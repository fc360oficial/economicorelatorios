# Sugestão Manual (Consolidação da Lista) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduzir no Econômico Relatórios a tela "Consolidação da Lista" do Dlinks: calcular a sugestão por loja com a conta do Dlinks, deixar a compradora digitar a quantidade, gravar no nosso lado e gerar o pedido em Pedidos de Compra — sem escrever nada no ERP.

**Architecture:** Novo módulo `lib/sugestao-manual.js` (conta pura + persistência JSON em `data/sugestoes-manuais/` + montagem a partir do ERP), rotas `/api/sugestao-manual*` em `server.js`, e uma nova view `#consolidacao-view` em `public/sugestao-compras.html`. O Monitor existente passa a misturar sugestões do Dlinks (`D-N`, só leitura no ERP) e do Fluxo (`F-N`, nossas). Gerar Pedido reaproveita `POST /api/pedidos-fornecedor` com `substituir:true`.

**Tech Stack:** Node.js (Express, mysql2 via `q()`), `node:test`, HTML/JS vanilla com `design-system.css`.

**Spec:** `docs/superpowers/specs/2026-09-15-sugestao-manual-consolidacao-design.md`

## Global Constraints

- **NUNCA escrever no MySQL do ERP (`central.*`, `ln{loja}mesNN.*`)** — só `SELECT`. Nenhuma rota nova faz INSERT/UPDATE/DELETE no ERP.
- Persistência nossa: um JSON por sugestão em `data/sugestoes-manuais/` (mesmo padrão de `lib/pedidos-fornecedor.js`).
- Ids: `F-1`, `F-2`… (Fluxo, contador em `data/sugestoes-manuais/_seq.json`) e `D-<nConsolidado>` (ajustes numa sugestão do Dlinks).
- Fórmula: `SugestãoSistema = max(0, round(Cobertura × MédiaPeríodo − Estoque − Trânsito))`, `MédiaPeríodo = QtdVenda ÷ dias` (dias corridos, ou dias com venda quando `obs.dias_com_venda`), `Estoque = 0` quando `obs.sem_estoque`, `Trânsito = 0` quando `!obs.transito`.
- Testes: `node --test test/` (padrão do repo: `node:test` + `node:assert/strict`).
- Commits: mensagem em português no estilo do repo (`Sugestão Manual: ...`), terminando com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Deploy só quando o Tiago pedir (`git push origin main` + `GET https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026`).

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/sugestao-manual.js` (novo) | `calcularLoja()` (conta pura), `repartirPorLoja()` (pura), persistência (`proximoId/salvar/obter/listar`), `montarDoERP()` (lê `lista_consolidado_*` pra `D-N`), `calcularNova()` (lê venda/estoque/custo/preço do ERP e monta `F-N`) |
| `test/sugestao-manual.test.js` (novo) | testes das funções puras |
| `server.js` | rotas `/api/sugestao-manual*`; `GET /api/sugestoes-compra` passa a incluir as do Fluxo; `POST /api/pedidos-fornecedor` aceita `origem:'sugestao-manual'` |
| `public/sugestao-compras.html` | view `#consolidacao-view` (cabeçalho, grade de itens, detalhe por loja, barra de baixo), modal Nova Sugestão passa a criar `F-N`, Monitor com selo de origem e Desativar real pras do Fluxo |

---

### Task 1: Conta pura `calcularLoja` + `repartirPorLoja` (TDD)

**Files:**
- Create: `lib/sugestao-manual.js`
- Test: `test/sugestao-manual.test.js`

**Interfaces:**
- Produces:
  - `calcularLoja({ qtdVenda, diasVenda, dias, estoque, transito, cobertura, obs })` → `{ media, dias_cob, sug_sistema }` onde `media` é número (3 casas), `dias_cob` é número (1 casa) ou `null` quando média = 0, `sug_sistema` inteiro ≥ 0.
  - `repartirPorLoja(total, lojas)` com `lojas = [{ loja, sug_sistema }]` → `{ [loja]: qtd }` só com lojas > 0; proporcional a `sug_sistema`; sem sugestão divide igual; a última loja fecha a conta.

- [ ] **Step 1: Escrever os testes**

```js
// test/sugestao-manual.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../lib/sugestao-manual');

const OBS = { sem_estoque: false, transito: false, dias_com_venda: false };

test('calcularLoja: dias corridos, sem trânsito', () => {
  // venda 30 un em 30 dias → 1/dia; cobertura 20 → 20 − estoque 5 = 15
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 4, cobertura: 20, obs: OBS });
  assert.equal(r.media, 1);
  assert.equal(r.dias_cob, 5);
  assert.equal(r.sug_sistema, 15);           // trânsito ignorado (obs.transito=false)
});

test('calcularLoja: considera trânsito quando obs.transito', () => {
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 4, cobertura: 20, obs: { ...OBS, transito: true } });
  assert.equal(r.sug_sistema, 11);
});

test('calcularLoja: não considerar estoque zera o estoque', () => {
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 0, cobertura: 20, obs: { ...OBS, sem_estoque: true } });
  assert.equal(r.sug_sistema, 20);
  assert.equal(r.dias_cob, 0);
});

test('calcularLoja: dias com venda no lugar de dias corridos', () => {
  // 30 un em 12 dias com venda → 2,5/dia; cobertura 10 → 25 − 5 = 20
  const r = sm.calcularLoja({ qtdVenda: 30, diasVenda: 12, dias: 30, estoque: 5, transito: 0, cobertura: 10, obs: { ...OBS, dias_com_venda: true } });
  assert.equal(r.media, 2.5);
  assert.equal(r.sug_sistema, 20);
});

test('calcularLoja: sem venda → média 0, dias_cob null, sugestão 0', () => {
  const r = sm.calcularLoja({ qtdVenda: 0, diasVenda: 0, dias: 30, estoque: 8, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r.media, 0);
  assert.equal(r.dias_cob, null);
  assert.equal(r.sug_sistema, 0);
});

test('calcularLoja: resultado negativo vira 0 e arredonda', () => {
  const r = sm.calcularLoja({ qtdVenda: 10, diasVenda: 5, dias: 30, estoque: 50, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r.sug_sistema, 0);
  const r2 = sm.calcularLoja({ qtdVenda: 10, diasVenda: 5, dias: 30, estoque: 2, transito: 0, cobertura: 20, obs: OBS });
  assert.equal(r2.sug_sistema, 5);            // 6,667 − 2 = 4,667 → 5
});

test('repartirPorLoja: proporcional à sugestão sistema, última fecha a conta', () => {
  const r = sm.repartirPorLoja(10, [{ loja: 1, sug_sistema: 3 }, { loja: 2, sug_sistema: 6 }, { loja: 3, sug_sistema: 0 }]);
  assert.deepEqual(r, { 1: 3, 2: 7 });        // 3,33→3 ; 6,67→ resto 7 ; loja 3 fica 0 e sai
});

test('repartirPorLoja: sem sugestão sistema divide igual', () => {
  const r = sm.repartirPorLoja(7, [{ loja: 1, sug_sistema: 0 }, { loja: 2, sug_sistema: 0 }, { loja: 3, sug_sistema: 0 }]);
  assert.deepEqual(r, { 1: 2, 2: 2, 3: 3 });
});

test('repartirPorLoja: total 0 ou sem lojas → {}', () => {
  assert.deepEqual(sm.repartirPorLoja(0, [{ loja: 1, sug_sistema: 5 }]), {});
  assert.deepEqual(sm.repartirPorLoja(5, []), {});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/sugestao-manual.test.js`
Expected: FAIL — `Cannot find module '../lib/sugestao-manual'`

- [ ] **Step 3: Implementar o mínimo**

```js
// lib/sugestao-manual.js
// Sugestão Manual — tela "Consolidação da Lista" (espelho do Dlinks, dentro do Fluxo).
//
// Conta por loja igual à do Dlinks (lista_consolidado_historico.QtdSug):
//   MédiaPeríodo    = QtdVenda ÷ dias   (dias corridos; obs.dias_com_venda → dias com venda)
//   DiasCob         = Estoque ÷ MédiaPeríodo
//   SugestãoSistema = max(0, round(Cobertura × MédiaPeríodo − Estoque − Trânsito))
//   obs.sem_estoque → Estoque = 0 ; !obs.transito → Trânsito = 0
//
// Persistência: um JSON por sugestão em data/sugestoes-manuais/ (F-N = criada
// aqui; D-<nConsolidado> = só os ajustes numa sugestão do Dlinks). NADA é
// escrito no ERP.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'sugestoes-manuais');

function calcularLoja({ qtdVenda, diasVenda, dias, estoque, transito, cobertura, obs }) {
  const o = obs || {};
  const div = o.dias_com_venda ? Math.max(1, diasVenda || 0) : Math.max(1, dias || 0);
  const media = (qtdVenda || 0) / div;
  const est = o.sem_estoque ? 0 : (estoque || 0);
  const tr = o.transito ? (transito || 0) : 0;
  const diasCob = media > 0 ? est / media : null;
  const sug = Math.max(0, Math.round((cobertura || 0) * media - est - tr));
  return { media: +media.toFixed(3), dias_cob: diasCob == null ? null : +diasCob.toFixed(1), sug_sistema: sug };
}

// reparte o total do item pelas lojas proporcional à sugestão sistema; sem sugestão divide igual; última fecha a conta
function repartirPorLoja(total, lojas) {
  const T = Math.max(0, Math.round(total || 0));
  if (T <= 0 || !lojas || !lojas.length) return {};
  const soma = lojas.reduce((a, l) => a + (l.sug_sistema || 0), 0);
  const out = {}; let dist = 0;
  lojas.forEach((l, i) => {
    let qv = soma > 0 ? Math.round(T * (l.sug_sistema || 0) / soma) : Math.floor(T / lojas.length);
    if (i === lojas.length - 1) qv = T - dist;
    dist += qv; if (qv > 0) out[l.loja] = qv;
  });
  return out;
}

module.exports = { DIR, calcularLoja, repartirPorLoja };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/sugestao-manual.test.js`
Expected: `# pass 9`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/sugestao-manual.js test/sugestao-manual.test.js
git commit -m "Sugestão Manual: conta por loja igual ao Dlinks e reparte por loja (funções puras + testes)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Persistência (`proximoId`, `salvar`, `obter`, `listar`, `aplicarPatch`)

**Files:**
- Modify: `lib/sugestao-manual.js`
- Test: `test/sugestao-manual.test.js`

**Interfaces:**
- Produces:
  - `init()` cria a pasta.
  - `proximoId()` → `'F-1'`, `'F-2'`… (lê/grava `_seq.json`).
  - `salvar(s)` grava `DIR/<s.id>.json` e devolve `s`.
  - `obter(id)` → objeto ou `null`.
  - `listar()` → só as `F-*`, ordenadas por `criado_em` desc.
  - `aplicarPatch(s, patch)` → aplica `{ quantidades:{cod:{loja:qtd}}, obs:{cod:texto}, ativo:{cod:bool}, status, pedido_id }` num objeto de sugestão (`F` ou `D`) e devolve o objeto; **não grava**.
- Formato `F-N.json`: `{ id, origem:'fluxo', criado_em (ISO), criado_por, lista:{id,nome,fornecedor,cnpj,cod_fornec}, parametros:{data_ini,data_fim,dias,cobertura,lojas:[..],obs:{sem_estoque,transito,dias_com_venda}}, status:'aberta'|'pedido_gerado'|'desativada', pedido_id:null, pm:0, itens:[{codigo,descricao,und,emb,preco_und,obs,ativo,quantidade,lojas:[{loja,ultima_compra,ultima_venda,fornecedor,un,emb,qtd_compra,preco_compra,total_compra,custo,preco_atual,estoque,pmv,qtd_venda,dias_venda,media,dias_cob,sug_sistema,transito,abc,sug_loja}]}] }`
- Formato `D-N.json`: `{ id:'D-4380', origem:'dlinks', quantidades:{cod:{loja:qtd}}, obs:{cod:texto}, inativos:[cod], status, pedido_id, atualizado_em }`

- [ ] **Step 1: Escrever os testes**

Acrescentar em `test/sugestao-manual.test.js`:

```js
const fs = require('fs');
const path = require('path');
const os = require('os');

test('persistência: proximoId sequencial, salvar/obter/listar, D-* fora do listar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugman-'));
  sm._setDir(dir);
  assert.equal(sm.proximoId(), 'F-1');
  assert.equal(sm.proximoId(), 'F-2');
  sm.salvar({ id: 'F-1', origem: 'fluxo', criado_em: '2026-09-15T10:00:00.000Z', itens: [] });
  sm.salvar({ id: 'F-2', origem: 'fluxo', criado_em: '2026-09-15T11:00:00.000Z', itens: [] });
  sm.salvar({ id: 'D-4380', origem: 'dlinks', quantidades: {} });
  assert.equal(sm.obter('F-1').id, 'F-1');
  assert.equal(sm.obter('X-9'), null);
  assert.deepEqual(sm.listar().map(s => s.id), ['F-2', 'F-1']);
});

test('aplicarPatch numa F-N: quantidade por loja, obs, ativo, status', () => {
  const s = { id: 'F-1', origem: 'fluxo', status: 'aberta', pedido_id: null,
    itens: [{ codigo: '789', ativo: true, obs: '', quantidade: 5, lojas: [{ loja: 1, sug_loja: 2 }, { loja: 2, sug_loja: 3 }] }] };
  sm.aplicarPatch(s, { quantidades: { 789: { 1: 4, 2: 0 } }, obs: { 789: 'urgente' }, ativo: { 789: false }, status: 'pedido_gerado', pedido_id: 77 });
  assert.equal(s.itens[0].lojas[0].sug_loja, 4);
  assert.equal(s.itens[0].lojas[1].sug_loja, 0);
  assert.equal(s.itens[0].quantidade, 4);          // soma das lojas
  assert.equal(s.itens[0].obs, 'urgente');
  assert.equal(s.itens[0].ativo, false);
  assert.equal(s.status, 'pedido_gerado');
  assert.equal(s.pedido_id, 77);
});

test('aplicarPatch numa D-N guarda só os ajustes', () => {
  const d = { id: 'D-4380', origem: 'dlinks', quantidades: {}, obs: {}, inativos: [], status: 'aberta', pedido_id: null };
  sm.aplicarPatch(d, { quantidades: { 789: { 3: 9 } }, ativo: { 789: false, 555: true }, obs: { 789: 'x' } });
  assert.deepEqual(d.quantidades, { 789: { 3: 9 } });
  assert.deepEqual(d.inativos, ['789']);
  assert.equal(d.obs['789'], 'x');
  sm.aplicarPatch(d, { ativo: { 789: true } });
  assert.deepEqual(d.inativos, []);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/sugestao-manual.test.js`
Expected: FAIL — `sm._setDir is not a function`

- [ ] **Step 3: Implementar**

Substituir o `module.exports` de `lib/sugestao-manual.js` por:

```js
let dir = DIR;
function _setDir(d) { dir = d; fs.mkdirSync(dir, { recursive: true }); }
function init() { fs.mkdirSync(dir, { recursive: true }); }
const arq = id => path.join(dir, `${id}.json`);
const ID_OK = /^[FD]-\d+$/;

function proximoId() {
  const seqArq = path.join(dir, '_seq.json');
  let n = 0; try { n = JSON.parse(fs.readFileSync(seqArq, 'utf8')).n || 0; } catch (e) {}
  n += 1; fs.writeFileSync(seqArq, JSON.stringify({ n }));
  return `F-${n}`;
}
function salvar(s) { s.atualizado_em = new Date().toISOString(); fs.writeFileSync(arq(s.id), JSON.stringify(s)); return s; }
function obter(id) { if (!ID_OK.test(id || '')) return null; try { return JSON.parse(fs.readFileSync(arq(id), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(dir).filter(f => /^F-\d+\.json$/.test(f)).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
}

// patch = { quantidades:{cod:{loja:qtd}}, obs:{cod:texto}, ativo:{cod:bool}, status, pedido_id }
function aplicarPatch(s, patch) {
  const p = patch || {};
  const qtd = v => Math.max(0, Math.round(parseFloat(v) || 0));
  if (s.origem === 'fluxo') {
    for (const it of s.itens || []) {
      const c = String(it.codigo);
      const qs = p.quantidades && p.quantidades[c];
      if (qs) { for (const l of it.lojas) if (qs[l.loja] != null) l.sug_loja = qtd(qs[l.loja]); it.quantidade = it.lojas.reduce((a, l) => a + (l.sug_loja || 0), 0); }
      if (p.obs && p.obs[c] != null) it.obs = String(p.obs[c]).slice(0, 200);
      if (p.ativo && p.ativo[c] != null) it.ativo = !!p.ativo[c];
    }
  } else {
    s.quantidades = s.quantidades || {}; s.obs = s.obs || {}; s.inativos = s.inativos || [];
    for (const [c, qs] of Object.entries(p.quantidades || {})) { s.quantidades[c] = s.quantidades[c] || {}; for (const [l, v] of Object.entries(qs || {})) s.quantidades[c][l] = qtd(v); }
    for (const [c, t] of Object.entries(p.obs || {})) s.obs[c] = String(t).slice(0, 200);
    for (const [c, a] of Object.entries(p.ativo || {})) { const i = s.inativos.indexOf(String(c)); if (!a && i < 0) s.inativos.push(String(c)); if (a && i >= 0) s.inativos.splice(i, 1); }
  }
  if (['aberta', 'pedido_gerado', 'desativada'].includes(p.status)) s.status = p.status;
  if (p.pedido_id != null) s.pedido_id = p.pedido_id;
  return s;
}

module.exports = { DIR, _setDir, init, proximoId, salvar, obter, listar, aplicarPatch, calcularLoja, repartirPorLoja };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/sugestao-manual.test.js`
Expected: `# pass 12`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/sugestao-manual.js test/sugestao-manual.test.js
git commit -m "Sugestão Manual: persistência em data/sugestoes-manuais (F-N e ajustes D-N) + aplicarPatch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `montarDoERP(nConsolidado)` — sugestão do Dlinks lida do ERP (só SELECT)

**Files:**
- Modify: `lib/sugestao-manual.js`
- Test: `test/sugestao-manual.test.js`

**Interfaces:**
- Consumes: `initERP({ q })` recebe a função `q(sql, params)` do `server.js` (mesmo padrão de `radarPedidos.init`).
- Produces: `async montarDoERP(nConsolidado)` → objeto no **mesmo formato** de `F-N` mas com `id:'D-<n>'`, `origem:'dlinks'`, `status_web`, e com os ajustes de `D-<n>.json` já aplicados (quantidades/obs/inativos/status/pedido_id). Devolve `null` se não existir em `lista_consolidadas`.
- Função pura testável: `montarDeLinhas(cab, itens, hist, ajustes)` — recebe as linhas cruas das 3 tabelas + o JSON de ajustes (ou null) e devolve o objeto.

Mapeamento (tudo varchar com vírgula → `num()`):
- Cabeçalho `lista_consolidadas`: `nConsolidado, nLista, CodFornec, NomeFornec, CNPJ, Data, DataVenda1, DataVenda2, QtdCobertura, StatusWeb, CodDesativado`.
- Itens `lista_consolidado_itens`: `CodigoBarra, Descricao, Unid, QtdEmb, QTotal, Preco, Ql1..Ql10, Obs`.
- Histórico `lista_consolidado_historico`: `nLoja, DataCompra, Fornecedor, Qtd, Emb, Preco, Total, Custo, PVenda, Transito, SaidaMedia, Cobertura, Estoque, QtdVendas, QtdSug, QtdLoja, PMV, CodigoBarra`.
- `sug_loja` = ajuste gravado se houver, senão `Ql{loja}` do item (quantidade digitada no Dlinks), senão `QtdSug`.
- `quantidade` do item = soma de `sug_loja`.
- `dias` = diferença em dias entre `DataVenda1` e `DataVenda2` (formato `dd/mm/aaaa`).
- `abc` = `null` (o Dlinks não grava; a tela mostra "—").
- `dias_venda` = `null` (idem).

- [ ] **Step 1: Escrever o teste da função pura**

```js
test('montarDeLinhas: monta D-N a partir das linhas do ERP e aplica ajustes', () => {
  const cab = { nConsolidado: 4380, nLista: 444, CodFornec: 1335, NomeFornec: 'PARATY ATACADO', CNPJ: '05476815001056', Data: new Date('2026-09-15T03:00:00Z'), DataVenda1: '15/08/2026', DataVenda2: '15/09/2026', QtdCobertura: 40, StatusWeb: 1, CodDesativado: 0 };
  const itens = [{ CodigoBarra: '789', Descricao: 'CAREFREE 15UN', Unid: 'un', QtdEmb: 1, QTotal: '24.000', Preco: '6.890', Ql1: '10.000', Ql2: '14.000', Ql3: '0.000', Obs: 'x' }];
  const hist = [
    { nLoja: 1, CodigoBarra: '789', DataCompra: '18/11/25', Fornecedor: 'PARATY', Qtd: '6', Emb: '1', Preco: '6,89', Total: '41,32', Custo: '7,80', PVenda: '12,49', Transito: '0', SaidaMedia: '0,31', Cobertura: '12', Estoque: '4', QtdVendas: '10', QtdSug: '9', QtdLoja: '10', PMV: '12,49' },
    { nLoja: 2, CodigoBarra: '789', DataCompra: '13/02/26', Fornecedor: 'PARATY', Qtd: '12', Emb: '1', Preco: '6,85', Total: '82,22', Custo: '7,76', PVenda: '12,49', Transito: '0', SaidaMedia: '0', Cobertura: '0', Estoque: '0', QtdVendas: '0', QtdSug: '0', QtdLoja: '14', PMV: '0' },
  ];
  const s = sm.montarDeLinhas(cab, itens, hist, { id: 'D-4380', origem: 'dlinks', quantidades: { 789: { 2: 20 } }, obs: {}, inativos: [], status: 'aberta', pedido_id: null });
  assert.equal(s.id, 'D-4380');
  assert.equal(s.origem, 'dlinks');
  assert.equal(s.lista.id, 444);
  assert.equal(s.lista.cnpj, '05476815001056');
  assert.equal(s.parametros.dias, 31);
  assert.equal(s.parametros.cobertura, 40);
  assert.deepEqual(s.parametros.lojas, [1, 2]);
  assert.equal(s.status_web, 1);
  const it = s.itens[0];
  assert.equal(it.preco_und, 6.89);
  assert.equal(it.lojas[0].sug_sistema, 9);
  assert.equal(it.lojas[0].sug_loja, 10);          // Ql1 do Dlinks
  assert.equal(it.lojas[1].sug_loja, 20);          // ajuste gravado no Fluxo sobrepõe Ql2
  assert.equal(it.quantidade, 30);
  assert.equal(it.lojas[0].estoque, 4);
  assert.equal(it.lojas[0].pmv, 12.49);
  assert.equal(it.lojas[0].dias_cob, 12);
  assert.equal(it.lojas[0].media, 0.31);
  assert.equal(it.lojas[0].abc, null);
});

test('montarDeLinhas: sem ajustes usa Ql, sem Ql usa QtdSug; inativo vem dos ajustes', () => {
  const cab = { nConsolidado: 1, nLista: 2, CodFornec: 3, NomeFornec: 'F', CNPJ: '0', Data: null, DataVenda1: '01/09/2026', DataVenda2: '11/09/2026', QtdCobertura: 10, StatusWeb: 0, CodDesativado: 0 };
  const itens = [{ CodigoBarra: '1', Descricao: 'A', Unid: 'UN', QtdEmb: 12, QTotal: '0.000', Preco: '0.000', Ql1: '0.000', Obs: '0' }];
  const hist = [{ nLoja: 1, CodigoBarra: '1', DataCompra: '0', Fornecedor: '0', Qtd: '0', Emb: '0', Preco: '0', Total: '0', Custo: '0', PVenda: '0', Transito: '0', SaidaMedia: '1', Cobertura: '3', Estoque: '3', QtdVendas: '10', QtdSug: '7', QtdLoja: '0', PMV: '0' }];
  const s = sm.montarDeLinhas(cab, itens, hist, { id: 'D-1', origem: 'dlinks', quantidades: {}, obs: {}, inativos: ['1'], status: 'aberta', pedido_id: null });
  assert.equal(s.itens[0].lojas[0].sug_loja, 7);
  assert.equal(s.itens[0].quantidade, 7);
  assert.equal(s.itens[0].ativo, false);
  assert.equal(s.itens[0].obs, '');                 // '0' do ERP vira vazio
  assert.equal(s.lista.cnpj, null);
  const s2 = sm.montarDeLinhas(cab, itens, hist, null);
  assert.equal(s2.itens[0].ativo, true);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/sugestao-manual.test.js`
Expected: FAIL — `sm.montarDeLinhas is not a function`

- [ ] **Step 3: Implementar**

Acrescentar em `lib/sugestao-manual.js` (antes do `module.exports`) e exportar `initERP, montarDeLinhas, montarDoERP`:

```js
let q = null;
function initERP(deps) { q = deps.q; }

const num = v => { if (v == null) return 0; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? 0 : n; };
const txt = v => (v == null || String(v).trim() === '0') ? '' : String(v).trim();
function diasEntre(d1, d2) {           // 'dd/mm/aaaa' → dias corridos (mínimo 1)
  const p = s => { const [d, m, a] = String(s).split('/').map(Number); return new Date(a, m - 1, d); };
  try { return Math.max(1, Math.round((p(d2) - p(d1)) / 86400000)); } catch (e) { return 1; }
}

// linhas cruas das 3 tabelas + JSON de ajustes (D-N.json ou null) → objeto no formato F-N
function montarDeLinhas(cab, itens, hist, ajustes) {
  const aj = ajustes || { quantidades: {}, obs: {}, inativos: [], status: 'aberta', pedido_id: null };
  const porItem = {};
  for (const h of hist) (porItem[String(h.CodigoBarra)] = porItem[String(h.CodigoBarra)] || []).push(h);
  const lojas = [...new Set(hist.map(h => +h.nLoja))].sort((a, b) => a - b);
  let vlr = 0, qtdV = 0;
  const out = itens.map(it => {
    const c = String(it.CodigoBarra);
    const hs = (porItem[c] || []).sort((a, b) => a.nLoja - b.nLoja);
    const ls = hs.map(h => {
      const ln = +h.nLoja;
      const ajq = aj.quantidades && aj.quantidades[c] && aj.quantidades[c][ln];
      const ql = num(it['Ql' + ln]);
      const sugSis = Math.round(num(h.QtdSug));
      const sugLoja = ajq != null ? ajq : (ql > 0 ? Math.round(ql) : sugSis);
      const media = num(h.SaidaMedia);
      vlr += num(h.PMV) * num(h.QtdVendas); qtdV += num(h.QtdVendas);
      return { loja: ln, ultima_compra: txt(h.DataCompra) || null, ultima_venda: null, fornecedor: txt(h.Fornecedor) || null, un: txt(it.Unid) || null,
        emb: num(h.Emb) || null, qtd_compra: num(h.Qtd), preco_compra: num(h.Preco), total_compra: num(h.Total), custo: num(h.Custo), preco_atual: num(h.PVenda),
        estoque: num(h.Estoque), pmv: num(h.PMV), qtd_venda: num(h.QtdVendas), dias_venda: null, media: +media.toFixed(3),
        dias_cob: media > 0 ? +num(h.Cobertura).toFixed(1) : null, sug_sistema: sugSis, transito: num(h.Transito), abc: null, sug_loja: sugLoja };
    });
    return { codigo: c, descricao: txt(it.Descricao), und: txt(it.Unid), emb: num(it.QtdEmb) || 1, preco_und: +num(it.Preco).toFixed(2),
      obs: (aj.obs && aj.obs[c] != null) ? aj.obs[c] : txt(it.Obs), ativo: !(aj.inativos || []).includes(c),
      quantidade: ls.reduce((a, l) => a + (l.sug_loja || 0), 0), lojas: ls };
  });
  return { id: `D-${cab.nConsolidado}`, origem: 'dlinks', criado_em: cab.Data ? new Date(cab.Data).toISOString() : null, criado_por: null,
    lista: { id: +cab.nLista, nome: txt(cab.NomeFornec), fornecedor: txt(cab.NomeFornec), cnpj: txt(cab.CNPJ) || null, cod_fornec: +cab.CodFornec || null },
    parametros: { data_ini: txt(cab.DataVenda1) || null, data_fim: txt(cab.DataVenda2) || null, dias: diasEntre(cab.DataVenda1, cab.DataVenda2), cobertura: +cab.QtdCobertura || 0, lojas, obs: { sem_estoque: false, transito: true, dias_com_venda: false } },
    status: aj.status || 'aberta', pedido_id: aj.pedido_id || null, status_web: +cab.StatusWeb || 0, desativada_erp: +cab.CodDesativado === 1,
    pm: qtdV > 0 ? +(vlr / qtdV).toFixed(2) : 0, itens: out };
}

async function montarDoERP(nConsolidado) {
  const n = parseInt(nConsolidado); if (!n) return null;
  const [cab] = await q(`SELECT nConsolidado, nLista, CodFornec, NomeFornec, CNPJ, Data, DataVenda1, DataVenda2, QtdCobertura, StatusWeb, CodDesativado FROM central.lista_consolidadas WHERE nConsolidado=?`, [n]);
  if (!cab) return null;
  const [itens, hist] = await Promise.all([
    q(`SELECT CodigoBarra, Descricao, Unid, QtdEmb, QTotal, Preco, Ql1, Ql2, Ql3, Ql4, Ql5, Ql6, Ql7, Ql8, Ql9, Ql10, Obs FROM central.lista_consolidado_itens WHERE nConsolidado=? ORDER BY Descricao`, [n]),
    q(`SELECT nLoja, CodigoBarra, DataCompra, Fornecedor, Qtd, Emb, Preco, Total, Custo, PVenda, Transito, SaidaMedia, Cobertura, Estoque, QtdVendas, QtdSug, QtdLoja, PMV FROM central.lista_consolidado_historico WHERE nConsolidado=?`, [n])
  ]);
  return montarDeLinhas(cab, itens, hist, obter(`D-${n}`));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/sugestao-manual.test.js`
Expected: `# pass 14`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/sugestao-manual.js test/sugestao-manual.test.js
git commit -m "Sugestão Manual: monta sugestão do Dlinks (D-N) a partir de lista_consolidado_* + ajustes gravados

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `calcularNova(params)` — sugestão do Fluxo calculada do ERP (só SELECT)

**Files:**
- Modify: `lib/sugestao-manual.js`
- Test: `test/sugestao-manual.test.js`

**Interfaces:**
- Consumes: `initERP({ q, mesDB, transitoDe, curvaASet })` — `mesDB(mes)` → `'mes09'` (do `server.js`); `transitoDe(cod, loja)` → unidades em trânsito (número, do Radar); `curvaASet()` → `Set` de códigos curva A ou `null`.
- Produces:
  - `async calcularNova({ listaId, data_ini, data_fim, cobertura, lojas, obs, usuario })` → objeto `F-N` **já gravado** (com `id` novo) ou lança `Error('Lista não encontrada')` / `Error('Lista sem produtos nas lojas escolhidas')`.
  - `async recalcular(id)` → recarrega os dados do ERP com `s.parametros`, sobrescreve `itens` (zera digitação), grava e devolve.
  - Função pura testável: `montarItens(base, porLoja, params)` → `{ pm, itens }`, onde `base = [{ codigo, descricao, und, emb, lojas:[1,2,..] }]`, `porLoja[ln][cod] = { estoque, qtdVenda, valorVenda, diasVenda, ultimaVenda, custo, ultimaCompra, precoAtual, transito }`, `params = { dias, cobertura, obs, curvaA: Set|null }`.
- ABC: `A` se `curvaA.has(codigo)`; senão ordena os itens da lista por `valorVenda` total desc; `B` enquanto o acumulado *antes* do item < 80% do total; `C` o resto. Sem venda → `C`.

Consultas (por loja `ln`, meses `m` que o período cruza):
```sql
SELECT i.Codigobarra, TRIM(it.Descricao) descricao, it.Unid, it.qtdemb, i.l1,i.l2,i.l3,i.l4,i.l5,i.l6, it.P1,it.P2,it.P3,it.P4,it.P5,it.P6
FROM central.c_cotacao_lista_itens i INNER JOIN central.itens it ON it.CodigoBarra=i.Codigobarra
WHERE i.nCotacao=? AND it.CodDesativado=0 ORDER BY it.Descricao
-- por loja:
SELECT CodigoBarra, Qtd FROM central.estoquen{ln} WHERE CodigoBarra IN (?)
SELECT CodigoBarra, Custo, UltimaCompra FROM central.custoloja{ln} WHERE CodigoBarra IN (?)
SELECT Codigo, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor, COUNT(DISTINCT Data) dias, MAX(Data) ultima
FROM `ln{ln}{mesDB(m)}`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (?) GROUP BY Codigo
```
(Qtd/Fornecedor/Preço/Total da última compra: `custoloja` só tem `Custo` e `UltimaCompra`; preencher `qtd_compra/preco_compra/total_compra/fornecedor` com `null` nesta rodada — a tela mostra "—".)

- [ ] **Step 1: Escrever o teste da função pura**

```js
test('montarItens: calcula por loja, quantidade = soma, ABC e P/M', () => {
  const base = [
    { codigo: '1', descricao: 'A', und: 'UN', emb: 12, lojas: [1, 2] },
    { codigo: '2', descricao: 'B', und: 'UN', emb: 1, lojas: [1] },
    { codigo: '3', descricao: 'C', und: 'UN', emb: 1, lojas: [1] },
  ];
  const porLoja = {
    1: { 1: { estoque: 5, qtdVenda: 30, valorVenda: 300, diasVenda: 12, ultimaVenda: '10/09/2026', custo: 7.8, ultimaCompra: '01/09/2026', precoAtual: 12.49, transito: 4 },
         2: { estoque: 0, qtdVenda: 10, valorVenda: 50, diasVenda: 5, ultimaVenda: null, custo: 2, ultimaCompra: null, precoAtual: 5, transito: 0 },
         3: { estoque: 3, qtdVenda: 0, valorVenda: 0, diasVenda: 0, ultimaVenda: null, custo: 1, ultimaCompra: null, precoAtual: 2, transito: 0 } },
    2: { 1: { estoque: 2, qtdVenda: 15, valorVenda: 150, diasVenda: 8, ultimaVenda: null, custo: 7.9, ultimaCompra: null, precoAtual: 12.49, transito: 0 } },
  };
  const r = sm.montarItens(base, porLoja, { dias: 30, cobertura: 20, obs: { sem_estoque: false, transito: true, dias_com_venda: false }, curvaA: new Set(['2']) });
  const i1 = r.itens[0];
  assert.equal(i1.lojas[0].sug_sistema, 11);          // 20×1 − 5 − 4
  assert.equal(i1.lojas[1].sug_sistema, 8);           // 20×0,5 − 2
  assert.equal(i1.quantidade, 19);
  assert.equal(i1.lojas[0].sug_loja, 11);
  assert.equal(i1.preco_und, 7.9);                    // maior custo entre as lojas
  assert.equal(i1.lojas[0].pmv, 10);                  // 300/30
  assert.equal(i1.lojas[0].abc, 'B');                 // maior venda R$ da lista: acumulado antes dele = 0% < 80% → B
  assert.equal(r.itens[1].lojas[0].abc, 'A');         // curva A do Radar
  assert.equal(r.itens[2].lojas[0].abc, 'C');         // sem venda
  assert.equal(r.itens[2].lojas[0].dias_cob, null);
  assert.equal(r.pm, +(500 / 55).toFixed(2));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/sugestao-manual.test.js`
Expected: FAIL — `sm.montarItens is not a function`

- [ ] **Step 3: Implementar**

Acrescentar em `lib/sugestao-manual.js`; trocar `initERP` por `function initERP(deps) { q = deps.q; mesDB = deps.mesDB; transitoDe = deps.transitoDe || (() => 0); curvaASet = deps.curvaASet || (() => null); }` (declarar `let mesDB = null, transitoDe = () => 0, curvaASet = () => null;`). Exportar `montarItens, calcularNova, recalcular`.

```js
function montarItens(base, porLoja, params) {
  const { dias, cobertura, obs } = params; const curvaA = params.curvaA || null;
  // ABC: A = curva A do Radar; senão B até 80% acumulado da venda R$ da lista, C o resto
  const vendaR = {}; let totalR = 0;
  for (const b of base) { let v = 0; for (const ln of b.lojas) v += (porLoja[ln] && porLoja[ln][b.codigo] ? porLoja[ln][b.codigo].valorVenda : 0) || 0; vendaR[b.codigo] = v; totalR += v; }
  const abc = {}; let acum = 0;
  for (const c of Object.keys(vendaR).sort((a, b) => vendaR[b] - vendaR[a])) {
    if (curvaA && curvaA.has(String(c))) { abc[c] = 'A'; continue; }
    if (vendaR[c] <= 0 || totalR <= 0) { abc[c] = 'C'; continue; }
    abc[c] = acum / totalR < 0.8 ? 'B' : 'C'; acum += vendaR[c];   // entra em B enquanto o acumulado ANTES dele < 80%
  }
  let vlr = 0, qtdV = 0;
  const itens = base.map(b => {
    const ls = b.lojas.map(ln => {
      const d = (porLoja[ln] && porLoja[ln][b.codigo]) || { estoque: 0, qtdVenda: 0, valorVenda: 0, diasVenda: 0, ultimaVenda: null, custo: 0, ultimaCompra: null, precoAtual: 0, transito: 0 };
      const c = calcularLoja({ qtdVenda: d.qtdVenda, diasVenda: d.diasVenda, dias, estoque: d.estoque, transito: d.transito, cobertura, obs });
      vlr += d.valorVenda || 0; qtdV += d.qtdVenda || 0;
      return { loja: ln, ultima_compra: d.ultimaCompra || null, ultima_venda: d.ultimaVenda || null, fornecedor: null, un: b.und || null, emb: b.emb || null,
        qtd_compra: null, preco_compra: null, total_compra: null, custo: +(d.custo || 0).toFixed(4), preco_atual: +(d.precoAtual || 0).toFixed(2),
        estoque: +(d.estoque || 0).toFixed(2), pmv: d.qtdVenda > 0 ? +(d.valorVenda / d.qtdVenda).toFixed(2) : 0, qtd_venda: +(d.qtdVenda || 0).toFixed(2), dias_venda: d.diasVenda || 0,
        media: c.media, dias_cob: c.dias_cob, sug_sistema: c.sug_sistema, transito: +(d.transito || 0).toFixed(2), abc: abc[b.codigo] || 'C', sug_loja: c.sug_sistema };
    });
    const custoMax = Math.max(0, ...ls.map(l => l.custo || 0));
    return { codigo: String(b.codigo), descricao: b.descricao, und: b.und, emb: b.emb || 1, preco_und: +custoMax.toFixed(2), obs: '', ativo: true,
      quantidade: ls.reduce((a, l) => a + l.sug_loja, 0), lojas: ls };
  });
  return { pm: qtdV > 0 ? +(vlr / qtdV).toFixed(2) : 0, itens };
}

// meses (ano, mes) que o período cruza, no formato usado pelos bancos ln{loja}mesNN
function mesesDoPeriodo(dIni, dFim) {
  const out = []; const a = new Date(dIni + 'T00:00:00'), b = new Date(dFim + 'T00:00:00');
  for (let d = new Date(a.getFullYear(), a.getMonth(), 1); d <= b; d.setMonth(d.getMonth() + 1)) out.push(d.getMonth() + 1);
  return out;
}

async function lerBaseERP(listaId, lojas, dIni, dFim) {
  const [lista] = await q(`SELECT Nome, NomeFornec, CodFornec FROM central.c_cotacao_lista WHERE nReg=?`, [listaId]);
  if (!lista) throw new Error('Lista não encontrada');
  const rows = await q(`SELECT i.Codigobarra, TRIM(it.Descricao) descricao, it.Unid, it.qtdemb, i.l1,i.l2,i.l3,i.l4,i.l5,i.l6, it.P1,it.P2,it.P3,it.P4,it.P5,it.P6
    FROM central.c_cotacao_lista_itens i INNER JOIN central.itens it ON it.CodigoBarra=i.Codigobarra WHERE i.nCotacao=? AND it.CodDesativado=0 ORDER BY it.Descricao`, [listaId]);
  const base = rows.map(r => ({ codigo: String(r.Codigobarra), descricao: r.descricao, und: r.Unid, emb: parseInt(r.qtdemb) || 1,
    lojas: lojas.filter(ln => parseInt(r['l' + ln]) === 1), precos: Object.fromEntries(lojas.map(ln => [ln, num(r['P' + ln])])) })).filter(b => b.lojas.length);
  if (!base.length) throw new Error('Lista sem produtos nas lojas escolhidas');
  const cods = base.map(b => b.codigo); const ph = cods.map(() => '?').join(',');
  const porLoja = {};
  const fmt = d => d ? new Date(d).toLocaleDateString('pt-BR') : null;
  for (const ln of lojas) {
    porLoja[ln] = {};
    for (const b of base) porLoja[ln][b.codigo] = { estoque: 0, qtdVenda: 0, valorVenda: 0, diasVenda: 0, ultimaVenda: null, custo: 0, ultimaCompra: null, precoAtual: b.precos[ln] || 0, transito: transitoDe(b.codigo, ln) || 0 };
    try { for (const r of await q(`SELECT CodigoBarra, Qtd FROM central.estoquen${ln} WHERE CodigoBarra IN (${ph})`, cods)) if (porLoja[ln][r.CodigoBarra]) porLoja[ln][r.CodigoBarra].estoque = num(r.Qtd); } catch (e) {}
    try { for (const r of await q(`SELECT CodigoBarra, Custo, UltimaCompra FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, cods)) if (porLoja[ln][r.CodigoBarra]) { porLoja[ln][r.CodigoBarra].custo = num(r.Custo); porLoja[ln][r.CodigoBarra].ultimaCompra = fmt(r.UltimaCompra); } } catch (e) {}
    for (const m of mesesDoPeriodo(dIni, dFim)) {
      try {
        const vr = await q(`SELECT Codigo, SUM(QtdNovo) qtd, SUM(ValorTotalNovo) valor, COUNT(DISTINCT Data) dias, MAX(Data) ultima FROM \`ln${ln}${mesDB(m)}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...cods]);
        for (const r of vr) { const d = porLoja[ln][r.Codigo]; if (!d) continue; d.qtdVenda += num(r.qtd); d.valorVenda += num(r.valor); d.diasVenda += parseInt(r.dias) || 0; const u = fmt(r.ultima); if (u) d.ultimaVenda = u; }
      } catch (e) {}
    }
  }
  return { lista, base, porLoja };
}

async function calcularNova({ listaId, data_ini, data_fim, cobertura, lojas, obs, usuario }) {
  const ls = (lojas || []).map(n => parseInt(n)).filter(n => n >= 1 && n <= 6);
  if (!ls.length) throw new Error('Escolha ao menos uma loja');
  const dias = Math.max(1, Math.round((new Date(data_fim) - new Date(data_ini)) / 86400000));
  const o = { sem_estoque: !!(obs && obs.sem_estoque), transito: !!(obs && obs.transito), dias_com_venda: !!(obs && obs.dias_com_venda) };
  const { lista, base, porLoja } = await lerBaseERP(listaId, ls, data_ini, data_fim);
  const { pm, itens } = montarItens(base, porLoja, { dias, cobertura: +cobertura || 20, obs: o, curvaA: curvaASet() });
  const s = { id: proximoId(), origem: 'fluxo', criado_em: new Date().toISOString(), criado_por: usuario || null,
    lista: { id: +listaId, nome: (lista.Nome || '').trim(), fornecedor: (lista.NomeFornec || '').trim(), cnpj: null, cod_fornec: lista.CodFornec || null },
    parametros: { data_ini, data_fim, dias, cobertura: +cobertura || 20, lojas: ls, obs: o }, status: 'aberta', pedido_id: null, pm, itens };
  return salvar(s);
}

async function recalcular(id) {
  const s = obter(id); if (!s || s.origem !== 'fluxo') return null;
  const p = s.parametros;
  const { base, porLoja } = await lerBaseERP(s.lista.id, p.lojas, p.data_ini, p.data_fim);
  const { pm, itens } = montarItens(base, porLoja, { dias: p.dias, cobertura: p.cobertura, obs: p.obs, curvaA: curvaASet() });
  s.pm = pm; s.itens = itens; s.recalculado_em = new Date().toISOString();
  return salvar(s);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/sugestao-manual.test.js`
Expected: `# pass 15`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/sugestao-manual.js test/sugestao-manual.test.js
git commit -m "Sugestão Manual: calcula sugestão nova (F-N) a partir de venda/estoque/custo do ERP com a conta do Dlinks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Rotas `/api/sugestao-manual*` e Monitor com as duas fontes

**Files:**
- Modify: `server.js` — logo depois do bloco `const pedidosFornec = require('./lib/pedidos-fornecedor'); pedidosFornec.init();` (~linha 6144); e a rota `GET /api/sugestoes-compra` (~linha 2905); e `POST /api/pedidos-fornecedor` (~linha 6252, `origemPedido`).

**Interfaces:**
- Consumes: `sugestaoManual.{init, initERP, calcularNova, montarDoERP, obter, listar, salvar, aplicarPatch, recalcular}`; `radarPedidos.itensLista`, `radarPedidos.curvaASet`.
- Produces (todas exigem sessão, como as demais `/api/*`):
  - `GET /api/sugestoes-compra` → array; itens do Fluxo vêm com `origem:'fluxo'`, `sugestao:'F-3'`, `status_fluxo`, `pedido`, `lojas`, `total`, `comprador`; itens do Dlinks com `origem:'dlinks'` (campos de hoje). Ordenado por data desc. Query `?desativadas=1` inclui as desativadas das duas fontes.
  - `POST /api/sugestao-manual` body `{ lista, data_ini, data_fim, cobertura, lojas:[..], obs:{sem_estoque,transito,dias_com_venda} }` → objeto `F-N`.
  - `GET /api/sugestao-manual/:id` → objeto (`F-N` gravado ou `D-N` montado do ERP); 404 se não existir.
  - `PATCH /api/sugestao-manual/:id` body = patch de `aplicarPatch` → `{ ok:true, atualizado_em }`. Pra `D-N` cria o JSON de ajustes se não existir. Recusa (409) alterar quantidades/ativo de sugestão `pedido_gerado`.
  - `POST /api/sugestao-manual/:id/recalcular` → objeto recalculado (só `F-N`; 400 pra `D-N`).
  - `POST /api/sugestao-manual/:id/desativar` → `{ ok:true }` (só `F-N`).
- Trânsito pro cálculo: `transitoDe(cod, loja)` implementado no `server.js` como `(cod, ln) => { const det = radarPedidos.itensLista(listaAtual…) }` **não** — usar o estado do Radar: `radarPedidos.getEstado()` não expõe trânsito por item; então implementar `transitoDe` lendo `radarPedidos.itensLista(listaId)` uma vez por cálculo. Pra manter simples: `calcularNova` recebe `obs.transito`; o `server.js` passa `transitoDe` como closure que consulta um mapa montado antes da chamada:

```js
function transitoDaLista(listaId) {
  const det = radarPedidos.itensLista(parseInt(listaId)); const m = {};
  if (det) for (const it of det.itens) for (const [ln, d] of Object.entries(it.lojas_det || {})) m[`${it.cod}|${ln}`] = d.transito || 0;
  return (cod, ln) => m[`${cod}|${ln}`] || 0;
}
```
e `sugestaoManual.initERP({ q, mesDB, curvaASet: radarPedidos.curvaASet, transitoDe: (cod, ln) => TRANSITO_ATUAL(cod, ln) })` com `let TRANSITO_ATUAL = () => 0;` setado antes de cada `calcularNova/recalcular`.

- [ ] **Step 1: Registrar o módulo e as rotas**

Depois de `pedidosFornec.init();` em `server.js`:

```js
// ═══════════════════════════════════════════════════
// SUGESTÃO MANUAL — tela "Consolidação da Lista" (espelho do Dlinks, dentro do Fluxo).
// F-N = criada aqui (JSON em data/sugestoes-manuais); D-N = sugestão do Dlinks lida do
// ERP (lista_consolidado_*) + ajustes gravados aqui. NADA é escrito no ERP.
// ═══════════════════════════════════════════════════
const sugestaoManual = require('./lib/sugestao-manual');
let TRANSITO_ATUAL = () => 0;
function transitoDaLista(listaId) {
  const det = radarPedidos.itensLista(parseInt(listaId)); const m = {};
  if (det) for (const it of det.itens) for (const [ln, d] of Object.entries(it.lojas_det || {})) m[`${it.cod}|${ln}`] = d.transito || 0;
  return (cod, ln) => m[`${cod}|${ln}`] || 0;
}
sugestaoManual.init();
sugestaoManual.initERP({ q, mesDB, curvaASet: radarPedidos.curvaASet, transitoDe: (cod, ln) => TRANSITO_ATUAL(cod, ln) });

app.post('/api/sugestao-manual', async (req, res) => {
  try {
    const b = req.body || {};
    const listaId = parseInt(b.lista); if (!listaId) return res.status(400).json({ error: 'Informe o número da lista' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data_ini || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.data_fim || '')) return res.status(400).json({ error: 'Período de venda inválido' });
    TRANSITO_ATUAL = transitoDaLista(listaId);
    const s = await sugestaoManual.calcularNova({ listaId, data_ini: b.data_ini, data_fim: b.data_fim, cobertura: Math.max(1, parseInt(b.cobertura) || 20), lojas: b.lojas, obs: b.obs, usuario: req.session.user?.nome || null });
    res.json(s);
  } catch (err) { res.status(err.message.startsWith('Lista') || err.message.startsWith('Escolha') ? 400 : 500).json({ error: err.message }); }
});
app.get('/api/sugestao-manual/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const s = id.startsWith('D-') ? await sugestaoManual.montarDoERP(id.slice(2)) : sugestaoManual.obter(id);
    if (!s) return res.status(404).json({ error: 'Sugestão não encontrada' });
    res.json(s);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/sugestao-manual/:id', (req, res) => {
  try {
    const id = String(req.params.id); if (!/^[FD]-\d+$/.test(id)) return res.status(400).json({ error: 'Id inválido' });
    let s = sugestaoManual.obter(id);
    if (!s && id.startsWith('D-')) s = { id, origem: 'dlinks', quantidades: {}, obs: {}, inativos: [], status: 'aberta', pedido_id: null };
    if (!s) return res.status(404).json({ error: 'Sugestão não encontrada' });
    const p = req.body || {};
    if (s.status === 'pedido_gerado' && (p.quantidades || p.ativo)) return res.status(409).json({ error: 'Sugestão já tem pedido gerado — não dá pra alterar quantidades' });
    sugestaoManual.salvar(sugestaoManual.aplicarPatch(s, p));
    res.json({ ok: true, atualizado_em: s.atualizado_em });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/sugestao-manual/:id/recalcular', async (req, res) => {
  try {
    const s0 = sugestaoManual.obter(String(req.params.id));
    if (!s0 || s0.origem !== 'fluxo') return res.status(400).json({ error: 'Só sugestões do Fluxo podem ser recalculadas' });
    if (s0.status === 'pedido_gerado') return res.status(409).json({ error: 'Sugestão já tem pedido gerado' });
    TRANSITO_ATUAL = transitoDaLista(s0.lista.id);
    res.json(await sugestaoManual.recalcular(s0.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/sugestao-manual/:id/desativar', (req, res) => {
  try {
    const s = sugestaoManual.obter(String(req.params.id));
    if (!s || s.origem !== 'fluxo') return res.status(400).json({ error: 'Só sugestões do Fluxo podem ser desativadas aqui' });
    sugestaoManual.salvar(sugestaoManual.aplicarPatch(s, { status: 'desativada' }));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 2: Monitor com as duas fontes**

Em `GET /api/sugestoes-compra`, trocar o `res.json(rows.map(...))` final por:

```js
    const dlinks = rows.map(r => ({
      origem: 'dlinks',
      sugestao: r.nConsolidado,
      // ...(manter exatamente os campos de hoje: lista, fornecedor, cnpj, descricao, lojas, status_web, status, desativada, pedido, data, periodo_venda, cobertura, itens, total, comprador)
      _ord: r.data ? new Date(r.data).getTime() : 0
    }));
    // sugestões criadas no Fluxo (JSON local) — mesma busca e mesmo filtro de desativadas
    const sugestaoManual = require('./lib/sugestao-manual');
    const fluxo = sugestaoManual.listar()
      .filter(s => comDesativadas || s.status !== 'desativada')
      .filter(s => !busca || String(s.lista.id) === busca || s.id.toLowerCase() === busca.toLowerCase() || (s.lista.fornecedor || '').toLowerCase().includes(busca.toLowerCase()))
      .map(s => ({
        origem: 'fluxo', sugestao: s.id, lista: s.lista.id, fornecedor: s.lista.fornecedor, cnpj: s.lista.cnpj, descricao: s.lista.nome,
        lojas: s.parametros.lojas, status_web: 0, status: 0, desativada: s.status === 'desativada', status_fluxo: s.status,
        pedido: s.pedido_id, data: new Date(s.criado_em).toLocaleDateString('pt-BR'),
        periodo_venda: `${s.parametros.data_ini.split('-').reverse().join('/')} a ${s.parametros.data_fim.split('-').reverse().join('/')}`,
        cobertura: s.parametros.cobertura, itens: s.itens.filter(i => i.ativo).length,
        total: +s.itens.filter(i => i.ativo).reduce((a, i) => a + i.quantidade * (i.preco_und || 0), 0).toFixed(2),
        comprador: s.criado_por || null, _ord: new Date(s.criado_em).getTime()
      }));
    const todos = [...fluxo, ...dlinks].sort((a, b) => b._ord - a._ord);
    res.json(todos.map(({ _ord, ...x }) => x));
```

(Reescrever o `rows.map` atual dentro de `dlinks` mantendo os mesmos campos — não remover nenhum.)

- [ ] **Step 3: `POST /api/pedidos-fornecedor` aceita a origem nova**

Trocar `const origemPedido = req.body.origem === 'sugestao' ? 'sugestao' : 'radar';` por:

```js
    const origemPedido = ['sugestao', 'sugestao-manual'].includes(req.body.origem) ? req.body.origem : 'radar';
```

- [ ] **Step 4: Checar sintaxe e subir local**

Run: `node -e "new (require('vm').Script)(require('fs').readFileSync('server.js','utf8'))" && echo OK`
Expected: `OK`

Run (sem ERP local, só pra ver as rotas subirem): `node server.js` por 5 s e `curl -s -o /dev/null -w "%{http_code}" http://localhost:3003/api/sugestao-manual/F-1`
Expected: `401` (não autenticado — a rota existe e está atrás do login)

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "Sugestão Manual: rotas /api/sugestao-manual (criar, ler, patch, recalcular, desativar) e Monitor com Dlinks + Fluxo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Modal Nova Sugestão cria `F-N`; Monitor com selo de origem e Desativar real

**Files:**
- Modify: `public/sugestao-compras.html` — funções `confirmarNovaSugestao`, `renderMonitorTabela`, `desativarSugestoesSelecionadas`, `statusInfo`; CSS.

**Interfaces:**
- Consumes: `POST /api/sugestao-manual`, `POST /api/sugestao-manual/:id/desativar`, campos `origem`/`status_fluxo`/`sugestao` do Monitor.
- Produces: `abrirConsolidacao(id)` (definida na Task 7; aqui só é chamada) — clicar numa linha do Monitor chama `abrirConsolidacao(s.origem === 'fluxo' ? s.sugestao : 'D-' + s.sugestao)`.

- [ ] **Step 1: CSS do selo de origem**

Acrescentar no `<style>` (perto de `.status-pill`):

```css
.origem-pill{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.4px;border-radius:4px;padding:2px 6px;margin-right:6px;vertical-align:middle}
.origem-pill.dlinks{background:#E4E6EA;color:#4E5A72}
.origem-pill.fluxo{background:#FCEFDC;color:#B26A00}
```

- [ ] **Step 2: `statusInfo` e a linha do Monitor**

Substituir `statusInfo`:

```js
function statusInfo(s){
  if (s.origem === 'fluxo') {
    if (s.status_fluxo === 'desativada') return { cls:'desativada', label:'Desativada', extra:null };
    if (s.status_fluxo === 'pedido_gerado' || s.pedido) return { cls:'pedido', label:'Pedido Gerado', extra:s.pedido ? '#'+s.pedido : null };
    return { cls:'aberto', label:'Aberta', extra:null };
  }
  if (s.desativada) return { cls:'desativada', label:'Desativada', extra:null };
  if (s.pedido) return { cls:'pedido', label:'Pedido Gerado', extra:'#'+s.pedido };
  if (s.status_web === 1) return { cls:'aberto', label:'Em Aberto', extra:null };
  if (s.status_web === 2) return { cls:'fechado', label:'Fechado', extra:null };
  if (s.status_web) return { cls:'digitacao', label:'Em Digitação', extra:null };
  return { cls:'nenhum', label:'Sem link', extra:null };
}
```

Em `passaNaAba`, tratar as do Fluxo: `if (s.origem === 'fluxo') { if (abaMonitor === 'todos') return true; const fin = s.status_fluxo === 'pedido_gerado'; return abaMonitor === 'finalizados' ? fin : !fin; }` no topo da função.

Na linha da tabela (`renderMonitorTabela`), trocar:
- `onclick="abrirSugestao(${s.lista})"` → `onclick="abrirConsolidacao('${s.origem === 'fluxo' ? s.sugestao : 'D-' + s.sugestao}')"`
- `<td><b>${s.sugestao}</b></td>` → `<td><span class="origem-pill ${s.origem}">${s.origem === 'fluxo' ? 'FLUXO' : 'DLINKS'}</span><b>${s.sugestao}</b></td>`
- o checkbox ganha `data-id="${s.sugestao}" data-origem="${s.origem}"`.

- [ ] **Step 3: Confirmar do modal cria a sugestão**

Substituir `confirmarNovaSugestao`:

```js
async function confirmarNovaSugestao(){
  const id = parseInt(document.getElementById('ns-lista').value);
  const hint = document.getElementById('ns-hint');
  if (!id) { hint.textContent = 'Informe o número da lista.'; return; }
  const lojas = [...document.querySelectorAll('.ns-chk-loja:checked')].map(c => parseInt(c.value));
  if (!lojas.length) { hint.textContent = 'Marque ao menos uma loja participante.'; return; }
  const body = {
    lista: id,
    data_ini: document.getElementById('ns-data-ini').value,
    data_fim: document.getElementById('ns-data-fim').value,
    cobertura: parseInt(document.getElementById('ns-cobertura').value) || 20,
    lojas,
    obs: { sem_estoque: document.getElementById('ns-obs1').checked, transito: document.getElementById('ns-obs-transito').checked, dias_com_venda: document.getElementById('ns-obs3').checked }
  };
  const btn = document.querySelector('#ns-overlay .btn-blue'); btn.disabled = true; btn.textContent = 'Calculando...'; hint.textContent = '';
  try {
    const r = await fetch('/api/sugestao-manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    fecharNovaSugestao();
    monitorJaCarregado = false;            // força recarregar o Monitor na volta
    abrirConsolidacao(j.id, j);
  } catch (e) { hint.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Confirmar'; }
}
```

No HTML do modal, a observação "Considerar itens em trânsito" hoje é `label.off` desabilitada — trocar por `<label><input type="checkbox" id="ns-obs-transito"> Considerar itens em trânsito.</label>` (habilitada). Manter cinzas: "Utilizar Custo Consolidado Lista(s) Indústria", "Gerar com Custo (Única Loja)", "Gerar com Custo (Grupo de Lojas)". "Utilizar lista recebida da Indústria" (`ns-obs2`) passa a `disabled` com `title="Ainda não disponível"`. Em `abrirNovaSugestao` zerar também `ns-obs-transito`.

- [ ] **Step 4: Desativar real pras do Fluxo**

Substituir `desativarSugestoesSelecionadas`:

```js
async function desativarSugestoesSelecionadas(){
  const sel = [...document.querySelectorAll('.chk-sugestao:checked')];
  if (!sel.length) return;
  const fluxo = sel.filter(c => c.dataset.origem === 'fluxo').map(c => c.dataset.id);
  const dlinks = sel.length - fluxo.length;
  if (!fluxo.length) { alert(`As ${dlinks} selecionada(s) são do Dlinks — o Fluxo não escreve no ERP. Desative por lá.`); return; }
  if (!confirm(`Desativar ${fluxo.length} sugestão(ões) do Fluxo (${fluxo.join(', ')})?` + (dlinks ? `\n\n${dlinks} do Dlinks vão ficar como estão (não escrevemos no ERP).` : ''))) return;
  for (const id of fluxo) { try { await fetch(`/api/sugestao-manual/${id}/desativar`, { method: 'POST' }); } catch (e) {} }
  carregarMonitor();
}
```

- [ ] **Step 5: Verificar no navegador (sem ERP: só o JS carregar sem erro)**

Abrir `http://localhost:3003/sugestao-compras.html?tela=monitor` logado; console sem `ReferenceError`. (Sem ERP a lista vem vazia — ok.)

- [ ] **Step 6: Commit**

```bash
git add public/sugestao-compras.html
git commit -m "Sugestão Manual: Nova Sugestão cria F-N, Monitor com selo Dlinks/Fluxo e Desativar real nas do Fluxo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: View "Consolidação da Lista" — cabeçalho + grade de itens + salvamento automático

**Files:**
- Modify: `public/sugestao-compras.html` — nova `<div id="consolidacao-view" style="display:none">` logo antes de `<div id="sugestao-wrap"`; CSS; JS.

**Interfaces:**
- Consumes: `GET /api/sugestao-manual/:id`, `PATCH /api/sugestao-manual/:id`.
- Produces: `abrirConsolidacao(id, dadosOpcionais)`, `voltarDaConsolidacao()`, estado global `CONS = { s, sel (codigo selecionado), filtro:'todos'|'com_qtd'|'sem_giro', busca:'' }`, `renderConsItens()`, `salvarPatch(patch)` (debounce 600 ms, mescla patches pendentes), `selecionarItem(codigo)` (a Task 8 implementa a grade de baixo em `renderConsDetalhe()` — aqui é um stub que faz nada).

- [ ] **Step 1: HTML da view**

```html
  <div id="consolidacao-view" style="display:none">
    <div class="cons-hdr">
      <div class="cons-nums">
        <div class="cons-num"><span>Sugestão</span><b id="c-sugestao">—</b></div>
        <div class="cons-num"><span>Lista</span><b id="c-lista">—</b></div>
      </div>
      <div class="cons-forn">
        <div><span>Fornecedor:</span> <b id="c-cnpj" class="cod"></b> <b id="c-fornecedor"></b></div>
        <div class="cons-busca"><span>Item:</span> <input type="text" id="c-busca" placeholder="código ou descrição — % coringa" oninput="CONS.busca=this.value;renderConsItens()"></div>
      </div>
      <div class="cons-meta">
        <div><span>Período Vendas:</span> <b id="c-periodo"></b></div>
        <div><span>Lojas:</span> <b id="c-lojas"></b></div>
        <div><span>Cobertura:</span> <b id="c-cobertura"></b> &nbsp; <span>P/M:</span> <b id="c-pm"></b></div>
        <div><span>Status:</span> <b id="c-status"></b> <span class="cons-salvo" id="c-salvo"></span></div>
      </div>
      <div class="cons-acoes">
        <span class="origem-pill" id="c-origem"></span>
        <button class="btn btn-slate" id="c-recalc" onclick="recalcularConsolidacao()">↻ Recalcular</button>
        <button class="btn btn-slate" onclick="voltarDaConsolidacao()">← Monitor</button>
      </div>
    </div>

    <div class="table-wrap cons-itens-wrap">
      <table class="main-t cons-t" id="c-itens">
        <thead><tr><th>Código</th><th>Descrição</th><th class="c">Und</th><th class="c">Emb</th><th class="c">Quantidade</th><th class="r">Preço Und</th><th class="r">Preço Emb</th><th class="r">Total</th><th>Observação</th></tr></thead>
        <tbody id="c-itens-tbody"></tbody>
      </table>
    </div>
    <div class="cons-rodape"><span id="c-contagem"></span><span>Total: <b id="c-total"></b></span></div>

    <div class="cons-det-titulo" id="c-det-titulo">Selecione um item</div>
    <div class="table-wrap"><table class="main-t cons-t cons-det" id="c-det"><thead><tr>
      <th>LJ</th><th>Última Compra</th><th>Última Venda</th><th>Fornecedor</th><th class="c">Un</th><th class="c">Emb</th><th class="r">Qtd</th><th class="r">Preço</th><th class="r">Total</th><th class="r">Custo Unit.</th><th class="r">Preço Atual</th><th class="r">Estoque Atual</th><th class="r">P.M.V</th><th class="r">Qtd Venda</th><th class="r">Dias de Venda</th><th class="r">Média Período</th><th class="r">Dias de Cob.</th><th class="r">Sugestão Sistema</th><th class="r">Pedido Compra</th><th class="c">ABC</th><th class="c">Sugestão Loja</th>
    </tr></thead><tbody id="c-det-tbody"></tbody></table></div>

    <div class="cons-barra">
      <button class="btn btn-danger-out" onclick="alternarItemAtivo(false)">Excluir/Desativar item</button>
      <button class="btn btn-slate" onclick="alternarItemAtivo(true)">Ativar item</button>
      <label>Exibir itens:
        <select id="c-filtro" onchange="CONS.filtro=this.value;renderConsItens()"><option value="todos">Todos</option><option value="com_qtd">Com quantidade</option><option value="sem_giro">Sem giro</option></select>
      </label>
      <span class="spacer"></span>
      <button class="btn btn-slate" onclick="exportarExcelConsolidacao()">📊 Excel</button>
      <button class="btn btn-slate btn-imprimir" onclick="window.print()">🖨️ Imprimir</button>
      <button class="btn btn-blue" id="c-gerar" onclick="gerarPedidoConsolidacao()">Gerar Pedido</button>
    </div>
  </div>
```

- [ ] **Step 2: CSS**

```css
.cons-hdr{background:#fff;border:1px solid #DADAD6;border-radius:10px;padding:12px 16px;display:grid;grid-template-columns:auto 1fr auto auto;gap:18px;align-items:start;margin-bottom:12px}
.cons-nums{display:flex;gap:14px}
.cons-num{background:#F1F2ED;border-radius:8px;padding:6px 14px;text-align:center}
.cons-num span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:#98A0B3}
.cons-num b{font-size:22px;color:#101B33}
.cons-forn div,.cons-meta div{font-size:12.5px;margin-bottom:4px}
.cons-forn span,.cons-meta span{color:#98A0B3}
.cons-busca input{width:100%;max-width:420px;padding:5px 8px;border:1px solid #DADAD6;border-radius:6px;font-size:12px}
.cons-salvo{font-size:10.5px;color:#2E7A33;margin-left:8px}
.cons-acoes{display:flex;flex-direction:column;gap:6px;align-items:flex-end}
.cons-itens-wrap{max-height:46vh;overflow:auto}
table.cons-t td,table.cons-t th{font-size:12px;padding:5px 8px;white-space:nowrap}
table.cons-t tbody tr{cursor:pointer}
table.cons-t tbody tr.sel td{background:#FFF6D6}
table.cons-t tbody tr.inativo td{color:#B23A3A;text-decoration:line-through}
table.cons-t tbody tr.inativo td input{text-decoration:none}
table.cons-t input.qtd{width:72px;text-align:center;font-weight:700;border:1px solid #DADAD6;border-radius:5px;padding:3px}
table.cons-t input.qtd.zero{color:#98A0B3;font-weight:400}
table.cons-t input.obs{width:220px;border:1px solid transparent;border-radius:5px;padding:3px;background:transparent}
table.cons-t input.obs:focus{border-color:#DADAD6;background:#fff}
table.cons-det td.neg{color:#B23A3A;font-weight:700}
.cons-rodape{display:flex;justify-content:space-between;font-size:12px;color:#4E5A72;padding:6px 4px}
.cons-det-titulo{font-weight:800;font-size:13px;text-align:center;background:#101B33;color:#fff;border-radius:8px 8px 0 0;padding:6px;margin-top:6px}
.cons-barra{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
.cons-barra .spacer{flex:1}
.cons-barra label{font-size:12px;color:#4E5A72}
@media print{.cons-barra,.cons-acoes,.cons-busca{display:none}}
```

- [ ] **Step 3: JS — abrir, cabeçalho, grade de cima, salvamento**

```js
// ── Consolidação da Lista (Sugestão Manual) ──
const CONS = { s: null, sel: null, filtro: 'todos', busca: '', pend: null, timer: null };
const fmtN = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
function esconderTudoConsolidacao(){ for (const id of ['rupturas-view','monitor-view','por-lista-view','sugestao-wrap']) document.getElementById(id).style.display = 'none'; }
async function abrirConsolidacao(id, dados){
  esconderTudoConsolidacao();
  const v = document.getElementById('consolidacao-view'); v.style.display = 'block';
  document.getElementById('c-itens-tbody').innerHTML = '<tr><td colspan="9" style="padding:30px;text-align:center"><div class="spinner"></div></td></tr>';
  try {
    let s = dados;
    if (!s) { const r = await fetch('/api/sugestao-manual/' + encodeURIComponent(id)); s = await r.json(); if (s.error) throw new Error(s.error); }
    CONS.s = s; CONS.sel = null; CONS.filtro = 'todos'; CONS.busca = ''; document.getElementById('c-filtro').value = 'todos'; document.getElementById('c-busca').value = '';
    renderConsCabecalho(); renderConsItens(); renderConsDetalhe();
    history.replaceState(null, '', '?tela=monitor&sugestao=' + encodeURIComponent(s.id));
  } catch (e) { document.getElementById('c-itens-tbody').innerHTML = `<tr><td colspan="9" class="empty">Erro: ${e.message}</td></tr>`; }
}
function voltarDaConsolidacao(){ document.getElementById('consolidacao-view').style.display = 'none'; CONS.s = null; history.replaceState(null, '', '?tela=monitor'); monitorJaCarregado = false; mostrarMonitor(); }
function consTravada(){ return CONS.s && CONS.s.status === 'pedido_gerado'; }
function renderConsCabecalho(){
  const s = CONS.s, p = s.parametros;
  document.getElementById('c-sugestao').textContent = s.id.replace(/^D-/, '');
  document.getElementById('c-lista').textContent = s.lista.id;
  document.getElementById('c-cnpj').textContent = s.lista.cnpj || '';
  document.getElementById('c-fornecedor').textContent = s.lista.fornecedor || s.lista.nome || '';
  const br = d => d && d.includes('-') ? d.split('-').reverse().join('/') : (d || '—');
  document.getElementById('c-periodo').textContent = `${br(p.data_ini)} até ${br(p.data_fim)} ( ${p.dias} Dias )`;
  document.getElementById('c-lojas').textContent = 'Loja(s): ' + p.lojas.join(' - ');
  document.getElementById('c-cobertura').textContent = p.cobertura + ' Dias';
  document.getElementById('c-pm').textContent = fmtN(s.pm, 4);
  const st = s.status === 'pedido_gerado' ? `Pedido gerado #${s.pedido_id}` : s.status === 'desativada' ? 'Desativada' : (s.origem === 'dlinks' ? ({1:'Em Aberto (web)',2:'Fechado (web)'}[s.status_web] || 'Aberta') : 'Aberta');
  document.getElementById('c-status').textContent = st;
  const op = document.getElementById('c-origem'); op.className = 'origem-pill ' + s.origem; op.textContent = s.origem === 'fluxo' ? 'FLUXO' : 'DLINKS';
  document.getElementById('c-recalc').style.display = s.origem === 'fluxo' && !consTravada() ? '' : 'none';
  document.getElementById('c-gerar').disabled = consTravada() || s.status === 'desativada';
  document.getElementById('c-salvo').textContent = '';
}
function itensFiltrados(){
  const b = CONS.busca.trim().toLowerCase();
  const re = b ? new RegExp('^' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*'), 'i') : null;
  return CONS.s.itens.filter(it => {
    if (re && !(re.test(it.codigo) || re.test(it.descricao) || it.descricao.toLowerCase().includes(b))) return false;
    if (CONS.filtro === 'com_qtd') return it.quantidade > 0;
    if (CONS.filtro === 'sem_giro') return !it.lojas.some(l => (l.qtd_venda || 0) > 0);
    return true;
  });
}
function renderConsItens(){
  const its = itensFiltrados(); const trav = consTravada();
  document.getElementById('c-itens-tbody').innerHTML = its.length ? its.map(it => `
    <tr class="${it.codigo === CONS.sel ? 'sel' : ''} ${it.ativo ? '' : 'inativo'}" onclick="selecionarItem('${it.codigo}')">
      <td class="cod">${it.codigo}</td><td>${it.descricao}</td><td class="c">${it.und || ''}</td><td class="c">${it.emb}</td>
      <td class="c"><input type="number" min="0" class="qtd ${it.quantidade ? '' : 'zero'}" value="${it.quantidade}" ${(!it.ativo || trav) ? 'disabled' : ''} onclick="event.stopPropagation()" onchange="editarQuantidade('${it.codigo}', this.value)"></td>
      <td class="r">${fmtN(it.preco_und)}</td><td class="r">${fmtN(it.preco_und * (it.emb || 1))}</td><td class="r">${fmtN(it.quantidade * it.preco_und)}</td>
      <td><input type="text" class="obs" value="${(it.obs || '').replace(/"/g, '&quot;')}" ${trav ? 'disabled' : ''} onclick="event.stopPropagation()" onchange="editarObs('${it.codigo}', this.value)"></td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">Nenhum item.</td></tr>';
  const ativos = CONS.s.itens.filter(i => i.ativo);
  document.getElementById('c-contagem').textContent = `${its.length} - Produto(s)`;
  document.getElementById('c-total').textContent = 'R$ ' + fmtN(ativos.reduce((a, i) => a + i.quantidade * i.preco_und, 0));
}
function selecionarItem(codigo){ CONS.sel = codigo; renderConsItens(); renderConsDetalhe(); }
function renderConsDetalhe(){ /* Task 8 */ }
// quantidade do item → reparte pelas lojas proporcional à sugestão sistema
function editarQuantidade(codigo, v){
  const it = CONS.s.itens.find(i => i.codigo === codigo); if (!it) return;
  const T = Math.max(0, Math.round(parseFloat(v) || 0));
  const rep = repartirLojas(T, it.lojas);
  for (const l of it.lojas) l.sug_loja = rep[l.loja] || 0;
  it.quantidade = it.lojas.reduce((a, l) => a + l.sug_loja, 0);
  salvarPatch({ quantidades: { [codigo]: Object.fromEntries(it.lojas.map(l => [l.loja, l.sug_loja])) } });
  renderConsItens(); renderConsDetalhe();
}
function repartirLojas(total, lojas){        // mesma regra de lib/sugestao-manual.repartirPorLoja
  const T = Math.max(0, Math.round(total || 0)); if (T <= 0 || !lojas.length) return {};
  const soma = lojas.reduce((a, l) => a + (l.sug_sistema || 0), 0); const out = {}; let dist = 0;
  lojas.forEach((l, i) => { let qv = soma > 0 ? Math.round(T * (l.sug_sistema || 0) / soma) : Math.floor(T / lojas.length); if (i === lojas.length - 1) qv = T - dist; dist += qv; if (qv > 0) out[l.loja] = qv; });
  return out;
}
function editarObs(codigo, v){ const it = CONS.s.itens.find(i => i.codigo === codigo); if (!it) return; it.obs = v; salvarPatch({ obs: { [codigo]: v } }); }
function alternarItemAtivo(ativo){
  if (!CONS.sel) { alert('Selecione um item na grade.'); return; }
  if (consTravada()) return;
  const it = CONS.s.itens.find(i => i.codigo === CONS.sel); it.ativo = ativo;
  salvarPatch({ ativo: { [it.codigo]: ativo } }); renderConsItens();
}
// salvamento automático: mescla os patches e manda um PATCH 600 ms depois da última edição
function salvarPatch(patch){
  const p = CONS.pend = CONS.pend || {};
  for (const k of ['quantidades', 'obs', 'ativo']) if (patch[k]) p[k] = Object.assign(p[k] || {}, patch[k]);
  document.getElementById('c-salvo').textContent = 'salvando…';
  clearTimeout(CONS.timer);
  CONS.timer = setTimeout(async () => {
    const body = CONS.pend; CONS.pend = null;
    try {
      const r = await fetch('/api/sugestao-manual/' + encodeURIComponent(CONS.s.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json(); if (j.error) throw new Error(j.error);
      document.getElementById('c-salvo').textContent = 'salvo ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { document.getElementById('c-salvo').textContent = 'erro ao salvar: ' + e.message; }
  }, 600);
}
async function recalcularConsolidacao(){
  if (!confirm('Recalcular com os mesmos parâmetros? As quantidades digitadas serão substituídas pela Sugestão Sistema.')) return;
  const r = await fetch('/api/sugestao-manual/' + encodeURIComponent(CONS.s.id) + '/recalcular', { method: 'POST' }); const j = await r.json();
  if (j.error) { alert(j.error); return; }
  abrirConsolidacao(j.id, j);
}
```

Na inicialização da página (onde `?tela=` é lido), acrescentar: `const sugParam = new URLSearchParams(location.search).get('sugestao'); if (sugParam) abrirConsolidacao(sugParam);`.

- [ ] **Step 4: Verificar no navegador**

Sem ERP: abrir `?tela=monitor&sugestao=F-1` com um `data/sugestoes-manuais/F-1.json` de teste criado à mão (copiar o objeto do teste `aplicarPatch numa F-N` da Task 2, acrescentando `lista:{id:1,nome:'T',fornecedor:'T',cnpj:null}`, `parametros:{data_ini:'2026-08-15',data_fim:'2026-09-15',dias:31,cobertura:20,lojas:[1,2],obs:{}}`, `pm:0`, `criado_em` ISO, e em cada loja `sug_sistema`, `estoque`, `qtd_venda` numéricos). Esperado: cabeçalho preenchido, 1 item, editar a quantidade mostra "salvando… → salvo hh:mm" e o JSON muda em disco.

- [ ] **Step 5: Commit**

```bash
git add public/sugestao-compras.html
git commit -m "Sugestão Manual: tela Consolidação da Lista — cabeçalho, grade de itens com quantidade editável e salvamento automático

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Detalhe por loja (grade de baixo) com Sugestão Loja editável

**Files:**
- Modify: `public/sugestao-compras.html` — substituir o stub `renderConsDetalhe`.

**Interfaces:**
- Consumes: `CONS`, `salvarPatch`, `renderConsItens`.
- Produces: `renderConsDetalhe()`, `editarSugLoja(codigo, loja, valor)`.

- [ ] **Step 1: Implementar**

```js
function renderConsDetalhe(){
  const tb = document.getElementById('c-det-tbody'), tt = document.getElementById('c-det-titulo');
  const it = CONS.s && CONS.sel ? CONS.s.itens.find(i => i.codigo === CONS.sel) : null;
  if (!it) { tt.textContent = 'Selecione um item'; tb.innerHTML = ''; return; }
  tt.textContent = `${it.codigo} - ${it.descricao}`;
  const trav = consTravada() || !it.ativo;
  const cob = v => v == null ? '—' : (v >= 9999 ? '∞' : fmtN(v, 0));
  tb.innerHTML = it.lojas.map(l => `
    <tr>
      <td><b>${l.loja}</b></td><td>${l.ultima_compra || '—'}</td><td>${l.ultima_venda || '—'}</td><td>${l.fornecedor || '—'}</td>
      <td class="c">${l.un || ''}</td><td class="c">${l.emb ?? '—'}</td>
      <td class="r">${l.qtd_compra == null ? '—' : fmtN(l.qtd_compra, 0)}</td><td class="r">${l.preco_compra == null ? '—' : fmtN(l.preco_compra)}</td><td class="r">${l.total_compra == null ? '—' : fmtN(l.total_compra)}</td>
      <td class="r">${fmtN(l.custo)}</td><td class="r">${fmtN(l.preco_atual)}</td>
      <td class="r ${l.estoque <= 0 ? 'neg' : ''}">${fmtN(l.estoque, 0)}</td><td class="r ${l.pmv <= 0 ? 'neg' : ''}">${fmtN(l.pmv)}</td>
      <td class="r">${fmtN(l.qtd_venda, 0)}</td><td class="r">${l.dias_venda == null ? '—' : l.dias_venda}</td><td class="r">${fmtN(l.media)}</td><td class="r">${cob(l.dias_cob)}</td>
      <td class="r"><b>${l.sug_sistema}</b></td><td class="r">${fmtN(l.transito, 0)}</td><td class="c">${l.abc || '—'}</td>
      <td class="c"><input type="number" min="0" class="qtd ${l.sug_loja ? '' : 'zero'}" value="${l.sug_loja}" ${trav ? 'disabled' : ''} onchange="editarSugLoja('${it.codigo}', ${l.loja}, this.value)"></td>
    </tr>`).join('');
}
// sugestão loja → quantidade do item = soma das lojas
function editarSugLoja(codigo, loja, v){
  const it = CONS.s.itens.find(i => i.codigo === codigo); if (!it) return;
  const l = it.lojas.find(x => x.loja === loja); if (!l) return;
  l.sug_loja = Math.max(0, Math.round(parseFloat(v) || 0));
  it.quantidade = it.lojas.reduce((a, x) => a + (x.sug_loja || 0), 0);
  salvarPatch({ quantidades: { [codigo]: { [loja]: l.sug_loja } } });
  renderConsItens(); renderConsDetalhe();
}
```

- [ ] **Step 2: Verificar no navegador**

Com o `F-1.json` de teste: clicar no item → grade de baixo com 2 lojas; editar Sugestão Loja da loja 1 → Quantidade de cima vira a soma; editar Quantidade de cima → lojas repartidas proporcional à Sugestão Sistema; "salvo hh:mm" aparece.

- [ ] **Step 3: Commit**

```bash
git add public/sugestao-compras.html
git commit -m "Sugestão Manual: detalhe por loja (última compra, estoque, PMV, média, cobertura, sugestão sistema/loja editável)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Gerar Pedido + Excel

**Files:**
- Modify: `public/sugestao-compras.html` — `gerarPedidoConsolidacao`, `exportarExcelConsolidacao`.

**Interfaces:**
- Consumes: `POST /api/pedidos-fornecedor` (existente) com `{ listas:[lista], ajustes:{[lista]:{codigo:{loja:qtd}}}, substituir:true, origem:'sugestao-manual', confirmar_excesso }`; `PATCH /api/sugestao-manual/:id` com `{ status:'pedido_gerado', pedido_id }`.

- [ ] **Step 1: Implementar**

```js
async function gerarPedidoConsolidacao(){
  const s = CONS.s; if (!s || consTravada()) return;
  const ajustes = {}; let nItens = 0, nUn = 0;
  for (const it of s.itens) { if (!it.ativo) continue; const r = {}; for (const l of it.lojas) if (l.sug_loja > 0) r[l.loja] = l.sug_loja; if (Object.keys(r).length) { ajustes[it.codigo] = r; nItens++; nUn += it.quantidade; } }
  if (!nItens) { alert('Nenhum item com quantidade. Digite a quantidade nos produtos antes de gerar o pedido.'); return; }
  const lojasTxt = [...new Set(Object.values(ajustes).flatMap(r => Object.keys(r)))].sort().map(l => 'L' + l).join(', ');
  if (!confirm(`Gerar pedido da sugestão ${s.id} (lista ${s.lista.id} · ${s.lista.fornecedor || ''})?\n\n${nItens} produto(s) · ${nUn} un · lojas ${lojasTxt}\n\nO pedido vai pra Pedidos de Compra com o link pro vendedor digitar os preços. Depois disso a sugestão fica travada.`)) return;
  const btn = document.getElementById('c-gerar'); btn.disabled = true; btn.textContent = 'Criando pedido...';
  try {
    const corpo = conf => JSON.stringify({ listas: [s.lista.id], ajustes: { [s.lista.id]: ajustes }, substituir: true, origem: 'sugestao-manual', confirmar_excesso: conf });
    let r = await fetch('/api/pedidos-fornecedor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo(false) });
    let j = await r.json();
    if (r.status === 409 && j.bloqueados) {
      const SL = { cobertura_excessiva: 'cobertura >120 d', parado: 'parado', nao_merece: 'não merece', compra_e_nao_vende: 'compra e não vende' };
      const txt = j.bloqueados.slice(0, 25).map(b => '• L' + b.loja + ' · ' + b.descricao + ' · ' + b.qtd + ' un · ' + (SL[b.classe] || b.classe) + (b.cob && b.cob !== 9999 ? ' (' + b.cob + ' d)' : '')).join('\n') + (j.bloqueados.length > 25 ? '\n… e mais ' + (j.bloqueados.length - 25) : '');
      if (!confirm('SORTIMENTO: ' + j.bloqueados.length + ' item(ns) com alerta iriam no pedido:\n\n' + txt + '\n\nConfirmar e gerar mesmo assim?')) throw new Error('Cancelado: zere esses itens ou confirme.');
      r = await fetch('/api/pedidos-fornecedor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo(true) }); j = await r.json();
    }
    if (j.error) throw new Error(j.error);
    const p = (j.criados || [])[0];
    if (!p) throw new Error((j.sem_itens || []).map(x => x.motivo).join('; ') || 'Pedido não foi criado');
    await fetch('/api/sugestao-manual/' + encodeURIComponent(s.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pedido_gerado', pedido_id: p.id }) });
    s.status = 'pedido_gerado'; s.pedido_id = p.id; renderConsCabecalho(); renderConsItens(); renderConsDetalhe();
    alert(`Pedido #${p.id} criado · ${p.itens} item(ns)` + (j.nao_encontrados && j.nao_encontrados.length ? `\n${j.nao_encontrados.length} código(s) fora da lista do Radar foram ignorados` : '') + `\n\nLink pro vendedor:\n${p.link}\n\nAbrindo Pedidos de Compra...`);
    location.href = '/pedidos-compra.html?pedido=' + p.id;
  } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Gerar Pedido'; }
}
function exportarExcelConsolidacao(){
  const s = CONS.s; if (!s) return;
  const L = [['Sugestão', s.id, 'Lista', s.lista.id, 'Fornecedor', s.lista.fornecedor || '', 'Período', `${s.parametros.data_ini} a ${s.parametros.data_fim}`, 'Cobertura', s.parametros.cobertura], []];
  L.push(['Código','Descrição','Und','Emb','Quantidade','Preço Und','Preço Emb','Total','Observação','Ativo']);
  for (const it of s.itens) L.push([it.codigo, it.descricao, it.und, it.emb, it.quantidade, it.preco_und, +(it.preco_und * it.emb).toFixed(2), +(it.quantidade * it.preco_und).toFixed(2), it.obs || '', it.ativo ? 'S' : 'N']);
  L.push([], ['Código','Loja','Última Compra','Última Venda','Custo Unit.','Preço Atual','Estoque','PMV','Qtd Venda','Dias de Venda','Média Período','Dias de Cob.','Sugestão Sistema','Trânsito','ABC','Sugestão Loja']);
  for (const it of s.itens) for (const l of it.lojas) L.push([it.codigo, l.loja, l.ultima_compra || '', l.ultima_venda || '', l.custo, l.preco_atual, l.estoque, l.pmv, l.qtd_venda, l.dias_venda ?? '', l.media, l.dias_cob ?? '', l.sug_sistema, l.transito, l.abc || '', l.sug_loja]);
  const csv = L.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `sugestao-${s.id}-lista-${s.lista.id}.csv`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
```

Verificar que `pedidos-compra.html` aceita `?pedido=` (grep `URLSearchParams` lá); se não aceitar, usar `location.href = '/pedidos-compra.html'`.

- [ ] **Step 2: Verificar no navegador**

Com `F-1.json` de teste: Excel baixa um CSV com as duas seções. Gerar Pedido sem ERP local vai falhar em `/api/pedidos-fornecedor` (Radar sem base) — esperado; o alerta de erro aparece e o botão volta.

- [ ] **Step 3: Commit**

```bash
git add public/sugestao-compras.html
git commit -m "Sugestão Manual: Gerar Pedido (Pedidos de Compra, com aviso de Sortimento) e exportar Excel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Rodar tudo, deploy e validação com dado real

**Files:** nenhum novo.

- [ ] **Step 1: Suite completa**

Run: `node --test test/`
Expected: todos os arquivos `pass`, `# fail 0`.

- [ ] **Step 2: Sintaxe do server e push**

```bash
node -e "new (require('vm').Script)(require('fs').readFileSync('server.js','utf8'))" && git push origin main
```

- [ ] **Step 3: Deploy (só com OK do Tiago)**

`curl -s "https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026"` e conferir no `.254`: `git log --oneline -1` no repo e `Get-Content server-err.log -Tail 5`.

- [ ] **Step 4: Validação com dado real (Tiago)**

1. Monitor: linhas do Dlinks continuam iguais (15 ativas, mesmas cores), agora com selo DLINKS.
2. Abrir a **4380** (Dlinks): grade de cima com 195 itens e Quantidade = Ql por loja; detalhe do item `7891010087722` deve bater com o print do Dlinks (loja 3: estoque 4, PMV 12,49, qtd venda 10, média 0,31, dias cob 12, sugestão sistema 9).
3. **+ Nova Sugestão** pra lista 444 com 15/08→15/09, cobertura 40, lojas 1-6, "Considerar itens em trânsito" marcado → `F-1`. Comparar Sugestão Sistema por loja do mesmo item com a 4380 (esperado igual em ~63% das linhas; erro mediano < 1 un).
4. Digitar quantidades, sair e voltar (Monitor → F-1): quantidades persistem.
5. Gerar Pedido → abre Pedidos de Compra com o pedido; voltar na F-1: travada com "Pedido gerado #N".
6. Desativar F-1 no Monitor → some; "Mostrar desativadas" traz de volta riscada.

- [ ] **Step 5: Memória**

Atualizar `project_economico-sugestao-compras-monitor.md` com o estado (commit, o que foi validado, o que ficou de fora) e o índice `MEMORY.md`.
