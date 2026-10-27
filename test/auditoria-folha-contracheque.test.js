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
