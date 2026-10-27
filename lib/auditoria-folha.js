'use strict';
// lib/auditoria-folha.js — DP / RH › Auditoria da Folha de Pagamento (27/10/2026).
// Auditoria PÓS-PAGAMENTO: a Coordenação Administrativa recebe dois PDFs por competência (adiantamento salarial e folha
// mensal), o módulo lê os dois, identifica cada funcionário no cadastro do PontoCerto, busca os pagamentos nas contas
// Itaú de cada loja (lib/itau-extrato.js, SÓ LEITURA — nada aqui movimenta dinheiro) e cruza documento × banco.
// Toda diferença vira uma divergência com protocolo (FOL-AAAA-NNNN), setor responsável (Financeiro ou RH/DP), prazo e
// histórico de tratativas. Tudo em data/auditoria-folha (gitignored): um JSON por competência + auditoria .jsonl por mês.
// Rotas em lib/auditoria-folha-rotas.js; tela em public/auditoria-folha.html. Permissões = central de pessoas (lib/gestao-pessoas.js).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const GP = require('./gestao-pessoas');

const DIR = process.env.AUDITORIA_FOLHA_DIR || path.join(__dirname, '..', 'data', 'auditoria-folha');
const P = { comp: c => path.join(DIR, 'competencias', c + '.json'), docs: c => path.join(DIR, 'docs', c), auditoria: m => path.join(DIR, 'auditoria', m + '.jsonl'), config: path.join(DIR, 'config.json') };
const LOJAS_FOLHA = [1, 2, 3, 4, 5, 6, 10];
const CONTA_LOJA = { 1: 'cahu', 2: 'muribeca', 3: 'ponte', 4: 'atacarejo', 5: 'portalarga', 6: 'jardimjordao' };   // CD (10) não tem API de extrato
const DOC_TIPOS = { adiantamento: 'Adiantamento salarial', folha: 'Folha mensal' };
const TIPO_TXT = {
  adiantamento_nao_pago: 'Adiantamento não pago', folha_nao_paga: 'Folha não paga',
  valor_inferior_adiantamento: 'Valor inferior (adiantamento)', valor_superior_adiantamento: 'Valor superior (adiantamento)',
  valor_inferior_folha: 'Valor inferior (folha)', valor_superior_folha: 'Valor superior (folha)',
  desconto_divergente: 'Desconto do adiantamento divergente', sem_cadastro: 'Funcionário sem cadastro no ponto',
  pagamento_nao_identificado: 'Pagamento não identificado', pagamento_duplicado: 'Pagamento em duplicidade',
};
// setor que responde por cada tipo (Tiago/prompt: Financeiro responde pelo pagamento; RH/DP pelo cadastro e pelos descontos)
const TIPO_SETOR = { adiantamento_nao_pago: 'financeiro', folha_nao_paga: 'financeiro', valor_inferior_adiantamento: 'financeiro', valor_superior_adiantamento: 'financeiro', valor_inferior_folha: 'financeiro', valor_superior_folha: 'financeiro', desconto_divergente: 'rh', sem_cadastro: 'rh', pagamento_nao_identificado: 'financeiro', pagamento_duplicado: 'financeiro' };
const SETOR_TXT = { financeiro: 'Financeiro', rh: 'RH/DP', coordenacao: 'Coordenação' };
const SIT_TXT = { aberta: 'Aberta', em_analise: 'Em análise', aguardando_retorno: 'Aguardando retorno', resposta_recebida: 'Resposta recebida', resolvida: 'Resolvida', improcedente: 'Improcedente' };
const SIT_FINAIS = ['resolvida', 'improcedente'];
const COMP_STATUS_TXT = { sem_documentos: 'Sem documentos', parcial: 'Documentos incompletos', importada: 'Documentos importados', conciliada: 'Conciliada', em_tratativa: 'Divergências em tratativa', encerrada: 'Encerrada' };
const CONFIG_PADRAO = {
  prazoDiasUteis: 3,            // prazo padrão de resposta da divergência
  toleranciaCentavos: 1,        // diferença <= R$ 0,01 não é divergência
  janelaAdiantamento: { diaDe: 10, diaAte: 31 },          // dentro do mês da competência
  janelaFolha: { diaDe: 25, diaAteMesSeguinte: 15 },     // do dia 25 da competência até o dia 15 do mês seguinte
};

const erro = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });
const dig = s => String(s || '').replace(/\D/g, '');
const r2 = n => Math.round((+n || 0) * 100) / 100;
const agoraIso = () => new Date().toISOString();
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const somaDias = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const somaDU = (d, n) => { let k = 0, x = d; while (k < n) { x = somaDias(x, 1); const w = new Date(x + 'T12:00:00').getDay(); if (w !== 0 && w !== 6) k++; } return x; };
const ultimoDia = c => new Date(+c.slice(0, 4), +c.slice(5, 7), 0).getDate();
const quem = u => ({ usuario: u ? u.usuario : null, nome: u ? (u.nome || u.usuario) : null });
const brl = n => (+n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
function appendLinha(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(obj) + '\n'); }
function lerLinhas(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } }
const compOk = c => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || ''))) throw erro('Competência inválida (use AAAA-MM)'); return c; };
const compTxt = c => ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'][+c.slice(5, 7) - 1] + '/' + c.slice(0, 4);

function config() { return { ...CONFIG_PADRAO, ...lerJson(P.config, {}) }; }
function salvarConfig(mud, user) {
  const p = perm(user); if (!p.configurar) throw erro('Só a Coordenação altera a configuração', 403);
  const c = config(); const antes = { ...c };
  if (mud.prazoDiasUteis != null) c.prazoDiasUteis = Math.max(1, Math.min(30, +mud.prazoDiasUteis || 3));
  if (mud.toleranciaCentavos != null) c.toleranciaCentavos = Math.max(0, Math.min(1000, +mud.toleranciaCentavos || 0));
  if (mud.janelaAdiantamento) c.janelaAdiantamento = { diaDe: Math.max(1, Math.min(31, +mud.janelaAdiantamento.diaDe || 10)), diaAte: Math.max(1, Math.min(31, +mud.janelaAdiantamento.diaAte || 31)) };
  if (mud.janelaFolha) c.janelaFolha = { diaDe: Math.max(1, Math.min(31, +mud.janelaFolha.diaDe || 25)), diaAteMesSeguinte: Math.max(1, Math.min(31, +mud.janelaFolha.diaAteMesSeguinte || 15)) };
  gravarJson(P.config, c); auditar({ usuario: user, acao: 'config', antes, depois: c }); return c;
}

// ── permissões (central de pessoas) ──
function perm(user) {
  const papeis = GP.papeisDe(user);
  const coord = GP.temPapel(user, 'coordenacao'), fin = GP.temPapel(user, 'financeiro'), rh = GP.temPapel(user, ...GP.RH), dir = GP.temPapel(user, 'diretoria');
  return { papeis, coord, fin, rh, dir, ver: coord || fin || rh || dir, importar: coord, conciliar: coord, encerrar: coord, configurar: coord,
    tratar: coord || fin || rh, setores: [coord && 'coordenacao', fin && 'financeiro', rh && 'rh'].filter(Boolean) };
}
function auditar(ev) { const em = agoraIso(); appendLinha(P.auditoria(em.slice(0, 7)), { id: crypto.randomUUID(), em, ...quem(ev.usuario), competencia: ev.competencia || null, ref: ev.ref || null, acao: ev.acao, justificativa: ev.justificativa || null, antes: ev.antes == null ? null : ev.antes, depois: ev.depois == null ? null : ev.depois, detalhe: ev.detalhe || null }); }

// ── competência ──
function novaComp(c) { return { competencia: c, criadaEm: agoraIso(), documentos: { adiantamento: null, folha: null }, funcionarios: [], naoIdentificados: [], divergencias: [], conciliacao: null, evolucao: [], historico: [], encerramento: null, seq: 0 }; }
function obterRaw(c) { compOk(c); return lerJson(P.comp(c), null) || novaComp(c); }
function salvar(r) { gravarJson(P.comp(r.competencia), r); }
function competencias() { try { return fs.readdirSync(path.join(DIR, 'competencias')).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort().reverse(); } catch (e) { return []; } }
function fluxo(r, user, acao, detalhe) { r.historico.push({ em: agoraIso(), ...quem(user), acao, detalhe: detalhe || null }); }
function statusComp(r) {
  if (r.encerramento) return 'encerrada';
  const nd = ['adiantamento', 'folha'].filter(t => r.documentos[t]).length; if (!nd) return 'sem_documentos'; if (nd === 1 && !r.conciliacao) return 'parcial';
  if (!r.conciliacao) return 'importada';
  return r.divergencias.some(d => !SIT_FINAIS.includes(d.situacao)) ? 'em_tratativa' : 'conciliada';
}

// ── leitura dos PDFs da folha ──
// O layout dos relatórios do sistema de folha varia; o leitor é por LINHA: pega a última moeda da linha como líquido,
// a sequência de palavras maiúsculas como nome, um número de 1 a 7 dígitos antes do nome como matrícula e um CPF se houver.
// Linhas sem nome ou sem valor são ignoradas; cabeçalhos/totais ("TOTAL", "LÍQUIDO", "PÁGINA") também. A prévia mostra o que
// foi reconhecido pra Coordenação conferir antes de confirmar.
const RE_MOEDA = /-?\d{1,3}(?:\.\d{3})*,\d{2}(?!\d)/g, RE_CPF = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/;
const IGNORAR = /\b(TOTAL|TOTAIS|SUBTOTAL|PAGINA|PÁGINA|LIQUIDO A PAGAR|RESUMO|CENTRO DE CUSTO|EMPRESA|CNPJ|COMPETENCIA|COMPETÊNCIA|FOLHA DE PAGAMENTO|ADIANTAMENTO SALARIAL|EMITIDO|PROVENTOS|DESCONTOS|VENCIMENTOS)\b/i;
const moedaNum = s => r2(parseFloat(String(s).replace(/\./g, '').replace(',', '.')));
function linhasDoTexto(texto) {
  const out = []; const linhas = String(texto || '').split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i].replace(/\s+/g, ' ').trim(); if (!l || IGNORAR.test(l.replace(RE_MOEDA, ''))) continue;
    const moedas = l.match(RE_MOEDA) || []; if (!moedas.length) continue;
    const cpfM = l.match(RE_CPF); const cpf = cpfM ? dig(cpfM[0]) : '';
    let s = l.replace(RE_MOEDA, ' ').replace(RE_CPF, ' ').replace(/\d{2}\/\d{2}\/\d{4}/g, ' ');
    const nomeM = s.match(/([A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`.]+(?:\s+(?:D[AEIO]S?|E|[A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`.]+)){1,9})/); if (!nomeM) continue;
    const nome = nomeM[1].replace(/\s+(D[AEIO]S?|E)$/, '').trim(); if (nome.replace(/[^A-ZÀ-ÚÇ]/g, '').length < 5) continue;
    const antes = s.slice(0, nomeM.index); const matM = antes.match(/(\d{1,7})\s*$/) || antes.match(/^\s*(\d{1,7})\b/); const matricula = matM ? matM[1].replace(/^0+(?=\d)/, '') : '';
    const vals = moedas.map(moedaNum); const valor = vals[vals.length - 1]; if (!(valor > 0)) continue;
    out.push({ n: out.length + 1, linhaPdf: i + 1, nome: nome.toUpperCase(), matricula, cpf: cpf.length === 11 ? cpf : '', valor, valores: vals, texto: l.slice(0, 180) });
  }
  return out;
}
// ── contracheques (um bloco por funcionário) ──
// Tiago (27/10): a folha mensal chega como PDF de CONTRACHEQUES de uma loja (ex.: Socorro), um holerite por funcionário.
// Nesse formato o leitor por linha pegaria "SALARIO 1.500,00" como se fosse gente; então cada bloco termina no
// "LÍQUIDO" (a receber / a pagar / total) e dentro dele procuramos nome, matrícula, CPF e o desconto de adiantamento.
const RE_LIQUIDO = /(?:L[ÍI]QUIDO|L[ÍI]Q\.?|VALOR\s+L[ÍI]QUIDO|TOTAL\s+L[ÍI]QUIDO)\s*(?:A\s+RECEBER|A\s+PAGAR|TOTAL|DO\s+M[ÊE]S)?\s*[:.]?\s*(?:R\$)?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
const NAO_NOME = /\b(LTDA|EIRELI|S\/A|S\.A\.|ME\b|EPP|SUPERMERCADO|SUPERMERCADOS|ECONOMICO|ECONÔMICO|ATACAREJO|DISTRIBUIDORA|COMERCIO|COMÉRCIO|ALIMENTOS|CNPJ|CPF|EMPRESA|FILIAL|LOJA|RECIBO|PAGAMENTO|CONTRACHEQUE|HOLERITE|DEMONSTRATIVO|SALARIO|SALÁRIO|HORAS|EXTRAS?|INSS|IRRF|FGTS|VALE|TRANSPORTE|ADIANTAMENTO|DESCONTO|PROVENTOS|DESCONTOS|VENCIMENTOS|BASE|LIQUIDO|LÍQUIDO|TOTAL|FUNCAO|FUNÇÃO|CARGO|SETOR|DEPARTAMENTO|ADMISSAO|ADMISSÃO|COMPETENCIA|COMPETÊNCIA|MENSAL|FOLHA|FERIAS|FÉRIAS|FALTAS?|DSR|PERIODO|PERÍODO|BANCO|AGENCIA|AGÊNCIA|CONTA|CODIGO|CÓDIGO|DESCRICAO|DESCRIÇÃO|REFERENCIA|REFERÊNCIA|VALOR|QUANTIDADE|MATRICULA|MATRÍCULA|ASSINATURA|DATA|RUA|AVENIDA|AV\.|CEP|BAIRRO|CIDADE|PE\b|PERNAMBUCO|RECIFE|JABOATAO|JABOATÃO)\b/i;
const RE_NOME = /([A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`.]+(?:\s+(?:D[AEIO]S?|E|[A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`.]+)){1,9})/g;
// corta o "nome" no primeiro rótulo/palavra de folha ("MARIA JOSE DA SILVA CPF" → "MARIA JOSE DA SILVA"); precisa de 2+ palavras
function limparNome(n) {
  const ws = []; for (const w of String(n).trim().split(/\s+/)) { if (NAO_NOME.test(w)) break; ws.push(w); }
  while (ws.length && /^(D[AEIO]S?|E)$/.test(ws[ws.length - 1])) ws.pop();
  const out = ws.join(' '); return ws.length >= 2 && out.replace(/[^A-ZÀ-ÚÇ]/g, '').length >= 5 ? out : null;
}
const RE_ROTULO_NOME = /(?:NOME(?:\s+DO\s+(?:FUNCION[ÁA]RIO|COLABORADOR|EMPREGADO))?|FUNCION[ÁA]RIO|COLABORADOR|EMPREGADO)\s*[:.]\s*/i;
function nomeDoBloco(bloco) {
  // 1) rótulo explícito ("Nome: FULANO", "Funcionário: FULANO") — o rótulo pode vir em caixa baixa, o nome tem que vir em maiúsculas
  const rot = bloco.match(RE_ROTULO_NOME);
  if (rot) { const m = bloco.slice(rot.index + rot[0].length).match(/^([A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`.]+(?:\s+(?:D[AEIO]S?|E|[A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`.]+)){1,9})/); const n = m && limparNome(m[1]); if (n) return n; }
  // 2) a linha que tem o CPF ou a matrícula costuma ter o nome; rótulos "Palavra:" saem antes
  const cands = [];
  for (const l of bloco.split(/\r?\n/)) {
    const s = l.replace(RE_MOEDA, ' ').replace(RE_CPF, ' ').replace(/\d{2}\/\d{2}\/\d{4}/g, ' ').replace(/[A-Za-zÀ-ú.]+\s*:/g, ' ').replace(/\s+/g, ' ');
    let m; RE_NOME.lastIndex = 0;
    while ((m = RE_NOME.exec(s))) { const n = limparNome(m[1]); if (!n) continue; cands.push({ n, cpf: RE_CPF.test(l), mat: /MATR|REGISTRO|C[ÓO]D/i.test(l) }); }
  }
  const c = cands.find(x => x.cpf) || cands.find(x => x.mat) || cands[0]; return c ? c.n : null;
}
function blocosContracheque(texto) {
  const t = String(texto || ''); const out = []; let ini = 0, m; RE_LIQUIDO.lastIndex = 0;
  while ((m = RE_LIQUIDO.exec(t))) {
    const bloco = t.slice(ini, m.index + m[0].length); ini = m.index + m[0].length;
    const valor = moedaNum(m[1]); if (!(valor > 0)) continue;
    const nome = nomeDoBloco(bloco); if (!nome) continue;
    const cpfM = bloco.match(RE_CPF); const cpf = cpfM ? dig(cpfM[0]) : '';
    const matM = bloco.match(/(?:MATR[ÍI]CULA|MATR\.?|REGISTRO|C[ÓO]DIGO|C[ÓO]D\.?)\s*[:.]?\s*0*(\d{1,7})\b/i); const matricula = matM ? matM[1] : '';
    const adM = bloco.match(/ADIANTAMENTO[^\d\n]{0,40}?(\d{1,3}(?:\.\d{3})*,\d{2})(?!\d)/i); const descontoAdiantamento = adM ? moedaNum(adM[1]) : null;
    const moedas = (bloco.match(RE_MOEDA) || []).map(moedaNum);
    out.push({ n: out.length + 1, linhaPdf: t.slice(0, m.index).split('\n').length, nome: nome.toUpperCase(), matricula, cpf: cpf.length === 11 ? cpf : '', valor, valores: moedas.slice(-6), descontoAdiantamento, texto: bloco.replace(/\s+/g, ' ').trim().slice(-180) });
  }
  return out;
}
function pareceContracheque(texto) {
  const t = String(texto || ''); const liq = (t.match(RE_LIQUIDO) || []).length; if (!liq) return false;
  return /(PROVENTOS|VENCIMENTOS|DESCONTOS)/i.test(t) && (/(CONTRACHEQUE|HOLERITE|RECIBO DE PAGAMENTO|DEMONSTRATIVO DE PAGAMENTO)/i.test(t) || (t.match(RE_CPF) || []).length >= liq / 2);
}
// ── recibo do sistema de folha do Econômico (visto no PDF real de 27/10: "RECIBO MENSAL - CAHU") ──
// pdf-parse devolve o texto com o RÓTULO DEPOIS DO VALOR ("ALEXSANDRO DA SILVA" / "Nome do Funcionário", "66" / "Código"),
// uma página por funcionário com DUAS vias iguais, sem CPF, e os três totais vêm em ordem variável logo antes do cabeçalho
// "Código Descrição Referência Vencimentos Descontos". Como Vencimentos − Descontos = Líquido, achamos a trinca pela conta.
const MESES = { janeiro: '01', fevereiro: '02', marco: '03', março: '03', abril: '04', maio: '05', junho: '06', julho: '07', agosto: '08', setembro: '09', outubro: '10', novembro: '11', dezembro: '12' };
function competenciaDoTexto(texto) { const m = String(texto || '').match(/\b(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})\b/i); return m ? m[2] + '-' + MESES[m[1].toLowerCase()] : null; }
function pareceReciboRotuloDepois(texto) { return /Nome do Funcion[áa]rio/i.test(texto) && /Valor L[íi]quido/i.test(texto) && /C[óo]digo\s+Descri[çc][ãa]o/i.test(texto); }
function reciboDaPagina(textoPag, numPag) {
  const L = String(textoPag || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim());
  let nome = null, matricula = '', vias = 0; const nomes = new Set();
  L.forEach((l, i) => {
    if (/^Nome do Funcion[áa]rio/i.test(l) && i > 0) { vias++; const n = L[i - 1].replace(/\s*\(.*\)\s*$/, '').trim(); if (/^[A-ZÀ-ÚÇ][A-ZÀ-ÚÇ'`. ]+$/.test(n) && n.replace(/[^A-ZÀ-ÚÇ]/g, '').length >= 5) { nomes.add(n); if (!nome) nome = n; } }
    if (/^C[óo]digo$/i.test(l) && i > 0 && /^\d{1,7}$/.test(L[i - 1]) && !matricula) matricula = L[i - 1].replace(/^0+(?=\d)/, '');
  });
  if (!nome) return null;
  // trinca (venc, desc, liq) em alguma ordem, com max = soma dos outros dois, o mais perto possível ANTES de um cabeçalho "Código Descrição"
  const vals = []; L.forEach((l, i) => { for (const m of l.match(RE_MOEDA) || []) vals.push({ v: moedaNum(m), i }); });
  const cab = L.map((l, i) => /^C[óo]digo\s+Descri/i.test(l) ? i : -1).filter(i => i >= 0);
  let melhor = null;
  for (let k = 0; k + 2 < vals.length; k++) {
    const t = [vals[k].v, vals[k + 1].v, vals[k + 2].v]; const max = Math.max(...t); const resto = t.reduce((a, v) => a + v, 0) - max; if (max <= 0 || Math.abs(max - resto) > 0.011) continue;
    // a trinca certa é a que vem logo antes do cabeçalho (até 3 linhas); sem cabeçalho depois (via única no fim da página), vale a última trinca
    const fim = vals[k + 2].i; const dist = Math.min(99, ...cab.map(c => c > fim ? c - fim : 99));
    // ordem observada no PDF real: vencimentos, descontos, líquido; se descontos = 0 o líquido é o próprio total (os dois valores iguais)
    const liq = Math.abs(t[0] - t[1] - t[2]) <= 0.011 ? t[2] : Math.abs(t[0] - t[2] - t[1]) <= 0.011 ? t[1] : max - Math.min(...t);
    const cand = { venc: max, liq: liq > 0 ? liq : max, dist }; if (!melhor || cand.dist <= melhor.dist) melhor = cand;
  }
  if (!melhor) return { nome, matricula, erro: 'não achei os totais (vencimentos − descontos = líquido) na página ' + numPag };
  const ad = L.map(l => l.match(/ADIANT[^\d\n]*?(\d{1,3}(?:\.\d{3})*,\d{2})(?!\d)/i)).find(Boolean); const descontoAdiantamento = ad && !/ESTORNO|FERIAS|FÉRIAS/i.test(ad[0]) ? moedaNum(ad[1]) : null;
  return { nome, matricula, vias: vias || 1, valor: melhor.liq, valores: [melhor.venc, r2(melhor.venc - melhor.liq), melhor.liq], descontoAdiantamento, duasPessoas: nomes.size > 1, pagina: numPag, texto: nome + ' · código ' + (matricula || '—') + ' · venc. ' + melhor.venc.toFixed(2) + ' − desc. ' + r2(melhor.venc - melhor.liq).toFixed(2) + ' = líquido ' + melhor.liq.toFixed(2) };
}
function blocosReciboPaginas(pages) {
  const out = [], avisos = [];
  for (const p of pages || []) {
    const r = reciboDaPagina(p.text, p.num); if (!r) continue;
    if (r.erro) { avisos.push(r.erro + ' (' + r.nome + ')'); continue; }
    if (r.duasPessoas) avisos.push('Página ' + p.num + ' tem mais de um nome; usei ' + r.nome);
    // 2ª via do mesmo recibo (mesmo nome, mesmo líquido) = ignora; se o líquido for diferente, deixa pra prévia somar/avisar
    const igual = out.find(x => x.nome === r.nome && x.matricula === r.matricula && Math.abs(x.valor - r.valor) < 0.005); if (igual) { igual.vias += r.vias; continue; }
    out.push({ n: out.length + 1, linhaPdf: p.num, nome: r.nome.toUpperCase(), matricula: r.matricula, cpf: '', valor: r.valor, valores: r.valores, descontoAdiantamento: r.descontoAdiantamento, vias: r.vias, texto: r.texto });
  }
  return { linhas: out, avisos };
}
// Loja pelo CNPJ da empresa que aparece no recibo (Tiago 27/10: "quando eu envio era pra entender qual loja é"). Cada loja é
// uma empresa (mesma tabela de lib/conferencia-xml.js + CD de lib/recebimento-rotas.js). Se o PDF tiver mais de um CNPJ, não chuta.
const CNPJ_LOJA = { '21425302000181': 1, '30148015000162': 2, '39762002000153': 3, '43358448000194': 4, '51632927000185': 5, '59890722000101': 6, '61920643000148': 10 };
const fmtCnpj = c => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
function lojaDoTexto(texto) {
  const t = String(texto || ''); const achados = new Map();
  for (const m of t.match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g) || []) { const d = dig(m); if (CNPJ_LOJA[d]) achados.set(d, (achados.get(d) || 0) + 1); }
  if (!achados.size) return { loja: null, cnpj: null };
  const [cnpj] = [...achados.entries()].sort((a, b) => b[1] - a[1])[0];
  const emp = (t.match(/^([A-ZÀ-Ú][A-ZÀ-Ú0-9&.' ]{4,}(?:LTDA|EIRELI|S\/A|S\.A\.|ME|EPP)\.?)\s*$/m) || [])[1] || null;
  return { loja: CNPJ_LOJA[cnpj], cnpj, cnpjTxt: fmtCnpj(cnpj), empresa: emp, varios: achados.size > 1, cnpjs: [...achados.keys()].map(c => fmtCnpj(c) + ' (' + lojaTag(CNPJ_LOJA[c]) + ')') };
}
async function lerPdf(buffer) {
  const { PDFParse } = require('pdf-parse'); let texto, pages;
  try { const p = new PDFParse({ data: buffer }); const r = await p.getText(); texto = r.text || ''; pages = r.pages || []; } catch (e) { throw erro('Não consegui ler o PDF: ' + e.message); }
  const competenciaDoc = competenciaDoTexto(texto); const lojaDoc = lojaDoTexto(texto);
  if (pareceReciboRotuloDepois(texto)) { const b = blocosReciboPaginas(pages); if (b.linhas.length) return { texto, linhas: b.linhas, avisos: b.avisos, formato: 'contracheque', competenciaDoc, lojaDoc, paginas: pages.length }; }
  if (pareceContracheque(texto)) { const linhas = blocosContracheque(texto); if (linhas.length) return { texto, linhas, formato: 'contracheque', competenciaDoc, lojaDoc, paginas: pages.length }; }
  return { texto, linhas: linhasDoTexto(texto), formato: 'lista', competenciaDoc, lojaDoc, paginas: pages.length };
}
async function lerXlsx(buffer) {
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); try { await wb.xlsx.load(buffer); } catch (e) { throw erro('Arquivo não é um .xlsx válido'); }
  const ws = wb.worksheets[0]; if (!ws || ws.rowCount < 2) throw erro('Planilha vazia');
  const cab = {}; ws.getRow(1).eachCell((c, i) => { cab[semAcento(c.text != null ? c.text : c.value).replace(/[^A-Z0-9]/g, '')] = i; });
  const col = (...ks) => ks.map(k => cab[k]).find(Boolean) || null; const iNome = col('NOME', 'NOMECOMPLETO', 'FUNCIONARIO', 'COLABORADOR'), iVal = col('VALOR', 'LIQUIDO', 'VALORLIQUIDO', 'LIQUIDOAPAGAR', 'TOTAL'), iMat = col('MATRICULA', 'REGISTRO', 'CODIGO'), iCpf = col('CPF'), iDesc = col('DESCONTOADIANTAMENTO', 'ADIANTAMENTO', 'DESCADIANTAMENTO');
  if (!iNome || !iVal) throw erro('A planilha precisa das colunas "Nome" e "Valor" (líquido) na primeira linha');
  const out = []; const g = (row, i) => { if (!i) return ''; const cell = row.getCell(i); const v = cell.text != null && cell.text !== '' ? cell.text : cell.value; return v == null ? '' : String(typeof v === 'object' && v.result != null ? v.result : v).trim(); };
  const num = s => { const t = String(s).replace(/[R$\s]/g, ''); return /,\d{2}$/.test(t) ? moedaNum(t) : r2(parseFloat(t.replace(',', '.'))); };
  ws.eachRow((row, n) => { if (n === 1) return; const nome = semAcento(g(row, iNome)); const valor = num(g(row, iVal)); if (!nome || !(valor > 0)) return; out.push({ n: out.length + 1, linhaPdf: n, nome, matricula: dig(g(row, iMat)).replace(/^0+(?=\d)/, ''), cpf: dig(g(row, iCpf)).length === 11 ? dig(g(row, iCpf)) : '', valor, valores: [valor], descontoAdiantamento: iDesc ? num(g(row, iDesc)) || null : null, texto: nome + ' ' + valor }); });
  return { texto: '', linhas: out };
}

// ── identificação no PontoCerto ──
function nomeBate(a, b) { const A = semAcento(a).split(' ').filter(w => w.length > 2), B = semAcento(b).split(' ').filter(w => w.length > 2); if (!A.length || !B.length || A[0] !== B[0]) return false; return A.filter(w => B.includes(w)).length >= Math.min(3, A.length, B.length); }
async function identificar(linhas, deps) {
  const col = await deps.colaboradores(); const todos = [...col.ativos, ...col.desligados];
  const porMat = new Map(), porNome = new Map(); for (const c of todos) { if (c.matricula) porMat.set(String(c.matricula).replace(/^0+(?=\d)/, ''), c); porNome.set(semAcento(c.nome), c); }
  const cpfs = new Map(); if (deps.cpfDe) for (const c of todos) { const cpf = await deps.cpfDe(c.id); if (cpf) cpfs.set(cpf, c); }
  for (const l of linhas) {
    let c = null, como = null;
    if (l.cpf && cpfs.has(l.cpf)) { c = cpfs.get(l.cpf); como = 'cpf'; }
    if (!c && l.matricula && porMat.has(l.matricula)) { const m = porMat.get(l.matricula); if (nomeBate(m.nome, l.nome) || semAcento(m.nome).split(' ')[0] === semAcento(l.nome).split(' ')[0]) { c = m; como = 'matricula'; } }
    if (!c && porNome.has(semAcento(l.nome))) { c = porNome.get(semAcento(l.nome)); como = 'nome'; }
    if (!c) { const cand = todos.filter(x => nomeBate(x.nome, l.nome)); if (cand.length === 1) { c = cand[0]; como = 'nome_aproximado'; } }
    if (c) { l.funcId = c.id; l.loja = c.loja || null; l.setor = c.setor || ''; l.cargo = c.cargo || ''; l.ativo = !!c.ativo; l.identificadoPor = como; if (!l.cpf && deps.cpfDe) l.cpf = await deps.cpfDe(c.id) || ''; if (!l.matricula && c.matricula) l.matricula = String(c.matricula); }
    else { l.funcId = null; l.loja = null; l.identificadoPor = null; }
  }
  return linhas;
}

// ── importação (prévia → confirmar) ──
const previas = new Map();   // token → { linhas, tipo, competencia, arquivo, buffer, em }
// Importação POR LOJA (Tiago, 27/10): cada PDF é de uma unidade (ex.: contracheques de Socorro). A loja escolhida na tela
// manda: todo funcionário do arquivo entra nessa loja (é dessa conta que o pagamento tem que sair), e se o cadastro do
// ponto diz outra loja a prévia avisa. Cada loja tem a sua versão do documento; importar E1 não mexe nas linhas de E2.
// Sem loja escolhida = documento consolidado (todas as lojas no mesmo arquivo), como era antes.
const lojaOk = l => { if (l == null || l === '') return null; const n = +l; if (!LOJAS_FOLHA.includes(n)) throw erro('Unidade inválida'); return n; };
const lojaTag = n => n ? (n === 10 ? 'CD' : 'E' + n) : 'todas';
async function importarPrevia(buffer, nomeArquivo, tipo, competencia, user, deps, loja) {
  const p = perm(user); if (!p.importar) throw erro('Só a Coordenação importa documentos da folha', 403);
  if (!DOC_TIPOS[tipo]) throw erro('Tipo do documento inválido (adiantamento ou folha)'); compOk(competencia);
  // loja: 'auto' (padrão) = pelo CNPJ do PDF · 'todas' = consolidado · número = escolhida na tela
  const modoLoja = loja == null || loja === '' || loja === 'auto' ? 'auto' : loja === 'todas' ? 'todas' : 'fixa'; loja = modoLoja === 'fixa' ? lojaOk(loja) : null;
  const r = obterRaw(competencia); if (r.encerramento) throw erro('Competência encerrada — reabra antes de importar');
  const ext = String(nomeArquivo || '').toLowerCase().split('.').pop();
  const lido = ext === 'xlsx' ? await lerXlsx(buffer) : await lerPdf(buffer);
  if (!lido.linhas.length) throw erro('Nenhuma linha "nome + valor" reconhecida no arquivo. Confira se o PDF tem texto (não é imagem escaneada) ou envie a planilha .xlsx com as colunas Nome e Valor.');
  await identificar(lido.linhas, deps);
  // mesma pessoa em duas linhas (ex.: quebra de página) = soma e avisa
  const vis = new Map(); const avisos = [...(lido.avisos || [])];
  // o PDF diz de que mês é ("Folha Mensal · Setembro de 2026"); se não bate com a competência escolhida, a tela oferece trocar
  const competenciaDoc = lido.competenciaDoc || null; const competenciaDiferente = !!(competenciaDoc && competenciaDoc !== competencia);
  if (competenciaDiferente) avisos.unshift('O documento é da competência ' + compTxt(competenciaDoc) + ', e você está importando em ' + compTxt(competencia) + '. A conciliação procura o pagamento pela janela da competência escolhida — confira antes de confirmar.');
  for (const l of lido.linhas) { const k = l.funcId ? 'f' + l.funcId : 'n' + semAcento(l.nome) + '|' + l.matricula; if (vis.has(k)) { const a = vis.get(k); a.valor = r2(a.valor + l.valor); a.duplicada = true; avisos.push('Linha ' + l.n + ' (' + l.nome + ') repetida — valores somados'); l.descartar = true; } else vis.set(k, l); }
  const linhas = lido.linhas.filter(l => !l.descartar);
  // loja pelo CNPJ da empresa do recibo (lojaDoTexto); no modo automático ela manda, no modo escolhido só avisa se for outra
  const LD = lido.lojaDoc || {}; let lojaOrigem = modoLoja === 'fixa' ? 'escolhida' : 'consolidado', lojaDiferente = false;
  if (modoLoja === 'auto') {
    if (LD.loja && !LD.varios) { loja = LD.loja; lojaOrigem = 'cnpj'; }
    else { lojaOrigem = LD.varios ? 'varios' : 'nao_detectada'; avisos.unshift(LD.varios ? 'O arquivo tem empresas de mais de uma loja (' + LD.cnpjs.join(', ') + ') — entra como consolidado, com a loja de cada funcionário vinda do ponto.' : 'Não achei o CNPJ de nenhuma loja no arquivo — entra como consolidado (loja de cada funcionário vinda do ponto). Se for de uma loja só, volte e escolha a unidade.'); }
  } else if (modoLoja === 'fixa' && LD.loja && !LD.varios && LD.loja !== loja) { lojaDiferente = true; avisos.unshift('O CNPJ do recibo é de ' + GP.LOJA_TXT[LD.loja] + ' (' + (LD.empresa || LD.cnpjTxt) + '), mas você escolheu ' + GP.LOJA_TXT[loja] + '.'); }
  const outraLoja = [];
  for (const l of linhas) { l.lojaPonto = l.loja || null; if (loja) { if (l.lojaPonto && l.lojaPonto !== loja) outraLoja.push(l); l.loja = loja; } }
  if (outraLoja.length) avisos.push(outraLoja.length + ' funcionário(s) estão em outra loja no cadastro do ponto (' + outraLoja.slice(0, 6).map(l => l.nome + ' → ' + lojaTag(l.lojaPonto)).join('; ') + (outraLoja.length > 6 ? '; …' : '') + '). Entram na auditoria como ' + lojaTag(loja) + ', que é a loja deste documento.');
  for (let i = 0; i < 5; i++) previas.forEach((v, k) => { if (Date.now() - v.em > 30 * 60000) previas.delete(k); });
  const token = crypto.randomBytes(12).toString('hex'); previas.set(token, { linhas, tipo, loja, formato: lido.formato || (ext === 'xlsx' ? 'xlsx' : 'lista'), competencia, arquivo: String(nomeArquivo || 'documento.' + ext).replace(/[\\/:*?"<>|]/g, '_'), buffer, em: Date.now(), usuario: user.usuario });
  const semCad = linhas.filter(l => !l.funcId).length; const d = r.documentos[tipo];
  auditar({ usuario: user, competencia, acao: 'importar_previa', detalhe: { tipo, loja, formato: lido.formato, arquivo: nomeArquivo, linhas: linhas.length, semCadastro: semCad } });
  return { token, tipo, tipoTxt: DOC_TIPOS[tipo], loja, lojaTxt: loja ? GP.LOJA_TXT[loja] : 'Todas as lojas', lojaOrigem, lojaDiferente, lojaDoc: LD.loja || null, lojaDocTxt: LD.loja ? GP.LOJA_TXT[LD.loja] : null, cnpjDoc: LD.cnpjTxt || null, empresaDoc: LD.empresa || null, formato: lido.formato || (ext === 'xlsx' ? 'xlsx' : 'lista'), competencia, competenciaDoc, competenciaDocTxt: competenciaDoc ? compTxt(competenciaDoc) : null, competenciaDiferente, paginas: lido.paginas || null, arquivo: nomeArquivo, total: r2(linhas.reduce((a, l) => a + l.valor, 0)), funcionarios: linhas.length, identificados: linhas.length - semCad, semCadastro: semCad, outraLoja: outraLoja.length, avisos,
    substitui: !!(d && (loja ? (d.lojas && d.lojas[loja]) || d.linhas.some(l => l.loja === loja) : true)),
    linhas: linhas.map(l => ({ n: l.n, nome: l.nome, matricula: l.matricula, cpfFim: l.cpf ? '***' + l.cpf.slice(-4) : '', valor: l.valor, valores: l.valores, descontoAdiantamento: l.descontoAdiantamento || null, loja: l.loja, lojaPonto: l.lojaPonto, setor: l.setor, identificadoPor: l.identificadoPor, texto: l.texto })) };
}
function importarConfirmar(token, user) {
  const p = perm(user); if (!p.importar) throw erro('Só a Coordenação importa documentos da folha', 403);
  const pv = previas.get(token); if (!pv) throw erro('Prévia expirou (30 min) — envie o arquivo de novo', 410); previas.delete(token);
  const r = obterRaw(pv.competencia); if (r.encerramento) throw erro('Competência encerrada');
  const em = agoraIso(); const nomeArq = pv.tipo + (pv.loja ? '-' + lojaTag(pv.loja) : '') + '-' + em.replace(/[:.]/g, '-') + '.' + pv.arquivo.split('.').pop();
  fs.mkdirSync(P.docs(pv.competencia), { recursive: true }); fs.writeFileSync(path.join(P.docs(pv.competencia), nomeArq), pv.buffer);
  const anterior = r.documentos[pv.tipo];
  const novas = pv.linhas.map(l => ({ n: l.n, nome: l.nome, matricula: l.matricula, cpf: l.cpf, funcId: l.funcId, loja: l.loja, lojaPonto: l.lojaPonto || null, setor: l.setor, cargo: l.cargo, ativo: l.ativo, valor: l.valor, valores: l.valores, descontoAdiantamento: l.descontoAdiantamento || null, identificadoPor: l.identificadoPor }));
  const somaDe = ls => r2(ls.reduce((a, l) => a + l.valor, 0));
  let doc, versaoLoja = 1, substituiu = false;
  if (pv.loja) {
    // só as linhas desta loja são trocadas; as outras lojas ficam como estavam
    const antLoja = anterior && anterior.lojas && anterior.lojas[pv.loja]; substituiu = !!(antLoja || (anterior && anterior.linhas.some(l => l.loja === pv.loja)));
    versaoLoja = (antLoja ? antLoja.versao : 0) + 1;
    // documento anterior consolidado (sem loja, ex.: importação errada antes da versão por loja) sai inteiro; por loja, só a loja importada sai
    const mantidas = anterior && anterior.porLoja ? anterior.linhas.filter(l => l.loja !== pv.loja) : []; const linhas = [...mantidas, ...novas];
    const lojas = { ...((anterior && anterior.lojas) || {}) }; lojas[pv.loja] = { loja: pv.loja, arquivo: pv.arquivo, caminho: nomeArq, formato: pv.formato, importadoEm: em, ...quem(user), funcionarios: novas.length, total: somaDe(novas), semCadastro: novas.filter(l => !l.funcId).length, versao: versaoLoja };
    doc = { tipo: pv.tipo, porLoja: true, arquivo: pv.arquivo, caminho: nomeArq, formato: pv.formato, importadoEm: em, ...quem(user), funcionarios: linhas.length, total: somaDe(linhas), semCadastro: linhas.filter(l => !l.funcId).length, versao: (anterior ? anterior.versao : 0) + 1, lojas, linhas };
  } else {
    substituiu = !!anterior;
    doc = { tipo: pv.tipo, porLoja: false, arquivo: pv.arquivo, caminho: nomeArq, formato: pv.formato, importadoEm: em, ...quem(user), funcionarios: novas.length, total: somaDe(novas), semCadastro: novas.filter(l => !l.funcId).length, versao: (anterior ? anterior.versao : 0) + 1, lojas: {}, linhas: novas };
  }
  r.documentos[pv.tipo] = doc;
  r.importacoes = r.importacoes || []; r.importacoes.push({ em, ...quem(user), tipo: pv.tipo, loja: pv.loja, lojaTxt: pv.loja ? GP.LOJA_TXT[pv.loja] : 'Todas as lojas', formato: pv.formato, arquivo: pv.arquivo, funcionarios: novas.length, total: somaDe(novas), versao: pv.loja ? versaoLoja : doc.versao, substituiu });
  montarFuncionarios(r); r.conciliacao = null;   // documento novo = conciliação anterior não vale mais
  // divergência aberta que ninguém tocou (só a abertura) e cujo funcionário saiu dos documentos = lixo da importação anterior (ex.: leitor
  // antigo tomando "ABONO DE FERIAS" por gente); pagamentos não identificados sem tratativa também saem, a conciliação recria os que valem
  const keys = new Set(r.funcionarios.map(f => f.key)); const antes = r.divergencias.length;
  r.divergencias = r.divergencias.filter(d => !(d.situacao === 'aberta' && (d.tratativas || []).length <= 1 && (d.funcKey ? !keys.has(d.funcKey) : d.tipo === 'pagamento_nao_identificado')));
  const limpas = antes - r.divergencias.length; r.naoIdentificados = [];
  fluxo(r, user, 'importar', DOC_TIPOS[pv.tipo] + (pv.loja ? ' de ' + GP.LOJA_TXT[pv.loja] : '') + ' importado: ' + pv.arquivo + ' (' + novas.length + ' funcionários, ' + brl(somaDe(novas)) + (pv.formato === 'contracheque' ? ', contracheques' : '') + ')' + (substituiu ? ' — substituiu a versão anterior' : '') + (limpas ? ' · ' + limpas + ' divergência(s) sem tratativa da importação anterior removida(s)' : ''));
  salvar(r); auditar({ usuario: user, competencia: r.competencia, acao: 'importar', detalhe: { tipo: pv.tipo, loja: pv.loja, formato: pv.formato, arquivo: pv.arquivo, funcionarios: novas.length, total: somaDe(novas) } });
  return resumo(r, user);
}
/** junta as linhas dos dois documentos numa lista por funcionário (chave = funcId, senão nome normalizado + matrícula) */
function montarFuncionarios(r) {
  const m = new Map(); const chave = l => l.funcId ? 'f' + l.funcId : 'n' + semAcento(l.nome) + '|' + (l.matricula || '');
  const ant = new Map(r.funcionarios.map(f => [f.key, f]));
  for (const t of ['adiantamento', 'folha']) { const d = r.documentos[t]; if (!d) continue; for (const l of d.linhas) { const k = chave(l); let f = m.get(k); if (!f) { f = { key: k, nome: l.nome, matricula: l.matricula || '', cpf: l.cpf || '', funcId: l.funcId, loja: l.loja, lojaPonto: l.lojaPonto || null, setor: l.setor || '', cargo: l.cargo || '', ativo: l.ativo, adiantamento: null, folha: null }; m.set(k, f); } if (!f.loja && l.loja) f.loja = l.loja; f[t] = { previsto: l.valor, pago: (ant.get(k) && ant.get(k)[t] && ant.get(k)[t].pago) || null, lancamentos: (ant.get(k) && ant.get(k)[t] && ant.get(k)[t].lancamentos) || [], modo: (ant.get(k) && ant.get(k)[t] && ant.get(k)[t].modo) || null, descontoAdiantamento: l.descontoAdiantamento || null }; if (!f.cpf && l.cpf) f.cpf = l.cpf; } }
  r.funcionarios = [...m.values()].sort((a, b) => (a.loja || 99) - (b.loja || 99) || a.nome.localeCompare(b.nome));
}

// ── conciliação com o Itaú ──
function janelas(c, cfg) {
  const ud = ultimoDia(c); const prox = c.slice(5, 7) === '12' ? (+c.slice(0, 4) + 1) + '-01' : c.slice(0, 4) + '-' + String(+c.slice(5, 7) + 1).padStart(2, '0'); const udp = ultimoDia(prox);
  const dd = (m, d) => m + '-' + String(Math.min(d, m === c ? ud : udp)).padStart(2, '0');
  const hoje = hojeISO(); const cap = d => d > hoje ? hoje : d;
  return { adiantamento: { de: dd(c, cfg.janelaAdiantamento.diaDe), ate: cap(dd(c, cfg.janelaAdiantamento.diaAte)) }, folha: { de: dd(c, cfg.janelaFolha.diaDe), ate: cap(dd(prox, cfg.janelaFolha.diaAteMesSeguinte)) } };
}
/** A API de extrato do Itaú devolve o lote SISPAG Salários como UM evento type 'agrupamento' (só valor total e number_events,
 * sem favorecido/CPF); parseSaidasApi só lê type 'lancamento', então o lote da folha nunca aparecia (achado 27/10 na conciliação
 * de Pagamentos: lote de R$ 436,00 da E1 em 26/10 com 7 pessoas). Aqui o lote entra como saída categoria 'salario'. */
function lotesSalarioApi(bruto) {
  return (bruto && bruto.data || []).flatMap(d => d.events || [])
    .filter(e => e.type === 'agrupamento' && e.operation === 'D' && /^SISPAG SAL/i.test(((e.literal && (e.literal.shortened || e.literal.complete)) || '').trim()))
    .map(e => ({ data: e.date && e.date.accounting, historico: 'SISPAG SALARIOS (lote com ' + (e.number_events || '?') + ' lançamento(s))', valor: Math.abs(Number(e.amount && e.amount.value) || 0), categoria: 'salario', favorecido: null, documento: null, tipoDocumento: null, lancamentosNoLote: e.number_events || null }))
    .filter(e => e.data && e.valor > 0);
}
/** Índices de um subconjunto de `valores` com exatamente `n` itens (n null = qualquer tamanho ≥ 2) somando `alvo` (±tol).
 * Devolve o subconjunto só se ele for ÚNICO; null se não houver ou houver mais de um. Busca com poda (ordenado decrescente, soma
 * restante) e teto de nós pra nunca travar a thread do servidor com uma loja grande. */
function combinacaoUnica(valores, alvo, n, tol) {
  const it = valores.map((v, i) => ({ c: Math.round(v * 100), i })).sort((a, b) => b.c - a.c); const A = Math.round(alvo * 100), T = Math.round((tol || 0) * 100);
  const suf = new Array(it.length + 1).fill(0); for (let k = it.length - 1; k >= 0; k--) suf[k] = suf[k + 1] + it[k].c;
  const achados = []; let nos = 0; const sel = [];
  (function rec(k, cnt, soma) {
    if (achados.length > 1 || nos++ > 400000) return;
    if (Math.abs(soma - A) <= T && (n ? cnt === n : cnt >= 2)) { achados.push(sel.map(j => it[j].i)); return; }
    if (k >= it.length || soma - T > A || soma + suf[k] + T < A || (n && cnt >= n)) return;
    sel.push(k); rec(k + 1, cnt + 1, soma + it[k].c); sel.pop(); rec(k + 1, cnt, soma);
  })(0, 0, 0);
  return achados.length === 1 && nos <= 400000 ? achados[0] : null;
}
async function conciliar(c, user, deps, opts) {
  opts = opts || {}; const p = perm(user); if (!p.conciliar && !opts.sistema) throw erro('Só a Coordenação executa a conciliação', 403);
  const r = obterRaw(c); if (r.encerramento) throw erro('Competência encerrada'); if (!r.documentos.adiantamento && !r.documentos.folha) throw erro('Importe ao menos um documento antes de conciliar');
  const cfg = config(); const J = janelas(c, cfg); const tol = (cfg.toleranciaCentavos || 0) / 100;
  const itau = require('./itau-extrato'), parser = require('./extrato-parser');
  const de = J.adiantamento.de < J.folha.de ? J.adiantamento.de : J.folha.de, ate = J.folha.ate > J.adiantamento.ate ? J.folha.ate : J.adiantamento.ate;
  const em = agoraIso(); const res = { em, periodo: { de, ate }, janelas: J, lojas: [], semConta: [] }; const cands = [];
  // só as contas das lojas que têm documento importado (importação por loja); funcionário sem loja = procura em todas
  const lojasDoc = new Set(r.funcionarios.map(f => f.loja).filter(Boolean)); const todas = r.funcionarios.some(f => !f.loja) || !lojasDoc.size;
  for (const loja of [1, 2, 3, 4, 5, 6]) {
    const conta = CONTA_LOJA[loja]; const lojaTxt = GP.LOJA_TXT[loja];
    if (!todas && !lojasDoc.has(loja)) { res.lojas.push({ loja, lojaTxt, conta, semDocumento: true }); continue; }
    let saidas; try { const bruto = await (opts.extrato ? opts.extrato({ conta, dataInicio: de, dataFim: ate }) : itau.buscarExtrato({ conta, dataInicio: de, dataFim: ate })); saidas = [...parser.parseSaidasApi(bruto), ...lotesSalarioApi(bruto)]; } catch (e) { res.lojas.push({ loja, lojaTxt, conta, erro: e.message }); continue; }
    const cs = saidas.filter(s => !['tributo', 'tarifa_juros', 'aplicacao', 'cartao', 'pix_devolvido'].includes(s.categoria)).map((s, k) => ({ ...s, loja, conta, ref: conta + '|' + s.data + '|' + s.valor.toFixed(2) + '|' + (dig(s.documento) || semAcento(s.favorecido) || k) }));
    cands.push(...cs); res.lojas.push({ loja, lojaTxt, conta, saidas: cs.length, pessoaFisica: cs.filter(s => s.tipoDocumento === 'CPF').length, lotes: cs.filter(s => s.categoria === 'salario').length });
  }
  res.semConta.push({ loja: 10, lojaTxt: GP.LOJA_TXT[10], motivo: 'conta do CD sem API de extrato do Itaú — pagamentos do CD ficam como "não verificado"' });
  const usados = new Set(); const noJanela = (s, t) => s.data >= J[t].de && s.data <= J[t].ate;
  for (const f of r.funcionarios) for (const t of ['adiantamento', 'folha']) {
    const x = f[t]; if (!x) continue; x.pago = null; x.lancamentos = []; x.modo = null; x.situacao = null;
    if (f.loja === 10) { x.situacao = 'nao_verificado'; continue; }
    const livres = cands.filter(s => !usados.has(s.ref) && noJanela(s, t));
    const porCpf = f.cpf ? livres.filter(s => dig(s.documento) === f.cpf) : [];
    const exatos = porCpf.filter(s => Math.abs(s.valor - x.previsto) <= tol);
    let esc = null;
    if (exatos.length) { esc = exatos[0]; x.modo = 'CPF + valor'; }
    else if (porCpf.length === 1) { esc = porCpf[0]; x.modo = 'CPF (valor diferente)'; }
    else if (porCpf.length > 1) { const soma = r2(porCpf.reduce((a, s) => a + s.valor, 0)); if (Math.abs(soma - x.previsto) <= tol) { for (const s of porCpf) usados.add(s.ref); x.pago = soma; x.lancamentos = porCpf.map(lanc); x.modo = 'CPF (' + porCpf.length + ' lançamentos)'; x.situacao = 'pago'; continue; } esc = porCpf.sort((a, b) => Math.abs(a.valor - x.previsto) - Math.abs(b.valor - x.previsto))[0]; x.modo = 'CPF (vários lançamentos)'; }
    else { const porNome = livres.filter(s => !dig(s.documento) && nomeBate(s.favorecido, f.nome)); const ex = porNome.filter(s => Math.abs(s.valor - x.previsto) <= tol); if (ex.length === 1) { esc = ex[0]; x.modo = 'nome + valor'; } else if (porNome.length === 1) { esc = porNome[0]; x.modo = 'nome (valor diferente)'; } }
    if (esc) { usados.add(esc.ref); x.pago = esc.valor; x.lancamentos = [lanc(esc)]; x.situacao = Math.abs(esc.valor - x.previsto) <= tol ? 'pago' : (esc.valor < x.previsto ? 'inferior' : 'superior'); if (esc.loja !== f.loja && f.loja) x.outraLoja = esc.loja; }
    else x.situacao = 'nao_pago';
  }
  // lote SISPAG/folha com o subtotal da loja: quem ficou "não pago" naquela loja/documento é marcado "pago em lote" (sem conferência individual)
  for (const t of ['adiantamento', 'folha']) for (const loja of [1, 2, 3, 4, 5, 6]) {
    const pend = r.funcionarios.filter(f => f.loja === loja && f[t] && f[t].situacao === 'nao_pago'); if (!pend.length) continue;
    const sub = r2(r.funcionarios.filter(f => f.loja === loja && f[t]).reduce((a, f) => a + f[t].previsto, 0)), subPend = r2(pend.reduce((a, f) => a + f[t].previsto, 0));
    const lotes = cands.filter(s => s.loja === loja && !usados.has(s.ref) && noJanela(s, t) && (s.categoria === 'salario' || /SISPAG|FOLHA|SALARIO/i.test(s.historico)) && (Math.abs(s.valor - sub) <= tol || Math.abs(s.valor - subPend) <= tol));
    if (lotes.length === 1) { usados.add(lotes[0].ref); for (const f of pend) { f[t].pago = f[t].previsto; f[t].lancamentos = [lanc(lotes[0])]; f[t].modo = 'lote (' + brl(lotes[0].valor) + ')'; f[t].situacao = 'lote'; } continue; }
    // Caso real de E1 (set/26): o lote SISPAG de 30/09, R$ 11.379,04 com 11 lançamentos, era EXATAMENTE a soma do líquido de 11 dos 14
    // pendentes — a API só traz total + quantidade, sem nome/CPF. Então: lote com n lançamentos cuja soma bate com exatamente n
    // pendentes, numa combinação ÚNICA, marca esses n como "pago em lote". Mais de uma combinação possível = não chuta.
    for (const s of cands.filter(s => s.loja === loja && !usados.has(s.ref) && noJanela(s, t) && s.categoria === 'salario').sort((a, b) => b.valor - a.valor)) {
      const ainda = pend.filter(f => f[t].situacao === 'nao_pago'); if (ainda.length < 2) break;
      const combo = combinacaoUnica(ainda.map(f => f[t].previsto), s.valor, s.lancamentosNoLote || null, tol); if (!combo) continue;
      usados.add(s.ref); for (const i of combo) { const f = ainda[i]; f[t].pago = f[t].previsto; f[t].lancamentos = [lanc(s)]; f[t].modo = 'lote SISPAG ' + dBR(s.data) + ' (' + brl(s.valor) + ', ' + combo.length + ' pessoas, soma exata)'; f[t].situacao = 'lote'; }
    }
  }
  // pagamentos a pessoa física (ou lote de salário) que sobraram e não pertencem a ninguém dos documentos
  const cpfsDoc = new Set(r.funcionarios.map(f => f.cpf).filter(Boolean));
  r.naoIdentificados = cands.filter(s => !usados.has(s.ref) && (s.tipoDocumento === 'CPF' || s.categoria === 'salario') && !cpfsDoc.has(dig(s.documento))).map(s => ({ ...lanc(s), loja: s.loja, lojaTxt: GP.LOJA_TXT[s.loja], documento: dig(s.documento) ? '***.***.' + dig(s.documento).slice(6, 9) + '-' + dig(s.documento).slice(9) : null, janela: noJanela(s, 'folha') ? 'folha' : 'adiantamento' }));
  r.conciliacao = { em, ...quem(user), periodo: res.periodo, janelas: J, lojas: res.lojas, semConta: res.semConta, totais: null };
  gerarDivergencias(r, user, cfg); r.conciliacao.totais = totais(r);
  r.evolucao.push({ em, pct: r.conciliacao.totais.pct, pctAdiantamento: r.conciliacao.totais.adiantamento.pct, pctFolha: r.conciliacao.totais.folha.pct, divergencias: r.divergencias.filter(d => !SIT_FINAIS.includes(d.situacao)).length }); if (r.evolucao.length > 60) r.evolucao = r.evolucao.slice(-60);
  fluxo(r, user, 'conciliar', 'Conciliação executada: ' + r.conciliacao.totais.pct + '% conciliado, ' + r.divergencias.filter(d => !SIT_FINAIS.includes(d.situacao)).length + ' divergência(s) aberta(s)');
  salvar(r); auditar({ usuario: user, competencia: c, acao: 'conciliar', detalhe: { periodo: res.periodo, lojas: res.lojas.map(l => l.conta + ':' + (l.erro || l.saidas)), totais: r.conciliacao.totais } });
  return resumo(r, user);
}
const lanc = s => ({ ref: s.ref, data: s.data, valor: s.valor, favorecido: s.favorecido, historico: s.historico, categoria: s.categoria, conta: s.conta });

function gerarDivergencias(r, user, cfg) {
  const tol = (cfg.toleranciaCentavos || 0) / 100; const hoje = hojeISO(); const prazo = somaDU(hoje, cfg.prazoDiasUteis || 3);
  const ativas = new Map(r.divergencias.filter(d => !SIT_FINAIS.includes(d.situacao)).map(d => [d.chave, d])); const vistas = new Set();
  const fechadas = new Map(); for (const d of r.divergencias) if (SIT_FINAIS.includes(d.situacao)) fechadas.set(d.chave, d);   // última encerrada por chave
  const abrir = (chave, dados) => {
    vistas.add(chave); const ex = ativas.get(chave);
    if (ex) { Object.assign(ex, { diferenca: dados.diferenca, previsto: dados.previsto, pago: dados.pago, atualizadaEm: agoraIso() }); return; }
    // já foi encerrada (ex.: "pago posteriormente", "improcedente") e a diferença continua a mesma = não reabre a cada reconciliação
    const fe = fechadas.get(chave); if (fe && fe.tipo === dados.tipo && Math.abs((fe.diferenca || 0) - (dados.diferenca || 0)) <= tol) return;
    r.seq = (r.seq || 0) + 1; const protocolo = 'FOL-' + r.competencia.slice(0, 4) + '-' + String(r.seq).padStart(4, '0');
    r.divergencias.push({ protocolo, chave, ...dados, setor: TIPO_SETOR[dados.tipo], setorTxt: SETOR_TXT[TIPO_SETOR[dados.tipo]], situacao: 'aberta', abertaEm: agoraIso(), prazo, atualizadaEm: agoraIso(), tratativas: [{ em: agoraIso(), ...quem(user), acao: 'abertura', texto: 'Aberta pela conciliação automática' }], encerramento: null });
  };
  for (const f of r.funcionarios) {
    const base = { funcKey: f.key, funcId: f.funcId, nome: f.nome, matricula: f.matricula, loja: f.loja };
    if (!f.funcId) { const pg = ['adiantamento', 'folha'].filter(t => f[t] && ['pago', 'lote', 'inferior', 'superior'].includes(f[t].situacao)); abrir('sem_cadastro|' + f.key, { ...base, tipo: 'sem_cadastro', previsto: r2((f.adiantamento ? f.adiantamento.previsto : 0) + (f.folha ? f.folha.previsto : 0)), pago: r2(pg.reduce((a, t) => a + (f[t].pago || 0), 0)) || null, diferenca: null, descricao: 'Consta no documento da folha mas não foi encontrado no cadastro do PontoCerto (nome/matrícula/CPF). ' + (pg.length ? 'Há pagamento no banco com esse nome (' + pg.map(t => DOC_TIPOS[t].toLowerCase() + ' ' + brl(f[t].pago)).join(', ') + ').' : 'Nenhum pagamento localizado com esse nome.') }); continue; }
    for (const t of ['adiantamento', 'folha']) {
      const x = f[t]; if (!x || !x.situacao || x.situacao === 'nao_verificado') continue;
      if (x.situacao === 'nao_pago') abrir(t + '_nao_pago|' + f.key, { ...base, tipo: t === 'folha' ? 'folha_nao_paga' : 'adiantamento_nao_pago', documento: t, previsto: x.previsto, pago: 0, diferenca: r2(-x.previsto), descricao: 'Nenhum pagamento localizado no extrato Itaú da loja entre ' + dBR(r.conciliacao.janelas[t].de) + ' e ' + dBR(r.conciliacao.janelas[t].ate) });
      else if (x.situacao === 'inferior' || x.situacao === 'superior') abrir('valor_' + t + '|' + f.key, { ...base, tipo: 'valor_' + x.situacao + '_' + t, documento: t, previsto: x.previsto, pago: x.pago, diferenca: r2(x.pago - x.previsto), descricao: 'Documento ' + brl(x.previsto) + ' × banco ' + brl(x.pago) + ' (' + x.modo + ')' });
    }
    if (f.adiantamento && f.folha && f.folha.descontoAdiantamento != null && Math.abs(f.folha.descontoAdiantamento - f.adiantamento.previsto) > tol)
      abrir('desconto|' + f.key, { ...base, tipo: 'desconto_divergente', documento: 'folha', previsto: f.adiantamento.previsto, pago: f.folha.descontoAdiantamento, diferenca: r2(f.folha.descontoAdiantamento - f.adiantamento.previsto), descricao: 'Adiantamento pago ' + brl(f.adiantamento.previsto) + ' × desconto na folha ' + brl(f.folha.descontoAdiantamento) });
  }
  for (const s of r.naoIdentificados) abrir('nao_identificado|' + s.ref, { funcKey: null, funcId: null, nome: s.favorecido || '(sem favorecido)', matricula: '', loja: s.loja, tipo: 'pagamento_nao_identificado', documento: s.janela, previsto: 0, pago: s.valor, diferenca: s.valor, descricao: 'Pagamento de ' + brl(s.valor) + ' em ' + dBR(s.data) + ' (' + s.historico.slice(0, 60) + ') sem funcionário correspondente nos documentos', lancamento: s });
  // divergência que a nova conciliação não encontrou mais = resolvida automaticamente
  for (const d of r.divergencias) if (!SIT_FINAIS.includes(d.situacao) && !vistas.has(d.chave)) { d.situacao = 'resolvida'; d.encerramento = { em: agoraIso(), ...quem(user), conclusao: 'regularizada', justificativa: 'Não apareceu mais na reconciliação' }; d.tratativas.push({ em: agoraIso(), ...quem(user), acao: 'resolvida', texto: 'Resolvida automaticamente: a reconciliação não encontrou mais a diferença' }); d.atualizadaEm = agoraIso(); }
}
const dBR = s => s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '';

function totais(r) {
  const t = {}; for (const k of ['adiantamento', 'folha']) {
    const fs_ = r.funcionarios.filter(f => f[k]); const prev = r2(fs_.reduce((a, f) => a + f[k].previsto, 0)); const pago = r2(fs_.reduce((a, f) => a + (f[k].pago || 0), 0));
    const ok = fs_.filter(f => ['pago', 'lote'].includes(f[k].situacao)).length;
    t[k] = { funcionarios: fs_.length, previsto: prev, pago, diferenca: r2(pago - prev), conciliados: ok, lote: fs_.filter(f => f[k].situacao === 'lote').length, naoVerificado: fs_.filter(f => f[k].situacao === 'nao_verificado').length, pct: fs_.length ? Math.round(ok / fs_.length * 1000) / 10 : 0, importado: !!r.documentos[k] };
  }
  const n = r.funcionarios.length; const okTot = r.funcionarios.filter(f => ['adiantamento', 'folha'].every(k => !f[k] || ['pago', 'lote'].includes(f[k].situacao))).length;
  const abertas = r.divergencias.filter(d => !SIT_FINAIS.includes(d.situacao));
  return { funcionarios: n, previsto: r2(t.adiantamento.previsto + t.folha.previsto), pago: r2(t.adiantamento.pago + t.folha.pago), diferenca: r2(t.adiantamento.pago + t.folha.pago - t.adiantamento.previsto - t.folha.previsto), conciliados: okTot, pct: n ? Math.round(okTot / n * 1000) / 10 : 0, adiantamento: t.adiantamento, folha: t.folha,
    divergencias: abertas.length, divergenciasFinanceiro: abertas.filter(d => d.setor === 'financeiro').length, divergenciasRh: abertas.filter(d => d.setor === 'rh').length, prazoVencido: abertas.filter(d => d.prazo < hojeISO()).length, naoIdentificados: r.naoIdentificados.length };
}

// ── leitura pra tela ──
function docVisivel(d) { if (!d) return null; const { linhas, ...resto } = d; return resto; }
function veLojaA(user, loja) { const p = perm(user); if (p.coord || p.fin || p.dir || p.rh) return true; return GP.veLoja(user, loja); }
function funcVisivel(f) { return { ...f, cpf: f.cpf ? '***' + f.cpf.slice(-4) : '', situacao: f.adiantamento && f.folha ? (['pago', 'lote'].includes(f.adiantamento.situacao) && ['pago', 'lote'].includes(f.folha.situacao) ? 'ok' : 'divergente') : 'parcial' }; }
function resumo(r, user) {
  const p = perm(user); const hoje = hojeISO();
  const divs = r.divergencias.map(d => ({ ...d, situacaoTxt: SIT_TXT[d.situacao], tipoTxt: TIPO_TXT[d.tipo], setorTxt: SETOR_TXT[d.setor], lojaTxt: d.loja ? GP.LOJA_TXT[d.loja] : '—', vencida: !SIT_FINAIS.includes(d.situacao) && d.prazo < hoje, podeTratar: p.coord || p.setores.includes(d.setor) }));
  return { competencia: r.competencia, competenciaTxt: compTxt(r.competencia), status: statusComp(r), statusTxt: COMP_STATUS_TXT[statusComp(r)], documentos: { adiantamento: docVisivel(r.documentos.adiantamento), folha: docVisivel(r.documentos.folha) }, totais: r.conciliacao ? totais(r) : totais(r), conciliacao: r.conciliacao, funcionarios: r.funcionarios.map(funcVisivel), naoIdentificados: r.naoIdentificados, divergencias: divs, importacoes: r.importacoes || [], historico: r.historico, evolucao: r.evolucao, encerramento: r.encerramento, config: config() };
}
function obter(c, user) { const p = perm(user); if (!p.ver) throw erro('Sem acesso à Auditoria da Folha', 403); return resumo(obterRaw(c), user); }
function listar(user) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403);
  return competencias().map(c => { const r = obterRaw(c); const t = totais(r); return { competencia: c, competenciaTxt: compTxt(c), status: statusComp(r), statusTxt: COMP_STATUS_TXT[statusComp(r)], funcionarios: t.funcionarios, pct: t.pct, divergencias: t.divergencias, documentos: ['adiantamento', 'folha'].filter(k => r.documentos[k]) }; });
}
function arquivoDoc(c, tipo, user, loja) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403); const r = obterRaw(c); let d = r.documentos[tipo]; if (!d) throw erro('Documento não importado', 404);
  loja = lojaOk(loja); if (loja) { d = d.lojas && d.lojas[loja]; if (!d) throw erro('Documento de ' + GP.LOJA_TXT[loja] + ' não importado', 404); }
  const caminho = path.join(P.docs(c), d.caminho); if (!fs.existsSync(caminho)) throw erro('Arquivo não encontrado no servidor', 404);
  auditar({ usuario: user, competencia: c, acao: 'ver_documento', detalhe: { tipo, loja } }); return { caminho, nome: d.arquivo, pdf: /\.pdf$/i.test(d.caminho) };
}

// ── tratativas da divergência ──
function divDe(r, prot) { const d = r.divergencias.find(x => x.protocolo === prot); if (!d) throw erro('Divergência não encontrada', 404); return d; }
function exigeTratar(user, d) { const p = perm(user); if (!(p.coord || p.setores.includes(d.setor))) throw erro('Só a Coordenação ou o setor responsável (' + SETOR_TXT[d.setor] + ') trata esta divergência', 403); }
function tratar(c, prot, body, user) {
  const r = obterRaw(c); const d = divDe(r, prot); exigeTratar(user, d); if (r.encerramento) throw erro('Competência encerrada');
  const acao = String(body.acao || ''); const texto = String(body.texto || '').trim().slice(0, 2000); const em = agoraIso(); const antes = d.situacao;
  if (acao === 'comentar') { if (texto.length < 3) throw erro('Escreva a tratativa'); d.tratativas.push({ em, ...quem(user), acao: 'comentario', texto }); if (d.situacao === 'aberta') d.situacao = 'em_analise'; }
  else if (acao === 'analisar') { if (SIT_FINAIS.includes(d.situacao)) throw erro('Divergência já encerrada'); d.situacao = 'em_analise'; d.tratativas.push({ em, ...quem(user), acao: 'em_analise', texto: texto || 'Assumiu a análise' }); }
  else if (acao === 'solicitar_retorno') { if (SIT_FINAIS.includes(d.situacao)) throw erro('Divergência já encerrada'); if (texto.length < 3) throw erro('Descreva o que foi solicitado'); d.situacao = 'aguardando_retorno'; d.tratativas.push({ em, ...quem(user), acao: 'solicitacao', texto }); if (body.prazo && /^\d{4}-\d{2}-\d{2}$/.test(body.prazo)) d.prazo = body.prazo; }
  else if (acao === 'resposta') { if (SIT_FINAIS.includes(d.situacao)) throw erro('Divergência já encerrada'); if (texto.length < 3) throw erro('Escreva a resposta'); d.situacao = 'resposta_recebida'; d.tratativas.push({ em, ...quem(user), acao: 'resposta', texto }); }
  else if (acao === 'encaminhar') { const s = String(body.setor || ''); if (!SETOR_TXT[s]) throw erro('Setor inválido'); if (!perm(user).coord && !perm(user).setores.includes(d.setor)) throw erro('Sem permissão', 403); d.setor = s; d.setorTxt = SETOR_TXT[s]; d.situacao = 'aberta'; d.tratativas.push({ em, ...quem(user), acao: 'encaminhamento', texto: 'Encaminhada para ' + SETOR_TXT[s] + (texto ? ': ' + texto : '') }); }
  else if (acao === 'resolver' || acao === 'improcedente') { if (texto.length < 5) throw erro('Justifique a conclusão'); if (acao === 'resolver' && !perm(user).coord && !perm(user).setores.includes(d.setor)) throw erro('Sem permissão', 403); if (acao === 'improcedente' && !perm(user).coord) throw erro('Só a Coordenação classifica como improcedente', 403); d.situacao = acao === 'resolver' ? 'resolvida' : 'improcedente'; d.encerramento = { em, ...quem(user), conclusao: String(body.conclusao || (acao === 'resolver' ? 'regularizada' : 'improcedente')).slice(0, 40), justificativa: texto }; d.tratativas.push({ em, ...quem(user), acao: d.situacao, texto }); }
  else if (acao === 'reabrir') { if (!SIT_FINAIS.includes(d.situacao)) throw erro('Divergência não está encerrada'); if (!perm(user).coord) throw erro('Só a Coordenação reabre', 403); if (texto.length < 3) throw erro('Justifique a reabertura'); d.situacao = 'em_analise'; d.encerramento = null; d.prazo = somaDU(hojeISO(), config().prazoDiasUteis); d.tratativas.push({ em, ...quem(user), acao: 'reabertura', texto }); }
  else if (acao === 'prazo') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.prazo || ''))) throw erro('Data inválida'); if (!perm(user).coord) throw erro('Só a Coordenação altera o prazo', 403); d.tratativas.push({ em, ...quem(user), acao: 'prazo', texto: 'Prazo alterado de ' + dBR(d.prazo) + ' para ' + dBR(body.prazo) + (texto ? ': ' + texto : '') }); d.prazo = body.prazo; }
  else throw erro('Ação inválida');
  d.atualizadaEm = em; salvar(r); auditar({ usuario: user, competencia: c, ref: prot, acao: 'divergencia_' + acao, justificativa: texto || null, antes: { situacao: antes }, depois: { situacao: d.situacao, setor: d.setor } });
  return resumo(r, user).divergencias.find(x => x.protocolo === prot);
}
function encerrar(c, body, user) {
  const p = perm(user); if (!p.encerrar) throw erro('Só a Coordenação encerra a competência', 403); const r = obterRaw(c);
  if (r.encerramento) throw erro('Competência já encerrada'); if (!r.conciliacao) throw erro('Execute a conciliação antes de encerrar');
  const abertas = r.divergencias.filter(d => !SIT_FINAIS.includes(d.situacao)); const texto = String((body || {}).justificativa || '').trim().slice(0, 2000);
  if (abertas.length && texto.length < 10) throw erro('Há ' + abertas.length + ' divergência(s) aberta(s): justifique o encerramento (mín. 10 caracteres) ou resolva-as antes');
  r.encerramento = { em: agoraIso(), ...quem(user), justificativa: texto || null, divergenciasAbertas: abertas.length, totais: totais(r) };
  fluxo(r, user, 'encerrar', 'Competência encerrada' + (abertas.length ? ' com ' + abertas.length + ' divergência(s) aberta(s): ' + texto : '')); salvar(r);
  auditar({ usuario: user, competencia: c, acao: 'encerrar', justificativa: texto || null, detalhe: r.encerramento.totais }); return resumo(r, user);
}
function reabrir(c, body, user) {
  const p = perm(user); if (!p.encerrar) throw erro('Só a Coordenação reabre a competência', 403); const r = obterRaw(c); if (!r.encerramento) throw erro('Competência não está encerrada');
  const texto = String((body || {}).justificativa || '').trim().slice(0, 2000); if (texto.length < 5) throw erro('Justifique a reabertura');
  r.encerramento = null; fluxo(r, user, 'reabrir', 'Competência reaberta: ' + texto); salvar(r); auditar({ usuario: user, competencia: c, acao: 'reabrir', justificativa: texto }); return resumo(r, user);
}
function auditoria(c, user) { const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403); let out = []; try { for (const f of fs.readdirSync(path.join(DIR, 'auditoria')).sort().reverse().slice(0, 6)) out.push(...lerLinhas(path.join(DIR, 'auditoria', f))); } catch (e) {} return out.filter(e => !c || e.competencia === c).sort((a, b) => b.em.localeCompare(a.em)).slice(0, 500); }

// ── relatórios (xlsx + pdf) ──
async function xlsxCompetencia(c, user) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403); const r = obterRaw(c); const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); wb.creator = 'Econômico Relatórios';
  const cab = (ws, cols) => { ws.columns = cols.map(([h, w]) => ({ header: h, width: w })); ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF6D9' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };
  const sit = x => !x ? '—' : ({ pago: 'Pago', lote: 'Pago em lote', inferior: 'Valor inferior', superior: 'Valor superior', nao_pago: 'Não pago', nao_verificado: 'Não verificado (CD)' })[x.situacao] || x.situacao || 'Não conciliado';
  const w1 = wb.addWorksheet('Consolidado'); cab(w1, [['Loja', 8], ['Matrícula', 10], ['Funcionário', 36], ['Setor', 18], ['Adiant. previsto', 14], ['Adiant. pago', 14], ['Situação adiant.', 18], ['Folha prevista', 14], ['Folha paga', 14], ['Situação folha', 18], ['Diferença', 12]]);
  for (const f of r.funcionarios) w1.addRow([f.loja ? (f.loja === 10 ? 'CD' : 'E' + f.loja) : '—', f.matricula, f.nome, f.setor, f.adiantamento ? f.adiantamento.previsto : null, f.adiantamento ? f.adiantamento.pago : null, sit(f.adiantamento), f.folha ? f.folha.previsto : null, f.folha ? f.folha.pago : null, sit(f.folha), r2(((f.adiantamento && f.adiantamento.pago) || 0) + ((f.folha && f.folha.pago) || 0) - ((f.adiantamento && f.adiantamento.previsto) || 0) - ((f.folha && f.folha.previsto) || 0))]);
  [5, 6, 8, 9, 11].forEach(i => w1.getColumn(i).numFmt = '#,##0.00');
  const w2 = wb.addWorksheet('Divergências'); cab(w2, [['Protocolo', 14], ['Funcionário', 36], ['Matrícula', 10], ['Loja', 8], ['Tipo', 32], ['Setor', 12], ['Situação', 18], ['Previsto', 12], ['Pago', 12], ['Diferença', 12], ['Prazo', 12], ['Aberta em', 18], ['Descrição', 60]]);
  for (const d of r.divergencias) w2.addRow([d.protocolo, d.nome, d.matricula, d.loja ? (d.loja === 10 ? 'CD' : 'E' + d.loja) : '—', TIPO_TXT[d.tipo], SETOR_TXT[d.setor], SIT_TXT[d.situacao], d.previsto, d.pago, d.diferenca, dBR(d.prazo), d.abertaEm.slice(0, 16).replace('T', ' '), d.descricao]);
  [8, 9, 10].forEach(i => w2.getColumn(i).numFmt = '#,##0.00');
  const w3 = wb.addWorksheet('Não identificados'); cab(w3, [['Loja', 8], ['Data', 12], ['Valor', 12], ['Favorecido', 36], ['Documento', 16], ['Histórico', 60]]);
  for (const s of r.naoIdentificados) w3.addRow(['E' + s.loja, dBR(s.data), s.valor, s.favorecido, s.documento || '', s.historico]); w3.getColumn(3).numFmt = '#,##0.00';
  auditar({ usuario: user, competencia: c, acao: 'exportar_xlsx' }); return Buffer.from(await wb.xlsx.writeBuffer());
}
function pdfCompetencia(c, user) {
  const p = perm(user); if (!p.ver) throw erro('Sem acesso', 403); const r = obterRaw(c); const t = totais(r); const PDFDocument = require('pdfkit'); const logo = require('./logo-economico');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'Auditoria da Folha · ' + compTxt(c), Author: 'Econômico Supermercados', Creator: 'Econômico Relatórios' } }); const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    try { logo.desenhar(doc, 40, 32, 110); } catch (e) {}
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#0E1626').text('Auditoria da Folha de Pagamento', 170, 36); doc.font('Helvetica').fontSize(10).fillColor('#4E5A72').text('Competência ' + compTxt(c) + ' · ' + COMP_STATUS_TXT[statusComp(r)] + ' · emitido em ' + new Date().toLocaleString('pt-BR'), 170, 56);
    let y = 100; const linha = (l, v) => { doc.font('Helvetica').fontSize(10).fillColor('#4E5A72').text(l, 40, y, { width: 300 }); doc.font('Helvetica-Bold').fillColor('#0E1626').text(v, 340, y, { width: 215, align: 'right' }); y += 16; };
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0E1626').text('Resumo', 40, y); y += 18;
    linha('Funcionários nos documentos', String(t.funcionarios)); linha('Adiantamento previsto / pago (Itaú)', brl(t.adiantamento.previsto) + ' / ' + brl(t.adiantamento.pago)); linha('Folha mensal prevista / paga (Itaú)', brl(t.folha.previsto) + ' / ' + brl(t.folha.pago)); linha('Diferença da competência', brl(t.diferenca)); linha('Conciliação (funcionários sem diferença)', t.pct + '% (' + t.conciliados + ' de ' + t.funcionarios + ')'); linha('Divergências abertas', t.divergencias + ' (Financeiro ' + t.divergenciasFinanceiro + ' · RH/DP ' + t.divergenciasRh + ')'); linha('Pagamentos não identificados', String(t.naoIdentificados));
    y += 10; doc.font('Helvetica-Bold').fontSize(11).text('Divergências', 40, y); y += 18;
    const cols = [[40, 'Protocolo', 70], [110, 'Funcionário', 150], [260, 'Tipo', 120], [380, 'Setor', 50], [430, 'Situação', 65], [495, 'Diferença', 60]];
    const cab = () => { doc.font('Helvetica-Bold').fontSize(8).fillColor('#4E5A72'); for (const [x, h, w] of cols) doc.text(h, x, y, { width: w, align: x === 495 ? 'right' : 'left' }); y += 12; doc.moveTo(40, y).lineTo(555, y).strokeColor('#DADAD6').stroke(); y += 4; };
    cab(); doc.font('Helvetica').fontSize(8).fillColor('#0E1626');
    const divs = r.divergencias.slice().sort((a, b) => (SIT_FINAIS.includes(a.situacao) ? 1 : 0) - (SIT_FINAIS.includes(b.situacao) ? 1 : 0) || a.protocolo.localeCompare(b.protocolo));
    if (!divs.length) { doc.text('Nenhuma divergência registrada.', 40, y); y += 14; }
    for (const d of divs) { if (y > 780) { doc.addPage(); y = 40; cab(); doc.font('Helvetica').fontSize(8).fillColor('#0E1626'); } const vals = [d.protocolo, d.nome, TIPO_TXT[d.tipo], SETOR_TXT[d.setor], SIT_TXT[d.situacao], d.diferenca == null ? '—' : brl(d.diferenca)]; cols.forEach(([x, , w], i) => doc.text(vals[i], x, y, { width: w, align: x === 495 ? 'right' : 'left', lineBreak: false, ellipsis: true })); y += 13; }
    doc.end();
  }).then(buf => { auditar({ usuario: user, competencia: c, acao: 'exportar_pdf' }); return buf; });
}

module.exports = { DIR, TIPO_TXT, SETOR_TXT, SIT_TXT, SIT_FINAIS, DOC_TIPOS, COMP_STATUS_TXT, LOJAS_FOLHA, config, salvarConfig, perm, listar, obter, obterRaw, importarPrevia, importarConfirmar, conciliar, tratar, encerrar, reabrir, auditoria, arquivoDoc, xlsxCompetencia, pdfCompetencia, compTxt, hojeISO, _interno: { lerPdf, blocosReciboPaginas, competenciaDoTexto, lojaDoTexto, linhasDoTexto, identificar, montarFuncionarios, gerarDivergencias, totais, janelas, nomeBate, salvar, novaComp } };
