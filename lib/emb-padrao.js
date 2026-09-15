// Caixa padrão do produto (unidades por embalagem de compra) — busca funda sob demanda.
//
// Pedido do Tiago (14/09/2026, Cotação): "um botão de refresh pra gente apertar e o sistema tentar ir
// lá na entrada dos itens e achar um padrão pra caixa do produto; não deixar nenhum item sem padrão".
// O Radar só olha compraprodutos.QtdEmb dos últimos 36 meses (fornecedor da lista primeiro) e depois
// o cadastro (itens.qtdemb). Aqui, pros itens que ficaram sem padrão, vasculha TODAS as fontes de
// entrada, nesta ordem (a primeira que responde vale):
//   1. manual  — correção da Lista de Compra (data/unidade-embalagem-overrides.json)
//   2. notas   — compraprodutos.QtdEmb de QUALQUER época e fornecedor (central + backup_central),
//                moda; fornecedor da lista primeiro; empate → maior
//   3. xml     — axmlprodutos: Qtd (unidade comercial, caixas) × oqTrib (unidade tributável, unidades)
//                → un/cx = oqTrib ÷ Qtd quando é inteiro ≥ 2; moda
//   4. vendas  — central.embalagempadrao_venda.Qtd_venda ("Embalagem Vendas" do cadastro)
//   5. dun14   — cadastro tem um código de caixa (14 dígitos) cujo EAN-13 é este produto: qtdemb dele
//   6. erp     — lista_consolidado_historico.Emb (embalagem da última compra na sugestão do ERP)
// Resultado gravado em data/emb-padrao.json ({cod: {emb, fonte, detalhe, em}}); o Radar usa como
// fallback depois das notas recentes (radar-pedidos.embEfetiva). SOMENTE LEITURA no ERP.
const fs = require('fs');
const path = require('path');
const { dun14ParaEan13 } = require('./pedidos-cd-util');

const ARQ = path.join(__dirname, '..', 'data', 'emb-padrao.json');
const ARQ_MANUAL = path.join(__dirname, '..', 'data', 'unidade-embalagem-overrides.json');
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const lerJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };

function carregar() { return lerJson(ARQ); }
function gravar(encontrados) {
  const atual = carregar(); const em = new Date().toISOString();
  for (const [cod, v] of Object.entries(encontrados || {})) if (v && v.emb >= 1) atual[cod] = { emb: v.emb, fonte: v.fonte, detalhe: v.detalhe || null, em };
  fs.mkdirSync(path.dirname(ARQ), { recursive: true });
  fs.writeFileSync(ARQ, JSON.stringify(atual));
  return atual;
}

// moda de [emb, n, prioridade]: maior contagem entre os prioritários (fornecedor da lista); senão geral; empate → maior emb
function moda(lista) {
  const conta = (filtro) => { const c = {}; for (const [e, n, pri] of lista) if (filtro(pri)) c[e] = (c[e] || 0) + n; let best = null, bn = 0; for (const [e, n] of Object.entries(c)) { const ee = +e; if (n > bn || (n === bn && ee > best)) { best = ee; bn = n; } } return best ? { emb: best, n: bn } : null; };
  return conta(p => p) || conta(() => true);
}

async function descobrir(q, cods, codFornecLista = 0) {
  const t0 = Date.now();
  const alvo = [...new Set((cods || []).map(String).filter(Boolean))];
  const out = {}; const fontes = { manual: 0, notas: 0, xml: 0, vendas: 0, dun14: 0, erp: 0 };
  const falta = () => alvo.filter(c => !out[c]);
  const marca = (cod, emb, fonte, detalhe) => { if (!out[cod] && emb >= 2) { out[cod] = { emb: Math.round(emb), fonte, detalhe }; fontes[fonte]++; } };
  const ph = c => c.map(() => '?').join(',');

  // 1. manual
  const manual = lerJson(ARQ_MANUAL);
  for (const c of alvo) { const e = num(manual[c]?.embalagem); if (e >= 2) marca(c, e, 'manual', 'correção manual da Lista de Compra'); }

  // 2. notas de entrada — qualquer época e fornecedor
  for (const banco of ['central', 'backup_central']) {
    const rest = falta(); if (!rest.length) break;
    const acc = {};
    for (const c of chunk(rest, 2000)) {
      const rows = await q(`SELECT cp.CodigoBarra cod, cp.QtdEmb emb, c.CodFornec cf, COUNT(*) n, MAX(cp.DataEntrada) ult
                            FROM ${banco}.compraprodutos cp LEFT JOIN ${banco}.compras c ON c.nCompra=cp.nCompra AND c.nLoja=cp.nLoja
                            WHERE cp.Movimentacao='COMPRA' AND cp.QtdEmb > 1 AND cp.CodigoBarra IN (${ph(c)})
                            GROUP BY cp.CodigoBarra, cp.QtdEmb, c.CodFornec`, c).catch(() => []);
      for (const r of rows) { const e = num(r.emb); if (e >= 2) (acc[String(r.cod)] = acc[String(r.cod)] || []).push([e, +r.n || 1, codFornecLista && +r.cf === +codFornecLista]); }
    }
    for (const [cod, l] of Object.entries(acc)) { const m = moda(l); if (m) marca(cod, m.emb, 'notas', `${m.n} nota(s) de entrada${banco === 'backup_central' ? ' (histórico antigo)' : ''}`); }
  }

  // 3. XML da NF-e: caixas (Qtd) × unidades (oqTrib)
  { const rest = falta(); const acc = {};
    for (const c of chunk(rest, 1500)) {
      const rows = await q(`SELECT CodigoBarras cod, ocEanTrib ean, Qtd, oqTrib FROM central.axmlprodutos
                            WHERE Qtd > 0 AND oqTrib > 0 AND (CodigoBarras IN (${ph(c)}) OR ocEanTrib IN (${ph(c)}))`, [...c, ...c]).catch(() => []);
      const set = new Set(c);
      for (const r of rows) {
        const ratio = num(r.oqTrib) / num(r.Qtd); if (!(ratio >= 2) || Math.abs(ratio - Math.round(ratio)) > 0.01) continue;
        for (const k of [String(r.cod || '').trim(), String(r.ean || '').trim()]) if (set.has(k)) { (acc[k] = acc[k] || []).push([Math.round(ratio), 1, false]); break; }
      }
    }
    for (const [cod, l] of Object.entries(acc)) { const m = moda(l); if (m) marca(cod, m.emb, 'xml', `${m.n} item(ns) de NF-e (caixa × unidade tributável)`); }
  }

  // 4. Embalagem Vendas do cadastro
  { const rest = falta();
    for (const c of chunk(rest, 2000)) {
      const rows = await q(`SELECT Codigobarra cod, Qtd_venda qv FROM central.embalagempadrao_venda WHERE Codigobarra IN (${ph(c)})`, c).catch(() => []);
      for (const r of rows) marca(String(r.cod), num(r.qv), 'vendas', 'Embalagem Vendas do cadastro');
    }
  }

  // 5. DUN-14: código de caixa no cadastro apontando pra este EAN
  { const rest = falta();
    if (rest.length) {
      const caixas = await q(`SELECT CodigoBarra cod, qtdemb FROM central.itens WHERE LENGTH(CodigoBarra)=14 AND CodDesativado=0`).catch(() => []);
      const set = new Set(rest); const porEan = {};
      for (const r of caixas) { const ean = dun14ParaEan13(String(r.cod)); if (ean && set.has(ean)) { const e = num(r.qtdemb); if (e >= 2) porEan[ean] = { emb: e, cod14: String(r.cod) }; } }
      const cod14s = Object.values(porEan).map(x => x.cod14);
      if (cod14s.length) for (const c of chunk(cod14s, 2000)) {
        const rows = await q(`SELECT Codigobarra cod, Qtd_venda qv FROM central.embalagempadrao_venda WHERE Codigobarra IN (${ph(c)})`, c).catch(() => []);
        for (const r of rows) { const ean = dun14ParaEan13(String(r.cod)); const e = num(r.qv); if (ean && porEan[ean] && e >= 2) porEan[ean].emb = e; }
      }
      for (const [ean, x] of Object.entries(porEan)) marca(ean, x.emb, 'dun14', `código de caixa ${x.cod14} no cadastro`);
    }
  }

  // 6. sugestão do ERP (embalagem da última compra) — colunas podem variar; falha silenciosa
  { const rest = falta();
    for (const c of chunk(rest, 2000)) {
      const rows = await q(`SELECT CodigoBarra cod, Emb FROM central.lista_consolidado_historico WHERE CodigoBarra IN (${ph(c)})`, c).catch(() => []);
      const acc = {};
      for (const r of rows) { const e = num(r.Emb); if (e >= 2) (acc[String(r.cod)] = acc[String(r.cod)] || []).push([e, 1, false]); }
      for (const [cod, l] of Object.entries(acc)) { const m = moda(l); if (m) marca(cod, m.emb, 'erp', 'última compra na Sugestão de Compras do ERP'); }
    }
  }

  return { encontrados: out, semPadrao: falta(), fontes, procurados: alvo.length, duracaoMs: Date.now() - t0 };
}

module.exports = { descobrir, gravar, carregar, moda, ARQ };
