// lib/nfe-pendentes.js — NF-e do fornecedor ainda não importadas (central.axml, Importado=0): entrega × devolução e a
// contranota ESPELHO.
//
// 28/10/2026 (Nordeste Bebidas #108, E1 Socorro): a NF 53341 de 07/10 (3 cx vodka 970 + 3 cx vodka 300, R$ 563,70) voltou
// inteira pela contranota 53846 de 13/10 (CFOP 1411, mesmos itens, mesmas quantidades, mesmo valor). Três telas erravam:
//   · Fiscal › Pedidos a receber: "NF-e emitida · a caminho" 3 semanas, porque a regra de devolução SOMAVA todas as contranotas
//     do fornecedor pra loja na janela (duas eram de outra compra) e, como a soma passava do entregue, desistia;
//   · Radar e Cotação: o pedido de compra segue aberto no ERP e a NF-e "emitida" segurava a sugestão achando que ia chegar;
//   · Pedidos do CD: idem no trânsito de fornecedor.
// Tiago: "tem que ser visto se foi emitida OU devolvida pra depois ele não sugerir porque acha que vai chegar".
//
// Regra do espelho: contranota (toda em CFOP de entrada / devolução) emitida NA DATA OU DEPOIS da entrega, com o mesmo conjunto
// de códigos de item e, por código, a mesma quantidade — ou o mesmo valor total da nota (centavo). Cada contranota só espelha
// uma entrega. Sem espelho, as devoluções seguem a regra antiga (soma por item, só informa quando passa do entregue).
'use strict';

// Nota que NÃO é entrega (16/10/2026, Nordeste #108 Loja 1): CFOP de ENTRADA do emitente (1xxx/2xxx/3xxx = o fornecedor
// documentando mercadoria que voltou pra ele) ou devolução / retorno de demonstração (x201, x202, x410-x413, x912-x916).
// Nota é entrega se tem pelo menos um item de saída normal.
const CFOP_NAO_ENTREGA = new Set(['201', '202', '410', '411', '412', '413', '912', '913', '914', '915', '916']);
function naoEntrega(cfop) { const c = String(cfop || '').replace(/\D/g, '').slice(0, 4); if (c.length !== 4) return false; return /^[123]/.test(c) || CFOP_NAO_ENTREGA.has(c.slice(1)); }

const num = v => { let s = String(v ?? '0').trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };

/** Chave do item igual à da conferência (lib/conferencia-xml.js): GTIN válido → código do item no fornecedor (F…) → linha (I…). */
function codItem(p, nNota) {
  const codFornec = String(p.CodigoItemFornec || '').trim();
  const gtin = [p.CodigoBarras, p.ocEanTrib].map(v => String(v || '').trim()).find(v => /^\d{8,14}$/.test(v) && !/^0+$/.test(v)) || '';
  return gtin || (codFornec ? 'F' + codFornec : 'I' + nNota + '-' + p.nItem);
}

/** Duas notas são espelho: mesmos códigos e, por código, mesma quantidade — ou mesmo valor total (centavo). */
function espelho(e, d) {
  const ke = Object.keys(e.itens || {}), kd = Object.keys(d.itens || {});
  if (!ke.length || ke.length !== kd.length || !ke.every(c => d.itens[c] != null)) return false;
  const qtdIgual = ke.every(c => Math.abs(e.itens[c] - d.itens[c]) <= 0.001);
  const valIgual = e.valor > 0 && Math.abs(e.valor - d.valor) <= 0.01;
  return qtdIgual || valIgual;
}

/**
 * Casa cada ENTREGA com a contranota espelho (data ≥ data da entrega; cada contranota serve uma entrega só).
 * entregas/devolucoes: [{ data, valor, itens: {cod: qtd}, ... }]. Marca entrega.devolvida = { nNota, data, chave } e
 * devolucao.espelho_de = { nNota, chave }. Devolve as devoluções usadas (na ordem das entregas).
 */
function casarEspelhos(entregas, devolucoes) {
  const livres = [...devolucoes].sort((a, b) => String(a.data).localeCompare(String(b.data)));
  const usadas = [];
  for (const e of [...entregas].sort((a, b) => String(a.data).localeCompare(String(b.data)))) {
    const i = livres.findIndex(d => String(d.data) >= String(e.data) && espelho(e, d));
    if (i < 0) continue;
    const d = livres.splice(i, 1)[0];
    e.devolvida = { nNota: d.nNota, data: d.data, chave: d.chave };
    d.espelho_de = { nNota: e.nNota, chave: e.chave };
    usadas.push(d);
  }
  return usadas;
}

/**
 * Notas pendentes (Importado=0, modelo 55) dos últimos dias, por raiz do CNPJ do fornecedor + loja destino, já com itens,
 * tipo ('entrega' | 'devolucao') e o espelho casado. Radar e Pedidos do CD usam o mesmo resultado.
 *   q         consulta no ERP (central)
 *   corteX    nReg de corte (lib/axml-corte.js)
 *   desde     'YYYY-MM-DD'
 *   cnpjLoja  { '21425302000181': 1, ... }
 * → { porRaizLoja: { 'raiz|loja': [nota] }, itensOk }  nota = { nNota, data, chave, cnpjEmit, valor, tipo, itens:{cod:qtdCom},
 *   un:{codigo:unidades} (todos os códigos: GTIN, EAN tributável e EAN-13 do DUN-14), codigos:Set, devolvida? }
 * Se a consulta dos itens falhar, itensOk=false: toda nota vira 'entrega' sem produto (comportamento antigo do Radar).
 */
async function nfePendentes(q, corteX, desde, cnpjLoja) {
  const xr = await q(`SELECT nNota, DATE_FORMAT(Data,'%Y-%m-%d') data, CNPJdest, CNPJemit, Chave, ValorNFE FROM central.axml WHERE nReg>=? AND nMod='55' AND Importado=0 AND Data>=?`, [corteX, desde]);
  const notas = [], porChave = {};
  for (const x of xr) {
    const l = cnpjLoja[String(x.CNPJdest || '').replace(/\D/g, '')]; if (!l) continue;
    const n = { nNota: String(x.nNota), data: x.data, chave: x.Chave, cnpjEmit: String(x.CNPJemit || ''), loja: l, raiz: String(x.CNPJemit || '').replace(/\D/g, '').slice(0, 8),
                valor: num(x.ValorNFE), tipo: 'entrega', itens: {}, un: {}, codigos: new Set(), _cfops: [] };
    notas.push(n); porChave[n.nNota + '|' + n.cnpjEmit] = n;
  }
  let itensOk = false;
  try {
    const { dun14ParaEan13 } = require('./pedidos-cd-util');
    const pr = await q(`SELECT x.nNota, x.CNPJemit, p.nItem, p.CodigoBarras, p.ocEanTrib, p.CodigoItemFornec, p.Qtd, p.oqTrib, p.CFOP FROM central.axml x JOIN central.axmlprodutos p ON p.nNota=x.nNota AND p.CNPJemit=x.CNPJemit WHERE x.nReg>=? AND x.nMod='55' AND x.Importado=0 AND x.Data>=?`, [corteX, desde]);
    for (const r of pr) {
      const n = porChave[String(r.nNota) + '|' + String(r.CNPJemit || '')]; if (!n) continue;
      const cod = codItem(r, n.nNota), qtd = num(r.Qtd), un = num(r.oqTrib) || qtd;
      n.itens[cod] = (n.itens[cod] || 0) + qtd;
      n._cfops.push(String(r.CFOP || '').replace(/\D/g, '').slice(0, 4));
      for (const v of [r.CodigoBarras, r.ocEanTrib]) {
        const c = String(v || '').trim(); if (!c) continue;
        n.un[c] = (n.un[c] || 0) + un; n.codigos.add(c);
        if (c.length === 14) { const u = dun14ParaEan13(c); if (u) { n.un[u] = (n.un[u] || 0) + un; n.codigos.add(u); } }
      }
    }
    itensOk = true;
    for (const n of notas) { if (n._cfops.length && n._cfops.every(naoEntrega)) n.tipo = 'devolucao'; delete n._cfops; }
  } catch (e) { console.error('[NFE-PENDENTES] itens das notas pendentes:', e.message); for (const n of notas) delete n._cfops; }
  const porRaizLoja = {};
  for (const n of notas) (porRaizLoja[n.raiz + '|' + n.loja] = porRaizLoja[n.raiz + '|' + n.loja] || []).push(n);
  if (itensOk) for (const L of Object.values(porRaizLoja)) casarEspelhos(L.filter(n => n.tipo === 'entrega'), L.filter(n => n.tipo === 'devolucao'));
  return { porRaizLoja, itensOk };
}

/** Resumo da NF-e pra tela (lista "nfe" do trânsito): número, data, chave e, se voltou, a contranota. */
const resumoNfe = n => ({ nNota: n.nNota, data: n.data, chave: n.chave, ...(n.devolvida ? { devolvida: n.devolvida } : {}) });

module.exports = { naoEntrega, CFOP_NAO_ENTREGA, codItem, espelho, casarEspelhos, nfePendentes, resumoNfe };
