// Sugestão Manual — tela "Consolidação da Lista" (espelho do Dlinks, dentro do Fluxo).
//
// Conta por loja igual à do Dlinks (lista_consolidado_historico.QtdSug):
//   MédiaPeríodo    = QtdVenda ÷ dias   (dias corridos; obs.dias_com_venda → dias com venda)
//   DiasCob         = Estoque ÷ MédiaPeríodo
//   SugestãoSistema = max(0, round(Cobertura × MédiaPeríodo − Estoque − Trânsito))
//   obs.sem_estoque → Estoque = 0 ; !obs.transito → Trânsito = 0
//
// Persistência: um JSON por sugestão em data/sugestoes-manuais/ (F-N = criada
// aqui; D-<nConsolidado> = só os ajustes numa sugestão do Dlinks). NADA é
// escrito no ERP.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'sugestoes-manuais');

function calcularLoja({ qtdVenda, diasVenda, dias, estoque, transito, cobertura, obs }) {
  const o = obs || {};
  const div = o.dias_com_venda ? Math.max(1, diasVenda || 0) : Math.max(1, dias || 0);
  const media = (qtdVenda || 0) / div;
  const est = o.sem_estoque ? 0 : (estoque || 0);
  const tr = o.transito ? (transito || 0) : 0;
  const diasCob = media > 0 ? est / media : null;
  const sug = Math.max(0, Math.round((cobertura || 0) * media - est - tr));
  return { media: +media.toFixed(3), dias_cob: diasCob == null ? null : +diasCob.toFixed(1), sug_sistema: sug };
}

// reparte o total do item pelas lojas proporcional à sugestão sistema; sem sugestão divide igual; última fecha a conta
function repartirPorLoja(total, lojas) {
  const T = Math.max(0, Math.round(total || 0));
  if (T <= 0 || !lojas || !lojas.length) return {};
  const soma = lojas.reduce((a, l) => a + (l.sug_sistema || 0), 0);
  const out = {}; let dist = 0;
  lojas.forEach((l, i) => {
    let qv = soma > 0 ? Math.round(T * (l.sug_sistema || 0) / soma) : Math.floor(T / lojas.length);
    if (i === lojas.length - 1) qv = T - dist;
    dist += qv; if (qv > 0) out[l.loja] = qv;
  });
  return out;
}

let dir = DIR;
function _setDir(d) { dir = d; fs.mkdirSync(dir, { recursive: true }); }
function init() { fs.mkdirSync(dir, { recursive: true }); }
const arq = id => path.join(dir, `${id}.json`);
const ID_OK = /^[FD]-\d+$/;

function proximoId() {
  const seqArq = path.join(dir, '_seq.json');
  let n = 0; try { n = JSON.parse(fs.readFileSync(seqArq, 'utf8')).n || 0; } catch (e) {}
  n += 1; fs.writeFileSync(seqArq, JSON.stringify({ n }));
  return `F-${n}`;
}
function salvar(s) { if (!ID_OK.test(s.id || '')) throw new Error('Id inválido'); s.atualizado_em = new Date().toISOString(); fs.writeFileSync(arq(s.id), JSON.stringify(s)); return s; }
function obter(id) { if (!ID_OK.test(id || '')) return null; try { return JSON.parse(fs.readFileSync(arq(id), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(dir).filter(f => /^F-\d+\.json$/.test(f)).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
}

// patch = { quantidades:{cod:{loja:qtd}}, obs:{cod:texto}, ativo:{cod:bool}, status, pedido_id }
function aplicarPatch(s, patch) {
  const p = patch || {};
  const qtd = v => Math.max(0, Math.round(parseFloat(v) || 0));
  if (s.origem === 'fluxo') {
    for (const it of s.itens || []) {
      const c = String(it.codigo);
      const qs = p.quantidades && p.quantidades[c];
      if (qs) { for (const l of it.lojas) if (qs[l.loja] != null) l.sug_loja = qtd(qs[l.loja]); it.quantidade = it.lojas.reduce((a, l) => a + (l.sug_loja || 0), 0); }
      if (p.obs && p.obs[c] != null) it.obs = String(p.obs[c]).slice(0, 200);
      if (p.ativo && p.ativo[c] != null) it.ativo = !!p.ativo[c];
    }
  } else {
    s.quantidades = s.quantidades || {}; s.obs = s.obs || {}; s.inativos = s.inativos || [];
    for (const [c, qs] of Object.entries(p.quantidades || {})) { s.quantidades[c] = s.quantidades[c] || {}; for (const [l, v] of Object.entries(qs || {})) s.quantidades[c][l] = qtd(v); }
    for (const [c, t] of Object.entries(p.obs || {})) s.obs[c] = String(t).slice(0, 200);
    for (const [c, a] of Object.entries(p.ativo || {})) { const i = s.inativos.indexOf(String(c)); if (!a && i < 0) s.inativos.push(String(c)); if (a && i >= 0) s.inativos.splice(i, 1); }
  }
  if (['aberta', 'pedido_gerado', 'desativada'].includes(p.status)) s.status = p.status;
  if (p.pedido_id != null) s.pedido_id = p.pedido_id;
  return s;
}

let q = null;
function initERP(deps) { q = deps.q; }

const num = v => { if (v == null) return 0; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? 0 : n; };
const txt = v => (v == null || String(v).trim() === '0') ? '' : String(v).trim();
function diasEntre(d1, d2) {           // 'dd/mm/aaaa' → dias corridos (mínimo 1)
  const p = s => { const [d, m, a] = String(s).split('/').map(Number); return new Date(a, m - 1, d); };
  try { return Math.max(1, Math.round((p(d2) - p(d1)) / 86400000)); } catch (e) { return 1; }
}

// linhas cruas das 3 tabelas + JSON de ajustes (D-N.json ou null) → objeto no formato F-N
function montarDeLinhas(cab, itens, hist, ajustes) {
  const aj = ajustes || { quantidades: {}, obs: {}, inativos: [], status: 'aberta', pedido_id: null };
  const porItem = {};
  for (const h of hist) (porItem[String(h.CodigoBarra)] = porItem[String(h.CodigoBarra)] || []).push(h);
  const lojas = [...new Set(hist.map(h => +h.nLoja))].sort((a, b) => a - b);
  let vlr = 0, qtdV = 0;
  const out = itens.map(it => {
    const c = String(it.CodigoBarra);
    const hs = (porItem[c] || []).sort((a, b) => a.nLoja - b.nLoja);
    const ls = hs.map(h => {
      const ln = +h.nLoja;
      const ajq = aj.quantidades && aj.quantidades[c] && aj.quantidades[c][ln];
      const ql = num(it['Ql' + ln]);
      const sugSis = Math.round(num(h.QtdSug));
      const sugLoja = ajq != null ? ajq : (ql > 0 ? Math.round(ql) : sugSis);
      const media = num(h.SaidaMedia);
      vlr += num(h.PMV) * num(h.QtdVendas); qtdV += num(h.QtdVendas);
      return { loja: ln, ultima_compra: txt(h.DataCompra) || null, ultima_venda: null, fornecedor: txt(h.Fornecedor) || null, un: txt(it.Unid) || null,
        emb: num(h.Emb) || null, qtd_compra: num(h.Qtd), preco_compra: num(h.Preco), total_compra: num(h.Total), custo: num(h.Custo), preco_atual: num(h.PVenda),
        estoque: num(h.Estoque), pmv: num(h.PMV), qtd_venda: num(h.QtdVendas), dias_venda: null, media: +media.toFixed(3),
        dias_cob: media > 0 ? +num(h.Cobertura).toFixed(1) : null, sug_sistema: sugSis, transito: num(h.Transito), abc: null, sug_loja: sugLoja };
    });
    return { codigo: c, descricao: txt(it.Descricao), und: txt(it.Unid), emb: num(it.QtdEmb) || 1, preco_und: +num(it.Preco).toFixed(2),
      obs: (aj.obs && aj.obs[c] != null) ? aj.obs[c] : txt(it.Obs), ativo: !(aj.inativos || []).includes(c),
      quantidade: ls.reduce((a, l) => a + (l.sug_loja || 0), 0), lojas: ls };
  });
  return { id: `D-${cab.nConsolidado}`, origem: 'dlinks', criado_em: cab.Data ? new Date(cab.Data).toISOString() : null, criado_por: null,
    lista: { id: +cab.nLista, nome: txt(cab.NomeFornec), fornecedor: txt(cab.NomeFornec), cnpj: txt(cab.CNPJ) || null, cod_fornec: +cab.CodFornec || null },
    parametros: { data_ini: txt(cab.DataVenda1) || null, data_fim: txt(cab.DataVenda2) || null, dias: diasEntre(cab.DataVenda1, cab.DataVenda2), cobertura: +cab.QtdCobertura || 0, lojas, obs: { sem_estoque: false, transito: true, dias_com_venda: false } },
    status: aj.status || 'aberta', pedido_id: aj.pedido_id || null, status_web: +cab.StatusWeb || 0, desativada_erp: +cab.CodDesativado === 1,
    pm: qtdV > 0 ? +(vlr / qtdV).toFixed(2) : 0, itens: out };
}

async function montarDoERP(nConsolidado) {
  const n = parseInt(nConsolidado); if (!n) return null;
  const [cab] = await q(`SELECT nConsolidado, nLista, CodFornec, NomeFornec, CNPJ, Data, DataVenda1, DataVenda2, QtdCobertura, StatusWeb, CodDesativado FROM central.lista_consolidadas WHERE nConsolidado=?`, [n]);
  if (!cab) return null;
  const [itens, hist] = await Promise.all([
    q(`SELECT CodigoBarra, Descricao, Unid, QtdEmb, QTotal, Preco, Ql1, Ql2, Ql3, Ql4, Ql5, Ql6, Ql7, Ql8, Ql9, Ql10, Obs FROM central.lista_consolidado_itens WHERE nConsolidado=? ORDER BY Descricao`, [n]),
    q(`SELECT nLoja, CodigoBarra, DataCompra, Fornecedor, Qtd, Emb, Preco, Total, Custo, PVenda, Transito, SaidaMedia, Cobertura, Estoque, QtdVendas, QtdSug, QtdLoja, PMV FROM central.lista_consolidado_historico WHERE nConsolidado=?`, [n])
  ]);
  return montarDeLinhas(cab, itens, hist, obter(`D-${n}`));
}

module.exports = { DIR, _setDir, init, proximoId, salvar, obter, listar, aplicarPatch, calcularLoja, repartirPorLoja, initERP, montarDeLinhas, montarDoERP };
