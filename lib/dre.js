// DRE gerencial (Financeiro > DRE, 21/09/2026, pedido do Tiago): loja a loja e consolidada, no padrão de DRE de
// supermercado (receita bruta → impostos s/ venda → receita líquida → CMV → lucro bruto → perdas → despesas por
// natureza → EBITDA → depreciação → resultado financeiro → IR/CSLL → resultado líquido), com % da receita e
// comparação com faixas de referência do varejo alimentar. Aba "Sugestões" analisa os números e aponta desvios.
//
// Fontes (SOMENTE LEITURA no ERP):
//   receita/CMV/cupons/cancelamentos/descontos  → ln{loja}mes{MM}.zcupomitens (guarda 5 anos por mês)
//   despesas por competência e loja (Filial)     → loja20045.contasapagar × planodecontas (PlanoGrupo.PlanoSub)
//   perdas (avarias) e consumo interno           → central.avariaconsumo (Tipo 1 avaria / 2 consumo; Status 9 é lixo)
//   mix de pagamento (taxa de cartão estimada)   → dashboard.tipovendas (TipoPagto 01 débito/PIX TEF, 02 crédito, 03 voucher, 04 POS)
//   Filial 10 = Central/CD: despesas rateadas pelas lojas na proporção da receita (grupo 13 DESPESAS CD idem)
// Gravado: data/dre-params.json (taxas de cartão, depreciação, provisões) e data/dre-cache.json (meses fechados).
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const PARAMS_F = path.join(DATA, 'dre-params.json');
const CACHE_F = path.join(DATA, 'dre-cache.json');
const LOJAS = [1, 2, 3, 4, 5, 6];
const NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO', 10: 'CENTRAL/CD' };
const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
const pad = n => String(n).padStart(2, '0');
const pct = (a, b) => b > 0 ? r2(a / b * 100) : null;
let deps = null, params = null, cache = null, aquecendo = null;

// ── linhas da DRE (ordem de exibição) ─────────────────────────────────────────────────────────────────────
// tipo: 'r' receita · 'd' dedução/despesa (entra negativo) · 't' total calculado · 'i' informativo (fora do resultado)
const LINHAS = [
  { k: 'receita', t: 'Receita bruta de vendas', tipo: 'r', fonte: 'cupons', desc: 'Venda registrada nos cupons das 6 lojas (itens não cancelados).' },
  { k: 'impostos', t: '(−) Impostos sobre vendas', tipo: 'd', fonte: 'contas', desc: 'PIS, COFINS, ICMS, FECEP, antecipação, fronteira, DAE, DAS, DARF lançados no contas a pagar por competência.' },
  { k: 'receitaLiq', t: '= Receita líquida', tipo: 't', calc: ['receita', '-impostos'] },
  { k: 'cmv', t: '(−) CMV — custo das mercadorias vendidas', tipo: 'd', fonte: 'cupons', desc: 'Custo dos itens vendidos, item a item, no momento da venda (campo Custo do cupom).' },
  { k: 'lucroBruto', t: '= Lucro bruto', tipo: 't', calc: ['receitaLiq', '-cmv'], bench: [22, 27], benchDesc: 'margem bruta típica do varejo alimentar 22–27% da receita' },
  { k: 'perdas', t: '(−) Perdas e quebras (avarias)', tipo: 'd', fonte: 'avaria', bench: [0, 2], benchDesc: 'perdas conhecidas: até 2% (ABRAS ~1,8–2,0%)', desc: 'Avarias lançadas no ERP (Tipo 1), a custo. Lançamentos com status 9 (quantidade digitada errada) ficam fora.' },
  { k: 'pessoal', t: '(−) Pessoal', tipo: 'd', fonte: 'contas', bench: [0, 11], benchDesc: 'folha + encargos + benefícios: 8–11%', desc: 'Folha, adiantamentos, FGTS/INSS, férias, 13º, rescisões, vale-transporte, alimentação, fardamento, ASO.' },
  { k: 'ocupacao', t: '(−) Ocupação e utilidades', tipo: 'd', fonte: 'contas', bench: [0, 4.5], benchDesc: 'aluguel + energia + água + IPTU + seguro: 3–4,5%', desc: 'Aluguel, energia, água, IPTU, alvará, condomínio, seguro da loja, gás.' },
  { k: 'materiais', t: '(−) Materiais e embalagens', tipo: 'd', fonte: 'contas', bench: [0, 0.8], benchDesc: 'sacolas, bobinas, etiquetas, material de consumo: 0,4–0,8%', desc: 'Sacola/bobina/embalagem/etiqueta, material de escritório, água mineral, consumo interno.' },
  { k: 'consumo', t: '(−) Consumo interno de mercadoria', tipo: 'd', fonte: 'avaria', desc: 'Mercadoria da loja usada internamente (Tipo 2 da avaria), a custo.' },
  { k: 'manutencao', t: '(−) Manutenção', tipo: 'd', fonte: 'contas', bench: [0, 1], benchDesc: 'manutenção/reforma/refrigeração: 0,5–1%', desc: 'Manutenção e reforma, técnico de refrigeração, material de manutenção.' },
  { k: 'servicos', t: '(−) Serviços de terceiros e administrativas', tipo: 'd', fonte: 'contas', bench: [0, 1.5], benchDesc: 'contabilidade, sistema, segurança, TI, facilities: 1–1,5%', desc: 'Contabilidade, sistema, segurança patrimonial, TI, internet, telefone, prestadores, facility, veterinária, INMETRO.' },
  { k: 'marketing', t: '(−) Marketing', tipo: 'd', fonte: 'contas', bench: [0, 1], benchDesc: 'propaganda e ofertas: 0,5–1%', desc: 'Vinheta, tráfego pago, encarte, cartazes, panfletagem, influenciador.' },
  { k: 'logistica', t: '(−) Logística e veículos', tipo: 'd', fonte: 'contas', bench: [0, 1], benchDesc: 'frete, combustível, manutenção de veículos: 0,5–1%', desc: 'Combustível, manutenção, seguro e IPVA dos veículos, pedágio, rastreador, frete.' },
  { k: 'cartao', t: '(−) Taxas de cartão (estimadas)', tipo: 'd', fonte: 'cartao', bench: [0, 1.5], benchDesc: 'MDR médio ponderado: 1–1,5%', desc: 'Volume por forma de pagamento (débito, crédito, voucher, POS) × taxa informada em Parâmetros. O ERP não lança a taxa; ajuste as taxas com o contrato da adquirente.' },
  { k: 'checkout', t: '(−) Operações de checkout e diversos', tipo: 'd', fonte: 'contas', desc: 'Desistência, preço incorreto, troca, brinde, sorteio, cesta básica, doação, dinheiro trocado.' },
  { k: 'rateioCD', t: '(−) Rateio Central/CD', tipo: 'd', fonte: 'rateio', desc: 'Despesas lançadas na Filial 10 (central, CD, caminhões, equipe do CD, veículos) rateadas pelas lojas na proporção da receita.' },
  { k: 'ebitda', t: '= EBITDA (resultado operacional)', tipo: 't', calc: ['lucroBruto', '-perdas', '-pessoal', '-ocupacao', '-materiais', '-consumo', '-manutencao', '-servicos', '-marketing', '-logistica', '-cartao', '-checkout', '-rateioCD'], bench: [3, 7], benchDesc: 'EBITDA de supermercado: 3–7%' },
  { k: 'depreciacao', t: '(−) Depreciação (parâmetro)', tipo: 'd', fonte: 'param', desc: 'O ERP não controla ativo imobilizado. Valor mensal por loja informado em Parâmetros.' },
  { k: 'financeiro', t: '(−) Resultado financeiro', tipo: 'd', fonte: 'contas', desc: 'Juros, tarifas bancárias, multas (DAM, FGTS), acordos de renegociação, financiamento.' },
  { k: 'resultadoAntesIR', t: '= Resultado antes do IR', tipo: 't', calc: ['ebitda', '-depreciacao', '-financeiro'] },
  { k: 'irCsll', t: '(−) IRPJ e CSLL', tipo: 'd', fonte: 'contas' },
  { k: 'resultado', t: '= Resultado líquido', tipo: 't', calc: ['resultadoAntesIR', '-irCsll'], bench: [1.5, 4], benchDesc: 'lucro líquido de supermercado: 1,5–4%' },
  { k: 'investimentos', t: 'Investimentos (fora do resultado)', tipo: 'i', fonte: 'contas', desc: 'Aquisição de equipamentos, compra de veículo, equipamento de informática: entram no imobilizado, não na despesa do mês.' },
  { k: 'socios', t: 'Retiradas e despesas dos sócios (fora do resultado)', tipo: 'i', fonte: 'contas', desc: 'Retirada de sócio e o grupo "Despesas Rodrigo" (plano de saúde, cartão, condomínio, carro…).' },
  { k: 'movFin', t: 'Movimentações financeiras (não são despesa)', tipo: 'i', fonte: 'contas', desc: 'Empréstimo, depósito carro-forte, pagamento de boleto no caixa, cheque devolvido.' },
  { k: 'naoClass', t: 'Lançamentos sem classificação', tipo: 'i', fonte: 'contas', desc: 'Contas do plano que ainda não têm linha na DRE. Aparecem aqui pra você decidir onde entram.' }
];
const LINHA = Object.fromEntries(LINHAS.map(l => [l.k, l]));

// plano de contas → linha da DRE ('g.s' específico vence 'g' genérico)
const MAPA = {
  '1': 'servicos', '1.1': 'ocupacao', '1.2': 'ocupacao', '1.3': 'servicos', '1.4': 'ocupacao', '1.5': 'servicos', '1.6': 'servicos', '1.7': 'materiais', '1.8': 'investimentos',
  '1.9': 'materiais', '1.10': 'servicos', '1.11': 'ocupacao', '1.12': 'servicos', '1.13': 'servicos', '1.14': 'materiais', '1.15': 'servicos', '1.16': 'servicos', '1.17': 'ocupacao',
  '1.18': 'manutencao', '1.19': 'manutencao', '1.21': 'ocupacao', '1.22': 'investimentos', '1.23': 'materiais', '1.24': 'servicos', '1.25': 'ocupacao', '1.26': 'pessoal', '1.27': 'socios',
  '1.28': 'logistica', '1.29': 'financeiro', '1.30': 'materiais', '1.31': 'servicos', '1.32': 'checkout', '1.33': 'financeiro',
  '2': 'logistica', '2.5': 'investimentos', '2.10': 'financeiro',
  '3': 'marketing', '3.13': 'investimentos',
  '4': 'movFin', '4.2': 'financeiro', '4.3': 'servicos',
  '5': 'checkout', '5.7': 'manutencao', '5.10': 'movFin',
  '6': 'checkout', '6.2': 'movFin', '6.4': 'movFin', '6.5': 'movFin', '6.7': 'naoClass', '6.8': 'naoClass', '6.9': 'perdasContas',
  '8': 'impostos', '8.10': 'irCsll', '8.11': 'irCsll',
  '9': 'impostos',
  '10': 'ocupacao', '10.10': 'financeiro',
  '11': 'socios',
  '12': 'pessoal', '12.18': 'impostos', '12.24': 'financeiro',
  '13': 'rateioCD', '13.10': 'pessoal'
};
function linhaDe(g, s) { const k = MAPA[g + '.' + s] || MAPA[String(g)] || 'naoClass'; return k === 'perdasContas' ? 'checkout' : k; }

const PARAMS_PADRAO = {
  taxasCartao: { '01': 1.0, '02': 2.3, '03': 3.5, '04': 2.0 },   // % sobre o volume: 01 débito/PIX TEF · 02 crédito · 03 voucher · 04 POS
  depreciacao: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },            // R$/mês por loja
  provisao13Ferias: false,                                        // se true, soma 11,1% da folha mensal como provisão (13º + 1/3 férias) e tira os pagamentos de 13º/férias
  rateioCD: 'receita'                                             // 'receita' (proporcional à venda) ou 'igual'
};
function lerJson(f, p) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return p; } }
function gravarJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); }
function init(d) { deps = d; params = { ...PARAMS_PADRAO, ...lerJson(PARAMS_F, {}) }; params.taxasCartao = { ...PARAMS_PADRAO.taxasCartao, ...(params.taxasCartao || {}) }; params.depreciacao = { ...PARAMS_PADRAO.depreciacao, ...(params.depreciacao || {}) }; cache = lerJson(CACHE_F, { cupons: {} }); }
function getParams() { return params; }
function setParams(p) {
  if (p.taxasCartao) for (const [k, v] of Object.entries(p.taxasCartao)) if (isFinite(+v)) params.taxasCartao[k] = +v;
  if (p.depreciacao) for (const [k, v] of Object.entries(p.depreciacao)) if (isFinite(+v)) params.depreciacao[k] = +v;
  if (p.provisao13Ferias != null) params.provisao13Ferias = !!p.provisao13Ferias;
  if (p.rateioCD) params.rateioCD = p.rateioCD === 'igual' ? 'igual' : 'receita';
  gravarJson(PARAMS_F, params); return params;
}

// ── meses ──────────────────────────────────────────────────────────────────────────────────────────────────
function mesesDe(periodo) {   // 'AAAA-MM' | 'AAAA' (acumulado do ano) | '12m'
  const hoje = new Date(), out = [];
  if (/^\d{4}-\d{2}$/.test(periodo)) return [periodo];
  if (/^\d{4}$/.test(periodo)) { const ate = +periodo === hoje.getFullYear() ? hoje.getMonth() + 1 : 12; for (let m = 1; m <= ate; m++) out.push(periodo + '-' + pad(m)); return out; }
  for (let i = 11; i >= 0; i--) { const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1); out.push(d.getFullYear() + '-' + pad(d.getMonth() + 1)); }
  return out;
}
const fimMes = ym => { const [a, m] = ym.split('-').map(Number); return ym + '-' + pad(new Date(a, m, 0).getDate()); };
const mesFechado = ym => { const h = new Date(); return ym < h.getFullYear() + '-' + pad(h.getMonth() + 1); };

// cupons de uma loja num mês (cache permanente pra mês fechado; mês corrente refaz a cada 30 min)
async function cuponsMes(ln, ym) {
  const k = ln + '|' + ym, c = cache.cupons[k];
  if (c && (mesFechado(ym) ? true : Date.now() - (c.em || 0) < 30 * 60 * 1000)) return c;
  const [r] = await deps.q(`SELECT COALESCE(SUM(CASE WHEN IndCancel='N' THEN ValorTotalNovo END),0) v, COALESCE(SUM(CASE WHEN IndCancel='N' THEN Custo END),0) c,
                                   COUNT(DISTINCT CASE WHEN IndCancel='N' THEN CONCAT(nECF,'-',CCF) END) n, COALESCE(SUM(CASE WHEN IndCancel='N' THEN TotalDesconto END),0) d,
                                   COALESCE(SUM(CASE WHEN IndCancel='S' THEN ValorTotalNovo END),0) canc
                            FROM \`ln${ln}mes${ym.slice(5)}\`.zcupomitens WHERE Data BETWEEN ? AND ?`, [ym + '-01', fimMes(ym)]).catch(e => { console.error('[DRE] cupons', ln, ym, e.message); return [null]; });
  if (!r) return { v: 0, c: 0, n: 0, d: 0, canc: 0, erro: true };
  const o = { v: r2(num(r.v)), c: r2(num(r.c)), n: +r.n || 0, d: r2(num(r.d)), canc: r2(num(r.canc)), em: Date.now() };
  cache.cupons[k] = o; return o;
}
async function salvarCache() { try { gravarJson(CACHE_F, cache); } catch (e) {} }

// contas a pagar por loja × mês × conta, no período
async function contas(meses) {
  const anos = [...new Set(meses.map(m => +m.slice(0, 4)))];
  const rows = await deps.q(`SELECT c.Filial loja, c.CompetenciaAno ano, c.CompetenciaMes mes, c.PlanoGrupo g, c.PlanoSub s, COUNT(*) n, SUM(c.Valor) v, CAST(TRIM(MAX(p.Descricao)) AS CHAR) conta, CAST(TRIM(MAX(pg.Descricao)) AS CHAR) grupo
                             FROM loja20045.contasapagar c LEFT JOIN loja20045.planodecontas p ON p.PlanoGrupo = c.PlanoGrupo AND p.PlanoSub = c.PlanoSub LEFT JOIN loja20045.planodecontas pg ON pg.PlanoGrupo = c.PlanoGrupo AND pg.PlanoSub = 0
                             WHERE c.CompetenciaAno IN (${anos.map(() => '?').join(',')}) AND NOT (c.PlanoGrupo = 4 AND c.PlanoSub IN (0, 1, 5, 11)) GROUP BY c.Filial, c.CompetenciaAno, c.CompetenciaMes, c.PlanoGrupo, c.PlanoSub`, anos).catch(e => { console.error('[DRE] contas', e.message); return []; });
  const set = new Set(meses);
  return rows.map(r => ({ loja: +r.loja, ym: r.ano + '-' + pad(r.mes), g: +r.g, s: +r.s, n: +r.n, v: r2(num(r.v)), conta: r.conta || ('conta ' + r.g + '.' + r.s), grupo: r.grupo || ('grupo ' + r.g), linha: linhaDe(+r.g, +r.s) })).filter(r => set.has(r.ym));
}
async function avarias(meses) {
  const de = meses[0] + '-01', ate = fimMes(meses[meses.length - 1]);
  const rows = await deps.q(`SELECT nLoja loja, DATE_FORMAT(DataLan, '%Y-%m') ym, Tipo, COUNT(*) n, SUM(Total) v FROM central.avariaconsumo WHERE DataLan BETWEEN ? AND ? AND Status <> 9 GROUP BY nLoja, ym, Tipo`, [de, ate]).catch(e => { console.error('[DRE] avarias', e.message); return []; });
  return rows.map(r => ({ loja: +r.loja, ym: r.ym, tipo: +r.Tipo, n: +r.n, v: r2(num(r.v)) }));
}
async function mixPagamento(meses) {
  const anos = [...new Set(meses.map(m => +m.slice(0, 4)))];
  const rows = await deps.q(`SELECT nLoja loja, Ano, Mes, TipoPagto tp, SUM(Total) v FROM dashboard.tipovendas WHERE Ano IN (${anos.map(() => '?').join(',')}) GROUP BY nLoja, Ano, Mes, TipoPagto`, anos).catch(() => []);
  const set = new Set(meses);
  return rows.map(r => ({ loja: +r.loja, ym: r.Ano + '-' + pad(r.Mes), tp: String(r.tp), v: r2(num(r.v)) })).filter(r => set.has(r.ym));
}

// ── montagem da DRE de um período ──────────────────────────────────────────────────────────────────────────
async function montar(periodo) {
  const meses = mesesDe(periodo), t0 = Date.now();
  const cup = {}; for (const ln of LOJAS) for (const ym of meses) cup[ln + '|' + ym] = await cuponsMes(ln, ym);
  salvarCache();
  const [ct, av, mix] = await Promise.all([contas(meses), avarias(meses), mixPagamento(meses)]);
  const nMeses = meses.length;
  // valores por loja × linha (+ detalhe por conta)
  const V = {}, DET = {}; const add = (ln, k, v) => { (V[ln] = V[ln] || {}); V[ln][k] = r2((V[ln][k] || 0) + v); };
  const det = (ln, k, chave, conta, grupo, v, n) => { const L = (DET[ln] = DET[ln] || {}); const D = (L[k] = L[k] || {}); const o = D[chave] || (D[chave] = { chave, conta, grupo, v: 0, n: 0 }); o.v = r2(o.v + v); o.n += n || 0; };
  for (const ln of LOJAS) {
    let v = 0, c = 0, n = 0, d = 0, canc = 0, erro = false;
    for (const ym of meses) { const x = cup[ln + '|' + ym]; v += x.v; c += x.c; n += x.n; d += x.d; canc += x.canc; if (x.erro) erro = true; }
    V[ln] = { receita: r2(v), cmv: r2(c), cupons: n, descontos: r2(d), cancelamentos: r2(canc), erroCupons: erro };
  }
  const receitaTotal = LOJAS.reduce((s, ln) => s + V[ln].receita, 0);
  const share = ln => params.rateioCD === 'igual' ? 1 / LOJAS.length : (receitaTotal > 0 ? V[ln].receita / receitaTotal : 1 / LOJAS.length);
  // contas a pagar
  const folhaPorLoja = {};
  for (const r of ct) {
    let k = r.linha, valor = r.v;
    if (params.provisao13Ferias && k === 'pessoal' && (r.s === 5 || r.s === 6) && r.g === 12) continue;   // 13º/férias pagos saem; entra a provisão
    if (k === 'pessoal' && r.g === 12 && (r.s === 1 || r.s === 11 || r.s === 14)) folhaPorLoja[r.loja] = (folhaPorLoja[r.loja] || 0) + valor;
    if (r.loja === 10 || r.g === 13) {   // central/CD: rateia
      if (['investimentos', 'socios', 'movFin', 'naoClass'].includes(k)) { for (const ln of LOJAS) { add(ln, k, valor * share(ln)); det(ln, k, 'CD ' + r.g + '.' + r.s, 'Central: ' + r.conta, r.grupo, valor * share(ln), r.n); } continue; }
      const kk = ['impostos', 'irCsll', 'financeiro'].includes(k) ? k : 'rateioCD';   // imposto/juros da central seguem na linha própria, o resto vira rateio
      for (const ln of LOJAS) { add(ln, kk, valor * share(ln)); det(ln, kk, (kk === k ? 'CD ' : '') + r.g + '.' + r.s, (kk === k ? 'Central: ' : '') + r.conta, r.grupo, valor * share(ln), r.n); }
      continue;
    }
    if (!LOJAS.includes(r.loja)) continue;
    add(r.loja, k, valor); det(r.loja, k, r.g + '.' + r.s, r.conta, r.grupo, valor, r.n);
  }
  if (params.provisao13Ferias) for (const ln of LOJAS) { const p = r2((folhaPorLoja[ln] || 0) * 0.111); if (p) { add(ln, 'pessoal', p); det(ln, 'pessoal', 'prov', 'Provisão 13º + 1/3 férias (11,1% da folha)', 'PROVISÃO', p, 0); } }
  // avarias
  for (const r of av) { if (!LOJAS.includes(r.loja)) continue; const k = r.tipo === 1 ? 'perdas' : 'consumo'; add(r.loja, k, r.v); det(r.loja, k, 'av' + r.tipo, r.tipo === 1 ? 'Avarias (Tipo 1)' : 'Consumo interno (Tipo 2)', 'AVARIA', r.v, r.n); }
  // cartão
  const TP = { '01': 'Débito / PIX TEF', '02': 'Crédito', '03': 'Voucher / ticket', '04': 'POS (maquininha)' };
  for (const r of mix) { if (!LOJAS.includes(r.loja)) continue; const tx = params.taxasCartao[r.tp]; if (!tx) continue; const v = r2(r.v * tx / 100); add(r.loja, 'cartao', v); det(r.loja, 'cartao', 'tp' + r.tp, (TP[r.tp] || 'Tipo ' + r.tp) + ' · ' + tx + '% de ' + r2(r.v).toLocaleString('pt-BR'), 'CARTÃO', v, 0); }
  // depreciação
  for (const ln of LOJAS) { const d = r2((params.depreciacao[ln] || 0) * nMeses); if (d) { add(ln, 'depreciacao', d); det(ln, 'depreciacao', 'dep', 'Depreciação informada', 'PARÂMETRO', d, 0); } }
  // totais calculados
  const calcular = X => { for (const l of LINHAS) { if (l.tipo !== 't') { X[l.k] = r2(X[l.k] || 0); continue; } let s = 0; for (const c of l.calc) s += c.startsWith('-') ? -(X[c.slice(1)] || 0) : (X[c] || 0); X[l.k] = r2(s); } return X; };
  const lojas = {}; for (const ln of LOJAS) lojas[ln] = calcular(V[ln]);
  const rede = calcular(LINHAS.reduce((o, l) => { o[l.k] = r2(LOJAS.reduce((s, ln) => s + (lojas[ln][l.k] || 0), 0)); return o; }, { cupons: LOJAS.reduce((s, ln) => s + lojas[ln].cupons, 0), descontos: r2(LOJAS.reduce((s, ln) => s + lojas[ln].descontos, 0)), cancelamentos: r2(LOJAS.reduce((s, ln) => s + lojas[ln].cancelamentos, 0)) }));
  const pctDe = X => Object.fromEntries(LINHAS.map(l => [l.k, pct(X[l.k], X.receita)]));
  const detRede = {}; for (const ln of LOJAS) for (const [k, D] of Object.entries(DET[ln] || {})) { const R = (detRede[k] = detRede[k] || {}); for (const o of Object.values(D)) { const x = R[o.chave] || (R[o.chave] = { ...o, v: 0, n: 0 }); x.v = r2(x.v + o.v); x.n += o.n; } }
  const out = { periodo, meses, nMeses, fechado: meses.every(mesFechado), lojas: LOJAS.map(ln => ({ loja: ln, nome: NOMES[ln], valores: lojas[ln], pct: pctDe(lojas[ln]), detalhe: DET[ln] || {} })),
    rede: { valores: rede, pct: pctDe(rede), detalhe: detRede }, linhas: LINHAS, params, ms: Date.now() - t0 };
  out.sugestoes = sugestoes(out);
  return out;
}

// tendência mensal (12 meses) das linhas principais, rede e por loja
async function tendencia() {
  const meses = mesesDe('12m'), out = [];
  for (const ym of meses) { const d = await montar(ym); out.push({ ym, rede: { receita: d.rede.valores.receita, lucroBruto: d.rede.valores.lucroBruto, ebitda: d.rede.valores.ebitda, resultado: d.rede.valores.resultado, pct: d.rede.pct }, lojas: d.lojas.map(l => ({ loja: l.loja, receita: l.valores.receita, lucroBruto: l.valores.lucroBruto, ebitda: l.valores.ebitda, resultado: l.valores.resultado, pctLB: l.pct.lucroBruto, pctEbitda: l.pct.ebitda, pctRes: l.pct.resultado })) }); }
  return { meses, serie: out };
}

// ── sugestões: onde a empresa pode melhorar / o que não está sendo visto ──────────────────────────────────
const fmtK = v => { const a = Math.abs(v); return (v < 0 ? '−' : '') + (a >= 1e6 ? 'R$ ' + (a / 1e6).toFixed(2).replace('.', ',') + ' mi' : 'R$ ' + (a / 1e3).toFixed(1).replace('.', ',') + ' mil'); };
function sugestoes(d) {
  const S = [], R = d.rede, n = d.nMeses;
  const push = (grau, area, titulo, texto, impacto) => S.push({ grau, area, titulo, texto, impacto: impacto != null ? r2(impacto) : null });
  const lojasOrd = [...d.lojas].sort((a, b) => b.valores.receita - a.valores.receita);
  // 1. resultado
  if (R.valores.receita > 0) {
    if (R.valores.ebitda < 0) push('alto', 'Resultado', 'A rede fecha o período com EBITDA negativo', `Receita ${fmtK(R.valores.receita)}, lucro bruto ${R.pct.lucroBruto}% e despesas operacionais de ${r1((R.valores.lucroBruto - R.valores.ebitda) / R.valores.receita * 100)}% da receita. Ou a margem bruta está baixa, ou há despesa que não pertence à operação misturada no contas a pagar (veja as linhas "fora do resultado").`, R.valores.ebitda);
    for (const l of d.lojas) if (l.valores.receita > 0 && l.valores.ebitda < 0) push('alto', 'Resultado', `L${l.loja} ${l.nome} opera no vermelho (EBITDA ${l.pct.ebitda}%)`, `Lucro bruto ${l.pct.lucroBruto}% contra despesas de ${r1(((l.valores.lucroBruto - l.valores.ebitda) / l.valores.receita) * 100)}% da receita. Pessoal ${l.pct.pessoal}%, ocupação ${l.pct.ocupacao}%, rateio CD ${l.pct.rateioCD}%. Loja pequena com estrutura de loja grande: ou cresce a venda, ou enxuga a estrutura.`, l.valores.ebitda);
  }
  // 2. linhas contra benchmark, por loja, com impacto em R$
  for (const l of LINHAS) {
    if (!l.bench) continue;
    for (const L of d.lojas) {
      const p = L.pct[l.k]; if (p == null || L.valores.receita <= 0) continue;
      if (l.tipo === 'd' && p > l.bench[1]) push(p > l.bench[1] * 1.5 ? 'alto' : 'medio', 'Despesas', `L${L.loja} ${L.nome}: ${l.t.replace(/^\(−\) /, '')} em ${p}% da receita (referência até ${l.bench[1]}%)`, `${l.benchDesc}. Trazer pra referência economiza ${fmtK((p - l.bench[1]) / 100 * L.valores.receita)} no período.`, -(p - l.bench[1]) / 100 * L.valores.receita);
      if (l.tipo === 't' && p < l.bench[0]) push(p < l.bench[0] * 0.5 ? 'alto' : 'medio', l.k === 'lucroBruto' ? 'Margem' : 'Resultado', `L${L.loja} ${L.nome}: ${l.t.replace(/^= /, '')} em ${p}% (referência ${l.bench[0]}–${l.bench[1]}%)`, `${l.benchDesc}. Cada ponto de margem nessa loja vale ${fmtK(L.valores.receita / 100)} no período.`, (l.bench[0] - p) / 100 * L.valores.receita);
    }
  }
  // 3. margem bruta: loja abaixo da média da rede
  const mb = R.pct.lucroBruto; if (mb != null) for (const L of d.lojas) if (L.pct.lucroBruto != null && L.pct.lucroBruto < mb - 2) push('medio', 'Margem', `L${L.loja} ${L.nome} vende com ${(mb - L.pct.lucroBruto).toFixed(1)} pontos de margem bruta a menos que a rede`, `Mesmo mix e mesmos fornecedores deveriam dar margem parecida. Olhar no Radar Precificação os departamentos dessa loja abaixo da meta e os itens abaixo do custo.`, (mb - L.pct.lucroBruto) / 100 * L.valores.receita);
  // 4. perdas
  for (const L of d.lojas) { if (L.pct.perdas != null && L.pct.perdas > 2) push('alto', 'Perdas', `L${L.loja} ${L.nome}: perdas em ${L.pct.perdas}% da receita`, `Acima dos 2% do setor. Ver motivos no ERP (padaria, açougue, hortifrúti, furto) e a checagem 12 do Dedo Duro (ajustes de estoque).`, -(L.pct.perdas - 2) / 100 * L.valores.receita); if (L.valores.receita > 0 && (L.valores.perdas || 0) === 0) push('baixo', 'Perdas', `L${L.loja} ${L.nome}: nenhuma perda lançada no período`, `Loja sem avaria lançada não é loja sem perda: é perda não medida. Sem lançamento a DRE fica melhor do que a realidade.`, null); }
  // 5. pessoal
  const pes = d.lojas.filter(l => l.pct.pessoal != null && l.valores.receita > 0);
  if (pes.length) { const min = pes.reduce((a, b) => a.pct.pessoal < b.pct.pessoal ? a : b), max = pes.reduce((a, b) => a.pct.pessoal > b.pct.pessoal ? a : b); if (max.pct.pessoal - min.pct.pessoal > 4) push('medio', 'Pessoal', `Pessoal vai de ${min.pct.pessoal}% (L${min.loja}) a ${max.pct.pessoal}% (L${max.loja}) da receita`, `Diferença grande entre lojas com o mesmo formato indica quadro fora de escala na loja de maior %. Vale comparar venda por funcionário e escala de horários.`, null); }
  for (const L of d.lojas) if (L.valores.receita > 500000 * n && (L.valores.pessoal || 0) < 0.03 * L.valores.receita) push('alto', 'Dados', `L${L.loja} ${L.nome}: pessoal em só ${L.pct.pessoal}% da receita — folha lançada?`, `Loja desse porte não roda com essa folha. Provavelmente a folha está lançada em outra filial (Central) ou fora da competência. A DRE por loja depende de cada despesa cair na loja certa.`, null);
  // 6. rateio CD
  if (R.pct.rateioCD > 3) push('medio', 'Central/CD', `Central/CD custa ${R.pct.rateioCD}% da receita da rede`, `${fmtK(R.valores.rateioCD)} no período, rateado por receita. Um CD só se paga se a economia de compra (preço, bonificação, ruptura) for maior que isso. Vale medir o ganho de compra do CD contra o custo.`, null);
  // 7. cartão / mix
  if (R.valores.cartao > 0) push('baixo', 'Financeiro', `Taxa de cartão estimada em ${R.pct.cartao}% (${fmtK(R.valores.cartao)})`, `Estimativa por taxa média × volume por forma de pagamento. Lançar a taxa real da adquirente em Parâmetros (débito, crédito, voucher, POS) e negociar MDR com o volume da rede: cada 0,1 ponto vale ${fmtK(R.valores.receita * 0.001)} por período.`, null);
  // 8. impostos
  if (R.pct.impostos != null && R.pct.impostos < 1.5) push('medio', 'Tributos', `Impostos sobre venda em só ${R.pct.impostos}% da receita`, `Baixo pra varejo: mercearia tem muito produto com ST e monofásico, mas confira se PIS/COFINS/ICMS de todas as filiais estão lançados no contas a pagar com a competência certa. Imposto fora da competência distorce o mês.`, null);
  // 9. fora do resultado
  if (R.valores.socios > 0) push('baixo', 'Governança', `Retiradas e despesas dos sócios: ${fmtK(R.valores.socios)} no período`, `Ficaram fora do resultado (abaixo da linha), como manda a boa prática. Vale formalizar como pró-labore e distribuição de lucros, com valor fixo: assim a DRE mostra o resultado real da operação.`, null);
  if (R.valores.investimentos > 0) push('baixo', 'Governança', `Investimentos de ${fmtK(R.valores.investimentos)} tirados da despesa`, `Aquisição de equipamentos e veículos foi pro imobilizado. Sem depreciação lançada (Parâmetros), o resultado fica um pouco otimista: informe um valor mensal por loja.`, null);
  if (R.valores.naoClass > 0) push('medio', 'Dados', `${fmtK(R.valores.naoClass)} em contas sem linha na DRE`, `Contas do plano que não foram mapeadas (ex.: "FLAVIO", "LJ JORDÃO" em Diversos). Enquanto não forem classificadas, ficam fora do resultado. Renomear essas contas no ERP resolve.`, null);
  if (!params.provisao13Ferias) push('baixo', 'Método', '13º e férias entram só quando são pagos', 'Novembro/dezembro e meses de férias ficam pesados, os outros leves. Ligar a provisão em Parâmetros (11,1% da folha todo mês) deixa a comparação mês a mês justa.', null);
  if (!d.fechado) push('baixo', 'Método', 'Período inclui mês em aberto', 'Despesas por competência chegam com atraso (folha, energia, impostos). O mês corrente sempre parece melhor do que vai fechar. Compare meses fechados.', null);
  // 10. concentração
  if (lojasOrd.length && R.valores.receita > 0) { const top = lojasOrd[0]; if (top.valores.receita / R.valores.receita > 0.35) push('baixo', 'Estratégia', `L${top.loja} ${top.nome} é ${r1(top.valores.receita / R.valores.receita * 100)}% da receita da rede`, `Concentração alta: qualquer problema nessa loja (reforma, concorrente, quebra) mexe no resultado da empresa inteira. As lojas pequenas precisam de um plano pra ganhar escala ou de custo proporcional.`, null); }
  const ordem = { alto: 0, medio: 1, baixo: 2 };
  return S.sort((a, b) => ordem[a.grau] - ordem[b.grau] || Math.abs(b.impacto || 0) - Math.abs(a.impacto || 0));
}

function aquecer() {   // pré-carrega os 13 últimos meses de cupons em segundo plano (meses fechados ficam em cache)
  if (aquecendo) return aquecendo;
  aquecendo = (async () => { const ms = mesesDe('12m'); for (const ym of ms) for (const ln of LOJAS) await cuponsMes(ln, ym); await salvarCache(); console.log('[DRE] cache de cupons aquecido'); })().catch(e => console.error('[DRE]', e.message)).finally(() => { aquecendo = null; });
  return aquecendo;
}
function agendar() { setTimeout(aquecer, 60 * 1000); }

module.exports = { init, agendar, montar, tendencia, getParams, setParams, LINHAS, MAPA, NOMES, LOJAS, mesesDe };
