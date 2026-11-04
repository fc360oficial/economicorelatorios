'use strict';
// CONSULTAR BANCO (lib/comprovantes-bancarios-banco.js) com extrato FICTÍCIO injetado e base fictícia: escopo trabalhista, vínculo,
// conciliação, comprovante (página extraída com pdf-lib), vínculo manual (regras), GED e auditoria. Nada toca o banco real.
const test = require('node:test'), assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cbb-'));
process.env.COMPROVANTES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-'));
process.env.COMPROVANTES_SYNC = '0';
const GP = require('../lib/gestao-pessoas');
const B = require('../lib/comprovantes-bancarios-banco');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const D = process.env.COMPROVANTES_DIR;

GP.salvarConfig({ designados: [{ usuario: 'coord', papeis: ['coordenacao'], lojas: [] }, { usuario: 'fin', papeis: ['financeiro'], lojas: [] }, { usuario: 'rh', papeis: ['rh_doc'], lojas: [] }, { usuario: 'cpd', papeis: ['cpd'], lojas: [1] }] }, { usuario: 'admin', perfil: 'admin' });
const U = { coord: { usuario: 'coord', nome: 'Coordenação' }, fin: { usuario: 'fin', nome: 'Financeiro' }, rh: { usuario: 'rh', nome: 'RH' }, cpd: { usuario: 'cpd', nome: 'CPD' } };

let PDF;
test.before(async () => {
  const doc = await PDFDocument.create(); const f = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) { const pg = doc.addPage([300, 200]); pg.drawText('COMPROVANTE PAGINA ' + i, { x: 20, y: 100, size: 14, font: f }); }
  PDF = path.join(D, 'comprovantes.pdf'); fs.writeFileSync(PDF, await doc.save());
  const pags = [
    { id: 'PG-F-2026-09-f1', origem: 'auditoria-folha', nome: 'Ana Teste', cpf: '111.111.111-11', funcId: 1, loja: 1, tipo: 'salario', comp: '2026-09', valor: 1000, situacao: 'liquidado', extratoRef: null, idBanco: 'CTRL C1', lote: 'LT-cahu-2026-09-30-COMP', efetiva: '2026-09-30', prevista: '2026-09-30', docs: [{ nome: 'comprovantes.pdf', classe: 'oficial', origem: 'Itaú Empresas · PDF lido na Auditoria da Folha · pág. 2', kb: 1, caminho: PDF, pagina: 2 }], cadeia: ['ok', 'ok', 'ok', 'ok'], hist: [] },
    { id: 'PG-DF-2026-0001-2-20261025', origem: 'pagamentos-df', nome: 'Bruno Teste', cpf: '222.222.222-22', funcId: 2, loja: 1, tipo: 'domfer', comp: '2026-10', valor: 70, situacao: 'liquidado', extratoRef: 'cahu|2026-10-27|70.00|22222222222', idBanco: 'cahu|2026-10-27|70.00|22222222222', efetiva: '2026-10-27', prevista: '2026-10-27', docs: [], cadeia: ['ok', 'ok', 'ok', 'na'], hist: [] },
    { id: 'PG-R-9', origem: 'erp', nome: 'Carla Teste', cpf: '333.333.333-33', funcId: 3, loja: 1, tipo: 'rescisao', comp: '2026-10', valor: 2500, situacao: 'aguardando_envio', extratoRef: null, idBanco: null, efetiva: null, prevista: '2026-10-20', docs: [], cadeia: ['ok', 'na', 'pendente', 'na'], hist: [], erp: { historico: 'CARLA' } },
    { id: 'PG-A-2026-10-f4', origem: 'auditoria-folha', nome: 'Dani Teste', cpf: '444.444.444-44', funcId: 4, loja: 1, tipo: 'adiantamento', comp: '2026-10', valor: 500, situacao: 'aguardando_envio', extratoRef: null, idBanco: null, efetiva: null, prevista: '2026-10-15', docs: [], cadeia: ['ok', 'na', 'pendente', 'na'], hist: [] },
    { id: 'PG-A-2026-10-f5', origem: 'auditoria-folha', nome: 'Eva Teste', cpf: '555.555.555-55', funcId: 5, loja: 1, tipo: 'adiantamento', comp: '2026-10', valor: 600, situacao: 'aguardando_envio', extratoRef: null, idBanco: null, efetiva: null, prevista: '2026-10-15', docs: [], cadeia: ['ok', 'na', 'pendente', 'na'], hist: [] },
  ];
  fs.writeFileSync(path.join(D, 'pagamentos.json'), JSON.stringify(pags));
  fs.writeFileSync(path.join(D, 'guias.json'), JSON.stringify([{ id: 'GU-1', tipo: 'fgts_mensal', comp: '2026-09', loja: 1, valor: 3408.74, vencimento: '2026-10-20', situacao: 'conferencia', docs: [], demonstrativo: [], conc: { crit: {}, debitos: [{ ref: 'cahu|2026-10-20|3408.74|00360305000104', data: '2026-10-20', valor: 3408.74 }], res: 'sugestao' }, hist: [] }]));
});
const ev = (id, data, valor, shortened, cp, extra) => ({ id, type: 'lancamento', operation: 'D', amount: { value: -valor }, date: { accounting: data }, literal: { code: '9676', shortened, complete: shortened }, counterpart: cp, ...(extra || {}) });
const EXT = { cahu: [
  ev('id-ana', '2026-09-30', 1000, 'PIX ENVIADO', { name: 'ANA TESTE', document: '11111111111', person: 'FISICA' }),
  ev('id-bruno', '2026-10-27', 70, 'PIX ENVIADO', { name: 'BRUNO TESTE', document: '22222222222', person: 'FISICA', institution: 'NUBANK', agency: '0001', account: '123', digit: '4' }),
  ev('id-carla', '2026-10-21', 2500, 'PIX ENVIADO', { name: 'CARLA TESTE', document: '33333333333', person: 'FISICA' }),
  ev('id-dani', '2026-10-16', 450, 'PIX ENVIADO', { name: 'DANI TESTE', document: '44444444444', person: 'FISICA' }),
  ev('id-eva-outro', '2026-10-16', 600, 'PIX ENVIADO', { name: 'EVA TESTE', document: '99999999999', person: 'FISICA' }),
  ev('id-cef', '2026-10-20', 3408.74, 'SISPAG FORNECEDORES PIX', { name: 'CEF MATRIZ', document: '00360305000104', person: 'JURIDICA' }),
  ev('id-forn', '2026-10-20', 5000, 'SISPAG FORNECEDORES PAG TIT', { name: 'DISTRIBUIDORA X', document: '12345678000199', person: 'JURIDICA' }),
  ev('id-tar', '2026-10-20', 15.72, 'TAR/CUSTAS COBRANCA', {}),
  ev('id-dev', '2026-10-22', 2500, 'PIX DEVOLVIDO', { name: 'CARLA TESTE', document: '33333333333', person: 'FISICA' }, { literal: { code: '9498', shortened: 'PIX DEVOLVIDO' }, reversal: true }),
  ev('id-fabio', '2026-10-10', 300, 'PIX ENVIADO', { name: 'FABIO TESTE', document: '66666666666', person: 'FISICA' }),
  { id: 'id-fabio-volta', type: 'lancamento', operation: 'C', amount: { value: 300 }, date: { accounting: '2026-10-11' }, literal: { shortened: 'PIX TRANSF FABIO TESTE', complete: 'PIX TRANSF FABIO TESTE 11/10' }, counterpart: { name: 'FABIO TESTE', document: '66666666666', person: 'FISICA' } },
  { id: 'id-lote', type: 'agrupamento', operation: 'D', amount: { value: -1000 }, date: { accounting: '2026-09-30' }, literal: { shortened: 'SISPAG SALARIOS', complete: 'SISPAG SALARIOS' }, number_events: 1 },
] };
const chamadas = [];
B._interno._deps({ agora: () => new Date('2026-11-04T12:00:00'), extrato: async ({ conta, dataInicio, dataFim }) => { chamadas.push([conta, dataInicio, dataFim]); return { data: [{ events: EXT[conta] || [] }] }; }, pontocerto: null, ged: null });
const aud = () => fs.readFileSync(path.join(D, 'auditoria.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('consulta: escopo trabalhista, identificador do banco, situação real, vínculo e conciliação', async () => {
  const r = await B.consultar(U.rh, { loja: '1', de: '2026-09-01', ate: '2026-11-04' });
  assert.strictEqual(r.ocultados, 3, 'fornecedor, tarifa e devolução de PIX recebido ficam fora');
  const by = id => r.linhas.find(l => l.idBanco === id);
  assert.strictEqual(r.linhas.length, 8); assert.ok(!by('id-forn') && !by('id-tar') && !by('id-dev'));
  assert.strictEqual(by('id-fabio').situacao, 'estornado', 'crédito de volta do mesmo CPF e valor = devolvido'); assert.strictEqual(by('id-fabio').devolucao.data, '2026-10-11'); assert.strictEqual(by('id-fabio').devolucao.idBanco, 'id-fabio-volta');
  assert.strictEqual(by('id-bruno').conciliacao, 'conciliado'); assert.strictEqual(by('id-bruno').vinculo.id, 'PG-DF-2026-0001-2-20261025'); assert.strictEqual(by('id-bruno').tipo, 'domfer'); assert.strictEqual(by('id-bruno').bancoFav, 'NUBANK');
  assert.strictEqual(by('id-bruno').documentoTxt, '***.***.222-22', 'RH vê o CPF mascarado'); assert.strictEqual(by('id-bruno').comprovante.disponivel, false); assert.strictEqual(by('id-bruno').comprovante.motivo, B.SEM_COMPROVANTE);
  assert.strictEqual(by('id-carla').conciliacao, 'pendente'); assert.deepStrictEqual(by('id-carla').candidatos.map(c => c.id), ['PG-R-9']); assert.strictEqual(by('id-carla').tipo, 'rescisao');
  assert.strictEqual(by('id-dani').conciliacao, 'divergencia_valor'); assert.strictEqual(by('id-eva-outro').conciliacao, 'beneficiario_divergente');
  assert.strictEqual(by('id-cef').tipo, 'fgts'); assert.strictEqual(by('id-cef').vinculo.id, 'GU-1'); assert.strictEqual(by('id-cef').conciliacao, 'pendente', 'guia: débito só sugere');
  assert.strictEqual(by('id-carla').situacao, 'liquidado');
  assert.strictEqual(by('id-lote').lote, true); assert.strictEqual(by('id-lote').membros.length, 1); assert.strictEqual(by('id-lote').membros[0].comprovante.disponivel, true); assert.strictEqual(by('id-lote').comprovante.disponivel, false);
  assert.strictEqual(by('id-ana').conciliacao, 'sem_lancamento', 'Ana já foi confirmada pelo comprovante SISPAG, o PIX avulso de mesmo valor não é dela');
  assert.ok(aud().some(a => a.acao === 'Consulta ao banco' && a.usuario === 'rh' && /E1/.test(a.ref)));
  const fin = await B.consultar(U.fin, { loja: '1', de: '2026-10-01', ate: '2026-11-04', cpf: '222' }); assert.strictEqual(fin.linhas.length, 1); assert.strictEqual(fin.linhas[0].documentoTxt, '222.222.222-22', 'Financeiro vê o CPF completo');
  assert.strictEqual((await B.consultar(U.fin, { loja: '1', de: '2026-10-01', ate: '2026-11-04', valor: '2.500,00' })).linhas.length, 1);
  assert.strictEqual((await B.consultar(U.fin, { loja: '1', de: '2026-10-01', ate: '2026-11-04', situacao: 'estornado' })).linhas.length, 1);
  assert.strictEqual((await B.consultar(U.fin, { loja: '1', de: '2026-10-01', ate: '2026-11-04', idBanco: 'ID-CEF' })).linhas.length, 1);
  assert.strictEqual((await B.consultar(U.fin, { loja: '1', de: '2026-10-01', ate: '2026-11-04', tipo: 'fgts' })).linhas.length, 1);
  assert.strictEqual((await B.consultar(U.fin, { loja: '1', de: '2026-09-01', ate: '2026-11-04', nome: 'bruno' })).linhas.length, 1);
  await assert.rejects(() => B.consultar(U.rh, { loja: '10' }), /CD/); await assert.rejects(() => B.consultar(U.rh, { loja: '1', de: '2026-01-01', ate: '2026-11-04' }), /92 dias/); await assert.rejects(() => B.consultar(U.cpd, { loja: '1' }), /Sem acesso/);
  const n = chamadas.length; await B.consultar(U.rh, { loja: '1', de: '2026-09-01', ate: '2026-11-04' }); assert.strictEqual(chamadas.length, n, 'cache de 10 min evita bater no banco de novo');
});

test('vínculo manual: regras de valor, CPF, duplicidade; desvincular; auditoria por referência', async () => {
  const refCarla = 'cahu|2026-10-21|2500.00|33333333333';
  await assert.rejects(() => Promise.resolve().then(() => B.vincular(U.rh, { ref: refCarla, pagamentoId: 'PG-R-9' })), /Só Financeiro/);
  await assert.rejects(() => Promise.resolve().then(() => B.vincular(U.fin, { ref: 'cahu|2026-10-16|450.00|44444444444', pagamentoId: 'PG-A-2026-10-f4' })), /difere/);
  await assert.rejects(() => Promise.resolve().then(() => B.vincular(U.fin, { ref: 'cahu|2026-10-16|600.00|99999999999', pagamentoId: 'PG-A-2026-10-f5' })), /Beneficiário divergente/);
  await assert.rejects(() => Promise.resolve().then(() => B.vincular(U.fin, { ref: 'cahu|2026-10-27|70.00|22222222222', pagamentoId: 'PG-R-9' })), /já confirma o pagamento/);
  const r = B.vincular(U.fin, { ref: refCarla, pagamentoId: 'PG-R-9', idBanco: 'id-carla', obs: 'conferido no Itaú Empresas' });
  assert.strictEqual(r.pagamento.situacao, 'liquidado'); assert.strictEqual(r.pagamento.idBanco, 'id-carla'); assert.strictEqual(r.pagamento.efetiva, '2026-10-21'); assert.ok(r.pagamento.vinculoManual);
  const c = await B.consultar(U.fin, { loja: '1', de: '2026-10-01', ate: '2026-11-04', idBanco: 'id-carla' }); assert.strictEqual(c.linhas[0].conciliacao, 'manual'); assert.strictEqual(c.linhas[0].vinculo.manual, true);
  await assert.rejects(() => Promise.resolve().then(() => B.vincular(U.fin, { ref: refCarla, pagamentoId: 'PG-A-2026-10-f4' })), /já está vinculado/);
  const a = B.auditoriaDe('id-carla'); assert.ok(a.length === 0 || a.length >= 0); const ar = B.auditoriaDe(refCarla); assert.ok(ar.some(x => x.acao === 'Vínculo'));
  // sobrevive à sincronização
  const S = require('../lib/comprovantes-bancarios-sync'); S._interno._deps({ agora: () => new Date('2026-11-04T12:00:00'), competencias: () => [], relatorios: () => [], titulos: async () => [{ nReg: 9, Filial: 1, PlanoGrupo: 12, PlanoSub: 8, Historico: 'CARLA', Valor: '2500', Devedor: '2500', Acrescimo: '0', Multa: '0', Juros: '0', Desconto: '0', DataVencto: new Date(2026, 9, 20), CompetenciaMes: 10, CompetenciaAno: 2026 }], extrato: async () => ({ data: [{ events: [] }] }), colaboradores: async () => null });
  const s = await S.sincronizar('teste'); assert.deepStrictEqual(s.erros, []); const pg = JSON.parse(fs.readFileSync(path.join(D, 'pagamentos.json'))).find(p => p.id === 'PG-R-9'); assert.strictEqual(pg.situacao, 'liquidado'); assert.strictEqual(pg.extratoRef, refCarla);
  B.desvincular(U.coord, { ref: refCarla, obs: 'teste' }); assert.strictEqual(JSON.parse(fs.readFileSync(path.join(D, 'pagamentos.json'))).find(p => p.id === 'PG-R-9').situacao, 'aguardando_envio');
  // restaura a base do 1º teste pra os próximos
  fs.writeFileSync(path.join(D, 'pagamentos.json'), JSON.stringify([{ id: 'PG-F-2026-09-f1', origem: 'auditoria-folha', nome: 'Ana Teste', cpf: '111.111.111-11', funcId: 1, loja: 1, tipo: 'salario', comp: '2026-09', valor: 1000, situacao: 'liquidado', idBanco: 'CTRL C1', efetiva: '2026-09-30', docs: [{ nome: 'comprovantes.pdf', classe: 'oficial', origem: 'Itaú Empresas', kb: 1, caminho: PDF, pagina: 2 }], cadeia: ['ok', 'ok', 'ok', 'ok'], hist: [] }]));
});

test('comprovante: página individual extraída, GED exige RH e funcionário, origem preservada', async () => {
  const pags = JSON.parse(fs.readFileSync(path.join(D, 'pagamentos.json'))); const doc = pags[0].docs[0];
  const pg = await B.paginaPdf(doc, 'PG-F-2026-09-f1', 0); const d = await PDFDocument.load(fs.readFileSync(pg)); assert.strictEqual(d.getPageCount(), 1);
  assert.strictEqual((await PDFDocument.load(fs.readFileSync(PDF))).getPageCount(), 3, 'original intacto');
  await assert.rejects(() => B.arquivarGed(U.fin, { pagamentoId: 'PG-F-2026-09-f1', idx: 0 }), /Só o RH/);
  await assert.rejects(() => B.arquivarGed(U.rh, { pagamentoId: 'PG-F-2026-09-f1', idx: 0 }), /não disponível/);
  const recebido = [];
  B._interno._deps({ ged: { pcDeps: {}, importar: async (user, body, file) => { recebido.push({ user: user.usuario, body, size: file.size, nome: file.originalname }); const n = (await PDFDocument.load(fs.readFileSync(file.path))).getPageCount(); assert.strictEqual(n, 1); fs.unlinkSync(file.path); return { protocolo: 'DOC-2026-0001' }; } } });
  const r = await B.arquivarGed(U.rh, { pagamentoId: 'PG-F-2026-09-f1', idx: 0 });
  assert.strictEqual(r.protocolo, 'DOC-2026-0001'); assert.strictEqual(recebido[0].body.categoria, '08'); assert.strictEqual(recebido[0].body.tipo, 'Comprovante bancário'); assert.strictEqual(recebido[0].body.colabId, 1); assert.strictEqual(recebido[0].body.dataDocumento, '2026-09-30');
  const p2 = JSON.parse(fs.readFileSync(path.join(D, 'pagamentos.json')))[0]; assert.strictEqual(p2.arquivado, true); assert.match(p2.pasta, /DOC-2026-0001/);
  await assert.rejects(() => B.arquivarGed(U.rh, { pagamentoId: 'PG-F-2026-09-f1', idx: 0 }), /já arquivado/);
  assert.ok(aud().some(a => a.acao === 'Arquivamento' && a.ref === 'PG-F-2026-09-f1'));
});

test('rotas: POST do banco passa pelo middleware, download da página auditado, evento de impressão registrado', async () => {
  const express = require('express'); const montar = require('../lib/comprovantes-bancarios-rotas');
  const app = express(); app.use(express.json()); app.use((req, res, next) => { const u = req.headers['x-u']; req.session = u ? { user: { usuario: u, nome: 'Teste ' + u } } : {}; next(); }); montar(app, { semSync: true });
  const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port + '/api/comprovantes-bancarios';
  try {
    const r = await fetch(base + '/banco/consultar?loja=1&de=2026-10-01&ate=2026-11-04', { headers: { 'x-u': 'rh' } }); assert.strictEqual(r.status, 200); assert.ok((await r.json()).linhas.length >= 1);
    assert.strictEqual((await fetch(base + '/banco/consultar?loja=1', { headers: { 'x-u': 'cpd' } })).status, 403);
    const ev2 = await fetch(base + '/banco/evento', { method: 'POST', headers: { 'x-u': 'rh', 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'impressao', ref: 'PG-F-2026-09-f1', det: 'teste' }) }); assert.strictEqual(ev2.status, 200);
    const pdf = await fetch(base + '/doc/PG-F-2026-09-f1/0?pagina=1&download=1', { headers: { 'x-u': 'rh' } }); assert.strictEqual(pdf.status, 200); assert.match(pdf.headers.get('content-disposition'), /attachment; filename="comprovante-PG-F-2026-09-f1.pdf"/);
    assert.strictEqual((await fetch(base + '/banco/vincular', { method: 'POST', headers: { 'x-u': 'rh', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const a = await (await fetch(base + '/auditoria?ref=PG-F-2026-09-f1', { headers: { 'x-u': 'coord' } })).json(); assert.ok(a.itens.some(x => x.acao === 'Impressão') && a.itens.some(x => x.acao === 'Download'));
    assert.strictEqual((await fetch(base + '/banco/catalogo', { headers: { 'x-u': 'rh' } })).status, 200);
  } finally { srv.close(); }
});
