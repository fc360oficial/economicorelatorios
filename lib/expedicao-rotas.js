// lib/expedicao-rotas.js — Expedição do CD (loja 10) no coletor: rotas públicas por token da loja 10
// (conferência cega de saída do pedido do Televendas) e internas (sessão: pendências "verificar pallet",
// Lotes no CD). Estado em lib/expedicao.js; espelho no ERP de teste em lib/expedicao-erp.js.
// Spec: docs/superpowers/specs/2026-09-29-coletor-cd-expedicao-processo.md
module.exports = function montarRotasExpedicao(app, deps) {
  const { q, escreverERP, recebimento, expedicao, logColetor, LOG_COLETOR_DIR } = deps;
  const expErp = require('./expedicao-erp');
  const LOJA = expedicao.LOJA_CD;
  const logC = ev => { try { logColetor.registrar(LOG_COLETOR_DIR, { loja: LOJA, ...ev }); } catch (e) { console.error('[EXPEDICAO] log:', e.message); } };
  const rcCD = req => { const s = recebimento.lojaPorToken(req.query.t || req.body?.t); return s && +s.loja === LOJA ? s : null; };
  const dataStr = d => { const x = new Date(d); return isNaN(x) ? String(d || '').slice(0, 10) : new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

  async function pedidoDoErp(nPedido) {
    const cab = await q(`SELECT nPedido, Nome, CPF, Data, Hora, Total, Status, NFe FROM central.delivery WHERE nLoja=? AND nPedido=? LIMIT 1`, [LOJA, nPedido]);
    if (!cab[0]) return null;
    const itens = await q(`SELECT CodigoBarra cod, Descricao descricao, Und und, Qtd qtd, QtdEmb qtdEmb, Conversao conversao FROM central.delivery_produtos WHERE nPedido=? ORDER BY nReg`, [nPedido]);
    return { cab: cab[0], itens };
  }

  async function espelhoFechar(c) {
    let r = null, erro = null;
    try {
      const montado = expErp.passosFechar(c, { dataHora: new Date() });
      r = await escreverERP.lote({ usuario: 'coletor:' + c.nome, motivo: montado.motivo, banco: 'central', passos: montado.passos, limite: 500 });
      if (!r.ok) throw new Error(r.erro || ('ERP recusou (' + r.status + ')'));
    } catch (e) { erro = e.message; r = null; }
    const f = expedicao.obter(c.id) || c; f.erp = f.erp || { nReg: null, erros: [] };
    if (erro) { f.erp.erros = [{ em: new Date().toISOString(), tipo: 'fechar', erro }]; expedicao.salvar(f); logC({ tipo: 'erp', nome: f.nome, nfe: f.nPedido, erro, msg: 'expedicao fechar' }); return null; }
    f.erp.erros = []; f.erp.ultimoLogId = r.id; f.erp.espelhadoEm = new Date().toISOString(); expedicao.salvar(f);
    logC({ tipo: 'erp', nome: f.nome, nfe: f.nPedido, logErpId: r.id, msg: 'expedicao fechar' }); return r;
  }

  // ── públicas (token da loja 10) ─────────────────────────────────────────
  app.get('/api/expedicao-publico/pedidos', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida ou loja sem expedição.' });
    try {
      const desde = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
      // pedidos do Televendas do CD ainda sem nota de venda (Status 0/1); cancelado (9) e faturado (2) ficam fora
      const rows = await q(`SELECT d.nPedido, d.Nome cliente, d.CPF cnpj, d.Data, d.Hora hora, d.Total total, d.Status status FROM central.delivery d WHERE d.nLoja=? AND d.Data>=? AND d.Status IN (0,1) AND (d.NFe IS NULL OR d.NFe='' OR d.NFe='0') ORDER BY d.Data DESC, d.Hora DESC LIMIT 100`, [LOJA, desde]);
      const nums = rows.map(r => String(r.nPedido));
      const painel = nums.length ? await q(`SELECT nPedido, Status status FROM central.painel_televendas WHERE nLoja=? AND nPedido IN (${nums.map(() => '?').join(',')})`, [LOJA, ...nums]).catch(() => []) : [];
      const qtd = nums.length ? await q(`SELECT nPedido, COUNT(*) n, SUM(Qtd) un FROM central.delivery_produtos WHERE nPedido IN (${nums.map(() => '?').join(',')}) GROUP BY nPedido`, nums).catch(() => []) : [];
      const pPorN = Object.fromEntries(painel.map(p => [String(p.nPedido), Number(p.status)])); const qPorN = Object.fromEntries(qtd.map(x => [String(x.nPedido), x]));
      const fechadasHoje = expedicao.listarDia(expedicao.hojeStr()).filter(c => c.status === 'fechada').map(c => c.nPedido);
      res.json(rows.map(r => { const c = expedicao.acharPorPedido(r.nPedido); const n = String(r.nPedido); return {
        nPedido: n, cliente: String(r.cliente || '').trim(), cnpj: String(r.cnpj || ''), data: dataStr(r.Data), hora: String(r.hora || '').slice(0, 5), total: +r.total || 0,
        itens: qPorN[n] ? +qPorN[n].n : 0, painel: pPorN[n] ?? null, conferencia: c ? { id: c.id, status: c.status, tentativas: c.tentativas || 0 } : null, fechadaHoje: fechadasHoje.includes(n) };
      // Enquanto os dois coletores convivem, o status segue o painel de expedição do Dlinks (Tiago, 29/09):
      // conferido lá (2) ou liberado (4) já foi feito pelo outro coletor e some daqui.
      }).filter(p => !p.fechadaHoje && p.painel !== 4 && p.painel !== 2));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/expedicao-publico/abrir', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const nPedido = String(req.body?.nPedido || '').replace(/\D/g, ''); if (!nPedido) return res.status(400).json({ error: 'nPedido obrigatório' });
      const nome = String(req.body?.nome || '').toUpperCase().slice(0, 20);
      let c = expedicao.acharPorPedido(nPedido);
      if (!c) {
        const p = await pedidoDoErp(nPedido); if (!p) return res.status(404).json({ error: 'Pedido não encontrado no Televendas do CD.' });
        if (!p.itens.length) return res.status(409).json({ error: 'Pedido sem itens no Televendas.' });
        c = expedicao.abrirPedido({ nPedido, cliente: p.cab.Nome, cnpj: p.cab.CPF, nome, itens: p.itens, total: p.cab.Total });
        logC({ tipo: 'exp_abrir', nome: c.nome, nfe: c.nPedido, descricao: c.cliente, quant: p.itens.length, msg: 'pedido aberto pra conferência de saída' });
      }
      res.json(expedicao.visao(c.id));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/expedicao-publico/visao/:id', (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try { const v = expedicao.visao(expedicao.validarId(req.params.id)); if (!v) return res.status(404).json({ error: 'Conferência não encontrada' }); res.json(v); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/expedicao-publico/bipar', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const id = expedicao.validarId(req.body?.id); const r = await expedicao.bipar(id, req.body || {});
      if (!r.repetido && r.resultado !== 'sem_lote') { const c = expedicao.obter(id); logC({ tipo: 'exp_bipe', nome: c.nome, nfe: c.nPedido, cod: r.item ? r.item.cod : req.body.cod, descricao: r.item?.descricao, quant: req.body.quant, emb: req.body.emb, un: r.item?.un, lote: req.body.lote || '', resultado: r.resultado }); }
      res.json({ resultado: r.resultado, item: r.item, repetido: !!r.repetido, visao: expedicao.visao(id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/expedicao-publico/tirar', (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const id = expedicao.validarId(req.body?.id); const c0 = expedicao.obter(id); if (!c0) return res.status(404).json({ error: 'Conferência não encontrada' });
      const r = expedicao.tirar(id, { ...req.body, nome: req.body?.nome || c0.nome });
      logC({ tipo: 'tirar_coletagem', nome: r.evento.nome, nfe: c0.nPedido, cod: r.evento.cod, descricao: r.evento.descricao, quant: r.evento.quant, un: r.evento.un, lote: r.evento.lote || '', resultado: r.evento.fora ? 'fora_do_pedido' : 'a_mais', msg: 'antes ' + r.evento.antes + ' → depois ' + r.evento.depois + (r.evento.motivo ? ' · ' + r.evento.motivo : '') + ' · VERIFICAR PALLET' });
      res.json({ evento: r.evento, item: r.item, visao: expedicao.visao(id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/expedicao-publico/terminei', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const id = expedicao.validarId(req.body?.id); const c0 = expedicao.obter(id); if (!c0) return res.status(404).json({ error: 'Conferência não encontrada' });
      const r = expedicao.terminei(id, { nome: req.body?.nome || c0.nome });
      const c = expedicao.obter(id);
      logC({ tipo: 'exp_fechar', nome: c.nome, nfe: c.nPedido, resultado: r.fechou ? 'fechou 100%' : 'nao fechou', msg: r.fechou ? 'pedido conferido e fechado' : (r.pendentes.length + ' item(ns) pendente(s), ' + r.fora.length + ' fora do pedido') });
      if (r.fechou && !c.erp?.espelhadoEm) await espelhoFechar(c);
      res.json({ ...r, visao: expedicao.visao(id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ── internas (sessão da retaguarda) ────────────────────────────────────
  const nomeSessao = req => String(req.session?.user?.nome || req.session?.user?.usuario || 'FISCAL').toUpperCase().slice(0, 20);
  app.get('/api/expedicao/pendencias', (req, res) => { try { res.json(expedicao.pendenciasVerificacao(Math.min(+req.query.dias || 7, 60))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/expedicao/verificar', (req, res) => {
    try { const ev = expedicao.verificarPallet(expedicao.validarId(req.body?.id), +req.body?.idx, nomeSessao(req)); logC({ tipo: 'tirar_coletagem', nome: ev.verificado.nome, nfe: String(req.body.id).slice(18), cod: ev.cod, descricao: ev.descricao, resultado: 'verificado', msg: 'fiscal do CD verificou o pallet' }); res.json(ev); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.get('/api/expedicao/fechadas', (req, res) => {
    try {
      const n = Math.min(+req.query.dias || 7, 60); const out = [];
      for (let i = 0; i < n; i++) { const d = new Date(Date.now() - i * 864e5); const dia = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        for (const c of expedicao.listarDia(dia)) out.push({ id: c.id, nPedido: c.nPedido, cliente: c.cliente, status: c.status, nome: c.nome, abertoEm: c.abertoEm, fechadoEm: c.fechadoEm || null, fechadoPor: c.fechadoPor || null, tentativas: c.tentativas || 0, produtos: Object.keys(c.itens).length, produtos_pedido: Object.keys(c.pedido).length, tirados: c.eventos.filter(e => e.tipo === 'tirar_coletagem').length, pendentesVerificar: c.eventos.filter(e => e.tipo === 'tirar_coletagem' && !e.verificado).length, erpErro: (c.erp?.erros || [])[0]?.erro || null }); }
      res.json(out.sort((a, b) => String(b.abertoEm).localeCompare(String(a.abertoEm))));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Lotes no CD: entradas (conferências de RECEBIMENTO da loja 10, uma linha por lote) × saídas (expedições fechadas)
  app.get('/api/expedicao/lotes', (req, res) => {
    try {
      const n = Math.min(+req.query.dias || 60, 180); const mapa = {};
      const chave = (cod, lote) => cod + '|' + (lote || '');
      for (let i = 0; i < n; i++) { const d = new Date(Date.now() - i * 864e5); const dia = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        for (const c of recebimento.listarDia(dia)) { if (+c.loja !== LOJA) continue;
          for (const it of Object.values(c.itens || {})) for (const l of (it.lotes || [])) { if (!l.lote) continue; const k = chave(it.cod, l.lote);
            const m = mapa[k] || (mapa[k] = { cod: it.cod, descricao: it.descricao, lote: l.lote, validade: l.validade || it.validade || null, entrou: 0, saiu: 0, entradas: [], saidas: [] });
            m.entrou = +(m.entrou + l.un).toFixed(3); m.entradas.push({ nfe: c.nNota, fornecedor: c.fornecedor, em: c.abertoEm, un: l.un }); if (l.validade && (!m.validade || l.validade < m.validade)) m.validade = l.validade; } } }
      for (const s of expedicao.saidasPorLote(n)) { const k = chave(s.cod, s.lote); const m = mapa[k] || (mapa[k] = { cod: s.cod, descricao: s.descricao, lote: s.lote, validade: null, entrou: 0, saiu: 0, entradas: [], saidas: [] });
        m.saiu = +(m.saiu + s.un).toFixed(3); m.saidas.push({ nPedido: s.nPedido, cliente: s.cliente, em: s.em, un: s.un }); }
      const lotes = Object.values(mapa).map(m => ({ ...m, saldo: +(m.entrou - m.saiu).toFixed(3) })).sort((a, b) => a.descricao.localeCompare(b.descricao) || String(a.validade || '').localeCompare(String(b.validade || '')));
      res.json(lotes);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { pedidoDoErp, espelhoFechar, rcCD };
};
