'use strict';
// lib/auditoria-folha-robo.js — robô da PASTA DE ENTRADA da Auditoria da Folha (Tiago, 27/10/2026: "isso fica muito manual, queria
// algo mais automático"). Ninguém precisa abrir a tela pra importar: o DP solta o PDF numa pasta do Google Drive
// ("Auditoria da Folha/Entrada", via rclone gdrive:) ou na pasta local do servidor (data/auditoria-folha/entrada); a cada N minutos o
// robô puxa os arquivos, descobre sozinho o que é cada um (recibo de folha / adiantamento / comprovantes SISPAG), de que loja e de que
// competência, importa, concilia com o Itaú e devolve o arquivo pro Drive em "Processados/AAAA-MM" (ou "Erros", com o motivo num .txt
// ao lado). Tudo que ele faz fica na linha do tempo da competência como usuário "Robô da pasta de entrada".
// Também reconcilia 1x/dia as competências abertas (pagamento que caiu depois aparece sem ninguém clicar).
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');
const A = require('./auditoria-folha');

const RCLONE = process.env.RCLONE_EXE || 'C:\\fc360\\tools\\rclone\\rclone.exe';
const ENTRADA = () => path.join(A.DIR, 'entrada');
const LOG = () => path.join(A.DIR, 'robo.jsonl');
let deps = { pcDeps: null, extrato: null }; let timer = null, rodando = false, ultimo = null;

const agora = () => new Date().toISOString();
function log(ev) { fs.mkdirSync(A.DIR, { recursive: true }); fs.appendFileSync(LOG(), JSON.stringify({ em: agora(), ...ev }) + '\n'); }
function ultimos(n) { try { return fs.readFileSync(LOG(), 'utf8').split('\n').filter(Boolean).slice(-(n || 50)).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse(); } catch (e) { return []; } }
function temRclone() { try { return fs.existsSync(RCLONE); } catch (e) { return false; } }
function rclone(args, timeoutMs) { return new Promise((resolve, reject) => { execFile(RCLONE, args, { timeout: timeoutMs || 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => err ? reject(new Error((errOut || err.message || '').toString().trim().split('\n').slice(-2).join(' '))) : resolve((out || '').toString())); }); }

// Drive → pasta local (move: some da Entrada do Drive assim que chega aqui). Cria as pastas na primeira vez.
async function puxarDoDrive(cfg) {
  if (!cfg.drive || !temRclone()) return { ok: false, motivo: !cfg.drive ? 'sem pasta do Drive configurada' : 'rclone não encontrado em ' + RCLONE };
  const base = cfg.drive.replace(/\/+$/, ''); const raiz = base.replace(/\/[^/]+$/, '');
  try { await rclone(['mkdir', base], 30000); await rclone(['mkdir', raiz + '/Processados'], 30000); await rclone(['mkdir', raiz + '/Erros'], 30000); } catch (e) { return { ok: false, motivo: 'Drive: ' + e.message }; }
  try { await rclone(['move', base, ENTRADA(), '--include', '*.{pdf,PDF,xlsx,XLSX}', '--max-depth', '1', '--no-traverse'], 180000); return { ok: true }; }
  catch (e) { return { ok: false, motivo: 'Drive: ' + e.message }; }
}
async function devolverAoDrive(cfg, arquivoLocal, destinoRel) {
  if (!cfg.drive || !temRclone()) return false;
  const raiz = cfg.drive.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
  try { await rclone(['move', arquivoLocal, raiz + '/' + destinoRel], 120000); return true; } catch (e) { log({ tipo: 'aviso', msg: 'não consegui devolver ao Drive: ' + e.message, arquivo: path.basename(arquivoLocal) }); return false; }
}

const compDeNome = n => (String(n).match(/(20\d{2})[-_. ]?(0[1-9]|1[0-2])\b/) || []).slice(1, 3).join('-') || null;
const lojaDeNome = n => { const m = String(n).match(/\bE([1-6])\b/i) || String(n).match(/\b(socorro|muribeca|ponte|atacarejo|porta\s*larga|jardim\s*jord)/i); if (!m) return null; if (/^\d$/.test(m[1])) return +m[1]; return { socorro: 1, muribeca: 2, ponte: 3, atacarejo: 4 }[m[1].toLowerCase()] || (/porta/i.test(m[1]) ? 5 : 6); };

/** Processa UM arquivo: classifica → importa (prévia + confirmar como robô) → concilia. Devolve { ok, resumo } ou { ok:false, motivo }. */
async function processarArquivo(caminho) {
  const nome = path.basename(caminho); const buffer = fs.readFileSync(caminho);
  const c = await A.classificarArquivo(buffer, nome);
  const competencia = c.competencia || compDeNome(nome); const loja = c.loja || lojaDeNome(nome);
  if (c.tipo === 'desconhecido') return { ok: false, motivo: c.motivo || 'não reconheci o arquivo' };
  if (!competencia) return { ok: false, motivo: (c.motivo || 'não achei a competência no conteúdo') + ' — ponha AAAA-MM no nome do arquivo (ex.: "recibo E1 2026-09.pdf")' };
  const r0 = A.obterRaw(competencia); if (r0.encerramento) return { ok: false, motivo: 'competência ' + A.compTxt(competencia) + ' está encerrada' };
  const pv = await A.importarPrevia(buffer, nome, c.tipo, competencia, A.ROBO, deps.pcDeps, loja ? String(loja) : 'auto');
  if (c.tipo !== 'comprovantes' && !pv.loja && c.tipo !== 'desconhecido') return { ok: false, motivo: 'não descobri a loja (CNPJ não encontrado no PDF) — ponha E1..E6 no nome do arquivo' };
  if (c.tipo !== 'comprovantes' && pv.semCadastro && pv.identificados === 0) return { ok: false, motivo: 'nenhum dos ' + pv.funcionarios + ' nomes existe no PontoCerto — parece leitura errada; confira à mão na tela' };
  A.importarConfirmar(pv.token, A.ROBO);
  let conc = null; try { conc = await A.conciliar(competencia, A.ROBO, deps.pcDeps, { sistema: true, extrato: deps.extrato || undefined }); } catch (e) { log({ tipo: 'aviso', msg: 'importou mas a conciliação falhou: ' + e.message, arquivo: nome, competencia }); }
  return { ok: true, tipo: c.tipo, competencia, loja: pv.loja || null, lojaTxt: pv.lojaTxt, itens: pv.funcionarios, total: pv.total, pct: conc ? conc.totais.pct : null, pctFolha: conc ? conc.totais.folha.pct : null, pctAdiant: conc ? conc.totais.adiantamento.pct : null, divergencias: conc ? conc.totais.divergencias : null };
}

/** Um ciclo: puxa do Drive, processa tudo que estiver na pasta local, devolve pro Drive (Processados/Erros) ou move pra subpasta local. */
async function ciclo(origem) {
  if (rodando) return { pulado: true, motivo: 'ciclo anterior ainda rodando' };
  rodando = true; const ini = Date.now(); const cfg = A.config().entrada || {}; const res = { em: agora(), origem: origem || 'agendado', drive: null, processados: [], erros: [] };
  try {
    fs.mkdirSync(ENTRADA(), { recursive: true });
    res.drive = await puxarDoDrive(cfg);
    const arquivos = fs.readdirSync(ENTRADA()).filter(f => /\.(pdf|xlsx)$/i.test(f) && fs.statSync(path.join(ENTRADA(), f)).isFile()).sort();
    for (const f of arquivos) {
      const caminho = path.join(ENTRADA(), f); let r;
      try { r = await processarArquivo(caminho); } catch (e) { r = { ok: false, motivo: e.message }; }
      const stamp = agora().slice(0, 19).replace(/[:T]/g, '-');
      if (r.ok) {
        res.processados.push({ arquivo: f, ...r }); log({ ...r, tipoDoc: r.tipo, tipo: 'ok', arquivo: f, origem: res.origem });
        const dest = path.join(A.DIR, 'processados', r.competencia); fs.mkdirSync(dest, { recursive: true }); const novo = path.join(dest, stamp + ' ' + f); fs.renameSync(caminho, novo);
        if (res.drive && res.drive.ok) await devolverAoDrive(cfg, novo, 'Processados/' + r.competencia);
      } else {
        res.erros.push({ arquivo: f, motivo: r.motivo }); log({ tipo: 'erro', arquivo: f, motivo: r.motivo, origem: res.origem });
        const dest = path.join(A.DIR, 'erros'); fs.mkdirSync(dest, { recursive: true }); const novo = path.join(dest, stamp + ' ' + f); fs.renameSync(caminho, novo);
        const txt = novo.replace(/\.(pdf|xlsx)$/i, '') + ' - MOTIVO.txt'; fs.writeFileSync(txt, 'Auditoria da Folha — arquivo NÃO importado\n\nArquivo: ' + f + '\nQuando: ' + new Date().toLocaleString('pt-BR') + '\nMotivo: ' + r.motivo + '\n\nCorrija (ou renomeie com a loja e a competência, ex.: "recibo E1 2026-09.pdf") e solte de novo na pasta Entrada.\n');
        if (res.drive && res.drive.ok) { await devolverAoDrive(cfg, novo, 'Erros'); await devolverAoDrive(cfg, txt, 'Erros'); }
      }
    }
  } catch (e) { res.falha = e.message; log({ tipo: 'erro', msg: 'ciclo falhou: ' + e.message, origem: res.origem }); }
  res.ms = Date.now() - ini; ultimo = res; rodando = false;
  if (res.processados.length || res.erros.length || res.falha) log({ tipo: 'ciclo', origem: res.origem, processados: res.processados.length, erros: res.erros.length, drive: res.drive, ms: res.ms, falha: res.falha || null });
  return res;
}

/** Reconcilia todas as competências abertas que têm documento (pagamento que caiu depois aparece sozinho). */
async function reconciliarAbertas() {
  const out = [];
  for (const c of A.competencias()) {
    const r = A.obterRaw(c); if (r.encerramento || (!r.documentos.adiantamento && !r.documentos.folha)) continue;
    try { const x = await A.conciliar(c, A.ROBO, deps.pcDeps, { sistema: true, extrato: deps.extrato || undefined }); out.push({ competencia: c, pct: x.totais.pct, divergencias: x.totais.divergencias }); }
    catch (e) { out.push({ competencia: c, erro: e.message }); }
  }
  log({ tipo: 'reconciliacao_diaria', competencias: out }); return out;
}

function status() {
  const cfg = A.config().entrada || {}; let naFila = 0; try { naFila = fs.readdirSync(ENTRADA()).filter(f => /\.(pdf|xlsx)$/i.test(f)).length; } catch (e) { /* sem pasta ainda */ }
  return { config: cfg, rclone: temRclone(), pastaLocal: ENTRADA(), naFila, rodando, ultimo, agendado: !!timer, log: ultimos(40) };
}

/** Liga o agendador: ciclo a cada intervaloMin e reconciliação diária na hora configurada. deps: { pcDeps, extrato? } */
function iniciar(d) {
  deps = { ...deps, ...(d || {}) }; if (timer) clearTimeout(timer);
  let ultimaDiaria = null;
  const tic = async () => {
    const cfg = A.config().entrada || {};
    try { if (cfg.ativo !== false) await ciclo('agendado'); } catch (e) { log({ tipo: 'erro', msg: e.message }); }
    const h = new Date(); const hoje = h.toISOString().slice(0, 10);
    if (h.getHours() === (+cfg.reconciliarDiarioHora || 6) && ultimaDiaria !== hoje) { ultimaDiaria = hoje; try { await reconciliarAbertas(); } catch (e) { log({ tipo: 'erro', msg: 'reconciliação diária: ' + e.message }); } }
    timer = setTimeout(tic, Math.max(2, +cfg.intervaloMin || 10) * 60000); timer.unref && timer.unref();
  };
  timer = setTimeout(tic, 90 * 1000); timer.unref && timer.unref();
}
function parar() { if (timer) clearTimeout(timer); timer = null; }

module.exports = { iniciar, parar, ciclo, processarArquivo, reconciliarAbertas, status, ENTRADA, _deps: d => { deps = { ...deps, ...d }; } };
