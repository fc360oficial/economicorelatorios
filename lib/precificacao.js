// Formação de Preço (sidebar "Precificação"). Um registro por pedido × loja, criado quando a
// loja fica "Conciliado XML". NADA é escrito no ERP: só SELECT (itens, custoloja, itens_margens).
'use strict';
const fs = require('fs');
const path = require('path');
const calc = require('./precificacao-calc');

let DIR = path.join(__dirname, '..', 'data', 'precificacao');
let qERP = null, radar = null;
let padrao = { politica: 'por_curva', arredondamento: '9' };

function init(opts = {}) { if (opts.dir) DIR = opts.dir; fs.mkdirSync(DIR, { recursive: true }); }
function initERP(q, radarMod) { qERP = q; radar = radarMod || null; }
function setPadrao(p) { padrao = { politica: calc.POLITICAS.includes(p?.politica) ? p.politica : padrao.politica, arredondamento: calc.TERMINACOES.includes(p?.arredondamento) ? p.arredondamento : padrao.arredondamento }; return padrao; }
function getPadrao() { return { ...padrao }; }

const arq = id => path.join(DIR, `${id}.json`);
const idDe = (pedidoId, ln) => `${pedidoId}-L${ln}`;
function salvar(r) { fs.writeFileSync(arq(r.id), JSON.stringify(r)); return r; }
function obter(id) { try { return JSON.parse(fs.readFileSync(arq(String(id)), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
const parsePreco = v => v && v !== '0' ? parseFloat(String(v).replace(',', '.')) || 0 : 0;

// itens da conferência que entram na precificação (recebidos e não recusados)
function itensConciliados(x) {
  const out = [];
  for (const i of x.itens || []) {
    if (!(i.recebida > 0)) continue;
    if (i.decisao?.acao === 'recusar' && i.tipo !== 'a_mais') continue;   // recusa de a_mais devolve só o excedente
    out.push({ cod: String(i.cod), descricao: i.descricao, recebida: i.recebida, custo_novo: +(i.preco_xml || 0) });
  }
  for (const i of x.nao_pedidos || []) if (i.decisao?.acao === 'aceitar' && i.recebida > 0) out.push({ cod: String(i.cod), descricao: i.descricao, recebida: i.recebida, custo_novo: +(i.preco_xml || 0), nao_pedido: true });
  return out;
}

function rateioDe(x) {
  const s = { frete: 0, ipi: 0, st: 0, desconto: 0, valorProduto: 0 };
  for (const n of x.notas || []) { s.frete += +(n.frete || 0); s.ipi += +(n.ipi || 0); s.st += +(n.st || 0); s.desconto += +(n.desconto || 0); s.valorProduto += +(n.valorProduto || 0); }
  const disponivel = s.valorProduto > 0;
  const fator = disponivel ? +(((s.frete + s.ipi + s.st - s.desconto) / s.valorProduto)).toFixed(6) : 0;
  return { ...s, fator, disponivel };
}

// dados do ERP pra UMA loja: preço de venda (P{n}, atacado a{n}), custo (custoloja{n}), margens
async function dadosERP(ln, cods) {
  const vazio = { preco: {}, custo: {}, margem: {}, existe: new Set() };
  if (!qERP || !cods.length) return vazio;
  const ph = cods.map(() => '?').join(',');
  const [itens, custos, margens] = await Promise.all([
    qERP(`SELECT CodigoBarra, P${ln} AS P, a${ln} AS A, CodDesativado FROM central.itens WHERE CodigoBarra IN (${ph})`, cods),
    qERP(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, cods),
    qERP(`SELECT CodigoBarra, MargemVarejo, MargemAtacado FROM central.itens_margens WHERE nLoja=? AND CodigoBarra IN (${ph})`, [ln, ...cods])
  ]);
  const d = { preco: {}, custo: {}, margem: {}, existe: new Set() };
  for (const r of itens) { const c = String(r.CodigoBarra); d.existe.add(c); d.preco[c] = { varejo: parsePreco(r.P), atacado: parsePreco(r.A) }; }
  for (const r of custos) d.custo[String(r.CodigoBarra)] = parsePreco(r.Custo);
  for (const r of margens) d.margem[String(r.CodigoBarra)] = { varejo: r.MargemVarejo != null ? +r.MargemVarejo : null, atacado: r.MargemAtacado != null ? +r.MargemAtacado : null };
  return d;
}

async function montarEntradas(reg, x) {
  const base = itensConciliados(x);
  const rateio = rateioDe(x);
  const erp = await dadosERP(reg.loja, base.map(b => b.cod));
  const curvaA = radar?.curvaASet ? radar.curvaASet() : new Set();
  reg.rateio = rateio;
  reg.entradas = base.map(b => {
    const ci = +(b.custo_novo * (1 + (rateio.disponivel ? rateio.fator : 0))).toFixed(4);
    const m = erp.margem[b.cod] || {};
    const e = {
      cod: b.cod, descricao: b.descricao, curvaA: curvaA.has(b.cod), recebida: b.recebida, nao_pedido: !!b.nao_pedido,
      custo_atual: erp.custo[b.cod] ?? null, custo_novo: b.custo_novo, custo_imposto: ci,
      margem: m.varejo ?? null, preco_atual: erp.preco[b.cod]?.varejo ?? null,
      margem_atacado: reg.loja === 4 ? (m.atacado ?? null) : null,
      preco_atacado_atual: reg.loja === 4 ? (erp.preco[b.cod]?.atacado ?? null) : null
    };
    if (!erp.existe.has(b.cod)) e.motivo_bloqueio = 'não casado no ERP (código ' + b.cod + ')';
    return e;
  });
}

async function criarDeConciliacao(p, ln) {
  const x = p.xml?.lojas?.[ln]; if (!x || x.status !== 'conciliado') return null;
  const id = idDe(p.id, ln);
  const existente = obter(id); if (existente) return existente;
  const reg = {
    id, pedidoId: p.id, loja: +ln, lista: p.lista, lista_nome: p.lista_nome, fornecedor: p.fornecedor, teste: !!p.teste,
    status: 'a_precificar', criadoEm: new Date().toISOString(), conciliadoEm: x.conferidoEm || null,
    parametros: { ...padrao }, rateio: null, entradas: [], itens: [], resumo: null, historico: [{ acao: 'criado', por: null, em: new Date().toISOString() }]
  };
  await montarEntradas(reg, x);
  calc.calcularRegistro(reg);
  return salvar(reg);
}

async function recalcular(id, opts = {}) {
  const reg = obter(id); if (!reg) return null;
  if (opts.doERP) {
    // re-lê preço/custo/margem do ERP mantendo os itens conciliados (custo XML não muda)
    const erp = await dadosERP(reg.loja, reg.entradas.map(e => e.cod));
    const curvaA = radar?.curvaASet ? radar.curvaASet() : new Set();
    for (const e of reg.entradas) {
      const m = erp.margem[e.cod] || {};
      e.curvaA = curvaA.has(e.cod); e.custo_atual = erp.custo[e.cod] ?? null; e.margem = m.varejo ?? null; e.preco_atual = erp.preco[e.cod]?.varejo ?? null;
      e.margem_atacado = reg.loja === 4 ? (m.atacado ?? null) : null; e.preco_atacado_atual = reg.loja === 4 ? (erp.preco[e.cod]?.atacado ?? null) : null;
      if (erp.existe.has(e.cod)) delete e.motivo_bloqueio; else e.motivo_bloqueio = 'não casado no ERP (código ' + e.cod + ')';
    }
  }
  calc.calcularRegistro(reg, { descartarManuais: !!opts.descartarManuais });
  return salvar(reg);
}

module.exports = { init, initERP, setPadrao, getPadrao, criarDeConciliacao, recalcular, listar, obter, salvar, idDe, itensConciliados, rateioDe };
