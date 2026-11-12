// Ensaio do robô de compras + precificação (Tiago, 11/11/2026: "vamos fazer esse teste amanhã... em vez do robô mandar
// pro fornecedor, mandar pra mim como teste, e eu aprovando as etapas e vendo no ERP teste").
//
// O ciclo é o mesmo das telas que já existem; o ensaio só troca DUAS coisas:
//   1) o pedido não vai pro vendedor: o link vai pro WhatsApp do Tiago (bot central, rota /mensagem-alerta), e ele
//      digita os preços no lugar do fornecedor;
//   2) a nota fiscal é SIMULADA (data/xml-teste/<id>.json, o mesmo mecanismo dos pedidos de teste da conferência XML),
//      igual ao pedido com os preços digitados.
// O pedido nasce com p.teste = true (nenhuma tela de compradora/fiscal conta com ele, nenhuma nota real casa com ele,
// nenhum vendedor é avisado) e p.ensaio = {...} (não é apagado pelo "remover testes"; a carga agendada de preço NÃO vai
// sozinha: espera aprovação — ver precificacao.enviarCargasPendentes).
// Gravações: só no MySQL de TESTE do .254, pelas rotas de sempre (pedido aprovado → pedidocompra; preço aprovado →
// Carga de Itens), tudo em Processos › Log. Nada toca o .252.
//
// Etapas (quem age): 1 robô monta · 2 robô envia (pra você) · 3 VOCÊ responde preços (como fornecedor) · 4 VOCÊ aprova a
// compra → ERP teste · 5 VOCÊ simula a chegada da nota · 6 robô calcula o preço de venda · 7 VOCÊ aprova o preço → ERP teste.
const fs = require('fs');
const path = require('path');

let deps = null;   // { radarPedidos, pedidosFornec, precificacao, roboPrecif, cadastroLista, linkPedido, publicUrl, zap(texto), verificarRecebimentos, testeDir }
const LOJAS_PADRAO = [1, 2];
const LJ = n => (+n === 10 ? 'CD' : 'E' + n);
const brl = v => 'R$ ' + (+v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const VIVO = ['aguardando', 'digitacao', 'finalizado', 'aprovado', 'recebido_parcial', 'recebido'];

function init(d) { deps = d; }

function listasRobo() { return deps.roboPrecif.listasRobo().flatMap(l => (l.ids || []).map(id => ({ id: +id, grupo: l.nome || l.chave }))); }
let opCache = { em: 0, chave: '', linhas: null };   // 12/11/26: com todas as listas a conta é grande e a tela pergunta a cada 15 s → guarda 2 min
const morto = p => p.status === 'cancelado' || !!(p.ensaio && p.ensaio.encerradoEm);
function ensaios() { return deps.pedidosFornec.listar().filter(p => p.ensaio).sort((a, b) => b.id - a.id); }
function registrosDe(p) { return (p.lojas || []).map(ln => deps.precificacao.obter(deps.precificacao.idDe(p.id, ln))).filter(Boolean); }

/** O que o robô pediria HOJE em cada lista dele, só nas lojas do ensaio. Só leitura (cálculo do Radar de Pedidos). */
function opcoes(lojas = LOJAS_PADRAO) {
  const vivos = new Set(ensaios().filter(p => !concluido(p) && !morto(p)).map(p => +p.lista));
  const chave = lojas.join(',');
  if (opCache.linhas && opCache.chave === chave && Date.now() - opCache.em < 120000) return opCache.linhas.map(o => ({ ...o, em_ensaio: vivos.has(o.lista) }));
  const out = [], todas = listasRobo(), muitas = todas.length > 20;
  for (const l of todas) {
    let det = null;
    try { det = deps.radarPedidos.itensLista(l.id, deps.radarPedidos.TETO_PADRAO, 0, undefined, true, null, { loja: lojas }); } catch (e) { det = null; }
    if (!det) { if (!muitas) out.push({ lista: l.id, grupo: l.grupo, nome: null, erro: 'lista fora do Radar (ou Radar calculando)' }); continue; }
    const pede = det.itens.filter(i => i.qtd > 0), semCx = pede.filter(i => !(i.emb > 1) && !(i.emb_manual >= 1));
    const total = pede.reduce((s, i) => s + (i.total || 0), 0);
    out.push({ lista: l.id, grupo: l.grupo, nome: det.lista.nome, fornecedor: det.lista.fornecedor, itens: pede.length, sem_embalagem: semCx.length, total: +total.toFixed(2),
      pedido_minimo: det.lista.pedidoMinimo || null, fazer_em: det.fazer_em, em_ensaio: vivos.has(l.id) });
  }
  out.sort((a, b) => (b.itens > 0) - (a.itens > 0) || (b.total || 0) - (a.total || 0));
  const linhas = muitas ? out.filter(o => o.itens > 0 || o.em_ensaio) : out;   // loja completa: só as listas que têm o que pedir hoje
  if (linhas.length) opCache = { em: Date.now(), chave, linhas };
  return linhas;
}

async function zap(p, etapa, texto) {
  const av = { etapa, em: new Date().toISOString(), ok: false };
  try { await deps.zap('🤖 Robô de Compras (ENSAIO): ' + texto); av.ok = true; } catch (e) { av.erro = e.message; }
  const atual = deps.pedidosFornec.obter(p.id); if (!atual || !atual.ensaio) return av;
  atual.ensaio.avisos = [...(atual.ensaio.avisos || []), av]; deps.pedidosFornec.salvar(atual);
  return av;
}
const avisou = (p, etapa) => (p.ensaio.avisos || []).some(a => a.etapa === etapa);

/** Etapa 1 + 2: o robô monta o pedido da lista (regra do Radar, só E1/E2) e manda o link pro Tiago no lugar do vendedor. */
async function gerar({ lista, lojas, usuario }) {
  lista = +lista; lojas = (Array.isArray(lojas) && lojas.length ? lojas : LOJAS_PADRAO).map(Number);
  if (!listasRobo().some(l => l.id === lista)) throw new Error('Lista ' + lista + ' não é uma lista do robô (Processos › Robô de Precificação)');
  const vivo = ensaios().find(p => +p.lista === lista && !morto(p) && !concluido(p));
  if (vivo) throw new Error('Já tem um ensaio em andamento nesta lista (pedido #' + vivo.id + '). Termine ou cancele antes de gerar outro.');
  const det = deps.radarPedidos.itensLista(lista, deps.radarPedidos.TETO_PADRAO, 0, undefined, true, null, { loja: lojas });
  if (!det) throw new Error('Lista fora do Radar de Pedidos (ou o Radar ainda está calculando)');
  // item sem embalagem padrão não entra (mesma trava da tela; aqui só fica de fora e é avisado)
  const fora = [];
  for (const it of det.itens) if (it.qtd > 0 && !(it.emb > 1) && !(it.emb_manual >= 1)) { fora.push(it.descricao); for (const ln of Object.keys(it.lojas_qtd || {})) it.lojas_qtd[ln] = 0; it.qtd = 0; it.volumes = 0; it.total = 0; }
  if (!det.itens.some(i => i.qtd > 0)) throw new Error('O robô não tem nada a pedir hoje nesta lista pras lojas ' + lojas.map(LJ).join(' e ') + (fora.length ? ' (' + fora.length + ' item(ns) sem embalagem padrão ficaram de fora)' : ''));
  const cad = await deps.cadastroLista(lista).catch(() => null);
  const p = deps.pedidosFornec.criar({ lista: det.lista, cadastro: cad, detalhe: det, teto: deps.radarPedidos.TETO_PADRAO, usuario: 'ROBÔ DE COMPRAS', modo: 'completa', origem: 'radar', status: 'aguardando' });
  p.teste = true;
  p.parametros.origem = 'robo';
  p.ensaio = { criadoEm: p.criadoEm, por: usuario || null, lojas, vendedor_real: p.vendedor || null, sem_embalagem: fora, avisos: [] };
  p.vendedor = { nome: 'Tiago (ensaio do robô)', whats: '' };   // o vendedor de verdade nunca é avisado
  p.enviadoEm = new Date().toISOString(); p.enviadoPor = 'ROBÔ DE COMPRAS';
  deps.pedidosFornec.salvar(p);
  const av = await zap(p, 'pedido', 'montei o pedido #' + p.id + ' da lista ' + p.lista_nome + ' (' + p.itens.length + ' itens, ' + brl(p.totais && p.totais.total_ultimo != null ? p.totais.total_ultimo : totalUltimo(p)) + ' pelo último custo, lojas ' + p.lojas.map(LJ).join(' e ') + '). Você é o fornecedor neste teste: abra o link, digite os preços e finalize: ' + deps.linkPedido(p));
  return { id: p.id, link: deps.linkPedido(p), whatsapp: av, sem_embalagem: fora };
}
function totalUltimo(p) { return p.itens.reduce((s, i) => s + (i.qtd || 0) * (i.ultimo_custo || 0), 0); }
function totalDigitado(p) { return p.itens.reduce((s, i) => s + (i.qtd || 0) * (i.preco || 0), 0); }

// registro de preço resolvido: gravado no ERP teste, ou lista fechada em que nenhum preço muda (nada a gravar)
const precifErp = require('./precificacao-erp');
function precoResolvido(r) { if (['aplicado', 'conferido'].includes(r.status)) return true; if (r.status !== 'precificado') return false; try { return !precifErp.itensParaCarga(r).length; } catch (e) { return false; } }
function notaConciliada(p) { const L = p.xml && p.xml.lojas || {}; return (p.lojas || []).length > 0 && (p.lojas || []).every(ln => L[ln] && L[ln].status === 'conciliado'); }
function concluido(p) { const rs = registrosDe(p); return notaConciliada(p) && rs.length === (p.lojas || []).length && rs.every(precoResolvido); }

/** Linha do tempo do ensaio: 7 etapas, cada uma 'feito' | 'agora' (alguém precisa agir) | 'espera'. */
function etapas(p) {
  const rs = registrosDe(p), erp = (p.erp_teste && p.erp_teste.lojas) || {}, erros = (p.erp_teste && p.erp_teste.erros) || [];
  const respondeu = !!p.finalizadoEm, aprovado = !!p.aprovadoEm, noErp = (p.lojas || []).length > 0 && (p.lojas || []).every(ln => erp[ln] && erp[ln].nReg);
  const nota = notaConciliada(p), temNota = !!(p.ensaio.nota_simulada_em), calculou = rs.length === (p.lojas || []).length && rs.length > 0;
  const gravado = calculou && rs.every(precoResolvido);
  const zapPedido = (p.ensaio.avisos || []).find(a => a.etapa === 'pedido');
  const E = [
    { n: 1, quem: 'robô', titulo: 'Robô montou o pedido', feito: true, em: p.criadoEm,
      detalhe: p.itens.length + ' itens · ' + brl(totalUltimo(p)) + ' pelo último custo · lojas ' + (p.lojas || []).map(LJ).join(' e ') + (p.ensaio.sem_embalagem && p.ensaio.sem_embalagem.length ? ' · ' + p.ensaio.sem_embalagem.length + ' item(ns) sem embalagem ficaram de fora' : '') },
    { n: 2, quem: 'robô', titulo: 'Pedido enviado (no ensaio: pra você, não pro fornecedor)', feito: true, em: p.enviadoEm || p.criadoEm,
      detalhe: zapPedido ? (zapPedido.ok ? 'link mandado no seu WhatsApp' : 'WhatsApp falhou (' + zapPedido.erro + '): use o link desta tela') : 'link nesta tela' },
    { n: 3, quem: 'você', titulo: 'Fornecedor responde os preços', feito: respondeu, em: p.finalizadoEm || null,
      detalhe: respondeu ? 'preços digitados: ' + brl(totalDigitado(p)) : 'abra o link do pedido, digite o preço de cada item e finalize', acao: 'link' },
    { n: 4, quem: 'você', titulo: 'Compra aprovada e pedido gravado no ERP de teste', feito: aprovado && noErp, em: aprovado ? p.aprovadoEm : null,
      detalhe: aprovado ? (noErp ? 'pedido no ERP teste: ' + (p.lojas || []).map(ln => LJ(ln) + ' nº ' + erp[ln].nReg).join(' · ') : 'aprovado, mas o ERP teste recusou: ' + (erros.map(e => LJ(e.loja) + ' ' + e.erro).join(' · ') || 'gravando…')) : 'em Pedidos de Compra: confira os preços, preencha a "Obs. pro Fiscal" e aprove', acao: 'pedidos' },
    { n: 5, quem: 'você', titulo: 'Nota fiscal chegou (simulada)', feito: nota, em: nota ? (p.ensaio.nota_simulada_em || null) : null,
      detalhe: nota ? 'nota conferida com o pedido nas lojas ' + (p.lojas || []).map(LJ).join(' e ') : temNota ? 'nota simulada criada; conferindo com o pedido…' : 'clique em "Simular chegada da nota": cria uma nota igual ao pedido, com os preços digitados', acao: 'nota' },
    { n: 6, quem: 'robô', titulo: 'Robô calculou o preço de venda', feito: calculou, em: calculou ? rs[0].criadoEm : null,
      detalhe: calculou ? rs.map(r => LJ(r.loja) + ': ' + (r.itens || []).length + ' itens').join(' · ') : 'acontece sozinho quando a nota é conferida' },
    { n: 7, quem: 'você', titulo: 'Preço aprovado e gravado no ERP de teste', feito: gravado, em: gravado ? rs.map(r => r.aplicadoEm || '').sort().pop() || null : null,
      detalhe: gravado ? rs.map(r => LJ(r.loja) + ': ' + (r.erp_teste && r.erp_teste.logId ? (r.erp_teste.itens + ' preço(s) gravado(s), Log ' + r.erp_teste.logId) : 'nenhum preço mudou')).join(' · ') : 'em Formação de Preço: confira os preços calculados, feche a lista de cada loja e clique "Enviar pra carga"' + (rs.length ? ' · ' + rs.map(r => LJ(r.loja) + (precoResolvido(r) ? ' pronta' : ' falta')).join(', ') : ''), acao: 'precos' }
  ];
  const PEDE = { 3: 'digitar os preços como fornecedor', 4: 'aprovar a compra', 5: 'simular a chegada da nota', 7: 'aprovar o preço de venda' };
  let achou = false;
  for (const e of E) { e.pede = PEDE[e.n] || null; e.status = e.feito ? 'feito' : achou ? 'espera' : 'agora'; if (!e.feito) achou = true; delete e.feito; }
  return E;
}

function visao(p) {
  const E = etapas(p), agora = E.find(e => e.status === 'agora') || null;
  return { id: p.id, lista: p.lista, lista_nome: p.lista_nome, fornecedor: p.fornecedor, lojas: p.lojas || [], status: p.status, criadoEm: p.criadoEm, itens: p.itens.length,
    total_ultimo: +totalUltimo(p).toFixed(2), total_digitado: +totalDigitado(p).toFixed(2), link: deps.linkPedido(p), cancelado: morto(p), concluido: !agora,
    registros: registrosDe(p).map(r => ({ id: r.id, loja: r.loja, status: r.status, logId: (r.erp_teste && r.erp_teste.logId) || null })),
    erp_pedido: Object.fromEntries(Object.entries((p.erp_teste && p.erp_teste.lojas) || {}).map(([ln, x]) => [ln, { nReg: x.nReg, logId: x.logId }])),
    etapas: E, agora: agora ? { n: agora.n, quem: agora.quem, titulo: agora.titulo, detalhe: agora.detalhe, pede: agora.pede } : null };
}
function consultar() { return { lojas: LOJAS_PADRAO, ensaios: ensaios().slice(0, 20).map(visao), geradoEm: new Date().toISOString() }; }

/** Pro painel da TV: só o que está em andamento (ou terminou hoje). Sem link (o painel é público). */
function painel() {
  const hoje = new Date().toISOString().slice(0, 10);
  return ensaios().filter(p => !morto(p)).map(visao).filter(v => !v.concluido || (v.etapas[6].em || '').slice(0, 10) === hoje).slice(0, 3)
    .map(v => ({ id: v.id, lista_nome: v.lista_nome, fornecedor: v.fornecedor, lojas: v.lojas, itens: v.itens, total: v.total_digitado || v.total_ultimo, concluido: v.concluido, agora: v.agora,
      etapas: v.etapas.map(e => ({ n: e.n, quem: e.quem, titulo: e.titulo, detalhe: e.detalhe, status: e.status, em: e.em })) }));
}

/** Etapa 5: cria a nota simulada (igual ao pedido, preços digitados) e roda a conferência. */
async function simularNota(id) {
  const p = deps.pedidosFornec.obter(+id);
  if (!p || !p.ensaio) throw new Error('Ensaio não encontrado');
  if (!p.aprovadoEm) throw new Error('Aprove a compra antes (etapa 4): a nota só chega depois do pedido aprovado');
  if (notaConciliada(p)) throw new Error('A nota deste ensaio já foi conferida');
  const hoje = new Date().toISOString().slice(0, 10), venc = new Date(Date.now() + 28 * 864e5).toISOString().slice(0, 10);
  const notas = {};
  for (const ln of p.lojas || []) {
    const itens = p.itens.filter(i => (i.lojas_qtd && i.lojas_qtd[ln]) > 0).map((i, k) => {
      const un = +i.lojas_qtd[ln], preco = +(i.preco || i.ultimo_custo || 0), emb = i.emb || 1;
      return { item: k + 1, cod: i.cod, descricao: i.descricao, und: emb > 1 ? 'CX' : 'UN', qtdCom: +(un / emb).toFixed(4), unidades: un, precoUnit: preco, total: +(un * preco).toFixed(2), desconto: 0 };
    });
    if (!itens.length) { notas[ln] = []; continue; }
    const valor = +itens.reduce((s, i) => s + i.total, 0).toFixed(2), nNota = 900000 + p.id * 10 + (+ln);
    notas[ln] = [{ chave: 'TESTE' + String(nNota).padStart(39, '0'), nNota, serie: '1', data: hoje, cnpjEmit: '00000000000000', emitente: (p.fornecedor || 'FORNECEDOR') + ' (nota simulada do ensaio)',
      valorNFE: valor, valorProduto: valor, desconto: 0, frete: 0, ipi: 0, st: 0, importado: true, status: 0, itens, boletos: [{ dup: 1, vencimento: venc, valor }] }];
  }
  fs.mkdirSync(deps.testeDir, { recursive: true });
  fs.writeFileSync(path.join(deps.testeDir, p.id + '.json'), JSON.stringify(notas));
  p.ensaio.nota_simulada_em = new Date().toISOString(); deps.pedidosFornec.salvar(p);
  await deps.conferirPedido(p.id);
  // o gancho da conciliação cria os registros de preço sem esperar: dá um tempo curto pra eles aparecerem
  for (let k = 0; k < 20; k++) { const a = deps.pedidosFornec.obter(p.id); if (notaConciliada(a) && registrosDe(a).length === (a.lojas || []).length) break; await new Promise(r => setTimeout(r, 500)); }
  return visao(deps.pedidosFornec.obter(p.id));
}

/** Abandona um ensaio no meio: antes da aprovação cancela o pedido; depois, só marca como encerrado (o que já foi pro ERP de teste fica no Log). */
function encerrar(id, usuario) {
  const p = deps.pedidosFornec.obter(+id); if (!p || !p.ensaio) throw new Error('Ensaio não encontrado');
  if (!['aprovado', 'recebido_parcial', 'recebido', 'cancelado'].includes(p.status)) { const r = deps.pedidosFornec.cancelar(p.id, usuario, 'ensaio do robô cancelado'); if (r && r.erro) throw new Error(r.erro); return { ok: true }; }
  p.ensaio.encerradoEm = new Date().toISOString(); p.ensaio.encerradoPor = usuario || null; deps.pedidosFornec.salvar(p); return { ok: true };
}

/** Avisos no WhatsApp quando chega a vez do Tiago (uma vez por etapa). Chamado de tempos em tempos pelo server.js. */
async function vigiar() {
  for (const p of ensaios()) {
    if (morto(p) || !VIVO.includes(p.status)) continue;
    try {
      const E = etapas(p), ag = E.find(e => e.status === 'agora'); if (!ag) { if (!avisou(p, 'fim')) await zap(p, 'fim', 'ensaio do pedido #' + p.id + ' (' + p.lista_nome + ') terminou: compra e preços gravados no ERP de teste. Veja o resumo em ' + deps.publicUrl + '/robo-ensaio.html'); continue; }
      if (ag.n === 4 && !avisou(p, 'aprovar_compra')) await zap(p, 'aprovar_compra', 'o fornecedor respondeu o pedido #' + p.id + ' (' + p.lista_nome + '): ' + brl(totalDigitado(p)) + '. Falta você aprovar a compra em Pedidos de Compra: ' + deps.publicUrl + '/robo-ensaio.html');
      if (ag.n === 7 && !avisou(p, 'aprovar_preco')) await zap(p, 'aprovar_preco', 'a nota do pedido #' + p.id + ' (' + p.lista_nome + ') foi conferida e eu calculei os preços de venda. Falta você aprovar em Formação de Preço: ' + deps.publicUrl + '/robo-ensaio.html');
    } catch (e) { console.error('[ROBO-ENSAIO] vigiar', p.id, e.message); }
  }
}

module.exports = { init, opcoes, gerar, consultar, painel, simularNota, encerrar, vigiar, etapas, LOJAS_PADRAO };
