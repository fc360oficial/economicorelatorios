// lib/expedicao-rotas.js — Expedição do CD (loja 10) no coletor: rotas públicas por token da loja 10 + token do
// operador (PIN pessoal) — conferência cega de saída do pedido do Televendas em duas etapas (separação → expedição,
// quem separou não expede) — e internas (sessão: pendências do fiscal, operadores, Lotes no CD).
// Estado em lib/expedicao.js; espelho no ERP de teste em lib/expedicao-erp.js.
// Spec: docs/superpowers/specs/2026-09-29-coletor-cd-expedicao-processo.md
module.exports = function montarRotasExpedicao(app, deps) {
  const { q, escreverERP, recebimento, expedicao, logColetor, LOG_COLETOR_DIR } = deps;
  const expErp = require('./expedicao-erp');
  const LOJA = expedicao.LOJA_CD;
  const logC = ev => { try { logColetor.registrar(LOG_COLETOR_DIR, { loja: LOJA, ...ev }); } catch (e) { console.error('[EXPEDICAO] log:', e.message); } };
  // sessão do coletor: t = token da loja 10; o = token do operador (PIN pessoal). Sem operador a leitura funciona,
  // mas abrir/bipar/terminei exigem (a trava "quem separou não expede" precisa saber quem é).
  const rcCD = req => { const s = recebimento.lojaPorToken(req.query.t || req.body?.t); if (!s || +s.loja !== LOJA) return null; return { ...s, operador: expedicao.operadorPorToken(req.query.o || req.body?.o) }; };
  const exigeOperador = (s, res) => { if (s.operador) return true; res.status(403).json({ error: expedicao.temOperadores() ? 'Entre de novo com o seu PIN pessoal.' : 'Cadastre os operadores do CD na retaguarda (Centro de Distribuição › Expedição) e entre com o PIN pessoal.' }); return false; };
  const dataStr = d => { const x = new Date(d); return isNaN(x) ? String(d || '').slice(0, 10) : new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const nomeDe = (s, req) => String((s.operador && s.operador.nome) || req.body?.nome || '').toUpperCase().slice(0, 20);
  const respErro = (res, e) => res.status(e.status || 500).json({ error: e.message, separadoPor: e.separadoPor || undefined });

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
      r = await escreverERP.lote({ usuario: 'coletor:' + (c.fechadoPor || c.nome), motivo: montado.motivo, banco: 'central', passos: montado.passos, limite: 500 });
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
      res.json(rows.map(r => { const c = expedicao.acharPorPedido(r.nPedido); const n = String(r.nPedido); const sep = c ? expedicao.separador(c) : null; const et = c ? expedicao.etapaAtual(c) : null; return {
        nPedido: n, cliente: String(r.cliente || '').trim(), cnpj: String(r.cnpj || ''), data: dataStr(r.Data), hora: String(r.hora || '').slice(0, 5), total: +r.total || 0,
        itens: qPorN[n] ? +qPorN[n].n : 0, painel: pPorN[n] ?? null,
        // etapa que falta: 'separacao' (sem conferência ou separando) · 'expedicao' (separada/expedindo) · 'unica' (modelo antigo)
        conferencia: c ? { id: c.id, status: c.status, etapa: !c.etapas ? 'unica' : (c.status === 'separando' ? 'separacao' : 'expedicao'), emAndamento: !!et, tentativas: et ? (et.tentativas || 0) : 0,
          separadoPor: sep ? sep.nome : null, souSeparador: !!(sep && s.operador && sep.id === s.operador.id) } : null, fechadaHoje: fechadasHoje.includes(n) };
      // Enquanto os dois coletores convivem, o status segue o painel de expedição do Dlinks (Tiago, 29/09):
      // 0 Para separação · 1 Em separação · 2 Aguardando liberação · 3 Reconferir · 4 Liberado.
      // Aguardando liberação (2) e Liberado (4) já passaram pelo outro coletor e somem daqui; Reconferir (3) fica.
      // Digitado (ainda fora do painel, painel null) também não entra: o pedido ainda está aberto e pode ser ajustado.
      }).filter(p => !p.fechadaHoje && p.painel != null && p.painel !== 4 && p.painel !== 2));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/expedicao-publico/abrir', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    if (!exigeOperador(s, res)) return;
    try {
      const nPedido = String(req.body?.nPedido || '').replace(/\D/g, ''); if (!nPedido) return res.status(400).json({ error: 'nPedido obrigatório' });
      const nome = nomeDe(s, req);
      let c = expedicao.acharPorPedido(nPedido);
      if (!c) {
        const p = await pedidoDoErp(nPedido); if (!p) return res.status(404).json({ error: 'Pedido não encontrado no Televendas do CD.' });
        if (!p.itens.length) return res.status(409).json({ error: 'Pedido sem itens no Televendas.' });
        c = expedicao.abrirPedido({ nPedido, cliente: p.cab.Nome, cnpj: p.cab.CPF, nome, itens: p.itens, total: p.cab.Total, operador: s.operador });
        logC({ tipo: 'exp_abrir', nome, nfe: c.nPedido, descricao: c.cliente, quant: p.itens.length, msg: 'pedido aberto · separação' });
      } else {
        const antes = c.status;
        c = expedicao.abrirPedido({ nPedido, itens: [], operador: s.operador });   // retoma; 'separada' → abre a expedição (com a trava)
        if (antes === 'separada' && c.status === 'expedindo') logC({ tipo: 'exp_abrir', nome, nfe: c.nPedido, descricao: c.cliente, msg: 'expedição aberta (separado por ' + (expedicao.separador(c) || {}).nome + ')' });
      }
      res.json(expedicao.visao(c.id, s.operador));
    } catch (e) {
      if (e.status === 409 && e.separadoPor) logC({ tipo: 'exp_trava', nome: nomeDe(s, req), nfe: String(req.body?.nPedido || ''), resultado: 'recusado', msg: 'tentou expedir o que separou (' + e.separadoPor + ')' });
      respErro(res, e);
    }
  });

  app.get('/api/expedicao-publico/visao/:id', (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try { const v = expedicao.visao(expedicao.validarId(req.params.id), s.operador); if (!v) return res.status(404).json({ error: 'Conferência não encontrada' }); res.json(v); }
    catch (e) { respErro(res, e); }
  });

  app.post('/api/expedicao-publico/bipar', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    if (!exigeOperador(s, res)) return;
    try {
      const id = expedicao.validarId(req.body?.id); const r = await expedicao.bipar(id, { ...(req.body || {}), nome: nomeDe(s, req), operador: s.operador });
      if (!r.repetido && r.resultado !== 'sem_lote') { const c = expedicao.obter(id); const et = expedicao.etapaAtual(c); logC({ tipo: 'exp_bipe', nome: nomeDe(s, req), nfe: c.nPedido, cod: r.item ? r.item.cod : req.body.cod, descricao: r.item?.descricao, quant: req.body.quant, emb: req.body.emb, un: r.item?.un, lote: req.body.lote || '', resultado: r.resultado, msg: et && et.etapa ? et.etapa : undefined }); }
      res.json({ resultado: r.resultado, item: r.item, repetido: !!r.repetido, visao: expedicao.visao(id, s.operador) });
    } catch (e) { respErro(res, e); }
  });

  app.post('/api/expedicao-publico/tirar', (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    if (!exigeOperador(s, res)) return;
    try {
      const id = expedicao.validarId(req.body?.id); const c0 = expedicao.obter(id); if (!c0) return res.status(404).json({ error: 'Conferência não encontrada' });
      const r = expedicao.tirar(id, { ...req.body, nome: nomeDe(s, req) || c0.nome, operador: s.operador });
      logC({ tipo: 'tirar_coletagem', nome: r.evento.nome, nfe: c0.nPedido, cod: r.evento.cod, descricao: r.evento.descricao, quant: r.evento.quant, un: r.evento.un, lote: r.evento.lote || '', resultado: r.evento.fora ? 'fora_do_pedido' : 'a_mais', msg: (r.evento.etapa ? r.evento.etapa + ' · ' : '') + 'antes ' + r.evento.antes + ' → depois ' + r.evento.depois + (r.evento.motivo ? ' · ' + r.evento.motivo : '') + ' · VERIFICAR PALLET' });
      res.json({ evento: r.evento, item: r.item, visao: expedicao.visao(id, s.operador) });
    } catch (e) { respErro(res, e); }
  });

  app.post('/api/expedicao-publico/terminei', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    if (!exigeOperador(s, res)) return;
    try {
      const id = expedicao.validarId(req.body?.id); const c0 = expedicao.obter(id); if (!c0) return res.status(404).json({ error: 'Conferência não encontrada' });
      const r = expedicao.terminei(id, { nome: nomeDe(s, req) || c0.nome, operador: s.operador });
      const c = expedicao.obter(id);
      const rotulo = r.etapa === 'separacao' ? 'separação' : 'expedição';
      logC({ tipo: 'exp_fechar', nome: nomeDe(s, req), nfe: c.nPedido, resultado: r.fechou ? 'fechou 100%' : 'nao fechou', msg: r.fechou ? (r.etapa === 'separacao' ? 'separação fechada 100 % · pedido vai pra expedição' : 'pedido conferido e fechado') : (rotulo + ': ' + r.pendentes.length + ' item(ns) pendente(s), ' + r.fora.length + ' fora do pedido') });
      if (r.fechou && c.status === 'fechada') {
        for (const ev of c.eventos) if (ev.tipo === 'lote_divergente' && !ev.logado) { ev.logado = true; logC({ tipo: 'lote_divergente', nome: ev.nome, nfe: c.nPedido, cod: ev.cod, descricao: ev.descricao, msg: 'separação ' + ev.separacao.map(l => l.lote + ' (' + l.un + ')').join(', ') + ' · expedição ' + ev.expedicao.map(l => l.lote + ' (' + l.un + ')').join(', ') }); }
        if (c.eventos.some(e => e.logado)) expedicao.salvar(c);
        if (!c.erp?.espelhadoEm) await espelhoFechar(c);
      }
      res.json({ ...r, visao: expedicao.visao(id, s.operador) });
    } catch (e) { respErro(res, e); }
  });

  // ── internas (sessão da retaguarda) ────────────────────────────────────
  const nomeSessao = req => String(req.session?.user?.nome || req.session?.user?.usuario || 'FISCAL').toUpperCase().slice(0, 20);
  app.get('/api/expedicao/pendencias', (req, res) => { try { res.json(expedicao.pendenciasVerificacao(Math.min(+req.query.dias || 7, 60))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/expedicao/verificar', (req, res) => {
    try { const ev = expedicao.verificarPallet(expedicao.validarId(req.body?.id), +req.body?.idx, nomeSessao(req)); logC({ tipo: ev.tipo, nome: ev.verificado.nome, nfe: String(req.body.id).slice(18), cod: ev.cod, descricao: ev.descricao, resultado: 'verificado', msg: ev.tipo === 'lote_divergente' ? 'fiscal do CD viu a divergência de lote' : 'fiscal do CD verificou o pallet' }); res.json(ev); }
    catch (e) { respErro(res, e); }
  });
  app.get('/api/expedicao/fechadas', (req, res) => {
    try {
      const n = Math.min(+req.query.dias || 7, 60); const out = [];
      for (let i = 0; i < n; i++) { const d = new Date(Date.now() - i * 864e5); const dia = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        for (const c of expedicao.listarDia(dia)) out.push({ id: c.id, nPedido: c.nPedido, cliente: c.cliente, status: c.status, nome: c.nome, abertoEm: c.abertoEm, fechadoEm: c.fechadoEm || null, fechadoPor: c.fechadoPor || null, etapas: expedicao.etapasDe(c),
          tentativas: c.etapas ? ((c.etapas.separacao.tentativas || 0) + ((c.etapas.expedicao || {}).tentativas || 0)) : (c.tentativas || 0), produtos: Object.keys(expedicao.itensSaida(c)).length, produtos_pedido: Object.keys(c.pedido).length,
          tirados: c.eventos.filter(e => e.tipo === 'tirar_coletagem').length, pendentesVerificar: c.eventos.filter(e => (e.tipo === 'tirar_coletagem' || e.tipo === 'lote_divergente') && !e.verificado).length, lotesDivergentes: c.eventos.filter(e => e.tipo === 'lote_divergente').length, erpErro: (c.erp?.erros || [])[0]?.erro || null }); }
      res.json(out.sort((a, b) => String(b.abertoEm).localeCompare(String(a.abertoEm))));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Operadores do CD (PIN pessoal): cadastro na retaguarda. Quem separa não pode expedir o mesmo pedido.
  app.get('/api/expedicao/operadores', (req, res) => { try { res.json(expedicao.operadores()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/expedicao/operadores', (req, res) => {
    try { const op = expedicao.salvarOperador(req.body || {}); logC({ tipo: 'operador', nome: nomeSessao(req), descricao: op.nome, resultado: op.ativo ? 'ativo' : 'inativo', msg: (req.body?.id ? 'operador editado' : 'operador criado') + ' na retaguarda' }); res.json(op); }
    catch (e) { respErro(res, e); }
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
