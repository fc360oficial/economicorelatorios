/* Gente & Gestão — base compartilhada das telas de DP (dp.html) e RH (rh.html). 13/10/2026.
   Helpers de formatação, chamada de API, toast, modal de formulário (com busca de colaborador do PontoCerto),
   tabela padrão, ficha do colaborador e CRUD das coleções em /api/gente/<colecao>. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO', 10: 'DISTRIBUIDORA', 0: 'SEM LOJA' };
  const ETQ = n => +n === 10 ? 'CD' : (+n === 0 || n == null || n === '') ? '—' : 'E' + n;
  const etq = n => '<span class="etq' + (+n === 10 ? ' cd' : '') + '">' + ETQ(n) + '</span>';
  const dBR = s => s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '';
  const dSem = s => s ? ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][new Date(s + 'T12:00:00').getDay()] : '';
  const hoje = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const hhmm = min => { const s = min < 0 ? '-' : '', a = Math.abs(Math.round(min || 0)); return s + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0'); };
  const horas = min => (min < 0 ? '-' : '') + (Math.abs(min || 0) / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' h';
  const num = (v, d) => (+v || 0).toLocaleString('pt-BR', { maximumFractionDigits: d == null ? 0 : d });
  const pill = (cls, txt) => '<span class="pill ' + cls + '">' + esc(txt) + '</span>';
  const tempoCasa = adm => { if (!adm) return ''; const d = Math.round((new Date(hoje() + 'T12:00:00') - new Date(adm + 'T12:00:00')) / 86400000); if (d < 60) return d + ' d'; if (d < 365) return Math.round(d / 30.44) + ' m'; const a = Math.floor(d / 365.25), m = Math.round((d - a * 365.25) / 30.44); return a + ' a' + (m ? ' ' + m + ' m' : ''); };
  const sel = (op, v) => op.map(o => '<option' + (String(o) === String(v) ? ' selected' : '') + '>' + esc(o) + '</option>').join('');
  const LOJAS_OP = [[1, 'E1 · CAHU'], [2, 'E2 · MURIBECA'], [3, 'E3 · PONTE'], [4, 'E4 · ATACAREJO'], [5, 'E5 · PORTA LARGA'], [6, 'E6 · JARDIM JORDÃO'], [10, 'CD · DISTRIBUIDORA']];
  const selLoja = (v, vazio) => (vazio ? '<option value="">' + esc(vazio) + '</option>' : '') + LOJAS_OP.map(([k, t]) => '<option value="' + k + '"' + (String(k) === String(v) ? ' selected' : '') + '>' + t + '</option>').join('');

  // ── API ──
  async function api(url, opts) {
    const r = await fetch(url, opts && opts.body ? { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : opts);
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const err = new Error((j && j.error) || ('HTTP ' + r.status)); err.status = r.status; throw err; }
    return j;
  }
  const crud = {
    listar: (col, q) => api('/api/gente/' + col + (q ? '?' + new URLSearchParams(q) : '')),
    salvar: (col, body) => api('/api/gente/' + col, { body }),
    excluir: (col, id) => api('/api/gente/' + col + '/' + id, { method: 'DELETE' })
  };
  let me = null; const quemSou = () => me || api('/api/me').then(u => (me = u)).catch(() => null);

  // ── toast ──
  function toast(msg, tipo) {
    let t = $('#g-toast'); if (!t) { t = document.createElement('div'); t.id = 'g-toast'; document.body.appendChild(t); }
    t.className = 'show ' + (tipo || ''); t.textContent = msg; clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ── colaboradores (cache local da página) ──
  let colabs = null;
  async function colaboradores() { if (colabs) return colabs; const j = await api('/api/gente/colaboradores'); colabs = j; return j; }
  const colabPorId = id => colabs ? (colabs.ativos.find(c => c.id === +id) || colabs.desligados.find(c => c.id === +id)) : null;

  // ── modal de formulário ──
  // campos: [{ k, label, tipo: text|date|number|select|textarea|colab|check|multi|candidatos|setor, opcoes, obrig, col (1..3), ajuda }]
  function modal({ titulo, campos, valor, salvar, excluir, largura, rodape }) {
    return new Promise(resolve => {
      valor = valor || {};
      const ov = document.createElement('div'); ov.className = 'g-ov';
      const campo = f => {
        const v = valor[f.k] != null ? valor[f.k] : (f.padrao != null ? f.padrao : '');
        const id = 'f-' + f.k; const req = f.obrig ? ' required' : '';
        let inp;
        if (f.tipo === 'select') inp = '<select id="' + id + '"' + req + '>' + (f.vazio ? '<option value="">' + esc(f.vazio) + '</option>' : '') + sel(f.opcoes || [], v) + '</select>';
        else if (f.tipo === 'loja') inp = '<select id="' + id + '"' + req + '>' + selLoja(v, f.vazio || 'escolha a loja') + '</select>';
        else if (f.tipo === 'textarea') inp = '<textarea id="' + id + '" rows="' + (f.linhas || 3) + '"' + req + '>' + esc(v) + '</textarea>';
        else if (f.tipo === 'check') inp = '<label class="chk"><input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + '> ' + esc(f.texto || 'sim') + '</label>';
        else if (f.tipo === 'multi') inp = '<div class="multi" id="' + id + '">' + (f.opcoes || []).map(o => '<label><input type="checkbox" value="' + esc(o) + '"' + ((v || []).includes(o) ? ' checked' : '') + '> ' + esc(o) + '</label>').join('') + '</div>';
        else if (f.tipo === 'colab') inp = '<input id="' + id + '" list="g-colabs" autocomplete="off" placeholder="digite o nome…" value="' + esc(v) + '"' + req + '><input type="hidden" id="f-colab_id" value="' + esc(valor.colab_id || '') + '">';
        else if (f.tipo === 'setor') inp = '<input id="' + id + '" list="g-setores" autocomplete="off" value="' + esc(v) + '"' + req + '>';
        else if (f.tipo === 'candidatos') inp = '<div class="cands" id="' + id + '"></div><button type="button" class="btn gh sm" id="' + id + '-add">+ candidato</button>';
        else inp = '<input id="' + id + '" type="' + (f.tipo || 'text') + '" value="' + esc(v) + '"' + req + (f.min != null ? ' min="' + f.min + '"' : '') + (f.step ? ' step="' + f.step + '"' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>';
        return '<label class="fld c' + (f.col || 1) + '"><span>' + esc(f.label) + (f.obrig ? ' *' : '') + '</span>' + inp + (f.ajuda ? '<small>' + esc(f.ajuda) + '</small>' : '') + '</label>';
      };
      ov.innerHTML = '<div class="g-md" style="max-width:' + (largura || 760) + 'px"><div class="hd"><b>' + esc(titulo) + '</b><button type="button" class="x" title="fechar">×</button></div><form class="bd"><div class="grid">' + campos.map(campo).join('') + '</div>' + (rodape ? '<div class="rod">' + rodape + '</div>' : '') + '<div class="acoes">' + (excluir && valor.id ? '<button type="button" class="btn gh neg" id="g-del">Excluir</button>' : '') + '<span style="flex:1"></span><button type="button" class="btn gh" id="g-cancel">Cancelar</button><button type="submit" class="btn am">' + esc(salvar || 'Salvar') + '</button></div></form></div>';
      document.body.appendChild(ov);
      // datalists
      if (campos.some(f => f.tipo === 'colab' || f.tipo === 'setor')) colaboradores().then(c => {
        if (!$('#g-colabs')) { const dl = document.createElement('datalist'); dl.id = 'g-colabs'; document.body.appendChild(dl); }
        $('#g-colabs').innerHTML = c.ativos.map(x => '<option value="' + esc(x.nome) + '">' + ETQ(x.loja) + ' · ' + esc(x.setor) + ' · ' + esc(x.cargo) + '</option>').join('');
        if (!$('#g-setores')) { const dl = document.createElement('datalist'); dl.id = 'g-setores'; document.body.appendChild(dl); }
        $('#g-setores').innerHTML = [...new Set(c.ativos.map(x => x.setor))].sort().map(s => '<option value="' + esc(s) + '">').join('');
      });
      const fc = campos.find(f => f.tipo === 'colab');
      if (fc) ov.querySelector('#f-' + fc.k).addEventListener('input', e => {
        const c = colabs && colabs.ativos.find(x => x.nome === e.target.value); if (!c) { ov.querySelector('#f-colab_id').value = ''; return; }
        ov.querySelector('#f-colab_id').value = c.id;
        for (const [k, v] of [['loja', c.loja], ['setor', c.setor], ['cargo', c.cargo]]) { const el = ov.querySelector('#f-' + k); if (el && !el.dataset.manual) el.value = v; }
      });
      // candidatos (vagas)
      const fcand = campos.find(f => f.tipo === 'candidatos');
      let cands = fcand ? (valor.candidatos || []).map(c => ({ ...c })) : null;
      const ETAPAS = (fcand && fcand.opcoes) || ['triagem', 'entrevista', 'teste prático', 'exame admissional', 'aprovado', 'reprovado', 'desistiu'];
      const renderCands = () => { const el = ov.querySelector('#f-' + fcand.k); el.innerHTML = cands.length ? cands.map((c, i) => '<div class="cand"><input placeholder="nome" value="' + esc(c.nome) + '" data-i="' + i + '" data-k="nome"><input placeholder="telefone" value="' + esc(c.telefone || '') + '" data-i="' + i + '" data-k="telefone" style="max-width:130px"><select data-i="' + i + '" data-k="etapa">' + sel(ETAPAS, c.etapa || 'triagem') + '</select><input placeholder="observação" value="' + esc(c.obs || '') + '" data-i="' + i + '" data-k="obs"><button type="button" class="x" data-rm="' + i + '" title="remover">×</button></div>').join('') : '<div class="vazio sm">Nenhum candidato ainda.</div>';
        el.querySelectorAll('[data-k]').forEach(i => i.oninput = () => { cands[+i.dataset.i][i.dataset.k] = i.value; });
        el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { cands.splice(+b.dataset.rm, 1); renderCands(); }); };
      if (fcand) { renderCands(); ov.querySelector('#f-' + fcand.k + '-add').onclick = () => { cands.push({ nome: '', etapa: 'triagem' }); renderCands(); ov.querySelector('#f-' + fcand.k + ' .cand:last-child input').focus(); }; }
      const fechar = v => { ov.remove(); resolve(v); };
      ov.querySelector('.x').onclick = () => fechar(null); ov.querySelector('#g-cancel').onclick = () => fechar(null);
      ov.addEventListener('keydown', e => { if (e.key === 'Escape') fechar(null); });
      if (excluir && valor.id) ov.querySelector('#g-del').onclick = () => { if (confirm('Excluir este registro?')) fechar({ _excluir: true, id: valor.id }); };
      ov.querySelector('form').onsubmit = e => {
        e.preventDefault(); const out = { id: valor.id };
        for (const f of campos) { const el = ov.querySelector('#f-' + f.k); if (!el) continue;
          if (f.tipo === 'check') out[f.k] = el.checked; else if (f.tipo === 'multi') out[f.k] = [...el.querySelectorAll('input:checked')].map(i => i.value);
          else if (f.tipo === 'candidatos') out[f.k] = cands.filter(c => c.nome.trim()); else out[f.k] = el.value; }
        if (fc) out.colab_id = ov.querySelector('#f-colab_id').value || null;
        fechar(out);
      };
      setTimeout(() => { const first = ov.querySelector('input:not([type=hidden]),select,textarea'); if (first) first.focus(); }, 30);
    });
  }
  // abre o modal, salva na coleção e devolve o registro (ou null)
  async function formulario(col, cfg) {
    const v = await modal(cfg); if (!v) return null;
    try { if (v._excluir) { await crud.excluir(col, v.id); toast('Registro excluído'); return { excluido: true }; } const r = await crud.salvar(col, v); toast('Salvo'); return r; }
    catch (e) { toast(e.message, 'neg'); return null; }
  }

  // ── tabela padrão ──
  // cols: [{ h, cls, f: row => html }]; rows; vazio
  function tabela(cols, rows, opts) {
    opts = opts || {};
    if (!rows.length) return '<div class="vazio">' + esc(opts.vazio || 'Nada aqui.') + '</div>';
    const lim = opts.limite || 400;
    return '<div class="table-wrap"><table class="t"><thead><tr>' + cols.map(c => '<th class="' + (c.cls || '') + '">' + c.h + '</th>').join('') + '</tr></thead><tbody>' +
      rows.slice(0, lim).map(r => '<tr' + (opts.tr ? opts.tr(r) : '') + '>' + cols.map(c => '<td class="' + (c.cls || '') + '">' + c.f(r) + '</td>').join('') + '</tr>').join('') + '</tbody>' +
      (opts.rodape ? '<tfoot><tr>' + opts.rodape + '</tr></tfoot>' : '') + '</table>' + (rows.length > lim ? '<div class="vazio sm">mostrando ' + lim + ' de ' + rows.length + '</div>' : '') + '</div>';
  }
  const linhaColab = (r, extra) => '<td>' + etq(r.loja) + '</td><td class="w"><b>' + esc(r.nome) + '</b><span class="sub">' + esc(r.setor || '') + (r.cargo ? ' · ' + esc(r.cargo) : '') + '</span></td>' + (extra || '');
  const btn = (txt, cls, attr) => '<button class="btn ' + (cls || 'gh') + ' sm" ' + (attr || '') + '>' + txt + '</button>';

  // ── ficha do colaborador (drawer) ──
  async function ficha(id, extras) {
    await colaboradores(); const c = colabPorId(id); if (!c) { toast('Colaborador não encontrado no cadastro', 'neg'); return; }
    const ov = document.createElement('div'); ov.className = 'g-ov';
    ov.innerHTML = '<div class="g-md ficha"><div class="hd"><div><b>' + esc(c.nome) + '</b><small>' + ETQ(c.loja) + ' · ' + esc(NOMES[c.loja] || '') + ' · ' + esc(c.setor) + ' · ' + esc(c.cargo) + '</small></div><button type="button" class="x">×</button></div><div class="bd"><div class="dados">' +
      [['Status agora', c.status_agora], ['Admissão', dBR(c.admissao) + (c.admissao ? ' (' + tempoCasa(c.admissao) + ')' : '')], ['Vínculo', c.clt ? 'CLT' : '—'], ['Turno', c.turno], ['Equipe', c.equipe], ['Departamento', c.departamento], ['Matrícula', c.matricula || '—'], ['CPF', c.cpf_fim || '—'], ['Nascimento', dBR(c.nascimento) || '—'], ['Banco de horas', hhmm(c.banco_horas_min) + ' h'], ['Contato', [c.telefone, c.email].filter(Boolean).join(' · ') || '—'], ['Líder de equipe', c.lider ? 'sim' : 'não']]
        .map(([k, v]) => '<div><span>' + k + '</span><b>' + esc(v || '—') + '</b></div>').join('') + '</div><div id="ficha-regs" class="regs"><div class="vazio sm">carregando registros…</div></div></div></div>';
    document.body.appendChild(ov); ov.querySelector('.x').onclick = () => ov.remove(); ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    const cols = [['ocorrencias', 'Ocorrências', r => dBR(r.data) + ' · ' + r.tipo + (r.motivo ? ' — ' + r.motivo : '')], ['documentos', 'Documentos e exames', r => r.tipo + (r.validade ? ' · validade ' + dBR(r.validade) : '') + (r.emissao ? ' · emitido ' + dBR(r.emissao) : '')], ['ferias', 'Férias', r => r.status + ' · ' + dBR(r.inicio) + ' a ' + dBR(r.fim) + (r.aquisitivo_ini ? ' · período ' + dBR(r.aquisitivo_ini) + '–' + dBR(r.aquisitivo_fim) : '')],
      ['avaliacoes', 'Avaliações', r => r.tipo + ' · ' + (r.realizada ? 'feita em ' + dBR(r.realizada) + (r.nota ? ' · nota ' + r.nota : '') + (r.decisao ? ' · ' + r.decisao : '') : 'prevista ' + dBR(r.prevista))], ['capacitacoes', 'Treinamentos', r => r.treinamento + ' · ' + dBR(r.data) + (r.validade ? ' · vale até ' + dBR(r.validade) : '')], ['movimentacoes', 'Movimentações', r => dBR(r.data) + ' · ' + r.tipo + (r.de || r.para ? ' · ' + (r.de || '') + ' → ' + (r.para || '') : '')]];
    const partes = await Promise.all(cols.map(([col]) => crud.listar(col, { colab_id: c.id }).catch(() => [])));
    const regs = ov.querySelector('#ficha-regs');
    regs.innerHTML = cols.map(([col, tit, f], i) => '<div class="bloco"><div class="bh">' + tit + ' <small>' + partes[i].length + '</small></div>' + (partes[i].length ? '<ul>' + partes[i].map(r => '<li>' + esc(f(r)) + '</li>').join('') + '</ul>' : '<div class="vazio sm">nenhum</div>') + '</div>').join('') + (extras ? '<div class="bloco acoes-ficha">' + extras(c) + '</div>' : '');
    return ov;
  }

  // ── pendências ──
  const grauCls = g => g >= 3 ? 'neg' : g === 2 ? 'am' : 'inf';
  function pendencias(lista, lojaFiltro, irAba) {
    const rows = lojaFiltro ? lista.filter(p => !p.loja || String(p.loja) === String(lojaFiltro)) : lista;
    if (!rows.length) return '<div class="vazio">Nenhuma pendência' + (lojaFiltro ? ' nesta loja' : '') + '. Dia tranquilo.</div>';
    return '<div class="pend-lista">' + rows.map(p => '<div class="pend ' + grauCls(p.grau) + '" data-aba="' + esc(p.aba) + '"' + (p.colab_id ? ' data-colab="' + p.colab_id + '"' : '') + '><span class="grau"></span><span class="area">' + esc(p.area) + '</span>' + (p.loja ? etq(p.loja) : '') + '<b>' + esc(p.nome) + '</b><span class="txt">' + esc(p.texto) + '</span><span class="ir">abrir ›</span></div>').join('') + '</div>';
  }

  // CSS compartilhado (injetado uma vez)
  const css = `
.etq{display:inline-block;background:#101B33;color:#FFC933;font-weight:800;font-size:10.5px;padding:2px 7px;border-radius:6px;letter-spacing:.3px;min-width:30px;text-align:center}.etq.cd{background:var(--inf);color:#fff}
.pill{display:inline-block;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;letter-spacing:.2px;white-space:nowrap;background:var(--wsh);color:var(--ink2)}
.pill.neg{background:var(--negw);color:var(--neg)}.pill.pos{background:var(--posw);color:var(--pos)}.pill.inf{background:var(--infw);color:var(--inf)}.pill.am{background:var(--amw);color:var(--amk)}
.btn{border:none;border-radius:8px;padding:8px 14px;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.btn.am{background:var(--am);color:var(--amk)}.btn.nv{background:#101B33;color:#FFC933}.btn.gh{background:transparent;color:var(--ink2);border:1px solid var(--ln2)}.btn.gh.neg{color:var(--neg);border-color:#F1B9C3}.btn.sm{padding:4px 9px;font-size:11px;border-radius:6px}
.btn:hover{filter:brightness(.96)}
.sub{font-size:10.5px;color:var(--ink3);display:block;line-height:1.3}
.table-wrap{overflow-x:auto;border-radius:12px;border:1px solid var(--ln);background:var(--crd);box-shadow:var(--sh-sm);margin-bottom:16px}
table.t{width:100%;border-collapse:collapse;font-size:11.5px}
table.t th{text-align:left;font-size:9.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--ink2);background:var(--pap);padding:8px 9px;white-space:nowrap;border-bottom:1px solid var(--ln);position:sticky;top:0;z-index:1}
table.t th.r,table.t td.r{text-align:right}table.t th.c,table.t td.c{text-align:center}
table.t td{padding:6px 9px;border-top:1px solid var(--ln);white-space:nowrap;vertical-align:middle;line-height:1.35;font-variant-numeric:tabular-nums}
table.t td.w{white-space:normal;min-width:160px}
table.t tbody tr:nth-child(even) td{background:rgba(14,22,38,.018)}table.t tbody tr:hover td{background:var(--amw)}
table.t tbody tr.row{cursor:pointer}table.t tbody tr.on td{background:var(--amw)}
table.t tfoot td{font-weight:800;background:var(--pap);border-top:2px solid var(--ln2)}
.vazio{padding:22px;text-align:center;color:var(--ink3);font-size:12.5px}.vazio.sm{padding:10px;font-size:11.5px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--crd);border:1px solid var(--ln);border-radius:10px;padding:10px 14px;border-bottom:3px solid transparent;cursor:pointer}
.kpi.on{border-bottom-color:var(--am)}.kpi .l{font-size:9.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--ink3)}
.kpi .v{font-size:22px;font-weight:800;letter-spacing:-.5px;margin-top:2px;font-variant-numeric:tabular-nums}.kpi .s{font-size:11px;color:var(--ink2);margin-top:2px}
.kpi.neg .v{color:var(--neg)}.kpi.inf .v{color:var(--inf)}.kpi.pos .v{color:var(--pos)}.kpi.am .v{color:var(--amk)}
.card{background:var(--crd);border:1px solid var(--ln);border-radius:12px;overflow:hidden;margin-bottom:14px}
.card .hd{background:#101B33;color:#fff;font-weight:800;font-size:12.5px;padding:9px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.card .hd small{color:#B7C0D6;font-weight:600}.card .bd{padding:12px 14px;font-size:12.5px;color:var(--ink2);line-height:1.55}
.card.leve .hd{background:var(--wsh);color:var(--ink)}.card.leve .hd small{color:var(--ink3)}
.sec{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:18px 0 8px;flex-wrap:wrap}
.sec h2{font-size:14px;font-weight:800;letter-spacing:-.2px}.sec h2 small{color:var(--ink3);font-weight:700;margin-left:6px}
.sec .acoes{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{border:1px solid var(--ln2);background:var(--crd);border-radius:999px;padding:4px 11px;font-size:11px;font-weight:700;color:var(--ink2);cursor:pointer}.chip.on{background:#101B33;color:#FFC933;border-color:#101B33}.chip small{opacity:.7;margin-left:3px}
.pend-lista{display:flex;flex-direction:column;gap:5px;margin-bottom:16px}
.pend{display:flex;align-items:center;gap:9px;background:var(--crd);border:1px solid var(--ln);border-radius:9px;padding:7px 11px;font-size:12px;cursor:pointer;flex-wrap:wrap}
.pend:hover{background:var(--amw)}.pend .grau{width:8px;height:8px;border-radius:50%;flex:none}.pend.neg .grau{background:var(--neg)}.pend.am .grau{background:var(--am)}.pend.inf .grau{background:var(--inf)}
.pend .area{font-size:9.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--ink3);min-width:84px}.pend b{white-space:nowrap}.pend .txt{color:var(--ink2);flex:1;min-width:200px}.pend .ir{font-size:11px;font-weight:700;color:var(--ink3)}
.g-ov{position:fixed;inset:0;background:rgba(10,17,32,.55);z-index:9000;display:flex;align-items:flex-start;justify-content:center;padding:40px 14px;overflow:auto}
.g-md{background:var(--crd);color:var(--ink);border-radius:14px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden}
.g-md .hd{background:#101B33;color:#fff;padding:11px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px}.g-md .hd b{font-size:14px}.g-md .hd small{display:block;color:#B7C0D6;font-weight:600;font-size:11.5px;margin-top:2px}
.g-md .x{background:transparent;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:0 4px}
.g-md .bd{padding:14px 16px}.g-md .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 12px}
.g-md .fld{display:flex;flex-direction:column;gap:3px;font-size:11px;font-weight:700;color:var(--ink2)}.g-md .fld.c2{grid-column:span 2}.g-md .fld.c3{grid-column:span 3}.g-md .fld small{font-weight:500;color:var(--ink3)}
.g-md input,.g-md select,.g-md textarea{padding:7px 9px;border:1px solid var(--ln2);border-radius:8px;font-size:12.5px;font-family:inherit;color:var(--ink);background:var(--crd);width:100%}
.g-md .chk{display:flex;align-items:center;gap:6px;font-weight:600;padding-top:8px}.g-md .chk input{width:auto}
.g-md .multi{display:flex;flex-wrap:wrap;gap:4px 10px;padding:6px 0}.g-md .multi label{font-weight:600;display:flex;gap:4px;align-items:center}.g-md .multi input{width:auto}
.g-md .cands{display:flex;flex-direction:column;gap:5px;margin-bottom:6px}.g-md .cand{display:grid;grid-template-columns:1.4fr .8fr 1fr 1.4fr auto;gap:5px;align-items:center}.g-md .cand .x{color:var(--neg);font-size:18px}
.g-md .rod{font-size:11.5px;color:var(--ink3);margin-top:10px;line-height:1.5}
.g-md .acoes{display:flex;gap:8px;margin-top:14px;align-items:center}
.g-md.ficha{max-width:860px}.g-md.ficha .dados{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px 14px;margin-bottom:14px}.g-md.ficha .dados div{display:flex;flex-direction:column;font-size:12px}.g-md.ficha .dados span{font-size:9.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--ink3)}
.g-md.ficha .regs{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}.g-md.ficha .bloco{border:1px solid var(--ln);border-radius:10px;padding:8px 11px;font-size:12px}.g-md.ficha .bh{font-weight:800;margin-bottom:4px}.g-md.ficha .bh small{color:var(--ink3)}.g-md.ficha ul{padding-left:16px;color:var(--ink2);line-height:1.5}.g-md.ficha .acoes-ficha{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap;border-style:dashed}
#g-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);background:#0E1626;color:#fff;font:700 12.5px var(--font);padding:10px 18px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3);z-index:99999;opacity:0;transition:.25s;pointer-events:none;border-left:4px solid var(--am)}
#g-toast.show{opacity:1;transform:translateX(-50%)}#g-toast.neg{border-left-color:var(--neg)}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.bar input,.bar select{padding:7px 9px;border:1px solid var(--ln2);border-radius:8px;font-size:12px;font-family:inherit;background:var(--crd);color:var(--ink)}
.bar .seg{display:flex;border:1px solid var(--ln2);border-radius:9px;overflow:hidden;background:var(--crd)}.bar .seg button{border:none;background:transparent;padding:7px 11px;font-size:12px;font-weight:700;color:var(--ink2);cursor:pointer;font-family:inherit}.bar .seg button.on{background:#101B33;color:#FFC933}
.st{font-size:11.5px;color:var(--ink3)}
.tabs{display:flex;gap:2px;border-bottom:2px solid var(--ln);margin-bottom:14px;flex-wrap:wrap;position:sticky;top:0;background:var(--pap);z-index:5}
.tab{padding:9px 13px;font-size:12.5px;font-weight:700;color:var(--ink2);cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;white-space:nowrap}.tab.on{color:var(--ink);border-bottom-color:var(--am)}.tab small{color:var(--ink3);font-weight:700;margin-left:4px}.tab small.neg{color:var(--neg)}
.aviso{background:var(--amw);border:1px solid var(--am-ln);color:var(--amk);border-radius:10px;padding:10px 14px;font-size:12.5px;margin-bottom:14px;line-height:1.5}.aviso.neg{background:var(--negw);border-color:#F1B9C3;color:var(--neg)}.aviso.inf{background:var(--infw);border-color:var(--inf);color:var(--inf)}
.barra{display:inline-block;height:7px;border-radius:4px;background:var(--pos);vertical-align:middle}.barra.neg{background:var(--neg)}
.vivo{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.vivo div{background:var(--crd);border:1px solid var(--ln);border-radius:9px;padding:6px 12px;font-size:12px;display:flex;gap:8px;align-items:baseline;cursor:pointer}.vivo b{font-size:16px;font-variant-numeric:tabular-nums}.vivo .dot{width:8px;height:8px;border-radius:50%;display:inline-block;align-self:center}
@media(max-width:820px){.g-md .grid{grid-template-columns:1fr}.g-md .fld.c2,.g-md .fld.c3{grid-column:span 1}.g-md .cand{grid-template-columns:1fr 1fr}.pend .area{min-width:0}.g-ov{padding:10px 6px}}
`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  window.G = { $, $$, esc, NOMES, ETQ, etq, dBR, dSem, hoje, hhmm, horas, num, pill, tempoCasa, sel, selLoja, LOJAS_OP, api, crud, quemSou, toast, colaboradores, colabPorId, modal, formulario, tabela, linhaColab, btn, ficha, pendencias, grauCls };
})();
