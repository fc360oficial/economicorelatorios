// CLAUDIA — assistente de voz do Econômico (Tiago, 03/11/2026). SÓ do Econômico: não levar pra base FC360.
// TELA DE TESTE: ainda sem a chave da API da Anthropic, então o "cérebro" aqui entende poucas perguntas por palavra-chave
// (saudação, vendas de ontem, vendas de hoje, uma loja). Quando a chave chegar, responder() passa a chamar o Claude com
// ferramentas (vendas, estoque, ponto, pendências, tarefas) e esta parte vira só o atalho das perguntas mais comuns.
// Números: venda_dia_loja do espelho (lib/espelho-erp.js) e, pra hoje, espelhoErp.hojeErpTotais (ERP ao vivo, só leitura).
const LOJAS = [1, 2, 3, 4, 5, 6];
const NOMES = { 1: 'Socorro', 2: 'Muribeca', 3: 'Ponte', 4: 'Atacarejo', 5: 'Porta Larga', 6: 'Jardim Jordão' };
const APELIDOS = [[/\bsocorro\b|\be ?1\b/, 1], [/\bmuribeca\b|\be ?2\b/, 2], [/\bponte\b|\be ?3\b/, 3], [/\batacarejo\b|\be ?4\b/, 4],
  [/\bporta larga\b|\be ?5\b/, 5], [/\bjardim\b|\bjordao\b|\be ?6\b/, 6]];
const ART = { 1: 'o', 2: 'a', 3: 'a', 4: 'o', 5: 'a', 6: 'o' };   // 'a Porta Larga', 'o Atacarejo'
const loj = n => ART[n] + ' ' + NOMES[n];
const passada = ds => (ds === 'sábado' || ds === 'domingo') ? 'no ' + ds + ' passado' : 'na ' + ds + ' passada';
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

let deps = {};
let cacheHoje = { em: 0, rows: null };

function init(d) { deps = d || {}; }

const semAcento = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function isoLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); }
const diaSemana = iso => DIAS[new Date(iso + 'T12:00:00').getDay()];
const brl = v => 'R$ ' + Math.round(v).toLocaleString('pt-BR');

// Valor falado: "311 mil e 800 reais" soa natural; centavos não interessam na conversa.
function falaReais(v) {
  v = Math.round(v);
  if (v >= 1000000) { const m = (v / 1000000).toFixed(1).replace('.0', '').replace('.', ','); return `${m} milhão${m === '1' ? '' : 'ões'} de reais`.replace('1 milhãoões', '1 milhão'); }
  if (v >= 1000) { const mil = Math.floor(v / 1000); const cent = Math.round((v % 1000) / 100) * 100; return cent && cent < 1000 ? `${mil} mil e ${cent} reais` : `${mil} mil reais`; }
  return `${v} reais`;
}
const falaPct = p => `${Math.abs(Math.round(p))} por cento ${p >= 0 ? 'a mais' : 'a menos'}`;

async function vendasDia(dia) {
  const rows = await deps.pq('SELECT loja, valor, cupons FROM venda_dia_loja WHERE loja = ANY($1) AND dia = $2', [LOJAS, dia]);
  const m = {}; for (const r of rows) m[+r.loja] = { valor: +r.valor || 0, cupons: +r.cupons || 0 };
  return rows.length ? m : null;
}
async function vendasHoje() {
  if (cacheHoje.rows && Date.now() - cacheHoje.em < 5 * 60 * 1000) return cacheHoje.rows;
  const rows = await deps.hojeErpTotais(LOJAS);
  const m = {}; for (const r of rows) m[+r.loja] = { valor: +r.valor || 0, cupons: +r.cupons || 0 };
  cacheHoje = { em: Date.now(), rows: m };
  return m;
}
const total = m => LOJAS.reduce((s, l) => s + (m[l]?.valor || 0), 0);

function tabela(titulo, m, ant, rotuloAnt) {
  const linhas = LOJAS.map(l => ({ loja: `E${l} ${NOMES[l]}`, valor: brl(m[l]?.valor || 0),
    ant: ant ? brl(ant[l]?.valor || 0) : null,
    var: ant && ant[l]?.valor ? Math.round(((m[l]?.valor || 0) / ant[l].valor - 1) * 100) : null }))
    .sort((a, b) => parseFloat(b.valor.replace(/\D/g, '')) - parseFloat(a.valor.replace(/\D/g, '')));
  const t = total(m), ta = ant ? total(ant) : 0;
  return { titulo, rotuloAnt, linhas, total: brl(t), totalAnt: ant ? brl(ta) : null, totalVar: ta ? Math.round((t / ta - 1) * 100) : null };
}

async function respOntem(hoje, loja) {
  const ontem = somaDias(hoje, -1), semana = somaDias(ontem, -7);
  const [m, ant] = await Promise.all([vendasDia(ontem), vendasDia(semana)]);
  if (!m) return { fala: 'Ainda não tenho as vendas de ontem copiadas do ERP. A cópia roda de madrugada; tente de novo mais tarde.' };
  const ds = diaSemana(ontem);
  if (loja) {
    const v = m[loja]?.valor || 0, a = ant?.[loja]?.valor || 0;
    let f = `Ontem, ${ds}, ${loj(loja)} vendeu ${falaReais(v)}`;
    if (a) f += `, ${falaPct((v / a - 1) * 100)} que ${passada(ds)}`;
    return { fala: f + '.', tabela: tabela(`Vendas de ontem (${ds}, ${ontem.split('-').reverse().slice(0, 2).join('/')})`, m, ant, `${ds} anterior`) };
  }
  const t = total(m), ta = ant ? total(ant) : 0;
  const ord = LOJAS.slice().sort((a, b) => (m[b]?.valor || 0) - (m[a]?.valor || 0));
  let f = `Ontem, ${ds}, as seis lojas venderam ${falaReais(t)}`;
  if (ta) f += `, ${falaPct((t / ta - 1) * 100)} que ${passada(ds)}`;
  f += `. A que mais vendeu foi ${loj(ord[0])}, com ${falaReais(m[ord[0]].valor)}. A menor foi ${loj(ord[5])}, com ${falaReais(m[ord[5]]?.valor || 0)}.`;
  return { fala: f, tabela: tabela(`Vendas de ontem (${ds}, ${ontem.split('-').reverse().slice(0, 2).join('/')})`, m, ant, `${ds} anterior`) };
}

async function respHoje(loja) {
  const m = await vendasHoje();
  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (loja) return { fala: `Hoje, até agora, ${loj(loja)} vendeu ${falaReais(m[loja]?.valor || 0)}, em ${m[loja]?.cupons || 0} cupons.`, tabela: tabela(`Vendas de hoje até ${hora}`, m) };
  const ord = LOJAS.slice().sort((a, b) => (m[b]?.valor || 0) - (m[a]?.valor || 0));
  return { fala: `Hoje, até agora, as seis lojas somam ${falaReais(total(m))}. Na frente está ${loj(ord[0])}, com ${falaReais(m[ord[0]]?.valor || 0)}.`,
    tabela: tabela(`Vendas de hoje até ${hora}`, m) };
}

async function responder(texto, user) {
  const t = semAcento(texto);
  const nome = String(user?.nome || '').split(' ')[0] || '';
  const hoje = isoLocal(new Date());
  const h = new Date().getHours();
  const periodo = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  let loja = null; for (const [re, n] of APELIDOS) if (re.test(t)) { loja = n; break; }
  const falaVenda = /vend|faturou|faturamento|fatura|como foi|como (ta|esta)|resultado|numero/.test(t);

  if (/obrigad|valeu/.test(t)) return { fala: `Por nada${nome ? ', ' + nome : ''}! Qualquer coisa é só me chamar.` };
  if (/tchau|ate mais|ate logo/.test(t)) return { fala: `Até mais${nome ? ', ' + nome : ''}! Bom trabalho.` };
  if (/quem (e|eh) voce|seu nome|o que voce faz/.test(t))
    return { fala: 'Eu sou a Cláudia, a assistente do Econômico. Nesta versão de teste eu já falo das vendas das lojas. Depois vou acompanhar o ponto, as pendências dos setores e as tarefas da equipe.' };
  if (/\bhoje\b/.test(t) && (falaVenda || loja)) return respHoje(loja);
  if (/ontem/.test(t) || (falaVenda && !/\bhoje\b/.test(t)) || loja) return respOntem(hoje, loja);
  if (/^(oi|ola|bom dia|boa tarde|boa noite|e ai|opa|fala)\b|claudia/.test(t)) {
    const r = await respOntem(hoje, null).catch(() => null);
    const intro = `${periodo}${nome ? ', ' + nome : ''}! Hoje é ${diaSemana(hoje)}, dia ${+hoje.slice(8)}.`;
    return r && r.tabela ? { fala: `${intro} ${r.fala} Quer saber de alguma loja?`, tabela: r.tabela } : { fala: `${intro} Em que posso ajudar?` };
  }
  return { fala: 'Nesta versão de teste eu ainda só sei falar das vendas: de ontem, de hoje ou de uma loja. Quando a minha inteligência for ligada, vou entender qualquer pergunta.' };
}

module.exports = { init, responder, _falaReais: falaReais };
