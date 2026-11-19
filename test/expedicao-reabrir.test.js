// Pedido reaberto e alterado no Dlinks DEPOIS do carregamento fechado ou da saída liberada (19/11/26, Tiago: "faça o 2" =
// avisar e devolver pra conferência só os itens alterados). Antes a conferência ficava congelada com o pedido antigo.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const montarRotasExpedicao = require('../lib/expedicao-rotas');
const expedicao = require('../lib/expedicao');
const recebimento = require('../lib/recebimento');

function fakeApp() { const routes = {}; const reg = (m, p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; }; return { app: { get: (p, ...h) => reg('GET', p, ...h), post: (p, ...h) => reg('POST', p, ...h) }, routes }; }
const req = ({ query = {}, body = {} } = {}) => ({ query, body, params: {}, headers: {}, session: { user: { nome: 'Nicoly Chagas' } } });
function res() { const r = { statusCode: 200 }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; return r; }
const hoje = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

const A = '7891150097605', B = '7891000100103', C = '7896004000015', D = '7894900011517';
const DESC = { [A]: 'ALA ERVA DOCE', [B]: 'LEITE MOCA', [C]: 'ARROZ TIO JOAO', [D]: 'COCA COLA 2L' };
// linha de delivery_produtos como o ERP devolve
const linha = (nPedido, cod, qtd) => ({ nPedido, cod, descricao: DESC[cod], und: 'UN', qtd: String(qtd), qtdEmb: '0.00', conversao: '' });
const bipado = (cod, un) => ({ cod, descricao: DESC[cod], quant: un, emb: 1, un, lotes: [], estado: 'ok', bipagens: 1 });
// conferência de duas etapas com A=10, B=20, C=5 separados e carregados 100 %
function conferencia(nPedido, status, extra = {}) {
  const id = 'exp-' + hoje() + '-10-' + nPedido, quando = new Date().toISOString();
  const itens = () => ({ [A]: bipado(A, 10), [B]: bipado(B, 20), [C]: bipado(C, 5) });
  const c = { id, loja: 10, nPedido: String(nPedido), cliente: 'SERAFIM SUPERMERCADO', status, nome: 'MARIA', abertoEm: quando, conferidaEm: quando, conferidaPor: 'JOAO', eventos: [], erp: { nReg: null, erros: [], espelhadoEm: quando },
    pedido: expedicao.normalizarPedido([linha(nPedido, A, 10), linha(nPedido, B, 20), linha(nPedido, C, 5)]),
    etapas: { separacao: { etapa: 'separacao', operador: null, abertoEm: quando, itens: itens(), fora: {}, fechadoEm: quando, fechadoPor: 'MARIA', tentativas: 1, bipes_vistos: {} },
      expedicao: { etapa: 'expedicao', operador: null, abertoEm: quando, itens: itens(), fora: {}, fechadoEm: quando, fechadoPor: 'JOAO', tentativas: 1, bipes_vistos: {} } }, ...extra };
  if (status === 'fechada') Object.assign(c, { fechadoEm: quando, fechadoPor: 'JOAO', saida: { decisao: 'liberada', decididoPor: 'NICOLY CHAGAS', decididoEm: quando, obs: '' } });
  return expedicao.salvar(c);
}
function iniciar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-reabrir-'));
  recebimento.init({ dir: path.join(dir, 'rec'), cadastro: async () => null, xmlLoja: () => null });
  expedicao.init({ dir: path.join(dir, 'exp'), cadastro: async cod => ({ descricao: DESC[cod] || cod }), vinculo: async () => null });
  return dir;
}
// erp: { [nPedido]: { status, nfe, painel (null = fora do painel), itens: [[cod, qtd]...], data } }
function montar(erp, { auto = false } = {}) {
  const dir = iniciar(); const { app, routes } = fakeApp(); const logs = [], ordens = [], sqls = [];
  const q = async (sql, params) => {
    sqls.push(sql); const nums = (params || []).map(String);
    if (sql.includes('FROM central.delivery WHERE nLoja=? AND nPedido IN')) return Object.entries(erp).filter(([n]) => nums.includes(n)).map(([n, p]) => ({ nPedido: +n, Data: p.data || hoje(), Status: p.status == null ? 1 : p.status, NFe: p.nfe || '0' }));
    if (sql.includes('FROM central.painel_televendas WHERE nLoja=? AND nPedido IN') && sql.includes('ORDER BY nReg')) return Object.entries(erp).filter(([n, p]) => nums.includes(n) && p.painel != null).map(([n, p]) => ({ nPedido: n, Status: p.painel }));
    if (sql.includes('Conversao conversao FROM central.delivery_produtos WHERE nPedido IN')) return Object.entries(erp).filter(([n]) => nums.includes(n)).flatMap(([n, p]) => p.itens.map(([cod, qtd]) => linha(+n, cod, qtd)));
    return [];
  };
  const estado = { auto };
  const conector = { televendasAuto: () => estado.auto, liberacaoTelevendas: async (chave, por, dados) => { ordens.push({ chave, por, dados }); return { ok: true, status: 'ok', ordem: 'ORD' + ordens.length, id: 'LOG' + ordens.length, resultado: { pedido: dados.pedido, ja_liberado: false, status_anterior: 0 } }; } };
  const rotas = montarRotasExpedicao(app, { q, escreverERP: { lote: async () => ({ ok: true, id: 'LOGX', ids: [] }) }, recebimento, expedicao, logColetor: { registrar: (d, ev) => logs.push(ev) }, LOG_COLETOR_DIR: dir, conector });
  return { routes, rotas, logs, ordens, sqls, estado, t10: recebimento.config().lojas[10].token };
}

test('saída liberada + pedido alterado: só os itens alterados voltam pra separação e pro carregamento; o resto continua valendo', async () => {
  iniciar(); const c0 = conferencia(8201, 'fechada', { dlinks: { ok: true, em: 'x', por: 'NICOLY', erros: [] } });
  // A igual · B 20 → 12 · C tirado · D novo
  const r = expedicao.reabrirPorPedido(c0.id, [linha(8201, A, 10), linha(8201, B, 12), linha(8201, D, 6)], { fonte: 'DLINKS' });
  assert.equal(r.alterado, true); assert.equal(r.reabriu, true); assert.equal(r.status, 'separando'); assert.equal(r.de, 'fechada');
  assert.deepEqual(r.refazer.map(x => x.cod).sort(), [B, D].sort()); assert.deepEqual(r.tirar.map(x => x.cod), [C]);
  let c = expedicao.obter(c0.id);
  assert.deepEqual(Object.keys(c.etapas.separacao.itens), [A], 'separação: só o item que não mudou continua separado');
  assert.deepEqual(Object.keys(c.etapas.expedicao.itens), [A], 'carregamento: só o item que não mudou continua bipado');
  assert.equal(c.etapas.expedicao.fora[C].un, 5, 'item tirado do pedido segue no caminhão (fora) até alguém tirar');
  assert.equal(c.pedido[B].un, 12); assert.ok(c.pedido[D]); assert.ok(!c.pedido[C]);
  assert.equal(c.avisoFiscal.erp, true); assert.equal(c.avisoFiscal.reconferir, true); assert.deepEqual(c.avisoFiscal.itens.map(x => x.cod).sort(), [B, D].sort());
  assert.deepEqual(c.avisoCarga.tirar.map(x => x.cod), [C]); assert.match(c.avisoCarga.obs, /depois da saída liberada/);
  assert.equal(c.dlinks, undefined, 'a liberação anterior no Dlinks sai da linha (fica no histórico)'); assert.equal(c.fechadoEm, null);
  assert.equal(c.reaberturas.length, 1); assert.equal(c.reaberturas[0].dlinks.ok, true); assert.equal(c.reaberturas[0].saida.decisao, 'liberada');
  assert.equal(c.separacoesAnteriores[0].itens[B].un, 20); assert.equal(c.carregamentosAnteriores[0].itens[B].un, 20); assert.equal(c.carregamentosAnteriores[0].reconferirPor, 'DLINKS');
  const ev = c.eventos[c.eventos.length - 1]; assert.equal(ev.tipo, 'pedido_erp'); assert.equal(ev.depois, 'fechada');
  assert.deepEqual(expedicao.reaberturaAberta(c).de, 'fechada');
  assert.equal(expedicao.acharPorPedido('8201').id, c0.id, 'volta a ser pedido aberto pro coletor'); assert.equal(expedicao.saidaLiberada('8201'), null);
  const painel = expedicao.statusColetorPorPedido(7)['8201']; assert.equal(painel.rotulo, 'Pedido alterado · separar'); assert.equal(painel.reconferir, true); assert.equal(painel.reaberto, true);

  // separação: o separador vê a lista com B e D em aberto e fecha só com eles
  const v = expedicao.visao(c0.id, null); assert.equal(v.etapa, 'separacao'); assert.equal(v.pedido.find(p => p.cod === A).separado.estado, 'ok'); assert.equal(v.pedido.find(p => p.cod === B).separado, null);
  let t = expedicao.terminei(c0.id, {}); assert.equal(t.fechou, false); assert.deepEqual(t.pendentes.map(p => p.cod).sort(), [B, D].sort());
  await expedicao.separar(c0.id, { cod: B, quant: 12, emb: 1 }); await expedicao.separar(c0.id, { cod: D, quant: 6, emb: 1 });
  t = expedicao.terminei(c0.id, {}); assert.equal(t.fechou, true); assert.equal(t.status, 'separada');

  // carregamento: reabre o MESMO (A continua bipado), bipa B e D, tira C do caminhão
  c = expedicao.abrirPedido({ nPedido: '8201', itens: [], operador: null }); assert.equal(c.status, 'expedindo'); assert.equal(c.etapas.expedicao.itens[A].un, 10, 'não começou um carregamento novo');
  t = expedicao.terminei(c0.id, {}); assert.equal(t.fechou, false); assert.deepEqual(t.fora.map(f => f.cod), [C]);
  await expedicao.bipar(c0.id, { cod: B, quant: 12, emb: 1 }); await expedicao.bipar(c0.id, { cod: D, quant: 6, emb: 1 });
  expedicao.tirar(c0.id, { cod: C, motivo: 'saiu do pedido' });
  t = expedicao.terminei(c0.id, {}); assert.equal(t.fechou, true); assert.equal(t.status, 'conferida');
  c = expedicao.obter(c0.id); assert.equal(c.avisoCarga, null); assert.ok(expedicao.reaberturaAberta(c), 'segue marcado como alterado até o fiscal liberar de novo');
  assert.equal(expedicao.statusColetorPorPedido(7)['8201'].rotulo, 'Carregado · fiscal liberar');
  const conf = expedicao.detalhe(c0.id); assert.equal(conf.divergencias, 0); assert.equal(conf.reaberto.de, 'fechada'); assert.equal(conf.alteracoesErp[0].depois, 'fechada');
  const lib = expedicao.liberarSaida(c0.id, { decisao: 'liberar', nome: 'Nicoly' }); assert.equal(lib.status, 'fechada');
  assert.equal(expedicao.reaberturaAberta(expedicao.obter(c0.id)), null);
});

test('só item tirado: volta direto pro carregamento; tirado que nem foi carregado não reabre nada; pedido igual não mexe', () => {
  iniciar();
  const c1 = conferencia(8202, 'conferida');
  let r = expedicao.reabrirPorPedido(c1.id, [linha(8202, A, 10), linha(8202, B, 20)]);
  assert.equal(r.reabriu, true); assert.equal(r.status, 'expedindo'); assert.equal(r.de, 'conferida');
  let c = expedicao.obter(c1.id); assert.equal(c.avisoFiscal, undefined); assert.deepEqual(c.avisoCarga.itens, []); assert.deepEqual(c.avisoCarga.tirar.map(x => x.cod), [C]);
  assert.ok(c.etapas.separacao.fechadoEm, 'separação continua fechada'); assert.equal(c.etapas.expedicao.fora[C].un, 5);
  assert.equal(expedicao.statusColetorPorPedido(7)['8202'].rotulo, 'Pedido alterado · carregar');

  // fiscal tinha liberado sem o C (não separado, não carregado): tirar o C do pedido só registra
  const c2 = conferencia(8203, 'fechada'); const x = expedicao.obter(c2.id); delete x.etapas.separacao.itens[C]; delete x.etapas.expedicao.itens[C]; expedicao.salvar(x);
  r = expedicao.reabrirPorPedido(c2.id, [linha(8203, A, 10), linha(8203, B, 20)]);
  assert.equal(r.alterado, true); assert.equal(r.reabriu, false); c = expedicao.obter(c2.id); assert.equal(c.status, 'fechada'); assert.equal(c.reaberturas, undefined); assert.equal(c.eventos[0].tipo, 'pedido_erp');

  const c3 = conferencia(8204, 'fechada');
  assert.equal(expedicao.reabrirPorPedido(c3.id, [linha(8204, A, 10), linha(8204, B, 20), linha(8204, C, 5)]).alterado, false);
  assert.equal(expedicao.reabrirPorPedido(c3.id, []).alterado, false, 'lista vazia do ERP nunca apaga o pedido');
  assert.equal(expedicao.obter(c3.id).status, 'fechada');
});

test('vigia: só mexe em pedido sem nota e fechado de novo no Televendas; o coletor recebe o pedido de volta e a nova liberação vai pro Dlinks', async () => {
  const erp = {
    8301: { painel: 4, itens: [[A, 10], [B, 12], [C, 5]] },            // alterado e fechado de novo → reabre
    8302: { painel: 4, nfe: '55123', itens: [[A, 1]] },                // já tem nota → não mexe
    8303: { painel: null, status: 0, itens: [[A, 1]] },                // reaberto, ainda em edição (fora do painel) → espera fechar
    8304: { painel: 4, itens: [[A, 10], [B, 20], [C, 5]] },            // igual → não mexe
  };
  const { routes, rotas, logs, ordens, estado } = montar(erp, { auto: true });
  const ids = {}; for (const n of Object.keys(erp)) ids[n] = conferencia(+n, 'fechada', { dlinks: { ok: true, em: 'x', por: 'NICOLY', erros: [] } }).id;
  let r = res(); await routes['GET /api/expedicao/saidas'](req(), r); assert.equal(r.statusCode, 200);
  assert.equal(expedicao.obter(ids[8301]).status, 'separando');
  for (const n of [8302, 8303, 8304]) assert.equal(expedicao.obter(ids[n]).status, 'fechada', 'pedido ' + n + ' não pode voltar');
  const log = logs.find(l => l.tipo === 'exp_pedido_erp'); assert.equal(log.nfe, '8301'); assert.equal(log.resultado, 'reaberto_separando'); assert.match(log.msg, /depois da saída liberada: 0 tirado\(s\), 0 novo\(s\), 1 qtd alterada\(s\)/);
  // linha do Fiscal
  r = res(); await routes['GET /api/expedicao/fechadas'](req(), r); const l = r.body.find(x => x.nPedido === '8301');
  assert.equal(l.status, 'separando'); assert.equal(l.reaberto.de, 'fechada'); assert.match(l.reaberto.resumo, /LEITE MOCA 20 → 12/); assert.equal(l.dlinks, null);
  assert.equal(r.body.find(x => x.nPedido === '8304').reaberto, null);

  // ciclo completo e nova liberação: outra ordem pro Conector (-r1), não a repetição da antiga
  await expedicao.separar(ids[8301], { cod: B, quant: 12, emb: 1 }); assert.equal(expedicao.terminei(ids[8301], {}).status, 'separada');
  expedicao.abrirPedido({ nPedido: '8301', itens: [], operador: null }); await expedicao.bipar(ids[8301], { cod: B, quant: 12, emb: 1 });
  assert.equal(expedicao.terminei(ids[8301], {}).status, 'conferida');
  r = res(); await routes['POST /api/expedicao/liberar-saida'](req({ body: { id: ids[8301], decisao: 'liberar' } }), r);
  assert.equal(r.body.status, 'fechada'); assert.equal(r.body.dlinks.ok, true); assert.equal(ordens.length, 1); assert.equal(ordens[0].chave, 'eco-libtv-L10-P8301-r1-t0');
  // mexeram de novo depois da segunda liberação: reabre outra vez
  erp[8301].itens = [[A, 10], [B, 12], [C, 5], [D, 3]];
  await rotas.vigiarLiberados(true);
  const c = expedicao.obter(ids[8301]); assert.equal(c.status, 'separando'); assert.equal(c.reaberturas.length, 2); assert.deepEqual(c.avisoFiscal.itens.map(x => x.cod), [D]);
  estado.auto = false;
});

test('vigia roda no máximo uma vez por minuto e erro do ERP não derruba a tela', async () => {
  const erp = { 8401: { painel: 4, itens: [[A, 10], [B, 20], [C, 5]] } };
  const { routes, rotas, sqls } = montar(erp); const id = conferencia(8401, 'fechada').id;
  await routes['GET /api/expedicao/saidas'](req(), res()); const n1 = sqls.filter(s => s.includes('nPedido IN')).length; assert.ok(n1 >= 3);
  erp[8401].itens = [[A, 9], [B, 20], [C, 5]];
  await routes['GET /api/expedicao/saidas'](req(), res()); assert.equal(sqls.filter(s => s.includes('Conversao conversao FROM central.delivery_produtos WHERE nPedido IN')).length, 1, 'segunda chamada no mesmo minuto não consulta o ERP');
  assert.equal(expedicao.obter(id).status, 'fechada');
  await rotas.vigiarLiberados(true); assert.equal(expedicao.obter(id).status, 'separando');
  // ERP fora do ar
  const m = montar({}); conferencia(8402, 'fechada');
  const { app, routes: r2 } = fakeApp();
  const rt = montarRotasExpedicao(app, { q: async () => { throw new Error('ER_HOST_IS_BLOCKED'); }, escreverERP: { lote: async () => ({ ok: true }) }, recebimento, expedicao, logColetor: { registrar: () => {} }, LOG_COLETOR_DIR: os.tmpdir(), conector: null });
  assert.deepEqual(await rt.vigiarLiberados(true), []); const r = res(); await r2['GET /api/expedicao/saidas'](req(), r); assert.equal(r.statusCode, 200); assert.ok(m);
});

test('coletor: o pedido reaberto volta pra lista com o aviso de pedido alterado', async () => {
  const erp = { 8501: { painel: 4, itens: [[A, 10], [B, 20]] } };   // tiraram o C depois de liberado
  const dir = iniciar(); const { app, routes } = fakeApp();
  const q = async (sql, params) => {
    const nums = (params || []).map(String);
    if (sql.includes('FROM central.delivery d WHERE')) return [{ nPedido: 8501, cliente: 'SERAFIM SUPERMERCADO', cnpj: '1', Data: hoje(), hora: '09:00:00', total: '10', status: 1 }];
    if (sql.includes('FROM central.delivery WHERE nLoja=? AND nPedido IN')) return [{ nPedido: 8501, Data: hoje(), Status: 1, NFe: '0' }];
    if (sql.includes('FROM central.painel_televendas')) return [{ nPedido: '8501', Status: 4, status: 4 }];
    if (sql.includes('Conversao conversao FROM central.delivery_produtos WHERE nPedido IN')) return erp[8501].itens.map(([cod, qtd]) => linha(8501, cod, qtd));
    if (sql.includes('FROM central.delivery_produtos WHERE nPedido IN')) return [{ nPedido: 8501, n: 2, un: 30 }];
    if (sql.includes('FROM central.conferencia_televendas')) return nums.length ? [] : [];
    return [];
  };
  montarRotasExpedicao(app, { q, escreverERP: { lote: async () => ({ ok: true }) }, recebimento, expedicao, logColetor: { registrar: () => {} }, LOG_COLETOR_DIR: dir, conector: null });
  const id = conferencia(8501, 'fechada').id; const t10 = recebimento.config().lojas[10].token;
  const r = res(); await routes['GET /api/expedicao-publico/pedidos'](req({ query: { t: t10 } }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.length, 1, 'saída liberada sumia da lista; alterado depois, volta');
  const p = r.body[0]; assert.equal(p.nPedido, '8501'); assert.equal(p.conferencia.etapa, 'expedicao'); assert.equal(p.conferencia.alteradoErp, true);
  assert.equal(p.conferencia.avisoCarga, 'tire do caminhão ARROZ TIO JOAO'); assert.equal(p.dlinksSemBipe, true);
  assert.equal(expedicao.obter(id).status, 'expedindo');
  const v = expedicao.visao(id, null); assert.equal(v.avisoCarga.erp, true); assert.deepEqual(v.fora.map(f => f.cod), [C]);
});

test('sem mudar item: se a liberação mandada pro Dlinks se perdeu na reabertura, a linha do fiscal volta a pedir "Tentar de novo"', async () => {
  const erp = { 8601: { painel: 0, itens: [[A, 10], [B, 20], [C, 5]] }, 8602: { painel: 4, itens: [[A, 10], [B, 20], [C, 5]] } };
  const { routes, rotas, logs, ordens } = montar(erp, { auto: true });
  const perdeu = conferencia(8601, 'fechada', { dlinks: { ok: true, em: 'x', por: 'NICOLY', erros: [] } }).id, segue = conferencia(8602, 'fechada', { dlinks: { ok: true, em: 'x', por: 'NICOLY', erros: [] } }).id;
  await rotas.vigiarLiberados(true);
  let c = expedicao.obter(perdeu); assert.equal(c.status, 'fechada', 'a nossa liberação continua valendo'); assert.equal(c.dlinks.ok, false); assert.equal(c.dlinks.reaberto, true); assert.match(c.dlinks.erro, /voltou pra "Para separação"/);
  assert.equal(expedicao.obter(segue).dlinks.ok, true, 'continua Liberado no Dlinks: nada a fazer');
  assert.ok(logs.some(l => l.tipo === 'exp_dlinks' && l.nfe === '8601' && l.resultado === 'erro'));
  await rotas.vigiarLiberados(true); assert.equal(expedicao.obter(perdeu).dlinks.erros.length, 1, 'não repete o erro a cada volta');
  const r = res(); await routes['POST /api/expedicao/liberar-dlinks'](req({ body: { id: perdeu } }), r);
  assert.equal(r.body.dlinks.ok, true); assert.equal(ordens[0].chave, 'eco-libtv-L10-P8601-t1', 'ordem nova, não a repetição da que já tinha sido executada');
});
