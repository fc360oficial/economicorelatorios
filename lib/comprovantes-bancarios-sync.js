'use strict';
// lib/comprovantes-bancarios-sync.js — sincronização AUTOMÁTICA da base de DP / RH › Comprovantes Bancários (04/11/2026, Tiago:
// "deixa isso automático"). Ninguém importa nada à mão: a cada ciclo o módulo monta pagamentos, guias, lotes e pendências a partir
// do que a empresa já tem, tudo SÓ LEITURA:
//   1. Auditoria da Folha (data/auditoria-folha) → salário e adiantamento de cada funcionário, com o comprovante SISPAG quando o
//      PDF do Itaú Empresas já foi lido lá, o débito do extrato ou o lote.
//   2. Pagamentos de Domingos e Feriados (data/pagamentos-df) → um pagamento por pessoa × dia dos relatórios que chegaram ao Financeiro.
//   3. Contas a pagar do ERP (loja20045.contasapagar, contas 12.20 / 12.7 / 8.1) → guias de FGTS, INSS, DARF e 13º; conta 12.8 →
//      rescisões. Histórico que não identifica a obrigação (Simples, ISS, sindicato, texto solto) NÃO entra: fica listado em
//      "não classificados" pro Financeiro ver.
//   4. Extrato Itaú das 6 contas (lib/itau-extrato.js) → débito candidato de cada guia e de cada rescisão. O CD não tem extrato.
// Regras do escopo: débito só SUGERE (guia nunca vira "paga" sozinha); lote sem detalhe nome a nome fica "comprovante indisponível";
// só o nome nunca confirma pagamento; nada aqui movimenta dinheiro. O que o Financeiro/RH fizer por cima (arquivar, tratar
// pendência) é preservado entre ciclos. Status do último ciclo em data/comprovantes-bancarios/sync.json.
const fs = require('fs');
const path = require('path');
const CB = require('./comprovantes-bancarios');
const GP = require('./gestao-pessoas');

const CONTA_LOJA = { 1: 'cahu', 2: 'muribeca', 3: 'ponte', 4: 'atacarejo', 5: 'portalarga', 6: 'jardimjordao' };
const SYNC = { usuario: 'sistema', nome: 'Sincronização automática', perfil: 'sistema' };
const QUEM = SYNC.nome;
const P = f => path.join(CB.DIR, f);
const DIAS_ERP_ATRAS = 120, DIAS_ERP_FRENTE = 60, DIAS_EXTRATO_MAX = 120;

let deps = { q: null, pontocerto: null, extrato: null, competencias: null, relatorios: null, titulos: null, colaboradores: null, agora: null };
let timer = null, rodando = false, ultimo = null, proximo = null;

// ── utilidades ──
const r2 = n => Math.round((+n || 0) * 100) / 100;
const dig = s => String(s || '').replace(/\D/g, '');
const pad = n => String(n).padStart(2, '0');
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const agoraIso = () => (deps.agora ? deps.agora() : new Date()).toISOString();
const hojeISO = () => { const d = deps.agora ? deps.agora() : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const somaDias = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const ultimoDia = c => { const [y, m] = c.split('-').map(Number); return c + '-' + pad(new Date(y, m, 0).getDate()); };
const dBR = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '—';
const brl = n => (+n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const cpfFmt = c => { const d = dig(c); return d.length === 11 ? d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9) : (c || ''); };
const titulo = s => String(s || '').toLowerCase().replace(/(^|\s)\S/g, t => t.toUpperCase());
const dataISO = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate()); const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const lerJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } };
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
function auditar(ev) { try { fs.mkdirSync(CB.DIR, { recursive: true }); fs.appendFileSync(P('auditoria.jsonl'), JSON.stringify({ em: agoraIso(), quem: QUEM, perfil: 'sistema', ...ev }) + '\n'); } catch (e) { /* auditoria nunca derruba o ciclo */ }
}
const hist = txt => ({ quem: QUEM, em: agoraIso().slice(0, 16).replace('T', ' '), txt });
/** nome do título do ERP (só o primeiro nome, às vezes) aparece no favorecido do extrato? */
function primeiroNomeBate(a, b) { const A = semAcento(a).split(' ').filter(w => w.length > 2), B = semAcento(b).split(' ').filter(w => w.length > 2); return !!(A.length && B.length && A[0] === B[0]); }
/** subconjunto ÚNICO de `valores` (2..max itens) que soma `alvo` (±tol); null se não houver ou houver mais de um */
function combinacaoUnica(valores, alvo, tol, max) {
  const it = valores.map((v, i) => ({ c: Math.round(v * 100), i })); const A = Math.round(alvo * 100), T = Math.round((tol || 0) * 100); const achados = []; const sel = []; let nos = 0;
  (function rec(k, soma) { if (achados.length > 1 || nos++ > 20000) return; if (sel.length >= 2 && Math.abs(soma - A) <= T) { achados.push(sel.map(j => it[j].i)); return; } if (k >= it.length || sel.length >= (max || 4) || soma - T > A) return; sel.push(k); rec(k + 1, soma + it[k].c); sel.pop(); rec(k + 1, soma); })(0, 0);
  return achados.length === 1 ? achados[0] : null;
}

// ── fontes (injetáveis nos testes) ──
function fontes() {
  const A = () => require('./auditoria-folha');
  return {
    competencias: deps.competencias || (() => { const a = A(); return a.competencias().map(c => ({ raw: a.obterRaw(c), janelas: null, dir: a.DIR })); }),
    relatorios: deps.relatorios || (() => require('./pagamentos-df')._interno.relatorios()),
    titulos: deps.titulos || (async (de, ate) => {
      if (!deps.q) throw new Error('consulta ao ERP não configurada (deps.q)');
      return deps.q(`SELECT c.nReg, c.Filial, c.PlanoGrupo, c.PlanoSub, c.DataEmissao, c.DataVencto, c.DataLancamento, c.Valor, c.Devedor, c.Acrescimo, c.Multa, c.Juros, c.Desconto, c.Historico, c.nDoc, c.Status, c.StatusLan, c.CompetenciaMes, c.CompetenciaAno, c.FormaPagamento,
                       (SELECT MAX(bc.DataDeposito) FROM loja20045.contasapagarbaixaconta bc WHERE bc.nReg = c.nReg) baixaEm
                     FROM loja20045.contasapagar c
                     WHERE ((c.PlanoGrupo = 12 AND c.PlanoSub IN (7, 8, 20)) OR (c.PlanoGrupo = 8 AND c.PlanoSub = 1)) AND c.DataVencto BETWEEN ? AND ?
                     ORDER BY c.DataVencto, c.nReg`, [de, ate], { timeoutMs: 60000 });
    }),
    extrato: deps.extrato || (args => require('./itau-extrato').buscarExtrato(args)),
    colaboradores: deps.colaboradores || (async () => { const pc = deps.pontocerto; if (!pc || !pc.colaboradores) return null; return pc.colaboradores(); }),
  };
}

/** arquivo gravado por outro módulo: caminho absoluto + tamanho em KB (mínimo 1) se existir; senão sem caminho (a tela avisa) */
function arquivoLocal(dir, rel) { if (!rel) return { caminho: null, kb: 0 }; const caminho = path.join(dir, rel); try { const st = fs.statSync(caminho); return st.isFile() ? { caminho, kb: Math.max(1, Math.round(st.size / 1024)) } : { caminho: null, kb: 0 }; } catch (e) { return { caminho: null, kb: 0 }; } }

// ── 1. Auditoria da Folha → salário / adiantamento ──
function deAuditoriaFolha(comps, out, cfgAF) {
  const cpfs = new Map(); let nComp = 0;
  for (const { raw: r, dir } of comps) {
    if (!r || !(r.funcionarios || []).length) continue; nComp++;
    const c = r.competencia; const J = (r.conciliacao && r.conciliacao.janelas) || null;
    const docsDir = path.join(dir || '', 'docs', c);
    const compsDia = new Map(); for (const cp of (r.comprovantes || [])) { const k = (cp.loja || 0) + '|' + cp.data; const g = compsDia.get(k) || { n: 0, total: 0 }; g.n++; g.total = r2(g.total + cp.valor); compsDia.set(k, g); }
    const divPor = new Map(); for (const d of (r.divergencias || [])) if (!['resolvida', 'encerrada', 'cancelada'].includes(d.situacao)) divPor.set(d.documento + '|' + d.funcKey, d);
    for (const f of r.funcionarios) {
      if (f.cpf) cpfs.set(String(f.funcId), f.cpf);
      for (const t of ['adiantamento', 'folha']) {
        const x = f[t]; if (!x) continue;
        const folha = t === 'folha'; const lanc = (x.lancamentos || [])[0] || null; const comp = !!(lanc && lanc.comprovante); const loja = f.loja || f.lojaPonto || null; const conta = CONTA_LOJA[loja];
        const id = 'PG-' + (folha ? 'F' : 'A') + '-' + c + '-' + f.key;
        let situacao, motivo = null, lote = null;
        const jan = J && J[t]; const fimJanela = jan ? jan.ate : (folha ? somaDias(ultimoDia(c), 15) : ultimoDia(c));
        switch (x.situacao) {
          case 'pago': situacao = 'liquidado'; break;
          case 'lote': situacao = 'comprovante_indisponivel'; motivo = 'Pago em lote SISPAG (' + (x.modo || 'soma da loja') + '): o banco só informa total e quantidade. O detalhe nome a nome vem do PDF de comprovantes do Itaú Empresas, lido na Auditoria da Folha.'; break;
          case 'inferior': case 'superior': situacao = 'divergente'; motivo = 'Valor pago (' + brl(x.pago) + ') difere do recibo (' + brl(x.previsto) + ') · ' + (x.modo || ''); break;
          case 'nao_verificado': situacao = 'comprovante_indisponivel'; motivo = 'Conta do CD sem extrato na API do Itaú: pagamento não verificado.'; break;
          case 'nao_pago': { const d = divPor.get(t + '|' + f.key); if (hojeISO() <= fimJanela) { situacao = 'aguardando_envio'; } else { situacao = 'divergente'; motivo = 'Nenhum débito localizado no extrato Itaú da loja até ' + dBR(fimJanela) + (d ? ' · divergência ' + d.protocolo + ' na Auditoria da Folha' : ''); } break; }
          default: situacao = 'aguardando_envio';
        }
        if (lanc && lanc.categoria === 'salario') { lote = 'LT-' + conta + '-' + lanc.data + '-' + Math.round(lanc.valor * 100); if (!out.lotes.has(lote)) out.lotes.set(lote, { id: lote, loja, descricao: lanc.historico, total: lanc.valor, qtdBanco: lanc.lancamentosNoLote || null, identificados: 0, data: lanc.data }); }
        if (comp) { const g = compsDia.get((lanc.loja || loja || 0) + '|' + lanc.data) || compsDia.get('0|' + lanc.data); lote = 'LT-' + conta + '-' + lanc.data + '-COMP'; if (!out.lotes.has(lote)) out.lotes.set(lote, { id: lote, loja, descricao: 'SISPAG SALARIOS · comprovantes do Itaú Empresas de ' + dBR(lanc.data), total: g ? g.total : lanc.valor, qtdBanco: g ? g.n : 1, identificados: 0, data: lanc.data }); out.lotes.get(lote).identificados++; }
        const docs = [];
        if (comp) { const cp = (r.comprovantes || []).find(z => z.ctrl === lanc.ctrl) || {}; const a = arquivoLocal(docsDir, cp.caminho); docs.push({ nome: lanc.arquivo || cp.arquivo || 'comprovante.pdf', classe: 'oficial', origem: 'Itaú Empresas · PDF de comprovantes lido na Auditoria da Folha · pág. ' + (lanc.pagina || cp.pagina || '?') + ' · CTRL ' + (lanc.ctrl || '?'), kb: a.kb, caminho: a.caminho, pagina: lanc.pagina || cp.pagina || null }); }
        const doc = r.documentos && r.documentos[t]; const dl = doc && ((doc.lojas && loja && doc.lojas[loja]) || doc); if (dl && dl.arquivo) { const a = arquivoLocal(docsDir, dl.caminho); docs.push({ nome: dl.arquivo, classe: 'demonstrativo', origem: 'Recibo de ' + (folha ? 'folha mensal' : 'adiantamento') + ' importado na Auditoria da Folha', kb: a.kb, caminho: a.caminho }); }
        const banco = lanc ? (situacao === 'divergente' ? 'falha' : 'ok') : (situacao === 'aguardando_envio' ? 'pendente' : 'falha');
        out.pagamentos.push({ id, origem: 'auditoria-folha', nome: f.nome, cpf: cpfFmt(f.cpf), idf: f.matricula ? 'Matrícula ' + f.matricula : (f.funcId ? 'PontoCerto ' + f.funcId : 'Sem cadastro'), funcId: f.funcId || null, loja, tipo: folha ? 'salario' : 'adiantamento', comp: c, sub: folha ? 'Folha mensal' : 'Adiantamento salarial', valor: x.previsto, pago: x.pago,
          prevista: folha ? ultimoDia(c) : c + '-' + pad(Math.min(15, +((cfgAF && cfgAF.janelaAdiantamento && cfgAF.janelaAdiantamento.diaAte) || 15))), efetiva: lanc ? lanc.data : null, idBanco: lanc ? (lanc.ctrl ? 'CTRL ' + lanc.ctrl : lanc.ref) : null, situacao, motivo, lote, docs, arquivado: false, pasta: null, guiaRel: null,
          cadeia: ['ok', comp ? 'ok' : 'na', banco, comp ? 'ok' : (situacao === 'liquidado' || situacao === 'comprovante_indisponivel' ? 'pendente' : 'na')], extratoRef: lanc && !comp && lanc.categoria !== 'salario' ? lanc.ref : null, hist: [hist('Importado da Auditoria da Folha · ' + CB.TIPOS[folha ? 'salario' : 'adiantamento'] + ' ' + c.slice(5, 7) + '/' + c.slice(0, 4) + ' · ' + (x.modo || 'sem conciliação ainda'))] });
      }
    }
  }
  return { competencias: nComp, cpfs };
}

// ── 2. Pagamentos Dom/Feriados ──
function deDomFer(rels, out, cpfs) {
  const PG = require('./pagamentos-df'); const totalItem = PG._interno.totalItem; let n = 0;
  const MAP = { pago: 'liquidado', processando: 'processamento', falha: 'rejeitado', devolvido: 'devolvido', bloqueado: 'divergente' };
  for (const r of rels || []) {
    if (!PG.FIN_STATUS.includes(r.status)) continue; n++;
    for (const i of r.itens || []) {
      if (!i.selecionado) continue; const pg = i.pagamento || {}; const st = MAP[pg.status] || (r.status === 'em_processamento' ? 'processamento' : 'aguardando_envio');
      const id = 'PG-DF-' + String(r.id).replace(/^PG-/, '') + '-' + i.funcId + '-' + String(i.data).replace(/-/g, '');
      const cpf = cpfs.get(String(i.funcId)) || null; const lote = pg.extratoRef && /lote SISPAG/i.test(pg.obs || '') ? 'LT-' + pg.extratoRef.split('|').slice(0, 2).join('-') + '-' + Math.round(parseFloat(pg.extratoRef.split('|')[2] || 0) * 100) : null;
      if (lote && !out.lotes.has(lote)) { const m = /lote com (\d+)/i.exec(pg.transacao || pg.obs || ''); out.lotes.set(lote, { id: lote, loja: i.loja, descricao: pg.transacao || 'SISPAG SALARIOS', total: parseFloat(pg.extratoRef.split('|')[2] || 0), qtdBanco: m ? +m[1] : null, identificados: 0, data: pg.data }); }
      const docs = pg.comprovante ? [{ nome: pg.comprovante.arquivo || pg.comprovante.nome || 'comprovante.pdf', classe: 'importado', origem: 'Anexado no Pagamentos de Domingos e Feriados', kb: pg.comprovante.kb || 0, caminho: null }] : [];
      out.pagamentos.push({ id, origem: 'pagamentos-df', nome: i.nome, cpf: cpf ? cpfFmt(cpf) : (i.cpf_fim || ''), idf: 'PontoCerto ' + i.funcId, funcId: i.funcId, loja: i.loja, tipo: 'domfer', comp: String(i.data).slice(0, 7), sub: (i.tipo === 'feriado' ? 'Feriado' : 'Domingo') + ' ' + dBR(i.data) + (i.nomeFeriado ? ' · ' + i.nomeFeriado : '') + ' · relatório ' + r.id, valor: totalItem(i), pago: st === 'liquidado' ? totalItem(i) : null,
        prevista: (r.previsaoPagamento && r.previsaoPagamento.data) || null, efetiva: pg.data || null, idBanco: pg.extratoRef || pg.transacao || null, situacao: st, motivo: pg.status === 'bloqueado' ? 'Pagamento bloqueado no módulo de Domingos e Feriados' + (pg.obs ? ': ' + pg.obs : '') : null, lote, docs, arquivado: false, pasta: null, guiaRel: null,
        cadeia: ['ok', r.aprovacao ? 'ok' : 'pendente', st === 'liquidado' ? 'ok' : (['rejeitado', 'devolvido', 'divergente'].includes(st) ? 'falha' : 'pendente'), docs.length ? 'ok' : (st === 'liquidado' ? 'pendente' : 'na')], extratoRef: lote ? null : (pg.extratoRef || null), hist: [hist('Importado de Pagamentos de Domingos e Feriados · ' + r.id + ' · ' + (PG.STATUS_TXT[r.status] || r.status) + (pg.obs ? ' · ' + pg.obs : ''))] });
    }
  }
  return { relatorios: n };
}

// ── 3. ERP → guias e rescisões ──
function classificarTitulo(t) {
  const g = +t.PlanoGrupo, s = +t.PlanoSub, h = semAcento(t.Historico);
  if (g === 12 && s === 8) return { kind: 'rescisao' };
  if (g === 12 && s === 7) return { kind: 'guia', tipo: 'fgts_rescisorio' };
  if (/SIMPLES|\bDAS\b|\bISS\b|SINDIC|RATEIO|\bPIS\b|COFINS|IRPJ|CSLL|ICMS|PREFEITURA|IMPOSTO/.test(h)) return { kind: 'ignorar', motivo: 'tributo comercial ou contribuição fora do DP/RH' };
  if (/FGT[SA]|FTGS/.test(h)) return { kind: 'guia', tipo: /RESCIS|GRRF|MULTA/.test(h) ? 'fgts_rescisorio' : 'fgts_mensal' };
  if (/\b13\b|DECIMO|13O/.test(h)) return { kind: 'guia', tipo: 'encargos_13' };
  if (/INSS|\bGPS\b|PREVID|DCTF/.test(h)) return { kind: 'guia', tipo: 'previdencia' };
  if (/IRRF|FOLHA/.test(h)) return { kind: 'guia', tipo: 'darf_folha' };
  // conta 8.1 (DARF) mistura imposto da empresa com retenção da folha: só entra quando o histórico diz a natureza
  if (g === 8) return { kind: 'ignorar', motivo: 'DARF sem natureza no histórico (pode ser imposto da empresa)' };
  if (/DARF/.test(h)) return { kind: 'guia', tipo: 'darf_folha' };
  return { kind: 'ignorar', motivo: 'histórico não identifica a obrigação' };
}
const ehFgts = tipo => /^fgts/.test(tipo);
const debitoServe = (tipo, s) => { const txt = semAcento((s.favorecido || '') + ' ' + (s.historico || '')); if (ehFgts(tipo)) return /CEF|CAIXA ECON|FGTS/.test(txt); return /DARF|GPS|INSS|RECEITA|TRIB|DCTF|PREVID/.test(txt) || s.categoria === 'tributo'; };

function deErp(titulos, out, colab) {
  const hoje = hojeISO(); const stats = { titulos: titulos.length, guias: 0, rescisoes: 0, ignorados: [] };
  const desligados = (colab && colab.desligados) || [];
  for (const t of titulos) {
    const cl = classificarTitulo(t); const loja = +t.Filial; const valor = r2(t.Valor); const venc = dataISO(t.DataVencto); const comp = t.CompetenciaAno && t.CompetenciaMes ? t.CompetenciaAno + '-' + pad(t.CompetenciaMes) : (venc || '').slice(0, 7);
    const baixaEm = dataISO(t.baixaEm); const baixado = r2(t.Devedor) === 0 || !!baixaEm; const atual = r2(valor + r2(t.Acrescimo) + r2(t.Multa) + r2(t.Juros) - r2(t.Desconto));
    if (cl.kind === 'ignorar') { stats.ignorados.push({ nReg: t.nReg, loja, lojaTxt: GP.LOJA_TXT[loja] || String(loja), conta: t.PlanoGrupo + '.' + t.PlanoSub, historico: String(t.Historico || '').trim(), valor, vencimento: venc, motivo: cl.motivo }); continue; }
    if (cl.kind === 'rescisao') {
      stats.rescisoes++; let nome = titulo(String(t.Historico || '').trim()) || 'Sem nome no título', cpf = '', idf = 'Título ERP ' + t.nReg, funcId = null;
      const cands = desligados.filter(d => +d.loja === loja && primeiroNomeBate(d.nome, t.Historico)); if (cands.length === 1) { nome = cands[0].nome; funcId = cands[0].id; idf = 'PontoCerto ' + cands[0].id; cpf = ''; }
      out.pagamentos.push({ id: 'PG-R-' + t.nReg, origem: 'erp', nome, cpf, idf, funcId, loja, tipo: 'rescisao', comp, sub: 'Rescisão · título ' + t.nReg + ' · ' + String(t.Historico || '').trim(), valor, pago: null, prevista: venc, efetiva: null, idBanco: null, situacao: 'aguardando_envio', motivo: null, lote: null, docs: [], arquivado: false, pasta: null, guiaRel: null, cadeia: ['ok', 'na', 'pendente', 'na'], extratoRef: null,
        erp: { nReg: t.nReg, historico: String(t.Historico || '').trim(), devedor: r2(t.Devedor), baixado, baixaEm, forma: t.FormaPagamento || null }, hist: [hist('Importado do contas a pagar do ERP · conta 12.8 Rescisão · título ' + t.nReg + (baixado ? ' · ERP dá o título como baixado' + (baixaEm ? ' em ' + dBR(baixaEm) : '') : ''))] });
      continue;
    }
    stats.guias++;
    out.guias.push({ id: 'GU-' + t.nReg, tipo: cl.tipo, comp, loja, valor, atualizado: Math.abs(atual - valor) > 0.009 ? atual : null, emissao: dataISO(t.DataEmissao) || dataISO(t.DataLancamento), vencimento: venc, pagamento: baixaEm, numero: 'Título ERP ' + t.nReg + (t.nDoc && dig(t.nDoc) !== String(Math.round(valor * 100)) ? ' · doc ' + t.nDoc : ''), origem: 'Contas a pagar do ERP · ' + String(t.Historico || '').trim() + ' · conta ' + t.PlanoGrupo + '.' + t.PlanoSub,
      situacao: venc && venc >= hoje ? 'aguardando' : 'vencida', motivo: null, semComprovante: false, coletiva: cl.tipo !== 'fgts_rescisorio', lote: null, docs: [], demonstrativo: [], conc: { crit: { identificador: 'nd', cnpj: 'nd', valor: 'nd', competencia: 'nd', data: 'nd' }, debitos: [], res: 'sem_debito' },
      erp: { nReg: t.nReg, historico: String(t.Historico || '').trim(), devedor: r2(t.Devedor), baixado, baixaEm, forma: t.FormaPagamento || null }, hist: [hist('Importada do contas a pagar do ERP · conta ' + t.PlanoGrupo + '.' + t.PlanoSub + ' · ' + String(t.Historico || '').trim() + (baixado ? ' · ERP dá o título como baixado' + (baixaEm ? ' em ' + dBR(baixaEm) : '') : ''))] });
  }
  return stats;
}

// ── 4. extrato Itaú → conciliação de guias e rescisões ──
async function lerExtratos(out, F) {
  const hoje = hojeISO(); const porLoja = new Map(); const res = [];
  const precisa = new Map();
  for (const g of out.guias) if (CONTA_LOJA[g.loja] && g.vencimento) precisa.set(g.loja, Math.min(precisa.get(g.loja) || Infinity, +new Date(somaDias(g.vencimento, -10) + 'T12:00:00')));
  for (const p of out.pagamentos) if (p.origem === 'erp' && CONTA_LOJA[p.loja] && p.prevista) precisa.set(p.loja, Math.min(precisa.get(p.loja) || Infinity, +new Date(somaDias(p.prevista, -10) + 'T12:00:00')));
  const parser = require('./extrato-parser');
  for (const [loja, ms] of precisa) {
    const conta = CONTA_LOJA[loja]; let de = new Date(ms).toISOString().slice(0, 10); const piso = somaDias(hoje, -DIAS_EXTRATO_MAX); if (de < piso) de = piso; if (de > hoje) de = hoje;
    try {
      const bruto = await F.extrato({ conta, dataInicio: de, dataFim: hoje });
      const saidas = parser.parseSaidasApi(bruto).map((s, k) => ({ ...s, loja, conta, ref: conta + '|' + s.data + '|' + s.valor.toFixed(2) + '|' + (dig(s.documento) || semAcento(s.favorecido) || k) }));
      porLoja.set(loja, saidas); res.push({ loja, lojaTxt: GP.LOJA_TXT[loja], conta, de, ate: hoje, saidas: saidas.length, paginas: bruto && bruto.pagination ? bruto.pagination.paginas_lidas : null });
    } catch (e) { res.push({ loja, lojaTxt: GP.LOJA_TXT[loja], conta, de, ate: hoje, erro: String(e.message || e).slice(0, 200) }); }
  }
  return { porLoja, lojas: res };
}
function conciliarGuias(out, ext, anteriores) {
  const hoje = hojeISO(); const usados = out.usados; const antigas = new Map((anteriores.guias || []).map(g => [g.id, g]));
  const tol = 0.009; const porGrupo = new Map();
  for (const g of out.guias) {
    if (g.loja === 10 || !CONTA_LOJA[g.loja]) { g.motivo = 'Conta do CD sem extrato na API do Itaú: conciliação só com comprovante importado.'; g.situacao = g.erp.baixado ? 'conferencia' : g.situacao; if (g.erp.baixado) { g.semComprovante = true; g.motivo += ' O ERP dá o título como baixado.'; } continue; }
    if (!ext.porLoja.has(g.loja)) { const a = antigas.get(g.id); if (a && a.conc && a.conc.debitos.length) { g.conc = a.conc; g.situacao = a.situacao; g.motivo = a.motivo; g.lote = a.lote || null; } else g.motivo = 'Extrato da loja indisponível neste ciclo: sem débito candidato.'; continue; }
    const k = g.loja + '|' + (ehFgts(g.tipo) ? 'fgts' : 'darf') + '|' + g.valor.toFixed(2); const grp = porGrupo.get(k) || { guias: [], debitos: null }; grp.guias.push(g); porGrupo.set(k, grp);
  }
  for (const [k, grp] of porGrupo) {
    const [lojaS, grupo] = k.split('|'); const loja = +lojaS; const saidas = ext.porLoja.get(loja) || []; const guias = grp.guias.sort((a, b) => (a.vencimento || '').localeCompare(b.vencimento || ''));
    const vencMin = somaDias(guias[0].vencimento, -10), vencMax = somaDias(guias[guias.length - 1].vencimento, 45);
    const debs = saidas.filter(s => !usados.has(s.ref) && debitoServe(guias[0].tipo, s) && s.data >= vencMin && s.data <= vencMax && guias.some(g => Math.abs(s.valor - g.valor) <= tol || (g.atualizado && Math.abs(s.valor - g.atualizado) <= tol))).sort((a, b) => a.data.localeCompare(b.data));
    void grupo;
    let di = 0;
    for (const g of guias) {
      const d = debs[di]; if (d && d.data >= somaDias(g.vencimento, -10) && d.data <= somaDias(g.vencimento, 45)) { di++; usados.add(d.ref); g.conc = { crit: { identificador: 'nd', cnpj: 'ok', valor: 'ok', competencia: 'nd', data: 'ok' }, debitos: [{ ref: d.ref, data: d.data, historico: d.historico, valor: d.valor, favorecido: d.favorecido }], res: 'sugestao' }; g.situacao = 'conferencia'; g.pagamento = g.pagamento || d.data; g.motivo = 'Débito de ' + brl(d.valor) + ' em ' + dBR(d.data) + ' para ' + (d.favorecido || d.historico) + ' combina com a guia. O extrato não traz o número da guia: só o Financeiro confirma a quitação.'; }
    }
    if (debs.length > di) { const extras = debs.slice(di); const alvo = guias[guias.length - 1]; alvo.conc.debitos.push(...extras.map(d => ({ ref: d.ref, data: d.data, historico: d.historico, valor: d.valor, favorecido: d.favorecido }))); alvo.motivo = (alvo.motivo ? alvo.motivo + ' ' : '') + 'Há ' + extras.length + ' outro(s) débito(s) com o mesmo valor no período: conferir se não houve pagamento em duplicidade.'; if (alvo.conc.res === 'sem_debito') { alvo.conc.res = 'sugestao'; alvo.situacao = 'conferencia'; alvo.conc.crit.valor = 'ok'; alvo.conc.crit.cnpj = 'ok'; } }
  }
  // lote: um débito igual à soma de 2..4 guias da mesma loja e mesma natureza ainda sem débito
  for (const loja of [1, 2, 3, 4, 5, 6]) for (const nat of ['fgts', 'darf']) {
    const livres = out.guias.filter(g => g.loja === loja && (ehFgts(g.tipo) ? 'fgts' : 'darf') === nat && g.conc.res === 'sem_debito' && g.vencimento); if (livres.length < 2 || !ext.porLoja.has(loja)) continue;
    const de = somaDias(livres.map(g => g.vencimento).sort()[0], -10), ate = somaDias(livres.map(g => g.vencimento).sort().pop(), 45);
    for (const s of (ext.porLoja.get(loja) || []).filter(s => !usados.has(s.ref) && debitoServe(livres[0].tipo, s) && s.data >= de && s.data <= ate)) {
      const combo = combinacaoUnica(livres.map(g => g.valor), s.valor, tol, 4); if (!combo) continue;
      const id = 'LG-' + s.ref.replace(/[^A-Za-z0-9]+/g, '-'); const membros = combo.map(i => livres[i]); usados.add(s.ref);
      out.lotesGuia.push({ id, loja, total: s.valor, data: s.data, descricao: s.historico, guias: membros.map(g => g.id) });
      for (const g of membros) { g.lote = id; g.conc = { crit: { identificador: 'nd', cnpj: 'ok', valor: 'ok', competencia: 'nd', data: 'ok' }, debitos: [{ ref: s.ref, data: s.data, historico: s.historico, valor: s.valor, favorecido: s.favorecido }], res: 'sugestao' }; g.situacao = 'conferencia'; g.pagamento = g.pagamento || s.data; g.motivo = 'Um débito de ' + brl(s.valor) + ' em ' + dBR(s.data) + ' fecha com a soma de ' + membros.length + ' guias (lote ' + id + '). Só o Financeiro confirma.'; }
      for (const i of combo.sort((a, b) => b - a)) livres.splice(i, 1); if (livres.length < 2) break;
    }
  }
  for (const g of out.guias) {
    if (g.conc.res === 'sem_debito' && CONTA_LOJA[g.loja] && ext.porLoja.has(g.loja)) {
      if (g.erp.baixado) { g.situacao = 'conferencia'; g.semComprovante = true; g.motivo = 'O ERP dá o título como baixado' + (g.erp.baixaEm ? ' em ' + dBR(g.erp.baixaEm) : '') + ', mas nenhum débito com este valor apareceu no extrato da loja. Conferir comprovante.'; }
      else if (g.vencimento && g.vencimento < hoje) { g.situacao = 'vencida'; g.motivo = 'Vencida em ' + dBR(g.vencimento) + ' sem débito localizado no extrato e sem baixa no ERP.'; }
      else g.situacao = 'aguardando';
    }
  }
}
function conciliarRescisoes(out, ext) {
  const hoje = hojeISO(); const usados = out.usados; const tol = 0.009;
  for (const p of out.pagamentos.filter(p => p.origem === 'erp')) {
    const cont = CONTA_LOJA[p.loja];
    if (!cont) { p.situacao = 'comprovante_indisponivel'; p.motivo = 'Conta do CD sem extrato na API do Itaú: pagamento não verificado.' + (p.erp.baixado ? ' O ERP dá o título como baixado.' : ''); p.cadeia[2] = 'na'; continue; }
    if (!ext.porLoja.has(p.loja)) { p.motivo = 'Extrato da loja indisponível neste ciclo.'; continue; }
    const de = somaDias(p.prevista, -10), ate = somaDias(p.prevista, 45);
    const cands = (ext.porLoja.get(p.loja) || []).filter(s => !usados.has(s.ref) && s.data >= de && s.data <= ate && s.tipoDocumento === 'CPF' && Math.abs(s.valor - p.valor) <= tol);
    const porNome = cands.filter(s => primeiroNomeBate(s.favorecido, p.erp.historico));
    const esc = porNome.length === 1 ? porNome[0] : (porNome.length === 0 && cands.length === 1 ? cands[0] : null);
    if (esc) {
      usados.add(esc.ref); p.efetiva = esc.data; p.idBanco = esc.ref; p.extratoRef = esc.ref; p.pago = esc.valor; if (!p.cpf && dig(esc.documento).length === 11) p.cpf = cpfFmt(esc.documento);
      if (porNome.length === 1) { p.situacao = 'liquidado'; p.cadeia[2] = 'ok'; p.cadeia[3] = 'pendente'; p.motivo = null; }
      else { p.situacao = 'divergente'; p.cadeia[2] = 'falha'; p.motivo = 'Débito de ' + brl(esc.valor) + ' em ' + dBR(esc.data) + ' para ' + (esc.favorecido || 'favorecido sem nome') + ' não confere com o nome do título (' + p.erp.historico + '). Conferência do Financeiro.'; p.alertaTipo = 'cpf'; }
      p.hist.push(hist('Débito localizado no extrato Itaú (' + cont + ') · ' + dBR(esc.data) + ' · ' + brl(esc.valor) + (porNome.length === 1 ? ' · favorecido confere' : ' · favorecido NÃO confere')));
    } else if (cands.length > 1) { p.situacao = 'divergente'; p.cadeia[2] = 'falha'; p.motivo = cands.length + ' débitos com este valor a pessoas físicas no período, nenhum com o nome do título. Conferência do Financeiro.'; p.alertaTipo = 'cpf'; }
    else if (p.prevista >= somaDias(hoje, -3)) { p.situacao = 'aguardando_envio'; }
    else if (p.erp.baixado) { p.situacao = 'comprovante_indisponivel'; p.cadeia[2] = 'na'; p.motivo = 'O ERP dá o título como baixado' + (p.erp.baixaEm ? ' em ' + dBR(p.erp.baixaEm) : '') + ', mas nenhum débito individual com este valor apareceu no extrato (pode ter saído em lote ou por outra conta).'; }
    else { p.situacao = 'divergente'; p.cadeia[2] = 'falha'; p.motivo = 'Nenhum débito com este valor a pessoa física no extrato da loja entre ' + dBR(de) + ' e ' + dBR(ate) + ', e o título segue em aberto no ERP.'; p.alertaTipo = 'nao_confirmado'; }
    // guia de FGTS rescisório do mesmo nome (conta 12.7 "MULTA <nome>")
    const g = out.guias.find(g => g.tipo === 'fgts_rescisorio' && g.loja === p.loja && primeiroNomeBate(g.erp.historico.replace(/^MULTA\s*/i, ''), p.erp.historico) && Math.abs(+new Date(g.vencimento) - +new Date(p.prevista)) <= 20 * 864e5);
    if (g) { p.guiaRel = g.id; g.demonstrativo = [{ nome: p.nome, cpf: p.cpf || '—', vinculo: p.idf, valor: g.valor, desligamento: null }]; }
  }
}

// ── 5. débito usado duas vezes (Auditoria da Folha × Dom/Feriados × rescisões) ──
function debitosDuplos(out) {
  const porRef = new Map();
  for (const p of out.pagamentos) if (p.extratoRef) { const l = porRef.get(p.extratoRef) || []; l.push(p); porRef.set(p.extratoRef, l); }
  const dup = [];
  for (const [ref, l] of porRef) if (l.length > 1 && new Set(l.map(p => p.origem + '|' + (p.funcId || p.nome))).size > 1) dup.push({ ref, pagamentos: l.map(p => p.id) });
  return dup;
}

// ── 6. pendências (chave estável, estado preservado) ──
function montarPendencias(out, dup, anteriores) {
  const hoje = hojeISO(); const novas = [];
  const add = (alerta, ref, detalhe) => novas.push({ alerta, ref, detalhe, setor: 'Financeiro' });
  const lotesSemComp = new Map();
  for (const p of out.pagamentos) {
    if (p.situacao === 'divergente') add(p.alertaTipo || (/Valor pago/.test(p.motivo || '') ? 'valor' : 'nao_confirmado'), p.id, (p.nome + ' · ' + brl(p.valor) + ' · ' + (p.motivo || 'divergente')).slice(0, 220));
    else if (p.situacao === 'rejeitado') add('rejeitado', p.id, p.nome + ' · ' + brl(p.valor) + (p.motivo ? ' · ' + p.motivo : ''));
    else if (p.situacao === 'devolvido') add('devolvido', p.id, p.nome + ' · ' + brl(p.valor) + (p.motivo ? ' · ' + p.motivo : ''));
    else if (p.situacao === 'comprovante_indisponivel' && p.lote && p.loja !== 10) { const l = lotesSemComp.get(p.lote) || { n: 0, total: 0, loja: p.loja }; l.n++; l.total = r2(l.total + p.valor); lotesSemComp.set(p.lote, l); }
    else if (p.situacao === 'comprovante_indisponivel' && !p.lote && p.origem === 'erp' && p.loja !== 10) add('sem_comprovante', p.id, p.nome + ' · ' + brl(p.valor) + ' · ' + (p.motivo || ''));
  }
  for (const [id, l] of lotesSemComp) add('sem_comprovante', id, l.n + ' pagamento(s) de ' + (GP.LOJA_TXT[l.loja] || l.loja) + ' pagos em lote (' + brl(l.total) + ') sem comprovante individual. Importar o PDF de comprovantes do Itaú Empresas na Auditoria da Folha.');
  for (const g of out.guias) {
    const dias = g.vencimento ? Math.round((new Date(g.vencimento + 'T12:00:00') - new Date(hoje + 'T12:00:00')) / 864e5) : null;
    if (g.situacao === 'vencida') add('guia_vencida', g.id, CB.TIPOS_GUIA[g.tipo] + ' ' + g.comp.slice(5) + '/' + g.comp.slice(0, 4) + ' · ' + (GP.LOJA_TXT[g.loja] || g.loja) + ' · ' + brl(g.valor) + ' · venceu em ' + dBR(g.vencimento));
    else if (g.situacao === 'aguardando' && dias != null && dias >= 0 && dias <= 10) add('guia_proxima', g.id, CB.TIPOS_GUIA[g.tipo] + ' ' + g.comp.slice(5) + '/' + g.comp.slice(0, 4) + ' · ' + (GP.LOJA_TXT[g.loja] || g.loja) + ' · ' + brl(g.valor) + ' · vence em ' + dBR(g.vencimento));
    else if (g.semComprovante) add('guia_sem_comp', g.id, CB.TIPOS_GUIA[g.tipo] + ' ' + g.comp.slice(5) + '/' + g.comp.slice(0, 4) + ' · ' + (GP.LOJA_TXT[g.loja] || g.loja) + ' · ' + brl(g.valor) + ' · ' + (g.motivo || ''));
  }
  for (const d of dup) add('debito_duplo', d.pagamentos[0], 'O débito ' + d.ref + ' aparece em ' + d.pagamentos.length + ' pagamentos: ' + d.pagamentos.join(', ') + '. Um lançamento do banco não pode quitar dois pagamentos.');
  // mescla com as anteriores: mesma chave mantém protocolo, data, situação e responsável; o que sumiu é resolvido pelo sistema
  const ant = anteriores.pendencias || []; const porChave = new Map(ant.map(p => [p.alerta + '|' + p.ref, p])); const ano = hoje.slice(0, 4);
  let seq = ant.reduce((m, p) => { const x = /^PD-(\d{4})-(\d+)$/.exec(p.id || ''); return x && x[1] === ano ? Math.max(m, +x[2]) : m; }, 0);
  const agora = agoraIso(); const vistas = new Set(); const out2 = [];
  for (const n of novas) {
    const k = n.alerta + '|' + n.ref; if (vistas.has(k)) continue; vistas.add(k); const a = porChave.get(k);
    if (a) { out2.push({ ...a, detalhe: n.detalhe, setor: a.setor || n.setor, situacao: a.situacao === 'resolvida' && a.resolvidaPor === 'sistema' ? 'aberta' : a.situacao, reaberta: a.situacao === 'resolvida' && a.resolvidaPor === 'sistema' ? agora : (a.reaberta || null) }); }
    else out2.push({ id: 'PD-' + ano + '-' + String(++seq).padStart(4, '0'), ...n, responsavel: null, em: hoje, abertaEm: agora, situacao: 'aberta' });
  }
  for (const a of ant) { const k = a.alerta + '|' + a.ref; if (vistas.has(k)) continue; if (a.situacao !== 'resolvida') out2.push({ ...a, situacao: 'resolvida', resolvidaEm: agora, resolvidaPor: 'sistema', resolucao: 'A condição deixou de existir na sincronização de ' + dBR(hoje) + '.' }); else out2.push(a); }
  const porData = (a, b) => String(b.em || '').localeCompare(String(a.em || '')) || String(b.id).localeCompare(String(a.id));
  const resolvidas = out2.filter(p => p.situacao === 'resolvida').sort((a, b) => String(b.resolvidaEm || '').localeCompare(String(a.resolvidaEm || ''))).slice(0, 500);
  return [...out2.filter(p => p.situacao !== 'resolvida').sort(porData), ...resolvidas];   // abertas primeiro, depois as resolvidas mais recentes
}

/** o que o usuário fez por cima (arquivamento, histórico manual) sobrevive ao ciclo */
function preservar(lista, anteriores, chave) {
  const ant = new Map((anteriores || []).map(x => [x.id, x]));
  for (const x of lista) { const a = ant.get(x.id); if (!a) continue; if (a.arquivado) { x.arquivado = true; x.pasta = a.pasta || null; }
    // vínculo manual feito pelo Financeiro em Consultar Banco vale mais que a leitura automática
    if (a.vinculoManual) { x.vinculoManual = a.vinculoManual; x.extratoRef = a.extratoRef; x.idBanco = a.idBanco; x.efetiva = a.efetiva; x.pago = a.pago; x.situacao = 'liquidado'; x.motivo = null; x.cadeia = [x.cadeia[0], x.cadeia[1], 'ok', x.cadeia[3] === 'ok' ? 'ok' : 'pendente']; } const manuais = (a.hist || []).filter(h => h.quem !== QUEM); if (manuais.length) x.hist = [...x.hist, ...manuais]; if (a.docs) for (const d of a.docs) if (d.classe === 'importado' && d.manual && !x.docs.some(y => y.nome === d.nome)) x.docs.push(d); if (chave === 'guia' && a.confirmadaPor) { x.confirmadaPor = a.confirmadaPor; x.confirmadaEm = a.confirmadaEm; x.situacao = 'paga'; x.conc.res = 'confirmada'; } }
}

// ── ciclo completo ──
async function sincronizar(origem) {
  if (rodando) return { pulado: true, motivo: 'ciclo anterior ainda rodando' };
  rodando = true; const ini = Date.now(); const F = fontes(); const hoje = hojeISO();
  const res = { em: agoraIso(), origem: origem || 'agendado', fontes: { auditoriaFolha: null, domFer: null, erp: null, itau: null }, erros: [], totais: null, ms: 0 };
  const out = { pagamentos: [], guias: [], lotes: new Map(), lotesGuia: [], usados: new Set() };
  const anteriores = { pagamentos: lerJson(P('pagamentos.json'), []), guias: lerJson(P('guias.json'), []), pendencias: lerJson(P('pendencias.json'), []) };
  try {
    let cpfs = new Map();
    try { let cfgAF = null; try { cfgAF = require('./auditoria-folha').config(); } catch (e) { cfgAF = null; } const a = deAuditoriaFolha(F.competencias() || [], out, cfgAF); cpfs = a.cpfs; res.fontes.auditoriaFolha = { competencias: a.competencias, pagamentos: out.pagamentos.length }; }
    catch (e) { res.erros.push('Auditoria da Folha: ' + e.message); res.fontes.auditoriaFolha = { erro: e.message }; }
    try { const antes = out.pagamentos.length; const d = deDomFer(F.relatorios() || [], out, cpfs); res.fontes.domFer = { relatorios: d.relatorios, pagamentos: out.pagamentos.length - antes }; }
    catch (e) { res.erros.push('Pagamentos Dom/Feriados: ' + e.message); res.fontes.domFer = { erro: e.message }; }
    let erpOk = false;
    try {
      const titulos = await F.titulos(somaDias(hoje, -DIAS_ERP_ATRAS), somaDias(hoje, DIAS_ERP_FRENTE));
      let colab = null; try { colab = await F.colaboradores(); } catch (e) { res.erros.push('PontoCerto (identificação das rescisões): ' + e.message); }
      const s = deErp(titulos || [], out, colab); erpOk = true;
      res.fontes.erp = { periodo: { de: somaDias(hoje, -DIAS_ERP_ATRAS), ate: somaDias(hoje, DIAS_ERP_FRENTE) }, titulos: s.titulos, guias: s.guias, rescisoes: s.rescisoes, ignorados: s.ignorados.length, naoClassificados: s.ignorados.slice(0, 200), pontocerto: !!colab };
    } catch (e) {
      res.erros.push('ERP (contas a pagar): ' + e.message); res.fontes.erp = { erro: e.message };
      // sem ERP neste ciclo, as guias e rescisões do ciclo anterior continuam na base (não some o que já estava)
      out.guias.push(...anteriores.guias); out.pagamentos.push(...anteriores.pagamentos.filter(p => p.origem === 'erp'));
    }
    try {
      const ext = erpOk ? await lerExtratos(out, F) : { porLoja: new Map(), lojas: [] };
      res.fontes.itau = { contas: ext.lojas, ok: ext.lojas.filter(l => !l.erro).length, falhas: ext.lojas.filter(l => l.erro).length };
      for (const l of ext.lojas.filter(l => l.erro)) res.erros.push('Itaú ' + l.lojaTxt + ': ' + l.erro);
      if (erpOk) { conciliarGuias(out, ext, anteriores); conciliarRescisoes(out, ext); }
    } catch (e) { res.erros.push('Extrato Itaú: ' + e.message); res.fontes.itau = { erro: e.message }; }
    const dup = debitosDuplos(out);
    preservar(out.pagamentos, anteriores.pagamentos, 'pagamento'); preservar(out.guias, anteriores.guias, 'guia');
    const pend = montarPendencias(out, dup, anteriores);
    const pagamentos = out.pagamentos.sort((a, b) => String(b.efetiva || b.prevista || '').localeCompare(String(a.efetiva || a.prevista || '')) || a.nome.localeCompare(b.nome));
    const guias = out.guias.sort((a, b) => String(b.vencimento || '').localeCompare(String(a.vencimento || '')) || a.loja - b.loja);
    const lotes = [...out.lotes.values()].sort((a, b) => String(b.data).localeCompare(String(a.data)));
    gravarJson(P('pagamentos.json'), pagamentos); gravarJson(P('guias.json'), guias); gravarJson(P('lotes.json'), lotes); gravarJson(P('lotes-guia.json'), out.lotesGuia); gravarJson(P('pendencias.json'), pend);
    res.totais = { pagamentos: pagamentos.length, guias: guias.length, lotes: lotes.length, lotesGuia: out.lotesGuia.length, pendenciasAbertas: pend.filter(p => p.situacao !== 'resolvida').length, debitosDuplos: dup.length,
      porSituacao: pagamentos.reduce((m, p) => { m[p.situacao] = (m[p.situacao] || 0) + 1; return m; }, {}), guiasPorSituacao: guias.reduce((m, g) => { m[g.situacao] = (m[g.situacao] || 0) + 1; return m; }, {}) };
    const novos = pagamentos.filter(p => !anteriores.pagamentos.some(a => a.id === p.id)).length + guias.filter(g => !anteriores.guias.some(a => a.id === g.id)).length;
    const mudou = JSON.stringify([pagamentos.map(p => [p.id, p.situacao]), guias.map(g => [g.id, g.situacao])]) !== JSON.stringify([anteriores.pagamentos.map(p => [p.id, p.situacao]), anteriores.guias.map(g => [g.id, g.situacao])]);
    if (mudou || res.erros.length || !ultimo) auditar({ acao: 'Importação', ref: 'SYNC', det: 'Sincronização ' + res.origem + ': ' + pagamentos.length + ' pagamentos, ' + guias.length + ' guias, ' + lotes.length + ' lotes, ' + res.totais.pendenciasAbertas + ' pendências abertas' + (novos ? ' · ' + novos + ' registro(s) novo(s)' : '') + (res.erros.length ? ' · ' + res.erros.length + ' erro(s): ' + res.erros.join(' | ').slice(0, 300) : '') });
    res.novos = novos; res.mudou = mudou;
  } catch (e) { res.falha = e.message; res.erros.push('ciclo: ' + e.message); auditar({ acao: 'Importação', ref: 'SYNC', det: 'Sincronização falhou: ' + e.message }); }
  res.ms = Date.now() - ini; ultimo = res; rodando = false;
  try { gravarJson(P('sync.json'), { ultimo: res, proximo, intervaloMin: intervaloMin() }); } catch (e) { /* status é informativo */ }
  return res;
}

const intervaloMin = () => Math.max(30, +process.env.COMPROVANTES_SYNC_MIN || 240);
function status() { const s = lerJson(P('sync.json'), {}); return { rodando, agendado: !!timer, proximo, intervaloMin: intervaloMin(), ultimo: ultimo || s.ultimo || null }; }
/** liga o agendador: primeiro ciclo 3 min depois de subir, depois a cada COMPROVANTES_SYNC_MIN (padrão 240 min) */
function iniciar(d) {
  deps = { ...deps, ...(d || {}) }; if (timer) clearTimeout(timer);
  const marcar = ms => { proximo = new Date(Date.now() + ms).toISOString(); timer = setTimeout(tic, ms); timer.unref && timer.unref(); };
  // o "próximo" é definido ANTES de rodar, pra ficar certo no sync.json gravado no fim do ciclo (antes mostrava a hora do ciclo que acabou de rodar)
  const tic = async () => { const alvo = Date.now() + intervaloMin() * 60000; proximo = new Date(alvo).toISOString(); try { await sincronizar('agendado'); } catch (e) { console.error('[comprovantes-bancarios] sync:', e.message); } marcar(Math.max(60000, alvo - Date.now())); };
  marcar(3 * 60000);
}
function parar() { if (timer) clearTimeout(timer); timer = null; proximo = null; }

module.exports = { sincronizar, iniciar, parar, status, CONTA_LOJA, SYNC, _interno: { classificarTitulo, combinacaoUnica, primeiroNomeBate, deAuditoriaFolha, deDomFer, deErp, conciliarGuias, conciliarRescisoes, montarPendencias, debitosDuplos, _deps: d => { deps = { ...deps, ...d }; } } };
