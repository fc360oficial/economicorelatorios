// Pedidos enviados ao fornecedor (Fase 3 do Radar de Pedidos).
//
// Fluxo definido pelo Tiago (10/09/2026):
//   1. compradora seleciona listas no Radar e clica "Enviar pro fornecedor"
//   2. sistema gera 1 pedido por lista (itens/quantidades do radar, por loja),
//      guarda o ÚLTIMO CUSTO do ERP de cada item e cria um link único (token)
//   3. status: aguardando  → vendedor ainda não abriu o link
//              digitacao   → vendedor abriu o link (primeira abertura)
//              finalizado  → vendedor clicou em Finalizar
//   4. no link o vendedor vê código, descrição, quantidade e preenche PREÇO e
//      OBSERVAÇÃO por item (salva sozinho); ao finalizar, trava
//   5. no pedido finalizado a compradora vê último custo × preço digitado com
//      seta (↑ verde maior, ↓ vermelha menor, = igual)
//
// Persistência: um JSON por pedido em data/pedidos-fornecedor/. NADA é escrito
// no ERP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cx = require('./conferencia-xml');

const DIR = path.join(__dirname, '..', 'data', 'pedidos-fornecedor');
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };

function init() { fs.mkdirSync(DIR, { recursive: true }); }
const arq = id => path.join(DIR, `${id}.json`);
function salvar(p) { fs.writeFileSync(arq(p.id), JSON.stringify(p)); return p; }
function obter(id) { try { return JSON.parse(fs.readFileSync(arq(id), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
function porToken(token) {
  if (!/^[a-f0-9]{32}$/.test(token || '')) return null;
  return listar().find(p => p.token === token) || null;
}
function proximoId() {
  const ids = fs.readdirSync(DIR).map(f => parseInt(f)).filter(n => !isNaN(n));
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

function totais(p) {
  let ultimo = 0, digitado = 0, comPreco = 0;
  for (const i of p.itens) {
    ultimo += i.qtd * (i.ultimo_custo || 0);
    if (i.preco != null) { digitado += i.qtd * i.preco; comPreco++; }
  }
  return { ultimo_custo: +ultimo.toFixed(2), digitado: +digitado.toFixed(2), itens: p.itens.length, com_preco: comPreco };
}

// cria 1 pedido a partir do detalhe do radar (itensLista) + cadastro da lista
function criar({ lista, cadastro, detalhe, teto, embMeses, usuario, modo }) {
  // origem_item: 'curva_a' = produto de curva A em risco que puxou/justificou o pedido; 'lista' = demais itens da lista
  const itens = detalhe.itens.filter(i => i.qtd > 0).map(i => ({
    cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: i.qtd, volumes: i.volumes,
    lojas_qtd: i.lojas_qtd || {}, ultimo_custo: i.custo, preco: null, obs: '',
    origem_item: i.curva_a ? 'curva_a' : 'lista', curva_a: !!i.curva_a, risco_a: !!i.risco_a, cobertura_dias: i.cobertura_dias ?? null
  }));
  const p = {
    id: proximoId(), token: crypto.randomBytes(16).toString('hex'),
    lista: lista.lista, lista_nome: lista.nome, fornecedor: lista.fornecedor, codFornec: lista.codFornec,
    vendedor: cadastro?.vendedor || null, comprador: cadastro?.comprador || null,
    prazo_pagamento: cadastro?.prazo_pagamento || null, pedido_minimo: lista.pedidoMinimo || null,
    status: 'aguardando', criadoEm: new Date().toISOString(), criadoPor: usuario || null,
    abertoEm: null, finalizadoEm: null, parametros: { teto, embMeses, fazer_em: detalhe.fazer_em, gatilho: detalhe.gatilho || 'lista', fazer_em_lista: detalhe.fazer_em_lista ?? detalhe.fazer_em, modo: modo || 'completa' },
    resumo_origem: itens.some(i => i.origem_item === 'curva_a') ? { curva_a: itens.filter(i => i.origem_item === 'curva_a').length, lista: itens.filter(i => i.origem_item === 'lista').length } : undefined,
    lojas: [...new Set(itens.flatMap(i => Object.keys(i.lojas_qtd).filter(l => i.lojas_qtd[l] > 0).map(Number)))].sort((a, b) => a - b),
    itens
  };
  p.totais = totais(p);
  return salvar(p);
}

// --- lado do vendedor (público, por token) ---
function abrir(token) {
  const p = porToken(token); if (!p) return null;
  if (p.status === 'aguardando') { p.status = 'digitacao'; p.abertoEm = new Date().toISOString(); salvar(p); }
  return p;
}
function salvarPrecos(token, itens) {
  const p = porToken(token); if (!p) return null;
  if (p.status === 'finalizado') return { erro: 'Pedido já finalizado' };
  if (p.status === 'cancelado') return { erro: 'Pedido cancelado' };
  const map = new Map((itens || []).map(i => [String(i.cod), i]));
  for (const it of p.itens) {
    const n = map.get(String(it.cod)); if (!n) continue;
    if (n.preco === '' || n.preco == null) it.preco = null;
    else { const v = parseFloat(String(n.preco).replace(',', '.')); if (isFinite(v) && v >= 0) it.preco = +v.toFixed(4); }
    if (typeof n.obs === 'string') it.obs = n.obs.slice(0, 200);
  }
  p.atualizadoEm = new Date().toISOString(); p.totais = totais(p);
  return salvar(p);
}
function finalizar(token, nomeQuemFinalizou) {
  const p = porToken(token); if (!p) return null;
  if (p.status === 'cancelado') return p;
  if (p.status === 'finalizado') return p;
  p.status = 'finalizado'; p.finalizadoEm = new Date().toISOString(); p.finalizadoPor = (nomeQuemFinalizou || '').slice(0, 80) || null;
  p.totais = totais(p);
  return salvar(p);
}
// --- lado da compradora ---
function aprovar(id, usuario) {
  const p = obter(id); if (!p) return null;
  if (p.status !== 'finalizado') return { erro: 'Só pedido finalizado pelo vendedor pode ser aprovado (status atual: ' + p.status + ')' };
  p.status = 'aprovado'; p.aprovadoEm = new Date().toISOString(); p.aprovadoPor = usuario || null;
  try { gerarPdf(p); p.pdf = true; } catch (e) { console.error('[PEDIDOS] pdf:', e.message); }
  return salvar(p);
}

// PDF do pedido aprovado (mesmo desenho da prévia "Gerar pedido": resumo + uma seção por loja)
const pdfPath = id => path.join(DIR, `${id}.pdf`);
function gerarPdf(p) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, info: { Title: `Pedido ${p.id} - ${p.lista_nome}` } });
  const out = fs.createWriteStream(pdfPath(p.id)); doc.pipe(out);
  const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n0 = v => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const dt = s => s ? new Date(s).toLocaleString('pt-BR') : '';
  const precoDe = i => (i.preco != null ? i.preco : i.ultimo_custo) || 0;
  const W = doc.page.width - 56;
  // cabeçalho
  doc.rect(28, 28, W, 72).fill('#101B33');
  // logo da rede à esquerda com a linha amarela ao lado; título branco e fornecedor começam embaixo, na margem esquerda
  try { doc.image(path.join(__dirname, '..', 'public', 'logo-supermercados.png'), 36, 31, { height: 30 }); } catch (e) {}
  doc.fillColor('#FFC933').font('Helvetica-Bold').fontSize(9).text('PEDIDO DE COMPRA APROVADO · ECONOMICO SUPERMERCADO - REDE CAHU', 70, 42);
  doc.fillColor('#FFFFFF').fontSize(15).text(`Pedido #${p.id} · ${p.lista_nome}`, 40, 64);
  doc.font('Helvetica').fontSize(8.5).fillColor('#AEB8CE').text(`Fornecedor: ${p.fornecedor || ''}${p.vendedor?.nome ? '  ·  Vendedor: ' + p.vendedor.nome + (p.vendedor.whats ? ' ' + p.vendedor.whats : '') : ''}${p.comprador?.nome ? '  ·  Comprador(a): ' + p.comprador.nome : ''}${p.prazo_pagamento ? '  ·  Prazo: ' + p.prazo_pagamento : ''}  ·  Aprovado em ${dt(p.aprovadoEm)}${p.aprovadoPor ? ' por ' + p.aprovadoPor : ''}`, 40, 84, { width: W - 24 });
  let y = 112;
  // resumo por loja
  const lojas = p.lojas.length ? p.lojas : [...new Set(p.itens.flatMap(i => Object.keys(i.lojas_qtd).map(Number)))].sort((a, b) => a - b);
  const porLoja = lojas.map(ln => { const rows = p.itens.filter(i => (i.lojas_qtd[ln] || 0) > 0); return { ln, rows, tot: rows.reduce((s, i) => s + i.lojas_qtd[ln] * precoDe(i), 0), vol: rows.reduce((s, i) => s + Math.ceil(i.lojas_qtd[ln] / (i.emb || 1)), 0) }; });
  const totalGeral = porLoja.reduce((s, l) => s + l.tot, 0);
  const cw = Math.min(150, (W - 8 * porLoja.length) / (porLoja.length + 1));
  let x = 28;
  for (const l of [...porLoja, { ln: 0, tot: totalGeral, vol: porLoja.reduce((s, l) => s + l.vol, 0), rows: { length: p.itens.length } }]) {
    const isTot = l.ln === 0;
    doc.roundedRect(x, y, cw, 40, 5).lineWidth(0.6).strokeColor('#DADAD6').fillAndStroke(isTot ? '#101B33' : '#FFFFFF', isTot ? '#101B33' : '#DADAD6');
    doc.fillColor(isTot ? '#AEB8CE' : '#4E5A72').font('Helvetica-Bold').fontSize(6.5).text(isTot ? 'TOTAL DO PEDIDO' : `LOJA ${l.ln} · ${LOJAS_NOMES[l.ln] || ''}`, x + 8, y + 6, { width: cw - 16 });
    doc.fillColor(isTot ? '#FFC933' : '#0E1626').fontSize(11).text(brl(l.tot), x + 8, y + 15, { width: cw - 16 });
    doc.fillColor(isTot ? '#AEB8CE' : '#98A0B3').font('Helvetica').fontSize(6.5).text(`${l.rows.length} itens · ${l.vol} vol`, x + 8, y + 29, { width: cw - 16 });
    x += cw + 8;
  }
  y += 52;
  const cols = [['Código', 80, 'left'], ['Produto', W - 80 - 45 - 45 - 60 - 70 - 80, 'left'], ['Emb', 45, 'right'], ['Vol', 45, 'right'], ['Qtd', 60, 'right'], ['Preço', 70, 'right'], ['Total', 80, 'right']];
  const linha = (vals, yy, bold, bg) => {
    if (bg) doc.rect(28, yy - 3, W, 14).fill(bg);
    let xx = 32; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#0E1626');
    cols.forEach(([, w, al], i) => { doc.text(String(vals[i] ?? ''), xx, yy, { width: w - 6, align: al, lineBreak: false }); xx += w; });
  };
  for (const l of porLoja) {
    if (y > doc.page.height - 80) { doc.addPage(); y = 36; }
    doc.rect(28, y, W, 18).fill('#EBEBE9');
    doc.fillColor('#0E1626').font('Helvetica-Bold').fontSize(9.5).text(`Loja ${l.ln} · ${LOJAS_NOMES[l.ln] || ''}`, 36, y + 5);
    doc.font('Helvetica').fontSize(8).fillColor('#4E5A72').text(`${l.rows.length} itens · ${l.vol} volumes · ${brl(l.tot)}`, 36, y + 5, { width: W - 16, align: 'right' });
    y += 24;
    linha(cols.map(c => c[0].toUpperCase()), y, true); y += 14;
    doc.moveTo(28, y - 2).lineTo(28 + W, y - 2).lineWidth(0.5).strokeColor('#DADAD6').stroke();
    for (const [k, i] of l.rows.sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR')).entries()) {
      if (y > doc.page.height - 40) { doc.addPage(); y = 36; linha(cols.map(c => c[0].toUpperCase()), y, true); y += 14; }
      const q = i.lojas_qtd[l.ln];
      linha([i.cod, i.descricao, i.emb, Math.ceil(q / (i.emb || 1)), `${n0(q)} ${i.unid || ''}`, Number(precoDe(i)).toLocaleString('pt-BR', { minimumFractionDigits: 2 }), brl(q * precoDe(i))], y, false, k % 2 ? '#FAFAF8' : null);
      y += 14;
    }
    y += 10;
  }
  doc.fontSize(7).fillColor('#98A0B3').text(`Gerado pelo Econômico Relatórios em ${new Date().toLocaleString('pt-BR')} · preços = digitados pelo vendedor (sem preço: último custo do ERP)`, 28, doc.page.height - 30, { width: W });
  doc.end();
  return pdfPath(p.id);
}
function caminhoPdf(id) { const f = pdfPath(id); return fs.existsSync(f) ? f : null; }
function cancelar(id, usuario, motivo) {
  const p = obter(id); if (!p) return null;
  if (p.status === 'aprovado') return { erro: 'Pedido aprovado não pode ser cancelado por aqui' };
  p.status = 'cancelado'; p.canceladoEm = new Date().toISOString(); p.canceladoPor = usuario || null; p.motivoCancelamento = (motivo || '').slice(0, 200) || null;
  return salvar(p);
}
// compradora ajusta quantidades por loja dentro do pedido (antes de aprovar)
function ajustarQuantidades(id, ajustes, usuario) {
  const p = obter(id); if (!p) return null;
  if (['aprovado', 'recebido', 'recebido_parcial', 'cancelado'].includes(p.status)) return { erro: 'Pedido ' + p.status + ' não pode ter quantidade alterada' };
  for (const it of p.itens) {
    const a = ajustes?.[it.cod]; if (!a) continue;
    for (const [ln, v] of Object.entries(a)) { const n = Math.max(0, Math.round(parseFloat(v) || 0)); it.lojas_qtd[ln] = n; }
    it.qtd = Object.values(it.lojas_qtd).reduce((s, v) => s + (v || 0), 0);
    it.volumes = it.qtd ? Math.ceil(it.qtd / (it.emb || 1)) : 0; it.editado = true;
  }
  p.lojas = [...new Set(p.itens.flatMap(i => Object.keys(i.lojas_qtd).filter(l => i.lojas_qtd[l] > 0).map(Number)))].sort((a, b) => a - b);
  p.totais = totais(p); p.ajustadoEm = new Date().toISOString(); p.ajustadoPor = usuario || null;
  return salvar(p);
}
// sugestão criada pelo sistema (ruptura de entrega) → compradora manda pro vendedor
function enviar(id, usuario) {
  const p = obter(id); if (!p) return null;
  if (p.status !== 'sugestao') return { erro: 'Só sugestão pendente pode ser enviada (status atual: ' + p.status + ')' };
  p.status = 'aguardando'; p.enviadoEm = new Date().toISOString(); p.enviadoPor = usuario || null;
  return salvar(p);
}

// ─────────────────────────────────────────────────────────────
// RECEBIMENTO × RUPTURA DE ENTREGA
// Pra cada pedido APROVADO, procura no ERP a nota do fornecedor em cada loja
// (compras: mesmo CodFornec, mesma loja, recebida depois da aprovação) e
// compara item a item o que entrou (compraprodutos.QtdEntradaEstoque) com o
// que foi pedido. Falta total ou parcial vira uma SUGESTÃO nova, só com as
// faltas, marcada como ruptura de entrega do pedido de origem — fica em
// status "sugestao" até a compradora mandar pro vendedor.
// ─────────────────────────────────────────────────────────────
let qERP = null, radar = null;
function initERP(q, radarMod) { qERP = q; radar = radarMod || null; cx.init(q); }
const JANELA_RECEBIMENTO_DIAS = 30;

// Desde 11/09/2026 a conferência usa as NF-e do XML (central.axml/axmlprodutos/axmlboletos),
// loja a loja — ver lib/conferencia-xml.js. Mantém o nome por causa da rota e do agendamento.
async function verificarRecebimentos() {
  return cx.conferirTodos({ listar, salvar, criarOuMesclarRuptura });
}

// ─────────────────────────────────────────────────────────────
// PEDIDOS DE TESTE da conferência XML ("FORNECEDOR TESTE", p.teste=true):
// as notas vêm de data/xml-teste/<id>.json, não do ERP. 4 casos:
//   1 conciliado 100%  2 falta parcial (vira sugestão de ruptura)
//   3 preço diferente do digitado  4 boleto ≠ NF-e (e uma loja ainda sem nota)
// ─────────────────────────────────────────────────────────────
function criarTestesXml(usuario) {
  const ITENS = [
    { cod: 'TESTE0001', descricao: 'TESTE ARROZ TIPO 1 5KG', unid: 'UN', emb: 6, custo: 22.90, preco: 23.50 },
    { cod: 'TESTE0002', descricao: 'TESTE FEIJAO CARIOCA 1KG', unid: 'UN', emb: 10, custo: 7.80, preco: 7.90 },
    { cod: 'TESTE0003', descricao: 'TESTE OLEO SOJA 900ML', unid: 'UN', emb: 20, custo: 6.10, preco: 6.25 }
  ];
  const QTD = { 1: [60, 100, 200], 3: [30, 50, 100] };   // por loja, na ordem dos itens
  const base = (caso, titulo) => {
    const itens = ITENS.map((it, k) => ({ cod: it.cod, descricao: it.descricao, unid: it.unid, emb: it.emb, qtd: QTD[1][k] + QTD[3][k], volumes: Math.ceil((QTD[1][k] + QTD[3][k]) / it.emb), lojas_qtd: { 1: QTD[1][k], 3: QTD[3][k] }, ultimo_custo: it.custo, preco: it.preco, obs: '', origem_item: 'lista' }));
    const agora = new Date().toISOString();
    const p = { id: proximoId(), token: crypto.randomBytes(16).toString('hex'), teste: true, caso,
      lista: 0, lista_nome: 'TESTE XML ' + caso + ' · ' + titulo, fornecedor: 'FORNECEDOR TESTE', codFornec: 0,
      vendedor: { nome: 'Vendedor Teste', whats: '' }, comprador: { nome: usuario || 'Teste' }, prazo_pagamento: 'BOLETO 28DD', pedido_minimo: null,
      status: 'aprovado', criadoEm: agora, criadoPor: usuario || 'teste', abertoEm: agora, finalizadoEm: agora, finalizadoPor: 'Vendedor Teste', aprovadoEm: agora, aprovadoPor: usuario || 'teste',
      parametros: { teto: 28, embMeses: 24, fazer_em: 0, gatilho: 'lista', modo: 'completa' }, lojas: [1, 3], itens };
    p.totais = totais(p); return salvar(p);
  };
  const nota = (ln, nNota, itensXml, opts = {}) => {
    const itens = itensXml.map((x, k) => ({ item: k + 1, cod: x.cod, descricao: ITENS.find(i => i.cod === x.cod)?.descricao || x.cod, und: 'CX', qtdCom: x.unidades / (ITENS.find(i => i.cod === x.cod)?.emb || 1), unidades: x.unidades, precoUnit: x.preco, total: +(x.unidades * x.preco).toFixed(2), desconto: 0 }));
    const valor = +itens.reduce((a, i) => a + i.total, 0).toFixed(2);
    const hoje = new Date().toISOString().slice(0, 10);
    const venc = d => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
    const boletos = opts.boletos ? opts.boletos(valor, venc) : [{ dup: 1, vencimento: venc(28), valor }];
    return { chave: 'TESTE' + String(nNota).padStart(39, '0'), nNota, serie: '1', data: hoje, cnpjEmit: '00000000000000', emitente: 'FORNECEDOR TESTE LTDA', valorNFE: valor, valorProduto: valor, desconto: 0, frete: 0, ipi: 0, st: 0, importado: true, status: 0, itens, boletos };
  };
  const q = (ln, mult = {}, precoMult = {}) => ITENS.map((it, k) => ({ cod: it.cod, unidades: Math.round(QTD[ln][k] * (mult[it.cod] ?? 1)), preco: +(it.preco * (precoMult[it.cod] ?? 1)).toFixed(2) })).filter(x => x.unidades > 0);
  const criados = [];
  // 1) conciliado: as duas lojas com nota igual ao pedido, boleto = NF-e
  let p = base(1, 'conciliado 100%'); fs.writeFileSync(path.join(cx.TESTE_DIR, p.id + '.json'), JSON.stringify({ 1: [nota(1, 9001, q(1))], 3: [nota(3, 9002, q(3))] })); criados.push(p.id);
  // 2) falta: L1 sem o óleo e com metade do feijão; L3 completa → consistência + sugestão de ruptura
  p = base(2, 'falta parcial (ruptura)'); fs.writeFileSync(path.join(cx.TESTE_DIR, p.id + '.json'), JSON.stringify({ 1: [nota(1, 9003, q(1, { TESTE0003: 0, TESTE0002: 0.5 }))], 3: [nota(3, 9004, q(3))] })); criados.push(p.id);
  // 3) preço: L1 arroz 8% mais caro que o digitado; L3 ok
  p = base(3, 'preço diferente do digitado'); fs.writeFileSync(path.join(cx.TESTE_DIR, p.id + '.json'), JSON.stringify({ 1: [nota(1, 9005, q(1, {}, { TESTE0001: 1.08 }))], 3: [nota(3, 9006, q(3))] })); criados.push(p.id);
  // 4) boleto: L1 com 2 duplicatas que somam mais que a NF-e; L3 ainda sem nota (aguardando)
  p = base(4, 'boleto diferente da NF-e + loja sem nota'); fs.writeFileSync(path.join(cx.TESTE_DIR, p.id + '.json'), JSON.stringify({ 1: [nota(1, 9007, q(1), { boletos: (v, venc) => [{ dup: 1, vencimento: venc(28), valor: +(v / 2).toFixed(2) }, { dup: 2, vencimento: venc(56), valor: +(v / 2 + 150).toFixed(2) }] })], 3: [] })); criados.push(p.id);
  return criados;
}
function removerTestesXml() {
  let n = 0;
  for (const p of listar()) if (p.teste || p.fornecedor === 'FORNECEDOR TESTE' || (p.origem?.pedidoId && (obter(p.origem.pedidoId)?.teste))) { try { fs.unlinkSync(arq(p.id)); n++; } catch (e) {} try { fs.unlinkSync(path.join(cx.TESTE_DIR, p.id + '.json')); } catch (e) {} }
  return n;
}

function criarOuMesclarRuptura(origem, ln, faltas) {
  // mescla na sugestão de ruptura já existente desse pedido enquanto ela não foi enviada
  let r = listar().find(x => x.origem?.tipo === 'ruptura' && x.origem.pedidoId === origem.id && x.status === 'sugestao');
  if (!r) {
    r = {
      id: proximoId(), token: crypto.randomBytes(16).toString('hex'),
      lista: origem.lista, lista_nome: origem.lista_nome, fornecedor: origem.fornecedor, codFornec: origem.codFornec,
      vendedor: origem.vendedor, comprador: origem.comprador, prazo_pagamento: origem.prazo_pagamento, pedido_minimo: origem.pedido_minimo,
      status: 'sugestao', criadoEm: new Date().toISOString(), criadoPor: 'sistema (ruptura de entrega)',
      abertoEm: null, finalizadoEm: null, parametros: origem.parametros || {},
      origem: { tipo: 'ruptura', pedidoId: origem.id, lojas: [], notas: [] },
      lojas: [], itens: [], alerta_novo: true
    };
  }
  if (!r.origem.lojas.includes(ln)) r.origem.lojas.push(ln);
  for (const n of origem.recebimento[ln].notas) r.origem.notas.push({ loja: ln, ...n });
  if (!r.lojas.includes(ln)) { r.lojas.push(ln); r.lojas.sort((a, b) => a - b); }
  for (const f of faltas) {
    let it = r.itens.find(i => i.cod === f.it.cod);
    if (!it) { it = { cod: f.it.cod, descricao: f.it.descricao, unid: f.it.unid, emb: f.it.emb, qtd: 0, volumes: 0, lojas_qtd: {}, ultimo_custo: f.it.preco != null ? f.it.preco : f.it.ultimo_custo, preco: null, obs: '', ruptura: {}, origem_item: 'ruptura' }; r.itens.push(it); }
    it.origem_item = 'ruptura';
    const q = Math.ceil(f.falta / (it.emb || 1)) * (it.emb || 1);
    it.lojas_qtd[ln] = q; it.ruptura[ln] = { pedida: f.pedida, recebida: f.rec, tipo: f.rec <= 0 ? 'total' : 'parcial' };
    it.qtd = Object.values(it.lojas_qtd).reduce((s, v) => s + v, 0); it.volumes = Math.ceil(it.qtd / (it.emb || 1));
  }
  // aproveita a ruptura: traz junto os produtos da mesma lista que o radar já vê ABAIXO DO PONTO DE PEDIDO
  // (urgentes), pra sair um pedido só pro vendedor. Itens folgados não entram. Cada item guarda a origem.
  try {
    const det = radar && radar.itensLista ? radar.itensLista(origem.lista) : null;
    if (det) for (const i of det.itens) {
      if (!(i.qtd > 0) || !i.abaixo_ponto) continue;
      let it = r.itens.find(x => x.cod === i.cod);
      if (it) { for (const [l2, q2] of Object.entries(i.lojas_qtd || {})) if (q2 > 0 && !it.lojas_qtd[l2]) { it.lojas_qtd[l2] = q2; it.radar = it.radar || {}; it.radar[l2] = { cobertura_dias: i.lojas_det?.[l2]?.cobertura_dias ?? null }; } }
      else { it = { cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: 0, volumes: 0, lojas_qtd: { ...i.lojas_qtd }, ultimo_custo: i.custo, preco: null, obs: '', origem_item: 'radar', radar: Object.fromEntries(Object.keys(i.lojas_qtd || {}).filter(l2 => i.lojas_qtd[l2] > 0).map(l2 => [l2, { cobertura_dias: i.lojas_det?.[l2]?.cobertura_dias ?? null }])) }; r.itens.push(it); }
      it.qtd = Object.values(it.lojas_qtd).reduce((s, v) => s + (v || 0), 0); it.volumes = Math.ceil(it.qtd / (it.emb || 1));
      for (const l2 of Object.keys(it.lojas_qtd)) if (it.lojas_qtd[l2] > 0 && !r.lojas.includes(+l2)) r.lojas.push(+l2);
    }
    r.lojas.sort((a, b) => a - b);
  } catch (e) { console.error('[PEDIDOS] radar na ruptura:', e.message); }
  r.totais = totais(r); r.alerta_novo = true;
  r.resumo_origem = { ruptura: r.itens.filter(i => i.origem_item === 'ruptura').length, radar: r.itens.filter(i => i.origem_item === 'radar').length };
  salvar(r);
  return r;
}
function verAlertas(ids, usuario) {
  for (const id of ids || []) { const p = obter(id); if (p && p.alerta_novo) { p.alerta_novo = false; p.alertaVistoPor = usuario || null; salvar(p); } }
}

// versão pro vendedor: sem custo do ERP (ele não deve ver o que a loja paga hoje)
function visaoVendedor(p) {
  return {
    id: p.id, status: p.status, lista_nome: p.lista_nome, fornecedor: p.fornecedor, criadoEm: p.criadoEm, finalizadoEm: p.finalizadoEm,
    vendedor: p.vendedor ? { nome: p.vendedor.nome || null } : null,
    comprador: p.comprador, prazo_pagamento: p.prazo_pagamento, lojas: p.lojas, lojas_nomes: LOJAS_NOMES,
    itens: p.itens.map(i => ({ cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: i.qtd, volumes: i.volumes, lojas_qtd: i.lojas_qtd, preco: i.preco, obs: i.obs }))
  };
}

module.exports = { init, initERP, criar, listar, obter, porToken, abrir, salvarPrecos, finalizar, aprovar, cancelar, enviar, ajustarQuantidades, verificarRecebimentos, criarTestesXml, removerTestesXml, verAlertas, visaoVendedor, gerarPdf, caminhoPdf, LOJAS_NOMES };
