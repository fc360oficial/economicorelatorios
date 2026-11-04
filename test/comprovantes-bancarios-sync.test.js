'use strict';
// Sincronização automática de Comprovantes Bancários (lib/comprovantes-bancarios-sync.js) com fontes FICTÍCIAS injetadas:
// Auditoria da Folha, Pagamentos Dom/Feriados, títulos do ERP e extrato Itaú. Nenhum dado real; nada toca banco ou ERP.
const test = require('node:test'), assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cbs-'));
process.env.COMPROVANTES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-'));
process.env.AUDITORIA_FOLHA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cbs-'));
process.env.PAGDF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-cbs-'));
process.env.COMPROVANTES_SYNC = '0';
const GP = require('../lib/gestao-pessoas');
const CB = require('../lib/comprovantes-bancarios');
const S = require('../lib/comprovantes-bancarios-sync');

const AF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'afdocs-'));
fs.mkdirSync(path.join(AF_DIR, 'docs', '2026-09'), { recursive: true });
fs.writeFileSync(path.join(AF_DIR, 'docs', '2026-09', 'comp.pdf'), '%PDF-1.4 teste');
fs.writeFileSync(path.join(AF_DIR, 'docs', '2026-09', 'folha-E1.pdf'), '%PDF-1.4 recibo');

const lanc = (ref, data, valor, extra) => ({ ref, data, valor, favorecido: null, documento: null, historico: 'PIX ENVIADO', categoria: 'pix_enviado', ...extra });
let AF = () => [{ dir: AF_DIR, raw: {
  competencia: '2026-09', documentos: { folha: { arquivo: 'recibo.pdf', caminho: 'folha.pdf', lojas: { 1: { arquivo: 'recibo E1.pdf', caminho: 'folha-E1.pdf' } } }, adiantamento: { arquivo: 'adiant.pdf', caminho: 'adiant.pdf' } },
  comprovantes: [{ ctrl: 'C1', caminho: 'comp.pdf', arquivo: 'comp.pdf', pagina: 1, loja: 1, data: '2026-09-30', valor: 1000, nome: 'ANA TESTE' }],
  divergencias: [{ protocolo: 'FOL-2026-0001', documento: 'adiantamento', funcKey: 'f1', situacao: 'aberta' }],
  conciliacao: { janelas: { folha: { de: '2026-09-25', ate: '2026-10-15' }, adiantamento: { de: '2026-09-10', ate: '2026-09-30' } } },
  funcionarios: [
    { key: 'f1', nome: 'Ana Teste', cpf: '11111111111', funcId: 1, loja: 1, matricula: '10', folha: { previsto: 1000, pago: 1000, situacao: 'pago', modo: 'comprovante SISPAG 30/09/2026 · CTRL C1', lancamentos: [lanc('comp|C1', '2026-09-30', 1000, { comprovante: true, ctrl: 'C1', arquivo: 'comp.pdf', pagina: 1, categoria: 'comprovante', loja: 1 })] }, adiantamento: { previsto: 400, pago: null, situacao: 'nao_pago', lancamentos: [] } },
    { key: 'f2', nome: 'Bruno Teste', cpf: '22222222222', funcId: 2, loja: 1, folha: { previsto: 1200, pago: 1200, situacao: 'lote', modo: 'lote (R$ 5.000,00)', lancamentos: [lanc('cahu|2026-09-30|5000.00|7', '2026-09-30', 5000, { categoria: 'salario', historico: 'SISPAG SALARIOS (lote com 5 lançamento(s))', lancamentosNoLote: 5 })] }, adiantamento: null },
    { key: 'f3', nome: 'Carla Teste', cpf: '33333333333', funcId: 3, loja: 2, folha: { previsto: 1000, pago: 900, situacao: 'inferior', modo: 'CPF (valor diferente)', lancamentos: [lanc('muribeca|2026-09-30|900.00|33333333333', '2026-09-30', 900)] }, adiantamento: null },
    { key: 'f4', nome: 'Dani Teste', cpf: '44444444444', funcId: 4, loja: 10, folha: { previsto: 800, pago: null, situacao: 'nao_verificado', lancamentos: [] }, adiantamento: null },
  ] } }];
const DF = () => [
  { id: 'PG-2026-0001', status: 'pago', aprovacao: { em: '2026-10-20T10:00:00Z' }, previsaoPagamento: { data: '2026-10-27' }, itens: [
    { key: '1|2026-10-25', funcId: 1, nome: 'Ana Teste', cpf_fim: '***.***.111-11', loja: 1, data: '2026-10-25', tipo: 'domingo', selecionado: true, valorTrabalho: 61, passagem: { aplica: false, valor: 0 }, pagamento: { status: 'pago', data: '2026-10-27', extratoRef: 'cahu|2026-10-27|61.00|11111111111', obs: 'Conciliado automaticamente com o extrato Itaú (cahu, CPF + valor)', transacao: 'PIX ENVIADO ANA TESTE' } },
    { key: '2|2026-10-25', funcId: 2, nome: 'Bruno Teste', cpf_fim: '***.***.222-22', loja: 1, data: '2026-10-25', tipo: 'domingo', selecionado: true, valorTrabalho: 61, passagem: { aplica: true, valor: 9 }, pagamento: { status: 'pendente' } },
    { key: '3|2026-10-25', funcId: 3, nome: 'Carla Teste', cpf_fim: '***.***.333-33', loja: 2, data: '2026-10-25', tipo: 'domingo', selecionado: true, valorTrabalho: 900, passagem: { aplica: false, valor: 0 }, pagamento: { status: 'pago', data: '2026-09-30', extratoRef: 'muribeca|2026-09-30|900.00|33333333333', obs: 'Conciliado', transacao: 'PIX' } },
    { key: '9|2026-10-25', funcId: 9, nome: 'Fora', loja: 1, data: '2026-10-25', tipo: 'domingo', selecionado: false, valorTrabalho: 10, passagem: { aplica: false }, pagamento: { status: 'pendente' } }] },
  { id: 'PG-2026-0002', status: 'cancelado', itens: [{ funcId: 5, nome: 'Cancelado', loja: 1, data: '2026-10-18', selecionado: true, valorTrabalho: 61, passagem: { aplica: false }, pagamento: { status: 'pendente' } }] },
];
const D = (y, m, d) => new Date(y, m - 1, d);
const T = (nReg, Filial, g, s, Historico, Valor, venc, extra) => ({ nReg, Filial, PlanoGrupo: g, PlanoSub: s, Historico, Valor: String(Valor), Devedor: String(Valor), Acrescimo: '0', Multa: '0', Juros: '0', Desconto: '0', DataEmissao: D(2026, 10, 1), DataVencto: venc, nDoc: String(Math.round(Valor * 100)), CompetenciaMes: 9, CompetenciaAno: 2026, FormaPagamento: 'BOLETO', baixaEm: null, ...extra });
let ERP = async () => [
  T(1, 1, 12, 20, 'FGTS', 3408.74, D(2026, 10, 20)), T(2, 1, 12, 20, 'INSS', 9696.53, D(2026, 10, 20)), T(3, 1, 12, 20, 'SIMPLES PQO', 56337.27, D(2026, 10, 21)), T(4, 1, 12, 20, 'PONTE', 240.01, D(2026, 10, 18)),
  T(5, 2, 12, 7, 'MULTA JONAS', 2933.84, D(2026, 10, 18)), T(6, 2, 12, 8, 'JONAS', 6505.18, D(2026, 10, 18), { FormaPagamento: 'TRANSFERÊNCIA' }), T(7, 2, 12, 8, 'MARIA', 1500, D(2026, 10, 18)),
  T(8, 3, 12, 20, 'INSS', 100, D(2026, 10, 10), { Devedor: '0', baixaEm: D(2026, 10, 10) }), T(9, 3, 12, 20, 'FGTS', 200, D(2026, 10, 10)), T(10, 3, 12, 20, 'FTGS YGM', 300, D(2026, 10, 10)),
  T(11, 1, 12, 20, 'FGTS', 50, D(2026, 11, 10)), T(12, 10, 12, 20, 'INSS', 10, D(2026, 10, 1)), T(13, 1, 8, 1, 'DARF', 77, D(2026, 10, 5)),
  // rescisões como saem de verdade: SISPAG Fornecedores para o CNPJ da própria empresa (mesma data da baixa), lote SISPAG Salários de 1 item, e duas somadas num débito
  T(20, 1, 12, 8, 'PAULO', 1785.63, D(2026, 10, 29), { Devedor: '0', baixaEm: D(2026, 10, 29) }), T(21, 1, 12, 8, 'RITA', 335.35, D(2026, 10, 9), { Devedor: '0', baixaEm: D(2026, 10, 9) }),
  T(22, 1, 12, 8, 'FABIO', 1136.35, D(2026, 10, 14), { Devedor: '0', baixaEm: D(2026, 10, 14) }), T(23, 1, 12, 8, 'RENATA', 1073.65, D(2026, 10, 14), { Devedor: '0', baixaEm: D(2026, 10, 14) }),
];
const ev = (data, valor, shortened, cp, code) => ({ type: 'lancamento', operation: 'D', amount: { value: -valor }, date: { accounting: data }, literal: { code: code || '9676', shortened, complete: shortened }, counterpart: cp });
const CEF = { name: 'CEF MATRIZ', document: '00360305000104', person: 'JURIDICA' };
const EXT = {
  cahu: [ev('2026-10-20', 3408.74, 'SISPAG FORNECEDORES PIX', CEF), ev('2026-10-27', 61, 'PIX ENVIADO', { name: 'ANA TESTE', document: '11111111111', person: 'FISICA' }),
    ev('2026-10-29', 1785.63, 'SISPAG FORNECEDORES', { name: 'CAHU COMERCIO DE ALIMENTOS', document: '21425302000181', person: 'JURIDICA' }, '7549'),
    { type: 'agrupamento', operation: 'D', amount: { value: -335.35 }, date: { accounting: '2026-10-09' }, literal: { shortened: 'SISPAG SALARIOS', complete: 'SISPAG SALARIOS' }, number_events: 1 },
    ev('2026-10-14', 2210, 'SISPAG FORNECEDORES', { name: 'CAHU COMERCIO DE ALIMENTOS', document: '21425302000181', person: 'JURIDICA' }, '7549'),
    ev('2026-10-14', 2210, 'SISPAG FORNECEDORES PAG TIT', { name: 'DISTRIBUIDORA X', document: '12345678000199', person: 'JURIDICA' }, '7549')],
  muribeca: [ev('2026-10-19', 6505.18, 'PIX ENVIADO', { name: 'JONAS DA SILVA', document: '55555555555', person: 'FISICA' }), ev('2026-10-19', 1500, 'PIX ENVIADO', { name: 'JOSE OUTRO', document: '66666666666', person: 'FISICA' }), ev('2026-10-18', 2933.84, 'SISPAG FORNECEDORES PIX', CEF)],
  ponte: [ev('2026-10-10', 500, 'SISPAG FORNECEDORES PIX', CEF)],
};
const extratoFake = async ({ conta }) => ({ data: [{ events: EXT[conta] || [] }], pagination: { paginas_lidas: 1 } });
S._interno._deps({ agora: () => new Date('2026-11-04T12:00:00'), competencias: () => AF(), relatorios: DF, titulos: (de, ate) => ERP(de, ate), extrato: extratoFake, colaboradores: async () => ({ ativos: [], desligados: [{ id: 77, nome: 'Jonas da Silva Teste', loja: 2 }] }) });
const ler = f => JSON.parse(fs.readFileSync(path.join(process.env.COMPROVANTES_DIR, f), 'utf8'));

test('classificação dos títulos do ERP', () => {
  const c = S._interno.classificarTitulo;
  assert.deepStrictEqual(c({ PlanoGrupo: 12, PlanoSub: 20, Historico: 'FTGS YGM' }), { kind: 'guia', tipo: 'fgts_mensal' });
  assert.deepStrictEqual(c({ PlanoGrupo: 12, PlanoSub: 20, Historico: 'INSS PQO' }), { kind: 'guia', tipo: 'previdencia' });
  assert.deepStrictEqual(c({ PlanoGrupo: 12, PlanoSub: 7, Historico: 'MULTA JONAS' }), { kind: 'guia', tipo: 'fgts_rescisorio' });
  assert.strictEqual(c({ PlanoGrupo: 12, PlanoSub: 8, Historico: 'YASMIM' }).kind, 'rescisao');
  assert.strictEqual(c({ PlanoGrupo: 12, PlanoSub: 20, Historico: 'SIMPLES PQO' }).kind, 'ignorar');
  assert.strictEqual(c({ PlanoGrupo: 12, PlanoSub: 20, Historico: 'JARDIM' }).kind, 'ignorar');
  assert.strictEqual(c({ PlanoGrupo: 8, PlanoSub: 1, Historico: 'DARF' }).kind, 'ignorar');
  assert.deepStrictEqual(c({ PlanoGrupo: 8, PlanoSub: 1, Historico: 'DARF INSS' }), { kind: 'guia', tipo: 'previdencia' });
  assert.deepStrictEqual(S._interno.combinacaoUnica([200, 300, 50], 500, 0.009, 4), [0, 1]);
  assert.strictEqual(S._interno.combinacaoUnica([200, 300, 250, 250], 500, 0.009, 4), null, 'duas combinações = não chuta');
});

test('ciclo completo: pagamentos, guias, lotes e pendências saem das fontes, sem nada fictício do módulo', async () => {
  const r = await S.sincronizar('teste');
  assert.ok(!r.falha, r.erros.join(' | ')); assert.deepStrictEqual(r.erros, []);
  const P = ler('pagamentos.json'), G = ler('guias.json'), L = ler('lotes.json'), LG = ler('lotes-guia.json'), PD = ler('pendencias.json');
  const p = id => P.find(x => x.id === id), g = id => G.find(x => x.id === id);
  // Auditoria da Folha
  const ana = p('PG-F-2026-09-f1'); assert.strictEqual(ana.situacao, 'liquidado'); assert.strictEqual(ana.cpf, '111.111.111-11'); assert.strictEqual(ana.idBanco, 'CTRL C1'); assert.strictEqual(ana.lote, 'LT-cahu-2026-09-30-COMP');
  assert.strictEqual(ana.docs[0].classe, 'oficial'); assert.ok(ana.docs[0].caminho && ana.docs[0].kb === 1, 'comprovante com caminho e tamanho'); assert.strictEqual(ana.docs[1].classe, 'demonstrativo'); assert.strictEqual(ana.docs[1].nome, 'recibo E1.pdf');
  assert.deepStrictEqual(ana.cadeia, ['ok', 'ok', 'ok', 'ok']);
  const anaAd = p('PG-A-2026-09-f1'); assert.strictEqual(anaAd.situacao, 'divergente'); assert.match(anaAd.motivo, /FOL-2026-0001/); assert.strictEqual(anaAd.tipo, 'adiantamento');
  const bruno = p('PG-F-2026-09-f2'); assert.strictEqual(bruno.situacao, 'comprovante_indisponivel'); assert.strictEqual(bruno.lote, 'LT-cahu-2026-09-30-500000'); assert.strictEqual(L.find(l => l.id === bruno.lote).qtdBanco, 5);
  assert.strictEqual(p('PG-F-2026-09-f3').situacao, 'divergente'); assert.strictEqual(p('PG-F-2026-09-f4').situacao, 'comprovante_indisponivel');
  // Dom/Feriados
  const df = P.filter(x => x.tipo === 'domfer'); assert.strictEqual(df.length, 3, 'cancelado e não selecionado ficam de fora');
  assert.strictEqual(p('PG-DF-2026-0001-1-20261025').situacao, 'liquidado'); assert.strictEqual(p('PG-DF-2026-0001-1-20261025').cpf, '111.111.111-11', 'CPF vem da Auditoria da Folha');
  assert.strictEqual(p('PG-DF-2026-0001-2-20261025').situacao, 'aguardando_envio'); assert.strictEqual(p('PG-DF-2026-0001-2-20261025').valor, 70);
  // ERP → guias
  assert.strictEqual(r.fontes.erp.ignorados, 3); assert.deepStrictEqual(r.fontes.erp.naoClassificados.map(x => x.nReg), [3, 4, 13]);
  assert.strictEqual(g('GU-1').situacao, 'conferencia'); assert.strictEqual(g('GU-1').conc.res, 'sugestao'); assert.strictEqual(g('GU-1').conc.debitos[0].valor, 3408.74); assert.strictEqual(g('GU-1').pagamento, '2026-10-20');
  assert.strictEqual(g('GU-2').situacao, 'vencida'); assert.strictEqual(g('GU-11').situacao, 'aguardando'); assert.strictEqual(g('GU-12').situacao, 'vencida'); assert.match(g('GU-12').motivo, /CD/);
  assert.strictEqual(g('GU-8').situacao, 'conferencia'); assert.strictEqual(g('GU-8').semComprovante, true);
  assert.strictEqual(LG.length, 1); assert.deepStrictEqual(LG[0].guias.sort(), ['GU-10', 'GU-9']); assert.strictEqual(g('GU-9').lote, LG[0].id); assert.strictEqual(g('GU-10').situacao, 'conferencia');
  assert.ok(G.every(x => x.situacao !== 'paga'), 'débito nunca quita guia sozinho');
  // ERP → rescisões
  const jonas = p('PG-R-6'); assert.strictEqual(jonas.situacao, 'liquidado'); assert.strictEqual(jonas.nome, 'Jonas da Silva Teste'); assert.strictEqual(jonas.cpf, '555.555.555-55'); assert.strictEqual(jonas.guiaRel, 'GU-5'); assert.strictEqual(g('GU-5').demonstrativo[0].nome, 'Jonas da Silva Teste');
  const maria = p('PG-R-7'); assert.strictEqual(maria.situacao, 'divergente'); assert.match(maria.motivo, /JOSE OUTRO/);
  assert.strictEqual(p('PG-R-20').situacao, 'liquidado'); assert.match(p('PG-R-20').hist[1].txt, /CNPJ da empresa · mesma data da baixa/); assert.strictEqual(p('PG-R-20').efetiva, '2026-10-29');
  assert.strictEqual(p('PG-R-21').situacao, 'liquidado'); assert.match(p('PG-R-21').hist[1].txt, /lote SISPAG Salários \(1 lançamento\)/);
  assert.strictEqual(p('PG-R-22').situacao, 'liquidado'); assert.strictEqual(p('PG-R-23').situacao, 'liquidado'); assert.match(p('PG-R-22').hist[1].txt, /soma exata de 2 rescisões/); assert.strictEqual(p('PG-R-22').extratoRef, p('PG-R-23').extratoRef); assert.match(p('PG-R-22').extratoRef, /21425302000181/, 'a soma casa com a transferência da empresa, não com o fornecedor de mesmo valor');
  // pendências
  const ab = PD.filter(x => x.situacao !== 'resolvida'); const por = k => ab.filter(x => x.alerta === k).map(x => x.ref);
  assert.deepStrictEqual(por('guia_vencida').sort(), ['GU-12', 'GU-2']); assert.deepStrictEqual(por('guia_proxima'), ['GU-11']); assert.deepStrictEqual(por('guia_sem_comp'), ['GU-8']);
  assert.deepStrictEqual(por('cpf'), ['PG-R-7']); assert.deepStrictEqual(por('valor'), ['PG-F-2026-09-f3']); assert.deepStrictEqual(por('nao_confirmado'), ['PG-A-2026-09-f1']);
  assert.deepStrictEqual(por('sem_comprovante'), ['LT-cahu-2026-09-30-500000'], 'lote sem comprovante = uma pendência por lote, CD não gera');
  assert.strictEqual(por('debito_duplo').length, 1, 'mesmo débito na folha da Carla e no dom/feriado dela'); assert.ok(ab.every(x => /^PD-2026-\d{4}$/.test(x.id)));
  assert.ok(!JSON.stringify(CB.dados()).includes('Exemplo'), 'tela recebe só o que veio das fontes');
  const H = CB.dados().HOMOLOGACAO; assert.strictEqual(H.find(h => h[0] === 2)[2], 'PG-F-2026-09-f1'); assert.strictEqual(G.find(x => x.id === H.find(h => h[0] === 9)[2]).tipo, 'fgts_mensal'); assert.strictEqual(H.find(h => h[0] === 12)[2], 'GU-2'); assert.strictEqual(H.find(h => h[0] === 13)[2], null);
  assert.ok(fs.existsSync(path.join(process.env.COMPROVANTES_DIR, 'auditoria.jsonl')) && fs.existsSync(path.join(process.env.COMPROVANTES_DIR, 'sync.json')));
});

test('segundo ciclo: protocolos estáveis, arquivamento preservado, pendência some quando a causa some', async () => {
  const antes = ler('pendencias.json'); const pg = ler('pagamentos.json'); pg.find(x => x.id === 'PG-F-2026-09-f1').arquivado = true; pg.find(x => x.id === 'PG-F-2026-09-f1').pasta = '08 — Recibos e Contracheques'; fs.writeFileSync(path.join(process.env.COMPROVANTES_DIR, 'pagamentos.json'), JSON.stringify(pg));
  const base = AF(); base[0].raw.funcionarios[0].adiantamento = { previsto: 400, pago: 400, situacao: 'pago', modo: 'CPF + valor', lancamentos: [lanc('cahu|2026-09-15|400.00|11111111111', '2026-09-15', 400)] }; const afAntiga = AF; AF = () => base;
  const r = await S.sincronizar('teste2'); assert.deepStrictEqual(r.erros, []);
  const P = ler('pagamentos.json'), PD = ler('pendencias.json');
  assert.strictEqual(P.find(x => x.id === 'PG-F-2026-09-f1').arquivado, true); assert.strictEqual(P.find(x => x.id === 'PG-A-2026-09-f1').situacao, 'liquidado');
  const velha = antes.find(x => x.ref === 'PG-A-2026-09-f1'), nova = PD.find(x => x.ref === 'PG-A-2026-09-f1'); assert.strictEqual(nova.id, velha.id); assert.strictEqual(nova.situacao, 'resolvida'); assert.strictEqual(nova.resolvidaPor, 'sistema');
  for (const a of antes.filter(x => x.ref !== 'PG-A-2026-09-f1')) { const n = PD.find(x => x.alerta === a.alerta && x.ref === a.ref); assert.ok(n && n.id === a.id && n.em === a.em, 'protocolo estável: ' + a.id); }
  AF = afAntiga;
});

test('ERP fora do ar: guias e rescisões do ciclo anterior continuam na base e o erro fica registrado', async () => {
  const erpOk = ERP; ERP = async () => { throw new Error('ETIMEDOUT 192.168.2.252'); };
  const r = await S.sincronizar('teste3'); assert.ok(r.erros.some(e => /ERP/.test(e))); assert.strictEqual(r.fontes.erp.erro, 'ETIMEDOUT 192.168.2.252');
  assert.strictEqual(ler('guias.json').length, 8, '13 títulos − 3 não classificados − 2 rescisões'); assert.ok(ler('pagamentos.json').some(p => p.id === 'PG-R-6'));
  ERP = erpOk;
});

test('rotas: só a Coordenação dispara o ciclo, PDF vinculado sai auditado, POST em outra rota continua 405', async () => {
  const express = require('express'); const montar = require('../lib/comprovantes-bancarios-rotas');
  GP.salvarConfig({ designados: [{ usuario: 'c.user', papeis: ['coordenacao'], lojas: [] }, { usuario: 'r.user', papeis: ['rh_doc'], lojas: [] }, { usuario: 'p.user', papeis: ['cpd'], lojas: [1] }] }, { usuario: 'admin', perfil: 'admin' });
  const app = express(); app.use((req, res, next) => { const u = req.headers['x-u']; req.session = u ? { user: { usuario: u, nome: 'Teste ' + u, perfil: 'usuario' } } : {}; next(); }); montar(app, { semSync: true });
  const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port + '/api/comprovantes-bancarios';
  try {
    const st = async (p, u, m) => (await fetch(base + p, { method: m || 'GET', headers: u ? { 'x-u': u } : {} })).status;
    assert.strictEqual(await st('/sync/rodar', 'r.user', 'POST'), 403); assert.strictEqual(await st('/sync/rodar', 'p.user', 'POST'), 403); assert.strictEqual(await st('/dados', 'c.user', 'POST'), 405);
    const rr = await fetch(base + '/sync/rodar', { method: 'POST', headers: { 'x-u': 'c.user' } }); assert.strictEqual(rr.status, 200); const j = await rr.json(); assert.ok(j.ok && j.ciclo.totais.pagamentos > 0);
    assert.strictEqual(await st('/sync', 'r.user'), 200);
    const pdf = await fetch(base + '/doc/PG-F-2026-09-f1/0', { headers: { 'x-u': 'r.user' } }); assert.strictEqual(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /pdf/); assert.match(pdf.headers.get('content-disposition'), /inline/);
    assert.strictEqual(await st('/doc/PG-F-2026-09-f1/9', 'r.user'), 404); assert.strictEqual(await st('/doc/PG-F-2026-09-f1/0', 'p.user'), 403);
    const d = await (await fetch(base + '/dados', { headers: { 'x-u': 'c.user' } })).json(); assert.ok(d.SYNC && d.SYNC.ultimo && d.SYNC.ultimo.origem === 'manual · c.user');
    const aud = d.AUDITORIA; assert.ok(aud.some(a => a.acao === 'Visualização' && a.ref === 'PG-F-2026-09-f1' && a.quem === 'Teste r.user')); assert.ok(aud.some(a => a.acao === 'Acesso negado')); assert.ok(aud.some(a => a.acao === 'Consulta'));
  } finally { srv.close(); }
});
