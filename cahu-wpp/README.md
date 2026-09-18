# cahu-wpp — bot do número "Central Rede Cahu"

Processo separado do `negativos-wpp` (número antigo). Só recebe pedidos do `server.js` em `127.0.0.1:3011`
e manda pro grupo dos vendedores da CAHU. Quem agenda (07:00 tabela, 09/12/15/18 checagens) é `lib/cahu-tabela-wpp.js`.

## Instalar no .254 (uma vez)
```powershell
cd C:\fc360\economico-relatorios-app\cahu-wpp     # ou a pasta onde o app roda
npm install
copy config.exemplo.json config.json              # preencher numero (chip novo), grupo (nome exato), alerta (Tiago)
node index.js                                     # 1ª vez na mão: mostra o CÓDIGO DE PAREAMENTO no console
```
No celular reserva: WhatsApp Business > Dispositivos conectados > Conectar dispositivo > **Conectar com número de telefone** > digitar o código.
Quando aparecer "WhatsApp conectado", Ctrl+C e instalar como serviço:
```powershell
nssm install CahuWpp "C:\Program Files\nodejs\node.exe" "index.js"
nssm set CahuWpp AppDirectory C:\fc360\economico-relatorios-app\cahu-wpp
nssm set CahuWpp AppStdout C:\fc360\logs\cahu-wpp.log
nssm set CahuWpp AppStderr C:\fc360\logs\cahu-wpp.log
nssm start CahuWpp
```

## Testar sem esperar as 07:00
Na página CAHU Distribuidora > Tabela de Preços há o painel "Envio automático no WhatsApp" com "Enviar tabela agora" e "Checar agora".
Ou: `curl -X POST http://127.0.0.1:3011/mensagem-grupo -H "Content-Type: application/json" -d "{\"texto\":\"teste\"}"`.

## Se o número cair (loggedOut)
Apagar a pasta `auth_info`, reiniciar o serviço, olhar o log pra pegar o código novo. Nunca parear por QR.
