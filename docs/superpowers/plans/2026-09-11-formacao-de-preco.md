# Formação de Preço (sidebar "Precificação") — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Depois que uma loja de um pedido fica "Conciliado XML", gerar sozinho a lista de preços de venda (custo com imposto × margem cadastrada, política de repasse, arredondamento 9/5), pra pessoa só digitar no Dlinks — sem escrever nada no ERP.

**Architecture:** Cálculo puro em `lib/precificacao-calc.js` (testável sem ERP). Persistência, gatilho, ERP, PDF e verificação em `lib/precificacao.js`, um JSON por pedido×loja em `data/precificacao/`. Gatilho vem de `conferencia-xml.js`/`pedidos-fornecedor.js` via callback `onConciliado(p, ln)`. Rotas em `server.js`, tela `public/formacao-de-preco.html` no padrão de Pedidos de Compra, item próprio "Precificação" no `nav.js`.

**Tech Stack:** Node 20+ (CommonJS), Express 5, mysql2 (só SELECT, via `q` do server.js), pdfkit, `node:test`. Sem framework no front (HTML + JS puro, `design-system.css` + `nav.js`).

## Global Constraints

- **Nunca escrever no MySQL do ERP.** Só `SELECT`. Nenhum `INSERT/UPDATE/DELETE`.
- Spec: `docs/superpowers/specs/2026-09-11-formacao-de-preco-design.md`. Nome no sidebar: **Precificação**. Título da tela: **Formação de Preço**. Arquivo: `public/formacao-de-preco.html`.
- Sidebar: bloco "Operação" em ordem alfabética → Precificação entra entre "Gestão de Compras" e "Prevenção".
- Margem = margem sobre custo: `preco = custo × (1 + margem/100)`; `margem_se_mantem = preco_atual/custo_imposto − 1`.
- Tolerância "sem mudança": ±0,5% (`TOL_SEM_MUDANCA = 0.005`).
- Arredondamento: terminação `9`, `5` ou `nenhum`; sempre pra cima. Piso: `preco_final ≥ custo_imposto`.
- Política padrão `por_curva`; arredondamento padrão `9`.
- Testes rodam com `node --test test/` (não há script npm).
- Commits em português, mensagem curta, com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` no fim. Só commit local, sem push (o Tiago faz o push e o deploy).
- Dados no .254 ficam em `C:\fc360\claude_code_\data\...`; localmente `data/` é relativo ao repo (`path.join(__dirname,'..','data',...)`), igual a `pedidos-fornecedor.js`.

---

## File map

| Arquivo | Responsabilidade |
|---|---|
| `lib/precificacao-calc.js` (novo) | Funções puras: `arred`, `calcularItem`, `calcularRegistro`, `resumo`. Sem I/O. |
| `lib/precificacao.js` (novo) | Registros (JSON), `criarDeConciliacao`, consultas ao ERP, `verificar`, `gerarPdf`. |
| `lib/conferencia-xml.js` (modificar) | Guardar frete/IPI/ST/desconto/valorProduto por nota; chamar `onConciliado`. |
| `lib/pedidos-fornecedor.js` (modificar) | Passar `onConciliado` pro `conferirTodos`; chamar em `aceitarLojaXml`; `setHooks`. |
| `lib/radar-pedidos.js` (modificar) | Exportar `curvaASet()`. |
| `server.js` (modificar) | Init/hook, rotas `/api/precificacao/*`, agendamento da verificação. |
| `public/nav.js` (modificar) | Item "Precificação". |
| `public/formacao-de-preco.html` (novo) | Tela. |
| `test/precificacao-calc.test.js` (novo) | Testes das funções puras. |
| `test/precificacao-registro.test.js` (novo) | Testes de `criarDeConciliacao` com ERP falso e diretório temporário. |

---

### Task 1: Arredondamento (`arred`)

**Files:**
- Create: `lib/precificacao-calc.js`
- Test: `test/precificacao-calc.test.js`

**Interfaces:**
- Produces: `arred(valor: number, term: '9'|'5'|'nenhum') → number` (2 casas, nunca abaixo de `valor`).

- [ ] **Step 1: Write the failing test**

```js
// test/precificacao-calc.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/precificacao-calc');

test('arred nenhum: 2 casas, pra cima', () => {
  assert.equal(c.arred(3.141, 'nenhum'), 3.15);
  assert.equal(c.arred(3.14, 'nenhum'), 3.14);
  assert.equal(c.arred(0, 'nenhum'), 0);
});

test('arred 9: menor valor >= v com centavos terminados em 9', () => {
  assert.equal(c.arred(3.14, '9'), 3.19);
  assert.equal(c.arred(3.19, '9'), 3.19);
  assert.equal(c.arred(3.191, '9'), 3.29);
  assert.equal(c.arred(3.995, '9'), 3.99);
  assert.equal(c.arred(3.996, '9'), 4.09);
  assert.equal(c.arred(10, '9'), 10.09);
});

test('arred 5: menor valor >= v com centavos terminados em 5', () => {
  assert.equal(c.arred(3.14, '5'), 3.15);
  assert.equal(c.arred(3.15, '5'), 3.15);
  assert.equal(c.arred(3.151, '5'), 3.25);
  assert.equal(c.arred(3.96, '5'), 4.05);
});

test('arred termo inválido cai em nenhum', () => {
  assert.equal(c.arred(3.141, 'x'), 3.15);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/precificacao-calc.test.js`
Expected: FAIL — `Cannot find module '../lib/precificacao-calc'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/precificacao-calc.js
// Formação de Preço — cálculo puro (sem ERP, sem arquivo). Ver spec 2026-09-11-formacao-de-preco-design.md.
'use strict';

const TOL_SEM_MUDANCA = 0.005;   // ±0,5% entre custo com imposto e custo atual = não mexe
const POLITICAS = ['manter', 'repassar', 'por_curva'];
const TERMINACOES = ['9', '5', 'nenhum'];

// centavos inteiros, evitando 3.995 → 399.49999
const cents = v => Math.round(Number(v || 0) * 100 + 1e-6);
const ceilCents = v => Math.ceil(Number(v || 0) * 100 - 1e-6);

// menor valor >= v (2 casas) cujo último dígito de centavo é `term`; 'nenhum' = só 2 casas pra cima
function arred(v, term) {
  let c = ceilCents(v);
  if (c < 0) c = 0;
  if (term !== '9' && term !== '5') return c / 100;
  const d = +term;
  const resto = c % 10;
  if (resto !== d) c += (d - resto + 10) % 10;
  return c / 100;
}

module.exports = { arred, cents, TOL_SEM_MUDANCA, POLITICAS, TERMINACOES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/precificacao-calc.test.js`
Expected: `# pass 4`

- [ ] **Step 5: Commit**

```bash
git add lib/precificacao-calc.js test/precificacao-calc.test.js
git commit -m "Formação de Preço: arredondamento 9/5/nenhum (cálculo puro)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Cálculo de um item (`calcularItem`)

**Files:**
- Modify: `lib/precificacao-calc.js`
- Test: `test/precificacao-calc.test.js`

**Interfaces:**
- Consumes: `arred`, `TOL_SEM_MUDANCA`.
- Produces:
  ```
  calcularItem(entrada, params) → item
  entrada = { cod, descricao, curvaA:boolean, recebida:number,
              custo_atual:number|null, custo_novo:number, custo_imposto:number,
              margem:number|null, preco_atual:number|null,
              margem_atacado:number|null, preco_atacado_atual:number|null,   // só L4, senão null
              motivo_bloqueio?: string }
  params  = { politica:'manter'|'repassar'|'por_curva', arredondamento:'9'|'5'|'nenhum' }
  item    = { ...entrada, variacao:number|null, preco_calc:number|null, margem_se_mantem:number|null,
              status:'bloqueado'|'sem_mudanca'|'sobe'|'desce'|'mantem', piso:boolean,
              preco_sugerido:number|null, preco_final:number|null, manual:boolean, motivo?:string,
              atacado: null | { preco_calc, preco_sugerido, preco_final, piso } }
  ```
  `preco_final` começa igual a `preco_sugerido` (`manual:false`).

- [ ] **Step 1: Write the failing tests**

Acrescentar em `test/precificacao-calc.test.js`:

```js
const P9 = { politica: 'por_curva', arredondamento: '9' };
const base = { cod: '1', descricao: 'X', curvaA: false, recebida: 10, custo_atual: 10, custo_novo: 11, custo_imposto: 11.5, margem: 30, preco_atual: 12.99, margem_atacado: null, preco_atacado_atual: null };

test('calcularItem: custo subiu → sobe, preço = custo_imposto×(1+margem) arredondado', () => {
  const it = c.calcularItem(base, P9);
  assert.equal(it.status, 'sobe');
  assert.equal(it.preco_calc, 14.95);
  assert.equal(it.preco_sugerido, 14.99);
  assert.equal(it.preco_final, 14.99);
  assert.equal(it.manual, false);
  assert.equal(it.variacao, 0.15);
  assert.equal(it.margem_se_mantem, 0.1296);
  assert.equal(it.atacado, null);
});

test('calcularItem: sem mudança dentro de 0,5%', () => {
  const it = c.calcularItem({ ...base, custo_imposto: 10.04 }, P9);
  assert.equal(it.status, 'sem_mudanca');
  assert.equal(it.preco_sugerido, 12.99);
});

test('calcularItem: custo caiu — manter / repassar / por_curva', () => {
  const caiu = { ...base, custo_imposto: 8 };
  assert.equal(c.calcularItem(caiu, { politica: 'manter', arredondamento: '9' }).status, 'mantem');
  assert.equal(c.calcularItem(caiu, { politica: 'manter', arredondamento: '9' }).preco_sugerido, 12.99);
  const rep = c.calcularItem(caiu, { politica: 'repassar', arredondamento: '9' });
  assert.equal(rep.status, 'desce');
  assert.equal(rep.preco_sugerido, 10.49);            // 8×1.3 = 10.40 → 10.49
  assert.equal(c.calcularItem(caiu, P9).status, 'mantem');                       // não é curva A
  assert.equal(c.calcularItem({ ...caiu, curvaA: true }, P9).status, 'desce');   // curva A repassa
});

test('calcularItem: sem margem → bloqueado', () => {
  const it = c.calcularItem({ ...base, margem: null }, P9);
  assert.equal(it.status, 'bloqueado');
  assert.equal(it.preco_sugerido, null);
  assert.match(it.motivo, /margem/i);
  const it0 = c.calcularItem({ ...base, margem: 0 }, P9);
  assert.equal(it0.status, 'bloqueado');
});

test('calcularItem: motivo_bloqueio externo vence tudo', () => {
  const it = c.calcularItem({ ...base, motivo_bloqueio: 'não casado no ERP' }, P9);
  assert.equal(it.status, 'bloqueado');
  assert.equal(it.motivo, 'não casado no ERP');
});

test('calcularItem: piso no custo com imposto', () => {
  const it = c.calcularItem({ ...base, margem: 1, custo_imposto: 11.5 }, { politica: 'manter', arredondamento: 'nenhum' });
  // 11.5 × 1.01 = 11.615 → 11.62 ≥ custo: sem piso
  assert.equal(it.piso, false);
  const it2 = c.calcularItem({ ...base, margem: -10 }, { politica: 'manter', arredondamento: 'nenhum' });
  assert.equal(it2.preco_sugerido, 11.5);
  assert.equal(it2.piso, true);
});

test('calcularItem: preço atual 0/null (produto novo) → sobe, margem_se_mantem null', () => {
  const it = c.calcularItem({ ...base, preco_atual: 0, custo_atual: null }, P9);
  assert.equal(it.status, 'sobe');
  assert.equal(it.variacao, null);
  assert.equal(it.margem_se_mantem, null);
  assert.equal(it.preco_sugerido, 14.99);
});

test('calcularItem: L4 com atacado', () => {
  const it = c.calcularItem({ ...base, margem_atacado: 10, preco_atacado_atual: 11.5 }, P9);
  assert.deepEqual(it.atacado, { preco_calc: 12.65, preco_sugerido: 12.69, preco_final: 12.69, piso: false });
  const semAt = c.calcularItem({ ...base, margem_atacado: 0, preco_atacado_atual: 11.5 }, P9);
  assert.equal(semAt.atacado, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/precificacao-calc.test.js`
Expected: FAIL — `c.calcularItem is not a function`

- [ ] **Step 3: Implement**

Acrescentar em `lib/precificacao-calc.js` (antes do `module.exports`) e exportar:

```js
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;

function precoPor(custo, margem, term) {
  const calc = r2(custo * (1 + margem / 100));
  let sug = arred(calc, term);
  const piso = sug < custo - 1e-9;
  if (piso) sug = arred(custo, term);
  return { preco_calc: calc, preco_sugerido: sug, piso };
}

function calcularItem(e, params) {
  const politica = POLITICAS.includes(params?.politica) ? params.politica : 'por_curva';
  const term = TERMINACOES.includes(params?.arredondamento) ? params.arredondamento : '9';
  const ci = Number(e.custo_imposto || 0), ca = e.custo_atual != null && e.custo_atual > 0 ? Number(e.custo_atual) : null;
  const pa = e.preco_atual != null && e.preco_atual > 0 ? Number(e.preco_atual) : null;
  const variacao = ca != null && ci > 0 ? r4(ci / ca - 1) : null;
  const margemSeMantem = pa != null && ci > 0 ? r4(pa / ci - 1) : null;
  const out = { ...e, variacao, preco_calc: null, margem_se_mantem: margemSeMantem, status: 'bloqueado', piso: false,
                preco_sugerido: null, preco_final: null, manual: false, atacado: null };
  if (e.motivo_bloqueio) return { ...out, motivo: e.motivo_bloqueio };
  if (!(e.margem > 0)) return { ...out, motivo: 'sem margem cadastrada na loja' };
  if (!(ci > 0)) return { ...out, motivo: 'custo do XML zerado' };
  delete out.motivo;

  const calc = precoPor(ci, Number(e.margem), term);
  out.preco_calc = calc.preco_calc;
  let status;
  if (pa == null) status = 'sobe';
  else if (variacao != null && Math.abs(variacao) <= TOL_SEM_MUDANCA) status = 'sem_mudanca';
  else if (variacao == null || variacao > 0) status = 'sobe';
  else if (politica === 'repassar') status = 'desce';
  else if (politica === 'por_curva' && e.curvaA) status = 'desce';
  else status = 'mantem';
  out.status = status;
  if (status === 'sobe' || status === 'desce') { out.preco_sugerido = calc.preco_sugerido; out.piso = calc.piso; }
  else { out.preco_sugerido = pa; out.piso = false; }
  out.preco_final = out.preco_sugerido;

  if (e.margem_atacado > 0) {
    const at = precoPor(ci, Number(e.margem_atacado), term);
    const paAt = e.preco_atacado_atual != null && e.preco_atacado_atual > 0 ? Number(e.preco_atacado_atual) : null;
    const sug = (status === 'sobe' || status === 'desce' || paAt == null) ? at.preco_sugerido : paAt;
    out.atacado = { preco_calc: at.preco_calc, preco_sugerido: sug, preco_final: sug, piso: sug === at.preco_sugerido ? at.piso : false };
  }
  return out;
}
```

E no `module.exports`: `{ arred, cents, calcularItem, TOL_SEM_MUDANCA, POLITICAS, TERMINACOES }`.

- [ ] **Step 4: Run tests**

Run: `node --test test/precificacao-calc.test.js`
Expected: `# pass 12`. Se `margem_se_mantem` der 0.1296 vs 0.1295, confira `r4` (12.99/11.5 − 1 = 0.129565… → 0.1296).

- [ ] **Step 5: Commit**

```bash
git add lib/precificacao-calc.js test/precificacao-calc.test.js
git commit -m "Formação de Preço: cálculo por item (política, piso, atacado L4)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Registro inteiro (`calcularRegistro`, `resumo`) preservando edições manuais

**Files:**
- Modify: `lib/precificacao-calc.js`
- Test: `test/precificacao-calc.test.js`

**Interfaces:**
- Produces:
  - `calcularRegistro(reg, { descartarManuais?:boolean }) → reg` — recalcula `reg.itens` a partir de `reg.entradas` (array de `entrada`) com `reg.parametros`; mantém `preco_final`/`manual` de itens já editados quando `custo_imposto` não mudou.
  - `resumo(itens) → { itens, sobem, descem, mantem, sem_mudanca, bloqueados, mudam }`.

- [ ] **Step 1: Write the failing tests**

```js
test('calcularRegistro: recalcula e preserva edição manual', () => {
  const reg = { parametros: P9, entradas: [base, { ...base, cod: '2', custo_imposto: 8 }], itens: [] };
  c.calcularRegistro(reg);
  assert.equal(reg.itens.length, 2);
  reg.itens[0].preco_final = 15.49; reg.itens[0].manual = true;
  c.calcularRegistro(reg);                       // custo igual → mantém
  assert.equal(reg.itens[0].preco_final, 15.49);
  assert.equal(reg.itens[0].manual, true);
  reg.entradas[0] = { ...base, custo_imposto: 12 };
  c.calcularRegistro(reg);                       // custo mudou → descarta
  assert.equal(reg.itens[0].manual, false);
  assert.equal(reg.itens[0].preco_final, reg.itens[0].preco_sugerido);
  reg.itens[1].preco_final = 9.99; reg.itens[1].manual = true;
  c.calcularRegistro(reg, { descartarManuais: true });
  assert.equal(reg.itens[1].manual, false);
});

test('resumo conta status', () => {
  const r = c.resumo([{ status: 'sobe' }, { status: 'desce' }, { status: 'mantem' }, { status: 'sem_mudanca' }, { status: 'bloqueado' }, { status: 'sobe' }]);
  assert.deepEqual(r, { itens: 6, sobem: 2, descem: 1, mantem: 1, sem_mudanca: 1, bloqueados: 1, mudam: 3 });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/precificacao-calc.test.js` → FAIL `c.calcularRegistro is not a function`

- [ ] **Step 3: Implement**

```js
function calcularRegistro(reg, opts = {}) {
  const antes = new Map((reg.itens || []).map(i => [i.cod, i]));
  reg.itens = (reg.entradas || []).map(e => {
    const novo = calcularItem(e, reg.parametros);
    const old = antes.get(e.cod);
    if (old && old.manual && !opts.descartarManuais && novo.status !== 'bloqueado' && Math.abs((old.custo_imposto || 0) - (novo.custo_imposto || 0)) < 1e-9) {
      novo.preco_final = old.preco_final; novo.manual = true;
      if (novo.atacado && old.atacado) { novo.atacado.preco_final = old.atacado.preco_final; }
    }
    return novo;
  });
  reg.resumo = resumo(reg.itens);
  return reg;
}

function resumo(itens) {
  const r = { itens: itens.length, sobem: 0, descem: 0, mantem: 0, sem_mudanca: 0, bloqueados: 0, mudam: 0 };
  for (const i of itens) {
    if (i.status === 'sobe') r.sobem++; else if (i.status === 'desce') r.descem++; else if (i.status === 'mantem') r.mantem++;
    else if (i.status === 'sem_mudanca') r.sem_mudanca++; else if (i.status === 'bloqueado') r.bloqueados++;
  }
  r.mudam = r.sobem + r.descem;
  return r;
}
```

Exportar `calcularRegistro, resumo`.

- [ ] **Step 4: Run tests** → `# pass 14`

- [ ] **Step 5: Commit**

```bash
git add lib/precificacao-calc.js test/precificacao-calc.test.js
git commit -m "Formação de Preço: cálculo do registro com preservação de edições manuais

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Conferência XML guarda impostos por nota e avisa quando a loja concilia

**Files:**
- Modify: `lib/conferencia-xml.js:141-146` (retorno de `conferirLoja`, mapa `notas`) e `:150-199` (`conferirTodos`)
- Modify: `lib/pedidos-fornecedor.js:215-222` (`initERP`, `verificarRecebimentos`) e `:319-334` (`aceitarLojaXml`)
- Modify: `lib/radar-pedidos.js:558,569` (`curvaASet`)

**Interfaces:**
- Produces:
  - Em `p.xml.lojas[ln].notas[]`: campos novos `valorProduto, desconto, frete, ipi, st` (números).
  - `conferirTodos({ listar, salvar, criarOuMesclarRuptura, onConciliado })`: chama `onConciliado(p, ln)` **depois** de `salvar(p)` pra cada loja que ficou `conciliado` nesta rodada.
  - `pedidosFornec.setHooks({ onConciliado })`; `aceitarLojaXml` chama o hook após salvar.
  - `radar.curvaASet() → Set<string>` de códigos curva A (vazio se ainda não calculou).

- [ ] **Step 1: Guardar os totais da nota**

Em `lib/conferencia-xml.js`, no `return` de `conferirLoja`, trocar a linha `notas: notas.map(...)` por:

```js
    notas: notas.map(n => ({ chave: n.chave, nNota: n.nNota, serie: n.serie, data: n.data, emitente: n.emitente, valorNFE: n.valorNFE, importado: n.importado, itens: n.itens.length, boletos: n.boletos,
                             valorProduto: n.valorProduto, desconto: n.desconto, frete: n.frete, ipi: n.ipi, st: n.st })),
```

(`valorProduto/desconto/frete/ipi/st` já são lidos do cabeçalho `axml` em `buscarNotas`.) As notas de teste (`data/xml-teste/<id>.json`) podem não ter esses campos: `num(undefined)` → 0, e `valorProduto` 0 é tratado como "sem rateio" na Task 5.

- [ ] **Step 2: Callback ao conciliar**

Em `conferirTodos`, assinatura: `async function conferirTodos({ listar, salvar, criarOuMesclarRuptura, onConciliado }) {`.
Dentro do `for (const ln of p.lojas)`, logo após `p.xml.lojas[ln] = r; mudou = true; verificados++;`, acrescentar:

```js
      if (r.status === 'conciliado') (p._conciliadasAgora = p._conciliadasAgora || []).push(+ln);
```

E trocar o fim do loop do pedido `if (mudou) { p.xml.verificadoEm = ...; salvar(p); }` por:

```js
    const agora = p._conciliadasAgora || []; delete p._conciliadasAgora;
    if (mudou) { p.xml.verificadoEm = new Date().toISOString(); salvar(p); }
    if (onConciliado) for (const ln of agora) { try { onConciliado(p, ln); } catch (e) { console.error('[XML] onConciliado:', e.message); } }
```

- [ ] **Step 3: Hook em pedidos-fornecedor**

Em `lib/pedidos-fornecedor.js`:

```js
let hooks = {};
function setHooks(h) { hooks = h || {}; }
async function verificarRecebimentos() {
  return cx.conferirTodos({ listar, salvar, criarOuMesclarRuptura, onConciliado: hooks.onConciliado });
}
```

Em `aceitarLojaXml`, trocar o `return salvar(p);` final por:

```js
  const salvo = salvar(p);
  if (hooks.onConciliado) { try { hooks.onConciliado(p, +ln); } catch (e) { console.error('[XML] onConciliado:', e.message); } }
  return salvo;
```

Adicionar `setHooks` ao `module.exports`.

- [ ] **Step 4: Curva A no radar**

Em `lib/radar-pedidos.js`, antes de `function getEstado()`:

```js
function curvaASet() { return new Set((base?.prods || []).filter(p => p.curvaA).map(p => String(p.cod))); }
```

E incluir `curvaASet` no `module.exports` (linha 569).

- [ ] **Step 5: Verificar que nada quebrou**

Run: `node --test test/` → todos passam. Run: `node -e "require('./lib/conferencia-xml');require('./lib/pedidos-fornecedor');require('./lib/radar-pedidos');console.log('ok')"` → `ok`.

- [ ] **Step 6: Commit**

```bash
git add lib/conferencia-xml.js lib/pedidos-fornecedor.js lib/radar-pedidos.js
git commit -m "Conferência XML: guarda frete/IPI/ST por nota e avisa (onConciliado) quando a loja concilia; radar exporta curvaASet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Módulo `lib/precificacao.js` — registro, entradas e ERP

**Files:**
- Create: `lib/precificacao.js`
- Test: `test/precificacao-registro.test.js`

**Interfaces:**
- Consumes: `calcularRegistro`, `resumo` (Task 3); `p.xml.lojas[ln]` (itens `{cod, descricao, recebida, tipo, preco_xml, preco_status, decisao}`, `nao_pedidos`, `notas` com totais — Task 4); `radar.curvaASet()`.
- Produces:
  ```
  init({ dir? })                       // cria a pasta
  initERP(q, radar)                    // q(sql, params) → rows ; radar.curvaASet()
  criarDeConciliacao(p, ln) → Promise<reg|null>   // idempotente por id
  listar() → reg[]  (ordenado por criadoEm desc)
  obter(id) → reg|null
  salvar(reg) → reg
  recalcular(id, { descartarManuais }) → Promise<reg>
  reg = { id:'<pedidoId>-L<ln>', pedidoId, loja, lista, lista_nome, fornecedor, teste,
          status:'a_precificar'|'precificado'|'aplicado'|'conferido', criadoEm, conciliadoEm,
          parametros:{politica, arredondamento}, rateio:{ fator, frete, ipi, st, desconto, valorProduto, disponivel:boolean },
          entradas:[entrada], itens:[item], resumo, historico:[{acao, por, em}] }
  ```

- [ ] **Step 1: Write the failing test** (ERP falso, pasta temporária)

```js
// test/precificacao-registro.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const pr = require('../lib/precificacao');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precif-'));
pr.init({ dir });

// ERP falso: responde pelas 3 consultas (itens/preço, custo, margem)
const qFake = async (sql) => {
  if (/FROM central\.itens /.test(sql)) return [{ CodigoBarra: 'A', P: '12,99', A: '0', CodDesativado: 0 }, { CodigoBarra: 'B', P: '5,00', A: '0', CodDesativado: 0 }];
  if (/FROM central\.custoloja/.test(sql)) return [{ CodigoBarra: 'A', Custo: '10' }, { CodigoBarra: 'B', Custo: '4' }];
  if (/FROM central\.itens_margens/.test(sql)) return [{ CodigoBarra: 'A', MargemVarejo: 30, MargemAtacado: null }];
  return [];
};
pr.initERP(qFake, { curvaASet: () => new Set(['A']) });

const pedido = {
  id: 40, lista: 7, lista_nome: 'LISTA X', fornecedor: 'FORN', teste: true,
  itens: [{ cod: 'A', descricao: 'ARROZ' }, { cod: 'B', descricao: 'FEIJAO' }, { cod: 'C', descricao: 'FALTOU' }],
  xml: { lojas: { 2: {
    status: 'conciliado', conferidoEm: '2026-09-11T10:00:00.000Z',
    notas: [{ chave: 'k1', valorProduto: 200, desconto: 0, frete: 10, ipi: 0, st: 10 }],
    itens: [
      { cod: 'A', descricao: 'ARROZ', recebida: 10, tipo: 'ok', preco_xml: 11 },
      { cod: 'B', descricao: 'FEIJAO', recebida: 5, tipo: 'ok', preco_xml: 4.5, preco_status: 'maior', decisao: { acao: 'recusar' } },
      { cod: 'C', descricao: 'FALTOU', recebida: 0, tipo: 'falta', preco_xml: null }
    ],
    nao_pedidos: [{ cod: 'D', descricao: 'EXTRA', recebida: 2, preco_xml: 3, decisao: { acao: 'aceitar' } }]
  } } }
};

test('criarDeConciliacao monta entradas, rateia impostos e calcula', async () => {
  const reg = await pr.criarDeConciliacao(pedido, 2);
  assert.equal(reg.id, '40-L2'); assert.equal(reg.loja, 2); assert.equal(reg.status, 'a_precificar');
  assert.equal(reg.rateio.fator, 0.1);                 // (10+0+10−0)/200
  const cods = reg.entradas.map(e => e.cod).sort();
  assert.deepEqual(cods, ['A', 'D']);                  // B recusado, C faltou
  const a = reg.itens.find(i => i.cod === 'A');
  assert.equal(a.custo_novo, 11); assert.equal(a.custo_imposto, 12.1); assert.equal(a.custo_atual, 10);
  assert.equal(a.preco_atual, 12.99); assert.equal(a.margem, 30); assert.equal(a.curvaA, true);
  assert.equal(a.status, 'sobe'); assert.equal(a.preco_sugerido, 15.79);   // 12.1×1.3=15.73 → 15.79
  const d = reg.itens.find(i => i.cod === 'D');
  assert.equal(d.status, 'bloqueado'); assert.match(d.motivo, /não casado/);
  assert.equal(reg.resumo.mudam, 1);
});

test('criarDeConciliacao é idempotente', async () => {
  const again = await pr.criarDeConciliacao(pedido, 2);
  assert.equal(again.id, '40-L2');
  assert.equal(pr.listar().length, 1);
});

test('sem valorProduto → rateio indisponível, custo_imposto = custo_novo', async () => {
  const p2 = JSON.parse(JSON.stringify(pedido)); p2.id = 41; p2.xml.lojas[2].notas = [{ chave: 'k2' }];
  const reg = await pr.criarDeConciliacao(p2, 2);
  assert.equal(reg.rateio.disponivel, false);
  assert.equal(reg.itens.find(i => i.cod === 'A').custo_imposto, 11);
});
```

- [ ] **Step 2: Run to verify fail** → `Cannot find module '../lib/precificacao'`

- [ ] **Step 3: Implement**

```js
// lib/precificacao.js
// Formação de Preço (sidebar "Precificação"). Um registro por pedido × loja, criado quando a
// loja fica "Conciliado XML". NADA é escrito no ERP: só SELECT (itens, custoloja, itens_margens).
'use strict';
const fs = require('fs');
const path = require('path');
const calc = require('./precificacao-calc');

let DIR = path.join(__dirname, '..', 'data', 'precificacao');
let qERP = null, radar = null;
let padrao = { politica: 'por_curva', arredondamento: '9' };

function init(opts = {}) { if (opts.dir) DIR = opts.dir; fs.mkdirSync(DIR, { recursive: true }); }
function initERP(q, radarMod) { qERP = q; radar = radarMod || null; }
function setPadrao(p) { padrao = { politica: calc.POLITICAS.includes(p?.politica) ? p.politica : padrao.politica, arredondamento: calc.TERMINACOES.includes(p?.arredondamento) ? p.arredondamento : padrao.arredondamento }; return padrao; }
function getPadrao() { return { ...padrao }; }

const arq = id => path.join(DIR, `${id}.json`);
const idDe = (pedidoId, ln) => `${pedidoId}-L${ln}`;
function salvar(r) { fs.writeFileSync(arq(r.id), JSON.stringify(r)); return r; }
function obter(id) { try { return JSON.parse(fs.readFileSync(arq(String(id)), 'utf8')); } catch (e) { return null; } }
function listar() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => obter(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}
const parsePreco = v => v && v !== '0' ? parseFloat(String(v).replace(',', '.')) || 0 : 0;

// itens da conferência que entram na precificação (recebidos e não recusados)
function itensConciliados(x) {
  const out = [];
  for (const i of x.itens || []) {
    if (!(i.recebida > 0)) continue;
    if (i.decisao?.acao === 'recusar' && i.tipo !== 'a_mais') continue;   // recusa de a_mais devolve só o excedente
    out.push({ cod: String(i.cod), descricao: i.descricao, recebida: i.recebida, custo_novo: +(i.preco_xml || 0) });
  }
  for (const i of x.nao_pedidos || []) if (i.decisao?.acao === 'aceitar' && i.recebida > 0) out.push({ cod: String(i.cod), descricao: i.descricao, recebida: i.recebida, custo_novo: +(i.preco_xml || 0), nao_pedido: true });
  return out;
}

function rateioDe(x) {
  const s = { frete: 0, ipi: 0, st: 0, desconto: 0, valorProduto: 0 };
  for (const n of x.notas || []) { s.frete += +(n.frete || 0); s.ipi += +(n.ipi || 0); s.st += +(n.st || 0); s.desconto += +(n.desconto || 0); s.valorProduto += +(n.valorProduto || 0); }
  const disponivel = s.valorProduto > 0;
  const fator = disponivel ? +(((s.frete + s.ipi + s.st - s.desconto) / s.valorProduto)).toFixed(6) : 0;
  return { ...s, fator, disponivel };
}

// dados do ERP pra UMA loja: preço de venda (P{n}, atacado a{n}), custo (custoloja{n}), margens
async function dadosERP(ln, cods) {
  const vazio = { preco: {}, custo: {}, margem: {}, existe: new Set() };
  if (!qERP || !cods.length) return vazio;
  const ph = cods.map(() => '?').join(',');
  const [itens, custos, margens] = await Promise.all([
    qERP(`SELECT CodigoBarra, P${ln} AS P, a${ln} AS A, CodDesativado FROM central.itens WHERE CodigoBarra IN (${ph})`, cods),
    qERP(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph})`, cods),
    qERP(`SELECT CodigoBarra, MargemVarejo, MargemAtacado FROM central.itens_margens WHERE nLoja=? AND CodigoBarra IN (${ph})`, [ln, ...cods])
  ]);
  const d = { preco: {}, custo: {}, margem: {}, existe: new Set() };
  for (const r of itens) { const c = String(r.CodigoBarra); d.existe.add(c); d.preco[c] = { varejo: parsePreco(r.P), atacado: parsePreco(r.A) }; }
  for (const r of custos) d.custo[String(r.CodigoBarra)] = parsePreco(r.Custo);
  for (const r of margens) d.margem[String(r.CodigoBarra)] = { varejo: r.MargemVarejo != null ? +r.MargemVarejo : null, atacado: r.MargemAtacado != null ? +r.MargemAtacado : null };
  return d;
}

async function montarEntradas(reg, x) {
  const base = itensConciliados(x);
  const rateio = rateioDe(x);
  const erp = await dadosERP(reg.loja, base.map(b => b.cod));
  const curvaA = radar?.curvaASet ? radar.curvaASet() : new Set();
  reg.rateio = rateio;
  reg.entradas = base.map(b => {
    const ci = +(b.custo_novo * (1 + (rateio.disponivel ? rateio.fator : 0))).toFixed(4);
    const m = erp.margem[b.cod] || {};
    const e = {
      cod: b.cod, descricao: b.descricao, curvaA: curvaA.has(b.cod), recebida: b.recebida, nao_pedido: !!b.nao_pedido,
      custo_atual: erp.custo[b.cod] ?? null, custo_novo: b.custo_novo, custo_imposto: ci,
      margem: m.varejo ?? null, preco_atual: erp.preco[b.cod]?.varejo ?? null,
      margem_atacado: reg.loja === 4 ? (m.atacado ?? null) : null,
      preco_atacado_atual: reg.loja === 4 ? (erp.preco[b.cod]?.atacado ?? null) : null
    };
    if (!erp.existe.has(b.cod)) e.motivo_bloqueio = 'não casado no ERP (código ' + b.cod + ')';
    return e;
  });
}

async function criarDeConciliacao(p, ln) {
  const x = p.xml?.lojas?.[ln]; if (!x || x.status !== 'conciliado') return null;
  const id = idDe(p.id, ln);
  const existente = obter(id); if (existente) return existente;
  const reg = {
    id, pedidoId: p.id, loja: +ln, lista: p.lista, lista_nome: p.lista_nome, fornecedor: p.fornecedor, teste: !!p.teste,
    status: 'a_precificar', criadoEm: new Date().toISOString(), conciliadoEm: x.conferidoEm || null,
    parametros: { ...padrao }, rateio: null, entradas: [], itens: [], resumo: null, historico: [{ acao: 'criado', por: null, em: new Date().toISOString() }]
  };
  await montarEntradas(reg, x);
  calc.calcularRegistro(reg);
  return salvar(reg);
}

async function recalcular(id, opts = {}) {
  const reg = obter(id); if (!reg) return null;
  if (opts.doERP) {
    // re-lê preço/custo/margem do ERP mantendo os itens conciliados (custo XML não muda)
    const erp = await dadosERP(reg.loja, reg.entradas.map(e => e.cod));
    const curvaA = radar?.curvaASet ? radar.curvaASet() : new Set();
    for (const e of reg.entradas) {
      const m = erp.margem[e.cod] || {};
      e.curvaA = curvaA.has(e.cod); e.custo_atual = erp.custo[e.cod] ?? null; e.margem = m.varejo ?? null; e.preco_atual = erp.preco[e.cod]?.varejo ?? null;
      e.margem_atacado = reg.loja === 4 ? (m.atacado ?? null) : null; e.preco_atacado_atual = reg.loja === 4 ? (erp.preco[e.cod]?.atacado ?? null) : null;
      if (erp.existe.has(e.cod)) delete e.motivo_bloqueio; else e.motivo_bloqueio = 'não casado no ERP (código ' + e.cod + ')';
    }
  }
  calc.calcularRegistro(reg, { descartarManuais: !!opts.descartarManuais });
  return salvar(reg);
}

module.exports = { init, initERP, setPadrao, getPadrao, criarDeConciliacao, recalcular, listar, obter, salvar, idDe, itensConciliados, rateioDe };
```

- [ ] **Step 4: Run tests** → `node --test test/precificacao-registro.test.js` → `# pass 3`

- [ ] **Step 5: Commit**

```bash
git add lib/precificacao.js test/precificacao-registro.test.js
git commit -m "Formação de Preço: registro por pedido×loja a partir da conciliação XML (ERP só leitura)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Ações do registro (editar item, parâmetros, fechar, reabrir, aplicar) e verificação no ERP

**Files:**
- Modify: `lib/precificacao.js`
- Test: `test/precificacao-registro.test.js`

**Interfaces:**
- Produces:
  ```
  editarItem(id, cod, { preco_final?, preco_atacado_final? }, usuario) → reg | {erro}
  setParametros(id, { politica?, arredondamento? }, usuario) → Promise<reg|{erro}>   // recalcula, preserva manuais
  fechar(id, usuario) → reg|{erro}       // a_precificar → precificado (exige 0 bloqueados OU ignorarBloqueados)
  reabrir(id, usuario) → reg|{erro}      // precificado|aplicado → a_precificar
  aplicar(id, usuario) → reg|{erro}      // precificado → aplicado (aplicadoEm)
  verificar(id) → Promise<reg>           // aplicado|conferido: lê P{ln}/a{ln}, marca item.erp = { preco, atacado, ok } e reg.status='conferido', reg.divergentes=n
  verificarTodos() → Promise<{ verificados, divergentes }>   // registros aplicado/conferido com aplicadoEm < 7 dias
  ```

- [ ] **Step 1: Write the failing tests**

```js
test('editarItem marca manual e respeita piso', () => {
  const r1 = pr.editarItem('40-L2', 'A', { preco_final: 16.49 }, 'tiago');
  const a = r1.itens.find(i => i.cod === 'A');
  assert.equal(a.preco_final, 16.49); assert.equal(a.manual, true);
  const err = pr.editarItem('40-L2', 'A', { preco_final: 1 }, 'tiago');
  assert.match(err.erro, /abaixo do custo/);
});

test('setParametros recalcula preservando manual', async () => {
  const r = await pr.setParametros('40-L2', { arredondamento: '5' }, 'tiago');
  assert.equal(r.parametros.arredondamento, '5');
  assert.equal(r.itens.find(i => i.cod === 'A').preco_final, 16.49);
});

test('fechar exige resolver bloqueados, aplicar exige precificado', () => {
  assert.match(pr.fechar('40-L2', 'tiago').erro, /bloqueado/);
  const r = pr.fechar('40-L2', 'tiago', { ignorarBloqueados: true });
  assert.equal(r.status, 'precificado');
  assert.match(pr.editarItem('40-L2', 'A', { preco_final: 17 }, 'x').erro, /fechado/);
  assert.equal(pr.aplicar('40-L2', 'tiago').status, 'aplicado');
  assert.equal(pr.reabrir('40-L2', 'tiago').status, 'a_precificar');
  pr.fechar('40-L2', 'tiago', { ignorarBloqueados: true }); pr.aplicar('40-L2', 'tiago');
});

test('verificar lê o ERP e marca divergência', async () => {
  const r = await pr.verificar('40-L2');   // qFake devolve P=12,99 pra A, e o final é 16.49 → divergente
  assert.equal(r.status, 'conferido');
  assert.equal(r.itens.find(i => i.cod === 'A').erp.ok, false);
  assert.equal(r.divergentes, 1);
  const t = await pr.verificarTodos();
  assert.equal(t.verificados, 1);
});
```

- [ ] **Step 2: Run to verify fail** → `pr.editarItem is not a function`

- [ ] **Step 3: Implement** (acrescentar em `lib/precificacao.js`, exportar tudo)

```js
const ABERTO = ['a_precificar'];
function hist(r, acao, por, extra) { r.historico.push({ acao, por: por || null, em: new Date().toISOString(), ...(extra || {}) }); }

function editarItem(id, cod, v, usuario) {
  const r = obter(id); if (!r) return null;
  if (!ABERTO.includes(r.status)) return { erro: 'Registro fechado: reabra pra editar' };
  const it = r.itens.find(i => i.cod === String(cod)); if (!it) return { erro: 'Item não encontrado' };
  if (it.status === 'bloqueado') return { erro: 'Item bloqueado (' + it.motivo + ')' };
  if (v.preco_final != null) {
    const p = Math.round(parseFloat(v.preco_final) * 100) / 100;
    if (!(p > 0)) return { erro: 'Preço inválido' };
    if (p < it.custo_imposto - 1e-9) return { erro: 'Preço abaixo do custo com imposto (R$ ' + it.custo_imposto.toFixed(2) + ')' };
    it.preco_final = p; it.manual = true;
  }
  if (v.preco_atacado_final != null && it.atacado) {
    const p = Math.round(parseFloat(v.preco_atacado_final) * 100) / 100;
    if (!(p > 0)) return { erro: 'Preço atacado inválido' };
    if (p < it.custo_imposto - 1e-9) return { erro: 'Preço atacado abaixo do custo com imposto' };
    it.atacado.preco_final = p; it.manual = true;
  }
  hist(r, 'editar_item', usuario, { cod: it.cod, preco_final: it.preco_final });
  return salvar(r);
}

async function setParametros(id, p, usuario) {
  const r = obter(id); if (!r) return null;
  if (!ABERTO.includes(r.status)) return { erro: 'Registro fechado: reabra pra mudar política/arredondamento' };
  if (p.politica != null) { if (!calc.POLITICAS.includes(p.politica)) return { erro: 'Política inválida' }; r.parametros.politica = p.politica; }
  if (p.arredondamento != null) { if (!calc.TERMINACOES.includes(p.arredondamento)) return { erro: 'Arredondamento inválido' }; r.parametros.arredondamento = p.arredondamento; }
  hist(r, 'parametros', usuario, { ...r.parametros });
  salvar(r);
  return recalcular(id, { descartarManuais: false });
}

function fechar(id, usuario, opts = {}) {
  const r = obter(id); if (!r) return null;
  if (r.status !== 'a_precificar') return { erro: 'Só registro "a precificar" pode ser fechado' };
  const bloq = r.itens.filter(i => i.status === 'bloqueado').length;
  if (bloq && !opts.ignorarBloqueados) return { erro: bloq + ' item(ns) bloqueado(s): cadastre a margem e recalcule, ou feche ignorando' };
  r.status = 'precificado'; r.fechadoEm = new Date().toISOString(); r.fechadoPor = usuario || null;
  hist(r, 'fechar', usuario, { bloqueados_ignorados: bloq });
  return salvar(r);
}
function reabrir(id, usuario) {
  const r = obter(id); if (!r) return null;
  if (!['precificado', 'aplicado', 'conferido'].includes(r.status)) return { erro: 'Registro já está aberto' };
  r.status = 'a_precificar'; delete r.aplicadoEm; delete r.divergentes; for (const i of r.itens) delete i.erp;
  hist(r, 'reabrir', usuario);
  return salvar(r);
}
function aplicar(id, usuario) {
  const r = obter(id); if (!r) return null;
  if (r.status !== 'precificado') return { erro: 'Feche a lista antes de marcar como aplicada' };
  r.status = 'aplicado'; r.aplicadoEm = new Date().toISOString(); r.aplicadoPor = usuario || null;
  hist(r, 'aplicar', usuario);
  return salvar(r);
}

const TOL_ERP = 0.011;   // R$0,01
async function verificar(id) {
  const r = obter(id); if (!r) return null;
  if (!['aplicado', 'conferido'].includes(r.status)) return { erro: 'Só registro aplicado pode ser verificado' };
  const cods = r.itens.filter(i => i.status !== 'bloqueado').map(i => i.cod);
  const erp = await dadosERP(r.loja, cods);
  let div = 0;
  for (const i of r.itens) {
    if (i.status === 'bloqueado') { delete i.erp; continue; }
    const p = erp.preco[i.cod];
    const okV = p != null && Math.abs(p.varejo - i.preco_final) < TOL_ERP;
    const okA = !i.atacado || (p != null && Math.abs(p.atacado - i.atacado.preco_final) < TOL_ERP);
    i.erp = { preco: p?.varejo ?? null, atacado: i.atacado ? (p?.atacado ?? null) : null, ok: okV && okA };
    if (!i.erp.ok) div++;
  }
  r.status = 'conferido'; r.divergentes = div; r.verificadoEm = new Date().toISOString();
  return salvar(r);
}
async function verificarTodos() {
  const lim = Date.now() - 7 * 86400000;
  let verificados = 0, divergentes = 0;
  for (const r of listar()) {
    if (!['aplicado', 'conferido'].includes(r.status)) continue;
    if (!r.aplicadoEm || new Date(r.aplicadoEm).getTime() < lim) continue;
    try { const v = await verificar(r.id); verificados++; divergentes += v.divergentes || 0; } catch (e) { console.error('[PRECIF] verificar', r.id, e.message); }
  }
  return { verificados, divergentes };
}
function removerTestes() { let n = 0; for (const r of listar()) if (r.teste) { try { fs.unlinkSync(arq(r.id)); n++; } catch (e) {} } return n; }
```

`module.exports = { init, initERP, setPadrao, getPadrao, criarDeConciliacao, recalcular, listar, obter, salvar, idDe, itensConciliados, rateioDe, editarItem, setParametros, fechar, reabrir, aplicar, verificar, verificarTodos, removerTestes };`

- [ ] **Step 4: Run tests** → `node --test test/` → todos passam (`# pass 21` no total: 14 + 7).

- [ ] **Step 5: Commit**

```bash
git add lib/precificacao.js test/precificacao-registro.test.js
git commit -m "Formação de Preço: editar item, política, fechar/aplicar/reabrir e verificação do preço no ERP

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: PDF por loja

**Files:**
- Modify: `lib/precificacao.js`

**Interfaces:**
- Produces: `gerarPdf(reg) → caminho` (arquivo `data/precificacao/<id>.pdf`), `caminhoPdf(id) → caminho|null`.

- [ ] **Step 1: Implement** (mesmo estilo de `gerarPdf` em `pedidos-fornecedor.js`, A4 retrato)

```js
const LOJAS_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };
const pdfPath = id => path.join(DIR, `${id}.pdf`);
function caminhoPdf(id) { const f = pdfPath(id); return fs.existsSync(f) ? f : null; }
function gerarPdf(r) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 28, info: { Title: `Formação de Preço ${r.id} - ${r.lista_nome}` } });
  const out = fs.createWriteStream(pdfPath(r.id)); doc.pipe(out);
  const brl = v => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dt = s => s ? new Date(s).toLocaleString('pt-BR') : '';
  const W = doc.page.width - 56, L = 28;
  doc.rect(L, 28, W, 64).fill('#101B33');
  try { doc.image(path.join(__dirname, '..', 'public', 'logo-supermercados.png'), 36, 31, { height: 26 }); } catch (e) {}
  doc.fillColor('#FFFFFF').fontSize(13).text(`Formação de Preço · Loja ${r.loja} ${LOJAS_NOMES[r.loja] || ''}`, 40, 60);
  doc.fontSize(8.5).fillColor('#C9D1E3').text(`Pedido #${r.pedidoId} · ${r.lista_nome} · ${r.fornecedor} · conciliado ${dt(r.conciliadoEm)} · política ${r.parametros.politica} · terminação ${r.parametros.arredondamento}`, 40, 76, { width: W - 24 });
  let y = 104;
  const l4 = r.loja === 4;
  const cols = l4 ? [[L, 62, 'Código'], [L + 62, 200, 'Descrição'], [L + 262, 60, 'Atual'], [L + 322, 60, 'Novo'], [L + 382, 60, 'Atac. atual'], [L + 442, 60, 'Atac. novo'], [L + 502, 37, 'Obs']]
                  : [[L, 70, 'Código'], [L + 70, 260, 'Descrição'], [L + 330, 70, 'Preço atual'], [L + 400, 70, 'Preço novo'], [L + 470, 69, 'Obs']];
  const cab = () => { doc.rect(L, y, W, 16).fill('#F5B800'); doc.fillColor('#101B33').fontSize(8); for (const [x, w, t] of cols) doc.text(t, x + 4, y + 4, { width: w - 8 }); y += 18; };
  const mudam = r.itens.filter(i => i.status === 'sobe' || i.status === 'desce' || (i.manual && i.preco_final !== i.preco_atual));
  doc.fillColor('#0E1626').fontSize(10).text(`${mudam.length} produto(s) mudam de preço`, L, y); y += 16;
  cab();
  doc.fontSize(8.5);
  for (const i of mudam) {
    if (y > doc.page.height - 60) { doc.addPage(); y = 40; cab(); doc.fontSize(8.5); }
    const obs = (i.status === 'desce' ? '▼' : i.status === 'sobe' ? '▲' : '') + (i.manual ? ' manual' : '') + (i.piso ? ' piso' : '');
    const vals = l4 ? [i.cod, i.descricao, brl(i.preco_atual), brl(i.preco_final), brl(i.preco_atacado_atual), brl(i.atacado?.preco_final), obs]
                    : [i.cod, i.descricao, brl(i.preco_atual), brl(i.preco_final), obs];
    doc.fillColor('#0E1626'); cols.forEach(([x, w], k) => doc.text(String(vals[k] ?? ''), x + 4, y, { width: w - 8, lineBreak: false }));
    y += 14; doc.moveTo(L, y - 2).lineTo(L + W, y - 2).strokeColor('#E4E4E0').lineWidth(.5).stroke();
  }
  const bloq = r.itens.filter(i => i.status === 'bloqueado');
  if (bloq.length) {
    y += 10; if (y > doc.page.height - 80) { doc.addPage(); y = 40; }
    doc.fillColor('#C22F49').fontSize(10).text(`${bloq.length} produto(s) sem preço (bloqueados)`, L, y); y += 14; doc.fontSize(8.5);
    for (const i of bloq) { if (y > doc.page.height - 50) { doc.addPage(); y = 40; } doc.fillColor('#0E1626').text(`${i.cod}  ${i.descricao}  — ${i.motivo}`, L, y, { width: W, lineBreak: false }); y += 13; }
  }
  doc.end();
  return pdfPath(r.id);
}
```

Exportar `gerarPdf, caminhoPdf, LOJAS_NOMES`.

- [ ] **Step 2: Smoke test manual**

```bash
node -e "
const pr=require('./lib/precificacao');const fs=require('fs');const os=require('os');const path=require('path');
pr.init({dir:fs.mkdtempSync(path.join(os.tmpdir(),'pp-'))});
const r={id:'1-L4',pedidoId:1,loja:4,lista_nome:'L',fornecedor:'F',conciliadoEm:null,parametros:{politica:'por_curva',arredondamento:'9'},itens:[{cod:'1',descricao:'ARROZ',status:'sobe',preco_atual:10,preco_final:11.99,preco_atacado_atual:9,atacado:{preco_final:10.49},manual:false,piso:false},{cod:'2',descricao:'X',status:'bloqueado',motivo:'sem margem'}]};
console.log(pr.gerarPdf(r));"
```
Expected: imprime um caminho `.pdf`; abrir o arquivo e ver cabeçalho navy, tabela com 1 linha e bloco vermelho de bloqueados.

- [ ] **Step 3: Commit**

```bash
git add lib/precificacao.js
git commit -m "Formação de Preço: PDF por loja (só itens que mudam + bloqueados)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Rotas e wiring no `server.js`

**Files:**
- Modify: `server.js` — após o bloco de `pedidosFornec` (linhas ~6068-6073) e antes de `app.listen` (~6314).

**Interfaces:**
- Consumes: todo o `lib/precificacao.js`; `pedidosFornec.setHooks`; `radarPedidos.curvaASet`.
- Produces (todas exigem login, como as demais rotas `/api/...`):
  ```
  GET  /api/precificacao?status=&loja=            → { padrao, registros:[{ id, pedidoId, loja, lista_nome, fornecedor, teste, status, criadoEm, conciliadoEm, aplicadoEm, parametros, resumo, divergentes }] }
  GET  /api/precificacao/:id                       → reg completo
  POST /api/precificacao/padrao {politica, arredondamento}
  POST /api/precificacao/:id/item {cod, preco_final?, preco_atacado_final?}
  POST /api/precificacao/:id/parametros {politica?, arredondamento?}
  POST /api/precificacao/:id/recalcular {descartarManuais?:bool}     (doERP:true)
  POST /api/precificacao/:id/fechar {ignorarBloqueados?:bool}
  POST /api/precificacao/:id/reabrir · /aplicar · /verificar
  POST /api/precificacao/verificar                 → { verificados, divergentes }
  POST /api/precificacao/remover-testes            → { removidos }
  GET  /api/precificacao/:id/pdf?refazer=1
  ```

- [ ] **Step 1: Wiring** — logo após a linha `pedidosFornec.initERP(q, radarPedidos);`:

```js
// ── Formação de Preço (sidebar "Precificação"): registro por pedido×loja quando a loja concilia o XML
const precificacao = require('./lib/precificacao');
precificacao.init();
precificacao.initERP(q, radarPedidos);
pedidosFornec.setHooks({ onConciliado: (p, ln) => precificacao.criarDeConciliacao(p, ln).catch(e => console.error('[PRECIF] criar', p.id, ln, e.message)) });
setTimeout(() => precificacao.verificarTodos().catch(e => console.error('[PRECIF] verificar:', e.message)), 120 * 1000);
setInterval(() => precificacao.verificarTodos().catch(e => console.error('[PRECIF] verificar:', e.message)), 60 * 60 * 1000);
```

- [ ] **Step 2: Rotas** — antes de `const server = app.listen(3003, ...)`:

```js
// ── rotas Formação de Preço
const precifUser = req => req.session.user?.nome || null;
const precifResp = (res, r) => { if (!r) return res.status(404).json({ error: 'Registro não encontrado' }); if (r.erro) return res.status(400).json({ error: r.erro }); res.json(r); };
app.get('/api/precificacao', (req, res) => {
  let regs = precificacao.listar();
  if (req.query.status) regs = regs.filter(r => r.status === req.query.status);
  if (req.query.loja) regs = regs.filter(r => r.loja === parseInt(req.query.loja));
  res.json({ padrao: precificacao.getPadrao(), registros: regs.map(r => ({ id: r.id, pedidoId: r.pedidoId, loja: r.loja, lista: r.lista, lista_nome: r.lista_nome, fornecedor: r.fornecedor, teste: r.teste, status: r.status, criadoEm: r.criadoEm, conciliadoEm: r.conciliadoEm, aplicadoEm: r.aplicadoEm || null, parametros: r.parametros, resumo: r.resumo, divergentes: r.divergentes ?? null, rateio_disponivel: !!r.rateio?.disponivel })) });
});
app.post('/api/precificacao/padrao', (req, res) => res.json(precificacao.setPadrao(req.body || {})));
app.post('/api/precificacao/verificar', async (req, res) => { try { res.json(await precificacao.verificarTodos()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/precificacao/remover-testes', (req, res) => res.json({ removidos: precificacao.removerTestes() }));
app.get('/api/precificacao/:id', (req, res) => precifResp(res, precificacao.obter(req.params.id)));
app.post('/api/precificacao/:id/item', (req, res) => precifResp(res, precificacao.editarItem(req.params.id, req.body?.cod, req.body || {}, precifUser(req))));
app.post('/api/precificacao/:id/parametros', async (req, res) => { try { precifResp(res, await precificacao.setParametros(req.params.id, req.body || {}, precifUser(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/precificacao/:id/recalcular', async (req, res) => { try { precifResp(res, await precificacao.recalcular(req.params.id, { doERP: true, descartarManuais: !!req.body?.descartarManuais })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/precificacao/:id/fechar', (req, res) => precifResp(res, precificacao.fechar(req.params.id, precifUser(req), { ignorarBloqueados: !!req.body?.ignorarBloqueados })));
app.post('/api/precificacao/:id/reabrir', (req, res) => precifResp(res, precificacao.reabrir(req.params.id, precifUser(req))));
app.post('/api/precificacao/:id/aplicar', (req, res) => precifResp(res, precificacao.aplicar(req.params.id, precifUser(req))));
app.post('/api/precificacao/:id/verificar', async (req, res) => { try { precifResp(res, await precificacao.verificar(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/precificacao/:id/pdf', (req, res) => {
  const r = precificacao.obter(req.params.id); if (!r) return res.status(404).json({ error: 'Registro não encontrado' });
  let f = precificacao.caminhoPdf(r.id);
  if (!f || req.query.refazer === '1') { try { f = precificacao.gerarPdf(r); } catch (e) { return res.status(500).json({ error: e.message }); } }
  setTimeout(() => res.sendFile(f, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="formacao-preco-${r.id}.pdf"` } }), 150);
});
```

Também: em `removerTestesXml` do `pedidos-fornecedor` não mexer; a rota `/api/pedidos-fornecedor/testes-xml/remover` (server.js ~6177) passa a chamar também `precificacao.removerTestes()`:
```js
  try { const n = pedidosFornec.removerTestesXml(); const np = precificacao.removerTestes(); res.json({ removidos: n, precificacao_removidos: np }); }
```
(ajustar a linha existente mantendo o `catch` que já está lá).

- [ ] **Step 3: Verificar que o server sobe**

Run: `node -e "process.env.PORT=0; require('./server.js')"` por 5 s (ou `node server.js` e Ctrl+C). Expected: sem `TypeError`; log normal de inicialização. Se a conexão MySQL falhar localmente é esperado (só o .254 tem acesso); o que importa é não haver erro de sintaxe/require.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Formação de Preço: rotas /api/precificacao, hook na conciliação XML e verificação agendada

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Sidebar

**Files:**
- Modify: `public/nav.js:62-72` (ITENS, bloco Operação)

- [ ] **Step 1: Inserir o item** entre o grupo `compras` (fecha em `]},` depois de "Sugestão de Compras") e `{ id: 'prevencao', ...`:

```js
    { href: '/formacao-de-preco.html', ic: 'trend', txt: 'Precificação' },
```

(Ordem alfabética do bloco: CAHU Distribuidora · Financeiro · Gestão de Compras · **Precificação** · Prevenção · Processos. Não há ícone de etiqueta no sprite; `trend` fica até alguém desenhar um `tag`.)

- [ ] **Step 2: Verificar** abrindo qualquer página local (`node server.js` + navegador, ou `python -m http.server` em `public/`): o rail mostra "Precificação" entre Gestão de Compras e Prevenção, sem acordeão.

- [ ] **Step 3: Commit**

```bash
git add public/nav.js
git commit -m "Menu lateral: item Precificação (Formação de Preço)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Tela `public/formacao-de-preco.html`

**Files:**
- Create: `public/formacao-de-preco.html`

**Interfaces:**
- Consumes: as rotas da Task 8. Padrão visual e helpers copiados de `public/pedidos-compra.html` (CSS das classes `.main .page-hdr .btn .totais .tkpi .tools .tbl #pv .pv-card .pv-top`).

- [ ] **Step 1: Escrever a página**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/design-system.css">
<script src="/nav.js" defer></script>
<title>Formação de Preço — Econômico Relatórios</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'InterVar','Segoe UI',sans-serif;background:#EBEBE9;color:#0E1626;min-height:100vh;font-variant-numeric:tabular-nums}
.main{padding:24px}
.page-hdr{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px;gap:12px;flex-wrap:wrap}
.page-hdr h1{font-size:21px;font-weight:800;letter-spacing:-.3px}
.page-hdr p{font-size:12px;color:#4E5A72;margin-top:2px;max-width:72ch}
.btn{border:none;border-radius:8px;padding:9px 16px;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit;text-decoration:none;display:inline-block}
.btn-amber{background:#F5B800;color:#6B4E00}.btn-amber:hover{background:#E5AC00}
.btn-slate{background:#FFFFFF;border:1px solid #C9C9C4;color:#4E5A72}.btn-slate:hover{background:#DADAD6}
.btn-green{background:#137A48;color:#fff}.btn-green:hover{background:#0F6339}
.btn-red{background:#fff;border:1px solid #E5B4BD;color:#C22F49}.btn-red:hover{background:#FBEAED}
.btn-sm{padding:5px 11px;font-size:11.5px;margin-left:6px}
.btn:disabled{opacity:.5;cursor:default}
.totais{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.tkpi{background:#FFFFFF;border:1px solid #DADAD6;border-radius:10px;padding:11px 16px;cursor:pointer;border-bottom:3px solid transparent}
.tkpi.on{border-bottom-color:#F5B800}
.tkpi .v{font-size:19px;font-weight:800;letter-spacing:-.3px}
.tkpi .l{font-size:9.5px;color:#98A0B3;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-top:2px}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.tools select,.tools input{font-family:inherit;font-size:12px;padding:7px 10px;border:1px solid #C9C9C4;border-radius:8px;background:#fff}
.tools label{font-size:11px;color:#4E5A72;font-weight:700}
.card{background:#fff;border:1px solid #DADAD6;border-radius:12px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#F4F4F2;text-align:left;padding:9px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:#4E5A72;white-space:nowrap}
td{padding:9px 10px;border-top:1px solid #ECECEA;vertical-align:middle;white-space:nowrap}
td.n,th.n{text-align:right}
tr.click{cursor:pointer}tr.click:hover td{background:#FBF7EA}
.st{padding:3px 9px;border-radius:99px;font-weight:700;font-size:10.5px;display:inline-block}
.st-a_precificar{background:#FFF1C2;color:#6B4E00}.st-precificado{background:#DCEBFF;color:#1B4E9B}.st-aplicado{background:#DDF3E6;color:#137A48}.st-conferido{background:#DDF3E6;color:#137A48}.st-div{background:#FBEAED;color:#C22F49}
.i-sobe{color:#C22F49;font-weight:700}.i-desce{color:#137A48;font-weight:700}.i-mantem{color:#4E5A72}.i-sem_mudanca{color:#98A0B3}.i-bloqueado{color:#C22F49}
.mut{color:#98A0B3}.sm{font-size:11px}
.tag{font-size:9.5px;font-weight:800;padding:2px 6px;border-radius:5px;background:#101B33;color:#FFC933;margin-left:4px}
.tag.teste{background:#E9E9FF;color:#3B3B8F}
.empty{padding:40px;text-align:center;color:#98A0B3}
input.pf{width:86px;text-align:right;font-family:inherit;font-size:12px;padding:5px 7px;border:1px solid #C9C9C4;border-radius:6px}
input.pf.manual{border-color:#F5B800;background:#FFF9E5}
tr.bloq td{background:#FFF4F6}
#pv{position:fixed;inset:0;background:rgba(14,22,38,.55);z-index:1000;overflow:auto;padding:24px}
.pv-card{background:#fff;border-radius:14px;max-width:1240px;margin:0 auto;padding:22px 26px 30px;box-shadow:0 20px 60px -20px rgba(0,0,0,.5)}
.pv-top{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;border-bottom:3px solid #F5B800;padding-bottom:12px;margin-bottom:14px}
.pv-top h2{font-size:18px;font-weight:800;letter-spacing:-.3px}.pv-sub{font-size:12px;color:#4E5A72;margin-top:4px;max-width:80ch}
.pv-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}
.aviso{background:#FFF1C2;border:1px solid #F5B800;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px}
@media(max-width:700px){.main{padding:14px}.pv-card{padding:14px}}
</style>
</head>
<body>
<div class="main">
  <div class="page-hdr">
    <div><h1>Formação de Preço</h1><p>Cada loja que concilia o XML entra aqui sozinha. O sistema calcula o preço de venda pelo custo com imposto e pela margem cadastrada. Nada é gravado no ERP: feche a lista, digite no Dlinks e marque como aplicada. Depois o sistema confere se o preço bateu.</p></div>
    <div>
      <button class="btn btn-slate" onclick="verificarTodos()">Verificar no ERP</button>
      <button class="btn btn-red btn-sm" onclick="removerTestes()">Remover testes</button>
    </div>
  </div>
  <div class="totais" id="totais"></div>
  <div class="tools">
    <label>Loja</label><select id="f-loja" onchange="render()"><option value="">Todas</option><option value="1">1 · CAHU</option><option value="2">2 · MURIBECA</option><option value="3">3 · PONTE</option><option value="4">4 · ATACAREJO</option><option value="5">5 · PORTA LARGA</option><option value="6">6 · JARDIM JORDÃO</option></select>
    <input id="f-busca" placeholder="pedido, lista, fornecedor" oninput="render()" style="min-width:220px">
    <span style="flex:1"></span>
    <label>Padrão pra novos:</label>
    <select id="p-politica" onchange="salvarPadrao()"><option value="por_curva">Por curva (A repassa)</option><option value="manter">Manter preço</option><option value="repassar">Repassar queda</option></select>
    <select id="p-arred" onchange="salvarPadrao()"><option value="9">Terminação 9</option><option value="5">Terminação 5</option><option value="nenhum">Sem arredondar</option></select>
  </div>
  <div class="card" id="view"><div class="empty">Carregando…</div></div>
</div>
<div id="pv" hidden><div class="pv-card" id="pv-body"></div></div>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const brl=v=>v==null?'—':'R$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const pct=v=>v==null?'—':((v>0?'+':'')+(v*100).toFixed(1)+'%');
const dt=s=>s?new Date(s).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const LOJAS={1:'CAHU',2:'MURIBECA',3:'PONTE',4:'ATACAREJO',5:'PORTA LARGA',6:'JARDIM JORDÃO'};
const STN={a_precificar:'A precificar',precificado:'Precificado',aplicado:'Aplicado',conferido:'Conferido'};
const POL={por_curva:'por curva',manter:'manter',repassar:'repassar'};
let LISTA=[],PADRAO=null,filtro='a_precificar',REG=null,filtroItem='mudam';

// body definido (mesmo {}) → POST; sem body → GET
async function api(url,body){const r=await fetch(url,body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{method:'GET'});const j=await r.json();if(j.error)throw new Error(j.error);return j;}
async function carregar(){
  try{const j=await api('/api/precificacao');LISTA=j.registros;PADRAO=j.padrao;$('#p-politica').value=PADRAO.politica;$('#p-arred').value=PADRAO.arredondamento;}
  catch(e){$('#view').innerHTML='<div class="empty">Erro: '+esc(e.message)+'</div>';return;}
  renderTotais();render();
}
function grupo(r){return r.status==='conferido'&&r.divergentes>0?'divergente':r.status;}
function renderTotais(){
  const c={a_precificar:0,precificado:0,aplicado:0,divergente:0,bloqueados:0};
  for(const r of LISTA){const g=grupo(r);if(g==='conferido')c.aplicado++;else if(c[g]!=null)c[g]++;c.bloqueados+=r.resumo?.bloqueados||0;}
  const k=[['a_precificar','A precificar',c.a_precificar],['precificado','Precificados',c.precificado],['aplicado','Aplicados',c.aplicado],['divergente','Divergentes',c.divergente],['bloq','Itens bloqueados',c.bloqueados],['todos','Todos',LISTA.length]];
  $('#totais').innerHTML=k.map(([id,l,v])=>'<div class="tkpi'+(filtro===id?' on':'')+'" onclick="filtro=\''+id+'\';renderTotais();render()"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>').join('');
}
function render(){
  const loja=$('#f-loja').value,b=$('#f-busca').value.trim().toLowerCase();
  let rows=LISTA.filter(r=>{
    const g=grupo(r);
    if(filtro==='aplicado'&&!(g==='aplicado'||g==='conferido'))return false;
    if(filtro==='bloq'&&!(r.resumo?.bloqueados>0))return false;
    if(!['todos','aplicado','bloq'].includes(filtro)&&g!==filtro)return false;
    if(loja&&String(r.loja)!==loja)return false;
    if(b&&!(String(r.pedidoId)+' '+r.lista_nome+' '+r.fornecedor).toLowerCase().includes(b))return false;
    return true;});
  if(!rows.length){$('#view').innerHTML='<div class="empty">Nada aqui. Registros entram sozinhos quando uma loja concilia o XML em Pedidos de Compra.</div>';return;}
  $('#view').innerHTML='<table><thead><tr><th>#</th><th>Loja</th><th>Lista / Fornecedor</th><th>Conciliado</th><th class="n">Itens</th><th class="n">Sobem</th><th class="n">Descem</th><th class="n">Mantêm</th><th class="n">Sem mud.</th><th class="n">Bloq.</th><th>Política</th><th>Status</th><th>Ação</th></tr></thead><tbody>'+
    rows.map(r=>{const s=r.resumo||{};const g=grupo(r);return '<tr class="click" onclick="abrir(\''+r.id+'\')"><td>'+r.pedidoId+'</td><td><b>L'+r.loja+'</b> <span class="mut sm">'+LOJAS[r.loja]+'</span></td><td><b>'+esc(r.lista_nome)+'</b>'+(r.teste?'<span class="tag teste">TESTE</span>':'')+'<div class="mut sm">'+esc(r.fornecedor)+'</div></td><td class="sm">'+dt(r.conciliadoEm)+'</td><td class="n">'+(s.itens||0)+'</td><td class="n i-sobe">'+(s.sobem||0)+'</td><td class="n i-desce">'+(s.descem||0)+'</td><td class="n">'+(s.mantem||0)+'</td><td class="n mut">'+(s.sem_mudanca||0)+'</td><td class="n '+(s.bloqueados?'i-bloqueado':'mut')+'">'+(s.bloqueados||0)+'</td><td class="sm">'+POL[r.parametros.politica]+' · '+r.parametros.arredondamento+'</td><td><span class="st st-'+(g==='divergente'?'div':r.status)+'">'+(g==='divergente'?r.divergentes+' divergente(s)':STN[r.status])+'</span></td><td onclick="event.stopPropagation()"><a class="btn btn-slate btn-sm" target="_blank" href="/api/precificacao/'+r.id+'/pdf">PDF</a></td></tr>';}).join('')+'</tbody></table>';
}
async function salvarPadrao(){try{await api('/api/precificacao/padrao',{politica:$('#p-politica').value,arredondamento:$('#p-arred').value});}catch(e){alert(e.message);}}
async function verificarTodos(){try{const j=await api('/api/precificacao/verificar',{});await carregar();alert('Verificados '+j.verificados+' registro(s), '+j.divergentes+' item(ns) divergente(s).');}catch(e){alert(e.message);}}
async function removerTestes(){if(!confirm('Remover os registros de teste?'))return;try{const j=await api('/api/precificacao/remover-testes',{});await carregar();alert('Removidos '+j.removidos+'.');}catch(e){alert(e.message);}}

// ── detalhe
function abrirPv(x){$('#pv-body').innerHTML=x;$('#pv').hidden=false;}
function fecharPv(){$('#pv').hidden=true;REG=null;}
async function abrir(id){abrirPv('<div class="pv-top"><h2>Carregando…</h2><button class="btn btn-amber" onclick="fecharPv()">Fechar</button></div>');try{REG=await api('/api/precificacao/'+id);}catch(e){abrirPv('<div class="empty">'+esc(e.message)+'</div>');return;}renderPv();}
function renderPv(){
  const r=REG,s=r.resumo||{},aberto=r.status==='a_precificar',l4=r.loja===4,conf=['aplicado','conferido'].includes(r.status);
  const itens=r.itens.filter(i=>filtroItem==='tudo'||(filtroItem==='bloq'?i.status==='bloqueado':(i.status==='sobe'||i.status==='desce'||i.manual)));
  let h='<div class="pv-top"><div><div style="font-size:10px;font-weight:800;letter-spacing:.1em;color:#6B4E00">FORMAÇÃO DE PREÇO · LOJA '+r.loja+' '+LOJAS[r.loja]+'</div><h2>Pedido #'+r.pedidoId+' · '+esc(r.lista_nome)+(r.teste?'<span class="tag teste">TESTE</span>':'')+'</h2><div class="pv-sub">'+esc(r.fornecedor)+' · conciliado '+dt(r.conciliadoEm)+' · <span class="st st-'+r.status+'">'+STN[r.status]+'</span>'+(r.divergentes?' · <span class="st st-div">'+r.divergentes+' divergente(s) no ERP</span>':'')+'</div></div><button class="btn btn-amber" onclick="fecharPv()">Fechar</button></div>';
  if(!r.rateio||!r.rateio.disponivel)h+='<div class="aviso">Impostos não disponíveis no XML desta nota: custo com imposto = custo do XML.</div>';
  else h+='<div class="aviso" style="background:#F4F4F2;border-color:#DADAD6">Rateio de impostos: frete '+brl(r.rateio.frete)+' + IPI '+brl(r.rateio.ipi)+' + ST '+brl(r.rateio.st)+' − desconto '+brl(r.rateio.desconto)+' sobre '+brl(r.rateio.valorProduto)+' de produtos = <b>'+pct(r.rateio.fator)+'</b> sobre o custo.</div>';
  h+='<div class="pv-tools"><label class="sm">Política</label><select id="d-pol" '+(aberto?'':'disabled')+' onchange="setParam()"><option value="por_curva">Por curva (A repassa)</option><option value="manter">Manter preço</option><option value="repassar">Repassar queda</option></select>'+
     '<select id="d-arr" '+(aberto?'':'disabled')+' onchange="setParam()"><option value="9">Terminação 9</option><option value="5">Terminação 5</option><option value="nenhum">Sem arredondar</option></select>'+
     '<span class="sm mut">'+s.itens+' itens · <span class="i-sobe">'+s.sobem+' sobem</span> · <span class="i-desce">'+s.descem+' descem</span> · '+s.mantem+' mantêm · '+s.sem_mudanca+' sem mudança · <span class="'+(s.bloqueados?'i-bloqueado':'mut')+'">'+s.bloqueados+' bloqueados</span></span><span style="flex:1"></span>'+
     '<select id="d-fil" onchange="filtroItem=this.value;renderPv()"><option value="mudam">Só o que muda</option><option value="tudo">Tudo</option><option value="bloq">Bloqueados</option></select>'+
     (aberto?'<button class="btn btn-slate btn-sm" onclick="recalc(false)">Recalcular (ERP)</button><button class="btn btn-slate btn-sm" onclick="recalc(true)">Descartar edições</button><button class="btn btn-green btn-sm" onclick="fechar()">Fechar lista</button>':'')+
     (r.status==='precificado'?'<button class="btn btn-green btn-sm" onclick="acao(\'aplicar\')">Marcar como aplicado</button>':'')+
     (conf?'<button class="btn btn-slate btn-sm" onclick="acao(\'verificar\')">Verificar agora</button>':'')+
     (aberto?'':'<button class="btn btn-red btn-sm" onclick="acao(\'reabrir\')">Reabrir</button>')+
     '<a class="btn btn-slate btn-sm" target="_blank" href="/api/precificacao/'+r.id+'/pdf?refazer=1">PDF</a><button class="btn btn-slate btn-sm" onclick="whats()">WhatsApp</button></div>';
  h+='<div class="card"><table><thead><tr><th>Código</th><th>Descrição</th><th>Curva</th><th class="n">Qtd</th><th class="n">Custo atual</th><th class="n">Custo novo</th><th class="n">C/ imposto</th><th class="n">Var.</th><th class="n">Margem cad.</th><th class="n">Preço atual</th><th class="n">Marg. se mantém</th><th class="n">Sugerido</th><th class="n">Preço final</th>'+(l4?'<th class="n">Atac. atual</th><th class="n">Atac. final</th>':'')+(conf?'<th class="n">No ERP</th>':'')+'<th>Status</th></tr></thead><tbody>';
  if(!itens.length)h+='<tr><td colspan="20" class="empty">Nenhum item neste filtro.</td></tr>';
  for(const i of itens){
    const bl=i.status==='bloqueado';
    h+='<tr class="'+(bl?'bloq':'')+'"><td>'+esc(i.cod)+'</td><td>'+esc(i.descricao)+(i.nao_pedido?'<span class="tag">não pedido</span>':'')+'</td><td>'+(i.curvaA?'<b>A</b>':'<span class="mut">—</span>')+'</td><td class="n">'+i.recebida+'</td><td class="n">'+brl(i.custo_atual)+'</td><td class="n">'+brl(i.custo_novo)+'</td><td class="n"><b>'+brl(i.custo_imposto)+'</b></td><td class="n '+(i.variacao>0?'i-sobe':i.variacao<0?'i-desce':'mut')+'">'+(i.variacao>0?'▲ ':i.variacao<0?'▼ ':'')+pct(i.variacao)+'</td><td class="n">'+(i.margem!=null?i.margem+'%':'<span class="i-bloqueado">sem margem</span>')+'</td><td class="n">'+brl(i.preco_atual)+'</td><td class="n mut">'+pct(i.margem_se_mantem)+'</td><td class="n">'+brl(i.preco_sugerido)+(i.piso?' <span class="sm i-bloqueado">piso</span>':'')+'</td>'+
       '<td class="n">'+(bl?'—':(aberto?'<input class="pf'+(i.manual?' manual':'')+'" value="'+Number(i.preco_final).toFixed(2)+'" onchange="editar(\''+esc(i.cod)+'\',this.value,null)">':'<b>'+brl(i.preco_final)+'</b>'+(i.manual?' <span class="sm mut">manual</span>':'')))+'</td>'+
       (l4?'<td class="n">'+brl(i.preco_atacado_atual)+'</td><td class="n">'+(i.atacado?(aberto?'<input class="pf" value="'+Number(i.atacado.preco_final).toFixed(2)+'" onchange="editar(\''+esc(i.cod)+'\',null,this.value)">':'<b>'+brl(i.atacado.preco_final)+'</b>'):'<span class="mut">—</span>')+'</td>':'')+
       (conf?'<td class="n '+(i.erp?(i.erp.ok?'i-desce':'i-bloqueado'):'mut')+'">'+(i.erp?brl(i.erp.preco)+(i.erp.ok?' ✓':' ✗'):'—')+'</td>':'')+
       '<td class="i-'+i.status+'">'+({sobe:'sobe',desce:'desce',mantem:'mantém',sem_mudanca:'sem mudança',bloqueado:'bloqueado'}[i.status])+(bl?'<div class="sm">'+esc(i.motivo)+(/margem/.test(i.motivo||'')?' · <a href="/fornecedores.html?aba=cadastro-pendente">Cadastro Pendente</a>':'')+'</div>':'')+'</td></tr>';
  }
  h+='</tbody></table></div>';
  abrirPv(h);$('#d-pol').value=r.parametros.politica;$('#d-arr').value=r.parametros.arredondamento;$('#d-fil').value=filtroItem;
}
async function editar(cod,pf,pa){try{const b={cod};if(pf!=null)b.preco_final=String(pf).replace(',','.');if(pa!=null)b.preco_atacado_final=String(pa).replace(',','.');REG=await api('/api/precificacao/'+REG.id+'/item',b);}catch(e){alert(e.message);}renderPv();}
async function setParam(){try{REG=await api('/api/precificacao/'+REG.id+'/parametros',{politica:$('#d-pol').value,arredondamento:$('#d-arr').value});}catch(e){alert(e.message);}renderPv();}
async function recalc(desc){if(desc&&!confirm('Descartar todas as edições manuais e recalcular?'))return;try{REG=await api('/api/precificacao/'+REG.id+'/recalcular',{descartarManuais:desc});}catch(e){alert(e.message);}renderPv();}
async function fechar(){
  try{REG=await api('/api/precificacao/'+REG.id+'/fechar',{});}
  catch(e){if(/bloqueado/.test(e.message)&&confirm(e.message+'\n\nFechar mesmo assim, deixando os bloqueados de fora?')){try{REG=await api('/api/precificacao/'+REG.id+'/fechar',{ignorarBloqueados:true});}catch(e2){alert(e2.message);}}else alert(e.message);}
  renderPv();carregar();
}
async function acao(a){if(a==='reabrir'&&!confirm('Reabrir esta lista pra edição?'))return;try{REG=await api('/api/precificacao/'+REG.id+'/'+a,{});}catch(e){alert(e.message);}renderPv();carregar();}
function whats(){
  const r=REG,s=r.resumo||{};const num=prompt('WhatsApp de quem vai digitar no Dlinks (DDD+número):');if(!num)return;
  const link=location.origin+'/api/precificacao/'+r.id+'/pdf';
  const txt='Formação de Preço · Loja '+r.loja+' '+LOJAS[r.loja]+'\nPedido #'+r.pedidoId+' · '+r.lista_nome+'\n'+s.sobem+' sobem, '+s.descem+' descem'+(s.bloqueados?', '+s.bloqueados+' bloqueados':'')+'\nPDF (precisa estar logado): '+link;
  window.open('https://wa.me/55'+num.replace(/\D/g,'')+'?text='+encodeURIComponent(txt),'_blank');
}
carregar();
</script>
</body>
</html>
```

- [ ] **Step 2: Conferir o `api()` helper**: `body` definido (inclusive `{}`) → POST; sem `body` → GET. Todas as ações passam `{}`; `carregar()` e `abrir(id)` não passam.

- [ ] **Step 3: Teste manual local sem ERP**

1. `node server.js` (porta 3003). Login.
2. Em Pedidos de Compra → "Criar testes XML" (cria #N conciliado, etc.) → "Verificar recebimentos". O hook cria os registros de precificação das lojas conciliadas (itens ficam **bloqueados** "não casado no ERP" se o MySQL não responder localmente; no .254 vêm com preço/custo/margem reais — os códigos `TESTE000x` não existem no ERP, então em produção também ficam bloqueados: é o esperado pros testes).
3. Abrir Precificação: registros aparecem; abrir o detalhe; trocar terminação; fechar ignorando bloqueados; aplicar; verificar; reabrir; PDF abre.
4. "Remover testes" limpa.

- [ ] **Step 4: Commit**

```bash
git add public/formacao-de-preco.html
git commit -m "Formação de Preço: tela (lista por pedido×loja, detalhe com três custos, política, edição e PDF)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Registro de teste com dados que passam pelo cálculo (pra ver a tela cheia)

**Files:**
- Modify: `lib/precificacao.js` (função `criarTeste`), `server.js` (rota), `public/formacao-de-preco.html` (botão)

Motivo: os pedidos de teste da conferência usam códigos `TESTE000x` que não existem no ERP, então tudo fica bloqueado e a tela não mostra o cálculo. Um registro de teste com entradas prontas (sem ERP) resolve.

- [ ] **Step 1: `criarTeste()` em `lib/precificacao.js`**

```js
function criarTeste(usuario) {
  const id = 'T' + Date.now().toString().slice(-6) + '-L4';
  const E = (cod, descricao, curvaA, ca, cn, m, pa, ma, paa) => ({ cod, descricao, curvaA, recebida: 12, nao_pedido: false, custo_atual: ca, custo_novo: cn, custo_imposto: +(cn * 1.04).toFixed(4), margem: m, preco_atual: pa, margem_atacado: ma, preco_atacado_atual: paa });
  const reg = { id, pedidoId: 0, loja: 4, lista: 0, lista_nome: 'TESTE FORMAÇÃO DE PREÇO', fornecedor: 'FORNECEDOR TESTE', teste: true, status: 'a_precificar', criadoEm: new Date().toISOString(), conciliadoEm: new Date().toISOString(),
    parametros: { ...padrao }, rateio: { frete: 20, ipi: 0, st: 28, desconto: 0, valorProduto: 1200, fator: 0.04, disponivel: true },
    entradas: [
      E('7891000100103', 'ARROZ TIPO 1 5KG (curva A, custo subiu)', true, 22.90, 24.50, 18, 27.99, 12, 26.49),
      E('7891000100110', 'FEIJÃO CARIOCA 1KG (curva A, custo caiu)', true, 7.80, 6.90, 25, 9.99, 15, 9.29),
      E('7891000100127', 'BISCOITO 400G (não é A, custo caiu)', false, 4.10, 3.60, 35, 5.69, 20, 5.19),
      E('7891000100134', 'DETERGENTE 500ML (sem mudança)', false, 1.90, 1.83, 40, 2.69, null, null),
      E('7891000100141', 'SABÃO EM PÓ 1KG (sem margem cadastrada)', false, 8.20, 8.90, null, 11.49, null, null),
      E('7891000100158', 'AZEITE 500ML (produto novo na loja)', false, null, 24.00, 30, null, null, null)
    ], itens: [], resumo: null, historico: [{ acao: 'criado', por: usuario || null, em: new Date().toISOString(), teste: true }] };
  calc.calcularRegistro(reg);
  return salvar(reg);
}
```
Exportar `criarTeste`. (`removerTestes` já apaga por `r.teste`.)

- [ ] **Step 2: Rota** em `server.js`, junto das outras de precificação:

```js
app.post('/api/precificacao/criar-teste', (req, res) => res.json(precificacao.criarTeste(precifUser(req))));
```

- [ ] **Step 3: Botão** no `page-hdr` da tela, antes de "Remover testes":

```html
<button class="btn btn-slate btn-sm" onclick="criarTeste()">Criar teste</button>
```
e no script:
```js
async function criarTeste(){try{const r=await api('/api/precificacao/criar-teste',{});await carregar();abrir(r.id);}catch(e){alert(e.message);}}
```

- [ ] **Step 4: Verificar na tela**: registro L4 com 6 itens: arroz sobe (▲), feijão desce (curva A), biscoito mantém, detergente sem mudança, sabão bloqueado, azeite sobe com margem-se-mantém "—". Colunas de atacado preenchidas nos 3 primeiros.

- [ ] **Step 5: Commit**

```bash
git add lib/precificacao.js server.js public/formacao-de-preco.html
git commit -m "Formação de Preço: registro de teste com os 6 casos do cálculo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Verificação final, memória e handoff

- [ ] **Step 1: Suite completa** — `node --test test/` → tudo verde (as suites antigas de pedidos-cd/radar continuam passando).
- [ ] **Step 2: Carga do server sem erro de require** — `node -e "require('./lib/precificacao');require('./lib/precificacao-calc');console.log('ok')"`.
- [ ] **Step 3: Atualizar memória** (`C:\Users\tiago\.claude\projects\C--Users-tiago\memory\`): novo arquivo `project_economico-formacao-de-preco.md` (o que está feito, decisões: 3 custos, política, arredondamento, sem escrita no ERP, caminho 1 escolhido, Fase "gravar no ERP" pendente de decisão) + linha no `MEMORY.md`. Colunas de imposto usadas: `axml.ValorFrete/ValorIPI/ValorICMSsub/ValorDesconto/ValorProduto` (cabeçalho, rateado por item).
- [ ] **Step 4: Não fazer push nem deploy.** Avisar o Tiago: `git push origin main` + bater no endpoint de deploy do .254; depois abrir Precificação, "Criar teste", e nos pedidos de teste XML conferir que as lojas conciliadas geraram registro.

---

## Self-review

- **Spec coverage:** sidebar (T9) · entrada automática por loja/`aceitarLojaXml` (T4, T8) · três custos e rateio (T5) · política/arredondamento/piso/sem_mudança/bloqueado (T2) · status a_precificar→precificado→aplicado→conferido e reabrir (T6) · preservar edições manuais e "descartar" (T3, T6, T10) · tela com colunas da spec, filtros, cards, WhatsApp (T10) · PDF por loja (T7) · verificação agendada 2 min/60 min (T8) · testes entram e somem com "Remover testes" (T5 `teste`, T8 rota) · atacado L4 (T2, T5, T10) · link pro Cadastro Pendente (T10) · não escreve no ERP (só SELECT em T5/T6).
- **Ajuste em relação à spec:** a spec pedia PDF "retrato A4" e verificação "a cada 60 min" — atendido. A spec citava uma tarefa de `DESCRIBE axmlprodutos`: não é necessária, os totais de frete/IPI/ST/desconto já vêm do cabeçalho `axml` em `buscarNotas` (rateio por valor do item, como a spec previa como alternativa). Diferença: o rateio usa `preco_xml` (= ValorTotal/unidades) como base, que é o valor bruto do item; o desconto entra pelo cabeçalho.
- **Type consistency:** `curvaASet()` (T4) usado em T5; `calcularRegistro(reg, {descartarManuais})` (T3) usado em T5/T6; `dadosERP` retorna `{preco:{cod:{varejo,atacado}}, custo, margem:{cod:{varejo,atacado}}, existe}` e é consumido igual em `montarEntradas`, `recalcular` e `verificar`; `setHooks` (T4) usado em T8; rotas de T8 batem com as chamadas em T10 (`/item`, `/parametros`, `/recalcular`, `/fechar`, `/reabrir`, `/aplicar`, `/verificar`, `/pdf`, `/padrao`, `/verificar`, `/remover-testes`, `/criar-teste`).
