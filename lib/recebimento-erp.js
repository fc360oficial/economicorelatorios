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


// ── Coletor de Recebimento (conferência cega do celular da loja) ─────────────
// Restaurado em 25/09/2026: estas 4 funções são as que lib/recebimento-rotas.js usa desde o
// commit 649a130 e sumiram quando este arquivo foi reescrito pro recebimento do Radar — sem
// elas toda rota do coletor quebra ("recebErp.passosAbrir is not a function"). As duas coisas
// convivem no mesmo módulo: montarPassosRecebimento* é do pedido, passos* é da conferência.
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hms = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
const cortar = (s, n) => String(s == null ? '' : s).slice(0, n);

/** { passos } pra escreverERP.lote: insere conferencia (cabeçalho) + conferenciachave (NF-e). */
function passosAbrir(c, { dataHora = new Date() } = {}) {
  const conferencia = {
    nLoja: Number(c.loja) || 0, CodFornec: Number(c.codFornec) || 0, NomeFornec: cortar(c.fornecedor, 45),
    Status: 1, DataEntrada: ymd(dataHora), HoraEntrada: hms(dataHora),
    OperadorLoja: cortar(c.nome, 20), OperadorLiberacao: '0',
    Beep: 1, Aviso: 0, Aviso2: 0, Backup: 0, Obs: cortar('Economico ' + c.id, 200),
  };
  const chave = { nRegConf: { $id: 0 }, Chave: cortar(c.chave, 44), Obs: 'Economico', Backup: 0 };
  return {
    motivo: `Coletor Econômico ${c.id} · abrir`,
    passos: [
      { tabela: 'conferencia', operacao: 'insert', valores: conferencia },
      { tabela: 'conferenciachave', operacao: 'insert', valores: chave },
    ],
  };
}

/** { passos }: insere conferenciaitens na 1a vez que o item chega no ERP, senão atualiza a linha.
 * INSERT x UPDATE sai de `item.espelhado` (gravado pelo espelho quando o ERP aceita), e NÃO de
 * `item.bipagens`: `corrigir` zera bipagens (viraria um 2o INSERT na mesma PK = ER_DUP_ENTRY) e
 * um item enfileirado por falta de nReg pode chegar ao ERP só na 2a bipagem (UPDATE em linha que
 * nunca foi criada = 0 linhas, "ok" silencioso). */
function passosItem(c, item, nReg) {
  const chave = String(nReg);
  const codigobarra = cortar(item.cod, 14);
  const valores = {
    chave, codigobarra, emb: cortar(item.emb_label || (Number(item.emb) === 1 ? 'UN' : 'CX'), 4),
    qtd: Number(item.quant), qtdemb: Number(item.emb), status: 1, Reconferir: 0, Name: '0', Backup: 0,
    DataValidade: item.validade || null,   // coluna DATE: sem validade é NULL, nunca '00/00/0000'
  };
  const passo = item.espelhado
    ? { tabela: 'conferenciaitens', operacao: 'update', where: { chave, codigobarra }, valores }
    : { tabela: 'conferenciaitens', operacao: 'insert', valores };
  return { motivo: `Coletor Econômico ${c.id} · item ${codigobarra}`, passos: [passo] };
}

/** { passos }: atualiza Status da conferência (+ DataConferido/HoraConferido quando status 3). */
function passosStatus(c, nReg, status, { dataHora = new Date() } = {}) {
  const valores = { Status: status };
  if (status === 3) { valores.DataConferido = ymd(dataHora); valores.HoraConferido = hms(dataHora); }
  return {
    motivo: `Coletor Econômico ${c.id} · status ${status}`,
    passos: [{ tabela: 'conferencia', operacao: 'update', where: { nReg }, valores }],
  };
}

/** { passos }: libera a conferência (Status 2) + 1 insert em conferenciadevolucao por devolução. */
function passosLiberar(c, nReg, { nome, dataHora = new Date() } = {}) {
  const passos = [{
    tabela: 'conferencia', operacao: 'update', where: { nReg },
    valores: {
      Status: 2, DataLiberacao: ymd(dataHora), HoraLiberacao: hms(dataHora),
      OperadorCentral: cortar(nome, 20), OperadorLiberacao: cortar(nome, 45),
    },
  }];
  (c.devolucoes || []).forEach(d => passos.push({
    tabela: 'conferenciadevolucao', operacao: 'insert',
    valores: { nConf: Number(nReg), CodigoBarra: cortar(d.cod, 15), Qtd: Number(d.qtd), Backup: 0 },
  }));
  return { motivo: `Coletor Econômico ${c.id} · liberar`, passos };
}

module.exports = { montarPassosRecebimento, statusRecebimento, motivoRecebimento, br,
  passosAbrir, passosItem, passosStatus, passosLiberar, ymd, hms, cortar };
