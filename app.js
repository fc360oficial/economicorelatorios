firebase.initializeApp({
  apiKey: "AIzaSyAIOroUpio0sSBzTuhUqyJxz5bV7PX4KLw",
  authDomain: "economico-gestao.firebaseapp.com",
  projectId: "economico-gestao",
  storageBucket: "economico-gestao.firebasestorage.app",
  messagingSenderId: "650620659681",
  appId: "1:650620659681:web:4ca84bdb330d028e9f14a0"
});
var db = firebase.firestore();

// ── PWA: persistência offline do Firestore ──
db.enablePersistence({synchronizeTabs: true}).catch(function(err){
  if (err.code === 'failed-precondition') {
    console.warn('Offline: múltiplas abas abertas — persistência desativada nesta aba.');
  } else if (err.code === 'unimplemented') {
    console.warn('Offline: este navegador não suporta persistência.');
  }
});

// ── PWA: registrar Service Worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(function(err){
    console.warn('SW registro falhou:', err);
  });
}

// ── PWA: monitorar conexão ──
function atualizarStatusConexao() {
  var banner = document.getElementById('offline-banner');
  if (!banner) return;
  banner.style.display = navigator.onLine ? 'none' : 'block';
  // Empurra conteúdo para baixo quando offline
  var app = document.getElementById('app');
  if (app) app.style.paddingTop = navigator.onLine ? '' : '40px';
}
window.addEventListener('online',  atualizarStatusConexao);
window.addEventListener('offline', atualizarStatusConexao);
// Verifica na carga
document.addEventListener('DOMContentLoaded', atualizarStatusConexao);

// ===========================================
// DADOS BUILTIN DE CHECKLISTS
// ===========================================
var BUILTIN = { admin:[], operator:[], prevencao:[] };

// ===========================================
// STORAGE
// ===========================================
var UKEY = 'eco_users';
var INV_KEY = 'eco_inventario';
var PERD_KEY = 'eco_perdas';

function calcPontos(pct) {
  if (pct === 100) return 10;
  if (pct >= 80)  return 7;
  if (pct >= 60)  return 4;
  return 1;
}

function getLocalDate() {
  var d = new Date();
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}
function saveInvToFirebase() {
  var userId = S.currentUser ? S.currentUser.id : 'guest';
  var hoje = getLocalDate();
  db.collection('inventarios').doc(userId+'_'+hoje).set({
    userId: userId, date: hoje,
    operador: S.currentUser ? S.currentUser.nome : '--',
    items: S.invItems
  }).catch(function(){});
}

function savePerdaToFirebase(item) {
  var id = 'perd_'+Date.now()+'_'+(S.currentUser?S.currentUser.id:'guest');
  db.collection('perdas').doc(id).set(Object.assign({
    userId: S.currentUser ? S.currentUser.id : 'guest',
    operador: S.currentUser ? S.currentUser.nome : '--',
    dataHora: new Date().toLocaleDateString('pt-BR')+' '+item.hora
  }, item)).catch(function(){});
}

function loadInvFromFirebase(callback) {
  var userId = S.currentUser ? S.currentUser.id : 'guest';
  var hoje = getLocalDate();
  db.collection('inventarios').doc(userId+'_'+hoje).get().then(function(doc){
    if (doc.exists && doc.data().items) {
      S.invItems = doc.data().items;
    }
    if (callback) callback();
  }).catch(function(){ if (callback) callback(); });
}

function loadPerdasFromFirebase(callback) {
  var userId = S.currentUser ? S.currentUser.id : 'guest';
  var hoje = new Date().toLocaleDateString('pt-BR');
  db.collection('perdas').where('userId','==',userId).get().then(function(snap){
    S.perdaItems = snap.docs.map(function(d){return d.data();}).filter(function(p){
      return p.dataHora && p.dataHora.indexOf(hoje)===0;
    });
    if (callback) callback();
  }).catch(function(){ if (callback) callback(); });
}
var CLSTATE_PREFIX = 'eco_clstate_';

function getStateKey() {
  var userId = S.currentUser ? S.currentUser.id : 'guest';
  var today = getLocalDate();
  return CLSTATE_PREFIX + userId + '_' + today;
}

function loadCheckState() {
  try {
    var raw = localStorage.getItem(getStateKey());
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

function saveCheckState() {
  try {
    localStorage.setItem(getStateKey(), JSON.stringify(S.checkState));
    var userId = S.currentUser ? S.currentUser.id : 'guest';
    var today = getLocalDate();
    // Salvar no Firebase SEM as fotos (base64 e muito grande)
    var stateParaSalvar = {};
    Object.keys(S.checkState).forEach(function(k){
      // Ignorar chaves de foto (base64 enorme)
      if (k.indexOf('_foto_') >= 0) return;
      stateParaSalvar[k] = S.checkState[k];
    });
    db.collection('checkstates').doc(userId+'_'+today).set({
      userId: userId,
      date: today,
      localDate: getLocalDate(),
      state: JSON.stringify(stateParaSalvar)
    }).catch(function(){});
  } catch(e) {}
}

function loadCheckStateFromFirebase(callback) {
  var userId = S.currentUser ? S.currentUser.id : 'guest';
  var today = getLocalDate();
  db.collection('checkstates').doc(userId+'_'+today).get().then(function(doc){
    if (doc.exists && doc.data().state) {
      try {
        var fbState = JSON.parse(doc.data().state);
        // Merge with localStorage (Firebase wins)
        var localState = loadCheckState();
        S.checkState = Object.assign(localState, fbState);
        localStorage.setItem(getStateKey(), JSON.stringify(S.checkState));
      } catch(e) { S.checkState = loadCheckState(); }
    } else {
      S.checkState = loadCheckState();
    }
    if (callback) callback();
  }).catch(function(){
    S.checkState = loadCheckState();
    if (callback) callback();
  });
}
var CLKEY = 'eco_cl_custom';
var RESKEY = 'eco_resultados';
var PLANO_KEY = 'eco_planos';

// ===========================================
// SEGURANÇA — Hash de senhas (SHA-256)
// ===========================================
var ADMIN_PROFILE = {id:'admin',nome:'Administrador Central',email:'admin@economico.com',perfil:'admin',setor:'Central',cargo:'Admin do sistema',ativo:true};

function gerarSenhaAleatoria() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  var senha = '';
  for (var i = 0; i < 12; i++) {
    senha += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return senha;
}

function hashPassword(pwd) {
  var encoder = new TextEncoder();
  var data = encoder.encode(pwd);
  return crypto.subtle.digest('SHA-256', data).then(function(buf) {
    return Array.from(new Uint8Array(buf))
      .map(function(b){ return b.toString(16).padStart(2,'0'); })
      .join('');
  });
}

function isHashed(str) {
  return typeof str === 'string' && /^[0-9a-f]{64}$/.test(str);
}

// Mantido só para compatibilidade de estrutura — sem senha em texto claro
var DEFAULT_USERS = [];

function getUsers() {
  // Returns from cache (loaded from Firebase on login)
  var cached = S.usersCache && S.usersCache.length ? S.usersCache : null;
  if (!cached) {
    try {
      var raw = localStorage.getItem(UKEY);
      cached = raw ? JSON.parse(raw) : [];
    } catch(e) { cached = []; }
  }
  return cached;
}

function saveUsers(list) {
  S.usersCache = list;
  localStorage.setItem(UKEY, JSON.stringify(list));
  // Save all users to Firebase (admin included — sem senha em texto claro)
  list.forEach(function(u){
    db.collection('usuarios').doc(u.id).set(u).catch(function(){});
  });
}

function loadUsersFromFirebase(callback) {
  db.collection('usuarios').get().then(function(snap){
    var list = snap.docs.map(function(d){return d.data();});
    var hasAdmin = list.some(function(u){return u.id==='admin';});
    if (!hasAdmin) {
      // Primeiro boot: gera senha aleatória e cria admin no Firebase
      var senhaGerada = gerarSenhaAleatoria();
      hashPassword(senhaGerada).then(function(hash){
        var adminDoc = Object.assign({}, ADMIN_PROFILE, {senha: hash, _primeiroAcesso: true});
        db.collection('usuarios').doc('admin').set(adminDoc).catch(function(){});
        list.unshift(adminDoc);
        S.usersCache = list;
        localStorage.setItem(UKEY, JSON.stringify(list));
        // Exibe senha gerada — deve ser anotada e trocada imediatamente
        alert('PRIMEIRO ACESSO — ANOTE A SENHA ABAIXO:\n\nE-mail: admin@economico.com\nSenha: ' + senhaGerada + '\n\nTroque a senha imediatamente após o primeiro login!');
        if (callback) callback();
      });
      return;
    }
    S.usersCache = list;
    localStorage.setItem(UKEY, JSON.stringify(list));
    if (callback) callback();
  }).catch(function(){
    try {
      var raw = localStorage.getItem(UKEY);
      S.usersCache = raw ? JSON.parse(raw) : [];
    } catch(e){ S.usersCache = []; }
    if (callback) callback();
  });
}

// ── FIREBASE: Custom Checklists ──
function getCustomCLs() {
  // Returns from local cache (loaded async on login)
  return S.customCLsCache || [];
}

function saveCustomCLs(list) {
  S.customCLsCache = list;
  // Save each checklist to Firestore
  var batch = db.collection('checklists');
  // Delete removed ones
  batch.get().then(function(snap){
    var existingIds = snap.docs.map(function(d){return d.id;});
    var newIds = list.map(function(cl){return cl.id;});
    existingIds.forEach(function(id){
      if (newIds.indexOf(id)<0) db.collection('checklists').doc(id).delete();
    });
    list.forEach(function(cl){
      db.collection('checklists').doc(cl.id).set(cl);
    });
  }).catch(function(){
    // Fallback to localStorage
    localStorage.setItem(CLKEY, JSON.stringify(list));
  });
  localStorage.setItem(CLKEY, JSON.stringify(list));
}

function loadCustomCLsFromFirebase(callback) {
  db.collection('checklists').get().then(function(snap){
    var list = snap.docs.map(function(d){return d.data();});
    // Filter out builtin duplicates
    var allBuiltin = BUILTIN.admin.concat(BUILTIN.operator).concat(BUILTIN.prevencao);
    var builtinIds = allBuiltin.map(function(cl){return cl.id;});
    var builtinNames = allBuiltin.map(function(cl){return (cl.label||cl.nome||'').trim().toLowerCase();});
    list = list.filter(function(cl){
      if (builtinIds.indexOf(cl.id)>=0) return false;
      var nm=(cl.nome||cl.label||'').trim().toLowerCase();
      if (builtinNames.indexOf(nm)>=0) return false;
      return true;
    });
    S.customCLsCache = list;
    localStorage.setItem(CLKEY, JSON.stringify(list));
    if (callback) callback();
  }).catch(function(){
    // Fallback to localStorage
    try { S.customCLsCache = JSON.parse(localStorage.getItem(CLKEY)||'[]'); } catch(e){ S.customCLsCache=[]; }
    if (callback) callback();
  });
}

// ── FIREBASE: Resultados ──

// Isolamento de dados: admin/gerência veem tudo; outros veem só sua loja
function filterResultadosByLoja(resultados) {
  var u = S.currentUser;
  if (!u) return [];
  if (u.perfil === 'admin' || u.perfil === 'gerencia') return resultados;
  var myLoja = (u.loja || '').trim().toLowerCase();
  if (!myLoja) return resultados; // sem loja atribuída → não filtra (fallback seguro)
  var users = getUsers();
  return resultados.filter(function(r) {
    // Resultados novos já têm campo loja
    if (r.loja) return r.loja.trim().toLowerCase() === myLoja;
    // Resultados legados: busca loja pelo nome do operador
    var op = users.find(function(u2){ return u2.nome === r.operador; });
    return op ? (op.loja||'').trim().toLowerCase() === myLoja : false;
  });
}

function getResultados() {
  return filterResultadosByLoja(S.resultadosCache || []);
}

// Acesso bruto (sem filtro) — uso interno para salvar
function getAllResultados() {
  return S.resultadosCache || [];
}

function saveResultados(list) {
  S.resultadosCache = list;
  if (list.length > 0) {
    var ultimo = list[list.length-1];
    db.collection('resultados').doc(ultimo.id).set(ultimo).catch(function(){
      localStorage.setItem(RESKEY, JSON.stringify(list));
    });
  }
  localStorage.setItem(RESKEY, JSON.stringify(list));
}

function loadResultadosFromFirebase(callback) {
  db.collection('resultados').get().then(function(snap){
    var list = snap.docs.map(function(d){return d.data();});
    list.sort(function(a,b){return (a.dataHora||'') < (b.dataHora||'') ? -1 : 1;});
    S.resultadosCache = list;
    // Salva sem assinatura no localStorage para não estourar cota (base64 grande)
    try {
      var semAssina = list.map(function(r){ return r.assinatura ? Object.assign({},r,{assinatura:null}) : r; });
      localStorage.setItem(RESKEY, JSON.stringify(semAssina));
    } catch(e){}
    if (callback) callback();
  }).catch(function(){
    try { S.resultadosCache = JSON.parse(localStorage.getItem(RESKEY)||'[]'); } catch(e){ S.resultadosCache=[]; }
    if (callback) callback();
  });
}

function limparResultadosFirebase() {
  db.collection('resultados').get().then(function(snap){
    snap.docs.forEach(function(d){ d.ref.delete(); });
  });
}

function genId() { return 'id_'+Date.now()+'_'+Math.random().toString(36).substr(2,5); }

// ===========================================
// AGENDA OBRIGATÓRIA & NOTIFICAÇÕES
// ===========================================

// Retorna os checklists que são obrigatórios para HOJE nesta loja
function getChecklistsObrigatoriosHoje() {
  var diaSemana = new Date().getDay(); // 0=Dom … 6=Sáb
  var myLoja = S.currentUser ? (S.currentUser.loja || '').toLowerCase() : '';
  return getCustomCLs().filter(function(cl) {
    var dias = cl.diasObrigatorios || [];
    // sem agenda configurada = obrigatório todo dia
    if (dias.length && !dias.some(function(d){ return Number(d) === diaSemana; })) return false;
    // Filtra por loja se o checklist tiver loja configurada
    if (cl.loja && myLoja && cl.loja.toLowerCase() !== myLoja) return false;
    return true;
  });
}

// Retorna pendências: checklists que ainda não foram enviados hoje
function getPendencias() {
  var u = S.currentUser;
  var isManager = u && (u.perfil === 'admin' || u.perfil === 'gerencia');
  // Gerência/admin vê TODOS os checklists; operadores só os obrigatórios de hoje
  var lista = isManager ? getCustomCLs() : getChecklistsObrigatoriosHoje();
  if (!lista.length) return [];
  var hoje = new Date().toLocaleDateString('pt-BR');
  var agora = new Date();
  var horaAgora = agora.getHours() * 60 + agora.getMinutes();
  var resultados = getResultados();
  var pendencias = [];
  lista.forEach(function(cl) {
    var enviado = resultados.some(function(r){
      return r.checklistId === cl.id && r.dataHora && r.dataHora.indexOf(hoje) === 0 && !r.resetado;
    });
    if (!enviado) {
      var partes = (cl.horaLimite || '10:00').split(':');
      var horaLimMin = parseInt(partes[0]) * 60 + parseInt(partes[1] || 0);
      pendencias.push({
        cl: cl,
        atrasado: horaAgora > horaLimMin,
        horaLimite: cl.horaLimite || '10:00'
      });
    }
  });
  return pendencias;
}

// Abre painel de pendências
function abrirPendentes() {
  var u = S.currentUser;
  var isManager = u && (u.perfil === 'admin' || u.perfil === 'gerencia');
  var todos = isManager ? getCustomCLs() : getChecklistsObrigatoriosHoje();
  var hoje = new Date().toLocaleDateString('pt-BR');
  var resultados = getResultados();
  var resultadosHoje = resultados.filter(function(r){ return r.dataHora && r.dataHora.indexOf(hoje) === 0; });
  var pendencias = getPendencias();
  var lista = document.getElementById('pendentes-lista');
  if (!lista) return;
  var titulo = document.getElementById('pendentes-titulo');
  var debug = '<div style="font-size:11px;color:var(--t3);background:var(--gray);border-radius:8px;padding:8px 12px;margin-bottom:10px">'
    +'Checklists no sistema: <b>'+todos.length+'</b> · '
    +'Enviados hoje: <b>'+resultadosHoje.length+'</b> · '
    +'Pendentes: <b>'+pendencias.length+'</b>'
    +'</div>';
  if (!pendencias.length) {
    if (titulo) { titulo.textContent = '✅ Checklists em Dia'; titulo.style.color = 'var(--g)'; }
    lista.innerHTML = debug + '<div style="text-align:center;padding:20px;color:var(--g);font-weight:600">Todos os checklists de hoje foram enviados!</div>';
  } else {
    if (titulo) { titulo.textContent = '⚠️ Checklists Pendentes'; titulo.style.color = '#c0392b'; }
    lista.innerHTML = debug + pendencias.map(function(p){
      var cor = p.atrasado ? '#c0392b' : '#e67e22';
      var icone = p.atrasado ? '🔴' : '🟡';
      return '<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--gray);border-radius:10px;border-left:4px solid '+cor+'">'
        +'<div style="font-size:22px">'+icone+'</div>'
        +'<div style="flex:1">'
        +'<div style="font-weight:600;font-size:14px">'+p.cl.nome+'</div>'
        +'<div style="font-size:12px;color:var(--t3)">'+p.cl.setor+' · Turno: '+p.cl.turno+'</div>'
        +'<div style="font-size:12px;color:'+cor+';font-weight:600;margin-top:2px">'
        +(p.atrasado ? '⚠️ Atrasado — limite era '+p.horaLimite : '⏰ Limite: '+p.horaLimite)
        +'</div>'
        +'</div>'
        +'</div>';
    }).join('');
  }
  document.getElementById('modal-pendentes').style.display = 'flex';
}

// Atualiza o badge de alertas no sidebar
function atualizarBadgeAlertas() {
  var badge = document.getElementById('badge-alertas');
  if (!badge) return;
  // Só mostra para perfis que gerenciam
  var u = S.currentUser;
  if (!u || (u.perfil !== 'admin' && u.perfil !== 'gerencia')) return;
  var p = getPendencias().filter(function(x){ return x.atrasado; });
  var navBtn = document.getElementById('nav-alertas');
  if (navBtn) navBtn.style.display = 'flex';
  if (p.length > 0) {
    badge.style.display = 'flex';
    badge.textContent = p.length;
  } else {
    badge.style.display = 'none';
  }
}

// Pede permissão e envia notificação nativa (toast fallback se negada)
function notificarPendencias(pendencias) {
  if (!pendencias.length) return;
  var atrasados = pendencias.filter(function(p){ return p.atrasado; });
  if (!atrasados.length) return;
  var msg = atrasados.length === 1
    ? 'Checklist pendente: ' + atrasados[0].cl.nome
    : atrasados.length + ' checklists obrigatórios em atraso!';
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('⚠️ Cahu360 — Pendências', {body: msg, icon: './logo.png'});
  } else {
    showToast('⚠️ ' + msg, 6000);
  }
}

// Solicita permissão de notificação (chamado no login de gerência/admin)
function pedirPermissaoNotificacao() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Verificação periódica — chamada no login e a cada 15min
var _alertaInterval = null;
function iniciarVerificacaoPeriodica() {
  if (_alertaInterval) clearInterval(_alertaInterval);
  atualizarBadgeAlertas();
  _alertaInterval = setInterval(function(){
    atualizarBadgeAlertas();
    notificarPendencias(getPendencias());
  }, 15 * 60 * 1000); // a cada 15 minutos
}

// ===========================================
// STATE
// ===========================================
var S = {
  role: '',
  currentUser: null,
  checkState: {},
  invItems: [],
  perdaItems: [],
  historico: [],
  dashCharts: {},
  relCharts: {},
  customCLsCache: [],
  resultadosCache: [],
  usersCache: []
};

// ===========================================
// LOGIN / LOGOUT
// ===========================================
function doLogin() {
  var email = (document.getElementById('lEmail').value||'').trim().toLowerCase();
  var pass = document.getElementById('lPass').value;
  var err = document.getElementById('lErr');
  err.style.display = 'none';

  if (!email || !pass) {
    err.textContent = 'Preencha e-mail e senha.';
    err.style.color = 'var(--r)';
    err.style.display = 'block';
    return;
  }

  err.textContent = 'Entrando...';
  err.style.color = '#856404';
  err.style.display = 'block';

  // Calcula hash antes de consultar o Firebase
  hashPassword(pass).then(function(passHash){
    db.collection('usuarios').where('email','==',email).get().then(function(snap){
      if (snap.empty) {
        err.textContent = 'E-mail ou senha incorretos.';
        err.style.color = 'var(--r)';
        return;
      }
      var found = null;
      snap.docs.forEach(function(doc){
        var u = doc.data();
        if (!u.ativo) return;
        var match = false;
        if (isHashed(u.senha)) {
          // Senha já hasheada — comparação segura
          match = u.senha === passHash;
        } else {
          // Migração: senha ainda em texto claro → compara e atualiza
          match = u.senha === pass;
          if (match) {
            db.collection('usuarios').doc(u.id).update({senha: passHash}).catch(function(){});
            u.senha = passHash;
            // Atualiza cache local
            var idx = (S.usersCache||[]).findIndex(function(x){return x.id===u.id;});
            if (idx >= 0) S.usersCache[idx].senha = passHash;
          }
        }
        if (match) found = u;
      });
      if (!found) {
        err.textContent = 'E-mail ou senha incorretos.';
        err.style.color = 'var(--r)';
        return;
      }
      err.style.display = 'none';
      finalizarLogin(found);
    }).catch(function(e){
      err.textContent = 'Erro: ' + (e.message||'Verifique sua conexao.');
      err.style.color = 'var(--r)';
      err.style.display = 'block';
    });
  });
}

function finalizarLogin(found) {
  document.getElementById('lErr').style.display='none';
  S.role = found.perfil;
  S.currentUser = found;
  sessionStorage.setItem('eco_session', JSON.stringify(found));
  // Aviso de primeiro acesso: admin deve trocar a senha
  if (found._primeiroAcesso) {
    setTimeout(function(){
      showToast('⚠️ Primeiro acesso! Vá em Usuários e troque a senha do admin agora.', 8000);
    }, 2000);
  }
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('app').style.display='flex';
  setupRole();
  setDate();
  checkMobile();
  var isOpOrPrev2 = S.role==='operator'||S.role==='prevencao';

  // Mostrar tela de carregamento
  document.getElementById('app').style.opacity='0.6';

  function iniciarApp() {
    limparContagensAntigas();
    limparPlanosAntigos();
    // Load inv and perdas for this user/day
    loadInvFromFirebase(function(){
      loadPerdasFromFirebase(function(){
        renderInv();
        renderPerdas();
        updateDash();
      });
    });
    if (!isOpOrPrev2) initDashCharts();
    // buildCLTabs só após planilhas diárias carregadas para que _planilhaTemplates esteja populado
    loadPlanosFromFirebase(function() {
      loadPlanilhasDiarias(function() {
        buildCLTabs();
        renderAlertaPlanos();
      });
    });
    var hoje = new Date();
    var dEl = document.getElementById('cl-data-hoje');
    if (dEl) dEl.textContent = hoje.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
    document.getElementById('app').style.opacity='1';
    var lastPage = sessionStorage.getItem('eco_last_page');
    var pagesForRole = {
      admin:    ['dashboard','checklist','central','relatorios','usuarios','plano'],
      gerencia: ['dashboard','checklist','central','plano'],
      operator: ['checklist'],
      prevencao:['checklist']
    };
    var allowed = pagesForRole[S.role] || ['checklist'];
    if (lastPage && allowed.indexOf(lastPage) >= 0) {
      var sbEl = document.querySelector('.sb-item[onclick*="\''+lastPage+'\'"]');
      nav(lastPage, sbEl);
    } else if (isOpOrPrev2) {
      nav('checklist', document.querySelector('.sb-item[onclick*="\'checklist\'"]'));
    } else {
      nav('dashboard', document.querySelector('#nav-dashboard'));
      updateDash();
    }
  }

  // Carregar tudo do Firebase
  Promise.all([
    db.collection('usuarios').get().then(function(snap){
      var list = snap.docs.map(function(d){return d.data();});
      if (!list.some(function(u){return u.id==='admin';})) list.unshift(DEFAULT_USERS[0]);
      S.usersCache = list;
    }),
    db.collection('checklists').get().then(function(snap){
      var list = snap.docs.map(function(d){return d.data();});
      var allBuiltin = BUILTIN.admin.concat(BUILTIN.operator).concat(BUILTIN.prevencao);
      var bIds = allBuiltin.map(function(cl){return cl.id;});
      var bNames = allBuiltin.map(function(cl){return (cl.label||cl.nome||'').trim().toLowerCase();});
      list = list.filter(function(cl){
        if (bIds.indexOf(cl.id)>=0) return false;
        var nm=(cl.nome||cl.label||'').trim().toLowerCase();
        return bNames.indexOf(nm)<0;
      });
      S.customCLsCache = list;
    }),
    db.collection('resultados').get().then(function(snap){
      var list = snap.docs.map(function(d){return d.data();});
      list.sort(function(a,b){return (a.dataHora||'')<(b.dataHora||'')?-1:1;});
      S.resultadosCache = list;
      try {
        var semAssina = list.map(function(r){ return r.assinatura ? Object.assign({},r,{assinatura:null}) : r; });
        localStorage.setItem(RESKEY, JSON.stringify(semAssina));
      } catch(e){}
    }),
    (function(){
      var userId = found.id;
      var hoje = getLocalDate();
      return db.collection('checkstates').doc(userId+'_'+hoje).get().then(function(doc){
        if (doc.exists && doc.data().state && doc.data().localDate === getLocalDate()) {
          try { S.checkState = JSON.parse(doc.data().state); } catch(e){ S.checkState={}; }
        } else {
          S.checkState = {};
        }
      });
    })()
  ]).then(function(){
    iniciarApp();
  }).catch(function(err){
    console.error('Firebase erro:', err);
    // Tentar mesmo assim com o que carregou
    if (!S.usersCache) S.usersCache = [DEFAULT_USERS[0]];
    if (!S.customCLsCache) S.customCLsCache = [];
    if (!S.resultadosCache) S.resultadosCache = [];
    if (!S.checkState) S.checkState = {};
    iniciarApp();
  });
}

function doLogout() {
  sessionStorage.removeItem('eco_session');
  sessionStorage.removeItem('eco_last_page');
  document.getElementById('loginScreen').style.display='flex';
  document.getElementById('app').style.display='none';
  document.querySelectorAll('.sb-item').forEach(function(i){i.classList.remove('active');});
  document.querySelector('.sb-item').classList.add('active');
  Object.values(S.dashCharts).forEach(function(c){try{c.destroy();}catch(e){}});
  Object.values(S.relCharts).forEach(function(c){try{c.destroy();}catch(e){}});
  S = {role:'',currentUser:null,checkState:{},invItems:[],perdaItems:[],historico:[],dashCharts:{},relCharts:{}};
  _planosCache = null;
  document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active');});
  document.getElementById('panel-dashboard').classList.add('active');
}

function setupRole() {
  var r = S.role;
  var roleNames = {admin:'Administrador',gerencia:'Gerência de Loja',operator:'Operador',prevencao:'Aux. Prevenção'};
  var badgeCls = {admin:'badge-admin',gerencia:'badge-admin',operator:'badge-op',prevencao:'badge-prev'};
  var badgeTxt = {admin:'Administrador',gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
  document.getElementById('sbName').textContent = S.currentUser ? S.currentUser.nome : '-';
  document.getElementById('sbRole').textContent = roleNames[r]||r;
  var tb = document.getElementById('tbBadge');
  tb.className = 'badge '+(badgeCls[r]||'badge-op');
  tb.textContent = badgeTxt[r]||r;
  var isAdmin = r==='admin';
  var isAdmOrGer = r==='admin'||r==='gerencia';
  show('sb-adm-sec', isAdmOrGer);
  // Show/hide gerenciar tab in checklist
  var tabGer = document.getElementById('tab-gerenciar');
  if (tabGer) tabGer.style.display = isAdmOrGer ? '' : 'none';
  // Dashboard só para admin e gerencia
  var isOpOrPrev = r==='operator'||r==='prevencao';
  show('nav-dashboard', !isOpOrPrev);
  show('nav-central', isAdmin);
  show('nav-relat', isAdmin);
  show('nav-users', isAdmin);
  // Botão de alertas visível para admin e gerência
  show('nav-alertas', isAdmOrGer);
  show('nav-plano', isAdmOrGer);
  // Inicia verificação periódica de pendências para gestores
  if (isAdmOrGer) {
    pedirPermissaoNotificacao();
    // Aguarda carregar os dados antes de checar
    setTimeout(iniciarVerificacaoPeriodica, 3000);
  }
}

// ── Mobile sidebar ──
function toggleSidebar() {
  var sb = document.querySelector('.sb');
  var overlay = document.getElementById('sb-overlay');
  var isOpen = sb.classList.contains('open');
  if (isOpen) {
    sb.classList.remove('open');
    overlay.classList.remove('show');
    document.body.classList.remove('menu-open');
  } else {
    sb.classList.add('open');
    overlay.classList.add('show');
    document.body.classList.add('menu-open');
  }
}

function checkMobile() {
  var isMobile = window.innerWidth <= 768;
  var btn = document.getElementById('btn-hamburger');
  if (btn) btn.style.display = isMobile ? 'flex' : 'none';
  // On desktop ensure sidebar is visible
  if (!isMobile) {
    var sb = document.querySelector('.sb');
    if (sb) { sb.classList.remove('open'); sb.style.position = ''; }
    var overlay = document.getElementById('sb-overlay');
    if (overlay) overlay.classList.remove('show');
    document.body.classList.remove('menu-open');
  }
}

window.addEventListener('resize', checkMobile);

function show(id, v) {
  var el = document.getElementById(id);
  if (el) el.style.display = v ? '' : 'none';
}

function setDate() {
  var d = new Date();
  document.getElementById('tbDate').textContent = d.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
}

// ===========================================
// NAVEGAÇÃO
// ===========================================
var PAGE_TITLES = {
  dashboard:'Dashboard',checklist:'Checklist',inventario:'Inventário',
  perdas:'Lançar Perdas',central:'Central de Resultados',
  relatorios:'Relatórios',usuarios:'Cadastro de Usuários',
  plano:'Plano de Ação',
};

function nav(page, el) {
  sessionStorage.setItem('eco_last_page', page);
  // Close sidebar on mobile when navigating
  if (window.innerWidth <= 768) {
    var sb = document.querySelector('.sb');
    var overlay = document.getElementById('sb-overlay');
    if (sb) sb.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
    document.body.classList.remove('menu-open');
  }
  document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.sb-item').forEach(function(i){i.classList.remove('active');});
  var panel = document.getElementById('panel-'+page);
  if (panel) panel.classList.add('active');
  if (el) el.classList.add('active');
  document.getElementById('pageTitle').textContent = PAGE_TITLES[page]||page;
  if (page==='relatorios') {
    initRelCharts();
    // Reload resultados from Firebase before rendering
    loadResultadosFromFirebase(function(){
      renderRelatorios();
    });
  }
  if (page==='usuarios') {
    loadUsersFromFirebase(function(){ renderUsers(); });
  }
  if (page==='central') {
    // Reload resultados from Firebase before rendering central
    loadResultadosFromFirebase(function(){
      switchCentralTab('checklist', document.querySelector('#central-tabs .tab'));
    });
  }
  if (page==='plano') {
    loadPlanosFromFirebase(function(){
      renderPlanos(planoFiltroAtual||'aberto');
      atualizarBadgePlano();
      initFotoObrigToggle();
    });
  }
  updateDash();
}

// ===========================================
// CHECKLISTS - BUILTIN
// ===========================================
function setCLMode(mode, btn) {
  document.querySelectorAll('#cl-mode-tabs .tab').forEach(function(t){t.classList.remove('on');});
  btn.classList.add('on');
  var isAdmOrGer = S.role==='admin'||S.role==='gerencia';
  document.getElementById('cl-mode-executar').style.display = mode==='executar' ? 'block' : 'none';
  document.getElementById('cl-mode-gerenciar').style.display = mode==='gerenciar' ? 'block' : 'none';
  document.getElementById('cl-add-btn').style.display = (mode==='gerenciar' && isAdmOrGer) ? 'block' : 'none';
  if (mode==='gerenciar') renderCLGrid();
  // When switching to executar, sync fresh state from Firebase
  if (mode==='executar') {
    sincronizarEstadoFirebase();
  }
}

function sincronizarEstadoFirebase() {
  var userId = S.currentUser ? S.currentUser.id : null;
  if (!userId) return;
  var hoje = getLocalDate();

  // Load BOTH checkstate and resultados fresh from Firebase, then rebuild UI
  var promiseState = db.collection('checkstates').doc(userId+'_'+hoje).get()
    .then(function(doc){
      if (doc.exists && doc.data().state && doc.data().localDate === getLocalDate()) {
        try {
          var fbState = JSON.parse(doc.data().state);
          S.checkState = fbState;
          localStorage.setItem('eco_clstate_'+userId+'_'+hoje, JSON.stringify(fbState));
        } catch(e){ S.checkState = {}; }
      } else {
        S.checkState = {};
        localStorage.removeItem('eco_clstate_'+userId+'_'+hoje);
      }
    }).catch(function(){});

  var promiseResultados = db.collection('resultados').get().then(function(snap){
    var allResults = snap.docs.map(function(d){return d.data();});
    allResults.sort(function(a,b){return (a.dataHora||'') < (b.dataHora||'') ? -1 : 1;});
    S.resultadosCache = allResults;
    localStorage.setItem('eco_resultados', JSON.stringify(S.resultadosCache));
  }).catch(function(){});

  Promise.all([promiseState, promiseResultados]).then(function(){
    loadPlanilhasDiarias(function() { buildCLTabs(); renderAlertaPlanos(); updateDash(); });
  }).catch(function(){
    loadPlanilhasDiarias(function() { buildCLTabs(); renderAlertaPlanos(); updateDash(); });
  });
}

function getMyCLs() {
  var r = S.role;
  var base = [];
  if (r==='admin') base = BUILTIN.admin.concat(BUILTIN.operator).concat(BUILTIN.prevencao);
  else if (r==='gerencia') base = BUILTIN.admin.concat(BUILTIN.operator);
  else if (r==='operator') base = BUILTIN.operator.slice();
  else if (r==='prevencao') base = BUILTIN.prevencao.slice();
  var custom = getCustomCLs().filter(function(cl){
    if (r==='admin') return true;
    if (cl.perfil==='todos') return true;
    return cl.perfil===r;
  }).map(function(cl){
    return {id:cl.id,label:cl.nome,desc:cl.desc||cl.setor+' - '+(cl.turno||''),itens:cl.itens,setor:cl.setor};
  });
  return base.concat(custom);
}

function buildCLTabs() {
  var lists = getMyCLs();
  var tabsEl = document.getElementById('cl-tabs');
  var contentEl = document.getElementById('cl-content');
  tabsEl.innerHTML = '';
  contentEl.innerHTML = '';
  if (!lists.length) { contentEl.innerHTML='<p style="color:var(--t3)">Nenhum checklist disponível.</p>'; return; }
  lists.forEach(function(cl,idx){
    cl.itens.forEach(function(item){
      var key = cl.id+'_'+item.t;
      if (S.checkState[key]===undefined) S.checkState[key]=false;
    });
    // Note: checkState already loaded from localStorage - only set undefined keys
    var tab = document.createElement('div');
    tab.className = 'tab'+(idx===0?' on':'');
    tab.textContent = cl.label;
    tab.onclick = (function(id){ return function(){ switchCLTab(id); }; })(cl.id);
    tabsEl.appendChild(tab);
    var block = document.createElement('div');
    block.id = 'cl-block-'+cl.id;
    block.style.display = idx===0?'block':'none';
    block.innerHTML = buildCLBlock(cl);
    contentEl.appendChild(block);
  });
}

function buildCLBlock(cl) {
  var done = cl.itens.filter(function(i){ return S.checkState[cl.id+'_'+i.t]; }).length;
  var total = cl.itens.length;
  var pct = total ? Math.round(done/total*100) : 0;
  var jaConcluido = jaEnviouHoje(cl.id);
  // Verifica se algum item crítico está reprovado (simNao=nao ou checkbox=false)
  var itemCriticoReprovado = cl.itens.some(function(item, i){
    if (!item.critico) return false;
    var val = S.checkState[cl.id+'_'+item.t];
    if ((item.tipo||'checkbox') === 'simNao') return val === 'nao';
    return !val;
  });

  var items = cl.itens.map(function(item,i){
    var key = cl.id + '_' + item.t;
    var on = S.checkState[key] ? true : false;
    var fotoHtml = '';
    if (item.foto && item.foto !== 'none') {
      var hasFotoAntes = !!S.checkState[cl.id+'_foto_antes_'+i];
      var hasFotoDepois = !!S.checkState[cl.id+'_foto_depois_'+i];

      if (item.foto === 'antes_depois') {
        // Fluxo sequencial: primeiro ANTES, depois DEPOIS
        if (!hasFotoAntes) {
          // Estado 1: aguardando foto ANTES
          fotoHtml = '<div style="flex-shrink:0">'
            + '<label style="cursor:pointer;display:block" onclick="event.stopPropagation()">'
            + '<input type="file" accept="image/*" capture="environment" style="display:none" onchange="salvarFotoTipo(\''+cl.id+'\','+i+',\'antes\',this)">'
            + '<span style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:7px 12px;border-radius:8px;background:#fdecea;border:1.5px solid #fac5c0;color:var(--r);white-space:nowrap">Enviar foto ANTES</span>'
            + '</label>'
            + '<div style="font-size:10px;color:var(--t3);margin-top:3px;text-align:center">1 de 2</div>'
            + '</div>';
        } else if (!hasFotoDepois) {
          // Estado 2: antes ok, aguardando DEPOIS
          var srcAntes = S.checkState[cl.id+'_foto_antes_'+i];
          fotoHtml = '<div style="flex-shrink:0">'
            + '<img src="'+srcAntes+'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;border:2px solid var(--g2);display:block;margin-bottom:4px;cursor:pointer" onclick="abrirFotoFull([{src:\''+srcAntes+'\',label:\'ANTES\'}],0);event.stopPropagation()" title="Foto ANTES enviada"/>'
            + '<label style="cursor:pointer;display:block" onclick="event.stopPropagation()">'
            + '<input type="file" accept="image/*" capture="environment" style="display:none" onchange="salvarFotoTipo(\''+cl.id+'\','+i+',\'depois\',this)">'
            + '<span style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:7px 12px;border-radius:8px;background:#fef9e7;border:1.5px solid #f0d060;color:var(--am);white-space:nowrap">Enviar foto DEPOIS</span>'
            + '</label>'
            + '<div style="font-size:10px;color:var(--t3);margin-top:3px;text-align:center">2 de 2</div>'
            + '</div>';
        } else {
          // Estado 3: ambas as fotos enviadas - item completo
          var srcA = S.checkState[cl.id+'_foto_antes_'+i];
          var srcD = S.checkState[cl.id+'_foto_depois_'+i];
          fotoHtml = '<div style="flex-shrink:0;display:flex;gap:4px">'
            + '<div style="text-align:center">'
            + '<img src="'+srcA+'" style="width:36px;height:36px;object-fit:cover;border-radius:6px;border:2px solid var(--g2);cursor:pointer" onclick="abrirFotoFull([{src:\''+srcA+'\',label:\'ANTES\'},{src:\''+srcD+'\',label:\'DEPOIS\'}],0);event.stopPropagation()"/>'
            + '<div style="font-size:9px;color:var(--g);margin-top:1px">Antes</div>'
            + '</div>'
            + '<div style="text-align:center">'
            + '<img src="'+srcD+'" style="width:36px;height:36px;object-fit:cover;border-radius:6px;border:2px solid var(--g2);cursor:pointer" onclick="abrirFotoFull([{src:\''+srcA+'\',label:\'ANTES\'},{src:\''+srcD+'\',label:\'DEPOIS\'}],1);event.stopPropagation()"/>'
            + '<div style="font-size:9px;color:var(--g);margin-top:1px">Depois</div>'
            + '</div>'
            + '</div>';
        }
      } else {
        // So foto depois
        var hasFoto2 = hasFotoDepois || !!S.checkState[cl.id+'_foto_'+i];
        if (!hasFoto2) {
          fotoHtml = '<div style="flex-shrink:0">'
            + '<label style="cursor:pointer;display:block" onclick="event.stopPropagation()">'
            + '<input type="file" accept="image/*" capture="environment" style="display:none" onchange="salvarFotoTipo(\''+cl.id+'\','+i+',\'depois\',this)">'
            + '<span style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:7px 12px;border-radius:8px;background:#fdecea;border:1.5px solid #fac5c0;color:var(--r);white-space:nowrap">Enviar foto</span>'
            + '</label>'
            + '</div>';
        } else {
          var srcF = S.checkState[cl.id+'_foto_depois_'+i] || S.checkState[cl.id+'_foto_'+i];
          fotoHtml = '<div style="flex-shrink:0">'
            + '<img src="'+srcF+'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;border:2px solid var(--g2);cursor:pointer" onclick="abrirFotoFull([{src:\''+srcF+'\',label:\'Foto\'}],0);event.stopPropagation()"/>'
            + '<div style="font-size:9px;color:var(--g);text-align:center;margin-top:2px">OK</div>'
            + '</div>';
        }
      }
    }
    var tipo = item.tipo || 'checkbox';
    var val = S.checkState[cl.id+'_'+item.t];
    var itemBg = !on ? '#fff' : (tipo==='simNao' && val==='nao') ? 'var(--r2)' : 'var(--g3)';
    var txtStyle = (tipo==='checkbox' && on) ? 'text-decoration:line-through;color:var(--t3)' : 'color:var(--t)';
    // Left control
    var leftCtrl;
    if (tipo === 'checkbox') {
      leftCtrl = '<div class="chkbox'+(on?' on':'')+'" id="chk-'+cl.id+'-'+i+'"'
        +(jaConcluido?' style="cursor:not-allowed;opacity:.6;flex-shrink:0;margin-top:1px">':' onclick="toggleCL(\''+cl.id+'\','+i+')" style="cursor:pointer;flex-shrink:0;margin-top:1px">')+(on?'ok':'')+'</div>';
    } else {
      var dotC = !on?'var(--gray3)':(tipo==='simNao'&&val==='nao')?'var(--r)':'var(--g2)';
      leftCtrl = '<div style="width:14px;height:14px;border-radius:50%;background:'+dotC+';flex-shrink:0;margin-top:4px"></div>';
    }
    // Below-text controls
    var belowHtml = '';
    if (tipo === 'simNao') {
      var isSim=val==='sim', isNao=val==='nao';
      var justifVal = S.checkState[cl.id+'_justif_'+i] || '';
      if (!jaConcluido) {
        belowHtml = '<div style="display:flex;gap:6px;margin-top:8px" onclick="event.stopPropagation()">'
          +'<button onclick="setSimNao(\''+cl.id+'\','+i+',\'sim\')" style="padding:5px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1.5px solid '+(isSim?'var(--g2)':'var(--gray3)')+';background:'+(isSim?'var(--g3)':'#fff')+';color:'+(isSim?'var(--g)':'var(--t2)')+'">✓ Sim</button>'
          +'<button onclick="setSimNao(\''+cl.id+'\','+i+',\'nao\')" style="padding:5px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1.5px solid '+(isNao?'var(--r)':'var(--gray3)')+';background:'+(isNao?'var(--r2)':'#fff')+';color:'+(isNao?'var(--r)':'var(--t2)')+'">✗ Não</button>'
          +'</div>';
        if (isNao) {
          belowHtml += '<textarea placeholder="Justifique a não-conformidade (obrigatório)..." onblur="salvarJustificativa(\''+cl.id+'\','+i+',this.value)" style="width:100%;margin-top:8px;padding:8px 10px;border:1.5px solid var(--r);border-radius:8px;font-size:12px;font-family:inherit;resize:vertical;min-height:54px;color:var(--t)">'+justifVal+'</textarea>';
        }
      } else {
        var snLabel=val==='sim'?'✓ Sim':val==='nao'?'✗ Não':'—';
        var snColor=val==='sim'?'var(--g)':val==='nao'?'var(--r)':'var(--t3)';
        belowHtml='<div style="margin-top:6px;font-size:12px;font-weight:700;color:'+snColor+'">'+snLabel+'</div>';
        if (isNao && justifVal) belowHtml+='<div style="margin-top:4px;padding:6px 10px;background:var(--r2);border-radius:6px;font-size:12px;color:var(--r)">'+justifVal+'</div>';
      }
    } else if (tipo === 'nota') {
      var notaVal=parseInt(val)||0;
      if (!jaConcluido) {
        belowHtml='<div style="display:flex;gap:4px;margin-top:8px" onclick="event.stopPropagation()">'
          +[1,2,3,4,5].map(function(n){var a=n<=notaVal;return '<button onclick="setNota(\''+cl.id+'\','+i+','+n+')" style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;border:1.5px solid '+(a?'var(--dk2)':'var(--gray3)')+';background:'+(a?'var(--dk)':'#fff')+';color:'+(a?'#111':'var(--t3)')+'">'+n+'</button>';}).join('')
          +'</div>';
      } else if (notaVal) {
        belowHtml='<div style="display:flex;gap:3px;margin-top:6px">'
          +[1,2,3,4,5].map(function(n){return '<span style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:5px;font-size:11px;font-weight:700;background:'+(n<=notaVal?'var(--dk)':'var(--gray2)')+';color:'+(n<=notaVal?'#111':'var(--t3)')+'">'+n+'</span>';}).join('')
          +'</div>';
      }
    } else if (tipo === 'texto') {
      if (!jaConcluido) {
        belowHtml='<textarea placeholder="Digite a resposta..." onblur="saveTextoItem(\''+cl.id+'\','+i+',this.value)" style="width:100%;margin-top:8px;padding:8px 10px;border:1.5px solid var(--gray2);border-radius:8px;font-size:12px;font-family:inherit;resize:vertical;min-height:60px;color:var(--t)">'+(val&&typeof val==='string'?val:'')+'</textarea>';
      } else if (val) {
        belowHtml='<div style="margin-top:6px;padding:7px 10px;background:var(--gray);border-radius:7px;font-size:12px;color:var(--t2)">'+val+'</div>';
      }
    } else if (tipo === 'planilha') {
      var userLoja = S.currentUser ? (S.currentUser.loja || '') : '';
      var modoPlanilha = item.modoPlanilha || 'fixa';
      var hoje = new Date().toISOString().slice(0, 10);
      var produtos = [];
      if (modoPlanilha === 'diaria') {
        var isAdmGer = S.role === 'admin' || S.role === 'gerencia';
        if (isAdmGer) {
          // Central: mostra uploads já feitos hoje + interface para upload por loja
          var lojasHoje = Object.keys(_planilhaTemplates).filter(function(k) {
            return k.indexOf(cl.id + '_' + i + '_') === 0;
          }).map(function(k) { return k.replace(cl.id + '_' + i + '_', ''); });
          var admHtml = '<div style="margin-top:10px;background:var(--gray);border-radius:8px;padding:10px">'
            +'<div style="font-size:12px;font-weight:600;color:var(--t2);margin-bottom:6px">📅 Planilha diária — upload por loja</div>';
          if (lojasHoje.length) {
            admHtml += lojasHoje.map(function(lj) {
              var cnt = (_planilhaTemplates[cl.id+'_'+i+'_'+lj]||[]).length;
              return '<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:#fff;border-radius:6px;margin-bottom:4px;font-size:12px">'
                +'<span style="flex:1">🏪 '+lj+' — '+cnt+' produtos</span>'
                +'<input type="file" id="diaria-upd-'+cl.id+'-'+i+'-'+lj+'" accept=".csv,.txt" style="display:none" onchange="uploadDiariaPorLoja(\''+cl.id+'\','+i+',\''+lj+'\',this)" onclick="event.stopPropagation()">'
                +'<button class="btn btn-s btn-sm" onclick="event.stopPropagation();document.getElementById(\'diaria-upd-'+cl.id+'-'+i+'-'+lj+'\').click()" style="font-size:10px">🔄 Atualizar</button>'
                +'</div>';
            }).join('');
          }
          admHtml += '<div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">'
            +'<input type="text" id="diaria-loja-'+cl.id+'-'+i+'" placeholder="Nome da loja" onclick="event.stopPropagation()" style="flex:1;min-width:110px;padding:6px 8px;border:1.5px solid var(--gray2);border-radius:6px;font-size:12px;font-family:inherit">'
            +'<input type="file" id="diaria-file-'+cl.id+'-'+i+'" accept=".csv,.txt" style="display:none" onchange="uploadDiariaPorLoja(\''+cl.id+'\','+i+',null,this)" onclick="event.stopPropagation()">'
            +'<button class="btn btn-p btn-sm" onclick="event.stopPropagation();document.getElementById(\'diaria-file-'+cl.id+'-'+i+'\').click()">+ Carregar loja</button>'
            +'</div>'
            +'</div>';
          belowHtml = admHtml;
        } else {
          // Operador: busca produtos da sua loja no template do dia
          produtos = _planilhaTemplates[cl.id + '_' + i + '_' + userLoja] || [];
          if (!produtos.length) {
            belowHtml = '<div style="margin-top:10px;padding:12px;background:var(--gray);border-radius:8px;text-align:center;font-size:12px;color:var(--t3)">⏳ Aguardando planilha de hoje (Central ainda não fez o upload)</div>';
            S.checkState[cl.id+'_'+item.t] = '';
          }
        }
      } else {
        produtos = item.lojas ? (item.lojas[userLoja] || []) : (item.produtos || []);
      }
      if (produtos.length) {
        var filledCount = produtos.filter(function(p) {
          var v = S.checkState[cl.id+'_qty_'+i+'_'+p.codigo];
          return v !== undefined && v !== '';
        }).length;
        var tHead = '<table style="width:100%;border-collapse:collapse;font-size:12px">'
          +'<thead><tr style="background:var(--gray)">'
          +'<th style="padding:5px 7px;text-align:left;font-weight:600;color:var(--t2)">Código</th>'
          +'<th style="padding:5px 7px;text-align:left;font-weight:600;color:var(--t2)">Descrição</th>'
          +'<th style="padding:5px 7px;text-align:left;font-weight:600;color:var(--t2)">Setor</th>'
          +'<th style="padding:5px 7px;text-align:center;font-weight:600;color:var(--t2)">Qtd</th>'
          +'</tr></thead><tbody>';
        if (!jaConcluido) {
          belowHtml = '<div style="margin-top:10px;overflow-x:auto">'
            + tHead
            + produtos.map(function(p) {
                var qtdVal = S.checkState[cl.id+'_qty_'+i+'_'+p.codigo];
                if (qtdVal === undefined) qtdVal = '';
                var filled = qtdVal !== '';
                return '<tr style="border-bottom:1px solid var(--gray2)">'
                  +'<td style="padding:5px 7px;color:var(--t2);font-size:11px">'+p.codigo+'</td>'
                  +'<td style="padding:5px 7px;color:var(--t)">'+p.descricao+'</td>'
                  +'<td style="padding:5px 7px;color:var(--t2)">'+(p.setor||'—')+'</td>'
                  +'<td style="padding:5px 7px;text-align:center">'
                  +'<input type="number" min="0" inputmode="numeric" value="'+qtdVal+'"'
                  +' onchange="salvarQuantidade(\''+cl.id+'\','+i+',\''+p.codigo+'\',this.value)"'
                  +' onclick="event.stopPropagation()"'
                  +' style="width:62px;padding:4px 6px;border:1.5px solid '+(filled?'var(--g2)':'var(--gray2)')+';border-radius:6px;font-size:12px;text-align:center;font-weight:'+(filled?'700':'400')+'">'
                  +'</td></tr>';
              }).join('')
            + '</tbody></table></div>'
            + '<div style="font-size:11px;color:var(--t3);margin-top:5px">'+filledCount+'/'+produtos.length+' produtos preenchidos</div>';
        } else {
          belowHtml = '<div style="margin-top:10px;overflow-x:auto">'
            + tHead
            + produtos.map(function(p) {
                var qtdVal = S.checkState[cl.id+'_qty_'+i+'_'+p.codigo] || '—';
                return '<tr style="border-bottom:1px solid var(--gray2)">'
                  +'<td style="padding:5px 7px;color:var(--t2);font-size:11px">'+p.codigo+'</td>'
                  +'<td style="padding:5px 7px;color:var(--t)">'+p.descricao+'</td>'
                  +'<td style="padding:5px 7px;color:var(--t2)">'+(p.setor||'—')+'</td>'
                  +'<td style="padding:5px 7px;text-align:center;font-weight:700;color:var(--g)">'+qtdVal+'</td>'
                  +'</tr>';
              }).join('')
            + '</tbody></table></div>';
        }
      }
    }
    return '<div id="cli-' + cl.id + '-' + i + '" style="display:flex;align-items:flex-start;gap:12px;padding:13px 14px;border:1px solid var(--gray2);border-radius:10px;background:' + itemBg + '">'
      + leftCtrl
      + '<div style="flex:1;min-width:0">'
      + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
      + '<div style="font-size:13px;font-weight:500;line-height:1.4;' + txtStyle + '">' + item.t + '</div>'
      + (item.critico ? '<span style="font-size:10px;font-weight:800;color:var(--r);background:var(--r2);padding:1px 7px;border-radius:20px;border:1px solid var(--r);white-space:nowrap">⚠️ CRÍTICO</span>' : '')
      + '</div>'
      + (item.obs ? '<div style="font-size:11px;color:var(--t3);margin-top:3px">' + item.obs + '</div>' : '')
      + belowHtml
      + '</div>'
      + fotoHtml
      + '</div>';
  }).join('');
  var empty = !total ? '<div style="text-align:center;padding:32px;color:var(--t3);font-size:13px">Nenhum item neste checklist.</div>' : '';
  var criticoBanner = (!jaConcluido && itemCriticoReprovado)
    ? '<div style="display:flex;align-items:center;gap:10px;background:var(--r2);border:1.5px solid var(--r);border-radius:10px;padding:12px 16px;margin-bottom:14px">'
      + '<span style="font-size:22px">🚨</span>'
      + '<div><div style="font-size:13px;font-weight:800;color:var(--r)">Inspeção Reprovada!</div>'
      + '<div style="font-size:12px;color:var(--r)">Um item crítico foi marcado como Não conforme. O envio registrará esta inspeção como REPROVADA.</div></div>'
      + '</div>'
    : '';
  var envioBanner = jaConcluido
    ? '<div style="display:flex;align-items:center;gap:10px;background:#e8f5ee;border:1px solid #a8d5b5;border-radius:10px;padding:12px 16px;margin-bottom:14px">'
      + '<span style="font-size:20px">✅</span>'
      + '<div><div style="font-size:13px;font-weight:600;color:var(--g)">Checklist já enviado hoje!</div>'
      + '<div style="font-size:12px;color:var(--g)">Você já enviou este checklist hoje. Os itens não podem mais ser alterados.</div></div>'
      + '</div>'
    : '';
  var clId = cl.id;
  var clLabel = cl.label;
  var clDesc = cl.desc || '';
  var clSetor = cl.setor || '';
  var clTurno = cl.turno || '';
  var pctColor = pct===100 ? 'var(--g)' : pct>=50 ? 'var(--am)' : 'var(--r)';
  return '<div style="background:#fff;border:1px solid var(--gray2);border-radius:14px;padding:20px;margin-bottom:16px;box-shadow:var(--sh)">'
    + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">'
    + '<div>'
    + '<div style="font-family:\'Syne\',sans-serif;font-size:18px;font-weight:800;color:var(--t);margin-bottom:4px">' + clLabel + '</div>'
    + (clDesc ? '<div style="font-size:13px;color:var(--t2);line-height:1.5;margin-bottom:6px">' + clDesc + '</div>' : '')
    + criticoBanner
    + envioBanner
    + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
    + (clSetor ? '<span style="font-size:11px;padding:2px 9px;border-radius:20px;background:var(--g3);color:var(--g);font-weight:600">' + clSetor + '</span>' : '')
    + (clTurno ? '<span style="font-size:11px;padding:2px 9px;border-radius:20px;background:var(--gray);color:var(--t3)">' + clTurno + '</span>' : '')
    + '</div></div>'
    + '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">'
    + (jaConcluido ? '<button class="btn btn-s btn-sm" disabled style="opacity:.5;cursor:not-allowed">Ja enviado</button>' : '<button class="btn btn-p btn-sm" onclick="enviarCL(\'' + clId + '\',\'' + clLabel.replace(/'/g, '') + '\')">Enviar</button>')
    + (S.role==='admin' ? '<button class="btn btn-s btn-sm" onclick="abrirModalReset(\'' + clId + '\')" style="margin-top:4px">Resetar itens</button>' : '')
    + '</div></div>'
    + '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--gray);border-radius:8px;margin-bottom:14px">'
    + '<span style="font-size:12px;font-weight:600;color:var(--t2)">' + done + '/' + total + ' concluídos</span>'
    + '<div class="cl-prog-bar" style="flex:1"><div class="cl-prog-fill" id="pf-' + clId + '" style="width:' + pct + '%"></div></div>'
    + '<span style="font-size:13px;font-weight:700;color:' + pctColor + '" id="pt-' + clId + '">' + pct + '%</span>'
    + '</div>'
    + '<div style="display:flex;flex-direction:column;gap:8px" id="clw-' + clId + '">' + items + empty + '</div>'
    + '</div>';
}

function switchCLTab(id) {
  var lists = getMyCLs();
  document.querySelectorAll('#cl-tabs .tab').forEach(function(t,i){
    t.classList.toggle('on', lists[i] && lists[i].id===id);
  });
  lists.forEach(function(cl){
    var b = document.getElementById('cl-block-'+cl.id);
    if (b) b.style.display = cl.id===id ? 'block' : 'none';
  });
}

function toggleCL(clId, idx) {
  if (jaEnviouHoje(clId)) return;
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  var key = clId+'_'+cl.itens[idx].t;
  S.checkState[key] = !S.checkState[key];
  var on = S.checkState[key];
  var itemEl = document.getElementById('cli-'+clId+'-'+idx);
  var box = document.getElementById('chk-'+clId+'-'+idx);
  if (itemEl) itemEl.style.background = on ? 'var(--g3)' : '#fff';
  if (box) {
    box.className = 'chkbox'+(on?' on':'');
    box.textContent = on ? 'ok' : '';
  }
  var txtEl = itemEl ? itemEl.querySelector('[style*="font-weight:500"]') : null;
  if (txtEl) txtEl.style.cssText = on ? 'font-size:13px;font-weight:500;line-height:1.4;text-decoration:line-through;color:var(--t3)' : 'font-size:13px;font-weight:500;line-height:1.4;color:var(--t)';
  saveCheckState();
  updateCLProg(cl);
  updateDash();
}

function setSimNao(clId, idx, val) {
  if (jaEnviouHoje(clId)) return;
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  S.checkState[clId+'_'+cl.itens[idx].t] = val;
  saveCheckState();
  var block = document.getElementById('cl-block-'+clId);
  if (block) block.innerHTML = buildCLBlock(cl);
  updateCLProg(cl);
  updateDash();
}

function setNota(clId, idx, val) {
  if (jaEnviouHoje(clId)) return;
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  S.checkState[clId+'_'+cl.itens[idx].t] = val;
  saveCheckState();
  var block = document.getElementById('cl-block-'+clId);
  if (block) block.innerHTML = buildCLBlock(cl);
  updateCLProg(cl);
  updateDash();
}

function saveTextoItem(clId, idx, val) {
  if (jaEnviouHoje(clId)) return;
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  S.checkState[clId+'_'+cl.itens[idx].t] = val.trim() || false;
  saveCheckState();
  updateCLProg(cl);
  updateDash();
}

function salvarJustificativa(clId, idx, val) {
  S.checkState[clId+'_justif_'+idx] = val.trim() || '';
  saveCheckState();
}

function salvarFoto(clId, idx, input) {
  salvarFotoTipo(clId, idx, 'depois', input);
}

function salvarFotoTipo(clId, idx, tipo, input) {
  if (!input.files || !input.files[0]) return;

  // Comprimir imagem antes de salvar
  var img = new Image();
  var objectUrl = URL.createObjectURL(input.files[0]);
  img.onload = function() {
    var canvas = document.createElement('canvas');
    var MAX = 800;
    var w = img.width, h = img.height;
    if (w > MAX) { h = Math.round(h*MAX/w); w = MAX; }
    if (h > MAX) { w = Math.round(w*MAX/h); h = MAX; }
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    var base64 = canvas.toDataURL('image/jpeg', 0.6);
    URL.revokeObjectURL(objectUrl);

    var fotoKey = clId+'_foto_'+tipo+'_'+idx;
    S.checkState[fotoKey] = base64;

    // Salvar foto separado no Firebase (nao no checkstate)
    var userId = S.currentUser ? S.currentUser.id : 'guest';
    var today = getLocalDate();
    var fotoDocId = userId+'_'+today+'_'+clId+'_'+tipo+'_'+idx;
    db.collection('fotos').doc(fotoDocId).set({
      userId: userId, date: today, clId: clId,
      tipo: tipo, idx: idx, base64: base64
    }).catch(function(e){ console.log('Erro ao salvar foto:', e); });

    var cl = getMyCLs().find(function(cc){return cc.id===clId;});
    if (cl && cl.itens[idx]) {
      if (cl.itens[idx].foto === 'antes_depois') {
        var hasBoth = !!S.checkState[clId+'_foto_antes_'+idx] && !!S.checkState[clId+'_foto_depois_'+idx];
        if (hasBoth) S.checkState[clId+'_'+cl.itens[idx].t] = true;
      }
      if (cl.itens[idx].foto === 'depois') {
        S.checkState[clId+'_'+cl.itens[idx].t] = true;
      }
    }

    saveCheckState();
    var b = document.getElementById('cl-block-'+clId);
    if (b && cl) b.innerHTML = buildCLBlock(cl);
    updateDash();
  };
  img.src = objectUrl;
}

function updateCLProg(cl) {
  var done = cl.itens.filter(function(i){return S.checkState[cl.id+'_'+i.t];}).length;
  var total = cl.itens.length;
  var pct = total ? Math.round(done/total*100) : 0;
  var f = document.getElementById('pf-'+cl.id);
  var t = document.getElementById('pt-'+cl.id);
  if (f) f.style.width = pct+'%';
  if (t) t.textContent = done+'/'+total+' - '+pct+'%';
}

var pendingResetClId = null;
var pendingResetItens = [];

function abrirModalReset(clId) {
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  pendingResetClId = clId;
  pendingResetItens = [];
  document.getElementById('reset-cl-nome').textContent = cl.label;
  // Show ALL items - admin resets for OTHER users, not just what admin marked
  var todosItens = cl.itens;
  resetItemsRef = todosItens;
  var wrap = document.getElementById('reset-itens-wrap');
  wrap.innerHTML = todosItens.map(function(item,i){
    return '<div style="display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--gray2);border-radius:8px;cursor:pointer;background:#fff;transition:background .15s" id="ri-'+i+'" onclick="toggleResetItem('+i+')">'
      +'<div class="chkbox" id="ri-chk-'+i+'" style="flex-shrink:0"></div>'
      +'<div style="flex:1">'
      +'<div style="font-size:13px;font-weight:500">'+item.t+'</div>'
      +(item.obs ? '<div style="font-size:11px;color:var(--t3);margin-top:2px">'+item.obs+'</div>' : '')
      +'</div>'
      +'</div>';
  }).join('');
  document.getElementById('reset-err').style.display='none';
  document.getElementById('modal-reset').style.display='flex';
}

// Store items for reset selection
var resetItemsRef = [];

function toggleResetItem(i) {
  var item = resetItemsRef[i];
  if (!item) return;
  var el = document.getElementById('ri-'+i);
  var chk = document.getElementById('ri-chk-'+i);
  var texto = item.t;
  var idx = pendingResetItens.indexOf(texto);
  if (idx >= 0) {
    pendingResetItens.splice(idx,1);
    el.style.background='#fff';
    chk.className='chkbox';
    chk.style.background='';
    chk.style.borderColor='';
    chk.textContent='';
  } else {
    pendingResetItens.push(texto);
    el.style.background='var(--r2)';
    chk.className='chkbox on';
    chk.style.background='var(--r)';
    chk.style.borderColor='var(--r)';
    chk.textContent='ok';
  }
}

function selecionarTodosReset() {
  pendingResetItens = [];
  resetItemsRef.forEach(function(item,i){
    pendingResetItens.push(item.t);
    var el = document.getElementById('ri-'+i);
    var chk = document.getElementById('ri-chk-'+i);
    if (el) el.style.background='var(--r2)';
    if (chk) { chk.className='chkbox on'; chk.style.background='var(--r)'; chk.style.borderColor='var(--r)'; chk.textContent='ok'; }
  });
}

var pendingResetUsers = [];

function confirmarReset() {
  if (!pendingResetClId || !pendingResetItens.length) {
    document.getElementById('reset-err').style.display='block';
    return;
  }
  document.getElementById('reset-err').style.display='none';
  document.getElementById('reset-step1').style.display='none';
  document.getElementById('reset-step2').style.display='block';
  document.getElementById('reset-users-wrap').innerHTML =
    '<div style="font-size:13px;color:var(--t3);padding:12px;text-align:center">Buscando usuários...</div>';

  // Fetch from Firebase directly to get fresh results
  var hoje = new Date().toLocaleDateString('pt-BR');
  db.collection('resultados')
    .where('checklistId','==',pendingResetClId)
    .get()
    .then(function(snap){
      var usuariosEnviaram = [];
      snap.docs.forEach(function(doc){
        var r = doc.data();
        // Only show users who sent TODAY with 100%
        if (r.dataHora && r.dataHora.indexOf(hoje)===0 && r.pct===100) {
          var jaAdded = usuariosEnviaram.some(function(u){return u.nome===r.operador;});
          if (!jaAdded) usuariosEnviaram.push({nome:r.operador, perfil:r.perfil, pct:r.pct});
        }
      });
      renderResetUsers(usuariosEnviaram);
    })
    .catch(function(){
      // Fallback: use cache
      var resultados = getResultados();
      var usuariosEnviaram = [];
      resultados.forEach(function(r){
        if (r.checklistId===pendingResetClId && r.dataHora && r.dataHora.indexOf(hoje)===0 && r.pct===100) {
          var jaAdded = usuariosEnviaram.some(function(u){return u.nome===r.operador;});
          if (!jaAdded) usuariosEnviaram.push({nome:r.operador, perfil:r.perfil, pct:r.pct});
        }
      });
      renderResetUsers(usuariosEnviaram);
    });
}

function renderResetUsers(usuariosEnviaram) {
  var wrap = document.getElementById('reset-users-wrap');
  if (!usuariosEnviaram.length) {
    wrap.innerHTML = '<div style="font-size:13px;color:var(--t3);padding:16px;text-align:center;background:var(--gray);border-radius:8px">Nenhum usuário enviou este checklist com 100% hoje.</div>';
    wrap._users = [];
    return;
  }
  var PLABEL = {admin:'Admin',gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
  var PCLS = {operator:'st-ok',prevencao:'st-err',gerencia:'st-info',admin:'st-info'};
  wrap._users = usuariosEnviaram;
  wrap.innerHTML = usuariosEnviaram.map(function(u,i){
    return '<div style="display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--gray2);border-radius:8px;background:#fff;cursor:pointer;transition:background .15s" id="ru-'+i+'" onclick="toggleResetUser('+i+')">'
      +'<div class="chkbox" id="ru-chk-'+i+'" style="flex-shrink:0"></div>'
      +'<div style="flex:1">'
      +'<div style="font-size:13px;font-weight:500">'+u.nome+'</div>'
      +'<div style="font-size:11px;color:var(--t3);margin-top:2px"><span class="st '+(PCLS[u.perfil]||'st-ok')+'">'+(PLABEL[u.perfil]||u.perfil)+'</span></div>'
      +'</div>'
      +'<span class="st st-ok">100%</span>'
      +'</div>';
  }).join('');
}


function toggleResetUser(i) {
  var wrap = document.getElementById('reset-users-wrap');
  var users = wrap._users || [];
  var nome = users[i] ? users[i].nome : '';
  var el = document.getElementById('ru-'+i);
  var chk = document.getElementById('ru-chk-'+i);
  var idx = pendingResetUsers.indexOf(nome);
  if (idx >= 0) {
    pendingResetUsers.splice(idx,1);
    el.style.background='#fff';
    chk.className='chkbox'; chk.style.background=''; chk.style.borderColor=''; chk.textContent='';
  } else {
    pendingResetUsers.push(nome);
    el.style.background='var(--bl2)';
    chk.className='chkbox on'; chk.style.background='var(--bl)'; chk.style.borderColor='var(--bl)'; chk.textContent='ok';
  }
}

function selecionarTodosUsers() {
  pendingResetUsers = [];
  var wrap = document.getElementById('reset-users-wrap');
  var users = wrap._users || [];
  users.forEach(function(u,i){
    pendingResetUsers.push(u.nome);
    var el = document.getElementById('ru-'+i);
    var chk = document.getElementById('ru-chk-'+i);
    if (el) el.style.background='var(--bl2)';
    if (chk) { chk.className='chkbox on'; chk.style.background='var(--bl)'; chk.style.borderColor='var(--bl)'; chk.textContent='ok'; }
  });
}

function confirmarResetUsers() {
  if (!pendingResetUsers.length) {
    document.getElementById('reset-users-err').style.display='block';
    return;
  }
  document.getElementById('reset-users-err').style.display='none';
  var userTxt = pendingResetUsers.length===1 ? pendingResetUsers[0] : pendingResetUsers.length+' usuários';
  mostrarStepConfirm(userTxt);
}

function mostrarStepConfirm(userTxt) {
  document.getElementById('reset-step1').style.display='none';
  document.getElementById('reset-step2').style.display='none';
  document.getElementById('reset-step3').style.display='block';
  document.getElementById('reset-confirm-count').textContent = pendingResetItens.length+' item(s)';
  document.getElementById('reset-cl-nome2').textContent = document.getElementById('reset-cl-nome').textContent;
  document.getElementById('reset-confirm-users').textContent = userTxt;
}

function executarReset() {
  var clId = pendingResetClId;
  var hoje = getLocalDate();
  var itensCopy = pendingResetItens.slice();
  var usersCopy = pendingResetUsers.slice();

  // For each selected user: update their checkstate in Firebase
  // AND remove their "sent today" result so they can send again
  usersCopy.forEach(function(nomeUser){
    var users = getUsers();
    var u = users.find(function(x){return x.nome===nomeUser;});
    var uid = u ? u.id : null;
    if (!uid) return;

    // 1. Update checkstate - clear selected items
    db.collection('checkstates').doc(uid+'_'+hoje).get().then(function(doc){
      var state = {};
      if (doc.exists && doc.data().state) {
        try { state = JSON.parse(doc.data().state); } catch(e){}
      }
      itensCopy.forEach(function(texto){ state[clId+'_'+texto] = false; });
      return db.collection('checkstates').doc(uid+'_'+hoje).set({
        userId: uid, date: hoje, state: JSON.stringify(state)
      });
    }).catch(function(){});

    // 2. Update their result: recalculate % after reset and mark as "resetado"
    // so jaEnviouHoje returns false (user can send again)
    (function(nomeUserCopy, uidCopy, itensCopyCopy){
      db.collection('resultados')
        .where('checklistId','==',clId)
        .where('operador','==',nomeUserCopy)
        .get().then(function(snap){
          var hoje2 = new Date().toLocaleDateString('pt-BR');
          snap.docs.forEach(function(doc){
            var r = doc.data();
            if (r.dataHora && r.dataHora.indexOf(hoje2)===0) {
              // Recalculate: how many items remain done after reset?
              var itensRestantes = r.itens ? r.itens.filter(function(it){
                return it.feito && itensCopyCopy.indexOf(it.texto) < 0;
              }).length : 0;
              var totalItens = r.total || 1;
              var novoPct = Math.round(itensRestantes / totalItens * 100);
              // Update itens array - mark reset items as not done
              var novosItens = r.itens ? r.itens.map(function(it){
                if (itensCopyCopy.indexOf(it.texto) >= 0) return Object.assign({},it,{feito:false});
                return it;
              }) : r.itens;
              // Update in Firebase - set resetado:true so jaEnviouHoje ignores it
              doc.ref.update({
                pct: novoPct,
                feitos: itensRestantes,
                itens: novosItens,
                resetado: true,
                resetadoEm: new Date().toLocaleString('pt-BR'),
                resetadoPor: S.currentUser ? S.currentUser.nome : 'Admin'
              });
              // Update local cache
              S.resultadosCache = S.resultadosCache.map(function(r2){
                if (r2.id === r.id) return Object.assign({},r2,{pct:novoPct,feitos:itensRestantes,itens:novosItens,resetado:true});
                return r2;
              });
              localStorage.setItem('eco_resultados', JSON.stringify(S.resultadosCache));
            }
          });
        }).catch(function(){});
    })(nomeUser, uid, itensCopy.slice());
  });

  // Reset admin local state for the reset items too
  itensCopy.forEach(function(texto){ S.checkState[clId+'_'+texto]=false; });
  saveCheckState();
  // Rebuild the checklist block to reflect new state
  setTimeout(function(){
    var cl = getMyCLs().find(function(cc){return cc.id===clId;});
    var b = document.getElementById('cl-block-'+clId);
    if (b && cl) b.innerHTML = buildCLBlock(cl);
    updateDash();
  }, 500);
  var qtdUsers = pendingResetUsers.length;
  var nomeUsers = pendingResetUsers.slice();
  fecharModalReset();
  var msg = qtdUsers === 1
    ? 'Reset feito para ' + nomeUsers[0] + '! Pode reenviar agora.'
    : 'Reset feito para ' + qtdUsers + ' usuários! Podem reenviar agora.';
  showToast(msg);
}

function fecharModalReset() {
  document.getElementById('modal-reset').style.display='none';
  document.getElementById('reset-step1').style.display='block';
  document.getElementById('reset-step2').style.display='none';
  document.getElementById('reset-step3').style.display='none';
  document.getElementById('reset-err').style.display='none';
  document.getElementById('reset-users-err').style.display='none';
  pendingResetClId=null;
  pendingResetItens=[];
  pendingResetUsers=[];
}

function resetCL(clId) {
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  cl.itens.forEach(function(i){S.checkState[clId+'_'+i.t]=false;});
  saveCheckState();
  var b = document.getElementById('cl-block-'+clId);
  if (b) b.innerHTML = buildCLBlock(cl);
  updateDash();
}

var pendingEnviarId = null;
var pendingEnviarLabel = null;
var pendingPlanilhaProdutos = null;
var pendingPlanilhaLojas = {};

function proximaMeiaNoite() {
  var d = new Date();
  d.setHours(24, 0, 0, 0);
  return d;
}

function parseCSV(text) {
  var lines = text.trim().split(/\r?\n/);
  var sep = text.indexOf(';') > -1 ? ';' : ',';
  var produtos = [];
  lines.forEach(function(line) {
    var cols = line.split(sep).map(function(c) { return c.trim().replace(/^"|"$/g, ''); });
    if (cols.length < 2) return;
    var codigo = cols[0], descricao = cols[1], setor = cols[2] || '';
    if (!/\d/.test(codigo)) return; // pula qualquer linha sem dígito na coluna código (cabeçalho)
    if (!descricao) return;
    produtos.push({ codigo: codigo, descricao: descricao, setor: setor });
  });
  return produtos;
}

function togglePlanilhaRow(sel) {
  var row = document.getElementById('ncl-planilha-row');
  var fotoSel = document.getElementById('ncl-item-foto');
  var prazoRow = document.getElementById('ncl-simnao-prazo-row');
  if (!row) return;
  var isPlanilha = sel.value === 'planilha';
  var isSimNao = sel.value === 'simNao';
  row.style.display = isPlanilha ? 'block' : 'none';
  if (fotoSel) fotoSel.style.display = isPlanilha ? 'none' : '';
  if (prazoRow) prazoRow.style.display = isSimNao ? 'block' : 'none';
  if (isPlanilha) {
    var modoInputs = document.querySelectorAll('input[name="ncl-planilha-modo"]');
    modoInputs.forEach(function(inp){ inp.checked = inp.value === 'fixa'; });
    onPlanilhaModoChange('fixa');
  }
}

function onPlanilhaModoChange(modo) {
  var fixaSection = document.getElementById('ncl-planilha-fixa-section');
  var diariaSection = document.getElementById('ncl-planilha-diaria-section');
  if (fixaSection) fixaSection.style.display = modo === 'fixa' ? '' : 'none';
  if (diariaSection) diariaSection.style.display = modo === 'diaria' ? 'block' : 'none';
}

function onPlanilhaCSVChange(input) {
  var file = input.files[0];
  if (!file) { pendingPlanilhaProdutos = null; return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    pendingPlanilhaProdutos = parseCSV(e.target.result);
    var info = document.getElementById('ncl-planilha-info');
    if (info) info.textContent = pendingPlanilhaProdutos.length + ' produtos carregados — clique "+ Loja" para adicionar';
  };
  reader.readAsText(file, 'UTF-8');
}

function adicionarLojaPlanilha() {
  var lojaInput = document.getElementById('ncl-planilha-loja-nome');
  var loja = lojaInput ? lojaInput.value.trim() : '';
  if (!loja) { showToast('Informe o nome da loja'); return; }
  if (!pendingPlanilhaProdutos || !pendingPlanilhaProdutos.length) { showToast('Selecione o arquivo CSV primeiro'); return; }
  pendingPlanilhaLojas[loja] = pendingPlanilhaProdutos.slice();
  pendingPlanilhaProdutos = null;
  if (lojaInput) lojaInput.value = '';
  var csvInput = document.getElementById('ncl-planilha-csv');
  if (csvInput) csvInput.value = '';
  var info = document.getElementById('ncl-planilha-info');
  if (info) info.textContent = 'Formato: código, descrição, setor — um produto por linha';
  renderNclPlanilhaLojas();
}

function removerLojaPlanilha(loja) {
  delete pendingPlanilhaLojas[loja];
  renderNclPlanilhaLojas();
}

function renderNclPlanilhaLojas() {
  var wrap = document.getElementById('ncl-planilha-lojas-lista');
  if (!wrap) return;
  var keys = Object.keys(pendingPlanilhaLojas);
  if (!keys.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = keys.map(function(loja) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--gray);border-radius:8px;margin-bottom:4px">'
      +'<span style="flex:1;font-size:12px;font-weight:600">🏪 '+loja+' — '+pendingPlanilhaLojas[loja].length+' produtos</span>'
      +'<button onclick="removerLojaPlanilha(\''+loja+'\')" style="background:none;border:none;color:var(--r);cursor:pointer;font-size:15px;line-height:1">✕</button>'
      +'</div>';
  }).join('');
}

function onDiariaCSVChange(input) {
  var file = input.files[0];
  if (!file) { pendingDiariaProdutos = null; return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    pendingDiariaProdutos = parseCSV(e.target.result);
    var info = document.getElementById('ncl-diaria-info');
    if (info) info.textContent = pendingDiariaProdutos.length + ' produtos carregados — clique "+ Loja" para adicionar';
  };
  reader.readAsText(file, 'UTF-8');
}

function adicionarLojaDiaria() {
  var lojaInput = document.getElementById('ncl-diaria-loja-nome');
  var loja = lojaInput ? lojaInput.value.trim() : '';
  if (!loja) { showToast('Informe o nome da loja'); return; }
  if (!pendingDiariaProdutos || !pendingDiariaProdutos.length) { showToast('Selecione o arquivo CSV primeiro'); return; }
  var hoje = new Date().toISOString().slice(0, 10);
  var clId = pendingCLId || editingCLId || genId();
  // Descobre o índice real do item planilha diária em nclItens
  var itemIdx = 0;
  for (var ii = nclItens.length - 1; ii >= 0; ii--) {
    if (nclItens[ii].tipo === 'planilha' && (nclItens[ii].modoPlanilha || 'fixa') === 'diaria') {
      itemIdx = ii;
      break;
    }
  }
  pendingDiariaLojas[loja] = pendingDiariaProdutos.slice();
  var docId = clId + '_diaria_' + itemIdx + '_' + loja + '_' + hoje;
  db.collection('contagens').doc(docId).set({
    id: docId, tipo: 'planilha_diaria',
    checklistId: clId, itemIdx: itemIdx, loja: loja,
    data: hoje, expireAt: proximaMeiaNoite(),
    produtos: pendingDiariaProdutos.slice()
  }).catch(function(){});
  _planilhaTemplates[clId + '_' + itemIdx + '_' + loja] = pendingDiariaProdutos.slice();
  pendingDiariaProdutos = null;
  if (lojaInput) lojaInput.value = '';
  var csvInput = document.getElementById('ncl-diaria-csv');
  if (csvInput) csvInput.value = '';
  var info = document.getElementById('ncl-diaria-info');
  if (info) info.textContent = 'Formato: código, descrição, setor — um produto por linha';
  renderNclDiariaLojas();
}

function removerLojaDiaria(loja) {
  delete pendingDiariaLojas[loja];
  renderNclDiariaLojas();
}

function renderNclDiariaLojas() {
  var wrap = document.getElementById('ncl-diaria-lojas-lista');
  if (!wrap) return;
  var keys = Object.keys(pendingDiariaLojas);
  if (!keys.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = keys.map(function(loja) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#e8f4fd;border-radius:8px;margin-bottom:4px">'
      +'<span style="flex:1;font-size:12px;font-weight:600">🏪 '+loja+' — '+pendingDiariaLojas[loja].length+' produtos ✓</span>'
      +'<button onclick="removerLojaDiaria(\''+loja+'\')" style="background:none;border:none;color:var(--r);cursor:pointer;font-size:15px;line-height:1">✕</button>'
      +'</div>';
  }).join('');
}

function uploadDiariaPorLoja(clId, itemIdx, lojaParam, fileInput) {
  var file = fileInput.files[0];
  if (!file) return;
  var loja = lojaParam;
  if (!loja) {
    var lojaInput = document.getElementById('diaria-loja-' + clId + '-' + itemIdx);
    loja = lojaInput ? lojaInput.value.trim() : '';
  }
  if (!loja) { showToast('Informe o nome da loja'); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    var produtos = parseCSV(e.target.result);
    if (!produtos.length) { showToast('Nenhum produto encontrado no CSV'); return; }
    var hoje = new Date().toISOString().slice(0, 10);
    var docId = clId + '_diaria_' + itemIdx + '_' + loja + '_' + hoje;
    var doc = {
      id: docId, tipo: 'planilha_diaria',
      checklistId: clId, itemIdx: itemIdx, loja: loja,
      data: hoje, expireAt: proximaMeiaNoite(), produtos: produtos
    };
    db.collection('contagens').doc(docId).set(doc).catch(function(){});
    _planilhaTemplates[clId + '_' + itemIdx + '_' + loja] = produtos;
    var cl = getMyCLs().find(function(c) { return c.id === clId; });
    if (cl) {
      var block = document.getElementById('cl-block-' + clId);
      if (block) block.innerHTML = buildCLBlock(cl);
    }
    var liInput = document.getElementById('diaria-loja-' + clId + '-' + itemIdx);
    if (liInput) liInput.value = '';
    showToast('🏪 ' + loja + ' — ' + produtos.length + ' produtos carregados!');
  };
  reader.readAsText(file, 'UTF-8');
}

function salvarQuantidade(clId, itemIdx, codigo, val) {
  S.checkState[clId + '_qty_' + itemIdx + '_' + codigo] = val;
  var cl = getMyCLs().find(function(c) { return c.id === clId; });
  if (!cl) return;
  var item = cl.itens[itemIdx];
  if (!item || item.tipo !== 'planilha') return;
  var produtos = [];
  if ((item.modoPlanilha || 'fixa') === 'diaria') {
    var uLojaSQ = S.currentUser ? (S.currentUser.loja || '') : '';
    produtos = _planilhaTemplates[clId + '_' + itemIdx + '_' + uLojaSQ] || [];
  } else {
    var userLojaSQ = S.currentUser ? (S.currentUser.loja || '') : '';
    produtos = item.lojas ? (item.lojas[userLojaSQ] || []) : (item.produtos || []);
  }
  var allFilled = produtos.every(function(p) {
    var v = S.checkState[clId + '_qty_' + itemIdx + '_' + p.codigo];
    return v !== undefined && v !== '';
  });
  S.checkState[clId + '_' + item.t] = allFilled ? 'done' : '';
  updateCLProg(cl);
}

function limparPlanosAntigos() {
  var limite = Date.now() - 30 * 24 * 3600000;
  var lista = getPlanos();
  var removidos = lista.filter(function(p) {
    if (p.status !== 'resolvido') return false;
    if (!p.resolvidoTimestamp) return false;
    return new Date(p.resolvidoTimestamp).getTime() < limite;
  });
  if (!removidos.length) return;
  var novaLista = lista.filter(function(p) {
    return !removidos.some(function(r){ return r.id === p.id; });
  });
  savePlanos(novaLista);
  removidos.forEach(function(p){ db.collection('planos').doc(p.id).delete().catch(function(){}); });
}

function limparContagensAntigas() {
  var hoje = new Date().toISOString().slice(0, 10);
  db.collection('contagens').get().then(function(snap) {
    snap.docs.forEach(function(doc) {
      if ((doc.data().data || '') < hoje) {
        doc.ref.delete().catch(function() {});
      }
    });
  }).catch(function() {});
}

function loadPlanilhasDiarias(cb) {
  var hoje = new Date().toISOString().slice(0, 10);
  db.collection('contagens').get().then(function(snap) {
    _planilhaTemplates = {};
    snap.docs.forEach(function(doc) {
      var d = doc.data();
      if (d.tipo === 'planilha_diaria' && d.data === hoje) {
        var key = (d.checklistId || '') + '_' + (d.itemIdx !== undefined ? d.itemIdx : '') + '_' + (d.loja || '');
        _planilhaTemplates[key] = d.produtos || [];
      }
    });
    if (cb) cb();
  }).catch(function() { if (cb) cb(); });
}

function jaEnviouHoje(clId) {
  var hoje = new Date().toLocaleDateString('pt-BR');
  var operador = S.currentUser ? S.currentUser.nome : '--';
  var resultados = getResultados();
  // Find the most recent result for this user+checklist today
  var todayResults = resultados.filter(function(r){
    return r.checklistId === clId
      && r.operador === operador
      && r.dataHora && r.dataHora.indexOf(hoje) === 0;
  });
  if (!todayResults.length) return false;
  // Sort by id desc to get latest
  todayResults.sort(function(a,b){ return (b.id||'') > (a.id||'') ? 1 : -1; });
  var latest = todayResults[0];
  // If latest was reset by admin, user can send again
  return !latest.resetado;
}

function enviarCL(clId, label) {
  // Bloqueia envio se há planos vencidos para a loja do operador
  var vencidos = _planosVencidosDoUsuario();
  if (vencidos.length) {
    showToast('🚨 Envio bloqueado: '+vencidos.length+' plano(s) de ação vencido(s). Resolva ou solicite prorrogação.', 5000);
    return;
  }
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  var feitos = cl.itens.filter(function(i){return !!S.checkState[clId+'_'+i.t];}).length;
  var total = cl.itens.length;
  var pct = total ? Math.round(feitos/total*100) : 0;

  // Bloquear reenvio se já enviou hoje
  if (jaEnviouHoje(clId)) {
    document.getElementById('env-ja-enviado-nome').textContent = label;
    document.getElementById('modal-ja-enviado').style.display = 'flex';
    return;
  }

  // Verificar fotos obrigatórias pendentes
  var fotosPendentes = [];
  cl.itens.forEach(function(item, idx){
    if (!item.foto || item.foto === 'none') return;
    var faltaAntes = item.foto === 'antes_depois' && !S.checkState[clId+'_foto_antes_'+idx];
    var faltaDepois = (item.foto === 'depois' || item.foto === 'antes_depois') && !S.checkState[clId+'_foto_depois_'+idx] && !S.checkState[clId+'_foto_'+idx];
    if (faltaAntes || faltaDepois) {
      fotosPendentes.push({texto:item.t, idx:idx, faltaAntes:faltaAntes, faltaDepois:faltaDepois});
    }
  });

  if (fotosPendentes.length > 0) {
    // Mostrar modal de fotos pendentes
    var wrap = document.getElementById('fp-lista');
    wrap.innerHTML = fotosPendentes.map(function(p){
      var msg = '';
      if (p.faltaAntes && p.faltaDepois) msg = '📷 Faltando foto do ANTES e DEPOIS';
      else if (p.faltaAntes) msg = '📷 Faltando foto do ANTES';
      else msg = '📷 Faltando foto do DEPOIS';
      return '<div style="padding:10px 12px;background:var(--r2);border:1px solid #fac5c0;border-radius:8px;margin-bottom:6px">'
        +'<div style="font-size:13px;font-weight:600;color:var(--r)">'+p.texto+'</div>'
        +'<div style="font-size:12px;color:var(--r);margin-top:2px">'+msg+'</div>'
        +'</div>';
    }).join('');
    document.getElementById('fp-cl-id').value = clId;
    document.getElementById('fp-cl-label').value = label;
    document.getElementById('modal-foto-pendente').style.display = 'flex';
    return;
  }

  pendingEnviarId = clId;
  pendingEnviarLabel = label;
  document.getElementById('env-titulo').textContent = label;
  document.getElementById('env-pct').textContent = pct+'%';
  document.getElementById('env-itens').textContent = feitos+'/'+total+' itens concluidos';
  var icon = document.getElementById('env-icon');
  var msg = document.getElementById('env-msg');
  if (pct === 100) {
    icon.textContent = 'OK';
    msg.textContent = 'Todos os itens foram concluidos!';
    msg.style.color = 'var(--g)';
  } else if (pct >= 50) {
    icon.textContent = '! ';
    msg.textContent = 'Atencao: alguns itens ainda nao foram marcados.';
    msg.style.color = 'var(--am)';
  } else {
    icon.textContent = 'X ';
    msg.textContent = 'A maioria dos itens nao foi concluida. Deseja enviar mesmo assim?';
    msg.style.color = 'var(--r)';
  }
  var fill = document.getElementById('env-bar-fill');
  fill.style.width = pct+'%';
  fill.style.background = pct===100 ? 'var(--g2)' : pct>=50 ? 'var(--am)' : 'var(--r)';
  document.getElementById('modal-enviar').style.display = 'flex';
}

function confirmarEnviar(assinatura) {
  var clId = pendingEnviarId;
  var label = pendingEnviarLabel;
  if (!clId) return;
  // Fecha o modal imediatamente para evitar duplo envio
  pendingEnviarId = null;
  pendingEnviarLabel = null;
  document.getElementById('modal-enviar').style.display = 'none';
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  var snapshot = cl.itens.map(function(item,idx){
    var val = S.checkState[clId+'_'+item.t];
    var tipo = item.tipo || 'checkbox';
    var justificativa = tipo==='simNao' ? (S.checkState[clId+'_justif_'+idx]||'') : '';
    var itemProdutos = null;
    if (tipo === 'planilha') {
      var uLoja = S.currentUser ? (S.currentUser.loja || '') : '';
      var lojaProds = [];
      if ((item.modoPlanilha || 'fixa') === 'diaria') {
        lojaProds = _planilhaTemplates[clId + '_' + idx + '_' + uLoja] || [];
      } else {
        lojaProds = item.lojas ? (item.lojas[uLoja] || []) : (item.produtos || []);
      }
      if (lojaProds.length) {
        itemProdutos = lojaProds.map(function(p) {
          return Object.assign({}, p, { quantidade: S.checkState[clId+'_qty_'+idx+'_'+p.codigo] || '' });
        });
      }
    }
    return {
      texto:item.t, obs:item.obs||'', foto:item.foto||false, tipo:tipo,
      resposta:tipo!=='checkbox'&&tipo!=='planilha'?(val||null):null,
      justificativa:justificativa,
      fotoAntes:S.checkState[clId+'_foto_antes_'+idx]||null,
      fotoDepois:S.checkState[clId+'_foto_depois_'+idx]||S.checkState[clId+'_foto_'+idx]||null,
      feito:!!val, critico:!!item.critico,
      prazoPlano: item.prazoPlano || 72,
      produtos: itemProdutos
    };
  });
  var feitos = snapshot.filter(function(i){return i.feito;}).length;
  var total = snapshot.length;
  var pct = total ? Math.round(feitos/total*100) : 0;
  // Verifica se algum item crítico foi reprovado
  var reprovado = snapshot.some(function(item){
    if (!item.critico) return false;
    if (item.tipo === 'simNao') return item.resposta === 'nao';
    return !item.feito;
  });
  var customCL = getCustomCLs().find(function(c){return c.id===clId;});
  var setor = customCL ? customCL.setor : 'Geral';
  var now = new Date();
  var dh = now.toLocaleDateString('pt-BR')+' '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  var res = {
    id:genId(), checklistId:clId, checklistNome:label, setor:setor,
    operador:S.currentUser?S.currentUser.nome:'--', perfil:S.role,
    loja:S.currentUser?S.currentUser.loja||'':'',
    dataHora:dh, itens:snapshot, feitos:feitos, total:total, pct:pct,
    reprovado:reprovado, assinatura:assinatura||null
  };
  var lista = getAllResultados();
  // Salva sem assinatura no cache local (base64 enorme estoura localStorage)
  var resParaCache = Object.assign({}, res, {assinatura: null});
  lista.push(resParaCache);
  S.resultadosCache = lista;
  try { localStorage.setItem(RESKEY, JSON.stringify(lista)); } catch(e) {}
  // Salva com assinatura apenas no Firebase
  db.collection('resultados').doc(res.id).set(res).catch(function(err){
    console.error('Erro ao salvar resultado no Firebase:', err);
    showToast('⚠️ Resultado salvo localmente — sincronizará quando houver conexão');
  });
  // Salva contagens de planilha com TTL (expiram na meia-noite)
  var meianoite = proximaMeiaNoite();
  var hoje = new Date().toISOString().slice(0, 10);
  cl.itens.forEach(function(clItem, idx) {
    if (clItem.tipo !== 'planilha') return;
    var uLoja2 = S.currentUser ? (S.currentUser.loja || '') : '';
    var lojaProds2 = [];
    if ((clItem.modoPlanilha || 'fixa') === 'diaria') {
      lojaProds2 = _planilhaTemplates[clId + '_' + idx + '_' + uLoja2] || [];
    } else {
      lojaProds2 = clItem.lojas ? (clItem.lojas[uLoja2] || []) : (clItem.produtos || []);
    }
    if (!lojaProds2.length) return;
    var produtos = lojaProds2.map(function(p) {
      return Object.assign({}, p, { quantidade: S.checkState[clId+'_qty_'+idx+'_'+p.codigo] || '' });
    });
    var contagemDoc = {
      id: genId(), checklistId: clId, checklistNome: label,
      itemTexto: clItem.t, itemIdx: idx,
      loja: S.currentUser ? S.currentUser.loja || '' : '',
      operador: S.currentUser ? S.currentUser.nome : '--',
      data: hoje, expireAt: meianoite, produtos: produtos
    };
    db.collection('contagens').doc(contagemDoc.id).set(contagemDoc).catch(function(){});
  });
  // Auto-criar planos de ação para itens Sim/Não com resposta "Não"
  snapshot.forEach(function(item) {
    if (item.tipo==='simNao' && item.resposta==='nao') {
      criarPlanoAuto(label, item.texto, item.justificativa||'', setor, item.prazoPlano||72);
    }
  });
  addHist('Checklist','"'+label+'" enviado ('+pct+'%)','Geral',pct===100?'st-ok':'st-warn',pct+'%');
  // Re-renderiza o bloco para mostrar o banner "Checklist já enviado hoje!"
  var block = document.getElementById('cl-block-'+clId);
  if (block) block.innerHTML = buildCLBlock(cl);
  updateCLProg(cl);
  updateDash();
  if (reprovado) showToast('🚨 Inspeção REPROVADA — item crítico não conforme!');
  else showToast(pct===100 ? 'Checklist enviado com sucesso!' : 'Checklist enviado com '+pct+'% concluído');
}

function cancelarEnviar() {
  pendingEnviarId = null;
  pendingEnviarLabel = null;
  document.getElementById('modal-enviar').style.display = 'none';
}


// ===========================================
// CRIAR CHECKLIST
// ===========================================
var nclItens = [];
var editingCLId = null;
var pendingCLId = null;
var pendingDiariaProdutos = null;
var pendingDiariaLojas = {};
var clFiltro = 'todos';
var pendingExcluirId = null;

function abrirModalCL() {
  editingCLId = null;
  pendingCLId = genId();
  pendingDiariaLojas = {}; pendingDiariaProdutos = null;
  nclItens = [];
  document.getElementById('mcl-title').textContent = 'Novo Checklist';
  ['ncl-nome','ncl-desc','ncl-item-txt','ncl-item-obs'].forEach(function(id){document.getElementById(id).value='';}); document.getElementById('ncl-item-foto').value='none'; var _t=document.getElementById('ncl-item-tipo'); if(_t)_t.value='checkbox';
  document.getElementById('ncl-perfil').value='operator';
  document.getElementById('ncl-setor').value='Açougue';
  document.getElementById('ncl-turno').value='Abertura';
  // Limpar agenda obrigatória
  [0,1,2,3,4,5,6].forEach(function(d){ var el=document.getElementById('dia-'+d); if(el) el.checked=false; });
  var hl = document.getElementById('ncl-hora-limite'); if(hl) hl.value='10:00';
  document.getElementById('mcl-err').style.display='none';
  renderNclItens();
  document.getElementById('modal-cl').style.display='flex';
}

function fecharModalCL() {
  document.getElementById('modal-cl').style.display='none';
  nclItens=[]; editingCLId=null; pendingCLId=null;
  pendingPlanilhaLojas={}; pendingPlanilhaProdutos=null;
  pendingDiariaLojas={}; pendingDiariaProdutos=null;
  renderNclDiariaLojas();
  renderNclPlanilhaLojas();
  var pr=document.getElementById('ncl-planilha-row'); if(pr) pr.style.display='none';
  var fs=document.getElementById('ncl-item-foto'); if(fs) fs.style.display='';
}

function addItemNCL() {
  var txt = document.getElementById('ncl-item-txt').value.trim();
  var obs = document.getElementById('ncl-item-obs').value.trim();
  var fotoVal = document.getElementById('ncl-item-foto').value;
  var tipo = (document.getElementById('ncl-item-tipo')||{value:'checkbox'}).value || 'checkbox';
  var criticoEl = document.getElementById('ncl-item-critico');
  if (!txt) return;
  if (tipo === 'planilha') {
    var modoChecked = document.querySelector('input[name="ncl-planilha-modo"]:checked');
    var modoPlanilha = modoChecked ? modoChecked.value : 'fixa';
    if (modoPlanilha === 'diaria') {
      nclItens.push({ t: txt, obs: obs, tipo: 'planilha', foto: false, critico: false, modoPlanilha: 'diaria', lojas: {} });
    } else {
      if (!Object.keys(pendingPlanilhaLojas).length) {
        showToast('Adicione pelo menos uma loja com arquivo CSV');
        return;
      }
      var lojasCopy = {};
      Object.keys(pendingPlanilhaLojas).forEach(function(l) { lojasCopy[l] = pendingPlanilhaLojas[l].slice(); });
      nclItens.push({ t: txt, obs: obs, tipo: 'planilha', foto: false, critico: false, modoPlanilha: 'fixa', lojas: lojasCopy });
      pendingPlanilhaLojas = {};
      pendingPlanilhaProdutos = null;
      var csvInput = document.getElementById('ncl-planilha-csv');
      if (csvInput) csvInput.value = '';
      var lojaInput = document.getElementById('ncl-planilha-loja-nome');
      if (lojaInput) lojaInput.value = '';
      renderNclPlanilhaLojas();
      var info = document.getElementById('ncl-planilha-info');
      if (info) info.textContent = 'Formato: código, descrição, setor — um produto por linha';
    }
  } else {
    var foto = fotoVal !== 'none' ? fotoVal : false;
    var critico = criticoEl ? criticoEl.checked : false;
    var prazoPlanoEl = document.getElementById('ncl-item-prazo-plano');
    var prazoPlano = (tipo === 'simNao' && prazoPlanoEl) ? parseInt(prazoPlanoEl.value || '72') : 72;
    nclItens.push({ t: txt, obs: obs, foto: foto, tipo: tipo, critico: critico, prazoPlano: prazoPlano });
  }
  document.getElementById('ncl-item-txt').value='';
  document.getElementById('ncl-item-obs').value='';
  document.getElementById('ncl-item-foto').value='none';
  var tipoEl = document.getElementById('ncl-item-tipo');
  if (tipoEl) { tipoEl.value='checkbox'; togglePlanilhaRow(tipoEl); }
  if (criticoEl) criticoEl.checked = false;
  var prazoPlanoResetEl = document.getElementById('ncl-item-prazo-plano');
  if (prazoPlanoResetEl) prazoPlanoResetEl.value = '72';
  renderNclItens();
  document.getElementById('ncl-item-txt').focus();
}

function removeItemNCL(idx) {
  nclItens.splice(idx,1);
  renderNclItens();
}

function renderNclItens() {
  var wrap = document.getElementById('ncl-itens-wrap');
  if (!nclItens.length) { wrap.innerHTML='<div style="font-size:12px;color:var(--t3);padding:8px 0">Nenhum item ainda. Preencha o campo abaixo e clique em Adicionar.</div>'; return; }
  wrap.innerHTML = nclItens.map(function(item,i){
    return '<div style="display:flex;align-items:flex-start;gap:8px;padding:10px 12px;background:var(--gray);border-radius:8px">'
      +'<span style="font-size:18px;margin-top:1px">☐</span>'
      +'<div style="flex:1;min-width:0">'
      +'<div style="font-size:13px;font-weight:500">'+item.t+'</div>'
      +(item.obs ? '<div style="font-size:11px;color:var(--t3);margin-top:2px">'+item.obs+'</div>' : '')
      +(item.tipo && item.tipo!=='checkbox' ? '<div style="font-size:11px;color:var(--bl);margin-top:2px">'+({simNao:'✅ Sim/Não',nota:'⭐ Nota 1–5',texto:'📝 Texto',planilha:'📊 Planilha de Contagem'}[item.tipo]||'')+(item.tipo==='planilha'&&item.lojas?' ('+Object.keys(item.lojas).join(', ')+')':item.tipo==='planilha'&&item.produtos?' ('+item.produtos.length+' produtos)':'')+'</div>' : '')
      +(item.foto && item.foto!=='none' ? '<div style="font-size:11px;color:var(--g);margin-top:2px">'+(item.foto==='antes_depois'?'📷📷 Foto antes e depois':'📷 Foto depois')+'</div>' : '')
      +(item.critico ? '<div style="font-size:11px;font-weight:700;color:var(--r);margin-top:2px">⚠️ Item Crítico — reprova a inspeção inteira</div>' : '')
      +'</div>'
      +'<button onclick="removeItemNCL('+i+')" style="background:none;border:none;color:var(--r);cursor:pointer;font-size:16px;line-height:1;flex-shrink:0">✕</button>'
      +'</div>';
  }).join('');
}

function salvarCL() {
  var nome = document.getElementById('ncl-nome').value.trim();
  var setor = document.getElementById('ncl-setor').value;
  var perfil = document.getElementById('ncl-perfil').value;
  var turno = document.getElementById('ncl-turno').value;
  var desc = document.getElementById('ncl-desc').value.trim();
  var err = document.getElementById('mcl-err');
  if (!nome) { err.textContent='Informe o nome.'; err.style.display='block'; return; }
  if (!nclItens.length) { err.textContent='Adicione pelo menos 1 item.'; err.style.display='block'; return; }
  // Agenda obrigatória
  var diasObrigatorios = [0,1,2,3,4,5,6].filter(function(d){
    var el = document.getElementById('dia-'+d); return el && el.checked;
  });
  var horaLimite = (document.getElementById('ncl-hora-limite')||{}).value || '10:00';
  var list = getCustomCLs();
  if (editingCLId) {
    list = list.map(function(cl){ return cl.id===editingCLId ? Object.assign({},cl,{nome:nome,setor:setor,perfil:perfil,turno:turno,desc:desc,itens:nclItens.slice(),diasObrigatorios:diasObrigatorios,horaLimite:horaLimite}) : cl; });
  } else {
    list.push({id:pendingCLId||genId(),nome:nome,setor:setor,perfil:perfil,turno:turno,desc:desc,itens:nclItens.slice(),diasObrigatorios:diasObrigatorios,horaLimite:horaLimite,criadoEm:new Date().toLocaleString('pt-BR'),criadoPor:S.currentUser?S.currentUser.nome:'Admin'});
  }
  saveCustomCLs(list);
  fecharModalCL();
  renderCLGrid();
  buildCLTabs();
}

function editarCL(id) {
  var cl = getCustomCLs().find(function(x){return x.id===id;});
  if (!cl) return;
  editingCLId = id;
  pendingCLId = id;
  pendingDiariaLojas = {}; pendingDiariaProdutos = null;
  nclItens = cl.itens.slice();
  document.getElementById('mcl-title').textContent='Editar Checklist';
  document.getElementById('ncl-nome').value=cl.nome;
  document.getElementById('ncl-setor').value=cl.setor;
  document.getElementById('ncl-perfil').value=cl.perfil;
  document.getElementById('ncl-turno').value=cl.turno||'Abertura';
  document.getElementById('ncl-desc').value=cl.desc||'';
  // Agenda obrigatória
  var dias = cl.diasObrigatorios || [];
  [0,1,2,3,4,5,6].forEach(function(d){ var el=document.getElementById('dia-'+d); if(el) el.checked=dias.indexOf(d)>=0; });
  var hl = document.getElementById('ncl-hora-limite'); if(hl) hl.value=cl.horaLimite||'10:00';
  document.getElementById('mcl-err').style.display='none';
  ['ncl-item-txt','ncl-item-obs'].forEach(function(id){document.getElementById(id).value='';}); document.getElementById('ncl-item-foto').value='none'; var _t2=document.getElementById('ncl-item-tipo'); if(_t2)_t2.value='checkbox';
  // Pré-popula lojas de itens planilha existentes
  pendingPlanilhaLojas={};
  renderNclPlanilhaLojas();
  renderNclItens();
  document.getElementById('modal-cl').style.display='flex';
}

function excluirCL(id) {
  // Store pending id and show confirm panel
  pendingExcluirId = id;
  var cl = getCustomCLs().find(function(x){return x.id===id;});
  var nome = cl ? cl.nome : 'este checklist';
  document.getElementById('excluir-nome').textContent = nome;
  document.getElementById('modal-excluir').style.display = 'flex';
}

function confirmarExcluir() {
  if (!pendingExcluirId) return;
  saveCustomCLs(getCustomCLs().filter(function(cl){return cl.id!==pendingExcluirId;}));
  pendingExcluirId = null;
  document.getElementById('modal-excluir').style.display = 'none';
  renderCLGrid();
  buildCLTabs();
}

function cancelarExcluir() {
  pendingExcluirId = null;
  document.getElementById('modal-excluir').style.display = 'none';
}

function filtrarCL(f, btn) {
  clFiltro=f;
  document.querySelectorAll('#cl-criar-tabs .tab').forEach(function(t){t.classList.remove('on');});
  btn.classList.add('on');
  renderCLGrid();
}

var SETOR_COLORS = {'Açougue':'#FCEBEB','Hortifruti':'#EAF3DE','Frios':'#E6F1FB','Padaria':'#FAEEDA','Mercearia':'#E6F1FB','Bebidas':'#E6F1FB','Prevenção':'#FCEBEB','Gerência':'#EAF3DE','Geral':'#f4f6f8','Limpeza':'#f4f6f8','Caixa':'#FAEEDA'};
var PERF_LABEL = {operator:'Operador',prevencao:'Prevenção',gerencia:'Gerência',todos:'Todos',admin:'Admin'};
var PERF_CLS = {operator:'st-ok',prevencao:'st-err',gerencia:'st-info',todos:'st-warn',admin:'st-info'};

function renderCLGrid() {
  var list = getCustomCLs();
  var filtered = clFiltro==='todos' ? list : list.filter(function(cl){return cl.setor===clFiltro;});
  var grid = document.getElementById('cl-grid');
  if (!filtered.length) {
    grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--t3)"><div style="font-size:32px;margin-bottom:8px">📋</div><div>Nenhum checklist criado ainda</div><div style="font-size:12px;margin-top:4px">Clique em "+ Novo Checklist" para começar</div></div>';
    return;
  }
  grid.innerHTML = filtered.map(function(cl){
    return '<div style="background:#fff;border:1px solid var(--gray2);border-radius:12px;padding:16px;box-shadow:var(--sh)">'
      +'<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:12px">'
      +'<div style="width:36px;height:36px;border-radius:8px;background:'+(SETOR_COLORS[cl.setor]||'#f4f6f8')+';display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">📋</div>'
      +'<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:14px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+cl.nome+'</div>'
      +'<div style="font-size:11px;color:var(--t3)">'+cl.setor+' · '+(cl.turno||'Qualquer')+'</div></div></div>'
      +'<div style="font-size:12px;color:var(--t2);margin-bottom:10px;min-height:32px">'+(cl.desc||'Sem descrição')+'</div>'
      +'<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px">'
      +'<span class="st '+(PERF_CLS[cl.perfil]||'st-ok')+'">'+(PERF_LABEL[cl.perfil]||cl.perfil)+'</span>'
      +'<span style="font-size:11px;color:var(--t3);margin-left:auto">'+cl.itens.length+' itens</span></div>'
      +'<div style="font-size:10px;color:var(--t3);margin-bottom:10px">Criado por '+(cl.criadoPor||'Admin')+' · '+(cl.criadoEm||'-')+'</div>'
      +'<div style="display:flex;gap:6px">'
      +'<button class="btn btn-s btn-sm cl-btn-editar" data-clid="'+cl.id+'">✏ Editar</button>'
      +'<button class="btn btn-d btn-sm cl-btn-excluir" data-clid="'+cl.id+'">🗑 Excluir</button>'
      +'</div></div>';
  }).join('');
  grid.querySelectorAll('.cl-btn-editar').forEach(function(btn){btn.addEventListener('click',function(){editarCL(this.dataset.clid);});});
  grid.querySelectorAll('.cl-btn-excluir').forEach(function(btn){btn.addEventListener('click',function(){excluirCL(this.dataset.clid);});});
}

// ===========================================
// CENTRAL DE RESULTADOS
// ===========================================
function renderCentral() {
  var resultados = getResultados();
  var fs = (document.getElementById('cf-setor')||{}).value||'';
  var fo = (document.getElementById('cf-op')||{}).value||'';
  var opSel = document.getElementById('cf-op');
  if (opSel) {
    var ops = [];
    resultados.forEach(function(r){ if (ops.indexOf(r.operador)<0) ops.push(r.operador); });
    opSel.innerHTML = '<option value="">Todos</option>'+ops.map(function(o){return '<option'+(fo===o?' selected':'')+'>'+o+'</option>';}).join('');
  }
  var dtIni = (document.getElementById('cf-dt-ini')||{}).value||'';
  var dtFim = (document.getElementById('cf-dt-fim')||{}).value||'';
  var lista = resultados;
  if (fs) lista = lista.filter(function(r){return r.setor===fs;});
  if (fo) lista = lista.filter(function(r){return r.operador===fo;});
  if (dtIni) {
    lista = lista.filter(function(r){
      if (!r.dataHora) return false;
      // dataHora is "dd/mm/yyyy hh:mm" - convert to compare
      var parts = r.dataHora.split(' ')[0].split('/');
      if (parts.length<3) return true;
      var d = parts[2]+'-'+parts[1]+'-'+parts[0]; // yyyy-mm-dd
      return d >= dtIni;
    });
  }
  if (dtFim) {
    lista = lista.filter(function(r){
      if (!r.dataHora) return false;
      var parts = r.dataHora.split(' ')[0].split('/');
      if (parts.length<3) return true;
      var d = parts[2]+'-'+parts[1]+'-'+parts[0];
      return d <= dtFim;
    });
  }
  var total=lista.length, comp=0, incomp=0, sum=0;
  lista.forEach(function(r){if(r.pct===100)comp++;else incomp++;sum+=r.pct;});
  var media = total?Math.round(sum/total):0;
  document.getElementById('c-total').textContent=total;
  document.getElementById('c-comp').textContent=comp;
  document.getElementById('c-incomp').textContent=incomp;
  document.getElementById('c-media').textContent=total?media+'%':'-';
  var tbody = document.getElementById('c-tbody');
  if (!lista.length) { tbody.innerHTML='<tr class="erow"><td colspan="8">Nenhum resultado ainda</td></tr>'; return; }
  var PLABEL={admin:'Administrador',gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
  var PCLS={admin:'st-info',gerencia:'st-info',operator:'st-ok',prevencao:'st-err'};
  var reversed = lista.slice().reverse();
  tbody.innerHTML = reversed.map(function(r,i){
    var realIdx = lista.length-1-i;
    var st = r.reprovado?'st-err':r.pct===100?'st-ok':r.pct>=50?'st-warn':'st-err';
    var pctLabel = r.reprovado ? '🚨 REPROVADO' : r.pct+'%'+(r.resetado?' ↺':'');
    return '<tr>'
      +'<td style="white-space:nowrap;font-size:12px">'+r.dataHora+'</td>'
      +'<td><strong>'+r.checklistNome+'</strong></td>'
      +'<td>'+r.setor+'</td>'
      +'<td>'+r.operador+'</td>'
      +'<td><span class="st '+(PCLS[r.perfil]||'st-ok')+'">'+(PLABEL[r.perfil]||r.perfil)+'</span></td>'
      +'<td><span class="st '+st+'">'+pctLabel+'</span></td>'
      +'<td style="font-size:12px">'+r.feitos+'/'+r.total+'</td>'
      +'<td><button class="btn btn-s btn-sm" onclick="verDetalhe('+realIdx+')">Ver</button></td>'
      +'</tr>';
  }).join('');
}

function verDetalhe(idx) {
  var resultados = getResultados();
  var r = resultados[idx];
  if (!r) return;
  var todasFotos = [];
  (r.itens||[]).forEach(function(item){
    if (item.fotoAntes) todasFotos.push({src:item.fotoAntes, label:'ANTES — '+item.texto});
    if (item.fotoDepois) todasFotos.push({src:item.fotoDepois, label:'DEPOIS — '+item.texto});
  });
  fotoFullList = todasFotos;

  // ── Cabeçalho ──
  document.getElementById('det-titulo').textContent = r.checklistNome;
  var badge = document.getElementById('det-badge');
  if (r.reprovado) { badge.textContent='🚨 REPROVADO'; badge.className='st st-err'; }
  else if (r.pct===100) { badge.textContent='✅ APROVADO'; badge.className='st st-ok'; }
  else { badge.textContent='⚠️ '+r.pct+'% concluído'; badge.className='st st-warn'; }

  // ── Meta ──
  var metaItems = [
    r.loja ? '🏪 '+r.loja : '',
    '👤 '+r.operador,
    '📂 '+r.setor,
    '🕐 '+r.dataHora
  ].filter(Boolean);
  document.getElementById('det-meta').innerHTML = metaItems.map(function(m){
    return '<span style="display:flex;align-items:center;gap:4px;padding:4px 10px;background:#fff;border-radius:20px;font-size:12px;font-weight:500;border:1px solid var(--gray2)">'+m+'</span>';
  }).join('');

  // ── KPIs ──
  var naoConformIds = (r.itens||[]).filter(function(it){ return it.tipo==='simNao'&&it.resposta==='nao'; }).length;
  var naoFeitos = (r.itens||[]).filter(function(it){ return it.tipo!=='planilha'&&!it.feito; }).length;
  var fotoCount = todasFotos.length;
  var pctColor = r.pct===100?'var(--g)':r.pct>=50?'var(--am)':'var(--r)';
  document.getElementById('det-kpis').innerHTML = [
    {val: r.pct+'%', label:'Conformidade', color: pctColor, bg: r.pct===100?'var(--g3)':r.pct>=50?'var(--am2)':'var(--r2)'},
    {val: r.feitos+'/'+r.total, label:'Itens Concluídos', color:'var(--bl)', bg:'var(--bl2)'},
    {val: fotoCount, label:'Fotos Registradas', color:'var(--t2)', bg:'var(--gray)'},
    {val: naoConformIds+naoFeitos, label:'Não Conformes', color: (naoConformIds+naoFeitos)>0?'var(--r)':'var(--g)', bg:(naoConformIds+naoFeitos)>0?'var(--r2)':'var(--g3)'}
  ].map(function(k){
    return '<div style="background:'+k.bg+';border-radius:12px;padding:16px 14px;text-align:center">'
      +'<div style="font-size:24px;font-weight:800;color:'+k.color+';font-family:\'Syne\',sans-serif">'+k.val+'</div>'
      +'<div style="font-size:11px;font-weight:600;color:var(--t2);margin-top:4px;text-transform:uppercase;letter-spacing:.4px">'+k.label+'</div>'
      +'</div>';
  }).join('');

  // ── Barra de progresso ──
  document.getElementById('det-pct-label').textContent = r.pct+'%';
  document.getElementById('det-pct-label').style.color = pctColor;
  document.getElementById('det-prog-bar').style.width = r.pct+'%';
  document.getElementById('det-prog-bar').style.background = pctColor;
  document.getElementById('det-itens-label').textContent = r.feitos+' de '+r.total+' itens concluídos';
  document.getElementById('det-data-label').textContent = r.dataHora;

  // ── Não-conformidades ──
  var nconformItens = (r.itens||[]).filter(function(it){
    return (it.tipo==='simNao'&&it.resposta==='nao') || (it.tipo!=='planilha'&&it.tipo!=='simNao'&&!it.feito);
  });
  var nconformEl = document.getElementById('det-nconform');
  if (nconformItens.length) {
    nconformEl.innerHTML = '<div style="background:#fff;border-radius:12px;padding:18px 20px;margin-bottom:18px;box-shadow:var(--sh);border-left:4px solid var(--r)">'
      +'<div style="font-size:12px;font-weight:800;color:var(--r);text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px">⚠ Não Conformidades ('+nconformItens.length+')</div>'
      +nconformItens.map(function(it){
        var justHtml = it.justificativa ? '<div style="margin-top:6px;padding:8px 12px;background:var(--r2);border-radius:8px;font-size:12px;color:var(--r)">📋 '+it.justificativa+'</div>' : '';
        return '<div style="padding:10px 12px;border-radius:8px;background:var(--r2);border:1px solid #fac5c0;margin-bottom:8px">'
          +'<div style="font-size:13px;font-weight:600;color:var(--r)">'+it.texto+'</div>'
          +(it.obs?'<div style="font-size:11px;color:var(--r);margin-top:2px;opacity:.7">'+it.obs+'</div>':'')
          +justHtml
          +'</div>';
      }).join('')
      +'</div>';
  } else {
    nconformEl.innerHTML = '';
  }
  // ── Itens do checklist (exceto planilha) ──
  var itensNormais = (r.itens||[]).filter(function(it){ return (it.tipo||'checkbox') !== 'planilha'; });
  var itensPlanilha = (r.itens||[]).filter(function(it){ return it.tipo === 'planilha'; });
  var fotosDosItens = todasFotos;

  document.getElementById('det-itens').innerHTML = itensNormais.length
    ? '<div style="background:#fff;border-radius:12px;padding:18px 20px;margin-bottom:18px;box-shadow:var(--sh)">'
      +'<div style="font-size:12px;font-weight:800;color:var(--t2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px">☑ Itens do Checklist</div>'
      +itensNormais.map(function(item){
          var tipo = item.tipo || 'checkbox';
          var fotoHtml = '';
          if (item.fotoAntes || item.fotoDepois) {
            if (item.fotoAntes) {
              var fi = fotosDosItens.findIndex(function(f){return f.src===item.fotoAntes;});
              fotoHtml += '<img src="'+item.fotoAntes+'" onclick="abrirFotoFull(fotoFullList,'+fi+')" style="width:80px;height:80px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid var(--gray2);margin-top:8px;margin-right:6px" title="ANTES"/>';
            }
            if (item.fotoDepois) {
              var fj = fotosDosItens.findIndex(function(f){return f.src===item.fotoDepois;});
              fotoHtml += '<img src="'+item.fotoDepois+'" onclick="abrirFotoFull(fotoFullList,'+fj+')" style="width:80px;height:80px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid var(--gray2);margin-top:8px" title="DEPOIS"/>';
            }
            fotoHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px">'+fotoHtml+'</div>';
          } else if (item.foto && item.foto !== 'none') {
            fotoHtml = '<div style="font-size:11px;color:var(--am);margin-top:6px;padding:5px 10px;background:var(--am2);border-radius:6px;display:inline-block">📷 Foto não enviada</div>';
          }
          var respostaHtml = '';
          if (tipo==='simNao') {
            var snL=item.resposta==='sim'?'✓ Sim':item.resposta==='nao'?'✗ Não':'—';
            var snC=item.resposta==='sim'?'var(--g)':item.resposta==='nao'?'var(--r)':'var(--t3)';
            respostaHtml='<span style="font-size:12px;font-weight:700;color:'+snC+'"> · '+snL+'</span>';
          } else if (tipo==='nota') {
            var nv=parseInt(item.resposta)||0;
            respostaHtml='<span style="font-size:12px;font-weight:700;color:var(--dk)"> · Nota: '+nv+'/5</span>';
          } else if (tipo==='texto'&&item.resposta) {
            respostaHtml='<div style="margin-top:5px;padding:6px 10px;background:var(--gray);border-radius:6px;font-size:12px;color:var(--t2)">'+item.resposta+'</div>';
          }
          var bg = !item.feito?'#fff':(tipo==='simNao'&&item.resposta==='nao')?'var(--r2)':'var(--g3)';
          var icon = tipo==='simNao'?(item.resposta==='sim'?'✅':item.resposta==='nao'?'❌':'⬜'):(item.feito?'✅':'⬜');
          var txtS = tipo==='checkbox'&&item.feito?'text-decoration:line-through;color:var(--t3)':'color:var(--t)';
          return '<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;background:'+bg+';border:1px solid var(--gray2);margin-bottom:8px">'
            +'<span style="font-size:17px;flex-shrink:0;margin-top:1px">'+icon+'</span>'
            +'<div style="flex:1;min-width:0">'
            +'<div style="font-size:13px;font-weight:600;'+txtS+'">'+item.texto
            +respostaHtml
            +(item.critico?'<span style="font-size:10px;font-weight:800;color:var(--r);background:var(--r2);padding:1px 6px;border-radius:20px;border:1px solid var(--r);margin-left:6px">⚠ CRÍTICO</span>':'')
            +'</div>'
            +(item.obs?'<div style="font-size:11px;color:var(--t3);margin-top:2px">'+item.obs+'</div>':'')
            +(item.justificativa?'<div style="margin-top:6px;padding:6px 10px;background:var(--r2);border-radius:6px;font-size:12px;color:var(--r)">📋 '+item.justificativa+'</div>':'')
            +fotoHtml
            +'</div></div>';
        }).join('')
      +'</div>'
    : '';

  // ── Contagem de Estoque (planilha) ──
  document.getElementById('det-fotos').innerHTML = itensPlanilha.map(function(item){
    if (!item.produtos || !item.produtos.length) return '';
    var preenchidos = item.produtos.filter(function(p){ return p.quantidade && p.quantidade !== ''; }).length;
    var totalP = item.produtos.length;
    return '<div style="background:#fff;border-radius:12px;padding:18px 20px;margin-bottom:18px;box-shadow:var(--sh)">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">'
      +'<div style="font-size:12px;font-weight:800;color:var(--t2);text-transform:uppercase;letter-spacing:.6px">📊 '+item.texto+'</div>'
      +'<span style="font-size:12px;font-weight:700;color:var(--bl);background:var(--bl2);padding:3px 10px;border-radius:20px">'+preenchidos+'/'+totalP+' preenchidos</span>'
      +'</div>'
      +'<div style="overflow-x:auto">'
      +'<table style="width:100%;border-collapse:collapse;font-size:13px">'
      +'<thead><tr style="border-bottom:2px solid var(--gray2)">'
      +'<th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.4px">Código</th>'
      +'<th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.4px">Descrição</th>'
      +'<th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.4px">Setor</th>'
      +'<th style="padding:8px 10px;text-align:center;font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.4px">Qtd</th>'
      +'</tr></thead><tbody>'
      +item.produtos.map(function(p, pi){
          var semQtd = !p.quantidade || p.quantidade === '';
          return '<tr style="border-bottom:1px solid var(--gray2);background:'+(pi%2===0?'#fff':'#fafafa')+'">'
            +'<td style="padding:9px 10px;font-size:12px;color:var(--t3);font-family:monospace">'+p.codigo+'</td>'
            +'<td style="padding:9px 10px;font-weight:500;color:var(--t)">'+p.descricao+'</td>'
            +'<td style="padding:9px 10px;font-size:12px;color:var(--t2)">'+( p.setor||'—')+'</td>'
            +'<td style="padding:9px 10px;text-align:center;font-size:15px;font-weight:800;color:'+(semQtd?'var(--t3)':'var(--g)')+'">'+( semQtd?'—':p.quantidade)+'</td>'
            +'</tr>';
        }).join('')
      +'</tbody></table></div></div>';
  }).join('');

  // ── Assinatura ──
  document.getElementById('det-assinatura').innerHTML = r.assinatura
    ? '<div style="background:#fff;border-radius:12px;padding:18px 20px;box-shadow:var(--sh)">'
      +'<div style="font-size:12px;font-weight:800;color:var(--t2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">✍ Assinatura Digital</div>'
      +'<img src="'+r.assinatura+'" style="max-width:280px;border:1px solid var(--gray2);border-radius:8px;background:#fff"/>'
      +'</div>'
    : '';

  document.getElementById('modal-det').style.display='block';
  document.getElementById('modal-det').scrollTop = 0;
}

// ── Fotos pendentes ──
function irParaFotosPendentes() {
  document.getElementById('modal-foto-pendente').style.display='none';
  // Navigate to checklist execute tab
  var clItem = document.querySelector('.sb-item[onclick*="checklist"]');
  nav('checklist', clItem);
  var execTab = document.querySelector('#cl-mode-tabs .tab');
  if (execTab) setCLMode('executar', execTab);
}

function enviarSemFoto() {
  document.getElementById('modal-foto-pendente').style.display='none';
  var clId = document.getElementById('fp-cl-id').value;
  var label = document.getElementById('fp-cl-label').value;
  // Skip photo check and go straight to send modal
  var cl = getMyCLs().find(function(c){return c.id===clId;});
  if (!cl) return;
  var feitos = cl.itens.filter(function(i){return !!S.checkState[clId+'_'+i.t];}).length;
  var total = cl.itens.length;
  var pct = total ? Math.round(feitos/total*100) : 0;
  pendingEnviarId = clId;
  pendingEnviarLabel = label;
  document.getElementById('env-titulo').textContent = label;
  document.getElementById('env-pct').textContent = pct+'%';
  document.getElementById('env-itens').textContent = feitos+'/'+total+' itens concluidos';
  var icon = document.getElementById('env-icon');
  var msg = document.getElementById('env-msg');
  icon.textContent = '⚠️';
  msg.textContent = 'Algumas fotos obrigatórias não foram enviadas.';
  msg.style.color = 'var(--am)';
  var fill = document.getElementById('env-bar-fill');
  fill.style.width = pct+'%';
  fill.style.background = 'var(--am)';
  document.getElementById('modal-enviar').style.display = 'flex';
}

// ── Foto fullscreen ──
var fotoFullList = [];
var fotoFullIdx = 0;

function abrirFotoFull(fotos, idx) {
  fotoFullList = fotos;
  fotoFullIdx = idx || 0;
  renderFotoFull();
  document.getElementById('modal-foto-full').style.display = 'flex';
}

function renderFotoFull() {
  var foto = fotoFullList[fotoFullIdx];
  if (!foto) return;
  document.getElementById('foto-full-img').src = foto.src;
  document.getElementById('foto-full-label').textContent = foto.label || '';
  document.getElementById('foto-full-counter').textContent = (fotoFullIdx+1)+'/'+fotoFullList.length;
  // Thumbnails
  var thumbs = document.getElementById('foto-full-thumbnails');
  thumbs.innerHTML = fotoFullList.map(function(f,i){
    return '<img src="'+f.src+'" onclick="fotoFullIdx='+i+';renderFotoFull()" '
      +'style="width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid '+(i===fotoFullIdx?'#FFC600':'rgba(255,255,255,.3)')+'"/>';
  }).join('');
}

function navFoto(dir) {
  fotoFullIdx = (fotoFullIdx + dir + fotoFullList.length) % fotoFullList.length;
  renderFotoFull();
}

function downloadFotoAtual() {
  var foto = fotoFullList[fotoFullIdx];
  if (!foto) return;
  var a = document.createElement('a');
  a.href = foto.src;
  a.download = (foto.label||'foto').replace(/\s/g,'_')+'_'+Date.now()+'.jpg';
  a.click();
}

var centralTabAtual = 'checklist';

function switchCentralTab(tab, btn) {
  centralTabAtual = tab;
  ['checklist','inventario','perdas','plano'].forEach(function(t){
    var el = document.getElementById('central-tab-'+t);
    if (el) el.style.display = t===tab ? 'block' : 'none';
  });
  document.querySelectorAll('#central-tabs .tab').forEach(function(t){t.classList.remove('on');});
  if (btn) btn.classList.add('on');
  if (tab === 'plano') {
    loadPlanosFromFirebase(function(){ renderCentralPlanos(); });
    return;
  }
  renderCentralAtual();
}

function renderCentralAtual() {
  if (centralTabAtual === 'checklist') renderCentral();
  // inventario e perdas: dados da sessão atual
  if (centralTabAtual === 'inventario') {
    document.getElementById('cinv-total').textContent = S.invItems.length;
    var divs = S.invItems.filter(function(i){return i.fis!==i.sist;}).length;
    document.getElementById('cinv-div').textContent = divs;
    document.getElementById('cinv-ok').textContent = S.invItems.length - divs;
    document.getElementById('cinv-ops').textContent = S.currentUser ? 1 : 0;
  }
  if (centralTabAtual === 'perdas') {
    var total = S.perdaItems.reduce(function(s,i){return s+i.total;},0);
    document.getElementById('cperd-total').textContent = 'R$ '+total.toFixed(2);
    document.getElementById('cperd-cnt').textContent = S.perdaItems.length;
    var maior = S.perdaItems.length ? S.perdaItems.reduce(function(a,b){return b.total>a.total?b:a;}) : {total:0};
    document.getElementById('cperd-maior').textContent = 'R$ '+maior.total.toFixed(2);
    document.getElementById('cperd-ops').textContent = S.currentUser ? 1 : 0;
  }
}

function limparFiltrosPlanos() {
  ['cf-loja-plano','cf-status-plano'].forEach(function(id){ var e=document.getElementById(id); if(e) e.value=''; });
  renderCentralPlanos();
}

function renderCentralPlanos() {
  var lista = getPlanos().slice().sort(function(a, b){
    return (b.criadoTimestamp||b.criadoEm||'') > (a.criadoTimestamp||a.criadoEm||'') ? 1 : -1;
  });

  // Popular select de lojas
  var lojaSelect = document.getElementById('cf-loja-plano');
  if (lojaSelect) {
    var lojas = [];
    getPlanos().forEach(function(p){ if(p.loja && lojas.indexOf(p.loja)<0) lojas.push(p.loja); });
    lojas.sort();
    var lojaVal = lojaSelect.value;
    lojaSelect.innerHTML = '<option value="">Todas</option>' + lojas.map(function(l){ return '<option value="'+l+'"'+(l===lojaVal?' selected':'')+'>'+l+'</option>'; }).join('');
  }

  var fl = (document.getElementById('cf-loja-plano')||{}).value||'';
  var fst = (document.getElementById('cf-status-plano')||{}).value||'';
  if (fl) lista = lista.filter(function(p){ return (p.loja||'')=== fl; });
  if (fst) lista = lista.filter(function(p){ return p.status === fst; });

  // Métricas
  var tot = lista.length;
  var res = lista.filter(function(p){return p.status==='resolvido';}).length;
  var and = lista.filter(function(p){return p.status==='andamento';}).length;
  var abe = lista.filter(function(p){return p.status==='aberto';}).length;
  var el = function(id,v){ var e=document.getElementById(id); if(e) e.textContent=v; };
  el('cplano-total', tot); el('cplano-resolvidos', res); el('cplano-andamento', and); el('cplano-abertos', abe);

  var wrap = document.getElementById('cplano-lista');
  if (!wrap) return;

  var COR = {aberto:'var(--r)',andamento:'var(--am)',resolvido:'var(--g)'};
  var LABEL = {aberto:'🔴 Aberto',andamento:'🟡 Em Andamento',resolvido:'✅ Resolvido'};
  var PERFIL = {operator:'Operador',prevencao:'Prevenção',gerencia:'Gerência',admin:'Administrador'};

  // Seção de prorrogações pendentes para aprovação
  var todosPlanos = getPlanos();
  var prorrogPendentes = [];
  todosPlanos.forEach(function(p){
    (p.prorrogacoes||[]).filter(function(pr){ return pr.status==='pendente'; }).forEach(function(pr){
      prorrogPendentes.push({ plano:p, prorr:pr });
    });
  });
  var prorrogHtml = '';
  if (prorrogPendentes.length) {
    prorrogHtml = '<div style="background:#fff8e1;border:1.5px solid #fde68a;border-radius:10px;padding:14px 16px;margin-bottom:16px">'
      +'<div style="font-size:13px;font-weight:700;color:#b45309;margin-bottom:10px">⏳ '+prorrogPendentes.length+' Solicitação(ões) de Prorrogação Pendente(s)</div>'
      +prorrogPendentes.map(function(item){
        var p=item.plano; var pr=item.prorr;
        return '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;background:#fff;border-radius:8px;margin-bottom:6px;border:1px solid #fde68a">'
          +'<div style="flex:1;min-width:200px">'
          +'<div style="font-size:12px;font-weight:700;color:var(--t)">'+p.desc+'</div>'
          +(p.loja?'<div style="font-size:11px;color:#b45309">🏪 '+p.loja+'</div>':'')
          +'<div style="font-size:11px;color:var(--t2);margin-top:2px">Solicitado por <strong>'+pr.solicitadoPor+'</strong> · +'+pr.horasExtras+'h · "'+pr.motivo+'"</div>'
          +'<div style="font-size:10px;color:var(--t3)">'+pr.solicitadoEm+'</div>'
          +'</div>'
          +'<div style="display:flex;gap:6px">'
          +'<button class="btn btn-p btn-sm" onclick="avaliarProrrogacao(\''+p.id+'\',\''+pr.id+'\',true)">✓ Aprovar</button>'
          +'<button class="btn btn-s btn-sm" onclick="avaliarProrrogacao(\''+p.id+'\',\''+pr.id+'\',false)">✗ Rejeitar</button>'
          +'</div>'
          +'</div>';
      }).join('')
      +'</div>';
  }

  if (!lista.length) {
    wrap.innerHTML = prorrogHtml + '<div style="padding:32px;text-align:center;color:var(--t3);font-size:13px">Nenhum plano de ação registrado.</div>';
    return;
  }

  wrap.innerHTML = prorrogHtml + lista.map(function(p){
    var cor = COR[p.status]||'var(--t3)';
    var inf = _prazoInfo(p);
    var prazoTag = (inf && p.status !== 'resolvido') ? '<span style="padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:'+inf.cor+';margin-left:4px">⏱ '+inf.texto+'</span>' : '';
    var ini = p.iniciadoPor ? ('<div style="font-size:12px;color:var(--t2);margin-top:4px">▶ Iniciado por <strong>'+p.iniciadoPor.nome+'</strong>'+(p.iniciadoPor.perfil?' ('+PERFIL[p.iniciadoPor.perfil]||p.iniciadoPor.perfil+')':'')+(p.iniciadoPor.em?' — '+p.iniciadoPor.em:'')+'</div>') : '';
    var loja = p.loja ? '<span style="background:#fff8e1;color:#b45309;border-radius:5px;padding:1px 7px;font-size:11px;font-weight:600;margin-right:6px">🏪 '+p.loja+'</span>' : '';
    var mensagemTag = (p.mensagem && p.status!=='resolvido') ? '<div style="font-size:11px;color:#0369a1;margin-top:4px">💬 '+p.mensagem+'</div>' : '';
    var concl = '';
    if (p.conclusao && p.conclusao.texto) {
      concl = '<div style="margin-top:10px;padding:10px 12px;background:#f0fdf4;border-left:3px solid var(--g);border-radius:6px">'
        +'<div style="font-size:11px;font-weight:600;color:var(--g);margin-bottom:4px">✅ Conclusão</div>'
        +'<div style="font-size:12px;color:var(--t)">'+p.conclusao.texto+'</div>'
        +(p.conclusao.foto ? '<div style="margin-top:8px"><img src="'+p.conclusao.foto+'" style="max-width:100%;max-height:200px;border-radius:8px;object-fit:cover;border:1px solid var(--gray2)"/></div>' : '')
        +'</div>';
    }
    return '<div style="border:1px solid var(--gray2);border-left:4px solid '+cor+';border-radius:10px;padding:14px 16px;margin-bottom:10px;background:#fff">'
      +'<div style="flex:1;min-width:0">'
      +'<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:4px">'+loja+'<span style="font-size:13px;font-weight:700;color:var(--t)">'+p.desc+'</span>'+prazoTag+'</div>'
      +(p.origem?'<div style="font-size:11px;color:var(--t3)">📋 '+p.origem+'</div>':'')
      +'<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--t2);margin-top:4px">'
      +'<span style="color:'+cor+';font-weight:600">'+LABEL[p.status]+'</span>'
      +(p.responsavel?'<span>👤 '+p.responsavel+'</span>':'')
      +(p.prazo?'<span>📅 Prazo: '+p.prazo+'</span>':'')
      +(p.resolvidoEm?'<span>✅ '+p.resolvidoEm+'</span>':'')
      +'</div>'
      +ini+mensagemTag+concl
      +'</div>'
      +'<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">'
      +'<div style="font-size:10px;color:var(--t3)">Criado em '+p.criadoEm+' por '+p.criadoPor+'</div>'
      +'<button onclick="excluirPlanoCentral(\''+p.id+'\')" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--r);padding:2px 6px;border-radius:4px;opacity:.7" title="Excluir plano">🗑 Excluir</button>'
      +'</div>'
      +'</div>';
  }).join('');
}

function excluirPlanoCentral(planoId) {
  var p = getPlanos().find(function(x){ return x.id === planoId; });
  if (!p) return;
  if (!confirm('Excluir o plano de ação "' + p.desc + '"?\nEssa ação não pode ser desfeita.')) return;
  var lista = getPlanos().filter(function(x){ return x.id !== planoId; });
  savePlanos(lista);
  if (db) db.collection('planos').doc(planoId).delete().catch(function(){});
  renderCentralPlanos();
  showToast('Plano excluído.');
}

function limparFiltrosCentral() {
  ['cf-setor','cf-op','cf-dt-ini','cf-dt-fim'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.value='';
  });
  renderCentral();
}

function limparCentral() {
  document.getElementById('modal-limpar-central').style.display = 'flex';
  document.getElementById('limpar-senha-input').value = '';
  document.getElementById('limpar-senha-err').style.display = 'none';
}
function confirmarLimparCentral() {
  var senha = document.getElementById('limpar-senha-input').value;
  var adminSenha = DEFAULT_USERS[0].senha;
  if (senha !== adminSenha) {
    document.getElementById('limpar-senha-err').style.display = 'block';
    return;
  }
  limparResultadosFirebase();
  S.resultadosCache = [];
  document.getElementById('modal-limpar-central').style.display = 'none';
  renderCentral();
  showToast('Historico apagado com sucesso!');
}

// ===========================================
// INVENTÁRIO
// ===========================================
function addInv() {
  var cod=document.getElementById('inv-cod').value||'-';
  var desc=document.getElementById('inv-desc').value.trim();
  var setor=document.getElementById('inv-setor').value;
  var sist=parseFloat(document.getElementById('inv-sist').value)||0;
  var fis=parseFloat(document.getElementById('inv-fis').value)||0;
  var unid=document.getElementById('inv-unid').value;
  var obs=document.getElementById('inv-obs').value;
  if (!desc) { alert('Informe a descrição.'); return; }
  S.invItems.push({cod:cod,desc:desc,setor:setor,sist:sist,fis:fis,unid:unid,obs:obs});
  saveInvToFirebase();
  renderInv();
  ['inv-cod','inv-desc','inv-sist','inv-fis','inv-obs'].forEach(function(id){document.getElementById(id).value='';});
  updateDash();
}

function renderInv() {
  var tbody=document.getElementById('inv-tbody');
  if (!S.invItems.length) {
    tbody.innerHTML='<tr class="erow"><td colspan="8">Nenhum item lançado ainda</td></tr>';
    document.getElementById('inv-cnt').textContent='0';
    document.getElementById('inv-div').textContent='0';
    document.getElementById('inv-saldo').textContent='0 un';
    return;
  }
  var divs=0, saldo=0;
  tbody.innerHTML=S.invItems.map(function(it){
    var d=it.fis-it.sist; saldo+=d; if(d!==0)divs++;
    var st=d===0?'st-ok':d>0?'st-warn':'st-err';
    var sl=d===0?'OK':(d>0?'+':'')+d;
    return '<tr><td>'+it.cod+'</td><td>'+it.desc+'</td><td>'+it.setor+'</td>'
      +'<td>'+it.sist+' '+it.unid+'</td><td>'+it.fis+' '+it.unid+'</td>'
      +'<td>'+(d>0?'+':'')+d+' '+it.unid+'</td>'
      +'<td>'+(it.obs||'-')+'</td>'
      +'<td><span class="st '+st+'">'+sl+'</span></td></tr>';
  }).join('');
  document.getElementById('inv-cnt').textContent=S.invItems.length;
  document.getElementById('inv-div').textContent=divs;
  document.getElementById('inv-saldo').textContent=(saldo>0?'+':'')+saldo+' un';
}

function enviarInv() {
  if (!S.invItems.length) { alert('Nenhum item para enviar.'); return; }
  showAlert('inv-alert');
  addHist('Inventário',S.invItems.length+' itens enviados','Geral','st-info','Enviado');
  updateDash();
}

function limparInv() {
  S.invItems=[]; renderInv(); updateDash();
}

// ===========================================
// PERDAS
// ===========================================
function addPerda() {
  var prod=document.getElementById('p-prod').value.trim();
  var setor=document.getElementById('p-setor').value;
  var motivo=document.getElementById('p-motivo').value;
  var qtd=parseFloat(document.getElementById('p-qtd').value)||0;
  var valor=parseFloat(document.getElementById('p-valor').value)||0;
  var obs=document.getElementById('p-obs').value;
  if (!prod||qtd===0) { alert('Informe produto e quantidade.'); return; }
  var total=qtd*valor;
  var now=new Date();
  var hora=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  var perdaItem = {prod:prod,setor:setor,motivo:motivo,qtd:qtd,valor:valor,total:total,hora:hora,obs:obs};
  S.perdaItems.push(perdaItem);
  savePerdaToFirebase(perdaItem);
  renderPerdas();
  ['p-prod','p-cod','p-qtd','p-valor','p-obs'].forEach(function(id){document.getElementById(id).value='';});
  showAlert('p-alert');
  addHist('Perda',prod+' - '+qtd+' un ('+motivo+')',setor,'st-err','Lançado');
  updateDash();
}

function renderPerdas() {
  var tbody=document.getElementById('p-tbody');
  if (!S.perdaItems.length) {
    tbody.innerHTML='<tr class="erow"><td colspan="8">Nenhuma perda registrada hoje</td></tr>';
    document.getElementById('p-total').textContent='R$ 0,00';
    document.getElementById('p-cnt').textContent='0';
    document.getElementById('p-maior').textContent='-';
    document.getElementById('p-maior-prod').textContent='-';
    return;
  }
  var totalG=0, maior={total:0,prod:''};
  tbody.innerHTML=S.perdaItems.map(function(it){
    totalG+=it.total;
    if(it.total>maior.total)maior={total:it.total,prod:it.prod};
    return '<tr><td>'+it.hora+'</td><td>'+it.prod+'</td><td>'+it.setor+'</td>'
      +'<td>'+it.motivo+'</td><td>'+it.qtd+'</td>'
      +'<td>R$ '+it.valor.toFixed(2)+'</td>'
      +'<td><strong>R$ '+it.total.toFixed(2)+'</strong></td>'
      +'<td><span class="st st-err">Lançado</span></td></tr>';
  }).join('');
  document.getElementById('p-total').textContent='R$ '+totalG.toFixed(2);
  document.getElementById('p-cnt').textContent=S.perdaItems.length;
  document.getElementById('p-maior').textContent='R$ '+maior.total.toFixed(2);
  document.getElementById('p-maior-prod').textContent=maior.prod;
}

function limparPerdas() {
  S.perdaItems=[]; renderPerdas(); updateDash();
}

// ===========================================
// USUÁRIOS
// ===========================================
var editingUserId=null, userFilter='todos';

function abrirModalUser() {
  editingUserId=null;
  document.getElementById('mu-title').textContent='Novo Usuário';
  ['u-nome','u-email','u-senha','u-senha2','u-cargo','u-loja'].forEach(function(id){document.getElementById(id).value='';});
  document.getElementById('u-perfil').value='operator';
  document.getElementById('u-setor').value='Geral';
  document.getElementById('mu-err').style.display='none';
  var hint=document.getElementById('senha-hint');
  if (hint) hint.textContent='';
  document.getElementById('modal-user').style.display='flex';
}

function fecharModalUser() {
  document.getElementById('modal-user').style.display='none';
  editingUserId=null;
}

function editarUser(id) {
  var u=getUsers().find(function(x){return x.id===id;});
  if (!u) return;
  editingUserId=id;
  document.getElementById('mu-title').textContent='Editar Usuário';
  document.getElementById('u-nome').value=u.nome;
  document.getElementById('u-email').value=u.email;
  document.getElementById('u-senha').value='';   // nunca exibe hash/senha
  document.getElementById('u-senha2').value='';
  document.getElementById('u-perfil').value=u.perfil;
  document.getElementById('u-setor').value=u.setor||'Geral';
  document.getElementById('u-cargo').value=u.cargo||'';
  document.getElementById('u-loja').value=u.loja||'';
  document.getElementById('mu-err').style.display='none';
  var hint=document.getElementById('senha-hint');
  if (hint) hint.textContent='(em branco = manter atual)';
  document.getElementById('modal-user').style.display='flex';
}

function salvarUser() {
  var nome=document.getElementById('u-nome').value.trim();
  var email=document.getElementById('u-email').value.trim().toLowerCase();
  var senha=document.getElementById('u-senha').value;
  var senha2=document.getElementById('u-senha2').value;
  var perfil=document.getElementById('u-perfil').value;
  var setor=document.getElementById('u-setor').value;
  var cargo=document.getElementById('u-cargo').value.trim();
  var loja=document.getElementById('u-loja').value.trim();
  var err=document.getElementById('mu-err');
  if (!nome){err.textContent='Informe o nome.';err.style.display='block';return;}
  if (!email||email.indexOf('@')<0){err.textContent='E-mail inválido.';err.style.display='block';return;}
  // Ao editar: senha em branco = manter a existente
  var trocandoSenha = senha.length > 0;
  if (!editingUserId && !trocandoSenha){err.textContent='Informe uma senha.';err.style.display='block';return;}
  if (trocandoSenha && senha.length<4){err.textContent='Senha com mínimo 4 caracteres.';err.style.display='block';return;}
  if (trocandoSenha && senha!==senha2){err.textContent='Senhas não coincidem.';err.style.display='block';return;}
  var users=getUsers();
  var dup=users.find(function(u){return u.email.toLowerCase()===email && u.id!==editingUserId;});
  if (dup){err.textContent='E-mail já cadastrado.';err.style.display='block';return;}

  function aplicarSalvar(senhaFinal) {
    if (editingUserId) {
      var existing = users.find(function(u){return u.id===editingUserId;}) || {};
      // Admin nunca perde o perfil 'admin' pelo select (select não tem essa opção)
      var perfilFinal = editingUserId==='admin' ? 'admin' : perfil;
      var updates = {nome:nome, email:email, perfil:perfilFinal, setor:setor, cargo:cargo, loja:loja};
      if (senhaFinal) updates.senha = senhaFinal;
      users=users.map(function(u){return u.id===editingUserId?Object.assign({},u,updates):u;});
    } else {
      users.push({id:genId(),nome:nome,email:email,senha:senhaFinal,perfil:perfil,setor:setor,cargo:cargo,loja:loja,ativo:true});
    }
    saveUsers(users);
    fecharModalUser();
    renderUsers();
  }

  if (trocandoSenha) {
    hashPassword(senha).then(function(hash){ aplicarSalvar(hash); });
  } else {
    aplicarSalvar(null); // mantém senha existente
  }
}

function excluirUser(id) {
  if (!confirm('Excluir este usuário?')) return;
  saveUsers(getUsers().filter(function(u){return u.id!==id;}));
  renderUsers();
}

function toggleAtivo(id) {
  saveUsers(getUsers().map(function(u){return u.id===id?Object.assign({},u,{ativo:!u.ativo}):u;}));
  renderUsers();
}

function filtrarUsers(f,btn) {
  userFilter=f;
  document.querySelectorAll('#u-filter-tabs .tab').forEach(function(t){t.classList.remove('on');});
  btn.classList.add('on');
  renderUsers();
}

var UPLABEL={admin:'Administrador',gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
var UPCLS={admin:'st-info',gerencia:'st-info',operator:'st-ok',prevencao:'st-err'};

function renderUsers() {
  var users=getUsers();
  // Isolamento: gerência vê apenas usuários da sua loja; admin vê todos
  if (S.currentUser && S.currentUser.perfil !== 'admin' && S.currentUser.loja) {
    var myLoja=(S.currentUser.loja||'').trim().toLowerCase();
    users=users.filter(function(u){ return (u.loja||'').trim().toLowerCase()===myLoja; });
  }
  var filtered=userFilter==='todos'?users:users.filter(function(u){return u.perfil===userFilter;});
  var tbody=document.getElementById('u-tbody');
  if (!filtered.length){tbody.innerHTML='<tr class="erow"><td colspan="8">Nenhum usuário neste perfil</td></tr>';return;}
  tbody.innerHTML=filtered.map(function(u){
    var actions = u.id==='admin'
      ? '<button class="btn btn-s btn-sm" onclick="editarUser(\''+u.id+'\')">Editar</button>'
        +'<span style="font-size:11px;color:var(--t3);margin-left:4px">sem exclusão</span>'
      : '<button class="btn btn-s btn-sm" onclick="editarUser(\''+u.id+'\')">Editar</button>'
        +'<button class="btn btn-s btn-sm" onclick="toggleAtivo(\''+u.id+'\')" style="'+(u.ativo?'color:var(--am)':'color:var(--g)')+'">'+(u.ativo?'Inativar':'Ativar')+'</button>'
        +'<button class="btn btn-d btn-sm" onclick="excluirUser(\''+u.id+'\')">Excluir</button>';
    return '<tr><td><strong>'+u.nome+'</strong></td><td>'+u.email+'</td>'
      +'<td><span class="st '+(UPCLS[u.perfil]||'st-ok')+'">'+(UPLABEL[u.perfil]||u.perfil)+'</span></td>'
      +'<td>'+(u.loja||'-')+'</td>'
      +'<td>'+(u.setor||'-')+'</td>'
      +'<td style="font-size:12px;color:var(--t3)">'+(u.cargo||'-')+'</td>'
      +'<td><span class="st '+(u.ativo?'st-ok':'st-warn')+'">'+(u.ativo?'Ativo':'Inativo')+'</span></td>'
      +'<td style="display:flex;gap:4px;flex-wrap:wrap">'+actions+'</td></tr>';
  }).join('');
  document.getElementById('u-ger').textContent=users.filter(function(u){return u.perfil==='gerencia';}).length;
  document.getElementById('u-op').textContent=users.filter(function(u){return u.perfil==='operator';}).length;
  document.getElementById('u-prev').textContent=users.filter(function(u){return u.perfil==='prevencao';}).length;
}

// ===========================================
// DASHBOARD
// ===========================================
function addHist(tipo,desc,setor,stCls,stLabel) {
  var now=new Date();
  var hora=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  S.historico.unshift({hora,tipo,desc,setor,stCls,stLabel,op:S.currentUser?S.currentUser.nome:'-'});
}

function updateDash() {
  var isAdmin = S.role==='admin';
  var isGer = S.role==='gerencia';
  var isAdmOrGer = isAdmin||isGer;

  var agora = new Date();
  var hojeStr = agora.toLocaleDateString('pt-BR');
  var ontemDate = new Date(agora); ontemDate.setDate(ontemDate.getDate()-1);
  var ontemStr = ontemDate.toLocaleDateString('pt-BR');

  var resultados = getResultados();
  var resultadosHoje = resultados.filter(function(r){ return r.dataHora && r.dataHora.indexOf(hojeStr)===0; });
  var resultadosOntem = resultados.filter(function(r){ return r.dataHora && r.dataHora.indexOf(ontemStr)===0; });

  // ── Header ──
  var lojaNome = (S.currentUser && S.currentUser.loja) ? S.currentUser.loja : 'Cahu360';
  var dataFull = agora.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  var lojaNomeEl = document.getElementById('dash-loja-nome');
  var dataFullEl = document.getElementById('dash-data-full');
  if (lojaNomeEl) lojaNomeEl.textContent = lojaNome;
  if (dataFullEl) dataFullEl.textContent = dataFull.charAt(0).toUpperCase()+dataFull.slice(1);

  if (isAdmOrGer) {
    var totalEnvios = resultadosHoje.length;
    var completos = resultadosHoje.filter(function(r){return r.pct===100;}).length;
    var mediaGeral = totalEnvios ? Math.round(resultadosHoje.reduce(function(s,r){return s+r.pct;},0)/totalEnvios) : 0;

    // KPI: Checklists Hoje
    document.getElementById('dck-val').textContent = completos+'/'+totalEnvios+' envios';
    document.getElementById('dck-bar').style.width = mediaGeral+'%';
    document.getElementById('dck-pct').textContent = totalEnvios ? mediaGeral+'% média hoje' : 'Nenhum envio hoje';

    // KPI: Conformidade
    var dconfEl = document.getElementById('dconf-val');
    var dconfSubEl = document.getElementById('dconf-sub');
    if (dconfEl) {
      dconfEl.textContent = totalEnvios ? mediaGeral+'%' : '—';
      dconfEl.style.color = mediaGeral>=80 ? 'var(--g)' : mediaGeral>=60 ? 'var(--am)' : totalEnvios ? 'var(--r)' : 'var(--t3)';
    }
    if (dconfSubEl) dconfSubEl.textContent = '100% completos: '+completos;

    // Trends (vs ontem)
    var mediOntem = resultadosOntem.length ? Math.round(resultadosOntem.reduce(function(s,r){return s+r.pct;},0)/resultadosOntem.length) : null;
    var trendCkEl = document.getElementById('dck-trend');
    var trendConfEl = document.getElementById('dconf-trend');
    if (mediOntem !== null) {
      var diff = mediaGeral - mediOntem;
      var trendTxt = (diff>=0?'↑':'↓')+' '+Math.abs(diff)+'% vs ontem';
      var trendCor = diff>=0 ? 'var(--g)' : 'var(--r)';
      if (trendCkEl) { trendCkEl.textContent=trendTxt; trendCkEl.style.color=trendCor; }
      if (trendConfEl) { trendConfEl.textContent=trendTxt; trendConfEl.style.color=trendCor; }
    } else {
      if (trendCkEl) trendCkEl.textContent='';
      if (trendConfEl) trendConfEl.textContent='';
    }

    // KPI: Operadores ativos
    var opsAtivos = [];
    resultadosHoje.forEach(function(r){ if(opsAtivos.indexOf(r.operador)<0) opsAtivos.push(r.operador); });
    var dopsEl = document.getElementById('dops-val');
    var dopsSubEl = document.getElementById('dops-sub');
    if (dopsEl) dopsEl.textContent = opsAtivos.length;
    if (dopsSubEl) dopsSubEl.textContent = opsAtivos.length===1 ? 'operador enviou hoje' : 'operadores enviaram hoje';

    // Indicador de saúde
    var saudeDot = document.getElementById('dash-saude-dot');
    var saudeLabel = document.getElementById('dash-saude-label');
    var saudeEl = document.getElementById('dash-saude');
    if (saudeDot && saudeLabel) {
      if (!totalEnvios) {
        saudeDot.style.background='#9ca3af'; saudeLabel.textContent='Aguardando envios'; saudeLabel.style.color='var(--t3)';
        if (saudeEl) saudeEl.style.borderColor='var(--gray2)';
      } else if (mediaGeral>=80) {
        saudeDot.style.background='var(--g2)'; saudeLabel.textContent='Operação normal'; saudeLabel.style.color='var(--g)';
        if (saudeEl) saudeEl.style.borderColor='var(--g2)';
      } else if (mediaGeral>=60) {
        saudeDot.style.background='var(--am)'; saudeLabel.textContent='Atenção necessária'; saudeLabel.style.color='var(--am)';
        if (saudeEl) saudeEl.style.borderColor='var(--am)';
      } else {
        saudeDot.style.background='var(--r)'; saudeLabel.textContent='Conformidade crítica'; saudeLabel.style.color='var(--r)';
        if (saudeEl) saudeEl.style.borderColor='var(--r)';
      }
    }

    // Status da equipe
    var dashEquipe = document.getElementById('dash-equipe');
    var dashEquipeResumo = document.getElementById('dash-equipe-resumo');
    if (dashEquipe) {
      var users = getUsers().filter(function(u){ return u.id!=='admin' && u.ativo; });
      if (!users.length) {
        dashEquipe.innerHTML='<div style="text-align:center;color:var(--t3);font-size:13px;padding:20px;grid-column:1/-1">Nenhum usuário cadastrado</div>';
      } else {
        var enviados=0;
        var perfisLabel={gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
        dashEquipe.innerHTML = users.map(function(u){
          var urs = resultadosHoje.filter(function(r){return r.operador===u.nome;});
          var enviou = urs.length>0;
          var media = enviou ? Math.round(urs.reduce(function(s,r){return s+r.pct;},0)/urs.length) : null;
          if (enviou) enviados++;
          var cor = !enviou?'#9ca3af':media===100?'var(--g2)':media>=80?'#2d9e62':media>=60?'var(--am)':'var(--r)';
          var bg  = !enviou?'var(--gray)':media===100?'var(--g3)':media>=60?'var(--am2)':'var(--r2)';
          return '<div style="padding:10px 12px;border-radius:10px;background:'+bg+';border:1.5px solid '+cor+'">'
            +'<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">'
            +'<div style="width:8px;height:8px;border-radius:50%;background:'+cor+';flex-shrink:0"></div>'
            +'<div style="font-size:12px;font-weight:600;color:var(--t);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+u.nome+'</div>'
            +'</div>'
            +'<div style="font-size:10px;color:var(--t3);margin-bottom:4px">'+(perfisLabel[u.perfil]||u.perfil)+'</div>'
            +(enviou
              ?'<div style="font-size:14px;font-weight:800;color:'+cor+'">'+media+'%</div>'
               +'<div style="font-size:10px;color:var(--t3)">'+urs.length+' envio'+(urs.length>1?'s':'')+'</div>'
              :'<div style="font-size:11px;color:#9ca3af;font-weight:600">Pendente</div>')
            +'</div>';
        }).join('');
        if (dashEquipeResumo) dashEquipeResumo.textContent = enviados+' de '+users.length+' enviaram';
      }
    }

    // Atualizar gráfico de perdas com dados reais
    if (S.dashCharts && S.dashCharts.perdas) {
      var setoresPerd = ['Perecíveis','Açougue','Frios','Hortifruti','Mercearia','Padaria','Outros'];
      var outrosSetores = ['Bebidas','Limpeza','Caixa'];
      var perdaData = setoresPerd.map(function(s){
        return S.perdaItems.filter(function(p){
          return s==='Outros' ? outrosSetores.indexOf(p.setor)>=0 : p.setor===s;
        }).reduce(function(acc,p){return acc+p.total;},0);
      });
      S.dashCharts.perdas.data.datasets[0].data = perdaData;
      S.dashCharts.perdas.update();
    }

    // Atualizar gráfico de evolução 7 dias
    if (S.dashCharts && S.dashCharts.check) {
      var labels7=[]; var days7=[];
      for (var i=6;i>=0;i--) {
        var d=new Date(agora); d.setDate(d.getDate()-i);
        days7.push(d.toLocaleDateString('pt-BR'));
        labels7.push(d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}));
      }
      var data7 = days7.map(function(ds){
        var dr=resultados.filter(function(r){return r.dataHora&&r.dataHora.indexOf(ds)===0;});
        return dr.length ? Math.round(dr.reduce(function(s,r){return s+r.pct;},0)/dr.length) : null;
      });
      S.dashCharts.check.data.labels = labels7;
      S.dashCharts.check.data.datasets[0].data = data7;
      S.dashCharts.check.update();
    }

    // Gráfico conformidade por setor — hoje
    if (S.dashCharts && S.dashCharts.setor) {
      var setoresGraf = ['Açougue','Frios','Hortifruti','Padaria','Mercearia','Prevenção','Geral'];
      var setorData = setoresGraf.map(function(s){
        var rs = resultadosHoje.filter(function(r){return (r.setor||'')===s;});
        return rs.length ? Math.round(rs.reduce(function(acc,r){return acc+r.pct;},0)/rs.length) : null;
      });
      S.dashCharts.setor.data.datasets[0].data = setorData;
      S.dashCharts.setor.update();
    }

    // KPI Pendentes Hoje
    var pendVal = document.getElementById('dpend-val');
    var pendSub = document.getElementById('dpend-sub');
    if (pendVal) {
      var totalCLs = getCustomCLs().length;
      var enviadosHoje = resultadosHoje.map(function(r){return r.checklistId;});
      var pendentes = totalCLs - enviadosHoje.length;
      if (pendentes < 0) pendentes = 0;
      pendVal.textContent = pendentes;
      pendVal.style.color = pendentes === 0 ? 'var(--g)' : 'var(--r)';
      if (pendSub) pendSub.textContent = pendentes === 0 ? 'todos enviados ✓' : 'checklists em aberto';
    }

    // Card Planos de Ação Abertos
    var planosCard = document.getElementById('dash-planos-card');
    var planosLista = document.getElementById('dash-planos-lista');
    if (planosCard && planosLista) {
      var planos = getPlanos().filter(function(p){return p.status==='aberto'||p.status==='andamento';});
      var loja = S.currentUser ? (S.currentUser.loja||'').toLowerCase() : '';
      if (loja) planos = planos.filter(function(p){return (p.loja||'').toLowerCase()===loja||(p.loja||'').toLowerCase()==='';});
      planosCard.style.display = '';
      if (!planos.length) {
        planosLista.innerHTML = '<div style="text-align:center;color:var(--g);font-size:13px;padding:12px">✅ Nenhum plano de ação aberto</div>';
      } else {
        planosLista.innerHTML = planos.slice(0,4).map(function(p){
          var stColor = p.status==='andamento' ? 'var(--am)' : 'var(--r)';
          var stLabel = p.status==='andamento' ? 'Em andamento' : 'Aberto';
          return '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--gray2);border-radius:9px;background:#fff">'
            +'<div style="flex:1;min-width:0">'
            +'<div style="font-size:13px;font-weight:500;color:var(--t);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+p.desc+'</div>'
            +'<div style="font-size:11px;color:var(--t3);margin-top:2px">'+p.criadoEm+(p.setor?' · '+p.setor:'')+'</div>'
            +'</div>'
            +'<span style="flex-shrink:0;font-size:11px;font-weight:700;color:'+stColor+';padding:2px 8px;border-radius:20px;border:1.5px solid '+stColor+';white-space:nowrap">'+stLabel+'</span>'
            +'</div>';
        }).join('');
        if (planos.length > 4) {
          planosLista.innerHTML += '<div style="text-align:center;font-size:12px;color:var(--t3);padding:6px">+ '+(planos.length-4)+' outros planos</div>';
        }
      }
    }

  } else {
    // Operador: progresso local
    var allCLs=getMyCLs();
    var allKeys=[];
    allCLs.forEach(function(cl){cl.itens.forEach(function(i){allKeys.push(cl.id+'_'+i.t);});});
    var done=allKeys.filter(function(k){return S.checkState[k];}).length;
    var total=allKeys.length;
    var pct=total?Math.round(done/total*100):0;
    document.getElementById('dck-val').textContent=done+'/'+total;
    document.getElementById('dck-bar').style.width=pct+'%';
    document.getElementById('dck-pct').textContent=pct+'% concluído';
  }

  // Perdas (comum a todos)
  var totalP=S.perdaItems.reduce(function(s,i){return s+i.total;},0);
  document.getElementById('dp-val').textContent='R$ '+totalP.toFixed(2);
  document.getElementById('dp-cnt').textContent=S.perdaItems.length+' registros';

  // Compat: ddiv-val e dinv-val (ocultos)
  var divs=S.invItems.filter(function(i){return i.fis!==i.sist;}).length;
  var ddivEl=document.getElementById('ddiv-val');
  var dinvEl=document.getElementById('dinv-val');
  if (ddivEl) ddivEl.textContent=divs;
  if (dinvEl) dinvEl.textContent=S.invItems.length;

  // Histórico / Ocorrências
  var tbody=document.getElementById('d-hist');
  var rows=[];

  if (isAdmOrGer) {
    resultadosHoje.slice().reverse().slice(0,10).forEach(function(r){
      var st=r.pct===100?'st-ok':r.pct>=50?'st-warn':'st-err';
      rows.push('<tr>'
        +'<td>'+r.dataHora.split(' ')[1]+'</td>'
        +'<td><span class="st st-info">Checklist</span></td>'
        +'<td>'+r.checklistNome+'</td>'
        +'<td>'+r.setor+'</td>'
        +'<td>'+r.operador+'</td>'
        +'<td><span class="st '+st+'">'+r.pct+'%</span></td>'
        +'</tr>');
    });
    S.historico.slice(0,5).forEach(function(h){
      if (h.tipo!=='Checklist') {
        rows.push('<tr><td>'+h.hora+'</td><td><span class="st st-info">'+h.tipo+'</span></td><td>'+h.desc+'</td><td>'+h.setor+'</td><td>'+h.op+'</td><td><span class="st '+h.stCls+'">'+h.stLabel+'</span></td></tr>');
      }
    });
  } else {
    S.historico.slice(0,8).forEach(function(h){
      rows.push('<tr><td>'+h.hora+'</td><td><span class="st st-info">'+h.tipo+'</span></td><td>'+h.desc+'</td><td>'+h.setor+'</td><td>'+h.op+'</td><td><span class="st '+h.stCls+'">'+h.stLabel+'</span></td></tr>');
    });
  }

  var occCount=document.getElementById('dash-occ-count');
  if (occCount) occCount.textContent=rows.length ? rows.length+' ocorrência'+(rows.length>1?'s':'') : '';

  tbody.innerHTML=rows.length ? rows.join('') : '<tr class="erow"><td colspan="6">Nenhuma ocorrência hoje</td></tr>';
}

// ===========================================
// CHARTS
// ===========================================
function initDashCharts() {
  // Destroi charts anteriores se existirem
  if (S.dashCharts.perdas) { try{S.dashCharts.perdas.destroy();}catch(e){} }
  if (S.dashCharts.setor)  { try{S.dashCharts.setor.destroy();}catch(e){} }
  if (S.dashCharts.check)  { try{S.dashCharts.check.destroy();}catch(e){} }
  if (S.dashCharts.planoEvol) { try{S.dashCharts.planoEvol.destroy();}catch(e){} }

  // Gráfico de perdas desativado temporariamente (módulo oculto)
  // S.dashCharts.perdas = ...

  // Gráfico de conformidade por setor — hoje
  var setores = ['Açougue','Frios','Hortifruti','Padaria','Mercearia','Prevenção','Geral'];
  S.dashCharts.setor = new Chart(document.getElementById('chartSetor'),{
    type:'bar',
    data:{
      labels: setores,
      datasets:[{
        label:'Conformidade %',
        data: setores.map(function(){return 0;}),
        backgroundColor: setores.map(function(s,i){
          var colors=['#c0392b','#1a5276','#2d9e62','#d68910','#8e44ad','#2980b9','#95a5a6'];
          return colors[i]+'CC';
        }),
        borderRadius:6,borderSkipped:false
      }]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        y:{min:0,max:100,ticks:{callback:function(v){return v+'%';},font:{size:10}}},
        x:{ticks:{font:{size:10}}}
      }
    }
  });

  // Gráfico evolução de planos — últimos 7 dias
  var dias7 = [];
  for (var d = 6; d >= 0; d--) {
    var dt = new Date(); dt.setDate(dt.getDate() - d);
    dias7.push(dt.toISOString().slice(0, 10));
  }
  var diasLabels = dias7.map(function(d){ return d.slice(8,10)+'/'+d.slice(5,7); });
  var planosTodos = getPlanos();
  var dadosCriados = dias7.map(function(dia){
    return planosTodos.filter(function(p){ return (p.criadoTimestamp||'').slice(0,10)===dia; }).length;
  });
  var dadosResolvidos = dias7.map(function(dia){
    return planosTodos.filter(function(p){ return (p.resolvidoTimestamp||'').slice(0,10)===dia; }).length;
  });
  S.dashCharts.planoEvol = new Chart(document.getElementById('chartPlanoEvol'),{
    type:'bar',
    data:{
      labels: diasLabels,
      datasets:[
        {label:'Criados', data: dadosCriados, backgroundColor:'rgba(220,53,69,.7)', borderRadius:5},
        {label:'Resolvidos', data: dadosResolvidos, backgroundColor:'rgba(45,158,98,.7)', borderRadius:5}
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:'bottom', labels:{font:{size:11}}}},
      scales:{y:{ticks:{stepSize:1, font:{size:10}}, beginAtZero:true}, x:{ticks:{font:{size:10}}}}
    }
  });

  // Gráfico de evolução de conformidade — últimos 7 dias (linha)
  S.dashCharts.check = new Chart(document.getElementById('chartCheck'),{
    type:'line',
    data:{
      labels:['','','','','','',''],
      datasets:[{
        label:'Conformidade %',
        data:[null,null,null,null,null,null,null],
        borderColor:'#2d9e62',
        backgroundColor:'rgba(45,158,98,.12)',
        borderWidth:2,
        pointBackgroundColor:'#2d9e62',
        pointRadius:4,
        fill:true,
        tension:.35,
        spanGaps:true
      }]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        y:{min:0,max:100,ticks:{callback:function(v){return v+'%';},font:{size:11}}},
        x:{ticks:{font:{size:11}}}
      }
    }
  });
}

function switchRelClTab(sub, btn) {
  ['geral','executivo','naoconformidade','ranking','porquestao','execucao','corporativo'].forEach(function(t){
    var el = document.getElementById('rel-cl-'+t);
    if (el) el.style.display = t===sub ? 'block' : 'none';
  });
  document.querySelectorAll('#rel-cl-subtabs .tab').forEach(function(t){t.classList.remove('on');});
  if (btn) btn.classList.add('on');
  if (sub==='geral') renderRelChecklist();
  if (sub==='executivo') { renderRelExecutivo(); }
  if (sub==='naoconformidade') { renderRelNaoConformidade(); }
  if (sub==='ranking') { renderRelRanking(); }
  if (sub==='porquestao') { renderRelPorQuestao(); }
  if (sub==='execucao') { renderRelExecucao(); }
  if (sub==='corporativo') { renderRelCorporativoTab(); }
}

function switchRelTab(tab, btn) {
  ['checklist','inventario','perdas'].forEach(function(t){
    var el = document.getElementById('rel-tab-'+t);
    if (el) el.style.display = t===tab ? 'block' : 'none';
  });
  document.querySelectorAll('#rel-tabs .tab').forEach(function(t){t.classList.remove('on');});
  if (btn) btn.classList.add('on');
  if (tab==='checklist') {
    // Reset sub-tabs to geral
    switchRelClTab('geral', document.querySelector('#rel-cl-subtabs .tab'));
  }
  if (tab==='inventario') renderRelInventario();
  if (tab==='perdas') renderRelPerdas();
}

var resumoDiaFiltro = 'hoje';

function filtrarResumoDia(tipo, btn) {
  resumoDiaFiltro = tipo;
  document.querySelectorAll('.rel-dia-btn').forEach(function(b){b.classList.remove('active-dia');});
  if (btn) btn.classList.add('active-dia');
  renderRelChecklist();
}

function getResultadosFiltradosDia() {
  var resultados = getResultados();
  var agora = new Date();
  var hoje = agora.toLocaleDateString('pt-BR');
  var custom = (document.getElementById('rel-dia-custom')||{}).value||'';

  if (resumoDiaFiltro === 'hoje') {
    return resultados.filter(function(r){return r.dataHora && r.dataHora.indexOf(hoje)===0;});
  } else if (resumoDiaFiltro === 'ontem') {
    var ontem = new Date(agora); ontem.setDate(ontem.getDate()-1);
    var ontemStr = ontem.toLocaleDateString('pt-BR');
    return resultados.filter(function(r){return r.dataHora && r.dataHora.indexOf(ontemStr)===0;});
  } else if (resumoDiaFiltro === '7dias') {
    var limite = new Date(agora); limite.setDate(limite.getDate()-6);
    return resultados.filter(function(r){
      if (!r.dataHora) return false;
      var p=r.dataHora.split(' ')[0].split('/');
      if(p.length<3) return false;
      var d=new Date(p[2]+'-'+p[1]+'-'+p[0]);
      return d>=limite;
    });
  } else if (resumoDiaFiltro === 'mes') {
    var mes = agora.getMonth(); var ano = agora.getFullYear();
    return resultados.filter(function(r){
      if (!r.dataHora) return false;
      var p=r.dataHora.split(' ')[0].split('/');
      if(p.length<3) return false;
      var d=new Date(p[2]+'-'+p[1]+'-'+p[0]);
      return d.getMonth()===mes && d.getFullYear()===ano;
    });
  } else if (resumoDiaFiltro === 'custom' && custom) {
    var customParts = custom.split('-');
    var customStr = customParts[2]+'/'+customParts[1]+'/'+customParts[0];
    return resultados.filter(function(r){return r.dataHora && r.dataHora.indexOf(customStr)===0;});
  }
  return resultados.filter(function(r){return r.dataHora && r.dataHora.indexOf(hoje)===0;});
}

function renderRelChecklist() {
  var resultados = getResultados();
  var totalEnv = resultados.length;
  var totalComp = resultados.filter(function(r){return r.pct===100;}).length;
  var taxa = totalEnv ? Math.round(totalComp/totalEnv*100) : 0;
  var mediaGeral = totalEnv ? Math.round(resultados.reduce(function(s,r){return s+r.pct;},0)/totalEnv) : 0;
  document.getElementById('rel-checklists').textContent = totalEnv;
  document.getElementById('rel-taxa').textContent = taxa+'%';
  document.getElementById('rel-media').textContent = totalEnv ? mediaGeral+'%' : '-';

  // Count unique operators
  var opsUnicos = [];
  resultados.forEach(function(r){ if(opsUnicos.indexOf(r.operador)<0) opsUnicos.push(r.operador); });
  document.getElementById('rel-ops-ativos').textContent = opsUnicos.length;

  var hoje = new Date().toLocaleDateString('pt-BR');
  var dEl = document.getElementById('rel-data-hoje');
  var filtroLabel = {hoje:'Hoje',ontem:'Ontem','7dias':'Últimos 7 dias',mes:'Este mês',custom:'Data selecionada'};
  if (dEl) dEl.textContent = filtroLabel[resumoDiaFiltro]||hoje;

  // Resumo do dia - usa filtro selecionado
  var resultadosHoje = getResultadosFiltradosDia().filter(function(r){return !r.resetado;});
  var users = getUsers().filter(function(u){return u.id!=='admin' && u.ativo;});
  var resumoDiv = document.getElementById('rel-resumo-dia');
  var PLABEL2 = {gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
  resumoDiv.innerHTML = users.length ? users.map(function(u){
    var enviou = resultadosHoje.find(function(r){return r.operador===u.nome;});
    var cor = enviou ? (enviou.pct===100?'#e8f5ee':'#fef9e7') : '#fdecea';
    var icon = enviou ? (enviou.pct===100?'✅':'⚠️') : '⏳';
    var pct = enviou ? enviou.pct+'%' : 'Pendente';
    var pctColor = enviou ? (enviou.pct===100?'var(--g)':'var(--am)') : 'var(--r)';
    return '<div style="background:'+cor+';border-radius:10px;padding:14px;text-align:center">'
      +'<div style="font-size:24px;margin-bottom:6px">'+icon+'</div>'
      +'<div style="font-size:13px;font-weight:600;margin-bottom:2px">'+u.nome+'</div>'
      +'<div style="font-size:11px;color:var(--t3);margin-bottom:6px">'+(PLABEL2[u.perfil]||u.perfil)+'</div>'
      +'<div style="font-size:18px;font-weight:700;color:'+pctColor+'">'+pct+'</div>'
      +'</div>';
  }).join('') : '<div style="text-align:center;color:var(--t3);padding:20px;font-size:13px;grid-column:1/-1">Nenhum usuário cadastrado</div>';

  // Por setor
  var setoresMap = {};
  resultados.forEach(function(r){
    var s=r.setor||'Geral';
    if(!setoresMap[s]) setoresMap[s]={env:0,comp:0,soma:0};
    setoresMap[s].env++; if(r.pct===100) setoresMap[s].comp++; setoresMap[s].soma+=r.pct;
  });
  var setorTbody = document.getElementById('rel-setor-tbody');
  setorTbody.innerHTML = Object.keys(setoresMap).length ? Object.keys(setoresMap).map(function(s){
    var d=setoresMap[s]; var med=Math.round(d.soma/d.env);
    var st=med===100?'st-ok':med>=70?'st-warn':'st-err';
    var alerta=med<70?'<span class="st st-err">Crítico</span>':med<100?'<span class="st st-warn">Regular</span>':'<span class="st st-ok">Ótimo</span>';
    return '<tr><td><strong>'+s+'</strong></td><td>'+d.env+'</td>'
      +'<td><span class="st '+(d.comp===d.env?'st-ok':'st-warn')+'">'+d.comp+'/'+d.env+'</span></td>'
      +'<td><span class="st '+st+'">'+med+'%</span></td><td>'+alerta+'</td></tr>';
  }).join('') : '<tr class="erow"><td colspan="5">Nenhum dado ainda</td></tr>';

  // Evolução diária
  var dias = [];
  for (var i=6;i>=0;i--){var d2=new Date();d2.setDate(d2.getDate()-i);dias.push(d2.toLocaleDateString('pt-BR'));}
  var diasData = dias.map(function(d){return resultados.filter(function(r){return r.dataHora&&r.dataHora.indexOf(d)===0;}).length;});
  var diasLabels = dias.map(function(d){return d.slice(0,5);});
  if (S.relCharts.evolDiaria) {
    S.relCharts.evolDiaria.data.labels=diasLabels; S.relCharts.evolDiaria.data.datasets[0].data=diasData; S.relCharts.evolDiaria.update();
  } else {
    var ctx=document.getElementById('chartEvolDiaria');
    if(ctx) S.relCharts.evolDiaria=new Chart(ctx,{type:'bar',data:{labels:diasLabels,datasets:[{label:'Envios',data:diasData,backgroundColor:'#2d9e62',borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{stepSize:1},suggestedMax:5}}}});
  }

  // Ranking
  var opsMap={};
  resultados.forEach(function(r){
    if(!opsMap[r.operador]) opsMap[r.operador]={perfil:r.perfil,env:0,comp:0,soma:0,ultimo:''};
    opsMap[r.operador].env++; if(r.pct===100)opsMap[r.operador].comp++; opsMap[r.operador].soma+=r.pct; opsMap[r.operador].ultimo=r.dataHora;
  });
  var rankList=Object.keys(opsMap).map(function(n){var o=opsMap[n];return{nome:n,perfil:o.perfil,env:o.env,comp:o.comp,media:Math.round(o.soma/o.env),ultimo:o.ultimo};}).sort(function(a,b){return b.media-a.media||b.comp-a.comp;});
  var medals=['🥇','🥈','🥉'];
  document.getElementById('rel-ranking-tbody').innerHTML = rankList.length ? rankList.map(function(o,i){
    var st=o.media===100?'st-ok':o.media>=70?'st-warn':'st-err';
    return '<tr><td>'+(medals[i]||i+1)+'</td><td><strong>'+o.nome+'</strong></td><td>'+o.env+'</td>'
      +'<td><span class="st '+(o.comp===o.env?'st-ok':'st-warn')+'">'+o.comp+'/'+o.env+'</span></td>'
      +'<td><span class="st '+st+'">'+o.media+'%</span></td></tr>';
  }).join('') : '<tr class="erow"><td colspan="5">Nenhum dado</td></tr>';

  // Problemáticos
  var clMap={};
  resultados.forEach(function(r){var n=r.checklistNome||'-';if(!clMap[n])clMap[n]={env:0,soma:0};clMap[n].env++;clMap[n].soma+=r.pct;});
  var clList=Object.keys(clMap).map(function(n){return{nome:n,env:clMap[n].env,media:Math.round(clMap[n].soma/clMap[n].env)};}).sort(function(a,b){return a.media-b.media;});
  document.getElementById('rel-problemas-tbody').innerHTML = clList.length ? clList.map(function(cl){
    var st=cl.media===100?'st-ok':cl.media>=70?'st-warn':'st-err';
    var alerta=cl.media<70?'<span class="st st-err">⚠ Crítico</span>':cl.media<100?'<span class="st st-warn">Regular</span>':'<span class="st st-ok">OK</span>';
    return '<tr><td>'+cl.nome+'</td><td>'+cl.env+'</td><td><span class="st '+st+'">'+cl.media+'%</span></td><td>'+alerta+'</td></tr>';
  }).join('') : '<tr class="erow"><td colspan="4">Nenhum dado</td></tr>';

  // Equipe completa
  var PLABEL3={admin:'Administrador',gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
  var PCLS3={admin:'st-info',gerencia:'st-info',operator:'st-ok',prevencao:'st-err'};
  document.getElementById('rel-equipe-tbody').innerHTML = rankList.length ? rankList.map(function(o){
    var mst=o.media===100?'st-ok':o.media>=50?'st-warn':'st-err';
    return '<tr><td><strong>'+o.nome+'</strong></td><td><span class="st '+(PCLS3[o.perfil]||'st-ok')+'">'+(PLABEL3[o.perfil]||o.perfil)+'</span></td>'
      +'<td>'+o.env+'</td><td><span class="st '+(o.comp===o.env?'st-ok':'st-warn')+'">'+o.comp+'/'+o.env+'</span></td>'
      +'<td><span class="st '+mst+'">'+o.media+'%</span></td><td style="font-size:12px;color:var(--t3)">'+o.ultimo+'</td></tr>';
  }).join('') : '<tr class="erow"><td colspan="6">Nenhum checklist enviado ainda</td></tr>';
}

function renderRelPorQuestao() {
  var resultados = getResultados();
  // Agrupa itens por texto da questão
  var mapa = {};
  resultados.forEach(function(r) {
    (r.itens||[]).forEach(function(item) {
      var chave = (item.texto||'').trim();
      if (!chave) return;
      if (!mapa[chave]) mapa[chave] = {texto:chave, checklistNome:r.checklistNome, tipo:item.tipo||'checkbox', critico:!!item.critico, total:0, falhou:0};
      mapa[chave].total++;
      var falha = false;
      if (item.tipo==='simNao') falha = item.resposta==='nao';
      else falha = !item.feito;
      if (falha) mapa[chave].falhou++;
    });
  });
  var lista = Object.values(mapa).filter(function(q){return q.total>0;});
  lista.sort(function(a,b){ return (b.falhou/b.total) - (a.falhou/a.total); });

  var criticas = lista.filter(function(q){return q.critico && q.falhou>0;}).length;
  document.getElementById('pq-total').textContent = lista.length;
  document.getElementById('pq-criticas').textContent = criticas;
  var pior = lista.length ? Math.round(lista[0].falhou/lista[0].total*100)+'%' : '—';
  document.getElementById('pq-pior').textContent = pior;

  var tbody = document.getElementById('pq-tbody');
  if (!lista.length) { tbody.innerHTML='<tr class="erow"><td colspan="7">Nenhum resultado para analisar</td></tr>'; return; }
  tbody.innerHTML = lista.map(function(q, i) {
    var taxa = Math.round(q.falhou/q.total*100);
    var st = taxa>=50?'st-err':taxa>=20?'st-warn':'st-ok';
    var tipoLabel = {checkbox:'☑ Checkbox',simNao:'✅ Sim/Não',nota:'⭐ Nota',texto:'📝 Texto'}[q.tipo]||q.tipo;
    return '<tr>'
      +'<td style="font-weight:700;color:var(--t3)">'+(i+1)+'</td>'
      +'<td style="font-size:12px">'+(q.critico?'<span style="color:var(--r);font-weight:700">⚠️ </span>':'')+q.texto+'</td>'
      +'<td style="font-size:12px;color:var(--t3)">'+q.checklistNome+'</td>'
      +'<td style="text-align:center">'+q.total+'</td>'
      +'<td style="text-align:center;color:var(--r);font-weight:600">'+q.falhou+'</td>'
      +'<td><span class="st '+st+'">'+taxa+'%</span></td>'
      +'<td style="font-size:11px;color:var(--t3)">'+tipoLabel+'</td>'
      +'</tr>';
  }).join('');
}

function renderRelExecucao() {
  var customCLs = getCustomCLs();
  var resultados = getResultados();
  var agora = new Date();
  var dias7 = [];
  for (var i=6; i>=0; i--) {
    var d = new Date(agora); d.setDate(d.getDate()-i);
    dias7.push({
      dateStr: d.toLocaleDateString('pt-BR'),
      diaSemana: d.getDay(),
      label: d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit'})
    });
  }
  // Calcula agendados por checklist no período
  var porCL = customCLs.map(function(cl) {
    var dias = cl.diasObrigatorios || [];
    var agendados = dias7.filter(function(d){
      if (!dias.length) return true; // sem agenda = todo dia
      return dias.some(function(x){ return Number(x)===d.diaSemana; });
    }).length;
    var executados = dias7.filter(function(d){
      return resultados.some(function(r){
        return r.checklistId===cl.id && r.dataHora && r.dataHora.indexOf(d.dateStr)===0;
      });
    }).length;
    return {nome:cl.label||cl.nome||'', setor:cl.setor||'', agendados:agendados, executados:executados};
  }).filter(function(x){return x.agendados>0;});

  var totAg = porCL.reduce(function(s,x){return s+x.agendados;},0);
  var totEx = porCL.reduce(function(s,x){return s+x.executados;},0);
  var totPend = totAg - totEx;
  var taxa = totAg ? Math.round(totEx/totAg*100) : 0;

  document.getElementById('ex-agendados').textContent = totAg;
  document.getElementById('ex-executados').textContent = totEx;
  document.getElementById('ex-pendentes').textContent = totPend;
  var taxaEl = document.getElementById('ex-taxa');
  taxaEl.textContent = totAg ? taxa+'%' : '—';
  taxaEl.style.color = taxa>=80?'var(--g)':taxa>=50?'var(--am)':'var(--r)';

  // Tabela por checklist
  var tbCL = document.getElementById('ex-cl-tbody');
  if (!porCL.length) { tbCL.innerHTML='<tr class="erow"><td colspan="6">Nenhum checklist agendado</td></tr>'; }
  else tbCL.innerHTML = porCL.map(function(x){
    var t = x.agendados ? Math.round(x.executados/x.agendados*100) : 0;
    var st = t>=80?'st-ok':t>=50?'st-warn':'st-err';
    return '<tr>'
      +'<td><strong>'+x.nome+'</strong></td>'
      +'<td style="font-size:12px;color:var(--t3)">'+x.setor+'</td>'
      +'<td style="text-align:center">'+x.agendados+'</td>'
      +'<td style="text-align:center;color:var(--g);font-weight:600">'+x.executados+'</td>'
      +'<td style="text-align:center;color:var(--r)">'+Math.max(0,x.agendados-x.executados)+'</td>'
      +'<td><span class="st '+st+'">'+t+'%</span></td>'
      +'</tr>';
  }).join('');

  // Tabela por dia
  var tbDia = document.getElementById('ex-dia-tbody');
  tbDia.innerHTML = dias7.map(function(d){
    var agDia = customCLs.filter(function(cl){
      var dias = cl.diasObrigatorios||[];
      if (!dias.length) return true;
      return dias.some(function(x){return Number(x)===d.diaSemana;});
    }).length;
    var exDia = resultados.filter(function(r){
      return r.dataHora && r.dataHora.indexOf(d.dateStr)===0;
    }).map(function(r){return r.checklistId;}).filter(function(id,idx,arr){return arr.indexOf(id)===idx;}).length;
    if (agDia===0) return '';
    var t = Math.round(exDia/agDia*100);
    var st = t>=80?'st-ok':t>=50?'st-warn':'st-err';
    var stLabel = t>=80?'OK':t>=50?'Parcial':'Crítico';
    return '<tr>'
      +'<td style="font-size:12px">'+d.dateStr+'</td>'
      +'<td style="font-size:12px;color:var(--t3)">'+d.label.split(',')[0]+'</td>'
      +'<td style="text-align:center">'+agDia+'</td>'
      +'<td style="text-align:center;color:var(--g);font-weight:600">'+exDia+'</td>'
      +'<td><span class="st '+st+'">'+t+'%</span></td>'
      +'<td><span class="st '+st+'">'+stLabel+'</span></td>'
      +'</tr>';
  }).filter(Boolean).join('') || '<tr class="erow"><td colspan="6">Nenhum dado</td></tr>';
}

function renderRelInventario() {
  var items = S.invItems;
  var total = items.length;
  var divs = items.filter(function(i){return i.fis!==i.sist;}).length;
  var ok = total - divs;
  var saldo = items.reduce(function(s,i){return s+(i.fis-i.sist);},0);
  document.getElementById('rel-inv-total').textContent = total;
  document.getElementById('rel-inv-div').textContent = divs;
  document.getElementById('rel-inv-ok').textContent = ok;
  document.getElementById('rel-inv-saldo').textContent = (saldo>0?'+':'')+saldo+' un';

  // Por setor
  var setMap = {};
  items.forEach(function(i){
    if(!setMap[i.setor]) setMap[i.setor]={total:0,divs:0,saldo:0};
    setMap[i.setor].total++;
    if(i.fis!==i.sist) setMap[i.setor].divs++;
    setMap[i.setor].saldo+=(i.fis-i.sist);
  });
  var setTbody = document.getElementById('rel-inv-setor-tbody');
  setTbody.innerHTML = Object.keys(setMap).length ? Object.keys(setMap).map(function(s){
    var d=setMap[s];
    var st=d.divs===0?'st-ok':d.divs<d.total?'st-warn':'st-err';
    var sld=(d.saldo>0?'+':'')+d.saldo+' un';
    return '<tr><td><strong>'+s+'</strong></td><td>'+d.total+'</td>'
      +'<td><span class="st '+st+'">'+d.divs+'</span></td>'
      +'<td>'+sld+'</td>'
      +'<td><span class="st '+(d.divs===0?'st-ok':'st-warn')+'">'+( d.divs===0?'OK':'Verificar')+'</span></td></tr>';
  }).join('') : '<tr class="erow"><td colspan="5">Nenhum inventário lançado</td></tr>';

  // Itens com divergência
  var divItems = items.filter(function(i){return i.fis!==i.sist;});
  var divTbody = document.getElementById('rel-inv-itens-tbody');
  divTbody.innerHTML = divItems.length ? divItems.map(function(i){
    var dif=i.fis-i.sist; var st=dif>0?'st-warn':'st-err';
    return '<tr><td>'+i.desc+'</td><td>'+i.setor+'</td>'
      +'<td>'+i.sist+' '+i.unid+'</td><td>'+i.fis+' '+i.unid+'</td>'
      +'<td><span class="st '+st+'">'+(dif>0?'+':'')+dif+' '+i.unid+'</span></td>'
      +'<td><span class="st '+st+'">'+(dif>0?'Sobra':'Falta')+'</span></td></tr>';
  }).join('') : '<tr class="erow"><td colspan="6">Nenhuma divergência encontrada</td></tr>';
}

function renderRelPerdas() {
  var items = S.perdaItems;
  var total = items.reduce(function(s,i){return s+i.total;},0);
  var cnt = items.length;
  var maior = items.length ? items.reduce(function(a,b){return b.total>a.total?b:a;},{total:0,prod:'-'}) : {total:0,prod:'-'};
  document.getElementById('rel-perdas').textContent = 'R$ '+total.toFixed(2);
  document.getElementById('rel-perdas-cnt').textContent = cnt;
  document.getElementById('rel-perdas-maior').textContent = 'R$ '+maior.total.toFixed(2);

  // Setor crítico
  var setMap = {};
  items.forEach(function(i){
    if(!setMap[i.setor]) setMap[i.setor]=0;
    setMap[i.setor]+=i.total;
  });
  var setorCrit = Object.keys(setMap).sort(function(a,b){return setMap[b]-setMap[a];})[0]||'-';
  document.getElementById('rel-perdas-setor').textContent = setorCrit;

  // Gráfico por setor
  var setores = Object.keys(setMap);
  var setVals = setores.map(function(s){return setMap[s];});
  var colors = ['#c0392b','#1a5276','#2d9e62','#d68910','#8e44ad','#1a7a4a','#e74c3c'];
  if (S.relCharts.set) {
    S.relCharts.set.data.labels=setores; S.relCharts.set.data.datasets[0].data=setVals; S.relCharts.set.data.datasets[0].backgroundColor=colors.slice(0,setores.length); S.relCharts.set.update();
  } else {
    var ctx=document.getElementById('chartSet');
    if(ctx) S.relCharts.set=new Chart(ctx,{type:'pie',data:{labels:setores,datasets:[{data:setVals,backgroundColor:colors,borderWidth:3,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:12}}}}});
  }

  // Gráfico por motivo
  var motMap = {};
  items.forEach(function(i){if(!motMap[i.motivo]) motMap[i.motivo]=0; motMap[i.motivo]+=i.total;});
  var mots=Object.keys(motMap); var motVals=mots.map(function(m){return motMap[m];});
  if (S.relCharts.motivo) {
    S.relCharts.motivo.data.labels=mots; S.relCharts.motivo.data.datasets[0].data=motVals; S.relCharts.motivo.update();
  } else {
    var ctx2=document.getElementById('chartMotivo');
    if(ctx2) S.relCharts.motivo=new Chart(ctx2,{type:'doughnut',data:{labels:mots,datasets:[{data:motVals,backgroundColor:colors,borderWidth:3,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:12}}}}});
  }

  // Tabela por setor
  var perdTbody = document.getElementById('rel-perdas-tbody');
  perdTbody.innerHTML = setores.length ? setores.sort(function(a,b){return setMap[b]-setMap[a];}).map(function(s){
    var sitens=items.filter(function(i){return i.setor===s;});
    var stotal=setMap[s];
    var smaior=sitens.reduce(function(a,b){return b.total>a.total?b:a;},{total:0,prod:'-'});
    var motores={};
    sitens.forEach(function(i){if(!motores[i.motivo])motores[i.motivo]=0;motores[i.motivo]+=i.total;});
    var motPrincipal=Object.keys(motores).sort(function(a,b){return motores[b]-motores[a];})[0]||'-';
    return '<tr><td><strong>'+s+'</strong></td><td>'+sitens.length+'</td>'
      +'<td><strong class="dn">R$ '+stotal.toFixed(2)+'</strong></td>'
      +'<td>R$ '+smaior.total.toFixed(2)+'</td>'
      +'<td>'+motPrincipal+'</td></tr>';
  }).join('') : '<tr class="erow"><td colspan="5">Nenhuma perda registrada</td></tr>';
}

function renderRelExecutivo() {
  var resultados = getResultados();
  var hoje = new Date().toLocaleDateString('pt-BR');
  var res = resultados.filter(function(r){return r.dataHora && r.dataHora.indexOf(hoje)===0 && !r.resetado;});
  var total = res.length;
  var comp = res.filter(function(r){return r.pct===100;}).length;
  var pend = total - comp;
  var taxa = total ? Math.round(comp/total*100) : 0;
  var media = total ? Math.round(res.reduce(function(s,r){return s+r.pct;},0)/total) : 0;
  var ops = [];
  res.forEach(function(r){if(ops.indexOf(r.operador)<0) ops.push(r.operador);});
  var fotos = 0;
  res.forEach(function(r){(r.itens||[]).forEach(function(it){if(it.fotoAntes||it.fotoDepois)fotos++;});});
  var ocorr = res.filter(function(r){return r.pct<100;}).length;

  document.getElementById('exec-total').textContent = total;
  document.getElementById('exec-comp').textContent = comp;
  document.getElementById('exec-pend').textContent = pend;
  document.getElementById('exec-taxa').textContent = taxa+'%';
  document.getElementById('exec-ops').textContent = ops.length;
  document.getElementById('exec-media').textContent = total ? media+'%' : '-';
  document.getElementById('exec-fotos').textContent = fotos;
  document.getElementById('exec-ocorr').textContent = ocorr;
  document.getElementById('exec-data-label').textContent = hoje;

  // Equipe cards
  var users = getUsers().filter(function(u){return u.id!=='admin'&&u.ativo;});
  var PLABEL = {gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
  var eq = document.getElementById('exec-equipe');
  eq.innerHTML = users.length ? users.map(function(u){
    var env = res.find(function(r){return r.operador===u.nome;});
    var cor = env?(env.pct===100?'#e8f5ee':'#fef9e7'):'#fdecea';
    var icon = env?(env.pct===100?'✅':'⚠️'):'⏳';
    var pctTxt = env?env.pct+'%':'Pendente';
    var pctColor = env?(env.pct===100?'var(--g)':'var(--am)'):'var(--r)';
    return '<div style="background:'+cor+';border-radius:10px;padding:14px;text-align:center">'
      +'<div style="font-size:22px;margin-bottom:4px">'+icon+'</div>'
      +'<div style="font-size:13px;font-weight:600">'+u.nome+'</div>'
      +'<div style="font-size:11px;color:var(--t3);margin-bottom:6px">'+(PLABEL[u.perfil]||u.perfil)+'</div>'
      +'<div style="font-size:20px;font-weight:700;color:'+pctColor+'">'+pctTxt+'</div>'
      +'</div>';
  }).join('') : '<div style="color:var(--t3);padding:20px;text-align:center;grid-column:1/-1">Nenhum usuário</div>';

  // Gráfico por hora
  var horas = Array.from({length:24},function(_,i){return i;});
  var horaData = horas.map(function(h){
    return res.filter(function(r){
      if(!r.dataHora) return false;
      var t=r.dataHora.split(' ')[1]||'';
      return parseInt(t.split(':')[0])===h;
    }).length;
  });
  var horaLabels = horas.map(function(h){return h+'h';});
  if (S.relCharts.hora) { S.relCharts.hora.data.datasets[0].data=horaData; S.relCharts.hora.update(); }
  else {
    var ctx=document.getElementById('chartHora');
    if(ctx) S.relCharts.hora=new Chart(ctx,{type:'bar',data:{labels:horaLabels,datasets:[{data:horaData,backgroundColor:'#FFC600',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{stepSize:1},suggestedMax:3}}}});
  }

  // Gráfico por setor
  var setMap={};
  res.forEach(function(r){var s=r.setor||'Geral';if(!setMap[s])setMap[s]={soma:0,cnt:0};setMap[s].soma+=r.pct;setMap[s].cnt++;});
  var setLabels=Object.keys(setMap);
  var setData=setLabels.map(function(s){return Math.round(setMap[s].soma/setMap[s].cnt);});
  if(S.relCharts.execSetor){S.relCharts.execSetor.data.labels=setLabels;S.relCharts.execSetor.data.datasets[0].data=setData;S.relCharts.execSetor.update();}
  else{var ctx2=document.getElementById('chartExecSetor');if(ctx2)S.relCharts.execSetor=new Chart(ctx2,{type:'bar',data:{labels:setLabels,datasets:[{data:setData,backgroundColor:'#2d9e62',borderRadius:5}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{max:100,ticks:{callback:function(v){return v+'%';}}}}}});}
}

function renderRelNaoConformidade() {
  var resultados = getResultados();
  var naoConf = resultados.filter(function(r){return r.pct<100 && !r.resetado;});
  var parciais = resultados.filter(function(r){return r.pct>0 && r.pct<100;}).length;

  document.getElementById('nc-total').textContent = naoConf.length;
  document.getElementById('nc-parciais').textContent = parciais;

  // Setor crítico
  var setMap={};
  naoConf.forEach(function(r){var s=r.setor||'Geral';if(!setMap[s])setMap[s]=0;setMap[s]++;});
  var setCrit=Object.keys(setMap).sort(function(a,b){return setMap[b]-setMap[a];})[0]||'-';
  document.getElementById('nc-setor').textContent = setCrit;

  // Operador crítico
  var opMap={};
  naoConf.forEach(function(r){if(!opMap[r.operador])opMap[r.operador]=0;opMap[r.operador]++;});
  var opCrit=Object.keys(opMap).sort(function(a,b){return opMap[b]-opMap[a];})[0]||'-';
  document.getElementById('nc-op').textContent = opCrit;

  // Gráfico setor
  var setLabels=Object.keys(setMap);var setData=setLabels.map(function(s){return setMap[s];});
  if(S.relCharts.ncSetor){S.relCharts.ncSetor.data.labels=setLabels;S.relCharts.ncSetor.data.datasets[0].data=setData;S.relCharts.ncSetor.update();}
  else{var ctx=document.getElementById('chartNcSetor');if(ctx)S.relCharts.ncSetor=new Chart(ctx,{type:'bar',data:{labels:setLabels,datasets:[{data:setData,backgroundColor:'#c0392b',borderRadius:5}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}});}

  // Gráfico operador
  var opLabels=Object.keys(opMap);var opData=opLabels.map(function(o){return opMap[o];});
  if(S.relCharts.ncOp){S.relCharts.ncOp.data.labels=opLabels;S.relCharts.ncOp.data.datasets[0].data=opData;S.relCharts.ncOp.update();}
  else{var ctx2=document.getElementById('chartNcOp');if(ctx2)S.relCharts.ncOp=new Chart(ctx2,{type:'doughnut',data:{labels:opLabels,datasets:[{data:opData,backgroundColor:['#c0392b','#d68910','#1a5276','#2d9e62'],borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:12}}}}});}

  // Tabela NC
  var tbody=document.getElementById('nc-tbody');
  tbody.innerHTML = naoConf.length ? naoConf.slice().reverse().slice(0,20).map(function(r){
    var pend=(r.itens||[]).filter(function(i){return !i.feito;}).length;
    var st=r.pct>=50?'st-warn':'st-err';
    return '<tr><td>'+r.checklistNome+'</td><td>'+r.operador+'</td><td>'+r.setor+'</td>'
      +'<td style="font-size:12px">'+r.dataHora+'</td>'
      +'<td><span class="st '+st+'">'+r.pct+'%</span></td>'
      +'<td>'+pend+' item(s)</td></tr>';
  }).join('') : '<tr class="erow"><td colspan="6">Nenhuma não conformidade</td></tr>';

  // Reincidências
  var reincMap={};
  naoConf.forEach(function(r){var k=r.operador+'||'+r.checklistNome;if(!reincMap[k])reincMap[k]={op:r.operador,cl:r.checklistNome,cnt:0,soma:0};reincMap[k].cnt++;reincMap[k].soma+=r.pct;});
  var reincList=Object.values(reincMap).filter(function(x){return x.cnt>1;}).sort(function(a,b){return b.cnt-a.cnt;});
  var rtbody=document.getElementById('nc-reincid-tbody');
  rtbody.innerHTML = reincList.length ? reincList.map(function(x){
    var med=Math.round(x.soma/x.cnt);
    return '<tr><td>'+x.op+'</td><td>'+x.cl+'</td><td><span class="st st-err">'+x.cnt+'x</span></td>'
      +'<td><span class="st st-warn">'+med+'%</span></td>'
      +'<td><span class="st st-err">Atenção</span></td></tr>';
  }).join('') : '<tr class="erow"><td colspan="5">Nenhuma reincidência</td></tr>';
}

function switchRankView(view, btn) {
  document.getElementById('rank-view-op').style.display    = view === 'operadores' ? 'block' : 'none';
  document.getElementById('rank-view-lojas').style.display = view === 'lojas'      ? 'block' : 'none';
  document.querySelectorAll('#rel-cl-ranking .tabs .tab').forEach(function(t){ t.classList.remove('on'); });
  if (btn) btn.classList.add('on');
}

function buildPodio(elId, rankList) {
  var podio   = document.getElementById(elId);
  if (!podio) return;
  var medals  = [{pos:1,icon:'🥇',h:120,bg:'#FFD700'},{pos:2,icon:'🥈',h:90,bg:'#C0C0C0'},{pos:3,icon:'🥉',h:70,bg:'#CD7F32'}];
  var order   = [1,0,2];
  podio.innerHTML = order.map(function(i){
    var m=medals[i]; var op=rankList[i];
    if (!op) return '<div style="width:120px"></div>';
    return '<div style="text-align:center;width:130px">'
      +'<div style="font-size:28px;margin-bottom:4px">'+m.icon+'</div>'
      +'<div style="font-size:13px;font-weight:700;margin-bottom:4px">'+op.nome+'</div>'
      +'<div style="font-size:11px;color:var(--t3);margin-bottom:2px">'+op.pontos+' pts</div>'
      +'<div style="font-size:11px;color:var(--t3);margin-bottom:8px">'+op.media+'% média</div>'
      +'<div style="height:'+m.h+'px;background:'+m.bg+';border-radius:8px 8px 0 0;display:flex;align-items:flex-start;justify-content:center;padding-top:8px;font-size:20px;font-weight:800;color:#fff">'+m.pos+'</div>'
      +'</div>';
  }).join('');
}

function renderRelRanking() {
  var resultados = getResultados();
  var mesSel = document.getElementById('rank-mes') ? document.getElementById('rank-mes').value : '';
  var anoSel = document.getElementById('rank-ano') ? parseInt(document.getElementById('rank-ano').value) : new Date().getFullYear();

  var res = resultados.filter(function(r){
    if (!r.dataHora) return false;
    var p=r.dataHora.split(' ')[0].split('/');
    if (p.length<3) return true;
    var d=new Date(p[2]+'-'+p[1]+'-'+p[0]);
    if (anoSel && d.getFullYear()!==anoSel) return false;
    if (mesSel!=='' && d.getMonth()!==parseInt(mesSel)) return false;
    return true;
  });

  var MEDALS = ['🥇','🥈','🥉'];

  // ── RANKING DE OPERADORES ──────────────────────────────────
  var opMap = {};
  res.forEach(function(r){
    if (!opMap[r.operador]) opMap[r.operador]={env:0,comp:0,soma:0,pontos:0};
    opMap[r.operador].env++;
    if (r.pct===100) opMap[r.operador].comp++;
    opMap[r.operador].soma   += r.pct;
    opMap[r.operador].pontos += calcPontos(r.pct);
  });
  var opList = Object.keys(opMap).map(function(n){
    var o=opMap[n];
    return {nome:n, env:o.env, comp:o.comp, pontos:o.pontos, media:Math.round(o.soma/o.env)};
  }).sort(function(a,b){ return b.pontos-a.pontos || b.media-a.media; });

  buildPodio('rank-podio', opList);

  var tbody = document.getElementById('rank-tbody');
  tbody.innerHTML = opList.length ? opList.map(function(o,i){
    var st = o.media===100?'st-ok':o.media>=70?'st-warn':'st-err';
    return '<tr>'
      +'<td>'+(MEDALS[i]||i+1)+'</td>'
      +'<td><strong>'+o.nome+'</strong></td>'
      +'<td><strong style="color:var(--g)">'+o.pontos+'</strong></td>'
      +'<td>'+o.env+'</td>'
      +'<td><span class="st '+(o.comp===o.env?'st-ok':'st-warn')+'">'+o.comp+'/'+o.env+'</span></td>'
      +'<td><span class="st '+st+'">'+o.media+'%</span></td>'
      +'</tr>';
  }).join('') : '<tr class="erow"><td colspan="6">Nenhum dado</td></tr>';

  // ── RANKING DE LOJAS ──────────────────────────────────────
  var users    = getUsers();
  var lojaMap  = {};
  res.forEach(function(r){
    // Busca loja do operador no cadastro
    var u = users.find(function(u){ return u.nome === r.operador; });
    var loja = (u && u.loja && u.loja.trim()) ? u.loja.trim() : 'Sem loja';
    if (!lojaMap[loja]) lojaMap[loja]={env:0,comp:0,soma:0,pontos:0};
    lojaMap[loja].env++;
    if (r.pct===100) lojaMap[loja].comp++;
    lojaMap[loja].soma   += r.pct;
    lojaMap[loja].pontos += calcPontos(r.pct);
  });
  var lojaList = Object.keys(lojaMap).map(function(n){
    var o=lojaMap[n];
    return {nome:n, env:o.env, comp:o.comp, pontos:o.pontos, media:Math.round(o.soma/o.env)};
  }).sort(function(a,b){ return b.pontos-a.pontos || b.media-a.media; });

  buildPodio('rank-lojas-podio', lojaList);

  var lojasTbody = document.getElementById('rank-lojas-tbody');
  lojasTbody.innerHTML = lojaList.length ? lojaList.map(function(o,i){
    var st = o.media===100?'st-ok':o.media>=70?'st-warn':'st-err';
    var rowStyle = i===0 ? ' style="background:#fffbe6"' : '';
    return '<tr'+rowStyle+'>'
      +'<td>'+(MEDALS[i]||i+1)+'</td>'
      +'<td><strong>'+o.nome+'</strong></td>'
      +'<td><strong style="color:var(--g)">'+o.pontos+'</strong></td>'
      +'<td>'+o.env+'</td>'
      +'<td><span class="st '+(o.comp===o.env?'st-ok':'st-warn')+'">'+o.comp+'/'+o.env+'</span></td>'
      +'<td><span class="st '+st+'">'+o.media+'%</span></td>'
      +'</tr>';
  }).join('') : '<tr class="erow"><td colspan="6">Nenhum dado — cadastre a loja nos usuários</td></tr>';
}

// Clona elemento substituindo <canvas> por <img> com o conteúdo desenhado
function _cloneComImagens(containerEl) {
  // Se o container estiver oculto, mostra temporariamente para que o canvas tenha dimensões
  var origDisplay = containerEl.style.display;
  var wasHidden = origDisplay === 'none' || getComputedStyle(containerEl).display === 'none';
  if (wasHidden) {
    containerEl.style.display = 'block';
    // Força redimensionamento dos charts Chart.js dentro do container
    containerEl.querySelectorAll('canvas').forEach(function(c) {
      try {
        var ch = typeof Chart !== 'undefined' ? Chart.getChart(c) : null;
        if (ch) { ch.resize(); ch.update('none'); }
      } catch(e) {}
    });
  }

  var clone = containerEl.cloneNode(true);
  var origCanvases = containerEl.querySelectorAll('canvas');
  var cloneCanvases = clone.querySelectorAll('canvas');

  origCanvases.forEach(function(canvas, i) {
    try {
      var dataUrl = '';
      // Usa API do Chart.js quando disponível (mais confiável que toDataURL direto)
      var chart = typeof Chart !== 'undefined' ? Chart.getChart(canvas) : null;
      if (chart) {
        dataUrl = chart.toBase64Image('image/png', 1);
      } else {
        dataUrl = canvas.toDataURL('image/png');
      }
      if (!dataUrl || dataUrl === 'data:,' || dataUrl.length < 50) return;
      var img = document.createElement('img');
      img.src = dataUrl;
      var w = canvas.offsetWidth || canvas.width || 0;
      var h = canvas.offsetHeight || canvas.height || 0;
      img.style.cssText = 'display:block;max-width:100%;'
        + (w > 0 ? 'width:'+w+'px;' : 'width:100%;')
        + (h > 0 ? 'height:'+h+'px;' : '');
      var cl = cloneCanvases[i];
      if (cl && cl.parentNode) cl.parentNode.replaceChild(img, cl);
    } catch(e) {}
  });

  if (wasHidden) containerEl.style.display = origDisplay;
  return clone.innerHTML;
}

// ── Exportar PDF ──
function exportarRelatorioSupervisor() {
  var logoEl = document.querySelector('.sb-logo img');
  var logoSrc = logoEl ? logoEl.src : '';
  var agora = new Date();
  var hojeStr = agora.toLocaleDateString('pt-BR');
  var hojeExtenso = agora.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  hojeExtenso = hojeExtenso.charAt(0).toUpperCase()+hojeExtenso.slice(1);
  var loja = (S.currentUser && S.currentUser.loja) ? S.currentUser.loja : 'Cahu360';

  var resultados = getResultados();
  var resultadosHoje = resultados.filter(function(r){ return r.dataHora && r.dataHora.indexOf(hojeStr)===0; });
  var totalEnvios = resultadosHoje.length;
  var completos = resultadosHoje.filter(function(r){return r.pct===100;}).length;
  var media = totalEnvios ? Math.round(resultadosHoje.reduce(function(s,r){return s+r.pct;},0)/totalEnvios) : 0;

  // Auxiliares de prevenção que enviaram hoje
  var prevencaoHoje = resultadosHoje.filter(function(r){return r.perfil==='prevencao';});
  var opsUnicos = [];
  prevencaoHoje.forEach(function(r){ if(opsUnicos.indexOf(r.operador)<0) opsUnicos.push(r.operador); });

  // Todos os usuários de prevenção
  var users = getUsers().filter(function(u){return u.perfil==='prevencao' && u.ativo;});

  // Perdas do dia
  var totalPerdas = S.perdaItems.reduce(function(s,i){return s+i.total;},0);

  // ── Seção: Status da equipe de prevenção ──
  var equipeTbody = users.length ? users.map(function(u){
    var urs = prevencaoHoje.filter(function(r){return r.operador===u.nome;});
    var enviou = urs.length>0;
    var mediU = enviou ? Math.round(urs.reduce(function(s,r){return s+r.pct;},0)/urs.length) : null;
    var cor = !enviou?'#e74c3c':mediU===100?'#2d9e62':mediU>=80?'#27ae60':mediU>=60?'#d68910':'#e74c3c';
    var status = !enviou?'Pendente':mediU===100?'Concluído 100%':mediU+'% concluído';
    return '<tr>'
      +'<td>'+u.nome+'</td>'
      +'<td>'+(u.loja||loja)+'</td>'
      +'<td>'+urs.length+' envio'+(urs.length>1?'s':'')+'</td>'
      +'<td style="font-weight:700;color:'+cor+'">'+status+'</td>'
      +'</tr>';
  }).join('') : '<tr><td colspan="4" style="text-align:center;color:#999">Nenhum auxiliar cadastrado</td></tr>';

  // ── Seção: Checklists de prevenção enviados ──
  var checkTbody = prevencaoHoje.length ? prevencaoHoje.slice().reverse().map(function(r){
    var cor = r.pct===100?'#2d9e62':r.pct>=60?'#d68910':'#e74c3c';
    return '<tr>'
      +'<td>'+r.dataHora.split(' ')[1]+'</td>'
      +'<td>'+r.operador+'</td>'
      +'<td>'+r.checklistNome+'</td>'
      +'<td style="font-weight:700;color:'+cor+'">'+r.pct+'%</td>'
      +'</tr>';
  }).join('') : '<tr><td colspan="4" style="text-align:center;color:#999">Nenhum checklist enviado hoje</td></tr>';

  // ── Seção: Perdas do dia ──
  var perdasTbody = S.perdaItems.length ? S.perdaItems.slice().reverse().map(function(p){
    return '<tr>'
      +'<td>'+p.hora+'</td>'
      +'<td>'+p.produto+'</td>'
      +'<td>'+p.setor+'</td>'
      +'<td>'+p.motivo+'</td>'
      +'<td>'+p.qtd+'</td>'
      +'<td style="font-weight:700;color:#e74c3c">R$ '+p.total.toFixed(2)+'</td>'
      +'</tr>';
  }).join('') : '<tr><td colspan="6" style="text-align:center;color:#999">Nenhuma perda registrada hoje</td></tr>';

  var statusCor = media>=80?'#2d9e62':media>=60?'#d68910':'#e74c3c';
  var statusTxt = media>=80?'NORMAL':media>=60?'ATENÇÃO':'CRÍTICO';

  var html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><title>Relatório Supervisor — '+hojeStr+'</title>'
    +'<style>'
    +'*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif}'
    +'body{padding:32px;color:#111;font-size:12px;background:#fff}'
    +'.header{display:flex;align-items:center;justify-content:space-between;border-bottom:4px solid #FFC600;padding-bottom:16px;margin-bottom:24px}'
    +'.header img{height:56px;object-fit:contain}'
    +'.header-r{text-align:right}'
    +'.header-r h1{font-size:17px;font-weight:700;color:#111}'
    +'.header-r p{font-size:11px;color:#666;margin-top:3px}'
    +'.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}'
    +'.kpi{background:#f8f9fa;border-radius:8px;padding:14px;border-left:4px solid #FFC600}'
    +'.kpi .k-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#888;margin-bottom:6px}'
    +'.kpi .k-val{font-size:22px;font-weight:800;color:#111}'
    +'.kpi .k-sub{font-size:10px;color:#888;margin-top:3px}'
    +'.status-pill{display:inline-block;padding:4px 14px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:'+statusCor+'}'
    +'.section{margin-bottom:24px}'
    +'.section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#333;border-bottom:2px solid #FFC600;padding-bottom:6px;margin-bottom:12px}'
    +'table{width:100%;border-collapse:collapse;font-size:11px}'
    +'th{background:#FFC600;padding:8px 10px;text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:#111}'
    +'td{padding:8px 10px;border-bottom:1px solid #eee}'
    +'tr:last-child td{border:none}'
    +'.assinatura{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}'
    +'.ass-box{border-top:1px solid #333;padding-top:8px;font-size:11px;color:#555}'
    +'.footer{margin-top:28px;padding-top:10px;border-top:1px solid #eee;display:flex;justify-content:space-between;font-size:9.5px;color:#999}'
    +'@media print{body{padding:20px}}'
    +'</style></head><body>'

    // Cabeçalho
    +'<div class="header">'
    +(logoSrc?'<img src="'+logoSrc+'" alt="Logo"/>':'<div style="font-size:18px;font-weight:800">Cahu360</div>')
    +'<div class="header-r">'
    +'<h1>Relatório Diário — Prevenção de Perdas</h1>'
    +'<p>'+hojeExtenso+'</p>'
    +'<p>Loja: <strong>'+loja+'</strong> &nbsp;|&nbsp; Status: <span class="status-pill">'+statusTxt+'</span></p>'
    +'</div></div>'

    // KPIs
    +'<div class="kpis">'
    +'<div class="kpi"><div class="k-lbl">Checklists Enviados</div><div class="k-val">'+totalEnvios+'</div><div class="k-sub">'+completos+' com 100%</div></div>'
    +'<div class="kpi"><div class="k-lbl">Conformidade Geral</div><div class="k-val" style="color:'+statusCor+'">'+media+'%</div><div class="k-sub">média do dia</div></div>'
    +'<div class="kpi"><div class="k-lbl">Aux. Prevenção Ativos</div><div class="k-val">'+opsUnicos.length+'</div><div class="k-sub">de '+users.length+' cadastrados</div></div>'
    +'<div class="kpi"><div class="k-lbl">Total de Perdas</div><div class="k-val" style="color:#e74c3c">R$ '+totalPerdas.toFixed(2)+'</div><div class="k-sub">'+S.perdaItems.length+' registros</div></div>'
    +'</div>'

    // Status da equipe
    +'<div class="section"><div class="section-title">Status da Equipe de Prevenção</div>'
    +'<table><thead><tr><th>Auxiliar</th><th>Loja</th><th>Envios</th><th>Status</th></tr></thead>'
    +'<tbody>'+equipeTbody+'</tbody></table></div>'

    // Checklists executados
    +'<div class="section"><div class="section-title">Checklists Executados — Prevenção</div>'
    +'<table><thead><tr><th>Hora</th><th>Auxiliar</th><th>Checklist</th><th>Conclusão</th></tr></thead>'
    +'<tbody>'+checkTbody+'</tbody></table></div>'

    // Perdas registradas
    +'<div class="section"><div class="section-title">Perdas Registradas no Dia</div>'
    +'<table><thead><tr><th>Hora</th><th>Produto</th><th>Setor</th><th>Motivo</th><th>Qtd</th><th>Total</th></tr></thead>'
    +'<tbody>'+perdasTbody+'</tbody></table></div>'

    // Assinaturas
    +'<div class="assinatura">'
    +'<div class="ass-box">Responsável pela Prevenção de Perdas</div>'
    +'<div class="ass-box">Supervisor / Gerente</div>'
    +'</div>'

    +'<div class="footer"><span>Cahu360 Process © '+agora.getFullYear()+'</span><span>Gerado em: '+agora.toLocaleString('pt-BR')+'</span></div>'
    +'</body></html>';

  var w = window.open('','_blank','width=900,height=700');
  if (w) {
    w.document.write(html);
    w.document.close();
    w.onload = function(){ w.print(); };
  } else {
    showToast('Permita pop-ups para gerar o relatório.');
  }
}

// ===========================================
// PLANO DE AÇÃO
// ===========================================
var editingPlanoId = null;
var planoFiltroAtual = 'aberto';

var _planilhaTemplates = {}; // { "clId_itemIdx_loja": [...produtos] } — planilhas diárias carregadas do Firebase

var _planosCache = null;
function getPlanos() {
  if (_planosCache) return _planosCache;
  try { _planosCache = JSON.parse(localStorage.getItem(PLANO_KEY)||'[]'); } catch(e){ _planosCache = []; }
  return _planosCache;
}
function savePlanos(list) {
  _planosCache = list;
  try { localStorage.setItem(PLANO_KEY, JSON.stringify(list)); } catch(e) {}
  list.forEach(function(p){ db.collection('planos').doc(p.id).set(p).catch(function(){}); });
}
function loadPlanosFromFirebase(cb) {
  db.collection('planos').get().then(function(snap){
    var list = snap.docs.map(function(d){ return d.data(); });
    _planosCache = list;
    try { localStorage.setItem(PLANO_KEY, JSON.stringify(list)); } catch(e) {}
    if (cb) cb();
  }).catch(function(){ if (cb) cb(); });
}

function abrirModalPlano(dadosAuto) {
  editingPlanoId = null;
  document.getElementById('mplano-title').textContent = 'Novo Plano de Ação';
  document.getElementById('plano-desc').value = dadosAuto ? (dadosAuto.desc||'') : '';
  document.getElementById('plano-resp').value = '';
  document.getElementById('plano-prazo').value = '';
  document.getElementById('plano-origem').value = dadosAuto ? (dadosAuto.origem||'') : '';
  document.getElementById('plano-obs').value = '';
  document.getElementById('mplano-err').style.display='none';
  document.getElementById('modal-plano').style.display='flex';
}

function fecharModalPlano() { document.getElementById('modal-plano').style.display='none'; }

function salvarPlano() {
  var desc = document.getElementById('plano-desc').value.trim();
  var err = document.getElementById('mplano-err');
  if (!desc) { err.textContent='Informe o que precisa ser feito.'; err.style.display='block'; return; }
  var list = getPlanos();
  var now = new Date().toLocaleString('pt-BR');
  var loja = S.currentUser ? (S.currentUser.loja||'') : '';
  var prazoHoras = parseInt((document.getElementById('plano-prazo-horas')||{}).value||'72');
  var prazoFim = new Date(Date.now() + prazoHoras * 3600000).toISOString();
  var mensagem = (document.getElementById('plano-mensagem')||{}).value || '';
  if (editingPlanoId) {
    list = list.map(function(p){ return p.id===editingPlanoId ? Object.assign({},p,{desc:desc,responsavel:document.getElementById('plano-resp').value.trim(),prazo:document.getElementById('plano-prazo').value,origem:document.getElementById('plano-origem').value.trim(),obs:document.getElementById('plano-obs').value.trim(),prazoHoras:prazoHoras,prazoFim:prazoFim,mensagem:mensagem.trim()}) : p; });
  } else {
    var quem = S.currentUser ? S.currentUser.nome : '—';
    list.push({id:genId(),desc:desc,responsavel:document.getElementById('plano-resp').value.trim(),prazo:document.getElementById('plano-prazo').value,origem:document.getElementById('plano-origem').value.trim(),obs:document.getElementById('plano-obs').value.trim(),status:'aberto',loja:loja,criadoEm:now,criadoTimestamp:new Date().toISOString(),criadoPor:quem,prazoHoras:prazoHoras,prazoFim:prazoFim,mensagem:mensagem.trim(),prorrogacoes:[],historico:[{acao:'criado',para:'aberto',por:quem,em:now}]});
  }
  savePlanos(list);
  fecharModalPlano();
  renderPlanos(planoFiltroAtual);
  atualizarBadgePlano();
  showToast('Plano salvo!');
}

var _pendingStatusPlano = null; // {id, novoStatus}
var _pendingConclusaoFoto = null; // base64 string

function atualizarStatusPlano(id, novoStatus) {
  var plano = getPlanos().find(function(p){ return p.id === id; });
  if (!plano) return;
  _pendingStatusPlano = {id: id, novoStatus: novoStatus};

  if (novoStatus === 'resolvido') {
    // Abre modal de conclusão separado
    document.getElementById('mconcl-desc').textContent = plano.desc;
    document.getElementById('mconcl-texto').value = '';
    var fi = document.getElementById('mconcl-foto'); if (fi) fi.value = '';
    document.getElementById('mconcl-preview').style.display = 'none';
    document.getElementById('mconcl-err').style.display = 'none';
    _pendingConclusaoFoto = null;
    document.getElementById('modal-conclusao-plano').style.display = 'flex';
    return;
  }

  var iconMap = {andamento:'▶', aberto:'🔄'};
  var tituloMap = {andamento:'Iniciar este plano?', aberto:'Reabrir este plano?'};
  var descMap = {
    andamento: 'O plano passará para <strong>Em Andamento</strong>.',
    aberto: 'O plano voltará para <strong>Aberto</strong>.'
  };
  document.getElementById('mcp-icon').textContent = iconMap[novoStatus] || '?';
  document.getElementById('mcp-titulo').textContent = tituloMap[novoStatus] || 'Confirmar?';
  document.getElementById('mcp-desc').innerHTML = '<strong style="font-size:13px;display:block;margin-bottom:4px">'+plano.desc+'</strong>' + (descMap[novoStatus]||'');

  var iniciarFields = document.getElementById('mcp-iniciar-fields');
  if (iniciarFields) iniciarFields.style.display = novoStatus === 'andamento' ? 'block' : 'none';
  // pré-preenche com o usuário atual
  if (novoStatus === 'andamento') {
    var nomeEl = document.getElementById('mcp-iniciar-nome');
    var perfilEl = document.getElementById('mcp-iniciar-perfil');
    if (nomeEl) nomeEl.value = S.currentUser ? (S.currentUser.nome || '') : '';
    if (perfilEl) perfilEl.value = S.currentUser ? (S.currentUser.perfil || 'operator') : 'operator';
  }
  document.getElementById('modal-confirm-plano').style.display = 'flex';
}

function confirmarStatusPlano() {
  document.getElementById('modal-confirm-plano').style.display = 'none';
  if (!_pendingStatusPlano) return;
  var id = _pendingStatusPlano.id;
  var novoStatus = _pendingStatusPlano.novoStatus;
  _pendingStatusPlano = null;

  var extras = {};
  if (novoStatus === 'andamento') {
    var nome = (document.getElementById('mcp-iniciar-nome')||{}).value || '';
    var perfil = (document.getElementById('mcp-iniciar-perfil')||{}).value || '';
    if (nome) extras.iniciadoPor = { nome: nome.trim(), perfil: perfil, em: new Date().toLocaleString('pt-BR') };
  }

  var updatedPlano = null;
  var acaoMap = {andamento:'iniciado', aberto:'reaberto'};
  var quemStatus = S.currentUser ? S.currentUser.nome : '—';
  var agora = new Date().toLocaleString('pt-BR');
  var list = getPlanos().map(function(p){
    if (p.id !== id) return p;
    var hist = (p.historico||[]).concat([{acao: acaoMap[novoStatus]||novoStatus, de: p.status, para: novoStatus, por: quemStatus, em: agora}]);
    updatedPlano = Object.assign({}, p, extras, { status: novoStatus, historico: hist });
    return updatedPlano;
  });
  if (!updatedPlano) return;

  _planosCache = list;
  try { localStorage.setItem(PLANO_KEY, JSON.stringify(list)); } catch(e) {}
  db.collection('planos').doc(id).set(updatedPlano).then(function(){
    var msgs = {andamento:'▶ Plano em andamento!', aberto:'🔄 Plano reaberto!'};
    showToast(msgs[novoStatus] || 'Status atualizado');
  }).catch(function(err){
    showToast('⚠ Firebase: ' + (err && err.code ? err.code : 'erro ao salvar'));
    console.error('Firebase plano erro:', err);
  });
  renderPlanos(planoFiltroAtual);
  atualizarBadgePlano();
}

function onConcluFotoChange(input) {
  var file = input.files[0];
  if (!file) { _pendingConclusaoFoto = null; return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var canvas = document.createElement('canvas');
      var maxSize = 800;
      var ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      _pendingConclusaoFoto = canvas.toDataURL('image/jpeg', 0.72);
      var prev = document.getElementById('mconcl-preview');
      var prevImg = document.getElementById('mconcl-preview-img');
      if (prev && prevImg) { prevImg.src = _pendingConclusaoFoto; prev.style.display = 'block'; }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function confirmarConclusaoPlano() {
  var texto = (document.getElementById('mconcl-texto')||{}).value || '';
  var err = document.getElementById('mconcl-err');
  if (!texto.trim()) {
    if (err) { err.textContent = 'Descreva o que foi feito.'; err.style.display = 'block'; }
    return;
  }
  if (_isFotoObrig() && !_pendingConclusaoFoto) {
    if (err) { err.textContent = '📷 Foto obrigatória — anexe uma foto da conclusão.'; err.style.display = 'block'; }
    return;
  }
  if (err) err.style.display = 'none';
  if (!_pendingStatusPlano) return;
  var id = _pendingStatusPlano.id;
  _pendingStatusPlano = null;
  document.getElementById('modal-conclusao-plano').style.display = 'none';

  var quemConcl = S.currentUser ? S.currentUser.nome : '—';
  var agoraConcl = new Date().toLocaleString('pt-BR');
  var updatedPlano = null;
  var list = getPlanos().map(function(p){
    if (p.id !== id) return p;
    var hist = (p.historico||[]).concat([{acao:'resolvido', de: p.status, para:'resolvido', por: quemConcl, em: agoraConcl}]);
    updatedPlano = Object.assign({}, p, {
      status: 'resolvido',
      resolvidoEm: agoraConcl,
      resolvidoTimestamp: new Date().toISOString(),
      historico: hist,
      conclusao: { texto: texto.trim(), foto: _pendingConclusaoFoto || '' }
    });
    return updatedPlano;
  });
  _pendingConclusaoFoto = null;
  if (!updatedPlano) return;

  _planosCache = list;
  try { localStorage.setItem(PLANO_KEY, JSON.stringify(list)); } catch(e) {}
  db.collection('planos').doc(id).set(updatedPlano).then(function(){
    showToast('✅ Plano resolvido!');
  }).catch(function(err){
    showToast('⚠ Firebase: ' + (err && err.code ? err.code : 'erro ao salvar'));
  });
  renderPlanos(planoFiltroAtual);
  atualizarBadgePlano();
}

function toggleFotoObrig(chk) {
  try { localStorage.setItem('cahu360_fotoObrig', chk.checked ? '1' : '0'); } catch(e) {}
}

function _isFotoObrig() {
  try { return localStorage.getItem('cahu360_fotoObrig') === '1'; } catch(e) { return false; }
}

function initFotoObrigToggle() {
  var isAdmin = S.role === 'admin' || S.role === 'gerencia';
  var toggle = document.getElementById('foto-obrig-toggle');
  var chk = document.getElementById('foto-obrig-check');
  if (toggle) toggle.style.display = isAdmin ? 'flex' : 'none';
  if (chk) chk.checked = _isFotoObrig();
}

var _planoPageCount = 1;
var PLANO_PAGE_SIZE = 10;

function filtrarPlanos(filtro, el) {
  planoFiltroAtual = filtro;
  _planoPageCount = 1;
  document.querySelectorAll('#plano-filter-tabs .tab').forEach(function(t){ t.classList.remove('on'); });
  if (el) el.classList.add('on');
  renderPlanos(filtro);
}

function renderPlanos(filtro) {
  var lista = getPlanos();
  var loja = S.currentUser ? (S.currentUser.loja||'').toLowerCase() : '';
  var isAdmin = S.role==='admin'||S.role==='gerencia';
  if (!isAdmin && loja) lista = lista.filter(function(p){ return (p.loja||'').toLowerCase()===loja; });
  if (filtro && filtro!=='todos') lista = lista.filter(function(p){ return p.status===filtro; });
  lista = lista.slice().reverse();
  var wrap = document.getElementById('plano-lista');
  if (!wrap) return;
  if (!lista.length) { wrap.innerHTML='<div style="text-align:center;padding:32px;color:var(--t3);font-size:13px">Nenhum plano nesta categoria.</div>'; return; }
  var totalLista = lista.length;
  lista = lista.slice(0, PLANO_PAGE_SIZE * _planoPageCount);
  var STATUS_COR = {aberto:'var(--r)',andamento:'var(--am)',resolvido:'var(--g)'};
  var STATUS_LABEL = {aberto:'🔴 Aberto',andamento:'🟡 Em Andamento',resolvido:'✅ Resolvido'};
  var PERFIL_LABEL = {operator:'Operador',prevencao:'Prevenção',gerencia:'Gerência',admin:'Administrador'};
  var verMaisHtml = (totalLista > lista.length)
    ? '<div style="text-align:center;padding:16px"><button class="btn btn-s btn-sm" onclick="_planoPageCount++;renderPlanos(planoFiltroAtual)">Ver mais ('+(totalLista - lista.length)+' restantes)</button></div>'
    : '';
  wrap.innerHTML = lista.map(function(p){
    var cor = STATUS_COR[p.status]||'var(--t3)';
    var lojaTag = (p.loja && isAdmin) ? '<span style="background:#fff8e1;color:#b45309;border-radius:5px;padding:1px 8px;font-size:11px;font-weight:600;margin-right:4px">🏪 '+p.loja+'</span>' : '';
    var iniInfo = (p.iniciadoPor && p.iniciadoPor.nome)
      ? '<div style="font-size:11px;color:var(--t2);margin-top:5px">▶ Iniciado por <strong>'+p.iniciadoPor.nome+'</strong> ('+(PERFIL_LABEL[p.iniciadoPor.perfil]||p.iniciadoPor.perfil||'')+')'+(p.iniciadoPor.em?' — '+p.iniciadoPor.em:'')+'</div>' : '';
    // Prazo countdown
    var prazoHtml = '';
    var inf = _prazoInfo(p);
    if (inf && p.status !== 'resolvido') {
      prazoHtml = '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;color:#fff;background:'+inf.cor+';margin-left:6px">⏱ '+inf.texto+'</span>';
    }
    if (p.mensagem && p.status !== 'resolvido') {
      prazoHtml += '<div style="font-size:11px;color:#0369a1;margin-top:4px;padding:4px 8px;background:#f0f9ff;border-radius:6px;border-left:3px solid #38bdf8">💬 '+p.mensagem+'</div>';
    }
    // Prorrogações
    var prorrogHtml = '';
    var prorrogs = p.prorrogacoes || [];
    var pendentes = prorrogs.filter(function(pr){ return pr.status==='pendente'; });
    var ultimaProrr = prorrogs.length ? prorrogs[prorrogs.length-1] : null;
    if (p.status !== 'resolvido') {
      if (pendentes.length) {
        prorrogHtml = '<div style="font-size:11px;color:#b45309;margin-top:6px;padding:5px 8px;background:#fff8e1;border-radius:6px">⏳ Prorrogação aguardando aprovação da Central</div>';
        if (isAdmin) {
          pendentes.forEach(function(pr){
            prorrogHtml += '<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 8px;background:#fff8e1;border-radius:6px;margin-top:4px;flex-wrap:wrap">'
              +'<span><strong>'+pr.solicitadoPor+'</strong> pede +'+pr.horasExtras+'h: "'+pr.motivo+'"</span>'
              +'<button class="btn btn-p btn-sm" style="font-size:11px;padding:2px 8px" onclick="avaliarProrrogacao(\''+p.id+'\',\''+pr.id+'\',true)">✓ Aprovar</button>'
              +'<button class="btn btn-s btn-sm" style="font-size:11px;padding:2px 8px" onclick="avaliarProrrogacao(\''+p.id+'\',\''+pr.id+'\',false)">✗ Rejeitar</button>'
              +'</div>';
          });
        }
      } else if (inf && inf.vencido && !isAdmin) {
        prorrogHtml = '<div style="margin-top:6px"><button class="btn btn-s btn-sm" style="font-size:11px" onclick="solicitarProrrogacao(\''+p.id+'\')">⏳ Solicitar Prorrogação</button></div>';
      } else if (ultimaProrr && ultimaProrr.status==='rejeitado') {
        prorrogHtml = '<div style="font-size:11px;color:var(--r);margin-top:4px">❌ Prorrogação rejeitada'+(ultimaProrr.avaliadoPor?' por '+ultimaProrr.avaliadoPor:'')+'</div>';
        if (!isAdmin) prorrogHtml += '<div style="margin-top:4px"><button class="btn btn-s btn-sm" style="font-size:11px" onclick="solicitarProrrogacao(\''+p.id+'\')">↩ Solicitar novamente</button></div>';
      }
    }
    var conclusaoHtml = '';
    if (p.conclusao && p.conclusao.texto) {
      conclusaoHtml = '<div style="margin-top:10px;padding:8px 12px;background:#f0fdf4;border-left:3px solid var(--g);border-radius:6px">'
        +'<div style="font-size:11px;font-weight:600;color:var(--g);margin-bottom:3px">✅ O que foi feito</div>'
        +'<div style="font-size:12px;color:var(--t)">'+p.conclusao.texto+'</div>'
        +(p.conclusao.foto ? '<div style="margin-top:6px"><img src="'+p.conclusao.foto+'" style="max-width:100%;max-height:160px;border-radius:8px;object-fit:cover;border:1px solid var(--gray2)"/></div>' : '')
        +'</div>';
    }
    var histHtml = '';
    if (p.historico && p.historico.length) {
      var ACAO_LABEL = {criado:'Criado',iniciado:'Iniciado',resolvido:'Resolvido',reaberto:'Reaberto',prorrogacao_pedida:'Prorrogação solicitada',prorrogacao_aprovada:'Prorrogação aprovada',prorrogacao_rejeitada:'Prorrogação rejeitada'};
      histHtml = '<details style="margin-top:8px"><summary style="font-size:11px;color:var(--t3);cursor:pointer">🕓 Histórico ('+p.historico.length+')</summary>'
        +'<div style="margin-top:6px;border-left:2px solid var(--gray2);padding-left:10px">'
        +p.historico.map(function(h){
          return '<div style="font-size:11px;color:var(--t2);margin-bottom:4px">'
            +'<span style="font-weight:600;color:var(--t)">'+(ACAO_LABEL[h.acao]||h.acao)+'</span>'
            +' — '+h.por+' <span style="color:var(--t3)">'+h.em+'</span></div>';
        }).join('')
        +'</div></details>';
    }
    return '<div style="background:#fff;border:1px solid var(--gray2);border-left:4px solid '+cor+';border-radius:12px;padding:16px 18px;box-shadow:var(--sh)">'
      +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">'
      +'<div style="flex:1;min-width:0">'
      +'<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:4px">'+lojaTag+'<span style="font-size:14px;font-weight:700;color:var(--t)">'+p.desc+'</span>'+prazoHtml+'</div>'
      +(p.origem?'<div style="font-size:11px;color:var(--t3);margin-bottom:4px">📋 '+p.origem+'</div>':'')
      +'<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--t2)">'
      +(p.responsavel?'<span>👤 '+p.responsavel+'</span>':'')
      +(p.prazo?'<span>📅 '+p.prazo+'</span>':'')
      +'<span style="color:'+cor+';font-weight:600">'+STATUS_LABEL[p.status]+'</span>'
      +'</div>'
      +iniInfo
      +(p.obs?'<div style="font-size:12px;color:var(--t3);margin-top:6px;padding:6px 10px;background:var(--gray);border-radius:6px">'+p.obs+'</div>':'')
      +prorrogHtml+conclusaoHtml+histHtml
      +'</div>'
      +'<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">'
      +(p.status==='aberto'?'<button class="btn btn-s btn-sm" onclick="atualizarStatusPlano(\''+p.id+'\',\'andamento\')">Iniciar</button>':'')
      +(p.status==='andamento'?'<button class="btn btn-p btn-sm" onclick="atualizarStatusPlano(\''+p.id+'\',\'resolvido\')">Resolver</button>':'')
      +(p.status==='resolvido'?'<button class="btn btn-s btn-sm" onclick="atualizarStatusPlano(\''+p.id+'\',\'aberto\')">Reabrir</button>':'')
      +'</div>'
      +'</div>'
      +'<div style="font-size:10px;color:var(--t3);margin-top:8px">Criado em '+p.criadoEm+' por '+p.criadoPor+(p.resolvidoEm?' · Resolvido em '+p.resolvidoEm:'')+'</div>'
      +'</div>';
  }).join('') + verMaisHtml;
}

function atualizarBadgePlano() {
  var badge = document.getElementById('badge-plano');
  if (!badge) return;
  var abertos = getPlanos().filter(function(p){ return p.status==='aberto'; }).length;
  if (abertos > 0) { badge.style.display='flex'; badge.textContent=abertos; }
  else { badge.style.display='none'; }
}

function criarPlanoAuto(checklistNome, itemTexto, justificativa, setor, prazoHoras) {
  var loja = S.currentUser ? (S.currentUser.loja||'') : '';
  var list = getPlanos();
  var desc = '['+checklistNome+'] '+itemTexto;
  prazoHoras = prazoHoras || 72;
  var prazoFim = new Date(Date.now() + prazoHoras * 3600000).toISOString();
  var quemAuto = S.currentUser ? S.currentUser.nome : '—';
  var nowAuto = new Date().toLocaleString('pt-BR');
  list.push({id:genId(),desc:desc,responsavel:'',prazo:'',origem:checklistNome,obs:justificativa||'',status:'aberto',loja:loja,setor:setor||'',criadoEm:nowAuto,criadoTimestamp:new Date().toISOString(),criadoPor:quemAuto,prazoHoras:prazoHoras,prazoFim:prazoFim,mensagem:'',prorrogacoes:[],historico:[{acao:'criado',para:'aberto',por:quemAuto,em:nowAuto}]});
  savePlanos(list);
  atualizarBadgePlano();
}

// Retorna info de prazo { vencido, urgente, texto, cor } ou null
function _prazoInfo(p) {
  if (!p.prazoFim) return null;
  var now = Date.now();
  var fim = new Date(p.prazoFim).getTime();
  var diffMs = fim - now;
  if (diffMs < 0) {
    var overH = Math.floor(-diffMs / 3600000);
    var overD = Math.floor(overH / 24);
    var txt = overD > 0 ? (overD+'d '+(overH%24)+'h vencido') : (overH+'h vencido');
    return { vencido:true, urgente:true, texto:txt, cor:'var(--r)' };
  }
  var h = Math.floor(diffMs / 3600000);
  var d = Math.floor(h / 24);
  var m = Math.floor((diffMs % 3600000) / 60000);
  var txt2 = d > 0 ? (d+'d '+(h%24)+'h restantes') : (h+'h '+m+'m restantes');
  var urgente = diffMs < 24 * 3600000;
  return { vencido:false, urgente:urgente, texto:txt2, cor: urgente ? '#d68910' : 'var(--g)' };
}

// Verifica se submissão de checklist deve ser bloqueada por plano vencido
function _planosVencidosDoUsuario() {
  var uLoja = S.currentUser ? (S.currentUser.loja||'').toLowerCase() : '';
  var agora = Date.now();
  return getPlanos().filter(function(p) {
    if (p.status === 'resolvido') return false;
    if (uLoja && (p.loja||'').toLowerCase() !== uLoja) return false;
    return p.prazoFim && new Date(p.prazoFim).getTime() < agora;
  });
}

function renderAlertaPlanos() {
  var wrap = document.getElementById('plano-alert-banner');
  if (!wrap) return;
  var isAdm = S.role === 'admin' || S.role === 'gerencia';
  if (isAdm) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
  var uLoja = S.currentUser ? (S.currentUser.loja||'').toLowerCase() : '';
  var agora = Date.now();
  var planos = getPlanos().filter(function(p) {
    if (p.status === 'resolvido') return false;
    if (uLoja && (p.loja||'').toLowerCase() !== uLoja) return false;
    return true;
  });
  var vencidos = planos.filter(function(p){ return p.prazoFim && new Date(p.prazoFim).getTime() < agora; });
  var urgentes = planos.filter(function(p){
    if (!p.prazoFim) return false;
    var fim = new Date(p.prazoFim).getTime();
    return fim > agora && fim < agora + 24*3600000;
  });
  var abertos = planos.filter(function(p){ return !p.prazoFim || new Date(p.prazoFim).getTime() >= agora; });
  var html = '';
  if (vencidos.length) {
    html += '<div style="background:#fee2e2;border:1.5px solid #fca5a5;border-radius:10px;padding:12px 16px;margin-bottom:8px">'
      +'<div style="font-size:13px;font-weight:700;color:#b91c1c;margin-bottom:8px">🚨 '+vencidos.length+' Plano(s) de Ação VENCIDO(S) — Envio de Checklist Bloqueado!</div>'
      +vencidos.map(function(p){
        var inf = _prazoInfo(p);
        var temPendente = (p.prorrogacoes||[]).some(function(pr){ return pr.status==='pendente'; });
        return '<div style="padding:6px 0;border-top:1px solid #fca5a580;font-size:12px;color:#7f1d1d">'
          +'<strong>'+p.desc+'</strong>'
          +(p.mensagem?' <em>— '+p.mensagem+'</em>':'')
          +' <span style="color:var(--r);font-weight:600">('+inf.texto+')</span>'
          +(temPendente
            ? ' <span style="color:#b45309;font-size:11px">⏳ Prorrogação aguardando aprovação</span>'
            : ' <button class="btn btn-s btn-sm" style="font-size:11px;padding:2px 8px;margin-left:6px" onclick="solicitarProrrogacao(\''+p.id+'\')">⏳ Prorrogar</button>')
          +'</div>';
      }).join('')
      +'</div>';
  }
  if (urgentes.length) {
    html += '<div style="background:#fff8e1;border:1.5px solid #fde68a;border-radius:10px;padding:10px 14px;margin-bottom:8px">'
      +'<div style="font-size:12px;font-weight:700;color:#b45309;margin-bottom:4px">⚠️ '+urgentes.length+' plano(s) vencem em menos de 24h!</div>'
      +urgentes.map(function(p){ var inf=_prazoInfo(p); return '<div style="font-size:12px;color:#78350f;padding:2px 0">• <strong>'+p.desc+'</strong> — <span style="color:#d68910">'+inf.texto+'</span></div>'; }).join('')
      +'</div>';
  }
  if (!vencidos.length && abertos.length) {
    html += '<div style="background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:10px;padding:10px 14px;margin-bottom:8px">'
      +'<div style="font-size:12px;font-weight:700;color:#0369a1;margin-bottom:4px">📋 '+abertos.length+' plano(s) de ação em aberto/andamento</div>'
      +abertos.slice(0,3).map(function(p){ var inf=_prazoInfo(p); return '<div style="font-size:12px;color:#075985;padding:2px 0">• <strong>'+p.desc+'</strong>'+(inf?' <span style="color:'+inf.cor+'">'+inf.texto+'</span>':'')+'</div>'; }).join('')
      +(abertos.length>3?'<div style="font-size:11px;color:#0369a1;margin-top:2px">...e mais '+(abertos.length-3)+' planos</div>':'')
      +'</div>';
  }
  wrap.innerHTML = html;
  wrap.style.display = html ? 'block' : 'none';
}

var _pendingProrrogacaoPlanoId = null;
function solicitarProrrogacao(planoId) {
  var plano = getPlanos().find(function(p){ return p.id === planoId; });
  if (!plano) return;
  _pendingProrrogacaoPlanoId = planoId;
  document.getElementById('mprorrog-desc').textContent = plano.desc;
  var m = document.getElementById('prorrog-motivo'); if (m) m.value = '';
  var h = document.getElementById('prorrog-horas'); if (h) h.value = '48';
  var e = document.getElementById('mprorrog-err'); if (e) e.style.display = 'none';
  document.getElementById('modal-prorrogacao').style.display = 'flex';
}

function salvarProrrogacao() {
  var motivo = (document.getElementById('prorrog-motivo')||{}).value || '';
  var horas = parseInt((document.getElementById('prorrog-horas')||{}).value||'48');
  var errEl = document.getElementById('mprorrog-err');
  if (!motivo.trim()) { if(errEl){errEl.textContent='Informe o motivo.';errEl.style.display='block';} return; }
  if (!_pendingProrrogacaoPlanoId) return;
  var plano = getPlanos().find(function(p){ return p.id === _pendingProrrogacaoPlanoId; });
  if (!plano) return;
  document.getElementById('modal-prorrogacao').style.display = 'none';
  var prorr = { id:genId(), solicitadoPor:S.currentUser?S.currentUser.nome:'—', motivo:motivo.trim(), horasExtras:horas, status:'pendente', solicitadoEm:new Date().toLocaleString('pt-BR') };
  var updated = Object.assign({}, plano, { prorrogacoes:(plano.prorrogacoes||[]).concat([prorr]) });
  var list = getPlanos().map(function(p){ return p.id===updated.id?updated:p; });
  _planosCache = list;
  try { localStorage.setItem(PLANO_KEY, JSON.stringify(list)); } catch(e) {}
  db.collection('planos').doc(updated.id).set(updated).catch(function(){});
  renderPlanos(planoFiltroAtual);
  renderAlertaPlanos();
  showToast('⏳ Solicitação enviada! Aguardando aprovação da Central.');
}

function avaliarProrrogacao(planoId, prorroId, aprovado) {
  var plano = getPlanos().find(function(p){ return p.id===planoId; });
  if (!plano) return;
  var prorrog = (plano.prorrogacoes||[]).find(function(pr){ return pr.id===prorroId; });
  var prorrogacoes = (plano.prorrogacoes||[]).map(function(pr){
    if (pr.id!==prorroId) return pr;
    return Object.assign({},pr,{status:aprovado?'aprovado':'rejeitado',avaliadoPor:S.currentUser?S.currentUser.nome:'—',avaliadoEm:new Date().toLocaleString('pt-BR')});
  });
  var updated = Object.assign({}, plano, { prorrogacoes:prorrogacoes });
  if (aprovado && prorrog && plano.prazoFim) {
    updated.prazoFim = new Date(new Date(plano.prazoFim).getTime() + prorrog.horasExtras*3600000).toISOString();
  }
  var list = getPlanos().map(function(p){ return p.id===updated.id?updated:p; });
  _planosCache = list;
  try { localStorage.setItem(PLANO_KEY, JSON.stringify(list)); } catch(e) {}
  db.collection('planos').doc(updated.id).set(updated).catch(function(){});
  renderPlanos(planoFiltroAtual);
  if (centralTabAtual==='plano') renderCentralPlanos();
  showToast(aprovado?'✅ Prorrogação aprovada! Prazo estendido.':'❌ Prorrogação rejeitada.');
}

// ===========================================
// ASSINATURA DIGITAL
// ===========================================
var _assinaturaDrawing = false;
var _assinaturaCtx = null;

function abrirAssinatura() {
  var clId = pendingEnviarId;
  var label = pendingEnviarLabel;
  if (!clId) return;
  document.getElementById('modal-enviar').style.display='none';
  var nomeEl = document.getElementById('assina-nome');
  if (nomeEl) nomeEl.textContent = label + ' — ' + (document.getElementById('env-pct')||{textContent:''}).textContent;
  var modal = document.getElementById('modal-assinatura');
  if (modal) modal.style.display='flex';
  setTimeout(initAssinaturaCanvas, 100);
}

function initAssinaturaCanvas() {
  var canvas = document.getElementById('assinatura-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  _assinaturaCtx = ctx;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  function getPos(e) {
    var r = canvas.getBoundingClientRect();
    var scaleX = canvas.width / r.width;
    var scaleY = canvas.height / r.height;
    var src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * scaleX, y: (src.clientY - r.top) * scaleY };
  }
  function startDraw(e) { e.preventDefault(); _assinaturaDrawing=true; var p=getPos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); }
  function draw(e) { if (!_assinaturaDrawing) return; e.preventDefault(); var p=getPos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); }
  function stopDraw() { _assinaturaDrawing=false; }
  canvas.onmousedown=startDraw; canvas.onmousemove=draw; canvas.onmouseup=stopDraw; canvas.onmouseleave=stopDraw;
  canvas.ontouchstart=startDraw; canvas.ontouchmove=draw; canvas.ontouchend=stopDraw;
}

function limparAssinatura() {
  var canvas = document.getElementById('assinatura-canvas');
  if (canvas && _assinaturaCtx) _assinaturaCtx.clearRect(0,0,canvas.width,canvas.height);
}

function confirmarComAssinatura() {
  var canvas = document.getElementById('assinatura-canvas');
  var assinatura = canvas ? canvas.toDataURL('image/png') : null;
  document.getElementById('modal-assinatura').style.display='none';
  confirmarEnviar(assinatura);
}

// ===========================================
// WHATSAPP
// ===========================================
function enviarWhatsApp() {
  var numSalvo = localStorage.getItem('cahu360_wp_numero') || '';
  var num = window.prompt('Número WhatsApp do supervisor (com DDD, sem espaços):\nEx: 11999990000', numSalvo);
  if (!num) return;
  num = num.replace(/\D/g,'');
  localStorage.setItem('cahu360_wp_numero', num);
  var pendencias = getPendencias();
  var hoje = new Date().toLocaleDateString('pt-BR');
  var loja = S.currentUser ? (S.currentUser.loja||'esta loja') : 'esta loja';
  var msg = '⚠️ *Cahu360 — Checklists Pendentes*\n';
  msg += '📅 '+hoje+' | 🏪 '+loja+'\n\n';
  if (pendencias.length) {
    pendencias.forEach(function(p){ msg += (p.atrasado?'🔴':'🟡')+' '+p.cl.nome+' ('+p.cl.setor+')\n'; });
  } else {
    msg += '✅ Todos os checklists foram enviados!';
  }
  window.open('https://wa.me/55'+num+'?text='+encodeURIComponent(msg), '_blank');
}

function exportarPDF(tipo) {
  var logoEl = document.querySelector('.sb-logo img');
  var logoSrc = logoEl ? logoEl.src : '';
  var hoje = new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  var titulos = {executivo:'Relatório Executivo Diário',naoconformidade:'Relatório de Não Conformidade',ranking:'Ranking de Operadores',checklist:'Relatório de Checklist',inventario:'Relatório de Inventário',perdas:'Relatório de Perdas'};
  var titulo = titulos[tipo]||'Relatório';

  var idMap = {executivo:'rel-cl-executivo',naoconformidade:'rel-cl-naoconformidade',ranking:'rel-cl-ranking',checklist:'rel-cl-geral',inventario:'rel-tab-inventario',perdas:'rel-tab-perdas'};
  var tabEl = document.getElementById(idMap[tipo]||'rel-cl-geral');
  if (!tabEl) { showToast('Erro: aba nao encontrada'); return; }
  var conteudo = _cloneComImagens(tabEl);

  var html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/>'
    +'<title>'+titulo+'</title>'
    +'<style>'
    +'*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif}'
    +'body{padding:30px;color:#111;font-size:12px}'
    +'.header{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #FFC600;padding-bottom:16px;margin-bottom:24px}'
    +'.header img{height:60px;object-fit:contain}'
    +'.header-info{text-align:right}'
    +'.header-info h1{font-size:18px;font-weight:700;color:#111}'
    +'.header-info p{font-size:11px;color:#666;margin-top:4px}'
    +'.mc{background:#f8f9fa;border-radius:8px;padding:12px;margin-bottom:8px}'
    +'.lbl{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#888;margin-bottom:4px}'
    +'.val{font-size:22px;font-weight:700}'
    +'.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}'
    +'.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}'
    +'table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11px}'
    +'th{background:#FFC600;padding:8px;text-align:left;font-size:10px;text-transform:uppercase}'
    +'td{padding:7px 8px;border-bottom:1px solid #eee}'
    +'.footer{margin-top:30px;padding-top:12px;border-top:1px solid #eee;display:flex;justify-content:space-between;font-size:10px;color:#999}'
    +'button{display:none}'
    +'select{display:none}'
    +'input{display:none}'
    +'</style>'
    +'</head><body>'
    +'<div class="header">'
    +(logoSrc ? '<img src="'+logoSrc+'" alt="Logo"/>' : '<div style="font-size:20px;font-weight:700">Cahu360</div>')
    +'<div class="header-info"><h1>'+titulo+'</h1><p>'+hoje+'</p><p>Cahu360 Process - Gestão Completa. Resultados Reais.</p></div>'
    +'</div>'
    +conteudo
    +'<div class="footer"><span>Cahu360 Process © '+new Date().getFullYear()+'</span><span>Gerado em: '+new Date().toLocaleString('pt-BR')+'</span></div>'
    +'</body></html>';

  var blob = new Blob([html], {type:'text/html'});
  var url = URL.createObjectURL(blob);
  var w = window.open(url,'_blank');
  if(w) {
    w.onload = function(){ w.print(); };
  }
}

function initRelCharts() {
  if (S.relCharts.ev) return;
  S.relCharts.ev = new Chart(document.getElementById('chartEv'),{
    type:'bar',
    data:{labels:['Nov','Dez','Jan','Fev','Mar','Abr'],
      datasets:[{label:'Perdas (R$)',data:[0,0,0,0,0,0],backgroundColor:'#2d9e62',borderRadius:6}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{y:{ticks:{callback:function(v){return 'R$'+v;}},suggestedMax:100}}}
  });
  S.relCharts.set = new Chart(document.getElementById('chartSet'),{
    type:'pie',
    data:{labels:['Perecíveis','Frios','Mercearia','Hortifruti','Açougue'],
      datasets:[{data:[0,0,0,0,0],backgroundColor:['#c0392b','#1a5276','#2d9e62','#d68910','#8e44ad'],borderWidth:3,borderColor:'#fff'}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:12}}}}
  });
}

function renderRelatorios() {
  var firstTab = document.querySelector('#rel-tabs .tab');
  switchRelTab('checklist', firstTab);
}

function _renderRelatorios_unused() {
  var resultados = getResultados();
  var totalPerdas = S.perdaItems.reduce(function(s,i){return s+i.total;},0);
  var totalEnv = resultados.length;
  var totalComp = resultados.filter(function(r){return r.pct===100;}).length;
  var taxa = totalEnv ? Math.round(totalComp/totalEnv*100) : 0;
  var mediaGeral = totalEnv ? Math.round(resultados.reduce(function(s,r){return s+r.pct;},0)/totalEnv) : 0;
  document.getElementById('rel-perdas').textContent = 'R$ '+totalPerdas.toFixed(2);
  document.getElementById('rel-checklists').textContent = totalEnv;
  document.getElementById('rel-taxa').textContent = taxa+'%';
  document.getElementById('rel-media').textContent = totalEnv ? mediaGeral+'%' : '-';

  var hoje = new Date().toLocaleDateString('pt-BR');
  var dEl = document.getElementById('rel-data-hoje');
  if (dEl) dEl.textContent = hoje;

  // ── E: Resumo do dia ──
  var hoje2 = hoje;
  var resultadosHoje = resultados.filter(function(r){return r.dataHora && r.dataHora.indexOf(hoje2)===0 && !r.resetado;});
  var users = getUsers().filter(function(u){return u.id!=='admin' && u.ativo;});
  var resumoDiv = document.getElementById('rel-resumo-dia');
  if (!users.length && !resultadosHoje.length) {
    resumoDiv.innerHTML = '<div style="text-align:center;color:var(--t3);padding:20px;font-size:13px;grid-column:1/-1">Nenhum envio hoje</div>';
  } else {
    var PLABEL2 = {gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
    resumoDiv.innerHTML = users.map(function(u){
      var enviou = resultadosHoje.find(function(r){return r.operador===u.nome;});
      var cor = enviou ? (enviou.pct===100?'#e8f5ee':'#fef9e7') : '#fdecea';
      var icon = enviou ? (enviou.pct===100?'✅':'⚠️') : '⏳';
      var pct = enviou ? enviou.pct+'%' : 'Pendente';
      var pctColor = enviou ? (enviou.pct===100?'var(--g)':'var(--am)') : 'var(--r)';
      return '<div style="background:'+cor+';border-radius:10px;padding:14px;text-align:center">'
        +'<div style="font-size:24px;margin-bottom:6px">'+icon+'</div>'
        +'<div style="font-size:13px;font-weight:600;margin-bottom:2px">'+u.nome+'</div>'
        +'<div style="font-size:11px;color:var(--t3);margin-bottom:6px">'+PLABEL2[u.perfil]+'</div>'
        +'<div style="font-size:18px;font-weight:700;color:'+pctColor+'">'+pct+'</div>'
        +'</div>';
    }).join('');
  }

  // ── A: Por setor ──
  var setoresMap = {};
  resultados.forEach(function(r){
    var s = r.setor||'Geral';
    if (!setoresMap[s]) setoresMap[s]={enviados:0,completos:0,somaPct:0};
    setoresMap[s].enviados++;
    if(r.pct===100) setoresMap[s].completos++;
    setoresMap[s].somaPct+=r.pct;
  });
  var setorTbody = document.getElementById('rel-setor-tbody');
  if (!Object.keys(setoresMap).length) {
    setorTbody.innerHTML='<tr class="erow"><td colspan="5">Nenhum dado ainda</td></tr>';
  } else {
    setorTbody.innerHTML = Object.keys(setoresMap).map(function(s){
      var d=setoresMap[s];
      var med=Math.round(d.somaPct/d.enviados);
      var st=med===100?'st-ok':med>=70?'st-warn':'st-err';
      var alerta=med<70?'<span class="st st-err">Atenção</span>':med<100?'<span class="st st-warn">Regular</span>':'<span class="st st-ok">Ótimo</span>';
      return '<tr><td><strong>'+s+'</strong></td><td>'+d.enviados+'</td>'
        +'<td><span class="st '+(d.completos===d.enviados?'st-ok':'st-warn')+'">'+d.completos+'/'+d.enviados+'</span></td>'
        +'<td><span class="st '+st+'">'+med+'%</span></td>'
        +'<td>'+alerta+'</td></tr>';
    }).join('');
  }

  // ── B: Evolução diária - últimos 7 dias ──
  var dias = [];
  for (var i=6;i>=0;i--) {
    var d2=new Date(); d2.setDate(d2.getDate()-i);
    dias.push(d2.toLocaleDateString('pt-BR'));
  }
  var diasData = dias.map(function(d){
    return resultados.filter(function(r){return r.dataHora && r.dataHora.indexOf(d)===0;}).length;
  });
  var diasLabels = dias.map(function(d){return d.slice(0,5);});
  if (S.relCharts.evolDiaria) {
    S.relCharts.evolDiaria.data.labels = diasLabels;
    S.relCharts.evolDiaria.data.datasets[0].data = diasData;
    S.relCharts.evolDiaria.update();
  } else {
    var ctx = document.getElementById('chartEvolDiaria');
    if (ctx) {
      S.relCharts.evolDiaria = new Chart(ctx,{
        type:'bar',
        data:{labels:diasLabels,datasets:[{label:'Envios',data:diasData,backgroundColor:'#2d9e62',borderRadius:6}]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
          scales:{y:{ticks:{stepSize:1},suggestedMax:5}}}
      });
    }
  }

  // ── C: Ranking de operadores ──
  var opsMap = {};
  resultados.forEach(function(r){
    if (!opsMap[r.operador]) opsMap[r.operador]={perfil:r.perfil,env:0,comp:0,soma:0,ultimo:''};
    opsMap[r.operador].env++;
    if(r.pct===100) opsMap[r.operador].comp++;
    opsMap[r.operador].soma+=r.pct;
    opsMap[r.operador].ultimo=r.dataHora;
  });
  var rankList = Object.keys(opsMap).map(function(n){
    var o=opsMap[n]; return {nome:n,perfil:o.perfil,env:o.env,comp:o.comp,media:Math.round(o.soma/o.env),ultimo:o.ultimo};
  }).sort(function(a,b){return b.media-a.media||b.comp-a.comp;});
  var rankTbody = document.getElementById('rel-ranking-tbody');
  var medals = ['🥇','🥈','🥉'];
  rankTbody.innerHTML = rankList.length ? rankList.map(function(o,i){
    var st=o.media===100?'st-ok':o.media>=70?'st-warn':'st-err';
    return '<tr><td>'+(medals[i]||i+1)+'</td><td><strong>'+o.nome+'</strong></td>'
      +'<td>'+o.env+'</td>'
      +'<td><span class="st '+(o.comp===o.env?'st-ok':'st-warn')+'">'+o.comp+'/'+o.env+'</span></td>'
      +'<td><span class="st '+st+'">'+o.media+'%</span></td></tr>';
  }).join('') : '<tr class="erow"><td colspan="5">Nenhum dado</td></tr>';

  // ── D: Checklists problemáticos ──
  var clMap = {};
  resultados.forEach(function(r){
    var n=r.checklistNome||'-';
    if(!clMap[n]) clMap[n]={env:0,soma:0};
    clMap[n].env++; clMap[n].soma+=r.pct;
  });
  var clList = Object.keys(clMap).map(function(n){
    return {nome:n,env:clMap[n].env,media:Math.round(clMap[n].soma/clMap[n].env)};
  }).sort(function(a,b){return a.media-b.media;});
  var probTbody = document.getElementById('rel-problemas-tbody');
  probTbody.innerHTML = clList.length ? clList.map(function(cl){
    var st=cl.media===100?'st-ok':cl.media>=70?'st-warn':'st-err';
    var alerta=cl.media<70?'<span class="st st-err">⚠ Crítico</span>':cl.media<100?'<span class="st st-warn">Regular</span>':'<span class="st st-ok">OK</span>';
    return '<tr><td>'+cl.nome+'</td><td>'+cl.env+'</td>'
      +'<td><span class="st '+st+'">'+cl.media+'%</span></td><td>'+alerta+'</td></tr>';
  }).join('') : '<tr class="erow"><td colspan="4">Nenhum dado</td></tr>';

  // ── Equipe completa ──
  var PLABEL3={admin:'Administrador',gerencia:'Gerência',operator:'Operador',prevencao:'Prevenção'};
  var PCLS3={admin:'st-info',gerencia:'st-info',operator:'st-ok',prevencao:'st-err'};
  var equTbody=document.getElementById('rel-equipe-tbody');
  equTbody.innerHTML = rankList.length ? rankList.map(function(o){
    var mst=o.media===100?'st-ok':o.media>=50?'st-warn':'st-err';
    return '<tr><td><strong>'+o.nome+'</strong></td>'
      +'<td><span class="st '+(PCLS3[o.perfil]||'st-ok')+'">'+(PLABEL3[o.perfil]||o.perfil)+'</span></td>'
      +'<td>'+o.env+'</td>'
      +'<td><span class="st '+(o.comp===o.env?'st-ok':'st-warn')+'">'+o.comp+'/'+o.env+'</span></td>'
      +'<td><span class="st '+mst+'">'+o.media+'%</span></td>'
      +'<td style="font-size:12px;color:var(--t3)">'+o.ultimo+'</td></tr>';
  }).join('') : '<tr class="erow"><td colspan="6">Nenhum checklist enviado ainda</td></tr>';
}

// ===========================================
// UTILS
// ===========================================
function showToast(msg, duration) {
  var t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#1a7a4a;color:#fff;padding:12px 24px;border-radius:30px;font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.2);z-index:999;transition:opacity .3s;white-space:nowrap';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(function(){ t.style.opacity='0'; }, duration || 3000);
}

function showAlert(id) {
  var el=document.getElementById(id);
  if (!el) return;
  el.style.display='flex';
  setTimeout(function(){el.style.display='none';},3500);
}

// ============================================================
// RELATÓRIOS CORPORATIVOS
// ============================================================

// Sub-tab ativo (default: adesao)
var _corpSubAtivo = 'adesao';

function switchRelCorpTab(sub, btn) {
  var subs = ['adesao','tendencia','naoconf','comparativo','pontualidade','perdasxcl'];
  subs.forEach(function(s){
    var el = document.getElementById('rel-corp-'+s);
    if (el) el.style.display = s===sub ? 'block' : 'none';
  });
  document.querySelectorAll('#rel-corp-subtabs .tab').forEach(function(t){t.classList.remove('on');});
  if (btn) btn.classList.add('on');
  _corpSubAtivo = sub;
  renderRelCorporativoTab();
}

function renderRelCorporativoTab() {
  if (_corpSubAtivo==='adesao')       renderAdesao();
  else if (_corpSubAtivo==='tendencia')   renderTendencia();
  else if (_corpSubAtivo==='naoconf')     renderNaoConformRecorrente();
  else if (_corpSubAtivo==='comparativo') renderComparativoLojas();
  else if (_corpSubAtivo==='pontualidade')renderPontualidade();
  else if (_corpSubAtivo==='perdasxcl')  renderPerdasChecklist();
}

function _corpGetPeriodDays() {
  var mes = document.getElementById('corp-mes') ? document.getElementById('corp-mes').value : '';
  var ano = parseInt(document.getElementById('corp-ano') ? document.getElementById('corp-ano').value : new Date().getFullYear());
  var days = 0;
  if (mes !== '') {
    var m = parseInt(mes);
    days = new Date(ano, m+1, 0).getDate();
  } else {
    days = 365;
  }
  return days || 30;
}

function _corpFilterRes() {
  var res = getResultados();
  var mes = document.getElementById('corp-mes') ? document.getElementById('corp-mes').value : '';
  var ano = parseInt(document.getElementById('corp-ano') ? document.getElementById('corp-ano').value : new Date().getFullYear());
  if (mes === '' && !ano) return res;
  return res.filter(function(r){
    if (!r.dataHora) return false;
    var parts = r.dataHora.split(' ')[0].split('/');
    var rDia=parseInt(parts[0]),rMes=parseInt(parts[1])-1,rAno=parseInt(parts[2]);
    if (ano && rAno !== ano) return false;
    if (mes !== '' && rMes !== parseInt(mes)) return false;
    return true;
  });
}

function _corpLojaDeUsuario(operador) {
  var users = getUsers();
  var u = users.find(function(u){ return u.nome === operador; });
  return (u && u.loja && u.loja.trim()) ? u.loja.trim() : 'Sem loja';
}

// ── Relatório 1: Adesão ──────────────────────────────────
function renderAdesao() {
  var res = _corpFilterRes();
  var totalDias = _corpGetPeriodDays();
  var lojaMap = {};
  res.forEach(function(r){
    var loja = _corpLojaDeUsuario(r.operador);
    if (!lojaMap[loja]) lojaMap[loja]={dias:new Set(),total:0,comp:0};
    if (r.dataHora) {
      var dia = r.dataHora.split(' ')[0];
      lojaMap[loja].dias.add(dia);
    }
    lojaMap[loja].total++;
    if (r.pct===100) lojaMap[loja].comp++;
  });

  var lojas = Object.keys(lojaMap).map(function(n){
    var o=lojaMap[n];
    var diasEnvio = o.dias.size;
    var adesao = Math.min(100, Math.round(diasEnvio/totalDias*100));
    return {nome:n, diasEnvio:diasEnvio, total:o.total, comp:o.comp, adesao:adesao};
  }).sort(function(a,b){return b.adesao-a.adesao;});

  var totalLojas = lojas.length;
  var mediaAd = totalLojas ? Math.round(lojas.reduce(function(s,l){return s+l.adesao;},0)/totalLojas) : 0;
  var melhor = lojas.length ? lojas[0].nome : '—';

  var adLojasEl = document.getElementById('corp-ad-lojas');
  var adMediaEl = document.getElementById('corp-ad-media');
  var adMelhorEl = document.getElementById('corp-ad-melhor');
  if (adLojasEl) adLojasEl.textContent = totalLojas;
  if (adMediaEl) adMediaEl.textContent = mediaAd+'%';
  if (adMelhorEl) adMelhorEl.textContent = melhor;

  var tbody = document.getElementById('corp-adesao-tbody');
  if (!tbody) return;
  if (!lojas.length) { tbody.innerHTML='<tr class="erow"><td colspan="5">Nenhum dado para o período</td></tr>'; return; }
  tbody.innerHTML = lojas.map(function(l){
    var cor = l.adesao>=80?'var(--g)':l.adesao>=50?'var(--am)':'var(--r)';
    var barra = '<div style="background:var(--gray2);border-radius:4px;height:8px;overflow:hidden"><div style="width:'+l.adesao+'%;height:100%;background:'+cor+';border-radius:4px"></div></div>';
    return '<tr><td><strong>'+l.nome+'</strong></td>'
      +'<td>'+l.diasEnvio+'</td>'
      +'<td>'+l.total+'</td>'
      +'<td><span class="st '+(l.comp===l.total&&l.total>0?'st-ok':'st-warn')+'">'+l.comp+'</span></td>'
      +'<td>'+barra+'<small style="color:'+cor+'">'+l.adesao+'%</small></td></tr>';
  }).join('');
}

// ── Relatório 2: Tendência Semanal ───────────────────────
function renderTendencia() {
  var res = getResultados();
  function isoWeekStart(d) {
    var dt = new Date(d);
    var day = dt.getDay();
    var diff = (day===0?-6:1-day);
    dt.setDate(dt.getDate()+diff);
    return dt.toISOString().slice(0,10);
  }

  // Últimas 8 semanas
  var weekMap = {};
  res.forEach(function(r){
    if (!r.dataHora) return;
    var parts=r.dataHora.split(' ')[0].split('/');
    var dt=new Date(parseInt(parts[2]),parseInt(parts[1])-1,parseInt(parts[0]));
    var wk=isoWeekStart(dt);
    if (!weekMap[wk]) weekMap[wk]={soma:0,cnt:0};
    weekMap[wk].soma+=r.pct;
    weekMap[wk].cnt++;
  });

  var weeks = Object.keys(weekMap).sort().slice(-8);
  var labels = weeks.map(function(w){ return w.slice(5); });
  var data   = weeks.map(function(w){ var o=weekMap[w]; return Math.round(o.soma/o.cnt); });

  if (S.relCharts.tendencia) { S.relCharts.tendencia.destroy(); S.relCharts.tendencia=null; }
  var ctx = document.getElementById('chart-tendencia');
  if (ctx) {
    S.relCharts.tendencia = new Chart(ctx, {
      type:'line',
      data:{labels:labels,datasets:[{label:'Média %',data:data,borderColor:'#2d9e62',backgroundColor:'rgba(45,158,98,.15)',tension:.35,fill:true,pointRadius:5,pointBackgroundColor:'#2d9e62'}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true}},scales:{y:{min:0,max:100,ticks:{callback:function(v){return v+'%';}}}}}
    });
  }

  var tbody = document.getElementById('corp-tendencia-tbody');
  if (!tbody) return;
  if (!weeks.length) { tbody.innerHTML='<tr class="erow"><td colspan="4">Nenhum dado</td></tr>'; return; }
  tbody.innerHTML = weeks.map(function(w,i){
    var o=weekMap[w];
    var med=Math.round(o.soma/o.cnt);
    var prev = i>0 ? Math.round(weekMap[weeks[i-1]].soma/weekMap[weeks[i-1]].cnt) : null;
    var variacao = prev===null ? '—' : (med>prev?'<span style="color:var(--g)">↑ +'+(med-prev)+'%</span>':med<prev?'<span style="color:var(--r)">↓ '+(med-prev)+'%</span>':'<span style="color:var(--t3)">→ 0%</span>');
    return '<tr><td>'+w+'</td><td>'+o.cnt+'</td><td><strong>'+med+'%</strong></td><td>'+variacao+'</td></tr>';
  }).join('');
}

// ── Relatório 3: Não Conformidades Recorrentes ────────────
function renderNaoConformRecorrente() {
  var res = _corpFilterRes();
  var itemMap = {};
  res.forEach(function(r){
    if (!r.itens) return;
    r.itens.forEach(function(it){
      var txt = it.texto||'(sem texto)';
      if (!itemMap[txt]) itemMap[txt]={falhas:0,total:0};
      itemMap[txt].total++;
      if (it.feito===false) itemMap[txt].falhas++;
    });
  });

  var items = Object.keys(itemMap).map(function(txt){
    var o=itemMap[txt];
    return {texto:txt, falhas:o.falhas, total:o.total, pct:o.total?Math.round(o.falhas/o.total*100):0};
  }).filter(function(i){return i.falhas>0;}).sort(function(a,b){return b.falhas-a.falhas;}).slice(0,10);

  var totalNC = items.reduce(function(s,i){return s+i.falhas;},0);
  var critico = items.length ? items[0].texto : '—';
  var totalItens = Object.keys(itemMap).reduce(function(s,k){return s+itemMap[k].total;},0);
  var totalFeitos = Object.keys(itemMap).reduce(function(s,k){return s+(itemMap[k].total-itemMap[k].falhas);},0);
  var mediaConf = totalItens ? Math.round(totalFeitos/totalItens*100) : 100;

  var ncTotalEl=document.getElementById('corp-nc-total');
  var ncCriticoEl=document.getElementById('corp-nc-critico');
  var ncMediaEl=document.getElementById('corp-nc-media');
  if (ncTotalEl) ncTotalEl.textContent=totalNC;
  if (ncCriticoEl) ncCriticoEl.textContent=critico.length>40?critico.slice(0,37)+'...':critico;
  if (ncMediaEl) ncMediaEl.textContent=mediaConf+'%';

  var tbody = document.getElementById('corp-naoconf-tbody');
  if (!tbody) return;
  if (!items.length) { tbody.innerHTML='<tr class="erow"><td colspan="4">Nenhuma não conformidade encontrada</td></tr>'; return; }
  tbody.innerHTML = items.map(function(it){
    var grave = it.pct>50?'<span class="st st-err">Crítico</span>':it.pct>25?'<span class="st st-warn">Atenção</span>':'<span class="st st-ok">Leve</span>';
    var cor = it.pct>50?'var(--r)':'var(--t)';
    return '<tr><td style="max-width:250px;word-break:break-word">'+it.texto+'</td>'
      +'<td style="color:'+cor+'"><strong>'+it.falhas+'</strong></td>'
      +'<td>'+it.pct+'%</td>'
      +'<td>'+grave+'</td></tr>';
  }).join('');
}

// ── Relatório 4: Comparativo de Lojas ────────────────────
function renderComparativoLojas() {
  var res = _corpFilterRes();
  var lojaMap = {};
  res.forEach(function(r){
    var loja = _corpLojaDeUsuario(r.operador);
    if (!lojaMap[loja]) lojaMap[loja]={geral:[],prev:[],oper:[],dias:new Set()};
    lojaMap[loja].geral.push(r.pct);
    if (r.perfil==='prevencao') lojaMap[loja].prev.push(r.pct);
    if (r.perfil==='operator') lojaMap[loja].oper.push(r.pct);
    if (r.dataHora) lojaMap[loja].dias.add(r.dataHora.split(' ')[0]);
  });

  var COLORS = ['#2d9e62','#1a5276','#d68910','#c0392b','#8e44ad'];
  var lojas = Object.keys(lojaMap);
  function avg(arr){ return arr.length?Math.round(arr.reduce(function(s,v){return s+v;},0)/arr.length):0; }

  var datasets = lojas.slice(0,5).map(function(nome,i){
    var o=lojaMap[nome];
    var cl=avg(o.geral), prev=avg(o.prev), oper=avg(o.oper), ades=Math.min(100,Math.round(o.dias.size/30*100));
    return {label:nome, data:[cl,prev,oper,ades], borderColor:COLORS[i], backgroundColor:COLORS[i]+'33', pointBackgroundColor:COLORS[i]};
  });

  if (S.relCharts.radar) { S.relCharts.radar.destroy(); S.relCharts.radar=null; }
  var ctx = document.getElementById('chart-radar');
  if (ctx) {
    S.relCharts.radar = new Chart(ctx, {
      type:'radar',
      data:{labels:['CL Geral','Prevenção','Operacional','Adesão'],datasets:datasets},
      options:{responsive:true,maintainAspectRatio:false,scales:{r:{min:0,max:100,ticks:{stepSize:20,callback:function(v){return v+'%';}}}}}
    });
  }

  var tbody = document.getElementById('corp-comparativo-tbody');
  if (!tbody) return;
  if (!lojas.length) { tbody.innerHTML='<tr class="erow"><td colspan="6">Nenhum dado</td></tr>'; return; }
  tbody.innerHTML = lojas.map(function(nome){
    var o=lojaMap[nome];
    var cl=avg(o.geral),prev=avg(o.prev),oper=avg(o.oper),ades=Math.min(100,Math.round(o.dias.size/30*100));
    var score=Math.round((cl+prev+oper+ades)/4);
    var st=score>=80?'st-ok':score>=60?'st-warn':'st-err';
    return '<tr><td><strong>'+nome+'</strong></td>'
      +'<td>'+cl+'%</td><td>'+prev+'%</td><td>'+oper+'%</td><td>'+ades+'%</td>'
      +'<td><span class="st '+st+'"><strong>'+score+'%</strong></span></td></tr>';
  }).join('');
}

// ── Relatório 5: Pontualidade ─────────────────────────────
function renderPontualidade() {
  var res = _corpFilterRes();
  var buckets = ['06-09h','09-12h','12-15h','15-18h','18-21h','21h+'];
  function getBucket(hora){
    if (hora<9) return '06-09h';
    if (hora<12) return '09-12h';
    if (hora<15) return '12-15h';
    if (hora<18) return '15-18h';
    if (hora<21) return '18-21h';
    return '21h+';
  }

  var lojaMap = {};
  res.forEach(function(r){
    var loja = _corpLojaDeUsuario(r.operador);
    if (!lojaMap[loja]) {
      lojaMap[loja]={};
      buckets.forEach(function(b){lojaMap[loja][b]=0;});
    }
    if (r.dataHora) {
      var timePart = r.dataHora.split(' ')[1]||'00:00';
      var hora = parseInt(timePart.split(':')[0]);
      var bkt = getBucket(hora);
      lojaMap[loja][bkt]++;
    }
  });

  var topLojas = Object.keys(lojaMap).slice(0,3);
  var COLORS = ['#2d9e62','#1a5276','#d68910'];
  var datasets = topLojas.map(function(loja,i){
    return {label:loja, data:buckets.map(function(b){return lojaMap[loja][b];}), backgroundColor:COLORS[i]+'cc', borderRadius:4};
  });

  if (S.relCharts.pontualidade) { S.relCharts.pontualidade.destroy(); S.relCharts.pontualidade=null; }
  var ctx = document.getElementById('chart-pontualidade');
  if (ctx) {
    S.relCharts.pontualidade = new Chart(ctx, {
      type:'bar',
      data:{labels:buckets,datasets:datasets},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true}},scales:{y:{beginAtZero:true,ticks:{stepSize:1}}}}
    });
  }

  var tbody = document.getElementById('corp-pontualidade-tbody');
  if (!tbody) return;
  var lojas = Object.keys(lojaMap);
  if (!lojas.length) { tbody.innerHTML='<tr class="erow"><td colspan="4">Nenhum dado</td></tr>'; return; }
  tbody.innerHTML = lojas.map(function(nome){
    var o=lojaMap[nome];
    var comercial=['06-09h','09-12h','12-15h','15-18h'].reduce(function(s,b){return s+o[b];},0);
    var fora=['18-21h','21h+'].reduce(function(s,b){return s+o[b];},0);
    var total=comercial+fora;
    var pct=total?Math.round(comercial/total*100):0;
    var st=pct>=80?'st-ok':pct>=60?'st-warn':'st-err';
    return '<tr><td><strong>'+nome+'</strong></td>'
      +'<td>'+comercial+'</td><td>'+fora+'</td>'
      +'<td><span class="st '+st+'">'+pct+'%</span></td></tr>';
  }).join('');
}

// ── Relatório: PDF de Planos de Ação ────────────────
function exportarPDFPlanos() {
  showToast('Preparando PDF de planos...');
  var logoEl = document.querySelector('.sb-logo img');
  var logoSrc = logoEl ? logoEl.src : '';
  var hoje = new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  var fl = (document.getElementById('cf-loja-plano')||{}).value||'';
  var fst = (document.getElementById('cf-status-plano')||{}).value||'';

  var lista = getPlanos().slice().sort(function(a,b){
    return (b.criadoTimestamp||b.criadoEm||'') > (a.criadoTimestamp||a.criadoEm||'') ? 1 : -1;
  });
  if (fl) lista = lista.filter(function(p){ return (p.loja||'')=== fl; });
  if (fst) lista = lista.filter(function(p){ return p.status === fst; });

  var tot = lista.length;
  var res = lista.filter(function(p){ return p.status==='resolvido'; }).length;
  var and = lista.filter(function(p){ return p.status==='andamento'; }).length;
  var abe = lista.filter(function(p){ return p.status==='aberto'; }).length;
  var taxa = tot ? Math.round(res/tot*100) : 0;

  // Tabela por loja
  var porLoja = {};
  lista.forEach(function(p){
    var l = p.loja || '(sem loja)';
    if (!porLoja[l]) porLoja[l] = {total:0,resolvidos:0,andamento:0,abertos:0};
    porLoja[l].total++;
    if (p.status==='resolvido') porLoja[l].resolvidos++;
    else if (p.status==='andamento') porLoja[l].andamento++;
    else porLoja[l].abertos++;
  });
  var tabelaLoja = Object.keys(porLoja).map(function(l){
    var d = porLoja[l];
    var tx = Math.round(d.resolvidos/d.total*100);
    return '<tr><td>'+l+'</td><td style="text-align:center">'+d.total+'</td>'
      +'<td style="text-align:center;color:#2d9e62;font-weight:600">'+d.resolvidos+'</td>'
      +'<td style="text-align:center;color:#d68910">'+d.andamento+'</td>'
      +'<td style="text-align:center;color:#c0392b">'+d.abertos+'</td>'
      +'<td style="text-align:center;font-weight:600">'+tx+'%</td></tr>';
  }).join('');

  var STATUS_COR = {aberto:'#c0392b',andamento:'#d68910',resolvido:'#2d9e62'};
  var STATUS_LABEL = {aberto:'Aberto',andamento:'Em Andamento',resolvido:'Resolvido'};

  var listHtml = lista.map(function(p){
    var cor = STATUS_COR[p.status]||'#666';
    var fotoConcl = (p.conclusao && p.conclusao.foto)
      ? '<div style="margin-top:8px"><img src="'+p.conclusao.foto+'" style="max-width:100%;max-height:220px;border-radius:8px;object-fit:cover;border:1px solid #ddd"/></div>' : '';
    var conclusaoHtml = (p.conclusao && p.conclusao.texto)
      ? '<div style="margin-top:8px;padding:8px 12px;background:#f0fdf4;border-left:3px solid #2d9e62;border-radius:6px;font-size:11px"><strong>✅ Conclusão:</strong> '+p.conclusao.texto+fotoConcl+'</div>' : '';
    var histHtml = '';
    if (p.historico && p.historico.length) {
      var ACAO_LABEL = {criado:'Criado',iniciado:'Iniciado',resolvido:'Resolvido',reaberto:'Reaberto'};
      histHtml = '<div style="margin-top:8px;font-size:10px;color:#666"><strong>Histórico:</strong> '
        + p.historico.map(function(h){ return (ACAO_LABEL[h.acao]||h.acao)+' por '+h.por+' ('+h.em+')'; }).join(' → ')
        +'</div>';
    }
    return '<div style="border:1px solid #ddd;border-left:4px solid '+cor+';border-radius:8px;padding:12px 14px;margin-bottom:10px;page-break-inside:avoid">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">'
      +'<div style="flex:1"><strong style="font-size:13px">'+p.desc+'</strong>'
      +(p.loja?'<span style="margin-left:8px;background:#fff8e1;color:#b45309;border-radius:4px;padding:1px 6px;font-size:11px">🏪 '+p.loja+'</span>':'')
      +'</div>'
      +'<span style="font-size:11px;font-weight:700;color:'+cor+'">'+STATUS_LABEL[p.status]+'</span>'
      +'</div>'
      +(p.origem?'<div style="font-size:11px;color:#888;margin-top:4px">📋 '+p.origem+'</div>':'')
      +'<div style="font-size:11px;color:#555;margin-top:4px;display:flex;gap:16px;flex-wrap:wrap">'
      +(p.responsavel?'<span>👤 '+p.responsavel+'</span>':'')
      +(p.criadoEm?'<span>📅 Criado: '+p.criadoEm+'</span>':'')
      +(p.resolvidoEm?'<span>✅ Resolvido: '+p.resolvidoEm+'</span>':'')
      +'</div>'
      +(p.obs?'<div style="font-size:11px;color:#666;margin-top:6px;padding:5px 8px;background:#f8f8f8;border-radius:4px">'+p.obs+'</div>':'')
      +conclusaoHtml+histHtml
      +'</div>';
  }).join('');

  var html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><title>Planos de Ação</title>'
    +'<style>*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif}body{padding:30px;color:#111;font-size:12px}'
    +'.header{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #FFC600;padding-bottom:16px;margin-bottom:24px}'
    +'.header img{height:60px;object-fit:contain}.header-info{text-align:right}'
    +'.header-info h1{font-size:18px;font-weight:700}.header-info p{font-size:11px;color:#666;margin-top:4px}'
    +'.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}'
    +'.mc{background:#f8f9fa;border-radius:8px;padding:12px}.lbl{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#888;margin-bottom:4px}'
    +'.val{font-size:22px;font-weight:700}table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:11px}'
    +'th{background:#FFC600;padding:8px;text-align:left;font-size:10px;text-transform:uppercase}td{padding:7px 8px;border-bottom:1px solid #eee}'
    +'.footer{margin-top:30px;padding-top:12px;border-top:1px solid #eee;display:flex;justify-content:space-between;font-size:10px;color:#999}'
    +'</style></head><body>'
    +'<div class="header">'
    +(logoSrc?'<img src="'+logoSrc+'" alt="Logo"/>':'<div style="font-size:20px;font-weight:700">Cahu360</div>')
    +'<div class="header-info"><h1>Relatório de Planos de Ação</h1><p>'+hoje+'</p>'
    +(fl?'<p>Loja: '+fl+'</p>':'')+(fst?'<p>Status: '+STATUS_LABEL[fst]+'</p>':'')
    +'</div></div>'
    +'<div class="g4">'
    +'<div class="mc"><div class="lbl">Total</div><div class="val">'+tot+'</div></div>'
    +'<div class="mc"><div class="lbl">Resolvidos</div><div class="val" style="color:#2d9e62">'+res+'</div></div>'
    +'<div class="mc"><div class="lbl">Em Andamento</div><div class="val" style="color:#d68910">'+and+'</div></div>'
    +'<div class="mc"><div class="lbl">Taxa Resolução</div><div class="val">'+taxa+'%</div></div>'
    +'</div>'
    +(Object.keys(porLoja).length > 1
      ? '<table><thead><tr><th>Loja</th><th style="text-align:center">Total</th><th style="text-align:center">Resolvidos</th><th style="text-align:center">Andamento</th><th style="text-align:center">Abertos</th><th style="text-align:center">Taxa</th></tr></thead><tbody>'+tabelaLoja+'</tbody></table>'
      : '')
    +'<div style="margin-bottom:12px;font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.5px">Detalhamento ('+tot+' planos)</div>'
    +listHtml
    +'<div class="footer"><span>Cahu360 Process © '+new Date().getFullYear()+'</span><span>Gerado em: '+new Date().toLocaleString('pt-BR')+'</span></div>'
    +'</body></html>';

  var blob = new Blob([html], {type:'text/html'});
  var url = URL.createObjectURL(blob);
  var w = window.open(url, '_blank');
  if (w) w.onload = function(){ w.print(); };
}

// ── Relatório 6: Exportar PDF Consolidado ────────────────
function exportarPDFConsolidado() {
  showToast('Preparando PDF consolidado...');
  var logoEl = document.querySelector('.sb-logo img');
  var logoSrc = logoEl ? logoEl.src : '';
  var hoje = new Date().toLocaleString('pt-BR');
  var mesSel = document.getElementById('corp-mes');
  var anoSel = document.getElementById('corp-ano');
  var periodoTxt = (mesSel&&mesSel.options[mesSel.selectedIndex]?mesSel.options[mesSel.selectedIndex].text:'Todos os meses')+' / '+(anoSel?anoSel.value:'');

  var secoes = ['rel-corp-adesao','rel-corp-naoconf','rel-corp-comparativo','rel-corp-pontualidade'];
  // Mostra todas as seções temporariamente para que os charts tenham dimensões válidas
  var secoesEls = secoes.map(function(id){ return document.getElementById(id); });
  var origDisplays = secoesEls.map(function(el){ return el ? el.style.display : ''; });
  secoesEls.forEach(function(el){ if (el) el.style.display = 'block'; });
  // Re-renderiza com as seções visíveis
  try { renderAdesao(); } catch(e){}
  try { renderTendencia(); } catch(e){}
  try { renderNaoConformRecorrente(); } catch(e){}
  try { renderComparativoLojas(); } catch(e){}
  try { renderPontualidade(); } catch(e){}

  var conteudo = secoes.map(function(id){
    var el=document.getElementById(id);
    return el ? '<div style="page-break-inside:avoid;margin-bottom:30px">'+_cloneComImagens(el)+'</div>' : '';
  }).join('');
  // Restaura visibilidade original
  secoesEls.forEach(function(el, i){ if (el) el.style.display = origDisplays[i]; });

  var html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><title>Relatório Corporativo Consolidado</title>'
    +'<style>*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif}'
    +'body{padding:30px;color:#111;font-size:12px}'
    +'.header{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #FFC600;padding-bottom:16px;margin-bottom:24px}'
    +'.header img{height:60px;object-fit:contain}'
    +'.header-info{text-align:right}'
    +'.header-info h1{font-size:18px;font-weight:700}'
    +'.mc{background:#f8f9fa;border-radius:8px;padding:12px;margin-bottom:8px;display:inline-block;min-width:160px;margin-right:8px}'
    +'.lbl{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#888;margin-bottom:4px}'
    +'.val{font-size:20px;font-weight:700}'
    +'.g3,.g4{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}'
    +'table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11px}'
    +'th{background:#FFC600;padding:8px;text-align:left;font-size:10px;text-transform:uppercase}'
    +'td{padding:7px 8px;border-bottom:1px solid #eee}'
    +'.card{border:1px solid #eee;border-radius:8px;padding:14px;margin-bottom:16px}'
    +'.card-hdr{margin-bottom:10px;font-weight:700}'
    +'button,select,input{display:none}'
    +'@media print{.no-print{display:none}}'
    +'</style></head><body>'
    +'<div class="header">'
    +(logoSrc?'<img src="'+logoSrc+'" alt="Logo"/>':'<div style="font-size:20px;font-weight:700">Cahu360</div>')
    +'<div class="header-info"><h1>Relatório Corporativo Consolidado</h1><p>Período: '+periodoTxt+'</p><p>Gerado em: '+hoje+'</p></div>'
    +'</div>'
    +conteudo
    +'<div style="margin-top:30px;padding-top:12px;border-top:1px solid #eee;display:flex;justify-content:space-between;font-size:10px;color:#999">'
    +'<span>Cahu360 Process © '+new Date().getFullYear()+'</span><span>'+hoje+'</span></div>'
    +'</body></html>';

  var w = window.open('','_blank','width=900,height=700');
  if (w) {
    w.document.write(html);
    w.document.close();
    w.onload = function(){ w.print(); };
  }
}

// ── Relatório 7: Perdas × Checklist ──────────────────────
function renderPerdasChecklist() {
  var loadingEl = document.getElementById('corp-px-loading');
  if (loadingEl) loadingEl.style.display='block';

  var res = _corpFilterRes();
  // Agrupa CL de prevenção por data
  var clPrevMap = {};
  res.filter(function(r){return r.perfil==='prevencao';}).forEach(function(r){
    if (!r.dataHora) return;
    var data = r.dataHora.split(' ')[0];
    if (!clPrevMap[data]) clPrevMap[data]={soma:0,cnt:0};
    clPrevMap[data].soma+=r.pct;
    clPrevMap[data].cnt++;
  });

  try {
    db.collection('perdas').get().then(function(snap){
      if (loadingEl) loadingEl.style.display='none';
      var perdasMap = {};
      snap.forEach(function(doc){
        var d=doc.data();
        if (!d.dataHora) return;
        var data = d.dataHora.split(' ')[0];
        if (!perdasMap[data]) perdasMap[data]=0;
        perdasMap[data]+=(d.total||0);
      });

      // União de datas
      var allDatas = new Set(Object.keys(perdasMap).concat(Object.keys(clPrevMap)));
      var dias = Array.from(allDatas).sort();

      var labels = dias.map(function(d){return d.slice(0,5);});
      var perdasData = dias.map(function(d){return +(perdasMap[d]||0).toFixed(2);});
      var clData = dias.map(function(d){
        if (!clPrevMap[d]) return null;
        return Math.round(clPrevMap[d].soma/clPrevMap[d].cnt);
      });

      if (S.relCharts.perdasxcl) { S.relCharts.perdasxcl.destroy(); S.relCharts.perdasxcl=null; }
      var ctx = document.getElementById('chart-perdasxcl');
      if (ctx) {
        S.relCharts.perdasxcl = new Chart(ctx, {
          type:'bar',
          data:{labels:labels,datasets:[
            {label:'Perdas R$',data:perdasData,backgroundColor:'#c0392b99',yAxisID:'y',borderRadius:3},
            {label:'CL Prevenção %',data:clData,backgroundColor:'#2d9e6299',yAxisID:'y2',borderRadius:3,type:'line',borderColor:'#2d9e62',tension:.3,fill:false,pointRadius:4}
          ]},
          options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:true}},
            scales:{
              y:{position:'left',beginAtZero:true,ticks:{callback:function(v){return 'R$'+v.toFixed(0);}}},
              y2:{position:'right',min:0,max:100,grid:{drawOnChartArea:false},ticks:{callback:function(v){return v+'%';}}}
            }
          }
        });
      }

      // Calcular correlação: dias com CL < 80% e perdas acima da média
      var mediaPerdasVal = perdasData.filter(function(v){return v>0;});
      var mediaPerdas = mediaPerdasVal.length ? mediaPerdasVal.reduce(function(s,v){return s+v;},0)/mediaPerdasVal.length : 0;
      var corr = dias.filter(function(d){
        var cl=clPrevMap[d]?Math.round(clPrevMap[d].soma/clPrevMap[d].cnt):null;
        var p=perdasMap[d]||0;
        return cl!==null && cl<80 && p>mediaPerdas;
      }).length;
      var baixoCL = dias.filter(function(d){
        var cl=clPrevMap[d]?Math.round(clPrevMap[d].soma/clPrevMap[d].cnt):null;
        return cl!==null && cl<80;
      }).length;

      var corrEl=document.getElementById('corp-px-correlacao');
      var diasEl=document.getElementById('corp-px-dias');
      var baixoEl=document.getElementById('corp-px-baixo');
      if (corrEl) corrEl.textContent=corr+' dias';
      if (diasEl) diasEl.textContent=dias.length;
      if (baixoEl) baixoEl.textContent=baixoCL;

      var tbody=document.getElementById('corp-perdasxcl-tbody');
      if (!tbody) return;
      if (!dias.length) { tbody.innerHTML='<tr class="erow"><td colspan="4">Nenhum dado</td></tr>'; return; }
      tbody.innerHTML = dias.slice(-30).reverse().map(function(d){
        var p=(perdasMap[d]||0).toFixed(2);
        var cl=clPrevMap[d]?Math.round(clPrevMap[d].soma/clPrevMap[d].cnt):null;
        var clTxt=cl!==null?cl+'%':'—';
        var stCl=cl===null?'':cl>=80?'st-ok':cl>=60?'st-warn':'st-err';
        var status=cl!==null&&cl<80&&(perdasMap[d]||0)>mediaPerdas
          ?'<span class="st st-err">Correlação</span>'
          :'<span class="st st-ok">OK</span>';
        return '<tr><td>'+d+'</td><td>R$ '+p+'</td>'
          +'<td>'+(cl!==null?'<span class="st '+stCl+'">'+clTxt+'</span>':clTxt)+'</td>'
          +'<td>'+status+'</td></tr>';
      }).join('');
    }).catch(function(e){
      if (loadingEl) loadingEl.style.display='none';
      var tbody=document.getElementById('corp-perdasxcl-tbody');
      if (tbody) tbody.innerHTML='<tr class="erow"><td colspan="4">Erro ao carregar perdas do Firebase</td></tr>';
    });
  } catch(e) {
    if (loadingEl) loadingEl.style.display='none';
    var tbody=document.getElementById('corp-perdasxcl-tbody');
    if (tbody) tbody.innerHTML='<tr class="erow"><td colspan="4">Erro ao acessar Firebase</td></tr>';
  }
}

// Restaura sessao ao recarregar a pagina
// (script e defer — DOM ja esta pronto aqui, sem precisar de DOMContentLoaded)
(function() {
  try {
    var saved = sessionStorage.getItem('eco_session');
    if (saved) {
      var user = JSON.parse(saved);
      if (user && user.id && user.perfil) {
        finalizarLogin(user);
      }
    }
  } catch(e) {}
})();