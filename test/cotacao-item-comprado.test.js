process.env.COTACOES_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cotacoes-teste-'));   // a lib grava cotação em disco (salvarPrecos/preencherTodas): pasta temporária, nunca data/cotacoes
process.env.PORTAL_FORNECEDOR_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'portal-teste-'));   // idem pro portal (teste dos lembretes), nunca data/portal-fornecedor
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { comparativo, pendentesReais, podeEncerrar, prePedidos, preencherItensPedidos, preencherTodasItensPedidos, itensRepetidos, resumo, salvarPrecos, visaoVendedor, porToken, definirVencedor, negociarPreco, obter, finalizar, realizarPedido, fechar, marcarTeste, fornecedoresRealizados } = require('../lib/cotacao');

// "Item já comprado não muda de vencedor" (Tiago, 28/10/2026): na #4 a UNIÃO/Givaldo enviou a proposta às 23:41, DEPOIS dos 22
// pedidos realizados; ficou mais barato em itens já comprados, o comparativo fez dele o vencedor, a cotação voltou a ter
// "pendente" ("Em digitação" no Monitor) e saiu o pedido #232 repetindo compra. Agora a loja que já está num pedido realizado
// fica com quem comprou (c.prePedidos[cf].itens); preço que chega depois só concorre pelo que ninguém comprou.
const tok = ch => ch.repeat(32);
const base = () => ({
  id: 9, nome: 'Cotação teste', status: 'aberta', criadoEm: '2026-10-27T16:50:29.324Z', lojas: [1, 2],
  itens: [
    { cod: '111', descricao: 'ARROZ', unid: 'UN', emb: 10, qtd: 20, volumes: 2, lojas_qtd: { 1: 10, 2: 10 }, ultimo_custo: 5 },
    { cod: '222', descricao: 'FEIJAO', unid: 'UN', emb: 10, qtd: 20, volumes: 2, lojas_qtd: { 1: 10, 2: 10 }, ultimo_custo: 8 },
  ],
  fornecedores: [
    { codFornec: 10, nome: 'FORN A', status: 'finalizado', token: tok('a'), vendedor: { nome: 'a' }, precos: { '111': { preco: 4 }, '222': { preco: 7.5 } } },
    { codFornec: 20, nome: 'FORN B (chegou depois)', status: 'aguardando', token: tok('b'), vendedor: { nome: 'b' }, precos: {} },
  ],
  vencedores: {}, prePedidos: {}, pedidos: [],
});
// A realizou o pedido #301 com os 2 itens nas 2 lojas (snapshot do que o pedido levou)
const pedidoA = (c, itens) => {
  c.pedidos = [{ id: 301, codFornec: 10, fornecedor: 'FORN A', itens: 2, total: 230, lojas: [1, 2] }];
  c.prePedidos[10] = { status: 'realizado', pedidoId: 301, realizadoEm: '2026-10-27T19:00:00.000Z', itens: itens || { '111': { 1: 10, 2: 10 }, '222': { 1: 10, 2: 10 } } };
  return c;
};
// B envia a proposta depois, mais barato nos 2 itens
const bDepois = c => { const b = c.fornecedores[1]; b.status = 'finalizado'; b.finalizadoEm = '2026-10-28T02:41:32.179Z'; b.precos = { '111': { preco: 3 }, '222': { preco: 6 } }; return c; };

test('sem pedido realizado, o mais barato vence normalmente (B ganha os 2 itens)', () => {
  const c = bDepois(base()), cmp = comparativo(c);
  assert.deepEqual(cmp.itens.map(i => i.vencedor.codFornec), [20, 20]);
  assert.equal(cmp.itens[0].travado, false);
  assert.deepEqual(pendentesReais(c, cmp).map(f => f.codFornec), [20]);
});

test('pedido de A realizado e B chega depois mais barato: itens já comprados ficam com A, B não vira pendente e a cotação pode encerrar', () => {
  const c = bDepois(pedidoA(base())), cmp = comparativo(c);
  for (const it of cmp.itens) {
    assert.equal(it.vencedor.codFornec, 10, it.cod + ' continua com A');
    assert.equal(it.manual, false);
    assert.equal(it.travado, true);
    assert.equal(it.fechado, true, it.cod + ' está no pedido');
    assert.equal(it.pedidoId, 301);
    assert.deepEqual(it.por_loja, { 1: 10, 2: 10 });
    assert.deepEqual(it.lojas_fechadas, { 1: 301, 2: 301 });
    assert.equal(it.dividido, false);
    assert.equal(it.melhor.codFornec, 20, 'o menor preço continua visível');
    assert.deepEqual(it.menor_depois_pedido, { codFornec: 20, preco: it.cod === '111' ? 3 : 6 });
  }
  const fa = cmp.fornecedores.find(f => f.codFornec === 10), fb = cmp.fornecedores.find(f => f.codFornec === 20);
  assert.equal(fa.itens_vencedor, 2); assert.equal(fb.itens_vencedor, 0);
  assert.equal(fa.total_vencedor, 230); assert.equal(fb.total_vencedor, 0);
  assert.equal(cmp.resumo.total_vencedores, 230);
  assert.deepEqual(pendentesReais(c, cmp), []);
  assert.equal(podeEncerrar(c, cmp), true);
  const r = resumo(c); assert.equal(r.pode_encerrar, true); assert.equal(r.pendentes_reais, 0);
  const pp = prePedidos(c);
  assert.deepEqual(pp.fornecedores.map(f => [f.codFornec, f.status]), [[10, 'realizado']], 'B nem aparece nos pré-pedidos');
  assert.equal(pp.pendentes, 0);
});

test('B chega depois, mas um item ninguém tinha comprado: B ganha só esse e fica pendente por ele', () => {
  const c = bDepois(pedidoA(base(), { '111': { 1: 10, 2: 10 } }));   // o pedido de A levou só o ARROZ
  const cmp = comparativo(c), arroz = cmp.itens[0], feijao = cmp.itens[1];
  assert.equal(arroz.vencedor.codFornec, 10); assert.equal(arroz.fechado, true);
  assert.equal(feijao.vencedor.codFornec, 20); assert.equal(feijao.fechado, false); assert.equal(feijao.travado, false);
  assert.deepEqual(pendentesReais(c, cmp).map(f => f.codFornec), [20]);
  assert.equal(podeEncerrar(c, cmp), false);
  const pb = prePedidos(c).fornecedores.find(f => f.codFornec === 20);
  assert.deepEqual(pb.itens.map(i => i.cod), ['222']); assert.equal(pb.total, 120);
});

test('pedido de A levou só a loja 1 (loja 2 zerada): loja 1 fica com A, loja 2 vai pro B que chegou mais barato', () => {
  const c = bDepois(pedidoA(base(), { '111': { 1: 10 }, '222': { 1: 10 } }));
  const cmp = comparativo(c), arroz = cmp.itens[0];
  assert.deepEqual(arroz.por_loja, { 1: 10, 2: 20 });
  assert.deepEqual(arroz.lojas_fechadas, { 1: 301 });
  assert.equal(arroz.dividido, true);
  assert.equal(arroz.travado, true);
  assert.equal(arroz.vencedor.codFornec, 20, 'com lojas divididas o vencedor do item é o das lojas abertas');
  const pb = prePedidos(c).fornecedores.find(f => f.codFornec === 20);
  assert.deepEqual(pb.itens.map(i => [i.cod, i.lojas_qtd]), [['111', { 2: 10 }], ['222', { 2: 10 }]]);
  assert.deepEqual(pendentesReais(c, cmp).map(f => f.codFornec), [20]);
});

test('escolha manual pra B ou "não comprar" feita depois do pedido não tira o item de A', () => {
  const c = bDepois(pedidoA(base()));
  c.vencedores = { '111': 20, '222': null }; c.vencedores_loja = { '111': { 2: 20 } };
  const cmp = comparativo(c);
  assert.equal(cmp.itens[0].vencedor.codFornec, 10); assert.equal(cmp.itens[0].manual, false);
  assert.equal(cmp.itens[1].vencedor.codFornec, 10); assert.equal(cmp.itens[1].nao_comprar, false);
  assert.equal(cmp.resumo.nao_comprar, 0);
  assert.deepEqual(pendentesReais(c, cmp), []);
});

test('quem comprou ficou sem preço no item (dado estranho): não trava nem quebra, segue a regra normal', () => {
  const c = bDepois(pedidoA(base()));
  delete c.fornecedores[0].precos['222'];
  const cmp = comparativo(c);
  assert.equal(cmp.itens[0].vencedor.codFornec, 10);
  assert.equal(cmp.itens[1].vencedor.codFornec, 20); assert.equal(cmp.itens[1].travado, false);
});

test('cotação sem o snapshot (feita antes de 28/10): comportamento antigo até preencherItensPedidos rodar', () => {
  const c = bDepois(pedidoA(base())); delete c.prePedidos[10].itens;
  assert.deepEqual(comparativo(c).itens.map(i => i.vencedor.codFornec), [20, 20], 'sem snapshot, B ainda vira vencedor');
  const pedidos = { 301: { id: 301, itens: [{ cod: '111', lojas_qtd: { 1: 10, 2: 0 } }, { cod: '222', lojas_qtd: { 1: 10, 2: 10 } }, { cod: '333', lojas_qtd: { 1: 0 } }] } };
  assert.equal(preencherItensPedidos(c, id => pedidos[id], false), true);
  assert.deepEqual(c.prePedidos[10].itens, { '111': { 1: 10 }, '222': { 1: 10, 2: 10 } }, 'só loja com quantidade; item zerado fica de fora');
  assert.equal(c.prePedidos[10].itens_de, 'pedido');
  assert.equal(preencherItensPedidos(c, id => pedidos[id], false), false, 'segunda vez não muda nada');
  const cmp = comparativo(c);
  assert.deepEqual(cmp.itens[0].por_loja, { 1: 10, 2: 20 });
  assert.equal(cmp.itens[1].vencedor.codFornec, 10);
});

test('preencherItensPedidos: pedido que sumiu ou obterPedido que quebra não derruba', () => {
  const c = pedidoA(base()); delete c.prePedidos[10].itens;
  assert.equal(preencherItensPedidos(c, () => null, false), false);
  assert.equal(preencherItensPedidos(c, () => { throw new Error('x'); }, false), false);
  assert.equal(c.prePedidos[10].itens, undefined);
  assert.equal(preencherItensPedidos({ id: 1, pedidos: [] }, () => null, false), false);
});

test('itensRepetidos: mesmo item na mesma loja em dois pedidos realizados (compra repetida)', () => {
  const c = bDepois(pedidoA(base()));
  assert.deepEqual(itensRepetidos(c), []);
  c.pedidos.push({ id: 302, codFornec: 20, fornecedor: 'FORN B', itens: 1, total: 60, lojas: [1, 2] });
  c.prePedidos[20] = { status: 'realizado', pedidoId: 302, realizadoEm: '2026-10-28T17:08:36.567Z', itens: { '222': { 1: 10, 2: 10 }, '111': { 2: 5 } } };
  const rep = itensRepetidos(c);
  assert.deepEqual(rep.map(r => r.cod).sort(), ['111', '222']);
  const feijao = rep.find(r => r.cod === '222');
  assert.equal(feijao.descricao, 'FEIJAO');
  assert.deepEqual(Object.keys(feijao.lojas).sort(), ['1', '2']);
  assert.deepEqual(feijao.lojas[1].map(x => x.pedidoId), [301, 302]);
  // com os dois pedidos realizados, a loja fica com o pedido mais antigo
  const cmp = comparativo(c);
  assert.deepEqual(cmp.itens[1].por_loja, { 1: 10, 2: 10 });
});

// ── revisão adversarial de 28/10/26 ──
test('cotação com 6 lojas e item com quantidade só em 2 (caso normal da #4): tudo que tinha quantidade foi comprado por A → vencedor A, loja com 0 não é loja aberta, B sem pré-pedido', () => {
  const c = bDepois(pedidoA(base())); c.lojas = [1, 2, 3, 4, 5, 6];
  const cmp = comparativo(c);
  for (const it of cmp.itens) {
    assert.equal(it.vencedor.codFornec, 10, it.cod + ' é de quem comprou');
    assert.equal(it.fechado, true); assert.equal(it.pedidoId, 301); assert.equal(it.dividido, false); assert.equal(it.manual, false);
    assert.deepEqual(it.menor_depois_pedido, { codFornec: 20, preco: it.cod === '111' ? 3 : 6 });
    assert.deepEqual(it.por_loja, { 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10 }, 'loja sem quantidade segue o vencedor final, não o preço tardio');
  }
  const fb = cmp.fornecedores.find(f => f.codFornec === 20);
  assert.equal(fb.itens_vencedor, 0); assert.equal(fb.total_vencedor, 0);
  const pp = prePedidos(c);
  assert.deepEqual(pp.fornecedores.map(f => [f.codFornec, f.status]), [[10, 'realizado']], 'B não ganha card de pré-pedido fantasma');
  assert.equal(pp.pendentes, 0);
  assert.deepEqual(pendentesReais(c, cmp), []); assert.equal(podeEncerrar(c, cmp), true);
  // B também já com pedido (de outro item): o 🔒 continua apontando pro pedido de A, não pro de B
  c.pedidos.push({ id: 302, codFornec: 20, fornecedor: 'FORN B', itens: 1, total: 10, lojas: [3] });
  c.prePedidos[20] = { status: 'realizado', pedidoId: 302, realizadoEm: '2026-10-28T17:08:36.567Z', itens: { '999': { 3: 1 } } };
  const cmp2 = comparativo(c);
  assert.equal(cmp2.itens[0].vencedor.codFornec, 10); assert.equal(cmp2.itens[0].pedidoId, 301);
  assert.deepEqual(cmp2.itens[0].lojas_fechadas, { 1: 301, 2: 301, 3: 301, 4: 301, 5: 301, 6: 301 });
});

test('loja com 0 na cotação mas com quantidade digitada no pré-pedido de B conta como loja aberta: B fica com ela', () => {
  const c = bDepois(pedidoA(base())); c.lojas = [1, 2, 3];
  c.prePedidos[20] = { lojas_qtd: { '111': { 3: 5 } } };   // o(a) comprador(a) digitou 5 pra E3 no pré-pedido de B
  const cmp = comparativo(c), arroz = cmp.itens[0], feijao = cmp.itens[1];
  assert.deepEqual(arroz.por_loja, { 1: 10, 2: 10, 3: 20 }); assert.equal(arroz.vencedor.codFornec, 20); assert.equal(arroz.fechado, false); assert.equal(arroz.dividido, true);
  assert.deepEqual(feijao.por_loja, { 1: 10, 2: 10, 3: 10 }); assert.equal(feijao.vencedor.codFornec, 10); assert.equal(feijao.fechado, true);
  const pb = prePedidos(c).fornecedores.find(f => f.codFornec === 20);
  assert.deepEqual(pb.itens.map(i => [i.cod, i.lojas_qtd]), [['111', { 3: 5 }]]);
  assert.deepEqual(pendentesReais(c, cmp).map(f => f.codFornec), [20]);
});

test('item repartido entre dois pedidos realizados (A loja 1, B loja 2) e C mais barato depois: vencedor é quem comprou (pedido mais antigo), C fica de fora', () => {
  const c = pedidoA(base(), { '111': { 1: 10 }, '222': { 1: 10 } });
  const b = c.fornecedores[1]; b.status = 'finalizado'; b.precos = { '111': { preco: 4.5 }, '222': { preco: 8 } };
  c.pedidos.push({ id: 302, codFornec: 20, fornecedor: 'FORN B', itens: 2, total: 125, lojas: [2] });
  c.prePedidos[20] = { status: 'realizado', pedidoId: 302, realizadoEm: '2026-10-27T19:05:00.000Z', itens: { '111': { 2: 10 }, '222': { 2: 10 } } };
  c.fornecedores.push({ codFornec: 30, nome: 'FORN C (chegou depois)', status: 'finalizado', token: tok('c'), vendedor: { nome: 'c' }, precos: { '111': { preco: 3 }, '222': { preco: 6 } } });
  const cmp = comparativo(c), arroz = cmp.itens[0];
  assert.deepEqual(arroz.por_loja, { 1: 10, 2: 20 });
  assert.deepEqual(arroz.lojas_fechadas, { 1: 301, 2: 302 });
  assert.equal(arroz.vencedor.codFornec, 10, 'empate em lojas: o pedido mais antigo'); assert.equal(arroz.fechado, true); assert.equal(arroz.pedidoId, 301);
  assert.equal(arroz.dividido, true); assert.equal(arroz.manual, false);
  assert.deepEqual(arroz.menor_depois_pedido, { codFornec: 30, preco: 3 });
  const fc = cmp.fornecedores.find(f => f.codFornec === 30);
  assert.equal(fc.itens_vencedor, 0);
  assert.deepEqual(pendentesReais(c, cmp), []); assert.equal(podeEncerrar(c, cmp), true);
  assert.equal(prePedidos(c).fornecedores.some(f => f.codFornec === 30), false);
  // B comprou mais lojas que A → vencedor B
  c.prePedidos[20].itens['111'] = { 2: 10, 3: 4 }; c.lojas = [1, 2, 3]; c.itens[0].lojas_qtd[3] = 4;
  const a2 = comparativo(c).itens[0];
  assert.equal(a2.vencedor.codFornec, 20); assert.equal(a2.pedidoId, 302);
});

test('"não comprar" no item + loja aberta dada ao B por loja: vencedor segue a loja aberta (B), item não fica fechado', () => {
  const c = bDepois(pedidoA(base(), { '111': { 1: 10 }, '222': { 1: 10, 2: 10 } }));
  c.vencedores = { '111': null }; c.vencedores_loja = { '111': { 2: 20 } };
  const cmp = comparativo(c), arroz = cmp.itens[0];
  assert.deepEqual(arroz.por_loja, { 1: 10, 2: 20 });
  assert.equal(arroz.vencedor.codFornec, 20); assert.equal(arroz.fechado, false); assert.equal(arroz.pedidoId, null);
  assert.deepEqual(arroz.vencedores_loja, { 2: 20 }); assert.equal(arroz.dividido, true); assert.equal(arroz.nao_comprar, false);
  assert.deepEqual(pendentesReais(c, cmp).map(f => f.codFornec), [20]);
  // "não comprar" sem escolha por loja: a loja aberta fica sem fornecedor e o item é de A (fechado)
  delete c.vencedores_loja; const a2 = comparativo(c).itens[0];
  assert.deepEqual(a2.por_loja, { 1: 10, 2: null }); assert.equal(a2.vencedor.codFornec, 10); assert.equal(a2.fechado, true);
});

test('escolha por loja apontando pra loja travada não aparece em vencedores_loja nem marca o item como dividido', () => {
  const c = bDepois(pedidoA(base()));
  c.vencedores_loja = { '111': { 2: 20 }, '222': { 1: null } };
  const cmp = comparativo(c);
  for (const it of cmp.itens) { assert.deepEqual(it.vencedores_loja, {}); assert.equal(it.dividido, false); assert.deepEqual(it.por_loja, { 1: 10, 2: 10 }); }
});

// salvarPrecos/visaoVendedor/preencherTodas leem a cotação do disco: arquivo temporário em data/cotacoes (apagado no fim)
const DIR = process.env.COTACOES_DIR, TMP_IDS = [987654, 987655, 987656, 987657, 987658, 987659, 987660, 987661, 987662, 987663];
const gravaTmp = c => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, c.id + '.json'), JSON.stringify(c)); return c; };
const leTmp = id => JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8'));
const limpaTmp = () => { for (const id of TMP_IDS) for (const ext of ['.json', '.json.tmp']) { try { fs.unlinkSync(path.join(DIR, id + ext)); } catch (e) { /* nada */ } } };
test.after(() => { limpaTmp(); try { fs.rmdirSync(DIR); } catch (e) { /* nada */ } const PD = process.env.PORTAL_FORNECEDOR_DIR; try { for (const f of fs.readdirSync(PD)) fs.unlinkSync(path.join(PD, f)); fs.rmdirSync(PD); } catch (e) { /* nada */ } });

test('vendedor com pedido realizado não altera mais a proposta: salvarPrecos recusa, a página dele trava (pedido_realizado), e quem não tem pedido segue editando', () => {
  limpaTmp();
  const c = pedidoA(base()); c.id = 987654; c.prazo = '2099-12-31T23:59:00.000Z'; c.fornecedores[0].status = 'digitacao'; c.fornecedores[0].token = tok('e'); c.fornecedores[1].token = tok('f'); gravaTmp(c);
  const r = salvarPrecos(tok('e'), [{ cod: '222', preco: '' }]);
  assert.match(r.erro, /já realizou o pedido #301/);
  assert.equal(leTmp(987654).fornecedores[0].precos['222'].preco, 7.5, 'nada gravado');
  const v = visaoVendedor(porToken(tok('e')).c, porToken(tok('e')).f);
  assert.equal(v.fornecedor.pedido_realizado, 301);
  const rb = salvarPrecos(tok('f'), [{ cod: '222', preco: 6.9 }]);
  assert.equal(rb.erro, undefined); assert.equal(leTmp(987654).fornecedores[1].precos['222'].preco, 6.9);
  assert.equal(visaoVendedor(rb.c, rb.f).fornecedor.pedido_realizado, null);
  assert.equal(fs.existsSync(path.join(DIR, '987654.json.tmp')), false, 'gravação atômica não deixa .tmp');
});

test('preencherTodasItensPedidos: erro numa cotação não para as outras', () => {
  limpaTmp();
  const c1 = pedidoA(base()); c1.id = 987655; delete c1.prePedidos[10].itens; c1.fornecedores.forEach((f, k) => f.token = tok(String(k + 1))); gravaTmp(c1);
  const c2 = pedidoA(base()); c2.id = 987656; delete c2.prePedidos[10].itens; c2.fornecedores.forEach((f, k) => f.token = tok(String(k + 3))); gravaTmp(c2);
  const bomba = { id: 301, itens: [{ get cod() { throw new Error('boom'); } }] };
  let chamadas = 0;
  const r = preencherTodasItensPedidos(id => { chamadas++; return chamadas === 1 ? bomba : { id: 301, itens: [{ cod: '111', lojas_qtd: { 1: 10, 2: 10 } }] }; });
  assert.equal(r.preenchidas, 1);
  assert.equal(r.erros.length, 1); assert.match(r.erros[0].erro, /boom/);
  const ok = [987655, 987656].map(leTmp).find(x => x.prePedidos[10].itens);
  assert.deepEqual(ok.prePedidos[10].itens, { '111': { 1: 10, 2: 10 } });
  assert.deepEqual(TMP_IDS.filter(id => fs.existsSync(path.join(DIR, id + '.json.tmp'))), []);
});

test('LACUNA 1: comprador(a) não tira item/loja comprado de A depois do pedido (definirVencedor) nem negocia o preço tardio de B nele (negociarPreco)', () => {
  limpaTmp();
  const c = bDepois(pedidoA(base())); c.id = 987657; gravaTmp(c);
  for (const args of [['111', 20], ['111', 20, '2'], ['111', 'nao'], ['111', 'auto'], ['111', 'nao', '1']]) {
    const r = definirVencedor(987657, ...args); assert.match(r.erro || '', /já está no pedido #301/, 'definirVencedor ' + JSON.stringify(args) + ' tem que recusar');
  }
  assert.match(negociarPreco(987657, '111', 20, 2.5, 'x').erro || '', /já está no pedido #301/);
  assert.match(negociarPreco(987657, '111', 10, 3.9, 'x').erro || '', /já foi realizado/);
  const d = obter(987657); assert.deepEqual(d.vencedores, {}); assert.equal(d.vencedores_loja, undefined); assert.equal(d.negociados, undefined);
});

test('LACUNA 2: item parcialmente comprado (A loja 1): a loja aberta aceita escolha por loja (B / não comprar / auto) e negociação com B; o item inteiro não', () => {
  limpaTmp();
  const c = bDepois(pedidoA(base(), { '111': { 1: 10 }, '222': { 1: 10 } })); c.id = 987658; gravaTmp(c);
  assert.equal(definirVencedor(987658, '111', 20, '2').erro, undefined);
  assert.deepEqual(comparativo(obter(987658)).itens[0].por_loja, { 1: 10, 2: 20 });
  assert.equal(definirVencedor(987658, '111', 'nao', '2').erro, undefined);
  assert.deepEqual(comparativo(obter(987658)).itens[0].por_loja, { 1: 10, 2: null });
  assert.equal(definirVencedor(987658, '111', 'auto', '2').erro, undefined);
  assert.match(definirVencedor(987658, '111', 20).erro, /Na loja 1 este item já está no pedido #301/);
  assert.equal(negociarPreco(987658, '111', 20, 2.5, 'x').erro, undefined);
  assert.equal(comparativo(obter(987658)).itens[0].precos[20].preco, 2.5);
});

test('LACUNA 3: dois pedidos (A loja 1, B loja 2) + loja 3 aberta com quantidade: C mais barato fica só com a loja 3 e é o único pendente', () => {
  const c = pedidoA(base(), { '111': { 1: 10 }, '222': { 1: 10 } }); c.lojas = [1, 2, 3]; c.itens[0].lojas_qtd[3] = 7; c.itens[1].lojas_qtd[3] = 7;
  const b = c.fornecedores[1]; b.status = 'finalizado'; b.precos = { '111': { preco: 4.5 }, '222': { preco: 8 } };
  c.pedidos.push({ id: 302, codFornec: 20, fornecedor: 'FORN B', itens: 2, total: 125, lojas: [2] });
  c.prePedidos[20] = { status: 'realizado', pedidoId: 302, realizadoEm: '2026-10-27T19:05:00.000Z', itens: { '111': { 2: 10 }, '222': { 2: 10 } } };
  c.fornecedores.push({ codFornec: 30, nome: 'FORN C', status: 'finalizado', token: tok('c'), vendedor: { nome: 'c' }, precos: { '111': { preco: 3 }, '222': { preco: 6 } } });
  const cmp = comparativo(c), arroz = cmp.itens[0];
  assert.deepEqual(arroz.por_loja, { 1: 10, 2: 20, 3: 30 }); assert.deepEqual(arroz.lojas_fechadas, { 1: 301, 2: 302 });
  assert.equal(arroz.vencedor.codFornec, 30); assert.equal(arroz.fechado, false); assert.equal(arroz.travado, true);
  assert.deepEqual(pendentesReais(c, cmp).map(f => f.codFornec), [30]); assert.equal(podeEncerrar(c, cmp), false);
  const pc = prePedidos(c).fornecedores.find(f => f.codFornec === 30);
  assert.deepEqual(pc.itens.map(i => [i.cod, i.lojas_qtd]), [['111', { 3: 7 }], ['222', { 3: 7 }]]); assert.equal(pc.total, 63);
});

// 2ª rodada (28/10/26): em #4/#5 o preço conta sem enviar e o pedido saía com o vendedor ainda em digitação. Recusar TUDO em
// salvarPrecos deixava o vendedor preso: a rota /finalizar chama salvarPrecos antes, a página escondia o Enviar e o(a) comprador(a)
// seguia cobrando "Digitou N · não enviou" (⏰ Lembrar, push do portal). Pedido realizado = proposta aceita.
test('vendedor em digitação com pedido realizado: salvar igual passa, mudar preço/obs/condição recusa, cadastro entra sem mexer na condição, Enviar proposta conclui e o(a) comprador(a) para de cobrar', () => {
  limpaTmp();
  const c = pedidoA(base()); c.id = 987659; c.so_respondido = false; c.prazo = '2099-12-31T23:59:00.000Z';
  const a = c.fornecedores[0]; a.status = 'digitacao'; a.token = tok('e'); a.condicao = 'Boleto 28 dias'; a.abertoEm = '2026-10-27T10:00:00.000Z'; a.cadastro_vendedor = { email: 'a@a.com', prazo_pagamento: 28, prazo_entrega: 2, pedido_minimo: 100, em: '2026-10-27T10:00:00.000Z' };
  c.fornecedores[1].token = tok('f'); gravaTmp(c);
  // lado do(a) comprador(a), antes de qualquer envio: pedido realizado = proposta aceita
  const r0 = resumo(obter(987659)); assert.equal(r0.nao_enviados, 0); assert.equal(r0.responderam, 1); assert.equal(r0.empresas_responderam, 1);
  assert.equal(prePedidos(obter(987659)).fornecedores.find(p => p.codFornec === 10).proposta.aceita_no_pedido, 301);
  // o que a rota /finalizar manda antes de finalizar (itens vazios) e o autosave da página que ficou aberta (mesmo preço): passam sem regravar
  const antes = leTmp(987659).fornecedores[0].atualizadoEm;
  assert.equal(salvarPrecos(tok('e'), [], { condicao: 'Boleto 28 dias', obs: '' }).erro, undefined);
  assert.equal(salvarPrecos(tok('e'), [{ cod: '111', preco: '4,00' }, { cod: '222', preco: 7.5 }], { condicao: 'Boleto 28 dias' }).erro, undefined);
  assert.equal(leTmp(987659).fornecedores[0].atualizadoEm, antes, 'nada mudou: não regrava');
  // mudar qualquer coisa da proposta: recusa e não grava
  assert.match(salvarPrecos(tok('e'), [{ cod: '111', preco: 3.9 }]).erro, /já realizou o pedido #301/);
  assert.match(salvarPrecos(tok('e'), [{ cod: '111', preco: 4, obs: 'cx fechada' }]).erro, /já realizou o pedido #301/);
  assert.match(salvarPrecos(tok('e'), [{ cod: '222', preco: '' }]).erro, /já realizou o pedido #301/);
  assert.match(salvarPrecos(tok('e'), [], { condicao: 'Boleto 14 dias' }).erro, /já realizou o pedido #301/);
  assert.match(salvarPrecos(tok('e'), [], { obs: 'entrega só terça' }).erro, /já realizou o pedido #301/);
  assert.deepEqual(leTmp(987659).fornecedores[0].precos, { '111': { preco: 4 }, '222': { preco: 7.5 } });
  // bloco de cadastro entra (dado do vendedor), mas condição/mínimo/entrega desta cotação não mudam
  assert.equal(salvarPrecos(tok('e'), [], { cadastro: { email: 'novo@a.com', prazo_pagamento: 14, prazo_entrega: 5, pedido_minimo: 900 } }).erro, undefined);
  const d1 = leTmp(987659).fornecedores[0];
  assert.equal(d1.cadastro_vendedor.email, 'novo@a.com'); assert.equal(d1.cadastro_vendedor.prazo_pagamento, 14);
  assert.equal(d1.condicao, 'Boleto 28 dias'); assert.equal(d1.faturamento_minimo, undefined); assert.equal(d1.prazo_entrega, undefined);
  // Enviar proposta (rota: salvarPrecos + finalizar) conclui
  const rf = finalizar(tok('e'), 'Ana'); assert.equal(rf.erro, undefined);
  assert.equal(leTmp(987659).fornecedores[0].status, 'finalizado');
  assert.equal(resumo(obter(987659)).responderam, 1);
  assert.equal(prePedidos(obter(987659)).fornecedores.find(p => p.codFornec === 10).proposta.aceita_no_pedido, null);
  assert.equal(fs.existsSync(path.join(DIR, '987659.json.tmp')), false);
});

// 2ª rodada (28/10/26): realizarPedido/fechar liam a cotação, esperavam criar o pedido (segundos: Pedidos de Compra + ERP de teste) e
// gravavam a cópia velha — duas chamadas na mesma cotação apagavam o pedido uma da outra (sumia de c.pedidos, sem trava, pedido de novo).
test('realizarPedido em paralelo (2ª aba / duplo clique) e preço salvo pelo vendedor no meio: um de cada vez por cotação, nada se perde, nada repete', async () => {
  limpaTmp();
  const c = bDepois(base()); c.id = 987660; c.so_respondido = false; c.prazo = '2099-12-31T23:59:00.000Z';
  c.fornecedores[0].token = tok('e'); c.fornecedores[1].token = tok('f');
  c.fornecedores.push({ codFornec: 30, nome: 'FORN C', status: 'digitacao', token: tok('1'), vendedor: { nome: 'c' }, precos: { '111': { preco: 9 } } });
  c.vencedores = { '111': 10, '222': 20 };   // A leva o arroz, B o feijão
  gravaTmp(c);
  let seq = 300, salvouNoMeio = false; const criados = [];
  const criar = async (f, itens) => {
    if (f.codFornec === 10 && !salvouNoMeio) { salvouNoMeio = true; assert.equal(salvarPrecos(tok('1'), [{ cod: '222', preco: 5 }]).erro, undefined); }   // autosave do vendedor C na janela do await de A
    await new Promise(r => setTimeout(r, 30));
    const p = { id: ++seq, codFornec: f.codFornec, fornecedor: f.nome, itens: itens.length, total: 0, lojas: [1, 2] }; criados.push(p); return p;
  };
  const [ra, ra2, rb] = await Promise.all([realizarPedido(987660, 10, 'x', criar), realizarPedido(987660, 10, 'x', criar), realizarPedido(987660, 20, 'x', criar)]);   // A, 2º clique em A, B
  assert.equal(ra.erro, undefined); assert.equal(rb.erro, undefined); assert.match(ra2.erro, /já realizado/);
  assert.equal(criados.length, 2, 'duplo clique em A não cria 2º pedido');
  const d = obter(987660);
  assert.deepEqual(d.pedidos.map(p => [p.id, p.codFornec]), [[301, 10], [302, 20]]);
  assert.equal(d.prePedidos[10].status, 'realizado'); assert.deepEqual(d.prePedidos[10].itens, { '111': { 1: 10, 2: 10 } });
  assert.equal(d.prePedidos[20].status, 'realizado'); assert.deepEqual(d.prePedidos[20].itens, { '222': { 1: 10, 2: 10 } });
  assert.equal(d.fornecedores[2].precos['222'].preco, 5, 'preço que o vendedor salvou na janela não se perde');
  assert.equal(d.status, 'fechada', 'todos com pedido: fechou sozinha');
  assert.deepEqual([...fornecedoresRealizados(d).keys()].sort(), [10, 20]);
});

test('Fechar cotação disparado com um Realizar Pedido em voo: espera, vê o pedido que saiu e gera só o que falta', async () => {
  limpaTmp();
  const c = bDepois(base()); c.id = 987661; c.so_respondido = false; c.vencedores = { '111': 10, '222': 20 }; gravaTmp(c);
  let seq = 400; const criados = [];
  const criar = async (f, itens) => { await new Promise(r => setTimeout(r, 30)); const p = { id: ++seq, codFornec: f.codFornec, fornecedor: f.nome, itens: itens.length, total: 0, lojas: [1, 2] }; criados.push(p); return p; };
  const [ra, rf] = await Promise.all([realizarPedido(987661, 10, 'x', criar), fechar(987661, 'x', criar)]);
  assert.equal(ra.erro, undefined); assert.equal(rf.erro, undefined); assert.equal(rf.status, 'fechada');
  assert.deepEqual(criados.map(p => p.codFornec), [10, 20], 'A não sai duas vezes');
  assert.deepEqual(obter(987661).pedidos.map(p => [p.id, p.codFornec]), [[401, 10], [402, 20]]);
});

test('fechar: se o 2º pedido falhar, o 1º fica gravado na cotação (não some, não repete), ela segue aberta e o próximo Fechar gera só o que falta', async () => {
  limpaTmp();
  const c = bDepois(base()); c.id = 987662; c.so_respondido = false; c.vencedores = { '111': 10, '222': 20 }; gravaTmp(c);
  let seq = 500, n = 0; const criados = [];
  const criar = async (f, itens) => { n++; if (n === 2) throw new Error('ERP fora'); const p = { id: ++seq, codFornec: f.codFornec, fornecedor: f.nome, itens: itens.length, total: 0, lojas: [1, 2] }; criados.push(p); return p; };
  await assert.rejects(fechar(987662, 'x', criar), /ERP fora/);
  const d = obter(987662); assert.equal(d.status, 'aberta'); assert.deepEqual(d.pedidos.map(p => p.id), [501]);
  assert.equal(d.prePedidos[10].status, 'realizado'); assert.deepEqual(d.prePedidos[10].itens, { '111': { 1: 10, 2: 10 } });
  assert.deepEqual(pendentesReais(d, comparativo(d)).map(f => f.codFornec), [20]);
  const r2 = await fechar(987662, 'x', criar); assert.equal(r2.erro, undefined); assert.equal(r2.status, 'fechada');
  assert.deepEqual(r2.pedidos.map(p => [p.id, p.codFornec]), [[501, 10], [502, 20]]); assert.equal(criados.length, 2);
});

test('salvar: se o .tmp não grava (disco cheio), o arquivo real fica intacto e o erro sobe; se só o rename falha, grava direto', () => {
  limpaTmp();
  const c = base(); c.id = 987663; gravaTmp(c);
  const wf = fs.writeFileSync, rn = fs.renameSync;
  fs.writeFileSync = function (p, ...a) { if (String(p).endsWith('.tmp')) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return wf.call(fs, p, ...a); };
  try { assert.throws(() => marcarTeste(987663), /ENOSPC/); } finally { fs.writeFileSync = wf; }
  assert.equal(leTmp(987663).teste, undefined, 'arquivo real como estava'); assert.equal(fs.existsSync(path.join(DIR, '987663.json.tmp')), false);
  fs.renameSync = function () { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
  try { assert.equal(marcarTeste(987663).teste, true); } finally { fs.renameSync = rn; }
  assert.equal(leTmp(987663).teste, true, 'rename falhou: gravou direto'); assert.equal(fs.existsSync(path.join(DIR, '987663.json.tmp')), false);
});

test('portal: vendedor com pedido realizado não recebe lembrete de prazo nem reenvio de "nova cotação", e o card dele mostra o pedido', async () => {
  limpaTmp();
  const portal = require('../lib/portal-fornecedor'), PDIR = process.env.PORTAL_FORNECEDOR_DIR;
  const d = new Date(Date.now() + 90 * 60 * 1000), pad = n => String(n).padStart(2, '0');
  const prazo = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());   // daqui a 1h30 (janela do lembrete = 2 h)
  const c = pedidoA(base()); c.id = 987659; c.so_respondido = false; c.prazo = prazo;
  const a = c.fornecedores[0]; a.status = 'digitacao'; a.token = tok('e'); a.vendedor = { nome: 'Ana', whats: '81999990001' }; a.abertoEm = '2026-10-27T10:00:00.000Z';
  const b = c.fornecedores[1]; b.status = 'digitacao'; b.token = tok('f'); b.vendedor = { nome: 'Beto', whats: '81999990002' }; b.abertoEm = '2026-10-27T10:00:00.000Z'; b.precos = { '111': { preco: 5 } };
  gravaTmp(c);
  const vend = (w, t) => ({ id: w, nome: 'V' + w, whats: w, email: w + '@x.com', senha: 'hash', token: tok(t), empresas: [], dispositivos: [{ endpoint: 'https://push.exemplo/' + w, keys: { p256dh: 'x', auth: 'y' }, criadoEm: '2026-10-20T00:00:00.000Z' }], criadoEm: '2026-10-20T00:00:00.000Z' });
  fs.mkdirSync(PDIR, { recursive: true });
  fs.writeFileSync(path.join(PDIR, 'vendedores.json'), JSON.stringify({ '81999990001': vend('81999990001', '2'), '81999990002': vend('81999990002', '3') }));
  const pushes = [];
  portal.init({ cotacao: require('../lib/cotacao'), pedidosFornec: { listar: () => [], obter: () => null }, lerCotForn: () => ({}), log: () => {}, webpush: { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), setVapidDetails() {}, sendNotification: async (sub, corpo) => { pushes.push(JSON.parse(corpo)); } } });
  const r = await portal.lembretesPrazo();
  assert.equal(r.enviados, 1, 'só o Beto (sem pedido) recebe'); assert.equal(pushes.length, 1); assert.match(pushes[0].url, new RegExp(tok('f')));
  const rn = await portal.avisarNovaCotacao(obter(987659), { reenvio: true });
  assert.deepEqual(rn.detalhes.map(x => x.codFornec), [20]);
  const card = portal.resumoVendedor(tok('2')).cotacoes_abertas.find(x => x.id === 987659);
  assert.equal(card.pedido_realizado, 301); assert.equal(card.f_status, 'digitacao');
  assert.equal(portal.resumoVendedor(tok('3')).cotacoes_abertas.find(x => x.id === 987659).pedido_realizado, null);
});
