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
function montarAmbiente({ q, loteImpl, cnpj = '11222333000199' } = {}) {
  const { app, routes } = fakeApp();
  const dirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-rotas-'));
  const loteChamadas = [];
  const logs = [];
  const pdfs = [];
  const escreverERP = { lote: async (args) => { loteChamadas.push(args); return loteImpl ? loteImpl(args) : { ok: true, id: 'LOG1', ids: ['NREG1'] }; } };
  const pedidosFornec = { listar: () => [], gerarPdfDevolucao: (p, ln, usuario, extras) => { pdfs.push({ p, ln, usuario, extras }); return path.join(dirBase, 'fake-devolucao.pdf'); } };
  const conferenciaXml = { LOJA_CNPJ: { 3: cnpj } };
  const logColetor = { registrar: (dir, ev) => logs.push(ev) };
  const qFn = q || (async () => []);
  montarRotasRecebimento(app, { q: qFn, path, escreverERP, pedidosFornec, conferenciaXml, logColetor, LOG_COLETOR_DIR: dirBase, __dirname: dirBase });
  return { routes, loteChamadas, logs, pdfs };
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
  const { routes, pdfs } = montarAmbiente({ q: async () => [] });
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
