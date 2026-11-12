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
function cfg() { const c = lerJson(P.cfg(), null) || {}; return { versao: c.versao || 1, regras: c.regras || [], funcionarios: c.funcionarios || {}, lojas: c.lojas || {}, historico: c.historico || {}, excecoesFolga: c.excecoesFolga || {}, relatorioHora: c.relatorioHora == null ? 18 : c.relatorioHora }; }
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
  p.feriado = { tratamento: txt((q.feriado || {}).tratamento, 300) || 'conforme_convencao', folgado: (q.feriado || {}).folgado === 'a_parte' ? 'a_parte' : 'folga' };   // feriado folgado conta como folga da semana, ou é descanso à parte
  p.folgasConsecutivas = q.folgasConsecutivas === 'evitar' ? 'evitar' : 'livre';   // modelo flexível (padrão): juntas ou separadas; 'evitar' só quando a convenção prefere separadas
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
  if (cad && cad.duasRotativas) return { dia: null, origem: 'duas_rotativas' };   // autorizado pelo RH: as duas folgas são rotativas
  if (cad && cad.folga_fixa != null) return { dia: +cad.folga_fixa, origem: 'rh' };
  const c = folgasContrato(f).filter(d => d !== 0); return c.length ? { dia: c[0], origem: 'contrato' } : { dia: null, origem: 'nenhuma' };
}
// Sexo do funcionário (para o revezamento dominical feminino e a verificação do art. 386 da CLT): o informado pelo RH no
// cadastro do gerador; sem ele, o do cadastro do ponto (campo gender do GET /employees — hoje preenchido para poucos); sem
// nenhum dos dois fica "não informado" e a pessoa não é alcançada pela regra (nada é presumido pelo nome).
const sexoNorm = v => { const s = String(v == null ? '' : v).trim().toUpperCase(); return s.startsWith('F') ? 'F' : s.startsWith('M') ? 'M' : null; };
function sexoDe(f, cad, colabs) {
  const rh = sexoNorm(cad && cad.sexo); if (rh) return { valor: rh, origem: 'rh' };
  const c = colabs ? (colabs.ativos || []).find(x => String(x.id) === String(f.id)) : null; const p = sexoNorm((c && c.sexo) || f.sexo);
  return p ? { valor: p, origem: 'ponto' } : { valor: null, origem: 'nao_informado' };
}
function cadastroLoja(loja, funcs, colabs) {
  const C = cfg().funcionarios;
  return funcs.map(f => { const c = C[f.id] || {}; const ff = folgaFixaDe(f, c); const sx = sexoDe(f, c, colabs); return { sexo: sx.valor, sexoOrigem: sx.origem, id: f.id, nome: f.nome, cargo: f.cargo || '', setor: c.setor || f.setor, setorEscala: f.setor, folga_fixa: ff.dia, folgaOrigem: ff.origem, duasRotativas: !!c.duasRotativas, folgasContrato: folgasContrato(f), categoria: c.categoria || '', naoTrabalha: c.naoTrabalha || [], entradaMin: c.entradaMin || '', saidaMax: c.saidaMax || '', obs: c.obs || '', definidoPor: c.por || null, definidoEm: c.em || null }; });
}
function salvarCadastro(user, loja, funcs, itens, justificativa) {
  exige(rhDa(user, loja), 'Só o RH Ponto da unidade ajusta folga fixa, setor e restrições'); const just = txt(justificativa, 500); if (just.length < 5) throw erro('Justifique o ajuste');
  const c = cfg(); const mud = [];
  for (const it of itens || []) {
    const f = funcs.find(x => String(x.id) === String(it.id)); if (!f) throw erro('Funcionário ' + it.id + ' não está no quadro desta unidade');
    const antes = c.funcionarios[f.id] || {}; const novo = { ...antes };
    if ('folga_fixa' in it) { if (it.folga_fixa === null || it.folga_fixa === '') novo.folga_fixa = null; else { const d = +it.folga_fixa; if (!(d >= 0 && d <= 6)) throw erro('Folga fixa inválida'); novo.folga_fixa = d; novo.duasRotativas = false; } }
    // modelo flexível: duas folgas rotativas só com autorização expressa no cadastro do funcionário (a folga fixa deixa de valer)
    if ('duasRotativas' in it) { novo.duasRotativas = it.duasRotativas === true; if (novo.duasRotativas) novo.folga_fixa = null; }
    if ('categoria' in it) novo.categoria = semAcento(it.categoria).slice(0, 60);
    if ('setor' in it) novo.setor = semAcento(it.setor).slice(0, 60) || null;
    if ('naoTrabalha' in it) { const l = [...new Set((it.naoTrabalha || []).map(Number))]; if (l.some(d => !(d >= 0 && d <= 6)) || l.length > 2) throw erro('Restrição de dias inválida (no máximo 2 dias da semana)'); novo.naoTrabalha = l; }
    for (const k of ['entradaMin', 'saidaMax']) if (k in it) { if (it[k] && !HM.test(it[k])) throw erro('Horário inválido em ' + k); novo[k] = it[k] || ''; }
    if ('obs' in it) novo.obs = txt(it.obs, 200);
    if ('sexo' in it) { if (it.sexo === null || it.sexo === '') novo.sexo = null; else { const s = sexoNorm(it.sexo); if (!s) throw erro('Sexo inválido (F ou M)'); novo.sexo = s; } }
    const chave = x => JSON.stringify([x.folga_fixa == null ? null : x.folga_fixa, !!x.duasRotativas, x.sexo || null, x.categoria || '', x.setor || null, x.naoTrabalha || [], x.entradaMin || '', x.saidaMax || '', x.obs || '']);
    if (chave(antes) === chave(novo)) continue;
    novo.por = user.usuario; novo.em = agora(); c.funcionarios[f.id] = novo; mud.push({ id: f.id, nome: f.nome, antes, depois: novo });
  }
  if (!mud.length) return { ok: true, alterados: 0 };
  salvarCfg(c); auditar(user, 'cadastro', { ref: 'CAD-' + loja, loja: +loja, justificativa: just, alteracoes: mud });
  avisar({ nivel: 'rotina', loja, texto: (GP.LOJA_TXT[loja] || loja) + ': ' + (user.nome || user.usuario) + ' ajustou folga fixa / modelo de folga / setor / restrições de ' + mud.length + ' funcionário(s). ' + just, autor: user });
  return { ok: true, alterados: mud.length };
}
function coberturaLoja(loja) {
  const L = E.config().lojas[loja] || { abre: '07:00', fecha: '19:00', setores: {} }; const g = cfg().lojas[loja] || {}; const setores = {};
  for (const [s, v] of Object.entries(L.setores || {})) setores[s] = { min: (v && v.min) || 0, faixas: (g.picos || []).filter(p => p.setor === s).map(p => ({ dias: p.dias, ini: p.ini, fim: p.fim, min: p.min })) };
  for (const p of g.picos || []) if (!setores[p.setor]) setores[p.setor] = { min: 0, faixas: [{ dias: p.dias, ini: p.ini, fim: p.fim, min: p.min }] };
  // prioridade operacional por dia da semana: a da unidade e, quando informada, a do setor (que vence a da unidade)
  const pesosSetor = g.pesosSetor || {};
  for (const [s, pd] of Object.entries(pesosSetor)) { if (!setores[s]) setores[s] = { min: 0, faixas: [] }; setores[s].pesoDia = pd; }
  return { abre: L.abre, fecha: L.fecha, setores, entradas: g.entradas || [], pesoDia: g.pesoDia || {}, pesosSetor, picos: g.picos || [], turnos: turnosLoja(loja) };
}

// ── Turnos e cores da grade (Etapa 4) ────────────────────────────────────────────────────────────────────
// Cada dia de trabalho é classificado em Abertura / Intermediário / Fechamento / Turno especial a partir do horário de
// funcionamento: o da UNIDADE é o da configuração das escalas (abre/fecha — não é cadastrado de novo aqui) e cada SETOR pode
// ter o seu. Os limites ("abertura: entrada até", "fechamento: saída a partir de") e os horários tratados como especiais são
// configuráveis por unidade e por setor em gerador.json › lojas[n].turnos / turnosSetor. Nenhum horário fica fixo no código:
// sem configuração, os limites saem do próprio horário de funcionamento (motor: limitesTurno).
const CLASSE_TXT = { abertura: 'Abertura', intermediario: 'Intermediário', fechamento: 'Fechamento', especial: 'Turno especial' };
const CORES = { abertura: '#CDEFD9', intermediario: '#D6E8FA', fechamento: '#FFDCC2', especial: '#F9CFE3', folga_fixa: '#EBEBE8', folga_rotativa: '#C4C4BE', ferias: '#EBDDF9', afastado: '#CDBFEF', feriado: '#FBEAED' };
const PAR_HM = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
/** Valida um bloco de turnos. `setor` = pode ter funcionamento próprio (a unidade usa o da configuração das escalas). */
function normTurno(v, rotulo, setor) {
  v = v || {}; const o = {};
  for (const k of setor ? ['abre', 'fecha', 'aberturaAte', 'fechamentoDesde'] : ['aberturaAte', 'fechamentoDesde']) { const x = String(v[k] == null ? '' : v[k]).trim(); if (!x) continue; if (!HM.test(x)) throw erro('Horário inválido em ' + rotulo); o[k] = x; }
  const esp = [...new Set((Array.isArray(v.especiais) ? v.especiais : String(v.especiais || '').split(/[,;\n]/)).map(x => { const t = String(x).replace(/[–—]/g, '-').replace(/\s/g, ''); const m = t.match(/^(\d{2}):?(\d{2})-(\d{2}):?(\d{2})$/); return m ? m[1] + ':' + m[2] + '-' + m[3] + ':' + m[4] : t; }).filter(Boolean))].sort();
  if (esp.some(x => !PAR_HM.test(x) || x.slice(6) <= x.slice(0, 5)) || esp.length > 12) throw erro('Horários especiais inválidos em ' + rotulo + ' (entrada-saída no formato HH:MM-HH:MM, até 12)');
  if (esp.length) o.especiais = esp; return o;
}
/** Turnos resolvidos da unidade e de cada setor com configuração própria (o setor herda da unidade o que não informar). */
function turnosLoja(loja) {
  const L = E.config().lojas[loja] || { abre: '07:00', fecha: '19:00' }; const g = cfg().lojas[loja] || {}; const hm = M._util.hm;
  const res = (b, pai) => { const abre = b.abre || pai.abre, fecha = b.fecha || pai.fecha;
    const lim = M.limitesTurno({ abre, fecha, aberturaAte: b.aberturaAte || (b.abre ? null : pai.aberturaAte), fechamentoDesde: b.fechamentoDesde || (b.fecha ? null : pai.fechamentoDesde), especiais: b.especiais || pai.especiais || [] });
    return { abre, fecha, aberturaAte: hm(lim.aberturaAte), fechamentoDesde: hm(lim.fechamentoDesde), especiais: lim.especiais }; };
  const u = g.turnos || {}; const unidade = res(u, { abre: L.abre, fecha: L.fecha, aberturaAte: null, fechamentoDesde: null, especiais: [] });
  const setores = {}; for (const [s, b] of Object.entries(g.turnosSetor || {})) setores[s] = { ...res(b, unidade), proprio: b };
  return { unidade: { ...unidade, proprio: u }, setores, classes: M.CLASSES_TURNO.map(id => ({ id, nome: CLASSE_TXT[id], cor: CORES[id] })), cores: CORES };
}
/** Funcionamento e limites de turno no formato que o motor usa para a cobertura por turno. */
const turnosDoMotor = loja => { const T = turnosLoja(loja); return { unidade: T.unidade, setores: T.setores }; };
/** Pinta a grade: grava `classe` em cada dia de trabalho de `funcs[].dias` e devolve a legenda (classificação, cor, regra e
 *  os horários que caíram em cada uma). Serve a proposta do gerador e a Escala coletiva. */
function pintar(loja, funcs) {
  const T = turnosLoja(loja); const achados = {};
  for (const f of funcs || []) for (const d of Object.values(f.dias || {})) {
    if (!d || d.tipo !== 'trabalho') continue; const c = M.classificarTurno(d, T.setores[d.setor || f.setor] || T.unidade); d.classe = c;
    if (d.entrada && d.saida) { const a = achados[c] || (achados[c] = {}); const k = d.entrada.replace(':', '') + '-' + d.saida.replace(':', ''); a[k] = (a[k] || 0) + 1; }
  }
  const u = T.unidade; const regra = { abertura: 'entrada até ' + u.aberturaAte, intermediario: 'entrada depois de ' + u.aberturaAte + ' e saída antes de ' + u.fechamentoDesde, fechamento: 'saída a partir de ' + u.fechamentoDesde,
    especial: (u.especiais.length ? 'horários ' + u.especiais.map(x => x.replace('-', '–')).join(', ') + '; ' : '') + 'jornada fora do funcionamento ou da abertura ao fechamento' };
  return { funcionamento: { abre: u.abre, fecha: u.fecha }, setoresProprios: Object.entries(T.setores).map(([s, t]) => ({ setor: s, abre: t.abre, fecha: t.fecha, aberturaAte: t.aberturaAte, fechamentoDesde: t.fechamentoDesde, especiais: t.especiais })),
    classes: M.CLASSES_TURNO.map(id => ({ id, nome: CLASSE_TXT[id], cor: CORES[id], regra: regra[id], dias: Object.values(achados[id] || {}).reduce((a, b) => a + b, 0), horarios: Object.entries(achados[id] || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k) })), cores: CORES };
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
  // turnos e cores (classificação por horário): quem não manda o campo mantém o que estava gravado
  let turnos = antes.turnos || {}, turnosSetor = antes.turnosSetor || {}; const L = E.config().lojas[loja] || { abre: '07:00', fecha: '19:00' };
  const coerente = (t, pai, rot) => { const abre = t.abre || pai.abre, fecha = t.fecha || pai.fecha; if (fecha <= abre) throw erro('Funcionamento inválido em ' + rot + ' (fecha depois de abrir)');
    if (t.aberturaAte && (t.aberturaAte < abre || t.aberturaAte >= fecha)) throw erro('"Abertura: entrada até" de ' + rot + ' precisa ficar dentro do funcionamento (' + abre + ' a ' + fecha + ')');
    if (t.fechamentoDesde && t.fechamentoDesde <= abre) throw erro('"Fechamento: saída a partir de" de ' + rot + ' precisa ser depois da abertura (' + abre + ')'); return { abre, fecha }; };
  if ('turnos' in b) { turnos = normTurno(b.turnos, 'a unidade', false); coerente(turnos, L, 'a unidade'); }
  if ('turnosSetor' in b) { turnosSetor = {}; for (const [s, v] of Object.entries(b.turnosSetor || {})) { const k = semAcento(s).slice(0, 60); if (!k) continue; const t = normTurno(v, k, true); if (Object.keys(t).length) { coerente(t, L, k); turnosSetor[k] = t; } } if (Object.keys(turnosSetor).length > 30) throw erro('No máximo 30 setores com turno próprio'); }
  c.lojas[loja] = { ...antes, entradas, picos, pesoDia, pesosSetor, turnos, turnosSetor, por: user.usuario, em: agora() };
  salvarCfg(c); auditar(user, 'cobertura', { ref: 'COB-' + loja, loja: +loja, justificativa: just, antes: { entradas: antes.entradas || [], picos: antes.picos || [], pesoDia: antes.pesoDia || {}, pesosSetor: antes.pesosSetor || {}, turnos: antes.turnos || {}, turnosSetor: antes.turnosSetor || {} }, depois: { entradas, picos, pesoDia, pesosSetor, turnos, turnosSetor } });
  avisar({ nivel: 'relevante', loja, texto: (GP.LOJA_TXT[loja] || loja) + ': entradas permitidas, reforços de pico, pesos por dia e classificação dos turnos do gerador alterados por ' + (user.nome || user.usuario) + '. ' + just, autor: user });
  return coberturaLoja(loja);
}

// ── Configurações avançadas · Revezamento dominical feminino — 1×1 (Etapa 7) ─────────────────────────────
// Interruptor POR UNIDADE, desligado por padrão, em gerador.json › lojas[n].dominicalFeminino. Ligado: as trabalhadoras
// alternam um domingo trabalhado e um de descanso (o domingo de descanso é uma das duas folgas da semana). Desligado: o
// gerador não impõe o padrão, mas a verificação do art. 386 continua e bloqueia a publicação do que descumprir. O texto
// legal é o que o Tiago mandou exibir; fica aqui para a tela e a auditoria usarem a mesma redação.
const DOMINICAL_INFO = { nome: 'Revezamento dominical feminino — 1×1', titulo: 'Fundamentação legal — Art. 386 da CLT',
  citacao: 'Havendo trabalho aos domingos, será organizada uma escala de revezamento quinzenal, que favoreça o repouso dominical.',
  origem: 'Decreto-Lei nº 5.452/1943 — Consolidação das Leis do Trabalho, art. 386, na seção de proteção ao trabalho da mulher.',
  aplicacao: 'o revezamento quinzenal é operacionalizado por alternância entre um domingo trabalhado e outro de descanso, observadas as demais normas aplicáveis.',
  importante: 'desativar esta opção não afasta a obrigação de cumprir a legislação trabalhista.',
  linkTxt: 'Consultar legislação oficial', link: 'https://www.planalto.gov.br/ccivil_03/decreto-lei/del5452compilado.htm' };
const dominicalLoja = loja => { const d = (cfg().lojas[loja] || {}).dominicalFeminino || {}; return { ativo: d.ativo === true, por: d.por || null, porNome: d.nome || null, em: d.em || null, justificativa: d.justificativa || null }; };
const podeDominical = (u, loja) => rhDa(u, loja) || GP.temPapel(u, 'coordenacao');   // usuário autorizado: RH Ponto da unidade ou Coordenação
const alcanceDominical = (funcs, colabs) => { const C = cfg().funcionarios; const s = (funcs || []).map(f => sexoDe(f, C[f.id] || {}, colabs).valor); return { mulheres: s.filter(x => x === 'F').length, homens: s.filter(x => x === 'M').length, semSexo: s.filter(x => !x).length }; };
/** Estado das configurações avançadas da unidade (o texto legal vem sempre, com a regra ligada ou desligada). */
function avancadas(user, loja, funcs, colabs) {
  exige(podeVer(user, loja), 'Unidade fora do seu escopo');
  // sem `funcs` devolve só o estado e o texto legal (resposta imediata, sem consultar o ponto); a contagem vem quando o quadro é informado
  return { loja: +loja, lojaTxt: GP.LOJA_TXT[loja], podeAlterar: podeDominical(user, loja), dominical: { ...DOMINICAL_INFO, ...dominicalLoja(loja), ...(funcs ? alcanceDominical(funcs, colabs) : { mulheres: null, homens: null, semSexo: null }) } };
}
/** Liga ou desliga o revezamento dominical feminino 1×1 da unidade. Fica na auditoria (quem, quando, unidade, antes/depois,
 *  quantas trabalhadoras alcança e a situação de cada escala em aberto) e a Coordenação é avisada na hora. */
function salvarDominical(user, loja, funcs, colabs, body) {
  exige(podeDominical(user, loja), 'Só o RH Ponto da unidade ou a Coordenação alteram o revezamento dominical feminino'); if (!GP.LOJAS.includes(+loja)) throw erro('Unidade inválida'); body = body || {};
  if (typeof body.ativo !== 'boolean') throw erro('Informe se a regra fica ativada ou desativada'); const just = txt(body.justificativa, 500); if (just.length < 10) throw erro('Justifique a alteração (mínimo de 10 caracteres)');
  const c = cfg(); const antes = dominicalLoja(loja); if (antes.ativo === body.ativo) throw erro('O revezamento dominical feminino já está ' + (body.ativo ? 'ativado' : 'desativado') + ' nesta unidade', 409);
  c.lojas[loja] = { ...(c.lojas[loja] || {}), dominicalFeminino: { ativo: body.ativo, por: user.usuario, nome: user.nome || user.usuario, em: agora(), justificativa: just } }; salvarCfg(c);
  // o interruptor não regrava nenhum dia: a escala muda na próxima geração (que registra dia a dia o que mudou). Aqui fica o
  // retrato de cada escala do mês corrente em diante, já com a regra nova
  const mesHoje = hojeISO().slice(0, 7); const escalas = [];
  for (const { loja: l, mes } of E.listar()) { if (+l !== +loja || mes < mesHoje) continue; try { const a = analiseBase(loja, mes, { afast: null, colabs: colabs || null }); if (!a) continue;
    escalas.push({ mes, status: a.e.status, versao: a.e.versao, diasDoGerador: Object.values(a.e.dias).filter(x => x.origem === 'gerador').length, violacoesArt386: a.r.dominicalFeminino.violacoes, bloqueiosTrabalhistas: a.r.conflitos.trabalhistas.filter(x => x.gravidade === 'bloqueio').length }); } catch (err) { escalas.push({ mes, erro: err.message }); } }
  const alcance = alcanceDominical(funcs, colabs);
  const reg = auditar(user, 'dominical_feminino', { ref: 'DOM-' + loja, loja: +loja, justificativa: just, antes: { ativo: antes.ativo, por: antes.por, em: antes.em }, depois: { ativo: body.ativo, por: user.usuario, em: c.lojas[loja].dominicalFeminino.em }, alcance, escalas,
    alteracoesNasEscalas: 'Nenhum dia é regravado ao ' + (body.ativo ? 'ativar' : 'desativar') + ': a mudança entra na próxima geração de cada escala, que registra na auditoria os dias alterados.' });
  avisar({ nivel: 'relevante', loja, texto: (GP.LOJA_TXT[loja] || loja) + ': ' + (user.nome || user.usuario) + (body.ativo ? ' ATIVOU' : ' DESATIVOU') + ' o revezamento dominical feminino 1×1 (' + alcance.mulheres + ' trabalhadora(s) identificada(s), ' + alcance.semSexo + ' funcionário(s) sem o sexo informado). ' + just, autor: user, ref: 'DOM-' + loja });
  return { ok: true, auditoria: reg.seq, dominical: { ...DOMINICAL_INFO, ...dominicalLoja(loja), ...alcance }, escalas };
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
  const hist = {}; const n = { trabalho: 0, descanso: 0, ausencia: 0, indefinido: 0, naoConfirmado: 0, planejadoFuturo: 0, validadoRH: 0, incompletas: 0, semDado: 0, semIntervalo: 0 }; const pend = []; const semPonto = [];
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
      if (w && w.marcacoes && w.marcacoes.length) { const h = horariosDasMarcacoes(w.marcacoes, plan); const semItv = !h.almoco_ini && min(h.entrada) != null && min(h.saida) != null && min(h.saida) - min(h.entrada) > 360;   // mais de 6 h batidas sem intervalo registrado nem previsto
        dias[d] = { tipo: 'trabalho', entrada: h.entrada, saida: h.saida, almoco_ini: h.almoco_ini, almoco_fim: h.almoco_fim, setor: f.setor, fonte: 'ponto', ...(h.incompleta ? { incompleta: true } : {}), ...(semItv ? { intervaloNaoRegistrado: true } : {}), ...(plan.tipo === 'folga' ? { emFolgaPrevista: true } : {}) }; n.trabalho++; if (h.incompleta) n.incompletas++; if (semItv) n.semIntervalo++; continue; }
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
  if (n.semIntervalo) lim.push(n.semIntervalo + ' dia(s) com só entrada e saída no ponto, mais de 6 h e nenhum intervalo batido ou previsto: a carga desses dias entra pela permanência (não há intervalo registrado para descontar) — conferir com o RH.');
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
/** Exceção à regra das duas folgas: semana com MENOS folgas do que a regra pede, justificada e analisada pelo RH Ponto da
 *  unidade (nunca vale para folga a mais). Fica na auditoria e a Coordenação é avisada na hora; `remover` desfaz. */
function registrarExcecaoFolga(user, loja, funcs, b) {
  exige(rhDa(user, loja), 'Só o RH Ponto da unidade analisa exceção à regra das duas folgas'); b = b || {};
  const f = (funcs || []).find(x => String(x.id) === String(b.funcId)); if (!f) throw erro('Funcionário ' + b.funcId + ' não está no quadro desta unidade');
  if (!ISO.test(String(b.semana || ''))) throw erro('Informe a semana (qualquer dia dela, AAAA-MM-DD)'); const seg = M._util.segunda(b.semana), fim = soma(seg, 6);
  const just = txt(b.justificativa, 600); if (just.length < 10) throw erro('Descreva a situação que justifica a exceção (mínimo de 10 caracteres)');
  const c = cfg(); const k = f.id + '|' + seg; const antes = c.excecoesFolga[k] || null;
  if (b.remover) { if (!antes) return { ok: true, removida: false }; delete c.excecoesFolga[k]; } else c.excecoesFolga[k] = { motivo: just, loja: +loja, por: user.usuario, nome: user.nome || user.usuario, em: agora() };
  const setor = (c.funcionarios[f.id] || {}).setor || f.setor;
  salvarCfg(c); auditar(user, 'folga_excecao', { ref: 'EXC-' + loja + '-' + f.id + '-' + seg, loja: +loja, mes: seg.slice(0, 7), funcId: f.id, funcionario: f.nome, setor, semana: { inicio: seg, fim }, justificativa: just, antes, depois: c.excecoesFolga[k] || null });
  avisar({ nivel: 'relevante', loja, mes: seg.slice(0, 7), texto: (GP.LOJA_TXT[loja] || loja) + ': ' + (user.nome || user.usuario) + ' (RH) ' + (b.remover ? 'retirou a exceção' : 'registrou exceção') + ' à regra das duas folgas para ' + f.nome + ' na semana de ' + seg.split('-').reverse().slice(0, 2).join('/') + ' a ' + fim.split('-').reverse().slice(0, 2).join('/') + '. ' + just, autor: user });
  return { ok: true, removida: !!b.remover, semana: { inicio: seg, fim } };
}
function funcsDoMotor(e, ctx) {
  const C = cfg().funcionarios; const adm = new Map(); if (ctx.colabs) for (const c of ctx.colabs.ativos || []) if (c.admissao) adm.set(String(c.id), c.admissao);
  return e.funcionarios.map(f => { const c = C[f.id] || {}; const a = ctx.afast ? (ctx.afast.get(semAcento(f.nome)) || []) : [];
    return { sexo: sexoDe(f, c, ctx.colabs).valor, id: f.id, nome: f.nome, setor: c.setor || f.setor, estabelecimento: e.loja, categoria: c.categoria || null, folga_fixa: folgaFixaDe(f, c).dia, base: f.base, admissao: adm.get(String(f.id)) || undefined, desligamento: f.desligamento || undefined,
      ...(c.duasRotativas ? { duasRotativas: true } : {}),
      restricoes: { naoTrabalha: c.naoTrabalha || [], entradaMin: c.entradaMin || null, saidaMax: c.saidaMax || null }, ausencias: a.map(x => ({ inicio: x.inicio, fim: x.fim, tipo: x.ferias ? 'ferias' : 'afastado' })) }; });
}
const assinar = (r, de, ate) => sha(JSON.stringify([de, ate, r.proposta.map(p => [p.id, p.dias])])).slice(0, 16);

// ── Simular ──────────────────────────────────────────────────────────────────────────────────────────────
function simular(user, loja, mes, ctx, opts = {}) {
  exige(podeVer(user, loja), 'Unidade fora do seu escopo'); const hoje = ctx.hoje || hojeISO(); const { e, existe } = escalaDe(loja, mes, ctx); const per = periodo(mes, opts.aPartirDe, hoje);
  const R = E.resolver(e, ctx.afast || null); const travados = {};
  const atual = {};   // geração que já está na grade e será trocada: o motor mexe o mínimo nela (critério 7)
  for (const [k, ov] of Object.entries(e.dias)) { const data = k.slice(k.indexOf('|') + 1); if (data < per.de) continue; if (ov.origem !== 'gerador') travados[k] = limpo(ov); else atual[k] = limpo(ov); }
  const H = historicoReal(e, per.de, ctx);
  const r = M.gerar({ de: per.de, ate: per.ate, funcionarios: funcsDoMotor(e, ctx), regras: cfg().regras, historico: H.hist, travados, cobertura: coberturaLoja(loja), feriados: E.config().feriados, excecoesFolga: cfg().excecoesFolga, turnos: turnosDoMotor(loja), atual, dominicalFeminino: { ativo: dominicalLoja(loja).ativo } });
  const assinatura = assinar(r, per.de, per.ate); const classes = pintar(loja, r.proposta);   // a assinatura sai antes de pintar: mudar a cor de um turno não invalida a simulação
  const pend = []; const cod = r.publicacao.bloqueios.map(b => b.codigo);
  // regra das duas folgas: semana com 3 ou mais, ou com menos do que a regra pede sem exceção do RH, não pode ser aplicada
  const d2 = r.duasFolgas; if (d2.excesso || d2.falta) pend.push({ codigo: 'duas_folgas', texto: (d2.excesso + d2.falta) + ' semana(s) fora da regra das duas folgas (' + d2.excesso + ' com folga a mais, ' + d2.falta + ' com folga a menos) — o motor não conseguiu fechar com os dias que já estão fixos na grade' });
  // semana de transição sem dados suficientes: não aplica (o RH valida os dias pendentes ou começa numa segunda-feira)
  const proxSeg = soma(M._util.segunda(per.de), 7); const sugestaoInicio = r.transicao.necessaria && proxSeg <= per.ate ? proxSeg : null;
  if (cod.includes('transicao_sem_dados')) pend.push({ codigo: 'transicao_sem_dados', texto: r.publicacao.bloqueios.find(b => b.codigo === 'transicao_sem_dados').texto + (sugestaoInicio ? ' (próxima segunda: ' + sugestaoInicio.split('-').reverse().slice(0, 2).join('/') + ')' : '') });
  if (['enviada_rh', 'validada_rh'].includes(e.status)) pend.push({ codigo: 'em_aprovacao', texto: 'A escala de ' + mes.split('-').reverse().join('/') + ' está em aprovação (' + E.STATUS_TXT[e.status] + '): peça a devolução antes de aplicar' });
  if (!ctx.afast) pend.push({ codigo: 'afastamentos_indisponiveis', texto: 'O PontoCerto não devolveu férias e afastamentos agora: sem eles a proposta não pode ser aplicada' });
  if (cod.includes('regra_nao_validada')) pend.push({ codigo: 'regra_nao_validada', texto: r.publicacao.bloqueios.find(b => b.codigo === 'regra_nao_validada').texto + ' — cadastre e valide em Regras e cadastro' });
  if (cod.includes('conflito_trabalhista')) pend.push({ codigo: 'conflito_trabalhista', texto: r.publicacao.bloqueios.find(b => b.codigo === 'conflito_trabalhista').texto + ' na proposta' });
  // com o 1×1 ativo, quem não tem o sexo informado ficaria de fora sem ninguém perceber: a proposta não é aplicada assim
  const DF = r.dominicalFeminino; if (DF.ativo && DF.semSexo) pend.push({ codigo: 'sexo_nao_informado', texto: 'Revezamento dominical feminino ativo e ' + DF.semSexo + ' funcionário(s) sem o sexo informado: informe em Regras e cadastro (o ponto não traz o dado para todos)' });
  if (DF.violacoes) pend.push({ codigo: 'domingo_art386', texto: DF.violacoes + ' domingo(s) em que uma trabalhadora ficaria com dois domingos seguidos de trabalho (art. 386 da CLT)' + (DF.ativo ? ' — há dia fixo na grade impedindo a alternância' : ' — ative o revezamento dominical feminino 1×1 em Regras e cadastro › Configurações avançadas, ou ajuste a escala') });
  if (!rhDa(user, loja)) pend.push({ codigo: 'sem_permissao', texto: 'Só o RH Ponto da unidade aplica a proposta na escala (você pode simular)' });
  const C = cfg().funcionarios; const semFixaRH = e.funcionarios.filter(f => !(C[f.id] && (C[f.id].folga_fixa != null || C[f.id].duasRotativas))).length;
  return { loja: +loja, lojaTxt: GP.LOJA_TXT[loja], mes, de: per.de, ate: per.ate, existe, status: e.status, statusTxt: existe ? E.STATUS_TXT[e.status] : 'Ainda sem escala no mês (será criada do PontoCerto ao aplicar)', versao: e.versao,
    travados: Object.keys(travados).length, geradosAtuais: Object.values(e.dias).filter(x => x.origem === 'gerador').length, semFolgaFixaRH: semFixaRH, afastamentos: !!ctx.afast,
    resultado: r, assinatura, classes, duasFolgas: d2, distribuicaoFolgas: r.distribuicaoFolgas, alteracoes: r.alteracoes, dominical: r.dominicalFeminino, historico: H.resumo, sugestaoInicio,
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
  for (const f of e.funcionarios) { const c = C[f.id] || {}; const ff = folgaFixaDe(f, c).dia; const novoSetor = c.setor || f.setor; const novaFixa = c.duasRotativas ? [] : ff == null ? f.folga_fixa : [ff];
    if (JSON.stringify(novaFixa) !== JSON.stringify(f.folga_fixa) || novoSetor !== f.setor) { funcsAntes[f.id] = { folga_fixa: f.folga_fixa, setor: f.setor }; if (!f.folga_fixa_contrato) f.folga_fixa_contrato = f.folga_fixa; f.folga_fixa = novaFixa; f.setor = novoSetor; } }
  e.fluxo.push({ em: agora(), usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de: e.status, para: e.status, texto: 'Gerador 5×2 (' + id + '): ' + Object.keys(depois).length + ' dia(s) de ' + s.de.split('-').reverse().join('/') + ' a ' + s.ate.split('-').reverse().join('/') + ' aplicados como proposta. ' + just });
  E.salvar(e);
  const g = { id, loja: +loja, mes, de: s.de, ate: s.ate, em: agora(), ...quem(user), justificativa: just, cienteDivergencias: body.cienteDivergencias === true, statusAntes, versaoAntes, versao: e.versao, novaVersao, assinatura: s.assinatura,
    indicadores: r.indicadores, cobertura: r.cobertura.resumo, conflitos: r.conflitos, divergenciasContratuais: r.divergenciasContratuais, domingosFeriados: r.domingosFeriados, regrasAplicadas: r.regrasAplicadas, continuidade: r.continuidade,
    transicao: r.transicao, pesos: r.pesos, duasFolgas: r.duasFolgas, historico: { ...s.historico, pendentes: s.historico.pendentes.length }, antes, depois, funcsAntes, nomes: Object.fromEntries(e.funcionarios.map(f => [f.id, f.nome])), desfeita: null };
  gravarJson(P.ger(id), g);
  auditar(user, 'gerar_aplicar', { ref: id, loja: +loja, mes, justificativa: just, de: s.de, ate: s.ate, dias: Object.keys(depois).length, substituidos: Object.values(antes).filter(Boolean).length, novaVersao, versao: e.versao, indicadores: r.indicadores, processo: 'Gerador 5×2', distribuicaoFolgas: r.distribuicaoFolgas, alteracoes: r.alteracoes, dominicalFeminino: { ativo: r.dominicalFeminino.ativo, mulheres: r.dominicalFeminino.mulheres, alternando: r.dominicalFeminino.alternando, semSexo: r.dominicalFeminino.semSexo },
    // correções automáticas que o próprio gerador fez em volta de dias fixos (folga fixa que cedeu ou foi movida, folga redistribuída)
    reprocessamentos: r.conflitos.operacionais.filter(c => c.reprocessado).slice(0, 80).map(c => ({ funcId: c.funcId, funcionario: c.nome, data: c.ref, codigo: c.codigo, texto: c.texto })),
    validacao: { ok: true, duasFolgas: r.duasFolgas, semanal: r.validacaoSemanal, bloqueiosTrabalhistas: 0, alertasTrabalhistas: r.conflitos.trabalhistas.filter(c => c.gravidade === 'alerta').length, resumo: r.duasFolgas.ok + ' de ' + r.duasFolgas.semanas + ' semanas com as duas folgas; nenhuma pendência impeditiva' } });
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
/** Roda o motor sobre a grade como ela está (todo dia do mês entra como fixo): é a validação da escala. Na semana que
 *  atravessa para o mês seguinte, se a grade do mês seguinte já existe os dias dela fecham a semana; senão o motor prevê. */
function analiseBase(loja, mes, ctx, sobre) {
  const e = E.ler(loja, mes); if (!e) return null; const dias = E.diasDoMes(mes); const R = E.resolver(e, ctx.afast || null); const travados = {};
  for (const f of R) for (const d of dias) { const x = f.dias[d]; if (x && ['trabalho', 'folga', 'feriado'].includes(x.tipo)) travados[f.id + '|' + d] = limpo(x); }
  // `sobre` = dias hipotéticos ({ 'id|data': dia }) para testar uma correção antes de gravar qualquer coisa
  for (const [k, v] of Object.entries(sobre || {})) { if (v) travados[k] = limpo(v); else delete travados[k]; }
  const fim = dias[dias.length - 1], dom = soma(M._util.segunda(fim), 6); let proximoMes = null;
  if (dom > fim) { const prox = E.ler(loja, dom.slice(0, 7)); if (prox) { proximoMes = prox.mes; for (const f of prox.funcionarios) for (let d = soma(fim, 1); d <= dom; d = soma(d, 1)) { const x = E.diaDe(prox, f, d, null); if (x && ['trabalho', 'folga', 'feriado'].includes(x.tipo)) travados[f.id + '|' + d] = limpo(x); } } }
  const H = historicoReal(e, dias[0], ctx);
  const r = M.gerar({ de: dias[0], ate: fim, funcionarios: funcsDoMotor(e, ctx), regras: cfg().regras, historico: H.hist, travados, cobertura: coberturaLoja(loja), feriados: E.config().feriados, excecoesFolga: cfg().excecoesFolga, turnos: turnosDoMotor(loja), dominicalFeminino: { ativo: dominicalLoja(loja).ativo } });
  return { e, r, H, dias, proximoMes };
}
const dataDoConflito = c => { const x = String(c.ref || '').split('|').pop(); return ISO.test(x) ? x : null; };
/** Trava de publicação (Etapa 4): escala no regime 5×2 (com geração aplicada) só é validada pelo RH e aprovada pela Coordenação
 *  sem pendência trabalhista impeditiva — duas folgas por semana, descansos, intervalo e carga — a partir da semana em que o
 *  regime começou. Escala que não passou pelo gerador fica como sempre foi (`aplicavel: false`). */
function portaPublicacao(loja, mes, ctx) {
  const e = E.ler(loja, mes); if (!e) return { aplicavel: false, liberada: true, bloqueios: [] };
  const gs = listarGeracoes(loja, mes).filter(g => !g.desfeita);
  if (!gs.length || !Object.values(e.dias).some(x => x.origem === 'gerador')) return { aplicavel: false, liberada: true, bloqueios: [], motivo: 'Escala fora do regime 5×2: nenhuma geração aplicada' };
  const desde = M._util.segunda(gs.map(g => g.de).sort()[0]); const a = analiseBase(loja, mes, ctx || {});
  const bl = a.r.conflitos.trabalhistas.filter(c => c.gravidade === 'bloqueio' && (dataDoConflito(c) == null || dataDoConflito(c) >= desde));
  return { aplicavel: true, desde, liberada: !bl.length, bloqueios: bl, folgas: bl.filter(c => c.codigo.startsWith('folgas_semana')).length, duasFolgas: a.r.duasFolgas };
}
function exigirPublicavel(user, loja, mes, ctx, acao) {
  const p = portaPublicacao(loja, mes, ctx); if (p.liberada) return p;
  auditar(user, 'publicacao_bloqueada', { ref: 'ESC-' + loja + '-' + mes, loja: +loja, mes, tentativa: acao, pendencias: p.bloqueios.length, folgas: p.folgas, exemplos: p.bloqueios.slice(0, 10).map(c => c.texto) });
  throw erro('Esta escala não pode ser ' + (acao === 'aprovar' ? 'aprovada' : 'validada') + ': ' + p.bloqueios.length + ' pendência(s) impeditiva(s)' + (p.folgas ? ', ' + p.folgas + ' da regra das duas folgas' : '') + ' — ' + p.bloqueios.slice(0, 3).map(c => c.texto).join(' · ') + (p.bloqueios.length > 3 ? ' …' : '') + '. Confira em DP / RH › Gerador de Escalas 5×2 › Validar Jornada e Folgas.', 409, { bloqueios: p.bloqueios.slice(0, 60) });
}
/** Resultado da validação da semana (segunda a domingo) de uma pessoa, para a auditoria de cada alteração. */
function validacaoDaSemana(loja, mes, funcId, data, ctx) {
  const a = analiseBase(loja, mes, ctx || {}); if (!a) return null; const seg = M._util.segunda(data), dom = soma(seg, 6);
  const p = a.r.proposta.find(x => String(x.id) === String(funcId)); const s = p && p.semanas.find(x => x.inicio === seg); if (!s) return null;
  const naSemana = c => { const d = dataDoConflito(c); return d != null && d >= seg && d <= dom; };
  const meus = a.r.conflitos.trabalhistas.filter(c => String(c.funcId) === String(funcId) && naSemana(c)); const bloq = meus.filter(c => c.gravidade === 'bloqueio'), alertas = meus.filter(c => c.gravidade === 'alerta');
  const cob = a.r.conflitos.operacionais.filter(c => c.codigo === 'cobertura_abaixo' && c.ref === p.setor + '|' + data);
  const R = s.regra52; const curto = t => String(t).replace(p.nome + ': ', '');
  // semanas vizinhas (a anterior e a seguinte): uma alteração no domingo ou na segunda mexe nos descansos da outra semana.
  // `antesDia` = como o dia estava: permite dizer quais bloqueios das vizinhas são NOVOS, causados pela alteração.
  const vizinhas = [soma(seg, -7), soma(seg, 7)].map(w => p.semanas.find(x => x.inicio === w)).filter(Boolean); let antigos = null;
  if (ctx && ctx.antesDia && ['trabalho', 'folga', 'feriado'].includes(ctx.antesDia.tipo)) { try { const b = analiseBase(loja, mes, ctx, { [funcId + '|' + data]: ctx.antesDia }); const pb = b.r.proposta.find(x => String(x.id) === String(funcId)); antigos = new Set(pb.semanas.flatMap(w => w.validacao.itens.filter(i => i.gravidade === 'bloqueio').map(i => w.inicio + '|' + i.codigo + '|' + i.dias.join(',')))); } catch (err) { antigos = null; } }
  const adjacentes = vizinhas.map(w => { const bl = w.validacao.itens.filter(i => i.gravidade === 'bloqueio'); const novos = antigos ? bl.filter(i => !antigos.has(w.inicio + '|' + i.codigo + '|' + i.dias.join(','))) : [];
    return { inicio: w.inicio, fim: w.fim, nivel: w.validacao.nivel, bloqueios: bl.map(i => ({ codigo: i.codigo, texto: i.texto })), novos: novos.map(i => ({ codigo: i.codigo, texto: i.texto })) }; });
  return { semana: { inicio: seg, fim: dom }, setor: p.setor, ok: !bloq.length, nivel: s.validacao.nivel, itens: s.validacao.itens, adjacentes, situacao: R.situacao, folgas: R.folgas, exigidas: R.exigidas, trabalho: s.trabalho, ausencias: s.ausencias, minutos: s.minutos, horas: s.horas, permanenciaMin: s.permanenciaMin, intervalosMin: s.intervalosMin,
    bloqueios: bloq.map(c => ({ codigo: c.codigo, texto: curto(c.texto) })), alertas: alertas.map(c => ({ codigo: c.codigo, texto: curto(c.texto) })), cobertura: cob.map(c => c.texto),
    resumo: R.folgas + ' folga(s) (F + FR) e ' + s.horas + ' efetivas na semana — ' + (bloq.length ? 'INVÁLIDA: ' + bloq.map(c => curto(c.texto)).join(' · ') : 'dentro das regras' + (alertas.length ? ', com ' + alertas.length + ' alerta(s)' : '')) + (cob.length ? ' · cobertura abaixo do mínimo no dia' : '') };
}
// ── Correção sugerida pelo motor de validação semanal ────────────────────────────────────────────────────
// Semana com folga a mais (3 ou mais) ou a menos: o motor diz quais dias podem ser redistribuídos, testa cada um SEM gravar
// (roda a validação com o dia hipotético) e propõe o de menor impacto. Nunca mexe em dia protegido — ajuste manual, dia já
// passado, dia sem geração do 5×2 (contrato / anterior à implantação), férias e afastamento, dia de outro mês — e descarta
// a opção que cria bloqueio na própria semana, na anterior ou na seguinte (descanso semanal, interjornada, dias seguidos,
// domingo, carga) ou, ao dar folga, que deixa o setor mais tempo abaixo do mínimo. Aplicar é sempre ato do RH, auditado.
const PROCESSO = 'Motor de validação semanal 5×2';
const brC = d => d.split('-').reverse().slice(0, 2).join('/');
function protecaoDoDia(e, funcId, d, hoje) {
  if (d.tipo !== 'trabalho' && d.tipo !== 'folga') return d.tipo === 'ferias' || d.tipo === 'afastado' ? 'férias/afastamento (preservado)' : 'sem jornada a redistribuir';
  if (d.data.slice(0, 7) !== e.mes) return 'pertence a outro mês (a correção é feita na escala daquele mês)';
  if (d.data <= hoje) return 'dia já passado ou em andamento';
  const ov = e.dias[funcId + '|' + d.data]; if (!ov) return 'jornada do contrato, sem geração do 5×2 (anterior à implantação)';
  if (ov.origem !== 'gerador') return 'ajuste manual (preservado)';
  return null;
}
function sugerirCorrecao(user, loja, mes, funcId, semana, ctx) {
  exige(podeVer(user, loja), 'Unidade fora do seu escopo'); if (!MES.test(mes) || !ISO.test(String(semana || ''))) throw erro('Informe o mês e a semana (AAAA-MM-DD)');
  const base = analiseBase(loja, mes, ctx); if (!base) throw erro('Ainda não há escala de ' + (GP.LOJA_TXT[loja] || loja) + ' em ' + mes.split('-').reverse().join('/'), 404, { semEscala: true });
  const { e } = base; const seg = M._util.segunda(semana), hoje = ctx.hoje || hojeISO(); const pes = res => res.proposta.find(x => String(x.id) === String(funcId));
  const p = pes(base.r); const f = e.funcionarios.find(x => String(x.id) === String(funcId)); const s = p && p.semanas.find(x => x.inicio === seg); if (!p || !f || !s) throw erro('Funcionário ou semana fora desta escala', 404);
  const semanas = [soma(seg, -7), seg, soma(seg, 7)]; const chave = (w, i) => w + '|' + i.codigo + '|' + i.dias.join(',');
  const bloqueios = res => { const pp = pes(res); return semanas.flatMap(w => { const sw = pp.semanas.find(x => x.inicio === w); return sw ? sw.validacao.itens.filter(i => i.gravidade === 'bloqueio').map(i => ({ semana: w, chave: chave(w, i), codigo: i.codigo, texto: i.texto })) : []; }); };
  const deficit = (res, data) => { const d = res.cobertura.dias.find(x => x.data === data); const st = d && d.setores.find(x => x.setor === p.setor); return st ? st.deficit : 0; };   // pessoas que faltam × blocos de 15 min
  const escalados = (res, data) => { const d = res.cobertura.dias.find(x => x.data === data); const st = d && d.setores.find(x => x.setor === p.setor); return st ? st.escalados : 0; };
  const modo = R => R.situacao === 'excesso' ? 'excesso' : R.situacao === 'falta' ? 'falta' : null;
  // jornada de referência para um dia que deixa de ser folga: a mais comum da pessoa na semana, depois no mês, depois o contrato
  const jornada = dw => { const conta = l => { const m = new Map(); for (const d of l) if (d.tipo === 'trabalho' && d.entrada && d.saida) { const k = [d.entrada, d.saida, d.almoco_ini || '', d.almoco_fim || ''].join('|'); m.set(k, (m.get(k) || 0) + 1); } const top = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]; if (!top) return null; const [en, sa, ai, af] = top[0].split('|'); return { entrada: en, saida: sa, almoco_ini: ai || null, almoco_fim: af || null }; };
    const j = conta(s.dias) || conta(Object.values(p.dias)) || (f.base && f.base[dw]) || Object.values(f.base || {}).find(Boolean) || null; return j ? { tipo: 'trabalho', entrada: j.entrada, saida: j.saida, almoco_ini: j.almoco_ini || null, almoco_fim: j.almoco_fim || null, setor: f.setor } : null; };
  const dias = s.dias.map(d => ({ ...d, protegido: protecaoDoDia(e, f.id, d, hoje) }));
  const tipo0 = modo(s.regra52); const resp = { loja: +loja, mes, funcId: f.id, nome: f.nome, setor: p.setor, semana: { inicio: seg, fim: soma(seg, 6) }, situacao: s.regra52.situacao, nivel: s.validacao.nivel, folgas: s.regra52.folgas, exigidas: s.regra52.exigidas, itens: s.validacao.itens, dias, candidatos: [], sugestao: null, motivoSemSugestao: null, processo: PROCESSO,
    podeAplicar: rhDa(user, loja) && e.status !== 'validada_rh' };
  if (!tipo0) { resp.motivoSemSugestao = 'A correção automática trata semana com folga a mais ou a menos; esta semana está como “' + s.regra52.situacao + '”.'; return resp; }
  const antes = new Set(bloqueios(base.r).map(b => b.chave)); let sobre = {}, atual = base, passos = []; const usados = new Set();
  for (let rodada = 0; rodada < 3; rodada++) {
    const sAt = pes(atual.r).semanas.find(x => x.inicio === seg); const tipo = modo(sAt.regra52); if (!tipo) break;
    const lista = dias.filter(d => !usados.has(d.data) && (tipo === 'excesso' ? d.tipo === 'folga' : d.tipo === 'trabalho')); const avaliados = [];
    for (const d of lista) {
      const c = { data: d.data, de: d.tipo === 'folga' ? (d.folga === 'rotativa' ? 'FR' : 'F') : d.entrada + '–' + d.saida, folga: d.folga || null, viavel: false, motivos: [], ressalvas: [], novosBloqueios: [], cobertura: null };
      if (d.protegido) { c.motivos.push(d.protegido); c.protegido = true; avaliados.push(c); continue; }
      const dw = dow(d.data); const novo = tipo === 'excesso' ? jornada(dw) : { tipo: 'folga', entrada: null, saida: null, almoco_ini: null, almoco_fim: null, setor: f.setor, folga: 'rotativa' };
      if (!novo) { c.motivos.push('sem jornada de referência para o dia'); avaliados.push(c); continue; }
      c.para = novo.tipo === 'folga' ? 'FR' : novo.entrada + '–' + novo.saida; c.depois = novo;
      const t = analiseBase(loja, mes, ctx, { ...sobre, [f.id + '|' + d.data]: novo }); const sT = pes(t.r).semanas.find(x => x.inicio === seg);
      const novos = bloqueios(t.r).filter(b => !antes.has(b.chave)); c.novosBloqueios = novos.map(b => ({ semana: b.semana, codigo: b.codigo, texto: b.texto }));
      for (const b of novos) c.motivos.push((b.semana === seg ? 'criaria bloqueio na própria semana: ' : b.semana > seg ? 'criaria bloqueio na semana seguinte (' + brC(b.semana) + '): ' : 'criaria bloqueio na semana anterior (' + brC(b.semana) + '): ') + b.texto);
      const da = deficit(atual.r, d.data), dd = deficit(t.r, d.data); c.cobertura = { antesMin: da * 15, depoisMin: dd * 15, escalados: escalados(t.r, d.data) };
      // cobertura: a folga devida não deixa de existir por falta de gente, mas dar folga onde o setor fica mais descoberto NÃO é
      // correção segura — vira ressalva, e só entra como sugestão (a de menor perda) com a ciência expressa do RH
      if (tipo === 'falta' && dd > da) c.ressalvas.push('compromete a cobertura: ' + E.setorTxt(p.setor) + ' perderia mais ' + (dd - da) * 15 + ' min de pessoa abaixo do mínimo em ' + brC(d.data));
      const melhora = tipo === 'excesso' ? sT.regra52.folgas < sAt.regra52.folgas : sT.regra52.folgas > sAt.regra52.folgas; if (!melhora) c.motivos.push('não muda a contagem de folgas da semana');
      c.viavel = !c.motivos.length && !c.ressalvas.length; c.aceitavel = !c.motivos.length; c.perda = dd - da; c.restantes = bloqueios(t.r).length; c._t = t; avaliados.push(c);
    }
    if (rodada === 0) resp.candidatos = avaliados.map(({ _t, depois, perda, aceitavel, restantes, ...x }) => x);
    // menor impacto: ao tirar folga, o dia em que o setor mais precisa (mais tempo abaixo do mínimo recuperado), a rotativa antes da
    // fixa; ao dar folga, o dia em que o setor tem mais gente escalada
    const ok = avaliados.filter(c => c.viavel).sort((a, b) => (a.restantes - b.restantes) || (tipo === 'excesso' ? ((b.cobertura.antesMin - b.cobertura.depoisMin) - (a.cobertura.antesMin - a.cobertura.depoisMin)) || ((a.folga === 'rotativa' ? 0 : 1) - (b.folga === 'rotativa' ? 0 : 1)) || a.data.localeCompare(b.data) : (b.cobertura.escalados - a.cobertura.escalados) || a.data.localeCompare(b.data)));   // antes de tudo, a opção que deixa menos bloqueios na semana e nas vizinhas (ex.: a folga que também resolve o descanso dominical)
    // nenhuma opção segura: sobra, se houver, a que não cria bloqueio e perde menos cobertura — proposta COM RESSALVA
    const resto = ok.length ? [] : avaliados.filter(c => c.aceitavel).sort((a, b) => (a.perda - b.perda) || (b.cobertura.escalados - a.cobertura.escalados) || a.data.localeCompare(b.data));
    const m = ok[0] || resto[0]; if (!m) break; usados.add(m.data); sobre = { ...sobre, [f.id + '|' + m.data]: m.depois }; atual = m._t;
    passos.push({ data: m.data, de: m.de, para: m.para, antes: dias.find(d => d.data === m.data), depois: m.depois, cobertura: m.cobertura, ressalvas: m.ressalvas });
  }
  const sFim = pes(atual.r).semanas.find(x => x.inicio === seg);
  if (!passos.length) resp.motivoSemSugestao = resp.candidatos.every(c => c.protegido) ? 'Todos os dias que poderiam ser redistribuídos estão protegidos (ajuste manual, dia já passado, contrato ou outro mês): a correção fica com o RH.' : 'Nenhuma opção é segura: cada dia livre criaria outro bloqueio (na própria semana ou nas vizinhas). A decisão fica com o RH.';
  else if (modo(sFim.regra52)) { passos = []; resp.motivoSemSugestao = 'Os dias livres não bastam para a semana voltar às ' + s.regra52.exigidas + ' folgas sem criar outro bloqueio: a correção fica com o RH.'; }
  else { const viz = [soma(seg, -7), soma(seg, 7)].map(w => pes(atual.r).semanas.find(x => x.inicio === w)).filter(Boolean);
    resp.sugestao = { passos: passos.map(({ antes: a, ...x }) => ({ ...x, antes: { tipo: a.tipo, folga: a.folga, entrada: a.entrada, saida: a.saida, almoco_ini: a.almoco_ini, almoco_fim: a.almoco_fim } })),
      resumo: passos.map(x => brC(x.data) + ' (' + DIAS[dow(x.data)] + '): ' + x.de + ' → ' + x.para).join(' · '),
      // true = não havia dia com cobertura sobrando: a proposta é a de menor perda e só é aplicada com a ciência expressa do RH
      exigeCiencia: passos.some(x => x.ressalvas.length), ressalvas: passos.flatMap(x => x.ressalvas),
      validacao: { semana: { nivel: sFim.validacao.nivel, folgas: sFim.regra52.folgas, horas: sFim.horas, bloqueios: sFim.validacao.itens.filter(i => i.gravidade === 'bloqueio').length }, adjacentes: viz.map(w => ({ inicio: w.inicio, fim: w.fim, nivel: w.validacao.nivel, bloqueios: w.validacao.itens.filter(i => i.gravidade === 'bloqueio').length })) } }; }
  return resp;
}
/** Aplica a correção sugerida (refeita no servidor na hora — o cliente só confirma os dias). Só o RH Ponto da unidade. */
function aplicarCorrecao(user, loja, mes, ctx, body) {
  exige(rhDa(user, loja), 'Só o RH Ponto da unidade aplica a correção sugerida'); body = body || {};
  const sug = sugerirCorrecao(user, loja, mes, body.funcId, body.semana, ctx); if (!sug.sugestao) throw erro('Não há correção segura para aplicar: ' + sug.motivoSemSugestao, 409);
  const datas = sug.sugestao.passos.map(x => x.data); if (body.datas && [].concat(body.datas).join(',') !== datas.join(',')) throw erro('A escala mudou desde a sugestão: abra a semana de novo antes de aplicar', 409, { desatualizada: true });
  if (sug.sugestao.exigeCiencia && body.cienteCobertura !== true) throw erro('A correção disponível reduz a cobertura do setor (' + sug.sugestao.ressalvas.join(' · ') + '): o RH precisa confirmar que está ciente antes de aplicar', 409, { exigeCiencia: 1 });
  const e = E.obter(loja, mes); if (e.status === 'validada_rh') throw erro('Escala aguardando a Coordenação: peça a devolução antes de corrigir', 409);
  const statusAntes = e.status; const nv = E.reabrirSeAprovada(e, user, PROCESSO + ': correção de folgas em escala aprovada (nova versão)'); const f = e.funcionarios.find(x => String(x.id) === String(sug.funcId));
  const nota = txt(body.justificativa, 400); const just = 'Correção sugerida pelo motor de validação semanal: semana de ' + brC(sug.semana.inicio) + ' a ' + brC(sug.semana.fim) + ' com ' + sug.folgas + ' folga(s) (a regra pede ' + sug.exigidas + '). ' + sug.sugestao.resumo + '.' + (sug.sugestao.exigeCiencia ? ' Aplicada com ressalva de cobertura, com a ciência do RH: ' + sug.sugestao.ressalvas.join(' · ') + '.' : '') + (nota ? ' Observação do RH: ' + nota : '');
  const alter = [];
  for (const ps of sug.sugestao.passos) { const k = f.id + '|' + ps.data; const antes = e.dias[k] ? { ...e.dias[k] } : null;
    const novo = { tipo: ps.depois.tipo, entrada: ps.depois.entrada, saida: ps.depois.saida, almoco_ini: ps.depois.almoco_ini, almoco_fim: ps.depois.almoco_fim, setor: ps.depois.setor || f.setor, obs: '', origem: 'gerador', geracao: (antes && antes.geracao) || null, ...(ps.depois.folga ? { folga: ps.depois.folga } : {}), correcao: { em: agora(), processo: PROCESSO, por: user.usuario } };
    e.dias[k] = novo; alter.push({ data: ps.data, antes, depois: novo }); }
  E.salvar(e); let v = null; try { v = validacaoDaSemana(loja, mes, f.id, sug.semana.inicio, ctx); } catch (err) {}
  const setor = (cfg().funcionarios[f.id] || {}).setor || f.setor;
  const reg = auditar(user, 'correcao_folgas', { ref: 'ESC-' + loja + '-' + mes, loja: +loja, mes, funcId: f.id, funcionario: f.nome, setor, semana: sug.semana, processo: PROCESSO, confirmadoPor: user.usuario, justificativa: just, statusAntes, novaVersao: nv, versao: e.versao, cienteCobertura: !!sug.sugestao.exigeCiencia, ressalvas: sug.sugestao.ressalvas,
    cobertura: sug.sugestao.passos.map(x => ({ data: x.data, ...x.cobertura })),
    alteracoes: alter.map(a => ({ id: f.id, nome: f.nome + ' · ' + brC(a.data), data: a.data, antes: a.antes, depois: a.depois })),
    validacao: v ? { ok: v.ok, nivel: v.nivel, situacao: v.situacao, folgas: v.folgas, exigidas: v.exigidas, horas: v.horas, bloqueios: v.bloqueios, adjacentes: v.adjacentes.map(a => ({ inicio: a.inicio, fim: a.fim, nivel: a.nivel, bloqueios: a.bloqueios })), resumo: v.resumo } : { ok: null, resumo: 'validação indisponível' } });
  const e2 = E.obter(loja, mes); for (const a of alter) e2.historico.push({ em: reg.em, usuario: user.usuario, nome: user.nome, acao: 'correcao', processo: PROCESSO, peloRH: true, funcId: f.id, funcionario: f.nome, data: a.data, antes: a.antes, depois: a.depois, justificativa: just, versao: e2.versao, setor, semana: sug.semana, validacao: v ? { ok: v.ok, resumo: v.resumo } : null, auditoria: reg.seq });
  e2.fluxo.push({ em: reg.em, usuario: user.usuario, nome: user.nome, papeis: GP.papeisDe(user), de: e2.status, para: e2.status, texto: PROCESSO + ': ' + f.nome + ' — ' + sug.sugestao.resumo }); E.salvar(e2);
  avisar({ nivel: nv ? 'critico' : 'relevante', loja, mes, texto: (GP.LOJA_TXT[loja] || loja) + ': ' + (user.nome || user.usuario) + ' (RH) aplicou a correção do motor de validação para ' + f.nome + ' — ' + sug.sugestao.resumo + (sug.sugestao.exigeCiencia ? ' — REDUZ A COBERTURA: ' + sug.sugestao.ressalvas.join(' · ') : '') + (nv ? ' — ESCALA APROVADA reaberta como versão ' + e2.versao : '') + (v ? '. Semana: ' + v.resumo : ''), autor: user });
  return { ok: true, passos: sug.sugestao.passos.map(x => ({ data: x.data, de: x.de, para: x.para })), validacao: v, auditoria: reg.seq, status: e2.status, versao: e2.versao };
}
function analisar(user, loja, mes, ctx) {
  exige(podeVer(user, loja), 'Unidade fora do seu escopo'); if (!MES.test(mes)) throw erro('Mês inválido'); const A = analiseBase(loja, mes, ctx); if (!A) throw erro('Ainda não há escala de ' + (GP.LOJA_TXT[loja] || loja) + ' em ' + mes.split('-').reverse().join('/'), 404, { semEscala: true });
  const { e, r, H } = A; const porta = portaPublicacao(loja, mes, ctx);
  const fora = c => !['sem_folga_fixa', 'folga_extra_domingo', 'folga_extra_descanso', 'folga_fixa_ja_gozada', 'entrada_adiada'].includes(c.codigo);   // avisos que só fazem sentido numa geração
  return { loja: +loja, lojaTxt: GP.LOJA_TXT[loja], mes, status: e.status, statusTxt: E.STATUS_TXT[e.status], versao: e.versao, afastamentos: !!ctx.afast, gerados: Object.values(e.dias).filter(x => x.origem === 'gerador').length, manuais: Object.values(e.dias).filter(x => x.origem !== 'gerador').length,
    indicadores: r.indicadores, regrasAplicadas: r.regrasAplicadas, conflitos: { trabalhistas: r.conflitos.trabalhistas, operacionais: r.conflitos.operacionais.filter(fora) }, divergenciasContratuais: r.divergenciasContratuais, cobertura: r.cobertura,
    transicao: r.transicao, historico: H.resumo, pesos: r.pesos, duasFolgas: r.duasFolgas, validacaoSemanal: r.validacaoSemanal, dominical: r.dominicalFeminino, proximoMes: A.proximoMes, podeExcecao: rhDa(user, loja), podeCorrigir: rhDa(user, loja) && e.status !== 'validada_rh', hoje: ctx.hoje || hojeISO(),
    publicacao: { aplicavel: porta.aplicavel, desde: porta.desde || null, liberada: porta.liberada, bloqueios: porta.bloqueios.length, folgas: porta.folgas || 0, motivo: porta.motivo || null },
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
// Etapa 4: toda alteração de dia entra na auditoria encadeada com funcionário, loja e setor, semana de referência, escala
// anterior e modificada, usuário, data/hora, justificativa e o RESULTADO DA VALIDAÇÃO da semana (duas folgas, carga efetiva,
// descansos). Alteração que deixa a semana inválida ou o setor abaixo do mínimo é de impacto relevante: aviso imediato.
function aposEdicao(user, loja, mes, body, statusAntes, afast) {
  const e = E.ler(loja, mes); if (!e) return null; const f = e.funcionarios.find(x => +x.id === +body.funcId); const data = String(body.data || ''); const dBR = data.split('-').reverse().slice(0, 2).join('/');
  const peloRH = !GP.gerenteDa(user, loja); const sensivel = dow(data) === 0 || E.feriado(data) || (f && (f.folga_fixa || []).includes(dow(data)));
  const seg = M._util.segunda(data); const h = (e.historico || []).slice().reverse().find(x => +x.funcId === +body.funcId && x.data === data && !x.auditoria);
  let v = null; try { v = validacaoDaSemana(loja, mes, body.funcId, data, { afast: afast || null, antesDia: h ? h.antes : null }); } catch (err) { console.error('[escalas-5x2] validação da alteração', err.message); }
  const setor = f ? ((cfg().funcionarios[f.id] || {}).setor || f.setor) : null;
  const reg = auditar(user, 'dia_alterar', { ref: 'ESC-' + loja + '-' + mes, loja: +loja, mes, funcId: f ? f.id : +body.funcId, funcionario: f ? f.nome : null, setor, data, semana: { inicio: seg, fim: soma(seg, 6) },
    antes: h ? h.antes : null, depois: h ? h.depois : null, restaurado: !!(h && h.acao === 'restaurar'), justificativa: txt(body.justificativa, 500), peloRH, versao: e.versao, statusAntes: statusAntes || null,
    validacao: v ? { ok: v.ok, situacao: v.situacao, folgas: v.folgas, exigidas: v.exigidas, horas: v.horas, minutos: v.minutos, bloqueios: v.bloqueios, alertas: v.alertas, cobertura: v.cobertura, nivel: v.nivel, adjacentes: v.adjacentes.map(a => ({ inicio: a.inicio, fim: a.fim, nivel: a.nivel, novos: a.novos })), resumo: v.resumo } : { ok: null, resumo: 'validação indisponível' } });
  if (h) { h.setor = setor; h.semana = { inicio: seg, fim: soma(seg, 6) }; h.validacao = v ? { ok: v.ok, resumo: v.resumo } : null; h.auditoria = reg.seq; E.salvar(e); }
  // cobertura só conta como impacto quando a alteração TIRA presença (trabalho → folga/ausência, ou jornada menor) num dia em
  // que o setor fica abaixo do mínimo; mudar o horário de quem continua trabalhando segue como rotina
  const liq = M._util.liquido; const tiraPresenca = !!(h && h.antes && h.antes.tipo === 'trabalho' && h.acao !== 'restaurar' && (h.depois.tipo !== 'trabalho' || liq(h.depois) < liq(h.antes)));
  const semCobertura = !!(v && v.cobertura.length && tiraPresenca);
  const afetou = v ? v.adjacentes.filter(a => a.novos.length) : [];   // a alteração criou bloqueio na semana anterior ou na seguinte
  const impacto = !!(v && !v.ok) || semCobertura || afetou.length > 0;
  const nivel = statusAntes === 'aprovada' ? 'critico' : ((peloRH && sensivel) || impacto) ? 'relevante' : 'rotina';
  avisar({ nivel, loja, mes, texto: (GP.LOJA_TXT[loja] || loja) + ': ' + (user.nome || user.usuario) + (peloRH ? ' (RH)' : '') + ' alterou ' + (f ? f.nome : 'funcionário') + ' em ' + dBR + ' (' + DIAS[dow(data)] + ')' + (statusAntes === 'aprovada' ? ' — ESCALA APROVADA reaberta como versão ' + e.versao : '') + (v && !v.ok ? ' — SEMANA INVÁLIDA: ' + v.bloqueios.map(b => b.texto).join(' · ').slice(0, 220) : '') + (semCobertura ? ' — setor abaixo do mínimo no dia' : '') + (afetou.length ? ' — AFETOU A SEMANA DE ' + afetou.map(a => a.inicio.split('-').reverse().slice(0, 2).join('/') + ': ' + a.novos.map(n => n.texto).join(' · ')).join('; ').slice(0, 220) : '') + (body.justificativa ? '. ' + txt(body.justificativa, 200) : ''), autor: user });
  return { validacao: v, nivel, auditoria: reg.seq };
}

// ── Trilha de auditoria (gerador + alterações da grade + fluxo de aprovação) ─────────────────────────────
const ACAO_TXT = { regra_criar: 'Regra trabalhista criada', regra_alterar: 'Regra trabalhista alterada', regra_validar: 'Regra validada pelo RH', regra_encerrar: 'Vigência da regra encerrada', cadastro: 'Folga fixa / setor / restrições', cobertura: 'Cobertura e pesos por dia do gerador', historico_validar: 'Dias sem confirmação do ponto validados pelo RH', escala_criar: 'Escala criada do PontoCerto', gerar_aplicar: 'Geração 5×2 aplicada', gerar_desfazer: 'Geração 5×2 desfeita', quadro: 'Quadro ajustado pelo ponto', dia_alterar: 'Dia alterado na grade', folga_excecao: 'Exceção à regra das duas folgas (RH)', publicacao_bloqueada: 'Validação/aprovação recusada: escala inválida', correcao_folgas: 'Correção de folgas (motor de validação semanal)', dominical_feminino: 'Revezamento dominical feminino 1×1' };
const semTxt = s => s ? s.inicio.split('-').reverse().slice(0, 2).join('/') + ' a ' + s.fim.split('-').reverse().slice(0, 2).join('/') : '';
function trilha(user, filtro = {}) {
  exige(GP.vePainel(user), 'Sem acesso à auditoria'); const loja = filtro.loja ? +filtro.loja : null; const mes = MES.test(filtro.mes || '') ? filtro.mes : null; if (loja != null) exige(podeVer(user, loja), 'Unidade fora do seu escopo');
  const out = [];
  for (const r of lerLinhas(P.aud())) { if (r.loja != null && !podeVer(user, r.loja)) continue; if (loja != null && r.loja != null && r.loja !== loja) continue; if (mes && r.mes && r.mes !== mes) continue;
    out.push({ origem: 'gerador', seq: r.seq, em: r.em, usuario: r.usuario, nome: r.nome, papeis: r.papeis, acao: r.acao, acaoTxt: ACAO_TXT[r.acao] || r.acao, loja: r.loja == null ? null : r.loja, mes: r.mes || null, ref: r.ref || null, justificativa: r.justificativa || null, antes: r.antes === undefined ? null : r.antes, depois: r.depois === undefined ? null : r.depois, alteracoes: r.alteracoes || null,
      funcionario: r.funcionario || null, setor: r.setor || null, data: r.data || null, semana: r.semana || null, validacao: r.validacao || null,
      detalhe: r.acao === 'dia_alterar' ? [r.funcionario, r.data ? r.data.split('-').reverse().join('/') : null, r.setor ? E.setorTxt(r.setor) : null, r.semana ? 'semana ' + semTxt(r.semana) : null, r.peloRH ? 'pelo RH' : null, 'versão ' + r.versao].filter(Boolean).join(' · ') + (r.validacao ? ' — validação: ' + r.validacao.resumo : '')
        : r.acao === 'publicacao_bloqueada' ? 'tentou ' + r.tentativa + ' com ' + r.pendencias + ' pendência(s) impeditiva(s)' + (r.folgas ? ', ' + r.folgas + ' da regra das duas folgas' : '')
        : r.acao === 'correcao_folgas' ? [r.funcionario, r.setor ? E.setorTxt(r.setor) : null, 'semana ' + semTxt(r.semana), 'processo: ' + r.processo, 'confirmada por ' + r.confirmadoPor].filter(Boolean).join(' · ') + (r.validacao ? ' — validação: ' + r.validacao.resumo : '')
        : r.acao === 'dominical_feminino' ? (r.depois && r.depois.ativo ? 'ATIVADO' : 'DESATIVADO') + ' · ' + (r.alcance ? r.alcance.mulheres + ' trabalhadora(s), ' + r.alcance.semSexo + ' sem o sexo informado' : '') + ((r.escalas || []).length ? ' · escalas em aberto: ' + r.escalas.map(x => x.mes.split('-').reverse().join('/') + (x.violacoesArt386 ? ' (' + x.violacoesArt386 + ' domingo(s) em desacordo)' : ' (sem pendência dominical)')).join(', ') : ' · nenhuma escala em aberto')
        : r.acao === 'folga_excecao' ? [r.funcionario, r.setor ? E.setorTxt(r.setor) : null, 'semana ' + semTxt(r.semana), r.depois ? 'exceção registrada' : 'exceção retirada'].filter(Boolean).join(' · ')
        : r.acao === 'gerar_aplicar' ? r.dias + ' dia(s) de ' + r.de + ' a ' + r.ate + (r.substituidos ? ', ' + r.substituidos + ' substituído(s)' : '') + (r.novaVersao ? ', nova versão ' + r.versao : '') + ((r.reprocessamentos || []).length ? ', ' + r.reprocessamentos.length + ' folga(s) reprocessada(s) pelo gerador' : '') + (r.validacao ? ' — validação: ' + r.validacao.resumo : '') : r.acao === 'gerar_desfazer' ? r.restaurados + ' restaurado(s), ' + r.mantidos + ' mantido(s)' : r.acao === 'quadro' ? (r.adicionados || []).length + ' incluído(s), ' + (r.sairam || []).length + ' fora' : null, hash: r.hash.slice(0, 12) }); }
  const lojas = loja != null ? [loja] : GP.LOJAS.filter(l => podeVer(user, l));
  for (const { loja: l, mes: m } of E.listar()) { if (!lojas.includes(l) || (mes && m !== mes)) continue; const e = E.ler(l, m); if (!e) continue;
    for (const h of e.historico || []) if (!h.auditoria) out.push({ origem: 'grade', em: h.em, usuario: h.usuario, nome: h.nome, acao: h.acao, acaoTxt: (h.acao === 'restaurar' ? 'Dia restaurado ao contratual' : 'Dia alterado na grade') + (h.peloRH ? ' (RH)' : ''), loja: l, mes: m, ref: h.funcionario + ' · ' + String(h.data).split('-').reverse().join('/'), justificativa: h.justificativa || null, antes: h.antes, depois: h.depois, detalhe: 'versão ' + h.versao });
    for (const h of e.fluxo || []) out.push({ origem: 'fluxo', em: h.em, usuario: h.usuario, nome: h.nome, papeis: h.papeis, acao: 'fluxo', acaoTxt: h.de === h.para ? 'Registro na escala' : 'Fluxo: ' + (E.STATUS_TXT[h.de] || h.de) + ' → ' + (E.STATUS_TXT[h.para] || h.para), loja: l, mes: m, ref: null, justificativa: h.texto || null, antes: null, depois: null, detalhe: null }); }
  out.sort((a, b) => b.em.localeCompare(a.em));
  return { cadeia: verificarCadeia(), total: out.length, registros: out.slice(0, 600) };
}
function geracao(user, id) { const g = lerJson(P.ger(String(id).replace(/[^A-Za-z0-9-]/g, '')), null); if (!g) throw erro('Geração não encontrada', 404); exige(podeVer(user, g.loja), 'Unidade fora do seu escopo'); return g; }

module.exports = { P, cfg, podeVer, rhDa, podeRegras, podeValidarRegra, auditar, verificarCadeia, avisar, relatorioDiario, avisos, marcarVistos, listarRegras, salvarRegra, validarRegra, encerrarRegra, folgaFixaDe, cadastroLoja, salvarCadastro, coberturaLoja, salvarCobertura,
  CORES, CLASSE_TXT, turnosLoja, pintar, registrarExcecaoFolga, analiseBase, portaPublicacao, exigirPublicavel, validacaoDaSemana, sugerirCorrecao, aplicarCorrecao, PROCESSO, DOMINICAL_INFO, dominicalLoja, avancadas, salvarDominical, sexoDe,
  escalaDe, periodo, janelaHistorico, historicoReal, validarHistorico, simular, aplicar, desfazer, listarGeracoes, resumoGeracao, geracao, analisar, sincronizarQuadro, aposEdicao, trilha, mesAnterior };
