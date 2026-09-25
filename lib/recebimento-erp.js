'use strict';
// Espelha no ERP de TESTE (.254) o recebimento de um pedido do Radar, do jeito que o Dlinks marca
// (visto em pedidos reais do .252, 25/09/26):
//   - pedidocompra.Status = 2 (Recebido: todo item faturado por completo) ou 7 (Recebido Parcialmente),
//     RecebidoVendedor = 1;
//   - pedidocompraproduto.QtdFaturada = quantidade que veio na nota, item a item;
//   - pedidoitensconferidos: 1 linha por item (pedido x nota), números em texto com vírgula ("14,49").
// Puro: recebe a conferência do XML que o app já fez (p.xml.lojas[ln]). Só tabelas existentes.

const br = v => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ',');
const inteiro = v => String(Math.trunc(Number(v) || 0));

function statusRecebimento(xmlLoja, faltas) {
  const itens = (xmlLoja && xmlLoja.itens) || [];
  const parcial = (Number(faltas) || 0) > 0 || itens.some(i => (Number(i.recebida) || 0) < (Number(i.pedida) || 0));
  return parcial ? 7 : 2;
}

/**
 * montarPassosRecebimento({ nRegTeste, xmlLoja, faltas })
 *  nRegTeste: nReg do pedido no ERP teste; xmlLoja: p.xml.lojas[ln] (status, notas[], itens[])
 * → { passos, status, itens } pra escreverERP.lote. Lança se não houver itens conferidos.
 */
function montarPassosRecebimento({ nRegTeste, xmlLoja, faltas = 0 }) {
  const nReg = Number(nRegTeste);
  if (!nReg) throw new Error('pedido sem número no ERP teste');
  const itens = (xmlLoja && xmlLoja.itens) || [];
  if (!itens.length) throw new Error('conferência do XML sem itens');
  const nota = (xmlLoja.notas || [])[0] || {};
  const status = statusRecebimento(xmlLoja, faltas);
  const passos = [
    { tabela: 'pedidocompra', operacao: 'update', where: { nReg }, valores: { Status: status, RecebidoVendedor: 1 } },
  ];
  itens.forEach((i, k) => {
    const pedida = Number(i.pedida) || 0, recebida = Number(i.recebida) || 0;
    const precoPed = Number(i.preco_digitado) || 0, precoXml = Number(i.preco_xml) || precoPed;
    const totalPed = pedida * precoPed, totalXml = recebida * precoXml;
    passos.push({ tabela: 'pedidocompraproduto', operacao: 'update', where: { nPedido: nReg, CodigoBarra: String(i.cod) }, valores: { QtdFaturada: recebida } });
    passos.push({ tabela: 'pedidoitensconferidos', operacao: 'insert', valores: {
      nPedido: nReg, nNota: String(nota.nNota || ''), Serie: String(nota.serie || '1').slice(0, 5), nItem: k + 1,
      Codigobarras: String(i.cod).slice(0, 15), Descricao: String(i.descricao || '').slice(0, 45),
      UndPed: 'UN', UndXml: String((i.xml && i.xml[0] && i.xml[0].und) || 'UN').slice(0, 5),
      QtdPed: inteiro(pedida), QtdXml: inteiro(recebida), PrecoPed: br(precoPed), PrecoXml: br(precoXml),
      TotalPed: br(totalPed), TotalXml: br(totalXml), Diferenca: br(totalPed - totalXml),
    } });
  });
  return { passos, status, itens: itens.length, nNota: nota.nNota || null };
}

function motivoRecebimento(p, ln, nNota) { return `Radar: recebimento do pedido #${p.id} ${p.fornecedor || ''} → ERP teste, loja ${ln}${nNota ? ', NF ' + nNota : ''}`.slice(0, 200); }

module.exports = { montarPassosRecebimento, statusRecebimento, motivoRecebimento, br };
