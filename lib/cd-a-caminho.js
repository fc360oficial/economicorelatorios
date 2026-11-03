// lib/cd-a-caminho.js — mercadoria a caminho do CD (loja 10, CAHU Distribuidora), pro CD em 3D (03/11/2026, Tiago:
// "pode ser pedido que tá a caminho do CD").
//
// O CD não compra pelo nosso Pedidos de Compra (0 pedidos da loja 10 em 03/11) e quase não tem pedidocompra aberto no ERP.
// O que está a caminho de verdade é a NF-e que o fornecedor já emitiu pro CNPJ do CD e que ainda não deu entrada
// (central.axml, Importado=0). Mesma regra do Radar e dos Pedidos do CD (lib/nfe-pendentes.js): separa entrega de
// devolução (CFOP) e descarta a entrega que voltou pela contranota espelho. Janela de 30 dias.
// Nota de loja da rede (CNPJ de E1..E6) = transferência. Nota parada há mais de 7 dias costuma ser entrada esquecida ou
// uso e consumo (combustível, peças): a tela mostra a idade e não esconde.
// Também lista os pedidos de compra da loja 10 abertos no ERP (Status 0/1, 30 dias). SOMENTE LEITURA. Cache de 5 min.
'use strict';

const { corteAxml } = require('./axml-corte');
const { nfePendentes } = require('./nfe-pendentes');
const { LOJA_CNPJ } = require('./conferencia-xml');

const CNPJ_CD = '61920643000148';
const TTL_MS = 5 * 60 * 1000;
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDias = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
const r2 = v => Math.round(v * 100) / 100;
const so = s => String(s || '').replace(/\D/g, '');
const LOJA_DO_CNPJ = Object.fromEntries(Object.entries(LOJA_CNPJ).map(([l, c]) => [c, +l]));

let q = null, cache = null, calc = null;
function init(d) { q = d.q; }

async function montar() {
  const hoje = iso(new Date()), desde = addDias(hoje, -30);
  const corteX = await corteAxml(q, desde);
  const pend = await nfePendentes(q, corteX, desde, { [CNPJ_CD]: 10 });
  const todas = Object.values(pend.porRaizLoja).flat();
  const notas = todas.filter(n => n.tipo === 'entrega' && !n.devolvida);
  // nome do emitente pelo CNPJ completo (o cadastro guarda com pontuação)
  const cnpjs = [...new Set(notas.map(n => so(n.cnpjEmit)).filter(Boolean))], nome = {};
  if (cnpjs.length) {
    const rows = await q(`SELECT Nome, CNPJ FROM central.fornecedor WHERE REPLACE(REPLACE(REPLACE(CNPJ,'.',''),'/',''),'-','') IN (${cnpjs.map(() => '?').join(',')})`, cnpjs).catch(() => []);
    for (const r of rows) { const c = so(r.CNPJ); if (!nome[c]) nome[c] = String(r.Nome || '').trim(); }
  }
  const lista = notas.map(n => {
    const c = so(n.cnpjEmit), loja = LOJA_DO_CNPJ[c] || null;
    return { nNota: n.nNota, data: n.data, dias: diasEntre(n.data, hoje), chave: n.chave || null, cnpj: c, fornecedor: nome[c] || (loja ? 'Loja ' + loja : 'CNPJ ' + c),
      transferencia: loja, valor: r2(n.valor || 0), itens: Object.keys(n.itens || {}).length };
  }).sort((a, b) => a.dias - b.dias || b.valor - a.valor);
  let pedidos = [];
  try {
    pedidos = (await q(`SELECT p.nReg, p.Status, DATE_FORMAT(p.DataPedido,'%Y-%m-%d') dp, TRIM(f.Nome) nome FROM central.pedidocompra p LEFT JOIN central.fornecedor f ON f.CodFornec=p.CodFornec
      WHERE p.nLoja=10 AND p.Status IN (0,1) AND p.DataPedido>=? ORDER BY p.DataPedido DESC LIMIT 30`, [desde]))
      .map(r => ({ pedido: r.nReg, data: r.dp, dias: r.dp ? diasEntre(r.dp, hoje) : null, fornecedor: r.nome || '—', status: +r.Status }));
  } catch (e) { console.error('[CD-A-CAMINHO] pedidos:', e.message); }
  const soma = a => r2(a.reduce((s, n) => s + n.valor, 0));
  const recentes = lista.filter(n => n.dias <= 7), paradas = lista.filter(n => n.dias > 7);
  return { hoje, desde, notas: lista, total: { n: lista.length, v: soma(lista) }, recentes: { n: recentes.length, v: soma(recentes) }, paradas: { n: paradas.length, v: soma(paradas) },
    transferencias: lista.filter(n => n.transferencia).length, devolvidas: todas.filter(n => n.tipo === 'entrega' && n.devolvida).length, itensOk: pend.itensOk, pedidos, atualizadoEm: new Date().toISOString() };
}
async function aCaminho() {
  if (cache && Date.now() - cache.em < TTL_MS) return cache.r;
  if (calc) return calc;
  calc = montar().then(r => { cache = { em: Date.now(), r }; return r; }).finally(() => { calc = null; });
  return calc;
}

// dados de exemplo (TESTE) pro ?demo=1
function demo() {
  const hoje = iso(new Date());
  const F = [['TRES CORACOES ALIMENTOS SA (TESTE)', 0, 18450.3, 12], ['INDUSTRIAS REUNIDAS RAYMUNDO DA FONTE (TESTE)', 1, 32110, 20], ['PESSOA PERNAMBUCO DISTRIBUIDOR (TESTE)', 2, 9870.5, 8],
    ['MALU INDUSTRIA E COMERCIO (TESTE)', 3, 5420, 6], ['FACILITY ATACADO HIGIENE (TESTE)', 5, 7310.9, 14], ['ATACAREJO ECONOMICO (TESTE)', 4, 2210, 5, 4], ['JARDIM ATLANTICO ALIMENTOS (TESTE)', 6, 4120, 7],
    ['POSTO FIJI COMBUSTIVEIS (TESTE)', 18, 1850, 1], ['ATACAREJO SANTA CLARA (TESTE)', 21, 6630, 9], ['INDUSTRIAS REUNIDAS RAYMUNDO DA FONTE (TESTE)', 25, 28900, 18]];
  const notas = F.map(([f, d, v, i, loja], k) => ({ nNota: String(641000 + k), data: addDias(hoje, -d), dias: d, chave: null, cnpj: '000000000000' + pad(k), fornecedor: f, transferencia: loja || null, valor: v, itens: i }));
  const soma = a => r2(a.reduce((s, n) => s + n.valor, 0)), rec = notas.filter(n => n.dias <= 7), par = notas.filter(n => n.dias > 7);
  return { hoje, desde: addDias(hoje, -30), notas, total: { n: notas.length, v: soma(notas) }, recentes: { n: rec.length, v: soma(rec) }, paradas: { n: par.length, v: soma(par) }, transferencias: 1, devolvidas: 0, itensOk: true,
    pedidos: [{ pedido: 9001, data: addDias(hoje, -13), dias: 13, fornecedor: 'NESTLE BRASIL (TESTE)', status: 1 }], atualizadoEm: new Date().toISOString() };
}

module.exports = { init, aCaminho, demo, CNPJ_CD };
