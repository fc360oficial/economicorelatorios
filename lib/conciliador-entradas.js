// Motor de conciliação de entradas: casa entradas do extrato (categorias
// pix_recebido/deposito_boleto — ver lib/extrato-parser.js) com faturas de
// crediário/B2B do ERP (cargaaux.fatura / cargaaux.faturabaixa). Cartão
// débito/crédito NÃO passa por aqui — o ERP não tem lançamento diário por
// forma de pagamento nessa instalação (confirmado via COUNT(*) real em
// cartaomaquineta/cartaolancamento/zcupompagto, todas vazias), então vira
// uma conferência agregada mensal calculada em server.js. Ver design em
// docs/superpowers/specs/2026-09-03-conciliacao-entradas-design.md.

const { similaridadeNome, addDias, TOLERANCIA_DIAS } = require('./conciliador');

const CATEGORIAS_RECEBIVEL = ['pix_recebido', 'deposito_boleto'];

// Tolerância de valor pra achar fatura "parecida" quando não existe uma com
// valor idêntico — cobre desconto de antecipação ou juros/multa que mudam
// o valor recebido em relação ao título original. Mesmo valor usado na
// Conciliação de Saídas (lib/conciliador.js).
const TOLERANCIA_VALOR = 15;

function diffDias(dataA, dataB) {
  const ms = Math.abs(new Date(dataA) - new Date(dataB));
  return Math.round(ms / 86400000);
}

// Fatura já baixada usa o valor de referência da baixa (pode ter desconto),
// fatura em aberto usa o valor do título.
function valorReferencia(c) {
  return c.DataPagto && c.ValorPago != null ? Number(c.ValorPago) : Number(c.Valor);
}

function montarMatch(c) {
  return {
    nFatura: c.nFatura,
    cliente: c.NomeCliente || c.Empresa || '(sem cadastro)',
    codCliente: c.CodCliente,
    valor: Number(c.Valor),
    emAberto: Number(c.EmAberto),
    dataVenda: c.DataVenda,
    dataVencto: c.DataVencto,
    baixado: !!c.DataPagto,
    dataPagto: c.DataPagto || null,
    valorPago: c.ValorPago != null ? Number(c.ValorPago) : null
  };
}

// DataPagto presente (existe baixa em cargaaux.faturabaixa) -> conciliado,
// a menos que ainda sobre EmAberto > 0 (baixa parcial — cliente pagou em
// parcelas e a última baixa dá DataPagto, mas o título não está quitado de
// verdade) -> revisar. Sem baixa nenhuma (só título em aberto) -> baixa_pendente
// (o cliente pode já ter pago — é isso que o depósito no banco está
// confirmando — mas ninguém deu baixa no título ainda, mesmo espírito de
// baixa_pendente na Conciliação de Saídas). Tolerância de 0.01 evita marcar
// ruído de arredondamento de float como saldo real.
function statusFinal(c) {
  if (!c.DataPagto) return 'baixa_pendente';
  return Number(c.EmAberto) > 0.01 ? 'revisar' : 'conciliado';
}

// Monta o {status, match, candidatos} de um candidato já decidido (via valor
// exato ou via acharDivergenciaValor). Quando statusFinal aponta 'revisar'
// (baixa parcial), reaproveita o mesmo formato usado no caso de ambiguidade
// entre candidatos (match: null, candidatos: [...]) — o frontend já sabe
// renderizar isso, não precisa de nenhuma mudança pra esse caso.
function resultadoParaCandidato(c) {
  const status = statusFinal(c);
  if (status === 'revisar') {
    return { status: 'revisar', match: null, candidatos: [montarMatch(c)] };
  }
  return { status, match: montarMatch(c), candidatos: [] };
}

// Quando não existe fatura com valor de referência idêntico, procura uma
// "parecida" (mesmo cliente, vencimento próximo, valor dentro de
// TOLERANCIA_VALOR). Só assume automaticamente quando o nome do cliente bate
// razoavelmente E não há ambiguidade — mesmo princípio de
// acharDivergenciaValor em lib/conciliador.js.
function acharDivergenciaValor(entrada, candidatos, usados) {
  const pontuados = candidatos
    .filter(c => !usados.has(c.nFatura))
    .map(c => ({
      c,
      dias: diffDias(entrada.data, c.DataVencto),
      delta: Math.abs(entrada.valor - valorReferencia(c)),
      sim: similaridadeNome(entrada.favorecido, c.NomeCliente || c.Empresa)
    }))
    .filter(x => x.dias <= TOLERANCIA_DIAS && x.delta > 0 && x.delta <= TOLERANCIA_VALOR && x.sim > 0.5)
    .map(x => ({ ...x, score: x.sim * 2 - x.dias * 0.1 - x.delta * 0.05 }))
    .sort((a, b) => b.score - a.score);

  if (!pontuados.length) return null;
  if (pontuados.length > 1 && pontuados[0].score - pontuados[1].score < 0.3) return null;
  return pontuados[0].c;
}

// entradas: retorno de parseEntradas()/parseEntradasApi(). candidatos: linhas
// de cargaaux.fatura + cliente + faturabaixa (ver buscarCandidatosFatura em
// server.js), sem filtro de EmAberto/baixa — a decisão de status acontece
// aqui, olhando pra ambos os casos (baixada ou não) no mesmo pool.
function conciliarEntradas(entradas, candidatos) {
  const porValor = new Map();
  for (const c of candidatos) {
    const key = valorReferencia(c).toFixed(2);
    if (!porValor.has(key)) porValor.set(key, []);
    porValor.get(key).push(c);
  }

  const usados = new Set();

  return entradas.map(entrada => {
    if (entrada.categoria === 'cartao') {
      return { ...entrada, status: 'cartao', match: null, candidatos: [] };
    }
    if (!CATEGORIAS_RECEBIVEL.includes(entrada.categoria)) {
      return { ...entrada, status: 'fora_escopo', match: null, candidatos: [] };
    }

    const key = entrada.valor.toFixed(2);
    const pool = (porValor.get(key) || []).filter(c => !usados.has(c.nFatura));
    const dentroTolerancia = pool.filter(c => diffDias(entrada.data, c.DataVencto) <= TOLERANCIA_DIAS);

    if (!dentroTolerancia.length) {
      const divergente = acharDivergenciaValor(entrada, candidatos, usados);
      if (divergente) {
        usados.add(divergente.nFatura);
        return { ...entrada, ...resultadoParaCandidato(divergente) };
      }
      return { ...entrada, status: 'nao_encontrado', match: null, candidatos: [] };
    }

    const pontuados = dentroTolerancia
      .map(c => ({ c, score: similaridadeNome(entrada.favorecido, c.NomeCliente || c.Empresa) * 2 - diffDias(entrada.data, c.DataVencto) * 0.1 }))
      .sort((a, b) => b.score - a.score);

    if (pontuados.length === 1) {
      const c = pontuados[0].c;
      usados.add(c.nFatura);
      return { ...entrada, ...resultadoParaCandidato(c) };
    }

    const [melhor, segundo] = pontuados;
    if (melhor.score > 0 && melhor.score - segundo.score >= 0.5) {
      usados.add(melhor.c.nFatura);
      return { ...entrada, ...resultadoParaCandidato(melhor.c) };
    }

    return {
      ...entrada,
      status: 'revisar',
      match: null,
      candidatos: pontuados.map(p => montarMatch(p.c))
    };
  });
}

module.exports = { conciliarEntradas, TOLERANCIA_VALOR };
