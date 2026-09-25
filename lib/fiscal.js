'use strict';
// FISCAL — Recebimento de notas nas lojas (21/09/2026, pedido do Tiago).
//
// Hoje o fiscal faz muita coisa na mão no ERP (tela "Documentos Fiscais"):
// abre cada conferência, confere nota × pedido, olha validade, vencimento do
// boleto, itens, libera pra armazenagem ou manda reconferir. A ideia aqui é
// o sistema cruzar TUDO sozinho e só chamar gente pra exceção.
//
// Fontes no ERP (SOMENTE LEITURA — nada é gravado no MySQL):
//   central.conferencia        cabeçalho da conferência aberta na loja (bipagem da nota)
//   central.conferenciachave   chaves NF-e associadas à conferência (Obs = venc. boleto digitado)
//   central.conferenciaitens   contagem do coletor (chave = nº da conferência, qtd, emb, validade)
//   central.compras            lançamento fiscal (nConferencia liga, TotalNota, Movimentacao, NumeroPedido)
//   central.axml / axmlprodutos / axmlboletos   XML da NF-e (cabeçalho, itens, duplicatas)
//   central.pedidoitensconferidos   comparação pedido × XML feita pelo ERP (por nNota+Serie)
//   central.itens / custoloja{N}    cadastro (venda, margem, validade em dias, emb) e último custo
//   central.mensagemreconferir       telefone do conferente de cada loja (WhatsApp de reconferência)
//
// Status de central.conferencia (legenda do ERP: Em Conf. de Pedido, Em Conf.
// de Coletor, Conferido, Liberado p/ armazenagem, Cancelado, Reconferir).
// Confirmado nos dados: 2 = Liberado p/ armazenagem, 3 = Em Conf. de Coletor
// (sem item, sem chave, sem operador central). 1 aparece só até mar/2026
// (Conferido). 0/4/5 são inferidos pela ordem da legenda — Tiago confirma.
//
// Decisões do fiscal (liberar / reconferir / bloquear), tolerâncias e os
// exemplos de teste ficam em data/fiscal/*.json.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'fiscal');
const ARQ_DECISOES = path.join(DIR, 'decisoes.json');
const ARQ_CONFIG = path.join(DIR, 'config.json');
const ARQ_TESTES = path.join(DIR, 'testes.json');

const LOJAS = [1, 2, 3, 4, 5, 6, 10];
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO', 10: 'DISTRIBUIDORA' };
const STATUS_ERP = { 0: 'conf_pedido', 1: 'conferido', 2: 'liberado', 3: 'em_coletor', 4: 'reconferir', 5: 'cancelado' };
const STATUS_NOMES = { conf_pedido: 'Em conf. de pedido', em_coletor: 'Em conf. de coletor', conferido: 'Conferido', liberado: 'Liberado p/ armazenagem', cancelado: 'Cancelado', reconferir: 'Reconferir' };

const CONFIG_PADRAO = {
  tol_qtd_pct: 0,          // diferença de quantidade tolerada (coletor × nota), em %
  tol_peso_pct: 5,         // item de balança (kg): tolerância de pesagem/quebra (hortifruti varia 3-8% no dia a dia), em %
  tol_preco_pct: 1,        // preço XML acima do pedido tolerado, em % (no ERP ~9% das linhas passam disso — é trabalho real do fiscal)
  custo_aumento_pct: 5,    // custo XML acima do último custo do ERP → aviso
  validade_min_dias: 7,    // piso absoluto: validade lida no coletor menor que isso → exceção
  validade_min_pct: 33,    // ou menor que X% da referência (1/3 do normal; 50% pegava lote comum, porque a referência já é a validade média NA ENTRADA) (validade de cadastro; senão a validade normal do item nas entradas anteriores)
  boleto_min_dias: 7,      // 1º boleto vencendo em menos de N dias da entrada → aviso
  margem_min_pct: 5,       // margem (venda cadastro × custo XML) abaixo disso → exceção
  margem_diverg_pp: 10,    // margem calculada X pontos abaixo da margem de cadastro → aviso
  exigir_pedido: false,    // nota sem pedido de compra vira exceção (true) ou só aviso (false)
  auto_liberar: true       // cruzamento 100% OK → sistema já marca "pronto" (fiscal não precisa abrir)
};

const UND_UNITARIA = new Set(['UN', 'UND', 'UNID', 'PC', 'PÇ', 'PCS', 'KG', 'G', 'L', 'LT', 'ML', 'BD', 'BDJ', 'GF', 'LATA', 'SC', 'PT', 'POTE', 'FR', 'TB', 'VD', 'BS']);

let qERP = null;
let depsF = {};
function init(q, deps) { qERP = q; depsF = deps || {}; fs.mkdirSync(DIR, { recursive: true }); }
// pedidos de compra (pedidos-fornecedor) ligados a esta conferência: pela chave da NF-e conciliada; senão mesmo
// fornecedor + loja e aprovado nos últimos 45 dias. Traz a observação do(a) comprador(a) pro Fiscal.
function pedidosCompraDe(codFornec, loja, chaves) {
  let lista = []; try { lista = (depsF.pedidos && depsF.pedidos()) || []; } catch (e) { return []; }
  const setCh = new Set(chaves || []); const limite = new Date(Date.now() - 45 * 86400000).toISOString();
  const out = [];
  for (const p of lista) {
    if (p.teste || !['aprovado', 'recebido', 'recebido_parcial'].includes(p.status)) continue;
    const porChave = Object.values(p.recebimento || {}).some(r => (r.notas || []).some(n => setCh.has(n.chave))) || Object.values(p.xml?.lojas || {}).some(x => (x.notas || []).some(n => setCh.has(n.chave)));
    const porFornec = +p.codFornec > 0 && +p.codFornec === +codFornec && (p.lojas || []).includes(+loja) && (p.aprovadoEm || '') >= limite;
    if (!porChave && !porFornec) continue;
    out.push({ id: p.id, lista_nome: p.lista_nome, status: p.status, aprovadoEm: p.aprovadoEm || null, vendedor: p.vendedor?.nome || null, obs_fiscal: p.obs_fiscal || null, obs_fiscal_por: p.obs_fiscal_por || null, vinculo: porChave ? 'nota' : 'fornecedor' });
  }
  return out;
}

// Itens do Pedido de Compra do APP vinculados a esta nota (conferência XML da loja: pedida × veio, preço digitado × XML),
// pra quando o ERP não tem pedido (pedidoitensconferidos vazio). Tiago, 24/09/2026: "no fiscal pode puxar já a nota de
// Três Corações que recebeu na loja 3, aí já pode puxar todas informações". Quantidades em UNIDADES (oqTrib), como o Fiscal.
function pedidoAppPorCod(codFornec, loja, chaves) {
  let lista = []; try { lista = (depsF.pedidos && depsF.pedidos()) || []; } catch (e) { return { map: {}, ids: [], aceitos: [] }; }
  const setCh = new Set(chaves || []); const map = {}; const ids = []; const aceitos = [];
  for (const p of lista) {
    if (p.teste || !['aprovado', 'recebido', 'recebido_parcial'].includes(p.status)) continue;
    const x = p.xml?.lojas?.[loja]; if (!x || !(x.notas || []).some(n => setCh.has(n.chave))) continue;
    ids.push(p.id);
    if (x.aceito && x.aceito.por !== undefined) aceitos.push({ pedido: p.id, por: x.aceito.por || null, em: x.aceito.em || null, motivo: x.aceito.motivo || '' });
    const dec = i => i.decisao && i.decisao.acao ? { acao: i.decisao.acao, por: i.decisao.por || null, em: i.decisao.em || null } : null;
    const unidDe = cod => (p.itens || []).find(i => i.cod === cod)?.unid || null;
    for (const i of x.itens || []) {
      const cod = String(i.cod || '').trim(); if (!cod || map[cod]) continue;
      map[cod] = { qtd_ped: +i.pedida || 0, qtd_xml: +i.recebida || 0, preco_ped: i.preco_digitado != null ? +i.preco_digitado : 0, preco_xml: i.preco_xml != null ? +i.preco_xml : 0, und_ped: unidDe(cod), und_xml: null,
        diferenca: i.preco_digitado != null && i.preco_xml != null ? r2((+i.preco_xml - +i.preco_digitado) * (+i.recebida || 0)) : 0, nPedido: null, app: p.id, tipo: i.tipo || null, decisao: dec(i) };
    }
    for (const i of x.nao_pedidos || []) { const cod = String(i.cod || '').trim(); if (cod && !map[cod]) map[cod] = { qtd_ped: 0, qtd_xml: +i.recebida || 0, preco_ped: 0, preco_xml: i.preco_xml != null ? +i.preco_xml : 0, und_ped: null, und_xml: null, diferenca: 0, nPedido: null, app: p.id, nao_pedido: true, decisao: dec(i) }; }
  }
  return { map, ids, aceitos };
}
// linha informativa pro fiscal: quem liberou/recusou o item na conferência XML do Pedido de Compra (25/09/2026)
const ddmm = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] : ''; };
function flagDecisao(pd) {
  const d = pd && pd.decisao; if (!d || !d.acao) return null;
  const motivo = pd.nao_pedido ? 'item não pedido' : pd.tipo === 'a_mais' ? 'item a mais' : pd.tipo === 'parcial' ? 'quantidade menor' : pd.tipo === 'falta' ? 'falta' : 'preço';
  const quem = (d.por ? ' por ' + d.por : '') + (d.em ? ' em ' + ddmm(d.em) : '');
  const msg = d.acao === 'recusar' ? `Recusado${quem} (${motivo}) — devolver` : `Liberado${quem} (${motivo})`;
  return { tipo: 'xml_decisao', nivel: 'info', msg };
}

const num = v => { let s = String(v ?? '0').trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const hoje = () => new Date().toISOString().slice(0, 10);
const ymd = v => { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const diasEntre = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; } };
const gravarJson = (arq, obj) => fs.writeFileSync(arq, JSON.stringify(obj, null, 1));

function getConfig() { return { ...CONFIG_PADRAO, ...lerJson(ARQ_CONFIG, {}) }; }
function setConfig(campos) {
  const c = getConfig();
  for (const k of Object.keys(CONFIG_PADRAO)) if (campos[k] !== undefined) c[k] = typeof CONFIG_PADRAO[k] === 'boolean' ? !!campos[k] : (isFinite(+campos[k]) ? +campos[k] : c[k]);
  gravarJson(ARQ_CONFIG, c); return c;
}
function getDecisoes() { return lerJson(ARQ_DECISOES, {}); }
function decidir(nReg, acao, obs, por) {
  if (!['liberado', 'reconferir', 'bloqueado', 'limpar'].includes(acao)) throw new Error('ação inválida');
  const d = getDecisoes();
  if (acao === 'limpar') delete d[nReg];
  else {
    const ant = d[nReg] || { historico: [] };
    ant.historico = ant.historico || [];
    ant.historico.push({ acao, obs: obs || '', por: por || null, em: new Date().toISOString() });
    d[nReg] = { acao, obs: obs || '', por: por || null, em: new Date().toISOString(), historico: ant.historico };
  }
  gravarJson(ARQ_DECISOES, d); return d[nReg] || null;
}

// ── consultas em lote ──────────────────────────────────────────
// Descobertas com dado real (21/09/2026):
//   central.compraprodutos = itens da nota JÁ CONVERTIDOS pelo ERP no lançamento: código interno
//   (CodigoBarra, o mesmo que o coletor bipa — inclusive código de balança e "SEM GTIN"),
//   QtdEntradaEstoque em unidades, Custo unitário, PrecoVenda da hora. É a ponte certa entre
//   XML e coletor (o XML sozinho traz EAN de caixa / SEM GTIN e não casa). nCompra repete entre
//   lojas → sempre (nCompra, nLoja). Os campos QtdGuiaCega/StatusCega/DiferencaEstoque estão
//   zerados em 2026: o ERP não guarda o resultado da conferência cega — este módulo faz isso.
//   central.itens.P1..P6 = preço de venda por loja (string com vírgula); itens_margens.MargemVarejo
//   por loja = margem de cadastro. itenscoletorvalidade = validade lida em cada entrada (histórico
//   → "validade normal" do item). custoloja{N}.Custo já vem sobrescrito pela própria nota, então o
//   custo anterior sai de compraprodutos (última compra antes desta).
const BRUTO_VAZIO = () => ({ confs: [], chaves: [], notas: [], prods: [], boletos: [], coletor: [], compras: [], notaItens: [], pedConf: [], pedidos: [], cadastro: [], margens: {}, histVal: {}, custoAnt: [], custos: {}, fornec: {} });
const MAX_EANS_EXTRAS = 2500;   // acima disso pula histórico de custo (consulta pesada) — só em períodos longos

async function carregarBruto({ de, ate, loja }) {
  const filtroLoja = loja ? ' AND c.nLoja=? ' : '';
  const p = [de, ate]; if (loja) p.push(loja);
  const confs = await qERP(`SELECT c.nReg, c.nLoja, c.CodFornec, c.NomeFornec, c.Status, DATE_FORMAT(c.DataEntrada,'%Y-%m-%d') DataEntrada, c.HoraEntrada,
      DATE_FORMAT(c.DataConferido,'%Y-%m-%d') DataConferido, c.HoraConferido, DATE_FORMAT(c.DataLiberacao,'%Y-%m-%d') DataLiberacao, c.HoraLiberacao,
      c.OperadorLoja, c.OperadorCentral, c.OperadorLiberacao, c.Obs
    FROM central.conferencia c WHERE c.DataEntrada BETWEEN ? AND ? ${filtroLoja} ORDER BY c.nLoja, c.nReg`, p);
  if (!confs.length) return BRUTO_VAZIO();
  const ids = confs.map(c => c.nReg);
  const idsStr = ids.map(String);
  const inIds = ids.map(() => '?').join(',');
  const inList = arr => arr.map(() => '?').join(',');

  const chaves = await qERP(`SELECT nRegConf, Chave, Obs FROM central.conferenciachave WHERE nRegConf IN (${inIds})`, ids);
  const compras = await qERP(`SELECT nCompra, nNota, Serie, nLoja, NomeFornec, CodFornec, TotalNota, TotalProdutos, Status, nConferencia, NumeroPedido, Movimentacao, Tipo, chave,
      DATE_FORMAT(DataEmissao,'%Y-%m-%d') DataEmissao, DATE_FORMAT(DataRecto,'%Y-%m-%d') DataRecto, DATE_FORMAT(DataLan,'%Y-%m-%d') DataLan, NomeOperador
    FROM central.compras WHERE nConferencia IN (${inIds})`, ids);
  // itens da nota lançada (código interno, unidades de estoque, custo unitário) — chave (nCompra, nLoja)
  let notaItens = [];
  if (compras.length) {
    const cond = compras.map(() => '(nCompra=? AND nLoja=?)').join(' OR ');
    notaItens = await qERP(`SELECT nCompra, nLoja, Item, CodigoBarra, Unid, Qtd, QtdEmb, QtdEntradaEstoque, Preco, Custo, PrecoVenda, Descricao, Cancelado, ocEanTrib, NNOTA, SERIE, Movimentacao, Bonificacao
      FROM central.compraprodutos WHERE ${cond}`, compras.flatMap(c => [c.nCompra, c.nLoja])).catch(e => { console.error('[FISCAL] compraprodutos:', e.message); return []; });
  }
  const setChaves = new Set([...chaves.map(c => c.Chave), ...compras.map(c => c.chave)].filter(k => k && k.length >= 40));
  const listaChaves = [...setChaves];
  const notas = listaChaves.length ? await qERP(`SELECT nReg, nNota, nSerie, nMod, DATE_FORMAT(Data,'%Y-%m-%d') Data, CNPJdest, CNPJemit, NomeEmit, ValorNFE, ValorProduto, ValorDesconto, ValorFrete, ValorIPI, ValorICMSsub, Chave, Importado, Status, Leu
    FROM central.axml WHERE Chave IN (${inList(listaChaves)})`, listaChaves) : [];
  const boletos = listaChaves.length ? await qERP(`SELECT chave, ndup, DATE_FORMAT(dataVencto,'%Y-%m-%d') vencimento, valor FROM central.axmlboletos WHERE chave IN (${inList(listaChaves)}) ORDER BY chave, ndup`, listaChaves) : [];
  let prods = [];
  if (notas.length) {
    const cond = notas.map(() => '(nNota=? AND CNPJemit=?)').join(' OR ');
    prods = await qERP(`SELECT nNota, CNPJemit, nItem, CodigoItemFornec, CodigoBarras, ocEanTrib, Descricao, Und, Qtd, ValorUnit, ValorTotal, ValorDesconto, oqTrib, ouTrib, ovUnTrib, NCM, CFOP
      FROM central.axmlprodutos WHERE ${cond} ORDER BY nNota, nItem`, notas.flatMap(n => [n.nNota, n.CNPJemit]));
  }
  const coletor = await qERP(`SELECT chave, codigobarra, emb, qtd, qtdemb, status, Reconferir, DataValidade FROM central.conferenciaitens WHERE chave IN (${inIds})`, idsStr);
  // pedido × XML que o ERP já comparou (por nNota + Serie; filtrado depois pelo fornecedor/loja do pedido)
  let pedConf = [];
  if (compras.length) {
    const cond = compras.map(() => '(nNota=? AND Serie=?)').join(' OR ');
    pedConf = await qERP(`SELECT nPedido, nNota, Serie, nItem, Codigobarras, Descricao, UndPed, UndXml, QtdPed, QtdXml, PrecoPed, PrecoXml, TotalPed, TotalXml, Diferenca
      FROM central.pedidoitensconferidos WHERE ${cond}`, compras.flatMap(c => [c.nNota, c.Serie])).catch(() => []);
  }
  const numPed = [...new Set([...compras.map(c => +c.NumeroPedido).filter(n => n > 0), ...pedConf.map(p => +p.nPedido).filter(n => n > 0)])];
  const pedidos = numPed.length ? await qERP(`SELECT nReg, nPedido, nLoja, CodFornec, CNPJFornec, Nome, Total, Status, DATE_FORMAT(DataPedido,'%Y-%m-%d') DataPedido, DATE_FORMAT(DataEntrega,'%Y-%m-%d') DataEntrega, Solicitante, CodPrazo, Prazo_Entrega
    FROM central.pedidocompra WHERE nReg IN (${inList(numPed)}) OR nPedido IN (${inList(numPed)})`, [...numPed, ...numPed]).catch(() => []) : [];

  // cadastro, margem de cadastro, preço por loja, validade histórica e custo anterior dos códigos envolvidos
  const eans = [...new Set([...notaItens.map(p => String(p.CodigoBarra || '').trim()), ...prods.map(p => String(p.ocEanTrib || '').trim()), ...prods.map(p => String(p.CodigoBarras || '').trim()), ...coletor.map(c => String(c.codigobarra || '').trim())].filter(e => e && e !== '0' && e !== 'SEM GTIN'))];
  const lojasEnv = [...new Set(confs.map(c => +c.nLoja))];
  const cadastro = eans.length ? await qERP(`SELECT CodigoBarra, Descricao, qtdemb, Unid, TipoBalanca, P1, P2, P3, P4, P5, P6, custo, UltimoCusto, margem, Validade, CodDesativado FROM central.itens WHERE CodigoBarra IN (${inList(eans)})`, eans) : [];
  const margens = {};
  if (eans.length) for (const r of await qERP(`SELECT CodigoBarra, nLoja, MargemVarejo FROM central.itens_margens WHERE nLoja IN (${inList(lojasEnv)}) AND CodigoBarra IN (${inList(eans)})`, [...lojasEnv, ...eans]).catch(() => [])) margens[r.nLoja + '|' + String(r.CodigoBarra).trim()] = num(r.MargemVarejo);
  const histVal = {};
  if (eans.length) for (const r of await qERP(`SELECT Codigobarra, COUNT(*) n, ROUND(AVG(DATEDIFF(Data, dataEntrada))) media, MIN(DATEDIFF(Data, dataEntrada)) minimo FROM central.itenscoletorvalidade
      WHERE Codigobarra IN (${inList(eans)}) AND dataEntrada BETWEEN ? AND ? AND Data > dataEntrada GROUP BY Codigobarra`, [...eans, addDias(de, -365), ate]).catch(e => { console.error('[FISCAL] hist validade:', e.message); return []; })) histVal[String(r.Codigobarra).trim()] = { n: +r.n, media: +r.media, minimo: +r.minimo };
  let custoAnt = [];
  if (eans.length && eans.length <= MAX_EANS_EXTRAS) custoAnt = await qERP(`SELECT CodigoBarra, nLoja, nCompra, Custo, DATE_FORMAT(DataEntrada,'%Y-%m-%d') DataEntrada FROM central.compraprodutos
      WHERE nLoja IN (${inList(lojasEnv)}) AND CodigoBarra IN (${inList(eans)}) AND DataEntrada BETWEEN ? AND ? AND Movimentacao='COMPRA' AND Cancelado=0`, [...lojasEnv, ...eans, addDias(de, -365), ate]).catch(e => { console.error('[FISCAL] custo anterior:', e.message); return []; });
  const custos = {};
  for (const ln of lojasEnv) {
    if (!eans.length) continue;
    const rows = await qERP(`SELECT CodigoBarra, Custo, CustoMedio, DATE_FORMAT(UltimaCompra,'%Y-%m-%d') UltimaCompra FROM central.custoloja${ln} WHERE CodigoBarra IN (${inList(eans)})`, eans).catch(() => []);
    custos[ln] = Object.fromEntries(rows.map(r => [String(r.CodigoBarra).trim(), r]));
  }
  const codsF = [...new Set(confs.map(c => +c.CodFornec).filter(n => n > 0))];
  const fornRows = codsF.length ? await qERP(`SELECT CodFornec, Nome, CNPJ, Prazo, PrazoDescricao, Condicao_Pagto, DiasEntrega FROM central.fornecedor WHERE CodFornec IN (${inList(codsF)})`, codsF).catch(() => []) : [];
  const fornec = Object.fromEntries(fornRows.map(f => [+f.CodFornec, f]));
  return { confs, chaves, notas, prods, boletos, coletor, compras, notaItens, pedConf, pedidos, cadastro, margens, histVal, custoAnt, custos, fornec };
}

const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ehPeso = (k, und) => (k && String(k.TipoBalanca || '').toUpperCase() === 'P') || ['KG', 'G'].includes(String(und || '').toUpperCase());

// ── cruzamento de UMA conferência ──────────────────────────────
// Recebe os pedaços já filtrados dessa conferência e devolve o recebimento
// pronto pra tela: cabeçalho, notas, itens cruzados, checagens e veredito.
function cruzar(conf, partes, cfg, decisao) {
  const { chaves, notas, prods, boletos, coletor, compras, notaItens, pedConf, pedidos, cadastro, margens, histVal, custoAnt, custos, fornec } = partes;
  const ref = conf.DataEntrada || hoje();
  const loja = +conf.nLoja;
  const statusErp = STATUS_ERP[conf.Status] || ('status_' + conf.Status);
  const cad = ean => cadastro[ean];
  const custoDe = ean => (custos[loja] || {})[ean];
  const vendaDe = (k, ean) => { if (!k) return null; const v = num(k['P' + loja]); if (v > 0) return r2(v); const n = notaPorCod[ean]; return n && n.venda_nota > 0 ? n.venda_nota : null; };
  const margemCadDe = (k, ean) => { const m = margens[loja + '|' + ean]; if (m != null && m > 0) return r2(m); return k && k.margem != null && num(k.margem) > 0 ? r2(num(k.margem)) : null; };
  // custo anterior: última compra desse código nessa loja ANTES desta conferência (outra nota)
  const nCompras = new Set(compras.map(c => +c.nCompra));
  const custoAnterior = ean => {
    let melhor = null;
    for (const r of custoAnt) { if (String(r.CodigoBarra).trim() !== ean || +r.nLoja !== loja || nCompras.has(+r.nCompra) || r.DataEntrada > ref) continue; if (!melhor || r.DataEntrada > melhor.DataEntrada) melhor = r; }
    if (melhor) return { custo: r2(num(melhor.Custo)), data: melhor.DataEntrada };
    const cu = custoDe(ean); if (cu && num(cu.Custo) > 0 && (!cu.UltimaCompra || cu.UltimaCompra < ref)) return { custo: r2(num(cu.Custo)), data: cu.UltimaCompra };
    return null;
  };

  // ── notas: XML (axml) + lançamento (compras), unidas pela chave ──
  const notasOut = [];
  const chavesTodas = [...new Set([...chaves.map(c => c.Chave), ...compras.map(c => c.chave)].filter(Boolean))];
  for (const ch of chavesTodas) {
    const x = notas.find(n => n.Chave === ch);
    const lan = compras.find(c => c.chave === ch);
    const obsChave = (chaves.find(c => c.Chave === ch) || {}).Obs;
    const bols = boletos.filter(b => b.chave === ch).map(b => ({ parcela: +b.ndup, vencimento: b.vencimento, valor: num(b.valor), dias: b.vencimento ? diasEntre(ref, b.vencimento) : null }));
    notasOut.push({
      chave: ch, nNota: x ? +x.nNota : (lan ? +lan.nNota : null), serie: x ? x.nSerie : (lan ? lan.Serie : null), emissao: x ? x.Data : (lan ? lan.DataEmissao : null),
      emitente: x ? x.NomeEmit : (lan ? lan.NomeFornec : null), cnpjEmit: x ? x.CNPJemit : null,
      valor_xml: x ? num(x.ValorNFE) : null, valor_lancado: lan ? num(lan.TotalNota) : null,
      xml: !!x, lancada: !!lan, status_lancamento: lan ? lan.Status : null, movimentacao: lan ? lan.Movimentacao : null, nCompra: lan ? +lan.nCompra : null,
      numero_pedido: lan && +lan.NumeroPedido > 0 ? +lan.NumeroPedido : null, obs_chave: obsChave && obsChave !== '0' ? obsChave : null,
      boletos: bols, itens_xml: x ? prods.filter(p => +p.nNota === +x.nNota && p.CNPJemit === x.CNPJemit).length : 0,
      itens_lancados: lan ? notaItens.filter(i => +i.nCompra === +lan.nCompra && +i.nLoja === +lan.nLoja && !+i.Cancelado).length : 0
    });
  }
  for (const lan of compras.filter(c => !c.chave || c.chave.length < 40)) {
    notasOut.push({ chave: null, nNota: +lan.nNota, serie: lan.Serie, emissao: lan.DataEmissao, emitente: lan.NomeFornec, valor_xml: null, valor_lancado: num(lan.TotalNota), xml: false, lancada: true, status_lancamento: lan.Status, movimentacao: lan.Movimentacao, nCompra: +lan.nCompra, numero_pedido: +lan.NumeroPedido > 0 ? +lan.NumeroPedido : null, boletos: [], itens_xml: 0, itens_lancados: notaItens.filter(i => +i.nCompra === +lan.nCompra && +i.nLoja === +lan.nLoja && !+i.Cancelado).length });
  }

  // ── itens da NOTA por código interno (compraprodutos; fallback: EAN do XML quando ainda não lançou) ──
  const notaPorCod = {};
  const lancada = notaItens.some(i => !+i.Cancelado);
  if (lancada) {
    for (const i of notaItens) {
      if (+i.Cancelado) continue;
      const cod = String(i.CodigoBarra || '').trim(); if (!cod) continue;
      const und = String(i.Unid || '').toUpperCase().trim();
      const qtdEst = num(i.QtdEntradaEstoque) > 0 ? num(i.QtdEntradaEstoque) : num(i.Qtd) * (num(i.QtdEmb) > 0 ? num(i.QtdEmb) : 1);
      const custo = num(i.Custo) > 0 ? num(i.Custo) : (qtdEst > 0 ? num(i.Preco) * num(i.Qtd) / qtdEst : 0);
      const it = notaPorCod[cod] || (notaPorCod[cod] = { cod, descricao_nota: i.Descricao, und, qtd: 0, qtd_com: 0, emb: num(i.QtdEmb) || 1, valor: 0, custo_und: custo, venda_nota: r2(num(i.PrecoVenda)), xml_ean: String(i.ocEanTrib || '').trim(), notas: [], bonif: /BONIF/i.test(String(i.Movimentacao || '')), consumo: !!i.Movimentacao && !/COMPRA|BONIF/i.test(String(i.Movimentacao)) });
      it.qtd += qtdEst; it.qtd_com += num(i.Qtd); it.valor += num(i.Preco) * num(i.Qtd); it.custo_und = custo; if (!it.notas.includes(+i.NNOTA)) it.notas.push(+i.NNOTA);
    }
  } else {
    for (const x of notas) {
      for (const p of prods.filter(p => +p.nNota === +x.nNota && p.CNPJemit === x.CNPJemit)) {
        const ean = String(p.ocEanTrib || '').trim().replace(/^0$/, '') || String(p.CodigoBarras || '').trim().replace(/^SEM GTIN$/, '') || ('SEM-EAN-' + p.CodigoItemFornec);
        const qtdTrib = num(p.oqTrib) > 0 ? num(p.oqTrib) : num(p.Qtd);
        const und = String(p.ouTrib && p.ouTrib !== '0' ? p.ouTrib : p.Und || '').toUpperCase().trim();
        const vUnit = num(p.ovUnTrib) > 0 ? num(p.ovUnTrib) : (qtdTrib > 0 ? num(p.ValorTotal) / qtdTrib : 0);
        const it = notaPorCod[ean] || (notaPorCod[ean] = { cod: ean, descricao_nota: p.Descricao, und, qtd: 0, qtd_com: 0, emb: 1, valor: 0, custo_und: vUnit, venda_nota: null, xml_ean: ean, notas: [], bonif: false, consumo: false });
        it.qtd += qtdTrib; it.qtd_com += num(p.Qtd); it.valor += num(p.ValorTotal); it.custo_und = vUnit; if (!it.notas.includes(+x.nNota)) it.notas.push(+x.nNota);
      }
    }
  }
  // ── contagem do coletor por código (unidades) ──
  const colPorCod = {};
  for (const c of coletor) {
    const cod = String(c.codigobarra || '').trim(); if (!cod) continue;
    const emb = num(c.qtdemb) > 0 ? num(c.qtdemb) : 1;
    const it = colPorCod[cod] || (colPorCod[cod] = { cod, qtd: 0, bipagens: 0, emb: String(c.emb || '').toUpperCase(), qtdemb: emb, validade: null, reconferir: 0 });
    it.qtd += num(c.qtd) * emb; it.bipagens++; it.reconferir += +c.Reconferir || 0;
    const v = ymd(c.DataValidade); if (v && v > '1900-01-01' && (!it.validade || v < it.validade)) it.validade = v;   // validade mais curta manda
  }
  // ── pedido × XML (comparação do ERP), só dos pedidos deste fornecedor nesta loja ──
  const pedidosOk = pedidos.filter(p => +p.nLoja === loja && (+p.CodFornec === +conf.CodFornec || (!+conf.CodFornec)));
  const pedidosSet = new Set(pedidosOk.flatMap(p => [+p.nReg, +p.nPedido]).filter(n => n > 0));
  const pedPorCod = {};
  for (const p of pedConf) { if (!pedidosSet.has(+p.nPedido)) continue; const ean = String(p.Codigobarras || '').trim(); pedPorCod[ean] = { qtd_ped: num(p.QtdPed), qtd_xml: num(p.QtdXml), preco_ped: num(p.PrecoPed), preco_xml: num(p.PrecoXml), und_ped: p.UndPed, und_xml: p.UndXml, diferenca: num(p.Diferenca), nPedido: +p.nPedido }; }
  // sem pedido no ERP → usa o Pedido de Compra do app vinculado pela NF-e (24/09/2026)
  const pedApp = pedidoAppPorCod(+conf.CodFornec, loja, chavesTodas);
  if (!Object.keys(pedPorCod).length) { for (const [cod, pd] of Object.entries(pedApp.map)) if (!pd.nao_pedido) pedPorCod[cod] = pd; }
  else for (const [cod, pd] of Object.entries(pedApp.map)) if (pedPorCod[cod] && pd.decisao) { pedPorCod[cod].decisao = pd.decisao; pedPorCod[cod].tipo = pd.tipo; }

  // validade "padrão": o conferente digita a mesma data em vários itens (ex.: hortifruti com 30/09 em tudo) — não é validade real
  const porData = {}; for (const c of Object.values(colPorCod)) if (c.validade) porData[c.validade] = (porData[c.validade] || 0) + 1;
  const dataPadrao = v => v && porData[v] >= 3 && Object.keys(colPorCod).length >= 4 && porData[v] / Object.keys(colPorCod).length >= 0.6;
  // ── cruzamento item a item ──
  const itens = [];
  const codsTodos = [...new Set([...Object.keys(notaPorCod), ...Object.keys(colPorCod)])];
  const temNota = Object.keys(notaPorCod).length > 0;
  const temColetor = Object.keys(colPorCod).length > 0;
  for (const cod of codsTodos) {
    const x = notaPorCod[cod], c = colPorCod[cod], k = cad(cod) || (x && x.xml_ean ? cad(x.xml_ean) : null), pd = pedPorCod[cod] || (x && x.xml_ean ? pedPorCod[x.xml_ean] : null);
    const flags = [];
    const peso = ehPeso(k, x ? x.und : (c ? c.emb : ''));
    const hist = histVal[cod] || (x && x.xml_ean ? histVal[x.xml_ean] : null);
    const ant = x ? custoAnterior(cod) : null;
    const it = { ean: cod, descricao: k ? k.Descricao : (x ? x.descricao_nota : '(sem cadastro)'), sem_cadastro: !k && !cod.startsWith('SEM-EAN'), peso, bonificacao: !!(x && x.bonif),
      xml_qtd: x ? r2(x.qtd) : null, xml_und: x ? (x.emb > 1 && x.qtd_com !== x.qtd ? 'UN' : x.und) : null, xml_qtd_com: x ? r2(x.qtd_com) : null, xml_und_com: x && x.emb > 1 ? x.und + ' ×' + x.emb : null, xml_valor: x ? r2(x.valor) : null, custo_xml: x ? r2(x.custo_und) : null, notas: x ? x.notas : [],
      col_qtd: c ? r2(c.qtd) : null, col_bipagens: c ? c.bipagens : 0, col_emb: c ? c.emb : null, col_qtdemb: c ? c.qtdemb : null, validade: c ? c.validade : null, reconferir: c ? c.reconferir : 0,
      cad_emb: k ? num(k.qtdemb) : null, cad_validade_dias: k ? +k.Validade || 0 : 0, validade_ref: null, validade_ref_fonte: null, venda: vendaDe(k, cod), venda_nota: x ? x.venda_nota : null, margem_cad: margemCadDe(k, cod),
      ultimo_custo: ant ? ant.custo : null, ultima_compra: ant ? ant.data : null,
      ped_qtd: pd ? pd.qtd_ped : null, ped_preco: pd ? pd.preco_ped : null, ped_xml_preco: pd ? pd.preco_xml : null, ped_dif: pd ? pd.diferenca : null,
      dif_qtd: null, fator_emb: null, dias_validade: null, margem: null, custo_var_pct: null, flags };

    if (it.sem_cadastro) flags.push({ tipo: 'sem_cadastro', nivel: 'erro', msg: 'Código não existe no cadastro do ERP' });
    else if (k && +k.CodDesativado > 0) flags.push({ tipo: 'desativado', nivel: 'aviso', msg: 'Item desativado no cadastro' });

    // quantidade: coletor × nota (em unidades de estoque)
    if (x && !c && temColetor) flags.push({ tipo: 'nao_bipado', nivel: 'erro', msg: 'Está na nota, não foi bipado no coletor' });
    else if (c && !x && temNota) flags.push({ tipo: 'nao_na_nota', nivel: 'erro', msg: 'Bipado no coletor, não está na nota' });
    else if (x && c) {
      const tolPct = x.qtd * (cfg.tol_qtd_pct / 100);
      const tol = peso ? Math.max(tolPct, x.qtd * (cfg.tol_peso_pct / 100)) : tolPct;   // balança: tolerância própria (quebra/gelo/pesagem)
      const dif = c.qtd - x.qtd; it.dif_qtd = r2(dif);
      if (Math.abs(dif) <= tol + 1e-9) { /* ok */ }
      else {
        const fator = c.qtd > x.qtd ? c.qtd / x.qtd : x.qtd / c.qtd;
        const fatorInt = Math.abs(fator - Math.round(fator)) < 1e-6 && Math.round(fator) >= 2 && Math.round(fator) <= 120;
        const embCad = k ? num(k.qtdemb) : 0;
        if (fatorInt && (embCad === Math.round(fator) || (x.emb > 1 && x.emb === Math.round(fator)))) { it.fator_emb = Math.round(fator); flags.push({ tipo: 'emb', nivel: 'aviso', msg: `Unidade diferente: nota ${r2(x.qtd)} ${x.und}, coletor ${r2(c.qtd)} — bate se contou por embalagem de ${Math.round(fator)}` }); }
        else if (dif < 0) flags.push({ tipo: 'falta', nivel: 'erro', msg: `Faltou ${r2(-dif)} ${peso ? 'kg' : 'un'} (nota ${r2(x.qtd)}, coletor ${r2(c.qtd)})` });
        else flags.push({ tipo: 'sobra', nivel: 'erro', msg: `Veio ${r2(dif)} ${peso ? 'kg' : 'un'} a mais (nota ${r2(x.qtd)}, coletor ${r2(c.qtd)})` });
      }
    }
    if (c && c.reconferir > 0) flags.push({ tipo: 'reconferir', nivel: 'erro', msg: 'Marcado pra reconferir no coletor' });

    // validade lida no coletor × referência (cadastro em dias; senão a validade normal desse item nas entradas anteriores)
    if (it.cad_validade_dias > 0) { it.validade_ref = it.cad_validade_dias; it.validade_ref_fonte = 'cadastro'; }
    else if (hist && hist.n >= 3 && hist.media > 0) { it.validade_ref = hist.media; it.validade_ref_fonte = 'histórico ' + hist.n + ' entradas'; }
    if (c && c.validade && peso) { it.dias_validade = diasEntre(ref, c.validade); /* item pesado: validade do coletor não é confiável (hortifruti/açougue) — só informa */ }
    else if (c && c.validade && dataPadrao(c.validade)) { it.dias_validade = diasEntre(ref, c.validade); it.validade_padrao = true; flags.push({ tipo: 'validade_padrao', nivel: 'aviso', msg: `Mesma data em ${porData[c.validade]} itens da conferência — parece data padrão digitada, não validade real` }); }
    else if (c && c.validade) {
      it.dias_validade = diasEntre(ref, c.validade);
      if (it.dias_validade < 0) flags.push({ tipo: 'vencido', nivel: 'erro', msg: `Validade vencida (${c.validade.split('-').reverse().join('/')})` });
      else if (it.dias_validade < cfg.validade_min_dias) flags.push({ tipo: 'validade_curta', nivel: 'erro', msg: `Vence em ${it.dias_validade} dia(s) — mínimo ${cfg.validade_min_dias}` });
      else if (it.validade_ref && it.dias_validade < it.validade_ref * cfg.validade_min_pct / 100) flags.push({ tipo: 'validade_curta', nivel: 'erro', msg: `Vence em ${it.dias_validade} d; o normal desse item é ${Math.round(it.validade_ref)} d (${it.validade_ref_fonte}) — menos de ${cfg.validade_min_pct}%` });
    } else if (c && !peso && it.validade_ref) flags.push({ tipo: 'sem_validade', nivel: 'aviso', msg: 'Coletor não registrou a data de validade (item costuma ter)' });

    // preço × pedido (comparação do ERP) e custo × compra anterior
    if (pd && pd.preco_ped > 0 && pd.preco_xml > pd.preco_ped * (1 + cfg.tol_preco_pct / 100) + 1e-9) flags.push({ tipo: 'preco_pedido', nivel: 'erro', msg: `Preço na nota ${brl(pd.preco_xml)} acima do pedido ${brl(pd.preco_ped)} (+${r2((pd.preco_xml / pd.preco_ped - 1) * 100)}%)` });
    if (pd && pd.qtd_ped > 0 && Math.abs(pd.qtd_xml - pd.qtd_ped) > 1e-9) flags.push({ tipo: 'qtd_pedido', nivel: 'aviso', msg: `Nota ${pd.qtd_xml} × pedido ${pd.qtd_ped} ${pd.und_ped || ''}` });
    { const fd = flagDecisao(pd || pedApp.map[cod] || (x && x.xml_ean ? pedApp.map[x.xml_ean] : null)); if (fd) flags.push(fd); }
    if (x && ant && ant.custo > 0 && x.custo_und > 0) {
      it.custo_var_pct = r2((x.custo_und / ant.custo - 1) * 100);
      if (it.custo_var_pct > cfg.custo_aumento_pct) flags.push({ tipo: 'custo_subiu', nivel: 'aviso', msg: `Custo +${it.custo_var_pct}% sobre a compra anterior (${brl(ant.custo)} em ${ant.data ? ant.data.split('-').reverse().join('/') : '?'})` });
    }
    // margem: venda de cadastro da loja × custo unitário da nota
    if (x && !x.bonif && !x.consumo && it.venda != null && it.venda < 0.5 && x.custo_und > 0) { it.venda = null; flags.push({ tipo: 'sem_preco', nivel: 'aviso', msg: 'Sem preço de venda no cadastro (valor simbólico)' }); }
    if (x && !x.bonif && !x.consumo && it.venda > 0 && x.custo_und > 0) {
      it.margem = r2((it.venda - x.custo_und) / it.venda * 100);
      if (it.margem < 0) flags.push({ tipo: 'margem_negativa', nivel: 'erro', msg: `Margem negativa: custo ${brl(x.custo_und)} × venda ${brl(it.venda)}` });
      else if (it.margem < cfg.margem_min_pct) flags.push({ tipo: 'margem_baixa', nivel: 'erro', msg: `Margem ${it.margem}% abaixo do mínimo ${cfg.margem_min_pct}%` });
      else if (it.margem_cad != null && it.margem_cad - it.margem >= cfg.margem_diverg_pp) flags.push({ tipo: 'margem_diverge', nivel: 'aviso', msg: `Margem ${it.margem}% × cadastro ${it.margem_cad}%` });
    }
    itens.push(it);
  }

  // ── checagens de cabeçalho ──
  const checks = {};
  const contar = tipos => itens.filter(i => i.flags.some(f => tipos.includes(f.tipo))).length;
  const nivelDe = (n, aviso) => n === 0 ? 'ok' : (aviso ? 'aviso' : 'erro');
  const temXml = notasOut.some(n => n.xml);
  checks.xml = { nivel: !notasOut.length ? 'pendente' : (notasOut.every(n => n.xml) ? 'ok' : (temXml ? 'aviso' : 'erro')), msg: !notasOut.length ? 'Nenhuma nota associada ainda' : notasOut.every(n => n.xml) ? `${notasOut.length} NF-e com XML${lancada ? ', lançada' : ', ainda não lançada'}` : `${notasOut.filter(n => !n.xml).length} nota(s) sem XML no ERP` };
  const comPedido = pedidosOk.length > 0 || Object.keys(pedPorCod).length > 0;
  const ehCompra = !notasOut.length || notasOut.some(n => !n.movimentacao || n.movimentacao === 'COMPRA');
  const nPrecoPed = contar(['preco_pedido']), nQtdPed = contar(['qtd_pedido']);
  checks.pedido = !ehCompra ? { nivel: 'ok', msg: 'Não é compra (' + [...new Set(notasOut.map(n => n.movimentacao).filter(Boolean))].join(', ') + ')' }
    : comPedido ? { nivel: nPrecoPed ? 'erro' : nivelDe(nQtdPed, true), msg: (nPrecoPed ? `${nPrecoPed} item(ns) com preço acima do pedido` : nQtdPed ? `${nQtdPed} item(ns) com quantidade ≠ pedido` : 'Pedido bate com a nota') + (pedApp.ids.length ? ` · pedido de compra ${pedApp.ids.map(i => '#' + i).join(', ')} (app, preço digitado pelo vendedor)` : '') }
    : { nivel: cfg.exigir_pedido ? 'erro' : 'aviso', msg: 'Nota sem pedido de compra vinculado' };
  const nQtd = contar(['falta', 'sobra', 'nao_bipado', 'nao_na_nota', 'reconferir']);
  checks.coletor = { nivel: !temColetor ? 'pendente' : !temNota ? 'aviso' : nQtd ? 'erro' : nivelDe(contar(['emb']), true),
    msg: !temColetor ? 'Coletor ainda não contou' : !temNota ? `${Object.keys(colPorCod).length} itens contados, nota ainda sem itens pra cruzar` : nQtd ? `${nQtd} item(ns) com diferença de quantidade` : contar(['emb']) ? `${contar(['emb'])} item(ns) contados por embalagem` : `${Object.keys(colPorCod).length} itens contados, tudo bate` };
  const nVal = contar(['vencido', 'validade_curta']);
  checks.validade = { nivel: !temColetor ? 'pendente' : nVal ? 'erro' : nivelDe(contar(['sem_validade', 'validade_padrao']), true), msg: !temColetor ? 'Aguardando coletor' : nVal ? `${nVal} item(ns) com validade curta/vencida` : contar(['validade_padrao']) ? `Mesma data em ${contar(['validade_padrao'])} itens — data padrão digitada?` : contar(['sem_validade']) ? `${contar(['sem_validade'])} item(ns) sem data de validade` : 'Validades OK' };
  const bols = notasOut.flatMap(n => n.boletos.map(b => ({ ...b, nNota: n.nNota })));
  const totXml = r2(notasOut.reduce((s, n) => s + (n.valor_xml || 0), 0));
  const totBol = r2(bols.reduce((s, b) => s + b.valor, 0));
  const primeiro = bols.length ? Math.min(...bols.map(b => b.dias ?? 999)) : null;
  const notasCompra = notasOut.filter(n => !n.movimentacao || n.movimentacao === 'COMPRA');
  const totXmlCompra = r2(notasCompra.reduce((s, n) => s + (n.valor_xml || 0), 0));
  checks.boleto = !bols.length ? { nivel: notasCompra.length && temXml ? 'aviso' : 'ok', msg: notasCompra.length && temXml ? 'XML sem duplicata/boleto (à vista?)' : 'Sem boleto (não é compra)' }
    : Math.abs(totBol - totXmlCompra) > 0.01 && notasCompra.every(n => n.xml) ? { nivel: 'erro', msg: `Boletos ${brl(totBol)} ≠ NF-e ${brl(totXmlCompra)}` }
    : primeiro != null && primeiro < cfg.boleto_min_dias ? { nivel: 'aviso', msg: `1º boleto vence em ${primeiro} dia(s) (${bols.length} parcela(s))` }
    : { nivel: 'ok', msg: `${bols.length} parcela(s), 1ª em ${primeiro} dias` };
  const nMar = contar(['margem_negativa', 'margem_baixa']);
  checks.margem = { nivel: !temNota ? 'pendente' : nMar ? 'erro' : nivelDe(contar(['margem_diverge', 'custo_subiu', 'sem_preco']), true), msg: !temNota ? 'Sem itens da nota' : nMar ? `${nMar} item(ns) com margem negativa/baixa` : contar(['custo_subiu']) ? `${contar(['custo_subiu'])} item(ns) com custo acima da compra anterior` : contar(['margem_diverge']) ? `${contar(['margem_diverge'])} item(ns) com margem abaixo do cadastro` : contar(['sem_preco']) ? `${contar(['sem_preco'])} item(ns) sem preço de venda` : 'Margens OK' };
  const nCad = contar(['sem_cadastro']);
  checks.cadastro = { nivel: nCad ? 'erro' : nivelDe(contar(['desativado']), true), msg: nCad ? `${nCad} código(s) sem cadastro` : contar(['desativado']) ? `${contar(['desativado'])} item(ns) desativado(s)` : 'Cadastro OK' };
  const totLan = r2(notasOut.reduce((s, n) => s + (n.valor_lancado || 0), 0));
  checks.valor = { nivel: !notasOut.length ? 'pendente' : (temXml && notasOut.every(n => n.xml && n.lancada) && Math.abs(totLan - totXml) > 0.01) ? 'erro' : 'ok', msg: notasOut.length ? `NF-e ${brl(totXml)}${notasOut.some(n => n.lancada) ? ' · lançado ' + brl(totLan) : ' · ainda não lançada'}` : '—' };

  // ── veredito automático ──
  const erros = Object.values(checks).filter(c => c.nivel === 'erro').length;
  const avisos = Object.values(checks).filter(c => c.nivel === 'aviso').length;
  const pendentes = Object.values(checks).filter(c => c.nivel === 'pendente').length;
  let situacao;
  if (statusErp === 'cancelado') situacao = 'cancelado';
  else if (decisao && decisao.acao === 'bloqueado') situacao = 'bloqueado';
  else if (decisao && decisao.acao === 'reconferir' && statusErp !== 'liberado') situacao = 'reconferir';
  else if (statusErp === 'liberado' || (decisao && decisao.acao === 'liberado')) situacao = 'liberado';
  else if (statusErp === 'reconferir' || itens.some(i => i.reconferir > 0)) situacao = 'reconferir';
  else if (!temColetor) situacao = 'aguardando_coletor';
  else if (erros > 0) situacao = 'excecao';
  else if (pendentes > 0) situacao = 'em_contagem';
  else situacao = cfg.auto_liberar ? 'pronto' : 'conferido';
  const veredito = erros ? 'divergente' : avisos ? 'atencao' : pendentes ? 'pendente' : 'ok';

  const f = fornec[+conf.CodFornec];
  return {
    nReg: +conf.nReg, loja, loja_nome: LOJAS_NOMES[loja] || ('Loja ' + loja), codFornec: +conf.CodFornec || null, fornecedor: conf.NomeFornec,
    prazo_fornecedor: f ? (f.PrazoDescricao || f.Condicao_Pagto || f.Prazo || null) : null,
    status_erp: statusErp, status_erp_nome: STATUS_NOMES[statusErp] || statusErp, status_erp_cod: +conf.Status,
    entrada: conf.DataEntrada, hora_entrada: conf.HoraEntrada, conferido: conf.DataConferido, hora_conferido: conf.HoraConferido, liberacao: conf.DataLiberacao, hora_liberacao: conf.HoraLiberacao,
    operador_loja: conf.OperadorLoja, operador_central: conf.OperadorCentral, operador_liberacao: conf.OperadorLiberacao && conf.OperadorLiberacao !== '0' ? conf.OperadorLiberacao : null, obs: conf.Obs && conf.Obs !== '0' ? conf.Obs : null,
    notas: notasOut, qtd_notas: notasOut.length, valor_xml: totXml, valor_lancado: totLan, boletos: bols, primeiro_boleto_dias: primeiro, lancada,
    pedidos_compra: pedidosCompraDe(+conf.CodFornec, loja, chavesTodas), obs_compradora: pedidosCompraDe(+conf.CodFornec, loja, chavesTodas).filter(p => p.obs_fiscal).map(p => '#' + p.id + ': ' + p.obs_fiscal).join(' · ') || null,
    pedidos: pedidosOk.map(p => ({ nReg: +p.nReg, nPedido: +p.nPedido || +p.nReg, total: num(p.Total), data: p.DataPedido, entrega: p.DataEntrega, solicitante: p.Solicitante, status: +p.Status })),
    itens, qtd_itens_xml: Object.keys(notaPorCod).length, qtd_itens_coletor: Object.keys(colPorCod).length,
    checks, erros, avisos, pendentes, veredito, situacao, decisao: decisao || null,
    excecoes: itens.flatMap(i => i.flags.filter(fl => fl.nivel === 'erro').map(fl => ({ ean: i.ean, descricao: i.descricao, tipo: fl.tipo, msg: fl.msg })))
  };
}

function fatiar(bruto, conf) {
  const nReg = +conf.nReg;
  const chaves = bruto.chaves.filter(c => +c.nRegConf === nReg);
  const compras = bruto.compras.filter(c => +c.nConferencia === nReg);
  const setNC = new Set(compras.map(c => c.nCompra + '|' + c.nLoja));
  const notaItens = bruto.notaItens.filter(i => setNC.has(i.nCompra + '|' + i.nLoja));
  const setCh = new Set([...chaves.map(c => c.Chave), ...compras.map(c => c.chave)].filter(Boolean));
  const notas = bruto.notas.filter(n => setCh.has(n.Chave));
  const setNota = new Set(notas.map(n => n.nNota + '|' + n.CNPJemit));
  const prods = bruto.prods.filter(p => setNota.has(p.nNota + '|' + p.CNPJemit));
  const boletos = bruto.boletos.filter(b => setCh.has(b.chave));
  const coletor = bruto.coletor.filter(c => String(c.chave) === String(nReg));
  const setNN = new Set(compras.map(c => c.nNota + '|' + c.Serie));
  const pedConf = bruto.pedConf.filter(p => setNN.has(p.nNota + '|' + p.Serie));
  const cadastro = Object.fromEntries(bruto.cadastro.map(k => [String(k.CodigoBarra).trim(), k]));
  return { chaves, notas, prods, boletos, coletor, compras, notaItens, pedConf, pedidos: bruto.pedidos, cadastro, margens: bruto.margens, histVal: bruto.histVal, custoAnt: bruto.custoAnt, custos: bruto.custos, fornec: bruto.fornec };
}

// ── API ────────────────────────────────────────────────────────
// ERP fora do ar não derruba a tela: devolve o que tem (exemplos de teste) + erro_erp pra avisar
async function brutoSeguro(f) { try { return { bruto: await carregarBruto(f), erro: null }; } catch (e) { console.error('[FISCAL] ERP:', e.message); return { bruto: BRUTO_VAZIO(), erro: e.message }; } }
const cacheBruto = new Map();   // chave de|ate|loja → { em, bruto, erro }; 90 s (decisão/config não dependem do bruto, recalcula sempre)
const CACHE_MS = 90 * 1000;
async function brutoCache(f) {
  const k = [f.de, f.ate, f.loja || 0].join('|'); const c = cacheBruto.get(k);
  if (c && Date.now() - c.em < CACHE_MS && !c.erro) return c;
  const r = await brutoSeguro(f); cacheBruto.set(k, { ...r, em: Date.now() });
  if (cacheBruto.size > 40) cacheBruto.delete(cacheBruto.keys().next().value);
  return r;
}
async function listar({ de, ate, loja }) {
  const cfg = getConfig(); const dec = getDecisoes();
  const { bruto, erro } = await brutoCache({ de, ate, loja });
  const lista = bruto.confs.map(c => cruzar(c, fatiar(bruto, c), cfg, dec[c.nReg]));
  for (const t of testesLista(loja)) lista.push(t);
  return { de, ate, loja: loja || null, config: cfg, erro_erp: erro, recebimentos: lista.map(resumo), gerado_em: new Date().toISOString() };
}
function resumo(r) { const { itens, ...resto } = r; return { ...resto, itens_com_flag: itens.filter(i => i.flags.length).length }; }

async function detalhe(nReg) {
  const t = testesLista(null).find(x => x.nReg === +nReg); if (t) return t;
  const cfg = getConfig(); const dec = getDecisoes();
  const [conf] = await qERP(`SELECT c.nReg, c.nLoja, c.CodFornec, c.NomeFornec, c.Status, DATE_FORMAT(c.DataEntrada,'%Y-%m-%d') DataEntrada, c.HoraEntrada,
      DATE_FORMAT(c.DataConferido,'%Y-%m-%d') DataConferido, c.HoraConferido, DATE_FORMAT(c.DataLiberacao,'%Y-%m-%d') DataLiberacao, c.HoraLiberacao,
      c.OperadorLoja, c.OperadorCentral, c.OperadorLiberacao, c.Obs FROM central.conferencia c WHERE c.nReg=?`, [nReg]);
  if (!conf) return null;
  const bruto = await carregarBruto({ de: conf.DataEntrada, ate: conf.DataEntrada, loja: +conf.nLoja });
  const c = bruto.confs.find(x => +x.nReg === +nReg) || conf;
  return cruzar(c, fatiar(bruto, c), cfg, dec[nReg]);
}

// Documentos do dia (aba "Documentos"): movimento fiscal lançado, por loja
async function documentos({ de, ate, loja }) {
  const p = [de, ate]; const fl = loja ? ' AND nLoja=? ' : ''; if (loja) p.push(loja);
  const rows = await qERP(`SELECT nCompra, nNota, Serie, Modelo, nLoja, NomeFornec, CodFornec, TotalNota, Status, nConferencia, NumeroPedido, Movimentacao, Tipo, chave, NomeOperador,
      DATE_FORMAT(DataEmissao,'%Y-%m-%d') emissao, DATE_FORMAT(DataRecto,'%Y-%m-%d') entrada, DATE_FORMAT(DataLan,'%Y-%m-%d') lancamento
    FROM central.compras WHERE DataLan BETWEEN ? AND ? ${fl} ORDER BY nLoja, nCompra`, p);
  return rows.map(r => ({ nCompra: +r.nCompra, nNota: r.nNota, serie: r.Serie, modelo: r.Modelo, loja: +r.nLoja, loja_nome: LOJAS_NOMES[+r.nLoja] || ('Loja ' + r.nLoja), fornecedor: r.NomeFornec, valor: num(r.TotalNota),
    status: r.Status, status_nome: { F: 'Fechado', A: 'Aberto', C: 'Cancelado', E: 'Em digitação' }[r.Status] || r.Status, conferencia: +r.nConferencia || null, pedido: +r.NumeroPedido || null, movimentacao: r.Movimentacao, tipo: r.Tipo, chave: r.chave && r.chave.length >= 40 ? r.chave : null, operador: r.NomeOperador, emissao: r.emissao, entrada: r.entrada, lancamento: r.lancamento }));
}

// Margem dos itens recebidos no período (aba "Margem dos itens", o "Itens Margem" do ERP)
async function margemItens({ de, ate, loja }) {
  const cfg = getConfig(); const dec = getDecisoes();
  const { bruto } = await brutoCache({ de, ate, loja });
  const out = [];
  for (const c of bruto.confs) {
    const r = cruzar(c, fatiar(bruto, c), cfg, dec[c.nReg]);
    for (const i of r.itens) if (i.custo_xml != null) out.push({ nReg: r.nReg, loja: r.loja, loja_nome: r.loja_nome, fornecedor: r.fornecedor, notas: i.notas, ean: i.ean, descricao: i.descricao, custo: i.custo_xml, ultimo_custo: i.ultimo_custo, custo_var_pct: i.custo_var_pct, venda: i.venda, margem: i.margem, margem_cad: i.margem_cad, flags: i.flags.filter(f => /margem|custo/.test(f.tipo)).map(f => f.tipo) });
  }
  for (const t of testesLista(loja)) for (const i of t.itens) if (i.custo_xml != null) out.push({ nReg: t.nReg, loja: t.loja, loja_nome: t.loja_nome, fornecedor: t.fornecedor, notas: i.notas, ean: i.ean, descricao: i.descricao, custo: i.custo_xml, ultimo_custo: i.ultimo_custo, custo_var_pct: i.custo_var_pct, venda: i.venda, margem: i.margem, margem_cad: i.margem_cad, flags: i.flags.filter(f => /margem|custo/.test(f.tipo)).map(f => f.tipo), teste: true });
  return out;
}

async function contatos() {
  const rows = await qERP(`SELECT nReg, nLoja, Nome, Fone FROM central.mensagemreconferir ORDER BY nLoja, nReg`).catch(() => []);
  return rows.map(r => ({ loja: +r.nLoja, nome: r.Nome, fone: String(r.Fone || '').replace(/\D/g, '') }));
}

// Texto de reconferência pro WhatsApp do conferente da loja (só os itens com problema)
function textoReconferencia(r) {
  const linhas = [`*RECONFERIR — Loja ${r.loja} ${r.loja_nome}*`, `Conferência nº ${r.nReg} · ${r.fornecedor}`, r.notas.length ? 'NF-e ' + r.notas.map(n => n.nNota).join(', ') : '', ''];
  const probl = r.itens.filter(i => i.flags.some(f => f.nivel === 'erro'));
  for (const i of probl) linhas.push(`• ${i.descricao} (${i.ean})`, ...i.flags.filter(f => f.nivel === 'erro').map(f => `   ↳ ${f.msg}`));
  if (!probl.length) linhas.push('(sem item com erro — reconferir a nota inteira)');
  linhas.push('', 'Conte de novo no coletor e avise o Fiscal.');
  return linhas.filter(l => l !== null).join('\n');
}

// ── EXEMPLOS DE TESTE ──────────────────────────────────────────
// Recebimentos sintéticos passando pelo MESMO cruzamento do ERP, um por
// cenário, pra Tiago ajustar a tela olhando. Ficam em data/fiscal/testes.json.
function testesLista(loja) {
  const t = lerJson(ARQ_TESTES, null); if (!t) return [];
  const cfg = getConfig(); const dec = getDecisoes();
  return t.filter(x => !loja || +x.conf.nLoja === +loja).map(x => ({ ...cruzar(x.conf, montarPartesTeste(x), cfg, dec[x.conf.nReg]), teste: true }));
}
function montarPartesTeste(x) {
  const cadastro = Object.fromEntries((x.cadastro || []).map(k => [String(k.CodigoBarra), k]));
  return { chaves: x.chaves || [], notas: x.notas || [], prods: x.prods || [], boletos: x.boletos || [], coletor: x.coletor || [], compras: x.compras || [], notaItens: x.notaItens || [], pedConf: x.pedConf || [], pedidos: x.pedidos || [], cadastro, margens: {}, histVal: x.histVal || {}, custoAnt: [], custos: { [x.conf.nLoja]: Object.fromEntries((x.custos || []).map(c => [String(c.CodigoBarra), c])) }, fornec: {} };
}
function criarTestes() {
  const dia = hoje(); const em = (d) => { const x = new Date(dia + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
  const CN = '99999999000199';
  let seq = 9900001; let nNota = 700001; let nCompra = 990001;
  const prodsBase = [
    { ean: '7890000000011', desc: 'TESTE LEITE INTEGRAL 1L', und: 'UN', preco: 4.20, venda: 5.99, emb: 12, validade: 120, custo: 4.10 },
    { ean: '7890000000028', desc: 'TESTE ARROZ TIPO 1 5KG', und: 'UN', preco: 22.50, venda: 27.90, emb: 6, validade: 365, custo: 22.50 },
    { ean: '7890000000035', desc: 'TESTE IOGURTE MORANGO 170G', und: 'UN', preco: 1.90, venda: 2.99, emb: 24, validade: 45, custo: 1.85 },
    { ean: '7890000000042', desc: 'TESTE REFRIGERANTE COLA 2L', und: 'UN', preco: 6.10, venda: 8.49, emb: 6, validade: 180, custo: 6.00 },
    { ean: '7890000000059', desc: 'TESTE SABAO EM PO 1KG', und: 'UN', preco: 9.80, venda: 12.90, emb: 10, validade: 0, custo: 9.80 }
  ];
  function cen({ loja, fornecedor, status, hora, itens, pedido, boletos, semXml, obs, coletorFn, semColetor, precoFn, movimentacao, validadeFn, extraProds, extraColetor, decisao, opLoja, opCentral }) {
    const nReg = seq++; const nn = nNota++; const chave = 'TESTE' + String(nn).padStart(39, '0');
    const prods = (itens || prodsBase).map((p, i) => ({ nNota: nn, CNPJemit: CN, nItem: i + 1, CodigoItemFornec: 'F' + p.ean.slice(-4), CodigoBarras: p.ean, ocEanTrib: p.ean, Descricao: p.desc, Und: p.und, Qtd: p.qtd || 24, ValorUnit: String(precoFn ? precoFn(p, i) : p.preco), ValorTotal: String(r2((p.qtd || 24) * (precoFn ? precoFn(p, i) : p.preco))), oqTrib: String(p.qtd || 24), ouTrib: p.und, ovUnTrib: String(precoFn ? precoFn(p, i) : p.preco), NCM: '00000000', CFOP: '5102' })).concat(extraProds || []);
    const valor = r2(prods.reduce((s, p) => s + num(p.ValorTotal), 0));
    const nCompraAtual = nCompra;
    const notaItens = semXml ? [] : prods.map((p, i) => { const emb = p.Und === 'CX' ? 12 : 1; const qtd = num(p.Qtd); return { nCompra: nCompraAtual, nLoja: loja, Item: i + 1, CodigoBarra: p.CodigoBarras, Unid: p.Und, Qtd: String(qtd), QtdEmb: String(emb), QtdEntradaEstoque: String(qtd * emb), Preco: p.ValorUnit, Custo: String(r2(num(p.ValorUnit) / emb)), PrecoVenda: String((prodsBase.find(b => b.ean === p.CodigoBarras) || {}).venda || 0), Descricao: p.Descricao, Cancelado: 0, ocEanTrib: p.CodigoBarras, NNOTA: String(nn), SERIE: '1', Movimentacao: movimentacao || 'COMPRA', Bonificacao: '0' }; });
    const coletor = semColetor ? [] : (itens || prodsBase).map((p, i) => ({ chave: String(nReg), codigobarra: p.ean, emb: 'UN', qtd: String(coletorFn ? coletorFn(p, i) : (p.qtd || 24)), qtdemb: '1.000', status: 1, Reconferir: 0, DataValidade: validadeFn ? validadeFn(p, i) : (p.validade ? em(Math.round(p.validade * 0.8) + i * 3) : null) })).concat(extraColetor ? extraColetor(nReg) : []);
    const bols = boletos === null ? [] : (boletos || [{ dias: 28 }]).map((b, i) => ({ chave, ndup: i + 1, vencimento: em(b.dias), valor: b.valor != null ? b.valor : r2(valor / (boletos || [1]).length) }));
    const x = {
      conf: { nReg, nLoja: loja, CodFornec: 0, NomeFornec: fornecedor, Status: status, DataEntrada: dia, HoraEntrada: hora, DataConferido: null, HoraConferido: null, DataLiberacao: status === 2 ? dia : null, HoraLiberacao: status === 2 ? '09:40:00' : null, OperadorLoja: opLoja || 'DAYANE', OperadorCentral: opCentral || (status === 2 ? 'SUZYCLEA' : null), OperadorLiberacao: status === 2 ? 'SUZYCLEA' : '0', Obs: obs || '0' },
      chaves: semXml ? [] : [{ nRegConf: nReg, Chave: chave, Obs: '0' }],
      notas: semXml ? [] : [{ nReg: nn, nNota: nn, nSerie: '1', nMod: '55', Data: em(-2), CNPJdest: '', CNPJemit: CN, NomeEmit: fornecedor, ValorNFE: String(valor), ValorProduto: String(valor), Chave: chave, Importado: 1, Status: 0, Leu: 0 }],
      prods: semXml ? [] : prods, boletos: semXml ? [] : bols, coletor, notaItens, histVal: { '7890000000035': { n: 12, media: 40, minimo: 20 } },
      compras: semXml && !obs ? [] : [{ nCompra: nCompra++, nNota: String(nn), Serie: '1', nLoja: loja, NomeFornec: fornecedor, CodFornec: 0, TotalNota: String(valor), Status: 'F', nConferencia: nReg, NumeroPedido: pedido ? 880000 + nReg % 1000 : 0, Movimentacao: movimentacao || 'COMPRA', Tipo: 'PNF', chave: semXml ? '' : chave, DataEmissao: em(-2), DataRecto: dia, DataLan: dia, NomeOperador: 'SUZYCLEA' }],
      pedConf: pedido ? (itens || prodsBase).map((p, i) => ({ nPedido: 880000 + nReg % 1000, nNota: String(nn), Serie: '1', nItem: i + 1, Codigobarras: p.ean, Descricao: p.desc, UndPed: p.und, UndXml: p.und, QtdPed: String(p.qtd || 24), QtdXml: String(p.qtd || 24), PrecoPed: String(pedido.precoFn ? pedido.precoFn(p, i) : p.preco), PrecoXml: String(precoFn ? precoFn(p, i) : p.preco), TotalPed: '0', TotalXml: '0', Diferenca: '0' })) : [],
      pedidos: pedido ? [{ nReg: 880000 + nReg % 1000, nPedido: 880000 + nReg % 1000, nLoja: loja, CodFornec: 0, Nome: fornecedor, Total: valor, Status: 4, DataPedido: em(-6), DataEntrega: dia, Solicitante: 'COMPRADORA TESTE' }] : [],
      cadastro: prodsBase.map(p => ({ CodigoBarra: p.ean, Descricao: p.desc, qtdemb: String(p.emb), Unid: 'UN', TipoBalanca: 'U', Preco: String(p.venda), P1: String(p.venda), P2: String(p.venda), P3: String(p.venda), P4: String(p.venda), P5: String(p.venda), P6: String(p.venda), custo: String(p.custo), UltimoCusto: String(p.custo), margem: String(r2((p.venda - p.custo) / p.venda * 100)), Validade: p.validade, CodDesativado: 0 })),
      custos: prodsBase.map(p => ({ CodigoBarra: p.ean, Custo: String(p.custo), CustoMedio: String(p.custo), UltimaCompra: em(-20) })),
      decisao
    };
    return x;
  }
  const F = n => 'FORNECEDOR TESTE ' + n;
  const lista = [
    // 1. tudo certo, com pedido: o sistema já deixa "pronto p/ liberar" sem ninguém abrir
    cen({ loja: 1, fornecedor: F('A · TUDO OK'), status: 3, hora: '07:12:10', pedido: {}, boletos: [{ dias: 21 }, { dias: 35 }] }),
    // 2. já liberado no ERP (auditoria depois do fato)
    cen({ loja: 1, fornecedor: F('B · JÁ LIBERADO NO ERP'), status: 2, hora: '07:30:44', pedido: {}, boletos: [{ dias: 28 }] }),
    // 3. loja bipou a nota mas o coletor ainda não contou
    cen({ loja: 2, fornecedor: F('C · AGUARDANDO COLETOR'), status: 3, hora: '08:05:00', semColetor: true, opLoja: 'BRUNA' }),
    // 4. falta e sobra na contagem
    cen({ loja: 2, fornecedor: F('D · FALTA E SOBRA'), status: 3, hora: '08:41:15', pedido: {}, coletorFn: (p, i) => i === 0 ? 20 : i === 3 ? 30 : 24, opLoja: 'BRUNA' }),
    // 5. validade curta e item sem validade
    cen({ loja: 3, fornecedor: F('E · VALIDADE CURTA'), status: 3, hora: '09:02:30', pedido: {}, validadeFn: (p, i) => i === 2 ? em(12) : i === 0 ? null : i === 4 ? em(5) : em(150 + i * 40), opLoja: 'MAYRA' }),
    // 6. preço acima do pedido + custo subiu
    cen({ loja: 4, fornecedor: F('F · PREÇO ACIMA DO PEDIDO'), status: 3, hora: '09:20:05', pedido: { precoFn: (p) => p.preco }, precoFn: (p, i) => i === 1 ? r2(p.preco * 1.08) : p.preco, opLoja: 'GABRIELA' }),
    // 7. margem negativa (custo da nota maior que a venda de cadastro)
    cen({ loja: 4, fornecedor: F('G · MARGEM NEGATIVA'), status: 3, hora: '09:48:50', pedido: {}, precoFn: (p, i) => i === 2 ? 3.40 : p.preco, opLoja: 'GABRIELA' }),
    // 8. boletos não fecham com a NF-e e 1º vence em 3 dias
    cen({ loja: 5, fornecedor: F('H · BOLETO DIVERGENTE'), status: 3, hora: '10:15:00', pedido: {}, boletos: [{ dias: 3, valor: 300 }, { dias: 30, valor: 300 }], opLoja: 'FABIANA' }),
    // 9. sem pedido de compra e sem XML (nota manual)
    cen({ loja: 5, fornecedor: F('I · SEM XML E SEM PEDIDO'), status: 3, hora: '10:33:20', semXml: true, obs: 'NOTA MANUAL', opLoja: 'FABIANA' }),
    // 10. código fora do cadastro + nota em caixa (ERP converte 2 CX × 12 = 24 un, coletor conta 24: bate)
    cen({ loja: 6, fornecedor: F('J · SEM CADASTRO E EMBALAGEM'), status: 3, hora: '11:02:00', pedido: {}, itens: [{ ...prodsBase[0], und: 'CX', qtd: 2, preco: 50.40 }, prodsBase[1], prodsBase[4]], extraProds: [{ nNota: 0, CNPJemit: CN, nItem: 9, CodigoItemFornec: 'NOVO1', CodigoBarras: '7890000000999', ocEanTrib: '7890000000999', Descricao: 'TESTE PRODUTO NOVO SEM CADASTRO', Und: 'UN', Qtd: 6, ValorUnit: '3,00', ValorTotal: '18,00', oqTrib: '6', ouTrib: 'UN', ovUnTrib: '3,00', NCM: '00000000', CFOP: '5102' }], coletorFn: (p, i) => i === 0 ? 24 : 24, extraColetor: nReg => [{ chave: String(nReg), codigobarra: '7890000000999', emb: 'UN', qtd: '6', qtdemb: '1.000', status: 1, Reconferir: 0, DataValidade: null }], opLoja: 'ROSINEIDE' }),
    // 11. marcado pra reconferir no coletor
    cen({ loja: 6, fornecedor: F('K · RECONFERIR'), status: 3, hora: '11:25:40', pedido: {}, coletorFn: (p, i) => i === 4 ? 18 : 24, extraColetor: nReg => [{ chave: String(nReg), codigobarra: '7890000000059', emb: 'UN', qtd: '0', qtdemb: '1.000', status: 1, Reconferir: 1, DataValidade: null }], opLoja: 'ROSINEIDE' }),
    // 12. bonificação (não é compra: sem boleto, sem pedido, e tudo bem)
    cen({ loja: 3, fornecedor: F('L · BONIFICAÇÃO'), status: 3, hora: '11:50:00', movimentacao: 'BONIFICACAO', boletos: null, itens: [prodsBase[3]], opLoja: 'MAYRA' })
  ];
  // corrige nNota dos itens extras (foram criados antes de saber o número)
  for (const x of lista) for (const p of x.prods) if (!p.nNota) p.nNota = x.notas[0].nNota;
  gravarJson(ARQ_TESTES, lista);
  return lista.length;
}
function removerTestes() {
  const t = lerJson(ARQ_TESTES, []); const d = getDecisoes();
  for (const x of t) delete d[x.conf.nReg];
  gravarJson(ARQ_DECISOES, d);
  try { fs.unlinkSync(ARQ_TESTES); } catch (e) { /* já não existia */ }
  return t.length;
}
function temTestes() { return fs.existsSync(ARQ_TESTES); }

module.exports = { init, pedidoAppPorCod, flagDecisao, listar, detalhe, documentos, margemItens, contatos, textoReconferencia, decidir, getDecisoes, getConfig, setConfig, criarTestes, removerTestes, temTestes, testesLista, LOJAS, LOJAS_NOMES, STATUS_ERP, STATUS_NOMES, CONFIG_PADRAO, cruzar };
