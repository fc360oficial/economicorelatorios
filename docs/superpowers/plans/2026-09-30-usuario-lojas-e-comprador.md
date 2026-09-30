# Usuários: lojas liberadas e trava por comprador(a) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** usuário do Econômico Relatórios enxerga só as lojas marcadas no cadastro (Fiscal primeiro) e compradora enxerga só o que é das listas dela, com a trava no servidor.

**Architecture:** `lib/escopo.js` (novo, sem Express) concentra as regras de "o que este usuário pode ver": lojas e compradora. `server.js` grava `lojas` no cadastro/sessão e aplica a trava nas rotas do Fiscal/Recebimento (fase 1) e de Compras (fase 2). Telas só escondem/travam seletor lendo `/api/me`.

**Tech Stack:** Node (CommonJS), Express, node:test, HTML/JS puro. Spec: `docs/superpowers/specs/2026-09-30-usuario-lojas-e-comprador-design.md`.

## Global Constraints
- Lojas válidas: `1..6` e `10` (CD). `null` = todas. Admin e gerencial ignoram.
- Trava vale no próximo login (dados ficam em `req.session.user`).
- Rotas públicas do coletor (`/api/recebimento-publico/*`, `/api/expedicao-publico/*`) não mudam.
- Repo público: nada de IP, token ou domínio no código/commit.
- Testes: `node --test test/` (node:test). Teste pré-existente `pedidos-cd-sugestao.test.js` já falha, não é daqui.
- Commits locais na `main`; push é do Tiago.

---

### Task 1: `lib/escopo.js` — regras de loja

**Files:** Create `lib/escopo.js`, `test/escopo.test.js`.
**Produces:** `LOJAS_VALIDAS`, `lojasDoBody(v)`, `lojasDoUsuario(user)`, `podeLoja(user, loja)`, `resolverLoja(user, pedida)`, `filtrarPorLoja(user, lista, getLoja)`.

- [x] Teste (`test/escopo.test.js`):
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../lib/escopo');

test('lojasDoBody: só 1..6 e 10, sem repetição; vazio/inválido = null', () => {
  assert.deepEqual(e.lojasDoBody([10, '3', 3, 99, 'x']), [3, 10]);
  assert.equal(e.lojasDoBody([]), null);
  assert.equal(e.lojasDoBody(null), null);
  assert.equal(e.lojasDoBody('10'), null);
});
test('lojasDoUsuario: admin/gerencial/sem campo = null', () => {
  assert.equal(e.lojasDoUsuario({ perfil: 'admin', lojas: [10] }), null);
  assert.equal(e.lojasDoUsuario({ perfil: 'gerencial', lojas: [10] }), null);
  assert.equal(e.lojasDoUsuario({ perfil: 'usuario' }), null);
  assert.deepEqual(e.lojasDoUsuario({ perfil: 'usuario', lojas: [10, 2] }), [2, 10]);
});
test('podeLoja', () => {
  assert.equal(e.podeLoja({ perfil: 'usuario', lojas: [10] }, 10), true);
  assert.equal(e.podeLoja({ perfil: 'usuario', lojas: [10] }, '10'), true);
  assert.equal(e.podeLoja({ perfil: 'usuario', lojas: [10] }, 3), false);
  assert.equal(e.podeLoja({ perfil: 'usuario' }, 3), true);
});
test('resolverLoja: sem restrição devolve o pedido; restrito força a lista', () => {
  const livre = { perfil: 'usuario' }, cd = { perfil: 'usuario', lojas: [10] }, duas = { perfil: 'usuario', lojas: [1, 2] };
  assert.deepEqual(e.resolverLoja(livre, 3), { loja: 3, lojas: null });
  assert.deepEqual(e.resolverLoja(livre, null), { loja: null, lojas: null });
  assert.deepEqual(e.resolverLoja(cd, null), { loja: 10, lojas: [10] });
  assert.deepEqual(e.resolverLoja(cd, 10), { loja: 10, lojas: [10] });
  assert.deepEqual(e.resolverLoja(duas, null), { loja: null, lojas: [1, 2] });
  assert.deepEqual(e.resolverLoja(duas, 2), { loja: 2, lojas: [2] });
  assert.throws(() => e.resolverLoja(cd, 3), err => err.status === 403);
});
test('filtrarPorLoja', () => {
  const lista = [{ loja: 1 }, { loja: 10 }, { loja: 3 }];
  assert.deepEqual(e.filtrarPorLoja({ perfil: 'usuario', lojas: [10] }, lista, x => x.loja), [{ loja: 10 }]);
  assert.equal(e.filtrarPorLoja({ perfil: 'admin' }, lista, x => x.loja), lista);
});
```
- [x] Rodar `node --test test/escopo.test.js` → falha (módulo não existe).
- [x] Implementar `lib/escopo.js`:
```js
'use strict';
// Escopo do usuário logado: quais LOJAS ele enxerga (e, na fase 2, qual COMPRADORA).
// Fonte única, sem Express. Usado pelo cadastro (server.js), sessão, /api/me e pelas rotas travadas.
// `lojas: null` no cadastro = todas (cadastro antigo). Admin e gerencial ignoram o campo.
const LOJAS_VALIDAS = [1, 2, 3, 4, 5, 6, 10];

function lojasDoBody(v) {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map(Number).filter(n => LOJAS_VALIDAS.includes(n)))].sort((a, b) => a - b);
  return out.length ? out : null;
}
function lojasDoUsuario(user) {
  if (!user || user.perfil === 'admin' || user.perfil === 'gerencial') return null;
  return lojasDoBody(user.lojas);
}
function podeLoja(user, loja) {
  const l = lojasDoUsuario(user);
  return !l || l.includes(Number(loja));
}
function erro403(msg) { const e = new Error(msg); e.status = 403; return e; }
/** O que a API deve usar: { loja: uma loja ou null, lojas: lista permitida ou null (=todas) }. */
function resolverLoja(user, pedida) {
  const l = lojasDoUsuario(user);
  const p = pedida ? Number(pedida) : null;
  if (!l) return { loja: p, lojas: null };
  if (p) { if (!l.includes(p)) throw erro403('Sem permissão pra esta loja'); return { loja: p, lojas: [p] }; }
  return l.length === 1 ? { loja: l[0], lojas: l } : { loja: null, lojas: l };
}
function filtrarPorLoja(user, lista, getLoja) {
  const l = lojasDoUsuario(user);
  return l ? lista.filter(x => l.includes(Number(getLoja(x)))) : lista;
}
module.exports = { LOJAS_VALIDAS, lojasDoBody, lojasDoUsuario, podeLoja, resolverLoja, filtrarPorLoja, erro403 };
```
- [x] `node --test test/escopo.test.js` → 5 pass. Commit `feat(escopo): regras de lojas por usuário`.

### Task 2: cadastro, login e `/api/me` carregam `lojas`

**Files:** Modify `server.js` (login ~283, `/api/me` ~292, GET/POST/PUT `/api/admin/usuarios` ~310-350).
- [x] `const escopo = require('./lib/escopo');` junto do `modulos`.
- [x] Login: acrescentar `lojas: escopo.lojasDoBody(user.lojas)` no objeto da sessão.
- [x] `/api/me`: acrescentar `lojas: escopo.lojasDoUsuario(req.session.user)`.
- [x] GET lista: acrescentar `lojas: escopo.lojasDoBody(u.lojas)`.
- [x] POST: ler `lojas: lojasBody` do body; gravar `lojas: escopo.lojasDoBody(lojasBody)`.
- [x] PUT: `if (lojasBody !== undefined) usuarios[idx].lojas = escopo.lojasDoBody(lojasBody);`
- [x] Conferir com `node --check server.js`. Commit `feat(usuarios): campo lojas no cadastro e na sessão`.

### Task 3: tela Usuários — bloco "Lojas liberadas"

**Files:** Modify `public/admin-usuarios.html` (form antes de Módulos; `renderTabela`; helpers; `salvar`; `editarUsuario`/`trocarSenha`/`abrirModal`; `toggleExtraFields`).
- [x] HTML depois do campo Dlinks:
```html
<div class="field" id="field-lojas">
  <label>Lojas liberadas</label>
  <div class="mods" id="f-lojas">
    <label><input type="checkbox" value="todas" checked onchange="lojasTodasMudou()"> Todas as lojas</label>
    <label><input type="checkbox" value="1"> E1</label><label><input type="checkbox" value="2"> E2</label>
    <label><input type="checkbox" value="3"> E3</label><label><input type="checkbox" value="4"> E4</label>
    <label><input type="checkbox" value="5"> E5</label><label><input type="checkbox" value="6"> E6</label>
    <label><input type="checkbox" value="10"> CD</label>
  </div>
  <div class="field-hint">O usuário só enxerga as lojas marcadas nas telas que filtram por loja (hoje: Fiscal). Vale no próximo login.</div>
</div>
```
- [x] JS:
```js
function lojasTodasMudou() {
  const todas = document.querySelector('#f-lojas input[value="todas"]').checked;
  document.querySelectorAll('#f-lojas input:not([value="todas"])').forEach(i => { i.disabled = todas; if (todas) i.checked = false; });
}
function setLojas(lista) {
  const todas = !Array.isArray(lista) || !lista.length;
  document.querySelector('#f-lojas input[value="todas"]').checked = todas;
  document.querySelectorAll('#f-lojas input:not([value="todas"])').forEach(i => { i.checked = !todas && lista.map(String).includes(i.value); });
  lojasTodasMudou();
}
function getLojas() {
  if (document.querySelector('#f-lojas input[value="todas"]').checked) return null;
  return [...document.querySelectorAll('#f-lojas input:not([value="todas"]):checked')].map(i => +i.value);
}
const LJ = n => +n === 10 ? 'CD' : 'E' + n;
function etiquetasLojas(u) {
  if (u.perfil === 'admin' || u.perfil === 'gerencial' || !Array.isArray(u.lojas) || !u.lojas.length) return '<span style="color:var(--text3);font-size:11px">todas</span>';
  return u.lojas.map(n => `<span class="comp-tag">${LJ(n)}</span>`).join(' ');
}
```
- [x] `toggleExtraFields`: `document.getElementById('field-lojas').style.display = (p === 'admin' || p === 'gerencial') ? 'none' : '';`
- [x] `abrirModal`: `setLojas(null)`. `editarUsuario` e `trocarSenha`: `setLojas(u.lojas)`.
- [x] `salvar`: `const lojas = (perfil === 'admin' || perfil === 'gerencial') ? null : getLojas();` + validação `if (Array.isArray(lojas) && !lojas.length) { mostrarErroModal('Marque ao menos uma loja ou "Todas as lojas".'); return; }` + `lojas` no body.
- [x] Tabela: cabeçalho ganha `<th>Lojas</th>` depois de Módulos; linha ganha `<td>${etiquetasLojas(u)}</td>`; `colspan` 7→8.
- [x] Commit `feat(usuarios): bloco Lojas liberadas na tela`.

### Task 4: trava de loja nas rotas do Fiscal e do Recebimento (sessão)

**Files:** Modify `server.js` (`fiscalPeriodo` e rotas `/api/fiscal/*`), `lib/recebimento-rotas.js` (rotas de sessão `/api/recebimento*`).
- [x] `server.js`: `fiscalPeriodo` passa a resolver a loja pela sessão:
```js
const fiscalPeriodo = req => { const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(v || ''); const de = ok(req.query.de) ? req.query.de : new Date().toISOString().slice(0, 10); const ate = ok(req.query.ate) && req.query.ate >= de ? req.query.ate : de; const r = escopo.resolverLoja(req.session.user, parseInt(req.query.loja) || null); return { de, ate, loja: r.loja, lojas: r.lojas }; };
const fiscalErr = (res, err) => res.status(err.status || 500).json({ error: err.message });
```
  (o regex original `/^d{4}-d{2}-d{2}$/` está sem `\` — bug pré-existente; corrigir junto.)
- [x] `/api/fiscal/recebimentos`: `const f = fiscalPeriodo(req); const r = await fiscal.listar(f); r.recebimentos = escopo.filtrarPorLoja(req.session.user, r.recebimentos, x => x.loja); res.json(r);` com `catch (err) { fiscalErr(res, err); }`.
- [x] `/documentos` e `/margem`: mesmo padrão, `filtrarPorLoja(..., x => x.loja)`.
- [x] `/recebimentos/:nReg` (GET) e `/decisao` (POST): depois de obter `r = await fiscal.detalhe(n)`, `if (!escopo.podeLoja(req.session.user, r.loja)) return res.status(403).json({ error: 'Sem permissão pra esta loja' });` (no POST, chamar `detalhe` antes de `decidir`).
- [x] `/api/fiscal/config`: `lojas` = só as permitidas:
```js
const l = escopo.lojasDoUsuario(req.session.user);
const lojas = l ? Object.fromEntries(Object.entries(fiscal.LOJAS_NOMES).filter(([k]) => l.includes(+k))) : fiscal.LOJAS_NOMES;
```
- [x] `lib/recebimento-rotas.js`: `const escopo = require('./escopo');`. `GET /api/recebimento`: `escopo.filtrarPorLoja(req.session.user, recebimento.listarDia(data), c => c.loja)`. `GET /api/recebimento/config`: `lojas` só as permitidas. Rotas `/:id/liberar|reconferir|chat|devolucao/pdf|reenviar-erp`: helper `travaLoja(req, res)` que devolve `true` se bloqueou (`recebimento.obter(id)`; se existe e `!escopo.podeLoja(...)` → 403).
- [x] `node --check server.js lib/recebimento-rotas.js`; `node --test test/` (só a falha pré-existente). Commit `feat(fiscal): trava de loja por usuário nas rotas do Fiscal e Recebimento`.

### Task 5: tela do Fiscal — seletor travado/reduzido

**Files:** Modify `public/fiscal.html` (`boot`).
- [x] Em `boot`, depois de montar as opções (que já vêm só com as permitidas, pelo `/config`):
```js
const me=await fetch('/api/me').then(r=>r.ok?r.json():{}).catch(()=>({}));
const minhas=Array.isArray(me.lojas)?me.lojas:null;
if(minhas&&minhas.length===1){sel.value=String(minhas[0]);sel.disabled=true;sel.title='Você só tem acesso a esta loja';}
else if(minhas){sel.querySelector('option[value=""]').textContent='Todas as minhas lojas';}
```
  e só aplicar `u.get('loja')` se `!sel.disabled`.
- [x] Commit `feat(fiscal): seletor de loja respeita lojas do usuário`.

### Task 6: validação local da fase 1
- [ ] Subir o app local, criar usuário de teste via tela Usuários com lojas = CD e módulos CAHU + Fiscal; logar; conferir: Fiscal abre com seletor travado em CD; `/api/fiscal/recebimentos?loja=3` → 403; `/api/fiscal/config` traz só a 10; `/api/recebimento/config` só a 10; admin continua vendo tudo.
- [ ] Remover o usuário de teste. Atualizar a memória `feedback_economico-regras-acesso.md` com a regra 4 (lojas).

### Task 7 (fase 2): `lib/escopo.js` — compradora

**Files:** Modify `lib/escopo.js`, `test/escopo.test.js`.
**Produces:** `compradorDoUsuario(user)`, `listasDoUsuario(user, nregsComprador, resolve)`.
- [x] Teste:
```js
test('compradorDoUsuario: só perfil comprador com nome', () => {
  assert.equal(e.compradorDoUsuario({ perfil: 'comprador', comprador_nome: 'ANA KELLY' }), 'ANA KELLY');
  assert.equal(e.compradorDoUsuario({ perfil: 'admin', comprador_nome: 'ANA KELLY' }), null);
  assert.equal(e.compradorDoUsuario({ perfil: 'comprador' }), null);
});
test('listasDoUsuario: listas dela, nome que não bate = [] (falha fechada), sem trava = null', () => {
  const nregs = { 'ANA KELLY SILVA': [1, 2], 'PATRICIA PEREIRA': [3] };
  const resolve = n => n === 'ANA KELLY' ? 'ANA KELLY SILVA' : n;
  assert.deepEqual(e.listasDoUsuario({ perfil: 'comprador', comprador_nome: 'ANA KELLY' }, nregs, resolve), [1, 2]);
  assert.deepEqual(e.listasDoUsuario({ perfil: 'comprador', comprador_nome: 'NINGUEM' }, nregs, resolve), []);
  assert.equal(e.listasDoUsuario({ perfil: 'usuario' }, nregs, resolve), null);
});
```
- [x] Implementação:
```js
function compradorDoUsuario(user) {
  return user && user.perfil === 'comprador' && user.comprador_nome ? String(user.comprador_nome).trim().toUpperCase() : null;
}
/** Ids das listas da compradora (null = sem trava). Nome que não bate com o ERP = [] — nunca tudo aberto. */
function listasDoUsuario(user, nregsComprador, resolve = n => n) {
  const nome = compradorDoUsuario(user);
  if (!nome) return null;
  return (nregsComprador || {})[resolve(nome)] || [];
}
```
  + exportar. Commit `feat(escopo): regras de compradora`.

### Task 8 (fase 2): auditoria das rotas de Compras e aplicação da trava

**Files:** Modify `server.js` (middleware de acesso; rotas dos prefixos de `apis` do módulo `compras` em `lib/modulos.js`; dashboard bloco `compradores`) e as libs que as rotas usam, conforme a auditoria.
- [x] Middleware (logo depois do check de módulos, só pra `/api/`):
```js
const compNome = escopo.compradorDoUsuario(req.session.user);
if (compNome && modulos.moduloDaRota(req.path) === 'compras') req.query.comprador = compNome;
```
- [x] Auditoria: pra cada rota `app.get|post|put|delete('/api/<prefixo>` com prefixo em `compras.apis`, anotar numa tabela em `docs/superpowers/plans/2026-09-30-auditoria-compras.md`: (a) já filtra por `req.query.comprador` → só o middleware; (b) lista por lista de compra sem `comprador` → filtrar por `escopo.listasDoUsuario(req.session.user, NREGS_COMPRADOR, resolveComprador)` e negar 403 em ação sobre lista fora; (c) sem dono (CD, fornecedores, painel-cd, expedição) → deixar. Rotas que devolvem `compradores: [...]` → só ela.
- [x] Aplicar (b) e "só ela" rota a rota, cada uma com `node --check` e commit próprio.
- [x] Dashboard: bloco `comercial.compradores` filtrado pelo nome dela quando `compradorDoUsuario` não é null.

### Task 9 (fase 2): telas de Compras escondem/travam o seletor de compradora

**Files:** `public/sugestao-compras.html` (`#f-comprador`), `cotacao.html` (`#f-comprador`), `ruptura.html` (`#sel-comprador`), `ponta-gondola.html` (`#f-comprador`), `compras.html`, `comprador.html`, `analise-comprador.html`, `margem-comprador.html`, `mensal.html`, `relatorio-cronograma.html` (seletor/aba por compradora, achar por `comprador` no arquivo).
- [x] Helper comum em `public/nav.js` (carregado em todas as telas):
```js
window.travarComprador = async function(sel){ try{ const me=await fetch('/api/me').then(r=>r.json()); if(me.perfil==='comprador'&&me.comprador_nome){ if(sel){ sel.innerHTML='<option value="'+me.comprador_nome+'">'+me.comprador_nome+'</option>'; sel.value=me.comprador_nome; sel.disabled=true; } return me.comprador_nome; } }catch{} return null; };
```
- [x] Em cada tela, no boot: `await travarComprador(document.getElementById('f-comprador'))` (ou o id da tela) antes de carregar. Commit `feat(compras): seletor de compradora travado no nome dela`.

### Task 10 (fase 2): validação e memória
- [ ] Logar como usuária compradora de teste (nome que bate com o ERP) e percorrer as 10 telas: só listas dela; trocar `?comprador=` na URL não muda nada; admin vê tudo.
- [x] Atualizar memória `feedback_economico-regras-acesso.md` (regra 5: compradora) e `project_estado-atual.md`.
