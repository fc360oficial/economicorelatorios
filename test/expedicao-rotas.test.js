// Rotas da Expedição do CD (loja 10): lista de pedidos do Televendas, abrir, bipar, tirar, terminei em DUAS etapas
// (separação → expedição, quem separou não expede; espelho só ao fechar a expedição 100 %), operadores com PIN pessoal
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const montarRotasExpedicao = require('../lib/expedicao-rotas');
const expedicao = require('../lib/expedicao');
const recebimento = require('../lib/recebimento');

function fakeApp() { const routes = {}; const reg = (m, p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; }; return { app: { get: (p, ...h) => reg('GET', p, ...h), post: (p, ...h) => reg('POST', p, ...h) }, routes }; }
function req({ query = {}, body = {}, params = {}, session = {} } = {}) { return { query, body, params, headers: {}, session }; }
function res() { const r = { statusCode: 200 }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; return r; }

const CAB = { nPedido: 6853, Nome: 'SERAFIM SUPERMERCADO', CPF: '35226657000156', Data: '2026-09-29', Hora: '09:56:19', Total: '5451.31', Status: 1, NFe: '0' };
const ITENS = [{ cod: '7891150097605', descricao: 'ALA ERVA DOCE', und: 'UN', qtd: '108.000', qtdEmb: '0.00', conversao: '4 FD c/27' }, { cod: '17891000457099', descricao: 'BOMBOM GAROTO CX30', und: 'CX', qtd: '2.000', qtdEmb: '0.00', conversao: '2 CX c/01' }];

function montar() {
  const { app, routes } = fakeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-rotas-'));
  recebimento.init({ dir: path.join(dir, 'rec'), cadastro: async () => null, xmlLoja: () => null });
  expedicao.init({ dir: path.join(dir, 'exp'), cadastro: async cod => ({ descricao: 'CAD ' + cod }), vinculo: async () => null });
  const logs = [], lotes = [];
  const q = async (sql, params) => {
    if (sql.includes('FROM central.delivery d WHERE')) return [{ nPedido: 6853, cliente: CAB.Nome, cnpj: CAB.CPF, Data: CAB.Data, hora: CAB.Hora, total: CAB.Total, status: 1 }, { nPedido: 6856, cliente: 'LOJA 3 PONTE', cnpj: '1', Data: CAB.Data, hora: '10:02:00', total: '1', status: 0 }, { nPedido: 6858, cliente: 'DIGITADO SEM PAINEL', cnpj: '1', Data: CAB.Data, hora: '10:05:00', total: '1', status: 0 }];
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
  assert.equal(r.statusCode, 200); assert.equal(r.body.length, 1, 'digitado sem painel, conferido (2) e liberado (4) no Dlinks somem da lista');
  const p = r.body[0]; assert.equal(p.nPedido, '6853'); assert.equal(p.cliente, 'SERAFIM SUPERMERCADO'); assert.equal(p.hora, '09:56'); assert.equal(p.itens, 2); assert.equal(p.painel, 1); assert.equal(p.conferencia, null);
  assert.ok(!('un' in p), 'lista não leva quantidade do pedido');
});

test('duas etapas com PIN pessoal: MARIA separa → terminei vira "separada" → MARIA barrada (409) → JOAO expede → fecha, espelha SÓ a expedição; retaguarda vê as duas', async () => {
  const { routes, logs, lotes, t10 } = montar();
  // sem operador cadastrado o coletor da loja 10 não abre pedido
  let r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: { t: t10 }, body: { nPedido: '6853', nome: 'carmem' } }), r); assert.equal(r.statusCode, 403); assert.match(r.body.error, /Cadastre os operadores/);
  // cadastro na retaguarda + login por PIN
  r = res(); routes['POST /api/expedicao/operadores'](req({ body: { nome: 'maria', pin: '4821' }, session: { user: { nome: 'Tiago' } } }), r); assert.equal(r.body.nome, 'MARIA');
  r = res(); routes['POST /api/expedicao/operadores'](req({ body: { nome: 'joao', pin: '7305' } }), r); assert.equal(r.body.nome, 'JOAO');
  r = res(); routes['POST /api/expedicao/operadores'](req({ body: { nome: 'x', pin: '7305' } }), r); assert.equal(r.statusCode, 400);
  r = res(); routes['GET /api/expedicao/operadores'](req({}), r); assert.deepEqual(r.body.map(o => o.nome + ':' + o.pin), ['JOAO:7305', 'MARIA:4821']);
  const oM = expedicao.entrarOperador('4821').token, oJ = expedicao.entrarOperador('7305').token;
  const qM = { t: t10, o: oM }, qJ = { t: t10, o: oJ };
  // MARIA abre: separação
  r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: qM, body: { nPedido: '6853' } }), r);
  assert.equal(r.statusCode, 200); const id = r.body.id; assert.equal(id, 'exp-' + expedicao.hojeStr() + '-10-6853'); assert.equal(r.body.produtos_pedido, 2); assert.equal(r.body.etapa, 'separacao'); assert.equal(r.body.separadoPor, 'MARIA'); assert.equal(r.body.souSeparador, true);
  assert.equal(r.body.pedido.length, 2, 'Separação de Pedidos leva a lista do pedido'); assert.equal(r.body.pedido[0].un, 108); assert.equal(r.body.pedido[0].ean4, '7605'); assert.equal(r.body.pedido[0].separado, null);
  r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: qM, body: { nPedido: '9999' } }), r); assert.equal(r.statusCode, 404);
  // bipe sem lote não soma; 3 fardos de 27 = 81 ≠ 108 → qtd_diferente
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qM, body: { id, cod: '7891150097605', quant: 3, emb: 27 } }), r); assert.equal(r.body.resultado, 'sem_lote');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qM, body: { id, cod: '7891150097605', quant: 3, emb: 27, lote: 'L1' } }), r); assert.equal(r.body.resultado, 'qtd_diferente');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qM, body: { id, cod: '7891150097605', quant: 1, emb: 27, lote: 'L1' } }), r); assert.equal(r.body.resultado, 'ok');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qM, body: { id, cod: '17891000457099', quant: 2, emb: 1, lote: 'B2' } }), r); assert.equal(r.body.resultado, 'ok');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qM, body: { id, cod: '555', quant: 1, emb: 1, lote: 'X' } }), r); assert.equal(r.body.resultado, 'fora_do_pedido'); assert.equal(r.body.item.descricao, 'CAD 555');
  // não fecha: tem fora do pedido
  r = res(); await routes['POST /api/expedicao-publico/terminei'](req({ query: qM, body: { id } }), r);
  assert.equal(r.body.fechou, false); assert.equal(r.body.fora.length, 1); assert.equal(lotes.length, 0, 'sem espelho enquanto não fecha');
  r = res(); await routes['POST /api/expedicao-publico/tirar'](req({ query: qM, body: { id, cod: '555', motivo: 'tirei do pallet' } }), r);
  assert.equal(r.body.evento.tipo, 'tirar_coletagem'); assert.equal(r.body.evento.etapa, 'separacao'); assert.equal(r.body.visao.fora.length, 0);
  r = res(); await routes['POST /api/expedicao-publico/terminei'](req({ query: qM, body: { id } }), r);
  assert.equal(r.body.fechou, true); assert.equal(r.body.etapa, 'separacao'); assert.equal(r.body.proxima, 'expedicao'); assert.equal(r.body.visao.status, 'separada');
  assert.equal(lotes.length, 0, 'separação fechada NÃO espelha no ERP');
  // lista: pedido continua, agora na etapa expedição, e avisa a MARIA que ela separou
  r = res(); await routes['GET /api/expedicao-publico/pedidos'](req({ query: qM }), r); assert.equal(r.body.length, 1);
  assert.equal(r.body[0].conferencia.etapa, 'expedicao'); assert.equal(r.body[0].conferencia.separadoPor, 'MARIA'); assert.equal(r.body[0].conferencia.souSeparador, true); assert.equal(r.body[0].conferencia.emAndamento, false);
  r = res(); await routes['GET /api/expedicao-publico/pedidos'](req({ query: qJ }), r); assert.equal(r.body[0].conferencia.souSeparador, false);
  // trava: MARIA tenta expedir
  r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: qM, body: { nPedido: '6853' } }), r);
  assert.equal(r.statusCode, 409); assert.match(r.body.error, /Quem separou não pode carregar/); assert.equal(r.body.separadoPor, 'MARIA');
  r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: { t: t10 }, body: { nPedido: '6853' } }), r); assert.equal(r.statusCode, 403, 'sem PIN pessoal não expede');
  // JOAO expede (cego: não vê a separação)
  r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: qJ, body: { nPedido: '6853' } }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.etapa, 'expedicao'); assert.equal(r.body.status, 'expedindo'); assert.equal(r.body.itens.length, 0); assert.equal(r.body.separadoPor, 'MARIA');
  assert.equal(r.body.pedido, undefined, 'carregamento é cego'); assert.ok(!JSON.stringify(r.body).includes('108'), 'carregamento nunca leva a quantidade');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qM, body: { id, cod: '17891000457099', quant: 2, emb: 1, lote: 'B2' } }), r); assert.equal(r.statusCode, 409, 'MARIA no mesmo aparelho: bipe recusado');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qJ, body: { id, cod: '7891150097605', quant: 4, emb: 27, lote: 'L1' } }), r); assert.equal(r.body.resultado, 'ok');
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qJ, body: { id, cod: '17891000457099', quant: 2, emb: 1, lote: 'B9' } }), r); assert.equal(r.body.resultado, 'ok');   // lote diferente da separação (B2)
  r = res(); await routes['POST /api/expedicao-publico/terminei'](req({ query: qJ, body: { id } }), r);
  assert.equal(r.body.fechou, true); assert.equal(r.body.etapa, 'expedicao'); assert.equal(r.body.visao.status, 'fechada'); assert.equal(r.body.visao.expedidoPor, 'JOAO');
  assert.equal(lotes.length, 1); const passos = lotes[0].passos; assert.equal(passos.length, 2); assert.equal(lotes[0].usuario, 'coletor:JOAO');
  assert.deepEqual(passos.map(p => p.tabela + ':' + p.valores.Codigobarra + ':' + p.valores.Qtd + 'x' + p.valores.QtdEmb).sort(), ['conferencia_televendas:17891000457099:2x1', 'conferencia_televendas:7891150097605:4x27']);
  assert.equal(passos[0].valores.nPedido, 6853); assert.equal(passos[0].valores.nLoja, 10);
  assert.deepEqual(logs.map(l => l.tipo), ['operador', 'operador', 'exp_abrir', 'exp_bipe', 'exp_bipe', 'exp_bipe', 'exp_bipe', 'exp_fechar', 'tirar_coletagem', 'exp_fechar', 'exp_trava', 'exp_abrir', 'exp_bipe', 'exp_bipe', 'exp_fechar', 'lote_divergente', 'erp']);
  assert.equal(logs.find(l => l.tipo === 'exp_trava').nome, 'MARIA');
  // retaguarda: pendência de pallet (separação) + lote divergente (expedição), verificação pelo fiscal, as duas etapas na lista
  r = res(); routes['GET /api/expedicao/pendencias'](req({}), r); assert.equal(r.body.length, 2); assert.deepEqual(r.body.map(p => p.tipo).sort(), ['lote_divergente', 'tirar_coletagem']);
  const pend = r.body.find(p => p.tipo === 'tirar_coletagem'); assert.equal(pend.verificado, null);
  r = res(); routes['POST /api/expedicao/verificar'](req({ body: { id, idx: pend.idx }, session: { user: { nome: 'Fiscal CD' } } }), r); assert.equal(r.body.verificado.nome, 'FISCAL CD');
  r = res(); routes['GET /api/expedicao/fechadas'](req({ query: {} }), r); assert.equal(r.body.length, 1); const f = r.body[0];
  assert.equal(f.pendentesVerificar, 1, 'lote divergente ainda a verificar'); assert.equal(f.tirados, 1); assert.equal(f.lotesDivergentes, 1); assert.equal(f.tentativas, 3);
  assert.equal(f.etapas.modelo, 'duas'); assert.equal(f.etapas.separacao.operador.nome, 'MARIA'); assert.equal(f.etapas.separacao.tentativas, 2); assert.equal(f.etapas.expedicao.operador.nome, 'JOAO'); assert.equal(f.etapas.expedicao.fechadoPor, 'JOAO');
  r = res(); routes['GET /api/expedicao/lotes'](req({ query: {} }), r); const l1 = r.body.find(x => x.lote === 'L1'); assert.equal(l1.saiu, 108); assert.equal(l1.entrou, 0); assert.equal(l1.saldo, -108);
  assert.ok(r.body.find(x => x.lote === 'B9') && !r.body.find(x => x.lote === 'B2'), 'Lotes no CD usa o lote que saiu na expedição');
});

test('Separação de Pedidos com lista + fiscal do CD: /produto acha ou avisa fora; /separar grava o digitado; terminei com divergência manda pro fiscal; retaguarda libera; carregamento bate com o pallet', async () => {
  const { routes, logs, lotes, t10 } = montar();
  let r = res(); routes['POST /api/expedicao/operadores'](req({ body: { nome: 'maria', pin: '4821' } }), r); r = res(); routes['POST /api/expedicao/operadores'](req({ body: { nome: 'joao', pin: '7305' } }), r);
  const qM = { t: t10, o: expedicao.entrarOperador('4821').token }, qJ = { t: t10, o: expedicao.entrarOperador('7305').token };
  r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: qM, body: { nPedido: '6853' } }), r); const id = r.body.id;
  r = res(); await routes['GET /api/expedicao-publico/produto'](req({ query: { ...qM, id, cod: '7891150097605' } }), r); assert.equal(r.body.fora, false); assert.equal(r.body.item.un, 108);
  r = res(); await routes['GET /api/expedicao-publico/produto'](req({ query: { ...qM, id, cod: '555' } }), r); assert.equal(r.body.fora, true); assert.equal(r.body.descricao, 'CAD 555');
  r = res(); await routes['POST /api/expedicao-publico/separar'](req({ query: qM, body: { id, cod: '7891150097605', quant: 3, emb: 27 } }), r); assert.equal(r.body.resultado, 'qtd_diferente'); assert.equal(r.body.visao.pedido[0].separado.un, 81);
  r = res(); await routes['POST /api/expedicao-publico/separar'](req({ query: qM, body: { id, cod: '555', quant: 1 } }), r); assert.equal(r.body.resultado, 'fora_do_pedido'); assert.equal(r.body.visao.fora.length, 0);
  r = res(); await routes['POST /api/expedicao-publico/terminei'](req({ query: qM, body: { id, enviarFiscal: true, motivo: 'faltou' } }), r);
  assert.equal(r.body.fechou, false); assert.equal(r.body.aguardandoFiscal, true); assert.equal(r.body.visao.etapa, 'fiscal'); assert.equal(r.body.pendentes[0].pedido, 108); assert.equal(r.body.pendentes[0].separado, 81);
  r = res(); await routes['GET /api/expedicao-publico/pedidos'](req({ query: qM }), r); assert.equal(r.body[0].conferencia.etapa, 'fiscal');
  r = res(); await routes['POST /api/expedicao-publico/separar'](req({ query: qM, body: { id, cod: '7891150097605', quant: 4, emb: 27 } }), r); assert.equal(r.statusCode, 409);
  r = res(); routes['GET /api/expedicao/liberacoes'](req({ query: {} }), r); assert.equal(r.body.length, 1); assert.equal(r.body[0].liberacao.motivo, 'faltou'); assert.deepEqual(r.body[0].itens.map(i => i.diferenca), [-27, -2]);
  r = res(); routes['POST /api/expedicao/liberar'](req({ body: { id, decisao: 'liberar', obs: 'segue' }, session: { user: { nome: 'Fiscal CD' } } }), r); assert.equal(r.body.status, 'separada'); assert.equal(r.body.liberacao.decididoPor, 'FISCAL CD');
  r = res(); await routes['GET /api/expedicao-publico/pedidos'](req({ query: qJ }), r); assert.equal(r.body[0].conferencia.etapa, 'expedicao'); assert.equal(r.body[0].conferencia.liberada, true);
  r = res(); await routes['POST /api/expedicao-publico/abrir'](req({ query: qJ, body: { nPedido: '6853' } }), r); assert.equal(r.body.etapa, 'expedicao'); assert.equal(r.body.pedido, undefined);
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qJ, body: { id, cod: '17891000457099', quant: 2, emb: 1, lote: 'B1' } }), r); assert.equal(r.body.resultado, 'fora_do_pedido', 'bombom não foi separado: não é esperado no caminhão');
  r = res(); await routes['POST /api/expedicao-publico/tirar'](req({ query: qJ, body: { id, cod: '17891000457099' } }), r);
  r = res(); await routes['POST /api/expedicao-publico/bipar'](req({ query: qJ, body: { id, cod: '7891150097605', quant: 3, emb: 27, lote: 'L1' } }), r); assert.equal(r.body.resultado, 'ok', 'bate com os 81 separados');
  r = res(); await routes['POST /api/expedicao-publico/terminei'](req({ query: qJ, body: { id } }), r); assert.equal(r.body.fechou, true); assert.equal(r.body.visao.status, 'fechada');
  assert.equal(lotes.length, 1); assert.equal(lotes[0].passos.length, 1); assert.equal(lotes[0].passos[0].valores.Qtd, 3);
  r = res(); routes['GET /api/expedicao/fechadas'](req({ query: {} }), r); assert.equal(r.body[0].liberacao.decisao, 'liberada'); assert.equal(r.body[0].liberacao.pendentes, 2);
  assert.deepEqual(logs.filter(l => ['exp_separar', 'exp_fiscal'].includes(l.tipo)).map(l => l.tipo + ':' + l.resultado), ['exp_separar:qtd_diferente', 'exp_fiscal:liberada']);
  assert.equal(logs.filter(l => l.tipo === 'exp_bipe' && l.msg === 'separação · produto não está no pedido').length, 2);
  assert.match(logs.find(l => l.tipo === 'exp_fechar' && l.resultado === 'fiscal').msg, /mandada pro fiscal do CD · faltou/);
});
