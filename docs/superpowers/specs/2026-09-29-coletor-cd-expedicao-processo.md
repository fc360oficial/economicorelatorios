# Coletor no CD (loja 10): recebimento × expedição — como é hoje e como vai ficar

**Data:** 2026-09-29 · **Status:** IMPLEMENTADO 29/09/26 à noite (commits 7b47562 → 96ba918), em produção no .254 · **Pergunta do Tiago:** no CD tem duas conferências
(a de recebimento, igual às lojas, e a de saída, em que se digita `000` + nº do pedido). Como diferenciar no nosso coletor?

## Como funciona hoje no Dlinks (lido no ERP em 29/09/26, só leitura)

**Entrada (nota de fornecedor)** — igual às lojas:
`axml` (XML da SEFAZ) → `conferencia` + `conferenciachave` (chave de 44 dígitos, `nLoja=10`) → Status 2 = liberada → CPD dá entrada (`Importado=1`).
Nos últimos 90 dias todas as 363 chaves de conferência da loja 10 são NF-e de 44 dígitos. Nenhuma começa com `000`.

**Saída (pedido de loja ou cliente)** — outro caminho, outras tabelas:
1. Televendas digita o pedido: `central.delivery` (`nLoja=10`, `nPedido` 6848, 6853…, cliente = loja do grupo ou mercadinho: SERAFIM, VILA NOVA, OLINDA…).
2. Pedido vai pro painel de separação: `painel_televendas` (Status 0 no painel → 1 em separação → 2 conferido → 4 liberado/expedido).
3. Conferente abre no coletor do Dlinks digitando **`000` + nPedido**. Os três zeros são o truque do coletor do Dlinks pra saber que aquilo é um pedido e não uma NF-e — não existem em tabela nenhuma.
4. Cada bipe vai pra `conferencia_televendas` (`nLoja`, `nPedido`, `Codigobarra` DUN-14 ou unidade, `Qtd` em caixas, `QtdEmb`, `Data`, `Status_Conferencia`).
5. CD emite a nota de VENDA pra loja (o Pedidos do CD já lê `conferencia_televendas` e `painel_televendas` pra mostrar "separado").

## Como vai ficar no nosso coletor (decisão do Tiago, 29/09/26 à tarde)

**Separação continua no papel.** O CD tem um coletor só: o Televendas digita o pedido, o CD imprime e separa olhando o papel, como hoje.
O coletor entra **uma vez só, na saída**, e a conferência é **cega**: o conferente bipa o que está no caminhão sem ver a quantidade do pedido,
e no "Terminei" o app compara com o pedido.

**Diferenciação é por tela, não por código.** Só a loja 10 vê, depois do PIN, a escolha:

| | Recebimento | Expedição (saída) |
|---|---|---|
| O que é | nota de fornecedor chegando | pedido separado saindo pro caminhão |
| Lista | NF-e da `axml` sem entrada (igual às lojas) | pedidos do dia em `delivery nLoja=10` ainda sem nota de venda, com cliente, nº e hora |
| Abrir | tocar na nota → **bipar a DANFE** | tocar no pedido (sem digitar zero nenhum) |
| Bipagem | cega, unidade, validade obrigatória em TODO produto (29/09) | **cega**, por caixa (DUN-14) ou unidade, **sem pedir validade** (foi conferida na entrada); o app não mostra quanto o pedido pede |
| Terminei | recontagem (1×) → central libera no Fiscal | só fecha com 100 % batendo; não bateu → lista os itens (sem qtd) e a conferência continua aberta até o CD acertar o pallet |
| Espelho no ERP de teste | `conferencia` + `conferenciachave` (como hoje) | `conferencia_televendas`, no formato do Dlinks (nLoja 10, nPedido, Codigobarra, Qtd cx, QtdEmb) |
| Id interno | `AAAA-MM-DD-10-<hash da chave>` | `exp-AAAA-MM-DD-10-<nPedido>` |

Lojas 1–6 não veem a escolha: entram direto no Recebimento, como hoje.

## Aviso na hora do bipe e fechamento (Tiago, 29/09/26, versão final)
**O pedido nunca muda. Tudo se resolve no coletor até bater 100 %.** O app avisa na hora, sem revelar a quantidade do pedido:
- bipou **a menos** (9, pedido tem 10) → "Quantidade diferente do pedido": o conferente busca o que falta e bipa o certo;
- bipou **a mais** (12, pedido tem 10) → "Quantidade diferente do pedido": tira o excesso do pallet e usa **"Tirar da coletagem"** pra baixar a quantidade;
- bipou **código que não está no pedido** → "Este produto não é do pedido": não soma; tira do pallet e usa "Tirar da coletagem".
- e assim por diante: o item só fica verde quando bate exatamente; o resto da bipagem nunca trava.

**Fecha só 100 % certo.** O Terminei só conclui quando todo item do pedido bateu e não há nada fora. Não existe "fechar com divergência": a conferência fica aberta até o CD acertar o pallet.

**Única exceção em que o pedido muda: sem estoque.** O pedido já chega 100 %. Se o CD não tem o item, o Televendas **exclui o item do pedido** no Dlinks; o app relê o pedido (o item some da conferência) e, se o conferente já tinha bipado algo dele, usa "Tirar da coletagem". O CD nunca altera quantidade pelo app.

**Retaguarda: pendência "verificar pallet" pro fiscal do CD.** Todo "Tirar da coletagem" (a mais ou fora do pedido) gera evento `tirar_coletagem` com loja 10, quem, pedido, código, descrição,
quantidade bipada antes/depois e hora. Aparece na retaguarda pro **fiscal do CD** conferir se o produto saiu mesmo do pallet — porque dá pra apagar no app e mandar o produto sem coletagem.
Onde: aba **Expedição** em Centro Distribuição (retaguarda), pendências por pedido, e no LOG Coletor. Fiscal marca "verifiquei" (nome + hora). Pendência aberta sinaliza o pedido na retaguarda, não trava o CD.

## Lote no CD (Tiago, 29/09/26)
O CD precisa saber o que tem **por lote**. Só na loja 10; nas lojas 1–6 continua só validade.
- **Recebimento (loja 10):** cada bipe pede quantidade, validade **e código do lote** (campo aceita bipe ou digitação; obrigatório). Mesmo produto com dois lotes = duas linhas (qtd + validade + lote). Bloqueio de validade curta é por lote, não pelo produto inteiro.
- **Expedição:** a conferência cega do pedido também **bipa/digita o lote** de cada caixa. Saída sem lote não fecha.
- **Retaguarda "Lotes no CD"** (aba em Centro Distribuição): por produto, lotes com data de entrada, validade, quantidade que entrou, quantidade que saiu (por pedido) e saldo. Sem FEFO calculado: o saldo é o que foi bipado de verdade.
- **Espelho no ERP de teste:** entrada em `conferenciaitens`/`itenscoletorvalidade` no formato do Dlinks (uma linha por lote: Codigobarra, Qtd, Data, Lote); saída em `conferencia_televendas` (o Dlinks não tem lote nessa tabela; o lote da saída fica só no Econômico).

## Decisões já tomadas
1. Expedição **cega** (não separação assistida). O papel impresso é a separação.
2. Quem fecha a expedição é o **próprio CD** ao terminar, e só com 100 % batendo. O pedido nunca é alterado: a menos → bipa o certo; a mais ou fora do pedido → tira do pallet e da coletagem. Cada retirada vira pendência pro fiscal do CD na retaguarda.
3. Entram **todos** os pedidos do Televendas da loja 10 (lojas do grupo e clientes externos).
4. `painel_televendas.Status` não é mexido; o espelho grava só os bipes em `conferencia_televendas` (teste).

Mockup: https://claude.ai/artifact/X8GGMLQW8dSfQVGc6rHpcr · Escrita no `.252` continua fechada; espelho só no MySQL de teste do `.254`.

## Como ficou implementado (29/09/26)
- `lib/expedicao.js` (estado), `lib/expedicao-erp.js` (espelho), `lib/expedicao-rotas.js` (rotas), telas no `public/recebimento.html`, abas em `public/centro-distribuicao.html`.
- **Quantidade do pedido (CORRIGIDO 14/10, pedidos reais 7222/7223):** `delivery_produtos.Qtd` vem NA UNIDADE DA LINHA (`Und`). Linha em UN = unidades, código EAN-13 (ALA 400G: Qtd 54, "2 CX c/27"). Linha em CX/FD = CAIXAS, código DUN-14 da caixa, QtdEmb = un/caixa (PAPEL HIG. FD: Qtd 4, QtdEmb 16 → 64 un). O app converte tudo pra unidades (`un`) e guarda `qtd`/`und`/`emb`/`emCaixa` pra mostrar como na folha. A frase antiga abaixo valia só pra linha em UN: `delivery_produtos.Qtd` já vem em unidades do código (ex.: "4 FD c/27" = 108); a comparação usa Qtd direto. Bipe da caixa (DUN-14) cai no código da unidade pelo vínculo caixa → unidade do Pedidos do CD.
- **Lista de pedidos:** `delivery nLoja=10`, últimos 3 dias, Status 0/1 e sem NFe; some quando fecha 100 % no coletor.
- **Espelho no ERP de teste:** só ao fechar, uma linha por código × lote em `conferencia_televendas` (Qtd em caixas, QtdEmb). O lote da saída fica só no Econômico.
- **Sem fila offline** na expedição (CD tem rede); o bipe vai direto.
- **Retaguarda:** Centro Distribuição › Expedição (pendências "verificar pallet" com botão "Verifiquei o pallet", pedidos conferidos) e › Lotes no CD (entrou × saiu × saldo por lote, busca).
- **Pendente de validação real:** primeiro pedido conferido no Autoid Q8; conferir com o Televendas se algum item é pedido em código diferente do que está na caixa.

## Separação de Pedidos com lista + fiscal do CD + Carregamento de Caminhão (Tiago, 14/10/26 à noite). Status: IMPLEMENTADO 14/10/26

Tiago, 14/10 à noite: "na primeira bipagem vamos chamar ela de **Separação de Pedidos** e a segunda bipagem vai ser **Carregamento de
Caminhão**. Na separação quero que venha os produtos do pedido, descrição e quantidade, e no código de barra traga só os 4 últimos
números do EAN. Ele seleciona o item e digita a quantidade; aí já tem essa conferência em cima do produto: se der erro ele já mostra que
o produto não está no pedido. A segunda coletagem (carregamento) vai ser outra pessoa conferindo às cegas, que vai bater com a
separação; se der divergência de separação e pedido, o fiscal do CD é que tem que liberar se continua ou não."

**Muda em relação à seção abaixo (que continua valendo no resto):**

| Etapa | Nome no CD | Cega? | Compara com | Fecha |
|---|---|---|---|---|
| 1 (`separacao`) | **Separação de Pedidos** | **não**: lista do pedido com descrição, quantidade e `…EAN4` | pedido do Televendas | 100 % → `separada`; com divergência → **fiscal do CD** |
| 2 (`expedicao`) | **Carregamento de Caminhão** | sim | **o que a separação registrou** (não o pedido) | só 100 % |

- **Separação:** o separador toca no produto (ou bipa, que só serve pra achar na lista) e **digita a quantidade separada**; grava o TOTAL do
  item (`separar`, não soma; 0 limpa). Bipe de produto que não está no pedido mostra erro na hora ("Não está no pedido") e não grava nada
  (`/api/expedicao-publico/produto`). Lote opcional nessa etapa. A lista traz os itens na ordem do pedido, os já certos vão pro fim.
- **Terminei da separação com divergência:** o coletor mostra pedido × separado e o botão "Mandar pro fiscal do CD decidir" (motivo
  opcional) → status `aguardando_fiscal`; o pedido fica travado na lista ("Aguardando fiscal"). Só a separação manda pro fiscal; se tiver
  "fora do pedido", tira da coletagem antes.
- **Fiscal do CD** (Centro de Distribuição › Expedição › "Separações aguardando o fiscal"): vê pedido × separado item a item, com motivo,
  e decide: **Liberar pro carregamento assim** (separação fecha do jeito que está → `separada`; o carregamento bate com o pallet) ou
  **Devolver pra separação** (→ `separando`, a observação aparece no coletor). Rotas `/api/expedicao/liberacoes` e `/api/expedicao/liberar`.
  Não libera pallet vazio. Eventos `pedido_fiscal` / `liberacao_fiscal` na conferência; `c.liberacao` guarda a decisão.
- **Carregamento:** referência = itens da separação com un > 0 (`referencia(c, et)`). Item do pedido que não foi separado, se bipado, é
  "não está na separação" (fora). Lote obrigatório. Divergência de lote só quando a separação registrou lote naquele item.
- **Trava** "quem separou não carrega" e o resto (PIN pessoal, tirar da coletagem, espelho no ERP com os itens do carregamento) não mudam.
- Log do coletor: `exp_separar` (quantidade digitada), `exp_bipe` com `fora_do_pedido` na separação, `exp_fechar` com resultado `fiscal`,
  `exp_fiscal` (decisão da retaguarda).

## Duas conferências na saída do CD (Tiago, 14/10/26) — SÓ loja 10, SÓ expedição. Status: IMPLEMENTADO 14/10/26 (mockup https://claude.ai/artifact/LnE2VJmn3C9m9egVGtrEoq); separação deixou de ser cega na seção acima

Como ficou: `lib/expedicao.js` (etapas `separacao`/`expedicao` dentro da mesma conferência, status separando → separada → expedindo → fechada,
operadores com PIN pessoal em `data/expedicao/operadores.json`, trava `travaOperador`), `lib/expedicao-rotas.js` (sessão = token da loja `t` +
token do operador `o`; `/api/expedicao/operadores`), login da loja 10 em `lib/recebimento-rotas.js` (`pinPessoal`), telas em `public/recebimento.html`
e aba Expedição de `public/centro-distribuicao.html` (pendências, duas etapas por pedido, cadastro de operadores). Testes: `test/expedicao*.test.js`.
**Antes de usar:** cadastrar os operadores do CD na retaguarda — sem operador ativo o coletor da loja 10 não entra.

**O que muda:** a saída do pedido do Televendas passa a ter **duas conferências cegas em sequência**, as duas batendo 100 % com o pedido:

| Etapa | Quem | Quando | Compara com | Fecha |
|---|---|---|---|---|
| 1. **Separação** | separador | enquanto monta o pallet | pedido do Televendas | só 100 % |
| 2. **Expedição** | conferente da saída | quando o pallet entra no caminhão | pedido do Televendas | só 100 % |

**O que NÃO muda:** recebimento (entrada de nota) no CD continua igual às lojas; lojas 1–6 continuam só com o recebimento;
o híbrido com o coletor do Dlinks continua (lista segue `painel_televendas`); espelho em `conferencia_televendas` e "Lotes no CD" seguem iguais.

### Regras
- **As duas são cegas.** Nenhuma mostra a quantidade do pedido. A expedição também **não vê** o que a separação bipou (premissa do Claude em 14/10, a confirmar com o Tiago).
- **Mesmas regras de bipe das duas:** `ok` / `qtd_diferente` / `fora_do_pedido` / `sem_lote`, "Tirar da coletagem" gera `tirar_coletagem` (pendência "verificar pallet" pro fiscal do CD) em qualquer etapa. O pedido nunca muda pelo app; a única exceção continua sendo o Televendas excluir item sem estoque no Dlinks.
- **Ordem obrigatória:** a expedição só abre depois que a separação fechou 100 %. Pedido separado mas não expedido fica na lista do coletor como "Expedir".
- **Batimento entre as etapas:** como as duas só fecham 100 % contra o pedido, quantidade por código bate por construção. **Lote diferente** entre separação e expedição (separou lote A, embarcou lote B) **não trava** a expedição, mas vira pendência `lote_divergente` pro fiscal do CD na retaguarda (mesma lista do "verificar pallet").
- **Quem fecha:** cada etapa guarda quem fechou (nome do PIN) e hora. Separador e conferente podem ser a mesma pessoa; o app não impede, a retaguarda mostra.
- **Pedido só está pronto pra nota** quando a etapa 2 fecha. O espelho em `conferencia_televendas` e a saída em "Lotes no CD" usam **os lotes da expedição** (o que de fato saiu), não os da separação.

### Estado (lib/expedicao.js)
Mesma conferência `exp-AAAA-MM-DD-10-<nPedido>`, com as duas etapas dentro:
- `status`: `separando` → `separada` → `expedindo` → `fechada` (hoje é `bipando` → `fechada`).
- `etapas.separacao` e `etapas.expedicao`: cada uma com `itens`, `fora`, `eventos`, `tentativas`, `abertoEm`, `fechadoEm`, `fechadoPor`, `bipes_vistos`.
- `pedido` continua único (a verdade). `eventos` do pedido guardam `lote_divergente` e `tirar_coletagem` com o campo `etapa`.
- Conferência gravada antes de 14/10 (sem `etapas`) continua sendo lida no modelo antigo: uma etapa só, pra não quebrar o histórico.

### Coletor (public/recebimento.html, só loja 10 › Expedição)
- Lista de pedidos ganha a etapa: **Separar** (sem conferência ou `separando`), **Expedir** (`separada`/`expedindo`). O status do painel do Dlinks continua filtrando a lista.
- Ao tocar no pedido abre a etapa que falta; a barra mostra "SEPARAÇÃO · 6853 · SERAFIM" ou "EXPEDIÇÃO · ...".
- "Terminei" da separação, quando fecha, volta pra lista com o pedido em "Expedir". "Terminei" da expedição fecha o pedido e ele some.

### Rotas
- `/api/expedicao-publico/abrir` passa a devolver a etapa aberta; `bipar`, `tirar`, `terminei`, `visao` agem na etapa atual da conferência (sem rota nova).
- Internas: `/api/expedicao/pendencias` inclui `lote_divergente`; `/api/expedicao/fechadas` devolve as duas etapas (quem, hora, tentativas) pra aba Expedição da retaguarda.

### Fora deste escopo
Separação assistida (mostrar a lista pro separador), múltiplos separadores no mesmo pedido, mexer em `painel_televendas.Status`.

### Trava: quem separa NÃO pode expedir (Tiago, 14/10/26)
O app tem que **impedir** que a mesma pessoa feche as duas etapas do mesmo pedido. Hoje o coletor entra com o PIN da loja
(um só pra loja 10) e nome digitado livre, o que não identifica ninguém. Por isso, só no CD:
- **Operadores do CD com PIN pessoal.** Cadastro na retaguarda (Centro Distribuição › Expedição › Operadores): nome + PIN de 4 dígitos
  por pessoa, ativo/inativo. Guardado em `data/expedicao/operadores.json` (gitignored, backup normal).
- **Login do coletor na loja 10 muda:** depois do PIN da loja, pede o **PIN pessoal** em vez do nome livre. O nome vem do cadastro.
  A sessão do coletor passa a carregar `operador` (id + nome). Lojas 1–6 continuam com nome digitado.
- **Regra no servidor** (`lib/expedicao.js`, não só na tela): a expedição de um pedido **não abre nem aceita bipe/terminei** com o
  mesmo operador que fechou a separação. Erro 409 "Quem separou não pode expedir este pedido" com o nome de quem separou.
  Separação sem operador (histórico) não trava.
- Quem separou fica em `etapas.separacao.operador`, quem liberou em `etapas.expedicao.operador`. Retaguarda mostra os dois.
- Trocar de operador no mesmo aparelho = sair e entrar com outro PIN pessoal.
