'use strict';
const test = require('node:test');
// Teste de ponta a ponta: PDF de contracheques (sintético, loja Socorro) → prévia por loja → confirmar → conciliar com extrato simulado.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-af-'));
process.env.AUDITORIA_FOLHA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'af-'));
const ROOT = path.join(__dirname, '..');
const GP = require(ROOT + '/lib/gestao-pessoas'); const A = require(ROOT + '/lib/auditoria-folha');
const PDFDocument = require('pdfkit');

const admin = { usuario: 'tiago', nome: 'Admin', perfil: 'admin' }; const coord = { usuario: 'coord', nome: 'Coordenação', perfil: 'gerente' };
GP.salvarConfig({ designados: [{ usuario: 'coord', nome: 'Coordenação', papeis: ['coordenacao'] }] }, admin);

const FUNC = [
  { id: 'f1', nome: 'MARIA JOSE DA SILVA', matricula: '123', cpf: '11122233344', loja: 1, setor: 'Caixa', cargo: 'Operadora', ativo: true, liquido: 1850.33, adiant: 600 },
  { id: 'f2', nome: 'JOAO PEDRO SANTOS', matricula: '456', cpf: '55566677788', loja: 1, setor: 'Mercearia', cargo: 'Repositor', ativo: true, liquido: 1420.1, adiant: 500 },
  { id: 'f3', nome: 'ANA PAULA DE OLIVEIRA', matricula: '789', cpf: '99988877766', loja: 2, setor: 'Padaria', cargo: 'Padeira', ativo: true, liquido: 2210, adiant: 700 },   // no ponto está em Muribeca
];
const deps = { colaboradores: async () => ({ ativos: FUNC.map(f => ({ id: f.id, nome: f.nome, matricula: f.matricula, loja: f.loja, setor: f.setor, cargo: f.cargo, ativo: true })), desligados: [] }), cpfDe: async id => (FUNC.find(f => f.id === id) || {}).cpf || '' };

function pdfContracheques() {
  return new Promise(res => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 }); const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => res(Buffer.concat(bufs)));
    const brl = n => n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    FUNC.forEach((f, i) => {
      if (i) doc.addPage();
      doc.fontSize(11).text('ECONOMICO SUPERMERCADOS LTDA   CNPJ 12.345.678/0001-90   Filial: 01 - SOCORRO');
      doc.text('RECIBO DE PAGAMENTO DE SALARIO   Competencia: Outubro/2026   Folha Mensal');
      doc.moveDown(); doc.text('Codigo: ' + f.matricula.padStart(6, '0') + '   Nome: ' + f.nome + '   CPF: ' + f.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'));
      doc.text('Funcao: ' + f.cargo + '   Admissao: 05/03/2024   Depto: ' + f.setor);
      doc.moveDown(); doc.text('Cod   Descricao                     Referencia      Proventos       Descontos');
      doc.text('001   SALARIO BASE                  30,00 d        ' + brl(f.liquido + f.adiant + 410) + '');
      doc.text('010   HORAS EXTRAS 50%              8,00 h         ' + brl(120) + '');
      doc.text('201   INSS                          9,00 %                         ' + brl(230));
      doc.text('203   VALE TRANSPORTE               6,00 %                         ' + brl(300));
      doc.text('210   ADIANTAMENTO SALARIAL                                        ' + brl(f.adiant));
      doc.moveDown(); doc.text('Total Proventos: ' + brl(f.liquido + f.adiant + 530) + '   Total Descontos: ' + brl(f.adiant + 530));
      doc.text('Liquido a Receber: ' + brl(f.liquido));
      doc.moveDown(); doc.text('Salario Base ' + brl(2000) + '   Base Calc. INSS ' + brl(2120) + '   Base Calc. FGTS ' + brl(2120) + '   FGTS do mes ' + brl(169.6));
      doc.moveDown(2); doc.text('Assinatura: ______________________________');
    });
    doc.end();
  });
}

test('Auditoria da Folha: PDF de contracheques por loja → prévia → confirmar → conciliar só a conta da loja', async () => {
  const buf = await pdfContracheques(); fs.writeFileSync(path.join(process.env.AUDITORIA_FOLHA_DIR, 'contracheques-socorro.pdf'), buf);
  const pv = await A.importarPrevia(buf, 'contracheques-socorro.pdf', 'folha', '2026-10', coord, deps, '1');
  assert.strictEqual(pv.formato, 'contracheque'); assert.strictEqual(pv.funcionarios, 3); assert.strictEqual(pv.identificados, 3);
  assert.deepStrictEqual(pv.linhas.map(l => l.valor), [1850.33, 1420.1, 2210]); assert.deepStrictEqual(pv.linhas.map(l => l.matricula), ['123', '456', '789']);
  assert.ok(pv.linhas.every(l => l.loja === 1)); assert.strictEqual(pv.outraLoja, 1); assert.strictEqual(pv.linhas[0].descontoAdiantamento, 600);

  let r = A.importarConfirmar(pv.token, coord);
  assert.ok(r.documentos.folha.lojas[1]); assert.strictEqual(r.documentos.folha.lojas[1].funcionarios, 3); assert.strictEqual(r.documentos.folha.formato, 'contracheque');
  assert.strictEqual(r.funcionarios.length, 3); assert.ok(r.funcionarios.every(f => f.loja === 1));

  // segunda loja (E2) não mexe na E1: lista consolidada em xlsx seria igual; aqui reimporta E1 pra ver versão 2
  const pv2 = await A.importarPrevia(buf, 'contracheques-socorro-v2.pdf', 'folha', '2026-10', coord, deps, 1);
  assert.strictEqual(pv2.substitui, true); r = A.importarConfirmar(pv2.token, coord);
  assert.strictEqual(r.documentos.folha.lojas[1].versao, 2); assert.strictEqual(r.funcionarios.length, 3); assert.strictEqual(r.importacoes.length, 2); assert.strictEqual(r.importacoes[1].loja, 1);

  // conciliação com extrato simulado: só a conta da E1 é consultada
  const consultadas = [];
  const ev = (data, valor, cpf, nome) => ({ type: 'lancamento', operation: 'D', amount: { value: valor }, date: { accounting: data }, literal: { complete: 'PIX ENVIADO ' + nome }, counterpart: { document: cpf, person: 'FISICA', name: nome } });
  const extrato = async ({ conta }) => { consultadas.push(conta); return { data: [{ events: conta === 'cahu' ? [ev('2026-10-26', 1850.33, '11122233344', 'MARIA JOSE DA SILVA'), ev('2026-10-26', 1400.10, '55566677788', 'JOAO PEDRO SANTOS')] : [] }] }; };
  r = await A.conciliar('2026-10', coord, deps, { extrato });
  assert.deepStrictEqual(consultadas, ['cahu']); assert.strictEqual(r.conciliacao.lojas.filter(l => l.semDocumento).length, 5);
  const porNome = Object.fromEntries(r.funcionarios.map(f => [f.nome, f.folha.situacao]));
  assert.strictEqual(porNome['MARIA JOSE DA SILVA'], 'pago'); assert.strictEqual(porNome['JOAO PEDRO SANTOS'], 'inferior'); assert.strictEqual(porNome['ANA PAULA DE OLIVEIRA'], 'nao_pago');
  // lote SISPAG Salários vem da API como type 'agrupamento' (sem CPF): quem ficou sem pagamento individual é marcado 'lote' quando o valor bate com o subtotal pendente
  const lote = { type: 'agrupamento', operation: 'D', amount: { value: 2210 }, number_events: 1, date: { accounting: '2026-10-26' }, literal: { shortened: 'SISPAG SALARIOS' } };
  const extrato2 = async ({ conta }) => ({ data: [{ events: conta === 'cahu' ? [ev('2026-10-26', 1850.33, '11122233344', 'MARIA JOSE DA SILVA'), ev('2026-10-26', 1400.10, '55566677788', 'JOAO PEDRO SANTOS'), lote] : [] }] });
  r = await A.conciliar('2026-10', coord, deps, { extrato: extrato2 });
  const sit2 = Object.fromEntries(r.funcionarios.map(f => [f.nome, f.folha.situacao]));
  assert.strictEqual(sit2['ANA PAULA DE OLIVEIRA'], 'lote'); assert.strictEqual(sit2['MARIA JOSE DA SILVA'], 'pago'); assert.strictEqual(r.conciliacao.lojas.find(l => l.loja === 1).lotes, 1);
  assert.ok(A.arquivoDoc('2026-10', 'folha', coord, 1).caminho.includes('folha-E1-'));
});

test('Auditoria da Folha: recibo do sistema de folha com rótulo DEPOIS do valor (layout real de 27/10), 2 vias por página, competência do PDF', () => {
  const A = require('../lib/auditoria-folha');
  // ordem real do pdf-parse: a 2ª via começa pelo cabeçalho "Código Descrição", logo depois dos três totais da 1ª via
  const via = (nome, cod, venc, desc, liq) => ['Código \tDescrição \tReferência \tVencimentos \tDescontos', '8781', 'DIAS NORMAIS', '30,00', venc, 'DESC.ADIANT.SALARIAL \t770,37', 'EMPRESA EXEMPLO LTDA', '21.425.302/0001-81\tCNPJ: \tCC:', cod, 'Código', nome, 'Nome do Funcionário \tCBO', '848510', 'Departamento', '28', 'Filial', 'Folha Mensal', 'Setembro de 2026', 'Total de Vencimentos', 'ð\tValor Líquido', 'Total de Descontos', 'Declaro ter recebido a importância líquida discriminada neste recibo.', venc, desc, liq].join('\n');
  const pages = [
    { num: 1, text: via('CARLOS EDUARDO DA SILVA', '66', '2.047,95', '942,43', '1.105,52') + '\n' + via('CARLOS EDUARDO DA SILVA', '66', '2.047,95', '942,43', '1.105,52') },
    { num: 2, text: via('PEDRO HENRIQUE ALMEIDA BARROS', '56', '1.725,00', '0,00', '1.725,00') },   // via única: vale a última trinca da página
    { num: 3, text: via('JOAO BATISTA DOS SANTOS (C)', '052', '1.839,27', '838,21', '1.001,06') },
  ];
  const b = A._interno.blocosReciboPaginas(pages);
  assert.deepStrictEqual(b.avisos, []); assert.strictEqual(b.linhas.length, 3);
  assert.deepStrictEqual(b.linhas.map(l => [l.nome, l.matricula, l.valor, l.descontoAdiantamento]), [['CARLOS EDUARDO DA SILVA', '66', 1105.52, 770.37], ['PEDRO HENRIQUE ALMEIDA BARROS', '56', 1725, 770.37], ['JOAO BATISTA DOS SANTOS', '52', 1001.06, 770.37]]);
  assert.strictEqual(b.linhas[0].vias, 2);   // segunda via ignorada, não somada
  assert.strictEqual(A._interno.competenciaDoTexto(pages[0].text), '2026-09');
});

test('Auditoria da Folha: loja detectada pelo CNPJ da empresa do recibo', async () => {
  const A = require('../lib/auditoria-folha');
  assert.deepStrictEqual(A._interno.lojaDoTexto('EMPRESA EXEMPLO LTDA\n21.425.302/0001-81\tCNPJ: \tCC:\n').loja, 1);
  assert.strictEqual(A._interno.lojaDoTexto('EMPRESA EXEMPLO LTDA\n21.425.302/0001-81').empresa, 'EMPRESA EXEMPLO LTDA');
  assert.strictEqual(A._interno.lojaDoTexto('30.148.015/0001-62 e 39.762.002/0001-53').varios, true);
  assert.strictEqual(A._interno.lojaDoTexto('sem cnpj nenhum 12.345.678/0001-90').loja, null);
});

test('Auditoria da Folha: lote SISPAG com n lançamentos = soma exata de n pendentes (combinação única) marca "pago em lote"', async () => {
  process.env.AUDITORIA_FOLHA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'af-lote-'));
  const A = require('../lib/auditoria-folha');
  const F = [['ANA ALVES PEREIRA', 1105.52], ['BRUNO COSTA LIMA', 1001.06], ['CARLA DIAS MOTA', 1351.78], ['DANIEL FARIAS ROCHA', 1725], ['EDNA GOMES SILVA', 119.12]].map(([nome, v], i) => ({ id: 'l' + i, nome, matricula: String(i + 1), cpf: String(22200000000 + i), loja: 1, setor: 'Loja', cargo: 'Op', ativo: true, v }));
  const deps = { colaboradores: async () => ({ ativos: F, desligados: [] }), cpfDe: async id => (F.find(f => f.id === id) || {}).cpf || '' };
  const wb = new (require('exceljs').Workbook)(); const ws = wb.addWorksheet('f'); ws.addRow(['Nome', 'Valor']); for (const f of F) ws.addRow([f.nome, f.v]);
  const pv = await A.importarPrevia(Buffer.from(await wb.xlsx.writeBuffer()), 'folha-e1.xlsx', 'folha', '2026-09', coord, deps, 1); A.importarConfirmar(pv.token, coord);
  const lote = (valor, n) => ({ type: 'agrupamento', operation: 'D', amount: { value: valor }, number_events: n, date: { accounting: '2026-09-30' }, literal: { shortened: 'SISPAG SALARIOS' } });
  // lote de 3 = ANA + BRUNO + CARLA (3458.36); lote de 2 = 1725 + 119.12 NÃO existe (1844.12 ≠ 1900) → fica não pago
  const extrato = async ({ conta }) => ({ data: [{ events: conta === 'cahu' ? [lote(3458.36, 3), lote(1900, 2)] : [] }] });
  const r = await A.conciliar('2026-09', coord, deps, { extrato });
  const sit = Object.fromEntries(r.funcionarios.map(f => [f.nome, f.folha.situacao]));
  assert.deepStrictEqual(sit, { 'ANA ALVES PEREIRA': 'lote', 'BRUNO COSTA LIMA': 'lote', 'CARLA DIAS MOTA': 'lote', 'DANIEL FARIAS ROCHA': 'nao_pago', 'EDNA GOMES SILVA': 'nao_pago' });
  assert.ok(r.funcionarios.find(f => f.nome === 'ANA ALVES PEREIRA').folha.modo.includes('3 pessoas'));
  assert.strictEqual(r.naoIdentificados.length, 1); assert.strictEqual(r.naoIdentificados[0].valor, 1900);
});

test('Auditoria da Folha: comprovantes SISPAG do Itaú (1 por página) casam nome a nome e explicam o lote do extrato', async () => {
  process.env.AUDITORIA_FOLHA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'af-comp-'));
  const A = require('../lib/auditoria-folha'); const PDFDocument = require('pdfkit');
  const F = [['ANA BEATRIZ FERREIRA DA COSTA MELO', 1351.78], ['MARIA APARECIDA GONCALVES DE SOUZA', 1166.53], ['PEDRO HENRIQUE ALMEIDA BARROS', 1725]].map(([nome, v], i) => ({ id: 'c' + i, nome, matricula: '', cpf: String(33300000000 + i), loja: 1, setor: 'Loja', cargo: 'Op', ativo: true, v }));
  const deps = { colaboradores: async () => ({ ativos: F, desligados: [] }), cpfDe: async id => (F.find(f => f.id === id) || {}).cpf || '' };
  const wb = new (require('exceljs').Workbook)(); const ws = wb.addWorksheet('f'); ws.addRow(['Nome', 'Valor']); for (const f of F) ws.addRow([f.nome, f.v]);
  const pv = await A.importarPrevia(Buffer.from(await wb.xlsx.writeBuffer()), 'folha-e1.xlsx', 'folha', '2026-09', coord, deps, 1); A.importarConfirmar(pv.token, coord);
  // PDF igual ao do Itaú Empresas: nome cortado em 30 caracteres, 2 páginas (a 3ª pessoa, JOSE MATHEUS, não tem comprovante)
  const pdf = await new Promise(res => { const d = new PDFDocument({ size: 'A4', margin: 40 }); const b = []; d.on('data', x => b.push(x)); d.on('end', () => res(Buffer.concat(b)));
    [['ANA BEATRIZ FERREIRA DA COSTA', '0001', '12345 - 6', '1.351,78', '000000000000001', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'], ['MARIA APARECIDA GONCALVES DE', '0002', '23456 - 7', '1.166,53', '000000000000002', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB']].forEach(([n, ag, cc, v, ctrl, aut], i) => { if (i) d.addPage();
      d.fontSize(11).text('Banco Itaú - Comprovante de Transferência').text('de conta corrente para conta corrente').text('Identificação no extrato: SISPAG SALARIOS').text('Dados da conta debitada:').text('Nome da empresa: EMPRESA EXEMPLO LTDA').text('Agência: 0000 Conta corrente: 00000 - 0').text('Dados da conta creditada:').text('Nome: ' + n).text('Agência: ' + ag + ' Conta corrente: ' + cc).text('Valor: R$ ' + v).text('Informações fornecidas pelo').text('pagador: FOLHA').text('Transferência efetuada em 30/09/2026 às 12:32:49 via Sispag, CTRL ' + ctrl + '.').text('Autenticação:').text(aut); });
    d.end(); });
  const pc = await A.importarPrevia(pdf, 'comprovantes-e1.pdf', 'comprovantes', '2026-09', coord, deps, 1);
  assert.strictEqual(pc.funcionarios, 2); assert.strictEqual(pc.identificados, 2); assert.strictEqual(pc.linhas[0].funcionario.nome, 'ANA BEATRIZ FERREIRA DA COSTA MELO'); assert.strictEqual(pc.linhas[0].ctrl, '000000000000001');
  A.importarConfirmar(pc.token, coord);
  const lote = { type: 'agrupamento', operation: 'D', amount: { value: 2518.31 }, number_events: 2, date: { accounting: '2026-09-30' }, literal: { shortened: 'SISPAG SALARIOS' } };
  const r = await A.conciliar('2026-09', coord, deps, { extrato: async ({ conta }) => ({ data: [{ events: conta === 'cahu' ? [lote] : [] }] }) });
  const porNome = Object.fromEntries(r.funcionarios.map(f => [f.nome, f.folha]));
  assert.strictEqual(porNome['ANA BEATRIZ FERREIRA DA COSTA MELO'].situacao, 'pago'); assert.ok(porNome['ANA BEATRIZ FERREIRA DA COSTA MELO'].modo.includes('CTRL 000000000000001'));
  assert.strictEqual(porNome['MARIA APARECIDA GONCALVES DE SOUZA'].situacao, 'pago'); assert.strictEqual(porNome['PEDRO HENRIQUE ALMEIDA BARROS'].situacao, 'nao_pago');
  assert.strictEqual(r.naoIdentificados.length, 0, 'lote coberto pelos comprovantes não pode sobrar como não identificado');
  assert.deepStrictEqual(r.conciliacao.comprovantes, { total: 2, usados: 2 });
  const pc2 = await A.importarPrevia(pdf, 'comprovantes-e1.pdf', 'comprovantes', '2026-09', coord, deps, 1); assert.strictEqual(pc2.repetidos, 2); assert.strictEqual(pc2.funcionarios, 0);
});
