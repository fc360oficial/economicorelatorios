'use strict';
// Formação de Preço → Carga de Itens do Dlinks. Monta, a partir de um registro fechado
// (lib/precificacao.js, status "precificado"), os passos de escrita no formato que o Dlinks usa
// quando alguém altera preço na tela de precificação dele (mapeado no MySQL de teste, 24/09/26,
// item 7898416970245 alterado pela LENI em 17/09 16:50):
//   - central.itens: P{loja} (varejo) e a{loja} (atacado) em texto com vírgula ("8,49"),
//     NomeAlteracao e DataHoraAlteracao ("17/09/2026 16:50:36");
//   - central.logpreco2: 1 linha por item e loja (PrecoAnt/PrecoNovo, atacado, custo, Nome "F:<quem>",
//     Motivo, origem). É esse rastro que o "Receber Carga" da loja lê pra montar a fila de etiquetas.
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
 * montarPassosCarga({ r, usuario, agora, cadastro }) → { passos, itens, motivo } pra escreverERP.lote.
 * Lança se o registro não está fechado ou não tem item que mude de preço.
 * `cadastro` (opcional): mapa cod → linha de central.itens (Descricao, Abreviacao, ST, UnVenda,
 * codsetor, CodSubSetor, CodMarca, Peso, TipoBalanca). Quando presente, além do preço em
 * central.itens + rastro em logpreco2, cada item ganha 1 INSERT na fila supermercado.cargapreco —
 * é ela que a tela "Carga de Itens > Cargas Pendentes" do Dlinks lê pra loja puxar a carga
 * (mapeado em 06/10/26 na produção .252, só leitura: 174 linhas de exemplo).
 */
function montarPassosCarga({ r, usuario, agora = new Date(), cadastro = null }) {
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
    const valores = { NomeAlteracao: corta(quem, 45), DataHoraAlteracao: `${dh.br} ${dh.hora}` };
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
    const cad = cadastro && cadastro[i.cod];
    if (cad) passos.push({ banco: 'supermercado', tabela: 'cargapreco', operacao: 'insert', valores: {
      // formato copiado das linhas reais da produção (06/10/26): StatusPendente=1 = aba
      // "Cargas Pendentes"; Tipo 1 = aumento, 0 = redução (legenda azul/vermelha da tela);
      // WhatsApp fica 0 no teste pra não disparar divulgação. nReg é auto_increment.
      nMv: Number(r.pedidoId) || 0, codigobarra: i.cod, descricao: i.descricao,
      abreviacao: corta(cad.Abreviacao || i.descricao, 45), st: corta(cad.ST ?? '0', 45),
      preco: (i.varejo ? i.preco_novo : i.preco_atual).toFixed(2), preco2: (i.atacado ? i.atacado_novo : 0).toFixed(2),
      apartir: '0', unvenda: String(cad.UnVenda || 'UN').slice(0, 45), codsetor: Number(cad.codsetor) || 0,
      ncarga: 0, peso: Number(cad.Peso) || 0, precoanterior: (Number(i.preco_atual) || 0).toFixed(2),
      TipoBalanca: String(cad.TipoBalanca || 'U').slice(0, 45), Tipo: i.varejo && i.preco_novo < i.preco_atual ? 0 : 1,
      Oferta: 0, Marca: 0, Custo: (Number(i.custo) || 0).toFixed(2),
      CodSubSetor: Number(cad.CodSubSetor) || 0, CodMarca: Number(cad.CodMarca) || 0, AlqTributos: '0', Lote: 0,
      StatusPendente: 1, DataRecto: dh.iso, DataFechamento: '2021-01-01', HoraRecto: dh.hora.slice(0, 5), HoraFechamento: '0',
      Etiq: 0, Promocao: 0, WhatsApp: 0, usuario: corta(quem, 25),
    } });
  }
  return { passos, itens, motivo };
}

module.exports = { montarPassosCarga, itensParaCarga, virg, ORIGEM };
