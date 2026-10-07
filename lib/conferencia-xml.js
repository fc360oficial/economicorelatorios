// Conferência XML dos pedidos ao fornecedor (11/09/2026, pedido do Tiago).
//
// Depois que o(a) comprador(a) APROVA um pedido, ele fica "aguardando conferência XML".
// O sistema procura, LOJA A LOJA, as NF-e que o fornecedor emitiu pra cada loja
// (central.axml = cabeçalho, central.axmlprodutos = itens, central.axmlboletos =
// duplicatas/boletos) e compara com o que foi pedido:
//   - quantidade por item (unidades) → conciliado / parcial / falta / veio a mais / não pedido
//   - preço unitário digitado pelo vendedor × preço unitário do XML
//   - financeiro: valor da NF-e × esperado (recebido × preço digitado; preço da nota quando veio menor) e boletos × NF-e
// Cada loja fica: aguardando | conciliado | consistencia. O pedido só fecha quando
// todas as lojas têm nota. Faltas viram sugestão de ruptura (criarOuMesclarRuptura).
//
// Ligações no ERP (descobertas em 11/09/2026):
//   axml.CodFornec vem sempre "0" → fornecedor é achado pelo CNPJ (central.fornecedor.CNPJ),
//   comparando a RAIZ (8 dígitos) porque a indústria fatura por filiais diferentes.
//   axmlprodutos liga com axml por nNota + CNPJemit (o nReg é outro).
//   axmlboletos liga por chave da NF-e. Loja = CNPJdest.
//   Quantidade em unidades = oqTrib (unidade tributável); preço unitário = ovUnTrib.
//
// SOMENTE LEITURA no ERP. Pedidos de TESTE (p.teste=true) leem as notas de
// data/xml-teste/<id>.json em vez do ERP.
const fs = require('fs');
const path = require('path');
const { corteAxml } = require('./axml-corte');

const LOJA_CNPJ = { 1: '21425302000181', 2: '30148015000162', 3: '39762002000153', 4: '43358448000194', 5: '51632927000185', 6: '59890722000101' };
const TESTE_DIR = path.join(__dirname, '..', 'data', 'xml-teste');
const JANELA_DIAS = 30;
const TOL_PRECO = 0.005;   // 0,5% de tolerância no preço unitário
const TOL_VALOR = 0.01;    // R$ 0,01 nos totais

// unidades que já são "unidade" (não precisam converter por embalagem)
const UND_UNITARIA = new Set(['UN', 'UND', 'UNID', 'PC', 'PÇ', 'PCS', 'KG', 'G', 'L', 'LT', 'ML', 'M', 'MT', 'BD', 'BDJ', 'GF', 'LATA', 'SC', 'SACHE', 'PT', 'POTE', 'FR', 'FRASCO', 'TB', 'VD', 'BS', 'BISNAGA']);
let qERP = null;
const cnpjCache = {};
function init(q, opts) { qERP = q; if (opts?.deparaPath) deparaPath = opts.deparaPath; fs.mkdirSync(TESTE_DIR, { recursive: true }); }

const num = v => { let s = String(v ?? '0').trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };
const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function cnpjRaizFornecedor(codFornec) {
  if (cnpjCache[codFornec] !== undefined) return cnpjCache[codFornec];
  let raiz = null;
  try {
    const r = await qERP(`SELECT CNPJ FROM central.fornecedor WHERE CodFornec=? LIMIT 1`, [codFornec]);
    const c = String(r[0]?.CNPJ || '').replace(/\D/g, '');
    raiz = c.length >= 8 ? c.slice(0, 8) : null;
  } catch (e) { console.error('[XML] cnpj fornecedor:', e.message); }
  cnpjCache[codFornec] = raiz;
  return raiz;
}

// notas do fornecedor pra uma loja, a partir de uma data (cabeçalho + itens + boletos)
async function buscarNotas(raiz, ln, desde, ate) {
  const cnpjLoja = LOJA_CNPJ[ln]; if (!cnpjLoja || !raiz) return [];
  // corte por nReg: evita varrer a axml inteira e estourar os 20 s (ver lib/axml-corte.js)
  const corteX = await corteAxml(qERP, desde);
  const cab = await qERP(`SELECT nReg, nNota, nSerie, DATE_FORMAT(Data,'%Y-%m-%d') data, CNPJemit, NomeEmit, ValorNFE, ValorProduto, ValorDesconto, ValorFrete, ValorIPI, ValorICMSsub, Chave, Importado, Status
                          FROM central.axml WHERE nReg>=? AND CNPJdest=? AND LEFT(CNPJemit,8)=? AND nMod='55' AND Data BETWEEN ? AND ? ORDER BY Data, nReg`, [corteX, cnpjLoja, raiz, desde, ate]);
  const notas = [];
  for (const n of cab) {
    const prods = await qERP(`SELECT nItem, CodigoBarras, ocEanTrib, Descricao, Und, Qtd, ValorUnit, ValorTotal, ValorDesconto, oqTrib, ovUnTrib FROM central.axmlprodutos WHERE nNota=? AND CNPJemit=? ORDER BY nItem`, [n.nNota, n.CNPJemit]).catch(() => []);
    const boletos = await qERP(`SELECT ndup, DATE_FORMAT(dataVencto,'%Y-%m-%d') vencimento, valor FROM central.axmlboletos WHERE chave=? ORDER BY ndup`, [n.Chave]).catch(() => []);
    notas.push({
      chave: n.Chave, nNota: n.nNota, serie: n.nSerie, data: n.data, cnpjEmit: n.CNPJemit, emitente: n.NomeEmit,
      valorNFE: num(n.ValorNFE), valorProduto: num(n.ValorProduto), desconto: num(n.ValorDesconto), frete: num(n.ValorFrete), ipi: num(n.ValorIPI), st: num(n.ValorICMSsub),
      importado: +n.Importado === 1, status: n.Status,
      itens: prods.map(p => {
        // unidade COMERCIAL (como o fornecedor vende: CX, FD, PC…) × unidade TRIBUTÁVEL (unidade real, exigida pela Receita).
        // Usa a tributável quando ela é diferente da comercial; senão fica marcado pra converter pela embalagem do pedido.
        const qtdCom = num(p.Qtd), total = num(p.ValorTotal);
        const und = String(p.Und || '').trim().toUpperCase(), undTrib = String(p.ouTrib || '').trim().toUpperCase();
        const qTrib = num(p.oqTrib), vTrib = num(p.ovUnTrib);
        const tribDiferente = qTrib > 0 && Math.abs(qTrib - qtdCom) > 0.001;
        const unidades = tribDiferente ? qTrib : qtdCom;
        const precoUnit = tribDiferente && vTrib > 0 ? vTrib : (unidades > 0 ? total / unidades : 0);
        const ean = String(p.ocEanTrib || '').trim(); const cod = String(p.CodigoBarras || '').trim();
        return { item: p.nItem, cod: cod && cod !== '0' ? cod : ean, descricao: (p.Descricao || '').trim(), und, undTrib, qtdCom, valorUnitCom: num(p.ValorUnit),
                 unidades, precoUnit: +precoUnit.toFixed(4), total, desconto: num(p.ValorDesconto), conversao: tribDiferente ? 'trib' : (UND_UNITARIA.has(und) ? 'unitaria' : 'pendente') };
      }),
      boletos: boletos.map(b => ({ dup: b.ndup, vencimento: b.vencimento, valor: num(b.valor) }))
    });
  }
  return notas;
}

// pedidos de teste: notas vêm de um JSON local no formato acima ({ "<loja>": [notas] })
function notasTeste(pedidoId, ln) {
  try { const j = JSON.parse(fs.readFileSync(path.join(TESTE_DIR, `${pedidoId}.json`), 'utf8')); return j[ln] || j[String(ln)] || []; } catch (e) { return []; }
}

// Código do XML × código do pedido (29/09/2026): o fornecedor manda DUN-14 ("17891080150453") ou EAN com zero à
// esquerda ("07891000416266"). Tudo vira EAN sem zeros pra comparar; devolve o código DO PEDIDO quando é o mesmo produto.
// 02/10/2026 (caso Alpes/Urca, Loja 4): o DUN-14 de verdade tem dígito verificador PRÓPRIO — a caixa "17896274823830"
// é o produto "7896274823833" — então tirar só o 1º dígito não basta; compara também a BASE (código sem o verificador).
const normCod = c => String(c || '').trim().replace(/^0+/, '');
function mapaCodPedido(p, ln) {
  const m = {}, base = {};
  for (const i of p.itens) if ((i.lojas_qtd?.[ln] || 0) > 0) {
    const n = normCod(i.cod);
    m[n] = i.cod;
    if (n.length >= 8) base[n.slice(0, -1)] = i.cod;
  }
  return codXml => {
    const s = String(codXml || '').trim();
    return m[normCod(s)] || (s.length === 14 ? m[normCod(s.slice(1))] || base[normCod(s.slice(1, -1))] : undefined) || null;
  };
}

// 07/10/2026 (caso Knorr, Loja 5): a cartela "67891150016868" (CALDO KNORR CARNE CART 114G 1X1) é OUTRO GTIN do mesmo
// produto "7891150012363" (KNORR CALDO 114G CARNE). Não deriva do EAN — nenhuma regra de dígito resolve. Dois caminhos:
//   1) DE-PARA gravado (data/xml-depara.json): código da nota → código do pedido, confirmado pelo(a) comprador(a) na tela.
//      Vale pra todos os pedidos dali em diante. { cod: null, bloqueado: true } = "nunca case esse código pelo nome".
//   2) NOME: item da nota sem código no pedido × item do pedido que não veio. Casa só quando TODAS as palavras do pedido
//      estão na descrição da nota (prefixo vale: "TRAD" ~ "TRADICIONAL"), a gramatura (114G, 2L, 800G) é a mesma e há
//      UM candidato de cada lado. Fica marcado "casado pelo nome" e vira consistência até o(a) comprador(a) confirmar.
let deparaPath = path.join(__dirname, '..', 'data', 'xml-depara.json');
function lerDepara() { try { return JSON.parse(fs.readFileSync(deparaPath, 'utf8')); } catch (e) { return {}; } }
// cod = código do pedido; cod vazio = bloquear (não é o mesmo produto, não casar pelo nome)
function vincularCod(codXml, cod, meta) {
  const d = lerDepara(); const k = normCod(codXml); if (!k) return d;
  d[k] = { cod: cod ? String(cod).trim() : null, bloqueado: !cod, ...(meta || {}), em: new Date().toISOString() };
  fs.mkdirSync(path.dirname(deparaPath), { recursive: true });
  fs.writeFileSync(deparaPath, JSON.stringify(d, null, 1));
  return d;
}
const normTxt = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
const RE_GRAM = /\b(\d+(?:[.,]\d+)?)\s*(KG|GR?|ML|LT?S?|LITROS?)\b/g;
// gramaturas normalizadas ("114 G", "2 L") e palavras (≥3 letras, sem as gramaturas)
function descTokens(desc) {
  const t = normTxt(desc); const gram = new Set(); let m;
  while ((m = RE_GRAM.exec(t))) { const u = m[2][0] === 'K' ? 'KG' : m[2][0] === 'G' ? 'G' : m[2][0] === 'M' ? 'ML' : 'L'; gram.add(parseFloat(m[1].replace(',', '.')) + ' ' + u); }
  const pal = new Set(t.replace(RE_GRAM, ' ').split(' ').filter(w => w.length >= 3));
  return { gram, pal };
}
function nomeCasa(descPedido, descXml) {
  const a = descTokens(descPedido), b = descTokens(descXml);
  if (a.pal.size < 2) return false;
  if (a.gram.size && b.gram.size && ![...a.gram].some(g => b.gram.has(g))) return false;
  const bp = [...b.pal];
  return [...a.pal].every(w => bp.some(u => u === w || u.startsWith(w) || w.startsWith(u)));
}
// eq(codXml) → código do pedido, somando código + de-para + nome. Devolve também o motivo de cada vínculo extra.
function mapaVinculos(p, ln, notas) {
  const eqCod = mapaCodPedido(p, ln), depara = lerDepara();
  const porCod = Object.fromEntries(p.itens.filter(i => (i.lojas_qtd?.[ln] || 0) > 0).map(i => [i.cod, i]));
  const vinc = {};   // codXml (como veio) → { cod, tipo: 'depara' | 'nome' }
  const xmlItens = {}; for (const n of notas) for (const it of n.itens) if (!xmlItens[it.cod]) xmlItens[it.cod] = { descricao: it.descricao, unidades: 0 }, xmlItens[it.cod].unidades += it.unidades; else xmlItens[it.cod].unidades += it.unidades;
  const casados = new Set();
  for (const [cx, x] of Object.entries(xmlItens)) {
    if (eqCod(cx)) { casados.add(eqCod(cx)); continue; }
    const d = depara[normCod(cx)];
    if (d && d.cod && porCod[d.cod]) { vinc[cx] = { cod: d.cod, tipo: 'depara' }; casados.add(d.cod); }
  }
  // nome: só entre o que sobrou dos dois lados
  const sobraPed = Object.values(porCod).filter(i => !casados.has(i.cod));
  const sobraXml = Object.entries(xmlItens).filter(([cx]) => !eqCod(cx) && !vinc[cx] && !depara[normCod(cx)]?.bloqueado);
  const candPed = {}, candXml = {};
  for (const [cx, x] of sobraXml) for (const i of sobraPed) if (nomeCasa(i.descricao, x.descricao)) { (candXml[cx] = candXml[cx] || []).push(i); (candPed[i.cod] = candPed[i.cod] || []).push(cx); }
  for (const [cx, lista] of Object.entries(candXml)) {
    let c = lista;
    if (c.length > 1) c = c.filter(i => Math.abs((i.lojas_qtd?.[ln] || 0) - xmlItens[cx].unidades) < 0.001);   // desempata pela quantidade
    if (c.length !== 1) continue;
    const i = c[0]; if ((candPed[i.cod] || []).filter(o => o !== cx && (candXml[o] || []).length === 1).length) continue;   // item do pedido disputado por outro item da nota
    vinc[cx] = { cod: i.cod, tipo: 'nome' };
  }
  return { eq: codXml => eqCod(codXml) || vinc[codXml]?.cod || null, vinc };
}
// quantos itens da(s) nota(s) estão no pedido daquela loja → { batem, total, pct }
function afinidade(p, ln, notas) {
  const { eq } = mapaVinculos(p, ln, notas), cods = new Set();
  for (const n of notas) for (const it of n.itens) cods.add(it.cod);
  let batem = 0; for (const c of cods) if (eq(c)) batem++;
  return { batem, total: cods.size, pct: cods.size ? Math.round(batem / cods.size * 100) : 0 };
}

// compara UMA loja de um pedido com as notas achadas
function conferirLoja(p, ln, notas) {
  const rec = {}; // cod → { unidades, total, precos: [], descricao, xml: [como veio na nota] }
  const itemPedido = Object.fromEntries(p.itens.map(i => [i.cod, i]));
  const { eq, vinc } = mapaVinculos(p, ln, notas);
  for (const n of notas) for (const it0 of n.itens) {
    const it = eq(it0.cod) && eq(it0.cod) !== it0.cod ? { ...it0, cod: eq(it0.cod), cod_xml: it0.cod } : it0;
    let unidades = it.unidades, conv = it.conversao || 'trib';
    if (conv === 'pendente') {
      // Unidade da nota que não é claramente unitária (CX, FD, PAC, PCT…) e sem tributável diferente.
      // 29/09/2026 (caso Betânia/Camponesa: "PAC" era o sachê, não a caixa de 50): antes de multiplicar pela
      // embalagem, olha a EVIDÊNCIA do próprio pedido — preço unitário da nota × preço digitado e qtd da nota × qtd pedida.
      const ip = itemPedido[it.cod], e = ip?.emb || 1;
      const precoPed = ip && ip.preco != null ? ip.preco : (ip?.ultimo_custo || 0);
      const pedida = ip?.lojas_qtd?.[ln] || 0;
      const perto = (a, b) => a > 0 && b > 0 && Math.abs(a / b - 1) <= 0.05;
      if (precoPed > 0 && it.valorUnitCom > 0 && perto(it.valorUnitCom, precoPed)) { unidades = it.qtdCom; conv = 'unitaria'; }          // preço da nota = preço unitário digitado → já é unidade
      else if (e > 1 && precoPed > 0 && it.valorUnitCom > 0 && perto(it.valorUnitCom, precoPed * e)) { unidades = it.qtdCom * e; conv = 'emb'; } // preço da nota = preço da caixa
      else if (pedida > 0 && Math.abs(it.qtdCom - pedida) < 0.001) { unidades = it.qtdCom; conv = 'unitaria'; }                             // qtd da nota = qtd pedida → unidade
      else if (e > 1) { unidades = it.qtdCom * e; conv = 'emb'; }        // CX/FD sem tributável: converte pela embalagem do pedido
      else conv = 'conferir';                                             // não dá pra saber: fica marcado pra conferir
    }
    const r = rec[it.cod] || (rec[it.cod] = { unidades: 0, total: 0, precos: [], descricao: it.descricao, xml: [] });
    if (vinc[it0.cod]) r.vinculo = { tipo: vinc[it0.cod].tipo, cod_xml: it0.cod, descricao_xml: it0.descricao };
    r.unidades += unidades; r.total += it.total; r.precos.push(it.total / (unidades || 1));
    r.xml.push({ qtdCom: it.qtdCom, und: it.und, valorUnitCom: it.valorUnitCom, unidades, conversao: conv, fator: it.qtdCom > 0 ? +(unidades / it.qtdCom).toFixed(3) : null });
  }
  const itens = [], faltas = [];
  let esperado = 0, divPreco = 0;
  for (const it of p.itens) {
    const pedida = it.lojas_qtd?.[ln] || 0; if (pedida <= 0) continue;
    const r = rec[it.cod]; const recebida = r ? r.unidades : 0;
    const precoDig = it.preco != null ? it.preco : null;
    const precoXml = r && r.unidades > 0 ? +(r.total / r.unidades).toFixed(4) : null;
    const conferir = !!(r && r.xml.some(x => x.conversao === 'conferir'));
    let tipo = 'ok';
    if (recebida <= 0) tipo = 'falta'; else if (conferir) tipo = 'conferir'; else if (recebida < pedida - 0.001) tipo = 'parcial'; else if (recebida > pedida + 0.001) tipo = 'a_mais';
    let precoStatus = null, precoDif = null, precoPct = null;
    if (precoDig != null && precoXml != null && !conferir) {   // sem saber a unidade, não dá pra julgar o preço
      precoDif = +(precoXml - precoDig).toFixed(4); precoPct = precoDig > 0 ? precoDif / precoDig : 0;
      precoStatus = Math.abs(precoPct) <= TOL_PRECO ? 'ok' : (precoDif > 0 ? 'maior' : 'menor');
      if (precoStatus === 'maior') divPreco++;   // só preço MAIOR trava; menor é a favor da rede e fica só como informação (29/09/2026, pedido 17 Betânia)
    }
    // esperado = recebido × preço digitado; se a nota veio mais barata, vale o preço da nota (é o que se paga)
    esperado += recebida * (precoStatus === 'menor' ? precoXml : (precoDig != null ? precoDig : (it.ultimo_custo || 0)));
    itens.push({ cod: it.cod, descricao: it.descricao, pedida, recebida, dif: +(recebida - pedida).toFixed(3), tipo, preco_digitado: precoDig, preco_xml: precoXml, preco_dif: precoDif, preco_pct: precoPct != null ? +(precoPct * 100).toFixed(2) : null, preco_status: precoStatus, xml: r ? r.xml : [], conferir_unidade: conferir, ...(r?.vinculo ? { vinculo: r.vinculo } : {}) });
    if (tipo === 'falta' || tipo === 'parcial') faltas.push({ it, pedida, rec: recebida, falta: pedida - recebida });
  }
  // itens que vieram na nota mas não estavam no pedido
  const pedidos = new Set(p.itens.filter(i => (i.lojas_qtd?.[ln] || 0) > 0).map(i => i.cod));
  const naoPedidos = Object.entries(rec).filter(([cod]) => !pedidos.has(cod)).map(([cod, r]) => ({ cod, descricao: r.descricao, recebida: r.unidades, total: +r.total.toFixed(2), preco_xml: r.unidades > 0 ? +(r.total / r.unidades).toFixed(4) : null, xml: r.xml }));
  const nConferir = itens.filter(i => i.conferir_unidade).length;
  const nfe = +notas.reduce((a, n) => a + n.valorNFE, 0).toFixed(2);
  const bolTotal = +notas.reduce((a, n) => a + n.boletos.reduce((s, b) => s + b.valor, 0), 0).toFixed(2);
  const nBol = notas.reduce((a, n) => a + n.boletos.length, 0);
  const af = afinidade(p, ln, notas);
  const problemas = [];
  if (af.total && af.pct < 50) problemas.push({ tipo: 'afinidade', msg: 'só ' + af.batem + ' de ' + af.total + ' itens da nota estão no pedido: conferir se é este pedido' });
  if (faltas.length) problemas.push({ tipo: 'falta', msg: faltas.length + (faltas.length > 1 ? ' itens' : ' item') + ' com falta ou parcial' });
  if (itens.some(i => i.tipo === 'a_mais')) problemas.push({ tipo: 'a_mais', msg: itens.filter(i => i.tipo === 'a_mais').length + ' item(ns) veio a mais' });
  if (naoPedidos.length) problemas.push({ tipo: 'nao_pedido', msg: naoPedidos.length + ' item(ns) na nota que não estavam no pedido' });
  if (divPreco) problemas.push({ tipo: 'preco', msg: divPreco + ' item(ns) com preço diferente do digitado' });
  if (nConferir) problemas.push({ tipo: 'unidade', msg: nConferir + ' item(ns) com unidade da nota (caixa/fardo) sem conversão: conferir' });
  const nNome = itens.filter(i => i.vinculo?.tipo === 'nome').length;
  if (nNome) problemas.push({ tipo: 'vinculo_nome', msg: nNome + ' item(ns) casado(s) pelo nome (código da nota é outro): confirmar o vínculo' });
  if (!nBol) problemas.push({ tipo: 'sem_boleto', msg: 'nota sem boleto/duplicata no XML' });
  else if (Math.abs(bolTotal - nfe) > TOL_VALOR) problemas.push({ tipo: 'boleto', msg: 'boletos somam ' + bolTotal.toFixed(2) + ' e a NF-e é ' + nfe.toFixed(2) });
  if (esperado > 0 && Math.abs(nfe - esperado) / esperado > TOL_PRECO && !divPreco && !naoPedidos.length) problemas.push({ tipo: 'valor', msg: 'valor da NF-e (' + nfe.toFixed(2) + ') diferente do esperado (' + esperado.toFixed(2) + ')' });
  return {
    status: problemas.length ? 'consistencia' : 'conciliado', conferidoEm: new Date().toISOString(),
    notas: notas.map(n => ({ chave: n.chave, nNota: n.nNota, serie: n.serie, data: n.data, emitente: n.emitente, valorNFE: n.valorNFE, importado: n.importado, itens: n.itens.length, boletos: n.boletos,
                             valorProduto: n.valorProduto, desconto: n.desconto, frete: n.frete, ipi: n.ipi, st: n.st })),
    itens, nao_pedidos: naoPedidos, faltas: faltas.length, afinidade: af.pct,
    financeiro: { nfe, esperado: +esperado.toFixed(2), boletos: bolTotal, n_boletos: nBol, vencimentos: notas.flatMap(n => n.boletos.map(b => b.vencimento)).sort() },
    problemas, _faltas: faltas
  };
}

// confere a loja e grava o resultado no pedido: recebido por item (compatível com a tela antiga), p.recebimento[ln]
// e sugestão de ruptura UMA vez por loja. Preserva o que a conferência não recalcula (chegou/entrada, decisões por item).
function aplicarConferencia(p, ln, notas, prev, criarOuMesclarRuptura) {
  const r = conferirLoja(p, ln, notas);
  for (const i of r.itens) { const it = p.itens.find(x => x.cod === i.cod); if (it) { it.recebido = it.recebido || {}; it.recebido[ln] = i.recebida; } }
  const jaCriou = prev?.ruptura_criada;
  p.recebimento = p.recebimento || {};
  p.recebimento[ln] = { notas: r.notas.map(n => ({ nNota: n.nNota, chave: n.chave, data: n.data })), conferidoEm: r.conferidoEm, faltas: r.faltas, itens_pedidos: r.itens.length };
  if (r._faltas.length && !jaCriou && criarOuMesclarRuptura) { try { criarOuMesclarRuptura(p, ln, r._faltas); r.ruptura_criada = true; } catch (e) { console.error('[XML] ruptura:', e.message); } }
  else if (jaCriou) r.ruptura_criada = true;
  delete r._faltas;
  if (prev) {
    if (prev.chegou) r.chegou = prev.chegou;
    for (const n of r.notas) { const o = (prev.notas || []).find(q => q.chave === n.chave); if (o?.entrada) n.entrada = o.entrada; }
    for (const i of [...r.itens, ...r.nao_pedidos]) { const o = [...(prev.itens || []), ...(prev.nao_pedidos || [])].find(q => q.cod === i.cod); if (o?.decisao) i.decisao = o.decisao; }
  }
  p.xml = p.xml || { status: 'aguardando', lojas: {} };
  p.xml.lojas[ln] = r;
  return r;
}
// Reconfere UMA loja na hora (depois de vincular/desvincular um código), com as mesmas notas já vinculadas a ela.
// Não mexe em loja conciliada nem em loja sem nota. Devolve o novo resultado da loja ou null.
async function reconferirLoja(p, ln, { criarOuMesclarRuptura } = {}) {
  const prev = p.xml?.lojas?.[ln];
  if (!prev || prev.status === 'conciliado' || !(prev.notas || []).length) return null;
  let notas;
  if (p.teste) notas = notasTeste(p.id, ln);
  else {
    const desde = (p.aprovadoEm || p.criadoEm).slice(0, 10);
    notas = await buscarNotas(await cnpjRaizFornecedor(p.codFornec), ln, addDias(desde, -1), addDias(desde, JANELA_DIAS));
  }
  const chaves = new Set(prev.notas.map(n => n.chave));
  notas = notas.filter(n => chaves.has(n.chave));
  if (!notas.length) return null;
  const r = aplicarConferencia(p, ln, notas, prev, criarOuMesclarRuptura);
  const L = p.lojas.map(l => p.xml.lojas[l]).filter(Boolean), comNota = L.filter(y => y && y.status !== 'aguardando');
  if (comNota.length === p.lojas.length) p.xml.status = L.every(y => y.status === 'conciliado') ? 'conciliado' : 'consistencia';
  else p.xml.status = comNota.length ? 'parcial' : 'aguardando';
  if (p.xml.status === 'conciliado') { p.status = 'recebido'; p.recebidoEm = p.recebidoEm || new Date().toISOString(); }
  else if (['consistencia', 'parcial'].includes(p.xml.status) && p.status === 'aprovado') p.status = 'recebido_parcial';
  return r;
}

// roda em todos os pedidos aprovados; devolve { verificados, rupturas, conciliados, consistencias }
async function conferirTodos({ listar, salvar, criarOuMesclarRuptura, onConciliado }) {
  if (!qERP) return { verificados: 0, rupturas: 0 };
  const hoje = new Date().toISOString().slice(0, 10);
  let verificados = 0, rupturas = 0, conciliados = 0, consistencias = 0;
  const todos = listar();
  const aberto = p => ['aprovado', 'recebido_parcial', 'recebido'].includes(p.status) && p.xml?.status !== 'conciliado';
  // Nota só fica presa a um pedido depois que a loja CONCILIOU. Antes disso ela é redistribuída a cada rodada.
  const chaveDono = {};
  for (const p of todos) for (const L of Object.values(p.xml?.lojas || {})) if (L.status === 'conciliado') for (const n of L.notas || []) chaveDono[n.chave] = p.id;
  // 1ª passagem: busca as notas de cada pedido/loja e anota os candidatos de cada nota (29/09/2026, caso DIA: a cotação
  // gerou 4 pedidos do mesmo fornecedor no mesmo dia e a nota dos adoçantes caiu no pedido do Smirnoff).
  const cand = {};                 // `${id}|${ln}` → notas achadas
  const porChave = {};             // `${ln}|${chave}` → { pedidos: [{ p, batem }] }
  for (const p of todos) {
    if (!aberto(p)) continue;
    const desde = (p.aprovadoEm || p.criadoEm).slice(0, 10), ate = addDias(desde, JANELA_DIAS);
    const raiz = p.teste ? null : await cnpjRaizFornecedor(p.codFornec);
    for (const ln of p.lojas) {
      if (p.xml?.lojas?.[ln]?.status === 'conciliado') continue;
      let notas;
      try { notas = p.teste ? notasTeste(p.id, ln) : await buscarNotas(raiz, ln, addDias(desde, -1), ate); }
      catch (e) { console.error('[XML] loja', ln, e.message); continue; }
      notas = notas.filter(n => !chaveDono[n.chave] || chaveDono[n.chave] === p.id);
      cand[p.id + '|' + ln] = notas;
      for (const n of notas) {
        const k = ln + '|' + n.chave, e = porChave[k] || (porChave[k] = { pedidos: [] });
        e.pedidos.push({ p, batem: afinidade(p, ln, [n]).batem });
      }
    }
  }
  // Dono da nota: quem tem MAIS itens dela; empate → pedido mais antigo; nenhum item em comum → ninguém (pedido feito direto no Dlinks).
  const dono = {};
  for (const [k, e] of Object.entries(porChave)) {
    const melhor = e.pedidos.filter(c => c.batem > 0).sort((a, b) => b.batem - a.batem || a.p.criadoEm.localeCompare(b.p.criadoEm))[0];
    if (melhor) dono[k] = melhor.p.id;
  }
  // 2ª passagem: confere cada loja só com as notas que são dela
  for (const p of todos) {
    if (!aberto(p)) continue;
    const desde = (p.aprovadoEm || p.criadoEm).slice(0, 10);
    const ate = addDias(desde, JANELA_DIAS);
    p.xml = p.xml || { status: 'aguardando', lojas: {} };
    p.recebimento = p.recebimento || {};
    let mudou = false;
    for (const ln of p.lojas) {
      const prev = p.xml.lojas[ln];
      if (prev && prev.status === 'conciliado') continue;
      if (!cand[p.id + '|' + ln]) continue;   // busca falhou nessa rodada: não mexe
      const notas = cand[p.id + '|' + ln].filter(n => dono[ln + '|' + n.chave] === p.id);
      if (!notas.length) {
        if (!prev || prev.status !== 'aguardando' || (prev.notas || []).length) {   // inclui desfazer vínculo errado de rodada anterior
          p.xml.lojas[ln] = { status: 'aguardando', notas: [], itens: [], problemas: [] };
          delete p.recebimento[ln];
          for (const it of p.itens) if (it.recebido) delete it.recebido[ln];
          mudou = true;
        }
        continue;
      }
      const r = aplicarConferencia(p, ln, notas, prev, criarOuMesclarRuptura);
      if (r.ruptura_criada && !prev?.ruptura_criada) rupturas++;
      mudou = true; verificados++;
      if (r.status === 'conciliado') (p._conciliadasAgora = p._conciliadasAgora || []).push(+ln);
      if (r.status === 'conciliado') conciliados++; else consistencias++;
    }
    const L = p.lojas.map(ln => p.xml.lojas[ln]).filter(Boolean);
    const comNota = L.filter(x => x.status !== 'aguardando');
    const antes = p.xml.status;
    if (comNota.length === p.lojas.length) p.xml.status = L.every(x => x.status === 'conciliado') ? 'conciliado' : 'consistencia';
    else if (hoje > ate && comNota.length) p.xml.status = 'consistencia';   // janela venceu com loja sem nota
    else p.xml.status = comNota.length ? 'parcial' : 'aguardando';
    if (p.xml.status !== antes) mudou = true;
    // status do pedido (mantém os nomes que a tela já usa)
    if (p.xml.status === 'conciliado') { p.status = 'recebido'; p.recebidoEm = p.recebidoEm || new Date().toISOString(); mudou = true; }
    else if (p.xml.status === 'consistencia') { p.status = 'recebido_parcial'; p.recebidoEm = p.recebidoEm || new Date().toISOString(); mudou = true; }
    else if (p.status === 'recebido_parcial') { p.status = 'aprovado'; delete p.recebidoEm; mudou = true; }   // vínculo errado desfeito
    const agora = p._conciliadasAgora || []; delete p._conciliadasAgora;
    if (mudou) { p.xml.verificadoEm = new Date().toISOString(); salvar(p); }
    if (onConciliado) for (const ln of agora) { try { onConciliado(p, ln); } catch (e) { console.error('[XML] onConciliado:', e.message); } }
  }
  return { verificados, rupturas, conciliados, consistencias };
}

// ─────────────────────────────────────────────────────────────
// ENTRADA NA LOJA (24/09/2026, pedido do Tiago: "já chegou na loja, mostrar a nota ao lado e abrir ao clicar")
// A conferência acima acontece ANTES do caminhão (o XML entra no ERP primeiro). Quando a loja lança a nota,
// ela vira uma linha em central.compras (chave = chave da NF-e; Status E = lançada/aberta, F = fechada pela
// central, C = cancelada). Bonificação (Movimentacao BONIFICACAO) do mesmo fornecedor conta como nota chegada (25/09/26:
// Atacarejo nunca fechava porque a 2ª NF-e era bonificação e ficava fora). Antes só COMPRA. Linha antiga:
// central, C = cancelada) e, se a loja conferir no coletor, central.conferencia (Status 1 bipando, 3/4 loja
// terminou, 2 liberada pela central). Aqui só ANOTA em cada nota do XML: n.entrada = { nCompra, status, dataRecto,
// conferencia }. Loja: x.chegou = { em, fechada }. Loja que APAGA a nota pra relançar → entrada some e volta.
// Somente leitura no ERP. Pedidos de teste não consultam nada.
// ─────────────────────────────────────────────────────────────
const CONF_STATUS = { 0: 'aguardando conferência na loja', 1: 'em conferência na loja', 3: 'conferida pela loja, aguardando central', 4: 'conferida pela loja, aguardando central', 2: 'liberada pela central' };
const ENTRADA_DIAS = 60;   // deixa de consultar pedidos recebidos há mais de 60 dias

async function verificarEntradas({ listar, salvar }) {
  if (!qERP) return { pedidos: 0, notas: 0, chegaram: 0 };
  const corte = addDias(new Date().toISOString().slice(0, 10), -ENTRADA_DIAS);
  let pedidos = 0, notas = 0, chegaram = 0;
  for (const p of listar()) {
    if (p.teste || !p.xml?.lojas) continue;
    if (!['aprovado', 'recebido', 'recebido_parcial'].includes(p.status)) continue;
    if ((p.recebidoEm || p.aprovadoEm || p.criadoEm || '').slice(0, 10) < corte) continue;
    const todas = [];
    for (const [ln, x] of Object.entries(p.xml.lojas)) for (const n of x.notas || []) if (n.chave) todas.push({ ln: +ln, n });
    if (!todas.length) continue;
    let rows;
    try {
      rows = await qERP(`/*entrada-nota*/ SELECT nt.nCompra, nt.nLoja, nt.nNota, nt.chave, nt.Status st, DATE_FORMAT(nt.DataRecto,'%Y-%m-%d') dr, nt.NomeOperador op,
          cf.Status cst, cf.OperadorLoja opLoja, cf.OperadorCentral opCentral, DATE_FORMAT(cf.DataEntrada,'%Y-%m-%d') de, cf.HoraEntrada he, DATE_FORMAT(cf.DataLiberacao,'%Y-%m-%d') dl, cf.HoraLiberacao hl, DATE_FORMAT(cf.DataConferido,'%Y-%m-%d') dc, cf.HoraConferido hc
        FROM central.compras nt LEFT JOIN central.conferencia cf ON cf.nReg=nt.nConferencia
        WHERE nt.Movimentacao IN ('COMPRA','BONIFICACAO') AND nt.Status<>'C' AND (nt.chave IN (${todas.map(() => '?').join(',')})
           OR (nt.CodFornec=? AND nt.nNota IN (${todas.map(() => '?').join(',')}) AND nt.nLoja IN (${[...new Set(todas.map(t => t.ln))].map(() => '?').join(',')})))
        ORDER BY nt.DataRecto`, [...todas.map(t => t.n.chave), p.codFornec || 0, ...todas.map(t => String(t.n.nNota)), ...new Set(todas.map(t => t.ln))]);
    } catch (e) { console.error('[XML] entrada pedido #' + p.id + ':', e.message); continue; }
    pedidos++;
    let mudou = false;
    for (const { ln, n } of todas) {
      const h = rows.find(r => String(r.chave || '') === String(n.chave) && +r.nLoja === ln)
             || rows.find(r => String(r.nNota) === String(n.nNota) && +r.nLoja === ln);
      const antes = JSON.stringify(n.entrada || null);
      if (!h) { delete n.entrada; }
      else {
        notas++;
        n.entrada = { nCompra: h.nCompra, status: h.st || null, dataRecto: h.dr || null, operador: h.op || null,
          conferencia: h.cst == null ? null : { status: num(h.cst), texto: CONF_STATUS[num(h.cst)] || ('status ' + h.cst), operadorLoja: h.opLoja || null, operadorCentral: h.opCentral || null,
            entrada: h.de ? h.de + (h.he ? ' ' + String(h.he).slice(0, 5) : '') : null, conferido: h.dc ? h.dc + (h.hc ? ' ' + String(h.hc).slice(0, 5) : '') : null, liberacao: h.dl ? h.dl + (h.hl ? ' ' + String(h.hl).slice(0, 5) : '') : null } };
      }
      if (JSON.stringify(n.entrada || null) !== antes) mudou = true;
    }
    for (const x of Object.values(p.xml.lojas)) {
      const com = (x.notas || []).filter(n => n.entrada);
      const antes = JSON.stringify(x.chegou || null);
      if (!com.length) delete x.chegou;
      else {
        // Hora: o ERP só guarda a DATA da entrada (compras.DataRecto). Hora vem do coletor (conferencia.DataEntrada/HoraEntrada)
        // quando a loja bipa; senão fica a hora em que o app viu a nota (detectadoEm). Fechamento: hora de liberação/conferido
        // do coletor, senão a hora em que o app viu o Status 'F' (fechadaEm). 25/09/26, pedido do Tiago: "chegou hora e finalizado hora".
        const antigo = x.chegou || {};
        const fechada = com.length === (x.notas || []).length && com.every(n => n.entrada.status === 'F');
        const horaEntrada = com.map(n => n.entrada.conferencia && n.entrada.conferencia.entrada).filter(Boolean).sort()[0] || null;
        const horaFecho = com.map(n => n.entrada.conferencia && (n.entrada.conferencia.liberacao || n.entrada.conferencia.conferido)).filter(Boolean).sort().pop() || null;
        x.chegou = { em: com.map(n => n.entrada.dataRecto).filter(Boolean).sort()[0] || null, notas: com.length, de: (x.notas || []).length, fechada,
          horaEntrada, detectadoEm: antigo.detectadoEm || new Date().toISOString(),
          fechadaEm: fechada ? (antigo.fechadaEm || horaFecho || new Date().toISOString()) : null, horaFecho };
        chegaram++;
      }
      if (JSON.stringify(x.chegou || null) !== antes) mudou = true;
    }
    if (mudou) { p.xml.entradaEm = new Date().toISOString(); salvar(p); }
  }
  return { pedidos, notas, chegaram };
}

module.exports = { init, conferirTodos, verificarEntradas, conferirLoja, reconferirLoja, vincularCod, lerDepara, nomeCasa, buscarNotas, LOJA_CNPJ, TESTE_DIR };
