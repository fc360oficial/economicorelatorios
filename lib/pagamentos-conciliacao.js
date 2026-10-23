'use strict';
// lib/pagamentos-conciliacao.js — concilia os Pagamentos de Domingos e Feriados com o extrato do Itaú de cada loja (23/10/2026).
// Tiago: "cada loja paga seu funcionário" e "quero que fique automático". Cada loja paga da própria conta; as 6 contas estão
// na API de extrato (lib/itau-extrato.js), o CD não. SÓ LEITURA do banco: nada aqui movimenta dinheiro — o que muda é o
// status do item no nosso relatório. Regra: CPF do favorecido no extrato + valor (do item, ou do total da pessoa no relatório)
// = marca "Pago" sozinho. Valor bate e nome parecido mas sem CPF, dois lançamentos possíveis, ou lote SISPAG com o subtotal
// exato da loja = vira SUGESTÃO para o Financeiro confirmar com um clique. Nunca marca pago com ambiguidade.
const GP = require('./gestao-pessoas');
const PG = require('./pagamentos-df');
const I = PG._interno;   // obterRaw, fluxo, auditar, quem, totais, totalItem, salvarRel, relatorios, r2, hojeISO, semAcento, recomputarStatus

const CONTA_LOJA = { 1: 'cahu', 2: 'muribeca', 3: 'ponte', 4: 'atacarejo', 5: 'portalarga', 6: 'jardimjordao' };
const erro = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });
const dig = s => String(s || '').replace(/\D/g, '');
const brl = n => (+n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const somaDias = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
function nomeBate(a, b) { const A = I.semAcento(a).split(/\s+/).filter(w => w.length > 2), B = I.semAcento(b).split(/\s+/).filter(w => w.length > 2); if (!A.length || !B.length || A[0] !== B[0]) return false; return A.filter(w => B.includes(w)).length >= Math.min(2, A.length, B.length); }

async function conciliar(id, user, deps, opts) {
  opts = opts || {}; const r = I.obterRaw(id); const p = PG.perm(user);
  if (!(p.processar || p.aprovar || opts.sistema)) throw erro('Só Financeiro ou Coordenação conciliam com o banco', 403);
  if (!PG.FIN_STATUS.includes(r.status)) throw erro('Relatório ainda não está no Financeiro');
  const itau = require('./itau-extrato'), parser = require('./extrato-parser');
  const base = (r.previsaoPagamento && r.previsaoPagamento.data) || (r.aprovacao ? r.aprovacao.em.slice(0, 10) : I.hojeISO()); const aprov = r.aprovacao ? r.aprovacao.em.slice(0, 10) : base;
  const ate = I.hojeISO(); let de = somaDias(base < aprov ? base : aprov, -2); if (de < somaDias(ate, -45)) de = somaDias(ate, -45); if (de > ate) de = ate;
  const em = new Date().toISOString(); const res = { relatorio: r.id, em, periodo: { de, ate }, lojas: [], pagos: [], sugestoes: [], semConta: [] };
  const usados = new Set(r.itens.map(i => i.pagamento && i.pagamento.extratoRef).filter(Boolean)); let n = 0;
  for (const loja of r.lojas) {
    const conta = CONTA_LOJA[loja]; const lojaTxt = GP.LOJA_TXT[loja] || String(loja);
    if (!conta) { res.semConta.push({ loja, lojaTxt, motivo: 'conta sem API de extrato do Itaú' }); continue; }
    let saidas; try { saidas = parser.parseSaidasApi(await itau.buscarExtrato({ conta, dataInicio: de, dataFim: ate })); } catch (e) { res.lojas.push({ loja, lojaTxt, conta, erro: e.message }); continue; }
    const cands = saidas.filter(s => !['tributo', 'tarifa_juros', 'aplicacao'].includes(s.categoria)).map((s, k) => ({ ...s, ref: conta + '|' + s.data + '|' + s.valor.toFixed(2) + '|' + (dig(s.documento) || I.semAcento(s.favorecido) || k) }));
    const itens = r.itens.filter(i => i.selecionado && +i.loja === +loja && i.pagamento.status !== 'pago' && i.banco && i.banco.status === 'apto');
    const porFunc = new Map(); for (const i of itens) { const g = porFunc.get(i.funcId) || { funcId: i.funcId, nome: i.nome, itens: [], total: 0 }; g.itens.push(i); g.total = I.r2(g.total + I.totalItem(i)); porFunc.set(i.funcId, g); }
    let nLoja = 0;
    for (const g of porFunc.values()) {
      g.cpf = await deps.cpfDe(g.funcId); const valores = new Set([g.total.toFixed(2), ...g.itens.map(i => I.totalItem(i).toFixed(2))]);
      const porCpf = cands.filter(s => !usados.has(s.ref) && g.cpf && dig(s.documento) === g.cpf); const exatos = porCpf.filter(s => valores.has(s.valor.toFixed(2)));
      const porValorNome = porCpf.length ? [] : cands.filter(s => !usados.has(s.ref) && !dig(s.documento) && valores.has(s.valor.toFixed(2)) && nomeBate(s.favorecido, g.nome));
      let esc = null, modo = null; if (exatos.length === 1) { esc = exatos[0]; modo = 'CPF + valor'; } else if (!porCpf.length && porValorNome.length === 1) { esc = porValorNome[0]; modo = 'valor + nome'; }
      if (esc) {
        const alvo = esc.valor.toFixed(2) === g.total.toFixed(2) ? g.itens : [g.itens.find(i => I.totalItem(i).toFixed(2) === esc.valor.toFixed(2))];
        for (const i of alvo) { i.pagamento = { status: 'pago', statusTxt: PG.PAG_TXT.pago, data: esc.data, modalidade: /pix/i.test(esc.historico) ? 'pix' : 'transferencia', transacao: esc.historico.slice(0, 80), comprovante: null, obs: 'Conciliado automaticamente com o extrato Itaú (' + conta + ', ' + modo + ')', extratoRef: esc.ref, conciliado: true, ...I.quem(user), em }; res.pagos.push({ key: i.key, nome: i.nome, loja, valor: I.totalItem(i), data: esc.data, modo }); n++; nLoja++; I.auditar({ usuario: user, ref: r.id, item: i.key, acao: 'pagamento', justificativa: i.pagamento.obs, depois: { status: 'pago', data: esc.data, extrato: esc.ref } }); }
        usados.add(esc.ref);
      } else if (porCpf.length || porValorNome.length) {
        res.sugestoes.push({ funcId: g.funcId, nome: g.nome, loja, lojaTxt, total: g.total, itens: g.itens.map(i => ({ key: i.key, data: i.data, valor: I.totalItem(i) })), lancamentos: [...porCpf, ...porValorNome].slice(0, 6).map(s => ({ ref: s.ref, data: s.data, valor: s.valor, favorecido: s.favorecido, documento: dig(s.documento) ? '***.***.' + dig(s.documento).slice(6, 9) + '-' + dig(s.documento).slice(9) : null, historico: s.historico })), motivo: porCpf.length ? (exatos.length ? 'mais de um lançamento com o mesmo CPF e valor' : 'CPF bate, mas o valor não (' + porCpf.map(s => brl(s.valor)).join(', ') + ')') : 'valor bate e nome parecido, sem CPF no extrato' });
      }
    }
    const subtotal = I.r2([...porFunc.values()].reduce((a, g) => a + g.total, 0)); const lote = cands.filter(s => s.categoria === 'salario' && s.valor.toFixed(2) === subtotal.toFixed(2) && !usados.has(s.ref));
    if (lote.length && subtotal > 0 && nLoja < porFunc.size) res.sugestoes.push({ lote: true, loja, lojaTxt, total: subtotal, itens: [...porFunc.values()].flatMap(g => g.itens.filter(i => i.pagamento.status !== 'pago').map(i => ({ key: i.key, nome: i.nome, data: i.data, valor: I.totalItem(i) }))), lancamentos: lote.map(s => ({ ref: s.ref, data: s.data, valor: s.valor, favorecido: s.favorecido, historico: s.historico })), motivo: 'lote SISPAG com o valor exato do subtotal da loja' });
    res.lojas.push({ loja, lojaTxt, conta, saidas: cands.length, conciliados: nLoja, aguardando: porFunc.size - nLoja });
  }
  I.recomputarStatus(r); r.conciliacao = { em, ...I.quem(user), periodo: res.periodo, lojas: res.lojas, semConta: res.semConta, pagos: res.pagos.length, sugestoes: res.sugestoes };
  if (n) I.fluxo(r, user, 'conciliar', n + ' pagamento(s) conciliado(s) com o extrato Itaú'); r.totais = I.totais(r); I.salvarRel();
  I.auditar({ usuario: user, ref: r.id, acao: 'conciliar', detalhe: { periodo: res.periodo, pagos: n, sugestoes: res.sugestoes.length, lojas: res.lojas.map(l => l.conta + ':' + (l.erro || l.conciliados)) } });
  return { ...res, status: r.status, statusTxt: PG.STATUS_TXT[r.status], totais: r.totais };
}
/** rotina automática: relatórios no Financeiro com aprovação/previsão nos últimos 40 dias, só casamentos sem ambiguidade */
async function conciliarTodos() {
  const pc = require('./pontocerto'); const deps = { cpfDe: id => pc.cpfDe(id) }; const user = { usuario: 'sistema', nome: 'Conciliação Itaú' }; const lim = somaDias(I.hojeISO(), -40); const out = [];
  for (const r of I.relatorios()) {
    if (!PG.FIN_STATUS.includes(r.status) || ['pago', 'processado'].includes(r.status)) continue; const ref = (r.previsaoPagamento && r.previsaoPagamento.data) || (r.aprovacao ? r.aprovacao.em.slice(0, 10) : ''); if (ref < lim) continue;
    if (!r.itens.some(i => i.selecionado && i.pagamento.status !== 'pago' && i.banco && i.banco.status === 'apto')) continue;
    try { const x = await conciliar(r.id, user, deps, { sistema: true }); out.push(r.id + ': ' + x.pagos.length + ' pago(s), ' + x.sugestoes.length + ' sugestão(ões)'); } catch (e) { out.push(r.id + ': ' + e.message); }
  }
  if (out.length) console.log('[pagamentos-df] conciliação Itaú:', out.join(' | ')); return out;
}
module.exports = { conciliar, conciliarTodos, CONTA_LOJA, nomeBate };
