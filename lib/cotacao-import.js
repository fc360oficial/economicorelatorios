// Importação de fornecedores da Cotação a partir de planilha (Excel exportado do Club da Cotação, ou qualquer
// planilha com colunas Fornecedor / CNPJ / Vendedor / Telefone / Email). Tiago, 15/09/2026: "os fornecedores
// estão no Excel". Lê a planilha, acha a linha de cabeçalho, e casa cada fornecedor com o cadastro do ERP:
//   1. pelo CNPJ (só dígitos)  2. pelo nome normalizado igual  3. nome contido / palavras em comum (parcial)
// Nada é escrito no ERP.
const ExcelJS = require('exceljs');

const dig = v => String(v ?? '').replace(/\D/g, '');
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const GENERICAS = new Set(['LTDA', 'ME', 'EPP', 'EIRELI', 'SA', 'S A', 'CIA', 'COMERCIO', 'COMERCIAL', 'DISTRIBUIDORA', 'DISTRIBUIDOR', 'DISTRIBUICAO', 'ATACADO', 'ATACADISTA', 'ALIMENTOS', 'DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'IND', 'INDUSTRIA', 'PRODUTOS', 'REPRESENTACOES', 'REPRESENTACAO', 'LTDA ME']);
const tokens = s => norm(s).split(' ').filter(t => t && !GENERICAS.has(t) && t.length > 1);
const celVal = c => { if (c == null) return ''; if (typeof c === 'object') { if (c.text != null) return String(c.text); if (c.result != null) return String(c.result); if (c.richText) return c.richText.map(r => r.text).join(''); if (c.hyperlink && c.text) return String(c.text); return ''; } return String(c); };
const vazio = v => { const t = String(v ?? '').trim(); return !t || t === '--' || t === '-'; };

// lê a planilha (buffer) → linhas normalizadas
async function parsePlanilha(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Planilha vazia');
  // cabeçalho = primeira linha que tem uma célula "Fornecedor" (ou "Razão")
  let hdrRow = null, map = {};
  ws.eachRow((row, n) => {
    if (hdrRow) return;
    const vals = row.values.map(celVal);
    const idx = {};
    vals.forEach((v, i) => { const k = norm(v); if (!k) return;
      if (!idx.nome && /^(FORNECEDOR|RAZAO|RAZAO SOCIAL|NOME|EMPRESA)$/.test(k)) idx.nome = i;
      if (!idx.cnpj && /CNPJ/.test(k)) idx.cnpj = i;
      if (!idx.vendedor && /^VENDEDOR|REPRESENTANTE|CONTATO$/.test(k)) idx.vendedor = i;
      if (!idx.telVend && /(TEL|FONE|CEL|WHATS).*(VENDEDOR|CONTATO)|^WHATS/.test(k)) idx.telVend = i;
      if (!idx.telefone && /^(TELEFONE|TEL|FONE|CELULAR)$/.test(k)) idx.telefone = i;
      if (!idx.email && /MAIL/.test(k)) idx.email = i;
      if (!idx.cond && /COND/.test(k)) idx.cond = i;
      if (!idx.id && /^(ID|CODIGO|COD)$/.test(k)) idx.id = i;
    });
    if (idx.nome) { hdrRow = n; map = idx; }
  });
  if (!hdrRow) throw new Error('Não achei a coluna "Fornecedor" na planilha');
  const linhas = [];
  ws.eachRow((row, n) => {
    if (n <= hdrRow) return;
    const v = i => (i ? celVal(row.values[i]).trim() : '');
    const nome = v(map.nome); if (!nome || /^(total|fornecedor)$/i.test(nome)) return;
    const telVend = dig(vazio(v(map.telVend)) ? '' : v(map.telVend)), tel = dig(vazio(v(map.telefone)) ? '' : v(map.telefone));
    linhas.push({ linha: n, id_planilha: vazio(v(map.id)) ? null : v(map.id), nome, cnpj: dig(v(map.cnpj)), vendedor: vazio(v(map.vendedor)) ? '' : v(map.vendedor), whats: telVend || tel || '', email: vazio(v(map.email)) ? '' : v(map.email), condicao: vazio(v(map.cond)) ? '' : v(map.cond) });
  });
  return { cabecalho: hdrRow, colunas: map, linhas };
}

// casa cada linha com o cadastro do ERP: fornecedores = [{ CodFornec, Nome, NomeCompleto, CNPJ }]
function casar(linhas, fornecedores) {
  const porCnpj = {}, porNome = {}, lista = [];
  for (const f of fornecedores || []) {
    const cod = +f.CodFornec; if (!cod) continue;
    const nome = String(f.NomeCompleto || f.Nome || '').trim(), curto = String(f.Nome || '').trim();
    const item = { codFornec: cod, nome, curto, cnpj: dig(f.CNPJ), n1: norm(nome), n2: norm(curto), t: new Set(tokens(nome).concat(tokens(curto))) };
    lista.push(item);
    const c = dig(f.CNPJ); if (c.length >= 11) porCnpj[c] = item;
    if (item.n1) porNome[item.n1] = item; if (item.n2) porNome[item.n2] = porNome[item.n2] || item;
  }
  // Club da Cotação põe o estado no fim do nome ("ATACADAO - PE", "ARMAZENS MARTINS - MG"): sai antes de casar
  const semUf = s => String(s || '').replace(/\s*[-–]\s*[A-Z]{2}\s*$/i, '').trim();
  return linhas.map(l => {
    let m = null, como = null, score = 0;
    const nomeL = semUf(l.nome);
    if (l.cnpj.length >= 11 && porCnpj[l.cnpj]) { m = porCnpj[l.cnpj]; como = 'cnpj'; score = 1; }
    if (!m) { const n = norm(nomeL); if (n && porNome[n]) { m = porNome[n]; como = 'nome'; score = 1; } }
    if (!m) {
      const n = norm(nomeL), tk = tokens(nomeL);
      let best = null, bs = 0;
      for (const f of lista) {
        let s = 0;
        if (n.length >= 6 && (f.n1.startsWith(n) || f.n2.startsWith(n) || (f.n1.length >= 6 && n.startsWith(f.n1)) || (f.n2.length >= 6 && n.startsWith(f.n2)))) s = 0.9;
        else if (tk.length && f.t.has(tk[0])) { const comum = tk.filter(t => f.t.has(t)).length; const j = comum / Math.max(tk.length, 1); if (comum >= 1 && j >= 0.6) s = 0.5 + j * 0.3; else if (comum >= 2) s = 0.55; }
        if (s > bs) { bs = s; best = f; }
      }
      if (best && bs >= 0.5) { m = best; como = bs >= 0.9 ? 'nome' : 'parcial'; score = bs; }
    }
    return { ...l, codFornec: m ? m.codFornec : 0, nome_erp: m ? m.nome : null, cnpj_erp: m ? m.cnpj : null, como, score: +score.toFixed(2) };
  });
}

module.exports = { parsePlanilha, casar, norm, tokens };
