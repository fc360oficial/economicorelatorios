// Cotação de compra (Gestão de Compras > Cotação).
//
// Fluxo definido pelo Tiago (14/09/2026):
//   1. comprador(a) digita o nº da lista do ERP (ex.: 277 "Cotação de Alimentos") e o sistema monta a
//      sugestão de compra com as regras do Radar (loja a loja, piso/teto, embalagem real); lista sem
//      lead time usa a cobertura e o prazo de entrega digitados na tela
//   2. escolhe os fornecedores concorrentes; cada um recebe um link único (token) pra digitar o
//      preço unitário por item — não vê o custo da loja nem os preços dos outros
//   3. comparativo fornecedor a fornecedor: o menor preço vence por item; a comprador(a) pode trocar
//      o vencedor ou marcar "não comprar"
//   4. fechar a cotação gera 1 pedido por fornecedor vencedor em lib/pedidos-fornecedor (já com os
//      preços, status "finalizado") → tela Pedidos de Compra pra aprovar e conferir igual ao Radar
//
// Persistência: um JSON por cotação em data/cotacoes/. NADA é escrito no ERP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'data', 'cotacoes');
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };

function init() { fs.mkdirSync(DIR, { recursive: true }); }
const arq = id => path.join(DIR, `${id}.json`);
function salvar(c) { c.atualizadoEm = new Date().toISOString(); fs.writeFileSync(arq(c.id), JSON.stringify(c)); return c; }
function obter(id) { try { return JSON.parse(fs.readFileSync(arq(id), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
function proximoId() {
  const ids = fs.readdirSync(DIR).map(f => parseInt(f)).filter(n => !isNaN(n));
  return (ids.length ? Math.max(...ids) : 0) + 1;
}
// token é POR FORNECEDOR (cada convidado tem o seu link)
function porToken(token) {
  if (!/^[a-f0-9]{32}$/.test(token || '')) return null;
  for (const c of listar()) { const f = (c.fornecedores || []).find(x => x.token === token); if (f) return { c, f }; }
  return null;
}
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : null; };
const novoToken = () => crypto.randomBytes(16).toString('hex');

function normFornecedor(f) {
  const cod = parseInt(f.codFornec) || 0;
  const v = f.vendedor || {};
  return {
    codFornec: cod, codFornecErp: parseInt(f.codFornecErp) || cod, nome: String(f.nome || '').trim().slice(0, 120) || ('Fornecedor ' + cod),
    // empresa = nome da firma (sem o " · Vendedor"); vendedores da mesma empresa NÃO concorrem entre si: cada um cota seus
    // produtos e gera pedido e nota próprios (Tiago, 23/09/26)
    empresa: String(f.empresa || f.nome || '').trim().slice(0, 100) || ('Fornecedor ' + cod),
    vendedor: { nome: String(v.nome || '').trim().slice(0, 80) || null, whats: String(v.whats || '').replace(/\D/g, '').slice(0, 20) || null, email: String(v.email || '').trim().slice(0, 120) || null },
    // outros vendedores da mesma empresa (Tiago, 22/09): todos recebem o mesmo link; quem responder primeiro digita
    vendedores: (Array.isArray(f.vendedores) ? f.vendedores : []).map(x => ({ nome: String(x.nome || '').trim().slice(0, 80) || null, whats: String(x.whats || '').replace(/\D/g, '').slice(0, 20) || null, email: String(x.email || '').trim().slice(0, 120) || null })).filter(x => x.nome || x.whats).slice(0, 6),
    faturamento_minimo: num(f.faturamento_minimo) || null, condicao_padrao: String(f.condicao || '').trim().slice(0, 80) || null, prazo_entrega: num(f.prazo_entrega) || null,
    token: novoToken(), status: 'aguardando', convidadoEm: new Date().toISOString(), enviadoEm: null, abertoEm: null, finalizadoEm: null,
    precos: {}, condicao: null, obs: null
  };
}

// Empresa com 2+ vendedores (Tiago, 23/09/26: "a DIA tem 3 vendedores; na cotação aparecem 3 DIA, cada um digita seu preço
// e ninguém vê o preço de ninguém"): cada vendedor vira um CONCORRENTE separado — link/token, preços, vencedor e pedido
// próprios. Chave do concorrente (codFornec) = código do ERP pro 1º vendedor e código×1.000.000+k pros demais; o código real
// do ERP fica em codFornecErp (é ele que vai pro pedido, avarias, XML, histórico). Nome vira "EMPRESA · Vendedor".
function expandirFornecedor(f) {
  const cod = parseInt(f.codFornec) || 0;
  const extras = (Array.isArray(f.vendedores) ? f.vendedores : []).filter(v => v && (String(v.nome || '').trim() || String(v.whats || '').replace(/\D/g, '')));
  if (!extras.length) return [normFornecedor({ ...f, vendedores: [] })];
  const base = String(f.nome || '').trim().slice(0, 100) || ('Fornecedor ' + cod);
  const rotulo = v => { const n = String((v && v.nome) || '').trim() || String((v && v.whats) || '').replace(/\D/g, ''); return n ? base + ' · ' + n.slice(0, 40) : base; };
  const todos = [f.vendedor || {}].concat(extras);
  return todos.map((v, k) => normFornecedor({ ...f, codFornec: k === 0 ? cod : (cod > 0 ? cod * 1000000 + k : 0), codFornecErp: cod, empresa: base, nome: rotulo(v), vendedor: v, vendedores: [] }));
}

// cria a cotação a partir da sugestão (itens com quantidade POR LOJA) + fornecedores convidados
// Prazo com hora (Tiago, 23/09/26): 'YYYY-MM-DDTHH:MM' no horário do servidor; prazo antigo só com data vale até 23:59 daquele dia.
// Depois do prazo o vendedor não digita nem envia; comprador(a) libera adiando (setPrazo) no Acompanhamento.
function normPrazo(v) { const s = String(v || '').trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T23:59'; const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/); return m ? m[1] + 'T' + m[2] + ':' + m[3] : null; }
function prazoVencido(c) { const p = normPrazo(c && c.prazo); return !!p && Date.now() > new Date(p).getTime(); }
function fmtPrazo(p) { const n = normPrazo(p); if (!n) return ''; return n.slice(8, 10) + '/' + n.slice(5, 7) + '/' + n.slice(0, 4) + ' ' + n.slice(11, 16); }
function setPrazo(id, prazo, usuario) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status + ': o prazo não muda mais' };
  const p = normPrazo(prazo); if (!p) return { erro: 'Data e hora inválidas' };
  c.historicoPrazo = (c.historicoPrazo || []).concat([{ de: c.prazo || null, para: p, em: new Date().toISOString(), por: usuario || null }]).slice(-30);
  c.prazo = p; c.prazoAlteradoEm = new Date().toISOString(); c.prazoAlteradoPor = usuario || null;
  return salvar(c);
}
function criar({ nome, lista, lista_nome, comprador, prazo, parametros, itens, fornecedores, usuario }) {
  const its = (itens || []).map(i => {
    const lojas_qtd = {};
    for (const [ln, v] of Object.entries(i.lojas_qtd || {})) { const n = Math.max(0, Math.round(num(v) || 0)); if (n > 0) lojas_qtd[ln] = n; }
    const qtd = Object.values(lojas_qtd).reduce((s, v) => s + v, 0);
    const emb = Math.max(1, Math.round(num(i.emb) || 1));
    return {
      cod: String(i.cod), descricao: i.descricao || '', unid: i.unid || 'UN', emb, qtd, volumes: qtd ? Math.ceil(qtd / emb) : 0, lojas_qtd,
      ultimo_custo: num(i.ultimo_custo) ?? num(i.custo) ?? 0, estoque: num(i.estoque), venda_dia: num(i.venda_dia), cobertura_dias: num(i.cobertura_dias), curva_a: !!i.curva_a
    };
  }).filter(i => i.qtd > 0);
  if (!its.length) throw new Error('Nenhum item com quantidade por loja');
  const seen = new Set();
  const forns = (fornecedores || []).flatMap(expandirFornecedor).filter(f => { const k = f.codFornec || f.nome.toUpperCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  if (!forns.length) throw new Error('Nenhum fornecedor convidado');
  const c = {
    id: proximoId(), nome: String(nome || '').trim().slice(0, 120) || `Cotação lista ${lista}`,
    lista: parseInt(lista) || null, lista_nome: lista_nome || null, comprador: comprador || null, prazo: normPrazo(prazo),
    status: 'aberta', criadoEm: new Date().toISOString(), criadoPor: usuario || null,
    parametros: parametros || {}, itens: its, fornecedores: forns, vencedores: {}, pedidos: [],
    lojas: [...new Set(its.flatMap(i => Object.keys(i.lojas_qtd).map(Number)))].sort((a, b) => a - b)
  };
  c.totais = { itens: its.length, volumes: its.reduce((a, i) => a + i.volumes, 0), ultimo_custo: +its.reduce((a, i) => a + i.qtd * (i.ultimo_custo || 0), 0).toFixed(2) };
  return salvar(c);
}
function adicionarFornecedor(id, f) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status + ': não aceita mais fornecedores' };
  const nfs = expandirFornecedor(f).filter(nf => !(nf.codFornec && c.fornecedores.some(x => x.codFornec === nf.codFornec)));
  if (!nfs.length) return { erro: 'Fornecedor já convidado' };
  for (const nf of nfs) c.fornecedores.push(nf); salvar(c);
  return { c, f: nfs[0], adicionados: nfs };
}
function marcarEnviado(id, codFornec) {
  const c = obter(id); if (!c) return null;
  const f = c.fornecedores.find(x => x.codFornec === parseInt(codFornec) || x.token === codFornec);
  if (f) { f.enviadoEm = new Date().toISOString(); salvar(c); }
  return c;
}

// --- lado do fornecedor (público, por token) ---
function abrir(token) {
  const r = porToken(token); if (!r) return null;
  if (r.c.status === 'aberta' && r.f.status === 'aguardando') { r.f.status = 'digitacao'; r.f.abertoEm = new Date().toISOString(); salvar(r.c); }
  return r;
}
function salvarPrecos(token, itens, extra) {
  const r = porToken(token); if (!r) return null;
  const { c, f } = r;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status + ': não aceita mais preços' };
  if (!['aguardando', 'digitacao'].includes(f.status)) return { erro: 'Proposta já enviada: não aceita mais alteração' };
  if (prazoVencido(c)) return { erro: 'Prazo encerrado em ' + fmtPrazo(c.prazo) + ': não dá mais pra digitar. Fale com o(a) comprador(a) pra liberar.' };
  const cods = new Set(c.itens.map(i => i.cod));
  for (const n of itens || []) {
    const cod = String(n.cod); if (!cods.has(cod)) continue;
    const v = n.preco === '' || n.preco == null ? null : num(n.preco);
    const obs = typeof n.obs === 'string' ? n.obs.slice(0, 200) : (f.precos[cod]?.obs || '');
    const marca = typeof n.marca === 'string' ? n.marca.trim().slice(0, 60) : (f.precos[cod]?.marca || '');
    // embalagem informada pelo vendedor ("emb. correta?", igual ao pedido do Radar) — só observação, a comprador(a) decide
    const emb_vendedor = typeof n.emb_vendedor === 'string' ? n.emb_vendedor.trim().slice(0, 20) : (f.precos[cod]?.emb_vendedor || '');
    if (v == null) { if (obs || marca || emb_vendedor) f.precos[cod] = { preco: null, obs, marca, emb_vendedor }; else delete f.precos[cod]; }
    else if (v >= 0) f.precos[cod] = { preco: +v.toFixed(4), obs, marca, emb_vendedor };
  }
  if (extra) {
    if (typeof extra.condicao === 'string') f.condicao = extra.condicao.trim().slice(0, 80) || null;
    if (typeof extra.obs === 'string') f.obs = extra.obs.trim().slice(0, 500) || null;
  // "Estamos atualizando nosso cadastro de fornecedor" (Tiago, 23/09/26): e-mail, prazo de pagamento (dias de boleto), tempo de
  // entrega (dias) e pedido mínimo (R$) — obrigatórios pra enviar a proposta; a condição vira "Boleto N dias"
  if (extra && extra.cadastro && typeof extra.cadastro === 'object') {
    const cv = extra.cadastro, n = v => { const x = parseFloat(String(v ?? '').replace(/\./g, '').replace(',', '.')); return isFinite(x) ? x : null; };
    const pp = parseInt(cv.prazo_pagamento), pe = parseInt(cv.prazo_entrega), pm = n(cv.pedido_minimo);
    f.cadastro_vendedor = { email: String(cv.email || '').trim().slice(0, 120) || null, prazo_pagamento: pp > 0 ? pp : null, prazo_entrega: pe >= 0 ? pe : null, pedido_minimo: pm != null && pm >= 0 ? +pm.toFixed(2) : null, em: new Date().toISOString() };
    if (f.cadastro_vendedor.prazo_pagamento) f.condicao = 'Boleto ' + f.cadastro_vendedor.prazo_pagamento + ' dias';
  }
  }
  f.atualizadoEm = new Date().toISOString(); salvar(c);
  return r;
}
function cadastroFaltando(f) {
  const cv = f.cadastro_vendedor || {}; const faltam = [];
  if (!cv.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cv.email)) faltam.push('e-mail');
  if (!(cv.prazo_pagamento > 0)) faltam.push('prazo de pagamento (dias)');
  if (!(cv.prazo_entrega >= 0)) faltam.push('tempo de entrega (dias)');
  if (!(cv.pedido_minimo >= 0)) faltam.push('pedido mínimo (R$)');
  return faltam;
}
function finalizar(token, nome) {
  const r = porToken(token); if (!r) return null;
  const { c, f } = r;
  if (c.status !== 'aberta' || !['aguardando', 'digitacao'].includes(f.status) || prazoVencido(c)) return r;
  const faltam = cadastroFaltando(f); if (faltam.length) return { ...r, erro: 'Antes de enviar, preencha: ' + faltam.join(', ') };
  f.status = 'finalizado'; f.finalizadoEm = new Date().toISOString(); f.finalizadoPor = (nome || '').slice(0, 80) || null;
  salvar(c);
  return r;
}
// versão pro fornecedor: sem custo do ERP e sem os preços dos concorrentes
function visaoVendedor(c, f) {
  return {
    id: c.id, nome: c.nome, status: c.status, prazo: normPrazo(c.prazo), prazo_vencido: prazoVencido(c), criadoEm: c.criadoEm,
    comprador: c.comprador ? { nome: c.comprador.nome || null, whats: c.comprador.whats || null } : null,
    mensagem: c.mensagem || null, mensagemEm: c.mensagemEm || null,
    fornecedor: { nome: f.nome, status: f.status, vendedor: f.vendedor ? { nome: f.vendedor.nome, email: f.vendedor.email || null } : null, finalizadoEm: f.finalizadoEm, condicao: f.condicao, obs: f.obs, condicao_padrao: f.condicao_padrao || null, prazo_entrega: f.prazo_entrega || null, cadastro_vendedor: f.cadastro_vendedor || null, faturamento_minimo: f.faturamento_minimo || null, cadastro: f.cadastro_vendedor || null },
    lojas: c.lojas, lojas_nomes: LOJAS_NOMES,
    cotados: c.itens.filter(i => f.precos[i.cod]?.preco != null).length,
    itens: c.itens.map(i => ({ cod: i.cod, descricao: i.descricao, unid: i.unid, emb: i.emb, qtd: i.qtd, volumes: i.volumes, lojas_qtd: i.lojas_qtd, preco: f.precos[i.cod]?.preco ?? null, obs: f.precos[i.cod]?.obs || '', marca: f.precos[i.cod]?.marca || '', emb_vendedor: f.precos[i.cod]?.emb_vendedor || '' }))
  };
}

// --- comparativo (comprador(a)): menor preço vence por item, salvo escolha manual em c.vencedores
//     c.vencedores[cod]: ausente = automático · null = não comprar · número = codFornec escolhido
// Pedido realizado é travado: nem o item sai dele, nem entra item novo, nem muda quantidade (Tiago, 21/09).
function fornecedoresRealizados(c) {
  const s = new Map();
  for (const p of (c.pedidos || [])) s.set(+p.codFornec, p.id);
  for (const [k, v] of Object.entries(c.prePedidos || {})) if (v && v.status === 'realizado') s.set(+k, v.pedidoId || s.get(+k) || true);
  return s;
}
function comparativo(c) {
  const realizados = fornecedoresRealizados(c);
  const forns = c.fornecedores.map(f => ({
    codFornec: f.codFornec, codFornecErp: f.codFornecErp || f.codFornec, empresa: f.empresa || f.nome, nome: f.nome, status: f.status, vendedor: f.vendedor, vendedores: f.vendedores || [], condicao: f.condicao, obs: f.obs, token: f.token,
    realizado: realizados.has(f.codFornec), pedidoId: realizados.get(f.codFornec) || null,
    enviadoEm: f.enviadoEm, abertoEm: f.abertoEm, finalizadoEm: f.finalizadoEm, faturamento_minimo: f.faturamento_minimo || null, condicao_padrao: f.condicao_padrao || null, prazo_entrega: f.prazo_entrega || null, cadastro_vendedor: f.cadastro_vendedor || null,
    cotados: c.itens.filter(i => f.precos[i.cod]?.preco != null).length,
    total: 0, itens_vencedor: 0, total_vencedor: 0, economia: 0
  }));
  const byCod = Object.fromEntries(forns.map(f => [f.codFornec, f]));
  let ultimoVenc = 0, totalVenc = 0, comPreco = 0, abaixo = 0, acima = 0, semVencedor = 0, naoComprar = 0;
  const escolhas = c.vencedores || {};
  const itens = c.itens.map(i => {
    const precos = {}; let melhor = null;
    for (const f of c.fornecedores) {
      const p = f.precos[i.cod]; if (p?.preco == null) continue;
      precos[f.codFornec] = { preco: p.preco, obs: p.obs || '', marca: p.marca || '', emb_vendedor: p.emb_vendedor || '' };
      byCod[f.codFornec].total += p.preco * i.qtd;
      if (!melhor || p.preco < melhor.preco) melhor = { codFornec: f.codFornec, preco: p.preco };
    }
    const escolha = Object.prototype.hasOwnProperty.call(escolhas, i.cod) ? escolhas[i.cod] : undefined;
    let vencedor = null, manual = false;
    if (escolha === null) naoComprar++;
    else if (escolha != null && precos[escolha]) { vencedor = { codFornec: escolha, preco: precos[escolha].preco }; manual = true; }
    else vencedor = melhor;
    if (Object.keys(precos).length) comPreco++;
    const ultimo = i.ultimo_custo || 0;
    let economia = null;
    if (vencedor) {
      const f = byCod[vencedor.codFornec];
      f.itens_vencedor++; f.total_vencedor += vencedor.preco * i.qtd; totalVenc += vencedor.preco * i.qtd;
      if (ultimo > 0) { ultimoVenc += ultimo * i.qtd; economia = +((ultimo - vencedor.preco) * i.qtd).toFixed(2); f.economia += ultimo - vencedor.preco > 0 ? (ultimo - vencedor.preco) * i.qtd : (ultimo - vencedor.preco) * i.qtd; if (vencedor.preco <= ultimo) abaixo++; else acima++; }
    } else if (escolha !== null) semVencedor++;
    const fechado = !!(vencedor && realizados.has(vencedor.codFornec));
    return { ...i, precos, melhor, vencedor, manual, nao_comprar: escolha === null, economia, total_vencedor: vencedor ? +(vencedor.preco * i.qtd).toFixed(2) : null, fechado, pedidoId: fechado ? realizados.get(vencedor.codFornec) : null };
  });
  for (const f of forns) { f.total = +f.total.toFixed(2); f.total_vencedor = +f.total_vencedor.toFixed(2); f.economia = +f.economia.toFixed(2); }
  return {
    fornecedores: forns, itens,
    resumo: {
      itens: c.itens.length, com_preco: comPreco, abaixo, acima, sem_vencedor: semVencedor, nao_comprar: naoComprar,
      convidados: forns.length, responderam: forns.filter(f => f.status === 'finalizado').length, abriram: forns.filter(f => f.abertoEm).length,
      total_ultimo_custo: c.totais?.ultimo_custo ?? 0, total_ultimo_vencedores: +ultimoVenc.toFixed(2), total_vencedores: +totalVenc.toFixed(2),
      economia: +(ultimoVenc - totalVenc).toFixed(2), economia_pct: ultimoVenc > 0 ? +(((ultimoVenc - totalVenc) / ultimoVenc) * 100).toFixed(1) : null
    }
  };
}
// mensagem da comprador(a) aos fornecedores (aparece fixa no topo da página do vendedor); só a comprador(a) edita
function setMensagem(id, { mensagem, whats, nome }, usuario) {
  const c = obter(id); if (!c) return null;
  if (mensagem !== undefined) { c.mensagem = String(mensagem || '').trim().slice(0, 600) || null; c.mensagemEm = c.mensagem ? new Date().toISOString() : null; c.mensagemPor = c.mensagem ? (usuario || null) : null; }
  c.comprador = c.comprador || {};
  if (whats !== undefined) c.comprador.whats = String(whats || '').replace(/\D/g, '') || null;
  if (nome !== undefined && String(nome || '').trim()) c.comprador.nome = String(nome).trim().slice(0, 80);
  return salvar(c);
}
function definirVencedor(id, cod, codFornec) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status + ': não dá mais pra mudar o vencedor' };
  cod = String(cod);
  if (!c.itens.some(i => i.cod === cod)) return { erro: 'Item não está na cotação' };
  const realizados = fornecedoresRealizados(c);
  const atual = comparativo(c).itens.find(i => i.cod === cod);
  if (atual && atual.fechado) { const f = c.fornecedores.find(x => x.codFornec === atual.vencedor.codFornec) || {}; return { erro: 'Item já está no pedido #' + atual.pedidoId + ' de ' + (f.nome || atual.vencedor.codFornec) + ', que foi realizado. Pedido fechado não muda.' }; }
  if (codFornec != null && codFornec !== 'auto' && codFornec !== 'nao' && codFornec !== '' && realizados.has(parseInt(codFornec))) { const f = c.fornecedores.find(x => x.codFornec === parseInt(codFornec)) || {}; return { erro: 'O pedido de ' + (f.nome || codFornec) + ' já foi realizado (#' + realizados.get(parseInt(codFornec)) + '). Não dá mais pra incluir item nele.' }; }
  c.vencedores = c.vencedores || {};
  if (codFornec === undefined || codFornec === 'auto' || codFornec === '') delete c.vencedores[cod];
  else if (codFornec === null || codFornec === 'nao') c.vencedores[cod] = null;
  else { const n = parseInt(codFornec); if (!c.fornecedores.some(f => f.codFornec === n)) return { erro: 'Fornecedor não está na cotação' }; c.vencedores[cod] = n; }
  return salvar(c);
}
// ── PRÉ-PEDIDOS (Tiago, 21/09, modelo Club da Cotação): um pré-pedido por fornecedor vencedor, com a quantidade
// por loja editável, data/tipo de entrega, e "Realizar Pedido" fornecedor a fornecedor (vira pedido em Pedidos
// de Compra). c.prePedidos[codFornec] = { lojas_qtd: { cod: { loja: qtd } }, entrega, tipo_entrega, obs, status, pedidoId }
function itensDoFornecedor(c, cmp, codFornec) {
  const pp = (c.prePedidos || {})[codFornec] || {};
  return cmp.itens.filter(it => it.vencedor && it.vencedor.codFornec === +codFornec).map(it => {
    const over = pp.lojas_qtd && pp.lojas_qtd[it.cod];
    const lojas_qtd = {}; for (const [ln, v] of Object.entries(over || it.lojas_qtd || {})) { const n = Math.max(0, Math.round(num(v) || 0)); if (n > 0) lojas_qtd[ln] = n; }
    const qtd = Object.values(lojas_qtd).reduce((s, v) => s + v, 0), p = it.precos[codFornec] || {};
    return { ...it, lojas_qtd, qtd, volumes: qtd ? Math.ceil(qtd / (it.emb || 1)) : 0, preco: it.vencedor.preco, obs: p.obs || '', marca: p.marca || '', emb_vendedor: p.emb_vendedor || '', total: +(qtd * it.vencedor.preco).toFixed(2), editado: !!over };
  });
}
function prePedidos(c) {
  const cmp = comparativo(c), lojas = c.lojas || [], hoje = new Date();
  const lista = cmp.fornecedores.filter(f => f.itens_vencedor > 0).map(f => {
    const pp = (c.prePedidos || {})[f.codFornec] || {}, itens = itensDoFornecedor(c, cmp, f.codFornec);
    const porLoja = {}; for (const ln of lojas) porLoja[ln] = +itens.reduce((s, i) => s + (i.lojas_qtd[ln] || 0) * i.preco, 0).toFixed(2);
    const total = +itens.reduce((s, i) => s + i.total, 0).toFixed(2);
    const prazo = parseInt(f.prazo_entrega) || 7; const d = new Date(hoje); d.setDate(d.getDate() + prazo);
    const forn = c.fornecedores.find(x => x.codFornec === f.codFornec) || {};
    const ped = (c.pedidos || []).find(p => p.codFornec === f.codFornec) || null;
    return { codFornec: f.codFornec, nome: f.nome, vendedor: forn.vendedor || null, condicao: f.condicao || f.condicao_padrao || null, faturamento_minimo: f.faturamento_minimo || null, prazo_entrega: f.prazo_entrega || null,
      entrega: pp.entrega || d.toISOString().slice(0, 10), tipo_entrega: pp.tipo_entrega || 'CIF', obs: pp.obs || '', status: ped ? 'realizado' : (pp.status || 'pendente'), pedidoId: ped ? ped.id : (pp.pedidoId || null),
      itens, total, porLoja, abaixo_minimo: f.faturamento_minimo > 0 && total > 0 && total < f.faturamento_minimo, economia: f.economia, itens_editados: itens.filter(i => i.editado).length };
  });
  const pend = lista.filter(p => p.status !== 'realizado'), real = lista.filter(p => p.status === 'realizado');
  return { lojas, fornecedores: lista, total_pre: +pend.reduce((s, p) => s + p.total, 0).toFixed(2), total_pedidos: +real.reduce((s, p) => s + p.total, 0).toFixed(2), pendentes: pend.length, realizados: real.length };
}
function salvarPrePedido(id, codFornec, dados) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status };
  codFornec = parseInt(codFornec); if (!c.fornecedores.some(f => f.codFornec === codFornec)) return { erro: 'Fornecedor não está na cotação' };
  c.prePedidos = c.prePedidos || {}; const pp = c.prePedidos[codFornec] = c.prePedidos[codFornec] || {};
  if (pp.status === 'realizado') return { erro: 'Pedido já realizado pra esse fornecedor' };
  if (dados.lojas_qtd && typeof dados.lojas_qtd === 'object') { pp.lojas_qtd = pp.lojas_qtd || {}; for (const [cod, lq] of Object.entries(dados.lojas_qtd)) { if (!c.itens.some(i => i.cod === String(cod))) continue; const o = {}; for (const [ln, v] of Object.entries(lq || {})) o[ln] = Math.max(0, Math.round(num(v) || 0)); pp.lojas_qtd[cod] = o; } }
  if (dados.entrega !== undefined) pp.entrega = /^\d{4}-\d{2}-\d{2}$/.test(dados.entrega || '') ? dados.entrega : null;
  if (dados.tipo_entrega !== undefined) pp.tipo_entrega = ['CIF', 'FOB', 'CIF / FOB'].includes(dados.tipo_entrega) ? dados.tipo_entrega : 'CIF';
  if (dados.obs !== undefined) pp.obs = String(dados.obs || '').slice(0, 300);
  return salvar(c);
}
// Realizar Pedido de UM fornecedor (o pré-pedido vira pedido em Pedidos de Compra). Quando todos os vencedores
// tiverem pedido, a cotação fecha sozinha.
async function realizarPedido(id, codFornec, usuario, criarPedido) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação ' + c.status };
  codFornec = parseInt(codFornec);
  const f = c.fornecedores.find(x => x.codFornec === codFornec); if (!f) return { erro: 'Fornecedor não está na cotação' };
  c.prePedidos = c.prePedidos || {}; const pp = c.prePedidos[codFornec] = c.prePedidos[codFornec] || {};
  if (pp.status === 'realizado' || (c.pedidos || []).some(p => p.codFornec === codFornec)) return { erro: 'Pedido já realizado pra esse fornecedor' };
  const cmp = comparativo(c), itens = itensDoFornecedor(c, cmp, codFornec).filter(i => i.qtd > 0);
  if (!itens.length) return { erro: 'Nenhum item com quantidade pra esse fornecedor' };
  const ped = await criarPedido(f, itens, c, { entrega: pp.entrega || null, tipo_entrega: pp.tipo_entrega || 'CIF', obs: pp.obs || '' });
  pp.status = 'realizado'; pp.pedidoId = ped.id; pp.realizadoEm = new Date().toISOString(); pp.realizadoPor = usuario || null;
  c.pedidos = (c.pedidos || []).concat([ped]);
  const faltam = cmp.fornecedores.filter(x => x.itens_vencedor > 0 && !(c.pedidos || []).some(p => p.codFornec === x.codFornec));
  if (!faltam.length) { c.status = 'fechada'; c.fechadaEm = new Date().toISOString(); c.fechadaPor = usuario || null; c.resultado = cmp.resumo; }
  return salvar(c);
}
// fecha: gera pedido pra todo fornecedor vencedor que ainda não tem (com as quantidades do pré-pedido)
async function fechar(id, usuario, criarPedido) {
  const c = obter(id); if (!c) return null;
  if (c.status !== 'aberta') return { erro: 'Cotação já ' + c.status };
  const cmp = comparativo(c);
  const pend = cmp.fornecedores.filter(f => f.itens_vencedor > 0 && !(c.pedidos || []).some(p => p.codFornec === f.codFornec));
  if (!pend.length && !(c.pedidos || []).length) return { erro: 'Nenhum item com preço digitado: nada a pedir' };
  const pedidos = (c.pedidos || []).slice();
  for (const fv of pend) {
    const f = c.fornecedores.find(x => x.codFornec === fv.codFornec), pp = (c.prePedidos || {})[fv.codFornec] || {};
    const itens = itensDoFornecedor(c, cmp, fv.codFornec).filter(i => i.qtd > 0); if (!itens.length) continue;
    const ped = await criarPedido(f, itens, c, { entrega: pp.entrega || null, tipo_entrega: pp.tipo_entrega || 'CIF', obs: pp.obs || '' });
    c.prePedidos = c.prePedidos || {}; c.prePedidos[fv.codFornec] = { ...pp, status: 'realizado', pedidoId: ped.id, realizadoEm: new Date().toISOString(), realizadoPor: usuario || null };
    pedidos.push(ped);
  }
  c.status = 'fechada'; c.fechadaEm = new Date().toISOString(); c.fechadaPor = usuario || null;
  c.pedidos = pedidos; c.resultado = cmp.resumo;
  return salvar(c);
}
// cotações de TESTE (botão "Criar cotação de teste" na tela): marcadas com c.teste, removidas em bloco
function marcarTeste(id) { const c = obter(id); if (!c) return null; c.teste = true; return salvar(c); }
function patchTeste(id, campos) { const c = obter(id); if (!c || !c.teste) return null; Object.assign(c, campos || {}); return salvar(c); }
function removerTestes() {
  const dir = path.join(DIR, '_removidos'); fs.mkdirSync(dir, { recursive: true });
  const ids = [];
  for (const c of listar()) if (c.teste) { fs.renameSync(arq(c.id), path.join(dir, c.id + '.json')); ids.push(c.id); }
  return ids;
}
function cancelar(id, usuario) {
  const c = obter(id); if (!c) return null;
  if (c.status === 'fechada') return { erro: 'Cotação fechada (pedidos já gerados) não pode ser cancelada' };
  c.status = 'cancelada'; c.canceladaEm = new Date().toISOString(); c.canceladaPor = usuario || null;
  return salvar(c);
}
// linha do Monitor
function resumo(c) {
  const r = comparativo(c).resumo;
  return {
    id: c.id, nome: c.nome, teste: !!c.teste, lista: c.lista, lista_nome: c.lista_nome, comprador: c.comprador, prazo: c.prazo, status: c.status,
    criadoEm: c.criadoEm, criadoPor: c.criadoPor, fechadaEm: c.fechadaEm || null, lojas: c.lojas, itens: c.itens.length, totais: c.totais,
    convidados: r.convidados, responderam: r.responderam, abriram: r.abriram, com_preco: r.com_preco, comprados: r.itens - r.sem_vencedor - r.nao_comprar,
    empresas: new Set(c.fornecedores.map(f => String(f.codFornecErp || f.codFornec || f.nome))).size,
    empresas_responderam: new Set(c.fornecedores.filter(f => f.status === 'finalizado').map(f => String(f.codFornecErp || f.codFornec || f.nome))).size,
    total_vencedores: r.total_vencedores, economia: r.economia, economia_pct: r.economia_pct, pedidos: c.pedidos || []
  };
}
// histórico de preço de um produto nas cotações anteriores (quem ganhou e por quanto)
function historicoProduto(cod) {
  cod = String(cod); const out = [];
  for (const c of listar()) {
    const i = c.itens.find(x => x.cod === cod); if (!i) continue;
    const it = comparativo(c).itens.find(x => x.cod === cod);
    const nome = cf => c.fornecedores.find(f => f.codFornec === +cf)?.nome || String(cf);
    out.push({
      cotacao: c.id, nome: c.nome, status: c.status, data: c.fechadaEm || c.criadoEm, qtd: i.qtd, ultimo_custo: i.ultimo_custo,
      vencedor: it.vencedor ? { nome: nome(it.vencedor.codFornec), preco: it.vencedor.preco } : null,
      precos: Object.entries(it.precos).map(([cf, p]) => ({ codFornec: +cf, nome: nome(cf), preco: p.preco }))
    });
  }
  return out;
}

// Regra SÓ DA COTAÇÃO (Tiago, 23/09/2026): "item que está na minha lista de cotação, com estoque zero na loja e sem
// sugestão, é pra sugerir 1 caixa". O Radar zera o produto inteiro quando não há venda em 40 d em nenhuma loja (nem
// avalia a caixa de loja zerada) e segura a loja que nunca vendeu em 24 m ('nunca_vendeu'); na cotação a lista manda:
// loja marcada + estoque e trânsito zerados + quantidade 0 → 1 caixa (embalagem efetiva do item). Não vale no Radar.
// Altera os itens no lugar (lojas_qtd, qtd, volumes, total, flag, zerado_cotacao) e devolve quantos itens mudaram.
function zeradoCotacao(itens) {
  let n = 0;
  for (const i of itens || []) {
    const emb = i.emb >= 1 ? i.emb : 1;
    const lq = i.lojas_qtd || (i.lojas_qtd = {}), det = i.lojas_det || {}, lojas = [];
    for (const ln of i.lojas || []) {
      const d = det[ln]; if (!d) continue;
      if ((Number(lq[ln]) || 0) > 0) continue;
      if ((Number(d.estoque) || 0) + (Number(d.transito) || 0) > 0) continue;
      lq[ln] = emb; lojas.push(ln);
    }
    if (!lojas.length) continue;
    n++;
    i.qtd = Object.values(lq).reduce((a, v) => a + (Number(v) || 0), 0);
    i.volumes = Math.ceil(i.qtd / emb);
    i.total = +(i.qtd * (Number(i.custo) || 0)).toFixed(2);
    i.flag = i.flag ? i.flag + ' · zerado (cotação)' : 'zerado (cotação)';
    i.zerado_cotacao = lojas;
  }
  return n;
}

module.exports = { init, criar, obter, listar, porToken, adicionarFornecedor, marcarEnviado, abrir, salvarPrecos, finalizar, visaoVendedor, setMensagem, prePedidos, salvarPrePedido, realizarPedido, comparativo, definirVencedor, fechar, cancelar, resumo, historicoProduto, marcarTeste, patchTeste, removerTestes, LOJAS_NOMES, zeradoCotacao, expandirFornecedor, setPrazo, normPrazo, prazoVencido, cadastroFaltando };
