// lib/recebimento-rotas.js — Coletor de Recebimento (conferência cega): rotas públicas por token
// (celular do conferente) e internas (sessão, módulo fiscal), com espelho no ERP de teste (.254).
// Ver lib/recebimento.js (estado da conferência) e lib/recebimento-erp.js (passos pro escreverERP).
module.exports = function montarRotasRecebimento(app, deps) {
  const { q, path, escreverERP, pedidosFornec, conferenciaXml, logColetor, LOG_COLETOR_DIR, __dirname } = deps;
  const recebimento = require('./recebimento');
  const recebErp = require('./recebimento-erp');
  const cadastroCache = new Map();

  // Colunas reais de central.itens (confirmadas em outras queries do arquivo: CodigoBarra, Descricao,
  // qtdemb, Validar; não existe coluna "Emb" — a embalagem de compra usa UnidadeCompra, como em
  // /api/cotacao (`r.UnidadeCompra?.trim() || r.Unid?.trim()`).
  async function cadastroItem(cod) {
    if (cadastroCache.has(cod)) return cadastroCache.get(cod);
    const r = await q(`SELECT CodigoBarra cod, Descricao descricao, qtdemb, UnidadeCompra emb, Validar validar FROM central.itens WHERE CodigoBarra=? LIMIT 1`, [cod]).catch(() => []);
    const v = r[0] ? { cod, descricao: String(r[0].descricao || '').trim(), qtdemb: +r[0].qtdemb || 1, emb: String(r[0].emb || 'UN').trim(), validar: +r[0].validar || 0 } : null;
    cadastroCache.set(cod, v); setTimeout(() => cadastroCache.delete(cod), 600e3); return v;
  }

  function xmlPorChave(chave) {
    for (const p of pedidosFornec.listar()) for (const [ln, x] of Object.entries(p.xml?.lojas || {})) {
      const n = (x.notas || []).find(n => n.chave === chave); if (!n) continue;
      const itens = (x.itens || []).map(i => ({ cod: i.cod, descricao: i.descricao, un: +i.recebida || 0, decisao: i.decisao || null }));
      const naoPedidos = (x.nao_pedidos || []).map(i => ({ cod: i.cod, descricao: i.descricao, un: +i.recebida || 0, decisao: i.decisao || null }));
      return { pedidoId: p.id, ln: +ln, status: x.status === 'conciliado' ? 'conciliado' : 'consistencia', itens: itens.concat(naoPedidos.filter(i => i.decisao?.acao !== 'recusar')), naoPedidos };
    }
    return null;
  }

  recebimento.init({ dir: path.join(__dirname, 'data', 'recebimento'), cadastro: cadastroItem, xmlLoja: xmlPorChave });
  const rcLoja = req => recebimento.lojaPorToken(req.query.t || req.body?.t);
  const logC = ev => { try { logColetor.registrar(LOG_COLETOR_DIR, ev); } catch (e) { console.error('[LOG COLETOR]', e.message); } };

  // escreverERP.lote nunca rejeita a Promise em erro esperado (mysql do .254 fora do ar, lote recusado
  // por regra de negócio etc.) — resolve com { ok:false, status, erro }. Por isso checamos r.ok aqui
  // antes de seguir, senão um `.254` fora do ar nunca cairia em erp.erros como o esperado localmente.
  // Campo com o(s) id(s) gerados é `r.ids` (plural, um por passo), não `r.ids_gerados`.
  async function espelhoErp(c, montado, tipo) {
    try {
      const r = await escreverERP.lote({ usuario: 'coletor:' + c.nome, motivo: montado.motivo, banco: 'central', passos: montado.passos, limite: 200 });
      if (!r.ok) throw new Error(r.erro || ('ERP recusou (' + r.status + ')'));
      if (tipo === 'abrir') c.erp.nReg = r.ids?.[0] || null;
      c.erp.ultimoLogId = r.id; recebimento.salvar(c);
      logC({ tipo: 'erp', loja: c.loja, nome: c.nome, nfe: c.nNota, nReg: c.erp.nReg, logErpId: r.id, msg: tipo });
      return r;
    } catch (e) {
      c.erp.erros.push({ em: new Date().toISOString(), tipo, erro: e.message, passos: montado.passos });
      recebimento.salvar(c);
      logC({ tipo: 'erp', loja: c.loja, nome: c.nome, nfe: c.nNota, erro: e.message, msg: tipo });
      return null;
    }
  }

  // ── rotas públicas (?t=token ou body.t) ─────────────────────────────────────
  app.post('/api/recebimento-publico/entrar', (req, res) => {
    const { loja, pin, nome } = req.body || {}; const r = recebimento.lojaPorPin(parseInt(loja, 10), String(pin || '').trim());
    if (!r) return res.status(401).json({ error: 'PIN não confere com essa loja.' });
    logC({ tipo: 'entrar', loja: r.loja, nome: String(nome || '').toUpperCase(), msg: String(req.headers['user-agent'] || '').slice(0, 80) });
    res.json({ ...r, nome: String(nome || '').toUpperCase().slice(0, 20) });
  });

  app.get('/api/recebimento-publico/notas', async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida. Entre de novo com o PIN.' });
    try {
      const cfg = recebimento.config(); const cnpj = conferenciaXml.LOJA_CNPJ[s.loja]; const desde = new Date(Date.now() - cfg.janela_dias_axml * 864e5).toISOString().slice(0, 10);
      const rows = await q(`SELECT a.Chave chave, a.nNota, a.CNPJemit, a.Data FROM central.axml a WHERE a.CNPJdest=? AND a.nMod='55' AND a.Data>=? ORDER BY a.Data DESC, a.nReg DESC LIMIT 200`, [cnpj, desde]);
      const raizes = [...new Set(rows.map(r => String(r.CNPJemit).slice(0, 8)))];
      const forn = raizes.length ? await q(`SELECT LEFT(CNPJ,8) raiz, nReg cod, Nome nome FROM central.fornecedor WHERE LEFT(CNPJ,8) IN (${raizes.map(() => '?').join(',')})`, raizes) : [];
      const fPorRaiz = Object.fromEntries(forn.map(f => [f.raiz, f])); const hoje = recebimento.listarDia(); const conf = Object.fromEntries(hoje.map(c => [c.chave, c]));
      res.json(rows.map(r => {
        const x = xmlPorChave(r.chave); const f = fPorRaiz[String(r.CNPJemit).slice(0, 8)]; const c = conf[r.chave];
        return { chave: r.chave, nNota: String(r.nNota), fornecedor: f ? f.nome : 'CNPJ ' + r.CNPJemit, codFornec: f ? f.cod : 0, pedidoId: x ? x.pedidoId : null, veredito: !x ? 'sem_pedido' : x.status === 'conciliado' ? 'liberada' : 'divergente', conferencia: c ? { id: c.id, status: c.status } : null };
      }).filter(n => !n.conferencia || n.conferencia.status !== 'liberada'));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // devolucoes(c) só é revelada pra conferência cega DEPOIS de terminar a bipagem (terminada/liberada)
  // — nunca antes, senão a lista de devolução (compras/coletor/falta) vaza quantidade da nota.
  function comDevolucoes(v, c) {
    if (v && c && (c.status === 'terminada' || c.status === 'liberada')) v.devolucoes = recebimento.devolucoes(c);
    return v;
  }

  app.post('/api/recebimento-publico/abrir', async (req, res) => {
    try {
      const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
      const { chave, nNota, fornecedor, codFornec, nome } = req.body || {}; if (!chave) return res.status(400).json({ error: 'chave obrigatória' });
      const c = recebimento.abrirNota({ loja: s.loja, nome, chave, nNota, fornecedor, codFornec });
      if (!c.erp.nReg && !c.erp.erros.length) await espelhoErp(c, recebErp.passosAbrir(c, { dataHora: new Date() }), 'abrir');
      logC({ tipo: 'abrir_nota', loja: s.loja, nome: c.nome, nfe: c.nNota, chave, nReg: c.erp.nReg, descricao: fornecedor });
      res.json(comDevolucoes(recebimento.visaoLoja(s.loja, c.id), c));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/recebimento-publico/conferencia/:id', (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    const c = recebimento.obter(req.params.id);
    const v = recebimento.visaoLoja(s.loja, req.params.id);
    v ? res.json(comDevolucoes(v, c)) : res.status(404).json({ error: 'não encontrada' });
  });

  app.get('/api/recebimento-publico/cadastro/:cod', async (req, res) => {
    try {
      if (!rcLoja(req)) return res.status(401).json({ error: 'Sessão inválida.' });
      const k = await cadastroItem(String(req.params.cod).trim());
      k ? res.json({ descricao: k.descricao, qtdemb: k.qtdemb, emb: k.emb }) : res.status(404).json({ error: 'Produto não cadastrado. Chame a central.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  for (const acao of ['bipar', 'corrigir']) app.post('/api/recebimento-publico/' + acao, async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const c0 = recebimento.obter(req.body.id); if (!c0 || +c0.loja !== s.loja) return res.status(404).json({ error: 'Conferência não encontrada' });
      const r = await recebimento[acao](req.body.id, req.body); const c = recebimento.obter(req.body.id);
      // r.repetido = a fila offline do coletor reenviou um bipeId já aplicado: nada foi somado de
      // novo, então não loga outro evento nem espelha o item no ERP uma segunda vez.
      if (!r.repetido) {
        logC({ tipo: acao === 'bipar' ? 'bipe' : 'corrigir', loja: s.loja, nome: c.nome, nfe: c.nNota, cod: req.body.cod, descricao: r.item?.descricao, quant: req.body.quant, emb: req.body.emb, un: r.item?.un, validade: req.body.validade, resultado: r.resultado });
        if (r.item && c.erp.nReg && r.resultado !== 'nao_cadastrado') await espelhoErp(c, recebErp.passosItem(c, r.item, c.erp.nReg), 'item');
      }
      res.json({ resultado: r.resultado, item: r.item, repetido: !!r.repetido, visao: recebimento.visaoLoja(s.loja, c.id) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento-publico/terminei', async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const t = recebimento.terminei(req.body.id); const c = recebimento.obter(req.body.id);
      logC({ tipo: 'terminei', loja: s.loja, nome: c.nome, nfe: c.nNota, resultado: t.bateu ? 'bateu' : t.recontar.length + ' recontar', msg: 'recontagem ' + c.recontagens });
      if (c.status === 'terminada' && c.erp.nReg) await espelhoErp(c, recebErp.passosStatus(c, c.erp.nReg, 3, { nome: c.nome, dataHora: new Date() }), 'terminei');
      res.json({ ...t, status: c.status, ...(c.status === 'terminada' || c.status === 'liberada' ? { devolucoes: recebimento.devolucoes(c) } : {}) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento-publico/enviar', async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const c = recebimento.enviarAssimMesmo(req.body.id);
      logC({ tipo: 'terminei', loja: s.loja, nome: c.nome, nfe: c.nNota, resultado: 'enviado assim mesmo' });
      if (c.erp.nReg) await espelhoErp(c, recebErp.passosStatus(c, c.erp.nReg, 3, { nome: c.nome, dataHora: new Date() }), 'terminei');
      res.json({ status: c.status, ...(c.status === 'terminada' || c.status === 'liberada' ? { devolucoes: recebimento.devolucoes(c) } : {}) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento-publico/chat', (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const c = recebimento.obter(req.body.id);
      const m = recebimento.mensagem(req.body.id, { de: 'loja', nome: c.nome, motivo: req.body.motivo, texto: req.body.texto, cod: req.body.cod });
      logC({ tipo: 'chat', loja: s.loja, nome: c.nome, nfe: c.nNota, cod: m.cod, msg: [m.motivo, m.texto].filter(Boolean).join(': ') });
      res.json(m);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── rotas internas (sessão, módulo fiscal) ──────────────────────────────────
  app.get('/api/recebimento', (req, res) => res.json(recebimento.listarDia(req.query.data || recebimento.hojeStr()).map(c => ({ ...c, devolucoes: c.devolucoes || recebimento.devolucoes(c), xml: undefined }))));

  app.get('/api/recebimento/config', (req, res) => {
    const c = recebimento.config();
    res.json({ ...c, lojas: Object.fromEntries(Object.entries(c.lojas).map(([k, v]) => [k, { pin: v.pin }])) });
  });

  app.post('/api/recebimento/config', (req, res) => {
    const { validade_pct_min, recontagens_min, modo_cega, janela_dias_axml } = req.body || {};
    res.json(recebimento.setConfig({ validade_pct_min: +validade_pct_min || 100, recontagens_min: +recontagens_min || 1, modo_cega: modo_cega || 'total', janela_dias_axml: +janela_dias_axml || 7 }));
  });

  app.post('/api/recebimento/:id/liberar', async (req, res) => {
    const nome = req.session.user?.nome || 'CENTRAL';
    try {
      const c = recebimento.liberar(req.params.id, { nome });
      logC({ tipo: 'liberar', loja: c.loja, nome, nfe: c.nNota, msg: c.devolucoes.map(d => d.origem + ' ' + d.cod + ' ' + d.qtd).join('; ') });
      const r = c.erp.nReg ? await espelhoErp(c, recebErp.passosLiberar(c, c.erp.nReg, { nome, dataHora: new Date() }), 'liberar') : null;
      res.json({ ok: true, conferencia: c, erp: r ? { logId: r.id } : { erro: c.erp.erros.at(-1)?.erro || 'sem nReg no ERP' } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento/:id/reconferir', async (req, res) => {
    const nome = req.session.user?.nome || 'CENTRAL';
    try {
      const c = recebimento.reconferir(req.params.id, { nome });
      logC({ tipo: 'reconferir', loja: c.loja, nome, nfe: c.nNota });
      if (c.erp.nReg) await espelhoErp(c, recebErp.passosStatus(c, c.erp.nReg, 5, { nome, dataHora: new Date() }), 'reconferir');
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento/:id/chat', (req, res) => {
    const nome = req.session.user?.nome || 'CENTRAL';
    try {
      const c = recebimento.obter(req.params.id);
      const m = recebimento.mensagem(req.params.id, { de: 'central', nome, texto: req.body.texto, cod: req.body.cod, acao: req.body.acao });
      logC({ tipo: 'chat', loja: c.loja, nome, nfe: c.nNota, cod: m.cod, msg: [m.acao, m.texto].filter(Boolean).join(': ') });
      res.json(m);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento/:id/reenviar-erp', async (req, res) => {
    const c = recebimento.obter(req.params.id); if (!c) return res.status(404).json({ error: 'não encontrada' });
    const pend = c.erp.erros.splice(0); let ok = 0;
    for (const p of pend) { const r = await espelhoErp(c, { motivo: 'Reenvio ' + p.tipo + ' ' + c.id, passos: p.passos }, p.tipo); if (r) ok++; }
    res.json({ reenviados: ok, erros: c.erp.erros.length });
  });

  // exposto pra teste (sem contrato externo — os testes de recebimento-rotas usam isto pra evitar
  // recriar toda a lógica de veredito/espelho)
  return { cadastroItem, xmlPorChave, espelhoErp, rcLoja, logC };
};
