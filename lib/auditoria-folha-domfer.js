'use strict';
// lib/auditoria-folha-domfer.js — Auditoria da Folha › bloco 4 "Domingos, Feriados e Pagamentos Extraordinários" (04/11/2026, Fases A e B).
// SIMULAÇÃO SOMENTE LEITURA: cruza o que já existe (relatórios de Pagamentos Dom/Feriados, termos de escala e os lotes SISPAG que a
// conciliação da competência deixou como "não identificado") e SUGERE classificação e conciliação. Nada aqui grava, altera folha, termos,
// pagamentos ou classificações reais; nenhuma sugestão é confirmada sozinha. O motor real (Fases C e D) só entra com aprovação da Coordenação.
const A = require('./auditoria-folha');
const PG = require('./pagamentos-df');
const T = require('./termos-escala');
const GP = require('./gestao-pessoas');

const r2 = n => Math.round((+n || 0) * 100) / 100;
const erro = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });
const CONTA_LOJA = { cahu: 1, muribeca: 2, ponte: 3, atacarejo: 4, portalarga: 5, jardimjordao: 6 };
const fimMes = c => { const [y, m] = c.split('-').map(Number); return c + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0'); };

// classificações da seção 7 (sugestões); situações de item e de lote
const CLASSE_TXT = { adiantamento: 'Adiantamento salarial', folha: 'Folha mensal', domingo: 'Domingo trabalhado', feriado: 'Feriado trabalhado', diarista: 'Pagamento de diarista', extraordinario: 'Pagamento extraordinário', rescisao: 'Pagamento de rescisão', outro: 'Outro pagamento trabalhista', nao_identificado: 'Não identificado' };
const SIT_ITEM_TXT = { conciliado_individual: 'Conciliado individualmente', conciliado_lote: 'Pago em lote (sem detalhe individual)', aguardando_pagamento: 'Aguardando pagamento', sem_relatorio: 'Sem relatório de pagamento', divergente: 'Com divergência' };
const SIT_LOTE_TXT = { individual: 'Lote conciliado individualmente', financeiro: 'Lote conciliado financeiramente', divergente: 'Lote com divergência', ambiguo: 'Mais de um candidato (conferência manual)', sem_candidato: 'Sem registro autorizado correspondente', folha_provavel: 'Provável folha mensal (documento não importado)' };
// tipos de divergência da seção 10
const DIV_TXT = { funcionario_sem_pagamento: 'Funcionário sem pagamento identificado', pagamento_sem_termo: 'Pagamento sem termo autorizado', valor_inferior: 'Valor pago inferior ao autorizado', valor_superior: 'Valor pago superior ao autorizado', pagamento_duplicado: 'Pagamento duplicado', beneficiario_incompativel: 'Beneficiário incompatível', cpf_divergente: 'CPF divergente', pagamento_rejeitado: 'Pagamento rejeitado', pagamento_devolvido: 'Pagamento devolvido', lote_sem_detalhe: 'Lote sem detalhamento individual', pagamento_nao_classificado: 'Pagamento não classificado', sem_valor_previsto: 'Registro de trabalho sem valor previsto', unidade_divergente: 'Divergência de unidade ou CNPJ' };

const totalItem = i => r2((+i.valorTrabalho || 0) + (i.passagem && i.passagem.aplica ? (+i.passagem.valor || 0) : 0));
function termoDe(i) { if (i.termo && i.termo.id) return { id: i.termo.id, em: i.termo.em, origem: 'relatorio' }; const t = T.termosPorData(i.data).get(String(i.funcId)); return t ? { id: t.id, em: t.em, origem: 'emissoes' } : null; }

/** relatórios da competência: data trabalhada no mês OU pagamento previsto no mês (o trabalho de 01/11 pago em 03/11 é de novembro) */
function relatoriosDaComp(c) {
  const ini = c + '-01', fim = fimMes(c);
  return PG._interno.relatorios().filter(r => r.status !== 'cancelado' && (r.datas.some(d => d >= ini && d <= fim) || (r.previsaoPagamento && r.previsaoPagamento.data >= ini && r.previsaoPagamento.data <= fim)));
}
// o mesmo débito aparece com índice diferente em cada módulo (conta|data|valor|n): a chave do lote ignora o índice
const chaveLote = ref => String(ref || '').split('|').slice(0, 3).join('|');
function situacaoItem(i, r) {
  const p = i.pagamento || {}; const div = [];
  if (!i.termo && !termoDe(i)) div.push('pagamento_sem_termo'); if (i.valorTrabalho == null) div.push('sem_valor_previsto'); if ((i.divergencias || []).includes('duplicado')) div.push('pagamento_duplicado');
  if (p.status === 'falha') div.push('pagamento_rejeitado');
  let sit;
  if (p.status === 'pago') sit = p.comprovante || (p.origem === 'comprovante') ? 'conciliado_individual' : 'conciliado_lote';   // lote único = evidência só do total
  else if (PG.FIN_STATUS.includes(r.status)) sit = 'aguardando_pagamento'; else sit = 'aguardando_pagamento';
  if (div.length) sit = 'divergente';
  return { sit, div };
}
/** combinações de até 3 relatórios da mesma loja, com datas anteriores ao débito, cuja quantidade de pessoas bate com o lote */
function candidatosDoLote(lote, rels) {
  const el = rels.filter(r => r.lojas.includes(lote.loja) && r.datas.every(d => d <= lote.data) && r.status !== 'cancelado').map(r => { const sel = r.itens.filter(i => i.selecionado); return { id: r.id, datas: r.datas, n: sel.length, total: r2(sel.reduce((a, i) => a + totalItem(i), 0)), pagos: sel.filter(i => i.pagamento && i.pagamento.status === 'pago').length, ref: [...new Set(sel.map(i => i.pagamento && i.pagamento.extratoRef).filter(Boolean))] }; });
  const out = [];
  for (let m = 1; m < (1 << el.length); m++) { const comb = el.filter((_, k) => (m >> k) & 1); if (comb.length > 3) continue; const n = comb.reduce((a, x) => a + x.n, 0); if (n !== lote.lancamentos) continue; const total = r2(comb.reduce((a, x) => a + x.total, 0)); out.push({ relatorios: comb.map(x => x.id), datas: [...new Set(comb.flatMap(x => x.datas))].sort(), n, total, diferenca: r2(lote.valor - total), jaCasado: comb.every(x => x.ref.some(rf => chaveLote(rf) === chaveLote(lote.ref))) }); }
  return out.sort((a, b) => Math.abs(a.diferenca) - Math.abs(b.diferenca));
}
function classificarLote(lote, cands, r, nAdiant) {
  const exatos = cands.filter(c => Math.abs(c.diferenca) < 0.005);
  if (cands.some(c => c.jaCasado)) return { sit: 'financeiro', nota: 'A conciliação de Pagamentos Dom/Feriados já marcou este lote como pago (lote único). Falta o detalhe individual: comprovante SISPAG ou retorno do banco.' };
  if (exatos.length === 1) return { sit: 'financeiro', nota: 'Quantidade e valor batem com ' + exatos[0].relatorios.join(' + ') + '. Sugestão: pagamento de domingos/feriados. Confirmar antes de usar.' };
  if (exatos.length > 1) return { sit: 'ambiguo', nota: exatos.length + ' combinações fecham valor e quantidade. Não há como escolher sem o detalhe do lote.' };
  if (cands.length) return { sit: 'divergente', nota: 'A quantidade bate com ' + cands[0].relatorios.join(' + ') + ', mas o valor difere ' + cands[0].diferenca.toFixed(2).replace('.', ',') + '. Pode ser tabela de valores diferente da paga.' };
  if (nAdiant && Math.abs(lote.lancamentos - nAdiant) <= 1 && !(r.documentos.folha && r.documentos.folha.lojas && r.documentos.folha.lojas[lote.loja])) return { sit: 'folha_provavel', nota: 'Mesma quantidade de pessoas do adiantamento da unidade e o documento da folha mensal não foi importado. Importar a folha antes de classificar.' };
  return { sit: 'sem_candidato', nota: 'Nenhum relatório de domingos/feriados aprovado cobre datas anteriores a este débito. Pode ser diarista, extraordinário ou pagamento sem registro: pedir o detalhe ao Financeiro.' };
}

function simular(c, user) {
  const p = A.perm(user); if (!p.ver) throw erro('Sem acesso à Auditoria da Folha', 403);
  const r = A.obterRaw(c); const conc = r.conciliacao; const rels = relatoriosDaComp(c);
  const lojasVis = GP.LOJAS;   // quem vê a Auditoria (Coordenação, Financeiro, RH, Diretoria) vê todas as unidades, como nas outras abas
  // itens: um por funcionário × data trabalhada (registro único financeiro = o item do relatório de Pagamentos Dom/Feriados)
  const itens = [];
  for (const rel of rels) for (const i of rel.itens) {
    if (!i.selecionado || !lojasVis.includes(+i.loja)) continue; const { sit, div } = situacaoItem(i, rel); const termo = termoDe(i); const pg = i.pagamento || {};
    itens.push({ protocolo: rel.id + '/' + i.key, relatorio: rel.id, relatorioStatus: rel.status, relatorioStatusTxt: PG.STATUS_TXT[rel.status] || rel.status, funcId: i.funcId, nome: i.nome, cpf: i.cpf_fim || '', loja: +i.loja, lojaTxt: i.lojaTxt, cargo: i.cargo, data: i.data, tipo: i.tipo, tipoTxt: i.tipo === 'feriado' ? 'Feriado' + (i.nomeFeriado && i.nomeFeriado !== 'Feriado' ? ' · ' + i.nomeFeriado : '') : 'Domingo', nomeFeriado: i.nomeFeriado || null,
      termo, valorTrabalho: i.valorTrabalho, passagem: i.passagem && i.passagem.aplica ? +i.passagem.valor : 0, total: totalItem(i), origemValor: i.origemValor, funcaoTabela: i.funcaoTabela, ponto: i.ponto ? { situacao: i.ponto.situacao, marcacoes: i.ponto.marcacoes } : null,
      pago: pg.status === 'pago' ? totalItem(i) : 0, pagamentoStatus: pg.status || 'pendente', pagamentoStatusTxt: PG.PAG_TXT[pg.status] || pg.status, dataPagamento: pg.data || null, lote: pg.extratoRef || null, transacao: pg.transacao || null, comprovante: pg.comprovante || null,
      classe: i.tipo, classeTxt: CLASSE_TXT[i.tipo], situacao: sit, situacaoTxt: SIT_ITEM_TXT[sit], divergencias: div.map(d => ({ tipo: d, txt: DIV_TXT[d] })), divergenciasRel: (i.divergencias || []).map(d => PG.DIV_TXT[d] || d), justificativa: i.justificativa || null });
  }
  // lotes: os que a conciliação deixou "não identificado" + os já casados por Pagamentos Dom/Feriados (mesmo lançamento, visões diferentes)
  const nAdiantPorLoja = {}; for (const f of r.funcionarios) if (f.adiantamento) nAdiantPorLoja[f.loja] = (nAdiantPorLoja[f.loja] || 0) + 1;
  const mapa = new Map();
  for (const s of r.naoIdentificados) if (s.lote && lojasVis.includes(+s.loja)) mapa.set(chaveLote(s.ref), { ref: s.ref, loja: +s.loja, lojaTxt: s.lojaTxt, conta: s.conta, data: s.data, valor: r2(s.valor), lancamentos: s.lancamentosNoLote || null, historico: s.historico, origem: 'nao_identificado', divergencia: (r.divergencias.find(d => d.chave === 'nao_identificado|' + s.ref) || {}).protocolo || null });
  for (const i of itens) if (i.lote && mapa.has(chaveLote(i.lote))) { const m = mapa.get(chaveLote(i.lote)); m.origem = 'ambos'; m.refPg = i.lote; }
  for (const i of itens) if (i.lote && !mapa.has(chaveLote(i.lote))) { const [conta, data, valor] = i.lote.split('|'); mapa.set(chaveLote(i.lote), { ref: i.lote, loja: CONTA_LOJA[conta] || i.loja, lojaTxt: GP.LOJA_TXT[CONTA_LOJA[conta] || i.loja], conta, data, valor: r2(+valor), lancamentos: itens.filter(x => chaveLote(x.lote) === chaveLote(i.lote)).length, historico: i.transacao || 'SISPAG SALARIOS', origem: 'pagamentos_df', divergencia: null }); }
  for (const i of itens) if (i.lote) i.loteChave = chaveLote(i.lote);
  const lotes = [...mapa.values()].sort((a, b) => a.data.localeCompare(b.data)).map(l => {
    const cands = candidatosDoLote(l, rels); const cl = classificarLote(l, cands, r, nAdiantPorLoja[l.loja]); const itensDoLote = itens.filter(i => chaveLote(i.lote) === chaveLote(l.ref));
    const classe = cl.sit === 'financeiro' || cl.sit === 'divergente' || cl.sit === 'ambiguo' ? 'domingo_feriado' : cl.sit === 'folha_provavel' ? 'folha' : 'nao_identificado';
    return { ...l, chave: chaveLote(l.ref), situacao: cl.sit, situacaoTxt: SIT_LOTE_TXT[cl.sit], nota: cl.nota, classeSugerida: classe, classeSugeridaTxt: classe === 'domingo_feriado' ? 'Domingos / feriados' : CLASSE_TXT[classe], candidatos: cands.slice(0, 6), itens: itensDoLote.length, detalheIndividual: itensDoLote.some(i => i.comprovante), diferencas: cands[0] && Math.abs(cands[0].diferenca) >= 0.005 ? [{ tipo: cands[0].diferenca > 0 ? 'valor_superior' : 'valor_inferior', txt: DIV_TXT[cands[0].diferenca > 0 ? 'valor_superior' : 'valor_inferior'], valor: cands[0].diferenca }] : [] };
  });
  // bloco 4 e indicadores (seções 2 e 12): individual só com evidência por pessoa; financeiro = total do lote bate
  const autorizado = r2(itens.reduce((a, i) => a + i.total, 0));
  const identificado = r2(lotes.filter(l => ['financeiro', 'individual'].includes(l.situacao)).reduce((a, l) => a + l.valor, 0));
  const indiv = r2(itens.filter(i => i.situacao === 'conciliado_individual').reduce((a, i) => a + i.total, 0));
  const aguardando = r2(lotes.filter(l => l.situacao === 'financeiro' && !l.detalheIndividual).reduce((a, l) => a + l.valor, 0));
  const difer = r2(lotes.reduce((a, l) => a + l.diferencas.reduce((b, d) => b + Math.abs(d.valor), 0), 0));
  const divItens = itens.filter(i => i.divergencias.length); const divLotes = lotes.filter(l => !['financeiro', 'individual'].includes(l.situacao));
  const pendentes = itens.filter(i => i.situacao !== 'conciliado_individual').length;
  const atualizado = [conc && conc.em, ...rels.map(x => x.conciliacao && x.conciliacao.em)].filter(Boolean).sort().pop() || null;
  const porLoja = {}; for (const i of itens) { const L = porLoja[i.loja] || (porLoja[i.loja] = { loja: i.loja, lojaTxt: i.lojaTxt, itens: 0, autorizado: 0, pagoLote: 0, individual: 0 }); L.itens++; L.autorizado = r2(L.autorizado + i.total); if (i.situacao === 'conciliado_lote') L.pagoLote = r2(L.pagoLote + i.total); if (i.situacao === 'conciliado_individual') L.individual = r2(L.individual + i.total); }
  const porTipo = {}; for (const i of itens) { const Tt = porTipo[i.tipo] || (porTipo[i.tipo] = { tipo: i.tipo, txt: CLASSE_TXT[i.tipo], itens: 0, autorizado: 0 }); Tt.itens++; Tt.autorizado = r2(Tt.autorizado + i.total); }
  return {
    competencia: c, somenteLeitura: true, atualizadoEm: atualizado, relatorios: rels.map(x => ({ id: x.id, status: x.status, statusTxt: PG.STATUS_TXT[x.status] || x.status, lojas: x.lojas, datas: x.datas, previsao: x.previsaoPagamento && x.previsaoPagamento.data })),
    bloco: { autorizado, identificado, conciliadoIndividual: indiv, aguardandoDetalhamento: aguardando, diferencas: difer, funcionarios: new Set(itens.map(i => i.funcId)).size, itens: itens.length, pendentes, atualizadoEm: atualizado },
    indicadores: { pctFinanceiro: autorizado ? Math.round(r2(itens.filter(i => ['conciliado_lote', 'conciliado_individual'].includes(i.situacao)).reduce((a, i) => a + i.total, 0)) / autorizado * 1000) / 10 : 0, pctIndividual: itens.length ? Math.round(itens.filter(i => i.situacao === 'conciliado_individual').length / itens.length * 1000) / 10 : 0, lotesPendentes: lotes.filter(l => l.situacao !== 'individual').length, divergencias: divItens.length + divLotes.length, divergenciasValor: r2(difer + divItens.reduce((a, i) => a + i.total, 0)) },
    porLoja: Object.values(porLoja), porTipo: Object.values(porTipo), itens, lotes,
    textos: { classes: CLASSE_TXT, sitItem: SIT_ITEM_TXT, sitLote: SIT_LOTE_TXT, divergencias: DIV_TXT },
  };
}
module.exports = { simular, CLASSE_TXT, SIT_ITEM_TXT, SIT_LOTE_TXT, DIV_TXT, _interno: { candidatosDoLote, classificarLote, relatoriosDaComp } };
