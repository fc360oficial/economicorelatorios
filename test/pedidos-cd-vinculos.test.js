// test/pedidos-cd-vinculos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-'));
cd.init({ q: async () => [], mesDB: m => String(m).padStart(2, '0'), dataDir: dir });

test('config default e salvar parcial', () => {
  assert.equal(cd.getConfig().teto, 28);
  assert.equal(cd.getConfig().clientesLoja[1], 828);
  cd.salvarConfig({ teto: 21 });
  assert.equal(cd.getConfig().teto, 21);
  assert.equal(cd.getConfig().ciclo, 7);
});

test('salvarConfig rejeita entrada inválida', () => {
  assert.throws(() => cd.salvarConfig({ teto: 'x' }), /teto/);
  assert.throws(() => cd.salvarConfig({ clientesLoja: { 1: 0 } }), /loja 1/);
});

test('sincronizarVinculos: igual, dun14 sugerido, pendente; não sobrescreve confirmado', () => {
  const v = cd.sincronizarVinculos([
    { codigoCD: '7897395040727', unPorCaixa: null, unidadeExiste: null },
    { codigoCD: '17896037913143', unPorCaixa: 12, unidadeExiste: '7896037913146' },
    { codigoCD: '17509546679171', unPorCaixa: 72, unidadeExiste: null }
  ]);
  assert.equal(v['7897395040727'].status, 'confirmado'); assert.equal(v['7897395040727'].origem, 'igual'); assert.equal(v['7897395040727'].unPorCaixa, 1);
  assert.equal(v['17896037913143'].status, 'sugerido'); assert.equal(v['17896037913143'].candidato, '7896037913146'); assert.equal(v['17896037913143'].unPorCaixa, 12);
  assert.equal(v['17509546679171'].status, 'pendente');
  cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 'tiago' });
  const v2 = cd.sincronizarVinculos([{ codigoCD: '17896037913143', unPorCaixa: 24, unidadeExiste: '7896037913146' }]);
  assert.equal(v2['17896037913143'].status, 'confirmado');
  assert.equal(v2['17896037913143'].unPorCaixa, 12);   // manual vence o cadastro
  assert.equal(v2['17896037913143'].origem, 'dun14');   // candidato aceito mantém a origem
});

test('salvarVinculo valida', () => {
  assert.throws(() => cd.salvarVinculo({ codigoCD: '1', unidade: '', unPorCaixa: 12 }), /unidade/);
  assert.throws(() => cd.salvarVinculo({ codigoCD: '1', unidade: '2', unPorCaixa: 0 }), /un\/cx/);
  cd.salvarVinculo({ codigoCD: '17509546679171', unidade: '7509546679174', unPorCaixa: 72, usuario: 'tiago' });
  assert.equal(cd.getVinculos()['17509546679171'].origem, 'manual');
  cd.removerVinculo('17509546679171');
  assert.equal(cd.getVinculos()['17509546679171'].status, 'pendente');
  assert.equal(cd.getVinculos()['17509546679171'].unidade, null);
});

test('salvarVinculo/removerVinculo rejeitam codigoCD malicioso (path traversal)', () => {
  assert.throws(() => cd.salvarVinculo({ codigoCD: '__proto__', unidade: '1', unPorCaixa: 1 }), /codigoCD/);
  assert.throws(() => cd.removerVinculo('../../etc/passwd'), /codigoCD/);
});

test('sincronizarVinculos: candidato pela descrição vira sugerido com origem descricao; alternativas ficam guardadas', () => {
  const v = cd.sincronizarVinculos([
    { codigoCD: '47896006711245', unPorCaixa: 10, unidadeExiste: null, candidatoDescricao: '7896006711100', alternativas: [{ cod: '7896006711100', descricao: 'POP ARROZ 1KG BRANCO' }] },
    { codigoCD: '17896029046767', unPorCaixa: 40, unidadeExiste: null, candidatoDescricao: null, alternativas: [{ cod: '7896029046609', descricao: 'WHISKAS POUCH ADULTO 85G CARNE' }, { cod: '7896029046623', descricao: 'WHISKAS POUCH CASTRADOS 85G CARNE' }] },
    { codigoCD: '17896037913143', unPorCaixa: 12, unidadeExiste: '7896037913146', candidatoDescricao: '7896037913122' }
  ]);
  assert.equal(v['47896006711245'].status, 'sugerido'); assert.equal(v['47896006711245'].origem, 'descricao'); assert.equal(v['47896006711245'].candidato, '7896006711100');
  assert.equal(v['17896029046767'].status, 'pendente'); assert.equal(v['17896029046767'].alternativas.length, 2);
  assert.equal(v['17896037913143'].origem, 'dun14'); assert.equal(v['17896037913143'].candidato, '7896037913146'); // código de barras vence a descrição
  const c = cd.salvarVinculo({ codigoCD: '47896006711245', unidade: '7896006711100', unPorCaixa: 10, usuario: 'tiago' });
  assert.equal(c.origem, 'descricao'); assert.equal(c.status, 'confirmado');
  const r = cd.removerVinculo('47896006711245');
  assert.equal(r.status, 'sugerido'); assert.equal(r.origem, 'descricao');
  const m = cd.salvarVinculo({ codigoCD: '17896029046767', unidade: '7896029046609', unPorCaixa: 40 });
  assert.equal(m.origem, 'manual');
});

test('sincronizarVinculos guarda a descrição da unidade candidata (dun14 e descricao)', () => {
  const v = cd.sincronizarVinculos([
    { codigoCD: '17896221600156', unPorCaixa: 12, unidadeExiste: '7896221600159', descricaoUnidadeExiste: 'CLORITO AGUA SANITARIA 1L' },
    { codigoCD: '47896006711245', unPorCaixa: 10, unidadeExiste: null, candidatoDescricao: '7896006711100', alternativas: [{ cod: '7896006711100', descricao: 'POP ARROZ 1KG BRANCO' }] }
  ]);
  assert.equal(v['17896221600156'].descricaoCandidato, 'CLORITO AGUA SANITARIA 1L');
  assert.equal(v['47896006711245'].descricaoCandidato, 'POP ARROZ 1KG BRANCO');
});

test('coletarCD: emb_multipla=0 conta o estoque do CD em fardos; =1 em unidades; caixa de 14 dígitos sempre em caixas', async () => {
  const fake = async (sql) => {
    if (sql.includes('estoquen10')) return [
      { cod: '7896012303115', Qtd: 300, descricao: 'ARROZ PARB EMOCOES 1KG FD10', qtdemb: 0 },
      { cod: '7891150097575', Qtd: 379, descricao: 'ALA LAVA ROUPAS EM PO 400G COCO', qtdemb: 1 },
      { cod: '17896221600156', Qtd: 1825, descricao: 'AGUA SANITARIA CLORITO 1L CX12', qtdemb: 0 },
      { cod: '039800014009', Qtd: 1800, descricao: 'ENERGIZER PILHA AAA2', qtdemb: 1 }];
    if (sql.includes('embalagempadrao_venda')) return [
      { cod: '7896012303115', qv: 10, em: 0 }, { cod: '7891150097575', qv: 27, em: 1 }, { cod: '17896221600156', qv: 12, em: 0 }];
    if (sql.includes('FROM central.itens WHERE CodDesativado=0 AND CodigoBarra IN')) return [{ cod: '7896221600159', descricao: 'CLORITO AGUA SANITARIA 1L' }];
    if (sql.includes('custoloja10')) return [{ cod: '17896221600156', Custo: 19.08 }, { cod: '7891150097575', Custo: 2.18 }, { cod: '7896012303115', Custo: 44 }];
    return [];
  };
  const cdm = require('../lib/pedidos-cd');
  cdm.init({ q: fake, mesDB: m => String(m).padStart(2, '0'), dataDir: dir });
  const r = await cdm.coletarCD();
  assert.equal(r['7896012303115'].estoqueCx, 300); assert.equal(r['7896012303115'].estoqueUn, null); assert.equal(r['7896012303115'].unPorCaixaCadastro, 10); assert.equal(r['7896012303115'].estoqueEm, 'cx');
  assert.equal(r['7891150097575'].estoqueCx, 14); assert.equal(r['7891150097575'].estoqueUn, 379); assert.equal(r['7891150097575'].estoqueEm, 'un');
  assert.equal(r['17896221600156'].estoqueCx, 1825); assert.equal(r['17896221600156'].unPorCaixaCadastro, 12);
  assert.equal(r['039800014009'].estoqueCx, 1800); assert.equal(r['039800014009'].estoqueEm, 'un');   // sem Itens App: unidades, un/cx 1
  // custo do CD por caixa: caixa/fardo usa o custo direto; unidade multiplica pelo un/cx
  assert.equal(r['17896221600156'].custoCDcx, 19.08); assert.equal(r['7896012303115'].custoCDcx, 44); assert.equal(r['7891150097575'].custoCDcx, 58.86); assert.equal(r['039800014009'].custoCDcx, 0);
  cdm.init({ q: async () => [], mesDB: m => String(m).padStart(2, '0'), dataDir: dir });
});
