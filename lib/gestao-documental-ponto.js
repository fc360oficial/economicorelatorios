'use strict';
// lib/gestao-documental-ponto.js — Central de Gestão de Ponto (DP / RH › Gestão Documental › aba Central de Ponto), etapa 03 (28/10/2026).
// Depois do fechamento da competência, importa da VR/Pontomais (lib/pontocerto.js, só leitura) a jornada de cada funcionário das
// seis lojas e do CD, monta o ESPELHO DE REGISTROS DE PONTO (JSON + PDF com a logo), deixa o RH conferir/aprovar ou sinalizar
// divergência, preparar para assinatura (abre solicitação ao CPD da unidade, que devolve o espelho assinado pelo Recebimento ·
// CPD) e arquivar na pasta 09 — Espelhos de Ponto do prontuário (lib/gestao-documental.js). Nada é alterado na VR.
// A API externa do Pontomais não expõe o fechamento de competência: aqui "fechamento" = mês encerrado + confirmação do RH.
// Dados em data/gestao-documental/ponto/<AAAA-MM>/{index.json, dias/<colabId>.json, pdf/<colabId>.pdf} + sync.json + fechamentos.json.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const PDFDocument = require('pdfkit');
const LOGO = require('./logo-economico');
const GP = require('./gestao-pessoas');
const D = require('./gestao-documental');

const RAIZ = () => path.join(D.DIR, 'ponto');
const P = { comp: c => path.join(RAIZ(), c), index: c => path.join(RAIZ(), c, 'index.json'), dias: (c, id) => path.join(RAIZ(), c, 'dias', String(id) + '.json'), pdf: (c, id) => path.join(RAIZ(), c, 'pdf', String(id) + '.pdf'),
  sync: () => path.join(RAIZ(), 'sync.json'), fech: () => path.join(RAIZ(), 'fechamentos.json'), tmp: () => path.join(RAIZ(), '_tmp') };
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400 }, extra || {});
const agoraIso = () => new Date().toISOString();
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const txt = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max || 1000);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
const hhmm = min => { const s = min < 0 ? '-' : '', a = Math.abs(Math.round(min || 0)); return s + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0'); };
const dBR = s => s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '—';
const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const lojaTxt = n => GP.LOJA_TXT[n] || ('Loja ' + n);

// ── Competência ──────────────────────────────────────────────────────────────
const compOk = c => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || ''));
const compAtual = () => hojeISO().slice(0, 7);
function ultimoDia(c) { const [a, m] = c.split('-').map(Number); return c + '-' + String(new Date(a, m, 0).getDate()).padStart(2, '0'); }
function periodo(c) { if (!compOk(c)) throw erro('Competência inválida (use AAAA-MM)'); if (c > compAtual()) throw erro('Competência futura'); const ate = ultimoDia(c); return { de: c + '-01', ate: ate > hojeISO() ? hojeISO() : ate, encerrada: ate < hojeISO() }; }
const compTxt = c => c.slice(5) + '/' + c.slice(0, 4);
function compAnterior(c) { const [a, m] = c.split('-').map(Number); const d = new Date(a, m - 2, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

// ── Permissões: mesma designação da Gestão Documental (RH confere; CPD/Diretoria consultam a própria visão) ──
function perm(user) { const p = D.permissoes(user); return { ...p, verPonto: p.ver, operar: p.rh, confirmar: p.rh || p.coord }; }
function exigeRh(user) { const p = perm(user); if (!p.operar) throw erro('Só o RH opera a Central de Ponto', 403); return p; }

// ── Catálogos ────────────────────────────────────────────────────────────────
const CONF_TXT = { pendente: 'Pendente de conferência', conferido: 'Conferido', divergente: 'Divergência sinalizada' };
const ASS_TXT = { nao_enviado: 'Não enviado', preparado: 'Preparado para assinatura', solicitado: 'Aguardando assinatura (CPD)', arquivado: 'Assinado e arquivado' };
const SIT_DIV = { sem_marcacao: 'Dia sem marcação', incompleta: 'Marcação incompleta (número ímpar)', folga_trabalhada: 'Trabalho em dia de folga', atraso: 'Atraso confirmado pela apuração', pendente: 'Apuração pendente na VR' };

// ── Índice da competência ────────────────────────────────────────────────────
const indexMem = new Map();
function index(c) { if (!indexMem.has(c)) indexMem.set(c, lerJson(P.index(c), { competencia: c, sincronizadoEm: null, funcionarios: {} })); return indexMem.get(c); }
function gravarIndex(c, ix) { ix.atualizadoEm = agoraIso(); gravarJson(P.index(c), ix); indexMem.set(c, ix); }
function entrada(c, id) { const e = index(c).funcionarios[String(id)]; if (!e) throw erro('Funcionário não está na competência ' + compTxt(c) + ' — sincronize com a VR', 404); return e; }
function auditar(user, acao, ref, extra) { D.auditar(user, acao, ref, extra); }

// ── Resumo de uma jornada (saída do pontocerto.jornadaPeriodo) ──────────────
function resumir(c, j) {
  const dias = (j.dias || []).slice().sort((a, b) => a.data.localeCompare(b.data));
  const r = { dias: dias.length, trabalhados: 0, semMarcacao: 0, incompletos: 0, folgaTrabalhada: 0, atrasos: 0, folgas: 0, afastamentos: 0, marcacoes: 0, normaisMin: 0, extrasMin: 0, faltantesMin: 0, saldoMin: null, divergencias: [] };
  for (const d of dias) {
    const n = (d.marcacoes || []).length; r.marcacoes += n; if (n) r.trabalhados++;
    if (d.apuracao) { r.extrasMin += d.apuracao.extras_min || 0; r.faltantesMin += d.apuracao.faltantes_min || 0; r.normaisMin += minutos(d.apuracao.normais); if (d.apuracao.saldo_acum_min != null) r.saldoMin = d.apuracao.saldo_acum_min; }
    if (d.situacao === 'sem_marcacao') r.semMarcacao++; if (d.situacao === 'incompleta') r.incompletos++; if (d.situacao === 'folga_trabalhada') r.folgaTrabalhada++; if (d.situacao === 'atraso') r.atrasos++; if (d.situacao === 'folga') r.folgas++; if (d.situacao === 'ferias' || d.situacao === 'afastado') r.afastamentos++;
    if (SIT_DIV[d.situacao]) r.divergencias.push({ data: d.data, situacao: d.situacao, txt: SIT_DIV[d.situacao] + (d.situacao === 'atraso' && d.atraso_min ? ' (' + d.atraso_min + ' min)' : ''), marcacoes: d.marcacoes || [] });
  }
  r.hash = crypto.createHash('sha1').update(JSON.stringify(dias.map(d => [d.data, d.marcacoes, d.situacao]))).digest('hex');
  return { resumo: r, dias: dias.map(d => ({ data: d.data, dow: DOW[new Date(d.data + 'T12:00:00').getDay()], entrada: d.entrada, saidaInt: d.saidaInt, retornoInt: d.retornoInt, saida: d.saida, marcacoes: d.marcacoes || [], situacao: d.situacao, situacaoTxt: d.situacaoTxt, previsto: d.previsto, apuracao: d.apuracao, atraso_min: d.atraso_min || 0 })) };
}
const minutos = s => { const m = String(s || '').match(/^(-?)(\d+):(\d{2})/); if (!m) return 0; const v = (+m[2]) * 60 + (+m[3]); return m[1] ? -v : v; };

// ── Sincronização com a VR (roda em segundo plano; a tela consulta o andamento) ──
const sync = { emAndamento: false, competencia: null, loja: null, inicio: null, fim: null, total: 0, feitos: 0, erros: [], por: null };
function statusSync() { return { ...sync, erros: sync.erros.slice(0, 20), nErros: sync.erros.length, historico: lerJson(P.sync(), []).slice(-30).reverse() }; }
async function sincronizar(user, c, opts, deps) {
  const p = exigeRh(user); const { de, ate } = periodo(c);
  if (sync.emAndamento) throw erro('Já existe uma sincronização em andamento (' + compTxt(sync.competencia) + ', ' + sync.feitos + '/' + sync.total + ')', 409);
  const col = await deps.colaboradores(); const loja = opts && opts.loja ? +opts.loja : null;
  const lista = [...col.ativos, ...col.desligados.filter(x => x.desligamento && x.desligamento >= de)].filter(x => D.veLoja(user, x.loja, p) && (!loja || +x.loja === loja));
  Object.assign(sync, { emAndamento: true, competencia: c, loja, inicio: agoraIso(), fim: null, total: lista.length, feitos: 0, erros: [], por: user.nome || user.usuario });
  const rodar = async () => {
    const ix = index(c); const t0 = Date.now();
    for (const x of lista) {
      try {
        const j = await deps.jornadaPeriodo(x.id, x.admissao && x.admissao > de ? x.admissao : de, ate); const { resumo, dias } = resumir(c, j);
        const ant = ix.funcionarios[String(x.id)] || {}; const mudou = ant.hash && ant.hash !== resumo.hash;
        ix.funcionarios[String(x.id)] = { id: x.id, nome: x.nome, matricula: x.matricula || '', loja: +x.loja, cargo: x.cargo || '', setor: x.setor || '', ativo: !!x.ativo, email: x.email || '', ...resumo,
          situacao: 'importado', importadoEm: agoraIso(), conferencia: mudou && ant.conferencia === 'conferido' ? 'pendente' : (ant.conferencia || 'pendente'), conferidoPor: mudou ? null : ant.conferidoPor || null, conferidoEm: mudou ? null : ant.conferidoEm || null,
          obsConferencia: mudou && ant.conferencia === 'conferido' ? 'Marcações mudaram na VR depois da conferência — conferir de novo' : ant.obsConferencia || null, assinatura: ant.assinatura || 'nao_enviado', solicitacao: ant.solicitacao || null, documento: ant.documento || null, preparadoEm: ant.preparadoEm || null };
        gravarJson(P.dias(c, x.id), { id: x.id, competencia: c, de, ate, dias, geradoEm: agoraIso() });
      } catch (e) { sync.erros.push({ id: x.id, nome: x.nome, erro: e.message }); }
      sync.feitos++;
    }
    ix.sincronizadoEm = agoraIso(); ix.sincronizadoPor = user.nome || user.usuario; ix.periodo = { de, ate }; gravarIndex(c, ix);
    const h = lerJson(P.sync(), []); h.push({ em: agoraIso(), por: user.nome || user.usuario, usuario: user.usuario, competencia: c, loja, total: lista.length, ok: lista.length - sync.erros.length, erros: sync.erros.length, ms: Date.now() - t0, automatica: !!(opts && opts.automatica) }); gravarJson(P.sync(), h.slice(-500));
    auditar(user, 'ponto_sync', 'PONTO-' + c, { loja, detalhe: 'Sincronização com a VR · ' + compTxt(c) + ' · ' + (lista.length - sync.erros.length) + ' funcionário(s), ' + sync.erros.length + ' erro(s)' });
    sync.emAndamento = false; sync.fim = agoraIso();
  };
  const promessa = rodar().catch(e => { sync.emAndamento = false; sync.fim = agoraIso(); sync.erros.push({ erro: e.message }); });
  if (opts && opts.aguardar) await promessa;
  return { iniciado: true, total: lista.length, competencia: c };
}

// ── Consultas ────────────────────────────────────────────────────────────────
function refrescarArquivados(c, user) {
  // espelho assinado devolvido pelo CPD (solicitação atendida) e validado pelo RH → conta como arquivado no prontuário
  const ix = index(c); let mudou = false;
  for (const e of Object.values(ix.funcionarios)) { if (!e.solicitacao || e.assinatura === 'arquivado') continue; try { const s = D.obterSol(e.solicitacao); if (s.status === 'atendida' && s.documento) { const d = D.obter(s.documento); if (d.status === 'arquivado') { e.documento = d.protocolo; e.assinatura = 'arquivado'; mudou = true; } } } catch (err) { /* solicitação sumiu: ignora */ } }
  if (mudou) gravarIndex(c, ix);
}
function visivel(user, e, p) { return D.veLoja(user, e.loja, p); }
function fmt(e, c) { return { ...e, competencia: c, lojaTxt: lojaTxt(e.loja), conferenciaTxt: CONF_TXT[e.conferencia], assinaturaTxt: ASS_TXT[e.assinatura], normais: hhmm(e.normaisMin), extras: hhmm(e.extrasMin), faltantes: hhmm(e.faltantesMin), saldo: e.saldoMin == null ? null : hhmm(e.saldoMin), nDivergencias: (e.divergencias || []).length, divergencias: undefined }; }
function listar(user, c, q = {}) {
  const p = perm(user); if (!p.verPonto) throw erro('Sem acesso', 403); if (!compOk(c)) throw erro('Competência inválida'); refrescarArquivados(c, user);
  const n = semAcento(q.q || '').trim();
  return Object.values(index(c).funcionarios).filter(e => visivel(user, e, p) && (!q.loja || +e.loja === +q.loja) && (!q.conferencia || e.conferencia === q.conferencia) && (!q.assinatura || e.assinatura === q.assinatura) && (!q.divergentes || (e.divergencias || []).length)
    && (!n || semAcento(e.nome).includes(n) || String(e.matricula || '').includes(n))).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).map(e => fmt(e, c));
}
function espelho(user, c, id) {
  const p = perm(user); if (!p.verPonto) throw erro('Sem acesso', 403); const e = entrada(c, id); if (!visivel(user, e, p)) throw erro('Funcionário fora das unidades que você atende', 403);
  const d = lerJson(P.dias(c, id), null); if (!d) throw erro('Jornada não encontrada — sincronize de novo', 410);
  return { ...fmt(e, c), divergencias: e.divergencias || [], dias: d.dias, de: d.de, ate: d.ate, geradoEm: d.geradoEm, sincronizadoEm: index(c).sincronizadoEm };
}
function conferir(user, c, id, body) {
  exigeRh(user); const e = entrada(c, id); const aprovar = !!(body && body.aprovar); const texto = txt(body && body.texto, 500);
  if (!aprovar && texto.length < 5) throw erro('Descreva a divergência');
  e.conferencia = aprovar ? 'conferido' : 'divergente'; e.conferidoPor = { usuario: user.usuario, nome: user.nome || user.usuario }; e.conferidoEm = agoraIso(); e.obsConferencia = texto || null; gravarIndex(c, index(c));
  auditar(user, aprovar ? 'ponto_conferir' : 'ponto_divergencia', 'PONTO-' + c, { loja: e.loja, colab: e.id, detalhe: e.nome + ' · ' + compTxt(c) + (texto ? ' · ' + texto : '') }); return fmt(e, c);
}
function conferirLote(user, c, ids) { exigeRh(user); let n = 0; for (const id of ids || []) { try { conferir(user, c, id, { aprovar: true }); n++; } catch (e) { /* segue */ } } return { conferidos: n }; }
function confirmarFechamento(user, c, body) {
  const p = perm(user); if (!p.confirmar) throw erro('Só RH ou Coordenação confirma o fechamento', 403); const { encerrada } = periodo(c); if (!encerrada) throw erro('A competência ' + compTxt(c) + ' ainda não encerrou');
  const f = lerJson(P.fech(), {}); f[c] = { confirmadoPor: { usuario: user.usuario, nome: user.nome || user.usuario }, em: agoraIso(), texto: txt(body && body.texto, 300) || null, funcionarios: Object.keys(index(c).funcionarios).length }; gravarJson(P.fech(), f);
  auditar(user, 'ponto_fechamento', 'PONTO-' + c, { detalhe: 'Fechamento da VR confirmado · ' + compTxt(c) }); return f[c];
}
function fechamentos(user, n = 12) {
  const p = perm(user); if (!p.verPonto) throw erro('Sem acesso', 403); const f = lerJson(P.fech(), {}); const out = []; let c = compAtual();
  for (let i = 0; i < n; i++) { const ix = indexMem.has(c) || fs.existsSync(P.index(c)) ? index(c) : null; const { encerrada } = periodo(c); const fc = f[c];
    out.push({ competencia: c, txt: compTxt(c), status: fc ? 'confirmado' : encerrada ? 'encerrada' : 'em_aberto', statusTxt: fc ? 'Fechado (confirmado pelo RH)' : encerrada ? 'Mês encerrado — aguardando confirmação' : 'Em aberto', confirmado: fc || null, sincronizadoEm: ix ? ix.sincronizadoEm : null, funcionarios: ix ? Object.keys(ix.funcionarios).length : 0 }); c = compAnterior(c); }
  return out;
}
function divergencias(user, c, q = {}) { return listar(user, c, { ...q, divergentes: 1 }).flatMap(e => (index(c).funcionarios[String(e.id)].divergencias || []).map(d => ({ ...d, id: e.id, nome: e.nome, matricula: e.matricula, loja: e.loja, lojaTxt: e.lojaTxt, conferencia: e.conferencia }))).sort((a, b) => a.data.localeCompare(b.data) || a.nome.localeCompare(b.nome)); }
async function painel(user, c, deps) {
  const p = perm(user); if (!p.verPonto) throw erro('Sem acesso', 403); refrescarArquivados(c, user);
  let ativos = []; try { const col = await deps.colaboradores(); ativos = col.ativos.filter(x => D.veLoja(user, x.loja, p)); } catch (e) { /* VR fora do ar: indicadores do que já está importado */ }
  const ix = index(c); const L = Object.values(ix.funcionarios).filter(e => visivel(user, e, p)); const ids = new Set(L.map(e => String(e.id)));
  const temEmail = ativos.some(x => x.email !== undefined);
  return { competencia: c, txt: compTxt(c), periodo: periodo(c), sincronizadoEm: ix.sincronizadoEm, sincronizadoPor: ix.sincronizadoPor || null,
    indicadores: { localizados: L.length, ativos: ativos.length, fechamentosConfirmados: Object.keys(lerJson(P.fech(), {})).length, preparados: L.length, pendentes: L.filter(e => e.conferencia === 'pendente').length, conferidos: L.filter(e => e.conferencia === 'conferido').length, divergentes: L.filter(e => e.conferencia === 'divergente').length,
      aguardandoAssinatura: L.filter(e => ['preparado', 'solicitado'].includes(e.assinatura)).length, arquivados: L.filter(e => e.assinatura === 'arquivado' || e.documento).length, semCorrespondencia: ativos.filter(x => !ids.has(String(x.id))).length, semEmail: temEmail ? ativos.filter(x => !x.email).length : null, comDivergencia: L.filter(e => (e.divergencias || []).length).length, totalDivergencias: L.reduce((s, e) => s + (e.divergencias || []).length, 0) },
    porLoja: GP.LOJAS.filter(l => D.veLoja(user, l, p)).map(l => { const X = L.filter(e => +e.loja === l); return { loja: l, txt: lojaTxt(l), total: X.length, pendentes: X.filter(e => e.conferencia === 'pendente').length, conferidos: X.filter(e => e.conferencia === 'conferido').length, divergentes: X.filter(e => e.conferencia === 'divergente').length, arquivados: X.filter(e => e.documento).length }; }),
    fechamentos: fechamentos(user, 6), sync: statusSync(), integracao: { ultima: (lerJson(P.sync(), []).slice(-1)[0] || null), proxima: 'automática, diária às 06:15 (competência atual e, até o dia 10, a anterior)' } };
}

// ── PDF do espelho (28/10/2026, Tiago: UMA página; CPF no lugar da matrícula; razão social + CNPJ do empregador no lugar da unidade) ──
const fmtCpf = d => { d = String(d || '').replace(/\D/g, ''); return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : ''; };
const fmtCnpj = d => { d = String(d || '').replace(/\D/g, ''); return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : String(d || ''); };
function pdfBuffer(esp, ctx) {
  ctx = ctx || {};
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 30, left: 36, right: 36, bottom: 30 }, info: { Title: 'Espelho de ponto ' + compTxt(esp.competencia) + ' — ' + esp.nome, Author: 'Econômico Supermercados' } });
    const chunks = []; doc.on('data', x => chunks.push(x)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const NAVY = '#101B33', INK = '#0E1626', GR = '#6B7280', LN = '#D1D5DB', RED = '#B91C1C', ML = 36, W = 523;
    const T = (s, x, y, o) => doc.text(String(s == null ? '' : s), x, y, { lineBreak: false, ...(o || {}) });   // nunca deixa o pdfkit quebrar página sozinho
    const emp = ctx.emp || {}; const razao = emp.razao || emp.nome || 'Econômico Supermercados'; const cnpj = fmtCnpj(emp.cnpj); const cpf = fmtCpf(ctx.cpf);
    // cabeçalho
    const hLogo = LOGO.desenhar(doc, ML, 30, 86);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(NAVY); T('ESPELHO DE REGISTROS DE PONTO', ML + 100, 32, { width: W - 100, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK); T('COMPETÊNCIA ' + compTxt(esp.competencia) + '  ·  ' + dBR(esp.de) + ' a ' + dBR(esp.ate), ML + 100, 49, { width: W - 100, align: 'right' });
    doc.font('Helvetica').fontSize(7).fillColor(GR); T('Registros extraídos do sistema de ponto eletrônico VR/Pontomais em ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }), ML + 100, 62, { width: W - 100, align: 'right' });
    let y = Math.max(30 + hLogo, 74) + 8;
    // empregador + funcionário
    doc.rect(ML, y, W, 34).fill('#F3F4F6'); doc.rect(ML, y, 3, 34).fill(NAVY);
    doc.font('Helvetica').fontSize(7).fillColor(GR); T('EMPREGADOR', ML + 10, y + 4); doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK); T(razao + (cnpj ? '   ·   CNPJ ' + cnpj : ''), ML + 10, y + 13, { width: W - 20 });
    y += 34; doc.rect(ML, y, W, 30).fill('#FAFAFA'); doc.rect(ML, y, 3, 30).fill(NAVY);
    doc.font('Helvetica').fontSize(7).fillColor(GR); T('FUNCIONÁRIO', ML + 10, y + 4); T('CPF', ML + 270, y + 4); T('CARGO / SETOR', ML + 355, y + 4);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK); T(esp.nome, ML + 10, y + 13, { width: 255, ellipsis: true }); T(cpf || '—', ML + 270, y + 13, { width: 80 }); doc.font('Helvetica').fontSize(7.5); T((esp.cargo || '—') + (esp.setor ? ' · ' + esp.setor : ''), ML + 355, y + 13, { width: W - 365, ellipsis: true });
    y += 36;
    // tabela (31 linhas × 11,5 pt cabem com folga)
    const cols = [['Data', 60], ['Dia', 34], ['1ª Entrada', 80], ['1ª Saída', 80], ['2ª Entrada', 80], ['2ª Saída', 80], ['Extras', 55], ['Faltantes', 54]];   // Tiago (28/10): sem as colunas de marcações extras e de classificação do dia — ocorrências ficam em vermelho e listadas embaixo
    doc.rect(ML, y, W, 13).fill(NAVY); let x = ML + 3; doc.font('Helvetica-Bold').fontSize(6.8).fillColor('#FFFFFF'); for (const [t, w] of cols) { T(t, x, y + 3.5, { width: w - 4 }); x += w; } y += 13;
    const RH = 11.5;
    for (const d of esp.dias) {
      const fds = d.dow === 'Dom' || d.dow === 'Sáb'; const div = !!SIT_DIV[d.situacao]; if (fds) doc.rect(ML, y, W, RH).fill('#F3F4F6');
      const ap = d.apuracao || {}; const vals = [dBR(d.data).slice(0, 5), d.dow, d.entrada || (d.situacao === 'folga' ? 'Folga' : '—'), d.saidaInt || '—', d.retornoInt || '—', d.saida || '—', ap.extras && ap.extras !== '0:00' && ap.extras !== '00:00' ? ap.extras : '—', ap.faltantes && ap.faltantes !== '0:00' && ap.faltantes !== '00:00' ? ap.faltantes : '—'];
      x = ML + 3; doc.font(div ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.8).fillColor(div ? RED : INK); vals.forEach((v, i) => { T(v, x, y + 2.8, { width: cols[i][1] - 4 }); x += cols[i][1]; });
      doc.moveTo(ML, y + RH).lineTo(ML + W, y + RH).lineWidth(0.3).strokeColor(LN).stroke(); y += RH;
    }
    // totais em uma linha
    y += 6; doc.rect(ML, y, W, 15).fill('#F3F4F6'); doc.font('Helvetica').fontSize(7.2).fillColor(INK);
    const tot = ['Dias c/ marcação: ' + esp.trabalhados, 'Marcações: ' + esp.marcacoes, 'Normais: ' + hhmm(esp.normaisMin), 'Extras: ' + hhmm(esp.extrasMin), 'Faltantes: ' + hhmm(esp.faltantesMin), 'Saldo banco: ' + (esp.saldoMin == null ? '—' : hhmm(esp.saldoMin))];
    tot.forEach((t, i) => T(t, ML + 6 + i * 87, y + 4, { width: 85 })); y += 21;
    // ocorrências: até 6, em duas colunas
    const oc = esp.divergencias || [];
    if (oc.length) { doc.font('Helvetica-Bold').fontSize(7.2).fillColor(RED); T('Ocorrências a esclarecer (' + oc.length + ')' + (oc.length > 6 ? ' — as demais estão na Central de Ponto' : ''), ML, y); y += 10; doc.font('Helvetica').fontSize(6.8).fillColor(INK);
      oc.slice(0, 6).forEach((d, i) => T(dBR(d.data) + ' — ' + d.txt, ML + (i % 2) * 262, y + Math.floor(i / 2) * 9, { width: 258 })); y += Math.ceil(Math.min(oc.length, 6) / 2) * 9 + 6; }
    // declaração e assinaturas
    doc.font('Helvetica').fontSize(7).fillColor(GR); doc.text('Declaro que conferi os registros acima, extraídos do sistema de ponto eletrônico, e que correspondem à minha jornada de trabalho na competência indicada.', ML, y, { width: W, lineBreak: true, height: 20 }); y += 34;
    doc.moveTo(ML, y).lineTo(ML + 240, y).strokeColor(INK).lineWidth(0.6).stroke(); doc.moveTo(ML + 283, y).lineTo(ML + W, y).stroke();
    doc.fontSize(7.2).fillColor(INK); T(esp.nome, ML, y + 3, { width: 240, align: 'center' }); doc.fontSize(6.5).fillColor(GR); T('Funcionário' + (cpf ? ' · CPF ' + cpf : ''), ML, y + 12, { width: 240, align: 'center' });
    doc.fontSize(7.2).fillColor(INK); T(razao, ML + 283, y + 3, { width: 240, align: 'center' }); doc.fontSize(6.5).fillColor(GR); T('Empregador' + (cnpj ? ' · CNPJ ' + cnpj : ''), ML + 283, y + 12, { width: 240, align: 'center' });
    doc.fontSize(6.3).fillColor(GR); T('Gestão Documental · Central de Ponto · competência ' + compTxt(esp.competencia) + ' · ' + lojaTxt(esp.loja) + (ctx.por ? ' · emitido por ' + ctx.por : '') + ' · ' + new Date().toLocaleDateString('pt-BR'), ML, 796, { width: W, align: 'center' });   // 812 = margem inferior: encostar nela faz o pdfkit abrir 2ª página
    doc.end();
  });
}
async function pdf(user, c, id, deps) {
  const esp = espelho(user, c, id); let cpf = '', emp = null;
  if (deps && deps.cpfDe) { try { cpf = await deps.cpfDe(esp.id); } catch (e) { /* sem CPF na VR */ } }
  if (deps && deps.empregadorDe) { try { emp = await deps.empregadorDe(esp.id); } catch (e) { /* sem unidade empregadora */ } }
  const buf = await pdfBuffer(esp, { por: user.nome || user.usuario, cpf, emp }); fs.mkdirSync(path.dirname(P.pdf(c, id)), { recursive: true }); fs.writeFileSync(P.pdf(c, id), buf);
  auditar(user, 'ponto_pdf', 'PONTO-' + c, { loja: esp.loja, colab: esp.id, detalhe: 'Espelho ' + compTxt(c) + ' · ' + esp.nome }); return { buffer: buf, nome: 'espelho-ponto-' + c + '-' + (esp.matricula || esp.id) + '.pdf' };
}

// ── Assinatura e arquivamento ────────────────────────────────────────────────
// Preparar = gera o PDF e abre uma solicitação ao CPD da unidade (pasta 09 · Espelho de ponto); o CPD imprime, colhe a assinatura e
// devolve pelo Recebimento · CPD; o RH valida e o espelho assinado fica arquivado no prontuário. Sem assinatura, o RH pode arquivar direto.
async function prepararAssinatura(user, c, ids, deps) {
  exigeRh(user); let n = 0; const erros = [];
  for (const id of ids || []) {
    try { const e = entrada(c, id); if (e.conferencia !== 'conferido') throw new Error('ainda não conferido'); await pdf(user, c, id, deps);
      if (!e.solicitacao) { const s = await D.criarSolicitacao(user, { colabId: id, categoria: '09', tipo: 'Espelho de ponto', observacoes: 'Espelho de ponto ' + compTxt(c) + ': imprimir (PDF na Central de Ponto), colher a assinatura do funcionário e devolver digitalizado' }, deps); e.solicitacao = s.protocolo; }
      e.assinatura = 'solicitado'; e.preparadoEm = agoraIso(); n++;
    } catch (err) { erros.push({ id, erro: err.message }); }
  }
  gravarIndex(c, index(c)); auditar(user, 'ponto_assinatura', 'PONTO-' + c, { detalhe: n + ' espelho(s) preparados e solicitados ao CPD · ' + compTxt(c) }); return { preparados: n, erros };
}
async function arquivar(user, c, id, deps) {
  exigeRh(user); const e = entrada(c, id); if (e.conferencia !== 'conferido') throw erro('Confira e aprove o espelho antes de arquivar', 409); if (e.documento) throw erro('Espelho já arquivado (' + e.documento + ')', 409);
  const { buffer, nome } = await pdf(user, c, id, deps); fs.mkdirSync(P.tmp(), { recursive: true }); const tmp = path.join(P.tmp(), crypto.randomBytes(8).toString('hex') + '.pdf'); fs.writeFileSync(tmp, buffer);
  const d = await D.importar(user, { colabId: id, categoria: '09', tipo: 'Espelho de ponto', dataDocumento: ultimoDia(c) > hojeISO() ? hojeISO() : ultimoDia(c), competencia: c, origem: 'pontomais', observacoes: 'Espelho gerado da VR/Pontomais · competência ' + compTxt(c) + (e.conferidoPor ? ' · conferido por ' + e.conferidoPor.nome : ''), confirmado: true }, { path: tmp, originalname: nome, mimetype: 'application/pdf', size: buffer.length }, deps);
  e.documento = d.protocolo; if (e.assinatura === 'nao_enviado') e.assinatura = 'arquivado'; gravarIndex(c, index(c)); return { ...fmt(e, c), protocolo: d.protocolo };
}
function recarregar() { indexMem.clear(); }

module.exports = { P, CONF_TXT, ASS_TXT, SIT_DIV, compOk, compAtual, compAnterior, periodo, compTxt, perm, sincronizar, statusSync, listar, espelho, conferir, conferirLote, confirmarFechamento, fechamentos, divergencias, painel, pdf, pdfBuffer, prepararAssinatura, arquivar, recarregar, _util: { resumir, hhmm } };
