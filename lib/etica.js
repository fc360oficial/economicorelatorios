'use strict';
// Canal de Ética e Denúncias — regras e dados (16/10/2026).
// Base: "prompt mestre" + Especificação V1.0 (PDF de 16/10). Decisões do Tiago em 16/10:
//  - começa em JSON (1 arquivo por caso + eventos .jsonl append-only, pasta fora do backup geral) e migra pra
//    banco antes de abrir pras 6 lojas; por isso TODO acesso a disco fica neste módulo (camada de dados);
//  - acompanhamento do denunciante é SOMENTE LEITURA (etapa, datas, resultado): não há caixa de mensagens;
//  - retaguarda dentro do Econômico Relatórios (DP / RH › Canal de Ética), portal público fora (/etica).
// Estrutura em data/etica/:
//   config.json                 unidades, categorias, políticas de prazo, cadeia, designados, calendário
//   casos/<PROT>.json           o caso (sem identidade do denunciante)
//   casos/<PROT>.ident.json     identidade opcional (cifrada com ETICA_KEY quando a variável existe)
//   casos/<PROT>.eventos.jsonl  histórico append-only, cada linha com hash da anterior (verificarCadeia)
//   omissoes/<OM>.json          avaliação administrativa separada por descumprimento de prazo
//   anexos/<PROT>/              arquivos enviados (nunca servidos como estático)
//   notificacoes.jsonl          avisos internos (painel); e-mail/WhatsApp só com texto genérico, nunca conteúdo
//   auditoria/AAAA-MM.jsonl     quem leu/exportou o quê (separado do log de acessos do sistema)
//   tentativas.json             tentativas erradas de consulta por protocolo (5/hora)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.ETICA_DIR || path.join(__dirname, '..', 'data', 'etica');
const P = {
  config: () => path.join(DIR, 'config.json'),
  casos: () => path.join(DIR, 'casos'),
  caso: p => path.join(DIR, 'casos', p + '.json'),
  ident: p => path.join(DIR, 'casos', p + '.ident.json'),
  eventos: p => path.join(DIR, 'casos', p + '.eventos.jsonl'),
  omissoes: () => path.join(DIR, 'omissoes'),
  omissao: id => path.join(DIR, 'omissoes', id + '.json'),
  anexos: p => path.join(DIR, 'anexos', p),
  notificacoes: () => path.join(DIR, 'notificacoes.jsonl'),
  auditoria: d => path.join(DIR, 'auditoria', String(d).slice(0, 7) + '.jsonl'),
  tentativas: () => path.join(DIR, 'tentativas.json'),
};

// ── Catálogos ────────────────────────────────────────────────────────────────
const UNIDADES = [
  { cod: 'E1', nome: 'Socorro' }, { cod: 'E2', nome: 'Muribeca' }, { cod: 'E3', nome: 'Ponte' },
  { cod: 'E4', nome: 'Atacarejo' }, { cod: 'E5', nome: 'Porta Larga' }, { cod: 'E6', nome: 'Jardim Jordão' },
  { cod: 'CD', nome: 'Centro de Distribuição' }, { cod: 'ADM', nome: 'Administrativo' }, { cod: 'NI', nome: 'Não informada' },
];
const CATEGORIAS = [
  { id: 'assedio_moral', nome: 'Assédio moral', prioridade: 'alta' },
  { id: 'assedio_sexual', nome: 'Assédio sexual', prioridade: 'alta' },
  { id: 'discriminacao', nome: 'Discriminação', prioridade: 'alta' },
  { id: 'fraude', nome: 'Fraude, furto ou desvio de mercadoria', prioridade: 'alta' },
  { id: 'conflito', nome: 'Conflito de interesses / favorecimento', prioridade: 'media' },
  { id: 'seg_alimentar', nome: 'Segurança alimentar / sanitária', prioridade: 'media' },
  { id: 'seg_trabalho', nome: 'Segurança do trabalho', prioridade: 'media' },
  { id: 'normas', nome: 'Descumprimento de normas internas', prioridade: 'baixa' },
  { id: 'retaliacao', nome: 'Retaliação a denunciante', prioridade: 'alta' },
  { id: 'outro', nome: 'Outro', prioridade: 'media' },
];
const PRIORIDADES = ['critica', 'alta', 'media', 'baixa'];
const PRIORIDADE_TXT = { critica: 'Crítica', alta: 'Alta', media: 'Média', baixa: 'Baixa' };
// Política de prazos: h = horas corridas, du = dias úteis. Proposta do doc. V1.0 (pág. 8) — depende de Direção+RH+Jurídico.
const POLITICAS_PADRAO = {
  critica: { triagem: { h: 1 }, aceite: { h: 2 }, providencia: { h: 2 }, investigacao: { du: 10 }, validacao: { du: 2 }, comunicacao: { du: 2 } },
  alta:    { triagem: { h: 4 }, aceite: { h: 8 }, providencia: { h: 24 }, investigacao: { du: 20 }, validacao: { du: 3 }, comunicacao: { du: 2 } },
  media:   { triagem: { du: 1 }, aceite: { du: 1 }, providencia: { du: 2 }, investigacao: { du: 30 }, validacao: { du: 3 }, comunicacao: { du: 2 } },
  baixa:   { triagem: { du: 2 }, aceite: { du: 2 }, providencia: { du: 5 }, investigacao: { du: 45 }, validacao: { du: 5 }, comunicacao: { du: 3 } },
};
const ETAPAS_PRAZO = ['triagem', 'aceite', 'providencia', 'investigacao', 'validacao', 'comunicacao'];
const ETAPA_TXT = { triagem: 'Triagem', aceite: 'Aceite', providencia: '1ª providência', investigacao: 'Investigação', validacao: 'Validação', comunicacao: 'Comunicação do resultado' };
// Cadeia: RH → Jurídico → Coordenação Administrativa → autoridade independente. Nunca volta ao RH.
const CADEIA_PADRAO = [
  { id: 'rh', nome: 'RH', papel: 'rh' },
  { id: 'juridico', nome: 'Jurídico', papel: 'juridico' },
  { id: 'coordenacao', nome: 'Coordenação Administrativa', papel: 'coordenacao' },
  { id: 'independente', nome: 'Autoridade independente', papel: 'independente' },
];
const PAPEIS = {
  triagem: 'Analista de Triagem', rh: 'RH', juridico: 'Jurídico', coordenacao: 'Coordenação Administrativa',
  investigador: 'Investigador designado', revisor: 'Revisor independente', independente: 'Autoridade independente',
};
const STATUS = ['recebida', 'em_triagem', 'aguardando_aceite', 'em_apuracao', 'aguardando_validacao', 'concluida', 'arquivada'];
const STATUS_TXT = { recebida: 'Recebida', em_triagem: 'Em triagem', aguardando_aceite: 'Aguardando aceite', em_apuracao: 'Em apuração', aguardando_validacao: 'Aguardando validação', concluida: 'Concluída', arquivada: 'Arquivada' };
// O que o denunciante vê em cada status (somente leitura — decisão 16/10)
const ETAPA_PUBLICA = { recebida: 'Recebida', em_triagem: 'Em triagem', aguardando_aceite: 'Em apuração', em_apuracao: 'Em apuração', aguardando_validacao: 'Em validação', concluida: 'Concluída', arquivada: 'Encerrada' };
const RESULTADOS = { procedente: 'Procedente', parcial: 'Parcialmente procedente', improcedente: 'Improcedente', inconclusivo: 'Inconclusivo' };
const DESFECHOS_OM = { sem_falha: 'Sem falha', orientacao: 'Orientação', melhoria: 'Necessidade de melhoria', disciplinar: 'Encaminhamento disciplinar', outra: 'Outra medida' };
const ATIVOS = ['recebida', 'em_triagem', 'aguardando_aceite', 'em_apuracao', 'aguardando_validacao'];

// ── Utilidades ───────────────────────────────────────────────────────────────
const erro = (msg, status = 400, extra) => Object.assign(new Error(msg), { status, ...(extra || {}) });
const agoraIso = (d = new Date()) => new Date(d).toISOString();
const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L
function aleatorio(n) { const b = crypto.randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += ALFA[b[i] % ALFA.length]; return s; }
function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }
function gravarJson(arq, obj) { mkdirp(path.dirname(arq)); const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, arq); }
function lerJson(arq, padrao) { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; } }
function appendLinha(arq, obj) { mkdirp(path.dirname(arq)); fs.appendFileSync(arq, JSON.stringify(obj) + '\n'); }
function lerLinhas(arq) { try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// cifra opcional da identidade (AES-256-GCM com ETICA_KEY). Sem a chave, grava em claro e avisa uma vez.
let avisouSemChave = false;
function chave() { const k = process.env.ETICA_KEY; if (!k) return null; return crypto.createHash('sha256').update(k).digest(); }
function cifrar(obj) {
  const k = chave();
  if (!k) { if (!avisouSemChave) { avisouSemChave = true; console.warn('[etica] ETICA_KEY ausente: identidade do denunciante gravada em claro'); } return { claro: obj }; }
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), dados: enc.toString('base64') };
}
function decifrar(env) {
  if (!env) return null; if (env.claro) return env.claro;
  const k = chave(); if (!k) return { erro: 'ETICA_KEY ausente: identidade cifrada não pode ser lida' };
  try { const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv, 'base64')); d.setAuthTag(Buffer.from(env.tag, 'base64')); return JSON.parse(Buffer.concat([d.update(Buffer.from(env.dados, 'base64')), d.final()]).toString('utf8')); } catch (e) { return { erro: 'identidade não pôde ser decifrada' }; }
}

// credencial: 12 caracteres (XXXX-XXXX-XXXX), guardada só como scrypt(credencial, salt)
function novaCredencial() { return aleatorio(4) + '-' + aleatorio(4) + '-' + aleatorio(4); }
function hashCredencial(cred, salt) { return crypto.scryptSync(String(cred).toUpperCase().replace(/[^A-Z0-9]/g, ''), salt, 32).toString('hex'); }
const normProt = p => String(p || '').toUpperCase().trim().replace(/\s+/g, '');

// ── Config ───────────────────────────────────────────────────────────────────
let cfgMem = null;
function configPadrao() {
  return { unidades: UNIDADES, categorias: CATEGORIAS, politicas: POLITICAS_PADRAO, cadeia: CADEIA_PADRAO, designados: [],
    calendario: { diasUteis: [1, 2, 3, 4, 5, 6], feriados: [], horaInicio: 8, horaFim: 18 },
    avisos: { marcos: [50, 80] }, omissao: { prazoManifestacaoDu: 2 }, consulta: { tentativas: 5, janelaMin: 60 }, versao: 1, alteracoes: [] };
}
function config() {
  if (cfgMem) return cfgMem;
  const c = lerJson(P.config(), null);
  cfgMem = c ? Object.assign(configPadrao(), c) : configPadrao();
  return cfgMem;
}
function salvarConfig(mudancas, por) {
  const c = config();
  const permitido = ['politicas', 'cadeia', 'designados', 'calendario', 'avisos', 'omissao', 'consulta', 'unidades', 'categorias'];
  const antes = {};
  for (const k of Object.keys(mudancas || {})) {
    if (!permitido.includes(k)) throw erro('Campo de configuração não permitido: ' + k);
    antes[k] = c[k]; c[k] = mudancas[k];
  }
  if (mudancas.politicas) for (const p of PRIORIDADES) { if (!c.politicas[p]) throw erro('Política sem prioridade ' + p); for (const e of ETAPAS_PRAZO) { const v = c.politicas[p][e]; if (!v || (!(v.h > 0) && !(v.du > 0) && !(v.h === 0))) throw erro('Prazo inválido em ' + p + '.' + e); } }
  if (mudancas.cadeia) { if (!Array.isArray(c.cadeia) || c.cadeia.length < 2) throw erro('Cadeia precisa de pelo menos 2 instâncias'); if (c.cadeia[c.cadeia.length - 1].id !== 'independente') throw erro('A última instância da cadeia deve ser a autoridade independente'); }
  c.versao = (c.versao || 1) + 1;
  c.alteracoes = (c.alteracoes || []).concat([{ em: agoraIso(), por: por || null, campos: Object.keys(mudancas || {}) }]).slice(-200);
  gravarJson(P.config(), c); cfgMem = c;
  return c;
}
function unidade(cod) { return config().unidades.find(u => u.cod === String(cod || '').toUpperCase()) || null; }
function categoria(id) { return config().categorias.find(c => c.id === id) || null; }
function instancia(id) { return config().cadeia.find(i => i.id === id) || null; }

// ── Designados e permissões ──────────────────────────────────────────────────
// designados: [{ usuario, nome, papeis: ['triagem','rh',...] }]. Quem não está aqui não passa da entrada,
// mesmo sendo admin do sistema (admin técnico não ganha acesso ao conteúdo por administrar a infra).
function designado(usuario) { return config().designados.find(d => d.usuario === usuario) || null; }
function papeisDe(user) { const d = user && designado(user.usuario); return d ? (d.papeis || []) : []; }
function temPapel(user, ...papeis) { const p = papeisDe(user); return papeis.some(x => p.includes(x)); }
function bootstrapPermitido(user) { return config().designados.length === 0 && user && user.perfil === 'admin'; }
function usuariosComPapel(papel) { return config().designados.filter(d => (d.papeis || []).includes(papel)); }
function impedido(caso, usuario) {
  if (!usuario) return false;
  if ((caso.impedidos || []).includes(usuario)) return true;
  return (caso.envolvidos || []).some(e => e.usuario && e.usuario === usuario);
}
function podeVer(user, caso) {
  if (!user) return false;
  if (impedido(caso, user.usuario)) return false;
  const p = papeisDe(user);
  if (p.includes('triagem') || p.includes('coordenacao') || p.includes('revisor') || p.includes('independente')) return true;
  if (caso.responsavel && caso.responsavel.usuario === user.usuario) return true;
  if ((caso.historicoResponsaveis || []).some(h => h.usuario === user.usuario)) return true;
  const inst = instancia(caso.instancia);
  if (inst && p.includes(inst.papel)) return true;
  return false;
}

// ── Calendário: horas corridas e dias úteis ──────────────────────────────────
function diaUtil(d) {
  const c = config().calendario; const iso = new Date(d).toISOString().slice(0, 10);
  return c.diasUteis.includes(new Date(d).getDay()) && !(c.feriados || []).includes(iso);
}
function somarPrazo(desde, regra) {
  const d = new Date(desde);
  if (regra.h !== undefined) return new Date(d.getTime() + regra.h * 3600000);
  let n = Number(regra.du || 0); const x = new Date(d);
  while (n > 0) { x.setDate(x.getDate() + 1); if (diaUtil(x)) n--; }
  return x;
}
// dias úteis depois de hoje até o dia do vencimento, inclusive (vence hoje = 0)
function diasUteisEntre(a, b) { let n = 0; const x = new Date(a); const fim = new Date(b); if (fim <= x) return 0; x.setHours(0, 0, 0, 0); fim.setHours(0, 0, 0, 0); for (;;) { x.setDate(x.getDate() + 1); if (x > fim) break; if (diaUtil(x)) n++; } return n; }
function textoRegra(r) { return r.h !== undefined ? (r.h === 0 ? 'imediata' : r.h + ' h corridas') : r.du + (r.du === 1 ? ' dia útil' : ' dias úteis'); }

// ── Casos: memória + disco ───────────────────────────────────────────────────
const mem = { casos: null, omissoes: null, tentativas: null };
function carregar() {
  if (mem.casos) return;
  mem.casos = new Map(); mem.omissoes = new Map();
  try { for (const f of fs.readdirSync(P.casos())) if (/^[A-Z0-9-]+\.json$/.test(f) && !f.endsWith('.ident.json')) { const c = lerJson(path.join(P.casos(), f), null); if (c && c.protocolo) mem.casos.set(c.protocolo, c); } } catch (e) { /* pasta ainda não existe */ }
  try { for (const f of fs.readdirSync(P.omissoes())) if (f.endsWith('.json')) { const o = lerJson(path.join(P.omissoes(), f), null); if (o && o.id) mem.omissoes.set(o.id, o); } } catch (e) { /* idem */ }
  mem.tentativas = lerJson(P.tentativas(), {});
}
function recarregar() { mem.casos = null; cfgMem = null; carregar(); }
function obter(prot) { carregar(); const c = mem.casos.get(normProt(prot)); if (!c) throw erro('Protocolo não encontrado', 404); return c; }
function salvar(caso) { caso.atualizadoEm = agoraIso(); gravarJson(P.caso(caso.protocolo), caso); mem.casos.set(caso.protocolo, caso); return caso; }
function todos() { carregar(); return [...mem.casos.values()]; }

// eventos: append-only com hash encadeado
function eventos(prot) { return lerLinhas(P.eventos(prot)); }
function registrarEvento(prot, ev) {
  const lista = eventos(prot); const ant = lista.length ? lista[lista.length - 1].hash : 'GENESIS';
  const linha = { seq: lista.length + 1, em: agoraIso(), tipo: ev.tipo, por: ev.por || null, texto: ev.texto || '', dados: ev.dados || null, publico: !!ev.publico, textoPublico: ev.textoPublico || null, hashAnterior: ant };
  linha.hash = sha(ant + JSON.stringify({ ...linha, hash: undefined }));
  appendLinha(P.eventos(prot), linha);
  return linha;
}
function verificarCadeia(prot) {
  let ant = 'GENESIS'; const lista = eventos(prot);
  for (const l of lista) { const h = sha(ant + JSON.stringify({ ...l, hash: undefined })); if (l.hashAnterior !== ant || l.hash !== h) return { ok: false, seq: l.seq, total: lista.length }; ant = l.hash; }
  return { ok: true, total: lista.length };
}

function auditar(ev) { appendLinha(P.auditoria(agoraIso()), { em: agoraIso(), ...ev }); }
function auditoria(filtro = {}) {
  const mes = filtro.mes || agoraIso().slice(0, 7);
  let l = lerLinhas(P.auditoria(mes + '-01'));
  if (filtro.protocolo) l = l.filter(x => x.protocolo === normProt(filtro.protocolo));
  return l.slice(-500);
}
// notificações internas (painel). Texto SEM conteúdo do relato. Destinatários: usuários ou papel.
function notificar(n) { appendLinha(P.notificacoes(), { id: crypto.randomUUID(), em: agoraIso(), lida: false, ...n }); }
function notificacoes(user, soNaoLidas) {
  const p = papeisDe(user);
  return lerLinhas(P.notificacoes()).filter(n => (n.para || []).includes(user.usuario) || (n.papeis || []).some(x => p.includes(x))).filter(n => !soNaoLidas || !(n.lidasPor || []).includes(user.usuario)).slice(-200).reverse();
}
function marcarLidas(user, ids) {
  const l = lerLinhas(P.notificacoes()); let mudou = false;
  for (const n of l) if (ids.includes(n.id)) { n.lidasPor = n.lidasPor || []; if (!n.lidasPor.includes(user.usuario)) { n.lidasPor.push(user.usuario); mudou = true; } }
  if (mudou) { mkdirp(DIR); fs.writeFileSync(P.notificacoes(), l.map(x => JSON.stringify(x)).join('\n') + '\n'); }
}

// ── Registro (portal público) ────────────────────────────────────────────────
function novoProtocolo() { carregar(); for (let i = 0; i < 50; i++) { const p = 'ETC-' + new Date().getFullYear() + '-' + aleatorio(5); if (!mem.casos.has(p)) return p; } throw erro('Não foi possível gerar protocolo', 500); }
function prioridadeInicial(cat, risco) { if (risco) return 'critica'; const c = categoria(cat); return (c && c.prioridade) || 'media'; }
function prazoNovo(caso, etapa, desde) { const regra = config().politicas[caso.prioridade][etapa]; return { regra, venceEm: agoraIso(somarPrazo(desde || new Date(), regra)), cumpridoEm: null, vencidoEm: null, prorrogadoAte: null, avisos: [] }; }
function registrar(d) {
  carregar();
  const u = unidade(d.unidade || 'NI'); if (!u) throw erro('Unidade inválida');
  const cat = categoria(d.categoria); if (!cat) throw erro('Tipo de ocorrência inválido');
  const descricao = String(d.descricao || '').trim(); if (descricao.length < 20) throw erro('Descreva o que aconteceu com pelo menos 20 caracteres');
  if (descricao.length > 20000) throw erro('Descrição longa demais');
  const protocolo = novoProtocolo(); const credencial = novaCredencial(); const salt = crypto.randomBytes(16).toString('hex');
  const anonimo = !(d.identificar && (d.nome || d.contato));
  const caso = {
    protocolo, criadoEm: agoraIso(), unidade: u.cod, categoria: cat.id, prioridade: prioridadeInicial(cat.id, !!d.risco), risco: !!d.risco, anonimo,
    status: 'recebida', relato: { quando: String(d.quando || '').slice(0, 200), local: String(d.local || '').slice(0, 200), descricao, pessoas: String(d.pessoas || '').slice(0, 2000) },
    anexos: (d.anexos || []).map(a => ({ nome: a.nome, arquivo: a.arquivo, tamanho: a.tamanho, tipo: a.tipo, hash: a.hash || null, por: 'denunciante', em: agoraIso() })),
    envolvidos: [], impedidos: [], instancia: null, responsavel: null, historicoResponsaveis: [], escalonamentos: 0,
    prazos: {}, triagem: null, resultado: null, concluidoEm: null, credencial: { salt, hash: hashCredencial(credencial, salt) },
  };
  caso.prazos.triagem = prazoNovo(caso, 'triagem', caso.criadoEm);
  salvar(caso);
  if (!anonimo) gravarJson(P.ident(protocolo), cifrar({ nome: String(d.nome || '').slice(0, 200), contato: String(d.contato || '').slice(0, 200) }));
  registrarEvento(protocolo, { tipo: 'recebida', por: 'portal', texto: 'Relato recebido pelo portal' + (anonimo ? ' (anônimo)' : ' (identificado)'), publico: true, textoPublico: 'Relato recebido. Protocolo gerado.' });
  if (caso.prioridade === 'critica') notificar({ tipo: 'critica', papeis: ['triagem', 'coordenacao'], protocolo, texto: 'Nova ocorrência CRÍTICA aguardando triagem imediata' });
  else notificar({ tipo: 'nova', papeis: ['triagem'], protocolo, texto: 'Nova ocorrência aguardando triagem (' + PRIORIDADE_TXT[caso.prioridade] + ')' });
  return { protocolo, credencial, prioridade: caso.prioridade, prazoTriagem: textoRegra(caso.prazos.triagem.regra) };
}

// anexos enviados junto com o registro (as rotas movem os arquivos pra anexos/<PROT>/ e chamam aqui)
function anexosDoPortal(prot, anexos) {
  const caso = obter(prot);
  caso.anexos = (caso.anexos || []).concat((anexos || []).map(a => ({ nome: a.nome, arquivo: a.arquivo, tamanho: a.tamanho, tipo: a.tipo, hash: a.hash || null, por: 'denunciante', em: caso.criadoEm, acesso: ['triagem', 'responsavel', 'revisor', 'coordenacao'] })));
  salvar(caso); registrarEvento(prot, { tipo: 'anexos', por: 'portal', texto: anexos.length + ' anexo(s) recebido(s) com o relato' });
  return caso;
}

// consulta pública: só o autorizado (status, etapa, datas, eventos públicos, resultado). 5 erros/hora por protocolo.
function consultar(protocolo, credencial) {
  carregar(); const p = normProt(protocolo); const agora = Date.now(); const c = config().consulta;
  const t = mem.tentativas[p] || { erros: [], bloqueadoAte: 0 };
  if (t.bloqueadoAte > agora) throw erro('Protocolo bloqueado temporariamente por tentativas erradas. Tente de novo em ' + Math.ceil((t.bloqueadoAte - agora) / 60000) + ' min.', 429);
  const caso = mem.casos.get(p);
  const ok = caso && crypto.timingSafeEqual(Buffer.from(caso.credencial.hash, 'hex'), Buffer.from(hashCredencial(credencial, caso.credencial.salt), 'hex'));
  if (!ok) {
    t.erros = t.erros.filter(x => x > agora - c.janelaMin * 60000).concat([agora]);
    if (t.erros.length >= c.tentativas) { t.bloqueadoAte = agora + c.janelaMin * 60000; t.erros = []; }
    mem.tentativas[p] = t; gravarJson(P.tentativas(), mem.tentativas);
    throw erro('Protocolo ou credencial incorretos', 401);
  }
  if (mem.tentativas[p]) { delete mem.tentativas[p]; gravarJson(P.tentativas(), mem.tentativas); }
  return visaoPublica(caso);
}
function visaoPublica(caso) {
  const evs = eventos(caso.protocolo).filter(e => e.publico).map(e => ({ em: e.em, texto: e.textoPublico || e.texto }));
  const prev = caso.status === 'em_apuracao' && caso.prazos.investigacao ? (caso.prazos.investigacao.prorrogadoAte || caso.prazos.investigacao.venceEm) : null;
  return { protocolo: caso.protocolo, criadoEm: caso.criadoEm, unidade: caso.unidade, status: caso.status, etapa: ETAPA_PUBLICA[caso.status], eventos: evs,
    previsao: prev, resultado: caso.resultado ? { tipo: caso.resultado.tipo, texto: RESULTADOS[caso.resultado.tipo], comunicado: caso.resultado.comunicado || null, em: caso.concluidoEm } : null,
    etapas: ['recebida', 'em_triagem', 'em_apuracao', 'aguardando_validacao', 'concluida'].map(s => ({ id: s, txt: ETAPA_PUBLICA[s] })) };
}

// ── Triagem ──────────────────────────────────────────────────────────────────
function verificarDestino(caso, resp) {
  if (!resp || !resp.usuario) return;
  if (impedido(caso, resp.usuario)) throw erro('Encaminhamento bloqueado: esta pessoa está registrada como envolvida ou impedida neste caso', 409, { bloqueio: 'impedido' });
}
function abrirTriagem(prot, user) {
  const caso = obter(prot);
  if (caso.status === 'recebida') { caso.status = 'em_triagem'; salvar(caso); registrarEvento(prot, { tipo: 'em_triagem', por: user.usuario, texto: 'Caso aberto pela triagem', publico: true, textoPublico: 'Em triagem.' }); }
  return caso;
}
function triar(prot, user, d) {
  const caso = obter(prot);
  if (!ATIVOS.slice(0, 2).includes(caso.status)) throw erro('Caso não está em triagem (' + STATUS_TXT[caso.status] + ')', 409);
  const just = String(d.justificativa || '').trim(); if (just.length < 10) throw erro('Justificativa da triagem é obrigatória');
  if (d.prioridade && !PRIORIDADES.includes(d.prioridade)) throw erro('Prioridade inválida');
  if (d.categoria && !categoria(d.categoria)) throw erro('Categoria inválida');
  const envolvidos = (d.envolvidos || []).map(e => ({ nome: String(e.nome || '').slice(0, 120), cargo: String(e.cargo || '').slice(0, 80), unidade: e.unidade || caso.unidade, usuario: e.usuario || null })).filter(e => e.nome || e.usuario);
  if (d.arquivar) {
    caso.status = 'arquivada'; caso.envolvidos = envolvidos; caso.prazos.triagem.cumpridoEm = agoraIso();
    caso.triagem = { por: user.usuario, em: agoraIso(), justificativa: just, arquivado: true, motivo: String(d.motivoArquivo || '').slice(0, 500) };
    caso.resultado = { tipo: 'improcedente', comunicado: String(d.comunicado || 'O relato foi analisado e encerrado na triagem.').slice(0, 1000) }; caso.concluidoEm = agoraIso();
    salvar(caso); registrarEvento(prot, { tipo: 'arquivada', por: user.usuario, texto: 'Arquivado na triagem: ' + caso.triagem.motivo, dados: { justificativa: just }, publico: true, textoPublico: 'Encerrado na triagem. ' + caso.resultado.comunicado });
    return caso;
  }
  const inst = instancia(d.instancia || 'rh'); if (!inst) throw erro('Instância inválida');
  const resp = d.responsavel && d.responsavel.usuario ? { usuario: d.responsavel.usuario, nome: d.responsavel.nome || d.responsavel.usuario } : null;
  if (!resp) throw erro('Informe o responsável designado');
  const dsg = designado(resp.usuario); if (!dsg) throw erro('Responsável não está entre os designados do canal');
  if (!(dsg.papeis || []).includes(inst.papel) && !(dsg.papeis || []).includes('investigador')) throw erro('Responsável não tem o papel da instância ' + inst.nome);
  caso.envolvidos = envolvidos; caso.impedidos = Array.from(new Set((caso.impedidos || []).concat((d.impedidos || []).filter(Boolean))));
  try { verificarDestino(caso, resp); } catch (e) { registrarEvento(prot, { tipo: 'bloqueio', por: user.usuario, texto: 'Tentativa de encaminhar a pessoa impedida bloqueada: ' + resp.usuario }); auditar({ usuario: user.usuario, acao: 'tentativa_bloqueada', protocolo: prot, destino: resp.usuario }); throw e; }
  if (d.prioridade) caso.prioridade = d.prioridade; if (d.categoria) caso.categoria = d.categoria;
  caso.prazos.triagem.cumpridoEm = agoraIso();
  caso.triagem = { por: user.usuario, em: agoraIso(), justificativa: just, medidaProtetiva: String(d.medidaProtetiva || '').slice(0, 500), conflitoVerificado: true };
  designar(caso, inst, resp, user, 'triagem');
  salvar(caso);
  registrarEvento(prot, { tipo: 'triada', por: user.usuario, texto: 'Triagem: ' + PRIORIDADE_TXT[caso.prioridade] + ' · ' + (categoria(caso.categoria) || {}).nome + ' → ' + inst.nome + ' (' + resp.nome + ')', dados: { justificativa: just, envolvidos: envolvidos.map(e => e.nome || e.usuario), medidaProtetiva: caso.triagem.medidaProtetiva }, publico: true, textoPublico: 'Triagem concluída: relato considerado pertinente e encaminhado para apuração. Prazo previsto: ' + textoRegra(config().politicas[caso.prioridade].investigacao) + '.' });
  notificar({ tipo: 'atribuida', para: [resp.usuario], protocolo: prot, texto: 'Caso atribuído a você · aceite em ' + textoRegra(caso.prazos.aceite.regra) });
  if (caso.prioridade === 'critica') notificar({ tipo: 'critica', papeis: ['coordenacao'], protocolo: prot, texto: 'Caso crítico encaminhado a ' + inst.nome + ' — medidas de proteção imediatas' });
  return caso;
}
// coloca o caso numa instância com um responsável; recalcula aceite/1ª providência/investigação a partir de agora
function designar(caso, inst, resp, user, motivo) {
  const agora = new Date();
  if (caso.responsavel) caso.historicoResponsaveis.push({ ...caso.responsavel, instancia: caso.instancia, de: caso.responsavel.desde, ate: agoraIso(agora), motivo });
  caso.instancia = inst.id; caso.responsavel = { usuario: resp.usuario, nome: resp.nome, desde: agoraIso(agora), por: user ? user.usuario : 'sistema' };
  caso.status = 'aguardando_aceite';
  caso.prazos.aceite = prazoNovo(caso, 'aceite', agora);
  caso.prazos.providencia = prazoNovo(caso, 'providencia', agora);
  if (!caso.prazos.investigacao || motivo === 'triagem') caso.prazos.investigacao = prazoNovo(caso, 'investigacao', agora);
}

// ── Apuração ─────────────────────────────────────────────────────────────────
function exigeResponsavel(caso, user) { if (!caso.responsavel || caso.responsavel.usuario !== user.usuario) throw erro('Só o responsável designado pode fazer isto', 403); }
function aceitar(prot, user) {
  const caso = obter(prot); exigeResponsavel(caso, user);
  if (caso.status !== 'aguardando_aceite') throw erro('Caso não está aguardando aceite', 409);
  caso.status = 'em_apuracao'; caso.prazos.aceite.cumpridoEm = agoraIso(); salvar(caso);
  registrarEvento(prot, { tipo: 'aceite', por: user.usuario, texto: 'Caso aceito pelo responsável', publico: true, textoPublico: 'Responsável designado. Apuração iniciada pela instância competente.' });
  return caso;
}
function declararImpedimento(prot, user, motivo) {
  const caso = obter(prot); exigeResponsavel(caso, user);
  motivo = String(motivo || '').trim(); if (motivo.length < 5) throw erro('Informe o motivo do impedimento');
  caso.impedidos = Array.from(new Set((caso.impedidos || []).concat([user.usuario])));
  caso.historicoResponsaveis.push({ ...caso.responsavel, instancia: caso.instancia, ate: agoraIso(), motivo: 'impedimento' });
  caso.responsavel = null; caso.status = 'aguardando_aceite'; caso.redistribuir = { motivo: 'impedimento', desde: agoraIso() };
  salvar(caso); registrarEvento(prot, { tipo: 'impedimento', por: user.usuario, texto: 'Impedimento declarado: ' + motivo });
  notificar({ tipo: 'redistribuir', papeis: ['triagem', 'coordenacao'], protocolo: prot, texto: 'Responsável declarou impedimento — redistribuir o caso' });
  return caso;
}
function solicitarRedistribuicao(prot, user, motivo) {
  const caso = obter(prot); exigeResponsavel(caso, user);
  motivo = String(motivo || '').trim(); if (motivo.length < 5) throw erro('Informe o motivo');
  caso.redistribuir = { motivo: 'solicitacao', texto: motivo, desde: agoraIso() }; salvar(caso);
  registrarEvento(prot, { tipo: 'redistribuicao_pedida', por: user.usuario, texto: 'Redistribuição solicitada: ' + motivo });
  notificar({ tipo: 'redistribuir', papeis: ['triagem', 'coordenacao'], protocolo: prot, texto: 'Responsável pediu redistribuição do caso' });
  return caso;
}
function redistribuir(prot, user, d) {
  const caso = obter(prot);
  if (!ATIVOS.includes(caso.status) || caso.status === 'aguardando_validacao') throw erro('Caso não pode ser redistribuído neste status', 409);
  const inst = instancia(d.instancia || caso.instancia || 'rh'); if (!inst) throw erro('Instância inválida');
  const resp = d.responsavel && d.responsavel.usuario ? { usuario: d.responsavel.usuario, nome: d.responsavel.nome || d.responsavel.usuario } : null; if (!resp) throw erro('Informe o responsável');
  if (!designado(resp.usuario)) throw erro('Responsável não está entre os designados do canal');
  try { verificarDestino(caso, resp); } catch (e) { registrarEvento(prot, { tipo: 'bloqueio', por: user.usuario, texto: 'Tentativa de redistribuir a pessoa impedida bloqueada: ' + resp.usuario }); throw e; }
  const motivo = String(d.motivo || '').trim(); if (motivo.length < 5) throw erro('Informe o motivo da redistribuição');
  designar(caso, inst, resp, user, 'redistribuicao'); delete caso.redistribuir; salvar(caso);
  registrarEvento(prot, { tipo: 'redistribuida', por: user.usuario, texto: 'Redistribuído para ' + inst.nome + ' (' + resp.nome + '): ' + motivo });
  notificar({ tipo: 'atribuida', para: [resp.usuario], protocolo: prot, texto: 'Caso atribuído a você · aceite em ' + textoRegra(caso.prazos.aceite.regra) });
  return caso;
}
function providencia(prot, user, d) {
  const caso = obter(prot); exigeResponsavel(caso, user);
  if (caso.status !== 'em_apuracao') throw erro('Caso não está em apuração', 409);
  const desc = String(d.descricao || '').trim(); if (desc.length < 5) throw erro('Descreva a providência');
  if (!caso.prazos.providencia.cumpridoEm) caso.prazos.providencia.cumpridoEm = agoraIso();
  salvar(caso);
  const avancar = d.visibilidade === 'etapa';
  registrarEvento(prot, { tipo: 'providencia', por: user.usuario, texto: '[' + String(d.tipo || 'providência') + '] ' + desc, publico: avancar, textoPublico: avancar ? 'Apuração em andamento: nova providência registrada.' : null });
  return caso;
}
function evidencia(prot, user, d) {
  const caso = obter(prot);
  if (!(caso.responsavel && caso.responsavel.usuario === user.usuario) && !temPapel(user, 'revisor', 'coordenacao')) throw erro('Sem permissão para anexar neste caso', 403);
  const a = { nome: d.nome, arquivo: d.arquivo || null, tamanho: d.tamanho || null, tipo: d.tipo || null, hash: d.hash || null, descricao: String(d.descricao || '').slice(0, 500), por: user.usuario, em: agoraIso(), acesso: d.acesso || ['responsavel', 'revisor', 'coordenacao'] };
  caso.anexos.push(a); salvar(caso);
  registrarEvento(prot, { tipo: 'evidencia', por: user.usuario, texto: 'Evidência registrada: ' + (a.nome || a.descricao) + (a.hash ? ' · sha256 ' + a.hash.slice(0, 12) : '') });
  return caso;
}
function solicitarProrrogacao(prot, user, d) {
  const caso = obter(prot); exigeResponsavel(caso, user);
  const etapa = d.etapa || 'investigacao'; if (!['providencia', 'investigacao'].includes(etapa)) throw erro('Etapa inválida');
  const ate = new Date(d.ate); if (isNaN(ate) || ate <= new Date()) throw erro('Nova data inválida');
  const motivo = String(d.motivo || '').trim(); if (motivo.length < 10) throw erro('Fundamente a prorrogação');
  caso.prorrogacao = { etapa, ate: agoraIso(ate), motivo, por: user.usuario, em: agoraIso(), situacao: 'pendente' }; salvar(caso);
  registrarEvento(prot, { tipo: 'prorrogacao_pedida', por: user.usuario, texto: 'Prorrogação de ' + ETAPA_TXT[etapa] + ' até ' + agoraIso(ate).slice(0, 10) + ': ' + motivo });
  notificar({ tipo: 'prorrogacao', papeis: ['coordenacao', 'revisor'], protocolo: prot, texto: 'Pedido de prorrogação aguardando decisão' });
  return caso;
}
function decidirProrrogacao(prot, user, aprovar, texto) {
  const caso = obter(prot); if (!temPapel(user, 'coordenacao', 'revisor')) throw erro('Só Coordenação ou Revisor decidem prorrogação', 403);
  if (impedido(caso, user.usuario)) throw erro('Você está impedido neste caso', 403);
  const p = caso.prorrogacao; if (!p || p.situacao !== 'pendente') throw erro('Não há prorrogação pendente', 409);
  if (p.por === user.usuario) throw erro('Quem pediu não pode aprovar', 403);
  p.situacao = aprovar ? 'aprovada' : 'negada'; p.decididoPor = user.usuario; p.decididoEm = agoraIso(); p.decisao = String(texto || '').slice(0, 500);
  if (aprovar) { const pr = caso.prazos[p.etapa]; pr.prorrogadoAte = p.ate; pr.venceEm = p.ate; pr.vencidoEm = null; pr.avisos = []; }
  salvar(caso);
  registrarEvento(prot, { tipo: aprovar ? 'prorrogacao_aprovada' : 'prorrogacao_negada', por: user.usuario, texto: (aprovar ? 'Prorrogação aprovada até ' + p.ate.slice(0, 10) : 'Prorrogação negada') + (p.decisao ? ': ' + p.decisao : ''), publico: aprovar, textoPublico: aprovar ? 'Prazo da apuração prorrogado com fundamento. Nova previsão: ' + p.ate.slice(0, 10) + '.' : null });
  notificar({ tipo: 'prorrogacao', para: [p.por], protocolo: prot, texto: 'Prorrogação ' + p.situacao });
  return caso;
}
function enviarValidacao(prot, user, d) {
  const caso = obter(prot); exigeResponsavel(caso, user);
  if (caso.status !== 'em_apuracao') throw erro('Caso não está em apuração', 409);
  const conclusao = String(d.conclusao || '').trim(); if (conclusao.length < 20) throw erro('Escreva a conclusão fundamentada');
  if (!RESULTADOS[d.resultado]) throw erro('Resultado proposto inválido');
  caso.status = 'aguardando_validacao'; caso.prazos.investigacao.cumpridoEm = agoraIso(); caso.prazos.validacao = prazoNovo(caso, 'validacao');
  caso.conclusao = { por: user.usuario, em: agoraIso(), texto: conclusao, resultadoProposto: d.resultado, recomendacoes: String(d.recomendacoes || '').slice(0, 2000) };
  salvar(caso);
  registrarEvento(prot, { tipo: 'validacao_enviada', por: user.usuario, texto: 'Enviado para validação com resultado proposto: ' + RESULTADOS[d.resultado], dados: { conclusao }, publico: true, textoPublico: 'Apuração concluída pela instância responsável. Em validação independente.' });
  notificar({ tipo: 'validar', papeis: ['revisor'], protocolo: prot, texto: 'Caso aguardando validação · ' + textoRegra(caso.prazos.validacao.regra) });
  return caso;
}
function validar(prot, user, d) {
  const caso = obter(prot);
  if (!temPapel(user, 'revisor')) throw erro('Só o Revisor independente valida a conclusão', 403);
  if (impedido(caso, user.usuario)) throw erro('Você está impedido neste caso', 403);
  if (caso.conclusao && caso.conclusao.por === user.usuario) throw erro('O revisor precisa ser pessoa diferente de quem investigou', 403);
  if (caso.status !== 'aguardando_validacao') throw erro('Caso não está aguardando validação', 409);
  const texto = String(d.texto || '').trim(); if (texto.length < 10) throw erro('Fundamente a decisão');
  if (!d.aprovado) {
    caso.status = 'em_apuracao'; caso.prazos.validacao.cumpridoEm = agoraIso(); caso.prazos.investigacao.cumpridoEm = null;
    caso.prazos.investigacao.venceEm = agoraIso(somarPrazo(new Date(), { du: Number(d.diasUteisExtra || 5) })); caso.prazos.investigacao.vencidoEm = null; caso.prazos.investigacao.avisos = [];
    salvar(caso); registrarEvento(prot, { tipo: 'validacao_devolvida', por: user.usuario, texto: 'Devolvido pelo revisor: ' + texto, publico: true, textoPublico: 'Apuração complementar solicitada pela validação.' });
    notificar({ tipo: 'devolvido', para: [caso.responsavel.usuario], protocolo: prot, texto: 'Validação devolveu o caso para complementação' });
    return caso;
  }
  if (!RESULTADOS[d.resultado]) throw erro('Resultado inválido');
  caso.status = 'concluida'; caso.prazos.validacao.cumpridoEm = agoraIso(); caso.concluidoEm = agoraIso();
  caso.resultado = { tipo: d.resultado, comunicado: String(d.comunicado || 'A apuração foi concluída e as medidas cabíveis foram adotadas.').slice(0, 1000), validadoPor: user.usuario, texto };
  caso.prazos.comunicacao = prazoNovo(caso, 'comunicacao'); caso.prazos.comunicacao.cumpridoEm = agoraIso(); // o portal mostra na hora
  salvar(caso);
  registrarEvento(prot, { tipo: 'concluida', por: user.usuario, texto: 'Validado: ' + RESULTADOS[d.resultado] + ' — ' + texto, publico: true, textoPublico: 'Concluída. Resultado: ' + RESULTADOS[d.resultado] + '. ' + caso.resultado.comunicado });
  notificar({ tipo: 'concluida', para: [caso.responsavel.usuario], papeis: ['coordenacao'], protocolo: prot, texto: 'Apuração concluída e validada' });
  return caso;
}
function reabrir(prot, user, motivo) {
  const caso = obter(prot); if (!temPapel(user, 'coordenacao', 'revisor')) throw erro('Só Coordenação ou Revisor reabrem', 403);
  if (!['concluida', 'arquivada'].includes(caso.status)) throw erro('Caso não está encerrado', 409);
  motivo = String(motivo || '').trim(); if (motivo.length < 10) throw erro('Fundamente a reabertura');
  caso.status = caso.responsavel ? 'em_apuracao' : 'em_triagem'; caso.resultado = null; caso.concluidoEm = null; caso.reaberta = { por: user.usuario, em: agoraIso(), motivo };
  if (caso.responsavel) { caso.prazos.investigacao = prazoNovo(caso, 'investigacao'); } else { caso.prazos.triagem = prazoNovo(caso, 'triagem'); }
  salvar(caso); registrarEvento(prot, { tipo: 'reaberta', por: user.usuario, texto: 'Reaberto: ' + motivo, publico: true, textoPublico: 'Caso reaberto para nova análise.' });
  return caso;
}

// ── Prazos, escalonamento e omissões (tick do servidor) ──────────────────────
function etapaPendente(caso) {
  if (caso.status === 'recebida' || caso.status === 'em_triagem') return 'triagem';
  if (caso.status === 'aguardando_aceite') return 'aceite';
  if (caso.status === 'em_apuracao') return caso.prazos.providencia && !caso.prazos.providencia.cumpridoEm ? 'providencia' : 'investigacao';
  if (caso.status === 'aguardando_validacao') return 'validacao';
  return null;
}
function proximaInstancia(caso) {
  const cadeia = config().cadeia; const idx = cadeia.findIndex(i => i.id === caso.instancia);
  for (let i = idx + 1; i < cadeia.length; i++) return cadeia[i]; // nunca volta: só anda pra frente
  return null;
}
function substitutoEm(caso, inst) {
  const lista = usuariosComPapel(inst.papel).filter(d => !impedido(caso, d.usuario) && !(caso.responsavel && caso.responsavel.usuario === d.usuario));
  return lista[0] ? { usuario: lista[0].usuario, nome: lista[0].nome || lista[0].usuario } : null;
}
function novaOmissao(caso, etapa, resp, agora) {
  carregar(); const ano = new Date(agora).getFullYear();
  const n = [...mem.omissoes.keys()].filter(k => k.startsWith('OM-' + ano + '-')).length + 1;
  const id = 'OM-' + ano + '-' + String(n).padStart(3, '0');
  const om = { id, protocolo: caso.protocolo, etapa, instancia: caso.instancia, responsavel: resp ? { usuario: resp.usuario, nome: resp.nome } : null, prazo: { venceEm: caso.prazos[etapa].venceEm, regra: caso.prazos[etapa].regra }, avisos: caso.prazos[etapa].avisos || [],
    abertaEm: agoraIso(agora), status: 'aguardando_manifestacao', prazoManifestacao: agoraIso(somarPrazo(agora, { du: config().omissao.prazoManifestacaoDu })), manifestacao: null, decisao: null, unidade: caso.unidade, prioridade: caso.prioridade };
  gravarJson(P.omissao(id), om); mem.omissoes.set(id, om);
  if (resp) notificar({ tipo: 'omissao', para: [resp.usuario], protocolo: caso.protocolo, omissao: id, texto: 'Avaliação administrativa ' + id + ' aberta sobre prazo de ' + ETAPA_TXT[etapa] + ' — você pode se manifestar em ' + config().omissao.prazoManifestacaoDu + ' dias úteis' });
  notificar({ tipo: 'omissao', papeis: ['revisor', 'coordenacao'], protocolo: caso.protocolo, omissao: id, texto: 'Avaliação de omissão ' + id + ' aberta (' + ETAPA_TXT[etapa] + ')' });
  return om;
}
function escalonar(caso, etapa, agora) {
  const prot = caso.protocolo; const pr = caso.prazos[etapa];
  pr.vencidoEm = agoraIso(agora); caso.escalonamentos = (caso.escalonamentos || 0) + 1;
  const anterior = caso.responsavel ? { ...caso.responsavel } : null;
  // 1. vencimento registrado · 2. histórico do responsável anterior preservado (designar() empilha)
  registrarEvento(prot, { tipo: 'prazo_vencido', por: 'sistema', texto: 'Prazo de ' + ETAPA_TXT[etapa] + ' vencido em ' + pr.venceEm + (anterior ? ' (responsável: ' + anterior.nome + ')' : ''), dados: { etapa, venceEm: pr.venceEm, avisos: pr.avisos } });
  if (etapa === 'triagem') {
    // sem instância pra mover: avisa a coordenação e abre a avaliação sobre a triagem
    notificar({ tipo: 'vencido', papeis: ['coordenacao', 'triagem'], protocolo: prot, texto: 'Prazo de triagem vencido — caso sem triagem' });
    const resp = usuariosComPapel('triagem')[0] || null;
    novaOmissao(caso, etapa, resp ? { usuario: resp.usuario, nome: resp.nome || resp.usuario } : null, agora);
    salvar(caso); return;
  }
  if (etapa === 'validacao') {
    notificar({ tipo: 'vencido', papeis: ['coordenacao', 'revisor'], protocolo: prot, texto: 'Prazo de validação vencido' });
    const resp = usuariosComPapel('revisor')[0] || null;
    novaOmissao(caso, etapa, resp ? { usuario: resp.usuario, nome: resp.nome || resp.usuario } : null, agora);
    salvar(caso); return;
  }
  // 3. notifica a instância supervisora · 4. encaminha ao substituto por competência · 5. registra a transferência
  const prox = proximaInstancia(caso);
  if (prox) {
    const sub = substitutoEm(caso, prox);
    notificar({ tipo: 'escalonado', papeis: [prox.papel, 'coordenacao'], protocolo: prot, texto: 'Caso escalonado para ' + prox.nome + ' por prazo de ' + ETAPA_TXT[etapa] + ' vencido' });
    if (sub) {
      designar(caso, prox, sub, null, 'escalonamento');
      registrarEvento(prot, { tipo: 'escalonada', por: 'sistema', texto: 'Escalonado para ' + prox.nome + ' (' + sub.nome + ') — motivo: prazo de ' + ETAPA_TXT[etapa] + ' vencido', dados: { de: anterior, para: sub, instancia: prox.id }, publico: true, textoPublico: 'Caso encaminhado a outra instância por controle de prazo.' });
      notificar({ tipo: 'atribuida', para: [sub.usuario], protocolo: prot, texto: 'Caso atribuído a você por escalonamento · aceite em ' + textoRegra(caso.prazos.aceite.regra) });
    } else {
      if (caso.responsavel) caso.historicoResponsaveis.push({ ...caso.responsavel, instancia: caso.instancia, ate: agoraIso(agora), motivo: 'escalonamento' });
      caso.instancia = prox.id; caso.responsavel = null; caso.status = 'aguardando_aceite'; caso.redistribuir = { motivo: 'escalonamento_sem_substituto', desde: agoraIso(agora) };
      registrarEvento(prot, { tipo: 'escalonada', por: 'sistema', texto: 'Escalonado para ' + prox.nome + ' sem responsável disponível (sem conflito) — designar manualmente', dados: { de: anterior, instancia: prox.id } });
      notificar({ tipo: 'redistribuir', papeis: ['coordenacao'], protocolo: prot, texto: 'Escalonado para ' + prox.nome + ' sem substituto cadastrado — designar' });
    }
  } else {
    // última instância (autoridade independente) também venceu: não circula; avisa e registra
    registrarEvento(prot, { tipo: 'escalonamento_esgotado', por: 'sistema', texto: 'Prazo vencido na última instância da cadeia — sem novo encaminhamento automático' });
    notificar({ tipo: 'vencido', papeis: ['independente', 'coordenacao', 'revisor'], protocolo: prot, texto: 'Prazo vencido na autoridade independente — decisão manual necessária' });
  }
  // 6. avaliação administrativa separada · 7. responsável anterior pode se manifestar
  novaOmissao(caso, etapa, anterior, agora);
  salvar(caso);
}
function tick(agora = new Date()) {
  carregar(); const marcos = config().avisos.marcos || []; const r = { avisos: 0, vencidos: 0 };
  for (const caso of mem.casos.values()) {
    if (!ATIVOS.includes(caso.status)) continue;
    const etapa = etapaPendente(caso); const pr = etapa && caso.prazos[etapa]; if (!pr || pr.cumpridoEm || pr.vencidoEm) continue;
    const ini = new Date(etapa === 'triagem' ? caso.criadoEm : (caso.responsavel && caso.responsavel.desde) || caso.criadoEm).getTime();
    const fim = new Date(pr.venceEm).getTime(); const t = agora.getTime();
    if (t >= fim) { escalonar(caso, etapa, agora); r.vencidos++; continue; }
    const pct = fim > ini ? ((t - ini) / (fim - ini)) * 100 : 0; let mudou = false;
    for (const m of marcos) if (pct >= m && !(pr.avisos || []).includes(m)) {
      pr.avisos = (pr.avisos || []).concat([m]); mudou = true; r.avisos++;
      const para = caso.responsavel ? [caso.responsavel.usuario] : []; const papeis = etapa === 'triagem' ? ['triagem'] : etapa === 'validacao' ? ['revisor'] : (m >= 80 ? ['coordenacao'] : []);
      notificar({ tipo: 'aviso_prazo', para, papeis, protocolo: caso.protocolo, texto: ETAPA_TXT[etapa] + ': ' + m + '% do prazo consumido · vence ' + pr.venceEm.slice(0, 16).replace('T', ' ') });
    }
    if (mudou) salvar(caso);
  }
  return r;
}

// ── Omissões: manifestação e decisão ─────────────────────────────────────────
function omissoes(filtro = {}) { carregar(); let l = [...mem.omissoes.values()]; if (filtro.status) l = l.filter(o => o.status === filtro.status); if (filtro.usuario) l = l.filter(o => o.responsavel && o.responsavel.usuario === filtro.usuario); return l.sort((a, b) => b.abertaEm.localeCompare(a.abertaEm)); }
function omissao(id) { carregar(); const o = mem.omissoes.get(String(id || '').toUpperCase()); if (!o) throw erro('Avaliação não encontrada', 404); return o; }
function salvarOmissao(o) { o.atualizadoEm = agoraIso(); gravarJson(P.omissao(o.id), o); mem.omissoes.set(o.id, o); return o; }
function manifestar(id, user, texto) {
  const o = omissao(id); if (!o.responsavel || o.responsavel.usuario !== user.usuario) throw erro('Só o responsável avaliado se manifesta', 403);
  if (o.status !== 'aguardando_manifestacao') throw erro('Avaliação não está aguardando manifestação', 409);
  texto = String(texto || '').trim(); if (texto.length < 10) throw erro('Escreva a justificativa');
  o.manifestacao = { em: agoraIso(), texto }; o.status = 'em_analise'; salvarOmissao(o);
  registrarEvento(o.protocolo, { tipo: 'om_manifestacao', por: user.usuario, texto: 'Manifestação apresentada em ' + o.id });
  notificar({ tipo: 'omissao', papeis: ['revisor', 'coordenacao'], protocolo: o.protocolo, omissao: o.id, texto: o.id + ': justificativa apresentada, aguardando decisão' });
  return o;
}
function decidirOmissao(id, user, d) {
  const o = omissao(id); if (!temPapel(user, 'coordenacao', 'revisor')) throw erro('Só Coordenação ou Revisor decidem', 403);
  if (o.responsavel && o.responsavel.usuario === user.usuario) throw erro('O avaliado não decide a própria avaliação', 403);
  const caso = obter(o.protocolo); if (impedido(caso, user.usuario)) throw erro('Você está impedido no caso de origem', 403);
  if (!DESFECHOS_OM[d.desfecho]) throw erro('Desfecho inválido');
  const texto = String(d.texto || '').trim(); if (texto.length < 10) throw erro('Fundamente a decisão');
  if (o.status === 'aguardando_manifestacao' && new Date(o.prazoManifestacao) > new Date() && !d.semEsperar) throw erro('Aguarde o prazo de manifestação (' + o.prazoManifestacao.slice(0, 10) + ') ou marque "decidir sem esperar"', 409);
  o.decisao = { em: agoraIso(), por: user.usuario, desfecho: d.desfecho, medida: String(d.medida || '').slice(0, 500), texto }; o.status = 'decidida'; salvarOmissao(o);
  registrarEvento(o.protocolo, { tipo: 'om_decisao', por: user.usuario, texto: o.id + ' decidida: ' + DESFECHOS_OM[d.desfecho] + (o.decisao.medida ? ' · ' + o.decisao.medida : '') });
  if (o.responsavel) notificar({ tipo: 'omissao', para: [o.responsavel.usuario], protocolo: o.protocolo, omissao: o.id, texto: o.id + ' decidida: ' + DESFECHOS_OM[d.desfecho] });
  return o;
}

// ── Leitura pela retaguarda ──────────────────────────────────────────────────
function resumo(caso, agora = new Date()) {
  const etapa = etapaPendente(caso); const pr = etapa && caso.prazos[etapa];
  let prazo = null;
  if (pr && !pr.cumpridoEm) { const ms = new Date(pr.venceEm) - agora; prazo = { etapa, etapaTxt: ETAPA_TXT[etapa], venceEm: pr.venceEm, vencido: !!pr.vencidoEm || ms <= 0, horas: Math.round(ms / 36e5), diasUteis: ms > 0 ? diasUteisEntre(agora, pr.venceEm) : 0, prorrogado: !!pr.prorrogadoAte }; }
  return { protocolo: caso.protocolo, criadoEm: caso.criadoEm, unidade: caso.unidade, unidadeTxt: (unidade(caso.unidade) || {}).nome, categoria: caso.categoria, categoriaTxt: (categoria(caso.categoria) || {}).nome,
    prioridade: caso.prioridade, prioridadeTxt: PRIORIDADE_TXT[caso.prioridade], status: caso.status, statusTxt: STATUS_TXT[caso.status], risco: caso.risco, anonimo: caso.anonimo,
    instancia: caso.instancia, instanciaTxt: (instancia(caso.instancia) || {}).nome || null, responsavel: caso.responsavel ? { usuario: caso.responsavel.usuario, nome: caso.responsavel.nome } : null,
    prazo, escalonamentos: caso.escalonamentos || 0, redistribuir: caso.redistribuir || null, prorrogacaoPendente: !!(caso.prorrogacao && caso.prorrogacao.situacao === 'pendente'), resultado: caso.resultado ? caso.resultado.tipo : null, concluidoEm: caso.concluidoEm, anexos: (caso.anexos || []).length };
}
function fila(user, tipo) {
  carregar(); const agora = new Date(); const p = papeisDe(user);
  let l = todos().filter(c => podeVer(user, c));
  if (tipo === 'triagem') l = l.filter(c => ['recebida', 'em_triagem'].includes(c.status) && p.includes('triagem'));
  else if (tipo === 'meus') l = l.filter(c => c.responsavel && c.responsavel.usuario === user.usuario && ATIVOS.includes(c.status));
  else if (tipo === 'validar') l = l.filter(c => c.status === 'aguardando_validacao' && p.includes('revisor'));
  else if (tipo === 'ativos') l = l.filter(c => ATIVOS.includes(c.status));
  else if (tipo === 'redistribuir') l = l.filter(c => c.redistribuir && (p.includes('triagem') || p.includes('coordenacao')));
  const ordem = { critica: 0, alta: 1, media: 2, baixa: 3 };
  return l.map(c => resumo(c, agora)).sort((a, b) => (ordem[a.prioridade] - ordem[b.prioridade]) || ((a.prazo ? a.prazo.venceEm : 'z').localeCompare(b.prazo ? b.prazo.venceEm : 'z')));
}
function detalhe(prot, user) {
  const caso = obter(prot);
  if (!podeVer(user, caso)) { auditar({ usuario: user.usuario, acao: 'acesso_negado', protocolo: caso.protocolo }); throw erro('Sem permissão para este caso', 403); }
  auditar({ usuario: user.usuario, acao: 'leitura', protocolo: caso.protocolo });
  const p = papeisDe(user); const podeIdent = !caso.anonimo && (p.includes('triagem') || p.includes('coordenacao') || (caso.responsavel && caso.responsavel.usuario === user.usuario));
  const { credencial, ...semCred } = caso;
  return { ...semCred, resumo: resumo(caso), identificacao: podeIdent ? decifrar(lerJson(P.ident(prot), null)) : (caso.anonimo ? null : { restrito: true }),
    eventos: eventos(prot), cadeia: verificarCadeia(prot), omissoes: omissoes().filter(o => o.protocolo === caso.protocolo), prazosTxt: Object.fromEntries(Object.entries(caso.prazos).map(([k, v]) => [k, { ...v, etapaTxt: ETAPA_TXT[k], regraTxt: textoRegra(v.regra) }])),
    acoes: acoesDe(caso, user) };
}
function acoesDe(caso, user) {
  const p = papeisDe(user); const resp = caso.responsavel && caso.responsavel.usuario === user.usuario; const a = [];
  if (['recebida', 'em_triagem'].includes(caso.status) && p.includes('triagem')) a.push('triar');
  if (caso.status === 'aguardando_aceite' && resp) a.push('aceitar', 'impedimento');
  if (caso.status === 'em_apuracao' && resp) a.push('providencia', 'evidencia', 'prorrogar', 'validacao', 'impedimento', 'redistribuicao');
  if (ATIVOS.includes(caso.status) && caso.status !== 'aguardando_validacao' && (p.includes('triagem') || p.includes('coordenacao')) && caso.status !== 'recebida' && caso.status !== 'em_triagem') a.push('redistribuir');
  if (caso.status === 'aguardando_validacao' && p.includes('revisor') && !(caso.conclusao && caso.conclusao.por === user.usuario)) a.push('validar');
  if (caso.prorrogacao && caso.prorrogacao.situacao === 'pendente' && (p.includes('coordenacao') || p.includes('revisor')) && caso.prorrogacao.por !== user.usuario) a.push('decidir_prorrogacao');
  if (['concluida', 'arquivada'].includes(caso.status) && (p.includes('coordenacao') || p.includes('revisor'))) a.push('reabrir');
  return a;
}
// painel: só números; unidade com menos de 3 casos vira "<3" pra quem não é coordenação/revisor
function painel(filtro = {}, user) {
  carregar(); const agora = new Date(); const de = filtro.de ? new Date(filtro.de) : new Date(agora.getTime() - 90 * 86400000); const ate = filtro.ate ? new Date(filtro.ate + 'T23:59:59') : agora;
  let l = todos().filter(c => { const d = new Date(c.criadoEm); return d >= de && d <= ate; });
  if (filtro.unidade) l = l.filter(c => c.unidade === filtro.unidade); if (filtro.categoria) l = l.filter(c => c.categoria === filtro.categoria);
  if (filtro.prioridade) l = l.filter(c => c.prioridade === filtro.prioridade); if (filtro.status) l = l.filter(c => c.status === filtro.status);
  const ativos = l.filter(c => ATIVOS.includes(c.status)); const res = ativos.map(c => resumo(c, agora));
  const media = (arr) => arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length * 10) / 10 : null;
  const triagemH = l.filter(c => c.prazos.triagem && c.prazos.triagem.cumpridoEm).map(c => (new Date(c.prazos.triagem.cumpridoEm) - new Date(c.criadoEm)) / 36e5);
  const investDu = l.filter(c => c.concluidoEm && c.triagem && !c.triagem.arquivado).map(c => diasUteisEntre(c.triagem.em, c.concluidoEm));
  const porUnid = {}; for (const u of config().unidades) porUnid[u.cod] = { cod: u.cod, nome: u.nome, recebidas: 0, ativos: 0, vencidos: 0 };
  for (const c of l) { const r = porUnid[c.unidade] || (porUnid[c.unidade] = { cod: c.unidade, nome: c.unidade, recebidas: 0, ativos: 0, vencidos: 0 }); r.recebidas++; if (ATIVOS.includes(c.status)) r.ativos++; }
  for (const r of res) if (r.prazo && r.prazo.vencido) porUnid[r.unidade].vencidos++;
  const porCat = {}; for (const c of l) { const n = (categoria(c.categoria) || {}).nome || c.categoria; porCat[n] = (porCat[n] || 0) + 1; }
  const mascara = !temPapel(user, 'coordenacao', 'revisor'); const m = n => (mascara && n > 0 && n < 3) ? '<3' : n;
  const oms = omissoes().filter(o => new Date(o.abertaEm) >= de);
  return { periodo: { de: agoraIso(de).slice(0, 10), ate: agoraIso(ate).slice(0, 10) },
    kpis: { recebidas: l.length, anonimas: l.filter(c => c.anonimo).length, emApuracao: ativos.length, criticasAtivas: ativos.filter(c => c.prioridade === 'critica').length, concluidas: l.filter(c => c.status === 'concluida').length, procedentes: l.filter(c => c.resultado && ['procedente', 'parcial'].includes(c.resultado.tipo)).length,
      vencem72h: res.filter(r => r.prazo && !r.prazo.vencido && r.prazo.horas <= 72).length, vencidos: res.filter(r => r.prazo && r.prazo.vencido).length, escalonamentos: l.reduce((s, c) => s + (c.escalonamentos || 0), 0),
      omissoesAbertas: oms.filter(o => o.status !== 'decidida').length, omissoes: oms.length, triagemMediaH: media(triagemH), investigacaoMediaDu: media(investDu) },
    porUnidade: Object.values(porUnid).map(r => ({ ...r, recebidas: m(r.recebidas), ativos: m(r.ativos) })), porCategoria: Object.entries(porCat).map(([nome, n]) => ({ nome, n: m(n) })).sort((a, b) => (b.n === '<3' ? 1 : b.n) - (a.n === '<3' ? 1 : a.n)),
    porPrioridade: PRIORIDADES.map(p => ({ p, txt: PRIORIDADE_TXT[p], n: l.filter(c => c.prioridade === p).length })), porStatus: STATUS.map(s => ({ s, txt: STATUS_TXT[s], n: l.filter(c => c.status === s).length })) };
}

module.exports = {
  DIR, P, UNIDADES, CATEGORIAS, PRIORIDADES, PRIORIDADE_TXT, POLITICAS_PADRAO, ETAPAS_PRAZO, ETAPA_TXT, CADEIA_PADRAO, PAPEIS, STATUS, STATUS_TXT, ETAPA_PUBLICA, RESULTADOS, DESFECHOS_OM, ATIVOS,
  config, salvarConfig, unidade, categoria, instancia, designado, papeisDe, temPapel, bootstrapPermitido, usuariosComPapel, impedido, podeVer, textoRegra, somarPrazo, diaUtil, diasUteisEntre,
  carregar, recarregar, obter, todos, eventos, registrarEvento, verificarCadeia, auditar, auditoria, notificar, notificacoes, marcarLidas,
  registrar, anexosDoPortal, consultar, visaoPublica, abrirTriagem, triar, aceitar, declararImpedimento, solicitarRedistribuicao, redistribuir, providencia, evidencia, solicitarProrrogacao, decidirProrrogacao, enviarValidacao, validar, reabrir,
  tick, escalonar, etapaPendente, proximaInstancia, omissoes, omissao, manifestar, decidirOmissao, resumo, fila, detalhe, acoesDe, painel, hashCredencial, novaCredencial, cifrar, decifrar,
};
