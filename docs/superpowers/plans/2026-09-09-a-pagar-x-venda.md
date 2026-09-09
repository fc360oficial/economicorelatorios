# A Pagar x Venda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma nova aba "A Pagar x Venda" em `comparativos.html` que compara Contas a
Pagar do ERP (por loja, mês inteiro) contra Venda Total (parcial até hoje quando o mês é o
corrente), com uma barra horizontal por loja mostrando só a porcentagem, colorida em faixas
verde/amarelo/vermelho.

**Architecture:** Backend: novo endpoint `GET /api/pagar-venda` em `server.js`, reaproveitando
(via uma função extraída) a mesma lógica de cálculo de venda por loja que `/api/compra-venda` já
usa, e somando `loja20045.contasapagar.Valor` por `Filial`. Frontend: nova aba no padrão já
existente da página (`tab-btn` + painel + entradas nos mapas `_carregado`/`_filtros`/`_carregar`),
com uma barra horizontal por loja construída com uma escala de cor fixa (gradiente CSS) coberta
por uma máscara que recua conforme a porcentagem.

**Tech Stack:** Node.js/Express (`mysql2/promise`), HTML/CSS/JS vanilla (sem framework, sem
bundler) — igual ao resto do `economico-relatorios-app`.

## Global Constraints

- Repositório é `C:\Users\tiago\OneDrive\Documentos\economico-relatorios-app`, remote único
  `origin` (`economicorelatorios.git`) — "subir" é sempre `git push origin main`.
- Deploy é manual via `GET https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026`
  (faz `git fetch && git reset --hard origin/main` no `.254` e reinicia o processo). **Só rodar
  uma vez, no final (Task 4)**, depois que os três primeiros tasks estiverem commitados — cada
  deploy derruba o app em uso.
- MySQL do ERP (`192.168.2.252`) é **somente leitura** para qualquer script de verificação —
  nunca rodar `UPDATE`/`INSERT`/`DELETE`. Acesso via SSH no `.254`
  (`ssh -i ~/.ssh/claude_254 claude-ssh@100.102.231.28`, é `cmd.exe`, não bash).
- Não existe framework de teste no repo (sem Jest/Mocha, sem `package.json` `scripts`). A
  verificação usada no repo pra JS embutido em HTML é extrair o `<script>` pra um `.js` temporário
  e rodar `node --check` nele (mesma técnica de `scripts/sync-buyer-schedules.js:311-324`) — usar
  essa técnica nos passos de verificação abaixo, não inventar um framework novo.
- Scripts de verificação com acesso a banco são descartáveis: criar em
  `C:\Users\tiago\AppData\Local\Temp\claude\...\scratchpad` local, copiar pro `.254` via `scp -i
  ~/.ssh/claude_254`, rodar via SSH, **apagar do `.254` com `del` depois** (nunca deixar sobrar
  lá — não são parte do repo).
- 6 lojas válidas: `[1,2,3,4,5,6]` (`LOJAS = ['','CAHU','MURIBECA','PONTE','ATACAREJO','PORTA
  LARGA','JARDIM JORDÃO']`, índice = número da loja). `Filial=10` em `contasapagar` é o CD, nunca
  entra nessa comparação.

---

### Task 1: Extrair função compartilhada de venda por loja e refatorar `/api/compra-venda`

**Files:**
- Modify: `server.js:1867-1957` (rota `/api/compra-venda`)
- Create: script descartável de verificação (fora do repo, no scratchpad)

**Interfaces:**
- Produz: `async function calcularVendaPorLoja(mesSel, mm, diaFiltroV, diaFiltroC)` → retorna
  `{ nfceMap, nfeVendaMap, vendaTotalMap }`, onde cada map é `{ [loja: number]: number }` (valor
  já em `float`, não arredondado). `vendaTotalMap[loja] = nfceMap[loja] + nfeVendaMap[loja]`,
  arredondado a 2 casas. Declarada no escopo do módulo (mesmo nível de `q()`), antes da rota
  `/api/compra-venda`, pra ser reaproveitada por `/api/pagar-venda` no Task 2.

- [ ] **Step 1: Capturar números de referência (baseline) antes de mexer no código**

Criar `C:\Users\tiago\AppData\Local\Temp\claude\...\scratchpad\baseline_venda_loja4.js` (usar o
caminho de scratchpad real da sessão) com o conteúdo exato abaixo — é uma cópia fiel da lógica
atual de `/api/compra-venda` pra loja 4, mês 9, ano 2026, sem cortar por dia (mês fechado, não é
o mês corrente, então `diaFiltroV`/`diaFiltroC` ficam vazios):

```javascript
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: '192.168.2.252', port: 3306, user: 'root', password: '1900', connectTimeout: 15000
  });

  const [nfceRows] = await conn.query(
    `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda
     FROM \`ln4mes08\`.zcupomitens
     WHERE YEAR(Data)=2026 AND IndCancel='N'`
  );
  const nfce = parseFloat(nfceRows[0]?.venda || 0);

  const [nfeRows] = await conn.query(
    `SELECT COALESCE(SUM(TotalNota),0) as total
     FROM central.compras
     WHERE MONTH(DataLan)=8 AND YEAR(DataLan)=2026
       AND nLoja=4 AND Movimentacao='VENDA' AND Tipo='NF'`
  );
  const nfe = parseFloat(nfeRows[0]?.total || 0);

  console.log('BASELINE loja=4 mes=8/2026 -> nfce:', nfce, 'nfe:', nfe, 'total:', +(nfce+nfe).toFixed(2));

  await conn.end();
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
```

(Usa mês 8/Agosto — mês fechado — em vez do mês corrente, pra ter um resultado estável que não
muda entre o "antes" e o "depois" por causa do corte de dia.)

Copiar e rodar:

```bash
scp -o ConnectTimeout=15 -i ~/.ssh/claude_254 "<caminho-scratchpad>/baseline_venda_loja4.js" claude-ssh@100.102.231.28:"C:/fc360/claude_code_/baseline_tmp.js"
ssh -o ConnectTimeout=20 -i ~/.ssh/claude_254 claude-ssh@100.102.231.28 "cd C:\\fc360\\claude_code_ && node baseline_tmp.js"
```

Expected: uma linha `BASELINE loja=4 mes=8/2026 -> nfce: <N1> nfe: <N2> total: <N1+N2>` com
números positivos (`ln4mes08.zcupomitens` e `central.compras` têm dado real de Agosto/2026).
Anotar os 3 números — são o baseline pro Step 4.

- [ ] **Step 2: Adicionar a função `calcularVendaPorLoja` em `server.js`, antes da rota `/api/compra-venda` (linha 1867)**

```javascript
// Venda total por loja (NFC-e + NF-e de saída) — compartilhado entre
// /api/compra-venda e /api/pagar-venda.
async function calcularVendaPorLoja(mesSel, mm, diaFiltroV, diaFiltroC) {
  const lojas = [1,2,3,4,5,6];

  const nfceMap = {};
  await Promise.all(lojas.map(async ln => {
    try {
      const [r] = await q(
        `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda
         FROM \`ln${ln}mes${mm}\`.zcupomitens
         WHERE YEAR(Data)=2026 AND IndCancel='N'${diaFiltroV}`);
      nfceMap[ln] = parseFloat(r?.venda || 0);
    } catch(_) { nfceMap[ln] = 0; }
  }));

  const nfeVendaRows = await q(
    `SELECT nLoja, COALESCE(SUM(TotalNota),0) as total
     FROM central.compras
     WHERE MONTH(DataLan)=? AND YEAR(DataLan)=2026
       AND nLoja IN (1,2,3,4,5,6)
       AND Movimentacao='VENDA' AND Tipo='NF'${diaFiltroC}
     GROUP BY nLoja`,
    [mesSel]
  );
  const nfeVendaMap = {};
  for (const r of nfeVendaRows) nfeVendaMap[r.nLoja] = parseFloat(r.total || 0);

  const vendaTotalMap = {};
  for (const ln of lojas) vendaTotalMap[ln] = +((nfceMap[ln] || 0) + (nfeVendaMap[ln] || 0)).toFixed(2);

  return { nfceMap, nfeVendaMap, vendaTotalMap };
}
```

- [ ] **Step 3: Refatorar a rota `/api/compra-venda` pra usar a função extraída**

Substituir o corpo inteiro da rota (linhas 1867-1957) por:

```javascript
app.get('/api/compra-venda', withCache(30), async (req, res) => {
  try {
    const hoje   = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const diaHoje = hoje.getDate();
    const mesHoje = hoje.getMonth() + 1;
    const lojas  = [1,2,3,4,5,6];
    const mm     = String(mesSel).padStart(2,'0');
    const diaFiltroV = mesSel === mesHoje ? ` AND DAY(Data) <= ${diaHoje}` : '';
    const diaFiltroC = mesSel === mesHoje ? ` AND DAY(DataLan) <= ${diaHoje}` : '';
    const NOMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    const { nfceMap, nfeVendaMap } = await calcularVendaPorLoja(mesSel, mm, diaFiltroV, diaFiltroC);

    // Compra por loja: DataRecto (recebimento) + Tipo='PNF' + Status='F' = igual ao ERP "com NF"
    const compraRows = await q(
      `SELECT nLoja, COALESCE(SUM(TotalNota),0) as total
       FROM central.compras
       WHERE MONTH(DataRecto)=? AND YEAR(DataRecto)=2026
         AND nLoja IN (1,2,3,4,5,6)
         AND Movimentacao='COMPRA' AND Tipo='PNF' AND Status='F'${diaFiltroC.replace('DataLan','DataRecto')}
       GROUP BY nLoja`,
      [mesSel]
    );
    const compraMap = {};
    for (const r of compraRows) compraMap[r.nLoja] = parseFloat(r.total || 0);

    const por_loja = lojas.map(ln => {
      const nfce   = nfceMap[ln]    || 0;
      const nfe    = nfeVendaMap[ln] || 0;
      const compra = compraMap[ln]  || 0;
      const total  = nfce + nfe;
      return {
        loja: ln,
        venda_nfce:  +nfce.toFixed(2),
        venda_nfe:   +nfe.toFixed(2),
        venda_total: +total.toFixed(2),
        compra:      +compra.toFixed(2),
        cv: total > 0 ? +((compra / total) * 100).toFixed(2) : null,
      };
    });

    const tnfce   = por_loja.reduce((s,l)=>s+l.venda_nfce,0);
    const tnfe    = por_loja.reduce((s,l)=>s+l.venda_nfe,0);
    const ttotal  = por_loja.reduce((s,l)=>s+l.venda_total,0);
    const tcompra = por_loja.reduce((s,l)=>s+l.compra,0);

    res.json({
      por_loja,
      totais: {
        venda_nfce:  +tnfce.toFixed(2),
        venda_nfe:   +tnfe.toFixed(2),
        venda_total: +ttotal.toFixed(2),
        compra:      +tcompra.toFixed(2),
        cv: ttotal > 0 ? +((tcompra / ttotal) * 100).toFixed(2) : null,
      },
      mes: mesSel,
      nome_mes: NOMES[mesSel - 1],
      diaHoje, mesHoje,
      parcial: mesSel === mesHoje,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 4: Validar sintaxe e confirmar que os números batem com o baseline**

```bash
node --check server.js
```

Expected: nenhuma saída (sucesso silencioso).

Criar um segundo script descartável `verify_refactor_loja4.js` com o **mesmo** conteúdo do Step 1
(idêntico, é só pra confirmar que a extração não mudou a query nem o resultado — não precisa
copiar server.js inteiro, é uma verificação da lógica, não do arquivo). Rodar do mesmo jeito
(scp + ssh + node) e conferir que os 3 números impressos são **idênticos** aos anotados no Step 1.
Se baterem, a extração não alterou comportamento.

Apagar os dois scripts temporários do `.254`:

```bash
ssh -o ConnectTimeout=15 -i ~/.ssh/claude_254 claude-ssh@100.102.231.28 "cd C:\\fc360\\claude_code_ && del baseline_tmp.js"
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Extrai calcularVendaPorLoja de /api/compra-venda pra reuso

Prepara o terreno pra /api/pagar-venda reaproveitar a mesma lógica de
venda por loja (NFC-e + NF-e de saída), sem mudar comportamento —
números conferidos contra baseline pré-refatoração (loja 4, ago/2026).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Novo endpoint `GET /api/pagar-venda`

**Files:**
- Modify: `server.js` — inserir nova rota entre o fim de `/api/compra-venda` e
  `const _mensalCache = {}, _mensalCacheTs = {};` (linha 1959 antes do Task 1; confirmar a linha
  exata depois do Task 1, deve estar perto de 1957-1959).

**Interfaces:**
- Consome: `calcularVendaPorLoja(mesSel, mm, diaFiltroV, diaFiltroC)` do Task 1.
- Produz: resposta JSON de `GET /api/pagar-venda?mes=N`:
  ```
  { por_loja: [{ loja, a_pagar, venda_total, pct }], totais: { a_pagar, venda_total, pct },
    mes, nome_mes, diaHoje, mesHoje, parcial }
  ```
  `pct = a_pagar / venda_total * 100` (1 casa), `null` se `venda_total` for 0. Consumida pelo
  frontend no Task 3.

- [ ] **Step 1: Confirmar o número de referência da consulta de Contas a Pagar**

Criar script descartável `verify_contasapagar.js`:

```javascript
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: '192.168.2.252', port: 3306, user: 'root', password: '1900', connectTimeout: 15000
  });

  const [rows] = await conn.query(
    `SELECT Filial, COALESCE(SUM(Valor),0) as total
     FROM loja20045.contasapagar
     WHERE MONTH(DataVencto)=9 AND YEAR(DataVencto)=2026
       AND Filial IN (1,2,3,4,5,6)
     GROUP BY Filial ORDER BY Filial`
  );
  console.log('A PAGAR set/2026 por Filial:', rows);

  await conn.end();
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
```

Copiar e rodar (mesmo padrão scp+ssh dos tasks anteriores). Expected: linha pra `Filial: 4` com
`total: '1731085.34'` (valor já confirmado numa investigação anterior desta mesma sessão — se não
bater exatamente, algo mudou nos dados ou na query, investigar antes de prosseguir).

- [ ] **Step 2: Adicionar a rota `/api/pagar-venda` em `server.js`**

Inserir logo depois do `});` que fecha `/api/compra-venda` (antes de `const _mensalCache`):

```javascript
app.get('/api/pagar-venda', withCache(30), async (req, res) => {
  try {
    const hoje   = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const diaHoje = hoje.getDate();
    const mesHoje = hoje.getMonth() + 1;
    const lojas  = [1,2,3,4,5,6];
    const mm     = String(mesSel).padStart(2,'0');
    const diaFiltroV = mesSel === mesHoje ? ` AND DAY(Data) <= ${diaHoje}` : '';
    const diaFiltroC = mesSel === mesHoje ? ` AND DAY(DataLan) <= ${diaHoje}` : '';
    const NOMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    const { vendaTotalMap } = await calcularVendaPorLoja(mesSel, mm, diaFiltroV, diaFiltroC);

    // Contas a pagar: vencimento no mês inteiro (sem corte de dia — os
    // títulos do mês já existem todos no ERP hoje, diferente da venda).
    const pagarRows = await q(
      `SELECT Filial, COALESCE(SUM(Valor),0) as total
       FROM loja20045.contasapagar
       WHERE MONTH(DataVencto)=? AND YEAR(DataVencto)=2026
         AND Filial IN (1,2,3,4,5,6)
       GROUP BY Filial`,
      [mesSel]
    );
    const pagarMap = {};
    for (const r of pagarRows) pagarMap[r.Filial] = parseFloat(r.total || 0);

    const por_loja = lojas.map(ln => {
      const a_pagar     = pagarMap[ln] || 0;
      const venda_total = vendaTotalMap[ln] || 0;
      return {
        loja: ln,
        a_pagar:     +a_pagar.toFixed(2),
        venda_total: +venda_total.toFixed(2),
        pct: venda_total > 0 ? +((a_pagar / venda_total) * 100).toFixed(1) : null,
      };
    });

    const tpagar = por_loja.reduce((s,l)=>s+l.a_pagar,0);
    const ttotal = por_loja.reduce((s,l)=>s+l.venda_total,0);

    res.json({
      por_loja,
      totais: {
        a_pagar:     +tpagar.toFixed(2),
        venda_total: +ttotal.toFixed(2),
        pct: ttotal > 0 ? +((tpagar / ttotal) * 100).toFixed(1) : null,
      },
      mes: mesSel,
      nome_mes: NOMES[mesSel - 1],
      diaHoje, mesHoje,
      parcial: mesSel === mesHoje,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 3: Validar sintaxe**

```bash
node --check server.js
```

Expected: nenhuma saída.

- [ ] **Step 4: Apagar o script temporário do `.254` e commitar**

```bash
ssh -o ConnectTimeout=15 -i ~/.ssh/claude_254 claude-ssh@100.102.231.28 "cd C:\\fc360\\claude_code_ && del verify_contasapagar_tmp.js"
git add server.js
git commit -m "$(cat <<'EOF'
Adiciona endpoint GET /api/pagar-venda

Soma Contas a Pagar (loja20045.contasapagar, por Filial, vencimento no
mês inteiro) e compara contra Venda Total por loja (reaproveitando
calcularVendaPorLoja). Número de A Pagar da loja 4/set-2026 conferido
direto no ERP antes de escrever a query (R$ 1.731.085,34).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Nova aba "A Pagar x Venda" no frontend

**Files:**
- Modify: `public/comparativos.html` (CSS ~linha 84-85, botão de aba ~linha 189, painel de aba
  ~linha 329, mapas de controle e listener de mês ~linhas 524-967 — linhas exatas devem ser
  reconfirmadas com `Grep` antes de editar, já que os tasks anteriores não tocam nesse arquivo
  mas o número de linha pode ter deslocado por outras edições concorrentes no repositório
  compartilhado — ver Global Constraints do projeto sobre isso).

**Interfaces:**
- Consome: `GET /api/pagar-venda?mes=N` do Task 2, formato de resposta documentado lá.

- [ ] **Step 1: Adicionar CSS da barra, depois do bloco `/* ABAS */` (depois de `.tab-btn.active{...}`, antes de `/* RESPONSIVE */`)**

```css
/* A PAGAR X VENDA */
.pv-row{display:flex;align-items:center;gap:12px;padding:8px 0}
.pv-row+.pv-row{border-top:1px solid #DADAD6}
.pv-loja{width:170px;flex-shrink:0;font-size:12px;font-weight:700;color:#0E1626}
.pv-loja span{color:#4E5A72;font-weight:400;font-size:10px;margin-left:4px}
.pv-track{position:relative;flex:1;height:22px;border-radius:6px;overflow:hidden;background:linear-gradient(to right,#137A48 0%,#137A48 50%,#F5B800 50%,#F5B800 70%,#C22F49 70%,#C22F49 100%)}
.pv-mask{position:absolute;top:0;right:0;height:100%;background:#EDEDE9;transition:width .3s}
.pv-pct{width:64px;flex-shrink:0;text-align:right;font-size:13px;font-weight:700;color:#0E1626}
```

- [ ] **Step 2: Adicionar o botão da aba, depois do botão "Compra x Venda"**

```html
      <button class="tab-btn"        id="tab-btn-cv"     onclick="setTab('cv')">Compra x Venda</button>
      <button class="tab-btn"        id="tab-btn-pagar"  onclick="setTab('pagar')">A Pagar x Venda</button>
```

- [ ] **Step 3: Adicionar o painel da aba, depois do painel `tab-cv` (antes do `</div>` que fecha `.card` das abas)**

```html
    <!-- Tab: A Pagar x Venda -->
    <div id="tab-pagar" style="display:none">
      <p id="pagar-subtitulo" style="font-size:11px;color:#4E5A72;margin-bottom:14px">
        A Pagar = Contas a Pagar com vencimento no mês (mês inteiro) &nbsp;·&nbsp; Venda = NFC-e (PDV) + NF-e saída &nbsp;·&nbsp; % = A Pagar ÷ Venda Total × 100
      </p>
      <div id="pv-body"><p class="loading">Selecione a aba para carregar</p></div>
    </div>
```

- [ ] **Step 4: Adicionar `carregarPagarVenda()`, depois de `carregarCV()` (depois do `}` que fecha `carregarCV`, antes de `const _carregar = {...}`)**

```javascript
function carregarPagarVenda() {
  const mes = document.getElementById('sel-mes').value;
  const body = document.getElementById('pv-body');
  body.innerHTML = '<p class="loading">Carregando...</p>';
  fetch(`/api/pagar-venda?mes=${mes}`)
    .then(r => { if (r.status === 401) { location.href='/login.html'; throw new Error('401'); } return r.json(); })
    .then(data => {
      if (data.error) throw new Error(data.error);
      _carregado.pagar = true;

      const t = data.totais;
      document.getElementById('k-tot26').textContent = t.pct !== null ? t.pct.toFixed(1) + '%' : '—';
      document.getElementById('k-sub26').textContent = 'A Pagar % rede ' + data.nome_mes;
      document.getElementById('k-tot25').textContent = '—';
      document.getElementById('k-sub25').textContent = '';
      document.getElementById('k-var').textContent = '';
      document.getElementById('k-var').className = 'kpi-v';
      document.getElementById('k-med26').textContent = '—';
      document.getElementById('k-med-label').textContent = 'A Pagar x Venda';

      const parcialLabel = data.parcial ? ` <span style="color:#4E5A72;font-size:10px">(venda até dia ${data.diaHoje})</span>` : '';
      document.getElementById('pagar-subtitulo').innerHTML =
        `A Pagar = Contas a Pagar com vencimento no mês (mês inteiro) &nbsp;·&nbsp; Venda = NFC-e (PDV) + NF-e saída${parcialLabel} &nbsp;·&nbsp; % = A Pagar ÷ Venda Total × 100`;

      const LOJAS = ['','CAHU','MURIBECA','PONTE','ATACAREJO','PORTA LARGA','JARDIM JORDÃO'];
      let html = '';
      for (const l of data.por_loja) {
        const pctTxt = l.pct !== null ? l.pct.toFixed(1) + '%' : '—';
        const maskPct = l.pct !== null ? 100 - Math.min(l.pct, 100) : 100;
        html += `
          <div class="pv-row">
            <div class="pv-loja">Loja ${l.loja}<span>${LOJAS[l.loja]||''}</span></div>
            <div class="pv-track"><div class="pv-mask" style="width:${maskPct}%"></div></div>
            <div class="pv-pct">${pctTxt}</div>
          </div>`;
      }
      body.innerHTML = html;
    })
    .catch(e => {
      if (e?.message === '401') return;
      body.innerHTML = `<p class="loading">Erro: ${e?.message || e}</p>`;
    });
}
```

- [ ] **Step 5: Registrar a aba nos mapas de controle**

Em `const _carregado = { diario: false, mensal: false, merc: false, lojas: false, margem: false, cv: false };`, adicionar `pagar: false`:

```javascript
const _carregado = { diario: false, mensal: false, merc: false, lojas: false, margem: false, cv: false, pagar: false };
```

Em `const _filtros = { diario:[1,1], mensal:[1,0], merc:[1,1], lojas:[0,1], margem:[1,1], cv:[0,1] };`, adicionar `pagar:[0,1]` (mesmo padrão de `cv`: sem filtro de loja, com filtro de mês):

```javascript
const _filtros = { diario:[1,1], mensal:[1,0], merc:[1,1], lojas:[0,1], margem:[1,1], cv:[0,1], pagar:[0,1] };
```

Em `const _kpiLabel = { ... cv:'C/V% Rede' };`, adicionar `pagar:'A Pagar % Rede'`:

```javascript
const _kpiLabel = { diario:'Média Diária 2026', mensal:'Média Mensal 2026', merc:'Total Mercad. 2026', lojas:'Melhor Loja 2026', margem:'Melhor Margem 2026', cv:'C/V% Rede', pagar:'A Pagar % Rede' };
```

Em `function setTab(aba)`, no array de abas do `forEach`, adicionar `'pagar'`:

```javascript
  ['diario','mensal','merc','lojas','margem','cv','pagar'].forEach(t => {
```

Em `const _carregar = { diario: carregar, mensal: carregarMensal, merc: carregarMerc, lojas: carregarLojas, margem: carregarMargem, cv: carregarCV };`, adicionar `pagar: carregarPagarVenda`:

```javascript
const _carregar = { diario: carregar, mensal: carregarMensal, merc: carregarMerc, lojas: carregarLojas, margem: carregarMargem, cv: carregarCV, pagar: carregarPagarVenda };
```

No listener de troca de mês, adicionar `'pagar'` na lista de abas que recarregam:

```javascript
document.getElementById('sel-mes').addEventListener('change', () => {
  _carregado[abaAtual] = false;
  if (['diario','merc','lojas','margem','cv','pagar'].includes(abaAtual)) _carregar[abaAtual]();
});
```

- [ ] **Step 6: Validar sintaxe do JS embutido**

Extrair o conteúdo do primeiro `<script>...</script>` do arquivo pra um `.js` temporário e checar:

Usar o diretório de scratchpad da sessão (não `/tmp`) pro arquivo temporário:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/comparativos.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
fs.writeFileSync(process.env.SCRATCH_JS_PATH, m[1]);
" 
```

(definir `SCRATCH_JS_PATH` como `<diretório-de-scratchpad-da-sessão>/comparativos_check.js` antes
de rodar, ex: `export SCRATCH_JS_PATH="$SCRATCHPAD/comparativos_check.js"`)

```bash
node --check "$SCRATCH_JS_PATH"
rm "$SCRATCH_JS_PATH"
```

Expected: `node --check` não imprime nada (sucesso). Se apontar erro de sintaxe, a linha do erro é
relativa ao início do `<script>`, não do arquivo — contar a partir de lá pra achar o problema.

- [ ] **Step 7: Commit**

```bash
git add public/comparativos.html
git commit -m "$(cat <<'EOF'
Adiciona aba "A Pagar x Venda" em comparativos.html

Barra horizontal por loja (1-6) mostrando % de Contas a Pagar do mês
sobre Venda Total, com escala de cor fixa verde(0-50%)/amarelo(50-70%)/
vermelho(70%+) revelada por uma máscara — sem valor em R$, só %.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Deploy e verificação com o Tiago

**Files:** nenhum (só deploy).

- [ ] **Step 1: Push**

```bash
git push origin main
```

Expected: push aceito, sem conflito (branch `main` local à frente do remoto pelos 3 commits dos
tasks anteriores).

- [ ] **Step 2: Disparar o deploy**

```bash
curl -s -m 20 "https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026"
```

Expected: saída contendo o hash do commit do Task 3 (`git log -1 --oneline` local pra conferir
qual é) na linha `HEAD is now at <hash> ...`, seguida de `Reiniciando servidor...`.

- [ ] **Step 3: Pedir confirmação visual ao Tiago**

Não há credencial de login disponível nesta sessão pra verificar via navegador (mesma limitação
de sessões anteriores neste mesmo dia). Pedir pro Tiago dar hard refresh em `comparativos.html`,
abrir a aba "A Pagar x Venda" e confirmar:
1. As 6 lojas aparecem, cada uma com uma barra e uma porcentagem (sem valor em R$).
2. As cores batem com a regra (verde <50%, amarelo 50-70%, vermelho ≥70%).
3. Trocar o mês no filtro recarrega a aba corretamente.
