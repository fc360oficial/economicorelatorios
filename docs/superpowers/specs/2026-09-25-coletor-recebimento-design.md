# Coletor de Recebimento (PWA Android) — design

**Data:** 2026-09-25
**Status:** aprovado em conversa com o Tiago (telas de referência: https://claude.ai/artifact/BVDkbGGtUhtn24KY8A4TPG)
**Substitui:** o coletor do Dlinks no recebimento de notas nas 6 lojas.

## 1. Objetivo

Trocar o coletor de recebimento do Dlinks por um app nosso, instalado nos coletores Android das lojas, que:

1. mostra ao conferente só o que ele precisa: quais notas chegaram e se estão **Liberada / Divergente / Sem pedido** (veredito da conciliação XML que o Econômico já faz);
2. faz **conferência cega** (bipa, digita quantidade × embalagem e validade; nunca vê itens nem quantidades da nota);
3. grava no ERP, no formato do Dlinks, exatamente o que o coletor deles grava hoje, pra que o CPD continue dando entrada na nota sem mudar nada;
4. alimenta a retaguarda inteira do Econômico (Fiscal, Formação de Preço, Financeiro, ruptura) com um dado bipado uma única vez.

**Fora de escopo nesta versão:** lote por item, transferências entre lojas (`Obs: TRANSFERENCIA`), integração com balança, escrita no `.252` (segue [[feedback_mysql-readonly]]: tudo vai pro MySQL de teste do `.254` via `escreverERP` até o Tiago liberar o `.252` explicitamente).

## 2. O que foi confirmado no ERP (MySQL de teste `.254`, snapshot 17/09/26)

Fluxo do coletor do Dlinks, 4 tabelas em `central`:

| Tabela | Papel | Chave |
|---|---|---|
| `conferencia` | 1 linha por recebimento: `nLoja, CodFornec, NomeFornec, Status, DataEntrada/HoraEntrada, DataLiberacao/HoraLiberacao, OperadorLoja, OperadorCentral, OperadorLiberacao, Beep, Obs` | `nReg` auto |
| `conferenciachave` | NF-e(s) da conferência: `nRegConf, Chave (44 dígitos), Obs` (texto livre: vencimento, valor, "TRANSFERENCIA") | `nReg` auto |
| `conferenciaitens` | bipagem: `chave (= nReg da conferência, varchar), codigobarra, emb, qtd (em embalagens), qtdemb (un por emb), status, Reconferir, DataValidade` | PK (`chave`,`codigobarra`) |
| `conferenciadevolucao` | `nConf, CodigoBarra, Qtd` (o que volta) | `nReg` auto |

**Status de `conferencia`:** 1 bipando · 3 loja terminou · 5 reconferir · 2 liberada pela central (`OperadorLiberacao` preenchido). Contagem 15/08→17/09: 5.214 liberadas, 208 em 3, 3 em 5, 2 em 1.

**A entrada da nota depende disso:** das compras externas (Movimentacao COMPRA, 15/08→17/09) 100 % têm `compras.nConferencia` apontando pra uma conferência Status 2. As 145 sem conferência são transferências entre as empresas do grupo. Logo o app **precisa** gravar nessas tabelas.

**Validade:** cadastro em `itens.Validar` (dias); validade real por entrada em `itenscoletorvalidade` (o ERP grava a partir de `conferenciaitens.DataValidade` quando o CPD dá entrada). Hoje só ~6 % das linhas recentes de `conferenciaitens` têm validade preenchida.

**Unidade:** `conferenciaitens.qtd` é em embalagens e `qtdemb` é un/emb; o ERP multiplica. O XML é lido em unidade tributável (`oqTrib`). Toda comparação no Econômico é feita em **unidade**.

## 3. Arquitetura

```
Coletor Android (PWA /recebimento.html, loja+PIN+nome)
        │  HTTPS (Caddy .254), fila offline
        ▼
Econômico Relatórios  server.js
   lib/recebimento.js        estado da conferência (JSON por dia em data/recebimento/)
   lib/conferencia-xml.js    veredito XML×pedido (já existe)  ──┐
   lib/fiscal.js             tela Fiscal · Recebimento (já lê as 4 tabelas) ◄── central libera aqui
   lib/escrever-erp.js       única porta de escrita (já existe, .254, Log)
        │
        ▼
MySQL teste .254 → central.conferencia / conferenciachave / conferenciaitens / conferenciadevolucao
        │
        ▼
CPD dá entrada no Dlinks como hoje (compras.nConferencia)
```

Decisão: **PWA**, não APK. Mesmo padrão de `public/contagem.html` (manifest próprio, entra uma vez com loja + PIN + nome, token em localStorage, fila offline). Leitor do coletor bipa como teclado (keyboard wedge); câmera como fallback via `BarcodeDetector` quando disponível. Deploy junto com o app, sem loja de aplicativos.

## 4. Fluxo do conferente (4 telas)

### 4.1 Entrar
Loja (1–6) + PIN da loja + nome. Reusa `contagem-config.json`? **Não**: PIN/token próprios em `data/recebimento-config.json` (mesma geração, arquivo separado, pra trocar um sem afetar o outro). Nome vira `OperadorLoja` no ERP (maiúsculas, ≤20 chars).

### 4.2 Notas da loja
Lista das NF-e em `central.axml` com `CNPJdest` = CNPJ da loja, `Importado`=0 ou data ≥ hoje−7 d, ainda sem conferência nossa concluída. Cada linha: fornecedor (por raiz do CNPJ em `central.fornecedor`), nº NF-e, nº do pedido no Econômico se houver, e o **veredito**:

| Pill | Origem |
|---|---|
| Liberada (verde) | `conferencia-xml`: loja `conciliado` |
| Divergente (vermelho) | loja `consistencia` (falta/a mais/preço/não pedido) — linha diz só "central já sabe o motivo, confira normal" |
| Sem pedido (âmbar) | NF-e sem pedido no Econômico nem em `pedidocompra` |

Nada de quantidade de itens nem valor. Seções: "Pode conferir", "Atenção", e botão "Notas já conferidas hoje".

### 4.3 Bipando às cegas
Lista começa **vazia**; só entra o que ele bipou.

Ao bipar um código (Enter do leitor):
- cadastrado e aceito → cartão **Quant / Emb / Validade** (cursor já em Quant; Enter avança; Emb preenchida com `itens.qtdemb`; Enter em Validade volta pro campo de bipe). Total em unidades mostrado. Bipes seguintes do mesmo código somam 1 × Emb sem abrir o cartão; "Corrigir qtd" reabre.
- no XML mas **recusado pela compradora** na conferência XML (`it.decisao.acao==='recusar'`) → item vermelho "recusado · devolver", não conta como recebido.
- **não está no XML** → entra com aviso âmbar "não está na nota"; central decide.
- **não cadastrado** em `central.itens` → toast "chame a central", não entra.

**Validade (regra nova, automática):** `dias = validade − hoje`. Se `itens.Validar > 0` e `dias < Validar × pct_min` (config, padrão 100 %) → item **bloqueado** (vermelho, vai pra devolução, só a central libera pelo chat/Fiscal). Sem cadastro → só avisa. Piso absoluto `validade_min_dias` do Fiscal continua valendo.

Cabeçalho: "Você bipou N produtos · M unidades". Sem meta, sem barra de progresso.

Botões: **Corrigir qtd** · **Chamar central (chat)** · **Terminei a nota**.

### 4.4 Terminei
Servidor compara bipado × XML (em unidade). Resultado ao conferente **sem revelar quantidades**:
- "Tudo certo, enviado pra central liberar" (verde), ou
- "N produtos não bateram, reconte só esses": lista nomes com pill `recontar` / `não bipado` / `não está na nota`. Botões **Recontar** e **Recontei, está assim mesmo · enviar pra central**. Nº de recontagens antes de poder enviar: config, padrão 1.

Cartão **Devolução** (um aviso só pro motorista), três origens:

| Origem | Quando | Exemplos |
|---|---|---|
| Compras | antes do caminhão (conferência XML) | preço maior, não pedido, a mais |
| Coletor | na hora | validade curta, avaria |
| Falta | no Terminei | nota diz X, veio menos: sai por nota de devolução também (a rede não usa carta de crédito); motorista só assina |

Enviar → `conferencia.Status = 3`.

## 5. Central / Fiscal

Tudo na tela existente **Fiscal · Recebimento de Notas** (`public/fiscal.html`, `lib/fiscal.js`), que já lê as 4 tabelas e já tem as situações `aguardando_coletor, em_contagem, pronto, conferido, excecao, reconferir, liberado, bloqueado`. Mudanças:

1. Fonte adicional: `lib/recebimento.js` (nosso estado) mesclado por `nReg` da conferência — traz recontagens, bloqueios de validade, origem de cada devolução, chat.
2. **Liberar** passa a gravar: `conferencia.Status=2, DataLiberacao/HoraLiberacao, OperadorCentral, OperadorLiberacao` + `conferenciadevolucao` (uma linha por item/qtd, sem origem) via `escreverERP.lote`. Texto da tela "Nada é gravado no ERP" sai; entra "grava no ERP de teste (.254)".
3. **Reconferir** pela central → `Status=5`, coletor recebe.
4. Cruzamento "conferência física" no Fiscal: contado × nota × devolução; nota só fica `pronto` quando pedido, XML e físico batem.
5. PDF "Aviso de devolução" reaproveita `gerarPdfDevolucao` de `lib/pedidos-fornecedor.js`, estendido pra receber as três origens.

## 6. Chat interno preso à nota (Chamar central)

- Coletor: botão abre a conversa da conferência; primeiro toque = motivo em botões (código não cadastrado, avaria, validade, não está na nota, outro) com o último produto bipado anexado; depois texto livre.
- Central: badge "N chamados" + som na linha da nota no Fiscal; respostas prontas **Pode receber / Devolver / Liberar validade / Aguarde** + texto livre. Resposta-ação muda o estado do item no coletor sem digitação.
- Armazenamento: `mensagens[]` dentro da conferência em `data/recebimento/`. Coletor faz polling a cada 5 s enquanto a nota está aberta; Fiscal a cada 15 s. Sem WhatsApp (o coletor não tem).
- Registro: quem, quando, produto, resposta → também vai pro Log quando vira escrita no ERP.

## 7. O que vai pro ERP e quando (tudo via `escreverERP`, banco de teste `.254`)

| Evento no app | Escrita |
|---|---|
| Abrir nota | `INSERT conferencia` (Status 1, Beep 1, OperadorLoja, DataEntrada/HoraEntrada) + `INSERT conferenciachave` (Chave, Obs = "Econômico #id") |
| Cada produto (1ª vez / correção) | `INSERT`/`UPDATE conferenciaitens` (chave = nReg, codigobarra, emb, qtd em embalagens, qtdemb, DataValidade, status 1) |
| Terminei | `UPDATE conferencia SET Status=3` |
| Central: reconferir | `UPDATE conferencia SET Status=5` |
| Central: liberar | `UPDATE conferencia SET Status=2, DataLiberacao, HoraLiberacao, OperadorCentral, OperadorLiberacao` + `INSERT conferenciadevolucao` por item |

Fonte da verdade do estado durante a conferência é o JSON do Econômico; o ERP recebe espelho. Se a escrita no ERP falhar, o app segue e a pendência aparece no Fiscal com "Reenviar pro ERP" (mesmo padrão de `p.erp_teste.erros`).

## 8. Estrutura de código

- `lib/recebimento.js` (puro, testável, só fs/path + funções injetadas): PIN/token por loja, `abrirNota`, `bipar`, `corrigir`, `terminei` (compara em unidade, decide recontagem), `devolucoes` (3 origens), `mensagens`, `liberar`. Espelho ERP em `lib/recebimento-erp.js` (`montarPassos*` no estilo de `lib/pedido-erp.js`).
- Rotas públicas (token): `POST /api/recebimento-publico/entrar`, `GET .../notas`, `POST .../abrir`, `POST .../bipar`, `POST .../corrigir`, `POST .../terminei`, `GET/POST .../chat`.
- Rotas internas (sessão, módulo `fiscal`): `GET /api/recebimento/:data`, `POST /api/recebimento/:nReg/liberar|reconferir|chat|reenviar-erp`. Entrar em `lib/modulos.js`.
- `public/recebimento.html` + `manifest-recebimento.json` (design-system.css; tokens navy+âmbar; layout das telas de referência).
- `public/fiscal.html`: coluna/badges novos, botões Liberar/Reconferir, chat.
- Testes: `test/recebimento.test.js` (comparação em unidade, regra de validade, 3 origens de devolução, recontagem, montagem dos passos ERP com `criarConexao` fake).

## 9. Configurações (em `data/recebimento-config.json`, editáveis na tela Fiscal)

| Chave | Padrão | Uso |
|---|---|---|
| `validade_pct_min` | 100 | % de `itens.Validar` que o lote precisa ter |
| `recontagens_min` | 1 | recontagens antes de "enviar assim mesmo" |
| `modo_cega` | `total` | `total` (lista vazia) ou `quantidade` (mostra produtos da nota sem qtd) — por loja opcional |
| `janela_dias_axml` | 7 | notas quantos dias pra trás aparecem na lista |

## 10. Riscos e decisões pendentes

- **Modelo do coletor** não informado ainda; premissa: leitor bipa como teclado. Se só funcionar dentro do app do Dlinks, cai pra câmera (mais lento) ou APK fino (TWA) — decidir ao testar no aparelho.
- **Dlinks e Status 3/5/2 vindos de fora**: precisa validar num Dlinks apontado pro `.254` que a tela deles enxerga a conferência e o CPD consegue dar entrada. Mesma pendência do Radar ("Gerar pedido no ERP teste").
- **Convivência**: enquanto o `.252` não estiver liberado, as lojas testam com o app e o CPD continua entrando pelo coletor do Dlinks; o Econômico mostra as duas fontes lado a lado.
- **`Obs` de `conferenciachave`** hoje leva vencimento/valor digitados pela loja; nosso app grava "Econômico #id" e os boletos vêm de `axmlboletos` (já usado no Fiscal).
