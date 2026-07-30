// Controle de Ponta de Gôndola: quem negocia (comprador), qual fornecedor
// ocupa cada ponta, por quanto tempo, e o contrato assinado dessa negociação.
// Digitaliza o painel físico que fica na sala de compras.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const DATA_PATH = path.join(__dirname, '..', 'data', 'pontas-gondola.json');
const CONTRATOS_DIR = path.join(__dirname, '..', 'data', 'contratos-ponta-gondola');

// Mesmo mapeamento de loja já usado no resto do sistema.
const LOJAS = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JD JORDÃO' };

// Quantidade de pontas por loja no painel físico de hoje — só o ponto de
// partida; dá pra adicionar/remover ponta por loja depois de criado.
const QTD_INICIAL = { 1: 6, 2: 6, 3: 6, 4: 16, 5: 10, 6: 8 };

function carregarPontas() {
  try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch (e) { return criarSeed(); }
}

function salvarPontas(lista) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(lista, null, 2));
}

function criarSeed() {
  const lista = [];
  let id = 1;
  for (const loja of Object.keys(QTD_INICIAL).map(Number)) {
    for (let numero = 1; numero <= QTD_INICIAL[loja]; numero++) {
      lista.push({
        id: id++, loja, numero,
        comprador: null, fornecedor: null, inicio: null, fim: null, valor: null,
        contratoArquivo: null, contratoEnviadoEm: null, contratoEnviadoPor: null,
        atualizadoEm: null, atualizadoPor: null
      });
    }
  }
  salvarPontas(lista);
  return lista;
}

// >15 dias pro fim: ok. <=15: atenção (amarelo). <=10: comprar (laranja).
// já passou do fim: vencido (vermelho). Sem contrato/fim definido: livre.
function calcularStatus(fim) {
  if (!fim) return { status: 'livre', diasRestantes: null };
  const hoje = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const dataFim = new Date(fim + 'T00:00:00Z');
  const diasRestantes = Math.round((dataFim - hoje) / 86400000);
  if (diasRestantes < 0) return { status: 'vencido', diasRestantes };
  if (diasRestantes <= 10) return { status: 'comprar', diasRestantes };
  if (diasRestantes <= 15) return { status: 'atencao', diasRestantes };
  return { status: 'ok', diasRestantes };
}

function comPlano(lista) {
  return lista.map(p => ({ ...p, lojaNome: LOJAS[p.loja], ...calcularStatus(p.fim) }));
}

function fmtDataBr(iso) {
  if (!iso) return '____/____/______';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function fmtValor(v) {
  if (v == null || v === '') return '________________';
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MESES_EXTENSO = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
function dataHojeExtenso() {
  const hoje = new Date();
  return `${hoje.getDate()} de ${MESES_EXTENSO[hoje.getMonth()]} de ${hoje.getFullYear()}`;
}

// Gera o modelo de contrato preenchido com os dados já cadastrados da
// negociação (comprador, fornecedor, loja, ponta, vigência) — o Tiago baixa,
// providencia a assinatura das partes e devolve o assinado via upload.
function gerarModeloPdf(ponta, res) {
  const doc = new PDFDocument({ margin: 56, size: 'A4' });
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(15).text('CONTRATO DE CESSÃO DE PONTA DE GÔNDOLA', { align: 'center' });
  doc.moveDown(1.4);

  doc.font('Helvetica-Bold').fontSize(10.5).text('LOJA (CEDENTE): ', { continued: true })
    .font('Helvetica').text(LOJAS[ponta.loja] || `Loja ${ponta.loja}`);
  doc.font('Helvetica-Bold').text('PONTA DE GÔNDOLA: ', { continued: true })
    .font('Helvetica').text(`Ponta ${ponta.numero}`);
  doc.font('Helvetica-Bold').text('COMPRADOR(A) RESPONSÁVEL: ', { continued: true })
    .font('Helvetica').text(ponta.comprador || '________________________');
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').text('FORNECEDOR (CESSIONÁRIO): ', { continued: true })
    .font('Helvetica').text(ponta.fornecedor || '________________________');
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').text('VIGÊNCIA: ', { continued: true })
    .font('Helvetica').text(`${fmtDataBr(ponta.inicio)} a ${fmtDataBr(ponta.fim)}`);
  doc.font('Helvetica-Bold').text('VALOR DO ACORDO: ', { continued: true })
    .font('Helvetica').text(fmtValor(ponta.valor));

  doc.moveDown(1.6);
  doc.font('Helvetica').fontSize(10).text(
    'Pelo presente instrumento, as partes acima identificadas ajustam a cessão onerosa do espaço de ' +
    'ponta de gôndola indicado, destinado à exposição e comercialização de produtos do FORNECEDOR, ' +
    'pelo período de vigência informado, mediante as condições comerciais previamente negociadas entre ' +
    'as partes.\n\n' +
    'Findo o prazo de vigência sem renovação expressa entre as partes, o espaço retorna à disponibilidade ' +
    'da LOJA para nova negociação, independentemente de notificação prévia.',
    { align: 'justify', lineGap: 3 }
  );

  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(9.5).text(`Recife, ${dataHojeExtenso()}`, { align: 'right' });

  doc.moveDown(3);
  const y = doc.y;
  doc.moveTo(56, y).lineTo(266, y).stroke();
  doc.moveTo(330, y).lineTo(540, y).stroke();
  doc.fontSize(9.5)
    .text(LOJAS[ponta.loja] || `Loja ${ponta.loja}`, 56, y + 4, { width: 210, align: 'center' })
    .text(ponta.fornecedor || 'Fornecedor', 330, y + 4, { width: 210, align: 'center' });

  doc.end();
}

module.exports = { LOJAS, QTD_INICIAL, carregarPontas, salvarPontas, calcularStatus, comPlano, CONTRATOS_DIR, gerarModeloPdf };
