// Parser do extrato bancário Itaú (formato TXT: data;historico;valor;)
// Usado pelo Conciliador para extrair as saídas (valor negativo) do extrato.

const RE_CNPJ = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
const RE_CPF = /\d{3}\.\d{3}\.\d{3}-\d{2}/;

const TIPOS_FORNECEDOR = ['BOLETO PAGO', 'PIX ENVIADO'];
const TIPOS_TRIBUTO = ['PAGAMENTOS TRIB COD BARRAS', 'PAGAMENTOS PIX QR-CODE'];
const TIPOS_TARIFA_JUROS = ['TAR ', 'IOF', 'JUROS LIMITE DA CONTA'];
const TIPOS_APLICACAO = ['APL APLIC AUT MAIS', 'RES APLIC AUT MAIS'];
const TIPOS_SALARIO = ['SISPAG SALARIOS'];

// Categorização best-effort das ENTRADAS — diferente das saídas, ainda não
// foi validada contra extrato real (o Tiago vai confirmar os padrões reais
// quando processar o primeiro extrato de verdade; se aparecer um prefixo
// novo, seguir o mesmo padrão de refinamento incremental já usado acima
// pras saídas, ex: achado de "SISPAG DIVERSOS" em 03/09/2026).
const OPERADORAS_CARTAO = [
  'REDE', 'CIELO', 'GETNET', 'STONE', 'PAGSEGURO', 'PAGBANK',
  'MERCADOPAGO', 'SAFRAPAY', 'VERO', 'FISERV'
];

function classificarEntrada(historico) {
  const h = historico.trim().toUpperCase();
  if (h.startsWith('PIX RECEBIDO')) return 'pix_recebido';
  if (h.startsWith('BOLETO RECEBIDO') || h.startsWith('TED RECEBID') || h.startsWith('DOC RECEBID') || h.startsWith('DEPOSITO')) return 'deposito_boleto';
  if (OPERADORAS_CARTAO.some(op => h.includes(op))) return 'cartao';
  return 'outro';
}

function extrairFavorecidoEntrada(historico, categoria, doc) {
  let resto = historico.trim();
  if (categoria === 'pix_recebido') resto = resto.replace(/^PIX RECEBIDO\s*/i, '');
  else if (categoria === 'deposito_boleto') resto = resto.replace(/^(BOLETO RECEBIDO|TED RECEBID[AO]|DOC RECEBID[AO]|DEPOSITO)\s*/i, '');
  if (doc) resto = resto.split(doc)[0];
  return resto.trim().replace(/\s+/g, ' ');
}

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

// Mapa de código de lançamento (API oficial do Itaú, ver lib/itau-extrato.js)
// pra categoria — a API usa um vocabulário de "literal.code"/"literal.shortened"
// diferente do TXT exportado pelo site (ex: "BOLETO  PAGO" com 2 espaços,
// "SISPAG TRIB..." em vez de "PAGAMENTOS TRIB..."), então não dá pra reusar
// classificar() direto. Só 'boleto_pago' e 'pix_enviado' entram no cruzamento
// contra o ERP (ver conciliador.js) — o resto é só pra completude da tela.
//
// Achado 03/09/2026: as contas da agência 0877 (Muribeca, Ponte, Atacarejo,
// Porta Larga, Jardim Jordão) pagam fornecedor via lote SISPAG (código 7549
// "SISPAG FORNECEDORES PAG TIT..."), não boleto avulso (código 9678, usado
// só pela Cahu/agência 8302) — sem o 7549 aqui, ~95% dos pagamentos dessas
// lojas caía em "fora do escopo" e nunca era cruzado contra o ERP.
const CODIGO_CATEGORIA_API = {
  '9678': 'boleto_pago',
  '7549': 'boleto_pago',
  '9676': 'pix_enviado',
  '9498': 'pix_devolvido',
  '8512': 'aplicacao',
  '0793': 'tarifa_juros',
  '1209': 'tarifa_juros'
};

function classificarApi(literal) {
  const code = literal.code;
  if (CODIGO_CATEGORIA_API[code]) return CODIGO_CATEGORIA_API[code];
  const texto = (literal.shortened || literal.complete || '').trim();
  if (texto.startsWith('TAR ')) return 'tarifa_juros';
  if (texto.startsWith('SISPAG SALARIOS')) return 'salario';
  if (texto.startsWith('SISPAG TRIB') || texto === 'SISPAG PIX QR-CODE') return 'tributo';
  return 'outro';
}

// Converte o retorno da API oficial do Itaú (lib/itau-extrato.js
// buscarExtrato) no mesmo formato de saída de parseSaidas/parseSaidasOfx.
// Ao contrário do TXT/OFX, a API já traz favorecido e documento estruturados
// (counterpart.name/document) — não precisa extrair de texto por regex.
function parseSaidasApi(apiResult) {
  const eventos = (apiResult.data || []).flatMap(d => d.events || []);
  const saidas = [];
  for (const ev of eventos) {
    if (ev.type !== 'lancamento' || ev.operation !== 'D') continue;
    const valor = Number(ev.amount && ev.amount.value);
    if (isNaN(valor)) continue;

    const data = ev.date && ev.date.accounting;
    if (!data) continue;
    const [y, mo, d] = data.split('-');

    const historico = ((ev.literal && (ev.literal.complete || ev.literal.shortened)) || '(sem histórico)').trim().replace(/\s+/g, ' ');
    const categoria = classificarApi(ev.literal || {});
    const cp = ev.counterpart || {};
    const documento = cp.document || null;
    const tipoDocumento = cp.person === 'FISICA' ? 'CPF' : (cp.person === 'JURIDICA' ? 'CNPJ' : null);
    const favorecido = cp.name || extrairFavorecido(historico, categoria, documento);

    saidas.push({
      data,
      dataBr: `${d}/${mo}/${y}`,
      historico,
      valor: Math.abs(valor),
      categoria,
      favorecido,
      documento,
      tipoDocumento
    });
  }
  return saidas;
}

// Mesma ideia de classificarApi (saídas), mas pro vocabulário de entrada.
// Como classificarApi(saídas), foi ajustado com achados reais ao longo do
// tempo (ver comentário acima de CODIGO_CATEGORIA_API) — aqui ainda não
// existe um mapa de código validado pra entrada, então usa só o texto
// (literal.shortened/complete) até aparecer um extrato real da API pra
// confirmar os códigos.
function classificarApiEntrada(literal) {
  const texto = (literal.shortened || literal.complete || '').trim().toUpperCase();
  if (texto.startsWith('PIX RECEBIDO')) return 'pix_recebido';
  if (texto.startsWith('BOLETO RECEBIDO') || texto.startsWith('TED RECEBID') || texto.startsWith('DOC RECEBID') || texto.startsWith('DEPOSITO')) return 'deposito_boleto';
  if (OPERADORAS_CARTAO.some(op => texto.includes(op))) return 'cartao';
  return 'outro';
}

// Converte o retorno da API oficial do Itaú (lib/itau-extrato.js
// buscarExtrato) em entradas (operation === 'C', crédito) no mesmo formato
// de parseEntradas/parseEntradasOfx.
function parseEntradasApi(apiResult) {
  const eventos = (apiResult.data || []).flatMap(d => d.events || []);
  const entradas = [];
  for (const ev of eventos) {
    if (ev.type !== 'lancamento' || ev.operation !== 'C') continue;
    const valor = Number(ev.amount && ev.amount.value);
    if (isNaN(valor) || valor <= 0) continue;

    const data = ev.date && ev.date.accounting;
    if (!data) continue;
    const [y, mo, d] = data.split('-');

    const historico = ((ev.literal && (ev.literal.complete || ev.literal.shortened)) || '(sem histórico)').trim().replace(/\s+/g, ' ');
    const categoria = classificarApiEntrada(ev.literal || {});
    const cp = ev.counterpart || {};
    const documento = cp.document || null;
    const tipoDocumento = cp.person === 'FISICA' ? 'CPF' : (cp.person === 'JURIDICA' ? 'CNPJ' : null);
    const favorecido = cp.name || extrairFavorecidoEntrada(historico, categoria, documento);

    entradas.push({
      data,
      dataBr: `${d}/${mo}/${y}`,
      historico,
      valor,
      categoria,
      favorecido,
      documento,
      tipoDocumento
    });
  }
  return entradas;
}

// Parseia o TXT completo e retorna somente as entradas (valor positivo).
function parseEntradas(txtContent) {
  const linhas = txtContent.split(/\r?\n/).filter(l => l.trim());
  const entradas = [];
  for (const linha of linhas) {
    const partes = linha.split(';');
    if (partes.length < 3) continue;
    const [dataStr, historico, valorStr] = partes;
    if (!dataStr || !historico) continue;
    const valor = parseValor(valorStr);
    if (isNaN(valor) || valor <= 0) continue;

    const categoria = classificarEntrada(historico);
    const { doc, tipoDoc } = extrairDocumento(historico);
    const favorecido = extrairFavorecidoEntrada(historico, categoria, doc);

    entradas.push({
      data: parseData(dataStr),
      dataBr: dataStr.trim(),
      historico: historico.trim(),
      valor,
      categoria,
      favorecido,
      documento: doc,
      tipoDocumento: tipoDoc
    });
  }
  return entradas;
}

// Mesma ideia de parseSaidasOfx, mas filtra valor positivo (entrada).
function parseEntradasOfx(ofxContent) {
  const entradas = [];
  const blocos = ofxContent.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  for (const bloco of blocos) {
    const dtM = bloco.match(/<DTPOSTED>([^\r\n<]+)/i);
    const valM = bloco.match(/<TRNAMT>([^\r\n<]+)/i);
    const memoM = bloco.match(/<MEMO>([^\r\n<]+)/i);
    const nameM = bloco.match(/<NAME>([^\r\n<]+)/i);
    if (!dtM || !valM) continue;

    const valor = parseValorOfx(valM[1]);
    if (isNaN(valor) || valor <= 0) continue;

    const data = parseDataOfx(dtM[1]);
    if (!data) continue;

    const historico = [nameM && nameM[1].trim(), memoM && memoM[1].trim()]
      .filter(Boolean).join(' ').trim() || '(sem histórico)';

    const categoria = classificarEntrada(historico);
    const { doc, tipoDoc } = extrairDocumento(historico);
    const favorecido = extrairFavorecidoEntrada(historico, categoria, doc);

    const [y, mo, d] = data.split('-');
    entradas.push({
      data,
      dataBr: `${d}/${mo}/${y}`,
      historico,
      valor,
      categoria,
      favorecido,
      documento: doc,
      tipoDocumento: tipoDoc
    });
  }
  return entradas;
}

module.exports = {
  parseSaidas, parseSaidasOfx, parseSaidasApi, classificar, extrairDocumento, extrairFavorecido,
  parseEntradas, parseEntradasOfx, classificarEntrada, extrairFavorecidoEntrada, parseEntradasApi
};
