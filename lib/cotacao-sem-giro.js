'use strict';
// lib/cotacao-sem-giro.js — Sem giro por loja na Cotação (Tiago, 11/11/26, barra de filtros do Comparativo: "colocar uma opção
// para trazer cada loja: quando eu clicar na loja ele traz todos os produtos sem giro que estão na cotação, como já aparece lá
// na cotação, e que eu consiga imprimir ou enviar o PDF").
// montar() é pura: recebe o que as rotas /api/cotacoes/:id/giro e /estoque já buscaram (giroDaCotacao / estoqueDaCotacao no
// server.js), o pré-pedido e o comparativo, e devolve a lista da loja com o MESMO critério do pré-pedido (giro.itens[cod][loja]
// .sem_giro = 30 dias ou mais sem venda na loja, ou nenhuma venda nos últimos 120 d). pdf() desenha no estilo de
// lib/gerencial-inicio.js pdfSemGiro (logo, navy, zebra, "página X de Y"). Nada aqui lê o ERP nem grava.

const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const CRITERIO = '30 dias ou mais sem venda na loja (nunca nos últimos 120 d conta)';
const NAVY = '#14213D';

/** "E3 PONTE": rótulo de loja E1..E6 (regra do Tiago, 22/09/26) + nome curto. */
function lojaTxt(ln) { return 'E' + ln + (LOJAS_NOMES[ln] ? ' ' + LOJAS_NOMES[ln] : ''); }
/** Lojas da cotação (c.lojas), ou 1..6 quando a cotação não tem a lista (como a rota /giro faz). */
function lojasDe(c) { return ((c && Array.isArray(c.lojas) && c.lojas.length) ? c.lojas.map(Number) : [1, 2, 3, 4, 5, 6]).filter(ln => Number.isInteger(ln) && ln >= 1 && ln <= 6); }
/** ?loja=N válida (inteiro e loja da cotação) → N; qualquer outra coisa → null. */
function lojaValida(c, loja) { const s = String(loja == null ? '' : loja).trim(); if (!/^\d{1,2}$/.test(s)) return null; const ln = parseInt(s, 10); return lojasDe(c).includes(ln) ? ln : null; }
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * Itens da cotação sem giro na loja. giro = dados da rota /giro ({ itens: { cod: { loja: { uc, uv, dias, sem_giro } } }, em }),
 * estoque = dados da rota /estoque ({ itens: { cod: { lojas: { loja: { estoque } } } } }) ou null (falhou: estoque sai null),
 * prePedidos = cotacao.prePedidos(c, …), comparativo = cotacao.comparativo(c), loja = nº da loja (já validado).
 * Ordem: nunca vendeu em 120 d primeiro, depois mais dias sem venda, depois descrição.
 */
function montar(c, { giro, estoque, prePedidos, comparativo, loja }) {
  const ln = parseInt(loja, 10), k = String(ln);
  const G = (giro && giro.itens) || {}, E = (estoque && estoque.itens) || {}, cmp = comparativo || {};
  const nomeF = {}; for (const f of (cmp.fornecedores || [])) nomeF[String(f.codFornec)] = f.nome || f.empresa || String(f.codFornec);
  const porCod = {}; for (const it of (cmp.itens || [])) porCod[String(it.cod)] = it;
  // pedido pra loja = soma de lojas_qtd[loja] nos itens de TODOS os fornecedores do pré-pedido (pendentes e realizados):
  // um item pode estar em mais de um pré-pedido quando o vencedor muda por loja (Tiago, 05/10)
  const ped = {}; for (const f of ((prePedidos && prePedidos.fornecedores) || [])) for (const it of (f.itens || [])) { const q = num((it.lojas_qtd || {})[k]); if (q > 0) ped[String(it.cod)] = (ped[String(it.cod)] || 0) + q; }
  const itens = [];
  for (const i of ((c && c.itens) || [])) {
    const cod = String(i.cod), g = (G[cod] || {})[k];
    if (!g || g.sem_giro !== true) continue;   // mesmo critério do pré-pedido (ppGiroSg na tela): só o que a rota /giro marcou sem_giro nesta loja
    const ci = porCod[cod] || i;
    const el = E[cod] && E[cod].lojas ? E[cod].lojas[k] : null, est = el ? num(el.estoque) : null;
    // quem fornece ESTA loja (por_loja = vencedor por loja, Tiago 05/10); sem escolha por loja vale o vencedor geral
    let w = ci.vencedor ? ci.vencedor.codFornec : null; if (hasOwn(ci.por_loja, k)) w = ci.por_loja[k];
    const pr = w == null ? null : (ci.precos && ci.precos[w] ? num(ci.precos[w].preco) : (ci.vencedor && ci.vencedor.codFornec === w ? num(ci.vencedor.preco) : null));
    itens.push({ cod, descricao: String(ci.descricao || i.descricao || ''), unid: ci.unid || i.unid || '', emb: num(ci.emb != null ? ci.emb : i.emb), uv: g.uv || null, dias: g.uv ? num(g.dias) : null, uc: g.uc || null,
      estoque: est, qtd_pedido: ped[cod] > 0 ? ped[cod] : null, fornecedor: w == null ? null : (nomeF[String(w)] || null), preco: pr, curva_a: !!ci.curva_a });
  }
  itens.sort((a, b) => { const na = a.uv == null, nb = b.uv == null; if (na !== nb) return na ? -1 : 1; return (b.dias || 0) - (a.dias || 0) || a.descricao.localeCompare(b.descricao, 'pt-BR') || a.cod.localeCompare(b.cod); });
  return { id: c.id, nome: c.nome || '', status: c.status || null, loja: ln, loja_txt: lojaTxt(ln), lojas: lojasDe(c), total_itens: ((c && c.itens) || []).length, sem_giro: itens.length, itens,
    geradoEm: new Date().toISOString(), giro_em: (giro && giro.em) || null, criterio: CRITERIO };
}

// ── PDF (A4 paisagem: 10 colunas) no estilo de lib/gerencial-inicio.js pdfSemGiro ───────────────────────────────────────────
const brl = v => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtd = v => v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const dCurta = s => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s))) ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(2, 4) : '—';
const dataHora = d => { if (d === undefined) d = new Date(); if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };   // dataHora() = agora; null = '—'
/** Corta o texto pra caber na largura da coluna (o pdfkit quebra linha mesmo com lineBreak: false quando passa da width). */
function cabe(doc, s, w) { s = String(s || '').replace(/[\r\n\t]+/g, ' '); if (doc.widthOfString(s) <= w) return s; while (s.length > 1 && doc.widthOfString(s + '…') > w) s = s.slice(0, -1); return s.trimEnd() + '…'; }
/** Nome do arquivo: cotacao-13-sem-giro-E3.pdf */
function nomeArquivo(c, loja) { return 'cotacao-' + (c && c.id != null ? c.id : 'x') + '-sem-giro-E' + loja + '.pdf'; }
/** Gera o PDF (Buffer) a partir do que montar() devolveu; usuario = nome de quem emitiu (cabeçalho). */
async function pdf(d, { usuario } = {}) {
  const PDFDocument = require('pdfkit'); const LOGO = require('./logo-economico');
  const rows = d.itens || [], lojaT = d.loja_txt || lojaTxt(d.loja);
  const titulo = 'SEM GIRO NA COTAÇÃO #' + d.id + ' · ' + (d.nome || '') + ' · ' + lojaT;
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: 'Sem giro · Cotação #' + d.id + ' · ' + lojaT, Author: 'Econômico Supermercados' } });
  const chunks = []; doc.on('data', ch => chunks.push(ch)); const fim = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  const X = 28, W = doc.page.width - 56;
  // text() SEM `width`: com width o pdfkit passa pelo LineWrapper e quebra linha mesmo com lineBreak:false (a soma das palavras difere
  // do widthOfString pelo kerning). Aqui o texto é cortado com cabe() pra caber na coluna e o alinhamento à direita/centro é feito na mão.
  const txt = (s, x, y, w, dir) => { s = cabe(doc, s, w - 4); const tw = dir ? doc.widthOfString(s) : 0; doc.text(s, dir === 'right' ? x + w - 2 - tw : dir === 'center' ? x + (w - tw) / 2 : x + 2, y, { lineBreak: false }); };
  const cols = [['Código', 62], ['Produto', 0], ['Emb', 50], ['Últ. venda', 54], ['Dias', 36], ['Últ. compra', 56], ['Estoque na loja', 66], ['Pedido pra loja', 66], ['Fornecedor vencedor', 128], ['Preço', 60]];
  cols[1][1] = W - cols.reduce((s, c) => s + c[1], 0); const sx = []; let acc = X; for (const c of cols) { sx.push(acc); acc += c[1]; }
  const alinha = k => (k === 4 || k === 6 || k === 7 || k === 9 ? 'right' : null);
  const cab = () => {
    LOGO.desenhar(doc, X, 18, 60);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY); txt(titulo, X + 72, 22, W - 72);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111'); txt(rows.length.toLocaleString('pt-BR') + ' de ' + Number(d.total_itens || 0).toLocaleString('pt-BR') + ' itens da cotação ' + (rows.length === 1 ? 'está' : 'estão') + ' sem giro nesta loja', X + 72, 40, W - 72);
    // duas linhas: nome comprido de quem emitiu não corta o critério nem a ordem (revisão 11/11)
    doc.font('Helvetica').fontSize(7.5).fillColor('#555'); txt('emitido ' + dataHora() + (usuario ? ' por ' + usuario : '') + ' · giro lido no ERP ' + dataHora(d.giro_em), X + 72, 52, W - 72);
    txt('critério: ' + (d.criterio || CRITERIO) + ' · ordem: mais tempo sem venda primeiro', X + 72, 61, W - 72);
    doc.y = 74;
    doc.rect(X, doc.y, W, 14).fill('#E6ECF4'); doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY); const y = doc.y + 4;
    cols.forEach(([t, w], k) => txt(t, sx[k], y, w, alinha(k))); doc.y = y + 12;
  };
  cab(); let i = 0;
  for (const r of rows) {
    if (doc.y > doc.page.height - 44) { doc.addPage(); cab(); }
    const y = doc.y; if (i++ % 2) doc.rect(X, y - 2, W, 14).fill('#F6F7FA');
    doc.font('Helvetica').fontSize(7.5).fillColor('#111');
    txt(r.cod, sx[0], y, cols[0][1]);
    const wA = r.curva_a ? 12 : 0; txt(r.descricao, sx[1], y, cols[1][1] - wA);   // curva A: "A" em navy no fim da coluna Produto
    if (r.curva_a) { doc.font('Helvetica-Bold').fillColor(NAVY); txt('A', sx[1] + cols[1][1] - 14, y, 14, 'right'); doc.font('Helvetica').fillColor('#111'); }
    doc.fillColor('#444'); txt(String(r.unid || '') + (r.emb > 1 ? ' · cx ' + qtd(r.emb) : ''), sx[2], y, cols[2][1]);
    doc.fillColor('#111'); txt(r.uv ? dCurta(r.uv) : '—', sx[3], y, cols[3][1]);
    doc.font('Helvetica-Bold').fillColor('#B42318'); txt(r.uv ? String(r.dias == null ? '—' : r.dias) : '120+', sx[4], y, cols[4][1], 'right');
    doc.font('Helvetica').fillColor('#111'); txt(dCurta(r.uc), sx[5], y, cols[5][1]);
    txt(qtd(r.estoque), sx[6], y, cols[6][1], 'right');
    txt(r.qtd_pedido > 0 ? qtd(r.qtd_pedido) : '—', sx[7], y, cols[7][1], 'right');
    doc.fillColor('#444'); txt(r.fornecedor || '—', sx[8], y, cols[8][1]);
    doc.fillColor('#111'); txt(brl(r.preco), sx[9], y, cols[9][1], 'right');
    doc.y = y + 14;
  }
  if (!rows.length) { doc.font('Helvetica').fontSize(10).fillColor('#666'); txt('Nenhum item sem giro nesta loja.', X, doc.y + 12, W, 'center'); }
  const total = doc.bufferedPageRange().count;
  for (let p = 0; p < total; p++) {
    doc.switchToPage(p); doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#888'); txt('Econômico Supermercados · Cotação #' + d.id + ' · Sem giro · ' + lojaT + '   —   página ' + (p + 1) + ' de ' + total, X, doc.page.height - 22, W, 'center');
  }
  doc.end();
  return fim;
}

module.exports = { montar, pdf, nomeArquivo, lojaValida, lojasDe, lojaTxt, LOJAS_NOMES, CRITERIO };
