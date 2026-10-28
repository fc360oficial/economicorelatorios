'use strict';
// lib/gestao-documental.js — Central de Gestão Documental (DP / RH › Gestão Documental), etapa 02 (28/10/2026).
// Prontuário digital por funcionário (id permanente do PontoCerto/Pontomais — acompanha transferência entre lojas), recebimento
// de documentos pelo CPD das unidades, conferência e arquivamento pelo RH, importação histórica direta pelo RH (unitária e em
// lote), solicitações do RH às unidades, autorização da Coordenação (com reautenticação) pra excluir/substituir documento
// validado, auditoria imutável e retenção documental.
// Reaproveita a central de pessoas (lib/gestao-pessoas.js: designados, papéis, escopo por loja, notificações) e o cadastro do
// PontoCerto (lib/pontocerto.js, só leitura). Nenhum cadastro de funcionário ou unidade é duplicado: o documento guarda uma
// FOTO (nome, matrícula, loja, cargo) do momento, e o prontuário é pelo id.
// Dados em data/gestao-documental (gitignored, dado pessoal de acesso restrito; entra no backup geral do data/):
//   docs/<prot>.json · solicitacoes/<prot>.json · autorizacoes/<prot>.json · seq.json · config.json · auditoria/AAAA-MM.jsonl
//   arquivos/pendentes/<prot>/vN.ext (recebidos, ainda não validados)  ·  arquivos/prontuarios/<colabId>/<cat>/<prot>-vN.ext (validados)
//   arquivos/excluidos/<prot>/ (exclusão autorizada pela Coordenação: o arquivo sai do prontuário mas NÃO é apagado — retenção)
// Acesso público direto ao arquivo não existe: só pela rota autenticada, que passa por podeBaixar().
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const GP = require('./gestao-pessoas');

const DIR = process.env.CGD_DIR || path.join(__dirname, '..', 'data', 'gestao-documental');
const P = {
  docs: () => path.join(DIR, 'docs'), doc: p => path.join(DIR, 'docs', p + '.json'),
  sols: () => path.join(DIR, 'solicitacoes'), sol: p => path.join(DIR, 'solicitacoes', p + '.json'),
  auts: () => path.join(DIR, 'autorizacoes'), aut: p => path.join(DIR, 'autorizacoes', p + '.json'),
  pend: prot => path.join(DIR, 'arquivos', 'pendentes', prot), pront: (colab, cat) => path.join(DIR, 'arquivos', 'prontuarios', String(colab), cat),
  excl: prot => path.join(DIR, 'arquivos', 'excluidos', prot), seq: () => path.join(DIR, 'seq.json'), config: () => path.join(DIR, 'config.json'),
  auditoria: iso => path.join(DIR, 'auditoria', String(iso).slice(0, 7) + '.jsonl'),
};
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400 }, extra || {});
const agoraIso = () => new Date().toISOString();
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const dataOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T12:00:00').getTime());
const txt = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max || 2000);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
function appendLinha(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(obj) + '\n'); }
function lerLinhas(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } }
function listarDir(d) { try { return fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch (e) { return []; } }

// ── Catálogos ────────────────────────────────────────────────────────────────
// Pastas do prontuário (spec etapa 02, item 2). `sensivel` = saúde ocupacional: só RH / Coordenação baixam.
// `retencaoAnos` = proposta inicial (CLT/FGTS/NR-7) a validar com o jurídico — configurável em config.json; nada é descartado sozinho.
const CATEGORIAS = {
  '01': { nome: 'Documentos Pessoais', retencaoAnos: 5, tipos: ['RG', 'CPF', 'CTPS digital', 'Título de eleitor', 'Certificado de reservista', 'Comprovante de residência', 'Comprovante de escolaridade', 'CNH', 'Certidão de nascimento ou casamento', 'Certidão de dependentes', 'PIS / NIS', 'Foto 3x4', 'Outro documento pessoal'] },
  '02': { nome: 'Admissão e Contratos', retencaoAnos: 10, tipos: ['Ficha de registro', 'Contrato de trabalho', 'Contrato de experiência', 'Prorrogação de experiência', 'Acordo de compensação de horas', 'Acordo de banco de horas', 'Opção de vale-transporte', 'Termo de responsabilidade', 'Alteração contratual', 'Outro documento admissional'] },
  '03': { nome: 'Termos de Ciência', retencaoAnos: 5, tipos: ['Termo de ciência', 'Regulamento interno', 'Política de uso de sistemas', 'Termo de entrega de EPI / uniforme', 'Termo de confidencialidade', 'Outro termo'] },
  '04': { nome: 'Férias', retencaoAnos: 5, tipos: ['Aviso de férias', 'Recibo de férias', 'Abono pecuniário', 'Programação de férias', 'Outro documento de férias'] },
  '05': { nome: 'Afastamentos', retencaoAnos: 10, tipos: ['Atestado médico', 'Declaração de comparecimento', 'Licença-maternidade / paternidade', 'Afastamento INSS', 'Outro afastamento'] },
  '06': { nome: 'Medidas Disciplinares', retencaoAnos: 5, tipos: ['Advertência escrita', 'Suspensão disciplinar', 'Registro de recusa de assinatura', 'Outro documento disciplinar'] },
  '07': { nome: 'Saúde Ocupacional', retencaoAnos: 20, sensivel: true, tipos: ['ASO admissional', 'ASO periódico', 'ASO de retorno ao trabalho', 'ASO de mudança de função', 'ASO demissional', 'Exame complementar', 'Outro documento de saúde ocupacional'] },
  '08': { nome: 'Recibos e Contracheques', retencaoAnos: 5, tipos: ['Contracheque', 'Recibo de pagamento', 'Recibo de adiantamento', 'Recibo de vale-transporte', 'Recibo de benefício', 'Outro recibo'] },
  '09': { nome: 'Espelhos de Ponto', retencaoAnos: 5, tipos: ['Espelho de ponto', 'Justificativa de ponto', 'Outro documento de ponto'] },
  '10': { nome: 'Desligamento', retencaoAnos: 10, tipos: ['Aviso prévio', 'Termo de rescisão (TRCT)', 'Homologação', 'Carta de referência', 'Outro documento de desligamento'] },
};
const CATS = Object.keys(CATEGORIAS).sort();   // .sort(): "10" é chave numérica e o JS a poria antes de "01"
const STATUS_TXT = { aguardando_rh: 'Aguardando conferência do RH', em_analise: 'Em análise pelo RH', correcao_solicitada: 'Correção solicitada ao CPD', rejeitado: 'Rejeitado', arquivado: 'Validado — Arquivado', excluido: 'Excluído (autorizado pela Coordenação)' };
const ABERTOS = ['aguardando_rh', 'em_analise', 'correcao_solicitada'];
const ORIGEM_TXT = { cpd: 'Envio pelo CPD da unidade', importacao_historica: 'Importação histórica (RH)' };
const ORIGEM_DET_TXT = { fisico: 'Arquivo físico digitalizado', digital_anterior: 'Arquivo digital anterior', outra: 'Outra origem cadastrada' };
const SOL_STATUS_TXT = { aberta: 'Aberta', atendida: 'Atendida', cancelada: 'Cancelada' };
const AUT_OP_TXT = { excluir: 'Exclusão de documento validado', substituir: 'Substituição de documento validado' };
const AUT_STATUS_TXT = { pendente: 'Aguardando a Coordenação', aprovada: 'Aprovada', indeferida: 'Indeferida', usada: 'Aprovada e executada' };
const ACAO_TXT = { enviar: 'Documento enviado pelo CPD', reenviar: 'Documento reenviado pelo CPD (nova versão)', analisar: 'RH iniciou a análise', validar: 'Validado e arquivado pelo RH', corrigir: 'RH solicitou correção ao CPD', rejeitar: 'Rejeitado pelo RH',
  importar: 'Importação histórica direta pelo RH (validado e arquivado)', substituir: 'Nova versão arquivada (substituição autorizada)', excluir: 'Excluído do prontuário (autorização da Coordenação)',
  aut_solicitar: 'RH pediu autorização à Coordenação', aut_aprovar: 'Coordenação aprovou', aut_indeferir: 'Coordenação indeferiu', sol_criar: 'RH solicitou documento à unidade', sol_cancelar: 'Solicitação cancelada', baixar: 'Arquivo aberto/baixado', ver: 'Prontuário consultado', config: 'Configuração alterada' };

// ── Configuração ─────────────────────────────────────────────────────────────
let cfgMem = null;
function configPadrao() { return { prazoRhDias: 2, prazoCpdDias: 3, maxMb: 25, retencaoAnos: Object.fromEntries(CATS.map(c => [c, CATEGORIAS[c].retencaoAnos])), avisarWhatsapp: false }; }
function config() { if (!cfgMem) cfgMem = { ...configPadrao(), ...lerJson(P.config(), {}) }; return cfgMem; }
function salvarConfig(user, mud) {
  const p = permissoes(user); if (!p.config) throw erro('Só a Coordenação altera a configuração', 403);
  const c = config(); const n = { ...c };
  if (mud.prazoRhDias != null) n.prazoRhDias = Math.min(30, Math.max(1, +mud.prazoRhDias || 1));
  if (mud.prazoCpdDias != null) n.prazoCpdDias = Math.min(60, Math.max(1, +mud.prazoCpdDias || 1));
  if (mud.retencaoAnos && typeof mud.retencaoAnos === 'object') for (const k of CATS) if (mud.retencaoAnos[k] != null) n.retencaoAnos[k] = Math.min(99, Math.max(1, +mud.retencaoAnos[k] || 1));
  if (mud.avisarWhatsapp != null) n.avisarWhatsapp = !!mud.avisarWhatsapp;
  cfgMem = n; gravarJson(P.config(), n); auditar(user, 'config', null, { detalhe: JSON.stringify(mud).slice(0, 300) }); return n;
}

// ── Permissões (designação na central de pessoas; admin do sistema opera como RH + Coordenação) ──
// cpd = papel novo 'cpd' (GP.PAPEIS) designado com as lojas da unidade. Diretoria só consulta, nunca aprova.
function permissoes(user) {
  const p = GP.papeisDe(user || {}); const admin = !!(user && user.perfil === 'admin');
  const cpd = p.includes('cpd'), rh = p.some(x => GP.RH.includes(x)), coord = p.includes('coordenacao'), dir = p.includes('diretoria');
  const d = GP.designado(user); const lojasCpd = cpd ? (d && d.lojas || []).map(Number) : [];
  return { ver: cpd || rh || coord || dir || admin, cpd, rh: rh || admin, coord: coord || admin, dir, admin, importar: rh || admin, autorizar: coord || admin, config: coord || admin, lojasCpd, papeis: p,
    lojas: GP.LOJAS.filter(l => veLoja(user, l, { cpd, rh, coord, dir, admin, lojasCpd })) };
}
function veLoja(user, loja, p) {
  p = p || permissoes(user); loja = +loja;
  if (p.coord || p.dir || p.admin) return true;
  if (p.rh && GP.rhDa(user, loja)) return true;
  return p.cpd && p.lojasCpd.includes(loja);
}
const lojaTxt = n => GP.LOJA_TXT[n] || ('Loja ' + n);
function podeVer(user, d) {
  const p = permissoes(user); if (!p.ver) return false;
  if (d.enviadoPor && d.enviadoPor.usuario === user.usuario) return true;   // quem enviou acompanha o próprio protocolo
  if (!veLoja(user, d.loja, p)) return false;
  if (CATEGORIAS[d.categoria].sensivel && !(p.rh || p.coord)) return false;   // saúde ocupacional: CPD e Diretoria nem veem a ficha
  return true;
}
function podeBaixar(user, d) {
  const p = permissoes(user); if (!podeVer(user, d)) return false;
  if (CATEGORIAS[d.categoria].sensivel) return p.rh || p.coord;
  if (d.status === 'excluido') return p.coord;
  if (p.dir) return false;   // diretoria consulta a ficha, não abre o arquivo
  return true;
}

// ── Armazenamento ────────────────────────────────────────────────────────────
let docsMem = null, solsMem = null, autsMem = null;
function carregar(mem, dir) { const m = new Map(); for (const f of listarDir(dir)) { const o = lerJson(path.join(dir, f), null); if (o && o.protocolo) m.set(o.protocolo, o); } return m; }
const docs = () => docsMem || (docsMem = carregar(docsMem, P.docs()));
const sols = () => solsMem || (solsMem = carregar(solsMem, P.sols()));
const auts = () => autsMem || (autsMem = carregar(autsMem, P.auts()));
function obter(prot) { const d = docs().get(String(prot || '').toUpperCase().trim()); if (!d) throw erro('Protocolo não encontrado', 404); return d; }
function obterSol(prot) { const s = sols().get(String(prot || '').toUpperCase().trim()); if (!s) throw erro('Solicitação não encontrada', 404); return s; }
function obterAut(prot) { const a = auts().get(String(prot || '').toUpperCase().trim()); if (!a) throw erro('Autorização não encontrada', 404); return a; }
function gravarDoc(d) { d.atualizadoEm = agoraIso(); gravarJson(P.doc(d.protocolo), d); docs().set(d.protocolo, d); return d; }
function gravarSol(s) { s.atualizadoEm = agoraIso(); gravarJson(P.sol(s.protocolo), s); sols().set(s.protocolo, s); return s; }
function gravarAut(a) { a.atualizadoEm = agoraIso(); gravarJson(P.aut(a.protocolo), a); auts().set(a.protocolo, a); return a; }
// numeração sequencial por ano e prefixo (seq.json) — nunca reaproveita número
function proximoProtocolo(prefixo, digitos) {
  const ano = new Date().getFullYear(); const s = lerJson(P.seq(), {}); s[prefixo] = s[prefixo] || {}; s[prefixo][ano] = (s[prefixo][ano] || 0) + 1; gravarJson(P.seq(), s);
  return prefixo + '-' + ano + '-' + String(s[prefixo][ano]).padStart(digitos || 5, '0');
}
function hist(d, user, acao, para, texto, extra) {
  const de = d.status; if (para) d.status = para;
  (d.historico = d.historico || []).push({ em: agoraIso(), usuario: user.usuario, nome: user.nome || user.usuario, acao, de, para: para || de, texto: txt(texto, 1000) || undefined, ...(extra || {}) });
}
function auditar(user, acao, ref, extra) {
  appendLinha(P.auditoria(agoraIso()), { em: agoraIso(), usuario: user.usuario, nome: user.nome || user.usuario, acao, ref: ref || null, ip: user.ip || null, ...(extra || {}) });
}
function notificar(papeis, loja, texto, ref) { try { GP.notificar(GP.usuariosPara(papeis, loja), '[Gestão Documental] ' + texto, ref); } catch (e) { /* notificação nunca derruba a operação */ } }

// ── Arquivos: validação (tipo real pelos primeiros bytes, tamanho, extensão), hash e movimentação ──
const MAGIC = [[/^application\/pdf$/i, /\.pdf$/i, b => b.slice(0, 4).toString() === '%PDF', '.pdf'], [/^image\/jpeg$/i, /\.jpe?g$/i, b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF, '.jpg'],
  [/^image\/png$/i, /\.png$/i, b => b[0] === 0x89 && b.slice(1, 4).toString() === 'PNG', '.png'], [/^image\/webp$/i, /\.webp$/i, b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP', '.webp']];
function validarArquivo(f) {
  if (!f || !f.path) throw erro('Anexe o arquivo (PDF, JPG, PNG ou WEBP)');
  const max = (config().maxMb || 25) * 1024 * 1024; if (f.size > max) throw erro('Arquivo maior que ' + (config().maxMb || 25) + ' MB');
  if (f.size < 64) throw erro('Arquivo vazio ou corrompido');
  const nome = String(f.originalname || ''); const fd = fs.openSync(f.path, 'r'); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
  const m = MAGIC.find(x => x[0].test(f.mimetype || '') && x[1].test(nome));
  if (!m) throw erro('Tipo de arquivo não aceito: ' + (nome || f.mimetype) + '. Só PDF, JPG, PNG ou WEBP.');
  if (!m[2](b)) throw erro('O conteúdo de "' + nome + '" não corresponde a um ' + m[3].slice(1).toUpperCase() + ' válido (arquivo renomeado ou corrompido).');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
  return { nome: nome.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120), ext: m[3], tipo: m[3] === '.jpg' ? 'image/jpeg' : m[3] === '.pdf' ? 'application/pdf' : 'image/' + m[3].slice(1), tamanho: f.size, hash };
}
function duplicado(colabId, hash, exceto) { for (const d of docs().values()) if (d.protocolo !== exceto && String(d.colab.id) === String(colabId) && !['rejeitado', 'excluido'].includes(d.status) && (d.versoes || []).some(v => v.hash === hash)) return d; return null; }
function mover(tmp, destDir, nomeArq) { fs.mkdirSync(destDir, { recursive: true }); const dest = path.join(destDir, nomeArq); try { fs.renameSync(tmp, dest); } catch (e) { fs.copyFileSync(tmp, dest); fs.unlinkSync(tmp); } return path.relative(DIR, dest).split(path.sep).join('/'); }
const abs = rel => path.join(DIR, rel);
function versaoNova(d, meta, rel, user, motivo) { const n = (d.versoes || []).length + 1; (d.versoes = d.versoes || []).push({ n, nome: meta.nome, caminho: rel, tamanho: meta.tamanho, tipo: meta.tipo, hash: meta.hash, em: agoraIso(), por: { usuario: user.usuario, nome: user.nome || user.usuario }, motivo: txt(motivo, 300) || undefined }); d.versaoAtual = n; return n; }
function versaoAtual(d) { return (d.versoes || []).find(v => v.n === d.versaoAtual) || (d.versoes || [])[0]; }
// validado → pasta do prontuário (separada logicamente dos pendentes)
function arquivarVersao(d, v) { const rel = mover(abs(v.caminho), P.pront(d.colab.id, d.categoria), d.protocolo + '-v' + v.n + path.extname(v.caminho)); v.caminho = rel; }

// ── Colaborador (PontoCerto, só leitura) ─────────────────────────────────────
async function colab(id, deps) {
  const col = await deps.colaboradores(); const c = col.ativos.find(x => String(x.id) === String(id)) || col.desligados.find(x => String(x.id) === String(id));
  if (!c) throw erro('Funcionário não encontrado no cadastro (PontoCerto)', 404);
  return { id: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo || '', setor: c.setor || '', loja: +c.loja, ativo: !!c.ativo, admissao: c.admissao || null, situacao: c.ativo ? (c.status_agora || 'Ativo') : 'Desligado' };
}
async function buscarColaboradores(user, q, loja, deps, incluirDesligados) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem acesso', 403);
  const col = await deps.colaboradores(); const n = semAcento(q || '').trim(); const lista = incluirDesligados ? [...col.ativos, ...col.desligados] : col.ativos;
  return lista.filter(c => veLoja(user, c.loja, p) && (!loja || +c.loja === +loja) && (!n || semAcento(c.nome).includes(n) || String(c.matricula || '').includes(n)))
    .slice(0, 60).map(c => ({ id: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo || '', setor: c.setor || '', loja: +c.loja, lojaTxt: lojaTxt(c.loja), ativo: !!c.ativo, admissao: c.admissao || null }));
}

// ── Validações de entrada ────────────────────────────────────────────────────
function validarClassificacao(b) {
  const categoria = String(b.categoria || '').padStart(2, '0'); if (!CATEGORIAS[categoria]) throw erro('Categoria (pasta) inválida');
  const tipo = txt(b.tipo, 80); if (!CATEGORIAS[categoria].tipos.includes(tipo)) throw erro('Tipo de documento inválido para a pasta ' + categoria + ' — ' + CATEGORIAS[categoria].nome);
  const dataDocumento = b.dataDocumento ? String(b.dataDocumento) : null; if (dataDocumento && !dataOk(dataDocumento)) throw erro('Data do documento inválida'); if (dataDocumento && dataDocumento > hojeISO()) throw erro('Data do documento não pode ser futura');
  const competencia = b.competencia ? String(b.competencia) : null; if (competencia && !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) throw erro('Competência inválida (use AAAA-MM)');
  return { categoria, tipo, dataDocumento, competencia, observacoes: txt(b.observacoes, 500) || null };
}
function retencaoAte(d) { const base = d.dataDocumento || (d.arquivadoEm || agoraIso()).slice(0, 10); const anos = (config().retencaoAnos || {})[d.categoria] || CATEGORIAS[d.categoria].retencaoAnos; return (+base.slice(0, 4) + anos) + base.slice(4); }
function novoDoc(user, c, cls, origem, extra) {
  return { protocolo: proximoProtocolo('CGD'), colab: c, loja: c.loja, ...cls, origem, ...(extra || {}), status: null, sensivel: !!CATEGORIAS[cls.categoria].sensivel,
    enviadoPor: { usuario: user.usuario, nome: user.nome || user.usuario }, enviadoEm: agoraIso(), validadoPor: null, validadoEm: null, arquivadoEm: null, versoes: [], versaoAtual: 0, historico: [], criadoEm: agoraIso() };
}

// ── Recebimento pelo CPD ─────────────────────────────────────────────────────
async function enviar(user, body, file, deps) {
  const p = permissoes(user); if (!(p.cpd || p.rh)) throw erro('Só o CPD da unidade (ou o RH) envia documentos', 403);
  const c = await colab(body.colabId, deps); if (!veLoja(user, c.loja, p)) throw erro('Este funcionário não é da sua unidade', 403);
  const cls = validarClassificacao(body); const meta = validarArquivo(file);
  const dup = duplicado(c.id, meta.hash); if (dup) throw erro('Este arquivo já está no prontuário de ' + c.nome + ' (' + dup.protocolo + ' · ' + STATUS_TXT[dup.status] + ')', 409, { duplicadoDe: dup.protocolo });
  const d = novoDoc(user, c, cls, 'cpd'); const rel = mover(file.path, P.pend(d.protocolo), 'v1' + meta.ext); versaoNova(d, meta, rel, user);
  if (body.solicitacao) { const s = sols().get(String(body.solicitacao).toUpperCase()); if (s && s.status === 'aberta' && String(s.colab.id) === String(c.id)) { d.solicitacao = s.protocolo; s.status = 'atendida'; s.documento = d.protocolo; s.atendidaEm = agoraIso(); gravarSol(s); } }
  hist(d, user, 'enviar', 'aguardando_rh', cls.observacoes); gravarDoc(d);
  auditar(user, 'enviar', d.protocolo, { loja: d.loja, colab: c.id, detalhe: cls.tipo + ' · ' + c.nome + ' · ' + meta.nome + ' (' + meta.tamanho + ' B)' });
  notificar(GP.RH, d.loja, d.protocolo + ' · ' + cls.tipo + ' de ' + c.nome + ' (' + lojaTxt(d.loja) + ') aguarda conferência', d.protocolo);
  return d;
}
function reenviar(prot, user, body, file) {
  const d = obter(prot); const p = permissoes(user); if (!(p.cpd || p.rh) || !veLoja(user, d.loja, p)) throw erro('Sem permissão para reenviar este protocolo', 403);
  if (d.status !== 'correcao_solicitada') throw erro('Só é possível reenviar quando o RH solicitou correção (situação atual: ' + STATUS_TXT[d.status] + ')', 409);
  const meta = validarArquivo(file); const dup = duplicado(d.colab.id, meta.hash, d.protocolo); if (dup) throw erro('Este arquivo já está no prontuário (' + dup.protocolo + ')', 409);
  const n = versaoNova(d, meta, mover(file.path, P.pend(d.protocolo), 'v' + ((d.versoes || []).length + 1) + meta.ext), user, 'Reenvio após correção');
  if (body && body.observacoes) d.observacoes = txt(body.observacoes, 500);
  hist(d, user, 'reenviar', 'aguardando_rh', body && body.texto, { versao: n }); gravarDoc(d);
  auditar(user, 'reenviar', d.protocolo, { loja: d.loja, colab: d.colab.id, detalhe: 'versão ' + n + ' · ' + meta.nome });
  notificar(GP.RH, d.loja, d.protocolo + ' reenviado pelo CPD (' + lojaTxt(d.loja) + ') — versão ' + n, d.protocolo); return d;
}

// ── Conferência pelo RH ──────────────────────────────────────────────────────
function exigeRh(user, d) { const p = permissoes(user); if (!p.rh || !veLoja(user, d.loja, p)) throw erro('Só o RH confere documentos desta unidade', 403); return p; }
function analisar(prot, user) { const d = obter(prot); exigeRh(user, d); if (d.status !== 'aguardando_rh') throw erro('Situação atual: ' + STATUS_TXT[d.status], 409); d.analista = { usuario: user.usuario, nome: user.nome || user.usuario }; hist(d, user, 'analisar', 'em_analise'); auditar(user, 'analisar', d.protocolo, { loja: d.loja, colab: d.colab.id }); return gravarDoc(d); }
function validar(prot, user, body) {
  const d = obter(prot); exigeRh(user, d); if (!['aguardando_rh', 'em_analise'].includes(d.status)) throw erro('Não é possível validar na situação atual (' + STATUS_TXT[d.status] + ')', 409);
  const b = body || {}; if (b.categoria || b.tipo) { const cls = validarClassificacao({ ...d, ...b }); Object.assign(d, cls); }   // RH pode corrigir a classificação ao validar
  arquivarVersao(d, versaoAtual(d)); d.validadoPor = { usuario: user.usuario, nome: user.nome || user.usuario }; d.validadoEm = agoraIso(); d.arquivadoEm = d.validadoEm; d.parecer = txt(b.parecer, 1000) || null; d.retencaoAte = retencaoAte(d);
  hist(d, user, 'validar', 'arquivado', d.parecer); gravarDoc(d); auditar(user, 'validar', d.protocolo, { loja: d.loja, colab: d.colab.id, detalhe: d.tipo + ' · ' + d.colab.nome });
  notificar(['cpd'], d.loja, d.protocolo + ' · ' + d.tipo + ' de ' + d.colab.nome + ' foi validado e arquivado', d.protocolo); return d;
}
function corrigir(prot, user, body) {
  const d = obter(prot); exigeRh(user, d); if (!['aguardando_rh', 'em_analise'].includes(d.status)) throw erro('Situação atual: ' + STATUS_TXT[d.status], 409);
  const motivo = txt(body && body.motivo, 120); const texto = txt(body && body.texto, 1000); if (!motivo) throw erro('Informe o motivo da correção');
  (d.correcoes = d.correcoes || []).push({ em: agoraIso(), por: { usuario: user.usuario, nome: user.nome || user.usuario }, motivo, texto: texto || undefined, versao: d.versaoAtual });
  hist(d, user, 'corrigir', 'correcao_solicitada', motivo + (texto ? ' — ' + texto : '')); gravarDoc(d); auditar(user, 'corrigir', d.protocolo, { loja: d.loja, colab: d.colab.id, detalhe: motivo });
  notificar(['cpd'], d.loja, d.protocolo + ' devolvido para correção: ' + motivo, d.protocolo); return d;
}
function rejeitar(prot, user, body) {
  const d = obter(prot); exigeRh(user, d); if (!ABERTOS.includes(d.status)) throw erro('Situação atual: ' + STATUS_TXT[d.status], 409);
  const motivo = txt(body && body.motivo, 500); if (motivo.length < 5) throw erro('Informe o motivo da rejeição');
  d.rejeicao = { em: agoraIso(), por: { usuario: user.usuario, nome: user.nome || user.usuario }, motivo }; hist(d, user, 'rejeitar', 'rejeitado', motivo); gravarDoc(d);
  auditar(user, 'rejeitar', d.protocolo, { loja: d.loja, colab: d.colab.id, detalhe: motivo }); notificar(['cpd'], d.loja, d.protocolo + ' foi rejeitado pelo RH: ' + motivo, d.protocolo); return d;
}

// ── Importação histórica direta pelo RH (unitária) ───────────────────────────
async function importar(user, body, file, deps, opts = {}) {
  const p = permissoes(user); if (!p.importar) throw erro('Só o RH autorizado importa documentos históricos', 403);
  if (!(body.confirmado === true || String(body.confirmado) === '1' || String(body.confirmado) === 'true')) throw erro('Confirme o resumo antes de arquivar diretamente');
  const c = await colab(body.colabId, deps); if (!veLoja(user, c.loja, p)) throw erro('Funcionário fora das unidades que você atende', 403);
  const cls = validarClassificacao(body); if (!cls.dataDocumento) throw erro('Informe a data original do documento (ela nunca é substituída pela data da importação)');
  const origemDetalhe = String(body.origem || 'fisico'); if (!ORIGEM_DET_TXT[origemDetalhe]) throw erro('Origem inválida');
  const meta = validarArquivo(file); const dup = duplicado(c.id, meta.hash); if (dup) throw erro('Arquivo já existe no prontuário de ' + c.nome + ' (' + dup.protocolo + ')', 409, { duplicadoDe: dup.protocolo });
  const d = novoDoc(user, c, cls, 'importacao_historica', { origemDetalhe, importadoEm: agoraIso(), lote: opts.lote || null });
  versaoNova(d, meta, mover(file.path, P.pend(d.protocolo), 'v1' + meta.ext), user); arquivarVersao(d, versaoAtual(d));
  d.validadoPor = { usuario: user.usuario, nome: user.nome || user.usuario }; d.validadoEm = agoraIso(); d.arquivadoEm = d.validadoEm; d.retencaoAte = retencaoAte(d);
  hist(d, user, 'importar', 'arquivado', cls.observacoes, { origem: origemDetalhe }); gravarDoc(d);
  auditar(user, 'importar', d.protocolo, { loja: d.loja, colab: c.id, detalhe: cls.tipo + ' · ' + c.nome + ' · ' + ORIGEM_DET_TXT[origemDetalhe] + ' · data ' + cls.dataDocumento + (opts.lote ? ' · lote ' + opts.lote : '') });
  return d;
}
// ── Importação em lote: cada arquivo vira um documento com protocolo próprio; item sem funcionário identificado NÃO é arquivado ──
async function importarLote(user, itens, files, deps) {
  const p = permissoes(user); if (!p.importar) throw erro('Só o RH autorizado importa documentos históricos', 403);
  if (!Array.isArray(itens) || !itens.length || itens.length !== (files || []).length) throw erro('Lote inválido: a lista de itens precisa ter um registro por arquivo');
  const lote = 'LOTE-' + agoraIso().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(); const out = [];
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i] || {}; const f = files[i];
    try {
      if (!it.colabId) throw erro('Funcionário não identificado — não arquivado');
      const d = await importar(user, { ...it, confirmado: true }, f, deps, { lote }); out.push({ i, arquivo: f.originalname, ok: true, protocolo: d.protocolo, colab: d.colab.nome, categoria: d.categoria, tipo: d.tipo });
    } catch (e) { out.push({ i, arquivo: f && f.originalname, ok: false, erro: e.message, duplicadoDe: e.duplicadoDe }); try { if (f && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (e2) { /* já movido */ } }
  }
  auditar(user, 'importar_lote', lote, { detalhe: out.filter(x => x.ok).length + ' arquivado(s), ' + out.filter(x => !x.ok).length + ' recusado(s)' });
  return { lote, itens: out, arquivados: out.filter(x => x.ok).length, recusados: out.filter(x => !x.ok).length };
}

// ── Proteção do documento validado: RH solicita → Coordenação decide (reautenticada) ──
function solicitarAutorizacao(user, body) {
  const p = permissoes(user); if (!p.rh) throw erro('Só o RH solicita autorização', 403);
  const d = obter(body.protocolo); if (!veLoja(user, d.loja, p)) throw erro('Sem acesso a este protocolo', 403);
  if (d.status !== 'arquivado') throw erro('Só documentos validados e arquivados passam pela Coordenação (situação atual: ' + STATUS_TXT[d.status] + ')', 409);
  const operacao = String(body.operacao || ''); if (!AUT_OP_TXT[operacao]) throw erro('Operação inválida (excluir ou substituir)');
  const justificativa = txt(body.justificativa, 1000); if (justificativa.length < 10) throw erro('Justifique o pedido (mínimo 10 caracteres)');
  if ([...auts().values()].some(a => a.documento === d.protocolo && a.status === 'pendente')) throw erro('Já existe um pedido pendente para este documento', 409);
  const a = { protocolo: proximoProtocolo('AUT', 4), documento: d.protocolo, operacao, justificativa, status: 'pendente', loja: d.loja, colab: d.colab, tipo: d.tipo, categoria: d.categoria, versao: d.versaoAtual,
    solicitante: { usuario: user.usuario, nome: user.nome || user.usuario }, solicitadoEm: agoraIso(), decisao: null, criadoEm: agoraIso() };
  gravarAut(a); (d.autorizacoes = d.autorizacoes || []).push(a.protocolo); hist(d, user, 'aut_solicitar', null, AUT_OP_TXT[operacao] + ' — ' + justificativa, { autorizacao: a.protocolo }); gravarDoc(d);
  auditar(user, 'aut_solicitar', a.protocolo, { loja: d.loja, colab: d.colab.id, detalhe: AUT_OP_TXT[operacao] + ' · ' + d.protocolo + ' · ' + justificativa });
  notificar(['coordenacao'], null, a.protocolo + ': RH pede ' + AUT_OP_TXT[operacao].toLowerCase() + ' (' + d.protocolo + ' · ' + d.colab.nome + ')', a.protocolo); return a;
}
// `reautenticado` = a rota conferiu a senha da conta da Coordenação (bcrypt, deps.validarSenha) ANTES de chamar aqui; a senha nunca chega ao lib nem é gravada
function decidirAutorizacao(prot, user, body, reautenticado) {
  const p = permissoes(user); if (!p.autorizar) throw erro('Só a Coordenação Administrativa decide autorizações', 403);
  if (!reautenticado) throw erro('Confirme sua senha para autorizar', 401);
  const a = obterAut(prot); if (a.status !== 'pendente') throw erro('Pedido já decidido (' + AUT_STATUS_TXT[a.status] + ')', 409);
  if (a.solicitante.usuario === user.usuario) throw erro('Quem pediu não pode autorizar o próprio pedido', 403);
  const aprovar = body.decisao === 'aprovar'; const texto = txt(body.texto, 1000); if (!aprovar && texto.length < 5) throw erro('Informe o motivo do indeferimento');
  const d = obter(a.documento);
  a.decisao = { aprovada: aprovar, por: { usuario: user.usuario, nome: user.nome || user.usuario }, em: agoraIso(), texto: texto || null, reautenticadoEm: agoraIso() }; a.status = aprovar ? 'aprovada' : 'indeferida';
  if (aprovar && a.operacao === 'excluir') {
    for (const v of d.versoes || []) { try { v.caminho = mover(abs(v.caminho), P.excl(d.protocolo), path.basename(v.caminho)); } catch (e) { /* arquivo já fora do prontuário */ } }
    d.exclusao = { autorizacao: a.protocolo, por: a.decisao.por, em: a.decisao.em, solicitante: a.solicitante, justificativa: a.justificativa }; hist(d, user, 'excluir', 'excluido', a.justificativa, { autorizacao: a.protocolo }); a.status = 'usada'; a.usadaEm = agoraIso();
  } else if (aprovar) { d.substituicaoAutorizada = a.protocolo; hist(d, user, 'aut_aprovar', null, 'Substituição autorizada — aguardando o RH anexar a nova versão', { autorizacao: a.protocolo }); }
  else hist(d, user, 'aut_indeferir', null, texto, { autorizacao: a.protocolo });
  gravarAut(a); gravarDoc(d);
  auditar(user, aprovar ? 'aut_aprovar' : 'aut_indeferir', a.protocolo, { loja: d.loja, colab: d.colab.id, detalhe: AUT_OP_TXT[a.operacao] + ' · ' + d.protocolo + ' · solicitante ' + a.solicitante.nome + (texto ? ' · ' + texto : '') });
  notificar(GP.RH, d.loja, a.protocolo + ' ' + (aprovar ? 'aprovada' : 'indeferida') + ' pela Coordenação (' + d.protocolo + ')', a.protocolo); return a;
}
function substituir(prot, user, body, file) {
  const d = obter(prot); exigeRh(user, d); if (d.status !== 'arquivado') throw erro('Situação atual: ' + STATUS_TXT[d.status], 409);
  const a = d.substituicaoAutorizada ? auts().get(d.substituicaoAutorizada) : null; if (!a || a.status !== 'aprovada') throw erro('Substituição não autorizada pela Coordenação — peça autorização primeiro', 403);
  const meta = validarArquivo(file); const dup = duplicado(d.colab.id, meta.hash); if (dup) throw erro('Este arquivo já está no prontuário (' + dup.protocolo + ')', 409);
  const n = versaoNova(d, meta, mover(file.path, P.pend(d.protocolo), 'v' + ((d.versoes || []).length + 1) + meta.ext), user, 'Substituição autorizada ' + a.protocolo); arquivarVersao(d, versaoAtual(d));
  if (body && body.dataDocumento) { const cls = validarClassificacao({ ...d, ...body }); Object.assign(d, cls); }
  a.status = 'usada'; a.usadaEm = agoraIso(); a.novaVersao = n; d.substituicaoAutorizada = null; d.validadoPor = { usuario: user.usuario, nome: user.nome || user.usuario }; d.validadoEm = agoraIso();
  hist(d, user, 'substituir', null, body && body.texto, { versao: n, autorizacao: a.protocolo }); gravarAut(a); gravarDoc(d);
  auditar(user, 'substituir', d.protocolo, { loja: d.loja, colab: d.colab.id, detalhe: 'versão ' + n + ' · autorização ' + a.protocolo + ' · ' + meta.nome }); return d;
}

// ── Solicitações do RH às unidades ───────────────────────────────────────────
async function criarSolicitacao(user, body, deps) {
  const p = permissoes(user); if (!p.rh) throw erro('Só o RH solicita documentos às unidades', 403);
  const c = await colab(body.colabId, deps); if (!veLoja(user, c.loja, p)) throw erro('Funcionário fora das unidades que você atende', 403);
  const categoria = String(body.categoria || '').padStart(2, '0'); if (!CATEGORIAS[categoria]) throw erro('Categoria inválida'); const tipo = txt(body.tipo, 80); if (!CATEGORIAS[categoria].tipos.includes(tipo)) throw erro('Tipo inválido');
  const prazo = body.prazo && dataOk(body.prazo) ? body.prazo : (() => { const d = new Date(); d.setDate(d.getDate() + (config().prazoCpdDias || 3)); return d.toISOString().slice(0, 10); })();
  const s = { protocolo: proximoProtocolo('SOL', 4), colab: c, loja: c.loja, categoria, tipo, prazo, observacoes: txt(body.observacoes, 500) || null, status: 'aberta', por: { usuario: user.usuario, nome: user.nome || user.usuario }, criadoEm: agoraIso(), documento: null };
  gravarSol(s); auditar(user, 'sol_criar', s.protocolo, { loja: s.loja, colab: c.id, detalhe: tipo + ' · ' + c.nome + ' · prazo ' + prazo }); notificar(['cpd'], s.loja, s.protocolo + ': RH pede ' + tipo + ' de ' + c.nome + ' até ' + prazo, s.protocolo); return s;
}
function cancelarSolicitacao(prot, user, motivo) { const s = obterSol(prot); const p = permissoes(user); if (!p.rh || !veLoja(user, s.loja, p)) throw erro('Sem permissão', 403); if (s.status !== 'aberta') throw erro('Solicitação já ' + SOL_STATUS_TXT[s.status].toLowerCase(), 409); s.status = 'cancelada'; s.cancelamento = { em: agoraIso(), por: user.usuario, motivo: txt(motivo, 300) || null }; gravarSol(s); auditar(user, 'sol_cancelar', s.protocolo, { loja: s.loja }); return s; }
function resumoSol(s) { const atrasada = s.status === 'aberta' && s.prazo < hojeISO(); return { ...s, atrasada, statusTxt: atrasada ? 'Atrasada' : SOL_STATUS_TXT[s.status], lojaTxt: lojaTxt(s.loja), categoriaTxt: CATEGORIAS[s.categoria].nome }; }
function listarSolicitacoes(user, q = {}) { const p = permissoes(user); if (!p.ver) throw erro('Sem acesso', 403); return [...sols().values()].filter(s => veLoja(user, s.loja, p) && (!q.loja || +s.loja === +q.loja) && (!q.status || (q.status === 'atrasada' ? (s.status === 'aberta' && s.prazo < hojeISO()) : s.status === q.status)) && (!q.colab || String(s.colab.id) === String(q.colab))).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)).map(resumoSol); }

// ── Consultas ────────────────────────────────────────────────────────────────
function resumo(d, user) {
  const v = versaoAtual(d) || {}; const p = user ? permissoes(user) : null;
  return { protocolo: d.protocolo, colab: d.colab, loja: d.loja, lojaTxt: lojaTxt(d.loja), categoria: d.categoria, categoriaTxt: CATEGORIAS[d.categoria].nome, tipo: d.tipo, dataDocumento: d.dataDocumento, competencia: d.competencia, observacoes: d.observacoes,
    origem: d.origem, origemTxt: ORIGEM_TXT[d.origem] + (d.origemDetalhe ? ' · ' + ORIGEM_DET_TXT[d.origemDetalhe] : ''), status: d.status, statusTxt: STATUS_TXT[d.status], sensivel: !!d.sensivel, enviadoPor: d.enviadoPor, enviadoEm: d.enviadoEm,
    validadoPor: d.validadoPor, validadoEm: d.validadoEm, arquivadoEm: d.arquivadoEm, retencaoAte: d.retencaoAte || null, versaoAtual: d.versaoAtual, versoes: (d.versoes || []).map(x => ({ n: x.n, nome: x.nome, tamanho: x.tamanho, tipo: x.tipo, em: x.em, por: x.por, motivo: x.motivo, hash: x.hash })),
    arquivo: { nome: v.nome, tamanho: v.tamanho, tipo: v.tipo }, parecer: d.parecer || null, correcoes: d.correcoes || [], rejeicao: d.rejeicao || null, exclusao: d.exclusao || null, substituicaoAutorizada: d.substituicaoAutorizada || null, autorizacoes: d.autorizacoes || [], solicitacao: d.solicitacao || null, lote: d.lote || null,
    historico: (d.historico || []).map(h => ({ ...h, acaoTxt: ACAO_TXT[h.acao] || h.acao })), podeBaixar: p ? podeBaixar(user, d) : false, diasNaFila: ABERTOS.includes(d.status) ? Math.floor((Date.now() - new Date(d.enviadoEm)) / 86400000) : null };
}
function filtrar(user, q = {}) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem acesso', 403); const n = semAcento(q.q || '').trim();
  return [...docs().values()].filter(d => podeVer(user, d) && (!q.loja || +d.loja === +q.loja) && (!q.categoria || d.categoria === String(q.categoria).padStart(2, '0')) && (!q.tipo || d.tipo === q.tipo) && (!q.status || (q.status === 'abertos' ? ABERTOS.includes(d.status) : d.status === q.status)) && (!q.origem || d.origem === q.origem)
    && (!q.colab || String(d.colab.id) === String(q.colab)) && (!q.de || d.enviadoEm.slice(0, 10) >= q.de) && (!q.ate || d.enviadoEm.slice(0, 10) <= q.ate) && (!q.per || d.enviadoEm.startsWith(q.per))
    && (!n || semAcento(d.colab.nome).includes(n) || String(d.colab.matricula || '').includes(n) || semAcento(d.protocolo).includes(n))).sort((a, b) => b.enviadoEm.localeCompare(a.enviadoEm));
}
function listar(user, q = {}) { return filtrar(user, q).slice(0, +q.limite || 500).map(d => resumo(d, user)); }
function detalhe(prot, user) { const d = obter(prot); if (!podeVer(user, d)) throw erro('Sem acesso a este protocolo', 403); return resumo(d, user); }
function fila(user) { const p = permissoes(user); if (!p.rh) throw erro('Só o RH vê a fila de conferência', 403); return filtrar(user, { status: 'abertos' }).filter(d => d.status !== 'correcao_solicitada').sort((a, b) => a.enviadoEm.localeCompare(b.enviadoEm)).map(d => resumo(d, user)); }
function painel(user, q = {}) {
  const todos = filtrar(user, { loja: q.loja }); const mes = (q.per || agoraIso().slice(0, 7)); const noMes = todos.filter(d => d.enviadoEm.startsWith(mes)); const hoje = hojeISO(); const limite = (config().prazoRhDias || 2) * 86400000;
  const n = (l, st) => l.filter(d => d.status === st).length; const p = permissoes(user);
  const ind = { recebidosMes: noMes.length, aguardandoRh: n(todos, 'aguardando_rh') + n(todos, 'em_analise'), validadosMes: noMes.filter(d => d.status === 'arquivado').length, arquivadosTotal: n(todos, 'arquivado'), correcao: n(todos, 'correcao_solicitada'), rejeitadosMes: n(noMes, 'rejeitado'),
    importadosMes: noMes.filter(d => d.origem === 'importacao_historica').length, foraDoPrazo: todos.filter(d => ['aguardando_rh', 'em_analise'].includes(d.status) && Date.now() - new Date(d.enviadoEm) > limite).length,
    autorizacoesPendentes: p.coord || p.rh ? [...auts().values()].filter(a => a.status === 'pendente' && veLoja(user, a.loja, p)).length : 0, solicitacoesAbertas: [...sols().values()].filter(s => s.status === 'aberta' && veLoja(user, s.loja, p)).length, solicitacoesAtrasadas: [...sols().values()].filter(s => s.status === 'aberta' && s.prazo < hoje && veLoja(user, s.loja, p)).length,
    prontuariosComDoc: new Set(todos.filter(d => d.status === 'arquivado').map(d => String(d.colab.id))).size };
  const situacao = Object.fromEntries(Object.keys(STATUS_TXT).map(st => [st, n(todos, st)]));
  const porLoja = GP.LOJAS.filter(l => veLoja(user, l, p)).map(l => { const L = todos.filter(d => +d.loja === l); return { loja: l, txt: lojaTxt(l), total: L.length, arquivados: n(L, 'arquivado'), aguardando: n(L, 'aguardando_rh') + n(L, 'em_analise'), correcao: n(L, 'correcao_solicitada'), rejeitados: n(L, 'rejeitado') }; });
  const porCategoria = CATS.map(c => ({ categoria: c, nome: CATEGORIAS[c].nome, arquivados: todos.filter(d => d.categoria === c && d.status === 'arquivado').length }));
  const recentes = todos.slice(0, 10).map(d => resumo(d, user));
  const acoes = auditoriaBase(user).slice(0, 8);
  return { indicadores: ind, situacao, porLoja, porCategoria, recentes, acoes, mes };
}
function pendencias(user) {
  const p = permissoes(user); if (!p.ver) return { n: 0 }; let n = 0;
  if (p.rh) n += filtrar(user, { status: 'abertos' }).filter(d => d.status !== 'correcao_solicitada').length;
  if (p.coord) n += [...auts().values()].filter(a => a.status === 'pendente' && a.solicitante.usuario !== user.usuario).length;
  if (p.cpd) n += filtrar(user, { status: 'correcao_solicitada' }).length + [...sols().values()].filter(s => s.status === 'aberta' && p.lojasCpd.includes(+s.loja)).length;
  return { n };
}
// prontuários: lista de funcionários (cadastro do PontoCerto) com contagem de documentos arquivados por pasta
async function prontuarios(user, q, deps) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem acesso', 403); const col = await deps.colaboradores(); const n = semAcento(q.q || '').trim();
  const porColab = new Map(); for (const d of docs().values()) { if (d.status !== 'arquivado' || !podeVer(user, d)) continue; const k = String(d.colab.id); const e = porColab.get(k) || { total: 0, cats: {} }; e.total++; e.cats[d.categoria] = (e.cats[d.categoria] || 0) + 1; porColab.set(k, e); }
  const lista = (q.desligados ? [...col.ativos, ...col.desligados] : col.ativos).filter(c => veLoja(user, c.loja, p) && (!q.loja || +c.loja === +q.loja) && (!n || semAcento(c.nome).includes(n) || String(c.matricula || '').includes(n)));
  const out = lista.map(c => { const e = porColab.get(String(c.id)) || { total: 0, cats: {} }; return { id: c.id, nome: c.nome, matricula: c.matricula || '', cargo: c.cargo || '', setor: c.setor || '', loja: +c.loja, lojaTxt: lojaTxt(c.loja), ativo: !!c.ativo, admissao: c.admissao || null, docs: e.total, pastas: Object.keys(e.cats).length, cats: e.cats }; });
  if (q.sit === 'com') return out.filter(x => x.docs > 0); if (q.sit === 'sem') return out.filter(x => !x.docs);
  return out.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
async function prontuario(colabId, user, deps) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem acesso', 403); const c = await colab(colabId, deps); if (!veLoja(user, c.loja, p)) throw erro('Funcionário fora das unidades que você atende', 403);
  const meus = [...docs().values()].filter(d => String(d.colab.id) === String(c.id) && podeVer(user, d)).sort((a, b) => (b.dataDocumento || b.enviadoEm).localeCompare(a.dataDocumento || a.enviadoEm));
  const pastas = CATS.map(k => ({ categoria: k, nome: CATEGORIAS[k].nome, sensivel: !!CATEGORIAS[k].sensivel, restrita: !!CATEGORIAS[k].sensivel && !(p.rh || p.coord), docs: meus.filter(d => d.categoria === k && d.status === 'arquivado').map(d => resumo(d, user)), abertos: meus.filter(d => d.categoria === k && ABERTOS.includes(d.status)).length }));
  const outros = meus.filter(d => d.status !== 'arquivado').map(d => resumo(d, user));
  auditar(user, 'ver', null, { colab: c.id, loja: c.loja, detalhe: 'prontuário de ' + c.nome });
  return { colab: { ...c, lojaTxt: lojaTxt(c.loja) }, pastas, outros, total: pastas.reduce((s, x) => s + x.docs.length, 0), solicitacoes: listarSolicitacoes(user, { colab: c.id }), historico: meus.flatMap(d => (d.historico || []).map(h => ({ ...h, protocolo: d.protocolo, tipo: d.tipo, acaoTxt: ACAO_TXT[h.acao] || h.acao }))).sort((a, b) => b.em.localeCompare(a.em)).slice(0, 100) };
}
function arquivo(prot, user, versao) {
  const d = obter(prot); if (!podeBaixar(user, d)) throw erro('Sem permissão para abrir este arquivo', 403);
  const v = versao ? (d.versoes || []).find(x => x.n === +versao) : versaoAtual(d); if (!v) throw erro('Versão não encontrada', 404);
  const f = abs(v.caminho); if (!fs.existsSync(f)) throw erro('Arquivo não está mais no servidor', 410);
  auditar(user, 'baixar', d.protocolo, { loja: d.loja, colab: d.colab.id, versao: v.n }); return { caminho: f, nome: v.nome, tipo: v.tipo };
}
function listarAutorizacoes(user, q = {}) { const p = permissoes(user); if (!(p.rh || p.coord || p.dir)) throw erro('Sem acesso', 403); return [...auts().values()].filter(a => veLoja(user, a.loja, p) && (!q.status || a.status === q.status)).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)).map(a => ({ ...a, operacaoTxt: AUT_OP_TXT[a.operacao], statusTxt: AUT_STATUS_TXT[a.status], lojaTxt: lojaTxt(a.loja), podeDecidir: p.autorizar && a.status === 'pendente' && a.solicitante.usuario !== user.usuario })); }
function auditoriaBase(user) {
  const p = permissoes(user); const mes = agoraIso().slice(0, 7); const d = new Date(); d.setMonth(d.getMonth() - 1); const ant = d.toISOString().slice(0, 7);
  let l = [...lerLinhas(P.auditoria(ant + '-01')), ...lerLinhas(P.auditoria(mes + '-01'))];
  if (!(p.coord || p.dir)) l = l.filter(e => e.loja == null ? p.rh : veLoja(user, e.loja, p));
  if (p.cpd && !p.rh && !p.coord) l = l.filter(e => e.usuario === user.usuario || (e.loja != null && p.lojasCpd.includes(+e.loja)));
  return l.reverse().map(e => ({ ...e, acaoTxt: ACAO_TXT[e.acao] || e.acao, lojaTxt: e.loja ? lojaTxt(e.loja) : null }));
}
function auditoria(user, q = {}) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem acesso', 403); let l = auditoriaBase(user);
  if (q.mes && /^\d{4}-\d{2}$/.test(q.mes)) l = lerLinhas(P.auditoria(q.mes + '-01')).reverse().map(e => ({ ...e, acaoTxt: ACAO_TXT[e.acao] || e.acao, lojaTxt: e.loja ? lojaTxt(e.loja) : null })).filter(e => (p.coord || p.dir) || (e.loja == null ? p.rh : veLoja(user, e.loja, p)));
  const n = semAcento(q.q || '').trim();
  return l.filter(e => (!q.usuario || e.usuario === q.usuario) && (!q.acao || e.acao === q.acao) && (!q.loja || +e.loja === +q.loja) && (!n || semAcento((e.ref || '') + ' ' + (e.detalhe || '') + ' ' + (e.nome || '')).includes(n))).slice(0, 2000);
}
function recarregar() { docsMem = null; solsMem = null; autsMem = null; cfgMem = null; }

module.exports = { DIR, P, CATEGORIAS, CATS, STATUS_TXT, ABERTOS, ORIGEM_TXT, ORIGEM_DET_TXT, SOL_STATUS_TXT, AUT_OP_TXT, AUT_STATUS_TXT, ACAO_TXT,
  config, salvarConfig, permissoes, veLoja, podeVer, podeBaixar, colab, buscarColaboradores, enviar, reenviar, analisar, validar, corrigir, rejeitar, importar, importarLote,
  solicitarAutorizacao, decidirAutorizacao, substituir, listarAutorizacoes, criarSolicitacao, cancelarSolicitacao, listarSolicitacoes,
  listar, detalhe, fila, painel, pendencias, prontuarios, prontuario, arquivo, auditoria, resumo, obter, recarregar, validarArquivo, _util: { hojeISO, lojaTxt } };
