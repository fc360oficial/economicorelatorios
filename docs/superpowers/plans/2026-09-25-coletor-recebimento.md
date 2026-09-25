# Coletor de Recebimento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA Android de recebimento (conferência cega) integrada ao Econômico Relatórios, gravando nas 4 tabelas `central.conferencia*` do MySQL de teste do `.254` via `escreverERP`, com liberação pela tela Fiscal, chat interno e "LOG Coletor" numa página de Log com abas.

**Architecture:** `lib/recebimento.js` (puro, estado em JSON por dia em `data/recebimento/`) + `lib/recebimento-erp.js` (monta passos pro `escreverERP.lote`) + `lib/log-coletor.js` (JSONL por mês) + rotas em `server.js` (públicas por token, internas por sessão no módulo `fiscal`/`processos`) + `public/recebimento.html` (PWA) + mudanças em `public/fiscal.html` e `public/log.html` (abas).

**Tech Stack:** Node (CommonJS, `node:test`), Express, mysql2, fs/JSON, vanilla HTML/JS com `design-system.css`. Sem libs novas.

**Spec:** `docs/superpowers/specs/2026-09-25-coletor-recebimento-design.md`

## Global Constraints

- **Nunca** `q()` com escrita; toda escrita no ERP passa por `escreverERP` / `escreverERP.lote` (banco de teste `.254`, `dbTeste` em `server.js:379`). `.252` fechado.
- Só inserir/atualizar **linhas em tabelas existentes** do Dlinks (`conferencia`, `conferenciachave`, `conferenciaitens`, `conferenciadevolucao`); nunca criar tabela/coluna.
- Toda comparação bipado × XML em **unidade** (`qtd × qtdemb` vs `oqTrib`).
- Conferência **cega**: nenhuma rota pública devolve itens, quantidades ou valores da nota.
- Visual: `public/design-system.css` (navy + âmbar), botões de ação em cima, referência https://claude.ai/artifact/BVDkbGGtUhtn24KY8A4TPG.
- Nova página/API entra em `lib/modulos.js` (acesso por módulo).
- Testes: `node --test test/` (sem script npm). Commits pequenos, mensagem em português, com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Deploy: `git push origin main` + `GET https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026`.

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/log-coletor.js` (novo) | append/ler/csv de eventos do coletor em `data/log-coletor/AAAA-MM.jsonl` (reusa `log-erp.js` helpers) |
| `lib/recebimento.js` (novo) | estado: config PIN/token, conferências do dia, bipar/corrigir/terminei/recontar, devoluções (3 origens), chat, liberar/reconferir. Só fs; ERP e XML injetados |
| `lib/recebimento-erp.js` (novo) | funções puras `passosAbrir/passosItem/passosStatus/passosLiberar` → `passos[]` do `escreverERP.lote` |
| `test/recebimento*.test.js` | testes unitários dos três módulos |
| `server.js` | rotas `/api/recebimento-publico/*` e `/api/recebimento/*`, `/api/log-coletor`, `/api/logs` |
| `lib/modulos.js` | páginas/apis novas |
| `public/recebimento.html` + `public/manifest-recebimento.json` | PWA do coletor |
| `public/log.html` | abas de logs (registro genérico) |
| `public/fiscal.html` | coluna "Coletor Econômico", Liberar/Reconferir, chat |

---

### Task 1: LOG Coletor (módulo + rotas + abas na página Log)

**Files:**
- Create: `lib/log-coletor.js`, `test/log-coletor.test.js`
- Modify: `server.js` (perto de `app.get('/api/log-erp'`, linha ~403), `lib/modulos.js:25`, `public/log.html`

**Interfaces:**
- Produces: `logColetor.registrar(dir, evento)` onde `evento = { tipo, loja, nome, nfe?, chave?, nReg?, cod?, descricao?, quant?, emb?, un?, validade?, resultado?, msg?, logErpId?, erro? }` → entrada `{ id, em, ...evento }`; `logColetor.ler(dir, { de, ate, loja, tipo, nfe, nome, limite })`; `logColetor.csv(itens)`; `TIPOS = ['entrar','abrir_nota','bipe','corrigir','terminei','chat','liberar','reconferir','erp']`.
- Produces: `GET /api/logs` → `[{ id:'erp', nome:'Log ERP (teste)', api:'/api/log-erp' }, { id:'coletor', nome:'LOG Coletor', api:'/api/log-coletor' }]` (Tiago: "vai ter vários logs, a gente vai criando" — cada log novo = 1 linha nessa lista).

- [ ] **Step 1: teste**

```js
// test/log-coletor.test.js
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const LC = require('../lib/log-coletor');
test('registrar grava jsonl por mês e ler filtra por loja/tipo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  const e = LC.registrar(dir, { tipo: 'bipe', loja: 3, nome: 'MAYRA', nfe: '911217', cod: '7896213007386', quant: 10, emb: 24, un: 240, resultado: 'ok' }, new Date('2026-09-25T10:00:00'));
  assert.equal(e.em.slice(0, 10), '2026-09-25'); assert.ok(e.id);
  LC.registrar(dir, { tipo: 'entrar', loja: 1, nome: 'ANA' }, new Date('2026-09-25T10:01:00'));
  assert.ok(fs.existsSync(path.join(dir, '2026-09.jsonl')));
  assert.equal(LC.ler(dir, { de: '2026-09-01', ate: '2026-09-30', loja: 3 }).length, 1);
  assert.equal(LC.ler(dir, { de: '2026-09-01', ate: '2026-09-30', tipo: 'entrar' })[0].nome, 'ANA');
  assert.throws(() => LC.registrar(dir, { tipo: 'xyz', loja: 1, nome: 'A' }), /tipo/);
  assert.match(LC.csv(LC.ler(dir, { de: '2026-09-01', ate: '2026-09-30' })), /tipo;loja;nome/);
});
```

- [ ] **Step 2:** `node --test test/log-coletor.test.js` → FAIL (módulo não existe)
- [ ] **Step 3: implementação**

```js
// lib/log-coletor.js — eventos do coletor de recebimento, append-only, 1 arquivo por mês
const fs = require('fs'); const path = require('path');
const L = require('./log-erp'); // novoId, agoraIso, arquivoDoMes-like helpers reimplementados aqui pra não expor internos
const TIPOS = ['entrar', 'abrir_nota', 'bipe', 'corrigir', 'terminei', 'chat', 'liberar', 'reconferir', 'erp'];
const CAMPOS = ['id', 'em', 'tipo', 'loja', 'nome', 'nfe', 'chave', 'nReg', 'cod', 'descricao', 'quant', 'emb', 'un', 'validade', 'resultado', 'msg', 'logErpId', 'erro'];
function arq(dir, quando) { return path.join(dir, String(quando).slice(0, 7) + '.jsonl'); }
function registrar(dir, ev, agora = new Date()) {
  if (!TIPOS.includes(ev.tipo)) throw new Error('tipo inválido: ' + ev.tipo);
  if (!ev.loja) throw new Error('loja obrigatória');
  const e = { id: L.novoId(agora), em: L.agoraIso(agora) };
  for (const k of CAMPOS) if (ev[k] !== undefined && !(k in e)) e[k] = ev[k];
  fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(arq(dir, e.em), JSON.stringify(e) + '\n'); return e;
}
function meses(de, ate) { const out = []; let d = new Date(de.slice(0, 7) + '-01T00:00:00'); const fim = ate.slice(0, 7); for (;;) { const m = d.toISOString().slice(0, 7); out.push(m); if (m >= fim) break; d.setMonth(d.getMonth() + 1); } return out; }
function ler(dir, { de, ate, loja, tipo, nfe, nome, limite = 5000 } = {}) {
  de = de || new Date().toISOString().slice(0, 10); ate = ate || de; const out = [];
  for (const m of meses(de, ate)) { const f = path.join(dir, m + '.jsonl'); if (!fs.existsSync(f)) continue;
    for (const ln of fs.readFileSync(f, 'utf8').split('\n')) { if (!ln) continue; let e; try { e = JSON.parse(ln); } catch { continue; }
      const dia = e.em.slice(0, 10); if (dia < de || dia > ate) continue;
      if (loja && +e.loja !== +loja) continue; if (tipo && e.tipo !== tipo) continue;
      if (nfe && String(e.nfe || '') !== String(nfe)) continue; if (nome && !String(e.nome || '').toUpperCase().includes(String(nome).toUpperCase())) continue;
      out.push(e); } }
  return out.sort((a, b) => b.em.localeCompare(a.em)).slice(0, limite);
}
function csv(itens) { const cab = ['em', 'tipo', 'loja', 'nome', 'nfe', 'cod', 'descricao', 'quant', 'emb', 'un', 'validade', 'resultado', 'msg', 'logErpId', 'erro'];
  const esc = v => v == null ? '' : /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  return '﻿' + cab.join(';') + '\n' + itens.map(e => cab.map(k => esc(e[k])).join(';')).join('\n'); }
module.exports = { registrar, ler, csv, TIPOS };
```
(Se `log-erp.js` não exportar `novoId`/`agoraIso` do jeito usado, copiar as duas funções — 5 linhas — pra dentro deste arquivo.)

- [ ] **Step 4:** `node --test test/log-coletor.test.js` → PASS
- [ ] **Step 5: rotas + módulo.** Em `server.js` logo após as rotas `/api/log-erp`:

```js
const logColetor = require('./lib/log-coletor');
const LOG_COLETOR_DIR = path.join(__dirname, 'data', 'log-coletor');
const LOGS = [ { id: 'erp', nome: 'Log ERP (teste)', api: '/api/log-erp' }, { id: 'coletor', nome: 'LOG Coletor', api: '/api/log-coletor' } ];
app.get('/api/logs', (req, res) => res.json(LOGS));
app.get('/api/log-coletor', (req, res) => { try { res.json(logColetor.ler(LOG_COLETOR_DIR, req.query)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/log-coletor/csv', (req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="log-coletor.csv"'); res.send(logColetor.csv(logColetor.ler(LOG_COLETOR_DIR, req.query))); });
```
Em `lib/modulos.js` módulo `processos`: `apis` += `'logs', 'log-coletor'`.

- [ ] **Step 6: abas em `public/log.html`.** Acima dos filtros, inserir `<div class="ds-tabs" id="logTabs"></div>`; no JS: `fetch('/api/logs')` → um botão por log (classe `ds-tab`, ativo = `?log=` da URL ou `erp`). Ao trocar de aba: aba `erp` mantém a tabela atual; aba `coletor` renderiza tabela com colunas `Hora · Loja · Nome · Evento · NF-e · Produto · Quant×Emb=Un · Validade · Resultado · Msg · Log ERP` (link `?log=erp&id=` quando `logErpId`), filtros dia/loja/tipo/NF-e/nome, botão Exportar CSV → `/api/log-coletor/csv?…`. Título da página: "Logs". Nav (`public/nav.js`) continua apontando pra `log.html`.
- [ ] **Step 7:** abrir `/log.html?log=coletor` local sem dados → tabela vazia sem erro no console. `node --test test/` → tudo PASS.
- [ ] **Step 8:** `git add lib/log-coletor.js test/log-coletor.test.js server.js lib/modulos.js public/log.html && git commit -m "Logs: página com abas (Log ERP, LOG Coletor) + lib/log-coletor"`

---

### Task 2: `lib/recebimento.js` — estado, PIN, abrir nota, bipar, corrigir

**Files:** Create `lib/recebimento.js`, `test/recebimento.test.js`

**Interfaces:**
- `init({ dir, cadastro, xmlLoja, agora })` — `cadastro(cod) → Promise<{cod, descricao, qtdemb, emb, validar}|null>`; `xmlLoja(chave) → { pedidoId, ln, status:'conciliado'|'consistencia'|'sem_pedido', itens:[{cod, descricao, un, decisao}], naoPedidos:[...] }|null` (injetados por `server.js`).
- `config()` → `{ lojas: {1:{pin,token},…}, validade_pct_min:100, recontagens_min:1, modo_cega:'total', janela_dias_axml:7 }`; `lojaPorPin(ln,pin)`, `lojaPorToken(t)`.
- `abrirNota({ loja, nome, chave, nNota, fornecedor, codFornec })` → conferência `c = { id, loja, nome, chave, nNota, fornecedor, codFornec, status:'bipando', abertoEm, itens:{}, recontagens:0, mensagens:[], erp:{ nReg:null, erros:[] } }` (id = `AAAA-MM-DD-<loja>-<nNota>`).
- `bipar(id, { cod, quant, emb, validade, nome })` → `{ item, resultado }`, `resultado ∈ 'ok'|'recusado'|'bloqueado_validade'|'nao_esta_na_nota'|'nao_cadastrado'`. Item: `{ cod, descricao, quant, emb, un, validade, estado, origem_devolucao?:'compras'|'coletor', bipagens }`.
- `corrigir(id, { cod, quant, emb, validade })`, `visaoLoja(loja, id)` (sem nada da nota), `listarDia(data)`, `obter(id)`, `salvar(c)`.

- [ ] **Step 1: testes**

```js
// test/recebimento.test.js
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../lib/recebimento');
const CAD = { '7896213007386': { cod: '7896213007386', descricao: 'CREAM CRACKER 350G', qtdemb: 24, emb: 'FD', validar: 180 }, '111': { cod: '111', descricao: 'SEM VALIDAR', qtdemb: 1, emb: 'UN', validar: 0 } };
const XML = { itens: [{ cod: '7896213007386', descricao: 'CREAM CRACKER', un: 240 }, { cod: '222', descricao: 'RECUSADO', un: 6, decisao: { acao: 'recusar' } }], naoPedidos: [], status: 'conciliado', pedidoId: 12, ln: 3 };
function setup() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')); R.init({ dir, cadastro: async c => CAD[c] || (c === '222' ? { cod: '222', descricao: 'RECUSADO', qtdemb: 1, emb: 'UN', validar: 0 } : null), xmlLoja: () => XML, agora: () => new Date('2026-09-25T08:00:00') }); return dir; }
test('PIN/token por loja', () => { setup(); const c = R.config(); assert.equal(Object.keys(c.lojas).length, 6); const t = R.lojaPorPin(3, c.lojas[3].pin); assert.equal(t.loja, 3); assert.equal(R.lojaPorToken(t.token).loja, 3); assert.equal(R.lojaPorPin(3, '0000'), null); });
test('abrir + bipar: ok / recusado / bloqueado validade / não cadastrado / não está na nota', async () => {
  setup(); const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: '2626'.padEnd(44, '0'), nNota: '911217', fornecedor: 'M DIAS', codFornec: 540 });
  assert.equal(c.status, 'bipando'); assert.equal(c.id, '2026-09-25-3-911217');
  let r = await R.bipar(c.id, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28', nome: 'MAYRA' });
  assert.equal(r.resultado, 'ok'); assert.equal(r.item.un, 240); assert.equal(r.item.estado, 'ok');
  r = await R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2027-03-28' }); assert.equal(r.item.un, 264); assert.equal(r.item.bipagens, 2);
  r = await R.bipar(c.id, { cod: '7896213007386', quant: 1, emb: 24, validade: '2026-12-01' }); assert.equal(r.resultado, 'bloqueado_validade'); assert.equal(r.item.origem_devolucao, 'coletor');
  r = await R.bipar(c.id, { cod: '222', quant: 6, emb: 1, validade: null }); assert.equal(r.resultado, 'recusado'); assert.equal(r.item.origem_devolucao, 'compras');
  r = await R.bipar(c.id, { cod: '111', quant: 3, emb: 1, validade: null }); assert.equal(r.resultado, 'nao_esta_na_nota');
  r = await R.bipar(c.id, { cod: '999', quant: 1, emb: 1 }); assert.equal(r.resultado, 'nao_cadastrado');
  const v = R.visaoLoja(3, c.id); assert.equal(v.produtos, 3); assert.ok(!('xml' in v)); assert.ok(!JSON.stringify(v).includes('"un":240,"pedida'));
  await R.corrigir(c.id, { cod: '7896213007386', quant: 5, emb: 24, validade: '2027-03-28' }); assert.equal(R.obter(c.id).itens['7896213007386'].un, 120);
});
```

- [ ] **Step 2:** rodar → FAIL
- [ ] **Step 3: implementação**

```js
// lib/recebimento.js — conferência cega de recebimento (estado no Econômico; ERP é espelho, ver recebimento-erp.js)
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
let DIR, deps = {}; const LOJAS = [1, 2, 3, 4, 5, 6];
const PADRAO = { validade_pct_min: 100, recontagens_min: 1, modo_cega: 'total', janela_dias_axml: 7 };
const agora = () => (deps.agora ? deps.agora() : new Date());
const hojeStr = () => { const d = agora(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const arqCfg = () => path.join(DIR, 'recebimento-config.json');
const arqDia = data => path.join(DIR, data + '.json');
function init(o) { DIR = o.dir; deps = o; fs.mkdirSync(DIR, { recursive: true }); config(); }
function config() { let c = {}; try { c = JSON.parse(fs.readFileSync(arqCfg(), 'utf8')); } catch {} c = { ...PADRAO, ...c, lojas: c.lojas || {} }; let mudou = false;
  for (const ln of LOJAS) { c.lojas[ln] = c.lojas[ln] || {}; if (!c.lojas[ln].pin) { c.lojas[ln].pin = String(1000 + Math.floor(Math.random() * 9000)); mudou = true; } if (!c.lojas[ln].token) { c.lojas[ln].token = crypto.randomBytes(16).toString('hex'); mudou = true; } }
  if (mudou || !fs.existsSync(arqCfg())) fs.writeFileSync(arqCfg(), JSON.stringify(c, null, 2)); return c; }
function setConfig(campos) { const c = { ...config(), ...campos }; fs.writeFileSync(arqCfg(), JSON.stringify(c, null, 2)); return c; }
function lojaPorPin(ln, pin) { const c = config().lojas[ln]; return c && String(pin) === String(c.pin) ? { loja: +ln, token: c.token } : null; }
function lojaPorToken(t) { if (!/^[a-f0-9]{32}$/.test(String(t || ''))) return null; const c = config(); const ln = LOJAS.find(k => c.lojas[k].token === t); return ln ? { loja: ln, token: t } : null; }
function lerDia(data) { try { return JSON.parse(fs.readFileSync(arqDia(data), 'utf8')); } catch { return { data, confs: {} }; } }
function gravarDia(d) { fs.writeFileSync(arqDia(d.data), JSON.stringify(d)); }
function obter(id) { return lerDia(id.slice(0, 10)).confs[id] || null; }
function salvar(c) { const d = lerDia(c.id.slice(0, 10)); c.atualizadoEm = agora().toISOString(); d.confs[c.id] = c; gravarDia(d); return c; }
function listarDia(data = hojeStr()) { return Object.values(lerDia(data).confs); }
function abrirNota({ loja, nome, chave, nNota, fornecedor, codFornec }) {
  const id = `${hojeStr()}-${loja}-${nNota}`; const ex = obter(id); if (ex) return ex;
  return salvar({ id, loja: +loja, nome: String(nome || '').toUpperCase().slice(0, 20), chave, nNota: String(nNota), fornecedor, codFornec: +codFornec || 0, status: 'bipando', abertoEm: agora().toISOString(), itens: {}, recontagens: 0, mensagens: [], erp: { nReg: null, erros: [] } });
}
function diasAte(validade) { if (!validade) return null; return Math.round((new Date(validade + 'T00:00:00') - new Date(hojeStr() + 'T00:00:00')) / 864e5); }
function xmlDe(c) { const x = deps.xmlLoja ? deps.xmlLoja(c.chave) : null; return x || { itens: [], naoPedidos: [], status: 'sem_pedido' }; }
async function bipar(id, { cod, quant, emb, validade, nome }) {
  const c = obter(id); if (!c) throw new Error('Conferência não encontrada'); if (c.status === 'liberada') throw new Error('Nota já liberada');
  cod = String(cod || '').trim(); const cad = await deps.cadastro(cod);
  if (!cad) return { resultado: 'nao_cadastrado', item: null };
  const x = xmlDe(c); const noXml = (x.itens || []).find(i => i.cod === cod); const cfg = config();
  quant = +quant || 0; emb = +emb || cad.qtdemb || 1; const un = +(quant * emb).toFixed(3);
  const it = c.itens[cod] || (c.itens[cod] = { cod, descricao: cad.descricao, quant: 0, emb, un: 0, validade: null, estado: 'ok', bipagens: 0, validar: cad.validar || 0 });
  it.bipagens++; it.quant = +(it.quant + quant).toFixed(3); it.emb = emb; it.un = +(it.un + un).toFixed(3);
  if (validade && (!it.validade || validade < it.validade)) it.validade = validade;
  let resultado = 'ok';
  if (noXml && noXml.decisao && noXml.decisao.acao === 'recusar') { it.estado = 'recusado'; it.origem_devolucao = 'compras'; resultado = 'recusado'; }
  else if (!noXml) { it.estado = 'nao_esta_na_nota'; resultado = 'nao_esta_na_nota'; }
  const d = diasAte(it.validade);
  if (resultado === 'ok' && it.validar > 0 && d != null && d < it.validar * (cfg.validade_pct_min / 100)) { it.estado = 'bloqueado_validade'; it.origem_devolucao = 'coletor'; resultado = 'bloqueado_validade'; }
  if (resultado === 'ok') it.estado = 'ok';
  it.por = nome || c.nome; it.em = agora().toISOString(); salvar(c); return { resultado, item: it };
}
async function corrigir(id, { cod, quant, emb, validade }) { const c = obter(id); const it = c && c.itens[cod]; if (!it) throw new Error('Item não bipado');
  it.quant = 0; it.un = 0; it.validade = null; it.bipagens = 0; delete it.origem_devolucao; return bipar(id, { cod, quant, emb, validade, nome: c.nome }); }
function visaoLoja(loja, id) { const c = obter(id); if (!c || +c.loja !== +loja) return null; const itens = Object.values(c.itens);
  return { id: c.id, nNota: c.nNota, fornecedor: c.fornecedor, status: c.status, recontagens: c.recontagens, produtos: itens.length, unidades: +itens.reduce((a, i) => a + i.un, 0).toFixed(3),
    itens: itens.map(i => ({ cod: i.cod, descricao: i.descricao, quant: i.quant, emb: i.emb, un: i.un, validade: i.validade, estado: i.estado })), recontar: c.recontar || null, mensagens: c.mensagens.slice(-50) }; }
module.exports = { init, config, setConfig, lojaPorPin, lojaPorToken, hojeStr, obter, salvar, listarDia, abrirNota, bipar, corrigir, visaoLoja, diasAte, xmlDe, LOJAS };
```

- [ ] **Step 4:** rodar → PASS
- [ ] **Step 5:** `git add lib/recebimento.js test/recebimento.test.js && git commit -m "Recebimento: estado da conferência cega (PIN, abrir nota, bipar, corrigir, validade)"`

---

### Task 3: Terminei, recontagem, devoluções (3 origens), chat, liberar/reconferir

**Files:** Modify `lib/recebimento.js`; Create `test/recebimento-terminei.test.js`

**Interfaces (Produces):**
- `terminei(id)` → `{ bateu: bool, recontar: [{cod, descricao, motivo:'recontar'|'nao_bipado'|'nao_esta_na_nota'}], podeEnviar: bool }`; grava `c.recontar`, `c.recontagens++`, e se `bateu` ou `recontagens > recontagens_min` → `c.status='terminada'` (senão `'recontando'`).
- `enviarAssimMesmo(id)` → força `status='terminada'` se `recontagens >= recontagens_min`.
- `devolucoes(c)` → `[{ cod, descricao, qtd, origem:'compras'|'coletor'|'falta', motivo }]` (Compras: itens do XML com `decisao.acao==='recusar'`, qtd = un do XML; Coletor: itens `bloqueado_validade`/`avaria`; Falta: `xml.un − bipado.un` quando > 0, só com `status='terminada'`).
- `mensagem(id, { de:'loja'|'central', nome, motivo?, texto?, cod?, acao? })` → `c.mensagens.push({ em, de, nome, motivo, texto, cod, acao })`; `acao ∈ 'pode_receber'|'devolver'|'liberar_validade'|'aguarde'` — `liberar_validade` com `cod` muda `itens[cod].estado='ok'` e apaga `origem_devolucao`; `devolver` marca `estado='avaria'`, `origem_devolucao='coletor'`.
- `liberar(id, { nome })` → `status='liberada', liberadoEm, liberadoPor, devolucoes: devolucoes(c)`; `reconferir(id, { nome })` → `status='bipando'`, `recontagens=0`, mensagem automática da central.

- [ ] **Step 1: testes** (mesmo `setup()`/`CAD`/`XML` da Task 2, copiar; XML com `itens: [{cod:'7896213007386', un:240}, {cod:'333', descricao:'FALTA', un:12}, {cod:'222', un:6, decisao:{acao:'recusar'}}]`):

```js
test('terminei: recontagem sem revelar qtd; falta e recusa viram devolução; chat libera validade', async () => {
  setup(); const c = R.abrirNota({ loja: 3, nome: 'MAYRA', chave: 'K', nNota: '1', fornecedor: 'F', codFornec: 1 });
  await R.bipar(c.id, { cod: '7896213007386', quant: 8, emb: 24, validade: '2027-03-28' });   // 192 ≠ 240
  await R.bipar(c.id, { cod: '222', quant: 6, emb: 1 });                                       // recusado pela compradora
  let t = R.terminei(c.id); assert.equal(t.bateu, false); assert.deepEqual(t.recontar.map(r => r.motivo).sort(), ['nao_bipado', 'recontar']);
  assert.ok(!JSON.stringify(t).includes('240')); assert.equal(R.obter(c.id).status, 'recontando'); assert.equal(t.podeEnviar, true);
  await R.corrigir(c.id, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28' });
  t = R.terminei(c.id); assert.equal(t.bateu, false); assert.equal(t.recontar.length, 1); // falta o 333
  R.enviarAssimMesmo(c.id); assert.equal(R.obter(c.id).status, 'terminada');
  const dev = R.devolucoes(R.obter(c.id)); assert.deepEqual(dev.map(d => d.origem + ':' + d.cod + ':' + d.qtd).sort(), ['compras:222:6', 'falta:333:12']);
  R.mensagem(c.id, { de: 'loja', nome: 'MAYRA', motivo: 'validade', cod: '7896213007386' });
  R.mensagem(c.id, { de: 'central', nome: 'JOSE', acao: 'liberar_validade', cod: '7896213007386' });
  assert.equal(R.obter(c.id).mensagens.length, 2);
  const lib = R.liberar(c.id, { nome: 'JOSE' }); assert.equal(lib.status, 'liberada'); assert.equal(lib.devolucoes.length, 2);
  assert.throws(() => R.terminei(c.id), /liberada/);
});
```

- [ ] **Step 2:** rodar → FAIL
- [ ] **Step 3: implementação** (acrescentar em `lib/recebimento.js` antes do `module.exports` e exportar `terminei, enviarAssimMesmo, devolucoes, mensagem, liberar, reconferir`):

```js
function terminei(id) { const c = obter(id); if (!c) throw new Error('Conferência não encontrada'); if (c.status === 'liberada') throw new Error('Nota já liberada');
  const x = xmlDe(c); const cfg = config(); const recontar = [];
  for (const xi of x.itens || []) { if (xi.decisao && xi.decisao.acao === 'recusar') continue; const b = c.itens[xi.cod];
    if (!b) recontar.push({ cod: xi.cod, descricao: xi.descricao, motivo: 'nao_bipado' });
    else if (Math.abs(b.un - xi.un) > 0.001 && b.estado !== 'bloqueado_validade') recontar.push({ cod: xi.cod, descricao: b.descricao, motivo: 'recontar' }); }
  for (const b of Object.values(c.itens)) if (b.estado === 'nao_esta_na_nota') recontar.push({ cod: b.cod, descricao: b.descricao, motivo: 'nao_esta_na_nota' });
  c.recontagens = (c.recontagens || 0) + 1; c.recontar = recontar; const bateu = recontar.length === 0;
  c.status = bateu ? 'terminada' : 'recontando'; c.termineiEm = agora().toISOString(); salvar(c);
  return { bateu, recontar, podeEnviar: c.recontagens >= cfg.recontagens_min }; }
function enviarAssimMesmo(id) { const c = obter(id); if (c.recontagens < config().recontagens_min) throw new Error('Reconte antes de enviar'); c.status = 'terminada'; return salvar(c); }
function devolucoes(c) { const x = xmlDe(c); const out = [];
  for (const xi of x.itens || []) if (xi.decisao && xi.decisao.acao === 'recusar') out.push({ cod: xi.cod, descricao: xi.descricao, qtd: xi.un, origem: 'compras', motivo: 'recusado pela compradora na conferência XML' });
  for (const b of Object.values(c.itens)) { if (b.estado === 'bloqueado_validade') out.push({ cod: b.cod, descricao: b.descricao, qtd: b.un, origem: 'coletor', motivo: 'validade curta (' + b.validade + ')' });
    if (b.estado === 'avaria') out.push({ cod: b.cod, descricao: b.descricao, qtd: b.un, origem: 'coletor', motivo: 'avaria' }); }
  if (c.status === 'terminada' || c.status === 'liberada') for (const xi of x.itens || []) { if (xi.decisao && xi.decisao.acao === 'recusar') continue; const b = c.itens[xi.cod]; const rec = b && b.estado !== 'bloqueado_validade' && b.estado !== 'avaria' ? b.un : 0;
    const falta = +(xi.un - rec).toFixed(3); if (falta > 0) out.push({ cod: xi.cod, descricao: xi.descricao, qtd: falta, origem: 'falta', motivo: 'na nota, não veio' }); }
  return out; }
function mensagem(id, m) { const c = obter(id); if (!c) throw new Error('Conferência não encontrada'); const msg = { em: agora().toISOString(), de: m.de, nome: m.nome, motivo: m.motivo || null, texto: m.texto || null, cod: m.cod || null, acao: m.acao || null };
  if (m.de === 'central' && m.cod && c.itens[m.cod]) { const it = c.itens[m.cod]; if (m.acao === 'liberar_validade' || m.acao === 'pode_receber') { it.estado = 'ok'; delete it.origem_devolucao; } if (m.acao === 'devolver') { it.estado = 'avaria'; it.origem_devolucao = 'coletor'; } }
  c.mensagens.push(msg); salvar(c); return msg; }
function liberar(id, { nome }) { const c = obter(id); if (!c) throw new Error('Conferência não encontrada'); if (c.status !== 'terminada') throw new Error('Loja ainda não terminou');
  c.status = 'liberada'; c.liberadoEm = agora().toISOString(); c.liberadoPor = String(nome || '').toUpperCase().slice(0, 20); c.devolucoes = devolucoes(c); return salvar(c); }
function reconferir(id, { nome }) { const c = obter(id); if (!c) throw new Error('Conferência não encontrada'); c.status = 'bipando'; c.recontagens = 0; c.recontar = null;
  c.mensagens.push({ em: agora().toISOString(), de: 'central', nome, texto: 'Central pediu pra reconferir a nota', acao: 'aguarde' }); return salvar(c); }
```

- [ ] **Step 4:** rodar `node --test test/` → PASS
- [ ] **Step 5:** commit `"Recebimento: terminei/recontagem, devoluções (compras/coletor/falta), chat, liberar/reconferir"`

---

### Task 4: `lib/recebimento-erp.js` — passos pro ERP (formato Dlinks)

**Files:** Create `lib/recebimento-erp.js`, `test/recebimento-erp.test.js`

**Interfaces (Produces):** funções puras que devolvem `{ motivo, passos }` pro `escreverERP.lote({ usuario, motivo, banco:'central', passos, limite })`:
- `passosAbrir(c, { dataHora })` → INSERT `conferencia` `{ nLoja, CodFornec, NomeFornec(≤45), Status:1, DataEntrada:'AAAA-MM-DD', HoraEntrada:'HH:MM:SS', OperadorLoja, OperadorLiberacao:'0', Beep:1, Aviso:0, Aviso2:0, Backup:0, Obs:'Economico ' + c.id }` + INSERT `conferenciachave` `{ nRegConf:{ $id:0 }, Chave:c.chave, Obs:'Economico', Backup:0 }`.
- `passosItem(c, item, nReg)` → se `item.bipagens === 1` INSERT `conferenciaitens` `{ chave:String(nReg), codigobarra, emb, qtd:item.quant, qtdemb:item.emb, status:1, Reconferir:0, Name:'0', Backup:0, DataValidade: item.validade || '00/00/0000' }`, senão UPDATE mesmos campos `where { chave:String(nReg), codigobarra }`.
- `passosStatus(c, nReg, status, { nome, dataHora })` → UPDATE `conferencia` `{ Status }` (+ `DataConferido/HoraConferido` quando 3) `where { nReg }`.
- `passosLiberar(c, nReg, { nome, dataHora })` → UPDATE `conferencia` `{ Status:2, DataLiberacao, HoraLiberacao, OperadorCentral:nome, OperadorLiberacao:nome }` + um INSERT `conferenciadevolucao` `{ nConf:nReg, CodigoBarra:d.cod, Qtd:d.qtd, Backup:0 }` por item de `c.devolucoes`.

- [ ] **Step 1: teste**

```js
const test = require('node:test'); const assert = require('node:assert/strict'); const E = require('../lib/recebimento-erp');
const c = { id: '2026-09-25-3-911217', loja: 3, nome: 'MAYRA', chave: 'K'.padEnd(44, '0'), nNota: '911217', fornecedor: 'M. DIAS BRANCO S.A. INDUSTRIA E COMERCIO DE ALIMENTOS LTDA', codFornec: 540, devolucoes: [{ cod: '222', qtd: 6, origem: 'compras' }] };
const dh = new Date('2026-09-25T08:05:09');
test('passosAbrir: conferencia + chave ligada por $id', () => { const { passos } = E.passosAbrir(c, { dataHora: dh });
  assert.equal(passos.length, 2); assert.equal(passos[0].tabela, 'conferencia'); assert.equal(passos[0].valores.Status, 1); assert.equal(passos[0].valores.HoraEntrada, '08:05:09'); assert.equal(passos[0].valores.NomeFornec.length, 45);
  assert.deepEqual(passos[1].valores.nRegConf, { $id: 0 }); assert.equal(passos[1].valores.Chave.length, 44); });
test('passosItem: insert na 1ª bipagem, update depois; qtd em emb', () => {
  let p = E.passosItem(c, { cod: '7896213007386', quant: 10, emb: 24, validade: '2027-03-28', bipagens: 1 }, 182400).passos[0];
  assert.equal(p.operacao, 'insert'); assert.equal(p.valores.chave, '182400'); assert.equal(p.valores.qtd, 10); assert.equal(p.valores.qtdemb, 24); assert.equal(p.valores.DataValidade, '2027-03-28');
  p = E.passosItem(c, { cod: '7896213007386', quant: 11, emb: 24, validade: null, bipagens: 2 }, 182400).passos[0];
  assert.equal(p.operacao, 'update'); assert.deepEqual(p.where, { chave: '182400', codigobarra: '7896213007386' }); assert.equal(p.valores.DataValidade, '00/00/0000'); });
test('passosLiberar: status 2 + devoluções', () => { const { passos } = E.passosLiberar(c, 182400, { nome: 'JOSE', dataHora: dh });
  assert.equal(passos[0].valores.Status, 2); assert.equal(passos[0].valores.OperadorLiberacao, 'JOSE'); assert.equal(passos[1].tabela, 'conferenciadevolucao'); assert.equal(passos[1].valores.nConf, 182400); assert.equal(passos[1].valores.Qtd, 6); });
```

- [ ] **Step 2:** FAIL → **Step 3:** implementar exatamente as 4 funções acima (helpers `ymd(d)`, `hms(d)`, `cortar(s, n)`); `motivo` = `'Coletor Econômico ' + c.id + ' · ' + <ação>`.
- [ ] **Step 4:** PASS → **Step 5:** commit `"Recebimento: passos ERP no formato do Dlinks (conferencia/chave/itens/devolucao)"`

---

### Task 5: rotas em `server.js` (públicas por token + internas) e espelho ERP

**Files:** Modify `server.js` (bloco novo depois das rotas `/api/contagem`, ~linha 5225), `lib/modulos.js`

**Interfaces:**
- Consumes: Tasks 1–4; `pedidosFornec.listar()`; `conferenciaXml.LOJA_CNPJ`; `escreverERP.lote`; `q()` (leitura `.252`).
- Produces (públicas, `?t=token` ou body `t`): `POST /api/recebimento-publico/entrar {loja,pin,nome}` → `{loja, token, nome}`; `GET .../notas` → `[{ chave, nNota, fornecedor, pedidoId, veredito:'liberada'|'divergente'|'sem_pedido', conferencia:{id,status}|null }]`; `POST .../abrir {chave}`; `GET .../conferencia/:id`; `POST .../bipar {id,cod,quant,emb,validade}`; `POST .../corrigir`; `POST .../terminei {id}`; `POST .../enviar {id}`; `POST .../chat {id,motivo,texto,cod}`; `GET .../cadastro/:cod` → `{descricao, qtdemb, emb}` (pra preencher Emb).
- Internas (sessão, módulo `fiscal`): `GET /api/recebimento?data=` → conferências do dia + `devolucoes`; `POST /api/recebimento/:id/liberar|reconferir|chat|reenviar-erp`; `GET/POST /api/recebimento/config`.

- [ ] **Step 1: wiring**

```js
// ── Coletor de Recebimento (conferência cega) ────────────────────────────────
const recebimento = require('./lib/recebimento'); const recebErp = require('./lib/recebimento-erp');
const cadastroCache = new Map();
async function cadastroItem(cod) { if (cadastroCache.has(cod)) return cadastroCache.get(cod); const r = await q(`SELECT CodigoBarras cod, Descricao descricao, qtdemb, Emb emb, Validar validar FROM central.itens WHERE CodigoBarras=? LIMIT 1`, [cod]).catch(() => []);
  const v = r[0] ? { cod, descricao: String(r[0].descricao || '').trim(), qtdemb: +r[0].qtdemb || 1, emb: String(r[0].emb || 'UN').trim(), validar: +r[0].validar || 0 } : null; cadastroCache.set(cod, v); setTimeout(() => cadastroCache.delete(cod), 600e3); return v; }
function xmlPorChave(chave) { for (const p of pedidosFornec.listar()) for (const [ln, x] of Object.entries(p.xml?.lojas || {})) { const n = (x.notas || []).find(n => n.chave === chave); if (!n) continue;
    const itens = (x.itens || []).map(i => ({ cod: i.cod, descricao: i.descricao, un: +i.recebida || 0, decisao: i.decisao || null }));
    const naoPedidos = (x.nao_pedidos || []).map(i => ({ cod: i.cod, descricao: i.descricao, un: +i.recebida || 0, decisao: i.decisao || null }));
    return { pedidoId: p.id, ln: +ln, status: x.status === 'conciliado' ? 'conciliado' : 'consistencia', itens: itens.concat(naoPedidos.filter(i => i.decisao?.acao !== 'recusar')), naoPedidos }; } return null; }
recebimento.init({ dir: path.join(__dirname, 'data', 'recebimento'), cadastro: cadastroItem, xmlLoja: xmlPorChave });
const rcLoja = req => recebimento.lojaPorToken(req.query.t || req.body?.t);
const logC = ev => { try { logColetor.registrar(LOG_COLETOR_DIR, ev); } catch (e) { console.error('[LOG COLETOR]', e.message); } };
async function espelhoErp(c, montado, tipo) { try { const r = await escreverERP.lote({ usuario: 'coletor:' + c.nome, motivo: montado.motivo, banco: 'central', passos: montado.passos, limite: 200 });
    if (tipo === 'abrir') c.erp.nReg = r.ids_gerados?.[0] || null; c.erp.ultimoLogId = r.id; recebimento.salvar(c); logC({ tipo: 'erp', loja: c.loja, nome: c.nome, nfe: c.nNota, nReg: c.erp.nReg, logErpId: r.id, msg: tipo }); return r; }
  catch (e) { c.erp.erros.push({ em: new Date().toISOString(), tipo, erro: e.message, passos: montado.passos }); recebimento.salvar(c); logC({ tipo: 'erp', loja: c.loja, nome: c.nome, nfe: c.nNota, erro: e.message, msg: tipo }); return null; } }
```
(Confirmar nomes das colunas de `central.itens` — `CodigoBarras`, `Descricao`, `qtdemb`, `Emb`, `Validar` — com `SHOW COLUMNS` no `.254` antes de subir; ajustar se diferirem. Verificar também o formato de retorno de `escreverERP.lote` — `ids_gerados`, `id` — em `lib/escrever-erp.js`.)

- [ ] **Step 2: rotas públicas**

```js
app.post('/api/recebimento-publico/entrar', (req, res) => { const { loja, pin, nome } = req.body || {}; const r = recebimento.lojaPorPin(parseInt(loja, 10), String(pin || '').trim());
  if (!r) return res.status(401).json({ error: 'PIN não confere com essa loja.' }); logC({ tipo: 'entrar', loja: r.loja, nome: String(nome || '').toUpperCase(), msg: String(req.headers['user-agent'] || '').slice(0, 80) }); res.json({ ...r, nome: String(nome || '').toUpperCase().slice(0, 20) }); });
app.get('/api/recebimento-publico/notas', async (req, res) => { const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida. Entre de novo com o PIN.' });
  try { const cfg = recebimento.config(); const cnpj = conferenciaXml.LOJA_CNPJ[s.loja]; const desde = new Date(Date.now() - cfg.janela_dias_axml * 864e5).toISOString().slice(0, 10);
    const rows = await q(`SELECT a.Chave chave, a.nNota, a.CNPJemit, a.Data FROM central.axml a WHERE a.CNPJdest=? AND a.nMod='55' AND a.Data>=? ORDER BY a.Data DESC, a.nReg DESC LIMIT 200`, [cnpj, desde]);
    const raizes = [...new Set(rows.map(r => String(r.CNPJemit).slice(0, 8)))]; const forn = raizes.length ? await q(`SELECT LEFT(CNPJ,8) raiz, nReg cod, Nome nome FROM central.fornecedor WHERE LEFT(CNPJ,8) IN (${raizes.map(() => '?').join(',')})`, raizes) : [];
    const fPorRaiz = Object.fromEntries(forn.map(f => [f.raiz, f])); const hoje = recebimento.listarDia(); const conf = Object.fromEntries(hoje.map(c => [c.chave, c]));
    res.json(rows.map(r => { const x = xmlPorChave(r.chave); const f = fPorRaiz[String(r.CNPJemit).slice(0, 8)]; const c = conf[r.chave];
      return { chave: r.chave, nNota: String(r.nNota), fornecedor: f ? f.nome : 'CNPJ ' + r.CNPJemit, codFornec: f ? f.cod : 0, pedidoId: x ? x.pedidoId : null, veredito: !x ? 'sem_pedido' : x.status === 'conciliado' ? 'liberada' : 'divergente', conferencia: c ? { id: c.id, status: c.status } : null }; }).filter(n => !n.conferencia || n.conferencia.status !== 'liberada')); }
  catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/recebimento-publico/abrir', async (req, res) => { const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
  const { chave, nNota, fornecedor, codFornec, nome } = req.body || {}; if (!chave) return res.status(400).json({ error: 'chave obrigatória' });
  const c = recebimento.abrirNota({ loja: s.loja, nome, chave, nNota, fornecedor, codFornec }); if (!c.erp.nReg && !c.erp.erros.length) await espelhoErp(c, recebErp.passosAbrir(c, { dataHora: new Date() }), 'abrir');
  logC({ tipo: 'abrir_nota', loja: s.loja, nome: c.nome, nfe: c.nNota, chave, nReg: c.erp.nReg, descricao: fornecedor }); res.json(recebimento.visaoLoja(s.loja, c.id)); });
app.get('/api/recebimento-publico/conferencia/:id', (req, res) => { const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' }); const v = recebimento.visaoLoja(s.loja, req.params.id); v ? res.json(v) : res.status(404).json({ error: 'não encontrada' }); });
app.get('/api/recebimento-publico/cadastro/:cod', async (req, res) => { if (!rcLoja(req)) return res.status(401).json({ error: 'Sessão inválida.' }); const k = await cadastroItem(String(req.params.cod).trim()); k ? res.json({ descricao: k.descricao, qtdemb: k.qtdemb, emb: k.emb }) : res.status(404).json({ error: 'Produto não cadastrado. Chame a central.' }); });
for (const acao of ['bipar', 'corrigir']) app.post('/api/recebimento-publico/' + acao, async (req, res) => { const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
  try { const c0 = recebimento.obter(req.body.id); if (!c0 || +c0.loja !== s.loja) return res.status(404).json({ error: 'Conferência não encontrada' });
    const r = await recebimento[acao](req.body.id, req.body); const c = recebimento.obter(req.body.id);
    logC({ tipo: acao === 'bipar' ? 'bipe' : 'corrigir', loja: s.loja, nome: c.nome, nfe: c.nNota, cod: req.body.cod, descricao: r.item?.descricao, quant: req.body.quant, emb: req.body.emb, un: r.item?.un, validade: req.body.validade, resultado: r.resultado });
    if (r.item && c.erp.nReg && r.resultado !== 'nao_cadastrado') await espelhoErp(c, recebErp.passosItem(c, r.item, c.erp.nReg), 'item');
    res.json({ resultado: r.resultado, item: r.item, visao: recebimento.visaoLoja(s.loja, c.id) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/recebimento-publico/terminei', async (req, res) => { const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
  try { const t = recebimento.terminei(req.body.id); const c = recebimento.obter(req.body.id); logC({ tipo: 'terminei', loja: s.loja, nome: c.nome, nfe: c.nNota, resultado: t.bateu ? 'bateu' : t.recontar.length + ' recontar', msg: 'recontagem ' + c.recontagens });
    if (c.status === 'terminada' && c.erp.nReg) await espelhoErp(c, recebErp.passosStatus(c, c.erp.nReg, 3, { nome: c.nome, dataHora: new Date() }), 'terminei'); res.json({ ...t, status: c.status }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/recebimento-publico/enviar', async (req, res) => { const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
  try { const c = recebimento.enviarAssimMesmo(req.body.id); logC({ tipo: 'terminei', loja: s.loja, nome: c.nome, nfe: c.nNota, resultado: 'enviado assim mesmo' }); if (c.erp.nReg) await espelhoErp(c, recebErp.passosStatus(c, c.erp.nReg, 3, { nome: c.nome, dataHora: new Date() }), 'terminei'); res.json({ status: c.status }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/recebimento-publico/chat', (req, res) => { const s = rcLoja(req); if (!s) return res.status(401).json({ error: 'Sessão inválida.' });
  try { const c = recebimento.obter(req.body.id); const m = recebimento.mensagem(req.body.id, { de: 'loja', nome: c.nome, motivo: req.body.motivo, texto: req.body.texto, cod: req.body.cod }); logC({ tipo: 'chat', loja: s.loja, nome: c.nome, nfe: c.nNota, cod: m.cod, msg: [m.motivo, m.texto].filter(Boolean).join(': ') }); res.json(m); } catch (e) { res.status(400).json({ error: e.message }); } });
```

- [ ] **Step 3: rotas internas**

```js
app.get('/api/recebimento', (req, res) => res.json(recebimento.listarDia(req.query.data || recebimento.hojeStr()).map(c => ({ ...c, devolucoes: c.devolucoes || recebimento.devolucoes(c), xml: undefined }))));
app.get('/api/recebimento/config', (req, res) => { const c = recebimento.config(); res.json({ ...c, lojas: Object.fromEntries(Object.entries(c.lojas).map(([k, v]) => [k, { pin: v.pin }])) }); });
app.post('/api/recebimento/config', (req, res) => { const { validade_pct_min, recontagens_min, modo_cega, janela_dias_axml } = req.body || {}; res.json(recebimento.setConfig({ validade_pct_min: +validade_pct_min || 100, recontagens_min: +recontagens_min || 1, modo_cega: modo_cega || 'total', janela_dias_axml: +janela_dias_axml || 7 })); });
app.post('/api/recebimento/:id/liberar', async (req, res) => { const nome = req.session.user?.nome || 'CENTRAL';
  try { const c = recebimento.liberar(req.params.id, { nome }); logC({ tipo: 'liberar', loja: c.loja, nome, nfe: c.nNota, msg: c.devolucoes.map(d => d.origem + ' ' + d.cod + ' ' + d.qtd).join('; ') });
    const r = c.erp.nReg ? await espelhoErp(c, recebErp.passosLiberar(c, c.erp.nReg, { nome, dataHora: new Date() }), 'liberar') : null; res.json({ ok: true, conferencia: c, erp: r ? { logId: r.id } : { erro: c.erp.erros.at(-1)?.erro || 'sem nReg no ERP' } }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/recebimento/:id/reconferir', async (req, res) => { const nome = req.session.user?.nome || 'CENTRAL';
  try { const c = recebimento.reconferir(req.params.id, { nome }); logC({ tipo: 'reconferir', loja: c.loja, nome, nfe: c.nNota }); if (c.erp.nReg) await espelhoErp(c, recebErp.passosStatus(c, c.erp.nReg, 5, { nome, dataHora: new Date() }), 'reconferir'); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/recebimento/:id/chat', (req, res) => { const nome = req.session.user?.nome || 'CENTRAL'; try { const c = recebimento.obter(req.params.id); const m = recebimento.mensagem(req.params.id, { de: 'central', nome, texto: req.body.texto, cod: req.body.cod, acao: req.body.acao }); logC({ tipo: 'chat', loja: c.loja, nome, nfe: c.nNota, cod: m.cod, msg: [m.acao, m.texto].filter(Boolean).join(': ') }); res.json(m); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/recebimento/:id/reenviar-erp', async (req, res) => { const c = recebimento.obter(req.params.id); if (!c) return res.status(404).json({ error: 'não encontrada' });
  const pend = c.erp.erros.splice(0); let ok = 0; for (const p of pend) { const r = await espelhoErp(c, { motivo: 'Reenvio ' + p.tipo + ' ' + c.id, passos: p.passos }, p.tipo); if (r) ok++; } res.json({ reenviados: ok, erros: c.erp.erros.length }); });
```
`lib/modulos.js`: módulo `fiscal` (localizar o id existente que contém a página `fiscal`) `apis` += `'recebimento'`; página `recebimento` fica **fora** do mapa (pública por token, como `contagem`).

- [ ] **Step 4:** subir local (`DB_HOST` de leitura como está; `dbTeste` 127.0.0.1 só existe no `.254` — local o espelho vai cair em `erp.erros`, esperado) e testar com `curl`: entrar → notas → abrir → bipar → terminei. `node --test test/` PASS.
- [ ] **Step 5:** commit `"Recebimento: rotas públicas do coletor, internas do fiscal, espelho no ERP de teste e LOG Coletor"`

---

### Task 6: `public/recebimento.html` — PWA do coletor

**Files:** Create `public/recebimento.html`, `public/manifest-recebimento.json`; Modify `public/sw.js` só se ele tiver lista de rotas a cachear (adicionar `/recebimento.html`).

**Interfaces:** Consumes todas as rotas `/api/recebimento-publico/*` da Task 5. Referência visual: artifact (4 telas). Tokens do `design-system.css`.

- [ ] **Step 1: esqueleto e login.** Copiar a estrutura de `public/contagem.html` (manifest, meta viewport, localStorage `rec_sessao = {loja, token, nome}`, fila offline). Tela 1: botões das lojas 1–6, PIN (inputmode numeric), nome; `POST /entrar`; salvar sessão.
- [ ] **Step 2: tela Notas.** `GET /notas?t=`; seções "Pode conferir" (veredito `liberada`) e "Atenção" (`divergente` com texto "Central já sabe o motivo. Confira normal." e `sem_pedido` com "Nenhum pedido. Confira e a central decide."); pills verde/vermelho/âmbar; **sem** itens/valor. Toque → `POST /abrir` → tela Bipagem. Atualiza a cada 60 s.
- [ ] **Step 3: tela Bipagem (cega).** Campo `#bip` sempre com foco (refocar em `blur` após 100 ms, exceto quando o cartão está aberto). `keydown Enter` no `#bip`: `GET /cadastro/:cod`; se 404 → toast vermelho "Produto não cadastrado. Chame a central."; senão abre cartão com **Quant** (foco, `inputmode=decimal`), **Emb** (preenchida com `qtdemb`), **Validade** (`type=date`), linha "Total · N un" recalculada a cada tecla e a dica "Tanto faz digitar 10 × 24 ou 240 × 1.". Enter avança Quant→Emb→Validade→`POST /bipar` e volta o foco pro `#bip`. Se o código já está na lista, não abre cartão: `POST /bipar {quant:1, emb: item.emb}` direto (soma 1 volume) e toast "descrição · N × emb = un". Lista: só itens bipados, mais recente em cima, `un` grande e `quant × emb` pequeno; estado: `ok` cinza, `recusado`/`bloqueado_validade`/`avaria` vermelho com texto, `nao_esta_na_nota` âmbar. Cabeçalho "Você bipou N produtos · M unidades". Botões: **Corrigir qtd** (escolhe item da lista → cartão preenchido → `POST /corrigir`), **Chamar central** (Task 7), **Terminei a nota**.
- [ ] **Step 4: tela Terminei.** `POST /terminei`: se `bateu` → tela verde "Tudo certo, enviado pra central liberar" + botão Voltar às notas. Senão: aviso "N produtos não bateram com a nota. Reconte só esses." + lista com pills `recontar` / `não bipado` / `não está na nota` (sem quantidade); botões **Recontar** (volta à bipagem) e, quando `podeEnviar`, **Recontei, está assim mesmo · enviar pra central** (`POST /enviar`). Cartão "Devolução" só aparece depois de `terminada` com `GET /conferencia/:id` (o servidor **não** inclui devoluções na visão da loja antes de terminar — manter cego).
- [ ] **Step 5: offline.** Fila em localStorage `rec_fila` com os POSTs de bipar/corrigir; reenvio em ordem ao voltar rede; indicador "N bipes aguardando rede" no cabeçalho.
- [ ] **Step 6:** testar no navegador desktop (Chrome, largura 360) o fluxo completo contra o servidor local; conferir que nenhuma resposta pública contém quantidades da nota (aba Network).
- [ ] **Step 7:** commit `"Recebimento: PWA do coletor (login por PIN, notas com veredito, bipagem cega Quant/Emb/Validade, terminei/recontagem)"`

---

### Task 7: Chat interno preso à nota (coletor + Fiscal)

**Files:** Modify `public/recebimento.html`, `public/fiscal.html`

- [ ] **Step 1 (coletor):** botão "Chamar central" abre painel na própria nota: motivos em botões (`codigo_nao_cadastrado`, `avaria`, `validade`, `nao_esta_na_nota`, `outro`), último produto bipado anexado (`cod`), campo texto opcional → `POST /chat`. Enquanto a nota está aberta, `GET /conferencia/:id` a cada 5 s; mensagens novas de `central` viram badge no botão e toast; se `acao` mudou estado de item, a lista re-renderiza.
- [ ] **Step 2 (fiscal):** em `public/fiscal.html`, na aba Recebimentos, buscar `GET /api/recebimento?data=` junto da listagem atual e mesclar por chave da NF-e/nReg; coluna "Coletor Econômico" com status (`bipando / recontando / terminada / liberada`), badge vermelho "N chamados" (mensagens de `loja` sem resposta `central` depois delas) e som curto (`new Audio(dataURI beep)`) quando o número sobe entre polls (15 s). Painel lateral do chat: histórico + botões **Pode receber / Devolver / Liberar validade / Aguarde** (+ texto) → `POST /api/recebimento/:id/chat {acao, cod, texto}`.
- [ ] **Step 3:** testar ida e volta com dois navegadores (coletor e fiscal). Commit `"Recebimento: chat interno preso à nota (coletor ↔ Fiscal)"`

---

### Task 8: Fiscal — Liberar / Reconferir gravando no ERP de teste, devoluções e PDF

**Files:** Modify `public/fiscal.html`, `lib/fiscal.js` (mesclar fonte nossa), `lib/pedidos-fornecedor.js` (`gerarPdfDevolucao` aceita lista com origem)

- [ ] **Step 1:** em `lib/fiscal.js` `listar()`, depois de `cruzar`, anexar `r.economico = recebimento.listarDia(...)` casado por `chaves` (passar `recebimento` via `init(q, deps)` → `deps.recebimento`), com `status`, `recontagens`, `devolucoes` (3 origens), `erp.erros`. Teste: `test/fiscal-recebimento.test.js` chamando a função de mescla pura com uma conferência falsa.
- [ ] **Step 2:** `public/fiscal.html`: no detalhe da nota, seção "Coletor Econômico": itens bipados (quant × emb = un, validade, estado), tabela "Devolução" com coluna Origem (Compras / Coletor / Falta), botões no topo **Liberar** (habilitado só com `status='terminada'`; confirma; `POST /api/recebimento/:id/liberar`; mostra nº do Log ERP ou erro + botão **Reenviar pro ERP**), **Reconferir**, **PDF Aviso de devolução**. Trocar o texto do cabeçalho "Nada é gravado no ERP." por "Liberar grava no ERP de teste (.254), com Log."
- [ ] **Step 3:** `gerarPdfDevolucao(p, ln, usuario, extras)` → aceitar `extras = { itens: devolucoes[], nota, loja, motorista: true }`; linhas com origem; nas de `falta` texto "não veio (o motorista assina reconhecendo)". Rota `GET /api/recebimento/:id/devolucao/pdf`.
- [ ] **Step 4:** `node --test test/` PASS; testar liberar no local (espelho cai em erro, esperado) e depois no `.254` (Task 9). Commit `"Fiscal: coletor Econômico na tela, Liberar/Reconferir gravando no ERP de teste, PDF de devolução com 3 origens"`

---

### Task 9: Deploy no `.254`, validação real e memória

- [ ] **Step 1:** `git push origin main` + `GET .../deploy?token=fc360deploy2026`; aguardar ~10 s; `GET /api/versao`.
- [ ] **Step 2:** no `.254` (SSH Tailscale `ssh -i ~/.ssh/claude_254 claude-ssh@100.102.231.28`), conferir colunas de `central.itens` usadas em `cadastroItem` e ajustar se preciso. Ler PINs em `data/recebimento-config.json` e passar pro Tiago.
- [ ] **Step 3:** teste ponta a ponta com uma NF-e real de hoje numa loja: abrir → bipar 2 itens → terminei → liberar no Fiscal. Conferir no MySQL de teste: `SELECT * FROM central.conferencia WHERE Obs LIKE 'Economico %' ORDER BY nReg DESC LIMIT 1`, `conferenciachave`, `conferenciaitens`, `conferenciadevolucao`. Conferir aba **LOG Coletor** e o Log ERP ligados.
- [ ] **Step 4:** pedir ao Tiago: modelo do coletor e teste no aparelho (leitor como teclado); apontar um Dlinks pro `.254` e ver se a conferência aparece na tela deles e se o CPD consegue dar entrada.
- [ ] **Step 5:** atualizar `memory/project_economico-coletor-recebimento.md` (estado, PINs entregues, pendências) e commit final.

---

## Self-review

- **Cobertura da spec:** §4.1–4.4 → Tasks 2, 3, 6; §5 → Task 8; §6 → Task 7; §7 → Tasks 4, 5; §8 → todas; §8b LOG Coletor → Task 1; §9 config → Tasks 2, 5; §10 riscos → Task 9. `modo_cega:'quantidade'` fica só como config (sem UI) nesta versão — YAGNI, spec diz "opcional".
- **Consistência de nomes:** `recebimento.{abrirNota,bipar,corrigir,terminei,enviarAssimMesmo,devolucoes,mensagem,liberar,reconferir,visaoLoja,listarDia,obter,salvar,config,setConfig,lojaPorPin,lojaPorToken,hojeStr}`; `recebErp.{passosAbrir,passosItem,passosStatus,passosLiberar}`; `logColetor.{registrar,ler,csv,TIPOS}`; estados de item `ok|recusado|bloqueado_validade|nao_esta_na_nota|avaria`; status da conferência `bipando|recontando|terminada|liberada`.
- **Pontos a confirmar no código real antes de executar** (marcados nos passos): colunas de `central.itens`; retorno de `escreverERP.lote` (`id`, `ids_gerados`); id do módulo `fiscal` em `lib/modulos.js`; se `log-erp.js` exporta `novoId`/`agoraIso`.
