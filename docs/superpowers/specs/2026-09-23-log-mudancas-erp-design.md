# Processos > Log — registro de toda mudança feita no MySQL de teste (.254)

**Data:** 2026-09-23
**Decisão do Tiago:** toda mudança de teste (estoque etc.) acontece SÓ no MySQL de teste do `.254`
(cópia do ERP, snapshot 17/09). Nada é escrito no `.252`. Antes de qualquer mudança, precisa
existir uma aba **Log** em Processos mostrando tudo que foi feito: hora, o quê, tabela, valores.

## 1. Regras de escrita

- **Leitura** continua como hoje: função `q()` contra `dbConfig` (`.252`, somente leitura, trava já em produção).
- **Escrita** só por uma função nova, `escreverERP()`, que conecta em `dbTeste`:
  `host = process.env.DB_TESTE_HOST || '127.0.0.1'`, porta 3306, `root`/`1900`, timeout 15 s.
  Se `dbTeste.host` for `192.168.2.252`, a função recusa sempre (sem variável de liberação). Nada de `.252`.
- Nenhuma rota chama `INSERT/UPDATE/DELETE` direto: quem escreve passa por `escreverERP()`.
  `q()` continua bloqueando escrita no `.252`; a exceção `central.prevencao_bonif` fica como está (não faz parte deste trabalho).
- Só roda de verdade no servidor `.254` (onde o MySQL de teste está em `127.0.0.1`). Na máquina local, sem MySQL em 127.0.0.1, `escreverERP()` falha na conexão e o log registra o erro.

## 2. `escreverERP(opcoes)`

```
escreverERP({
  usuario,   // req.session.user.nome (obrigatório)
  motivo,    // texto livre, obrigatório, mínimo 5 caracteres
  banco,     // ex. 'central'
  tabela,    // ex. 'estoquen1'
  operacao,  // 'update' | 'insert' | 'delete'
  where,     // objeto {coluna: valor} (update/delete: obrigatório, mínimo 1 coluna)
  valores,   // objeto {coluna: valor} (update/insert: obrigatório)
  limite     // opcional, máximo de linhas afetadas (padrão 500); acima disso recusa antes de executar
})
```

Passos, numa única conexão com transação:
1. Valida entrada (campos obrigatórios; nomes de banco/tabela/coluna só `[A-Za-z0-9_]`).
2. `antes` = `SELECT * FROM banco.tabela WHERE ...` (update/delete). Se `count > limite`, recusa e loga como `recusado`.
3. Executa o SQL montado com placeholders (`UPDATE ... SET c=? WHERE c=?`, etc.).
4. `depois` = mesmo SELECT (update) ou SELECT dos inseridos por chave primária quando houver `insertId`/where (insert).
5. `COMMIT`. Em erro: `ROLLBACK` e loga como `erro`.
6. Grava a entrada no log (sempre, inclusive erro/recusa). Retorna `{ok, afetados, id}`.

## 3. Armazenamento do log

- Arquivo por mês: `data/log-erp/AAAA-MM.jsonl` (uma linha JSON por evento, append). Mesmo padrão dos outros dados do app; sobrevive à recópia da pasta `data` do MySQL; entra no backup do app.
- Escrita com `fs.appendFileSync` (append atômico por linha). Nunca reescrito, nunca apagado pela interface.
- Campos de cada linha:

| campo | conteúdo |
|---|---|
| id | `AAAAMMDD-HHMMSS-<4 hex>` |
| quando | ISO local (`2026-09-23T14:05:11-03:00`) |
| usuario | nome do usuário logado |
| servidor | `teste-254` (sempre; gravado mesmo assim pra deixar explícito na tela) |
| host | `dbTeste.host` real usado |
| banco, tabela, operacao | como enviados |
| motivo | texto |
| where, valores | objetos como enviados |
| sql, params | SQL montado + parâmetros |
| afetados | linhas afetadas (`affectedRows`) |
| antes, depois | arrays de registros (limitados a `limite`) |
| status | `ok` / `erro` / `recusado` |
| erro | mensagem, quando houver |
| ms | duração |

## 4. API

- `POST /api/log-erp/executar` — corpo = `opcoes` (menos `usuario`, que vem da sessão). Chama `escreverERP`. É a porta única pra qualquer tela futura de teste; hoje ninguém a chama ainda além de testes manuais.
- `GET /api/log-erp?de=AAAA-MM-DD&ate=AAAA-MM-DD&tabela=&usuario=&status=` — lê os arquivos dos meses do período, filtra, devolve do mais novo pro mais velho (máx. 5000).
- `GET /api/log-erp/:id` — uma entrada completa (antes/depois/SQL).
- `GET /api/log-erp/csv?...` — mesmos filtros, CSV `;` com BOM (Excel BR): quando, usuário, servidor, banco.tabela, operação, afetados, status, motivo.
- Acesso: `lib/modulos.js` — módulo `processos` ganha página `log` e API `log-erp`.

## 5. Tela `public/log.html` (Processos > Log)

- Sidebar: item **Log** (ícone `list`) abaixo de Negativos em `nav.js`.
- Topo (botões em cima, nunca rodapé): período (padrão = mês atual), filtros Tabela / Usuário / Status, botões **Atualizar** e **Exportar CSV**.
- Tabela: Data/Hora · Usuário · Servidor (tag azul "Teste .254") · Tabela (`banco.tabela`) · Operação · Registros · Status (verde ok / vermelho erro / âmbar recusado) · Motivo.
- Clicar na linha abre painel lateral com: antes e depois lado a lado (colunas que mudaram destacadas em âmbar), SQL + parâmetros, erro se houver.
- Vazio: "Nenhuma mudança registrada no período."
- Design-system navy+âmbar, sem cores externas. Funciona no celular (tabela rola horizontal).

## 6. Erros

- Entrada inválida → 400 com mensagem clara, e mesmo assim entra no log como `recusado` (pra ficar rastro de tentativa).
- MySQL de teste fora → 502 com "MySQL de teste do .254 não respondeu", log `erro`.
- Arquivo de log ilegível/corrompido numa linha → a linha é pulada e contada em `linhas_invalidas` na resposta; nunca derruba a tela.

## 7. Testes

- Unitários (node, sem banco): montagem do SQL/placeholders pra update/insert/delete; validação de nomes; recusa quando host é `.252`; parser/filtro dos `.jsonl` com linha corrompida.
- Integração no `.254` (manual, com Tiago): `POST /api/log-erp/executar` mudando `Qtd` de 1 item em `central.estoquen1` com motivo "teste do log"; conferir na tela o antes/depois; conferir no `.252` que nada mudou (SELECT).

## Fora de escopo

- Reverter mudanças pela tela; editar/apagar log; capturar SQL rodado à mão fora do app; migrar `prevencao_bonif`; qualquer escrita no `.252`.
