// Parser do extrato bancário Itaú (formato TXT: data;historico;valor;)
// Usado pelo Conciliador para extrair as saídas (valor negativo) do extrato.

const RE_CNPJ = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
const RE_CPF = /\d{3}\.\d{3}\.\d{3}-\d{2}/;

const TIPOS_FORNECEDOR = ['BOLETO PAGO', 'PIX ENVIADO'];
const TIPOS_TRIBUTO = ['PAGAMENTOS TRIB COD BARRAS', 'PAGAMENTOS PIX QR-CODE'];
const TIPOS_TARIFA_JUROS = ['TAR ', 'IOF', 'JUROS LIMITE DA CONTA'];
const TIPOS_APLICACAO = ['APL APLIC AUT MAIS', 'RES APLIC AUT MAIS'];
const TIPOS_SALARIO = ['SISPAG SALARIOS'];

// Extratos de conta que paga fornecedor via SISPAG (ex: CD) usam "SISPAG
// DIVERSOS ..." em vez de "BOLETO PAGO"/"PIX ENVIADO" — mesma ideia (saída
// pra um favorecido), formato de histórico diferente. Ordem importa: do
// prefixo mais específico pro mais genérico, senão o genérico casa primeiro
// e sobra "PAG TIT BANCO 237 FACCHINI" em vez de só "FACCHINI".
const PREFIXOS_SISPAG_DIVERSOS = [
  /^SISPAG DIVERSOS PAG TIT BANCO \d{3}\s*/i,
  /^SISPAG DIVERSOS PAG TIT \d+\s*/i,
  /^SISPAG DIVERSOS PIX QR-CODE\s*/i,
  /^SISPAG DIVERSOS\s*/i
];

function classificar(historico) {
  const h = historico.trim();
  if (TIPOS_FORNECEDOR.some(t => h.startsWith(t))) return h.startsWith('BOLETO PAGO') ? 'boleto_pago' : 'pix_enviado';
  if (TIPOS_TRIBUTO.some(t => h.startsWith(t))) return 'tributo';
  if (TIPOS_SALARIO.some(t => h.startsWith(t))) return 'salario';
  if (TIPOS_APLICACAO.some(t => h.startsWith(t))) return 'aplicacao';
  if (TIPOS_TARIFA_JUROS.some(t => h.startsWith(t))) return 'tarifa_juros';
  if (h.startsWith('PIX DEVOLVIDO')) return 'pix_devolvido';
  return 'outro';
}

function extrairDocumento(historico) {
  const cnpj = historico.match(RE_CNPJ);
  if (cnpj) return { doc: cnpj[0], tipoDoc: 'CNPJ' };
  const cpf = historico.match(RE_CPF);
  if (cpf) return { doc: cpf[0], tipoDoc: 'CPF' };
  return { doc: null, tipoDoc: null };
}

// Extrai o nome do favorecido: tudo entre o prefixo do tipo e o documento (CNPJ/CPF).
function extrairFavorecido(historico, categoria, doc) {
  let resto = historico.trim();
  if (categoria === 'boleto_pago') resto = resto.replace(/^BOLETO PAGO\s*/, '');
  else if (categoria === 'pix_enviado') resto = resto.replace(/^PIX ENVIADO\s*/, '');
  else if (categoria === 'tributo') resto = resto.replace(/^PAGAMENTOS (TRIB COD BARRAS|PIX QR-CODE)\s*/, '');
  else {
    for (const re of PREFIXOS_SISPAG_DIVERSOS) {
      if (re.test(resto)) { resto = resto.replace(re, ''); break; }
    }
  }
  if (doc) resto = resto.split(doc)[0];
  return resto.trim().replace(/\s+/g, ' ');
}

function parseValor(str) {
  return parseFloat(String(str).trim().replace(/\./g, '').replace(',', '.'));
}

function parseData(str) {
  const [d, m, y] = str.trim().split('/');
  return `${y}-${m}-${d}`;
}

function parseValorOfx(str) {
  return parseFloat(String(str).trim());
}

function parseDataOfx(str) {
  // formato OFX: YYYYMMDD ou YYYYMMDDHHMMSS[.xxx][+-tz]
  const m = String(str).trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo}-${d}`;
}

// Parseia um extrato OFX (Open Financial Exchange) e retorna somente as
// saídas (valor negativo). Reaproveita a mesma classificação/extração de
// CNPJ do TXT — o campo MEMO do OFX do Itaú carrega o mesmo texto de
// histórico do extrato TXT (mesma origem de dados no banco).
function parseSaidasOfx(ofxContent) {
  const saidas = [];
  const blocos = ofxContent.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  for (const bloco of blocos) {
    const dtM = bloco.match(/<DTPOSTED>([^\r\n<]+)/i);
    const valM = bloco.match(/<TRNAMT>([^\r\n<]+)/i);
    const memoM = bloco.match(/<MEMO>([^\r\n<]+)/i);
    const nameM = bloco.match(/<NAME>([^\r\n<]+)/i);
    if (!dtM || !valM) continue;

    const valor = parseValorOfx(valM[1]);
    if (isNaN(valor) || valor >= 0) continue;

    const data = parseDataOfx(dtM[1]);
    if (!data) continue;

    const historico = [nameM && nameM[1].trim(), memoM && memoM[1].trim()]
      .filter(Boolean).join(' ').trim() || '(sem histórico)';

    const categoria = classificar(historico);
    const { doc, tipoDoc } = extrairDocumento(historico);
    const favorecido = extrairFavorecido(historico, categoria, doc);

    const [y, mo, d] = data.split('-');
    saidas.push({
      data,
      dataBr: `${d}/${mo}/${y}`,
      historico,
      valor: Math.abs(valor),
      categoria,
      favorecido,
      documento: doc,
      tipoDocumento: tipoDoc
    });
  }
  return saidas;
}

// Parseia o TXT completo e retorna somente as saídas (valor negativo).
function parseSaidas(txtContent) {
  const linhas = txtContent.split(/\r?\n/).filter(l => l.trim());
  const saidas = [];
  for (const linha of linhas) {
    const partes = linha.split(';');
    if (partes.length < 3) continue;
    const [dataStr, historico, valorStr] = partes;
    if (!dataStr || !historico) continue;
    const valor = parseValor(valorStr);
    if (isNaN(valor) || valor >= 0) continue;

    const categoria = classificar(historico);
    const { doc, tipoDoc } = extrairDocumento(historico);
    const favorecido = extrairFavorecido(historico, categoria, doc);

    saidas.push({
      data: parseData(dataStr),
      dataBr: dataStr.trim(),
      historico: historico.trim(),
      valor: Math.abs(valor),
      categoria,
      favorecido,
      documento: doc,
      tipoDocumento: tipoDoc
    });
  }
  return saidas;
}

module.exports = { parseSaidas, parseSaidasOfx, classificar, extrairDocumento, extrairFavorecido };
