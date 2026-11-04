'use strict';
const test = require('node:test'), assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cb-'));
process.env.COMPROVANTES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
const GP = require('../lib/gestao-pessoas');
const CB = require('../lib/comprovantes-bancarios');

test('sem dado fictício: base nasce vazia e o catálogo é consistente', () => {
  const d = CB.dados();
  for (const k of ['PAGAMENTOS', 'GUIAS', 'LOTES', 'LOTES_GUIA', 'PENDENCIAS', 'AUDITORIA']) assert.deepStrictEqual(d[k], [], k);
  assert.ok(!JSON.stringify(d).match(/Exemplo|Fictíci|DEMO-/), 'nenhum nome ou identificador fictício');
  assert.strictEqual(d.HOMOLOGACAO.length, 16); assert.strictEqual(new Set(d.ALERTAS_GUIA.flatMap(a => a.k)).size, 8);
  for (const a of d.ALERTAS_GUIA) for (const k of a.k) assert.ok(d.ALERTAS[k], k);
  assert.match(d.HOJE, /^\d{4}-\d{2}-\d{2}$/);
});
test('base real é lida quando existe', () => {
  fs.writeFileSync(path.join(process.env.COMPROVANTES_DIR, 'guias.json'), JSON.stringify([{ id: 'GU-0001', tipo: 'fgts_mensal' }]));
  assert.strictEqual(CB.dados().GUIAS.length, 1); fs.unlinkSync(path.join(process.env.COMPROVANTES_DIR, 'guias.json'));
});
test('ninguém executa pagamento, RH não vê extrato e CPD não vê nada', () => {
  const linha = t => CB.PERMISSOES.find(r => r[0] === t).slice(1);
  assert.deepStrictEqual(linha('Executar, agendar ou alterar pagamento'), [0, 0, 0, 0, 0]);
  assert.deepStrictEqual(linha('Saldo e extrato geral'), [0, 0, 0, 0, 0]);
  for (const r of CB.PERMISSOES) assert.strictEqual(r[5], 0, 'CPD: ' + r[0]);
});
test('rotas: CPD leva 403 no servidor, POST é recusado e Coordenação recebe os dados', async () => {
  const express = require('express'); const montar = require('../lib/comprovantes-bancarios-rotas');
  GP.salvarConfig({ designados: [{ usuario: 'c.user', papeis: ['coordenacao'], lojas: [] }, { usuario: 'p.user', papeis: ['cpd'], lojas: [1] }, { usuario: 'r.user', papeis: ['rh_doc'], lojas: [] }] }, { usuario: 'admin', perfil: 'admin' });
  const app = express(); app.use((req, res, next) => { const u = req.headers['x-u']; req.session = u ? { user: { usuario: u, nome: 'Teste', perfil: 'usuario' } } : {}; next(); }); montar(app);
  const srv = app.listen(0); const url = 'http://127.0.0.1:' + srv.address().port + '/api/comprovantes-bancarios/dados';
  try {
    const st = async (u, m) => (await fetch(url, { method: m || 'GET', headers: u ? { 'x-u': u } : {} })).status;
    assert.strictEqual(await st(null), 401); assert.strictEqual(await st('p.user'), 403); assert.strictEqual(await st('sem.papel'), 403);
    assert.strictEqual(await st('c.user'), 200); assert.strictEqual(await st('r.user'), 200); assert.strictEqual(await st('c.user', 'POST'), 405);
  } finally { srv.close(); }
});
