// Gestão Gerencial › Notas Finalizadas (03/11/2026, Tiago: "coloca uma aba com as notas que está finalizada e clicando mostra os
// produtos e em cima um PDF com os produtos todos que finalizou no dia, com as datas pra trocar se eu quero ver ontem, hoje").
// "Finalizada" = entrada da loja fechada no ERP: central.compras Status 'F', Movimentacao COMPRA ou BONIFICACAO, no dia do
// status (DataStatus). Itens = central.compraprodutos (código interno, QtdEntradaEstoque em unidades, custo unitário).
// Recebido = contagem do coletor do ERP (central.conferenciaitens, qtd × qtdemb por código, mesma régua do lib/fiscal.js);
// quando a conferência junta mais de uma nota (compra + bonificação) a contagem não separa por nota → fica sem "Recebido".
// PDF (Tiago, 03/11: "no PDF não precisa de valores") = só código, produto, quantidade da nota e recebido.
// Só leitura no ERP.
'use strict';

const LOJA_TXT = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão' };
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r3 = v => Math.round(v * 1000) / 1000;
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hojeStr = () => ymd(new Date());
const diaValido = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : hojeStr();
const menosDias = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() - n); return ymd(d); };
const hm = h => { const s = String(h || ''); return /^\d{2}:\d{2}/.test(s) && !s.startsWith('00:00') ? s.slice(0, 5) : null; };

// cache curto por loja×dia: o gerente troca de dia e volta, e o dia de hoje muda ao longo do dia (3 min)
const CACHE = new Map(); const TTL_HOJE = 3 * 60e3, TTL_PASSADO = 30 * 60e3;

/** Notas finalizadas da loja no dia, com os itens. deps: { q } (SELECT no ERP). */
async function listar({ loja, dia }, deps) {
  const ln = +loja; if (!ln) throw new Error('Escolha uma loja');
  const d = diaValido(dia); const chave = ln + '|' + d; const c = CACHE.get(chave);
  if (c && Date.now() - c.em < (d === hojeStr() ? TTL_HOJE : TTL_PASSADO)) return c.v;
  const q = deps.q;
  // DataRecto tem índice; DataStatus (dia em que fechou) não → janela de 60 dias no DataRecto e o dia exato no DataStatus
  const notas = await q(`SELECT c.nCompra, c.nLoja, c.nNota, c.NomeFornec, c.CodFornec, c.Movimentacao, c.TotalNota, c.NomeOperador, c.nConferencia,
      DATE_FORMAT(c.DataRecto,'%Y-%m-%d') DataRecto, cf.OperadorLoja, cf.OperadorLiberacao, cf.HoraLiberacao, cf.HoraConferido,
      DATE_FORMAT(cf.DataLiberacao,'%Y-%m-%d') DataLiberacao, DATE_FORMAT(cf.DataConferido,'%Y-%m-%d') DataConferido
    FROM central.compras c LEFT JOIN central.conferencia cf ON cf.nReg = c.nConferencia AND c.nConferencia > 0
    WHERE c.nLoja = ? AND c.Status = 'F' AND c.Movimentacao IN ('COMPRA','BONIFICACAO') AND c.DataRecto BETWEEN ? AND ? AND c.DataStatus = ?
    ORDER BY c.nCompra`, [ln, menosDias(d, 60), d, d]);
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
  const out = notas.map(n => {
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
      bonificacao: /BONIF/i.test(n.Movimentacao), total: num(n.TotalNota), hora, chegada: n.DataRecto,
      conferente: String(n.OperadorLoja || '').trim() || null, lancou: String(n.NomeOperador || '').trim() || null,
      coletor: !!comparar, diferencas: lin.filter(l => l.dif).length, itens: lin,
    };
  }).sort((a, b) => String(a.hora || '99').localeCompare(String(b.hora || '99')) || a.nCompra - b.nCompra);
  const v = { loja: ln, lojaTxt: LOJA_TXT[ln] || 'Loja ' + ln, dia: d, notas: out,
    resumo: { notas: out.length, produtos: out.reduce((s, n) => s + n.itens.length, 0), valor: Math.round(out.reduce((s, n) => s + n.total, 0) * 100) / 100, comDiferenca: out.filter(n => n.diferencas).length } };
  CACHE.set(chave, { em: Date.now(), v }); if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
  return v;
}

const dataBR = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';
const qtdTxt = v => v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
function cabe(doc, s, w) { s = String(s || ''); if (doc.widthOfString(s) <= w) return s; while (s.length > 1 && doc.widthOfString(s + '…') > w) s = s.slice(0, -1); return s.trimEnd() + '…'; }
function nomePdf(loja, dia, nCompra) { return 'notas-finalizadas-E' + loja + '-' + diaValido(dia) + (nCompra ? '-' + nCompra : '') + '.pdf'; }

/** PDF (Buffer) do dia, ou só de uma nota (nCompra). Sem valores (Tiago, 03/11). */
async function pdf({ loja, dia, nCompra, usuario }, deps) {
  const PDFDocument = require('pdfkit'); const LOGO = require('./logo-economico');
  const dados = await listar({ loja, dia }, deps);
  const notas = nCompra ? dados.notas.filter(n => n.nCompra === +nCompra) : dados.notas;
  const NAVY = '#14213D';
  const doc = new PDFDocument({ size: 'A4', margin: 28, bufferPages: true, info: { Title: 'Notas finalizadas · ' + dados.lojaTxt + ' · ' + dataBR(dados.dia), Author: 'Econômico Supermercados' } });
  const chunks = []; doc.on('data', c => chunks.push(c)); const fim = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  const X = 28, W = doc.page.width - 56;
  const cols = [['Código', 86], ['Produto', 0], ['Unid.', 40], ['Qtd nota', 62], ['Recebido', 62]];
  cols[1][1] = W - cols.reduce((s, c) => s + c[1], 0); const sx = []; let acc = X; for (const c of cols) { sx.push(acc); acc += c[1]; }
  const nProd = notas.reduce((s, n) => s + n.itens.length, 0);
  const cab = () => {
    LOGO.desenhar(doc, X, 18, 60);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('NOTAS FINALIZADAS · ' + dados.lojaTxt.toUpperCase(), X + 74, 22, { width: W - 74 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111').text(dataBR(dados.dia) + ' · ' + notas.length + (notas.length === 1 ? ' nota' : ' notas') + ' · ' + nProd + ' produtos', X + 74, 40, { width: W - 74 });
    doc.font('Helvetica').fontSize(7.5).fillColor('#555').text('Entradas finalizadas no ERP · emitido ' + new Date().toLocaleString('pt-BR') + (usuario ? ' por ' + usuario : '') + ' · quantidades em unidades de estoque · "Recebido" = contagem do coletor', X + 74, 54, { width: W - 74 });
    doc.y = 76;
  };
  const cabTab = () => {
    doc.rect(X, doc.y, W, 14).fill('#E6ECF4'); doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY); const y = doc.y + 4;
    cols.forEach(([t, w], k) => doc.text(t, sx[k] + 2, y, { width: w - 4, lineBreak: false, align: k >= 3 ? 'right' : 'left' })); doc.y = y + 12;
  };
  cab();
  for (const n of notas) {
    if (doc.y > doc.page.height - 90) { doc.addPage(); cab(); }
    const y0 = doc.y + 6;
    doc.rect(X, y0, 3, 16).fill('#F5B800');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text(cabe(doc, 'NF ' + n.nNota + ' — ' + n.fornecedor + (n.bonificacao ? ' (bonificação)' : ''), W * 0.62), X + 8, y0 + 4, { lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor('#555').text([n.hora ? 'finalizada ' + n.hora : null, n.conferente ? 'conferente ' + n.conferente : null, n.itens.length + (n.itens.length === 1 ? ' produto' : ' produtos')].filter(Boolean).join(' · '), X, y0 + 5, { width: W, align: 'right', lineBreak: false });
    doc.y = y0 + 20; cabTab(); let i = 0;
    for (const it of n.itens) {
      if (doc.y > doc.page.height - 44) { doc.addPage(); cab(); cabTab(); }
      const y = doc.y; if (i++ % 2) doc.rect(X, y - 2, W, 14).fill('#F6F7FA');
      doc.font('Helvetica').fontSize(7.5).fillColor('#111');
      doc.text(it.cod, sx[0] + 2, y, { width: cols[0][1] - 4, lineBreak: false });
      doc.text(cabe(doc, it.descricao, cols[1][1] - 4), sx[1] + 2, y, { width: cols[1][1], lineBreak: false });
      doc.fillColor('#444').text(it.unid, sx[2] + 2, y, { width: cols[2][1] - 4, lineBreak: false });
      doc.fillColor('#111').text(qtdTxt(it.qtd), sx[3] + 2, y, { width: cols[3][1] - 4, lineBreak: false, align: 'right' });
      doc.font(it.dif ? 'Helvetica-Bold' : 'Helvetica').fillColor(it.dif ? '#C22F49' : '#111').text(qtdTxt(it.recebido), sx[4] + 2, y, { width: cols[4][1] - 4, lineBreak: false, align: 'right' });
      doc.y = y + 14;
    }
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
    doc.text('Conferente', X + W / 2 + 20, ya + 4, { width: W / 2 - 40, align: 'center' });
  }
  const total = doc.bufferedPageRange().count;
  for (let p = 0; p < total; p++) {
    doc.switchToPage(p); doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('Econômico Supermercados · Gestão Gerencial · Notas finalizadas · ' + dados.lojaTxt + ' · ' + dataBR(dados.dia) + '   —   página ' + (p + 1) + ' de ' + total, X, doc.page.height - 22, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return fim;
}

// ── Aviso no celular do gerente (03/11/2026, Tiago: "e quando finalizar aparece nas notificações do gerente da loja") ──
// rodar() a cada 5 min (server.js): nota que não estava na lista vira um push pra loja (lib/gerencial-push.js notificarLoja).
// Já vistas em data/gerencial-push/notas-finalizadas.json (por dia), então reiniciar o servidor não repete aviso. Primeira passada
// do dia sem arquivo = só marca (não despeja as notas da manhã de uma vez). Mais de 3 novas na mesma passada = um aviso só.
const fs = require('fs'); const path = require('path');
let ARQ = null, vistos = { dia: null, chaves: [], iniciado: false };
function initAvisos(deps) {
  ARQ = path.join((deps && deps.dataDir) || path.join(__dirname, '..', 'data', 'gerencial-push'), 'notas-finalizadas.json');
  try { vistos = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { vistos = { dia: null, chaves: [], iniciado: false }; }
}
function gravarVistos() { try { fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(vistos)); } catch (e) { console.error('[notas-finalizadas] gravar:', e.message); } }
/** deps: { q, notificarLoja(loja, payload, ttl), lojas? } → { novas, avisos } */
async function rodar(deps) {
  if (!ARQ) initAvisos({});
  const dia = hojeStr(); if (vistos.dia !== dia) vistos = { dia, chaves: [], iniciado: vistos.dia != null };
  const set = new Set(vistos.chaves); let novas = 0, avisos = 0;
  for (const loja of deps.lojas || [1, 2, 3, 4, 5, 6]) {
    let d; try { d = await listar({ loja, dia }, deps); } catch (e) { console.error('[notas-finalizadas] loja ' + loja + ':', e.message); continue; }
    const nov = d.notas.filter(n => !set.has(loja + '|' + n.nCompra));
    for (const n of nov) set.add(loja + '|' + n.nCompra);
    if (!nov.length || !vistos.iniciado) continue;
    novas += nov.length;
    const url = '/gestao-gerencial.html#notas/' + dia;
    const lista = nov.length > 3 ? [{ title: nov.length + ' notas finalizadas · ' + d.lojaTxt, body: nov.map(n => 'NF ' + n.nNota + ' ' + n.fornecedor).join(' · ').slice(0, 180), url, tag: 'nf-' + dia + '-' + loja }]
      : nov.map(n => ({ title: 'Nota finalizada · NF ' + n.nNota, body: n.fornecedor + ' · ' + n.itens.length + (n.itens.length === 1 ? ' produto' : ' produtos') + (n.diferencas ? ' · ' + n.diferencas + ' com diferença no coletor' : '') + (n.hora ? ' · ' + n.hora : ''), url, tag: 'nf-' + loja + '-' + n.nCompra }));
    for (const p of lista) { try { await deps.notificarLoja(loja, p, 6 * 3600); avisos++; } catch (e) { console.error('[notas-finalizadas] push loja ' + loja + ':', e.message); } }
  }
  vistos.chaves = [...set]; vistos.iniciado = true; gravarVistos();
  return { novas, avisos };
}

module.exports = { listar, pdf, nomePdf, hojeStr, initAvisos, rodar };
