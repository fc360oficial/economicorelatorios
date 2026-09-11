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
  const total = Object.values(pedidoCx).reduce((a, b) => a + b, 0);
  const est = Math.max(0, Math.floor(estoqueCx));
  if (total <= est) return { pedidoCx: { ...pedidoCx }, falta: 0 };
  const out = {}; for (const ln of Object.keys(pedidoCx)) out[ln] = 0;
  let restante = est;
  while (restante > 0) {
    const cand = Object.keys(pedidoCx).filter(ln => out[ln] < pedidoCx[ln])
      .sort((a, b) => (cobertura[a] ?? 9999) - (cobertura[b] ?? 9999) || (+a) - (+b));
    if (!cand.length) break;
    out[cand[0]]++; restante--;
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
module.exports = { ean13Valido, dun14ParaEan13, emCaixas, distribuirCdInsuficiente, statusRecebimento, mediaLead };
