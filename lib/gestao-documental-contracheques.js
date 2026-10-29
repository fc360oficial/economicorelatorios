'use strict';
// lib/gestao-documental-contracheques.js — Gestão de Contracheques (DP / RH › Gestão Documental › Contracheques), etapa 4B (29/10/2026).
// O RH importa o PDF da contabilidade (vários contracheques, um ou mais por página), o sistema confere o arquivo, extrai o texto por
// página (pdf-parse), descobre onde começa cada contracheque, identifica o funcionário no cadastro do PontoCerto (matrícula → CPF →
// nome, considerando unidade, situação e id permanente), separa um PDF por contracheque (pdf-lib, páginas copiadas sem reescrever o
// conteúdo) e apresenta pra conferência. Aprovar = arquivar o PDF individual na pasta 08 do prontuário (lib/gestao-documental.js).
// NÃO há envio de e-mail nem assinatura nesta fase. CPD e Diretoria não acessam. Nada aqui registra salário ou CPF inteiro em log.
// Dados: data/gestao-documental/contracheques/remessas/<REM>.json · arquivos/contracheques/<REM>/original.pdf e doc-<n>.pdf.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const GP = require('./gestao-pessoas');
const D = require('./gestao-documental');

const RAIZ = () => path.join(D.DIR, 'contracheques');
const P = { rems: () => path.join(RAIZ(), 'remessas'), rem: r => path.join(RAIZ(), 'remessas', r + '.json'), dir: r => path.join(D.DIR, 'arquivos', 'contracheques', r), original: r => path.join(D.DIR, 'arquivos', 'contracheques', r, 'original.pdf'), doc: (r, n) => path.join(D.DIR, 'arquivos', 'contracheques', r, 'doc-' + n + '.pdf'), tmp: () => path.join(RAIZ(), '_tmp') };
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400 }, extra || {});
const agoraIso = () => new Date().toISOString();
const txt = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max || 500);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const dig = s => String(s || '').replace(/\D/g, '');
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const compOk = c => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || ''));
const compTxt = c => c ? c.slice(5) + '/' + c.slice(0, 4) : '—';
const ultimoDia = c => { const [a, m] = c.split('-').map(Number); return c + '-' + String(new Date(a, m, 0).getDate()).padStart(2, '0'); };
const lojaTxt = n => GP.LOJA_TXT[n] || ('Loja ' + n);

// ── Catálogos ────────────────────────────────────────────────────────────────
const TIPOS = { adiantamento: 'Adiantamento Salarial', mensal: 'Folha Mensal' };
const TIPO_DOC = { adiantamento: 'Recibo de adiantamento', mensal: 'Contracheque' };   // tipo na pasta 08 do prontuário
const IDENT_TXT = { confirmada: 'Confirmada', pendente: 'Identificação pendente', ambigua: 'Identificação pendente (ambígua)', nao_localizado: 'Identificação pendente (não localizado)' };
const CONF_TXT = { aguardando: 'Aguardando conferência', aprovado: 'Aprovado e arquivado', retirado: 'Retirado da remessa' };
const REM_TXT = { importada: 'Importada', processando: 'Processando', conferencia: 'Em conferência', revisao_manual: 'Revisão manual (PDF sem texto)', concluida: 'Concluída', erro: 'Erro no processamento' };
const BLOQ_TXT = { nao_identificado: 'Funcionário não identificado', ambigua: 'Mais de um funcionário possível', nome_so: 'Identificado só pelo nome — confirmar matrícula', matricula_sem_nome: 'Matrícula encontrada, mas o nome não confere', desligado: 'Funcionário desligado no cadastro', outra_unidade: 'Funcionário cadastrado em outra unidade (transferência?)', competencia: 'Competência do documento diferente da remessa', tipo: 'Tipo de folha do documento diferente da remessa', sem_texto: 'Página sem texto legível (digitalização?)', repetido: 'Mesmo funcionário em mais de um documento da remessa', duas_pessoas: 'Mais de um nome na mesma página' };
const MESES = { JANEIRO: '01', FEVEREIRO: '02', MARCO: '03', ABRIL: '04', MAIO: '05', JUNHO: '06', JULHO: '07', AGOSTO: '08', SETEMBRO: '09', OUTUBRO: '10', NOVEMBRO: '11', DEZEMBRO: '12' };
const MAX_MB = 60, MAX_PAG = 3000;

// ── Permissões: só RH (e Coordenação/admin); CPD e Diretoria nunca ──────────
function perm(user) { const p = D.permissoes(user); return { ...p, ver: p.rh || p.coord, operar: p.rh }; }
function exige(user, operar) { const p = perm(user); if (!(operar ? p.operar : p.ver)) throw erro(operar ? 'Só o RH opera a Gestão de Contracheques' : 'Contracheques: acesso restrito ao RH e à Coordenação', 403, { naoAutorizado: true }); return p; }
const veDoc = (user, p, d) => !d.colab || D.veLoja(user, d.colab.loja, p);
function veRem(user, p, r) { return r.loja ? D.veLoja(user, r.loja, p) : true; }
function auditar(user, acao, ref, extra) { D.auditar(user, acao, ref, extra); }

// ── Remessas ─────────────────────────────────────────────────────────────────
let remMem = null;
function rems() { if (!remMem) { remMem = new Map(); let fs_ = []; try { fs_ = fs.readdirSync(P.rems()).filter(f => f.endsWith('.json')); } catch (e) {} for (const f of fs_) { const r = lerJson(path.join(P.rems(), f), null); if (r && r.protocolo) remMem.set(r.protocolo, r); } } return remMem; }
function obter(prot) { const r = rems().get(String(prot || '').toUpperCase().trim()); if (!r) throw erro('Remessa não encontrada', 404); return r; }
function gravar(r) { r.atualizadoEm = agoraIso(); gravarJson(P.rem(r.protocolo), r); rems().set(r.protocolo, r); return r; }
function novoProtocolo() { const ano = new Date().getFullYear(); const n = [...rems().keys()].filter(k => k.startsWith('REM-' + ano + '-')).reduce((m, k) => Math.max(m, +k.split('-')[2] || 0), 0) + 1; return 'REM-' + ano + '-' + String(n).padStart(4, '0'); }
function hist(r, user, acao, texto, extra) { (r.historico = r.historico || []).push({ em: agoraIso(), usuario: user.usuario, nome: user.nome || user.usuario, acao, texto: txt(texto, 300) || undefined, ...(extra || {}) }); }

// ── Leitura do PDF ───────────────────────────────────────────────────────────
function validarPdf(buf) {
  if (!buf || buf.length < 100) throw erro('Arquivo vazio ou corrompido');
  if (buf.length > MAX_MB * 1024 * 1024) throw erro('PDF maior que ' + MAX_MB + ' MB');
  if (buf.slice(0, 5).toString() !== '%PDF-') throw erro('O arquivo não é um PDF válido');
  if (/\/Encrypt\b/.test(buf.slice(-4096).toString('latin1')) && !/\/Encrypt\b/.test('')) { /* checado de verdade no pdf-lib (abaixo) */ }
}
async function abrirPdf(buf) {
  const { PDFDocument } = require('pdf-lib');
  let doc; try { doc = await PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false }); } catch (e) { if (/encrypted/i.test(e.message)) throw erro('PDF protegido por senha — peça à contabilidade o arquivo sem proteção'); throw erro('Não consegui abrir o PDF: ' + e.message); }
  const n = doc.getPageCount(); if (!n) throw erro('PDF sem páginas'); if (n > MAX_PAG) throw erro('PDF com mais de ' + MAX_PAG + ' páginas');
  return doc;
}
async function textoPorPagina(buf) {
  const { PDFParse } = require('pdf-parse'); let r;
  try { r = await new PDFParse({ data: buf }).getText(); } catch (e) { throw erro('Não consegui extrair o texto do PDF: ' + e.message); }
  return (r.pages || []).map(p => ({ num: p.num, texto: String(p.text || '') }));
}
// O que uma página diz: nomes em maiúsculas perto de um rótulo de nome, matrícula (antes de "Código"/depois de "Matrícula"), CPF, competência, tipo
const RE_CPF = /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/g;
const NAO_NOME = /^(LTDA|EIRELI|ME|EPP|SUPERMERCADO|SUPERMERCADOS|ECONOMICO|ATACAREJO|DISTRIBUIDORA|COMERCIO|ALIMENTOS|CNPJ|CPF|EMPRESA|FILIAL|LOJA|RECIBO|PAGAMENTO|CONTRACHEQUE|HOLERITE|DEMONSTRATIVO|SALARIO|SALARIAL|HORAS|MENSAL|ADIANTAMENTO|FOLHA|CODIGO|DESCRICAO|REFERENCIA|VENCIMENTOS|DESCONTOS|LIQUIDO|TOTAL|VALOR|BASE|INSS|IRRF|FGTS|FUNCAO|CARGO|SETOR|DEPARTAMENTO|ADMISSAO|COMPETENCIA|NOME|FUNCIONARIO|COLABORADOR|EMPREGADO|MATRICULA|REGISTRO|DATA|VIA|CAHU|MURIBECA|PONTE|SOCORRO|JABOATAO)$/;
const RE_NOME_MAIUSC = /^[A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`.]+(?:\s+(?:D[AEIO]S?|E|[A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`.]+)){1,9}$/;
function limparNome(n) { const ws = []; for (const w of String(n).trim().split(/\s+/)) { if (NAO_NOME.test(semAcento(w))) break; ws.push(w); } while (ws.length && /^(D[AEIO]S?|E)$/i.test(ws[ws.length - 1])) ws.pop(); const out = ws.join(' '); return ws.length >= 2 && semAcento(out).replace(/[^A-Z]/g, '').length >= 5 ? out.toUpperCase() : null; }
function lerPagina(texto) {
  const L = String(texto || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean); const todo = L.join('\n');
  const nomes = []; let matricula = '', cpf = '';
  const addNome = n => { const c = limparNome(n); if (c && !nomes.includes(c)) nomes.push(c); };
  L.forEach((l, i) => {
    // rótulo DEPOIS do valor (formato do sistema de folha do Econômico): linha anterior é o nome / a matrícula
    if (/^Nome(?: do (?:Funcion[áa]rio|Colaborador|Empregado))?$/i.test(l) && i > 0) addNome(L[i - 1].replace(/\s*\(.*\)\s*$/, ''));
    if (/^(C[óo]digo|Matr[íi]cula|Registro)$/i.test(l) && i > 0 && /^0*\d{1,7}$/.test(L[i - 1]) && !matricula) matricula = L[i - 1].replace(/^0+(?=\d)/, '');
    // rótulo ANTES do valor ("Nome: FULANO", "Matrícula: 158", "Funcionário: 158 - FULANO")
    const rn = l.match(/(?:Nome(?: do (?:Funcion[áa]rio|Colaborador|Empregado))?|Funcion[áa]rio|Colaborador|Empregado)\s*[:.]\s*(?:0*(\d{1,7})\s*[-–]\s*)?([A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`. ]{4,})/i); if (rn) { addNome(rn[2]); if (rn[1] && !matricula) matricula = rn[1].replace(/^0+(?=\d)/, ''); }
    const rm = l.match(/(?:Matr[íi]cula|Matr\.|Registro|C[óo]d\.?\s*Func(?:ion[áa]rio)?|C[óo]digo)\s*[:.]\s*0*(\d{1,7})\b/i); if (rm && !matricula) matricula = rm[1].replace(/^0+(?=\d)/, '');
  });
  const cm = todo.match(RE_CPF); if (cm) { const c = dig(cm[0]); if (c.length === 11) cpf = c; }
  const mc = semAcento(todo).match(/\b(JANEIRO|FEVEREIRO|MARCO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO)\s*(?:DE|\/)?\s*(\d{4})\b/) || semAcento(todo).match(/COMPET[EÊ]NCIA\s*[:.]?\s*(\d{2})\/(\d{4})/);
  const competencia = mc ? (MESES[mc[1]] ? mc[2] + '-' + MESES[mc[1]] : mc[2] + '-' + mc[1]) : null;
  const t = semAcento(todo); const tipo = /ADIANTAMENTO\s+(SALARIAL|DE\s+SALARIO|QUINZENAL)|RECIBO\s+DE\s+ADIANTAMENTO/.test(t) && !/FOLHA\s+MENSAL|RECIBO\s+MENSAL/.test(t) ? 'adiantamento' : /FOLHA\s+MENSAL|RECIBO\s+MENSAL|RECIBO\s+DE\s+PAGAMENTO|CONTRACHEQUE|HOLERITE|DEMONSTRATIVO\s+DE\s+PAGAMENTO/.test(t) ? 'mensal' : null;
  const chave = matricula ? 'm' + matricula : cpf ? 'c' + cpf : nomes[0] ? 'n' + semAcento(nomes[0]) : null;
  return { nomes, matricula, cpf, competencia, tipo, chave, temTexto: todo.replace(/\s/g, '').length >= 25, duasPessoas: nomes.length > 1 };
}
// Agrupa páginas em documentos: página com identidade nova começa um documento; mesma identidade em sequência ou página sem identidade = continuação.
function agrupar(paginas) {
  const docs = []; let atual = null;
  for (const p of paginas) {
    const inicia = p.chave && (!atual || atual.chave !== p.chave);
    if (inicia) { atual = { n: docs.length + 1, chave: p.chave, paginas: [p.num], nomes: [...p.nomes], matricula: p.matricula, cpf: p.cpf, competencia: p.competencia, tipo: p.tipo, avisos: [] }; if (p.duasPessoas) atual.avisos.push('duas_pessoas'); docs.push(atual); continue; }
    if (!atual) { atual = { n: docs.length + 1, chave: null, paginas: [p.num], nomes: [...p.nomes], matricula: p.matricula, cpf: p.cpf, competencia: p.competencia, tipo: p.tipo, avisos: [] }; docs.push(atual); }
    else atual.paginas.push(p.num);
    if (!p.temTexto) atual.avisos.push('sem_texto'); for (const n of p.nomes) if (!atual.nomes.includes(n)) atual.nomes.push(n); if (!atual.competencia) atual.competencia = p.competencia; if (!atual.tipo) atual.tipo = p.tipo; if (!atual.cpf) atual.cpf = p.cpf;
  }
  return docs;
}

// ── Identificação no cadastro (matrícula → CPF → nome; unidade, situação, id permanente) ──
function nomeBate(a, b) { const A = semAcento(a).split(' ').filter(w => w.length > 2), B = semAcento(b).split(' ').filter(w => w.length > 2); if (!A.length || !B.length || A[0] !== B[0]) return false; return A.filter(w => B.includes(w)).length >= Math.min(3, A.length, B.length); }
const foto = c => ({ id: c.id, nome: c.nome, matricula: c.matricula || '', loja: +c.loja, cargo: c.cargo || '', setor: c.setor || '', ativo: !!c.ativo, desligamento: c.desligamento || null });
async function cadastro(deps) {
  const col = await deps.colaboradores(); const todos = [...col.ativos, ...col.desligados];
  const porMat = new Map(); for (const c of todos) { if (c.matricula) { const k = String(c.matricula).replace(/^0+(?=\d)/, ''); if (!porMat.has(k)) porMat.set(k, []); porMat.get(k).push(c); } }
  const porCpf = new Map(); if (deps.cpfDe) for (const c of todos) { let cpf = ''; try { cpf = await deps.cpfDe(c.id); } catch (e) {} if (cpf) porCpf.set(cpf, c); }
  return { todos, porMat, porCpf };
}
function identificarDoc(d, cad, rem) {
  const nome = d.nomes[0] || ''; let c = null, por = null, cands = [], bloq = [];
  if (d.cpf && cad.porCpf.has(d.cpf)) { c = cad.porCpf.get(d.cpf); por = 'cpf'; }
  if (!c && d.matricula && cad.porMat.has(d.matricula)) {
    const ms = cad.porMat.get(d.matricula); const batem = nome ? ms.filter(x => nomeBate(x.nome, nome)) : [];
    if (batem.length === 1) { c = batem[0]; por = 'matricula'; } else if (batem.length > 1) { cands = batem; bloq.push('ambigua'); } else if (ms.length === 1 && !nome) { c = ms[0]; por = 'matricula'; } else { cands = ms; bloq.push('matricula_sem_nome'); }
  }
  if (!c && !cands.length && nome) {
    const exatos = cad.todos.filter(x => semAcento(x.nome) === semAcento(nome)); const prox = exatos.length ? exatos : cad.todos.filter(x => nomeBate(x.nome, nome));
    if (prox.length === 1) { cands = prox; bloq.push('nome_so'); } else if (prox.length > 1) { cands = prox; bloq.push('ambigua'); }
  }
  const alvo = c || (cands.length === 1 ? cands[0] : null);
  if (alvo) { if (!alvo.ativo) bloq.push('desligado'); if (rem.loja && +alvo.loja !== +rem.loja) bloq.push('outra_unidade'); }
  if (d.competencia && d.competencia !== rem.competencia) bloq.push('competencia'); if (d.tipo && d.tipo !== rem.tipo) bloq.push('tipo');
  for (const a of d.avisos) if (!bloq.includes(a)) bloq.push(a);
  if (!c && !cands.length) bloq.unshift('nao_identificado');
  const ident = c && !bloq.length ? 'confirmada' : !c && !cands.length ? 'nao_localizado' : cands.length > 1 ? 'ambigua' : 'pendente';
  return { colab: alvo ? foto(alvo) : null, identPor: c ? por : null, candidatos: cands.slice(0, 8).map(foto), ident, bloqueios: [...new Set(bloq)] };
}

// ── Importar + processar ─────────────────────────────────────────────────────
async function importar(user, body, file, deps) {
  const p = exige(user, true); const b = body || {};
  const tipo = String(b.tipo || ''); if (!TIPOS[tipo]) throw erro('Tipo de folha: Adiantamento Salarial ou Folha Mensal');
  const competencia = String(b.competencia || ''); if (!compOk(competencia)) throw erro('Competência inválida (AAAA-MM)');
  const loja = b.loja ? +b.loja : null; if (loja && !GP.LOJAS.includes(loja)) throw erro('Unidade inválida'); if (loja && !D.veLoja(user, loja, p)) throw erro('Unidade fora do seu escopo', 403);
  if (!file || !file.path) throw erro('Anexe o PDF da folha');
  const buf = fs.readFileSync(file.path); validarPdf(buf); const hash = sha256(buf);
  const igual = [...rems().values()].find(r => r.arquivo && r.arquivo.hash === hash && r.status !== 'erro');
  if (igual && !(b.confirmarDuplicado === true || String(b.confirmarDuplicado) === '1')) throw erro('Este PDF já foi importado na remessa ' + igual.protocolo + ' (' + TIPOS[igual.tipo] + ' ' + compTxt(igual.competencia) + '). Confirme se quer importar de novo.', 409, { duplicadoDe: igual.protocolo });
  const pdf = await abrirPdf(buf); const paginas = pdf.getPageCount();
  const r = { protocolo: novoProtocolo(), tipo, competencia, loja, observacoes: txt(b.observacoes, 500) || null, status: 'importada', por: { usuario: user.usuario, nome: user.nome || user.usuario }, criadoEm: agoraIso(),
    arquivo: { nome: String(file.originalname || 'folha.pdf').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120), tamanho: buf.length, paginas, hash, caminho: null }, reimportacaoDe: igual ? igual.protocolo : null, processamento: null, docs: [], historico: [] };
  fs.mkdirSync(P.dir(r.protocolo), { recursive: true }); fs.writeFileSync(P.original(r.protocolo), buf); r.arquivo.caminho = path.relative(D.DIR, P.original(r.protocolo)).split(path.sep).join('/'); try { fs.unlinkSync(file.path); } catch (e) {}
  hist(r, user, 'importar', r.arquivo.nome + ' · ' + paginas + ' página(s)'); gravar(r);
  auditar(user, 'cc_importar', r.protocolo, { loja, detalhe: TIPOS[tipo] + ' ' + compTxt(competencia) + ' · ' + r.arquivo.nome + ' · ' + paginas + ' pág · ' + Math.round(buf.length / 1024) + ' KB · sha256 ' + hash.slice(0, 12) });
  const promessa = processar(r.protocolo, user, deps);
  if (b.aguardar) await promessa;
  return resumoRem(r, user);
}
const emProcessamento = new Map();   // protocolo → { passo, texto }
async function processar(prot, user, deps) {
  const r = obter(prot); const passo = (n, t) => { emProcessamento.set(prot, { passo: n, texto: t }); };
  r.status = 'processando'; r.processamento = { inicio: agoraIso(), fim: null, erro: null }; gravar(r); auditar(user, 'cc_processar_inicio', prot, { loja: r.loja, detalhe: r.arquivo.nome });
  try {
    passo(1, 'Conferindo o PDF'); const buf = fs.readFileSync(P.original(prot)); if (sha256(buf) !== r.arquivo.hash) throw erro('O arquivo original foi alterado depois da importação'); const pdf = await abrirPdf(buf);
    passo(2, 'Extraindo o texto das páginas'); const pags = (await textoPorPagina(buf)).map(pg => ({ num: pg.num, ...lerPagina(pg.texto) }));
    const comTexto = pags.filter(pg => pg.temTexto).length;
    if (!comTexto) { r.status = 'revisao_manual'; r.processamento.fim = agoraIso(); r.processamento.erro = 'O PDF não tem texto pesquisável (digitalização). Peça à contabilidade o PDF gerado pelo sistema de folha ou trate manualmente.'; r.docs = []; hist(r, user, 'processar', r.processamento.erro); gravar(r); auditar(user, 'cc_processar_fim', prot, { loja: r.loja, detalhe: 'sem texto pesquisável · revisão manual' }); return; }
    passo(3, 'Separando os contracheques'); const grupos = agrupar(pags);
    passo(4, 'Identificando os funcionários'); const cad = await cadastro(deps);
    const { PDFDocument } = require('pdf-lib'); const vistos = new Map(); const docs = [];
    for (const g of grupos) {
      const id = identificarDoc(g, cad, r);
      const k = id.colab ? 'id' + id.colab.id : g.chave; if (k && vistos.has(k)) { id.bloqueios.push('repetido'); if (id.ident === 'confirmada') id.ident = 'pendente'; const ant = docs[vistos.get(k) - 1]; if (ant && !ant.bloqueios.includes('repetido')) { ant.bloqueios.push('repetido'); if (ant.ident === 'confirmada') ant.ident = 'pendente'; } } else if (k) vistos.set(k, g.n);
      passo(5, 'Gerando o PDF individual ' + g.n + '/' + grupos.length);
      const novo = await PDFDocument.create(); const copiadas = await novo.copyPages(pdf, g.paginas.map(n => n - 1)); copiadas.forEach(pg => novo.addPage(pg)); novo.setTitle(TIPO_DOC[r.tipo] + ' ' + compTxt(r.competencia)); novo.setSubject('Remessa ' + prot + ' · origem ' + r.arquivo.nome + ' · página(s) ' + g.paginas.join(', ')); novo.setProducer('Gestão Documental · Econômico'); novo.setCreationDate(new Date()); novo.setModificationDate(new Date()); const out = Buffer.from(await novo.save({ useObjectStreams: false }));
      fs.writeFileSync(P.doc(prot, g.n), out);
      docs.push({ n: g.n, paginas: g.paginas, nomeLido: g.nomes[0] || null, matriculaLida: g.matricula || null, cpfFim: g.cpf ? g.cpf.slice(-4) : null, competenciaLida: g.competencia, tipoLido: g.tipo, colab: id.colab, identPor: id.identPor, candidatos: id.candidatos, ident: id.ident, bloqueios: id.bloqueios, conferencia: 'aguardando', arquivo: { nome: (TIPO_DOC[r.tipo] + '-' + r.competencia + '-' + (id.colab ? id.colab.matricula || id.colab.id : 'doc' + g.n) + '.pdf').replace(/\s+/g, '_'), tamanho: out.length, hash: sha256(out) }, aprovadoPor: null, aprovadoEm: null, documento: null, retirada: null, vinculadoPor: null, historico: [] });
    }
    r.docs = docs; r.status = 'conferencia'; r.processamento.fim = agoraIso(); r.processamento.erro = null;
    hist(r, user, 'processar', docs.length + ' contracheque(s) separados · ' + docs.filter(d => d.ident === 'confirmada').length + ' identificados · ' + docs.filter(d => d.ident !== 'confirmada').length + ' pendente(s)'); gravar(r);
    auditar(user, 'cc_processar_fim', prot, { loja: r.loja, detalhe: docs.length + ' documento(s) · ' + docs.filter(d => d.ident === 'confirmada').length + ' identificados · ' + docs.filter(d => d.ident !== 'confirmada').length + ' pendentes' });
  } catch (e) { r.status = 'erro'; r.processamento.fim = agoraIso(); r.processamento.erro = e.message; hist(r, user, 'processar', 'ERRO: ' + e.message); gravar(r); auditar(user, 'cc_processar_fim', prot, { loja: r.loja, detalhe: 'ERRO: ' + e.message }); }
  finally { emProcessamento.delete(prot); }
}
function statusProcessamento(prot) { return emProcessamento.get(prot) || null; }

// ── Conferência ──────────────────────────────────────────────────────────────
function docDe(r, n) { const d = (r.docs || []).find(x => x.n === +n); if (!d) throw erro('Documento não encontrado na remessa', 404); return d; }
function histDoc(d, user, acao, texto) { (d.historico = d.historico || []).push({ em: agoraIso(), usuario: user.usuario, nome: user.nome || user.usuario, acao, texto: txt(texto, 300) || undefined }); }
const abertoCheck = d => { if (d.conferencia !== 'aguardando') throw erro('Documento já ' + CONF_TXT[d.conferencia].toLowerCase(), 409); };
async function vincular(prot, n, user, body, deps) {
  const p = exige(user, true); const r = obter(prot); if (!veRem(user, p, r)) throw erro('Remessa fora do seu escopo', 403); const d = docDe(r, n); abertoCheck(d);
  const b = body || {}; const id = b.colabId || (d.colab && d.colab.id); if (!id) throw erro('Escolha o funcionário');
  if (!(b.confirmado === true || String(b.confirmado) === '1')) throw erro('Confirme que o documento, a matrícula e o funcionário conferem');
  const c = await D.colab(id, deps); if (!D.veLoja(user, c.loja, p)) throw erro('Funcionário fora das unidades que você atende', 403);
  const anterior = d.colab ? d.colab.nome : '—'; d.colab = foto(c); d.ident = 'confirmada'; d.identPor = 'manual'; d.candidatos = []; d.bloqueios = []; d.vinculadoPor = { usuario: user.usuario, nome: user.nome || user.usuario, em: agoraIso(), justificativa: txt(b.justificativa, 300) || null };
  d.arquivo.nome = (TIPO_DOC[r.tipo] + '-' + r.competencia + '-' + (c.matricula || c.id) + '.pdf').replace(/\s+/g, '_');
  histDoc(d, user, 'vincular', (anterior !== c.nome ? anterior + ' → ' : '') + c.nome + (b.justificativa ? ' · ' + b.justificativa : '')); gravar(r);
  auditar(user, 'cc_vincular', prot, { loja: c.loja, colab: c.id, detalhe: 'doc ' + n + ' · ' + c.nome + (anterior !== c.nome ? ' (antes: ' + anterior + ')' : '') }); return resumoDoc(r, d, user);
}
function retirar(prot, n, user, body) {
  const p = exige(user, true); const r = obter(prot); if (!veRem(user, p, r)) throw erro('Remessa fora do seu escopo', 403); const d = docDe(r, n); abertoCheck(d);
  const motivo = txt(body && body.motivo, 300); if (motivo.length < 3) throw erro('Informe o motivo');
  d.conferencia = 'retirado'; d.retirada = { por: { usuario: user.usuario, nome: user.nome || user.usuario }, em: agoraIso(), motivo }; histDoc(d, user, 'retirar', motivo); fecharSeConcluida(r); gravar(r);
  auditar(user, 'cc_retirar', prot, { loja: r.loja, colab: d.colab ? d.colab.id : null, detalhe: 'doc ' + n + ' · ' + (d.colab ? d.colab.nome : d.nomeLido || '?') + ' · ' + motivo }); return resumoDoc(r, d, user);
}
function podeAprovar(d) { return d.conferencia === 'aguardando' && d.ident === 'confirmada' && !!d.colab && !d.bloqueios.length; }
async function aprovar(prot, n, user, body, deps) {
  const p = exige(user, true); const r = obter(prot); if (!veRem(user, p, r)) throw erro('Remessa fora do seu escopo', 403); const d = docDe(r, n); abertoCheck(d);
  if (!podeAprovar(d)) throw erro('Documento não pode ser aprovado: ' + (d.ident !== 'confirmada' || !d.colab ? 'identificação pendente' : d.bloqueios.map(x => BLOQ_TXT[x] || x).join('; ')), 409);
  // duplicidade no prontuário (mesma competência e tipo): decisão do RH
  const jaTem = D.listar(user, { colab: d.colab.id, categoria: '08', status: 'arquivado' }).filter(x => x.tipo === TIPO_DOC[r.tipo] && x.competencia === r.competencia);
  if (jaTem.length && !(body && (body.manterAmbos === true || String(body.manterAmbos) === '1'))) throw erro('Já existe ' + TIPO_DOC[r.tipo].toLowerCase() + ' de ' + compTxt(r.competencia) + ' no prontuário de ' + d.colab.nome + ' (' + jaTem[0].protocolo + '). Decida: manter ambos ou retirar este da remessa.', 409, { duplicadoDe: jaTem[0].protocolo });
  const f = P.doc(prot, d.n); if (!fs.existsSync(f)) throw erro('PDF individual não está mais no servidor', 410);
  fs.mkdirSync(P.tmp(), { recursive: true }); const tmp = path.join(P.tmp(), crypto.randomBytes(8).toString('hex') + '.pdf'); fs.copyFileSync(f, tmp);
  const doc = await D.importar(user, { colabId: d.colab.id, categoria: '08', tipo: TIPO_DOC[r.tipo], dataDocumento: ultimoDia(r.competencia) > new Date().toISOString().slice(0, 10) ? new Date().toISOString().slice(0, 10) : ultimoDia(r.competencia), competencia: r.competencia, origem: 'contabilidade', observacoes: 'Remessa ' + r.protocolo + ' · arquivo original ' + r.arquivo.nome + ' · página(s) ' + d.paginas.join(', ') + (jaTem.length ? ' · mantido junto com ' + jaTem[0].protocolo + ' por decisão do RH' : ''), confirmado: true }, { path: tmp, originalname: d.arquivo.nome, mimetype: 'application/pdf', size: d.arquivo.tamanho }, deps);
  d.conferencia = 'aprovado'; d.aprovadoPor = { usuario: user.usuario, nome: user.nome || user.usuario }; d.aprovadoEm = agoraIso(); d.documento = doc.protocolo; d.assinatura = 'nao_solicitada'; histDoc(d, user, 'aprovar', 'arquivado como ' + doc.protocolo); fecharSeConcluida(r); gravar(r);
  auditar(user, 'cc_aprovar', prot, { loja: d.colab.loja, colab: d.colab.id, detalhe: 'doc ' + n + ' · ' + d.colab.nome + ' · arquivado ' + doc.protocolo }); return resumoDoc(r, d, user);
}
async function aprovarLote(prot, user, body, deps) {
  const p = exige(user, true); const r = obter(prot); if (!veRem(user, p, r)) throw erro('Remessa fora do seu escopo', 403);
  const ns = Array.isArray(body && body.ns) && body.ns.length ? body.ns.map(Number) : r.docs.filter(podeAprovar).map(d => d.n);
  const aptos = ns.map(n => docDe(r, n)).filter(d => podeAprovar(d) && veDoc(user, p, d));
  if (body && body.quantidade != null && +body.quantidade !== aptos.length) throw erro('A quantidade confirmada (' + body.quantidade + ') não bate com os documentos aptos agora (' + aptos.length + '). Atualize e confirme de novo.', 409, { aptos: aptos.length });
  const out = []; for (const d of aptos) { try { await aprovar(prot, d.n, user, {}, deps); out.push({ n: d.n, ok: true, documento: d.documento }); } catch (e) { out.push({ n: d.n, ok: false, erro: e.message, duplicadoDe: e.duplicadoDe }); } }
  return { aprovados: out.filter(x => x.ok).length, pulados: out.filter(x => !x.ok).length, itens: out };
}
function fecharSeConcluida(r) { if (r.docs.length && r.docs.every(d => d.conferencia !== 'aguardando')) r.status = 'concluida'; else if (r.status === 'concluida') r.status = 'conferencia'; }

// ── Consultas ────────────────────────────────────────────────────────────────
function resumoDoc(r, d, user) {
  return { n: d.n, remessa: r.protocolo, paginas: d.paginas, nPaginas: d.paginas.length, nomeLido: d.nomeLido, matriculaLida: d.matriculaLida, cpfFim: d.cpfFim, competenciaLida: d.competenciaLida, tipoLido: d.tipoLido, colab: d.colab, lojaTxt: d.colab ? lojaTxt(d.colab.loja) : null, identPor: d.identPor, candidatos: d.candidatos || [], ident: d.ident, identTxt: IDENT_TXT[d.ident], bloqueios: d.bloqueios || [], bloqueiosTxt: (d.bloqueios || []).map(b => BLOQ_TXT[b] || b), conferencia: d.conferencia, conferenciaTxt: CONF_TXT[d.conferencia], podeAprovar: podeAprovar(d), arquivo: d.arquivo, aprovadoPor: d.aprovadoPor, aprovadoEm: d.aprovadoEm, documento: d.documento, assinatura: 'nao_solicitada', assinaturaTxt: 'Ainda não solicitada', retirada: d.retirada, vinculadoPor: d.vinculadoPor, historico: d.historico || [], competencia: r.competencia, tipo: r.tipo, tipoTxt: TIPOS[r.tipo] };
}
function resumoRem(r, user, comDocs) {
  const p = perm(user); const docs = (r.docs || []).filter(d => veDoc(user, p, d)); const n = f => docs.filter(f).length;
  return { protocolo: r.protocolo, tipo: r.tipo, tipoTxt: TIPOS[r.tipo], competencia: r.competencia, competenciaTxt: compTxt(r.competencia), loja: r.loja, lojaTxt: r.loja ? lojaTxt(r.loja) : 'Toda a rede', observacoes: r.observacoes, status: r.status, statusTxt: REM_TXT[r.status], por: r.por, criadoEm: r.criadoEm, arquivo: { ...r.arquivo, caminho: undefined }, reimportacaoDe: r.reimportacaoDe, processamento: r.processamento, andamento: statusProcessamento(r.protocolo),
    totais: { docs: docs.length, identificados: n(d => d.ident === 'confirmada'), pendentes: n(d => d.conferencia === 'aguardando' && d.ident !== 'confirmada'), aguardando: n(d => d.conferencia === 'aguardando'), aptos: n(podeAprovar), aprovados: n(d => d.conferencia === 'aprovado'), retirados: n(d => d.conferencia === 'retirado'), bloqueados: n(d => d.conferencia === 'aguardando' && d.bloqueios.length) },
    docs: comDocs ? docs.map(d => resumoDoc(r, d, user)) : undefined, historico: comDocs ? r.historico : undefined };
}
function listar(user, q = {}) { const p = exige(user, false); return [...rems().values()].filter(r => veRem(user, p, r) && (!q.competencia || r.competencia === q.competencia) && (!q.tipo || r.tipo === q.tipo) && (!q.loja || +r.loja === +q.loja || (!r.loja && r.docs.some(d => d.colab && +d.colab.loja === +q.loja))) && (!q.status || r.status === q.status)).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)).map(r => resumoRem(r, user)); }
function detalhe(prot, user) { const p = exige(user, false); const r = obter(prot); if (!veRem(user, p, r)) throw erro('Remessa fora do seu escopo', 403); return resumoRem(r, user, true); }
function arquivo(prot, n, user, download) {
  const p = exige(user, false); const r = obter(prot); if (!veRem(user, p, r)) throw erro('Remessa fora do seu escopo', 403);
  if (n === 'original') { const f = P.original(prot); if (!fs.existsSync(f)) throw erro('Arquivo original não está mais no servidor', 410); auditar(user, download ? 'cc_baixar' : 'cc_ver', prot, { loja: r.loja, detalhe: 'PDF original ' + r.arquivo.nome }); return { caminho: f, nome: r.arquivo.nome }; }
  const d = docDe(r, n); if (!veDoc(user, p, d)) throw erro('Documento fora do seu escopo', 403); const f = P.doc(prot, d.n); if (!fs.existsSync(f)) throw erro('PDF individual não está mais no servidor', 410);
  auditar(user, download ? 'cc_baixar' : 'cc_ver', prot, { loja: d.colab ? d.colab.loja : r.loja, colab: d.colab ? d.colab.id : null, detalhe: 'doc ' + n + ' · ' + (d.colab ? d.colab.nome : d.nomeLido || 'não identificado') }); return { caminho: f, nome: d.arquivo.nome };
}
function painel(user, q = {}) {
  const p = exige(user, false); const L = [...rems().values()].filter(r => veRem(user, p, r) && (!q.competencia || r.competencia === q.competencia) && (!q.tipo || r.tipo === q.tipo));
  const docs = L.flatMap(r => r.docs.filter(d => veDoc(user, p, d) && (!q.loja || (d.colab ? +d.colab.loja === +q.loja : +r.loja === +q.loja))).map(d => ({ d, r }))); const n = f => docs.filter(x => f(x.d, x.r)).length;
  return { indicadores: { importados: n(() => true), identificados: n(d => d.ident === 'confirmada' || d.conferencia === 'aprovado'), pendentes: n(d => d.conferencia === 'aguardando'), aprovados: n(d => d.conferencia === 'aprovado'), arquivados: n(d => !!d.documento), divergencias: n(d => d.conferencia === 'aguardando' && (d.ident !== 'confirmada' || d.bloqueios.length)), retirados: n(d => d.conferencia === 'retirado'), remessasAbertas: L.filter(r => ['conferencia', 'processando', 'importada', 'revisao_manual'].includes(r.status)).length, assinatura: { aguardando: 0, assinados: 0, nota: 'Assinatura e envio ficam para a próxima fase' } },
    porLoja: GP.LOJAS.filter(l => D.veLoja(user, l, p)).map(l => { const X = docs.filter(x => x.d.colab ? +x.d.colab.loja === l : +x.r.loja === l); const c = f => X.filter(x => f(x.d)).length; return { loja: l, txt: lojaTxt(l), docs: X.length, identificados: c(d => d.ident === 'confirmada' || d.conferencia === 'aprovado'), pendentes: c(d => d.conferencia === 'aguardando'), aprovados: c(d => d.conferencia === 'aprovado') }; }),
    remessas: L.filter(r => r.status !== 'concluida').sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)).map(r => resumoRem(r, user)) };
}
function recarregar() { remMem = null; }

module.exports = { P, TIPOS, TIPO_DOC, IDENT_TXT, CONF_TXT, REM_TXT, BLOQ_TXT, perm, importar, processar, statusProcessamento, vincular, retirar, aprovar, aprovarLote, listar, detalhe, arquivo, painel, recarregar, obter, _util: { lerPagina, agrupar, identificarDoc, nomeBate, limparNome } };
