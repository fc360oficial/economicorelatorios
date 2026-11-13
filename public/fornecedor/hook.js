// Gancho do Portal do Fornecedor nas páginas do vendedor (/cotacao/<token>, /pedido/<token> e os atalhos /fornecedor/...).
// Sem login neste celular: painel "crie seu login no portal" (WhatsApp + PIN de 6 números) → manda pro
// /fornecedor/?de=cotacao/<token>#criar (ou #entrar), que volta pra cá depois de entrar, com #avisos pra oferecer os
// avisos na hora. Na cotação o login é OBRIGATÓRIO quando /api/portal/config diz exigeLogin (padrão; Tiago, 13/10:
// "quero forçar já agora nessa cotação"): fundo escuro bloqueia a página desde a abertura e o painel não tem "Agora não". Já logado: refaz a inscrição de push se o navegador perdeu e lembra de ativar os avisos (1x por semana).
// Nada aqui interfere na digitação dos preços: o painel sobe por cima, dá pra fechar e continuar como sempre.
(function () {
  'use strict';
  var m = location.pathname.match(/\/(cotacao|pedido)\/([a-f0-9]{32})/); if (!m) return;
  var tipo = m[1], token = m[2];
  var KEY = 'portalVt', NOME = 'portalNome', ADIADO = 'portalAdiadoAte', SUB = 'portalSubOk';
  var ls = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }, del: function (k) { try { localStorage.removeItem(k); } catch (e) {} } };
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var celular = isIOS || /Android|Mobile/i.test(navigator.userAgent);   // app obrigatório só vale no celular (Tiago, 13/11/26)
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function api(url, body) { return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); }); }
  function b64(s) { var p = '='.repeat((4 - s.length % 4) % 4); var b = (s + p).replace(/-/g, '+').replace(/_/g, '/'); var raw = atob(b); var a = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); return a; }
  // celular abrindo o link público: passa pro endereço do app (mesma página), onde o navegador consegue oferecer a instalação
  if ((isIOS || /Android|Mobile/i.test(navigator.userAgent)) && !/^\/fornecedor\//.test(location.pathname)) { location.replace('/fornecedor/' + tipo + '/' + token + location.search + location.hash); return; }
  var de = encodeURIComponent(tipo + '/' + token);   // de onde o vendedor veio: o portal volta pra cá depois do login

  // ── estilo do painel ──
  var css = '.pf-sheet{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fff;color:#0E1626;border-radius:22px 22px 0 0;box-shadow:0 -12px 40px -16px rgba(14,22,38,.45);padding:12px 20px 22px;font-family:Inter,"Segoe UI",system-ui,sans-serif;font-size:14px;max-height:88vh;overflow:auto;animation:pfUp .25s ease-out}' +
    '@keyframes pfUp{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}' +
    '.pf-sheet .pf-h{width:40px;height:5px;border-radius:3px;background:#DADAD6;margin:0 auto 14px}' +
    '.pf-sheet h3{font-size:18px;font-weight:700;line-height:1.2;margin:0 0 4px}.pf-sheet p{margin:0 0 12px;color:#4E5A72;line-height:1.4}' +
    '.pf-top{display:flex;gap:14px;align-items:center;margin-bottom:14px}.pf-ic{width:56px;height:56px;border-radius:14px;background:#F5B800;color:#0E1626;font-weight:800;font-size:28px;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
    '.pf-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:50px;border-radius:9px;border:none;font:inherit;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;box-sizing:border-box}' +
    '.pf-btn.p{background:#F5B800;color:#0E1626}.pf-btn.d{background:#0E1626;color:#fff}.pf-btn.g{background:#fff;border:1px solid #C9C9C4;color:#0E1626;height:46px;font-weight:600;margin-top:8px}.pf-btn[disabled]{opacity:.55;cursor:default}' +
    '.pf-ok{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;line-height:1.4}.pf-ok i{width:26px;height:26px;border-radius:13px;background:#E7F5EC;color:#137A48;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-style:normal;font-weight:800}' +
    '.pf-note{font-size:12px;color:#4E5A72;text-align:center;margin-top:12px;line-height:1.45}.pf-err{color:#C22F49;font-weight:600;margin:8px 0 0}' +
    '.pf-back{position:fixed;left:0;top:0;right:0;bottom:0;z-index:9998;background:rgba(14,22,38,.55)}' +
    '.pf-bar{position:fixed;left:10px;right:10px;bottom:10px;z-index:9998;background:#0E1626;color:#fff;border-radius:12px;padding:10px 12px;display:flex;gap:10px;align-items:center;font-family:Inter,"Segoe UI",system-ui,sans-serif;font-size:13px;box-shadow:0 10px 30px -10px rgba(14,22,38,.6)}' +
    '.pf-bar b{color:#F5B800}.pf-bar button,.pf-bar a{font:inherit;font-weight:700;border:none;border-radius:8px;padding:9px 12px;cursor:pointer;text-decoration:none;white-space:nowrap}.pf-bar .y{background:#F5B800;color:#0E1626}.pf-bar .n{background:transparent;color:#AEB8CE}' +
    '@media(min-width:720px){.pf-sheet{left:auto;right:24px;bottom:24px;width:420px;border-radius:18px}.pf-bar{left:auto;right:24px;width:420px;box-sizing:border-box}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var box = null, fundo = null;
  function fechar() { if (box) { box.remove(); box = null; } semFundo(); }
  function semFundo() { if (fundo) { fundo.remove(); fundo = null; } }
  function comFundo() { if (!fundo) { fundo = document.createElement('div'); fundo.className = 'pf-back'; document.body.appendChild(fundo); } }
  // bloquear = login obrigatório: fundo escuro fica por trás do painel e a página não responde a toques
  function painel(html, bloquear) { if (box) { box.remove(); box = null; } if (bloquear) comFundo(); else semFundo(); box = document.createElement('div'); box.className = 'pf-sheet'; box.setAttribute('role', 'dialog'); box.innerHTML = '<div class="pf-h"></div>' + html; document.body.appendChild(box); return box; }
  // sem sessão na cotação: já escurece a página na abertura, enquanto o servidor confirma se o login é obrigatório
  if (tipo === 'cotacao' ? !ls.get(KEY) || celular : celular) comFundo();   // celular: escurece até saber se o app está instalado e com avisos
  function adiar(dias) { ls.set(ADIADO, String(Date.now() + dias * 86400000)); fechar(); }
  function adiado() { var t = parseInt(ls.get(ADIADO) || '0', 10); return t > Date.now(); }
  var beneficios = '<div class="pf-ok"><i>✓</i><div><b>Pedido novo</b> da Econômico chega como aviso, pra você digitar os preços; e outro aviso quando ele é aprovado.</div></div>' +
    '<div class="pf-ok"><i>✓</i><div><b>Nova cotação</b> chega como aviso, com prazo e número de itens.</div></div>' +
    '<div class="pf-ok"><i>✓</i><div><b>Lembrete 2 h antes do prazo</b> se ainda faltar item sem preço.</div></div>' +
    '<div class="pf-ok"><i>✓</i><div><b>Pedido gerado</b> quando você vence, com o PDF e a data de entrega.</div></div>';

  // ── push: inscreve este aparelho pro vendedor (vt) ──
  function inscrever(vt) {
    if (!pushOk) return Promise.reject(new Error('Este navegador não recebe avisos. No iPhone, instale o app primeiro (Compartilhar → Adicionar à Tela de Início) e ative lá.'));
    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Avisos bloqueados neste navegador. Libere em Configurações do site → Notificações.' : 'Você não permitiu os avisos.');
      return api('/api/portal/vapid');
    }).then(function (k) {
      if (!k.chave) throw new Error('Avisos ainda não disponíveis no servidor' + (k.erro ? ' (' + k.erro + ')' : '') + '. Tente mais tarde.');
      return navigator.serviceWorker.register('/fornecedor/sw.js', { scope: '/fornecedor/' }).then(function (reg) {
        return navigator.serviceWorker.ready.then(function () { return reg.pushManager.getSubscription(); }).then(function (s) { return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.chave) }); });
      });
    }).then(function (sub) { return api('/api/portal/push/inscrever', { vt: vt, subscription: sub.toJSON ? sub.toJSON() : sub }); })
      .then(function () { ls.set(SUB, '1'); return api('/api/portal/push/testar', { vt: vt }).catch(function () { return {}; }); });
  }

  // ── sem login neste celular: convite pra criar o login (ou entrar). obrig = login obrigatório pra responder: sem "Agora não" ──
  function passoLogin(obrig) {
    var h = '<div class="pf-top"><div class="pf-ic">E</div><div><h3>' + (obrig ? 'Pra responder ' + (tipo === 'pedido' ? 'este pedido' : 'esta cotação') + ', crie seu login no Portal do Fornecedor' : 'Receba os próximos pedidos e cotações direto no celular') + '</h3><p>' + (obrig ? 'Seu WhatsApp e um PIN de 6 números. Leva 1 minuto, vale pra todos os próximos pedidos e cotações da Econômico, e você volta pra esta logo em seguida.' : 'Crie seu login no Portal do Fornecedor da Econômico: seu WhatsApp e um PIN de 6 números. Depois é só entrar, em qualquer celular.') + '</p></div></div>' +
      beneficios +
      '<a class="pf-btn p" href="/fornecedor/?de=' + de + '#criar">Criar meu login</a>' +
      '<a class="pf-btn g" href="/fornecedor/?de=' + de + '#entrar">Já tenho login, entrar</a>' +
      (obrig ? '' : '<button class="pf-btn g" id="pf-nao">Agora não, só ' + (tipo === 'pedido' ? 'ver o pedido' : 'cotar') + '</button>') +
      '<div class="pf-note">Só o(a) comprador(a) da Econômico vê seus preços. Os outros fornecedores não veem nada.</div>';
    var b = painel(h, !!obrig);
    if (!obrig) b.querySelector('#pf-nao').onclick = function () { adiar(3); };
  }

  // ── logado: ativar avisos + instalar ──
  function passoAvisos(vt, nome) {
    var h = '<div class="pf-top"><div class="pf-ic">E</div><div><h3>' + (nome ? esc(nome.split(' ')[0]) + ', receba' : 'Receba') + ' os próximos pedidos e cotações direto no celular</h3><p>Sem esperar o link no WhatsApp. Um toque e você já está cotando.</p></div></div>' +
      beneficios +
      (isIOS && !standalone
        ? '<p style="margin-top:8px"><b>No iPhone</b>: toque em <b>Compartilhar</b> (quadrado com seta) e depois em <b>Adicionar à Tela de Início</b>. Abra o app <b>Fornecedor</b> e toque em <b>Ativar avisos</b>.</p><a class="pf-btn d" href="/fornecedor/">Abrir o portal</a>'
        : '<button class="pf-btn d" id="pf-ativar">🔔 Ativar avisos' + (deferred ? ' e instalar' : '') + '</button>') +
      '<button class="pf-btn g" id="pf-nao">Agora não, só ' + (tipo === 'pedido' ? 'ver o pedido' : 'cotar') + '</button>' +
      '<div class="pf-note">Dá pra desligar os avisos quando quiser, no portal.</div><div class="pf-err" id="pf-err"></div>';
    var b = painel(h);
    b.querySelector('#pf-nao').onclick = function () { adiar(7); };
    var bt = b.querySelector('#pf-ativar');
    if (bt) bt.onclick = function () {
      bt.disabled = true; bt.textContent = 'Ativando…';
      inscrever(vt).then(function () {
        var inst = deferred ? deferred.prompt().then(function () { deferred = null; }).catch(function () {}) : Promise.resolve();
        return inst.then(function () { pronto(standalone || !deferred); });
      }).catch(function (e) { bt.disabled = false; bt.textContent = '🔔 Ativar avisos'; b.querySelector('#pf-err').textContent = e.message; });
    };
  }
  function pronto(semInstalar) {
    var h = '<div class="pf-top"><div class="pf-ic" style="background:#E7F5EC;color:#137A48">✓</div><div><h3>Avisos ativados</h3><p>Você acabou de receber um aviso de teste. Os próximos pedidos e cotações chegam assim.</p></div></div>' +
      (!standalone ? '<p><b>Pra ter o ícone na tela inicial</b>: ' + (isIOS ? 'toque em Compartilhar → Adicionar à Tela de Início.' : 'abra o menu ⋮ do navegador → <b>Instalar app</b> (ou "Adicionar à tela inicial").') + '</p>' : '') +
      '<a class="pf-btn d" href="/fornecedor/">Abrir meu portal</a><button class="pf-btn g" id="pf-fechar">Continuar ' + (tipo === 'pedido' ? 'no pedido' : 'cotando') + '</button>';
    var b = painel(h); b.querySelector('#pf-fechar').onclick = fechar; ls.set(ADIADO, '0');
  }

  // ── CELULAR: app instalado + avisos ativos são obrigatórios pra responder (Tiago, 13/11/26). Painel sem "Agora não". ──
  // O servidor é quem sabe: vendedor.instalado (já abriu pelo ícone do app) e vendedor.dispositivos (aparelhos com aviso ativo).
  function faltaApp(v) {
    var f = []; v = v || {};
    if (!v.instalado && !standalone) f.push('instalar');
    if (!(v.dispositivos > 0) && (pushOk || isIOS)) f.push('avisos');   // aparelho que não recebe aviso de jeito nenhum (navegador antigo) não trava por isso
    return f;
  }
  function passoApp(vt, v) {
    var f = faltaApp(v), fi = f.indexOf('instalar') >= 0, fa = f.indexOf('avisos') >= 0;
    var linha = function (ok, txt) { return '<div class="pf-ok"><i style="' + (ok ? '' : 'background:#FBEDDD;color:#8A4A00') + '">' + (ok ? '✓' : '!') + '</i><div>' + txt + '</div></div>'; };
    var h = '<div class="pf-top"><div class="pf-ic">E</div><div><h3>Pelo celular, ' + (tipo === 'pedido' ? 'o pedido' : 'a cotação') + ' é respondid' + (tipo === 'pedido' ? 'o' : 'a') + ' pelo app do Portal do Fornecedor</h3><p>Instale o app e ative os avisos. Leva 1 minuto e vale pra todos os próximos pedidos e cotações da Econômico.</p></div></div>' +
      linha(!fi, fi ? '<b>Instalar o app</b> na tela inicial deste celular.' : '<b>App instalado.</b>') +
      linha(!fa, fa ? '<b>Ativar os avisos</b>: é por eles que o pedido e a cotação chegam.' : '<b>Avisos ativos.</b>') +
      (isIOS && !standalone
        ? '<p style="margin-top:8px"><b>No iPhone</b>: toque em <b>Compartilhar</b> (quadrado com seta) → <b>Adicionar à Tela de Início</b>. Depois abra o app <b>Fornecedor</b> pela tela inicial e toque em <b>Ativar avisos</b>.</p><a class="pf-btn d" href="/fornecedor/">Abrir o portal</a>'
        : '<button class="pf-btn d" id="pf-app">' + (fa ? '🔔 Ativar avisos' + (fi ? ' e instalar o app' : '') : 'Instalar o app') + '</button>' +
          (fi ? '<p class="pf-note" style="text-align:left">Se o celular não perguntar nada: abra o menu <b>⋮</b> do navegador → <b>Instalar app</b> (ou "Adicionar à tela inicial") e abra o app <b>Fornecedor</b> uma vez pela tela inicial.</p>' : '')) +
      '<button class="pf-btn g" id="pf-ja">Já fiz, continuar</button>' +
      '<div class="pf-err" id="pf-err"></div><div class="pf-note">Não conseguiu instalar? Fale com o(a) comprador(a) da Econômico. Pelo computador o link abre normal.</div>';
    var b = painel(h, true), err = function (t) { b.querySelector('#pf-err').textContent = t; }, semOferta = false;
    var conferir = function (aviso) {
      return api('/api/portal/eu?vt=' + encodeURIComponent(vt) + (standalone ? '&app=1' : '')).then(function (r) {
        var falta = faltaApp(r.vendedor);
        if (!falta.length) { fechar(); jaIdentificado(vt); return true; }
        if (aviso) err(falta.indexOf('instalar') >= 0 ? 'Ainda falta instalar: depois de instalar, abra o app Fornecedor uma vez pela tela inicial e volte aqui.' : 'Ainda falta ativar os avisos' + (isIOS ? ': abra o app Fornecedor e toque em Ativar avisos.' : '.'));
        else passoApp(vt, r.vendedor);
        return false;
      }).catch(function (e) { err(e.message); });
    };
    b.querySelector('#pf-ja').onclick = function () { conferir(true); };
    var bt = b.querySelector('#pf-app');
    if (bt) bt.onclick = function () {
      bt.disabled = true; var txt = bt.textContent; bt.textContent = 'Aguarde…';
      (fa ? inscrever(vt) : Promise.resolve()).then(function () {
        if (!fi) return null;
        if (!deferred) { semOferta = true; return null; }   // o navegador não ofereceu a instalação: mostra o caminho manual
        var d = deferred; deferred = null; d.prompt();
        return d.userChoice.then(function (c) { if (c && c.outcome === 'accepted') return api('/api/portal/eu?vt=' + encodeURIComponent(vt) + '&app=1').catch(function () {}); });
      }).then(function () {
        if (semOferta) {
          semOferta = false; bt.disabled = false; bt.textContent = txt;
          return api('/api/portal/eu?vt=' + encodeURIComponent(vt)).then(function (r) {
            if (!faltaApp(r.vendedor).length) { fechar(); jaIdentificado(vt); return; }
            err(isIOS ? 'Toque em Compartilhar → Adicionar à Tela de Início. Depois abra o app Fornecedor.' : 'Este navegador não abriu a instalação sozinho. Toque no menu ⋮ (canto de cima) → "Instalar app" ou "Adicionar à tela inicial". Se o app já está instalado, abra o Fornecedor pela tela inicial: o pedido está lá.');
          });
        }
        return conferir(false);
      }).catch(function (e) { bt.disabled = false; bt.textContent = txt; err(e.message); });
    };
  }
  window.addEventListener('appinstalled', function () { var vt = ls.get(KEY); if (vt) api('/api/portal/eu?vt=' + encodeURIComponent(vt) + '&app=1').catch(function () {}); });

  // ── já logado: garante a inscrição deste aparelho; senão, oferece os avisos (na volta do login: na hora; depois: 1x por semana) ──
  function jaIdentificado(vt) {
    var voltouDoLogin = /avisos/.test(location.hash);
    if (voltouDoLogin) history.replaceState(null, '', location.pathname + location.search);
    var nome = ls.get(NOME) || '';
    if (!pushOk) { if (voltouDoLogin && isIOS && !standalone) passoAvisos(vt, nome); return; }
    if (Notification.permission === 'granted') {
      navigator.serviceWorker.register('/fornecedor/sw.js', { scope: '/fornecedor/' }).then(function (reg) { return reg.pushManager.getSubscription().then(function (s) { if (s) { if (!ls.get(SUB)) return api('/api/portal/push/inscrever', { vt: vt, subscription: s.toJSON ? s.toJSON() : s }).then(function () { ls.set(SUB, '1'); }); return; } if (adiado() && !voltouDoLogin) return; return api('/api/portal/vapid').then(function (k) { if (!k.chave) return; return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.chave) }).then(function (ns) { return api('/api/portal/push/inscrever', { vt: vt, subscription: ns.toJSON ? ns.toJSON() : ns }); }).then(function () { ls.set(SUB, '1'); }); }); }); }).catch(function () {});
      return;
    }
    if (Notification.permission === 'denied' || (isIOS && !standalone)) return;
    if (voltouDoLogin) { passoAvisos(vt, nome); return; }
    if (adiado()) return;
    var bar = document.createElement('div'); bar.className = 'pf-bar';
    bar.innerHTML = '<div style="flex:1"><b>Avisos desligados.</b> Ative pra receber os próximos pedidos e cotações neste celular.</div><button class="y" id="pf-bar-y">Ativar</button><button class="n" id="pf-bar-n">depois</button>';
    document.body.appendChild(bar);
    bar.querySelector('#pf-bar-n').onclick = function () { ls.set(ADIADO, String(Date.now() + 7 * 86400000)); bar.remove(); };
    bar.querySelector('#pf-bar-y').onclick = function () { bar.remove(); passoAvisos(vt, nome); };
  }

  // ── espera a página do vendedor carregar (P preenchido / #app com conteúdo) e decide o que mostrar ──
  function semLogin() {
    api('/api/portal/config').catch(function () { return {}; }).then(function (c) {
      var obrig = (tipo === 'cotacao' && !!c.exigeLogin) || (celular && !!c.exigeApp);
      if (obrig || !adiado()) passoLogin(obrig); else semFundo();
    });
  }
  function iniciar() {
    var vt = ls.get(KEY);
    if (vt) {
      api('/api/portal/eu?vt=' + encodeURIComponent(vt) + (standalone ? '&app=1' : '')).then(function (r) {
        ls.set(NOME, (r.vendedor && r.vendedor.nome) || '');
        if (!celular) { semFundo(); jaIdentificado(vt); return; }
        return api('/api/portal/config').catch(function () { return {}; }).then(function (c) {
          if (c.exigeApp && faltaApp(r.vendedor).length) { passoApp(vt, r.vendedor); return; }
          semFundo(); jaIdentificado(vt);
        });
      })
        .catch(function (e) { if (/inválida/i.test(e.message)) { ls.del(KEY); ls.del(SUB); ls.del(NOME); semLogin(); } else semFundo(); });
      return;
    }
    semLogin();
  }
  var tent = 0;
  (function esperar() {
    var app = document.getElementById('app'); var ok = app && app.children.length && !/não encontrad|link inválido/i.test(app.textContent || '');
    if (ok) { setTimeout(iniciar, ls.get(KEY) ? 900 : 100); return; }
    if (++tent < 40) setTimeout(esperar, 250); else semFundo();   // página não carregou (link inválido): não deixa a tela escura
  })();
})();
// App sempre na versão nova (Tiago, 13/11/26: "quero que ele atualize sozinho nos celulares dos fornecedores"): o servidor diz a versão
// no ar; mudou → a tela recarrega sozinha (ao voltar pro app e a cada 5 min), menos enquanto o vendedor está digitando num campo.
(function () {
  var v0 = null;
  function ver() {
    fetch('/api/portal/versao', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.v) return; if (v0 === null) { v0 = j.v; return; } if (j.v === v0) return;
      var a = document.activeElement; if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;   // digitando: espera a próxima checagem
      location.reload();
    }).catch(function () {});
  }
  ver(); setInterval(ver, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) ver(); });
})();
