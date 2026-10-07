'use strict';
// Formação de Preço → Carga de Itens do Dlinks. Monta, a partir de um registro fechado
// (lib/precificacao.js, status "precificado"), os passos de escrita no formato que o Dlinks usa
// quando alguém altera preço na tela de precificação dele (mapeado no MySQL de teste, 24/09/26,
// item 7898416970245 alterado pela LENI em 17/09 16:50):
//   - central.itens: P{loja} (varejo) e a{loja} (atacado) em texto com vírgula ("8,49"),
//     L{loja} = 0 (flag "loja tem alteração pendente"), NomeAlteracao e DataHoraAlteracao
//     ("17/09/2026 16:50:36");
//   - central.logpreco2: 1 linha por item e loja (PrecoAnt/PrecoNovo, atacado, custo, Nome "F:<quem>",
//     Motivo, origem) — só rastro/histórico.
// Como a carga chega na loja (verificado em 07/10/26 nos executáveis do Dlinks, CargaPDV.exe e
// Formacao.exe/Produto.exe): a tela de preço da central grava `UPDATE central.itens SET pN=..., lN='0'`;
// o "Receber Carga" da loja N roda `SELECT ... pN, aN FROM central.itens WHERE lN = 0`, copia pra
// `supermercado.recebidoscentral` LOCAL dela, monta `supermercado.carga` + `supermercado.cargapreco`
// no banco LOCAL da loja e marca `lN = 1` na central. Cada loja tem o próprio banco `supermercado`;
// o do .252 (e da cópia .254) é o da LOJA 10 (CD). Por isso NUNCA gravar em supermercado.cargapreco
// daqui: isso enfileira na loja 10, e só a flag L{loja} = 0 faz as lojas 1..6 puxarem.
// Puro: sem banco. Só roda no MySQL de TESTE (.254) via escreverERP.lote. Nunca no .252.

const ORIGEM = 'FLUXO';
// corte por BYTE: coluna latin1 recebe os bytes UTF-8 (acento = 2) — ver lib/log-erp.js
const corta = require('./log-erp').cortaBytes;
const virg = v => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ',');
const p2 = n => String(n).padStart(2, '0');
function dataHora(d) {
  return { iso: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, br: `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`, hora: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` };
}
const difere = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) >= 0.005;

/** Itens do registro que vão pra carga: varejo que sobe/desce, ou atacado (L4) que mudou. */
function itensParaCarga(r) {
  const out = [];
  for (const i of r.itens || []) {
    if (i.status === 'bloqueado') continue;
    const varejo = (i.status === 'sobe' || i.status === 'desce') && i.preco_final > 0 && difere(i.preco_final, i.preco_atual);
    const atacado = !!(i.atacado && i.atacado.preco_final > 0 && difere(i.atacado.preco_final, i.preco_atacado_atual));
    if (!varejo && !atacado) continue;
    out.push({ cod: String(i.cod), descricao: corta(i.descricao, 45), varejo, atacado,
      preco_atual: Number(i.preco_atual) || 0, preco_novo: Number(i.preco_final) || 0,
      atacado_atual: Number(i.preco_atacado_atual) || 0, atacado_novo: i.atacado ? Number(i.atacado.preco_final) || 0 : 0,
      custo: Number(i.custo_novo) || 0 });
  }
  return out;
}

/**
 * montarPassosCarga({ r, usuario, agora }) → { passos, itens, motivo } pra escreverERP.lote.
 * Lança se o registro não está fechado ou não tem item que mude de preço.
 * Por item: UPDATE central.itens (P{loja}/a{loja} + L{loja} = 0) e INSERT central.logpreco2.
 * A fila supermercado.cargapreco é montada pelo próprio Dlinks quando a loja clica "Receber Carga".
 */
function montarPassosCarga({ r, usuario, agora = new Date() }) {
  if (!r || r.status !== 'precificado') throw new Error('só lista fechada (precificado) vai pra carga');
  const ln = Number(r.loja);
  if (!(ln >= 1 && ln <= 10)) throw new Error('loja inválida: ' + r.loja);
  const itens = itensParaCarga(r);
  if (!itens.length) throw new Error(`lista ${r.id}: nenhum item muda de preço`);
  const quem = String(usuario || 'ECONOMICO').trim().toUpperCase();
  const dh = dataHora(agora);
  const motivo = corta(`Formação de Preço #${r.pedidoId} loja ${ln} (${r.lista_nome || r.fornecedor || ''}) → Carga de Itens, ERP teste`, 200);
  const passos = [];
  for (const i of itens) {
    // L{loja} = 0 é o que faz o "Receber Carga" da loja puxar o item (Dlinks grava `lN ='0'`)
    const valores = { [`L${ln}`]: 0, NomeAlteracao: corta(quem, 45), DataHoraAlteracao: `${dh.br} ${dh.hora}` };
    if (i.varejo) valores[`P${ln}`] = virg(i.preco_novo);
    if (i.atacado) valores[`a${ln}`] = virg(i.atacado_novo);
    passos.push({ tabela: 'itens', operacao: 'update', where: { CodigoBarra: i.cod }, valores });
    passos.push({ tabela: 'logpreco2', operacao: 'insert', valores: {
      nLoja: ln, Data: dh.iso, Hora: dh.hora, CodGrupo: 0, CodSub: 0, CodMarca: 0, CodigoBarras: i.cod.slice(0, 15),
      PrecoAnt: virg(i.preco_atual), PrecoNovo: virg(i.varejo ? i.preco_novo : i.preco_atual),
      Nome: corta('F:' + quem, 30), Descricao: i.descricao,
      PrecoSite: '0.00', PrecoAtacadoAnt: virg(i.atacado_atual), PrecoAtacadoNovo: virg(i.atacado ? i.atacado_novo : i.atacado_atual),
      QtdMult: '0', custo: virg(i.custo), Backup: 0, Motivo: motivo, origem: ORIGEM,
    } });
  }
  return { passos, itens, motivo };
}

module.exports = { montarPassosCarga, itensParaCarga, virg, ORIGEM };
