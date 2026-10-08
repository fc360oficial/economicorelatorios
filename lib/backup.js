'use strict';
// Backup diário do estado do Econômico Relatórios (tudo que fica fora do git:
// data/, usuarios.json, pareamento dos WhatsApp, Itaú, Caddy, Firebase das etiquetas,
// parâmetros/senhas dos serviços NSSM).
// Spec: docs/superpowers/specs/2026-09-29-backup-e-seguranca-design.md
// Zip gerado com o tar.exe nativo do Windows 11 (--format=zip), sem pacote novo.
// Cópia pra nuvem via rclone só roda se o binário e o rclone.conf existirem.
// Backups "extras" (ex.: CAHU Delivery) são scripts separados, com zip e pasta no Drive próprios,
// disparados logo depois deste; o resultado deles entra no histórico (campo extras).
// Regra de ouro: erro de backup NUNCA derruba o app — vira estado.erro + console.error.
const fs = require('fs');
const path = require('path');
const util = require('util');
const cp = require('child_process');

const RETENCAO_DIAS = 30;
const HORA_AGENDADA = 4; // 04:00
const MAX_HISTORICO = 30;
const ATRASO_ALERTA_H = 28; // sem backup bom há mais de 28 h → aviso no topo da tela
const EXEC_OPTS = { windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
const EXEC_OPTS_EXTRA = { ...EXEC_OPTS, timeout: 30 * 60 * 1000 };
// bsdtar do Windows (suporta --format=zip); o tar do Git Bash é GNU e não gera zip
const TAR = fs.existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';

let cfg = null;     // { appDir, dataDir, configPath, estadoPath, execFileFn, destinoDefault }
let rodando = null; // Promise da execução em andamento (serializa chamadas concorrentes)

function configDefault() {
  return {
    destino: cfg.destinoDefault,
    // relativos ao appDir (C:\fc360\claude_code_); só entra o que existir na hora
    itens: [
      'data', 'usuarios.json', 'Caddyfile', 'docs/RESTAURAR.md',
      'negativos-wpp/auth_info', 'negativos-wpp/pendentes.json',
      'cahu-wpp/auth_info', 'cahu-wpp/config.json',
      'negativos-agent/negativos.db', 'negativos-agent/negativos.db-wal', 'negativos-agent/data',
    ],
    // absolutos, fora do app
    externos: [
      'C:/fc360/etiquetas-api/.env.etiquetas-api',
      'C:/fc360/etiquetas-api/firebase-service-account.json',
      'C:/cahudelivery/infra/caddy',
      'C:/fc360/data',
    ],
    // relativos ao appDir; sessões de login e arquivos de teste/PDF regeneráveis
    excluir: ['data/sessions', 'data/xml-teste', 'data/promocoes-pdf'],
    // serviços NSSM cujos parâmetros (comando, pasta, variáveis de ambiente com senhas) vão pro zip
    // em data/servicos-nssm.json — sem isso o RESTAURAR.md não consegue subir os serviços de novo
    servicos: ['EconomicoRelatorios', 'Caddy', 'EtiquetasAPI', 'NegativosWpp', 'NegativosAgent', 'FluxoAPI', 'PostgreSQL16'],
    // backups separados. `estado`: JSON {ultimo} que o backup grava quando roda sozinho (tarefa agendada);
    // se estiver recente só mostramos o resultado. `script`: disparado daqui quando não há estado recente;
    // imprime na última linha do stdout um JSON {inicio, arquivo, bytes, nuvem, erro}.
    extras: [{ nome: 'CAHU Delivery', script: 'C:/cahudelivery/infra/scripts/backup-cahu.js', estado: 'D:/backups/cahu/estado.json' }],
    rclone: {
      exe: 'C:/fc360/tools/rclone/rclone.exe',
      conf: 'C:/fc360/tools/rclone/rclone.conf',
      remoto: 'gdrive-crypt:',
    },
  };
}

function lerJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function gravarJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function init(opts) {
  cfg = { execFileFn: util.promisify(cp.execFile), destinoDefault: 'D:/backups/economico', ...opts };
  if (!fs.existsSync(cfg.configPath)) gravarJson(cfg.configPath, configDefault());
}
function configAtual() { return { ...configDefault(), ...lerJson(cfg.configPath, {}) }; }
function lerEstadoBruto() { return lerJson(cfg.estadoPath, { ultimo: null, historico: [] }); }
const idadeMs = iso => Date.now() - new Date(iso).getTime();

// Último registro de um backup extra que roda por conta própria (tarefa agendada grava <destino>/estado.json).
function lerExtraExterno(ex) {
  if (!ex || !ex.estado) return null;
  const st = lerJson(ex.estado, null);
  const u = st && st.ultimo;
  return u && u.inicio ? { nome: ex.nome || path.basename(ex.estado), ...u, origem: 'tarefa' } : null;
}

/** Estado pra tela e pro alerta: o último registro, com cada extra substituído pelo estado.json dele
 *  quando esse for mais novo (o backup extra rodou sozinho depois do nosso). */
function estado() {
  const st = lerEstadoBruto();
  if (!st.ultimo) return st;
  const lista = [...(st.ultimo.extras || [])];
  for (const ex of configAtual().extras || []) {
    const ext = lerExtraExterno(ex);
    if (!ext) continue;
    const i = lista.findIndex(x => x.nome === ext.nome);
    if (i < 0) lista.push(ext);
    else if (new Date(ext.inicio) > new Date(lista[i].inicio || 0)) lista[i] = ext;
  }
  st.ultimo = { ...st.ultimo, extras: lista };
  return st;
}

// D:\ pode não existir (máquina nova) → cai pra <appDir>\..\backups
function destinoReal(c) {
  try { fs.mkdirSync(c.destino, { recursive: true }); fs.accessSync(c.destino, fs.constants.W_OK); return c.destino; }
  catch {
    const alt = path.resolve(cfg.appDir, '..', 'backups');
    fs.mkdirSync(alt, { recursive: true });
    return alt;
  }
}

function nomeArquivo(dest) {
  const d = new Date();
  const dia = d.toISOString().slice(0, 10);
  let nome = `economico-${dia}.zip`;
  if (fs.existsSync(path.join(dest, nome))) {
    nome = `economico-${dia}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.zip`;
  }
  return path.join(dest, nome);
}

function retencao(dest) {
  const limite = Date.now() - RETENCAO_DIAS * 864e5;
  for (const f of fs.readdirSync(dest)) {
    if (!/^economico-.*\.zip$/.test(f)) continue;
    const p = path.join(dest, f);
    try { if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p); }
    catch (e) { console.error('[BACKUP] retenção', f, e.message); }
  }
}

// Parâmetros dos serviços NSSM (HKLM\SYSTEM\CurrentControlSet\Services\<svc>\Parameters): comando, pasta e
// AppEnvironmentExtra, que é onde moram as senhas (banco do CAHU, JWT...). Vai pra data/servicos-nssm.json
// e portanto pro zip. Serviço que não existe nesta máquina é ignorado.
async function exportarServicos(c) {
  const out = { geradoEm: new Date().toISOString(), servicos: {} };
  for (const svc of c.servicos || []) {
    try {
      const { stdout } = await cfg.execFileFn('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${svc}\\Parameters`], EXEC_OPTS);
      const p = {};
      for (const linha of String(stdout || '').split(/\r?\n/)) {
        const m = linha.match(/^\s{4}(\S+)\s+(REG_\w+)\s+(.*)$/);
        if (!m) continue;
        p[m[1]] = m[2] === 'REG_MULTI_SZ' ? m[3].split('\\0').filter(Boolean) : m[3];
      }
      if (Object.keys(p).length) out.servicos[svc] = p;
    } catch { /* serviço não instalado aqui */ }
  }
  const arq = path.join(cfg.dataDir, 'servicos-nssm.json');
  gravarJson(arq, out);
  return arq;
}

async function gerarZip(c, arquivo) {
  const tmp = arquivo + '.tmp';
  const args = ['--format=zip', '-cf', tmp, '-C', cfg.appDir];
  for (const ex of c.excluir) args.push('--exclude=' + ex);
  for (const it of c.itens) if (fs.existsSync(path.join(cfg.appDir, it))) args.push(it);
  for (const ex of c.externos) if (fs.existsSync(ex)) args.push('-C', path.dirname(ex), path.basename(ex));
  try {
    await cfg.execFileFn(TAR, args, EXEC_OPTS);
    fs.renameSync(tmp, arquivo);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

async function enviarNuvem(c, arquivo) {
  const r = c.rclone || {};
  if (!r.exe || !r.conf || !fs.existsSync(r.exe) || !fs.existsSync(r.conf)) return { status: 'nao-configurada' };
  const base = [r.exe, ['--config', r.conf]];
  await cfg.execFileFn(base[0], [...base[1], 'copy', arquivo, r.remoto, '--drive-chunk-size', '64M'], EXEC_OPTS);
  // --max-depth 1: só os zips da raiz; subpastas (ex.: cahu/) são de outros backups, com retenção própria
  await cfg.execFileFn(base[0], [...base[1], 'delete', r.remoto, '--min-age', RETENCAO_DIAS + 'd', '--max-depth', '1'], EXEC_OPTS);
  return { status: 'ok', em: new Date().toISOString() };
}

// Backups separados (ex.: CAHU Delivery). Cada um cuida do próprio zip, retenção e nuvem.
// Se o extra roda sozinho (tarefa agendada) e o estado.json dele tem menos de 28 h, só aproveitamos o
// registro; senão disparamos o script e guardamos o JSON da última linha do stdout. Falha de um não afeta os outros.
async function rodarExtras(c) {
  const res = [];
  for (const ex of c.extras || []) {
    if (!ex) continue;
    const ext = lerExtraExterno(ex);
    if (ext && idadeMs(ext.inicio) < ATRASO_ALERTA_H * 36e5) { res.push(ext); continue; }
    if (!ex.script || !fs.existsSync(ex.script)) continue;
    const r = { nome: ex.nome || path.basename(ex.script), arquivo: null, bytes: 0, nuvem: null, erro: null };
    try {
      const { stdout } = await cfg.execFileFn(process.execPath, [ex.script], EXEC_OPTS_EXTRA);
      const linhas = String(stdout || '').trim().split(/\r?\n/);
      Object.assign(r, JSON.parse(linhas[linhas.length - 1]));
    } catch (e) { r.erro = e.message; }
    if (r.erro) console.error('[BACKUP] extra', r.nome, r.erro);
    res.push(r);
  }
  return res;
}

async function executar({ motivo = 'agendado' } = {}) {
  if (rodando) return rodando;
  rodando = (async () => {
    const c = configAtual();
    const reg = { inicio: new Date().toISOString(), fim: null, motivo, arquivo: null, bytes: 0, erro: null, nuvem: null, extras: [] };
    try {
      const dest = destinoReal(c);
      try { await exportarServicos(c); } catch (e) { console.error('[BACKUP] serviços:', e.message); }
      const arquivo = nomeArquivo(dest);
      await gerarZip(c, arquivo);
      reg.arquivo = arquivo;
      reg.bytes = fs.statSync(arquivo).size;
      retencao(dest);
      try { reg.nuvem = await enviarNuvem(c, arquivo); }
      catch (e) { reg.nuvem = { status: 'erro', erro: e.message }; console.error('[BACKUP] nuvem:', e.message); }
    } catch (e) {
      reg.erro = e.message;
      console.error('[BACKUP]', e.message);
    }
    reg.extras = await rodarExtras(c);
    reg.fim = new Date().toISOString();
    const st = lerEstadoBruto();
    st.ultimo = reg;
    st.historico = [reg, ...(st.historico || [])].slice(0, MAX_HISTORICO);
    gravarJson(cfg.estadoPath, st);
    console.log('[BACKUP]', motivo, reg.erro ? 'ERRO ' + reg.erro : `${(reg.bytes / 1048576).toFixed(1)} MB → ${reg.arquivo} | nuvem: ${reg.nuvem && reg.nuvem.status}`
      + reg.extras.map(x => ` | ${x.nome}: ${x.erro ? 'ERRO ' + x.erro : (x.bytes / 1048576).toFixed(1) + ' MB'}`).join(''));
    return st;
  })();
  try { return await rodando; } finally { rodando = null; }
}

const fmtBR = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Texto do aviso no topo da tela Processos › Backup, ou null quando está tudo bem.
 *  Avisa já na primeira falha, quando o zip não subiu pro Drive, quando um backup extra falhou
 *  e quando o último backup tem mais de 28 h (o das 04:00 não rodou). */
function alerta() {
  const u = estado().ultimo;
  if (!u) return null;
  if (u.erro) return `O último backup (${fmtBR(u.inicio)}) falhou: ${u.erro}. Veja a tabela e avise o Tiago.`;
  if (u.nuvem && u.nuvem.status === 'erro') return `O zip de ${fmtBR(u.inicio)} foi feito, mas não subiu pro Google Drive: ${u.nuvem.erro}`;
  for (const x of u.extras || []) {
    if (x.erro) return `O backup do ${x.nome} (${fmtBR(x.inicio || u.inicio)}) falhou: ${x.erro}`;
    if (x.inicio && idadeMs(x.inicio) > ATRASO_ALERTA_H * 36e5) {
      return `O backup do ${x.nome} não roda há mais de ${ATRASO_ALERTA_H} horas (último em ${fmtBR(x.inicio)}). Conferir a tarefa agendada "Backup CAHU".`;
    }
  }
  if (idadeMs(u.inicio) > ATRASO_ALERTA_H * 36e5) {
    return `Nenhum backup há mais de ${ATRASO_ALERTA_H} horas (último em ${fmtBR(u.inicio)}). O agendado das 04:00 não rodou.`;
  }
  return null;
}

function agendar() {
  const hoje = () => new Date().toISOString().slice(0, 10);
  const jaFezHoje = () => { const u = lerEstadoBruto().ultimo; return !!(u && !u.erro && u.inicio.slice(0, 10) === hoje()); };
  // ao subir: 5 min depois, se ainda não tem backup bom de hoje (ex.: servidor reiniciou às 04:00)
  setTimeout(() => { if (!jaFezHoje()) executar({ motivo: 'boot' }); }, 5 * 60 * 1000);
  // 04:00 todo dia; se falhar, tenta de novo nas próximas horas cheias (até 3×)
  let falhas = 0;
  setInterval(async () => {
    const d = new Date();
    if (d.getHours() === HORA_AGENDADA && d.getMinutes() === 0) {
      const st = await executar({ motivo: 'agendado' });
      falhas = st.ultimo.erro ? 1 : 0;
    } else if (falhas > 0 && falhas <= 3 && d.getMinutes() === 0) {
      const st = await executar({ motivo: 'retry' });
      falhas = st.ultimo.erro ? falhas + 1 : 0;
    }
  }, 60 * 1000);
}

module.exports = { init, executar, estado, configAtual, agendar, alerta, RETENCAO_DIAS, ATRASO_ALERTA_H };
