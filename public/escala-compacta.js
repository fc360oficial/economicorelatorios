// public/escala-compacta.js — visualização COMPACTA da escala, no modelo da planilha "ESCALA LOJA 5" (Tiago, 19/11/2026:
// "Padronização do gerador de escalas da Rede"). Não gera nem calcula nada: só muda a APRESENTAÇÃO das grades que já existem
// (Escala coletiva e proposta do Gerador 5×2). Cada jornada vira o código do turno (T.1, T.2…) na cor da planilha, a folga
// fixa vira "Folga" verde, o descanso do domingo e a folga rotativa ficam em branco, e a legenda traz o horário de cada código.
// A visão detalhada (horário dentro da célula) continua a um clique. Os códigos vêm do servidor (lib/escalas-periodo.js › codificar).
window.EscalaCompacta = (function () {
  var CHAVE = 'escala-visao';
  var DS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'], MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  var CSS = 'table.cal.pl{border-collapse:collapse;border-spacing:0;background:#fff;color:#14213D}' +
    'table.cal.pl th{background:#fff;color:#14213D;border:1px solid #9AA0A6;border-radius:0;padding:2px 3px;font-size:10px;font-weight:700;line-height:1.25}table.cal.pl th small{color:#14213D;font-weight:600;font-size:9.5px}' +
    'table.cal.pl th.fds{background:#fff;color:#14213D}table.cal.pl th.dom{background:#E8412C;color:#fff}table.cal.pl th.dom small{color:#fff}table.cal.pl th.fer{background:#fff;color:#C22F49;box-shadow:inset 0 -3px 0 #C22F49}table.cal.pl th.fer small{color:#C22F49}table.cal.pl th.dom.fer{background:#E8412C;color:#fff}table.cal.pl th.dom.fer small{color:#fff}' +
    'table.cal.pl th.n{background:#fff;color:#14213D;font-size:10.5px;padding:2px 6px}' +
    'table.cal.pl td{border:1px solid #9AA0A6;border-radius:0;height:21px;padding:1px 2px;min-width:30px;font-size:10.5px;line-height:1.1;background:#fff}' +
    'table.cal.pl td.n{padding:1px 6px;min-width:255px;background:#fff}table.cal.pl td.n b{display:inline-block;max-width:60%;vertical-align:middle;font-size:10.5px}table.cal.pl td.n span{display:inline-block;float:right;max-width:38%;font-size:10px;color:#14213D;line-height:19px}' +
    'table.cal.pl td.d{font-weight:700}table.cal.pl td.d .a{display:block;font-size:8px;font-weight:500}table.cal.pl td.ecau{font-size:9px;font-weight:600;color:#14213D}table.cal.pl td.vz{background:#F7F7F5;color:#9AA0A6}' +
    'table.cal.pl td.tot{background:#F4F4F1;color:#14213D;font-size:10.5px;padding:0 6px}' +
    '@media (max-width:1499px){table.cal.pl td{min-width:26px;font-size:10px}table.cal.pl th{font-size:9.5px;padding:2px 1px}table.cal.pl th small{font-size:9px}table.cal.pl td.n{min-width:215px}table.cal.pl td.n b{font-size:10px}table.cal.pl td.n span{font-size:9.5px}}' +
    '@media (max-width:1299px){table.cal.pl td.n{min-width:190px}table.cal.pl td.n b{max-width:64%}table.cal.pl td.n span{max-width:34%}}';
  function css() { if (document.getElementById('ec-css')) return; var s = document.createElement('style'); s.id = 'ec-css'; s.textContent = CSS; document.head.appendChild(s); }
  function ativo() { try { return localStorage.getItem(CHAVE) !== 'detalhada'; } catch (e) { return true; } }
  function alternar() { try { localStorage.setItem(CHAVE, ativo() ? 'detalhada' : 'compacta'); } catch (e) {} if (typeof api.aoMudar === 'function') api.aoMudar(); }
  function mapa(P) { return P._m || (P._m = Object.fromEntries((P.turnos || []).map(function (t) { return [t.codigo, t]; }))); }
  function hTxt(hm) { var p = String(hm).split(':'); return +p[0] + 'h' + (+p[1] ? p[1] + 'min' : ''); }
  function horario(t) { return hTxt(t.entrada) + (t.almoco_ini ? ' às ' + hTxt(t.almoco_ini) + ' - ' + hTxt(t.almoco_fim) + ' às ' : ' às ') + hTxt(t.saida); }
  /** Cabeçalho do dia como na planilha: dia da semana em cima, data embaixo. */
  function th(d, w) { return DS[w] + '<small>' + d.slice(8) + '/' + MES[+d.slice(5, 7) - 1] + '</small>'; }
  /** Conteúdo compacto de um dia: { bg, fg, txt, tt, cls } ou null (jornada sem código → a célula fica no formato detalhado). */
  function cel(c, f, d, P) {
    if (!c) return null; var w = new Date(d + 'T12:00:00').getDay();
    if (c.tipo === 'trabalho') { var t = c.cod && mapa(P)[c.cod]; return t ? { bg: t.cor, fg: t.texto, txt: c.cod, tt: c.cod } : null; }
    if (c.tipo === 'folga') { var fixa = c.folga ? c.folga === 'fixa' : w !== 0 && ((f && f.folga_fixa) || []).indexOf(w) >= 0; return fixa ? { bg: P.corFolga, fg: '#FFFFFF', txt: 'Folga', tt: '' } : { bg: '#FFFFFF', fg: '#14213D', txt: '', tt: '' }; }
    if (c.tipo === 'ferias') return { bg: '#FFFFFF', fg: '#14213D', txt: 'Férias', tt: '', cls: 'ecau' };
    if (c.tipo === 'afastado') return { bg: '#FFFFFF', fg: '#14213D', txt: 'Licença', tt: '', cls: 'ecau' };
    if (c.tipo === 'feriado') return { bg: '#FFFFFF', fg: '#C22F49', txt: 'Feriado', tt: '', cls: 'ecau' };
    return null;
  }
  /** Legenda (LEGENDA × HORÁRIO da planilha) no formato de fichas da .cal-leg: só os turnos usados na grade. */
  function chips(P) {
    var us = (P.turnos || []).filter(function (t) { return t.n > 0; }); if (!us.length) us = P.turnos || [];
    return us.map(function (t) { return '<span title="' + t.codigo + ': ' + horario(t) + (t.n ? ' · ' + t.n + ' dia(s) nesta grade' : '') + '"><i style="background:' + t.cor + '"></i><div><b>' + t.codigo + '</b><small>' + horario(t) + '</small></div></span>'; }).join('') +
      '<span><i style="background:' + P.corFolga + '"></i><div><b>Folga</b><small>Folga fixa</small></div></span><span><i style="background:#fff;box-shadow:inset 0 0 0 1px #9AA0A6"></i><div><b>Em branco</b><small>Descanso do domingo · folga rotativa</small></div></span>';
  }
  function botao() { return '<a class="ds-btn ds-btn-secondary" onclick="EscalaCompacta.alternar()" title="' + (ativo() ? 'Mostrar o horário de entrada, saída e intervalo dentro de cada dia' : 'Mostrar a escala no modelo da planilha: código e cor do turno') + '">' + (ativo() ? 'Ver horários' : 'Visão compacta') + '</a>'; }
  var api = { css: css, ativo: ativo, alternar: alternar, th: th, cel: cel, chips: chips, botao: botao, horario: horario, aoMudar: null };
  return api;
})();
