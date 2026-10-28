// Gestão Gerencial › quadros do início (27/10/2026, Tiago: "pegar o layout do Fluxo no mobile e trazer pro gerencial:
// quando ele logasse apareciam os quadrados mostrando desempenho, gestão disciplinar, ponto, avarias, sem giro").
// A tela monta cinco quadros no estilo dos cartões do Fluxo Certo 360. Este módulo entrega só o que as rotas existentes
// não trazem: PONTO (jornada de hoje da loja, a mesma leitura da TV RH/DP em lib/tv-rh.js) e SEM GIRO (cache de
// lib/sem-giro.js). Desempenho e Avarias saem de /api/gestao-gerencial; Gestão Disciplinar, de /api/disciplinar/me.
// Só leitura: nada aqui grava no ERP nem no PontoCerto.
'use strict';

const LOJA_TXT = { 1: 'E1 · Socorro', 2: 'E2 · Muribeca', 3: 'E3 · Ponte', 4: 'E4 · Atacarejo', 5: 'E5 · Porta Larga', 6: 'E6 · Jardim Jordão' };
const MAX_PENDENCIAS = 80;   // lista da gaveta do quadro Ponto
const MAX_ITENS = 30;        // lista da gaveta do quadro Sem Giro
const MAX_PESSOAS = 200;     // equipe da loja na tela Ponto
const agoraHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const hojeStr = () => { const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`; };

/** Quadro Ponto a partir de tvRh.montar(jornada, { lojas: [loja] }) — função pura. */
/** banco = { [id]: saldo oficial acumulado em minutos } das linhas cruas de pontocerto.jornadaDia (a TV tira o banco de propósito) */
function resumoPonto(m, banco) {
  const B = banco || {};
  const r = (m && m.resumo) || {};
  const pend = ((m && m.pendencias) || []);
  const fora = r.fora || { folga: 0, ferias: 0, afastado: 0 };
  return {
    previstos: r.previstos || 0, chegaram: r.chegaram || 0, atrasos: r.atrasos || 0,
    semMarcacao: pend.filter(p => p.g === 'sem').length,
    aguardando: r.aguardando || 0, apuracao: r.apuracao || 0, emIntervalo: r.emIntervalo || 0, saidas: r.saidas || 0,
    fora: { folga: fora.folga || 0, ferias: fora.ferias || 0, afastado: fora.afastado || 0 },
    pendencias: pend.slice(0, MAX_PENDENCIAS).map(p => ({ g: p.g, nome: p.nome, setor: p.setor || '—', txt: p.txt })),
    // por pessoa (Tiago, 27/10: "clicar no funcionário abrir o horário que teria que bater na entrada, no intervalo e na saída"):
    // as 4 marcações previsto × batido e a situação de cada uma, como a TV RH/DP classifica (tv-rh.linhaTV)
    pessoas: ((m && m.entradas) || []).slice(0, MAX_PESSOAS).map(l => ({ id: l.id, nome: l.nome, setor: l.setor || '—', cargo: l.cargo || '', previsto: l.previsto || null,
      entrada: l.entrada || null, saidaInt: l.saidaInt || null, retornoInt: l.retornoInt || null, saida: l.saida || null, atrasoMin: l.atrasoMin || 0, situacao: l.situacao || null,
      sit: { entrada: l.sitEntrada || null, intervalo: l.sitIntervalo || null, saida: l.sitSaida || null, jornada: l.sitJornada || null }, pendencias: l.pendencias || [], divergencias: l.divergencias || [],
      banco_min: B[l.id] == null ? null : B[l.id] })),
    maisPendencias: Math.max(0, pend.length - MAX_PENDENCIAS)
  };
}

/** Quadro Sem Giro a partir do resumo da loja (semGiro.lojas) e dos itens mais parados (semGiro.consultar) — função pura. */
const FAIXAS = [30, 60, 90, 120];
const itemTela = i => ({ cod: i.cod, descricao: i.descricao, grupo: i.grupo || '', unid: i.unid || '', est: i.est, valor: i.valor, dias: i.dias, faixa: i.faixa, preco: i.preco, custo: i.custo, abaixoCusto: !!i.abaixoCusto });   // custo (28/10): a folha de rebaixa mostra preço atual × custo
/** porFaixa (Tiago, 27/10: "sem giro coloque de 30 dias, de 60 dias"): { 30: [...], 60: [...], 90: [...], 120: [...] } — os mais parados de cada faixa. */
function resumoSemGiro(res, itens, estado, porFaixa) {
  const r = res || {}, f = k => (r[k] || { n: 0, v: 0 }), pf = porFaixa || {};
  return {
    n: r.n || 0, valor: r.valor || 0, abaixoCusto: r.abaixoCusto || 0, decididas: r.decididas || 0,
    faixas: { f30: f('f30'), f60: f('f60'), f90: f('f90'), f120: f('f120') },
    calculadoEm: (estado && estado.calculadoEm) || null, calculando: !!(estado && estado.calculando),
    itens: (itens || []).slice(0, MAX_ITENS).map(itemTela),
    itensFaixa: Object.fromEntries(FAIXAS.map(fx => [fx, (pf[fx] || []).slice(0, MAX_ITENS).map(itemTela)]))
  };
}

/**
 * Dados dos quadros Ponto e Sem Giro da loja (ou da rede, loja = null). Cada bloco falha sozinho ({ erro }) pra tela
 * mostrar os outros. deps: { tvRh (jornadaHoje, montar), semGiro (lojas, consultar), toleranciaMin() }.
 */
async function quadros(loja, deps) {
  const ln = loja ? +loja : null;
  const out = { loja: ln, lojaTxt: ln ? (LOJA_TXT[ln] || 'Loja ' + ln) : 'Rede', hoje: hojeStr(), agora: agoraHM() };
  try {
    const j = await deps.tvRh.jornadaHoje(false);
    let tol = null; try { tol = deps.toleranciaMin ? deps.toleranciaMin() : null; } catch (e) { tol = null; }
    const banco = {}; for (const l of (j && j.linhas) || []) if (l && l.id != null && l.banco_oficial_min != null) banco[l.id] = l.banco_oficial_min;
    out.ponto = resumoPonto(deps.tvRh.montar(j, { lojas: ln ? [ln] : [], setores: [] }, out.agora, tol), banco);
  } catch (e) { out.ponto = { erro: e.message }; }
  try {
    const l = deps.semGiro.lojas({});
    const itens = deps.semGiro.consultar({ loja: ln || 0, ordem: 'valor', limite: MAX_ITENS }).rows;
    const porFaixa = {}; for (const fx of FAIXAS) porFaixa[fx] = deps.semGiro.consultar({ loja: ln || 0, faixa: fx, ordem: 'valor', limite: MAX_ITENS }).rows;
    out.semGiro = resumoSemGiro(ln ? l.lojas[ln] : l.total, itens, l.estado, porFaixa);
  } catch (e) { out.semGiro = { erro: e.message }; }
  return out;
}

// ── PDF do Sem Giro pra imprimir / mandar no WhatsApp (28/10/26, Tiago: "no app gerencial, em Sem Giro, coloca um PDF: quando
// clicar ele abre e envia via zap; o gerente abre e manda pra imprimir. Todas as opções (30+, 30 a 59…) ter um PDF pra cada um").
// Lista COMPLETA da loja na faixa (a tela mostra só os 30 de maior valor), mesma ordem da tela (valor parado), A4 retrato com
// coluna "Contagem" em branco pra anotar na mão andando a loja. Só leitura: sai do cache de lib/sem-giro.js.
const FAIXA_TXT = { 0: 'Todos · 30 dias ou mais', 30: '30 a 59 dias', 60: '60 a 89 dias', 90: '90 a 119 dias', 120: '120 dias ou mais' };
const FAIXA_ARQ = { 0: 'todos', 30: '30-a-59-dias', 60: '60-a-89-dias', 90: '90-a-119-dias', 120: '120-dias-ou-mais' };
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtd = v => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
/** Corta o texto pra caber na largura da coluna (o pdfkit quebra linha mesmo com lineBreak: false quando passa da width). */
function cabe(doc, s, w) { s = String(s || ''); if (doc.widthOfString(s) <= w) return s; while (s.length > 1 && doc.widthOfString(s + '…') > w) s = s.slice(0, -1); return s.trimEnd() + '…'; }
const dataBR = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
/** Nome do arquivo: sem-giro-E5-30-a-59-dias.pdf */
function nomePdfSemGiro(loja, faixa) { return 'sem-giro-' + (loja ? 'E' + loja : 'rede') + '-' + (FAIXA_ARQ[+faixa] || 'todos') + '.pdf'; }
/**
 * Gera o PDF (Buffer) da faixa pedida. deps: { semGiro (lojas, consultar) }; usuario = nome de quem emitiu (rodapé).
 * faixa 0 = todos (30 dias ou mais). loja null = rede inteira (admin).
 */
async function pdfSemGiro({ loja, faixa, usuario }, deps) {
  const PDFDocument = require('pdfkit'); const LOGO = require('./logo-economico');
  const ln = loja ? +loja : null, fx = [30, 60, 90, 120].includes(+faixa) ? +faixa : 0;
  const l = deps.semGiro.lojas({}); const res = (ln ? l.lojas[ln] : l.total) || {}; const estado = l.estado || {};
  const rows = deps.semGiro.consultar({ loja: ln || 0, faixa: fx, ordem: 'valor', limite: 5000 }).rows || [];
  const n = fx ? ((res['f' + fx] || {}).n || 0) : (res.n || 0), valor = fx ? ((res['f' + fx] || {}).v || 0) : (res.valor || 0);
  const lojaTxt = ln ? (LOJA_TXT[ln] || 'Loja ' + ln) : 'Rede';
  const NAVY = '#14213D';
  const doc = new PDFDocument({ size: 'A4', margin: 28, bufferPages: true, info: { Title: 'Sem giro · ' + lojaTxt + ' · ' + FAIXA_TXT[fx], Author: 'Econômico Supermercados' } });
  const chunks = []; doc.on('data', c => chunks.push(c)); const fim = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  const X = 28, W = doc.page.width - 56;
  const cols = [['Código', 66], ['Produto', 0], ['Grupo', 86], ['Dias', 30], ['Estoque', 58], ['Valor parado', 64], ['Contagem', 56]];
  cols[1][1] = W - cols.reduce((s, c) => s + c[1], 0); const sx = []; let acc = X; for (const c of cols) { sx.push(acc); acc += c[1]; }
  const cab = () => {
    LOGO.desenhar(doc, X, 18, 60);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('SEM GIRO · ' + lojaTxt.toUpperCase(), X + 74, 22, { width: W - 74 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111').text(FAIXA_TXT[fx] + ' sem venda · ' + n.toLocaleString('pt-BR') + ' itens · ' + brl(valor) + ' parado (custo × estoque)', X + 74, 40, { width: W - 74 });
    doc.font('Helvetica').fontSize(7.5).fillColor('#555').text('Calculado em ' + dataBR(estado.calculadoEm) + ' · emitido ' + new Date().toLocaleString('pt-BR') + (usuario ? ' por ' + usuario : '') + ' · ordem: maior valor parado primeiro · "Contagem": anote a quantidade achada na loja', X + 74, 54, { width: W - 74 });
    doc.y = 74;
    doc.rect(X, doc.y, W, 14).fill('#E6ECF4'); doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY); const y = doc.y + 4;
    cols.forEach(([t, w], k) => doc.text(t, sx[k] + 2, y, { width: w - 4, lineBreak: false, align: k >= 3 && k <= 5 ? 'right' : 'left' })); doc.y = y + 12;
  };
  cab(); let i = 0;
  for (const r of rows) {
    if (doc.y > doc.page.height - 44) { doc.addPage(); cab(); }
    const y = doc.y; if (i++ % 2) doc.rect(X, y - 2, W, 14).fill('#F6F7FA');
    doc.font('Helvetica').fontSize(7.5).fillColor('#111');
    doc.text(String(r.cod || ''), sx[0] + 2, y, { width: cols[0][1] - 4, lineBreak: false });
    doc.text(cabe(doc, r.descricao, cols[1][1] - 4), sx[1] + 2, y, { width: cols[1][1], lineBreak: false });
    doc.fillColor('#444').text(cabe(doc, r.grupo, cols[2][1] - 4), sx[2] + 2, y, { width: cols[2][1], lineBreak: false });
    doc.fillColor('#111').text(r.dias == null ? '—' : String(r.dias), sx[3] + 2, y, { width: cols[3][1] - 4, lineBreak: false, align: 'right' });
    doc.text(qtd(r.est) + ' ' + String(r.unid || ''), sx[4] + 2, y, { width: cols[4][1] - 4, lineBreak: false, align: 'right' });
    doc.font('Helvetica-Bold').text(brl(r.valor), sx[5] + 2, y, { width: cols[5][1] - 4, lineBreak: false, align: 'right' });
    doc.lineWidth(0.5).rect(sx[6] + 6, y - 1.5, cols[6][1] - 12, 11).stroke('#B8C0D0');
    doc.y = y + 14;
  }
  if (!rows.length) { doc.font('Helvetica').fontSize(10).fillColor('#666').text('Nenhum item ' + (fx ? 'nesta faixa' : 'sem giro') + ' nesta loja.', X, doc.y + 12, { width: W, align: 'center' }); }
  const total = doc.bufferedPageRange().count;
  for (let p = 0; p < total; p++) {
    doc.switchToPage(p); doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('Econômico Supermercados · Gestão Gerencial · Sem giro · ' + lojaTxt + ' · ' + FAIXA_TXT[fx] + '   —   página ' + (p + 1) + ' de ' + total, X, doc.page.height - 22, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return fim;
}

module.exports = { quadros, resumoPonto, resumoSemGiro, pdfSemGiro, nomePdfSemGiro, LOJA_TXT, FAIXA_TXT };
