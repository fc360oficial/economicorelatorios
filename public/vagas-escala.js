// vagas-escala.js — desenha as linhas "VAGA EM ABERTO" na grade da Escala coletiva e na proposta do Gerador 5×2 (12/11/2026).
// A vaga vem de DP / RH › Vagas e Quadro de Pessoal (/api/vagas/escala) e é só desenho: não existe em `funcionarios`, não tem
// jornada, não soma horas e não entra na cobertura. Quem não tem acesso ao módulo simplesmente não vê as linhas.
(function () {
  const CSS = 'table.cal tr.vaga td.n{background:#FDF1F3;box-shadow:inset 3px 0 0 #D9667A}table.cal tr.vaga td.n b{color:#A3263A;display:flex;align-items:center;gap:5px}table.cal tr.vaga td.n b svg{width:13px;height:13px;flex:none}table.cal tr.vaga td.n span{color:#8A4A55}' +
    'table.cal tr.vaga td.n b small{font-weight:700;font-size:9px;background:#FBDDE2;color:#8E1F33;border-radius:999px;padding:1px 6px;text-transform:none}' +
    'table.cal td.vg{background:repeating-linear-gradient(135deg,#FBE4E8 0 5px,#FFF6F7 5px 10px);color:#A3263A;font-size:8px;font-weight:800;letter-spacing:.2px;cursor:pointer}table.cal td.vgt{background:#FDF1F3;color:#A3263A;font-weight:800;text-align:center}' +
    'table.cal td.n b em.sai{display:inline-block;margin-right:5px;padding:1px 5px;border-radius:999px;font-size:8.5px;font-weight:800;font-style:normal;text-transform:none;background:#FBDDE2;color:#8E1F33;vertical-align:1px}' +
    '.cal-leg i.vgx{background:repeating-linear-gradient(135deg,#FBE4E8 0 4px,#FFF6F7 4px 8px);box-shadow:inset 3px 0 0 #D9667A}@media (max-width:1399px){table.cal td.vg span{display:none}}';
  const ICO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="2 1.6" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2.5 14.2c.6-3 2.7-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/></svg>';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const br = d => d ? d.split('-').reverse().join('/') : '';
  const cache = {};
  async function buscar(loja, de, ate) { const k = loja + '|' + de + '|' + ate; const c = cache[k]; if (c && Date.now() - c.em < 30000) return c.l; const r = await fetch('/api/vagas/escala?loja=' + loja + '&de=' + de + '&ate=' + ate, { credentials: 'same-origin' }); if (!r.ok) return []; const l = await r.json(); cache[k] = { em: Date.now(), l }; return l; }
  /** raiz = seletor do bloco que contém a table.cal; dias = datas (AAAA-MM-DD) das colunas, na ordem */
  window.vagasNaGrade = async function (raiz, loja, dias) {
    try {
      if (!document.getElementById('vg-css')) { const st = document.createElement('style'); st.id = 'vg-css'; st.textContent = CSS; document.head.appendChild(st); }
      if (!dias || !dias.length) return; const lista = await buscar(loja, dias[0], dias[dias.length - 1]);
      const tab = document.querySelector(raiz + ' table.cal'); if (!tab || !tab.tBodies[0]) return; tab.querySelectorAll('tr.vaga').forEach(t => t.remove()); if (!lista.length) return;
      const nCols = tab.tHead ? tab.tHead.rows[0].cells.length : dias.length + 2; const resto = Math.max(0, nCols - 1 - dias.length);
      for (const v of lista) {
        const tt = 'VAGA EM ABERTO ' + v.id + ' · ' + v.lojaTxt + ' · ' + v.setorTxt + (v.cargo ? ' · ' + v.cargo : '') + (v.turno ? ' · turno de referência ' + v.turno : '') + ' · aberta em ' + br(v.abertaEm) + ' · posição vaga desde ' + br(v.desde) + (v.ate ? ' até ' + br(v.ate) : '') + ' · ' + v.statusTxt + (v.ocupanteAnterior ? ' · era de ' + v.ocupanteAnterior : '') + (v.substituto ? ' · substituto: ' + v.substituto.nome + ' a partir de ' + br(v.substituto.inicio) : '') + ' — não conta como presença, jornada ou cobertura';
        const tr = document.createElement('tr'); tr.className = 'vaga'; tr.dataset.vaga = v.id;
        tr.innerHTML = '<td class="n" title="' + esc(tt) + '"><b>' + ICO + 'VAGA EM ABERTO<small>' + esc(v.statusTxt) + '</small></b><span>' + esc(v.setorTxt + (v.cargo && v.cargo !== v.setorTxt ? ' · ' + v.cargo : '') + (v.turno ? ' · ' + v.turno : '') + ' · aberta em ' + br(v.abertaEm).slice(0, 5)) + '</span></td>' +
          dias.map(d => d >= v.desde && (!v.ate || d <= v.ate) ? '<td class="vg" title="' + esc(tt) + '"><span>VAGA</span></td>' : '<td class="vz"></td>').join('') + (resto ? '<td class="vgt" title="Vaga não soma horas">—</td>' + '<td class="vz"></td>'.repeat(resto - 1) : '');
        tr.onclick = () => { location.href = '/vagas.html#vaga=' + v.id; };
        // logo abaixo da última pessoa do mesmo setor; sem ninguém do setor na tela, no fim da grade
        const doSetor = [...tab.tBodies[0].querySelectorAll('td.n[data-st]')].filter(td => td.dataset.st === v.setor); const ult = doSetor.length ? doSetor[doSetor.length - 1].parentNode : null; let ref = ult; while (ref && ref.nextElementSibling && ref.nextElementSibling.classList.contains('vaga')) ref = ref.nextElementSibling;
        if (ref) ref.after(tr); else tab.tBodies[0].appendChild(tr);
      }
      const leg = document.querySelector(raiz + ' .cal-leg'); if (leg && !leg.querySelector('.vgx')) leg.insertAdjacentHTML('beforeend', '<span><i class="vgx"></i><div><b>Vaga em aberto</b><small>posição sem ocupante · não conta na cobertura</small></div></span>');
    } catch (e) {}
  };
})();
