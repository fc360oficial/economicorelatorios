// lib/pedidos-cd-util.js — funções puras dos Pedidos do CD (sem ERP, sem fs)
function digitoEan13(b12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += (+b12[i]) * (i % 2 ? 3 : 1);
  return String((10 - s % 10) % 10);
}
function ean13Valido(s) {
  return /^\d{13}$/.test(s || '') && digitoEan13(s.slice(0, 12)) === s[12];
}
// DUN-14 (código de caixa) = indicador (1 dígito) + 12 dígitos do EAN-13 da unidade + verificador próprio
function dun14ParaEan13(cod14) {
  if (!/^\d{14}$/.test(cod14 || '')) return null;
  const b12 = cod14.slice(1, 13);
  return b12 + digitoEan13(b12);
}
function emCaixas(unidades, unPorCaixa) {
  if (!(unPorCaixa >= 1) || !(unidades > 0)) return 0;
  return Math.ceil(unidades / unPorCaixa);
}
// Quando as lojas pedem mais caixas do que o CD tem: entrega uma caixa por vez,
// sempre pra loja de menor cobertura que ainda não recebeu tudo que pediu.
function distribuirCdInsuficiente(pedidoCx, estoqueCx, cobertura) {
  // Quando as lojas pedem mais caixas do que o CD tem: reparte UMA caixa por vez entre TODAS as lojas que
  // pediram (ordem: menor cobertura primeiro, empate pelo nº da loja), rodada após rodada, até acabar o estoque.
  // Assim nenhuma loja zerada fica sem nada só porque outra tinha cobertura um pouco menor (caso Capricche:
  // 13 cx no CD, L2/L3 levavam tudo e L4/L5 ficavam sem).
  const total = Object.values(pedidoCx).reduce((a, b) => a + b, 0);
  const est = Math.max(0, Math.floor(estoqueCx));
  if (total <= est) return { pedidoCx: { ...pedidoCx }, falta: 0 };
  const out = {}; for (const ln of Object.keys(pedidoCx)) out[ln] = 0;
  const ordem = Object.keys(pedidoCx).filter(ln => pedidoCx[ln] > 0)
    .sort((a, b) => (cobertura[a] ?? 9999) - (cobertura[b] ?? 9999) || (+a) - (+b));
  let restante = est;
  while (restante > 0) {
    let deu = false;
    for (const ln of ordem) { if (restante <= 0) break; if (out[ln] < pedidoCx[ln]) { out[ln]++; restante--; deu = true; } }
    if (!deu) break;
  }
  return { pedidoCx: out, falta: total - est };
}

function statusRecebimento(itens) {
  const rec = itens.reduce((a, i) => a + Math.min(i.recebidas || 0, i.caixas), 0);
  const ped = itens.reduce((a, i) => a + i.caixas, 0);
  if (ped > 0 && rec >= ped) return 'recebido';
  if (rec > 0) return 'recebido_parcial';
  return 'aberto';
}
function mediaLead(pares) {
  const ds = pares.map(p => Math.round((new Date(p.nota + 'T00:00:00Z') - new Date(p.entrada + 'T00:00:00Z')) / 864e5)).filter(d => d >= 0 && d <= 30);
  if (!ds.length) return null;
  const m = ds.reduce((a, b) => a + b, 0) / ds.length;
  return { lead_medio: +m.toFixed(1), lead_max: Math.max(...ds), n: ds.length };
}
// ── Casamento caixa ↔ unidade pela DESCRIÇÃO ─────────────────────────────────
// Caixa no CD "ARROZ BRANCO POP 1KG PC10" × unidade na loja "POP ARROZ 1KG BRANCO": mesmas palavras
// em ordem diferente, com a embalagem (PC10/CX24/FD12…) só na caixa. Compara por palavras, sem ordem,
// ignorando acento e tokens de embalagem; abreviação vale por prefixo (PARB ~ PARBOILIZADO, CR ~ CREME).
const TOKEN_EMB = /^(CX|PC|PCT|FD|DP|DZ|PT|UN|UND|KIT|PACK)\d*$|^C\/?\d+$|^\d+PCT$|^\d+X\d+$/;
function tokensDescricao(desc, tiraEmbalagem = true) {
  let t = String(desc || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(CX|PC|PCT|FD|C)\/(\d+)/g, '$1$2')   // "CX/27", "C/12" \u2192 "CX27", "C12" (BOVINO/FRANGO continua separando)
    .replace(/[^A-Z0-9,]/g, ' ').split(/\s+/).filter(Boolean);
  if (tiraEmbalagem) t = t.filter(x => !TOKEN_EMB.test(x));
  return t;
}
const tokenBate = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (b.startsWith(a) || a.startsWith(b)));
// cobertura = fração das palavras da caixa achadas na unidade; extra = palavras da unidade que sobraram
function pontuarDescricao(tokensCaixa, tokensUnidade) {
  let hit = 0; const usados = new Set();
  for (const bt of tokensCaixa) { const i = tokensUnidade.findIndex((ct, k) => !usados.has(k) && tokenBate(bt, ct)); if (i >= 0) { hit++; usados.add(i); } }
  return { hit, cobertura: tokensCaixa.length ? hit / tokensCaixa.length : 0, extra: tokensUnidade.length - hit };
}
// unidades: [{ cod, descricao, tokens? }]. Devolve { candidato, alternativas } — candidato só quando há UMA
// unidade com todas as palavras da caixa e nenhuma outra tão boa quanto ela (empate → só alternativas).
function casarPorDescricao(descricaoCaixa, unidades, { maxAlternativas = 4 } = {}) {
  const bt = tokensDescricao(descricaoCaixa);
  if (bt.length < 2) return { candidato: null, alternativas: [] };
  const cands = [];
  for (const u of unidades) {
    const s = pontuarDescricao(bt, u.tokens || tokensDescricao(u.descricao));
    if (s.cobertura >= 0.75 && s.hit >= 2) cands.push({ cod: String(u.cod), descricao: u.descricao, cobertura: s.cobertura, extra: s.extra });
  }
  cands.sort((a, b) => b.cobertura - a.cobertura || a.extra - b.extra || a.descricao.localeCompare(b.descricao));
  const alternativas = cands.slice(0, maxAlternativas).map(c => ({ cod: c.cod, descricao: c.descricao }));
  // única quando: bate todas as palavras sem sobra e nenhuma outra também bate tudo sem sobra; ou bate tudo com
  // 1 palavra sobrando e nenhuma outra bate tudo (POUCH PEDIGREE CARNE: "JR" e "ADULTO" batem tudo → não escolhe)
  const m = cands[0], s = cands[1];
  const outraCompleta = s && s.cobertura === 1;
  const unico = !!m && m.cobertura === 1 && ((m.extra === 0 && !(outraCompleta && s.extra === 0)) || (m.extra === 1 && !outraCompleta));
  return { candidato: unico ? m.cod : null, alternativas };
}
// Venda média por dia a partir do histórico mensal do Radar ({ 'YYYY-MM': [qtd, valor] }, até 24 meses):
// média dos MESES EM QUE VENDEU (30,4 d/mês). Usado quando os últimos 40 dias deram zero (produto que ficou em falta).
function mediaMensal(mensal) {
  const meses = Object.entries(mensal || {}).filter(([, v]) => Array.isArray(v) && +v[0] > 0).sort((a, b) => a[0].localeCompare(b[0]));
  if (!meses.length) return { vq: 0, meses: 0, ultimo: null };
  const total = meses.reduce((a, [, v]) => a + (+v[0]), 0);
  return { vq: +(total / (meses.length * 30.4)).toFixed(3), meses: meses.length, ultimo: meses[meses.length - 1][0] };
}
module.exports = { ean13Valido, dun14ParaEan13, emCaixas, distribuirCdInsuficiente, statusRecebimento, mediaLead, tokensDescricao, casarPorDescricao, mediaMensal };
