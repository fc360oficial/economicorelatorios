// lib/recebimento-rotas.js — Coletor de Recebimento (conferência cega): rotas públicas por token
// (celular do conferente) e internas (sessão, módulo fiscal), com espelho no ERP de teste (.254).
// Ver lib/recebimento.js (estado da conferência) e lib/recebimento-erp.js (passos pro escreverERP).
module.exports = function montarRotasRecebimento(app, deps) {
  const { q: qErp, path, escreverERP, pedidosFornec, conferenciaXml, logColetor, LOG_COLETOR_DIR, __dirname } = deps;
  // 20/10/26: tudo aqui é rota interativa (coletor na mão do conferente, fiscal na tela): não paga a pausa de 5 min que um
  // job pesado em central.axml provoca no q() do servidor — tenta com o timeout normal e, se estourar, avisa só esta chamada.
  const q = (sql, params, opt) => qErp(sql, params, { ignorarPausa: true, ...(opt || {}) });
  const recebimento = require('./recebimento');
  const escopo = require('./escopo');
  const recebErp = require('./recebimento-erp');
  // CNPJ de destino por loja pro coletor. A loja 10 (CD / CAHU Distribuidora) só existe aqui: o
  // cruzamento pedido × XML do conferencia-xml.js continua olhando só as lojas 1-6.
  const CNPJ_LOJA = { ...conferenciaXml.LOJA_CNPJ, 10: '61920643000148' };

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
  // 18/11/26 (Tiago, CD, NF 340, Pampulha "300 c/20 = 6000 un"): os itens saem do XML COMPLETADO pela entrada que o ERP
  // já lançou pra nota (lib/recebimento-entrada.js) — a entrada dá o código interno da linha "SEM GTIN" e as un/cx que
  // o XML não traz. O XML não muda (cache de 5 min); a entrada pode ser corrigida no ERP com a conferência aberta
  // (foi o caso: lançada 300 UN, corrigida pra 300 CX c/ 20), então ela tem cache curto e os itens são refeitos a cada chamada.
  const { itensDaNota } = require('./recebimento-entrada');
  const entradaCache = cacheTtl(60e3, 500);
  async function xmlDaChave(chave) {
    const j = notaCache.get(chave); if (j !== undefined) return j;
    let v = null;
    try {
      const cab = await q(`SELECT Chave, nNota, CNPJemit, CNPJdest, NomeEmit FROM central.axml WHERE Chave=? AND nMod='55' LIMIT 1`, [chave]);
      if (cab[0]) {
        // emb (un/cx) sai da PRÓPRIA nota: 200 CX comerciais = 2400 un tributárias → 12 (11/11/26, CD, NF 643671 3 Corações);
        // ean = EAN tributário quando difere do comercial (nota pela caixa, item bipado pela unidade): o bipe casa por ele
        const prods = await q(`SELECT nItem, CodigoBarras, ocEanTrib, Descricao, Und, Qtd, oqTrib FROM central.axmlprodutos WHERE nNota=? AND CNPJemit=? ORDER BY nItem`, [cab[0].nNota, cab[0].CNPJemit]).catch(() => []);
        v = { chave, nNota: String(cab[0].nNota), cnpjEmit: String(cab[0].CNPJemit || ''), cnpjDest: String(cab[0].CNPJdest || ''), nomeEmit: String(cab[0].NomeEmit || '').trim(), prods: prods || [] };
      }
    } catch (e) { console.error('[COLETOR] nota da chave:', e.message); return null; }  // erro de banco não entra no cache
    return notaCache.set(chave, v);
  }
  // Entrada do ERP pra esta NF-e nesta loja: central.compras pela chave → central.compraprodutos (nCompra, nLoja), as
  // mesmas colunas que o Fiscal lê. Só LEITURA. Sem entrada (ou erro de banco) = [] e a nota fica só pelo XML.
  async function entradaDaChave(chave, loja) {
    if (!loja) return [];
    const k = loja + ':' + chave; const j = entradaCache.get(k); if (j !== undefined) return j;
    let v = [];
    try {
      const cs = await q(`SELECT nCompra, nLoja, Status FROM central.compras WHERE chave=? AND nLoja=? ORDER BY nReg DESC LIMIT 5`, [chave, loja]);
      for (const c of cs || []) {
        if (!c || !+c.nCompra) continue;
        const its = await q(`SELECT Item, CodigoBarra, Unid, Qtd, QtdEmb, QtdEntradaEstoque, Descricao, Cancelado, ocEanTrib FROM central.compraprodutos WHERE nCompra=? AND nLoja=?`, [c.nCompra, loja]);
        const vivos = (its || []).filter(i => i && !+i.Cancelado);
        if (vivos.length) { v = vivos; break; }   // lançamento mais recente que tem item (o cancelado fica sem nenhum)
      }
    } catch (e) { console.error('[COLETOR] entrada do ERP:', e.message); return null; }  // erro de banco: null (≠ "sem entrada") e fora do cache
    return entradaCache.set(k, v);
  }
  const lojaDoCnpj = cnpj => +Object.keys(CNPJ_LOJA).find(k => CNPJ_LOJA[k] === cnpj) || 0;
  async function notaDaChave(chave) {
    const x = await xmlDaChave(chave); if (!x) return null;
    const entrada = x.prods.length ? await entradaDaChave(chave, lojaDoCnpj(x.cnpjDest)) : [];
    const { prods, ...cab } = x;
    // entradaFalhou: a leitura da entrada deu erro — a nota sai só pelo XML (dá pra abrir e bipar), mas uma conferência
    // já aberta NÃO troca a lista dela por esta (senão um soluço do ERP desfazia o código e as un/cx que a entrada deu)
    return { ...cab, itens: itensDaNota(prods, entrada || []), ...(entrada === null ? { entradaFalhou: true } : {}) };
  }

  // Fornecedor pela RAIZ do CNPJ do emitente (axml.CodFornec vem sempre "0" — ver conferencia-xml.js).
  async function fornecedorPorCnpj(cnpjEmit) {
    const raiz = String(cnpjEmit || '').replace(/\D/g, '').slice(0, 8);
    if (raiz.length < 8) return null;
    const r = await q(`SELECT CodFornec cod, Nome nome FROM central.fornecedor WHERE LEFT(CNPJ,8)=? LIMIT 1`, [raiz]).catch(() => []);
    return r[0] ? { cod: +r[0].cod || 0, nome: String(r[0].nome || '').trim() } : null;
  }

  const validadeMinDias = () => { try { return +require('./fiscal').getConfig().validade_min_dias || 0; } catch { return 7; } };
  recebimento.init({ dir: path.join(__dirname, 'data', 'recebimento'), cadastro: cadastroItem, xmlLoja: xmlPorChave, validadeMinDias, vinculo: deps.vinculo || null });
  // Caixa (DUN-14) com cadastro próprio de qtdemb 1 → unidade e unidades por caixa, pro cartão do coletor já abrir
  // contando caixas (07/11/26). Vínculo do Pedidos do CD primeiro, senão a conta DUN-14 → EAN-13. null = não é caixa.
  const { dun14ParaEan13 } = require('./pedidos-cd-util');
  // unidadeErp (18/11/26) = linha da nota que a ENTRADA do ERP lançou com este código (a caixa): vale antes da conta DUN-14.
  async function caixaParaUnidade(cod, embNotaDe, unidadeErp) {
    const v = deps.vinculo ? await deps.vinculo(cod) : null;
    const u = v && v.cod ? String(v.cod) : (unidadeErp || dun14ParaEan13(cod));
    if (!u || u === cod) return null;
    const cadU = await cadastroItem(u); if (!cadU) return null;
    const embNota = embNotaDe ? +embNotaDe(u) || 0 : 0;   // un/cx da própria nota (mesma ordem do resolverCaixa)
    const emb = v && +v.emb > 1 ? +v.emb : embNota > 1 ? embNota : cadU.qtdemb > 1 ? cadU.qtdemb : 1;
    return { cod: u, emb, emb_label: cadU.emb || null };
  }
  // Conferência aberta antes de 11/11/26 (ou reaberta pelo Reconferir sem passar pelo /abrir) não tem as un/cx da nota
  // nos itens: completa a partir do XML antes do bipe. abrirNota numa conferência existente só faz esse complemento.
  // 18/11/26: além disso a lista da nota é REFEITA quando a entrada do ERP muda com a conferência aberta (NF 340 no CD:
  // a entrada estava 300 UN quando o conferente abriu a nota e foi corrigida pra 300 CX c/ 20 depois). Só troca quando
  // todas as notas da conferência foram lidas e a lista veio diferente; conferência liberada não muda mais.
  async function atualizarNota(c) {
    if (!c || !c.chave || c.status === 'liberada') return;
    const chaves = recebimento.chavesDe(c);
    const notas = (await Promise.all(chaves.map(k => notaDaChave(k)))).filter(Boolean);
    if (!notas.length || notas.length !== chaves.length || notas.some(n => n.entradaFalhou)) return;
    recebimento.atualizarItensNota(c.id, somarItensNotas(notas));
  }
  // o bipe não espera o ERP além de 3 s: se a leitura demorar, segue com a lista que a conferência já tem
  const comPrazo = (p, ms = 3000) => Promise.race([Promise.resolve(p).catch(e => { console.error('[COLETOR] atualizar nota:', e.message); }), new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); })]);

  // ── várias NF-e numa conferência só (17/11/26) ────────────────────────────
  // O Dlinks junta as notas do mesmo caminhão numa conferência (central.conferenciachave → conferencia) e o coletor
  // deles bipa tudo junto, somando as notas: PepsiCo no CD, conferência 188840 = NF-e 831947/48/49, aparecia 3 vezes
  // aqui. grupoDaNota devolve as notas da conferência do Dlinks em que esta chave está (só desta loja, ordem do nº);
  // sem conferência no Dlinks (ou já liberada) a nota segue sozinha, como sempre foi.
  async function grupoDaNota(loja, nota) {
    let chaves = [];
    try {
      const r = await q(`SELECT k2.Chave chave FROM central.conferenciachave k1 JOIN central.conferencia c ON c.nReg=k1.nRegConf JOIN central.conferenciachave k2 ON k2.nRegConf=c.nReg WHERE k1.Chave=? AND c.Status<>2 AND c.Obs NOT LIKE 'Economico%' AND c.nLoja=? ORDER BY c.nReg DESC`, [nota.chave, loja]);
      chaves = [...new Set((r || []).map(x => String(x.chave || '').trim()).filter(k => k.length === 44))];
    } catch (e) { console.error('[COLETOR] grupo da nota:', e.message); }
    if (chaves.length < 2 || !chaves.includes(nota.chave)) return [nota];
    const notas = [];
    for (const k of chaves) { const n = k === nota.chave ? nota : await notaDaChave(k); if (n && n.cnpjDest === nota.cnpjDest) notas.push(n); }
    return notas.sort((a, b) => (+a.nNota || 0) - (+b.nNota || 0) || String(a.chave).localeCompare(String(b.chave)));
  }
  // Itens de várias notas somados por código (mesma regra de dentro da nota): un soma; un/cx só fica se for a mesma.
  function somarItensNotas(notas) {
    if (notas.length === 1) return notas[0].itens;
    const porCod = new Map();
    for (const n of notas) for (const i of n.itens || []) {
      const a = porCod.get(i.cod);
      if (!a) { porCod.set(i.cod, { ...i }); continue; }
      a.un = +(a.un + i.un).toFixed(3); if (a.emb !== i.emb) { a.emb = null; delete a.cx; } else if (!i.cx) delete a.cx;
      if (!a.ean && i.ean) a.ean = i.ean; if (!a.erp && i.erp) a.erp = i.erp;
    }
    return [...porCod.values()];
  }
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
    if (tipo === 'abrir') { f.erp.nReg = r.ids?.[0] || null; f.erp.chaves = recebimento.chavesDe(c); }   // c = a conferência de onde saíram os passos
    if (tipo === 'chaves') f.erp.chaves = [...new Set([...(f.erp.chaves || [f.chave]), ...(extra.chaves || [])])];
    if (extra.cod && f.itens && f.itens[extra.cod]) { f.itens[extra.cod].espelhado = true; if (extra.codErp) f.itens[extra.cod].espelhado_cod = extra.codErp; }   // espelhado_cod = código com que a linha está no ERP (caixa ou unidade)
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
    const p = recebErp.passosItem(c, item, c.erp.nReg);
    return espelhoErp(c, { motivo: p.motivo, passos: p.passos }, 'item', { cod: item.cod, codErp: p.codErp });
  }
  async function espelhoStatus(c, status, nome) {
    if (!c.erp.nReg) { pendencia(c, { tipo: 'status', status, erro: 'conferência ainda sem nReg no ERP' }); return null; }
    return espelhoErp(c, recebErp.passosStatus(c, c.erp.nReg, status, { nome: nome || c.nome, dataHora: new Date() }), 'status', { status });
  }
  // NF-e que entraram na conferência depois de ela já existir no ERP (conferência de uma nota só que virou grupo).
  // erp.chaves = chaves já gravadas em conferenciachave; conferência antiga sem o campo tinha só a c.chave.
  async function espelhoChaves(c) {
    if (!c.erp || !c.erp.nReg) return null;
    const ja = c.erp.chaves || [c.chave];
    const faltam = recebimento.chavesDe(c).filter(k => !ja.includes(k));
    if (!faltam.length) return null;
    return espelhoErp(c, recebErp.passosChaves(c, c.erp.nReg, faltam), 'chaves', { chaves: faltam });
  }

  // ── rotas públicas (?t=token ou body.t) ─────────────────────────────────────
  // 15/10 (Tiago: "o código de barras não lê nada, não sei mais o que fazer"): /leitor-teste.html manda pra cá tudo o
  // que o aparelho entrega quando bipa (keydown, input, paste, composition), pra eu ver no log em que modo o leitor está.
  // Sem token de propósito (é só diagnóstico); corpo curto, loja 0 = teste.
  app.post('/api/recebimento-publico/diag', (req, res) => {
    try { const b = req.body || {}; logC({ tipo: 'diag', loja: +b.loja || 99, nome: String(b.nome || 'LEITOR').toUpperCase().slice(0, 20), msg: String(b.msg || '').slice(0, 2000), resultado: String(b.resultado || '').slice(0, 40) }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/recebimento-publico/entrar', (req, res) => {
    const { loja, pin, nome, pinPessoal } = req.body || {}; const r = recebimento.lojaPorPin(parseInt(loja, 10), String(pin || '').trim());
    if (!r) return res.status(401).json({ error: 'PIN não confere com essa loja.' });
    // Loja 10 (CD): depois do PIN da loja entra o PIN PESSOAL do operador (Tiago, 14/10/26) — a expedição em duas
    // etapas precisa saber quem é quem pra travar "quem separou não expede". O nome vem do cadastro da retaguarda.
    if (+r.loja === 10) {
      const expedicao = require('./expedicao');
      if (!expedicao.temOperadores()) return res.status(401).json({ error: 'Nenhum operador do CD cadastrado. Cadastre nome e PIN pessoal na retaguarda (Centro de Distribuição › Expedição).' });
      const op = expedicao.entrarOperador(pinPessoal);
      if (!op) return res.status(401).json({ error: 'PIN pessoal não confere. Cada pessoa do CD tem o seu, cadastrado na retaguarda.' });
      logC({ tipo: 'entrar', loja: r.loja, nome: op.operador.nome, msg: 'PIN pessoal · ' + (req.body?.diag ? String(req.body.diag).slice(0, 140) : String(req.headers['user-agent'] || '').slice(0, 60)) });
      return res.json({ ...r, nome: op.operador.nome, operador: op.operador, opToken: op.token });
    }
    logC({ tipo: 'entrar', loja: r.loja, nome: String(nome || '').toUpperCase(), msg: req.body?.diag ? String(req.body.diag).slice(0, 140) : String(req.headers['user-agent'] || '').slice(0, 80) });
    res.json({ ...r, nome: String(nome || '').toUpperCase().slice(0, 20) });
  });
  // 28/10/26 (Tiago: "quando der 100 % tem que deslogar pra outra pessoa?"): não desloga. O coletor do CD fica na
  // bancada o turno inteiro; o que muda é a PESSOA. Troca de operador = só o PIN pessoal, mantendo a sessão da loja 10
  // (sem digitar PIN da loja de novo). A mesma rota destrava o coletor depois de parado: quem pegar digita o seu PIN
  // e a sessão passa a ser dele — se for outra pessoa, a trava "quem separou não carrega" segue valendo no servidor.
  app.post('/api/recebimento-publico/trocar-operador', (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida. Entre de novo com o PIN.' });
    if (+s.loja !== 10) return res.status(400).json({ error: 'Troca de operador só no coletor do CD.' });
    const expedicao = require('./expedicao');
    const op = expedicao.entrarOperador(req.body?.pinPessoal);
    if (!op) return res.status(401).json({ error: 'PIN pessoal não confere. Cada pessoa do CD tem o seu, cadastrado na retaguarda.' });
    const de = String(req.body?.de || '').toUpperCase().slice(0, 20);
    logC({ tipo: 'entrar', loja: s.loja, nome: op.operador.nome, msg: (req.body?.motivo === 'bloqueio' ? 'destravou o coletor' : 'troca de operador') + (de && de !== op.operador.nome ? ' · antes ' + de : '') });
    res.json({ loja: s.loja, token: s.token, nome: op.operador.nome, operador: op.operador, opToken: op.token });
  });

  // Uma linha por conferência do Dlinks (ou por conferência nossa que já junta várias notas); nota sozinha segue sozinha.
  // A linha do grupo leva chave = 1ª nota (é ela que vai no /abrir), chaves/notas = todas e nNota = "831947, 831948".
  function agruparNotas(lista) {
    const grupos = new Map();
    for (const n of lista) {
      const k = n.erp && n.erp.conf ? 'e' + n.erp.conf : n.conferencia ? 'c' + n.conferencia.id : 'n' + n.chave;
      const g = grupos.get(k); if (g) g.push(n); else grupos.set(k, [n]);
    }
    return [...grupos.values()].map(g => {
      if (g.length === 1) return g[0];
      g.sort((a, b) => (+a.nNota || 0) - (+b.nNota || 0));
      const conf = g.map(n => n.conferencia).find(Boolean) || null;
      return { ...g[0], nNota: g.map(n => n.nNota).join(', '), chaves: g.map(n => n.chave), notas: g.map(n => ({ chave: n.chave, nNota: n.nNota })),
        pedidoId: g.map(n => n.pedidoId).find(Boolean) || null, conferencia: conf, tipo: g.some(n => n.tipo === 'devolucao') ? 'devolucao' : g[0].tipo };
    });
  }

  app.get('/api/recebimento-publico/notas', async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida. Entre de novo com o PIN.' });
    try {
      const cfg = recebimento.config(); const cnpj = CNPJ_LOJA[s.loja]; const desde = new Date(Date.now() - cfg.janela_dias_axml * 864e5).toISOString().slice(0, 10);
      // Importado NÃO filtra mais (Tiago, 15/10: "nota dado entrada 185304 no CD e não tou vendo no coletor"): quando a
      // Carmem "dá entrada" no Dlinks (conferencia Status 1/5, compras Status E) o axml já vira Importado=1 com a nota
      // ainda aberta pra conferir. O que tira da lista é a conferência liberada (Status 2) ou compras finalizada (F);
      // Importado=1 SEM lançamento em compras nesta loja também sai (importada por outro caminho, spec §4.2).
      const rows = await q(`SELECT a.Chave chave, a.nNota, a.CNPJemit, a.Data, a.Importado importado FROM central.axml a WHERE a.CNPJdest=? AND a.nMod='55' AND a.Data>=? ORDER BY a.Data DESC, a.nReg DESC LIMIT 200`, [cnpj, desde]);
      const raizes = [...new Set(rows.map(r => String(r.CNPJemit).slice(0, 8)))];
      const forn = raizes.length ? await q(`SELECT LEFT(CNPJ,8) raiz, CodFornec cod, Nome nome FROM central.fornecedor WHERE LEFT(CNPJ,8) IN (${raizes.map(() => '?').join(',')})`, raizes) : [];
      const fPorRaiz = Object.fromEntries(forn.map(f => [f.raiz, f]));
      // Conferência já feita pelo Dlinks na central (central.conferencia, Status 2 = liberada): a nota fica
      // Importado=0 até o CPD dar entrada, então só o Importado não basta — sem isso a loja 10 via pra
      // bipar nota que a CARMEM já tinha liberado (29/09/26). Liberada some da lista; aberta no ERP
      // (outro Status) continua, mas avisada. Obs 'Economico%' é o nosso espelho, não conta.
      const chaves = rows.map(r => r.chave);
      const confErp = chaves.length ? await q(`SELECT cc.Chave chave, cc.nRegConf conf, c.Status status, c.OperadorLoja operador FROM central.conferenciachave cc JOIN central.conferencia c ON c.nReg=cc.nRegConf WHERE cc.Chave IN (${chaves.map(() => '?').join(',')}) AND c.Obs NOT LIKE 'Economico%' ORDER BY c.nReg`, chaves) : [];
      const erpPorChave = {}; for (const e of confErp) erpPorChave[e.chave] = { status: Number(e.status), operador: String(e.operador || '').trim(), conf: Number(e.conf) || null };
      // Finalizada no Dlinks = já tem lançamento em central.compras nesta loja (Status F), mesmo com axml.Importado=0
      // (devolução de loja/cliente pro CD fica assim: compras DEVOLUCAO-CONS finalizada e Importado nunca vira 1). 29/09/26.
      const compras = chaves.length ? await q(`SELECT chave, Status status FROM central.compras WHERE nLoja=? AND chave IN (${chaves.map(() => '?').join(',')})`, [s.loja, ...chaves]).catch(() => []) : [];
      const lancada = new Set(compras.filter(x => String(x.status).toUpperCase() === 'F').map(x => String(x.chave)));
      const emCompras = new Set(compras.map(x => String(x.chave)));
      // Tipo da nota pelo XML: finNFe 4 = devolução (de loja do grupo ou cliente pro CD); o resto é compra normal.
      const xmls = chaves.length ? await q(`SELECT chave, SUBSTRING_INDEX(SUBSTRING_INDEX(xml,'<finNFe>',-1),'</finNFe>',1) fin, SUBSTRING_INDEX(SUBSTRING_INDEX(xml,'<natOp>',-1),'</natOp>',1) natOp FROM central.arquivoxml WHERE chave IN (${chaves.map(() => '?').join(',')})`, chaves).catch(() => []) : [];
      const tipoPorChave = {}; for (const x of xmls) tipoPorChave[String(x.chave)] = String(x.fin).trim() === '4' || /devol/i.test(String(x.natOp || '')) ? 'devolucao' : 'compra';
      // ontem + hoje: nota aberta antes da meia-noite continua sendo a mesma conferência (I4).
      const conf = {};
      for (const dia of [recebimento.ontemStr(), recebimento.hojeStr()]) for (const c of recebimento.listarDia(dia)) if (+c.loja === s.loja) for (const k of recebimento.chavesDe(c)) conf[k] = c;
      const lista = rows.filter(r => !(erpPorChave[r.chave] && erpPorChave[r.chave].status === 2) && !lancada.has(String(r.chave)) && !(Number(r.importado) === 1 && !emCompras.has(String(r.chave)))).map(r => {
        const x = xmlPorChave(r.chave); const f = fPorRaiz[String(r.CNPJemit).slice(0, 8)]; const c = conf[r.chave]; const erp = erpPorChave[r.chave] || null;
        return { chave: r.chave, nNota: String(r.nNota), fornecedor: f ? f.nome : 'CNPJ ' + r.CNPJemit, codFornec: f ? f.cod : 0, pedidoId: x ? x.pedidoId : null, veredito: !x ? 'sem_pedido' : x.status === 'conciliado' ? 'liberada' : 'divergente', conferencia: c ? { id: c.id, status: c.status } : null, erp, tipo: tipoPorChave[r.chave] || 'compra' };
      });
      res.json(agruparNotas(lista).filter(n => !n.conferencia || n.conferencia.status !== 'liberada'));
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

  // DANFE bipada com o caminhão ainda fechado (spec 2026-09-29-coletor-danfe-antes-de-descarregar): a
  // chave validada fica guardada 2 h por loja e /abrir exige isso, salvo pra retomar conferência já aberta.
  const danfeOk = cacheTtl(2 * 3600 * 1000, 500);
  const chaveDanfe = ch => String(ch || '').replace(/\s/g, '');
  app.post('/api/recebimento-publico/danfe', async (req, res) => {
    try {
      const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
      const nome = String(req.body?.nome || '').toUpperCase().slice(0, 20);
      const chave = chaveDanfe(req.body?.chave);
      if (chave.length !== 44) {
        // registra também o bipe inválido — sem isso o log fica cego pra loja "bipando e nada acontece"
        logC({ tipo: 'danfe', loja: s.loja, nome, chave, resultado: 'chave_invalida', msg: 'bipe com ' + chave.length + ' dígito(s) — não é chave de NF-e' });
        return res.status(400).json({ error: 'Isso não é uma chave de NF-e (44 dígitos). Bipe o código de barras da DANFE.' });
      }
      const cnpjEmit = chave.slice(6, 20);
      const nota = await notaDaChave(chave);
      let resultado, extra = {};
      if (!nota) resultado = 'sem_xml';
      else if (nota.cnpjDest !== CNPJ_LOJA[s.loja]) resultado = 'outra_loja';
      else { resultado = 'confere'; const f = await fornecedorPorCnpj(nota.cnpjEmit); extra = { chave, nNota: nota.nNota, fornecedor: f ? f.nome : ('CNPJ ' + nota.cnpjEmit) }; danfeOk.set(s.loja + ':' + chave, nome || true); }
      logC({ tipo: 'danfe', loja: s.loja, nome, nfe: nota ? nota.nNota : '', chave, resultado, descricao: nota ? nota.nomeEmit : ('emitente CNPJ ' + cnpjEmit),
        msg: resultado === 'confere' ? 'DANFE confere com o XML' : resultado === 'outra_loja' ? 'NF-e de outra loja (destinatário ' + nota.cnpjDest + ') · NÃO DESCARREGAR' : 'XML não está no ERP · NÃO DESCARREGAR' });
      res.json({ resultado, ...extra });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/recebimento-publico/abrir', async (req, res) => {
    try {
      const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
      const { chave, nome } = req.body || {}; if (!chave) return res.status(400).json({ error: 'chave obrigatória' });
      // A chave tem que ser de uma nota emitida PRA ESTA LOJA (o token diz qual é). Fornecedor e
      // codFornec saem do axml/central.fornecedor, nunca do body — o celular não decide isso.
      const nota = await notaDaChave(String(chave));
      if (!nota) return res.status(404).json({ error: 'NF-e não encontrada no ERP.' });
      if (nota.cnpjDest !== CNPJ_LOJA[s.loja]) return res.status(403).json({ error: 'Esta NF-e não é da sua loja.' });
      // as outras notas da mesma conferência do Dlinks entram juntas, com os itens somados (17/11/26)
      const grupo = await grupoDaNota(s.loja, nota); const chaves = grupo.map(n => n.chave);
      let jaAberta = null; for (const k of chaves) { jaAberta = recebimento.acharPorChave(s.loja, k); if (jaAberta) break; }
      // a DANFE de QUALQUER uma das notas do grupo vale: é o mesmo caminhão
      let danfe; for (const k of chaves) { danfe = danfeOk.get(s.loja + ':' + k); if (danfe) break; }
      if (!jaAberta && !danfe) return res.status(409).json({ error: 'Bipe a DANFE do caminhão antes de abrir a nota.', danfe: true });
      const f = await fornecedorPorCnpj(nota.cnpjEmit);
      const p0 = grupo[0];
      let c = recebimento.abrirNota({ loja: s.loja, nome, chave: p0.chave, nNota: p0.nNota, fornecedor: f ? f.nome : ('CNPJ ' + nota.cnpjEmit), codFornec: f ? f.cod : 0, xmlItens: somarItensNotas(grupo),
        ...(grupo.length > 1 ? { chaves, notas: grupo.map(n => ({ chave: n.chave, nNota: n.nNota })) } : {}),
        danfe: jaAberta ? undefined : { nome: typeof danfe === 'string' ? danfe : String(nome || '').toUpperCase().slice(0, 20), em: new Date().toISOString() } });
      if (!c.erp.nReg) await espelhoErp(c, recebErp.passosAbrir(c, { dataHora: new Date() }), 'abrir');
      else await espelhoChaves(c);
      if (jaAberta) await comPrazo(atualizarNota(c));   // retomada: a entrada do ERP pode ter mudado desde a abertura
      c = recebimento.obter(c.id) || c;
      const nNotas = recebimento.chavesDe(c).length;
      logC({ tipo: 'abrir_nota', loja: s.loja, nome: c.nome, nfe: recebimento.nNotasDe(c).join(', '), chave: String(chave), nReg: c.erp.nReg, descricao: c.fornecedor + (nNotas > 1 ? ' · ' + nNotas + ' notas numa conferência' : '') });
      res.json(comDevolucoes(recebimento.visaoLoja(s.loja, c.id), recebimento.obter(c.id)));
    } catch (e) { res.status(st(e)).json({ error: e.message }); }
  });

  app.get('/api/recebimento-publico/conferencia/:id', (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const c = recebimento.obter(req.params.id);
      const v = recebimento.visaoLoja(s.loja, req.params.id);
      // o coletor chama isto a cada 5 s: a entrada do ERP é relida por trás (cache de 1 min) e a próxima chamada já traz
      if (v && c) atualizarNota(c).catch(e => console.error('[COLETOR] atualizar nota:', e.message));
      v ? res.json(comDevolucoes(v, c)) : res.status(404).json({ error: 'não encontrada' });
    } catch (e) { res.status(st(e)).json({ error: e.message }); }
  });

  app.get('/api/recebimento-publico/cadastro/:cod', async (req, res) => {
    try {
      if (!rcLoja(req)) return res.status(401).json({ error: 'Sessão inválida.' });
      const cod = String(req.params.cod).trim(); const k = await cadastroItem(cod);
      if (!k) return res.status(404).json({ error: 'Produto não cadastrado. Chame a central.' });
      const r = { descricao: k.descricao, qtdemb: k.qtdemb, emb: k.emb };
      // ?id= da conferência aberta: as un/cx da nota entram quando não há vínculo (o cartão já abre "× 12")
      let conf = null; try { conf = req.query.id ? recebimento.obter(String(req.query.id)) : null; } catch { conf = null; }
      if (conf && +conf.loja !== +rcLoja(req).loja) conf = null;
      if (conf) { await comPrazo(atualizarNota(conf)); conf = recebimento.obter(conf.id); }
      const embNotaDe = conf ? u => ((conf.xml_itens || []).find(i => i.cod === u) || {}).emb : null;
      // regra da caixa só dentro do CD (Tiago, 11/11/26): nas lojas o cadastro sai puro, em unidades, como sempre foi
      if (recebimento.regraCaixa(rcLoja(req).loja) && !(k.qtdemb > 1)) { const uErp = conf ? ((conf.xml_itens || []).find(i => i.erp && i.erp === cod && i.cod !== cod) || {}).cod || null : null; const cx = await caixaParaUnidade(cod, embNotaDe, uErp); if (cx) Object.assign(r, { qtdemb: cx.emb, unidade: cx.cod, emb: k.emb && k.emb !== 'UN' ? k.emb : (cx.emb_label && cx.emb_label !== 'UN' ? cx.emb_label : 'CX') }); }
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  for (const acao of ['bipar', 'corrigir']) app.post('/api/recebimento-publico/' + acao, async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      const c0 = recebimento.obter(req.body.id); if (!c0 || +c0.loja !== s.loja) return res.status(404).json({ error: 'Conferência não encontrada' });
      await comPrazo(atualizarNota(c0));
      const r = await recebimento[acao](req.body.id, req.body); const c = recebimento.obter(req.body.id);
      // r.repetido = a fila offline do coletor reenviou um bipeId já aplicado: nada foi somado de
      // novo, então não loga outro evento nem espelha o item no ERP uma segunda vez.
      if (!r.repetido) {
        logC({ tipo: acao === 'bipar' ? 'bipe' : 'corrigir', loja: s.loja, nome: c.nome, nfe: c.nNota, cod: req.body.cod, descricao: r.item?.descricao, quant: req.body.quant, emb: req.body.emb, un: r.item?.un, validade: req.body.validade, lote: req.body.lote || '', resultado: r.resultado });
        if (r.item && r.resultado !== 'nao_cadastrado') await espelhoItem(c, r.item);
      }
      res.json({ resultado: r.resultado, item: r.item, repetido: !!r.repetido, visao: recebimento.visaoLoja(s.loja, c.id) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento-publico/terminei', async (req, res) => {
    const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
    try {
      // o Terminei compara com a nota: relê a entrada do ERP antes (corrigida no ERP depois da abertura = recontagem à toa)
      { let c0 = null; try { c0 = recebimento.obter(req.body.id); } catch { c0 = null; } if (c0 && +c0.loja === s.loja) await comPrazo(atualizarNota(c0)); }
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
  // trava de loja por usuário (lib/escopo.js): conferência de loja fora do cadastro = 403
  const negaLoja = (req, res) => { let c = null; try { c = recebimento.obter(req.params.id); } catch { return false; } if (!c || escopo.podeLoja(req.session.user, c.loja)) return false; res.status(403).json({ error: 'Sem permissão pra esta loja' }); return true; };
  app.get('/api/recebimento', (req, res) => {
    try {
      const data = req.query.data ? recebimento.validarDia(req.query.data) : recebimento.hojeStr();
      res.json(escopo.filtrarPorLoja(req.session.user, recebimento.listarDia(data), c => c.loja).map(c => ({ ...semInternos(c), devolucoes: c.devolucoes || recebimento.devolucoes(c) })));
    } catch (e) { res.status(st(e)).json({ error: e.message }); }
  });

  const semTokens = c => ({ ...c, lojas: Object.fromEntries(Object.entries(c.lojas).map(([k, v]) => [k, { pin: v.pin }])) });
  app.get('/api/recebimento/config', (req, res) => { const c = semTokens(recebimento.config()); res.json({ ...c, lojas: escopo.filtrarLojasObj(req.session.user, c.lojas) }); });

  // Number.isFinite (e não `|| padrão`): 0 é valor válido em recontagens_min. `modo_cega` não é
  // editável por aqui — fica só como default do arquivo de config.
  app.post('/api/recebimento/config', (req, res) => {
    const b = req.body || {}; const campos = {};
    for (const k of ['validade_pct_min', 'recontagens_min', 'janela_dias_axml']) { const v = Number(b[k]); if (b[k] !== undefined && b[k] !== '' && Number.isFinite(v)) campos[k] = v; }
    if (b.fiscal_ativo !== undefined) campos.fiscal_ativo = b.fiscal_ativo === true || b.fiscal_ativo === 'true' || b.fiscal_ativo === 1;
    res.json(semTokens(recebimento.setConfig(campos)));
  });

  app.post('/api/recebimento/:id/liberar', async (req, res) => {
    if (negaLoja(req, res)) return;
    const nome = req.session.user?.nome || 'CENTRAL';
    try {
      // a devolução por falta sai da nota: relê a entrada do ERP antes de fechar a conta
      { let c0 = null; try { c0 = recebimento.obter(req.params.id); } catch { c0 = null; } if (c0) await comPrazo(atualizarNota(c0)); }
      const c = recebimento.liberar(req.params.id, { nome });
      logC({ tipo: 'liberar', loja: c.loja, nome, nfe: c.nNota, msg: c.devolucoes.map(d => d.origem + ' ' + d.cod + ' ' + d.qtd).join('; ') });
      const r = c.erp.nReg ? await espelhoErp(c, recebErp.passosLiberar(c, c.erp.nReg, { nome, dataHora: new Date() }), 'liberar') : (pendencia(c, { tipo: 'liberar', erro: 'conferência ainda sem nReg no ERP' }), null);
      res.json({ ok: true, conferencia: semInternos(recebimento.obter(req.params.id)), erp: r ? { logId: r.id } : { erro: c.erp.erros.at(-1)?.erro || 'sem nReg no ERP' } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento/:id/reconferir', async (req, res) => {
    if (negaLoja(req, res)) return;
    const nome = req.session.user?.nome || 'CENTRAL';
    try {
      const c = recebimento.reconferir(req.params.id, { nome });
      logC({ tipo: 'reconferir', loja: c.loja, nome, nfe: c.nNota });
      await espelhoStatus(c, 5, nome);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/recebimento/:id/chat', (req, res) => {
    if (negaLoja(req, res)) return;
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
    if (negaLoja(req, res)) return;
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
        { id: c.id, itens, nota: { nNota: recebimento.nNotasDe(c).join(', '), chave: c.chave, fornecedor: c.fornecedor }, loja: c.loja, motorista: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
    res.sendFile(f, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="devolucao-${String(c.id).replace(/[^\w.-]/g, '_')}.pdf"` } });
  });

  // Reenvio: replay NA ORDEM (abrir → itens → status → liberar), sempre reconstruindo os passos do
  // ESTADO ATUAL da conferência. Não usa o array de passos guardado na pendência: entre a falha e o
  // reenvio a loja continuou bipando, e o que precisa chegar no ERP é a contagem de agora.
  app.post('/api/recebimento/:id/reenviar-erp', async (req, res) => {
    if (negaLoja(req, res)) return;
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

    if (await espelhoChaves(c)) ok++;
    c = recebimento.obter(req.params.id);
    const codsPend = new Set(pend.filter(p => p.tipo === 'item' && p.cod).map(p => p.cod));
    for (const it of Object.values(c.itens || {})) {
      if (it.espelhado && !codsPend.has(it.cod)) continue;
      const p = recebErp.passosItem(c, it, c.erp.nReg);
      const r = await espelhoErp(c, { motivo: p.motivo, passos: p.passos }, 'item', { cod: it.cod, codErp: p.codErp });
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
  return { cadastroItem, xmlPorChave, invalidarIndiceXml, notaDaChave, espelhoErp, rcLoja, logC, danfeLimpar: () => danfeOk.limpar(), entradaLimpar: () => entradaCache.limpar() };
};
