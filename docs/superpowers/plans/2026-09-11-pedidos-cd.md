# Pedidos do CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a tela Gestão de Compras > Centro Distribuição por uma nova que vincula caixa do CD ↔ unidade da loja, sugere o pedido semanal loja→CD em caixas com as regras do Radar, e acompanha o pedido até chegar na loja.

**Architecture:** Novo módulo `lib/pedidos-cd.js` (coleta ERP só dos produtos vinculados, lead por loja, sugestão, pedidos em JSON, verificação de expedição/recebimento) reaproveitando as funções puras exportadas de `lib/radar-pedidos.js`. Helpers puros e testáveis em `lib/pedidos-cd-util.js`. Rotas em `server.js` no bloco do Radar. Página `public/centro-distribuicao.html` reescrita do zero no padrão visual do Radar.

**Tech Stack:** Node 24 (`node:test` nativo, sem framework), Express 5, mysql2 (só SELECT, via `q()` do server.js), JSON em `data/` no .254 (fora do git), HTML/JS vanilla com `design-system.css` + `nav.js`.

Spec: `docs/superpowers/specs/2026-09-11-pedidos-cd-design.md`.

## Global Constraints

- ERP MySQL (192.168.2.252) é **somente leitura**: só `SELECT`, sempre através de `q()`; nunca conectar direto da máquina local, testes de integração rodam no .254 via SSH (`ssh -i ~/.ssh/claude_254 claude-ssh@192.168.2.254`, shell cmd.exe; Tailscale 100.102.231.28 quando estiver online).
- Persistência do app em `data/cd-vinculos.json`, `data/pedidos-cd/<id>.json`, `data/pedidos-cd/config.json` (pasta `data/` já está no .gitignore).
- Lojas 1–6, nomes `{1:'CAHU',2:'MURIBECA',3:'PONTE',4:'ATACAREJO',5:'PORTA LARGA',6:'JARDIM JORDÃO'}`; CD = loja 10; fornecedor do CD nas notas de entrada = `CodFornec 2157`.
- Ciclo fixo 7 dias, teto padrão 28, 60% da validade, lead padrão 2 (máx 3) sem histórico.
- Testes unitários: `node --test test/` (criar pasta `test/`). Não há framework; usar `node:test` + `node:assert/strict`.
- Bloco "Operação" do `nav.js` fica em ordem alfabética; a entrada continua `Centro Distribuição` em `/centro-distribuicao.html`.
- Commits: mensagem em português, terminando com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Não fazer push; o Tiago decide o deploy.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/radar-pedidos.js` (modificar) | exportar `paramsLista`, `alvoProduto`, `qtdPedido`, `num`, `chunk`; `embEfetiva` respeita `p.embFixa` |
| `lib/pedidos-cd-util.js` (criar) | funções puras: `dun14ParaEan13`, `ean13Valido`, `emCaixas`, `distribuirCdInsuficiente`, `statusRecebimento`, `mediaLead` |
| `lib/pedidos-cd.js` (criar) | estado do módulo: vínculos, config, coleta ERP, lead por loja, sugestão, pedidos, verificação, agendamento |
| `server.js` (modificar) | remover bloco antigo do CD (linhas 4255–4527) e helpers; adicionar rotas `/api/pedidos-cd/*` depois do bloco `pedidosFornec` |
| `public/centro-distribuicao.html` (reescrever) | página com 4 abas |
| `test/pedidos-cd-util.test.js`, `test/radar-export.test.js` (criar) | testes unitários |

---

### Task 1: Exportar as funções puras do Radar e aceitar embalagem fixa

**Files:**
- Modify: `lib/radar-pedidos.js:60-63` (embEfetiva) e `:568` (module.exports)
- Test: `test/radar-export.test.js`

**Interfaces:**
- Produces: `paramsLista(L, lead, teto) → {lm, seg, ponto, alvoLista, ciclo}|null` (`lead = {lead_medio, lead_max, intervalo}`), `alvoProduto(p, P) → number`, `qtdPedido(p, P, fazerEm, embMeses) → {qtd, flag, alvo, emb, porLoja}` onde `p = {cod, lista, emb, embFixa?, validade, vq, lojas:[ln], porLoja:{ln:{vq, est, transito}}}`; `num(v)`, `chunk(arr, n)`.

- [ ] **Step 1: Escrever o teste que falha**

```js
// test/radar-export.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const radar = require('../lib/radar-pedidos');

test('exporta as funções puras', () => {
  for (const f of ['paramsLista', 'alvoProduto', 'qtdPedido', 'num', 'chunk']) assert.equal(typeof radar[f], 'function', f);
});

test('paramsLista com ciclo fixo 7 e teto 28', () => {
  const P = radar.paramsLista({}, { lead_medio: 2, lead_max: 3, intervalo: 7 }, 28);
  assert.deepEqual(P, { lm: 2, seg: 1, ponto: 3, alvoLista: 10, ciclo: 7 });
});

test('qtdPedido usa embFixa (un/cx) e devolve múltiplos de caixa por loja', () => {
  const P = radar.paramsLista({}, { lead_medio: 2, lead_max: 3, intervalo: 7 }, 28);
  const p = { cod: 'X', lista: 0, emb: 1, embFixa: 12, validade: 0, vq: 10, lojas: [1, 2],
    porLoja: { 1: { vq: 10, est: 0, transito: 0 }, 2: { vq: 10, est: 500, transito: 0 } } };
  const r = radar.qtdPedido(p, P, 0, 0);
  assert.equal(r.emb, 12);
  assert.equal(r.porLoja[1] % 12, 0);
  assert.ok(r.porLoja[1] >= 96);       // alvo 10 d × 10 un/d = 100 → 108 (9 cx)
  assert.equal(r.porLoja[2], 0);        // loja 2 sobrando
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/radar-export.test.js`
Expected: FAIL — `typeof radar.paramsLista` é `undefined`.

- [ ] **Step 3: Implementar**

Em `lib/radar-pedidos.js`, trocar `embEfetiva`:

```js
function embEfetiva(p, meses) {
  if (p.embFixa >= 1) return p.embFixa;   // Pedidos do CD: un/cx do vínculo, sem olhar histórico de notas
  const h = embCompra(p.cod, meses, base?.listas?.[p.lista]?.codFornec || 0);
  return h && h >= 1 ? h : p.emb;
}
```

Trocar a última linha:

```js
module.exports = { init, agendar, recalcular, politica, itensLista, curvaARisco, sombra, sombraDetalhe, getEstado, TETO_PADRAO,
  // funções puras reaproveitadas por lib/pedidos-cd.js
  paramsLista, alvoProduto, qtdPedido, num, chunk };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/radar-export.test.js`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/radar-pedidos.js test/radar-export.test.js
git commit -m "Radar: exporta paramsLista/alvoProduto/qtdPedido e aceita embFixa (base pros Pedidos do CD)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Helpers puros (`lib/pedidos-cd-util.js`)

**Files:**
- Create: `lib/pedidos-cd-util.js`
- Test: `test/pedidos-cd-util.test.js`

**Interfaces:**
- Produces:
  - `ean13Valido(s) → boolean`
  - `dun14ParaEan13(cod14) → string|null` (null se não tiver 14 dígitos)
  - `emCaixas(unidades, unPorCaixa) → number` (ceil, 0 se unPorCaixa inválido)
  - `distribuirCdInsuficiente(pedidoCx:{ln:number}, estoqueCx:number, cobertura:{ln:number}) → {pedidoCx:{ln:number}, falta:number}`
  - `statusRecebimento(itens:[{caixas, recebidas}]) → 'recebido'|'recebido_parcial'|'aberto'`
  - `mediaLead(pares:[{entrada:'YYYY-MM-DD', nota:'YYYY-MM-DD'}]) → {lead_medio, lead_max, n}|null`

- [ ] **Step 1: Escrever os testes**

```js
// test/pedidos-cd-util.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../lib/pedidos-cd-util');

test('dun14ParaEan13 recalcula o dígito verificador', () => {
  assert.equal(u.dun14ParaEan13('17896037913143'), '7896037913146');
  assert.equal(u.dun14ParaEan13('25601252231168'), '5601252231164');
  assert.equal(u.dun14ParaEan13('7896037913146'), null);
  assert.equal(u.dun14ParaEan13('1789603791314X'), null);
});

test('ean13Valido', () => {
  assert.equal(u.ean13Valido('7896037913146'), true);
  assert.equal(u.ean13Valido('7896037913145'), false);
});

test('emCaixas arredonda pra cima', () => {
  assert.equal(u.emCaixas(0, 12), 0);
  assert.equal(u.emCaixas(1, 12), 1);
  assert.equal(u.emCaixas(24, 12), 2);
  assert.equal(u.emCaixas(25, 12), 3);
  assert.equal(u.emCaixas(10, 0), 0);
});

test('distribuirCdInsuficiente respeita o estoque e prioriza menor cobertura', () => {
  const r = u.distribuirCdInsuficiente({ 1: 3, 2: 2, 3: 4 }, 5, { 1: 10, 2: 1, 3: 5 });
  assert.equal(r.falta, 4);
  assert.equal(Object.values(r.pedidoCx).reduce((a, b) => a + b, 0), 5);
  assert.equal(r.pedidoCx[2], 2);           // menor cobertura, atendida inteira
  assert.ok(r.pedidoCx[3] >= r.pedidoCx[1]); // próxima prioridade
});

test('distribuirCdInsuficiente sem falta devolve igual', () => {
  const r = u.distribuirCdInsuficiente({ 1: 3, 2: 2 }, 10, { 1: 1, 2: 2 });
  assert.deepEqual(r, { pedidoCx: { 1: 3, 2: 2 }, falta: 0 });
});

test('statusRecebimento', () => {
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 2 }, { caixas: 1, recebidas: 1 }]), 'recebido');
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 1 }, { caixas: 1, recebidas: 1 }]), 'recebido_parcial');
  assert.equal(u.statusRecebimento([{ caixas: 2, recebidas: 0 }, { caixas: 1, recebidas: 0 }]), 'aberto');
});

test('mediaLead', () => {
  assert.equal(u.mediaLead([]), null);
  assert.deepEqual(u.mediaLead([{ entrada: '2026-09-01', nota: '2026-09-02' }, { entrada: '2026-09-03', nota: '2026-09-06' }]), { lead_medio: 2, lead_max: 3, n: 2 });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/pedidos-cd-util.test.js`
Expected: FAIL — `Cannot find module '../lib/pedidos-cd-util'`.

- [ ] **Step 3: Implementar**

```js
// lib/pedidos-cd-util.js — funções puras dos Pedidos do CD (sem ERP, sem fs)
function digitoEan13(b12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += (+b12[i]) * (i % 2 ? 3 : 1);
  return String((10 - s % 10) % 10);
}
function ean13Valido(s) {
  return /^\d{13}$/.test(s || '') && digitoEan13(s.slice(0, 12)) === s[12];
}
// DUN-14 (código de caixa) = indicador (1 dígito) + 12 dígitos do EAN-13 da unidade + verificador próprio
function dun14ParaEan13(cod14) {
  if (!/^\d{14}$/.test(cod14 || '')) return null;
  const b12 = cod14.slice(1, 13);
  return b12 + digitoEan13(b12);
}
function emCaixas(unidades, unPorCaixa) {
  if (!(unPorCaixa >= 1) || !(unidades > 0)) return 0;
  return Math.ceil(unidades / unPorCaixa);
}
// Quando as lojas pedem mais caixas do que o CD tem: entrega uma caixa por vez,
// sempre pra loja de menor cobertura que ainda não recebeu tudo que pediu.
function distribuirCdInsuficiente(pedidoCx, estoqueCx, cobertura) {
  const total = Object.values(pedidoCx).reduce((a, b) => a + b, 0);
  const est = Math.max(0, Math.floor(estoqueCx));
  if (total <= est) return { pedidoCx: { ...pedidoCx }, falta: 0 };
  const out = {}; for (const ln of Object.keys(pedidoCx)) out[ln] = 0;
  let restante = est;
  while (restante > 0) {
    const cand = Object.keys(pedidoCx).filter(ln => out[ln] < pedidoCx[ln])
      .sort((a, b) => (cobertura[a] ?? 9999) - (cobertura[b] ?? 9999) || (+a) - (+b));
    if (!cand.length) break;
    out[cand[0]]++; restante--;
  }
  return { pedidoCx: out, falta: total - est };
}
function statusRecebimento(itens) {
  const rec = itens.reduce((a, i) => a + Math.min(i.recebidas || 0, i.caixas), 0);
  const ped = itens.reduce((a, i) => a + i.caixas, 0);
  if (ped > 0 && rec >= ped) return 'recebido';
  if (rec > 0) return 'recebido_parcial';
  return 'aberto';
}
function mediaLead(pares) {
  const ds = pares.map(p => Math.round((new Date(p.nota + 'T00:00:00Z') - new Date(p.entrada + 'T00:00:00Z')) / 864e5)).filter(d => d >= 0 && d <= 30);
  if (!ds.length) return null;
  const m = ds.reduce((a, b) => a + b, 0) / ds.length;
  return { lead_medio: +m.toFixed(1), lead_max: Math.max(...ds), n: ds.length };
}
module.exports = { ean13Valido, dun14ParaEan13, emCaixas, distribuirCdInsuficiente, statusRecebimento, mediaLead };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/pedidos-cd-util.test.js`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/pedidos-cd-util.js test/pedidos-cd-util.test.js
git commit -m "Pedidos do CD: helpers puros (DUN-14→EAN-13, caixas, CD insuficiente, recebimento, lead)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Módulo `lib/pedidos-cd.js` — vínculos e config

**Files:**
- Create: `lib/pedidos-cd.js`
- Test: `test/pedidos-cd-vinculos.test.js`

**Interfaces:**
- Consumes: `pedidos-cd-util` (Task 2).
- Produces: `init({ q, mesDB, dataDir? })`, `getConfig() → cfg`, `salvarConfig(parcial) → cfg`, `getVinculos() → {codigoCD: vinculo}`, `salvarVinculo({codigoCD, unidade, unPorCaixa, usuario}) → vinculo`, `removerVinculo(codigoCD)`, `sincronizarVinculos(produtosCD) → {codigoCD: vinculo}` (puro em relação ao ERP: recebe a lista já consultada), `buscarUnidade(texto) → Promise<[{cod, descricao}]>`.
- Formato do vínculo: `{ codigoCD, unidade, unPorCaixa, origem:'igual'|'dun14'|'manual', status:'confirmado'|'sugerido'|'pendente', candidato?, confirmadoPor, confirmadoEm }`.
- Config default: `{ teto: 28, ciclo: 7, leadPadrao: 2, leadMaxPadrao: 3, fornecedorCD: 2157, clientesLoja: {1:828, 2:899, 3:1300, 4:1421, 5:1684, 6:1969} }`.

- [ ] **Step 1: Escrever o teste**

```js
// test/pedidos-cd-vinculos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-'));
cd.init({ q: async () => [], mesDB: m => String(m).padStart(2, '0'), dataDir: dir });

test('config default e salvar parcial', () => {
  assert.equal(cd.getConfig().teto, 28);
  assert.equal(cd.getConfig().clientesLoja[1], 828);
  cd.salvarConfig({ teto: 21 });
  assert.equal(cd.getConfig().teto, 21);
  assert.equal(cd.getConfig().ciclo, 7);
});

test('sincronizarVinculos: igual, dun14 sugerido, pendente; não sobrescreve confirmado', () => {
  const v = cd.sincronizarVinculos([
    { codigoCD: '7897395040727', unPorCaixa: null, unidadeExiste: null },
    { codigoCD: '17896037913143', unPorCaixa: 12, unidadeExiste: '7896037913146' },
    { codigoCD: '17509546679171', unPorCaixa: 72, unidadeExiste: null }
  ]);
  assert.equal(v['7897395040727'].status, 'confirmado'); assert.equal(v['7897395040727'].origem, 'igual'); assert.equal(v['7897395040727'].unPorCaixa, 1);
  assert.equal(v['17896037913143'].status, 'sugerido'); assert.equal(v['17896037913143'].candidato, '7896037913146'); assert.equal(v['17896037913143'].unPorCaixa, 12);
  assert.equal(v['17509546679171'].status, 'pendente');
  cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 'tiago' });
  const v2 = cd.sincronizarVinculos([{ codigoCD: '17896037913143', unPorCaixa: 24, unidadeExiste: '7896037913146' }]);
  assert.equal(v2['17896037913143'].status, 'confirmado');
  assert.equal(v2['17896037913143'].unPorCaixa, 12);   // manual vence o cadastro
  assert.equal(v2['17896037913143'].origem, 'dun14');   // candidato aceito mantém a origem
});

test('salvarVinculo valida', () => {
  assert.throws(() => cd.salvarVinculo({ codigoCD: '1', unidade: '', unPorCaixa: 12 }), /unidade/);
  assert.throws(() => cd.salvarVinculo({ codigoCD: '1', unidade: '2', unPorCaixa: 0 }), /un\/cx/);
  cd.salvarVinculo({ codigoCD: '17509546679171', unidade: '7509546679174', unPorCaixa: 72, usuario: 'tiago' });
  assert.equal(cd.getVinculos()['17509546679171'].origem, 'manual');
  cd.removerVinculo('17509546679171');
  assert.equal(cd.getVinculos()['17509546679171'].status, 'pendente');
  assert.equal(cd.getVinculos()['17509546679171'].unidade, null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/pedidos-cd-vinculos.test.js`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar (primeira parte do módulo)**

```js
// lib/pedidos-cd.js — Pedidos do CD (loja 10 → lojas 1-6)
//
// Vínculo caixa↔unidade, sugestão semanal em caixas com as regras do Radar,
// pedidos em JSON e acompanhamento (separado no CD → chegou na loja).
// ERP só leitura. Spec: docs/superpowers/specs/2026-09-11-pedidos-cd-design.md
const fs = require('fs');
const path = require('path');
const u = require('./pedidos-cd-util');
const radar = require('./radar-pedidos');

const LOJAS = [1, 2, 3, 4, 5, 6];
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const CONFIG_PADRAO = { teto: 28, ciclo: 7, leadPadrao: 2, leadMaxPadrao: 3, fornecedorCD: 2157, clientesLoja: { 1: 828, 2: 899, 3: 1300, 4: 1421, 5: 1684, 6: 1969 } };

let deps = null;      // { q, mesDB }
let DATA = null;      // pasta data/
let VINC_ARQ = null, PED_DIR = null, CFG_ARQ = null;
let vinculos = {};    // codigoCD → vinculo
let config = null;

function init(d) {
  deps = d;
  DATA = d.dataDir || path.join(__dirname, '..', 'data');
  VINC_ARQ = path.join(DATA, 'cd-vinculos.json');
  PED_DIR = path.join(DATA, 'pedidos-cd');
  CFG_ARQ = path.join(PED_DIR, 'config.json');
  fs.mkdirSync(PED_DIR, { recursive: true });
  try { vinculos = JSON.parse(fs.readFileSync(VINC_ARQ, 'utf8')); } catch (e) { vinculos = {}; }
  try { config = { ...CONFIG_PADRAO, ...JSON.parse(fs.readFileSync(CFG_ARQ, 'utf8')) }; } catch (e) { config = { ...CONFIG_PADRAO }; }
}
const agora = () => new Date().toISOString();
function gravarVinculos() { fs.writeFileSync(VINC_ARQ, JSON.stringify(vinculos, null, 1)); }
function getConfig() { return { ...config, clientesLoja: { ...config.clientesLoja } }; }
function salvarConfig(parcial) {
  const c = { ...config };
  if (parcial.teto != null) c.teto = Math.max(3, Math.min(90, +parcial.teto || 28));
  if (parcial.fornecedorCD != null) c.fornecedorCD = +parcial.fornecedorCD || CONFIG_PADRAO.fornecedorCD;
  if (parcial.clientesLoja) c.clientesLoja = { ...c.clientesLoja }, Object.entries(parcial.clientesLoja).forEach(([ln, v]) => { if (LOJAS.includes(+ln)) c.clientesLoja[ln] = +v || 0; });
  config = c; fs.writeFileSync(CFG_ARQ, JSON.stringify(config, null, 1));
  return getConfig();
}
function getVinculos() { return vinculos; }

// produtosCD: [{ codigoCD, unPorCaixa (embalagempadrao_venda ou null), unidadeExiste (EAN-13 do DUN-14 se existe ativo no cadastro, senão null) }]
function sincronizarVinculos(produtosCD) {
  for (const p of produtosCD) {
    const cod = String(p.codigoCD);
    const atual = vinculos[cod];
    if (atual && atual.status === 'confirmado') { if (atual.unPorCaixaCadastro !== p.unPorCaixa) { atual.unPorCaixaCadastro = p.unPorCaixa; } continue; }
    if (cod.length <= 13) {
      vinculos[cod] = { codigoCD: cod, unidade: cod, unPorCaixa: 1, unPorCaixaCadastro: p.unPorCaixa, origem: 'igual', status: 'confirmado', confirmadoPor: 'sistema', confirmadoEm: agora() };
      continue;
    }
    const cand = p.unidadeExiste || null;
    vinculos[cod] = { codigoCD: cod, unidade: null, unPorCaixa: (atual && atual.unPorCaixa) || p.unPorCaixa || null, unPorCaixaCadastro: p.unPorCaixa,
      origem: cand ? 'dun14' : null, status: cand ? 'sugerido' : 'pendente', candidato: cand, confirmadoPor: null, confirmadoEm: null };
  }
  gravarVinculos();
  return vinculos;
}
function salvarVinculo({ codigoCD, unidade, unPorCaixa, usuario }) {
  const cod = String(codigoCD || ''); const un = String(unidade || '').trim(); const upc = Math.round(+unPorCaixa);
  if (!cod) throw new Error('codigoCD obrigatório');
  if (!un) throw new Error('unidade obrigatória');
  if (!(upc >= 1)) throw new Error('un/cx inválido (mínimo 1)');
  const atual = vinculos[cod] || { codigoCD: cod };
  const origem = cod === un ? 'igual' : (atual.candidato === un ? 'dun14' : 'manual');
  vinculos[cod] = { ...atual, codigoCD: cod, unidade: un, unPorCaixa: upc, origem, status: 'confirmado', confirmadoPor: usuario || null, confirmadoEm: agora() };
  gravarVinculos();
  return vinculos[cod];
}
function removerVinculo(codigoCD) {
  const cod = String(codigoCD); const atual = vinculos[cod]; if (!atual) return null;
  vinculos[cod] = { ...atual, unidade: null, origem: atual.candidato ? 'dun14' : null, status: atual.candidato ? 'sugerido' : 'pendente', confirmadoPor: null, confirmadoEm: null };
  gravarVinculos();
  return vinculos[cod];
}
async function buscarUnidade(texto) {
  const t = String(texto || '').trim(); if (t.length < 3) return [];
  const rows = await deps.q(`SELECT CodigoBarra cod, TRIM(Descricao) descricao FROM central.itens
    WHERE CodDesativado=0 AND LENGTH(CodigoBarra)<=13 AND (CodigoBarra LIKE ? OR Descricao LIKE ?) ORDER BY Descricao LIMIT 30`, [t + '%', '%' + t + '%']);
  return rows;
}

module.exports = { init, getConfig, salvarConfig, getVinculos, sincronizarVinculos, salvarVinculo, removerVinculo, buscarUnidade, LOJAS, LOJAS_NOMES };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/pedidos-cd-vinculos.test.js`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/pedidos-cd.js test/pedidos-cd-vinculos.test.js
git commit -m "Pedidos do CD: vínculos caixa↔unidade (igual/DUN-14/manual) e config em JSON

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Coleta do ERP, lead por loja e sugestão

**Files:**
- Modify: `lib/pedidos-cd.js` (acrescentar após `buscarUnidade`)
- Test: `test/pedidos-cd-sugestao.test.js`

**Interfaces:**
- Consumes: `radar.paramsLista/alvoProduto/qtdPedido/num/chunk`, `u.emCaixas/distribuirCdInsuficiente/mediaLead`, vínculos da Task 3.
- Produces: `recalcular() → Promise<estado>`, `getEstado()`, `sugestao(teto?) → { repor:[...], novos:[...], resumo, regras, estado }`, `calcularSugestao(base, vinculos, cfg, transito) → {repor, novos}` (puro, testável), `agendar()`.
- Formato de item em `repor`/`novos`: `{ codigoCD, descricaoCD, unidade, descricaoUn, unPorCaixa, estoqueCDcx, vqTotal, coberturaTotal, custoUn, lojas:{ln:{cx, un, vq, est, transito, cobertura, zeraAntes}}, totalCx, custoTotal, cdInsuficiente:boolean, faltaCx, origem:'repor'|'novo', semVinculo:boolean }`.

- [ ] **Step 1: Escrever o teste do cálculo puro**

```js
// test/pedidos-cd-sugestao.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');
cd.init({ q: async () => [], mesDB: m => String(m).padStart(2, '0'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-')) });

const cfg = { teto: 28, ciclo: 7, leadPadrao: 2, leadMaxPadrao: 3 };
const lead = { 1: { lead_medio: 2, lead_max: 3, n: 5 }, 2: null };
const vinc = {
  '17896037913143': { codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, status: 'confirmado' },
  '17509546679171': { codigoCD: '17509546679171', unidade: null, unPorCaixa: 72, status: 'pendente' }
};
const base = {
  hoje: '2026-09-14', dias: 40, lead,
  cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5, unPorCaixaCadastro: 12 }, '17509546679171': { descricao: 'CREME DENTAL CX72', estoqueCx: 10, unPorCaixaCadastro: 72 } },
  un: { '7896037913146': { descricao: 'VINHO 750ML', validade: 0, custo: 20, porLoja: { 1: { vq: 6, est: 0 }, 2: { vq: 6, est: 200 } } } }
};

test('repor: quantidade em caixas por loja, loja folgada pede 0', () => {
  const { repor, novos } = cd.calcularSugestao(base, vinc, cfg, {});
  assert.equal(repor.length, 1);
  const r = repor[0];
  assert.equal(r.unidade, '7896037913146');
  assert.equal(r.lojas[2].cx, 0);
  assert.ok(r.lojas[1].cx >= 5);          // alvo 10 d × 6 = 60 un → 5 cx
  assert.equal(r.cdInsuficiente, r.totalCx > 5);
  assert.ok(r.totalCx <= 5);              // nunca acima do estoque do CD
  assert.equal(novos.length, 1);
  assert.equal(novos[0].semVinculo, true);
});

test('novos: 1 caixa por loja limitado ao estoque do CD', () => {
  const b2 = { ...base, cd: { ...base.cd, '17509546679171': { descricao: 'X', estoqueCx: 4, unPorCaixaCadastro: 72 } } };
  const { novos } = cd.calcularSugestao(b2, vinc, cfg, {});
  const n = novos[0];
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(ln => n.lojas[ln].cx), [1, 1, 1, 1, 0, 0]);
});

test('trânsito desconta do pedido', () => {
  const { repor } = cd.calcularSugestao(base, vinc, cfg, { '7896037913146|1': 600 });
  assert.equal(repor[0].lojas[1].cx, 0);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/pedidos-cd-sugestao.test.js`
Expected: FAIL — `cd.calcularSugestao is not a function`.

- [ ] **Step 3: Implementar**

Acrescentar em `lib/pedidos-cd.js` antes do `module.exports` e incluir os novos nomes na exportação:

```js
// ─── coleta do ERP ───────────────────────────────────────────
let estado = { status: 'vazio', atualizadoEm: null, erro: null, duracaoMs: 0 };
let base = null;          // ver montarBase()
let recalculando = null;
const JANELA_VENDA_DIAS = 40;
const iso = d => d.toISOString().slice(0, 10);
const addDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const { num, chunk } = radar;

async function coletarCD() {
  const { q } = deps;
  const est = await q(`SELECT e.CodigoBarra cod, e.Qtd, TRIM(i.Descricao) descricao FROM central.estoquen10 e JOIN central.itens i ON i.CodigoBarra=e.CodigoBarra WHERE e.Qtd>0 AND i.CodDesativado=0`);
  const cods = est.map(r => String(r.cod));
  const emb = {};
  for (const c of chunk(cods.filter(x => x.length === 14), 2000)) {
    for (const r of await q(`SELECT Codigobarra cod, Qtd_venda qv FROM central.embalagempadrao_venda WHERE Codigobarra IN (${c.map(() => '?').join(',')})`, c)) { const v = num(r.qv); if (v >= 1) emb[String(r.cod)] = v; }
  }
  const cand = {}; const candList = cods.map(c => [c, u.dun14ParaEan13(c)]).filter(x => x[1]);
  for (const c of chunk(candList.map(x => x[1]), 2000)) {
    const rows = await q(`SELECT CodigoBarra cod FROM central.itens WHERE CodDesativado=0 AND CodigoBarra IN (${c.map(() => '?').join(',')})`, c);
    const ok = new Set(rows.map(r => String(r.cod)));
    for (const [cd14, ean] of candList) if (ok.has(ean)) cand[cd14] = ean;
  }
  const cd = {};
  for (const r of est) { const c = String(r.cod); cd[c] = { descricao: r.descricao, estoqueCx: num(r.Qtd), unPorCaixaCadastro: c.length === 14 ? (emb[c] || null) : 1 }; }
  sincronizarVinculos(cods.map(c => ({ codigoCD: c, unPorCaixa: cd[c].unPorCaixaCadastro, unidadeExiste: cand[c] || null })));
  return cd;
}

async function coletarUnidades(codigos, hoje) {
  const { q, mesDB } = deps;
  const dFim = addDias(hoje, -1), dIni = addDias(hoje, -JANELA_VENDA_DIAS);
  const meses = new Set(); { const d = new Date(dIni + 'T00:00:00Z'); while (iso(d) <= dFim) { meses.add(d.getUTCMonth() + 1); d.setUTCDate(d.getUTCDate() + 1); } }
  const un = {};
  for (const c of chunk(codigos, 2000)) {
    const ph = c.map(() => '?').join(',');
    for (const r of await q(`SELECT CodigoBarra cod, TRIM(Descricao) descricao, Validar validade FROM central.itens WHERE CodigoBarra IN (${ph})`, c))
      un[String(r.cod)] = { descricao: r.descricao, validade: num(r.validade), custo: 0, porLoja: Object.fromEntries(LOJAS.map(ln => [ln, { vq: 0, est: 0 }])) };
    for (const ln of LOJAS) {
      try { for (const r of await q(`SELECT CodigoBarra cod, Qtd FROM central.estoquen${ln} WHERE CodigoBarra IN (${ph})`, c)) if (un[r.cod]) un[r.cod].porLoja[ln].est = Math.max(0, num(r.Qtd)); } catch (e) {}
      try { for (const r of await q(`SELECT CodigoBarra cod, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, c)) if (un[r.cod] && !un[r.cod].custo && num(r.Custo) > 0) un[r.cod].custo = num(r.Custo); } catch (e) {}
      for (const m of meses) {
        try {
          for (const r of await q(`SELECT Codigo cod, SUM(QtdNovo) qtd FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...c]))
            if (un[r.cod]) un[r.cod].porLoja[ln].vq += num(r.qtd) / JANELA_VENDA_DIAS;
        } catch (e) {}
      }
    }
  }
  return un;
}

// lead por loja: pedido da loja no painel do CD (DataEntrada) → nota do fornecedor do CD na loja (DataRecto), 6 meses
async function calcularLead(hoje) {
  const { q } = deps; const cfg = config; const lead = {};
  const dIni = addDias(hoje, -180);
  for (const ln of LOJAS) {
    lead[ln] = null;
    try {
      const cli = cfg.clientesLoja[ln]; if (!cli) continue;
      const ped = await q(`SELECT DATE_FORMAT(DataEntrada,'%Y-%m-%d') d FROM central.painel_televendas WHERE nLoja=10 AND CodFornec=? AND DataEntrada>=? ORDER BY DataEntrada`, [cli, dIni]);
      const notas = await q(`SELECT DISTINCT DATE_FORMAT(DataRecto,'%Y-%m-%d') d FROM central.compras WHERE nLoja=? AND CodFornec=? AND Movimentacao='COMPRA' AND DataRecto>=? ORDER BY DataRecto`, [ln, cfg.fornecedorCD, dIni]);
      const nd = notas.map(x => x.d);
      const pares = [];
      for (const p of ped) { const n = nd.find(x => x >= p.d); if (n) pares.push({ entrada: p.d, nota: n }); }
      lead[ln] = u.mediaLead(pares);
    } catch (e) { console.error('[PEDIDOS-CD] lead loja', ln, e.message); }
  }
  return lead;
}

async function montarBase() {
  const hoje = iso(new Date());
  const cd = await coletarCD();
  const unidades = [...new Set(Object.values(vinculos).filter(v => v.status === 'confirmado' && v.unidade).map(v => v.unidade))];
  const un = await coletarUnidades(unidades, hoje);
  const lead = await calcularLead(hoje);
  return { hoje, dias: JANELA_VENDA_DIAS, cd, un, lead };
}

async function recalcular() {
  if (recalculando) return recalculando;
  recalculando = (async () => {
    const t0 = Date.now(); estado = { ...estado, status: 'calculando' };
    try { base = await montarBase(); estado = { status: 'ok', atualizadoEm: agora(), erro: null, duracaoMs: Date.now() - t0 }; }
    catch (e) { estado = { ...estado, status: base ? 'ok' : 'erro', erro: e.message, duracaoMs: Date.now() - t0 }; console.error('[PEDIDOS-CD] recalcular:', e.message); }
    finally { recalculando = null; }
    return estado;
  })();
  return recalculando;
}
function getEstado() { return { ...estado, hoje: base?.hoje || null, produtosCD: base ? Object.keys(base.cd).length : 0 }; }

// ─── cálculo (puro em relação ao ERP) ────────────────────────
// transito: { 'unidade|loja': unidades } vindo dos pedidos do CD abertos/separados
function calcularSugestao(b, vinc, cfg, transito) {
  const paramsLoja = {};
  for (const ln of LOJAS) {
    const L = b.lead?.[ln];
    const lead = L ? { lead_medio: L.lead_medio, lead_max: L.lead_max, intervalo: cfg.ciclo } : { lead_medio: cfg.leadPadrao, lead_max: cfg.leadMaxPadrao, intervalo: cfg.ciclo };
    paramsLoja[ln] = radar.paramsLista({}, lead, cfg.teto);
  }
  const repor = [], novos = [];
  for (const [cod, c] of Object.entries(b.cd)) {
    const v = vinc[cod];
    const upc = (v && v.unPorCaixa) || c.unPorCaixaCadastro || null;
    const item = { codigoCD: cod, descricaoCD: c.descricao, unidade: v?.unidade || null, descricaoUn: null, unPorCaixa: upc, estoqueCDcx: c.estoqueCx,
      vqTotal: 0, coberturaTotal: null, custoUn: 0, lojas: {}, totalCx: 0, custoTotal: 0, cdInsuficiente: false, faltaCx: 0, origem: 'novo', semVinculo: !(v && v.status === 'confirmado' && v.unidade) };
    const un = item.unidade ? b.un[item.unidade] : null;
    if (un) { item.descricaoUn = un.descricao; item.custoUn = un.custo; item.vqTotal = +LOJAS.reduce((a, ln) => a + un.porLoja[ln].vq, 0).toFixed(3); }
    const temVenda = !!un && item.vqTotal > 0 && upc >= 1;
    if (temVenda) {
      item.origem = 'repor';
      const p = { cod: item.unidade, lista: 0, emb: 1, embFixa: upc, validade: un.validade, vq: item.vqTotal, lojas: LOJAS, porLoja: {} };
      for (const ln of LOJAS) p.porLoja[ln] = { vq: un.porLoja[ln].vq, est: un.porLoja[ln].est, transito: transito[`${item.unidade}|${ln}`] || 0 };
      const pedidoCx = {}, cobertura = {};
      for (const ln of LOJAS) {
        const P = paramsLoja[ln]; const r = radar.qtdPedido(p, P, 0, 0);
        const L = p.porLoja[ln]; const cob = L.vq > 0 ? (L.est + L.transito) / L.vq : null;
        pedidoCx[ln] = u.emCaixas(r.porLoja[ln] || 0, upc); cobertura[ln] = cob ?? 9999;
        item.lojas[ln] = { cx: pedidoCx[ln], un: 0, vq: +L.vq.toFixed(2), est: L.est, transito: L.transito, cobertura: cob == null ? null : +cob.toFixed(1), zeraAntes: cob != null && cob < P.lm };
      }
      const d = u.distribuirCdInsuficiente(pedidoCx, c.estoqueCx, cobertura);
      for (const ln of LOJAS) { item.lojas[ln].cx = d.pedidoCx[ln]; item.lojas[ln].un = d.pedidoCx[ln] * upc; }
      item.cdInsuficiente = d.falta > 0; item.faltaCx = d.falta;
      item.coberturaTotal = item.vqTotal > 0 ? +(LOJAS.reduce((a, ln) => a + p.porLoja[ln].est + p.porLoja[ln].transito, 0) / item.vqTotal).toFixed(1) : null;
    } else {
      let sobra = Math.floor(c.estoqueCx);
      for (const ln of LOJAS) { const cx = sobra > 0 ? 1 : 0; sobra -= cx; item.lojas[ln] = { cx, un: upc ? cx * upc : 0, vq: 0, est: un ? un.porLoja[ln].est : 0, transito: transito[`${item.unidade}|${ln}`] || 0, cobertura: null, zeraAntes: false }; }
    }
    item.totalCx = LOJAS.reduce((a, ln) => a + item.lojas[ln].cx, 0);
    item.custoTotal = +(item.totalCx * (upc || 0) * item.custoUn).toFixed(2);
    (item.origem === 'repor' ? repor : novos).push(item);
  }
  repor.sort((a, b2) => (a.coberturaTotal ?? 9999) - (b2.coberturaTotal ?? 9999));
  novos.sort((a, b2) => a.descricaoCD.localeCompare(b2.descricaoCD));
  return { repor, novos, paramsLoja };
}

function transitoPedidos() {
  const t = {};
  for (const p of listarPedidos()) if (p.status === 'aberto' || p.status === 'separado') for (const i of p.itens) t[`${i.unidade}|${p.loja}`] = (t[`${i.unidade}|${p.loja}`] || 0) + i.unidades;
  return t;
}
function sugestao(teto) {
  if (!base) return { repor: [], novos: [], resumo: null, regras: null, estado: getEstado() };
  const cfg = { ...config, teto: teto || config.teto };
  const { repor, novos, paramsLoja } = calcularSugestao(base, vinculos, cfg, transitoPedidos());
  const resumo = { repor: repor.length, novos: novos.length, semVinculo: novos.filter(n => n.semVinculo).length, cdInsuficiente: repor.filter(r => r.cdInsuficiente).length,
    caixas: repor.concat(novos).reduce((a, r) => a + r.totalCx, 0), custo: +repor.concat(novos).reduce((a, r) => a + r.custoTotal, 0).toFixed(2), proximaSegunda: proximaSegunda(base.hoje) };
  const regras = { teto: cfg.teto, ciclo: cfg.ciclo, fracaoValidade: 0.6, lojas: Object.fromEntries(LOJAS.map(ln => [ln, { nome: LOJAS_NOMES[ln], lead: base.lead[ln], ...paramsLoja[ln] }])) };
  return { repor, novos, resumo, regras, estado: getEstado() };
}
function proximaSegunda(hoje) { const d = new Date(hoje + 'T00:00:00Z'); const dow = d.getUTCDay(); return addDias(hoje, dow === 1 ? 0 : (8 - dow) % 7); }

let timer = null;
function agendar() {
  setTimeout(() => recalcular(), 90 * 1000);
  const prox = () => { const n = new Date(); const t = new Date(n); t.setHours(5, 30, 0, 0); if (t <= n) t.setDate(t.getDate() + 1); return t - n; };
  const tick = () => { recalcular(); timer = setTimeout(tick, prox()); };
  timer = setTimeout(tick, prox());
}
```

`listarPedidos` é definida na Task 5; pra esta task passar, acrescentar provisoriamente `function listarPedidos() { return []; }` (a Task 5 substitui). Atualizar o `module.exports` pra incluir `recalcular, getEstado, sugestao, calcularSugestao, agendar`.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/`
Expected: todos passando (radar-export 3, util 7, vinculos 3, sugestao 3).

- [ ] **Step 5: Commit**

```bash
git add lib/pedidos-cd.js test/pedidos-cd-sugestao.test.js
git commit -m "Pedidos do CD: coleta do ERP, lead por loja e sugestão semanal em caixas (regras do Radar)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Pedidos em JSON e verificação (separado / recebido)

**Files:**
- Modify: `lib/pedidos-cd.js` (substituir o stub `listarPedidos`, acrescentar bloco de pedidos)
- Test: `test/pedidos-cd-pedidos.test.js`

**Interfaces:**
- Produces: `criarPedidos({ lojas:{ln:[{codigoCD, caixas}]}, usuario }) → [pedido]`, `listarPedidos() → [pedido]`, `obterPedido(id)`, `cancelarPedido(id, usuario)`, `verificar() → Promise<{verificados, separados, recebidos}>`.
- Pedido: `{ id, loja, lojaNome, status:'aberto'|'separado'|'recebido'|'recebido_parcial'|'cancelado', criadoEm, criadoPor, canceladoEm?, canceladoPor?, itens:[{ codigoCD, unidade, descricao, unPorCaixa, caixas, unidades, custoUn, origem, recebidas:number, separadas:number }], totais:{caixas, unidades, custo}, expedicao:{ nPedido, data }|null, recebimento:{ notas:[{nNota, data}], verificadoEm }|null }`.

- [ ] **Step 1: Escrever o teste**

```js
// test/pedidos-cd-pedidos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cd = require('../lib/pedidos-cd');

let sql = [];
const fakeQ = async (s, p) => {
  sql.push(s);
  if (s.includes('painel_televendas')) return [{ nPedido: '6400', d: '2026-09-15' }];
  if (s.includes('conferencia_televendas')) return [{ cod: '17896037913143', cx: 3 }];
  if (s.includes('FROM central.compras c')) return [{ cod: '7896037913146', cx: 2, nNota: 4900, d: '2026-09-16' }];
  return [];
};
cd.init({ q: fakeQ, mesDB: m => String(m).padStart(2, '0'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-')) });
cd.salvarVinculo({ codigoCD: '17896037913143', unidade: '7896037913146', unPorCaixa: 12, usuario: 't' });
cd._setBaseParaTeste({ hoje: '2026-09-14', cd: { '17896037913143': { descricao: 'VINHO CX12', estoqueCx: 5 } }, un: { '7896037913146': { descricao: 'VINHO', custo: 20, porLoja: {} } }, lead: {} });

test('criarPedidos: 1 por loja, só itens com caixas > 0, recusa sem vínculo', () => {
  const ps = cd.criarPedidos({ lojas: { 1: [{ codigoCD: '17896037913143', caixas: 3 }], 2: [{ codigoCD: '17896037913143', caixas: 0 }] }, usuario: 'tiago' });
  assert.equal(ps.length, 1);
  assert.equal(ps[0].loja, 1); assert.equal(ps[0].status, 'aberto');
  assert.equal(ps[0].itens[0].unidades, 36); assert.equal(ps[0].totais.custo, 720);
  assert.throws(() => cd.criarPedidos({ lojas: { 1: [{ codigoCD: '999', caixas: 1 }] }, usuario: 't' }), /vínculo/);
});

test('verificar: separado pelo painel do CD e recebido pela nota da loja', async () => {
  const r = await cd.verificar();
  const p = cd.listarPedidos()[0];
  assert.equal(p.expedicao.nPedido, '6400');
  assert.equal(p.itens[0].separadas, 3);
  assert.equal(p.itens[0].recebidas, 2);
  assert.equal(p.status, 'recebido_parcial');
  assert.equal(r.verificados, 1);
});

test('cancelar', () => {
  const p = cd.listarPedidos()[0];
  cd.cancelarPedido(p.id, 'tiago');
  assert.equal(cd.obterPedido(p.id).status, 'cancelado');
  assert.throws(() => cd.cancelarPedido(p.id, 'tiago'), /cancelado/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/pedidos-cd-pedidos.test.js`
Expected: FAIL — `cd._setBaseParaTeste is not a function`.

- [ ] **Step 3: Implementar**

Remover o stub e acrescentar em `lib/pedidos-cd.js`:

```js
// ─── pedidos (1 JSON por pedido, 1 pedido por loja) ──────────
const arqPed = id => path.join(PED_DIR, `${id}.json`);
function salvarPedido(p) { fs.writeFileSync(arqPed(p.id), JSON.stringify(p)); return p; }
function obterPedido(id) { try { return JSON.parse(fs.readFileSync(arqPed(id), 'utf8')); } catch (e) { return null; } }
function listarPedidos() {
  return fs.readdirSync(PED_DIR).filter(f => /^\d+\.json$/.test(f)).map(f => obterPedido(f.slice(0, -5))).filter(Boolean).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
function proximoId() { const ids = fs.readdirSync(PED_DIR).map(f => parseInt(f)).filter(n => !isNaN(n)); return (ids.length ? Math.max(...ids) : 0) + 1; }
function totaisPedido(p) {
  return { caixas: p.itens.reduce((a, i) => a + i.caixas, 0), unidades: p.itens.reduce((a, i) => a + i.unidades, 0), custo: +p.itens.reduce((a, i) => a + i.unidades * (i.custoUn || 0), 0).toFixed(2) };
}
function _setBaseParaTeste(b) { base = b; }

function criarPedidos({ lojas, usuario }) {
  if (!base) throw new Error('sugestão ainda não calculada');
  const semVinculo = [];
  const criados = [];
  for (const [lnS, itens] of Object.entries(lojas || {})) {
    const ln = +lnS; if (!LOJAS.includes(ln)) continue;
    const its = [];
    for (const it of itens) {
      const cx = Math.round(+it.caixas || 0); if (cx <= 0) continue;
      const v = vinculos[String(it.codigoCD)];
      if (!v || v.status !== 'confirmado' || !v.unidade || !(v.unPorCaixa >= 1)) { semVinculo.push(String(it.codigoCD)); continue; }
      const c = base.cd[v.codigoCD] || {}; const un = base.un[v.unidade] || {};
      its.push({ codigoCD: v.codigoCD, unidade: v.unidade, descricao: un.descricao || c.descricao || v.codigoCD, unPorCaixa: v.unPorCaixa, caixas: cx, unidades: cx * v.unPorCaixa, custoUn: un.custo || 0, origem: (un.porLoja && Object.values(un.porLoja).some(l => l.vq > 0)) ? 'repor' : 'novo', recebidas: 0, separadas: 0 });
    }
    if (semVinculo.length) throw new Error('produto sem vínculo confirmado: ' + [...new Set(semVinculo)].join(', '));
    if (!its.length) continue;
    const p = { id: proximoId(), loja: ln, lojaNome: LOJAS_NOMES[ln], status: 'aberto', criadoEm: agora(), criadoPor: usuario || null, itens: its, expedicao: null, recebimento: null };
    p.totais = totaisPedido(p); criados.push(salvarPedido(p));
  }
  return criados;
}
function cancelarPedido(id, usuario) {
  const p = obterPedido(id); if (!p) throw new Error('pedido não encontrado');
  if (p.status === 'cancelado') throw new Error('pedido já cancelado');
  if (p.status === 'recebido') throw new Error('pedido já recebido');
  p.status = 'cancelado'; p.canceladoEm = agora(); p.canceladoPor = usuario || null;
  return salvarPedido(p);
}

// separado: pedido da loja no painel do CD (cliente da loja, entrada ≥ criação, Status 4 liberado)
// recebido: nota do fornecedor do CD na loja, casando produto por código de UNIDADE, Qtd em caixas
async function verificar() {
  const { q } = deps; const r = { verificados: 0, separados: 0, recebidos: 0 };
  for (const p of listarPedidos()) {
    if (!['aberto', 'separado', 'recebido_parcial'].includes(p.status)) continue;
    r.verificados++;
    const desde = p.criadoEm.slice(0, 10);
    try {
      if (!p.expedicao) {
        const cli = config.clientesLoja[p.loja];
        const ped = cli ? await q(`SELECT nPedido, DATE_FORMAT(DataLiberacao,'%Y-%m-%d') d FROM central.painel_televendas WHERE nLoja=10 AND CodFornec=? AND Status=4 AND DataEntrada>=? ORDER BY DataEntrada LIMIT 1`, [cli, desde]) : [];
        if (ped.length) {
          p.expedicao = { nPedido: String(ped[0].nPedido), data: ped[0].d };
          const its = await q(`SELECT Codigobarra cod, SUM(Qtd) cx FROM central.conferencia_televendas WHERE nLoja=10 AND nPedido=? GROUP BY Codigobarra`, [p.expedicao.nPedido]);
          for (const i of p.itens) { const x = its.find(y => String(y.cod) === i.codigoCD); i.separadas = x ? num(x.cx) : 0; }
          if (p.status === 'aberto') { p.status = 'separado'; r.separados++; }
        }
      }
      const unids = p.itens.map(i => i.unidade);
      const notas = unids.length ? await q(`SELECT cp.CodigoBarra cod, SUM(cp.Qtd) cx, c.nNota, DATE_FORMAT(c.DataRecto,'%Y-%m-%d') d
        FROM central.compras c JOIN central.compraprodutos cp ON cp.nCompra=c.nCompra AND cp.nLoja=c.nLoja
        WHERE c.nLoja=? AND c.CodFornec=? AND c.Movimentacao='COMPRA' AND c.DataRecto>=? AND c.DataRecto<=DATE_ADD(?, INTERVAL 30 DAY) AND cp.CodigoBarra IN (${unids.map(() => '?').join(',')})
        GROUP BY cp.CodigoBarra, c.nNota, c.DataRecto`, [p.loja, config.fornecedorCD, desde, desde, ...unids]) : [];
      if (notas.length) {
        const porCod = {}; const nn = new Map();
        for (const n of notas) { porCod[String(n.cod)] = (porCod[String(n.cod)] || 0) + num(n.cx); nn.set(String(n.nNota), n.d); }
        for (const i of p.itens) i.recebidas = porCod[i.unidade] || 0;
        p.recebimento = { notas: [...nn].map(([nNota, data]) => ({ nNota, data })), verificadoEm: agora() };
        const st = u.statusRecebimento(p.itens);
        if (st !== 'aberto') { if (p.status !== st) r.recebidos++; p.status = st; }
      }
      salvarPedido(p);
    } catch (e) { console.error('[PEDIDOS-CD] verificar pedido', p.id, e.message); }
  }
  return r;
}
```

Exportar também: `criarPedidos, listarPedidos, obterPedido, cancelarPedido, verificar, _setBaseParaTeste`.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/`
Expected: todos passando.

- [ ] **Step 5: Commit**

```bash
git add lib/pedidos-cd.js test/pedidos-cd-pedidos.test.js
git commit -m "Pedidos do CD: pedidos por loja em JSON, cancelar e verificação (separado no CD / chegou na loja)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `server.js` — remover o CD antigo e criar as rotas novas

**Files:**
- Modify: `server.js` — apagar o bloco "MÓDULO COMPRAS — CENTRO DE DISTRIBUIÇÃO" (da linha `// ═══` em 4255 até a linha 4527, logo antes do `// ═══` do "PAINEL TV — CD"); acrescentar rotas após o bloco `pedidosFornec` (após a linha 6346 `setInterval(... verificarRecebimentos ...)`).
- Delete: `public/centro-distribuicao.html` (é reescrita na Task 7; apagar aqui pra não sobrar tela chamando rota morta).

**Interfaces:**
- Consumes: `lib/pedidos-cd.js` (Tasks 3–5).
- Produces rotas: `GET /api/pedidos-cd?refresh=1&teto=`, `GET /api/pedidos-cd/vinculos`, `POST /api/pedidos-cd/vinculos`, `DELETE /api/pedidos-cd/vinculos/:codigoCD`, `GET /api/pedidos-cd/buscar-unidade?q=`, `GET /api/pedidos-cd/pedidos`, `POST /api/pedidos-cd/pedidos`, `GET /api/pedidos-cd/pedidos/:id`, `POST /api/pedidos-cd/pedidos/:id/cancelar`, `POST /api/pedidos-cd/verificar`, `GET/POST /api/pedidos-cd/config`.

- [ ] **Step 1: Apagar o bloco antigo**

Confirmar as bordas antes de apagar:

Run: `sed -n 4255,4257p server.js; sed -n 4526,4530p server.js`
Expected: começa com `// ═══` + `// MÓDULO COMPRAS — CENTRO DE DISTRIBUIÇÃO (loja 10)`; termina com `});` na 4527 e `// ═══` + `// PAINEL TV — CD` a partir da 4528.

Run: `sed -i '4255,4527d' server.js && grep -n "LOJAS_CD_NOMES\|carregarCdPedidoOverrides\|centro-distribuicao" server.js`
Expected: nenhuma ocorrência (se sobrar, apagar a linha).

Run: `git rm -q public/centro-distribuicao.html`

- [ ] **Step 2: Acrescentar as rotas**

Logo depois da linha `setInterval(() => pedidosFornec.verificarRecebimentos()...` inserir:

```js
// ═══════════════════════════════════════════════════
// PEDIDOS DO CD — Gestão de Compras > Centro Distribuição
// Vínculo caixa↔unidade, sugestão semanal em caixas (regras do Radar) e
// acompanhamento do pedido loja→CD. Regras em lib/pedidos-cd.js. ERP só leitura;
// estado em data/cd-vinculos.json e data/pedidos-cd/.
// ═══════════════════════════════════════════════════
const pedidosCD = require('./lib/pedidos-cd');
pedidosCD.init({ q, mesDB });
pedidosCD.agendar();
setTimeout(() => pedidosCD.verificar().catch(e => console.error('[PEDIDOS-CD] verificar:', e.message)), 150 * 1000);
setInterval(() => pedidosCD.verificar().catch(e => console.error('[PEDIDOS-CD] verificar:', e.message)), 30 * 60 * 1000);

app.get('/api/pedidos-cd', async (req, res) => {
  try {
    if (req.query.refresh === '1') await pedidosCD.recalcular();
    const teto = req.query.teto ? Math.max(3, Math.min(90, parseFloat(req.query.teto))) : null;
    res.json(pedidosCD.sugestao(teto));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/pedidos-cd/vinculos', (req, res) => res.json({ vinculos: pedidosCD.getVinculos(), estado: pedidosCD.getEstado() }));
app.post('/api/pedidos-cd/vinculos', (req, res) => {
  try { res.json(pedidosCD.salvarVinculo({ ...req.body, usuario: req.session.user?.nome || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/pedidos-cd/vinculos/:codigoCD', (req, res) => {
  const v = pedidosCD.removerVinculo(req.params.codigoCD);
  if (!v) return res.status(404).json({ error: 'vínculo não encontrado' });
  res.json(v);
});
app.get('/api/pedidos-cd/buscar-unidade', async (req, res) => {
  try { res.json(await pedidosCD.buscarUnidade(req.query.q)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/pedidos-cd/pedidos', (req, res) => res.json(pedidosCD.listarPedidos()));
app.post('/api/pedidos-cd/pedidos', (req, res) => {
  try { res.json(pedidosCD.criarPedidos({ lojas: req.body?.lojas || {}, usuario: req.session.user?.nome || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/pedidos-cd/pedidos/:id', (req, res) => {
  const p = pedidosCD.obterPedido(req.params.id);
  if (!p) return res.status(404).json({ error: 'pedido não encontrado' });
  res.json(p);
});
app.post('/api/pedidos-cd/pedidos/:id/cancelar', (req, res) => {
  try { res.json(pedidosCD.cancelarPedido(req.params.id, req.session.user?.nome || null)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/pedidos-cd/verificar', async (req, res) => {
  try { res.json(await pedidosCD.verificar()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/pedidos-cd/config', (req, res) => res.json(pedidosCD.getConfig()));
app.post('/api/pedidos-cd/config', (req, res) => {
  try { res.json(pedidosCD.salvarConfig(req.body || {})); } catch (err) { res.status(400).json({ error: err.message }); }
});
```

- [ ] **Step 3: Verificar sintaxe e subir local sem ERP**

Run: `node --check server.js && node --test test/`
Expected: sem erro de sintaxe; testes passando.

Run (smoke, mata em 5 s): `timeout 8 node server.js; echo exit=$?`
Expected: log `✓ Dashboard rodando em http://localhost:3003` sem stack trace de `require`. (Erros de conexão MySQL são esperados fora da rede.)

- [ ] **Step 4: Commit**

```bash
git add server.js public/centro-distribuicao.html
git commit -m "Centro Distribuição: remove cálculo antigo por giro e cria rotas /api/pedidos-cd

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Página `public/centro-distribuicao.html` (4 abas)

**Files:**
- Create: `public/centro-distribuicao.html`
- Reference: `public/radar-pedidos.html:1-80` (CSS base a copiar), `public/pedidos-compra.html` (cards de status).

**Interfaces:**
- Consumes: rotas da Task 6. Item da sugestão e pedido no formato das Tasks 4–5.

- [ ] **Step 1: Estrutura + CSS**

Criar o arquivo com o `<head>` idêntico ao do Radar (mesmo `<link design-system.css>`, `nav.js`, título `Centro de Distribuição — Econômico Relatórios`) e copiar o bloco `<style>` das linhas 9–80 de `radar-pedidos.html`. Acrescentar:

```css
input.cx{width:56px;text-align:center;border:1px solid #C9C9C4;border-radius:6px;padding:4px;font-weight:700;font-family:inherit}
input.cx.edit{border-color:#F5B800;background:#FFF6D9}
tr.insuf td.lc{border-left:3px solid #C22F49}
tr.zera td.lc{border-left:3px solid #E5AC00}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:14px}
.card{background:#fff;border:1px solid #DADAD6;border-radius:10px;padding:10px 12px;cursor:pointer}.card.on{border-color:#F5B800;background:#FFF6D9}
.card .v{font-size:18px;font-weight:800}.card .l{font-size:9.5px;text-transform:uppercase;color:#98A0B3;font-weight:700}
.barra{position:sticky;bottom:0;background:#101B33;color:#fff;padding:10px 16px;border-radius:10px;display:flex;gap:12px;align-items:center;justify-content:flex-end;margin-top:8px}
.overlay{position:fixed;inset:0;background:rgba(14,22,38,.55);display:none;align-items:center;justify-content:center;z-index:50}.overlay.on{display:flex}
.modal{background:#fff;border-radius:12px;max-width:900px;width:94vw;max-height:90vh;overflow:auto;padding:18px}
.busca-un{position:relative}.busca-un ul{position:absolute;z-index:5;background:#fff;border:1px solid #DADAD6;border-radius:8px;list-style:none;max-height:260px;overflow:auto;width:100%}.busca-un li{padding:6px 10px;cursor:pointer;font-size:12px}.busca-un li:hover{background:#FFF6D9}
```

Body:

```html
<div class="main">
  <div class="page-hdr">
    <div><h1>Centro de Distribuição</h1><p>Pedido semanal das lojas ao CD em caixas, com as regras do Radar. Vínculo caixa↔unidade, acompanhamento até chegar na loja. Nada é gravado no ERP.</p></div>
    <div class="estado" id="estado"></div>
  </div>
  <div class="tabs">
    <button class="tab on" data-tab="pedido">Pedido da semana <span class="n" id="n-pedido">–</span></button>
    <button class="tab" data-tab="vinculos">Vínculos <span class="n" id="n-vinc">–</span></button>
    <button class="tab" data-tab="pedidos">Pedidos <span class="n" id="n-peds">–</span></button>
    <button class="tab" data-tab="regras">Regras</button>
  </div>
  <section id="tab-pedido"></section>
  <section id="tab-vinculos" hidden></section>
  <section id="tab-pedidos" hidden></section>
  <section id="tab-regras" hidden></section>
</div>
<div class="overlay" id="ov"><div class="modal" id="ov-body"></div></div>
```

- [ ] **Step 2: JS — carga, estado e aba "Pedido da semana"**

```js
<script>
const $ = s => document.querySelector(s);
const fmtN = (v, d = 0) => (v == null ? '–' : (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtR = v => 'R$ ' + fmtN(v, 2);
const LOJAS = [1, 2, 3, 4, 5, 6];
let DADOS = null, EDITS = {}, SEL = new Set(), FILTRO = '', PEDIDOS = [], VINC = {}, VF = 'pendentes';

document.querySelectorAll('.tab').forEach(b => b.onclick = () => { document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b)); ['pedido', 'vinculos', 'pedidos', 'regras'].forEach(t => $('#tab-' + t).hidden = t !== b.dataset.tab); });

async function api(url, opt) { const r = await fetch(url, opt); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; }

async function carregar(refresh) {
  $('#estado').innerHTML = refresh ? '<span class="calc">recalculando…</span>' : 'carregando…';
  try { DADOS = await api('/api/pedidos-cd' + (refresh ? '?refresh=1' : '')); } catch (e) { $('#estado').innerHTML = '<span class="neg">' + e.message + '</span>'; return; }
  const es = DADOS.estado;
  $('#estado').innerHTML = es.status === 'calculando' || !es.atualizadoEm ? '<span class="calc">calculando… (até 1 min)</span>' : `dados de <b>${new Date(es.atualizadoEm).toLocaleString('pt-BR')}</b>${es.erro ? ' · <span class="neg">ERP indisponível: ' + es.erro + '</span>' : ''} · <b>${es.produtosCD}</b> produtos no CD`;
  if (!es.atualizadoEm) setTimeout(() => carregar(false), 15000);
  renderPedido(); renderRegras();
}
function cxDe(item, ln) { const k = item.codigoCD + '|' + ln; return k in EDITS ? EDITS[k] : item.lojas[ln].cx; }
function linha(item) {
  const tot = LOJAS.reduce((a, ln) => a + cxDe(item, ln), 0);
  const cls = item.cdInsuficiente ? 'insuf' : (LOJAS.some(ln => item.lojas[ln].zeraAntes) ? 'zera' : '');
  return `<tr class="${cls}" data-cod="${item.codigoCD}">
    <td class="c"><input type="checkbox" ${SEL.has(item.codigoCD) ? 'checked' : ''} onchange="toggleSel('${item.codigoCD}',this.checked)"></td>
    <td class="lc"><div class="nm">${item.descricaoCD}</div><div class="sub">${item.unidade ? item.unidade + ' · ' + (item.descricaoUn || '') : '<span class="neg">sem vínculo</span>'}${item.cdInsuficiente ? ' · <span class="neg">CD insuficiente: faltam ' + item.faltaCx + ' cx</span>' : ''}</div></td>
    <td class="r">${fmtN(item.estoqueCDcx)}</td><td class="c">${item.unPorCaixa || '–'}</td>
    <td class="r">${fmtN(item.vqTotal, 1)}</td><td class="r">${item.coberturaTotal == null ? '–' : fmtN(item.coberturaTotal, 1)}</td>
    ${LOJAS.map(ln => { const L = item.lojas[ln]; const k = item.codigoCD + '|' + ln; return `<td class="c" title="venda ${fmtN(L.vq, 1)}/d · est ${fmtN(L.est)} · trânsito ${fmtN(L.transito)} · cob ${L.cobertura == null ? '–' : fmtN(L.cobertura, 1)} d"><input class="cx ${k in EDITS ? 'edit' : ''}" type="number" min="0" value="${cxDe(item, ln)}" onchange="editar('${item.codigoCD}',${ln},this.value)">${L.zeraAntes ? '<div class="s2 neg">zera</div>' : ''}</td>`; }).join('')}
    <td class="r"><b>${fmtN(tot)}</b></td><td class="r">${fmtR(tot * (item.unPorCaixa || 0) * item.custoUn)}</td></tr>`;
}
function tabela(titulo, itens, id) {
  const f = FILTRO.toLowerCase(); const vis = itens.filter(i => !f || (i.descricaoCD + ' ' + (i.descricaoUn || '') + ' ' + i.codigoCD + ' ' + (i.unidade || '')).toLowerCase().includes(f));
  return `<h3 style="font-size:13px;margin:14px 0 6px">${titulo} <span class="mut">(${vis.length})</span></h3>
  <div class="table-wrap"><table class="main-t"><thead><tr><th class="c"><input type="checkbox" onchange="selTodos('${id}',this.checked)"></th><th>Produto</th><th class="r">Est. CD (cx)</th><th class="c">Un/cx</th><th class="r">Venda un/d</th><th class="r">Cob. (d)</th>${LOJAS.map(ln => `<th class="c">L${ln}</th>`).join('')}<th class="r">Total cx</th><th class="r">Custo</th></tr></thead>
  <tbody>${vis.map(linha).join('') || '<tr><td colspan="15" class="mut">nada aqui</td></tr>'}</tbody></table></div>`;
}
function renderPedido() {
  if (!DADOS || !DADOS.resumo) { $('#tab-pedido').innerHTML = '<p class="mut">calculando…</p>'; return; }
  const r = DADOS.resumo; $('#n-pedido').textContent = r.repor + r.novos;
  $('#tab-pedido').innerHTML = `
    <div class="totais">
      <div class="tkpi"><div class="v">${r.proximaSegunda.split('-').reverse().join('/')}</div><div class="l">próxima segunda</div></div>
      <div class="tkpi"><div class="v">${r.repor}</div><div class="l">produtos a repor</div></div>
      <div class="tkpi"><div class="v amb">${r.novos}</div><div class="l">novos no CD</div></div>
      <div class="tkpi"><div class="v ${r.cdInsuficiente ? 'neg' : ''}">${r.cdInsuficiente}</div><div class="l">CD insuficiente</div></div>
      <div class="tkpi"><div class="v">${fmtN(r.caixas)}</div><div class="l">caixas sugeridas</div></div>
      <div class="tkpi"><div class="v">${fmtR(r.custo)}</div><div class="l">custo</div></div>
    </div>
    <div class="busca-row"><input placeholder="buscar produto ou código" value="${FILTRO}" oninput="FILTRO=this.value;renderPedido()"><button class="btn btn-slate" onclick="carregar(true)">Recalcular</button><span class="contagem">${Object.keys(EDITS).length ? Object.keys(EDITS).length + ' quantidades editadas' : ''}</span></div>
    ${tabela('Repor', DADOS.repor, 'repor')}${tabela('Novos no CD (1 cx por loja)', DADOS.novos, 'novos')}
    <div class="barra"><span>${SEL.size} produto(s) selecionado(s)</span><button class="btn btn-slate" onclick="SEL.clear();renderPedido()">Limpar</button><button class="btn btn-amber" ${SEL.size ? '' : 'disabled'} onclick="fecharPedido()">Fechar pedido</button></div>`;
}
function toggleSel(cod, on) { on ? SEL.add(cod) : SEL.delete(cod); renderPedido(); }
function selTodos(id, on) { for (const i of DADOS[id]) on ? SEL.add(i.codigoCD) : SEL.delete(i.codigoCD); renderPedido(); }
function editar(cod, ln, v) { EDITS[cod + '|' + ln] = Math.max(0, Math.round(+v || 0)); renderPedido(); }
async function fecharPedido() {
  const itens = DADOS.repor.concat(DADOS.novos).filter(i => SEL.has(i.codigoCD));
  if (itens.some(i => i.semVinculo)) return alert('Há produto sem vínculo confirmado na seleção. Vincule na aba Vínculos antes de fechar.');
  const lojas = {}; for (const ln of LOJAS) { const l = itens.map(i => ({ codigoCD: i.codigoCD, caixas: cxDe(i, ln) })).filter(x => x.caixas > 0); if (l.length) lojas[ln] = l; }
  const n = Object.keys(lojas).length; if (!n) return alert('Nenhuma caixa nas lojas selecionadas.');
  if (!confirm(`Gerar pedidos pra ${n} loja(s)?`)) return;
  try { const ps = await api('/api/pedidos-cd/pedidos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lojas }) });
    SEL.clear(); EDITS = {}; await carregarPedidos(); document.querySelector('[data-tab=pedidos]').click(); alert(ps.length + ' pedido(s) criado(s).'); carregar(false);
  } catch (e) { alert(e.message); }
}
```

- [ ] **Step 3: JS — aba Vínculos**

```js
async function carregarVinculos() { const r = await api('/api/pedidos-cd/vinculos'); VINC = r.vinculos; renderVinculos(); }
function renderVinculos() {
  const all = Object.values(VINC); const cont = { pendentes: all.filter(v => v.status === 'pendente').length, sugeridos: all.filter(v => v.status === 'sugerido').length, confirmados: all.filter(v => v.status === 'confirmado').length, todos: all.length };
  $('#n-vinc').textContent = cont.pendentes + cont.sugeridos;
  const cd = DADOS?.repor.concat(DADOS.novos).reduce((m, i) => (m[i.codigoCD] = i, m), {}) || {};
  const vis = all.filter(v => VF === 'todos' || v.status === VF.replace(/s$/, '')).sort((a, b) => (cd[a.codigoCD]?.descricaoCD || '').localeCompare(cd[b.codigoCD]?.descricaoCD || ''));
  $('#tab-vinculos').innerHTML = `<div class="cards">${['pendentes', 'sugeridos', 'confirmados', 'todos'].map(k => `<div class="card ${VF === k ? 'on' : ''}" onclick="VF='${k}';renderVinculos()"><div class="v">${cont[k]}</div><div class="l">${k}</div></div>`).join('')}</div>
  <div class="table-wrap"><table class="main-t"><thead><tr><th>Código CD</th><th>Descrição CD</th><th class="r">Est. CD</th><th class="c">Un/cx</th><th>Unidade vinculada</th><th>Origem</th><th>Ação</th></tr></thead><tbody>
  ${vis.map(v => { const i = cd[v.codigoCD] || {}; const upc = v.unPorCaixa || v.unPorCaixaCadastro || ''; return `<tr>
    <td>${v.codigoCD}</td><td class="lc">${i.descricaoCD || ''}</td><td class="r">${fmtN(i.estoqueCDcx)}</td>
    <td class="c"><input class="cx" id="upc-${v.codigoCD}" type="number" min="1" value="${upc}" ${v.origem === 'igual' ? 'disabled' : ''}></td>
    <td class="lc">${v.status === 'confirmado' ? `<b>${v.unidade}</b><div class="sub">${i.descricaoUn || ''}</div>` : v.candidato ? `<span class="pill p-breve">sugerido</span> ${v.candidato}` : '<span class="pill p-hoje">sem vínculo</span>'}
      <div class="busca-un" id="bu-${v.codigoCD}"><input placeholder="buscar unidade por descrição ou código" oninput="buscarUn('${v.codigoCD}',this.value)"><ul hidden></ul></div></td>
    <td>${v.origem || '–'}${v.confirmadoPor ? '<div class="s2">' + v.confirmadoPor + '</div>' : ''}</td>
    <td>${v.status === 'sugerido' ? `<button class="btn btn-amber" onclick="confirmarVinc('${v.codigoCD}','${v.candidato}')">Confirmar</button>` : ''}${v.status === 'confirmado' && v.origem !== 'igual' ? `<button class="btn btn-slate" onclick="removerVinc('${v.codigoCD}')">Remover</button> <button class="btn btn-slate" onclick="confirmarVinc('${v.codigoCD}','${v.unidade}')">Salvar un/cx</button>` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}
let buscaT = null;
function buscarUn(cod, txt) {
  clearTimeout(buscaT); const ul = $('#bu-' + cod + ' ul'); if (txt.trim().length < 3) { ul.hidden = true; return; }
  buscaT = setTimeout(async () => { const r = await api('/api/pedidos-cd/buscar-unidade?q=' + encodeURIComponent(txt)); ul.innerHTML = r.map(x => `<li onclick="confirmarVinc('${cod}','${x.cod}')">${x.cod} · ${x.descricao}</li>`).join('') || '<li class="mut">nada encontrado</li>'; ul.hidden = false; }, 300);
}
async function confirmarVinc(cod, unidade) {
  const upc = +$('#upc-' + cod).value; if (!(upc >= 1)) return alert('Informe un/cx (mínimo 1).');
  try { await api('/api/pedidos-cd/vinculos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigoCD: cod, unidade, unPorCaixa: upc }) }); await carregarVinculos(); carregar(true); } catch (e) { alert(e.message); }
}
async function removerVinc(cod) { if (!confirm('Remover o vínculo?')) return; await api('/api/pedidos-cd/vinculos/' + cod, { method: 'DELETE' }); await carregarVinculos(); carregar(true); }
```

- [ ] **Step 4: JS — aba Pedidos e Regras + boot**

```js
let PF = 'todos';
async function carregarPedidos() { PEDIDOS = await api('/api/pedidos-cd/pedidos'); renderPedidos(); }
const ST = { aberto: ['Aberto', 'p-breve'], separado: ['Separado no CD', 'p-flag'], recebido: ['Chegou na loja', 'p-ok'], recebido_parcial: ['Chegou parcial', 'p-hoje'], cancelado: ['Cancelado', 'p-cinza'] };
function renderPedidos() {
  const cont = { todos: PEDIDOS.length }; for (const k of Object.keys(ST)) cont[k] = PEDIDOS.filter(p => p.status === k).length;
  $('#n-peds').textContent = cont.aberto + cont.separado;
  const vis = PEDIDOS.filter(p => PF === 'todos' || p.status === PF);
  $('#tab-pedidos').innerHTML = `<div class="cards">${['todos', ...Object.keys(ST)].map(k => `<div class="card ${PF === k ? 'on' : ''}" onclick="PF='${k}';renderPedidos()"><div class="v">${cont[k]}</div><div class="l">${k === 'todos' ? 'todos' : ST[k][0]}</div></div>`).join('')}</div>
  <div class="busca-row"><button class="btn btn-slate" onclick="verificar()">Verificar agora</button></div>
  <div class="table-wrap"><table class="main-t"><thead><tr><th>#</th><th>Loja</th><th>Criado</th><th class="r">Itens</th><th class="r">Caixas</th><th class="r">Custo</th><th>Andamento</th><th>Ação</th></tr></thead><tbody>
  ${vis.map(p => `<tr class="lst" onclick="abrirPedido(${p.id})"><td>${p.id}</td><td><b>L${p.loja}</b> ${p.lojaNome}</td><td>${new Date(p.criadoEm).toLocaleString('pt-BR')}<div class="s2">${p.criadoPor || ''}</div></td><td class="r">${p.itens.length}</td><td class="r">${fmtN(p.totais.caixas)}</td><td class="r">${fmtR(p.totais.custo)}</td>
    <td><span class="pill ${ST[p.status][1]}">${ST[p.status][0]}</span>${p.expedicao ? '<div class="s2">CD pedido ' + p.expedicao.nPedido + ' · ' + p.expedicao.data.split('-').reverse().join('/') + '</div>' : ''}${p.recebimento ? '<div class="s2">nota(s) ' + p.recebimento.notas.map(n => n.nNota).join(', ') + '</div>' : ''}</td>
    <td onclick="event.stopPropagation()">${['aberto', 'separado', 'recebido_parcial'].includes(p.status) ? `<button class="btn btn-slate" onclick="cancelar(${p.id})">Cancelar</button>` : ''} <button class="btn btn-slate" onclick="imprimir(${p.id})">Imprimir</button></td></tr>`).join('') || '<tr><td colspan="8" class="mut">nenhum pedido</td></tr>'}
  </tbody></table></div>`;
}
function abrirPedido(id) {
  const p = PEDIDOS.find(x => x.id === id); if (!p) return;
  $('#ov-body').innerHTML = `<h2 style="font-size:16px">Pedido #${p.id} · L${p.loja} ${p.lojaNome} <span class="pill ${ST[p.status][1]}">${ST[p.status][0]}</span></h2>
  <p class="mut" style="font-size:11px;margin:4px 0 10px">criado ${new Date(p.criadoEm).toLocaleString('pt-BR')} por ${p.criadoPor || '–'}</p>
  <table class="main-t"><thead><tr><th>Produto</th><th class="c">Un/cx</th><th class="r">Pedidas (cx)</th><th class="r">Separadas</th><th class="r">Recebidas</th><th>Situação</th></tr></thead><tbody>
  ${p.itens.map(i => `<tr><td class="lc">${i.descricao}<div class="sub">${i.codigoCD} → ${i.unidade}</div></td><td class="c">${i.unPorCaixa}</td><td class="r">${i.caixas}</td><td class="r">${i.separadas || 0}</td><td class="r">${i.recebidas || 0}</td>
    <td>${!p.recebimento ? '<span class="mut">aguardando</span>' : i.recebidas >= i.caixas ? '<span class="pos">✓</span>' : i.recebidas > 0 ? `<span class="neg">veio ${i.recebidas} de ${i.caixas} cx</span>` : '<span class="neg">não veio</span>'}</td></tr>`).join('')}
  </tbody></table><div style="text-align:right;margin-top:12px"><button class="btn btn-slate" onclick="$('#ov').classList.remove('on')">Fechar</button></div>`;
  $('#ov').classList.add('on');
}
async function cancelar(id) { if (!confirm('Cancelar o pedido #' + id + '?')) return; try { await api('/api/pedidos-cd/pedidos/' + id + '/cancelar', { method: 'POST' }); await carregarPedidos(); carregar(false); } catch (e) { alert(e.message); } }
async function verificar() { try { const r = await api('/api/pedidos-cd/verificar', { method: 'POST' }); await carregarPedidos(); alert(`Verificados ${r.verificados} · separados ${r.separados} · recebidos ${r.recebidos}`); } catch (e) { alert(e.message); } }
function imprimir(id) {
  const p = PEDIDOS.find(x => x.id === id); const w = window.open('', '_blank');
  w.document.write(`<title>Pedido CD #${p.id} L${p.loja}</title><style>body{font-family:sans-serif;font-size:12px;padding:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 6px}th{background:#eee}</style>
  <h2>Pedido ao CD #${p.id} · Loja ${p.loja} ${p.lojaNome}</h2><p>${new Date(p.criadoEm).toLocaleString('pt-BR')} · ${p.criadoPor || ''} · ${p.itens.length} itens · ${p.totais.caixas} caixas</p>
  <table><tr><th>Código CD</th><th>Produto</th><th>Un/cx</th><th>Caixas</th><th>Unidades</th></tr>${p.itens.map(i => `<tr><td>${i.codigoCD}</td><td>${i.descricao}</td><td>${i.unPorCaixa}</td><td><b>${i.caixas}</b></td><td>${i.unidades}</td></tr>`).join('')}</table>`);
  w.document.close(); w.print();
}
function renderRegras() {
  if (!DADOS?.regras) return; const r = DADOS.regras; const cfg = DADOS.regras;
  $('#tab-regras').innerHTML = `<div class="filtros"><div class="fg"><label>Teto (dias)</label><input type="number" id="cfg-teto" value="${r.teto}" min="3" max="90"></div><div class="fg"><label>Ciclo</label><input value="${r.ciclo} dias (segunda)" disabled></div><div class="fg"><label>Validade</label><input value="60% do cadastro" disabled></div><button class="btn btn-amber" onclick="salvarCfg()">Salvar</button></div>
  <div class="table-wrap"><table class="main-t"><thead><tr><th>Loja</th><th class="r">Lead médio (d)</th><th class="r">Lead máx</th><th class="r">Amostras</th><th class="r">Segurança</th><th class="r">Ponto</th><th class="r">Alvo</th><th class="c">Cliente no painel do CD</th></tr></thead><tbody>
  ${LOJAS.map(ln => { const L = r.lojas[ln]; return `<tr><td><b>L${ln}</b> ${L.nome}</td><td class="r">${L.lead ? L.lead.lead_medio : '<span class="mut">padrão</span>'}</td><td class="r">${L.lead ? L.lead.lead_max : '–'}</td><td class="r">${L.lead ? L.lead.n : 0}</td><td class="r">${L.seg}</td><td class="r">${L.ponto}</td><td class="r">${L.alvoLista}</td><td class="c"><input class="cx" style="width:80px" id="cli-${ln}" data-ln="${ln}"></td></tr>`; }).join('')}
  </tbody></table></div><p class="mut" style="font-size:11px">Lead = dias entre o pedido da loja no painel de expedição do CD e a nota de entrada do fornecedor do CD na loja (6 meses). Alvo = lead + segurança + 7, limitado ao teto. Fornecedor do CD nas notas: <span id="cfg-forn"></span>.</p>`;
  api('/api/pedidos-cd/config').then(c => { for (const ln of LOJAS) $('#cli-' + ln).value = c.clientesLoja[ln] || ''; $('#cfg-forn').textContent = c.fornecedorCD; });
}
async function salvarCfg() {
  const clientesLoja = {}; for (const ln of LOJAS) clientesLoja[ln] = +$('#cli-' + ln).value || 0;
  try { await api('/api/pedidos-cd/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teto: +$('#cfg-teto').value, clientesLoja }) }); carregar(true); } catch (e) { alert(e.message); }
}
carregar(false); carregarVinculos(); carregarPedidos();
</script>
```

- [ ] **Step 5: Conferir visual sem ERP**

Run: `node server.js` em segundo plano local e abrir `http://localhost:3003/centro-distribuicao.html` (login local). Esperado: cabeçalho, 4 abas, "calculando…" na primeira, aba Regras vazia até haver dados, sem erro no console do navegador. (Sem ERP, os dados ficam vazios; o teste real é a Task 8.)

- [ ] **Step 6: Commit**

```bash
git add public/centro-distribuicao.html
git commit -m "Centro Distribuição: tela nova com Pedido da semana, Vínculos, Pedidos e Regras

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Teste de integração no .254 e checklist de deploy

**Files:**
- Nenhum no repo (script temporário em `C:\fc360\tmp\pcd-teste.js` no .254).

- [ ] **Step 1: Copiar os libs pro .254 e rodar a coleta real**

Do local (Git Bash), com o repo commitado:

```bash
scp -i ~/.ssh/claude_254 lib/radar-pedidos.js lib/pedidos-cd.js lib/pedidos-cd-util.js claude-ssh@192.168.2.254:C:/fc360/tmp/
```

Script `pcd-teste.js` (enviar via `scp` também):

```js
const m = require('C:/fc360/claude_code_/node_modules/mysql2/promise');
const cd = require('C:/fc360/tmp/pedidos-cd.js');
(async () => {
  const c = await m.createConnection({ host: '192.168.2.252', user: 'root', password: '1900' });
  const q = async (s, p = []) => { const [r] = await c.query(s, p); return r; };
  const mesDB = mes => String(mes).padStart(2, '0');
  cd.init({ q, mesDB, dataDir: 'C:/fc360/tmp/pcd-data' });
  const t0 = Date.now(); await cd.recalcular(); console.log('estado', cd.getEstado(), (Date.now() - t0) + 'ms');
  const v = Object.values(cd.getVinculos());
  console.log('vinculos', { total: v.length, igual: v.filter(x => x.origem === 'igual').length, sugeridos: v.filter(x => x.status === 'sugerido').length, pendentes: v.filter(x => x.status === 'pendente').length });
  for (const x of v.filter(x => x.status === 'sugerido').slice(0, 20)) cd.salvarVinculo({ codigoCD: x.codigoCD, unidade: x.candidato, unPorCaixa: x.unPorCaixa || x.unPorCaixaCadastro, usuario: 'teste' });
  await cd.recalcular();
  const s = cd.sugestao();
  console.log('resumo', s.resumo); console.log('regras', JSON.stringify(s.regras.lojas));
  console.log('repor[0..3]', JSON.stringify(s.repor.slice(0, 3), null, 1));
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
```

Run: `ssh -i ~/.ssh/claude_254 claude-ssh@192.168.2.254 "node C:/fc360/tmp/pcd-teste.js"`
Expected: `vinculos { total: 187, igual: 71, sugeridos: 87, pendentes: 29 }` (aprox.: 68 de 13 dígitos + 3 curtos = 71 "igual"), regras com lead calculado em pelo menos 4 lojas, `repor` com caixas por loja e `totalCx ≤ estoqueCDcx` em todos. Se `sugeridos` divergir muito de 87, investigar `coletarCD` antes de seguir. Apagar `C:/fc360/tmp/pcd-data` ao fim (`rmdir /s /q`).

- [ ] **Step 2: Rodar o conjunto de testes e o check final**

Run: `node --test test/ && node --check server.js && git status --short`
Expected: todos passando, árvore limpa.

- [ ] **Step 3: Entregar ao Tiago (não fazer push sem ele pedir)**

Mensagem de entrega deve conter: (1) `git push origin main` + deploy pelo webhook `https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026` (ou `git reset --hard origin/main` via SSH e ele reinicia o serviço da porta 3003); (2) primeiro acesso: abrir Centro Distribuição, aguardar ~1 min, confirmar os 87 sugeridos na aba Vínculos (um a um, conferindo un/cx), vincular os 29 pendentes; (3) conferir na aba Regras se os códigos de cliente das lojas batem (828, 899, 1300, 1421, 1684, 1969); (4) fechar 1 pedido de teste de uma loja e cancelar.

- [ ] **Step 4: Memória**

Atualizar `C:\Users\tiago\.claude\projects\C--Users-tiago\memory\`: criar `project_economico-pedidos-cd.md` (o que foi construído, fontes do ERP, 87/29 vínculos, códigos de cliente das lojas, pendências) e adicionar a linha no `MEMORY.md`; marcar na memória `project_economico-radar-pedidos.md` que `paramsLista/alvoProduto/qtdPedido` agora são exportadas e usadas pelo CD.

---

## Self-review

- **Cobertura do spec:** menu/limpeza (T6), vínculos igual/dun14/manual + busca + un/cx (T3, T7), cálculo com regras do Radar, trânsito, CD insuficiente, novos 1 cx/loja (T4), pedidos 1 por loja, status, verificação por painel do CD e nota 2157, cancelar, imprimir (T5, T7), Regras com lead por loja, teto, clientes editáveis (T4, T6, T7), recálculo 90 s + 05:30 (T4), verificação 2,5 min + 30 min (T6), erros (estado.erro na tela, 400 nos POSTs), testes unitários + integração no .254 (T1–T5, T8). "Regras: fornecedor 2157 editável" → exposto em `salvarConfig` e mostrado na tela; edição via API apenas (a tela mostra o número). Aceitável.
- **Placeholders:** nenhum "TBD"; todo passo com código.
- **Consistência de nomes:** `sincronizarVinculos/salvarVinculo/removerVinculo/buscarUnidade/getVinculos` (T3) usados em T4/T6/T7; `calcularSugestao/sugestao/recalcular/getEstado/agendar` (T4) em T6/T7; `criarPedidos/listarPedidos/obterPedido/cancelarPedido/verificar/_setBaseParaTeste` (T5) em T4 (transitoPedidos), T6, T7; formato `lojas[ln].cx/un/vq/est/transito/cobertura/zeraAntes` igual em T4 e T7; `embFixa` em T1 e T4.
