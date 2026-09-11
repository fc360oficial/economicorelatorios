// Formação de Preço — cálculo puro (sem ERP, sem arquivo). Ver spec 2026-09-11-formacao-de-preco-design.md.
'use strict';

const TOL_SEM_MUDANCA = 0.005;   // ±0,5% entre custo com imposto e custo atual = não mexe
const POLITICAS = ['manter', 'repassar', 'por_curva'];
const TERMINACOES = ['9', '5', 'nenhum'];

// centavos inteiros, evitando 3.995 → 399.49999
const cents = v => Math.round(Number(v || 0) * 100 + 1e-6);
const ceilCents = v => Math.ceil(Number(v || 0) * 100 - 1e-6);

// menor valor >= v (2 casas) cujo último dígito de centavo é `term`; 'nenhum' = só 2 casas pra cima
function arred(v, term) {
  let c = ceilCents(v);
  if (c < 0) c = 0;
  if (term !== '9' && term !== '5') return c / 100 || 0;
  const d = +term;
  const resto = c % 10;
  if (resto !== d) c += (d - resto + 10) % 10;
  return c / 100 || 0;
}

module.exports = { arred, cents, TOL_SEM_MUDANCA, POLITICAS, TERMINACOES };
