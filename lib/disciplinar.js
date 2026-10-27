'use strict';
// lib/disciplinar.js — Gestão Disciplinar (DP / RH › Gestão Disciplinar, 27/10/2026).
// Registro, análise, decisão, formalização e arquivamento das medidas disciplinares (advertência escrita e suspensão):
//   o GERENTE solicita → o RH analisa, define e formaliza (PDF) → a COORDENAÇÃO avalia os indeferimentos → o RH encaminha ao
//   JURÍDICO quando a Coordenação determina → o GERENTE comunica, colhe assinatura e devolve o documento digitalizado → o RH
//   confere e encerra → a DIRETORIA só acompanha. Tudo num único protocolo DISC-AAAA-NNNN com histórico auditado.
// Reaproveita a central de pessoas (lib/gestao-pessoas.js: designados, papéis, escopo por loja, notificações, auditoria),
// o cadastro do PontoCerto (lib/pontocerto.js, só leitura) e a logo vetorial dos PDFs (lib/logo-economico.js, pdfkit).
// Dados em data/disciplinar (gitignored, dado pessoal de acesso restrito): solicitacoes/<prot>.json, anexos/<prot>/, pdf/.
// NENHUMA decisão é automática: o sistema só valida campos, limites legais (art. 474 CLT) e transições por perfil.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const PDFDocument = require('pdfkit');
const LOGO = require('./logo-economico');
const GP = require('./gestao-pessoas');

const DIR = process.env.DISCIPLINAR_DIR || path.join(__dirname, '..', 'data', 'disciplinar');
const P = { sols: () => path.join(DIR, 'solicitacoes'), sol: p => path.join(DIR, 'solicitacoes', p + '.json'), anexos: p => path.join(DIR, 'anexos', p),
  pdf: (p, v) => path.join(DIR, 'pdf', p + '-v' + v + '.pdf'), config: () => path.join(DIR, 'config.json'), folha: () => path.join(DIR, 'folha.json') };
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400 }, extra || {});
const agoraIso = () => new Date().toISOString();
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const dataOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T12:00:00').getTime());
const dBR = s => s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '';
const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const txt = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max || 4000);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const dtTxt = iso => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Recife', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }

// ── Catálogos ────────────────────────────────────────────────────────────────
const MOTIVOS = { falta_injustificada: 'Falta injustificada', atrasos_recorrentes: 'Atrasos recorrentes', ausencia_ponto: 'Ausência de registro de ponto',
  normas_internas: 'Descumprimento de normas internas', desidia: 'Desídia', indisciplina: 'Indisciplina', insubordinacao: 'Insubordinação', conduta_inadequada: 'Conduta inadequada',
  orientacao_legitima: 'Descumprimento de orientação profissional legítima', outros: 'Outros' };
const MEDIDAS = { advertencia: 'Advertência escrita', suspensao: 'Suspensão disciplinar', nenhuma: 'Nenhuma medida disciplinar' };
const MEDIDAS_GERENTE = ['advertencia', 'suspensao'];
// Hipóteses legais de seleção assistida (referência, nunca enquadramento automático — art. 482 é parâmetro, não rótulo de falta grave)
const FUNDAMENTOS = {
  clt_2: { ref: 'Art. 2º da CLT', txt: 'Poder diretivo e disciplinar do empregador (art. 2º da CLT)' },
  clt_482_a: { ref: 'Art. 482, "a", CLT', txt: 'Ato de improbidade (art. 482, alínea "a", da CLT)' },
  clt_482_b: { ref: 'Art. 482, "b", CLT', txt: 'Incontinência de conduta ou mau procedimento (art. 482, alínea "b", da CLT)' },
  clt_482_e: { ref: 'Art. 482, "e", CLT', txt: 'Desídia no desempenho das respectivas funções (art. 482, alínea "e", da CLT)' },
  clt_482_f: { ref: 'Art. 482, "f", CLT', txt: 'Embriaguez habitual ou em serviço (art. 482, alínea "f", da CLT)' },
  clt_482_h: { ref: 'Art. 482, "h", CLT', txt: 'Ato de indisciplina ou de insubordinação (art. 482, alínea "h", da CLT)' },
  clt_482_j: { ref: 'Art. 482, "j", CLT', txt: 'Ato lesivo da honra ou da boa fama praticado no serviço contra qualquer pessoa, ou ofensas físicas (art. 482, alínea "j", da CLT)' },
  clt_482_k: { ref: 'Art. 482, "k", CLT', txt: 'Ato lesivo da honra ou da boa fama ou ofensas físicas contra o empregador e superiores hierárquicos (art. 482, alínea "k", da CLT)' },
  clt_474: { ref: 'Art. 474 da CLT', txt: 'Limite legal da suspensão disciplinar: superior a 30 dias consecutivos importa rescisão injusta (art. 474 da CLT)' },
  clt_473: { ref: 'Art. 473 da CLT', txt: 'Faltas justificáveis por lei — verificar antes de caracterizar falta injustificada (art. 473 da CLT)' },
  regulamento: { ref: 'Normas internas', txt: 'Descumprimento de norma interna / regulamento da empresa, de ciência comprovada do colaborador' },
  outra: { ref: 'Outra', txt: 'Outra fundamentação (descrever na justificativa técnica)' },
};
const STATUS_TXT = { rascunho: 'Rascunho', enviado_rh: 'Enviado ao RH', em_analise_rh: 'Em análise pelo RH', aguardando_esclarecimentos: 'Aguardando esclarecimentos',
  aguardando_coordenacao: 'Aguardando avaliação da Coordenação', devolvido_rh: 'Devolvido ao RH', juridico_solicitado: 'Encaminhamento jurídico solicitado', aguardando_parecer_juridico: 'Aguardando parecer jurídico',
  deferido_rh: 'Deferido pelo RH', indeferido_encerrado: 'Indeferido e encerrado', documento_gerado: 'Documento gerado', documento_encaminhado: 'Documento encaminhado ao gerente',
  aguardando_devolucao_assinada: 'Aguardando devolução assinada', aguardando_conferencia_rh: 'Aguardando conferência do RH', correcao_documental: 'Correção documental solicitada', concluido: 'Concluído', cancelado: 'Cancelado' };
const STATUS = Object.keys(STATUS_TXT);
const FINAIS = ['indeferido_encerrado', 'concluido', 'cancelado'];
// de quem é a bola em cada status (responsável atual, pra tabela e pro contador do menu)
const RESPONSAVEL = { rascunho: 'gerente', enviado_rh: 'rh', em_analise_rh: 'rh', aguardando_esclarecimentos: 'gerente', aguardando_coordenacao: 'coordenacao', devolvido_rh: 'rh',
  juridico_solicitado: 'rh', aguardando_parecer_juridico: 'juridico', deferido_rh: 'rh', indeferido_encerrado: null, documento_gerado: 'rh', documento_encaminhado: 'gerente',
  aguardando_devolucao_assinada: 'gerente', aguardando_conferencia_rh: 'rh', correcao_documental: 'gerente', concluido: null, cancelado: null };
const RESP_TXT = { gerente: 'Gerente da unidade', rh: 'RH', coordenacao: 'Coordenação Administrativa', juridico: 'Jurídico (via RH)' };
const PRAZO_POR_STATUS = { enviado_rh: 'rh_analise', em_analise_rh: 'rh_analise', devolvido_rh: 'rh_analise', aguardando_esclarecimentos: 'gerente_esclarecimento', aguardando_coordenacao: 'coordenacao',
  juridico_solicitado: 'rh_analise', aguardando_parecer_juridico: 'juridico', deferido_rh: 'rh_analise', documento_gerado: 'rh_analise', documento_encaminhado: 'gerente_aplicacao', aguardando_devolucao_assinada: 'gerente_aplicacao',
  correcao_documental: 'gerente_aplicacao', aguardando_conferencia_rh: 'rh_conferencia' };
const ACAO_TXT = { criar: 'Abriu a solicitação', editar: 'Editou o rascunho', complementar: 'Complementou a solicitação', anexar: 'Anexou evidência', enviar: 'Enviou ao RH', cancelar: 'Cancelou',
  analisar: 'Iniciou a análise técnica', esclarecer: 'Solicitou esclarecimentos ao gerente', responder: 'Respondeu ao pedido de esclarecimento', deferir: 'Deferiu (decisão técnica do RH)', indeferir: 'Propôs indeferimento à Coordenação',
  confirmar_indeferimento: 'Confirmou o indeferimento e encerrou', devolver_rh: 'Devolveu ao RH para reavaliação', solicitar_juridico: 'Determinou análise jurídica', encaminhar_juridico: 'Encaminhou ao jurídico',
  parecer_juridico: 'Registrou o parecer jurídico', emitir: 'Emitiu o documento e encaminhou ao gerente', reemitir: 'Reemitiu o documento (nova versão)', comunicar: 'Registrou a comunicação ao colaborador',
  anexar_assinado: 'Anexou o documento assinado', recusa: 'Registrou recusa de assinatura', conferir_aprovar: 'Conferiu o documento e concluiu', conferir_devolver: 'Devolveu ao gerente (correção documental)', conferir_folha: 'DP conferiu a pendência de folha' };
const ANEXO_CAT = { evidencia: 'Evidência', esclarecimento: 'Esclarecimento', juridico: 'Documento jurídico', assinado: 'Documento assinado', recusa: 'Registro de recusa', outro: 'Outro' };

// ── Configuração (limites, prazos, modelos de texto) ─────────────────────────
function configPadrao() {
  return { versao: 1, maxDiasSuspensao: 30, alertaDiasSuspensao: 5,
    prazos: { rh_analise: 5, gerente_esclarecimento: 3, coordenacao: 5, juridico: 10, gerente_aplicacao: 5, rh_conferencia: 3 },
    empresa: 'Econômico Supermercados', validadoJuridico: false, validadoPor: null, validadoEm: null,
    advertencia: {
      titulo: 'ADVERTÊNCIA DISCIPLINAR ESCRITA',
      comunicacao: 'Pela presente, {empresa} comunica formalmente ao(à) colaborador(a) acima identificado(a) a aplicação de ADVERTÊNCIA DISCIPLINAR ESCRITA, em razão da ocorrência descrita neste documento, com fundamento no poder diretivo e disciplinar do empregador e nas hipóteses legais indicadas, em caráter corretivo e educativo.',
      orientacoes: 'O(A) colaborador(a) fica orientado(a) a observar as normas internas da empresa, as orientações legítimas de seus superiores hierárquicos e os deveres inerentes ao contrato de trabalho, mantendo conduta compatível com o ambiente de trabalho e com as funções que exerce.',
      consequencias: 'A reincidência ou a prática de novas infrações poderá ensejar a aplicação de medidas disciplinares mais severas, inclusive suspensão disciplinar e, conforme a gravidade e o enquadramento legal de cada caso, a rescisão do contrato de trabalho por justa causa, nos termos do art. 482 da CLT.' },
    suspensao: {
      titulo: 'TERMO DE SUSPENSÃO DISCIPLINAR',
      comunicacao: 'Pela presente, {empresa} comunica formalmente ao(à) colaborador(a) acima identificado(a) a aplicação de SUSPENSÃO DISCIPLINAR pelo período abaixo indicado, em razão da ocorrência descrita neste documento, com fundamento no poder diretivo e disciplinar do empregador e nas hipóteses legais indicadas, em caráter corretivo e educativo.',
      orientacoes: 'Durante o período de suspensão o(a) colaborador(a) fica dispensado(a) do comparecimento ao trabalho, devendo retornar às suas atividades na data de retorno indicada, no horário habitual de sua escala. Qualquer impedimento ao retorno deverá ser comunicado imediatamente ao gestor da unidade.',
      efeitos: 'A suspensão disciplinar não gera direito à remuneração dos dias de afastamento nem ao respectivo descanso semanal remunerado, na forma da legislação trabalhista aplicável, observado o limite do art. 474 da CLT (suspensão superior a 30 dias consecutivos importa rescisão injusta do contrato). Os efeitos na folha de pagamento serão apurados e validados pelo Departamento Pessoal.' },
    nota: 'Documento emitido pelo módulo de Gestão Disciplinar da Central Inteligente de Gestão de Pessoas. O enquadramento legal é referência técnica do RH e não caracteriza, por si, falta grave. Modelo sujeito à validação do jurídico antes do uso em produção.' };
}
let cfgMem = null;
function config() { if (!cfgMem) cfgMem = { ...configPadrao(), ...lerJson(P.config(), {}) }; return cfgMem; }
function salvarConfig(mud, user) {
  const pu = permissoes(user); if (!pu.configurar && !(pu.juridico && Object.keys(mud).every(k => k === 'validadoJuridico'))) throw erro('Só RH e Coordenação alteram a configuração', 403);
  const c = { ...config() }; const campos = [];
  if (mud.maxDiasSuspensao != null) { const n = +mud.maxDiasSuspensao; if (!(n >= 1 && n <= 30)) throw erro('Limite de suspensão deve ficar entre 1 e 30 dias (art. 474 da CLT)'); c.maxDiasSuspensao = n; campos.push('maxDiasSuspensao'); }
  if (mud.alertaDiasSuspensao != null) { const n = +mud.alertaDiasSuspensao; if (!(n >= 1 && n <= c.maxDiasSuspensao)) throw erro('Alerta de revisão deve ficar entre 1 e o limite'); c.alertaDiasSuspensao = n; campos.push('alertaDiasSuspensao'); }
  if (mud.prazos && typeof mud.prazos === 'object') { c.prazos = { ...c.prazos }; for (const k of Object.keys(c.prazos)) if (mud.prazos[k] != null) { const n = +mud.prazos[k]; if (!(n >= 1 && n <= 60)) throw erro('Prazo inválido: ' + k); c.prazos[k] = n; } campos.push('prazos'); }
  if (typeof mud.empresa === 'string' && mud.empresa.trim()) { c.empresa = txt(mud.empresa, 120); campos.push('empresa'); }
  for (const doc of ['advertencia', 'suspensao']) if (mud[doc] && typeof mud[doc] === 'object') { c[doc] = { ...c[doc] }; for (const k of Object.keys(c[doc])) if (typeof mud[doc][k] === 'string' && mud[doc][k].trim()) c[doc][k] = txt(mud[doc][k], 3000); campos.push(doc); }
  if (typeof mud.nota === 'string') { c.nota = txt(mud.nota, 1000); campos.push('nota'); }
  if (mud.validadoJuridico != null) { if (!GP.temPapel(user, 'juridico', 'coordenacao')) throw erro('Só o Jurídico ou a Coordenação marcam o modelo como validado', 403); c.validadoJuridico = !!mud.validadoJuridico; c.validadoPor = c.validadoJuridico ? user.usuario : null; c.validadoEm = c.validadoJuridico ? agoraIso() : null; campos.push('validadoJuridico'); }
  if (campos.includes('advertencia') || campos.includes('suspensao')) { c.validadoJuridico = false; c.validadoPor = null; c.validadoEm = null; }   // texto mudou = precisa validar de novo
  c.versao = (c.versao || 1) + 1; gravarJson(P.config(), c); cfgMem = c;
  GP.auditar({ usuario: user.usuario, acao: 'disc_config', campos });
  return c;
}

// ── Permissões (sempre no servidor; reaproveita papéis e lojas da central de pessoas) ──
const RH = GP.RH;
const ehRh = u => GP.temPapel(u, ...RH);
function permissoes(user) {
  const p = GP.papeisDe(user || {});
  const gerencial = !!lojaGerencial(user); const ger = p.includes('gerente') || gerencial, rh = p.some(x => RH.includes(x)), coord = p.includes('coordenacao'), dir = p.includes('diretoria'), jur = p.includes('juridico');
  return { ver: ger || rh || coord || dir || jur, solicitar: ger, analisar: rh, coordenar: coord, juridico: jur, diretoria: dir && !ger && !rh && !coord,
    relatorios: rh || coord || dir, configurar: rh || coord, folha: GP.temPapel(user, 'rh_ponto') || rh || coord, papeis: p, gerencial };
}
// Perfil 'gerencial' (celular do gerente, lib/escopo.js) é gerente da loja do cadastro (loja_id) sem precisar de designação na central de pessoas
const lojaGerencial = u => { const n = u && u.perfil === 'gerencial' ? Number(u.loja_id) : 0; return GP.LOJAS.includes(n) ? n : null; };
const gerenteDa = (u, loja) => GP.gerenteDa(u, loja) || lojaGerencial(u) === +loja;
function lojasGerente(u) { const ls = GP.LOJAS.filter(l => GP.gerenteDa(u, l)); const g = lojaGerencial(u); if (g && !ls.includes(g)) ls.push(g); return ls; }
const veLoja = (u, loja) => GP.veLoja(u, loja) || gerenteDa(u, loja);
function podeVer(user, s) {
  const p = permissoes(user); if (!p.ver) return false;
  if (s.gerente && s.gerente.usuario === user.usuario) return true;
  if (p.juridico && s.juridico && (s.juridico.encaminhadoEm || s.juridico.solicitadoEm)) return true;
  if (p.diretoria || p.coordenar || p.analisar) return veLoja(user, s.loja);
  if (p.solicitar) return gerenteDa(user, s.loja);
  return false;
}

// ── Armazenamento ────────────────────────────────────────────────────────────
let solsMem = null;
function carregar() {
  if (solsMem) return solsMem; solsMem = new Map();
  try { for (const f of fs.readdirSync(P.sols())) if (/^DISC-\d{4}-\d{4,6}\.json$/.test(f)) { const s = lerJson(path.join(P.sols(), f), null); if (s && s.protocolo) solsMem.set(s.protocolo, s); } } catch (e) { /* pasta ainda não existe */ }
  return solsMem;
}
const todas = () => [...carregar().values()];
function obter(prot) { const s = carregar().get(String(prot || '').toUpperCase().trim()); if (!s) throw erro('Protocolo não encontrado', 404); return s; }
function gravar(s) { s.atualizadoEm = agoraIso(); s.versao = (s.versao || 0) + 1; gravarJson(P.sol(s.protocolo), s); carregar().set(s.protocolo, s); return s; }
function proximoProtocolo() { const ano = new Date().getFullYear(); const n = todas().filter(s => s.protocolo.startsWith('DISC-' + ano + '-')).reduce((m, s) => Math.max(m, +s.protocolo.split('-')[2] || 0), 0) + 1; return 'DISC-' + ano + '-' + String(n).padStart(4, '0'); }
function hist(s, user, acao, para, texto, extra) {
  const de = s.status; if (para) s.status = para;
  s.historico.push({ em: agoraIso(), usuario: user ? user.usuario : 'sistema', nome: user ? (user.nome || user.usuario) : 'Sistema', papeis: user ? (GP.papeisDe(user).length ? GP.papeisDe(user) : (lojaGerencial(user) ? ['gerente (celular)'] : [])) : [], acao, acaoTxt: ACAO_TXT[acao] || acao, de, para: para || de, texto: texto || null, ...(extra || {}) });
  if (para && para !== de) s.statusDesde = agoraIso();
  GP.auditar({ usuario: user ? user.usuario : 'sistema', acao: 'disc_' + acao, ref: s.protocolo, de, para: para || de });
}
function exigeAcao(s, user, acao, ...st) { if (st.length) exigeStatus(s, ...st); if (!acoes(user, s).includes(acao)) throw erro('Sem permissão para esta ação (' + (ACAO_TXT[acao] || acao).toLowerCase() + ')', 403); }
function exigeStatus(s, ...st) { if (!st.includes(s.status)) throw erro('Ação não permitida no status atual (' + STATUS_TXT[s.status] + '). Atualize a tela.', 409); }
const exigeTexto = (v, min, campo) => { const t = txt(v); if (t.length < (min || 10)) throw erro((campo || 'Texto') + ' é obrigatório (mínimo ' + (min || 10) + ' caracteres)'); return t; };

// ── Notificações (central de pessoas) ────────────────────────────────────────
function avisar(s, quem, texto) {
  let users = [];
  for (const q of quem) {
    if (q === 'gerente') users.push(s.gerente && s.gerente.usuario);
    else if (q === 'rh') users.push(...GP.usuariosPara(RH, s.loja));
    else users.push(...GP.usuariosPara([q], s.loja));
  }
  GP.notificar(users.filter(Boolean), '[Disciplinar ' + s.protocolo + '] ' + texto, s.protocolo);
}

// ── Prazos e resumo ──────────────────────────────────────────────────────────
function prazoDe(s) {
  const k = PRAZO_POR_STATUS[s.status]; if (!k) return null;
  const dias = config().prazos[k] || 5; const desde = s.statusDesde || s.atualizadoEm || s.criadoEm;
  const limite = somaDias(desde.slice(0, 10), dias); const hoje = hojeISO();
  const restam = Math.round((new Date(limite + 'T12:00:00') - new Date(hoje + 'T12:00:00')) / 86400000);
  return { limite, dias, restam, vencido: restam < 0, proximo: restam >= 0 && restam <= 1 };
}
function resumo(s, user) {
  const pr = prazoDe(s);
  return { protocolo: s.protocolo, status: s.status, statusTxt: STATUS_TXT[s.status], final: FINAIS.includes(s.status), loja: s.loja, lojaTxt: GP.LOJA_TXT[s.loja], colaborador: s.colaborador, gerente: s.gerente,
    motivo: s.ocorrencia.motivo, motivoTxt: MOTIVOS[s.ocorrencia.motivo], dataOcorrencia: s.ocorrencia.data, medidaSugerida: s.ocorrencia.medidaSugerida, medidaSugeridaTxt: MEDIDAS[s.ocorrencia.medidaSugerida],
    medidaDecidida: s.analise ? s.analise.medida : null, medidaDecididaTxt: s.analise ? MEDIDAS[s.analise.medida] : null, dias: s.analise ? s.analise.dias : null,
    responsavel: RESPONSAVEL[s.status], responsavelTxt: RESPONSAVEL[s.status] ? RESP_TXT[RESPONSAVEL[s.status]] : '—', responsavelNome: responsavelNome(s),
    criadoEm: s.criadoEm, enviadoEm: s.enviadoEm, atualizadoEm: s.atualizadoEm, concluidoEm: s.concluidoEm, dataAplicacao: s.aplicacao ? s.aplicacao.dataAplicacao : null, prazo: pr,
    documento: s.documento ? { versao: s.documento.versao, tipo: s.documento.tipo, emitidoEm: s.documento.emitidoEm } : null, anexos: (s.anexos || []).length, versao: s.versao,
    acoes: user ? acoes(user, s) : [] };
}
function responsavelNome(s) {
  const r = RESPONSAVEL[s.status]; if (!r) return null;
  if (r === 'gerente') return s.gerente.nome;
  if (r === 'rh' && s.analista) return s.analista.nome;
  return RESP_TXT[r];
}

// ── Ações permitidas (única fonte de verdade: a tela mostra o que vier daqui e o servidor recusa o resto) ──
function acoes(user, s) {
  const a = []; if (!user || !podeVer(user, s)) return a;
  const p = permissoes(user); if (p.diretoria) return [];
  const autor = s.gerente.usuario === user.usuario; const gerLoja = p.solicitar && gerenteDa(user, s.loja);
  const rh = p.analisar && GP.rhDa(user, s.loja); const coord = p.coordenar; const st = s.status;
  if ((autor || gerLoja) && st === 'rascunho') a.push('editar', 'enviar', 'cancelar');
  if ((autor || gerLoja) && !FINAIS.includes(st) && st !== 'rascunho') a.push('complementar', 'anexar');
  if ((autor || gerLoja) && st === 'enviado_rh') a.push('cancelar');
  if ((autor || gerLoja) && st === 'aguardando_esclarecimentos') a.push('responder');
  if ((autor || gerLoja) && ['documento_encaminhado', 'aguardando_devolucao_assinada', 'correcao_documental'].includes(st)) { if (st === 'documento_encaminhado') a.push('comunicar'); a.push('anexar_assinado', 'recusa'); }
  if (rh && st === 'enviado_rh') a.push('analisar');
  if (rh && ['em_analise_rh', 'devolvido_rh'].includes(st)) a.push('esclarecer', 'deferir', 'indeferir', 'previa');
  if (rh && st === 'juridico_solicitado') a.push('encaminhar_juridico');
  if ((rh || p.juridico) && st === 'aguardando_parecer_juridico') a.push('parecer_juridico');
  if (rh && st === 'deferido_rh') a.push('previa', 'emitir');
  if (rh && st === 'documento_gerado') a.push('emitir');
  if (rh && ['documento_encaminhado', 'aguardando_devolucao_assinada', 'correcao_documental'].includes(st)) a.push('reemitir');
  if (rh && st === 'aguardando_conferencia_rh') a.push('conferir_aprovar', 'conferir_devolver');
  if (coord && st === 'aguardando_coordenacao') a.push('confirmar_indeferimento', 'devolver_rh', 'solicitar_juridico');
  if ((rh || coord) && !FINAIS.includes(st) && st !== 'rascunho') a.push('cancelar');
  return [...new Set(a)];
}
// pendências que exigem ação do usuário logado (contador do menu): só as ações "de bola na mão", não cancelar/anexar
const ACOES_PENDENTES = ['enviar', 'responder', 'comunicar', 'anexar_assinado', 'analisar', 'deferir', 'encaminhar_juridico', 'parecer_juridico', 'emitir', 'conferir_aprovar', 'confirmar_indeferimento'];
function pendencias(user) {
  if (!permissoes(user).ver) return { n: 0 };
  let n = 0; for (const s of todas()) if (!FINAIS.includes(s.status) && acoes(user, s).some(x => ACOES_PENDENTES.includes(x))) n++;
  return { n };
}

// ── Colaborador (cadastro do PontoCerto, só leitura) ─────────────────────────
async function colaborador(id, deps) {
  const col = await deps.colaboradores();
  const c = col.ativos.find(x => String(x.id) === String(id)) || col.desligados.find(x => String(x.id) === String(id));
  if (!c) throw erro('Colaborador não encontrado no cadastro (PontoCerto)', 404);
  return { id: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo || '', setor: c.setor || '', loja: c.loja, lojaTxt: GP.LOJA_TXT[c.loja] || c.loja_nome || '', situacao: c.ativo ? (c.status_agora || 'Ativo') : 'Desligado', ativo: !!c.ativo, admissao: c.admissao || null, turno: c.turno || '' };
}
async function buscarColaboradores(user, q, loja, deps) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem acesso', 403);
  const col = await deps.colaboradores(); const n = semAcento(q || '').trim();
  return col.ativos.filter(c => veLoja(user, c.loja) && (!loja || +c.loja === +loja) && (!n || semAcento(c.nome).includes(n) || String(c.matricula || '').includes(n)))
    .slice(0, 40).map(c => ({ id: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo, setor: c.setor, loja: c.loja, lojaTxt: GP.LOJA_TXT[c.loja], situacao: c.status_agora || 'Ativo', admissao: c.admissao }));
}

// ── Histórico disciplinar do colaborador (penalidades aplicadas × registros administrativos) ──
const ehPenalidade = s => s.status === 'concluido' && s.analise && s.analise.medida !== 'nenhuma';
const ehAplicada = s => !!(s.aplicacao && s.aplicacao.dataAplicacao) && s.analise && s.analise.medida !== 'nenhuma' && !['cancelado', 'indeferido_encerrado'].includes(s.status);
function historicoColaborador(colabId, user, opts = {}) {
  const lista = todas().filter(s => String(s.colaborador.id) === String(colabId) && (opts.semPermissao || podeVer(user, s))).sort((a, b) => (b.ocorrencia.data || '').localeCompare(a.ocorrencia.data || '') || b.criadoEm.localeCompare(a.criadoEm));
  const item = s => ({ protocolo: s.protocolo, dataOcorrencia: s.ocorrencia.data, motivo: s.ocorrencia.motivo, motivoTxt: MOTIVOS[s.ocorrencia.motivo], medida: s.analise ? s.analise.medida : s.ocorrencia.medidaSugerida,
    medidaTxt: s.analise ? MEDIDAS[s.analise.medida] : MEDIDAS[s.ocorrencia.medidaSugerida] + ' (sugerida)', dias: s.analise ? s.analise.dias : null, status: s.status, statusTxt: STATUS_TXT[s.status],
    dataAplicacao: s.aplicacao ? s.aplicacao.dataAplicacao : null, concluidoEm: s.concluidoEm || null, documento: s.documento ? { versao: s.documento.versao, tipo: s.documento.tipo } : null, loja: s.loja,
    situacao: ehPenalidade(s) ? 'aplicada' : ehAplicada(s) ? 'aplicada_em_conferencia' : FINAIS.includes(s.status) ? 'nao_convertida' : 'em_andamento' });
  const penalidades = lista.filter(s => ehPenalidade(s) || ehAplicada(s)).map(item);
  const administrativas = lista.filter(s => !(ehPenalidade(s) || ehAplicada(s))).map(item);
  const doze = somaDias(hojeISO(), -365);
  return { colabId: +colabId, penalidades, administrativas, reincidente: penalidades.filter(x => (x.dataOcorrencia || '') >= doze).length >= 2, total: lista.length };
}
/** mesmo fato = mesmo colaborador + mesma data da ocorrência + mesmo motivo, em protocolo que não foi cancelado nem indeferido */
function mesmoFato(colabId, data, motivo, exceto) {
  return todas().filter(s => s.protocolo !== exceto && String(s.colaborador.id) === String(colabId) && s.ocorrencia.data === data && s.ocorrencia.motivo === motivo && !['cancelado', 'indeferido_encerrado'].includes(s.status))
    .map(s => ({ protocolo: s.protocolo, status: s.status, statusTxt: STATUS_TXT[s.status], medidaTxt: s.analise ? MEDIDAS[s.analise.medida] : MEDIDAS[s.ocorrencia.medidaSugerida] }));
}

// ── Solicitação (gerente) ────────────────────────────────────────────────────
function validarOcorrencia(b, parcial) {
  const o = {};
  if (!MOTIVOS[b.motivo]) throw erro('Motivo da ocorrência inválido'); o.motivo = b.motivo;
  if (!MEDIDAS_GERENTE.includes(b.medidaSugerida)) throw erro('Medida sugerida deve ser advertência escrita ou suspensão disciplinar'); o.medidaSugerida = b.medidaSugerida;
  if (!dataOk(b.data)) throw erro('Data da ocorrência inválida'); if (b.data > hojeISO()) throw erro('Data da ocorrência não pode ser futura'); o.data = b.data;
  o.hora = /^\d{2}:\d{2}$/.test(b.hora || '') ? b.hora : ''; o.local = txt(b.local, 160);
  o.descricao = parcial ? txt(b.descricao, 6000) : exigeTexto(b.descricao, 30, 'Descrição objetiva dos fatos');
  o.orientacoesAnteriores = txt(b.orientacoesAnteriores, 3000); o.justificativaColaborador = txt(b.justificativaColaborador, 3000); o.outras = txt(b.outras, 3000);
  if (o.motivo === 'outros' && !parcial && txt(b.motivoOutro).length < 3) throw erro('Descreva o motivo em "Outros"'); o.motivoOutro = txt(b.motivoOutro, 160);
  return o;
}
async function criar(user, body, deps) {
  const p = permissoes(user); if (!p.solicitar) throw erro('Só o gerente da unidade abre solicitação disciplinar', 403);
  const c = await colaborador(body.colabId, deps);
  if (!gerenteDa(user, c.loja)) throw erro('Colaborador de unidade fora do seu escopo (' + (GP.LOJA_TXT[c.loja] || c.loja) + ')', 403);
  if (!c.ativo) throw erro('Colaborador desligado: não cabe medida disciplinar');
  const oc = validarOcorrencia(body, body.rascunho === true);
  const dup = mesmoFato(c.id, oc.data, oc.motivo);
  if (dup.length && body.confirmarFatoDistinto !== true) throw erro('Já existe protocolo para este colaborador com a mesma data e o mesmo motivo (' + dup.map(d => d.protocolo).join(', ') + '). Não é permitida dupla punição pelo mesmo fato. Se for fato distinto, confirme e descreva a diferença.', 409, { duplicados: dup });
  const s = { protocolo: proximoProtocolo(), versao: 0, status: 'rascunho', loja: c.loja, colaborador: c, gerente: { usuario: user.usuario, nome: user.nome || user.usuario }, criadoEm: agoraIso(), statusDesde: agoraIso(),
    ocorrencia: oc, fatoDistinto: dup.length ? { protocolos: dup.map(d => d.protocolo), justificativa: exigeTexto(body.justificativaFatoDistinto, 10, 'Justificativa de fato distinto') } : null,
    anexos: [], complementos: [], esclarecimentos: [], analise: null, indeferimento: null, coordenacao: [], juridico: null, documento: null, documentos: [], aplicacao: null, conferencia: null, historico: [] };
  hist(s, user, 'criar', null, null, { snapshotHistorico: historicoColaborador(c.id, user, { semPermissao: true }).penalidades.length });
  gravar(s);
  if (body.rascunho !== true) enviar(s.protocolo, user);
  return obter(s.protocolo);
}
function editar(prot, user, body) {
  const s = obter(prot); exigeAcao(s, user, 'editar', 'rascunho'); s.ocorrencia = { ...s.ocorrencia, ...validarOcorrencia({ ...s.ocorrencia, ...body }, true) };
  hist(s, user, 'editar'); return gravar(s);
}
function enviar(prot, user) {
  const s = obter(prot); exigeAcao(s, user, 'enviar', 'rascunho'); validarOcorrencia(s.ocorrencia);   // rascunho pode estar incompleto; o envio não
  s.enviadoEm = agoraIso(); hist(s, user, 'enviar', 'enviado_rh'); gravar(s);
  avisar(s, ['rh'], 'Nova solicitação de ' + MEDIDAS[s.ocorrencia.medidaSugerida].toLowerCase() + ' — ' + s.colaborador.nome + ' (' + GP.LOJA_TXT[s.loja] + ')');
  return s;
}
/** complementação depois do envio: a solicitação original não muda; a complementação é identificada e auditada */
function complementar(prot, user, texto) {
  const s = obter(prot); exigeAcao(s, user, 'complementar');
  const t = exigeTexto(texto, 10, 'Complementação'); s.complementos.push({ em: agoraIso(), usuario: user.usuario, nome: user.nome || user.usuario, texto: t });
  hist(s, user, 'complementar', null, t); gravar(s); avisar(s, ['rh'], 'Gerente complementou a solicitação'); return s;
}
function registrarAnexos(prot, user, lista, categoria, texto) {
  const s = obter(prot); const cat = ANEXO_CAT[categoria] ? categoria : 'outro';
  const permitido = cat === 'assinado' || cat === 'recusa' ? acoes(user, s).includes('anexar_assinado') : cat === 'juridico' ? acoes(user, s).includes('encaminhar_juridico') || acoes(user, s).includes('parecer_juridico') : acoes(user, s).includes('anexar') || acoes(user, s).includes('responder') || (permissoes(user).analisar && GP.rhDa(user, s.loja) && !FINAIS.includes(s.status));
  if (!permitido) throw erro('Sem permissão para anexar neste protocolo', 403);
  if (!lista.length) throw erro('Nenhum arquivo recebido');
  for (const a of lista) s.anexos.push({ ...a, categoria: cat, em: agoraIso(), usuario: user.usuario, nome_usuario: user.nome || user.usuario, descricao: txt(texto, 300) });
  hist(s, user, 'anexar', null, (ANEXO_CAT[cat] + ': ' + lista.map(a => a.nome).join(', ')).slice(0, 300)); gravar(s); return s;
}
function cancelar(prot, user, motivo) {
  const s = obter(prot); exigeAcao(s, user, 'cancelar');
  const m = exigeTexto(motivo, 10, 'Justificativa do cancelamento');
  const tinhaSuspensao = !!(s.analise && s.analise.medida === 'suspensao' && s.documento);
  s.cancelamento = { em: agoraIso(), usuario: user.usuario, nome: user.nome || user.usuario, motivo: m, papeis: GP.papeisDe(user) };
  hist(s, user, 'cancelar', 'cancelado', m); gravar(s);
  if (tinhaSuspensao) folhaMarcarAjuste(s, 'Protocolo cancelado após emissão do termo de suspensão: verificar lançamento na folha');
  avisar(s, ['gerente', 'rh'], 'Protocolo cancelado: ' + m.slice(0, 120)); return s;
}

// ── Análise técnica do RH ────────────────────────────────────────────────────
function analisar(prot, user) { const s = obter(prot); exigeAcao(s, user, 'analisar', 'enviado_rh'); s.analista = { usuario: user.usuario, nome: user.nome || user.usuario }; hist(s, user, 'analisar', 'em_analise_rh'); return gravar(s); }
function esclarecer(prot, user, pergunta) {
  const s = obter(prot); exigeAcao(s, user, 'esclarecer');
  const t = exigeTexto(pergunta, 10, 'Pedido de esclarecimento'); s.esclarecimentos.push({ em: agoraIso(), por: user.usuario, nome: user.nome || user.usuario, pergunta: t, resposta: null, respondidoEm: null });
  s.retornoEsclarecimento = s.status; hist(s, user, 'esclarecer', 'aguardando_esclarecimentos', t); gravar(s); avisar(s, ['gerente'], 'RH pediu esclarecimentos: ' + t.slice(0, 120)); return s;
}
function responder(prot, user, resposta) {
  const s = obter(prot); exigeAcao(s, user, 'responder');
  const t = exigeTexto(resposta, 10, 'Resposta'); const e = [...s.esclarecimentos].reverse().find(x => !x.resposta); if (e) { e.resposta = t; e.respondidoEm = agoraIso(); e.respondidoPor = user.usuario; }
  hist(s, user, 'responder', s.retornoEsclarecimento || 'em_analise_rh', t); gravar(s); avisar(s, ['rh'], 'Gerente respondeu ao esclarecimento'); return s;
}
function validarAnalise(b, s) {
  const a = {}; if (!MEDIDAS[b.medida]) throw erro('Medida considerada cabível inválida'); a.medida = b.medida;
  const f = Array.isArray(b.fundamentos) ? b.fundamentos.filter(x => FUNDAMENTOS[x]) : []; if (a.medida !== 'nenhuma' && !f.length) throw erro('Selecione ao menos uma hipótese legal na fundamentação jurídica');
  a.fundamentos = f; a.fundamentoTexto = txt(b.fundamentoTexto, 2000); if (f.includes('outra') && a.fundamentoTexto.length < 10) throw erro('Descreva a outra fundamentação');
  a.justificativa = exigeTexto(b.justificativa, 30, 'Justificativa técnica (fatos, evidências e proporcionalidade)');
  if (a.medida !== s.ocorrencia.medidaSugerida && a.medida !== 'nenhuma' && a.justificativa.length < 30) throw erro('Medida diferente da sugerida pelo gerente exige justificativa');
  if (a.medida === 'suspensao') {
    const c = config(); const d = parseInt(b.dias, 10); if (!(d >= 1)) throw erro('Informe a quantidade de dias de suspensão');
    if (d > 30) throw erro('Suspensão acima de 30 dias consecutivos é vedada (art. 474 da CLT)');
    if (d > c.maxDiasSuspensao) throw erro('Suspensão acima do limite configurado (' + c.maxDiasSuspensao + ' dias). Revise com a Coordenação/Jurídico.');
    if (!dataOk(b.inicio)) throw erro('Informe a data de início da suspensão'); if (b.inicio < hojeISO()) throw erro('Início da suspensão não pode ser no passado');
    a.dias = d; a.inicio = b.inicio; a.termino = somaDias(b.inicio, d - 1); a.retorno = somaDias(a.termino, 1); a.revisaoRecomendada = d > c.alertaDiasSuspensao;
  } else { a.dias = null; a.inicio = a.termino = a.retorno = null; a.revisaoRecomendada = false; }
  a.orientacoesGerente = txt(b.orientacoesGerente, 2000);
  return a;
}
function deferir(prot, user, body) {
  const s = obter(prot); exigeAcao(s, user, 'deferir', 'em_analise_rh', 'devolvido_rh');
  const a = validarAnalise(body || {}, s);
  if (a.medida !== 'nenhuma') { const dup = mesmoFato(s.colaborador.id, s.ocorrencia.data, s.ocorrencia.motivo, s.protocolo).filter(d => ['concluido', 'documento_encaminhado', 'aguardando_devolucao_assinada', 'aguardando_conferencia_rh', 'correcao_documental', 'documento_gerado', 'deferido_rh'].includes(d.status)); if (dup.length && !s.fatoDistinto) throw erro('Já há medida deferida/aplicada pelo mesmo fato (' + dup.map(d => d.protocolo).join(', ') + '): dupla punição não é permitida', 409, { duplicados: dup }); }
  s.analise = { ...a, decididoEm: agoraIso(), por: user.usuario, nome: user.nome || user.usuario, medidaSugerida: s.ocorrencia.medidaSugerida, alterouMedida: a.medida !== s.ocorrencia.medidaSugerida, versaoAnalise: ((s.analise && s.analise.versaoAnalise) || 0) + 1 };
  s.analista = { usuario: user.usuario, nome: user.nome || user.usuario }; s.indeferimento = null;
  if (a.medida === 'nenhuma') {   // deferido sem medida = decisão técnica de não punir: encerra como concluído (sem documento), fica no histórico administrativo
    hist(s, user, 'deferir', 'concluido', 'Nenhuma medida disciplinar: ' + a.justificativa, { medida: a.medida }); s.concluidoEm = agoraIso(); gravar(s);
    avisar(s, ['gerente'], 'RH concluiu a análise sem medida disciplinar'); return s;
  }
  hist(s, user, 'deferir', 'deferido_rh', MEDIDAS[a.medida] + (a.dias ? ' · ' + a.dias + ' dia(s)' : '') + ' — ' + a.justificativa, { medida: a.medida, dias: a.dias, alterouMedida: s.analise.alterouMedida });
  return gravar(s);
}
function indeferir(prot, user, justificativa) {
  const s = obter(prot); exigeAcao(s, user, 'indeferir', 'em_analise_rh', 'devolvido_rh');
  const t = exigeTexto(justificativa, 30, 'Justificativa do indeferimento');
  s.indeferimento = { justificativa: t, em: agoraIso(), por: user.usuario, nome: user.nome || user.usuario, rodada: ((s.indeferimento && s.indeferimento.rodada) || 0) + 1 }; s.analista = { usuario: user.usuario, nome: user.nome || user.usuario };
  hist(s, user, 'indeferir', 'aguardando_coordenacao', t); gravar(s); avisar(s, ['coordenacao'], 'Proposta de indeferimento aguarda sua avaliação'); return s;
}

// ── Coordenação ──────────────────────────────────────────────────────────────
function coordenacao(prot, user, acao, texto) {
  const s = obter(prot); if (!['confirmar_indeferimento', 'devolver_rh', 'solicitar_juridico'].includes(acao)) throw erro('Ação inválida'); exigeAcao(s, user, acao, 'aguardando_coordenacao');
  const t = exigeTexto(texto, 10, 'Manifestação da Coordenação');
  s.coordenacao.push({ em: agoraIso(), por: user.usuario, nome: user.nome || user.usuario, acao, texto: t, rodada: s.indeferimento ? s.indeferimento.rodada : null });
  if (acao === 'confirmar_indeferimento') { s.concluidoEm = agoraIso(); hist(s, user, acao, 'indeferido_encerrado', t); gravar(s); avisar(s, ['gerente', 'rh'], 'Indeferimento confirmado pela Coordenação; processo encerrado'); }
  else if (acao === 'devolver_rh') { hist(s, user, acao, 'devolvido_rh', t); gravar(s); avisar(s, ['rh'], 'Coordenação devolveu para reavaliação: ' + t.slice(0, 120)); }
  else if (acao === 'solicitar_juridico') { s.juridico = { solicitadoEm: agoraIso(), solicitadoPor: user.usuario, motivo: t, encaminhadoEm: null, parecer: null, parecerEm: null, rodadas: ((s.juridico && s.juridico.rodadas) || 0) + 1 }; hist(s, user, acao, 'juridico_solicitado', t); gravar(s); avisar(s, ['rh'], 'Coordenação determinou encaminhamento ao jurídico: ' + t.slice(0, 120)); }
  else throw erro('Ação inválida');
  return s;
}
// ── Jurídico (sempre via RH) ─────────────────────────────────────────────────
function encaminharJuridico(prot, user, texto) {
  const s = obter(prot); exigeAcao(s, user, 'encaminhar_juridico', 'juridico_solicitado');
  const t = exigeTexto(texto, 10, 'Resumo do que foi encaminhado'); s.juridico.encaminhadoEm = agoraIso(); s.juridico.encaminhadoPor = user.usuario; s.juridico.resumo = t;
  hist(s, user, 'encaminhar_juridico', 'aguardando_parecer_juridico', t); gravar(s); avisar(s, ['juridico'], 'Caso encaminhado para parecer jurídico'); return s;
}
function parecerJuridico(prot, user, texto, dataParecer) {
  const s = obter(prot); exigeAcao(s, user, 'parecer_juridico', 'aguardando_parecer_juridico');
  const t = exigeTexto(texto, 20, 'Parecer jurídico'); s.juridico.parecer = t; s.juridico.parecerEm = agoraIso(); s.juridico.parecerData = dataOk(dataParecer) ? dataParecer : hojeISO(); s.juridico.registradoPor = user.usuario;
  (s.pareceres = s.pareceres || []).push({ ...s.juridico });
  hist(s, user, 'parecer_juridico', 'devolvido_rh', t); gravar(s); avisar(s, ['rh', 'coordenacao'], 'Parecer jurídico recebido; RH faz nova análise'); return s;
}

// ── Documento (PDF) ──────────────────────────────────────────────────────────
const A4 = { w: 595.28, h: 841.89 }, ML = 48, MR = 48, CW = A4.w - ML - MR;
const NAVY = '#14213D', SEC = '#E6ECF4', LINE = '#CFD7E2', INK = '#1B2030', GRAY = '#5A6372', WHITE = '#FFFFFF';
/** quebra de página explícita: se o próximo bloco (h pontos) não cabe, abre página nova (o rodapé é desenhado depois em todas) */
// margens reais no pdfkit: a quebra automática no meio de um parágrafo longo para ANTES do rodapé (bottom), não em cima dele
const PAGINA = { size: 'A4', margins: { top: 48, bottom: 52, left: ML, right: MR } };   // bottom 52 = começo do rodapé (nota em A4.h-48)
function quebra(doc, y, h) { if (y + h > A4.h - 70) { doc.addPage(PAGINA); return 56; } return y; }
function secao(doc, y, titulo, semQuebra) { if (!semQuebra) y = quebra(doc, y, 60); doc.rect(ML, y, CW, 18).fill(SEC); doc.font('Helvetica-Bold').fontSize(9.3).fillColor(NAVY).text(titulo, ML + 10, y + 4.5, { width: CW - 20, lineBreak: false }); return y + 18; }
function linha(doc, y, rotulo, valor) {
  y = quebra(doc, y, 32); doc.font('Helvetica-Bold').fontSize(9.3).fillColor(INK).text(rotulo, ML + 10, y + 4, { width: 130, lineBreak: false });
  doc.font('Helvetica').fontSize(9.3).fillColor(INK).text(String(valor || '—'), ML + 145, y + 4, { width: CW - 155, lineGap: 1 });
  const h = Math.max(15, doc.y - y + 2); doc.moveTo(ML + 6, y + h).lineTo(ML + CW - 6, y + h).lineWidth(0.4).stroke(LINE); return y + h;
}
function paragrafo(doc, texto, y, empresa, opts) {
  y = quebra(doc, y, 44); const partes = String(texto).split('{empresa}'); doc.fontSize((opts && opts.size) || 9.3).fillColor(INK);
  // o pdfkit descarta o espaço no início de um segmento "continued": o espaço depois do nome da empresa vai junto com ele
  partes.forEach((p, i) => { const ultimo = i === partes.length - 1; const txtP = i === 0 ? p : p.replace(/^\s+/, ''); doc.font((opts && opts.font) || 'Helvetica').text(txtP, i === 0 ? ML + 10 : undefined, i === 0 ? y : undefined, { width: CW - 20, align: 'justify', lineGap: 1.5, continued: !ultimo }); if (!ultimo) doc.font('Helvetica-BoldOblique').text(empresa + (/^\s/.test(partes[i + 1]) ? ' ' : ''), { width: CW - 20, align: 'justify', lineGap: 1.5, continued: true }); });
  return doc.y;
}
/** local/data + assinaturas + recusa com testemunhas: bloco indivisível (~150 pt); se não cabe acima do rodapé, vai inteiro pra página seguinte */
function assinaturas(doc, y) {
  if (y + 126 > A4.h - 52) { doc.addPage(PAGINA); y = 56; }   // bloco inteiro acima da margem inferior (senão o pdfkit abre página sozinho no meio)
  doc.font('Helvetica-Bold').fontSize(9.3).fillColor(INK).text('Local e data:', ML + 10, y, { lineBreak: false }); doc.font('Helvetica').text('__________________________, ______ / ______ / __________', ML + 80, y, { lineBreak: false }); y += 28;
  const w = (CW - 40) / 2; [['Assinatura do colaborador', ML + 10], ['Assinatura do gestor da unidade', ML + 30 + w]].forEach(([t, x]) => { doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.8).stroke(INK); doc.font('Helvetica').fontSize(8.3).fillColor(GRAY).text(t, x, y + 3, { width: w, align: 'center', lineBreak: false }); }); y += 18;
  y = secao(doc, y, 'RECUSA DE ASSINATURA (preencher somente se houver)', true); y += 4;
  doc.font('Helvetica').fontSize(8.6).fillColor(INK).text('O(A) colaborador(a) tomou ciência do conteúdo deste documento, lido na presença das testemunhas abaixo, e recusou-se a assiná-lo em ______ / ______ / __________ .', ML + 10, y, { width: CW - 20, align: 'justify', lineGap: 1.2 }); y = doc.y + 16;
  for (let i = 0; i < 2; i++) { const x = i === 0 ? ML + 10 : ML + 30 + w; doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.8).stroke(INK); doc.font('Helvetica').fontSize(7.8).fillColor(GRAY).text('Testemunha ' + (i + 1) + ' — nome, CPF e assinatura', x, y + 3, { width: w, align: 'center', lineBreak: false }); }
  return y + 14;
}
function desenharDocumento(doc, s, ctx) {
  const c = config(); const a = s.analise; const m = c[a.medida]; let y = 24;
  const hLogo = LOGO.desenhar(doc, ML, y, 78);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('DEPARTAMENTO PESSOAL · GESTÃO DISCIPLINAR', ML + 200, y + 8, { width: CW - 200, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(GRAY).text(c.empresa, ML + 200, y + 21, { width: CW - 200, align: 'right', lineBreak: false });
  doc.text(ctx.previa ? 'Prévia — documento não emitido' : 'Protocolo ' + s.protocolo + ' · versão ' + ctx.versao, ML + 200, y + 33, { width: CW - 200, align: 'right', lineBreak: false });
  doc.text((ctx.previa ? 'Gerado em ' : 'Emitido em ') + ctx.emitidoTxt + ' por ' + ctx.usuarioNome, ML + 200, y + 45, { width: CW - 200, align: 'right', lineBreak: false });
  y += hLogo + 4; doc.moveTo(ML, y).lineTo(ML + CW, y).lineWidth(1.4).stroke(NAVY); y += 8;
  doc.rect(ML, y, CW, 26).fill(NAVY); doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text(m.titulo, ML, y + 7.5, { width: CW, align: 'center', lineBreak: false }); y += 32;
  // identificação do documento numa faixa só (protocolo · unidade · data de emissão), igual ao protótipo aprovado
  doc.font('Helvetica-Bold').fontSize(9.2).fillColor(INK).text('Protocolo: ', ML + 10, y, { continued: true }).font('Helvetica').text(s.protocolo + '      ', { continued: true }).font('Helvetica-Bold').text('Unidade: ', { continued: true }).font('Helvetica').text(GP.LOJA_TXT[s.loja] + '      ', { continued: true }).font('Helvetica-Bold').text('Data de emissão: ', { continued: true }).font('Helvetica').text(ctx.emitidoTxt.slice(0, 10)); y = doc.y + 6;
  y = secao(doc, y, 'IDENTIFICAÇÃO DO COLABORADOR'); y = linha(doc, y, 'Nome', s.colaborador.nome); y = linha(doc, y, 'Matrícula', s.colaborador.matricula || '—'); y = linha(doc, y, 'Cargo · Setor', (s.colaborador.cargo || '—') + ' · ' + (s.colaborador.setor || '—')); y += 5;
  y = secao(doc, y, 'DESCRIÇÃO DA OCORRÊNCIA'); y += 4;
  const o = s.ocorrencia; const cab = 'Em ' + dBR(o.data) + (o.hora ? ', às ' + o.hora : '') + (o.local ? ', em ' + o.local : '') + ' — motivo: ' + MOTIVOS[o.motivo] + (o.motivoOutro ? ' (' + o.motivoOutro + ')' : '') + '.';
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(cab, ML + 10, y, { width: CW - 20, lineGap: 1.5 }); y = doc.y + 3;
  y = paragrafo(doc, o.descricao, y, c.empresa) + 3;
  if (o.orientacoesAnteriores) { doc.font('Helvetica-Bold').fontSize(9).text('Orientações anteriores: ', ML + 10, y, { continued: true, width: CW - 20 }); doc.font('Helvetica').text(o.orientacoesAnteriores, { width: CW - 20, align: 'justify', lineGap: 1.5 }); y = doc.y + 3; }
  if (o.justificativaColaborador) { doc.font('Helvetica-Bold').fontSize(9).text('Justificativa apresentada pelo colaborador: ', ML + 10, y, { continued: true, width: CW - 20 }); doc.font('Helvetica').text(o.justificativaColaborador, { width: CW - 20, align: 'justify', lineGap: 1.5 }); y = doc.y + 3; }
  y += 6; y = secao(doc, y, 'FUNDAMENTAÇÃO LEGAL'); y += 5;
  const fund = a.fundamentos.map(f => FUNDAMENTOS[f].txt).join('; ') + (a.fundamentoTexto ? '. ' + a.fundamentoTexto : '') + '.';
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(fund, ML + 10, y, { width: CW - 20, align: 'justify', lineGap: 2 }); y = doc.y + 3;
  y += 5;   // a justificativa técnica do RH fica no protocolo (auditável), não no documento entregue ao colaborador
  y = secao(doc, y, a.medida === 'suspensao' ? 'COMUNICAÇÃO DA SUSPENSÃO' : 'COMUNICAÇÃO DA ADVERTÊNCIA'); y += 5; y = paragrafo(doc, m.comunicacao, y, c.empresa) + 6;
  if (a.medida === 'suspensao') {
    y = secao(doc, y, 'PERÍODO DA SUSPENSÃO'); y = linha(doc, y, 'Quantidade de dias', a.dias + ' (' + (a.dias === 1 ? 'um dia' : a.dias + ' dias') + ') — dias corridos'); y = linha(doc, y, 'Início', dBR(a.inicio)); y = linha(doc, y, 'Término', dBR(a.termino)); y = linha(doc, y, 'Retorno ao trabalho', dBR(a.retorno)); y += 6;
  }
  y = secao(doc, y, 'ORIENTAÇÕES'); y += 4; y = paragrafo(doc, m.orientacoes, y, c.empresa) + 5;
  y = secao(doc, y, a.medida === 'suspensao' ? 'EFEITOS REMUNERATÓRIOS' : 'CONSEQUÊNCIAS DE NOVAS INFRAÇÕES'); y += 4; y = paragrafo(doc, a.medida === 'suspensao' ? m.efeitos : m.consequencias, y, c.empresa) + 8;
  y = assinaturas(doc, y);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i); doc.page.margins.bottom = 0;   // rodapé fica abaixo da margem do corpo: sem isso o pdfkit abriria página nova
    doc.font('Helvetica').fontSize(7.3).fillColor(GRAY);
    doc.text((ctx.previa ? 'PRÉVIA · não emitido' : s.protocolo + ' · v' + ctx.versao + ' · emitido em ' + ctx.emitidoTxt + ' por ' + ctx.usuarioNome) + ' · ' + c.empresa + ' · página ' + (i - range.start + 1) + '/' + range.count, ML, A4.h - 30, { width: CW, align: 'center', lineBreak: false });
    doc.fontSize(6.8).text(c.nota, ML, A4.h - 48, { width: CW, align: 'center', lineGap: 0 });
    if (ctx.previa) { doc.save(); doc.rotate(-32, { origin: [A4.w / 2, A4.h / 2] }); doc.fillOpacity(0.09).font('Helvetica-Bold').fontSize(96).fillColor('#C22F49').text('PRÉVIA', 0, A4.h / 2 - 60, { width: A4.w, align: 'center', lineBreak: false }); doc.restore(); }
  }
}
function gerarPdf(s, ctx) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ ...PAGINA, bufferPages: true, info: { Title: (ctx.previa ? 'Prévia · ' : '') + MEDIDAS[s.analise.medida] + ' · ' + s.protocolo, Author: config().empresa, Subject: 'Medida disciplinar · ' + s.colaborador.nome, Creator: 'Econômico Relatórios · Gestão Disciplinar' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    desenharDocumento(doc, s, ctx); doc.end();
  });
}
async function previa(prot, user, body) {
  const s = obter(prot); exigeAcao(s, user, 'previa');
  const base = { ...s }; if (body && body.medida) base.analise = validarAnalise(body, s); else if (!s.analise) throw erro('Preencha a análise técnica para ver a prévia');
  if (base.analise.medida === 'nenhuma') throw erro('"Nenhuma medida" não gera documento');
  return gerarPdf(base, { previa: true, versao: ((s.documento && s.documento.versao) || 0) + 1, emitidoTxt: dtTxt(agoraIso()), usuarioNome: user.nome || user.usuario });
}
async function emitir(prot, user, body) {
  const s0 = obter(prot); const reemissao = acoes(user, s0).includes('reemitir') && !acoes(user, s0).includes('emitir');
  if (!acoes(user, s0).includes('emitir') && !reemissao) throw erro('Sem permissão para emitir', 403);
  if (reemissao) exigeTexto(body && body.motivo, 10, 'Motivo da reemissão');
  const versao = ((s0.documento && s0.documento.versao) || 0) + 1; const em = agoraIso();
  const pdf = await gerarPdf(s0, { previa: false, versao, emitidoTxt: dtTxt(em), usuarioNome: user.nome || user.usuario });
  const s = obter(prot); if (s.versao !== s0.versao) throw erro('O protocolo mudou enquanto o documento era gerado. Atualize a tela e tente de novo.', 409);   // clique repetido / duas abas
  fs.mkdirSync(path.dirname(P.pdf(prot, versao)), { recursive: true }); fs.writeFileSync(P.pdf(prot, versao), pdf);
  const d = { versao, tipo: s.analise.medida, arquivo: 'pdf/' + prot + '-v' + versao + '.pdf', bytes: pdf.length, hash: crypto.createHash('sha256').update(pdf).digest('hex'), emitidoEm: em, por: user.usuario, nome: user.nome || user.usuario, modeloValidado: !!config().validadoJuridico, motivo: reemissao ? txt(body.motivo, 300) : null, orientacoes: txt(body && body.orientacoes, 2000) || (s.analise.orientacoesGerente || '') };
  s.documento = d; s.documentos.push(d); s.aplicacao = null; s.conferencia = null;
  hist(s, user, reemissao ? 'reemitir' : 'emitir', 'documento_encaminhado', reemissao ? d.motivo : MEDIDAS[d.tipo] + ' v' + versao, { versaoDoc: versao, de2: 'documento_gerado' });
  gravar(s); avisar(s, ['gerente'], 'Documento disciplinar disponível para aplicação: ' + MEDIDAS[d.tipo] + ' — ' + s.colaborador.nome); return s;
}
function arquivoPdf(prot, user, versao) {
  const s = obter(prot); if (!podeVer(user, s)) throw erro('Sem acesso a este protocolo', 403);
  const v = versao ? +versao : (s.documento && s.documento.versao); const d = s.documentos.find(x => x.versao === v); if (!d) throw erro('Documento não emitido', 404);
  const f = P.pdf(prot, v); if (!fs.existsSync(f)) throw erro('Arquivo do documento não está mais no servidor', 410);
  GP.auditar({ usuario: user.usuario, acao: 'disc_pdf', ref: prot, versao: v });
  return { caminho: f, nome: prot + '-' + (d.tipo === 'suspensao' ? 'suspensao' : 'advertencia') + '-v' + v + '.pdf', doc: d };
}

// ── Aplicação pelo gerente ───────────────────────────────────────────────────
function comunicar(prot, user, body) {
  const s = obter(prot); exigeAcao(s, user, 'comunicar', 'documento_encaminhado');
  const data = dataOk(body.data) ? body.data : hojeISO(); if (data > hojeISO()) throw erro('Data da comunicação não pode ser futura');
  s.aplicacao = { comunicadoEm: agoraIso(), dataAplicacao: data, por: user.usuario, nome: user.nome || user.usuario, observacao: txt(body.observacao, 1000), assinado: null, recusa: null, anexo: null };
  hist(s, user, 'comunicar', 'aguardando_devolucao_assinada', 'Comunicado ao colaborador em ' + dBR(data)); return gravar(s);
}
function devolverAssinado(prot, user, anexos, body, recusa) {
  const s = obter(prot); exigeAcao(s, user, recusa ? 'recusa' : 'anexar_assinado', 'documento_encaminhado', 'aguardando_devolucao_assinada', 'correcao_documental');
  if (!anexos.length) throw erro('Envie o documento digitalizado (foto, scanner ou PDF)');
  const data = dataOk(body.data) ? body.data : (s.aplicacao && s.aplicacao.dataAplicacao) || hojeISO(); if (data > hojeISO()) throw erro('Data de aplicação não pode ser futura');
  const ap = s.aplicacao || { comunicadoEm: agoraIso(), por: user.usuario, nome: user.nome || user.usuario };
  ap.dataAplicacao = data; ap.devolvidoEm = agoraIso(); ap.devolvidoPor = user.usuario; ap.devolvidoNome = user.nome || user.usuario; ap.versaoDoc = s.documento.versao;
  for (const a of anexos) s.anexos.push({ ...a, categoria: recusa ? 'recusa' : 'assinado', em: agoraIso(), usuario: user.usuario, nome_usuario: user.nome || user.usuario, versaoDoc: s.documento.versao });
  ap.anexo = anexos[anexos.length - 1].arquivo;
  if (recusa) { const t = exigeTexto(body.testemunhas, 5, 'Nome das testemunhas'); ap.assinado = false; ap.recusa = { em: agoraIso(), testemunhas: t, observacao: txt(body.observacao, 1000) }; }
  else { ap.assinado = true; ap.recusa = null; ap.observacao = txt(body.observacao, 1000) || ap.observacao; }
  s.aplicacao = ap; s.conferencia = null;
  hist(s, user, recusa ? 'recusa' : 'anexar_assinado', 'aguardando_conferencia_rh', recusa ? 'Recusa de assinatura · testemunhas: ' + ap.recusa.testemunhas : 'Documento assinado devolvido (' + anexos.map(a => a.nome).join(', ') + ')');
  gravar(s); avisar(s, ['rh'], recusa ? 'Gerente registrou recusa de assinatura; aguarda conferência' : 'Documento assinado enviado; aguarda conferência'); return s;
}

// ── Conferência do RH e encerramento ─────────────────────────────────────────
function conferir(prot, user, aprovar, texto, motivoDevolucao) {
  const s = obter(prot); exigeAcao(s, user, aprovar ? 'conferir_aprovar' : 'conferir_devolver', 'aguardando_conferencia_rh');
  if (aprovar) {
    s.conferencia = { em: agoraIso(), por: user.usuario, nome: user.nome || user.usuario, resultado: 'aprovado', texto: txt(texto, 1000) }; s.concluidoEm = agoraIso();
    hist(s, user, 'conferir_aprovar', 'concluido', s.conferencia.texto || 'Documento conferido'); gravar(s);
    if (s.analise.medida === 'suspensao') folhaRegistrar(s);
    avisar(s, ['gerente'], 'Processo concluído: ' + MEDIDAS[s.analise.medida] + ' conferida pelo RH');
  } else {
    const t = exigeTexto(texto, 10, 'Justificativa da devolução'); const mot = ['nova_digitalizacao', 'complementacao', 'inconsistencia'].includes(motivoDevolucao) ? motivoDevolucao : 'inconsistencia';
    s.conferencia = { em: agoraIso(), por: user.usuario, nome: user.nome || user.usuario, resultado: 'devolvido', motivo: mot, texto: t }; (s.conferencias = s.conferencias || []).push(s.conferencia);
    hist(s, user, 'conferir_devolver', 'correcao_documental', ({ nova_digitalizacao: 'Nova digitalização', complementacao: 'Complementação', inconsistencia: 'Inconsistência' })[mot] + ': ' + t); gravar(s);
    avisar(s, ['gerente'], 'Documento devolvido na conferência: ' + t.slice(0, 120));
  }
  return s;
}

// ── Integração com o Departamento Pessoal (suspensão aplicada → pendência de folha) ──
let folhaMem = null;
const folha = () => { if (!folhaMem) folhaMem = lerJson(P.folha(), []); return folhaMem; };
const salvarFolha = () => gravarJson(P.folha(), folhaMem || []);
function folhaRegistrar(s) {
  if (folha().some(f => f.protocolo === s.protocolo && f.status !== 'ajuste_necessario')) return;   // nunca duplica
  folha().push({ protocolo: s.protocolo, colaborador: { id: s.colaborador.id, nome: s.colaborador.nome, matricula: s.colaborador.matricula }, loja: s.loja, inicio: s.analise.inicio, termino: s.analise.termino, retorno: s.analise.retorno, dias: s.analise.dias,
    dataAplicacao: s.aplicacao.dataAplicacao, criadoEm: agoraIso(), status: 'pendente', conferencia: null, historico: [{ em: agoraIso(), texto: 'Suspensão conferida pelo RH; pendência de conferência na folha' }] });
  salvarFolha(); GP.notificar(GP.usuariosPara(['rh_ponto'], s.loja), '[Disciplinar ' + s.protocolo + '] Suspensão aplicada (' + s.analise.dias + ' d, ' + dBR(s.analise.inicio) + ' a ' + dBR(s.analise.termino) + '): conferir na folha', s.protocolo);
}
function folhaMarcarAjuste(s, texto) { const f = folha().find(x => x.protocolo === s.protocolo); if (!f) return; f.status = 'ajuste_necessario'; f.historico.push({ em: agoraIso(), texto }); salvarFolha(); GP.notificar(GP.usuariosPara(['rh_ponto'], s.loja), '[Disciplinar ' + s.protocolo + '] ' + texto, s.protocolo); }
function folhaListar(user, q = {}) {
  if (!permissoes(user).folha) throw erro('Sem acesso às pendências de folha', 403);
  return folha().filter(f => veLoja(user, f.loja)).filter(f => !q.status || f.status === q.status).filter(f => !q.loja || +f.loja === +q.loja).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)).map(f => ({ ...f, lojaTxt: GP.LOJA_TXT[f.loja] }));
}
async function folhaPonto(prot, user, deps) {
  if (!permissoes(user).folha) throw erro('Sem acesso', 403); const f = folha().find(x => x.protocolo === prot); if (!f) throw erro('Pendência não encontrada', 404);
  const hoje = hojeISO(); if (f.inicio > hoje) return { protocolo: prot, aindaNaoComecou: true, dias: [] };
  const j = await deps.jornadaPeriodo(f.colaborador.id, f.inicio, f.termino < hoje ? f.termino : hoje);
  const dias = j.dias.map(d => ({ data: d.data, situacao: d.situacao, situacaoTxt: d.situacaoTxt, marcacoes: (d.marcacoes || []).length, previsto: d.previsto ? (d.previsto.entrada + '–' + d.previsto.saida) : null, trabalhou: (d.marcacoes || []).length > 0 }));
  return { protocolo: prot, dias, alerta: dias.some(d => d.trabalhou) ? 'Há marcação de ponto dentro do período de suspensão: verificar antes de lançar' : null };
}
function folhaConferir(prot, user, body) {
  if (!permissoes(user).folha) throw erro('Sem acesso', 403); const f = folha().find(x => x.protocolo === prot); if (!f) throw erro('Pendência não encontrada', 404);
  if (!veLoja(user, f.loja)) throw erro('Unidade fora do seu escopo', 403); if (f.status === 'conferido') throw erro('Já conferido');
  const t = exigeTexto(body.texto, 5, 'Observação da conferência'); const r = ['lancado', 'nao_lancar', 'ajustado'].includes(body.resultado) ? body.resultado : 'lancado';
  f.status = 'conferido'; f.conferencia = { em: agoraIso(), por: user.usuario, nome: user.nome || user.usuario, resultado: r, texto: t }; f.historico.push({ em: agoraIso(), texto: 'Conferido pelo DP (' + r + '): ' + t });
  salvarFolha(); const s = carregar().get(prot); if (s) { hist(s, user, 'conferir_folha', null, t, { resultado: r }); gravar(s); }
  return f;
}

// ── Listagem, painel e detalhe ───────────────────────────────────────────────
function listar(user, q = {}) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem acesso à Gestão Disciplinar', 403);
  const n = semAcento(q.q || '').trim(); const lim = Math.min(+q.limite || 500, 2000);
  return todas().filter(s => podeVer(user, s))
    .filter(s => !q.loja || +s.loja === +q.loja).filter(s => !q.status || s.status === q.status).filter(s => !q.motivo || s.ocorrencia.motivo === q.motivo)
    .filter(s => !q.medida || (s.analise ? s.analise.medida : s.ocorrencia.medidaSugerida) === q.medida).filter(s => !q.colab || String(s.colaborador.id) === String(q.colab))
    .filter(s => !q.matricula || String(s.colaborador.matricula) === String(q.matricula)).filter(s => !q.responsavel || RESPONSAVEL[s.status] === q.responsavel || (s.analista && s.analista.usuario === q.responsavel))
    .filter(s => !q.ocorrenciaDe || s.ocorrencia.data >= q.ocorrenciaDe).filter(s => !q.ocorrenciaAte || s.ocorrencia.data <= q.ocorrenciaAte)
    .filter(s => !q.de || s.criadoEm.slice(0, 10) >= q.de).filter(s => !q.ate || s.criadoEm.slice(0, 10) <= q.ate)
    .filter(s => !q.abertas || !FINAIS.includes(s.status))
    .filter(s => !n || s.protocolo.toLowerCase().includes(n) || semAcento(s.colaborador.nome).includes(n) || String(s.colaborador.matricula || '').includes(n))
    .sort((a, b) => (b.atualizadoEm || b.criadoEm).localeCompare(a.atualizadoEm || a.criadoEm)).slice(0, lim).map(s => resumo(s, user));
}
function painel(user, q = {}) {
  const lista = listar(user, { ...q, status: q.status || '', limite: 2000 });
  const cont = f => lista.filter(f).length;
  const ind = { abertas: cont(s => !s.final), aguardando_rh: cont(s => ['enviado_rh', 'em_analise_rh', 'devolvido_rh'].includes(s.status)), aguardando_esclarecimentos: cont(s => s.status === 'aguardando_esclarecimentos'),
    deferidas: cont(s => s.medidaDecidida && s.medidaDecidida !== 'nenhuma' && !['cancelado', 'indeferido_encerrado'].includes(s.status)), aguardando_coordenacao: cont(s => s.status === 'aguardando_coordenacao'),
    aguardando_juridico: cont(s => ['juridico_solicitado', 'aguardando_parecer_juridico'].includes(s.status)), documentos_encaminhados: cont(s => s.status === 'documento_encaminhado'),
    aguardando_devolucao: cont(s => ['aguardando_devolucao_assinada', 'correcao_documental'].includes(s.status)), aguardando_conferencia: cont(s => s.status === 'aguardando_conferencia_rh'), concluidos: cont(s => s.status === 'concluido'),
    indeferidos: cont(s => s.status === 'indeferido_encerrado'), vencidos: cont(s => s.prazo && s.prazo.vencido) };
  return { indicadores: ind, lista: q.status ? lista.filter(s => s.status === q.status) : lista, minhas: lista.filter(s => s.acoes.some(a => ACOES_PENDENTES.includes(a))).length };
}
function detalhe(prot, user) {
  const s = obter(prot); if (!podeVer(user, s)) throw erro('Sem acesso a este protocolo', 403);
  const p = permissoes(user); const hc = historicoColaborador(s.colaborador.id, user, { semPermissao: p.analisar || p.coordenar || p.diretoria });
  return { ...s, ...resumo(s, user), historicoColaborador: { penalidades: hc.penalidades.filter(x => x.protocolo !== s.protocolo), administrativas: hc.administrativas.filter(x => x.protocolo !== s.protocolo), reincidente: hc.reincidente },
    anexos: (s.anexos || []).map(a => ({ ...a, categoriaTxt: ANEXO_CAT[a.categoria] })), limites: { maxDias: config().maxDiasSuspensao, alertaDias: config().alertaDiasSuspensao }, modeloValidado: !!config().validadoJuridico };
}
function anexo(prot, user, arquivo) {
  const s = obter(prot); if (!podeVer(user, s)) throw erro('Sem acesso', 403);
  const a = (s.anexos || []).find(x => x.arquivo === arquivo); if (!a) throw erro('Anexo não encontrado', 404);
  const f = path.join(P.anexos(prot), a.arquivo); if (!fs.existsSync(f)) throw erro('Arquivo não está mais no servidor', 410);
  GP.auditar({ usuario: user.usuario, acao: 'disc_anexo', ref: prot, arquivo: a.arquivo }); return { caminho: f, nome: a.nome, tipo: a.tipo };
}

// ── Relatórios gerenciais (sem ranking punitivo de colaboradores) ────────────
function relatorio(user, q = {}) {
  if (!permissoes(user).relatorios) throw erro('Relatórios: só RH, Coordenação e Diretoria', 403);
  const L = todas().filter(s => podeVer(user, s)).filter(s => !q.loja || +s.loja === +q.loja).filter(s => !q.motivo || s.ocorrencia.motivo === q.motivo).filter(s => !q.status || s.status === q.status)
    .filter(s => !q.medida || (s.analise ? s.analise.medida : s.ocorrencia.medidaSugerida) === q.medida).filter(s => !q.de || s.criadoEm.slice(0, 10) >= q.de).filter(s => !q.ate || s.criadoEm.slice(0, 10) <= q.ate);
  const aplic = s => ehPenalidade(s); const horas = (a, b) => a && b ? (new Date(b) - new Date(a)) / 3600000 : null;
  const tempos = L.filter(s => s.enviadoEm && s.analise && s.analise.decididoEm).map(s => horas(s.enviadoEm, s.analise.decididoEm)).concat(L.filter(s => s.enviadoEm && s.indeferimento && !s.analise).map(s => horas(s.enviadoEm, s.indeferimento.em)));
  const porLoja = {}; for (const l of GP.LOJAS) if (veLoja(user, l)) porLoja[l] = { loja: l, lojaTxt: GP.LOJA_TXT[l], total: 0, advertencias: 0, suspensoes: 0, indeferidas: 0, abertas: 0 };
  for (const s of L) { const r = porLoja[s.loja]; if (!r) continue; r.total++; if (aplic(s)) { if (s.analise.medida === 'advertencia') r.advertencias++; else r.suspensoes++; } if (s.status === 'indeferido_encerrado') r.indeferidas++; if (!FINAIS.includes(s.status)) r.abertas++; }
  const porMes = {}; for (const s of L) { const m = s.criadoEm.slice(0, 7); porMes[m] = porMes[m] || { mes: m, total: 0, advertencias: 0, suspensoes: 0, indeferidas: 0 }; porMes[m].total++; if (aplic(s)) porMes[m][s.analise.medida === 'advertencia' ? 'advertencias' : 'suspensoes']++; if (s.status === 'indeferido_encerrado') porMes[m].indeferidas++; }
  const porMotivo = {}; for (const s of L) { const k = s.ocorrencia.motivo; porMotivo[k] = porMotivo[k] || { motivo: k, motivoTxt: MOTIVOS[k], total: 0, aplicadas: 0 }; porMotivo[k].total++; if (aplic(s)) porMotivo[k].aplicadas++; }
  const porColab = {}; for (const s of L.filter(aplic)) porColab[s.colaborador.id] = (porColab[s.colaborador.id] || 0) + 1;
  return { periodo: { de: q.de || null, ate: q.ate || null }, totais: { solicitacoes: L.length, advertencias: L.filter(s => aplic(s) && s.analise.medida === 'advertencia').length, suspensoes: L.filter(s => aplic(s) && s.analise.medida === 'suspensao').length,
      indeferimentos: L.filter(s => s.status === 'indeferido_encerrado').length, devolvidas: L.filter(s => s.coordenacao.some(c => c.acao === 'devolver_rh') || (s.conferencias || []).length).length, juridico: L.filter(s => s.juridico).length,
      reincidencias: Object.values(porColab).filter(n => n >= 2).length, tempoMedioAnaliseHoras: tempos.length ? Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length) : null,
      pendentesAssinatura: L.filter(s => ['documento_encaminhado', 'aguardando_devolucao_assinada', 'correcao_documental'].includes(s.status)).length, pendentesConferencia: L.filter(s => s.status === 'aguardando_conferencia_rh').length, abertas: L.filter(s => !FINAIS.includes(s.status)).length },
    porLoja: Object.values(porLoja), porMes: Object.values(porMes).sort((a, b) => a.mes.localeCompare(b.mes)), porMotivo: Object.values(porMotivo).sort((a, b) => b.total - a.total),
    linhas: L.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)).map(s => resumo(s)) };
}
async function relatorioXlsx(user, q) {
  const ExcelJS = require('exceljs'); const r = relatorio(user, q); const wb = new ExcelJS.Workbook(); wb.creator = 'Econômico Relatórios';
  const w1 = wb.addWorksheet('Resumo'); w1.addRow(['Indicador', 'Valor']); for (const [k, v] of Object.entries(r.totais)) w1.addRow([k, v == null ? '' : v]);
  const w2 = wb.addWorksheet('Por unidade'); w2.addRow(['Unidade', 'Total', 'Advertências', 'Suspensões', 'Indeferidas', 'Abertas']); for (const l of r.porLoja) w2.addRow([l.lojaTxt, l.total, l.advertencias, l.suspensoes, l.indeferidas, l.abertas]);
  const w3 = wb.addWorksheet('Evolução mensal'); w3.addRow(['Mês', 'Total', 'Advertências', 'Suspensões', 'Indeferidas']); for (const m of r.porMes) w3.addRow([m.mes, m.total, m.advertencias, m.suspensoes, m.indeferidas]);
  const w4 = wb.addWorksheet('Por motivo'); w4.addRow(['Motivo', 'Total', 'Aplicadas']); for (const m of r.porMotivo) w4.addRow([m.motivoTxt, m.total, m.aplicadas]);
  const w5 = wb.addWorksheet('Protocolos'); w5.addRow(['Protocolo', 'Colaborador', 'Matrícula', 'Unidade', 'Motivo', 'Medida solicitada', 'Medida decidida', 'Dias', 'Status', 'Data ocorrência', 'Aberto em', 'Aplicação', 'Concluído em', 'Responsável atual']);
  for (const s of r.linhas) w5.addRow([s.protocolo, s.colaborador.nome, s.colaborador.matricula, s.lojaTxt, s.motivoTxt, s.medidaSugeridaTxt, s.medidaDecididaTxt || '', s.dias || '', s.statusTxt, dBR(s.dataOcorrencia), dBR(s.criadoEm.slice(0, 10)), dBR(s.dataAplicacao), s.concluidoEm ? dBR(s.concluidoEm.slice(0, 10)) : '', s.responsavelTxt]);
  for (const w of wb.worksheets) { w.getRow(1).font = { bold: true }; w.columns.forEach(c => { c.width = 18; }); }
  return wb.xlsx.writeBuffer();
}
function relatorioPdf(user, q) {
  const r = relatorio(user, q);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: 'Relatório · Gestão Disciplinar', Creator: 'Econômico Relatórios' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    let y = 36; const hLogo = LOGO.desenhar(doc, ML, y, 100); doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('Relatório gerencial · Gestão Disciplinar', ML + 180, y + 10, { width: CW - 180, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text('Período: ' + (r.periodo.de ? dBR(r.periodo.de) : 'início') + ' a ' + (r.periodo.ate ? dBR(r.periodo.ate) : 'hoje') + ' · gerado em ' + dtTxt(agoraIso()) + ' por ' + (user.nome || user.usuario), ML + 180, y + 30, { width: CW - 180, align: 'right' });
    y += hLogo + 12;
    const tabela = (titulo, cab, linhas, larg) => {
      if (y > A4.h - 120) { doc.addPage({ size: 'A4', margin: 0 }); y = 50; }
      y = secao(doc, y, titulo) + 4; let x = ML + 6; doc.font('Helvetica-Bold').fontSize(8.2).fillColor(INK); cab.forEach((c, i) => { doc.text(c, x, y, { width: larg[i], lineBreak: false }); x += larg[i]; }); y += 13;
      for (const l of linhas) { if (y > A4.h - 70) { doc.addPage({ size: 'A4', margin: 0 }); y = 50; } x = ML + 6; doc.font('Helvetica').fontSize(8.2).fillColor(INK); l.forEach((c, i) => { doc.text(String(c == null ? '' : c), x, y, { width: larg[i] - 4, lineBreak: false }); x += larg[i]; }); y += 12; doc.moveTo(ML + 6, y - 2).lineTo(ML + CW - 6, y - 2).lineWidth(0.3).stroke(LINE); }
      y += 10;
    };
    const T = r.totais; tabela('INDICADORES', ['Indicador', 'Valor'], [['Total de solicitações', T.solicitacoes], ['Advertências aplicadas', T.advertencias], ['Suspensões aplicadas', T.suspensoes], ['Indeferimentos', T.indeferimentos], ['Solicitações devolvidas', T.devolvidas], ['Casos encaminhados ao jurídico', T.juridico], ['Reincidências (2+ medidas no período)', T.reincidencias], ['Tempo médio de análise (h)', T.tempoMedioAnaliseHoras == null ? '—' : T.tempoMedioAnaliseHoras], ['Documentos pendentes de assinatura', T.pendentesAssinatura], ['Documentos pendentes de conferência', T.pendentesConferencia]], [300, 100]);
    tabela('COMPARATIVO ENTRE UNIDADES', ['Unidade', 'Total', 'Advert.', 'Susp.', 'Indef.', 'Abertas'], r.porLoja.map(l => [l.lojaTxt, l.total, l.advertencias, l.suspensoes, l.indeferidas, l.abertas]), [200, 60, 60, 60, 60, 60]);
    tabela('EVOLUÇÃO MENSAL', ['Mês', 'Total', 'Advert.', 'Susp.', 'Indef.'], r.porMes.map(m => [m.mes, m.total, m.advertencias, m.suspensoes, m.indeferidas]), [120, 70, 70, 70, 70]);
    tabela('POR MOTIVO', ['Motivo', 'Total', 'Aplicadas'], r.porMotivo.map(m => [m.motivoTxt, m.total, m.aplicadas]), [300, 80, 80]);
    const range = doc.bufferedPageRange(); for (let i = range.start; i < range.start + range.count; i++) { doc.switchToPage(i); doc.font('Helvetica').fontSize(7.3).fillColor(GRAY).text('Gestão Disciplinar · relatório gerencial · sem ranking individual de colaboradores · página ' + (i - range.start + 1) + '/' + range.count, ML, A4.h - 30, { width: CW, align: 'center', lineBreak: false }); }
    doc.end();
  });
}

// ── Prazos: aviso automático quando o prazo está vencendo (roda 1×/h a partir do server.js) ──
function avisarPrazos() {
  let n = 0;
  for (const s of todas()) {
    if (FINAIS.includes(s.status) || s.status === 'rascunho') continue; const pr = prazoDe(s); if (!pr || !pr.proximo) continue;
    const chave = s.status + '@' + (s.statusDesde || ''); if (s.avisoPrazo === chave) continue;
    s.avisoPrazo = chave; gravar(s); const r = RESPONSAVEL[s.status]; avisar(s, [r === 'juridico' ? 'rh' : r], 'Prazo de atendimento vence em ' + dBR(pr.limite) + ' (' + STATUS_TXT[s.status] + ')'); n++;
  }
  return n;
}

function recarregar() { solsMem = null; cfgMem = null; folhaMem = null; }
module.exports = { DIR, P, MOTIVOS, MEDIDAS, MEDIDAS_GERENTE, FUNDAMENTOS, STATUS, STATUS_TXT, FINAIS, RESPONSAVEL, RESP_TXT, ACAO_TXT, ANEXO_CAT, ACOES_PENDENTES,
  config, salvarConfig, permissoes, podeVer, acoes, pendencias, lojasGerente, veLoja, gerenteDa, obter, listar, painel, detalhe, resumo, anexo, buscarColaboradores, historicoColaborador, mesmoFato,
  criar, editar, enviar, complementar, registrarAnexos, cancelar, analisar, esclarecer, responder, deferir, indeferir, coordenacao, encaminharJuridico, parecerJuridico,
  previa, emitir, arquivoPdf, comunicar, devolverAssinado, conferir, folhaListar, folhaPonto, folhaConferir, relatorio, relatorioXlsx, relatorioPdf, avisarPrazos, recarregar, _util: { hojeISO, somaDias, prazoDe } };
