const test = require('node:test'); const assert = require('node:assert/strict');
const fiscal = require('../lib/fiscal');

// 18/11/26, CD, NF 1068 Servbem: entrada no Dlinks em 16/11 (conferência 188714) e bipada no nosso coletor em 18/11.
// A janela de ±1 dia da entrada não achava a conferência e o Fiscal mostrava o coletor "—".
// acharConf(row, perto, longe): `longe` = conferências de fora da janela curta — só casam pela chave da NF-e,
// ou por nº da nota + loja + fornecedor juntos.
const CHAVE = '26261159853094000194550010000010681000088364';
const row = (extra = {}) => ({ nReg: 188714, loja: 10, codFornec: 2211, notas: [{ nNota: 1068, chave: CHAVE }], itens: [], ...extra });
const conf = (extra = {}) => ({ id: '2026-11-18-10-aceac261ec', loja: 10, nNota: '1068', codFornec: 2211, chave: CHAVE, status: 'terminada', itens: {}, erp: { nReg: 182392, erros: [] }, ...extra });

test('conferência bipada dias depois da entrada casa pela chave da NF-e', () => {
  assert.equal(fiscal.acharConf(row(), [], [conf()]).id, '2026-11-18-10-aceac261ec');
});

test('sem a lista de fora da janela nada muda (chamada antiga com 2 argumentos)', () => {
  assert.equal(fiscal.acharConf(row(), []), null);
  assert.equal(fiscal.acharConf(row(), [conf()]).id, '2026-11-18-10-aceac261ec');
});

test('fora da janela o nReg do ERP de teste NÃO casa (sequência diferente da produção)', () => {
  const outra = conf({ id: '2026-11-18-10-bbbbbbbbbb', chave: 'B'.repeat(44), nNota: '777', erp: { nReg: 188714, erros: [] } });
  assert.equal(fiscal.acharConf(row(), [], [outra]), null);
});

test('fora da janela, sem chave na linha: nº da nota + loja só casa com o mesmo fornecedor', () => {
  const semChave = row({ notas: [{ nNota: 1068, chave: null }] });
  assert.equal(fiscal.acharConf(semChave, [], [conf({ codFornec: 999 })]), null, 'mesma NF de outro fornecedor não casa');
  assert.equal(fiscal.acharConf(semChave, [], [conf({ loja: 3 })]), null, 'outra loja não casa');
  assert.equal(fiscal.acharConf(semChave, [], [conf()]).id, '2026-11-18-10-aceac261ec');
  assert.equal(fiscal.acharConf(row({ codFornec: null, notas: [{ nNota: 1068, chave: null }] }), [], [conf({ codFornec: 0 })]), null, 'sem fornecedor dos dois lados não casa');
});

test('a conferência da janela curta continua ganhando no casamento por nº da nota', () => {
  const semChave = row({ notas: [{ nNota: 1068, chave: null }] });
  const perto = conf({ id: '2026-11-16-10-cccccccccc', chave: null, erp: { nReg: null, erros: [] } });
  assert.equal(fiscal.acharConf(semChave, [perto], [conf()]).id, perto.id);
});
