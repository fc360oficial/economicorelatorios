// Sugestão de "Validade (dias)" pro cadastro do ERP — Análise Lista de Compras › Sem Validade (Tiago, 18/11/2026:
// "essas validades aqui não poderia ter sugestões?"). SOMENTE LEITURA: nada é gravado no ERP, a tela só mostra o número
// e de onde ele veio pra quem for preencher o cadastro.
//
// Duas fontes, nesta ordem (medido em 18/11 contra os 7.856 itens de lista que JÁ têm validade, tirando o próprio item
// da conta — "se ele estivesse vazio, a regra acertaria o que está cadastrado?"):
//   1. Produtos parecidos que já têm validade no cadastro:
//        mesma FAMÍLIA  (3+ irmãos, 60 %+ com o mesmo número) → acertou 99 %  → confiança alta
//        mesmo SUBGRUPO (3+ irmãos, 60 %+ com o mesmo número) → acertou 79 %  → alta se 80 %+ concordam, senão média
//   2. O que o coletor leu nas entradas do próprio produto (validade lida − data da entrada = quantos dias de validade
//      ele tinha ao CHEGAR): mediana das entradas, arredondada pra baixo pro número de cadastro mais próximo.
//      É piso, não a validade de fábrica (o produto já chega com parte dela gasta) → confiança média (3+ entradas) ou baixa.
//   3. Mesmo GRUPO (5+ irmãos, 60 %+) → confiança baixa.
// Conferência cruzada: se os parecidos dizem N dias mas o produto, em 3+ entradas, quase nunca chegou com metade disso,
// vale o coletor (com N o coletor bloquearia a entrada dele: recebimento.js compara a validade lida com Validar × %).
//
// Os números sugeridos são os que a casa já usa no cadastro (180, 365, 90, 25, 120, 60, 30, 15, 45, 20...).

const GRADE = [7, 10, 12, 15, 20, 25, 30, 45, 60, 90, 120, 180, 270, 365];
const MIN_IRMAOS = 3, MIN_IRMAOS_GRUPO = 5, CONSENSO = 0.6, CONSENSO_ALTO = 0.8, MIN_ENTRADAS = 3;

// maior número da grade que não passa de d; abaixo de 7 dias fica o próprio número (mínimo 2 — 1 é o "vazio" do ERP)
function naGrade(d) {
  d = Math.floor(+d || 0); if (d < 2) return null;
  let r = null; for (const g of GRADE) if (g <= d) r = g;
  return r || d;
}
function moda(arr) {
  if (!arr || !arr.length) return null;
  const f = new Map(); for (const v of arr) f.set(v, (f.get(v) || 0) + 1);
  let melhor = null; for (const [v, n] of f) if (!melhor || n > melhor.n || (n === melhor.n && v < melhor.v)) melhor = { v, n };
  return { v: melhor.v, n: melhor.n, t: arr.length, pct: melhor.n / arr.length };
}
const chaveFamilia = s => { const t = String(s == null ? '' : s).trim().toUpperCase(); return t && t !== '0' ? t : null; };
const chaveNum = v => { const n = parseInt(v, 10); return n > 0 ? n : null; };

// linhas = produtos ATIVOS com validade de cadastro > 1: { validar, familia, subgrupo, grupo }
function montarReferencia(linhas) {
  const ref = { familia: new Map(), subgrupo: new Map(), grupo: new Map(), total: 0 };
  const poe = (m, k, v) => { if (k == null) return; const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const r of linhas || []) {
    const v = parseInt(r.validar, 10); if (!(v > 1)) continue;
    ref.total++;
    poe(ref.familia, chaveFamilia(r.familia), v); poe(ref.subgrupo, chaveNum(r.subgrupo), v); poe(ref.grupo, chaveNum(r.grupo), v);
  }
  return ref;
}

// hist = { entradas, p25, p50, p75, ultima } do próprio produto (dias de validade ao chegar), ou null
function evidenciaColetor(hist) {
  if (!hist || !(+hist.entradas > 0) || !(+hist.p50 > 0)) return null;
  return { entradas: +hist.entradas, tipico: +hist.p50, de: +hist.p25 || +hist.p50, ate: +hist.p75 || +hist.p50, ultima: hist.ultima || null };
}

// item = { familia, subgrupo, grupo, balanca }; nomes = { subgrupo: {cod: nome}, grupo: {cod: nome} } (opcional, só pro texto)
// Produto de balança (perecível) que herdaria mais de 60 dias dos parecidos cai pra confiança baixa com aviso: no cadastro
// de hoje há fruta com 180 dias (número genérico), e a regra dos parecidos repetiria o erro.
const BALANCA_MAX = 60;
function sugerir(item, ref, hist, nomes) {
  const s = calcular(item, ref, hist, nomes);
  if (s && s.dias && item && item.balanca && s.fonte !== 'coletor' && s.dias > BALANCA_MAX) {
    s.confianca = 'baixa'; s.aviso = 'Produto de balança: confira antes de usar — os parecidos podem estar com validade genérica';
  }
  return s;
}
function calcular(item, ref, hist, nomes) {
  const col = evidenciaColetor(hist);
  const out = (dias, fonte, confianca, base, extra) => ({ dias, fonte, confianca, base, coletor: col, ...(extra || {}) });
  const nome = (tipo, cod) => { const n = nomes && nomes[tipo] && nomes[tipo][cod]; return n ? '"' + n + '"' : '#' + cod; };
  const irmaos = (m, k, min) => { if (k == null) return null; const md = moda(m.get(k)); return md && md.t >= min && md.pct >= CONSENSO ? md : null; };
  const frase = (onde, md) => `${onde}: ${md.n} de ${md.t} produtos com ${md.v} dias`;

  let s = null;
  const kf = chaveFamilia(item.familia), ks = chaveNum(item.subgrupo), kg = chaveNum(item.grupo);
  const mf = ref ? irmaos(ref.familia, kf, MIN_IRMAOS) : null;
  const ms = !mf && ref ? irmaos(ref.subgrupo, ks, MIN_IRMAOS) : null;
  if (mf) s = out(mf.v, 'familia', 'alta', frase('Família "' + kf + '"', mf));
  else if (ms) s = out(ms.v, 'subgrupo', ms.pct >= CONSENSO_ALTO ? 'alta' : 'media', frase('Subgrupo ' + nome('subgrupo', ks), ms));

  const colDias = col ? naGrade(col.tipico) : null;
  const colBase = col ? `Coletor: em ${col.entradas} entrada${col.entradas > 1 ? 's' : ''} chegou com ${col.tipico} dias de validade (mediana)` : null;
  // parecidos dizem N, mas o produto quase nunca chegou nem com metade de N → vale o que o coletor leu
  if (s && col && col.entradas >= MIN_ENTRADAS && colDias && col.ate < s.dias * 0.5)
    return out(colDias, 'coletor', 'media', colBase + ` — os parecidos usam ${s.dias} dias, mas este chega com bem menos`, { divergente: s.dias });
  if (s) return s;
  if (col && colDias) return out(colDias, 'coletor', col.entradas >= MIN_ENTRADAS ? 'media' : 'baixa', colBase);
  const mg = ref ? irmaos(ref.grupo, kg, MIN_IRMAOS_GRUPO) : null;
  if (mg) return out(mg.v, 'grupo', 'baixa', frase('Grupo ' + nome('grupo', kg), mg));
  return col ? { dias: null, fonte: null, confianca: null, base: null, coletor: col } : null;
}

module.exports = { GRADE, naGrade, moda, montarReferencia, evidenciaColetor, sugerir };
