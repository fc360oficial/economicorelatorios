'use strict';
// lib/paineis-tvs.js — Processos › Painéis e TVs (Tiago, 27/10/2026: "tem alguma coisa que eu possa saber se a TV
// Televendas, o Painel Compras e o Painel RH/DP estão ligados no momento?").
//
// Cada tela de TV (tv-televendas, painel-compras, tv-rh por token, tv-acougue) carrega /tv-heartbeat.js e manda um
// batimento a cada 30 s em POST /api/paineis-publico/batimento (sem login: a TV não tem sessão) com um id fixo do
// aparelho (localStorage), o painel, o slide que está mostrando, a resolução e a versão da página. Aqui a gente guarda
// o último sinal de cada aparelho, fecha/abre quedas e manda aviso no WhatsApp pelo cahu-wpp (127.0.0.1:3012).
//
// Estados: ligada (< 2 min sem sinal) · instavel (2 a 5 min) · desligada (> 5 min) · nunca (cadastrada à mão, sem sinal).
// "Desligada" = navegador fechado, TV em standby, sem rede ou entrada HDMI trocada — pra quem olha dá no mesmo: ninguém
// está vendo o painel. Não dá pra saber se a TV física está ligada com a tela preta.
//
// Arquivos (data/paineis-tvs/, gitignored): estado.json {telas, config} · quedas-AAAA-MM.json [{...}] (90 dias).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pgDocs = require('./pg-docs');   // 28/10/26 à noite: estado e quedas vão também pro Postgres (doc_json 'paineis-tvs')
const docs = pgDocs('paineis-tvs');

const PAINEIS = {
  televendas: { nome: 'Painel Televendas', local: 'CD (loja 10) · televendas', pagina: '/tv-televendas', arquivo: 'tv-televendas.html' },
  compras: { nome: 'Painel Compras', local: 'ADM · compras', pagina: '/painel-compras.html', arquivo: 'painel-compras.html' },
  rh: { nome: 'Painel RH/DP', local: 'ADM · departamento pessoal', pagina: '/tv-rh', arquivo: 'tv-rh.html' },
  acougue: { nome: 'Painel Açougue', local: 'E6 · Jardim Jordão · açougue', pagina: '/tv-acougue', arquivo: 'tv-acougue.html' },
  fiscal: { nome: 'Painel Fiscal', local: 'ADM · fiscal', pagina: '/painel-fiscal.html', arquivo: 'painel-fiscal.html' },   // 30/10/26
};
// Painel Compras: os 5 painéis que giram na TV da sala de compras (painel-compras.html). Ordem e liga/desliga configuráveis
// em Processos › Painéis › Painel Compras; o tempo de cada um é de cada página (ela avisa "CycleComplete" quando terminou).
// Painel Compras 2.0 (28/10/26, Tiago): 8 telas no padrão da TV RH/DP, ordem aprovada; `segundos` = tempo de cada
// página da tela (tela com carrossel interno — compradoras, lojas — usa esse tempo por página).
const COMPRAS_PAINEIS = [
  { id: 'central', nome: 'Central de Compras', desc: 'Listas urgentes do Radar por compradora: previsto × feito', segundos: 40 },
  { id: 'margem', nome: 'Venda · Margem · Avaria', desc: 'Uma página por compradora, fornecedores do mês', segundos: 30 },
  { id: 'avaria_comp', nome: 'Avarias por compradora', desc: 'Ranking de quem mais teve avaria no mês', segundos: 30 },
  { id: 'rupturas', nome: 'Rupturas', desc: 'Lista a lista, por compradora, ordenado por urgência', segundos: 30 },
  { id: 'curva_a', nome: 'Produtos curva A', desc: 'Produtos curva A que zeram antes da lista', segundos: 30 },
  { id: 'pagar', nome: 'A Pagar × Venda', desc: 'Contas a pagar do mês sobre a venda média, por loja', segundos: 25 },
  { id: 'avaria_prod', nome: 'Ranking de produtos com avaria', desc: 'Produto a produto no mês, rede e depois por loja', segundos: 30 },
  { id: 'rebaixas', nome: 'Rebaixas em acompanhamento', desc: 'Loja a loja: solicitada, vendida, saldo, vai vender a tempo?', segundos: 30 },
];
const SEG_MIN = 10, SEG_MAX = 180;
const INSTAVEL_MS = 2 * 60 * 1000, DESLIGADA_MS = 5 * 60 * 1000;
const GUARDAR_DIAS = 90;
const CONFIG_PADRAO = { minutos: 5, inicio: '07:00', fim: '21:00', grupo: '', repetirHoras: 1, avisarVolta: true, resumoManha: true, horaResumo: '08:10', ativo: false };

let DIR = null, ARQ = null, estado = null, deps = {}, timerVarredura = null;
const idOk = i => /^[a-f0-9]{8,32}$/.test(String(i || ''));
const hhmmOk = h => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || ''));
const corta = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const mesStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const hhmm = iso => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const minutosDoDia = d => d.getHours() * 60 + d.getMinutes();
const hhmmMin = h => { const [a, b] = String(h).split(':').map(Number); return a * 60 + b; };

function init(d) {
  deps = d || {};
  DIR = path.join(deps.dataDir || path.join(__dirname, '..', 'data'), 'paineis-tvs');
  fs.mkdirSync(DIR, { recursive: true });
  ARQ = path.join(DIR, 'estado.json');
  try { estado = JSON.parse(fs.readFileSync(ARQ, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[PAINEIS] estado.json ilegível:', e.message); estado = null; }
  if (!estado || typeof estado !== 'object') estado = { telas: {}, config: {} };
  estado.telas = estado.telas || {};
  estado.config = { ...CONFIG_PADRAO, ...(estado.config || {}) };
  // banco: estado e quedas do mês vão pro Postgres na subida (o arquivo continua sendo a leitura)
  if (docs.disponivel()) { docs.gravar('estado', 'estado', estado); try { for (const f of fs.readdirSync(DIR)) { const m = f.match(/^quedas-(\d{4}-\d{2})\.json$/); if (m) docs.gravar('quedas', m[1], lerQuedas(m[1])); } } catch (e) {} }
  // Uma queda que ficou aberta quando o servidor parou continua aberta (a TV pode ter continuado desligada).
  clearInterval(timerVarredura);
  timerVarredura = setInterval(() => { try { varrer(); } catch (e) { console.error('[PAINEIS] varredura:', e.message); } }, 60 * 1000);
  if (timerVarredura.unref) timerVarredura.unref();
}
let gravarTimer = null;
function gravar(agora) {
  // Batimento chega a cada 30 s por tela: grava no máximo 1x a cada 5 s pra não martelar o disco.
  if (agora) { clearTimeout(gravarTimer); gravarTimer = null; fs.writeFileSync(ARQ, JSON.stringify(estado, null, 1)); docs.gravar('estado', 'estado', estado); return; }
  if (gravarTimer) return;
  gravarTimer = setTimeout(() => { gravarTimer = null; try { fs.writeFileSync(ARQ, JSON.stringify(estado, null, 1)); docs.gravar('estado', 'estado', estado); } catch (e) { console.error('[PAINEIS] gravar:', e.message); } }, 5000);
}

// ── quedas (um arquivo por mês) ──────────────────────────────────────────────────────────────────────────────────
function arqQuedas(mes) { return path.join(DIR, `quedas-${mes}.json`); }
function lerQuedas(mes) { try { const a = JSON.parse(fs.readFileSync(arqQuedas(mes), 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function gravarQuedas(mes, lista) { fs.writeFileSync(arqQuedas(mes), JSON.stringify(lista, null, 1)); docs.gravar('quedas', mes, lista); }
function registrarQueda(q) { const mes = mesStr(new Date(q.de)); const l = lerQuedas(mes); l.push(q); gravarQuedas(mes, l); }
function fecharQueda(telaId, de, ate) {
  const mes = mesStr(new Date(de)); const l = lerQuedas(mes);
  const q = l.find(x => x.tela === telaId && x.de === de && !x.ate);
  if (q) { q.ate = ate; q.min = Math.round((new Date(ate) - new Date(de)) / 60000); gravarQuedas(mes, l); }
  return q;
}
function limparAntigas() {
  const limite = new Date(Date.now() - GUARDAR_DIAS * 86400000);
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/^quedas-(\d{4})-(\d{2})\.json$/); if (!m) continue;
    if (new Date(Number(m[1]), Number(m[2]), 1) < limite) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) {} }
  }
}

// ── batimento ─────────────────────────────────────────────────────────────────────────────────────────────────────
function batimento(b, ip) {
  const id = String(b.id || '').toLowerCase(); const painel = String(b.painel || '');
  if (!idOk(id)) throw new Error('id inválido');
  if (!PAINEIS[painel]) throw new Error('painel desconhecido');
  const agora = new Date().toISOString();
  let t = estado.telas[id];
  if (!t) {
    t = { id, painel, nome: PAINEIS[painel].nome, local: PAINEIS[painel].local, criadoEm: agora, primeiroSinal: agora, ligadaDesde: agora, quedas: 0 };
    estado.telas[id] = t;
    console.log(`[PAINEIS] tela nova: ${painel} ${id} (${ip})`);
  }
  const antes = t.ultimoSinal ? new Date(t.ultimoSinal).getTime() : 0;
  const gap = antes ? Date.now() - antes : 0;
  if (!t.primeiroSinal) { t.primeiroSinal = agora; t.ligadaDesde = agora; }
  if (t.quedaAberta) {
    // estava desligada e voltou
    fecharQueda(id, t.quedaAberta, agora);
    t.ligadaDesde = agora;
    const foraMin = Math.round((Date.now() - new Date(t.quedaAberta)) / 60000);
    if (t.avisadoEm && estado.config.avisarVolta) avisar(`✅ ${t.nome} · ${t.local} voltou\nFicou fora ${fmtMin(foraMin)} (${hhmm(t.quedaAberta)} a ${hhmm(agora)}).`, t).catch(() => {});
    t.quedaAberta = null; t.avisadoEm = null; t.ultimoAviso = null;
  } else if (antes && gap > DESLIGADA_MS) {
    // a varredura ainda não tinha visto a queda (servidor reiniciou, por exemplo): registra e já fecha
    registrarQueda({ tela: id, painel, nome: t.nome, local: t.local, de: t.ultimoSinal, ate: agora, min: Math.round(gap / 60000), aviso: null });
    t.ligadaDesde = agora;
  } else if (antes && gap > INSTAVEL_MS) {
    t.oscilacoes = (t.oscilacoes || 0) + 1;
    registrarQueda({ tela: id, painel, nome: t.nome, local: t.local, de: t.ultimoSinal, ate: agora, min: Math.round(gap / 60000), aviso: null, curta: true });
  }
  if (!t.ligadaDesde) t.ligadaDesde = agora;
  t.ultimoSinal = agora;
  t.ip = corta(ip, 45); t.ua = corta(b.ua, 160);
  t.tela = corta(b.tela, 20); t.slide = corta(b.slide, 120); t.versao = corta(b.versao, 40); t.url = corta(b.url, 120);
  t.ligadaHa = b.ligadaHa != null ? Number(b.ligadaHa) || 0 : t.ligadaHa;   // segundos desde que a página abriu (a própria TV conta)
  gravar();
  // versaoPagina = data do arquivo da página no servidor: a tela recarrega sozinha quando muda (tv-heartbeat.js), igual
  // ao `versao` que as TVs de token já recebem no payload — o Painel Compras só tinha este caminho (Tiago, 27/10)
  return { ok: true, id, nome: t.nome, versaoPagina: versaoPagina(painel) };
}
// A página da TV chamou a API dela (preços/marcações) — vale mesmo pra versão antiga da página, sem o batimento. Serve pra
// distinguir "TV desligada" de "TV ligada com a página antiga, precisa de F5" (Tiago, 27/10: "cadê painel televendas?").
function apiVista(painel, ip) {
  if (!PAINEIS[painel]) return;
  estado.api = estado.api || {};
  estado.api[painel] = { em: new Date().toISOString(), ip: corta(ip, 45) };
  gravar();
}
function versaoPagina(painel) {
  const p = PAINEIS[painel]; if (!p || !p.arquivo || !deps.publicDir) return null;
  try { return Math.round(fs.statSync(path.join(deps.publicDir, p.arquivo)).mtimeMs); } catch (e) { return null; }
}

// Roda a cada minuto: quem passou de 5 min sem sinal ganha uma queda aberta (e aviso, se a regra permitir).
function varrer() {
  const agora = Date.now(); let mudou = false;
  for (const t of Object.values(estado.telas)) {
    if (!t.ultimoSinal || t.quedaAberta) { if (t.quedaAberta) lembrar(t).catch(() => {}); continue; }
    if (agora - new Date(t.ultimoSinal).getTime() > DESLIGADA_MS) {
      t.quedaAberta = t.ultimoSinal; t.quedas = (t.quedas || 0) + 1; mudou = true;
      registrarQueda({ tela: t.id, painel: t.painel, nome: t.nome, local: t.local, de: t.ultimoSinal, ate: null, min: null, aviso: null });
      console.log(`[PAINEIS] ${t.nome} (${t.id}) sem sinal desde ${hhmm(t.ultimoSinal)}`);
      lembrar(t).catch(() => {});
    }
  }
  if (mudou) gravar(true);
  if (new Date().getHours() === 3 && new Date().getMinutes() === 0) limparAntigas();
  resumoManha().catch(() => {});
}

// ── avisos no WhatsApp ────────────────────────────────────────────────────────────────────────────────────────────
function dentroDoHorario(d) {
  const c = estado.config; const m = minutosDoDia(d || new Date());
  return m >= hhmmMin(c.inicio) && m <= hhmmMin(c.fim);
}
function fmtMin(min) { if (min < 60) return `${min} min`; const h = Math.floor(min / 60), m = min % 60; return m ? `${h} h ${m} min` : `${h} h`; }
async function avisar(texto, t) {
  if (!estado.config.ativo || !deps.enviarWpp) return false;
  try { await deps.enviarWpp({ grupo: estado.config.grupo || undefined, texto }); console.log(`[PAINEIS] aviso WhatsApp: ${texto.split('\n')[0]}`); return true; }
  catch (e) { console.error('[PAINEIS] aviso WhatsApp falhou:', e.message); return false; }
}
// Tela com queda aberta: avisa quando passar de `minutos` dentro do horário; repete a cada `repetirHoras` enquanto fora.
async function lembrar(t) {
  const c = estado.config; if (!c.ativo) return;
  const agora = Date.now(); const foraMin = Math.round((agora - new Date(t.quedaAberta)) / 60000);
  if (!dentroDoHorario(new Date())) return;
  if (foraMin < c.minutos) return;
  if (t.ultimoAviso && (c.repetirHoras <= 0 || agora - new Date(t.ultimoAviso).getTime() < c.repetirHoras * 3600000)) return;
  const primeira = !t.avisadoEm;
  const texto = primeira
    ? `⚠️ ${t.nome} · ${t.local} desligada\nSem sinal desde ${hhmm(t.quedaAberta)} (${fmtMin(foraMin)}).${t.slide ? `\nÚltima tela: ${t.slide}.` : ''}\nConfere se a TV está ligada e na entrada certa.`
    : `⚠️ ${t.nome} · ${t.local} continua desligada\nSem sinal desde ${hhmm(t.quedaAberta)} (${fmtMin(foraMin)}).`;
  if (await avisar(texto, t)) {
    const iso = new Date().toISOString(); t.avisadoEm = t.avisadoEm || iso; t.ultimoAviso = iso;
    const mes = mesStr(new Date(t.quedaAberta)); const l = lerQuedas(mes); const q = l.find(x => x.tela === t.id && x.de === t.quedaAberta);
    if (q) { q.aviso = q.aviso || hhmm(iso); gravarQuedas(mes, l); }
    gravar(true);
  }
}
// 08:10 (configurável): quais telas ainda não deram sinal hoje.
let resumoFeitoEm = null;
async function resumoManha() {
  const c = estado.config; if (!c.ativo || !c.resumoManha) return;
  const d = new Date(); const hoje = d.toISOString().slice(0, 10);
  if (resumoFeitoEm === hoje || minutosDoDia(d) !== hhmmMin(c.horaResumo || '08:10')) return;
  resumoFeitoEm = hoje;
  const fora = listar().telas.filter(t => t.status !== 'ligada');
  if (!fora.length) return;
  await avisar(`📺 Painéis às ${c.horaResumo || '08:10'}: ${fora.length} de ${Object.keys(estado.telas).length} sem sinal\n` + fora.map(t => `• ${t.nome} · ${t.local} — ${t.status === 'nunca' ? 'nunca ligou' : `último sinal ${hhmm(t.ultimoSinal)}`}`).join('\n'));
}

// ── leitura ───────────────────────────────────────────────────────────────────────────────────────────────────────
function statusDe(t, agora) {
  if (!t.ultimoSinal) return 'nunca';
  const gap = agora - new Date(t.ultimoSinal).getTime();
  if (gap > DESLIGADA_MS) return 'desligada';
  if (gap > INSTAVEL_MS) return 'instavel';
  return 'ligada';
}
// Linha do dia: trechos ligada/desligada de hoje a partir das quedas registradas + o estado atual.
function linhaDoDia(t, quedasHoje, agora) {
  const ini = new Date(); ini.setHours(0, 0, 0, 0); const ini0 = ini.getTime();
  const segs = quedasHoje.filter(q => q.tela === t.id).map(q => ({ de: Math.max(ini0, new Date(q.de).getTime()), ate: q.ate ? new Date(q.ate).getTime() : agora, curta: !!q.curta })).sort((a, b) => a.de - b.de);
  // primeiro sinal de hoje = fim da última queda que começou ontem, ou "ligadaDesde" se ela é de hoje
  const ld = t.ligadaDesde ? new Date(t.ligadaDesde).getTime() : null;
  const primeiro = segs.length && segs[0].de === ini0 ? segs[0].ate : (ld && ld >= ini0 ? Math.min(ld, ...segs.map(s => s.de)) : ini0);
  return { inicio: ini0, agora, quedas: segs, primeiro: t.ultimoSinal ? primeiro : null };
}
function listar() {
  const agora = Date.now(); const mes = mesStr(new Date());
  const hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0);
  const quedasMes = lerQuedas(mes);
  const quedasHoje = quedasMes.filter(q => new Date(q.ate || agora) >= hoje0);
  const telas = Object.values(estado.telas).map(t => {
    const status = statusDe(t, agora);
    const minhas = quedasHoje.filter(q => q.tela === t.id);
    return {
      id: t.id, painel: t.painel, nome: t.nome, local: t.local, status,
      ultimoSinal: t.ultimoSinal || null, segSemSinal: t.ultimoSinal ? Math.round((agora - new Date(t.ultimoSinal).getTime()) / 1000) : null,
      ligadaDesde: status === 'ligada' || status === 'instavel' ? t.ligadaDesde : null,
      ligadaHa: t.ligadaHa || null, quedaAberta: t.quedaAberta || null,
      quedasHoje: minhas.filter(q => !q.curta).length, oscilacoesHoje: minhas.filter(q => q.curta).length,
      ip: t.ip || null, tela: t.tela || null, slide: t.slide || null, versao: t.versao || null, ua: t.ua || null, url: t.url || null,
      avisadoEm: t.avisadoEm || null, criadoEm: t.criadoEm, pagina: PAINEIS[t.painel] ? PAINEIS[t.painel].pagina : null,
      dia: linhaDoDia(t, quedasHoje, agora),
    };
  }).sort((a, b) => Object.keys(PAINEIS).indexOf(a.painel) - Object.keys(PAINEIS).indexOf(b.painel) || a.nome.localeCompare(b.nome));
  const resumo = { total: telas.length, ligadas: telas.filter(t => t.status === 'ligada').length, instaveis: telas.filter(t => t.status === 'instavel').length,
                   desligadas: telas.filter(t => t.status === 'desligada').length, nunca: telas.filter(t => t.status === 'nunca').length };
  // painéis sem nenhum aparelho cadastrado: quando a API da TV foi chamada pela última vez (página antiga ou TV desligada?)
  const semTela = Object.keys(PAINEIS).filter(p => !telas.some(t => t.painel === p)).map(p => {
    const a = (estado.api || {})[p];
    return { painel: p, nome: PAINEIS[p].nome, local: PAINEIS[p].local, apiEm: a ? a.em : null, apiIp: a ? a.ip : null, apiSeg: a ? Math.round((agora - new Date(a.em).getTime()) / 1000) : null };
  });
  return { agora: new Date(agora).toISOString(), resumo, telas, semTela, paineis: PAINEIS, limites: { instavelMin: INSTAVEL_MS / 60000, desligadaMin: DESLIGADA_MS / 60000 } };
}
function quedas({ de, ate } = {}) {
  const d0 = de && /^\d{4}-\d{2}-\d{2}$/.test(de) ? new Date(de + 'T00:00:00') : new Date(Date.now() - 7 * 86400000);
  const d1 = ate && /^\d{4}-\d{2}-\d{2}$/.test(ate) ? new Date(ate + 'T23:59:59') : new Date();
  const meses = new Set([mesStr(d0), mesStr(d1)]);
  const cur = new Date(d0); while (cur < d1) { meses.add(mesStr(cur)); cur.setMonth(cur.getMonth() + 1); }
  const lista = [];
  for (const m of meses) for (const q of lerQuedas(m)) { const qd = new Date(q.de); if (qd >= d0 && qd <= d1) lista.push(q); }
  return lista.sort((a, b) => new Date(b.de) - new Date(a.de)).map(q => ({ ...q, foraDoHorario: !dentroDoHorario(new Date(q.de)) }));
}
function renomear(id, { nome, local }) {
  const t = estado.telas[id]; if (!t) throw new Error('tela não encontrada');
  if (nome != null) { const n = corta(nome, 40); if (!n) throw new Error('nome vazio'); t.nome = n; }
  if (local != null) t.local = corta(local, 60);
  gravar(true); return t;
}
function remover(id) { if (!estado.telas[id]) throw new Error('tela não encontrada'); delete estado.telas[id]; gravar(true); return { ok: true }; }
function getConfig() { return { ...estado.config }; }
function salvarConfig(p, usuario) {
  const c = { ...estado.config };
  if (p.minutos != null) { const m = Number(p.minutos); if (!(m >= 5 && m <= 120)) throw new Error('minutos entre 5 e 120'); c.minutos = Math.round(m); }
  if (p.inicio != null) { if (!hhmmOk(p.inicio)) throw new Error('horário de início inválido'); c.inicio = p.inicio; }
  if (p.fim != null) { if (!hhmmOk(p.fim)) throw new Error('horário de fim inválido'); c.fim = p.fim; }
  if (p.horaResumo != null) { if (!hhmmOk(p.horaResumo)) throw new Error('hora do resumo inválida'); c.horaResumo = p.horaResumo; }
  if (p.grupo != null) c.grupo = corta(p.grupo, 80);
  if (p.repetirHoras != null) { const r = Number(p.repetirHoras); if (!(r >= 0 && r <= 24)) throw new Error('repetir entre 0 e 24 h'); c.repetirHoras = r; }
  if (p.avisarVolta != null) c.avisarVolta = !!p.avisarVolta;
  if (p.resumoManha != null) c.resumoManha = !!p.resumoManha;
  if (p.ativo != null) c.ativo = !!p.ativo;
  c.atualizadoEm = new Date().toISOString(); c.atualizadoPor = usuario || null;
  estado.config = c; gravar(true); return getConfig();
}
// ── Painel Compras: ordem e liga/desliga dos painéis ─────────────────────────────────────────────────────────────
function getComprasConfig() {
  const c = estado.compras || {};
  const ordem = Array.isArray(c.ordem) ? c.ordem.filter(id => COMPRAS_PAINEIS.some(p => p.id === id)) : [];
  for (const p of COMPRAS_PAINEIS) if (!ordem.includes(p.id)) ordem.push(p.id);   // painel novo entra no fim
  const ligados = {}; for (const p of COMPRAS_PAINEIS) ligados[p.id] = c.ligados && c.ligados[p.id] === false ? false : true;
  const segundos = {}; for (const p of COMPRAS_PAINEIS) { const s = c.segundos && Number(c.segundos[p.id]); segundos[p.id] = s >= SEG_MIN && s <= SEG_MAX ? Math.round(s) : p.segundos; }
  const rolagem = { segPorLinha: c.rolagem && c.rolagem.segPorLinha >= 0.5 && c.rolagem.segPorLinha <= 10 ? c.rolagem.segPorLinha : 2.5, pausa: c.rolagem && c.rolagem.pausa >= 0 && c.rolagem.pausa <= 15 ? c.rolagem.pausa : 3 };   // carrossel subindo (29/10): mesma velocidade em todas as telas
  return { ordem, ligados, segundos, rolagem, paineis: COMPRAS_PAINEIS, atualizadoEm: c.atualizadoEm || null, atualizadoPor: c.atualizadoPor || null, versao: c.versao || 0 };
}
function salvarComprasConfig(p, usuario) {
  const atual = getComprasConfig();
  const ordem = Array.isArray(p.ordem) ? p.ordem.map(String).filter((id, i, a) => COMPRAS_PAINEIS.some(x => x.id === id) && a.indexOf(id) === i) : atual.ordem;
  for (const x of COMPRAS_PAINEIS) if (!ordem.includes(x.id)) ordem.push(x.id);
  const ligados = { ...atual.ligados };
  if (p.ligados && typeof p.ligados === 'object') for (const x of COMPRAS_PAINEIS) if (x.id in p.ligados) ligados[x.id] = !!p.ligados[x.id];
  if (!Object.values(ligados).some(Boolean)) throw new Error('Deixe pelo menos um painel ligado.');
  const segundos = { ...atual.segundos };
  if (p.segundos && typeof p.segundos === 'object') for (const x of COMPRAS_PAINEIS) if (x.id in p.segundos) { const s = Number(p.segundos[x.id]); if (!(s >= SEG_MIN && s <= SEG_MAX)) throw new Error(`Tempo de "${x.nome}" entre ${SEG_MIN} e ${SEG_MAX} s.`); segundos[x.id] = Math.round(s); }
  const rolagem = { ...atual.rolagem };
  if (p.rolagem && typeof p.rolagem === 'object') {
    if (p.rolagem.segPorLinha != null) { const v = Number(p.rolagem.segPorLinha); if (!(v >= 0.5 && v <= 10)) throw new Error('Velocidade do carrossel: entre 0,5 e 10 segundos por linha.'); rolagem.segPorLinha = Math.round(v * 10) / 10; }
    if (p.rolagem.pausa != null) { const v = Number(p.rolagem.pausa); if (!(v >= 0 && v <= 15)) throw new Error('Pausa do carrossel: entre 0 e 15 segundos.'); rolagem.pausa = Math.round(v * 10) / 10; }
  }
  estado.compras = { ordem, ligados, segundos, rolagem, atualizadoEm: new Date().toISOString(), atualizadoPor: usuario || null, versao: (atual.versao || 0) + 1 };
  gravar(true); return getComprasConfig();
}
// ── Painel Fiscal (30/10/26): telas, ordem, segundos por página, alerta de reconferência e lojas ─────────────────
// A ordem padrão segue o caminho da nota dentro do fiscal (Tiago, 30/10). A TV (painel-fiscal.html) lê a cada 30 s.
const FISCAL_PAINEIS = [
  { id: 'recebendo', nome: 'Chegaram', desc: 'Notas no coletor (aguardando ou em contagem), uma página por loja', segundos: 15 },
  { id: 'reconf', nome: 'Reconferência', desc: 'A loja tem que recontar · motivo grande · só aparece quando tem', segundos: 15 },
  { id: 'excecao', nome: 'Divergências', desc: 'XML × coletor × pedido esperando decisão', segundos: 15 },
  { id: 'pronto', nome: 'Pronto pra liberar', desc: 'Conferida sem divergência, só falta liberar no ERP', segundos: 15 },
  { id: 'quadro', nome: 'Quadro por loja', desc: 'Resumo E1 a E6: onde está o gargalo', segundos: 25 },
  { id: 'caminho', nome: 'A caminho e atrasados', desc: 'Pedidos com NF-e emitida e pedidos sem nota atrasados', segundos: 15 },
  { id: 'semconf', nome: 'NF-e sem conferência', desc: 'Emitida há 2 dias ou mais e ninguém conferiu', segundos: 15 },
];
const FISCAL_LOJAS = [1, 2, 3, 4, 5, 6];
function getFiscalConfig() {
  const c = estado.fiscal || {};
  const ordem = Array.isArray(c.ordem) ? c.ordem.filter(id => FISCAL_PAINEIS.some(p => p.id === id)) : [];
  for (const p of FISCAL_PAINEIS) if (!ordem.includes(p.id)) ordem.push(p.id);
  const ligados = {}; for (const p of FISCAL_PAINEIS) ligados[p.id] = c.ligados && c.ligados[p.id] === false ? false : true;
  const segundos = {}; for (const p of FISCAL_PAINEIS) { const s = c.segundos && Number(c.segundos[p.id]); segundos[p.id] = s >= SEG_MIN && s <= SEG_MAX ? Math.round(s) : p.segundos; }
  const a = c.alerta || {};
  const alerta = { ligado: a.ligado !== false, som: a.som !== false, segundos: a.segundos >= 3 && a.segundos <= 120 ? a.segundos : 5 };
  const lojas = Array.isArray(c.lojas) && c.lojas.length ? c.lojas.map(Number).filter(l => FISCAL_LOJAS.includes(l)) : FISCAL_LOJAS.slice();
  const rolagem = { segPorLinha: c.rolagem && c.rolagem.segPorLinha >= 0.5 && c.rolagem.segPorLinha <= 10 ? c.rolagem.segPorLinha : 2.5, pausa: c.rolagem && c.rolagem.pausa >= 0 && c.rolagem.pausa <= 15 ? c.rolagem.pausa : 3 };
  return { ordem, ligados, segundos, alerta, lojas, rolagem, paineis: FISCAL_PAINEIS, todasLojas: FISCAL_LOJAS, atualizadoEm: c.atualizadoEm || null, atualizadoPor: c.atualizadoPor || null, versao: c.versao || 0 };
}
function salvarFiscalConfig(p, usuario) {
  const atual = getFiscalConfig();
  const ordem = Array.isArray(p.ordem) ? p.ordem.map(String).filter((id, i, a) => FISCAL_PAINEIS.some(x => x.id === id) && a.indexOf(id) === i) : atual.ordem;
  for (const x of FISCAL_PAINEIS) if (!ordem.includes(x.id)) ordem.push(x.id);
  const ligados = { ...atual.ligados };
  if (p.ligados && typeof p.ligados === 'object') for (const x of FISCAL_PAINEIS) if (x.id in p.ligados) ligados[x.id] = !!p.ligados[x.id];
  if (!Object.values(ligados).some(Boolean)) throw new Error('Deixe pelo menos uma tela ligada.');
  const segundos = { ...atual.segundos };
  if (p.segundos && typeof p.segundos === 'object') for (const x of FISCAL_PAINEIS) if (x.id in p.segundos) { const s = Number(p.segundos[x.id]); if (!(s >= SEG_MIN && s <= SEG_MAX)) throw new Error(`Tempo de "${x.nome}" entre ${SEG_MIN} e ${SEG_MAX} s.`); segundos[x.id] = Math.round(s); }
  const alerta = { ...atual.alerta };
  if (p.alerta && typeof p.alerta === 'object') {
    if ('ligado' in p.alerta) alerta.ligado = !!p.alerta.ligado;
    if ('som' in p.alerta) alerta.som = !!p.alerta.som;
    if (p.alerta.segundos != null) { const v = Number(p.alerta.segundos); if (!(v >= 3 && v <= 120)) throw new Error('Tempo do alerta: entre 3 e 120 segundos.'); alerta.segundos = Math.round(v); }
  }
  let lojas = atual.lojas;
  if (Array.isArray(p.lojas)) { lojas = [...new Set(p.lojas.map(Number))].filter(l => FISCAL_LOJAS.includes(l)).sort((a, b) => a - b); if (!lojas.length) throw new Error('Deixe pelo menos uma loja.'); }
  const rolagem = { ...atual.rolagem };
  if (p.rolagem && typeof p.rolagem === 'object') {
    if (p.rolagem.segPorLinha != null) { const v = Number(p.rolagem.segPorLinha); if (!(v >= 0.5 && v <= 10)) throw new Error('Velocidade do carrossel: entre 0,5 e 10 segundos por linha.'); rolagem.segPorLinha = Math.round(v * 10) / 10; }
    if (p.rolagem.pausa != null) { const v = Number(p.rolagem.pausa); if (!(v >= 0 && v <= 15)) throw new Error('Pausa do carrossel: entre 0 e 15 segundos.'); rolagem.pausa = Math.round(v * 10) / 10; }
  }
  estado.fiscal = { ordem, ligados, segundos, alerta, lojas, rolagem, atualizadoEm: new Date().toISOString(), atualizadoPor: usuario || null, versao: (atual.versao || 0) + 1 };
  gravar(true); return getFiscalConfig();
}
async function testarAviso() {
  if (!deps.enviarWpp) throw new Error('robô de WhatsApp não configurado');
  await deps.enviarWpp({ grupo: estado.config.grupo || undefined, texto: `📺 Teste dos avisos de Painéis e TVs (${hhmm(new Date().toISOString())}). Se chegou, a regra está no grupo certo.` });
  return { ok: true };
}

module.exports = { init, batimento, apiVista, listar, quedas, renomear, remover, getConfig, salvarConfig, getComprasConfig, salvarComprasConfig, getFiscalConfig, salvarFiscalConfig, testarAviso, varrer, PAINEIS, _estado: () => estado };
