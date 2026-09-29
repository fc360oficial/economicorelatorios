// Rotas da Expedição do CD (loja 10): lista de pedidos do Televendas, abrir, bipar, tirar, terminei (espelho só ao fechar 100 %)
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const montarRotasExpedicao = require('../lib/expedicao-rotas');
const expedicao = require('../lib/expedicao');
const recebimento = require('../lib/recebimento');

function fakeApp() { const routes = {}; const reg = (m, p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; }; return { app: { get: (p, ...h) => reg('GET', p, ...h), post: (p, ...h) => reg('POST', p, ...h) }, routes }; }
function req({ query = {}, body = {}, params = {}, session = {} } = {}) { return { query, body, params, headers: {}, session }; }
function res() { const r = { statusCode: 200 }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; return r; }

const CAB = { nPedido: 6853, Nome: 'SERAFIM SUPERMERCADO', CPF: '35226657000156', Data: '2026-09-29', Hora: '09:56:19', Total: '5451.31', Status: 1, NFe: '0' };
const ITENS = [{ cod: '7891150097605', descricao: 'ALA ERVA DOCE', und: 'CX', qtd: '108.000', qtdEmb: '0.00', conversao: '4 FD c/27' }, { cod: '17891000457099', descricao: 'BOMBOM GAROTO CX30', und: 'CX', qtd: '2.000', qtdEmb: '0.00', conversao: '2 CX c/01' }];

function montar() {
  const { app, routes } = fakeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-rotas-'));
  recebimento.init({ dir: path.join(dir, 'rec'), cadastro: async () => null, xmlLoja: () => null });
  expedicao.init({ dir: path.join(dir, 'exp'), cadastro: async cod => ({ descricao: 'CAD ' + cod }), vinculo: async () => null });
  const logs = [], lotes = [];
  const q = async (sql, params) => {
    if (sql.includes('FROM central.delivery d WHERE')) return [{ nPedido: 6853, cliente: CAB.Nome, cnpj: CAB.CPF, Data: CAB.Data, hora: CAB.Hora, total: CAB.Total, status: 1 }, { nPedido: 6856, cliente: 'LOJA 3 PONTE', cnpj: '1', Data: CAB.Data, hora: '10:02:00', total: '1', status: 0 }];
    if (sql.includes('FROM central.painel_televendas')) return [{ nPedido: '6853', status: 1 }, { nPedido: '6856', status: 2 }];
    if (sql.includes('FROM central.delivery_produtos WHERE nPedido IN')) return [{ nPedido: 6853, n: 2, un: 110 }];
    if (sql.includes('FROM central.delivery WHERE nLoja=?')) return String(params[1]) === '6853' ? [CAB] : [];
    if (sql.includes('FROM central.delivery_produtos WHERE nPedido=?')) return ITENS;
    return [];
  };
  const escreverERP = { lote: async args => { lotes.push(args); return { ok: true, id: 'LOGX', ids: [] }; } };
  montarRotasExpedicao(app, { q, escreverERP, recebimento, expedicao, logColetor: { registrar: (d, ev) => logs.push(ev) }, LOG_COLETOR_DIR: dir });
  const t10 = recebimento.config().lojas[10].token, t3 = recebimento.config().lojas[3].token;
  return { routes, logs, lotes, t10, t3 };
}

test('só o token da loja 10 entra; /pedidos lista pedidos abertos do Televendas com painel e conferência local', async () => {
  const { routes, t10, t3 } = montar();
  let r = res(); await routes['GET /api/expedicao-publico/pedidos'](req({ query: { t: t3 } }), r); assert.equal(r.statusCode, 401);
  r = res(); await routes['GET /api/expedicao-publico/pedidos'](req({ query: { t: t10 } }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.length, 1, 'conferido/liberado no Dlinks (painel 2/4) some da lista');
  const p = r.body[0]; assert.equal(p.nPedido, '6853'); assert.equal(p.cliente, 'SERAFIM SUPERMERCADO'); assert.equal(p.hora, '09:56'); assert.equal(p.itens, 2); assert.equal(p.painel, 1); assert.equal(p.conferencia, null);
  assert.ok(!('un' in p), 'lista não leva quantidade do pedido');
});

test('abrir → bipar (avisos imediatos) → tirar (evento) → terminei só fecha 100 % e espelha em conferencia_televendas', async () => {
  const { routes, logs, lotes, t10 } = montar();
  let r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: { t: t10 }, body: { nPedido: '6853', nome: 'carmem' } }), r);
  assert.equal(r.statusCode, 200); const id = r.body.id; assert.equal(id, 'exp-' + expedicao.hojeStr() + '-10-6853'); assert.equal(r.body.produtos_pedido, 2);
  assert.ok(!JSON.stringify(r.body).includes('108'), 'visão nunca leva a qtd do pedido');
  r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: { t: t10 }, body: { nPedido: '9999', nome: 'carmem' } }), r); assert.equal(r.statusCode, 404);
  // bipe sem lote não soma; 3 fardos de 27 = 81 ≠ 108 → qtd_diferente
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: { t: t10 }, body: { id, cod: '7891150097605', quant: 3, emb: 27 } }), r); assert.equal(r.body.resultado, 'sem_lote');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: { t: t10 }, body: { id, cod: '7891150097605', quant: 3, emb: 27, lote: 'L1' } }), r); assert.equal(r.body.resultado, 'qtd_diferente');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: { t: t10 }, body: { id, cod: '7891150097605', quant: 1, emb: 27, lote: 'L1' } }), r); assert.equal(r.body.resultado, 'ok');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: { t: t10 }, body: { id, cod: '17891000457099', quant: 2, emb: 1, lote: 'B2' } }), r); assert.equal(r.body.resultado, 'ok');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: { t: t10 }, body: { id, cod: '555', quant: 1, emb: 1, lote: 'X' } }), r); assert.equal(r.body.resultado, 'fora_do_pedido'); assert.equal(r.body.item.descricao, 'CAD 555');
  // não fecha: tem fora do pedido
  r = res(); await routes['POST /api/expedicao-publico/terminei'](req({ query: { t: t10 }, body: { id } }), r);
  assert.equal(r.body.fechou, false); assert.equal(r.body.fora.length, 1); assert.equal(lotes.length, 0, 'sem espelho enquanto não fecha');
  r = res(); await routes['POST /api/expedicao-publico/tirar'](req({ query: { t: t10 }, body: { id, cod: '555', motivo: 'tirei do pallet' } }), r);
  assert.equal(r.body.evento.tipo, 'tirar_coletagem'); assert.equal(r.body.visao.fora.length, 0);
  r = res(); await routes['POST /api/expedicao-publico/terminei'](req({ query: { t: t10 }, body: { id } }), r);
  assert.equal(r.body.fechou, true); assert.equal(r.body.visao.status, 'fechada');
  assert.equal(lotes.length, 1); const passos = lotes[0].passos; assert.equal(passos.length, 2);
  assert.deepEqual(passos.map(p => p.tabela + ':' + p.valores.Codigobarra + ':' + p.valores.Qtd + 'x' + p.valores.QtdEmb).sort(), ['conferencia_televendas:17891000457099:2x1', 'conferencia_televendas:7891150097605:4x27']);
  assert.equal(passos[0].valores.nPedido, 6853); assert.equal(passos[0].valores.nLoja, 10);
  assert.deepEqual(logs.map(l => l.tipo), ['exp_abrir', 'exp_bipe', 'exp_bipe', 'exp_bipe', 'exp_bipe', 'exp_fechar', 'tirar_coletagem', 'exp_fechar', 'erp']);
  // retaguarda: pendência de pallet e verificação pelo fiscal
  r = res(); routes['GET /api/expedicao/pendencias'](req({}), r); assert.equal(r.body.length, 1); assert.equal(r.body[0].verificado, null); const pend = r.body[0];
  r = res(); routes['POST /api/expedicao/verificar'](req({ body: { id, idx: pend.idx }, session: { user: { nome: 'Fiscal CD' } } }), r); assert.equal(r.body.verificado.nome, 'FISCAL CD');
  r = res(); routes['GET /api/expedicao/fechadas'](req({ query: {} }), r); assert.equal(r.body.length, 1); assert.equal(r.body[0].pendentesVerificar, 0); assert.equal(r.body[0].tirados, 1);
  r = res(); routes['GET /api/expedicao/lotes'](req({ query: {} }), r); const l1 = r.body.find(x => x.lote === 'L1'); assert.equal(l1.saiu, 108); assert.equal(l1.entrou, 0); assert.equal(l1.saldo, -108);
});
