'use strict';
// Aprovação do ajuste de negativos: grava a quantidade CONTADA de cada item no MySQL de TESTE (.254),
// item por item, do MESMO jeito que a tela de ajuste do ERP (e o suporte da Dlinks) faz. Cada item é
// uma transação (escreverERP.lote) com 3 passos:
//   0. INSERT central.estoque_ajuste     → o "log do ajuste" do ERP (quem fez, motivo, saldo antes/depois)
//   1. INSERT fichaproduto.ficha         → a linha que aparece em Estoque › Ficha ("AJUSTE ESTOQUE LOJA N (Do")
//   2. UPDATE central.estoquen{N}.Qtd    → o saldo
// Levantamento de 15-16/10/2026 no ERP real: fichaproduto.ficha corta Origem em 25 letras; nRegDoc da
// ficha = nReg do estoque_ajuste; Tipo 1/E = entrada (saldo sobe), 2/S = saída (saldo cai); Qtd sempre
// positiva; Status/Lote/nItem 0, Fornecedor '0', HoraAtualizacao '0'. Item já igual ao contado só faz o passo 2.
// Puro: recebe `escrever` (com .lote) injetado. Spec: docs/superpowers/specs/2026-09-23-negativos-aprovar-ajuste-design.md

const USUARIO_ERP = 'ECOBOOT';   // nome que fica no log de ajuste do ERP (Tiago, 16/10: "O nome vai ser ECOBOOT")
const MOTIVO_NEGATIVOS = 37;     // central.estoque_ajustes_motivo: 37 = AJUSTE NEGATIVOS (já existe no ERP)

const dataBr = d => String(d || '').split('-').reverse().join('/');
const p2 = n => String(n).padStart(2, '0');
const dataIso = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const horaErp = d => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

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

/** Texto de Origem igual ao do ERP: "AJUSTE ESTOQUE LOJA 4 (Documento 111332)" cortado em 25 letras. */
function origemFicha(ln) {
  return ('AJUSTE ESTOQUE LOJA ' + Number(ln) + ' (Documento)').slice(0, 25);
}

/**
 * Monta os passos do lote de 1 item. `anterior` = saldo atual no .254 (lido antes); `unid` = central.itens.Unid.
 * Retorna { passos, dif } — dif 0 só atualiza o saldo (nada a movimentar na Ficha).
 */
function passosItem({ it, ln, anterior, unid, aprovador, agora }) {
  const novo = Number(it.novo);
  const ant = Number(anterior);
  const dif = novo - ant;
  const update = { tabela: 'estoquen' + Number(ln), operacao: 'update', where: { CodigoBarra: it.cod }, valores: { Qtd: it.novo } };
  if (!dif) return { passos: [update], dif: 0 };
  const hoje = dataIso(agora), hora = horaErp(agora);
  const ajuste = {
    banco: 'central', tabela: 'estoque_ajuste', operacao: 'insert',
    valores: {
      nLoja: Number(ln), Tipo: dif > 0 ? 1 : 2, CodigoBarras: it.cod, Descricao: String(it.desc || '').slice(0, 45),
      Qtd: Math.abs(dif), CodMotivo: MOTIVO_NEGATIVOS, Obs: ('NEGATIVOS - ' + String(aprovador || '').toUpperCase()).slice(0, 45),
      Usuario: USUARIO_ERP, Und: String(unid || 'UN').slice(0, 5), DataLan: hoje, Status: 0,
      Estoque_Anterior: ant, Estoque_Final: novo, Lote: 0,
    },
  };
  const ficha = {
    banco: 'fichaproduto', tabela: 'ficha', operacao: 'insert',
    valores: {
      CodigoBarras: it.cod, SaldoAnterior: ant, Qtd: Math.abs(dif), SaldoAtual: novo,
      DataAtualizacao: hoje, DataLancamento: hoje, Tipo: dif > 0 ? 'E' : 'S', Origem: origemFicha(ln),
      nRegDoc: { $id: 0 }, Hora: hora, nLoja: Number(ln), Lote: 0, Fornecedor: '0', nItem: 0, HoraAtualizacao: '0',
    },
  };
  return { passos: [ajuste, ficha, update], dif };
}

/**
 * Grava em série. Erro num item não interrompe o lote.
 * `atual`: { cod: { qtd, unid } } lido do .254 logo antes (saldo real no momento); sem registro usa it.sys.
 */
async function aprovarLoja({ escrever, itens, usuario, data, ln, nomeLoja, atual = {}, agora = () => new Date(), aoProgredir }) {
  const motivo = motivoAjuste(data, ln, nomeLoja);
  const tabela = 'estoquen' + Number(ln);
  const ids = [], erros = [];
  let n = 0, movimentados = 0, semMudanca = 0;
  for (const it of itens) {
    const a = atual[String(it.cod)] || {};
    const anterior = a.qtd !== undefined && a.qtd !== null && a.qtd !== '' ? a.qtd : it.sys;
    const { passos, dif } = passosItem({ it, ln, anterior, unid: a.unid, aprovador: usuario, agora: agora() });
    let r;
    try {
      r = await escrever.lote({ usuario, motivo, banco: 'central', passos });
    } catch (e) { r = { ok: false, status: 'erro', erro: e.message, id: null }; }
    if (r.ok) { ids.push(r.id); if (dif) movimentados++; else semMudanca++; }
    else erros.push({ cod: it.cod, desc: it.desc, erro: r.erro || r.status, id: r.id });
    n++; if (aoProgredir) aoProgredir(n, itens.length);
  }
  return { gravados: ids.length, movimentados, semMudanca, erros, ids, motivo, tabela, usuarioErp: USUARIO_ERP };
}

module.exports = { itensParaGravar, motivoAjuste, origemFicha, passosItem, aprovarLoja, USUARIO_ERP, MOTIVO_NEGATIVOS };
