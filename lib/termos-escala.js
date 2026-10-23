'use strict';
// lib/termos-escala.js — Termos de Ciência de Escala de Trabalho aos Domingos e Feriados (DP / RH › Termos de Escala), 23/10/2026.
// O DP escolhe a loja, a data e o tipo (domingo/feriado), marca os funcionários ativos da loja (cadastro do PontoCerto) e o
// sistema gera UM PDF com um termo por página (A4), guarda o arquivo e registra a emissão. Reimpressão devolve o PDF
// original, nunca regenera. Nada aqui altera escala, banco de horas ou ponto.
//   data/termos-escala/emissoes.json   registro das emissões (CPF só mascarado; o inteiro fica só dentro do PDF)
//   data/termos-escala/pdf/<id>.pdf    arquivo emitido (imutável; correção = cancelar + emitir de novo)
//   data/termos-escala/config.json     texto do modelo (configurável, validação do jurídico)
// Permissões = designação da central de pessoas (lib/gestao-pessoas.js): RH emite/consulta/reimprime na(s) loja(s) dele;
// Coordenação consulta tudo, reimprime e cancela; Diretoria só consulta; Jurídico consulta e edita o modelo; gerente não entra.
const fs = require('fs'), path = require('path');
const PDFDocument = require('pdfkit');
const LOGO = require('./logo-economico');
const GP = require('./gestao-pessoas');
const E = require('./escalas');   // feriados nacionais + PE + municipais cadastrados em Escalas › Configurações

const DIR = process.env.TERMOS_DIR || path.join(__dirname, '..', 'data', 'termos-escala');
const P = { emissoes: path.join(DIR, 'emissoes.json'), config: path.join(DIR, 'config.json'), pdf: id => path.join(DIR, 'pdf', id + '.pdf') };
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400 }, extra || {});
const agoraIso = () => new Date().toISOString();
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const dataOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T12:00:00').getTime());
const dBR = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';
const dow = s => new Date(s + 'T12:00:00').getDay();
const DIA_TXT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const TIPO_TXT = { domingo: 'Domingo', feriado: 'Feriado' };
const cpfFmt = d => d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9);
const cpfMask = d => '***.***.' + d.slice(6, 9) + '-' + d.slice(9);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ── arquivos ──
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
let emMem = null;
function emissoes() { if (!emMem) emMem = lerJson(P.emissoes, []); return emMem; }
function salvarEmissoes() { gravarJson(P.emissoes, emMem); }

// ── modelo (texto configurável; {empresa} é substituído pelo nome da empresa em negrito) ──
const MODELO_PADRAO = {
  empresa: 'Econômico Supermercados',
  titulo: 'TERMO DE CIÊNCIA DE ESCALA DE TRABALHO\nAOS DOMINGOS E FERIADOS',
  declaracao: 'Declaro, para os devidos fins, que fui previamente comunicado(a) pela {empresa} acerca da minha escala de trabalho para a data e o tipo de escala especificados neste documento.\n\n' +
    'Declaro, ainda, estar ciente de que minha assinatura tem como finalidade exclusiva comprovar o recebimento da comunicação antecipada da escala, não representando renúncia a quaisquer direitos trabalhistas assegurados pela legislação vigente e pela Convenção Coletiva de Trabalho aplicável.',
  fundamentacao: 'Documento administrativo de comunicação de escala, elaborado com referência ao artigo 67 da Consolidação das Leis do Trabalho (CLT), aos artigos 6º e 6º-A da Lei nº 10.101/2000 e às disposições da Convenção Coletiva de Trabalho aplicável.',
  nota: 'A assinatura comprova exclusivamente a ciência da escala, não substituindo as exigências legais relativas ao trabalho aos domingos e feriados.',
  validadoJuridico: false, validadoPor: null, validadoEm: null, alteradoPor: null, alteradoEm: null
};
const CAMPOS_TEXTO = ['empresa', 'titulo', 'declaracao', 'fundamentacao', 'nota'];
function modelo() { return { ...MODELO_PADRAO, ...lerJson(P.config, {}) }; }
function salvarModelo(mud, user) {
  if (!permissoes(user).configurar) throw erro('Só a Coordenação Administrativa e o Jurídico alteram o modelo do termo', 403);
  const m = modelo(); let mudouTexto = false;
  for (const k of CAMPOS_TEXTO) if (typeof mud[k] === 'string') { const v = mud[k].replace(/\r/g, '').trim(); if (!v) throw erro('O campo "' + k + '" não pode ficar vazio'); if (v.length > 4000) throw erro('Texto de "' + k + '" grande demais'); if (v !== m[k]) { m[k] = v; mudouTexto = true; } }
  if (mudouTexto) { m.validadoJuridico = false; m.validadoPor = null; m.validadoEm = null; }   // texto mudou = precisa validar de novo
  if (typeof mud.validadoJuridico === 'boolean') { m.validadoJuridico = mud.validadoJuridico; m.validadoPor = mud.validadoJuridico ? user.nome || user.usuario : null; m.validadoEm = mud.validadoJuridico ? agoraIso() : null; }
  m.alteradoPor = user.nome || user.usuario; m.alteradoEm = agoraIso();
  gravarJson(P.config, m); GP.auditar({ usuario: user.usuario, acao: 'termo_escala_modelo', mudouTexto, validadoJuridico: m.validadoJuridico });
  return m;
}

// ── permissões ──
function permissoes(user) {
  const papeis = GP.papeisDe(user);
  const emitir = GP.temPapel(user, ...GP.RH), coord = GP.temPapel(user, 'coordenacao');
  return { papeis, emitir, ver: emitir || coord || GP.temPapel(user, 'diretoria', 'juridico'), reimprimir: emitir || coord, cancelar: emitir || coord, configurar: coord || GP.temPapel(user, 'juridico') };
}
function exigeLoja(user, loja) { const l = +loja; if (!GP.LOJAS.includes(l)) throw erro('Unidade inválida'); if (!GP.veLoja(user, l)) throw erro('Unidade fora do seu escopo', 403); return l; }

// ── data: dia da semana, feriado, sugestão de tipo ──
function infoData(data) {
  if (!dataOk(data)) throw erro('Data inválida (AAAA-MM-DD)');
  const d = dow(data), feriado = E.feriado(data), nomeFeriado = feriado ? E.nomeFeriado(data) : null;
  const sugestao = feriado ? 'feriado' : d === 0 ? 'domingo' : null;
  const avisos = [];
  if (!sugestao) avisos.push('A data cai numa ' + DIA_TXT[d] + ' e não está no calendário de feriados (nacionais, de Pernambuco e os municipais cadastrados em Escalas › Configurações). Confira antes de emitir.');
  if (data < hojeISO()) avisos.push('A data já passou: o termo é uma comunicação antecipada da escala.');
  return { data, diaSemana: d, diaSemanaTxt: DIA_TXT[d], domingo: d === 0, feriado, nomeFeriado, sugestao, avisos, passado: data < hojeISO() };
}

// ── funcionários da loja (cadastro do PontoCerto), já dizendo quem pode receber termo ──
async function funcionariosDaLoja(loja, deps) {
  const col = await deps.colaboradores();
  const lista = [];
  for (const c of col.ativos) {
    if (+c.loja !== +loja) continue;
    const cpf = await deps.cpfDe(c.id); const pend = [];
    if (!cpf) pend.push('sem CPF no PontoCerto'); if (!c.cargo) pend.push('sem função no PontoCerto'); if (!c.nome) pend.push('sem nome');
    lista.push({ id: c.id, nome: c.nome, cpf_fim: c.cpf_fim || (cpf ? cpfMask(cpf) : ''), cargo: c.cargo || '', setor: c.setor || '', turno: c.turno || '', admissao: c.admissao || null, situacao: 'Ativo', ok: !pend.length, pendencias: pend });
  }
  lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return { loja, lojaTxt: GP.LOJA_TXT[loja], funcionarios: lista, gerado_em: col.gerado_em };
}

// ── PDF ──
const A4 = { w: 595.28, h: 841.89 }, ML = 48, MR = 48, CW = A4.w - ML - MR;
const NAVY = '#14213D', SEC = '#E6ECF4', LINE = '#CFD7E2', INK = '#1B2030', GRAY = '#5A6372', WHITE = '#FFFFFF';
function secao(doc, y, titulo) { doc.rect(ML, y, CW, 20).fill(SEC); doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(titulo, ML + 10, y + 5.5, { width: CW - 20, lineBreak: false }); return y + 20; }
function linha(doc, y, rotulo, valor, opts) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(rotulo, ML + 10, y + 6, { width: 150, lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor(GRAY).text(':', ML + 165, y + 6, { lineBreak: false });
  if (typeof valor === 'function') valor(ML + 180, y + 6); else doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(valor, ML + 180, y + 6, { width: CW - 190, lineBreak: false });
  const h = (opts && opts.h) || 24; doc.moveTo(ML + 6, y + h).lineTo(ML + CW - 6, y + h).lineWidth(0.5).stroke(LINE); return y + h;
}
function caixa(doc, x, y, marcado, rotulo) {
  doc.rect(x, y - 1, 11, 11).lineWidth(0.9).stroke(NAVY);
  if (marcado) { doc.rect(x, y - 1, 11, 11).fill(NAVY); doc.moveTo(x + 2.3, y + 4.5).lineTo(x + 4.6, y + 7).lineTo(x + 8.8, y + 1.8).lineWidth(1.6).stroke(WHITE); }
  doc.font(marcado ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5).fillColor(INK).text(rotulo, x + 16, y, { lineBreak: false });
  return x + 16 + doc.widthOfString(rotulo) + 22;
}
/** parágrafo justificado com {empresa} em negrito-itálico (segmentos "continued" do pdfkit) */
function paragrafo(doc, texto, x, y, w, empresa) {
  const partes = texto.split('{empresa}'); doc.fontSize(10.5).fillColor(INK);
  partes.forEach((p, i) => {
    const ultimo = i === partes.length - 1;
    doc.font('Helvetica').text(p, i === 0 ? x : undefined, i === 0 ? y : undefined, { width: w, align: 'justify', lineGap: 2.5, continued: !ultimo });
    if (!ultimo) doc.font('Helvetica-BoldOblique').text(empresa, { width: w, align: 'justify', lineGap: 2.5, continued: true });
  });
  return doc.y;
}
function desenharTermo(doc, ctx, f, idx, total) {
  const m = ctx.modelo; let y = 38;
  // cabeçalho: logo vetorial + identificação do documento
  const hLogo = LOGO.desenhar(doc, ML, y, 112);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('DEPARTAMENTO PESSOAL', ML + 220, y + 10, { width: CW - 220, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(8.5).fillColor(GRAY);
  doc.text(m.empresa, ML + 220, y + 24, { width: CW - 220, align: 'right', lineBreak: false });
  doc.text((ctx.previa ? 'Prévia — documento não emitido' : 'Termo ' + ctx.id + ' · documento ' + (idx + 1) + ' de ' + total), ML + 220, y + 37, { width: CW - 220, align: 'right', lineBreak: false });
  doc.text((ctx.previa ? 'Gerado em ' : 'Emitido em ') + ctx.emitidoTxt + ' por ' + ctx.usuarioNome, ML + 220, y + 50, { width: CW - 220, align: 'right', lineBreak: false });
  y += hLogo + 10; doc.moveTo(ML, y).lineTo(ML + CW, y).lineWidth(1.5).stroke(NAVY); y += 14;
  // título
  const tit = m.titulo.split('\n').map(s => s.trim()).filter(Boolean); const hT = 14 + tit.length * 19;
  doc.rect(ML, y, CW, hT).fill(NAVY); doc.font('Helvetica-Bold').fontSize(14.5).fillColor(WHITE);
  tit.forEach((t, i) => doc.text(t, ML, y + 9 + i * 19, { width: CW, align: 'center', lineBreak: false })); y += hT + 16;
  // dados do colaborador
  y = secao(doc, y, 'DADOS DO COLABORADOR');
  // Tiago, 23/10: no PDF só nome e CPF (sem unidade e sem função); loja e função continuam no histórico da emissão
  y = linha(doc, y, 'Colaborador', f.nome); y = linha(doc, y, 'CPF', cpfFmt(f.cpf)); y += 20;
  // dados da escala
  y = secao(doc, y, 'DADOS DA ESCALA');
  y = linha(doc, y, 'Data do trabalho', dBR(ctx.data) + ' (' + DIA_TXT[dow(ctx.data)] + ')' + (ctx.tipo === 'feriado' && ctx.nomeFeriado ? ' — ' + ctx.nomeFeriado : ''));
  y = linha(doc, y, 'Tipo de escala', (x, yy) => { let xx = caixa(doc, x, yy, ctx.tipo === 'domingo', 'Domingo'); caixa(doc, xx, yy, ctx.tipo === 'feriado', 'Feriado'); }); y += 14;
  // declaração
  y = secao(doc, y, 'DECLARAÇÃO DE CIÊNCIA'); y += 10;
  for (const p of m.declaracao.split(/\n\s*\n/)) { y = paragrafo(doc, p.trim(), ML + 10, y, CW - 20, m.empresa) + 9; }
  y += 10;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Data da ciência', ML + 10, y, { lineBreak: false }); doc.font('Helvetica').fillColor(GRAY).text(':', ML + 110, y, { lineBreak: false });
  doc.fillColor(INK).text('______ / ______ / __________', ML + 125, y, { lineBreak: false }); y += 30;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Assinatura do colaborador:', ML + 10, y, { lineBreak: false }); y += 44;
  doc.moveTo(ML + 10, y).lineTo(ML + CW - 10, y).lineWidth(0.8).stroke(INK); y += 26;
  // fundamentação legal
  y = secao(doc, y, 'FUNDAMENTAÇÃO LEGAL'); y += 8;
  doc.font('Helvetica').fontSize(9).fillColor(INK).text(m.fundamentacao, ML + 10, y, { width: CW - 20, align: 'justify', lineGap: 2 }); y = doc.y + 8;
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(GRAY).text(m.nota, ML + 10, y, { width: CW - 20, align: 'justify', lineGap: 2 });
  // rodapé
  doc.font('Helvetica').fontSize(7.5).fillColor(GRAY);
  doc.text((ctx.previa ? 'PRÉVIA · não emitido' : ctx.id + ' · documento ' + (idx + 1) + '/' + total + ' · emitido em ' + ctx.emitidoTxt + ' por ' + ctx.usuarioNome) + ' · ' + m.empresa + ' · Econômico Relatórios', ML, A4.h - 34, { width: CW, align: 'center', lineBreak: false });
  if (ctx.previa) { doc.save(); doc.rotate(-32, { origin: [A4.w / 2, A4.h / 2] }); doc.fillOpacity(0.09).font('Helvetica-Bold').fontSize(96).fillColor('#C22F49').text('PRÉVIA', 0, A4.h / 2 - 60, { width: A4.w, align: 'center', lineBreak: false }); doc.restore(); }
}
function gerarPdf(ctx) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: (ctx.previa ? 'Prévia · ' : '') + 'Termo de ciência de escala · ' + ctx.lojaTxt + ' · ' + dBR(ctx.data), Author: ctx.modelo.empresa, Subject: 'Termo de ciência de escala de trabalho aos domingos e feriados', Creator: 'Econômico Relatórios' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    ctx.funcionarios.forEach((f, i) => { doc.addPage({ size: 'A4', margin: 0 }); desenharTermo(doc, ctx, f, i, ctx.funcionarios.length); });
    doc.end();
  });
}
const emitidoTxt = iso => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Recife', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// ── validação comum (loja, data, tipo, funcionários) ──
async function montarContexto(body, user, deps, opts) {
  const loja = exigeLoja(user, body.loja); if (!dataOk(body.data)) throw erro('Data do trabalho inválida');
  const tipo = String(body.tipo || ''); if (!TIPO_TXT[tipo]) throw erro('Tipo de escala inválido (domingo ou feriado)');
  const ids = [...new Set((Array.isArray(body.funcIds) ? body.funcIds : [body.funcId]).map(String).filter(Boolean))];
  if (!ids.length) throw erro('Selecione pelo menos um funcionário'); if (ids.length > 400) throw erro('Mais de 400 funcionários numa emissão só');
  let col; try { col = await deps.colaboradores(); } catch (e) { GP.auditar({ usuario: user.usuario, acao: 'termo_escala_erro_ponto', erro: e.message }); throw erro('PontoCerto indisponível agora: ' + e.message, 502); }
  const daLoja = new Map(col.ativos.filter(c => +c.loja === loja).map(c => [String(c.id), c]));
  const funcionarios = [], problemas = [];
  for (const id of ids) {
    const c = daLoja.get(id);
    if (!c) { const outro = col.ativos.find(x => String(x.id) === id) || col.desligados.find(x => String(x.id) === id); problemas.push((outro ? outro.nome + (outro.ativo === false ? ' está desligado' : ' não é de ' + GP.LOJA_TXT[loja]) : 'funcionário ' + id + ' não encontrado no PontoCerto')); continue; }
    const cpf = await deps.cpfDe(c.id);
    if (!cpf) problemas.push(c.nome + ': sem CPF no PontoCerto'); else if (!c.cargo) problemas.push(c.nome + ': sem função no PontoCerto');
    else funcionarios.push({ id: c.id, nome: c.nome, cpf, cpf_fim: cpfMask(cpf), cargo: c.cargo, setor: c.setor || '' });
  }
  if (problemas.length && !(opts && opts.previa)) throw erro('Não dá para emitir: ' + problemas.join('; '), 400, { erros: problemas });
  if (!funcionarios.length) throw erro(problemas[0] || 'Nenhum funcionário válido');
  funcionarios.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const info = infoData(body.data);
  return { loja, lojaTxt: GP.LOJA_TXT[loja], data: body.data, tipo, nomeFeriado: info.nomeFeriado, funcionarios, usuarioNome: user.nome || user.usuario, modelo: modelo() };
}

/** emissões não canceladas da mesma loja e data que já incluem algum dos funcionários (evita duplicar sem querer) */
function duplicados(loja, data, ids) {
  const set = new Set(ids.map(String));
  return emissoes().filter(e => e.status !== 'cancelada' && +e.loja === +loja && e.data === data && e.funcionarios.some(f => set.has(String(f.id))))
    .map(e => ({ id: e.id, em: e.em, tipo: e.tipo, usuario: e.usuario, nomes: e.funcionarios.filter(f => set.has(String(f.id))).map(f => f.nome) }));
}
function proximoId(ano) { const n = emissoes().filter(e => e.id.startsWith('TE-' + ano + '-')).reduce((m, e) => Math.max(m, +e.id.split('-')[2] || 0), 0) + 1; return 'TE-' + ano + '-' + String(n).padStart(4, '0'); }

async function previaPdf(body, user, deps) {
  const p = permissoes(user); if (!p.emitir && !p.configurar) throw erro('Sem permissão para gerar prévia', 403);
  const ctx = await montarContexto({ ...body, funcIds: [body.funcId] }, user, deps, { previa: true });
  if (body.modelo && p.configurar) { const m = { ...ctx.modelo }; for (const k of CAMPOS_TEXTO) if (typeof body.modelo[k] === 'string' && body.modelo[k].trim()) m[k] = body.modelo[k].replace(/\r/g, '').trim(); ctx.modelo = m; }
  ctx.previa = true; ctx.id = 'PRÉVIA'; ctx.emitidoTxt = emitidoTxt(agoraIso());
  return gerarPdf(ctx);
}
/** prévia do modelo com dados fictícios (aba Modelo do termo) */
async function previaModelo(body, user) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem permissão', 403);
  const m = modelo(); if (body.modelo && p.configurar) for (const k of CAMPOS_TEXTO) if (typeof body.modelo[k] === 'string' && body.modelo[k].trim()) m[k] = body.modelo[k].replace(/\r/g, '').trim();
  const data = body.data && dataOk(body.data) ? body.data : hojeISO();
  return gerarPdf({ previa: true, id: 'PRÉVIA', emitidoTxt: emitidoTxt(agoraIso()), usuarioNome: user.nome || user.usuario, loja: 1, lojaTxt: GP.LOJA_TXT[1], data, tipo: dow(data) === 0 ? 'domingo' : 'feriado', nomeFeriado: E.feriado(data) ? E.nomeFeriado(data) : null, modelo: m, funcionarios: [{ nome: 'NOME DO COLABORADOR (EXEMPLO)', cpf: '00000000000', cargo: 'Função cadastrada no PontoCerto' }] });
}

async function emitir(body, user, deps) {
  if (!permissoes(user).emitir) throw erro('Só o RH / Departamento Pessoal emite termos', 403);
  const ctx = await montarContexto(body, user, deps);
  const dup = duplicados(ctx.loja, ctx.data, ctx.funcionarios.map(f => f.id));
  if (dup.length && body.confirmarDuplicado !== true) throw erro('Já existe termo emitido para ' + dBR(ctx.data) + ' em ' + ctx.lojaTxt + ' para ' + dup.reduce((n, d) => n + d.nomes.length, 0) + ' do(s) funcionário(s) selecionado(s). Confirme para emitir de novo.', 409, { duplicados: dup });
  const em = agoraIso(); const id = proximoId(em.slice(0, 4));
  Object.assign(ctx, { id, emitidoTxt: emitidoTxt(em) });
  const pdf = await gerarPdf(ctx);
  fs.mkdirSync(path.dirname(P.pdf(id)), { recursive: true }); fs.writeFileSync(P.pdf(id), pdf);
  const reg = { id, em, usuario: { usuario: user.usuario, nome: user.nome || user.usuario }, loja: ctx.loja, lojaTxt: ctx.lojaTxt, data: ctx.data, tipo: ctx.tipo, nomeFeriado: ctx.nomeFeriado, qtd: ctx.funcionarios.length,
    funcionarios: ctx.funcionarios.map(f => ({ id: f.id, nome: f.nome, cpf_fim: f.cpf_fim, cargo: f.cargo, setor: f.setor })), arquivo: 'pdf/' + id + '.pdf', bytes: pdf.length, status: 'emitida', modeloValidado: !!ctx.modelo.validadoJuridico, reimpressoes: 0, duplicadoDe: dup.map(d => d.id) };
  emissoes().push(reg); salvarEmissoes();
  GP.auditar({ usuario: user.usuario, acao: 'termo_escala_emitir', ref: id, loja: ctx.loja, data: ctx.data, tipo: ctx.tipo, qtd: reg.qtd, duplicadoDe: reg.duplicadoDe });
  return reg;
}

function listar(q, user) {
  const p = permissoes(user); if (!p.ver) throw erro('Sem acesso aos termos de escala', 403);
  const f = q || {}; const func = semAcento(f.func || '').trim();
  const lim = Math.min(+f.limite || 300, 1000);
  return emissoes().filter(e => GP.veLoja(user, e.loja))
    .filter(e => !f.loja || +e.loja === +f.loja).filter(e => !f.tipo || e.tipo === f.tipo).filter(e => !f.status || e.status === f.status)
    .filter(e => !f.de || e.em.slice(0, 10) >= f.de).filter(e => !f.ate || e.em.slice(0, 10) <= f.ate).filter(e => !f.dataTrabalho || e.data === f.dataTrabalho)
    .filter(e => !func || e.id.toLowerCase().includes(func) || e.funcionarios.some(x => semAcento(x.nome).includes(func)))
    .sort((a, b) => b.em.localeCompare(a.em)).slice(0, lim)
    .map(e => ({ ...e, nomes: e.funcionarios.map(x => x.nome) }));
}
function obter(id, user) {
  if (!permissoes(user).ver) throw erro('Sem acesso aos termos de escala', 403);
  const e = emissoes().find(x => x.id === id); if (!e) throw erro('Emissão não encontrada', 404);
  if (!GP.veLoja(user, e.loja)) throw erro('Emissão de unidade fora do seu escopo', 403);
  return e;
}
/** caminho do PDF original (nunca regenerado); reimpressão fica registrada na auditoria e no contador */
function arquivoPdf(id, user, reimpressao) {
  const e = obter(id, user); const f = P.pdf(e.id); if (!fs.existsSync(f)) throw erro('Arquivo do termo não está mais no servidor (' + e.arquivo + ')', 410);
  if (reimpressao) { if (!permissoes(user).reimprimir) throw erro('Diretoria tem acesso só de consulta', 403); e.reimpressoes = (e.reimpressoes || 0) + 1; e.ultimaReimpressao = { em: agoraIso(), usuario: user.usuario }; salvarEmissoes(); GP.auditar({ usuario: user.usuario, acao: 'termo_escala_reimprimir', ref: e.id }); }
  return { emissao: e, caminho: f, nome: e.id + '-' + semAcento(e.lojaTxt.split(' · ')[0]) + '-' + e.data + '.pdf' };
}
function cancelar(id, motivo, user) {
  if (!permissoes(user).cancelar) throw erro('Sem permissão para cancelar', 403);
  const e = obter(id, user); if (e.status === 'cancelada') throw erro('Esta emissão já está cancelada');
  const m = String(motivo || '').trim(); if (m.length < 5) throw erro('Informe o motivo do cancelamento');
  e.status = 'cancelada'; e.cancelamento = { em: agoraIso(), usuario: user.usuario, nome: user.nome || user.usuario, motivo: m }; salvarEmissoes();
  GP.auditar({ usuario: user.usuario, acao: 'termo_escala_cancelar', ref: e.id, motivo: m });
  return e;
}
function proximoDomingo() { const h = hojeISO(); const d = new Date(h + 'T12:00:00'); d.setDate(d.getDate() + (7 - d.getDay()) % 7); return d.toISOString().slice(0, 10); }

module.exports = { DIR, TIPO_TXT, DIA_TXT, modelo, salvarModelo, permissoes, exigeLoja, infoData, funcionariosDaLoja, previaPdf, previaModelo, emitir, duplicados, listar, obter, arquivoPdf, cancelar, proximoDomingo, hojeISO, _util: { gerarPdf, cpfFmt, dBR } };
