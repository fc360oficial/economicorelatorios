// Comprador robô em MODO SOMBRA (04/11/2026, Tiago): "ele poderia estar lendo e mostrando o que faria se estivesse fazendo essas
// listas, mas nada ainda certo e real, só acompanhando" — e SÓ nas listas do robô (Vitamassa, Capricche, Yoki, Nestlé + a 5ª),
// as mesmas do Robô de Precificação (data/robo-precificacao-params.json). Regras dele:
//   - NADA muda nas listas das compradoras: lista no nome da Kelly continua com a Kelly (ERP e cronograma intocados)
//   - nenhum pedido é criado, nenhuma mensagem é enviada, nada é gravado no ERP; só mostra "o que faria hoje"
//   - por enquanto só o Tiago vê (rotas exclusivas de admin no server.js)
// Reaproveita o Radar de Pedidos (lib/radar-pedidos.js): politica() = quando cada lista teria que ser pedida e quanto,
// itensLista() = item a item com quantidade por loja, sombra()/sombraDetalhe() = o que o sistema pediria × o que a compradora
// pediu de fato (snapshots diários em data/radar-sombra). Tudo só leitura.
'use strict';

let deps = null, cache = null, cacheEm = 0;
const CACHE_MS = 10 * 60 * 1000;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const r2 = v => Math.round((+v || 0) * 100) / 100;
const dd = (a, b) => Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);

function init(d) { deps = d; }
function invalidar() { cache = null; }

/** Listas vigiadas (chave do robô → ids no ERP), lidas do Robô de Precificação. */
function listasVigiadas() { return (deps.roboPrecif.getParams().listas || []).map(l => ({ chave: l.chave, nome: l.nome, ids: l.ids })); }

/** Sugestões DLINKS (central.lista_consolidadas) das listas vigiadas nos últimos 90 dias — o que a compradora FEZ de verdade
 *  no ERP, pra pôr do lado do que o robô faria (Tiago 05/11/26: "no sombra tem pedidos feitos pelo dlinks"). Só leitura.
 *  Situação igual ao Monitor de Sugestões: linha em pedidocompra = Pedido gerado; StatusWeb 1 = Em aberto, 2 = Fechado; senão Sem link. */
async function sugestoesDlinks(ids, hoje) {
  const porLista = {};
  if (!ids.length || !deps.q) return porLista;
  const rows = await deps.q(`
    SELECT lc.nConsolidado, lc.nLista, lc.Data, lc.StatusWeb, lc.CodDesativado,
           (SELECT COUNT(*) FROM central.lista_consolidado_itens i WHERE i.nConsolidado = lc.nConsolidado) itens,
           (SELECT COUNT(*) FROM central.pedidocompra p WHERE p.nConsolidado = lc.nConsolidado) pedLinhas,
           (SELECT MAX(p.nPedido) FROM central.pedidocompra p WHERE p.nConsolidado = lc.nConsolidado) nPedido,
           (SELECT COUNT(*) FROM central.pedidocompra p WHERE p.nConsolidado = lc.nConsolidado AND p.Status IN (0,1)) pedAbertos,
           (SELECT COUNT(*) FROM central.pedidocompra p WHERE p.nConsolidado = lc.nConsolidado AND p.Status IN (2,4,7)) pedRecebidos,
           (SELECT GROUP_CONCAT(DISTINCT p.nLoja ORDER BY p.nLoja) FROM central.pedidocompra p WHERE p.nConsolidado = lc.nConsolidado AND p.Status IN (0,1)) lojasAbertas,
           (SELECT GROUP_CONCAT(DISTINCT h.nLoja ORDER BY h.nLoja) FROM central.lista_consolidado_historico h WHERE h.nConsolidado = lc.nConsolidado) lojas
    FROM central.lista_consolidadas lc
    WHERE lc.nLista IN (${ids.map(() => '?').join(',')}) AND lc.Data >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
    ORDER BY lc.nConsolidado DESC`, ids);
  // pedidos de compra ainda abertos (Status 0/1) por sugestão: nReg por loja, pra achar e dar baixa no Dlinks (Tiago 09/11/26:
  // "os pedidos velhos não vamos contar. isso tá em aberto aonde no ERP?")
  const abertosPor = {};
  const comAberto = rows.filter(r => +r.pedAbertos > 0).map(r => r.nConsolidado);
  if (comAberto.length) {
    for (const p of await deps.q(`SELECT nReg, nConsolidado, nLoja, Status, DATE_FORMAT(DataPedido,'%Y-%m-%d') dp, DATE_FORMAT(DataEntrega,'%Y-%m-%d') de
      FROM central.pedidocompra WHERE nConsolidado IN (${comAberto.map(() => '?').join(',')}) AND Status IN (0,1) ORDER BY nLoja`, comAberto))
      (abertosPor[p.nConsolidado] = abertosPor[p.nConsolidado] || []).push({ nReg: p.nReg, loja: +p.nLoja, status: +p.Status, data: p.dp, entrega: p.de });
  }
  for (const r of rows) {
    const data = r.Data ? iso(new Date(r.Data)) : null;
    const pedido = r.pedLinhas > 0;
    // pedidocompra.Status: 0/1 = aberto no ERP (em trânsito, é o que o Radar soma ao estoque); 2/4/7 = recebido (total/parcial); 8 = cancelado
    const emTransito = pedido && +r.pedAbertos > 0, recebido = pedido && !emTransito && +r.pedRecebidos > 0;
    const situacao = emTransito ? 'Em trânsito' : recebido ? 'Recebido' : pedido ? 'Pedido gerado' : r.StatusWeb === 1 ? 'Em aberto' : r.StatusWeb === 2 ? 'Fechado' : 'Sem link';
    (porLista[r.nLista] = porLista[r.nLista] || []).push({
      sugestao: r.nConsolidado, data, dias: data ? dd(hoje, data) : null, situacao, pedido, em_transito: emTransito, recebido, nPedido: r.nPedido > 0 ? r.nPedido : null,
      itens: +r.itens || 0, lojas: String(r.lojas || '').split(',').filter(Boolean).map(Number), lojas_transito: String(r.lojasAbertas || '').split(',').filter(Boolean).map(Number), desativada: +r.CodDesativado !== 0,
      abertos: abertosPor[r.nConsolidado] || []   // pedidocompra abertos: { nReg, loja, status, data, entrega }
    });
  }
  return porLista;
}

async function resumo(forcar = false) {
  if (!forcar && cache && Date.now() - cacheEm < CACHE_MS) return cache;
  const { radarPedidos } = deps;
  const estado = radarPedidos.getEstado();
  const hoje = iso(new Date());
  const vig = listasVigiadas();
  const ids = [...new Set(vig.flatMap(v => v.ids))];
  let dlinks = {}, dlinksErro = null;
  try { dlinks = await sugestoesDlinks(ids, hoje); } catch (e) { dlinksErro = e.message; console.error('[SOMBRA] sugestões DLINKS:', e.message); }
  const out = { modo: 'SOMBRA', aviso: 'Nada aqui vale: nenhum pedido criado, nenhuma mensagem enviada, nada gravado no ERP. As listas continuam com as compradoras.',
    hoje, radar: { status: estado.status, atualizadoEm: estado.atualizadoEm || null, recalculando: !!estado.recalculando }, listas: [], historico: [], faria: null };
  if (!estado.hoje) { out.motivo = 'Radar de Pedidos ainda sem base (calcula ~90 s depois de subir)'; cache = out; cacheEm = Date.now(); return out; }
  const pol = radarPedidos.politica();
  const leadPorLista = {};
  for (const v of vig) for (const id of v.ids) {
    const row = pol.find(r => r.lista === id);
    if (!row) { out.listas.push({ chave: v.chave, nome: v.nome, id, ok: false, motivo: 'lista não está na base do Radar' }); continue; }
    const det = row.ok ? radarPedidos.itensLista(id) : null;
    const leadMedio = row.lead && row.lead.lead_medio != null ? row.lead.lead_medio : (det && det.params ? det.params.lm : null);
    leadPorLista[id] = leadMedio;
    const itens = det ? det.itens : [];
    const pedir = itens.filter(i => i.qtd > 0);
    // trânsito atrasado: sugestão no ERP (Status 0/1) mais velha que lead + 2 dias e sem NF-e → é o que o robô cobraria do fornecedor
    const atrasados = [];
    for (const i of itens) for (const [ln, L] of Object.entries(i.lojas_det || {})) for (const t of (L.transito_det || [])) {
      if (!t.data || t.devolvida) continue; const idade = dd(hoje, String(t.data).slice(0, 10)); const temNfe = (t.nfe || []).some(n => !n.devolvida);
      if (!temNfe && idade > (leadMedio != null ? leadMedio : 5) + 2) atrasados.push({ cod: i.cod, descricao: i.descricao, loja: +ln, sugestao: t.sugestao, data: String(t.data).slice(0, 10), dias: idade, und: t.und });
    }
    atrasados.sort((a, b) => b.dias - a.dias);
    const sugestoesAtrasadas = [...new Set(atrasados.map(a => a.sugestao))];
    // o que a compradora FEZ no DLINKS: última sugestão com pedido gerado × o que o robô faria. Se ela já pediu dentro do
    // lead (ou nos últimos 5 d sem lead), o "pediria hoje" do robô é um pedido que já existe → marcado, não some.
    const sugs = dlinks[id] || [];
    // Tiago 09/11/26: "são pedidos feitos pelo DLINKS e tá em trânsito" → pedido da compradora ainda aberto no ERP (Status 0/1)
    // conta como "já pediu" independente do lead; recebido dentro do lead também. O Radar já soma esse trânsito ao estoque.
    // Pedido aberto há mais de 30 d está fora do trânsito do Radar (janela de 30 d) e quase certamente é pedido esquecido no ERP
    // (Yoki 4363, 59 d): não conta como "já pediu"; vai marcado como transito_velho pra alguém fechar/cobrar.
    for (const s of sugs) s.transito_velho = !!(s.em_transito && s.dias != null && s.dias > 30);
    const emTransito = sugs.find(s => s.em_transito && !s.transito_velho) || null;
    const ultimaPedida = emTransito || sugs.find(s => s.pedido) || null;
    const janela = (leadMedio != null ? leadMedio : 5);
    const jaPedida = !!(row.ok && row.fazer_em === 0 && ultimaPedida && ((ultimaPedida.em_transito && !ultimaPedida.transito_velho) || (ultimaPedida.dias != null && ultimaPedida.dias <= janela)));
    out.listas.push({
      chave: v.chave, nome: v.nome, id, ok: !!row.ok, motivo: row.ok ? null : row.motivo,
      dlinks: { recentes: sugs.slice(0, 4), ultima: sugs[0] || null, ultima_pedida: ultimaPedida, em_transito: emTransito, total_90d: sugs.length, ja_pedida: jaPedida,
        ja_pedida_motivo: jaPedida ? (ultimaPedida.em_transito ? 'em trânsito' : 'dentro do lead') : null, transito_velho: sugs.filter(s => s.transito_velho).map(s => ({ sugestao: s.sugestao, data: s.data, dias: s.dias, abertos: s.abertos })), erro: dlinksErro },
      nomeErp: row.nome, fornecedor: row.fornecedor, codFornec: row.codFornec, compradora: row.comprador || null,   // dona real: continua com ela
      pedidoMinimo: row.pedidoMinimo || null, lead: row.lead || null, leadMedio, lead_fonte: row.lead_fonte || null,
      fazer_em: row.ok ? row.fazer_em : null, data: row.ok ? row.data : null, dow: row.ok ? row.dow : null, gatilho: row.ok ? row.gatilho : null,
      lojas_puxam: row.lojas_puxam || [], cobertura_dias: row.cobertura_dias ?? null, rupturas: row.rupturas || 0, estoque_hoje: row.estoque_hoje || 0, venda_dia: row.venda_dia || 0,
      pedido_valor: row.ok ? row.pedido_valor : 0, pedido_itens: row.ok ? row.pedido_itens : 0, volumes: det ? det.volumes : 0, abaixo_minimo: !!row.abaixo_minimo,
      transito_valor: row.transito_valor || 0, transito_itens: row.transito_itens || 0, transito_und: row.transito_und || 0, transito_lojas: row.transito_lojas || [], transito_nfe: row.transito_nfe || 0,
      curva_a_risco: row.curva_a_risco || [], curva_a_itens: row.curva_a_itens || 0, produtos: row.produtos, com_venda: row.com_venda, zerados_sem_venda: row.zerados_sem_venda,
      itens: pedir.slice(0, 60).map(i => ({ cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: i.qtd, volumes: i.volumes, custo: i.custo, total: i.total, lojas_qtd: i.lojas_qtd, cobertura_dias: i.cobertura_dias, estoque: i.estoque, transito: i.transito, curva_a: i.curva_a, risco_a: i.risco_a, zera_antes: i.zera_antes, flag: i.flag })),
      itens_pedir: pedir.length, atrasados: atrasados.slice(0, 30), sugestoes_atrasadas: sugestoesAtrasadas.length
    });
  }
  // histórico: o que o sistema pediria × o que a compradora pediu (30 dias), só das listas vigiadas
  try {
    const sb = await radarPedidos.sombra(30);
    const nomeDe = {}; for (const v of vig) for (const id of v.ids) nomeDe[id] = v.nome;
    out.historico = sb.linhas.filter(l => ids.includes(l.lista)).map(l => ({ ...l, robo: nomeDe[l.lista] })).sort((a, b) => b.dia.localeCompare(a.dia) || a.lista - b.lista);
    out.historico_dias = sb.snapshots;
  } catch (e) { out.historico_erro = e.message; }
  // o que o robô FARIA hoje (e não faz)
  const hojeL = out.listas.filter(l => l.ok && l.fazer_em === 0);
  const proximas = out.listas.filter(l => l.ok && l.fazer_em > 0).sort((a, b) => a.fazer_em - b.fazer_em);
  const cobrar = out.listas.filter(l => l.sugestoes_atrasadas > 0);
  out.faria = {
    pedir_hoje: hojeL.map(l => ({ nome: l.nome, valor: l.pedido_valor, itens: l.pedido_itens, volumes: l.volumes, gatilho: l.gatilho, compradora: l.compradora, abaixo_minimo: l.abaixo_minimo,
      ja_pedida: !!(l.dlinks && l.dlinks.ja_pedida), dlinks_sugestao: l.dlinks && l.dlinks.ultima_pedida ? l.dlinks.ultima_pedida.sugestao : null, dlinks_dias: l.dlinks && l.dlinks.ultima_pedida ? l.dlinks.ultima_pedida.dias : null })),
    ja_pedidas: hojeL.filter(l => l.dlinks && l.dlinks.ja_pedida).length,
    valor_hoje: r2(hojeL.reduce((a, l) => a + l.pedido_valor, 0)),
    proximas: proximas.map(l => ({ nome: l.nome, data: l.data, dow: l.dow, fazer_em: l.fazer_em, valor: l.pedido_valor })),
    aprovacao: hojeL.length, gravar_erp: hojeL.length,
    cobrar: cobrar.map(l => ({ nome: l.nome, fornecedor: l.fornecedor, sugestoes: l.sugestoes_atrasadas, mais_velha_dias: l.atrasados[0] ? l.atrasados[0].dias : null })),
    transito_valor: r2(out.listas.reduce((a, l) => a + (l.transito_valor || 0), 0)), transito_nfe: out.listas.reduce((a, l) => a + (l.transito_nfe || 0), 0),
    rupturas: out.listas.reduce((a, l) => a + (l.rupturas || 0), 0), curva_a_risco: out.listas.reduce((a, l) => a + (l.curva_a_risco || []).filter(c => c.zera_antes).length, 0),
    resumo_18h: null
  };
  out.faria.resumo_18h = `Sombra ${hoje.split('-').reverse().join('/')}: ` + (hojeL.length ? `pediria ${hojeL.map(l => `${l.nome} R$ ${l.pedido_valor.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`).join(', ')}` : 'nenhuma lista pra pedir hoje')
    + (proximas.length ? `; próximas: ${proximas.slice(0, 3).map(l => `${l.nome} ${l.dow} ${l.data.slice(8, 10)}/${l.data.slice(5, 7)}`).join(', ')}` : '')
    + (cobrar.length ? `; cobraria ${cobrar.map(c => c.fornecedor).join(', ')}` : '') + `; ${out.faria.rupturas} ruptura(s), ${out.faria.curva_a_risco} curva A zerando antes da lista.`;
  cache = out; cacheEm = Date.now();
  return out;
}

function itens(id) { const d = deps.radarPedidos.itensLista(+id); if (!d) throw new Error('lista fora da base do Radar'); return d; }
function dia(d, id) { return deps.radarPedidos.sombraDetalhe(d, +id); }

module.exports = { init, resumo, itens, dia, invalidar, listasVigiadas };
