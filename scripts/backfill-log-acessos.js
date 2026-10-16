'use strict';
// Reconstrói o Log de acessos (data/log-acessos) de um período em que ele ainda não existia,
// a partir de tudo em data/ que guarda "quem fez" + "quando": Log ERP (usuario/quando), pedidos ao
// fornecedor e cotações (por/em, realizadoPor/realizadoEm), conciliação (confirmadoPor, criadoPor),
// vínculos do CD, pontas de gôndola, formação de preço e a contagem de negativos (app por PIN, nome
// digitado). Cada ocorrência vira um evento tipo "atividade" (1 por usuário/fonte/minuto), com msg
// dizendo de onde veio. Sem IP/dispositivo — isso só existe desde 16/10/26.
//
// Uso: node scripts/backfill-log-acessos.js --de 2026-09-16 --ate 2026-10-16T10:31 [--dry]
// Pedido do Tiago em 16/10/26 ("jogue no log os últimos 30 dias de acesso").
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const LA = require('../lib/log-acessos');
const DIR = path.join(RAIZ, 'data', 'log-acessos');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const DE = arg('de', new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10));
const ATE = arg('ate', new Date().toISOString());
const DRY = process.argv.includes('--dry');

const usuarios = JSON.parse(fs.readFileSync(path.join(RAIZ, 'usuarios.json'), 'utf8'));
const porNome = new Map();
for (const u of usuarios) { porNome.set(u.usuario.toLowerCase(), u); porNome.set(u.nome.toLowerCase(), u); }

// Campos que dizem QUEM fez (ator). Campos de dados do ERP (NomeAutorizacao, Solicitante, Usuario
// dentro de linhas antes/depois) ficam de fora: são conteúdo das tabelas, não acesso ao sistema.
const CAMPOS_ATOR = ['usuario', 'por', 'confirmadoPor', 'realizadoPor', 'criadoPor', 'atualizadoPor', 'ajustadoPor', 'aprovadoPor', 'alertaVistoPor', 'criado_por', 'minimo_negociado_por'];
const CAMPOS_DATA = ['em', 'quando', 'confirmadoEm', 'realizadoEm', 'criadoEm', 'atualizadoEm', 'ajustadoEm', 'aprovadoEm', 'alertaVistoEm', 'criado_em', 'de'];
// Valores que não são pessoa (robôs, cargas, migrações, ações do Claude em nome do Tiago)
const RE_NAO_PESSOA = /^(carga\b|sistema|cotacao$|negativados$|teste-claude|ajuste carga|economico$|migra|coletor:|tiago \((pedido|via) )/i;
const SKIP_DIR = new Set(['apk', 'sessions', 'promocoes-pdf', 'xml-teste', 'log-acessos', 'itau', 'log-coletor', 'expedicao', 'recebimento']);

const FONTES = [
  [/^log-erp\//, 'Log ERP (escrita no teste)'],
  [/^pedidos-fornecedor\//, 'Pedido ao fornecedor'],
  [/^cotacoes\//, 'Cotação'],
  [/^(conciliacoes-avulsas|regras-conciliacao|cotacoes-conciliacao)\.json$/, 'Conciliação XML'],
  [/^cd-vinculos\.json$/, 'Pedidos CD'],
  [/^pontas-gondola\.json$/, 'Pontas de gôndola'],
  [/^contagem-negativos\//, 'Contagem de negativos (app PIN)'],
  [/^precificacao\//, 'Formação de preço'],
  [/^sugestoes-manuais\//, 'Sugestões de compra'],
  [/^fiscal\//, 'Fiscal'],
  [/^gente\//, 'Gente (DP/RH)'],
  [/^pedidos-cd\//, 'Pedidos CD'],
];
function fonteDe(rel) { for (const [re, nome] of FONTES) if (re.test(rel)) return nome; return rel.replace(/\/.*$/, ''); }

const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function dataDe(o) {
  for (const k of CAMPOS_DATA) if (typeof o[k] === 'string' && RE_ISO.test(o[k])) return o[k];
  for (const v of Object.values(o)) if (typeof v === 'string' && RE_ISO.test(v)) return v;
  return null;
}

const vistos = new Set();
const eventos = [];
const ignorados = {};
function anda(o, rel, prof = 0) {
  if (!o || typeof o !== 'object' || prof > 12) return;
  if (Array.isArray(o)) { for (const x of o) anda(x, rel, prof + 1); return; }
  const em = dataDe(o);
  if (em) {
    const emIso = new Date(em).toISOString();
    if (!isNaN(Date.parse(em)) && emIso.slice(0, 10) >= DE && em <= ATE) {
      for (const k of CAMPOS_ATOR) {
        const v = o[k];
        if (typeof v !== 'string' || !v.trim() || v.length > 60) continue;
        if (RE_NAO_PESSOA.test(v.trim())) { ignorados[v] = (ignorados[v] || 0) + 1; continue; }
        const u = porNome.get(v.trim().toLowerCase());
        const fonte = fonteDe(rel);
        let ev;
        if (u) ev = { usuario: u.usuario, nome: u.nome, perfil: u.perfil || 'gerente' };
        else if (/^contagem-negativos\//.test(rel)) ev = { usuario: 'contagem:' + v.trim().toLowerCase(), nome: v.trim(), perfil: 'auxiliar (PIN)' };
        else { ignorados[v] = (ignorados[v] || 0) + 1; continue; }
        const chave = ev.usuario + '|' + fonte + '|' + emIso.slice(0, 16);
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        eventos.push({ ...ev, tipo: 'atividade', pagina: fonte, msg: 'reconstruído de data/' + rel + ' (campo ' + k + ')', _em: new Date(em) });
      }
    }
  }
  for (const v of Object.values(o)) if (v && typeof v === 'object') anda(v, rel, prof + 1);
}
function varre(dir) {
  for (const n of fs.readdirSync(dir)) {
    if (SKIP_DIR.has(n)) continue;
    const p = path.join(dir, n), st = fs.statSync(p);
    if (st.isDirectory()) { varre(p); continue; }
    if (!/\.(json|jsonl)$/.test(n) || st.size > 150e6) continue;
    const rel = path.relative(path.join(RAIZ, 'data'), p).split(path.sep).join('/');
    try {
      const txt = fs.readFileSync(p, 'utf8');
      if (n.endsWith('.jsonl')) { for (const ln of txt.split('\n')) { if (!ln) continue; try { anda(JSON.parse(ln), rel); } catch {} } }
      else anda(JSON.parse(txt), rel);
    } catch (e) { console.error('erro lendo', rel, e.message); }
  }
}

// Não duplica o que já está no log (rodar 2× não dobra)
const jaTem = new Set();
// (lê 1 dia a mais de cada lado: o arquivo guarda hora local -03:00 e o filtro acima compara em UTC)
const diaMais = (d, n) => new Date(Date.parse(d.slice(0, 10)) + n * 86400e3).toISOString().slice(0, 10);
for (const e of LA.ler(DIR, { de: diaMais(DE, -1), ate: diaMais(ATE, 1), tipo: 'atividade', limite: 1e6 })) jaTem.add(e.usuario + '|' + e.pagina + '|' + new Date(e.em).toISOString().slice(0, 16));

varre(path.join(RAIZ, 'data'));
eventos.sort((a, b) => a._em - b._em);
const novos = eventos.filter(e => !jaTem.has(e.usuario + '|' + e.pagina + '|' + e._em.toISOString().slice(0, 16)));

const porUser = {}, porFonte = {};
for (const e of novos) { porUser[e.nome] = (porUser[e.nome] || 0) + 1; porFonte[e.pagina] = (porFonte[e.pagina] || 0) + 1; }
console.log(`período ${DE} → ${ATE} · ${eventos.length} atividades encontradas · ${novos.length} novas (${eventos.length - novos.length} já no log)`);
console.log('por usuário:', porUser);
console.log('por fonte:', porFonte);
console.log('ignorados (não é pessoa / nome desconhecido):', ignorados);
if (DRY) { console.log('(dry run — nada gravado)'); process.exit(0); }
let n = 0;
for (const e of novos) { const { _em, ...ev } = e; LA.registrar(DIR, ev, _em); n++; }
console.log(`gravados ${n} eventos em ${DIR}`);
