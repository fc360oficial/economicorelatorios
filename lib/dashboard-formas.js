// Dashboard › Faturamento › clique no NOME da loja: de que é feita a venda de hoje (Tiago, 29/09/26: "quando eu clicar no nome da
// loja traz pra mim um organograma o que representa esse valor da venda do dia: quanto é dinheiro, quanto é cartão crédito, débito etc").
//
// Fonte: vendas.relatoriofecl{loja} — o fechamento dos caixas do ERP, uma linha por PAGAMENTO de cada cupom (um cupom pago metade em
// dinheiro e metade no cartão vira duas linhas), com Data indexada. Colunas que importam:
//   Tipo1/Tipo2      = código da finalizadora (central.tipo_finalizadora): 99/98 dinheiro · 01 cartão TEF débito (PIX também entra
//                      aqui) · 02 crédito (Tipo2 = nº de parcelas) · 03 voucher · 04 POS (maquininha fora do TEF) · 91 troca de cupom ·
//                      90 convênio · 88 cheque/entrega · 00 troco solidário · 77 sangria
//   Cartao           = rótulo escolhido no caixa (DINHEIRO, PIX, POS-PIX, SAFRAPAY MAESTRO, TICKET ALIMENTAC…)
//   TEF_TipoProduto  = o que o TEF respondeu (Débito, Crédito, CreditoPrivateLabel, CarteiraDigital = PIX, Voucher Alimentacao/Refeicao/
//                      Beneficio…); '0' quando o TEF não respondeu — aí vale o código da finalizadora + rótulo
//   TEF_Bandeira     = Master, Visa, Elo, Pix, Alelo, Ticket, Sodexo, VR… ('0' quando não veio; derivo do rótulo)
//   Valor            = texto "1.234,56" (ponto de milhar!), líquido de troco · IndCancel '0' = válido · NaoVenda 1 = não é venda
//
// Validado em 29/09/26 no dia 28/09 (dia fechado), loja a loja: com IndCancel='0' AND NaoVenda=0 a soma bate AO CENTAVO com
// zcupomitens (a coluna "Venda hoje" do bloco) nas 6 lojas, cupom a cupom. NaoVenda=1 (Tipo1 77, CCF 0, StatusSangria 1, nome do
// envelope) são as SANGRIAS — ficam fora da árvore, só no rodapé. Durante o dia os itens (zcupomitens) chegam na central com atraso
// (E4 29/09 12:50: 121 cupons nos itens × 286 nos pagamentos), então a tela mostra o total dos pagamentos e avisa quando difere da
// coluna. O CD (loja 10) vende por NF-e, não tem cupom. Só leitura no ERP.
'use strict';

const LOJAS = [1, 2, 3, 4, 5, 6];
const GRUPOS = [
  ['dinheiro', 'Dinheiro'], ['pix', 'PIX'], ['debito', 'Cartão de débito'], ['credito', 'Cartão de crédito'],
  ['voucher', 'Voucher / vale-alimentação'], ['pos', 'Maquininha (POS)'], ['outros', 'Outros'],
];
const NOME_G = Object.fromEntries(GRUPOS);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const r2 = v => Math.round((+v || 0) * 100) / 100;
const num = v => { if (v == null || v === '') return 0; if (typeof v === 'number') return v; const s = String(v).trim(); return parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) || 0; };
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

// bandeira do cartão/voucher: o que o TEF respondeu; sem resposta, deduzo do rótulo do caixa
const BANDEIRAS = [
  [/MAESTRO|MASTER/i, 'Mastercard'], [/VISA/i, 'Visa'], [/\bELO\b/i, 'Elo'], [/AMEX|AMERICAN/i, 'Amex'], [/DINERS/i, 'Diners'], [/HIPER/i, 'Hipercard'],
  [/TRICARD/i, 'Tricard'], [/TICKET/i, 'Ticket'], [/ALELO/i, 'Alelo'], [/SODEXO|PLUXEE/i, 'Sodexo'], [/\bVR\b/i, 'VR'], [/VALE ?CARD/i, 'Valecard'],
  [/NUTRICASH/i, 'Nutricash'], [/POLICARD/i, 'Policard'], [/GREEN ?CARD/i, 'Greencard'], [/BEN ?VISA/i, 'Ben Visa Vale'], [/CABAL/i, 'Cabal'],
];
const VOUCHER_RX = /TICKET|ALELO|SODEXO|PLUXEE|\bVR\b|VALE ?CARD|NUTRICASH|POLICARD|GREEN ?CARD|BEN ?VISA|ALIMENT|REFEI|BENEF|FLEX/i;
function bandeira(bd, cart) {
  const b = String(bd || '').trim();
  if (b && b !== '0' && !/n[aã]o cadastrado/i.test(b)) { const m = BANDEIRAS.find(([rx]) => rx.test(b)); return m ? m[1] : cap(b); }
  const m = BANDEIRAS.find(([rx]) => rx.test(cart));
  return m ? m[1] : 'Sem bandeira';
}

// classifica uma linha agrupada do fechamento: { g: grupo, f: folha (bandeira/subtipo), parc: nº de parcelas (crédito) }
function classificar(r) {
  const t1 = String(r.t1 || '').trim(), t2 = String(r.t2 || '').trim(), tp = String(r.tp || '').trim(), cart = String(r.cartao || '').trim().toUpperCase(), bd = r.bd;
  if (t1 === '99' || t1 === '98') return { g: 'dinheiro' };
  if (t1 === '91') return { g: 'outros', f: 'Troca de cupom (vale-troca)' };
  if (t1 === '90') return { g: 'outros', f: 'Convênio' };
  if (t1 === '88') return { g: 'outros', f: t2 === '88' ? 'Entrega' : 'Cheque' };
  if (t1 === '00') return { g: 'outros', f: 'Troco solidário' };
  if (t1 === '01' || t1 === '02' || t1 === '03' || t1 === '04') {
    const parc = Math.max(parseInt(t2, 10) || 0, parseInt(r.parc, 10) || 0);
    if (tp === 'CarteiraDigital' || cart === 'PIX' || cart === 'POS-PIX') return { g: 'pix', f: t1 === '04' || cart === 'POS-PIX' ? 'PIX na maquininha (POS)' : 'PIX pelo TEF' };
    if (/^Voucher/i.test(tp)) return { g: 'voucher', f: bandeira(bd, cart) };
    if (/^D[ée]bito/i.test(tp)) return { g: 'debito', f: bandeira(bd, cart) };
    if (/^Cr[ée]dito/i.test(tp)) return { g: 'credito', f: bandeira(bd, cart), parc };
    // TEF não respondeu: vale o código da finalizadora e o rótulo do caixa
    if (t1 === '01') return VOUCHER_RX.test(cart) ? { g: 'voucher', f: bandeira(bd, cart) } : { g: 'debito', f: bandeira(bd, cart) };
    if (t1 === '02') return VOUCHER_RX.test(cart) ? { g: 'voucher', f: bandeira(bd, cart) } : { g: 'credito', f: bandeira(bd, cart), parc };
    if (t1 === '03') return { g: 'voucher', f: bandeira(bd, cart) };
    return { g: 'pos', f: cart && cart !== 'POS' ? cap(cart) : 'Sem bandeira / tipo' };
  }
  return { g: 'outros', f: cart ? cap(cart) : 'Tipo ' + (t1 || '?') };
}

// linhas agrupadas de UMA loja num dia (2 consultas rápidas: Data tem índice, ~1,5 mil linhas por dia por loja)
async function linhasLoja(q, ln, data) {
  const VAL = "CAST(REPLACE(REPLACE(Valor,'.',''),',','.') AS DECIMAL(14,2))";
  const rows = await q(`SELECT Tipo1 t1, Tipo2 t2, TRIM(Cartao) cartao, TEF_TipoProduto tp, TEF_Bandeira bd, TEF_Parc parc, COUNT(*) n, SUM(${VAL}) v
                        FROM vendas.relatoriofecl${ln} WHERE Data=? AND IndCancel='0' AND NaoVenda=0
                        GROUP BY Tipo1, Tipo2, TRIM(Cartao), TEF_TipoProduto, TEF_Bandeira, TEF_Parc`, [data]);
  const [t] = await q(`SELECT COUNT(DISTINCT CASE WHEN IndCancel='0' AND NaoVenda=0 THEN CONCAT(nECF,'-',CCF) END) cupons,
                              MAX(CASE WHEN IndCancel='0' AND NaoVenda=0 THEN Hora END) ult,
                              SUM(NaoVenda=1) nSang, SUM(CASE WHEN NaoVenda=1 THEN ${VAL} ELSE 0 END) vSang,
                              SUM(IndCancel<>'0' AND NaoVenda=0) nCanc, SUM(CASE WHEN IndCancel<>'0' AND NaoVenda=0 THEN ${VAL} ELSE 0 END) vCanc
                       FROM vendas.relatoriofecl${ln} WHERE Data=?`, [data]);
  return { rows, cupons: +(t || {}).cupons || 0, ult: String((t || {}).ult || '').slice(0, 8), sang: { n: +(t || {}).nSang || 0, v: r2(num((t || {}).vSang)) }, canc: { n: +(t || {}).nCanc || 0, v: r2(num((t || {}).vCanc)) } };
}

// árvore: venda do dia → grupos (dinheiro, PIX, débito, crédito, voucher, POS, outros) → folhas (bandeira / subtipo)
function montar(rowsPorLoja, { loja, data, nomes, lojas }) {
  const G = {}; let total = 0, pagamentos = 0;
  for (const r of rowsPorLoja.flatMap(l => l.rows)) {
    const c = classificar(r), v = num(r.v), n = +r.n || 0;
    const g = G[c.g] = G[c.g] || { id: c.g, nome: NOME_G[c.g], v: 0, n: 0, folhas: {}, avista: { v: 0, n: 0 }, parcelado: { v: 0, n: 0 } };
    g.v += v; g.n += n; total += v; pagamentos += n;
    if (c.f) { const f = g.folhas[c.f] = g.folhas[c.f] || { nome: c.f, v: 0, n: 0 }; f.v += v; f.n += n; }
    if (c.g === 'credito') { const k = c.parc > 1 ? 'parcelado' : 'avista'; g[k].v += v; g[k].n += n; }
  }
  const grupos = GRUPOS.filter(([id]) => G[id]).map(([id]) => {
    const g = G[id], filhos = Object.values(g.folhas).sort((a, b) => b.v - a.v || a.nome.localeCompare(b.nome, 'pt-BR')).map(f => ({ nome: f.nome, v: r2(f.v), n: f.n, pct: g.v > 0 ? r2(f.v / g.v * 100) : 0 }));
    // muitas bandeiras miúdas: 6 maiores + "Outras"
    const MAX = 6; const vis = filhos.length > MAX + 1 ? filhos.slice(0, MAX).concat([filhos.slice(MAX).reduce((s, f) => ({ nome: 'Outras (' + (filhos.length - MAX) + ')', v: r2(s.v + f.v), n: s.n + f.n, pct: r2(s.pct + f.pct) }), { v: 0, n: 0, pct: 0 })]) : filhos;
    const out = { id, nome: g.nome, v: r2(g.v), n: g.n, pct: total > 0 ? r2(g.v / total * 100) : 0, filhos: vis.length > 1 || (vis.length === 1 && (id === 'outros' || id === 'pos')) ? vis : [] };   // folha única só quando ela diz O QUE é (Outros/POS)
    if (id === 'credito') { out.avista = { v: r2(g.avista.v), n: g.avista.n }; out.parcelado = { v: r2(g.parcelado.v), n: g.parcelado.n }; }
    return out;
  });
  const soma = k => rowsPorLoja.reduce((s, l) => s + l[k].n, 0), somaV = k => r2(rowsPorLoja.reduce((s, l) => s + l[k].v, 0));
  return {
    loja, nome: loja ? (nomes || {})[loja] || 'Loja ' + loja : 'Rede', data, lojas,
    total: r2(total), pagamentos, cupons: rowsPorLoja.reduce((s, l) => s + l.cupons, 0), ult: rowsPorLoja.reduce((m, l) => l.ult > m ? l.ult : m, ''),
    grupos, sangrias: { n: soma('sang'), v: somaV('sang') }, cancelados: { n: soma('canc'), v: somaV('canc') },
  };
}

// loja 0 = rede (as 6 lojas somadas); data = hoje se não vier (YYYY-MM-DD)
async function formasPagto(q, { loja = 0, data = '', nomes = null } = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : iso(new Date());
  const lojas = loja ? [loja] : LOJAS;
  if (loja && !LOJAS.includes(loja)) throw new Error('Loja ' + loja + ' não vende pelo caixa');
  const por = [];
  for (const ln of lojas) por.push(await linhasLoja(q, ln, d));
  return montar(por, { loja, data: d, nomes, lojas });
}

module.exports = { formasPagto, classificar, bandeira, montar, LOJAS };
