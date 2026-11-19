// public/escala-compacta.js — visualização COMPACTA da escala, no modelo da planilha "ESCALA LOJA 5" (Tiago, 19/11/2026:
// "Padronização do gerador de escalas da Rede"). Não gera nem calcula nada: só muda a APRESENTAÇÃO das grades que já existem
// (Escala coletiva e proposta do Gerador 5×2). Cada jornada vira o código do turno (T.1, T.2…) na cor da planilha, a folga
// fixa vira "Folga" verde, a folga rotativa vira "F.Rot" em verde-claro, o descanso do domingo fica em branco e a legenda traz
// o horário de cada código. A visão detalhada (horário dentro da célula) continua a um clique. Também ficam aqui o filtro por
// setor/função e o diálogo de incluir funcionário ou vaga. Os códigos vêm do servidor (lib/escalas-periodo.js › codificar).
window.EscalaCompacta = (function () {
  var CHAVE = 'escala-visao';
  var DS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'], MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  var COR_ROT = '#C9EBCF', TXT_ROT = '#0B5A2A';   // folga rotativa: mesma família do verde da folga fixa, mais clara
  var CSS = 'table.cal.pl{border-collapse:collapse;border-spacing:0;background:#fff;color:#14213D}' +
    'table.cal.pl th{background:#fff;color:#14213D;border:1px solid #9AA0A6;border-radius:0;padding:2px 3px;font-size:10px;font-weight:700;line-height:1.25}table.cal.pl th small{color:#14213D;font-weight:600;font-size:9.5px}' +
    'table.cal.pl th.fds{background:#fff;color:#14213D}table.cal.pl th.dom{background:#E8412C;color:#fff}table.cal.pl th.dom small{color:#fff}table.cal.pl th.fer{background:#fff;color:#C22F49;box-shadow:inset 0 -3px 0 #C22F49}table.cal.pl th.fer small{color:#C22F49}table.cal.pl th.dom.fer{background:#E8412C;color:#fff}table.cal.pl th.dom.fer small{color:#fff}' +
    'table.cal.pl th.n{background:#fff;color:#14213D;font-size:10.5px;padding:2px 6px}' +
    'table.cal.pl td{border:1px solid #9AA0A6;border-radius:0;height:21px;padding:1px 2px;min-width:30px;font-size:10.5px;line-height:1.1;background:#fff}' +
    'table.cal.pl td.n{padding:1px 6px;min-width:255px;background:#fff}table.cal.pl td.n b{display:inline-block;max-width:60%;vertical-align:middle;font-size:10.5px}table.cal.pl td.n span{display:inline-block;float:right;max-width:38%;font-size:10px;color:#14213D;line-height:19px}' +
    'table.cal.pl td.d{font-weight:700}table.cal td[data-ef]{cursor:pointer}table.cal td[data-ef]:hover{filter:brightness(.92)}table.cal.pl td.d .a{display:block;font-size:8px;font-weight:500}table.cal.pl td.ecau{font-size:9px;font-weight:600;color:#14213D}table.cal.pl td.ecrot{font-size:9.5px;font-weight:700}table.cal.pl td.vz{background:#F7F7F5;color:#9AA0A6}' +
    'table.cal.pl td.tot{background:#F4F4F1;color:#14213D;font-size:10.5px;padding:0 6px}table.cal.pl tr.g0>td{border-top:2px solid #14213D}' +
    'a.ecoc{color:#D0021B;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}a.ecoc::after{content:" ▾";font-size:9px}a.ecoc:hover{text-decoration:underline}' +
    'table.cal td.n.ecvaga b{color:#D0021B}table.cal td.n a.ecx{float:right;margin-left:6px;color:#C22F49;font-weight:800;cursor:pointer;text-decoration:none;line-height:19px}' +
    '.ec-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 8px}.ec-bar .ec-end{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}' +
    '.ec-f{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.ec-f>small{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink3);margin-right:2px}' +
    '.ec-f a{border:1px solid var(--ln2,#C9CED6);background:var(--crd,#fff);border-radius:999px;padding:4px 10px;font-size:11.5px;font-weight:700;color:var(--ink2,#3A4660);cursor:pointer;user-select:none;white-space:nowrap}.ec-f a small{font-weight:600;opacity:.7;margin-left:3px}.ec-f a.on{background:#101B33;color:#FFC933;border-color:#101B33}' +
    '@media (max-width:1499px){table.cal.pl td{min-width:26px;font-size:10px}table.cal.pl th{font-size:9.5px;padding:2px 1px}table.cal.pl th small{font-size:9px}table.cal.pl td.n{min-width:215px}table.cal.pl td.n b{font-size:10px}table.cal.pl td.n span{font-size:9.5px}table.cal.pl td.ecrot{font-size:9px}}' +
    '@media (max-width:1299px){table.cal.pl td.n{min-width:190px}table.cal.pl td.n b{max-width:64%}table.cal.pl td.n span{max-width:34%}}';
  var e = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function css() { if (document.getElementById('ec-css')) return; var s = document.createElement('style'); s.id = 'ec-css'; s.textContent = CSS; document.head.appendChild(s); }
  function ativo() { try { return localStorage.getItem(CHAVE) !== 'detalhada'; } catch (x) { return true; } }
  function alternar() { try { localStorage.setItem(CHAVE, ativo() ? 'detalhada' : 'compacta'); } catch (x) {} if (typeof api.aoMudar === 'function') api.aoMudar(); }
  function mapa(P) { return P._m || (P._m = Object.fromEntries((P.turnos || []).map(function (t) { return [t.codigo, t]; }))); }
  function hTxt(hm) { var p = String(hm).split(':'); return +p[0] + 'h' + (+p[1] ? p[1] + 'min' : ''); }
  function horario(t) { return hTxt(t.entrada) + (t.almoco_ini ? ' às ' + hTxt(t.almoco_ini) + ' - ' + hTxt(t.almoco_fim) + ' às ' : ' às ') + hTxt(t.saida); }
  /** Cabeçalho do dia como na planilha: dia da semana em cima, data embaixo. */
  function th(d, w) { return DS[w] + '<small>' + d.slice(8) + '/' + MES[+d.slice(5, 7) - 1] + '</small>'; }
  /** Conteúdo compacto de um dia: { bg, fg, txt, tt, cls } ou null (jornada sem código → a célula fica no formato detalhado). */
  function cel(c, f, d, P) {
    if (!c) return null; var w = new Date(d + 'T12:00:00').getDay();
    if (c.tipo === 'trabalho') { var t = c.cod && mapa(P)[c.cod]; return t ? { bg: t.cor, fg: t.texto, txt: c.cod, tt: c.cod } : null; }
    if (c.tipo === 'folga') {
      var fixa = c.folga ? c.folga === 'fixa' : w !== 0 && ((f && f.folga_fixa) || []).indexOf(w) >= 0;
      if (fixa) return { bg: P.corFolga, fg: '#FFFFFF', txt: 'Folga', tt: '' };
      if (c.folga === 'rotativa') return { bg: COR_ROT, fg: TXT_ROT, txt: 'F.Rot', tt: 'Folga rotativa', cls: 'ecrot' };
      return { bg: '#FFFFFF', fg: '#14213D', txt: '', tt: '' };
    }
    if (c.tipo === 'ferias') return { bg: '#FFFFFF', fg: '#14213D', txt: 'Férias', tt: '', cls: 'ecau' };
    if (c.tipo === 'afastado') return { bg: '#FFFFFF', fg: '#14213D', txt: 'Licença', tt: '', cls: 'ecau' };
    if (c.tipo === 'feriado') return { bg: '#FFFFFF', fg: '#C22F49', txt: 'Feriado', tt: '', cls: 'ecau' };
    return null;
  }
  /** Legenda (LEGENDA × HORÁRIO da planilha) no formato de fichas da .cal-leg: só os turnos usados na grade. */
  function chips(P) {
    var us = (P.turnos || []).filter(function (t) { return t.n > 0; }); if (!us.length) us = P.turnos || [];
    return us.map(function (t) { return '<span title="' + t.codigo + ': ' + horario(t) + (t.n ? ' · ' + t.n + ' dia(s) nesta grade' : '') + '"><i style="background:' + t.cor + '"></i><div><b>' + t.codigo + '</b><small>' + horario(t) + '</small></div></span>'; }).join('') +
      '<span><i style="background:' + P.corFolga + '"></i><div><b>Folga</b><small>Folga fixa</small></div></span><span><i style="background:' + COR_ROT + '"></i><div><b>F.Rot</b><small>Folga rotativa</small></div></span><span><i style="background:#fff;box-shadow:inset 0 0 0 1px #9AA0A6"></i><div><b>Em branco</b><small>Descanso do domingo</small></div></span>';
  }
  function botao() { return '<a class="ds-btn ds-btn-secondary" onclick="EscalaCompacta.alternar()" title="' + (ativo() ? 'Mostrar o horário de entrada, saída e intervalo dentro de cada dia' : 'Mostrar a escala no modelo da planilha: código e cor do turno') + '">' + (ativo() ? 'Ver horários' : 'Visão compacta') + '</a>'; }

  // ── Filtro por setor / função (um ou vários) ──
  /** lista = linhas da grade (com `grupo`); sel = array dos grupos escolhidos (vazio = todos). */
  function filtro(lista, sel) {
    var cont = {}, ordem = []; (lista || []).forEach(function (x) { var g = x.grupo || '—'; if (cont[g] == null) { cont[g] = 0; ordem.push(g); } cont[g]++; });
    if (ordem.length < 2) return '';
    return '<div class="ec-f"><small>Setor</small><a data-ecg=""' + (!sel.length ? ' class="on"' : '') + '>todos<small>' + (lista || []).length + '</small></a>' + ordem.map(function (g) { return '<a data-ecg="' + e(g) + '"' + (sel.indexOf(g) >= 0 ? ' class="on"' : '') + '>' + e(g) + '<small>' + cont[g] + '</small></a>'; }).join('') + '</div>';
  }
  var passa = function (x, sel) { return !sel || !sel.length || sel.indexOf(x.grupo || '—') >= 0; };
  /** Liga os cliques do filtro dentro de `raiz`: alterna o grupo em `sel` (o próprio array) e chama `redesenhar`. */
  function ligarFiltro(raiz, sel, redesenhar) {
    var r = typeof raiz === 'string' ? document.querySelector(raiz) : raiz; if (!r) return;
    r.querySelectorAll('.ec-f a[data-ecg]').forEach(function (a) { a.onclick = function () { var g = a.getAttribute('data-ecg'); if (!g) sel.length = 0; else { var i = sel.indexOf(g); if (i >= 0) sel.splice(i, 1); else sel.push(g); } redesenhar(); }; });
  }

  // ── Incluir funcionário ou vaga (sem passar pelo ponto) ──
  function botaoIncluir() { return '<a class="ds-btn ds-btn-secondary" data-ecinc="1" title="Pôr na escala uma pessoa que ainda não está no ponto da loja ou uma vaga a contratar, com turno e folga fixa">+ Incluir funcionário ou vaga</a>'; }
  /** Abre o diálogo de inclusão; `depois` roda quando a linha foi gravada (a tela simula de novo). */
  async function incluir(loja, depois) {
    var G = window.G, C; try { C = await G.api('/api/escalas-periodo/' + loja + '/cadastro'); } catch (x) { G.toast(x.message, 'neg'); return; }
    if (!C.podeCadastrar) { G.toast('Só o gerente da unidade, o RH Ponto ou a Coordenação incluem pessoas ou vagas na escala', 'neg'); return; }
    var ov = document.createElement('div'); ov.className = 'f-ov'; var est = 'padding:7px 9px;border:1px solid #C9CED6;border-radius:8px;font:inherit;font-size:12.5px;width:100%;box-sizing:border-box;background:var(--crd,#fff);color:var(--ink,#14213D)';
    var lab = function (t, campo) { return '<label style="font-size:11px;font-weight:700;color:var(--ink2,#3A4660);display:grid;gap:4px;align-content:start">' + t + campo + '</label>'; };
    ov.innerHTML = '<div class="f-md" style="max-width:600px"><div class="hd"><div><b>Incluir na escala</b><small>Pessoa que ainda não está no ponto da loja ou vaga a contratar · entra com o turno e a folga fixa escolhidos</small></div><button class="x" type="button">×</button></div><div class="bd" style="padding:14px 16px;display:grid;gap:10px">' +
      '<div style="display:grid;grid-template-columns:1fr 2fr;gap:8px">' + lab('Tipo', '<select id="ei-tipo" style="' + est + '"><option value="p">Funcionário</option><option value="v">Vaga a contratar</option></select>') + lab('Nome <small id="ei-nt" style="font-weight:500"></small>', '<input id="ei-nome" maxlength="80" style="' + est + '">') + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' + lab('Função na escala', '<input id="ei-grupo" list="ei-grupos" maxlength="40" placeholder="Caixa, Seção, Balconista…" style="' + est + '"><datalist id="ei-grupos">' + C.grupos.map(function (g) { return '<option value="' + e(g.grupo) + '">'; }).join('') + '</datalist>') +
      lab('Setor (cobertura)', '<select id="ei-setor" style="' + est + '">' + C.setores.map(function (s) { return '<option value="' + e(s.id) + '">' + e(s.txt) + '</option>'; }).join('') + '</select>') + '</div>' +
      '<div style="display:grid;grid-template-columns:2fr 1fr;gap:8px">' + lab('Turno', '<select id="ei-turno" style="' + est + '">' + C.turnos.map(function (t) { return '<option value="' + e(t.codigo) + '">' + e(t.codigo + ' · ' + horario(t)) + '</option>'; }).join('') + '</select>') +
      lab('Folga fixa', '<select id="ei-fixa" style="' + est + '"><option value="">escolha…</option>' + [1, 2, 3, 4, 5, 6].map(function (d) { return '<option value="' + d + '">' + DS[d] + '</option>'; }).join('') + '</select>') + '</div>' +
      '<div id="ei-msg"></div><div class="acoes" style="display:flex;gap:8px;justify-content:flex-end"><button class="ds-btn ds-btn-ghost" id="ei-c" type="button">Cancelar</button><button class="ds-btn ds-btn-primary" id="ei-ok" type="button">Incluir na escala</button></div></div></div>';
    document.body.appendChild(ov); var q = function (s) { return ov.querySelector(s); }; var fechar = function () { ov.remove(); }; q('.x').onclick = fechar; q('#ei-c').onclick = fechar;
    var tipo = function () { var v = q('#ei-tipo').value === 'v'; q('#ei-nt').textContent = v ? '(opcional: sem nome, a linha sai como CONTRATAR · função)' : ''; }; q('#ei-tipo').onchange = tipo; tipo(); q('#ei-nome').focus();
    q('#ei-ok').onclick = async function () {
      var b = { vaga: q('#ei-tipo').value === 'v', nome: q('#ei-nome').value, grupo: q('#ei-grupo').value, setor: q('#ei-setor').value, turno: q('#ei-turno').value, folgaFixa: +q('#ei-fixa').value || null };
      q('#ei-ok').disabled = true;
      try { var r = await G.api('/api/escalas-periodo/' + loja + '/previsto', { body: b }); G.toast((b.vaga ? 'Vaga incluída' : r.nome + ' incluído(a)') + ' na escala'); fechar(); if (depois) depois((b.vaga ? 'vaga de ' + b.grupo : r.nome) + ' incluída na escala'); }
      catch (x) { q('#ei-msg').innerHTML = '<div class="aviso neg" style="margin:0">' + e(x.message) + '</div>'; q('#ei-ok').disabled = false; }
    };
  }
  /** Liga, dentro de `raiz`, o botão de incluir e o × das linhas incluídas à mão. `depois` = o que a tela faz em seguida (simular de novo). */
  function ligarIncluir(raiz, loja, depois) {
    var r = typeof raiz === 'string' ? document.querySelector(raiz) : raiz; if (!r) return; var G = window.G;
    r.querySelectorAll('[data-ecinc]').forEach(function (b) { b.onclick = function () { incluir(loja, depois); }; });
    r.querySelectorAll('a.ecx[data-ecrm]').forEach(function (a) { a.onclick = async function (ev) { ev.stopPropagation(); if (!confirm('Tirar "' + a.getAttribute('data-ecnome') + '" da escala desta loja?\nA linha deixa de entrar nas próximas gerações; o que já foi aplicado na grade não é apagado.')) return;
      try { await G.api('/api/escalas-periodo/' + loja + '/previsto/remover', { body: { id: +a.getAttribute('data-ecrm') } }); G.toast('Linha tirada da escala'); if (depois) depois(a.getAttribute('data-ecnome') + ' tirada da escala'); } catch (x) { G.toast(x.message, 'neg'); } }; });
  }
  // ── Trocar o horário clicando no dia (proposta do Gerador 5×2) ──
  /** o = { loja, id, nome, data, dia, turnos, folgaFixa, verSemana }. "Só neste dia" grava um ajuste à mão na grade (com
   *  justificativa; o gerador não mexe mais nele); "em todos os dias" muda o turno do funcionário no cadastro. */
  function editar(o, depois) {
    var G = window.G, c = o.dia || {}, previsto = +o.id < 0; var ov = document.createElement('div'); ov.className = 'f-ov';
    var est = 'padding:7px 9px;border:1px solid #C9CED6;border-radius:8px;font:inherit;font-size:12.5px;width:100%;box-sizing:border-box;background:var(--crd,#fff);color:var(--ink,#14213D)';
    var lab = function (t, campo, id) { return '<label' + (id ? ' id="' + id + '"' : '') + ' style="font-size:11px;font-weight:700;color:var(--ink2,#3A4660);display:grid;gap:4px;align-content:start">' + t + campo + '</label>'; };
    var atual = c.tipo === 'trabalho' ? (c.cod ? c.cod + ' · ' : '') + c.entrada + '–' + c.saida + (c.almoco_ini ? ' (intervalo ' + c.almoco_ini + '–' + c.almoco_fim + ')' : '') : c.tipo === 'folga' ? 'Folga' + (c.folga ? ' ' + c.folga : '') : (c.tipo || '—');
    var dBR = o.data.slice(8) + '/' + o.data.slice(5, 7) + ' (' + DS[new Date(o.data + 'T12:00:00').getDay()].toLowerCase() + ')';
    ov.innerHTML = '<div class="f-md" style="max-width:560px"><div class="hd"><div><b>' + e(o.nome) + '</b><small>' + dBR + ' · hoje na proposta: ' + e(atual) + '</small></div><button class="x" type="button">×</button></div><div class="bd" style="padding:14px 16px;display:grid;gap:10px">' +
      lab('Novo horário', '<select id="ed-turno" style="' + est + '">' + (o.turnos || []).map(function (t) { return '<option value="' + e(t.codigo) + '"' + (c.cod === t.codigo ? ' selected' : '') + '>' + e(t.codigo + ' · ' + horario(t)) + '</option>'; }).join('') + (previsto ? '' : '<option value="FOLGA">Folga neste dia</option>') + '</select>') +
      '<div style="display:grid;gap:6px;font-size:12.5px;color:var(--ink,#14213D)">' + (previsto ? '' : '<label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="radio" name="ed-esc" value="dia" checked style="width:auto"> Só neste dia</label>') +
      '<label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="radio" name="ed-esc" value="todos"' + (previsto ? ' checked' : '') + ' style="width:auto"> Em todos os dias — passa a ser o turno do funcionário</label></div>' +
      lab('Justificativa <small style="font-weight:500">(obrigatória: fica na auditoria com seu nome)</small>', '<textarea id="ed-just" rows="2" style="' + est + '"></textarea>', 'ed-l-just') +
      lab('Folga fixa do funcionário', '<select id="ed-fixa" style="' + est + '">' + [1, 2, 3, 4, 5, 6].map(function (d) { return '<option value="' + d + '"' + (+o.folgaFixa === d ? ' selected' : '') + '>' + DS[d] + '</option>'; }).join('') + '</select>', 'ed-l-fixa') +
      '<div id="ed-msg"></div><div class="acoes" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">' + (o.verSemana ? '<button class="ds-btn ds-btn-ghost" id="ed-sem" type="button" style="margin-right:auto">Ver a validação da semana</button>' : '') + '<button class="ds-btn ds-btn-ghost" id="ed-c" type="button">Cancelar</button><button class="ds-btn ds-btn-primary" id="ed-ok" type="button">Salvar e simular de novo</button></div></div></div>';
    document.body.appendChild(ov); var q = function (s) { return ov.querySelector(s); }; var fechar = function () { ov.remove(); }; q('.x').onclick = fechar; q('#ed-c').onclick = fechar;
    if (o.verSemana) q('#ed-sem').onclick = function () { fechar(); o.verSemana(); };
    var escopo = function () { var r = ov.querySelector('input[name="ed-esc"]:checked'); return r ? r.value : 'todos'; };
    var alterna = function () { var todos = escopo() === 'todos'; q('#ed-l-just').style.display = todos ? 'none' : ''; q('#ed-l-fixa').style.display = todos ? '' : 'none'; var fo = q('#ed-turno option[value="FOLGA"]'); if (fo) { fo.disabled = todos; if (todos && q('#ed-turno').value === 'FOLGA') q('#ed-turno').selectedIndex = 0; } };
    ov.querySelectorAll('input[name="ed-esc"]').forEach(function (r) { r.onchange = alterna; }); alterna();
    q('#ed-ok').onclick = async function () {
      var b = q('#ed-ok'); b.disabled = true;
      try {
        if (escopo() === 'todos') await G.api('/api/escalas-periodo/' + o.loja + '/pessoa', { body: { id: o.id, nome: o.nome, turno: q('#ed-turno').value, folgaFixa: +q('#ed-fixa').value } });
        else await G.api('/api/escalas-periodo/' + o.loja + '/dia', { body: { funcId: o.id, data: o.data, turno: q('#ed-turno').value, justificativa: q('#ed-just').value } });
        var feito = escopo() === 'todos' ? 'turno de ' + o.nome + ' passou para ' + q('#ed-turno').value : 'dia ' + dBR + ' de ' + o.nome + ' ajustado'; G.toast(escopo() === 'todos' ? 'Turno de ' + o.nome + ' alterado' : 'Dia ' + dBR + ' ajustado'); fechar(); if (depois) depois(feito);
      } catch (x) { q('#ed-msg').innerHTML = '<div class="aviso neg" style="margin:0">' + e(x.message) + '</div>'; b.disabled = false; }
    };
  }
  // ── Faltando contratar: as vagas de cada loja, por função e turno (lista de trabalho do RH) ──
  /** F = resposta de /api/escalas-periodo/faltando; soLoja = mostra só uma loja (aba Cadastro). */
  function faltandoHtml(F, soLoja) {
    if (!F) return ''; var lojas = (F.lojas || []).filter(function (l) { return soLoja == null || +l.loja === +soLoja; }); var total = lojas.reduce(function (t, l) { return t + l.vagas; }, 0);
    var cx = 'background:var(--crd,#fff);border:1px solid var(--ln,#DADDE3);border-radius:12px;padding:12px 14px;margin:0 0 14px';
    if (!total) return '<div style="' + cx + ';font-size:12.5px;color:var(--ink2,#3A4660)"><b style="color:var(--ink,#14213D)">Faltando contratar</b> — nenhuma vaga em aberto' + (soLoja == null ? ' nas lojas que você acompanha' : ' nesta loja') + '.</div>';
    return '<div style="' + cx + '"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b style="font-size:13.5px;color:var(--ink,#14213D)">Faltando contratar</b><span style="background:#D0021B;color:#fff;font-weight:800;border-radius:999px;padding:2px 10px;font-size:12px">' + total + ' vaga' + (total > 1 ? 's' : '') + '</span><span style="font-size:11.5px;color:var(--ink3,#6B7280)">posições que a escala já conta e ainda não têm pessoa</span><a class="ds-btn ds-btn-secondary" href="/vagas.html" style="margin-left:auto">Vagas e Quadro de Pessoal</a></div>' +
      '<table style="border-collapse:collapse;width:100%;font-size:12px;margin-top:8px"><thead><tr>' + ['Loja', 'Função', 'Setor', 'Turno', 'Folga fixa', 'Incluída em', 'Quem vai ocupar'].map(function (h) { return '<th style="text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--ink3,#6B7280);padding:5px 8px;border-bottom:1px solid var(--ln,#DADDE3)">' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      lojas.map(function (l) { return l.itens.map(function (v, i) { return '<tr>' + (i === 0 ? '<td rowspan="' + l.itens.length + '" style="padding:5px 8px;border-bottom:1px solid var(--ln,#DADDE3);vertical-align:top"><a href="/escalas.html?loja=' + l.loja + '#cadastro" style="font-weight:800;color:inherit" title="Abrir o Cadastro da loja">' + e(l.lojaTxt) + '</a><br><small style="color:#D0021B;font-weight:700">' + l.vagas + ' vaga' + (l.vagas > 1 ? 's' : '') + '</small></td>' : '') +
        ['<b style="color:#D0021B">' + e(v.grupo) + '</b>', e(v.setorTxt), v.turno ? e(v.turno + (v.horario ? ' · ' + v.horario : '')) : '—', v.folgaFixa ? DS[v.folgaFixa] : '—', v.desde ? new Date(v.desde).toLocaleDateString('pt-BR') + (v.por ? ' · ' + e(v.por) : '') : e(v.obs || '—'), '<a class="ds-btn ds-btn-secondary" data-ecoc="' + v.id + '" data-ecloja="' + l.loja + '" style="white-space:nowrap" title="Escolher quem vai ocupar esta vaga: a pessoa assume a função, o turno e a folga fixa">Selecionar funcionário</a>'].map(function (c) { return '<td style="padding:5px 8px;border-bottom:1px solid var(--ln,#DADDE3)">' + c + '</td>'; }).join('') + '</tr>'; }).join(''); }).join('') + '</tbody></table></div>';
  }
  // ── Ocupar a vaga: escolher o funcionário que fica na linha CONTRATAR (19/11/2026) ──
  /** o = { loja, id }. Lista quem está no VR da loja (primeiro quem ainda não tem posição na escala) e aceita um nome de quem
   *  ainda não está no VR. Quem ocupa assume a função, o turno, a folga fixa e os dias já escalados da vaga. */
  async function ocupar(o, depois) {
    var G = window.G; var ov = document.createElement('div'); ov.className = 'f-ov';
    ov.innerHTML = '<div class="f-md" style="max-width:620px"><div class="hd"><div><b>Ocupar a vaga</b><small>Lendo o quadro da loja no VR…</small></div><button class="x" type="button">×</button></div><div class="bd" style="padding:14px 16px;font-size:12.5px;color:var(--ink2,#3A4660)">Um instante: a primeira leitura do VR pode levar até 1 minuto.</div></div>';
    document.body.appendChild(ov); var q = function (s) { return ov.querySelector(s); }; var fechar = function () { ov.remove(); }; q('.x').onclick = fechar;
    var C; try { C = await G.api('/api/escalas-periodo/' + o.loja + '/cadastro'); } catch (x) { fechar(); G.toast(x.message, 'neg'); return; }
    if (!ov.isConnected) return;
    var V = (C.pessoas || []).filter(function (p) { return p.extra && p.vaga && +p.id === +o.id; })[0];
    if (!V) { fechar(); G.toast('Esta vaga não está mais em aberto: ela já foi ocupada ou tirada da escala', 'neg'); if (depois) depois(null); return; }
    if (!C.podeCadastrar) { fechar(); G.toast('Só o gerente da unidade, o RH Ponto ou a Coordenação definem quem ocupa uma vaga', 'neg'); return; }
    var T = {}; (C.turnos || []).forEach(function (t) { T[t.codigo] = t; }); var pos = function (p) { return [p.grupo, p.turno ? p.turno + (T[p.turno] ? ' ' + T[p.turno].entrada + '–' + T[p.turno].saida : '') : null, p.folgaFixa ? 'folga ' + DS[p.folgaFixa].toLowerCase() : null].filter(Boolean).join(' · '); };
    var vr = (C.pessoas || []).filter(function (p) { return !p.extra; }).sort(function (a, b) { return String(a.nome).localeCompare(String(b.nome)); });
    var livres = vr.filter(function (p) { return !p.cadastrado || p.fora; }), postos = vr.filter(function (p) { return p.cadastrado && !p.fora; });
    var opt = function (p, comPos) { return '<option value="' + p.id + '">' + e(p.nome + (comPos ? ' — hoje: ' + pos(p) : p.fora ? ' — fora da escala' : '')) + '</option>'; };
    var est = 'padding:7px 9px;border:1px solid #C9CED6;border-radius:8px;font:inherit;font-size:12.5px;width:100%;box-sizing:border-box;background:var(--crd,#fff);color:var(--ink,#14213D)';
    var lab = function (t, campo, id) { return '<label' + (id ? ' id="' + id + '"' : '') + ' style="font-size:11px;font-weight:700;color:var(--ink2,#3A4660);display:grid;gap:4px;align-content:start">' + t + campo + '</label>'; };
    q('.hd small').textContent = 'Vaga de ' + V.grupo + (pos(V) ? ' · ' + pos(V).replace(V.grupo + ' · ', '') : '');
    q('.bd').style.cssText = 'padding:14px 16px;display:grid;gap:10px';
    q('.bd').innerHTML = '<div class="aviso inf" style="margin:0;font-size:12px">Quem ocupar a vaga assume a função, o turno e a folga fixa dela — e os dias que já estão escalados nesta linha, de amanhã em diante.</div>' +
      lab('Funcionário que vai ocupar a vaga', '<select id="eo-quem" style="' + est + '"><option value="">escolha…</option>' +
        (livres.length ? '<optgroup label="Do VR · ainda sem posição na escala (' + livres.length + ')">' + livres.map(function (p) { return opt(p, false); }).join('') + '</optgroup>' : '') +
        (postos.length ? '<optgroup label="Do VR · já tem posição (passa para a da vaga)">' + postos.map(function (p) { return opt(p, true); }).join('') + '</optgroup>' : '') +
        '<optgroup label="Ainda não está no VR"><option value="novo">Outra pessoa: escrever o nome…</option></optgroup></select>') +
      lab('Nome <small style="font-weight:500">(como vai aparecer na escala; quando a pessoa entrar no VR com o mesmo nome, a linha passa a ser a dela)</small>', '<input id="eo-nome" maxlength="80" style="' + est + '">', 'eo-l-nome') +
      '<label id="eo-l-abrir" style="display:none;gap:8px;align-items:flex-start;font-size:12.5px;font-weight:600;color:var(--ink,#14213D)"><input type="checkbox" id="eo-abrir" checked style="width:auto;margin-top:2px"><span>Abrir vaga no lugar que ele(a) deixa <small id="eo-abrir-t" style="display:block;font-weight:500;color:var(--ink3,#6B7280)"></small></span></label>' +
      '<div id="eo-msg"></div><div class="acoes" style="display:flex;gap:8px;justify-content:flex-end"><button class="ds-btn ds-btn-ghost" id="eo-c" type="button">Cancelar</button><button class="ds-btn ds-btn-primary" id="eo-ok" type="button">Ocupar a vaga</button></div>';
    q('#eo-c').onclick = fechar; var sel = q('#eo-quem');
    var muda = function () { var v = sel.value; q('#eo-l-nome').style.display = v === 'novo' ? '' : 'none'; var p = postos.filter(function (x) { return String(x.id) === v; })[0]; q('#eo-l-abrir').style.display = p ? 'flex' : 'none'; if (p) q('#eo-abrir-t').textContent = pos(p) + ' — sem marcar, essa posição simplesmente deixa de existir na escala'; if (v === 'novo') q('#eo-nome').focus(); };
    sel.onchange = muda; muda(); sel.focus();
    q('#eo-ok').onclick = async function () {
      var v = sel.value; if (!v) { q('#eo-msg').innerHTML = '<div class="aviso neg" style="margin:0">Escolha o funcionário que vai ocupar a vaga</div>'; return; }
      var b = v === 'novo' ? { id: V.id, nome: q('#eo-nome').value } : { id: V.id, funcId: +v, abrirVaga: q('#eo-l-abrir').style.display !== 'none' && q('#eo-abrir').checked };
      q('#eo-ok').disabled = true;
      try { var r = await G.api('/api/escalas-periodo/' + o.loja + '/vaga/ocupar', { body: b }); G.toast(r.nome + ' passou a ocupar a vaga de ' + r.grupo + (r.abriuVaga ? ' · aberta vaga de ' + r.abriuVaga : '')); fechar(); if (depois) depois(r.nome + ' ocupou a vaga de ' + r.grupo, r); }
      catch (x) { q('#eo-msg').innerHTML = '<div class="aviso neg" style="margin:0">' + e(x.message) + '</div>'; q('#eo-ok').disabled = false; }
    };
  }
  /** Liga, dentro de `raiz`, a escolha de quem ocupa a vaga: o nome da linha CONTRATAR (id negativo) vira clicável e os botões
   *  [data-ecoc] do quadro "Faltando contratar" abrem o mesmo diálogo. `loja` pode vir do próprio botão (data-ecloja). */
  function ligarOcupar(raiz, loja, depois) {
    var r = typeof raiz === 'string' ? document.querySelector(raiz) : raiz; if (!r) return; css();
    r.querySelectorAll('td.ecvaga[data-fid], td.vaga[data-fid]').forEach(function (td) { var id = +td.getAttribute('data-fid'); if (!(id < 0)) return; var alvo = td.querySelector('b') || td; if (alvo.querySelector('.ecoc')) return;
      var a = document.createElement('a'); a.className = 'ecoc'; a.title = 'Selecionar o funcionário que vai ocupar esta vaga'; a.textContent = alvo.textContent; alvo.textContent = ''; alvo.appendChild(a); alvo.removeAttribute('title');
      a.onclick = function (ev) { ev.stopPropagation(); ocupar({ loja: loja, id: id }, depois); }; });
    r.querySelectorAll('[data-ecoc]').forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); ocupar({ loja: +b.getAttribute('data-ecloja') || loja, id: +b.getAttribute('data-ecoc') }, depois); }; });
  }
  /** × de tirar a linha (só em linha incluída à mão ou vaga: id negativo). */
  function xLinha(id, nome) { return +id < 0 ? '<a class="ecx" data-ecrm="' + id + '" data-ecnome="' + e(nome) + '" title="Tirar esta linha da escala">×</a>' : ''; }
  var ehVaga = function (f) { return !!(f && (f.vaga || /^CONTRATAR\b/.test(String(f.nome || '')))); };

  var api = { css: css, ativo: ativo, alternar: alternar, th: th, cel: cel, chips: chips, botao: botao, horario: horario, filtro: filtro, passa: passa, ligarFiltro: ligarFiltro, botaoIncluir: botaoIncluir, incluir: incluir, ligarIncluir: ligarIncluir, editar: editar, ocupar: ocupar, ligarOcupar: ligarOcupar, faltandoHtml: faltandoHtml, xLinha: xLinha, ehVaga: ehVaga, COR_ROT: COR_ROT, TXT_ROT: TXT_ROT, aoMudar: null };
  return api;
})();
