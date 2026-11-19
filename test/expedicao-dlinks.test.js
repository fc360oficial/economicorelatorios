// Liberação da saída do CD → liberação no painel do Televendas do Dlinks pelo Conector (19/11/26, Tiago: "assim que eu liberar
// no nosso, liberar no Dlinks"). A chave fica em Processos › Conector e nasce desligada; a nossa liberação nunca depende do Dlinks.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const montarRotasExpedicao = require('../lib/expedicao-rotas');
const expedicao = require('../lib/expedicao');
const recebimento = require('../lib/recebimento');

function fakeApp() { const routes = {}; const reg = (m, p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; }; return { app: { get: (p, ...h) => reg('GET', p, ...h), post: (p, ...h) => reg('POST', p, ...h) }, routes }; }
const req = ({ query = {}, body = {} } = {}) => ({ query, body, params: {}, headers: {}, session: { user: { nome: 'Nicoly Chagas' } } });
function res() { const r = { statusCode: 200 }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; return r; }
const hoje = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

// conferência com o carregamento fechado 100 %, aguardando o fiscal ('conferida')
function conferida(nPedido) {
  const id = 'exp-' + hoje() + '-10-' + nPedido, quando = new Date().toISOString();
  const item = { cod: '7891150097605', descricao: 'ALA ERVA DOCE', quant: 4, emb: 27, un: 108, lotes: [{ lote: 'L1', quant: 4, un: 108 }] };
  return expedicao.salvar({ id, nPedido: String(nPedido), cliente: 'SERAFIM SUPERMERCADO', status: 'conferida', nome: 'MARIA', abertoEm: quando, conferidaEm: quando, conferidaPor: 'JOAO', eventos: [],
    pedido: { [item.cod]: { cod: item.cod, descricao: item.descricao, und: 'UN', qtd: 108, emb: 1, un: 108 } },
    etapas: { separacao: { itens: { [item.cod]: { ...item } }, fora: {}, fechadoEm: quando, fechadoPor: 'MARIA', tentativas: 1 }, expedicao: { itens: { [item.cod]: { ...item } }, fora: {}, fechadoEm: quando, fechadoPor: 'JOAO', tentativas: 1 } } });
}
function montar({ auto = true, respostas = [] } = {}) {
  const { app, routes } = fakeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-dlinks-'));
  recebimento.init({ dir: path.join(dir, 'rec'), cadastro: async () => null, xmlLoja: () => null });
  expedicao.init({ dir: path.join(dir, 'exp'), cadastro: async () => null, vinculo: async () => null });
  const logs = [], ordens = [], estado = { auto };
  const conector = { televendasAuto: () => estado.auto, liberacaoTelevendas: async (chave, por, dados) => { ordens.push({ chave, por, dados }); const r = respostas.shift(); if (r instanceof Error) throw r; return r || { ok: true, status: 'ok', ordem: '20261119-101500-abc123', id: 'LOG1', resultado: { pedido: dados.pedido, ja_liberado: false, status_anterior: 2 } }; } };
  montarRotasExpedicao(app, { q: async () => [], escreverERP: { lote: async () => ({ ok: true, id: 'LOGX', ids: [] }) }, recebimento, expedicao, logColetor: { registrar: (d, ev) => logs.push(ev) }, LOG_COLETOR_DIR: dir, conector });
  return { routes, logs, ordens, estado };
}
const liberar = async (routes, id) => { const r = res(); await routes['POST /api/expedicao/liberar-saida'](req({ body: { id, decisao: 'liberar' } }), r); return r; };

test('chave desligada (padrão): o fiscal libera a saída e nada vai pro Conector', async () => {
  const { routes, ordens } = montar({ auto: false }); const c = conferida(8101);
  const r = await liberar(routes, c.id);
  assert.equal(r.body.status, 'fechada'); assert.equal(r.body.dlinks, null); assert.equal(ordens.length, 0);
  assert.equal(expedicao.obter(c.id).dlinks, undefined);
  const t = res(); await routes['POST /api/expedicao/liberar-dlinks'](req({ body: { id: c.id } }), t); assert.equal(t.statusCode, 409); assert.match(t.body.error, /desligada/);
});

test('chave ligada: liberar a saída manda UMA ordem de liberação do pedido, com o nome do fiscal, e a linha passa a mostrar', async () => {
  const { routes, ordens, logs } = montar(); const c = conferida(8102);
  const r = await liberar(routes, c.id);
  assert.equal(r.body.status, 'fechada'); assert.equal(r.body.erp.ok, true); assert.equal(r.body.dlinks.ok, true); assert.equal(r.body.dlinks.statusAnterior, 2);
  assert.deepEqual(ordens.map(o => [o.chave, o.por, o.dados.loja, o.dados.pedido]), [['eco-libtv-L10-P8102-t0', 'NICOLY CHAGAS', 10, 8102]]);
  const g = expedicao.obter(c.id); assert.equal(g.dlinks.ok, true); assert.equal(g.dlinks.ordem, '20261119-101500-abc123'); assert.ok(g.erp.espelhadoEm, 'o espelho continua saindo');
  assert.ok(logs.some(l => l.tipo === 'exp_dlinks' && l.resultado === 'liberado' && String(l.nfe) === '8102'));
  // já liberado no Dlinks: "tentar de novo" não manda outra ordem
  const t = res(); await routes['POST /api/expedicao/liberar-dlinks'](req({ body: { id: c.id } }), t); assert.equal(t.body.dlinks.ok, true); assert.equal(ordens.length, 1);
  // a lista do Fiscal leva o resultado
  const f = res(); await routes['GET /api/expedicao/fechadas'](req({ query: { de: hoje() } }), f);
  assert.deepEqual(f.body.find(x => x.id === c.id).dlinks.ok, true);
});

test('Conector recusa ou cai: a NOSSA liberação continua valendo, o motivo fica na linha e "Tentar de novo" usa outra chave', async () => {
  const { routes, ordens, logs } = montar({ respostas: [{ ok: false, status: 'recusado', erro: 'Conector: pedido 8103 ainda não está no painel de separação do Dlinks' }, new Error('fetch failed')] });
  const c = conferida(8103);
  const r = await liberar(routes, c.id);
  assert.equal(r.statusCode, 200); assert.equal(r.body.status, 'fechada'); assert.equal(r.body.saida.decisao, 'liberada');
  assert.equal(r.body.dlinks.ok, false); assert.match(r.body.dlinks.erro, /ainda não está no painel/);
  assert.equal(expedicao.obter(c.id).status, 'fechada'); assert.equal(expedicao.obter(c.id).dlinks.erros.length, 1);
  assert.ok(logs.some(l => l.tipo === 'exp_dlinks' && l.resultado === 'erro'));
  // 2ª tentativa: o Conector nem responde
  let t = res(); await routes['POST /api/expedicao/liberar-dlinks'](req({ body: { id: c.id } }), t);
  assert.equal(t.body.dlinks.ok, false); assert.match(t.body.dlinks.erro, /fetch failed/); assert.equal(expedicao.obter(c.id).dlinks.erros.length, 2);
  // 3ª: passa
  t = res(); await routes['POST /api/expedicao/liberar-dlinks'](req({ body: { id: c.id } }), t); assert.equal(t.body.dlinks.ok, true);
  assert.deepEqual(ordens.map(o => o.chave), ['eco-libtv-L10-P8103-t0', 'eco-libtv-L10-P8103-t1', 'eco-libtv-L10-P8103-t2']);
  assert.equal(expedicao.obter(c.id).dlinks.erros.length, 2, 'o histórico de erros fica guardado');
});

test('pedido que ainda não teve a saída liberada não vai pro Dlinks; mandar reconferir também não', async () => {
  const { routes, ordens } = montar(); const c = conferida(8104);
  let t = res(); await routes['POST /api/expedicao/liberar-dlinks'](req({ body: { id: c.id } }), t); assert.equal(t.statusCode, 409); assert.match(t.body.error, /saída liberada/);
  const r = res(); await routes['POST /api/expedicao/liberar-saida'](req({ body: { id: c.id, decisao: 'reconferir', obs: 'conferir de novo' } }), r);
  assert.equal(r.body.status, 'separada'); assert.equal(r.body.dlinks, null); assert.equal(ordens.length, 0);
});
