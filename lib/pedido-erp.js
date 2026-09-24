'use strict';
// Monta, a partir de um pedido aprovado do Radar (lib/pedidos-fornecedor.js), os passos de escrita
// no formato do Dlinks: 1 cabeçalho em central.pedidocompra POR LOJA, itens em pedidocompraproduto
// (nPedido = nReg do cabeçalho) e 1 linha em pedidocompraenvio. Puro: sem banco.
// Colunas copiadas de um pedido real do ERP (nReg 63405, 17/09/26). Status 1 = mesmo do pedido real
// recém-lançado; a confirmação do significado dos status está pendente com o Dlinks.
// Só roda no MySQL de TESTE (.254) via escreverERP.lote. Nunca no .252.

const HOJE = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const n2 = v => Math.round((Number(v) || 0) * 100) / 100;
const digitos = s => String(s || '').replace(/\D/g, '');

/** Itens do pedido do app que vão pra loja `ln` (quantidade em unidades > 0). */
function itensDaLoja(p, ln) {
  return (p.itens || []).map(i => {
    const und = Number(i.lojas_qtd && i.lojas_qtd[ln]) || 0;
    if (und <= 0) return null;
    const preco = i.preco !== null && i.preco !== undefined && i.preco !== '' ? Number(i.preco) : Number(i.ultimo_custo) || 0;
    return { cod: String(i.cod), descricao: String(i.descricao || '').slice(0, 45), unid: String(i.unid || 'UN').slice(0, 5), emb: Math.max(1, parseInt(i.emb, 10) || 1), qtd: und, preco: n2(preco), total: n2(und * preco), ultimo_custo: n2(i.ultimo_custo) };
  }).filter(Boolean);
}

/**
 * montarPassosPedido({ p, ln, fornecedor, usuario, hoje })
 *  p: pedido do app (status aprovado); ln: loja; fornecedor: { CodFornec, Nome, CNPJ, CodPrazo, Celular }
 * → { passos, total, itens } pra escreverERP.lote. Lança se a loja não tem item.
 */
function montarPassosPedido({ p, ln, fornecedor = {}, usuario, hoje = HOJE() }) {
  const itens = itensDaLoja(p, ln);
  if (!itens.length) throw new Error(`pedido #${p.id}: loja ${ln} sem itens com quantidade`);
  const total = n2(itens.reduce((s, i) => s + i.total, 0));
  const whats = digitos(p.vendedor && p.vendedor.whats).slice(0, 15) || digitos(fornecedor.Celular).slice(0, 15) || '0';
  const cab = {
    nLoja: Number(ln), CodFornec: Number(p.codFornec || fornecedor.CodFornec) || 0,
    Nome: String(p.fornecedor || fornecedor.Nome || '').slice(0, 60), CNPJFornec: digitos(fornecedor.CNPJ).slice(0, 15),
    DataLan: hoje, DataPedido: hoje, DataEntrega: hoje, DataSug: hoje, DataAut: hoje,
    Total: total, nPedido: 0, nCotacao: 0, Status: 1, nCompra: 0, CodSolicitante: 0,
    Obs: `Radar #${p.id}`.slice(0, 45), Solicitante: String(p.comprador && p.comprador.nome || usuario || '').slice(0, 45), Descricao: String(p.lista_nome || '').slice(0, 45),
    HoraInicio: '00:00:00', HoraTerminio: '00:00:00', QTDDias: 0, Prazo_Entrega: 0, Est_Seg: 0, Dias_Compras: 0, AceitarSug: 0,
    nCompraAgrupado: '0', Origem: 0, nConsolidado: 0, nLista: Number(p.lista) || 0,
    CodAutorizacao: 0, NomeAutorizacao: String(p.aprovadoPor || usuario || '').slice(0, 45), email: '', whats,
    Vendedor: String(p.vendedor && p.vendedor.nome || '').slice(0, 45), TipoPedido: 0, Observacao: String(p.prazo_pagamento || '0').slice(0, 100),
    CodPrazo: Number(fornecedor.CodPrazo) || 0, RecebidoVendedor: 0, Telefone: '0', NumConsolidacao: 0, Club: 0, nPedidoClub: 0, nCotacaoClub: 0,
    PedidoMinimo: String(p.pedido_minimo || '0').slice(0, 12), OrdemAlf: 0, Bloqueado: 0, usuario: String(usuario || 'ECONOMICO').slice(0, 25),
  };
  const passos = [{ tabela: 'pedidocompra', operacao: 'insert', valores: cab }];
  itens.forEach((i, k) => passos.push({ tabela: 'pedidocompraproduto', operacao: 'insert', valores: {
    CodigoBarra: i.cod, Descricao: i.descricao, Und: i.unid, Emb: i.emb, Qtd: i.qtd, ValorUnit: i.preco, Total: i.total,
    nPedido: { $id: 0 }, nCotacao: 0, Status: 1, nSeq: k + 1, Mvd: 0, Estoque: 0, Transito: 0, nLoja: Number(ln), nCompra: 0, Obs: '',
    nConsolidado: 0, nLista: Number(p.lista) || 0, QtdFaturada: 0, EstoqueSistema: 0, UltimaCompra: 0, UltimoCusto: i.ultimo_custo, TotalUnd: i.qtd,
    QtdVendaUltMes: 0, QtdDiasVenda: 0, MediaVenda: 0, SugSis: 0,
  } }));
  passos.push({ tabela: 'pedidocompraenvio', operacao: 'insert', valores: { nPedido: { $id: 0 }, email: 0, whats: 1 } });
  return { passos, total, itens };
}

function motivoPedido(p, ln) { return `Radar: pedido #${p.id} ${p.fornecedor || ''} → ERP teste, loja ${ln}`.slice(0, 200); }

module.exports = { montarPassosPedido, itensDaLoja, motivoPedido };
