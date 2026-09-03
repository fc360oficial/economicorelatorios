# Conciliação de Entradas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma nova aba "Conciliação de Entradas" que casa entradas do extrato Itaú (boleto/depósito/crediário) contra `cargaaux.fatura`/`cargaaux.faturabaixa` do ERP, e mostra cartão débito/crédito como conferência agregada mensal (sem fonte diária no ERP).

**Architecture:** Mesmo padrão arquitetural da Conciliação de Saídas já existente (`lib/extrato-parser.js` → `lib/conciliador-entradas.js` (motor) → rota em `server.js` → `public/conciliador-entradas.html`), reaproveitando funções já exportadas de `lib/conciliador.js` (`normalizarNome`, `similaridadeNome`, `addDias`, `TOLERANCIA_DIAS`) em vez de duplicá-las.

**Tech Stack:** Node.js/Express, MySQL (`mysql2`), HTML/CSS/JS vanilla no frontend (sem framework). O projeto **não usa nenhum framework de testes automatizados** (confirmado: `package.json` não tem seção `scripts`/`test`) — os passos de verificação usam scripts Node ad-hoc (`node -e`) que exercitam a função isolada e são descartados, e verificação manual na tela pro que depende do banco/rede (mesmo padrão já usado nas specs anteriores do Conciliador, ver `docs/superpowers/specs/2026-09-02-conciliador-regra-automatica-design.md`).

## Global Constraints

- Reaproveitar `normalizarNome`, `similaridadeNome`, `addDias`, `TOLERANCIA_DIAS` de `lib/conciliador.js` (já exportados) — não duplicar.
- `TOLERANCIA_DIAS` = 5 dias, `TOLERANCIA_VALOR` = ±15 (mesmos valores da Conciliação de Saídas).
- Loja sempre 1-6 nesta tela (CD é loja 10, fica só na aba CD já existente).
- Cartão débito/crédito **nunca** casa linha a linha — só conferência agregada mensal.
- Nenhuma tabela do MySQL é alterada (`cargaaux.*`, `dashboard.*` são só leitura, mesma regra do resto do projeto).
- Acesso ao MySQL do ERP (`192.168.2.252`) só funciona a partir do servidor `.254` — a máquina de dev local não alcança (`ETIMEDOUT`). Passos que dependem de query real usam SSH no `.254` (`ssh -i ~/.ssh/claude_254 claude-ssh@100.102.231.28`).

---

## Estrutura de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `lib/extrato-parser.js` | Modificar | `parseEntradas`, `parseEntradasOfx`, `parseEntradasApi` — extrai entradas (valor positivo) do extrato e categoriza |
| `lib/conciliador-entradas.js` | Criar | `conciliarEntradas()` — casa entradas contra `cargaaux.fatura`/`faturabaixa` |
| `server.js` | Modificar | Requires, helpers de query (`buscarCandidatosFatura`, `buscarTotalCartaoMes`), `processarConciliacaoEntradas()`, endpoints `/api/conciliador-entradas/*` |
| `public/conciliador-entradas.html` | Criar | Tela — cola/importa extrato, mostra itens + card de cartão |
| `public/nav.js` | Modificar | Item de menu abaixo de "Conciliação de Saídas" |

---

### Task 1: `parseEntradas`/`parseEntradasOfx` + categorização (`lib/extrato-parser.js`)

**Files:**
- Modify: `lib/extrato-parser.js`

**Interfaces:**
- Produces: `parseEntradas(txtContent) -> Array<{data, dataBr, historico, valor, categoria, favorecido, documento, tipoDocumento}>`, `parseEntradasOfx(ofxContent) -> mesmo formato`, `classificarEntrada(historico) -> 'pix_recebido'|'deposito_boleto'|'cartao'|'outro'`. Consumidas pela Task 3 (motor) e Task 5 (endpoint).

- [ ] **Step 1: Adicionar a lista de operadoras de cartão e o classificador, logo após `TIPOS_SALARIO` (linha 11)**

```js
// Categorização best-effort das ENTRADAS — diferente das saídas, ainda não
// foi validada contra extrato real (o Tiago vai confirmar os padrões reais
// quando processar o primeiro extrato de verdade; se aparecer um prefixo
// novo, seguir o mesmo padrão de refinamento incremental já usado acima
// pras saídas, ex: achado de "SISPAG DIVERSOS" em 03/09/2026).
const OPERADORAS_CARTAO = [
  'REDE', 'CIELO', 'GETNET', 'STONE', 'PAGSEGURO', 'PAGBANK',
  'MERCADOPAGO', 'SAFRAPAY', 'VERO', 'FISERV'
];

function classificarEntrada(historico) {
  const h = historico.trim().toUpperCase();
  if (h.startsWith('PIX RECEBIDO')) return 'pix_recebido';
  if (h.startsWith('BOLETO RECEBIDO') || h.startsWith('TED RECEBID') || h.startsWith('DOC RECEBID') || h.startsWith('DEPOSITO')) return 'deposito_boleto';
  if (OPERADORAS_CARTAO.some(op => h.includes(op))) return 'cartao';
  return 'outro';
}

function extrairFavorecidoEntrada(historico, categoria, doc) {
  let resto = historico.trim();
  if (categoria === 'pix_recebido') resto = resto.replace(/^PIX RECEBIDO\s*/i, '');
  else if (categoria === 'deposito_boleto') resto = resto.replace(/^(BOLETO RECEBIDO|TED RECEBID[AO]|DOC RECEBID[AO]|DEPOSITO)\s*/i, '');
  if (doc) resto = resto.split(doc)[0];
  return resto.trim().replace(/\s+/g, ' ');
}
```

- [ ] **Step 2: Adicionar `parseEntradas` e `parseEntradasOfx`, logo antes de `module.exports` (fim do arquivo)**

```js
// Parseia o TXT completo e retorna somente as entradas (valor positivo).
function parseEntradas(txtContent) {
  const linhas = txtContent.split(/\r?\n/).filter(l => l.trim());
  const entradas = [];
  for (const linha of linhas) {
    const partes = linha.split(';');
    if (partes.length < 3) continue;
    const [dataStr, historico, valorStr] = partes;
    if (!dataStr || !historico) continue;
    const valor = parseValor(valorStr);
    if (isNaN(valor) || valor <= 0) continue;

    const categoria = classificarEntrada(historico);
    const { doc, tipoDoc } = extrairDocumento(historico);
    const favorecido = extrairFavorecidoEntrada(historico, categoria, doc);

    entradas.push({
      data: parseData(dataStr),
      dataBr: dataStr.trim(),
      historico: historico.trim(),
      valor,
      categoria,
      favorecido,
      documento: doc,
      tipoDocumento: tipoDoc
    });
  }
  return entradas;
}

// Mesma ideia de parseSaidasOfx, mas filtra valor positivo (entrada).
function parseEntradasOfx(ofxContent) {
  const entradas = [];
  const blocos = ofxContent.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  for (const bloco of blocos) {
    const dtM = bloco.match(/<DTPOSTED>([^\r\n<]+)/i);
    const valM = bloco.match(/<TRNAMT>([^\r\n<]+)/i);
    const memoM = bloco.match(/<MEMO>([^\r\n<]+)/i);
    const nameM = bloco.match(/<NAME>([^\r\n<]+)/i);
    if (!dtM || !valM) continue;

    const valor = parseValorOfx(valM[1]);
    if (isNaN(valor) || valor <= 0) continue;

    const data = parseDataOfx(dtM[1]);
    if (!data) continue;

    const historico = [nameM && nameM[1].trim(), memoM && memoM[1].trim()]
      .filter(Boolean).join(' ').trim() || '(sem histórico)';

    const categoria = classificarEntrada(historico);
    const { doc, tipoDoc } = extrairDocumento(historico);
    const favorecido = extrairFavorecidoEntrada(historico, categoria, doc);

    const [y, mo, d] = data.split('-');
    entradas.push({
      data,
      dataBr: `${d}/${mo}/${y}`,
      historico,
      valor,
      categoria,
      favorecido,
      documento: doc,
      tipoDocumento: tipoDoc
    });
  }
  return entradas;
}
```

- [ ] **Step 3: Atualizar `module.exports` no fim do arquivo**

```js
module.exports = {
  parseSaidas, parseSaidasOfx, parseSaidasApi, classificar, extrairDocumento, extrairFavorecido,
  parseEntradas, parseEntradasOfx, classificarEntrada, extrairFavorecidoEntrada
};
```

- [ ] **Step 4: Verificar manualmente com um script Node ad-hoc (sem framework de teste no projeto)**

Criar um arquivo temporário `C:\Users\tiago\AppData\Local\Temp\claude\verify-parse-entradas.js`:

```js
const { parseEntradas, classificarEntrada } = require('C:/Users/tiago/OneDrive/Documentos/economico-relatorios-app/lib/extrato-parser');

const txt = [
  '01/09/2026;PIX RECEBIDO JOAO DA SILVA 123.456.789-00;520,00;',
  '01/09/2026;BOLETO RECEBIDO DISTRIBUIDORA XYZ LTDA 12.345.678/0001-90;1500,50;',
  '02/09/2026;REDE SA LIQUIDACAO;3200,10;',
  '02/09/2026;RESGATE APLIC AUT MAIS;800,00;',
  '02/09/2026;PIX ENVIADO ALGUEM;-50,00;' // saída, deve ser ignorada
].join('\n');

const r = parseEntradas(txt);
console.log(JSON.stringify(r.map(x => ({ valor: x.valor, categoria: x.categoria, favorecido: x.favorecido })), null, 2));
console.log('total de linhas (esperado 4, a saída deve ser ignorada):', r.length);
```

Run: `node "C:\Users\tiago\AppData\Local\Temp\claude\verify-parse-entradas.js"`

Expected: 4 entradas (não 5 — a linha `PIX ENVIADO` com valor negativo não entra), categorias `pix_recebido`, `deposito_boleto`, `cartao`, `outro` nessa ordem, favorecidos extraídos sem o prefixo do tipo.

Apagar o arquivo temporário depois de confirmar.

- [ ] **Step 5: Commit**

```bash
git add lib/extrato-parser.js
git commit -m "feat: adiciona parseEntradas/parseEntradasOfx ao extrato-parser"
```

---

### Task 2: `parseEntradasApi` (`lib/extrato-parser.js`)

**Files:**
- Modify: `lib/extrato-parser.js`

**Interfaces:**
- Consumes: `OPERADORAS_CARTAO`, `extrairFavorecidoEntrada` (Task 1).
- Produces: `parseEntradasApi(apiResult) -> mesmo formato de parseEntradas`. Consumida pela Task 5 (endpoint `/processar-api`).

- [ ] **Step 1: Adicionar `classificarApiEntrada` e `parseEntradasApi`, depois de `parseSaidasApi` e antes de `module.exports`**

```js
// Mesma ideia de classificarApi (saídas), mas pro vocabulário de entrada.
// Como classificarApi(saídas), foi ajustado com achados reais ao longo do
// tempo (ver comentário acima de CODIGO_CATEGORIA_API) — aqui ainda não
// existe um mapa de código validado pra entrada, então usa só o texto
// (literal.shortened/complete) até aparecer um extrato real da API pra
// confirmar os códigos.
function classificarApiEntrada(literal) {
  const texto = (literal.shortened || literal.complete || '').trim().toUpperCase();
  if (texto.startsWith('PIX RECEBIDO')) return 'pix_recebido';
  if (texto.startsWith('BOLETO RECEBIDO') || texto.startsWith('TED RECEBID') || texto.startsWith('DOC RECEBID') || texto.startsWith('DEPOSITO')) return 'deposito_boleto';
  if (OPERADORAS_CARTAO.some(op => texto.includes(op))) return 'cartao';
  return 'outro';
}

// Converte o retorno da API oficial do Itaú (lib/itau-extrato.js
// buscarExtrato) em entradas (operation === 'C', crédito) no mesmo formato
// de parseEntradas/parseEntradasOfx.
function parseEntradasApi(apiResult) {
  const eventos = (apiResult.data || []).flatMap(d => d.events || []);
  const entradas = [];
  for (const ev of eventos) {
    if (ev.type !== 'lancamento' || ev.operation !== 'C') continue;
    const valor = Number(ev.amount && ev.amount.value);
    if (isNaN(valor) || valor <= 0) continue;

    const data = ev.date && ev.date.accounting;
    if (!data) continue;
    const [y, mo, d] = data.split('-');

    const historico = ((ev.literal && (ev.literal.complete || ev.literal.shortened)) || '(sem histórico)').trim().replace(/\s+/g, ' ');
    const categoria = classificarApiEntrada(ev.literal || {});
    const cp = ev.counterpart || {};
    const documento = cp.document || null;
    const tipoDocumento = cp.person === 'FISICA' ? 'CPF' : (cp.person === 'JURIDICA' ? 'CNPJ' : null);
    const favorecido = cp.name || extrairFavorecidoEntrada(historico, categoria, documento);

    entradas.push({
      data,
      dataBr: `${d}/${mo}/${y}`,
      historico,
      valor,
      categoria,
      favorecido,
      documento,
      tipoDocumento
    });
  }
  return entradas;
}
```

- [ ] **Step 2: Atualizar `module.exports`**

```js
module.exports = {
  parseSaidas, parseSaidasOfx, parseSaidasApi, classificar, extrairDocumento, extrairFavorecido,
  parseEntradas, parseEntradasOfx, classificarEntrada, extrairFavorecidoEntrada, parseEntradasApi
};
```

- [ ] **Step 3: Verificar manualmente com um script Node ad-hoc**

```js
const { parseEntradasApi } = require('C:/Users/tiago/OneDrive/Documentos/economico-relatorios-app/lib/extrato-parser');

const mockApi = {
  data: [{
    events: [
      { type: 'lancamento', operation: 'C', amount: { value: '520.00' }, date: { accounting: '2026-09-01' },
        literal: { complete: 'PIX RECEBIDO JOAO DA SILVA' }, counterpart: { name: 'JOAO DA SILVA', document: '12345678900', person: 'FISICA' } },
      { type: 'lancamento', operation: 'D', amount: { value: '-100.00' }, date: { accounting: '2026-09-01' },
        literal: { complete: 'PIX ENVIADO FULANO' } } // saída, deve ser ignorada
    ]
  }]
};

const r = parseEntradasApi(mockApi);
console.log(JSON.stringify(r, null, 2));
console.log('total (esperado 1):', r.length);
```

Run: `node <caminho-do-arquivo-temporário>.js`

Expected: 1 entrada, `categoria: 'pix_recebido'`, `favorecido: 'JOAO DA SILVA'`, `valor: 520`.

- [ ] **Step 4: Commit**

```bash
git add lib/extrato-parser.js
git commit -m "feat: adiciona parseEntradasApi ao extrato-parser"
```

---

### Task 3: Motor de casamento (`lib/conciliador-entradas.js`)

**Files:**
- Create: `lib/conciliador-entradas.js`

**Interfaces:**
- Consumes: `normalizarNome, similaridadeNome, addDias, TOLERANCIA_DIAS` de `./conciliador` (já existem e são exportados).
- Consumes: itens no formato de `parseEntradas()`/`parseEntradasApi()` (Tasks 1-2) — `{data, valor, categoria, favorecido, ...}`.
- Consumes: candidatos no formato de `buscarCandidatosFatura()` (Task 4) — `{nFatura, CodCliente, DataVenda, DataVencto, Valor, EmAberto, NomeCliente, Empresa, DataPagto, ValorPago}`.
- Produces: `conciliarEntradas(entradas, candidatos) -> Array<item + {status, match, candidatos}>`, `status` ∈ `'conciliado'|'baixa_pendente'|'revisar'|'nao_encontrado'|'cartao'|'fora_escopo'`. Consumida pela Task 4 (`processarConciliacaoEntradas`).

- [ ] **Step 1: Criar o arquivo completo**

```js
// Motor de conciliação de entradas: casa entradas do extrato (categorias
// pix_recebido/deposito_boleto — ver lib/extrato-parser.js) com faturas de
// crediário/B2B do ERP (cargaaux.fatura / cargaaux.faturabaixa). Cartão
// débito/crédito NÃO passa por aqui — o ERP não tem lançamento diário por
// forma de pagamento nessa instalação (confirmado via COUNT(*) real em
// cartaomaquineta/cartaolancamento/zcupompagto, todas vazias), então vira
// uma conferência agregada mensal calculada em server.js. Ver design em
// docs/superpowers/specs/2026-09-03-conciliacao-entradas-design.md.

const { normalizarNome, similaridadeNome, addDias, TOLERANCIA_DIAS } = require('./conciliador');

const CATEGORIAS_RECEBIVEL = ['pix_recebido', 'deposito_boleto'];

// Tolerância de valor pra achar fatura "parecida" quando não existe uma com
// valor idêntico — cobre desconto de antecipação ou juros/multa que mudam
// o valor recebido em relação ao título original. Mesmo valor usado na
// Conciliação de Saídas (lib/conciliador.js).
const TOLERANCIA_VALOR = 15;

function diffDias(dataA, dataB) {
  const ms = Math.abs(new Date(dataA) - new Date(dataB));
  return Math.round(ms / 86400000);
}

// Fatura já baixada usa o valor de referência da baixa (pode ter desconto),
// fatura em aberto usa o valor do título.
function valorReferencia(c) {
  return c.DataPagto && c.ValorPago != null ? Number(c.ValorPago) : Number(c.Valor);
}

function montarMatch(c) {
  return {
    nFatura: c.nFatura,
    cliente: c.NomeCliente || c.Empresa || '(sem cadastro)',
    codCliente: c.CodCliente,
    valor: Number(c.Valor),
    emAberto: Number(c.EmAberto),
    dataVenda: c.DataVenda,
    dataVencto: c.DataVencto,
    baixado: !!c.DataPagto,
    dataPagto: c.DataPagto || null,
    valorPago: c.ValorPago != null ? Number(c.ValorPago) : null
  };
}

// DataPagto presente (existe baixa em cargaaux.faturabaixa) -> conciliado.
// Sem baixa (só título em aberto) -> baixa_pendente (o cliente pode já ter
// pago — é isso que o depósito no banco está confirmando — mas ninguém deu
// baixa no título ainda, mesmo espírito de baixa_pendente na Conciliação de
// Saídas).
function statusFinal(c) {
  return c.DataPagto ? 'conciliado' : 'baixa_pendente';
}

// Quando não existe fatura com valor de referência idêntico, procura uma
// "parecida" (mesmo cliente, vencimento próximo, valor dentro de
// TOLERANCIA_VALOR). Só assume automaticamente quando o nome do cliente bate
// razoavelmente E não há ambiguidade — mesmo princípio de
// acharDivergenciaValor em lib/conciliador.js.
function acharDivergenciaValor(entrada, candidatos, usados) {
  const pontuados = candidatos
    .filter(c => !usados.has(c.nFatura))
    .map(c => ({
      c,
      dias: diffDias(entrada.data, c.DataVencto),
      delta: Math.abs(entrada.valor - valorReferencia(c)),
      sim: similaridadeNome(entrada.favorecido, c.NomeCliente || c.Empresa)
    }))
    .filter(x => x.dias <= TOLERANCIA_DIAS && x.delta > 0 && x.delta <= TOLERANCIA_VALOR && x.sim > 0.5)
    .map(x => ({ ...x, score: x.sim * 2 - x.dias * 0.1 - x.delta * 0.05 }))
    .sort((a, b) => b.score - a.score);

  if (!pontuados.length) return null;
  if (pontuados.length > 1 && pontuados[0].score - pontuados[1].score < 0.3) return null;
  return pontuados[0].c;
}

// entradas: retorno de parseEntradas()/parseEntradasApi(). candidatos: linhas
// de cargaaux.fatura + cliente + faturabaixa (ver buscarCandidatosFatura em
// server.js), sem filtro de EmAberto/baixa — a decisão de status acontece
// aqui, olhando pra ambos os casos (baixada ou não) no mesmo pool.
function conciliarEntradas(entradas, candidatos) {
  const porValor = new Map();
  for (const c of candidatos) {
    const key = valorReferencia(c).toFixed(2);
    if (!porValor.has(key)) porValor.set(key, []);
    porValor.get(key).push(c);
  }

  const usados = new Set();

  return entradas.map(entrada => {
    if (entrada.categoria === 'cartao') {
      return { ...entrada, status: 'cartao', match: null, candidatos: [] };
    }
    if (!CATEGORIAS_RECEBIVEL.includes(entrada.categoria)) {
      return { ...entrada, status: 'fora_escopo', match: null, candidatos: [] };
    }

    const key = entrada.valor.toFixed(2);
    const pool = (porValor.get(key) || []).filter(c => !usados.has(c.nFatura));
    const dentroTolerancia = pool.filter(c => diffDias(entrada.data, c.DataVencto) <= TOLERANCIA_DIAS);

    if (!dentroTolerancia.length) {
      const divergente = acharDivergenciaValor(entrada, candidatos, usados);
      if (divergente) {
        usados.add(divergente.nFatura);
        return { ...entrada, status: statusFinal(divergente), match: montarMatch(divergente), candidatos: [] };
      }
      return { ...entrada, status: 'nao_encontrado', match: null, candidatos: [] };
    }

    const pontuados = dentroTolerancia
      .map(c => ({ c, score: similaridadeNome(entrada.favorecido, c.NomeCliente || c.Empresa) * 2 - diffDias(entrada.data, c.DataVencto) * 0.1 }))
      .sort((a, b) => b.score - a.score);

    if (pontuados.length === 1) {
      const c = pontuados[0].c;
      usados.add(c.nFatura);
      return { ...entrada, status: statusFinal(c), match: montarMatch(c), candidatos: [] };
    }

    const [melhor, segundo] = pontuados;
    if (melhor.score > 0 && melhor.score - segundo.score >= 0.5) {
      usados.add(melhor.c.nFatura);
      return { ...entrada, status: statusFinal(melhor.c), match: montarMatch(melhor.c), candidatos: [] };
    }

    return {
      ...entrada,
      status: 'revisar',
      match: null,
      candidatos: pontuados.map(p => montarMatch(p.c))
    };
  });
}

module.exports = { conciliarEntradas, TOLERANCIA_VALOR };
```

- [ ] **Step 2: Verificar manualmente com um script Node ad-hoc cobrindo os 6 status possíveis**

```js
const { conciliarEntradas } = require('C:/Users/tiago/OneDrive/Documentos/economico-relatorios-app/lib/conciliador-entradas');

const entradas = [
  { data: '2026-09-05', valor: 1000.00, categoria: 'deposito_boleto', favorecido: 'CLIENTE UM' },       // -> conciliado (baixado)
  { data: '2026-09-05', valor: 2000.00, categoria: 'pix_recebido', favorecido: 'CLIENTE DOIS' },        // -> baixa_pendente (em aberto)
  { data: '2026-09-05', valor: 3000.00, categoria: 'deposito_boleto', favorecido: 'CLIENTE TRES' },     // -> revisar (2 candidatos ambíguos)
  { data: '2026-09-05', valor: 4000.00, categoria: 'pix_recebido', favorecido: 'NINGUEM CONHECIDO' },   // -> nao_encontrado
  { data: '2026-09-05', valor: 500.00, categoria: 'cartao', favorecido: 'REDE SA' },                     // -> cartao
  { data: '2026-09-05', valor: 100.00, categoria: 'outro', favorecido: 'RESGATE' }                        // -> fora_escopo
];

const candidatos = [
  { nFatura: 1, CodCliente: 1, DataVenda: '2026-08-30', DataVencto: '2026-09-04', Valor: 1000.00, EmAberto: 0, NomeCliente: 'CLIENTE UM', Empresa: null, DataPagto: '2026-09-05', ValorPago: 1000.00 },
  { nFatura: 2, CodCliente: 2, DataVenda: '2026-08-30', DataVencto: '2026-09-04', Valor: 2000.00, EmAberto: 2000.00, NomeCliente: 'CLIENTE DOIS', Empresa: null, DataPagto: null, ValorPago: null },
  { nFatura: 3, CodCliente: 3, DataVenda: '2026-08-30', DataVencto: '2026-09-04', Valor: 3000.00, EmAberto: 3000.00, NomeCliente: 'CLIENTE TRES', Empresa: null, DataPagto: null, ValorPago: null },
  { nFatura: 4, CodCliente: 3, DataVenda: '2026-08-31', DataVencto: '2026-09-06', Valor: 3000.00, EmAberto: 3000.00, NomeCliente: 'CLIENTE TRES', Empresa: null, DataPagto: null, ValorPago: null }
];

const r = conciliarEntradas(entradas, candidatos);
console.log(r.map(x => `${x.favorecido}: ${x.status}`).join('\n'));
```

Run: `node <caminho-do-arquivo-temporário>.js`

Expected:
```
CLIENTE UM: conciliado
CLIENTE DOIS: baixa_pendente
CLIENTE TRES: revisar
NINGUEM CONHECIDO: nao_encontrado
REDE SA: cartao
RESGATE: fora_escopo
```

- [ ] **Step 3: Commit**

```bash
git add lib/conciliador-entradas.js
git commit -m "feat: adiciona motor de casamento da Conciliação de Entradas"
```

---

### Task 4: Helpers de query e orquestração (`server.js`)

**Files:**
- Modify: `server.js:11` (requires), `server.js` após linha 4990 (fim da seção CONCILIADOR CD, antes de `// ── API DE EXTRATO DO ITAÚ`)

**Interfaces:**
- Consumes: `q()`, `addDias()`, `pagtoLabels` (já existem em `server.js`), `conciliarEntradas()` (Task 3), `parseEntradas/parseEntradasOfx/parseEntradasApi` (Tasks 1-2).
- Produces: `processarConciliacaoEntradas(entradas, loja) -> {loja, total, totalValor, resumo, itens, cartao}`. Consumida pela Task 5 (endpoints).

- [ ] **Step 1: Atualizar a linha de require do `extrato-parser` (linha 11)**

Trocar:
```js
const { parseSaidas, parseSaidasOfx, parseSaidasApi } = require('./lib/extrato-parser');
```
Por:
```js
const { parseSaidas, parseSaidasOfx, parseSaidasApi, parseEntradas, parseEntradasOfx, parseEntradasApi } = require('./lib/extrato-parser');
```

- [ ] **Step 2: Adicionar o require do motor de entradas, logo depois da linha 12 (require de `./lib/conciliador`)**

```js
const { conciliarEntradas } = require('./lib/conciliador-entradas');
```

- [ ] **Step 3: Inserir a nova seção depois da linha 4990 (depois do `});` que fecha `/api/conciliador-cd/nota-detalhe`, antes do comentário `// ── API DE EXTRATO DO ITAÚ`)**

```js
// ── CONCILIAÇÃO DE ENTRADAS ──────────────────────────────
// Cruza as entradas (valor positivo) de um extrato bancário com faturas de
// crediário/B2B do ERP (cargaaux.fatura / cargaaux.faturabaixa) — mesmo
// espírito da Conciliação de Saídas, mas pro que entrou na conta. Cartão
// débito/crédito não casa linha a linha (ERP não tem lançamento diário por
// forma de pagamento nessa instalação) — vira conferência agregada contra
// dashboard.tipovendas. Ver docs/superpowers/specs/2026-09-03-conciliacao-entradas-design.md.

async function buscarCandidatosFatura(loja, dIni, dFim) {
  return q(`
    SELECT f.nFatura, f.CodCliente, f.Nloja,
           DATE_FORMAT(f.DataVenda,'%Y-%m-%d') as DataVenda,
           DATE_FORMAT(f.DataVencto,'%Y-%m-%d') as DataVencto,
           f.Valor, f.EmAberto,
           cl.Nome as NomeCliente, cl.Empresa,
           DATE_FORMAT(fb.DataPagto,'%Y-%m-%d') as DataPagto, fb.ValorPago
    FROM cargaaux.fatura f
    LEFT JOIN cargaaux.cliente cl ON cl.CodCliente = f.CodCliente
    LEFT JOIN (
      SELECT b1.nFatura, b1.DataPagto, b1.ValorPago
      FROM cargaaux.faturabaixa b1
      INNER JOIN (
        SELECT nFatura, MAX(DataPagto) as maxData FROM cargaaux.faturabaixa GROUP BY nFatura
      ) b2 ON b2.nFatura = b1.nFatura AND b2.maxData = b1.DataPagto
    ) fb ON fb.nFatura = f.nFatura
    WHERE f.Nloja = ? AND f.DataVencto BETWEEN ? AND ?
  `, [loja, dIni, dFim]);
}

// Soma o total de vendas por forma de pagamento (dashboard.tipovendas) pros
// meses cobertos pelo período do extrato — só granularidade mensal existe
// pra cartão (ver spec), então a comparação é sempre por mês inteiro, nunca
// por dia.
async function buscarTotalCartaoMes(loja, meses) {
  if (!meses.length) return [];
  const condicoes = meses.map(() => '(Ano=? AND Mes=?)').join(' OR ');
  const params = [loja];
  meses.forEach(m => params.push(m.ano, m.mes));
  const rows = await q(
    `SELECT Ano, Mes, TipoPagto, SUM(Total) as total FROM dashboard.tipovendas
     WHERE nLoja=? AND (${condicoes}) GROUP BY Ano, Mes, TipoPagto`,
    params
  );
  return rows.map(r => ({ ano: r.Ano, mes: r.Mes, tipo: pagtoLabels[r.TipoPagto] || `Tipo ${r.TipoPagto}`, total: parseFloat(r.total) }));
}

function mesesEntrePeriodo(dIni, dFim) {
  const meses = [];
  let [ano, mes] = dIni.split('-').map(Number);
  const [anoFim, mesFim] = dFim.split('-').map(Number);
  while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
    meses.push({ ano, mes });
    mes++;
    if (mes > 12) { mes = 1; ano++; }
  }
  return meses;
}

async function processarConciliacaoEntradas(entradas, loja) {
  const datas = entradas.map(e => e.data).sort();
  const dIni = addDias(datas[0], -TOLERANCIA_CONCILIADOR);
  const dFim = addDias(datas[datas.length - 1], TOLERANCIA_CONCILIADOR);

  const candidatos = await buscarCandidatosFatura(loja, dIni, dFim);
  const itens = conciliarEntradas(entradas, candidatos);

  const resumo = { conciliado: 0, baixa_pendente: 0, revisar: 0, nao_encontrado: 0, cartao: 0, fora_escopo: 0 };
  let totalValor = 0;
  for (const it of itens) { resumo[it.status]++; totalValor += it.valor; }

  const meses = mesesEntrePeriodo(datas[0], datas[datas.length - 1]);
  const cartaoBanco = itens.filter(it => it.status === 'cartao').reduce((s, it) => s + it.valor, 0);
  const cartaoErp = await buscarTotalCartaoMes(loja, meses);
  const cartaoErpTotal = cartaoErp
    .filter(c => c.tipo === 'PIX / Débito' || c.tipo === 'Crédito')
    .reduce((s, c) => s + c.total, 0);

  return {
    loja, total: itens.length, totalValor: +totalValor.toFixed(2), resumo, itens,
    cartao: {
      totalBanco: +cartaoBanco.toFixed(2),
      totalErp: +cartaoErpTotal.toFixed(2),
      diferenca: +(cartaoBanco - cartaoErpTotal).toFixed(2),
      meses,
      semDadoErp: cartaoErp.length === 0
    }
  };
}
```

- [ ] **Step 4: Verificar as queries direto no ERP via SSH no `.254` (não dá pra rodar local — `192.168.2.252` só é alcançável a partir do `.254`)**

Rodar (mesmo padrão de base64+certutil usado nesta sessão pra diagnóstico, evita problema de quoting):

```bash
cat > /tmp/verify-fatura-query.js << 'EOF'
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({host:'192.168.2.252', port:3306, user:'root', password:'1900', connectTimeout:15000});
  const [rows] = await conn.query(`
    SELECT f.nFatura, f.CodCliente, f.Nloja,
           DATE_FORMAT(f.DataVenda,'%Y-%m-%d') as DataVenda,
           DATE_FORMAT(f.DataVencto,'%Y-%m-%d') as DataVencto,
           f.Valor, f.EmAberto,
           cl.Nome as NomeCliente, cl.Empresa,
           DATE_FORMAT(fb.DataPagto,'%Y-%m-%d') as DataPagto, fb.ValorPago
    FROM cargaaux.fatura f
    LEFT JOIN cargaaux.cliente cl ON cl.CodCliente = f.CodCliente
    LEFT JOIN (
      SELECT b1.nFatura, b1.DataPagto, b1.ValorPago
      FROM cargaaux.faturabaixa b1
      INNER JOIN (SELECT nFatura, MAX(DataPagto) as maxData FROM cargaaux.faturabaixa GROUP BY nFatura) b2
        ON b2.nFatura = b1.nFatura AND b2.maxData = b1.DataPagto
    ) fb ON fb.nFatura = f.nFatura
    WHERE f.Nloja = 4 AND f.DataVencto BETWEEN '2026-08-01' AND '2026-09-03'
    LIMIT 5
  `);
  console.log(JSON.stringify(rows, null, 2));
  const [tv] = await conn.query("SELECT Ano, Mes, TipoPagto, SUM(Total) as total FROM dashboard.tipovendas WHERE nLoja=4 AND ((Ano=2026 AND Mes=9)) GROUP BY Ano, Mes, TipoPagto");
  console.log(JSON.stringify(tv, null, 2));
  await conn.end();
})().catch(e => console.log('ERR ' + e.message));
EOF
base64 -w0 /tmp/verify-fatura-query.js > /tmp/verify_b64.txt
B64=$(cat /tmp/verify_b64.txt)
ssh -i ~/.ssh/claude_254 claude-ssh@100.102.231.28 "cd /d C:\\fc360\\claude_code_ & echo $B64 > vf.b64 & certutil -decode vf.b64 vf.js & node vf.js & del vf.b64 vf.js"
```

Expected: primeiro bloco JSON com linhas de `cargaaux.fatura` da loja 4 (ajustar o número da loja/datas se não houver fatura nesse intervalo — usar os totais achados na investigação desta sessão como referência: loja 4 tem 961 faturas entre 2022 e 2026), sem erro de sintaxe SQL. Segundo bloco com o total de `dashboard.tipovendas` de setembro/2026 pra loja 4 (confirmado nesta sessão: existe linha real pra essa combinação).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: adiciona helpers de query e processarConciliacaoEntradas"
```

---

### Task 5: Endpoints `/api/conciliador-entradas/*` (`server.js`)

**Files:**
- Modify: `server.js` (logo depois do bloco da Task 4, mesma seção)

**Interfaces:**
- Consumes: `processarConciliacaoEntradas` (Task 4), `parseEntradas/parseEntradasOfx/parseEntradasApi` (Tasks 1-2), `itauExtrato.buscarExtrato` (já existe em `lib/itau-extrato.js`).
- Produces: `POST /api/conciliador-entradas/processar`, `POST /api/conciliador-entradas/processar-api`. Consumidos pela Task 6 (HTML).

- [ ] **Step 1: Adicionar os dois endpoints logo depois de `processarConciliacaoEntradas` (fim do bloco da Task 4)**

```js
app.post('/api/conciliador-entradas/processar', async (req, res) => {
  try {
    const texto = (req.body && req.body.texto) || '';
    const loja = parseInt(req.body && req.body.loja);
    if (!texto.trim()) return res.status(400).json({ error: 'Cole o extrato antes de processar.' });
    if (!loja || loja < 1 || loja > 6) return res.status(400).json({ error: 'Selecione a loja desse extrato antes de processar — cada loja tem conta bancária própria, e o casamento é feito só contra os títulos dessa filial.' });

    const ehOfx = /<OFX>|<STMTTRN>/i.test(texto);
    const entradas = ehOfx ? parseEntradasOfx(texto) : parseEntradas(texto);
    if (!entradas.length) return res.status(400).json({ error: ehOfx ? 'Nenhuma entrada encontrada no OFX.' : 'Nenhuma entrada encontrada no texto colado. Confira o formato (data;histórico;valor;).' });

    res.json(await processarConciliacaoEntradas(entradas, loja));
  } catch (err) {
    console.error('[CONCILIADOR-ENTRADAS-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao processar conciliação de entradas.' });
  }
});

// Mesmo padrão de /api/conciliador/processar-api (Saídas): admin only, usa
// lib/itau-extrato.js já existente. A loja continua escolhida manualmente.
app.post('/api/conciliador-entradas/processar-api', async (req, res) => {
  if (!req.session.user || req.session.user.perfil !== 'admin') return res.status(403).json({ error: 'Só admin.' });
  try {
    const itauExtrato = require('./lib/itau-extrato');
    const conta = req.body && req.body.conta;
    const loja = parseInt(req.body && req.body.loja);
    if (!conta) return res.status(400).json({ error: 'Informe a conta (ex: cahu, muribeca).' });
    if (!loja || loja < 1 || loja > 6) return res.status(400).json({ error: 'Selecione a loja desse extrato antes de processar — cada loja tem conta bancária própria, e o casamento é feito só contra os títulos dessa filial.' });

    const dataFim = (req.body && req.body.fim) || new Date().toISOString().slice(0, 10);
    const dataIni = (req.body && req.body.inicio) || addDias(dataFim, -60);
    const resultado = await itauExtrato.buscarExtrato({ conta, dataInicio: dataIni, dataFim });
    const entradas = parseEntradasApi(resultado);
    if (!entradas.length) return res.status(400).json({ error: `Nenhuma entrada encontrada no extrato da API entre ${dataIni} e ${dataFim}.` });

    res.json(await processarConciliacaoEntradas(entradas, loja));
  } catch (err) {
    console.error('[CONCILIADOR-ENTRADAS-API-ERR]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao importar extrato via API do Itaú.' });
  }
});
```

- [ ] **Step 2: Verificar sintaxe do arquivo antes de commitar**

Run: `node -c server.js`

Expected: sem output (sintaxe válida). Se der erro, corrigir antes de prosseguir — esse é o único jeito de pegar erro de sintaxe sem subir pro `.254` primeiro.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: adiciona endpoints /api/conciliador-entradas/processar[-api]"
```

---

### Task 6: Tela `public/conciliador-entradas.html`

**Files:**
- Create: `public/conciliador-entradas.html`

**Interfaces:**
- Consumes: `POST /api/conciliador-entradas/processar`, `POST /api/conciliador-entradas/processar-api` (Task 5). Resposta: `{loja, total, totalValor, resumo: {conciliado, baixa_pendente, revisar, nao_encontrado, cartao, fora_escopo}, itens: [{data, dataBr, historico, valor, categoria, favorecido, status, match, candidatos}], cartao: {totalBanco, totalErp, diferenca, meses, semDadoErp}}`.

- [ ] **Step 1: Criar o arquivo completo**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/design-system.css">
<script src="/nav.js" defer></script>
<title>Conciliação de Entradas — Econômico Relatórios</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#EBEBE9; --surface:#FFFFFF; --surface-2:#E4E4E1;
  --border:#DADAD6; --border-strong:#C9C9C4;
  --ink:#0E1626; --ink-2:#4E5A72; --ink-3:#98A0B3;
  --brand:#F5B800; --brand-ink:#6B4E00;
  --green:#137A48; --green-bg:#E7F5EC;
  --red:#C22F49; --red-bg:#FBEAED;
  --amber:#B45C00; --amber-bg:#FBEDDD;
  --font:'InterVar','Inter','Segoe UI',system-ui,-apple-system,sans-serif;
}
body{font-family:var(--font);background:var(--bg);color:var(--ink);min-height:100vh}
.main{padding:24px}
.page-hdr{margin-bottom:18px}
.page-hdr h1{font-size:21px;font-weight:800;color:var(--ink)}
.page-hdr p{font-size:12px;color:var(--ink-3);margin-top:2px}
.entrada{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:18px;box-shadow:0 1px 2px rgba(22,35,63,.04)}
.entrada label{font-size:10px;color:var(--ink-3);font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px}
.entrada textarea{width:100%;min-height:120px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--ink);padding:10px 12px;font-size:12px;font-family:ui-monospace,Consolas,monospace;outline:none;resize:vertical}
.entrada textarea:focus{border-color:var(--brand)}
.entrada-foot{display:flex;align-items:center;justify-content:space-between;margin-top:10px;flex-wrap:wrap;gap:8px}
.entrada-hint{font-size:11px;color:var(--ink-3)}
.btn{border:none;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font)}
.btn-blue{background:var(--brand);color:var(--brand-ink)}.btn-blue:hover{background:#E5AC00}
.btn-blue:disabled{opacity:.5;cursor:not-allowed}
.btn-slate{background:var(--surface);color:var(--ink-2);border:1px solid var(--border-strong)}.btn-slate:hover{background:var(--surface-2)}
.kpi-row{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 16px;min-width:120px;flex:1;box-shadow:0 1px 2px rgba(22,35,63,.04);cursor:pointer;transition:border-color .12s}
.kpi:hover{border-color:var(--border-strong)}
.kpi.on{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand) inset}
.kpi .v{font-size:20px;font-weight:800}
.kpi .l{font-size:10px;color:var(--ink-3);margin-top:2px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
.cartao-card{background:var(--surface);border:2px solid var(--brand);border-radius:12px;padding:14px 18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(22,35,63,.04)}
.cartao-card h3{font-size:13px;font-weight:800;margin-bottom:8px}
.cartao-row{display:flex;gap:20px;flex-wrap:wrap;font-size:13px}
.cartao-row .item .l{font-size:10px;color:var(--ink-3);font-weight:700;text-transform:uppercase;letter-spacing:.4px}
.cartao-row .item .v{font-size:16px;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums}
.cartao-obs{font-size:11px;color:var(--ink-3);margin-top:8px}
.table-wrap{overflow-x:auto;border-radius:12px;border:1px solid var(--border);background:var(--surface)}
table.t{width:100%;border-collapse:collapse;font-size:12px}
table.t thead{background:var(--surface-2)}
table.t th{padding:8px 12px;text-align:left;color:var(--ink-3);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;border-bottom:1px solid var(--border)}
table.t td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:top}
table.t th.r,table.t td.r{text-align:right}
table.t tbody tr{cursor:pointer}
table.t tbody tr:hover{background:var(--surface-2)}
.fav{font-weight:600;color:var(--ink)}
.hist{font-size:10.5px;color:var(--ink-3);margin-top:1px}
.cat{font-size:10.5px;color:var(--ink-2)}
.val{font-variant-numeric:tabular-nums;font-weight:700;color:var(--ink);white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;border-radius:20px;padding:3px 9px;white-space:nowrap}
.pill-ok{background:var(--green-bg);color:var(--green)}
.pill-alerta{background:var(--red-bg);color:var(--red)}
.pill-revisar{background:var(--amber-bg);color:var(--amber)}
.pill-neutro{background:var(--surface-2);color:var(--ink-2)}
.backdrop{position:fixed;inset:0;background:rgba(14,22,38,.38);opacity:0;pointer-events:none;transition:opacity .18s ease;z-index:40}
.backdrop.on{opacity:1;pointer-events:auto}
.popup{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:92vw;background:var(--surface);
  box-shadow:-16px 0 40px -12px rgba(14,22,38,.28);overflow-y:auto;z-index:41;
  transform:translateX(100%);transition:transform .2s ease}
.popup.on{transform:translateX(0)}
.popup-close{position:absolute;top:12px;right:12px;width:30px;height:30px;border-radius:8px;border:1px solid var(--border-strong);
  background:var(--surface);color:var(--ink-2);cursor:pointer;display:flex;align-items:center;justify-content:center}
.popup-close:hover{background:var(--surface-2);color:var(--ink)}
.popup-close svg{width:15px;height:15px;stroke:currentColor;stroke-width:2;fill:none}
.popup-hd{padding:16px 46px 14px 16px;border-bottom:1px solid var(--border)}
.popup-hd h2{font-size:15px;font-weight:800;color:var(--ink);line-height:1.3}
.popup-hd .sub{font-size:10.5px;color:var(--ink-3);margin-top:2px}
.popup-bd{padding:16px}
.popup-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12.5px}
.popup-row .k{color:var(--ink-3)}
.popup-row .v{font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
.cand-list{margin-top:6px;display:flex;flex-direction:column;gap:6px}
.cand-item2{border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:11.5px}
.cand-item2 .nm{font-weight:700;color:var(--ink)}
.cand-item2 .meta{display:flex;justify-content:space-between;color:var(--ink-3);margin-top:2px}
.spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--brand);animation:spin .7s linear infinite;margin:30px auto}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{padding:30px;text-align:center;color:var(--ink-3);font-size:13px}
.err{background:var(--red-bg);border:1px solid var(--red);color:var(--red);border-radius:8px;padding:10px 14px;font-size:12px;margin-bottom:14px}
@media(max-width:768px){
  .main{padding:10px}
  .page-hdr h1{font-size:16px}
  .kpi-row{gap:6px}
  .kpi{min-width:calc(50% - 4px);padding:9px 10px}
  .kpi .v{font-size:16px}
  table.t{min-width:700px}
}
</style>
</head>
<body class="ds">

<div class="main">
  <div class="page-hdr">
    <h1>Conciliação de Entradas</h1>
    <p>Cole as entradas do extrato do banco e cruze com faturas/crediário do ERP</p>
  </div>

  <div class="entrada">
    <label>Loja do extrato — cada loja tem conta bancária própria, então o casamento é feito só contra os títulos dessa filial</label>
    <select id="sel-loja-extrato" style="height:38px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:13px;font-weight:700;margin-bottom:14px">
      <option value="">Selecione a loja...</option>
      <option value="1">Loja 1</option><option value="2">Loja 2</option><option value="3">Loja 3</option>
      <option value="4">Loja 4</option><option value="5">Loja 5</option><option value="6">Loja 6</option>
    </select>

    <div id="box-api" style="display:none;align-items:center;gap:10px;padding:12px;border:1px dashed var(--border-strong);border-radius:8px;margin-bottom:14px;flex-wrap:wrap">
      <span id="api-loja-label" style="font-weight:700"></span>
      <label style="margin:0;font-weight:400">de</label>
      <input type="date" id="data-ini-api" style="height:34px;padding:0 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:13px">
      <label style="margin:0;font-weight:400">até</label>
      <input type="date" id="data-fim-api" style="height:34px;padding:0 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:13px">
      <button class="btn btn-blue" id="btn-processar-api" onclick="processarViaApi()">Importar via API</button>
    </div>

    <label>Ou cole manualmente — extrato (formato Itaú: data;histórico;valor;)</label>
    <textarea id="txt-extrato" placeholder="01/09/2026;PIX RECEBIDO JOAO DA SILVA 123.456.789-00;520,00;&#10;01/09/2026;BOLETO RECEBIDO DISTRIBUIDORA XYZ 12.345.678/0001-90;1500,50;"></textarea>
    <div class="entrada-foot">
      <span class="entrada-hint">Prefira o formato <b>OFX</b>. Só as linhas com valor positivo (entradas) são consideradas — saídas são ignoradas.</span>
      <div style="display:flex;gap:8px">
        <input type="file" id="file-extrato" accept=".txt,.ofx" style="display:none" onchange="importarArquivo(this)">
        <button class="btn btn-slate" onclick="document.getElementById('file-extrato').click()">Importar Arquivo</button>
        <button class="btn btn-slate" onclick="document.getElementById('txt-extrato').value=''">Limpar</button>
        <button class="btn btn-blue" id="btn-processar" onclick="processar()">Processar Extrato</button>
      </div>
    </div>
  </div>

  <div id="resultado"></div>
</div>

<div class="backdrop" id="backdrop" onclick="fecharPopup()"></div>
<div class="popup" id="popup"></div>

<script>
let dados = null;
let filtroAtivo = '';
let itensAtuais = [];

const CAT_LABEL = { pix_recebido: 'PIX Recebido', deposito_boleto: 'Depósito/Boleto', cartao: 'Cartão', outro: 'Outro' };
const STATUS_LABEL = {
  conciliado: 'Conciliado', baixa_pendente: 'Baixa pendente no ERP', revisar: 'Revisar',
  nao_encontrado: 'Não encontrado', cartao: 'Cartão (mensal)', fora_escopo: 'Fora do escopo'
};
const STATUS_PILL = {
  conciliado: 'pill-ok', baixa_pendente: 'pill-revisar', revisar: 'pill-revisar',
  nao_encontrado: 'pill-neutro', cartao: 'pill-neutro', fora_escopo: 'pill-neutro'
};

function fmtMoeda(v) { return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtData(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }

function importarArquivo(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('txt-extrato').value = e.target.result; };
  reader.readAsText(file, 'iso-8859-1');
  input.value = '';
}

async function processar() {
  const texto = document.getElementById('txt-extrato').value;
  const loja = document.getElementById('sel-loja-extrato').value;
  const btn = document.getElementById('btn-processar');
  const cont = document.getElementById('resultado');
  if (!loja) { cont.innerHTML = '<div class="err">Selecione a loja desse extrato antes de processar.</div>'; return; }
  btn.disabled = true;
  cont.innerHTML = '<div class="spinner"></div>';
  try {
    const r = await fetch('/api/conciliador-entradas/processar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto, loja })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Erro ao processar');
    dados = j;
    filtroAtivo = '';
    render();
  } catch (e) {
    cont.innerHTML = `<div class="err">Erro: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

const LOJA_CONTA_API = {
  '1': { conta: 'cahu', nome: 'Cahu' },
  '2': { conta: 'muribeca', nome: 'Muribeca' },
  '3': { conta: 'ponte', nome: 'Ponte dos Carvalhos' },
  '4': { conta: 'atacarejo', nome: 'Atacarejo' },
  '5': { conta: 'portalarga', nome: 'Porta Larga' },
  '6': { conta: 'jardimjordao', nome: 'Jardim Jordão' },
};

document.getElementById('sel-loja-extrato').addEventListener('change', function () {
  const info = LOJA_CONTA_API[this.value];
  const box = document.getElementById('box-api');
  if (info) {
    box.style.display = 'flex';
    document.getElementById('api-loja-label').textContent = `Importar direto do Itaú (${info.nome}):`;
  } else {
    box.style.display = 'none';
  }
});

(function initDatasApi() {
  const hoje = new Date();
  const primeiroDoMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  document.getElementById('data-ini-api').value = primeiroDoMes.toISOString().slice(0, 10);
  document.getElementById('data-fim-api').value = hoje.toISOString().slice(0, 10);
})();

async function processarViaApi() {
  const loja = document.getElementById('sel-loja-extrato').value;
  const info = LOJA_CONTA_API[loja];
  const conta = info && info.conta;
  const inicio = document.getElementById('data-ini-api').value;
  const fim = document.getElementById('data-fim-api').value;
  const btn = document.getElementById('btn-processar-api');
  const cont = document.getElementById('resultado');
  if (!conta) { cont.innerHTML = '<div class="err">Essa loja não tem integração com o Itaú liberada ainda.</div>'; return; }
  if (!inicio || !fim) { cont.innerHTML = '<div class="err">Selecione o período (de/até) pra importar.</div>'; return; }
  btn.disabled = true;
  cont.innerHTML = '<div class="spinner"></div>';
  try {
    const r = await fetch('/api/conciliador-entradas/processar-api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, loja, inicio, fim })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Erro ao importar');
    dados = j;
    filtroAtivo = '';
    render();
  } catch (e) {
    cont.innerHTML = `<div class="err">Erro: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function filtrar(status) {
  filtroAtivo = filtroAtivo === status ? '' : status;
  render();
}

function render() {
  const cont = document.getElementById('resultado');
  if (!dados) { cont.innerHTML = ''; return; }

  const cartaoMesesTxt = dados.cartao.meses.map(m => `${String(m.mes).padStart(2,'0')}/${m.ano}`).join(', ');
  const cartaoHtml = `
    <div class="cartao-card">
      <h3>Cartão débito/crédito — conferência mensal (${cartaoMesesTxt})</h3>
      ${dados.cartao.semDadoErp
        ? '<div class="cartao-obs">Sem dado do ERP pra esse(s) mês(es) ainda (relatório de Formas de Pagamento não fechou o período).</div>'
        : `<div class="cartao-row">
            <div class="item"><div class="l">No banco</div><div class="v">${fmtMoeda(dados.cartao.totalBanco)}</div></div>
            <div class="item"><div class="l">No ERP (mês)</div><div class="v">${fmtMoeda(dados.cartao.totalErp)}</div></div>
            <div class="item"><div class="l">Diferença</div><div class="v" style="color:${Math.abs(dados.cartao.diferenca) < 0.01 ? 'var(--green)' : 'var(--amber)'}">${fmtMoeda(dados.cartao.diferenca)}</div></div>
          </div>
          <div class="cartao-obs">Comparação por mês inteiro, não linha a linha — o ERP não guarda o repasse diário de cartão nessa instalação.</div>`}
    </div>`;

  const kpis = [
    { k: '', l: 'Total de entradas', v: dados.total, valor: dados.totalValor },
    { k: 'conciliado', l: 'Conciliado', v: dados.resumo.conciliado },
    { k: 'baixa_pendente', l: 'Baixa pendente', v: dados.resumo.baixa_pendente },
    { k: 'revisar', l: 'Revisar', v: dados.resumo.revisar },
    { k: 'nao_encontrado', l: 'Não encontrado', v: dados.resumo.nao_encontrado },
    { k: 'fora_escopo', l: 'Fora do escopo', v: dados.resumo.fora_escopo }
  ];
  const kpiHtml = kpis.map(k => `
    <div class="kpi ${filtroAtivo === k.k ? 'on' : ''}" onclick="filtrar('${k.k}')">
      <div class="v">${k.v}</div>
      <div class="l">${k.l}</div>
    </div>`).join('');

  itensAtuais = filtroAtivo ? dados.itens.filter(it => it.status === filtroAtivo) : dados.itens.filter(it => it.status !== 'cartao');

  const linhas = itensAtuais.map((it, i) => `
    <tr onclick="abrirDetalhe(${i})">
      <td>${fmtData(it.data)}</td>
      <td><div class="fav">${it.favorecido || '(sem nome)'}</div><div class="hist">${it.historico}</div></td>
      <td class="cat">${CAT_LABEL[it.categoria] || it.categoria}</td>
      <td class="r val">${fmtMoeda(it.valor)}</td>
      <td><span class="pill ${STATUS_PILL[it.status]}">${STATUS_LABEL[it.status]}</span></td>
    </tr>`).join('');

  cont.innerHTML = `
    ${cartaoHtml}
    <div class="kpi-row">${kpiHtml}</div>
    <div class="table-wrap">
      <table class="t">
        <thead><tr><th>Data</th><th>Favorecido</th><th>Categoria</th><th class="r">Valor</th><th>Status</th></tr></thead>
        <tbody>${linhas || '<tr><td colspan="5" class="empty">Nenhum item nesse filtro.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function abrirDetalhe(i) {
  const it = itensAtuais[i];
  const popup = document.getElementById('popup');
  const backdrop = document.getElementById('backdrop');

  let matchHtml = '';
  if (it.match) {
    matchHtml = `
      <div class="popup-row"><span class="k">Fatura</span><span class="v">#${it.match.nFatura}</span></div>
      <div class="popup-row"><span class="k">Cliente</span><span class="v">${it.match.cliente}</span></div>
      <div class="popup-row"><span class="k">Vencimento</span><span class="v">${fmtData(it.match.dataVencto)}</span></div>
      <div class="popup-row"><span class="k">Valor do título</span><span class="v">${fmtMoeda(it.match.valor)}</span></div>
      <div class="popup-row"><span class="k">Baixado no ERP</span><span class="v">${it.match.baixado ? 'Sim, em ' + fmtData(it.match.dataPagto) : 'Não'}</span></div>`;
  } else if (it.candidatos && it.candidatos.length) {
    matchHtml = `<div class="cand-list">${it.candidatos.map(c => `
      <div class="cand-item2">
        <div class="nm">${c.cliente}</div>
        <div class="meta"><span>Venc. ${fmtData(c.dataVencto)}</span><span>${fmtMoeda(c.valor)}</span></div>
      </div>`).join('')}</div>`;
  } else {
    matchHtml = '<div class="popup-row"><span class="k">Nenhuma fatura candidata encontrada.</span></div>';
  }

  popup.innerHTML = `
    <button class="popup-close" onclick="fecharPopup()">
      <svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
    </button>
    <div class="popup-hd">
      <h2>${it.favorecido || '(sem nome)'}</h2>
      <div class="sub">${fmtData(it.data)} · ${fmtMoeda(it.valor)} · <span class="pill ${STATUS_PILL[it.status]}">${STATUS_LABEL[it.status]}</span></div>
    </div>
    <div class="popup-bd">
      <div class="popup-row"><span class="k">Histórico do banco</span></div>
      <div style="font-size:11px;color:var(--ink-2);margin-bottom:10px">${it.historico}</div>
      ${matchHtml}
    </div>`;
  popup.classList.add('on');
  backdrop.classList.add('on');
}

function fecharPopup() {
  document.getElementById('popup').classList.remove('on');
  document.getElementById('backdrop').classList.remove('on');
}
</script>
</body>
</html>
```

- [ ] **Step 2: Verificar manualmente no navegador**

Depois do deploy (Task 8), acessar `/conciliador-entradas.html` logado, selecionar uma loja com fatura conhecida (ver Task 4 Step 4 — loja 4 tem faturas reais entre 2022-2026), colar um extrato de teste com uma linha `PIX RECEBIDO`/`BOLETO RECEBIDO` de valor batendo com alguma fatura real daquela loja/período, clicar "Processar Extrato" e conferir que a tela renderiza sem erro no console do navegador.

- [ ] **Step 3: Commit**

```bash
git add public/conciliador-entradas.html
git commit -m "feat: adiciona tela da Conciliação de Entradas"
```

---

### Task 7: Item de menu (`public/nav.js`)

**Files:**
- Modify: `public/nav.js:51`

**Interfaces:**
- Nenhuma (só link estático).

- [ ] **Step 1: Adicionar o item logo abaixo de "Conciliação de Saídas"**

Trocar:
```js
    { id: 'financeiro', ic: 'bank', txt: 'Financeiro', sub: [
        { href: '/conciliador.html', ic: 'bank', txt: 'Conciliação de Saídas' },
        { href: '/conciliador-cd.html', ic: 'bank', txt: 'CD' }
      ]},
```
Por:
```js
    { id: 'financeiro', ic: 'bank', txt: 'Financeiro', sub: [
        { href: '/conciliador.html', ic: 'bank', txt: 'Conciliação de Saídas' },
        { href: '/conciliador-entradas.html', ic: 'bank', txt: 'Conciliação de Entradas' },
        { href: '/conciliador-cd.html', ic: 'bank', txt: 'CD' }
      ]},
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node -c public/nav.js`

Expected: sem output.

- [ ] **Step 3: Commit**

```bash
git add public/nav.js
git commit -m "feat: adiciona Conciliação de Entradas no menu Financeiro"
```

---

### Task 8: Deploy e verificação manual end-to-end

**Files:**
- Nenhum (deploy + verificação na tela).

- [ ] **Step 1: Push e deploy**

```bash
git push origin main
curl "https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026"
```

Esperar ~8-10s (pode dar 502 se checar cedo demais) e confirmar que o serviço voltou:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://hhk0a8gt2cn.sn.mynetname.net/
```

Expected: `200` (ou redirect pro login, `302`/`200` dependendo da rota — qualquer coisa diferente de erro de conexão confirma que o serviço subiu).

- [ ] **Step 2: Checklist de verificação manual na tela (login como admin)**

- [ ] Menu Financeiro mostra "Conciliação de Entradas" logo abaixo de "Conciliação de Saídas", leva pra `/conciliador-entradas.html`.
- [ ] Colar um extrato de teste com uma linha `BOLETO RECEBIDO`/`PIX RECEBIDO` que bate valor+data com uma fatura real de `cargaaux.fatura` já baixada (loja 4, período de 2026 — ver Task 4 Step 4 pra achar um valor real) → aparece como `Conciliado`.
- [ ] Mesma ideia com uma fatura em aberto (`EmAberto > 0`, sem baixa) → aparece como `Baixa pendente no ERP`.
- [ ] Linha com nome de operadora de cartão (ex: `REDE SA LIQUIDACAO;3000,00;`) → não aparece na tabela principal (fica escondida do filtro padrão, só conta no card "Cartão"), soma certo no card "Cartão — conferência mensal", e o total do ERP nesse card bate com o que `/api/formas-pagamento` mostra pra mesma loja/mês (conferir manualmente comparando os dois).
- [ ] Linha sem nenhuma fatura compatível (valor/nome inventado) → `Não encontrado`.
- [ ] Linha categorizada como `outro` (ex: `RESGATE APLIC AUT MAIS;800,00;`) → `Fora do escopo`.
- [ ] Botão "Importar via API" aparece só pras lojas com conta liberada (1 e 2, conforme `LOJA_CONTA_API` hoje) e traz entradas reais sem erro.
- [ ] Clicar numa linha abre o popup de detalhe com fatura/cliente/vencimento (ou lista de candidatos, se `Revisar`).

- [ ] **Step 3: Reportar ao Tiago**

Depois de confirmar o checklist, avisar que a feature está no ar e pedir pra ele testar com um extrato real da próxima vez que colar um do banco — a categorização de entradas (`OPERADORAS_CARTAO`, prefixos `PIX RECEBIDO`/`BOLETO RECEBIDO`) é best-effort (Task 1) e pode precisar de ajuste assim que aparecer um histórico real que não bate com os padrões previstos.
