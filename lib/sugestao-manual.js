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

module.exports = { DIR, calcularLoja, repartirPorLoja };
