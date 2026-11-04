'use strict';
// lib/comprovantes-bancarios-banco.js — DP / RH › Comprovantes Bancários › CONSULTAR BANCO (04/11/2026, prompt "Consulta Bancária e
// Emissão de Comprovantes"). O RH localiza um pagamento trabalhista direto na conta Itaú da loja, sem abrir o internet banking:
//   · consulta a API oficial de extrato (lib/itau-extrato.js, escopo account-statement.read, credenciais só no servidor) por período,
//     empresa/CNPJ (= loja), nome, CPF, valor, tipo, identificador e situação;
//   · só lançamentos do ESCOPO TRABALHISTA saem daqui (pessoa física, lote SISPAG Salários, CEF = FGTS, ou lançamento já vinculado a um
//     registro da base). Fornecedores, tarifas e tributos sem vínculo ficam ocultos e só aparecem como contagem — a tabela de permissões
//     diz que ninguém vê "saldo e extrato geral" por este módulo;
//   · cada lançamento sai com o identificador ORIGINAL do banco (event id), a situação real (o extrato só mostra o que já foi debitado:
//     agendado/rejeitado não aparecem; estorno = reversal/PIX devolvido), o vínculo com o lançamento do RH (base montada pela
//     sincronização) e a classificação da conciliação;
//   · comprovante: a API contratada NÃO entrega PDF. Quando o PDF de comprovantes do Itaú Empresas já foi lido na Auditoria da Folha, a
//     página do funcionário é extraída (pdf-lib) e serve para visualizar, baixar, imprimir e arquivar no GED (pasta 08, tipo "Comprovante
//     bancário"). Senão: "Comprovante indisponível pela integração bancária". Nunca se gera documento que simule um comprovante.
//   · vínculo manual (Financeiro/Coordenação) exige valor igual e lançamento ainda não usado; fica em vinculos.json e sobrevive à sincronização.
// Tudo auditado em data/comprovantes-bancarios/auditoria.jsonl. Nada aqui movimenta dinheiro.
const fs = require('fs');
const path = require('path');
const os = require('os');
const CB = require('./comprovantes-bancarios');
const GP = require('./gestao-pessoas');

const CONTA_LOJA = { 1: 'cahu', 2: 'muribeca', 3: 'ponte', 4: 'atacarejo', 5: 'portalarga', 6: 'jardimjordao' };
const TIPOS_BANCO = { salario: 'Salários', adiantamento: 'Adiantamentos salariais', rescisao: 'Rescisões contratuais', domfer: 'Domingos e feriados', ferias: 'Férias', decimo: '13º salário', fgts: 'FGTS', encargos: 'Encargos e guias trabalhistas', outros: 'Outros pagamentos de RH' };
const SIT_BANCO = { liquidado: 'Liquidado', estornado: 'Estornado', pendente: 'Pendente', rejeitado: 'Rejeitado' };
const CONC_TXT = { conciliado: 'Conciliado automaticamente', manual: 'Conciliado pelo Financeiro', pendente: 'Pendente de conferência', divergencia_valor: 'Divergência de valor', beneficiario_divergente: 'Beneficiário divergente', sem_lancamento: 'Pagamento bancário sem lançamento no RH' };
const SEM_COMPROVANTE = 'Comprovante indisponível pela integração bancária';
const MAX_DIAS = 92, CACHE_MS = 10 * 60000;
const P = f => path.join(CB.DIR, f);
let deps = { extrato: null, pontocerto: null, ged: null, agora: null };
const cache = new Map();

const r2 = n => Math.round((+n || 0) * 100) / 100;
const dig = s => String(s || '').replace(/\D/g, '');
const pad = n => String(n).padStart(2, '0');
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const agoraIso = () => (deps.agora ? deps.agora() : new Date()).toISOString();
const hojeISO = () => { const d = deps.agora ? deps.agora() : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const somaDias = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const dBR = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '—';
const brl = n => (+n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const cpfMask = d => { d = dig(d); return d.length === 11 ? '***.***.' + d.slice(6, 9) + '-' + d.slice(9) : d.length === 14 ? d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5, 8) + '/' + d.slice(8, 12) + '-' + d.slice(12) : (d || '—'); };
const cpfFmt = d => { d = dig(d); return d.length === 11 ? d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9) : cpfMask(d); };
const erro = (msg, status, extra) => Object.assign(new Error(msg), { status: status || 400, ...(extra || {}) });
const lerJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } };
function gravarJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }
function nomeBate(a, b) { const A = semAcento(a).split(' ').filter(w => w.length > 2), B = semAcento(b).split(' ').filter(w => w.length > 2); if (!A.length || !B.length || A[0] !== B[0]) return false; return A.filter(w => B.includes(w)).length >= Math.min(2, A.length, B.length); }

function perm(user) {
  const coord = GP.temPapel(user, 'coordenacao'), fin = GP.temPapel(user, 'financeiro'), rh = GP.temPapel(user, ...GP.RH), dir = GP.temPapel(user, 'diretoria');
  return { coord, fin, rh, dir, ver: coord || fin || rh || dir, consultar: coord || fin || rh || dir, vincular: coord || fin, arquivar: rh || coord, cpfCompleto: coord || fin, perfil: coord ? 'coordenacao' : fin ? 'financeiro' : rh ? 'rh' : dir ? 'diretoria' : null };
}
const PERFIL_TXT = { coordenacao: 'Coordenação', financeiro: 'Financeiro', rh: 'RH / DP', diretoria: 'Diretoria' };
function auditar(u, acao, ref, det, extra) { try { fs.mkdirSync(CB.DIR, { recursive: true }); fs.appendFileSync(P('auditoria.jsonl'), JSON.stringify({ em: agoraIso(), quem: u.nome || u.usuario, usuario: u.usuario, perfil: PERFIL_TXT[perm(u).perfil] || '—', acao, ref, det, ...(extra || {}) }) + '\n'); } catch (e) { /* auditoria nunca derruba a consulta */ } }
function auditoriaDe(ref) { try { return fs.readFileSync(P('auditoria.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(a => a && (a.ref === ref || (a.refs || []).includes(ref))).reverse().slice(0, 300); } catch (e) { return []; } }

// ── extrato: eventos crus com o id do banco (parseSaidasApi descarta o id; aqui ele é o identificador oficial da transação) ──
const CODIGO = { 9678: 'boleto_pago', 7549: 'boleto_pago', 9676: 'pix_enviado', 9498: 'pix_devolvido', 8512: 'aplicacao', '0793': 'tarifa_juros', 1209: 'tarifa_juros' };
function categoriaDe(lit) { const c = String((lit && lit.code) || ''); if (CODIGO[c]) return CODIGO[c]; const t = String((lit && (lit.shortened || lit.complete)) || '').trim(); if (t.startsWith('TAR ')) return 'tarifa_juros'; if (t.startsWith('SISPAG SALARIOS')) return 'salario'; if (t.startsWith('SISPAG TRIB') || t === 'SISPAG PIX QR-CODE') return 'tributo'; return 'outro'; }
async function eventos(conta, de, ate) {
  const k = conta + '|' + de + '|' + ate; const c = cache.get(k); if (c && Date.now() - c.em < CACHE_MS) return c.evs;
  const bruto = await (deps.extrato || (a => require('./itau-extrato').buscarExtrato(a)))({ conta, dataInicio: de, dataFim: ate });
  const evs = (bruto && bruto.data || []).flatMap(d => d.events || []).filter(e => e.operation === 'D' && (e.type === 'lancamento' || e.type === 'agrupamento'));
  cache.set(k, { em: Date.now(), evs }); return evs;
}
function linhaDe(ev, loja, conta, k) {
  const lit = ev.literal || {}; const cp = ev.counterpart || {}; const historico = String(lit.complete || lit.shortened || '(sem histórico)').trim().replace(/\s+/g, ' ');
  const valor = Math.abs(Number(ev.amount && ev.amount.value) || 0); const data = ev.date && ev.date.accounting; if (!data || !valor) return null;
  const lote = ev.type === 'agrupamento'; if (lote && !/^SISPAG SAL/i.test(String(lit.shortened || lit.complete || ''))) return null;
  const doc = dig(cp.document); const pf = cp.person === 'FISICA' || doc.length === 11;
  const favorecido = cp.name || (lote ? 'Lote SISPAG Salários' : historico);
  const categoria = lote ? 'salario' : categoriaDe(lit);
  return { ref: conta + '|' + data + '|' + valor.toFixed(2) + '|' + (doc || semAcento(cp.name) || k), idBanco: ev.id || null, loja, lojaTxt: GP.LOJA_TXT[loja], cnpj: (CB.LOJAS.find(l => l.n === loja) || {}).cnpj, conta, data, valor, favorecido, documento: doc, pessoaFisica: pf, historico, categoria, lote, qtdLote: lote ? (ev.number_events || null) : null,
    estorno: !!ev.reversal || categoria === 'pix_devolvido', bancoFav: cp.institution || null, agenciaFav: cp.agency || null, contaFav: cp.account ? cp.account + (cp.digit ? '-' + cp.digit : '') : null, finalidade: cp.transfer_purpose || null, canal: ev.origin && ev.origin.channel || null, origemId: ev.origin && ev.origin.identifier || null };
}

// ── vínculo com a base do RH (montada pela sincronização) ──
function indices() {
  const d = CB.dados(); const vinc = lerJson(P('vinculos.json'), {});
  const porRef = new Map(), guiaPorRef = new Map(), porLote = new Map(), porCpf = new Map();
  for (const p of d.PAGAMENTOS) { if (p.extratoRef) porRef.set(p.extratoRef, p); if (p.lote) { const l = porLote.get(p.lote) || []; l.push(p); porLote.set(p.lote, l); } const c = dig(p.cpf); if (c.length === 11) { const l = porCpf.get(c) || []; l.push(p); porCpf.set(c, l); } }
  for (const g of d.GUIAS) for (const x of (g.conc && g.conc.debitos) || []) if (x.ref) guiaPorRef.set(x.ref, g);
  return { d, vinc, porRef, guiaPorRef, porLote, porCpf };
}
const tipoDe = p => ({ salario: 'salario', adiantamento: 'adiantamento', rescisao: 'rescisao', domfer: 'domfer', ferias: 'ferias', decimo: 'decimo' })[p.tipo] || 'outros';
function comprovanteDe(p) { const i = (p.docs || []).findIndex(x => x.classe === 'oficial' && x.caminho); if (i < 0) return { disponivel: false, motivo: SEM_COMPROVANTE }; const d = p.docs[i]; return { disponivel: true, url: '/api/comprovantes-bancarios/doc/' + encodeURIComponent(p.id) + '/' + i, pagina: d.pagina || null, nome: d.nome, origem: d.origem, pagamentoId: p.id, idx: i }; }
function classificar(l, ix) {
  const vm = ix.vinc[l.ref]; const pag = vm ? ix.d.PAGAMENTOS.find(p => p.id === vm.pagamentoId) : ix.porRef.get(l.ref); const guia = ix.guiaPorRef.get(l.ref);
  const base = { vinculo: null, membros: [], conciliacao: 'sem_lancamento', tipo: 'outros', comprovante: { disponivel: false, motivo: SEM_COMPROVANTE }, candidatos: [] };
  if (pag) return { ...base, vinculo: { id: pag.id, nome: pag.nome, cpf: pag.cpf, tipo: pag.tipo, tipoTxt: CB.TIPOS[pag.tipo], comp: pag.comp, valor: pag.valor, situacao: pag.situacao, manual: !!vm, por: vm ? vm.por : null, em: vm ? vm.em : null }, conciliacao: vm ? 'manual' : 'conciliado', tipo: tipoDe(pag), comprovante: comprovanteDe(pag) };
  if (guia) return { ...base, vinculo: { id: guia.id, nome: CB.TIPOS_GUIA[guia.tipo] + ' ' + guia.comp.slice(5) + '/' + guia.comp.slice(0, 4), tipo: 'guia', tipoTxt: CB.TIPOS_GUIA[guia.tipo], comp: guia.comp, valor: guia.valor, situacao: guia.situacao, guia: true }, conciliacao: guia.situacao === 'paga' ? 'manual' : 'pendente', tipo: /^fgts/.test(guia.tipo) ? 'fgts' : 'encargos' };
  if (l.lote) {
    const id = 'LT-' + l.conta + '-' + l.data + '-' + Math.round(l.valor * 100); const idC = 'LT-' + l.conta + '-' + l.data + '-COMP';
    const membros = [...(ix.porLote.get(id) || []), ...(ix.porLote.get(idC) || [])].map(p => ({ id: p.id, nome: p.nome, cpf: p.cpf, tipo: p.tipo, valor: p.valor, situacao: p.situacao, comprovante: comprovanteDe(p) }));
    return { ...base, membros, conciliacao: 'pendente', tipo: 'salario', comprovante: { disponivel: false, motivo: 'Lote: o banco informa só total e quantidade. O comprovante é individual, por funcionário (quando o PDF de comprovantes foi lido na Auditoria da Folha).' } };
  }
  if (/CEF|CAIXA ECON/.test(semAcento(l.favorecido + ' ' + l.historico))) return { ...base, tipo: 'fgts', conciliacao: 'sem_lancamento' };
  if (l.pessoaFisica) {
    // candidatos = lançamentos do RH desta pessoa ainda em aberto (quem já está liquidado por comprovante ou outro débito não entra)
    const mesmos = (ix.porCpf.get(l.documento) || []).filter(p => p.situacao !== 'liquidado' && !p.extratoRef && Math.abs(+new Date(p.efetiva || p.prevista || l.data) - +new Date(l.data)) <= 45 * 864e5);
    const igual = mesmos.filter(p => Math.abs(p.valor - l.valor) < 0.005);
    if (igual.length === 1) return { ...base, conciliacao: 'pendente', candidatos: igual.map(c => ({ id: c.id, nome: c.nome, tipo: c.tipo, valor: c.valor, comp: c.comp, situacao: c.situacao })), tipo: tipoDe(igual[0]) };
    if (igual.length > 1) return { ...base, conciliacao: 'pendente', candidatos: igual.slice(0, 6).map(c => ({ id: c.id, nome: c.nome, tipo: c.tipo, valor: c.valor, comp: c.comp, situacao: c.situacao })), tipo: tipoDe(igual[0]) };
    if (mesmos.length) return { ...base, conciliacao: 'divergencia_valor', candidatos: mesmos.slice(0, 6).map(c => ({ id: c.id, nome: c.nome, tipo: c.tipo, valor: c.valor, comp: c.comp, situacao: c.situacao })), tipo: tipoDe(mesmos[0]) };
    const porNome = ix.d.PAGAMENTOS.filter(p => p.situacao !== 'liquidado' && !p.extratoRef && Math.abs(p.valor - l.valor) < 0.005 && nomeBate(p.nome, l.favorecido) && dig(p.cpf) && dig(p.cpf) !== l.documento);
    if (porNome.length) return { ...base, conciliacao: 'beneficiario_divergente', candidatos: porNome.slice(0, 6).map(c => ({ id: c.id, nome: c.nome, cpf: c.cpf, tipo: c.tipo, valor: c.valor, comp: c.comp, situacao: c.situacao })), tipo: tipoDe(porNome[0]) };
  }
  return base;
}

/** CONSULTAR BANCO: lê o extrato das contas pedidas, filtra o escopo trabalhista, vincula com a base e aplica os filtros da tela */
async function consultar(user, f) {
  const p = perm(user); if (!p.consultar) throw erro('Sem acesso à consulta bancária', 403);
  f = f || {}; const hoje = hojeISO();
  let ate = f.ate && /^\d{4}-\d{2}-\d{2}$/.test(f.ate) ? f.ate : hoje; if (ate > hoje) ate = hoje;
  let de = f.de && /^\d{4}-\d{2}-\d{2}$/.test(f.de) ? f.de : somaDias(ate, -30); if (de > ate) throw erro('Período inicial depois do final');
  if ((new Date(ate) - new Date(de)) / 864e5 > MAX_DIAS) throw erro('Período máximo de ' + MAX_DIAS + ' dias por consulta');
  const loja = f.loja ? +f.loja : null; if (loja === 10) throw erro('A conta do CD não tem extrato pela API do Itaú (chamado de Conciliação Bancária ainda não aberto). Consulte as lojas E1 a E6.');
  if (loja && !CONTA_LOJA[loja]) throw erro('Unidade inválida');
  const lojas = loja ? [loja] : [1, 2, 3, 4, 5, 6];
  const nome = semAcento(f.nome), cpf = dig(f.cpf), valor = f.valor !== undefined && f.valor !== '' && f.valor !== null ? r2(String(f.valor).replace(/\./g, '').replace(',', '.')) : null, tipo = String(f.tipo || ''), idBanco = String(f.idBanco || '').trim().toLowerCase(), sit = String(f.situacao || '');
  const ix = indices(); const res = { periodo: { de, ate }, lojas: [], linhas: [], ocultados: 0, avisos: [] };
  for (const lj of lojas) {
    const conta = CONTA_LOJA[lj]; let evs;
    try { evs = await eventos(conta, de, ate); } catch (e) { res.lojas.push({ loja: lj, lojaTxt: GP.LOJA_TXT[lj], conta, erro: String(e.message || e).slice(0, 200) }); continue; }
    let inc = 0, oc = 0;
    evs.forEach((ev, k) => {
      const l = linhaDe(ev, lj, conta, k); if (!l) return;
      // devolução de PIX recebido (débito "PIX DEVOLVIDO") não é pagamento trabalhista: só entra se já estiver vinculada a um registro do RH
      const c = classificar(l, ix); const escopo = c.vinculo || (!l.estorno && (l.pessoaFisica || l.lote || c.tipo === 'fgts'));
      if (!escopo) { oc++; return; }
      inc++; res.linhas.push({ ...l, ...c, situacao: l.estorno ? 'estornado' : 'liquidado', documentoTxt: p.cpfCompleto && l.documento.length === 11 ? cpfFmt(l.documento) : cpfMask(l.documento), banco: 'Itaú Unibanco (341)' });
    });
    res.lojas.push({ loja: lj, lojaTxt: GP.LOJA_TXT[lj], conta, lidos: evs.length, incluidos: inc, ocultados: oc }); res.ocultados += oc;
  }
  res.linhas = res.linhas.filter(l => (!nome || semAcento(l.favorecido).includes(nome) || (l.vinculo && semAcento(l.vinculo.nome).includes(nome)) || l.membros.some(m => semAcento(m.nome).includes(nome)))
    && (!cpf || (cpf.length >= 3 && (l.documento.includes(cpf) || (l.vinculo && dig(l.vinculo.cpf).includes(cpf)) || l.membros.some(m => dig(m.cpf).includes(cpf)))))
    && (valor === null || Math.abs(l.valor - valor) < 0.005) && (!tipo || l.tipo === tipo) && (!idBanco || String(l.idBanco || '').toLowerCase().includes(idBanco) || l.ref.toLowerCase().includes(idBanco)) && (!sit || l.situacao === sit))
    .sort((a, b) => b.data.localeCompare(a.data) || a.favorecido.localeCompare(b.favorecido));
  if (lojas.length === 6 && !loja) res.avisos.push('CD (loja 10) não consultado: a conta não tem extrato pela API.');
  if (sit === 'pendente' || sit === 'rejeitado') res.avisos.push('O extrato do Itaú só traz lançamentos já debitados: agendados, pendentes e rejeitados não aparecem pela integração.');
  res.avisos.push('A API contratada não entrega o PDF do comprovante. Onde aparece "Disponível", o documento veio do PDF de comprovantes do Itaú Empresas lido na Auditoria da Folha.');
  auditar(user, 'Consulta ao banco', loja ? GP.LOJA_TXT[loja] : 'E1 a E6', 'Período ' + dBR(de) + ' a ' + dBR(ate) + [nome && ' · nome "' + f.nome + '"', cpf && ' · CPF ' + cpfMask(cpf), valor !== null && ' · valor ' + brl(valor), tipo && ' · tipo ' + (TIPOS_BANCO[tipo] || tipo), idBanco && ' · id ' + f.idBanco, sit && ' · situação ' + sit].filter(Boolean).join('') + ' · ' + res.linhas.length + ' lançamento(s), ' + res.ocultados + ' fora do escopo ocultado(s)' + (res.lojas.some(l => l.erro) ? ' · erro em ' + res.lojas.filter(l => l.erro).map(l => l.lojaTxt).join(', ') : ''));
  return res;
}

/** registra visualização de detalhes / impressão pedidas pela tela (o download e a visualização do PDF são auditados na própria rota do arquivo) */
function evento(user, b) {
  const acao = { detalhes: 'Visualização de detalhes', impressao: 'Impressão', comprovante: 'Visualização' }[String(b && b.acao)]; if (!acao) throw erro('Ação inválida');
  auditar(user, acao, String(b.ref || '').slice(0, 120), String(b.det || '').slice(0, 200)); return { ok: true };
}

// ── vínculo manual (Financeiro/Coordenação): lançamento do banco ↔ pagamento da base ──
function vincular(user, b) {
  const p = perm(user); if (!p.vincular) throw erro('Só Financeiro ou Coordenação vinculam lançamentos', 403);
  const ref = String(b.ref || ''), id = String(b.pagamentoId || ''); if (!ref || !id) throw erro('Informe o lançamento e o pagamento');
  const partes = ref.split('|'); if (partes.length < 4) throw erro('Referência do lançamento inválida');
  const valorRef = r2(partes[2]); const pags = lerJson(P('pagamentos.json'), []); const pag = pags.find(x => x.id === id); if (!pag) throw erro('Pagamento não encontrado na base', 404);
  const vinc = lerJson(P('vinculos.json'), {});
  if (vinc[ref] && vinc[ref].pagamentoId !== id) throw erro('Este lançamento já está vinculado a ' + vinc[ref].pagamentoId + '. Desvincule antes.', 409);
  const outro = pags.find(x => x.id !== id && x.extratoRef === ref); if (outro) throw erro('Este lançamento já confirma o pagamento ' + outro.id + ' (' + outro.nome + '). Um débito não quita dois pagamentos.', 409);
  if (pag.extratoRef && pag.extratoRef !== ref) throw erro('O pagamento ' + id + ' já tem lançamento bancário (' + pag.extratoRef + ').', 409);
  if (Math.abs(valorRef - pag.valor) >= 0.005) throw erro('Valor do lançamento (' + brl(valorRef) + ') difere do pagamento (' + brl(pag.valor) + '). Vínculo manual exige valor igual; diferença vai para pendência.');
  const docRef = dig(partes[3]); if (docRef.length === 11 && dig(pag.cpf).length === 11 && docRef !== dig(pag.cpf)) throw erro('CPF do favorecido não é o do funcionário. Beneficiário divergente não pode ser vinculado.');
  const em = agoraIso(); const quem = { usuario: user.usuario, nome: user.nome || user.usuario };
  vinc[ref] = { pagamentoId: id, por: quem, em, obs: String(b.obs || '').slice(0, 300) || null, idBanco: b.idBanco || null, data: partes[1], valor: valorRef };
  gravarJson(P('vinculos.json'), vinc);
  pag.vinculoManual = vinc[ref]; pag.extratoRef = ref; pag.idBanco = b.idBanco || ref; pag.efetiva = partes[1]; pag.pago = valorRef; pag.situacao = 'liquidado'; pag.motivo = null; pag.cadeia = [pag.cadeia[0] || 'ok', pag.cadeia[1] || 'na', 'ok', pag.cadeia[3] === 'ok' ? 'ok' : 'pendente'];
  (pag.hist = pag.hist || []).push({ quem: quem.nome, em: em.slice(0, 16).replace('T', ' '), txt: 'Vinculado manualmente ao lançamento ' + ref + (b.idBanco ? ' (id ' + b.idBanco + ')' : '') + (b.obs ? ' · ' + b.obs : '') });
  gravarJson(P('pagamentos.json'), pags);
  auditar(user, 'Vínculo', id, 'Lançamento ' + ref + (b.idBanco ? ' · id ' + b.idBanco : '') + ' vinculado a ' + pag.nome + ' · ' + brl(pag.valor), { refs: [ref] });
  return { ok: true, pagamento: pag };
}
function desvincular(user, b) {
  const p = perm(user); if (!p.vincular) throw erro('Só Financeiro ou Coordenação desvinculam', 403);
  const ref = String(b.ref || ''); const vinc = lerJson(P('vinculos.json'), {}); const v = vinc[ref]; if (!v) throw erro('Este lançamento não tem vínculo manual', 404);
  delete vinc[ref]; gravarJson(P('vinculos.json'), vinc);
  const pags = lerJson(P('pagamentos.json'), []); const pag = pags.find(x => x.id === v.pagamentoId);
  if (pag) { delete pag.vinculoManual; pag.extratoRef = null; pag.idBanco = null; pag.efetiva = null; pag.pago = null; pag.situacao = 'aguardando_envio'; pag.cadeia[2] = 'pendente'; (pag.hist = pag.hist || []).push({ quem: user.nome || user.usuario, em: agoraIso().slice(0, 16).replace('T', ' '), txt: 'Vínculo manual desfeito (' + ref + ')' + (b.obs ? ' · ' + b.obs : '') }); gravarJson(P('pagamentos.json'), pags); }
  auditar(user, 'Vínculo desfeito', v.pagamentoId, 'Lançamento ' + ref + (b.obs ? ' · ' + b.obs : ''), { refs: [ref] }); return { ok: true };
}
const vinculos = () => lerJson(P('vinculos.json'), {});

// ── comprovante: página do funcionário dentro do PDF de comprovantes (pdf-lib), em cache ──
async function paginaPdf(doc, pagamentoId, idx) {
  if (!doc.caminho || !fs.existsSync(doc.caminho)) throw erro('Arquivo não disponível no servidor', 404);
  if (!doc.pagina) return doc.caminho;
  const dir = P('paginas'); fs.mkdirSync(dir, { recursive: true }); const out = path.join(dir, String(pagamentoId).replace(/[^A-Za-z0-9_-]/g, '_') + '-' + idx + '.pdf');
  try { if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(doc.caminho).mtimeMs) return out; } catch (e) { /* regenera */ }
  const { PDFDocument } = require('pdf-lib'); const src = await PDFDocument.load(fs.readFileSync(doc.caminho)); if (doc.pagina > src.getPageCount()) throw erro('Página ' + doc.pagina + ' não existe no PDF', 404);
  const nd = await PDFDocument.create(); const [pg] = await nd.copyPages(src, [doc.pagina - 1]); nd.addPage(pg); fs.writeFileSync(out, await nd.save()); return out;
}
/** ARQUIVAR NO GED: a página do comprovante vai para a pasta 08 do prontuário (Gestão Documental), preservando o original e o protocolo */
async function arquivarGed(user, b) {
  const p = perm(user); if (!p.arquivar) throw erro('Só o RH (ou a Coordenação) arquiva no prontuário', 403);
  if (!deps.ged || !deps.ged.importar) throw erro('Gestão Documental não disponível neste servidor', 503);
  const pags = lerJson(P('pagamentos.json'), []); const pag = pags.find(x => x.id === String(b.pagamentoId || '')); if (!pag) throw erro('Pagamento não encontrado', 404);
  const idx = +b.idx; const doc = (pag.docs || [])[idx]; if (!doc || doc.classe !== 'oficial') throw erro('Só o comprovante bancário oficial vai para o prontuário');
  if (!pag.funcId) throw erro('Funcionário sem identificação no PontoCerto: o arquivamento no prontuário precisa do cadastro');
  if (pag.arquivado) throw erro('Comprovante já arquivado em ' + pag.pasta, 409);
  const origem = await paginaPdf(doc, pag.id, idx); const tmp = path.join(os.tmpdir(), 'cb-ged-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf'); fs.copyFileSync(origem, tmp);
  const nome = 'Comprovante bancário ' + (pag.idBanco || pag.id) + ' ' + dBR(pag.efetiva || pag.prevista) + '.pdf';
  const d = await deps.ged.importar(user, { colabId: pag.funcId, categoria: '08', tipo: 'Comprovante bancário', dataDocumento: pag.efetiva || pag.prevista || hojeISO(), competencia: pag.comp || null, confirmado: true, origem: 'outra', observacoes: 'Comprovantes Bancários · ' + pag.id + ' · ' + CB.TIPOS[pag.tipo] + ' · ' + (pag.idBanco || '') + ' · origem: ' + doc.origem }, { path: tmp, originalname: nome, mimetype: 'application/pdf', size: fs.statSync(tmp).size }, deps.ged.pcDeps);
  pag.arquivado = true; pag.pasta = '08 — Recibos e Contracheques · ' + d.protocolo; (pag.hist = pag.hist || []).push({ quem: user.nome || user.usuario, em: agoraIso().slice(0, 16).replace('T', ' '), txt: 'Comprovante arquivado no prontuário (Gestão Documental ' + d.protocolo + ')' });
  gravarJson(P('pagamentos.json'), pags); auditar(user, 'Arquivamento', pag.id, 'Comprovante ' + doc.nome + ' → prontuário de ' + pag.nome + ' · ' + d.protocolo);
  return { ok: true, protocolo: d.protocolo, pasta: pag.pasta };
}

/** catálogo da aba e o que a integração suporta hoje (resposta ao item 11 do prompt: serviços, credenciais e limites) */
function catalogo() {
  return { TIPOS_BANCO, SIT_BANCO, CONC_TXT, MAX_DIAS, CACHE_MIN: CACHE_MS / 60000, CONTAS: Object.entries(CONTA_LOJA).map(([loja, conta]) => ({ loja: +loja, lojaTxt: GP.LOJA_TXT[loja], conta, banco: 'Itaú Unibanco (341)' })),
    SUPORTE: [
      { t: 'Consultar transações e identificar liquidação', st: 'sim', d: 'API oficial Conta Corrente | Extrato (account-statement v1), 6 contas, escopo account-statement.read, mTLS + client credentials guardados só no servidor (data/itau). Tudo que aparece já foi debitado.' },
      { t: 'Identificador oficial da transação', st: 'sim', d: 'Cada lançamento traz o id do evento no banco, preservado na tabela, no vínculo e na auditoria.' },
      { t: 'Beneficiário, CPF/CNPJ, banco, agência e conta', st: 'sim', d: 'Para lançamento individual (bloco counterpart). Lote SISPAG Salários vem só com total e quantidade.' },
      { t: 'Agendado, pendente, rejeitado', st: 'nao', d: 'Não aparecem no extrato. Precisariam da API SISPAG de consulta (só em cópia não oficial, a contratar) ou do retorno CNAB.' },
      { t: 'Comprovante oficial em PDF pela API', st: 'nao', d: 'Nenhuma API contratada entrega comprovante. O módulo mostra "Comprovante indisponível pela integração bancária" e nunca gera documento que simule um. O PDF de comprovantes do Itaú Empresas, lido na Auditoria da Folha, supre o caso a caso.' },
      { t: 'Conta do CD', st: 'nao', d: 'Sem credencial de extrato (403 em 08/10). Precisa do chamado de Conciliação Bancária para a conta 0877/98111-8.' },
      { t: 'Outras instituições', st: 'a confirmar', d: 'A consulta é por conta configurada (CONTA_LOJA + data/itau/config.json); outro banco entra como novo provedor de extrato com o mesmo formato de linha.' },
    ] };
}

module.exports = { consultar, evento, vincular, desvincular, vinculos, arquivarGed, paginaPdf, auditoriaDe, catalogo, perm, TIPOS_BANCO, SIT_BANCO, CONC_TXT, SEM_COMPROVANTE, _interno: { linhaDe, classificar, indices, categoriaDe, _deps: d => { deps = { ...deps, ...d }; cache.clear(); } } };
