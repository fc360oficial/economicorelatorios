// Sugestão de "Validade (dias)" pro cadastro do ERP — Análise Lista de Compras › Sem Validade (Tiago, 18/11/2026:
// "essas validades aqui não poderia ter sugestões?"). SOMENTE LEITURA: nada é gravado no ERP, a tela só mostra o número
// e de onde ele veio pra quem for preencher o cadastro.
//
// Duas fontes, nesta ordem (medido em 18/11 contra os 7.856 itens de lista que JÁ têm validade, tirando o próprio item
// da conta — "se ele estivesse vazio, a regra acertaria o que está cadastrado?"):
//   1. Produtos parecidos que já têm validade no cadastro:
//        mesma FAMÍLIA  (3+ irmãos, 60 %+ com o mesmo número) → acertou 99 %  → confiança alta
//        mesmo SUBGRUPO (3+ irmãos, 60 %+ com o mesmo número) → acertou 79 %  → alta se 80 %+ concordam, senão média
//   2. O que o coletor leu nas entradas do próprio produto (validade lida − data da entrada = quantos dias de validade
//      ele tinha ao CHEGAR): mediana das entradas, arredondada pra baixo pro número de cadastro mais próximo.
//      É piso, não a validade de fábrica (o produto já chega com parte dela gasta) → confiança média (3+ entradas) ou baixa.
//   3. Mesmo GRUPO (5+ irmãos, 60 %+) → confiança baixa.
// Conferência cruzada: se os parecidos dizem N dias mas o produto, em 3+ entradas, quase nunca chegou com metade disso,
// vale o coletor (com N o coletor bloquearia a entrada dele: recebimento.js compara a validade lida com Validar × %).
//
// Os números sugeridos são os que a casa já usa no cadastro (180, 365, 90, 25, 120, 60, 30, 15, 45, 20...).

const GRADE = [7, 10, 12, 15, 20, 25, 30, 45, 60, 90, 120, 180, 270, 365];
const MIN_IRMAOS = 3, MIN_IRMAOS_GRUPO = 5, CONSENSO = 0.6, CONSENSO_ALTO = 0.8, MIN_ENTRADAS = 3;

// maior número da grade que não passa de d; abaixo de 7 dias fica o próprio número (mínimo 2 — 1 é o "vazio" do ERP)
function naGrade(d) {
  d = Math.floor(+d || 0); if (d < 2) return null;
  let r = null; for (const g of GRADE) if (g <= d) r = g;
  return r || d;
}
function moda(arr) {
  if (!arr || !arr.length) return null;
  const f = new Map(); for (const v of arr) f.set(v, (f.get(v) || 0) + 1);
  let melhor = null; for (const [v, n] of f) if (!melhor || n > melhor.n || (n === melhor.n && v < melhor.v)) melhor = { v, n };
  return { v: melhor.v, n: melhor.n, t: arr.length, pct: melhor.n / arr.length };
}
const chaveFamilia = s => { const t = String(s == null ? '' : s).trim().toUpperCase(); return t && t !== '0' ? t : null; };
const chaveNum = v => { const n = parseInt(v, 10); return n > 0 ? n : null; };

// linhas = produtos ATIVOS com validade de cadastro > 1: { validar, familia, subgrupo, grupo }
function montarReferencia(linhas) {
  const ref = { familia: new Map(), subgrupo: new Map(), grupo: new Map(), total: 0 };
  const poe = (m, k, v) => { if (k == null) return; const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const r of linhas || []) {
    const v = parseInt(r.validar, 10); if (!(v > 1)) continue;
    ref.total++;
    poe(ref.familia, chaveFamilia(r.familia), v); poe(ref.subgrupo, chaveNum(r.subgrupo), v); poe(ref.grupo, chaveNum(r.grupo), v);
  }
  return ref;
}

// hist = { entradas, p25, p50, p75, ultima } do próprio produto (dias de validade ao chegar), ou null
function evidenciaColetor(hist) {
  if (!hist || !(+hist.entradas > 0) || !(+hist.p50 > 0)) return null;
  return { entradas: +hist.entradas, tipico: +hist.p50, de: +hist.p25 || +hist.p50, ate: +hist.p75 || +hist.p50, ultima: hist.ultima || null };
}

// item = { familia, subgrupo, grupo, balanca }; nomes = { subgrupo: {cod: nome}, grupo: {cod: nome} } (opcional, só pro texto)
// Produto de balança (perecível) que herdaria mais de 60 dias dos parecidos cai pra confiança baixa com aviso: no cadastro
// de hoje há fruta com 180 dias (número genérico), e a regra dos parecidos repetiria o erro.
const BALANCA_MAX = 60;
function sugerir(item, ref, hist, nomes) {
  const s = calcular(item, ref, hist, nomes);
  if (s && s.dias && item && item.balanca && s.fonte !== 'coletor' && s.dias > BALANCA_MAX) {
    s.confianca = 'baixa'; s.aviso = 'Produto de balança: confira antes de usar — os parecidos podem estar com validade genérica';
  }
  return s;
}
function calcular(item, ref, hist, nomes) {
  const col = evidenciaColetor(hist);
  const out = (dias, fonte, confianca, base, extra) => ({ dias, fonte, confianca, base, coletor: col, ...(extra || {}) });
  const nome = (tipo, cod) => { const n = nomes && nomes[tipo] && nomes[tipo][cod]; return n ? '"' + n + '"' : '#' + cod; };
  const irmaos = (m, k, min) => { if (k == null) return null; const md = moda(m.get(k)); return md && md.t >= min && md.pct >= CONSENSO ? md : null; };
  const frase = (onde, md) => `${onde}: ${md.n} de ${md.t} produtos com ${md.v} dias`;

  let s = null;
  const kf = chaveFamilia(item.familia), ks = chaveNum(item.subgrupo), kg = chaveNum(item.grupo);
  const mf = ref ? irmaos(ref.familia, kf, MIN_IRMAOS) : null;
  const ms = !mf && ref ? irmaos(ref.subgrupo, ks, MIN_IRMAOS) : null;
  if (mf) s = out(mf.v, 'familia', 'alta', frase('Família "' + kf + '"', mf));
  else if (ms) s = out(ms.v, 'subgrupo', ms.pct >= CONSENSO_ALTO ? 'alta' : 'media', frase('Subgrupo ' + nome('subgrupo', ks), ms));

  const colDias = col ? naGrade(col.tipico) : null;
  const colBase = col ? `Coletor: em ${col.entradas} entrada${col.entradas > 1 ? 's' : ''} chegou com ${col.tipico} dias de validade (mediana)` : null;
  // parecidos dizem N, mas o produto quase nunca chegou nem com metade de N → vale o que o coletor leu
  if (s && col && col.entradas >= MIN_ENTRADAS && colDias && col.ate < s.dias * 0.5)
    return out(colDias, 'coletor', 'media', colBase + ` — os parecidos usam ${s.dias} dias, mas este chega com bem menos`, { divergente: s.dias });
  if (s) return s;
  if (col && colDias) return out(colDias, 'coletor', col.entradas >= MIN_ENTRADAS ? 'media' : 'baixa', colBase);
  const mg = ref ? irmaos(ref.grupo, kg, MIN_IRMAOS_GRUPO) : null;
  if (mg) return out(mg.v, 'grupo', 'baixa', frase('Grupo ' + nome('grupo', kg), mg));
  return col ? { dias: null, fonte: null, confianca: null, base: null, coletor: col } : null;
}

// Planilha (.xlsx) pra quem vai digitar a validade no cadastro do ERP (Tiago, 18/11/2026). Uma linha por item sem validade
// de cada lista; código de barras vai como TEXTO (em CSV o Excel transforma 7896001020658 em 7,896E+12).
// linhas = [{ lista, nome, fornecedor, comprador, codigo, descricao, lojas: [n], validade_dias, balanca, sugestao }]
const CONF_ROTULO = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
const CONF_ORDEM = { alta: 0, media: 1, baixa: 2, sem: 3 };
const confDe = l => (l.sugestao && l.sugestao.dias ? l.sugestao.confianca : 'sem');
async function planilha(linhas, opt = {}) {
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); wb.creator = 'Econômico Relatórios';
  const ws = wb.addWorksheet('Sem validade', { views: [{ state: 'frozen', ySplit: 1 }] });
  const COLS = [['Lista', 8], ['Nome da lista', 36], ['Fornecedor', 36], ['Comprador(a)', 20], ['Código de barras', 18], ['Descrição', 46], ['Lojas', 20],
    ['Validade no cadastro', 12], ['Sugestão (dias)', 11], ['Confiança', 11], ['De onde vem a sugestão', 70], ['Chegou com (dias, coletor)', 14], ['Entradas lidas', 10], ['Validade digitada no ERP', 14]];
  ws.columns = COLS.map(([h, w]) => ({ header: h, key: h, width: w }));
  const cab = ws.getRow(1); cab.font = { bold: true }; cab.alignment = { vertical: 'middle', wrapText: true }; cab.height = 32;
  cab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6ECF4' } };
  const ord = [...(linhas || [])].sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR') || (a.lista - b.lista)
    || CONF_ORDEM[confDe(a)] - CONF_ORDEM[confDe(b)] || String(a.descricao || '').localeCompare(String(b.descricao || ''), 'pt-BR'));
  const COR = { alta: 'FFE7F5EC', media: 'FFFFF6D9', baixa: 'FFE4E4E1' };
  for (const l of ord) {
    const s = l.sugestao, tem = !!(s && s.dias), c = s && s.coletor;
    const r = ws.addRow([l.lista, l.nome || '', l.fornecedor || '', l.comprador || '', String(l.codigo), l.descricao || '', (l.lojas || []).map(n => 'E' + n).join(' '),
      l.validade_dias > 0 ? l.validade_dias : null, tem ? s.dias : null, tem ? CONF_ROTULO[s.confianca] : 'Sem sugestão',
      tem ? s.base + (s.aviso ? ' — ' + s.aviso : '') : 'Sem produto parecido com validade e sem leitura do coletor', c ? c.tipico : null, c ? c.entradas : null, null]);
    r.getCell(5).numFmt = '@';
    if (tem) { r.getCell(9).font = { bold: true }; r.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR[s.confianca] } }; }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS.length } };
  const i = wb.addWorksheet('Como ler');
  [`Gerada em ${opt.geradaEm || new Date().toLocaleString('pt-BR')}${opt.filtro ? ' · ' + opt.filtro : ''} · ${ord.length} itens sem validade.`,
    'Só produtos ativos com loja marcada na lista. Sem validade = campo "Validade (dias)" do cadastro do ERP vazio, 0 ou 1 (o ERP grava 1 quando ninguém preencheu).',
    'Sugestão (dias) é o número proposto pro campo "Validade (dias)". Nada foi gravado no ERP: a planilha é só o roteiro de quem vai digitar.',
    'Confiança ALTA: produtos da mesma família, ou 80 % ou mais do subgrupo, já usam esse número no cadastro. Pode digitar.',
    'Confiança MÉDIA: 60 a 80 % do subgrupo usa esse número, ou ele veio do coletor em 3 ou mais entradas do próprio produto. Vale uma olhada.',
    'Confiança BAIXA: veio de 1 ou 2 leituras do coletor, só do grupo, ou é produto de balança com número alto herdado dos parecidos. Confira com quem conhece o produto.',
    '"Chegou com" = dias de validade que o produto tinha ao chegar (validade lida pelo coletor − data da entrada), na mediana das entradas. É piso: o produto já chega com parte da validade gasta.',
    'A sugestão repete o padrão do cadastro de hoje. Se os parecidos estiverem com número genérico, a sugestão herda — por isso a coluna "De onde vem".',
    'A última coluna ("Validade digitada no ERP") fica em branco pra anotar o que foi realmente cadastrado.'].forEach(t => i.addRow([t]));
  i.getColumn(1).width = 150; i.getColumn(1).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { GRADE, naGrade, moda, montarReferencia, evidenciaColetor, sugerir, planilha, confDe };
