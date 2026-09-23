const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { criarEscreverERP } = require('../lib/escrever-erp');
const L = require('../lib/log-erp');

// Conexão falsa: responde por padrão e registra tudo que recebeu.
function conexaoFake(respostas = {}) {
  const chamadas = [];
  return {
    chamadas,
    conn: {
      beginTransaction: async () => chamadas.push('BEGIN'),
      commit: async () => chamadas.push('COMMIT'),
      rollback: async () => chamadas.push('ROLLBACK'),
      end: async () => chamadas.push('END'),
      query: async (sql, params) => {
        chamadas.push([sql, params]);
        if (sql.startsWith('SELECT COUNT')) return [[{ n: respostas.count ?? 1 }]];
        if (sql.startsWith('SELECT')) return [respostas.selects.shift() || []];
        if (respostas.erroNoWrite) throw new Error('boom');
        return [{ affectedRows: respostas.afetados ?? 1, insertId: 0 }];
      },
    },
  };
}

function montar(opts = {}, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrever-'));
  const fake = conexaoFake(opts);
  const escrever = criarEscreverERP({
    config: { host: cfg.host || '127.0.0.1', port: 3306, user: 'root', password: 'x' },
    criarConexao: async () => { fake.aberta = true; return fake.conn; },
    dirLog: dir,
    agora: () => new Date(2026, 8, 23, 14, 5, 11),
  });
  return { dir, fake, escrever };
}

const base = { usuario: 'Tiago', motivo: 'teste do log', banco: 'central', tabela: 'estoquen1', operacao: 'update', where: { CodigoBarra: '789' }, valores: { Qtd: 5 } };

test('update ok: transação, antes/depois e entrada ok no log', async () => {
  const { dir, fake, escrever } = montar({ selects: [[{ CodigoBarra: '789', Qtd: '3' }], [{ CodigoBarra: '789', Qtd: '5' }]] });
  const r = await escrever(base);
  assert.equal(r.ok, true); assert.equal(r.status, 'ok'); assert.equal(r.afetados, 1);
  assert.deepEqual(fake.chamadas.filter(c => typeof c === 'string'), ['BEGIN', 'COMMIT', 'END']);
  const e = L.porId(dir, r.id);
  assert.equal(e.status, 'ok'); assert.equal(e.usuario, 'Tiago'); assert.equal(e.servidor, 'teste-254'); assert.equal(e.host, '127.0.0.1');
  assert.deepEqual(e.antes, [{ CodigoBarra: '789', Qtd: '3' }]); assert.deepEqual(e.depois, [{ CodigoBarra: '789', Qtd: '5' }]);
  assert.deepEqual(e.colunas_mudadas, ['Qtd']);
  assert.equal(e.sql, 'UPDATE `central`.`estoquen1` SET `Qtd` = ? WHERE `CodigoBarra` = ?');
  assert.equal(e.quando, L.agoraIso(new Date(2026, 8, 23, 14, 5, 11)));
});

test('erro no UPDATE: rollback e entrada erro', async () => {
  const { dir, fake, escrever } = montar({ selects: [[{ Qtd: '3' }]], erroNoWrite: true });
  const r = await escrever(base);
  assert.equal(r.ok, false); assert.equal(r.status, 'erro'); assert.match(r.erro, /boom/);
  assert.deepEqual(fake.chamadas.filter(c => typeof c === 'string'), ['BEGIN', 'ROLLBACK', 'END']);
  assert.equal(L.porId(dir, r.id).status, 'erro');
});

test('host .252 é recusado sem abrir conexão', async () => {
  const { dir, fake, escrever } = montar({ selects: [] }, { host: '192.168.2.252' });
  const r = await escrever(base);
  assert.equal(r.ok, false); assert.equal(r.status, 'recusado'); assert.match(r.erro, /252/);
  assert.equal(fake.aberta, undefined);
  assert.equal(L.porId(dir, r.id).status, 'recusado');
});

test('acima do limite é recusado antes de escrever', async () => {
  const { fake, escrever } = montar({ count: 501, selects: [] });
  const r = await escrever(base);
  assert.equal(r.status, 'recusado'); assert.match(r.erro, /501/);
  assert.ok(!fake.chamadas.some(c => Array.isArray(c) && c[0].startsWith('UPDATE')));
  assert.deepEqual(fake.chamadas.filter(c => typeof c === 'string'), ['BEGIN', 'ROLLBACK', 'END']);
});

test('motivo curto, usuário ausente e where inválido são recusados e logados', async () => {
  const { dir, fake, escrever } = montar({ selects: [] });
  const a = await escrever({ ...base, motivo: 'oi' });
  const b = await escrever({ ...base, usuario: '' });
  const c = await escrever({ ...base, where: {} });
  for (const r of [a, b, c]) { assert.equal(r.status, 'recusado'); assert.equal(L.porId(dir, r.id).status, 'recusado'); }
  assert.match(a.erro, /motivo/); assert.match(b.erro, /usu/); assert.match(c.erro, /where/);
  assert.equal(fake.aberta, undefined);
});

test('insert: sem select antes, sem insertId fica sem depois', async () => {
  const { dir, escrever } = montar({ selects: [] });
  const r = await escrever({ usuario: 'Tiago', motivo: 'inserir teste', banco: 'central', tabela: 't', operacao: 'insert', valores: { a: 1 } });
  assert.equal(r.status, 'ok');
  const e = L.porId(dir, r.id);
  assert.deepEqual(e.antes, []); assert.deepEqual(e.depois, []);
});

test('falha ao conectar vira erro com mensagem do MySQL de teste', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrever-'));
  const escrever = criarEscreverERP({ config: { host: '127.0.0.1' }, criarConexao: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }, dirLog: dir });
  const r = await escrever(base);
  assert.equal(r.status, 'erro'); assert.match(r.erro, /MySQL de teste do \.254 não respondeu/);
});
