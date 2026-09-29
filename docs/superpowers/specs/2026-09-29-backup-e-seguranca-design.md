# Backup e segurança do Econômico Relatórios — design

Data: 2026-09-29. Servidor: `.254` (Servidor_BI, Windows 11), app em `C:\fc360\claude_code_`, serviço NSSM na porta 3003.

## Problema

O código está no GitHub, mas **todo o estado do sistema fica só no disco C: do .254, sem nenhuma cópia**:
`data/` (~150 MB de JSON: contagens, cotações, precificação, sugestões manuais, pedidos CD/fornecedor,
conciliações, regras, log do ERP, DRE, metas, expedição, recebimento), `usuarios.json`, pareamento dos dois
WhatsApp (`negativos-wpp/`, `cahu-wpp/`), certificado/config do Itaú (`data/itau/`), `.env` + service account
do Firebase (`C:\fc360\etiquetas-api`), `Caddyfile` e os `.caddy` do CAHU. Um HD queimado ou um ransomware
zera tudo isso.

Achados de segurança (registrados, **sem ação por decisão do Tiago em 29/09**):
- repositório `fc360oficial/economicorelatorios` é público e o token do `/deploy` está no `server.js`;
- portas 3003 (app sem HTTPS), 3000 (API CAHU) e 3306 (MySQL) parecem redirecionadas no MikroTik
  (teste feito de dentro da LAN da CAHU; confirmar nas regras de NAT do roteador antes de fechar).

## Objetivo

Backup diário automático, com cópia fora do prédio, e um roteiro de restauração testado. Sem depender de
tarefa agendada do Windows (a conta `claude-ssh` não é admin) e sem novas ferramentas que exijam instalação
como administrador.

## Desenho

### 1. `lib/backup.js` — rotina dentro do server.js (mesmo padrão de `sortimento.agendar()`)

- Roda **todo dia às 04:00** (checagem a cada minuto) e também 5 min após o boot se ainda não houver
  backup do dia. Endpoint `POST /api/backup/executar` (perfil admin) pra rodar na hora.
- Gera `D:\backups\economico\economico-AAAA-MM-DD.zip` usando o `tar.exe` nativo do Windows
  (`tar -a -cf x.zip ...`, formato zip). Conteúdo:
  - `C:\fc360\claude_code_\data\` inteira (menos `sessions/`, `xml-teste/`, `promocoes-pdf/`);
  - `usuarios.json`, `Caddyfile`, `negativos-wpp\` (só auth + json, sem node_modules), `cahu-wpp\` (idem);
  - `C:\fc360\etiquetas-api\.env.etiquetas-api` e `firebase-service-account.json`;
  - `C:\cahudelivery\infra\caddy\*.caddy`;
  - `C:\fc360\data\` (radar-hist24, listas vistas);
  - `RESTAURAR.md` (cópia de `docs/RESTAURAR.md`).
- Lista de caminhos fica em `data/backup-config.json` (gitignored, criado com default no 1º boot), pra
  incluir coisa nova sem deploy.
- Retenção local: apaga zips com mais de 30 dias. Se `D:` não existir, usa `C:\fc360\backups`.
- Grava `data/backup-estado.json` com último resultado (hora, tamanho, erro). Tela **Processos › Backup**
  (`public/backup.html`, módulo `backup` no `lib/modulos.js`, admin) mostra os últimos 30 dias, botão
  "Fazer backup agora" e status do envio pra nuvem.
- Falha 2 dias seguidos → aviso no cabeçalho do admin (mesmo toast usado por "sistema atualizado").

### 2. Cópia na nuvem — Google Drive via rclone (modo `crypt`)

- `rclone.exe` baixado pra `C:\fc360\tools\rclone\` (binário único, sem instalação, sem admin).
- Remote `gdrive` (conta `processosredeeconomico@gmail.com`) + remote `gdrive-crypt` por cima, pasta
  `Backups/EconomicoRelatorios`. O arquivo sobe **criptografado**, senha só no `rclone.conf` do servidor
  (`C:\fc360\tools\rclone\rclone.conf`, ACL só do usuário do serviço) e no cofre do Tiago.
- Autorização: **um clique do Tiago** (`rclone authorize "drive"` no PC dele gera o token, eu copio pro
  servidor por scp). Até isso acontecer, o backup local já roda e a tela mostra "nuvem: não configurada".
- Após gerar o zip: `rclone copy zip gdrive-crypt:` + `rclone delete --min-age 30d`. Sucesso/erro vai pro
  `backup-estado.json`.

### 3. `docs/RESTAURAR.md` — roteiro de restauração

Passo a passo pra subir do zero num Windows limpo: Node + Git + NSSM + Caddy, `git clone`, descompactar o
zip do dia sobre a pasta, `npm ci`, variáveis do NSSM, serviços, DDNS. **Teste real** uma vez: restaurar
numa pasta separada (`C:\fc360\restore-teste`) e subir na porta 3999, conferir login e uma tela com dados.

### Fora de escopo (fase 2/3, decisão depois)

Repo privado + token do deploy em variável de ambiente; fechar 3000/3003/3306 no MikroTik; monitor externo
(UptimeRobot); migrar JSON pra PostgreSQL.

## Erros e limites

- `tar.exe` falhando ou D: cheio → erro registrado, tenta de novo em 1 h (máx. 3×), nunca derruba o app.
- Zip do dia é gerado num `.tmp` e renomeado no fim, pra nunca deixar zip pela metade.
- Backup roda enquanto o app escreve JSON: risco pequeno de um arquivo pego no meio da escrita. Aceitável
  porque as rotinas gravam por `writeFileSync` inteiro; o zip seguinte corrige.

## Testes

- `test/backup.test.js`: monta pasta temporária com arquivos de exemplo, roda `executar()`, confere zip
  criado, conteúdo esperado, exclusões respeitadas, retenção (arquivo velho apagado) e estado gravado.
- Envio à nuvem testado manualmente após autorização (arquivo aparece no Drive; `rclone lsl`).
