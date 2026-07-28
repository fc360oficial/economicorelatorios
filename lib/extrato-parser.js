// Parser do extrato bancário Itaú (formato TXT: data;historico;valor;)
// Usado pelo Conciliador para extrair as saídas (valor negativo) do extrato.

const RE_CNPJ = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
const RE_CPF = /\d{3}\.\d{3}\.\d{3}-\d{2}/;

const TIPOS_FORNECEDOR = ['BOLETO PAGO', 'PIX ENVIADO'];
const TIPOS_TRIBUTO = ['PAGAMENTOS TRIB COD BARRAS', 'PAGAMENTOS PIX QR-CODE'];
const TIPOS_TARIFA_JUROS = ['TAR ', 'IOF', 'JUROS LIMITE DA CONTA'];
const TIPOS_APLICACAO = ['APL APLIC AUT MAIS', 'RES APLIC AUT MAIS'];
const TIPOS_SALARIO = ['SISPAG SALARIOS'];

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

module.exports = { parseSaidas, classificar, extrairDocumento, extrairFavorecido };
