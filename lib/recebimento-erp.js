'use strict';
// Monta, a partir de uma conferência de recebimento do coletor (Econômico), os passos de escrita
// no formato do Dlinks: central.conferencia (cabeçalho por loja/fornecedor), conferenciachave
// (NF-e vinculada por $id), conferenciaitens (1 linha por código de barra, insert na 1ª bipagem e
// update depois) e conferenciadevolucao (1 linha por item devolvido na liberação). Puro: sem banco.
// Só roda no MySQL de TESTE (.254) via escreverERP.lote. Nunca no .252.

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
  const chave = { nRegConf: { $id: 0 }, Chave: cortar(c.chave, 45), Obs: 'Economico', Backup: 0 };
  return {
    motivo: `Coletor Econômico ${c.id} · abrir`,
    passos: [
      { tabela: 'conferencia', operacao: 'insert', valores: conferencia },
      { tabela: 'conferenciachave', operacao: 'insert', valores: chave },
    ],
  };
}

/** { passos }: insere conferenciaitens na 1ª bipagem do código, senão atualiza a linha existente. */
function passosItem(c, item, nReg) {
  const chave = String(nReg);
  const codigobarra = String(item.cod);
  const valores = {
    chave, codigobarra, emb: Number(item.emb) === 1 ? 'UN' : 'CX',
    qtd: item.quant, qtdemb: item.emb, status: 1, Reconferir: 0, Name: '0', Backup: 0,
    DataValidade: item.validade || '00/00/0000',
  };
  const passo = item.bipagens === 1
    ? { tabela: 'conferenciaitens', operacao: 'insert', valores }
    : { tabela: 'conferenciaitens', operacao: 'update', where: { chave, codigobarra }, valores };
  return { motivo: `Coletor Econômico ${c.id} · item ${codigobarra}`, passos: [passo] };
}

/** { passos }: atualiza Status da conferência (+ DataConferido/HoraConferido quando status 3). */
function passosStatus(c, nReg, status, { nome, dataHora = new Date() } = {}) {
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
    valores: { nConf: nReg, CodigoBarra: cortar(d.cod, 15), Qtd: d.qtd, Backup: 0 },
  }));
  return { motivo: `Coletor Econômico ${c.id} · liberar`, passos };
}

module.exports = { passosAbrir, passosItem, passosStatus, passosLiberar, ymd, hms, cortar };
