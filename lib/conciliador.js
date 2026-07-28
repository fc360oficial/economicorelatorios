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

function montarMatch(c, saidaData, favorecido) {
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
    diffDias: dias,
    similaridade: +sim.toFixed(2),
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
      return { ...saida, status: 'nao_encontrado', match: null, candidatos: [] };
    }

    const pontuados = dentroTolerancia
      .map(c => ({ c, score: similaridadeNome(saida.favorecido, c.NomeCompleto || c.Nome) * 2 - diffDias(saida.data, c.DataVencto) * 0.1 }))
      .sort((a, b) => b.score - a.score);

    if (pontuados.length === 1) {
      const c = pontuados[0].c;
      usados.add(c.nReg);
      return { ...saida, status: statusFinal(c), match: montarMatch(c, saida.data, saida.favorecido), candidatos: [] };
    }

    const [melhor, segundo] = pontuados;
    if (melhor.score > 0 && melhor.score - segundo.score >= 0.5) {
      usados.add(melhor.c.nReg);
      return { ...saida, status: statusFinal(melhor.c), match: montarMatch(melhor.c, saida.data, saida.favorecido), candidatos: [] };
    }

    return {
      ...saida,
      status: 'revisar',
      match: null,
      candidatos: pontuados.map(p => montarMatch(p.c, saida.data, saida.favorecido))
    };
  });
}

module.exports = { conciliar, normalizarNome, similaridadeNome, addDias, TOLERANCIA_DIAS };