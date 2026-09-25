// Divisão das listas de compra por CATEGORIA (grupo do mercadológico do ERP) — aba "Divisão por Categoria"
// em Gestão de Compras > Listas de Compras (23/09/2026, pedido do Tiago).
//
// Hoje cada lista de compra do ERP (central.c_cotacao_lista) é de um fornecedor e tem uma comprador(a)
// (central.c_cotacao_agenda_comprador). A ideia aqui é SIMULAR a divisão por categoria: uma relação
// "comprador(a) → grupos" (ex.: PATRICIA → BEBIDAS) e, olhando TODAS as listas, o que cada comprador(a)
// passaria a comprar — a lista inteira (quando é quase toda do grupo dela) ou só a parte do grupo
// (uma "lista nova" do tipo "FORNECEDOR · BEBIDAS").
//
// SÃO SÓ EXEMPLOS / SOMENTE LEITURA: nada é gravado no ERP. A relação fica no navegador de quem edita.
//
// Entrada (montarBase): linhas cruas do ERP —
//   listas   : [{ nReg, nome, fornecedor, CodFornec }]
//   grupos   : [{ CodGrupo, d }]                        (central.grupo)
//   itens    : [{ lista, cg, n }]                       (itens ativos da lista, contados por grupo)
//   compradorPorLista : { nReg: 'NOME' }                (NREGS_COMPRADOR invertido)

// Rótulo curto pra compor o nome da lista nova ("ALVOAR · BEBIDAS"); cai no 1º pedaço do nome do grupo.
const ROTULO_CURTO = {
  29: 'ARROZ/FEIJÃO', 30: 'BISCOITOS/DOCES', 31: 'CAFÉ/LEITE', 32: 'MATINAIS', 33: 'ÓLEO/MASSAS',
  34: 'CONDIMENTOS', 35: 'MOLHOS', 36: 'BEBIDAS', 37: 'DIET/LIGHT', 38: 'FESTA/GRANULADOS', 39: 'ARTIGO FESTA',
  40: 'LIMPEZA', 41: 'HIGIENE', 42: 'PERFUMARIA', 43: 'FRIOS/CONGELADOS', 44: 'PEIXARIA', 45: 'AÇOUGUE',
  46: 'FLV', 47: 'PADARIA', 48: 'SALGADO', 49: 'SAL/CARVÃO', 50: 'MESA/BANHO', 51: 'FERRAGENS', 52: 'PETSHOP',
  53: 'CALÇADOS', 54: 'INFANTIL/CONFECÇÕES', 55: 'PRATO PRONTO', 56: 'UTILIDADES', 57: 'TABACARIA',
  60: 'PAPELARIA', 62: 'USO E CONSUMO',
};
function rotulo(cg, nome) {
  return ROTULO_CURTO[cg] || String(nome || '').split('/')[0].trim() || ('GRUPO ' + cg);
}

// Base: listas com total de itens e itens por grupo; grupos com total, nº de listas e quem compra mais hoje.
function montarBase({ listas = [], grupos = [], itens = [], compradorPorLista = {} }) {
  const gNome = {};
  for (const g of grupos) gNome[g.CodGrupo] = String(g.d || '').trim();
  const porLista = {};
  for (const r of itens) {
    const n = +r.n || 0;
    if (!n) continue;
    const L = porLista[r.lista] || (porLista[r.lista] = { total: 0, grupos: {} });
    L.total += n;
    L.grupos[r.cg] = (L.grupos[r.cg] || 0) + n;
  }
  const out = [];
  for (const l of listas) {
    const L = porLista[l.nReg];
    if (!L || !L.total) continue;
    out.push({ id: l.nReg, nome: String(l.nome || '').trim(), fornecedor: String(l.fornecedor || '').trim(), codFornec: l.CodFornec || 0,
               comprador: compradorPorLista[l.nReg] || null, total: L.total, grupos: L.grupos });
  }
  out.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const gTot = {};
  for (const l of out) for (const [cg, n] of Object.entries(l.grupos)) {
    const G = gTot[cg] || (gTot[cg] = { cg: +cg, nome: gNome[cg] || ('GRUPO ' + cg), rotulo: rotulo(+cg, gNome[cg]), total: 0, listas: 0, porComprador: {} });
    G.total += n; G.listas++;
    G.porComprador[l.comprador || ''] = (G.porComprador[l.comprador || ''] || 0) + n;
  }
  const gruposOut = Object.values(gTot).map(G => {
    const e = Object.entries(G.porComprador).filter(([c]) => c).sort((a, b) => b[1] - a[1]);
    const [c, n] = e[0] || [null, 0];
    return { ...G, dominante: c, pctDominante: G.total ? Math.round(n / G.total * 100) : 0 };
  }).sort((a, b) => b.total - a.total);
  const compradores = [...new Set(out.map(l => l.comprador).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return { listas: out, grupos: gruposOut, compradores };
}

// Relação de EXEMPLO: cada grupo vai pra comprador(a) que já compra a maior parte dele hoje
// (pelo menos minPct% dos itens do grupo e o grupo com pelo menos minItens itens nas listas).
function relacaoExemplo(base, { minPct = 40, minItens = 20 } = {}) {
  const por = {};
  for (const g of base.grupos) {
    if (!g.dominante || g.total < minItens || g.pctDominante < minPct) continue;
    (por[g.dominante] = por[g.dominante] || []).push(g.cg);
  }
  return Object.entries(por).map(([comprador, grupos]) => ({ comprador, grupos })).sort((a, b) => a.comprador.localeCompare(b.comprador, 'pt-BR'));
}

// Normaliza a relação vinda do navegador: nome em maiúsculas, grupos numéricos, cada grupo com uma dona só.
function limparRelacao(relacao) {
  const vistos = new Set();
  return (Array.isArray(relacao) ? relacao : []).map(r => ({
    comprador: String(r?.comprador || '').trim().toUpperCase(),
    grupos: [...new Set((Array.isArray(r?.grupos) ? r.grupos : []).map(Number).filter(cg => cg > 0 && !vistos.has(cg) && vistos.add(cg)))],
  })).filter(r => r.comprador);
}

// Simula a divisão. Pra cada comprador(a) da relação: as listas onde existe item dos grupos dela.
//   situacao 'dela'    — a lista já é dela hoje
//            'migrar'  — a lista inteira passaria pra ela (>= pctInteira % dos itens são dos grupos dela)
//            'dividir' — só a parte dos grupos dela vira uma lista nova ("NOME · BEBIDAS")
// E, por lista, a quebra: quantos itens iriam pra cada comprador(a) e quantos ficam sem dona na relação.
function dividir(base, relacaoBruta, { pctInteira = 60 } = {}) {
  const relacao = limparRelacao(relacaoBruta);
  const gInfo = {};
  for (const g of base.grupos) gInfo[g.cg] = g;
  const dono = {};
  for (const r of relacao) for (const cg of r.grupos) dono[cg] = r.comprador;
  const rot = cg => gInfo[cg]?.rotulo || ('GRUPO ' + cg);

  const porComprador = relacao.map(r => {
    const setG = new Set(r.grupos);
    const listas = [];
    for (const l of base.listas) {
      let itensGrupo = 0; const det = [];
      for (const cg of setG) { const n = l.grupos[cg]; if (n) { itensGrupo += n; det.push({ cg, rotulo: rot(cg), n }); } }
      if (!itensGrupo) continue;
      det.sort((a, b) => b.n - a.n);
      const pct = Math.round(itensGrupo / l.total * 100);
      const situacao = l.comprador === r.comprador ? 'dela' : pct >= pctInteira ? 'migrar' : 'dividir';
      const nomeNovo = situacao === 'dividir' ? l.nome + ' · ' + det.slice(0, 2).map(d => d.rotulo).join('/') : l.nome;
      listas.push({ id: l.id, nome: l.nome, fornecedor: l.fornecedor, compradorHoje: l.comprador, itensGrupo, total: l.total, pct, situacao, nomeNovo, grupos: det });
    }
    listas.sort((a, b) => b.itensGrupo - a.itensGrupo || a.nome.localeCompare(b.nome, 'pt-BR'));
    const n = s => listas.filter(l => l.situacao === s).length;
    return {
      comprador: r.comprador,
      grupos: r.grupos.map(cg => ({ cg, nome: gInfo[cg]?.nome || ('GRUPO ' + cg), rotulo: rot(cg), total: gInfo[cg]?.total || 0 })),
      listasHoje: base.listas.filter(l => l.comprador === r.comprador).length,
      listas, dela: n('dela'), migrar: n('migrar'), dividir: n('dividir'),
      itens: listas.reduce((s, l) => s + l.itensGrupo, 0),
    };
  });

  const porLista = base.listas.map(l => {
    const partes = {}; let semDono = 0;
    for (const [cg, n] of Object.entries(l.grupos)) {
      const c = dono[cg];
      if (!c) { semDono += n; continue; }
      const P = partes[c] || (partes[c] = { comprador: c, itens: 0, grupos: [] });
      P.itens += n; P.grupos.push({ cg: +cg, rotulo: rot(+cg), n });
    }
    const arr = Object.values(partes).map(p => {
      p.grupos.sort((a, b) => b.n - a.n);
      const pct = Math.round(p.itens / l.total * 100);
      return { ...p, pct, nomeNovo: pct >= pctInteira ? l.nome : l.nome + ' · ' + p.grupos.slice(0, 2).map(g => g.rotulo).join('/') };
    }).sort((a, b) => b.itens - a.itens);
    return { id: l.id, nome: l.nome, fornecedor: l.fornecedor, comprador: l.comprador, total: l.total, partes: arr, semDono,
             muda: arr.some(p => p.comprador !== l.comprador) };
  });

  return {
    relacao, porComprador, porLista,
    resumo: {
      compradoras: porComprador.length, gruposCobertos: Object.keys(dono).length, gruposTotal: base.grupos.length,
      listasQueMudam: porLista.filter(l => l.muda).length, listasTotal: porLista.length,
      itensSemDono: porLista.reduce((s, l) => s + l.semDono, 0),
      listasNovas: porComprador.reduce((s, c) => s + c.migrar + c.dividir, 0),
    },
  };
}

// CSV (separador ;) da visão por comprador(a) — abre direto no Excel em pt-BR
function csv(resultado) {
  const esc = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const SIT = { dela: 'Já é dela', migrar: 'Migra a lista inteira', dividir: 'Só a parte do grupo (lista nova)' };
  const linhas = [['Comprador(a)', 'Grupos da comprador(a)', 'Nº lista', 'Lista (nome sugerido)', 'Fornecedor', 'Comprador(a) hoje', 'Itens do grupo', 'Itens da lista', '%', 'Situação'].join(';')];
  for (const c of resultado.porComprador) for (const l of c.listas)
    linhas.push([c.comprador, c.grupos.map(g => g.rotulo).join(' / '), l.id, l.nomeNovo, l.fornecedor, l.compradorHoje || '', l.itensGrupo, l.total, l.pct, SIT[l.situacao]].map(esc).join(';'));
  return '﻿' + linhas.join('\r\n');
}

module.exports = { montarBase, relacaoExemplo, limparRelacao, dividir, csv, rotulo, ROTULO_CURTO };
