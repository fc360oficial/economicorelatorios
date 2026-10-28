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
      // saída liberada (fechada) nos últimos 7 dias some da lista — mesmo que o painel do Dlinks ainda esteja em "Para separação" (28/10)
      const fechadasHoje = nums.filter(n => !!expedicao.saidaLiberada(n));
      res.json(rows.map(r => { const c = expedicao.acharPorPedido(r.nPedido); const n = String(r.nPedido); const sep = c ? expedicao.separador(c) : null; const et = c ? expedicao.etapaAtual(c) : null; return {
        nPedido: n, cliente: String(r.cliente || '').trim(), cnpj: String(r.cnpj || ''), data: dataStr(r.Data), hora: String(r.hora || '').slice(0, 5), total: +r.total || 0,
        itens: qPorN[n] ? +qPorN[n].n : 0, painel: pPorN[n] ?? null,
        // etapa que falta: 'separacao' (sem conferência ou separando) · 'fiscal' (separação com divergência aguardando o fiscal do CD)
        // · 'expedicao' = carregamento (separada/expedindo) · 'unica' (modelo antigo)
        // · 'conferida' = carregamento fechado 100 %, aguardando o fiscal do CD liberar a saída (some da lista do coletor)
        conferencia: c ? { id: c.id, status: c.status, etapa: !c.etapas ? 'unica' : c.status === 'separando' ? 'separacao' : c.status === 'aguardando_fiscal' ? 'fiscal' : c.status === 'conferida' ? 'conferida' : 'expedicao', emAndamento: !!et, tentativas: et ? (et.tentativas || 0) : 0,
          separadoPor: sep ? sep.nome : null, souSeparador: !!(sep && s.operador && sep.id === s.operador.id),
          avisoFiscal: c.avisoFiscal ? c.avisoFiscal.obs : null, avisoCarga: c.avisoCarga ? (c.avisoCarga.obs || 'bipe o caminhão de novo') : null, liberada: !!(c.liberacao && c.liberacao.decisao === 'liberada') } : null, fechadaHoje: fechadasHoje.includes(n) || (c && c.status === 'conferida') };
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

  // Separação de Pedidos (com lista, 14/10 noite): acha o produto bipado no pedido (erro na hora se não está) e grava a
  // quantidade digitada do item. Carregamento continua cego pelo /bipar.
  app.get('/api/expedicao-publico/produto', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    if (!exigeOperador(s, res)) return;
    try {
      const id = expedicao.validarId(req.query.id); const r = await expedicao.produto(id, req.query.cod, s.operador);
      if (r.fora) { const c = expedicao.obter(id); logC({ tipo: 'exp_bipe', nome: nomeDe(s, req), nfe: c.nPedido, cod: r.cod, descricao: r.descricao, resultado: 'fora_do_pedido', msg: 'separação · produto não está no pedido' }); }
      res.json(r);
    } catch (e) { respErro(res, e); }
  });
  app.post('/api/expedicao-publico/separar', async (req, res) => {
    const s = rcCD(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    if (!exigeOperador(s, res)) return;
    try {
      const id = expedicao.validarId(req.body?.id); const r = await expedicao.separar(id, { ...(req.body || {}), nome: nomeDe(s, req), operador: s.operador });
      if (!r.repetido) { const c = expedicao.obter(id); logC({ tipo: r.resultado === 'fora_do_pedido' ? 'exp_bipe' : 'exp_separar', nome: nomeDe(s, req), nfe: c.nPedido, cod: r.item ? r.item.cod : req.body.cod, descricao: r.item ? r.item.descricao : r.descricao, quant: req.body.quant, emb: req.body.emb, un: r.item ? r.item.un : 0, lote: req.body.lote || '', resultado: r.resultado, msg: r.resultado === 'fora_do_pedido' ? 'separação · produto não está no pedido' : r.pedido ? 'separação · pedido ' + r.pedido.un + ' un' : 'separação' }); }
      res.json({ resultado: r.resultado, item: r.item, descricao: r.descricao, repetido: !!r.repetido, visao: expedicao.visao(id, s.operador) });
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
      const r = expedicao.terminei(id, { nome: nomeDe(s, req) || c0.nome, operador: s.operador, enviarFiscal: !!req.body?.enviarFiscal, motivo: req.body?.motivo });
      const c = expedicao.obter(id);
      const rotulo = r.etapa === 'separacao' ? 'separação' : 'carregamento';
      logC({ tipo: 'exp_fechar', nome: nomeDe(s, req), nfe: c.nPedido, resultado: r.fechou ? 'fechou 100%' : r.aguardandoFiscal ? 'fiscal' : 'nao fechou',
        msg: r.fechou ? (r.etapa === 'separacao' ? 'separação fechada 100 % · pedido vai pro carregamento' : c.status === 'conferida' ? 'carregamento bateu 100 % · aguardando o fiscal do CD liberar a saída' : 'pedido carregado e fechado')
          : r.aguardandoFiscal ? 'separação com ' + r.pendentes.length + ' divergência(s) mandada pro fiscal do CD' + (req.body?.motivo ? ' · ' + String(req.body.motivo).slice(0, 120) : '')
          : (rotulo + ': ' + r.pendentes.length + ' item(ns) pendente(s), ' + r.fora.length + ' fora ' + (r.etapa === 'expedicao' ? 'da separação' : 'do pedido')) });
      if (r.fechou && (c.status === 'fechada' || c.status === 'conferida')) {
        for (const ev of c.eventos) if (ev.tipo === 'lote_divergente' && !ev.logado) { ev.logado = true; logC({ tipo: 'lote_divergente', nome: ev.nome, nfe: c.nPedido, cod: ev.cod, descricao: ev.descricao, msg: 'separação ' + ev.separacao.map(l => l.lote + ' (' + l.un + ')').join(', ') + ' · expedição ' + ev.expedicao.map(l => l.lote + ' (' + l.un + ')').join(', ') }); }
        if (c.eventos.some(e => e.logado)) expedicao.salvar(c);
        // modelo antigo (uma etapa) fecha e espelha direto; no modelo de duas etapas o espelho só sai quando o fiscal libera a saída
        if (c.status === 'fechada' && !c.erp?.espelhadoEm) await espelhoFechar(c);
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
  // Separações com divergência aguardando o fiscal do CD: liberar pro carregamento (do jeito que está) ou devolver pra separação
  app.get('/api/expedicao/liberacoes', (req, res) => { try { res.json(expedicao.aguardandoFiscal(Math.min(+req.query.dias || 7, 60))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/expedicao/liberar', (req, res) => {
    try {
      const r = expedicao.decidirLiberacao(expedicao.validarId(req.body?.id), { decisao: req.body?.decisao, obs: req.body?.obs, nome: nomeSessao(req) });
      logC({ tipo: 'exp_fiscal', nome: nomeSessao(req), nfe: r.nPedido, resultado: r.liberacao.decisao, msg: (r.liberacao.decisao === 'liberada' ? 'fiscal do CD liberou a separação com divergência pro carregamento' : 'fiscal do CD devolveu o pedido pra separação') + (r.liberacao.obs ? ' · ' + r.liberacao.obs : '') });
      res.json(r);
    } catch (e) { respErro(res, e); }
  });
  // Carregamentos fechados 100 % aguardando o fiscal do CD confrontar pedido × separado × carregado e liberar a saída
  // (Tiago, 28/10). Liberar = fecha e espelha no ERP de teste; reconferir = volta pro carregamento com a observação.
  app.get('/api/expedicao/detalhe/:id', (req, res) => { try { const d = expedicao.detalhe(expedicao.validarId(req.params.id)); if (!d) return res.status(404).json({ error: 'Conferência não encontrada' }); res.json(d); } catch (e) { respErro(res, e); } });
  // Híbrido com o Dlinks (Tiago, 28/10: "esse pedido acho que foi liberado pelo Dlinks"): carregamento 100 % no nosso coletor
  // + pedido já Liberado (Status 4) no painel do Dlinks = saída fecha sozinha como liberada pelo DLINKS e sai da fila do fiscal.
  async function sincronizarComDlinks() {
    const conf = expedicao.aguardandoSaida(7); if (!conf.length) return;
    const nums = conf.map(c => String(c.nPedido));
    const rows = await q(`SELECT nPedido, Status FROM central.painel_televendas WHERE nLoja=? AND nPedido IN (${nums.map(() => '?').join(',')})`, [LOJA, ...nums]).catch(() => []);
    for (const r of rows) {
      if (+r.Status !== 4) continue; const c = conf.find(x => String(x.nPedido) === String(r.nPedido)); if (!c) continue;
      try {
        const rr = expedicao.liberarSaida(c.id, { decisao: 'liberar', nome: 'DLINKS', obs: 'liberado no painel do Dlinks' });
        logC({ tipo: 'exp_fiscal', nome: 'DLINKS', nfe: rr.nPedido, resultado: 'liberada', msg: 'saída fechada sozinha: pedido já Liberado no painel do Dlinks' });
        const f = expedicao.obter(c.id); if (f && !f.erp?.espelhadoEm) await espelhoFechar(f);
      } catch (e) { console.error('[EXPEDICAO] sincronizar Dlinks', c.nPedido, e.message); }
    }
  }
  app.get('/api/expedicao/saidas', async (req, res) => { try { await sincronizarComDlinks(); res.json(expedicao.aguardandoSaida(Math.min(+req.query.dias || 7, 60))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/expedicao/liberar-saida', async (req, res) => {
    try {
      const r = expedicao.liberarSaida(expedicao.validarId(req.body?.id), { decisao: req.body?.decisao, obs: req.body?.obs, nome: nomeSessao(req) });
      logC({ tipo: 'exp_fiscal', nome: nomeSessao(req), nfe: r.nPedido, resultado: r.saida.decisao, msg: (r.saida.decisao === 'liberada' ? 'fiscal do CD liberou a saída do caminhão' : 'fiscal do CD mandou reconferir o carregamento') + (r.saida.obs ? ' · ' + r.saida.obs : '') });
      let erp = null;
      if (r.status === 'fechada') { const c = expedicao.obter(r.id); if (c && !c.erp?.espelhadoEm) { const x = await espelhoFechar(c); erp = x ? { ok: true, logId: x.id } : { ok: false, erro: ((expedicao.obter(r.id) || {}).erp?.erros || [])[0]?.erro || 'ERP de teste não respondeu' }; } }
      res.json({ ...r, erp });
    } catch (e) { respErro(res, e); }
  });
  // Pedido do Dlinks na nossa tela (Tiago, 28/10: "vamos ter a separação mostrando as separações do Dlinks também aqui?"):
  // pedidos do painel do Dlinks (7 dias pendentes ou liberados hoje) SEM conferência nossa entram na lista com status 'dlinks'
  // e o Status do painel (0 Para separação · 1 Em separação · 2 Aguardando liberação · 3 Reconferir · 4 Liberado).
  async function pedidosSoDlinks(nossos, de, ate) {
    // com de/ate: entrou OU foi liberado no período, mais os pendentes dos últimos 7 dias; sem: pendentes 7 dias + liberados hoje
    const sql = de ? `((p.DataEntrada BETWEEN ? AND ?) OR (p.DataLiberacao BETWEEN ? AND ?) OR (p.Status<4 AND p.DataEntrada>=CURDATE()-INTERVAL 7 DAY))` : `((p.Status<4 AND p.DataEntrada>=CURDATE()-INTERVAL 7 DAY) OR (p.Status=4 AND p.DataLiberacao=CURDATE()))`;
    const rows = await q(`SELECT p.nPedido, p.NomeFornec nome, p.Status status, DATE_FORMAT(p.DataEntrada,'%Y-%m-%d') de, p.HoraEntrada he, DATE_FORMAT(p.DataLiberacao,'%Y-%m-%d') dl
      FROM central.painel_televendas p WHERE p.nLoja=? AND ${sql} ORDER BY p.nReg DESC`, de ? [LOJA, de, ate, de, ate] : [LOJA]).catch(() => []);
    const fora = rows.filter(r => !nossos.has(String(r.nPedido))); if (!fora.length) return [];
    const nums = fora.map(r => String(r.nPedido));
    const qtd = await q(`SELECT nPedido, COUNT(*) n FROM central.delivery_produtos WHERE nPedido IN (${nums.map(() => '?').join(',')}) GROUP BY nPedido`, nums).catch(() => []);
    const conf = await q(`SELECT nPedido, COUNT(DISTINCT Codigobarra) n, MAX(Data) d FROM central.conferencia_televendas WHERE nLoja=? AND nPedido IN (${nums.map(() => '?').join(',')}) GROUP BY nPedido`, [LOJA, ...nums]).catch(() => []);
    const qN = Object.fromEntries(qtd.map(x => [String(x.nPedido), +x.n])), cN = Object.fromEntries(conf.map(x => [String(x.nPedido), x]));
    return fora.map(r => { const n = String(r.nPedido); const he = String(r.he || '').slice(0, 8); return { id: 'dl-' + n, nPedido: n, cliente: String(r.nome || '').trim(), status: 'dlinks', dlStatus: +r.status, abertoEm: r.de ? r.de + 'T' + (he || '00:00:00') : null, liberadoEm: r.dl || null,
      produtos: cN[n] ? +cN[n].n : 0, produtos_pedido: qN[n] || 0, tirados: 0, pendentesVerificar: 0, lotesDivergentes: 0, etapas: null, liberacao: null, saida: null, reconferencias: 0, erpErro: null }; });
  }
  // Bipagem que o Dlinks gravou (central.conferencia_televendas) × pedido (delivery_produtos), pra linha DLINKS abrir no Fiscal
  app.get('/api/expedicao/detalhe-dlinks/:nPedido', async (req, res) => {
    try {
      const n = String(req.params.nPedido || '').replace(/\D/g, ''); if (!n) return res.status(400).json({ error: 'pedido inválido' });
      const cab = await q(`SELECT nPedido, Nome FROM central.delivery WHERE nLoja=? AND nPedido=? LIMIT 1`, [LOJA, n]); if (!cab[0]) return res.status(404).json({ error: 'Pedido não encontrado no Televendas' });
      const itens = await q(`SELECT CodigoBarra cod, Descricao descricao, Und und, Qtd qtd, QtdEmb qtdEmb FROM central.delivery_produtos WHERE nPedido=? ORDER BY nReg`, [n]);
      const conf = await q(`SELECT Codigobarra cod, SUM(Qtd) qtd, MAX(QtdEmb) emb, MAX(Data) d FROM central.conferencia_televendas WHERE nLoja=? AND nPedido=? GROUP BY Codigobarra`, [LOJA, n]).catch(() => []);
      const pan = await q(`SELECT Status status FROM central.painel_televendas WHERE nLoja=? AND nPedido=? ORDER BY nReg DESC LIMIT 1`, [LOJA, n]).catch(() => []);
      const cPor = Object.fromEntries(conf.map(c => [String(c.cod).trim(), c]));
      const lin = itens.map(i => { const cod = String(i.cod || '').trim(); const und = String(i.und || '').trim().toUpperCase(); const qtdEmb = +i.qtdEmb > 0 ? +i.qtdEmb : 0; const emCaixa = und !== '' && und !== 'UN' && qtdEmb > 0;
        // Dlinks grava Qtd NA UNIDADE DA LINHA do pedido (pedido 7563, 28/10: "2 CX c/24" → Qtd 2, QtdEmb 1), igual à folha:
        // caixa × QtdEmb do pedido vira unidades; linha em UN fica em unidades. Tiago: "temos produtos em caixas e em unidades, tem que vir certo".
        const pedido = emCaixa ? +(+i.qtd * qtdEmb).toFixed(3) : +(+i.qtd || 0); const c = cPor[cod]; const confQtd = c ? +(+c.qtd || 0) : 0; const conferido = emCaixa ? +(confQtd * qtdEmb).toFixed(3) : confQtd;
        return { cod, ean4: cod.replace(/[^0-9]/g, '').slice(-4), descricao: String(i.descricao || '').trim(), und, qtd: +i.qtd || 0, emb: qtdEmb || 1, emCaixa, confQtd, pedido, separado: conferido, carregado: conferido, difSeparado: +(conferido - pedido).toFixed(3), difCarregado: 0, lotesSep: [], lotesCarga: [], loteDiferente: false }; });
      for (const c of conf) { const cod = String(c.cod).trim(); if (!lin.find(l => l.cod === cod)) { const un = +((+c.qtd || 0) * (+c.emb > 0 ? +c.emb : 1)).toFixed(3); lin.push({ cod, ean4: cod.replace(/[^0-9]/g, '').slice(-4), descricao: 'Código ' + cod, und: '', qtd: 0, emb: 1, pedido: 0, separado: un, carregado: un, difSeparado: un, difCarregado: 0, lotesSep: [], lotesCarga: [], loteDiferente: false, foraDoPedido: true }); } }
      res.json({ id: 'dl-' + n, nPedido: n, cliente: String(cab[0].Nome || '').trim(), status: 'dlinks', dlStatus: pan[0] ? +pan[0].status : null, modeloDlinks: true, separadoPor: 'coletor do Dlinks', carregadoPor: 'coletor do Dlinks', conferidaEm: conf.length ? conf.map(c => c.d).sort().pop() : null,
        tentativasSep: 0, tentativasCarga: 0, liberacao: null, reconferencias: 0, tirados: [], itens: lin, divergencias: lin.filter(l => l.difSeparado !== 0).length, semConferencia: !conf.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/expedicao/fechadas', async (req, res) => {
    try {
      // de/ate (navegador de datas do Fiscal, Tiago 28/10) = pedidos abertos no período; os PENDENTES dos últimos 7 dias entram
      // sempre (fila do fiscal não some ao trocar a data). Sem de/ate: últimos `dias` (7).
      const okD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); const de = okD(req.query.de) ? req.query.de : null, ate = okD(req.query.ate) ? req.query.ate : de;
      const n = Math.min(+req.query.dias || 7, 60); const out = []; const vistos = new Set();
      const ymdL = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const diasLista = [];
      if (de) for (let d = new Date(de + 'T12:00:00'), k = 0; ymdL(d) <= ate && k < 62; d.setDate(d.getDate() + 1), k++) diasLista.push([ymdL(d), true]);
      for (let i = 0; i < (de ? 7 : n); i++) diasLista.push([ymdL(new Date(Date.now() - i * 864e5)), !de]);
      const PEND = ['separando', 'aguardando_fiscal', 'separada', 'expedindo', 'conferida'];
      for (const [dia, tudo] of diasLista) for (const c of expedicao.listarDia(dia)) { if (vistos.has(c.id) || (!tudo && !PEND.includes(c.status))) continue; vistos.add(c.id);
        out.push({ id: c.id, nPedido: c.nPedido, cliente: c.cliente, status: c.status, nome: c.nome, abertoEm: c.abertoEm, fechadoEm: c.fechadoEm || null, fechadoPor: c.fechadoPor || null, etapas: expedicao.etapasDe(c),
          tentativas: c.etapas ? ((c.etapas.separacao.tentativas || 0) + ((c.etapas.expedicao || {}).tentativas || 0)) : (c.tentativas || 0), produtos: Object.keys(expedicao.itensSaida(c)).length, produtos_pedido: Object.keys(c.pedido).length,
          liberacao: c.liberacao ? { decisao: c.liberacao.decisao, decididoPor: c.liberacao.decididoPor, decididoEm: c.liberacao.decididoEm, obs: c.liberacao.obs, motivo: c.liberacao.motivo, pendentes: (c.liberacao.pendentes || []).length } : null,
          conferidaEm: c.conferidaEm || null, saida: c.saida || null, reconferencias: (c.carregamentosAnteriores || []).length,
          tirados: c.eventos.filter(e => e.tipo === 'tirar_coletagem').length, pendentesVerificar: c.eventos.filter(e => (e.tipo === 'tirar_coletagem' || e.tipo === 'lote_divergente') && !e.verificado).length, lotesDivergentes: c.eventos.filter(e => e.tipo === 'lote_divergente').length, erpErro: (c.erp?.erros || [])[0]?.erro || null }); }
      // toda a expedição (Tiago, 28/10: "poderia trazer toda a expedição né"): pedidos só no Dlinks entram junto
      let dl = []; try { dl = await pedidosSoDlinks(new Set(out.map(c => String(c.nPedido))), de, ate); } catch (e) { console.error('[EXPEDICAO] pedidos do Dlinks:', e.message); }
      res.json(out.concat(dl).sort((a, b) => String(b.abertoEm).localeCompare(String(a.abertoEm))));
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

  // Validades do CD registradas no ERP (26/10/26, Tiago: "já que não temos validade, traga tudo de validades do mais próximo").
  // O recebimento do ERP grava em central.itenscoletorvalidade uma linha por item de cada nota com a DATA DE VALIDADE
  // (na loja 10 sem lote nem quantidade: Lote='0', Qtd=0). Cruzamos com estoque atual (estoquen10), custo (custoloja10)
  // e giro de 30 dias dos pedidos faturados pra dizer o que vence antes de vender. Só leitura; nada é gravado no ERP.
  const numBR = v => { const s = String(v == null ? '0' : v).trim(); const n = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : 0; };
  const diasAte = (hoje, iso) => Math.round((new Date(iso + 'T12:00:00') - new Date(hoje + 'T12:00:00')) / 864e5);
  let VAL_CACHE = { em: 0, dados: null };
  app.get('/api/expedicao/validades', async (req, res) => {
    try {
      if (!req.query.forcar && VAL_CACHE.dados && Date.now() - VAL_CACHE.em < 5 * 60e3) return res.json(VAL_CACHE.dados);
      const hoje = recebimento.hojeStr();
      const d30 = new Date(new Date(hoje + 'T12:00:00').getTime() - 30 * 864e5).toISOString().slice(0, 10);
      // consultas separadas de propósito: estoquen10 e custoloja10 não têm índice por código e o JOIN direto levava 12 s (26/10)
      const rows = await q(`SELECT v.Codigobarra cod, DATE_FORMAT(v.Data,'%Y-%m-%d') validade, DATE_FORMAT(v.dataEntrada,'%Y-%m-%d') entrada, v.nDoc, v.nCompra, v.Lote lote, v.Qtd qtd
        FROM central.itenscoletorvalidade v WHERE v.nLoja = ? AND v.Data > '2000-01-01' ORDER BY v.Data`, [LOJA]);
      const marks = a => a.map(() => '?').join(',');
      const cods = [...new Set(rows.map(r => String(r.cod).trim()))], compras = [...new Set(rows.map(r => +r.nCompra).filter(Boolean))];
      const cad = new Map(), est = new Map(), custo = new Map(), forn = new Map();
      for (let i = 0; i < cods.length; i += 800) { const ch = cods.slice(i, i + 800);
        for (const r of await q(`SELECT CodigoBarra cod, TRIM(Descricao) d FROM central.itens WHERE CodigoBarra IN (${marks(ch)})`, ch)) cad.set(String(r.cod).trim(), String(r.d || '').trim());
        for (const r of await q(`SELECT CodigoBarra cod, Qtd FROM central.estoquen10 WHERE CodigoBarra IN (${marks(ch)})`, ch)) est.set(String(r.cod).trim(), numBR(r.Qtd));
        for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja10 WHERE CodigoBarra IN (${marks(ch)})`, ch).catch(() => [])) custo.set(String(r.cod).trim(), numBR(r.Custo)); }
      for (let i = 0; i < compras.length; i += 800) { const ch = compras.slice(i, i + 800);
        for (const r of await q(`SELECT nCompra, NomeFornec FROM central.compras WHERE nLoja = ? AND nCompra IN (${marks(ch)})`, [LOJA, ...ch]).catch(() => [])) forn.set(+r.nCompra, String(r.NomeFornec || '').trim()); }
      for (const r of rows) { const cod = String(r.cod).trim(); r.descricao = cad.get(cod) || null; r.est = est.get(cod) || 0; r.custo = custo.get(cod) || 0; r.fornecedor = forn.get(+r.nCompra) || null; }
      const giro = new Map();
      for (const g of await q(`SELECT p.CodigoBarra cod, SUM(p.Qtd) q30, DATE_FORMAT(MAX(d.Data),'%Y-%m-%d') ult FROM central.delivery_produtos p JOIN central.delivery d ON d.nPedido = p.nPedido
          WHERE d.nLoja = ? AND d.Status <> 9 AND (d.NFe <> '0' OR d.CCF > 0) AND d.Data > ? AND p.nPedido > 2700 GROUP BY p.CodigoBarra`, [LOJA, d30]).catch(e => { console.error('[VALIDADES] giro', e.message); return []; }))
        giro.set(String(g.cod).trim(), { q30: numBR(g.q30), ult: g.ult ? String(g.ult).slice(0, 10) : null });
      // uma linha por produto × validade; as notas que trouxeram essa validade ficam listadas na linha
      const mapa = {};
      for (const r of rows) {
        const cod = String(r.cod).trim(), validade = String(r.validade).slice(0, 10); if (!validade || validade.startsWith('0000')) continue;
        const k = cod + '|' + validade;
        const m = mapa[k] || (mapa[k] = { cod, descricao: String(r.descricao || '').trim() || cod, validade, dias: diasAte(hoje, validade), est: numBR(r.est), custo: numBR(r.custo), lote: null, notas: [] });
        const lote = String(r.lote || '').trim(); if (lote && lote !== '0') m.lote = m.lote ? m.lote + ', ' + lote : lote;
        m.notas.push({ nDoc: String(r.nDoc || '').trim(), nCompra: +r.nCompra || null, fornecedor: String(r.fornecedor || '').trim() || null, entrada: r.entrada ? String(r.entrada).slice(0, 10) : null, qtd: numBR(r.qtd) || null });
      }
      // nº de validades diferentes de cada produto (a mais próxima aparece primeiro na lista ordenada por validade)
      const porProduto = {}; for (const m of Object.values(mapa)) { const p = porProduto[m.cod] || (porProduto[m.cod] = { n: 0, maisNova: null, ultimaEntrada: null });
        p.n++; if (!p.maisNova || m.validade > p.maisNova) p.maisNova = m.validade; for (const nt of m.notas) if (nt.entrada && (!p.ultimaEntrada || nt.entrada > p.ultimaEntrada)) p.ultimaEntrada = nt.entrada; }
      const linhas = Object.values(mapa).map(m => {
        const g = giro.get(m.cod) || { q30: 0, ult: null }; const giroDia = g.q30 / 30; const cobertura = m.est > 0 && giroDia > 0 ? Math.round(m.est / giroDia) : null;
        const faixa = m.dias < 0 ? 'vencido' : m.dias <= 30 ? 'd30' : m.dias <= 90 ? 'd90' : 'ok';
        m.notas.sort((a, b) => String(b.entrada || '').localeCompare(String(a.entrada || '')));
        const p = porProduto[m.cod];
        return { ...m, valor: +(m.est * m.custo).toFixed(2), q30: g.q30, ultVenda: g.ult, cobertura, faixa, risco: null, principal: false, validadesDoProduto: p.n, validadeMaisNova: p.maisNova !== m.validade ? p.maisNova : null, ultimaEntrada: p.ultimaEntrada };
      }).sort((a, b) => a.validade.localeCompare(b.validade) || a.descricao.localeCompare(b.descricao));
      // O estoque é do PRODUTO (o ERP não sabe quanto é de cada validade). A validade "principal" — a que carrega o estoque, o risco e
      // os totais — é a mais próxima AINDA NÃO VENCIDA; vencida só é principal se o produto não recebeu validade mais nova (aí o
      // estoque é suspeito de verdade). Vencida com validade mais nova depois = histórico, fica na lista sem risco.
      // FIFO estimado: o estoque cobre "cobertura" dias de venda, então o que está na prateleira entrou mais ou menos nesse prazo;
      // uma validade cuja última entrada é bem mais antiga que isso (1,5× + 7 d) já deve ter saído e vira histórico ("provavelVendida").
      const porCod = {}; for (const l of linhas) (porCod[l.cod] || (porCod[l.cod] = [])).push(l);
      for (const ls of Object.values(porCod)) {
        const cob = ls[0].cobertura, janela = cob != null ? Math.round(cob * 1.5) + 7 : null;
        const idade = l => (l.notas[0] && l.notas[0].entrada) ? diasAte(l.notas[0].entrada, hoje) : null;
        const recente = l => janela == null || idade(l) == null || idade(l) <= janela;
        const p = ls.find(l => l.dias >= 0 && recente(l)) || ls[ls.length - 1]; p.principal = true;
        for (const l of ls) { l.idadeEntrada = idade(l); l.janelaFifo = janela; if (l !== p && l.dias >= 0 && l.validade < p.validade) l.provavelVendida = true; }
        if (p.est > 0) { if (p.dias < 0) p.risco = 'vencido'; else if (p.q30 <= 0) p.risco = 'sem_giro'; else if (p.cobertura != null && p.cobertura > p.dias) p.risco = 'vence_antes'; else p.risco = 'vende_a_tempo'; } }
      const vistos = new Set(linhas.map(l => l.cod));
      const comEst = linhas.filter(l => l.est > 0 && l.principal);
      const soma = arr => +arr.reduce((s, l) => s + l.valor, 0).toFixed(2);
      const dados = { hoje, total: linhas.length, produtos: vistos.size, comEstoque: comEst.length, resumo: {
          vencidos: comEst.filter(l => l.faixa === 'vencido').length, d30: comEst.filter(l => l.faixa === 'd30').length, d90: comEst.filter(l => l.faixa === 'd90').length, ok: comEst.filter(l => l.faixa === 'ok').length,
          semEstoque: linhas.filter(l => l.principal && !(l.est > 0)).length, valorVencido: soma(comEst.filter(l => l.faixa === 'vencido')), valor30: soma(comEst.filter(l => l.faixa === 'd30')),
          valor90: soma(comEst.filter(l => l.faixa === 'd90')), venceAntes: comEst.filter(l => l.risco === 'vence_antes').length },
        linhas };
      VAL_CACHE = { em: Date.now(), dados };
      res.json(dados);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { pedidoDoErp, espelhoFechar, rcCD };
};
