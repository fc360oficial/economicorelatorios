// Consulta de Produtos (Análise › Consulta de Produtos, 26/10/2026, pedido do Tiago): a mesma consulta do ERP
// ("Consulta de Itens" › grade por loja), só leitura. Busca por código de barras ou nome e, pro produto escolhido,
// uma linha por loja (E1..E6 e CD) com os campos que o ERP mostra:
//   Loja · Razão social · CNPJ · Preço Varejo · Preço Atacado · Qtd Mult · Preço Promoção · Preço Compra (custo)
//   Margem S/Custo · Estoque Atual · Última Compra · Última Venda · Curva ABC
// e dois extras que o ERP não tem: margem cadastrada e venda dos últimos 30 dias (qtd, R$, média/dia).
//
// Fontes no ERP (.252):
//   central.itens            P{loja} = preço varejo, a{loja} = preço atacado, q{loja} = qtd mult do atacado,
//                            L{loja} = ativo na loja, Unid, qtdemb, CodGrupo/CodGrupoSub, CodDesativado
//   central.sefcontribuinte  razão social (Nome_Contribuinte), CNPJ_MF e bairro, por nLoja
//   central.estoquen{loja}   Qtd = estoque atual (1 linha por produto)
//   central.custoloja{loja}  Custo e UltimaCompra (1 linha por produto; sem índice no CD → sempre por IN/=)
//   central.ultimavenda      DataVenda por (nLoja, CodigoBarra)
//   central.itens_margens    MargemVarejo cadastrada por loja (markup sobre o custo, igual ao ERP)
//   central.promocao_produtos preço promocional vigente (data_inicio ≤ hoje ≤ data_fim, não finalizada, nloja = loja ou 0)
//   ln{loja}mes{MM}.zcupomitens venda dos últimos 30 dias → curva ABC por loja (A = produtos que somam os primeiros
//                            50% da venda em R$, B até 80%, C o resto, "—" quem não vendeu). As tabelas de curva do ERP
//                            (itenscurvaabc, c_abc, curvaabc) estão vazias e itens.ABC não é atualizado, então a curva
//                            é calculada aqui e guardada em memória por loja até o dia virar.
// "Margem S/Custo" segue a conta do ERP: (preço ÷ custo − 1) × 100 (markup), não margem sobre a venda.
'use strict';

const LOJAS = [1, 2, 3, 4, 5, 6, 10];
const LOJAS_VENDA = [1, 2, 3, 4, 5, 6];            // o CD (10) não vende no caixa: curva só nas lojas
const ROTULO = { 1: 'E1', 2: 'E2', 3: 'E3', 4: 'E4', 5: 'E5', 6: 'E6', 10: 'CD' };
const BAIRRO = { 1: 'Socorro', 2: 'Muribeca', 3: 'Ponte', 4: 'Atacarejo', 5: 'Porta Larga', 6: 'Jardim Jordão', 10: 'Distribuidora' };
const DIAS_CURVA = 30;
const CORTE_A = 0.5, CORTE_B = 0.8;
const TIMEOUT_CURVA = 20000;        // ms por banco mensal no cálculo da curva (ver rankingLoja)

let q = null;
function init(deps) { q = deps.q; }

const num = v => { if (v == null || v === '') return 0; if (typeof v === 'number') return v; const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
// valores do ERP vêm como texto "10,99" (varchar) ou decimal "9.30" — num() trata os dois
const numDec = v => { if (v == null || v === '') return 0; if (typeof v === 'number') return v; const s = String(v).trim(); const n = s.includes(',') ? parseFloat(s.replace(/\./g, '').replace(',', '.')) : parseFloat(s); return isNaN(n) ? 0 : n; };
const r2 = v => Math.round(v * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoDate = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : iso(v); const s = String(v).trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3]; m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return m[3] + '-' + m[2] + '-' + m[1]; return null; };
// 2020-01-01 é o "vazio" do ERP em custoloja.UltimaCompra
const dataUtil = d => (d && d > '2020-01-01') ? d : null;
const cnpjFmt = c => { const s = String(c || '').replace(/\D/g, ''); return s.length === 14 ? s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : s; };
const lim = (v, max) => String(v || '').trim().slice(0, max);

// ── Lojas (razão social / CNPJ): muda quase nunca, cache de 1 h ─────────────────────────────────────────────
let lojasCache = null, lojasAt = 0;
async function lojas() {
  if (lojasCache && Date.now() - lojasAt < 3600e3) return lojasCache;
  const out = {};
  const rows = await q('SELECT nLoja, CNPJ_MF, Nome_Contribuinte, Fantasia, Bairro FROM central.sefcontribuinte').catch(() => []);
  for (const r of rows) {
    const ln = Number(r.nLoja); if (!LOJAS.includes(ln)) continue;
    out[ln] = { loja: ln, rotulo: ROTULO[ln], bairro: BAIRRO[ln], razao: String(r.Nome_Contribuinte || r.Fantasia || '').trim(), cnpj: cnpjFmt(r.CNPJ_MF) };
  }
  for (const ln of LOJAS) if (!out[ln]) out[ln] = { loja: ln, rotulo: ROTULO[ln], bairro: BAIRRO[ln], razao: '', cnpj: '' };
  lojasCache = out; lojasAt = Date.now();
  return out;
}

// ── Busca ──────────────────────────────────────────────────────────────────────────────────────────────────
// Código de barras (só dígitos): igual ou "começa com"/"contém". Nome: todas as palavras precisam aparecer
// (LIKE %palavra% com AND), igual à busca do ERP. Até `limite` resultados, ativos primeiro.
async function buscar(termo, limite = 80) {
  const t = String(termo || '').trim();
  if (t.length < 2) return [];
  const soDigitos = /^\d+$/.test(t);
  let where, params;
  if (soDigitos) {
    where = '(i.CodigoBarra = ? OR i.CodigoBarra LIKE ? OR i.nInterno = ?)';
    params = [t, '%' + t + '%', Number(t) || 0];
  } else {
    const palavras = t.toUpperCase().split(/\s+/).filter(Boolean).slice(0, 6);
    where = palavras.map(() => 'i.Descricao LIKE ?').join(' AND ');
    params = palavras.map(p => '%' + p + '%');
  }
  const rows = await q(`
    SELECT i.nInterno, i.CodigoBarra, TRIM(i.Descricao) descricao, i.Unid, i.qtdemb, i.CodDesativado, i.P1, i.P2, i.P3, i.P4, i.P5, i.P6, i.P10,
           TRIM(g.Descricao) grupo, TRIM(gs.Descricao) subgrupo
    FROM central.itens i
    LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
    LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
    WHERE ${where}
    ORDER BY i.CodDesativado, i.Descricao
    LIMIT ${Math.min(Math.max(parseInt(limite) || 80, 1), 200)}`, params);
  return rows.map(r => ({
    codigo: String(r.CodigoBarra || '').trim(), interno: r.nInterno, descricao: r.descricao || '', unid: String(r.Unid || '').trim(),
    emb: numDec(r.qtdemb), desativado: Number(r.CodDesativado) === 1, grupo: r.grupo || '', subgrupo: r.subgrupo || '',
    precos: { 1: num(r.P1), 2: num(r.P2), 3: num(r.P3), 4: num(r.P4), 5: num(r.P5), 6: num(r.P6), 10: num(r.P10) },
  }));
}

// ── Detalhe por loja ───────────────────────────────────────────────────────────────────────────────────────
async function detalhe(codigo) {
  const cod = String(codigo || '').trim();
  if (!cod) return null;
  const sel = LOJAS.map(ln => `i.P${ln}, i.a${ln}, i.q${ln}, i.L${ln}`).join(', ');
  const it = (await q(`
    SELECT i.nInterno, i.CodigoBarra, TRIM(i.Descricao) descricao, i.Unid, i.UnidadeCompra, i.qtdemb, i.CodDesativado, i.CODIGONCM, i.Marca,
           i.TipoBalanca, i.Validade, i.custo custoCentral, i.DataHoraAlteracao, ${sel},
           TRIM(g.Descricao) grupo, TRIM(gs.Descricao) subgrupo, gs.CodGrupo codGrupo, i.CodGrupoSub codSub,
           TRIM(f.Nome) fornecedor
    FROM central.itens i
    LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
    LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
    LEFT JOIN central.fornecedor f ON f.CodFornec = i.CodFornecLista AND i.CodFornecLista > 0
    WHERE i.CodigoBarra = ? LIMIT 1`, [cod]))[0];
  if (!it) return null;

  const hoje = iso(new Date());
  const [cadLojas, estoques, custos, vendas, margens, promos, filhos] = await Promise.all([
    lojas(),
    Promise.all(LOJAS.map(ln => q(`SELECT Qtd, Data FROM central.estoquen${ln} WHERE CodigoBarra = ? ORDER BY nReg DESC LIMIT 1`, [cod]).then(r => r[0] || null).catch(() => null))),
    Promise.all(LOJAS.map(ln => q(`SELECT Custo, CustoMedio, UltimaCompra, Data FROM central.custoloja${ln} WHERE CodigoBarra = ? ORDER BY nReg DESC LIMIT 1`, [cod]).then(r => r[0] || null).catch(() => null))),
    q('SELECT nLoja, DataVenda FROM central.ultimavenda WHERE CodigoBarra = ?', [cod]).catch(() => []),
    q('SELECT nLoja, MargemVarejo, MargemAtacado FROM central.itens_margens WHERE CodigoBarra = ?', [cod]).catch(() => []),
    q(`SELECT nloja, preco_promo, data_inicio, data_fim, nome_promo FROM central.promocao_produtos
       WHERE codigobarra = ? AND finalizada = 0 AND data_inicio <= ? AND data_fim >= ? ORDER BY nreg DESC`, [cod, hoje, hoje]).catch(() => []),
    q('SELECT CodigoBarra, TRIM(Descricao) descricao, qtdemb, Unid FROM central.itens WHERE Pai = ? AND nInterno <> ? LIMIT 20', [it.nInterno, it.nInterno]).catch(() => []),
  ]);

  const ultVenda = {}; for (const v of vendas) { const d = isoDate(v.DataVenda); const ln = Number(v.nLoja); if (d && (!ultVenda[ln] || d > ultVenda[ln])) ultVenda[ln] = d; }
  const margem = {}; for (const m of margens) margem[Number(m.nLoja)] = { varejo: numDec(m.MargemVarejo), atacado: numDec(m.MargemAtacado) };
  const promo = {}; for (const p of promos) { const ln = Number(p.nloja); const alvo = ln ? [ln] : LOJAS; for (const l of alvo) if (!promo[l]) promo[l] = { preco: numDec(p.preco_promo), inicio: isoDate(p.data_inicio), fim: isoDate(p.data_fim), nome: String(p.nome_promo || '').trim() }; }

  const porLoja = LOJAS.map((ln, i) => {
    const e = estoques[i], c = custos[i];
    const preco = num(it['P' + ln]), atacado = num(it['a' + ln]), mult = Math.round(num(it['q' + ln]));
    const custo = c ? numDec(c.Custo) : 0;
    const cad = cadLojas[ln];
    return {
      loja: ln, rotulo: ROTULO[ln], bairro: BAIRRO[ln], razao: cad.razao, cnpj: cad.cnpj,
      ativa: Number(it['L' + ln]) === 1,
      preco_varejo: r2(preco), preco_atacado: r2(atacado), qtd_mult: mult,
      preco_promocao: promo[ln] ? r2(promo[ln].preco) : 0, promocao: promo[ln] || null,
      preco_compra: r2(custo), custo_medio: c ? r2(numDec(c.CustoMedio)) : 0,
      margem_custo: custo > 0 && preco > 0 ? r2((preco / custo - 1) * 100) : null,     // igual ao ERP (markup)
      margem_venda: preco > 0 && custo > 0 ? r2((preco - custo) / preco * 100) : null,
      margem_cadastrada: margem[ln] ? margem[ln].varejo : null,
      estoque: e ? numDec(e.Qtd) : 0, estoque_data: e ? isoDate(e.Data) : null,
      ultima_compra: c ? dataUtil(isoDate(c.UltimaCompra)) : null,      // só a coluna real, como o ERP (CD sem compra fica em branco)
      ultima_venda: ultVenda[ln] || null,
    };
  });

  return {
    produto: {
      codigo: String(it.CodigoBarra).trim(), interno: it.nInterno, descricao: it.descricao || '', unid: String(it.Unid || '').trim(),
      unid_compra: String(it.UnidadeCompra || '').trim(), emb: numDec(it.qtdemb), desativado: Number(it.CodDesativado) === 1,
      ncm: String(it.CODIGONCM || '').trim(), marca: String(it.Marca || '').trim(), balanca: String(it.TipoBalanca || '').trim(),
      validade_dias: Number(it.Validade) || 0, grupo: it.grupo || '', subgrupo: it.subgrupo || '', fornecedor: it.fornecedor || '',
      alterado_em: String(it.DataHoraAlteracao || '').trim(),
      filhos: (filhos || []).map(f => ({ codigo: String(f.CodigoBarra).trim(), descricao: f.descricao, emb: numDec(f.qtdemb), unid: String(f.Unid || '').trim() })),
    },
    lojas: porLoja,
    consultado_em: new Date().toISOString(),
  };
}

// ── Curva ABC + venda 30 dias, por loja (cache em memória até virar o dia) ─────────────────────────────────
// Ranking de TODOS os produtos da loja nos últimos 30 dias (R$ desc); posição acumulada define A/B/C. Calcular uma vez
// por loja custa ~0,5 s por banco mensal (2 meses) e serve pra qualquer produto consultado no dia.
const rank = {};            // rank[ln] = { dia, total, mapa: Map(codigo → {curva, pos, qtd, valor}), n }
const emCurso = {};
function janela30() {
  const fim = new Date(); fim.setHours(12, 0, 0, 0);
  const ini = new Date(fim); ini.setDate(ini.getDate() - (DIAS_CURVA - 1));
  const meses = []; const cur = new Date(ini.getFullYear(), ini.getMonth(), 1);
  while (cur <= fim) { meses.push(pad(cur.getMonth() + 1)); cur.setMonth(cur.getMonth() + 1); }
  return { ini: iso(ini), fim: iso(fim), meses };
}
async function rankingLoja(ln) {
  const dia = iso(new Date());
  if (rank[ln] && rank[ln].dia === dia) return rank[ln];
  if (emCurso[ln]) return emCurso[ln];
  emCurso[ln] = (async () => {
    const { ini, fim, meses } = janela30();
    const soma = new Map();
    // 26/10: a loja 4 (1,6 mi linhas/mês) chegou a levar minutos quando o Radar e o Dashboard estavam na mesma tabela.
    // Cada banco mensal tem TIMEOUT_CURVA pra responder; estourou, a loja fica sem curva nesta chamada e NÃO entra no
    // cache (a próxima consulta tenta de novo). Banco que não existe (mês rotativo) só devolve vazio.
    for (const mm of meses) {
      const rows = await q(`SELECT Codigo cod, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) val FROM \`ln${ln}mes${mm}\`.zcupomitens
                            WHERE Data BETWEEN ? AND ? AND IndCancel = 'N' GROUP BY Codigo`, [ini, fim], { timeoutMs: TIMEOUT_CURVA })
        .catch(e => { if (/doesn't exist|Unknown database/i.test(e.message || '')) return []; throw e; });
      for (const r of rows) { const k = String(r.cod).trim(); const s = soma.get(k) || { qtd: 0, valor: 0 }; s.qtd += numDec(r.qtd); s.valor += numDec(r.val); soma.set(k, s); }
    }
    const lista = [...soma.entries()].filter(([, s]) => s.valor > 0).sort((a, b) => b[1].valor - a[1].valor);
    const total = lista.reduce((t, [, s]) => t + s.valor, 0);
    const mapa = new Map(); let acum = 0;
    lista.forEach(([k, s], i) => { acum += s.valor; const f = total > 0 ? acum / total : 1; mapa.set(k, { curva: f <= CORTE_A ? 'A' : f <= CORTE_B ? 'B' : 'C', pos: i + 1, qtd: r2(s.qtd), valor: r2(s.valor) }); });
    rank[ln] = { dia, ini, fim, total: r2(total), n: lista.length, mapa };
    return rank[ln];
  })().finally(() => { delete emCurso[ln]; });
  return emCurso[ln];
}
async function curva(codigo) {
  const cod = String(codigo || '').trim();
  const out = { dias: DIAS_CURVA, lojas: {} };
  await Promise.all(LOJAS_VENDA.map(async ln => {
    const r = await rankingLoja(ln).catch(() => null);
    if (!r) { out.lojas[ln] = { curva: null, erro: true }; return; }
    const x = r.mapa.get(cod);
    out.periodo = { inicio: r.ini, fim: r.fim };
    out.lojas[ln] = x ? { curva: x.curva, posicao: x.pos, de: r.n, qtd_30d: x.qtd, valor_30d: x.valor, media_dia: r2(x.qtd / DIAS_CURVA) }
                      : { curva: null, posicao: null, de: r.n, qtd_30d: 0, valor_30d: 0, media_dia: 0 };
  }));
  return out;
}

module.exports = { init, buscar, detalhe, curva, lojas, LOJAS, ROTULO, BAIRRO };
