'use strict';
// lib/historico-funcional.js — Controle contratual (contrato de experiência) e histórico funcional (DP / RH, 12/11/2026).
//
// O que este módulo GUARDA (data/historico-funcional, só aqui):
//   · contratos.json     o contrato de experiência de cada funcionário: prazos, situação da prorrogação (pendente / formalizada /
//                        não realizada), documento, desfecho, responsáveis e o histórico de alterações
//   · ocorrencias.json   atestados/afastamentos e faltas (vindos do ponto ou lançados pelo RH), com situação e trilha
//   · alertas.json       quais avisos de prazo já foram enviados (15, 10, 5, 3 e 1 dia antes de cada marco)
//   · auditoria.jsonl    trilha encadeada por hash: usuário, data/hora, ação, justificativa, antes e depois
//   · config.json        prazos padrão (30 + 60, até 90 dias) e dias de alerta
// O que ele só LÊ de quem já é dono do dado (nada é copiado, para não existir ocorrência em duplicidade):
//   · admissão, vínculo CLT, loja e desligamento ......... cadastro do ponto (pontocerto.colaboradores)
//   · afastamentos/atestados e faltas ................... relatórios do ponto (afastamentosLongos e resumo().listas.faltas)
//   · advertências e suspensões ......................... Gestão Disciplinar (disciplinar.historicoColaborador)
//   · documentos do prontuário .......................... Gestão Documental (gestao-documental.prontuario, com as permissões dela)
// Nada é escrito no ponto. Não existe integração com o eSocial: o envio é confirmado à mão pelo RH.
//
// "Falta" no relatório do ponto é DIA SEM MARCAÇÃO (na rede são mais de mil em 60 dias, inclusive de quem não marca ponto):
// isso entra aqui como INDÍCIO, guardado junto da última leitura, e só vira ocorrência de falta quando o RH analisa o dia.
// Atestados/afastamentos, que o ponto registra como tal, viram ocorrência direto (pendente de validação).
//
// Regras do contrato de experiência (CLT art. 445, parágrafo único, e art. 451): no máximo 90 dias no total e UMA única
// prorrogação. O módulo calcula os vencimentos pelas datas do contrato, NUNCA presume prorrogação (ela só vale depois de o RH
// registrar a formalização, com data e documento) e não impede ninguém de trabalhar: passado o prazo sem providência ele
// sinaliza o risco de conversão para prazo indeterminado e mantém o alerta aberto até a providência ser registrada.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const GP = require('./gestao-pessoas');

const DIR = process.env.HF_DIR || path.join(__dirname, '..', 'data', 'historico-funcional');
const P = { config: () => path.join(DIR, 'config.json'), contratos: () => path.join(DIR, 'contratos.json'), ocorrencias: () => path.join(DIR, 'ocorrencias.json'), alertas: () => path.join(DIR, 'alertas.json'), aud: () => path.join(DIR, 'auditoria.jsonl'), sync: () => path.join(DIR, 'sync.json') };
const erro = (msg, status = 400, extra) => Object.assign(new Error(msg), { status }, extra || {});
const agora = () => new Date().toISOString();
const isoDe = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const hojeISO = () => isoDe(new Date());
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const D = iso => new Date(iso + 'T12:00:00');
const soma = (iso, n) => { const d = D(iso); d.setDate(d.getDate() + n); return isoDe(d); };
const diasEntre = (a, b) => Math.round((D(b) - D(a)) / 86400000);   // b − a, em dias
const br = iso => iso ? iso.split('-').reverse().join('/') : '';
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; } };
function gravarJson(arq, obj) { fs.mkdirSync(path.dirname(arq), { recursive: true }); const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, arq); }
const lerLinhas = arq => { try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const quem = u => u ? { usuario: u.usuario, nome: u.nome || u.usuario, papeis: GP.papeisDe(u) } : { usuario: 'sistema', nome: 'Sistema', papeis: [] };

// ── Permissões ───────────────────────────────────────────────────────────────────────────────────────────
// ver: quem já vê a central de pessoas (gerente da loja, RH, Coordenação, Diretoria) e o Jurídico, sempre dentro das lojas dele.
// editar (contrato, prorrogação, ocorrências): só o RH que atende a loja. Dado sensível (motivo/observação do afastamento e o
// documento médico): só RH e Jurídico — os demais veem que houve afastamento e o período, nada além (LGPD).
const ehRH = u => GP.temPapel(u, ...GP.RH);
const veLoja = (u, loja) => GP.temPapel(u, 'juridico') || GP.veLoja(u, loja);   // o Jurídico não tem loja designada: vê todas
const podeVer = (u, loja) => (GP.vePainel(u) || GP.temPapel(u, 'juridico')) && (loja == null || veLoja(u, loja));
const podeEditar = (u, loja) => GP.rhDa(u, loja);
const veSensivel = u => ehRH(u) || GP.temPapel(u, 'juridico');
const podeConfig = u => ehRH(u) || GP.temPapel(u, 'coordenacao');
const veAuditoria = u => ehRH(u) || GP.temPapel(u, 'coordenacao', 'juridico', 'diretoria');
const exige = (cond, msg) => { if (!cond) throw erro(msg, 403); };

// ── Auditoria encadeada (só acrescenta; cada linha leva o hash da anterior) ──────────────────────────────
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function auditar(user, acao, dados) {
  const l = lerLinhas(P.aud()); const ant = l.length ? l[l.length - 1].hash : '';
  const reg = { seq: l.length + 1, em: agora(), ...quem(user), acao, ...(dados || {}), ant }; reg.hash = sha(ant + JSON.stringify(reg));
  fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(P.aud(), JSON.stringify(reg) + '\n');
  try { GP.auditar({ usuario: reg.usuario, acao: 'hf_' + acao, ref: dados && (dados.ref || dados.funcId) || null }); } catch (e) {}
  return reg;
}
function verificarCadeia() { const l = lerLinhas(P.aud()); let ant = ''; for (const r of l) { const { hash, ...resto } = r; if (r.ant !== ant || sha(ant + JSON.stringify(resto)) !== hash) return { ok: false, registros: l.length, quebradaEm: r.seq }; ant = hash; } return { ok: true, registros: l.length, quebradaEm: null }; }

// ── Configuração ─────────────────────────────────────────────────────────────────────────────────────────
const CFG_PADRAO = { diasIniciais: 30, diasProrrogacao: 60, maxTotalDias: 90, alertaDias: [15, 10, 5, 3, 1], janelaAdmissaoDias: 120, sincronizarDias: 60 };
const MAX_LEGAL = 90;   // CLT art. 445, parágrafo único
function config() { const c = lerJson(P.config(), null) || {}; return { ...CFG_PADRAO, ...c, alertaDias: (Array.isArray(c.alertaDias) && c.alertaDias.length ? c.alertaDias : CFG_PADRAO.alertaDias).slice().sort((a, b) => b - a) }; }
function validarPrazos(ini, pro) {
  if (!(Number.isInteger(ini) && ini >= 1 && ini <= MAX_LEGAL)) throw erro('Período inicial inválido (de 1 a ' + MAX_LEGAL + ' dias)');
  if (!(Number.isInteger(pro) && pro >= 0 && pro < MAX_LEGAL)) throw erro('Prorrogação inválida (em dias)');
  if (ini + pro > MAX_LEGAL) throw erro('O contrato de experiência não pode passar de ' + MAX_LEGAL + ' dias no total (CLT art. 445, parágrafo único): ' + ini + ' + ' + pro + ' = ' + (ini + pro));
}
function salvarConfig(user, b) {
  exige(podeConfig(user), 'Só RH e Coordenação alteram os prazos padrão'); b = b || {}; const just = txt(b.justificativa); if (just.length < 5) throw erro('Justifique a alteração');
  const antes = config(); const ini = Math.round(+b.diasIniciais), pro = Math.round(+b.diasProrrogacao); validarPrazos(ini, pro);
  const al = [...new Set((b.alertaDias || antes.alertaDias).map(x => Math.round(+x)))].sort((a, c) => c - a); if (!al.length || al.some(x => !(x >= 1 && x <= 60))) throw erro('Dias de alerta inválidos (de 1 a 60 dias antes)');
  const novo = { ...lerJson(P.config(), {}), diasIniciais: ini, diasProrrogacao: pro, alertaDias: al, atualizadoPor: user.usuario, atualizadoEm: agora() }; gravarJson(P.config(), novo);
  auditar(user, 'config', { ref: 'CONFIG', justificativa: just, antes: { diasIniciais: antes.diasIniciais, diasProrrogacao: antes.diasProrrogacao, alertaDias: antes.alertaDias }, depois: { diasIniciais: ini, diasProrrogacao: pro, alertaDias: al } });
  return config();
}

// ── Cadastro de pessoas (sempre o do ponto) ──────────────────────────────────────────────────────────────
async function quadro(deps) { const c = await deps.colaboradores(); return { ativos: c.ativos || [], desligados: c.desligados || [], todos: [...(c.ativos || []), ...(c.desligados || [])] }; }
async function colabDe(deps, id) { const q = await quadro(deps); const c = q.todos.find(x => String(x.id) === String(id)); if (!c) throw erro('Funcionário não encontrado no cadastro do ponto', 404); return c; }
const pessoa = c => ({ id: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo || '', setor: c.setor || '', loja: +c.loja, lojaTxt: GP.LOJA_TXT[c.loja] || String(c.loja), ativo: !!c.ativo, admissao: c.admissao || null, desligamento: c.desligamento || null, clt: c.clt !== false });

// ── Contratos ────────────────────────────────────────────────────────────────────────────────────────────
const TIPOS = { experiencia: 'Contrato de experiência', indeterminado: 'Prazo indeterminado', determinado: 'Prazo determinado (outro)', aprendiz: 'Aprendizagem', outro: 'Outro' };
const PRORROGACAO = { pendente: 'Pendente', formalizada: 'Formalizada', nao_realizada: 'Não realizada' };
const DESFECHOS = { efetivado: 'Efetivado (prazo indeterminado)', encerrado: 'Encerrado no término do contrato', rescindido: 'Rescindido antes do término' };
const SITUACAO = { experiencia_inicial: 'Em experiência · período inicial', prorrogado: 'Em experiência · prorrogado', vencido_inicial: 'Término inicial vencido sem prorrogação formalizada', vencido_final: 'Contrato de experiência vencido sem regularização',
  efetivado: 'Efetivado', encerrado: 'Encerrado', rescindido: 'Rescindido', desligado: 'Desligado no ponto, sem desfecho registrado', indeterminado: 'Prazo indeterminado', fora: 'Fora do período de experiência', outro: 'Outro tipo de contrato', sem_admissao: 'Sem data de admissão no ponto' };
const contratos = () => lerJson(P.contratos(), {});
/** Datas do contrato pelas regras: término inicial = admissão + dias iniciais − 1; final = término inicial (+ prorrogação, só se FORMALIZADA). */
function datas(c) {
  if (!c.admissao) return { terminoInicial: null, finalPrevisto: null, finalComProrrogacao: null };
  const ti = c.terminoInicialAjustado || soma(c.admissao, c.diasIniciais - 1); const comPro = c.finalAjustado || soma(ti, c.diasProrrogacao);
  return { terminoInicial: ti, finalComProrrogacao: comPro, finalPrevisto: c.prorrogacao.situacao === 'formalizada' ? comPro : ti };
}
/** Contrato de quem ainda não tem registro: PRESUMIDO pelo padrão da empresa e marcado como "a confirmar pelo RH". */
function presumido(p, cfg, hoje) {
  const base = { funcId: p.id, nome: p.nome, matricula: p.matricula, loja: p.loja, admissao: p.admissao, admissaoOrigem: 'ponto', diasIniciais: cfg.diasIniciais, diasProrrogacao: cfg.diasProrrogacao, prorrogacao: { situacao: 'pendente', formalizadaEm: null, documento: null }, desfecho: null, responsaveis: { decisao: null, documentacao: null }, esocial: {}, historico: [], confirmado: false, presumido: true };
  if (!p.admissao) return { ...base, tipo: 'experiencia' };
  return { ...base, tipo: p.clt && diasEntre(p.admissao, hoje) <= cfg.janelaAdmissaoDias ? 'experiencia' : 'indeterminado' };
}
function contratoDe(p, cfg, hoje) { const c = contratos()[p.id]; return c ? { ...c, nome: p.nome, matricula: p.matricula, loja: p.loja, presumido: false } : presumido(p, cfg, hoje); }
/** Situação atual + próximo marco. Nunca bloqueia nada: `risco` só sinaliza a possível conversão para prazo indeterminado. */
function situacaoDe(c, p, hoje) {
  const d = datas(c); const out = (codigo, nivel, extra) => ({ codigo, texto: SITUACAO[codigo], nivel, risco: false, marco: null, ...d, ...(extra || {}) });
  if (c.desfecho) return out(c.desfecho.tipo, 'neutro');
  if (c.tipo !== 'experiencia') return out(c.tipo === 'indeterminado' ? (c.presumido ? 'fora' : 'indeterminado') : 'outro', 'neutro');
  if (!c.admissao) return out('sem_admissao', 'atencao');
  if (!p.ativo) return out('desligado', 'atencao');
  const marco = (tipo, data) => ({ tipo, tipoTxt: tipo === 'termino_inicial' ? 'término do período inicial' : 'término final do contrato', data, dias: diasEntre(hoje, data) });
  if (c.prorrogacao.situacao === 'formalizada') {
    if (hoje <= d.finalPrevisto) return out('prorrogado', diasEntre(hoje, d.finalPrevisto) <= 15 ? 'atencao' : 'ok', { marco: marco('final', d.finalPrevisto) });
    return out('vencido_final', 'critico', { risco: true, marco: marco('final', d.finalPrevisto), riscoTxt: 'Passou do término final (' + br(d.finalPrevisto) + ') sem desfecho registrado: se o funcionário continua trabalhando, o contrato passa a valer por prazo indeterminado (CLT art. 451). Registre a efetivação ou o encerramento.' });
  }
  if (hoje <= d.terminoInicial) return out('experiencia_inicial', diasEntre(hoje, d.terminoInicial) <= 15 ? 'atencao' : 'ok', { marco: marco('termino_inicial', d.terminoInicial) });
  if (c.presumido) return out('vencido_inicial', 'critico', { risco: true, marco: marco('termino_inicial', d.terminoInicial), texto: 'Término inicial passado, sem registro de prorrogação no sistema', riscoTxt: 'Pelo padrão da empresa o período inicial terminou em ' + br(d.terminoInicial) + ' e o sistema ainda não tem o registro deste contrato. Confirme os prazos e registre a prorrogação (se foi formalizada, com a data e o documento) ou o desfecho. Sem prorrogação formalizada no prazo, o vínculo de quem segue trabalhando tende ao prazo indeterminado (CLT arts. 445 e 451).' });
  return out('vencido_inicial', 'critico', { risco: true, marco: marco('termino_inicial', d.terminoInicial), riscoTxt: 'Passou do término inicial (' + br(d.terminoInicial) + ') ' + (c.prorrogacao.situacao === 'nao_realizada' ? 'com a prorrogação não realizada' : 'sem prorrogação formalizada') + ' e o funcionário segue ativo: risco de conversão para prazo indeterminado (CLT arts. 445 e 451). A continuidade do trabalho não é impedida — o RH analisa o vínculo e registra a providência.' });
}
function salvarContrato(c) { const todos = contratos(); const { presumido: _p, nome, matricula, ...limpo } = c; todos[c.funcId] = { ...limpo, nome, matricula }; gravarJson(P.contratos(), todos); return todos[c.funcId]; }
const retrato = c => ({ tipo: c.tipo, admissao: c.admissao, diasIniciais: c.diasIniciais, diasProrrogacao: c.diasProrrogacao, terminoInicialAjustado: c.terminoInicialAjustado || null, finalAjustado: c.finalAjustado || null, prorrogacao: { ...c.prorrogacao }, desfecho: c.desfecho ? { ...c.desfecho } : null, responsaveis: { ...(c.responsaveis || {}) }, esocial: { ...(c.esocial || {}) }, ...datas(c) });
function documentoDe(b) { if (!b) return null; const prot = txt(b.protocolo, 40), ref = txt(b.referencia, 200); if (!prot && !ref) return null; return prot ? { tipo: 'cgd', protocolo: prot } : { tipo: 'referencia', referencia: ref }; }
/**
 * Alterações do contrato. `acao`:
 *   confirmar      tipo, admissão (a do ponto, ou outra com justificativa), dias iniciais e de prorrogação
 *   prorrogacao    situacao = formalizada (exige data e documento) | nao_realizada | pendente (correção)
 *   ajustar        nova data de um marco por situação que altera o término (afastamento etc.): exige validação jurídica declarada
 *   desfecho       efetivado | encerrado | rescindido (ou `desfazer: true`)
 *   responsaveis   quem decide e quem cuida da documentação
 *   esocial        confirmação manual de que o evento foi enviado (não há integração)
 */
async function alterarContrato(user, funcId, acao, b, deps, hoje) {
  hoje = hoje || hojeISO(); b = b || {}; const p = pessoa(await colabDe(deps, funcId)); exige(podeEditar(user, p.loja), 'Só o RH que atende a unidade altera o contrato'); const cfg = config();
  const just = txt(b.justificativa, 600); if (just.length < 5) throw erro('Justificativa obrigatória (mínimo de 5 caracteres): ela fica na auditoria');
  const c = JSON.parse(JSON.stringify(contratoDe(p, cfg, hoje))); const antes = retrato(c); let nota = null;
  if (acao === 'confirmar') {
    if (!TIPOS[b.tipo]) throw erro('Tipo de contrato inválido'); c.tipo = b.tipo;
    const adm = b.admissao || p.admissao; if (!ISO.test(String(adm || ''))) throw erro('Informe a data de admissão'); if (adm > hoje) throw erro('Admissão no futuro'); c.admissao = adm; c.admissaoOrigem = adm === p.admissao ? 'ponto' : 'rh';
    if (c.tipo === 'experiencia') { const ini = b.diasIniciais == null ? cfg.diasIniciais : Math.round(+b.diasIniciais), pro = b.diasProrrogacao == null ? cfg.diasProrrogacao : Math.round(+b.diasProrrogacao); validarPrazos(ini, pro);
      if (c.prorrogacao.situacao === 'formalizada' && (ini !== c.diasIniciais || pro !== c.diasProrrogacao)) throw erro('A prorrogação já foi formalizada: os prazos não mudam mais (para corrigir, volte a prorrogação para pendente antes)');
      c.diasIniciais = ini; c.diasProrrogacao = pro; }
    c.confirmado = true; c.confirmadoPor = user.usuario; c.confirmadoEm = agora();
  } else if (acao === 'prorrogacao') {
    if (c.tipo !== 'experiencia') throw erro('Só contrato de experiência tem prorrogação'); if (c.desfecho) throw erro('O contrato já tem desfecho registrado');
    if (!PRORROGACAO[b.situacao]) throw erro('Situação da prorrogação inválida'); const d = datas(c);
    if (b.situacao === 'formalizada') {
      if (c.prorrogacao.situacao === 'formalizada') throw erro('Este contrato já teve a prorrogação formalizada: a CLT (art. 451) admite uma única prorrogação');
      if (!(c.diasProrrogacao > 0)) throw erro('Este contrato não prevê prorrogação (dias de prorrogação = 0)');
      if (!ISO.test(String(b.formalizadaEm || ''))) throw erro('Informe a data em que a prorrogação foi formalizada'); if (b.formalizadaEm > hoje) throw erro('Data de formalização no futuro'); if (b.formalizadaEm < c.admissao) throw erro('Formalização anterior à admissão');
      const doc = documentoDe(b.documento); if (!doc) throw erro('Informe o documento da prorrogação (protocolo da Gestão Documental ou a referência do termo assinado)');
      c.prorrogacao = { situacao: 'formalizada', formalizadaEm: b.formalizadaEm, documento: doc, por: user.usuario, em: agora(), foraDoPrazo: b.formalizadaEm > d.terminoInicial };
      if (c.prorrogacao.foraDoPrazo) nota = 'Prorrogação formalizada em ' + br(b.formalizadaEm) + ', depois do término inicial (' + br(d.terminoInicial) + '): há risco de o contrato já ser considerado por prazo indeterminado — validar com o jurídico.';
    } else if (b.situacao === 'nao_realizada') c.prorrogacao = { situacao: 'nao_realizada', formalizadaEm: null, documento: null, por: user.usuario, em: agora() };
    else c.prorrogacao = { situacao: 'pendente', formalizadaEm: null, documento: null, por: user.usuario, em: agora() };
    c.confirmado = true;
  } else if (acao === 'ajustar') {
    if (c.tipo !== 'experiencia') throw erro('Só contrato de experiência tem marcos a ajustar'); if (!['inicial', 'final'].includes(b.marco)) throw erro('Informe qual marco será ajustado (inicial ou final)');
    if (b.validacaoJuridica !== true) throw erro('Ajuste de término exige a declaração de que a situação foi validada juridicamente pelo RH'); if (just.length < 10) throw erro('Descreva a situação que altera o término (mínimo de 10 caracteres)');
    const nova = b.novaData === null || b.novaData === '' ? null : String(b.novaData || ''); if (nova !== null && !ISO.test(nova)) throw erro('Nova data inválida'); if (nova && nova < c.admissao) throw erro('Data anterior à admissão');
    if (b.marco === 'inicial') c.terminoInicialAjustado = nova; else { if (nova && nova < datas(c).terminoInicial) throw erro('O término final não pode ser anterior ao término inicial'); c.finalAjustado = nova; }
    c.ajustes = [...(c.ajustes || []), { marco: b.marco, novaData: nova, por: user.usuario, em: agora(), motivo: just }]; c.confirmado = true;
  } else if (acao === 'desfecho') {
    if (b.desfazer === true) { if (!c.desfecho) throw erro('Não há desfecho registrado'); c.desfecho = null; }
    else { if (!DESFECHOS[b.tipo]) throw erro('Desfecho inválido'); if (!ISO.test(String(b.data || ''))) throw erro('Informe a data do desfecho'); if (b.data < c.admissao) throw erro('Data anterior à admissão');
      c.desfecho = { tipo: b.tipo, data: b.data, documento: documentoDe(b.documento), por: user.usuario, em: agora() }; }
    c.confirmado = true;
  } else if (acao === 'responsaveis') { c.responsaveis = { decisao: txt(b.decisao, 80) || null, documentacao: txt(b.documentacao, 80) || null }; c.confirmado = true; }
  else if (acao === 'esocial') { if (!['admissao', 'prorrogacao', 'desfecho'].includes(b.evento)) throw erro('Evento do eSocial inválido'); if (b.informadoEm && !ISO.test(b.informadoEm)) throw erro('Data inválida');
    c.esocial = { ...(c.esocial || {}), [b.evento]: b.informadoEm ? { informadoEm: b.informadoEm, recibo: txt(b.recibo, 60) || null, por: user.usuario, em: agora() } : null }; c.confirmado = true; }
  else throw erro('Ação inválida');
  const depois = retrato(c); if (JSON.stringify(antes) === JSON.stringify(depois) && acao !== 'confirmar') throw erro('Nada mudou');
  const reg = auditar(user, 'contrato_' + acao, { ref: 'CT-' + p.id, funcId: p.id, funcionario: p.nome, loja: p.loja, justificativa: just, antes, depois, ...(nota ? { nota } : {}) });
  c.historico = [...(c.historico || []), { em: reg.em, usuario: user.usuario, nome: user.nome || user.usuario, acao, justificativa: just, antes, depois, auditoria: reg.seq, ...(nota ? { nota } : {}) }];
  if (!c.criadoEm) { c.criadoEm = reg.em; c.criadoPor = user.usuario; }
  salvarContrato(c); c.presumido = false;
  if (['prorrogacao', 'desfecho', 'ajustar'].includes(acao)) { try { GP.notificar(GP.usuariosPara(['coordenacao'], p.loja).filter(u => u !== user.usuario), 'Contratos · ' + p.nome + ' (' + (GP.LOJA_TXT[p.loja] || p.loja).split(' · ')[0] + '): ' + ({ prorrogacao: 'prorrogação ' + PRORROGACAO[c.prorrogacao.situacao].toLowerCase(), desfecho: c.desfecho ? DESFECHOS[c.desfecho.tipo].toLowerCase() : 'desfecho desfeito', ajustar: 'término ajustado' })[acao] + ' por ' + (user.nome || user.usuario) + (nota ? ' — ' + nota : ''), { url: '/historico-funcional.html#ficha=' + p.id }); } catch (e) {} }
  return { ok: true, nota, contrato: visaoContrato(c, p, hoje) };
}
/** Contrato pronto para a tela: registro + datas + situação + pendências de providência. */
function visaoContrato(c, p, hoje) {
  const s = situacaoDe(c, p, hoje); const pend = [];
  if (c.tipo === 'experiencia' && !c.desfecho && p.ativo) {
    if (c.presumido) pend.push({ codigo: 'a_confirmar', texto: 'Contrato presumido pelo padrão da empresa (' + c.diasIniciais + ' + ' + c.diasProrrogacao + ' dias): o RH precisa confirmar o tipo e os prazos' });
    if (c.prorrogacao.situacao === 'pendente' && c.admissao) pend.push({ codigo: 'prorrogacao_pendente', texto: 'Prorrogação pendente de decisão até ' + br(s.terminoInicial) + ' — nada é presumido: registre a formalização (com documento) ou a não realização' });
    if (c.prorrogacao.situacao === 'formalizada' && !(c.esocial && c.esocial.prorrogacao)) pend.push({ codigo: 'esocial_prorrogacao', texto: 'Prorrogação formalizada sem a confirmação de envio ao eSocial (alteração contratual): confirme com quem transmite os eventos' });
    if (c.prorrogacao.foraDoPrazo) pend.push({ codigo: 'prorrogacao_fora_do_prazo', texto: 'Prorrogação formalizada depois do término inicial: validar com o jurídico' });
  }
  return { ...c, tipoTxt: TIPOS[c.tipo], prorrogacaoTxt: PRORROGACAO[c.prorrogacao.situacao], desfechoTxt: c.desfecho ? DESFECHOS[c.desfecho.tipo] : null, ...datas(c), situacao: s, pendencias: pend };
}

// ── Ocorrências (atestados/afastamentos e faltas) ────────────────────────────────────────────────────────
const TIPOS_OC = { atestado: 'Atestado / afastamento', falta: 'Falta' };
const CLASSES = { atestado: { atestado_medico: 'Atestado médico', licenca: 'Licença', acidente: 'Acidente de trabalho', acompanhamento: 'Acompanhamento / declaração', afastamento: 'Afastamento' }, falta: { pendente: 'Pendente de análise', justificada: 'Justificada', injustificada: 'Injustificada' } };
const SIT_OC = { pendente_validacao: 'Pendente de validação', validado: 'Validado', recusado: 'Recusado', pendente_analise: 'Pendente de análise', analisada: 'Analisada', registrada: 'Registrada', cancelada: 'Cancelada' };
const ocorrencias = () => lerJson(P.ocorrencias(), { seq: {}, itens: {} });
function novoId(o, ano) { o.seq[ano] = (o.seq[ano] || 0) + 1; return 'OC-' + ano + '-' + String(o.seq[ano]).padStart(5, '0'); }
const classeAfast = t => { const s = semAcento(t); return /ACIDENT/.test(s) ? 'acidente' : /LICEN|MATERN|PATERN/.test(s) ? 'licenca' : /ACOMPANH|DECLARA/.test(s) ? 'acompanhamento' : /ATEST|MEDIC|DOEN|SAUDE/.test(s) ? 'atestado_medico' : 'afastamento'; };
const cobre = (o, data) => o.tipo === 'atestado' && o.situacao !== 'cancelada' && o.situacao !== 'recusado' && o.data <= data && (o.fim || o.data) >= data;
/** Ocorrência como cada perfil pode ver: quem não vê dado sensível recebe só o período e a situação. */
function publica(o, user) {
  const base = { ...o, tipoTxt: TIPOS_OC[o.tipo], classificacaoTxt: (CLASSES[o.tipo] || {})[o.classificacao] || o.classificacao, situacaoTxt: SIT_OC[o.situacao] || o.situacao, origemTxt: { ponto: 'Ponto (VR)', manual: 'Lançado pelo RH' }[o.origem] || o.origem };
  if (!o.sensivel || veSensivel(user)) return { ...base, restrito: false };
  return { ...base, classificacao: 'afastamento', classificacaoTxt: 'Afastamento (detalhe restrito)', detalhe: null, documento: o.documento ? { restrito: true } : null, obs: null, historico: (o.historico || []).map(h => ({ em: h.em, nome: h.nome, acao: h.acao })), restrito: true };
}
/** Lê afastamentos e faltas do ponto e cria as ocorrências que ainda não existem (a chave de origem impede duplicidade). */
async function sincronizarPonto(deps, opts = {}) {
  const hoje = opts.hoje || hojeISO(); const cfg = config(); const de = soma(hoje, -cfg.sincronizarDias); const q = await quadro(deps);
  const porNome = new Map(); for (const c of q.todos) { const k = semAcento(c.nome); if (!porNome.has(k)) porNome.set(k, []); porNome.get(k).push(c); }
  const achar = (nome, loja) => { const l = porNome.get(semAcento(nome)) || []; if (l.length === 1) return l[0]; const mesmaLoja = l.filter(c => loja != null && +c.loja === +loja); if (mesmaLoja.length === 1) return mesmaLoja[0]; const at = l.filter(c => c.ativo); return at.length === 1 ? at[0] : null; };
  const O = ocorrencias(); const porChave = new Map(Object.values(O.itens).map(o => [o.chaveOrigem, o])); const r = { em: agora(), de, ate: hoje, atestadosNovos: 0, atestadosAtualizados: 0, faltasNovas: 0, naoIdentificados: [], erros: [] };
  const hist = (acao, extra) => ({ em: r.em, usuario: 'sistema', nome: 'Sincronização com o ponto', acao, ...(extra || {}) });
  let afast = []; try { afast = await deps.afastamentosLongos(de, soma(hoje, 120)); } catch (e) { r.erros.push('afastamentos: ' + e.message); }
  for (const a of afast) {
    if (a.ferias || !a.inicio) continue; const c = achar(a.nome, a.loja); if (!c) { r.naoIdentificados.push({ tipo: 'afastamento', nome: a.nome, data: a.inicio }); continue; }
    const chave = 'ponto|afast|' + c.id + '|' + a.inicio; const ex = porChave.get(chave); const fim = a.fim || a.inicio;
    if (!ex) { const o = { id: novoId(O, a.inicio.slice(0, 4)), funcId: c.id, nome: c.nome, loja: +c.loja, tipo: 'atestado', classificacao: classeAfast(a.tipo), data: a.inicio, fim, dias: diasEntre(a.inicio, fim) + 1, situacao: 'pendente_validacao', origem: 'ponto', chaveOrigem: chave, sensivel: true, detalhe: { tipoNoPonto: a.tipo || null, obs: a.obs || null }, documento: null, responsavel: null, criadoEm: r.em, criadoPor: 'sistema', historico: [hist('importada')] };
      O.itens[o.id] = o; porChave.set(chave, o); r.atestadosNovos++; }
    else if (ex.fim !== fim && ex.situacao !== 'cancelada') { ex.historico.push(hist('atualizada_pelo_ponto', { antes: { fim: ex.fim }, depois: { fim } })); ex.fim = fim; ex.dias = diasEntre(ex.data, fim) + 1; r.atestadosAtualizados++; }
  }
  let faltas = []; try { faltas = ((await deps.resumo({ de, ate: hoje })).listas || {}).faltas || []; } catch (e) { r.erros.push('faltas: ' + e.message); }
  const lista = Object.values(O.itens);
  // dia sem marcação = INDÍCIO de falta (não é falta, e muito menos injustificada): fica guardado por pessoa, com o que o
  // ponto diz sobre abono, e só vira ocorrência quando o RH analisa o dia
  r.indicios = {}; r.indiciosDias = 0; r.indiciosAbonados = 0;
  for (const f of faltas) {
    if (!f.data) continue; const c = achar(f.nome, f.loja); if (!c) { r.naoIdentificados.push({ tipo: 'falta', nome: f.nome, data: f.data }); continue; }
    const l = r.indicios[c.id] || (r.indicios[c.id] = []); if (l.some(x => x.data === f.data)) continue; l.push({ data: f.data, abonada: !!f.abonada, motivo: f.motivo || null }); if (f.abonada) r.indiciosAbonados++; else r.indiciosDias++;
  }
  // falta pendente que ganhou atestado depois: anota o vínculo (a classificação continua com o RH)
  for (const o of lista) if (o.tipo === 'falta' && !o.atestado && o.situacao === 'pendente_analise') { const at = lista.find(x => String(x.funcId) === String(o.funcId) && cobre(x, o.data)); if (at) { o.atestado = at.id; o.historico.push(hist('atestado_vinculado', { atestado: at.id })); } }
  gravarJson(P.ocorrencias(), O); gravarJson(P.sync(), r);
  if (r.atestadosNovos || r.atestadosAtualizados) auditar(null, 'sincronizar_ponto', { ref: 'SYNC', de, ate: hoje, atestadosNovos: r.atestadosNovos, atestadosAtualizados: r.atestadosAtualizados, diasSemMarcacao: r.indiciosDias, naoIdentificados: r.naoIdentificados.length });
  return r;
}
/** Dias sem marcação que o ponto apontou para a pessoa e que o RH ainda não analisou (com o aviso de atestado no período). */
function indiciosDe(funcId) {
  const s = lerJson(P.sync(), null); const l = (s && s.indicios && s.indicios[funcId]) || []; const ocs = ocorrenciasDe(funcId);
  return l.filter(x => !ocs.some(o => o.tipo === 'falta' && o.situacao !== 'cancelada' && o.data === x.data)).map(x => { const at = ocs.find(o => cobre(o, x.data)); return { ...x, atestado: at ? at.id : null }; }).sort((a, b) => b.data.localeCompare(a.data));
}
/** Lançamento pelo RH: falta analisada a partir do indício do ponto, ou ocorrência que o ponto não tem. Advertência e suspensão NÃO entram aqui: são da Gestão Disciplinar. */
async function registrarOcorrencia(user, b, deps, hoje) {
  hoje = hoje || hojeISO(); b = b || {}; const p = pessoa(await colabDe(deps, b.funcId)); exige(podeEditar(user, p.loja), 'Só o RH que atende a unidade lança ocorrências');
  if (['advertencia', 'suspensao'].includes(b.tipo)) throw erro('Advertências e suspensões são lançadas na Gestão Disciplinar (que tem o fluxo e o documento): aqui elas só são consultadas, para não existirem em dois lugares');
  if (!TIPOS_OC[b.tipo]) throw erro('Tipo de ocorrência inválido'); if (!ISO.test(String(b.data || ''))) throw erro('Informe a data'); const fim = b.fim || b.data; if (!ISO.test(fim) || fim < b.data) throw erro('Período inválido');
  const just = txt(b.justificativa, 600); if (just.length < 5) throw erro('Justificativa obrigatória (mínimo de 5 caracteres)');
  const classe = b.classificacao || (b.tipo === 'falta' ? 'pendente' : 'atestado_medico'); if (!CLASSES[b.tipo][classe]) throw erro('Classificação inválida');
  if (b.tipo === 'falta' && fim !== b.data) throw erro('Falta é lançada dia a dia');
  const O = ocorrencias(); const dup = Object.values(O.itens).find(o => String(o.funcId) === String(p.id) && o.tipo === b.tipo && o.situacao !== 'cancelada' && o.data <= fim && (o.fim || o.data) >= b.data);
  if (dup) throw erro('Já existe ' + TIPOS_OC[b.tipo].toLowerCase() + ' deste funcionário no período (' + dup.id + ', ' + br(dup.data) + (dup.fim !== dup.data ? ' a ' + br(dup.fim) : '') + ', origem ' + dup.origem + '): não é lançada de novo', 409, { duplicada: dup.id });
  const em = agora(); const at = b.tipo === 'falta' ? Object.values(O.itens).find(o => String(o.funcId) === String(p.id) && cobre(o, b.data)) : null;
  if (b.tipo === 'falta' && classe === 'injustificada' && at && b.cienteAtestado !== true) throw erro('Há atestado apresentado cobrindo este dia (' + at.id + '): a falta não é lançada como injustificada sem a análise do RH declarada', 409, { atestado: at.id });
  // falta de um dia que o ponto apontou sem marcação: a origem é o ponto (e a chave impede lançar o mesmo dia duas vezes)
  const ind = b.tipo === 'falta' ? ((lerJson(P.sync(), null) || {}).indicios || {})[p.id] : null; const doPonto = ind ? ind.find(x => x.data === b.data) : null;
  const o = { id: novoId(O, b.data.slice(0, 4)), funcId: p.id, nome: p.nome, loja: p.loja, tipo: b.tipo, classificacao: classe, data: b.data, fim, dias: diasEntre(b.data, fim) + 1, situacao: b.tipo === 'atestado' ? 'validado' : classe === 'pendente' ? 'pendente_analise' : 'analisada', origem: doPonto ? 'ponto' : 'manual', chaveOrigem: doPonto ? 'ponto|falta|' + p.id + '|' + b.data : 'manual|' + b.tipo + '|' + p.id + '|' + b.data + '|' + em,
    sensivel: b.tipo === 'atestado', detalhe: { obs: txt(b.obs, 400) || null, ...(doPonto ? { abonadaNoPonto: doPonto.abonada, motivoNoPonto: doPonto.motivo } : {}) }, atestado: at ? at.id : null, documento: documentoDe(b.documento), responsavel: quem(user), criadoEm: em, criadoPor: user.usuario, historico: [] };
  const reg = auditar(user, 'ocorrencia_lancar', { ref: o.id, funcId: p.id, funcionario: p.nome, loja: p.loja, justificativa: just, antes: null, depois: { tipo: o.tipo, classificacao: o.classificacao, data: o.data, fim: o.fim, situacao: o.situacao } });
  o.historico.push({ em: reg.em, usuario: user.usuario, nome: user.nome || user.usuario, acao: 'lancada', justificativa: just, auditoria: reg.seq }); O.itens[o.id] = o; gravarJson(P.ocorrencias(), O);
  return publica(o, user);
}
/** Decisão do RH: validar/recusar atestado, classificar falta (justificada / injustificada), anexar documento ou cancelar. */
function decidirOcorrencia(user, id, b) {
  b = b || {}; const O = ocorrencias(); const o = O.itens[id]; if (!o) throw erro('Ocorrência não encontrada', 404); exige(podeEditar(user, o.loja), 'Só o RH que atende a unidade decide ocorrências');
  if (o.situacao === 'cancelada') throw erro('Ocorrência cancelada'); const just = txt(b.justificativa, 600); if (just.length < 5) throw erro('Justificativa obrigatória (mínimo de 5 caracteres)');
  const antes = { classificacao: o.classificacao, situacao: o.situacao, documento: o.documento };
  if (b.acao === 'cancelar') o.situacao = 'cancelada';
  else if (b.acao === 'documento') { const d = documentoDe(b.documento); if (!d) throw erro('Informe o documento'); o.documento = d; }
  else if (o.tipo === 'atestado') { if (!['validar', 'recusar'].includes(b.acao)) throw erro('Ação inválida para atestado'); o.situacao = b.acao === 'validar' ? 'validado' : 'recusado'; if (b.classificacao) { if (!CLASSES.atestado[b.classificacao]) throw erro('Classificação inválida'); o.classificacao = b.classificacao; } if (b.documento) o.documento = documentoDe(b.documento) || o.documento; }
  else { if (b.acao !== 'classificar' || !['justificada', 'injustificada', 'pendente'].includes(b.classificacao)) throw erro('Classifique a falta como justificada, injustificada ou pendente');
    // atestado apresentado nunca vira falta injustificada sozinho: só com a declaração de que o RH analisou
    if (b.classificacao === 'injustificada' && o.atestado && b.cienteAtestado !== true) throw erro('Há atestado apresentado cobrindo este dia (' + o.atestado + '): para classificar como injustificada o RH precisa declarar que analisou o atestado', 409, { atestado: o.atestado });
    o.classificacao = b.classificacao; o.situacao = b.classificacao === 'pendente' ? 'pendente_analise' : 'analisada'; if (b.documento) o.documento = documentoDe(b.documento) || o.documento; }
  o.responsavel = quem(user); const depois = { classificacao: o.classificacao, situacao: o.situacao, documento: o.documento };
  const reg = auditar(user, 'ocorrencia_' + b.acao, { ref: o.id, funcId: o.funcId, funcionario: o.nome, loja: o.loja, justificativa: just, antes, depois });
  o.historico.push({ em: reg.em, usuario: user.usuario, nome: user.nome || user.usuario, acao: b.acao, justificativa: just, antes, depois, auditoria: reg.seq }); gravarJson(P.ocorrencias(), O);
  return publica(o, user);
}
const ocorrenciasDe = funcId => Object.values(ocorrencias().itens).filter(o => String(o.funcId) === String(funcId)).sort((a, b) => b.data.localeCompare(a.data));

// ── Ficha individual (7 abas) ────────────────────────────────────────────────────────────────────────────
async function ficha(user, funcId, deps, hoje) {
  hoje = hoje || hojeISO(); const p = pessoa(await colabDe(deps, funcId)); exige(podeVer(user, p.loja), 'Funcionário fora das unidades que você atende'); const cfg = config();
  const contrato = visaoContrato(contratoDe(p, cfg, hoje), p, hoje); const ocs = ocorrenciasDe(p.id);
  // afastamento dentro do período de experiência pode alterar o término: só sinaliza — o ajuste é do RH, com validação jurídica
  if (contrato.tipo === 'experiencia' && contrato.admissao && !contrato.desfecho) { const fimExp = contrato.finalComProrrogacao; const n = ocs.filter(o => o.tipo === 'atestado' && !['cancelada', 'recusado'].includes(o.situacao) && o.data <= fimExp && (o.fim || o.data) >= contrato.admissao);
    if (n.length) contrato.pendencias.push({ codigo: 'afastamento_na_experiencia', texto: n.length + ' afastamento(s) dentro do período de experiência (' + n.reduce((t, o) => t + o.dias, 0) + ' dia(s)): podem alterar o término do contrato — o RH valida juridicamente e, se for o caso, registra o ajuste do término' }); }
  let disciplinar = { penalidades: [], administrativas: [], total: 0 }, discErro = null; try { disciplinar = require('./disciplinar').historicoColaborador(p.id, user); } catch (e) { discErro = e.message; }
  const todas = [...disciplinar.penalidades, ...disciplinar.administrativas].map(x => ({ ...x, id: x.protocolo, origem: 'disciplinar', origemTxt: 'Gestão Disciplinar' }));
  let docs = null, docsErro = null; try { const pr = await require('./gestao-documental').prontuario(p.id, user, deps); docs = { total: pr.total, pastas: pr.pastas.map(x => ({ categoria: x.categoria, nome: x.nome, sensivel: x.sensivel, restrita: x.restrita, abertos: x.abertos, docs: x.docs.map(d => ({ protocolo: d.protocolo, tipo: d.tipo, dataDocumento: d.dataDocumento, statusTxt: d.statusTxt, sensivel: d.sensivel, enviadoPor: d.enviadoPor, arquivo: d.arquivo ? d.arquivo.nome : null })) })) }; } catch (e) { docsErro = e.message; }
  const faltas = ocs.filter(o => o.tipo === 'falta' && o.situacao !== 'cancelada').map(o => publica(o, user));
  try { GP.auditar({ usuario: user.usuario, acao: 'hf_ver_ficha', ref: p.id }); } catch (e) {}
  return { pessoa: p, podeEditar: podeEditar(user, p.loja), veSensivel: veSensivel(user), contrato,
    atestados: ocs.filter(o => o.tipo === 'atestado').map(o => publica(o, user)),
    advertencias: todas.filter(x => x.medida === 'advertencia'), suspensoes: todas.filter(x => x.medida === 'suspensao'), disciplinarOutras: todas.filter(x => !['advertencia', 'suspensao'].includes(x.medida)), disciplinarErro: discErro, reincidente: !!disciplinar.reincidente,
    faltas: { justificadas: faltas.filter(o => o.classificacao === 'justificada'), injustificadas: faltas.filter(o => o.classificacao === 'injustificada'), pendentes: faltas.filter(o => o.classificacao === 'pendente'), indicios: indiciosDe(p.id) },
    documentos: docs, documentosErro: docsErro,
    auditoria: veAuditoria(user) ? lerLinhas(P.aud()).filter(r => String(r.funcId) === String(p.id)).reverse().slice(0, 300).map(r => ({ seq: r.seq, em: r.em, usuario: r.usuario, nome: r.nome, acao: r.acao, acaoTxt: ACAO_TXT[r.acao] || r.acao, ref: r.ref, justificativa: r.justificativa || null, antes: r.antes === undefined ? null : r.antes, depois: r.depois === undefined ? null : r.depois, nota: r.nota || null, hash: r.hash.slice(0, 12) })) : null };
}
const ACAO_TXT = { config: 'Prazos padrão alterados', contrato_confirmar: 'Contrato confirmado / prazos definidos', contrato_prorrogacao: 'Prorrogação do contrato', contrato_ajustar: 'Término do contrato ajustado (validação jurídica)', contrato_desfecho: 'Desfecho do contrato', contrato_responsaveis: 'Responsáveis pelo contrato', contrato_esocial: 'Confirmação de envio ao eSocial',
  ocorrencia_lancar: 'Ocorrência lançada pelo RH', ocorrencia_validar: 'Atestado validado', ocorrencia_recusar: 'Atestado recusado', ocorrencia_classificar: 'Falta classificada', ocorrencia_documento: 'Documento associado à ocorrência', ocorrencia_cancelar: 'Ocorrência cancelada', sincronizar_ponto: 'Sincronização com o ponto', aviso_prazo: 'Aviso de prazo contratual enviado' };

// ── Lista de contratos, destaques da escala e painel de alertas ──────────────────────────────────────────
async function listarContratos(user, deps, f = {}, hoje) {
  hoje = hoje || hojeISO(); exige(podeVer(user, null), 'Seu papel não dá acesso aos contratos'); const cfg = config(); const q = await quadro(deps); const reg = contratos(); const n = semAcento(f.q || '');
  const base = [...q.ativos, ...q.desligados.filter(c => reg[c.id] && !reg[c.id].desfecho)].filter(c => veLoja(user, c.loja) && (!f.loja || +c.loja === +f.loja) && (!n || semAcento(c.nome).includes(n) || String(c.matricula || '').includes(n)));
  return base.map(c => { const p = pessoa(c); const v = visaoContrato(contratoDe(p, cfg, hoje), p, hoje); return { pessoa: p, tipo: v.tipo, tipoTxt: v.tipoTxt, presumido: !!v.presumido, admissao: v.admissao, terminoInicial: v.terminoInicial, finalPrevisto: v.finalPrevisto, prorrogacao: v.prorrogacao.situacao, prorrogacaoTxt: v.prorrogacaoTxt, situacao: v.situacao, pendencias: v.pendencias, desfecho: v.desfecho }; })
    .filter(x => !f.so || (f.so === 'experiencia' ? x.tipo === 'experiencia' && !x.desfecho : true)).sort((a, b) => ((a.situacao.marco ? a.situacao.marco.dias : 9999) - (b.situacao.marco ? b.situacao.marco.dias : 9999)) || a.pessoa.nome.localeCompare(b.pessoa.nome));
}
/** Selo do funcionário dentro da escala (não mexe na cor do turno): quem está em experiência e quantos dias faltam para o marco. */
async function destaques(user, loja, deps, hoje) {
  hoje = hoje || hojeISO(); if (!podeVer(user, loja)) return {}; const out = {};
  for (const x of await listarContratos(user, deps, { loja, so: 'experiencia' }, hoje)) { const s = x.situacao; if (!s.marco) continue;
    out[x.pessoa.id] = { rotulo: s.risco ? 'EXP vencido' : 'EXP ' + s.marco.dias + 'd', nivel: s.risco ? 'critico' : s.marco.dias <= 5 ? 'critico' : s.marco.dias <= 15 ? 'atencao' : 'ok',
      titulo: s.texto + ' · ' + s.marco.tipoTxt + ' em ' + br(s.marco.data) + (s.risco ? ' — sem providência registrada' : ' (faltam ' + s.marco.dias + ' dia(s))') + (x.presumido ? ' · contrato a confirmar pelo RH' : '') + ' · prorrogação ' + x.prorrogacaoTxt.toLowerCase() }; }
  return out;
}
async function painel(user, deps, hoje) {
  hoje = hoje || hojeISO(); exige(podeVer(user, null), 'Seu papel não dá acesso ao painel'); const cfg = config(); const max = cfg.alertaDias[0];
  const cts = (await listarContratos(user, deps, { so: 'experiencia' }, hoje)).filter(x => x.pessoa.ativo); const linha = x => ({ id: x.pessoa.id, nome: x.pessoa.nome, loja: x.pessoa.loja, lojaTxt: x.pessoa.lojaTxt, setor: x.pessoa.setor, admissao: x.admissao, terminoInicial: x.terminoInicial, finalPrevisto: x.finalPrevisto, prorrogacaoTxt: x.prorrogacaoTxt, presumido: x.presumido, situacaoTxt: x.situacao.texto, marco: x.situacao.marco, risco: x.situacao.risco, riscoTxt: x.situacao.riscoTxt || null });
  const ocs = Object.values(ocorrencias().itens).filter(o => veLoja(user, o.loja) && o.situacao !== 'cancelada'); const emEscala = d => d >= hoje;
  let disc = [], discErro = null; try { disc = require('./disciplinar').listar(user, { ocorrenciaDe: soma(hoje, -90) }).filter(s => ['advertencia', 'suspensao'].includes(s.medidaDecidida || s.medidaSugerida) && !['cancelado', 'indeferido_encerrado'].includes(s.status)).map(s => ({ protocolo: s.protocolo, nome: s.colaborador.nome, id: s.colaborador.id, loja: s.loja, lojaTxt: s.lojaTxt, medida: s.medidaDecidida || s.medidaSugerida, medidaTxt: s.medidaDecididaTxt || (s.medidaSugeridaTxt + ' (sugerida)'), dias: s.dias, dataOcorrencia: s.dataOcorrencia, statusTxt: s.statusTxt, final: s.final })); } catch (e) { discErro = e.message; }
  const P1 = { proximos: cts.filter(x => x.situacao.marco && !x.situacao.risco && x.situacao.marco.dias <= max).map(linha),
    prorrogacoesPendentes: cts.filter(x => x.prorrogacao === 'pendente' && x.situacao.codigo === 'experiencia_inicial' && x.situacao.marco.dias <= max).map(linha),
    vencidos: cts.filter(x => x.situacao.risco).map(linha), aConfirmar: cts.filter(x => x.presumido).map(linha),
    atestadosPendentes: ocs.filter(o => o.tipo === 'atestado' && o.situacao === 'pendente_validacao').sort((a, b) => b.data.localeCompare(a.data)).map(o => publica(o, user)),
    faltasPendentes: ocs.filter(o => o.tipo === 'falta' && o.situacao === 'pendente_analise').sort((a, b) => b.data.localeCompare(a.data)).map(o => publica(o, user)),
    disciplinares: disc, disciplinaresErro: discErro,
    // o que mexe na escala daqui para a frente: afastamento em curso ou futuro e contrato que termina nos próximos 30 dias
    impactoEscala: [...ocs.filter(o => o.tipo === 'atestado' && o.situacao !== 'recusado' && emEscala(o.fim || o.data)).map(o => ({ tipo: 'afastamento', id: o.funcId, nome: o.nome, loja: o.loja, de: o.data, ate: o.fim, texto: 'Afastamento de ' + br(o.data) + ' a ' + br(o.fim) + ' (' + o.dias + ' dia(s))', ref: o.id })),
      ...cts.filter(x => x.situacao.marco && x.situacao.marco.dias <= 30 && x.situacao.marco.dias >= 0).map(x => ({ tipo: 'contrato', id: x.pessoa.id, nome: x.pessoa.nome, loja: x.pessoa.loja, de: x.situacao.marco.data, ate: x.situacao.marco.data, texto: x.situacao.marco.tipoTxt + ' em ' + br(x.situacao.marco.data) + ' — prorrogação ' + x.prorrogacaoTxt.toLowerCase(), ref: 'CT-' + x.pessoa.id })),
      ...disc.filter(s => s.medida === 'suspensao' && !s.final).map(s => ({ tipo: 'suspensao', id: s.id, nome: s.nome, loja: s.loja, de: s.dataOcorrencia, ate: s.dataOcorrencia, texto: 'Suspensão em andamento na Gestão Disciplinar (' + s.statusTxt + ')', ref: s.protocolo }))].sort((a, b) => a.de.localeCompare(b.de)) };
  // dias sem marcação que o ponto apontou e ninguém analisou: só o total e quem mais tem (não são faltas, não entram no contador)
  const sy = lerJson(P.sync(), null); const nomes = new Map(cts.map(x => [String(x.pessoa.id), x.pessoa])); let indDias = 0; const indTop = [];
  if (sy && sy.indicios) { const q2 = await quadro(deps); for (const c of q2.ativos) nomes.set(String(c.id), pessoa(c)); for (const [id, l] of Object.entries(sy.indicios)) { const pp = nomes.get(String(id)); if (!pp || !veLoja(user, pp.loja)) continue; const n = indiciosDe(id).filter(x => !x.abonada).length; if (!n) continue; indDias += n; indTop.push({ id: pp.id, nome: pp.nome, loja: pp.loja, lojaTxt: pp.lojaTxt, dias: n }); } }
  indTop.sort((a, b) => b.dias - a.dias);
  return { hoje, alertaDias: cfg.alertaDias, podeConfig: podeConfig(user), indiciosPonto: { dias: indDias, pessoas: indTop.length, top: indTop.slice(0, 15) }, ...P1, resumo: Object.fromEntries(Object.entries(P1).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])), sync: lerJson(P.sync(), null) };
}
/** Contador do menu: o que ainda espera providência (nunca dá erro: sem acesso devolve 0). O acervo ainda não conferido
 *  pelo RH (contratos presumidos) fica no painel, não no contador. */
async function pendencias(user, deps, hoje) { try { const p = await painel(user, deps, hoje); return { n: p.vencidos.filter(x => !x.presumido).length + p.prorrogacoesPendentes.length + (ehRH(user) ? p.atestadosPendentes.length + p.faltasPendentes.length : 0) }; } catch (e) { return { n: 0 }; } }

// ── Avisos de prazo: 15, 10, 5, 3 e 1 dia antes de cada marco; o alerta só fecha com a providência registrada ──
async function avisarPrazos(deps, hoje) {
  hoje = hoje || hojeISO(); const cfg = config(); const q = await quadro(deps); const primeira = !fs.existsSync(P.alertas()); const A = lerJson(P.alertas(), {}); const enviados = [];
  // PRIMEIRA execução (o módulo acabou de entrar no ar): o que já está vencido ou dentro do prazo de alerta é o acervo — em vez
  // de um aviso por contrato, sai UM resumo para o RH e a Coordenação; dali em diante cada contrato avisa na régua normal
  const acervo = { vencidos: [], proximos: [] };
  for (const c of q.ativos) { const p = pessoa(c); const ct = contratoDe(p, cfg, hoje); if (ct.tipo !== 'experiencia' || ct.desfecho) continue; const s = situacaoDe(ct, p, hoje); if (!s.marco) continue;
    const chave = p.id + '|' + s.marco.tipo + '|' + s.marco.data; const a = A[chave] || (A[chave] = { avisos: {} }); const lojaCod = (GP.LOJA_TXT[p.loja] || String(p.loja)).split(' · ')[0];
    if (s.risco) { if (a.vencido) continue; a.vencido = hoje; if (primeira) { a.acervo = true; acervo.vencidos.push(p.id); continue; }
      const para = GP.usuariosPara([...GP.RH, 'coordenacao'], p.loja); const texto = 'Contratos · ' + p.nome + ' (' + lojaCod + '): ' + s.marco.tipoTxt + ' VENCEU em ' + br(s.marco.data) + ' sem providência registrada — risco de conversão para prazo indeterminado';
      if (para.length) GP.notificar(para, texto, { url: '/historico-funcional.html#ficha=' + p.id }); auditar(null, 'aviso_prazo', { ref: 'CT-' + p.id, funcId: p.id, funcionario: p.nome, loja: p.loja, marco: s.marco, vencido: true, para }); enviados.push({ id: p.id, marco: s.marco.tipo, vencido: true, para }); continue; }
    // o limite da vez é o MENOR dos que já foram alcançados (15 → 10 → 5 → 3 → 1); cada limite avisa uma vez só
    const limite = cfg.alertaDias.filter(t => s.marco.dias <= t).pop(); if (limite == null || a.avisos[limite]) continue;
    for (const t of cfg.alertaDias) if (t >= limite && !a.avisos[t]) a.avisos[t] = t === limite ? hoje : 'pulado';
    if (primeira) { a.acervo = true; acervo.proximos.push(p.id); continue; }
    const para = GP.usuariosPara(limite <= 5 ? [...GP.RH, 'coordenacao'] : GP.RH, p.loja);   // RH sempre; a Coordenação entra na reta final
    const texto = 'Contratos · ' + p.nome + ' (' + lojaCod + '): ' + (s.marco.dias === 0 ? 'HOJE' : 'em ' + s.marco.dias + ' dia(s)') + ' vence o ' + s.marco.tipoTxt + ' (' + br(s.marco.data) + ')' + (s.marco.tipo === 'termino_inicial' ? ' — prorrogação ' + PRORROGACAO[ct.prorrogacao.situacao].toLowerCase() : '') + (ct.presumido ? ' · contrato a confirmar' : '');
    if (para.length) GP.notificar(para, texto, { url: '/historico-funcional.html#ficha=' + p.id }); auditar(null, 'aviso_prazo', { ref: 'CT-' + p.id, funcId: p.id, funcionario: p.nome, loja: p.loja, marco: s.marco, limite, para }); enviados.push({ id: p.id, marco: s.marco.tipo, limite, dias: s.marco.dias, para });
  }
  if (primeira && (acervo.vencidos.length || acervo.proximos.length)) { const para = GP.usuariosPara([...GP.RH, 'coordenacao'], null);
    const texto = 'Contratos e Histórico Funcional entrou no ar: ' + acervo.vencidos.length + ' contrato(s) de experiência já passaram do término inicial sem prorrogação registrada no sistema e ' + acervo.proximos.length + ' vencem nos próximos ' + cfg.alertaDias[0] + ' dias. Confira no painel de alertas.';
    if (para.length) GP.notificar(para, texto, { url: '/historico-funcional.html#painel' }); auditar(null, 'aviso_prazo', { ref: 'ACERVO', acervo: true, vencidos: acervo.vencidos.length, proximos: acervo.proximos.length, para }); enviados.push({ acervo: true, vencidos: acervo.vencidos, proximos: acervo.proximos, para }); }
  gravarJson(P.alertas(), A); return enviados;
}
function trilha(user, f = {}) { exige(veAuditoria(user), 'Sem acesso à auditoria'); const l = lerLinhas(P.aud()).filter(r => (r.loja == null || veLoja(user, r.loja)) && (!f.loja || +r.loja === +f.loja)).reverse();
  return { cadeia: verificarCadeia(), total: l.length, registros: l.slice(0, 500).map(r => ({ seq: r.seq, em: r.em, usuario: r.usuario, nome: r.nome, acao: r.acao, acaoTxt: ACAO_TXT[r.acao] || r.acao, ref: r.ref || null, funcionario: r.funcionario || null, loja: r.loja == null ? null : r.loja, justificativa: r.justificativa || null, antes: r.antes === undefined ? null : r.antes, depois: r.depois === undefined ? null : r.depois, nota: r.nota || null, hash: r.hash.slice(0, 12) })) }; }

module.exports = { veLoja, DIR, P, CFG_PADRAO, MAX_LEGAL, TIPOS, PRORROGACAO, DESFECHOS, SITUACAO, TIPOS_OC, CLASSES, SIT_OC, ACAO_TXT, config, salvarConfig, podeVer, podeEditar, veSensivel, podeConfig, veAuditoria, ehRH, datas, situacaoDe, contratoDe, visaoContrato, alterarContrato, listarContratos, destaques,
  sincronizarPonto, registrarOcorrencia, decidirOcorrencia, ocorrenciasDe, indiciosDe, ficha, painel, pendencias, avisarPrazos, trilha, verificarCadeia, auditar, _util: { soma, diasEntre, hojeISO } };
