# Processos > Log de mudanças (MySQL de teste .254) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma única função de escrita no MySQL de teste do .254 que registra antes/depois de toda mudança, e uma aba Processos > Log que mostra tudo.

**Architecture:** `lib/log-erp.js` (puro: montagem de SQL, diff, arquivo JSONL por mês) + `lib/escrever-erp.js` (transação: select-antes → executa → select-depois → log; conexão injetável pra teste) + rotas em `server.js` + `public/log.html`. Leitura do ERP continua em `q()`/.252; escrita só via `escreverERP` em `dbTeste` (127.0.0.1 no .254).

**Tech Stack:** Node 24, Express 5, mysql2/promise, node:test, design-system.css do app.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-23-log-mudancas-erp-design.md`.
- Escrita NUNCA no `192.168.2.252`: `escreverERP` recusa esse host sem variável de liberação.
- Log em `data/log-erp/AAAA-MM.jsonl`, append-only, nunca editado/apagado pela interface.
- Nomes de banco/tabela/coluna só `[A-Za-z0-9_]`. `limite` padrão 500 linhas.
- Botões de ação em cima da tabela; cores só do design-system (navy+âmbar); tag "Teste .254" azul.
- Testes: `node --test test/`.

---

### Task 1: `lib/log-erp.js` — SQL, diff e arquivo JSONL

**Files:** Create `lib/log-erp.js`, `test/log-erp.test.js`.

**Produces:** `nomeValido(s)`, `montarSql({banco,tabela,operacao,where,valores})→{sql,params,sqlSelect,paramsSelect}`, `diff(antes,depois)→[colunas]`, `novoId(date)`, `gravar(dir,entrada)`, `ler(dir,{de,ate,tabela,usuario,status,limite})→{itens,linhas_invalidas}`, `porId(dir,id)`, `csv(itens)`.

- [ ] Escrever `test/log-erp.test.js` cobrindo: nome inválido recusado; update/insert/delete geram SQL com placeholders e SELECT correspondente; update sem where lança; diff acha colunas mudadas; gravar+ler em pasta temporária (2 meses), filtro por tabela/status, linha corrompida contada em `linhas_invalidas`; csv com BOM e `;`.
- [ ] Rodar `node --test test/log-erp.test.js` → falha (módulo inexistente).
- [ ] Implementar `lib/log-erp.js` (código na Task 1 do arquivo — ver commit).
- [ ] Rodar → passa. Commit `feat(log-erp): módulo puro de SQL/diff/arquivo`.

### Task 2: `lib/escrever-erp.js` — transação com log

**Files:** Create `lib/escrever-erp.js`, `test/escrever-erp.test.js`.

**Consumes:** Task 1. **Produces:** `criarEscreverERP({config, criarConexao, dirLog, agora})→ async escreverERP(opcoes)→{ok,afetados,id,status,erro?}`.

- [ ] Testes com conexão fake (`query` grava chamadas e devolve linhas): fluxo ok grava entrada `ok` com antes/depois/afetados; erro no UPDATE faz ROLLBACK e entrada `erro`; host `.252` → recusado sem abrir conexão; `count > limite` → recusado; motivo curto → recusado; usuário ausente → recusado.
- [ ] Rodar → falha. Implementar. Rodar → passa. Commit `feat(log-erp): escreverERP com transação, antes/depois e log`.

### Task 3: rotas + módulo + nav

**Files:** Modify `server.js` (após `q()`), `lib/modulos.js:25`, `public/nav.js:92-95`, `test/modulos.test.js`.

- [ ] `modulos.js`: processos ganha página `log` e api `log-erp`; teste em `modulos.test.js` (`moduloDaRota('/log.html')==='processos'`, `/api/log-erp/x`).
- [ ] `server.js`: `dbTeste`, `escreverERP = criarEscreverERP({...})`, rotas `POST /api/log-erp/executar`, `GET /api/log-erp`, `GET /api/log-erp/csv`, `GET /api/log-erp/:id`.
- [ ] `nav.js`: `{ href: '/log.html', ic: 'list', txt: 'Log' }` abaixo de Negativos.
- [ ] `node --check server.js`, `node --test test/` → passa. Commit.

### Task 4: `public/log.html`

- [ ] Página com `page-hdr` (título, período, filtros, botões Atualizar/Exportar CSV em cima), tabela, painel de detalhe (antes/depois lado a lado, colunas mudadas em âmbar, SQL), vazio, mobile. Commit.

### Task 5: deploy e teste real no .254

- [ ] Push + webhook de deploy. `POST /api/log-erp/executar` mudando `Qtd` de 1 item em `central.estoquen1` (motivo "teste do log"); conferir tela; `SELECT` no `.252` prova que nada mudou lá; reverter pelo mesmo caminho (fica 2 linhas no log).
