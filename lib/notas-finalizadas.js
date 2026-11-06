// Gestão Gerencial › Notas Finalizadas (03/11/2026, Tiago: "coloca uma aba com as notas que está finalizada e clicando mostra os
// produtos e em cima um PDF com os produtos todos que finalizou no dia, com as datas pra trocar se eu quero ver ontem, hoje").
// "Finalizada" = entrada da loja fechada no ERP: central.compras Status 'F', Movimentacao COMPRA ou BONIFICACAO, no dia do
// status (DataStatus). Itens = central.compraprodutos (código interno, QtdEntradaEstoque em unidades, custo unitário).
// Recebido = contagem do coletor do ERP (central.conferenciaitens, qtd × qtdemb por código, mesma régua do lib/fiscal.js);
// quando a conferência junta mais de uma nota (compra + bonificação) a contagem não separa por nota → fica sem "Recebido".
// PDF (Tiago, 03/11: "no PDF não precisa de valores") = só código, produto, quantidade da nota e recebido.
//
// Fase 2 (mockup aprovado 06/11/2026, pedido do Tiago em 04/11: "mostrar só os produtos com início no topo curva A B C e isso em
// PDF tbm, e uma opção de produto chegou dia x e tem 7 dias que não vende, pq pode tá no estoque"):
//  • cada item ganha a CURVA da loja (venda em R$ dos últimos 30 dias nesta loja, A até 50 %, B até 80 %, C o resto; "N" = novo,
//    sem venda nos 30 dias) e a venda média por dia — lida do espelho do ERP no Postgres (lib/espelho-erp.js), nunca do .252;
//  • PDF ?modo=curva = a mesma lista do dia agrupada A → B → C → Novo (lista de reposição);
//  • parado() = "Chegou e não vendeu": notas finalizadas entre 7 e 21 dias atrás (ou 14 a 28), venda do dia seguinte à nota até
//    ontem, estoque do ERP; "sem venda" só quando o produto vendia o bastante pra ter vendido ao menos 1 un. no prazo;
//  • o gerente responde (Estava no depósito · Já na gôndola · Sem etiqueta · Não achei) em data/notas-finalizadas/acoes.json e o
//    produto some da lista por 7 dias; push às 08:00 quando entra produto novo na lista.
// Só leitura no ERP.
'use strict';

const LOJA_TXT = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão' };
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r3 = v => Math.round(v * 1000) / 1000;
const r1 = v => Math.round(v * 10) / 10;
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hojeStr = () => ymd(new Date());
const diaValido = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : hojeStr();
const menosDias = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() - n); return ymd(d); };
const difDias = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
const hm = h => { const s = String(h || ''); return /^\d{2}:\d{2}/.test(s) && !s.startsWith('00:00') ? s.slice(0, 5) : null; };

// ── Curva da loja (30 dias, A ≤ 50 % · B ≤ 80 % · C) pelo espelho; sem espelho cai na curva de 90 dias do servidor (abcLojas) ──
const CURVA_CORTES = { A: 0.5, B: 0.8 };
const CURVA_DIAS = 30;
const CURVA_CACHE = new Map(); const CURVA_TTL = 60 * 60e3;
async function curvaLoja(loja, deps) {
  const c = CURVA_CACHE.get(loja); if (c && Date.now() - c.em < CURVA_TTL) return c;
  const hoje = hojeStr(), fim = menosDias(hoje, 1), ini = menosDias(hoje, CURVA_DIAS);
  let rows = null;
  if (deps.espelho) { try { rows = await deps.espelho.vendaPeriodo([loja], ini, fim, { hojeAoVivo: false }); } catch (e) { console.error('[notas-finalizadas] curva loja ' + loja + ':', e.message); } }
  let v = null;
  if (rows) {
    const lista = rows.map(r => ({ cod: String(r.codigo || '').trim(), v: +r.valor || 0, q: +r.qtd || 0 })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    const total = lista.reduce((s, x) => s + x.v, 0); let cum = 0; const mapa = {};
    // A = os produtos necessários pra chegar a 50 % da venda (o acumulado ANTES do produto ainda está abaixo do corte; assim o
    // 1º colocado é sempre A mesmo que sozinho passe de 50 %), B até 80 %, C o resto
    for (const x of lista) { const f = total ? cum / total : 1; cum += x.v; mapa[x.cod] = { abc: f < CURVA_CORTES.A ? 'A' : f < CURVA_CORTES.B ? 'B' : 'C', dia: x.q / CURVA_DIAS }; }
    v = { em: Date.now(), mapa, dias: CURVA_DIAS, fonte: 'espelho', ini, fim, produtos: lista.length };
  } else if (deps.abcLojas) {
    const abc = deps.abcLojas(); const pl = abc && abc.porLoja && abc.porLoja[loja];
    if (pl) { const mapa = {}; for (const [cod, a] of Object.entries(pl.mapa)) mapa[cod] = { abc: a.abc, dia: (a.qtd90 || 0) / (abc.dias || 90) }; v = { em: Date.now(), mapa, dias: abc.dias || 90, fonte: 'erp-90d', produtos: pl.produtos }; }
  }
  if (!v) return null;
  CURVA_CACHE.set(loja, v); return v;
}
const ORDEM_CURVA = { A: 0, B: 1, C: 2, N: 3 };

// cache curto por loja×dia: o gerente troca de dia e volta, e o dia de hoje muda ao longo do dia (3 min)
const CACHE = new Map(); const TTL_HOJE = 3 * 60e3, TTL_PASSADO = 30 * 60e3;

/** Notas Status F da loja com DataStatus entre dIni e dFim (inclusive), já com itens e contagem do coletor. */
async function carregarNotas(ln, dIni, dFim, deps) {
  const q = deps.q;
  // DataRecto tem índice; DataStatus (dia em que fechou) não → janela de 60 dias no DataRecto e a faixa exata no DataStatus
  const notas = await q(`SELECT c.nCompra, c.nLoja, c.nNota, c.NomeFornec, c.CodFornec, c.Movimentacao, c.TotalNota, c.NomeOperador, c.nConferencia,
      DATE_FORMAT(c.DataRecto,'%Y-%m-%d') DataRecto, DATE_FORMAT(c.DataStatus,'%Y-%m-%d') DataStatus, cf.OperadorLoja, cf.OperadorLiberacao, cf.HoraLiberacao, cf.HoraConferido,
      DATE_FORMAT(cf.DataLiberacao,'%Y-%m-%d') DataLiberacao, DATE_FORMAT(cf.DataConferido,'%Y-%m-%d') DataConferido
    FROM central.compras c LEFT JOIN central.conferencia cf ON cf.nReg = c.nConferencia AND c.nConferencia > 0
    WHERE c.nLoja = ? AND c.Status = 'F' AND c.Movimentacao IN ('COMPRA','BONIFICACAO') AND c.DataRecto BETWEEN ? AND ? AND c.DataStatus BETWEEN ? AND ?
    ORDER BY c.nCompra`, [ln, menosDias(dIni, 60), dFim, dIni, dFim]);
  let itens = [], coletor = [];
  if (notas.length) {
    const cond = notas.map(() => '(nCompra=? AND nLoja=?)').join(' OR ');
    itens = await q(`SELECT nCompra, Item, CodigoBarra, Descricao, Unid, Qtd, QtdEmb, QtdEntradaEstoque, Preco, Custo, Cancelado
      FROM central.compraprodutos WHERE ${cond} ORDER BY nCompra, Item`, notas.flatMap(n => [n.nCompra, n.nLoja]));
    const confs = [...new Set(notas.map(n => +n.nConferencia).filter(x => x > 0))];
    if (confs.length) coletor = await q(`SELECT chave, codigobarra, qtd, qtdemb FROM central.conferenciaitens WHERE chave IN (${confs.map(() => '?').join(',')})`, confs.map(String)).catch(e => { console.error('[NOTAS-FIN] coletor:', e.message); return []; });
  }
  // contagem do coletor por conferência × código, em unidades
  const col = {}; const confComColetor = new Set();
  for (const r of coletor) {
    const k = String(r.chave) + '|' + String(r.codigobarra || '').trim(); confComColetor.add(String(r.chave));
    col[k] = (col[k] || 0) + num(r.qtd) * (num(r.qtdemb) > 0 ? num(r.qtdemb) : 1);
  }
  const notasPorConf = {}; for (const n of notas) if (+n.nConferencia > 0) notasPorConf[n.nConferencia] = (notasPorConf[n.nConferencia] || 0) + 1;
  return notas.map(n => {
    const conf = +n.nConferencia > 0 ? String(n.nConferencia) : null;
    const comparar = conf && confComColetor.has(conf) && notasPorConf[n.nConferencia] === 1;
    const lin = itens.filter(i => +i.nCompra === +n.nCompra && !+i.Cancelado).map(i => {
      const cod = String(i.CodigoBarra || '').trim();
      const qtdNota = num(i.QtdEntradaEstoque) > 0 ? num(i.QtdEntradaEstoque) : num(i.Qtd) * (num(i.QtdEmb) > 0 ? num(i.QtdEmb) : 1);
      const custo = num(i.Custo) > 0 ? num(i.Custo) : (qtdNota > 0 ? num(i.Preco) * num(i.Qtd) / qtdNota : 0);
      const recebido = comparar ? r3(col[conf + '|' + cod] || 0) : null;
      return { cod, descricao: String(i.Descricao || '').trim(), unid: String(i.Unid || '').trim(), qtd: r3(qtdNota), recebido, custo: Math.round(custo * 10000) / 10000, total: Math.round(qtdNota * custo * 100) / 100 };
    });
    // se a mesma conferência bipou o código em mais de uma linha da nota, o coletor vem num balde só: compara pela soma
    if (comparar) {
      const soma = {}; for (const l of lin) soma[l.cod] = (soma[l.cod] || 0) + l.qtd;
      for (const l of lin) l.dif = Math.abs((col[conf + '|' + l.cod] || 0) - soma[l.cod]) > 0.001;
    }
    // o ERP só guarda a DATA do fechamento (DataStatus); hora = liberação da conferência, senão o fim da bipagem
    const hora = hm(n.DataLiberacao ? n.HoraLiberacao : null) || hm(n.DataConferido ? n.HoraConferido : null);
    return {
      nCompra: +n.nCompra, nNota: String(n.nNota), fornecedor: String(n.NomeFornec || '').trim() || 'Fornecedor ' + n.CodFornec,
      bonificacao: /BONIF/i.test(n.Movimentacao), total: num(n.TotalNota), hora, chegada: n.DataRecto, dia: n.DataStatus,
      conferente: String(n.OperadorLoja || '').trim() || null, lancou: String(n.NomeOperador || '').trim() || null,
      coletor: !!comparar, diferencas: lin.filter(l => l.dif).length, itens: lin,
    };
  }).sort((a, b) => String(a.dia).localeCompare(String(b.dia)) || String(a.hora || '99').localeCompare(String(b.hora || '99')) || a.nCompra - b.nCompra);
}

/** Marca em cada item a curva da loja (A/B/C/N) e a venda média por dia. */
function aplicarCurva(notas, curva) {
  for (const n of notas) for (const it of n.itens) {
    if (!curva) { it.curva = null; it.vendeDia = null; continue; }
    const c = curva.mapa[it.cod];
    it.curva = c ? c.abc : 'N'; it.vendeDia = c ? r1(c.dia) : 0;
  }
}

/** Notas finalizadas da loja no dia, com os itens. deps: { q, espelho?, abcLojas? }. */
async function listar({ loja, dia }, deps) {
  const ln = +loja; if (!ln) throw new Error('Escolha uma loja');
  const d = diaValido(dia); const chave = ln + '|' + d; const c = CACHE.get(chave);
  if (c && Date.now() - c.em < (d === hojeStr() ? TTL_HOJE : TTL_PASSADO)) return c.v;
  const out = await carregarNotas(ln, d, d, deps);
  const curva = await curvaLoja(ln, deps);
  aplicarCurva(out, curva);
  const curvas = { A: 0, B: 0, C: 0, N: 0 };
  for (const n of out) for (const it of n.itens) if (it.curva) curvas[it.curva]++;
  const v = { loja: ln, lojaTxt: LOJA_TXT[ln] || 'Loja ' + ln, dia: d, notas: out,
    curva: curva ? { dias: curva.dias, fonte: curva.fonte } : null,
    resumo: { notas: out.length, produtos: out.reduce((s, n) => s + n.itens.length, 0), valor: Math.round(out.reduce((s, n) => s + n.total, 0) * 100) / 100, comDiferenca: out.filter(n => n.diferencas).length, curvas } };
  CACHE.set(chave, { em: Date.now(), v }); if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
  return v;
}

const dataBR = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';
const qtdTxt = v => v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
function cabe(doc, s, w) { s = String(s || ''); if (doc.widthOfString(s) <= w) return s; while (s.length > 1 && doc.widthOfString(s + '…') > w) s = s.slice(0, -1); return s.trimEnd() + '…'; }
function nomePdf(loja, dia, nCompra, modo) { return 'notas-finalizadas-E' + loja + '-' + diaValido(dia) + (nCompra ? '-' + nCompra : '') + (modo === 'curva' ? '-por-curva' : '') + '.pdf'; }

const GRUPO_TXT = { A: ['CURVA A', 'repor primeiro'], B: ['CURVA B', ''], C: ['CURVA C', ''], N: ['NOVO', 'sem venda em ' + CURVA_DIAS + ' dias'] };
/** Lista plana dos itens do dia agrupada por curva (A → B → C → Novo), cada grupo por venda/dia decrescente. */
function porCurva(notas) {
  const lista = [];
  for (const n of notas) for (const it of n.itens) lista.push({ ...it, nNota: n.nNota, fornecedor: n.fornecedor, nCompra: n.nCompra });
  lista.sort((a, b) => (ORDEM_CURVA[a.curva] ?? 9) - (ORDEM_CURVA[b.curva] ?? 9) || (b.vendeDia || 0) - (a.vendeDia || 0) || a.descricao.localeCompare(b.descricao));
  const grupos = [];
  for (const it of lista) { let g = grupos[grupos.length - 1]; if (!g || g.curva !== it.curva) { g = { curva: it.curva, itens: [] }; grupos.push(g); } g.itens.push(it); }
  return grupos;
}

/** PDF (Buffer) do dia, ou só de uma nota (nCompra). Sem valores (Tiago, 03/11). modo 'curva' = lista única A → B → C → Novo. */
async function pdf({ loja, dia, nCompra, usuario, modo }, deps) {
  const PDFDocument = require('pdfkit'); const LOGO = require('./logo-economico');
  const dados = await listar({ loja, dia }, deps);
  const notas = nCompra ? dados.notas.filter(n => n.nCompra === +nCompra) : dados.notas;
  const curva = modo === 'curva';
  const NAVY = '#14213D';
  const doc = new PDFDocument({ size: 'A4', margin: 28, bufferPages: true, info: { Title: 'Notas finalizadas · ' + dados.lojaTxt + ' · ' + dataBR(dados.dia) + (curva ? ' · por curva' : ''), Author: 'Econômico Supermercados' } });
  const chunks = []; doc.on('data', c => chunks.push(c)); const fim = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  const X = 28, W = doc.page.width - 56;
  const cols = curva ? [['', 16], ['Código', 86], ['Produto', 0], ['NF', 50], ['Unid.', 36], ['Qtd nota', 58], ['Recebido', 58]] : [['Código', 86], ['Produto', 0], ['Unid.', 40], ['Qtd nota', 62], ['Recebido', 62]];
  const iProd = curva ? 2 : 1, iNum = curva ? 5 : 3;
  cols[iProd][1] = W - cols.reduce((s, c) => s + c[1], 0); const sx = []; let acc = X; for (const c of cols) { sx.push(acc); acc += c[1]; }
  const nProd = notas.reduce((s, n) => s + n.itens.length, 0);
  const cab = () => {
    LOGO.desenhar(doc, X, 18, 60);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('NOTAS FINALIZADAS · ' + dados.lojaTxt.toUpperCase(), X + 74, 22, { width: W - 74 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111').text(dataBR(dados.dia) + ' · ' + notas.length + (notas.length === 1 ? ' nota' : ' notas') + ' · ' + nProd + ' produtos' + (curva ? ' · por curva' : ''), X + 74, 40, { width: W - 74 });
    doc.font('Helvetica').fontSize(7.5).fillColor('#555').text('Entradas finalizadas no ERP · emitido ' + new Date().toLocaleString('pt-BR') + (usuario ? ' por ' + usuario : '') + ' · quantidades em unidades de estoque' + (curva ? ' · curva = venda ' + (dados.curva ? dados.curva.dias : CURVA_DIAS) + ' dias desta loja' : '') + ' · "Recebido" = contagem do coletor', X + 74, 54, { width: W - 74 });
    doc.y = 76;
  };
  const cabTab = () => {
    doc.rect(X, doc.y, W, 14).fill('#E6ECF4'); doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY); const y = doc.y + 4;
    cols.forEach(([t, w], k) => doc.text(t, sx[k] + 2, y, { width: w - 4, lineBreak: false, align: k >= iNum ? 'right' : 'left' })); doc.y = y + 12;
  };
  const linha = (it, i, extra) => {
    if (doc.y > doc.page.height - 44) { doc.addPage(); cab(); cabTab(); }
    const y = doc.y; if (i % 2) doc.rect(X, y - 2, W, 14).fill('#F6F7FA');
    let k = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor('#111');
    if (curva) { doc.font('Helvetica-Bold').text(it.curva === 'N' ? '★' : (it.curva || '–'), sx[k] + 2, y, { width: cols[k][1] - 4, lineBreak: false }); k++; doc.font('Helvetica'); }
    doc.text(it.cod, sx[k] + 2, y, { width: cols[k][1] - 4, lineBreak: false }); k++;
    doc.text(cabe(doc, it.descricao, cols[k][1] - 4), sx[k] + 2, y, { width: cols[k][1], lineBreak: false }); k++;
    if (curva) { doc.fillColor('#444').text(cabe(doc, extra.nNota, cols[k][1] - 4), sx[k] + 2, y, { width: cols[k][1] - 4, lineBreak: false }); k++; }
    doc.fillColor('#444').text(it.unid, sx[k] + 2, y, { width: cols[k][1] - 4, lineBreak: false }); k++;
    doc.fillColor('#111').text(qtdTxt(it.qtd), sx[k] + 2, y, { width: cols[k][1] - 4, lineBreak: false, align: 'right' }); k++;
    doc.font(it.dif ? 'Helvetica-Bold' : 'Helvetica').fillColor(it.dif ? '#C22F49' : '#111').text(qtdTxt(it.recebido), sx[k] + 2, y, { width: cols[k][1] - 4, lineBreak: false, align: 'right' });
    doc.y = y + 14;
  };
  cab();
  if (curva) {
    if (notas.length) {
      cabTab();
      for (const g of porCurva(notas)) {
        if (doc.y > doc.page.height - 70) { doc.addPage(); cab(); cabTab(); }
        const y0 = doc.y + 4; const [tit, sub] = GRUPO_TXT[g.curva] || ['SEM CURVA', 'espelho do ERP indisponível'];
        doc.rect(X, y0, W, 15).fill('#F4F4F2'); doc.rect(X, y0, 3, 15).fill(g.curva === 'A' ? '#B45C00' : g.curva === 'B' ? '#2C4A6B' : g.curva === 'N' ? '#F5B800' : '#9AA0AA');
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text(tit + ' · ' + g.itens.length + (g.itens.length === 1 ? ' produto' : ' produtos'), X + 8, y0 + 4, { lineBreak: false });
        if (sub) doc.font('Helvetica').fontSize(7.5).fillColor('#555').text(sub, X, y0 + 4.5, { width: W - 6, align: 'right', lineBreak: false });
        doc.y = y0 + 19; let i = 0;
        for (const it of g.itens) linha(it, i++, it);
      }
    }
  } else for (const n of notas) {
    if (doc.y > doc.page.height - 90) { doc.addPage(); cab(); }
    const y0 = doc.y + 6;
    doc.rect(X, y0, 3, 16).fill('#F5B800');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text(cabe(doc, 'NF ' + n.nNota + ' — ' + n.fornecedor + (n.bonificacao ? ' (bonificação)' : ''), W * 0.62), X + 8, y0 + 4, { lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor('#555').text([n.hora ? 'finalizada ' + n.hora : null, n.conferente ? 'conferente ' + n.conferente : null, n.itens.length + (n.itens.length === 1 ? ' produto' : ' produtos')].filter(Boolean).join(' · '), X, y0 + 5, { width: W, align: 'right', lineBreak: false });
    doc.y = y0 + 20; cabTab(); let i = 0;
    for (const it of n.itens) linha(it, i++, n);
  }
  if (!notas.length) doc.font('Helvetica').fontSize(10).fillColor('#666').text('Nenhuma nota finalizada nesta loja neste dia.', X, doc.y + 12, { width: W, align: 'center' });
  else {
    if (doc.y > doc.page.height - 110) { doc.addPage(); cab(); }
    const y = doc.y + 10; doc.moveTo(X, y).lineTo(X + W, y).lineWidth(1.2).stroke('#111');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text('TOTAL DO DIA', X, y + 6, { lineBreak: false });
    doc.text(notas.length + (notas.length === 1 ? ' nota' : ' notas') + ' · ' + nProd + ' produtos', X, y + 6, { width: W, align: 'right', lineBreak: false });
    const ya = y + 60; doc.lineWidth(0.7);
    doc.moveTo(X + 20, ya).lineTo(X + W / 2 - 20, ya).stroke('#111'); doc.moveTo(X + W / 2 + 20, ya).lineTo(X + W - 20, ya).stroke('#111');
    doc.font('Helvetica').fontSize(8).fillColor('#555').text('Gerente da loja', X + 20, ya + 4, { width: W / 2 - 40, align: 'center' });
    doc.text(curva ? 'Repositor' : 'Conferente', X + W / 2 + 20, ya + 4, { width: W / 2 - 40, align: 'center' });
  }
  const total = doc.bufferedPageRange().count;
  for (let p = 0; p < total; p++) {
    doc.switchToPage(p); doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('Econômico Supermercados · Gestão Gerencial · Notas finalizadas · ' + dados.lojaTxt + ' · ' + dataBR(dados.dia) + (curva ? ' · por curva' : '') + '   —   página ' + (p + 1) + ' de ' + total, X, doc.page.height - 22, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return fim;
}

// ── Ações do gerente no "Chegou e não vendeu" (data/notas-finalizadas/acoes.json, gitignored) ──────────────────────────
// Estava no depósito · Já na gôndola · Sem etiqueta · Não achei. Marcado = some da lista por 7 dias (ACAO_DIAS).
const fs = require('fs'); const path = require('path');
const ACOES = { deposito: 'Estava no depósito', gondola: 'Já na gôndola', etiqueta: 'Sem etiqueta', nao_achei: 'Não achei' };
const ACAO_DIAS = 7;
let ARQ_ACOES = null, acoes = [];
function initAcoes(deps) {
  ARQ_ACOES = path.join((deps && deps.dataDir) || path.join(__dirname, '..', 'data', 'notas-finalizadas'), 'acoes.json');
  try { acoes = JSON.parse(fs.readFileSync(ARQ_ACOES, 'utf8')); if (!Array.isArray(acoes)) acoes = []; } catch (e) { acoes = []; }
}
function gravarAcoes() { try { fs.mkdirSync(path.dirname(ARQ_ACOES), { recursive: true }); fs.writeFileSync(ARQ_ACOES, JSON.stringify(acoes)); } catch (e) { console.error('[notas-finalizadas] gravar ações:', e.message); } }
function acaoVigente(loja, cod, agora) {
  const lim = (agora || Date.now()) - ACAO_DIAS * 86400e3; let ult = null;
  for (const a of acoes) if (+a.loja === +loja && a.cod === cod && Date.parse(a.em) >= lim && (!ult || a.em > ult.em)) ult = a;
  return ult;
}
/** Gerente marca o que achou do produto. Devolve a ação gravada. */
function marcar({ loja, cod, acao, usuario, nCompra, descricao, nNota }) {
  if (!ARQ_ACOES) initAcoes({});
  const ln = +loja; cod = String(cod || '').trim();
  if (!ln || !cod) throw new Error('Loja e produto são obrigatórios');
  if (!ACOES[acao]) throw new Error('Ação inválida');
  const a = { loja: ln, cod, acao, acaoTxt: ACOES[acao], em: new Date().toISOString(), usuario: usuario || null, nCompra: nCompra ? +nCompra : null, nNota: nNota ? String(nNota) : null, descricao: String(descricao || '').slice(0, 120) };
  acoes.push(a); if (acoes.length > 20000) acoes = acoes.slice(-15000);
  gravarAcoes(); PARADO_CACHE.delete(ln + '|7'); PARADO_CACHE.delete(ln + '|14');
  return a;
}
/** Ações registradas (admin): últimas primeiro; filtros opcionais loja / acao. */
function listarAcoes({ loja, acao, limite } = {}) {
  if (!ARQ_ACOES) initAcoes({});
  return acoes.filter(a => (!loja || +a.loja === +loja) && (!acao || a.acao === acao)).slice(-(limite || 500)).reverse();
}

// ── "Chegou e não vendeu" ────────────────────────────────────────────────────────────────────────────────────────────
// Janela: notas finalizadas entre `dias` e `dias`+14 dias atrás (7 → 21..7 dias atrás; 14 → 28..14). Nota de hoje não entra.
// Venda = espelho do Postgres (venda_dia_produto) do dia seguinte à nota até ontem; "antes" = 30 dias antes da nota.
//   sem   = vendeu 0, estoque ERP > 0 (ou desconhecido) e esperado (média 30 d × dias) ≥ 1 → provável depósito
//   novo  = vendeu 0, estoque > 0 e sem venda nos 30 dias antes da nota → precisa de exposição
//   fraco = vendeu > 0 mas menos de 10 % do que chegou E menos de 30 % do esperado
//   ok    = o resto (inclui curva C que normalmente não venderia 1 un. no prazo e estoque zero = já saiu)
const PARADO_CACHE = new Map(); const PARADO_TTL = 30 * 60e3;
const PARADO_JANELA = 14;
function classificar(p) {
  if (p.estoque != null && p.estoque <= 0) return 'ok';
  // pesado (KG) que nunca vendeu com este código sai pelo código da balança (carcaça vira cortes, fruta vira etiqueta): não é "novo"
  if (p.vendeu <= 0 && p.antes <= 0) return String(p.unid || '').toUpperCase() === 'KG' ? 'ok' : 'novo';
  if (p.vendeu <= 0 && p.esperado >= 1) return 'sem';
  if (p.vendeu > 0 && p.vendeu < 0.1 * p.qtd && p.vendeu < 0.3 * p.esperado) return 'fraco';
  return 'ok';
}
/** Junta as notas da janela em produtos (mesmo código em 2 notas = 1 produto, chegada mais antiga, qtd somada). */
function produtosDaJanela(notas) {
  const m = new Map();
  for (const n of notas) for (const it of n.itens) {
    let p = m.get(it.cod);
    if (!p) { p = { cod: it.cod, descricao: it.descricao, unid: it.unid, qtd: 0, chegou: n.dia, notas: [], curva: it.curva, vendeDia: it.vendeDia }; m.set(it.cod, p); }
    p.qtd = r3(p.qtd + it.qtd); if (n.dia < p.chegou) p.chegou = n.dia;
    if (!p.notas.some(x => x.nCompra === n.nCompra)) p.notas.push({ nCompra: n.nCompra, nNota: n.nNota, fornecedor: n.fornecedor, dia: n.dia });
  }
  return [...m.values()];
}
/** Classifica os produtos com as vendas por dia ({cod: {dia: qtd}}), estoque ({cod: qtd} ou null) e a data de ontem. Função pura. */
function avaliar(produtos, vendasPorDia, estoque, ontem, agora) {
  const out = [];
  for (const p of produtos) {
    const vd = vendasPorDia[p.cod] || {}; const ini = menosDias(p.chegou, -1), ini30 = menosDias(p.chegou, 30), fim30 = menosDias(p.chegou, 1);
    let vendeu = 0, antes = 0;
    for (const [d, q] of Object.entries(vd)) { if (d >= ini && d <= ontem) vendeu += q; else if (d >= ini30 && d <= fim30) antes += q; }
    const diasSem = Math.max(0, difDias(p.chegou, ontem)); const media = antes / 30; const esperado = media * diasSem;
    const est = estoque ? (estoque[p.cod] != null ? +estoque[p.cod] : null) : null;
    const x = { ...p, vendeu: r3(vendeu), antes: r3(antes), mediaDia: r1(media), diasSem, esperado: Math.round(esperado), estoque: est };
    x.classe = classificar(x);
    const a = acaoVigente(x.lojaNum, p.cod, agora);
    if (a) x.acao = { acao: a.acao, acaoTxt: a.acaoTxt, em: a.em, usuario: a.usuario };
    out.push(x);
  }
  return out;
}
const ORDEM_CLASSE = { sem: 0, novo: 1, fraco: 2, ok: 3 };
/** deps: { q, espelho, abcLojas? } → lista de ação do gerente. */
async function parado({ loja, dias }, deps) {
  const ln = +loja; if (!ln) throw new Error('Escolha uma loja');
  const d = +dias === 14 ? 14 : 7; const chave = ln + '|' + d; const c = PARADO_CACHE.get(chave);
  if (c && Date.now() - c.em < PARADO_TTL) return c.v;
  const hoje = hojeStr(), ontem = menosDias(hoje, 1), fim = menosDias(hoje, d), ini = menosDias(hoje, d + PARADO_JANELA);
  const base = { loja: ln, lojaTxt: LOJA_TXT[ln] || 'Loja ' + ln, dias: d, janela: { ini, fim }, ate: ontem };
  const esp = deps.espelho;
  if (!esp || !esp.pronto || !esp.pronto()) return { ...base, erro: 'Espelho do ERP indisponível: a venda por dia ainda não pode ser lida.', itens: [], resumo: { sem: 0, novos: 0, fracos: 0, ok: 0, marcados: 0 } };
  const notas = await carregarNotas(ln, ini, fim, deps);
  const curva = await curvaLoja(ln, deps); aplicarCurva(notas, curva);
  const produtos = produtosDaJanela(notas); for (const p of produtos) p.lojaNum = ln;
  const codigos = produtos.map(p => p.cod);
  let vendasPorDia = {}, estoque = null, fonte = 'espelho';
  if (codigos.length) {
    const dIniV = menosDias(ini, 30);
    if (!(await esp.temCobertura([ln], dIniV, ontem))) return { ...base, erro: 'Espelho do ERP sem cobertura de ' + dataBR(dIniV) + ' a ' + dataBR(ontem) + ' nesta loja.', itens: [], resumo: { sem: 0, novos: 0, fracos: 0, ok: 0, marcados: 0 } };
    const rows = await esp.pq(`SELECT codigo, to_char(dia, 'YYYY-MM-DD') dia, qtd FROM venda_dia_produto WHERE loja = $1 AND codigo = ANY($2) AND dia BETWEEN $3 AND $4`, [ln, codigos.map(c => c.slice(0, 14)), dIniV, ontem]);
    for (const r of rows) { const k = String(r.codigo || '').trim(); (vendasPorDia[k] = vendasPorDia[k] || {})[r.dia] = (+r.qtd || 0); }
    try { const er = await esp.estoqueAtual([ln], codigos); if (er) { estoque = {}; for (const r of er) estoque[String(r.codigo || '').trim()] = +r.qtd || 0; } } catch (e) { console.error('[notas-finalizadas] estoque:', e.message); }
  }
  const todos = avaliar(produtos, vendasPorDia, estoque, ontem);
  const resumo = { sem: 0, novos: 0, fracos: 0, ok: 0, marcados: 0, produtos: todos.length, notas: notas.length };
  const itens = [];
  for (const x of todos) {
    delete x.lojaNum;
    if (x.classe === 'ok') { resumo.ok++; continue; }
    if (x.acao) { resumo.marcados++; continue; }
    resumo[x.classe === 'sem' ? 'sem' : x.classe === 'novo' ? 'novos' : 'fracos']++; itens.push(x);
  }
  itens.sort((a, b) => ORDEM_CLASSE[a.classe] - ORDEM_CLASSE[b.classe] || (b.esperado - a.esperado) || (b.qtd - a.qtd));
  const v = { ...base, fonte, estoqueOk: !!estoque, curva: curva ? { dias: curva.dias, fonte: curva.fonte } : null, resumo, itens, acoes: ACOES };
  PARADO_CACHE.set(chave, { em: Date.now(), v });
  return v;
}

// ── Aviso no celular do gerente (03/11/2026, Tiago: "e quando finalizar aparece nas notificações do gerente da loja") ──
// rodar() a cada 5 min (server.js): nota que não estava na lista vira um push pra loja (lib/gerencial-push.js notificarLoja).
// Já vistas em data/gerencial-push/notas-finalizadas.json (por dia), então reiniciar o servidor não repete aviso. Primeira passada
// do dia sem arquivo = só marca (não despeja as notas da manhã de uma vez). Mais de 3 novas na mesma passada = um aviso só.
// Fase 2: o aviso da nota diz quantos produtos são curva A e quantos são novos; às 08:00 (até 11:00 se o servidor estava parado)
// um push por loja com os produtos que ENTRARAM na lista "chegou e não vendeu" (sem venda ou novo), cada produto uma vez a cada 7 dias.
let ARQ = null, vistos = { dia: null, chaves: [], iniciado: false, paradoDia: null, paradoAvisados: {} };
const PARADO_HORA = 8, PARADO_HORA_FIM = 11;
function initAvisos(deps) {
  ARQ = path.join((deps && deps.dataDir) || path.join(__dirname, '..', 'data', 'gerencial-push'), 'notas-finalizadas.json');
  try { vistos = Object.assign({ dia: null, chaves: [], iniciado: false, paradoDia: null, paradoAvisados: {} }, JSON.parse(fs.readFileSync(ARQ, 'utf8'))); } catch (e) { vistos = { dia: null, chaves: [], iniciado: false, paradoDia: null, paradoAvisados: {} }; }
  initAcoes(deps && deps.dataDir ? { dataDir: path.join(deps.dataDir, 'notas-finalizadas') } : undefined);
}
function gravarVistos() { try { fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(vistos)); } catch (e) { console.error('[notas-finalizadas] gravar:', e.message); } }
function textoNota(n) {
  const a = n.itens.filter(i => i.curva === 'A').length, nv = n.itens.filter(i => i.curva === 'N').length;
  return n.fornecedor + ' · ' + n.itens.length + (n.itens.length === 1 ? ' produto' : ' produtos') + (a ? ' · ' + a + (a === 1 ? ' produto curva A' : ' produtos curva A') : '') + (nv ? ' · ' + nv + (nv === 1 ? ' produto novo' : ' produtos novos') : '') + (n.diferencas ? ' · ' + n.diferencas + ' com diferença no coletor' : '') + (n.hora ? ' · ' + n.hora : '');
}
/** Monta o push do "chegou e não vendeu" da loja (função pura): só produtos ainda não avisados nos últimos 7 dias. */
function avisoParado(p, avisados, dia) {
  const lim = menosDias(dia, ACAO_DIAS);
  const novos = p.itens.filter(x => (x.classe === 'sem' || x.classe === 'novo') && !(avisados[p.loja + '|' + x.cod] >= lim));
  if (!novos.length) return null;
  const nomes = novos.map(x => x.descricao).join(', ');
  return { chaves: novos.map(x => p.loja + '|' + x.cod), payload: { title: p.lojaTxt + ': ' + novos.length + (novos.length === 1 ? ' produto chegou e não vendeu' : ' produtos chegaram e não venderam'), body: nomes.slice(0, 180), url: '/gestao-gerencial.html#notas/parado', tag: 'nf-parado-' + dia + '-' + p.loja } };
}
/** deps: { q, espelho?, abcLojas?, notificarLoja(loja, payload, ttl), lojas?, agora? } → { novas, avisos, parados } */
async function rodar(deps) {
  if (!ARQ) initAvisos({});
  const agora = deps.agora ? new Date(deps.agora) : new Date();
  const dia = ymd(agora); if (vistos.dia !== dia) vistos = { ...vistos, dia, chaves: [], iniciado: vistos.dia != null };
  const set = new Set(vistos.chaves); let novas = 0, avisos = 0, parados = 0;
  const lojas = deps.lojas || [1, 2, 3, 4, 5, 6];
  for (const loja of lojas) {
    let d; try { d = await listar({ loja, dia }, deps); } catch (e) { console.error('[notas-finalizadas] loja ' + loja + ':', e.message); continue; }
    const nov = d.notas.filter(n => !set.has(loja + '|' + n.nCompra));
    for (const n of nov) set.add(loja + '|' + n.nCompra);
    if (!nov.length || !vistos.iniciado) continue;
    novas += nov.length;
    const url = '/gestao-gerencial.html#notas/' + dia;
    const lista = nov.length > 3 ? [{ title: nov.length + ' notas finalizadas · ' + d.lojaTxt, body: nov.map(n => 'NF ' + n.nNota + ' ' + n.fornecedor).join(' · ').slice(0, 180), url, tag: 'nf-' + dia + '-' + loja }]
      : nov.map(n => ({ title: 'Nota finalizada · NF ' + n.nNota, body: textoNota(n), url, tag: 'nf-' + loja + '-' + n.nCompra }));
    for (const p of lista) { try { await deps.notificarLoja(loja, p, 6 * 3600); avisos++; } catch (e) { console.error('[notas-finalizadas] push loja ' + loja + ':', e.message); } }
  }
  vistos.chaves = [...set]; vistos.iniciado = true;
  // 08:00 — chegou e não vendeu (uma vez por dia; se o servidor estava parado às 08:00, manda até as 11:00)
  const hh = agora.getHours();
  if (vistos.paradoDia !== dia && hh >= PARADO_HORA && hh < PARADO_HORA_FIM && deps.espelho) {
    vistos.paradoDia = dia; const avisados = vistos.paradoAvisados || (vistos.paradoAvisados = {});
    for (const k of Object.keys(avisados)) if (avisados[k] < menosDias(dia, 30)) delete avisados[k];
    for (const loja of lojas) {
      let p; try { p = await parado({ loja, dias: 7 }, deps); } catch (e) { console.error('[notas-finalizadas] parado loja ' + loja + ':', e.message); continue; }
      if (p.erro) continue;
      const av = avisoParado(p, avisados, dia); if (!av) continue;
      try { await deps.notificarLoja(loja, av.payload, 12 * 3600); parados++; for (const k of av.chaves) avisados[k] = dia; } catch (e) { console.error('[notas-finalizadas] push parado loja ' + loja + ':', e.message); }
    }
  }
  gravarVistos();
  return { novas, avisos, parados };
}

module.exports = { listar, parado, marcar, listarAcoes, pdf, nomePdf, hojeStr, initAvisos, initAcoes, rodar, ACOES,
  _puras: { classificar, avaliar, produtosDaJanela, porCurva, avisoParado, textoNota, aplicarCurva, acaoVigente, _vistos: () => vistos, _resetCaches: () => { CACHE.clear(); PARADO_CACHE.clear(); CURVA_CACHE.clear(); } } };
