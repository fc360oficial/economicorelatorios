// Sem Giro (Precificação > Sem Giro, 06/10/2026, pedido do Tiago): "precificar o sem giro" — produtos COM ESTOQUE e SEM
// VENDA no caixa há 30 / 60 / 90 / 120 ou mais dias, loja a loja, com código de barras, descrição, última compra, última
// venda, custo, preço, margem aplicada × margem cadastrada e simulador nas duas direções (digita a margem → vê o preço;
// digita o preço → vê a margem). SÓ LEITURA no ERP. O que é gravado fica em data/:
//   sem-giro.json           — cache do cálculo (1×/dia de madrugada ou sob demanda)
//   sem-giro-decisoes.json  — preço novo aceito na tela, por loja × produto (sai em CSV pra digitar no ERP)
//   sem-giro-exemplos.json  — exemplos de TESTE criados pelo botão da tela (somem com "Remover exemplos")
//
// Fontes (as mesmas do Radar Precificação e do Dashboard › Estoque por loja):
//   central.itens (ativos): descrição, unidade, P{loja} = preço de venda, grupo/subgrupo do mercadológico
//   central.estoquen{loja}.Qtd > 0 — só o que tem estoque (sem estoque não há o que precificar)
//   central.custoloja{loja}: Custo e UltimaCompra (coluna real do cadastro; pode vir Date, 'YYYY-MM-DD…' ou 'dd/mm/yyyy')
//   central.itens_margens (nLoja): MargemVarejo = margem CADASTRADA; o ERP forma preço = custo × (1 + margem/100), ou seja,
//     a "margem" do ERP é sobre o CUSTO (markup). A tela mostra essa como principal, pra bater com a cadastrada, e a
//     margem sobre a venda ((preço − custo) ÷ preço) ao lado.
//   ln{loja}mes{MM}.zcupomitens: última venda = MAX(Data) do mês atual e dos 4 anteriores (cobre 120 dias ou mais); quem
//     não vendeu nada na janela cai em "120 ou mais". Os bancos mensais são rotativos (12 meses), então o dia exato da
//     última venda só existe dentro da janela.
// Faixas: 30–59 · 60–89 · 90–119 · 120 ou mais dias sem venda. Item que vendeu nos últimos 29 dias tem giro: fica fora.
// Uso e consumo / insumo de produção (saco, bandeja, farinha da padaria…) nunca passa no caixa: fica marcado e FORA por
// padrão (mesma regra do Dashboard › Estoque por loja), com opção de incluir na tela.
'use strict';
const fs = require('fs');
const path = require('path');
const { arred } = require('./precificacao-calc');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'sem-giro.json');
const DEC = path.join(DATA, 'sem-giro-decisoes.json');
const EXE = path.join(DATA, 'sem-giro-exemplos.json');
const LOJAS = [1, 2, 3, 4, 5, 6];
const NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const FAIXAS = [30, 60, 90, 120];
const MESES_JANELA = 5;                 // mês atual + 4 anteriores ≥ 120 dias
const GIRO_DIAS = 30;                   // vendeu há menos que isso = tem giro

// mesma regra do Dashboard › Estoque por loja (lib/dashboard.js): uso e consumo / insumo não vende no caixa
const CONSUMO_RE = /USO E CONSUMO|CONSUMO|USO INTERNO|MAT(ERIAL)? ?(DE )?(EMBALAGEM|ESCRIT|LIMPEZA|EXPEDIENTE)|MAT ?PRIMA|MATERIA.PRIMA|INSUMO|EMBALAGE|ATIVO IMOBILIZADO|\bLUVAS\b|UNIFORME|\bEPI\b/i;
const INSUMO_DESC_RE = /^(PADARIA|ACOUGUE|A[CÇ]OUGUE|PROD\.?|INSUMO|CONSUMO|USO INTERNO|MAT\.? ?(DE )?(CONSUMO|LIMPEZA|ESCRIT))\b|RESFRIAD[AO]\b.*\b(TRASEIRO|DIANTEIRO)\b|\bCARCA[CÇ]A\b|\bQUARTO (TRASEIRO|DIANTEIRO)\b/i;

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoDate = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : iso(v); const s = String(v).trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3]; m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return m[3] + '-' + m[2] + '-' + m[1]; return null; };
const up = s => String(s || '').trim().toUpperCase();
const diasAte = (hoje, d) => d ? Math.round((hoje - new Date(d + 'T12:00:00')) / 864e5) : null;
const faixaDe = dias => dias == null || dias >= 120 ? 120 : dias >= 90 ? 90 : dias >= 60 ? 60 : dias >= 30 ? 30 : 0;

let deps = null, cache = null, calculando = null, decisoes = null, exemplos = null;
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); }

function init(d) { deps = d; decisoes = lerJson(DEC, {}); exemplos = lerJson(EXE, null); cache = lerJson(OUT, null); }

// margens de uma linha (custo × preço): markup s/ custo (o "margem" do ERP) e margem s/ venda; preço que a margem cadastrada daria
function margens(r) {
  const c = r.custo, p = r.preco;
  r.markup = c > 0 && p > 0 ? r1((p - c) / c * 100) : null;
  r.margemVenda = c > 0 && p > 0 ? r1((p - c) / p * 100) : null;
  r.precoCad = c > 0 && r.margemCad != null ? r2(c * (1 + r.margemCad / 100)) : null;
  r.abaixoCusto = c > 0 && p > 0 && p < c;
  r.valor = r2(r.est * (c > 0 ? c : 0));
  return r;
}

async function calcular() {
  if (calculando) return calculando;
  calculando = (async () => {
    const q = deps.q, t0 = Date.now(), hoje = new Date(), dHoje = iso(hoje);
    console.log('[SEM-GIRO] calculando...');
    const janelaDe = iso(new Date(hoje.getFullYear(), hoje.getMonth() - (MESES_JANELA - 1), 1));
    const itens = await q(`SELECT i.CodigoBarra cod, TRIM(i.Descricao) descricao, i.Unid unid, i.P1, i.P2, i.P3, i.P4, i.P5, i.P6,
                                  TRIM(g.Descricao) grupo, TRIM(gs.Descricao) subgrupo
                           FROM central.itens i LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
                           LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo WHERE i.CodDesativado = 0 AND i.CodigoBarra IS NOT NULL`);
    const cad = new Map();
    for (const it of itens) cad.set(String(it.cod).trim(), it);
    if (!cad.size) throw new Error('cadastro de itens vazio: Sem Giro não calculado');
    const ult = {}, lojasErro = [], rows = [];
    for (const ln of LOJAS) {
      // 1) o que tem estoque na loja (varredura de estoquen; o JOIN com custoloja passava do timeout nas lojas grandes)
      const est0 = await q(`SELECT CodigoBarra cod, Qtd est FROM central.estoquen${ln} WHERE CAST(REPLACE(Qtd, ',', '.') AS DECIMAL(14,3)) > 0`)
        .catch(e => { console.error('[SEM-GIRO] estoquen' + ln, e.message); return null; });
      if (!est0) { lojasErro.push({ loja: ln, motivo: 'estoque' }); continue; }
      const rs = [];
      for (const r of est0) { const cod = String(r.cod).trim(), it = cad.get(cod); if (it) rs.push({ cod, it, est: num(r.est) }); }
      // 2) custo e última compra (cadastro da loja), por lotes de códigos
      const custo = new Map();
      for (const ch of chunk(rs.map(r => r.cod), 4000))
        for (const r of await q(`SELECT CodigoBarra cod, Custo, UltimaCompra FROM central.custoloja${ln} WHERE CodigoBarra IN (${ch.map(() => '?').join(',')})`, ch).catch(e => { console.error('[SEM-GIRO] custoloja' + ln, e.message); return []; }))
          custo.set(String(r.cod).trim(), { custo: num(r.Custo), ultCompra: isoDate(r.UltimaCompra) });
      // 3) margem cadastrada na loja
      const mcad = new Map();
      for (const r of await q(`SELECT CodigoBarra cod, MargemVarejo m FROM central.itens_margens WHERE nLoja=?`, [ln]).catch(e => { console.error('[SEM-GIRO] itens_margens' + ln, e.message); return []; }))
        if (r.m != null && r.m !== '') mcad.set(String(r.cod).trim(), num(r.m));
      // 4) última venda no caixa: mês atual e os 4 anteriores (todos os códigos vendidos — serve também pro "vende em outras lojas")
      const u = new Map(); let cupons = 0;
      for (let k = 0; k < MESES_JANELA; k++) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth() - k, 1), y = d.getFullYear(), m = pad(d.getMonth() + 1);
        const dIni = `${y}-${m}-01`, dFim = k === 0 ? dHoje : `${y}-${m}-${pad(new Date(y, d.getMonth() + 1, 0).getDate())}`;
        const cs = await q(`SELECT Codigo cod, DATE_FORMAT(MAX(Data),'%Y-%m-%d') d FROM \`ln${ln}mes${m}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIni, dFim])
          .catch(e => { console.error(`[SEM-GIRO] ln${ln}mes${m}`, e.message); return []; });
        cupons += cs.length;
        for (const c of cs) { const cod = String(c.cod).trim(); if (!u.has(cod) || u.get(cod) < c.d) u.set(cod, c.d); }
      }
      ult[ln] = u;
      if (!cupons) { lojasErro.push({ loja: ln, motivo: 'cupons' }); continue; }   // sem cupom nenhum = não dá pra dizer o que não vende
      let n = 0;
      for (const r of rs) {
        const uv = u.get(r.cod) || null, dias = diasAte(hoje, uv), faixa = faixaDe(dias);
        if (!faixa) continue;                                                       // vendeu há menos de 30 dias: tem giro
        const it = r.it, c = custo.get(r.cod) || { custo: 0, ultCompra: null };
        const grupo = String(it.grupo || '').trim(), subgrupo = String(it.subgrupo || '').trim(), descricao = String(it.descricao || '').trim();
        rows.push(margens({ loja: ln, cod: r.cod, descricao, unid: it.unid || '', grupo, subgrupo,
          consumo: CONSUMO_RE.test(grupo) || CONSUMO_RE.test(subgrupo) || INSUMO_DESC_RE.test(descricao),
          est: +r.est.toFixed(3), custo: r2(c.custo), preco: r2(num(it['P' + ln])), margemCad: mcad.has(r.cod) ? r1(mcad.get(r.cod)) : null,
          ultCompra: c.ultCompra, ultVenda: uv, dias, faixa }));
        n++;
      }
      console.log(`[SEM-GIRO] E${ln}: ${rs.length} com estoque, ${n} sem giro`);
    }
    // vende em outras lojas (giro nos últimos 30 dias) — ajuda a decidir o preço olhando onde o item sai
    for (const r of rows) {
      const it = cad.get(r.cod), g = [];
      for (const ln of LOJAS) { if (ln === r.loja || !ult[ln]) continue; const d = diasAte(hoje, ult[ln].get(r.cod) || null); if (d != null && d < GIRO_DIAS) g.push({ loja: ln, preco: r2(num(it['P' + ln])), dias: d }); }
      r.giraEm = g;
    }
    cache = { calculadoEm: new Date().toISOString(), hoje: dHoje, janelaDe, lojasErro, ms: Date.now() - t0, rows };
    gravarJson(OUT, cache);
    console.log(`[SEM-GIRO] ok: ${rows.length} linhas em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  })().finally(() => { calculando = null; });
  return calculando;
}

// ── decisões da tela (preço novo aceito por loja × produto). Nada vai pro ERP.
function decisao(r) { return decisoes[`${r.loja}|${r.cod}`] || null; }
function setDecisao({ loja, cod, preco, origem, usuario }) {
  const k = `${+loja}|${String(cod)}`;
  if (!(num(preco) > 0)) { delete decisoes[k]; gravarJson(DEC, decisoes); return null; }
  decisoes[k] = { preco: r2(num(preco)), origem: origem === 'margem' ? 'margem' : 'preco', usuario: usuario || null, em: new Date().toISOString() };
  gravarJson(DEC, decisoes);
  return decisoes[k];
}
// linha + decisão + margens que o preço novo dá (recalculadas aqui pra tela e CSV não divergirem)
function comDecisao(r) {
  const d = decisao(r);
  if (!d) return { ...r, decisao: null };
  const c = r.custo, p = d.preco;
  return { ...r, decisao: { ...d, markup: c > 0 ? r1((p - c) / c * 100) : null, margemVenda: c > 0 && p > 0 ? r1((p - c) / p * 100) : null, delta: r.preco > 0 ? r1((p / r.preco - 1) * 100) : null } };
}

// ── exemplos de TESTE (Tiago, 15/09: toda tela nova entra com exemplos visíveis pra ajustar olhando)
function criarExemplos() {
  const hoje = new Date(), dm = n => iso(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - n));
  const base = [
    { loja: 1, cod: '9990000000011', descricao: 'TESTE — AZEITE EXTRA VIRGEM 500ML', unid: 'UN', grupo: 'OLEO/MASSAS', subgrupo: 'AZEITES', est: 24, custo: 21.4, preco: 32.9, margemCad: 45, ultCompra: dm(74), ultVenda: dm(41) },
    { loja: 1, cod: '9990000000028', descricao: 'TESTE — PANELA PRESSÃO 4,5L', unid: 'UN', grupo: 'UTILIDADE DOMESTICA', subgrupo: 'PANELAS', est: 6, custo: 68.0, preco: 99.9, margemCad: 60, ultCompra: dm(210), ultVenda: dm(133) },
    { loja: 1, cod: '9990000000035', descricao: 'TESTE — SHAMPOO ANTICASPA 400ML', unid: 'UN', grupo: 'HIGIENE', subgrupo: 'CABELOS', est: 11, custo: 14.9, preco: 13.99, margemCad: 35, ultCompra: dm(58), ultVenda: dm(66) },
    { loja: 2, cod: '9990000000042', descricao: 'TESTE — VINHO TINTO SUAVE 750ML', unid: 'UN', grupo: 'BEBIDAS/REFRIG/SUCO/AGUA SABOR', subgrupo: 'VINHOS', est: 18, custo: 12.5, preco: 19.9, margemCad: 55, ultCompra: dm(95), ultVenda: dm(97) },
    { loja: 2, cod: '9990000000059', descricao: 'TESTE — KIT CHURRASCO 3 PEÇAS', unid: 'UN', grupo: 'ARTIGO FESTA', subgrupo: 'CHURRASCO', est: 4, custo: 39.0, preco: 69.9, margemCad: null, ultCompra: dm(300), ultVenda: null },
    { loja: 3, cod: '9990000000066', descricao: 'TESTE — RAÇÃO GATO ADULTO 1KG', unid: 'UN', grupo: 'PETSHOP', subgrupo: 'RAÇÃO', est: 30, custo: 9.8, preco: 14.99, margemCad: 40, ultCompra: dm(33), ultVenda: dm(35) },
    { loja: 3, cod: '9990000000073', descricao: 'TESTE — CAFÉ GOURMET 250G', unid: 'UN', grupo: 'CAFE/LEITE/CHA/ACHOCOLATADOS', subgrupo: 'CAFÉ', est: 42, custo: 11.2, preco: 0, margemCad: 38, ultCompra: dm(120), ultVenda: dm(80) },
    { loja: 4, cod: '9990000000080', descricao: 'TESTE — LÂMPADA LED 12W', unid: 'UN', grupo: 'CAMPING/FERRAG/AUTOMOTIVO', subgrupo: 'ELÉTRICA', est: 60, custo: 6.4, preco: 12.9, margemCad: 70, ultCompra: dm(150), ultVenda: dm(121) },
    { loja: 4, cod: '9990000000097', descricao: 'TESTE — BISCOITO AMANTEIGADO 330G', unid: 'UN', grupo: 'BISC/BOMBONS/DOCES/SALG', subgrupo: 'BISCOITOS', est: 15, custo: 5.3, preco: 7.49, margemCad: 42, ultCompra: dm(49), ultVenda: dm(52) },
    { loja: 5, cod: '9990000000103', descricao: 'TESTE — SACO PLÁSTICO 30X40 C/1000', unid: 'PCT', grupo: 'USO E CONSUMO', subgrupo: 'EMBALAGEM', est: 9, custo: 48.0, preco: 0, margemCad: null, ultCompra: dm(20), ultVenda: null },
    { loja: 5, cod: '9990000000110', descricao: 'TESTE — DESODORANTE AEROSOL 150ML', unid: 'UN', grupo: 'PERFUMARIA', subgrupo: 'DESODORANTES', est: 27, custo: 8.9, preco: 15.99, margemCad: 50, ultCompra: dm(88), ultVenda: dm(102) },
    { loja: 6, cod: '9990000000127', descricao: 'TESTE — ARROZ INTEGRAL 1KG', unid: 'UN', grupo: 'ARROZ/FEIJAO/FARIN/ACUC', subgrupo: 'ARROZ', est: 36, custo: 5.6, preco: 6.99, margemCad: 22, ultCompra: dm(40), ultVenda: dm(31) },
    { loja: 6, cod: '9990000000134', descricao: 'TESTE — TOALHA BANHO FELPUDA', unid: 'UN', grupo: 'UTILIDADE INFANTIL/CONFECÇÕES', subgrupo: 'CAMA/MESA/BANHO', est: 8, custo: 0, preco: 39.9, margemCad: 65, ultCompra: null, ultVenda: dm(140) },
    { loja: 6, cod: '9990000000011', descricao: 'TESTE — AZEITE EXTRA VIRGEM 500ML', unid: 'UN', grupo: 'OLEO/MASSAS', subgrupo: 'AZEITES', est: 12, custo: 21.4, preco: 29.9, margemCad: 45, ultCompra: dm(60), ultVenda: dm(90) }
  ];
  const gira = { '9990000000011': [{ loja: 4, preco: 29.9, dias: 2 }, { loja: 5, preco: 31.9, dias: 6 }], '9990000000066': [{ loja: 1, preco: 14.99, dias: 1 }], '9990000000127': [{ loja: 1, preco: 6.49, dias: 0 }, { loja: 2, preco: 6.49, dias: 3 }, { loja: 4, preco: 5.99, dias: 1 }] };
  exemplos = base.map(e => margens({ ...e, dias: diasAte(hoje, e.ultVenda), faixa: faixaDe(diasAte(hoje, e.ultVenda)), consumo: CONSUMO_RE.test(e.grupo), giraEm: gira[e.cod] || [], teste: true }));
  gravarJson(EXE, exemplos);
  return exemplos.length;
}
function removerExemplos() {
  const n = (exemplos || []).length;
  for (const e of exemplos || []) delete decisoes[`${e.loja}|${e.cod}`];
  exemplos = null; gravarJson(DEC, decisoes); try { fs.unlinkSync(EXE); } catch (e) {}
  return n;
}

function todas() { return (cache ? cache.rows : []).concat(exemplos || []); }
function filtrar(f) {
  const b = (f.busca || '').toLowerCase(), fx = [];
  if (f.loja) fx.push(r => r.loja === +f.loja);
  if (f.faixa) fx.push(r => r.faixa === +f.faixa);
  if (f.grupo) fx.push(r => up(r.grupo) === up(f.grupo));
  if (!f.consumo) fx.push(r => !r.consumo);
  if (f.so === 'decididas') fx.push(r => !!decisao(r));
  else if (f.so === 'sem_decisao') fx.push(r => !decisao(r));
  else if (f.so === 'abaixo_custo') fx.push(r => r.abaixoCusto);
  else if (f.so === 'sem_dados') fx.push(r => !(r.custo > 0) || !(r.preco > 0));
  else if (f.so === 'gira_outras') fx.push(r => r.giraEm && r.giraEm.length);
  if (b) fx.push(r => r.cod.includes(b) || (r.descricao || '').toLowerCase().includes(b) || (r.grupo || '').toLowerCase().includes(b) || (r.subgrupo || '').toLowerCase().includes(b));
  return todas().filter(r => fx.every(fn => fn(r)));
}
function resumo(rows) {
  const z = () => ({ n: 0, v: 0 }), R = { n: 0, valor: 0, f30: z(), f60: z(), f90: z(), f120: z(), decididas: 0, abaixoCusto: 0, semDados: 0, giraOutras: 0 };
  for (const r of rows) {
    R.n++; R.valor += r.valor; const f = R['f' + r.faixa]; if (f) { f.n++; f.v += r.valor; }
    if (decisao(r)) R.decididas++; if (r.abaixoCusto) R.abaixoCusto++; if (!(r.custo > 0) || !(r.preco > 0)) R.semDados++; if (r.giraEm && r.giraEm.length) R.giraOutras++;
  }
  R.valor = r2(R.valor); for (const k of ['f30', 'f60', 'f90', 'f120']) R[k].v = r2(R[k].v);
  return R;
}
function parseFiltro(qq) {
  return { loja: parseInt(qq.loja) || 0, faixa: parseInt(qq.faixa) || 0, grupo: qq.grupo || '', busca: String(qq.busca || '').trim(), consumo: qq.consumo === '1', so: qq.so || '' };
}
// consulta da tela: filtros + ordenação + limite, com resumo da seleção
function consultar(qq) {
  const f = parseFiltro(qq), rows = filtrar(f);
  const ord = qq.ordem || 'valor', asc = qq.dir === 'asc';
  const val = r => ord === 'decisao' ? (decisao(r) || {}).preco : ord === 'dias' ? (r.dias == null ? 9999 : r.dias) : r[ord];   // sem venda na janela = mais velho de todos
  const vazio = v => v == null || v === '';
  rows.sort((a, b) => {
    const x = val(a), y = val(b), ex = vazio(x), ey = vazio(y);
    if (ex || ey) return ex && ey ? 0 : (ex ? 1 : -1);
    const d = (typeof x === 'string' || typeof y === 'string') ? String(x).localeCompare(String(y), 'pt-BR') : (x > y ? 1 : x < y ? -1 : 0);
    return (asc ? d : -d) || b.valor - a.valor;
  });
  const limite = Math.min(5000, parseInt(qq.limite) || 400);
  return { estado: estado(), resumo: resumo(rows), total: rows.length, rows: rows.slice(0, limite).map(comDecisao) };
}
// cartões: uma linha por loja + rede (respeitando só o filtro de uso e consumo)
function lojas(qq) {
  const consumo = qq && qq.consumo === '1', out = {};
  for (const ln of LOJAS) out[ln] = resumo(filtrar({ loja: ln, consumo }));
  return { estado: estado(), lojas: out, total: resumo(filtrar({ consumo })), nomes: NOMES, faixas: FAIXAS };
}
function estado() {
  if (!cache && deps && !calculando) calcular().catch(e => console.error('[SEM-GIRO]', e.message));
  return { calculadoEm: cache?.calculadoEm || null, hoje: cache?.hoje || null, janelaDe: cache?.janelaDe || null, linhas: cache?.rows?.length || 0, calculando: !!calculando,
    lojasErro: cache?.lojasErro || [], exemplos: (exemplos || []).length, faixas: FAIXAS, nomes: NOMES,
    grupos: [...new Set(todas().map(r => r.grupo).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')) };
}

const csvNum = v => v == null ? '' : String(v).replace('.', ',');
const brData = d => d ? d.split('-').reverse().join('/') : '';
const FAIXA_PT = { 30: '30 a 59 dias', 60: '60 a 89 dias', 90: '90 a 119 dias', 120: '120 dias ou mais' };
// CSV pra digitar no ERP: só com preço novo aceito (padrão) ou a lista inteira da seleção
function csv(rows, soAceitas) {
  const head = 'Loja;Código de barras;Descrição;Departamento;Faixa;Dias sem venda;Última venda;Última compra;Estoque;Valor a custo;Custo;Preço atual;Margem aplicada s/ custo (%);Margem aplicada s/ venda (%);Margem cadastrada (%);Preço novo;Margem nova s/ custo (%);Margem nova s/ venda (%);Δ preço (%);Usuário;Quando';
  const out = [];
  for (const r0 of rows) {
    const r = comDecisao(r0), d = r.decisao;
    if (soAceitas && !d) continue;
    out.push(['E' + r.loja + ' ' + NOMES[r.loja], r.cod, r.descricao + (r.teste ? ' (TESTE)' : ''), r.grupo || '', FAIXA_PT[r.faixa] || r.faixa, r.dias == null ? '' : r.dias, brData(r.ultVenda), brData(r.ultCompra),
      csvNum(r.est), csvNum(r.valor), csvNum(r.custo), csvNum(r.preco), csvNum(r.markup), csvNum(r.margemVenda), csvNum(r.margemCad),
      d ? csvNum(d.preco) : '', d ? csvNum(d.markup) : '', d ? csvNum(d.margemVenda) : '', d ? csvNum(d.delta) : '', d ? d.usuario || '' : '', d ? d.em.slice(0, 16).replace('T', ' ') : '']
      .map(x => String(x ?? '').replace(/;/g, ',')).join(';'));
  }
  return '﻿' + [head].concat(out).join('\r\n');
}

function agendar() {
  const idade = cache ? Date.now() - new Date(cache.calculadoEm).getTime() : Infinity;
  if (idade > 20 * 3600 * 1000) setTimeout(() => calcular().catch(e => console.error('[SEM-GIRO]', e.message)), 150 * 1000);
  setInterval(() => { const d = new Date(); if (d.getHours() === 5 && d.getMinutes() === 40) calcular().catch(e => console.error('[SEM-GIRO]', e.message)); }, 60 * 1000);
}

module.exports = { init, agendar, calcular, consultar, lojas, filtrar, parseFiltro, estado, csv, setDecisao, decisao, criarExemplos, removerExemplos, arred, NOMES, LOJAS, FAIXAS, FAIXA_PT };
