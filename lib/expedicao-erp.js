// lib/expedicao-erp.js — espelho da conferência de saída do CD no ERP de TESTE (.254), no formato que o
// Dlinks usa em central.conferencia_televendas (uma linha por código × lote: Qtd em caixas, QtdEmb).
// Só é chamado quando a conferência fecha 100 %. Nunca toca painel_televendas nem o .252.
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const cortar = (s, n) => String(s == null ? '' : s).slice(0, n);

/** { motivo, passos } pra escreverERP.lote. Lança se a conferência não estiver fechada ou sem itens. */
function passosFechar(c, { dataHora = new Date() } = {}) {
  if (!c || c.status !== 'fechada') throw new Error('Só espelha conferência fechada 100 %');
  const passos = [];
  for (const it of Object.values(c.itens || {})) {
    const lotes = (it.lotes && it.lotes.length) ? it.lotes : [{ lote: '', quant: it.quant, un: it.un }];
    for (const l of lotes) passos.push({ tabela: 'conferencia_televendas', operacao: 'insert', valores: {
      nLoja: 10, nPedido: Number(c.nPedido), Codigobarra: cortar(it.cod, 18), Qtd: Number(l.quant), QtdEmb: Number(it.emb) || 1, Data: ymd(dataHora), Status_Conferencia: 1,
    } });
  }
  if (!passos.length) throw new Error('Conferência sem itens');
  return { motivo: `Coletor Econômico expedição ${c.id} · pedido ${c.nPedido} fechado 100 % (${passos.length} linha(s), lote no Econômico)`, passos };
}

module.exports = { passosFechar, ymd, cortar };
