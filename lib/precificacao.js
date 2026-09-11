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

const ABERTO = ['a_precificar'];
function hist(r, acao, por, extra) { r.historico.push({ acao, por: por || null, em: new Date().toISOString(), ...(extra || {}) }); }

function editarItem(id, cod, v, usuario) {
  const r = obter(id); if (!r) return null;
  if (!ABERTO.includes(r.status)) return { erro: 'Registro fechado: reabra pra editar' };
  const it = r.itens.find(i => i.cod === String(cod)); if (!it) return { erro: 'Item não encontrado' };
  if (it.status === 'bloqueado') return { erro: 'Item bloqueado (' + it.motivo + ')' };
  if (v.preco_final != null) {
    const p = Math.round(parseFloat(v.preco_final) * 100) / 100;
    if (!(p > 0)) return { erro: 'Preço inválido' };
    if (p < it.custo_imposto - 1e-9) return { erro: 'Preço abaixo do custo com imposto (R$ ' + it.custo_imposto.toFixed(2) + ')' };
    it.preco_final = p; it.manual = true;
  }
  if (v.preco_atacado_final != null && it.atacado) {
    const p = Math.round(parseFloat(v.preco_atacado_final) * 100) / 100;
    if (!(p > 0)) return { erro: 'Preço atacado inválido' };
    if (p < it.custo_imposto - 1e-9) return { erro: 'Preço atacado abaixo do custo com imposto' };
    it.atacado.preco_final = p; it.manual = true;
  }
  hist(r, 'editar_item', usuario, { cod: it.cod, preco_final: it.preco_final });
  return salvar(r);
}

async function setParametros(id, p, usuario) {
  const r = obter(id); if (!r) return null;
  if (!ABERTO.includes(r.status)) return { erro: 'Registro fechado: reabra pra mudar política/arredondamento' };
  if (p.politica != null) { if (!calc.POLITICAS.includes(p.politica)) return { erro: 'Política inválida' }; r.parametros.politica = p.politica; }
  if (p.arredondamento != null) { if (!calc.TERMINACOES.includes(p.arredondamento)) return { erro: 'Arredondamento inválido' }; r.parametros.arredondamento = p.arredondamento; }
  hist(r, 'parametros', usuario, { ...r.parametros });
  salvar(r);
  return recalcular(id, { descartarManuais: false });
}

function fechar(id, usuario, opts = {}) {
  const r = obter(id); if (!r) return null;
  if (r.status !== 'a_precificar') return { erro: 'Só registro "a precificar" pode ser fechado' };
  const bloq = r.itens.filter(i => i.status === 'bloqueado').length;
  if (bloq && !opts.ignorarBloqueados) return { erro: bloq + ' item(ns) bloqueado(s): cadastre a margem e recalcule, ou feche ignorando' };
  r.status = 'precificado'; r.fechadoEm = new Date().toISOString(); r.fechadoPor = usuario || null;
  hist(r, 'fechar', usuario, { bloqueados_ignorados: bloq });
  return salvar(r);
}
function reabrir(id, usuario) {
  const r = obter(id); if (!r) return null;
  if (!['precificado', 'aplicado', 'conferido'].includes(r.status)) return { erro: 'Registro já está aberto' };
  r.status = 'a_precificar'; delete r.aplicadoEm; delete r.divergentes; for (const i of r.itens) delete i.erp;
  hist(r, 'reabrir', usuario);
  return salvar(r);
}
function aplicar(id, usuario) {
  const r = obter(id); if (!r) return null;
  if (r.status !== 'precificado') return { erro: 'Feche a lista antes de marcar como aplicada' };
  r.status = 'aplicado'; r.aplicadoEm = new Date().toISOString(); r.aplicadoPor = usuario || null;
  hist(r, 'aplicar', usuario);
  return salvar(r);
}

const TOL_ERP = 0.011;   // R$0,01
async function verificar(id) {
  const r = obter(id); if (!r) return null;
  if (!['aplicado', 'conferido'].includes(r.status)) return { erro: 'Só registro aplicado pode ser verificado' };
  const cods = r.itens.filter(i => i.status !== 'bloqueado').map(i => i.cod);
  const erp = await dadosERP(r.loja, cods);
  let div = 0;
  for (const i of r.itens) {
    if (i.status === 'bloqueado') { delete i.erp; continue; }
    const p = erp.preco[i.cod];
    const okV = p != null && Math.abs(p.varejo - i.preco_final) < TOL_ERP;
    const okA = !i.atacado || (p != null && Math.abs(p.atacado - i.atacado.preco_final) < TOL_ERP);
    i.erp = { preco: p?.varejo ?? null, atacado: i.atacado ? (p?.atacado ?? null) : null, ok: okV && okA };
    if (!i.erp.ok) div++;
  }
  r.status = 'conferido'; r.divergentes = div; r.verificadoEm = new Date().toISOString();
  return salvar(r);
}
async function verificarTodos() {
  const lim = Date.now() - 7 * 86400000;
  let verificados = 0, divergentes = 0;
  for (const r of listar()) {
    if (!['aplicado', 'conferido'].includes(r.status)) continue;
    if (!r.aplicadoEm || new Date(r.aplicadoEm).getTime() < lim) continue;
    try { const v = await verificar(r.id); verificados++; divergentes += v.divergentes || 0; } catch (e) { console.error('[PRECIF] verificar', r.id, e.message); }
  }
  return { verificados, divergentes };
}
function removerTestes() { let n = 0; for (const r of listar()) if (r.teste) { try { fs.unlinkSync(arq(r.id)); n++; } catch (e) {} } return n; }

module.exports = { init, initERP, setPadrao, getPadrao, criarDeConciliacao, recalcular, listar, obter, salvar, idDe, itensConciliados, rateioDe, editarItem, setParametros, fechar, reabrir, aplicar, verificar, verificarTodos, removerTestes };
