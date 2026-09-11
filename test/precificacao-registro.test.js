const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const pr = require('../lib/precificacao');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precif-'));
pr.init({ dir });

// ERP falso: responde pelas 3 consultas (itens/preço, custo, margem). Preço/margem de atacado
// (loja 4) variam por parâmetro: "a4 AS A" no SQL de itens, e params[0]===4 no de margens.
let desativados = new Set();    // códigos que o ERP devolve com CodDesativado != 0
let margemB = null;             // margem varejo do item B (null = sem cadastro → bloqueado)
const qFake = async (sql, params) => {
  const des = c => (desativados.has(c) ? 1 : 0);
  if (/FROM central\.itens /.test(sql)) {
    if (/a4 AS A/.test(sql)) return [{ CodigoBarra: 'A', P: '12,99', A: '11,50', CodDesativado: des('A') }, { CodigoBarra: 'B', P: '5,00', A: '0', CodDesativado: des('B') }];
    return [{ CodigoBarra: 'A', P: '12,99', A: '0', CodDesativado: des('A') }, { CodigoBarra: 'B', P: '5,00', A: '0', CodDesativado: des('B') }];
  }
  if (/FROM central\.custoloja/.test(sql)) return [{ CodigoBarra: 'A', Custo: '10' }, { CodigoBarra: 'B', Custo: '4' }];
  if (/FROM central\.itens_margens/.test(sql)) {
    const b = margemB != null ? [{ CodigoBarra: 'B', MargemVarejo: margemB, MargemAtacado: null }] : [];
    if (params && params[0] === 4) return [{ CodigoBarra: 'A', MargemVarejo: 30, MargemAtacado: 10 }, ...b];
    return [{ CodigoBarra: 'A', MargemVarejo: 30, MargemAtacado: null }, ...b];
  }
  return [];
};
const radarOk = { curvaASet: () => new Set(['A']) };
pr.initERP(qFake, radarOk);

const pedido = {
  id: 40, lista: 7, lista_nome: 'LISTA X', fornecedor: 'FORN', teste: true,
  itens: [{ cod: 'A', descricao: 'ARROZ' }, { cod: 'B', descricao: 'FEIJAO' }, { cod: 'C', descricao: 'FALTOU' }],
  xml: { lojas: { 2: {
    status: 'conciliado', conferidoEm: '2026-09-11T10:00:00.000Z',
    notas: [{ chave: 'k1', valorProduto: 200, desconto: 0, frete: 10, ipi: 0, st: 10 }],
    itens: [
      { cod: 'A', descricao: 'ARROZ', recebida: 10, tipo: 'ok', preco_xml: 11 },
      { cod: 'B', descricao: 'FEIJAO', recebida: 5, tipo: 'ok', preco_xml: 4.5, preco_status: 'maior', decisao: { acao: 'recusar' } },
      { cod: 'C', descricao: 'FALTOU', recebida: 0, tipo: 'falta', preco_xml: null }
    ],
    nao_pedidos: [{ cod: 'D', descricao: 'EXTRA', recebida: 2, preco_xml: 3, decisao: { acao: 'aceitar' } }]
  } } }
};

test('criarDeConciliacao monta entradas, rateia impostos e calcula', async () => {
  const reg = await pr.criarDeConciliacao(pedido, 2);
  assert.equal(reg.id, '40-L2'); assert.equal(reg.loja, 2); assert.equal(reg.status, 'a_precificar');
  assert.equal(reg.rateio.fator, 0.1);                 // (10+0+10−0)/200
  const cods = reg.entradas.map(e => e.cod).sort();
  assert.deepEqual(cods, ['A', 'D']);                  // B recusado, C faltou
  const a = reg.itens.find(i => i.cod === 'A');
  assert.equal(a.custo_novo, 11); assert.equal(a.custo_imposto, 12.1); assert.equal(a.custo_atual, 10);
  assert.equal(a.preco_atual, 12.99); assert.equal(a.margem, 30); assert.equal(a.curvaA, true);
  assert.equal(a.status, 'sobe'); assert.equal(a.preco_sugerido, 15.79);   // 12.1×1.3=15.73 → 15.79
  const d = reg.itens.find(i => i.cod === 'D');
  assert.equal(d.status, 'bloqueado'); assert.match(d.motivo, /não casado/);
  assert.equal(reg.resumo.mudam, 1);
});

test('criarDeConciliacao é idempotente', async () => {
  const again = await pr.criarDeConciliacao(pedido, 2);
  assert.equal(again.id, '40-L2');
  assert.equal(pr.listar().length, 1);
});

test('sem valorProduto → rateio indisponível, custo_imposto = custo_novo', async () => {
  const p2 = JSON.parse(JSON.stringify(pedido)); p2.id = 41; p2.xml.lojas[2].notas = [{ chave: 'k2' }];
  const reg = await pr.criarDeConciliacao(p2, 2);
  assert.equal(reg.rateio.disponivel, false);
  assert.equal(reg.itens.find(i => i.cod === 'A').custo_imposto, 11);
});

test('editarItem marca manual e respeita piso', () => {
  const r1 = pr.editarItem('40-L2', 'A', { preco_final: 16.49 }, 'tiago');
  const a = r1.itens.find(i => i.cod === 'A');
  assert.equal(a.preco_final, 16.49); assert.equal(a.manual, true);
  const err = pr.editarItem('40-L2', 'A', { preco_final: 1 }, 'tiago');
  assert.match(err.erro, /abaixo do custo/);
});

test('setParametros recalcula preservando manual', async () => {
  const r = await pr.setParametros('40-L2', { arredondamento: '5' }, 'tiago');
  assert.equal(r.parametros.arredondamento, '5');
  assert.equal(r.itens.find(i => i.cod === 'A').preco_final, 16.49);
});

test('fechar exige resolver bloqueados, aplicar exige precificado', () => {
  assert.match(pr.fechar('40-L2', 'tiago').erro, /bloqueado/);
  const r = pr.fechar('40-L2', 'tiago', { ignorarBloqueados: true });
  assert.equal(r.status, 'precificado');
  assert.match(pr.editarItem('40-L2', 'A', { preco_final: 17 }, 'x').erro, /fechado/);
  assert.equal(pr.aplicar('40-L2', 'tiago').status, 'aplicado');
  assert.equal(pr.reabrir('40-L2', 'tiago').status, 'a_precificar');
  pr.fechar('40-L2', 'tiago', { ignorarBloqueados: true }); pr.aplicar('40-L2', 'tiago');
});

test('verificar lê o ERP e marca divergência', async () => {
  const r = await pr.verificar('40-L2');   // qFake devolve P=12,99 pra A, e o final é 16.49 → divergente
  assert.equal(r.status, 'conferido');
  assert.equal(r.itens.find(i => i.cod === 'A').erp.ok, false);
  assert.equal(r.divergentes, 1);
  const t = await pr.verificarTodos();
  assert.equal(t.verificados, 1);
});

test('reabrir limpa erp de todos os itens', () => {
  const r = pr.reabrir('40-L2', 'tiago');
  assert.equal(r.status, 'a_precificar');
  assert.equal(r.aplicadoEm, undefined);
  assert.equal(r.divergentes, undefined);
  for (const i of r.itens) assert.equal(Object.prototype.hasOwnProperty.call(i, 'erp'), false);
});

// pedido de loja 4: mesmos itens da loja 2, mas com preço/margem de atacado próprios
const pedido4 = {
  id: 42, lista: 7, lista_nome: 'LISTA X', fornecedor: 'FORN', teste: true,
  itens: [{ cod: 'A', descricao: 'ARROZ' }],
  xml: { lojas: { 4: {
    status: 'conciliado', conferidoEm: '2026-09-11T10:00:00.000Z',
    notas: [{ chave: 'k4' }],   // sem valorProduto: rateio indisponível, custo_imposto = custo_novo = 10
    itens: [{ cod: 'A', descricao: 'ARROZ', recebida: 10, tipo: 'ok', preco_xml: 10 }],
    nao_pedidos: []
  } } }
};

test('verificar detecta divergência de atacado (loja 4) e reabrir corrige', async () => {
  const reg = await pr.criarDeConciliacao(pedido4, 4);
  assert.equal(reg.id, '42-L4');
  const a0 = reg.itens.find(i => i.cod === 'A');
  assert.ok(a0.atacado, 'margem_atacado=10 na loja 4 deveria gerar item.atacado');

  // varejo bate com o ERP (P4=12,99); atacado diverge de propósito (ERP a4=11,50)
  pr.editarItem('42-L4', 'A', { preco_final: 12.99 }, 'tiago');
  pr.editarItem('42-L4', 'A', { preco_atacado_final: 13.99 }, 'tiago');
  pr.fechar('42-L4', 'tiago', { ignorarBloqueados: true });
  pr.aplicar('42-L4', 'tiago');
  const v1 = await pr.verificar('42-L4');
  const i1 = v1.itens.find(i => i.cod === 'A');
  assert.equal(i1.erp.ok, false);
  assert.equal(i1.erp.atacado, 11.5);
  assert.equal(v1.divergentes, 1);

  // corrige o atacado pra bater com o ERP → sem divergência
  pr.reabrir('42-L4', 'tiago');
  pr.editarItem('42-L4', 'A', { preco_final: 12.99 }, 'tiago');
  pr.editarItem('42-L4', 'A', { preco_atacado_final: 11.5 }, 'tiago');
  pr.fechar('42-L4', 'tiago', { ignorarBloqueados: true });
  pr.aplicar('42-L4', 'tiago');
  const v2 = await pr.verificar('42-L4');
  const i2 = v2.itens.find(i => i.cod === 'A');
  assert.equal(i2.erp.ok, true);
  assert.equal(v2.divergentes, 0);
});

test('verificarTodos ignora registros aplicados há mais de 7 dias', async () => {
  const antes = pr.obter('42-L4');
  const verificadoEmAntes = antes.verificadoEm;
  antes.aplicadoEm = new Date(Date.now() - 8 * 86400000).toISOString();   // fora da janela de 7 dias
  pr.salvar(antes);

  const esperados = pr.listar().filter(x =>
    ['aplicado', 'conferido'].includes(x.status) &&
    x.aplicadoEm && new Date(x.aplicadoEm).getTime() >= Date.now() - 7 * 86400000
  ).length;

  const t = await pr.verificarTodos();
  assert.equal(t.verificados, esperados);

  const depois = pr.obter('42-L4');
  assert.equal(depois.verificadoEm, verificadoEmAntes);   // não foi tocado
});


// ── revisão final ────────────────────────────────────────────────────────────

test('obter/caminhoPdf rejeitam id com path traversal', () => {
  const fora = path.join(dir, '..', 'usuarios-precif-teste.json');
  fs.writeFileSync(fora, JSON.stringify({ segredo: 'hash bcrypt' }));
  try {
    assert.equal(pr.obter('../usuarios-precif-teste'), null);   // não pode sair do diretório
  } finally { try { fs.unlinkSync(fora); } catch (e) {} }
  assert.equal(pr.obter('../../usuarios'), null);
  assert.equal(pr.obter('..%2F..%2Fusuarios'), null);
  assert.equal(pr.obter(String.raw`..\..\usuarios`), null);
  assert.equal(pr.obter('40-L2/../../usuarios'), null);
  assert.equal(pr.caminhoPdf('../../usuarios'), null);
  assert.equal(pr.obter('40-L2').id, '40-L2');     // id legítimo continua funcionando
  assert.ok(pr.listar().length > 0);               // listar() deriva ids de nomes de arquivo
});

test('salvar invalida o PDF em cache', () => {
  const pdf = path.join(dir, '40-L2.pdf');
  fs.writeFileSync(pdf, 'pdf velho');
  assert.equal(pr.caminhoPdf('40-L2'), pdf);
  pr.salvar(pr.obter('40-L2'));
  assert.equal(pr.caminhoPdf('40-L2'), null);
});

// pedido 44: item com unidade não convertida (caixa/fardo) e não-pedido idem
const pedido44 = {
  id: 44, lista: 7, lista_nome: 'LISTA U', fornecedor: 'FORN', teste: true,
  itens: [{ cod: 'A', descricao: 'ARROZ' }],
  xml: { lojas: { 2: {
    status: 'conciliado', conferidoEm: '2026-09-11T10:00:00.000Z',
    notas: [{ chave: 'k44' }],
    itens: [{ cod: 'A', descricao: 'ARROZ', recebida: 10, tipo: 'ok', preco_xml: 11, conferir_unidade: true }],
    nao_pedidos: [
      { cod: 'B', descricao: 'FEIJAO', recebida: 4, preco_xml: 4, decisao: { acao: 'aceitar' }, xml: [{ conversao: 'conferir' }] },
      { cod: 'A', descricao: 'ARROZ EXTRA', recebida: 1, preco_xml: 11, decisao: { acao: 'aceitar' } }
    ]
  } } }
};

test('unidade não convertida bloqueia o item', async () => {
  const reg = await pr.criarDeConciliacao(pedido44, 2);
  const a = reg.itens.find(i => i.cod === 'A');
  assert.equal(a.status, 'bloqueado');
  assert.match(a.motivo, /unidade/i);
  const b = reg.itens.find(i => i.cod === 'B');
  assert.equal(b.status, 'bloqueado');
  assert.match(b.motivo, /unidade/i);
});

test('itensConciliados: não-pedido sem xml não é bloqueado por unidade', () => {
  const saida = pr.itensConciliados({ itens: [], nao_pedidos: [{ cod: 'Z', descricao: 'Z', recebida: 1, preco_xml: 2, decisao: { acao: 'aceitar' } }] });
  assert.equal(saida[0].motivo_bloqueio, undefined);
});

test('CodDesativado != 0 bloqueia o item', async () => {
  desativados = new Set(['A']);
  try {
    const p = JSON.parse(JSON.stringify(pedido)); p.id = 46;
    const reg = await pr.criarDeConciliacao(p, 2);
    const a = reg.itens.find(i => i.cod === 'A');
    assert.equal(a.status, 'bloqueado');
    assert.match(a.motivo, /desativado/i);
  } finally { desativados = new Set(); }
});

test('radar sem base: curva_disponivel false e nenhum item vira curva A', async () => {
  pr.initERP(qFake, { curvaASet: () => null });
  try {
    const p = JSON.parse(JSON.stringify(pedido)); p.id = 45;
    const reg = await pr.criarDeConciliacao(p, 2);
    assert.equal(reg.curva_disponivel, false);
    assert.equal(reg.entradas.find(e => e.cod === 'A').curvaA, false);
  } finally { pr.initERP(qFake, radarOk); }
  const p2 = JSON.parse(JSON.stringify(pedido)); p2.id = 47;
  const reg2 = await pr.criarDeConciliacao(p2, 2);
  assert.equal(reg2.curva_disponivel, true);
  assert.equal(reg2.entradas.find(e => e.cod === 'A').curvaA, true);
});

test('recalcular doERP: item sai de bloqueado quando a margem é cadastrada, e edição manual sobrevive', async () => {
  const p = JSON.parse(JSON.stringify(pedido)); p.id = 48;
  p.xml.lojas[2].itens[1].decisao = { acao: 'aceitar' };   // B entra (antes era recusado)
  const reg = await pr.criarDeConciliacao(p, 2);
  const b0 = reg.itens.find(i => i.cod === 'B');
  assert.equal(b0.status, 'bloqueado');
  assert.match(b0.motivo, /margem/i);

  pr.editarItem('48-L2', 'A', { preco_final: 16.49 }, 'tiago');

  margemB = 20;
  try {
    const r2 = await pr.recalcular('48-L2', { doERP: true });
    const b = r2.itens.find(i => i.cod === 'B');
    assert.notEqual(b.status, 'bloqueado');
    assert.equal(b.margem, 20);
    assert.ok(b.preco_sugerido > 0);
    const a = r2.itens.find(i => i.cod === 'A');
    assert.equal(a.preco_final, 16.49);      // custo_imposto igual → manual sobrevive
    assert.equal(a.manual, true);
  } finally { margemB = null; }
});
