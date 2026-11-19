'use strict';
// "Feito hoje" do Painel Robô (19/11/26, Tiago: "o que você acha que precisa ter? só isso mesmo"). O painel só mostrava o que o robô
// FARIA (sombra); aqui sai o que a precificação FEZ de verdade no dia, tirado do Log Precificação (data/log-precificacao/AAAA-MM.jsonl):
// as cargas de preço de 09:00, 12:00 e 15:00 (quantas listas e quantos preços foram), os envios pelo botão, os erros e as conferências
// contra o ERP. Só leitura de arquivo; nada no ERP.
//
// O arquivo do mês passa de 10 MB e o painel pergunta a cada 15 s: lê só o FIM do arquivo (o dia de hoje), guarda o resultado por 2 minutos
// e procura a última carga de antes de hoje uma vez por dia (não muda durante o dia). Ver a memória "servidor travado = thread ocupada".
const fs = require('fs');
const path = require('path');

const HORAS = ['09:00', '12:00', '15:00'];
const MB = 1024 * 1024;
const VALE_MS = 2 * 60 * 1000;
let cache = null, anterior = null;

const p2 = n => String(n).padStart(2, '0');
const diaLocal = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const RE_DIA = /"em":"(\d{4}-\d{2}-\d{2})/;

/** Linhas do fim do arquivo, crescendo a leitura até cobrir tudo desde `desdeDia` (ou bater no `limite` de bytes / começo do arquivo). */
function cauda(arquivo, desdeDia, limite) {
  let tam; try { tam = fs.statSync(arquivo).size; } catch (e) { return []; }
  if (!tam) return [];
  let n = Math.min(tam, 2 * MB);
  for (;;) {
    const buf = Buffer.alloc(n), fd = fs.openSync(arquivo, 'r');
    try { fs.readSync(fd, buf, 0, n, tam - n); } finally { fs.closeSync(fd); }
    let txt = buf.toString('utf8'); if (n < tam) txt = txt.slice(txt.indexOf('\n') + 1);   // a primeira linha vem cortada
    const linhas = txt.split('\n'), m = RE_DIA.exec(linhas[0] || '');
    if (n >= tam || n >= limite || (m && m[1] < desdeDia)) return linhas;
    n = Math.min(tam, n * 2, limite);
  }
}
function eventos(linhas, filtro) {
  const out = [];
  for (const ln of linhas) { if (!ln || !filtro(ln)) continue; try { out.push(JSON.parse(ln)); } catch (e) { /* linha quebrada: pula */ } }
  return out;
}
const horaCarga = e => { const m = /^CARGA (\d{2}:\d{2})/.exec(e.usuario || ''); return m ? m[1] : null; };
function somar(evs) { return { listas: new Set(evs.map(e => e.registroId)).size, precos: evs.reduce((s, e) => s + (+e.itens || 0), 0) }; }

/** Última carga de preço de ANTES de hoje (dia, horário, listas, preços): procura no mês e, se não achar, no mês anterior. */
function ultimaAntes(dir, hoje) {
  const d = new Date(hoje + 'T12:00:00'); d.setDate(0);
  const d4 = new Date(hoje + 'T12:00:00'); d4.setDate(d4.getDate() - 4);   // basta voltar uns dias (fim de semana, feriado); sem carga nesse intervalo, lê até o limite
  for (const mes of [hoje.slice(0, 7), diaLocal(d).slice(0, 7)]) {
    const evs = eventos(cauda(path.join(dir, mes + '.jsonl'), diaLocal(d4), 12 * MB), ln => ln.includes('"tipo":"enviar_carga"')).filter(e => String(e.em).slice(0, 10) < hoje);
    if (!evs.length) continue;
    const ult = evs[evs.length - 1], dia = String(ult.em).slice(0, 10), hora = horaCarga(ult);
    const doDia = evs.filter(e => String(e.em).slice(0, 10) === dia);
    return { dia, hora: hora || String(ult.em).slice(11, 16), ...somar(hora ? doDia.filter(e => horaCarga(e) === hora) : [ult]), noDia: somar(doDia) };
  }
  return null;
}

/** Resumo do dia. `agora` só pra teste. */
function resumo(dir, agora = new Date()) {
  const hoje = diaLocal(agora);
  if (cache && cache.dia === hoje && agora.getTime() - cache.t < VALE_MS && cache.dir === dir) return cache.r;
  const evs = eventos(cauda(path.join(dir, hoje.slice(0, 7) + '.jsonl'), hoje, 8 * MB), ln => ln.includes('"em":"' + hoje));
  const env = evs.filter(e => e.tipo === 'enviar_carga'), err = evs.filter(e => e.tipo === 'erro'), ver = evs.filter(e => e.tipo === 'verificar');
  const hm = p2(agora.getHours()) + ':' + p2(agora.getMinutes());
  const cargas = HORAS.map(hora => {
    const doH = env.filter(e => horaCarga(e) === hora), erros = err.filter(e => horaCarga(e) === hora).length;
    return { hora, passou: hm >= hora, ...somar(doH), erros };
  });
  const manuais = env.filter(e => !horaCarga(e));
  if (!anterior || anterior.dia !== hoje || anterior.dir !== dir) { let u = null; try { u = ultimaAntes(dir, hoje); } catch (e) { u = null; } anterior = { dia: hoje, dir, u }; }
  const r = {
    dia: hoje, horas: HORAS, cargas,
    total: somar(env), manual: somar(manuais),
    erros: err.length,
    conferidas: new Set(ver.map(e => e.registroId)).size,   // listas conferidas contra o ERP no dia (a conferência roda de hora em hora)
    ultima: anterior.u,
  };
  cache = { dia: hoje, dir, t: agora.getTime(), r };
  return r;
}

module.exports = { resumo, HORAS };
