'use strict';
// FISCAL × COLETOR ECONÔMICO — mescla da conferência física do nosso PWA (lib/recebimento.js)
// na linha do Fiscal (lib/fiscal.js).
//
// Decisão de 25/09/2026 (pedido do Tiago): o Fiscal voltou a ser só o cruzamento com o coletor
// do Dlinks, do jeito que era antes. Este código (que ficava dentro de lib/fiscal.js) NÃO está
// mais ligado — fica guardado aqui pronto pra "colocar de volta" quando decidirem retomar.
//
// Como religar:
//   1. No topo de lib/fiscal.js: const fiscalColetor = require('./fiscal-coletor').criar({ recebimento: depsF.recebimento });
//      (ou passar o módulo `recebimento` que já é injetado em init(q, deps) — deps.recebimento)
//   2. Em listar() e em detalhe(), depois de chamar cruzar(...) pra cada linha (ou lista),
//      chamar fiscalColetor.anexarEconomico(lista, de, ate, cfg) — mesma assinatura de antes,
//      só que agora ela já vem com o `recebimento` de dentro do objeto criado por `criar()`.
//   3. As funções puras (mesclarEconomico, conferenciaFisica, acharConf, maisRecente) não
//      dependem de `recebimento` e podem ser usadas soltas (é o que test/fiscal-recebimento.test.js faz).

// A conferência cega que a loja faz no nosso coletor é uma SEGUNDA contagem, independente do
// coletor do ERP. Aqui ela entra na linha do Fiscal: itens bipados, devoluções (3 origens:
// compras / coletor / falta) e a "conferência física" (bipado × nota). A linha só fica 'pronto'
// quando pedido, XML e físico batem — qualquer um fora vira 'excecao' com o motivo.
const ECO_FECHADA = ['terminada', 'liberada'];

const num = v => { let s = String(v ?? '0').trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const hoje = () => new Date().toISOString().slice(0, 10);
const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const CONFIG_PADRAO = {
  tol_qtd_pct: 0,
  tol_peso_pct: 5
};

// Mesma régua que cruzar() usa no coletor do ERP (tolerância de quantidade, tolerância própria de
// balança e "contou por embalagem" = aviso, não erro) — não faz sentido a segunda contagem ser
// julgada com critério diferente da primeira na mesma tela.
function conferenciaFisica(row, conf, devolucoes, cfg) {
  cfg = { ...CONFIG_PADRAO, ...(cfg || {}) };
  if (!ECO_FECHADA.includes(conf.status)) return { nivel: 'pendente', msg: `Coletor Econômico ainda ${conf.status} — contagem física não fechou`, diferencas: [] };
  const bip = {}; for (const it of Object.values(conf.itens || {})) bip[String(it.cod)] = num(it.un);
  const doRow = {}; for (const i of row.itens || []) doRow[String(i.ean)] = i;
  const nota = {}; for (const i of row.itens || []) if (i.xml_qtd != null) nota[String(i.ean)] = num(i.xml_qtd);
  if (!Object.keys(nota).length) return { nivel: 'pendente', msg: 'Nota ainda sem itens pra comparar com o físico', diferencas: [] };
  // item já recusado pelo(a) comprador(a) sai na devolução (origem 'compras'): não é erro de contagem
  const recusados = new Set((devolucoes || []).filter(d => d.origem === 'compras').map(d => String(d.cod)));
  const diferencas = [];
  for (const cod of [...new Set([...Object.keys(nota), ...Object.keys(bip)])]) {
    if (recusados.has(cod)) continue;
    const i = doRow[cod] || {};
    const n = nota[cod] || 0, f = bip[cod] || 0, dif = r2(f - n);
    const tolPct = n * (cfg.tol_qtd_pct / 100);
    const tol = i.peso ? Math.max(tolPct, n * (cfg.tol_peso_pct / 100)) : tolPct;   // balança: quebra/gelo/pesagem
    if (Math.abs(dif) <= tol + 1e-9) continue;
    const base = { cod, descricao: i.descricao || (conf.itens[cod] || {}).descricao || cod, nota: n, fisico: f, dif };
    // nota ainda não lançada traz a quantidade tributária: a embalagem sai da razão qtd ÷ qtd comercial
    const embNota = num(i.xml_qtd_com) > 0 && num(i.xml_qtd) > 0 ? Math.round(num(i.xml_qtd) / num(i.xml_qtd_com)) : 0;
    const fator = n > 0 && f > 0 ? (f > n ? f / n : n / f) : 0;
    const redondo = Math.round(fator);
    const ehEmb = fator > 0 && Math.abs(fator - redondo) < 1e-6 && redondo >= 2 && redondo <= 120 && (num(i.cad_emb) === redondo || embNota === redondo);
    if (ehEmb) diferencas.push({ ...base, tipo: 'emb', nivel: 'aviso', fator: redondo });
    else diferencas.push({ ...base, tipo: !f ? 'nao_bipado' : !n ? 'nao_na_nota' : dif < 0 ? 'falta' : 'sobra', nivel: 'erro' });
  }
  const nErro = diferencas.filter(d => d.nivel === 'erro').length;
  const nEmb = diferencas.length - nErro;
  return { nivel: nErro ? 'erro' : nEmb ? 'aviso' : 'ok', diferencas,
    msg: nErro ? `${nErro} item(ns) com diferença entre o físico bipado e a nota` : nEmb ? `${nEmb} item(ns) bipados por embalagem — bate pelo fator` : `Contagem física bate com a nota (${Object.keys(bip).length} itens bipados)` };
}

// pura (testada em test/fiscal-recebimento.test.js): mescla UMA conferência nossa na linha do Fiscal
function mesclarEconomico(row, conf, devolucoes, cfg) {
  if (!row || !conf) return row;
  const dev = devolucoes || conf.devolucoes || [];
  const fisico = conferenciaFisica(row, conf, dev, cfg);
  const erp = conf.erp || {};
  const eco = {
    id: conf.id, status: conf.status, recontagens: +conf.recontagens || 0, nNota: conf.nNota, conferente: conf.nome || null,
    liberado_por: conf.liberadoPor || null, liberado_em: conf.liberadoEm || null, devolucoes: dev, fisico, motivos: [],
    erp: { nReg: erp.nReg != null ? erp.nReg : null, erros: (erp.erros || []).length, ultimo_erro: (erp.erros || []).length ? erp.erros[erp.erros.length - 1].erro : null, ultimoLogId: erp.ultimoLogId || null },
    itens: Object.values(conf.itens || {}).map(i => ({ cod: i.cod, descricao: i.descricao, quant: i.quant, emb: i.emb, emb_label: i.emb_label || null, un: i.un, validade: i.validade || null, estado: i.estado, aviso: i.aviso || null }))
  };
  const ck = row.checks || {};
  if (ck.pedido && ck.pedido.nivel === 'erro') eco.motivos.push('Pedido de compra: ' + ck.pedido.msg);
  if (ck.xml && ck.xml.nivel === 'erro') eco.motivos.push('XML da NF-e: ' + ck.xml.msg);
  if (fisico.nivel === 'erro') eco.motivos.push('Conferência física: ' + fisico.msg);
  row.economico = eco;
  row.checks = { ...ck, fisico: { nivel: fisico.nivel, msg: fisico.msg } };
  // o check novo entra na contagem como qualquer outro (mesma derivação de cruzar)
  const niveis = Object.values(row.checks).map(c => c && c.nivel);
  row.erros = niveis.filter(n => n === 'erro').length;
  row.avisos = niveis.filter(n => n === 'aviso').length;
  row.pendentes = niveis.filter(n => n === 'pendente').length;
  row.veredito = row.erros ? 'divergente' : row.avisos ? 'atencao' : row.pendentes ? 'pendente' : 'ok';
  row.excecoes = [...(row.excecoes || []), ...fisico.diferencas.filter(d => d.nivel === 'erro')
    .map(d => ({ ean: d.cod, descricao: d.descricao, tipo: 'fisico_' + d.tipo, msg: `Conferência física: nota ${d.nota}, bipado ${d.fisico} (${d.dif > 0 ? '+' : ''}${d.dif})` }))];
  if (!['cancelado', 'bloqueado', 'reconferir', 'liberado'].includes(row.situacao)) {
    if (eco.motivos.length) row.situacao = 'excecao';
    else if (fisico.nivel === 'pendente' && ['pronto', 'conferido'].includes(row.situacao)) row.situacao = 'em_contagem';
  }
  return row;
}

// A chave da NF-e é a única identidade que vale nos dois lados. O nReg guardado em erp.nReg é o da
// conferência criada no ERP de TESTE (.254) — sequência diferente da produção (.252) —, então ele
// só casa junto com a loja, e o nº da nota + loja fica como último recurso.
const confQuando = c => c.atualizadoEm || c.termineiEm || c.abertoEm || c.id || '';
const maisRecente = cs => cs.sort((a, b) => String(confQuando(b)).localeCompare(String(confQuando(a))))[0] || null;

function acharConf(row, confs) {
  const chaves = new Set([...(row.notas || []).map(n => n.chave), ...(row.chaves || [])].filter(k => k && String(k).length >= 40).map(String));
  if (chaves.size) { const porChave = confs.filter(c => c.chave && chaves.has(String(c.chave))); if (porChave.length) return maisRecente(porChave); }
  const porNReg = confs.filter(c => c.erp && c.erp.nReg != null && String(c.erp.nReg) === String(row.nReg) && +c.loja === +row.loja);
  if (porNReg.length) return maisRecente(porNReg);
  const nums = new Set((row.notas || []).map(n => String(n.nNota)).filter(n => n && n !== 'null'));
  if (!nums.size) return null;
  return maisRecente(confs.filter(c => +c.loja === +row.loja && nums.has(String(c.nNota))));
}

// requer o módulo `recebimento` (lib/recebimento.js) injetado — ver criar() abaixo
function confsDoPeriodo(recebimento, de, ate) {
  if (!recebimento || !recebimento.listarDia) return [];
  // a conferência nossa é gravada no dia em que a loja abriu a nota — pode ser 1 dia antes/depois da entrada
  let d = addDias(de || hoje(), -1); const fim = addDias(ate || de || hoje(), 1); const out = [];
  for (let n = 0; d <= fim && n < 62; n++, d = addDias(d, 1)) { try { out.push(...recebimento.listarDia(d)); } catch (e) {} }
  return out;
}

function anexarEconomico(recebimento, lista, de, ate, cfg) {
  if (!recebimento || !lista.length) return lista;
  let cfgRec = null; try { cfgRec = recebimento.config(); } catch (e) { cfgRec = null; }
  if (!cfgRec || !cfgRec.fiscal_ativo) return lista; // integração desligada: Fiscal fica só com o coletor do Dlinks, como antes
  let confs = []; try { confs = confsDoPeriodo(recebimento, de, ate); } catch (e) { console.error('[FISCAL] coletor:', e.message); return lista; }
  for (const r of lista) {
    const c = acharConf(r, confs); if (!c) continue;
    let dev = c.devolucoes || [];
    if (!dev.length) { try { dev = recebimento.devolucoes(c); } catch (e) { dev = []; } }
    mesclarEconomico(r, c, dev, cfg);
  }
  return lista;
}

// Factory: prende o módulo `recebimento` pras funções que precisam dele (anexarEconomico,
// confsDoPeriodo), pra chamar como antes (sem passar `recebimento` em toda chamada) quando
// isto for religado em lib/fiscal.js.
function criar({ recebimento } = {}) {
  return {
    anexarEconomico: (lista, de, ate, cfg) => anexarEconomico(recebimento, lista, de, ate, cfg),
    confsDoPeriodo: (de, ate) => confsDoPeriodo(recebimento, de, ate),
    mesclarEconomico, conferenciaFisica, acharConf, maisRecente
  };
}

module.exports = { criar, mesclarEconomico, conferenciaFisica, acharConf, maisRecente, confsDoPeriodo, anexarEconomico, CONFIG_PADRAO };
