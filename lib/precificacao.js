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

// ids são sempre `<pedidoId>-L<loja>` (ou T<ts>-L4 no teste): só letras, dígitos, - e _.
// Qualquer outra coisa é recusada — sem isso `/api/precificacao/..%2F..%2Fusuarios` lia
// qualquer arquivo do servidor.
const ID_OK = /^[A-Za-z0-9_-]+$/;
const arq = id => { const s = String(id); if (!ID_OK.test(s)) throw new Error('id inválido'); return path.join(DIR, `${s}.json`); };
const idDe = (pedidoId, ln) => `${pedidoId}-L${ln}`;
function salvar(r) {
  fs.writeFileSync(arq(r.id), JSON.stringify(r));
  try { fs.unlinkSync(pdfPath(r.id)); } catch (e) {}   // PDF em cache vira lixo a cada gravação
  return r;
}
function obter(id) { try { return JSON.parse(fs.readFileSync(arq(String(id)), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
const parsePreco = v => v && v !== '0' ? parseFloat(String(v).replace(',', '.')) || 0 : 0;

const MOTIVO_UNIDADE = 'unidade da nota (caixa/fardo) não convertida — conferir';

// itens da conferência que entram na precificação (recebidos e não recusados)
function itensConciliados(x) {
  const out = [];
  for (const i of x.itens || []) {
    if (!(i.recebida > 0)) continue;
    if (i.decisao?.acao === 'recusar' && i.tipo !== 'a_mais') continue;   // recusa de a_mais devolve só o excedente
    const e = { cod: String(i.cod), descricao: i.descricao, recebida: i.recebida, custo_novo: +(i.preco_xml || 0) };
    if (i.conferir_unidade) e.motivo_bloqueio = MOTIVO_UNIDADE;
    out.push(e);
  }
  for (const i of x.nao_pedidos || []) {
    if (!(i.decisao?.acao === 'aceitar' && i.recebida > 0)) continue;
    const e = { cod: String(i.cod), descricao: i.descricao, recebida: i.recebida, custo_novo: +(i.preco_xml || 0), nao_pedido: true };
    // não-pedido não passa pela conversão de unidade da conferência: só bloqueia se o XML
    // mostrar unidade de compra não resolvida (sem `xml`, não dá pra afirmar nada)
    if (Array.isArray(i.xml) && i.xml.some(z => z.conversao === 'conferir' || z.conversao === 'pendente')) e.motivo_bloqueio = MOTIVO_UNIDADE;
    out.push(e);
  }
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
  const vazio = { preco: {}, custo: {}, margem: {}, existe: new Set(), desativado: new Set() };
  if (!qERP || !cods.length) return vazio;
  const ph = cods.map(() => '?').join(',');
  const [itens, custos, margens] = await Promise.all([
    qERP(`SELECT CodigoBarra, P${ln} AS P, a${ln} AS A, CodDesativado FROM central.itens WHERE CodigoBarra IN (${ph})`, cods),
    qERP(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, cods),
    qERP(`SELECT CodigoBarra, MargemVarejo, MargemAtacado FROM central.itens_margens WHERE nLoja=? AND CodigoBarra IN (${ph})`, [ln, ...cods])
  ]);
  const d = { preco: {}, custo: {}, margem: {}, existe: new Set(), desativado: new Set() };
  for (const r of itens) { const c = String(r.CodigoBarra); d.existe.add(c); if (+(r.CodDesativado || 0) !== 0) d.desativado.add(c); d.preco[c] = { varejo: parsePreco(r.P), atacado: parsePreco(r.A) }; }
  for (const r of custos) d.custo[String(r.CodigoBarra)] = parsePreco(r.Custo);
  for (const r of margens) d.margem[String(r.CodigoBarra)] = { varejo: r.MargemVarejo != null ? +r.MargemVarejo : null, atacado: r.MargemAtacado != null ? +r.MargemAtacado : null };
  return d;
}

// motivo do bloqueio vindo de fora do cálculo, na ordem em que a compradora precisa resolver
function aplicarBloqueio(e, erp) {
  if (!erp.existe.has(e.cod)) e.motivo_bloqueio = 'não casado no ERP (código ' + e.cod + ')';
  else if (erp.desativado.has(e.cod)) e.motivo_bloqueio = 'item desativado no ERP';
  else if (e.motivo_conferencia) e.motivo_bloqueio = e.motivo_conferencia;
  else delete e.motivo_bloqueio;
  return e;
}

// curva A vem do radar, que fica ~90 s sem base depois de subir: null = indisponível (não é
// "nenhum item é curva A"), e aí a política por_curva não pode repassar queda em silêncio.
function curvaSet() { const s = radar?.curvaASet ? radar.curvaASet() : null; return s || null; }

async function montarEntradas(reg, x) {
  const base = itensConciliados(x);
  const rateio = rateioDe(x);
  const erp = await dadosERP(reg.loja, base.map(b => b.cod));
  const curvaA = curvaSet();
  reg.curva_disponivel = !!curvaA;
  reg.rateio = rateio;
  reg.entradas = base.map(b => {
    const ci = +(b.custo_novo * (1 + (rateio.disponivel ? rateio.fator : 0))).toFixed(4);
    const m = erp.margem[b.cod] || {};
    const e = {
      cod: b.cod, descricao: b.descricao, curvaA: curvaA ? curvaA.has(b.cod) : false, recebida: b.recebida, nao_pedido: !!b.nao_pedido,
      custo_atual: erp.custo[b.cod] ?? null, custo_novo: b.custo_novo, custo_imposto: ci,
      margem: m.varejo ?? null, preco_atual: erp.preco[b.cod]?.varejo ?? null,
      margem_atacado: reg.loja === 4 ? (m.atacado ?? null) : null,
      preco_atacado_atual: reg.loja === 4 ? (erp.preco[b.cod]?.atacado ?? null) : null
    };
    if (b.motivo_bloqueio) e.motivo_conferencia = b.motivo_bloqueio;
    return aplicarBloqueio(e, erp);
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
    const curvaA = curvaSet();
    reg.curva_disponivel = !!curvaA;
    for (const e of reg.entradas) {
      const m = erp.margem[e.cod] || {};
      e.curvaA = curvaA ? curvaA.has(e.cod) : false; e.custo_atual = erp.custo[e.cod] ?? null; e.margem = m.varejo ?? null; e.preco_atual = erp.preco[e.cod]?.varejo ?? null;
      e.margem_atacado = reg.loja === 4 ? (m.atacado ?? null) : null; e.preco_atacado_atual = reg.loja === 4 ? (erp.preco[e.cod]?.atacado ?? null) : null;
      aplicarBloqueio(e, erp);
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
function criarTeste(usuario) {
  const id = 'T' + Date.now().toString().slice(-6) + '-L4';
  const E = (cod, descricao, curvaA, ca, cn, m, pa, ma, paa) => ({ cod, descricao, curvaA, recebida: 12, nao_pedido: false, custo_atual: ca, custo_novo: cn, custo_imposto: +(cn * 1.04).toFixed(4), margem: m, preco_atual: pa, margem_atacado: ma, preco_atacado_atual: paa });
  const reg = { id, pedidoId: 0, loja: 4, lista: 0, lista_nome: 'TESTE FORMAÇÃO DE PREÇO', fornecedor: 'FORNECEDOR TESTE', teste: true, status: 'a_precificar', criadoEm: new Date().toISOString(), conciliadoEm: new Date().toISOString(), curva_disponivel: true,
    parametros: { ...padrao }, rateio: { frete: 20, ipi: 0, st: 28, desconto: 0, valorProduto: 1200, fator: 0.04, disponivel: true },
    entradas: [
      E('7891000100103', 'ARROZ TIPO 1 5KG (curva A, custo subiu)', true, 22.90, 24.50, 18, 27.99, 12, 26.49),
      E('7891000100110', 'FEIJÃO CARIOCA 1KG (curva A, custo caiu)', true, 7.80, 6.90, 25, 9.99, 15, 9.29),
      E('7891000100127', 'BISCOITO 400G (não é A, custo caiu)', false, 4.10, 3.60, 35, 5.69, 20, 5.19),
      E('7891000100134', 'DETERGENTE 500ML (sem mudança)', false, 1.90, 1.83, 40, 2.69, null, null),
      E('7891000100141', 'SABÃO EM PÓ 1KG (sem margem cadastrada)', false, 8.20, 8.90, null, 11.49, null, null),
      E('7891000100158', 'AZEITE 500ML (produto novo na loja)', false, null, 24.00, 30, null, null, null)
    ], itens: [], resumo: null, historico: [{ acao: 'criado', por: usuario || null, em: new Date().toISOString(), teste: true }] };
  calc.calcularRegistro(reg);
  return salvar(reg);
}
function removerTestes() { let n = 0; for (const r of listar()) if (r.teste) { try { fs.unlinkSync(arq(r.id)); n++; } catch (e) {} } return n; }

const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const pdfPath = id => { const s = String(id); if (!ID_OK.test(s)) throw new Error('id inválido'); return path.join(DIR, `${s}.pdf`); };
function caminhoPdf(id) { try { const f = pdfPath(id); return fs.existsSync(f) ? f : null; } catch (e) { return null; } }
function gerarPdf(r) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 28, info: { Title: `Formação de Preço ${r.id} - ${r.lista_nome}` } });
  const out = fs.createWriteStream(pdfPath(r.id)); doc.pipe(out);
  const brl = v => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dt = s => s ? new Date(s).toLocaleString('pt-BR') : '';
  const W = doc.page.width - 56, L = 28;
  doc.rect(L, 28, W, 64).fill('#101B33');
  try { doc.image(path.join(__dirname, '..', 'public', 'logo-supermercados.png'), 36, 31, { height: 26 }); } catch (e) {}
  doc.fillColor('#FFFFFF').fontSize(13).text(`Formação de Preço · Loja ${r.loja} ${LOJAS_NOMES[r.loja] || ''}`, 40, 60);
  doc.fontSize(8.5).fillColor('#C9D1E3').text(`Pedido #${r.pedidoId} · ${r.lista_nome} · ${r.fornecedor} · conciliado ${dt(r.conciliadoEm)} · política ${r.parametros.politica} · terminação ${r.parametros.arredondamento}`, 40, 76, { width: W - 24 });
  let y = 104;
  const l4 = r.loja === 4;
  const cols = l4 ? [[L, 62, 'Código'], [L + 62, 200, 'Descrição'], [L + 262, 60, 'Atual'], [L + 322, 60, 'Novo'], [L + 382, 60, 'Atac. atual'], [L + 442, 60, 'Atac. novo'], [L + 502, 37, 'Obs']]
                  : [[L, 70, 'Código'], [L + 70, 260, 'Descrição'], [L + 330, 70, 'Preço atual'], [L + 400, 70, 'Preço novo'], [L + 470, 69, 'Obs']];
  const cab = () => { doc.rect(L, y, W, 16).fill('#F5B800'); doc.fillColor('#101B33').fontSize(8); for (const [x, w, t] of cols) doc.text(t, x + 4, y + 4, { width: w - 8 }); y += 18; };
  const mudam = r.itens.filter(i => i.status === 'sobe' || i.status === 'desce' || (i.manual && i.preco_final !== i.preco_atual) || (i.piso && i.preco_final !== i.preco_atual));
  doc.fillColor('#0E1626').fontSize(10).text(`${mudam.length} produto(s) mudam de preço`, L, y); y += 16;
  cab();
  doc.fontSize(8.5);
  for (const i of mudam) {
    if (y > doc.page.height - 60) { doc.addPage(); y = 40; cab(); doc.fontSize(8.5); }
    const obs = ((i.status === 'desce' ? 'desce' : i.status === 'sobe' ? 'sobe' : '') + (i.manual ? ' manual' : '') + (i.piso ? ' piso' : '')).trim();
    const vals = l4 ? [i.cod, i.descricao, brl(i.preco_atual), brl(i.preco_final), brl(i.preco_atacado_atual), brl(i.atacado?.preco_final), obs]
                    : [i.cod, i.descricao, brl(i.preco_atual), brl(i.preco_final), obs];
    doc.fillColor('#0E1626'); cols.forEach(([x, w], k) => doc.text(String(vals[k] ?? ''), x + 4, y, { width: w - 8, lineBreak: false }));
    y += 14; doc.moveTo(L, y - 2).lineTo(L + W, y - 2).strokeColor('#E4E4E0').lineWidth(.5).stroke();
  }
  const bloq = r.itens.filter(i => i.status === 'bloqueado');
  if (bloq.length) {
    y += 10; if (y > doc.page.height - 80) { doc.addPage(); y = 40; }
    doc.fillColor('#C22F49').fontSize(10).text(`${bloq.length} produto(s) sem preço (bloqueados)`, L, y); y += 14; doc.fontSize(8.5);
    for (const i of bloq) { if (y > doc.page.height - 50) { doc.addPage(); y = 40; } doc.fillColor('#0E1626').text(`${i.cod}  ${i.descricao}  — ${i.motivo}`, L, y, { width: W, lineBreak: false }); y += 13; }
  }
  doc.end();
  return pdfPath(r.id);
}

module.exports = { init, initERP, setPadrao, getPadrao, criarDeConciliacao, criarTeste, recalcular, listar, obter, salvar, idDe, itensConciliados, rateioDe, editarItem, setParametros, fechar, reabrir, aplicar, verificar, verificarTodos, removerTestes, gerarPdf, caminhoPdf, LOJAS_NOMES };
