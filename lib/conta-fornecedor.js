'use strict';
// Conta do fornecedor (23/10/2026, Tiago) — extrato por fornecedor do que ele nos deve por avaria (e, depois, falta e
// recusa no recebimento) e de como pagou (desconto no boleto, bonificação, troca física, nota de devolução).
//
//   • A avaria NASCE e é BAIXADA no ERP (central.avariaconsumo), pela prevenção. Este módulo só lê: a cada hora traz
//     as avarias abertas (Tipo=1, Status 0 aberta / 3 em trâmite) como DÉBITO, e quando o status muda lá marca a baixa.
//     Status 9 (cancelada) estorna o débito. Nunca escreve no ERP.
//   • Quem diz COMO a avaria foi paga é o fiscal, dentro da nota (lib/fiscal.js + fiscal.html): vira PAGAMENTO aqui,
//     aplicado da avaria mais antiga pra mais nova, a menos que ele aponte uma específica.
//   • Parcial: a avaria fica "paga 80 de 100, falta 20" e NÃO sai da fila de baixa até zerar. Sobra: vira CRÉDITO a favor
//     do fornecedor e abate a próxima avaria dele sozinho.
//   • Bonificação é avaria por padrão; é ACORDO COMERCIAL só se o Compras avisou antes no pedido (p.bonif_combinada).
//     Acordo fica FORA da conta (registrado, mas não abate nada).
//   • Pedido de COTAÇÃO não traz avaria e não mostra saldo (regra de 25/09 em pedidos-fornecedor).
//
// Dados em data/conta-fornecedor/conta.json (gitignored): { seq, debitos[], pagamentos[], sync }. Desde 28/10/26 à noite
// o mesmo estado vai também pro Postgres (doc_json 'conta-fornecedor'/'conta', lib/pg-docs.js); sem arquivo na subida,
// vem do banco.
const fs = require('fs');
const path = require('path');
const pgDocs = require('./pg-docs');
const docs = pgDocs('conta-fornecedor');

const DIR = path.join(__dirname, '..', 'data', 'conta-fornecedor');
const ARQ = path.join(DIR, 'conta.json');
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO', 10: 'DISTRIBUIDORA' };
// Status do ERP (central.avariaconsumo): 0 e 3 = em aberto com o fornecedor. 2 e 4 o app trata como baixada
// (2 parece "resolvida", 4 "baixada no estoque" — inferido da base em 23/10/26, a confirmar com a prevenção). 9 = cancelada.
const ERP_STATUS = { 0: 'aberta', 2: 'resolvida', 3: 'em trâmite', 4: 'baixada', 9: 'cancelada', 99: 'antiga' };
const ERP_ABERTA = [0, 3];
const FORMAS = { bonificacao: 'Bonificação', desconto_nota: 'Desconto na nota', desconto_boleto: 'Desconto no boleto', troca: 'Troca física', devolucao: 'Nota de devolução', ajuste: 'Ajuste manual', credito: 'Crédito aplicado', acordo: 'Acordo comercial' };
const TIPOS_DEBITO = { avaria: 'Avaria', falta: 'Falta no recebimento', recusa: 'Recusa no recebimento', ajuste: 'Ajuste manual' };

let qERP = null, deps = {}, st = null;
const r2 = v => Math.round((+v || 0) * 100) / 100;
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const diasDesde = iso => iso ? Math.max(0, Math.round((new Date(hojeISO() + 'T12:00:00') - new Date(String(iso).slice(0, 10) + 'T12:00:00')) / 86400000)) : null;
const agora = () => new Date().toISOString();

function init(q, d) {
  qERP = q; deps = d || {}; fs.mkdirSync(DIR, { recursive: true }); carregar();
  if (docs.disponivel()) docs.carregar('conta').then(b => {
    const doBanco = b && b.get('conta');
    if (doBanco && !st.debitos.length && !st.pagamentos.length && Array.isArray(doBanco.debitos) && doBanco.debitos.length) { st = doBanco; gravar(); console.log('[CONTA-FORN] estado veio do banco (arquivo vazio)'); }
    else docs.gravar('conta', 'conta', st);
  }).catch(e => console.error('[CONTA-FORN] banco:', e.message));
}
function carregar() {
  try { st = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { st = null; }
  if (!st || typeof st !== 'object') st = {};
  st.seq = st.seq || 1; st.debitos = Array.isArray(st.debitos) ? st.debitos : []; st.pagamentos = Array.isArray(st.pagamentos) ? st.pagamentos : []; st.sync = st.sync || null;
}
function gravar() { const tmp = ARQ + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, ARQ); docs.gravar('conta', 'conta', st); }
const novoId = pref => pref + (st.seq++);
const erro = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });

// ───────────────────────── regras de aplicação ─────────────────────────
const emAberto = d => d.status === 'aberta' || d.status === 'parcial';
const restante = d => r2(d.valor - (d.pago || 0));
// 26/10/26 (Tiago): a conta é do fornecedor na rede, mas o ABATIMENTO é por loja — a bonificação/desconto que chega
// na nota de uma loja só paga avaria DAQUELA loja. `loja` opcional: sem ela, a rede inteira (Prevenção).
function abertos(codFornec, loja) { const l = +loja || null; return st.debitos.filter(d => +d.codFornec === +codFornec && emAberto(d) && (!l || +d.loja === l)).sort((a, b) => (a.data || '').localeCompare(b.data || '') || (a.id > b.id ? 1 : -1)); }
// crédito (sobra de pagamento) segue a mesma regra: sobra numa nota da loja 2 só abate avaria da loja 2; sobra sem loja (ajuste manual) abate qualquer
const creditoServe = (p, loja) => p.sobra > 0 && (!p.loja || !loja || +p.loja === +loja);
function atualizarStatus(d) { if (d.status === 'cancelada') return; d.pago = r2(d.pago || 0); d.status = d.pago <= 0 ? 'aberta' : d.pago >= d.valor - 0.004 ? 'paga' : 'parcial'; }
// aplica `valor` do pagamento no débito; devolve o que coube
function alocar(pag, d, valor, forma) {
  const v = r2(Math.min(valor, restante(d))); if (v <= 0) return 0;
  d.pago = r2((d.pago || 0) + v); d.pagamentos = d.pagamentos || []; d.pagamentos.push({ id: pag.id, valor: v, forma: forma || pag.forma, em: agora(), nota: pag.nota ? pag.nota.nNota || null : null });
  atualizarStatus(d);
  pag.alocacoes = pag.alocacoes || []; pag.alocacoes.push({ debito_id: d.id, valor: v, cod: d.cod, descricao: d.descricao, loja: d.loja });
  return v;
}
// crédito (sobra de pagamentos anteriores) do fornecedor abate o débito `d`
function aplicarCreditoEm(d) {
  if (!emAberto(d)) return 0; let total = 0;
  for (const pag of st.pagamentos.filter(p => +p.codFornec === +d.codFornec && creditoServe(p, d.loja)).sort((a, b) => (a.data || '').localeCompare(b.data || ''))) {
    const v = alocar(pag, d, pag.sobra, 'credito'); if (!v) continue;
    pag.sobra = r2(pag.sobra - v); total = r2(total + v);
    if (!emAberto(d)) break;
  }
  return total;
}
function aplicarCreditoFornecedor(codFornec) { for (const d of abertos(codFornec)) aplicarCreditoEm(d); }
function cancelarDebito(d, motivo) {
  if (d.status === 'cancelada') return;
  // devolve o que já tinha sido pago nela pros pagamentos de origem (vira sobra = crédito do fornecedor)
  for (const a of d.pagamentos || []) { const pag = st.pagamentos.find(p => p.id === a.id); if (!pag) continue; pag.sobra = r2((pag.sobra || 0) + a.valor); pag.alocacoes = (pag.alocacoes || []).filter(x => x.debito_id !== d.id); }
  d.status = 'cancelada'; d.cancelada_em = agora(); d.cancelada_motivo = motivo || null;
  aplicarCreditoFornecedor(d.codFornec);
}

// ───────────────────────── pagamentos (o fiscal marca) ─────────────────────────
function registrarPagamento(c, por) {
  const codFornec = +c.codFornec; if (!(codFornec > 0)) throw erro('fornecedor inválido');
  const forma = String(c.forma || ''); if (!FORMAS[forma] || forma === 'credito') throw erro('forma de pagamento inválida');
  const classificacao = c.classificacao === 'acordo' || forma === 'acordo' ? 'acordo' : 'avaria';
  const valor = r2(c.valor); if (!(valor > 0)) throw erro('valor inválido');
  const pag = {
    id: novoId('p'), codFornec, fornecedor: c.fornecedor || nomeFornec(codFornec), loja: +c.loja || null,
    forma: classificacao === 'acordo' ? 'acordo' : forma, classificacao, valor, data: c.data && /^\d{4}-\d{2}-\d{2}$/.test(c.data) ? c.data : hojeISO(),
    nota: c.nota && (c.nota.nReg || c.nota.nNota || c.nota.chave) ? { nReg: +c.nota.nReg || null, nNota: c.nota.nNota || null, chave: c.nota.chave || null } : null,
    itens: Array.isArray(c.itens) ? c.itens.slice(0, 50).map(i => ({ cod: String(i.cod || ''), descricao: String(i.descricao || '').slice(0, 80), qtd: +i.qtd || 0, valor: r2(i.valor) })) : [],
    acordo: classificacao === 'acordo' ? { pedidoId: +c.acordo?.pedidoId || null, motivo: String(c.acordo?.motivo || '').slice(0, 200) || null } : null,
    alocacoes: [], sobra: 0, por: por || null, em: agora(), obs: String(c.obs || '').trim().slice(0, 300) || null,
  };
  if (classificacao === 'avaria') {
    let resto = valor;
    // 1) o que o fiscal apontou (só avaria da mesma loja da nota — 26/10)
    for (const a of Array.isArray(c.alocacoes) ? c.alocacoes : []) {
      const d = st.debitos.find(x => x.id === a.debito_id && +x.codFornec === codFornec); if (!d || !emAberto(d)) continue;
      if (pag.loja && +d.loja !== pag.loja) continue;
      resto = r2(resto - alocar(pag, d, Math.min(resto, r2(a.valor) || resto)));
      if (resto <= 0) break;
    }
    // 2) o resto vai da avaria mais antiga pra mais nova, DA LOJA da nota (sem loja = rede, ajuste da Prevenção)
    for (const d of abertos(codFornec, pag.loja)) { if (resto <= 0) break; resto = r2(resto - alocar(pag, d, resto)); }
    pag.sobra = r2(Math.max(0, resto));   // 3) sobrou = crédito a favor do fornecedor (naquela loja)
  }
  st.pagamentos.push(pag); gravar();
  return pag;
}
function ajuste(c, por) {
  const codFornec = +c.codFornec; if (!(codFornec > 0)) throw erro('fornecedor inválido');
  const valor = r2(c.valor); if (!(valor > 0)) throw erro('valor inválido');
  const motivo = String(c.motivo || '').trim(); if (motivo.length < 3) throw erro('informe o motivo do ajuste');
  if (c.tipo === 'debito') {
    const d = { id: novoId('d'), tipo: 'ajuste', codFornec, fornecedor: c.fornecedor || nomeFornec(codFornec), loja: +c.loja || null, cod: String(c.cod || ''), descricao: String(c.descricao || motivo).slice(0, 80), qtd: +c.qtd || 0, und: 'UN', valor_un: 0, valor, data: hojeISO(), origem: { manual: true }, erp: null, pago: 0, status: 'aberta', pagamentos: [], criado_em: agora(), criado_por: por || null, obs: motivo };
    st.debitos.push(d); aplicarCreditoEm(d); gravar(); return d;
  }
  if (c.tipo === 'credito') return registrarPagamento({ codFornec, loja: c.loja, forma: 'ajuste', valor, obs: motivo, alocacoes: c.alocacoes, fornecedor: c.fornecedor }, por);
  throw erro('tipo de ajuste inválido');
}
function desfazerPagamento(id, por) {
  const i = st.pagamentos.findIndex(p => p.id === id); if (i < 0) throw erro('pagamento não encontrado', 404);
  const pag = st.pagamentos[i];
  for (const a of pag.alocacoes || []) { const d = st.debitos.find(x => x.id === a.debito_id); if (!d) continue; d.pago = r2((d.pago || 0) - a.valor); d.pagamentos = (d.pagamentos || []).filter(x => x.id !== pag.id); atualizarStatus(d); }
  st.pagamentos.splice(i, 1); gravar();
  return { ok: true, desfeito: pag.id, por };
}

// ───────────────────────── ERP → débitos (a cada hora) ─────────────────────────
const _nomes = {};
function nomeFornec(cod) { return _nomes[cod] || st.debitos.find(d => +d.codFornec === +cod)?.fornecedor || ('Fornecedor ' + cod); }
async function nomesERP(cods) {
  const falta = [...new Set(cods.map(Number))].filter(c => c > 0 && !_nomes[c]); if (!falta.length || !qERP) return;
  for (let i = 0; i < falta.length; i += 500) {
    const lote = falta.slice(i, i + 500);
    const rows = await qERP(`SELECT CodFornec, Nome, NomeCompleto FROM central.fornecedor WHERE CodFornec IN (${lote.map(() => '?').join(',')})`, lote).catch(() => []);
    for (const r of rows) _nomes[+r.CodFornec] = String(r.Nome || r.NomeCompleto || '').trim() || ('Fornecedor ' + r.CodFornec);
  }
}
let _sincronizando = null;
function sincronizar(motivo) { if (_sincronizando) return _sincronizando; _sincronizando = _sincronizar(motivo).finally(() => { _sincronizando = null; }); return _sincronizando; }
async function _sincronizar(motivo) {
  if (!qERP) throw erro('ERP não configurado', 409);
  const t0 = Date.now(); const res = { em: agora(), motivo: motivo || 'auto', abertas: 0, novas: 0, baixadas: 0, canceladas: 0, alteradas: 0, erro: null, ms: 0 };
  try {
    const rows = await qERP(`SELECT nReg, nLoja, CodFornec, CodigoBarras, TRIM(Descricao) Descricao, Qtd, Valor, Total, Und, DATE_FORMAT(DataLan,'%Y-%m-%d') data, Status, nPedido
                             FROM central.avariaconsumo WHERE Tipo=1 AND Status IN (0,3) AND CodFornec>0 AND Total>0`);
    res.abertas = rows.length;
    await nomesERP(rows.map(r => r.CodFornec));
    const porReg = new Map(); for (const d of st.debitos) if (d.tipo === 'avaria' && d.origem?.nReg) porReg.set(+d.origem.nReg, d);
    const vistos = new Set();
    for (const r of rows) {
      const nReg = +r.nReg; vistos.add(nReg);
      const total = r2(r.Total), qtd = +(+r.Qtd || 0).toFixed(3);
      let d = porReg.get(nReg);
      if (!d) {
        d = { id: novoId('d'), tipo: 'avaria', codFornec: +r.CodFornec, fornecedor: _nomes[+r.CodFornec] || ('Fornecedor ' + r.CodFornec), loja: +r.nLoja, cod: String(r.CodigoBarras || ''), descricao: String(r.Descricao || '').slice(0, 80), qtd, und: r.Und || 'UN', valor_un: r2(r.Valor), valor: total, data: r.data,
          origem: { nReg, nPedido: +r.nPedido || null }, erp: { status: +r.Status, nome: ERP_STATUS[+r.Status] || String(r.Status), visto_em: agora(), baixado_em: null }, pago: 0, status: 'aberta', pagamentos: [], criado_em: agora(), criado_por: 'erp', obs: null };
        st.debitos.push(d); porReg.set(nReg, d); res.novas++;
        aplicarCreditoEm(d);   // fornecedor com crédito de sobra: abate já
        continue;
      }
      if (d.status === 'cancelada') { d.status = 'aberta'; d.cancelada_em = null; atualizarStatus(d); res.alteradas++; }   // voltou a aberta no ERP
      if (Math.abs(d.valor - total) > 0.004 || Math.abs((d.qtd || 0) - qtd) > 0.0005) { d.valor = total; d.qtd = qtd; d.valor_un = r2(r.Valor); atualizarStatus(d); res.alteradas++; }
      d.erp = { ...(d.erp || {}), status: +r.Status, nome: ERP_STATUS[+r.Status] || String(r.Status), visto_em: agora(), baixado_em: null };
    }
    // avarias que estavam aqui e saíram do IN (0,3): baixadas ou canceladas no ERP
    const sumiram = st.debitos.filter(d => d.tipo === 'avaria' && d.origem?.nReg && !vistos.has(+d.origem.nReg) && !(d.erp && d.erp.baixado_em) && d.status !== 'cancelada');
    for (let i = 0; i < sumiram.length; i += 500) {
      const lote = sumiram.slice(i, i + 500);
      const stRows = await qERP(`SELECT nReg, Status FROM central.avariaconsumo WHERE nReg IN (${lote.map(() => '?').join(',')})`, lote.map(d => +d.origem.nReg));
      const stMap = new Map(stRows.map(x => [+x.nReg, +x.Status]));
      for (const d of lote) {
        const s = stMap.has(+d.origem.nReg) ? stMap.get(+d.origem.nReg) : null;
        if (s === 9 || s === null) { cancelarDebito(d, s === null ? 'apagada no ERP' : 'cancelada no ERP'); d.erp = { ...(d.erp || {}), status: s, nome: s === null ? 'apagada' : 'cancelada', visto_em: agora() }; res.canceladas++; }
        else { d.erp = { ...(d.erp || {}), status: s, nome: ERP_STATUS[s] || String(s), visto_em: agora(), baixado_em: agora() }; res.baixadas++; }
      }
    }
  } catch (e) { res.erro = e.message; console.error('[CONTA-FORN] sync:', e.message); }
  res.ms = Date.now() - t0; st.sync = res; gravar();
  if (res.novas || res.baixadas || res.canceladas) console.log('[CONTA-FORN] sync: ' + res.abertas + ' abertas no ERP · ' + res.novas + ' novas · ' + res.baixadas + ' baixadas · ' + res.canceladas + ' canceladas · ' + res.ms + ' ms');
  return res;
}

// ───────────────────────── consultas ─────────────────────────
// `loja` opcional (26/10): saldo só daquela loja — é o que o Fiscal vê na nota. Sem loja = rede inteira, com quebra por loja.
function saldoDe(codFornec, loja) {
  const l = +loja || null;
  const ab = abertos(codFornec, l);
  const deve = r2(ab.reduce((s, d) => s + restante(d), 0));
  const credito = r2(st.pagamentos.filter(p => +p.codFornec === +codFornec && creditoServe(p, l)).reduce((s, p) => s + p.sobra, 0));
  const maisAntigo = ab.length ? ab[0].data : null;
  return { codFornec: +codFornec, fornecedor: nomeFornec(codFornec), loja: l, loja_nome: l ? (LOJAS_NOMES[l] || ('Loja ' + l)) : null, deve, credito, n_abertos: ab.length, mais_antigo: maisAntigo, mais_antigo_dias: diasDesde(maisAntigo), por_loja: ab.reduce((m, d) => { m[d.loja] = r2((m[d.loja] || 0) + restante(d)); return m; }, {}) };
}
const debOut = d => ({ ...d, restante: restante(d), dias: diasDesde(d.data), loja_nome: LOJAS_NOMES[d.loja] || ('Loja ' + d.loja), tipo_nome: TIPOS_DEBITO[d.tipo] || d.tipo });
const pagOut = p => ({ ...p, forma_nome: FORMAS[p.forma] || p.forma, loja_nome: p.loja ? (LOJAS_NOMES[p.loja] || ('Loja ' + p.loja)) : null });
// `filtro.loja` (26/10, Tiago: "quebrar por lojas"): tudo da tela só daquela loja. Sem loja = rede, com a quebra por loja em
// cada fornecedor (por_loja) e no total (kpis.por_loja). Cuidado: saldoDe tem 2º parâmetro (loja) — nunca passar direto no .map.
function resumo(filtro) {
  const loja = filtro && +filtro.loja > 0 ? +filtro.loja : null;
  const daLoja = d => !loja || +d.loja === loja;
  const cods = new Set([...st.debitos.filter(emAberto).map(d => +d.codFornec), ...st.pagamentos.filter(p => p.sobra > 0).map(p => +p.codFornec)]);
  const fornecedores = [...cods].map(c => saldoDe(c, loja)).filter(f => !loja || f.deve > 0 || f.credito > 0).sort((a, b) => (b.mais_antigo_dias || 0) - (a.mais_antigo_dias || 0) || b.deve - a.deve);
  const fila = st.debitos.filter(d => d.tipo === 'avaria' && d.status === 'paga' && !(d.erp && d.erp.baixado_em) && daLoja(d)).map(debOut).sort((a, b) => (a.pagamentos.at(-1)?.em || '').localeCompare(b.pagamentos.at(-1)?.em || ''));
  const semPagamento = st.debitos.filter(d => d.tipo === 'avaria' && emAberto(d) && d.erp && d.erp.baixado_em && daLoja(d)).map(debOut).sort((a, b) => (b.erp.baixado_em || '').localeCompare(a.erp.baixado_em || ''));
  const totalDeve = r2(fornecedores.reduce((s, f) => s + f.deve, 0)), totalCredito = r2(fornecedores.reduce((s, f) => s + f.credito, 0));
  const maisAntigo = fornecedores.find(f => f.deve > 0) || null;
  const pagos30 = st.pagamentos.filter(p => p.classificacao !== 'acordo' && diasDesde(p.data) <= 30 && (!loja || !p.loja || +p.loja === loja));
  // quebra por loja da rede inteira (independe do filtro): deve, nº de fornecedores devendo e nº de avarias abertas
  const porLoja = {};
  for (const d of st.debitos.filter(emAberto)) { const l = porLoja[d.loja] || (porLoja[d.loja] = { loja: +d.loja, loja_nome: LOJAS_NOMES[d.loja] || ('Loja ' + d.loja), deve: 0, n_abertos: 0, fornecedores: new Set() }); l.deve = r2(l.deve + restante(d)); l.n_abertos++; l.fornecedores.add(+d.codFornec); }
  const por_loja = Object.values(porLoja).map(l => ({ ...l, fornecedores: l.fornecedores.size })).sort((a, b) => a.loja - b.loja);
  return {
    loja, loja_nome: loja ? (LOJAS_NOMES[loja] || ('Loja ' + loja)) : null,
    kpis: { deve: totalDeve, fornecedores_devendo: fornecedores.filter(f => f.deve > 0).length, lancamentos_abertos: st.debitos.filter(d => emAberto(d) && daLoja(d)).length, credito: totalCredito, fornecedores_credito: fornecedores.filter(f => f.credito > 0).length,
      fila: fila.length, sem_pagamento: semPagamento.length, mais_antigo: maisAntigo ? { fornecedor: maisAntigo.fornecedor, codFornec: maisAntigo.codFornec, dias: maisAntigo.mais_antigo_dias, deve: maisAntigo.deve } : null,
      pagos_30d: r2(pagos30.reduce((s, p) => s + p.valor, 0)), n_pagos_30d: pagos30.length, por_loja },
    fornecedores, fila, sem_pagamento: semPagamento, sync: st.sync, formas: FORMAS, tipos: TIPOS_DEBITO, lojas: LOJAS_NOMES, erp_status: ERP_STATUS,
  };
}
function extrato(codFornec, filtro) {
  const loja = filtro && filtro.loja ? +filtro.loja : null;
  const debs = st.debitos.filter(d => +d.codFornec === +codFornec && (!loja || +d.loja === loja));
  const pags = st.pagamentos.filter(p => +p.codFornec === +codFornec && (!loja || +p.loja === loja || !p.loja));
  const linhas = [];
  for (const d of debs) linhas.push({ k: 'debito', data: d.data, ord: d.criado_em, ...debOut(d), sinal: d.status === 'cancelada' ? 0 : +d.valor });
  for (const p of pags) linhas.push({ k: 'pagamento', data: p.data, ord: p.em, ...pagOut(p), sinal: p.classificacao === 'acordo' ? 0 : -p.valor });
  linhas.sort((a, b) => (a.data || '').localeCompare(b.data || '') || (a.ord || '').localeCompare(b.ord || ''));
  let acum = 0; for (const l of linhas) { acum = r2(acum + l.sinal); l.saldo_acum = acum; }
  // com filtro de loja o cabeçalho é o saldo DAQUELA loja; a quebra por loja (chips) e o total da rede vêm sempre
  const rede = saldoDe(codFornec);
  return { ...(loja ? saldoDe(codFornec, loja) : rede), por_loja: rede.por_loja, rede_deve: rede.deve, rede_credito: rede.credito, abertos: abertos(codFornec, loja).map(debOut), extrato: linhas.reverse(), loja };
}

// ───────────────────────── pra nota aberta no Fiscal ─────────────────────────
// d = detalhe do recebimento (lib/fiscal.js). Devolve o que a faixa mostra: saldo, avarias abertas, o que já foi
// marcado nesta nota e as SUGESTÕES (bonificação: aviso do Compras → avaria do mesmo produto → sem explicação;
// desconto no XML: paga as avarias mais antigas).
// 26/10 (Tiago): tudo aqui é DA LOJA da nota — avarias abertas/em trâmite daquela loja, bonificação e desconto só
// abatem avaria daquela loja. O saldo da rede vai junto (`rede`) só pra informar; a conta completa fica na Prevenção.
function paraNota(d) {
  const codFornec = +d.codFornec; if (!(codFornec > 0)) return null;
  const loja = +d.loja || null;
  const saldo = saldoDe(codFornec, loja);
  const rede = loja ? saldoDe(codFornec) : saldo;
  const pagosNesta = st.pagamentos.filter(p => p.nota && +p.nota.nReg === +d.nReg).map(pagOut);
  const ab = abertos(codFornec, loja).map(debOut);
  const jaCod = new Set(pagosNesta.flatMap(p => (p.itens || []).map(i => i.cod)));
  const sugestoes = [];
  // bonificação: cada item que veio bonificado nesta conferência
  const bonifItens = (d.itens || []).filter(i => i.xml_qtd_bonif > 0 && !jaCod.has(i.ean));
  const combinados = deps.bonifCombinada ? deps.bonifCombinada(codFornec, d.loja) : [];   // [{pedidoId, cod, qtd, motivo, usado}]
  const consumidoDeb = {};
  for (const it of bonifItens) {
    const valorBonif = r2((it.por_nota || []).filter(n => n.mov === 'bonif').reduce((s, n) => s + (n.valor || 0), 0));
    let qtd = +it.xml_qtd_bonif || 0; if (!(qtd > 0)) continue;
    const debsCod = ab.filter(x => x.cod === it.ean);
    const vUn = valorBonif > 0 ? valorBonif / qtd : (debsCod[0] ? debsCod[0].valor_un : 0);
    // 1) aviso do Compras
    for (const c of combinados.filter(c => c.cod === it.ean && c.qtd > 0)) {
      if (qtd <= 0) break; const q = Math.min(qtd, c.qtd); qtd = +(qtd - q).toFixed(3); c.qtd = +(c.qtd - q).toFixed(3);
      sugestoes.push({ tipo: 'acordo', cod: it.ean, descricao: it.descricao, qtd: q, valor: r2(q * vUn), pedidoId: c.pedidoId, motivo: c.motivo, por: c.por, texto: 'combinado pelo Compras no pedido #' + c.pedidoId + (c.motivo ? ' (' + c.motivo + ')' : '') });
    }
    // 2) avaria aberta do mesmo produto, da mais antiga pra mais nova
    for (const deb of debsCod) {
      if (qtd <= 0) break;
      const jaQ = consumidoDeb[deb.id] || 0; const restQ = Math.max(0, (deb.qtd || 0) - jaQ); if (restQ <= 0) continue;
      const q = Math.min(qtd, restQ); qtd = +(qtd - q).toFixed(3); consumidoDeb[deb.id] = jaQ + q;
      const v = r2(Math.min(q * vUn || deb.restante, deb.restante));
      sugestoes.push({ tipo: 'avaria', cod: it.ean, descricao: it.descricao, qtd: q, valor: v, debito_id: deb.id, debito: { id: deb.id, loja: deb.loja, loja_nome: deb.loja_nome, data: deb.data, dias: deb.dias, qtd: deb.qtd, valor: deb.valor, restante: deb.restante, nReg: deb.origem?.nReg || null }, texto: 'parece pagar a avaria ' + (deb.origem?.nReg || deb.id) + ' (' + deb.loja_nome + ', ' + deb.data + ')' });
    }
    // 3) sobrou
    if (qtd > 0) sugestoes.push({ tipo: 'sem_explicacao', cod: it.ean, descricao: it.descricao, qtd, valor: r2(qtd * vUn), texto: saldo.deve > 0 ? 'não casa com aviso do Compras nem com avaria deste produto nesta loja' : (rede.deve > 0 ? 'fornecedor sem avaria aberta NESTA loja (deve em outra loja, que se acerta lá): bonificação sem explicação' : 'fornecedor sem avaria aberta: bonificação sem explicação') });
  }
  // desconto no XML
  const desconto = r2((d.notas || []).reduce((s, n) => s + (n.desconto || 0), 0));
  if (desconto > 0 && saldo.deve > 0 && !pagosNesta.some(p => p.forma === 'desconto_nota')) {
    let resto = desconto; const alvo = [];
    for (const deb of ab) { if (resto <= 0) break; const v = r2(Math.min(resto, deb.restante)); alvo.push({ debito_id: deb.id, valor: v, nReg: deb.origem?.nReg || null, loja_nome: deb.loja_nome, descricao: deb.descricao }); resto = r2(resto - v); }
    sugestoes.push({ tipo: 'desconto', valor: desconto, alocacoes: alvo, sobra: resto, texto: 'a nota veio com desconto de R$ ' + desconto.toFixed(2).replace('.', ',') + ': paga ' + (alvo.length === 1 ? 'a avaria ' + (alvo[0].nReg || '') : alvo.length + ' avarias, da mais antiga pra mais nova') + (resto > 0 ? ' e sobram R$ ' + resto.toFixed(2).replace('.', ',') + ' de crédito' : '') });
  }
  return { saldo, rede: { deve: rede.deve, credito: rede.credito, n_abertos: rede.n_abertos, por_loja: rede.por_loja }, abertos: ab.slice(0, 60), n_abertos: ab.length, pagos_nesta: pagosNesta, sugestoes, formas: FORMAS, tem_pendencia: saldo.deve > 0 || saldo.credito > 0 || sugestoes.length > 0 };
}
// pra lista do Fiscal: bolinha na nota do fornecedor que deve NESTA loja (sem olhar os itens — só o saldo da loja)
function marcadorLista(codFornec, temBonifOuDesconto, loja) { const s = +codFornec > 0 ? saldoDe(codFornec, loja) : null; if (!s || (!s.deve && !s.credito)) return null; return { nivel: temBonifOuDesconto ? 'erro' : 'aviso', deve: s.deve, credito: s.credito, dias: s.mais_antigo_dias }; }

module.exports = { init, sincronizar, registrarPagamento, ajuste, desfazerPagamento, resumo, extrato, saldoDe, paraNota, marcadorLista, FORMAS, TIPOS_DEBITO, ERP_STATUS, LOJAS_NOMES, _estado: () => st };
