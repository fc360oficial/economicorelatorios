// Formação de Preço — cálculo puro (sem ERP, sem arquivo). Ver spec 2026-09-11-formacao-de-preco-design.md.
'use strict';

const TOL_SEM_MUDANCA = 0.005;   // (legado) mantido só pra compatibilidade de quem importa
const POLITICAS = ['manter', 'repassar', 'por_curva', 'padrao'];   // legado: a regra é única, o campo é ignorado
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

const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;

function precoPor(custo, margem, term) {
  const calc = r2(custo * (1 + margem / 100));
  let sug = arred(calc, term);
  const piso = sug < custo - 1e-9;
  if (piso) sug = arred(custo, term);
  return { preco_calc: calc, preco_sugerido: sug, piso };
}

// REGRA (Tiago, 15/09/2026) — uma só, sem política escolhível:
//   1) custo novo IGUAL ao atual  → preço pela margem de cadastro
//   2) custo novo MAIOR que o atual → preço pela margem de cadastro
//   3) custo novo 20% (ou mais) ABAIXO do atual → preço 10% abaixo do preço atual
//   queda menor que 20% → mantém o preço atual (piso no custo em qualquer caso)
const QUEDA_MIN = 0.20;
const DESCONTO_PRECO = 0.10;

function calcularItem(e, params) {
  const term = TERMINACOES.includes(params?.arredondamento) ? params.arredondamento : '9';
  const ci = Number(e.custo_imposto || 0), ca = e.custo_atual != null && e.custo_atual > 0 ? Number(e.custo_atual) : null;
  const pa = e.preco_atual != null && e.preco_atual > 0 ? Number(e.preco_atual) : null;
  const variacao = ca != null && ci > 0 ? r4(ci / ca - 1) : null;
  const margemSeMantem = pa != null && ci > 0 ? r4(pa / ci - 1) : null;
  const out = { ...e, variacao, preco_calc: null, margem_se_mantem: margemSeMantem, status: 'bloqueado', piso: false, regra: null,
                preco_sugerido: null, preco_final: null, manual: false, atacado: null };
  if (e.motivo_bloqueio) return { ...out, motivo: e.motivo_bloqueio };
  if (e.margem == null || e.margem === 0) return { ...out, motivo: 'sem margem cadastrada na loja' };
  if (!(ci > 0)) return { ...out, motivo: 'custo do XML zerado' };
  delete out.motivo;

  const calc = precoPor(ci, Number(e.margem), term);
  out.preco_calc = calc.preco_calc;
  const statusPor = (sug) => pa == null ? 'sobe' : sug > pa + 1e-9 ? 'sobe' : sug < pa - 1e-9 ? 'desce' : 'sem_mudanca';
  let regra, sug, piso, status;
  if (pa == null || ca == null || ci >= ca - 1e-9) {
    regra = 'margem'; sug = calc.preco_sugerido; piso = calc.piso; status = statusPor(sug);
  } else if (ci <= ca * (1 - QUEDA_MIN) + 1e-9) {
    regra = 'desconto'; sug = arred(r2(pa * (1 - DESCONTO_PRECO)), term); piso = false;
    if (sug < ci - 1e-9) { sug = arred(ci, term); piso = true; }
    status = statusPor(sug);
  } else {
    regra = 'mantem'; status = 'mantem';
    if (pa < ci - 1e-9) { sug = arred(ci, term); piso = true; } else { sug = pa; piso = false; }
  }
  out.regra = regra; out.status = status; out.preco_sugerido = sug; out.piso = piso;
  out.preco_final = out.preco_sugerido;

  if (e.margem_atacado > 0) {
    const at = precoPor(ci, Number(e.margem_atacado), term);
    const paAt = e.preco_atacado_atual != null && e.preco_atacado_atual > 0 ? Number(e.preco_atacado_atual) : null;
    let sugA, pisoAt;
    if (regra === 'margem' || paAt == null) { sugA = at.preco_sugerido; pisoAt = at.piso; }
    else if (regra === 'desconto') { sugA = arred(r2(paAt * (1 - DESCONTO_PRECO)), term); pisoAt = false; if (sugA < ci - 1e-9) { sugA = arred(ci, term); pisoAt = true; } }
    else if (paAt < ci - 1e-9) { sugA = arred(ci, term); pisoAt = true; }
    else { sugA = paAt; pisoAt = false; }
    out.atacado = { preco_calc: at.preco_calc, preco_sugerido: sugA, preco_final: sugA, piso: pisoAt };
  }
  return out;
}

function calcularRegistro(reg, opts = {}) {
  const antes = new Map((reg.itens || []).map(i => [i.cod, i]));
  reg.itens = (reg.entradas || []).map(e => {
    const novo = calcularItem(e, reg.parametros);
    const old = antes.get(e.cod);
    if (old && old.manual && !opts.descartarManuais && novo.status !== 'bloqueado' && Math.abs((old.custo_imposto || 0) - (novo.custo_imposto || 0)) < 1e-9) {
      novo.preco_final = old.preco_final; novo.manual = true;
      if (novo.atacado && old.atacado) { novo.atacado.preco_final = old.atacado.preco_final; }
    }
    return novo;
  });
  reg.resumo = resumo(reg.itens);
  return reg;
}

function resumo(itens) {
  const r = { itens: itens.length, sobem: 0, descem: 0, mantem: 0, sem_mudanca: 0, bloqueados: 0, mudam: 0, piso: 0 };
  for (const i of itens) {
    if (i.status === 'sobe') r.sobem++; else if (i.status === 'desce') r.descem++; else if (i.status === 'mantem') r.mantem++;
    else if (i.status === 'sem_mudanca') r.sem_mudanca++; else if (i.status === 'bloqueado') r.bloqueados++;
    if (i.piso === true) r.piso++;
  }
  const pisoExtra = itens.filter(i => i.piso === true && i.status !== 'sobe' && i.status !== 'desce').length;
  r.mudam = r.sobem + r.descem + pisoExtra;
  return r;
}

module.exports = { arred, cents, calcularItem, calcularRegistro, resumo, TOL_SEM_MUDANCA, POLITICAS, TERMINACOES, QUEDA_MIN, DESCONTO_PRECO };
