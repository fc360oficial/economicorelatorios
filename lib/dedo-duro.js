// Dedo Duro (Operação > Dedo Duro, 21/09/2026, pedido do Tiago): as 28 checagens de auditoria do relatório
// "152 - Dedo Duro" do WinThor, mapeadas pras tabelas do ERP do Econômico. Mesma numeração do WinThor pra ele
// reconhecer. Cada checagem tem `aplica`: as que dependem de coisa que o ERP não tem (RCA/vendedor externo,
// contas a receber, conta corrente, acerto de caixa de motorista) ficam listadas com o motivo.
// SOMENTE LEITURA no ERP. Fontes: central.logpreco2 (log de preço), logcusto2 (log de custo), estoque_ajuste,
// solicitacaopreco, bonificacao_averbacao, itens/custoloja{n}/estoquen{n}/itens_margens (cadastro),
// ln{loja}mes{MM}.zcupomitens (cupons, bancos mensais rotativos ~12 m), loja20045.contasapagar(+baixaconta).
'use strict';

const LOJAS = [1, 2, 3, 4, 5, 6];
const NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
const iso = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`; return String(v).slice(0, 10); };
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
let deps = null;
function init(d) { deps = d; }

// meses (bancos ln{loja}mes{MM}) que cobrem o período; os bancos são rotativos (~12 meses), então o período é
// limitado aos últimos 12 meses
function mesesEntre(de, ate) {
  const a = new Date(de + 'T00:00:00'), b = new Date(ate + 'T00:00:00'), out = [];
  const d = new Date(a.getFullYear(), a.getMonth(), 1);
  while (d <= b) {
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const dIni = new Date(Math.max(d, a)), dFim = new Date(Math.min(new Date(y, m, 0), b));
    out.push({ mm: String(m).padStart(2, '0'), dIni: iso(dIni), dFim: iso(dFim) });
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}
const lojasDe = loja => loja ? [+loja] : LOJAS;

// cupons: roda uma query por loja × mês e junta
async function cupons(ctx, sqlFn, paramsFn) {
  const out = [];
  for (const ln of lojasDe(ctx.loja)) for (const ms of mesesEntre(ctx.de, ctx.ate)) {
    const rows = await deps.q(sqlFn(ln, ms), paramsFn(ln, ms)).catch(e => { if (!/doesn't exist|Unknown database/i.test(e.message)) console.error('[DEDO-DURO] cupons', ln, ms.mm, e.message); return []; });
    for (const r of rows) out.push({ loja: ln, ...r });
  }
  return out;
}

// cadastro (snapshot atual), com cache de 10 min: itens ativos + custo/estoque/margem por loja
let _cad = null, _cadTs = 0;
async function cadastro() {
  if (_cad && Date.now() - _cadTs < 10 * 60 * 1000) return _cad;
  const q = deps.q;
  const itens = await q(`SELECT i.CodigoBarra cod, TRIM(i.Descricao) descricao, i.P1, i.P2, i.P3, i.P4, i.P5, i.P6, TRIM(g.Descricao) grupo
                         FROM central.itens i LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
                         WHERE i.CodDesativado = 0 AND i.CodigoBarra IS NOT NULL`);
  const custo = {}, est = {}, marg = {};
  for (const ln of LOJAS) {
    custo[ln] = {}; est[ln] = {}; marg[ln] = {};
    for (const r of await q(`SELECT CodigoBarra cod, Custo c FROM central.custoloja${ln}`).catch(() => [])) custo[ln][r.cod] = num(r.c);
    for (const r of await q(`SELECT CodigoBarra cod, Qtd e FROM central.estoquen${ln}`).catch(() => [])) est[ln][r.cod] = num(r.e);
    for (const r of await q(`SELECT CodigoBarra cod, MargemVarejo m FROM central.itens_margens WHERE nLoja=?`, [ln]).catch(() => [])) marg[ln][r.cod] = r.m != null ? +r.m : null;
  }
  _cad = { itens, custo, est, marg }; _cadTs = Date.now();
  return _cad;
}
async function custosDe(ln, cods) {
  const o = {};
  for (const ch of chunk([...new Set(cods)], 2000)) for (const r of await deps.q(`SELECT CodigoBarra cod, Custo c FROM central.custoloja${ln} WHERE CodigoBarra IN (${ch.map(() => '?').join(',')})`, ch).catch(() => [])) o[r.cod] = num(r.c);
  return o;
}
const pctQueda = (a, b) => a > 0 ? r1((b / a - 1) * 100) : null;
const margem = (p, c) => p > 0 && c > 0 ? r1((p - c) / p * 100) : null;
const markup = (p, c) => p > 0 && c > 0 ? r1((p - c) / c * 100) : null;

// ── as 28 checagens ────────────────────────────────────────────────────────────────────────────────────────
// colunas: { k, t (título), tipo: 'n' | 'r$' | '%' | 'd' (data) | 'txt' }
const C = (k, t, tipo) => ({ k, t, tipo: tipo || 'txt' });
const CHECKS = [
  { n: 1, titulo: 'Cupons cancelados no PDV', desc: 'Itens cancelados no caixa (IndCancel = S nos cupons), por cupom (CCF), PDV e operador. Cupom com muitos itens cancelados ou valor alto merece olhar.',
    aplica: true, periodo: true, fonte: 'ln{loja}mes{MM}.zcupomitens',
    colunas: [C('loja', 'Loja'), C('data', 'Data', 'd'), C('pdv', 'PDV', 'n'), C('cupom', 'Cupom', 'n'), C('operador', 'Operador'), C('itens', 'Itens canc.', 'n'), C('valor', 'Valor cancelado', 'r$')],
    run: async ctx => (await cupons(ctx, (ln, ms) => `SELECT Data, nECF pdv, CCF cupom, Operador operador, COUNT(*) itens, SUM(ValorTotalNovo) valor FROM \`ln${ln}mes${ms.mm}\`.zcupomitens WHERE IndCancel='S' AND Data BETWEEN ? AND ? GROUP BY Data, nECF, CCF, Operador`, (ln, ms) => [ms.dIni, ms.dFim]))
      .map(r => ({ loja: r.loja, data: iso(r.Data), pdv: r.pdv, cupom: r.cupom, operador: r.operador || '', itens: +r.itens, valor: r2(num(r.valor)) })).sort((a, b) => b.valor - a.valor) },
  { n: 2, titulo: 'Preços de venda alterados para baixo', desc: 'Toda alteração de preço em que o preço novo ficou menor que o anterior (log de preço do ERP), com usuário, hora e motivo.',
    aplica: true, periodo: true, fonte: 'central.logpreco2',
    colunas: [C('loja', 'Loja'), C('data', 'Data', 'd'), C('hora', 'Hora'), C('produto', 'Produto'), C('cod', 'Código'), C('ant', 'Preço anterior', 'r$'), C('novo', 'Preço novo', 'r$'), C('var', 'Queda', '%'), C('usuario', 'Usuário'), C('motivo', 'Motivo'), C('origem', 'Origem')],
    run: async ctx => {
      const rows = await deps.q(`SELECT nLoja loja, Data, Hora hora, CodigoBarras cod, Descricao produto, PrecoAnt, PrecoNovo, Nome usuario, Motivo motivo, origem FROM central.logpreco2 WHERE Data BETWEEN ? AND ? ${ctx.loja ? 'AND nLoja=?' : ''} ORDER BY Data DESC, Hora DESC LIMIT 20000`, ctx.loja ? [ctx.de, ctx.ate, ctx.loja] : [ctx.de, ctx.ate]);
      return rows.map(r => ({ loja: r.loja, data: iso(r.Data), hora: r.hora, produto: r.produto, cod: r.cod, ant: num(r.PrecoAnt), novo: num(r.PrecoNovo), var: pctQueda(num(r.PrecoAnt), num(r.PrecoNovo)), usuario: (r.usuario || '').replace(/^P:/, ''), motivo: r.motivo || '', origem: r.origem || '' }))
        .filter(r => r.ant > 0 && r.novo < r.ant);
    } },
  { n: 3, titulo: 'Preços de venda abaixo do custo ou com margem zero', desc: 'Cadastro atual: preço de venda da loja menor ou igual ao custo da loja (custoloja). Não depende do período.',
    aplica: true, periodo: false, fonte: 'central.itens × custoloja{n}',
    colunas: [C('loja', 'Loja'), C('produto', 'Produto'), C('cod', 'Código'), C('grupo', 'Departamento'), C('custo', 'Custo', 'r$'), C('preco', 'Preço', 'r$'), C('margem', 'Margem', '%'), C('est', 'Estoque', 'n')],
    run: async ctx => { const k = await cadastro(), out = [];
      for (const ln of lojasDe(ctx.loja)) for (const it of k.itens) { const p = num(it['P' + ln]), c = k.custo[ln][it.cod] || 0; if (p > 0 && c > 0 && p <= c) out.push({ loja: ln, produto: it.descricao, cod: it.cod, grupo: it.grupo || '', custo: c, preco: p, margem: margem(p, c), est: k.est[ln][it.cod] || 0 }); }
      return out.sort((a, b) => a.margem - b.margem); } },
  { n: 4, titulo: 'Solicitações de preço (rebaixa) autorizadas', desc: 'Pedidos de rebaixa de preço feitos pela loja (data crítica, avaria etc.) e quem fechou. É a "autorização de venda" do ERP: quem pediu, quem autorizou, quanto caiu.',
    aplica: true, periodo: true, fonte: 'central.solicitacaopreco',
    colunas: [C('loja', 'Loja'), C('data', 'Solicitado em', 'd'), C('produto', 'Produto'), C('cod', 'Código'), C('atual', 'Preço atual', 'r$'), C('solic', 'Preço solicitado', 'r$'), C('var', 'Queda', '%'), C('qtd', 'Qtd', 'n'), C('validade', 'Validade', 'd'), C('motivo', 'Motivo'), C('solicitou', 'Solicitou'), C('fechou', 'Fechou'), C('fechado', 'Fechado em', 'd'), C('status', 'Status')],
    run: async ctx => (await deps.q(`SELECT nLoja loja, DataSolicitacao, CodigoBarra cod, Descricao produto, PrecoAtual, PrecoSolicitado, Qtd, Validade, Motivo, OperadorSolicitacao, OperadorFechamento, DataFechamento, Status FROM central.solicitacaopreco WHERE DataSolicitacao BETWEEN ? AND ? ${ctx.loja ? 'AND nLoja=?' : ''} ORDER BY DataSolicitacao DESC LIMIT 20000`, ctx.loja ? [ctx.de, ctx.ate, ctx.loja] : [ctx.de, ctx.ate]))
      .map(r => ({ loja: r.loja, data: iso(r.DataSolicitacao), produto: r.produto, cod: r.cod, atual: num(r.PrecoAtual), solic: num(r.PrecoSolicitado), var: pctQueda(num(r.PrecoAtual), num(r.PrecoSolicitado)), qtd: num(r.Qtd), validade: iso(r.Validade), motivo: r.Motivo || '', solicitou: r.OperadorSolicitacao || '', fechou: r.OperadorFechamento || '', fechado: iso(r.DataFechamento), status: r.Status === 1 ? 'fechada' : 'aberta' })) },
  { n: 5, titulo: 'Vendas com margem abaixo do mínimo', desc: 'Produtos vendidos no período com margem sobre a venda (cupons: valor − custo) abaixo do mínimo informado. Mostra o prejuízo quando vendeu abaixo do custo.',
    aplica: true, periodo: true, fonte: 'ln{loja}mes{MM}.zcupomitens', params: [{ k: 'margem', t: 'Margem mínima (%)', v: 5 }],
    colunas: [C('loja', 'Loja'), C('produto', 'Produto'), C('cod', 'Código'), C('qtd', 'Qtd vendida', 'n'), C('venda', 'Venda', 'r$'), C('custo', 'Custo vendido', 'r$'), C('margem', 'Margem', '%'), C('perda', 'Abaixo do custo', 'r$')],
    run: async ctx => { const min = num(ctx.params.margem);
      const acc = {};
      for (const r of await cupons(ctx, (ln, ms) => `SELECT Codigo cod, MAX(Descricao) produto, SUM(QtdNovo) q, SUM(ValorTotalNovo) v, SUM(Custo) c FROM \`ln${ln}mes${ms.mm}\`.zcupomitens WHERE IndCancel='N' AND Data BETWEEN ? AND ? GROUP BY Codigo`, (ln, ms) => [ms.dIni, ms.dFim])) {
        const k = r.loja + '|' + r.cod, a = acc[k] || (acc[k] = { loja: r.loja, cod: r.cod, produto: r.produto, qtd: 0, venda: 0, custo: 0 }); a.qtd += num(r.q); a.venda += num(r.v); a.custo += num(r.c); }
      return Object.values(acc).filter(a => a.venda > 0 && a.custo > 0).map(a => ({ ...a, qtd: r2(a.qtd), venda: r2(a.venda), custo: r2(a.custo), margem: margem(a.venda, a.custo), perda: a.custo > a.venda ? r2(a.custo - a.venda) : 0 })).filter(a => a.margem < min).sort((a, b) => b.perda - a.perda || a.margem - b.margem); } },
  { n: 6, titulo: 'Notas de bonificação recebidas', desc: 'Entradas de bonificação (mercadoria sem cobrança) no período, com valor, rebaixa de custo aplicada e saldo.',
    aplica: true, periodo: true, fonte: 'central.bonificacao_averbacao',
    colunas: [C('loja', 'Loja'), C('data', 'Entrada', 'd'), C('fornecedor', 'Fornecedor'), C('nf', 'NF', 'n'), C('produto', 'Produto'), C('qtd', 'Qtd', 'n'), C('valor', 'Valor', 'r$'), C('financeiro', 'Financeiro', 'r$'), C('rebaixa', 'Rebaixa', 'r$'), C('saldo', 'Saldo', 'r$'), C('status', 'Status')],
    run: async ctx => (await deps.q(`SELECT nLoja loja, DataEntrada, NomeFornec, nNota, Descricao, QtdEntrada, ValorTotal, ValorFinanceiro, ValorRebaixa, Saldo, Status FROM central.bonificacao_averbacao WHERE DataEntrada BETWEEN ? AND ? ${ctx.loja ? 'AND nLoja=?' : ''} ORDER BY DataEntrada DESC LIMIT 20000`, ctx.loja ? [ctx.de, ctx.ate, ctx.loja] : [ctx.de, ctx.ate]))
      .map(r => ({ loja: r.loja, data: iso(r.DataEntrada), fornecedor: r.NomeFornec || '', nf: r.nNota, produto: r.Descricao || '', qtd: num(r.QtdEntrada), valor: num(r.ValorTotal), financeiro: num(r.ValorFinanceiro), rebaixa: num(r.ValorRebaixa), saldo: num(r.Saldo), status: r.Status === 2 ? 'baixada' : r.Status === 1 ? 'parcial' : 'em aberto' })) },
  { n: 7, titulo: 'Cupons acima de um valor', desc: 'Cupons do período com total acima do valor informado, com PDV, operador e CPF na nota.',
    aplica: true, periodo: true, fonte: 'ln{loja}mes{MM}.zcupomitens', params: [{ k: 'valor', t: 'Valor (R$)', v: 5000 }],
    colunas: [C('loja', 'Loja'), C('data', 'Data', 'd'), C('pdv', 'PDV', 'n'), C('cupom', 'Cupom', 'n'), C('operador', 'Operador'), C('cpf', 'CPF'), C('itens', 'Itens', 'n'), C('valor', 'Total', 'r$')],
    run: async ctx => { const v = num(ctx.params.valor) || 5000;
      return (await cupons(ctx, (ln, ms) => `SELECT Data, nECF pdv, CCF cupom, MAX(Operador) operador, MAX(CPF) cpf, COUNT(*) itens, SUM(ValorTotalNovo) valor FROM \`ln${ln}mes${ms.mm}\`.zcupomitens WHERE IndCancel='N' AND Data BETWEEN ? AND ? GROUP BY Data, nECF, CCF HAVING valor > ?`, (ln, ms) => [ms.dIni, ms.dFim, v]))
        .map(r => ({ loja: r.loja, data: iso(r.Data), pdv: r.pdv, cupom: r.cupom, operador: r.operador || '', cpf: r.cpf && +r.cpf > 0 ? String(r.cpf).padStart(11, '0') : '', itens: +r.itens, valor: r2(num(r.valor)) })).sort((a, b) => b.valor - a.valor); } },
  { n: 8, titulo: 'Duplicatas recebidas abaixo do valor do documento', aplica: false, motivo: 'O ERP não tem contas a receber com movimento (venda é à vista no caixa; a tabela contasareceber está vazia).' },
  { n: 9, titulo: 'Duplicatas pagas acima do valor do documento', desc: 'Títulos do contas a pagar cujo total baixado no período ficou maior que o valor do documento mais acréscimos, juros e multa lançados.',
    aplica: true, periodo: true, fonte: 'loja20045.contasapagar × contasapagarbaixaconta',
    colunas: [C('loja', 'Loja'), C('fornecedor', 'Fornecedor'), C('doc', 'Documento'), C('vencto', 'Vencimento', 'd'), C('valor', 'Valor doc.', 'r$'), C('acresc', 'Acrésc.+juros+multa', 'r$'), C('desconto', 'Desconto', 'r$'), C('pago', 'Pago', 'r$'), C('dif', 'Pago a mais', 'r$'), C('baixa', 'Última baixa', 'd')],
    run: async ctx => (await deps.q(`SELECT c.Filial loja, f.Nome fornecedor, c.nDoc doc, c.DataVencto, c.Valor, c.Acrescimo, c.Juros, c.Multa, c.Desconto, SUM(b.Valor) pago, MAX(b.DataDeposito) baixa
                                     FROM loja20045.contasapagar c JOIN loja20045.contasapagarbaixaconta b ON b.nReg = c.nReg LEFT JOIN central.fornecedor f ON f.CodFornec = c.CodFornec
                                     WHERE b.DataDeposito BETWEEN ? AND ? ${ctx.loja ? 'AND c.Filial=?' : ''} GROUP BY c.nReg HAVING pago > c.Valor + IFNULL(c.Acrescimo,0) + IFNULL(c.Juros,0) + IFNULL(c.Multa,0) - IFNULL(c.Desconto,0) + 0.01 LIMIT 5000`, ctx.loja ? [ctx.de, ctx.ate, ctx.loja] : [ctx.de, ctx.ate]))
      .map(r => { const ac = num(r.Acrescimo) + num(r.Juros) + num(r.Multa); return { loja: r.loja, fornecedor: r.fornecedor || '', doc: r.doc, vencto: iso(r.DataVencto), valor: num(r.Valor), acresc: r2(ac), desconto: num(r.Desconto), pago: r2(num(r.pago)), dif: r2(num(r.pago) - num(r.Valor) - ac + num(r.Desconto)), baixa: iso(r.baixa) }; }).sort((a, b) => b.dif - a.dif) },
  { n: 10, titulo: 'Juros e multas pagos em títulos', desc: 'No WinThor é "juros cobrados × juros devidos". Aqui: títulos baixados no período que pagaram juros ou multa, com dias de atraso.',
    aplica: true, periodo: true, fonte: 'loja20045.contasapagar',
    colunas: [C('loja', 'Loja'), C('fornecedor', 'Fornecedor'), C('doc', 'Documento'), C('vencto', 'Vencimento', 'd'), C('baixa', 'Pago em', 'd'), C('atraso', 'Dias atraso', 'n'), C('valor', 'Valor doc.', 'r$'), C('juros', 'Juros', 'r$'), C('multa', 'Multa', 'r$'), C('acresc', 'Acréscimo', 'r$')],
    run: async ctx => (await deps.q(`SELECT c.Filial loja, f.Nome fornecedor, c.nDoc doc, c.DataVencto, c.Valor, c.Juros, c.Multa, c.Acrescimo, MAX(b.DataDeposito) baixa
                                     FROM loja20045.contasapagar c JOIN loja20045.contasapagarbaixaconta b ON b.nReg = c.nReg LEFT JOIN central.fornecedor f ON f.CodFornec = c.CodFornec
                                     WHERE b.DataDeposito BETWEEN ? AND ? ${ctx.loja ? 'AND c.Filial=?' : ''} AND (IFNULL(c.Juros,0) > 0 OR IFNULL(c.Multa,0) > 0) GROUP BY c.nReg LIMIT 5000`, ctx.loja ? [ctx.de, ctx.ate, ctx.loja] : [ctx.de, ctx.ate]))
      .map(r => ({ loja: r.loja, fornecedor: r.fornecedor || '', doc: r.doc, vencto: iso(r.DataVencto), baixa: iso(r.baixa), atraso: r.baixa && r.DataVencto ? Math.max(0, Math.round((new Date(iso(r.baixa)) - new Date(iso(r.DataVencto))) / 86400000)) : null, valor: num(r.Valor), juros: num(r.Juros), multa: num(r.Multa), acresc: num(r.Acrescimo) })).sort((a, b) => (b.juros + b.multa) - (a.juros + a.multa)) },
  { n: 11, titulo: 'Vendas de RCAs diferentes do cadastro de clientes', aplica: false, motivo: 'Não há RCA/vendedor externo nem venda por cliente cadastrado no ERP (venda de balcão).' },
  { n: 12, titulo: 'Ajustes de estoque', desc: 'Entradas e saídas lançadas à mão no estoque (inventário, avaria, transformação de carne etc.), com usuário, motivo e valor a custo.',
    aplica: true, periodo: true, fonte: 'central.estoque_ajuste',
    colunas: [C('loja', 'Loja'), C('data', 'Data', 'd'), C('tipo', 'Tipo'), C('produto', 'Produto'), C('cod', 'Código'), C('qtd', 'Qtd', 'n'), C('antes', 'Estoque antes', 'n'), C('depois', 'Estoque depois', 'n'), C('valor', 'Valor a custo', 'r$'), C('motivo', 'Motivo'), C('usuario', 'Usuário'), C('obs', 'Obs')],
    run: async ctx => {
      const rows = await deps.q(`SELECT a.nLoja loja, a.DataLan, a.Tipo, a.CodigoBarras cod, a.Descricao produto, a.Qtd, a.Estoque_Anterior antes, a.Estoque_Final depois, m.Descricao motivo, a.Usuario usuario, a.Obs obs
                                 FROM central.estoque_ajuste a LEFT JOIN central.estoque_ajustes_motivo m ON m.nReg = a.CodMotivo WHERE a.DataLan BETWEEN ? AND ? ${ctx.loja ? 'AND a.nLoja=?' : ''} ORDER BY a.DataLan DESC LIMIT 20000`, ctx.loja ? [ctx.de, ctx.ate, ctx.loja] : [ctx.de, ctx.ate]);
      const porLoja = {}; for (const r of rows) (porLoja[r.loja] = porLoja[r.loja] || []).push(r.cod);
      const custo = {}; for (const ln of Object.keys(porLoja)) custo[ln] = await custosDe(ln, porLoja[ln]);
      return rows.map(r => ({ loja: r.loja, data: iso(r.DataLan), tipo: r.Tipo === 1 ? 'Entrada' : 'Saída', produto: r.produto, cod: r.cod, qtd: num(r.Qtd), antes: num(r.antes), depois: num(r.depois), valor: r2(num(r.Qtd) * ((custo[r.loja] || {})[r.cod] || 0)), motivo: r.motivo || '', usuario: r.usuario || '', obs: r.obs || '' })).sort((a, b) => b.valor - a.valor);
    } },
  { n: 13, titulo: 'Títulos recebidos com cobrança divergente', aplica: false, motivo: 'Sem contas a receber no ERP.' },
  { n: 14, titulo: 'Manutenção de custos de produtos', desc: 'Alterações de custo (log de custo). "Manual" = sem nota de entrada vinculada: alguém digitou o custo.',
    aplica: true, periodo: true, fonte: 'central.logcusto2',
    colunas: [C('loja', 'Loja'), C('data', 'Data', 'd'), C('hora', 'Hora'), C('produto', 'Produto'), C('cod', 'Código'), C('ant', 'Custo anterior', 'r$'), C('novo', 'Custo novo', 'r$'), C('var', 'Variação', '%'), C('usuario', 'Usuário'), C('origem', 'Origem'), C('nota', 'Nota')],
    run: async ctx => (await deps.q(`SELECT nLoja loja, Data, Hora hora, CodigoBarras cod, Descricao produto, PrecoAtual ant, PrecoNovo novo, Nome usuario, origem, nnota FROM central.logcusto2 WHERE Data BETWEEN ? AND ? ${ctx.loja ? 'AND nLoja=?' : ''} ORDER BY Data DESC, Hora DESC LIMIT 20000`, ctx.loja ? [ctx.de, ctx.ate, ctx.loja] : [ctx.de, ctx.ate]))
      .map(r => ({ loja: r.loja, data: iso(r.Data), hora: r.hora, produto: r.produto, cod: r.cod, ant: num(r.ant), novo: num(r.novo), var: pctQueda(num(r.ant), num(r.novo)), usuario: r.usuario || '', origem: r.origem || '', nota: r.nnota > 0 ? String(r.nnota) : 'MANUAL' })) },
  { n: 15, titulo: 'Lançamentos em conta temporária', aplica: false, motivo: 'Não existe conta temporária/transitória no financeiro do ERP.' },
  { n: 16, titulo: 'RCAs com saldo negativo em conta corrente', aplica: false, motivo: 'Não há RCA nem conta corrente de vendedor no ERP.' },
  { n: 17, titulo: 'Notas de bonificação em aberto', desc: 'Bonificações com saldo ainda não baixado (independe do período; considera até a data final).',
    aplica: true, periodo: false, fonte: 'central.bonificacao_averbacao',
    colunas: [C('loja', 'Loja'), C('data', 'Entrada', 'd'), C('fornecedor', 'Fornecedor'), C('nf', 'NF', 'n'), C('produto', 'Produto'), C('valor', 'Valor', 'r$'), C('saldo', 'Saldo em aberto', 'r$'), C('dias', 'Dias em aberto', 'n'), C('status', 'Status')],
    run: async ctx => (await deps.q(`SELECT nLoja loja, DataEntrada, NomeFornec, nNota, Descricao, ValorTotal, Saldo, Status FROM central.bonificacao_averbacao WHERE Status <> 2 AND Saldo > 0 ${ctx.loja ? 'AND nLoja=?' : ''} ORDER BY DataEntrada LIMIT 20000`, ctx.loja ? [ctx.loja] : []))
      .map(r => ({ loja: r.loja, data: iso(r.DataEntrada), fornecedor: r.NomeFornec || '', nf: r.nNota, produto: r.Descricao || '', valor: num(r.ValorTotal), saldo: num(r.Saldo), dias: r.DataEntrada ? Math.round((Date.now() - new Date(iso(r.DataEntrada))) / 86400000) : null, status: r.Status === 1 ? 'parcial' : 'em aberto' })) },
  { n: 18, titulo: 'Divergências entre pedido de compra e nota', aplica: false, motivo: 'Ainda não mapeado: precisa cruzar pedidocompra × compras por item. A Conciliação CD (Financeiro) já cobre parte disso.' },
  { n: 19, titulo: 'Bônus fechado com divergência', aplica: false, motivo: 'Não há controle de bônus por RCA no ERP.' },
  { n: 20, titulo: 'Juros lançados por funcionário', aplica: false, motivo: 'Não há RCA. Os juros pagos em títulos estão na checagem 10.' },
  { n: 21, titulo: 'Títulos prorrogados por cliente', aplica: false, motivo: 'Sem contas a receber no ERP.' },
  { n: 22, titulo: 'Aplicação de verbas — rebaixa de custos', desc: 'Bonificações em que foi aplicada rebaixa de custo (verba abatida no custo do produto) no período.',
    aplica: true, periodo: true, fonte: 'central.bonificacao_averbacao (ValorRebaixa)',
    colunas: [C('loja', 'Loja'), C('data', 'Entrada', 'd'), C('fornecedor', 'Fornecedor'), C('nf', 'NF', 'n'), C('produto', 'Produto'), C('valor', 'Valor', 'r$'), C('rebaixa', 'Rebaixa', 'r$'), C('usuario', 'Baixado por'), C('baixa', 'Baixa', 'd')],
    run: async ctx => (await deps.q(`SELECT nLoja loja, DataEntrada, NomeFornec, nNota, Descricao, ValorTotal, ValorRebaixa, Usuario_Baixa, Data_Baixa FROM central.bonificacao_averbacao WHERE ValorRebaixa > 0 AND DataEntrada BETWEEN ? AND ? ${ctx.loja ? 'AND nLoja=?' : ''} ORDER BY DataEntrada DESC LIMIT 20000`, ctx.loja ? [ctx.de, ctx.ate, ctx.loja] : [ctx.de, ctx.ate]))
      .map(r => ({ loja: r.loja, data: iso(r.DataEntrada), fornecedor: r.NomeFornec || '', nf: r.nNota, produto: r.Descricao || '', valor: num(r.ValorTotal), rebaixa: num(r.ValorRebaixa), usuario: r.Usuario_Baixa || '', baixa: iso(r.Data_Baixa) })) },
  { n: 23, titulo: 'Margem ideal do produto alterada', aplica: false, motivo: 'O ERP não guarda log da margem de cadastro (itens_margens); só o valor atual. A checagem 26 compara a margem praticada com a de cadastro.' },
  { n: 24, titulo: 'Preço de venda abaixo da margem informada', desc: 'Cadastro atual: produtos cuja margem sobre o custo (o "margem" do ERP) está abaixo do percentual informado.',
    aplica: true, periodo: false, fonte: 'central.itens × custoloja{n}', params: [{ k: 'margem', t: 'Margem s/ custo (%)', v: 30 }],
    colunas: [C('loja', 'Loja'), C('produto', 'Produto'), C('cod', 'Código'), C('grupo', 'Departamento'), C('custo', 'Custo', 'r$'), C('preco', 'Preço', 'r$'), C('markup', 'Margem s/ custo', '%'), C('margemCad', 'Margem cadastro', '%'), C('est', 'Estoque', 'n')],
    run: async ctx => { const min = num(ctx.params.margem), k = await cadastro(), out = [];
      for (const ln of lojasDe(ctx.loja)) for (const it of k.itens) { const p = num(it['P' + ln]), c = k.custo[ln][it.cod] || 0; const mk = markup(p, c); if (mk != null && mk < min) out.push({ loja: ln, produto: it.descricao, cod: it.cod, grupo: it.grupo || '', custo: c, preco: p, markup: mk, margemCad: k.marg[ln][it.cod], est: k.est[ln][it.cod] || 0 }); }
      return out.sort((a, b) => a.markup - b.markup); } },
  { n: 25, titulo: 'Produtos com preço de venda zerado', desc: 'Cadastro atual: produto ativo com preço zero na loja. Marque "só com estoque" pra ver os que têm mercadoria sem preço.',
    aplica: true, periodo: false, fonte: 'central.itens × estoquen{n}', params: [{ k: 'so_estoque', t: 'Só com estoque', v: 1, tipo: 'chk' }],
    colunas: [C('loja', 'Loja'), C('produto', 'Produto'), C('cod', 'Código'), C('grupo', 'Departamento'), C('custo', 'Custo', 'r$'), C('est', 'Estoque', 'n'), C('valorEst', 'Estoque a custo', 'r$')],
    run: async ctx => { const so = String(ctx.params.so_estoque) === '1', k = await cadastro(), out = [];
      for (const ln of lojasDe(ctx.loja)) for (const it of k.itens) { const p = num(it['P' + ln]), e = k.est[ln][it.cod] || 0; if (p === 0 && (!so || e > 0)) out.push({ loja: ln, produto: it.descricao, cod: it.cod, grupo: it.grupo || '', custo: k.custo[ln][it.cod] || 0, est: e, valorEst: r2(e * (k.custo[ln][it.cod] || 0)) }); }
      return out.sort((a, b) => b.valorEst - a.valorEst); } },
  { n: 26, titulo: 'Margem atual menor que a margem ideal', desc: 'Cadastro atual: margem sobre o custo praticada (preço × custo da loja) abaixo da margem de cadastro do produto na loja (itens_margens).',
    aplica: true, periodo: false, fonte: 'central.itens × custoloja{n} × itens_margens',
    colunas: [C('loja', 'Loja'), C('produto', 'Produto'), C('cod', 'Código'), C('grupo', 'Departamento'), C('custo', 'Custo', 'r$'), C('preco', 'Preço', 'r$'), C('markup', 'Margem atual', '%'), C('ideal', 'Margem ideal', '%'), C('dif', 'Diferença', '%'), C('precoIdeal', 'Preço p/ ideal', 'r$')],
    run: async ctx => { const k = await cadastro(), out = [];
      for (const ln of lojasDe(ctx.loja)) for (const it of k.itens) { const p = num(it['P' + ln]), c = k.custo[ln][it.cod] || 0, ideal = k.marg[ln][it.cod]; const mk = markup(p, c); if (mk != null && ideal != null && ideal > 0 && mk < ideal - 0.05) out.push({ loja: ln, produto: it.descricao, cod: it.cod, grupo: it.grupo || '', custo: c, preco: p, markup: mk, ideal, dif: r1(mk - ideal), precoIdeal: r2(c * (1 + ideal / 100)) }); }
      return out.sort((a, b) => a.dif - b.dif); } },
  { n: 27, titulo: 'Créditos de clientes inclusos', aplica: false, motivo: 'Sem cadastro de crédito de cliente no ERP.' },
  { n: 28, titulo: 'Notas fiscais sem acerto de caixa de motorista', aplica: false, motivo: 'Não há acerto de caixa de motorista (entrega/rota) no ERP.' }
];

function lista() { return CHECKS.map(c => ({ n: c.n, titulo: c.titulo, desc: c.desc || null, aplica: !!c.aplica, motivo: c.motivo || null, periodo: !!c.periodo, fonte: c.fonte || null, params: c.params || [], colunas: c.colunas || [] })); }

async function rodar(n, ctx) {
  const c = CHECKS.find(x => x.n === +n);
  if (!c) throw new Error('Checagem não existe');
  if (!c.aplica) return { n: c.n, titulo: c.titulo, aplica: false, motivo: c.motivo, rows: [], total: 0 };
  const params = {}; for (const p of c.params || []) params[p.k] = ctx.params && ctx.params[p.k] != null && ctx.params[p.k] !== '' ? ctx.params[p.k] : p.v;
  const t0 = Date.now();
  const rows = await c.run({ ...ctx, params });
  const resumo = {};
  for (const col of c.colunas) if (col.tipo === 'r$') resumo[col.k] = r2(rows.reduce((s, r) => s + (num(r[col.k]) || 0), 0));
  return { n: c.n, titulo: c.titulo, aplica: true, colunas: c.colunas, params, total: rows.length, rows: rows.slice(0, ctx.limite || 2000), resumo, ms: Date.now() - t0 };
}

module.exports = { init, lista, rodar, CHECKS, NOMES, LOJAS };
