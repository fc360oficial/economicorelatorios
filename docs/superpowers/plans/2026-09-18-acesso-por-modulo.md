# Acesso por módulo — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o admin marca, por usuário, quais módulos da sidebar ele acessa; módulo não marcado some da sidebar e é bloqueado no servidor.

**Architecture:** um mapa único em `lib/modulos.js` (módulo → páginas + prefixos de API) usado pelo middleware de acesso do `server.js`, pelo `/api/me` (que passa a devolver `modulos`) e por `GET /api/admin/modulos` (alimenta as caixas do cadastro). `nav.js` filtra os grupos pelo `modulos` do `/api/me`. `usuarios.json` ganha `modulos: string[]` (ausente = tudo; admin e gerencial ignoram o campo).

**Tech Stack:** Node/Express (CommonJS), `node:test`, HTML/JS puro no `public/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-18-acesso-por-modulo-design.md`.
- Regras existentes intocáveis: admin vê tudo; perfil `gerencial` travado em `/gestao-gerencial.html`; `admin-usuarios.html` e `/api/admin/*` só admin.
- Rota fora do mapa continua liberada pra qualquer logado.
- Botões de ação acima da tabela (padrão do Econômico).
- Ordem alfabética do bloco "Operação" da sidebar não muda.

---

### Task 1: `lib/modulos.js` + teste

**Files:**
- Create: `lib/modulos.js`
- Test: `test/modulos.test.js`

**Interfaces (Produces):**
- `MODULOS: Array<{ id, nome, paginas: string[], apis: string[] }>` (páginas sem `/` e sem `.html`; apis = prefixo depois de `/api/`).
- `moduloDaRota(path: string): string | null` — id do módulo dono de `/x.html` ou `/api/prefixo/...`; `null` se fora do mapa.
- `modulosDoUsuario(user): string[]` — admin/gerencial/sem campo → todos os ids; senão `user.modulos` filtrado pelos ids válidos.
- `podeAcessar(user, path): boolean`.
- `primeiraPagina(user): string | null` — `/index.html` se tem `analise`; senão primeira página do primeiro módulo permitido, na ordem de `MODULOS`; `null` se nenhum.

- [ ] **Step 1: teste**

```js
// test/modulos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/modulos');

test('moduloDaRota: página, api, fora do mapa', () => {
  assert.equal(m.moduloDaRota('/dre.html'), 'financeiro');
  assert.equal(m.moduloDaRota('/api/conciliador-cd/resumo'), 'financeiro');
  assert.equal(m.moduloDaRota('/api/comparativo-lojas?mes=1'), 'analise');
  assert.equal(m.moduloDaRota('/sugestao-compras.html'), 'compras');
  assert.equal(m.moduloDaRota('/api/pendencias'), 'processos');
  assert.equal(m.moduloDaRota('/gestao-gerencial.html'), null);
  assert.equal(m.moduloDaRota('/api/admin/usuarios'), null);
  assert.equal(m.moduloDaRota('/api/me'), null);
  assert.equal(m.moduloDaRota('/painel-cd.html'), 'compras');
});

test('modulosDoUsuario: admin, gerencial e sem campo veem tudo', () => {
  const todos = m.MODULOS.map(x => x.id);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'admin', modulos: ['financeiro'] }), todos);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'gerencial', modulos: [] }), todos);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'gerente' }), todos);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'gerente', modulos: ['financeiro', 'xyz'] }), ['financeiro']);
  assert.deepEqual(m.modulosDoUsuario({ perfil: 'gerente', modulos: [] }), []);
});

test('podeAcessar e primeiraPagina', () => {
  const fin = { perfil: 'gerente', modulos: ['financeiro'] };
  assert.equal(m.podeAcessar(fin, '/dre.html'), true);
  assert.equal(m.podeAcessar(fin, '/api/pendencias'), false);
  assert.equal(m.podeAcessar(fin, '/hub.html'), true);
  assert.equal(m.primeiraPagina(fin), '/conciliador.html');
  assert.equal(m.primeiraPagina({ perfil: 'gerente', modulos: ['compras', 'analise'] }), '/index.html');
  assert.equal(m.primeiraPagina({ perfil: 'gerente', modulos: [] }), null);
  assert.equal(m.primeiraPagina({ perfil: 'admin' }), '/index.html');
});
```

- [ ] **Step 2:** `node --test test/modulos.test.js` → falha (módulo não existe).

- [ ] **Step 3: implementação**

```js
// lib/modulos.js
'use strict';
// Fonte única dos módulos do Econômico Relatórios (mesma divisão da sidebar em public/nav.js).
// Usado pelo middleware de acesso, pelo /api/me e pelo cadastro de usuários.
const MODULOS = [
  { id: 'analise', nome: 'Análise',
    paginas: ['index', 'comparativos', 'consulta', 'itens'],
    apis: ['comparativo-diario', 'comparativo-lojas', 'comparativo-mensal', 'comparativo-mercadologico', 'consulta', 'itens', 'kpis',
           'faturamento-lojas', 'faturamento-mensal', 'margem-lojas', 'top-mercadologico', 'top-produtos', 'top-vendidos',
           'produtos', 'produtos-semana', 'grupos', 'compra-venda', 'pagar-venda', 'formas-pagamento'] },
  { id: 'cahu-distribuidora', nome: 'CAHU Distribuidora', paginas: ['cahu-tabela-precos'], apis: ['cahu-distribuidora'] },
  { id: 'financeiro', nome: 'Financeiro',
    paginas: ['conciliador', 'conciliador-entradas', 'conciliador-cd', 'dre'],
    apis: ['conciliador', 'conciliador-entradas', 'conciliador-cd', 'itau'] },
  { id: 'compras', nome: 'Gestão de Compras',
    paginas: ['centro-distribuicao', 'cotacao', 'ruptura', 'fornecedores', 'pedidos-compra', 'ponta-gondola', 'radar-pedidos',
              'sugestao-compras', 'painel-cd', 'comprador', 'analise-comprador', 'margem-comprador', 'compras', 'mensal', 'relatorio-cronograma'],
    apis: ['compras', 'cotacoes', 'ruptura', 'fornecedores', 'listas-compra', 'pedidos-cd', 'painel-cd', 'pedidos-fornecedor',
           'pontas-gondola', 'radar-pedidos', 'sugestao-compras', 'sugestao-manual', 'sugestoes-compra', 'sem-fornecedor'] },
  { id: 'precificacao', nome: 'Precificação', paginas: ['formacao-de-preco', 'precificacao'], apis: ['precificacao'] },
  { id: 'prevencao', nome: 'Prevenção', paginas: ['prevencao'], apis: [] },
  { id: 'processos', nome: 'Processos', paginas: ['pendencias', 'negativos'], apis: ['pendencias', 'negativos'] },
];
const IDS = MODULOS.map(m => m.id);

function moduloDaRota(path) {
  const p = String(path || '').split('?')[0];
  const api = p.match(/^\/api\/([a-z0-9-]+)/);
  if (api) { const m = MODULOS.find(x => x.apis.includes(api[1])); return m ? m.id : null; }
  const pg = p.match(/^\/([a-z0-9-]+)\.html$/);
  if (pg) { const m = MODULOS.find(x => x.paginas.includes(pg[1])); return m ? m.id : null; }
  return null;
}
function modulosDoUsuario(user) {
  if (!user) return [];
  if (user.perfil === 'admin' || user.perfil === 'gerencial' || !Array.isArray(user.modulos)) return IDS.slice();
  return user.modulos.filter(id => IDS.includes(id));
}
function podeAcessar(user, path) {
  const mod = moduloDaRota(path);
  return !mod || modulosDoUsuario(user).includes(mod);
}
function primeiraPagina(user) {
  const mods = modulosDoUsuario(user);
  if (mods.includes('analise')) return '/index.html';
  const m = MODULOS.find(x => mods.includes(x.id));
  return m ? '/' + m.paginas[0] + '.html' : null;
}
module.exports = { MODULOS, moduloDaRota, modulosDoUsuario, podeAcessar, primeiraPagina };
```

- [ ] **Step 4:** `node --test test/modulos.test.js` → 3 pass.
- [ ] **Step 5:** `git add lib/modulos.js test/modulos.test.js && git commit -m "feat(acesso): mapa de módulos + regras de acesso por usuário"`.

---

### Task 2: servidor — bloqueio, login, /api/me, CRUD, /api/admin/modulos

**Files:**
- Modify: `server.js` (middleware ~linha 231-243; `/api/login` 254-265; `/api/me` 271-274; CRUD 285-315).

**Interfaces (Consumes):** `lib/modulos.js` da Task 1. **Produces:** `/api/me` → `{ ...sessão, modulos: string[] }`; `GET /api/admin/modulos` → `[{ id, nome }]`; CRUD aceita/devolve `modulos` (array de ids ou `null`).

- [ ] **Step 1:** no topo do `server.js`, junto aos requires: `const modulos = require('./lib/modulos');`

- [ ] **Step 2:** no middleware, dentro de `if (req.session && req.session.user) { ... }`, logo depois do bloco das rotas de admin e antes do `return next();`:

```js
    // Acesso por módulo (lib/modulos.js): rota de módulo não liberado pro usuário
    // → API 403, página vai pra primeira página permitida.
    if (!modulos.podeAcessar(req.session.user, req.path)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Sem permissão' });
      return res.redirect(modulos.primeiraPagina(req.session.user) || '/login.html');
    }
```

- [ ] **Step 3:** `/api/login`: gravar `modulos` na sessão e usar `primeiraPagina` no redirect:

```js
  req.session.user = { id: user.id, nome: user.nome, usuario: user.usuario, perfil, comprador_nome: user.comprador_nome || null, loja_id: user.loja_id || null, modulos: Array.isArray(user.modulos) ? user.modulos : null };
  const redirect = modulos.primeiraPagina(req.session.user) || '/index.html';
  res.json({ ok: true, nome: user.nome, perfil, redirect });
```

- [ ] **Step 4:** `/api/me`: `res.json({ ...req.session.user, modulos: modulos.modulosDoUsuario(req.session.user) });`

- [ ] **Step 5:** CRUD:
  - `GET /api/admin/usuarios`: incluir `modulos: Array.isArray(u.modulos) ? u.modulos : null` no map.
  - `POST`: ler `modulos` do body; gravar `modulos: Array.isArray(modulos) ? modulos.filter(id => modulos_ids(id)) : null` — use `modulos.MODULOS.some(m => m.id === id)` como filtro. Cuidado com o nome: dentro do handler chame a variável do body de `modulosBody`.
  - `PUT`: `if (Array.isArray(modulosBody)) usuarios[idx].modulos = modulosBody.filter(...); else if (modulosBody === null) usuarios[idx].modulos = null;`
  - Novo: `app.get('/api/admin/modulos', requireAdmin, (req, res) => res.json(modulos.MODULOS.map(m => ({ id: m.id, nome: m.nome }))));`
  - Sessões ativas: no `PUT`, se `usuarios[idx].id === req.session.user.id` não precisa nada (admin). Pra outros usuários, a lista nova vale no próximo login (sessão guarda `modulos`). Aceitável e documentado no commit.

- [ ] **Step 6:** `node --check server.js` → sem erro. `node --test test/modulos.test.js` → pass.
- [ ] **Step 7:** commit `feat(acesso): bloqueio por módulo no servidor, /api/me devolve modulos, CRUD aceita modulos`.

---

### Task 3: sidebar filtra por módulo

**Files:**
- Modify: `public/nav.js` (ITENS ~linhas 47-52 e callback do `/api/me` ~342-358).

- [ ] **Step 1:** marcar os itens soltos do bloco Análise e as seções com `mod`: `{ sec: 'Análise', mod: 'analise' }`, e cada um dos 4 itens (`index`, `comparativos`, `consulta`, `itens`) ganha `mod: 'analise'`. Os grupos já têm `id` igual ao id do módulo (`cahu-distribuidora`, `financeiro`, `compras`, `precificacao`, `prevencao`, `processos`).

- [ ] **Step 2:** no render, adicionar `data-mod` nos elementos: na seção `'<div class="dn-sec"' + g + esconder + (it.mod ? ' data-mod="' + it.mod + '"' : '') + '>'`; no grupo `'" data-grupo-id="' + it.id + '" data-mod="' + it.id + '">'`; no item solto `' data-mod="' + (it.mod || '') + '"'` (só quando `it.mod`).

- [ ] **Step 3:** no callback do `/api/me`, antes do bloco `gerencial`:

```js
      if (u && Array.isArray(u.modulos)) {
        aside.querySelectorAll('[data-mod]').forEach(function (el) {
          if (u.modulos.indexOf(el.getAttribute('data-mod')) === -1) el.style.display = 'none';
        });
        var secOp = aside.querySelector('.dn-sec:not([data-mod])');
        if (secOp && !aside.querySelector('.dn-group[data-mod]:not([style*="display: none"])')) secOp.style.display = 'none';
        if (u.modulos.indexOf('analise') === -1) {
          var b = document.getElementById('dn-brand');
          var grp = aside.querySelector('.dn-group[data-mod]:not([style*="display: none"]) .dn-item');
          if (grp) b.setAttribute('href', grp.getAttribute('href')); else { b.removeAttribute('href'); b.style.cursor = 'default'; }
        }
      }
```

- [ ] **Step 4:** abrir qualquer página logado como admin: sidebar igual a antes. `node --check` não se aplica; conferir no navegador que não há erro de console.
- [ ] **Step 5:** commit `feat(acesso): sidebar esconde módulos não liberados`.

---

### Task 4: cadastro de usuários — caixas de módulos

**Files:**
- Modify: `public/admin-usuarios.html` (formulário ~131-160; `carregar` ~176; `renderTabela` ~206-225; `abrirModal`/`editarUsuario`/`trocarSenha` ~231-298; `salvar` ~307-340; `toggleExtraFields` ~229).

- [ ] **Step 1:** HTML, depois do `field-loja`:

```html
    <div class="field" id="field-modulos">
      <label>Módulos liberados</label>
      <div class="mods" id="f-modulos"></div>
      <div class="field-hint">Marcou o módulo, o usuário vê todas as telas dele. Admin vê tudo.</div>
    </div>
```
CSS junto aos `.field`: `.mods{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:4px}.mods label{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--text2);cursor:pointer}.mods input{width:15px;height:15px;accent-color:var(--navy,#16233F)}`. Coluna nova na tabela: `<th>Módulos</th>` depois de `Vínculo` (colspan do vazio vira 7).

- [ ] **Step 2:** JS:
  - `let MODULOS = [];` e em `carregar()` antes de `renderTabela()`: `MODULOS = await (await fetch('/api/admin/modulos')).json(); renderModulosForm();`
  - `function renderModulosForm(){ document.getElementById('f-modulos').innerHTML = MODULOS.map(m => `<label><input type="checkbox" value="${m.id}"> ${m.nome}</label>`).join(''); }`
  - `function setModulos(lista){ const todos = !Array.isArray(lista); document.querySelectorAll('#f-modulos input').forEach(i => { i.checked = todos || lista.includes(i.value); }); }`
  - `function getModulos(){ return [...document.querySelectorAll('#f-modulos input:checked')].map(i => i.value); }`
  - `toggleExtraFields`: `document.getElementById('field-modulos').style.display = (p === 'admin' || p === 'gerencial') ? 'none' : '';`
  - `abrirModal`: `setModulos(null)` (tudo marcado). `editarUsuario` e `trocarSenha`: `setModulos(u.modulos)`.
  - `salvar`: `const body = { nome, usuario, perfil, comprador_nome, loja_id, modulos: (perfil === 'admin' || perfil === 'gerencial') ? null : getModulos() };`
  - `renderTabela`: célula nova `<td>${etiquetasModulos(u)}</td>` com
    `function etiquetasModulos(u){ if (u.perfil==='admin') return '<span style="color:var(--text3);font-size:11px">todos</span>'; if (u.perfil==='gerencial') return '<span style="color:var(--text3);font-size:11px">Gestão Gerencial</span>'; if (!Array.isArray(u.modulos)) return '<span style="color:var(--text3);font-size:11px">todos</span>'; if (!u.modulos.length) return '<span style="color:#B42318;font-size:11px">nenhum</span>'; return u.modulos.map(id => `<span class="comp-tag">${(MODULOS.find(m=>m.id===id)||{nome:id}).nome}</span>`).join(' '); }`

- [ ] **Step 3:** teste manual: criar usuário "teste.fin" perfil Gerente só com Financeiro; logar em janela anônima → cai em `/conciliador.html`; sidebar só Financeiro; `/pendencias.html` redireciona; `fetch('/api/pendencias')` → 403; admin continua vendo tudo; editar usuário antigo mostra tudo marcado.
- [ ] **Step 4:** commit `feat(acesso): cadastro de usuários escolhe os módulos liberados`.

---

### Task 5: deploy e memória

- [ ] `git push origin main` e `GET https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026`; esperar ~10 s; conferir `/api/versao`.
- [ ] Atualizar memória `feedback_economico-regras-acesso.md` com a regra 3 (acesso por módulo, mapa em `lib/modulos.js`).
