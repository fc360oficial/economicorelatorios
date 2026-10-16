'use strict';
// Fiscal × Pedidos de Compra do app (13/10/2026, combinado com o Tiago):
//
//   • Quem APROVA pedido é só o Compras. Radar e Fiscal não liberam nada.
//   • Pedido DE COTAÇÃO é feito pelo diretor e não tem comprador(a) acompanhando: o diretor NÃO confere XML.
//     Quem decide as divergências (preço acima do combinado, item não pedido, veio a mais) é o FISCAL, item a
//     item, na tela de Recebimento do Fiscal. Decisão gravada no pedido com papel 'fiscal'.
//   • Pedido NORMAL (radar / sugestão / ruptura, com compradora): quem decide continua sendo a COMPRADORA, em
//     Pedidos de Compra. O fiscal só vê, avisa a compradora e espera. SEM liberação por tempo (Tiago, 13/10:
//     "eu não quero colocar esse passada 2 horas").
//   • Aba "Pedidos a receber" no Fiscal: pedidos aprovados que ainda vão chegar, por loja, com origem, quem
//     decide, entrega prevista, situação da nota e ações (itens, PDF da loja, cobrar atraso, abrir recebimento).
//
// Só funções puras: recebem o pedido (JSON de data/pedidos-fornecedor) e devolvem o que a tela precisa.
// Nada é lido do ERP aqui.
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO', 10: 'DISTRIBUIDORA' };
const ABERTOS = ['aprovado', 'recebido_parcial', 'recebido'];
const SOME_SEM_NOTA_DIAS = 45;   // aprovado há mais de 45 dias e nenhuma nota: sai da aba (a janela do XML é 30 d)
const PARCIAL_DIAS = 30;         // parcial (faltou item) fica até 30 d da aprovação, que é até onde a conferência XML procura a 2ª entrega

// mesma régua da tela Pedidos de Compra (origemDe em pedidos-compra.html)
function origemDe(p) {
  const o = p.parametros?.origem;
  if (p.origem?.tipo === 'ruptura') return 'ruptura';
  if (o === 'sugestao' || o === 'sugestao-manual') return 'sugestao';
  if (o === 'semi') return 'semi';
  if (o === 'cotacao' || p.cotacao?.id != null) return 'cotacao';
  return 'radar';
}
const ORIGEM_TXT = { cotacao: 'Cotação', ruptura: 'Ruptura de entrega', sugestao: 'Sugestão manual', semi: 'Semi-automática', radar: 'Pedido (radar)' };
/** 'fiscal' = pedido de cotação (diretor): o fiscal decide as divergências no recebimento. 'compradora' = o resto. */
function quemDecide(p) { return origemDe(p) === 'cotacao' ? 'fiscal' : 'compradora'; }
function compradorDe(p) { return p.comprador?.nome || null; }
/** Observação que orienta quem recebe: a "Obs. pro Fiscal" do(a) comprador(a) ou a obs do diretor na cotação. */
function obsDe(p) {
  if (p.obs_fiscal) return { texto: p.obs_fiscal, por: p.obs_fiscal_por || (quemDecide(p) === 'fiscal' ? 'Diretor' : 'Comprador(a)') };
  if (p.cotacao?.obs) return { texto: p.cotacao.obs, por: 'Diretor' };
  return null;
}

// ── divergências que precisam de decisão (as mesmas que têm Aceitar/Recusar em Pedidos de Compra) ──
// falta/parcial NÃO precisam: viram pendência do fornecedor (sugestão de ruptura). Bonificação não passa pelo pedido.
function motivoDiverg(i, naoPedido) {
  if (naoPedido) return 'nao_pedido';
  if (i.tipo === 'a_mais') return 'a_mais';
  if (i.preco_status === 'maior') return 'preco';
  return null;
}
const MOTIVO_TXT = { nao_pedido: 'item não pedido', a_mais: 'veio a mais', preco: 'preço acima do combinado' };
/** Pendências de UMA loja do pedido: { pendentes: [...], decididas: n, total: n }. Loja conciliada não tem pendência. */
function pendenciasLoja(x) {
  const out = { pendentes: [], decididas: 0, total: 0 };
  if (!x || x.status !== 'consistencia') return out;
  const olhar = (i, naoPedido) => {
    const m = motivoDiverg(i, naoPedido); if (!m) return;
    out.total++;
    if (i.decisao && i.decisao.acao) out.decididas++;
    else out.pendentes.push({ cod: i.cod, descricao: i.descricao || '', motivo: m, motivo_txt: MOTIVO_TXT[m] });
  };
  for (const i of x.itens || []) olhar(i, false);
  for (const i of x.nao_pedidos || []) olhar(i, true);
  return out;
}

const addDias = (s, n) => { const d = new Date(String(s).slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
/** Data prevista de entrega: a da cotação; senão aprovação + prazo de entrega do vendedor. null = sem prazo. */
function entregaPrevista(p) {
  if (p.cotacao?.entrega && /^\d{4}-\d{2}-\d{2}/.test(p.cotacao.entrega)) return p.cotacao.entrega.slice(0, 10);
  const base = (p.aprovadoEm || p.criadoEm || '').slice(0, 10); if (!base) return null;
  const pe = p.prazo_entrega;
  return typeof pe === 'number' && pe >= 0 ? addDias(base, pe) : null;
}
/** nº da conferência do ERP (central.conferencia) da nota que entrou na loja — pra abrir o recebimento no Fiscal. */
function conferenciaDe(x) {
  for (const n of x?.notas || []) if (n.entrada && n.entrada.nConferencia) return +n.entrada.nConferencia;
  return null;
}
// 'AAAA-MM-DD HH:MM' ou 'AAAA-MM-DD' → 'DD/MM HH:MM' / 'DD/MM'
function dmh(s) { s = String(s || ''); const d = s.slice(8, 10) + '/' + s.slice(5, 7); const h = s.slice(11, 16); return /^\d{2}:\d{2}$/.test(h) ? d + ' ' + h : d; }
function horaChegou(x) {
  const c = x?.chegou; if (!c) return null;
  return c.horaEntrada || (c.em ? c.em : null);
}

/**
 * Situação da loja no pedido, pra aba "Pedidos a receber":
 *   aguardando_nota  nenhuma NF-e do fornecedor pra loja ainda (atrasado quando passou da entrega prevista)
 *   bipada_sem_xml   a loja bipou a chave da DANFE no coletor, mas o XML ainda não entrou no ERP (16/10/2026, Estivas #169):
 *                    não dá pra conferir itens; mostra a NF e a conferência pra abrir o recebimento
 *   nota_emitida     XML entrou no ERP, caminhão ainda não chegou (ninguém bipou)
 *   nota_bipada      a loja lançou/bipou a nota: conferência aberta no Fiscal (pendências pra decidir)
 *   liberado         fiscal liberou / loja fechou, mas ficou falta: fica até a 2ª entrega ou "não vem mais"
 *   fechado          tudo veio e fechou → sai da aba
 */
function situacaoLoja(p, ln, hoje) {
  const x = p.xml?.lojas?.[ln];
  const prev = entregaPrevista(p);
  const atraso = prev && prev < hoje ? diasEntre(prev, hoje) : 0;
  const pend = pendenciasLoja(x);
  const faltas = +(x?.faltas || 0);
  const nConf = conferenciaDe(x);
  if (!x || x.status === 'aguardando' || !(x.notas || []).length) {
    const b = (x && x.bipada && x.bipada.chaves) || [];
    if (b.length) {
      const em = b.map(c => c.em).filter(Boolean).sort()[0] || null;
      const nConfB = b.map(c => +c.nConferencia).filter(n => n > 0)[0] || null;
      const obs = b.map(c => c.obs).filter(Boolean)[0] || null;
      return { codigo: 'bipada_sem_xml', texto: 'Nota bipada na loja' + (em ? ' ' + dmh(em) : ''),
        sub: 'NF ' + b.map(c => c.nNota || '?').join(', ') + ' · XML ainda não baixado no ERP' + (nConfB ? ' · conferência ' + nConfB : '') + (obs ? ' · ' + obs : ''),
        atraso: 0, nConferencia: nConfB, pendentes: 0, faltas: 0 };
    }
    return { codigo: 'aguardando_nota', texto: 'Aguardando nota', sub: 'nenhuma NF-e desse CNPJ pra esta loja ainda', atraso, nConferencia: null, pendentes: 0, faltas: 0 };
  }
  const fechouFiscal = x.aceito || x.fiscal_liberou;
  const fechouLoja = !!(x.chegou && x.chegou.fechada);
  if (fechouFiscal || fechouLoja) {
    const quem = x.aceito ? (x.aceito.papel === 'fiscal' ? 'Liberado pelo fiscal' : 'Aceito pelo (a) Comprador (a)') : x.fiscal_liberou ? 'Liberado pelo fiscal' : 'Fechado na loja';
    const em = (x.aceito?.em || x.fiscal_liberou?.em || x.chegou?.fechadaEm || '').slice(0, 10);
    if (!faltas || x.fiscal_fechou) return { codigo: 'fechado', texto: quem, sub: '', atraso: 0, nConferencia: nConf, pendentes: 0, faltas };
    return { codigo: 'liberado', texto: quem + (em ? ' ' + em.slice(8, 10) + '/' + em.slice(5, 7) : ''), sub: faltas + ' item(ns) faltaram · aguardando 2ª entrega ou fechar como "não vem mais"', atraso: 0, nConferencia: nConf, pendentes: pend.pendentes.length, faltas };
  }
  if (x.chegou) {
    const h = horaChegou(x);
    const sub = [nConf ? 'conferência ' + nConf : null, pend.pendentes.length ? pend.pendentes.length + ' divergência(s) pra decidir' : (x.status === 'conciliado' ? 'bate com o pedido' : (x.problemas || []).length ? (x.problemas || []).map(z => z.msg).join(' · ') : null)].filter(Boolean).join(' · ');
    return { codigo: 'nota_bipada', texto: 'Nota bipada na loja' + (h ? ' ' + dmh(h) : ''), sub, atraso: 0, nConferencia: nConf, pendentes: pend.pendentes.length, faltas };
  }
  const n0 = (x.notas || [])[0];
  return { codigo: 'nota_emitida', texto: 'NF-e emitida · a caminho', sub: 'NF ' + (x.notas || []).map(n => n.nNota).join(', ') + (n0?.data ? ' de ' + String(n0.data).slice(8, 10) + '/' + String(n0.data).slice(5, 7) : '') + (pend.pendentes.length ? ' · ' + pend.pendentes.length + ' divergência(s) já vista(s) no XML' : ''), atraso, nConferencia: null, pendentes: pend.pendentes.length, faltas };
}

function itensLoja(p, ln) {
  const x = p.xml?.lojas?.[ln]; const porCod = {};
  for (const i of x?.itens || []) porCod[i.cod] = i;
  return (p.itens || []).filter(i => (i.lojas_qtd?.[ln] || 0) > 0).map(i => {
    const c = porCod[i.cod];
    return { cod: i.cod, descricao: i.descricao, unid: i.unid || null, emb: i.emb || null, qtd: i.lojas_qtd[ln], preco: i.preco != null ? i.preco : null, ultimo_custo: i.ultimo_custo ?? null, obs: i.obs || '',
      recebida: c ? c.recebida : null, tipo: c ? c.tipo : null, preco_xml: c ? c.preco_xml : null, preco_status: c ? c.preco_status : null, decisao: c?.decisao || null };
  });
}

/**
 * Linhas da aba "Pedidos a receber": uma por pedido × loja.
 * listar() = pedidosFornec.listar; totaisLoja = pedidosFornec.totaisLoja; lojas = null (todas) ou lista permitida.
 */
function pedidosAReceber(listar, totaisLoja, { lojas, loja, hoje } = {}) {
  hoje = hoje || new Date().toISOString().slice(0, 10);
  const out = [];
  for (const p of listar()) {
    if (p.teste || !ABERTOS.includes(p.status)) continue;
    const aprov = (p.aprovadoEm || p.criadoEm || '').slice(0, 10);
    const origem = origemDe(p), decide = quemDecide(p), comprador = compradorDe(p), obs = obsDe(p), prev = entregaPrevista(p);
    for (const ln of p.lojas || []) {
      if (loja && +ln !== +loja) continue;
      if (lojas && !lojas.includes(+ln)) continue;
      const s = situacaoLoja(p, ln, hoje);
      if (s.codigo === 'fechado') continue;
      const idade = aprov ? diasEntre(aprov, hoje) : 0;
      if (s.codigo === 'aguardando_nota' && idade > SOME_SEM_NOTA_DIAS) continue;
      // parcial ("liberado", faltou item) só fica pro pedido de COTAÇÃO — é o fiscal quem fecha como "não vem mais". No pedido
      // com compradora quem fecha é ela, em Pedidos de Compra. E só dentro da janela em que a conferência XML ainda procura a
      // 2ª entrega (30 d da aprovação): depois disso a linha só faria volume (13/10/2026: 150 linhas velhas na 1ª carga).
      if (s.codigo === 'liberado' && (decide !== 'fiscal' || idade > PARCIAL_DIAS)) continue;
      const t = totaisLoja(p, ln);
      const its = itensLoja(p, ln);
      const vieram = its.filter(i => i.recebida != null && i.recebida > 0).length;
      out.push({
        key: p.id + '-' + ln, pedido: p.id, loja: +ln, loja_nome: LOJAS_NOMES[ln] || ('Loja ' + ln), fornecedor: p.fornecedor, lista_nome: p.lista_nome || null, status: p.status,
        aprovadoEm: p.aprovadoEm || null, aprovadoPor: p.aprovadoPor || null, origem, origem_txt: ORIGEM_TXT[origem] || origem, cotacao: p.cotacao ? { id: p.cotacao.id, nome: p.cotacao.nome || null } : null,
        quem_decide: decide, comprador, obs, entrega_prevista: prev, atraso: s.atraso,
        itens: t.itens, itens_vieram: (s.codigo === 'nota_bipada' || s.codigo === 'liberado' || s.codigo === 'nota_emitida') ? vieram : null, valor: t.com_preco ? t.digitado : t.ultimo_custo, valor_tipo: t.com_preco ? 'digitado' : 'ultimo_custo',
        situacao: s.codigo, situacao_txt: s.texto, situacao_sub: s.sub, nConferencia: s.nConferencia, pendentes: s.pendentes, faltas: s.faltas,
        vendedor: p.vendedor ? { nome: p.vendedor.nome || null, whats: p.vendedor.whats || null } : null,
        avisos_fiscal: (p.avisos_fiscal || []).filter(a => +a.loja === +ln).length,
        itens_lista: its
      });
    }
  }
  const ORD = { nota_bipada: 0, bipada_sem_xml: 1, liberado: 2, nota_emitida: 3, aguardando_nota: 4 };
  // 15/10/2026 (Tiago: "essa cotação coloca ao contrário, a 3 em cima"): dentro da loja/situação/atraso, cotação mais nova primeiro e pedido mais novo primeiro
  const cot = r => (r.cotacao && r.cotacao.id) || 0;
  out.sort((a, b) => (a.loja - b.loja) || (ORD[a.situacao] - ORD[b.situacao]) || (b.atraso - a.atraso) || (cot(b) - cot(a)) || (b.pedido - a.pedido));
  return out;
}

/** Texto do WhatsApp pro vendedor cobrando a entrega atrasada (botão "Cobrar"). */
function textoCobranca(r) {
  const prev = r.entrega_prevista ? r.entrega_prevista.split('-').reverse().join('/') : null;
  return 'Olá' + (r.vendedor?.nome ? ' ' + r.vendedor.nome : '') + ', o pedido #' + r.pedido + (r.lista_nome ? ' (' + r.lista_nome + ')' : '') + ' da Loja ' + r.loja + ' · ' + (r.loja_nome || '') + ' (ECONOMICO SUPERMERCADO - REDE CAHU) ainda não chegou' + (prev ? ' — entrega prevista pra ' + prev + (r.atraso ? ', ' + r.atraso + ' dia(s) de atraso' : '') : '') + '. Pode nos dar uma previsão? ' + r.itens + ' itens · R$ ' + Number(r.valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + '. Obrigado!';
}
/** Texto do WhatsApp pra compradora: o fiscal está com a nota na mão e precisa da decisão dela. */
function textoAvisoCompradora(p, ln, nReg, pend) {
  const L = ['Olá' + (compradorDe(p) ? ' ' + compradorDe(p) : '') + ', o Fiscal está recebendo a nota do pedido #' + p.id + (p.lista_nome ? ' (' + p.lista_nome + ')' : '') + ' · ' + (p.fornecedor || '') + ' na Loja ' + ln + ' · ' + (LOJAS_NOMES[ln] || '') + (nReg ? ' (conferência ' + nReg + ')' : '') + ' e precisa da sua decisão:'];
  for (const i of pend || []) L.push('• ' + i.descricao + ' — ' + i.motivo_txt);
  L.push('Decida em Pedidos de Compra (Aceitar / Recusar). A conferência fica travada até isso.');
  return L.join('\n');
}

module.exports = { origemDe, quemDecide, compradorDe, obsDe, motivoDiverg, pendenciasLoja, entregaPrevista, situacaoLoja, conferenciaDe, itensLoja, pedidosAReceber, textoCobranca, textoAvisoCompradora, MOTIVO_TXT, ORIGEM_TXT, LOJAS_NOMES, SOME_SEM_NOTA_DIAS, PARCIAL_DIAS };
