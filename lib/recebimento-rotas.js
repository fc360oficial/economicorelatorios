// lib/recebimento-rotas.js — Coletor de Recebimento (conferência cega): rotas públicas por token
// (celular do conferente) e internas (sessão, módulo fiscal), com espelho no ERP de teste (.254).
// Ver lib/recebimento.js (estado da conferência) e lib/recebimento-erp.js (passos pro escreverERP).
module.exports = function montarRotasRecebimento(app, deps) {
  const { q, path, escreverERP, pedidosFornec, conferenciaXml, logColetor, LOG_COLETOR_DIR, __dirname } = deps;
  const recebimento = require('./recebimento');
  const recebErp = require('./recebimento-erp');

  // ── caches ────────────────────────────────────────────────────────────────
  // Cache simples com TTL por timestamp e teto de tamanho (sem setTimeout por chave: um bipe de
  // código novo por segundo criava um timer por código e segurava o processo acordado).
  function cacheTtl(ttl, max) {
    const m = new Map();
    return {
      get(k) { const e = m.get(k); if (!e) return undefined; if (Date.now() - e.em > ttl) { m.delete(k); return undefined; } return e.v; },
      set(k, v) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { em: Date.now(), v }); return v; },
      limpar() { m.clear(); },
      get tamanho() { return m.size; },
    };
  }
  const cadastroCache = cacheTtl(600e3, 2000);
  const notaCache = cacheTtl(300e3, 500);

  // Colunas reais de central.itens (confirmadas em outras queries do arquivo: CodigoBarra, Descricao,
  // qtdemb, Validar; não existe coluna "Emb" — a embalagem de compra usa UnidadeCompra, como em
  // /api/cotacao (`r.UnidadeCompra?.trim() || r.Unid?.trim()`).
  async function cadastroItem(cod) {
    const j = cadastroCache.get(cod); if (j !== undefined) return j;
    const r = await q(`SELECT CodigoBarra cod, Descricao descricao, qtdemb, UnidadeCompra emb, Validar validar FROM central.itens WHERE CodigoBarra=? LIMIT 1`, [cod]).catch(() => []);
    const v = r[0] ? { cod, descricao: String(r[0].descricao || '').trim(), qtdemb: +r[0].qtdemb || 1, emb: String(r[0].emb || 'UN').trim(), validar: +r[0].validar || 0 } : null;
    return cadastroCache.set(cod, v);
  }

  // ── índice chave da NF-e → pedido do app ──────────────────────────────────
  // pedidosFornec.listar() é readdir + JSON.parse de TODOS os pedidos. Era chamado por linha de
  // /notas, por bipe (xmlDe) e por conferência no poll de 15 s do Fiscal — com 60 pedidos x 200
  // notas o processo travava. Agora vira um índice montado uma vez e memoizado por TTL curto.
  const INDICE_TTL = 30e3;
  let indice = null, indiceEm = 0;
  function indiceXml() {
    if (indice && Date.now() - indiceEm < INDICE_TTL) return indice;
    const idx = new Map();
    for (const p of pedidosFornec.listar()) for (const [ln, x] of Object.entries(p.xml?.lojas || {})) {
      const e = { pedidoId: p.id, ln: +ln, x, v: null };
      for (const n of (x.notas || [])) if (n.chave && !idx.has(n.chave)) idx.set(n.chave, e);
    }
    indice = idx; indiceEm = Date.now();
    return indice;
  }
  function invalidarIndiceXml() { indice = null; indiceEm = 0; }
  function xmlPorChave(chave) {
    const e = indiceXml().get(chave); if (!e) return null;
    if (e.v) return e.v;
    const x = e.x;
    const itens = (x.itens || []).map(i => ({ cod: i.cod, descricao: i.descricao, un: +i.recebida || 0, decisao: i.decisao || null }));
    const naoPedidos = (x.nao_pedidos || []).map(i => ({ cod: i.cod, descricao: i.descricao, un: +i.recebida || 0, decisao: i.decisao || null }));
    e.v = { pedidoId: e.pedidoId, ln: e.ln, status: x.status === 'conciliado' ? 'conciliado' : 'consistencia', itens: itens.concat(naoPedidos.filter(i => i.decisao?.acao !== 'recusar')), naoPedidos };
    return e.v;
  }

  // ── nota do ERP (central.axml + central.axmlprodutos) ─────────────────────
  // Sem isto, toda nota que não veio de pedido do app (sem_pedido, e todo pedido digitado no
  // Dlinks) era inconferível: sem itens do XML, cada bipe caía em 'nao_esta_na_nota'.
  // Só LEITURA, parametrizado, cacheado por chave. Mesmo mapeamento de lib/conferencia-xml.js:
  // ligação axmlprodutos por nNota + CNPJemit, unidades em oqTrib, EAN com fallback ocEanTrib.
  async function notaDaChave(chave) {
    const j = notaCache.get(chave); if (j !== undefined) return j;
    let v = null;
    try {
      const cab = await q(`SELECT Chave, nNota, CNPJemit, CNPJdest, NomeEmit FROM central.axml WHERE Chave=? AND nMod='55' LIMIT 1`, [chave]);
      if (cab[0]) {
        const prods = await q(`SELECT nItem, CodigoBarras, ocEanTrib, Descricao, Und, Qtd, oqTrib FROM central.axmlprodutos WHERE nNota=? AND CNPJemit=? ORDER BY nItem`, [cab[0].nNota, cab[0].CNPJemit]).catch(() => []);
        const porCod = new Map();
        for (const p of prods) {
          const cod = String(p.CodigoBarras || '').trim(); const ean = String(p.ocEanTrib || '').trim();
          const k = cod && cod !== '0' ? cod : ean; if (!k) continue;
          const qTrib = Number(String(p.oqTrib ?? '0').replace(',', '.')) || 0;
          const qCom = Number(String(p.Qtd ?? '0').replace(',', '.')) || 0;
          const un = qTrib > 0 ? qTrib : qCom;
          const a = porCod.get(k);
          if (a) a.un = +(a.un + un).toFixed(3);
          else porCod.set(k, { cod: k, descricao: String(p.Descricao || '').trim(), un: +un.toFixed(3), decisao: null });
        }
        v = { chave, nNota: String(cab[0].nNota), cnpjEmit: String(cab[0].CNPJemit || ''), cnpjDest: String(cab[0].CNPJdest || ''), nomeEmit: String(cab[0].NomeEmit || '').trim(), itens: [...porCod.values()] };
      }
    } catch (e) { console.error('[COLETOR] nota da chave:', e.message); return null; }  // erro de banco não entra no cache
    return notaCache.set(chave, v);
  }

  // Fornecedor pela RAIZ do CNPJ do emitente (axml.CodFornec vem sempre "0" — ver conferencia-xml.js).
  async function fornecedorPorCnpj(cnpjEmit) {
    const raiz = String(cnpjEmit || '').replace(/\D/g, '').slice(0, 8);
    if (raiz.length < 8) return null;
    const r = await q(`SELECT nReg cod, Nome nome FROM central.fornecedor WHERE LEFT(CNPJ,8)=? LIMIT 1`, [raiz]).catch(() => []);
    return r[0] ? { cod: +r[0].cod || 0, nome: String(r[0].nome || '').trim() } : null;
  }

  const validadeMinDias = () => { try { return +require('./fiscal').getConfig().validade_min_dias || 0; } catch { return 7; } };
  recebimento.init({ dir: path.join(__dirname, 'data', 'recebimento'), cadastro: cadastroItem, xmlLoja: xmlPorChave, validadeMinDias });
  const rcLoja = req => recebimento.lojaPorToken(req.query.t || req.body?.t);
  const logC = ev => { try { logColetor.registrar(LOG_COLETOR_DIR, ev); } catch (e) { console.error('[LOG COLETOR]', e.message); } };
  const st = e => (e && e.status === 400 ? 400 : 500);

  // ── espelho no ERP de teste ───────────────────────────────────────────────
  // escreverERP.lote nunca rejeita a Promise em erro esperado (mysql do .254 fora do ar, lote recusado
  // por regra de negócio etc.) — resolve com { ok:false, status, erro }. Por isso checamos r.ok aqui
  // antes de seguir, senão um `.254` fora do ar nunca cairia em erp.erros como o esperado localmente.
  // Campo com o(s) id(s) gerados é `r.ids` (plural, um por passo), não `r.ids_gerados`.
  //
  // A conferência é RELIDA depois do await (o bipe seguinte pode ter gravado o JSON enquanto o ERP
  // respondia): só `erp.*` e `it.espelhado` são mexidos, no objeto fresco. A pendência guardada em
  // erp.erros é o MÍNIMO pra reconstruir o passo do estado atual ({tipo, cod, status}) — nunca o
  // array de passos congelado, que envelhece junto com a contagem.
  function pendencia(c, p) {
    const f = recebimento.obter(c.id) || c;
    f.erp = f.erp || { nReg: null, erros: [] };
    f.erp.erros = (f.erp.erros || []).filter(e => !(e.tipo === p.tipo && (e.cod || null) === (p.cod || null)));
    f.erp.erros.push({ em: new Date().toISOString(), ...p });
    recebimento.salvar(f);
    c.erp = f.erp;
    return f;
  }

  async function espelhoErp(c, montado, tipo, extra = {}) {
    let r = null, erro = null;
    try {
      r = await escreverERP.lote({ usuario: 'coletor:' + c.nome, motivo: montado.motivo, banco: 'central', passos: montado.passos, limite: 200 });
      if (!r.ok) throw new Error(r.erro || ('ERP recusou (' + r.status + ')'));
    } catch (e) { erro = e.message; r = null; }
    const f = recebimento.obter(c.id) || c;
    f.erp = f.erp || { nReg: null, erros: [] };
    if (erro) {
      f.erp.erros = (f.erp.erros || []).filter(e => !(e.tipo === tipo && (e.cod || null) === (extra.cod || null)));
      f.erp.erros.push({ em: new Date().toISOString(), tipo, erro, ...extra });
      recebimento.salvar(f); c.erp = f.erp;
      logC({ tipo: 'erp', loja: f.loja, nome: f.nome, nfe: f.nNota, erro, msg: tipo });
      return null;
    }
    if (tipo === 'abrir') f.erp.nReg = r.ids?.[0] || null;
    if (extra.cod && f.itens && f.itens[extra.cod]) f.itens[extra.cod].espelhado = true;
    f.erp.ultimoLogId = r.id;
    f.erp.erros = (f.erp.erros || []).filter(e => !(e.tipo === tipo && (e.cod || null) === (extra.cod || null)));
    recebimento.salvar(f); c.erp = f.erp;
    logC({ tipo: 'erp', loja: f.loja, nome: f.nome, nfe: f.nNota, nReg: f.erp.nReg, logErpId: r.id, msg: tipo });
    return r;
  }

  // Espelha o item quando já existe nReg; senão enfileira a pendência (o item entra no ERP no
  // /reenviar-erp, reconstruído do estado atual da conferência).
  async function espelhoItem(c, item) {
    if (!c.erp.nReg) { pendencia(c, { tipo: 'item', cod: item.cod, erro: 'conferência ainda sem nReg no ERP' }); return null; }
    return espelhoErp(c, recebErp.passosItem(c, item, c.erp.nReg), 'item', { cod: item.cod });
  }
  async function espelhoStatus(c, status, nome) {
    if (!c.erp.nReg) { pendencia(c, { tipo: 'status', status, erro: 'conferência ainda sem nReg no ERP' }); return null; }
    return espelhoErp(c, recebErp.passosStatus(c, c.erp.nReg, status, { nome: nome || c.nome, dataHora: new Date() }), 'status', { status });
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
      // Importado=0 (spec §4.2): nota já importada pro ERP não é mais recebimento a conferir.
      const rows = await q(`SELECT a.Chave chave, a.nNota, a.CNPJemit, a.Data FROM central.axml a WHERE a.CNPJdest=? AND a.nMod='55' AND a.Importado=0 AND a.Data>=? ORDER BY a.Data DESC, a.nReg DESC LIMIT 200`, [cnpj, desde]);
      const raizes = [...new Set(rows.map(r => String(r.CNPJemit).slice(0, 8)))];
      const forn = raizes.length ? await q(`SELECT LEFT(CNPJ,8) raiz, nReg cod, Nome nome FROM central.fornecedor WHERE LEFT(CNPJ,8) IN (${raizes.map(() => '?').join(',')})`, raizes) : [];
      const fPorRaiz = Object.fromEntries(forn.map(f => [f.raiz, f]));
      // ontem + hoje: nota aberta antes da meia-noite continua sendo a mesma conferência (I4).
      const conf = {};
      for (const dia of [recebimento.ontemStr(), recebimento.hojeStr()]) for (const c of recebimento.listarDia(dia)) if (+c.loja === s.loja) conf[c.chave] = c;
      res.json(rows.map(r => {
        const x = xmlPorChave(r.chave); const f = fPorRaiz[String(r.CNPJemit).slice(0, 8)]; const c = conf[r.chave];
        return { chave: r.chave, nNota: String(r.nNota), fornecedor: f ? f.nome : 'CNPJ ' + r.CNPJemit, codFornec: f ? f.cod : 0, pedidoId: x ? x.pedidoId : null, veredito: !x ? 'sem_pedido' : x.status === 'conciliado' ? 'liberada' : 'divergente', conferencia: c ? { id: c.id, status: c.status } : null };
      }).filter(n => !n.conferencia || n.conferencia.status !== 'liberada'));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // devolucoes(c) só é revelada pra conferência cega DEPOIS de terminar a bipagem (terminada/liberada)
  // — nunca antes, senão a lista de devolução (compras/coletor/falta) vaza quantidade da nota.
  // Mesmo depois, a linha de origem 'falta' vai SEM qtd pra loja: "não veio" é o que o motorista
  // precisa saber; a quantidade que faltou é justamente a quantidade da nota, e o Fiscal pode
  // mandar reconferir — se a loja tivesse visto o número, a recontagem deixaria de ser cega.
  function devolucoesLoja(c) {
    return recebimento.devolucoes(c).map(d => (d.origem === 'falta' ? { cod: d.cod, descricao: d.descricao, origem: d.origem, motivo: d.motivo } : d));
  }
  function comDevolucoes(v, c) {
    if (v && c && (c.status === 'terminada' || c.status === 'liberada')) v.devolucoes = devolucoesLoja(c);
    return v;
  }

  app.post('/api/recebimento-publico/abrir', async (req, res) => {
    try {
      const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
      const { chave, nome } = req.body || {}; if (!chave) return res.status(400).json({ error: 'chave obrigatória' });
      // A chave tem que ser de uma nota emitida PRA ESTA LOJA (o token diz qual é). Fornecedor e
      // codFornec saem do axml/central.fornecedor, nunca do body — o celular não decide isso.
      const nota = await notaDaChave(String(chave));
      if (!nota) return res.status(404).json({ error: 'NF-e não encontrada no ERP.' });
      if (nota.cnpjDest !== conferenciaXml.LOJA_CNPJ[s.loja]) return res.status(403).json({ error: 'Esta NF-e não é da sua loja.' });
      const f = await fornecedorPorCnpj(nota.cnpjEmit);
      const c = recebimento.abrirNota({ loja: s.loja, nome, chave: String(chave), nNota: nota.nNota, fornecedor: f ? f.nome : ('CNPJ ' + nota.cnpjEmit), codFornec: f ? f.cod : 0, xmlItens: nota.itens });
      if (!c.erp.nReg) await espelhoErp(c, recebErp.passosAbrir(c, { dataHora: new Date() }), 'abrir');
      logC({ tipo: 'abrir_nota', loja: s.loja, nome: c.nome, nfe: c.nNota, chave: String(chave), nReg: c.erp.nReg, descricao: c.fornecedor });
      res.json(comDevolucoes(recebimento.visaoLoja(s.loja, c.id), recebimento.obter(c.id)));
    } catch (e) { res.status(st(e)).json({ error: e.message }); }
  });

  app.get('/api/recebimento-publico/conferencia/:id', (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const c = recebimento.obter(req.params.id);
      const v = recebimento.visaoLoja(s.loja, req.params.id);
      v ? res.json(comDevolucoes(v, c)) : res.status(404).json({ error: 'não encontrada' });
    } catch (e) { res.status(st(e)).json({ error: e.message }); }
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
        if (r.item && r.resultado !== 'nao_cadastrado') await espelhoItem(c, r.item);
      }
      res.json({ resultado: r.resultado, item: r.item, repetido: !!r.repetido, visao: recebimento.visaoLoja(s.loja, c.id) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento-publico/terminei', async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const t = recebimento.terminei(req.body.id); let c = recebimento.obter(req.body.id);
      logC({ tipo: 'terminei', loja: s.loja, nome: c.nome, nfe: c.nNota, resultado: t.bateu ? 'bateu' : t.recontar.length + ' recontar', msg: 'recontagem ' + c.recontagens });
      if (c.status === 'terminada') await espelhoStatus(c, 3);
      c = recebimento.obter(req.body.id);
      res.json({ ...t, status: c.status, ...(c.status === 'terminada' || c.status === 'liberada' ? { devolucoes: devolucoesLoja(c) } : {}) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento-publico/enviar', async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      let c = recebimento.enviarAssimMesmo(req.body.id);
      logC({ tipo: 'terminei', loja: s.loja, nome: c.nome, nfe: c.nNota, resultado: 'enviado assim mesmo' });
      await espelhoStatus(c, 3);
      c = recebimento.obter(req.body.id);
      res.json({ status: c.status, ...(c.status === 'terminada' || c.status === 'liberada' ? { devolucoes: devolucoesLoja(c) } : {}) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento-publico/chat', (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const c = recebimento.obter(req.body.id); if (!c || +c.loja !== s.loja) return res.status(404).json({ error: 'Conferência não encontrada' });
      const m = recebimento.mensagem(req.body.id, { de: 'loja', nome: c.nome, motivo: req.body.motivo, texto: req.body.texto, cod: req.body.cod, msgId: req.body.msgId });
      if (!m.repetido) logC({ tipo: 'chat', loja: s.loja, nome: c.nome, nfe: c.nNota, cod: m.cod, msg: [m.motivo, m.texto].filter(Boolean).join(': ') });
      res.json(m);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── rotas internas (sessão, módulo fiscal) ──────────────────────────────────
  // `xml`, `xml_itens`, `bipes_vistos` e `msgs_vistos` NUNCA saem daqui: os dois primeiros são a
  // nota (conferência cega), os outros dois são controle interno de idempotência.
  const semInternos = c => ({ ...c, xml: undefined, xml_itens: undefined, bipes_vistos: undefined, msgs_vistos: undefined });
  app.get('/api/recebimento', (req, res) => {
    try {
      const data = req.query.data ? recebimento.validarDia(req.query.data) : recebimento.hojeStr();
      res.json(recebimento.listarDia(data).map(c => ({ ...semInternos(c), devolucoes: c.devolucoes || recebimento.devolucoes(c) })));
    } catch (e) { res.status(st(e)).json({ error: e.message }); }
  });

  const semTokens = c => ({ ...c, lojas: Object.fromEntries(Object.entries(c.lojas).map(([k, v]) => [k, { pin: v.pin }])) });
  app.get('/api/recebimento/config', (req, res) => res.json(semTokens(recebimento.config())));

  // Number.isFinite (e não `|| padrão`): 0 é valor válido em recontagens_min. `modo_cega` não é
  // editável por aqui — fica só como default do arquivo de config.
  app.post('/api/recebimento/config', (req, res) => {
    const b = req.body || {}; const campos = {};
    for (const k of ['validade_pct_min', 'recontagens_min', 'janela_dias_axml']) { const v = Number(b[k]); if (b[k] !== undefined && b[k] !== '' && Number.isFinite(v)) campos[k] = v; }
    res.json(semTokens(recebimento.setConfig(campos)));
  });

  app.post('/api/recebimento/:id/liberar', async (req, res) => {
    const nome = req.session.user?.nome || 'CENTRAL';
    try {
      const c = recebimento.liberar(req.params.id, { nome });
      logC({ tipo: 'liberar', loja: c.loja, nome, nfe: c.nNota, msg: c.devolucoes.map(d => d.origem + ' ' + d.cod + ' ' + d.qtd).join('; ') });
      const r = c.erp.nReg ? await espelhoErp(c, recebErp.passosLiberar(c, c.erp.nReg, { nome, dataHora: new Date() }), 'liberar') : (pendencia(c, { tipo: 'liberar', erro: 'conferência ainda sem nReg no ERP' }), null);
      res.json({ ok: true, conferencia: semInternos(recebimento.obter(req.params.id)), erp: r ? { logId: r.id } : { erro: c.erp.erros.at(-1)?.erro || 'sem nReg no ERP' } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento/:id/reconferir', async (req, res) => {
    const nome = req.session.user?.nome || 'CENTRAL';
    try {
      const c = recebimento.reconferir(req.params.id, { nome });
      logC({ tipo: 'reconferir', loja: c.loja, nome, nfe: c.nNota });
      await espelhoStatus(c, 5, nome);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento/:id/chat', (req, res) => {
    const nome = req.session.user?.nome || 'CENTRAL';
    try {
      const c = recebimento.obter(req.params.id); if (!c) return res.status(404).json({ error: 'Conferência não encontrada' });
      const m = recebimento.mensagem(req.params.id, { de: 'central', nome, texto: req.body.texto, cod: req.body.cod, acao: req.body.acao, msgId: req.body.msgId });
      if (!m.repetido) logC({ tipo: 'chat', loja: c.loja, nome, nfe: c.nNota, cod: m.cod, msg: [m.acao, m.texto].filter(Boolean).join(': ') });
      res.json(m);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // PDF "Aviso de devolução" da nota (3 origens: compras / coletor / falta). Só depois que a loja
  // terminou a contagem — antes disso a lista de devolução não existe (conferência cega).
  // Não gera evento de log: nada é gravado, é só a folha que o motorista assina.
  app.get('/api/recebimento/:id/devolucao/pdf', async (req, res) => {
    let c;
    try { c = recebimento.obter(req.params.id); } catch (e) { return res.status(st(e)).json({ error: e.message }); }
    if (!c) return res.status(404).json({ error: 'Conferência não encontrada' });
    if (!['terminada', 'liberada'].includes(c.status)) return res.status(409).json({ error: 'A loja ainda não terminou a conferência desta nota.' });
    const itens = (c.devolucoes && c.devolucoes.length ? c.devolucoes : recebimento.devolucoes(c)) || [];
    if (!itens.length) return res.status(404).json({ error: 'Sem itens de devolução nesta nota.' });
    let f;
    try {
      // gerarPdfDevolucao com `extras` devolve Promise que resolve quando o arquivo termina de ser escrito
      f = await pedidosFornec.gerarPdfDevolucao(null, c.loja, req.session?.user?.nome || null,
        { id: c.id, itens, nota: { nNota: c.nNota, chave: c.chave, fornecedor: c.fornecedor }, loja: c.loja, motorista: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
    res.sendFile(f, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="devolucao-${String(c.id).replace(/[^\w.-]/g, '_')}.pdf"` } });
  });

  // Reenvio: replay NA ORDEM (abrir → itens → status → liberar), sempre reconstruindo os passos do
  // ESTADO ATUAL da conferência. Não usa o array de passos guardado na pendência: entre a falha e o
  // reenvio a loja continuou bipando, e o que precisa chegar no ERP é a contagem de agora.
  app.post('/api/recebimento/:id/reenviar-erp', async (req, res) => {
    let c;
    try { c = recebimento.obter(req.params.id); } catch (e) { return res.status(st(e)).json({ error: e.message }); }
    if (!c) return res.status(404).json({ error: 'não encontrada' });
    const pend = (c.erp.erros || []).slice();
    let ok = 0, abriuAgora = false;

    if (!c.erp.nReg) {
      const r = await espelhoErp(c, recebErp.passosAbrir(c, { dataHora: new Date() }), 'abrir');
      c = recebimento.obter(req.params.id);
      if (!r || !c.erp.nReg) return res.json({ reenviados: ok, erros: c.erp.erros.length, erro: 'não deu pra abrir a conferência no ERP' });
      ok++; abriuAgora = true;
    }

    const codsPend = new Set(pend.filter(p => p.tipo === 'item' && p.cod).map(p => p.cod));
    for (const it of Object.values(c.itens || {})) {
      if (it.espelhado && !codsPend.has(it.cod)) continue;
      const r = await espelhoErp(c, recebErp.passosItem(c, it, c.erp.nReg), 'item', { cod: it.cod });
      c = recebimento.obter(req.params.id);
      if (r) ok++;
    }

    const pendStatus = pend.some(p => ['status', 'terminei', 'reconferir', 'liberar'].includes(p.tipo));
    if (abriuAgora || pendStatus) {
      if (c.status === 'terminada' || c.status === 'liberada') { if (await espelhoStatus(c, 3)) ok++; c = recebimento.obter(req.params.id); }
      if (c.status === 'bipando' && c.recontagens > 0) { if (await espelhoStatus(c, 5)) ok++; c = recebimento.obter(req.params.id); }
      if (c.status === 'liberada') { if (await espelhoErp(c, recebErp.passosLiberar(c, c.erp.nReg, { nome: c.liberadoPor || 'CENTRAL', dataHora: new Date() }), 'liberar')) ok++; c = recebimento.obter(req.params.id); }
    }
    res.json({ reenviados: ok, erros: c.erp.erros.length });
  });

  // exposto pra teste (sem contrato externo — os testes de recebimento-rotas usam isto pra evitar
  // recriar toda a lógica de veredito/espelho)
  return { cadastroItem, xmlPorChave, invalidarIndiceXml, notaDaChave, espelhoErp, rcLoja, logC };
};
