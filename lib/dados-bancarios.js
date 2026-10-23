'use strict';
// lib/dados-bancarios.js — Cadastro Bancário de funcionários (DP / RH › Termos de Escala › Dados bancários), 23/10/2026.
// O DP cadastra/altera conta ou chave Pix de cada funcionário (cadastro do PontoCerto); o Financeiro confere e valida
// (dupla conferência: quem cadastrou não valida). Cada cadastro/alteração é uma VERSÃO: a anterior validada continua
// valendo até a nova ser aprovada e fica no histórico. Segurança: alteração a menos de 48 h de um pagamento programado
// exige confirmação por canal independente; 3+ solicitações em 30 dias abrem alerta pra Coordenação; suspeita de fraude
// bloqueia o pagamento até o Financeiro revalidar. Dados sensíveis cifrados (AES-256-GCM) em data/dados-bancarios/:
//   contas.json        versões (dados cifrados em `enc`, só o resumo mascarado em claro)
//   alertas.json       48h / recorrente / fraude / bloqueio (abertos e encerrados)
//   importacoes.json   log das planilhas importadas (a planilha em si NÃO fica guardada)
//   config.json        parâmetros (recorrência, janela de horas, pagamentos programados avulsos)
//   auditoria/AAAA-MM.jsonl  todos os eventos (sem dados bancários completos)
//   .chave             chave AES (ou env DADOS_BANCARIOS_KEY, 64 hex); entra no backup geral do data/
// Papéis (central de pessoas): RH/DP cadastra, importa, corrige, consulta; FINANCEIRO valida/rejeita/bloqueia/libera;
// COORDENAÇÃO acompanha, encerra alertas e configura; DIRETORIA consulta (mascarado); gerente não entra.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const GP = require('./gestao-pessoas');

const DIR = process.env.BANCO_DIR || path.join(__dirname, '..', 'data', 'dados-bancarios');
const P = { contas: path.join(DIR, 'contas.json'), alertas: path.join(DIR, 'alertas.json'), importacoes: path.join(DIR, 'importacoes.json'), config: path.join(DIR, 'config.json'), chave: path.join(DIR, '.chave'), auditoria: mes => path.join(DIR, 'auditoria', mes + '.jsonl') };
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400 }, extra || {});
const agoraIso = () => new Date().toISOString();
const dig = s => String(s || '').replace(/\D/g, '');
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);

// ── arquivos ──
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
function appendLinha(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(obj) + '\n'); }
function lerLinhas(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } }
const mem = { contas: null, alertas: null, importacoes: null };
const contas = () => mem.contas || (mem.contas = lerJson(P.contas, []));
const alertas = () => mem.alertas || (mem.alertas = lerJson(P.alertas, []));
const importacoes = () => mem.importacoes || (mem.importacoes = lerJson(P.importacoes, []));
const salvarContas = () => gravarJson(P.contas, contas()), salvarAlertas = () => gravarJson(P.alertas, alertas()), salvarImportacoes = () => gravarJson(P.importacoes, importacoes());

// ── criptografia (AES-256-GCM; iv | tag | ciphertext em base64) ──
let chave = null;
function chaveAES() {
  if (chave) return chave;
  const env = process.env.DADOS_BANCARIOS_KEY;
  if (env && /^[0-9a-f]{64}$/i.test(env)) chave = Buffer.from(env, 'hex');
  else { try { chave = Buffer.from(fs.readFileSync(P.chave, 'utf8').trim(), 'hex'); } catch (e) { chave = null; } if (!chave || chave.length !== 32) { fs.mkdirSync(DIR, { recursive: true }); chave = crypto.randomBytes(32); fs.writeFileSync(P.chave, chave.toString('hex')); } }
  return chave;
}
function cifrar(obj) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', chaveAES(), iv); const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); }
function decifrar(b64) { const b = Buffer.from(b64, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', chaveAES(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')); }

// ── catálogos ──
const BANCOS = { '001': 'Banco do Brasil', '033': 'Santander', '104': 'Caixa Econômica Federal', '237': 'Bradesco', '341': 'Itaú', '260': 'Nubank', '077': 'Banco Inter', '336': 'C6 Bank', '212': 'Banco Original', '290': 'PagBank', '323': 'Mercado Pago', '380': 'PicPay', '403': 'Cora', '748': 'Sicredi', '756': 'Sicoob', '422': 'Safra', '655': 'Banco Votorantim', '070': 'BRB', '136': 'Unicred', '208': 'BTG Pactual', '389': 'Mercantil do Brasil', '041': 'Banrisul', '004': 'Banco do Nordeste', '021': 'Banestes', '037': 'Banpará', '047': 'Banese', '745': 'Citibank', '197': 'Stone', '332': 'Acesso', '364': 'Gerencianet', '536': 'Neon', '735': 'Neon', '102': 'XP Investimentos' };
const TIPO_CONTA = { corrente: 'Conta corrente', poupanca: 'Poupança', pagamento: 'Conta de pagamento' };
const TIPO_PIX = { cpf: 'CPF', telefone: 'Telefone', email: 'E-mail', aleatoria: 'Chave aleatória' };
const MODALIDADE = { pix: 'Pix', transferencia: 'Transferência bancária' };
const STATUS_TXT = { nao_cadastrado: 'Não cadastrado', pendente: 'Pendente de validação', em_correcao: 'Em correção', validado: 'Validado', rejeitado: 'Rejeitado', inativo: 'Inativo', cancelada: 'Cancelada' };
const ALERTA_TXT = { '48h': 'Alteração bancária próxima ao pagamento', recorrente: 'Alterações bancárias recorrentes', fraude: 'Suspeita de fraude', bloqueio: 'Pagamento bloqueado para verificação' };
const CONFIG_PADRAO = { recorrencia: { qtd: 3, dias: 30 }, janelaHoras: 48, pagamentosProgramados: [], alteracoes: [] };
function config() { const c = lerJson(P.config, {}); return { ...CONFIG_PADRAO, ...c, recorrencia: { ...CONFIG_PADRAO.recorrencia, ...(c.recorrencia || {}) } }; }

// ── permissões ──
function perm(user) {
  const dp = GP.temPapel(user, ...GP.RH), fin = GP.temPapel(user, 'financeiro'), coord = GP.temPapel(user, 'coordenacao'), dir = GP.temPapel(user, 'diretoria');
  return { papeis: GP.papeisDe(user), dp, fin, coord, dir, ver: dp || fin || coord || dir, completo: dp || fin, validar: fin, configurar: coord, alertas: coord || fin || dp, encerrarAlerta: coord, bloquear: fin || coord, liberar: fin, importar: dp };
}
function veLoja(user, loja) { const p = perm(user); if (p.fin || p.coord || p.dir) return true; return GP.veLoja(user, loja); }
const lojasDe = user => GP.LOJAS.filter(l => veLoja(user, l));
const quem = user => ({ usuario: user.usuario, nome: user.nome || user.usuario });

// ── máscaras / normalização ──
function mascararPix(tipo, k) {
  if (!k) return ''; if (tipo === 'cpf') return '***.***.' + k.slice(6, 9) + '-' + k.slice(9);
  if (tipo === 'telefone') return '(**) *****-' + k.slice(-4); if (tipo === 'email') { const [u, d] = k.split('@'); return u.slice(0, 1) + '***@' + (d || ''); }
  return k.slice(0, 4) + '…' + k.slice(-4);
}
function resumoDe(d) {
  return { modalidade: d.modalidade, modalidadeTxt: MODALIDADE[d.modalidade] || '', banco: d.banco || (d.codigoBanco ? BANCOS[d.codigoBanco] : '') || '', codigoBanco: d.codigoBanco || '', tipoConta: d.tipoConta || '', tipoContaTxt: TIPO_CONTA[d.tipoConta] || '',
    agenciaMask: d.agencia ? '••' + d.agencia.slice(-2) : '', contaMask: d.conta ? '••••' + (d.conta + (d.digito ? '-' + d.digito : '')).slice(-4) : '', tipoChavePix: d.tipoChavePix || '', tipoChavePixTxt: TIPO_PIX[d.tipoChavePix] || '', pixMask: d.chavePix ? mascararPix(d.tipoChavePix, d.chavePix) : '',
    titular: d.titular || '', titularTerceiro: !!d.titularTerceiro, cpfTitularMask: d.cpfTitular ? '***.***.' + d.cpfTitular.slice(6, 9) + '-' + d.cpfTitular.slice(9) : '' };
}
/** Valida e normaliza os dados conforme a modalidade. Retorna { dados, erros, avisos }. cpfFunc = CPF do funcionário (só servidor). */
function normalizarDados(d, func, cpfFunc) {
  d = d || {}; const out = { modalidade: String(d.modalidade || '').toLowerCase().trim() }; const erros = [], avisos = [];
  if (!MODALIDADE[out.modalidade]) erros.push('Modalidade preferencial: Pix ou transferência bancária');
  out.titular = txt(d.titular || func.nome, 120).toUpperCase(); out.cpfTitular = dig(d.cpfTitular) || cpfFunc || '';
  if (out.cpfTitular.length !== 11) erros.push('CPF do titular inválido');
  out.titularTerceiro = !!(cpfFunc && out.cpfTitular && out.cpfTitular !== cpfFunc);
  if (out.titularTerceiro) avisos.push('Conta em nome de terceiro (' + out.titular + '): o Financeiro precisa confirmar a titularidade antes de validar');
  if (out.modalidade === 'pix') {
    out.tipoChavePix = String(d.tipoChavePix || '').toLowerCase().trim(); let k = txt(d.chavePix, 120);
    if (!TIPO_PIX[out.tipoChavePix]) erros.push('Tipo de chave Pix: CPF, telefone, e-mail ou aleatória');
    else if (out.tipoChavePix === 'cpf') { k = dig(k); if (k.length !== 11) erros.push('Chave Pix (CPF) inválida'); else if (k !== out.cpfTitular) avisos.push('A chave Pix (CPF) não é o CPF do titular informado'); }
    else if (out.tipoChavePix === 'telefone') { k = dig(k); if (k.startsWith('55') && k.length > 11) k = k.slice(2); if (k.length < 10 || k.length > 11) erros.push('Chave Pix (telefone) inválida: DDD + número'); }
    else if (out.tipoChavePix === 'email') { k = k.toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)) erros.push('Chave Pix (e-mail) inválida'); }
    else { k = k.toLowerCase(); if (!/^[0-9a-f-]{32,36}$/.test(k)) erros.push('Chave Pix aleatória inválida (32 a 36 caracteres)'); }
    out.chavePix = k;
    for (const f of ['banco', 'codigoBanco', 'agencia', 'conta', 'digito', 'tipoConta']) if (d[f]) out[f] = txt(d[f], 60);   // opcionais no Pix
    if (out.codigoBanco) out.codigoBanco = dig(out.codigoBanco).padStart(3, '0').slice(-3);
  } else if (out.modalidade === 'transferencia') {
    const cb = dig(d.codigoBanco); out.codigoBanco = cb ? cb.padStart(3, '0').slice(-3) : ''; if (!cb) erros.push('Código do banco obrigatório (3 dígitos)');
    out.banco = txt(d.banco || BANCOS[out.codigoBanco] || '', 80).toUpperCase(); if (!out.banco) erros.push('Nome do banco obrigatório');
    out.agencia = dig(d.agencia); if (!out.agencia) erros.push('Agência obrigatória'); out.agenciaDigito = dig(d.agenciaDigito).slice(0, 1);
    out.conta = dig(d.conta); if (!out.conta) erros.push('Número da conta obrigatório'); out.digito = txt(d.digito, 2).toUpperCase();
    out.tipoConta = String(d.tipoConta || '').toLowerCase().trim(); if (!TIPO_CONTA[out.tipoConta]) erros.push('Tipo de conta: corrente, poupança ou pagamento');
    if (d.chavePix) { out.chavePix = txt(d.chavePix, 120); out.tipoChavePix = String(d.tipoChavePix || '').toLowerCase().trim(); }
  }
  return { dados: out, erros, avisos };
}
/** Nome da planilha × nome do PontoCerto: o CPF é a chave; o nome só confere. Listas do banco vêm truncadas ("DA SILV") ou com
 *  abreviação ("JOSE EDUARDO S PALMEIRA"), então cada palavra da planilha precisa ser prefixo de uma palavra do cadastro, na ordem. */
function nomesCompativeis(a, b) {
  const A = semAcento(a).split(/\s+/).filter(Boolean), B = semAcento(b).split(/\s+/).filter(Boolean); if (!A.length || !B.length) return true;
  if (A[0] !== B[0] && !B[0].startsWith(A[0])) return false;
  let j = 0; for (const w of A) { while (j < B.length && !B[j].startsWith(w)) j++; if (j >= B.length) return false; j++; }
  return true;
}
const tipoContaDe = s => { const t = semAcento(s); return /corr/.test(t) ? 'corrente' : /poup/.test(t) ? 'poupanca' : /pag/.test(t) ? 'pagamento' : t; };
const tipoPixDe = (s, chave) => { const t = semAcento(s); if (/cpf/.test(t)) return 'cpf'; if (/tel|cel|fone/.test(t)) return 'telefone'; if (/mail/.test(t)) return 'email'; if (/aleat|evp|rand/.test(t)) return 'aleatoria'; const k = String(chave || '').trim(); if (!k) return t; if (/@/.test(k)) return 'email'; if (/^[0-9a-f-]{32,36}$/i.test(k)) return 'aleatoria'; return dig(k).length === 11 ? 'cpf' : 'telefone'; };
const modalidadeDe = (s, chave) => { const t = semAcento(s); if (/pix/.test(t)) return 'pix'; if (/ted|transf|doc|conta/.test(t)) return 'transferencia'; return chave ? 'pix' : 'transferencia'; };

// ── versões ──
const versoesDe = funcId => contas().filter(c => String(c.funcId) === String(funcId)).sort((a, b) => a.versao - b.versao);
const atualValidada = funcId => { const v = versoesDe(funcId).filter(c => c.status === 'validado'); return v.length ? v[v.length - 1] : null; };
const pendenteDe = funcId => versoesDe(funcId).find(c => c.status === 'pendente' || c.status === 'em_correcao') || null;
const bloqueioDe = funcId => alertas().find(a => a.tipo === 'bloqueio' && a.aberto && String(a.funcId) === String(funcId)) || null;
const porId = id => { const v = contas().find(c => c.id === id); if (!v) throw erro('Versão bancária não encontrada', 404); return v; };
function proximoId() { const n = contas().reduce((m, c) => Math.max(m, +c.id.split('-')[1] || 0), 0) + 1; return 'CB-' + String(n).padStart(5, '0'); }
function situacaoFunc(funcId) {
  const vs = versoesDe(funcId), atual = atualValidada(funcId), pend = pendenteDe(funcId);
  let cadastral = 'nao_cadastrado'; if (pend) cadastral = pend.status; else if (atual) cadastral = 'validado'; else if (vs.length) cadastral = vs[vs.length - 1].status === 'rejeitado' ? 'rejeitado' : 'inativo';
  const al = alertas().filter(a => a.aberto && String(a.funcId) === String(funcId));
  return { cadastral, cadastralTxt: STATUS_TXT[cadastral], atual: atual ? { id: atual.id, versao: atual.versao, resumo: atual.resumo, validadoEm: atual.validacao.em } : null,
    pendente: pend ? { id: pend.id, versao: pend.versao, status: pend.status, criadoEm: pend.criadoEm, janela48h: !!(pend.seguranca.janela48h && pend.seguranca.janela48h.dentro) } : null,
    seguranca: { proximoPagamento: al.some(a => a.tipo === '48h'), recorrente: al.some(a => a.tipo === 'recorrente'), fraude: al.some(a => a.tipo === 'fraude'), bloqueado: al.some(a => a.tipo === 'bloqueio') },
    alertas: al.map(a => ({ id: a.id, tipo: a.tipo, tipoTxt: ALERTA_TXT[a.tipo] })), versoes: vs.length, ultimaAlteracao: vs.length ? vs[vs.length - 1].criadoEm : null };
}
/** versão como vai pra tela: dados completos só pra DP/Financeiro, senão só o resumo mascarado */
function versaoVisivel(v, user) { const { enc, ...resto } = v; return perm(user).completo ? { ...resto, dados: decifrar(enc) } : resto; }

// ── auditoria ──
function auditar(ev) {
  const em = agoraIso();
  appendLinha(P.auditoria(em.slice(0, 7)), { id: crypto.randomUUID(), em, usuario: ev.usuario ? ev.usuario.usuario : null, nome: ev.usuario ? (ev.usuario.nome || ev.usuario.usuario) : null, funcId: ev.funcId || null, nomeFunc: ev.nomeFunc || null, loja: ev.loja || null,
    acao: ev.acao, justificativa: ev.justificativa || null, resultado: ev.resultado || null, versaoAnterior: ev.versaoAnterior || null, versaoNova: ev.versaoNova || null, ref: ev.ref || null, detalhe: ev.detalhe || null });
}
function historico(q, user) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403); q = q || {};
  let arquivos = []; try { arquivos = fs.readdirSync(path.join(DIR, 'auditoria')).filter(f => f.endsWith('.jsonl')).sort().reverse(); } catch (e) {}
  if (q.de) arquivos = arquivos.filter(f => f.slice(0, 7) >= q.de.slice(0, 7)); if (q.ate) arquivos = arquivos.filter(f => f.slice(0, 7) <= q.ate.slice(0, 7));
  const out = [];
  for (const f of arquivos.slice(0, 24)) { for (const l of lerLinhas(path.join(DIR, 'auditoria', f))) { if (l.loja && !veLoja(user, l.loja)) continue; if (q.funcId && String(l.funcId) !== String(q.funcId)) continue; if (q.acao && l.acao !== q.acao) continue; if (q.de && l.em.slice(0, 10) < q.de) continue; if (q.ate && l.em.slice(0, 10) > q.ate) continue; if (q.q && !semAcento(l.nomeFunc + ' ' + l.nome + ' ' + l.versaoNova + ' ' + l.ref).includes(semAcento(q.q))) continue; out.push(l); } if (out.length > 2000) break; }
  return out.sort((a, b) => b.em.localeCompare(a.em)).slice(0, +q.limite || 500);
}

// ── pagamentos programados (regra das 48 h) ──
let fontePagamentos = () => [];   // o módulo de Pagamentos de Domingos/Feriados registra aqui os relatórios com data prevista
const setFontePagamentos = fn => { fontePagamentos = fn; };
function proximosPagamentos() {
  const agora = Date.now(); let extra = []; try { extra = fontePagamentos() || []; } catch (e) {}
  return [...config().pagamentosProgramados.map(p => ({ ...p, origem: 'agenda' })), ...extra].map(p => ({ ...p, ts: new Date(p.data + 'T' + (p.hora || '09:00') + ':00').getTime() })).filter(p => !isNaN(p.ts) && p.ts >= agora - 3600000).sort((a, b) => a.ts - b.ts);
}
function avaliar48h() {
  const l = proximosPagamentos(); if (!l.length) return { naoAvaliada: true, motivo: 'Nenhum pagamento programado conhecido: a regra das 48 h não pôde ser avaliada' };
  const prox = l[0], horas = (prox.ts - Date.now()) / 3600000, pagamento = { data: prox.data, hora: prox.hora || null, descricao: prox.descricao || null, relatorioId: prox.relatorioId || null };
  return horas <= config().janelaHoras ? { dentro: true, pagamento, horas: Math.round(horas * 10) / 10, confirmacao: null } : { dentro: false, pagamento, horas: Math.round(horas) };
}

// ── alertas ──
function abrirAlerta(a, user) {
  const n = alertas().reduce((m, x) => Math.max(m, +x.id.split('-')[1] || 0), 0) + 1;
  const al = { id: 'AL-' + String(n).padStart(5, '0'), ...a, tipoTxt: ALERTA_TXT[a.tipo], lojaTxt: GP.LOJA_TXT[a.loja] || '', aberto: true, criadoEm: agoraIso(), criadoPor: quem(user), atualizadoEm: agoraIso(), observacoes: [], historico: [{ em: agoraIso(), usuario: user.usuario, texto: 'Alerta aberto: ' + (a.texto || '') }], encerramento: null };
  alertas().push(al); salvarAlertas();
  auditar({ usuario: user, funcId: a.funcId, nomeFunc: a.nome, loja: a.loja, acao: 'alerta', resultado: a.tipo, ref: al.id, justificativa: a.texto });
  return al;
}
function verificarRecorrencia(v, user) {
  const c = config().recorrencia; const desde = Date.now() - c.dias * 86400000;
  const sols = versoesDe(v.funcId).filter(x => x.origem !== 'correcao' && new Date(x.criadoEm).getTime() >= desde);
  if (sols.length < c.qtd) return null;
  const sl = sols.map(s => ({ id: s.id, em: s.criadoEm, status: s.status, statusTxt: STATUS_TXT[s.status], por: s.criadoPor.nome }));
  let a = alertas().find(x => x.tipo === 'recorrente' && x.aberto && String(x.funcId) === String(v.funcId));
  if (a) { a.solicitacoes = sl; a.qtd = sl.length; a.atualizadoEm = agoraIso(); a.historico.push({ em: agoraIso(), usuario: user.usuario, texto: 'Nova solicitação ' + v.id + ' (' + sl.length + ' em ' + c.dias + ' dias)' }); salvarAlertas(); return a; }
  a = abrirAlerta({ tipo: 'recorrente', funcId: v.funcId, nome: v.nome, loja: v.loja, contaId: v.id, qtd: sl.length, solicitacoes: sl, texto: sl.length + ' solicitações de alteração bancária em ' + c.dias + ' dias' }, user);
  const dest = [...GP.usuariosPara(['coordenacao'])]; if (proximosPagamentos().length) dest.push(...GP.usuariosPara(['financeiro']));
  GP.notificar(dest, 'Atenção — alterações bancárias recorrentes: ' + v.nome + ' (' + (GP.LOJA_TXT[v.loja] || '') + '), ' + sl.length + ' solicitações em ' + c.dias + ' dias.', { url: '/termos-escala.html#seguranca' });
  return a;
}
function listarAlertas(q, user) { const p = perm(user); if (!p.alertas && !p.dir) throw erro('Sem acesso aos alertas', 403); q = q || {}; return alertas().filter(a => veLoja(user, a.loja)).filter(a => q.aberto == null || q.aberto === '' || String(!!a.aberto) === String(q.aberto === '1' || q.aberto === true)).filter(a => !q.tipo || a.tipo === q.tipo).filter(a => !q.funcId || String(a.funcId) === String(q.funcId)).sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm)).slice(0, 500); }
function observarAlerta(id, texto, user) { const p = perm(user); if (!p.alertas) throw erro('Sem permissão', 403); const a = alertas().find(x => x.id === id); if (!a) throw erro('Alerta não encontrado', 404); const t = txt(texto, 1000); if (t.length < 3) throw erro('Escreva a observação'); a.observacoes.push({ em: agoraIso(), ...quem(user), texto: t }); a.atualizadoEm = agoraIso(); salvarAlertas(); auditar({ usuario: user, funcId: a.funcId, nomeFunc: a.nome, loja: a.loja, acao: 'alerta_observacao', ref: a.id, justificativa: t }); return a; }
function encerrarAlerta(id, justificativa, user) {
  const a = alertas().find(x => x.id === id); if (!a) throw erro('Alerta não encontrado', 404); if (!a.aberto) throw erro('Alerta já encerrado');
  if (a.tipo === 'bloqueio') throw erro('Bloqueio só é liberado pelo Financeiro depois de revalidar o destino bancário (use "Liberar")');
  if (!perm(user).encerrarAlerta) throw erro('Só a Coordenação Administrativa encerra alertas', 403);
  const j = txt(justificativa, 1000); if (j.length < 5) throw erro('Informe a justificativa do encerramento');
  a.aberto = false; a.encerramento = { em: agoraIso(), ...quem(user), justificativa: j }; a.atualizadoEm = agoraIso(); salvarAlertas();
  auditar({ usuario: user, funcId: a.funcId, nomeFunc: a.nome, loja: a.loja, acao: 'alerta_encerrado', ref: a.id, justificativa: j }); return a;
}
function bloquear(funcId, motivo, user, deps) {
  if (!perm(user).bloquear) throw erro('Só Financeiro e Coordenação bloqueiam pagamentos', 403);
  const m = txt(motivo, 1000); if (m.length < 5) throw erro('Informe o motivo do bloqueio');
  if (bloqueioDe(funcId)) throw erro('Funcionário já está com pagamento bloqueado');
  const f = deps.func; const a = abrirAlerta({ tipo: 'bloqueio', funcId: f.id, nome: f.nome, loja: f.loja, motivo: m, texto: m }, user);
  GP.notificar([...GP.usuariosPara(['coordenacao']), ...GP.usuariosPara(['financeiro'])], 'Pagamento bloqueado para verificação: ' + f.nome + ' (' + (GP.LOJA_TXT[f.loja] || '') + ').', { url: '/termos-escala.html#seguranca' });
  return a;
}
function liberar(id, body, user) {
  if (!perm(user).liberar) throw erro('Só o Financeiro libera um bloqueio', 403);
  const a = alertas().find(x => x.id === id && x.tipo === 'bloqueio'); if (!a) throw erro('Bloqueio não encontrado', 404); if (!a.aberto) throw erro('Bloqueio já liberado');
  const r = txt(body.resolucao, 1500); if (r.length < 5) throw erro('Registre a resolução'); if (body.revalidado !== true) throw erro('Confirme que o destino bancário foi validado novamente antes de liberar');
  a.aberto = false; a.encerramento = { em: agoraIso(), ...quem(user), justificativa: r, revalidado: true }; a.atualizadoEm = agoraIso(); salvarAlertas();
  auditar({ usuario: user, funcId: a.funcId, nomeFunc: a.nome, loja: a.loja, acao: 'desbloqueio', ref: a.id, justificativa: r }); return a;
}

// ── cadastro / alteração / correção / cancelamento (DP) ──
async function colabDe(deps, funcId) { const col = await deps.colaboradores(); return col.ativos.find(x => String(x.id) === String(funcId)) || col.desligados.find(x => String(x.id) === String(funcId)) || null; }
async function criarVersao(funcId, body, user, deps, origem, opts) {
  opts = opts || {}; if (!perm(user).dp) throw erro('Só o DP / RH cadastra ou altera dados bancários', 403);
  const func = await colabDe(deps, funcId); if (!func) throw erro('Funcionário não encontrado no PontoCerto', 404);
  if (!veLoja(user, func.loja)) throw erro('Unidade fora do seu escopo', 403); if (func.ativo === false) throw erro('Funcionário desligado no PontoCerto: não é possível cadastrar');
  const cpfFunc = await deps.cpfDe(func.id);
  const { dados, erros, avisos } = normalizarDados(body.dados || body, func, cpfFunc); if (erros.length) throw erro(erros.join('; '), 400, { erros });
  const atual = atualValidada(func.id), pend = pendenteDe(func.id);
  if (pend) throw erro('Já existe a versão ' + pend.id + ' aguardando o Financeiro. Corrija essa versão ou aguarde a decisão.', 409);
  const just = txt(body.justificativa, 1000); if (atual && just.length < 5) throw erro('Alteração de dados bancários exige justificativa');
  const seg = avaliar48h(); const id = proximoId(); const em = agoraIso();
  const v = { id, funcId: func.id, nome: func.nome, cpf_fim: func.cpf_fim || '', loja: func.loja, lojaTxt: GP.LOJA_TXT[func.loja] || '', cargo: func.cargo || '', versao: versoesDe(func.id).length + 1, status: 'pendente', origem, enc: cifrar(dados), resumo: resumoDe(dados), avisos,
    justificativa: just || null, substitui: atual ? atual.id : null, preferencial: false, criadoPor: quem(user), criadoEm: em,
    seguranca: { janela48h: seg.naoAvaliada ? { naoAvaliada: true, motivo: seg.motivo } : (seg.dentro ? seg : null), proximoPagamento: seg.pagamento || null, titularidadeConferida: false }, validacao: null,
    historico: [{ em, usuario: user.usuario, acao: atual ? 'alteracao' : 'cadastro', texto: just || null }] };
  contas().push(v); salvarContas();
  auditar({ usuario: user, funcId: v.funcId, nomeFunc: v.nome, loja: v.loja, acao: atual ? 'alteracao' : (origem === 'importacao' ? 'importacao' : 'criacao'), justificativa: just, versaoAnterior: atual ? atual.id : null, versaoNova: id, detalhe: v.resumo });
  const url = { url: '/termos-escala.html#validacao' };
  if (v.seguranca.janela48h && v.seguranca.janela48h.dentro) {
    abrirAlerta({ tipo: '48h', funcId: v.funcId, nome: v.nome, loja: v.loja, contaId: id, pagamento: seg.pagamento, horas: seg.horas, texto: 'Alteração bancária a ' + seg.horas + ' h do pagamento de ' + seg.pagamento.data + (seg.pagamento.descricao ? ' (' + seg.pagamento.descricao + ')' : '') }, user);
    GP.notificar([...GP.usuariosPara(['financeiro']), ...GP.usuariosPara(['coordenacao'])], 'PRIORITÁRIO: alteração bancária de ' + v.nome + ' a ' + seg.horas + ' h do pagamento de ' + seg.pagamento.data + '. Exige confirmação por canal independente.', url);
  } else if (!opts.silencioso) GP.notificar(GP.usuariosPara(['financeiro']), (atual ? 'Alteração bancária' : 'Novo cadastro bancário') + ' de ' + v.nome + ' (' + v.lojaTxt + ') aguarda validação.', url);
  verificarRecorrencia(v, user);
  return v;
}
async function corrigir(contaId, body, user, deps) {
  if (!perm(user).dp) throw erro('Só o DP / RH corrige dados bancários', 403);
  const v = porId(contaId); if (!['pendente', 'em_correcao'].includes(v.status)) throw erro('Só versões pendentes ou em correção podem ser corrigidas (versão validada = nova alteração)');
  if (!veLoja(user, v.loja)) throw erro('Unidade fora do seu escopo', 403);
  const func = await colabDe(deps, v.funcId); const cpfFunc = func ? await deps.cpfDe(func.id) : '';
  const { dados, erros, avisos } = normalizarDados(body.dados || body, func || { nome: v.nome }, cpfFunc); if (erros.length) throw erro(erros.join('; '), 400, { erros });
  const antes = v.resumo; v.enc = cifrar(dados); v.resumo = resumoDe(dados); v.avisos = avisos; v.status = 'pendente'; v.corrigidoEm = agoraIso();
  v.historico.push({ em: agoraIso(), usuario: user.usuario, acao: 'correcao', texto: txt(body.justificativa, 500) || null, antes, depois: v.resumo }); salvarContas();
  auditar({ usuario: user, funcId: v.funcId, nomeFunc: v.nome, loja: v.loja, acao: 'correcao', justificativa: txt(body.justificativa, 500), versaoNova: v.id, detalhe: { antes, depois: v.resumo } });
  GP.notificar(GP.usuariosPara(['financeiro']), 'Dados bancários de ' + v.nome + ' corrigidos pelo DP: ' + v.id + ' volta para validação.', { url: '/termos-escala.html#validacao' });
  return v;
}
function cancelarSolicitacao(contaId, motivo, user) {
  if (!perm(user).dp) throw erro('Só o DP / RH cancela a própria solicitação', 403);
  const v = porId(contaId); if (!['pendente', 'em_correcao'].includes(v.status)) throw erro('Só solicitações pendentes podem ser canceladas');
  const m = txt(motivo, 500); if (m.length < 5) throw erro('Informe o motivo');
  v.status = 'cancelada'; v.validacao = { ...quem(user), em: agoraIso(), resultado: 'cancelada', obs: m }; v.historico.push({ em: agoraIso(), usuario: user.usuario, acao: 'cancelada', texto: m });
  fecharAlertas48h(v.id, user, 'Solicitação cancelada'); salvarContas();
  auditar({ usuario: user, funcId: v.funcId, nomeFunc: v.nome, loja: v.loja, acao: 'cancelamento', justificativa: m, versaoNova: v.id }); return v;
}
function fecharAlertas48h(contaId, user, texto) { for (const a of alertas()) if (a.tipo === '48h' && a.aberto && a.contaId === contaId) { a.aberto = false; a.encerramento = { em: agoraIso(), ...quem(user), justificativa: texto, automatico: true }; a.atualizadoEm = agoraIso(); } salvarAlertas(); }

// ── validação (Financeiro) ──
function validar(contaId, body, user) {
  body = body || {}; if (!perm(user).validar) throw erro('Só o Financeiro valida dados bancários', 403);
  const v = porId(contaId); if (!['pendente', 'em_correcao'].includes(v.status)) throw erro('Esta versão não está aguardando validação (' + STATUS_TXT[v.status] + ')');
  if (v.criadoPor.usuario === user.usuario) throw erro('Quem cadastrou ou alterou não pode validar a própria solicitação (dupla conferência)', 403);
  const r = String(body.resultado || ''); if (!['validado', 'rejeitado', 'correcao', 'fraude'].includes(r)) throw erro('Resultado inválido');
  const obs = txt(body.obs, 1500); if (r !== 'validado' && obs.length < 5) throw erro('Informe a observação / motivo');
  const j = v.seguranca.janela48h; const em = agoraIso();
  if (r === 'validado') {
    if (body.titularidadeConferida !== true) throw erro('Confirme que a titularidade e a autenticidade da solicitação foram conferidas');
    if (bloqueioDe(v.funcId)) throw erro('Funcionário com pagamento bloqueado para verificação: libere o bloqueio antes de validar', 409);
    if (j && j.dentro) {
      const met = txt(body.confirmacao && body.confirmacao.metodo, 200); if (!met) throw erro('Alteração próxima ao pagamento: informe o método de confirmação por canal independente (ligação para o telefone já cadastrado, presencial…)', 400, { exigeConfirmacao: true });
      j.confirmacao = { metodo: met, obs: txt(body.confirmacao.obs, 500), ...quem(user), em, resultado: 'confirmada' };
    }
    const ant = atualValidada(v.funcId); if (ant) { ant.status = 'inativo'; ant.preferencial = false; ant.inativadoEm = em; ant.substituidaPor = v.id; ant.historico.push({ em, usuario: user.usuario, acao: 'inativada', texto: 'Substituída pela versão ' + v.id }); }
    v.status = 'validado'; v.preferencial = true; v.seguranca.titularidadeConferida = true;
  } else if (r === 'rejeitado') v.status = 'rejeitado';
  else if (r === 'correcao') v.status = 'em_correcao';
  else { v.status = 'rejeitado'; v.suspeitaFraude = true; }
  v.validacao = { ...quem(user), em, resultado: r, obs, titularidadeConferida: body.titularidadeConferida === true };
  v.historico.push({ em, usuario: user.usuario, acao: r, texto: obs || null }); salvarContas();
  if (r !== 'correcao') fecharAlertas48h(v.id, user, 'Solicitação ' + STATUS_TXT[v.status].toLowerCase());
  auditar({ usuario: user, funcId: v.funcId, nomeFunc: v.nome, loja: v.loja, acao: { validado: 'aprovacao', rejeitado: 'rejeicao', correcao: 'solicitacao_correcao', fraude: 'suspeita_fraude' }[r], justificativa: obs, resultado: r, versaoAnterior: v.substitui, versaoNova: v.id });
  const dp = [v.criadoPor.usuario, ...GP.usuariosPara(['rh_doc'], v.loja)];
  if (r === 'fraude') {
    abrirAlerta({ tipo: 'fraude', funcId: v.funcId, nome: v.nome, loja: v.loja, contaId: v.id, texto: obs }, user);
    if (!bloqueioDe(v.funcId)) abrirAlerta({ tipo: 'bloqueio', funcId: v.funcId, nome: v.nome, loja: v.loja, contaId: v.id, motivo: 'Suspeita de fraude sinalizada pelo Financeiro em ' + v.id, texto: 'Suspeita de fraude: ' + obs }, user);
    GP.notificar([...GP.usuariosPara(['coordenacao']), ...dp], 'SUSPEITA DE FRAUDE em dados bancários de ' + v.nome + ' (' + v.lojaTxt + '): pagamento bloqueado para verificação.', { url: '/termos-escala.html#seguranca' });
  } else GP.notificar(dp, 'Dados bancários de ' + v.nome + ' (' + v.id + '): ' + ({ validado: 'validados pelo Financeiro', rejeitado: 'rejeitados — ' + obs, correcao: 'o Financeiro pediu correção — ' + obs })[r], { url: '/termos-escala.html#banco' });
  return v;
}
function validarLote(ids, body, user) {
  body = body || {}; if (!perm(user).validar) throw erro('Só o Financeiro valida', 403); if (body.conferidos !== true) throw erro('Confirme que cada registro foi efetivamente conferido');
  const ok = [], falhas = [];
  for (const id of [...new Set((ids || []).map(String))]) { try { const v = validar(id, { resultado: 'validado', obs: txt(body.obs, 500) || 'Validação em lote', titularidadeConferida: true }, user); ok.push({ id: v.id, nome: v.nome }); } catch (e) { falhas.push({ id, erro: e.message }); } }
  auditar({ usuario: user, acao: 'validacao_lote', resultado: ok.length + ' validados, ' + falhas.length + ' falhas', justificativa: txt(body.obs, 500), detalhe: { ok: ok.map(x => x.id), falhas } });
  return { validados: ok, falhas };
}

// ── consultas ──
async function listarFuncionarios(q, user, deps) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso ao cadastro bancário', 403); q = q || {};
  const col = await deps.colaboradores(); const lojas = lojasDe(user); const base = q.inativos === '1' ? [...col.ativos, ...col.desligados] : col.ativos;
  const qs = semAcento(q.q), qd = dig(q.q);
  const rows = [];
  for (const c of base) {
    if (!lojas.includes(+c.loja)) continue; if (q.loja && +c.loja !== +q.loja) continue;
    if (qs && !(semAcento(c.nome).includes(qs) || (qd && dig(c.cpf_fim).includes(qd)))) continue;
    const s = situacaoFunc(c.id);
    if (q.status && s.cadastral !== q.status) continue; if (q.modalidade && !(s.atual && s.atual.resumo.modalidade === q.modalidade)) continue;
    if (q.seguranca === '1' && !Object.values(s.seguranca).some(Boolean)) continue;
    rows.push({ id: c.id, nome: c.nome, cpf_fim: c.cpf_fim, loja: c.loja, lojaTxt: GP.LOJA_TXT[c.loja] || c.loja_nome || '', cargo: c.cargo, setor: c.setor, ativo: c.ativo !== false, situacao: s });
  }
  return { funcionarios: rows.sort((a, b) => a.loja - b.loja || a.nome.localeCompare(b.nome, 'pt-BR')), gerado_em: col.gerado_em, total: rows.length };
}
async function ficha(funcId, user, deps) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403);
  const c = await colabDe(deps, funcId); if (!c) throw erro('Funcionário não encontrado no PontoCerto', 404); if (!veLoja(user, c.loja)) throw erro('Unidade fora do seu escopo', 403);
  return { funcionario: { id: c.id, nome: c.nome, cpf_fim: c.cpf_fim, loja: c.loja, lojaTxt: GP.LOJA_TXT[c.loja] || '', cargo: c.cargo, setor: c.setor, ativo: c.ativo !== false, admissao: c.admissao, desligamento: c.desligamento || null },
    situacao: situacaoFunc(c.id), versoes: versoesDe(c.id).map(v => versaoVisivel(v, user)).reverse(), alertas: alertas().filter(a => String(a.funcId) === String(c.id)).sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm)), auditoria: historico({ funcId: c.id, limite: 100 }, user), permissoes: p };
}
function pendentes(user) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403);
  const pri = v => (v.seguranca.janela48h && v.seguranca.janela48h.dentro) ? 0 : 1;
  return contas().filter(v => ['pendente', 'em_correcao'].includes(v.status) && veLoja(user, v.loja)).sort((a, b) => pri(a) - pri(b) || a.criadoEm.localeCompare(b.criadoEm))
    .map(v => ({ ...versaoVisivel(v, user), bloqueado: !!bloqueioDe(v.funcId), recorrente: alertas().some(a => a.tipo === 'recorrente' && a.aberto && String(a.funcId) === String(v.funcId)), autoValidacaoProibida: v.criadoPor.usuario === user.usuario }));
}
async function painel(q, user, deps) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403); q = q || {};
  const col = await deps.colaboradores(); const lojas = lojasDe(user).filter(l => !q.loja || +l === +q.loja); const desde = Date.now() - 30 * 86400000;
  const por = {}; const L = l => por[l] || (por[l] = { loja: l, lojaTxt: GP.LOJA_TXT[l] || '', total: 0, validados: 0, pendentes: 0, rejeitados: 0, sem: 0, alertas: 0 });
  const tot = { ativos: 0, comCadastro: 0, validados: 0, pendentes: 0, rejeitados: 0, semCadastro: 0, alteracoes30d: 0, pix: 0, transferencia: 0 };
  for (const c of col.ativos) { if (!lojas.includes(+c.loja)) continue; const s = situacaoFunc(c.id); const l = L(+c.loja); l.total++; tot.ativos++;
    if (s.cadastral === 'validado') { l.validados++; tot.validados++; tot.comCadastro++; tot[s.atual.resumo.modalidade] = (tot[s.atual.resumo.modalidade] || 0) + 1; }
    else if (s.cadastral === 'pendente' || s.cadastral === 'em_correcao') { l.pendentes++; tot.pendentes++; tot.comCadastro++; }
    else if (s.cadastral === 'rejeitado') { l.rejeitados++; tot.rejeitados++; l.sem++; tot.semCadastro++; } else { l.sem++; tot.semCadastro++; }
    if (s.alertas.length) l.alertas += s.alertas.length; }
  tot.alteracoes30d = contas().filter(v => lojas.includes(+v.loja) && new Date(v.criadoEm).getTime() >= desde).length;
  const ab = alertas().filter(a => a.aberto && lojas.includes(+a.loja)); const porTipo = {}; for (const a of ab) porTipo[a.tipo] = (porTipo[a.tipo] || 0) + 1;
  return { totais: tot, porUnidade: Object.values(por).sort((a, b) => a.loja - b.loja), alertasAbertos: porTipo, pendentesValidacao: contas().filter(v => ['pendente', 'em_correcao'].includes(v.status) && lojas.includes(+v.loja)).length, proximosPagamentos: proximosPagamentos().slice(0, 5).map(x => ({ data: x.data, hora: x.hora || null, descricao: x.descricao || null, relatorioId: x.relatorioId || null })), gerado_em: col.gerado_em, config: config() };
}
function salvarConfig(mud, user) {
  if (!perm(user).configurar) throw erro('Só a Coordenação Administrativa altera os parâmetros de segurança', 403); mud = mud || {};
  const c = config(); const antes = { recorrencia: c.recorrencia, janelaHoras: c.janelaHoras, pagamentos: c.pagamentosProgramados.length };
  if (mud.recorrencia) { const q = +mud.recorrencia.qtd, d = +mud.recorrencia.dias; if (!(q >= 2 && q <= 20) || !(d >= 7 && d <= 365)) throw erro('Recorrência: quantidade 2–20 e período 7–365 dias'); c.recorrencia = { qtd: q, dias: d }; }
  if (mud.janelaHoras != null) { const h = +mud.janelaHoras; if (!(h >= 1 && h <= 240)) throw erro('Janela de 1 a 240 horas'); c.janelaHoras = h; }
  if (Array.isArray(mud.pagamentosProgramados)) { c.pagamentosProgramados = mud.pagamentosProgramados.map(p => ({ data: String(p.data || ''), hora: /^\d{2}:\d{2}$/.test(p.hora || '') ? p.hora : '09:00', descricao: txt(p.descricao, 120) })).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.data)).sort((a, b) => a.data.localeCompare(b.data)); }
  const j = txt(mud.justificativa, 500); c.alteracoes = [...(c.alteracoes || []), { em: agoraIso(), ...quem(user), justificativa: j || null, antes }].slice(-100);
  gravarJson(P.config, c); auditar({ usuario: user, acao: 'config', justificativa: j, detalhe: { recorrencia: c.recorrencia, janelaHoras: c.janelaHoras, pagamentos: c.pagamentosProgramados.length } }); return c;
}

// ── importação da planilha do Financeiro ──
const previas = new Map();   // token → { em, usuario, arquivo, linhas } (30 min; a planilha não é guardada em disco)
const limparPrevias = () => { const lim = Date.now() - 30 * 60000; for (const [k, v] of previas) if (v.em < lim) previas.delete(k); };
const CAB = { cpf: ['cpf', 'cpfdofuncionario'], nome: ['nomecompleto', 'nome', 'funcionario', 'colaborador'], banco: ['banco', 'nomedobanco'], codigoBanco: ['codigodobanco', 'codigobanco', 'codbanco', 'codigo'], agencia: ['agencia', 'ag'], conta: ['conta', 'numerodaconta', 'numeroconta', 'contanumero'], digito: ['digito', 'digitodaconta', 'dv', 'dig'], tipoConta: ['tipodeconta', 'tipoconta', 'tipo'], titular: ['titular', 'nomedotitular'], cpfTitular: ['cpfdotitular', 'cpftitular'], chavePix: ['chavepix', 'pix', 'chave'], tipoChavePix: ['tipodechavepix', 'tipochavepix', 'tipopix', 'tipodachave'], modalidade: ['modalidadepreferencialdepagamento', 'modalidade', 'modalidadepreferencial', 'formadepagamento', 'pagamento'] };
async function modeloXlsx() {
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); wb.creator = 'Econômico Relatórios';
  const ws = wb.addWorksheet('Dados bancários');
  ws.columns = [['CPF', 16], ['Nome completo', 34], ['Banco', 24], ['Código do banco', 10], ['Agência', 10], ['Conta', 14], ['Dígito', 8], ['Tipo de conta', 14], ['Titular', 34], ['CPF do titular', 16], ['Chave Pix', 30], ['Tipo de chave Pix', 14], ['Modalidade preferencial de pagamento', 22]].map(([h, w]) => ({ header: h, key: h, width: w }));
  ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6ECF4' } };
  ws.addRow(['000.000.000-00', 'NOME DO FUNCIONÁRIO (EXEMPLO)', 'Banco do Brasil', '001', '1234', '567890', '1', 'corrente', 'NOME DO FUNCIONÁRIO (EXEMPLO)', '000.000.000-00', '', '', 'transferencia']);
  ws.addRow(['000.000.000-01', 'OUTRO EXEMPLO (APAGUE ESTAS LINHAS)', '', '', '', '', '', '', 'OUTRO EXEMPLO', '000.000.000-01', 'exemplo@email.com', 'email', 'pix']);
  const i = wb.addWorksheet('Instruções');
  ['Uma linha por funcionário. O CPF localiza a pessoa no cadastro do PontoCerto (o nome só confere).', 'Modalidade: "pix" ou "transferencia". No Pix basta a chave e o tipo (cpf, telefone, email, aleatoria); na transferência banco, código, agência, conta, dígito e tipo (corrente, poupanca, pagamento).', 'Titular / CPF do titular: se vazios, assume o próprio funcionário. Conta de terceiro é aceita, mas o Financeiro precisa confirmar a titularidade.', 'Quem já tem dados validados ou pendentes NÃO é substituído pela importação (faça pela ficha, com justificativa).', 'Tudo que importar entra como "Pendente de validação" para o Financeiro conferir.'].forEach(t => i.addRow([t]));
  i.getColumn(1).width = 120;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function importarPrevia(buffer, nomeArquivo, user, deps) {
  if (!perm(user).importar) throw erro('Só o DP / RH importa planilhas', 403);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); try { await wb.xlsx.load(buffer); } catch (e) { throw erro('Arquivo não é um .xlsx válido'); }
  const ws = wb.worksheets[0]; if (!ws || ws.rowCount < 2) throw erro('Planilha vazia');
  const cab = {}; ws.getRow(1).eachCell((c, i) => { cab[semAcento(c.text != null ? c.text : c.value).replace(/[^a-z0-9]/g, '')] = i; });
  const idx = {}; for (const k in CAB) idx[k] = CAB[k].map(a => cab[a]).find(Boolean) || null;
  if (!idx.cpf) throw erro('Coluna "CPF" não encontrada na primeira linha (baixe o modelo)');
  const col = await deps.colaboradores(); const porCpf = new Map();
  for (const c of [...col.ativos, ...col.desligados]) { const cpf = await deps.cpfDe(c.id); if (cpf && !porCpf.has(cpf)) porCpf.set(cpf, c); }
  const linhas = [], vistos = new Map();
  ws.eachRow((row, n) => {
    if (n === 1) return; const g = k => { if (!idx[k]) return ''; const cell = row.getCell(idx[k]); const v = cell.text != null && cell.text !== '' ? cell.text : cell.value; return v == null ? '' : String(typeof v === 'object' && v.result != null ? v.result : v).trim(); };
    const cpf = dig(g('cpf')); if (!cpf && !g('nome')) return;
    const ch = g('chavePix'); const l = { linha: n, cpfMask: cpf.length === 11 ? '***.***.' + cpf.slice(6, 9) + '-' + cpf.slice(9) : (cpf || '—'), nome: g('nome'), problemas: [], avisos: [], classe: 'valido', resumo: null, funcId: null, funcNome: null, loja: null, lojaTxt: '', cargo: '' };
    const entrada = { banco: g('banco'), codigoBanco: g('codigoBanco'), agencia: g('agencia'), conta: g('conta'), digito: g('digito'), tipoConta: tipoContaDe(g('tipoConta')), titular: g('titular'), cpfTitular: g('cpfTitular'), chavePix: ch, tipoChavePix: tipoPixDe(g('tipoChavePix'), ch), modalidade: modalidadeDe(g('modalidade'), ch) };
    const marca = (classe, msg) => { if (l.classe === 'valido') l.classe = classe; l.problemas.push(msg); };
    if (cpf.length !== 11) marca('nao_localizado', 'CPF inválido');
    else {
      if (vistos.has(cpf)) marca('duplicado', 'CPF repetido na planilha (linha ' + vistos.get(cpf) + ')'); else vistos.set(cpf, n);
      const f = porCpf.get(cpf);
      if (!f) marca('nao_localizado', 'CPF não encontrado no cadastro do PontoCerto');
      else {
        l.funcId = f.id; l.funcNome = f.nome; l.loja = f.loja; l.lojaTxt = GP.LOJA_TXT[f.loja] || ''; l.cargo = f.cargo || '';
        if (f.ativo === false) marca('inativo', 'Funcionário desligado no PontoCerto');
        else {
          if (l.nome && !nomesCompativeis(l.nome, f.nome)) marca('revisao', 'Nome na planilha difere do cadastro (' + f.nome + ')');
          const s = situacaoFunc(f.id); if (s.cadastral === 'validado' || s.pendente) marca('ja_cadastrado', 'Já tem dados bancários ' + (s.pendente ? 'pendentes (' + s.pendente.id + ')' : 'validados (' + s.atual.id + ')') + ' — não será substituído');
          if (!veLoja(user, f.loja)) marca('revisao', 'Unidade fora do seu escopo');
          const nd = normalizarDados(entrada, f, cpf); if (nd.erros.length) { marca('invalido', nd.erros.join('; ')); } l.avisos = nd.avisos; l.resumo = resumoDe(nd.dados);
        }
      }
    }
    linhas.push({ ...l, _entrada: entrada });
  });
  limparPrevias(); const token = crypto.randomUUID(); previas.set(token, { em: Date.now(), usuario: user.usuario, arquivo: txt(nomeArquivo, 120), linhas });
  const n = k => linhas.filter(l => l.classe === k).length;
  auditar({ usuario: user, acao: 'importacao_previa', detalhe: { arquivo: txt(nomeArquivo, 120), total: linhas.length, validos: n('valido') } });
  return { token, arquivo: txt(nomeArquivo, 120), total: linhas.length, validos: n('valido'), revisao: n('revisao'), naoLocalizados: n('nao_localizado'), inativos: n('inativo'), duplicados: n('duplicado'), jaCadastrados: n('ja_cadastrado'), invalidos: n('invalido'), linhas: linhas.map(({ _entrada, ...l }) => l) };
}
async function importarConfirmar(token, indices, user, deps) {
  if (!perm(user).importar) throw erro('Só o DP / RH importa planilhas', 403);
  const pv = previas.get(token); if (!pv || pv.usuario !== user.usuario) throw erro('Prévia expirada ou de outro usuário: envie a planilha de novo');
  // válidos entram por padrão; linha "revisão" (nome com grafia diferente, mesmo CPF) só entra se o operador marcou explicitamente
  const marcados = Array.isArray(indices) ? indices.map(Number) : [];
  const sel = pv.linhas.filter(l => (l.classe === 'valido' && (!marcados.length || marcados.includes(l.linha))) || (l.classe === 'revisao' && marcados.includes(l.linha)));
  if (!sel.length) throw erro('Nenhum registro válido selecionado');
  const criados = [], falhas = [];
  for (const l of sel) { try { const v = await criarVersao(l.funcId, { dados: l._entrada, justificativa: 'Importação inicial da planilha do Financeiro (' + pv.arquivo + ', linha ' + l.linha + ')' }, user, deps, 'importacao', { silencioso: true }); criados.push({ id: v.id, nome: v.nome, loja: v.loja }); } catch (e) { falhas.push({ linha: l.linha, nome: l.funcNome, erro: e.message }); } }
  previas.delete(token);
  const n = importacoes().reduce((m, x) => Math.max(m, +x.id.split('-')[1] || 0), 0) + 1;
  const reg = { id: 'IMP-' + String(n).padStart(4, '0'), em: agoraIso(), usuario: quem(user), arquivo: pv.arquivo, totalPlanilha: pv.linhas.length, selecionados: sel.length, criados: criados.length, falhas: falhas.length, criadosIds: criados.map(c => c.id), falhasDetalhe: falhas, classes: Object.fromEntries(['valido', 'revisao', 'nao_localizado', 'inativo', 'duplicado', 'ja_cadastrado', 'invalido'].map(k => [k, pv.linhas.filter(l => l.classe === k).length])) };
  importacoes().push(reg); salvarImportacoes();
  auditar({ usuario: user, acao: 'importacao', ref: reg.id, resultado: criados.length + ' criados, ' + falhas.length + ' falhas', detalhe: { arquivo: pv.arquivo, criados: reg.criadosIds } });
  if (criados.length) GP.notificar(GP.usuariosPara(['financeiro']), 'Importação ' + reg.id + ': ' + criados.length + ' cadastros bancários aguardam validação.', { url: '/termos-escala.html#validacao' });
  return reg;
}

// ── integração com pagamentos (só servidor; quem chama decide o que expõe) ──
function paraPagamento(funcId) {
  const s = situacaoFunc(funcId); const atual = atualValidada(funcId); const bloq = bloqueioDe(funcId);
  const pendNova = !!s.pendente, j48 = !!(s.pendente && s.pendente.janela48h);
  let motivo = null; if (bloq) motivo = 'Pagamento bloqueado para verificação (' + bloq.id + ')'; else if (!atual) motivo = s.cadastral === 'nao_cadastrado' ? 'Dados bancários pendentes (sem cadastro)' : 'Dados bancários pendentes (' + STATUS_TXT[s.cadastral].toLowerCase() + ')';
  return { funcId, cadastral: s.cadastral, cadastralTxt: s.cadastralTxt, apto: !!atual && !bloq, bloqueado: !!bloq, bloqueioId: bloq ? bloq.id : null, recorrente: s.seguranca.recorrente, fraude: s.seguranca.fraude, pendenteNova: pendNova, pendenteJanela48h: j48, motivo,
    conta: atual ? { id: atual.id, versao: atual.versao, modalidade: atual.resumo.modalidade, resumo: atual.resumo, validadoEm: atual.validacao.em, validadoPor: atual.validacao.nome, dados: decifrar(atual.enc) } : null };
}
function registrarUso(funcId, contaId, relatorioId, user) { const v = contas().find(c => c.id === contaId); auditar({ usuario: user, funcId, nomeFunc: v ? v.nome : null, loja: v ? v.loja : null, acao: 'utilizacao_pagamento', ref: relatorioId, versaoNova: contaId }); }

module.exports = { DIR, BANCOS, nomesCompativeis, TIPO_CONTA, TIPO_PIX, MODALIDADE, STATUS_TXT, ALERTA_TXT, config, salvarConfig, perm, veLoja, lojasDe, cifrar, decifrar, normalizarDados, resumoDe, situacaoFunc, versaoVisivel, criarVersao, corrigir, cancelarSolicitacao, validar, validarLote,
  listarFuncionarios, ficha, pendentes, painel, historico, listarAlertas, observarAlerta, encerrarAlerta, bloquear, liberar, colabDe, modeloXlsx, importarPrevia, importarConfirmar, importacoes, paraPagamento, registrarUso, setFontePagamentos, proximosPagamentos, auditar };
