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

async function resumo(forcar = false) {
  if (!forcar && cache && Date.now() - cacheEm < CACHE_MS) return cache;
  const { radarPedidos } = deps;
  const estado = radarPedidos.getEstado();
  const hoje = iso(new Date());
  const vig = listasVigiadas();
  const ids = [...new Set(vig.flatMap(v => v.ids))];
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
    out.listas.push({
      chave: v.chave, nome: v.nome, id, ok: !!row.ok, motivo: row.ok ? null : row.motivo,
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
    pedir_hoje: hojeL.map(l => ({ nome: l.nome, valor: l.pedido_valor, itens: l.pedido_itens, volumes: l.volumes, gatilho: l.gatilho, compradora: l.compradora, abaixo_minimo: l.abaixo_minimo })),
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
