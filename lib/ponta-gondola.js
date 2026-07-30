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

// Razão social, CNPJ e endereço de cada loja (cada uma é um CNPJ próprio) —
// usado no cabeçalho e no campo COMPRADORA do modelo de contrato. Vem do
// cadastro do ERP (tela de Fornecedor de cada loja), não existe em tabela
// consultável — se abrir filial nova, atualizar aqui manualmente.
const LOJAS_INFO = {
  1: {
    razaoSocial: 'CAHU COMERCIO DE ALIMENTOS LTDA',
    cnpj: '21425302000181',
    endereco: 'Avenida General Manoel Rabelo, 3120, Socorro, Jaboatão dos Guararapes - PE'
  },
  2: {
    razaoSocial: 'MURIBECA COMERCIO DE ALIMENTOS EIRELI',
    cnpj: '30148015000162',
    endereco: 'Rua Três, 02, Galpão, Muribeca, Jaboatão dos Guararapes - PE'
  },
  3: {
    razaoSocial: 'PONTE DOS CARVALHOS COMERCIO DE ALIMENTOS LTDA',
    cnpj: '39762002000153',
    endereco: 'Avenida Prefeito Diógenes Ferreira de Melo, 29, Ponte dos Carvalhos, Cabo de Santo Agostinho - PE'
  },
  4: {
    razaoSocial: 'ATACAREJO ECONOMICO COMERCIO DE ALIMENTOS LTDA',
    cnpj: '43354844000194',
    endereco: 'Avenida Nossa Senhora do Bom Conselho, 153, Ponte dos Carvalhos, Cabo de Santo Agostinho - PE'
  },
  5: {
    razaoSocial: 'PORTA LARGA COMERCIO DE ALIMENTOS LTDA',
    cnpj: '51632927000185',
    endereco: 'Avenida Armindo Moura, 396, Piedade, Jaboatão dos Guararapes - PE'
  },
  6: {
    razaoSocial: 'JARDIM JORDÃO ECONOMICO COMERCIO DE ALIMENTOS LTDA',
    cnpj: '59890722000101',
    endereco: 'Avenida Gonçalves Dias, 1499, Piedade, Jaboatão dos Guararapes - PE'
  }
};

function fmtCnpj(digits) {
  const d = String(digits).padStart(14, '0');
  return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12,14)}`;
}

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

function diasVigencia(inicio, fim) {
  if (!inicio || !fim) return null;
  return Math.round((new Date(fim + 'T00:00:00Z') - new Date(inicio + 'T00:00:00Z')) / 86400000) + 1;
}

// Gera o modelo de contrato preenchido com os dados já cadastrados da
// negociação (comprador, fornecedor, loja, ponta, vigência, valor) — o
// Tiago baixa, providencia a assinatura das partes e devolve o assinado
// via upload. Segue o modelo real de "Acordo Comercial" já usado na loja.
function gerarModeloPdf(ponta, res) {
  const info = LOJAS_INFO[ponta.loja] || {};
  const razaoSocial = info.razaoSocial || LOJAS[ponta.loja] || `Loja ${ponta.loja}`;
  const cnpjLoja = info.cnpj ? fmtCnpj(info.cnpj) : '__.___.___/____-__';
  const endereco = info.endereco || '________________________';
  const fornecedor = ponta.fornecedor || '________________________';
  const dias = diasVigencia(ponta.inicio, ponta.fim);
  const cidade = (endereco.split(',').pop() || 'Recife').split('-')[0].trim() || 'Recife';

  const doc = new PDFDocument({ margin: 56, size: 'A4' });
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(10).text(razaoSocial, { align: 'center' });
  doc.font('Helvetica').fontSize(9.5).text(cnpjLoja, { align: 'center' });
  doc.moveDown(1.4);

  doc.font('Helvetica-Bold').fontSize(13).text('ACORDO COMERCIAL', { align: 'center', underline: true });
  doc.moveDown(1.2);

  doc.font('Helvetica').fontSize(10.5).text(
    `Pelo presente acordo comercial, a empresa ${razaoSocial} situada na ${endereco}, inscrita no CNPJ ` +
    `${cnpjLoja}, doravante denominada COMPRADORA, e a empresa ${fornecedor} doravante denominada ` +
    `FORNECEDORA, assumem os compromissos constantes destes Termos:`,
    { align: 'justify', lineGap: 3 }
  );
  doc.moveDown(0.8);

  doc.font('Helvetica-Oblique').fontSize(10.5).text(
    `Acordo comercial de ponto extra para seção de espaço em Ponta de Gôndola (Ponta ${ponta.numero})` +
    `${dias ? `, com vigência de ${dias} dias` : ''} iniciando em ${fmtDataBr(ponta.inicio)} e término em ` +
    `${fmtDataBr(ponta.fim)}. O espaço será destinado exclusivamente à exposição dos produtos da linha, ` +
    `comercializados por meio da ${fornecedor}. A responsabilidade pela montagem, abastecimento e ` +
    `organização do ponto de gôndola será integralmente dos promotores da marca, conforme acordado ` +
    `previamente. Como contrapartida comercial por esta exposição, será realizado um investimento no ` +
    `valor total de ${fmtValor(ponta.valor)}, cujo pagamento será liquidado por meio de bonificação em ` +
    `mercadorias. A loja se compromete a garantir a exclusividade do espaço e a manutenção da ` +
    `precificação correta durante todo o período de vigência da ação.`,
    { align: 'justify', lineGap: 3 }
  );
  doc.moveDown(1.2);

  doc.font('Helvetica').text('Pagamento será em Bonificação informada pelo cliente.');
  doc.moveDown(1.2);

  doc.text(
    'E, por assim estarem justas e acertadas, as partes, por seus representantes legais firmam o presente instrumento.',
    { align: 'justify', lineGap: 3 }
  );

  doc.moveDown(1.6);
  doc.fontSize(9.5).text(`${cidade}, ${dataHojeExtenso()}`, { align: 'right' });

  doc.moveDown(4);
  const y1 = doc.y;
  doc.moveTo(56, y1).lineTo(300, y1).stroke();
  doc.fontSize(9.5).text(razaoSocial, 56, y1 + 4, { width: 244, align: 'center' });
  doc.text(cnpjLoja, 56, doc.y, { width: 244, align: 'center' });

  doc.moveDown(2);
  const y2 = doc.y;
  doc.moveTo(56, y2).lineTo(300, y2).stroke();
  doc.text(fornecedor, 56, y2 + 4, { width: 244, align: 'center' });

  doc.end();
}

module.exports = { LOJAS, QTD_INICIAL, carregarPontas, salvarPontas, calcularStatus, comPlano, CONTRATOS_DIR, gerarModeloPdf };
