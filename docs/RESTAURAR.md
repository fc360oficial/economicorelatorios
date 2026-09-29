# Como restaurar o Econômico Relatórios do zero

Roteiro pra quando o servidor `.254` (Servidor_BI) morrer, for trocado ou precisar ser reinstalado.
Tempo estimado: 1 a 2 horas. Precisa de: acesso de Administrador no Windows novo, a conta do GitHub
`fc360oficial`, e o zip de backup mais recente (ver passo 3).

## O que está onde

| O quê | Onde fica | Como volta |
|---|---|---|
| Código do sistema | GitHub `fc360oficial/economicorelatorios` | `git clone` |
| Dados (data/), usuários, WhatsApp, Itaú, Caddy, Firebase das etiquetas | zip diário `economico-AAAA-MM-DD.zip` | extrair o zip (passo 4) |
| Dados do ERP (vendas, estoque, cadastro) | MySQL do `.252`, responsabilidade do Dlinks | não faz parte deste backup |

O zip diário fica em dois lugares:
- `D:\backups\economico\` no próprio servidor (30 dias);
- Google Drive da conta `processosredeeconomico@gmail.com`, pasta `Backups/EconomicoRelatorios`, **criptografado
  com rclone crypt** (30 dias). Sem a senha do crypt o arquivo do Drive não abre. A senha está no cofre de senhas
  do Tiago, item "rclone crypt Econômico". Sem ela, use o zip do D:.

## 1. Programas no Windows novo

Rodar no PowerShell como Administrador:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e        # Node 22+ (produção roda 24)
winget install --id CaddyServer.Caddy -e
winget install --id NSSM.NSSM -e
```

Confirmar: `git --version`, `node --version`, `caddy version`, `nssm --version`.

## 2. Código

```powershell
mkdir C:\fc360
git clone https://github.com/fc360oficial/economicorelatorios.git C:\fc360\claude_code_
cd C:\fc360\claude_code_
npm ci
```

## 3. Pegar o zip de backup

Do servidor antigo (se o disco D: sobreviveu): copiar `D:\backups\economico\economico-<data>.zip`.

Do Google Drive (se o servidor sumiu):

```powershell
# baixar rclone: https://rclone.org/downloads/ (zip, sem instalar), extrair em C:\fc360\tools\rclone
# criar o rclone.conf de novo: rclone config → remote "gdrive" (type drive, logar com processosredeeconomico)
#                              → remote "gdrive-crypt" (type crypt, remote gdrive:Backups/EconomicoRelatorios, senha do cofre)
C:\fc360\tools\rclone\rclone.exe --config C:\fc360\tools\rclone\rclone.conf lsl gdrive-crypt:
C:\fc360\tools\rclone\rclone.exe --config C:\fc360\tools\rclone\rclone.conf copy gdrive-crypt:economico-<data>.zip C:\fc360\restore\
```

## 4. Extrair o zip por cima do código

O zip guarda os caminhos relativos à pasta do app. O `tar.exe` já vem no Windows:

```powershell
cd C:\fc360\claude_code_
tar -xf C:\fc360\restore\economico-<data>.zip
```

Isso recria `data\`, `usuarios.json`, `Caddyfile`, `negativos-wpp\auth`, `cahu-wpp\auth_info` e configs.
Alguns itens do zip vêm de fora do app e precisam voltar pro lugar de origem:

| No zip | Copiar para |
|---|---|
| `.env.etiquetas-api`, `firebase-service-account.json` | `C:\fc360\etiquetas-api\` |
| `caddy\*.caddy` | `C:\cahudelivery\infra\caddy\` (CAHU Delivery) |
| `data\radar-hist24.json`, `data\radar-listas-vistas.json` (do `C:\fc360\data`) | `C:\fc360\data\` |

Conferir: `dir data` deve mostrar dezenas de JSON, `usuarios.json` deve existir.

## 5. Serviço do sistema (NSSM, porta 3003)

```powershell
nssm install EconomicoRelatorios "C:\Program Files\nodejs\node.exe" "C:\fc360\claude_code_\server.js"
nssm set EconomicoRelatorios AppDirectory C:\fc360\claude_code_
nssm set EconomicoRelatorios AppStdout C:\fc360\claude_code_\server-out.log
nssm set EconomicoRelatorios AppStderr C:\fc360\claude_code_\server-err.log
nssm set EconomicoRelatorios AppEnvironmentExtra DB_HOST=192.168.2.252 DB_TESTE_HOST=127.0.0.1 PUBLIC_URL=https://hhk0a8gt2cn.sn.mynetname.net
nssm start EconomicoRelatorios
```

Variáveis que o `server.js` lê: `DB_HOST` (MySQL do ERP), `DB_TESTE_HOST` (MySQL de teste local),
`PUBLIC_URL` (links públicos), `ERP_WRITE_OK` (só em teste). Conferir com `nssm dump <serviço>` no servidor
antigo se ele ainda existir, e copiar os valores exatos.

Teste: `curl http://localhost:3003/api/versao` responde `{"versao":...}`.

## 6. HTTPS (Caddy) e DNS

```powershell
nssm install Caddy "C:\Program Files\Caddy\caddy.exe" "run --config C:\fc360\claude_code_\Caddyfile"
nssm start Caddy
```

O `Caddyfile` já veio no zip. O domínio `hhk0a8gt2cn.sn.mynetname.net` é o DDNS do MikroTik (Winbox → IP →
Cloud), que aponta pro IP público da central. No roteador, as regras de NAT precisam mandar as portas 80 e 443
pro IP do servidor novo. Só 80 e 443. Nunca abrir 3003, 3306 ou 3389 pra internet.

## 7. Validar

1. Abrir `https://hhk0a8gt2cn.sn.mynetname.net/login.html` e logar com um usuário de verdade (os hashes vieram
   no `usuarios.json`).
2. Processos › Negativos: contagens antigas aparecem.
3. Processos › Log: histórico do ERP aparece.
4. Processos › Backup: clicar "Fazer backup agora" e ver o zip novo em `D:\backups\economico`.
5. Bots WhatsApp (`negativos-wpp`, `cahu-wpp`): se o pareamento não voltar sozinho (o WhatsApp às vezes derruba
   sessão restaurada), parear de novo pelo código de telefone. Nunca por QR.

## 8. Reativar o backup pro Drive no servidor novo

Recriar `C:\fc360\tools\rclone\rclone.conf` como no passo 3 (mesmos nomes `gdrive` e `gdrive-crypt`, mesma
senha do cofre). O sistema detecta o arquivo sozinho e volta a enviar às 04:00. Conferir na tela Processos ›
Backup o card "Google Drive: Enviado".

## Pendências de segurança conhecidas (decisão do Tiago, 29/09/2026)

- O repositório do GitHub é público e o token da rota `/deploy` está no `server.js`. Tornar privado e mover o
  token pra variável de ambiente quando decidir.
- As portas 3003, 3000 e 3306 aparecem abertas na internet pelo roteador. Fechar quando decidir (confirmar no
  MikroTik antes; o Dlinks pode depender da 3306).
