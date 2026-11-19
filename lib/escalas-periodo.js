'use strict';
// lib/escalas-periodo.js — DP / RH › Escalas › Gerar por período (19/11/2026, pedido do Tiago com a ESCALA LOJA 5.pdf).
// Serviço do "modelo da planilha": junta o quadro da loja (ponto + linhas previstas), o cadastro de cada pessoa (turno,
// folga fixa, trabalha domingo), chama o motor puro (lib/escalas-planilha.js) para o período escolhido e, se quem edita a
// escala mandar, grava o resultado como RASCUNHO na grade do(s) mês(es) — o fluxo gerente → RH → Coordenação segue igual.
// Nada aqui escreve no ponto. Dados: data/escalas/planilha.json (cadastro por loja) e data/escalas/planilha-geracoes/.
const fs = require('fs'); const path = require('path');
const E = require('./escalas'); const GP = require('./gestao-pessoas'); const M = require('./escalas-planilha');

const P = { cfg: () => path.join(E.DIR, 'planilha.json'), gerDir: () => path.join(E.DIR, 'planilha-geracoes'), ger: id => path.join(E.DIR, 'planilha-geracoes', id + '.json'), antigo: () => path.join(E.DIR, 'gerador.json') };
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; } };
function gravarJson(arq, obj) { fs.mkdirSync(path.dirname(arq), { recursive: true }); const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, arq); }
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const { soma, dow } = M._util; const hojeISO = () => E._util.diaISO();
const ISO = /^\d{4}-\d{2}-\d{2}$/; const HM = /^([01]\d|2[0-3]):[0-5]\d$/; const COR = /^#[0-9A-Fa-f]{6}$/;
const br = d => d.split('-').reverse().join('/');

// ── Cadastro por loja ────────────────────────────────────────────────────────────────────────────────────
function cfg() { const c = lerJson(P.cfg(), null) || {}; return { versao: c.versao || 1, lojas: c.lojas || {} }; }
function lojaCfg(loja) { const l = cfg().lojas[loja] || {}; return { ativo: !!l.ativo, turnos: l.turnos && Object.keys(l.turnos).length ? l.turnos : JSON.parse(JSON.stringify(M.TURNOS_PADRAO)), efetivoDomingo: l.efetivoDomingo || {}, pesoDia: { ...M.PESO_DIA_PADRAO, ...(l.pesoDia || {}) },
  params: { ...M.PARAMS_PADRAO, ...(l.params || {}) }, pessoas: l.pessoas || {}, extras: l.extras || [], seq: l.seq || 0, alteradoEm: l.alteradoEm || null, alteradoPor: l.alteradoPor || null }; }
function salvarLoja(loja, fn, user) { const c = cfg(); const l = c.lojas[loja] || {}; fn(l); l.alteradoEm = new Date().toISOString(); l.alteradoPor = user ? user.usuario : 'sistema'; c.lojas[loja] = l; c.versao++; gravarJson(P.cfg(), c); return lojaCfg(loja); }
/** O que a Escala coletiva precisa para pintar igual à planilha: só vale na loja que já usa o modelo. */
function visual(loja) { const l = lojaCfg(loja); return { ativo: l.ativo, corFolga: M.COR_FOLGA, turnos: Object.entries(l.turnos).map(([codigo, t]) => ({ codigo, entrada: t.entrada, saida: t.saida, almoco_ini: t.almoco_ini || null, almoco_fim: t.almoco_fim || null, cor: t.cor, texto: M.corTexto(t.cor), domingo: t.domingo || codigo })) }; }
/** A grade do mês tem dia gerado por este modelo? (a validação seg→dom do Gerador 5×2 antigo não se aplica a ele) */
const modeloNoMes = (loja, mes) => { const e = E.ler(loja, mes); return !!e && Object.values(e.dias || {}).some(x => x && x.modelo === 'planilha'); };

const podeVer = (u, loja) => E.podeVer(u, loja);
const podeCadastrar = (u, loja) => GP.gerenteDa(u, loja) || GP.rhDa(u, loja, 'rh_ponto') || GP.temPapel(u, 'coordenacao');
const podeAplicar = (u, loja) => GP.gerenteDa(u, loja) || GP.rhDa(u, loja, 'rh_ponto');

function normTurnos(v) {
  const out = {}; const lista = Array.isArray(v) ? v : Object.entries(v || {}).map(([codigo, t]) => ({ codigo, ...t }));
  for (const t of lista) {
    const k = txt(t.codigo, 8); if (!k) throw erro('Todo turno precisa de um código (ex.: T.1)'); if (out[k]) throw erro('Código de turno repetido: ' + k);
    if (!HM.test(t.entrada || '') || !HM.test(t.saida || '') || t.saida <= t.entrada) throw erro('Horário inválido no turno ' + k);
    const ai = t.almoco_ini || null, af = t.almoco_fim || null; if ((ai || af) && !(HM.test(ai || '') && HM.test(af || '') && ai >= t.entrada && af <= t.saida && af > ai)) throw erro('Intervalo inválido no turno ' + k);
    if (!COR.test(t.cor || '')) throw erro('Cor inválida no turno ' + k);
    out[k] = { entrada: t.entrada, saida: t.saida, almoco_ini: ai, almoco_fim: af, cor: t.cor.toUpperCase(), domingo: txt(t.domingo, 8) || k };
  }
  if (!Object.keys(out).length) throw erro('Cadastre pelo menos um turno'); if (Object.keys(out).length > 12) throw erro('No máximo 12 turnos por loja');
  for (const [k, t] of Object.entries(out)) if (!out[t.domingo]) throw erro('O turno de domingo de ' + k + ' (' + t.domingo + ') não existe');
  return out;
}

// ── Quadro: ponto + linhas previstas ─────────────────────────────────────────────────────────────────────
/** Funcionários da loja no formato da escala: o arquivo do mês, o mais recente da loja ou, na falta, o ponto. */
async function quadroBase(loja, mes, ctx) {
  let e = E.ler(loja, mes); if (e) return e.funcionarios;
  const outros = E.listar().filter(x => x.loja === +loja).map(x => x.mes).sort(); const perto = outros.filter(m => m <= mes).pop() || outros[0];
  if (perto) return E.ler(loja, perto).funcionarios;
  if (!ctx || !ctx.pontocerto) return [];
  const [col, esc] = await Promise.all([ctx.pontocerto.colaboradores(), ctx.pontocerto.escalas()]); return E.funcsDoPontoCerto(loja, col, esc);
}
const turnoPorEntrada = (turnos, f) => { const b = Object.values(f.base || {}).find(Boolean); if (!b) return null; const hit = Object.entries(turnos).find(([, t]) => t.entrada === b.entrada && t.saida === b.saida); return hit ? hit[0] : null; };
const titulo = s => String(s || '').toLowerCase().replace(/(^|[\s/])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/ (De|Da|Do|Das|Dos|E) /g, m => m.toLowerCase());
/** Pessoas do período: quem está no quadro da loja nas datas + as linhas previstas (admissão, transferência, vaga a contratar). */
async function quadro(loja, de, ate, ctx) {
  const L = lojaCfg(loja); const antigo = (lerJson(P.antigo(), {}) || {}).funcionarios || {}; const base = await quadroBase(loja, de.slice(0, 7), ctx || {});
  const pessoas = [];
  for (const f of base) {
    if (f.extra) continue;                                                  // linha prevista já entrou num mês aplicado: vem do cadastro, não daqui
    const lim = E.limitesNaEscala({ loja: +loja }, f); if (lim && ((lim.fim && lim.fim < de) || (lim.inicio && lim.inicio > ate))) continue;
    const c = L.pessoas[f.id] || {}; const fx = c.folgaFixa != null ? +c.folgaFixa : antigo[f.id] && antigo[f.id].folga_fixa != null && +antigo[f.id].folga_fixa >= 1 ? +antigo[f.id].folga_fixa : null;
    const contrato = (f.folga_fixa || []).filter(d => d >= 1 && d <= 6);
    pessoas.push({ id: f.id, nome: f.nome, cargo: f.cargo || '', setor: f.setor, grupo: txt(c.grupo, 40) || titulo(f.cargo) || E.setorTxt(f.setor), turno: c.turno || turnoPorEntrada(L.turnos, f), folgaFixa: fx || (contrato.length === 1 ? contrato[0] : null),
      folgaFixaOrigem: c.folgaFixa != null ? 'cadastro' : fx ? 'gerador 5×2' : contrato.length === 1 ? 'contrato do ponto' : null, domingo: c.domingo !== false, cadastrado: !!(c.turno && c.folgaFixa != null), ordem: c.ordem != null ? +c.ordem : null,
      ausencias: [...(lim && lim.fim && lim.fim < ate ? [{ inicio: soma(lim.fim, 1), fim: ate, tipo: 'afastado', saiu: true }] : []), ...(lim && lim.inicio && lim.inicio > de ? [{ inicio: de, fim: soma(lim.inicio, -1), tipo: 'afastado', saiu: true }] : [])] });
  }
  for (const x of L.extras) pessoas.push({ id: x.id, nome: x.nome, cargo: x.grupo, setor: x.setor || 'OUTROS', grupo: x.grupo, turno: x.turno || null, folgaFixa: x.folgaFixa || null, folgaFixaOrigem: x.folgaFixa ? 'cadastro' : null, domingo: x.domingo !== false, cadastrado: !!(x.turno && x.folgaFixa), ordem: x.ordem != null ? +x.ordem : null, extra: true, vaga: !!x.vaga, obs: x.obs || '', ausencias: [] });
  // ordem da planilha: por função (na ordem em que as funções aparecem) e, dentro dela, a ordem gravada ou o nome
  const og = {}; pessoas.slice().sort((a, b) => (a.ordem == null) - (b.ordem == null) || (a.ordem || 0) - (b.ordem || 0)).forEach(p => { if (og[p.grupo] == null) og[p.grupo] = Object.keys(og).length; });
  pessoas.sort((a, b) => og[a.grupo] - og[b.grupo] || (a.ordem == null) - (b.ordem == null) || (a.ordem || 0) - (b.ordem || 0) || a.vaga - b.vaga || a.nome.localeCompare(b.nome));
  return { L, pessoas };
}
/** Afastamentos e férias do ponto no período, por nome (se o ponto não responder, a escala sai sem eles e avisa). */
async function ausenciasDoPonto(de, ate, ctx) {
  if (ctx && ctx.afast) return { mapa: ctx.afast, erro: null }; if (!ctx || !ctx.pontocerto) return { mapa: new Map(), erro: null };
  try { const l = await ctx.pontocerto.afastamentos(de, ate); const m = new Map(); for (const a of l) { if (!m.has(a.nome)) m.set(a.nome, []); m.get(a.nome).push({ inicio: a.inicio, fim: a.fim, tipo: a.ferias ? 'ferias' : 'afastado' }); } return { mapa: m, erro: null }; }
  catch (e) { return { mapa: new Map(), erro: e.message }; }
}
/** O que já está gravado na grade nos 28 dias antes do período (só dia lançado de fato: gerado ou alterado à mão). */
function historico(loja, de, ids) {
  const out = {}; const ini = soma(de, -28); const meses = [...new Set([ini.slice(0, 7), soma(de, -1).slice(0, 7)])];
  for (const mes of meses) { const e = E.ler(loja, mes); if (!e) continue; for (const [k, d] of Object.entries(e.dias || {})) { const [id, data] = k.split('|'); if (data < ini || data >= de || !ids.has(String(id))) continue; (out[id] || (out[id] = {}))[data] = d.tipo === 'trabalho' ? 'T' : 'F'; } }
  return out;
}

async function cadastro(user, loja, ctx) {
  const hj = hojeISO(); const { L, pessoas } = await quadro(loja, hj, soma(hj, 60), ctx);
  const grupos = [...new Set(pessoas.map(p => p.grupo))];
  return { loja: +loja, ativo: L.ativo, turnos: visual(loja).turnos, corFolga: M.COR_FOLGA, pesoDia: L.pesoDia, params: { maxDiasSeguidos: L.params.maxDiasSeguidos, maxDomingosSeguidos: L.params.maxDomingosSeguidos },
    grupos: grupos.map(g => { const n = pessoas.filter(p => p.grupo === g).length, el = pessoas.filter(p => p.grupo === g && p.domingo).length; const v = L.efetivoDomingo[g]; return { grupo: g, pessoas: n, trabalhamDomingo: el, efetivoDomingo: v == null ? null : +v, padrao: M.efetivoPadrao(el) }; }),
    pessoas: pessoas.map(p => ({ id: p.id, nome: p.nome, cargo: p.cargo, setor: p.setor, setorTxt: E.setorTxt(p.setor), grupo: p.grupo, turno: p.turno, folgaFixa: p.folgaFixa, folgaFixaOrigem: p.folgaFixaOrigem, domingo: p.domingo, cadastrado: p.cadastrado, extra: !!p.extra, vaga: !!p.vaga, obs: p.obs || '' })),
    setores: [...new Set([...E.SETORES, ...pessoas.map(p => p.setor)])].map(s => ({ id: s, txt: E.setorTxt(s) })), podeCadastrar: podeCadastrar(user, loja), podeAplicar: podeAplicar(user, loja), alteradoEm: L.alteradoEm, alteradoPor: L.alteradoPor };
}
/** Grava o cadastro da loja: turnos, efetivo de domingo, pesos, pessoas (turno / folga fixa / domingo / função) e linhas previstas. */
function salvarCadastro(user, loja, b) {
  if (!podeCadastrar(user, loja)) throw erro('Só o gerente da unidade, o RH Ponto ou a Coordenação alteram o cadastro da escala', 403);
  b = b || {}; const atual = lojaCfg(loja); const turnos = b.turnos ? normTurnos(b.turnos) : atual.turnos; const cod = v => (v && turnos[v] ? v : null); const fixa = v => (+v >= 1 && +v <= 6 ? +v : null);
  const r = salvarLoja(loja, l => {
    l.turnos = turnos;
    if (b.efetivoDomingo) { l.efetivoDomingo = {}; for (const [g, v] of Object.entries(b.efetivoDomingo)) { if (v === '' || v == null) continue; const n = Math.round(+v); if (!(n >= 0 && n <= 200)) throw erro('Efetivo de domingo inválido em ' + g); l.efetivoDomingo[txt(g, 40)] = n; } }
    if (b.pesoDia) { l.pesoDia = {}; for (let d = 1; d <= 6; d++) { const n = +b.pesoDia[d]; if (!(n >= 0 && n <= 5)) throw erro('Peso do dia inválido (0 a 5)'); l.pesoDia[d] = n; } }
    if (b.params) { const a = Math.round(+b.params.maxDiasSeguidos), d = Math.round(+b.params.maxDomingosSeguidos); if (!(a >= 5 && a <= 7) || !(d >= 1 && d <= 4)) throw erro('Limites inválidos: dias seguidos de 5 a 7, domingos seguidos de 1 a 4'); l.params = { maxDiasSeguidos: a, maxDomingosSeguidos: d }; }
    if (Array.isArray(b.pessoas)) { l.pessoas = l.pessoas || {}; b.pessoas.forEach((p, i) => { if (p.extra || !(+p.id > 0)) return; l.pessoas[p.id] = { turno: cod(p.turno), folgaFixa: fixa(p.folgaFixa), domingo: p.domingo !== false, grupo: txt(p.grupo, 40) || null, ordem: i }; }); }
    if (Array.isArray(b.pessoas) || Array.isArray(b.extras)) {
      const vindas = (b.extras || []).concat((b.pessoas || []).map((p, i) => ({ ...p, ordem: i })).filter(p => p.extra)); let seq = l.seq || 0; const ant = new Map((l.extras || []).map(x => [x.id, x])); const novas = [];
      for (const x of vindas) { const nome = txt(x.nome, 80).toUpperCase(), grupo = txt(x.grupo, 40); if (!nome || !grupo) throw erro('Linha prevista precisa de nome e função');
        const id = +x.id < 0 && ant.has(+x.id) ? +x.id : -(9000 + (++seq)); novas.push({ id, nome, grupo, setor: semAcento(x.setor) || E.setorOperacional(grupo), turno: cod(x.turno), folgaFixa: fixa(x.folgaFixa), domingo: x.domingo !== false, vaga: !!x.vaga, obs: txt(x.obs, 120), ordem: x.ordem != null ? +x.ordem : null }); }
      if (novas.length > 80) throw erro('No máximo 80 linhas previstas por loja'); l.extras = novas; l.seq = seq;
    }
  }, user);
  GP.auditar({ usuario: user.usuario, acao: 'escala_periodo_cadastro', loja: +loja, pessoas: Object.keys(r.pessoas).length, extras: r.extras.length });
  return { ok: true };
}

// ── Gerar e aplicar ──────────────────────────────────────────────────────────────────────────────────────
function periodoOk(de, ate) { if (!ISO.test(de || '') || !ISO.test(ate || '')) throw erro('Informe o início e o fim do período'); if (ate < de) throw erro('O fim do período é antes do início'); }
async function gerar(user, loja, de, ate, ctx) {
  periodoOk(de, ate); const { L, pessoas } = await quadro(loja, de, ate, ctx); if (!pessoas.length) throw erro('Não há quadro para ' + GP.LOJA_TXT[loja] + ': abra a Escala coletiva do mês para criar a escala a partir do ponto, ou cadastre as linhas previstas.', 404);
  const aus = await ausenciasDoPonto(de, ate, ctx);
  for (const p of pessoas) if (!p.extra) p.ausencias = p.ausencias.concat(aus.mapa.get(semAcento(p.nome)) || []);
  const r = M.gerar({ de, ate, pessoas, turnos: L.turnos, efetivoDomingo: L.efetivoDomingo, pesoDia: L.pesoDia, params: L.params, historico: historico(loja, de, new Set(pessoas.map(p => String(p.id)))) });
  const porId = new Map(pessoas.map(p => [String(p.id), p]));
  for (const l of r.linhas) { const p = porId.get(String(l.id)); l.cargo = p.cargo; l.setor = p.setor; l.obs = p.obs || ''; for (const d of r.dias) { const a = p.ausencias.find(x => x.saiu && x.inicio <= d && x.fim >= d); if (a) l.dias[d] = { tipo: 'saiu', minutos: 0 }; } }
  const fer = E.config().feriados.filter(d => d >= de && d <= ate);
  return { ...r, loja: +loja, lojaTxt: GP.LOJA_TXT[loja], visual: visual(loja), feriados: Object.fromEntries(fer.map(d => [d, E.nomeFeriado(d)])), pontoErro: aus.erro, hoje: hojeISO(), podeAplicar: podeAplicar(user, loja), podeCadastrar: podeCadastrar(user, loja) };
}
const listarGeracoes = loja => { let fsn = []; try { fsn = fs.readdirSync(P.gerDir()); } catch (e) {} return fsn.filter(n => n.startsWith('P-' + loja + '-') && n.endsWith('.json')).map(n => lerJson(path.join(P.gerDir(), n), null)).filter(Boolean).sort((a, b) => b.em.localeCompare(a.em)); };
const resumoGeracao = g => ({ id: g.id, de: g.de, ate: g.ate, em: g.em, nome: g.nome, justificativa: g.justificativa, dias: g.dias, preservados: g.preservados, meses: g.meses, desfeita: g.desfeita || null });
/** Grava a escala gerada como rascunho na grade. Só de amanhã em diante; dia alterado à mão e escala em aprovação não são tocados. */
async function aplicar(user, loja, body, ctx) {
  body = body || {}; const de = body.de, ate = body.ate; periodoOk(de, ate);
  if (!podeAplicar(user, loja)) throw erro('Só o gerente da unidade ou o RH Ponto aplicam a escala na grade', 403);
  const just = txt(body.justificativa, 500); if (just.length < 10) throw erro('Escreva a justificativa (mínimo de 10 caracteres): ela fica registrada com o seu nome');
  const hj = (ctx && ctx.hoje) || hojeISO(); if (ate <= hj) throw erro('O período já passou: a escala só é aplicada de amanhã em diante');
  const r = await gerar(user, loja, de, ate, ctx); const datas = r.dias.filter(d => d > hj); const meses = [...new Set(datas.map(d => d.slice(0, 7)))];
  const L = lojaCfg(loja); const extras = new Map(L.extras.map(x => [x.id, x])); const escalas = {};
  for (const mes of meses) {
    let e = E.ler(loja, mes);
    if (!e) { if (!ctx || !ctx.pontocerto) throw erro('Ainda não há escala de ' + mes + ': abra a Escala coletiva do mês para criá-la'); const [col, esc] = await Promise.all([ctx.pontocerto.colaboradores(), ctx.pontocerto.escalas()]); e = E.criarDoPontoCerto(loja, mes, col, esc, user); }
    if (['enviada_rh', 'validada_rh'].includes(e.status)) throw erro('A escala de ' + mes.split('-').reverse().join('/') + ' está em aprovação (' + E.STATUS_TXT[e.status] + '): peça a devolução antes de aplicar');
    if (!E.podeEditar(user, e)) throw erro('Você não pode alterar a escala de ' + mes.split('-').reverse().join('/'), 403);
    escalas[mes] = e;
  }
  const id = 'P-' + loja + '-' + de.replace(/-/g, '') + '-' + Date.now().toString(36); const antes = {}; let gravados = 0, preservados = 0;
  for (const mes of meses) {
    const e = escalas[mes]; antes[mes] = {}; const doMes = datas.filter(d => d.startsWith(mes));
    for (const l of r.linhas) {
      let f = e.funcionarios.find(x => String(x.id) === String(l.id));
      if (!f) { const x = extras.get(+l.id); if (!x) continue;                // linha prevista: entra na grade do mês como linha própria, a partir do primeiro dia aplicado
        const base = {}; for (let w = 0; w < 7; w++) base[w] = null; f = { id: x.id, nome: (x.vaga ? 'CONTRATAR · ' : '') + x.nome, matricula: '', cargo: x.grupo.toUpperCase(), setor_pc: x.setor, setor: x.setor, turno: '', base, folga_fixa: l.folgaFixa ? [l.folgaFixa] : [], habilitado: [], extra: true, vaga: !!x.vaga }; e.funcionarios.push(f); }
      for (const d of doMes) {
        const c = l.dias[d]; const k = f.id + '|' + d; const ov = e.dias[k];
        if (c.tipo !== 'trabalho' && c.tipo !== 'folga') continue;          // férias, afastamento e fora do quadro já vêm do ponto / do RH
        if (ov && ov.origem !== 'gerador') { preservados++; continue; }     // dia ajustado à mão nunca é sobrescrito
        antes[mes][k] = ov || null;
        e.dias[k] = c.tipo === 'trabalho' ? { tipo: 'trabalho', entrada: c.entrada, saida: c.saida, almoco_ini: c.almoco_ini, almoco_fim: c.almoco_fim, setor: f.setor, obs: '', origem: 'gerador', modelo: 'planilha', turno: c.turno, geracao: id }
          : { tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor, obs: '', folga: c.folga, origem: 'gerador', modelo: 'planilha', geracao: id };
        gravados++;
      }
    }
  }
  if (!gravados) throw erro('Nada a aplicar: todos os dias do período já estão ajustados à mão ou fora do quadro');
  const texto = 'Escala gerada por período (modelo da planilha) de ' + br(datas[0]) + ' a ' + br(ate) + ': ' + gravados + ' dia(s)' + (preservados ? ', ' + preservados + ' ajuste(s) manual(is) preservado(s)' : '') + ' · ' + just;
  for (const mes of meses) { const e = escalas[mes]; if (!Object.keys(antes[mes]).length) continue; E.reabrirSeAprovada(e, user, 'Escala gerada por período após a aprovação: volta para proposta'); e.fluxo.push({ em: new Date().toISOString(), usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de: e.status, para: e.status, texto }); E.salvar(e); }
  const g = { id, loja: +loja, de: datas[0], ate, pedido: { de, ate }, em: new Date().toISOString(), usuario: user.usuario, nome: user.nome || user.usuario, justificativa: just, meses, dias: gravados, preservados, resumo: r.resumo, antes };
  gravarJson(P.ger(id), g); salvarLoja(loja, l => { l.ativo = true; }, user);
  GP.auditar({ usuario: user.usuario, acao: 'escala_periodo_aplicar', ref: id, loja: +loja, de: datas[0], ate, dias: gravados, preservados });
  return { ok: true, geracao: resumoGeracao(g), meses, dias: gravados, preservados, aPartirDe: datas[0] };
}
/** Desfaz uma aplicação: cada dia que ainda é o daquela geração volta ao que era antes (dia mexido depois fica como está). */
function desfazer(user, loja, id, justificativa) {
  if (!podeAplicar(user, loja)) throw erro('Só o gerente da unidade ou o RH Ponto desfazem a aplicação', 403);
  const g = lerJson(P.ger(String(id).replace(/[^A-Za-z0-9-]/g, '')), null); if (!g || +g.loja !== +loja) throw erro('Geração não encontrada', 404); if (g.desfeita) throw erro('Esta geração já foi desfeita');
  const just = txt(justificativa, 500); if (just.length < 10) throw erro('Escreva a justificativa (mínimo de 10 caracteres)');
  let voltou = 0, ficaram = 0;
  for (const mes of g.meses) {
    const e = E.ler(loja, mes); if (!e) continue; if (['enviada_rh', 'validada_rh'].includes(e.status)) throw erro('A escala de ' + mes.split('-').reverse().join('/') + ' está em aprovação: peça a devolução antes de desfazer');
    if (!E.podeEditar(user, e)) throw erro('Você não pode alterar a escala de ' + mes.split('-').reverse().join('/'), 403);
    for (const [k, ant] of Object.entries(g.antes[mes] || {})) { const at = e.dias[k]; if (!at || at.geracao !== g.id) { ficaram++; continue; } if (ant) e.dias[k] = ant; else delete e.dias[k]; voltou++; }
    E.reabrirSeAprovada(e, user, 'Geração por período desfeita após a aprovação: volta para proposta');
    e.fluxo.push({ em: new Date().toISOString(), usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de: e.status, para: e.status, texto: 'Geração por período de ' + br(g.de) + ' a ' + br(g.ate) + ' desfeita: ' + just }); E.salvar(e);
  }
  g.desfeita = { em: new Date().toISOString(), usuario: user.usuario, nome: user.nome || user.usuario, justificativa: just, voltou, ficaram }; gravarJson(P.ger(g.id), g);
  GP.auditar({ usuario: user.usuario, acao: 'escala_periodo_desfazer', ref: g.id, loja: +loja, voltou, ficaram });
  return { ok: true, voltou, ficaram };
}

module.exports = { P, cfg, lojaCfg, visual, modeloNoMes, podeVer, podeCadastrar, podeAplicar, normTurnos, quadro, cadastro, salvarCadastro, gerar, aplicar, desfazer, listarGeracoes, resumoGeracao, historico };
