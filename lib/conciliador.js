// Motor de conciliação bancária: casa as saídas do extrato (ver extrato-parser.js)
// com os títulos do ERP (loja20045.contasapagar).
//
// Nota: a tabela contasapagarbaixa parou de ser usada em 2020 (dados só até
// 22/09/2020) — não serve mais pra saber quando um título foi pago. O sistema
// atual só zera o campo Devedor ao dar baixa, sem registrar data de pagamento.
// Por isso o cruzamento usa Valor exato + DataVencto próxima da data do
// extrato (tolerância abaixo) — na prática o pagamento costuma cair em cima
// ou poucos dias após o vencimento.
//
// O campo Devedor do título casado decide o status final:
//   Devedor = 0   → já baixado no sistema, tudo consistente ("conciliado")
//   Devedor > 0   → saiu do banco mas o sistema ainda mostra em aberto
//                   ("pago_sem_baixa" — o achado mais importante da tela,
//                   normalmente esquecimento de dar baixa no ERP)

const TOLERANCIA_DIAS = 5;
const CATEGORIAS_FORNECEDOR = ['boleto_pago', 'pix_enviado'];

// Tolerância de valor pra achar título "parecido" quando não existe título com
// valor idêntico — cobre casos de boleto pago com juros/multa/taxa (mesma
// faixa de tolerância usada na busca manual "Buscar títulos próximos").
const TOLERANCIA_VALOR = 15;

function normalizarNome(str) {
  return (str || '')
    .toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similaridadeNome(a, b) {
  const na = normalizarNome(a), nb = normalizarNome(b);
  if (!na || !nb) return 0;
  const tokensA = new Set(na.split(' ').filter(t => t.length > 2));
  const tokensB = new Set(nb.split(' ').filter(t => t.length > 2));
  if (!tokensA.size || !tokensB.size) return 0;
  let comuns = 0;
  tokensA.forEach(t => { if (tokensB.has(t)) comuns++; });
  return comuns / Math.min(tokensA.size, tokensB.size);
}

function diffDias(dataA, dataB) {
  const ms = Math.abs(new Date(dataA) - new Date(dataB));
  return Math.round(ms / 86400000);
}

function addDias(dataStr, dias) {
  const d = new Date(dataStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function montarMatch(c, saidaData, favorecido, saidaValor) {
  const dias = diffDias(saidaData, c.DataVencto);
  const sim = similaridadeNome(favorecido, c.NomeCompleto || c.Nome);
  const confianca = Math.round(Math.min(99, 60 + sim * 30 + (dias === 0 ? 9 : dias <= 2 ? 5 : 0)));
  return {
    nReg: c.nReg,
    fornecedor: c.NomeCompleto || c.Nome || '(sem cadastro)',
    codFornec: c.CodFornec,
    valor: Number(c.Valor),
    devedor: Number(c.Devedor),
    dataVencto: c.DataVencto,
    historico: c.Historico,
    filial: c.Filial,
    planoGrupo: c.PlanoGrupo,
    planoSub: c.PlanoSub,
    planoGrupoNome: c.planoGrupoNome,
    planoSubNome: c.planoSubNome,
    diffDias: dias,
    similaridade: +sim.toFixed(2),
    // >0: extrato pagou a mais que o título do ERP (ex: taxa/juros de boleto).
    diferencaValor: saidaValor != null ? +(saidaValor - Number(c.Valor)).toFixed(2) : 0,
    // Composição do valor já lançada no próprio ERP (não é inferência nossa).
    acrescimo: Number(c.Acrescimo) || 0,
    multa: Number(c.Multa) || 0,
    juros: Number(c.Juros) || 0,
    desconto: Number(c.Desconto) || 0,
    devolucao: Number(c.Devolucao) || 0,
    valorBruto: c.ValorBruto != null ? Number(c.ValorBruto) : null,
    confianca
  };
}

function statusFinal(c) {
  return Number(c.Devedor) > 0 ? 'pago_sem_baixa' : 'conciliado';
}

// saidas: retorno de parseSaidas(). candidatos: linhas de
// contasapagar + fornecedor (ver server.js), sem filtro de Devedor.
function conciliar(saidas, candidatos) {
  const porValor = new Map();
  for (const c of candidatos) {
    const key = Number(c.Valor).toFixed(2);
    if (!porValor.has(key)) porValor.set(key, []);
    porValor.get(key).push(c);
  }

  const usados = new Set();

  return saidas.map(saida => {
    if (!CATEGORIAS_FORNECEDOR.includes(saida.categoria)) {
      return { ...saida, status: 'fora_escopo', match: null, candidatos: [] };
    }

    const key = saida.valor.toFixed(2);
    const pool = (porValor.get(key) || []).filter(c => !usados.has(c.nReg));
    const dentroTolerancia = pool.filter(c => diffDias(saida.data, c.DataVencto) <= TOLERANCIA_DIAS);

    if (!dentroTolerancia.length) {
      const divergente = acharDivergenciaValor(saida, candidatos, usados);
      if (divergente) {
        usados.add(divergente.nReg);
        return { ...saida, status: 'divergencia', match: montarMatch(divergente, saida.data, saida.favorecido, saida.valor), candidatos: [] };
      }
      return { ...saida, status: 'nao_encontrado', match: null, candidatos: [] };
    }

    const pontuados = dentroTolerancia
      .map(c => ({ c, score: similaridadeNome(saida.favorecido, c.NomeCompleto || c.Nome) * 2 - diffDias(saida.data, c.DataVencto) * 0.1 }))
      .sort((a, b) => b.score - a.score);

    if (pontuados.length === 1) {
      const c = pontuados[0].c;
      usados.add(c.nReg);
      return { ...saida, status: statusFinal(c), match: montarMatch(c, saida.data, saida.favorecido, saida.valor), candidatos: [] };
    }

    const [melhor, segundo] = pontuados;
    if (melhor.score > 0 && melhor.score - segundo.score >= 0.5) {
      usados.add(melhor.c.nReg);
      return { ...saida, status: statusFinal(melhor.c), match: montarMatch(melhor.c, saida.data, saida.favorecido, saida.valor), candidatos: [] };
    }

    return {
      ...saida,
      status: 'revisar',
      match: null,
      candidatos: pontuados.map(p => montarMatch(p.c, saida.data, saida.favorecido, saida.valor))
    };
  });
}

// Quando não existe título com valor idêntico, procura um título "parecido"
// (mesmo fornecedor, vencimento próximo, valor dentro de TOLERANCIA_VALOR) —
// cobre boleto pago com juros/multa/taxa lançada a mais no banco. Só assume
// o match automaticamente quando o nome do favorecido bate razoavelmente E
// não há ambiguidade (senão isso vira "revisar" de qualquer jeito, tratado
// fora desta função).
function acharDivergenciaValor(saida, candidatos, usados) {
  const pontuados = candidatos
    .filter(c => !usados.has(c.nReg))
    .map(c => ({
      c,
      dias: diffDias(saida.data, c.DataVencto),
      delta: Math.abs(saida.valor - Number(c.Valor)),
      sim: similaridadeNome(saida.favorecido, c.NomeCompleto || c.Nome)
    }))
    .filter(x => x.dias <= TOLERANCIA_DIAS && x.delta > 0 && x.delta <= TOLERANCIA_VALOR && x.sim > 0.5)
    .map(x => ({ ...x, score: x.sim * 2 - x.dias * 0.1 - x.delta * 0.05 }))
    .sort((a, b) => b.score - a.score);

  if (!pontuados.length) return null;
  if (pontuados.length > 1 && pontuados[0].score - pontuados[1].score < 0.3) return null;
  return pontuados[0].c;
}

// Chave estável pra correlacionar uma saída do extrato com uma conciliação
// avulsa salva — como o extrato não tem ID único de transação (TXT não tem
// FITID), usamos data+valor+histórico, que se repete igual a cada
// reprocessamento do mesmo extrato.
function chaveSaida(s) {
  return `${s.data}|${Number(s.valor).toFixed(2)}|${s.historico}`;
}

// Aplica as conciliações avulsas (matches manuais confirmados pelo usuário,
// ex: boleto pago com juros/multa que não bate o valor exato) por cima do
// resultado do conciliar(). Roda depois, então tem prioridade sobre
// "revisar"/"não encontrado"/"pago sem baixa" automáticos.
function aplicarAvulsos(itens, avulsos) {
  if (!avulsos || !avulsos.length) return itens;
  const porChave = new Map(avulsos.map(a => [a.chave, a]));
  return itens.map(it => {
    const av = porChave.get(chaveSaida(it));
    if (!av) return it;
    return {
      ...it,
      status: 'conciliado_avulso',
      match: {
        nReg: av.nReg,
        fornecedor: av.fornecedor,
        codFornec: av.codFornec,
        valor: av.valorErp,
        dataVencto: av.dataVencto,
        historico: av.historicoErp,
        filial: av.filial,
        planoGrupo: av.planoGrupo,
        planoSub: av.planoSub,
        planoGrupoNome: av.planoGrupoNome,
        planoSubNome: av.planoSubNome,
        justificativa: av.justificativa,
        confirmadoEm: av.confirmadoEm,
        confirmadoPor: av.confirmadoPor
      },
      candidatos: []
    };
  });
}

module.exports = { conciliar, normalizarNome, similaridadeNome, addDias, TOLERANCIA_DIAS, chaveSaida, aplicarAvulsos };