// Robô de Precificação — FASE 0 "vigia de margem" (Processos › Robô de Precificação, 04/11/2026, pedido do Tiago).
// Acompanha, por lista de compra do ERP, quanto de margem bruta a lista está deixando no mês, projeta o fim do mês,
// compara com a meta em R$ e aponta onde a margem vaza (preço abaixo do custo, queima parada, cadastro que já não
// entrega a meta, validade perto com estoque, rebaixa pedida pela loja). SÓ LEITURA no ERP: nada aqui escreve preço;
// as fases seguintes (sugerir → gravar no ERP de teste → automático) dependem de OK do Tiago e do Dlinks.
//
// Regras combinadas em 03-04/11/26 (memória project_economico-robo-precificacao):
//   - meta em R$ de margem bruta SOBRE A VENDA (ex.: Capricche+Vitamassa = R$ 32 mil/mês), não em %; piso de % por lista
//   - preço normal e promoção = IGUAL em todas as lojas (regra da loja); queima/rebaixa por validade = POR LOJA (exceção)
//   - validade + estoque obrigatórios: queima sem venda com estoque = voltar preço / conferir baixa
//   - gatilho da rebaixa: data de validade OU pedido da loja (promocaodatacritica do Dlinks / Ajustes de Estoque)
//   - as listas das compradoras (c_cotacao_lista) são só LIDAS; o robô não mexe nelas
//
// Fontes (todas no ERP, via q): c_cotacao_lista / c_cotacao_lista_itens (itens da lista), itens (descrição, P1..P6, desativado),
// itens_margens (margem de cadastro por loja = MARKUP sobre o custo, igual ao ERP e à Formação de Preço: preço alvo = custo × (1 + m);
// corrigido 09/11/26, antes lia como margem s/ venda e inflava o alvo), custoloja{n} (custo atual), estoquen{n} (estoque), itenscoletorvalidade
// (validade por lote/loja — Qtd vem 0, só a data serve), promocaodatacritica (rebaixa pedida, status 1-2),
// ln{n}mes{MM}.zcupomitens (venda, qtd e CUSTO NA VENDA por item; margem realizada = venda − Custo).
// Estado local em data/: robo-precificacao.json (cache do cálculo) e robo-precificacao-params.json (listas vigiadas, metas).
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'robo-precificacao.json');
const PARAMS = path.join(DATA, 'robo-precificacao-params.json');
// 12/11/26 (Tiago: "mudamos, vamos fazer E1 e E2 e completo"): o vigia olha só as lojas-teste. Outra loja entra aqui.
const LOJAS = [1, 2];
const NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };

// Listas vigiadas (Tiago 04-05/11/26): Vitamassa, Capricche, Yoki, Nestlé e Tambaú (as 5 do teste; outras entram pela tela).
// Vitamassa não tem lista própria: os itens estão na lista 404 (Cipan), por isso o filtro por descrição.
// Nestlé tem duas listas do mesmo fornecedor 1826 (376 "LDA SERVICOS..." 262 itens e 552 "NESTLE BRASIL" 30 itens): as duas juntas.
const PARAMS_PADRAO = {
  metaPctPadrao: 30,      // margem s/ venda alvo quando a lista não tem meta em R$ (meta R$ = % × venda projetada)
  pisoPct: 22,            // abaixo disso a lista fica vermelha mesmo batendo a meta em R$
  diasValidade: 21,       // "validade perto" = vence em até N dias, tem estoque e o estoque não acaba antes (no ritmo de venda do mês)
  diasSemVenda: 3,        // queima com estoque e sem venda há N dias = voltar preço / conferir baixa
  quedaQueima: 20,        // preço da loja ≥ N% abaixo do maior preço da rede = considerado queima/rebaixa daquela loja
  minReaisValidade: 15,   // validade/vencido só vira alerta se o que sobra vale pelo menos isso (a custo) — tira o ruído de 2-3 unidades
  todasListas: true,      // 12/11/26: loja completa = todas as listas de compra do ERP (false = só as listas abaixo)
  listas: [
    // meta de exemplo do Tiago (03/11): R$ 32 mil/mês Capricche+Vitamassa juntas; dividido na proporção da venda (~81/19)
    { chave: 'capricche', nome: 'Capricche', ids: [421], metaReais: null },   // era R$ 26 mil fixos das 6 lojas (até 11/11/26)
    { chave: 'vitamassa', nome: 'Vitamassa', ids: [404], filtro: 'VITAMASSA|VITA MASSA', metaReais: null },   // era R$ 6 mil fixos das 6 lojas
    { chave: 'yoki', nome: 'Yoki', ids: [417], metaReais: null },
    { chave: 'nestle', nome: 'Nestlé', ids: [376, 552], metaReais: null },
    { chave: 'tambau', nome: 'Tambaú', ids: [459], metaReais: null },  // 5ª lista (Tiago 05/11/26): fecha as 5 do teste
    // Listas de feijão (Tiago 10/11/26): margem de 20-27%, nunca chegam nos 30% — a meta de 30% é da loja, não da lista.
    { chave: 'pai-heleno', nome: 'Pai Heleno', ids: [310], metaReais: null },
    { chave: 'perola', nome: 'Pérola', ids: [461], metaReais: null },
    { chave: 'oasis', nome: 'Oásis', ids: [309], metaReais: null },
    { chave: 'kicaldo', nome: 'Kicaldo', ids: [313], metaReais: null },
    { chave: 'ta-gostoso', nome: 'Tá Gostoso', ids: [312], metaReais: null },
    // Pernambucana: a lista 311 está no fornecedor antigo; os últimos pedidos vieram com a razão social nova. Tratar como um só por enquanto.
    { chave: 'pernambucana', nome: 'Pernambucana', ids: [311], metaReais: null }
  ]
};

const num = v => { const n = parseFloat(String(v ?? '0').replace(/\./g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
const numDot = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = v => Math.round((+v || 0) * 100) / 100;
const r1 = v => Math.round((+v || 0) * 10) / 10;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoDe = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : iso(v); const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const up = s => String(s || '').trim().toUpperCase();

let deps = null, cache = null, calculando = null, params = null, ultimoErro = null;

function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); }

function mesclarParams(p) {
  const o = JSON.parse(JSON.stringify(PARAMS_PADRAO));
  for (const k of ['metaPctPadrao', 'pisoPct', 'diasValidade', 'diasSemVenda', 'quedaQueima', 'minReaisValidade']) if (p && p[k] != null && isFinite(+p[k])) o[k] = +p[k];
  if (p && Array.isArray(p.listas) && p.listas.length) o.listas = p.listas.map(normLista).filter(Boolean);
  o.todasListas = !(p && p.todasListas === false);
  return o;
}
function normLista(l) {
  if (!l) return null;
  const ids = (Array.isArray(l.ids) ? l.ids : [l.id]).map(x => parseInt(x)).filter(x => x > 0);
  if (!ids.length) return null;
  const nome = String(l.nome || '').trim().slice(0, 60) || ('Lista ' + ids.join('+'));
  const chave = String(l.chave || nome).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || ('l' + ids[0]);
  return { chave, nome, ids, filtro: l.filtro ? String(l.filtro).slice(0, 120) : null, metaReais: l.metaReais > 0 ? r2(l.metaReais) : null, metaPct: l.metaPct > 0 ? +l.metaPct : null };
}

function init(d) {
  deps = d;
  params = mesclarParams(lerJson(PARAMS, {}));
  cache = lerJson(OUT, null);
}
function getParams() { return params; }
function setParams(p) {
  const novo = mesclarParams({ ...params, ...p });
  // chaves repetidas confundem a tela
  const vistas = new Set(); novo.listas = novo.listas.filter(l => { if (vistas.has(l.chave)) return false; vistas.add(l.chave); return true; });
  params = novo; gravarJson(PARAMS, params);
  return params;
}
function resetParams() { params = mesclarParams({}); gravarJson(PARAMS, params); return params; }

// ───────────────────────── cálculo ─────────────────────────
async function calcular() {
  if (calculando) return calculando;
  calculando = (async () => {
    const t0 = Date.now();
    const q = deps.q;
    const hoje = new Date();
    const ano = hoje.getFullYear(), mes = hoje.getMonth() + 1, dia = hoje.getDate();
    const diasMes = new Date(ano, mes, 0).getDate();
    // dias "cheios" decorridos: ontem inteiro + fração de hoje (venda de hoje entra na soma, então a fração conta)
    const diasDecorridos = Math.max(0.25, (dia - 1) + Math.min(1, hoje.getHours() / 22));
    const mm = String(mes).padStart(2, '0');
    const dIni = `${ano}-${mm}-01`, dHoje = iso(hoje);
    const antD = new Date(ano, mes - 2, 1), ant2D = new Date(ano, mes - 3, 1);
    const periodos = [
      { k: 'atual', mes: mm, ini: dIni, fim: dHoje, dias: diasDecorridos },
      { k: 'ant', mes: String(antD.getMonth() + 1).padStart(2, '0'), ini: iso(antD), fim: iso(new Date(ano, mes - 1, 0)), dias: new Date(ano, mes - 1, 0).getDate() },
      { k: 'ant2', mes: String(ant2D.getMonth() + 1).padStart(2, '0'), ini: iso(ant2D), fim: iso(new Date(ano, mes - 2, 0)), dias: new Date(ano, mes - 2, 0).getDate() }
    ];
    const erros = [];

    // 12/11/26 (Tiago: "aqui ainda tá só as listas selecionadas"): o vigia cobre a LOJA COMPLETA nas lojas-teste = todas as
    // listas de compra do ERP + o que vende sem lista, com as regras combinadas em 11/11 (as mesmas de Alertas de Preço,
    // lidas de lá pra ter uma fonte só): carnes/charque/hortifrúti/taxa de entrega FORA; listas de cotação só acompanhadas;
    // preço final 7 (rebaixa) e 8 (promoção da diretoria) não se mexe; alto giro não sobe preço.
    // Pra não pesar no ERP (incidente de 11/11), venda/cadastro/estoque/custo vêm do espelho local (Postgres); do ERP ficam
    // só 5 consultas leves por cálculo (listas, itens das listas, margem de cadastro, validade, rebaixa pedida).
    const pq = deps.pq, regras = (deps.regras && deps.regras()) || {};
    const fora = new Set((regras.gruposFora || [45, 48, 46, 64]).map(Number)), cotacao = new Set((regras.listasCotacao || [277, 218]).map(Number)), topGiro = +regras.topGiro || 0;
    const completo = params.todasListas !== false;
    const LJS = LOJAS.join(',');

    // 1) listas de compra (só leitura das listas das compradoras)
    const nomesListaErp = {};
    for (const r of await q('SELECT nReg, Nome, CodFornec, NomeFornec FROM central.c_cotacao_lista').catch(e => { erros.push('c_cotacao_lista: ' + e.message); return []; }))
      nomesListaErp[+r.nReg] = { nome: String(r.Nome || '').trim(), fornec: r.CodFornec, nomeFornec: String(r.NomeFornec || '').trim() };
    const itensLista = await q('SELECT nCotacao lid, Codigobarra cod FROM central.c_cotacao_lista_itens ORDER BY nCotacao').catch(e => { erros.push('c_cotacao_lista_itens: ' + e.message); return []; });
    if (!itensLista.length) throw new Error('Nenhum item nas listas de compra' + (erros.length ? ' (' + erros.join('; ') + ')' : ''));
    const codsPorId = {}; for (const r of itensLista) (codsPorId[+r.lid] = codsPorId[+r.lid] || new Set()).add(String(r.cod).trim());
    let listasCfg = params.listas;
    if (completo) {
      // as listas com nome próprio (Capricche, Nestlé 376+552...) continuam; recorte por descrição (Vitamassa dentro da Cipan) sai,
      // senão o item contaria duas vezes; todas as outras listas do ERP entram com o nome do ERP
      const fixas = params.listas.filter(l => !l.filtro), usados = new Set(fixas.flatMap(l => l.ids));
      listasCfg = [...fixas, ...Object.keys(codsPorId).map(Number).filter(id => !usados.has(id) && nomesListaErp[id]).sort((a, b) => a - b)
        .map(id => ({ chave: 'l' + id, nome: nomesListaErp[id].nome || ('Lista ' + id), ids: [id], filtro: null, metaReais: null, metaPct: null, auto: true }))];
    }
    const emLista = new Set(listasCfg.flatMap(l => l.ids.flatMap(id => [...(codsPorId[id] || [])])));

    // 2) cadastro (espelho): descrição, grupo, preços por loja, desativado; custo e estoque por loja; do ERP: margem de cadastro, validade, rebaixa
    const cadastro = {};
    for (const r of await pq('SELECT TRIM(codigo) cod, TRIM(descricao) d, codgrupo cg, desativado des, p1, p2, p3, p4, p5, p6 FROM cadastro_item')) cadastro[r.cod] = r;
    const prod = {};
    const P = k => {
      if (prod[k] !== undefined) return prod[k];
      const r = cadastro[k]; if (!r || fora.has(+r.cg) || (!completo && !emLista.has(k))) return (prod[k] = null);
      const p = prod[k] = { cod: k, desc: r.d || '', grupo: +r.cg || 0, desativado: +r.des === 1, preco: {}, margemCad: {}, custo: {}, estoque: {}, validade: {}, venda: {}, ultVenda: {}, rebaixa: [] };
      for (const ln of LOJAS) p.preco[ln] = r2(+r['p' + ln]);
      return p;
    };
    for (const k of emLista) P(k);
    for (const r of await pq('SELECT loja, TRIM(codigo) cod, qtd, custo FROM estoque_loja WHERE loja = ANY($1)', [LOJAS])) {
      const p = P(r.cod); if (p) { p.custo[+r.loja] = r2(+r.custo); p.estoque[+r.loja] = r2(+r.qtd); }
    }
    for (const r of await q(`SELECT CodigoBarra cod, nLoja ln, MargemVarejo m FROM central.itens_margens WHERE nLoja IN (${LJS})`, [], { timeoutMs: 120000 }).catch(e => { erros.push('itens_margens: ' + e.message); return []; })) {
      const p = prod[String(r.cod).trim()]; if (p) p.margemCad[+r.ln] = numDot(r.m);
    }
    // validade por loja (coletor, Qtd vem 0 → só a data serve): a mais próxima ainda não vencida e, se o ÚLTIMO lote
    // registrado já venceu (sem lote novo depois), a data dele. Lote velho com lote novo registrado depois não conta.
    for (const r of await q(`SELECT Codigobarra cod, nLoja ln, Data d, dataEntrada e FROM central.itenscoletorvalidade WHERE nLoja IN (${LJS}) AND Data >= DATE_SUB(CURDATE(), INTERVAL 45 DAY)`, [], { timeoutMs: 120000 }).catch(e => { erros.push('itenscoletorvalidade: ' + e.message); return []; })) {
      const p = prod[String(r.cod).trim()]; if (!p) continue; const d = isoDe(r.d); if (!d) continue;
      const v = p.validade[+r.ln] = p.validade[+r.ln] || { proxima: null, vencida: null, entradaVencida: null, entradaProxima: null };
      const ent = isoDe(r.e) || '';
      if (d >= dHoje) { if (!v.proxima || d < v.proxima) v.proxima = d; if (ent > (v.entradaProxima || '')) v.entradaProxima = ent; }
      else if (!v.vencida || d > v.vencida) { v.vencida = d; if (ent > (v.entradaVencida || '')) v.entradaVencida = ent; }
    }
    // lote vencido só vale se não entrou lote novo depois dele
    for (const p of Object.values(prod)) { if (!p) continue; for (const ln of LOJAS) { const v = p.validade[ln]; if (v && v.vencida && (v.proxima || (v.entradaProxima || '') > (v.entradaVencida || ''))) v.vencida = null; } }
    // rebaixa pedida pela loja no Dlinks (data crítica, status 1-2) nos últimos 30 dias
    for (const r of await q(`SELECT Codigobarra cod, nLoja ln, PrecoAtual de, preco para, Qtd qtd, Validade val, DataLan lan FROM central.promocaodatacritica WHERE status IN (1,2) AND nLoja IN (${LJS}) AND DataLan >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`).catch(e => { erros.push('promocaodatacritica: ' + e.message); return []; })) {
      const p = prod[String(r.cod).trim()]; if (p) p.rebaixa.push({ loja: +r.ln, de: r2(num(r.de)), para: r2(num(r.para)), qtd: r2(numDot(r.qtd)), validade: isoDe(r.val), data: isoDe(r.lan), origem: 'dlinks' });
    }
    // rebaixa pedida pelo gerente no celular (Sem Giro → Ajustes de Estoque), ainda não decidida
    try {
      const pend = deps.ajustesEstoque ? deps.ajustesEstoque.listar({ status: 'pendente' }) : [];
      for (const r of pend) { const p = prod[String(r.cod || '').trim()]; if (p && LOJAS.includes(+r.loja) && r.rebaixaStatus === 'pendente') p.rebaixa.push({ loja: +r.loja, de: r2(r.precoAtual), para: r2(r.precoSugerido), qtd: r2(r.contado), data: isoDe(r.criadoEm), origem: 'gerente' }); }
    } catch (e) { erros.push('ajustes-estoque: ' + e.message); }

    // 3) vendas por período × loja × item (espelho): venda, qtd e custo na venda (cupom gravado sem custo = qtd × custo atual da loja,
    // mesma correção da meta da loja) + última venda (mês atual e anterior)
    for (const per of periodos) {
      const rows = await pq(`SELECT v.loja, TRIM(v.codigo) cod, SUM(v.qtd) qtd, SUM(v.valor) venda,
                                    SUM(CASE WHEN v.custo > 0 THEN v.custo ELSE v.qtd * COALESCE(e.custo, 0) END) custo, to_char(MAX(v.dia), 'YYYY-MM-DD') ult
                             FROM venda_dia_produto v LEFT JOIN estoque_loja e ON e.loja = v.loja AND e.codigo = v.codigo
                             WHERE v.loja = ANY($1) AND v.dia BETWEEN $2 AND $3 GROUP BY 1, 2`, [LOJAS, per.ini, per.fim]);
      for (const r of rows) {
        const p = P(r.cod); if (!p || !(+r.qtd > 0)) continue;
        const v = p.venda[per.k] = p.venda[per.k] || {}; v[+r.loja] = { qtd: +r.qtd || 0, venda: +r.venda || 0, custo: +r.custo || 0 };
        if (per.k !== 'ant2' && r.ult && (!p.ultVenda[+r.loja] || r.ult > p.ultVenda[+r.loja])) p.ultVenda[+r.loja] = r.ult;
      }
    }
    // alto giro (regra de 11/11): os N com mais vendas (nº de cupons-item, 60 dias) de cada loja → não sobe preço, negociar custo
    const giro = {};
    if (topGiro > 0) {
      const d60 = new Date(hoje); d60.setDate(d60.getDate() - 60);
      const rows = await pq('SELECT loja, TRIM(codigo) cod, SUM(itens) n FROM venda_dia_produto WHERE loja = ANY($1) AND dia >= $2 GROUP BY 1, 2', [LOJAS, iso(d60)]);
      for (const ln of LOJAS) giro[ln] = new Set(rows.filter(r => +r.loja === ln && cadastro[r.cod] && !fora.has(+cadastro[r.cod].cg)).sort((a, b) => (+b.n || 0) - (+a.n || 0)).slice(0, topGiro).map(r => r.cod));
    }
    // cada item fica numa lista só (a primeira que o tem); o que vende ou tem estoque sem estar em lista nenhuma vai pra "Sem lista"
    const dono = {}, codsCfg = {};
    for (const cfg of listasCfg) {
      const re = cfg.filtro ? new RegExp(cfg.filtro, 'i') : null, cs = codsCfg[cfg.chave] = [], visto = new Set();
      for (const id of cfg.ids) for (const k of (codsPorId[id] || [])) {
        if (visto.has(k) || (completo && dono[k]) || !prod[k] || (re && !re.test(prod[k].desc))) continue;
        visto.add(k); if (completo) dono[k] = cfg.chave; cs.push(k);
      }
    }
    if (completo) {
      const cs = Object.keys(prod).filter(k => prod[k] && !dono[k] && (Object.keys(prod[k].venda).length || LOJAS.some(ln => prod[k].estoque[ln] > 0)));
      if (cs.length) { listasCfg = [...listasCfg, { chave: 'sem-lista', nome: 'Sem lista de compra', ids: [], filtro: null, metaReais: null, metaPct: null, auto: true, semLista: true }]; codsCfg['sem-lista'] = cs; }
    }

    // 4) por lista: totais, projeção, meta, gap A/B/C, itens, alertas
    const listas = [], alertas = [];
    for (const cfg of listasCfg) {
      const cods = codsCfg[cfg.chave] || [], ehCot = cfg.ids.some(id => cotacao.has(+id));
      const L = { chave: cfg.chave, nome: cfg.nome, ids: cfg.ids, listasErp: cfg.ids.map(id => ({ id, ...(nomesListaErp[id] || { nome: 'lista ' + id }) })), filtro: cfg.filtro || null, cotacao: ehCot, semLista: !!cfg.semLista, auto: !!cfg.auto,
        itens: cods.length, ativos: cods.filter(k => !prod[k].desativado).length, periodos: {}, lojas: {}, gap: null, topCadastro: [], itensTabela: [] };
      for (const per of periodos) {
        const T = { venda: 0, custo: 0, qtd: 0, dias: per.dias, ini: per.ini, fim: per.fim };
        for (const k of cods) for (const ln of LOJAS) { const v = (prod[k].venda[per.k] || {})[ln]; if (!v) continue; T.venda += v.venda; T.custo += v.custo; T.qtd += v.qtd; }
        T.lucro = T.venda - T.custo; T.margem = T.venda > 0 ? T.lucro / T.venda * 100 : null;
        L.periodos[per.k] = { venda: r2(T.venda), custo: r2(T.custo), lucro: r2(T.lucro), margem: T.margem == null ? null : r1(T.margem), qtd: r2(T.qtd), dias: r2(T.dias), ini: T.ini, fim: T.fim };
      }
      const A = L.periodos.atual;
      if (cfg.auto && !(A.venda > 0) && !(L.periodos.ant.venda > 0)) continue;   // lista sem venda em E1/E2 neste mês nem no anterior: fora da tela
      const vendaProj = diasDecorridos > 0 ? A.venda / diasDecorridos * diasMes : 0;
      const lucroProj = diasDecorridos > 0 ? A.lucro / diasDecorridos * diasMes : 0;
      const metaPct = cfg.metaPct || params.metaPctPadrao;
      const metaReais = cfg.metaReais || r2(vendaProj * metaPct / 100);
      const diasRestantes = Math.max(0, diasMes - diasDecorridos);
      const faltaReais = metaReais - A.lucro;                      // o que ainda tem que entrar até o fim do mês
      const vendaRestante = vendaProj - A.venda;                     // venda que ainda vem no ritmo atual
      const margemNecessaria = vendaRestante > 0 ? faltaReais / vendaRestante * 100 : null;   // % s/ venda que o resto do mês precisa ter
      L.meta = { reais: metaReais, origem: cfg.metaReais ? 'fixa' : `${metaPct}% da venda projetada`, pct: metaPct, pisoPct: params.pisoPct,
        lucroProj: r2(lucroProj), vendaProj: r2(vendaProj), diasMes, diasDecorridos: r2(diasDecorridos), diasRestantes: r2(diasRestantes),
        faltaReais: r2(faltaReais), ritmoDia: diasRestantes > 0 ? r2(faltaReais / diasRestantes) : null, ritmoAtualDia: diasDecorridos > 0 ? r2(A.lucro / diasDecorridos) : null,
        margemNecessaria: margemNecessaria == null ? null : r1(margemNecessaria), projetaBater: lucroProj >= metaReais,
        abaixoPiso: A.margem != null && A.margem < params.pisoPct };
      L.status = A.venda <= 0 ? 'sem-venda' : (L.meta.abaixoPiso ? 'piso' : (lucroProj >= metaReais ? 'ok' : (lucroProj >= metaReais * 0.9 ? 'perto' : 'longe')));

      // por loja (mês atual)
      for (const ln of LOJAS) {
        const T = { venda: 0, custo: 0 };
        for (const k of cods) { const v = (prod[k].venda.atual || {})[ln]; if (v) { T.venda += v.venda; T.custo += v.custo; } }
        L.lojas[ln] = { nome: NOMES[ln], venda: r2(T.venda), lucro: r2(T.venda - T.custo), margem: T.venda > 0 ? r1((T.venda - T.custo) / T.venda * 100) : null };
      }

      // gap A/B/C do mês atual (mesma decomposição do gap.js de 03/11): alvo = margem de cadastro do ERP, que é MARKUP s/ custo
      // (lucro alvo = custo × m; preço alvo = custo × (1 + m)). margemCadastro abaixo é esse alvo convertido pra % sobre a venda.
      const G = { alvo: 0, cadAbaixo: 0, vendAbaixo: 0, vendAcima: 0, semMargem: 0 };
      const porItem = {};
      for (const k of cods) {
        const p = prod[k];
        const it = porItem[k] = { cod: k, desc: p.desc, venda: 0, qtd: 0, custo: 0, cadAbaixo: 0, vendAbaixo: 0, det: [] };
        for (const ln of LOJAS) {
          const v = (p.venda.atual || {})[ln]; if (!v || v.qtd <= 0) continue;
          it.venda += v.venda; it.qtd += v.qtd; it.custo += v.custo;
          const m = (p.margemCad[ln] || 0) / 100; if (!(m > 0)) { G.semMargem += v.venda; continue; }   // markup pode passar de 100%
          const custoUnit = v.custo / v.qtd, pcad = p.preco[ln] || 0;
          G.alvo += v.custo * m;
          const pAlvo = custoUnit * (1 + m);
          const lucroAlvo = v.qtd * (pAlvo - custoUnit), lucroCad = v.qtd * (pcad - custoUnit), lucroReal = v.venda - v.custo;
          const cadAbaixo = pcad > 0 ? Math.max(0, lucroAlvo - lucroCad) : 0;
          const vendAbaixo = pcad > 0 ? Math.max(0, lucroCad - lucroReal) : 0;
          G.cadAbaixo += cadAbaixo; G.vendAbaixo += vendAbaixo; G.vendAcima += pcad > 0 ? Math.max(0, lucroReal - lucroCad) : 0;
          it.cadAbaixo += cadAbaixo; it.vendAbaixo += vendAbaixo;
          if (cadAbaixo > 20) it.det.push({ loja: ln, cad: r2(pcad), alvo: r2(pAlvo), custo: r2(custoUnit), m: r1(m * 100) });
        }
      }
      L.gap = { alvo: r2(G.alvo), gap: r2(G.alvo - A.lucro), cadAbaixo: r2(G.cadAbaixo), vendAbaixo: r2(G.vendAbaixo), vendAcima: r2(G.vendAcima), semMargem: r2(G.semMargem),
        margemCadastro: A.venda - G.semMargem > 0 ? r1(G.alvo / (A.venda - G.semMargem) * 100) : null };
      L.topCadastro = Object.values(porItem).filter(i => i.cadAbaixo > 0).sort((a, b) => b.cadAbaixo - a.cadAbaixo).slice(0, 12)
        .map(i => ({ cod: i.cod, desc: i.desc, venda: r2(i.venda), qtd: r2(i.qtd), cadAbaixo: r2(i.cadAbaixo), det: i.det.sort((a, b) => a.loja - b.loja).slice(0, 6) }));

      // tabela de itens + alertas por item × loja
      for (const k of cods) {
        const p = prod[k]; const it = porItem[k];
        const precos = LOJAS.map(ln => p.preco[ln]).filter(x => x > 0);
        const pMax = precos.length ? Math.max(...precos) : 0, pMin = precos.length ? Math.min(...precos) : 0;
        const custos = LOJAS.map(ln => p.custo[ln]).filter(x => x > 0);
        const custoRef = custos.length ? Math.max(...custos) : 0;
        const estTotal = LOJAS.reduce((s, ln) => s + (p.estoque[ln] > 0 ? p.estoque[ln] : 0), 0);
        const margemReal = it.venda > 0 ? (it.venda - it.custo) / it.venda * 100 : null;
        const margemCad = pMax > 0 && custoRef > 0 ? (pMax - custoRef) / pMax * 100 : null;
        const flags = new Set();
        const lojasQueima = [];
        for (const ln of LOJAS) {
          const pr = p.preco[ln], cu = p.custo[ln], est = p.estoque[ln] || 0;
          const vAt = (p.venda.atual || {})[ln];
          // regras de 11/11: final 8 = promoção da diretoria e final 7 = rebaixa (não se mexe); alto giro não sobe; item parado e sem estoque não vira alerta de preço
          const fimP = Math.round((pr || 0) * 100) % 10, promo = pr > 0 && fimP === 8, rebx = pr > 0 && fimP === 7, prot = !!(giro[ln] && giro[ln].has(k));
          const vivo = est > 0 || !!vAt || !!(p.venda.ant || {})[ln];
          const nota = promo ? 'promoção da diretoria (final 8): não mexer' : rebx ? 'rebaixa (final 7): não mexer' : ehCot ? 'lista de cotação: o robô não mexe' : prot ? 'alto giro: não sobe preço, negociar custo' : null;
          const base = { lista: cfg.chave, listaNome: cfg.nome, cod: k, desc: p.desc, loja: ln, lojaNome: NOMES[ln], preco: pr, custo: cu, estoque: est, ultVenda: p.ultVenda[ln] || null, condicao: rebx ? 'rebaixa' : promo ? 'promocao' : 'normal', protegido: prot, nota };
          if (vivo && pr > 0 && cu > 0 && pr < cu) { flags.add('abaixo_custo'); alertas.push({ ...base, tipo: 'abaixo_custo', grav: 3, txt: `Preço ${fmt(pr)} abaixo do custo ${fmt(cu)}` + (est > 0 ? ` · ${fmtQ(est)} un em estoque` : '') }); }
          else if (vivo && !promo && !rebx && pr > 0 && cu > 0 && (pr - cu) / pr * 100 < 5) { flags.add('margem_zero'); alertas.push({ ...base, tipo: 'margem_zero', grav: 2, txt: `Margem de cadastro ${r1((pr - cu) / pr * 100)}% (preço ${fmt(pr)}, custo ${fmt(cu)})` }); }
          if (vAt && vAt.qtd > 0 && vAt.venda < vAt.custo) { flags.add('vendendo_abaixo'); alertas.push({ ...base, tipo: 'vendendo_abaixo', grav: 3, txt: `Vendeu ${fmtQ(vAt.qtd)} un a ${fmt(vAt.venda / vAt.qtd)} com custo ${fmt(vAt.custo / vAt.qtd)} (−${fmt(vAt.custo - vAt.venda)} no mês)`, prejuizo: r2(vAt.custo - vAt.venda) }); }
          // queima/rebaixa daquela loja: preço bem abaixo do maior preço da rede
          if (pr > 0 && !promo && (rebx || (pMax > 0 && (pMax - pr) / pMax * 100 >= params.quedaQueima))) {
            lojasQueima.push(ln);
            const diasSem = p.ultVenda[ln] ? Math.floor((hoje - new Date(p.ultVenda[ln] + 'T12:00:00')) / 86400000) : null;
            if (est > 0 && (diasSem == null || diasSem >= params.diasSemVenda)) { flags.add('queima_parada'); alertas.push({ ...base, tipo: 'queima_parada', grav: 3, txt: `Queima a ${fmt(pr)} (rede ${fmt(pMax)}) com ${fmtQ(est)} un e ${diasSem == null ? 'sem venda no período' : 'sem venda há ' + diasSem + ' dias'}` + (p.validade[ln] && p.validade[ln].vencida ? ` · lote venceu ${br(p.validade[ln].vencida)}` : '') + ' → voltar preço ou conferir/dar baixa', diasSemVenda: diasSem }); }
            else if (est <= 0) { flags.add('queima_zerada'); alertas.push({ ...base, tipo: 'queima_zerada', grav: 2, txt: `Queima a ${fmt(pr)} (rede ${fmt(pMax)}) e estoque zerado → voltar ao preço normal`, }); }
          }
          const val = p.validade[ln];
          if (val && val.proxima && est > 0) {
            const diasV = Math.round((new Date(val.proxima + 'T12:00:00') - hoje) / 86400000);
            const vendaDia = vAt && vAt.qtd > 0 ? vAt.qtd / diasDecorridos : 0;
            const diasEstoque = vendaDia > 0 ? est / vendaDia : null;    // em quantos dias o estoque acaba no ritmo do mês
            // só é problema se a validade chega ANTES do estoque acabar (regra do Tiago: olhar validade E estoque)
            const sobraUn = vendaDia > 0 ? est - vendaDia * diasV : est;
            if (diasV <= params.diasValidade && (diasEstoque == null || diasEstoque > diasV) && sobraUn * (cu || pr) >= params.minReaisValidade) { flags.add('validade'); alertas.push({ ...base, tipo: 'validade', grav: diasV <= 7 ? 3 : 2, txt: `Vence ${br(val.proxima)} (${diasV} dias) com ${fmtQ(est)} un` + (vendaDia > 0 ? ` · vende ${fmtQ(vendaDia)}/dia → sobram ~${fmtQ(est - vendaDia * diasV)} un na data` : ' · sem venda no mês'), diasValidade: diasV, sobra: r2(vendaDia > 0 ? est - vendaDia * diasV : est) }); }
          }
          if (val && val.vencida && est > 0 && est * (cu || pr) >= params.minReaisValidade && !flags.has('queima_parada')) { flags.add('vencido_estoque'); alertas.push({ ...base, tipo: 'vencido_estoque', grav: 2, txt: `Lote venceu ${br(val.vencida)} e ainda tem ${fmtQ(est)} un no estoque → conferir/dar baixa` }); }
        }
        for (const rb of p.rebaixa) { flags.add('rebaixa_pedida'); alertas.push({ lista: cfg.chave, listaNome: cfg.nome, cod: k, desc: p.desc, loja: rb.loja, lojaNome: NOMES[rb.loja], preco: p.preco[rb.loja], custo: p.custo[rb.loja], estoque: p.estoque[rb.loja] || 0, ultVenda: p.ultVenda[rb.loja] || null, tipo: 'rebaixa_pedida', grav: 2, txt: (rb.origem === 'gerente' ? 'Gerente pediu rebaixa no celular' : 'Rebaixa de data crítica no Dlinks') + (rb.de > 0 ? ` de ${fmt(rb.de)}` : '') + (rb.para > 0 ? ` para ${fmt(rb.para)}` : '') + (rb.qtd > 0 ? ` · ${fmtQ(rb.qtd)} un` : '') + (rb.validade ? ` · validade ${br(rb.validade)}` : '') + (rb.data ? ` · ${br(rb.data)}` : ''), origem: rb.origem }); }
        // preço diferente entre lojas fora de queima, rebaixa (final 7) e promoção (final 8) — regra: preço normal igual em E1 e E2
        const normal = ln => p.preco[ln] > 0 && !lojasQueima.includes(ln) && ![7, 8].includes(Math.round(p.preco[ln] * 100) % 10);
        const precosNormais = LOJAS.filter(normal).map(ln => p.preco[ln]);
        if (precosNormais.length > 1 && Math.max(...precosNormais) - Math.min(...precosNormais) > 0.009) { flags.add('preco_diferente'); alertas.push({ lista: cfg.chave, listaNome: cfg.nome, cod: k, desc: p.desc, loja: 0, lojaNome: 'REDE', preco: pMax, custo: custoRef, estoque: estTotal, tipo: 'preco_diferente', grav: 1, txt: 'Preço diferente entre lojas: ' + LOJAS.filter(normal).map(ln => 'E' + ln + ' ' + fmt(p.preco[ln])).join(' · ') }); }
        if (it.cadAbaixo > 100) flags.add('cadastro_abaixo');
        if (it.venda > 0 || flags.size) L.itensTabela.push({ protegido: LOJAS.some(ln => giro[ln] && giro[ln].has(k)), cod: k, desc: p.desc, desativado: p.desativado, venda: r2(it.venda), qtd: r2(it.qtd), lucro: r2(it.venda - it.custo), margem: margemReal == null ? null : r1(margemReal),
          margemCad: margemCad == null ? null : r1(margemCad), precoMin: pMin, precoMax: pMax, custo: custoRef, estoque: r2(estTotal), cadAbaixo: r2(it.cadAbaixo), vendAbaixo: r2(it.vendAbaixo),
          lojasQueima, flags: [...flags], precos: LOJAS.map(ln => p.preco[ln] || 0), estoques: LOJAS.map(ln => p.estoque[ln] || 0) });
      }
      L.itensTabela.sort((a, b) => b.venda - a.venda);
      listas.push(L);
    }
    for (const a of alertas) if (a.nota && ['abaixo_custo', 'margem_zero', 'vendendo_abaixo'].includes(a.tipo)) a.txt += ' · ' + a.nota;
    if (completo) listas.sort((a, b) => b.periodos.atual.venda - a.periodos.atual.venda);
    alertas.sort((a, b) => b.grav - a.grav || (b.prejuizo || 0) - (a.prejuizo || 0) || a.desc.localeCompare(b.desc, 'pt-BR') || a.loja - b.loja);

    const tot = { venda: 0, lucro: 0, lucroProj: 0, meta: 0 };
    for (const L of listas) { tot.venda += L.periodos.atual.venda; tot.lucro += L.periodos.atual.lucro; tot.lucroProj += L.meta.lucroProj; tot.meta += L.meta.reais; }
    cache = { calculadoEm: new Date().toISOString(), ms: Date.now() - t0, hoje: dHoje, mes: `${ano}-${mm}`, diasMes, diasDecorridos: r2(diasDecorridos), erros,
      total: { venda: r2(tot.venda), lucro: r2(tot.lucro), margem: tot.venda > 0 ? r1(tot.lucro / tot.venda * 100) : null, lucroProj: r2(tot.lucroProj), meta: r2(tot.meta), falta: r2(tot.meta - tot.lucro), alertas: alertas.length, graves: alertas.filter(a => a.grav === 3).length },
      escopo: { lojas: LOJAS.slice(), completo, gruposFora: [...fora], listasCotacao: [...cotacao], topGiro, protegidos: Object.fromEntries(LOJAS.map(ln => [ln, giro[ln] ? giro[ln].size : 0])) },
      listas, alertas, nomes: NOMES, tipos: TIPOS };
    gravarJson(OUT, cache);
    console.log(`[ROBO-PRECIF] calculado em ${cache.ms} ms: ${listas.length} listas, ${alertas.length} alertas${erros.length ? ', erros: ' + erros.length : ''}`);
    ultimoErro = null;
    return cache;
  })().catch(e => { ultimoErro = { em: new Date().toISOString(), msg: e.message }; throw e; }).finally(() => { calculando = null; });
  return calculando;
}

const TIPOS = {
  abaixo_custo: { txt: 'Preço abaixo do custo', grav: 3 },
  vendendo_abaixo: { txt: 'Vendendo abaixo do custo', grav: 3 },
  queima_parada: { txt: 'Queima parada (estoque sem venda)', grav: 3 },
  validade: { txt: 'Validade chega antes do estoque acabar', grav: 2 },
  vencido_estoque: { txt: 'Último lote vencido e ainda tem estoque', grav: 2 },
  queima_zerada: { txt: 'Queima com estoque zerado', grav: 2 },
  margem_zero: { txt: 'Margem de cadastro quase zero', grav: 2 },
  rebaixa_pedida: { txt: 'Rebaixa pedida pela loja', grav: 2 },
  preco_diferente: { txt: 'Preço diferente entre lojas', grav: 1 }
};
const fmt = v => 'R$ ' + (+v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQ = v => (+v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const br = d => d ? d.split('-').reverse().join('/') : '';

function estado() {
  if (!cache && deps && !calculando) calcular().catch(e => console.error('[ROBO-PRECIF]', e.message));
  return { calculadoEm: cache?.calculadoEm || null, calculando: !!calculando, ultimoErro, completo: !!(cache && cache.escopo && cache.escopo.completo), ms: cache?.ms || null, listas: (cache?.listas || []).length, alertas: (cache?.alertas || []).length, erros: cache?.erros || [] };
}
function consultar() {
  if (!cache && deps && deps.q && !calculando) calcular().catch(e => console.error('[ROBO-PRECIF]', e.message));   // 1ª abertura da tela sem cache dispara o cálculo
  return cache ? { ...cache, calculando: !!calculando, params } : { calculando: !!calculando, params, listas: [], alertas: [], total: null }; }

/** Versão leve pros painéis (sem a tabela de itens, alertas só com o que o painel mostra): com a loja completa o cálculo inteiro passa de alguns MB. */
function consultarLeve() {
  const c = consultar(); if (!c.calculadoEm) return c;
  return { ...c, listas: c.listas.map(l => ({ ...l, itensTabela: [], topCadastro: [] })), alertas: c.alertas.map(a => ({ loja: a.loja, desc: a.desc, txt: a.txt, tipo: a.tipo, grav: a.grav, lista: a.lista })) };
}

/** Listas em que o robô de COMPRAS trabalha (Comprador Sombra, Ensaio): com a loja completa, todas as listas de compra com venda em E1/E2,
 *  menos as de cotação (277/218: o robô não mexe); sem cálculo ainda, as listas com nome próprio. */
function listasRobo() {
  if (params.todasListas !== false && cache && cache.escopo && cache.escopo.completo) return cache.listas.filter(l => !l.cotacao && !l.semLista && l.ids.length).map(l => ({ chave: l.chave, nome: l.nome, ids: l.ids }));
  return (params.listas || []).map(l => ({ chave: l.chave, nome: l.nome, ids: l.ids }));
}

/** Listas de compra do ERP pra escolher a 5ª lista na tela (só leitura). */
async function listasErp() {
  const rows = await deps.q(`SELECT l.nReg id, TRIM(l.Nome) nome, l.CodFornec fornec, TRIM(l.NomeFornec) nomeFornec, (SELECT COUNT(*) FROM central.c_cotacao_lista_itens i WHERE i.nCotacao = l.nReg) itens FROM central.c_cotacao_lista l ORDER BY l.Nome`);
  return rows.map(r => ({ id: +r.id, nome: r.nome, fornec: +r.fornec, nomeFornec: r.nomeFornec, itens: +r.itens }));
}

function agendar() {
  const idade = cache ? Date.now() - new Date(cache.calculadoEm).getTime() : Infinity;
  if (idade > 6 * 3600 * 1000) setTimeout(() => calcular().catch(e => console.error('[ROBO-PRECIF]', e.message)), 200 * 1000);
  // 05:50 de madrugada (depois do Sem Giro 05:40) e 13:05 pra pegar a manhã
  setInterval(() => { const d = new Date(); if ((d.getHours() === 5 && d.getMinutes() === 50) || (d.getHours() === 13 && d.getMinutes() === 5)) calcular().catch(e => console.error('[ROBO-PRECIF]', e.message)); }, 60 * 1000);
}

module.exports = { init, agendar, calcular, consultar, consultarLeve, listasRobo, estado, getParams, setParams, resetParams, listasErp, NOMES, LOJAS, TIPOS, PARAMS_PADRAO };
