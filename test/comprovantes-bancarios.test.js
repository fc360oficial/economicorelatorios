'use strict';
const test = require('node:test'), assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cb-'));
const GP = require('../lib/gestao-pessoas');
const D = require('../lib/comprovantes-bancarios-demo');

// Trava da demonstração: enquanto a Fase C não for aprovada, o módulo só pode conter dado fictício e nenhuma ação de pagamento.
test('demonstração só tem nomes e identificadores fictícios', () => {
  for (const p of D.PAGAMENTOS) { assert.match(p.nome, /Exemplo|Fictício/); assert.match(p.idf, /^DEMO-/); assert.match(p.cpf, /^\*\*\*\.\d{3}\.\d{3}-\*\*$/); if (p.idBanco) assert.match(p.idBanco, /^DEMO-/); }
  for (const g of D.GUIAS) assert.match(g.numero, /^DEMO-/);
});
test('sem confirmação bancária não existe comprovante nem situação liquidada', () => {
  for (const p of D.PAGAMENTOS) {
    if (p.situacao === 'liquidado') { assert.deepStrictEqual(p.cadeia, ['ok', 'ok', 'ok', 'ok'], p.id); assert.ok(p.efetiva, p.id); }
    if (['agendado', 'enviado', 'processamento', 'aguardando_envio'].includes(p.situacao)) { assert.strictEqual(p.efetiva, null, p.id); assert.ok(!p.docs.some(d => d.classe === 'oficial' || d.classe === 'importado'), p.id); }
  }
});
test('lote confere com o total do banco e guia coletiva não vira valor individual', () => {
  for (const l of D.LOTES) { const m = D.PAGAMENTOS.filter(p => p.lote === l.id); assert.strictEqual(m.length, l.qtdBanco); assert.strictEqual(+m.reduce((a, p) => a + p.valor, 0).toFixed(2), l.total); assert.strictEqual(m.filter(p => p.situacao === 'liquidado').length, l.identificados); }
  for (const g of D.GUIAS.filter(x => x.coletiva)) for (const t of g.demonstrativo) assert.ok(t.valor < g.valor, g.id);
});
test('os 16 cenários apontam para registros que existem', () => {
  assert.strictEqual(D.HOMOLOGACAO.length, 16);
  const ids = new Set([...D.PAGAMENTOS.map(p => p.id), ...D.GUIAS.map(g => g.id), ...D.LOTES.map(l => l.id), 'Perfil CPD']);
  for (const [, , r] of D.HOMOLOGACAO) assert.ok(ids.has(r), r);
  for (const a of D.PENDENCIAS) assert.ok(D.ALERTAS[a.alerta], a.id);
  assert.strictEqual(new Set(D.PENDENCIAS.map(a => a.alerta)).size, Object.keys(D.ALERTAS).length, 'todo alerta da seção 12 tem exemplo');
});
test('ninguém executa pagamento e RH não vê extrato', () => {
  const linha = t => D.PERMISSOES.find(r => r[0] === t).slice(1);
  assert.deepStrictEqual(linha('Executar, agendar ou alterar pagamento'), [0, 0, 0, 0, 0]);
  assert.deepStrictEqual(linha('Saldo e extrato geral'), [0, 0, 0, 0, 0]);
  for (const r of D.PERMISSOES) assert.strictEqual(r[5], 0, 'CPD: ' + r[0]);
});

test('rotas: CPD leva 403 no servidor, POST é recusado e Coordenação recebe a demonstração', async () => {
  const express = require('express'); const montar = require('../lib/comprovantes-bancarios-rotas');
  GP.salvarConfig({ designados: [{ usuario: 'c.user', papeis: ['coordenacao'], lojas: [] }, { usuario: 'p.user', papeis: ['cpd'], lojas: [1] }, { usuario: 'r.user', papeis: ['rh_doc'], lojas: [] }] }, { usuario: 'admin', perfil: 'admin' });
  const app = express(); app.use((req, res, next) => { const u = req.headers['x-u']; req.session = u ? { user: { usuario: u, nome: 'Teste Exemplo', perfil: 'usuario' } } : {}; next(); }); montar(app);
  const srv = app.listen(0); const url = 'http://127.0.0.1:' + srv.address().port + '/api/comprovantes-bancarios/demo';
  try {
    const st = async (u, m) => (await fetch(url, { method: m || 'GET', headers: u ? { 'x-u': u } : {} })).status;
    assert.strictEqual(await st(null), 401); assert.strictEqual(await st('p.user'), 403); assert.strictEqual(await st('sem.papel'), 403);
    assert.strictEqual(await st('c.user'), 200); assert.strictEqual(await st('r.user'), 200); assert.strictEqual(await st('c.user', 'POST'), 405);
  } finally { srv.close(); }
});
