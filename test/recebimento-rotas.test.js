const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const montarRotasRecebimento = require('../lib/recebimento-rotas');
const recebimento = require('../lib/recebimento');

// Fake Express app: só guarda handler final por "MÉTODO caminho" (sem roteamento de :params de verdade —
// os testes chamam a chave exata e passam req.params manualmente).
function fakeApp() {
  const routes = {};
  const registrar = (metodo, caminho, ...handlers) => { routes[metodo + ' ' + caminho] = handlers[handlers.length - 1]; };
  return { app: { get: (p, ...h) => registrar('GET', p, ...h), post: (p, ...h) => registrar('POST', p, ...h) }, routes };
}
function req({ query = {}, body = {}, params = {}, headers = {}, session = {} } = {}) { return { query, body, params, headers, session }; }
function res() { const r = { statusCode: 200 }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; r.sendFile = (f, o) => { r.arquivo = f; r.opcoes = o; return r; }; return r; }

// Monta um ambiente novo (tmp dir isolado) com mocks de dependências externas (ERP de teste, ERP .252
// via q, log coletor). Devolve routes + espiões pra inspecionar chamadas nos testes.
// `notas`/`notaItens` alimentam as consultas que /abrir passou a fazer: a chave tem que existir em
// central.axml E ser da loja do token (CNPJdest), e os itens da nota vêm de central.axmlprodutos.
// Sem itens em axmlprodutos a conferência cai no pedido do app (xmlLoja), como antes.
function montarAmbiente({ q, loteImpl, cnpj = '11222333000199', notas = {}, notaItens = [], fornecedorNome = 'FORNECEDOR TESTE', cnpjDest } = {}) {
  const { app, routes } = fakeApp();
  const dirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-rotas-'));
  const loteChamadas = [];
  const logs = [];
  const pdfs = [];
  const escreverERP = { lote: async (args) => { loteChamadas.push(args); return loteImpl ? loteImpl(args) : { ok: true, id: 'LOG1', ids: ['NREG1'] }; } };
  const pedidosFornec = { listar: () => [], gerarPdfDevolucao: (p, ln, usuario, extras) => { pdfs.push({ p, ln, usuario, extras }); return path.join(dirBase, 'fake-devolucao.pdf'); } };
  const conferenciaXml = { LOJA_CNPJ: { 3: cnpj } };
  const logColetor = { registrar: (dir, ev) => logs.push(ev) };
  // qEstatico é SÍNCRONO de propósito: um `q` de teste que estoura de forma síncrona tem que
  // continuar estourando de forma síncrona (é justamente o que um dos testes verifica).
  const qEstatico = (sql, params) => {
    if (sql.includes('FROM central.axml WHERE Chave=?')) return [{ Chave: params[0], nNota: notas[params[0]] || '1', CNPJemit: '11222333000199', CNPJdest: cnpjDest === undefined ? cnpj : cnpjDest, NomeEmit: fornecedorNome }];
    if (sql.includes('FROM central.axmlprodutos')) return notaItens;
    if (sql.includes('FROM central.fornecedor WHERE LEFT(CNPJ,8)=?')) return [{ cod: 77, nome: fornecedorNome }];
    return null;
  };
  const qFn = (sql, params) => { const r = qEstatico(sql, params); return r === null ? (q ? q(sql, params) : Promise.resolve([])) : Promise.resolve(r); };
  const api = montarRotasRecebimento(app, { q: qFn, path, escreverERP, pedidosFornec, conferenciaXml, logColetor, LOG_COLETOR_DIR: dirBase, __dirname: dirBase });
  return { routes, loteChamadas, logs, pdfs, ...api };
}

test('/entrar com PIN errado devolve 401', async () => {
  const { routes } = montarAmbiente();
  const r = res();
  await routes['POST /api/recebimento-publico/entrar'](req({ body: { loja: 3, pin: '0000', nome: 'teste' } }), r);
  assert.equal(r.statusCode, 401);
  assert.match(r.body.error, /PIN/);
});

test('/entrar com PIN certo devolve token da loja', async () => {
  const { routes } = montarAmbiente();
  const cfg = recebimento.config();
  const r = res();
  await routes['POST /api/recebimento-publico/entrar'](req({ body: { loja: 3, pin: cfg.lojas[3].pin, nome: 'mayra' } }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.loja, 3);
  assert.equal(r.body.nome, 'MAYRA');
  assert.match(r.body.token, /^[a-f0-9]{32}$/);
});

test('/notas mapeia veredito (liberada|divergente|sem_pedido) e nunca devolve quantidade/valor dos itens da nota', async () => {
  const chave = 'X'.repeat(44);
  const q = async (sql, params) => {
    if (sql.includes('FROM central.axml')) return [{ chave, nNota: '4501', CNPJemit: '11222333000199', Data: '2026-09-20' }];
    if (sql.includes('FROM central.fornecedor')) return [{ raiz: '11222333', cod: 77, nome: 'FORNECEDOR TESTE' }];
    return [];
  };
  const { routes } = montarAmbiente({ q });
  const cfg = recebimento.config();
  const t = cfg.lojas[3].token;
  const r = res();
  await routes['GET /api/recebimento-publico/notas'](req({ query: { t } }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.length, 1);
  const n = r.body[0];
  assert.equal(n.chave, chave);
  assert.equal(n.fornecedor, 'FORNECEDOR TESTE');
  // sem pedido casado (pedidosFornec.listar() mockado vazio) => sem_pedido
  assert.equal(n.veredito, 'sem_pedido');
  // conferência cega: a rota pública de notas nunca revela quantidade/valor da nota em si
  assert.ok(!('itens' in n)); assert.ok(!('valor' in n)); assert.ok(!('un' in n));
});

test('/bipar loga evento "bipe" e só chama o espelho no ERP quando a conferência já tem nReg', async () => {
  const cad = { '789': { cod: '789', descricao: 'PRODUTO TESTE', qtdemb: 1, emb: 'UN', validar: 0 } };
  const xmlLoja = () => ({ itens: [{ cod: '789', descricao: 'PRODUTO TESTE', un: 3 }], naoPedidos: [], status: 'consistencia' });
  const q = async (sql, params) => (sql.includes('FROM central.itens') ? [{ cod: params[0], descricao: cad[params[0]]?.descricao, qtdemb: 1, UnidadeCompra: 'UN', Validar: 0 }] : []);

  // cenário A: abrir com sucesso no ERP -> nReg fica setado -> bipar deve chamar escreverERP.lote de novo
  { const { routes, loteChamadas, logs } = montarAmbiente({ q });
    recebimento.init({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rec-rotas-')), cadastro: async c => cad[c] || null, xmlLoja });
    const cfg = recebimento.config(); const t = cfg.lojas[3].token;
    const rAbrir = res();
    await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'C'.repeat(44), nNota: '1', fornecedor: 'F', codFornec: 1, nome: 'ana' } }), rAbrir);
    assert.equal(loteChamadas.length, 1, 'abrir deve ter espelhado no ERP');
    const rBip = res();
    await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id: rAbrir.body.id, cod: '789', quant: 3, emb: 1 } }), rBip);
    assert.equal(rBip.body.resultado, 'ok');
    assert.equal(loteChamadas.length, 2, 'bipar com nReg setado deve espelhar o item no ERP');
    assert.ok(logs.some(e => e.tipo === 'bipe' && e.cod === '789'), 'deve logar evento "bipe"');
  }

  // cenário B: abrir falha no ERP (.254 fora do ar) -> sem nReg -> bipar NÃO deve chamar o ERP de novo
  { const { routes, loteChamadas, logs } = montarAmbiente({ q, loteImpl: () => ({ ok: false, status: 500, erro: 'fora do ar' }) });
    recebimento.init({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rec-rotas-')), cadastro: async c => cad[c] || null, xmlLoja });
    const cfg = recebimento.config(); const t = cfg.lojas[3].token;
    const rAbrir = res();
    await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'D'.repeat(44), nNota: '2', fornecedor: 'F', codFornec: 1, nome: 'ana' } }), rAbrir);
    assert.equal(loteChamadas.length, 1, 'abrir tentou e falhou');
    const rBip = res();
    await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id: rAbrir.body.id, cod: '789', quant: 3, emb: 1 } }), rBip);
    assert.equal(rBip.body.resultado, 'ok');
    assert.equal(loteChamadas.length, 1, 'sem nReg, bipar não deve chamar o ERP de novo');
    assert.ok(logs.some(e => e.tipo === 'bipe'), 'ainda assim loga o bipe');
  }
});

test('/terminei manda status 3 (Status=3) pro ERP quando a conferência bate e termina', async () => {
  const cad = { '789': { cod: '789', descricao: 'PRODUTO TESTE', qtdemb: 1, emb: 'UN', validar: 0 } };
  const xmlLoja = () => ({ itens: [{ cod: '789', descricao: 'PRODUTO TESTE', un: 3 }], naoPedidos: [], status: 'consistencia' });
  const q = async () => [];
  const { routes, loteChamadas } = montarAmbiente({ q });
  recebimento.init({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rec-rotas-')), cadastro: async c => cad[c] || null, xmlLoja });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;

  const rAbrir = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'E'.repeat(44), nNota: '3', fornecedor: 'F', codFornec: 1, nome: 'ana' } }), rAbrir);
  await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id: rAbrir.body.id, cod: '789', quant: 3, emb: 1 } }), res());

  const antes = loteChamadas.length;
  const rTerm = res();
  await routes['POST /api/recebimento-publico/terminei'](req({ query: { t }, body: { id: rAbrir.body.id } }), rTerm);
  assert.equal(rTerm.body.bateu, true);
  assert.equal(rTerm.body.status, 'terminada');
  assert.equal(loteChamadas.length, antes + 1, 'terminar bateu deve mandar 1 passo novo pro ERP');
  const passos = loteChamadas.at(-1).passos;
  assert.equal(passos.length, 1);
  assert.equal(passos[0].tabela, 'conferencia');
  assert.equal(passos[0].valores.Status, 3);
});

test('/abrir e /cadastro/:cod devolvem erro 500 em JSON em vez de deixar a promise sem catch', async () => {
  // /abrir: força um erro síncrono dentro do handler (depois de todos os awaits) simulando uma falha
  // inesperada em recebimento.visaoLoja — sem try/catch, isso vira um throw dentro de um handler async
  // (unhandled rejection); com o fix, cai no catch e devolve JSON.
  { const { routes } = montarAmbiente();
    const cfg = recebimento.config(); const t = cfg.lojas[3].token;
    const original = recebimento.visaoLoja;
    recebimento.visaoLoja = () => { throw new Error('falha simulada em visaoLoja'); };
    try {
      const r = res();
      await assert.doesNotReject(routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'F'.repeat(44), nNota: '9', fornecedor: 'F', codFornec: 1, nome: 'ana' } }), r));
      assert.equal(r.statusCode, 500);
      assert.match(r.body.error, /falha simulada/);
    } finally { recebimento.visaoLoja = original; }
  }

  // /cadastro/:cod: força `q` a explodir de forma síncrona (não uma promise rejeitada) — o `.catch()`
  // encadeado em cadastroItem nem chega a existir nesse caso, então sem try/catch na rota isso também
  // seria uma promise rejeitada sem tratamento.
  { const qQueExplode = () => { throw new Error('banco fora do ar'); };
    const { routes } = montarAmbiente({ q: qQueExplode });
    const cfg = recebimento.config(); const t = cfg.lojas[3].token;
    const r = res();
    await assert.doesNotReject(routes['GET /api/recebimento-publico/cadastro/:cod'](req({ query: { t }, params: { cod: '789' } }), r));
    assert.equal(r.statusCode, 500);
    assert.match(r.body.error, /banco fora do ar/);
  }
});

test('devolucoes só aparece na visão pública depois de Terminei (terminada/liberada), nunca antes', async () => {
  // validade curta o bastante pra bloquear (validar:30 dias, chega faltando só 5) — a quantidade bipada
  // bate 100% com o pedido (5un), então termina (bateu=true) mesmo com o item bloqueado por validade,
  // que é exatamente o que gera 1 linha de devolução (origem 'coletor').
  const daqui5dias = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const cad = { '789': { cod: '789', descricao: 'PRODUTO TESTE', qtdemb: 1, emb: 'UN', validar: 30 } };
  const xmlLoja = () => ({ itens: [{ cod: '789', descricao: 'PRODUTO TESTE', un: 5 }], naoPedidos: [], status: 'consistencia' });
  const q = async () => [];
  const { routes } = montarAmbiente({ q });
  recebimento.init({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rec-rotas-')), cadastro: async c => cad[c] || null, xmlLoja });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;

  const rAbrir = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'G'.repeat(44), nNota: '4', fornecedor: 'F', codFornec: 1, nome: 'ana' } }), rAbrir);
  const id = rAbrir.body.id;
  assert.ok(!('devolucoes' in rAbrir.body), 'antes de bipar, sem devolucoes na visão');

  const rBip = res();
  await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '789', quant: 5, emb: 1, validade: daqui5dias } }), rBip);
  assert.equal(rBip.body.resultado, 'bloqueado_validade');

  const rAntes = res();
  await routes['GET /api/recebimento-publico/conferencia/:id'](req({ query: { t }, params: { id } }), rAntes);
  assert.ok(!('devolucoes' in rAntes.body), 'ainda bipando (não terminou) — sem devolucoes na visão pública');

  const rTerm = res();
  await routes['POST /api/recebimento-publico/terminei'](req({ query: { t }, body: { id } }), rTerm);
  assert.equal(rTerm.body.bateu, true);
  assert.equal(rTerm.body.status, 'terminada');
  assert.ok(Array.isArray(rTerm.body.devolucoes), 'resposta de /terminei traz devolucoes quando termina');
  assert.ok(rTerm.body.devolucoes.some(d => d.cod === '789' && d.origem === 'coletor'), 'devolução por validade curta (bloqueado_validade)');
  for (const d of rTerm.body.devolucoes) assert.ok('cod' in d && 'descricao' in d && 'qtd' in d && 'origem' in d && 'motivo' in d);

  const rDepois = res();
  await routes['GET /api/recebimento-publico/conferencia/:id'](req({ query: { t }, params: { id } }), rDepois);
  assert.ok(Array.isArray(rDepois.body.devolucoes), 'depois de terminar, a visão pública já traz devolucoes');
});

test('PDF de devolução: 404 sem conferência, 409 antes de Terminei, 200 com as 3 origens depois', async () => {
  const daqui5dias = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const cad = { '789': { cod: '789', descricao: 'PRODUTO TESTE', qtdemb: 1, emb: 'UN', validar: 30 }, '456': { cod: '456', descricao: 'OUTRO PRODUTO', qtdemb: 1, emb: 'UN', validar: 0 } };
  // nota com 2 itens: '789' (bipado com validade curta -> devolução 'coletor') e '456' (não veio -> 'falta')
  const xmlLoja = () => ({ itens: [{ cod: '789', descricao: 'PRODUTO TESTE', un: 5 }, { cod: '456', descricao: 'OUTRO PRODUTO', un: 2 }], naoPedidos: [], status: 'consistencia' });
  const { routes, pdfs } = montarAmbiente({ q: async () => [], notas: { ['H'.repeat(44)]: '77' }, fornecedorNome: 'FORN' });
  recebimento.init({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rec-rotas-')), cadastro: async c => cad[c] || null, xmlLoja });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const rota = routes['GET /api/recebimento/:id/devolucao/pdf'];
  assert.ok(rota, 'rota do PDF registrada');

  const rNao = res();
  await rota(req({ params: { id: '2000-01-01-3-999' } }), rNao);
  assert.equal(rNao.statusCode, 404);

  const rAbrir = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'H'.repeat(44), nNota: '77', fornecedor: 'FORN', codFornec: 1, nome: 'ana' } }), rAbrir);
  const id = rAbrir.body.id;
  await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '789', quant: 5, emb: 1, validade: daqui5dias } }), res());

  const rAntes = res();
  await rota(req({ params: { id } }), rAntes);
  assert.ok([403, 409].includes(rAntes.statusCode), 'sem Terminei não gera o PDF (403/409)');
  assert.equal(pdfs.length, 0);

  // a loja termina assim mesmo (item '456' não veio -> falta)
  await routes['POST /api/recebimento-publico/terminei'](req({ query: { t }, body: { id } }), res());
  await routes['POST /api/recebimento-publico/enviar'](req({ query: { t }, body: { id } }), res());

  const rOk = res();
  await rota(req({ params: { id }, session: { user: { nome: 'FISCAL' } } }), rOk);
  assert.equal(rOk.statusCode, 200);
  assert.ok(rOk.arquivo, 'streamou o arquivo do PDF');
  assert.match(rOk.opcoes.headers['Content-Type'], /pdf/);
  assert.equal(pdfs.length, 1, 'chamou gerarPdfDevolucao uma vez');
  const ex = pdfs[0].extras;
  assert.ok(ex && Array.isArray(ex.itens), 'passou extras com a lista de devolução (e não recusasLoja)');
  assert.equal(pdfs[0].p, null);
  assert.equal(ex.loja, 3); assert.equal(ex.motorista, true); assert.equal(ex.id, id);
  assert.equal(ex.nota.nNota, '77'); assert.equal(ex.nota.fornecedor, 'FORN');
  assert.ok(ex.itens.some(d => d.cod === '789' && d.origem === 'coletor'), 'validade curta -> origem coletor');
  assert.ok(ex.itens.some(d => d.cod === '456' && d.origem === 'falta'), 'item da nota não bipado -> origem falta');
});

test('gerarPdfDevolucaoColetor escreve o arquivo de verdade e resolve no fim do stream', async () => {
  const pedidosFornec = require('../lib/pedidos-fornecedor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-pdf-'));
  const itens = [
    { cod: '789', descricao: 'ARROZ TIPO 1 PACOTE 5KG MARCA COM NOME BEM COMPRIDO', qtd: 5, origem: 'coletor', motivo: 'validade curta (2026-09-30)' },
    { cod: '456', descricao: 'FEIJAO CARIOCA 1KG', qtd: 2, origem: 'falta', motivo: 'na nota, não veio' },
    { cod: '123', descricao: 'ACUCAR 1KG', qtd: 1, origem: 'compras', motivo: 'recusado pelo(a) comprador(a)' }
  ];
  const ret = pedidosFornec.gerarPdfDevolucao(null, 3, 'FISCAL', { id: '2026-09-25-3-4501/../x', dir, itens, loja: 3, motorista: true, nota: { nNota: '4501', chave: 'H'.repeat(44), fornecedor: 'FORN' } });
  assert.ok(ret && typeof ret.then === 'function', 'com extras o retorno é uma Promise');
  const arquivo = await ret;
  assert.equal(path.dirname(arquivo), dir, 'não escapa do diretório (nome sanitizado)');
  assert.match(path.basename(arquivo), /^[\w.-]+-devolucao\.pdf$/);
  const st = fs.statSync(arquivo);
  assert.ok(st.size > 1000, 'PDF com conteúdo (' + st.size + ' bytes)');
  assert.equal(fs.readFileSync(arquivo).slice(0, 4).toString(), '%PDF');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────────
// Revisão final (25/09/26): nota sem pedido do app, espelho resiliente, id e cega.
// ───────────────────────────────────────────────────────────────────────────────
const recebErp = require('../lib/recebimento-erp');
const CHAVE_A = 'A'.repeat(44);

test('C3 — nota SEM pedido do app é conferível: os itens vêm de central.axmlprodutos', async () => {
  const cad = { '789': { cod: '789', descricao: 'PRODUTO TESTE', qtdemb: 1, emb: 'UN', validar: 0 } };
  const q = async (sql, params) => (sql.includes('FROM central.itens') ? [{ cod: params[0], descricao: cad[params[0]]?.descricao, qtdemb: 1, UnidadeCompra: 'UN', Validar: 0 }] : []);
  const notaItens = [
    { nItem: 1, CodigoBarras: '789', ocEanTrib: '', Descricao: 'PRODUTO TESTE', Und: 'CX', Qtd: '1', oqTrib: '3' },
    { nItem: 2, CodigoBarras: '0', ocEanTrib: '456', Descricao: 'SO EAN TRIB', Und: 'UN', Qtd: '2', oqTrib: '0' },
  ];
  const { routes } = montarAmbiente({ q, notaItens, notas: { [CHAVE_A]: '5001' } });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;

  const rAbrir = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CHAVE_A, nome: 'ana' } }), rAbrir);
  assert.equal(rAbrir.statusCode, 200);
  const id = rAbrir.body.id;
  // nNota e fornecedor saem do ERP, não do body
  assert.equal(rAbrir.body.nNota, '5001');
  assert.equal(rAbrir.body.fornecedor, 'FORNECEDOR TESTE');
  // conferência cega: a visão da loja não devolve os itens da nota
  assert.ok(!('xml_itens' in rAbrir.body) && !('xml' in rAbrir.body));
  assert.equal(rAbrir.body.itens.length, 0);

  // item da nota bipado certo = ok (antes caía em nao_esta_na_nota, porque só havia pedido do app)
  const rBip = res();
  await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '789', quant: 3, emb: 1 } }), rBip);
  assert.equal(rBip.body.resultado, 'ok');

  // o 2º item da nota (só com ocEanTrib, oqTrib 0 → cai no Qtd comercial) ainda falta: não bate
  const rT1 = res();
  await routes['POST /api/recebimento-publico/terminei'](req({ query: { t }, body: { id } }), rT1);
  assert.equal(rT1.body.bateu, false);
  assert.deepEqual(rT1.body.recontar.map(r => r.cod), ['456']);
  assert.ok(!JSON.stringify(rT1.body).includes('"un"'), 'a recontagem não revela quantidade');

  // GET /api/recebimento (Fiscal) nunca devolve xml_itens nem os controles de idempotência
  const rInt = res();
  await routes['GET /api/recebimento'](req({ query: {} }), rInt);
  const c = rInt.body.find(x => x.id === id);
  assert.ok(c, 'a conferência aparece pro Fiscal');
  assert.equal(c.xml_itens, undefined); assert.equal(c.xml, undefined);
  assert.equal(c.bipes_vistos, undefined); assert.equal(c.msgs_vistos, undefined);
  // (a lista de recontagem guarda a descrição do item da nota de propósito — é o que a loja precisa
  // procurar; o que nunca pode sair é a QUANTIDADE da nota, e ela só existe em c.xml_itens.)
});

test('/abrir recusa chave que não é da loja do token (403) e sem chave (400)', async () => {
  const { routes } = montarAmbiente({ cnpjDest: '99999999000199' });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const r = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'B'.repeat(44), nome: 'ana' } }), r);
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /sua loja/);
  const rs = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { nome: 'ana' } }), rs);
  assert.equal(rs.statusCode, 400);
});

test('C2/I1/I3 — abrir que falha no ERP enfileira tudo e /reenviar-erp replica abrir → item → status', async () => {
  const cad = { '789': { cod: '789', descricao: 'PRODUTO TESTE', qtdemb: 1, emb: 'UN', validar: 0 } };
  const q = async (sql, params) => (sql.includes('FROM central.itens') ? [{ cod: params[0], descricao: cad[params[0]]?.descricao, qtdemb: 1, UnidadeCompra: 'UN', Validar: 0 }] : []);
  const notaItens = [{ nItem: 1, CodigoBarras: '789', ocEanTrib: '', Descricao: 'PRODUTO TESTE', Und: 'UN', Qtd: '3', oqTrib: '3' }];
  let fora = true;
  const { routes, loteChamadas } = montarAmbiente({ q, notaItens, notas: { [CHAVE_A]: '5002' }, loteImpl: () => (fora ? { ok: false, status: 500, erro: 'fora do ar' } : { ok: true, id: 'LOG9', ids: ['NREG9'] }) });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;

  const rAbrir = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CHAVE_A, nome: 'ana' } }), rAbrir);
  const id = rAbrir.body.id;
  assert.equal(recebimento.obter(id).erp.nReg, null);

  await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '789', quant: 3, emb: 1 } }), res());
  await routes['POST /api/recebimento-publico/terminei'](req({ query: { t }, body: { id } }), res());

  let c = recebimento.obter(id);
  assert.equal(c.status, 'terminada');
  const tipos = c.erp.erros.map(e => e.tipo).sort();
  assert.deepEqual(tipos, ['abrir', 'item', 'status'], 'bipe e terminei viraram pendência, não sumiram em silêncio');
  assert.equal(c.erp.erros.find(e => e.tipo === 'item').cod, '789');
  assert.ok(!c.erp.erros.some(e => e.passos), 'a pendência não congela os passos: é reconstruída do estado atual');

  fora = false; loteChamadas.length = 0;
  const rRe = res();
  await routes['POST /api/recebimento/:id/reenviar-erp'](req({ params: { id } }), rRe);
  assert.equal(rRe.body.erros, 0, 'fila zerada');
  assert.equal(loteChamadas.length, 3, 'abrir + item + status, nessa ordem');
  assert.equal(loteChamadas[0].passos[0].tabela, 'conferencia');
  assert.equal(loteChamadas[0].passos[0].operacao, 'insert');
  assert.equal(loteChamadas[1].passos[0].tabela, 'conferenciaitens');
  assert.equal(loteChamadas[1].passos[0].operacao, 'insert', 'item que nunca chegou no ERP entra como INSERT');
  assert.equal(loteChamadas[1].passos[0].valores.chave, 'NREG9');
  assert.equal(loteChamadas[2].passos[0].valores.Status, 3);

  c = recebimento.obter(id);
  assert.equal(c.erp.nReg, 'NREG9');
  assert.equal(c.itens['789'].espelhado, true);
  assert.equal(c.erp.erros.length, 0);

  // I1: a partir daqui o mesmo item vira UPDATE, e corrigir (que zera bipagens) não volta a INSERT
  loteChamadas.length = 0;
  await routes['POST /api/recebimento/:id/reconferir'](req({ params: { id }, session: {} }), res());
  await routes['POST /api/recebimento-publico/corrigir'](req({ query: { t }, body: { id, cod: '789', quant: 2, emb: 1 } }), res());
  const doItem = loteChamadas.filter(l => l.passos[0].tabela === 'conferenciaitens');
  assert.equal(doItem.length, 1);
  assert.equal(doItem[0].passos[0].operacao, 'update');
  assert.equal(recebimento.obter(id).itens['789'].bipagens, 1, 'corrigir zerou e recontou');
});

test('I3 — espelho no ERP não regrava a conferência velha por cima do que foi bipado durante o await', async () => {
  const notaItens = [{ nItem: 1, CodigoBarras: '789', ocEanTrib: '', Descricao: 'PRODUTO TESTE', Und: 'UN', Qtd: '3', oqTrib: '3' }];
  let idAtual = null;
  const amb = montarAmbiente({
    notaItens, notas: { [CHAVE_A]: '5003' },
    loteImpl: () => {
      // enquanto o ERP "responde", a loja bipa outro item: o JSON no disco muda debaixo do espelho
      if (idAtual) { const c = recebimento.obter(idAtual); c.itens['999'] = { cod: '999', descricao: 'BIPADO NO MEIO', quant: 1, emb: 1, un: 1, estado: 'ok', bipagens: 1 }; recebimento.salvar(c); }
      return { ok: true, id: 'LOG3', ids: ['NREG3'] };
    },
  });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const rAbrir = res();
  await amb.routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CHAVE_A, nome: 'ana' } }), rAbrir);
  idAtual = rAbrir.body.id;

  const c0 = recebimento.obter(idAtual);
  await amb.espelhoErp(c0, recebErp.passosStatus(c0, 'NREG3', 3, { nome: 'ANA', dataHora: new Date() }), 'status', { status: 3 });
  const f = recebimento.obter(idAtual);
  assert.ok(f.itens['999'], 'o item bipado durante o await sobreviveu ao salvar do espelho');
  assert.equal(f.erp.ultimoLogId, 'LOG3');
});

test('I5 — id de conferência com path traversal é recusado (400), não vira leitura de arquivo', async () => {
  const { routes } = montarAmbiente();
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  for (const id of ['../../../etc/passwd', '2026-09-25-3-../x', '..\\..\\x', 'nada']) {
    const r = res();
    await routes['GET /api/recebimento-publico/conferencia/:id'](req({ query: { t }, params: { id } }), r);
    assert.equal(r.statusCode, 400, 'id recusado: ' + id);
    const rp = res();
    await routes['GET /api/recebimento/:id/devolucao/pdf'](req({ params: { id } }), rp);
    assert.equal(rp.statusCode, 400, 'PDF também recusa: ' + id);
  }
  const rd = res();
  await routes['GET /api/recebimento'](req({ query: { data: '../../x' } }), rd);
  assert.equal(rd.statusCode, 400);
});

test('I4 — id é dia-loja-hash da chave: mesma NF de fornecedores diferentes não colide', async () => {
  const { routes } = montarAmbiente({ notas: { ['A'.repeat(44)]: '1000', ['B'.repeat(44)]: '1000' } });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const r1 = res(), r2 = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'A'.repeat(44), nome: 'ana' } }), r1);
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'B'.repeat(44), nome: 'ana' } }), r2);
  assert.equal(r1.body.nNota, '1000'); assert.equal(r2.body.nNota, '1000');
  assert.notEqual(r1.body.id, r2.body.id, 'mesma NF, chaves diferentes → conferências diferentes');
  assert.match(r1.body.id, /^\d{4}-\d{2}-\d{2}-3-[0-9a-f]{10}$/);
  // reabrir a mesma chave devolve a MESMA conferência (nada de 2º INSERT no ERP)
  const r3 = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: 'A'.repeat(44), nome: 'ana' } }), r3);
  assert.equal(r3.body.id, r1.body.id);
});

test('I7 — piso validade_min_dias do Fiscal bloqueia o item mesmo sem cadastro de Validar', async () => {
  const daqui2dias = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const daqui90dias = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  const cad = { '789': { cod: '789', descricao: 'SEM VALIDAR', qtdemb: 1, emb: 'UN', validar: 0 } };
  const q = async (sql, params) => (sql.includes('FROM central.itens') ? [{ cod: params[0], descricao: 'SEM VALIDAR', qtdemb: 1, UnidadeCompra: 'UN', Validar: 0 }] : []);
  const notaItens = [{ nItem: 1, CodigoBarras: '789', ocEanTrib: '', Descricao: 'SEM VALIDAR', Und: 'UN', Qtd: '3', oqTrib: '3' }];
  const { routes } = montarAmbiente({ q, notaItens, notas: { [CHAVE_A]: '5004' } });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const rAbrir = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CHAVE_A, nome: 'ana' } }), rAbrir);
  const id = rAbrir.body.id;
  const rBip = res();
  await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '789', quant: 3, emb: 1, validade: daqui2dias } }), rBip);
  assert.equal(rBip.body.resultado, 'bloqueado_validade', 'Validar=0, mas 2 dias é menos que o piso do Fiscal');
  assert.equal(rBip.body.item.origem_devolucao, 'coletor');
  const rOk = res();
  await routes['POST /api/recebimento-publico/corrigir'](req({ query: { t }, body: { id, cod: '789', quant: 3, emb: 1, validade: daqui90dias } }), rOk);
  assert.equal(rOk.body.resultado, 'ok');
});

test('I8 — linha de devolução por FALTA vai pra loja sem quantidade (o Fiscal continua vendo)', async () => {
  const cad = { '789': { cod: '789', descricao: 'VEIO', qtdemb: 1, emb: 'UN', validar: 0 } };
  const q = async (sql, params) => (sql.includes('FROM central.itens') ? [{ cod: params[0], descricao: 'VEIO', qtdemb: 1, UnidadeCompra: 'UN', Validar: 0 }] : []);
  const notaItens = [
    { nItem: 1, CodigoBarras: '789', ocEanTrib: '', Descricao: 'VEIO', Und: 'UN', Qtd: '3', oqTrib: '3' },
    { nItem: 2, CodigoBarras: '456', ocEanTrib: '', Descricao: 'NAO VEIO', Und: 'UN', Qtd: '12', oqTrib: '12' },
  ];
  const { routes } = montarAmbiente({ q, notaItens, notas: { [CHAVE_A]: '5005' } });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const rAbrir = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CHAVE_A, nome: 'ana' } }), rAbrir);
  const id = rAbrir.body.id;
  await routes['POST /api/recebimento-publico/bipar'](req({ query: { t }, body: { id, cod: '789', quant: 3, emb: 1 } }), res());
  await routes['POST /api/recebimento-publico/terminei'](req({ query: { t }, body: { id } }), res());
  const rEnv = res();
  await routes['POST /api/recebimento-publico/enviar'](req({ query: { t }, body: { id } }), rEnv);

  const falta = rEnv.body.devolucoes.find(d => d.origem === 'falta');
  assert.ok(falta, 'a linha de falta aparece pro motorista');
  assert.equal(falta.cod, '456');
  assert.ok(!('qtd' in falta), 'sem quantidade: a loja não pode saber o que a nota diz');
  assert.ok(!JSON.stringify(rEnv.body).includes('12'), 'a quantidade da nota não vaza em lugar nenhum');

  // o Fiscal (rota interna) continua com a quantidade
  const rInt = res();
  await routes['GET /api/recebimento'](req({ query: {} }), rInt);
  const c = rInt.body.find(x => x.id === id);
  assert.equal(c.devolucoes.find(d => d.origem === 'falta').qtd, 12);

  // e /enviar não passa duas vezes por cima de uma nota já liberada
  await routes['POST /api/recebimento/:id/liberar'](req({ params: { id }, session: { user: { nome: 'FISCAL' } } }), res());
  const rDepois = res();
  await routes['POST /api/recebimento-publico/enviar'](req({ query: { t }, body: { id } }), rDepois);
  assert.equal(rDepois.statusCode, 400);
  assert.match(rDepois.body.error, /liberada/);
});

test('I6 — POST /config aceita 0, ignora vazio, não mexe em modo_cega e nunca devolve o token da loja', async () => {
  const { routes } = montarAmbiente();
  const rGet = res();
  await routes['GET /api/recebimento/config'](req({}), rGet);
  assert.ok(rGet.body.lojas[3].pin); assert.equal(rGet.body.lojas[3].token, undefined);

  const r = res();
  await routes['POST /api/recebimento/config'](req({ body: { recontagens_min: 0, validade_pct_min: 80, janela_dias_axml: '', modo_cega: 'nenhum' } }), r);
  assert.equal(r.body.recontagens_min, 0, '0 é valor válido (não cai no padrão)');
  assert.equal(r.body.validade_pct_min, 80);
  assert.equal(r.body.janela_dias_axml, 7, 'campo vazio não sobrescreve');
  assert.equal(r.body.modo_cega, 'total', 'modo_cega não é editável pela rota');
  assert.equal(r.body.lojas[3].token, undefined, 'a resposta do POST também esconde o token');
  await routes['POST /api/recebimento/config'](req({ body: { recontagens_min: 1 } }), res());
});

test('chat: msgId repetido (fila offline) não duplica a mensagem', async () => {
  const { routes, logs } = montarAmbiente({ notas: { [CHAVE_A]: '5006' } });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const rAbrir = res();
  await routes['POST /api/recebimento-publico/abrir'](req({ query: { t }, body: { chave: CHAVE_A, nome: 'ana' } }), rAbrir);
  const id = rAbrir.body.id;
  const corpo = { id, motivo: 'validade', texto: 'produto vencendo', msgId: 'm-1' };
  const r1 = res(); await routes['POST /api/recebimento-publico/chat'](req({ query: { t }, body: corpo }), r1);
  const r2 = res(); await routes['POST /api/recebimento-publico/chat'](req({ query: { t }, body: corpo }), r2);
  assert.ok(!r1.body.repetido); assert.equal(r2.body.repetido, true);
  assert.equal(recebimento.obter(id).mensagens.length, 1);
  assert.equal(logs.filter(e => e.tipo === 'chat').length, 1, 'não loga o reenvio como conversa nova');
});

test('índice de pedidos por chave é montado uma vez e memoizado (não relê o disco por nota)', async () => {
  let chamadas = 0;
  const { app, routes } = fakeApp();
  const dirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-rotas-'));
  const pedidosFornec = { listar: () => { chamadas++; return []; }, gerarPdfDevolucao: () => '' };
  const api = montarRotasRecebimento(app, {
    q: async (sql) => (sql.includes('FROM central.axml a') ? Array.from({ length: 20 }, (_, i) => ({ chave: String(i).padStart(44, '0'), nNota: String(i), CNPJemit: '11222333000199', Data: '2026-09-20' })) : []),
    path, escreverERP: { lote: async () => ({ ok: true, id: 'L', ids: ['N'] }) }, pedidosFornec,
    conferenciaXml: { LOJA_CNPJ: { 3: '11222333000199' } }, logColetor: { registrar: () => {} }, LOG_COLETOR_DIR: dirBase, __dirname: dirBase,
  });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const r = res();
  await routes['GET /api/recebimento-publico/notas'](req({ query: { t } }), r);
  assert.equal(r.body.length, 20);
  assert.equal(chamadas, 1, '20 notas, 1 leitura dos pedidos do disco');
  api.invalidarIndiceXml();
  await routes['GET /api/recebimento-publico/notas'](req({ query: { t } }), res());
  assert.equal(chamadas, 2, 'depois de invalidar, relê uma vez');
});

test('cadastroCache: TTL por timestamp, sem um setTimeout por código, e com teto de tamanho', async () => {
  let idas = 0;
  const { routes } = montarAmbiente({ q: async (sql, params) => { if (!sql.includes('FROM central.itens')) return []; idas++; return [{ cod: params[0], descricao: 'X' + params[0], qtdemb: 1, UnidadeCompra: 'UN', Validar: 0 }]; } });
  const cfg = recebimento.config(); const t = cfg.lojas[3].token;
  const antes = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter(x => x === 'Timeout').length : 0;
  for (let i = 0; i < 50; i++) await routes['GET /api/recebimento-publico/cadastro/:cod'](req({ query: { t }, params: { cod: 'c' + i } }), res());
  await routes['GET /api/recebimento-publico/cadastro/:cod'](req({ query: { t }, params: { cod: 'c0' } }), res());
  assert.equal(idas, 50, 'o 51º pedido (repetido) saiu do cache');
  const depois = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter(x => x === 'Timeout').length : 0;
  assert.ok(depois - antes < 5, 'nenhum timer por código de barras (' + (depois - antes) + ')');
});
