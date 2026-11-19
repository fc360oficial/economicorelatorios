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
  params: { ...M.PARAMS_PADRAO, ...(l.params || {}) }, pessoas: l.pessoas || {}, extras: l.extras || [], seq: l.seq || 0, modeloContrato: l.modeloContrato === true, alteradoEm: l.alteradoEm || null, alteradoPor: l.alteradoPor || null }; }
function salvarLoja(loja, fn, user) { const c = cfg(); const l = c.lojas[loja] || {}; fn(l); l.alteradoEm = new Date().toISOString(); l.alteradoPor = user ? user.usuario : 'sistema'; c.lojas[loja] = l; c.versao++; gravarJson(P.cfg(), c); return lojaCfg(loja); }
/** O que a Escala coletiva precisa para pintar igual à planilha: só vale na loja que já usa o modelo. */
function visual(loja) { const l = lojaCfg(loja); return { ativo: l.ativo, corFolga: M.COR_FOLGA, turnos: Object.entries(l.turnos).map(([codigo, t]) => ({ codigo, entrada: t.entrada, saida: t.saida, almoco_ini: t.almoco_ini || null, almoco_fim: t.almoco_fim || null, cor: t.cor, texto: M.corTexto(t.cor), domingo: t.domingo || codigo })) }; }
/** Visão compacta (modelo da planilha) de QUALQUER grade: põe em cada dia de trabalho o código do turno (`cod`) e devolve a
 *  tabela código × horário × cor. Jornada que ainda não tem código ganha o próximo (T.6, T.7…) e ele fica gravado no cadastro
 *  da loja, para o mesmo horário ter sempre o mesmo código e a mesma cor. Não altera a escala: só a apresentação. */
const CORES_EXTRA = ['#F4B183', '#9DC3E6', '#C9C9C9', '#F7A8C8', '#B4A7D6', '#8FD3C8', '#E2B36B', '#D9E57A', '#F28E8E', '#7FB3FF', '#C6A98A', '#A9D18E', '#5FC8D8', '#E59AD6', '#FFC773', '#8E9BD9', '#B7C66A', '#F2A07B', '#7FD1A6', '#D0B0E8', '#9FB8C8', '#E8D06B', '#D98C8C', '#6FAFC0'];
const MAX_TURNOS = 40;
const chaveTurno = t => [t.entrada, t.saida, t.almoco_ini || '', t.almoco_fim || ''].join('|');
function codificar(loja, funcs, opts) {
  const gravar = !(opts && opts.gravar === false);   // simulação (proposta ainda não aplicada) usa códigos só para a tela: não ocupa a tabela da loja
  let turnos = lojaCfg(loja).turnos; let porChave = new Map(Object.entries(turnos).map(([k, t]) => [chaveTurno(t), k])); const faltam = new Map();
  const jornadas = []; for (const f of funcs || []) for (const d of Object.values(f.dias || {})) if (d && d.tipo === 'trabalho' && HM.test(d.entrada || '') && HM.test(d.saida || '')) { jornadas.push(d); const c = chaveTurno(d); if (!porChave.has(c)) faltam.set(c, (faltam.get(c) || 0) + 1); }
  if (faltam.size) {
    let n = Math.max(0, ...Object.keys(turnos).map(k => +(String(k).match(/^T\.(\d+)$/) || [])[1] || 0)); const novos = {};
    for (const [c] of [...faltam].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) { if (Object.keys(turnos).length + Object.keys(novos).length >= MAX_TURNOS) break; const [entrada, saida, ai, af] = c.split('|'); if (saida <= entrada) continue; n++; novos['T.' + n] = { entrada, saida, almoco_ini: ai || null, almoco_fim: af || null, cor: CORES_EXTRA[(n - 6 + CORES_EXTRA.length * 10) % CORES_EXTRA.length], domingo: 'T.' + n, auto: true }; }
    if (Object.keys(novos).length) { if (gravar) { try { turnos = salvarLoja(loja, l => { l.turnos = { ...turnos, ...novos }; }, null).turnos; } catch (e) { turnos = { ...turnos, ...novos }; } } else turnos = { ...turnos, ...novos }; porChave = new Map(Object.entries(turnos).map(([k, t]) => [chaveTurno(t), k])); }
  }
  const usos = {}; for (const d of jornadas) { const k = porChave.get(chaveTurno(d)); if (k) { d.cod = k; usos[k] = (usos[k] || 0) + 1; } }
  const num = k => +(String(k).match(/(\d+)$/) || [])[1] || 0;
  return { ativo: true, corFolga: M.COR_FOLGA, turnos: Object.entries(turnos).sort((a, b) => num(a[0]) - num(b[0]) || a[0].localeCompare(b[0])).map(([codigo, t]) => ({ codigo, entrada: t.entrada, saida: t.saida, almoco_ini: t.almoco_ini || null, almoco_fim: t.almoco_fim || null, cor: t.cor, texto: M.corTexto(t.cor), n: usos[codigo] || 0 })) };
}
// ── Cadastro da pessoa visto pelos outros módulos (Gerador 5×2, Escala coletiva, PDF) ──────────────────────
const soLetras = s => semAcento(s).replace(/[^A-Z ]/g, '').replace(/ +/g, ' ').trim();
/** Loja em que alguém já conferiu e gravou o cadastro (turno / folga fixa / função por pessoa). Desde 19/11/2026 (Donato/Tiago:
 *  "quero que fique somente esse modelo; replique para todas as lojas e também para o CD") o modelo da planilha vale em TODA
 *  unidade: sem cadastro gravado, turno, função e folga fixa saem do contrato do ponto como sugestão (ver turnoFixoDe e funcaoPadrao). */
const lojaConfigurada = L => Object.keys(L.pessoas || {}).length > 0 || (L.extras || []).length > 0;
/** Função na escala para quem ainda não tem cadastro: o cargo do ponto, juntando as grafias do mesmo cargo
 *  ("OPERADORA DE CAIXA", "OPERAODR DE CAIXA" → Caixa). O gerente troca na aba Cadastro. */
const FUNCOES_PADRAO = [[/^OPERA[A-Z]* DE CAIXA$|^CAIXA$/, 'Caixa'], [/^FISCAL DE CAIXA$/, 'Fiscal de Caixa'], [/ACOUGU/, 'Açougue'], [/PADEIRO|FORNEIRO/, 'Padeiro'], [/PASTEL/, 'Pastelaria'], [/SERVICOS GERAIS|^ASG$/, 'ASG'], [/PREVENCAO/, 'Prevenção'], [/^CONFERENTE$/, 'Conferente']];
function funcaoPadrao(cargo, setor) { const c = semAcento(cargo).replace(/[^A-Z ]/g, ' ').replace(/ +/g, ' ').trim(); for (const [re, nome] of FUNCOES_PADRAO) if (re.test(c)) return nome; return titulo(cargo) || E.setorTxt(setor); }
/** Ordem das funções quando a loja ainda não gravou a dela: a da planilha da E5; o que não está na lista vem depois, por nome, e a gerência por último. */
const ORDEM_FUNCOES = ['Caixa', 'Fiscal de Caixa', 'Frente de Loja', 'Seção', 'Op loja/frios', 'Op loja/horti', 'Operador de Loja', 'Balconista', 'Padeiro', 'Pastelaria', 'Sopa', 'Açougue', 'CPD', 'Prevenção', 'Fiscal de Loja', 'Segurança', 'Estoquista', 'ASG', 'Conferente'];
const FUNCOES_FIM = ['Aux. Administrativo', 'Encarregado de Setor', 'Encarregado de Loja', 'Coordenador Administrativo', 'Subgerente', 'Gerente', 'Gerente Geral'];
/** Posição de cada função na escala. `linhas` = [{ grupo, ordem }]: quem tem ordem gravada no cadastro manda (na ordem dela); o resto segue ORDEM_FUNCOES. */
function ordemDasFuncoes(linhas) {
  const og = {}; const padrao = g => { const i = ORDEM_FUNCOES.indexOf(g); if (i >= 0) return i; const j = FUNCOES_FIM.findIndex(x => semAcento(x) === semAcento(g)); return j >= 0 ? 900 + j : 500; };
  linhas.filter(x => x.ordem != null).sort((a, b) => a.ordem - b.ordem).forEach(x => { if (og[x.grupo] == null) og[x.grupo] = Object.keys(og).length; });
  [...new Set(linhas.filter(x => x.ordem == null).map(x => x.grupo))].sort((a, b) => padrao(a) - padrao(b) || String(a).localeCompare(String(b))).forEach(g => { if (og[g] == null) og[g] = Object.keys(og).length; });
  return og;
}
/** Turno da tabela mais parecido com a jornada de contrato da pessoa: menor diferença de entrada + saída (quem fecha a loja às
 *  20h cai no turno de fechamento, não no de entrada vizinha); empate fica com a entrada mais próxima. Prefere os turnos
 *  cadastrados aos criados sozinhos pela visão compacta. Sem jornada no ponto, o primeiro turno. */
function turnoMaisProximo(T, f) {
  const mn = M._util.min; const b = Object.values((f && f.base) || {}).find(Boolean); const base = Object.keys(T).filter(x => !T[x].auto); const cand = base.length ? base : Object.keys(T);
  if (!b || !HM.test(b.entrada || '')) return cand[0] || null; const en = mn(b.entrada), sa = HM.test(b.saida || '') ? mn(b.saida) : null;
  const dEn = k => Math.abs(mn(T[k].entrada) - en), dist = k => dEn(k) + (sa == null ? 0 : Math.abs(mn(T[k].saida) - sa));
  return cand.slice().sort((a, z) => dist(a) - dist(z) || dEn(a) - dEn(z))[0] || null;
}
/** Cadastro de uma pessoa: pelo id do ponto ou, se ela era uma "linha prevista" e depois entrou no ponto, pelo nome. */
function cadastroDe(L, f, todos) {
  if (!f) return null; const c = L.pessoas[f.id]; if (c) return c;
  let x = L.extras.find(e => String(e.id) === String(f.id)) || (f.nome ? L.extras.find(e => !e.vaga && soLetras(e.nome) === soLetras(f.nome)) : null);
  // a planilha traz gente só com o primeiro nome (CAMILA, LIDIANE…): vale quando só uma pessoa do quadro tem esse primeiro nome
  if (!x && f.nome && Array.isArray(todos)) { const pn = soLetras(f.nome).split(' ')[0]; const cand = L.extras.filter(e => !e.vaga && soLetras(e.nome) === pn); if (cand.length === 1 && todos.filter(o => soLetras(o.nome).split(' ')[0] === pn).length === 1) x = cand[0]; }
  return x ? { turno: x.turno, folgaFixa: x.folgaFixa, domingo: x.domingo, grupo: x.grupo, ordem: x.ordem, deExtra: x.id } : null;
}
/** Turno da planilha que a pessoa cumpre (o do cadastro; sem cadastro, o de entrada mais próxima do contrato) e o turno de domingo dele. */
function turnoFixoDe(loja, f, todos) {
  // `modeloContrato: true` no cadastro da loja (planilha.json, sem tela) devolve o Gerador 5×2 à jornada de contrato do ponto:
  // é a saída de emergência de uma unidade e o que mantém os testes do gerador livre. Nenhuma unidade nasce assim.
  const L = lojaCfg(loja); if (L.modeloContrato) return null; const c = cadastroDe(L, f, todos) || {}; const T = L.turnos;
  let k = c.turno && T[c.turno] ? c.turno : null; const sugerido = !k;
  if (!k) k = turnoMaisProximo(T, f);
  if (!k) return null; const t = T[k]; const kd = t.domingo && T[t.domingo] ? t.domingo : k; const d = T[kd]; const campos = (cod, x) => ({ codigo: cod, entrada: x.entrada, saida: x.saida, almoco_ini: x.almoco_ini || null, almoco_fim: x.almoco_fim || null });
  return { ...campos(k, t), domingo: campos(kd, d), folgaFixa: c.folgaFixa >= 1 && c.folgaFixa <= 6 ? +c.folgaFixa : null, sugerido };
}
/** Organiza as linhas como a planilha: por função (na ordem do cadastro da loja) e, dentro dela, na ordem gravada ou por nome.
 *  Põe `grupo` (a função na escala) em cada linha. Vale em toda unidade: sem cadastro, a função vem do cargo do ponto. */
function organizar(loja, lista) {
  const L = lojaCfg(loja); const linhas = (lista || []).map((f, i) => { const c = cadastroDe(L, f, lista) || {}; f.grupo = txt(c.grupo, 40) || funcaoPadrao(f.cargo, f.setor); return { f, i, ordem: c.ordem != null ? +c.ordem : null }; });
  const og = ordemDasFuncoes(linhas.map(x => ({ grupo: x.f.grupo, ordem: x.ordem })));
  return linhas.sort((a, b) => og[a.f.grupo] - og[b.f.grupo] || (a.ordem == null) - (b.ordem == null) || (a.ordem || 0) - (b.ordem || 0) || String(a.f.nome).localeCompare(String(b.f.nome))).map(x => x.f);
}
/** Linhas previstas que ainda não viraram gente do ponto (vaga a contratar ou pessoa incluída à mão): entram na escala com o
 *  turno e a folga fixa delas. `funcs` = quadro do ponto, para não repetir quem já entrou. */
function previstas(loja, funcs) {
  const L = lojaCfg(loja); const usadas = new Set(); const ids = new Set((funcs || []).map(f => String(f.id)));
  for (const f of funcs || []) { const c = cadastroDe(L, f, funcs); if (c && c.deExtra != null) usadas.add(c.deExtra); }
  return L.extras.filter(x => !usadas.has(x.id) && !ids.has(String(x.id))).map(x => ({ ...x, nomeNaEscala: (x.vaga ? 'CONTRATAR · ' : '') + x.nome, turnoFixo: turnoFixoDe(loja, { id: x.id, nome: x.nome, base: {} }) }));
}
/** Inclui uma pessoa ou uma vaga na escala da loja (sem passar pelo ponto): nome, função, setor, turno e folga fixa. */
function incluirPrevisto(user, loja, b) {
  if (!podeCadastrar(user, loja)) throw erro('Só o gerente da unidade, o RH Ponto ou a Coordenação incluem pessoas ou vagas na escala', 403);
  b = b || {}; const L = lojaCfg(loja); const vaga = !!b.vaga; const grupo = txt(b.grupo, 40); if (!grupo) throw erro('Informe a função (ex.: Caixa, Seção, Balconista)');
  const nome = (txt(b.nome, 80) || (vaga ? grupo : '')).toUpperCase(); if (!nome) throw erro('Informe o nome do funcionário');
  if (!b.turno || !L.turnos[b.turno]) throw erro('Escolha o turno'); const fixa = +b.folgaFixa >= 1 && +b.folgaFixa <= 6 ? +b.folgaFixa : null; if (!fixa) throw erro('Escolha o dia da folga fixa (segunda a sábado)');
  if (L.extras.length >= 80) throw erro('No máximo 80 linhas incluídas por loja');
  if (!vaga && L.extras.some(x => !x.vaga && soLetras(x.nome) === soLetras(nome))) throw erro(nome + ' já está incluído(a) na escala desta loja');
  let novo = null;
  salvarLoja(loja, l => { const seq = (l.seq || 0) + 1; const maior = Math.max(-1, ...(l.extras || []).map(x => (x.ordem == null ? -1 : +x.ordem)), ...Object.values(l.pessoas || {}).map(p => (p.ordem == null ? -1 : +p.ordem)));
    const doGrupo = [...(l.extras || []), ...Object.values(l.pessoas || {})].filter(x => x.grupo === grupo && x.ordem != null).map(x => +x.ordem);   // entra no fim da função dela
    novo = { id: -(9000 + seq), nome, grupo, setor: semAcento(b.setor) || E.setorOperacional(grupo), turno: b.turno, folgaFixa: fixa, domingo: b.domingo !== false, vaga, obs: txt(b.obs, 120) || (vaga ? 'vaga a contratar' : 'incluído à mão'), em: new Date().toISOString(), por: user.nome || user.usuario, ordem: doGrupo.length ? Math.max(...doGrupo) + 0.5 : maior + 1 };
    l.extras = (l.extras || []).concat([novo]); l.seq = seq; }, user);
  GP.auditar({ usuario: user.usuario, acao: 'escala_incluir_previsto', loja: +loja, id: novo.id, nome: novo.nome, grupo, turno: novo.turno, vaga });
  return { ok: true, id: novo.id, nome: novo.nome };
}
function removerPrevisto(user, loja, id) {
  if (!podeCadastrar(user, loja)) throw erro('Só o gerente da unidade, o RH Ponto ou a Coordenação tiram pessoas ou vagas da escala', 403);
  const L = lojaCfg(loja); const x = L.extras.find(e => String(e.id) === String(id)); if (!x) throw erro('Linha não encontrada', 404);
  salvarLoja(loja, l => { l.extras = (l.extras || []).filter(e => String(e.id) !== String(id)); }, user);
  GP.auditar({ usuario: user.usuario, acao: 'escala_remover_previsto', loja: +loja, id: x.id, nome: x.nome });
  return { ok: true, nome: x.nome };
}
/** Ocupa uma vaga (linha CONTRATAR) com o funcionário escolhido (19/11/2026, Tiago): ele assume a função, o turno e a folga
 *  fixa da vaga e, nas grades já salvas do mês atual em diante, os dias que estavam na linha da vaga (só de amanhã em diante;
 *  dia que ele tinha ajustado à mão fica). `funcId` = pessoa do VR da loja; sem ele, `nome` = quem ainda não está no VR (a
 *  linha deixa de ser vaga e passa a levar o nome). `abrirVaga` = a posição que a pessoa deixa vira uma vaga a contratar. */
async function ocuparVaga(user, loja, b, ctx) {
  if (!podeCadastrar(user, loja)) throw erro('Só o gerente da unidade, o RH Ponto ou a Coordenação definem quem ocupa uma vaga', 403);
  b = b || {}; const L = lojaCfg(loja); const V = L.extras.find(x => String(x.id) === String(b.id) && x.vaga); if (!V) throw erro('Vaga não encontrada: ela pode já ter sido ocupada ou tirada da escala', 404);
  const hj = (ctx && ctx.hoje) || hojeISO(); const mesHj = hj.slice(0, 7); const funcId = +b.funcId > 0 ? +b.funcId : null; const nomeNovo = funcId ? null : txt(b.nome, 80).toUpperCase();
  if (!funcId && !nomeNovo) throw erro('Escolha o funcionário ou escreva o nome de quem vai ocupar a vaga');
  let f = null, antigo = null;
  if (funcId) { const base = await quadroBase(loja, mesHj, ctx || {}); f = base.find(x => String(x.id) === String(funcId) && !x.extra); if (!f) throw erro('Funcionário não está no quadro desta loja', 404); antigo = cadastroDe(L, f, base); }
  else if (L.extras.some(x => !x.vaga && soLetras(x.nome) === soLetras(nomeNovo))) throw erro(nomeNovo + ' já está incluído(a) na escala desta loja');
  const abrir = !!(funcId && b.abrirVaga === true && antigo && antigo.turno && antigo.folgaFixa && antigo.grupo);   // só quem tinha posição definida deixa uma vaga
  // grades que já têm a linha da vaga: confere tudo antes de gravar qualquer coisa
  const mmaa = m => m.split('-').reverse().join('/');
  const grades = E.listar().filter(x => x.loja === +loja && x.mes >= mesHj).map(x => E.ler(loja, x.mes)).filter(e => e && e.funcionarios.some(x => String(x.id) === String(V.id)));
  for (const e of grades) { if (['enviada_rh', 'validada_rh'].includes(e.status) && !E.podeEditar(user, e)) throw erro('A escala de ' + mmaa(e.mes) + ' está em aprovação (' + E.STATUS_TXT[e.status] + '): peça a devolução antes de ocupar a vaga', 409);
    if (!E.podeEditar(user, e)) throw erro('A vaga já está gravada na escala de ' + mmaa(e.mes) + ', e só o gerente da unidade ou o RH Ponto alteram essa escala', 403); }
  const agora = new Date().toISOString(); const por = user.nome || user.usuario; const nome = funcId ? f.nome : nomeNovo; const nomeVaga = abrir ? String(antigo.grupo).toUpperCase() : null; const setorVaga = abrir ? (f.setor || E.setorOperacional(antigo.grupo)) : null;
  salvarLoja(loja, l => {
    l.extras = l.extras || []; const v = l.extras.find(x => String(x.id) === String(V.id)); if (!v) throw erro('Vaga não encontrada', 404);
    if (!funcId) { Object.assign(v, { nome: nomeNovo, vaga: false, obs: 'ocupou a vaga de ' + V.grupo, em: agora, por }); return; }
    if (!l.turnos || !Object.keys(l.turnos).length) l.turnos = L.turnos;
    l.pessoas = l.pessoas || {}; l.pessoas[funcId] = { turno: V.turno || null, folgaFixa: V.folgaFixa || null, domingo: V.domingo !== false, grupo: V.grupo || null, ordem: V.ordem != null ? V.ordem : null };
    if (antigo && antigo.deExtra != null) l.extras = l.extras.filter(x => x.id !== antigo.deExtra);   // a linha incluída à mão era a própria pessoa
    if (abrir) Object.assign(v, { nome: nomeVaga, grupo: antigo.grupo, setor: setorVaga, turno: antigo.turno, folgaFixa: +antigo.folgaFixa, domingo: antigo.domingo !== false, ordem: antigo.ordem != null ? antigo.ordem : null, vaga: true, obs: 'vaga aberta: ' + f.nome + ' passou para ' + V.grupo, em: agora, por });
    else l.extras = l.extras.filter(x => String(x.id) !== String(V.id));
  }, user);
  let movidos = 0, preservados = 0; const meses = [];
  for (const e of grades) {
    const rv = e.funcionarios.find(x => String(x.id) === String(V.id));
    if (!funcId) { rv.nome = nomeNovo; rv.vaga = false; }
    else {
      let rp = e.funcionarios.find(x => String(x.id) === String(funcId)); if (!rp) { rp = JSON.parse(JSON.stringify(f)); e.funcionarios.push(rp); }
      for (const data of E.diasDoMes(e.mes)) { if (data <= hj) continue; const kv = V.id + '|' + data, kp = funcId + '|' + data; const dv = e.dias[kv], dp = e.dias[kp]; if (!dv) continue;
        if (dp && dp.origem !== 'gerador') { preservados++; continue; }             // dia que a pessoa tinha ajustado à mão não é trocado
        e.dias[kp] = dv; movidos++; if (abrir && dp) e.dias[kv] = dp; else delete e.dias[kv]; }
      if (abrir) Object.assign(rv, { nome: 'CONTRATAR · ' + nomeVaga, cargo: nomeVaga, setor_pc: setorVaga, setor: setorVaga, folga_fixa: [+antigo.folgaFixa], vaga: true });
      else { e.funcionarios = e.funcionarios.filter(x => x !== rv); for (const k of Object.keys(e.dias)) if (k.startsWith(V.id + '|')) delete e.dias[k]; }
    }
    E.reabrirSeAprovada(e, user, 'Vaga ocupada após a aprovação: volta para proposta');
    e.fluxo.push({ em: agora, usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de: e.status, para: e.status, texto: nome + ' passou a ocupar a vaga de ' + V.grupo + (V.turno ? ' (' + V.turno + ')' : '') + (abrir ? ' · aberta vaga de ' + antigo.grupo + ' no lugar' : '') });
    E.salvar(e); meses.push(e.mes);
  }
  GP.auditar({ usuario: user.usuario, acao: 'escala_ocupar_vaga', loja: +loja, vaga: V.id, grupo: V.grupo, turno: V.turno || null, funcId, nome, abriuVaga: abrir ? antigo.grupo : null, meses, dias: movidos, preservados });
  return { ok: true, nome, grupo: V.grupo, turno: V.turno || null, meses, dias: movidos, preservados, abriuVaga: abrir ? antigo.grupo : null };
}
/** Pessoa do VR que o cadastro tirou da escala desta loja (não entra em nenhuma geração; nada é apagado). */
const foraDaEscala = (loja, f) => !!((lojaCfg(loja).pessoas[f && f.id] || {}).fora);
/** Altera o cadastro de UMA pessoa ou vaga (turno, folga fixa, função, domingo, na escala) — usado ao clicar no horário dela na proposta. */
async function salvarPessoa(user, loja, b, ctx) {
  if (!podeCadastrar(user, loja)) throw erro('Só o gerente da unidade, o RH Ponto ou a Coordenação alteram o cadastro da escala', 403);
  b = b || {}; const id = +b.id; if (!id) throw erro('Pessoa inválida'); const L = lojaCfg(loja);
  if ('turno' in b && !(b.turno && L.turnos[b.turno])) throw erro('Escolha o turno'); if ('folgaFixa' in b && !(+b.folgaFixa >= 1 && +b.folgaFixa <= 6)) throw erro('Escolha o dia da folga fixa (segunda a sábado)');
  const aplicar = x => { if ('turno' in b) x.turno = b.turno; if ('folgaFixa' in b) x.folgaFixa = +b.folgaFixa; if ('grupo' in b && txt(b.grupo, 40)) x.grupo = txt(b.grupo, 40); if ('domingo' in b) x.domingo = b.domingo !== false; if ('fora' in b) { if (b.fora === true) x.fora = true; else delete x.fora; } return x; };
  let herdada = null, nome = txt(b.nome, 80);
  if (id > 0 && !L.pessoas[id]) { const base = await quadroBase(loja, hojeISO().slice(0, 7), ctx || {}); const f = base.find(x => String(x.id) === String(id)); if (!f) throw erro('Funcionário não está no quadro desta loja', 404); nome = f.nome; herdada = cadastroDe(L, f, base); }
  salvarLoja(loja, l => {
    if (!l.turnos || !Object.keys(l.turnos).length) l.turnos = L.turnos;
    if (id < 0) { const x = (l.extras || []).find(e => +e.id === id); if (!x) throw erro('Linha não encontrada', 404); aplicar(x); nome = x.nome; return; }
    l.pessoas = l.pessoas || {}; const c = l.pessoas[id] || (herdada ? { turno: herdada.turno || null, folgaFixa: herdada.folgaFixa || null, domingo: herdada.domingo !== false, grupo: herdada.grupo || null, ordem: herdada.ordem != null ? herdada.ordem : null } : { turno: null, folgaFixa: null, domingo: true, grupo: null, ordem: null });
    l.pessoas[id] = aplicar(c); if (herdada && herdada.deExtra != null) l.extras = (l.extras || []).filter(e => e.id !== herdada.deExtra);   // a linha incluída à mão virou a pessoa do VR
  }, user);
  GP.auditar({ usuario: user.usuario, acao: 'escala_cadastro_pessoa', loja: +loja, id, nome, campos: Object.keys(b).filter(k => ['turno', 'folgaFixa', 'grupo', 'domingo', 'fora'].includes(k)) });
  return { ok: true, nome };
}
/** Troca o horário de UM dia pelo turno escolhido (ou por folga): vira dia ajustado à mão na grade do mês — fica na auditoria
 *  com a justificativa e o gerador não mexe mais nele. Se o mês ainda não tem grade, ela nasce do VR aqui. */
async function editarDiaTurno(user, loja, b, ctx) {
  b = b || {}; const data = String(b.data || ''); if (!ISO.test(data)) throw erro('Dia inválido'); const mes = data.slice(0, 7); const L = lojaCfg(loja);
  const folga = b.turno === 'FOLGA'; const t = folga ? null : L.turnos[b.turno]; if (!folga && !t) throw erro('Escolha o turno');
  if (+b.funcId < 0) throw erro('Vaga ou pessoa incluída à mão ainda não tem linha na grade do mês: para ela, mude o turno em “todos os dias”');
  let e = E.ler(loja, mes);
  if (!e) { if (!ctx || !ctx.pontocerto) throw erro('Ainda não há escala de ' + mes.split('-').reverse().join('/') + ': abra a Escala coletiva do mês para criá-la'); const [col, esc] = await Promise.all([ctx.pontocerto.colaboradores(), ctx.pontocerto.escalas()]); e = E.criarDoPontoCerto(loja, mes, col, esc, user); GP.auditar({ usuario: user.usuario, acao: 'escala_criar', ref: 'ESC-' + loja + '-' + mes }); }
  if (!e.funcionarios.some(f => String(f.id) === String(b.funcId))) { const base = await quadroBase(loja, mes, ctx || {}); const f = base.find(x => String(x.id) === String(b.funcId)); if (!f) throw erro('Funcionário não está no quadro desta loja', 404); e.funcionarios.push(JSON.parse(JSON.stringify(f))); E.salvar(e); }
  let afast = null; try { const a = await ausenciasDoPonto(mes + '-01', E.diasDoMes(mes).pop(), ctx); afast = new Map([...a.mapa].map(([n, l]) => [n, l.map(x => ({ inicio: x.inicio, fim: x.fim, ferias: x.tipo === 'ferias' }))])); } catch (er) {}
  const r = E.editarDia(loja, mes, user, folga ? { funcId: +b.funcId, data, tipo: 'folga', justificativa: b.justificativa } : { funcId: +b.funcId, data, tipo: 'trabalho', entrada: t.entrada, saida: t.saida, almoco_ini: t.almoco_ini || null, almoco_fim: t.almoco_fim || null, justificativa: b.justificativa, obs: b.turno }, afast);
  return { ok: true, avisos: r.avisos || [] };
}
/** Faltando contratar: as vagas (linhas CONTRATAR) de cada loja que o usuário vê, por função e turno — é a lista de trabalho do RH. */
function faltando(user) {
  const lojas = []; let total = 0;
  for (const n of GP.LOJAS) { if (!podeVer(user, n)) continue; const L = lojaCfg(n); const vs = L.extras.filter(x => x.vaga); if (!vs.length) continue; total += vs.length; const porF = {}; for (const v of vs) porF[v.grupo] = (porF[v.grupo] || 0) + 1;
    lojas.push({ loja: n, lojaTxt: GP.LOJA_TXT[n], vagas: vs.length, porFuncao: Object.entries(porF).map(([grupo, q]) => ({ grupo, vagas: q })), itens: vs.map(v => { const t = L.turnos[v.turno]; return { id: v.id, grupo: v.grupo, setor: v.setor, setorTxt: E.setorTxt(v.setor), turno: v.turno || null, horario: t ? t.entrada + '–' + t.saida : null, folgaFixa: v.folgaFixa || null, desde: v.em || null, por: v.por || null, obs: v.obs || '' }; }) }); }
  return { total, lojas };
}
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
  if (!Object.keys(out).length) throw erro('Cadastre pelo menos um turno'); if (Object.keys(out).length > MAX_TURNOS) throw erro('No máximo ' + MAX_TURNOS + ' turnos por loja');
  for (const [k, t] of Object.entries(out)) if (!out[t.domingo]) throw erro('O turno de domingo de ' + k + ' (' + t.domingo + ') não existe');
  return out;
}

// ── Quadro: ponto + linhas previstas ─────────────────────────────────────────────────────────────────────
/** Funcionários da loja no formato da escala: o arquivo do mês, o mais recente da loja ou, na falta, o ponto. */
async function quadroBase(loja, mes, ctx) {
  // direto do VR (ponto): o quadro de hoje da loja. Se o ponto não responder, vale o quadro que já está na grade.
  if (ctx && ctx.pontocerto && ctx.aoVivo !== false) { try { const [col, esc] = await Promise.all([ctx.pontocerto.colaboradores(!!ctx.forcar), ctx.pontocerto.escalas()]); const fs = E.funcsDoPontoCerto(loja, col, esc); if (fs.length) { ctx.vr = { ok: true, em: col.gerado_em || null, pessoas: fs.length }; return fs; } ctx.vr = { ok: false, erro: 'o VR não devolveu ninguém ativo nesta loja' }; } catch (er) { ctx.vr = { ok: false, erro: er.message }; } }
  let e = E.ler(loja, mes); if (e) return e.funcionarios;
  const outros = E.listar().filter(x => x.loja === +loja).map(x => x.mes).sort(); const perto = outros.filter(m => m <= mes).pop() || outros[0];
  if (perto) return E.ler(loja, perto).funcionarios;
  if (!ctx || !ctx.pontocerto) return [];
  const [col, esc] = await Promise.all([ctx.pontocerto.colaboradores(), ctx.pontocerto.escalas()]); return E.funcsDoPontoCerto(loja, col, esc);
}
const turnoPorEntrada = (turnos, f) => { const b = Object.values(f.base || {}).find(Boolean); if (!b) return null; const hit = Object.entries(turnos).find(([, t]) => t.entrada === b.entrada && t.saida === b.saida); return hit ? hit[0] : null; };
function titulo(s) { return String(s || '').toLowerCase().replace(/(^|[\s/])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/ (De|Da|Do|Das|Dos|E) /g, m => m.toLowerCase()); }
/** Pessoas do período: quem está no quadro da loja nas datas + as linhas previstas (admissão, transferência, vaga a contratar). */
async function quadro(loja, de, ate, ctx) {
  const L = lojaCfg(loja); const antigo = (lerJson(P.antigo(), {}) || {}).funcionarios || {}; const base = await quadroBase(loja, de.slice(0, 7), ctx || {});
  const pessoas = []; const usadas = new Set();
  for (const f of base) {
    if (f.extra) continue;                                                  // linha prevista já entrou num mês aplicado: vem do cadastro, não daqui
    const lim = E.limitesNaEscala({ loja: +loja }, f); if (lim && ((lim.fim && lim.fim < de) || (lim.inicio && lim.inicio > ate))) continue;
    const c = cadastroDe(L, f, base) || {}; if (c.deExtra != null) usadas.add(c.deExtra); const fx = c.folgaFixa != null ? +c.folgaFixa : antigo[f.id] && antigo[f.id].folga_fixa != null && +antigo[f.id].folga_fixa >= 1 ? +antigo[f.id].folga_fixa : null;
    const contrato = (f.folga_fixa || []).filter(d => d >= 1 && d <= 6);
    pessoas.push({ id: f.id, nome: f.nome, cargo: f.cargo || '', setor: f.setor, grupo: txt(c.grupo, 40) || funcaoPadrao(f.cargo, f.setor), turno: c.turno || turnoPorEntrada(L.turnos, f) || turnoMaisProximo(L.turnos, f), turnoSugerido: !c.turno, folgaFixa: fx || (contrato.length === 1 ? contrato[0] : null),
      folgaFixaOrigem: c.folgaFixa != null ? 'cadastro' : fx ? 'gerador 5×2' : contrato.length === 1 ? 'contrato do ponto' : null, domingo: c.domingo !== false, fora: c.fora === true, cadastrado: !!(c.turno && c.folgaFixa != null), ordem: c.ordem != null ? +c.ordem : null,
      ausencias: [...(lim && lim.fim && lim.fim < ate ? [{ inicio: soma(lim.fim, 1), fim: ate, tipo: 'afastado', saiu: true }] : []), ...(lim && lim.inicio && lim.inicio > de ? [{ inicio: de, fim: soma(lim.inicio, -1), tipo: 'afastado', saiu: true }] : [])] });
  }
  for (const x of L.extras) if (!usadas.has(x.id)) pessoas.push({ id: x.id, nome: x.nome, cargo: x.grupo, setor: x.setor || 'OUTROS', grupo: x.grupo, turno: x.turno || null, folgaFixa: x.folgaFixa || null, folgaFixaOrigem: x.folgaFixa ? 'cadastro' : null, domingo: x.domingo !== false, cadastrado: !!(x.turno && x.folgaFixa), ordem: x.ordem != null ? +x.ordem : null, extra: true, vaga: !!x.vaga, obs: x.obs || '', ausencias: [] });
  // ordem da planilha: por função (a ordem gravada no cadastro; sem cadastro, a ordem padrão das funções) e, dentro dela, a ordem gravada ou o nome
  const og = ordemDasFuncoes(pessoas);
  pessoas.sort((a, b) => og[a.grupo] - og[b.grupo] || (a.ordem == null) - (b.ordem == null) || (a.ordem || 0) - (b.ordem || 0) || a.vaga - b.vaga || a.nome.localeCompare(b.nome));
  return { L, pessoas, base };
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
  const hj = hojeISO(); const { L, pessoas } = await quadro(loja, hj, soma(hj, 60), ctx); const naEscala = pessoas.filter(p => !p.fora);
  // parâmetros gravados da loja: quantas pessoas cada função tem em cada turno (é nisso que as próximas gerações se baseiam)
  const qd = {}; for (const p of naEscala) { const g = qd[p.grupo] || (qd[p.grupo] = { grupo: p.grupo, total: 0, vagas: 0, semTurno: 0, turnos: {} }); g.total++; if (p.vaga) g.vagas++; if (p.turno) g.turnos[p.turno] = (g.turnos[p.turno] || 0) + 1; else g.semTurno++; }
  const grupos = [...new Set(pessoas.map(p => p.grupo))];
  return { loja: +loja, ativo: L.ativo, turnos: visual(loja).turnos, corFolga: M.COR_FOLGA, pesoDia: L.pesoDia, params: { maxDiasSeguidos: L.params.maxDiasSeguidos, maxDomingosSeguidos: L.params.maxDomingosSeguidos },
    vr: (ctx && ctx.vr) || null, configurada: lojaConfigurada(L), quadro: Object.values(qd),
    grupos: grupos.map(g => { const n = naEscala.filter(p => p.grupo === g).length, el = naEscala.filter(p => p.grupo === g && p.domingo).length; const v = L.efetivoDomingo[g]; return { grupo: g, pessoas: n, trabalhamDomingo: el, efetivoDomingo: v == null ? null : +v, padrao: M.efetivoPadrao(el) }; }),
    pessoas: pessoas.map(p => ({ id: p.id, nome: p.nome, cargo: p.cargo, setor: p.setor, setorTxt: E.setorTxt(p.setor), grupo: p.grupo, turno: p.turno, folgaFixa: p.folgaFixa, folgaFixaOrigem: p.folgaFixaOrigem, domingo: p.domingo, fora: !!p.fora, cadastrado: p.cadastrado, extra: !!p.extra, vaga: !!p.vaga, obs: p.obs || '' })),
    setores: [...new Set([...E.SETORES, ...pessoas.map(p => p.setor)])].map(s => ({ id: s, txt: E.setorTxt(s) })), podeCadastrar: podeCadastrar(user, loja), podeAplicar: podeAplicar(user, loja), alteradoEm: L.alteradoEm, alteradoPor: L.alteradoPor };
}
/** Grava o cadastro da loja: turnos, efetivo de domingo, pesos, pessoas (turno / folga fixa / domingo / função) e linhas previstas. */
function salvarCadastro(user, loja, b) {
  if (!podeCadastrar(user, loja)) throw erro('Só o gerente da unidade, o RH Ponto ou a Coordenação alteram o cadastro da escala', 403);
  b = b || {}; const atual = lojaCfg(loja); const turnos = b.turnos ? normTurnos(b.turnos) : atual.turnos; const cod = v => (v && turnos[v] ? v : null); const fixa = v => (+v >= 1 && +v <= 6 ? +v : null);
  // turno tirado da tabela não pode estar em uso: quem estava nele ficaria sem horário sem ninguém perceber
  const orfaos = [...(b.pessoas || []), ...(b.extras || [])].filter(p => p.turno && !turnos[p.turno]); if (orfaos.length) throw erro('O turno ' + orfaos[0].turno + ' saiu da tabela mas ainda está em ' + orfaos.length + ' linha(s): troque o turno delas antes de tirar');
  const r = salvarLoja(loja, l => {
    l.turnos = turnos;
    if (b.efetivoDomingo) { l.efetivoDomingo = {}; for (const [g, v] of Object.entries(b.efetivoDomingo)) { if (v === '' || v == null) continue; const n = Math.round(+v); if (!(n >= 0 && n <= 200)) throw erro('Efetivo de domingo inválido em ' + g); l.efetivoDomingo[txt(g, 40)] = n; } }
    if (b.pesoDia) { l.pesoDia = {}; for (let d = 1; d <= 6; d++) { const n = +b.pesoDia[d]; if (!(n >= 0 && n <= 5)) throw erro('Peso do dia inválido (0 a 5)'); l.pesoDia[d] = n; } }
    if (b.params) { const a = Math.round(+b.params.maxDiasSeguidos), d = Math.round(+b.params.maxDomingosSeguidos); if (!(a >= 5 && a <= 7) || !(d >= 1 && d <= 4)) throw erro('Limites inválidos: dias seguidos de 5 a 7, domingos seguidos de 1 a 4'); l.params = { maxDiasSeguidos: a, maxDomingosSeguidos: d }; }
    if (Array.isArray(b.pessoas)) { l.pessoas = l.pessoas || {}; b.pessoas.forEach((p, i) => { if (p.extra || !(+p.id > 0)) return; l.pessoas[p.id] = { turno: cod(p.turno), folgaFixa: fixa(p.folgaFixa), domingo: p.domingo !== false, grupo: txt(p.grupo, 40) || null, ordem: i, ...(p.fora === true ? { fora: true } : {}) }; }); }
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
  periodoOk(de, ate); const Q = await quadro(loja, de, ate, ctx); const L = Q.L, pessoas = Q.pessoas.filter(p => !p.fora); if (!pessoas.length) throw erro('Não há quadro para ' + GP.LOJA_TXT[loja] + ': abra a Escala coletiva do mês para criar a escala a partir do ponto, ou cadastre as linhas previstas.', 404);
  const aus = await ausenciasDoPonto(de, ate, ctx);
  for (const p of pessoas) if (!p.extra) p.ausencias = p.ausencias.concat(aus.mapa.get(semAcento(p.nome)) || []);
  const r = M.gerar({ de, ate, pessoas, turnos: L.turnos, efetivoDomingo: L.efetivoDomingo, pesoDia: L.pesoDia, params: L.params, historico: historico(loja, de, new Set(pessoas.map(p => String(p.id)))) });
  const porId = new Map(pessoas.map(p => [String(p.id), p]));
  for (const l of r.linhas) { const p = porId.get(String(l.id)); l.cargo = p.cargo; l.setor = p.setor; l.obs = p.obs || ''; for (const d of r.dias) { const a = p.ausencias.find(x => x.saiu && x.inicio <= d && x.fim >= d); if (a) l.dias[d] = { tipo: 'saiu', minutos: 0 }; } }
  const fer = E.config().feriados.filter(d => d >= de && d <= ate);
  Object.defineProperty(r, 'quadroBase', { value: new Map(Q.base.map(f => [String(f.id), f])), enumerable: false });   // para o aplicar pôr na grade quem entrou no VR depois que o mês foi criado
  return Object.defineProperty({ ...r, loja: +loja, lojaTxt: GP.LOJA_TXT[loja], visual: visual(loja), feriados: Object.fromEntries(fer.map(d => [d, E.nomeFeriado(d)])), pontoErro: aus.erro, vr: (ctx && ctx.vr) || null, hoje: hojeISO(), podeAplicar: podeAplicar(user, loja), podeCadastrar: podeCadastrar(user, loja) }, 'quadroBase', { value: r.quadroBase, enumerable: false });
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
      if (!f && +l.id > 0 && r.quadroBase && r.quadroBase.get(String(l.id))) { f = JSON.parse(JSON.stringify(r.quadroBase.get(String(l.id)))); e.funcionarios.push(f); }   // entrou no VR depois que a grade do mês foi criada
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

module.exports = { P, cfg, lojaCfg, visual, faltando, ocuparVaga, salvarPessoa, editarDiaTurno, foraDaEscala, codificar, organizar, turnoFixoDe, cadastroDe, lojaConfigurada, previstas, incluirPrevisto, removerPrevisto, modeloNoMes, podeVer, podeCadastrar, podeAplicar, normTurnos, quadro, cadastro, salvarCadastro, gerar, aplicar, desfazer, listarGeracoes, resumoGeracao, historico };
