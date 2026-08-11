# Centro Distribuição Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nova aba "Centro Distribuição" em Gestão de Compras que compara o estoque do CD (loja 10)
com o giro de 30 dias das lojas 1-6 e sugere quanto cada loja deve pedir do CD, alertando quando o
próprio CD precisa comprar do fornecedor.

**Architecture:** Uma rota nova em `server.js` (`GET /api/compras/centro-distribuicao`) que
reaproveita o padrão de consulta já usado em `/api/ruptura` e `/api/compras/analise-estoque`
(universo de produtos = `central.c_cotacao_lista_itens`, estoque por loja em `central.estoquenN`,
vendas por loja/mês em `ln{loja}{mes}.zcupomitens`) — só que cruzando `estoquen10` (CD) contra a
demanda somada das 6 lojas em vez de comparar cada loja contra si mesma. Uma página nova
(`public/centro-distribuicao.html`) segue exatamente o layout/CSS de `public/ruptura.html`
(mesmo design system Executive Ink), com um botão "Analisar Agora" (consulta pesada, sem
auto-carregar), tabela principal e linha expansível por produto mostrando a quebra por loja.
`nav.js` ganha uma quarta entrada dentro do grupo "Gestão de Compras".

**Tech Stack:** Node.js + Express 5, MySQL (via `mysql2/promise`), HTML/CSS/JS vanilla sem
bundler — mesmo stack de todo o resto do projeto.

## Global Constraints

- Host MySQL vem de `dbConfig` (linha ~274 de `server.js`) — **NUNCA** escrever no banco, só
  `SELECT` (ver [[feedback_mysql-readonly]]).
- Loja 10 = CD ("CAHU DISTRIBUIDORA DE ALIMENTOS LTDA"), lojas 1-6 = varejo
  (CAHU, MURIBECA, PONTE, ATACAREJO, PORTA LARGA, JARDIM JORDÃO — mesmo mapa `LOJAS_NOMES` já
  usado em `/api/ruptura`).
- Universo de produtos = os mesmos de `central.c_cotacao_lista_itens` (produtos que já passaram
  por alguma lista de cotação/compra) — é o padrão já estabelecido em `/api/ruptura` para "todos os
  produtos sem filtro de comprador". Não escanear `central.itens` inteiro.
- A nova rota e a nova página **não** entram na lista `publico` do middleware de autenticação
  (linha ~150 de `server.js`) — devem exigir login, igual `ruptura.html`.
- **Este projeto não tem suíte de testes automatizados** (sem Jest/Mocha, sem pasta `test/`) — a
  verificação de cada task é manual: rodar o servidor local, checar a resposta via `curl`/script, e
  no fim conferir a página no navegador. Isso é o padrão já usado no resto do projeto (não é uma
  lacuna a corrigir aqui).
- Ao terminar, seguir o fluxo de deploy documentado: `git push` pro remote `prod` + bater no
  endpoint `/deploy?token=...` (ver [[project_economico-relatorios-arquitetura]]) — só fazer isso
  se o Tiago pedir explicitamente para publicar.

---

### Task 1: Instalar dependências e confirmar que o servidor sobe local

**Files:**
- Nenhum arquivo novo — só `npm install` usando o `package-lock.json` já existente.

**Interfaces:**
- Produces: servidor rodando em `http://localhost:3003` para as próximas tasks testarem contra
  ele.

- [ ] **Step 1: Instalar dependências**

```bash
cd "C:\Users\tiago\OneDrive\Documentos\economico-relatorios-app"
npm install
```

Expected: termina sem erro (pode demorar — `sharp`/`firebase-admin` são pacotes grandes).

- [ ] **Step 2: Subir o servidor local**

```bash
node server.js
```

Expected (no terminal): linha `✓ Dashboard rodando em http://localhost:3003` (ver `server.js:4479`).
Deixe rodando em background para as próximas tasks. O `DB_HOST` não definido cai no padrão
`192.168.2.252` (produção, leitura), então os dados batem com o real.

- [ ] **Step 3: Confirmar que a home exige login**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3003/api/ruptura
```

Expected: `401` (prova que o middleware de autenticação está de pé e que `/api/ruptura`, rota
irmã da que vamos criar, está protegida — nossa rota nova deve se comportar igual).

Não precisa commit nesta task (nenhum arquivo alterado).

---

### Task 2: Endpoint `GET /api/compras/centro-distribuicao`

**Files:**
- Modify: `server.js` — inserir logo após o fim da rota `/api/compras/analise-estoque`
  (`server.js:3357`, a linha com `});` que fecha essa rota) e antes do comentário
  `app.get('/deploy', ...)` (`server.js:3359`).

**Interfaces:**
- Consumes: `q(sql, params)` (helper já existente, `server.js:288`) para rodar SELECTs;
  `withCache(ttlMin)` (`server.js:112`) como middleware de cache; `localDate(d)` (`server.js:323`)
  e `mesDB(mes)` (`server.js:307`) para montar datas/nomes de banco por mês.
- Produces: `GET /api/compras/centro-distribuicao` retornando
  `{ produtos: [...], resumo: {...}, geradoEm: "..." }` — usado pela Task 3 (frontend).
  Formato de cada item de `produtos`:
  ```
  {
    codigo: string, descricao: string,
    estoqueCD: number, diasCoberturaCD: number, status: 'critico'|'alto'|'medio'|'ok',
    totalSugerido: number, faltaComprar: number,
    lojas: [
      { loja: number, nome: string, estoque: number, giroDiario: number,
        diasCobertura: number, sugestaoPedido: number },
      ... (uma entrada por loja 1-6)
    ]
  }
  ```
  `resumo`: `{ totalProdutos: number, precisamReposicao: number, criticos: number, totalUnidadesFaltando: number }`.

- [ ] **Step 1: Escrever a rota**

Inserir em `server.js`, logo antes de `app.get('/deploy', ...)`:

```js
// ═══════════════════════════════════════════════════
// MÓDULO COMPRAS — CENTRO DE DISTRIBUIÇÃO (loja 10)
// Estoque do CD x giro de 30 dias das lojas 1-6 —
// sugere quanto cada loja deve pedir do CD e alerta
// quando o próprio CD precisa comprar do fornecedor.
// ═══════════════════════════════════════════════════

const LOJAS_CD_NOMES = { 1: 'CAHU', 2: 'MURIBECA', 3: 'PONTE', 4: 'ATACAREJO', 5: 'PORTA LARGA', 6: 'JARDIM JORDÃO' };

app.get('/api/compras/centro-distribuicao', withCache(10), async (req, res) => {
  try {
    const vazio = {
      produtos: [],
      resumo: { totalProdutos: 0, precisamReposicao: 0, criticos: 0, totalUnidadesFaltando: 0 },
      geradoEm: new Date().toISOString()
    };

    // 1. Universo de produtos — mesmo critério de /api/ruptura sem filtro de comprador
    const prods = await q(`
      SELECT DISTINCT i.CodigoBarra, TRIM(i.Descricao) as descricao
      FROM central.c_cotacao_lista_itens cli
      JOIN central.itens i ON i.CodigoBarra = cli.Codigobarra AND i.CodDesativado = 0
    `, []).catch(() => []);
    if (!prods.length) return res.json(vazio);

    const codigos = prods.map(p => p.CodigoBarra);
    const descMap = Object.fromEntries(prods.map(p => [p.CodigoBarra, p.descricao || p.CodigoBarra]));
    const phC = codigos.map(() => '?').join(',');

    // 2. Estoque — lojas 1-6 e CD (loja 10), em paralelo
    const LOJAS = [1, 2, 3, 4, 5, 6];
    const estoqueQs = [...LOJAS, 10].map(n =>
      q(`SELECT CodigoBarra, Qtd FROM central.estoquen${n} WHERE CodigoBarra IN (${phC})`, codigos).catch(() => [])
    );
    const estoqueArr = await Promise.all(estoqueQs);
    const estoqueMap = {}; // estoqueMap[cod][loja] = qtd (loja 10 = CD)
    estoqueArr.forEach((rows, idx) => {
      const ln = idx < 6 ? LOJAS[idx] : 10;
      for (const r of rows) {
        if (!estoqueMap[r.CodigoBarra]) estoqueMap[r.CodigoBarra] = {};
        estoqueMap[r.CodigoBarra][ln] = parseFloat(r.Qtd) || 0;
      }
    });

    // 3. Vendas dos últimos 30 dias por loja (1-6) — janela de 2 meses pra cobrir virada de mês
    const hojeD = new Date();
    const ini30 = localDate(new Date(hojeD - 30 * 86400000));
    const meses = [0, 1].map(i => mesDB(new Date(hojeD.getFullYear(), hojeD.getMonth() - i, 1).getMonth() + 1));

    const vendasMap = {}; // vendasMap[loja][cod] = qtd30
    for (const ln of LOJAS) vendasMap[ln] = {};
    await Promise.all(LOJAS.map(async (ln) => {
      for (const mm of meses) {
        try {
          const rows = await q(`
            SELECT Codigo, SUM(QtdNovo) as qtd30
            FROM \`ln${ln}${mm}\`.zcupomitens
            WHERE IndCancel='N' AND Data >= ? AND Codigo IN (${phC})
            GROUP BY Codigo
          `, [ini30, ...codigos]);
          for (const r of rows) {
            vendasMap[ln][r.Codigo] = (vendasMap[ln][r.Codigo] || 0) + (parseFloat(r.qtd30) || 0);
          }
        } catch (_) {}
      }
    }));

    // 4. Montar um registro por produto
    const produtos = [];
    for (const cod of codigos) {
      const estoqueCD = estoqueMap[cod]?.[10] || 0;
      let totalSugerido = 0;
      let giroDiarioTotalCD = 0;
      let algumaAtividade = estoqueCD > 0;
      const lojasOut = [];

      for (const ln of LOJAS) {
        const estoqueLoja = estoqueMap[cod]?.[ln] || 0;
        const qtd30 = vendasMap[ln][cod] || 0;
        if (qtd30 > 0) algumaAtividade = true;
        const giroDiario = qtd30 / 30;
        const diasCobertura = giroDiario > 0.001
          ? estoqueLoja / giroDiario
          : (estoqueLoja > 0 ? 9999 : 0);
        const sugestaoPedido = (giroDiario > 0.001 && diasCobertura < 30)
          ? Math.max(0, Math.round(giroDiario * 30 - estoqueLoja))
          : 0;

        totalSugerido += sugestaoPedido;
        giroDiarioTotalCD += giroDiario;
        lojasOut.push({
          loja: ln, nome: LOJAS_CD_NOMES[ln],
          estoque: +estoqueLoja.toFixed(2),
          giroDiario: +giroDiario.toFixed(2),
          diasCobertura: diasCobertura === 9999 ? 9999 : +diasCobertura.toFixed(1),
          sugestaoPedido
        });
      }

      if (!algumaAtividade) continue; // sem estoque no CD e sem venda nas 6 lojas — fora do universo ativo

      const diasCoberturaCD = giroDiarioTotalCD > 0.001
        ? estoqueCD / giroDiarioTotalCD
        : (estoqueCD > 0 ? 9999 : 0);
      const status = diasCoberturaCD < 10 ? 'critico'
        : diasCoberturaCD < 20 ? 'alto'
        : diasCoberturaCD < 30 ? 'medio' : 'ok';
      const faltaComprar = Math.max(0, totalSugerido - estoqueCD);

      produtos.push({
        codigo: cod, descricao: descMap[cod] || cod,
        estoqueCD: +estoqueCD.toFixed(2),
        diasCoberturaCD: diasCoberturaCD === 9999 ? 9999 : +diasCoberturaCD.toFixed(1),
        status, totalSugerido, faltaComprar,
        lojas: lojasOut
      });
    }

    produtos.sort((a, b) => a.diasCoberturaCD - b.diasCoberturaCD);

    const resumo = {
      totalProdutos: produtos.length,
      precisamReposicao: produtos.filter(p => p.totalSugerido > 0).length,
      criticos: produtos.filter(p => p.status === 'critico').length,
      totalUnidadesFaltando: produtos.reduce((s, p) => s + p.faltaComprar, 0)
    };

    res.json({ produtos, resumo, geradoEm: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Reiniciar o servidor local e confirmar que a rota exige login**

```bash
# Ctrl+C no terminal do servidor (Task 1), depois:
node server.js
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3003/api/compras/centro-distribuicao
```

Expected: `401` (mesmo comportamento de `/api/ruptura` — prova que a rota está registrada e
protegida pelo middleware, sem precisar de sessão pra esse check).

- [ ] **Step 3: Verificar a query e o cálculo direto no MySQL (sem precisar de sessão HTTP)**

Crie um script temporário `_check_cd.js` na raiz do projeto (mesma pasta do `server.js`, pra
reaproveitar o `node_modules` já instalado na Task 1):

```js
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host:'192.168.2.252', port:3306, user:'root', password:'1900', connectTimeout:15000 });
  try {
    const [prods] = await conn.query(`
      SELECT DISTINCT i.CodigoBarra, TRIM(i.Descricao) as descricao
      FROM central.c_cotacao_lista_itens cli
      JOIN central.itens i ON i.CodigoBarra = cli.Codigobarra AND i.CodDesativado = 0
      LIMIT 5
    `);
    console.log('Amostra de produtos:', prods);
    if (prods.length) {
      const cod = prods[0].CodigoBarra;
      const [estCD] = await conn.query('SELECT Qtd FROM central.estoquen10 WHERE CodigoBarra = ?', [cod]);
      console.log(`Estoque CD do produto ${cod}:`, estCD);
    }
  } finally { await conn.end(); }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
```

Rode:

```bash
node _check_cd.js
```

Expected: imprime uma amostra de 5 produtos (com `CodigoBarra` e `descricao` preenchidos) e o
estoque do CD para o primeiro. Se `estoquen10` não existir ou vier vazio pra vários produtos
seguidos, pare e confirme com o Tiago antes de continuar (o design assume que `estoquen10` segue
o mesmo padrão de `estoquen1..6` — ver pergunta respondida no spec).

Depois de confirmar, apague o script:

```bash
rm _check_cd.js
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: endpoint /api/compras/centro-distribuicao (estoque CD x giro das 6 lojas)"
```

---

### Task 3: Página `public/centro-distribuicao.html`

**Files:**
- Create: `public/centro-distribuicao.html`

**Interfaces:**
- Consumes: `GET /api/compras/centro-distribuicao` (Task 2) — mesmo shape de resposta descrito
  ali. `/design-system.css` e `/nav.js` (injeta sidebar automaticamente, igual toda outra página).
- Produces: página acessível em `/centro-distribuicao.html` (consumida pelo link adicionado em
  `nav.js` na Task 4).

- [ ] **Step 1: Criar o arquivo**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/design-system.css">
<script src="/nav.js" defer></script>
<title>Centro Distribuição — Econômico Relatórios</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#EBEBE9;--card:#FFFFFF;--border:#DADAD6;
  --brand:#F5B800;--red:#C22F49;--green:#137A48;--orange:#B45C00;
  --blue:#2C4A6B;--purple:#0E1626;--text:#0E1626;--text2:#4E5A72;--text3:#4E5A72;
}
html,body{height:100%;font-family:'InterVar','Segoe UI',sans-serif;background:var(--bg);color:var(--text)}
.main{margin-left:0;padding:24px;min-height:100vh}
.page-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px}
.page-hdr h1{font-size:20px;font-weight:800;color:#0E1626}
.page-hdr p{font-size:12px;color:var(--text3);margin-top:2px}
.btn{border:none;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .2s}
.btn-brand{background:var(--brand);color:#6B4E00}.btn-brand:hover{background:#E5AC00}
.btn:disabled{opacity:.5;cursor:not-allowed}

.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.kpi-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.kpi-card .val{font-size:22px;font-weight:800;line-height:1}
.kpi-card .lbl{font-size:11px;color:var(--text3);margin-top:5px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.kpi-card.danger{border-color:#C22F4940}.kpi-card.danger .val{color:var(--red)}
.kpi-card.warning{border-color:#B45C0040}.kpi-card.warning .val{color:var(--orange)}
.kpi-card.brand{border-color:#F5B80040}.kpi-card.brand .val{color:#6B4E00}

.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.filtro{padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--text2)}
.filtro.active{background:var(--brand);color:#6B4E00;border-color:var(--brand)}
#busca{background:#FFFFFF;border:1px solid #98A0B3;border-radius:6px;color:#0E1626;padding:6px 10px;font-size:12px;min-width:220px}

.sec{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.tbl-wrap{overflow-x:auto}
table.t{width:100%;border-collapse:collapse;font-size:12px}
table.t thead{background:#EBEBE9}
table.t th{padding:9px 12px;text-align:left;color:var(--text3);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;border-bottom:1px solid var(--border)}
table.t td{padding:8px 12px;border-bottom:1px solid #DADAD666;vertical-align:middle}
table.t th.r,table.t td.r{text-align:right}
table.t tr.prod-row{cursor:pointer}
table.t tr.prod-row:hover{background:#00000006}
table.t tr.sub-row{display:none;background:#F7F8FA}
table.t tr.sub-row.open{display:table-row}
.risk{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700}
.risk-critico{background:#C22F4922;color:var(--red)}
.risk-alto{background:#B45C0022;color:var(--orange)}
.risk-medio{background:#F5B80022;color:#6B4E00}
.risk-ok{background:#137A4822;color:var(--green)}
.sub-tbl{width:100%;border-collapse:collapse;font-size:11px;margin:6px 0}
.sub-tbl th{padding:5px 10px;text-align:left;color:var(--text3);font-weight:700;font-size:9px;text-transform:uppercase}
.sub-tbl td{padding:5px 10px;border-top:1px solid #DADAD6}
.sub-tbl td.r,.sub-tbl th.r{text-align:right}
.sub-tbl tr.precisa td{color:var(--red);font-weight:700}

.loading{display:flex;align-items:center;justify-content:center;padding:48px;gap:12px;color:var(--text3);font-size:14px}
.spin{width:20px;height:20px;border:2px solid #DADAD6;border-top-color:var(--brand);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{padding:32px;text-align:center;color:var(--text3);font-size:13px}
.stamp{font-size:11px;color:var(--text3);display:flex;align-items:center;gap:6px}
.dot-live{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

@media(max-width:768px){.kpi-grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body class="ds">

<main class="main">
  <div class="page-hdr">
    <div>
      <h1>🚚 Centro Distribuição</h1>
      <p>Estoque do CD (Loja 10) x giro de 30 dias das lojas 1-6 · sugestão de pedido automático por loja</p>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="stamp" id="stamp"><span class="dot-live"></span> Aguardando análise</span>
      <button class="btn btn-brand" onclick="carregar()" id="btn-analisar">⚡ Analisar Agora</button>
    </div>
  </div>

  <div id="conteudo"><div class="loading"><span class="spin"></span> Clique em "Analisar Agora" para iniciar a análise...</div></div>
</main>

<script>
const fmtN = v => Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:0});
const fmtD = v => v >= 9999 ? '—' : Number(v||0).toFixed(1) + 'd';

let _dados = null;
let _filtro = 'todos';

function statusBadge(s) {
  const map = { critico:['risk-critico','🔴 CRÍTICO'], alto:['risk-alto','🟠 ALTO'], medio:['risk-medio','🟡 MÉDIO'], ok:['risk-ok','🟢 OK'] };
  const [cls, lbl] = map[s] || ['risk-ok', s];
  return `<span class="risk ${cls}">${lbl}</span>`;
}

function renderTabela() {
  const busca = (document.getElementById('busca')?.value || '').toLowerCase().trim();
  let lista = _dados.produtos;
  if (_filtro !== 'todos') lista = lista.filter(p => p.status === _filtro);
  if (busca) lista = lista.filter(p => p.descricao.toLowerCase().includes(busca) || String(p.codigo).includes(busca));

  if (!lista.length) {
    document.getElementById('tbl-wrap').innerHTML = '<div class="empty">Nenhum produto encontrado para esse filtro.</div>';
    return;
  }

  const linhas = lista.map((p, i) => `
    <tr class="prod-row" onclick="toggleLinha(${i})">
      <td class="bold">${p.descricao}</td>
      <td class="r">${fmtN(p.estoqueCD)}</td>
      <td class="r">${fmtD(p.diasCoberturaCD)}</td>
      <td>${statusBadge(p.status)}</td>
      <td class="r">${p.totalSugerido > 0 ? fmtN(p.totalSugerido) : '—'}</td>
      <td class="r" style="color:${p.faltaComprar>0?'var(--red)':'inherit'};font-weight:${p.faltaComprar>0?'700':'400'}">${p.faltaComprar > 0 ? fmtN(p.faltaComprar) : '—'}</td>
    </tr>
    <tr class="sub-row" id="sub-${i}">
      <td colspan="6">
        <table class="sub-tbl">
          <thead><tr><th>Loja</th><th class="r">Estoque</th><th class="r">Giro/dia</th><th class="r">Cobertura</th><th class="r">Sugestão de pedido</th></tr></thead>
          <tbody>
            ${p.lojas.map(l => `
              <tr class="${l.sugestaoPedido > 0 ? 'precisa' : ''}">
                <td>${l.nome}</td>
                <td class="r">${fmtN(l.estoque)}</td>
                <td class="r">${(l.giroDiario||0).toFixed(2)}</td>
                <td class="r">${fmtD(l.diasCobertura)}</td>
                <td class="r">${l.sugestaoPedido > 0 ? fmtN(l.sugestaoPedido) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </td>
    </tr>`).join('');

  document.getElementById('tbl-wrap').innerHTML = `
    <table class="t">
      <thead><tr>
        <th>Produto</th><th class="r">Estoque CD</th><th class="r">Cobertura CD</th>
        <th>Status</th><th class="r">Total sugerido (6 lojas)</th><th class="r">Falta comprar (CD)</th>
      </tr></thead>
      <tbody>${linhas}</tbody>
    </table>`;
}

function toggleLinha(i) {
  document.getElementById('sub-'+i).classList.toggle('open');
}

function setFiltro(btn, f) {
  document.querySelectorAll('.filtro').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _filtro = f;
  renderTabela();
}

function renderTudo(d) {
  _dados = d;
  const r = d.resumo;
  const kpis = `
  <div class="kpi-grid">
    <div class="kpi-card brand"><div class="val">${fmtN(r.totalProdutos)}</div><div class="lbl">Produtos Analisados</div></div>
    <div class="kpi-card warning"><div class="val">${fmtN(r.precisamReposicao)}</div><div class="lbl">Precisam Reposição</div></div>
    <div class="kpi-card danger"><div class="val">${fmtN(r.criticos)}</div><div class="lbl">Em Estado Crítico</div></div>
    <div class="kpi-card danger"><div class="val">${fmtN(r.totalUnidadesFaltando)}</div><div class="lbl">Unidades Faltando no CD</div></div>
  </div>`;

  const toolbar = `
  <div class="toolbar">
    <div class="filtro active" onclick="setFiltro(this,'todos')">Todos</div>
    <div class="filtro" onclick="setFiltro(this,'critico')">🔴 Crítico</div>
    <div class="filtro" onclick="setFiltro(this,'alto')">🟠 Alto</div>
    <div class="filtro" onclick="setFiltro(this,'medio')">🟡 Médio</div>
    <div class="filtro" onclick="setFiltro(this,'ok')">🟢 OK</div>
    <input id="busca" type="text" placeholder="🔍 Buscar produto..." oninput="renderTabela()">
  </div>`;

  document.getElementById('conteudo').innerHTML = kpis + toolbar + `<div class="sec"><div class="tbl-wrap" id="tbl-wrap"></div></div>`;
  _filtro = 'todos';
  renderTabela();

  document.getElementById('stamp').innerHTML =
    `<span class="dot-live"></span> Atualizado em ${new Date().toLocaleTimeString('pt-BR')}`;
}

function carregar() {
  const btn = document.getElementById('btn-analisar');
  btn.disabled = true;
  btn.textContent = '⏳ Analisando...';
  document.getElementById('stamp').innerHTML = '<span class="spin"></span> Buscando dados...';
  document.getElementById('conteudo').innerHTML = '<div class="loading"><span class="spin"></span> Cruzando estoque do CD com o giro das 6 lojas...<br><small style="color:#4E5A72;margin-top:8px;display:block">Primeira análise pode levar 1-2 minutos. Próximas serão instantâneas (cache 10min).</small></div>';

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 300000);

  fetch('/api/compras/centro-distribuicao', { signal: ctrl.signal })
    .then(r => { clearTimeout(tid); if (r.status === 401) { location.href='/login.html'; return null; } return r.json(); })
    .then(d => {
      if (!d) return;
      if (d.error) throw new Error(d.error);
      renderTudo(d);
    })
    .catch(e => {
      clearTimeout(tid);
      const msg = e.name === 'AbortError' ? 'Tempo limite excedido (5min). Tente novamente.' : e.message;
      document.getElementById('conteudo').innerHTML = `<div class="empty">❌ Erro ao carregar: ${msg}</div>`;
      document.getElementById('stamp').innerHTML = '<span style="color:var(--red)">● Erro</span>';
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = '⚡ Analisar Agora';
    });
}
</script>
</body>
</html>
```

- [ ] **Step 2: Verificar carregamento manual no navegador**

Com o servidor da Task 1/2 rodando (`node server.js`), abra `http://localhost:3003/login.html` no
navegador, faça login com um usuário válido, depois navegue para
`http://localhost:3003/centro-distribuicao.html` diretamente na URL (ainda não tem link no menu —
isso é a Task 4).

Expected:
- Página carrega com o cabeçalho "🚚 Centro Distribuição" e o botão "⚡ Analisar Agora".
- Clicar no botão mostra o spinner e, depois de alguns segundos, preenche os 4 cards de resumo e a
  tabela.
- Clicar em uma linha de produto expande a quebra por loja abaixo dela.
- Os filtros (Todos/Crítico/Alto/Médio/OK) e a busca funcionam.

- [ ] **Step 3: Commit**

```bash
git add public/centro-distribuicao.html
git commit -m "feat: pagina centro-distribuicao.html (Gestao de Compras)"
```

---

### Task 4: Link no menu (`nav.js`)

**Files:**
- Modify: `public/nav.js:54-58` — grupo `compras` dentro do array `ITENS`.

**Interfaces:**
- Consumes: nenhuma nova — só adiciona uma entrada ao array `sub` já existente.
- Produces: link "Centro Distribuição" visível em Gestão de Compras em toda página que carrega
  `nav.js` (ou seja, praticamente todas as páginas do sistema, já que o script é compartilhado).

- [ ] **Step 1: Adicionar a entrada no grupo "Gestão de Compras"**

Em `public/nav.js`, o bloco atual (linhas 54-58) é:

```js
    { id: 'compras', ic: 'bag', txt: 'Gestão de Compras', sub: [
        { href: '/fornecedores.html',    ic: 'bag',   txt: 'Lista de Compra' },
        { href: '/ruptura.html',         ic: 'trend', txt: 'Gestão de Rupturas' },
        { href: '/ponta-gondola.html',   ic: 'store', txt: 'Ponta de Gôndola' }
      ]},
```

Trocar por:

```js
    { id: 'compras', ic: 'bag', txt: 'Gestão de Compras', sub: [
        { href: '/fornecedores.html',        ic: 'bag',   txt: 'Lista de Compra' },
        { href: '/ruptura.html',             ic: 'trend', txt: 'Gestão de Rupturas' },
        { href: '/ponta-gondola.html',       ic: 'store', txt: 'Ponta de Gôndola' },
        { href: '/centro-distribuicao.html', ic: 'cart',  txt: 'Centro Distribuição' }
      ]},
```

(`cart` é um ícone que já existe em `public/icons.svg` — não precisa criar ícone novo.)

- [ ] **Step 2: Verificar no navegador**

Com o servidor local ainda rodando, recarregue qualquer página logada (ex:
`http://localhost:3003/ruptura.html`). Expected: o menu lateral "Gestão de Compras" agora mostra 4
itens, com "Centro Distribuição" por último; clicar nele navega para
`/centro-distribuicao.html` e o item fica destacado (classe `on`) no menu.

- [ ] **Step 3: Commit**

```bash
git add public/nav.js
git commit -m "feat: adiciona Centro Distribuicao ao menu Gestao de Compras"
```

---

### Task 5: Verificação final ponta a ponta

**Files:** nenhum (só verificação manual — não altera código).

- [ ] **Step 1: Fluxo completo no navegador**

Com o servidor local rodando e logado:
1. Abra `/ruptura.html`, confirme que "Centro Distribuição" aparece no menu e navegue até lá.
2. Clique em "Analisar Agora" e espere carregar.
3. Escolha um produto que apareça como 🔴 CRÍTICO ou 🟠 ALTO, expanda a linha e confira que pelo
   menos uma loja tem `sugestaoPedido > 0` — e que a soma dessas sugestões bate com a coluna
   "Total sugerido (6 lojas)" da linha do produto.
4. Confira que quando "Total sugerido" é maior que "Estoque CD", a coluna "Falta comprar (CD)"
   mostra a diferença em vermelho; quando é menor ou igual, mostra "—".

- [ ] **Step 2: Parar o servidor local**

```bash
# Ctrl+C no terminal onde `node server.js` está rodando
```

Não commitar nada nesta task — é só validação do que já foi commitado nas Tasks 2-4.
