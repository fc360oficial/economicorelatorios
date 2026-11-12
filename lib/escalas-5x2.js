'use strict';
// lib/escalas-5x2.js — serviço do Gerador Inteligente de Escalas 5×2 (DP / RH › Gerador de Escalas 5×2, 11/11/2026).
// Liga o motor puro (lib/escalas-gerador.js) à escala do mês (lib/escalas.js) e à central de pessoas:
//   · simular  → proposta + pendências, sem gravar nada
//   · aplicar  → grava a proposta como RASCUNHO da escala (nunca publica; a escala segue gerente → RH → Coordenação).
//                Escala aprovada vira nova versão; dia ajustado à mão nunca é sobrescrito; cada aplicação guarda o antes/depois.
//   · desfazer → devolve os dias daquela geração ao que eram (o que foi editado depois fica)
//   · analisar → valida jornada/folgas e cobertura da escala que está na grade
//   · regras trabalhistas por estabelecimento / categoria / vigência, validadas pelo RH (sem regra validada não aplica)
//   · auditoria encadeada por hash (só acrescenta; não existe rota de exclusão) e avisos à Coordenação com envio/entrega/visualização
// Nada aqui escreve no PontoCerto/VR. Dados novos em data/escalas: gerador.json, geracoes/*.json, gerador-auditoria.jsonl,
// gerador-avisos.jsonl (os arquivos <loja>-<mês>.json continuam sendo os da escala).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./escalas');
const GP = require('./gestao-pessoas');
const M = require('./escalas-gerador');
const { soma, dow, min } = M._util;

const P = { cfg: () => path.join(E.DIR, 'gerador.json'), gerDir: () => path.join(E.DIR, 'geracoes'), ger: id => path.join(E.DIR, 'geracoes', id + '.json'), aud: () => path.join(E.DIR, 'gerador-auditoria.jsonl'), avisos: () => path.join(E.DIR, 'gerador-avisos.jsonl') };
const erro = (msg, status = 400, extra) => Object.assign(new Error(msg), { status }, extra || {});
const agora = () => new Date().toISOString();
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; } };
function gravarJson(arq, obj) { fs.mkdirSync(path.dirname(arq), { recursive: true }); const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, arq); }
const lerLinhas = arq => { try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
function anexar(arq, obj) { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.appendFileSync(arq, JSON.stringify(obj) + '\n'); }
const hojeISO = () => E._util.diaISO();
const HM = /^([01]\d|2[0-3]):[0-5]\d$/, ISO = /^\d{4}-\d{2}-\d{2}$/, MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const mesAnterior = mes => { const [a, m] = mes.split('-').map(Number); return m === 1 ? (a - 1) + '-12' : a + '-' + String(m - 1).padStart(2, '0'); };
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const quem = u => ({ usuario: u.usuario, nome: u.nome || u.usuario, papeis: GP.papeisDe(u) });

// ── Permissões ───────────────────────────────────────────────────────────────────────────────────────────
const podeVer = (u, loja) => E.podeVer(u, loja);
const rhDa = (u, loja) => GP.rhDa(u, loja, 'rh_ponto');                       // quem gera, aplica, desfaz e ajusta o quadro
const podeRegras = u => GP.temPapel(u, 'rh_ponto', 'coordenacao');             // cadastra regra e cobertura
const podeValidarRegra = u => GP.temPapel(u, 'rh_ponto');                      // "validada pelo RH"
const exige = (cond, msg) => { if (!cond) throw erro(msg, 403); };

// ── Configuração do gerador (regras, cadastro por funcionário, cobertura por loja) ───────────────────────
function cfg() { const c = lerJson(P.cfg(), null) || {}; return { versao: c.versao || 1, regras: c.regras || [], funcionarios: c.funcionarios || {}, lojas: c.lojas || {}, historico: c.historico || {}, relatorioHora: c.relatorioHora == null ? 18 : c.relatorioHora }; }
function salvarCfg(c) { c.versao = (c.versao || 1) + 1; c.atualizadoEm = agora(); gravarJson(P.cfg(), c); return c; }

// ── Auditoria encadeada (cada registro leva o hash do anterior: apagar ou editar uma linha quebra a cadeia) ──
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function auditar(user, acao, dados) {
  const l = lerLinhas(P.aud()); const ant = l.length ? l[l.length - 1].hash : '';
  const reg = { seq: l.length + 1, em: agora(), ...(user ? quem(user) : { usuario: 'sistema', nome: 'Sistema', papeis: [] }), acao, ...(dados || {}), ant };
  reg.hash = sha(ant + JSON.stringify(reg)); anexar(P.aud(), reg);
  try { GP.auditar({ usuario: reg.usuario, acao: 'escala5x2_' + acao, ref: dados && dados.ref || null }); } catch (e) {}
  return reg;
}
function verificarCadeia() {
  const l = lerLinhas(P.aud()); let ant = '';
  for (const r of l) { const { hash, ...resto } = r; if (r.ant !== ant || sha(ant + JSON.stringify(resto)) !== hash) return { ok: false, registros: l.length, quebradaEm: r.seq }; ant = hash; }
  return { ok: true, registros: l.length, quebradaEm: null };
}

// ── Avisos à Coordenação (arquivo só de acréscimo: aviso → envio; entrega e visualização entram como eventos) ──
function avisar({ nivel, loja, mes, texto, autor, ref }) {
  const id = 'AV-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); const base = { id, em: agora(), nivel, loja: loja == null ? null : +loja, mes: mes || null, texto: txt(texto, 400), autor: autor ? autor.usuario : 'sistema', ref: ref || null };
  if (nivel === 'rotina') { anexar(P.avisos(), { ev: 'rotina', ...base }); return null; }          // entra no relatório diário
  const para = GP.usuariosPara(['coordenacao']);
  anexar(P.avisos(), { ev: 'aviso', tipo: 'imediato', ...base, para });
  if (para.length) { try { GP.notificar(para, 'Escalas 5×2 · ' + base.texto, { url: '/escalas-gerador.html#auditoria' }); } catch (e) {} }
  return id;
}
/** Relatório diário das alterações de rotina (uma vez por dia, a partir da hora configurada; sem alteração não envia nada). */
function relatorioDiario(opts = {}) {
  const d = opts.agora || new Date(); const dia = E._util.diaISO(d); const l = lerLinhas(P.avisos());
  if (!opts.forcar && d.getHours() < cfg().relatorioHora) return null;
  if (l.some(x => x.ev === 'aviso' && x.tipo === 'diario' && x.dia === dia)) return null;
  const ult = l.filter(x => x.ev === 'aviso' && x.tipo === 'diario').map(x => x.em).sort().pop() || '';
  const itens = l.filter(x => x.ev === 'rotina' && x.em > ult); if (!itens.length) return null;
  const para = GP.usuariosPara(['coordenacao']); const id = 'AV-D' + dia.replace(/-/g, '');
  const texto = 'Relatório diário das escalas: ' + itens.length + ' alteração(ões) de rotina em ' + [...new Set(itens.map(i => i.loja).filter(x => x != null))].map(n => (GP.LOJA_TXT[n] || n).split(' · ')[0]).join(', ');
  anexar(P.avisos(), { ev: 'aviso', tipo: 'diario', id, dia, em: agora(), nivel: 'rotina', loja: null, mes: null, texto, autor: 'sistema', para, itens: itens.map(i => ({ em: i.em, loja: i.loja, mes: i.mes, texto: i.texto, autor: i.autor })) });
  if (para.length) { try { GP.notificar(para, texto, { url: '/escalas-gerador.html#auditoria' }); } catch (e) {} }
  return { id, itens: itens.length, para };
}
/** Avisos com o estado de envio / entrega / visualização por destinatário. `entregar` registra a entrega a quem está lendo. */
function avisos(user, opts = {}) {
  const l = lerLinhas(P.avisos()); const lista = l.filter(x => x.ev === 'aviso'); const ent = {}, vis = {};
  for (const x of l) { if (x.ev === 'entrega') (ent[x.id] = ent[x.id] || {})[x.usuario] = x.em; else if (x.ev === 'visualizacao') (vis[x.id] = vis[x.id] || {})[x.usuario] = x.em; }
  if (opts.entregar) for (const a of lista) if ((a.para || []).includes(user.usuario) && !(ent[a.id] || {})[user.usuario]) { const em = agora(); anexar(P.avisos(), { ev: 'entrega', id: a.id, usuario: user.usuario, em }); (ent[a.id] = ent[a.id] || {})[user.usuario] = em; }
  const meus = GP.temPapel(user, 'coordenacao', 'diretoria', 'rh_ponto') ? lista : lista.filter(a => (a.para || []).includes(user.usuario) || (a.loja != null && podeVer(user, a.loja)));
  return { pendentes_rotina: l.filter(x => x.ev === 'rotina' && x.em > (lista.filter(a => a.tipo === 'diario').map(a => a.em).sort().pop() || '')).length,
    nao_vistos: lista.filter(a => (a.para || []).includes(user.usuario) && !(vis[a.id] || {})[user.usuario]).length,
    avisos: meus.slice(-300).reverse().map(a => ({ id: a.id, tipo: a.tipo, nivel: a.nivel, em: a.em, loja: a.loja, mes: a.mes, texto: a.texto, autor: a.autor, itens: a.itens || null, meu: (a.para || []).includes(user.usuario),
      destinatarios: (a.para || []).map(u => ({ usuario: u, enviado: a.em, entregue: (ent[a.id] || {})[u] || null, visto: (vis[a.id] || {})[u] || null })) })) };
}
function marcarVistos(user, ids) {
  const l = lerLinhas(P.avisos()); const set = new Set(ids || []); let n = 0;
  for (const a of l) { if (a.ev !== 'aviso' || !set.has(a.id) || !(a.para || []).includes(user.usuario)) continue; if (l.some(x => x.ev === 'visualizacao' && x.id === a.id && x.usuario === user.usuario)) continue; anexar(P.avisos(), { ev: 'visualizacao', id: a.id, usuario: user.usuario, em: agora() }); n++; }
  return { ok: true, marcados: n };
}

// ── Regras trabalhistas ──────────────────────────────────────────────────────────────────────────────────
const LIM = { metaSemanalMin: [600, 2640], intervaloMin: [0, 240], jornadaMaxDiaMin: [240, 720], semanaMaxMin: [600, 2880], interjornadaMin: [0, 1440], descansoSemanalMin: [0, 4320], maxDiasConsecutivos: [1, 7] };
const LIM_INT = { minimoMin: [0, 240], maximoMin: [0, 480], exigidoAcimaMin: [120, 720], curtoMin: [0, 60], curtoAcimaMin: [60, 720], continuoMaxMin: [120, 720], bordaMin: [0, 240] };
function normParams(q) {
  q = q || {}; const p = {};
  for (const [k, [a, b]] of Object.entries(LIM)) { if (q[k] == null || q[k] === '') continue; const v = Math.round(+q[k]); if (!(v >= a && v <= b)) throw erro('Parâmetro fora da faixa: ' + k + ' (' + a + ' a ' + b + ')'); p[k] = v; }
  // intervalo intrajornada (duração e posição): só o que a convenção muda fica gravado; o resto segue o padrão do motor
  const qi = q.intervalo || {}; const it = {};
  for (const [k, [a, b]] of Object.entries(LIM_INT)) { if (qi[k] == null || qi[k] === '') continue; const v = Math.round(+qi[k]); if (!(v >= a && v <= b)) throw erro('Parâmetro do intervalo fora da faixa: ' + k + ' (' + a + ' a ' + b + ' min)'); it[k] = v; }
  const final = { ...M.PARAMS_PADRAO, ...p, intervalo: { ...M.PARAMS_PADRAO.intervalo, ...it } }; const I = final.intervalo, dia = Math.round(final.metaSemanalMin / final.diasTrabalho);
  if (final.metaSemanalMin > final.semanaMaxMin) throw erro('A meta semanal não pode passar do limite semanal');
  if (dia > final.jornadaMaxDiaMin) throw erro('A meta semanal dividida em 5 dias passa do limite diário');
  if (I.maximoMin > 0 && I.minimoMin > I.maximoMin) throw erro('O intervalo mínimo não pode ser maior que o máximo');
  if (dia > I.exigidoAcimaMin && (final.intervaloMin < I.minimoMin || (I.maximoMin > 0 && final.intervaloMin > I.maximoMin))) throw erro('O intervalo planejado (' + final.intervaloMin + ' min) precisa ficar entre o mínimo (' + I.minimoMin + ') e o máximo (' + I.maximoMin + ') da própria regra');
  if (final.intervaloMin > 0 && dia > 2 * I.continuoMaxMin) throw erro('Com ' + dia + ' min de trabalho por dia não existe posição de intervalo que respeite o máximo de ' + I.continuoMaxMin + ' min seguidos');
  if (Object.keys(it).length) p.intervalo = it;
  const d = q.domingo || {}; const cada = d.folgaACadaSemanas == null || d.folgaACadaSemanas === '' ? M.PARAMS_PADRAO.domingo.folgaACadaSemanas : Math.round(+d.folgaACadaSemanas);
  if (!(cada >= 0 && cada <= 8)) throw erro('Folga no domingo a cada N semanas: de 0 (desligado) a 8');
  p.domingo = { folgaACadaSemanas: cada, tratamento: txt(d.tratamento, 300) || 'conforme_convencao' };
  p.feriado = { tratamento: txt((q.feriado || {}).tratamento, 300) || 'conforme_convencao' };
  p.folgasConsecutivas = q.folgasConsecutivas === 'indiferente' ? 'indiferente' : 'evitar';
  return p;
}
const regraPublica = r => ({ ...r, params: { ...M.PARAMS_PADRAO, ...r.params, intervalo: { ...M.PARAMS_PADRAO.intervalo, ...(r.params.intervalo || {}) }, domingo: { ...M.PARAMS_PADRAO.domingo, ...(r.params.domingo || {}) }, feriado: { ...M.PARAMS_PADRAO.feriado, ...(r.params.feriado || {}) } }, estabelecimentoTxt: r.estabelecimento == null ? 'Todas as unidades' : (GP.LOJA_TXT[r.estabelecimento] || r.estabelecimento) });
const listarRegras = () => cfg().regras.map(regraPublica);
function salvarRegra(user, b) {
  exige(podeRegras(user), 'Só RH Ponto e Coordenação cadastram regras trabalhistas'); b = b || {};
  const c = cfg(); const atual = b.id ? c.regras.find(r => r.id === b.id) : null; if (b.id && !atual) throw erro('Regra não encontrada', 404);
  const nome = txt(b.nome, 120); if (nome.length < 3) throw erro('Dê um nome à regra (ex.: CCT Comerciários 2026/2027)');
  const est = b.estabelecimento == null || b.estabelecimento === '' ? null : +b.estabelecimento; if (est != null && !GP.LOJAS.includes(est)) throw erro('Unidade inválida');
  const v = b.vigencia || {}; if (!ISO.test(v.de || '')) throw erro('Informe o início da vigência'); if (v.ate && (!ISO.test(v.ate) || v.ate < v.de)) throw erro('Fim da vigência inválido');
  const just = txt(b.justificativa, 500); if (just.length < 5) throw erro('Justifique a criação/alteração da regra');
  const nova = { id: atual ? atual.id : 'R-' + Date.now().toString(36), nome, estabelecimento: est, categoria: semAcento(b.categoria) || null, vigencia: { de: v.de, ate: v.ate || null }, baseLegal: txt(b.baseLegal, 600), params: normParams(b.params),
    validada: false, validadaPor: null, validadaEm: null, parecer: null, versao: atual ? (atual.versao || 1) + 1 : 1, criadaEm: atual ? atual.criadaEm : agora(), criadaPor: atual ? atual.criadaPor : user.usuario, alteradaEm: agora(), alteradaPor: user.usuario };
  if (atual) c.regras[c.regras.indexOf(atual)] = nova; else c.regras.push(nova);
  salvarCfg(c); auditar(user, atual ? 'regra_alterar' : 'regra_criar', { ref: nova.id, loja: est, justificativa: just, antes: atual || null, depois: nova });
  avisar({ nivel: 'critico', loja: est, texto: 'Regra trabalhista "' + nome + '" ' + (atual ? 'alterada' : 'criada') + ' por ' + (user.nome || user.usuario) + ' — volta a depender da validação do RH. ' + just, autor: user, ref: nova.id });
  return regraPublica(nova);
}
function validarRegra(user, id, parecer) {
  exige(podeValidarRegra(user), 'Só o RH Ponto valida regra trabalhista'); const c = cfg(); const r = c.regras.find(x => x.id === id); if (!r) throw erro('Regra não encontrada', 404);
  const t = txt(parecer, 600); if (t.length < 10) throw erro('Registre o parecer do RH (qual convenção/cláusula foi conferida)');
  const antes = { ...r }; r.validada = true; r.validadaPor = user.usuario; r.validadaEm = agora(); r.parecer = t;
  salvarCfg(c); auditar(user, 'regra_validar', { ref: r.id, loja: r.estabelecimento, justificativa: t, antes, depois: r });
  avisar({ nivel: 'critico', loja: r.estabelecimento, texto: 'Regra trabalhista "' + r.nome + '" validada pelo RH (' + (user.nome || user.usuario) + '). ' + t, autor: user, ref: r.id });
  return regraPublica(r);
}
function encerrarRegra(user, id, ate, justificativa) {
  exige(podeRegras(user), 'Só RH Ponto e Coordenação encerram regras'); const c = cfg(); const r = c.regras.find(x => x.id === id); if (!r) throw erro('Regra não encontrada', 404);
  if (!ISO.test(ate || '') || ate < r.vigencia.de) throw erro('Data de encerramento inválida'); const just = txt(justificativa, 500); if (just.length < 5) throw erro('Justifique o encerramento');
  const antes = JSON.parse(JSON.stringify(r)); r.vigencia.ate = ate; r.alteradaEm = agora(); r.alteradaPor = user.usuario;
  salvarCfg(c); auditar(user, 'regra_encerrar', { ref: r.id, loja: r.estabelecimento, justificativa: just, antes, depois: r });
  avisar({ nivel: 'critico', loja: r.estabelecimento, texto: 'Vigência da regra "' + r.nome + '" encerrada em ' + ate.split('-').reverse().join('/') + ' por ' + (user.nome || user.usuario) + '. ' + just, autor: user, ref: r.id });
  return regraPublica(r);
}

// ── Cadastro por funcionário (folga fixa, categoria, setor, restrições) e cobertura do gerador ───────────
const folgasContrato = f => (f.folga_fixa_contrato || f.folga_fixa || []).map(Number);
/** Folga fixa que o gerador usa: a definida pelo RH; sem ela, a 1ª folga do contrato que não seja domingo. */
function folgaFixaDe(f, cad) {
  if (cad && cad.folga_fixa != null) return { dia: +cad.folga_fixa, origem: 'rh' };
  const c = folgasContrato(f).filter(d => d !== 0); return c.length ? { dia: c[0], origem: 'contrato' } : { dia: null, origem: 'nenhuma' };
}
function cadastroLoja(loja, funcs) {
  const C = cfg().funcionarios;
  return funcs.map(f => { const c = C[f.id] || {}; const ff = folgaFixaDe(f, c); return { id: f.id, nome: f.nome, cargo: f.cargo || '', setor: c.setor || f.setor, setorEscala: f.setor, folga_fixa: ff.dia, folgaOrigem: ff.origem, folgasContrato: folgasContrato(f), categoria: c.categoria || '', naoTrabalha: c.naoTrabalha || [], entradaMin: c.entradaMin || '', saidaMax: c.saidaMax || '', obs: c.obs || '', definidoPor: c.por || null, definidoEm: c.em || null }; });
}
function salvarCadastro(user, loja, funcs, itens, justificativa) {
  exige(rhDa(user, loja), 'Só o RH Ponto da unidade ajusta folga fixa, setor e restrições'); const just = txt(justificativa, 500); if (just.length < 5) throw erro('Justifique o ajuste');
  const c = cfg(); const mud = [];
  for (const it of itens || []) {
    const f = funcs.find(x => String(x.id) === String(it.id)); if (!f) throw erro('Funcionário ' + it.id + ' não está no quadro desta unidade');
    const antes = c.funcionarios[f.id] || {}; const novo = { ...antes };
    if ('folga_fixa' in it) { if (it.folga_fixa === null || it.folga_fixa === '') novo.folga_fixa = null; else { const d = +it.folga_fixa; if (!(d >= 0 && d <= 6)) throw erro('Folga fixa inválida'); novo.folga_fixa = d; } }
    if ('categoria' in it) novo.categoria = semAcento(it.categoria).slice(0, 60);
    if ('setor' in it) novo.setor = semAcento(it.setor).slice(0, 60) || null;
    if ('naoTrabalha' in it) { const l = [...new Set((it.naoTrabalha || []).map(Number))]; if (l.some(d => !(d >= 0 && d <= 6)) || l.length > 2) throw erro('Restrição de dias inválida (no máximo 2 dias da semana)'); novo.naoTrabalha = l; }
    for (const k of ['entradaMin', 'saidaMax']) if (k in it) { if (it[k] && !HM.test(it[k])) throw erro('Horário inválido em ' + k); novo[k] = it[k] || ''; }
    if ('obs' in it) novo.obs = txt(it.obs, 200);
    const chave = x => JSON.stringify([x.folga_fixa == null ? null : x.folga_fixa, x.categoria || '', x.setor || null, x.naoTrabalha || [], x.entradaMin || '', x.saidaMax || '', x.obs || '']);
    if (chave(antes) === chave(novo)) continue;
    novo.por = user.usuario; novo.em = agora(); c.funcionarios[f.id] = novo; mud.push({ id: f.id, nome: f.nome, antes, depois: novo });
  }
  if (!mud.length) return { ok: true, alterados: 0 };
  salvarCfg(c); auditar(user, 'cadastro', { ref: 'CAD-' + loja, loja: +loja, justificativa: just, alteracoes: mud });
  avisar({ nivel: 'rotina', loja, texto: (GP.LOJA_TXT[loja] || loja) + ': ' + (user.nome || user.usuario) + ' ajustou folga fixa/setor/restrições de ' + mud.length + ' funcionário(s). ' + just, autor: user });
  return { ok: true, alterados: mud.length };
}
function coberturaLoja(loja) {
  const L = E.config().lojas[loja] || { abre: '07:00', fecha: '19:00', setores: {} }; const g = cfg().lojas[loja] || {}; const setores = {};
  for (const [s, v] of Object.entries(L.setores || {})) setores[s] = { min: (v && v.min) || 0, faixas: (g.picos || []).filter(p => p.setor === s).map(p => ({ dias: p.dias, ini: p.ini, fim: p.fim, min: p.min })) };
  for (const p of g.picos || []) if (!setores[p.setor]) setores[p.setor] = { min: 0, faixas: [{ dias: p.dias, ini: p.ini, fim: p.fim, min: p.min }] };
  // prioridade operacional por dia da semana: a da unidade e, quando informada, a do setor (que vence a da unidade)
  const pesosSetor = g.pesosSetor || {};
  for (const [s, pd] of Object.entries(pesosSetor)) { if (!setores[s]) setores[s] = { min: 0, faixas: [] }; setores[s].pesoDia = pd; }
  return { abre: L.abre, fecha: L.fecha, setores, entradas: g.entradas || [], pesoDia: g.pesoDia || {}, pesosSetor, picos: g.picos || [] };
}
/** Pesos de 1 (normal) a 5 por dia da semana; 1 não é gravado. Devolve { dia: peso } só com os dias acima do normal — ou,
 *  no setor, também os dias que o setor declara normais para fugir do peso da unidade (`manterUm`). */
function normPesos(v, manterUm) {
  const out = {};
  for (const [k, x] of Object.entries(v || {})) { if (x == null || x === '') continue; const d = +k, n = Math.round(+x); if (!(d >= 0 && d <= 6) || !(n >= 1 && n <= 5)) throw erro('Peso do dia inválido: use de 1 (normal) a 5 (maior movimento)'); if (n > 1 || manterUm) out[d] = n; }
  return out;
}
function salvarCobertura(user, loja, b, justificativa) {
  exige(podeRegras(user), 'Só RH Ponto e Coordenação configuram a cobertura do gerador'); if (!GP.LOJAS.includes(+loja)) throw erro('Unidade inválida');
  const just = txt(justificativa, 500); if (just.length < 5) throw erro('Justifique a alteração'); b = b || {};
  const entradas = [...new Set((b.entradas || []).map(x => String(x).trim()).filter(Boolean))].sort(); if (entradas.some(x => !HM.test(x)) || entradas.length > 8) throw erro('Horários de entrada inválidos (HH:MM, até 8)');
  const picos = (b.picos || []).map(p => { const dias = [...new Set((p.dias || []).map(Number))].sort(); const n = Math.round(+p.min);
    if (!semAcento(p.setor) || !dias.length || dias.some(d => !(d >= 0 && d <= 6)) || !HM.test(p.ini || '') || !HM.test(p.fim || '') || p.fim <= p.ini || !(n >= 1 && n <= 99)) throw erro('Reforço de pico inválido (setor, dias, início < fim e mínimo de pessoas)');
    return { setor: semAcento(p.setor), dias, ini: p.ini, fim: p.fim, min: n }; });
  if (picos.length > 40) throw erro('No máximo 40 faixas de pico por unidade');
  const c = cfg(); const antes = c.lojas[loja] || {};
  // pesos por dia: quem não manda o campo (chamada antiga) mantém o que estava gravado
  const pesoDia = 'pesoDia' in b ? normPesos(b.pesoDia, false) : (antes.pesoDia || {}); let pesosSetor = antes.pesosSetor || {};
  if ('pesosSetor' in b) { pesosSetor = {}; for (const [s, v] of Object.entries(b.pesosSetor || {})) { const k = semAcento(s).slice(0, 60); if (!k) continue; const n = normPesos(v, true); if (Object.keys(n).length) pesosSetor[k] = n; } if (Object.keys(pesosSetor).length > 30) throw erro('No máximo 30 setores com peso próprio'); }
  c.lojas[loja] = { ...antes, entradas, picos, pesoDia, pesosSetor, por: user.usuario, em: agora() };
  salvarCfg(c); auditar(user, 'cobertura', { ref: 'COB-' + loja, loja: +loja, justificativa: just, antes: { entradas: antes.entradas || [], picos: antes.picos || [], pesoDia: antes.pesoDia || {}, pesosSetor: antes.pesosSetor || {} }, depois: { entradas, picos, pesoDia, pesosSetor } });
  avisar({ nivel: 'relevante', loja, texto: (GP.LOJA_TXT[loja] || loja) + ': entradas permitidas, reforços de pico e pesos por dia do gerador alterados por ' + (user.nome || user.usuario) + '. ' + just, autor: user });
  return coberturaLoja(loja);
}

// ── Montagem da entrada do motor ─────────────────────────────────────────────────────────────────────────
const limpo = d => ({ tipo: d.tipo, entrada: d.entrada || null, saida: d.saida || null, almoco_ini: d.almoco_ini || null, almoco_fim: d.almoco_fim || null, setor: d.setor || null, ...(d.folga ? { folga: d.folga } : {}) });
/** Escala do mês (a gravada, ou uma virtual com o quadro do ponto quando ainda não existe). ctx = { colabs, escalasPC, afast, afastAnt, hoje } */
function escalaDe(loja, mes, ctx) {
  const e = E.ler(loja, mes); if (e) return { e, existe: true };
  if (!ctx.colabs || !ctx.escalasPC) throw erro('Ainda não há escala de ' + (GP.LOJA_TXT[loja] || loja) + ' em ' + mes + ' e o PontoCerto não respondeu para montar o quadro', 503);
  return { e: { loja: +loja, mes, status: 'rascunho', versao: 0, funcionarios: E.funcsDoPontoCerto(loja, ctx.colabs, ctx.escalasPC), dias: {}, historico: [], fluxo: [], versoes: [] }, existe: false };
}
function periodo(mes, aPartirDe, hoje) {
  if (!MES.test(mes)) throw erro('Mês inválido (AAAA-MM)'); const dias = E.diasDoMes(mes); const ini = dias[0], fim = dias[dias.length - 1]; const mesHoje = hoje.slice(0, 7);
  if (mes < mesHoje) throw erro('Mês já encerrado: o gerador só propõe dias futuros');
  const minimo = mes === mesHoje ? soma(hoje, 1) : ini; if (minimo > fim) throw erro('Não há mais dias futuros neste mês: gere o mês seguinte');
  let de = minimo; if (aPartirDe) { if (!ISO.test(aPartirDe) || aPartirDe.slice(0, 7) !== mes) throw erro('"A partir de" precisa ser um dia do mês escolhido'); if (aPartirDe < minimo) throw erro('"A partir de" não pode ser hoje nem dia já passado (mínimo ' + minimo.split('-').reverse().join('/') + ')'); de = aPartirDe; }
  return { de, ate: fim, ini, fim };
}
// ── Histórico: o que estava planejado × o que o ponto registrou ──────────────────────────────────────────
// Para cada pessoa e dia anterior ao início da proposta (4 semanas antes da segunda-feira da semana inicial):
//   · ESCALA PLANEJADA      → a grade do sistema naquele mês; sem grade, a jornada contratual cadastrada no ponto
//   · MARCAÇÃO REALIZADA    → linha da apuração do ponto (relatório work_days) com marcação: trabalhou, com os horários batidos
//   · FOLGA PREVISTA        → dia sem jornada no planejado
//   · DESCANSO IDENTIFICADO → folga prevista E nenhuma marcação no ponto
//   · AUSÊNCIA / AFASTAMENTO→ relatório de afastamentos do ponto (férias, atestado, licença)
// Jornada prevista SEM marcação NÃO vira folga: fica "indefinido" (pode ser falta, folga trocada ou marcação esquecida)
// até o RH validar. Dia passado sem nenhuma linha no ponto (quem não marca ponto, ou ponto fora do ar) entra pelo
// planejado, marcado como NÃO CONFIRMADO. Dia futuro (entre hoje e o início) vale o planejado. Limitação da API: ela não
// devolve escala planejada dia a dia nem folga programada (/schedules e /day_offs respondem 404) — por isso a "folga
// prevista" vem do contrato do ponto ou da grade do sistema, nunca de um cadastro de folgas da VR.
const HIST_DIAS = 28;
const janelaHistorico = de => ({ de: soma(M._util.segunda(de), -HIST_DIAS), ate: soma(de, -1) });
const VALIDACAO_TXT = { trabalho: 'trabalhou', descanso: 'descansou' };
function horariosDasMarcacoes(m, plan) {
  let x = null, incompleta = false; const pl = plan && plan.tipo === 'trabalho' && plan.entrada && plan.saida ? plan : null;
  if (m.length >= 4) x = { entrada: m[0], almoco_ini: m[1], almoco_fim: m[2], saida: m[m.length - 1] };
  else if (m.length >= 2) { x = { entrada: m[0], saida: m[m.length - 1], almoco_ini: null, almoco_fim: null }; if (pl && pl.almoco_ini && min(pl.almoco_ini) > min(x.entrada) && min(pl.almoco_fim) < min(x.saida)) { x.almoco_ini = pl.almoco_ini; x.almoco_fim = pl.almoco_fim; } }
  if (!x || min(x.saida) == null || min(x.entrada) == null || min(x.saida) <= min(x.entrada) || (x.almoco_ini && !(min(x.almoco_fim) > min(x.almoco_ini)))) { incompleta = true; x = pl ? { entrada: pl.entrada, saida: pl.saida, almoco_ini: pl.almoco_ini || null, almoco_fim: pl.almoco_fim || null } : { entrada: m[0], saida: null, almoco_ini: null, almoco_fim: null }; }
  return { ...x, incompleta };
}
/** Devolve { hist, resumo }: `hist` no formato do motor e `resumo` com as contagens, as limitações e os dias que pedem validação. */
function historicoReal(e, de, ctx) {
  const hoje = ctx.hoje || hojeISO(); const j = janelaHistorico(de); const loja = e.loja; const val = cfg().historico;
  const temPonto = !!(ctx.ponto && Array.isArray(ctx.ponto.linhas)); const linhas = new Map(); const comLinha = new Set();
  if (temPonto) for (const w of ctx.ponto.linhas) { linhas.set(w.employee_id + '|' + w.data, w); comLinha.add(String(w.employee_id)); }
  const pontoAte = temPonto ? ctx.ponto.ate : null, pontoDe = temPonto ? ctx.ponto.de : null;
  const grades = new Map(); const gradeDe = mes => { if (!grades.has(mes)) grades.set(mes, mes === e.mes ? e : E.ler(loja, mes)); return grades.get(mes); };
  const afastDe = nome => { const k = semAcento(nome); const l = []; for (const m of [ctx.afastJanela, ctx.afast, ctx.afastAnt]) if (m && m.get(k)) l.push(...m.get(k)); return l; };
  const adm = new Map(); if (ctx.colabs) for (const c of ctx.colabs.ativos || []) if (c.admissao) adm.set(String(c.id), c.admissao);
  const hist = {}; const n = { trabalho: 0, descanso: 0, ausencia: 0, indefinido: 0, naoConfirmado: 0, planejadoFuturo: 0, validadoRH: 0, incompletas: 0, semDado: 0 }; const pend = []; const semPonto = [];
  for (const f of e.funcionarios) {
    if (f.id < 0) continue; const dias = {}; const aus = afastDe(f.nome); const a0 = adm.get(String(f.id)); const nuncaMarca = temPonto && !comLinha.has(String(f.id));
    for (let d = j.de; d <= j.ate; d = soma(d, 1)) {
      if (a0 && d < a0) continue; if (f.desligamento && d > f.desligamento) continue;
      const a = aus.find(x => x.inicio <= d && x.fim >= d); if (a) { dias[d] = { tipo: a.ferias ? 'ferias' : 'afastado', fonte: 'ponto' }; n.ausencia++; continue; }
      const g = gradeDe(d.slice(0, 7)); const fg = g ? g.funcionarios.find(x => String(x.id) === String(f.id)) : null; const w = linhas.get(f.id + '|' + d);
      // planejado: a grade do mês; sem grade, o contrato do ponto (jornada do dia, ou "sem jornada" quando a apuração traz 00:00)
      let plan = fg ? limpo(E.diaDe(g, fg, d, null)) : limpo(E.diaDe({ dias: {} }, f, d, null)); const origemPlano = fg ? 'grade' : 'contrato';
      if (!fg && w && w.shift_time != null) { if (w.shift_time === '00:00') plan = { tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor }; else if (plan.tipo !== 'trabalho') plan = { tipo: 'trabalho', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor }; }
      if (plan.tipo !== 'trabalho' && plan.tipo !== 'folga') plan = { ...plan, tipo: plan.tipo === 'feriado' ? 'folga' : plan.tipo };
      if (d > hoje) { dias[d] = { ...plan, fonte: 'escala', planejado: origemPlano }; n.planejadoFuturo++; continue; }
      const v = val[f.id + '|' + d];
      if (v) {   // validado pelo RH: trabalhou (com o horário planejado ou, na falta, o de um dia do contrato) ou descansou
        const b = Object.values(f.base || {}).find(Boolean); n.validadoRH++;
        dias[d] = v.tipo === 'trabalho' ? { ...(plan.tipo === 'trabalho' && plan.entrada ? plan : { entrada: b ? b.entrada : null, saida: b ? b.saida : null, almoco_ini: b ? b.almoco_ini : null, almoco_fim: b ? b.almoco_fim : null, setor: f.setor }), tipo: 'trabalho', fonte: 'rh' } : { tipo: 'folga', fonte: 'rh' }; continue; }
      if ((plan.tipo === 'ferias' || plan.tipo === 'afastado') && !(w && w.marcacoes && w.marcacoes.length)) { dias[d] = { tipo: plan.tipo, fonte: 'escala' }; n.ausencia++; continue; }   // ausência lançada à mão na grade
      if (w && w.marcacoes && w.marcacoes.length) { const h = horariosDasMarcacoes(w.marcacoes, plan); dias[d] = { tipo: 'trabalho', entrada: h.entrada, saida: h.saida, almoco_ini: h.almoco_ini, almoco_fim: h.almoco_fim, setor: f.setor, fonte: 'ponto', ...(h.incompleta ? { incompleta: true } : {}), ...(plan.tipo === 'folga' ? { emFolgaPrevista: true } : {}) }; n.trabalho++; if (h.incompleta) n.incompletas++; continue; }
      if (d === hoje) { dias[d] = { ...plan, fonte: 'escala', planejado: origemPlano }; n.planejadoFuturo++; continue; }   // dia em andamento: vale o planejado
      if (w) {   // o ponto tem a linha do dia e ela não tem marcação
        if (plan.tipo === 'folga') { dias[d] = { tipo: 'folga', fonte: 'ponto' }; n.descanso++; }
        else { dias[d] = { tipo: 'indefinido', fonte: 'ponto' }; n.indefinido++; pend.push({ id: f.id, nome: f.nome, setor: f.setor, data: d, motivo: 'sem_marcacao', texto: 'jornada prevista e nenhuma marcação' }); }
        continue;
      }
      // nenhuma linha do ponto para este dia: fora da faixa consultada, ponto indisponível ou pessoa que não marca ponto
      const motivo = !temPonto ? 'ponto_indisponivel' : (d < pontoDe || d > pontoAte) ? 'fora_da_consulta' : 'sem_linha_no_ponto';
      dias[d] = { ...plan, fonte: 'escala', planejado: origemPlano, naoConfirmado: true }; n.naoConfirmado++;
      pend.push({ id: f.id, nome: f.nome, setor: f.setor, data: d, motivo, texto: motivo === 'ponto_indisponivel' ? 'o ponto não respondeu' : 'o ponto não tem apuração deste dia (planejado: ' + (plan.tipo === 'trabalho' ? 'trabalho' : 'folga') + ')' });
    }
    if (nuncaMarca) semPonto.push(f.nome);
    if (Object.keys(dias).length) hist[f.id] = { dias };
  }
  const lim = ['A API do ponto não devolve a escala planejada dia a dia nem a folga programada: "folga prevista" aqui é o dia sem jornada no contrato do ponto ou na grade do sistema.'];
  if (!temPonto) lim.push('O ponto não respondeu agora: os dias já passados entram só como planejados, sem confirmação.');
  if (n.indefinido) lim.push(n.indefinido + ' dia(s) com jornada prevista e nenhuma marcação: o ponto não diz se foi folga, falta ou marcação esquecida — não foram contados como folga.');
  if (semPonto.length) lim.push(semPonto.length + ' funcionário(s) sem nenhuma apuração no ponto no período (não marcam ponto): só o planejado está disponível.');
  if (n.incompletas) lim.push(n.incompletas + ' dia(s) com marcação incompleta: contam como trabalhados, com o horário planejado no lugar do batido.');
  return { hist, resumo: { fonte: temPonto ? 'ponto' : 'planejado', de: j.de, ate: j.ate, hoje, ...n, pendentes: pend.sort((a, b) => b.data.localeCompare(a.data) || a.nome.localeCompare(b.nome)), semPonto, limitacoes: lim } };
}
/** RH valida o que aconteceu num dia que o ponto não confirma (só dias passados; fica na auditoria; `tipo: null` desfaz). */
function validarHistorico(user, loja, funcs, itens, justificativa, hoje) {
  exige(rhDa(user, loja), 'Só o RH Ponto da unidade valida dias sem confirmação do ponto'); const just = txt(justificativa, 500); if (just.length < 10) throw erro('Justifique a validação (mínimo de 10 caracteres): de onde veio a informação?');
  hoje = hoje || hojeISO(); const c = cfg(); const mud = []; if (!Array.isArray(itens) || !itens.length) throw erro('Nenhum dia informado'); if (itens.length > 400) throw erro('No máximo 400 dias por vez');
  for (const it of itens) {
    const f = (funcs || []).find(x => String(x.id) === String(it.id)); if (!f) throw erro('Funcionário ' + it.id + ' não está no quadro desta unidade');
    if (!ISO.test(it.data || '') || it.data >= hoje) throw erro('Só é possível validar dias já encerrados'); if (it.data < soma(hoje, -90)) throw erro('Dia fora do período que o gerador consulta (90 dias)');
    if (it.tipo != null && !VALIDACAO_TXT[it.tipo]) throw erro('Validação inválida: informe se a pessoa trabalhou ou descansou');
    const k = f.id + '|' + it.data; const antes = c.historico[k] || null; if ((antes ? antes.tipo : null) === (it.tipo || null)) continue;
    if (it.tipo) c.historico[k] = { tipo: it.tipo, loja: +loja, por: user.usuario, nome: user.nome || user.usuario, em: agora() }; else delete c.historico[k];
    mud.push({ id: f.id, nome: f.nome, data: it.data, antes: antes ? antes.tipo : null, depois: it.tipo || null });
  }
  if (!mud.length) return { ok: true, validados: 0 };
  salvarCfg(c); auditar(user, 'historico_validar', { ref: 'HIST-' + loja, loja: +loja, justificativa: just, alteracoes: mud });
  avisar({ nivel: 'relevante', loja, texto: (GP.LOJA_TXT[loja] || loja) + ': ' + (user.nome || user.usuario) + ' (RH) validou ' + mud.length + ' dia(s) que o ponto não confirma (trabalhou/descansou) para o Gerador 5×2. ' + just, autor: user });
  return { ok: true, validados: mud.length };
}
function funcsDoMotor(e, ctx) {
  const C = cfg().funcionarios; const adm = new Map(); if (ctx.colabs) for (const c of ctx.colabs.ativos || []) if (c.admissao) adm.set(String(c.id), c.admissao);
  return e.funcionarios.map(f => { const c = C[f.id] || {}; const a = ctx.afast ? (ctx.afast.get(semAcento(f.nome)) || []) : [];
    return { id: f.id, nome: f.nome, setor: c.setor || f.setor, estabelecimento: e.loja, categoria: c.categoria || null, folga_fixa: folgaFixaDe(f, c).dia, base: f.base, admissao: adm.get(String(f.id)) || undefined, desligamento: f.desligamento || undefined,
      restricoes: { naoTrabalha: c.naoTrabalha || [], entradaMin: c.entradaMin || null, saidaMax: c.saidaMax || null }, ausencias: a.map(x => ({ inicio: x.inicio, fim: x.fim, tipo: x.ferias ? 'ferias' : 'afastado' })) }; });
}
const assinar = (r, de, ate) => sha(JSON.stringify([de, ate, r.proposta.map(p => [p.id, p.dias])])).slice(0, 16);

// ── Simular ──────────────────────────────────────────────────────────────────────────────────────────────
function simular(user, loja, mes, ctx, opts = {}) {
  exige(podeVer(user, loja), 'Unidade fora do seu escopo'); const hoje = ctx.hoje || hojeISO(); const { e, existe } = escalaDe(loja, mes, ctx); const per = periodo(mes, opts.aPartirDe, hoje);
  const R = E.resolver(e, ctx.afast || null); const travados = {};
  for (const [k, ov] of Object.entries(e.dias)) { const data = k.slice(k.indexOf('|') + 1); if (data >= per.de && ov.origem !== 'gerador') travados[k] = limpo(ov); }
  const H = historicoReal(e, per.de, ctx);
  const r = M.gerar({ de: per.de, ate: per.ate, funcionarios: funcsDoMotor(e, ctx), regras: cfg().regras, historico: H.hist, travados, cobertura: coberturaLoja(loja), feriados: E.config().feriados });
  const pend = []; const cod = r.publicacao.bloqueios.map(b => b.codigo);
  // semana de transição sem dados suficientes: não aplica (o RH valida os dias pendentes ou começa numa segunda-feira)
  const proxSeg = soma(M._util.segunda(per.de), 7); const sugestaoInicio = r.transicao.necessaria && proxSeg <= per.ate ? proxSeg : null;
  if (cod.includes('transicao_sem_dados')) pend.push({ codigo: 'transicao_sem_dados', texto: r.publicacao.bloqueios.find(b => b.codigo === 'transicao_sem_dados').texto + (sugestaoInicio ? ' (próxima segunda: ' + sugestaoInicio.split('-').reverse().slice(0, 2).join('/') + ')' : '') });
  if (['enviada_rh', 'validada_rh'].includes(e.status)) pend.push({ codigo: 'em_aprovacao', texto: 'A escala de ' + mes.split('-').reverse().join('/') + ' está em aprovação (' + E.STATUS_TXT[e.status] + '): peça a devolução antes de aplicar' });
  if (!ctx.afast) pend.push({ codigo: 'afastamentos_indisponiveis', texto: 'O PontoCerto não devolveu férias e afastamentos agora: sem eles a proposta não pode ser aplicada' });
  if (cod.includes('regra_nao_validada')) pend.push({ codigo: 'regra_nao_validada', texto: r.publicacao.bloqueios.find(b => b.codigo === 'regra_nao_validada').texto + ' — cadastre e valide em Regras e cadastro' });
  if (cod.includes('conflito_trabalhista')) pend.push({ codigo: 'conflito_trabalhista', texto: r.publicacao.bloqueios.find(b => b.codigo === 'conflito_trabalhista').texto + ' na proposta' });
  if (!rhDa(user, loja)) pend.push({ codigo: 'sem_permissao', texto: 'Só o RH Ponto da unidade aplica a proposta na escala (você pode simular)' });
  const C = cfg().funcionarios; const semFixaRH = e.funcionarios.filter(f => !(C[f.id] && C[f.id].folga_fixa != null)).length;
  return { loja: +loja, lojaTxt: GP.LOJA_TXT[loja], mes, de: per.de, ate: per.ate, existe, status: e.status, statusTxt: existe ? E.STATUS_TXT[e.status] : 'Ainda sem escala no mês (será criada do PontoCerto ao aplicar)', versao: e.versao,
    travados: Object.keys(travados).length, geradosAtuais: Object.values(e.dias).filter(x => x.origem === 'gerador').length, semFolgaFixaRH: semFixaRH, afastamentos: !!ctx.afast,
    resultado: r, assinatura: assinar(r, per.de, per.ate), historico: H.resumo, sugestaoInicio,
    aplicacao: { permitida: pend.length === 0, pendencias: pend, exigeCiencia: r.divergenciasContratuais.length, novaVersao: e.status === 'aprovada' },
    feriados: E.config().feriados.filter(d => d.slice(0, 7) === mes), feriadosNome: Object.fromEntries(E.config().feriados.filter(d => d.slice(0, 7) === mes).map(d => [d, E.nomeFeriado(d)])) };
}

// ── Aplicar como rascunho / desfazer ─────────────────────────────────────────────────────────────────────
const listarGeracoes = (loja, mes) => { let fsn = []; try { fsn = fs.readdirSync(P.gerDir()); } catch (e) {} return fsn.filter(n => n.startsWith('G-' + loja + '-' + mes + '-')).map(n => lerJson(path.join(P.gerDir(), n), null)).filter(Boolean).sort((a, b) => b.em.localeCompare(a.em)); };
const resumoGeracao = g => ({ id: g.id, loja: g.loja, mes: g.mes, de: g.de, ate: g.ate, em: g.em, usuario: g.usuario, nome: g.nome, justificativa: g.justificativa, dias: Object.keys(g.depois).length, indicadores: g.indicadores, novaVersao: g.novaVersao, versao: g.versao, desfeita: g.desfeita || null });
function aplicar(user, loja, mes, ctx, body) {
  body = body || {}; const s = simular(user, loja, mes, ctx, { aPartirDe: body.aPartirDe });
  if (!s.aplicacao.permitida) throw erro('Não é possível aplicar: ' + s.aplicacao.pendencias.map(p => p.texto).join(' · '), s.aplicacao.pendencias.some(p => p.codigo === 'sem_permissao') ? 403 : 409, { pendencias: s.aplicacao.pendencias });
  if (body.assinatura && body.assinatura !== s.assinatura) throw erro('Os dados mudaram desde a simulação (ponto, cadastro ou escala): simule de novo antes de aplicar', 409, { desatualizada: true });
  const just = txt(body.justificativa, 600); if (just.length < 10) throw erro('Justifique a geração (mínimo de 10 caracteres)');
  if (s.aplicacao.exigeCiencia && body.cienteDivergencias !== true) throw erro('Confirme que o RH conferiu as ' + s.aplicacao.exigeCiencia + ' divergências entre a jornada contratual e a planejada', 409, { exigeCiencia: s.aplicacao.exigeCiencia });
  const r = s.resultado; let e = E.ler(loja, mes);
  if (!e) { e = E.criarDoPontoCerto(loja, mes, ctx.colabs, ctx.escalasPC, user); auditar(user, 'escala_criar', { ref: 'ESC-' + loja + '-' + mes, loja: +loja, mes }); }
  const n = listarGeracoes(loja, mes).length + 1; const id = 'G-' + loja + '-' + mes + '-' + String(n).padStart(2, '0');
  const statusAntes = e.status, versaoAntes = e.versao; const antes = {}, depois = {};
  for (const [k, ov] of Object.entries(e.dias)) { const data = k.slice(k.indexOf('|') + 1); if (data >= s.de && ov.origem === 'gerador') antes[k] = ov; }   // geração anterior que será trocada (reprocessamento)
  for (const p of r.proposta) for (const [d, x] of Object.entries(p.dias)) { if (x.origem !== 'gerador') continue; const k = p.id + '|' + d;
    depois[k] = { tipo: x.tipo, entrada: x.entrada, saida: x.saida, almoco_ini: x.almoco_ini, almoco_fim: x.almoco_fim, setor: x.setor, obs: '', origem: 'gerador', geracao: id, ...(x.folga ? { folga: x.folga } : {}), ...(x.ajuste ? { ajuste: x.ajuste } : {}) };
    if (!(k in antes)) antes[k] = e.dias[k] || null; }
  const novaVersao = E.reabrirSeAprovada(e, user, 'Gerador 5×2 (' + id + '): escala aprovada reaberta como nova versão');
  for (const k of Object.keys(antes)) delete e.dias[k]; for (const [k, v] of Object.entries(depois)) e.dias[k] = v;
  // folga fixa e setor do cadastro passam a valer na grade (o que era do contrato fica guardado)
  const C = cfg().funcionarios; const funcsAntes = {};
  for (const f of e.funcionarios) { const c = C[f.id] || {}; const ff = folgaFixaDe(f, c).dia; const novoSetor = c.setor || f.setor; const novaFixa = ff == null ? f.folga_fixa : [ff];
    if (JSON.stringify(novaFixa) !== JSON.stringify(f.folga_fixa) || novoSetor !== f.setor) { funcsAntes[f.id] = { folga_fixa: f.folga_fixa, setor: f.setor }; if (!f.folga_fixa_contrato) f.folga_fixa_contrato = f.folga_fixa; f.folga_fixa = novaFixa; f.setor = novoSetor; } }
  e.fluxo.push({ em: agora(), usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de: e.status, para: e.status, texto: 'Gerador 5×2 (' + id + '): ' + Object.keys(depois).length + ' dia(s) de ' + s.de.split('-').reverse().join('/') + ' a ' + s.ate.split('-').reverse().join('/') + ' aplicados como proposta. ' + just });
  E.salvar(e);
  const g = { id, loja: +loja, mes, de: s.de, ate: s.ate, em: agora(), ...quem(user), justificativa: just, cienteDivergencias: body.cienteDivergencias === true, statusAntes, versaoAntes, versao: e.versao, novaVersao, assinatura: s.assinatura,
    indicadores: r.indicadores, cobertura: r.cobertura.resumo, conflitos: r.conflitos, divergenciasContratuais: r.divergenciasContratuais, domingosFeriados: r.domingosFeriados, regrasAplicadas: r.regrasAplicadas, continuidade: r.continuidade,
    transicao: r.transicao, pesos: r.pesos, historico: { ...s.historico, pendentes: s.historico.pendentes.length }, antes, depois, funcsAntes, nomes: Object.fromEntries(e.funcionarios.map(f => [f.id, f.nome])), desfeita: null };
  gravarJson(P.ger(id), g);
  auditar(user, 'gerar_aplicar', { ref: id, loja: +loja, mes, justificativa: just, de: s.de, ate: s.ate, dias: Object.keys(depois).length, substituidos: Object.values(antes).filter(Boolean).length, novaVersao, versao: e.versao, indicadores: r.indicadores });
  avisar({ nivel: novaVersao ? 'critico' : 'relevante', loja, mes, texto: (GP.LOJA_TXT[loja] || loja) + ' ' + mes.split('-').reverse().join('/') + ': ' + (user.nome || user.usuario) + ' aplicou o Gerador 5×2 (' + Object.keys(depois).length + ' dias' + (novaVersao ? ', ESCALA APROVADA reaberta como versão ' + e.versao : ', rascunho') + '). ' + just, autor: user, ref: id });
  return { ok: true, geracao: resumoGeracao(g), status: e.status, statusTxt: E.STATUS_TXT[e.status], versao: e.versao };
}
function desfazer(user, loja, mes, id, justificativa) {
  exige(rhDa(user, loja), 'Só o RH Ponto da unidade desfaz uma geração'); const g = lerJson(P.ger(String(id).replace(/[^A-Za-z0-9-]/g, '')), null);
  if (!g || +g.loja !== +loja || g.mes !== mes) throw erro('Geração não encontrada', 404); if (g.desfeita) throw erro('Esta geração já foi desfeita');
  const just = txt(justificativa, 600); if (just.length < 10) throw erro('Justifique (mínimo de 10 caracteres)');
  const e = E.obter(loja, mes); if (['enviada_rh', 'validada_rh'].includes(e.status)) throw erro('Escala em aprovação: peça a devolução antes de desfazer', 409);
  const novaVersao = E.reabrirSeAprovada(e, user, 'Gerador 5×2: geração ' + id + ' desfeita em escala aprovada (nova versão)'); let rest = 0, mant = 0;
  for (const k of Object.keys(g.depois)) { const at = e.dias[k]; if (!at || at.geracao !== g.id) { mant++; continue; } if (g.antes[k]) e.dias[k] = g.antes[k]; else delete e.dias[k]; rest++; }   // dia editado depois da geração fica como está
  for (const f of e.funcionarios) { const a = (g.funcsAntes || {})[f.id]; if (a) { f.folga_fixa = a.folga_fixa; f.setor = a.setor; } }
  e.fluxo.push({ em: agora(), usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de: e.status, para: e.status, texto: 'Gerador 5×2: geração ' + g.id + ' desfeita (' + rest + ' dia(s) restaurado(s)' + (mant ? ', ' + mant + ' mantido(s) por terem sido editados depois' : '') + '). ' + just });
  E.salvar(e); g.desfeita = { em: agora(), ...quem(user), justificativa: just, restaurados: rest, mantidos: mant }; gravarJson(P.ger(g.id), g);
  auditar(user, 'gerar_desfazer', { ref: g.id, loja: +loja, mes, justificativa: just, restaurados: rest, mantidos: mant, novaVersao });
  avisar({ nivel: 'critico', loja, mes, texto: (GP.LOJA_TXT[loja] || loja) + ' ' + mes.split('-').reverse().join('/') + ': ' + (user.nome || user.usuario) + ' desfez a geração ' + g.id + ' (' + rest + ' dias restaurados). ' + just, autor: user, ref: g.id });
  return { ok: true, restaurados: rest, mantidos: mant, status: e.status, versao: e.versao };
}

// ── Analisar a escala que está na grade (jornada, folgas e cobertura) ────────────────────────────────────
function analisar(user, loja, mes, ctx) {
  exige(podeVer(user, loja), 'Unidade fora do seu escopo'); if (!MES.test(mes)) throw erro('Mês inválido'); const e = E.ler(loja, mes); if (!e) throw erro('Ainda não há escala de ' + (GP.LOJA_TXT[loja] || loja) + ' em ' + mes.split('-').reverse().join('/'), 404, { semEscala: true });
  const dias = E.diasDoMes(mes); const R = E.resolver(e, ctx.afast || null); const travados = {};
  for (const f of R) for (const d of dias) { const x = f.dias[d]; if (x && ['trabalho', 'folga', 'feriado'].includes(x.tipo)) travados[f.id + '|' + d] = limpo(x); }
  const H = historicoReal(e, dias[0], ctx);
  const r = M.gerar({ de: dias[0], ate: dias[dias.length - 1], funcionarios: funcsDoMotor(e, ctx), regras: cfg().regras, historico: H.hist, travados, cobertura: coberturaLoja(loja), feriados: E.config().feriados });
  const fora = c => !['sem_folga_fixa', 'folga_extra_domingo', 'folga_extra_descanso', 'folga_fixa_ja_gozada', 'entrada_adiada'].includes(c.codigo);   // avisos que só fazem sentido numa geração
  return { loja: +loja, lojaTxt: GP.LOJA_TXT[loja], mes, status: e.status, statusTxt: E.STATUS_TXT[e.status], versao: e.versao, afastamentos: !!ctx.afast, gerados: Object.values(e.dias).filter(x => x.origem === 'gerador').length, manuais: Object.values(e.dias).filter(x => x.origem !== 'gerador').length,
    indicadores: r.indicadores, regrasAplicadas: r.regrasAplicadas, conflitos: { trabalhistas: r.conflitos.trabalhistas, operacionais: r.conflitos.operacionais.filter(fora) }, divergenciasContratuais: r.divergenciasContratuais, cobertura: r.cobertura,
    transicao: r.transicao, historico: H.resumo, pesos: r.pesos,
    domingosFeriados: r.domingosFeriados, pessoas: r.proposta.map(p => ({ id: p.id, nome: p.nome, setor: p.setor, folga_fixa: p.folga_fixa, horas: p.horas, domingosTrabalhados: p.domingosTrabalhados, domingosFolga: p.domingosFolga, semanas: p.semanas })) };
}

// ── Ajustar o quadro pelo ponto (admitidos entram; quem saiu fica marcado, nunca é apagado) ───────────────
function sincronizarQuadro(user, loja, mes, ctx, justificativa) {
  exige(rhDa(user, loja), 'Só o RH Ponto da unidade ajusta o quadro'); const just = txt(justificativa, 500); if (just.length < 5) throw erro('Justifique o ajuste do quadro');
  if (!ctx.colabs || !ctx.escalasPC) throw erro('O PontoCerto não respondeu agora', 503); const e = E.obter(loja, mes); if (['enviada_rh', 'validada_rh'].includes(e.status)) throw erro('Escala em aprovação: peça a devolução antes de ajustar o quadro', 409);
  const atual = E.funcsDoPontoCerto(loja, ctx.colabs, ctx.escalasPC); const ids = new Set(e.funcionarios.map(f => String(f.id))); const novos = atual.filter(f => !ids.has(String(f.id)));
  const ativos = new Set(atual.map(f => String(f.id))); const hoje = ctx.hoje || hojeISO(); const sairam = [];
  for (const f of e.funcionarios) { if (f.id < 0 || ativos.has(String(f.id)) || f.desligamento) continue; const d = (ctx.colabs.desligados || []).find(x => String(x.id) === String(f.id)); f.desligamento = (d && d.desligamento) || hoje; f.saida_motivo = d ? 'desligado' : 'fora da unidade'; sairam.push({ id: f.id, nome: f.nome, desde: f.desligamento, motivo: f.saida_motivo }); }
  if (!novos.length && !sairam.length) return { ok: true, adicionados: [], sairam: [] };
  const nv = E.reabrirSeAprovada(e, user, 'Quadro ajustado pelo RH em escala aprovada (nova versão)'); e.funcionarios.push(...novos); e.funcionarios.sort((a, b) => a.setor.localeCompare(b.setor) || a.nome.localeCompare(b.nome));
  e.fluxo.push({ em: agora(), usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de: e.status, para: e.status, texto: 'Quadro ajustado pelo ponto: ' + novos.length + ' admitido(s) incluído(s), ' + sairam.length + ' marcado(s) como fora da unidade. ' + just });
  E.salvar(e); auditar(user, 'quadro', { ref: 'ESC-' + loja + '-' + mes, loja: +loja, mes, justificativa: just, adicionados: novos.map(f => ({ id: f.id, nome: f.nome, setor: f.setor })), sairam, novaVersao: nv });
  avisar({ nivel: nv ? 'critico' : 'rotina', loja, mes, texto: (GP.LOJA_TXT[loja] || loja) + ' ' + mes.split('-').reverse().join('/') + ': quadro ajustado por ' + (user.nome || user.usuario) + ' (' + novos.length + ' incluído(s), ' + sairam.length + ' fora). ' + just, autor: user });
  return { ok: true, adicionados: novos.map(f => f.nome), sairam: sairam.map(f => f.nome) };
}

// ── Depois de uma edição de dia na grade (lib/escalas-rotas.js chama): classifica e avisa a Coordenação ──
function aposEdicao(user, loja, mes, body, statusAntes) {
  const e = E.ler(loja, mes); if (!e) return; const f = e.funcionarios.find(x => +x.id === +body.funcId); const data = String(body.data || ''); const dBR = data.split('-').reverse().slice(0, 2).join('/');
  const peloRH = !GP.gerenteDa(user, loja); const sensivel = dow(data) === 0 || E.feriado(data) || (f && (f.folga_fixa || []).includes(dow(data)));
  const nivel = statusAntes === 'aprovada' ? 'critico' : (peloRH && sensivel) ? 'relevante' : 'rotina';
  avisar({ nivel, loja, mes, texto: (GP.LOJA_TXT[loja] || loja) + ': ' + (user.nome || user.usuario) + (peloRH ? ' (RH)' : '') + ' alterou ' + (f ? f.nome : 'funcionário') + ' em ' + dBR + ' (' + DIAS[dow(data)] + ')' + (statusAntes === 'aprovada' ? ' — ESCALA APROVADA reaberta como versão ' + e.versao : '') + (body.justificativa ? '. ' + txt(body.justificativa, 200) : ''), autor: user });
}

// ── Trilha de auditoria (gerador + alterações da grade + fluxo de aprovação) ─────────────────────────────
const ACAO_TXT = { regra_criar: 'Regra trabalhista criada', regra_alterar: 'Regra trabalhista alterada', regra_validar: 'Regra validada pelo RH', regra_encerrar: 'Vigência da regra encerrada', cadastro: 'Folga fixa / setor / restrições', cobertura: 'Cobertura e pesos por dia do gerador', historico_validar: 'Dias sem confirmação do ponto validados pelo RH', escala_criar: 'Escala criada do PontoCerto', gerar_aplicar: 'Geração 5×2 aplicada', gerar_desfazer: 'Geração 5×2 desfeita', quadro: 'Quadro ajustado pelo ponto' };
function trilha(user, filtro = {}) {
  exige(GP.vePainel(user), 'Sem acesso à auditoria'); const loja = filtro.loja ? +filtro.loja : null; const mes = MES.test(filtro.mes || '') ? filtro.mes : null; if (loja != null) exige(podeVer(user, loja), 'Unidade fora do seu escopo');
  const out = [];
  for (const r of lerLinhas(P.aud())) { if (r.loja != null && !podeVer(user, r.loja)) continue; if (loja != null && r.loja != null && r.loja !== loja) continue; if (mes && r.mes && r.mes !== mes) continue;
    out.push({ origem: 'gerador', seq: r.seq, em: r.em, usuario: r.usuario, nome: r.nome, papeis: r.papeis, acao: r.acao, acaoTxt: ACAO_TXT[r.acao] || r.acao, loja: r.loja == null ? null : r.loja, mes: r.mes || null, ref: r.ref || null, justificativa: r.justificativa || null, antes: r.antes === undefined ? null : r.antes, depois: r.depois === undefined ? null : r.depois, alteracoes: r.alteracoes || null,
      detalhe: r.acao === 'gerar_aplicar' ? r.dias + ' dia(s) de ' + r.de + ' a ' + r.ate + (r.substituidos ? ', ' + r.substituidos + ' substituído(s)' : '') + (r.novaVersao ? ', nova versão ' + r.versao : '') : r.acao === 'gerar_desfazer' ? r.restaurados + ' restaurado(s), ' + r.mantidos + ' mantido(s)' : r.acao === 'quadro' ? (r.adicionados || []).length + ' incluído(s), ' + (r.sairam || []).length + ' fora' : null, hash: r.hash.slice(0, 12) }); }
  const lojas = loja != null ? [loja] : GP.LOJAS.filter(l => podeVer(user, l));
  for (const { loja: l, mes: m } of E.listar()) { if (!lojas.includes(l) || (mes && m !== mes)) continue; const e = E.ler(l, m); if (!e) continue;
    for (const h of e.historico || []) out.push({ origem: 'grade', em: h.em, usuario: h.usuario, nome: h.nome, acao: h.acao, acaoTxt: (h.acao === 'restaurar' ? 'Dia restaurado ao contratual' : 'Dia alterado na grade') + (h.peloRH ? ' (RH)' : ''), loja: l, mes: m, ref: h.funcionario + ' · ' + String(h.data).split('-').reverse().join('/'), justificativa: h.justificativa || null, antes: h.antes, depois: h.depois, detalhe: 'versão ' + h.versao });
    for (const h of e.fluxo || []) out.push({ origem: 'fluxo', em: h.em, usuario: h.usuario, nome: h.nome, papeis: h.papeis, acao: 'fluxo', acaoTxt: h.de === h.para ? 'Registro na escala' : 'Fluxo: ' + (E.STATUS_TXT[h.de] || h.de) + ' → ' + (E.STATUS_TXT[h.para] || h.para), loja: l, mes: m, ref: null, justificativa: h.texto || null, antes: null, depois: null, detalhe: null }); }
  out.sort((a, b) => b.em.localeCompare(a.em));
  return { cadeia: verificarCadeia(), total: out.length, registros: out.slice(0, 600) };
}
function geracao(user, id) { const g = lerJson(P.ger(String(id).replace(/[^A-Za-z0-9-]/g, '')), null); if (!g) throw erro('Geração não encontrada', 404); exige(podeVer(user, g.loja), 'Unidade fora do seu escopo'); return g; }

module.exports = { P, cfg, podeVer, rhDa, podeRegras, podeValidarRegra, auditar, verificarCadeia, avisar, relatorioDiario, avisos, marcarVistos, listarRegras, salvarRegra, validarRegra, encerrarRegra, folgaFixaDe, cadastroLoja, salvarCadastro, coberturaLoja, salvarCobertura,
  escalaDe, periodo, janelaHistorico, historicoReal, validarHistorico, simular, aplicar, desfazer, listarGeracoes, resumoGeracao, geracao, analisar, sincronizarQuadro, aposEdicao, trilha, mesAnterior };
