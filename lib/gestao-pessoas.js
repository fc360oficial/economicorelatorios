'use strict';
// Central de Gestão de Pessoas (DP / RH › Gestão de Pessoas) — regras e dados. 21/10/2026.
// Base: "Prompt master — Central Inteligente de Gestão de Pessoas" que o Tiago colou em 21/10 ("cria outra aba,
// depois vejo se mudo o que já existe"): RH e DP antigos (rh.html/dp.html) ficam intactos.
// Integração "VR" = PontoCerto/Pontomais (lib/pontocerto.js). Aqui só LEMOS o ponto: nada é escrito de volta,
// nenhum desconto ou compensação é automático, nenhum registro original de ponto é alterado.
// Mesmo desenho do Canal de Ética (lib/etica.js): JSON em data/gestao-pessoas, todo acesso a disco neste módulo
// (camada de dados pra migrar pra banco depois), papéis por designação, permissões checadas AQUI (servidor).
//   config.json                  designados (papéis + lojas), limites, prazos, quadro autorizado, checklist
//   solicitacoes/<PROT>.json     solicitações (planos de ação, escala, quadro, movimentações) com histórico
//   alertas.json                 alertas de banco de horas (um aberto por colaborador e sentido; evolução)
//   ocorrencias.json             ocorrências de ponto (uma por colaborador+dia+tipo)
//   documentos.json · atendimentos.json   pendências documentais e atendimento assistido
//   saldos/AAAA-MM-DD.json       foto diária dos saldos (base das comparações semanais)
//   relatorios/AAAA-MM-DD.json   relatório semanal congelado (sexta)
//   notificacoes.jsonl · auditoria/AAAA-MM.jsonl · sync.json
// Fluxo obrigatório: GERENTE → RH → COORDENAÇÃO ADMINISTRATIVA → EXECUÇÃO → MONITORAMENTO. Diretoria só consulta.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.GP_DIR || path.join(__dirname, '..', 'data', 'gestao-pessoas');
const P = {
  config: () => path.join(DIR, 'config.json'),
  sols: () => path.join(DIR, 'solicitacoes'),
  sol: p => path.join(DIR, 'solicitacoes', p + '.json'),
  alertas: () => path.join(DIR, 'alertas.json'),
  ocorrencias: () => path.join(DIR, 'ocorrencias.json'),
  documentos: () => path.join(DIR, 'documentos.json'),
  atendimentos: () => path.join(DIR, 'atendimentos.json'),
  saldos: () => path.join(DIR, 'saldos'),
  saldo: d => path.join(DIR, 'saldos', d + '.json'),
  relatorios: () => path.join(DIR, 'relatorios'),
  relatorio: d => path.join(DIR, 'relatorios', d + '.json'),
  notificacoes: () => path.join(DIR, 'notificacoes.jsonl'),
  auditoria: d => path.join(DIR, 'auditoria', String(d).slice(0, 7) + '.jsonl'),
  sync: () => path.join(DIR, 'sync.json'),
};

// ── Catálogos ────────────────────────────────────────────────────────────────
const LOJAS = [1, 2, 3, 4, 5, 6, 10];
const LOJA_TXT = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão', 10: 'CD · Centro de Distribuição' };
const PAPEIS = {
  gerente: 'Gerente de unidade', rh_ponto: 'RH · Controle de Ponto', rh_doc: 'RH · Documentação', rh_adm: 'RH · Admissões',
  coordenacao: 'Coordenação Administrativa', diretoria: 'Diretoria (consulta)', juridico: 'Jurídico', ti: 'Tecnologia da Informação',
  financeiro: 'Financeiro (validação bancária e pagamentos)',   // 23/10/2026: Cadastro Bancário + Pagamentos de Domingos e Feriados
  cpd: 'CPD da unidade (envio de documentos — Gestão Documental)',   // 28/10/2026: designar com as lojas da unidade; só envia, nunca valida
};
const RH = ['rh_ponto', 'rh_doc', 'rh_adm'];
const STATUS = ['rascunho', 'enviado_rh', 'em_analise_rh', 'devolvido', 'validado_rh', 'aguardando_coordenacao', 'aprovado', 'rejeitado', 'em_execucao', 'concluido', 'vencido', 'cancelado'];
const STATUS_TXT = { rascunho: 'Rascunho', enviado_rh: 'Enviado ao RH', em_analise_rh: 'Em análise pelo RH', devolvido: 'Devolvido para correção', validado_rh: 'Validado pelo RH',
  aguardando_coordenacao: 'Aguardando Coordenação', aprovado: 'Aprovado', rejeitado: 'Rejeitado', em_execucao: 'Em execução', concluido: 'Concluído', vencido: 'Vencido', cancelado: 'Cancelado' };
const FINAIS = ['rejeitado', 'concluido', 'cancelado'];
const RESULTADOS = { cumprido: 'Cumprido', parcial: 'Cumprido em parte', nao_cumprido: 'Não cumprido' };
// Tipos de solicitação. `rh` = papel do RH que faz a análise técnica. Campos alimentam o formulário da tela.
const C = (k, label, tipo, obrig, extra) => ({ k, label, tipo: tipo || 'text', obrig: !!obrig, ...(extra || {}) });
const TIPOS = {
  plano_bh: { nome: 'Plano de ação · banco de horas', curto: 'Plano de ação', rh: 'rh_ponto', fimCampo: 'fim', campos: [
    C('colab', 'Funcionário', 'colab', true), C('justificativa', 'Justificativa do saldo', 'textarea', true, { col: 3 }), C('medida', 'Medida proposta', 'textarea', true, { col: 3 }),
    C('inicio', 'Data de início', 'date', true), C('fim', 'Conclusão prevista', 'date', true), C('horas_planejadas', 'Horas planejadas (h)', 'number', true, { step: '0.5' }),
    C('impacto', 'Impacto na operação', 'textarea', false, { col: 2 }), C('responsavel_execucao', 'Responsável pela execução', 'text', true)] },
  alteracao_escala: { nome: 'Alteração de escala', curto: 'Escala', rh: 'rh_ponto', fimCampo: 'fim', campos: [
    C('colab', 'Funcionário', 'colab', true), C('escala_atual', 'Escala atual', 'text'), C('escala_nova', 'Escala proposta', 'text', true),
    C('inicio', 'A partir de', 'date', true), C('fim', 'Até (vazio = definitiva)', 'date'), C('motivo', 'Motivo', 'textarea', true, { col: 3 })] },
  reposicao: { nome: 'Reposição de funcionário', curto: 'Reposição', rh: 'rh_adm', admissao: true, campos: [
    C('setor', 'Setor', 'setor', true), C('cargo', 'Função', 'text', true), C('quantidade', 'Quantidade', 'number', true),
    C('substituido', 'Quem está sendo reposto', 'text', false, { col: 2 }), C('data_desejada', 'Para quando', 'date'), C('motivo', 'Motivo', 'textarea', true, { col: 3 })] },
  ampliacao: { nome: 'Ampliação de quadro', curto: 'Ampliação', rh: 'rh_adm', admissao: true, campos: [
    C('setor', 'Setor', 'setor', true), C('cargo', 'Função', 'text', true), C('quantidade', 'Quantidade', 'number', true),
    C('justificativa', 'Justificativa', 'textarea', true, { col: 3 }), C('impacto', 'Impacto esperado', 'textarea', false, { col: 3 })] },
  transferencia: { nome: 'Transferência entre unidades', curto: 'Transferência', rh: 'rh_adm', campos: [
    C('colab', 'Funcionário', 'colab', true), C('loja_destino', 'Unidade de destino', 'loja', true), C('setor_destino', 'Setor de destino', 'setor'),
    C('data', 'A partir de', 'date', true), C('motivo', 'Motivo', 'textarea', true, { col: 3 })] },
  lotacao: { nome: 'Alteração de lotação (setor)', curto: 'Lotação', rh: 'rh_adm', campos: [
    C('colab', 'Funcionário', 'colab', true), C('setor_destino', 'Novo setor', 'setor', true), C('data', 'A partir de', 'date'), C('motivo', 'Motivo', 'textarea', true, { col: 3 })] },
  movimentacao: { nome: 'Outra movimentação de pessoal', curto: 'Movimentação', rh: 'rh_adm', campos: [
    C('colab', 'Funcionário', 'colab'), C('data', 'Data', 'date'), C('descricao', 'O que é pedido', 'textarea', true, { col: 3 })] },
};
const OC_TIPOS = { sem_marcacao: 'Dia sem marcação', atraso: 'Atraso na entrada', he_nao_planejada: 'Hora extra não planejada', trabalho_folga: 'Trabalho em dia de folga/feriado', falha_coletiva: 'Possível falha de registro na unidade' };
const OC_STATUS = { aberta: 'Aguardando justificativa', justificada: 'Justificada · análise do RH', encaminhada: 'Na Coordenação', regularizada: 'Regularizada', decidida: 'Decidida pela Coordenação' };
const OC_ABERTAS = ['aberta', 'justificada', 'encaminhada'];
const DOC_TIPOS = ['Documento admissional', 'Assinatura', 'Atualização cadastral', 'Termo', 'Comunicado', 'Outro'];
const DOC_STATUS = { pendente: 'Pendente', recebido: 'Recebido', assinado: 'Assinado', concluido: 'Concluído', cancelado: 'Cancelado' };
const AT_STATUS = { solicitado: 'Solicitado', agendado: 'Agendado', realizado: 'Realizado', encaminhado_rh: 'Encaminhado ao RH', cancelado: 'Cancelado' };
const CHECKLIST_PADRAO = ['RG e CPF', 'Comprovante de residência', 'Carteira de trabalho digital', 'Título de eleitor', 'Certidão de nascimento/casamento', 'Certidão dos filhos e vacinação (< 7 anos)',
  'Exame admissional (ASO)', 'Dados bancários', 'Foto 3x4', 'Contrato de trabalho assinado', 'Acordo de compensação/banco de horas assinado', 'Termo de ciência do regulamento interno'];

// ── Utilidades ───────────────────────────────────────────────────────────────
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const agoraIso = (d = new Date()) => new Date(d).toISOString();
const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function aleatorio(n) { const b = crypto.randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += ALFA[b[i] % ALFA.length]; return s; }
function gravarJson(arq, obj) { fs.mkdirSync(path.dirname(arq), { recursive: true }); const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, arq); }
function lerJson(arq, padrao) { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; } }
function appendLinha(arq, obj) { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.appendFileSync(arq, JSON.stringify(obj) + '\n'); }
function lerLinhas(arq) { try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } }
const diaISO = (d = new Date()) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return diaISO(d); };
// dias úteis = segunda a sábado (varejo); domingo não conta
function somaDu(iso, n) { let d = iso; let k = 0; while (k < n) { d = somaDias(d, 1); if (new Date(d + 'T12:00:00').getDay() !== 0) k++; } return d; }
function proximoDiaSemana(iso, dow) { let d = iso; for (let i = 0; i < 7; i++) { if (new Date(d + 'T12:00:00').getDay() === dow) return d; d = somaDias(d, 1); } return d; }
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
const hhmm = min => { const s = min < 0 ? '-' : '+', a = Math.abs(Math.round(min || 0)); return s + String(Math.floor(a / 60)).padStart(2, '0') + 'h' + String(a % 60).padStart(2, '0'); };
const minutos = s => { const m = String(s || '').match(/^(-?)(\d+):(\d{2})/); if (!m) return 0; const v = (+m[2]) * 60 + (+m[3]); return m[1] ? -v : v; };
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 2000);

// ── Config ───────────────────────────────────────────────────────────────────
let cfgMem = null;
function configPadrao() {
  return { designados: [],
    limites: { positivoMin: 600, negativoMin: 600 },               // +10h00 / −10h00: alerta só ACIMA/ABAIXO (10h00 exato = no limite)
    prazos: { justificativaDu: 2, analiseRhDu: 2, coordenacaoDu: 2, planoDiaSemana: 5, admissaoDias: 15, documentoDias: 5 },
    // atrasoMin 10 = tolerância da CLT (art. 58 §1º: 5 min por marcação, 10 no dia). falhaColetiva: dados reais de 21/10 —
    // E4 com 46 de 51 "sem marcação" nos mesmos dias = equipamento/registro, não 46 faltas. inicio = primeira data
    // considerada (gravada na 1ª sincronização como "ontem", pra não despejar o histórico; a Coordenação pode recuar).
    ponto: { diasVarredura: 7, extraAlertaMin: 120, atrasoMin: 10, reincidenciaQtd: 3, reincidenciaDias: 30, falhaColetivaPct: 40, falhaColetivaMin: 5, inicio: null },
    quadro: {},                                                     // { "<loja>|<SETOR>": n } — quadro autorizado
    checklistAdmissional: CHECKLIST_PADRAO, versao: 1, alteracoes: [] };
}
function config() {
  if (cfgMem) return cfgMem;
  const c = lerJson(P.config(), null); const pad = configPadrao();
  cfgMem = c ? { ...pad, ...c, limites: { ...pad.limites, ...(c.limites || {}) }, prazos: { ...pad.prazos, ...(c.prazos || {}) }, ponto: { ...pad.ponto, ...(c.ponto || {}) } } : pad;
  return cfgMem;
}
function salvarConfig(mudancas, user) {
  const c = config(); mudancas = mudancas || {};
  const campos = Object.keys(mudancas);
  const DE_COORD = ['limites', 'prazos', 'ponto', 'quadro', 'checklistAdmissional', 'designados'];
  for (const k of campos) if (!DE_COORD.includes(k)) throw erro('Campo de configuração não permitido: ' + k);
  if (!temPapel(user, 'coordenacao') && !(bootstrapPermitido(user) && campos.every(k => k === 'designados'))) throw erro('Só a Coordenação Administrativa altera parâmetros e designações', 403);
  if (mudancas.limites) { const l = mudancas.limites; if (!(l.positivoMin > 0) || !(l.negativoMin > 0)) throw erro('Limites precisam ser maiores que zero'); mudancas.limites = { positivoMin: Math.round(+l.positivoMin), negativoMin: Math.round(+l.negativoMin) }; }
  if (mudancas.prazos) { for (const [k, v] of Object.entries(mudancas.prazos)) if (!(+v >= 0)) throw erro('Prazo inválido: ' + k); mudancas.prazos = { ...c.prazos, ...mudancas.prazos }; }
  if (mudancas.ponto) mudancas.ponto = { ...c.ponto, ...mudancas.ponto };
  if (mudancas.quadro) { const q = {}; for (const [k, v] of Object.entries(mudancas.quadro)) { const m = String(k).match(/^(\d+)\|(.+)$/); if (!m || !LOJAS.includes(+m[1])) throw erro('Chave de quadro inválida: ' + k); if (v === null || v === '') continue; if (!(+v >= 0)) throw erro('Quadro inválido em ' + k); q[+m[1] + '|' + semAcento(m[2])] = Math.round(+v); } mudancas.quadro = q; }
  if (mudancas.designados) {
    if (!Array.isArray(mudancas.designados)) throw erro('Designados inválidos');
    mudancas.designados = mudancas.designados.map(d => {
      const papeis = (d.papeis || []).filter(p => PAPEIS[p]); const lojas = (d.lojas || []).map(Number).filter(n => LOJAS.includes(n));
      if (!d.usuario || !papeis.length) throw erro('Cada designado precisa de usuário e pelo menos um papel');
      if (papeis.includes('gerente') && !lojas.length) throw erro('Gerente ' + d.usuario + ' precisa de pelo menos uma unidade');
      if (papeis.includes('diretoria') && papeis.some(p => p !== 'diretoria')) throw erro('Diretoria é perfil exclusivamente de consulta: não acumula outro papel (' + d.usuario + ')');
      return { usuario: String(d.usuario), nome: txt(d.nome, 80) || String(d.usuario), papeis, lojas };
    });
    if (!mudancas.designados.some(d => d.papeis.includes('coordenacao'))) throw erro('Precisa haver pelo menos uma pessoa da Coordenação Administrativa');
  }
  const antes = {}; for (const k of campos) { antes[k] = c[k]; c[k] = mudancas[k]; }
  c.versao = (c.versao || 1) + 1;
  c.alteracoes = (c.alteracoes || []).concat([{ em: agoraIso(), por: user && user.usuario, campos }]).slice(-200);
  gravarJson(P.config(), c); cfgMem = c;
  auditar({ usuario: user && user.usuario, acao: 'config', campos, antes: campos.includes('designados') ? undefined : antes });
  return c;
}

// ── Papéis, escopo e permissões (sempre no servidor) ─────────────────────────
function designado(user) { return user ? config().designados.find(d => d.usuario === user.usuario) || null : null; }
function papeisDe(user) { const d = designado(user); return d ? d.papeis || [] : []; }
function temPapel(user, ...p) { const m = papeisDe(user); return p.some(x => m.includes(x)); }
function bootstrapPermitido(user) { return config().designados.length === 0 && !!user && user.perfil === 'admin'; }
const lojasDesignadas = user => { const d = designado(user); return d ? (d.lojas || []).map(Number) : []; };
/** null = todas as unidades; [] = nenhuma; [n..] = só essas */
function escopo(user) {
  if (temPapel(user, 'coordenacao', 'diretoria')) return null;
  const ls = lojasDesignadas(user);
  if (temPapel(user, ...RH)) return ls.length ? ls : null;
  if (temPapel(user, 'gerente')) return ls;
  return [];
}
const veLoja = (user, loja) => { const e = escopo(user); return e === null || e.includes(+loja); };
const gerenteDa = (user, loja) => temPapel(user, 'gerente') && lojasDesignadas(user).includes(+loja);
const rhDa = (user, loja, papel) => { if (!temPapel(user, ...(papel ? [papel] : RH))) return false; const ls = lojasDesignadas(user); return !ls.length || ls.includes(+loja); };
const vePainel = user => temPapel(user, 'gerente', 'coordenacao', 'diretoria', ...RH);
function exigeVer(user) { if (!vePainel(user)) throw erro('Seu papel não dá acesso a este painel', 403); }
/** quem recebe aviso: gerente só da(s) loja(s) dele; RH da loja ou sem loja (= todas); Coordenação/Diretoria/Jurídico sempre */
function usuariosPara(papeis, loja) {
  return config().designados.filter(d => (d.papeis || []).some(p => {
    if (!papeis.includes(p)) return false;
    if (['coordenacao', 'diretoria', 'juridico', 'ti'].includes(p) || loja == null) return true;
    const ls = d.lojas || [];
    return p === 'gerente' ? ls.includes(+loja) : (!ls.length || ls.includes(+loja));
  })).map(d => d.usuario);
}

// ── Auditoria e notificações ─────────────────────────────────────────────────
function auditar(ev) { appendLinha(P.auditoria(agoraIso()), { em: agoraIso(), ...ev }); }
function auditoria(user, filtro = {}) {
  if (!temPapel(user, 'coordenacao', 'diretoria', ...RH, 'gerente')) throw erro('Sem acesso à auditoria', 403);
  const mes = /^\d{4}-\d{2}$/.test(filtro.mes || '') ? filtro.mes : agoraIso().slice(0, 7);
  let l = lerLinhas(P.auditoria(mes + '-01'));
  if (!temPapel(user, 'coordenacao', 'diretoria')) {
    // gerente e RH: só a trilha das solicitações/ocorrências que eles enxergam (auditoria "limitada")
    const visiveis = new Set([...listarSols(user, {}).map(s => s.protocolo), ...todasOcorrencias().filter(o => veLoja(user, o.loja)).map(o => o.id)]);
    l = l.filter(e => e.ref && visiveis.has(e.ref));
  }
  if (filtro.ref) l = l.filter(e => e.ref === filtro.ref);
  return l.reverse().slice(0, 2000);
}
function notificar(usuarios, texto, ref) {
  const lista = [...new Set((usuarios || []).filter(Boolean))]; if (!lista.length) return;
  appendLinha(P.notificacoes(), { id: crypto.randomUUID(), em: agoraIso(), para: lista, texto: txt(texto, 300), ref: ref || null, lidaPor: [] });
}
function notificacoes(user, soNaoLidas) {
  const l = lerLinhas(P.notificacoes()).filter(n => n.para.includes(user.usuario)).map(n => ({ id: n.id, em: n.em, texto: n.texto, ref: n.ref, lida: (n.lidaPor || []).includes(user.usuario) }));
  return (soNaoLidas ? l.filter(n => !n.lida) : l).reverse().slice(0, 300);
}
function marcarLidas(user, ids) {
  const set = new Set(ids || []); const l = lerLinhas(P.notificacoes()); let mudou = false;
  for (const n of l) if ((set.has(n.id) || set.has('*')) && n.para.includes(user.usuario) && !(n.lidaPor || []).includes(user.usuario)) { (n.lidaPor = n.lidaPor || []).push(user.usuario); mudou = true; }
  if (mudou) { fs.writeFileSync(P.notificacoes(), l.map(x => JSON.stringify(x)).join('\n') + '\n'); }
}

// ── Sincronização: estado ────────────────────────────────────────────────────
function syncEstado() { return lerJson(P.sync(), {}); }
function syncRegistrar(fonte, r) { const s = syncEstado(); const antes = s[fonte] || {}; s[fonte] = { ...r, em: agoraIso(), ultimoOk: r.ok ? agoraIso() : antes.ultimoOk || null }; gravarJson(P.sync(), s); }

// ── Fotos de saldo (histórico do banco de horas) ─────────────────────────────
function datasSaldos() { try { return fs.readdirSync(P.saldos()).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort(); } catch (e) { return []; } }
const saldoMem = new Map();
function lerSaldo(d) { if (!d) return null; if (saldoMem.has(d)) return saldoMem.get(d); const s = lerJson(P.saldo(d), null); if (s) { saldoMem.set(d, s); if (saldoMem.size > 20) saldoMem.delete(saldoMem.keys().next().value); } return s; }
function ultimoSaldo() { const ds = datasSaldos(); return lerSaldo(ds[ds.length - 1]); }
/** foto mais recente com data <= `ate` (usada pra "semana anterior") */
function saldoAte(ate) { const ds = datasSaldos().filter(d => d <= ate); return lerSaldo(ds[ds.length - 1]); }
function colabInfo(id) { const s = ultimoSaldo(); return s && s.colabs[String(id)] ? { id: +id, ...s.colabs[String(id)] } : null; }
function colabPorNome(nome) { const s = ultimoSaldo(); if (!s) return null; const n = semAcento(nome); for (const [id, c] of Object.entries(s.colabs)) if (semAcento(c.nome) === n) return { id: +id, ...c }; return null; }

// ── Banco de horas ───────────────────────────────────────────────────────────
function classificar(min, lim = config().limites) {
  if (min > lim.positivoMin) return 'alerta_pos';
  if (min === lim.positivoMin) return 'limite_pos';
  if (min < -lim.negativoMin) return 'alerta_neg';
  if (min === -lim.negativoMin) return 'limite_neg';
  return 'regular';
}
const SITUACAO_TXT = { alerta_pos: 'Alerta (acima do limite)', limite_pos: 'No limite', alerta_neg: 'Alerta (abaixo do limite)', limite_neg: 'No limite', regular: 'Regular' };
let alertasMem = null;
function alertas() { if (!alertasMem) alertasMem = lerJson(P.alertas(), []); return alertasMem; }
function salvarAlertas() { gravarJson(P.alertas(), alertasMem || []); }
function novoProt(prefixo, existe) { for (let i = 0; i < 50; i++) { const p = prefixo + '-' + new Date().getFullYear() + '-' + aleatorio(5); if (!existe(p)) return p; } throw erro('Não foi possível gerar protocolo', 500); }
/**
 * Recebe os colaboradores ATIVOS do PontoCerto (lib/pontocerto.js › colaboradores().ativos, banco_horas_min) e:
 * grava a foto do dia, abre alerta para quem passou do limite (um aberto por pessoa e sentido — sincronizar de novo
 * só registra a evolução), e encerra o alerta quando o saldo volta pra dentro. Lista vazia/ inválida = falha de
 * sincronização: nada é alterado (falta de dado não vira situação do funcionário).
 */
function sincronizarBancoHoras(ativos, agora = new Date()) {
  if (!Array.isArray(ativos) || !ativos.length || ativos.some(c => c == null || c.id == null || typeof c.banco_horas_min !== 'number')) {
    syncRegistrar('bancoHoras', { ok: false, erro: 'Lista de colaboradores vazia ou inválida — alertas mantidos como estavam' });
    throw erro('Sincronização do banco de horas sem dados válidos', 502);
  }
  const dia = diaISO(agora), lim = config().limites;
  const foto = { data: dia, em: agoraIso(agora), limites: lim, colabs: {} };
  for (const c of ativos) foto.colabs[String(c.id)] = { nome: c.nome, matricula: c.matricula || '', loja: +c.loja || 0, setor: c.setor || '', cargo: c.cargo || '', min: c.banco_horas_min };
  gravarJson(P.saldo(dia), foto); saldoMem.delete(dia);
  const lista = alertas(); let novos = 0, atualizados = 0, encerrados = 0;
  const abertos = new Map(lista.filter(a => a.status === 'aberto').map(a => [a.chave, a]));
  const vistos = new Set();
  for (const c of ativos) {
    const cls = classificar(c.banco_horas_min, lim);
    for (const sentido of ['pos', 'neg']) {
      const chave = 'bh_' + sentido + ':' + c.id; const a = abertos.get(chave);
      if (cls === 'alerta_' + sentido) {
        vistos.add(chave);
        if (a) { if (a.saldoAtual !== c.banco_horas_min) { a.evolucao.push({ em: agoraIso(agora), min: c.banco_horas_min }); a.saldoAtual = c.banco_horas_min; atualizados++; } a.loja = +c.loja || a.loja; a.verificadoEm = agoraIso(agora); continue; }
        const prot = novoProt('BH', p => lista.some(x => x.protocolo === p));
        lista.push({ protocolo: prot, chave, tipo: sentido === 'pos' ? 'bh_pos' : 'bh_neg', colab_id: c.id, nome: c.nome, matricula: c.matricula || '', loja: +c.loja || 0, setor: c.setor || '', cargo: c.cargo || '',
          status: 'aberto', identificadoEm: agoraIso(agora), saldoIdentificado: c.banco_horas_min, saldoAtual: c.banco_horas_min, limiteMin: sentido === 'pos' ? lim.positivoMin : -lim.negativoMin,
          prazoPlano: proximoDiaSemana(dia, config().prazos.planoDiaSemana), prioridade: Math.abs(c.banco_horas_min) > 2 * (sentido === 'pos' ? lim.positivoMin : lim.negativoMin) ? 'alta' : 'media',
          evolucao: [{ em: agoraIso(agora), min: c.banco_horas_min }], providencias: [], verificadoEm: agoraIso(agora) });
        novos++;
      }
    }
  }
  const ids = new Set(ativos.map(c => String(c.id)));
  for (const a of lista) if (a.status === 'aberto' && !vistos.has(a.chave)) {
    const c = foto.colabs[String(a.colab_id)];
    a.status = 'encerrado'; a.encerradoEm = agoraIso(agora);
    a.motivoEncerramento = !ids.has(String(a.colab_id)) ? 'Colaborador não aparece mais entre os ativos' : 'Saldo voltou para dentro do limite (' + hhmm(c.min) + ')';
    if (c) { a.saldoAtual = c.min; a.evolucao.push({ em: agoraIso(agora), min: c.min }); }
    encerrados++;
  }
  salvarAlertas();
  syncRegistrar('bancoHoras', { ok: true, colaboradores: ativos.length, novos, atualizados, encerrados });
  if (novos) for (const ln of new Set(lista.filter(a => a.status === 'aberto' && a.identificadoEm === agoraIso(agora)).map(a => a.loja)))
    notificar([...usuariosPara(['gerente'], ln), ...usuariosPara(['rh_ponto'], ln)], 'Banco de horas: novos alertas em ' + (LOJA_TXT[ln] || 'loja ' + ln) + '. Prazo do plano de ação: sexta.', { aba: 'bh' });
  return { novos, atualizados, encerrados, data: dia };
}
function planoDoAlerta(a) {
  return todasSols().filter(s => s.tipo === 'plano_bh' && s.dados && +s.dados.colab_id === +a.colab_id && s.criadoEm >= a.identificadoEm.slice(0, 10) && !['cancelado', 'rejeitado'].includes(s.status))
    .sort((x, y) => y.criadoEm.localeCompare(x.criadoEm))[0] || null;
}
function painelBancoHoras(user, agora = new Date()) {
  exigeVer(user);
  const atual = ultimoSaldo(); if (!atual) return { semDados: true, sync: syncEstado().bancoHoras || null, limites: config().limites };
  const ant = saldoAte(somaDias(atual.data, -7)); const lim = config().limites;
  const abertos = new Map(alertas().filter(a => a.status === 'aberto').map(a => [String(a.colab_id), a]));
  const linhas = Object.entries(atual.colabs).filter(([, c]) => veLoja(user, c.loja)).map(([id, c]) => {
    const a = abertos.get(id); const plano = a ? planoDoAlerta(a) : null; const anterior = ant && ant.data !== atual.data && ant.colabs[id] ? ant.colabs[id].min : null;
    return { id: +id, nome: c.nome, matricula: c.matricula, loja: c.loja, setor: c.setor, cargo: c.cargo, min: c.min, anterior, variacao: anterior == null ? null : c.min - anterior,
      situacao: classificar(c.min, lim), alerta: a ? { protocolo: a.protocolo, desde: a.identificadoEm, prazoPlano: a.prazoPlano } : null, plano: plano ? { protocolo: plano.protocolo, status: plano.status, statusTxt: STATUS_TXT[plano.status] } : null };
  });
  return { data: atual.data, em: atual.em, anteriorData: ant && ant.data !== atual.data ? ant.data : null, limites: lim, linhas, sync: syncEstado().bancoHoras || null,
    naoDisponivel: ['Saldo anterior oficial do período', 'Período de apuração', 'Prazo de compensação aplicável', 'Histórico de movimentações (lançamentos)'] };
}
function alertaBH(prot, user) {
  const a = alertas().find(x => x.protocolo === prot); if (!a || !veLoja(user, a.loja)) throw erro('Alerta não encontrado', 404); exigeVer(user);
  return { ...a, situacao: classificar(a.saldoAtual), plano: (() => { const p = planoDoAlerta(a); return p ? { protocolo: p.protocolo, status: p.status, statusTxt: STATUS_TXT[p.status] } : null; })() };
}
function providenciaAlerta(prot, user, texto) {
  const a = alertas().find(x => x.protocolo === prot); if (!a || !veLoja(user, a.loja)) throw erro('Alerta não encontrado', 404);
  if (!(gerenteDa(user, a.loja) || rhDa(user, a.loja) || temPapel(user, 'coordenacao'))) throw erro('Sem permissão para registrar providência', 403);
  const t = txt(texto, 1000); if (!t) throw erro('Descreva a providência');
  a.providencias.push({ em: agoraIso(), usuario: user.usuario, nome: user.nome, texto: t }); salvarAlertas();
  auditar({ usuario: user.usuario, acao: 'providencia_alerta', ref: prot });
  return a;
}

// ── Solicitações (motor de aprovação) ────────────────────────────────────────
let solsMem = null;
function carregarSols() {
  if (solsMem) return solsMem; solsMem = new Map();
  try { for (const f of fs.readdirSync(P.sols())) if (f.endsWith('.json')) { const s = lerJson(path.join(P.sols(), f), null); if (s && s.protocolo) solsMem.set(s.protocolo, s); } } catch (e) { /* pasta ainda não existe */ }
  return solsMem;
}
const todasSols = () => [...carregarSols().values()];
function obterSol(prot) { const s = carregarSols().get(String(prot || '').toUpperCase().trim()); if (!s) throw erro('Solicitação não encontrada', 404); return s; }
function gravarSol(s) { s.atualizadoEm = agoraIso(); gravarJson(P.sol(s.protocolo), s); carregarSols().set(s.protocolo, s); return s; }
function podeVerSol(user, s) {
  if (s.autor && s.autor.usuario === user.usuario) return true;
  if (temPapel(user, 'juridico') && s.juridico) return true;
  return vePainel(user) && veLoja(user, s.loja);
}
function podeCriar(user, loja) { return gerenteDa(user, loja) || rhDa(user, loja) || temPapel(user, 'coordenacao'); }
const ehAutor = (user, s) => !!(s.autor && s.autor.usuario === user.usuario);
/** Ações que ESTE usuário pode fazer NESTA solicitação agora. É a única fonte de verdade: a tela só mostra o que vier daqui e o servidor recusa o resto. */
function acoesSol(user, s) {
  const a = []; if (!user || !podeVerSol(user, s)) return a;
  if (temPapel(user, 'diretoria') && papeisDe(user).length === 1) return a;            // Diretoria: só leitura
  const tipo = TIPOS[s.tipo]; const rhComp = rhDa(user, s.loja, tipo.rh); const coord = temPapel(user, 'coordenacao');
  const autor = ehAutor(user, s);
  if (autor && ['rascunho', 'devolvido'].includes(s.status)) a.push('editar', 'enviar');
  if ((autor && ['rascunho', 'devolvido', 'enviado_rh'].includes(s.status)) || (coord && !autor && !FINAIS.includes(s.status))) a.push('cancelar');
  if (s.status === 'enviado_rh' && rhComp && !autor) a.push('analisar');
  if (s.status === 'em_analise_rh' && rhComp && !autor) a.push('validar', 'devolver');
  if (s.status === 'aguardando_coordenacao' && coord && !autor && s.validadoPor !== user.usuario) {
    a.push('aprovar', 'rejeitar', 'ajustes', 'devolver_rh'); if (!s.juridico || s.juridico.status !== 'pendente') a.push('juridico');
  }
  if (s.juridico && s.juridico.status === 'pendente' && temPapel(user, 'juridico')) a.push('parecer_juridico');
  if (s.status === 'aprovado' && (autor || gerenteDa(user, s.loja) || (tipo.admissao && rhDa(user, s.loja, 'rh_adm')))) a.push('iniciar');
  if (['em_execucao', 'vencido'].includes(s.status) && (autor || gerenteDa(user, s.loja) || rhComp)) a.push('registrar_execucao');
  if (['em_execucao', 'vencido'].includes(s.status) && rhComp && !autor) a.push('concluir');
  return [...new Set(a)];
}
const ACAO_TXT = { criar: 'Criou', editar: 'Editou', enviar: 'Enviou ao RH', cancelar: 'Cancelou', analisar: 'Iniciou a análise técnica', validar: 'Validou tecnicamente', devolver: 'Devolveu para correção',
  aprovar: 'Aprovou', rejeitar: 'Rejeitou', ajustes: 'Solicitou ajustes ao solicitante', devolver_rh: 'Devolveu ao RH', juridico: 'Encaminhou ao Jurídico', parecer_juridico: 'Parecer jurídico',
  iniciar: 'Iniciou a execução', registrar_execucao: 'Registrou execução', concluir: 'Concluiu o acompanhamento', vencer: 'Prazo de execução vencido', encaminhar_coord: 'Encaminhada à Coordenação' };
function hist(s, user, acao, para, texto, extra) {
  const de = s.status; if (para) s.status = para;
  s.historico.push({ em: agoraIso(), usuario: user ? user.usuario : 'sistema', nome: user ? user.nome : 'Sistema', papeis: user ? papeisDe(user) : [], acao, acaoTxt: ACAO_TXT[acao] || acao, de, para: para || de, texto: texto || null, ...(extra || {}) });
  auditar({ usuario: user ? user.usuario : 'sistema', acao: 'sol_' + acao, ref: s.protocolo, de, para: para || de });
}
function limparDados(tipo, dados, loja) {
  const t = TIPOS[tipo]; const out = {};
  for (const f of t.campos) {
    if (f.tipo === 'colab') continue;
    let v = dados[f.k]; if (v == null || v === '') continue;
    if (f.tipo === 'number') { v = +v; if (!(v >= 0)) throw erro(f.label + ': número inválido'); }
    else if (f.tipo === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw erro(f.label + ': data inválida'); v = String(v); }
    else if (f.tipo === 'loja') { v = +v; if (!LOJAS.includes(v)) throw erro(f.label + ': unidade inválida'); }
    else v = txt(v, f.tipo === 'textarea' ? 2000 : 160);
    out[f.k] = v;
  }
  if (t.campos.some(f => f.tipo === 'colab') && dados.colab_id) {
    const c = colabInfo(dados.colab_id); if (!c) throw erro('Funcionário não encontrado no cadastro do ponto (sincronize o banco de horas)');
    Object.assign(out, { colab_id: c.id, colab_nome: c.nome, matricula: c.matricula, setor_atual: c.setor, cargo: out.cargo || c.cargo, colab_loja: c.loja });
    if (tipo === 'plano_bh') out.saldo_min = c.min;                    // saldo no momento do plano: vem do servidor, não da tela
  }
  if (out.inicio && out.fim && out.fim < out.inicio) throw erro('A conclusão prevista não pode ser antes do início');
  if (out.loja_destino && out.loja_destino === (out.colab_loja || +loja)) throw erro('A unidade de destino é a mesma de origem');
  return out;
}
function faltando(tipo, d) { return TIPOS[tipo].campos.filter(f => f.obrig && (f.tipo === 'colab' ? !d.colab_id : (d[f.k] == null || d[f.k] === ''))).map(f => f.label); }
function criarSolicitacao(user, body) {
  const tipo = String(body.tipo || ''); if (!TIPOS[tipo]) throw erro('Tipo de solicitação inválido');
  let loja = +body.loja;
  const dados = limparDados(tipo, body.dados || {}, loja);
  if (dados.colab_loja) loja = dados.colab_loja;                       // funcionário define a unidade (não dá pra pedir por funcionário de outra loja)
  if (!LOJAS.includes(loja)) throw erro('Escolha a unidade');
  if (!podeCriar(user, loja)) throw erro(temPapel(user, 'diretoria') ? 'Diretoria tem acesso só de consulta' : 'Você não pode abrir solicitações para ' + (LOJA_TXT[loja] || 'esta unidade'), 403);
  const prot = novoProt('GP', p => carregarSols().has(p));
  const s = { protocolo: prot, tipo, loja, dados, status: 'rascunho', autor: { usuario: user.usuario, nome: user.nome, papeis: papeisDe(user) }, criadoEm: agoraIso(), historico: [], prazos: {}, execucao: { registros: [] } };
  hist(s, user, 'criar', 'rascunho');
  gravarSol(s);
  if (body.enviar) return executar(prot, user, 'enviar', {});
  return s;
}
function editarSolicitacao(prot, user, dados) {
  const s = obterSol(prot); if (!acoesSol(user, s).includes('editar')) throw erro('Esta solicitação não pode ser editada por você agora', 403);
  s.dados = limparDados(s.tipo, dados || {}, s.loja);
  if (s.dados.colab_loja && s.dados.colab_loja !== s.loja) throw erro('O funcionário é de outra unidade; abra a solicitação na unidade dele');
  hist(s, user, 'editar', null); return gravarSol(s);
}
const EXIGE_TEXTO = ['devolver', 'validar', 'aprovar', 'rejeitar', 'ajustes', 'devolver_rh', 'juridico', 'parecer_juridico', 'registrar_execucao', 'concluir', 'cancelar'];
function executar(prot, user, acao, body = {}) {
  const s = obterSol(prot);
  if (!podeVerSol(user, s)) throw erro('Solicitação não encontrada', 404);
  const pode = acoesSol(user, s);
  if (!pode.includes(acao)) {
    if (['aprovar', 'rejeitar'].includes(acao) && ehAutor(user, s)) throw erro('Ninguém aprova ou rejeita a própria solicitação', 403);
    if (['aprovar', 'rejeitar'].includes(acao) && s.validadoPor === user.usuario) throw erro('Quem validou no RH não pode aprovar a mesma solicitação (segregação de funções)', 403);
    throw erro('Ação "' + (ACAO_TXT[acao] || acao) + '" não permitida para você no status ' + STATUS_TXT[s.status], 403);
  }
  const texto = txt(body.texto, 2000);
  if (EXIGE_TEXTO.includes(acao) && !texto) throw erro('Registre a justificativa/parecer para esta ação');
  const hoje = diaISO(); const pz = config().prazos; const tipo = TIPOS[s.tipo];
  const rhs = usuariosPara([tipo.rh], s.loja), coords = usuariosPara(['coordenacao']), autor = s.autor.usuario;
  const ref = { aba: 'sol', protocolo: s.protocolo }; const nome = tipo.curto + ' ' + s.protocolo;
  switch (acao) {
    case 'enviar': {
      const f = faltando(s.tipo, s.dados); if (f.length) throw erro('Preencha antes de enviar: ' + f.join(', '));
      s.prazos.rh = somaDu(hoje, pz.analiseRhDu); hist(s, user, 'enviar', 'enviado_rh'); notificar(rhs, nome + ' (' + LOJA_TXT[s.loja] + ') chegou para análise do RH.', ref); break;
    }
    case 'analisar': s.analista = { usuario: user.usuario, nome: user.nome }; hist(s, user, 'analisar', 'em_analise_rh'); break;
    case 'devolver': s.devolvidoPor = 'rh'; hist(s, user, 'devolver', 'devolvido', texto); notificar([autor], nome + ' foi devolvida pelo RH para correção.', ref); break;
    case 'validar':
      s.validadoPor = user.usuario; hist(s, user, 'validar', 'validado_rh', texto);
      s.prazos.coordenacao = somaDu(hoje, pz.coordenacaoDu); hist(s, null, 'encaminhar_coord', 'aguardando_coordenacao', 'Encaminhada automaticamente à Coordenação após validação técnica');
      notificar(coords, nome + ' validada pelo RH aguarda decisão da Coordenação.', ref); break;
    case 'aprovar': s.decisao = { resultado: 'aprovado', por: user.usuario, nome: user.nome, em: agoraIso(), texto }; hist(s, user, 'aprovar', 'aprovado', texto); notificar([autor, ...rhs], nome + ' foi APROVADA pela Coordenação.', ref); break;
    case 'rejeitar': s.decisao = { resultado: 'rejeitado', por: user.usuario, nome: user.nome, em: agoraIso(), texto }; hist(s, user, 'rejeitar', 'rejeitado', texto); notificar([autor, ...rhs], nome + ' foi REJEITADA pela Coordenação.', ref); break;
    case 'ajustes': s.devolvidoPor = 'coordenacao'; hist(s, user, 'ajustes', 'devolvido', texto); notificar([autor], nome + ': a Coordenação pediu ajustes.', ref); break;
    case 'devolver_rh': s.prazos.rh = somaDu(hoje, pz.analiseRhDu); s.validadoPor = null; hist(s, user, 'devolver_rh', 'enviado_rh', texto); notificar(rhs, nome + ' voltou da Coordenação para nova análise do RH.', ref); break;
    case 'juridico': s.juridico = { status: 'pendente', pergunta: texto, por: user.usuario, em: agoraIso() }; hist(s, user, 'juridico', null, texto); notificar(usuariosPara(['juridico']), nome + ' encaminhada para parecer jurídico.', ref); break;
    case 'parecer_juridico': Object.assign(s.juridico, { status: 'respondido', parecer: texto, parecerPor: user.usuario, parecerEm: agoraIso() }); hist(s, user, 'parecer_juridico', null, texto); notificar(coords, nome + ': parecer jurídico registrado.', ref); break;
    case 'iniciar': s.execucao.inicio = agoraIso(); hist(s, user, 'iniciar', 'em_execucao', texto || null); notificar(rhs, nome + ': execução iniciada.', ref); break;
    case 'registrar_execucao': {
      const horas = body.horas != null && body.horas !== '' ? +body.horas : null; if (horas != null && !(horas >= 0)) throw erro('Horas inválidas');
      s.execucao.registros.push({ em: agoraIso(), usuario: user.usuario, nome: user.nome, texto, horas }); hist(s, user, 'registrar_execucao', null, texto, horas != null ? { horas } : null); break;
    }
    case 'concluir': {
      if (!RESULTADOS[body.resultado]) throw erro('Informe o resultado: cumprido, cumprido em parte ou não cumprido');
      s.resultado = body.resultado;
      if (s.tipo === 'plano_bh' && s.dados.colab_id) { const c = colabInfo(s.dados.colab_id); s.comparacao = { saldoNoPlano: s.dados.saldo_min, saldoNaConclusao: c ? c.min : null, nota: 'Comparação informativa: redução de saldo não prova, sozinha, o cumprimento do plano.' }; }
      hist(s, user, 'concluir', 'concluido', texto, { resultado: body.resultado }); notificar([autor, ...coords], nome + ' concluída: ' + RESULTADOS[body.resultado] + '.', ref); break;
    }
    case 'cancelar': hist(s, user, 'cancelar', 'cancelado', texto); if (!ehAutor(user, s)) notificar([autor], nome + ' foi cancelada.', ref); break;
    default: throw erro('Ação desconhecida');
  }
  return gravarSol(s);
}
function resumoSol(s, user) {
  const t = TIPOS[s.tipo]; const hoje = diaISO();
  const prazo = s.status === 'enviado_rh' || s.status === 'em_analise_rh' ? s.prazos.rh : s.status === 'aguardando_coordenacao' ? s.prazos.coordenacao : (['aprovado', 'em_execucao', 'vencido'].includes(s.status) ? s.dados[t.fimCampo] || null : null);
  return { protocolo: s.protocolo, tipo: s.tipo, tipoTxt: t.nome, curto: t.curto, loja: s.loja, lojaTxt: LOJA_TXT[s.loja], status: s.status, statusTxt: STATUS_TXT[s.status],
    colab: s.dados.colab_nome || null, resumo: s.dados.medida || s.dados.escala_nova || s.dados.motivo || s.dados.justificativa || s.dados.descricao || '', autor: s.autor.nome, criadoEm: s.criadoEm, atualizadoEm: s.atualizadoEm,
    prazo, prazoVencido: !!(prazo && prazo < hoje && !FINAIS.includes(s.status)), resultado: s.resultado || null, juridico: s.juridico ? s.juridico.status : null, acoes: user ? acoesSol(user, s) : [] };
}
function listarSols(user, filtro = {}) {
  let l = todasSols().filter(s => podeVerSol(user, s) && (s.status !== 'rascunho' || ehAutor(user, s)));
  if (temPapel(user, 'juridico') && !vePainel(user)) l = l.filter(s => s.juridico);
  if (filtro.tipo) l = l.filter(s => filtro.tipo === 'planos' ? s.tipo === 'plano_bh' : filtro.tipo === 'outras' ? s.tipo !== 'plano_bh' : s.tipo === filtro.tipo);
  if (filtro.status) l = l.filter(s => s.status === filtro.status);
  if (filtro.loja) l = l.filter(s => +s.loja === +filtro.loja);
  return l.sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
}
function detalheSol(prot, user) {
  const s = obterSol(prot); if (!podeVerSol(user, s) || (s.status === 'rascunho' && !ehAutor(user, s))) throw erro('Solicitação não encontrada', 404);
  auditar({ usuario: user.usuario, acao: 'ver_solicitacao', ref: s.protocolo });
  return { ...s, ...resumoSol(s, user), campos: TIPOS[s.tipo].campos, dados: s.dados, historico: s.historico };
}

// ── Ponto e jornada ──────────────────────────────────────────────────────────
let ocMem = null;
function todasOcorrencias() { if (!ocMem) ocMem = lerJson(P.ocorrencias(), []); return ocMem; }
function salvarOcorrencias() { gravarJson(P.ocorrencias(), ocMem || []); }
/**
 * Abre ocorrências a partir das listas do relatório do PontoCerto (lib/pontocerto.js › resumo().listas): dias sem
 * marcação (missing_days NÃO abonados — o próprio Pontomais já compara com a escala/turno do funcionário, por isso
 * folga e escala especial não viram ocorrência), atrasos e horas extras acima do limiar. Uma ocorrência por
 * colaborador + dia + tipo. Relatório que não veio (erro/timeout) não abre nada.
 */
function sincronizarPonto(listas, periodo, agora = new Date()) {
  if (!listas || !Array.isArray(listas.faltas) || !Array.isArray(listas.atrasos) || !Array.isArray(listas.extras)) {
    syncRegistrar('ponto', { ok: false, erro: 'Relatório de ponto não veio completo — nenhuma ocorrência aberta' });
    throw erro('Sincronização do ponto sem dados válidos', 502);
  }
  const cfg = config(); const l = todasOcorrencias(); const chaves = new Set(l.map(o => o.chave)); const hoje = diaISO(agora); let novas = 0, coletivas = 0; const lojasNovas = new Set();
  if (!cfg.ponto.inicio) { cfg.ponto = { ...cfg.ponto, inicio: (periodo && periodo.ate) || somaDias(hoje, -1) }; gravarJson(P.config(), cfg); }
  const inicio = cfg.ponto.inicio;
  const add = (tipo, r, previsto, registrado, detalhe) => {
    if (!r.data || !r.nome || r.data < inicio) return; const chave = tipo + '|' + semAcento(r.nome) + '|' + r.data; if (chaves.has(chave)) return; chaves.add(chave);
    const c = colabPorNome(r.nome); const loja = +r.loja || (c && c.loja) || 0;
    const desde = somaDias(hoje, -cfg.ponto.reincidenciaDias);
    const anteriores = l.filter(o => semAcento(o.nome) === semAcento(r.nome) && o.data >= desde).length;
    l.push({ id: novoProt('PT', p => l.some(o => o.id === p)), chave, tipo, nome: r.nome, colab_id: c ? c.id : null, loja, setor: r.setor || (c && c.setor) || '', cargo: r.cargo || (c && c.cargo) || '',
      data: r.data, turno: r.turno || '', previsto: previsto || '', registrado: registrado || '', detalhe: detalhe || '', status: 'aberta', criadaEm: agoraIso(agora),
      prazoJustificativa: somaDu(hoje, cfg.prazos.justificativaDu), reincidente: tipo !== 'falha_coletiva' && anteriores + 1 >= cfg.ponto.reincidenciaQtd, historico: [], escalonamentos: [] });
    novas++; lojasNovas.add(loja);
  };
  // Muita gente da mesma unidade sem marcação no mesmo dia = provável falha de relógio/registro/sincronização:
  // abre UMA ocorrência da unidade para o RH, e não uma falta por funcionário.
  const foto = ultimoSaldo(); const ativosLoja = {}; if (foto) for (const c of Object.values(foto.colabs)) ativosLoja[c.loja] = (ativosLoja[c.loja] || 0) + 1;
  const faltas = listas.faltas.filter(r => !r.abonada); const porDia = {};
  for (const r of faltas) { const k = (+r.loja || 0) + '|' + r.data; (porDia[k] = porDia[k] || []).push(r); }
  const coletiva = new Set();
  for (const [k, rs] of Object.entries(porDia)) {
    const [ln, data] = k.split('|'); const tot = ativosLoja[ln] || 0;
    if (+ln && rs.length >= cfg.ponto.falhaColetivaMin && tot && rs.length * 100 >= tot * cfg.ponto.falhaColetivaPct) {
      coletiva.add(k);
      const antes = novas; add('falha_coletiva', { nome: 'Unidade ' + (LOJA_TXT[ln] || ln), loja: +ln, data, setor: 'VÁRIOS' }, 'jornadas previstas na escala', rs.length + ' de ' + tot + ' funcionários sem nenhuma marcação',
        'Verificar relógio/aplicativo/sincronização antes de tratar como falta. Nomes: ' + rs.map(r => r.nome).slice(0, 60).join(', '));
      coletivas += novas - antes;
    }
  }
  for (const r of faltas) if (!coletiva.has((+r.loja || 0) + '|' + r.data)) add('sem_marcacao', r, r.turno || 'jornada prevista na escala', 'nenhuma marcação no dia', r.motivo || '');
  for (const r of listas.atrasos) if (minutos(r.atraso) > cfg.ponto.atrasoMin) add('atraso', r, r.previsto, r.batido, 'atraso de ' + (r.atraso || '?'));
  for (const r of listas.extras) {
    const ex = minutos(r.extras); if (ex <= 0) continue;
    if (minutos(r.normais) === 0) add('trabalho_folga', r, 'folga ou feriado na escala', (r.extras || '') + ' trabalhadas', r.motivo || '');
    else if (ex >= cfg.ponto.extraAlertaMin) add('he_nao_planejada', r, (r.normais || '') + ' normais', (r.extras || '') + ' extras', r.motivo || '');
  }
  salvarOcorrencias();
  syncRegistrar('ponto', { ok: true, de: periodo && periodo.de, ate: periodo && periodo.ate, inicio, novas, coletivas, linhas: listas.faltas.length + listas.atrasos.length + listas.extras.length });
  for (const ln of lojasNovas) notificar([...usuariosPara(['gerente'], ln), ...usuariosPara(['rh_ponto'], ln)], 'Ponto: novas ocorrências em ' + (LOJA_TXT[ln] || 'loja ' + ln) + ' aguardam justificativa.', { aba: 'ponto' });
  return { novas };
}
function acoesOcorrencia(user, o) {
  const a = []; if (!veLoja(user, o.loja) || (temPapel(user, 'diretoria') && papeisDe(user).length === 1)) return a;
  if (o.status === 'aberta' && (gerenteDa(user, o.loja) || rhDa(user, o.loja, 'rh_ponto'))) a.push('justificar');
  if (['aberta', 'justificada'].includes(o.status) && rhDa(user, o.loja, 'rh_ponto')) a.push('regularizar', 'encaminhar');
  if (o.status === 'justificada' && rhDa(user, o.loja, 'rh_ponto')) a.push('devolver');
  if (o.status === 'encaminhada' && temPapel(user, 'coordenacao')) a.push('decidir');
  return a;
}
function resumoOcorrencia(o, user, hoje = diaISO()) {
  const prazo = o.status === 'aberta' ? o.prazoJustificativa : o.status === 'justificada' ? o.prazoRh : null;
  return { ...o, tipoTxt: OC_TIPOS[o.tipo], statusTxt: OC_STATUS[o.status], lojaTxt: LOJA_TXT[o.loja] || '—', prazo, prazoVencido: !!(prazo && prazo < hoje), acoes: user ? acoesOcorrencia(user, o) : [],
    responsavel: o.status === 'aberta' ? (o.tipo === 'falha_coletiva' ? 'RH · Controle de Ponto' : 'Gerente da unidade') : o.status === 'justificada' ? 'RH · Controle de Ponto' : o.status === 'encaminhada' ? 'Coordenação Administrativa' : '—' };
}
function listarOcorrencias(user, filtro = {}) {
  exigeVer(user);
  let l = todasOcorrencias().filter(o => veLoja(user, o.loja));
  if (filtro.situacao === 'abertas') l = l.filter(o => OC_ABERTAS.includes(o.status)); else if (filtro.situacao === 'fechadas') l = l.filter(o => !OC_ABERTAS.includes(o.status));
  if (filtro.loja) l = l.filter(o => +o.loja === +filtro.loja);
  if (filtro.tipo) l = l.filter(o => o.tipo === filtro.tipo);
  return l.sort((a, b) => b.data.localeCompare(a.data) || a.nome.localeCompare(b.nome)).slice(0, 3000).map(o => resumoOcorrencia(o, user));
}
function tratarOcorrencia(id, user, acao, body = {}) {
  const o = todasOcorrencias().find(x => x.id === id); if (!o || !veLoja(user, o.loja)) throw erro('Ocorrência não encontrada', 404);
  if (!acoesOcorrencia(user, o).includes(acao)) throw erro('Ação não permitida para você nesta ocorrência', 403);
  const texto = txt(body.texto, 2000); if (!texto) throw erro('Registre a justificativa/análise');
  const de = o.status; const hoje = diaISO(); const pz = config().prazos;
  if (acao === 'justificar') { o.status = 'justificada'; o.justificativa = { texto, por: user.usuario, nome: user.nome, em: agoraIso() }; o.prazoRh = somaDu(hoje, pz.analiseRhDu); }
  else if (acao === 'regularizar') { o.status = 'regularizada'; o.fechadaEm = agoraIso(); }
  else if (acao === 'encaminhar') { o.status = 'encaminhada'; notificar(usuariosPara(['coordenacao']), 'Ocorrência de ponto ' + o.id + ' (' + (LOJA_TXT[o.loja] || '') + ') encaminhada à Coordenação.', { aba: 'ponto', id: o.id }); }
  else if (acao === 'devolver') { o.status = 'aberta'; o.prazoJustificativa = somaDu(hoje, pz.justificativaDu); notificar(usuariosPara(['gerente'], o.loja), 'Ocorrência de ponto ' + o.id + ' devolvida pelo RH: complemente a justificativa.', { aba: 'ponto', id: o.id }); }
  else if (acao === 'decidir') { o.status = 'decidida'; o.fechadaEm = agoraIso(); }
  o.historico.push({ em: agoraIso(), usuario: user.usuario, nome: user.nome, acao, de, para: o.status, texto });
  salvarOcorrencias(); auditar({ usuario: user.usuario, acao: 'ocorrencia_' + acao, ref: o.id, de, para: o.status });
  return resumoOcorrencia(o, user);
}

// ── Quadro de funcionários ───────────────────────────────────────────────────
const AFASTADO_RE = /afast|licen|atestad|inss|auxilio|aux[ií]lio|maternidade/i, FERIAS_RE = /f[eé]rias/i;
/** colabs = lib/pontocerto.js › colaboradores() (ativos + desligados, ao vivo); sem ele usa a última foto de saldo */
function painelQuadro(user, colabs, agora = new Date()) {
  exigeVer(user);
  const hoje = diaISO(agora), desde = somaDias(hoje, -90); const q = config().quadro || {};
  const ativos = colabs ? colabs.ativos : Object.entries((ultimoSaldo() || { colabs: {} }).colabs).map(([id, c]) => ({ id: +id, ...c }));
  const porChave = {};
  const K = (ln, setor) => { const k = ln + '|' + semAcento(setor || '—'); return porChave[k] || (porChave[k] = { loja: ln, lojaTxt: LOJA_TXT[ln] || '—', setor: semAcento(setor || '—'), atual: 0, afastados: 0, ferias: 0, autorizado: q[k] != null ? q[k] : null, funcoes: {} }); };
  for (const c of ativos) { if (!veLoja(user, c.loja)) continue; const r = K(+c.loja, c.setor); r.atual++; if (FERIAS_RE.test(c.status_agora || '')) r.ferias++; else if (AFASTADO_RE.test(c.status_agora || '')) r.afastados++; const f = c.cargo || '—'; r.funcoes[f] = (r.funcoes[f] || 0) + 1; }
  for (const k of Object.keys(q)) { const [ln, setor] = k.split('|'); if (veLoja(user, +ln)) K(+ln, setor); }
  const linhas = Object.values(porChave).map(r => ({ ...r, funcoes: Object.entries(r.funcoes).sort((a, b) => b[1] - a[1]).map(([cargo, n]) => ({ cargo, n })), diferenca: r.autorizado == null ? null : r.atual - r.autorizado }))
    .sort((a, b) => a.loja - b.loja || a.setor.localeCompare(b.setor));
  const sols = listarSols(user, {}); const pend = s => !FINAIS.includes(s.status) && s.status !== 'rascunho';
  const admissoes = colabs ? colabs.ativos.filter(c => veLoja(user, c.loja) && c.admissao && c.admissao >= desde).map(c => ({ nome: c.nome, loja: c.loja, setor: c.setor, cargo: c.cargo, data: c.admissao })) : [];
  const desligamentos = colabs ? colabs.desligados.filter(c => veLoja(user, c.loja) && c.desligamento && c.desligamento >= desde).map(c => ({ nome: c.nome, loja: c.loja, setor: c.setor, cargo: c.cargo, data: c.desligamento })) : [];
  return { linhas, admissoes, desligamentos, aoVivo: !!colabs,
    solicitacoesContratacao: sols.filter(s => TIPOS[s.tipo].admissao && pend(s)).map(s => resumoSol(s, user)),
    admissoesAndamento: sols.filter(s => TIPOS[s.tipo].admissao && ['aprovado', 'em_execucao', 'vencido'].includes(s.status)).map(s => resumoSol(s, user)),
    movimentacoes: sols.filter(s => ['transferencia', 'lotacao', 'movimentacao', 'alteracao_escala'].includes(s.tipo) && pend(s)).map(s => resumoSol(s, user)),
    nota: 'Diferença de quadro não é vaga aprovada: a vaga só existe depois de uma solicitação de reposição/ampliação aprovada pela Coordenação.' };
}

// ── Documentação e atendimento assistido ─────────────────────────────────────
let docMem = null, atMem = null;
const docs = () => docMem || (docMem = lerJson(P.documentos(), []));
const atends = () => atMem || (atMem = lerJson(P.atendimentos(), []));
const podeDoc = (user, loja) => rhDa(user, loja, 'rh_doc') || temPapel(user, 'coordenacao');
function listarDocumentos(user, filtro = {}) {
  exigeVer(user); const hoje = diaISO();
  let l = docs().filter(d => veLoja(user, d.loja));
  if (filtro.situacao === 'pendentes') l = l.filter(d => ['pendente', 'recebido'].includes(d.status));
  if (filtro.colab_id) l = l.filter(d => +d.colab_id === +filtro.colab_id);
  return l.map(d => ({ ...d, statusTxt: DOC_STATUS[d.status], lojaTxt: LOJA_TXT[d.loja] || '—', vencido: !!(d.prazo && d.prazo < hoje && ['pendente', 'recebido'].includes(d.status)), pode: podeDoc(user, d.loja) }))
    .sort((a, b) => (b.vencido - a.vencido) || String(a.prazo || '9').localeCompare(String(b.prazo || '9')));
}
function salvarDocumento(user, d) {
  const l = docs(); const atual = d.id ? l.find(x => x.id === d.id) : null; if (d.id && !atual) throw erro('Documento não encontrado', 404);
  const c = d.colab_id ? colabInfo(d.colab_id) : null; const loja = atual ? atual.loja : c ? c.loja : +d.loja;
  if (!LOJAS.includes(loja)) throw erro('Escolha o funcionário ou a unidade');
  if (!podeDoc(user, loja)) throw erro('Só RH · Documentação (ou a Coordenação) registra pendências documentais', 403);
  const status = DOC_STATUS[d.status] ? d.status : 'pendente'; const tipo = DOC_TIPOS.includes(d.tipo) ? d.tipo : 'Outro';
  const novo = { ...(atual || { id: novoProt('DC', p => l.some(x => x.id === p)), criadoEm: agoraIso(), criadoPor: user.usuario, historico: [] }),
    colab_id: c ? c.id : (atual ? atual.colab_id : null), nome: c ? c.nome : (atual ? atual.nome : txt(d.nome, 120)), loja, tipo, descricao: txt(d.descricao, 300), prazo: /^\d{4}-\d{2}-\d{2}$/.test(d.prazo || '') ? d.prazo : null,
    status, geri_ref: txt(d.geri_ref, 120), assistido: !!d.assistido, obs: txt(d.obs, 600) };
  if (!novo.descricao) throw erro('Descreva o documento');
  novo.historico.push({ em: agoraIso(), usuario: user.usuario, status, texto: atual ? 'atualizado' : 'criado' });
  if (atual) Object.assign(atual, novo); else l.push(novo);
  gravarJson(P.documentos(), l); auditar({ usuario: user.usuario, acao: atual ? 'doc_editar' : 'doc_criar', ref: novo.id });
  return novo;
}
function checklistAdmissional(user, colabId, prazo) {
  const c = colabInfo(colabId); if (!c) throw erro('Funcionário não encontrado no cadastro');
  if (!podeDoc(user, c.loja)) throw erro('Só RH · Documentação (ou a Coordenação) abre checklist admissional', 403);
  const ja = new Set(docs().filter(d => +d.colab_id === c.id && d.tipo === 'Documento admissional').map(d => d.descricao));
  const p = /^\d{4}-\d{2}-\d{2}$/.test(prazo || '') ? prazo : somaDias(diaISO(), config().prazos.documentoDias);
  let n = 0; for (const item of config().checklistAdmissional) if (!ja.has(item)) { salvarDocumento(user, { colab_id: c.id, tipo: 'Documento admissional', descricao: item, prazo: p }); n++; }
  return { criados: n };
}
function listarAtendimentos(user) {
  if (temPapel(user, 'juridico') && !vePainel(user)) return atends().filter(a => a.validacaoJuridica).map(a => ({ ...a, statusTxt: AT_STATUS[a.status], lojaTxt: LOJA_TXT[a.loja] }));
  exigeVer(user); return atends().filter(a => veLoja(user, a.loja)).map(a => ({ ...a, statusTxt: AT_STATUS[a.status], lojaTxt: LOJA_TXT[a.loja], pode: podeDoc(user, a.loja) })).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
function salvarAtendimento(user, d) {
  const l = atends(); const atual = d.id ? l.find(x => x.id === d.id) : null; if (d.id && !atual) throw erro('Atendimento não encontrado', 404);
  const c = d.colab_id ? colabInfo(d.colab_id) : null; const loja = atual ? atual.loja : c ? c.loja : +d.loja;
  if (!LOJAS.includes(loja)) throw erro('Escolha o funcionário');
  const rh = podeDoc(user, loja), ger = gerenteDa(user, loja), jur = temPapel(user, 'juridico') && atual && atual.validacaoJuridica;
  if (!rh && !(ger && !atual) && !jur) throw erro('Sem permissão para este atendimento', 403);
  let novo;
  if (jur && !rh) { novo = { ...atual, parecerJuridico: txt(d.parecerJuridico, 2000) }; }
  else {
    novo = { ...(atual || { id: novoProt('AT', p => l.some(x => x.id === p)), criadoEm: agoraIso(), criadoPor: user.usuario, status: 'solicitado' }),
      colab_id: c ? c.id : atual.colab_id, nome: c ? c.nome : atual.nome, loja, motivo: txt(d.motivo, 600) || (atual && atual.motivo) || '', documento: txt(d.documento, 200) || (atual && atual.documento) || '' };
    if (rh) Object.assign(novo, { status: AT_STATUS[d.status] ? d.status : novo.status, agendadoPara: d.agendadoPara || null, responsavel: txt(d.responsavel, 120), orientacoes: txt(d.orientacoes, 2000), validacaoJuridica: !!d.validacaoJuridica });
    if (!novo.motivo) throw erro('Diga o motivo do atendimento assistido');
  }
  if (atual) Object.assign(atual, novo); else l.push(novo);
  gravarJson(P.atendimentos(), l); auditar({ usuario: user.usuario, acao: atual ? 'atend_editar' : 'atend_criar', ref: novo.id });
  if (!atual) notificar(usuariosPara(['rh_doc'], loja), 'Pedido de atendimento assistido em ' + (LOJA_TXT[loja] || '') + '.', { aba: 'docs' });
  if (novo.validacaoJuridica && !(atual && atual.validacaoJuridica)) notificar(usuariosPara(['juridico']), 'Atendimento assistido ' + novo.id + ' precisa de validação jurídica.', { aba: 'docs' });
  return novo;
}

// ── Central de alertas (os 12 eventos) ───────────────────────────────────────
const PRIO = { alta: 3, media: 2, baixa: 1 };
function centralAlertas(user, filtro = {}, agora = new Date()) {
  exigeVer(user); const hoje = diaISO(agora); const pz = config().prazos; const out = [];
  const push = a => { if (veLoja(user, a.loja)) out.push(a); };
  // 1 e 2 · banco de horas
  for (const a of alertas()) if (a.status === 'aberto') {
    const plano = planoDoAlerta(a);
    push({ protocolo: a.protocolo, evento: a.tipo === 'bh_pos' ? 1 : 2, tipo: a.tipo === 'bh_pos' ? 'Banco de horas acima do limite' : 'Banco de horas abaixo do limite', colab: a.nome, loja: a.loja, data: a.identificadoEm.slice(0, 10),
      prioridade: a.prioridade, responsavel: 'Gerente da unidade', prazo: a.prazoPlano, status: plano ? 'Plano ' + STATUS_TXT[plano.status].toLowerCase() : 'Sem plano de ação', detalhe: 'saldo ' + hhmm(a.saldoAtual) + (a.saldoAtual !== a.saldoIdentificado ? ' (era ' + hhmm(a.saldoIdentificado) + ' ao abrir)' : ''), ref: { aba: 'bh', protocolo: a.protocolo } });
    // 5 · plano não enviado no prazo
    if (!plano && a.prazoPlano < hoje) push({ protocolo: a.protocolo, evento: 5, tipo: 'Plano de ação não enviado', colab: a.nome, loja: a.loja, data: a.prazoPlano, prioridade: 'alta', responsavel: 'Gerente da unidade', prazo: a.prazoPlano, status: 'Vencido', detalhe: 'Saldo ' + hhmm(a.saldoAtual), ref: { aba: 'bh', protocolo: a.protocolo } });
  }
  // 3 e 4 · ponto
  for (const o of todasOcorrencias()) if (OC_ABERTAS.includes(o.status)) {
    const r = resumoOcorrencia(o, null, hoje);
    push({ protocolo: o.id, evento: ['sem_marcacao', 'falha_coletiva'].includes(o.tipo) ? 3 : 4, tipo: o.tipo === 'sem_marcacao' ? 'Marcação de ponto ausente' : o.tipo === 'falha_coletiva' ? 'Possível falha de registro (unidade)' : 'Jornada inconsistente · ' + OC_TIPOS[o.tipo].toLowerCase(), colab: o.nome, loja: o.loja, data: o.data,
      prioridade: o.reincidente || r.prazoVencido ? 'alta' : 'media', responsavel: r.responsavel, prazo: r.prazo, status: r.statusTxt + (o.escalonamentos.length ? ' · escalonada' : ''), detalhe: o.registrado, ref: { aba: 'ponto', id: o.id } });
  }
  // 6, 7, 8, 10, 12 · solicitações
  for (const s of listarSols(user, {})) {
    const r = resumoSol(s, null); const plano = s.tipo === 'plano_bh';
    const base = { protocolo: s.protocolo, colab: r.colab, loja: s.loja, prazo: r.prazo, status: r.statusTxt, detalhe: TIPOS[s.tipo].nome, ref: { aba: 'sol', protocolo: s.protocolo } };
    if (['enviado_rh', 'em_analise_rh'].includes(s.status)) push({ ...base, evento: 6, tipo: plano ? 'Plano aguardando RH' : 'Solicitação aguardando RH', data: (s.historico.filter(h => h.para === 'enviado_rh').pop() || {}).em?.slice(0, 10), prioridade: r.prazoVencido ? 'alta' : 'media', responsavel: PAPEIS[TIPOS[s.tipo].rh] });
    if (s.status === 'aguardando_coordenacao') push({ ...base, evento: 7, tipo: plano ? 'Plano aguardando Coordenação' : 'Solicitação aguardando Coordenação', data: (s.historico.filter(h => h.para === 'aguardando_coordenacao').pop() || {}).em?.slice(0, 10), prioridade: r.prazoVencido ? 'alta' : 'media', responsavel: 'Coordenação Administrativa' });
    if (s.status === 'vencido') push({ ...base, evento: 8, tipo: 'Prazo de execução vencido', data: r.prazo, prioridade: 'alta', responsavel: 'Gerente da unidade' });
    if (s.status === 'devolvido') push({ ...base, evento: 10, tipo: 'Solicitação devolvida', data: s.atualizadoEm.slice(0, 10), prioridade: 'media', responsavel: s.autor.nome });
    if (TIPOS[s.tipo].admissao && s.status === 'em_execucao') { const ini = (s.execucao.inicio || s.atualizadoEm).slice(0, 10); if (diasEntre(ini, hoje) > pz.admissaoDias) push({ ...base, evento: 12, tipo: 'Processo admissional atrasado', data: ini, prioridade: 'alta', responsavel: 'RH · Admissões', prazo: somaDias(ini, pz.admissaoDias) }); }
  }
  // 9 · documentos
  for (const d of docs()) if (['pendente', 'recebido'].includes(d.status)) push({ protocolo: d.id, evento: 9, tipo: d.tipo === 'Assinatura' ? 'Assinatura pendente' : 'Documento pendente', colab: d.nome, loja: d.loja, data: d.criadoEm.slice(0, 10), prioridade: d.prazo && d.prazo < hoje ? 'alta' : 'baixa', responsavel: 'RH · Documentação', prazo: d.prazo, status: DOC_STATUS[d.status] + (d.prazo && d.prazo < hoje ? ' · vencido' : ''), detalhe: d.descricao, ref: { aba: 'docs', id: d.id } });
  // 11 · quadro abaixo do autorizado (comparação com a última foto; diferença NÃO é vaga aprovada)
  const foto = ultimoSaldo(); const q = config().quadro || {};
  if (foto) { const cont = {}; for (const c of Object.values(foto.colabs)) { const k = c.loja + '|' + semAcento(c.setor || '—'); cont[k] = (cont[k] || 0) + 1; }
    for (const [k, aut] of Object.entries(q)) { const [ln, setor] = k.split('|'); const at = cont[k] || 0; if (at < aut) push({ protocolo: 'QD-' + ln + '-' + setor, evento: 11, tipo: 'Quadro abaixo do autorizado', colab: null, loja: +ln, data: foto.data, prioridade: aut - at >= 2 ? 'alta' : 'media', responsavel: 'Gerente da unidade', prazo: null, status: at + ' de ' + aut, detalhe: setor + ': faltam ' + (aut - at), ref: { aba: 'quadro' } }); } }
  let l = out.map(a => ({ ...a, lojaTxt: LOJA_TXT[a.loja] || '—' }));
  if (filtro.prioridade) l = l.filter(a => a.prioridade === filtro.prioridade);
  if (filtro.loja) l = l.filter(a => +a.loja === +filtro.loja);
  if (filtro.responsavel) l = l.filter(a => a.responsavel === filtro.responsavel);
  if (filtro.evento) l = l.filter(a => +a.evento === +filtro.evento);
  return l.sort((a, b) => PRIO[b.prioridade] - PRIO[a.prioridade] || String(a.prazo || '9').localeCompare(String(b.prazo || '9')));
}

// ── Indicadores e desempenho ─────────────────────────────────────────────────
function indicadores(user, colabs, agora = new Date()) {
  exigeVer(user); const hoje = diaISO(agora); const lim = config().limites;
  const foto = ultimoSaldo(); const ant = foto ? saldoAte(somaDias(foto.data, -7)) : null;
  const porLoja = {}; const L = ln => porLoja[ln] || (porLoja[ln] = { loja: +ln, lojaTxt: LOJA_TXT[ln] || '—', pos_min: 0, neg_min: 0, acima: 0, abaixo: 0, pos_min_ant: null, neg_min_ant: null,
    oc_abertas: 0, oc_fechadas: 0, oc_reincid: 0, oc_resol_h: [], resp_h: [], planos_pend: 0, planos_aprov: 0, planos_concl: 0, planos_cumpridos: 0, devolvidas: 0, vencidas: 0,
    efetivo: 0, autorizado: 0, docs_pend: 0, assin_pend: 0, docs_concl: 0, admissoes_and: 0, sols_pend: 0 });
  for (const ln of LOJAS) if (veLoja(user, ln)) L(ln);
  if (foto) for (const c of Object.values(foto.colabs)) if (veLoja(user, c.loja)) { const r = L(c.loja); r.efetivo++; if (c.min > 0) r.pos_min += c.min; else r.neg_min += c.min; if (c.min > lim.positivoMin) r.acima++; if (c.min < -lim.negativoMin) r.abaixo++; }
  if (ant && ant.data !== foto.data) for (const c of Object.values(ant.colabs)) if (veLoja(user, c.loja)) { const r = L(c.loja); if (r.pos_min_ant == null) { r.pos_min_ant = 0; r.neg_min_ant = 0; } if (c.min > 0) r.pos_min_ant += c.min; else r.neg_min_ant += c.min; }
  for (const [k, n] of Object.entries(config().quadro || {})) { const ln = +k.split('|')[0]; if (veLoja(user, ln)) L(ln).autorizado += n; }
  for (const o of todasOcorrencias()) if (veLoja(user, o.loja)) {
    const r = L(o.loja); if (OC_ABERTAS.includes(o.status)) { r.oc_abertas++; const pz = o.status === 'aberta' ? o.prazoJustificativa : o.prazoRh; if (pz && pz < hoje) r.vencidas++; } else { r.oc_fechadas++; if (o.fechadaEm) r.oc_resol_h.push((new Date(o.fechadaEm) - new Date(o.criadaEm)) / 3600000); }
    if (o.reincidente) r.oc_reincid++; if (o.justificativa) r.resp_h.push((new Date(o.justificativa.em) - new Date(o.criadaEm)) / 3600000);
  }
  for (const s of listarSols(user, {})) {
    const r = L(s.loja); const rs = resumoSol(s, null);
    if (s.historico.some(h => h.acao === 'devolver' || h.acao === 'ajustes')) r.devolvidas++;
    if (rs.prazoVencido || s.status === 'vencido') r.vencidas++;
    if (!FINAIS.includes(s.status) && s.status !== 'rascunho' && !['aprovado', 'em_execucao', 'vencido'].includes(s.status)) r.sols_pend++;
    if (TIPOS[s.tipo].admissao && ['aprovado', 'em_execucao', 'vencido'].includes(s.status)) r.admissoes_and++;
    if (s.tipo === 'plano_bh') { if (['enviado_rh', 'em_analise_rh', 'aguardando_coordenacao', 'devolvido'].includes(s.status)) r.planos_pend++; if (s.decisao && s.decisao.resultado === 'aprovado') r.planos_aprov++; if (s.status === 'concluido') { r.planos_concl++; if (s.resultado === 'cumprido') r.planos_cumpridos++; } }
  }
  for (const d of docs()) if (veLoja(user, d.loja)) { const r = L(d.loja); if (['pendente', 'recebido'].includes(d.status)) { if (d.tipo === 'Assinatura') r.assin_pend++; else r.docs_pend++; } else if (['concluido', 'assinado'].includes(d.status)) r.docs_concl++; }
  const media = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
  const lojas = Object.values(porLoja).sort((a, b) => a.loja - b.loja).map(r => ({ ...r, oc_resol_h: media(r.oc_resol_h), resp_h: media(r.resp_h), taxa_cumprimento: r.planos_concl ? Math.round(r.planos_cumpridos / r.planos_concl * 100) : null, diferenca_quadro: r.autorizado ? r.efetivo - r.autorizado : null }));
  const soma = k => lojas.reduce((s, r) => s + (r[k] || 0), 0);
  const desde = somaDias(hoje, -30);
  const vivos = colabs ? { admissoes30: colabs.ativos.filter(c => veLoja(user, c.loja) && c.admissao >= desde).length, desligamentos30: colabs.desligados.filter(c => veLoja(user, c.loja) && c.desligamento >= desde).length,
    afastados: colabs.ativos.filter(c => veLoja(user, c.loja) && AFASTADO_RE.test(c.status_agora || '') && !FERIAS_RE.test(c.status_agora || '')).length, ferias: colabs.ativos.filter(c => veLoja(user, c.loja) && FERIAS_RE.test(c.status_agora || '')).length } : null;
  const concl = soma('planos_concl');
  return { data: foto ? foto.data : null, anteriorData: ant && foto && ant.data !== foto.data ? ant.data : null, limites: lim, lojas, vivos,
    total: { pos_min: soma('pos_min'), neg_min: soma('neg_min'), acima: soma('acima'), abaixo: soma('abaixo'), oc_abertas: soma('oc_abertas'), oc_fechadas: soma('oc_fechadas'), oc_reincid: soma('oc_reincid'),
      planos_pend: soma('planos_pend'), planos_aprov: soma('planos_aprov'), taxa_cumprimento: concl ? Math.round(soma('planos_cumpridos') / concl * 100) : null, efetivo: soma('efetivo'), autorizado: soma('autorizado'),
      docs_pend: soma('docs_pend'), assin_pend: soma('assin_pend'), docs_concl: soma('docs_concl'), admissoes_and: soma('admissoes_and'), sols_pend: soma('sols_pend'), devolvidas: soma('devolvidas'), vencidas: soma('vencidas'),
      pos_min_ant: lojas.some(r => r.pos_min_ant != null) ? soma('pos_min_ant') : null, neg_min_ant: lojas.some(r => r.neg_min_ant != null) ? soma('neg_min_ant') : null },
    aviso: 'Indicadores apoiam a gestão; nenhum deles gera penalidade automática.' };
}
/** O que está esperando ESTE usuário agir (vira a lista "Aguardando você" da visão geral) */
function minhaFila(user) {
  const out = [];
  for (const s of listarSols(user, {})) { const a = acoesSol(user, s).filter(x => !['cancelar', 'registrar_execucao', 'juridico'].includes(x)); if (a.length) out.push({ kind: 'sol', protocolo: s.protocolo, texto: TIPOS[s.tipo].curto + (s.dados.colab_nome ? ' · ' + s.dados.colab_nome : ''), loja: s.loja, status: STATUS_TXT[s.status], acoes: a }); }
  if (vePainel(user)) {
    for (const o of todasOcorrencias()) if (veLoja(user, o.loja)) { const a = acoesOcorrencia(user, o); if (a.length) out.push({ kind: 'ponto', protocolo: o.id, texto: OC_TIPOS[o.tipo] + ' · ' + o.nome + ' · ' + o.data.split('-').reverse().join('/'), loja: o.loja, status: OC_STATUS[o.status], acoes: a }); }
    for (const a of alertas()) if (a.status === 'aberto' && gerenteDa(user, a.loja) && !planoDoAlerta(a)) out.push({ kind: 'bh', protocolo: a.protocolo, texto: 'Plano de ação pendente · ' + a.nome + ' (' + hhmm(a.saldoAtual) + ')', loja: a.loja, status: 'prazo ' + a.prazoPlano.split('-').reverse().join('/'), acoes: ['plano'] });
  }
  return out.map(x => ({ ...x, lojaTxt: LOJA_TXT[x.loja] || '—' }));
}

// ── Resumo de um funcionário para a ficha (TESTE TIAGO, 21/10) ──────────────
function resumoColab(user, id, nome, loja) {
  exigeVer(user); if (loja != null && !veLoja(user, loja)) throw erro('Funcionário fora das suas unidades', 403);
  const nm = semAcento(nome);
  const alerta = alertas().find(a => a.status === 'aberto' && +a.colab_id === +id) || null;
  const oc = todasOcorrencias().filter(o => veLoja(user, o.loja) && (+o.colab_id === +id || (nm && semAcento(o.nome) === nm))).sort((a, b) => b.data.localeCompare(a.data)).map(o => resumoOcorrencia(o, user));
  const sols = listarSols(user, {}).filter(s => s.dados && +s.dados.colab_id === +id).map(s => resumoSol(s, user));
  const docs = listarDocumentos(user, { colab_id: id });
  return { alerta: alerta ? { ...alerta, situacao: classificar(alerta.saldoAtual), plano: (() => { const p = planoDoAlerta(alerta); return p ? { protocolo: p.protocolo, status: p.status, statusTxt: STATUS_TXT[p.status] } : null; })() } : null,
    ocorrencias: oc, solicitacoes: sols, documentos: docs, limites: config().limites };
}

// ── Relatório semanal (sexta) ────────────────────────────────────────────────
function montarRelatorioSemanal(agora = new Date()) {
  const foto = ultimoSaldo(); if (!foto) return null;
  const ant = saldoAte(somaDias(foto.data, -7)); const lim = config().limites; const lojas = {};
  for (const [id, c] of Object.entries(foto.colabs)) {
    const r = lojas[c.loja] || (lojas[c.loja] = { loja: c.loja, lojaTxt: LOJA_TXT[c.loja] || '—', colaboradores: 0, pos_min: 0, neg_min: 0, linhas: [] });
    const a = ant && ant.data !== foto.data && ant.colabs[id] ? ant.colabs[id].min : null;
    r.colaboradores++; if (c.min > 0) r.pos_min += c.min; else r.neg_min += c.min;
    r.linhas.push({ id: +id, nome: c.nome, setor: c.setor, cargo: c.cargo, min: c.min, anterior: a, variacao: a == null ? null : c.min - a, situacao: classificar(c.min, lim) });
  }
  const sols = todasSols().filter(s => s.tipo === 'plano_bh');
  const out = Object.values(lojas).sort((a, b) => a.loja - b.loja).map(r => {
    const ps = sols.filter(s => s.loja === r.loja);
    return { loja: r.loja, lojaTxt: r.lojaTxt, colaboradores: r.colaboradores, pos_min: r.pos_min, neg_min: r.neg_min,
      top_pos: r.linhas.filter(x => x.min > 0).sort((a, b) => b.min - a.min).slice(0, 5), top_neg: r.linhas.filter(x => x.min < 0).sort((a, b) => a.min - b.min).slice(0, 5),
      fora: r.linhas.filter(x => x.situacao.startsWith('alerta')).sort((a, b) => Math.abs(b.min) - Math.abs(a.min)),
      evolucao: { pos_ant: ant && ant.data !== foto.data ? Object.values(ant.colabs).filter(c => c.loja === r.loja && c.min > 0).reduce((s, c) => s + c.min, 0) : null, neg_ant: ant && ant.data !== foto.data ? Object.values(ant.colabs).filter(c => c.loja === r.loja && c.min < 0).reduce((s, c) => s + c.min, 0) : null },
      planos: { pendentes: ps.filter(s => ['rascunho', 'enviado_rh', 'em_analise_rh', 'devolvido', 'aguardando_coordenacao'].includes(s.status)).length, concluidos: ps.filter(s => s.status === 'concluido' && s.resultado !== 'nao_cumprido').length,
        descumpridos: ps.filter(s => (s.status === 'concluido' && s.resultado === 'nao_cumprido') || s.status === 'vencido').length, emExecucao: ps.filter(s => ['aprovado', 'em_execucao'].includes(s.status)).length } };
  });
  return { geradoEm: agoraIso(agora), data: foto.data, anteriorData: ant && ant.data !== foto.data ? ant.data : null, limites: lim, lojas: out };
}
function relatorioSemanal(user, data) {
  exigeVer(user);
  const r = data ? lerJson(P.relatorio(data), null) : montarRelatorioSemanal(); if (!r) throw erro(data ? 'Relatório não encontrado' : 'Ainda não há foto de saldos (sincronize o banco de horas)', 404);
  return { ...r, lojas: r.lojas.filter(l => veLoja(user, l.loja)), congelado: !!data };
}
function relatoriosSalvos() { try { return fs.readdirSync(P.relatorios()).filter(f => f.endsWith('.json')).map(f => f.slice(0, 10)).sort().reverse(); } catch (e) { return []; } }

// ── Tick (prazos, vencimentos, escalonamento, relatório de sexta) ────────────
function tick(agora = new Date()) {
  const hoje = diaISO(agora); let vencidas = 0, escalonadas = 0, relatorio = null;
  for (const s of todasSols()) {
    const fim = s.dados[TIPOS[s.tipo].fimCampo];
    if (['aprovado', 'em_execucao'].includes(s.status) && fim && fim < hoje) { hist(s, null, 'vencer', 'vencido', 'Data prevista de conclusão (' + fim.split('-').reverse().join('/') + ') passou sem conclusão'); gravarSol(s); vencidas++; notificar([s.autor.usuario, ...usuariosPara([TIPOS[s.tipo].rh], s.loja)], TIPOS[s.tipo].curto + ' ' + s.protocolo + ' venceu sem conclusão.', { aba: 'sol', protocolo: s.protocolo }); }
  }
  const l = todasOcorrencias(); let mudou = false; const pz = config().prazos;
  const escalar = (o, motivo, para) => { if (o.escalonamentos.some(e => e.motivo === motivo)) return; o.escalonamentos.push({ em: agoraIso(agora), motivo, para }); mudou = true; escalonadas++;
    notificar(para === 'Coordenação Administrativa' ? usuariosPara(['coordenacao']) : [...usuariosPara(['rh_ponto'], o.loja), ...usuariosPara(['coordenacao'])], 'Ocorrência ' + o.id + ' escalonada: ' + motivo + '.', { aba: 'ponto', id: o.id }); };
  for (const o of l) {
    if (o.status === 'aberta' && o.prazoJustificativa < hoje) escalar(o, 'justificativa não enviada no prazo', 'RH e Coordenação');
    if (o.status === 'aberta' && somaDu(o.prazoJustificativa, pz.justificativaDu) < hoje) escalar(o, 'ocorrência sem tratamento', 'Coordenação Administrativa');
    if (o.status === 'justificada' && o.prazoRh && o.prazoRh < hoje) escalar(o, 'análise do RH vencida', 'Coordenação Administrativa');
    if (o.reincidente && OC_ABERTAS.includes(o.status)) escalar(o, 'reincidência relevante', 'RH e Coordenação');
  }
  if (mudou) salvarOcorrencias();
  // sexta a partir das 8h: congela o relatório semanal (uma vez por sexta)
  if (agora.getDay() === 5 && agora.getHours() >= 8 && !fs.existsSync(P.relatorio(hoje))) { const r = montarRelatorioSemanal(agora); if (r) { gravarJson(P.relatorio(hoje), r); relatorio = hoje;
    notificar(usuariosPara(['coordenacao', 'diretoria', 'rh_ponto', 'gerente']), 'Relatório semanal do banco de horas (' + hoje.split('-').reverse().join('/') + ') disponível.', { aba: 'relatorios', data: hoje }); } }
  return { vencidas, escalonadas, relatorio };
}

function recarregar() { cfgMem = null; solsMem = null; alertasMem = null; ocMem = null; docMem = null; atMem = null; saldoMem.clear(); }

module.exports = { usuariosPara,   // 23/10/2026: Cadastro Bancário e Pagamentos avisam Financeiro/Coordenação
  DIR, LOJAS, LOJA_TXT, PAPEIS, RH, STATUS, STATUS_TXT, FINAIS, RESULTADOS, TIPOS, OC_TIPOS, OC_STATUS, DOC_TIPOS, DOC_STATUS, AT_STATUS, SITUACAO_TXT, ACAO_TXT,
  config, salvarConfig, designado, papeisDe, temPapel, bootstrapPermitido, escopo, veLoja, gerenteDa, rhDa, vePainel,
  auditar, auditoria, notificar, notificacoes, marcarLidas, syncEstado, syncRegistrar,
  classificar, sincronizarBancoHoras, painelBancoHoras, alertaBH, providenciaAlerta, ultimoSaldo, colabInfo,
  criarSolicitacao, editarSolicitacao, executar, acoesSol, listarSols, detalheSol, resumoSol, obterSol,
  sincronizarPonto, listarOcorrencias, tratarOcorrencia, acoesOcorrencia,
  painelQuadro, listarDocumentos, salvarDocumento, checklistAdmissional, listarAtendimentos, salvarAtendimento,
  centralAlertas, indicadores, minhaFila, resumoColab, montarRelatorioSemanal, relatorioSemanal, relatoriosSalvos, tick, recarregar,
  _util: { diaISO, somaDu, proximoDiaSemana, hhmm },
};
