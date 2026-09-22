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
// Casamento mais profundo (Tiago, 22/09: "razão social é uma coisa, nome fantasia outra, CNPJ outra — aí você concilia"):
//   0. conciliação já APROVADA pela compradora (data/cotacoes-conciliacao.json) — vale acima de tudo
//   1. CNPJ · 2. nome igual (fantasia OU razão social) · 3. telefone/WhatsApp do vendedor ou do cadastro do fornecedor
//   4. sigla (DLP = Distribuidora Logística Pernambuco) · 5. palavras parecidas (STYLO≈STYLE), sinônimos (OURO=GOLD)
//      e abreviações (DIST=DISTRIBUIDORA, LOG=LOGISTICA, PE=PERNAMBUCO, IMP=IMPORTACAO…)
//   Conciliação RECUSADA pela compradora nunca volta a ser sugerida pra aquele nome.
const SINONIMOS = { OURO: 'GOLD', GOLD: 'GOLD', STYLO: 'STYLE', ESTILO: 'STYLE', STYLE: 'STYLE', NORTH: 'NORTE', SOUTH: 'SUL', BRAZIL: 'BRASIL', HOUSE: 'CASA', KING: 'REI', STAR: 'ESTRELA', SUN: 'SOL', WORLD: 'MUNDO', LIFE: 'VIDA', GOOD: 'BOM', BOA: 'BOM', NEW: 'NOVO', NOVA: 'NOVO', BIG: 'GRANDE', GREEN: 'VERDE', BLUE: 'AZUL', SWEET: 'DOCE', FLAVOR: 'SABOR', FOOD: 'ALIMENTOS', FOODS: 'ALIMENTOS' };   // sempre pra UMA forma canônica (senão OURO→GOLD e GOLD→OURO nunca se encontram)
const ABREV = { DIST: 'DISTRIBUIDORA', DISTR: 'DISTRIBUIDORA', DISTRIB: 'DISTRIBUIDORA', DISTRIBUIDORA: 'DISTRIBUIDORA', DISTRIBUIDOR: 'DISTRIBUIDORA', DISTRIBUICAO: 'DISTRIBUIDORA', LOG: 'LOGISTICA', LOGIST: 'LOGISTICA', PE: 'PERNAMBUCO', PERNAMBICO: 'PERNAMBUCO', PERNAMB: 'PERNAMBUCO', IMP: 'IMPORTACAO', IMPOR: 'IMPORTACAO', IMPORT: 'IMPORTACAO', IMPORTADORA: 'IMPORTACAO', EXP: 'EXPORTACAO', EXPORT: 'EXPORTACAO', EXPORTADORA: 'EXPORTACAO', COM: 'COMERCIO', COML: 'COMERCIAL', IND: 'INDUSTRIA', INDL: 'INDUSTRIAL', ALIM: 'ALIMENTOS', ALIMENT: 'ALIMENTOS', ALIMENTICIOS: 'ALIMENTOS', ALIMENTICIA: 'ALIMENTOS', NORD: 'NORDESTE', NE: 'NORDESTE', SUPERM: 'SUPERMERCADO', SUPERMERCADOS: 'SUPERMERCADO', MERC: 'MERCANTIL', REPRES: 'REPRESENTACOES', REP: 'REPRESENTACOES', PROD: 'PRODUTOS', ATAC: 'ATACADO', ATACADISTA: 'ATACADO', ATACADAO: 'ATACADAO', HIG: 'HIGIENE', LIMP: 'LIMPEZA', BEB: 'BEBIDAS', FRIG: 'FRIGORIFICO', LATIC: 'LATICINIOS', LATICINIO: 'LATICINIOS', EMB: 'EMBALAGENS', EMBALAGEM: 'EMBALAGENS', SERV: 'SERVICOS', SERVICO: 'SERVICOS', TRANSP: 'TRANSPORTES', TRANSPORTE: 'TRANSPORTES', CIA: 'CIA', S: 'S', A: 'A' };
const CONECTORES = new Set(['DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'LTDA', 'ME', 'EPP', 'EIRELI', 'SA', 'S', 'A', 'CIA', 'EM', 'RECUPERACAO', 'JUDICIAL', 'FILIAL', 'MATRIZ']);
const expandir = t => ABREV[t] || t;
const canon = t => { const e = expandir(t); return SINONIMOS[e] || e; };
function lev(a, b) { if (a === b) return 0; const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let prev = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; }
const parecidos = (x, y) => x === y || (x.length >= 5 && y.length >= 5 && lev(x, y) <= 1) || (x.length >= 8 && y.length >= 8 && lev(x, y) <= 2);
// tokens "canônicos" pra comparar: expande abreviação, aplica sinônimo, tira genéricas e conectores
const tokC = s => norm(s).split(' ').filter(t => t && !CONECTORES.has(t)).map(canon).filter(t => t.length > 1 && !GENERICAS.has(t));
// sigla: primeira letra de cada palavra que não é conector (DLP ← Distribuidora [e] Logistica [de] Pernambuco [Impor…])
const sigla = s => norm(s).split(' ').filter(t => t && !CONECTORES.has(t)).map(t => t[0]).join('');
const fone8 = v => { const d = dig(v); return d.length >= 8 ? d.slice(-8) : ''; };

// opt = { telefones: { ultimos8 → codFornec }, aprovados: { norm(nome) → codFornec }, recusados: { norm(nome) → [codFornec] } }
function casar(linhas, fornecedores, opt) {
  opt = opt || {}; const TEL = opt.telefones || {}, APR = opt.aprovados || {}, REC = opt.recusados || {};
  const porCnpj = {}, porNome = {}, porCod = {}, lista = [];
  for (const f of fornecedores || []) {
    const cod = +f.CodFornec; if (!cod) continue;
    const nome = String(f.NomeCompleto || f.Nome || '').trim(), curto = String(f.Nome || '').trim();
    const item = { codFornec: cod, nome, curto, cnpj: dig(f.CNPJ), n1: norm(nome), n2: norm(curto), t: new Set(tokens(nome).concat(tokens(curto))), tc: [...new Set(tokC(nome).concat(tokC(curto)))], s1: sigla(nome), s2: sigla(curto) };
    lista.push(item); porCod[cod] = item;
    const c = dig(f.CNPJ); if (c.length >= 11) porCnpj[c] = item;
    if (item.n1) porNome[item.n1] = item; if (item.n2) porNome[item.n2] = porNome[item.n2] || item;
    for (const tel of [f.Fone, f.Celular, f.CelularCotacao]) { const k = fone8(tel); if (k && !TEL[k]) TEL[k] = cod; }
  }
  // Club da Cotação põe o estado no fim do nome ("ATACADAO - PE", "ARMAZENS MARTINS - MG"): sai antes de casar
  const semUf = s => String(s || '').replace(/\s*[-–]\s*[A-Z]{2}\s*$/i, '').trim();
  return linhas.map(l => {
    let m = null, como = null, score = 0;
    const nomeL = semUf(l.nome), n = norm(nomeL), recusa = new Set((REC[n] || []).map(Number));
    const ok = f => f && !recusa.has(f.codFornec);
    if (APR[n] && porCod[APR[n]]) { m = porCod[APR[n]]; como = 'aprovado'; score = 1; }
    if (!m && l.cnpj.length >= 11 && ok(porCnpj[l.cnpj])) { m = porCnpj[l.cnpj]; como = 'cnpj'; score = 1; }
    if (!m && n && ok(porNome[n])) { m = porNome[n]; como = 'nome'; score = 1; }
    if (!m) { for (const tel of [l.whats, l.telefone, l.fone, l.celular]) { const k = fone8(tel); if (k && TEL[k] && ok(porCod[TEL[k]])) { m = porCod[TEL[k]]; como = 'telefone'; score = 0.95; break; } } }
    if (!m) {
      const tk = tokens(nomeL), tc = tokC(nomeL), sg = n.replace(/ /g, '');
      let best = null, bs = 0, bc = null;
      for (const f of lista) {
        if (!ok(f)) continue;
        let s = 0, c = 'parcial';
        if (n.length >= 6 && (f.n1.startsWith(n) || f.n2.startsWith(n) || (f.n1.length >= 6 && n.startsWith(f.n1)) || (f.n2.length >= 6 && n.startsWith(f.n2)))) s = 0.9;
        else {
          // palavras canônicas em comum (com sinônimo, abreviação e erro de digitação)
          if (tc.length && f.tc.length) { let comum = 0; for (const x of tc) if (f.tc.some(y => parecidos(x, y))) comum++; const j = comum / Math.max(tc.length, 1); if (comum >= 1 && j >= 0.6) s = 0.5 + j * 0.35; else if (comum >= 2) s = 0.55; }
          if (!s && tk.length && f.t.has(tk[0])) { const comum = tk.filter(t => f.t.has(t)).length; const j = comum / Math.max(tk.length, 1); if (comum >= 1 && j >= 0.6) s = 0.5 + j * 0.3; else if (comum >= 2) s = 0.55; }
          // sigla: nome curto da planilha (2–6 letras, uma palavra) = iniciais do nome do ERP
          if (!s && sg.length >= 2 && sg.length <= 6 && tk.length <= 1 && (f.s1 === sg || f.s2 === sg || (sg.length >= 3 && (f.s1.startsWith(sg) || f.s2.startsWith(sg))))) { s = f.s1 === sg || f.s2 === sg ? 0.75 : 0.62; c = 'sigla'; }
        }
        if (s > bs) { bs = s; best = f; bc = c; }
      }
      if (best && bs >= 0.5) { m = best; como = bs >= 0.9 ? 'nome' : bc; score = bs; }
    }
    return { ...l, codFornec: m ? m.codFornec : 0, nome_erp: m ? m.nome : null, cnpj_erp: m ? m.cnpj : null, como, score: +score.toFixed(2) };
  });
}

module.exports = { parsePlanilha, casar, norm, tokens, tokC, sigla, fone8 };
