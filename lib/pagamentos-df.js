'use strict';
// lib/pagamentos-df.js — Pagamentos de Domingos e Feriados (DP / RH › Termos de Escala › Pagamentos), 23/10/2026.
// Apura pelo ponto do PontoCerto quem trabalhou nos domingos/feriados escolhidos, cruza com os Termos de Escala emitidos,
// calcula o valor por função (tabela configurável com vigência, por loja e exceções por funcionário), o RH confere e ajusta
// (sempre com justificativa), a Coordenação aprova (aí o destino bancário validado é congelado no relatório) e o Financeiro
// recebe só relatórios aprovados, exporta PDF/xlsx e registra pagamento por funcionário. Nada do ponto é alterado.
//   data/pagamentos-df/relatorios.json   relatórios (itens com valores congelados; dados bancários cifrados no snapshot)
//   data/pagamentos-df/valores.json      tabela de valores + alterações
//   data/pagamentos-df/auditoria/AAAA-MM.jsonl
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const GP = require('./gestao-pessoas'); const E = require('./escalas'); const T = require('./termos-escala'); const DB = require('./dados-bancarios');

const DIR = process.env.PAGDF_DIR || path.join(__dirname, '..', 'data', 'pagamentos-df');
const P = { relatorios: path.join(DIR, 'relatorios.json'), valores: path.join(DIR, 'valores.json'), auditoria: mes => path.join(DIR, 'auditoria', mes + '.jsonl') };
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400 }, extra || {});
const agoraIso = () => new Date().toISOString();
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const dataOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T12:00:00').getTime());
const dow = s => new Date(s + 'T12:00:00').getDay();
const dBR = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
const r2 = n => Math.round((+n || 0) * 100) / 100;
const brl = n => (+n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const quem = user => ({ usuario: user.usuario, nome: user.nome || user.usuario });
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
function appendLinha(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(obj) + '\n'); }
function lerLinhas(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } }
let relMem = null; const relatorios = () => relMem || (relMem = lerJson(P.relatorios, [])); const salvarRel = () => gravarJson(P.relatorios, relatorios());

const STATUS_TXT = { em_conferencia: 'Em conferência pelo RH', aguardando_aprovacao: 'Aguardando aprovação', devolvido: 'Devolvido para correção', aprovado: 'Aprovado', encaminhado_financeiro: 'Encaminhado ao Financeiro', em_processamento: 'Em processamento', processado: 'Processado', pago: 'Pago', parcialmente_pago: 'Parcialmente pago', cancelado: 'Cancelado' };
const PAG_TXT = { pendente: 'Pagamento pendente', processando: 'Em processamento', pago: 'Pago', falha: 'Falha no pagamento', bloqueado: 'Pagamento bloqueado', devolvido: 'Devolvido para correção' };
const DIV_TXT = { sem_termo: 'Sem termo de escala', termo_sem_ponto: 'Termo emitido sem registro de ponto', ponto_incompleto: 'Marcações incompletas', afastado: 'Afastado/férias no PontoCerto', sem_valor: 'Função sem valor configurado', duplicado: 'Já consta em outro relatório', inclusao_manual: 'Incluído manualmente pelo RH' };
const FIN_STATUS = ['encaminhado_financeiro', 'em_processamento', 'processado', 'pago', 'parcialmente_pago'];

// ── permissões ──
function perm(user) {
  const dp = GP.temPapel(user, ...GP.RH), fin = GP.temPapel(user, 'financeiro'), coord = GP.temPapel(user, 'coordenacao'), dir = GP.temPapel(user, 'diretoria');
  return { papeis: GP.papeisDe(user), dp, fin, coord, dir, ver: dp || fin || coord || dir, apurar: dp, conferir: dp, aprovar: coord, processar: fin, valores: coord || dp, bancoCompleto: fin, exportarFinanceiro: fin };
}
const veLoja = (user, loja) => DB.veLoja(user, loja);
const lojasDe = user => GP.LOJAS.filter(l => veLoja(user, l));
function auditar(ev) { const em = agoraIso(); appendLinha(P.auditoria(em.slice(0, 7)), { id: crypto.randomUUID(), em, usuario: ev.usuario ? ev.usuario.usuario : null, nome: ev.usuario ? (ev.usuario.nome || ev.usuario.usuario) : null, ref: ev.ref || null, item: ev.item || null, acao: ev.acao, justificativa: ev.justificativa || null, antes: ev.antes == null ? null : ev.antes, depois: ev.depois == null ? null : ev.depois, detalhe: ev.detalhe || null }); }

// ── tabela de valores ──
const VALORES_PADRAO = {
  passagemPadrao: 9,
  funcoes: [
    { id: 'operador_caixa', funcao: 'Operador de Caixa', aliases: ['operador de caixa', 'operadora de caixa', 'caixa'], domingo: 55, feriado: 58, passagem: 9 },
    { id: 'operador_loja', funcao: 'Operador de Loja', aliases: ['operador de loja', 'repositor', 'auxiliar de loja', 'estoquista', 'balconista', 'atendente', 'auxiliar', 'empacotador', 'conferente', 'recepcao'], domingo: 55, feriado: 58, passagem: 9 },
    { id: 'seguranca', funcao: 'Segurança / Fiscal de Loja', aliases: ['seguranca', 'fiscal de loja', 'fiscal de prevencao', 'prevencao', 'vigilante', 'fiscal'], domingo: 55, feriado: 58, passagem: 9 },
    { id: 'frente_loja', funcao: 'Frente de Loja', aliases: ['frente de loja', 'fiscal de caixa', 'lider de caixa', 'tesouraria'], domingo: 61, feriado: 64, passagem: 9 },
    { id: 'acougueiro', funcao: 'Açougueiro', aliases: ['acougueiro', 'acougue', 'desossador'], domingo: 61, feriado: 64, passagem: 9 },
    { id: 'padeiro', funcao: 'Padeiro', aliases: ['padeiro', 'padaria', 'confeiteiro'], domingo: 61, feriado: 64, passagem: 9 },
    { id: 'encarregado', funcao: 'Encarregado', aliases: ['encarregado', 'lider', 'supervisor', 'chefe de secao'], domingo: 73, feriado: 83, passagem: null },
    { id: 'subgerente', funcao: 'Subgerente', aliases: ['subgerente', 'sub gerente', 'sub-gerente'], domingo: 73, feriado: 83, passagem: null },
    { id: 'gerente', funcao: 'Gerente', aliases: ['gerente'], domingo: null, feriado: 125, passagem: null }],
  porLoja: [],      // { funcaoId, loja, domingo, feriado, passagem, vigenciaIni, vigenciaFim }
  excecoes: [],     // { funcId, nome, domingo, feriado, passagem, vigenciaIni, vigenciaFim, justificativa }
  alteracoes: []
};
function valores() { const v = lerJson(P.valores, null); return v ? { ...VALORES_PADRAO, ...v } : JSON.parse(JSON.stringify(VALORES_PADRAO)); }
const num = v => (v === '' || v == null) ? null : (isNaN(+v) ? NaN : r2(+v));
function salvarValores(mud, user) {
  if (!perm(user).valores) throw erro('Só Coordenação e DP / RH alteram a tabela de valores', 403); mud = mud || {};
  const j = txt(mud.justificativa, 500); if (j.length < 5) throw erro('Toda alteração de valores exige justificativa');
  const v = valores(); const antes = JSON.stringify({ p: v.passagemPadrao, f: v.funcoes, l: v.porLoja, e: v.excecoes });
  if (mud.passagemPadrao != null) { const p = num(mud.passagemPadrao); if (isNaN(p) || p < 0) throw erro('Passagem padrão inválida'); v.passagemPadrao = p; }
  if (Array.isArray(mud.funcoes)) v.funcoes = mud.funcoes.map(f => { const id = semAcento(f.id || f.funcao).replace(/[^a-z0-9]+/g, '_'); const o = { id, funcao: txt(f.funcao, 60), aliases: (Array.isArray(f.aliases) ? f.aliases : String(f.aliases || '').split(/[;,]/)).map(a => semAcento(a)).filter(Boolean), domingo: num(f.domingo), feriado: num(f.feriado), passagem: num(f.passagem) }; if (!o.funcao) throw erro('Função sem nome'); for (const k of ['domingo', 'feriado', 'passagem']) if (isNaN(o[k]) || (o[k] != null && o[k] < 0)) throw erro('Valor inválido em ' + o.funcao); return o; });
  if (Array.isArray(mud.porLoja)) v.porLoja = mud.porLoja.map(r => ({ funcaoId: String(r.funcaoId || ''), loja: +r.loja, domingo: num(r.domingo), feriado: num(r.feriado), passagem: num(r.passagem), vigenciaIni: dataOk(r.vigenciaIni) ? r.vigenciaIni : null, vigenciaFim: dataOk(r.vigenciaFim) ? r.vigenciaFim : null })).filter(r => GP.LOJAS.includes(r.loja) && v.funcoes.some(f => f.id === r.funcaoId));
  if (Array.isArray(mud.excecoes)) v.excecoes = mud.excecoes.map(e => ({ funcId: String(e.funcId || ''), nome: txt(e.nome, 80), domingo: num(e.domingo), feriado: num(e.feriado), passagem: num(e.passagem), vigenciaIni: dataOk(e.vigenciaIni) ? e.vigenciaIni : null, vigenciaFim: dataOk(e.vigenciaFim) ? e.vigenciaFim : null, justificativa: txt(e.justificativa, 300) })).filter(e => e.funcId);
  v.alteracoes = [...(v.alteracoes || []), { em: agoraIso(), ...quem(user), justificativa: j }].slice(-200);
  gravarJson(P.valores, v); auditar({ usuario: user, acao: 'valores', justificativa: j, antes: antes.slice(0, 4000), depois: JSON.stringify({ p: v.passagemPadrao, f: v.funcoes, l: v.porLoja, e: v.excecoes }).slice(0, 4000) }); return v;
}
function funcaoDe(cargo, V) { const c = semAcento(cargo); let best = null; for (const f of (V || valores()).funcoes) for (const a of f.aliases) { const an = semAcento(a); if (an && c.includes(an) && (!best || an.length > best.len)) best = { f, len: an.length }; } return best ? best.f : null; }
/** valor de trabalho e passagem para (função, loja, funcionário, data, tipo): exceção do funcionário > tabela da loja > tabela geral */
function valorPara({ cargo, loja, funcId, data, tipo }, V) {
  V = V || valores(); const vig = r => (!r.vigenciaIni || r.vigenciaIni <= data) && (!r.vigenciaFim || r.vigenciaFim >= data);
  const ex = V.excecoes.find(e => String(e.funcId) === String(funcId) && vig(e));
  if (ex && ex[tipo] != null) return { trabalho: ex[tipo], passagem: ex.passagem != null ? ex.passagem : V.passagemPadrao, origem: 'excecao', funcaoTabela: 'Valor específico do funcionário' };
  const f = funcaoDe(cargo, V); if (!f) return { trabalho: null, passagem: null, origem: 'sem_tabela', funcaoTabela: null, motivo: 'Função "' + (cargo || '—') + '" não está na tabela de valores' };
  const pl = V.porLoja.find(r => r.funcaoId === f.id && +r.loja === +loja && vig(r)); const row = pl || f;
  if (row[tipo] == null) return { trabalho: null, passagem: row.passagem, origem: 'sem_valor', funcaoTabela: f.funcao, motivo: 'Valor de ' + tipo + ' não definido para ' + f.funcao + (f.id === 'gerente' ? ' (não calcular até a empresa definir)' : '') };
  return { trabalho: row[tipo], passagem: row.passagem, origem: pl ? 'tabela_loja' : 'tabela', funcaoTabela: f.funcao };
}

// ── datas e apuração ──
function datasDoPeriodo(de, ate) {
  if (!dataOk(de) || !dataOk(ate) || ate < de) throw erro('Período inválido'); if ((new Date(ate) - new Date(de)) / 86400000 > 62) throw erro('Período máximo de 62 dias');
  const out = []; for (let d = de; d <= ate; d = (x => { const n = new Date(x + 'T12:00:00'); n.setDate(n.getDate() + 1); return n.toISOString().slice(0, 10); })(d)) { const fer = E.feriado(d); if (dow(d) === 0 || fer) out.push({ data: d, tipo: fer ? 'feriado' : 'domingo', nomeFeriado: fer ? E.nomeFeriado(d) : null, futura: d > hojeISO(), diaSemana: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][dow(d)] }); }
  return out;
}
function duplicadoDe(funcId, data, ignorarId) { for (const r of relatorios()) { if (r.status === 'cancelado' || r.id === ignorarId) continue; const it = r.itens.find(i => String(i.funcId) === String(funcId) && i.data === data && i.selecionado); if (it) return { relatorioId: r.id, status: r.status, statusTxt: STATUS_TXT[r.status] }; } return null; }
const pontoDe = l => { const m = (l.marcacoes || []).length; return m >= 2 && l.situacao !== 'incompleta' ? 'completa' : m >= 1 ? 'incompleta' : 'sem_marcacao'; };
async function apurar({ lojas, datas }, deps, ignorarId) {
  const col = await deps.colaboradores(); const cpfFim = new Map([...col.ativos, ...col.desligados].map(c => [String(c.id), c.cpf_fim || ''])); const V = valores();
  const itens = [], erros = [];
  for (const data of datas) {
    let j; try { j = await deps.jornadaDia(data); } catch (e) { erros.push({ data, erro: e.message }); continue; }
    const fer = E.feriado(data); const tipo = fer ? 'feriado' : 'domingo'; const nomeFeriado = fer ? E.nomeFeriado(data) : null; const termos = T.termosPorData(data);
    for (const l of j.linhas) {
      if (!lojas.includes(+l.loja)) continue; const trabalhou = (l.marcacoes || []).length > 0; const termo = termos.get(String(l.id)) || null; if (!trabalhou && !termo) continue;
      const ponto = pontoDe(l); const div = []; if (!termo) div.push('sem_termo'); if (termo && !trabalhou) div.push('termo_sem_ponto'); if (ponto === 'incompleta') div.push('ponto_incompleto'); if (['ferias', 'afastado'].includes(l.situacao)) div.push('afastado');
      const val = valorPara({ cargo: l.cargo, loja: l.loja, funcId: l.id, data, tipo }, V); if (val.trabalho == null) div.push('sem_valor');
      const dup = duplicadoDe(l.id, data, ignorarId); if (dup) div.push('duplicado');
      itens.push({ key: l.id + '|' + data, funcId: l.id, nome: l.nome, cpf_fim: cpfFim.get(String(l.id)) || '', loja: +l.loja, lojaTxt: GP.LOJA_TXT[l.loja] || '', cargo: l.cargo || '', setor: l.setor || '', data, tipo, nomeFeriado,
        ponto: { situacao: ponto, marcacoes: l.marcacoes || [], situacaoPonto: l.situacao, situacaoTxt: l.situacaoTxt || '', previsto: l.previsto || null }, termo: termo ? { id: termo.id, em: termo.em } : null,
        valorTrabalho: val.trabalho, passagem: { aplica: val.passagem != null, valor: val.passagem != null ? val.passagem : V.passagemPadrao }, origemValor: val.origem, funcaoTabela: val.funcaoTabela, motivoValor: val.motivo || null,
        divergencias: div, duplicadoDe: dup, selecionado: trabalhou && !dup && val.trabalho != null && !div.includes('afastado'), automatico: { selecionado: trabalhou && !dup && val.trabalho != null && !div.includes('afastado'), valorTrabalho: val.trabalho, passagemAplica: val.passagem != null, passagemValor: val.passagem != null ? val.passagem : V.passagemPadrao },
        justificativa: null, incluidoManual: false, conferido: false, pagamento: { status: 'pendente' }, banco: null, historico: [] });
    }
  }
  itens.sort((a, b) => a.loja - b.loja || a.data.localeCompare(b.data) || a.nome.localeCompare(b.nome, 'pt-BR'));
  return { itens, erros };
}
const totalItem = i => r2((+i.valorTrabalho || 0) + (i.passagem.aplica ? (+i.passagem.valor || 0) : 0));
function totais(r) {
  const sel = r.itens.filter(i => i.selecionado); const t = { itens: sel.length, funcionarios: new Set(sel.map(i => i.funcId)).size, trabalho: 0, passagens: 0, geral: 0, porLoja: {}, porData: {}, apto: 0, pendente: 0, bloqueado: 0, pago: 0, divergencias: sel.filter(i => i.divergencias.length).length, semTermo: sel.filter(i => i.divergencias.includes('sem_termo')).length, pontoIncompleto: sel.filter(i => i.divergencias.includes('ponto_incompleto')).length, bancoPendente: 0 };
  for (const i of sel) { const tot = totalItem(i); t.trabalho = r2(t.trabalho + (+i.valorTrabalho || 0)); t.passagens = r2(t.passagens + (i.passagem.aplica ? +i.passagem.valor || 0 : 0)); t.geral = r2(t.geral + tot);
    const L = t.porLoja[i.loja] || (t.porLoja[i.loja] = { loja: i.loja, lojaTxt: i.lojaTxt, itens: 0, trabalho: 0, passagens: 0, geral: 0 }); L.itens++; L.trabalho = r2(L.trabalho + (+i.valorTrabalho || 0)); L.passagens = r2(L.passagens + (i.passagem.aplica ? +i.passagem.valor || 0 : 0)); L.geral = r2(L.geral + tot);
    const D = t.porData[i.data] || (t.porData[i.data] = { data: i.data, tipo: i.tipo, itens: 0, geral: 0 }); D.itens++; D.geral = r2(D.geral + tot);
    if (i.banco) { if (i.banco.status === 'apto') t.apto = r2(t.apto + tot); else if (i.banco.status === 'bloqueado') t.bloqueado = r2(t.bloqueado + tot); else { t.pendente = r2(t.pendente + tot); t.bancoPendente++; } }
    if (i.pagamento.status === 'pago') t.pago = r2(t.pago + tot); }
  t.porLoja = Object.values(t.porLoja); t.porData = Object.values(t.porData).sort((a, b) => a.data.localeCompare(b.data)); return t;
}
function proximoId(ano) { const n = relatorios().filter(r => r.id.startsWith('PG-' + ano + '-')).reduce((m, r) => Math.max(m, +r.id.split('-')[2] || 0), 0) + 1; return 'PG-' + ano + '-' + String(n).padStart(4, '0'); }
const obterRaw = id => { const r = relatorios().find(x => x.id === id); if (!r) throw erro('Relatório não encontrado', 404); return r; };
function podeVerRel(r, user) { const p = perm(user); if (!p.ver) return false; if (!r.lojas.some(l => veLoja(user, l))) return false; if (p.fin && !p.dp && !p.coord && !p.dir && !FIN_STATUS.includes(r.status)) return false; return true; }
function fluxo(r, user, acao, texto) { const f = { acao, em: agoraIso(), ...quem(user), texto: texto || null, status: r.status }; r.fluxo.push(f); return f; }

// ── relatórios: criação e conferência (RH) ──
async function criar(body, user, deps) {
  const p = perm(user); if (!p.apurar) throw erro('Só o DP / RH apura pagamentos', 403); body = body || {};
  const lojas = [...new Set((Array.isArray(body.lojas) ? body.lojas : [body.loja]).map(Number).filter(l => GP.LOJAS.includes(l)))]; if (!lojas.length) throw erro('Escolha pelo menos uma unidade');
  for (const l of lojas) if (!veLoja(user, l)) throw erro(GP.LOJA_TXT[l] + ' está fora do seu escopo', 403);
  const datas = [...new Set((Array.isArray(body.datas) ? body.datas : []).filter(dataOk))].sort(); if (!datas.length) throw erro('Escolha pelo menos uma data');
  for (const d of datas) { if (d > hojeISO()) throw erro('Data futura: ' + dBR(d)); if (dow(d) !== 0 && !E.feriado(d)) throw erro(dBR(d) + ' não é domingo nem feriado cadastrado'); }
  const { itens, erros } = await apurar({ lojas, datas }, deps);
  if (!itens.length && erros.length) throw erro('PontoCerto indisponível: ' + erros.map(e => e.erro).join('; '), 502);
  const em = agoraIso(); const r = { id: proximoId(em.slice(0, 4)), status: 'em_conferencia', lojas, lojasTxt: lojas.map(l => GP.LOJA_TXT[l]), periodo: { de: datas[0], ate: datas[datas.length - 1] }, datas, criadoPor: quem(user), em, itens, errosApuracao: erros, previsaoPagamento: null, conferencia: null, aprovacao: null, fluxo: [], exportacoes: [], revisoes: [], apuradoEm: em };
  fluxo(r, user, 'criar', itens.length + ' ocorrência(s) em ' + datas.length + ' data(s)'); r.totais = totais(r); relatorios().push(r); salvarRel();
  auditar({ usuario: user, ref: r.id, acao: 'criar', detalhe: { lojas, datas, itens: itens.length, erros } }); return r;
}
async function reapurar(id, user, deps) {
  const r = obterRaw(id); if (!perm(user).conferir || !podeVerRel(r, user)) throw erro('Sem permissão', 403); if (!['em_conferencia', 'devolvido'].includes(r.status)) throw erro('Só relatórios em conferência podem ser reconsultados');
  const { itens, erros } = await apurar({ lojas: r.lojas, datas: r.datas }, deps, r.id); const antigos = new Map(r.itens.map(i => [i.key, i])); let novos = 0, mantidos = 0;
  const merged = itens.map(n => { const a = antigos.get(n.key); if (!a) { novos++; return n; } mantidos++; return { ...n, selecionado: a.selecionado, valorTrabalho: a.valorTrabalho, passagem: a.passagem, justificativa: a.justificativa, conferido: a.conferido, historico: a.historico, incluidoManual: a.incluidoManual, origemValor: a.origemValor }; });
  for (const a of r.itens) if (a.incluidoManual && !antigos.has(a.key) === false && !merged.some(m => m.key === a.key)) merged.push(a);
  const sumiram = r.itens.filter(a => !merged.some(m => m.key === a.key)).map(a => a.nome + ' ' + dBR(a.data));
  r.itens = merged; r.errosApuracao = erros; r.apuradoEm = agoraIso(); r.totais = totais(r); fluxo(r, user, 'reapurar', novos + ' novo(s), ' + mantidos + ' mantido(s)' + (sumiram.length ? ', saíram: ' + sumiram.join(', ') : '')); salvarRel();
  auditar({ usuario: user, ref: r.id, acao: 'reapurar', detalhe: { novos, mantidos, sumiram } }); return r;
}
function editarItem(id, key, mud, user) {
  const r = obterRaw(id); if (!perm(user).conferir || !podeVerRel(r, user)) throw erro('Sem permissão', 403); if (!['em_conferencia', 'devolvido'].includes(r.status)) throw erro('Relatório não está em conferência');
  const i = r.itens.find(x => x.key === key); if (!i) throw erro('Ocorrência não encontrada', 404); mud = mud || {};
  const antes = { selecionado: i.selecionado, valorTrabalho: i.valorTrabalho, passagem: { ...i.passagem }, justificativa: i.justificativa };
  if (mud.selecionado != null) i.selecionado = !!mud.selecionado;
  if (mud.valorTrabalho !== undefined) { const v = num(mud.valorTrabalho); if (v == null || isNaN(v) || v < 0) throw erro('Valor do trabalho inválido'); i.valorTrabalho = v; i.origemValor = v === i.automatico.valorTrabalho ? (i.automatico.valorTrabalho == null ? 'manual' : i.origemValor) : 'manual'; }
  if (mud.passagemAplica != null) i.passagem.aplica = !!mud.passagemAplica;
  if (mud.passagemValor !== undefined) { const v = num(mud.passagemValor); if (v == null || isNaN(v) || v < 0) throw erro('Valor da passagem inválido'); i.passagem.valor = v; }
  if (mud.justificativa !== undefined) i.justificativa = txt(mud.justificativa, 500) || null;
  if (mud.conferido != null) i.conferido = !!mud.conferido;
  const a = i.automatico; const mudouManual = i.selecionado !== a.selecionado || i.valorTrabalho !== a.valorTrabalho || i.passagem.aplica !== a.passagemAplica || i.passagem.valor !== a.passagemValor;
  if (i.selecionado && i.valorTrabalho == null) throw erro('Informe o valor do trabalho (função sem valor na tabela)');
  if ((mudouManual || (i.selecionado && i.divergencias.length)) && !(i.justificativa && i.justificativa.length >= 5)) throw erro('Inclusão, exclusão, alteração de valor ou divergência exigem justificativa');
  i.ajusteManual = mudouManual; i.historico.push({ em: agoraIso(), usuario: user.usuario, antes, depois: { selecionado: i.selecionado, valorTrabalho: i.valorTrabalho, passagem: { ...i.passagem }, justificativa: i.justificativa } });
  r.totais = totais(r); salvarRel(); auditar({ usuario: user, ref: r.id, item: key, acao: 'editar_item', justificativa: i.justificativa, antes, depois: { selecionado: i.selecionado, valorTrabalho: i.valorTrabalho, passagem: i.passagem } });
  return { item: i, totais: r.totais };
}
async function incluirManual(id, body, user, deps) {
  const r = obterRaw(id); if (!perm(user).conferir || !podeVerRel(r, user)) throw erro('Sem permissão', 403); if (!['em_conferencia', 'devolvido'].includes(r.status)) throw erro('Relatório não está em conferência'); body = body || {};
  const data = body.data; if (!r.datas.includes(data)) throw erro('A data precisa ser uma das datas do relatório'); const just = txt(body.justificativa, 500); if (just.length < 5) throw erro('Inclusão manual exige justificativa (documentação que comprova o trabalho)');
  const c = await DB.colabDe(deps, body.funcId); if (!c) throw erro('Funcionário não encontrado no PontoCerto', 404); if (!r.lojas.includes(+c.loja)) throw erro('Funcionário não é das unidades deste relatório');
  const key = c.id + '|' + data; if (r.itens.some(i => i.key === key)) throw erro('Esse funcionário já está na lista nesta data');
  const fer = E.feriado(data); const tipo = fer ? 'feriado' : 'domingo'; const val = valorPara({ cargo: c.cargo, loja: c.loja, funcId: c.id, data, tipo }); const termo = T.termosPorData(data).get(String(c.id)) || null; const dup = duplicadoDe(c.id, data, r.id);
  const div = ['inclusao_manual']; if (!termo) div.push('sem_termo'); if (val.trabalho == null) div.push('sem_valor'); if (dup) div.push('duplicado');
  const vt = body.valorTrabalho !== undefined && body.valorTrabalho !== '' ? num(body.valorTrabalho) : val.trabalho; if (vt == null || isNaN(vt)) throw erro('Informe o valor do trabalho');
  const i = { key, funcId: c.id, nome: c.nome, cpf_fim: c.cpf_fim || '', loja: +c.loja, lojaTxt: GP.LOJA_TXT[c.loja] || '', cargo: c.cargo || '', setor: c.setor || '', data, tipo, nomeFeriado: fer ? E.nomeFeriado(data) : null, ponto: { situacao: 'manual', marcacoes: [], situacaoTxt: 'Incluído manualmente' }, termo: termo ? { id: termo.id, em: termo.em } : null,
    valorTrabalho: vt, passagem: { aplica: body.passagemAplica != null ? !!body.passagemAplica : val.passagem != null, valor: body.passagemValor != null && body.passagemValor !== '' ? num(body.passagemValor) : (val.passagem != null ? val.passagem : valores().passagemPadrao) }, origemValor: vt === val.trabalho ? val.origem : 'manual', funcaoTabela: val.funcaoTabela, motivoValor: val.motivo || null,
    divergencias: div, duplicadoDe: dup, selecionado: !dup, automatico: { selecionado: false, valorTrabalho: val.trabalho, passagemAplica: val.passagem != null, passagemValor: val.passagem != null ? val.passagem : valores().passagemPadrao }, justificativa: just, incluidoManual: true, ajusteManual: true, conferido: true, pagamento: { status: 'pendente' }, banco: null, historico: [{ em: agoraIso(), usuario: user.usuario, acao: 'inclusao_manual', texto: just }] };
  r.itens.push(i); r.itens.sort((a, b) => a.loja - b.loja || a.data.localeCompare(b.data) || a.nome.localeCompare(b.nome, 'pt-BR')); r.totais = totais(r); salvarRel();
  auditar({ usuario: user, ref: r.id, item: key, acao: 'incluir_manual', justificativa: just, depois: { nome: c.nome, data, valorTrabalho: vt } }); return { item: i, totais: r.totais };
}
function enviar(id, body, user) {
  const r = obterRaw(id); if (!perm(user).conferir || !podeVerRel(r, user)) throw erro('Sem permissão', 403); if (!['em_conferencia', 'devolvido'].includes(r.status)) throw erro('Relatório não está em conferência'); body = body || {};
  const sel = r.itens.filter(i => i.selecionado); if (!sel.length) throw erro('Nenhuma ocorrência selecionada para pagamento');
  const pend = sel.filter(i => i.valorTrabalho == null || (i.divergencias.length && !(i.justificativa && i.justificativa.length >= 5))); if (pend.length) throw erro('Faltam valor ou justificativa em: ' + pend.slice(0, 6).map(i => i.nome + ' ' + dBR(i.data)).join('; ') + (pend.length > 6 ? ' e mais ' + (pend.length - 6) : ''), 400, { itens: pend.map(i => i.key) });
  if (body.previsaoPagamento) { if (!dataOk(body.previsaoPagamento)) throw erro('Data prevista de pagamento inválida'); r.previsaoPagamento = { data: body.previsaoPagamento, hora: /^\d{2}:\d{2}$/.test(body.previsaoHora || '') ? body.previsaoHora : '09:00' }; }
  r.status = 'aguardando_aprovacao'; r.conferencia = { ...quem(user), em: agoraIso(), texto: txt(body.texto, 500) || null }; fluxo(r, user, 'enviar', r.conferencia.texto); r.totais = totais(r); salvarRel();
  auditar({ usuario: user, ref: r.id, acao: 'enviar', justificativa: r.conferencia.texto, detalhe: { itens: sel.length, geral: r.totais.geral } });
  GP.notificar(GP.usuariosPara(['coordenacao']), 'Pagamento de domingos/feriados ' + r.id + ' (' + r.lojasTxt.join(', ') + ', ' + brl(r.totais.geral) + ') aguarda aprovação.', { url: '/termos-escala.html#pag' }); return r;
}
// ── aprovação (Coordenação): congela o destino bancário validado de cada funcionário ──
function aprovar(id, body, user) {
  const r = obterRaw(id); if (!perm(user).aprovar) throw erro('Só a Coordenação Administrativa aprova', 403); if (r.status !== 'aguardando_aprovacao') throw erro('Relatório não está aguardando aprovação'); body = body || {};
  if (body.previsaoPagamento) { if (!dataOk(body.previsaoPagamento)) throw erro('Data prevista de pagamento inválida'); r.previsaoPagamento = { data: body.previsaoPagamento, hora: /^\d{2}:\d{2}$/.test(body.previsaoHora || '') ? body.previsaoHora : '09:00' }; }
  const em = agoraIso();
  for (const i of r.itens) { if (!i.selecionado) continue; i.banco = snapshotBanco(i.funcId, r.id, user); i.pagamento = { status: i.banco.status === 'bloqueado' ? 'bloqueado' : 'pendente' }; }
  r.status = 'aprovado'; r.aprovacao = { ...quem(user), em, texto: txt(body.texto, 500) || null }; fluxo(r, user, 'aprovar', r.aprovacao.texto);
  r.status = 'encaminhado_financeiro'; fluxo(r, user, 'encaminhar', 'Encaminhado ao Financeiro'); r.totais = totais(r); salvarRel();
  auditar({ usuario: user, ref: r.id, acao: 'aprovar', justificativa: r.aprovacao.texto, detalhe: { geral: r.totais.geral, apto: r.totais.apto, pendente: r.totais.pendente, bloqueado: r.totais.bloqueado } });
  GP.notificar(GP.usuariosPara(['financeiro']), 'Relatório ' + r.id + ' aprovado: ' + brl(r.totais.geral) + ' (' + brl(r.totais.apto) + ' aptos, ' + brl(r.totais.pendente) + ' com pendência bancária).', { url: '/termos-escala.html#pag' });
  GP.notificar([r.criadoPor.usuario], 'Relatório ' + r.id + ' aprovado pela Coordenação e encaminhado ao Financeiro.', { url: '/termos-escala.html#pag' }); return r;
}
function snapshotBanco(funcId, relatorioId, user) {
  const pb = DB.paraPagamento(funcId);
  const s = { em: agoraIso(), status: pb.apto ? 'apto' : pb.bloqueado ? 'bloqueado' : 'pendente', statusTxt: pb.apto ? 'Apto' : pb.bloqueado ? 'Pagamento bloqueado para verificação' : 'Dados bancários pendentes', motivo: pb.motivo, cadastral: pb.cadastralTxt, recorrente: pb.recorrente, pendenteNova: pb.pendenteNova, pendenteJanela48h: pb.pendenteJanela48h, bloqueioId: pb.bloqueioId,
    contaId: pb.conta ? pb.conta.id : null, versao: pb.conta ? pb.conta.versao : null, modalidade: pb.conta ? pb.conta.modalidade : null, resumo: pb.conta ? pb.conta.resumo : null, validadoEm: pb.conta ? pb.conta.validadoEm : null, enc: pb.conta ? DB.cifrar(pb.conta.dados) : null };
  if (pb.conta) DB.registrarUso(funcId, pb.conta.id, relatorioId, user); return s;
}
function devolver(id, texto, user) {
  const r = obterRaw(id); const p = perm(user); const t = txt(texto, 500); if (t.length < 5) throw erro('Informe o que precisa ser corrigido');
  if (r.status === 'aguardando_aprovacao') { if (!p.aprovar) throw erro('Só a Coordenação devolve nesta etapa', 403); }
  else if (FIN_STATUS.includes(r.status)) { if (!p.processar && !p.aprovar) throw erro('Só o Financeiro ou a Coordenação devolvem nesta etapa', 403); if (r.itens.some(i => i.pagamento.status === 'pago')) throw erro('Há pagamentos já realizados: não é possível devolver o relatório inteiro (use revisão por item)'); }
  else throw erro('Relatório não pode ser devolvido neste status');
  r.status = 'devolvido'; fluxo(r, user, 'devolver', t); for (const i of r.itens) { i.banco = null; i.pagamento = { status: 'pendente' }; } r.totais = totais(r); salvarRel();
  auditar({ usuario: user, ref: r.id, acao: 'devolver', justificativa: t });
  GP.notificar([r.criadoPor.usuario, ...GP.usuariosPara(['rh_doc'])], 'Relatório ' + r.id + ' devolvido para correção: ' + t, { url: '/termos-escala.html#pag' }); return r;
}
function cancelar(id, texto, user) {
  const r = obterRaw(id); const p = perm(user); if (!(p.conferir || p.aprovar) || !podeVerRel(r, user)) throw erro('Sem permissão', 403); const t = txt(texto, 500); if (t.length < 5) throw erro('Informe o motivo');
  if (r.itens.some(i => i.pagamento.status === 'pago')) throw erro('Há pagamentos realizados: não é possível cancelar'); if (r.status === 'cancelado') throw erro('Já cancelado');
  if (FIN_STATUS.includes(r.status) && !p.aprovar) throw erro('Relatório já no Financeiro: só a Coordenação cancela', 403);
  r.status = 'cancelado'; fluxo(r, user, 'cancelar', t); r.totais = totais(r); salvarRel(); auditar({ usuario: user, ref: r.id, acao: 'cancelar', justificativa: t }); return r;
}
// ── processamento (Financeiro) ──
function registrarPagamento(id, key, body, user) {
  const r = obterRaw(id); if (!perm(user).processar) throw erro('Só o Financeiro registra pagamentos', 403); if (!FIN_STATUS.includes(r.status)) throw erro('Relatório ainda não foi encaminhado ao Financeiro'); body = body || {};
  const i = r.itens.find(x => x.key === key && x.selecionado); if (!i) throw erro('Ocorrência não encontrada', 404); const st = String(body.status || ''); if (!PAG_TXT[st]) throw erro('Situação inválida');
  if (i.pagamento.status === 'pago' && st !== 'pago') throw erro('Pagamento já registrado como pago: alteração exige revisão formal (registre em observação e abra ocorrência)');
  if (st === 'pago') { if (!i.banco || i.banco.status !== 'apto') throw erro('Sem destino bancário validado para este funcionário (' + (i.banco ? i.banco.statusTxt : 'sem dados') + ')'); const pb = DB.paraPagamento(i.funcId); if (pb.bloqueado) throw erro('Funcionário com pagamento bloqueado para verificação: não é possível registrar como pago'); if (!dataOk(body.data)) throw erro('Informe a data do pagamento'); }
  const antes = { ...i.pagamento };
  i.pagamento = { status: st, statusTxt: PAG_TXT[st], data: dataOk(body.data) ? body.data : null, modalidade: txt(body.modalidade, 20) || (i.banco && i.banco.modalidade) || null, transacao: txt(body.transacao, 80) || null, comprovante: txt(body.comprovante, 120) || null, obs: txt(body.obs, 500) || null, ...quem(user), em: agoraIso() };
  const sel = r.itens.filter(x => x.selecionado); const pagos = sel.filter(x => x.pagamento.status === 'pago').length;
  r.status = pagos === sel.length ? 'pago' : pagos ? 'parcialmente_pago' : sel.some(x => x.pagamento.status === 'processando') ? 'em_processamento' : sel.every(x => ['falha', 'bloqueado', 'devolvido'].includes(x.pagamento.status)) ? 'processado' : 'encaminhado_financeiro';
  r.totais = totais(r); salvarRel(); auditar({ usuario: user, ref: r.id, item: key, acao: 'pagamento', justificativa: i.pagamento.obs, antes, depois: { status: st, data: i.pagamento.data, transacao: i.pagamento.transacao } });
  return { item: itemVisivel(i, user), totais: r.totais, status: r.status, statusTxt: STATUS_TXT[r.status] };
}
/** destino bancário mudou depois da aprovação e o pagamento ainda não saiu: revisão formal (snapshot anterior fica guardado) */
function revisarBanco(id, key, justificativa, user) {
  const r = obterRaw(id); if (!perm(user).processar) throw erro('Só o Financeiro revisa o destino bancário', 403); if (!FIN_STATUS.includes(r.status)) throw erro('Relatório não está no Financeiro');
  const i = r.itens.find(x => x.key === key && x.selecionado); if (!i) throw erro('Ocorrência não encontrada', 404); if (i.pagamento.status === 'pago') throw erro('Pagamento já realizado: não há o que revisar');
  const j = txt(justificativa, 500); if (j.length < 5) throw erro('Informe a justificativa da revisão');
  const anterior = i.banco; i.banco = snapshotBanco(i.funcId, r.id, user); i.pagamento = { status: i.banco.status === 'bloqueado' ? 'bloqueado' : 'pendente' }; r.revisoes.push({ em: agoraIso(), ...quem(user), item: key, justificativa: j, anterior: anterior ? { contaId: anterior.contaId, versao: anterior.versao, status: anterior.status, resumo: anterior.resumo } : null, novo: { contaId: i.banco.contaId, versao: i.banco.versao, status: i.banco.status } });
  r.totais = totais(r); salvarRel(); auditar({ usuario: user, ref: r.id, item: key, acao: 'revisao_banco', justificativa: j, antes: anterior ? anterior.contaId : null, depois: i.banco.contaId }); return { item: itemVisivel(i, user), totais: r.totais };
}
// ── consultas ──
function itemVisivel(i, user) { const { banco, ...resto } = i; if (!banco) return { ...resto, banco: null }; const { enc, ...b } = banco; return { ...resto, banco: perm(user).bancoCompleto && enc ? { ...b, dados: DB.decifrar(enc) } : b }; }
function relVisivel(r, user, resumo) { const { itens, ...resto } = r; const out = { ...resto, statusTxt: STATUS_TXT[r.status], qtdItens: itens.length, qtdSelecionados: itens.filter(i => i.selecionado).length }; if (!resumo) out.itens = itens.map(i => itemVisivel(i, user)); return out; }
function listar(q, user) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403); q = q || {};
  return relatorios().filter(r => podeVerRel(r, user)).filter(r => !q.loja || r.lojas.includes(+q.loja)).filter(r => !q.status || r.status === q.status).filter(r => !q.de || r.periodo.ate >= q.de).filter(r => !q.ate || r.periodo.de <= q.ate).filter(r => !q.tipo || r.itens.some(i => i.tipo === q.tipo && i.selecionado))
    .filter(r => !q.func || r.itens.some(i => semAcento(i.nome).includes(semAcento(q.func))) || r.id.toLowerCase().includes(String(q.func).toLowerCase())).sort((a, b) => b.em.localeCompare(a.em)).slice(0, +q.limite || 300).map(r => relVisivel(r, user, true));
}
function obter(id, user) { const r = obterRaw(id); if (!podeVerRel(r, user)) throw erro('Sem acesso a este relatório', 403); return relVisivel(r, user); }
function painel(q, user) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403); q = q || {}; const rs = relatorios().filter(r => podeVerRel(r, user) && r.status !== 'cancelado').filter(r => !q.loja || r.lojas.includes(+q.loja)).filter(r => !q.de || r.periodo.ate >= q.de).filter(r => !q.ate || r.periodo.de <= q.ate);
  const k = { emConferencia: 0, aguardando: 0, aprovados: 0, valorAprovado: 0, valorFinanceiro: 0, valorPago: 0, valorPendente: 0, bloqueados: 0, divergenciasPonto: 0, semTermo: 0, pendenciasBancarias: 0, relatorios: rs.length };
  for (const r of rs) { const t = r.totais || totais(r); if (['em_conferencia', 'devolvido'].includes(r.status)) k.emConferencia++; if (r.status === 'aguardando_aprovacao') k.aguardando++;
    if (FIN_STATUS.includes(r.status) || r.status === 'aprovado') { k.aprovados++; k.valorAprovado = r2(k.valorAprovado + t.geral); k.valorFinanceiro = r2(k.valorFinanceiro + t.geral); k.valorPago = r2(k.valorPago + t.pago); k.valorPendente = r2(k.valorPendente + t.geral - t.pago); k.bloqueados += r.itens.filter(i => i.selecionado && (i.pagamento.status === 'bloqueado' || (i.banco && i.banco.status === 'bloqueado'))).length; k.pendenciasBancarias += t.bancoPendente; }
    k.divergenciasPonto += t.pontoIncompleto; k.semTermo += t.semTermo; }
  return { ...k, recentes: rs.sort((a, b) => b.em.localeCompare(a.em)).slice(0, 8).map(r => relVisivel(r, user, true)) };
}
function pagamentosProgramados() { return relatorios().filter(r => r.previsaoPagamento && ['aguardando_aprovacao', 'aprovado', 'encaminhado_financeiro', 'em_processamento', 'parcialmente_pago'].includes(r.status)).map(r => ({ data: r.previsaoPagamento.data, hora: r.previsaoPagamento.hora, descricao: 'Pagamento domingos/feriados ' + r.id, relatorioId: r.id, origem: 'relatorio' })); }
DB.setFontePagamentos(pagamentosProgramados);
function historicoAuditoria(q, user) { if (!perm(user).ver) throw erro('Sem acesso', 403); q = q || {}; let arquivos = []; try { arquivos = fs.readdirSync(path.join(DIR, 'auditoria')).filter(f => f.endsWith('.jsonl')).sort().reverse(); } catch (e) {} const out = []; for (const f of arquivos.slice(0, 12)) for (const l of lerLinhas(path.join(DIR, 'auditoria', f))) { if (q.ref && l.ref !== q.ref) continue; if (q.acao && l.acao !== q.acao) continue; out.push(l); } return out.sort((a, b) => b.em.localeCompare(a.em)).slice(0, +q.limite || 300); }

// ── exportações ──
const fmtDestino = b => { if (!b || !b.dados) return b && b.resumo ? (b.resumo.modalidade === 'pix' ? 'Pix ' + b.resumo.pixMask : (b.resumo.banco + ' ag ' + b.resumo.agenciaMask + ' cc ' + b.resumo.contaMask)) : '—'; const d = b.dados; return d.modalidade === 'pix' ? 'Pix (' + (DB.TIPO_PIX[d.tipoChavePix] || d.tipoChavePix) + '): ' + d.chavePix : (d.banco + ' (' + d.codigoBanco + ') ag ' + d.agencia + (d.agenciaDigito ? '-' + d.agenciaDigito : '') + ' ' + (DB.TIPO_CONTA[d.tipoConta] || '') + ' ' + d.conta + (d.digito ? '-' + d.digito : '')); };
const cpfFmt = c => c && c.length === 11 ? c.slice(0, 3) + '.' + c.slice(3, 6) + '.' + c.slice(6, 9) + '-' + c.slice(9) : (c || '');
async function cpfDeItem(i, modo, deps) { return modo === 'financeiro' && deps ? cpfFmt(await deps.cpfDe(i.funcId)) : i.cpf_fim; }
function registrarExportacao(r, user, fmt, modo, loja) { r.exportacoes.push({ em: agoraIso(), ...quem(user), fmt, modo, loja: loja || null }); salvarRel(); auditar({ usuario: user, ref: r.id, acao: 'exportar', detalhe: { fmt, modo, loja: loja || null } }); }
async function pdf(id, opts, user, deps) {
  const r = obterRaw(id); if (!podeVerRel(r, user)) throw erro('Sem acesso', 403); const p = perm(user); const modo = opts.modo === 'financeiro' && p.exportarFinanceiro ? 'financeiro' : 'gerencial'; const loja = opts.loja ? +opts.loja : null;
  const itens = r.itens.filter(i => i.selecionado && (!loja || i.loja === loja)); const PDFDocument = require('pdfkit'); const LOGO = require('./logo-economico');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, info: { Title: 'Pagamento de domingos e feriados ' + r.id, Author: 'Econômico Supermercados' } }); const chunks = []; doc.on('data', c => chunks.push(c)); const fim = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 56, X = 28; const NAVY = '#14213D';
  const cab = () => { LOGO.desenhar(doc, X, 18, 64); doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('PAGAMENTO DE DOMINGOS E FERIADOS · ' + r.id + (modo === 'financeiro' ? ' · VIA FINANCEIRA' : ' · VIA GERENCIAL (dados bancários mascarados)'), X + 80, 22, { width: W - 80 });
    doc.font('Helvetica').fontSize(8).fillColor('#444').text('Econômico Supermercados · ' + (loja ? GP.LOJA_TXT[loja] : r.lojasTxt.join(', ')) + ' · período ' + dBR(r.periodo.de) + ' a ' + dBR(r.periodo.ate) + ' · emitido ' + new Date().toLocaleString('pt-BR') + ' por ' + (user.nome || user.usuario) + '\nConferência RH: ' + (r.conferencia ? r.conferencia.nome + ' em ' + new Date(r.conferencia.em).toLocaleString('pt-BR') : '—') + ' · Aprovação: ' + (r.aprovacao ? r.aprovacao.nome + ' em ' + new Date(r.aprovacao.em).toLocaleString('pt-BR') : '—') + ' · Situação: ' + STATUS_TXT[r.status], X + 80, 38, { width: W - 80 }); doc.y = 72; };
  cab(); const cols = [['Funcionário', 140], ['CPF', 70], ['Função', 88], ['Unid.', 30], ['Data', 46], ['Tipo', 40], ['Trabalho', 46], ['Passagem', 46], ['Total', 48], ['Destino bancário', 158], ['Situação', 74]]; const sx = []; let x = X; for (const [, w] of cols) { sx.push(x); x += w; }
  const linhaCab = () => { doc.rect(X, doc.y, W, 14).fill('#E6ECF4'); doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY); const y = doc.y + 4; cols.forEach(([t, w], k) => doc.text(t, sx[k] + 2, y, { width: w - 4, lineBreak: false, align: k >= 6 && k <= 8 ? 'right' : 'left' })); doc.y = y + 12; };
  linhaCab(); doc.font('Helvetica').fontSize(7).fillColor('#111'); let n = 0;
  for (const i of itens) { if (doc.y > doc.page.height - 60) { doc.addPage(); cab(); linhaCab(); doc.font('Helvetica').fontSize(7).fillColor('#111'); }
    const y = doc.y + 2; const sit = i.pagamento.status === 'pago' ? 'Pago' : i.banco ? ({ apto: 'Apto', bloqueado: 'BLOQUEADO', pendente: 'Pendente bancário' }[i.banco.status] || i.banco.statusTxt) : 'Aguard. aprovação'; const vals = [i.nome, await cpfDeItem(i, modo, deps), i.cargo, (GP.LOJA_TXT[i.loja] || '').split(' · ')[0], dBR(i.data), i.tipo === 'feriado' ? 'Feriado' : 'Domingo', brl(i.valorTrabalho), i.passagem.aplica ? brl(i.passagem.valor) : '—', brl(totalItem(i)), modo === 'financeiro' ? fmtDestino(i.banco && i.banco.enc ? { dados: DB.decifrar(i.banco.enc) } : i.banco) : fmtDestino(i.banco), sit];
    if (n % 2) doc.rect(X, y - 2, W, 13).fill('#F6F7F9'); doc.fillColor('#111'); vals.forEach((v, k) => doc.text(String(v), sx[k] + 2, y, { width: cols[k][1] - 4, lineBreak: false, align: k >= 6 && k <= 8 ? 'right' : 'left' })); doc.y = y + 11; n++; }
  const t = totais({ ...r, itens }); doc.moveDown(0.6); doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
  doc.text('Funcionários: ' + t.funcionarios + ' · Pagamentos: ' + t.itens + ' · Trabalho: ' + brl(t.trabalho) + ' · Passagens: ' + brl(t.passagens) + ' · TOTAL GERAL: ' + brl(t.geral) + (r.aprovacao ? ' · Apto: ' + brl(t.apto) + ' · Pendente bancário: ' + brl(t.pendente) + ' · Bloqueado: ' + brl(t.bloqueado) + ' · Pago: ' + brl(t.pago) : ''), X, doc.y, { width: W });
  if (t.porLoja.length > 1) { doc.font('Helvetica').fontSize(8).fillColor('#333'); for (const L of t.porLoja) doc.text(L.lojaTxt + ': ' + L.itens + ' pagamento(s) · trabalho ' + brl(L.trabalho) + ' · passagens ' + brl(L.passagens) + ' · subtotal ' + brl(L.geral), X, doc.y + 2, { width: W }); }
  doc.font('Helvetica-Oblique').fontSize(7).fillColor('#666').text('Valores são parâmetros administrativos da empresa, congelados na emissão deste relatório; sujeitos à conferência do Jurídico/RH quanto à legislação e à convenção coletiva. Funcionários bloqueados ou com pendência bancária NÃO estão aptos para transferência. Exportação registrada na auditoria.', X, doc.y + 8, { width: W });
  doc.end(); const buf = await fim; registrarExportacao(r, user, 'pdf', modo, loja); return buf;
}
async function xlsx(id, opts, user, deps) {
  const r = obterRaw(id); if (!podeVerRel(r, user)) throw erro('Sem acesso', 403); const p = perm(user); if (!p.exportarFinanceiro) throw erro('A planilha com dados bancários é só do Financeiro', 403); const loja = opts.loja ? +opts.loja : null;
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); wb.creator = 'Econômico Relatórios';
  const colunas = ['Unidade', 'Funcionário', 'CPF', 'Função', 'Data', 'Tipo', 'Trabalho', 'Passagem', 'Total', 'Modalidade', 'Banco', 'Código', 'Agência', 'Conta', 'Dígito', 'Tipo de conta', 'Chave Pix', 'Tipo Pix', 'Titular', 'CPF titular', 'Versão bancária', 'Validado em', 'Situação bancária', 'Situação pagamento', 'Pago em', 'Transação'];
  const grupos = { Aptos: i => i.banco && i.banco.status === 'apto', Pendentes: i => !i.banco || i.banco.status === 'pendente', Bloqueados: i => i.banco && i.banco.status === 'bloqueado' };
  for (const [nome, f] of Object.entries(grupos)) { const ws = wb.addWorksheet(nome); ws.columns = colunas.map(c => ({ header: c, key: c, width: c.length < 8 ? 12 : c.length + 6 })); ws.getRow(1).font = { bold: true };
    for (const i of r.itens.filter(x => x.selecionado && (!loja || x.loja === loja) && f(x))) { const d = i.banco && i.banco.enc ? DB.decifrar(i.banco.enc) : null; ws.addRow([i.lojaTxt, i.nome, await cpfDeItem(i, 'financeiro', deps), i.cargo, dBR(i.data), i.tipo, +i.valorTrabalho || 0, i.passagem.aplica ? +i.passagem.valor : 0, totalItem(i), d ? DB.MODALIDADE[d.modalidade] : '', d ? d.banco || '' : '', d ? d.codigoBanco || '' : '', d ? (d.agencia || '') + (d.agenciaDigito ? '-' + d.agenciaDigito : '') : '', d ? d.conta || '' : '', d ? d.digito || '' : '', d ? DB.TIPO_CONTA[d.tipoConta] || '' : '', d ? d.chavePix || '' : '', d ? DB.TIPO_PIX[d.tipoChavePix] || '' : '', d ? d.titular : '', d ? cpfFmt(d.cpfTitular) : '', i.banco ? i.banco.contaId + ' v' + i.banco.versao : '', i.banco && i.banco.validadoEm ? new Date(i.banco.validadoEm).toLocaleString('pt-BR') : '', i.banco ? i.banco.statusTxt : 'Aguardando aprovação', PAG_TXT[i.pagamento.status] || i.pagamento.status, i.pagamento.data ? dBR(i.pagamento.data) : '', i.pagamento.transacao || '']); }
    ['Trabalho', 'Passagem', 'Total'].forEach(c => ws.getColumn(c).numFmt = '"R$" #,##0.00'); }
  const res = wb.addWorksheet('Resumo'); const t = totais({ ...r, itens: r.itens.filter(x => !loja || x.loja === loja) });
  [['Relatório', r.id], ['Unidades', loja ? GP.LOJA_TXT[loja] : r.lojasTxt.join(', ')], ['Período', dBR(r.periodo.de) + ' a ' + dBR(r.periodo.ate)], ['Situação', STATUS_TXT[r.status]], ['Conferência RH', r.conferencia ? r.conferencia.nome + ' · ' + new Date(r.conferencia.em).toLocaleString('pt-BR') : ''], ['Aprovação', r.aprovacao ? r.aprovacao.nome + ' · ' + new Date(r.aprovacao.em).toLocaleString('pt-BR') : ''], ['Funcionários', t.funcionarios], ['Pagamentos', t.itens], ['Total trabalho', t.trabalho], ['Total passagens', t.passagens], ['Total geral', t.geral], ['Apto para pagamento', t.apto], ['Pendente bancário', t.pendente], ['Bloqueado', t.bloqueado], ['Pago', t.pago]].forEach(l => res.addRow(l)); res.getColumn(1).width = 24; res.getColumn(2).width = 60;
  for (const L of t.porLoja) res.addRow([L.lojaTxt, 'pagamentos ' + L.itens + ' · trabalho ' + L.trabalho + ' · passagens ' + L.passagens + ' · subtotal ' + L.geral]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer()); registrarExportacao(r, user, 'xlsx', 'financeiro', loja); return buf;
}

module.exports = { DIR, STATUS_TXT, PAG_TXT, DIV_TXT, FIN_STATUS, perm, lojasDe, valores, salvarValores, funcaoDe, valorPara, datasDoPeriodo, criar, reapurar, editarItem, incluirManual, enviar, aprovar, devolver, cancelar, registrarPagamento, revisarBanco, listar, obter, painel, historicoAuditoria, pdf, xlsx, pagamentosProgramados, totais };
