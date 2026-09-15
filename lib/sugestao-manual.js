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
function salvar(s) { s.atualizado_em = new Date().toISOString(); fs.writeFileSync(arq(s.id), JSON.stringify(s)); return s; }
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

module.exports = { DIR, _setDir, init, proximoId, salvar, obter, listar, aplicarPatch, calcularLoja, repartirPorLoja };
