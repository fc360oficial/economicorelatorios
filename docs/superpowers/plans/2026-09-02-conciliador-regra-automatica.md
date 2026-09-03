# Regra Automática de Conciliação — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o Conciliador Bancário criar regras permanentes (alias fornecedor / auto-dispensar) a partir de uma confirmação manual com senha, restrita a usuários `admin`, pra beneficiários recorrentes não caírem em conferência manual todo mês.

**Architecture:** Uma nova etapa `aplicarRegras()` em `lib/conciliador.js` intercepta, antes do motor de match `conciliar()` já existente, só as saídas cujo beneficiário bate com uma regra salva — o resto segue pro `conciliar()` sem nenhuma mudança de comportamento. Regras persistem em `data/regras-conciliacao.json` (JSON local, mesmo padrão de `conciliacoes-avulsas.json`, nunca no MySQL do ERP). A criação de regra exige reautenticação (senha de login do próprio usuário, comparada via bcrypt) num novo endpoint guardado por `requireAdmin`.

**Tech Stack:** Node.js/Express (`server.js` monolito), `bcryptjs`, JSON como armazenamento local, frontend vanilla JS server-rendered em `public/conciliador.html`. Sem framework de testes automatizado no projeto — todo task usa verificação manual (via `node -e`/curl/browser), seguindo o mesmo padrão dos specs anteriores deste repo.

## Global Constraints

- Nunca escrever no MySQL do ERP (`central`/`loja20045` são somente leitura) — regras e avulsos são sempre JSON local.
- A senha de reautenticação é sempre a própria senha de login do usuário logado (`bcrypt.compare` contra `usuarios.json`), nunca uma senha nova ou compartilhada.
- Só usuários com `perfil === 'admin'` podem criar ou excluir regra — reusar o middleware `requireAdmin` já existente em `server.js` (linha ~249), não recriar a checagem.
- Regra nunca decide sozinha entre 2+ títulos candidatos ambíguos — cai em "revisar" como hoje.
- Regra nunca inventa título quando não existe candidato — a saída segue pro fluxo normal (`não_encontrado`/etc).
- Seguir o design da spec aprovada: `docs/superpowers/specs/2026-09-02-conciliador-regra-automatica-design.md`.

---

## Task 1: Motor de match — `aplicarRegras()` em `lib/conciliador.js`

**Files:**
- Modify: `lib/conciliador.js` (adiciona função antes da linha 219, adiciona export na linha 219)

**Interfaces:**
- Consumes: nada de tasks anteriores — só o que já existe no arquivo (`normalizarNome`, `diffDias`, `montarMatch`, `statusFinal`, `conciliar`, `TOLERANCIA_DIAS`, `TOLERANCIA_VALOR`, `CATEGORIAS_FORNECEDOR`, todos já definidos no mesmo arquivo).
- Produces: `aplicarRegras(saidas, candidatos, regras)` — exportado por `module.exports`. Assinatura: `saidas` (array de saída do parser, cada item com `data`, `valor`, `historico`, `favorecido`, `categoria`), `candidatos` (array de títulos do ERP já enriquecidos com plano de contas, mesma forma usada em `conciliar()`), `regras` (array de objetos `{ id, tipo: 'fornecedor'|'dispensar', beneficiarioNormalizado, codFornec?, fornecedorNome?, criadoPor, criadoEm }`). Retorna um array na **mesma ordem e tamanho de `saidas`**, cada item com a mesma forma que `conciliar()` já retorna (`{ ...saida, status, match, candidatos }`) — usado por Task 2 no lugar de `conciliar()` puro.

- [ ] **Step 1: Adicionar a função `aplicarRegras` em `lib/conciliador.js`, logo antes da linha `module.exports`**

Abrir `lib/conciliador.js` e inserir, imediatamente antes da linha `module.exports = { conciliar, normalizarNome, similaridadeNome, addDias, TOLERANCIA_DIAS, chaveSaida, aplicarAvulsos };`:

```js
// Aplica regras permanentes de conciliação (criadas via
// POST /api/conciliador/confirmar-regra, ver server.js) ANTES do motor de
// match automático (conciliar(), acima). Regra 'fornecedor' aliasa um
// beneficiário do extrato a um CodFornec do ERP — ajuda o motor a não cair
// em "revisar" só por divergência textual do nome, mas continua exigindo
// valor+data compatíveis (não substitui o motor, só dá o de-para de nome).
// Regra 'dispensar' tira um beneficiário de "fora_escopo" da fila de
// conferência mensal. Saídas não cobertas por nenhuma regra seguem pro
// conciliar() normal, sem nenhuma mudança de comportamento.
function aplicarRegras(saidas, candidatos, regras) {
  const porFornecedor = new Map();
  const dispensados = new Set();
  for (const r of (regras || [])) {
    if (r.tipo === 'fornecedor') porFornecedor.set(r.beneficiarioNormalizado, r);
    else if (r.tipo === 'dispensar') dispensados.add(r.beneficiarioNormalizado);
  }

  const usadosPorRegra = new Set();
  const porIndice = new Array(saidas.length).fill(null);

  saidas.forEach((saida, i) => {
    const chave = normalizarNome(saida.favorecido);
    const ehFornecedor = CATEGORIAS_FORNECEDOR.includes(saida.categoria);

    if (ehFornecedor && porFornecedor.has(chave)) {
      const regra = porFornecedor.get(chave);
      const pool = candidatos.filter(c =>
        c.CodFornec === regra.codFornec &&
        !usadosPorRegra.has(c.nReg) &&
        diffDias(saida.data, c.DataVencto) <= TOLERANCIA_DIAS &&
        Math.abs(saida.valor - Number(c.Valor)) <= TOLERANCIA_VALOR
      );
      if (pool.length === 1) {
        usadosPorRegra.add(pool[0].nReg);
        porIndice[i] = {
          ...saida,
          status: statusFinal(pool[0]),
          match: {
            ...montarMatch(pool[0], saida.data, saida.favorecido, saida.valor),
            regraAplicada: { id: regra.id, criadoPor: regra.criadoPor, criadoEm: regra.criadoEm }
          },
          candidatos: []
        };
      }
      // 0 candidatos: regra não inventa título, segue pro conciliar() normal.
      // 2+ candidatos: ambíguo mesmo sabendo o fornecedor, cai em "revisar" via conciliar() normal.
    } else if (!ehFornecedor && dispensados.has(chave)) {
      porIndice[i] = { ...saida, status: 'dispensado_regra', match: null, candidatos: [] };
    }
  });

  const indicesRestantes = [];
  const saidasRestantes = [];
  saidas.forEach((s, i) => {
    if (!porIndice[i]) { indicesRestantes.push(i); saidasRestantes.push(s); }
  });
  const candidatosRestantes = candidatos.filter(c => !usadosPorRegra.has(c.nReg));

  const itensConciliar = conciliar(saidasRestantes, candidatosRestantes);
  const resultado = porIndice.slice();
  indicesRestantes.forEach((origIdx, j) => { resultado[origIdx] = itensConciliar[j]; });
  return resultado;
}
```

- [ ] **Step 2: Adicionar `aplicarRegras` ao `module.exports`**

Trocar a linha final do arquivo:

```js
module.exports = { conciliar, normalizarNome, similaridadeNome, addDias, TOLERANCIA_DIAS, chaveSaida, aplicarAvulsos };
```

por:

```js
module.exports = { conciliar, normalizarNome, similaridadeNome, addDias, TOLERANCIA_DIAS, chaveSaida, aplicarAvulsos, aplicarRegras };
```

- [ ] **Step 3: Verificação manual — rodar um script ad hoc cobrindo os 3 casos da regra `fornecedor` + o caso `dispensar`**

Criar um arquivo temporário `scratch-verificar-regras.js` na raiz do repo (**não commitar** — apagar no Step 5):

```js
const assert = require('assert');
const { aplicarRegras } = require('./lib/conciliador');

const saidas = [
  { data: '2026-09-05', valor: 500, historico: 'BOLETO PAGO MICHEL FIGUEIREDO', favorecido: 'MICHEL FIGUEIREDO DE SA LEITAO PIX', categoria: 'boleto_pago' },
  { data: '2026-09-06', valor: 300, historico: 'BOLETO PAGO SEM TITULO', favorecido: 'FORNECEDOR SEM TITULO LTDA', categoria: 'boleto_pago' },
  { data: '2026-09-07', valor: 200, historico: 'BOLETO PAGO AMBIGUO', favorecido: 'FORNECEDOR AMBIGUO LTDA', categoria: 'boleto_pago' },
  { data: '2026-09-08', valor: 1000, historico: 'SISPAG SALARIO SETEMBRO', favorecido: 'SISPAG SALARIO', categoria: 'salario' }
];

const candidatos = [
  { nReg: 1, Valor: 505, Devedor: 505, DataVencto: '2026-09-05', CodFornec: 42, Historico: 'NF 123', Filial: 1, NomeCompleto: 'MICHEL FIGUEIREDO', PlanoGrupo: 12, PlanoSub: 19 },
  { nReg: 2, Valor: 200, Devedor: 200, DataVencto: '2026-09-07', CodFornec: 99, Historico: 'NF A', Filial: 1, NomeCompleto: 'FORNECEDOR AMBIGUO' },
  { nReg: 3, Valor: 200, Devedor: 200, DataVencto: '2026-09-07', CodFornec: 99, Historico: 'NF B', Filial: 1, NomeCompleto: 'FORNECEDOR AMBIGUO' }
];

const regras = [
  { id: 'r1', tipo: 'fornecedor', beneficiarioNormalizado: 'MICHEL FIGUEIREDO DE SA LEITAO PIX'.toUpperCase(), codFornec: 42, fornecedorNome: 'MICHEL FIGUEIREDO', criadoPor: 'tiago.freire', criadoEm: '2026-09-02T00:00:00.000Z' },
  { id: 'r2', tipo: 'fornecedor', beneficiarioNormalizado: 'FORNECEDOR SEM TITULO LTDA', codFornec: 77, fornecedorNome: 'SEM TITULO', criadoPor: 'tiago.freire', criadoEm: '2026-09-02T00:00:00.000Z' },
  { id: 'r3', tipo: 'fornecedor', beneficiarioNormalizado: 'FORNECEDOR AMBIGUO LTDA', codFornec: 99, fornecedorNome: 'AMBIGUO', criadoPor: 'tiago.freire', criadoEm: '2026-09-02T00:00:00.000Z' },
  { id: 'r4', tipo: 'dispensar', beneficiarioNormalizado: 'SISPAG SALARIO', criadoPor: 'donato', criadoEm: '2026-09-02T00:00:00.000Z' }
];

const resultado = aplicarRegras(saidas, candidatos, regras);

// Caso 1: 1 candidato -> concilia automaticamente com regraAplicada
assert.strictEqual(resultado[0].status, 'pago_sem_baixa'); // Devedor=505>0
assert.ok(resultado[0].match.regraAplicada, 'deveria ter regraAplicada');
assert.strictEqual(resultado[0].match.regraAplicada.id, 'r1');

// Caso 2: 0 candidatos -> regra não inventa, segue pro conciliar() normal (não_encontrado)
assert.strictEqual(resultado[1].status, 'nao_encontrado');

// Caso 3: 2+ candidatos -> ambíguo, cai em revisar (não decide sozinho)
assert.strictEqual(resultado[2].status, 'revisar');

// Caso 4: dispensar -> some da fila
assert.strictEqual(resultado[3].status, 'dispensado_regra');

console.log('OK — todos os casos de aplicarRegras() passaram');
```

Rodar:
```bash
node scratch-verificar-regras.js
```
Esperado: `OK — todos os casos de aplicarRegras() passaram` (sem stack trace de `AssertionError`).

- [ ] **Step 4: Se algum assert falhar, corrigir a implementação do Step 1 e rodar de novo até passar.**

- [ ] **Step 5: Apagar o script temporário**

```bash
rm scratch-verificar-regras.js
```

- [ ] **Step 6: Commit**

```bash
git add lib/conciliador.js
git commit -m "Adiciona aplicarRegras() ao motor de match do Conciliador"
```

---

## Task 2: Persistência de regras + integração em `processarConciliacao` (`server.js`)

**Files:**
- Modify: `server.js` (require de `aplicarRegras`, novo bloco de persistência, novo require de `crypto`, wiring em `processarConciliacao`)

**Interfaces:**
- Consumes: `aplicarRegras(saidas, candidatos, regras)` da Task 1 (`lib/conciliador.js`).
- Produces: `carregarRegras()` → retorna array de regras (`[]` se arquivo não existe); `salvarRegras(lista)` → grava `data/regras-conciliacao.json`; `crypto` (módulo built-in do Node, `require('crypto')`) disponível pro resto do arquivo, usado por `crypto.randomUUID()` na Task 3. `processarConciliacao()` passa a considerar as regras salvas.

- [ ] **Step 1: Adicionar `require('crypto')`**

Em `server.js`, linha 8 (logo após `const fs = require('fs');`), adicionar:

```js
const crypto = require('crypto');
```

- [ ] **Step 2: Adicionar `aplicarRegras` ao require de `./lib/conciliador`**

Trocar a linha 11:

```js
const { conciliar, addDias, similaridadeNome, normalizarNome, TOLERANCIA_DIAS: TOLERANCIA_CONCILIADOR, chaveSaida, aplicarAvulsos } = require('./lib/conciliador');
```

por:

```js
const { conciliar, addDias, similaridadeNome, normalizarNome, TOLERANCIA_DIAS: TOLERANCIA_CONCILIADOR, chaveSaida, aplicarAvulsos, aplicarRegras } = require('./lib/conciliador');
```

- [ ] **Step 3: Adicionar persistência de regras logo após o bloco de avulsos**

Em `server.js`, logo depois da linha 42 (`}` que fecha `salvarAvulsos`), adicionar:

```js

// Regras permanentes de conciliação (alias fornecedor / auto-dispensar) —
// criadas via POST /api/conciliador/confirmar-regra, sempre com
// reautenticação por senha (ver requireAdmin mais abaixo). Persistidas em
// JSON local, nunca no MySQL do ERP.
const REGRAS_PATH = path.join(__dirname, 'data', 'regras-conciliacao.json');
function carregarRegras() {
  try { return JSON.parse(fs.readFileSync(REGRAS_PATH, 'utf8')); } catch (e) { return []; }
}
function salvarRegras(lista) {
  fs.mkdirSync(path.dirname(REGRAS_PATH), { recursive: true });
  fs.writeFileSync(REGRAS_PATH, JSON.stringify(lista, null, 2));
}
```

- [ ] **Step 4: Fazer `processarConciliacao()` aplicar as regras antes de `conciliar()`**

Localizar em `server.js` (dentro de `async function processarConciliacao(saidas, loja)`):

```js
  const candidatos = enriquecerComPlanoContas(candidatosRaw, await getPlanoContas());

  const itens = aplicarAvulsos(conciliar(saidas, candidatos), carregarAvulsos());
  const resumo = { conciliado: 0, conciliado_avulso: 0, pago_sem_baixa: 0, divergencia: 0, revisar: 0, nao_encontrado: 0, fora_escopo: 0 };
```

Trocar por:

```js
  const candidatos = enriquecerComPlanoContas(candidatosRaw, await getPlanoContas());

  const itens = aplicarAvulsos(aplicarRegras(saidas, candidatos, carregarRegras()), carregarAvulsos());
  const resumo = { conciliado: 0, conciliado_avulso: 0, pago_sem_baixa: 0, divergencia: 0, revisar: 0, nao_encontrado: 0, fora_escopo: 0, dispensado_regra: 0 };
```

(Só troca `conciliar(saidas, candidatos)` por `aplicarRegras(saidas, candidatos, carregarRegras())`, e adiciona `dispensado_regra: 0` no objeto `resumo` — sem isso, `resumo[it.status]++` viraria `NaN` pra esse status novo.)

- [ ] **Step 5: Verificação manual**

Rodar:
```bash
node -e "require('./server.js')" &
sleep 2
curl -s -c /tmp/cookies.txt -X POST http://localhost:3000/api/login -H "Content-Type: application/json" -d '{"usuario":"tiago.freire","senha":"<SENHA_REAL>"}'
```
(Ajustar porta/senha conforme ambiente local de dev — ver como o servidor já é rodado hoje, ex.: `npm start`/`node server.js`.) Confirmar que o servidor sobe sem erro (`node -c server.js` também serve só pra checar sintaxe, mais rápido):
```bash
node -c server.js
```
Esperado: nenhum erro de sintaxe/require impresso.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "Adiciona persistência de regras e integra aplicarRegras() em processarConciliacao"
```

---

## Task 3: Endpoint `POST /api/conciliador/confirmar-regra`

**Files:**
- Modify: `server.js` (novo endpoint, inserido logo após o endpoint `confirmar-avulso` existente)

**Interfaces:**
- Consumes: `carregarRegras`/`salvarRegras`/`crypto` (Task 2), `carregarAvulsos`/`salvarAvulsos`/`chaveSaida`/`normalizarNome` (já existentes), middleware `requireAdmin` (já existente em `server.js` ~linha 249), `usuarios` (array já carregado em memória, linha 146), `bcrypt` (já importado).
- Produces: rota `POST /api/conciliador/confirmar-regra` — body `{ tipo: 'fornecedor'|'dispensar', beneficiario, senha, saida?, escolha? }`, resposta `{ ok: true, regra }` (201/200) ou `{ error }` (400/401/403/500). Consumida pelo frontend na Task 6/7.

- [ ] **Step 1: Adicionar o endpoint logo após `confirmar-avulso`**

Em `server.js`, localizar o fechamento do endpoint existente:

```js
app.post('/api/conciliador/confirmar-avulso', (req, res) => {
  ...
  } catch (err) {
    console.error('[CONCILIADOR-AVULSO-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao salvar conciliação avulsa.' });
  }
});
```

Logo depois desse `});` (e antes do comentário `// ── CONCILIADOR CD`), inserir:

```js

// Confirma uma regra permanente (alias fornecedor ou auto-dispensar) — exige
// reautenticação por senha (a própria senha de login do usuário, restrita a
// perfil admin via requireAdmin) porque a regra passa a agir sozinha todo
// mês, sem conferência manual. Ver lib/conciliador.js (aplicarRegras) pra
// como a regra entra no motor de match.
app.post('/api/conciliador/confirmar-regra', requireAdmin, async (req, res) => {
  try {
    const { tipo, saida, senha, escolha, beneficiario } = req.body || {};
    if (!senha) return res.status(400).json({ error: 'Informe a senha pra confirmar definitivamente.' });
    if (tipo !== 'fornecedor' && tipo !== 'dispensar') return res.status(400).json({ error: 'Tipo de regra inválido.' });

    const usuarioAtual = usuarios.find(u => u.id === req.session.user.id);
    const senhaOk = usuarioAtual && await bcrypt.compare(String(senha), usuarioAtual.senha_hash);
    if (!senhaOk) return res.status(401).json({ error: 'Senha incorreta.' });

    const beneficiarioOriginal = (saida && saida.favorecido) || beneficiario;
    const beneficiarioNorm = normalizarNome(beneficiarioOriginal);
    if (!beneficiarioNorm) return res.status(400).json({ error: 'Beneficiário não informado.' });

    if (tipo === 'fornecedor' && (!escolha || !escolha.codFornec)) {
      return res.status(400).json({ error: 'Escolha um título do ERP antes de confirmar a regra.' });
    }

    const regras = carregarRegras();
    const idx = regras.findIndex(r => r.beneficiarioNormalizado === beneficiarioNorm && r.tipo === tipo);
    const agora = new Date().toISOString();
    const registro = tipo === 'fornecedor'
      ? {
          id: idx >= 0 ? regras[idx].id : crypto.randomUUID(),
          tipo: 'fornecedor',
          beneficiarioNormalizado: beneficiarioNorm,
          beneficiarioOriginal,
          codFornec: escolha.codFornec,
          fornecedorNome: escolha.fornecedor,
          criadoPor: req.session.user.nome,
          criadoEm: agora
        }
      : {
          id: idx >= 0 ? regras[idx].id : crypto.randomUUID(),
          tipo: 'dispensar',
          beneficiarioNormalizado: beneficiarioNorm,
          beneficiarioOriginal,
          criadoPor: req.session.user.nome,
          criadoEm: agora
        };

    if (idx >= 0) regras[idx] = registro; else regras.push(registro);
    salvarRegras(regras);

    // Também grava/atualiza o avulso do mês corrente (regra 'fornecedor' com
    // saída informada), pra o item já sair conciliado nessa mesma consulta
    // sem precisar esperar reprocessar o extrato inteiro.
    if (tipo === 'fornecedor' && saida && escolha) {
      const lista = carregarAvulsos();
      const chave = chaveSaida(saida);
      const avulso = {
        chave, data: saida.data, valorSaida: saida.valor, historicoSaida: saida.historico,
        favorecidoSaida: saida.favorecido, nReg: escolha.nReg, fornecedor: escolha.fornecedor,
        codFornec: escolha.codFornec, valorErp: escolha.valor, dataVencto: escolha.dataVencto,
        historicoErp: escolha.historico, filial: escolha.filial, planoGrupo: escolha.planoGrupo,
        planoSub: escolha.planoSub, planoGrupoNome: escolha.planoGrupoNome, planoSubNome: escolha.planoSubNome,
        acrescimo: escolha.acrescimo, multa: escolha.multa, juros: escolha.juros, desconto: escolha.desconto,
        devolucao: escolha.devolucao, valorBruto: escolha.valorBruto,
        justificativa: `Regra automática: ${registro.fornecedorNome}`,
        confirmadoEm: agora, confirmadoPor: registro.criadoPor
      };
      const idxA = lista.findIndex(a => a.chave === chave);
      if (idxA >= 0) lista[idxA] = avulso; else lista.push(avulso);
      salvarAvulsos(lista);
    }

    res.json({ ok: true, regra: registro });
  } catch (err) {
    console.error('[CONCILIADOR-REGRA-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao confirmar regra.' });
  }
});
```

- [ ] **Step 2: Verificação manual (sintaxe + fluxo via curl)**

```bash
node -c server.js
```
Esperado: sem erro.

Com o servidor local rodando e uma sessão de admin logada (cookie salvo em `/tmp/cookies.txt`, ver Task 2 Step 5):
```bash
curl -s -b /tmp/cookies.txt -X POST http://localhost:3000/api/conciliador/confirmar-regra \
  -H "Content-Type: application/json" \
  -d '{"tipo":"dispensar","beneficiario":"SISPAG SALARIO TESTE","senha":"senha-errada"}'
```
Esperado: `{"error":"Senha incorreta."}` com status 401.

```bash
curl -s -b /tmp/cookies.txt -X POST http://localhost:3000/api/conciliador/confirmar-regra \
  -H "Content-Type: application/json" \
  -d '{"tipo":"dispensar","beneficiario":"SISPAG SALARIO TESTE","senha":"<SENHA_REAL_DO_ADMIN>"}'
```
Esperado: `{"ok":true,"regra":{...tipo:"dispensar"...}}`.

Confirmar que `data/regras-conciliacao.json` foi criado/atualizado com o registro.

Sem cookie de sessão admin (ou com sessão de perfil não-admin):
```bash
curl -s -X POST http://localhost:3000/api/conciliador/confirmar-regra -H "Content-Type: application/json" -d '{"tipo":"dispensar","beneficiario":"X","senha":"y"}'
```
Esperado: `{"error":"Sem permissão"}` com status 403 (ou 401 se nem sessão houver — ver middleware global de auth).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "Adiciona endpoint POST /api/conciliador/confirmar-regra"
```

---

## Task 4: Endpoints `GET /api/conciliador/regras` e `DELETE /api/conciliador/regras/:id`

**Files:**
- Modify: `server.js` (dois novos endpoints, logo após o de `confirmar-regra` da Task 3)

**Interfaces:**
- Consumes: `carregarRegras`/`salvarRegras` (Task 2), `requireAdmin` (já existente).
- Produces: `GET /api/conciliador/regras` → `[{ id, tipo, beneficiarioNormalizado, beneficiarioOriginal, codFornec?, fornecedorNome?, criadoPor, criadoEm }, ...]`. `DELETE /api/conciliador/regras/:id` → `{ ok: true }` (200) ou `{ error }` (404). Consumidos pelo frontend na Task 9.

- [ ] **Step 1: Adicionar os dois endpoints logo após o `confirmar-regra` da Task 3**

```js

app.get('/api/conciliador/regras', requireAdmin, (req, res) => {
  res.json(carregarRegras());
});

app.delete('/api/conciliador/regras/:id', requireAdmin, (req, res) => {
  const regras = carregarRegras();
  const restante = regras.filter(r => r.id !== req.params.id);
  if (restante.length === regras.length) return res.status(404).json({ error: 'Regra não encontrada.' });
  salvarRegras(restante);
  res.json({ ok: true });
});
```

- [ ] **Step 2: Verificação manual**

```bash
node -c server.js
curl -s -b /tmp/cookies.txt http://localhost:3000/api/conciliador/regras
```
Esperado: array JSON com a regra criada na Task 3.

```bash
curl -s -b /tmp/cookies.txt -X DELETE http://localhost:3000/api/conciliador/regras/<ID_DA_REGRA>
```
Esperado: `{"ok":true}`. Rodar o `GET` de novo e confirmar que a lista não tem mais aquele `id`.

```bash
curl -s -b /tmp/cookies.txt -X DELETE http://localhost:3000/api/conciliador/regras/id-que-nao-existe
```
Esperado: `{"error":"Regra não encontrada."}` com status 404.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "Adiciona endpoints GET/DELETE de regras de conciliação"
```

---

## Task 5: Frontend — carregar `usuarioAtual` e helper de badge de regra

**Files:**
- Modify: `public/conciliador.html`

**Interfaces:**
- Consumes: `GET /api/me` (já existe no backend, retorna `{ id, nome, usuario, perfil, comprador_nome, loja_id }` ou 401).
- Produces: variável global `usuarioAtual` (objeto do `/api/me` ou `null`), disponível pras Tasks 6-9. Função `ehAdmin()` → `boolean`.

- [ ] **Step 1: Adicionar variável global e carregamento no início do `<script>`**

Em `public/conciliador.html`, logo após a linha `let ultimaAtualizacao = null;` (linha 239), adicionar:

```js
let usuarioAtual = null;
function ehAdmin() { return !!(usuarioAtual && usuarioAtual.perfil === 'admin'); }
(async function carregarUsuarioAtual() {
  try {
    const r = await fetch('/api/me');
    if (r.ok) usuarioAtual = await r.json();
  } catch (e) { /* segue sem admin — checkbox/botões de regra ficam escondidos */ }
})();
```

- [ ] **Step 2: Adicionar os novos status ao `STATUS_LABEL`/`STATUS_PILL`**

Trocar:

```js
const STATUS_LABEL = {
  conciliado: 'Conciliado', conciliado_avulso: 'Conciliado avulso', pago_sem_baixa: 'Pago sem baixa',
  divergencia: 'Divergência de valor', revisar: 'Revisar', nao_encontrado: 'Não encontrado', fora_escopo: 'Fora do escopo'
};
const STATUS_PILL = {
  conciliado: 'pill-ok', conciliado_avulso: 'pill-ok', pago_sem_baixa: 'pill-alerta',
  divergencia: 'pill-revisar', revisar: 'pill-revisar', nao_encontrado: 'pill-neutro', fora_escopo: 'pill-neutro'
};
```

por:

```js
const STATUS_LABEL = {
  conciliado: 'Conciliado', conciliado_avulso: 'Conciliado avulso', pago_sem_baixa: 'Pago sem baixa',
  divergencia: 'Divergência de valor', revisar: 'Revisar', nao_encontrado: 'Não encontrado', fora_escopo: 'Fora do escopo',
  dispensado_regra: 'Dispensado (regra)'
};
const STATUS_PILL = {
  conciliado: 'pill-ok', conciliado_avulso: 'pill-ok', pago_sem_baixa: 'pill-alerta',
  divergencia: 'pill-revisar', revisar: 'pill-revisar', nao_encontrado: 'pill-neutro', fora_escopo: 'pill-neutro',
  dispensado_regra: 'pill-neutro'
};
```

- [ ] **Step 3: Verificação manual**

Abrir `conciliador.html` no navegador logado como admin, abrir o DevTools console e rodar:
```js
usuarioAtual
```
Esperado: objeto com `perfil: "admin"` (aguardar a Promise resolver — pode precisar de um instante após o load da página).

Logado como um usuário não-admin (ex.: `gerencia.cahu`), mesma checagem: `usuarioAtual.perfil` deve ser diferente de `"admin"`.

- [ ] **Step 4: Commit**

```bash
git add public/conciliador.html
git commit -m "Frontend: carrega usuarioAtual e novo status dispensado_regra"
```

---

## Task 6: Frontend — checkbox "Confirmar definitivamente" + senha no fluxo de match manual

**Files:**
- Modify: `public/conciliador.html`

**Interfaces:**
- Consumes: `ehAdmin()`, `usuarioAtual` (Task 5), `POST /api/conciliador/confirmar-regra` (Task 3), variáveis já existentes `candidatoEscolhido`, `itensAtuais`, `popupIdx`, `dados`.
- Produces: função `confirmarAvulso()` modificada — quando o checkbox de regra está marcado, chama `confirmar-regra` (com fallback pro fluxo antigo de avulso quando desmarcado, sem quebrar o comportamento atual).

- [ ] **Step 1: Adicionar o checkbox + campo de senha em `escolherCandidato()`**

Localizar a função (linhas ~835-850):

```js
function escolherCandidato(i) {
  candidatoEscolhido = candidatosProximos[i];
  const box = document.getElementById('concman-box');
  const it = itensAtuais[popupIdx];
  box.innerHTML = `
    <div class="cand-item2" style="margin-bottom:10px">
      <div class="nm">${candidatoEscolhido.fornecedor}</div>
      <div class="meta"><span>${candidatoEscolhido.historico || 'sem NF'}</span><span>${fmtMoeda(candidatoEscolhido.valor)}</span></div>
    </div>
    <label style="font-size:10px;color:var(--ink-3);font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Justificativa</label>
    <textarea id="txt-justificativa" placeholder="Ex: pago com juros/multa de atraso" style="width:100%;min-height:60px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;padding:8px 10px;font-size:12.5px;font-family:var(--font);outline:none;resize:vertical"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn btn-slate" style="flex:1" onclick="renderCandidatosProximos()">Voltar</button>
      <button class="btn btn-blue" style="flex:1" onclick="confirmarAvulso()">Confirmar conciliação</button>
    </div>`;
}
```

Trocar por:

```js
function escolherCandidato(i) {
  candidatoEscolhido = candidatosProximos[i];
  const box = document.getElementById('concman-box');
  const it = itensAtuais[popupIdx];
  box.innerHTML = `
    <div class="cand-item2" style="margin-bottom:10px">
      <div class="nm">${candidatoEscolhido.fornecedor}</div>
      <div class="meta"><span>${candidatoEscolhido.historico || 'sem NF'}</span><span>${fmtMoeda(candidatoEscolhido.valor)}</span></div>
    </div>
    <label style="font-size:10px;color:var(--ink-3);font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Justificativa</label>
    <textarea id="txt-justificativa" placeholder="Ex: pago com juros/multa de atraso" style="width:100%;min-height:60px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;padding:8px 10px;font-size:12.5px;font-family:var(--font);outline:none;resize:vertical"></textarea>
    ${ehAdmin() ? `
    <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--ink-2);cursor:pointer">
      <input type="checkbox" id="chk-regra-permanente" onchange="document.getElementById('box-senha-regra').style.display=this.checked?'block':'none'">
      Confirmar definitivamente (vira regra pra sempre pra esse fornecedor)
    </label>
    <div id="box-senha-regra" style="display:none;margin-top:6px">
      <input type="password" id="txt-senha-regra" placeholder="Sua senha de login" style="width:100%;height:34px;padding:0 10px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;font-family:var(--font);font-size:12.5px;outline:none">
    </div>` : ''}
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn btn-slate" style="flex:1" onclick="renderCandidatosProximos()">Voltar</button>
      <button class="btn btn-blue" style="flex:1" onclick="confirmarAvulso()">Confirmar conciliação</button>
    </div>`;
}
```

- [ ] **Step 2: Modificar `confirmarAvulso()` pra ramificar quando a regra está marcada**

Localizar a função (linhas ~852-887):

```js
async function confirmarAvulso() {
  const it = itensAtuais[popupIdx];
  const justificativa = document.getElementById('txt-justificativa').value.trim();
  if (!justificativa) { alert('Escreve a justificativa antes de confirmar.'); return; }
  const box = document.getElementById('concman-box');
  box.innerHTML = '<div class="spinner" style="margin:16px auto"></div>';
  try {
    const r = await fetch('/api/conciliador/confirmar-avulso', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saida: { data: it.data, valor: it.valor, historico: it.historico, favorecido: it.favorecido, categoria: it.categoria },
        escolha: candidatoEscolhido,
        justificativa
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Erro ao confirmar');

    // Atualiza o item localmente pra refletir na tela sem precisar reprocessar tudo
    const antigo = it.status;
    it.status = 'conciliado_avulso';
    it.match = {
      nReg: candidatoEscolhido.nReg, fornecedor: candidatoEscolhido.fornecedor, codFornec: candidatoEscolhido.codFornec,
      valor: candidatoEscolhido.valor, dataVencto: candidatoEscolhido.dataVencto, historico: candidatoEscolhido.historico,
      filial: candidatoEscolhido.filial, justificativa, confirmadoEm: new Date().toISOString(), confirmadoPor: 'você'
    };
    it.candidatos = [];
    dados.resumo[antigo]--;
    dados.resumo.conciliado_avulso = (dados.resumo.conciliado_avulso || 0) + 1;

    fecharPopup();
    render();
  } catch (e) {
    box.innerHTML = `<div class="err" style="margin:0">Erro: ${e.message}</div>`;
  }
}
```

Trocar por:

```js
async function confirmarAvulso() {
  const it = itensAtuais[popupIdx];
  const justificativa = document.getElementById('txt-justificativa').value.trim();
  if (!justificativa) { alert('Escreve a justificativa antes de confirmar.'); return; }
  const chkRegra = document.getElementById('chk-regra-permanente');
  const viraRegra = chkRegra && chkRegra.checked;
  const box = document.getElementById('concman-box');

  if (viraRegra) {
    const senha = document.getElementById('txt-senha-regra').value;
    if (!senha) { alert('Digite sua senha pra confirmar definitivamente.'); return; }
    box.innerHTML = '<div class="spinner" style="margin:16px auto"></div>';
    try {
      const r = await fetch('/api/conciliador/confirmar-regra', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo: 'fornecedor',
          saida: { data: it.data, valor: it.valor, historico: it.historico, favorecido: it.favorecido, categoria: it.categoria },
          escolha: candidatoEscolhido,
          senha
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Erro ao confirmar regra');
      aplicarConciliacaoLocal(it, 'conciliado_avulso', { regraAplicada: j.regra });
      fecharPopup();
      render();
    } catch (e) {
      box.innerHTML = `<div class="err" style="margin:0">Erro: ${e.message}</div>`;
    }
    return;
  }

  box.innerHTML = '<div class="spinner" style="margin:16px auto"></div>';
  try {
    const r = await fetch('/api/conciliador/confirmar-avulso', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saida: { data: it.data, valor: it.valor, historico: it.historico, favorecido: it.favorecido, categoria: it.categoria },
        escolha: candidatoEscolhido,
        justificativa
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Erro ao confirmar');
    aplicarConciliacaoLocal(it, 'conciliado_avulso', { justificativa });
    fecharPopup();
    render();
  } catch (e) {
    box.innerHTML = `<div class="err" style="margin:0">Erro: ${e.message}</div>`;
  }
}

// Atualiza um item localmente (sem reprocessar tudo) depois de confirmar avulso
// ou regra — extraído de confirmarAvulso() original pra reaproveitar nos dois casos.
function aplicarConciliacaoLocal(it, novoStatus, extra) {
  const antigo = it.status;
  it.status = novoStatus;
  it.match = {
    nReg: candidatoEscolhido.nReg, fornecedor: candidatoEscolhido.fornecedor, codFornec: candidatoEscolhido.codFornec,
    valor: candidatoEscolhido.valor, dataVencto: candidatoEscolhido.dataVencto, historico: candidatoEscolhido.historico,
    filial: candidatoEscolhido.filial, confirmadoEm: new Date().toISOString(), confirmadoPor: 'você',
    ...extra
  };
  it.candidatos = [];
  dados.resumo[antigo]--;
  dados.resumo[novoStatus] = (dados.resumo[novoStatus] || 0) + 1;
}
```

- [ ] **Step 2b: Verificar que não há duplicidade — remover a linha antiga de atualização local**

O bloco antigo (`const antigo = it.status; it.status = 'conciliado_avulso'; ...`) já foi substituído pela chamada a `aplicarConciliacaoLocal()` dentro do `try` de cada ramo no Step 2 acima — conferir que não sobrou nenhuma cópia duplicada desse trecho no arquivo depois da edição.

- [ ] **Step 3: Verificação manual no navegador**

1. Logar como `tiago.freire` (admin).
2. Processar um extrato com um item que caia em "Revisar" ou "Não encontrado".
3. Abrir o item, clicar "Buscar títulos próximos", escolher um candidato.
4. Confirmar que o checkbox "Confirmar definitivamente" aparece (só pra admin) e que marcá-lo revela o campo de senha.
5. Digitar a justificativa, marcar o checkbox, digitar uma senha errada, clicar "Confirmar conciliação" → esperado: alerta/erro "Senha incorreta." na caixa (sem fechar o popup).
6. Repetir com a senha certa → esperado: popup fecha, item vira "Conciliado avulso" na tabela, e `GET /api/conciliador/regras` (via curl ou nova aba) mostra a regra criada.
7. Logar como um usuário não-admin (ex.: `gerencia.cahu`) e repetir o passo 3 → esperado: o checkbox de "Confirmar definitivamente" **não aparece**.

- [ ] **Step 4: Commit**

```bash
git add public/conciliador.html
git commit -m "Frontend: checkbox de regra permanente + senha no fluxo de match manual"
```

---

## Task 7: Frontend — botão "Não preciso ver isso de novo" (regra `dispensar` pra Fora do escopo)

**Files:**
- Modify: `public/conciliador.html`

**Interfaces:**
- Consumes: `ehAdmin()` (Task 5), `POST /api/conciliador/confirmar-regra` (Task 3), `itensAtuais`, `popupIdx`, `dados`, `fecharPopup()`, `render()` (já existentes).
- Produces: função `dispensarRegra()`, chamada pelo botão novo no popup de itens "Fora do escopo".

- [ ] **Step 1: Adicionar o botão no ramo `else` de `renderPopup()` (o que hoje mostra "Fora do escopo"/"Sem correspondência")**

Localizar (linhas ~767-777):

```js
  } else {
    corpo = `
      <div class="popup-row"><span class="k">Valor do extrato</span><span class="v">${fmtMoeda(it.valor)}</span></div>
      <div class="popup-row"><span class="k">Data</span><span class="v">${it.dataBr}</span></div>
      <div class="popup-sec">${it.status === 'fora_escopo' ? 'Fora do escopo' : 'Sem correspondência'}</div>
      <div style="color:var(--ink-3);font-size:12px">
        ${it.status === 'fora_escopo'
          ? 'Essa categoria (tributo, tarifa, salário, aplicação) não é pagamento a fornecedor, então não tentamos casar com o ERP.'
          : 'Não achamos nenhum título no ERP com esse valor dentro da janela de vencimento considerada.'}
      </div>`;
  }
```

Trocar por:

```js
  } else {
    corpo = `
      <div class="popup-row"><span class="k">Valor do extrato</span><span class="v">${fmtMoeda(it.valor)}</span></div>
      <div class="popup-row"><span class="k">Data</span><span class="v">${it.dataBr}</span></div>
      <div class="popup-sec">${it.status === 'fora_escopo' ? 'Fora do escopo' : 'Sem correspondência'}</div>
      <div style="color:var(--ink-3);font-size:12px">
        ${it.status === 'fora_escopo'
          ? 'Essa categoria (tributo, tarifa, salário, aplicação) não é pagamento a fornecedor, então não tentamos casar com o ERP.'
          : 'Não achamos nenhum título no ERP com esse valor dentro da janela de vencimento considerada.'}
      </div>
      ${it.status === 'fora_escopo' && ehAdmin() ? renderDispensarRegra() : ''}`;
  }
```

- [ ] **Step 2: Adicionar as funções `renderDispensarRegra()` e `dispensarRegra()`, logo depois de `renderConciliacaoManual()`**

Localizar (linhas ~793-801):

```js
/* ── CONCILIAÇÃO MANUAL (juros/multa deixam o valor pago diferente do título) ── */
function renderConciliacaoManual() {
  return `
    <div class="popup-sec">Conciliar manualmente</div>
    <div id="concman-box">
      <div style="color:var(--ink-3);font-size:11.5px;margin-bottom:8px">Pra casos de boleto pago com juros/multa (valor não bate exato) — busca títulos do ERP com valor próximo.</div>
      <button class="btn btn-slate" style="width:100%" onclick="buscarProximos()">Buscar títulos próximos</button>
    </div>`;
}
```

Adicionar logo depois (mantendo o `renderConciliacaoManual()` intacto):

```js

/* ── DISPENSAR RECORRENTE (categorias fora do escopo, sem título pra vincular) ── */
function renderDispensarRegra() {
  return `
    <div class="popup-sec">Não é um caso de fornecedor</div>
    <div id="dispensar-box">
      <div style="color:var(--ink-3);font-size:11.5px;margin-bottom:8px">Beneficiários recorrentes desse tipo (ex: salário, tributo) podem sair da fila de conferência pra sempre.</div>
      <button class="btn btn-slate" style="width:100%" onclick="mostrarSenhaDispensar()">Não preciso ver isso de novo</button>
    </div>`;
}

function mostrarSenhaDispensar() {
  const box = document.getElementById('dispensar-box');
  box.innerHTML = `
    <label style="font-size:10px;color:var(--ink-3);font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Sua senha de login</label>
    <input type="password" id="txt-senha-dispensar" style="width:100%;height:34px;padding:0 10px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;font-family:var(--font);font-size:12.5px;outline:none">
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn btn-slate" style="flex:1" onclick="renderPopupAtual()">Cancelar</button>
      <button class="btn btn-blue" style="flex:1" onclick="dispensarRegra()">Confirmar</button>
    </div>`;
}

function renderPopupAtual() {
  document.getElementById('popup').innerHTML = renderPopup(itensAtuais[popupIdx]);
}

async function dispensarRegra() {
  const it = itensAtuais[popupIdx];
  const senha = document.getElementById('txt-senha-dispensar').value;
  if (!senha) { alert('Digite sua senha pra confirmar.'); return; }
  const box = document.getElementById('dispensar-box');
  box.innerHTML = '<div class="spinner" style="margin:16px auto"></div>';
  try {
    const r = await fetch('/api/conciliador/confirmar-regra', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'dispensar', beneficiario: it.favorecido || it.historico, senha })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Erro ao confirmar regra');
    const antigo = it.status;
    it.status = 'dispensado_regra';
    dados.resumo[antigo]--;
    dados.resumo.dispensado_regra = (dados.resumo.dispensado_regra || 0) + 1;
    fecharPopup();
    render();
  } catch (e) {
    box.innerHTML = `<div class="err" style="margin:0">Erro: ${e.message}</div>`;
  }
}
```

- [ ] **Step 3: Verificação manual no navegador**

1. Logar como `donato` (admin).
2. Processar um extrato com algum item "Fora do escopo" (ex.: SISPAG/tarifa).
3. Abrir o item → esperado: aparece a seção "Não é um caso de fornecedor" com o botão "Não preciso ver isso de novo".
4. Clicar, digitar senha errada → erro exibido, popup continua aberto.
5. Digitar senha certa → popup fecha, item some da lista padrão (mas continua contado — checar o KPI "Dispensado (regra)" da Task 8).
6. Logar como usuário não-admin, abrir um item "Fora do escopo" → esperado: seção "Não é um caso de fornecedor" **não aparece**.

- [ ] **Step 4: Commit**

```bash
git add public/conciliador.html
git commit -m "Frontend: botao dispensar regra pra itens Fora do escopo"
```

---

## Task 8: Frontend — KPI, badge "✓ regra" e filtro pro novo status

**Files:**
- Modify: `public/conciliador.html`

**Interfaces:**
- Consumes: `dados.resumo.dispensado_regra`, `it.match.regraAplicada` (produzido pelo backend na Task 1/3), `kpiCard()`, `renderMatch()`, `STATUS_LABEL`/`STATUS_PILL` (Task 5) — todos já existentes/ajustados.
- Produces: KPI card visível pra "Dispensado (regra)"; badge "✓ regra" nos itens conciliados via regra.

- [ ] **Step 1: Adicionar o KPI card na função `render()`**

Localizar:

```js
  html += kpiCard('nao_encontrado', r.nao_encontrado, 'Não encontrado', 'var(--ink-2)', totalPorStatus.nao_encontrado || 0);
  html += kpiCard('fora_escopo', r.fora_escopo, 'Fora do escopo', 'var(--ink-3)', totalPorStatus.fora_escopo || 0);
  html += '</div>';
```

Trocar por:

```js
  html += kpiCard('nao_encontrado', r.nao_encontrado, 'Não encontrado', 'var(--ink-2)', totalPorStatus.nao_encontrado || 0);
  html += kpiCard('fora_escopo', r.fora_escopo, 'Fora do escopo', 'var(--ink-3)', totalPorStatus.fora_escopo || 0);
  html += kpiCard('dispensado_regra', r.dispensado_regra || 0, 'Dispensado (regra)', 'var(--ink-3)', totalPorStatus.dispensado_regra || 0);
  html += '</div>';
```

- [ ] **Step 2: Adicionar a badge "✓ regra" em `renderMatch()`**

Localizar o início da função:

```js
function renderMatch(it) {
  if (it.status === 'conciliado_avulso' && it.match) {
    const m = it.match;
    return `<div class="match"><b>${m.fornecedor}</b> · ${fmtMoeda(m.valor)} <span class="diff">(match manual)</span></div>`;
  }
```

Trocar por:

```js
function renderMatch(it) {
  if (it.match && it.match.regraAplicada) {
    const m = it.match;
    return `<div class="match"><b>${m.fornecedor}</b> · ${fmtMoeda(m.valor)} <span class="diff" style="color:var(--brand-ink)">✓ regra</span></div>`;
  }
  if (it.status === 'conciliado_avulso' && it.match) {
    const m = it.match;
    return `<div class="match"><b>${m.fornecedor}</b> · ${fmtMoeda(m.valor)} <span class="diff">(match manual)</span></div>`;
  }
```

- [ ] **Step 3: Adicionar a mesma badge no popup de detalhe (`renderPopup()`, ramo `it.match`)**

Localizar (dentro de `renderPopup()`):

```js
  } else if (it.match) {
    const m = it.match;
    corpo = `
      <div class="popup-row"><span class="k">Valor do extrato</span><span class="v">${fmtMoeda(it.valor)}</span></div>
      <div class="popup-row"><span class="k">Loja</span><span class="v">${m.filial != null ? 'Loja ' + m.filial : '—'}</span></div>
```

Adicionar logo depois da linha `const m = it.match;` (antes do `corpo = \`...`), sem mexer no resto do bloco:

```js
  } else if (it.match) {
    const m = it.match;
    const badgeRegra = m.regraAplicada
      ? `<div style="color:var(--ink-3);font-size:11px;margin-bottom:8px">✓ Conciliado por regra criada por ${m.regraAplicada.criadoPor} em ${new Date(m.regraAplicada.criadoEm).toLocaleDateString('pt-BR')}</div>`
      : '';
    corpo = `
      ${badgeRegra}
      <div class="popup-row"><span class="k">Valor do extrato</span><span class="v">${fmtMoeda(it.valor)}</span></div>
      <div class="popup-row"><span class="k">Loja</span><span class="v">${m.filial != null ? 'Loja ' + m.filial : '—'}</span></div>
```

- [ ] **Step 4: Verificação manual**

1. Repetir o fluxo da Task 6 (criar uma regra `fornecedor`), depois **reprocessar** o mesmo extrato (ou processar de novo o mês seguinte com o mesmo beneficiário e valor parecido).
2. Esperado: o item aparece direto como conciliado, com a badge "✓ regra" na tabela e no popup de detalhe.
3. Confirmar que o KPI "Dispensado (regra)" reflete os itens dispensados da Task 7 e que clicar nele filtra a tabela corretamente (reaproveita `filtrar()` já existente, sem mudança necessária).

- [ ] **Step 5: Commit**

```bash
git add public/conciliador.html
git commit -m "Frontend: KPI e badge visual pra itens conciliados/dispensados por regra"
```

---

## Task 9: Frontend — tela de gerenciamento de regras (admin)

**Files:**
- Modify: `public/conciliador.html`

**Interfaces:**
- Consumes: `ehAdmin()` (Task 5), `GET /api/conciliador/regras` e `DELETE /api/conciliador/regras/:id` (Task 4), infraestrutura de popup já existente (`#popup`, `#backdrop`, `fecharPopup()`).
- Produces: botão "Gerenciar regras" no cabeçalho (só admin) que abre a listagem de regras reaproveitando o popup existente.

- [ ] **Step 1: Adicionar o botão no cabeçalho da página**

Localizar:

```html
  <div class="page-hdr">
    <h1>Conciliador Bancário</h1>
    <p>Cole as saídas do extrato do banco e cruze com os títulos de contas a pagar do ERP</p>
  </div>
```

Trocar por:

```html
  <div class="page-hdr" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
    <div>
      <h1>Conciliador Bancário</h1>
      <p>Cole as saídas do extrato do banco e cruze com os títulos de contas a pagar do ERP</p>
    </div>
    <button class="btn btn-slate" id="btn-gerenciar-regras" style="display:none" onclick="abrirGerenciarRegras()">Gerenciar regras</button>
  </div>
```

- [ ] **Step 2: Mostrar o botão quando `usuarioAtual` for admin**

Localizar (Task 5, Step 1):

```js
(async function carregarUsuarioAtual() {
  try {
    const r = await fetch('/api/me');
    if (r.ok) usuarioAtual = await r.json();
  } catch (e) { /* segue sem admin — checkbox/botões de regra ficam escondidos */ }
})();
```

Trocar por:

```js
(async function carregarUsuarioAtual() {
  try {
    const r = await fetch('/api/me');
    if (r.ok) usuarioAtual = await r.json();
  } catch (e) { /* segue sem admin — checkbox/botões de regra ficam escondidos */ }
  if (ehAdmin()) document.getElementById('btn-gerenciar-regras').style.display = 'inline-block';
})();
```

- [ ] **Step 3: Adicionar `abrirGerenciarRegras()`, `renderGerenciarRegras()` e `excluirRegra()` no fim do `<script>`, antes do `</script>` final**

Adicionar depois da última função do arquivo (`confirmarAvulso`/`aplicarConciliacaoLocal`, ao final do bloco de script):

```js

/* ── GERENCIAMENTO DE REGRAS (admin) ── */
async function abrirGerenciarRegras() {
  document.getElementById('popup').innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
  document.getElementById('popup').classList.add('on');
  document.getElementById('backdrop').classList.add('on');
  try {
    const r = await fetch('/api/conciliador/regras');
    const regras = await r.json();
    if (!r.ok) throw new Error(regras.error || 'Erro ao carregar regras');
    document.getElementById('popup').innerHTML = renderGerenciarRegras(regras);
  } catch (e) {
    document.getElementById('popup').innerHTML = `${BTN_FECHAR}<div class="popup-bd"><div class="err">Erro: ${e.message}</div></div>`;
  }
}

function renderGerenciarRegras(regras) {
  const linhas = regras.length
    ? regras.map(reg => `
        <div class="cand-item2">
          <div class="nm">${reg.beneficiarioOriginal || reg.beneficiarioNormalizado}</div>
          <div class="meta">
            <span>${reg.tipo === 'fornecedor' ? `→ ${reg.fornecedorNome || 'fornecedor #' + reg.codFornec}` : 'Auto-dispensar'} · criado por ${reg.criadoPor} em ${new Date(reg.criadoEm).toLocaleDateString('pt-BR')}</span>
          </div>
          <button class="btn btn-slate" style="margin-top:6px;font-size:11px;padding:5px 10px" onclick="excluirRegra('${reg.id}')">Excluir</button>
        </div>`).join('')
    : '<div class="empty" style="padding:14px 0">Nenhuma regra criada ainda.</div>';

  return `
    ${BTN_FECHAR}
    <div class="popup-hd"><div><h2>Regras de conciliação</h2><div class="sub">${regras.length} ativa(s)</div></div></div>
    <div class="popup-bd"><div class="cand-list">${linhas}</div></div>`;
}

async function excluirRegra(id) {
  if (!confirm('Excluir essa regra? O beneficiário volta a cair em conferência manual nos próximos meses.')) return;
  try {
    const r = await fetch(`/api/conciliador/regras/${id}`, { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Erro ao excluir');
    abrirGerenciarRegras();
  } catch (e) {
    alert('Erro: ' + e.message);
  }
}
```

- [ ] **Step 4: Verificação manual no navegador**

1. Logar como admin, confirmar que o botão "Gerenciar regras" aparece no cabeçalho.
2. Clicar → esperado: painel lateral lista as regras criadas nas Tasks 6/7 (fornecedor e dispensar), com quem criou e quando.
3. Clicar "Excluir" numa regra, confirmar o `confirm()` → esperado: regra some da lista.
4. Reprocessar o extrato daquele beneficiário → esperado: volta a cair em revisão manual normal (a regra não existe mais).
5. Logar como não-admin → esperado: botão "Gerenciar regras" não aparece.

- [ ] **Step 5: Commit**

```bash
git add public/conciliador.html
git commit -m "Frontend: tela de gerenciamento de regras de conciliacao (admin)"
```

---

## Task 10: Deploy

**Files:** nenhum (só push + bater no endpoint de deploy, conforme padrão do projeto)

**Interfaces:**
- Consumes: todas as tasks anteriores já commitadas na branch `main` local.

- [ ] **Step 1: Push pros dois remotes**

```bash
git push origin main
git push prod main
```

- [ ] **Step 2: Disparar o deploy no `.254`**

```bash
curl -s "https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026"
```

- [ ] **Step 3: Verificação pós-deploy**

Repetir rapidamente os passos de verificação manual das Tasks 3, 4, 6, 7 e 9 direto em produção (`https://cahudelivery...`/domínio do Econômico Relatórios, não localhost), logado como `tiago.freire`, `donato` ou `rodrigo.cahu`.
