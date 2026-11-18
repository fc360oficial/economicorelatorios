'use strict';
// lib/recebimento-entrada.js — itens da nota pro Coletor Econômico: o XML da NF-e (central.axmlprodutos) completado
// pela ENTRADA que o ERP já lançou pra mesma nota (central.compraprodutos). Puro, sem banco (testes em
// test/recebimento-entrada.test.js).
//
// 18/11/26 (Tiago, CD, NF 340 Comercial Campos, "PAMPULHA QUEIJO RALADO 50G"): "no ERP esse Pampulha veio 300 c/20,
// entrou 6000 unidades; no nosso sistema isso já está entendendo?" — não estava. O XML traz a linha SEM código de barras
// (texto "SEM GTIN"), 300 CX comerciais = 300 CX tributárias: nada ali diz que a caixa tem 20. Quem sabe é a entrada do
// ERP: código interno 7898920160897, Unid CX, Qtd 300, QtdEmb 20, QtdEntradaEstoque 6000. O coletor só lia o XML, então
// o produto bipado caía em "não está na nota" e as 300 caixas viravam 300 unidades.
//
// O que a entrada acrescenta, linha a linha:
//   1) linha "SEM GTIN" do XML ganha o código interno da entrada (ligação pelo nº do item, conferida pela quantidade);
//   2) entrada em CAIXA com o mesmo código da linha (Unid ≠ unidade, QtdEmb > 1) e XML sem as un/cx: a linha passa a
//      valer as unidades de estoque da entrada (300 × 20 = 6.000), emb = 20 e cx = true (o coletor conta em caixas);
//   3) entrada com OUTRO código (a caixa, DUN-14): o código vira apelido da linha (erp) e as un/cx saem de
//      unidades da nota ÷ caixas da entrada (1.680 un ÷ 140 CX = 12) quando o XML não trouxe.
// Sem entrada no ERP, ou quando ela não muda nada, o resultado é o mesmo de antes (só o XML). A quantidade do XML só é
// trocada no caso 2 — entrada "crua" (UN, emb 1) nunca rebaixa o que o XML diz.

const num = v => { let s = String(v ?? '0').trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };
const gtinOk = v => /^\d{8,14}$/.test(String(v || '')) && !/^0+$/.test(String(v || ''));
const UND_UNITARIA = new Set(['UN', 'UND', 'UNID', 'UNI', 'U', 'PC', 'PÇ', 'PCS', 'KG', 'G', 'L', 'LT', 'ML', 'M', 'MT']);
// inteiro ≥ 2 (com folga de arredondamento) ou 0
const inteiro2 = v => (v > 1.999 && Math.abs(v - Math.round(v)) < 0.001 ? Math.round(v) : 0);

// linhas do XML, uma por item da nota (mesma leitura que o coletor sempre fez de axmlprodutos)
function linhasXml(prods) {
  const out = [];
  for (const p of prods || []) {
    const cb = String(p.CodigoBarras || '').trim(), et = String(p.ocEanTrib || '').trim();
    let k = cb && cb !== '0' ? cb : et; if (!k) continue;
    if (!/^\d+$/.test(k) && gtinOk(et)) k = et;   // "SEM GTIN" no código comercial e EAN tributário válido: vale o EAN
    const qTrib = num(p.oqTrib), qCom = num(p.Qtd);
    const un = qTrib > 0 ? qTrib : qCom;
    // un/cx da PRÓPRIA nota (200 CX comerciais = 2400 un tributárias → 12)
    const emb = qTrib > 0 && qCom > 0 ? inteiro2(qTrib / qCom) || null : null;
    out.push({ nItem: +p.nItem || 0, cod: k, ean: et && et !== k ? et : null, descricao: String(p.Descricao || '').trim(), un: +un.toFixed(3), qCom, emb, semGtin: !/^\d+$/.test(k) });
  }
  return out;
}

// linhas da entrada do ERP (compraprodutos), sem as canceladas; est = unidades que entram no estoque (mesma conta do Fiscal)
function linhasEntrada(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || +r.Cancelado) continue;
    const cod = String(r.CodigoBarra || '').trim(); if (!cod) continue;
    const qtd = num(r.Qtd), qe = num(r.QtdEmb);
    const est = num(r.QtdEntradaEstoque) > 0 ? num(r.QtdEntradaEstoque) : qtd * (qe > 0 ? qe : 1);
    out.push({ item: +r.Item || 0, cod, und: String(r.Unid || '').toUpperCase().trim(), qtd, est, eanTrib: String(r.ocEanTrib || '').trim(), descricao: String(r.Descricao || '').trim() });
  }
  return out;
}

// liga cada linha do XML a UMA linha da entrada (cada linha da entrada é usada uma vez)
function casar(linhas, entrada) {
  const livres = new Set(entrada);
  const perto = (a, b) => Math.abs(a - b) < 0.001;
  for (const l of linhas) {
    const cands = [...livres]; let e = null;
    if (!l.semGtin) {
      const cods = [l.cod, l.ean].filter(Boolean);
      const bate = x => cods.includes(x.cod) || (gtinOk(x.eanTrib) && cods.includes(x.eanTrib));
      e = cands.find(x => x.item === l.nItem && bate(x)) || cands.find(bate) || null;
    } else {
      // sem código de barras só o nº do item liga as duas; a quantidade confere pra não casar com a linha errada
      const mesmaQtd = x => perto(x.qtd, l.qCom) || perto(x.qtd, l.un) || perto(x.est, l.un);
      e = cands.find(x => x.item === l.nItem && !gtinOk(x.eanTrib) && mesmaQtd(x)) || null;
    }
    if (e) { livres.delete(e); l.entrada = e; }
  }
  return linhas;
}

function aplicarEntrada(linhas) {
  const perto = (a, b) => Math.abs(a - b) < 0.001;
  for (const l of linhas) {
    const e = l.entrada; if (!e) continue;
    if (l.semGtin) { l.cod = e.cod; l.semGtin = false; if (e.descricao) l.descricao = e.descricao; }
    const emCaixa = !UND_UNITARIA.has(e.und);
    if (e.cod === l.cod) {
      const embEnt = e.qtd > 0 ? inteiro2(e.est / e.qtd) : 0;   // 6000 ÷ 300 = 20
      if (emCaixa && embEnt && !l.emb && (perto(e.qtd, l.un) || perto(e.qtd, l.qCom))) { l.un = +e.est.toFixed(3); l.emb = embEnt; l.cx = true; }
      else if (emCaixa && embEnt && l.emb === embEnt && perto(e.est, l.un)) l.cx = true;   // o XML já dizia o mesmo (200 CX = 2.400 un)
    } else {
      l.erp = e.cod;   // a entrada lançou por outro código (a caixa): bipar esse código cai nesta linha
      if (!l.emb && emCaixa && e.qtd > 0) { const r = inteiro2(l.un / e.qtd); if (r) l.emb = r; }   // 1.680 un ÷ 140 CX = 12
    }
  }
  return linhas;
}

// junta por código (mesma regra de sempre: un soma; un/cx só fica se for a mesma em todas as linhas do código)
function agrupar(linhas) {
  const porCod = new Map();
  for (const l of linhas) {
    const a = porCod.get(l.cod);
    if (a) {
      a.un = +(a.un + l.un).toFixed(3);
      if (a.emb !== l.emb) { a.emb = null; delete a.cx; } else if (!l.cx) delete a.cx;
      if (!a.ean && l.ean) a.ean = l.ean;
      if (!a.erp && l.erp) a.erp = l.erp;
    } else porCod.set(l.cod, { cod: l.cod, ean: l.ean || null, descricao: l.descricao, un: l.un, emb: l.emb, decisao: null, ...(l.erp ? { erp: l.erp } : {}), ...(l.cx ? { cx: true } : {}) });
  }
  return [...porCod.values()];
}

/** itensDaNota(prods, entrada) → [{ cod, ean, descricao, un, emb, decisao, erp?, cx? }]
 *  prods = linhas de central.axmlprodutos; entrada = linhas de central.compraprodutos da mesma nota (ou [] / null). */
function itensDaNota(prods, entrada) {
  const linhas = linhasXml(prods);
  const ent = linhasEntrada(entrada);
  if (ent.length) aplicarEntrada(casar(linhas, ent));
  return agrupar(linhas);
}

module.exports = { itensDaNota, linhasXml, linhasEntrada, num, gtinOk };
