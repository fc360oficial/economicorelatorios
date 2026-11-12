'use strict';
// lib/vagas.js — Controle de vagas em aberto e quadro de pessoal (DP / RH › Vagas e Quadro de Pessoal, 12/11/2026).
//
// O que este módulo GUARDA (data/vagas, só aqui):
//   · desligamentos.json  o movimento de saída CONFIRMADO PELO RH (desligamento ou transferência entre unidades): data do
//                         desligamento contratual, último dia efetivamente trabalhado, aviso prévio (trabalhado / indenizado),
//                         se a posição precisa de reposição, registro manual do S-2299 e o histórico de alterações
//   · vagas.json          a vaga: unidade, setor, cargo, turno de referência, ocupante anterior, situação (aberta → aguardando
//                         autorização → reposição autorizada → em recrutamento → contratação em andamento → preenchida, ou
//                         cancelada), substituto vinculado, observações e histórico
//   · alertas.json        quais avisos já saíram (vaga aberta, compromete a cobertura, 7/15/30 dias, preenchida, cancelada)
//   · sync.json           última leitura do ponto (em que unidade cada um estava e quais desligamentos já foram vistos)
//   · auditoria.jsonl     trilha encadeada por hash: responsável, data/hora, ação, justificativa, antes e depois
// O que ele só LÊ de quem já é dono do dado:
//   · cadastro (unidade, setor, cargo, admissão, data de desligamento) ... ponto (pontocerto.colaboradores) — nunca escreve lá
//   · quadro autorizado por unidade e setor ............................. Gestão de Pessoas › Configurações (GP.config().quadro)
//   · solicitação de reposição/ampliação aprovada ....................... Gestão de Pessoas (GP.obterSol)
//   · escala, jornada-base e mínimo de cobertura por setor .............. Escalas (lib/escalas.js)
//
// O ponto só informa a DATA de desligamento do cadastro: motivo, aviso prévio e último dia trabalhado não existem lá. Por isso
// o desligamento que o ponto mostra entra aqui como "a confirmar" e só produz efeito (sair da escala, abrir vaga) depois que o
// RH confirma e completa os dados. Não existe integração com o eSocial: o S-2299 é só a referência do processo e o envio é
// registrado à mão. Ninguém é apagado: quem sai continua no cadastro, na escala gravada e no histórico; a escala apenas deixa
// de contar a pessoa a partir do dia seguinte ao último dia trabalhado (lib/escalas.js › definirQuadro), e volta a contar se o
// desligamento for cancelado.
//
// A VAGA nunca é presença: ela aparece na grade como linha "VAGA EM ABERTO" desenhada pela tela, fora de `funcionarios`, e por
// isso não entra em horas, jornada realizada nem cobertura.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const GP = require('./gestao-pessoas');
const E = require('./escalas');

const DIR = process.env.VAGAS_DIR || path.join(__dirname, '..', 'data', 'vagas');
const P = { desl: () => path.join(DIR, 'desligamentos.json'), vagas: () => path.join(DIR, 'vagas.json'), alertas: () => path.join(DIR, 'alertas.json'), sync: () => path.join(DIR, 'sync.json'), aud: () => path.join(DIR, 'auditoria.jsonl') };
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
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();   // igual à chave do quadro autorizado
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; } };
function gravarJson(arq, obj) { fs.mkdirSync(path.dirname(arq), { recursive: true }); const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, arq); cacheQ = null; }
const lerLinhas = arq => { try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const quem = u => u ? { usuario: u.usuario, nome: u.nome || u.usuario, papeis: GP.papeisDe(u) } : { usuario: 'sistema', nome: 'Sistema', papeis: [] };
const lojaTxt = l => GP.LOJA_TXT[l] || String(l);

const CFG = { alertaDias: [7, 15, 30], janelaPontoDias: 30, coberturaDias: 7, janelaCandidatoDias: 15, esocialPrazoDias: 10 };

// ── Permissões ───────────────────────────────────────────────────────────────────────────────────────────
// ver: quem já vê a central de pessoas (gerente da loja, RH, Coordenação, Diretoria) e o Jurídico, dentro das lojas dele.
// desligamento (datas, aviso prévio, motivo, S-2299) e andamento da vaga: só o RH que atende a unidade.
// Coordenação: acompanha tudo, autoriza a reposição, cancela a vaga (posição extinta) e comenta — não altera dado contratual.
// motivo do desligamento: RH, Coordenação, Diretoria e Jurídico; o gerente vê que a pessoa saiu e as datas, nada além.
const ehRH = u => GP.temPapel(u, ...GP.RH);
const ehCoord = u => GP.temPapel(u, 'coordenacao');
const veLoja = (u, loja) => GP.temPapel(u, 'juridico') || GP.veLoja(u, loja);
const podeVer = (u, loja) => (GP.vePainel(u) || GP.temPapel(u, 'juridico')) && (loja == null || veLoja(u, loja));
const podeRH = (u, loja) => GP.rhDa(u, loja);
const veMotivo = u => ehRH(u) || GP.temPapel(u, 'coordenacao', 'diretoria', 'juridico');
const veAuditoria = veMotivo;
const exige = (cond, msg) => { if (!cond) throw erro(msg, 403); };

// ── Auditoria encadeada (só acrescenta; cada linha leva o hash da anterior) ──────────────────────────────
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function auditar(user, acao, dados) {
  const l = lerLinhas(P.aud()); const ant = l.length ? l[l.length - 1].hash : '';
  const reg = { seq: l.length + 1, em: agora(), ...quem(user), acao, ...(dados || {}), ant }; reg.hash = sha(ant + JSON.stringify(reg));
  fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(P.aud(), JSON.stringify(reg) + '\n');
  try { GP.auditar({ usuario: reg.usuario, acao: 'vagas_' + acao, ref: dados && dados.ref || null }); } catch (e) {}
  return reg;
}
function verificarCadeia() { const l = lerLinhas(P.aud()); let ant = ''; for (const r of l) { const { hash, ...resto } = r; if (r.ant !== ant || sha(ant + JSON.stringify(resto)) !== hash) return { ok: false, registros: l.length, quebradaEm: r.seq }; ant = hash; } return { ok: true, registros: l.length, quebradaEm: null }; }
function trilha(user, f = {}) {
  exige(veAuditoria(user), 'Sem acesso à auditoria'); let l = lerLinhas(P.aud()).filter(r => r.loja == null || veLoja(user, r.loja));
  if (f.loja) l = l.filter(r => +r.loja === +f.loja); if (f.ref) l = l.filter(r => r.ref === f.ref || r.vaga === f.ref || r.desligamento === f.ref);
  if (!veMotivo(user)) l = l.map(r => ({ ...r, antes: undefined, depois: undefined }));
  return { cadeia: verificarCadeia(), registros: l.reverse().slice(0, 1000) };
}

// ── Listas ───────────────────────────────────────────────────────────────────────────────────────────────
const MOVIMENTO = { desligamento: 'Desligamento', transferencia: 'Transferência entre unidades' };
const AVISO = { trabalhado: 'Aviso prévio trabalhado', indenizado: 'Aviso prévio indenizado', nao_se_aplica: 'Sem aviso prévio' };
const MOTIVO = { sem_justa_causa: 'Dispensa sem justa causa', pedido_demissao: 'Pedido de demissão', termino_contrato: 'Término de contrato (experiência / prazo determinado)', acordo: 'Rescisão por acordo', justa_causa: 'Dispensa por justa causa', aposentadoria: 'Aposentadoria', falecimento: 'Falecimento', outro: 'Outro' };
const REPOSICAO = { necessaria: 'Reposição necessária', posicao_extinta: 'Posição extinta (sem reposição)', sem_perda: 'Transferência sem perda de quadro' };
const STATUS = { aberta: 'Aberta', aguardando_autorizacao: 'Aguardando autorização', reposicao_autorizada: 'Reposição autorizada', em_recrutamento: 'Em recrutamento', contratacao_em_andamento: 'Contratação em andamento', preenchida: 'Preenchida', cancelada: 'Cancelada' };
const FINAIS = ['preenchida', 'cancelada'];
const ABERTAS = ['aberta', 'aguardando_autorizacao', 'reposicao_autorizada'];      // vaga em aberto, sem recrutamento iniciado
const RECRUTANDO = ['em_recrutamento', 'contratacao_em_andamento'];
const CANCELAMENTO = { posicao_extinta: 'Posição extinta', desligamento_cancelado: 'Desligamento cancelado', outro: 'Outro motivo' };

// ── Dados ────────────────────────────────────────────────────────────────────────────────────────────────
const desligamentos = () => lerJson(P.desl(), {});
const vagas = () => lerJson(P.vagas(), {});
const proximoId = (obj, pre, ano) => pre + '-' + ano + '-' + String(Object.keys(obj).filter(k => k.startsWith(pre + '-' + ano + '-')).length + 1).padStart(4, '0');
const h = (user, acao, texto, extra) => ({ em: agora(), ...quem(user), acao, texto: txt(texto, 600) || null, ...(extra || {}) });
async function quadro(deps) { const c = await deps.colaboradores(); const ativos = c.ativos || [], desligados = c.desligados || []; return { ativos, desligados, todos: [...ativos, ...desligados], bruto: { ativos, desligados } }; }
/** registro ativo (confirmado) de saída de um funcionário, se houver */
const saidaAtiva = (D0, funcId) => Object.values(D0).find(d => d.status === 'confirmado' && String(d.funcId) === String(funcId)) || null;

// ── Escala: quem saiu deixa de contar; o substituto só conta a partir do início ──────────────────────────
let cacheQ = null;
function mapaQuadro() {
  const t = Date.now(); if (cacheQ && t - cacheQ.em < 1500) return cacheQ.mapa;
  let mt = ''; for (const a of [P.desl(), P.vagas()]) { try { mt += fs.statSync(a).mtimeMs + '|'; } catch (e) { mt += '0|'; } }
  if (cacheQ && cacheQ.mt === mt) { cacheQ.em = t; return cacheQ.mapa; }
  const mapa = new Map(); const add = (loja, id, campo, v) => { const k = loja + '|' + id; mapa.set(k, { ...(mapa.get(k) || {}), [campo]: v }); };
  for (const d of Object.values(desligamentos())) if (d.status === 'confirmado' && d.ultimoDiaTrabalhado) add(d.loja, d.funcId, 'fim', d.ultimoDiaTrabalhado);
  for (const v of Object.values(vagas())) if (v.status === 'preenchida' && v.substituto && v.substituto.inicio && v.substituto.origem !== 'interno') add(v.loja, v.substituto.funcId, 'inicio', v.substituto.inicio);   // quem já era da unidade (movimentação interna) segue com a escala que tinha
  cacheQ = { em: t, mt, mapa }; return mapa;
}
E.definirQuadro((loja, funcId) => mapaQuadro().get(loja + '|' + funcId) || null);

/** Setor e cargo da posição: o da escala da unidade (quando a pessoa está nela), senão o do cadastro do ponto. */
function posicaoDe(loja, c, dia) {
  let f = null; for (const mes of [dia.slice(0, 7), soma(dia.slice(0, 7) + '-01', -1).slice(0, 7)]) { const e = E.ler(loja, mes); f = e && e.funcionarios.find(x => String(x.id) === String(c.id)); if (f) break; }
  const setorPonto = f ? (f.setor_pc || c.setor) : c.setor;
  return { setor: semAcento(setorPonto || '—'), setorEscala: f ? f.setor : E.setorOperacional(setorPonto), cargo: (f && f.cargo) || c.cargo || '', turnoRef: turnoRef(loja, f, c) };
}
/** Turno de referência: a jornada mais frequente da escala-base de quem ocupava a posição (classificada como a grade classifica). */
function turnoRef(loja, f, c) {
  const cont = new Map(); if (f && f.base) for (const b of Object.values(f.base)) if (b && b.entrada && b.saida) { const k = [b.entrada, b.saida, b.almoco_ini || '', b.almoco_fim || ''].join('|'); cont.set(k, (cont.get(k) || 0) + 1); }
  if (!cont.size) return { texto: txt(c && c.turno, 80) || 'não informado', origem: 'ponto', entrada: null, saida: null };
  const [entrada, saida, ai, af] = [...cont.entries()].sort((a, b) => b[1] - a[1])[0][0].split('|'); const t = { entrada, saida, almoco_ini: ai || null, almoco_fim: af || null, texto: entrada + '–' + saida, origem: 'escala' };
  try { const S5 = require('./escalas-5x2'); const M = require('./escalas-gerador'); const T = S5.turnosLoja(loja); t.classe = M.classificarTurno({ tipo: 'trabalho', entrada, saida }, T.setores[f.setor] || T.unidade); t.classeTxt = S5.CLASSE_TXT[t.classe] || null; } catch (e) {}
  return t;
}

// ── Quadro de pessoal da posição: ela continua autorizada? ───────────────────────────────────────────────
/** autorizado = quadro definido pela Coordenação (null = não definido); efetivo = ativos do ponto sem quem já tem saída confirmada. */
function situacaoQuadro(loja, setor, q, st, semFunc) {
  const k = +loja + '|' + setor; const aut = (GP.config().quadro || {})[k]; const saiu = new Set(Object.values(st.D).filter(d => d.status === 'confirmado' && +d.loja === +loja).map(d => String(d.funcId))); if (semFunc != null) saiu.add(String(semFunc));
  const efetivo = q.ativos.filter(c => +c.loja === +loja && semAcento(c.setor || '—') === setor && !saiu.has(String(c.id))).length;
  const abertas = Object.values(st.V).filter(v => !FINAIS.includes(v.status) && +v.loja === +loja && v.setor === setor).length;
  return { autorizado: aut != null ? aut : null, efetivo, vagasAbertas: abertas, dentro: aut != null && efetivo + abertas < aut };
}

// ── Avisos (RH da unidade + Coordenação) ─────────────────────────────────────────────────────────────────
function avisar(tipo, v, texto, chave, so) {
  const para = [...new Set([...GP.usuariosPara(GP.RH, v.loja), ...(so === 'rh' ? [] : GP.usuariosPara(['coordenacao'], v.loja))])];
  GP.notificar(para, texto, { aba: 'vagas', vaga: v.id || null }); const a = lerJson(P.alertas(), {}); a[chave || ((v.id || 'GERAL') + '|' + tipo)] = { em: agora(), tipo, vaga: v.id || null, para }; gravarJson(P.alertas(), a);
  return { tipo, vaga: v.id || null, loja: v.loja, para, texto };
}
const rotuloVaga = v => v.id + ' · ' + lojaTxt(v.loja) + ' · ' + E.setorTxt(v.setorEscala) + (v.cargo ? ' · ' + v.cargo : '');

// ── Cobertura: a vaga compromete o mínimo do setor? ──────────────────────────────────────────────────────
const faixaDoBloco = (t, cob) => { const abre = E._util.min(cob.abre), fecha = E._util.min(cob.fecha); return t < abre + 60 ? 'abertura' : t >= fecha - 60 ? 'fechamento' : 'intermediario'; };
const cobre = (b, t) => !!(b && b.entrada && b.saida) && E.estadoEm({ tipo: 'trabalho', ...b }, t) === 'disponivel';
function memoEscalas(afast) { const m = new Map(); return (loja, mes) => { const k = loja + '|' + mes; if (!m.has(k)) { const e = E.ler(loja, mes); m.set(k, e ? { e, funcs: E.resolver(e, afast || null) } : null); } return m.get(k); }; }
/** Nos próximos dias (a partir de hoje ou do dia em que a posição fica vaga), quantos blocos de 15 min do setor ficam ABAIXO do
 *  mínimo no horário que a pessoa que saiu cobriria. Sem escala no mês ou sem mínimo cadastrado para o setor = não avaliável. */
function impactoCobertura(v, hoje, afast, memo) {
  const ini = v.desde > hoje ? v.desde : hoje; const out = { de: ini, ate: soma(ini, CFG.coberturaDias - 1), diasAvaliados: 0, semEscala: 0, semMinimo: false, blocos: 0, dias: [], porTurno: { abertura: 0, intermediario: 0, fechamento: 0 } };
  const get = memo || memoEscalas(afast); const DOW = E._util.dow;
  for (let i = 0; i < CFG.coberturaDias; i++) {
    const data = soma(ini, i); const x = get(v.loja, data.slice(0, 7)); if (!x) { out.semEscala++; continue; }
    const cob = E.cobertura(v.loja, data, x.funcs); const S = cob.setores.find(s => s.setor === v.setorEscala); if (!S) continue; if (!S.min) { out.semMinimo = true; continue; } out.diasAvaliados++;
    const f = v.ocupanteAnterior && x.e.funcionarios.find(y => String(y.id) === String(v.ocupanteAnterior.funcId)); const ref = f ? f.base[DOW(data)] : (v.turnoRef && v.turnoRef.entrada ? v.turnoRef : null);
    let n = 0; for (const b of S.blocos) if (b.status === 'baixa' && cobre(ref, b.t)) { n++; out.porTurno[faixaDoBloco(b.t, cob)]++; }
    if (n) { out.blocos += n; out.dias.push({ data, blocos: n }); }
  }
  out.avaliavel = out.diasAvaliados > 0; out.compromete = out.blocos > 0; return out;
}
/** Cobertura dos próximos dias por setor da unidade, separando o que falta por VAGA (quem saiu) do que falta por AUSÊNCIA
 *  TEMPORÁRIA (férias, afastamento) — a mesma faixa pode ter as duas causas. */
function coberturaUnidade(loja, hoje, afast, st) {
  const get = memoEscalas(afast); const DOW = E._util.dow; const out = {}; const zero = () => ({ abertura: 0, intermediario: 0, fechamento: 0 });
  const S0 = s => out[s] || (out[s] = { setorEscala: s, diasAvaliados: 0, semMinimo: false, semEscala: 0, abaixo: zero(), porVaga: zero(), porAusencia: zero() });
  const avulsas = Object.values(st.V).filter(v => !FINAIS.includes(v.status) && +v.loja === +loja);
  for (let i = 0; i < CFG.coberturaDias; i++) {
    const data = soma(hoje, i); const x = get(loja, data.slice(0, 7)); if (!x) { for (const s of new Set(avulsas.map(v => v.setorEscala))) S0(s).semEscala++; continue; }
    const cob = E.cobertura(loja, data, x.funcs);
    for (const S of cob.setores) {
      const r = S0(S.setor); if (!S.min) { r.semMinimo = true; continue; } r.diasAvaliados++;
      const doSetor = x.funcs.filter(f => f.setor === S.setor && f.dias[data]); const fora = doSetor.filter(f => f.dias[data].tipo === 'saiu'), aus = doSetor.filter(f => ['ferias', 'afastado'].includes(f.dias[data].tipo));
      const semOcupante = avulsas.filter(v => v.setorEscala === S.setor && v.desde <= data && v.turnoRef && v.turnoRef.entrada && !(v.ocupanteAnterior && x.e.funcionarios.some(y => String(y.id) === String(v.ocupanteAnterior.funcId))));
      for (const b of S.blocos) { if (b.status !== 'baixa') continue; const fx = faixaDoBloco(b.t, cob); r.abaixo[fx]++;
        if (fora.some(f => cobre(f.base[DOW(data)], b.t)) || semOcupante.some(v => cobre(v.turnoRef, b.t))) r.porVaga[fx]++;
        if (aus.some(f => cobre(f.base[DOW(data)], b.t))) r.porAusencia[fx]++; }
    }
  }
  return out;
}

// ── Visões ───────────────────────────────────────────────────────────────────────────────────────────────
function podeNaVaga(u, v) {
  const rh = podeRH(u, v.loja), co = ehCoord(u), aberta = !FINAIS.includes(v.status); const p = { status: [], autorizar: false, observacao: (rh || co) && podeVer(u, v.loja), vincular: false, desvincular: false, preencher: false, cancelar: false };
  if (!aberta) return p;
  if (rh) { p.status = v.substituto ? [] : ['aberta', 'aguardando_autorizacao'].concat(v.autorizacao ? ['em_recrutamento', 'contratacao_em_andamento'] : []).filter(s => s !== v.status); p.vincular = !!v.autorizacao && !v.substituto; p.desvincular = !!v.substituto; p.preencher = !!v.substituto; }
  p.autorizar = !v.autorizacao && (co || rh); p.cancelar = rh || co; return p;
}
function visaoVaga(v, user, hoje) {
  const futura = v.desde > hoje; const fim = v.status === 'preenchida' && v.substituto ? v.substituto.inicio : v.encerradaEm;
  return { ...v, lojaTxt: lojaTxt(v.loja), setorTxt: E.setorTxt(v.setorEscala), statusTxt: STATUS[v.status], autorizada: !!v.autorizacao, futura,
    diasAberta: futura ? 0 : Math.max(0, diasEntre(v.desde, FINAIS.includes(v.status) && fim ? (fim < hoje ? fim : hoje) : hoje)), ocupanteAnterior: v.ocupanteAnterior || null, pode: podeNaVaga(user, v) };
}
/** O que o ponto diz agora sobre a pessoa do registro — a validação de status do desligamento. */
function pontoDe(d, q, hoje) {
  const c = q.todos.find(x => String(x.id) === String(d.funcId)); if (!c) return { situacao: 'nao_encontrado', divergencias: [{ codigo: 'nao_encontrado', texto: 'O funcionário não aparece mais no cadastro do ponto.' }] };
  const ativo = c.ativo !== false && !q.desligados.includes(c); const p = { situacao: ativo ? 'ativo' : 'desligado', desligamento: c.desligamento || null, loja: +c.loja, divergencias: [] };
  if (d.movimento === 'desligamento') {
    if (d.status === 'confirmado') {
      if (ativo && d.dataDesligamento < hoje) p.divergencias.push({ codigo: 'ativo_no_ponto', texto: 'O ponto ainda mostra ' + d.nome + ' como ativo depois da data do desligamento (' + br(d.dataDesligamento) + '): dê baixa no cadastro do ponto ou retifique a data aqui.' });
      if (!ativo && c.desligamento && c.desligamento !== d.dataDesligamento) p.divergencias.push({ codigo: 'data_diferente', texto: 'A data de desligamento no ponto (' + br(c.desligamento) + ') é diferente da registrada pelo RH (' + br(d.dataDesligamento) + '): confira e retifique o que estiver errado.' });
    } else if (d.status === 'cancelado' && !ativo) p.divergencias.push({ codigo: 'cancelado_desligado_no_ponto', texto: 'O desligamento foi cancelado aqui, mas o ponto mostra ' + d.nome + ' como desligado' + (c.desligamento ? ' em ' + br(c.desligamento) : '') + '.' });
  } else if (d.status === 'confirmado') {
    if (!ativo) p.divergencias.push({ codigo: 'desligado_no_ponto', texto: 'Registrado como transferência, mas o ponto mostra ' + d.nome + ' como desligado' + (c.desligamento ? ' em ' + br(c.desligamento) : '') + '.' });
    else if (+c.loja !== +d.lojaDestino && d.dataTransferencia <= hoje) p.divergencias.push({ codigo: 'ponto_nao_atualizado', texto: 'O ponto ainda mostra ' + d.nome + ' em ' + lojaTxt(c.loja) + ': atualize a unidade no cadastro do ponto (destino: ' + lojaTxt(d.lojaDestino) + ').' });
  }
  return p;
}
function visaoDesl(d, user, q, hoje, st) {
  const sens = veMotivo(user); const v = d.vagaId ? st.V[d.vagaId] : null; const rh = podeRH(user, d.loja); const conf = d.status === 'confirmado';
  const prazo = d.movimento === 'desligamento' ? soma(d.dataDesligamento, CFG.esocialPrazoDias) : null;
  return { ...d, motivo: sens ? d.motivo : null, motivoTxt: sens ? (MOTIVO[d.motivo] || null) : null, obs: sens ? d.obs : null, historico: sens ? d.historico : d.historico.map(x => ({ em: x.em, nome: x.nome, acao: x.acao })),
    movimentoTxt: MOVIMENTO[d.movimento], avisoTxt: d.avisoPrevio ? AVISO[d.avisoPrevio] : null, reposicaoTxt: REPOSICAO[d.reposicao], statusTxt: conf ? 'Confirmado' : 'Cancelado', lojaTxt: lojaTxt(d.loja), lojaDestinoTxt: d.lojaDestino ? lojaTxt(d.lojaDestino) : null, setorTxt: E.setorTxt(d.setorEscala),
    indisponivelDesde: soma(d.ultimoDiaTrabalhado, 1), ponto: q ? pontoDe(d, q, hoje) : null,
    esocial: d.movimento === 'desligamento' ? { evento: 'S-2299', ...(d.esocial && d.esocial.s2299 ? { registrado: true, ...d.esocial.s2299 } : { registrado: false }), prazoReferencia: prazo, atrasado: conf && !(d.esocial && d.esocial.s2299) && prazo < hoje,
      nota: 'Referência do processo: o S-2299 (Desligamento) é enviado pela folha/contabilidade. Este sistema não acessa o eSocial — aqui o RH só registra que o evento foi enviado. Prazo de referência: até ' + CFG.esocialPrazoDias + ' dias após o desligamento; confirme com a contabilidade.' } : null,
    vaga: v ? { id: v.id, status: v.status, statusTxt: STATUS[v.status], desde: v.desde } : null, pode: { retificar: rh && conf, cancelar: rh && conf, esocial: rh && conf && d.movimento === 'desligamento', reposicao: rh && conf } };
}

// ── Vagas: criar ─────────────────────────────────────────────────────────────────────────────────────────
function criarVaga(user, st, dados, hoje) {
  const id = proximoId(st.V, 'VG', hoje.slice(0, 4)); const Q = dados.quadro;
  const v = { id, loja: +dados.loja, setor: dados.setor, setorEscala: dados.setorEscala, cargo: txt(dados.cargo, 120), turnoRef: dados.turnoRef || { texto: 'não informado', origem: 'manual', entrada: null, saida: null }, origem: dados.origem, tipo: dados.tipo || 'reposicao', desligamentoId: dados.desligamentoId || null,
    ocupanteAnterior: dados.ocupanteAnterior || null, abertaEm: hoje, desde: dados.desde, status: Q.dentro ? 'aberta' : 'aguardando_autorizacao', quadro: { autorizado: Q.autorizado, efetivo: Q.efetivo, vagasAbertas: Q.vagasAbertas, dentro: Q.dentro, em: hoje }, autorizacao: null, solicitacao: null, substituto: null, encerradaEm: null, cancelamento: null, revisar: null,
    observacoes: [], criadaPor: quem(user), criadaEm: agora(), historico: [] };
  const porque = Q.autorizado == null ? 'o quadro autorizado de ' + lojaTxt(v.loja) + ' · ' + v.setor + ' não está definido: a reposição aguarda autorização da Coordenação' : Q.dentro ? 'posição dentro do quadro autorizado (' + Q.efetivo + ' de ' + Q.autorizado + ' no setor)' : 'o setor já está no quadro autorizado (' + Q.efetivo + ' de ' + Q.autorizado + '): a vaga aguarda autorização da Coordenação';
  v.historico.push(h(user, 'aberta', 'Vaga aberta' + (dados.origem === 'manual' ? ' pelo RH' : ' automaticamente pela saída de ' + (v.ocupanteAnterior ? v.ocupanteAnterior.nome : '—')) + ' — ' + porque + '.', { para: v.status }));
  st.V[id] = v; return v;
}
function avisosDaAbertura(v, hoje, afast) {
  const out = [avisar('vaga_aberta', v, 'VAGA EM ABERTO ' + rotuloVaga(v) + ': ' + (v.ocupanteAnterior ? 'saída de ' + v.ocupanteAnterior.nome + ', ' : '') + 'posição vaga a partir de ' + br(v.desde) + ' · ' + STATUS[v.status] + '.')];
  try { const imp = impactoCobertura(v, hoje, afast || null); if (imp.compromete) out.push(avisar('vaga_cobertura', v, 'A vaga ' + rotuloVaga(v) + ' COMPROMETE a cobertura mínima: ' + imp.blocos + ' faixa(s) de 15 min abaixo do mínimo em ' + imp.dias.length + ' dia(s) de ' + br(imp.de) + ' a ' + br(imp.ate) + '.')); } catch (e) {}
  return out;
}

// ── Desligamento / transferência: o RH confirma ──────────────────────────────────────────────────────────
function datasDoMovimento(b, c, mov) {
  if (mov === 'transferencia') {
    const dt = String(b.dataTransferencia || ''); if (!ISO.test(dt)) throw erro('Informe a data da transferência (primeiro dia na unidade de destino)');
    return { dataDesligamento: null, dataTransferencia: dt, ultimoDiaTrabalhado: soma(dt, -1), avisoPrevio: null, motivo: null };
  }
  const data = String(b.dataDesligamento || ''); if (!ISO.test(data)) throw erro('Informe a data do desligamento contratual');
  const aviso = String(b.avisoPrevio || ''); if (!AVISO[aviso]) throw erro('Informe o aviso prévio: trabalhado, indenizado ou sem aviso');
  const ult = String(b.ultimoDiaTrabalhado || (aviso === 'indenizado' ? '' : data)); if (!ISO.test(ult)) throw erro(aviso === 'indenizado' ? 'Aviso prévio indenizado: informe o último dia efetivamente trabalhado (a data do desligamento contratual inclui a projeção do aviso)' : 'Informe o último dia efetivamente trabalhado');
  if (ult > data) throw erro('O último dia trabalhado (' + br(ult) + ') não pode ser depois da data do desligamento contratual (' + br(data) + ')');
  if (c && c.admissao && data < c.admissao) throw erro('A data do desligamento (' + br(data) + ') é anterior à admissão (' + br(c.admissao) + ')');
  const motivo = String(b.motivo || ''); if (!MOTIVO[motivo]) throw erro('Informe o tipo de desligamento');
  return { dataDesligamento: data, dataTransferencia: null, ultimoDiaTrabalhado: ult, avisoPrevio: aviso, motivo };
}
/** Trata a posição de quem saiu: abre a vaga quando a reposição é necessária e a posição cabe (ou pode caber) no quadro. */
function tratarPosicao(user, st, d, q, hoje) {
  if (d.reposicao !== 'necessaria') { d.semVaga = { motivo: d.reposicao, texto: d.reposicao === 'sem_perda' ? 'Transferência sem perda de quadro: nenhuma vaga foi aberta.' : 'Posição extinta: nenhuma vaga foi aberta. Se o quadro autorizado do setor mudou, a Coordenação ajusta em Gestão de Pessoas › Configurações.' }; return null; }
  const Q = situacaoQuadro(d.loja, d.setor, q, st, d.funcId);
  if (Q.autorizado != null && !Q.dentro) { d.semVaga = { motivo: 'quadro_completo', autorizado: Q.autorizado, efetivo: Q.efetivo, vagasAbertas: Q.vagasAbertas, texto: 'O setor já está no quadro autorizado sem esta posição (' + Q.efetivo + ' ativo(s) + ' + Q.vagasAbertas + ' vaga(s) de ' + Q.autorizado + ' autorizado(s)): nenhuma vaga foi aberta automaticamente. O RH pode abrir uma vaga, que fica aguardando autorização.' }; return null; }
  d.semVaga = null; const v = criarVaga(user, st, { loja: d.loja, setor: d.setor, setorEscala: d.setorEscala, cargo: d.cargo, turnoRef: d.turnoRef, origem: d.movimento, desligamentoId: d.id, ocupanteAnterior: { funcId: d.funcId, nome: d.nome, matricula: d.matricula }, desde: soma(d.ultimoDiaTrabalhado, 1), quadro: Q }, hoje);
  d.vagaId = v.id; return v;
}
async function registrarDesligamento(user, b, deps, hoje = hojeISO()) {
  b = b || {}; const q = await quadro(deps); const c = q.todos.find(x => String(x.id) === String(b.funcId)); if (!c) throw erro('Funcionário não encontrado no cadastro do ponto', 404);
  const mov = b.movimento === 'transferencia' ? 'transferencia' : 'desligamento'; const ativo = !q.desligados.includes(c);
  let loja = +c.loja, lojaDestino = null;
  if (mov === 'transferencia') {
    lojaDestino = +b.lojaDestino; if (!GP.LOJAS.includes(lojaDestino)) throw erro('Informe a unidade de destino');
    if (b.lojaOrigem != null && b.lojaOrigem !== '') loja = +b.lojaOrigem; if (!GP.LOJAS.includes(loja)) throw erro('Unidade de origem inválida');
    if (loja === lojaDestino) throw erro(+c.loja === lojaDestino ? 'O ponto já mostra ' + c.nome + ' em ' + lojaTxt(lojaDestino) + ': informe a unidade de ORIGEM da transferência' : 'Origem e destino são a mesma unidade');
    if (!ativo) throw erro(c.nome + ' consta como desligado no ponto' + (c.desligamento ? ' em ' + br(c.desligamento) : '') + ': registre como desligamento, não como transferência', 409);
  }
  exige(podeRH(user, loja), 'Só o RH que atende a unidade confirma desligamento ou transferência');
  const just = txt(b.justificativa); if (just.length < 5) throw erro('Justificativa obrigatória (mínimo de 5 caracteres): ela fica na auditoria');
  const st = { D: desligamentos(), V: vagas() }; const ja = saidaAtiva(st.D, c.id); if (ja) throw erro('Já existe saída confirmada para ' + c.nome + ' (' + ja.id + ', ' + MOVIMENTO[ja.movimento].toLowerCase() + '): retifique ou cancele aquele registro', 409, { duplicada: ja.id });
  const datas = datasDoMovimento(b, c, mov);
  const rep = mov === 'transferencia' ? (b.reposicao === 'necessaria' ? 'necessaria' : 'sem_perda') : String(b.reposicao || ''); if (!['necessaria', 'posicao_extinta', 'sem_perda'].includes(rep) || (mov === 'desligamento' && rep === 'sem_perda')) throw erro('Informe se a posição precisa de reposição ou foi extinta');
  const pos = posicaoDe(loja, c, datas.ultimoDiaTrabalhado); const id = proximoId(st.D, 'DSL', hoje.slice(0, 4));
  const d = { id, movimento: mov, funcId: c.id, nome: c.nome, matricula: c.matricula || '', loja, ...pos, admissao: c.admissao || null, ...datas, lojaDestino, setorDestino: txt(b.setorDestino, 80) || null, reposicao: rep, status: 'confirmado',
    origem: !ativo && c.desligamento ? 'ponto' : 'lancamento_rh', pontoNoRegistro: { situacao: ativo ? 'ativo' : 'desligado', desligamento: c.desligamento || null, loja: +c.loja }, esocial: { s2299: null }, vagaId: null, semVaga: null, obs: txt(b.obs, 600) || null, confirmadoPor: quem(user), confirmadoEm: agora(), historico: [] };
  d.historico.push(h(user, 'confirmado', just));
  const v = tratarPosicao(user, st, d, q, hoje); st.D[id] = d; gravarJson(P.desl(), st.D); if (v) gravarJson(P.vagas(), st.V);
  auditar(user, 'desligamento_confirmar', { ref: id, loja, funcId: c.id, funcionario: c.nome, justificativa: just, depois: { movimento: mov, ...datas, lojaDestino, reposicao: rep, setor: d.setor, cargo: d.cargo, vaga: v ? v.id : null, semVaga: d.semVaga ? d.semVaga.motivo : null } });
  if (v) auditar(user, 'vaga_abrir', { ref: v.id, loja, desligamento: id, justificativa: 'Abertura automática pela saída de ' + c.nome, depois: { status: v.status, desde: v.desde, setor: v.setor, cargo: v.cargo, quadro: v.quadro } });
  const avisos = v ? avisosDaAbertura(v, hoje) : [];
  const P0 = pontoDe(d, q, hoje);
  return { desligamento: visaoDesl(d, user, q, hoje, st), vaga: v ? visaoVaga(v, user, hoje) : null, semVaga: d.semVaga, avisos, alertasPonto: P0.divergencias.map(x => x.texto) };
}
function carregarDesl(id) { const st = { D: desligamentos(), V: vagas() }; const d = st.D[String(id || '').toUpperCase()]; if (!d) throw erro('Registro não encontrado', 404); return { st, d }; }
const fotoDesl = d => ({ dataDesligamento: d.dataDesligamento, dataTransferencia: d.dataTransferencia, ultimoDiaTrabalhado: d.ultimoDiaTrabalhado, avisoPrevio: d.avisoPrevio, motivo: d.motivo, reposicao: d.reposicao, status: d.status });
/** Rearma os avisos de prazo da vaga quando a data em que a posição fica vaga muda. */
function rearmarAlertas(v, hoje) { const a = lerJson(P.alertas(), {}); const dias = diasEntre(v.desde, hoje); let mudou = false; for (const t of CFG.alertaDias) if (t > dias && a[v.id + '|dias|' + t]) { delete a[v.id + '|dias|' + t]; mudou = true; } if (a[v.id + '|vaga_cobertura']) { delete a[v.id + '|vaga_cobertura']; mudou = true; } if (mudou) gravarJson(P.alertas(), a); }
async function alterarDesligamento(user, id, b, deps, hoje = hojeISO()) {
  b = b || {}; const { st, d } = carregarDesl(id); exige(podeRH(user, d.loja), 'Só o RH que atende a unidade altera o registro de desligamento'); const acao = String(b.acao || '');
  const just = txt(b.justificativa); if (just.length < 5) throw erro('Justificativa obrigatória (mínimo de 5 caracteres): ela fica na auditoria');
  if (d.status !== 'confirmado') throw erro('Este registro foi cancelado em ' + br((d.canceladoEm || '').slice(0, 10)) + ': para registrar de novo, lance um novo desligamento', 409);
  const q = await quadro(deps); const c = q.todos.find(x => String(x.id) === String(d.funcId)) || null; const antes = fotoDesl(d); const v = d.vagaId ? st.V[d.vagaId] : null; const avisos = [];
  if (acao === 'retificar') {
    const novo = datasDoMovimento({ dataDesligamento: b.dataDesligamento != null ? b.dataDesligamento : d.dataDesligamento, ultimoDiaTrabalhado: b.ultimoDiaTrabalhado != null ? b.ultimoDiaTrabalhado : d.ultimoDiaTrabalhado, avisoPrevio: b.avisoPrevio || d.avisoPrevio, motivo: b.motivo || d.motivo, dataTransferencia: b.dataTransferencia || d.dataTransferencia }, c, d.movimento);
    if (JSON.stringify(novo) === JSON.stringify({ dataDesligamento: d.dataDesligamento, dataTransferencia: d.dataTransferencia, ultimoDiaTrabalhado: d.ultimoDiaTrabalhado, avisoPrevio: d.avisoPrevio, motivo: d.motivo })) throw erro('Nada foi alterado');
    Object.assign(d, novo); d.historico.push(h(user, 'retificado', just, { antes, depois: fotoDesl(d) }));
    // a vaga acompanha: a posição fica vaga no dia seguinte ao (novo) último dia trabalhado
    if (v && !FINAIS.includes(v.status)) { const de = v.desde; v.desde = soma(d.ultimoDiaTrabalhado, 1); if (de !== v.desde) { v.historico.push(h(user, 'data_retificada', 'Posição vaga a partir de ' + br(v.desde) + ' (era ' + br(de) + '): data do desligamento retificada pelo RH.')); rearmarAlertas(v, hoje); } }
    gravarJson(P.desl(), st.D); if (v) gravarJson(P.vagas(), st.V);
    auditar(user, 'desligamento_retificar', { ref: d.id, loja: d.loja, funcId: d.funcId, funcionario: d.nome, justificativa: just, antes, depois: fotoDesl(d), vaga: v ? v.id : null });
  } else if (acao === 'cancelar') {
    d.status = 'cancelado'; d.canceladoEm = agora(); d.canceladoPor = quem(user); d.historico.push(h(user, 'cancelado', just));
    if (v && v.status !== 'cancelada') {
      if (v.status === 'preenchida' || v.substituto) { v.revisar = { em: agora(), texto: 'O desligamento de ' + d.nome + ' foi cancelado depois de a vaga ter substituto ' + (v.status === 'preenchida' ? 'confirmado' : 'vinculado') + ' (' + v.substituto.nome + '): o RH decide o que fazer com a posição.' }; v.historico.push(h(user, 'revisar', v.revisar.texto)); avisos.push(avisar('vaga_revisar', v, 'Desligamento de ' + d.nome + ' CANCELADO, mas a vaga ' + rotuloVaga(v) + ' já tem substituto (' + v.substituto.nome + '): revisar o quadro.', v.id + '|revisar|' + d.id)); }
      else { const de = v.status; v.status = 'cancelada'; v.encerradaEm = hoje; v.cancelamento = { motivo: 'desligamento_cancelado', motivoTxt: CANCELAMENTO.desligamento_cancelado, por: quem(user), em: agora(), justificativa: just }; v.historico.push(h(user, 'cancelada', 'Vaga cancelada: o desligamento de ' + d.nome + ' foi cancelado. ' + just, { de, para: 'cancelada' })); avisos.push(avisar('vaga_cancelada', v, 'Vaga CANCELADA ' + rotuloVaga(v) + ': o desligamento de ' + d.nome + ' foi cancelado pelo RH.')); }
    }
    gravarJson(P.desl(), st.D); if (v) gravarJson(P.vagas(), st.V);
    auditar(user, 'desligamento_cancelar', { ref: d.id, loja: d.loja, funcId: d.funcId, funcionario: d.nome, justificativa: just, antes, depois: fotoDesl(d), vaga: v ? { id: v.id, status: v.status } : null });
  } else if (acao === 'esocial') {
    if (d.movimento !== 'desligamento') throw erro('O S-2299 é o evento de desligamento: não se aplica a transferência');
    const env = String(b.enviadoEm || ''); if (!ISO.test(env)) throw erro('Informe a data em que o S-2299 foi enviado'); const ant = d.esocial.s2299;
    d.esocial.s2299 = { enviadoEm: env, recibo: txt(b.recibo, 80) || null, registradoPor: quem(user), registradoEm: agora() }; d.historico.push(h(user, 'esocial_s2299', just));
    gravarJson(P.desl(), st.D); auditar(user, 'esocial_s2299', { ref: d.id, loja: d.loja, funcId: d.funcId, funcionario: d.nome, justificativa: just, antes: ant, depois: { enviadoEm: env, recibo: d.esocial.s2299.recibo } });
  } else if (acao === 'reposicao') {
    const rep = String(b.reposicao || ''); const validas = d.movimento === 'transferencia' ? ['necessaria', 'sem_perda'] : ['necessaria', 'posicao_extinta']; if (!validas.includes(rep)) throw erro('Opção de reposição inválida'); if (rep === d.reposicao) throw erro('Nada foi alterado');
    if (v && v.status === 'preenchida') throw erro('A vaga ' + v.id + ' já foi preenchida', 409);
    d.reposicao = rep; d.historico.push(h(user, 'reposicao', just, { antes: antes.reposicao, depois: rep })); let nova = null;
    if (rep === 'necessaria') { if (!v || v.status === 'cancelada') { d.vagaId = null; nova = tratarPosicao(user, st, d, q, hoje); } }
    else { d.semVaga = { motivo: rep, texto: rep === 'sem_perda' ? 'Transferência sem perda de quadro: nenhuma vaga foi aberta.' : 'Posição extinta: sem reposição.' };
      if (v && !FINAIS.includes(v.status)) { const de = v.status; v.status = 'cancelada'; v.encerradaEm = hoje; v.cancelamento = { motivo: 'posicao_extinta', motivoTxt: CANCELAMENTO.posicao_extinta, por: quem(user), em: agora(), justificativa: just }; v.historico.push(h(user, 'cancelada', 'Vaga cancelada: ' + REPOSICAO[rep].toLowerCase() + '. ' + just, { de, para: 'cancelada' })); avisos.push(avisar('vaga_cancelada', v, 'Vaga CANCELADA ' + rotuloVaga(v) + ': ' + REPOSICAO[rep].toLowerCase() + '.')); } }
    gravarJson(P.desl(), st.D); gravarJson(P.vagas(), st.V);
    auditar(user, 'desligamento_reposicao', { ref: d.id, loja: d.loja, funcId: d.funcId, funcionario: d.nome, justificativa: just, antes: { reposicao: antes.reposicao }, depois: { reposicao: rep, vaga: nova ? nova.id : (v ? v.id : null) } });
    if (nova) { auditar(user, 'vaga_abrir', { ref: nova.id, loja: d.loja, desligamento: d.id, justificativa: just, depois: { status: nova.status, desde: nova.desde } }); avisos.push(...avisosDaAbertura(nova, hoje)); }
  } else throw erro('Ação inválida');
  const vf = d.vagaId ? st.V[d.vagaId] : null;
  return { desligamento: visaoDesl(d, user, q, hoje, st), vaga: vf ? visaoVaga(vf, user, hoje) : null, avisos };
}

// ── Vaga aberta à mão pelo RH (ampliação, ou reposição que o sistema não abriu sozinho) ──────────────────
async function abrirVaga(user, b, deps, hoje = hojeISO()) {
  b = b || {}; const st = { D: desligamentos(), V: vagas() }; const q = await quadro(deps); let d = null; let base;
  const just = txt(b.justificativa); if (just.length < 5) throw erro('Justificativa obrigatória (mínimo de 5 caracteres): ela fica na auditoria');
  if (b.desligamentoId) { d = st.D[String(b.desligamentoId).toUpperCase()]; if (!d) throw erro('Registro de desligamento não encontrado', 404); if (d.status !== 'confirmado') throw erro('O desligamento foi cancelado', 409); if (d.vagaId && st.V[d.vagaId] && st.V[d.vagaId].status !== 'cancelada') throw erro('Este desligamento já tem a vaga ' + d.vagaId, 409, { duplicada: d.vagaId });
    base = { loja: d.loja, setor: d.setor, setorEscala: d.setorEscala, cargo: d.cargo, turnoRef: d.turnoRef, origem: 'manual', tipo: 'reposicao', desligamentoId: d.id, ocupanteAnterior: { funcId: d.funcId, nome: d.nome, matricula: d.matricula }, desde: soma(d.ultimoDiaTrabalhado, 1) };
  } else {
    const loja = +b.loja; if (!GP.LOJAS.includes(loja)) throw erro('Unidade inválida'); const setor = semAcento(b.setor); if (!setor) throw erro('Informe o setor'); if (!txt(b.cargo)) throw erro('Informe o cargo');
    const desde = String(b.desde || hoje); if (!ISO.test(desde)) throw erro('Data inválida'); const en = txt(b.entrada, 5), sa = txt(b.saida, 5); const HM = /^([01]\d|2[0-3]):[0-5]\d$/; if ((en || sa) && !(HM.test(en) && HM.test(sa) && en < sa)) throw erro('Turno de referência inválido (entrada e saída em HH:MM)');
    base = { loja, setor, setorEscala: E.setorOperacional(b.setor), cargo: b.cargo, turnoRef: en ? { entrada: en, saida: sa, texto: en + '–' + sa, origem: 'manual' } : null, origem: 'manual', tipo: b.tipo === 'ampliacao' ? 'ampliacao' : 'reposicao', desde };
  }
  exige(podeRH(user, base.loja), 'Só o RH que atende a unidade abre vaga');
  const Q = situacaoQuadro(base.loja, base.setor, q, st, null); const v = criarVaga(user, st, { ...base, quadro: Q }, hoje); v.historico[0].texto += ' ' + just;
  if (d) { d.vagaId = v.id; d.reposicao = 'necessaria'; d.semVaga = null; d.historico.push(h(user, 'vaga_aberta', 'Vaga ' + v.id + ' aberta pelo RH. ' + just)); gravarJson(P.desl(), st.D); }
  gravarJson(P.vagas(), st.V); auditar(user, 'vaga_abrir', { ref: v.id, loja: v.loja, desligamento: d ? d.id : null, justificativa: just, depois: { status: v.status, tipo: v.tipo, desde: v.desde, setor: v.setor, cargo: v.cargo, quadro: v.quadro } });
  return { vaga: visaoVaga(v, user, hoje), avisos: avisosDaAbertura(v, hoje) };
}

// ── Candidatos compatíveis (admitidos e transferidos que o ponto mostra na unidade) ──────────────────────
function candidatosDe(v, q, st, hoje) {
  const usados = new Set(Object.values(st.V).filter(x => x.status !== 'cancelada' && x.substituto).map(x => String(x.substituto.funcId))); const transf = (lerJson(P.sync(), {}).transferencias || []).filter(t => +t.para === +v.loja);
  const desde = soma(v.abertaEm < v.desde ? v.abertaEm : v.desde, -CFG.janelaCandidatoDias); const out = [];
  for (const c of q.ativos) {
    if (+c.loja !== +v.loja || usados.has(String(c.id)) || (v.ocupanteAnterior && String(v.ocupanteAnterior.funcId) === String(c.id))) continue;
    const t = transf.find(x => String(x.funcId) === String(c.id) && x.em >= desde); const adm = c.admissao && c.admissao >= desde; if (!t && !adm) continue;
    const compat = { unidade: true, setor: semAcento(c.setor || '—') === v.setor, cargo: !!v.cargo && semAcento(c.cargo) === semAcento(v.cargo) }; if (!compat.setor && !compat.cargo) continue;
    out.push({ funcId: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo || '', setor: semAcento(c.setor || '—'), admissao: c.admissao || null, origem: adm ? 'admissao' : 'transferencia', origemTxt: adm ? 'Admitido em ' + br(c.admissao) : 'Transferido de ' + lojaTxt(t.de) + ' (visto no ponto em ' + br(t.em) + ')', inicioSugerido: adm ? c.admissao : t.em, compat, pontos: (compat.setor ? 2 : 0) + (compat.cargo ? 1 : 0) });
  }
  return out.sort((a, b) => b.pontos - a.pontos || a.nome.localeCompare(b.nome));
}

// ── Vaga: andamento, autorização, vínculo, preenchimento, cancelamento ───────────────────────────────────
async function atualizarVaga(user, id, b, deps, hoje = hojeISO()) {
  b = b || {}; const st = { D: desligamentos(), V: vagas() }; const v = st.V[String(id || '').toUpperCase()]; if (!v) throw erro('Vaga não encontrada', 404); exige(podeVer(user, v.loja), 'Unidade fora do seu escopo');
  const acao = String(b.acao || ''); const rh = podeRH(user, v.loja), co = ehCoord(user); const just = txt(b.justificativa || b.observacao || b.texto); const avisos = []; const de = v.status; const antes = { status: v.status, autorizacao: v.autorizacao ? v.autorizacao.base : null, substituto: v.substituto ? v.substituto.funcId : null };
  if (FINAIS.includes(v.status) && acao !== 'observacao') throw erro('Vaga ' + STATUS[v.status].toLowerCase() + ': não aceita mais alterações', 409);
  const obs = t => { if (t) v.observacoes.push({ em: agora(), ...quem(user), texto: txt(t, 600) }); };
  if (acao === 'status') {
    exige(rh, 'Só o RH que atende a unidade atualiza o andamento da vaga'); const para = String(b.status || '');
    if (!['aberta', 'aguardando_autorizacao', 'em_recrutamento', 'contratacao_em_andamento'].includes(para)) throw erro(para === 'reposicao_autorizada' ? 'A autorização é registrada pela ação "Autorizar reposição"' : para === 'preenchida' ? 'A vaga só é preenchida pelo vínculo do substituto, com confirmação do RH' : para === 'cancelada' ? 'Use a ação de cancelar, com o motivo' : 'Situação inválida');
    if (para === v.status) throw erro('A vaga já está nessa situação');
    if (RECRUTANDO.includes(para) && !v.autorizacao) throw erro('A reposição ainda não foi autorizada: o recrutamento só começa depois da autorização', 409);
    if (v.substituto) throw erro('Há substituto vinculado (' + v.substituto.nome + '): desfaça o vínculo antes de voltar a situação', 409);
    v.status = para; obs(b.observacao); v.historico.push(h(user, 'status', b.observacao, { de, para }));
  } else if (acao === 'autorizar') {
    if (v.autorizacao) throw erro('A reposição já foi autorizada em ' + br(v.autorizacao.em.slice(0, 10)), 409); let base, prot = null;
    const protocolo = txt(b.protocolo, 40).toUpperCase();
    if (protocolo) { exige(rh || co, 'Sem permissão para autorizar'); let s; try { s = GP.obterSol(protocolo); } catch (e) { throw erro('Solicitação ' + protocolo + ' não encontrada na Gestão de Pessoas', 404); }
      if (!['reposicao', 'ampliacao'].includes(s.tipo)) throw erro('A solicitação ' + protocolo + ' não é de reposição nem de ampliação de quadro'); if (+s.loja !== +v.loja) throw erro('A solicitação ' + protocolo + ' é de outra unidade');
      if (!['aprovado', 'em_execucao', 'concluido'].includes(s.status)) throw erro('A solicitação ' + protocolo + ' ainda não foi aprovada pela Coordenação (' + (GP.STATUS_TXT[s.status] || s.status) + ')', 409); base = 'solicitacao'; prot = protocolo; }
    else if (co) base = 'coordenacao';
    else { exige(rh, 'Só a Coordenação autoriza a reposição'); const q = await quadro(deps); const Q = situacaoQuadro(v.loja, v.setor, q, { D: st.D, V: Object.fromEntries(Object.entries(st.V).filter(([k]) => k !== v.id)) }, null);
      if (!Q.dentro) throw erro(Q.autorizado == null ? 'O quadro autorizado deste setor não está definido: a autorização é da Coordenação (ou informe o protocolo de uma solicitação de reposição aprovada)' : 'O setor já está no quadro autorizado (' + Q.efetivo + ' ativo(s) + ' + Q.vagasAbertas + ' vaga(s) de ' + Q.autorizado + '): a autorização é da Coordenação', 403); base = 'quadro'; v.quadro = { ...Q, em: hoje }; }
    if (base !== 'quadro' && just.length < 5) throw erro('Registre a justificativa da autorização');
    v.autorizacao = { base, baseTxt: { coordenacao: 'Autorizada pela Coordenação', quadro: 'Posição dentro do quadro autorizado', solicitacao: 'Solicitação aprovada ' + prot }[base], protocolo: prot, por: quem(user), em: agora(), justificativa: just || null }; v.solicitacao = prot;
    if (ABERTAS.includes(v.status)) v.status = 'reposicao_autorizada'; v.historico.push(h(user, 'autorizada', v.autorizacao.baseTxt + (just ? '. ' + just : ''), { de, para: v.status }));
  } else if (acao === 'observacao') {
    exige(rh || co, 'Só RH e Coordenação registram observações na vaga'); if (just.length < 3) throw erro('Escreva a observação'); obs(just); v.historico.push(h(user, 'observacao', just));
  } else if (acao === 'vincular') {
    exige(rh, 'Só o RH que atende a unidade vincula o substituto'); if (!v.autorizacao) throw erro('A reposição ainda não foi autorizada: vincule o substituto depois da autorização', 409); if (v.substituto) throw erro('A vaga já tem ' + v.substituto.nome + ' vinculado: desfaça o vínculo antes', 409);
    const q = await quadro(deps); const c = q.ativos.find(x => String(x.id) === String(b.funcId)); if (!c) throw erro('Funcionário não encontrado entre os ativos do ponto', 404);
    if (v.ocupanteAnterior && String(v.ocupanteAnterior.funcId) === String(c.id)) throw erro('Esta pessoa é quem ocupava a posição');
    const outra = Object.values(st.V).find(x => x.id !== v.id && x.status !== 'cancelada' && x.substituto && String(x.substituto.funcId) === String(c.id)); if (outra) throw erro(c.nome + ' já está vinculado à vaga ' + outra.id, 409, { duplicada: outra.id });
    const inicio = String(b.inicio || c.admissao || ''); if (!ISO.test(inicio)) throw erro('Informe a data efetiva de início na posição');
    const ress = []; if (+c.loja !== +v.loja) ress.push('está lotado em ' + lojaTxt(c.loja) + ' no ponto (a vaga é de ' + lojaTxt(v.loja) + ')'); if (semAcento(c.setor || '—') !== v.setor) ress.push('setor no ponto é ' + (semAcento(c.setor) || '—') + ' (a vaga é de ' + v.setor + ')'); if (v.cargo && semAcento(c.cargo) !== semAcento(v.cargo)) ress.push('cargo no ponto é ' + (c.cargo || '—') + ' (a vaga é de ' + v.cargo + ')');
    if (ress.length && b.ciente !== true) throw erro('Compatibilidade com a vaga: ' + c.nome + ' ' + ress.join('; ') + '. Confirme que é mesmo o substituto desta posição.', 409, { ressalvas: ress, exigeCiencia: true });
    // de onde vem: admissão recente; transferência de outra unidade (registrada aqui ou vista no ponto); ou movimentação interna (já era da unidade)
    const veioDeFora = Object.values(st.D).some(d => d.movimento === 'transferencia' && d.status === 'confirmado' && String(d.funcId) === String(c.id) && +d.lojaDestino === +v.loja) || (lerJson(P.sync(), {}).transferencias || []).some(t => String(t.funcId) === String(c.id) && +t.para === +v.loja);
    const origem = c.admissao && c.admissao >= soma(v.abertaEm < v.desde ? v.abertaEm : v.desde, -CFG.janelaCandidatoDias) ? 'admissao' : veioDeFora || +c.loja !== +v.loja ? 'transferencia' : 'interno';
    v.substituto = { funcId: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo || '', setorAnterior: semAcento(c.setor || '—'), inicio, origem, origemTxt: { admissao: 'Admissão', transferencia: 'Transferência de outra unidade', interno: 'Movimentação interna (já era da unidade)' }[origem], ressalvas: ress, vinculadoPor: quem(user), vinculadoEm: agora() };
    v.status = 'contratacao_em_andamento'; obs(b.observacao); v.historico.push(h(user, 'vinculado', c.nome + ' vinculado à vaga, início em ' + br(inicio) + (ress.length ? ' (com ressalva: ' + ress.join('; ') + ')' : '') + '. A vaga só encerra com a confirmação do RH.', { de, para: v.status }));
  } else if (acao === 'desvincular') {
    exige(rh, 'Só o RH que atende a unidade desfaz o vínculo'); if (!v.substituto) throw erro('A vaga não tem substituto vinculado'); if (just.length < 5) throw erro('Justifique');
    const nome = v.substituto.nome; v.substituto = null; v.status = 'em_recrutamento'; v.historico.push(h(user, 'desvinculado', 'Vínculo de ' + nome + ' desfeito. ' + just, { de, para: v.status }));
  } else if (acao === 'preencher') {
    exige(rh, 'Só o RH que atende a unidade confirma o preenchimento'); if (!v.substituto) throw erro('Vincule o substituto antes de confirmar o preenchimento', 409);
    const q = await quadro(deps); const c = q.ativos.find(x => String(x.id) === String(v.substituto.funcId)); if (!c) throw erro(v.substituto.nome + ' não está entre os ativos do ponto: a vaga não pode ser encerrada', 409);
    if (+c.loja !== +v.loja) throw erro(v.substituto.nome + ' ainda consta em ' + lojaTxt(c.loja) + ' no ponto: a vaga de ' + lojaTxt(v.loja) + ' só encerra depois de o cadastro do ponto ser atualizado', 409);
    if (b.inicio) { if (!ISO.test(String(b.inicio))) throw erro('Data de início inválida'); v.substituto.inicio = String(b.inicio); }
    v.status = 'preenchida'; v.encerradaEm = hoje; v.substituto.confirmadoPor = quem(user); v.substituto.confirmadoEm = agora(); obs(b.observacao);
    v.historico.push(h(user, 'preenchida', 'Preenchimento confirmado pelo RH: ' + v.substituto.nome + ', a partir de ' + br(v.substituto.inicio) + '.' + (just ? ' ' + just : ''), { de, para: 'preenchida' }));
    avisos.push(avisar('vaga_preenchida', v, 'Vaga PREENCHIDA ' + rotuloVaga(v) + ': ' + v.substituto.nome + ' assume a posição em ' + br(v.substituto.inicio) + (v.ocupanteAnterior ? ' (era de ' + v.ocupanteAnterior.nome + ')' : '') + '.'));
  } else if (acao === 'cancelar') {
    exige(rh || co, 'Só RH e Coordenação cancelam a vaga'); const motivo = String(b.motivo || ''); if (!CANCELAMENTO[motivo] || motivo === 'desligamento_cancelado') throw erro('Informe o motivo do cancelamento: posição extinta ou outro'); if (just.length < 5) throw erro('Justificativa obrigatória (mínimo de 5 caracteres)');
    v.status = 'cancelada'; v.encerradaEm = hoje; v.cancelamento = { motivo, motivoTxt: CANCELAMENTO[motivo], por: quem(user), em: agora(), justificativa: just }; v.historico.push(h(user, 'cancelada', CANCELAMENTO[motivo] + '. ' + just, { de, para: 'cancelada' }));
    const d = v.desligamentoId ? st.D[v.desligamentoId] : null; if (d && motivo === 'posicao_extinta') { d.reposicao = d.movimento === 'transferencia' ? 'sem_perda' : 'posicao_extinta'; d.semVaga = { motivo: 'posicao_extinta', texto: 'Posição extinta: a vaga ' + v.id + ' foi cancelada.' }; d.historico.push(h(user, 'reposicao', 'Vaga ' + v.id + ' cancelada por posição extinta. ' + just)); gravarJson(P.desl(), st.D); }
    avisos.push(avisar('vaga_cancelada', v, 'Vaga CANCELADA ' + rotuloVaga(v) + ': ' + CANCELAMENTO[motivo].toLowerCase() + '. ' + just));
  } else throw erro('Ação inválida');
  gravarJson(P.vagas(), st.V);
  auditar(user, 'vaga_' + acao, { ref: v.id, loja: v.loja, justificativa: just || null, antes, depois: { status: v.status, autorizacao: v.autorizacao ? v.autorizacao.base : null, substituto: v.substituto ? v.substituto.funcId : null, cancelamento: v.cancelamento ? v.cancelamento.motivo : null } });
  const r = { vaga: visaoVaga(v, user, hoje), avisos };
  // preenchida: a escala passa a contar o substituto só a partir do início; se ele ainda não está no quadro da escala, o RH inclui
  if (acao === 'preencher') { const meses = [...new Set([v.substituto.inicio.slice(0, 7), hoje.slice(0, 7)])].filter(m => m >= v.substituto.inicio.slice(0, 7)); r.escala = meses.map(mes => { const e = E.ler(v.loja, mes); return { mes, existe: !!e, naEscala: !!(e && e.funcionarios.some(f => String(f.id) === String(v.substituto.funcId))) }; });
    r.orientacao = r.escala.some(x => x.existe && !x.naEscala) ? 'Inclua ' + v.substituto.nome + ' no quadro da escala (Gerador 5×2 › Ajustar o quadro pelo ponto): a grade passa a contar a jornada a partir de ' + br(v.substituto.inicio) + '.'
      : v.substituto.origem === 'interno' ? v.substituto.nome + ' já era da unidade (movimentação interna): a escala não muda sozinha — ajuste o setor e os horários na Escala coletiva a partir de ' + br(v.substituto.inicio) + '. A posição anterior (' + v.substituto.setorAnterior + ') não vira vaga automaticamente: abra uma vaga se ela precisar de reposição.' : null; }
  return r;
}

// ── Consultas ────────────────────────────────────────────────────────────────────────────────────────────
function listarVagas(user, f = {}, hoje = hojeISO()) {
  exige(podeVer(user, null), 'Sem acesso'); let l = Object.values(vagas()).filter(v => veLoja(user, v.loja)); if (f.loja) l = l.filter(v => +v.loja === +f.loja);
  if (f.status === 'abertas') l = l.filter(v => !FINAIS.includes(v.status)); else if (f.status) l = l.filter(v => v.status === f.status);
  return l.map(v => visaoVaga(v, user, hoje)).sort((a, b) => FINAIS.includes(a.status) - FINAIS.includes(b.status) || b.diasAberta - a.diasAberta || a.id.localeCompare(b.id));
}
async function detalheVaga(user, id, deps, hoje = hojeISO()) {
  const st = { D: desligamentos(), V: vagas() }; const v = st.V[String(id || '').toUpperCase()]; if (!v) throw erro('Vaga não encontrada', 404); exige(podeVer(user, v.loja), 'Unidade fora do seu escopo');
  const q = await quadro(deps); const d = v.desligamentoId ? st.D[v.desligamentoId] : null; let afast = null; try { afast = await afastMapa(deps, hoje); } catch (e) {}
  return { ...visaoVaga(v, user, hoje), desligamento: d ? visaoDesl(d, user, q, hoje, st) : null, candidatos: FINAIS.includes(v.status) || v.substituto ? [] : candidatosDe(v, q, st, hoje), cobertura: FINAIS.includes(v.status) ? null : impactoCobertura(v, hoje, afast),
    quadroAgora: situacaoQuadro(v.loja, v.setor, q, { D: st.D, V: Object.fromEntries(Object.entries(st.V).filter(([k]) => k !== v.id)) }, null), auditoria: veAuditoria(user) ? lerLinhas(P.aud()).filter(r => r.ref === v.id || (d && r.ref === d.id)).reverse() : null };
}
async function listarDesligamentos(user, deps, f = {}, hoje = hojeISO()) {
  exige(podeVer(user, null), 'Sem acesso'); const st = { D: desligamentos(), V: vagas() }; const q = await quadro(deps);
  let l = Object.values(st.D).filter(d => veLoja(user, d.loja) || (d.lojaDestino && veLoja(user, d.lojaDestino))); if (f.loja) l = l.filter(d => +d.loja === +f.loja);
  return { registros: l.map(d => visaoDesl(d, user, q, hoje, st)).sort((a, b) => (b.confirmadoEm || '').localeCompare(a.confirmadoEm || '')), aConfirmar: pendentesDoPonto(user, q, st, hoje), transferencias: transferenciasDetectadas(user, q, st) };
}
async function detalheDesligamento(user, id, deps, hoje = hojeISO()) { const { st, d } = carregarDesl(id); exige(podeVer(user, d.loja), 'Unidade fora do seu escopo'); const q = await quadro(deps); return { ...visaoDesl(d, user, q, hoje, st), auditoria: veAuditoria(user) ? lerLinhas(P.aud()).filter(r => r.ref === d.id).reverse() : null }; }
/** Desligamentos que o ponto mostra e o RH ainda não confirmou aqui (não produzem efeito até a confirmação). */
function pendentesDoPonto(user, q, st, hoje) {
  const desde = soma(hoje, -CFG.janelaPontoDias); const com = new Set(Object.values(st.D).filter(d => d.movimento === 'desligamento').map(d => String(d.funcId))); const s = lerJson(P.sync(), {}); const disp = s.dispensados || {}, acervo = s.acervo || {};
  return q.desligados.filter(c => c.desligamento && c.desligamento >= desde && !com.has(String(c.id)) && !(disp[c.id] && disp[c.id].desligamento === c.desligamento) && veLoja(user, c.loja))
    .map(c => ({ funcId: c.id, nome: c.nome, matricula: c.matricula || '', loja: +c.loja, lojaTxt: lojaTxt(c.loja), setor: semAcento(c.setor || '—'), cargo: c.cargo || '', desligamento: c.desligamento, confirma: podeRH(user, c.loja), acervo: acervo[c.id] === c.desligamento })).sort((a, b) => b.desligamento.localeCompare(a.desligamento));
}
/** O RH dispensa desligamentos que o ponto mostra e que este controle não vai tratar (baixa de cadastro antiga, saída já resolvida
 *  antes de o módulo existir). Dispensar NÃO confirma nada: ninguém sai da escala e nenhuma vaga é aberta por causa disso. */
async function dispensarPonto(user, b, deps, hoje = hojeISO()) {
  b = b || {}; exige(ehRH(user), 'Só o RH dispensa desligamentos do ponto'); const just = txt(b.justificativa); if (just.length < 5) throw erro('Justificativa obrigatória (mínimo de 5 caracteres): ela fica na auditoria');
  const q = await quadro(deps); const st = { D: desligamentos(), V: vagas() }; const ids = new Set((Array.isArray(b.funcIds) ? b.funcIds : []).map(String)); const ate = ISO.test(String(b.ate || '')) ? String(b.ate) : null; if (!ids.size && !ate) throw erro('Informe quem dispensar ou a data-limite');
  const alvo = pendentesDoPonto(user, q, st, hoje).filter(x => x.confirma && (ids.has(String(x.funcId)) || (ate && x.desligamento <= ate))); if (!alvo.length) throw erro('Nenhum desligamento a dispensar com esse critério', 404);
  const s = lerJson(P.sync(), {}); s.dispensados = s.dispensados || {}; for (const x of alvo) s.dispensados[x.funcId] = { desligamento: x.desligamento, em: agora(), ...quem(user), justificativa: just }; gravarJson(P.sync(), s);
  auditar(user, 'ponto_dispensar', { ref: 'PONTO', justificativa: just, depois: { quantidade: alvo.length, criterio: ate ? 'data no ponto até ' + ate : 'selecionados' }, dispensados: alvo.map(x => ({ funcId: x.funcId, nome: x.nome, loja: x.loja, desligamento: x.desligamento })) });
  return { ok: true, dispensados: alvo.length };
}
/** Mudanças de unidade que o ponto mostrou (comparando com a leitura anterior) e ainda não foram registradas como transferência. */
function transferenciasDetectadas(user, q, st) {
  const reg = new Set(Object.values(st.D).filter(d => d.movimento === 'transferencia' && d.status === 'confirmado').map(d => d.funcId + '|' + d.loja + '|' + d.lojaDestino));
  return (lerJson(P.sync(), {}).transferencias || []).filter(t => !t.dispensada && !reg.has(t.funcId + '|' + t.de + '|' + t.para) && (veLoja(user, t.de) || veLoja(user, t.para)) && q.ativos.some(c => String(c.id) === String(t.funcId) && +c.loja === +t.para))
    .map(t => ({ ...t, deTxt: lojaTxt(t.de), paraTxt: lojaTxt(t.para), confirma: podeRH(user, t.de) }));
}
/** Funcionários para o formulário de desligamento / vínculo: ativos e desligados recentes das unidades do usuário. */
async function buscarFuncionarios(user, deps, f = {}, hoje = hojeISO()) {
  exige(podeVer(user, null), 'Sem acesso'); const q = await quadro(deps); const t = semAcento(f.q); const desde = soma(hoje, -90); const st = { D: desligamentos() };
  return q.todos.filter(c => veLoja(user, c.loja) && (!f.loja || +c.loja === +f.loja) && (!q.desligados.includes(c) || (c.desligamento && c.desligamento >= desde)) && (!t || semAcento(c.nome + ' ' + (c.matricula || '')).includes(t)))
    .slice(0, 400).map(c => ({ funcId: c.id, nome: c.nome, matricula: c.matricula || '', loja: +c.loja, lojaTxt: lojaTxt(c.loja), setor: semAcento(c.setor || '—'), cargo: c.cargo || '', admissao: c.admissao || null, ativo: !q.desligados.includes(c), desligamento: c.desligamento || null, registro: (saidaAtiva(st.D, c.id) || {}).id || null })).sort((a, b) => a.nome.localeCompare(b.nome));
}
async function afastMapa(deps, hoje) { if (!deps.afastamentos) return null; const l = await deps.afastamentos(hoje, soma(hoje, CFG.coberturaDias - 1)); const m = new Map(); for (const a of l || []) { if (!m.has(a.nome)) m.set(a.nome, []); m.get(a.nome).push(a); } return m; }

/** Linhas "VAGA EM ABERTO" da grade de uma unidade no período (a tela desenha; nada disso entra em `funcionarios`). */
function naEscala(user, loja, de, ate, hoje = hojeISO()) {
  exige(E.podeVer(user, loja) || podeVer(user, loja), 'Unidade fora do seu escopo'); if (!ISO.test(String(de)) || !ISO.test(String(ate))) throw erro('Período inválido');
  return Object.values(vagas()).filter(v => +v.loja === +loja && v.status !== 'cancelada' && v.desde <= ate).map(v => { const fim = v.status === 'preenchida' && v.substituto ? soma(v.substituto.inicio, -1) : null; return { v, fim }; }).filter(x => !x.fim || x.fim >= de)
    .map(({ v, fim }) => ({ id: v.id, rotulo: 'VAGA EM ABERTO', loja: v.loja, lojaTxt: lojaTxt(v.loja), setor: v.setorEscala, setorTxt: E.setorTxt(v.setorEscala), cargo: v.cargo, turno: v.turnoRef ? v.turnoRef.texto : null, classe: v.turnoRef ? v.turnoRef.classe || null : null, abertaEm: v.abertaEm, desde: v.desde, ate: fim, status: v.status, statusTxt: STATUS[v.status],
      ocupanteAnterior: v.ocupanteAnterior ? v.ocupanteAnterior.nome : null, substituto: v.substituto ? { nome: v.substituto.nome, inicio: v.substituto.inicio } : null, dias: v.desde > hoje ? 0 : diasEntre(v.desde, fim && fim < hoje ? fim : hoje) })).sort((a, b) => a.setor.localeCompare(b.setor) || a.desde.localeCompare(b.desde));
}

// ── Quadro de pessoal por unidade e setor ────────────────────────────────────────────────────────────────
async function quadroPessoal(user, deps, hoje = hojeISO()) {
  exige(GP.vePainel(user), 'Sem acesso ao quadro de pessoal'); const q = await quadro(deps); const st = { D: desligamentos(), V: vagas() }; const base = GP.painelQuadro(user, q.bruto); let afast = null; try { afast = await afastMapa(deps, hoje); } catch (e) {}
  const desde90 = soma(hoje, -90); const linhas = new Map(); for (const r of base.linhas) linhas.set(r.loja + '|' + r.setor, { loja: r.loja, lojaTxt: r.lojaTxt, setor: r.setor, autorizado: r.autorizado, ativos: r.atual, afastados: r.afastados, ferias: r.ferias, funcoes: r.funcoes });
  const L = (loja, setor) => { const k = loja + '|' + setor; if (!linhas.has(k)) linhas.set(k, { loja: +loja, lojaTxt: lojaTxt(loja), setor, autorizado: (GP.config().quadro || {})[k] != null ? GP.config().quadro[k] : null, ativos: 0, afastados: 0, ferias: 0, funcoes: [] }); return linhas.get(k); };
  for (const v of Object.values(st.V)) if (GP.veLoja(user, v.loja)) L(v.loja, v.setor);
  const cobLoja = new Map(); const cobDe = loja => { if (!cobLoja.has(loja)) cobLoja.set(loja, coberturaUnidade(loja, hoje, afast, st)); return cobLoja.get(loja); };
  const ativosIds = new Set(q.ativos.map(c => String(c.id)));
  const out = [...linhas.values()].map(r => {
    const vs = Object.values(st.V).filter(v => +v.loja === r.loja && v.setor === r.setor); const setorEscala = (vs[0] && vs[0].setorEscala) || E.setorOperacional(r.setor);
    const saindo = Object.values(st.D).filter(d => d.status === 'confirmado' && +d.loja === r.loja && d.setor === r.setor && ativosIds.has(String(d.funcId)) && q.ativos.some(c => String(c.id) === String(d.funcId) && +c.loja === r.loja)).length;
    return { ...r, setorEscala, setorTxt: E.setorTxt(setorEscala), ausenciaTemporaria: r.afastados + r.ferias, saidasConfirmadas: saindo, efetivo: r.ativos - saindo,
      vagasAbertas: vs.filter(v => ABERTAS.includes(v.status)).length, emRecrutamento: vs.filter(v => RECRUTANDO.includes(v.status)).length, preenchidas: vs.filter(v => v.status === 'preenchida' && v.encerradaEm >= desde90).length, canceladas: vs.filter(v => v.status === 'cancelada' && v.encerradaEm >= desde90).length,
      deficitQuadro: r.autorizado == null ? null : Math.max(0, r.autorizado - (r.ativos - saindo)), cobertura: cobDe(r.loja)[setorEscala] || null };
  }).sort((a, b) => a.loja - b.loja || a.setor.localeCompare(b.setor));
  const tot = {}; for (const r of out) { const t = tot[r.loja] || (tot[r.loja] = { loja: r.loja, lojaTxt: r.lojaTxt, autorizado: null, ativos: 0, efetivo: 0, ausenciaTemporaria: 0, saidasConfirmadas: 0, vagasAbertas: 0, emRecrutamento: 0, preenchidas: 0, deficitQuadro: null }); for (const k of ['ativos', 'efetivo', 'ausenciaTemporaria', 'saidasConfirmadas', 'vagasAbertas', 'emRecrutamento', 'preenchidas']) t[k] += r[k]; if (r.autorizado != null) { t.autorizado = (t.autorizado || 0) + r.autorizado; t.deficitQuadro = (t.deficitQuadro || 0) + r.deficitQuadro; } }
  return { hoje, cobertura: { de: hoje, ate: soma(hoje, CFG.coberturaDias - 1) }, aoVivo: true, quadroDefinido: out.some(r => r.autorizado != null), linhas: out, unidades: Object.values(tot).sort((a, b) => a.loja - b.loja),
    nota: 'Déficit de quadro = quadro autorizado menos efetivo (ativos sem quem já tem saída confirmada). Ausência temporária (férias e afastamento) NÃO é déficit de quadro: a pessoa continua ocupando a posição. A cobertura mostra, nos próximos ' + CFG.coberturaDias + ' dias, as faixas de 15 min abaixo do mínimo do setor por turno, separando o que falta por vaga do que falta por ausência temporária.' };
}

// ── Painel e contador do menu ────────────────────────────────────────────────────────────────────────────
async function painel(user, deps, hoje = hojeISO()) {
  exige(podeVer(user, null), 'Sem acesso'); const q = await quadro(deps); const st = { D: desligamentos(), V: vagas() }; let afast = null; try { afast = await afastMapa(deps, hoje); } catch (e) {}
  const todas = Object.values(st.V).filter(v => veLoja(user, v.loja)); const abertas = todas.filter(v => !FINAIS.includes(v.status)); const desde90 = soma(hoje, -90); const memo = memoEscalas(afast);
  const vis = abertas.map(v => ({ ...visaoVaga(v, user, hoje), cobertura: impactoCobertura(v, hoje, afast, memo), candidatos: v.substituto ? 0 : candidatosDe(v, q, st, hoje).length })).sort((a, b) => b.diasAberta - a.diasAberta || a.id.localeCompare(b.id));
  const desl = Object.values(st.D).filter(d => veLoja(user, d.loja)).map(d => visaoDesl(d, user, q, hoje, st));
  return { hoje, alertaDias: CFG.alertaDias,
    kpis: { emAberto: abertas.filter(v => ABERTAS.includes(v.status)).length, aguardandoAutorizacao: abertas.filter(v => !v.autorizacao).length, emRecrutamento: abertas.filter(v => v.status === 'em_recrutamento').length, contratacao: abertas.filter(v => v.status === 'contratacao_em_andamento').length,
      preenchidas90: todas.filter(v => v.status === 'preenchida' && v.encerradaEm >= desde90).length, canceladas90: todas.filter(v => v.status === 'cancelada' && v.encerradaEm >= desde90).length, comprometemCobertura: vis.filter(v => v.cobertura.compromete).length, maisDe30: vis.filter(v => v.diasAberta >= 30).length },
    vagas: vis, aConfirmar: pendentesDoPonto(user, q, st, hoje), transferencias: transferenciasDetectadas(user, q, st), revisar: todas.filter(v => v.revisar).map(v => visaoVaga(v, user, hoje)),
    divergencias: desl.filter(d => d.ponto && d.ponto.divergencias.length).map(d => ({ id: d.id, nome: d.nome, loja: d.loja, lojaTxt: d.lojaTxt, textos: d.ponto.divergencias.map(x => x.texto) })),
    esocialPendente: desl.filter(d => d.esocial && d.status === 'confirmado' && !d.esocial.registrado && d.dataDesligamento <= hoje).map(d => ({ id: d.id, nome: d.nome, loja: d.loja, lojaTxt: d.lojaTxt, dataDesligamento: d.dataDesligamento, prazoReferencia: d.esocial.prazoReferencia, atrasado: d.esocial.atrasado })),
    semVaga: desl.filter(d => d.status === 'confirmado' && d.semVaga && d.semVaga.motivo === 'quadro_completo' && !d.vagaId).map(d => ({ id: d.id, nome: d.nome, loja: d.loja, lojaTxt: d.lojaTxt, texto: d.semVaga.texto })) };
}
async function pendencias(user, deps, hoje = hojeISO()) {
  if (!podeVer(user, null)) return { n: 0 }; const st = { D: desligamentos(), V: vagas() }; const abertas = Object.values(st.V).filter(v => !FINAIS.includes(v.status)); let n = 0;
  if (ehCoord(user)) n += abertas.filter(v => !v.autorizacao).length;
  if (ehRH(user)) { n += abertas.filter(v => podeRH(user, v.loja) && v.substituto).length; try { const q = await quadro(deps); n += pendentesDoPonto(user, q, st, hoje).filter(x => x.confirma && !x.acervo).length * (fs.existsSync(P.sync()) ? 1 : 0) + transferenciasDetectadas(user, q, st).filter(x => x.confirma).length; } catch (e) {} }
  return { n };
}
/** O RH dispensa uma mudança de unidade que o ponto mostrou e não é transferência a tratar (correção de cadastro, por exemplo). */
function dispensarTransferencia(user, b) {
  b = b || {}; const s = lerJson(P.sync(), {}); const t = (s.transferencias || []).find(x => String(x.funcId) === String(b.funcId) && +x.de === +b.de && +x.para === +b.para && !x.dispensada); if (!t) throw erro('Transferência não encontrada', 404);
  exige(podeRH(user, t.de), 'Só o RH que atende a unidade de origem dispensa'); const just = txt(b.justificativa); if (just.length < 5) throw erro('Justificativa obrigatória');
  t.dispensada = { em: agora(), ...quem(user), justificativa: just }; gravarJson(P.sync(), s); auditar(user, 'transferencia_dispensar', { ref: 'TRF-' + t.funcId, loja: t.de, funcId: t.funcId, funcionario: t.nome, justificativa: just, antes: { de: t.de, para: t.para } }); return { ok: true };
}

// ── Rotina: lê o ponto, detecta saídas/transferências/admissões e manda os avisos de prazo ───────────────
async function verificar(deps, opts = {}) {
  const hoje = opts.hoje || hojeISO(); const q = await quadro(deps); const st = { D: desligamentos(), V: vagas() }; const s = lerJson(P.sync(), null); const primeira = !s; const sync = s || { lojas: {}, vistos: {}, transferencias: [] }; const avisos = [];
  sync.vistos = sync.vistos || {}; sync.transferencias = sync.transferencias || [];
  // 1) mudou de unidade no ponto desde a última leitura = transferência a confirmar pelo RH (nunca tratada sozinha)
  const lojasAgora = {}; for (const c of q.ativos) { lojasAgora[c.id] = +c.loja; const ant = sync.lojas[c.id]; if (!primeira && ant != null && +ant !== +c.loja) { sync.transferencias = sync.transferencias.filter(t => !(String(t.funcId) === String(c.id) && !t.dispensada)); sync.transferencias.push({ funcId: c.id, nome: c.nome, de: +ant, para: +c.loja, em: hoje });
    if (!Object.values(st.D).some(d => d.movimento === 'transferencia' && d.status === 'confirmado' && String(d.funcId) === String(c.id) && +d.lojaDestino === +c.loja)) avisos.push(avisar('transferencia_ponto', { loja: +ant }, 'O ponto passou a mostrar ' + c.nome + ' em ' + lojaTxt(c.loja) + ' (antes: ' + lojaTxt(ant) + '). Confirme a transferência em Vagas e Quadro de Pessoal para tratar a posição de origem.', 'TRF|' + c.id + '|' + ant + '|' + c.loja + '|' + hoje, 'rh')); } }
  sync.lojas = { ...sync.lojas, ...lojasAgora };
  // 2) desligamento novo no ponto: fica "a confirmar" (não tira ninguém da escala nem abre vaga até o RH confirmar)
  const desde = soma(hoje, -CFG.janelaPontoDias); const com = new Set(Object.values(st.D).filter(d => d.movimento === 'desligamento').map(d => String(d.funcId)));
  const novos = q.desligados.filter(c => c.desligamento && c.desligamento >= desde && !com.has(String(c.id)) && sync.vistos[c.id] !== c.desligamento); for (const c of novos) sync.vistos[c.id] = c.desligamento;
  if (primeira) sync.acervo = Object.fromEntries(novos.map(c => [c.id, c.desligamento]));   // o que já estava no ponto quando o módulo entrou: fica no painel, fora do contador do menu
  if (novos.length && primeira) avisos.push({ ...avisar('acervo_ponto', { loja: null }, 'Vagas e Quadro de Pessoal entrou no ar: o ponto mostra ' + novos.length + ' desligamento(s) nos últimos ' + CFG.janelaPontoDias + ' dias aguardando confirmação do RH (aviso prévio, último dia trabalhado e se a posição será reposta).', 'ACERVO', 'rh'), acervo: true, funcs: novos.map(c => c.id) });
  else for (const c of novos) avisos.push(avisar('desligamento_ponto', { loja: +c.loja }, 'O ponto registrou o desligamento de ' + c.nome + ' (' + lojaTxt(c.loja) + ') em ' + br(c.desligamento) + '. Confirme em Vagas e Quadro de Pessoal: aviso prévio, último dia trabalhado e se a posição será reposta.', 'PONTO|' + c.id + '|' + c.desligamento, 'rh'));
  // 3) vagas em aberto: prazo sem reposição, cobertura comprometida e admitido/transferido compatível
  const A = () => lerJson(P.alertas(), {}); let afast = null; try { afast = await afastMapa(deps, hoje); } catch (e) {} const memo = memoEscalas(afast);
  for (const v of Object.values(st.V)) {
    if (FINAIS.includes(v.status)) continue; const dias = diasEntre(v.desde, hoje);
    const devidos = CFG.alertaDias.filter(t => dias >= t && !A()[v.id + '|dias|' + t]);
    if (devidos.length) { const t = Math.max(...devidos); const a = A(); for (const x of devidos) if (x !== t) a[v.id + '|dias|' + x] = { em: agora(), tipo: 'dias', vaga: v.id, absorvido: t }; gravarJson(P.alertas(), a);
      avisos.push({ ...avisar('dias', v, 'Vaga ' + rotuloVaga(v) + ' há ' + dias + ' dia(s) SEM REPOSIÇÃO (marco de ' + t + ' dias) · ' + STATUS[v.status] + (v.autorizacao ? '' : ' — ainda sem autorização') + '.', v.id + '|dias|' + t), marco: t, dias }); }
    if (!A()[v.id + '|vaga_cobertura']) { const imp = impactoCobertura(v, hoje, afast, memo); if (imp.compromete) avisos.push(avisar('vaga_cobertura', v, 'A vaga ' + rotuloVaga(v) + ' COMPROMETE a cobertura mínima: ' + imp.blocos + ' faixa(s) de 15 min abaixo do mínimo em ' + imp.dias.length + ' dia(s) de ' + br(imp.de) + ' a ' + br(imp.ate) + '.')); }
    if (!v.substituto) for (const c of candidatosDe(v, q, st, hoje)) { const k = v.id + '|cand|' + c.funcId; if (A()[k]) continue; avisos.push({ ...avisar('candidato', v, c.nome + ' (' + c.origemTxt.toLowerCase() + (c.cargo ? ', ' + c.cargo : '') + ') é compatível com a vaga ' + rotuloVaga(v) + '. Se for o substituto, vincule à vaga — ela só encerra com a confirmação do RH.', k, 'rh'), funcId: c.funcId }); }
  }
  sync.em = agora(); sync.transferencias = sync.transferencias.filter(t => t.em >= soma(hoje, -180)); gravarJson(P.sync(), sync);
  return { primeira, avisos, desligamentosNovos: novos.length };
}

module.exports = { DIR, P, CFG, MOVIMENTO, AVISO, MOTIVO, REPOSICAO, STATUS, CANCELAMENTO, FINAIS, ehRH, ehCoord, podeVer, podeRH, veMotivo, veAuditoria, verificarCadeia, trilha,
  registrarDesligamento, alterarDesligamento, abrirVaga, atualizarVaga, listarVagas, detalheVaga, listarDesligamentos, detalheDesligamento, buscarFuncionarios, naEscala, quadroPessoal, painel, pendencias, dispensarTransferencia, dispensarPonto, verificar,
  impactoCobertura, situacaoQuadro, candidatosDe, _util: { hojeISO, soma, diasEntre, br, semAcento } };
