// test/tv-televendas.test.js — config da TV do televendas da CAHU, cruzamento ERP × catálogo do app e sequência de slides (25/09/2026)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../lib/tv-televendas');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-televendas-'));

test('config padrão nasce com token de 32 hex e é persistida', () => {
  m.init({ q: async () => [], dataDir: DIR });
  const c = m.getConfig();
  assert.match(c.token, /^[a-f0-9]{32}$/);
  assert.equal(c.modo, 'individual');
  assert.equal(c.tema, 'escuro');
  assert.equal(c.soComFoto, true);
  assert.ok(fs.existsSync(path.join(DIR, 'tv-televendas.json')));
});

test('salvarConfig valida limites e listas', () => {
  const c = m.salvarConfig({ modo: 'grade', tema: 'amarelo', segundos: 8, appCada: 4, destaques: ['7891000359836', 123, 'abc'], app: { titulo: 'Oi', qrUrl: '' } }, 'tiago');
  assert.equal(c.modo, 'grade'); assert.equal(c.tema, 'amarelo'); assert.equal(c.segundos, 8); assert.equal(c.appCada, 4);
  assert.deepEqual(c.destaques, ['7891000359836', '123']);
  assert.equal(c.app.titulo, 'Oi');
  assert.equal(c.app.chamadas.length, 3);          // padrão mantido quando não vem
  assert.throws(() => m.salvarConfig({ modo: 'x' }), /modo/i);
  assert.throws(() => m.salvarConfig({ segundos: 1 }), /segundos/i);
  assert.throws(() => m.salvarConfig({ app: { qrUrl: 'ftp://x' } }), /https/i);
});

test('novoToken invalida o anterior', () => {
  const antes = m.getConfig().token;
  const depois = m.novoToken().token;
  assert.notEqual(antes, depois);
  assert.equal(m.tokenValido(antes), false);
  assert.equal(m.tokenValido(depois), true);
});

const ERP = [
  { codigobarra: '111', descricao: 'ACHOC LIQ NESCAU 180ML CX27', preco: '39.54', Qtd: 10 },
  { codigobarra: '222', descricao: 'AGUA SANITARIA X 1L CX12', preco: '21.21', Qtd: 3 },
  { codigobarra: '333', descricao: 'SEM FOTO NO APP CX6', preco: '5.00', Qtd: 1 },
];
const CAT = new Map([
  ['111', { nome: 'Nescau', categoria: 'Mercearia', unidade: 'CX', qtdEmbalagem: 27, imagem: 'https://x/1.jpg' }],
  ['222', { nome: 'Agua', categoria: 'Limpeza', unidade: 'CX', qtdEmbalagem: 12, imagem: 'https://x/2.jpg' }],
]);

test('cruzar junta ERP com catálogo, respeita soComFoto e marca destaques', () => {
  const com = m.cruzar(ERP, CAT, { soComFoto: true, destaques: ['222'] });
  assert.deepEqual(com.map(p => p.ean), ['111', '222']);
  assert.equal(com[0].preco, 39.54); assert.equal(com[0].qtdEmbalagem, 27); assert.equal(com[0].imagem, 'https://x/1.jpg');
  assert.equal(com[0].nome, 'ACHOC LIQ NESCAU 180ML CX27');   // nome é o do ERP
  assert.equal(com[1].destaque, true); assert.equal(com[0].destaque, false);
  const sem = m.cruzar(ERP, CAT, { soComFoto: false, destaques: [] });
  assert.equal(sem.length, 3);
  const s = sem.find(p => p.ean === '333');
  assert.equal(s.imagem, null); assert.equal(s.unidade, 'CX'); assert.equal(s.qtdEmbalagem, 1);
});

test('cruzar ignora estoque zerado e ordena por descrição', () => {
  const r = m.cruzar([{ ...ERP[1] }, { ...ERP[0] }, { ...ERP[0], codigobarra: '999', Qtd: 0 }], CAT, { soComFoto: false, destaques: [] });
  assert.deepEqual(r.map(p => p.ean), ['111', '222']);
});

const prods = n => Array.from({ length: n }, (_, i) => ({ ean: String(i), nome: 'P' + i, preco: 1, destaque: i % 10 === 0 }));

test('sequência individual: tela do app a cada N', () => {
  const s = m.montarSequencia(prods(12), { modo: 'individual', appCada: 5 });
  assert.deepEqual(s.map(x => x.t), ['prod', 'prod', 'prod', 'prod', 'prod', 'app', 'prod', 'prod', 'prod', 'prod', 'prod', 'app', 'prod', 'prod']);
});

test('sequência grade: páginas de 8 e app a cada N páginas', () => {
  const s = m.montarSequencia(prods(20), { modo: 'grade', appCada: 2 });
  assert.deepEqual(s.map(x => x.t), ['grade', 'grade', 'app', 'grade']);
  assert.equal(s[0].itens.length, 8); assert.equal(s[3].itens.length, 4); assert.equal(s[3].pagina, 3); assert.equal(s[3].paginas, 3);
});

test('sequência misto: destaque a cada 2 páginas, sem destaques vira grade', () => {
  const s = m.montarSequencia(prods(40), { modo: 'misto', appCada: 50 });
  assert.deepEqual(s.map(x => x.t), ['grade', 'grade', 'destaque', 'grade', 'grade', 'destaque', 'grade']);
  assert.equal(s[2].item.ean, '0'); assert.equal(s[5].item.ean, '10');
  const semD = m.montarSequencia(prods(40).map(p => ({ ...p, destaque: false })), { modo: 'misto', appCada: 50 });
  assert.deepEqual(semD.map(x => x.t), ['grade', 'grade', 'grade', 'grade', 'grade']);
});

test('sequência sem produtos mostra só a tela do app', () => {
  assert.deepEqual(m.montarSequencia([], { modo: 'individual', appCada: 5 }).map(x => x.t), ['app']);
});

test('carregarProdutos usa cache e cai no último resultado se o ERP falhar', async () => {
  let chamadas = 0;
  m.init({ q: async () => { chamadas++; if (chamadas > 1) throw new Error('ERP fora'); return ERP; }, dataDir: DIR, fetchCatalogo: async () => CAT, cacheMs: 0 });
  m.salvarConfig({ soComFoto: true, destaques: [] });
  const a = await m.carregarProdutos();
  assert.equal(a.length, 2);
  const b = await m.carregarProdutos();       // ERP falha → último cache
  assert.equal(b.length, 2);
  assert.equal(chamadas, 2);
});

test('carregarProdutos sem cache e ERP fora propaga o erro', async () => {
  m.init({ q: async () => { throw new Error('ERP fora'); }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tv-tv2-')), fetchCatalogo: async () => CAT, cacheMs: 0 });
  await assert.rejects(m.carregarProdutos(), /ERP fora/);
});

test('catálogo do app: mapa por ean e sku a partir das páginas da API', () => {
  const paginas = [[{ ean: '111', sku: 'S1', nome: 'N', categoria: 'C', unidade_venda: 'CX', qtd_por_embalagem: '27.000', imagens: [{ url: 'u1' }] }], []];
  let i = 0;
  return m.baixarCatalogo(async () => paginas[i++]).then(cat => {
    assert.equal(cat.get('111').imagem, 'u1'); assert.equal(cat.get('S1').qtdEmbalagem, 27); assert.equal(i, 1);   // página com menos de 20 é a última
  });
});
