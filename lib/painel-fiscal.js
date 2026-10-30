'use strict';
// lib/painel-fiscal.js — TV do setor Fiscal (Tiago, 30/10/2026: "tenho uma tv no setor fiscal e quero colocar um painel
// lá… só loja E1 a E6, CD não precisa… se tiver uma reconferência a tela aparece do nada piscando com alerta sonoro,
// depois retorna pro slide que estava").
//
// A TV mostra a FILA DE TRABALHO do fiscal (o que está parado esperando ação, há quanto tempo, quanto vale), não resultado:
//   1 Reconferência (fixa na rotação enquanto houver) · 2 Divergências pra decidir · 3 Pronto pra liberar ·
//   4 Quadro por loja · 5 NF-e sem conferência · 6 A caminho / atrasados.
// 30/10: todas as listas saem por loja na TV (até 300 por lista, sem corte por página) e sem valor na tela.
// Os dados vêm direto das mesmas funções da tela Fiscal (lib/fiscal.js, lib/fiscal-pedidos.js) — sem HTTP interno,
// sem escopo de usuário (a TV vê E1..E6) — e reaproveitam o cache "velho mas na hora" do bruto do ERP.
//   · conferências de HOJE: a cada 60 s (mesma chave de cache da tela Fiscal com todas as lojas);
//   · conferências dos últimos DIAS_ATRAS dias (reconferência/exceção que ficou pra trás): a cada 5 min.
// O alerta de reconferência NOVA é decidido na TV (painel-fiscal.html guarda as que já tocaram); aqui só vai o
// `desde` de cada uma: a hora da decisão "reconferir" do fiscal ou, se veio do ERP/coletor, a 1ª vez que o painel viu.
const LOJAS = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão' };
const LOJAS_OK = [1, 2, 3, 4, 5, 6];
const CICLO_MS = 60 * 1000;
const SEMANA_MS = 5 * 60 * 1000;
const DIAS_ATRAS = 7;
// NF-e sem conferência: com 0-1 dia é quase sempre mercadoria ainda a caminho (dado de 30/10: 133 das 240). Na TV só
// entra a partir de 2 dias — ou lançada no ERP sem conferência, em qualquer idade.
const SEMCONF_MIN_DIAS = 2;

let deps = {}, cache = null, montando = null, timer = null, semana = { em: 0, lista: [] };
const vistoReconf = new Map();   // nReg → ISO da 1ª vez que apareceu em reconferência (status do ERP não tem hora)
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hoje = () => isoLocal(new Date());
const addDias = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
const hm = h => (String(h || '').match(/^\d{1,2}:\d{2}/) || [''])[0];
async function tenta(nome, fn) { try { return await fn(); } catch (e) { console.error(`[PAINEL-FISCAL] ${nome}:`, e.message); return null; } }

function init(d) {
  deps = d || {};
  clearInterval(timer);
  timer = setInterval(() => montar().catch(e => console.error('[PAINEL-FISCAL] renovar:', e.message)), CICLO_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => montar().catch(e => console.error('[PAINEL-FISCAL] 1ª carga:', e.message)), 75 * 1000);   // depois do aquecimento geral
}

// conferência da tela Fiscal → linha enxuta da TV
function linha(r, h) {
  const notas = (r.notas || []).map(n => n.nNota).filter(Boolean);
  const entradaHora = r.entrada ? `${r.entrada}T${hm(r.hora_entrada) || '00:00'}:00` : null;
  return {
    nReg: r.nReg, loja: r.loja, lojaNome: LOJAS[r.loja] || ('Loja ' + r.loja), fornecedor: String(r.fornecedor || '').trim(), notas,
    valor: r2(r.valor_xml || r.valor_lancado), entrada: r.entrada || null, horaEntrada: hm(r.hora_entrada) || null, entradaHora,
    dias: r.entrada ? Math.max(0, diasEntre(r.entrada, h)) : 0, situacao: r.situacao, erros: r.erros || 0, itensFlag: r.itens_com_flag || 0,
    operador: r.operador_loja && r.operador_loja !== '0' ? String(r.operador_loja).trim() : null,
    motivos: [...new Set((r.excecoes || []).map(x => x.msg))].slice(0, 3),
    excecoes: (r.excecoes || []).length,
    pendFiscal: r.pedido_app && r.pedido_app.quem_decide === 'fiscal' ? (r.pedido_app.pendentes || []).length : 0,
    pendCompradora: r.pedido_app && r.pedido_app.quem_decide !== 'fiscal' ? (r.pedido_app.pendentes || []).length : 0,
    comprador: r.pedido_app ? r.pedido_app.comprador || null : null,
    decisao: r.decisao ? { acao: r.decisao.acao, por: r.decisao.por || null, em: r.decisao.em || null, obs: r.decisao.obs || '' } : null,
    liberacao: r.liberacao || null,
  };
}

async function conferencias() {
  const h = hoje();
  const doDia = await deps.fiscal.listar({ de: h, ate: h, loja: null });
  if (!semana.lista.length || Date.now() - semana.em > SEMANA_MS) {
    const s = await tenta('semana', () => deps.fiscal.listar({ de: addDias(h, -DIAS_ATRAS), ate: addDias(h, -1), loja: null }));
    if (s && !s.erro_erp) semana = { em: Date.now(), lista: s.recebimentos || [] };
  }
  const porReg = new Map();
  for (const r of semana.lista) porReg.set(r.nReg, r);
  for (const r of doDia.recebimentos || []) porReg.set(r.nReg, r);   // o de hoje manda
  const todas = [...porReg.values()].filter(r => !r.teste && LOJAS_OK.includes(+r.loja));
  return { todas, erroErp: doDia.erro_erp || null };
}

function montarPayload(conf, semConf, aReceber) {
  const h = hoje(); const agora = new Date().toISOString();
  const L = conf.todas.map(r => linha(r, h));
  // reconferência: desde quando (decisão do fiscal tem hora; status do ERP/coletor não → 1ª vez que o painel viu)
  const reconf = L.filter(x => x.situacao === 'reconferir').map(x => {
    let desde = x.decisao && x.decisao.acao === 'reconferir' ? x.decisao.em : null;
    if (!vistoReconf.has(x.nReg)) vistoReconf.set(x.nReg, desde || agora);
    desde = desde || vistoReconf.get(x.nReg);
    return { ...x, desde, minutos: Math.max(0, Math.round((Date.now() - new Date(desde).getTime()) / 60000)), chaveAlerta: x.nReg + '|' + (x.decisao && x.decisao.acao === 'reconferir' ? x.decisao.em : 'erp') };
  }).sort((a, b) => String(a.entradaHora).localeCompare(String(b.entradaHora)));
  for (const k of [...vistoReconf.keys()]) if (!reconf.some(x => x.nReg === k)) vistoReconf.delete(k);   // saiu da reconferência
  const excecao = L.filter(x => x.situacao === 'excecao' || (x.pendFiscal > 0 && !['liberado', 'cancelado', 'reconferir'].includes(x.situacao)))
    .sort((a, b) => (b.dias - a.dias) || (b.valor - a.valor));
  const pronto = L.filter(x => ['pronto', 'conferido'].includes(x.situacao) && !x.pendFiscal && !x.pendCompradora)
    .sort((a, b) => String(a.entradaHora).localeCompare(String(b.entradaHora)));
  semConf = (semConf || []).filter(n => LOJAS_OK.includes(+n.loja) && !n.interna && (n.dias >= SEMCONF_MIN_DIAS || n.lancada));
  // chegaram na loja e estão no coletor (1ª tela da volta, Tiago 30/10: a TV segue o caminho da nota) — a mais antiga primeiro
  const recebendo = L.filter(x => ['aguardando_coletor', 'em_contagem'].includes(x.situacao))
    .sort((a, b) => String(a.entradaHora).localeCompare(String(b.entradaHora)));
  const quadro = LOJAS_OK.map(l => {
    const m = L.filter(x => x.loja === l);
    const c = s => m.filter(x => x.situacao === s).length;
    return { loja: l, nome: LOJAS[l], aguardandoColetor: c('aguardando_coletor'), emContagem: c('em_contagem'), excecao: excecao.filter(x => x.loja === l).length,
      reconferir: c('reconferir'), pronto: pronto.filter(x => x.loja === l).length, bloqueado: c('bloqueado'),
      liberadoHoje: m.filter(x => x.situacao === 'liberado' && (x.liberacao === h || (x.decisao && x.decisao.acao === 'liberado' && String(x.decisao.em).slice(0, 10) === h))).length,
      semConf: (semConf || []).filter(n => n.loja === l).length };
  });
  const sc = semConf.map(n => ({ loja: n.loja, lojaNome: LOJAS[n.loja], nNota: n.nNota, emitente: String(n.emitente || '').trim(), emissao: n.emissao, dias: n.dias, valor: r2(n.valor), lancada: !!n.lancada }));
  const pr = (aReceber || []).filter(p => LOJAS_OK.includes(+p.loja));
  const caminho = pr.filter(p => p.situacao === 'nota_emitida').map(p => ({ pedido: p.pedido, loja: p.loja, lojaNome: LOJAS[p.loja], fornecedor: p.fornecedor, prevista: p.entrega_prevista, atraso: p.atraso || 0, valor: r2(p.valor), itens: p.itens, sub: p.situacao_sub || '', notas: ((p.xml_loja && p.xml_loja.notas) || []).map(n => n.nNota).filter(Boolean), emissao: ((p.xml_loja && p.xml_loja.notas) || [])[0]?.data || null, cotacao: !!p.cotacao, comprador: p.comprador || null }));
  const atrasados = pr.filter(p => p.situacao === 'aguardando_nota' && p.atraso > 0).map(p => ({ pedido: p.pedido, loja: p.loja, lojaNome: LOJAS[p.loja], fornecedor: p.fornecedor, prevista: p.entrega_prevista, atraso: p.atraso, valor: r2(p.valor), itens: p.itens, cotacao: !!p.cotacao, comprador: p.comprador || null }))
    .sort((a, b) => b.atraso - a.atraso || b.valor - a.valor);
  const decidirPedidos = pr.filter(p => p.quem_decide === 'fiscal' && (p.pendentes > 0 || p.situacao === 'bipada_sem_xml')).length;
  return {
    geradoEm: agora, hoje: h, lojas: LOJAS, erroErp: conf.erroErp,
    resumo: { reconferir: reconf.length, excecao: excecao.length, pronto: pronto.length, semConf: sc.length, semConfValor: r2(sc.reduce((a, n) => a + n.valor, 0)),
      caminho: caminho.length, atrasados: atrasados.length, liberadoHoje: quadro.reduce((a, q) => a + q.liberadoHoje, 0), decidirPedidos,
      aguardandoColetor: quadro.reduce((a, q) => a + q.aguardandoColetor, 0), emContagem: quadro.reduce((a, q) => a + q.emContagem, 0) },
    recebendo: recebendo.slice(0, 300), reconferir: reconf, excecao: excecao.slice(0, 300), pronto: pronto.slice(0, 300), quadro,
    semConf: sc.slice(0, 300), caminho: caminho.sort((a, b) => b.atraso - a.atraso || String(a.prevista).localeCompare(String(b.prevista))).slice(0, 300), atrasados: atrasados.slice(0, 300),
  };
}

async function montar() {
  if (montando) return montando;
  montando = (async () => {
    const t0 = Date.now(); const h = hoje();
    const [conf, semConf, aReceber] = await Promise.all([
      conferencias(),
      tenta('sem-conferencia', () => deps.fiscal.semConferencia({ de: h, ate: h, loja: null })),
      tenta('pedidos-a-receber', () => deps.fiscalPedidos.pedidosAReceber(() => deps.pedidosFornec.listar(), deps.pedidosFornec.totaisLoja, { lojas: LOJAS_OK })),
    ]);
    const novo = montarPayload(conf, semConf, aReceber);
    novo.duracaoMs = Date.now() - t0;
    // tela sem dado novo mantém o que tinha (ERP lento num minuto não apaga a lista)
    if (cache && semConf == null) { novo.semConf = cache.semConf; novo.resumo.semConf = cache.resumo.semConf; novo.resumo.semConfValor = cache.resumo.semConfValor; novo.semConfVelho = true; }
    if (cache && aReceber == null) { for (const k of ['caminho', 'atrasados']) novo[k] = cache[k]; novo.resumo.caminho = cache.resumo.caminho; novo.resumo.atrasados = cache.resumo.atrasados; novo.pedidosVelho = true; }
    cache = novo;
    return cache;
  })().finally(() => { montando = null; });
  return montando;
}
async function dados() {
  if (cache) { if (Date.now() - new Date(cache.geradoEm).getTime() > CICLO_MS * 3) montar().catch(() => {}); return cache; }
  return montar();
}
function estado() { return { cache: !!cache, geradoEm: cache ? cache.geradoEm : null, montando: !!montando, duracaoMs: cache ? cache.duracaoMs : null }; }

module.exports = { init, dados, montar, estado, LOJAS };
