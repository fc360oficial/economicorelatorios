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
// Pedido com compradora: falta/parcial NÃO precisam — viram pendência do fornecedor (sugestão de ruptura).
// Pedido de COTAÇÃO (cotacao=true, 16/10/2026, Tiago: "cotação ele não chega depois, é aceitar parcial e saber que não vem
// mais"): falta/parcial É decisão do fiscal — "não vem mais" (acao 'nao_vem', botão Aceitar parcial) ou recusar a entrega
// inteira (x.entrega_recusada). Não existe 2ª entrega. Bonificação não passa pelo pedido.
function motivoDiverg(i, naoPedido, cotacao) {
  if (naoPedido) return 'nao_pedido';
  if (i.tipo === 'a_mais') return 'a_mais';
  if (i.preco_status === 'maior') return 'preco';
  if (cotacao && (i.tipo === 'falta' || i.tipo === 'parcial')) return 'falta';
  return null;
}
const MOTIVO_TXT = { nao_pedido: 'item não pedido', a_mais: 'veio a mais', preco: 'preço acima do combinado', falta: 'não veio na nota' };
/** Pendências de UMA loja do pedido: { pendentes: [...], decididas: n, total: n }. Loja conciliada não tem pendência.
 *  cotacao=true inclui as faltas (decisão do fiscal: não vem mais). */
function pendenciasLoja(x, cotacao) {
  const out = { pendentes: [], decididas: 0, total: 0 };
  if (!x || x.status !== 'consistencia') return out;
  const olhar = (i, naoPedido) => {
    const m = motivoDiverg(i, naoPedido, cotacao); if (!m) return;
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
// ISO (UTC) → 'DD/MM HH:MM' no horário de Pernambuco
function dmhIso(iso) { try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).replace(',', ''); } catch (e) { return ''; } }
/** Itens da loja que não vieram (ou vieram a menos) na nota. */
function faltasLoja(x) { return (x?.itens || []).filter(i => i.tipo === 'falta' || i.tipo === 'parcial'); }
/** Pedido de cotação: o fiscal já aceitou o parcial (toda falta decidida como "não vem mais"). */
function parcialAceito(x) { const f = faltasLoja(x); return f.length > 0 && f.every(i => i.decisao && i.decisao.acao === 'nao_vem'); }
/** Recusa da entrega pelo fiscal, válida enquanto as notas da loja forem as mesmas que ele recusou (nota nova → fluxo normal). */
function entregaRecusada(x) {
  const r = x?.entrega_recusada; if (!r || !(x.notas || []).length) return null;
  const ch = new Set(r.chaves || []);
  return (x.notas || []).every(n => ch.has(n.chave)) ? r : null;
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
  const cot = quemDecide(p) === 'fiscal';
  const pend = pendenciasLoja(x, cot);
  const faltas = +(x?.faltas || 0);
  const nConf = conferenciaDe(x);
  const nfs = 'NF ' + (x?.notas || []).map(n => n.nNota).join(', ');
  const nFalta = faltasLoja(x).length;
  // pedaço da situação sobre as faltas (só cotação): decidido ("não vem mais") ou ainda pra decidir
  const txtFalta = cot && nFalta ? (parcialAceito(x) ? ' · parcial aceito pelo fiscal · ' + nFalta + ' item(ns) não vem mais' : ' · ' + nFalta + ' item(ns) não vem') : '';
  if (!x || x.status === 'aguardando' || !(x.notas || []).length) {
    // fechado pelo fiscal como NÃO ENTREGUE (cotação velha sem nota — painel Cotações, 16/10/2026): sai da aba. Nota que aparecer
    // depois (XML ou chave bipada) reabre, porque aí a entrega aconteceu.
    const b = (x && x.bipada && x.bipada.chaves) || [];
    if (x && x.nao_entregue && !b.length) return { codigo: 'fechado', texto: 'Não entregue · fechado pelo fiscal' + (x.nao_entregue.em ? ' ' + dmhIso(x.nao_entregue.em) : ''), sub: '', atraso: 0, nConferencia: null, pendentes: 0, faltas: 0, nao_entregue: true };
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
  // entrega devolvida inteira (contranota do fornecedor cobre tudo que veio — 16/10/2026, Aujo #94): fecha, sai da aba, não pagar o boleto
  if (x.status === 'devolvida') {
    const d = x.devolvida || {};
    return { codigo: 'fechado', texto: 'Entrega devolvida' + (d.em ? ' ' + String(d.em).slice(8, 10) + '/' + String(d.em).slice(5, 7) : ''), sub: nfs + ' devolvida pela NF ' + (d.notas || []).map(n => n.nNota).join(', ') + ' · nada ficou na loja · não pagar o boleto', atraso: 0, nConferencia: nConf, pendentes: 0, faltas: 0, devolvida: true };
  }
  const fechouFiscal = x.aceito || x.fiscal_liberou;
  const fechouLoja = !!(x.chegou && x.chegou.fechada);
  const rec = entregaRecusada(x);
  if (rec && !fechouFiscal && !fechouLoja) {
    return { codigo: 'entrega_recusada', texto: 'Entrega recusada pelo fiscal' + (rec.em ? ' ' + dmhIso(rec.em) : ''),
      sub: nfs + ' · ' + nFalta + ' item(ns) não vieram · a loja não recebe · vendedor cobrado' + (nConf ? ' · conferência ' + nConf : '') + ' · feche a loja quando o fornecedor resolver',
      atraso: 0, nConferencia: nConf, pendentes: 0, faltas };
  }
  if (fechouFiscal || fechouLoja) {
    const quem = x.aceito ? (x.aceito.papel === 'fiscal' ? 'Liberado pelo fiscal' : 'Aceito pelo (a) Comprador (a)') : x.fiscal_liberou ? 'Liberado pelo fiscal' : 'Fechado na loja';
    const em = (x.aceito?.em || x.fiscal_liberou?.em || x.chegou?.fechadaEm || '').slice(0, 10);
    if (!faltas || x.fiscal_fechou) return { codigo: 'fechado', texto: quem, sub: '', atraso: 0, nConferencia: nConf, pendentes: 0, faltas };
    // cotação não tem 2ª entrega (21/10/2026, Tiago #179): loja fechou no ERP, mas falta o fiscal decidir e liberar a conferência
    const subLib = cot ? (pend.pendentes.length ? pend.pendentes.length + ' item(ns) pra decidir · depois liberar a conferência' + (nConf ? ' ' + nConf : '') : 'tudo decidido · falta liberar a conferência' + (nConf ? ' ' + nConf : ''))
      : faltas + ' item(ns) faltaram · aguardando 2ª entrega ou fechar como "não vem mais"';
    return { codigo: 'liberado', texto: quem + (em ? ' ' + em.slice(8, 10) + '/' + em.slice(5, 7) : ''), sub: subLib, atraso: 0, nConferencia: nConf, pendentes: pend.pendentes.length, faltas };
  }
  if (x.chegou) {
    const h = horaChegou(x);
    const sub = [nConf ? 'conferência ' + nConf : null, pend.pendentes.length ? pend.pendentes.length + ' divergência(s) pra decidir' : (x.status === 'conciliado' ? 'bate com o pedido' : (x.problemas || []).length ? (x.problemas || []).map(z => z.msg).join(' · ') : null)].filter(Boolean).join(' · ') + (parcialAceito(x) ? txtFalta : '');
    return { codigo: 'nota_bipada', texto: 'Nota bipada na loja' + (h ? ' ' + dmh(h) : ''), sub, atraso: 0, nConferencia: nConf, pendentes: pend.pendentes.length, faltas };
  }
  const n0 = (x.notas || [])[0];
  // cotação: as faltas e demais divergências são decididas AQUI, antes do caminhão (16/10/2026)
  const txtPend = pend.pendentes.length ? ' · ' + pend.pendentes.length + (cot ? ' pra decidir antes da entrega' : ' divergência(s) já vista(s) no XML') : '';
  return { codigo: 'nota_emitida', texto: 'NF-e emitida · a caminho', sub: nfs + (n0?.data ? ' de ' + String(n0.data).slice(8, 10) + '/' + String(n0.data).slice(5, 7) : '') + txtFalta + txtPend, atraso, nConferencia: null, pendentes: pend.pendentes.length, faltas };
}
/** Texto do WhatsApp pro vendedor quando o fiscal recusa a entrega (pedido de cotação veio incompleto). */
function textoRecusaEntrega(p, ln) {
  const x = p.xml?.lojas?.[ln];
  const L = ['Olá' + (p.vendedor?.nome ? ' ' + p.vendedor.nome : '') + ', a ' + (x ? 'NF ' + (x.notas || []).map(n => n.nNota).join(', ') : 'nota') + ' do pedido #' + p.id + (p.lista_nome ? ' (' + p.lista_nome + ')' : '') + ' · Loja ' + ln + ' · ' + (LOJAS_NOMES[ln] || '') + ' (ECONOMICO SUPERMERCADO - REDE CAHU) veio incompleta:'];
  for (const i of faltasLoja(x)) L.push('• ' + i.descricao + ': pedido ' + i.pedida + ', veio ' + (i.recebida || 0));
  L.push('A loja NÃO vai receber esta entrega. Pedido de cotação não tem 2ª entrega: favor completar o pedido e emitir nova nota. Obrigado!');
  return L.join('\n');
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
        itens_lista: its,
        // 16/10/2026: decisão do fiscal na própria aba (cotação) — itens da nota fora do pedido, parcial aceito, entrega recusada
        itens_nao_pedidos: (p.xml?.lojas?.[ln]?.nao_pedidos || []).map(i => ({ cod: i.cod, descricao: i.descricao || '', recebida: i.recebida, preco_xml: i.preco_xml ?? null, decisao: i.decisao || null })),
        parcial_aceito: parcialAceito(p.xml?.lojas?.[ln]), faltas_lista: faltasLoja(p.xml?.lojas?.[ln]).map(i => ({ cod: i.cod, descricao: i.descricao, pedida: i.pedida, recebida: i.recebida, decisao: i.decisao || null })),
        entrega_recusada: (r => r ? { por: r.por || null, em: r.em || null } : null)(entregaRecusada(p.xml?.lojas?.[ln])),
        recusa_texto: decide === 'fiscal' && (p.xml?.lojas?.[ln]?.notas || []).length ? textoRecusaEntrega(p, ln) : null,
        // 16/10/2026: a conferência completa da loja (NF-e, financeiro, itens como vieram) — o Fiscal desenha o mesmo bloco de Pedidos de Compra
        xml_loja: p.xml?.lojas?.[ln] || null
      });
    }
  }
  const ORD = { nota_bipada: 0, bipada_sem_xml: 1, entrega_recusada: 2, liberado: 3, nota_emitida: 4, aguardando_nota: 5 };
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

/**
 * Painel "Cotações" da aba Pedidos a receber (16/10/2026, Tiago: "virou 50 pedidos de cotação, tem algo mostrando chegou 45 e
 * faltou 5, nessa loja e tal fornecedor?"). Uma linha por cotação com pedido aberto, contagem por loja (e total) e a lista de
 * quem ainda não entregou (pra cobrar / fechar como não entregue). Conta TODOS os pedidos da cotação, inclusive os fechados.
 */
const COT_VELHA_DIAS = 15;   // cotação aprovada há mais de 15 d com pedido sem nota: "provavelmente não vem" (cotação não tem 2ª entrega)
function resumoCotacoes(listar, totaisLoja, { lojas, loja, hoje } = {}) {
  hoje = hoje || new Date().toISOString().slice(0, 10);
  const cots = {};
  for (const p of listar()) {
    if (p.teste || !ABERTOS.includes(p.status) || !p.cotacao || p.cotacao.id == null || origemDe(p) !== 'cotacao') continue;
    const c = cots[p.cotacao.id] || (cots[p.cotacao.id] = { id: +p.cotacao.id, nome: p.cotacao.nome || null, aprovadoEm: null, lojas: {} });
    const ap = (p.aprovadoEm || p.criadoEm || '').slice(0, 10);
    if (ap && (!c.aprovadoEm || ap < c.aprovadoEm)) c.aprovadoEm = ap;
    for (const ln of p.lojas || []) {
      if (loja && +ln !== +loja) continue;
      if (lojas && !lojas.includes(+ln)) continue;
      const L = c.lojas[ln] || (c.lojas[ln] = { loja: +ln, loja_nome: LOJAS_NOMES[ln] || ('Loja ' + ln), total: 0, entregues: 0, nao_entregues: 0, devolvidas: 0, a_entregar: 0, a_caminho: 0, bipada: 0, parcial: 0, recusada: 0, pendentes: [] });
      const s = situacaoLoja(p, ln, hoje);
      L.total++;
      if (s.codigo === 'fechado') { if (s.nao_entregue) L.nao_entregues++; else if (s.devolvida) L.devolvidas++; else L.entregues++; }
      else if (s.codigo === 'aguardando_nota') L.a_entregar++;
      else if (s.codigo === 'nota_emitida') L.a_caminho++;
      else if (s.codigo === 'nota_bipada' || s.codigo === 'bipada_sem_xml') L.bipada++;
      else if (s.codigo === 'liberado') L.parcial++;
      else if (s.codigo === 'entrega_recusada') L.recusada++;
      if (s.codigo === 'aguardando_nota' || s.codigo === 'nota_emitida') {
        const t = totaisLoja(p, ln);
        const r = { pedido: p.id, loja: +ln, loja_nome: LOJAS_NOMES[ln] || ('Loja ' + ln), fornecedor: p.fornecedor || '', lista_nome: p.lista_nome || null, situacao: s.codigo, situacao_txt: s.texto, situacao_sub: s.sub,
          dias: ap ? diasEntre(ap, hoje) : 0, entrega_prevista: entregaPrevista(p), atraso: s.atraso, itens: t.itens, valor: t.com_preco ? t.digitado : t.ultimo_custo,
          vendedor: p.vendedor ? { nome: p.vendedor.nome || null, whats: p.vendedor.whats || null } : null };
        r.texto = textoCobranca(r);
        L.pendentes.push(r);
      }
    }
  }
  const K = ['total', 'entregues', 'nao_entregues', 'devolvidas', 'a_entregar', 'a_caminho', 'bipada', 'parcial', 'recusada'];
  return Object.values(cots).map(c => {
    const L = Object.values(c.lojas).sort((a, b) => a.loja - b.loja);
    const tot = Object.fromEntries(K.map(k => [k, 0]));
    for (const l of L) { for (const k of K) tot[k] += l[k]; l.pendentes.sort((a, b) => b.dias - a.dias || a.fornecedor.localeCompare(b.fornecedor, 'pt-BR')); }
    const dias = c.aprovadoEm ? diasEntre(c.aprovadoEm, hoje) : 0;
    return { id: c.id, nome: c.nome, aprovadoEm: c.aprovadoEm, dias, velha: dias > COT_VELHA_DIAS, ...tot, abertos: tot.total - tot.entregues - tot.nao_entregues - tot.devolvidas, lojas: L };
  }).filter(c => c.total > 0 && c.abertos > 0).sort((a, b) => b.id - a.id);
}

module.exports = { origemDe, quemDecide, compradorDe, obsDe, motivoDiverg, pendenciasLoja, entregaPrevista, situacaoLoja, conferenciaDe, itensLoja, pedidosAReceber, resumoCotacoes, textoCobranca, textoAvisoCompradora, textoRecusaEntrega, faltasLoja, parcialAceito, entregaRecusada, MOTIVO_TXT, ORIGEM_TXT, LOJAS_NOMES, SOME_SEM_NOTA_DIAS, PARCIAL_DIAS, COT_VELHA_DIAS };
