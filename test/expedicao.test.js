// Expedição do CD (loja 10): saída em DUAS etapas — Separação de Pedidos (com lista, quantidade digitada) → Carregamento
// de Caminhão (cego, bate com a separação); quem separou não carrega; divergência separação × pedido vai pro fiscal do CD
// — spec 2026-09-29-coletor-cd-expedicao-processo.md (seções de 14/10/26)
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const E = require('../lib/expedicao');

const ITENS = [
  { cod: '7891150097605', descricao: 'OLEO LIZA 900ML', qtd: 80, qtdEmb: 0, und: 'CX', conversao: '4 CX c/20' },   // 80 un
  { cod: '17898403781295', descricao: 'ACUCAR PETRIBU 1KG', qtd: 300, qtdEmb: 30, und: 'FD' }, // 300 un
  { cod: '789', descricao: 'ITEM UNITARIO', qtd: 5, qtdEmb: 0, und: 'UN' },              // 5 un
];
const MARIA = { id: 'op-maria', nome: 'MARIA' }, JOAO = { id: 'op-joao', nome: 'JOAO' };
function setup(agora = new Date('2026-09-29T10:00:00')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
  E.init({ dir, agora: () => agora, cadastro: async cod => cod === '999' ? { descricao: 'FORA DO PEDIDO' } : null, vinculo: async cod => cod === '17891150097602' ? { cod: '7891150097605', emb: 20 } : null });
  return E.abrirPedido({ nPedido: 6853, cliente: 'SERAFIM SUPERMERCADO', cnpj: '35226657000156', nome: 'carmem', itens: ITENS, total: 5558.22, operador: MARIA });
}
// bipa tudo certo na etapa atual
async function biparTudo(id, op, lotes = { '7891150097605': 'L01', '17898403781295': 'F7', '789': 'U1' }) {
  await E.bipar(id, { cod: '7891150097605', quant: 4, emb: 20, lote: lotes['7891150097605'], operador: op });
  await E.bipar(id, { cod: '17898403781295', quant: 10, emb: 30, lote: lotes['17898403781295'], operador: op });
  await E.bipar(id, { cod: '789', quant: 5, emb: 1, lote: lotes['789'], operador: op });
}

test('abrirPedido: id exp-dia-10-nPedido, pedido em unidades (Qtd direto; emb do QtdEmb ou do "c/NN"), começa em separação, reabrir devolve a mesma', () => {
  const c = setup();
  assert.equal(c.id, 'exp-2026-09-29-10-6853'); assert.equal(c.status, 'separando'); assert.equal(c.nome, 'CARMEM');
  assert.deepEqual(c.etapas.separacao.operador, MARIA); assert.equal(c.etapas.expedicao, null);
  assert.deepEqual(Object.values(c.pedido).map(p => p.cod + ':' + p.un).sort(), ['17898403781295:300', '7891150097605:80', '789:5']);
  assert.equal(c.pedido['7891150097605'].emb, 20, 'emb lida do "c/20"'); assert.equal(c.pedido['17898403781295'].emb, 30);
  assert.equal(E.abrirPedido({ nPedido: '6853', cliente: 'X', itens: [], operador: JOAO }).id, c.id, 'separando: qualquer um retoma');
  // Separação de Pedidos NÃO é cega (Tiago, 14/10 noite): a visão leva a lista do pedido, na ordem do pedido, com quantidade e 4 últimos do EAN
  const v = E.visao(c.id, MARIA); assert.equal(v.pedido.length, 3); assert.equal(v.separados, 0);
  assert.deepEqual(v.pedido.map(p => p.ean4 + ':' + p.un + ':' + p.emb), ['7605:80:20', '1295:300:30', '789:5:1']); assert.equal(v.pedido[0].separado, null);
  assert.equal(v.etapa, 'separacao'); assert.equal(v.separadoPor, 'MARIA'); assert.equal(v.souSeparador, true); assert.equal(E.visao(c.id, JOAO).souSeparador, false);
});

test('bipar cego: sem lote não soma; ok quando bate; qtd_diferente sem revelar; fora_do_pedido não entra nos itens', async () => {
  const c = setup(); const op = MARIA;
  let r = await E.bipar(c.id, { cod: '7891150097605', quant: 4, emb: 20, operador: op });
  assert.equal(r.resultado, 'sem_lote'); assert.equal(E.obter(c.id).etapas.separacao.itens['7891150097605'], undefined);
  r = await E.bipar(c.id, { cod: '7891150097605', quant: 3, emb: 20, lote: 'l01', operador: op });
  assert.equal(r.resultado, 'qtd_diferente'); assert.equal(r.item.estado, 'diferente'); assert.equal(r.item.un, 60); assert.ok(!('pedido' in r.item)); assert.equal(r.item.por, 'MARIA');
  r = await E.bipar(c.id, { cod: '7891150097605', quant: 1, emb: 20, lote: 'L02', operador: op });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.un, 80); assert.deepEqual(r.item.lotes.map(l => l.lote + ':' + l.quant), ['L01:3', 'L02:1']);
  r = await E.bipar(c.id, { cod: '999', quant: 2, emb: 1, lote: 'Z', operador: op });
  assert.equal(r.resultado, 'fora_do_pedido'); assert.equal(r.item.descricao, 'FORA DO PEDIDO');
  // bipou a caixa (DUN-14) vinculada: cai no código da unidade do pedido, 1 caixa = 20 un → passou de 80
  r = await E.bipar(c.id, { cod: '17891150097602', quant: 1, emb: 1, lote: 'L03', operador: op });
  assert.equal(r.resultado, 'qtd_diferente'); assert.equal(r.item.cod, '7891150097605'); assert.equal(r.item.un, 100);
  const v = E.visao(c.id); assert.equal(v.itens.length, 1); assert.equal(v.fora.length, 1); assert.equal(v.fora[0].un, 2);
  // bipeId repetido (fila offline): não soma de novo
  r = await E.bipar(c.id, { cod: '789', quant: 5, emb: 1, lote: 'A', bipeId: 'b1', operador: op }); assert.equal(r.resultado, 'ok');
  r = await E.bipar(c.id, { cod: '789', quant: 5, emb: 1, lote: 'A', bipeId: 'b1', operador: op }); assert.equal(r.repetido, true); assert.equal(E.obter(c.id).etapas.separacao.itens['789'].un, 5);
});

test('tirar da coletagem: baixa por lote ou tudo, grava evento (com etapa) com antes/depois, fora do pedido some, item a mais volta a ok', async () => {
  const c = setup(); const op = MARIA;
  await E.bipar(c.id, { cod: '7891150097605', quant: 4, emb: 20, lote: 'L01', operador: op });
  await E.bipar(c.id, { cod: '7891150097605', quant: 2, emb: 20, lote: 'L02', operador: op });   // 120 un > 80
  assert.equal(E.obter(c.id).etapas.separacao.itens['7891150097605'].estado, 'diferente');
  let t = E.tirar(c.id, { cod: '7891150097605', quant: 2, lote: 'L02', motivo: 'sobrou', nome: 'jose', operador: op });
  assert.equal(t.item.un, 80); assert.equal(t.item.estado, 'ok'); assert.deepEqual(t.item.lotes.map(l => l.lote), ['L01']);
  assert.equal(t.evento.tipo, 'tirar_coletagem'); assert.equal(t.evento.etapa, 'separacao'); assert.equal(t.evento.antes, 120); assert.equal(t.evento.depois, 80); assert.equal(t.evento.nome, 'JOSE'); assert.equal(t.evento.verificado, null);
  await E.bipar(c.id, { cod: '999', quant: 1, emb: 1, lote: 'Z', operador: op });
  t = E.tirar(c.id, { cod: '999', operador: op });
  assert.equal(t.item, null); assert.equal(t.evento.fora, true); assert.equal(Object.keys(E.obter(c.id).etapas.separacao.fora).length, 0);
  assert.throws(() => E.tirar(c.id, { cod: '789', operador: op }), /não bipado/);
  const pend = E.pendenciasVerificacao(1); assert.equal(pend.length, 2); assert.equal(pend[0].nPedido, '6853');
  const ev = E.verificarPallet(c.id, pend[1].idx, 'fiscal'); assert.equal(ev.verificado.nome, 'FISCAL');
  assert.equal(E.pendenciasVerificacao(1).filter(p => !p.verificado).length, 1);
});

test('terminei da separação só fecha 100 %: lista pendentes (pedido × separado) e fora; fecha → status separada, pedido continua retomável', async () => {
  const c = setup(); const op = MARIA;
  await E.bipar(c.id, { cod: '7891150097605', quant: 4, emb: 20, lote: 'L01', operador: op });
  await E.bipar(c.id, { cod: '17898403781295', quant: 9, emb: 30, lote: 'F7', operador: op });
  await E.bipar(c.id, { cod: '999', quant: 1, emb: 1, lote: 'Z', operador: op });
  let t = E.terminei(c.id, { operador: op });
  assert.equal(t.fechou, false); assert.equal(t.etapa, 'separacao'); assert.equal(E.obter(c.id).status, 'separando');
  assert.deepEqual(t.pendentes.map(p => p.cod + ':' + p.motivo).sort(), ['17898403781295:a_menos', '789:nao_bipado']);
  assert.equal(t.fora.length, 1); assert.equal(t.aguardandoFiscal, false);
  const pA = t.pendentes.find(p => p.cod === '17898403781295'); assert.equal(pA.pedido, 300); assert.equal(pA.separado, 270); assert.equal(pA.ean4, '1295', 'separação mostra pedido × separado');
  assert.equal(E.saidasPorLote().length, 0);
  await E.bipar(c.id, { cod: '17898403781295', quant: 1, emb: 30, lote: 'F7', operador: op });
  await E.bipar(c.id, { cod: '789', quant: 5, emb: 1, lote: 'U1', operador: op });
  t = E.terminei(c.id, { operador: op }); assert.equal(t.fechou, false); assert.equal(t.pendentes.length, 0); assert.equal(t.fora.length, 1, 'fora do pedido ainda segura');
  E.tirar(c.id, { cod: '999', operador: op });
  t = E.terminei(c.id, { operador: op }); assert.equal(t.fechou, true); assert.equal(t.proxima, 'expedicao'); assert.equal(t.status, 'separada');
  const f = E.obter(c.id); assert.equal(f.status, 'separada'); assert.equal(f.etapas.separacao.fechadoPor, 'MARIA'); assert.equal(f.etapas.separacao.tentativas, 3); assert.equal(f.fechadoEm, undefined);
  await assert.rejects(E.bipar(c.id, { cod: '789', quant: 1, emb: 1, lote: 'U1', operador: JOAO }), /Separação fechada/, 'separada: precisa abrir o carregamento antes de bipar');
  assert.equal(E.saidasPorLote().length, 0, 'ainda não saiu nada');
  assert.ok(E.acharPorPedido(6853), 'separada continua retomável (pro carregamento)');
  const v = E.visao(c.id, JOAO); assert.equal(v.etapa, 'expedicao'); assert.equal(v.itens.length, 0, 'carregamento ainda não aberto: não mostra o que a separação bipou');
});

test('trava: quem separou NÃO abre nem bipa o carregamento; sem operador também não; outra pessoa carrega e o pedido fecha', async () => {
  const c = setup();
  await biparTudo(c.id, MARIA); assert.equal(E.terminei(c.id, { operador: MARIA }).fechou, true);
  assert.throws(() => E.abrirPedido({ nPedido: 6853, itens: [], operador: MARIA }), e => e.status === 409 && /Quem separou não pode carregar/.test(e.message) && e.separadoPor === 'MARIA');
  assert.throws(() => E.abrirPedido({ nPedido: 6853, itens: [], operador: null }), e => e.status === 403);
  assert.equal(E.obter(c.id).status, 'separada', 'recusa não abre o carregamento');
  const r = E.abrirPedido({ nPedido: 6853, itens: [], operador: JOAO });
  assert.equal(r.status, 'expedindo'); assert.deepEqual(r.etapas.expedicao.operador, JOAO);
  // MARIA entra no mesmo aparelho e tenta bipar: servidor recusa
  await assert.rejects(E.bipar(c.id, { cod: '789', quant: 5, emb: 1, lote: 'U1', operador: MARIA }), /Quem separou não pode carregar/);
  assert.throws(() => E.terminei(c.id, { operador: MARIA }), /Quem separou não pode carregar/);
  const v = E.visao(c.id, JOAO); assert.equal(v.etapa, 'expedicao'); assert.equal(v.itens.length, 0, 'cega: não vê a separação'); assert.equal(v.pedido, undefined, 'carregamento não leva a lista do pedido');
  await biparTudo(c.id, JOAO);
  const t = E.terminei(c.id, { operador: JOAO }); assert.equal(t.fechou, true); assert.equal(t.etapa, 'expedicao'); assert.equal(t.status, 'fechada');
  const f = E.obter(c.id); assert.equal(f.status, 'fechada'); assert.equal(f.fechadoPor, 'JOAO'); assert.equal(f.etapas.expedicao.fechadoPor, 'JOAO'); assert.equal(f.etapas.separacao.fechadoPor, 'MARIA');
  assert.equal(f.eventos.filter(e => e.tipo === 'lote_divergente').length, 0, 'mesmos lotes: sem divergência');
  await assert.rejects(E.bipar(c.id, { cod: '789', quant: 1, emb: 1, lote: 'U1', operador: JOAO }), /fechado/);
  const s = E.saidasPorLote(); assert.equal(s.length, 3); assert.equal(s.find(x => x.lote === 'F7').un, 300);
  assert.equal(E.acharPorPedido(6853), null, 'fechada não é retomada');
  const et = E.etapasDe(f); assert.equal(et.modelo, 'duas'); assert.equal(et.separacao.operador.nome, 'MARIA'); assert.equal(et.expedicao.operador.nome, 'JOAO');
});

test('lote diferente entre separação e carregamento: fecha mesmo assim e vira evento lote_divergente (pendência do fiscal, verificável)', async () => {
  const c = setup();
  await biparTudo(c.id, MARIA); E.terminei(c.id, { operador: MARIA });
  E.abrirPedido({ nPedido: 6853, itens: [], operador: JOAO });
  await biparTudo(c.id, JOAO, { '7891150097605': 'L99', '17898403781295': 'F7', '789': 'U1' });   // óleo saiu no L99, separado como L01
  const t = E.terminei(c.id, { operador: JOAO }); assert.equal(t.fechou, true);
  const f = E.obter(c.id); const div = f.eventos.filter(e => e.tipo === 'lote_divergente');
  assert.equal(div.length, 1); assert.equal(div[0].cod, '7891150097605'); assert.deepEqual(div[0].separacao, [{ lote: 'L01', un: 80 }]); assert.deepEqual(div[0].expedicao, [{ lote: 'L99', un: 80 }]);
  const pend = E.pendenciasVerificacao(1); assert.equal(pend.length, 1); assert.equal(pend[0].tipo, 'lote_divergente');
  E.verificarPallet(c.id, pend[0].idx, 'fiscal'); assert.equal(E.pendenciasVerificacao(1)[0].verificado.nome, 'FISCAL');
  assert.deepEqual(E.saidasPorLote().map(s => s.lote).sort(), ['F7', 'L99', 'U1'], 'Lotes no CD usa o lote que de fato saiu (carregamento)');
});

test('Separação de Pedidos com lista: produto acha no pedido (caixa vinculada cai na unidade) ou avisa fora; separar grava o TOTAL digitado, 0 limpa, lote opcional', async () => {
  const c = setup(); const op = MARIA;
  let p = await E.produto(c.id, '7891150097605', op); assert.equal(p.fora, false); assert.equal(p.item.ean4, '7605'); assert.equal(p.item.un, 80); assert.equal(p.item.emb, 20); assert.equal(p.item.separado, null);
  p = await E.produto(c.id, '17891150097602', op); assert.equal(p.fora, false); assert.equal(p.item.cod, '7891150097605', 'DUN-14 vinculado → unidade do pedido');
  p = await E.produto(c.id, '999', op); assert.equal(p.fora, true); assert.equal(p.descricao, 'FORA DO PEDIDO');
  let r = await E.separar(c.id, { cod: '7891150097605', quant: 3, emb: 20, operador: op });
  assert.equal(r.resultado, 'qtd_diferente'); assert.equal(r.item.un, 60); assert.equal(r.pedido.un, 80); assert.deepEqual(r.item.lotes, [], 'lote opcional na separação');
  r = await E.separar(c.id, { cod: '7891150097605', quant: 4, emb: 20, lote: 'l01', operador: op });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.un, 80, 'grava o total, não soma'); assert.deepEqual(r.item.lotes, [{ lote: 'L01', quant: 4, un: 80 }]); assert.equal(r.item.bipagens, 2);
  r = await E.separar(c.id, { cod: '999', quant: 1, emb: 1, operador: op });
  assert.equal(r.resultado, 'fora_do_pedido'); assert.equal(r.item, null); assert.equal(Object.keys(E.obter(c.id).etapas.separacao.fora).length, 0, 'fora do pedido não entra em lugar nenhum');
  // caixas + soltas (Tiago, 14/10): 3 caixas de 20 + 20 soltas = 80
  r = await E.separar(c.id, { cod: '7891150097605', quant: 3, emb: 20, soltas: 20, operador: op }); assert.equal(r.resultado, 'ok'); assert.equal(r.item.un, 80); assert.equal(r.item.soltas, 20);
  assert.equal(E.visao(c.id, op).pedido[0].separado.soltas, 20);
  r = await E.separar(c.id, { cod: '789', quant: 5, emb: 1, operador: op }); assert.equal(r.resultado, 'ok');
  r = await E.separar(c.id, { cod: '789', quant: 0, operador: op }); assert.equal(r.resultado, 'limpo'); assert.equal(E.obter(c.id).etapas.separacao.itens['789'], undefined);
  r = await E.separar(c.id, { cod: '789', quant: 5, emb: 1, bipeId: 's1', operador: op }); r = await E.separar(c.id, { cod: '789', quant: 5, emb: 1, bipeId: 's1', operador: op }); assert.equal(r.repetido, true);
  const v = E.visao(c.id, op); assert.equal(v.separados, 2); assert.equal(v.certos, 2); assert.equal(v.pedido.find(x => x.cod === '7891150097605').separado.un, 80);
  await assert.rejects(E.produto(c.id, '', op), /código obrigatório/);
});

test('divergência separação × pedido vai pro fiscal do CD: devolver volta pra separação com aviso; liberar fecha a separação parcial e o carregamento bate com o PALLET', async () => {
  const c = setup();
  await E.separar(c.id, { cod: '7891150097605', quant: 4, emb: 20, lote: 'L01', operador: MARIA });
  await E.separar(c.id, { cod: '17898403781295', quant: 9, emb: 30, operador: MARIA });   // 270 de 300 (faltou estoque); ITEM UNITARIO não separado
  assert.equal(E.aguardandoFiscal().length, 0);
  let t = E.terminei(c.id, { operador: MARIA }); assert.equal(t.fechou, false); assert.equal(t.aguardandoFiscal, false); assert.equal(E.obter(c.id).status, 'separando', 'sem enviarFiscal continua separando');
  t = E.terminei(c.id, { operador: MARIA, enviarFiscal: true, motivo: 'faltou açúcar no estoque' });
  assert.equal(t.fechou, false); assert.equal(t.aguardandoFiscal, true); assert.equal(t.status, 'aguardando_fiscal'); assert.equal(t.pendentes.length, 2);
  await assert.rejects(E.separar(c.id, { cod: '789', quant: 5, operador: MARIA }), /aguardando o fiscal/);
  assert.equal(E.abrirPedido({ nPedido: 6853, itens: [], operador: JOAO }).status, 'aguardando_fiscal', 'retomar não muda o status');
  let v = E.visao(c.id, JOAO); assert.equal(v.etapa, 'fiscal'); assert.equal(v.liberacao.motivo, 'faltou açúcar no estoque'); assert.equal(v.pedido.length, 3);
  // retaguarda vê pedido × separado item a item, na ordem do pedido
  const ag = E.aguardandoFiscal(); assert.equal(ag.length, 1); assert.equal(ag[0].separadoPor, 'MARIA'); assert.equal(ag[0].liberacao.decisao, null);
  assert.deepEqual(ag[0].itens.map(i => i.ean4 + ':' + i.un + ':' + (i.separado ? i.separado.un : 0) + ':' + i.diferenca), ['7605:80:80:0', '1295:300:270:-30', '789:5:0:-5']);
  // fiscal devolve → separando, com a observação
  assert.throws(() => E.decidirLiberacao(c.id, { decisao: 'x', nome: 'f' }), /liberar ou devolver/);
  let d = E.decidirLiberacao(c.id, { decisao: 'devolver', nome: 'fiscal cd', obs: 'tem açúcar na doca 2' });
  assert.equal(d.status, 'separando'); assert.equal(d.liberacao.decisao, 'devolvida'); assert.equal(d.liberacao.decididoPor, 'FISCAL CD');
  v = E.visao(c.id, MARIA); assert.equal(v.etapa, 'separacao'); assert.equal(v.avisoFiscal.obs, 'tem açúcar na doca 2'); assert.equal(E.aguardandoFiscal().length, 0);
  assert.throws(() => E.decidirLiberacao(c.id, { decisao: 'liberar', nome: 'f' }), /não está aguardando/);
  // separador ajusta e manda de novo; fiscal libera
  await E.separar(c.id, { cod: '17898403781295', quant: 10, emb: 30, operador: MARIA });
  t = E.terminei(c.id, { operador: MARIA, enviarFiscal: true, motivo: 'item unitário não tem' }); assert.equal(t.status, 'aguardando_fiscal'); assert.equal(t.pendentes.length, 1); assert.equal(E.obter(c.id).avisoFiscal, null);
  d = E.decidirLiberacao(c.id, { decisao: 'liberar', nome: 'fiscal cd', obs: 'segue sem o unitário' });
  assert.equal(d.status, 'separada'); assert.equal(d.liberacao.decisao, 'liberada');
  const f1 = E.obter(c.id); assert.equal(f1.etapas.separacao.fechadoPor, 'MARIA'); assert.ok(f1.etapas.separacao.fechadoEm); assert.equal(f1.eventos.filter(e => e.tipo === 'liberacao_fiscal').length, 2); assert.equal(f1.eventos.filter(e => e.tipo === 'pedido_fiscal').length, 2);
  // carregamento (cego, outra pessoa) bate com o que foi separado: o unitário NÃO é esperado e, se bipado, é "fora"
  assert.throws(() => E.abrirPedido({ nPedido: 6853, itens: [], operador: MARIA }), /Quem separou não pode carregar/);
  E.abrirPedido({ nPedido: 6853, itens: [], operador: JOAO });
  const ref = E.referencia(E.obter(c.id), E.obter(c.id).etapas.expedicao); assert.deepEqual(Object.keys(ref).sort(), ['17898403781295', '7891150097605']);
  let r = await E.bipar(c.id, { cod: '789', quant: 5, emb: 1, lote: 'U1', operador: JOAO }); assert.equal(r.resultado, 'fora_do_pedido'); assert.equal(r.item.descricao, 'ITEM UNITARIO');
  E.tirar(c.id, { cod: '789', operador: JOAO });
  r = await E.bipar(c.id, { cod: '7891150097605', quant: 4, emb: 20, lote: 'L01', operador: JOAO }); assert.equal(r.resultado, 'ok');
  r = await E.bipar(c.id, { cod: '17898403781295', quant: 10, emb: 30, lote: 'F7', operador: JOAO }); assert.equal(r.resultado, 'ok', 'bate com a separação (300), não com o pedido');
  t = E.terminei(c.id, { operador: JOAO }); assert.equal(t.fechou, true); assert.equal(t.status, 'fechada'); assert.equal(t.pendentes.length, 0);
  const f = E.obter(c.id); assert.equal(f.eventos.filter(e => e.tipo === 'lote_divergente').length, 0, 'separação sem lote no açúcar não gera divergência de lote');
  assert.equal(E.saidasPorLote().length, 2); assert.equal(E.etapasDe(f).separacao.fechadoPor, 'MARIA');
});

test('fiscal não libera pallet vazio; carregamento com fora da separação não vai pro fiscal (só a separação manda)', async () => {
  const c = setup();
  let t = E.terminei(c.id, { operador: MARIA, enviarFiscal: true, motivo: 'nada' }); assert.equal(t.status, 'aguardando_fiscal');
  assert.throws(() => E.decidirLiberacao(c.id, { decisao: 'liberar', nome: 'f' }), /pallet vazio/);
  E.decidirLiberacao(c.id, { decisao: 'devolver', nome: 'f', obs: 'separa' });
  await E.bipar(c.id, { cod: '999', quant: 1, emb: 1, lote: 'Z', operador: MARIA });
  assert.throws(() => E.terminei(c.id, { operador: MARIA, enviarFiscal: true }), /Tire da coletagem/);
  E.tirar(c.id, { cod: '999', operador: MARIA }); await biparTudo(c.id, MARIA); assert.equal(E.terminei(c.id, { operador: MARIA }).fechou, true);
  E.abrirPedido({ nPedido: 6853, itens: [], operador: JOAO });
  await E.bipar(c.id, { cod: '789', quant: 4, emb: 1, lote: 'U1', operador: JOAO });
  t = E.terminei(c.id, { operador: JOAO, enviarFiscal: true, motivo: 'x' }); assert.equal(t.fechou, false); assert.equal(t.aguardandoFiscal, false); assert.equal(E.obter(c.id).status, 'expedindo');
  assert.ok(!('pedido' in t.pendentes[0]) && !('separado' in t.pendentes[0]), 'carregamento continua cego');
});

test('operadores do CD: cadastro com PIN de 4 dígitos único, login por PIN gera token, inativar derruba a sessão', () => {
  setup();
  assert.throws(() => E.salvarOperador({ nome: 'ana', pin: '12' }), /4 dígitos/);
  assert.throws(() => E.salvarOperador({ nome: '', pin: '1234' }), /Nome/);
  const a = E.salvarOperador({ nome: 'ana', pin: '1234' }); assert.equal(a.nome, 'ANA'); assert.ok(/^op-/.test(a.id)); assert.equal(a.ativo, true);
  assert.throws(() => E.salvarOperador({ nome: 'beto', pin: '1234' }), /já é de ANA/);
  const b = E.salvarOperador({ nome: 'beto', pin: '5678' });
  assert.equal(E.temOperadores(), true); assert.deepEqual(E.operadores().map(o => o.nome), ['ANA', 'BETO']);
  assert.equal(E.entrarOperador('0000'), null);
  const s = E.entrarOperador('5678'); assert.deepEqual(s.operador, { id: b.id, nome: 'BETO' }); assert.match(s.token, /^[a-f0-9]{32}$/);
  assert.deepEqual(E.operadorPorToken(s.token), { id: b.id, nome: 'BETO' }); assert.equal(E.operadorPorToken('x'), null);
  E.salvarOperador({ id: b.id, nome: 'beto', pin: '5678', ativo: false });
  assert.equal(E.operadorPorToken(s.token), null, 'inativo não entra mais'); assert.equal(E.entrarOperador('5678'), null);
  E.salvarOperador({ nome: 'caio', pin: '5678' });   // PIN do inativo pode ser reaproveitado
  assert.equal(E.salvarOperador({ id: a.id, nome: 'ana paula', pin: '1234' }).nome, 'ANA PAULA');
});

test('modelo antigo (sem etapas, gravado antes de 14/10): continua numa etapa só e fecha direto', async () => {
  const c = setup(); const dia = c.id.slice(4, 14);
  // simula uma conferência gravada pelo código antigo
  const legado = { id: 'exp-' + dia + '-10-7000', loja: 10, nPedido: '7000', cliente: 'LEGADO', status: 'bipando', abertoEm: new Date().toISOString(), nome: 'CARMEM', pedido: { '789': { cod: '789', descricao: 'ITEM', un: 5, emb: 1 } }, itens: {}, fora: {}, eventos: [], erp: { nReg: null, erros: [] } };
  E.salvar(legado);
  assert.equal(E.abrirPedido({ nPedido: 7000, itens: [], operador: MARIA }).id, legado.id);
  const r = await E.bipar(legado.id, { cod: '789', quant: 5, emb: 1, lote: 'A', operador: MARIA }); assert.equal(r.resultado, 'ok');
  const t = E.terminei(legado.id, { nome: 'carmem' }); assert.equal(t.fechou, true); assert.equal(t.etapa, 'unica'); assert.equal(t.status, 'fechada');
  const f = E.obter(legado.id); assert.equal(f.status, 'fechada'); assert.equal(f.tentativas, 1); assert.equal(E.etapasDe(f).modelo, 'unica');
  assert.equal(E.saidasPorLote().length, 1);
});
