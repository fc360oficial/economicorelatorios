# Backup diário + Google Drive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zip diário (04:00) do estado do Econômico Relatórios em `D:\backups\economico`, com cópia criptografada no Google Drive via rclone, tela admin em Processos › Backup e roteiro de restauração testado.

**Architecture:** Módulo `lib/backup.js` (sem dependência nova) agendado pelo `server.js` no mesmo padrão de `sortimento.agendar()`. Zip gerado com o `tar.exe` nativo do Windows (`--format=zip`), listas de caminhos em `data/backup-config.json`, estado em `data/backup-estado.json`. Envio à nuvem é uma etapa opcional que só roda se `C:\fc360\tools\rclone\rclone.conf` existir.

**Tech Stack:** Node 24, `node:test`, `child_process.execFile`, tar.exe (Windows 11), rclone (binário único).

## Global Constraints

- Nenhum pacote npm novo. Nenhuma tarefa agendada do Windows (claude-ssh não é admin).
- Nunca derrubar o app por erro de backup: toda falha vira `estado.erro` + `console.error('[BACKUP]', ...)`.
- Não commitar `data/backup-config.json` nem `data/backup-estado.json` (gitignore).
- Testes: `node --test test/backup.test.js`.
- Spec: `docs/superpowers/specs/2026-09-29-backup-e-seguranca-design.md`.

---

### Task 1: `lib/backup.js` — gerar zip, retenção, estado

**Files:**
- Create: `lib/backup.js`
- Create: `test/backup.test.js`
- Modify: `.gitignore` (adicionar `data/backup-config.json`, `data/backup-estado.json`)

**Interfaces:**
- Produces: `init({ appDir, dataDir, configPath, estadoPath, execFileFn?, destinoDefault? })`, `executar({ motivo }) → Promise<estado>`, `estado() → { ultimo, historico[≤30] }`, `configAtual()`, `agendar()`, `alerta()`.
- `execFileFn(cmd, args, opts) → Promise<{stdout, stderr}>` injetável (default `util.promisify(child_process.execFile)`), usado pelo tar e pelo rclone.

- [ ] **Step 1: Teste que falha** (`test/backup.test.js`): 3 casos — (a) `executar` gera zip no destino, passa `--exclude=data/sessions` e `usuarios.json` ao tar, não passa caminho inexistente, cria `backup-config.json` default, grava estado com 1 item no histórico; (b) retenção apaga zip com mtime > 30 dias e mantém o novo; (c) erro do tar vira `ultimo.erro` sem lançar e sem `.tmp` sobrando. Usa `execFileFn` falso que registra chamadas e cria o arquivo de saída.
- [ ] **Step 2:** `node --test test/backup.test.js` → FAIL (`Cannot find module '../lib/backup'`).
- [ ] **Step 3: Implementação** `lib/backup.js`: `configDefault()` com `destino`, `itens` (data, usuarios.json, Caddyfile, negativos-wpp/auth, negativos-wpp/pendentes.json, cahu-wpp/auth_info, cahu-wpp/config.json, docs/RESTAURAR.md), `externos` (C:/fc360/etiquetas-api/.env.etiquetas-api, .../firebase-service-account.json, C:/cahudelivery/infra/caddy, C:/fc360/data), `excluir` (data/sessions, data/xml-teste, data/promocoes-pdf), `rclone` {exe, conf, remoto}. `destinoReal` cai pra `<appDir>/../backups` se D: não gravável. Nome `economico-AAAA-MM-DD.zip` (sufixo `-HHMM` se já existe). `gerarZip` = tar `--format=zip -cf x.zip.tmp -C appDir --exclude=... itens... -C dir base` por externo, rename no fim, unlink do tmp em erro. `retencao` apaga `economico-*.zip` com mtime > 30 d. `enviarNuvem` só se exe+conf existem: `rclone copy` + `rclone delete --min-age 30d`; retorna `{status:'nao-configurada'|'ok'|'erro'}`. `executar` serializa (uma execução por vez), grava `{inicio,fim,motivo,arquivo,bytes,erro,nuvem}` em `ultimo` e `historico[≤30]`. `agendar`: 5 min pós-boot se ainda não fez hoje; a cada minuto, 04:00 executa; se falhou, tenta de novo na hora cheia até 3×. `alerta()` = 2 últimos com erro.
- [ ] **Step 4:** `node --test test/backup.test.js` → 3 pass.
- [ ] **Step 5:** `.gitignore` += as 2 linhas.
- [ ] **Step 6:** commit `feat(backup): zip diário do estado com tar nativo, retenção 30d e estado`.

### Task 2: server.js + módulo + tela Processos › Backup

**Files:**
- Modify: `server.js` (após `sortimento.agendar()`; endpoints com `requireAdmin`)
- Modify: `lib/modulos.js` (módulo `processos`: página `backup`, api `backup`)
- Modify: `public/nav.js` bloco Processos (ordem alfabética: Backup, Log, Negativos, Pendências)
- Create: `public/backup.html`

**Interfaces:**
- `GET /api/backup` → `{ ...estado(), alerta, config: { destino, itens, externos, excluir, nuvem: 'configurada'|'nao-configurada' } }` (admin)
- `POST /api/backup/executar` → `estado()` após rodar (admin)

- [ ] **Step 1:** server.js: `require('./lib/backup')`, `init` com paths do app, `agendar()`, os 2 endpoints.
- [ ] **Step 2:** modulos.js: `processos.paginas` += `backup`, `processos.apis` += `backup`. `node --test test/` continua verde.
- [ ] **Step 3:** nav.js: `{ href: '/backup.html', ic: 'shield', txt: 'Backup' }` como 1º item de Processos.
- [ ] **Step 4:** `public/backup.html` no mesmo head/estilo de `log.html`: cabeçalho + botão primário "Fazer backup agora" (em cima), faixa vermelha se `alerta`, cards Último backup (data, MB, destino, nuvem) e tabela dos 30 últimos (início, motivo, arquivo, MB, nuvem, erro). POST no clique com botão desabilitado e `#status` "Gerando…".
- [ ] **Step 5:** rodar local, login admin, `/backup.html`, clicar, conferir zip com `tar -tf`.
- [ ] **Step 6:** commit `feat(backup): tela Processos › Backup, endpoints admin e agendamento 04:00`.

### Task 3: rclone + Google Drive (crypt) — só no servidor

- [ ] **Step 1:** no `.254`: `C:\fc360\tools\rclone\` com `rclone.exe` baixado de `https://downloads.rclone.org/rclone-current-windows-amd64.zip` (curl + tar -xf).
- [ ] **Step 2:** no PC do Tiago: `rclone authorize "drive"` → Tiago loga com `processosredeeconomico@gmail.com` → token.
- [ ] **Step 3:** `rclone.conf` no servidor: `[gdrive]` type drive, scope drive, token; `[gdrive-crypt]` type crypt, remote `gdrive:Backups/EconomicoRelatorios`, password/password2 via `rclone obscure`. ACL restrita com `icacls`. Senha do crypt vai pro cofre do Tiago (não pro repo).
- [ ] **Step 4:** `rclone lsd gdrive-crypt:` ok → `POST /api/backup/executar` → `nuvem.status === 'ok'` e arquivo em `rclone lsl gdrive-crypt:`.

### Task 4: `docs/RESTAURAR.md` + teste de restauração

- [ ] **Step 1:** roteiro: pré-requisitos (Git, Node 24, NSSM, Caddy via winget); `git clone` do repo; `npm ci`; pegar zip (Drive via rclone ou `D:\backups\economico`) e `tar -xf` sobre a pasta do app + externos; serviço NSSM porta 3003 com variáveis; Caddy + DDNS; validar login/Negativos/Log; onde estão a senha do crypt e o token de deploy.
- [ ] **Step 2:** teste real no `.254`: `C:\fc360\restore-teste` = clone + extrair zip mais recente + subir em outra porta → `/api/versao` 200 e login com usuário restaurado. Apagar a pasta.
- [ ] **Step 3:** commit `docs: roteiro RESTAURAR.md`.

### Task 5: deploy e verificação em produção

- [ ] `git push origin main` + `/deploy`.
- [ ] `/api/versao`; login admin; `/backup.html`; "Fazer backup agora" → zip em `D:\backups\economico` conferido por SSH (`tar -tf`, tamanho).
- [ ] Dia seguinte 04:0x: `backup-estado.json` com `motivo: agendado` sem erro.
- [ ] Memória: nova entrada `project_economico-backup.md` + linha no MEMORY.md.
