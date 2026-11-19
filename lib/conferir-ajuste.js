// Conferência, SÓ LEITURA, do que uma ordem de ajuste de estoque do Conector (os negativos) deixou no ERP (19/11/26, Tiago,
// primeira loja gravada em produção: "alguns ajustou no ficha e outros não, por quê?"). Pra cada produto da ordem:
//   · o saldo de agora da loja            central.estoquen{loja}.Qtd
//   · o registro do ajuste                central.estoque_ajuste (do dia, com o usuário e a observação da ordem)
//   · a linha da Ficha                    fichaproduto.ficha (nRegDoc = nReg do ajuste)
// Produto que já estava com o saldo igual ao contado não gera movimento: nem ajuste nem Ficha, e isso é o certo.
// A Ficha tem dezenas de milhões de linhas: antes de consultar, confere o plano (EXPLAIN); sem índice, não consulta.
'use strict';

const codOk = c => typeof c === 'string' && /^[0-9A-Za-z]{1,20}$/.test(c);
const num = v => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const MAX_ITENS = 400, MAX_FICHA = 80;

/** q(sql, params) → linhas (conexão de leitura do ERP em que a ordem gravou) · ordem = ordem completa do Conector. */
async function conferir({ q, ordem }) {
  if (!ordem || ordem.tipo !== 'ajuste_estoque') throw new Error('Só ordem de ajuste de estoque tem conferência no ERP');
  const d = ordem.dados || {}, ln = +d.loja; if (!(Number.isInteger(ln) && ln >= 1 && ln <= 10)) throw new Error('loja inválida na ordem');
  const m = /^(\d{4})(\d{2})(\d{2})-/.exec(String(ordem.id || '')); if (!m) throw new Error('ordem sem data');
  const data = m[1] + '-' + m[2] + '-' + m[3];   // o dia em que o servidor do Conector gravou (DataLan / DataLancamento)
  const itens = (d.itens || []).filter(i => codOk(i.codigo)).slice(0, MAX_ITENS), cods = itens.map(i => i.codigo);
  if (!cods.length) throw new Error('ordem sem itens');
  const ph = cods.map(() => '?').join(','), usuario = String(d.usuario_dlinks || 'CONECTOR'), desfeita = ordem.status === 'desfeita';
  const antesDe = {}; for (const a of ((ordem.resultado || {}).antes || [])) antesDe[a.codigo] = num(a.qtd);
  const naoGravado = {}; for (const n of ((ordem.resultado || {}).nao_gravados || [])) naoGravado[n.codigo] = n.motivo;

  const saldos = await q('SELECT CodigoBarra, Qtd FROM central.estoquen' + ln + ' WHERE CodigoBarra IN (' + ph + ')', cods);
  const saldoDe = {}; for (const r of saldos) saldoDe[String(r.CodigoBarra).trim()] = num(r.Qtd);
  const ajustes = await q('SELECT nReg, CodigoBarras, Tipo, Qtd, Estoque_Anterior, Estoque_Final, Usuario, CodMotivo, Obs FROM central.estoque_ajuste WHERE nLoja = ? AND DataLan = ? AND CodigoBarras IN (' + ph + ') ORDER BY nReg', [ln, data, ...cods]);
  const ajustesDe = {}; for (const r of ajustes) (ajustesDe[String(r.CodigoBarras).trim()] = ajustesDe[String(r.CodigoBarras).trim()] || []).push(r);

  // Ficha: só com índice (plano conferido uma vez), e no máximo MAX_FICHA produtos por conferência
  const SQL_FICHA = 'SELECT CodigoBarras, Tipo, Qtd, SaldoAnterior, SaldoAtual, Origem, nRegDoc, Hora FROM fichaproduto.ficha WHERE nLoja = ? AND CodigoBarras = ? AND DataLancamento = ?';
  let fichaPode = false, fichaMotivo = null;
  try { const plano = await q('EXPLAIN ' + SQL_FICHA, [ln, cods[0], data]); const p = plano[0] || {}; fichaPode = !!p.key && (num(p.rows) || 0) < 500000; if (!fichaPode) fichaMotivo = 'a consulta da Ficha ficaria pesada no ERP (sem índice): não foi feita'; }
  catch (e) { fichaMotivo = 'não consegui ler a Ficha: ' + (e.sqlMessage || e.message); }
  const fichaDe = {}; let fichaConferidos = 0;
  if (fichaPode) for (const c of cods.slice(0, MAX_FICHA)) { fichaDe[c] = await q(SQL_FICHA, [ln, c, data]); fichaConferidos++; }

  const linhas = itens.map(i => {
    const c = i.codigo, contado = num(i.qtd), antes = c in antesDe ? antesDe[c] : null, saldoAgora = c in saldoDe ? saldoDe[c] : null;
    const moveu = antes != null && contado != null && Math.abs(contado - antes) > 0.0005;
    // o ajuste desta ordem: mesmo usuário e saldo final = contado (o mais novo, se a loja foi gravada mais de uma vez no dia)
    const meus = (ajustesDe[c] || []).filter(a => String(a.Usuario || '').trim() === usuario && num(a.Estoque_Final) === contado && (antes == null || num(a.Estoque_Anterior) === antes));
    const aj = meus.length ? meus[meus.length - 1] : null;
    const fichas = fichaDe[c]; const fi = aj && fichas ? fichas.find(f => +f.nRegDoc === +aj.nReg && /^AJUSTE ESTOQUE/i.test(String(f.Origem || ''))) || null : null;
    let situacao, texto;
    if (naoGravado[c]) { situacao = 'nao_gravado'; texto = 'não foi gravado: ' + naoGravado[c]; }
    else if (!moveu) { situacao = 'sem_movimento'; texto = 'o saldo já era igual ao contado: não gera ajuste nem linha na Ficha'; }
    else if (!aj) { situacao = 'sem_ajuste'; texto = 'não achei o registro do ajuste no ERP'; }
    else if (fichas && !fi) { situacao = 'sem_ficha'; texto = 'tem o registro do ajuste (nº ' + aj.nReg + '), mas não achei a linha na Ficha'; }
    else if (!fichas) { situacao = 'ficha_nao_conferida'; texto = 'registro do ajuste nº ' + aj.nReg + ' ok · Ficha não conferida'; }
    else { situacao = 'ok'; texto = 'registro do ajuste nº ' + aj.nReg + ' e linha na Ficha ok'; }
    // saldo de agora diferente do contado não é erro do ajuste: é movimento posterior (venda, entrada, outro ajuste, desfazer)
    const saldoMudou = saldoAgora != null && contado != null && Math.abs(saldoAgora - contado) > 0.0005;
    return { codigo: c, descricao: i.descricao || '', antes, contado, saldoAgora, saldoMudou, situacao, texto,
      ajuste: aj ? { nReg: aj.nReg, tipo: +aj.Tipo === 1 ? 'entrada' : 'saída', qtd: num(aj.Qtd), anterior: num(aj.Estoque_Anterior), final: num(aj.Estoque_Final), usuario: String(aj.Usuario || '').trim(), motivo: aj.CodMotivo, obs: String(aj.Obs || '').trim() } : null,
      ficha: fi ? { tipo: fi.Tipo, qtd: num(fi.Qtd), anterior: num(fi.SaldoAnterior), atual: num(fi.SaldoAtual), hora: String(fi.Hora || ''), origem: String(fi.Origem || '') } : null,
      // tudo o que a Ficha tem desse produto no dia (pra ver venda ou outro movimento depois do ajuste)
      fichaDoDia: fichas ? fichas.map(f => ({ tipo: f.Tipo, qtd: num(f.Qtd), anterior: num(f.SaldoAnterior), atual: num(f.SaldoAtual), hora: String(f.Hora || ''), origem: String(f.Origem || '').trim(), doc: f.nRegDoc })) : null };
  });
  const conta = s => linhas.filter(l => l.situacao === s).length;
  return { ordem: ordem.id, loja: ln, data, desfeita, itens: linhas.length, ok: conta('ok'), semMovimento: conta('sem_movimento'), semAjuste: conta('sem_ajuste'), semFicha: conta('sem_ficha'), naoGravados: conta('nao_gravado'),
    fichaConferidos, fichaMotivo, saldoMudou: linhas.filter(l => l.saldoMudou).length, linhas };
}

module.exports = { conferir };
