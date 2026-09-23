'use strict';
// Aprovação do ajuste de negativos: grava a quantidade CONTADA de cada item na tabela de
// estoque da loja (central.estoquen{N}) no MySQL de TESTE (.254), item por item, via escreverERP.
// Puro: recebe `escrever` injetado. Spec: docs/superpowers/specs/2026-09-23-negativos-aprovar-ajuste-design.md

const dataBr = d => String(d || '').split('-').reverse().join('/');

/** Separa os itens de uma loja (saída de visaoCentral) em "gravar" (com contagem), "semContagem" e "desmarcados" (excluídos na tela). */
function itensParaGravar(linhas, somenteCods = null, excluir = null) {
  const so = somenteCods ? new Set(somenteCods.map(String)) : null;
  const ex = new Set((excluir || []).map(String));
  const gravar = [], semContagem = [], desmarcados = [];
  for (const x of linhas || []) {
    if (x.contado === null || x.contado === undefined) { semContagem.push({ cod: x.cod, desc: x.desc, sys: x.sys }); continue; }
    if (so && !so.has(String(x.cod))) continue;
    if (ex.has(String(x.cod))) { desmarcados.push({ cod: x.cod, desc: x.desc, sys: x.sys, contado: x.contado }); continue; }
    gravar.push({ cod: String(x.cod), desc: x.desc, sys: x.sys, contado: Number(x.contado), novo: String(Math.trunc(Number(x.contado))) });
  }
  return { gravar, semContagem, desmarcados };
}

function motivoAjuste(data, ln, nomeLoja) {
  return `Ajuste de negativos — contagem ${dataBr(data)}, loja ${ln} (${nomeLoja})`;
}

/** Grava em série. Erro num item não interrompe o lote. */
async function aprovarLoja({ escrever, itens, usuario, data, ln, nomeLoja, aoProgredir }) {
  const motivo = motivoAjuste(data, ln, nomeLoja);
  const tabela = 'estoquen' + Number(ln);
  const ids = [], erros = [];
  let n = 0;
  for (const it of itens) {
    let r;
    try {
      r = await escrever({ usuario, motivo, banco: 'central', tabela, operacao: 'update', where: { CodigoBarra: it.cod }, valores: { Qtd: it.novo } });
    } catch (e) { r = { ok: false, status: 'erro', erro: e.message, id: null }; }
    if (r.ok) ids.push(r.id); else erros.push({ cod: it.cod, desc: it.desc, erro: r.erro || r.status, id: r.id });
    n++; if (aoProgredir) aoProgredir(n, itens.length);
  }
  return { gravados: ids.length, erros, ids, motivo, tabela };
}

module.exports = { itensParaGravar, motivoAjuste, aprovarLoja };
