# Coletor no CD (loja 10): recebimento × expedição — como é hoje e como vai ficar

**Data:** 2026-09-29 · **Status:** proposta de processo, NÃO implementada · **Pergunta do Tiago:** no CD tem duas conferências
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
| Bipagem | cega, unidade, validade | **cega**, por caixa (DUN-14) ou unidade; o app não mostra quanto o pedido pede |
| Terminei | recontagem (1×) → central libera no Fiscal | compara com o pedido: bateu 100 % → fecha; não bateu → lista os itens (sem qtd) e fica "aguardando ajuste do Televendas"; nunca fecha com divergência |
| Espelho no ERP de teste | `conferencia` + `conferenciachave` (como hoje) | `conferencia_televendas`, no formato do Dlinks (nLoja 10, nPedido, Codigobarra, Qtd cx, QtdEmb) |
| Id interno | `AAAA-MM-DD-10-<hash da chave>` | `exp-AAAA-MM-DD-10-<nPedido>` |

Lojas 1–6 não veem a escolha: entram direto no Recebimento, como hoje.

## Aviso na hora do bipe e fechamento (Tiago, 29/09/26, versão final)
Diferente do Recebimento (que só compara no Terminei), na Expedição o app avisa **na hora**, sem revelar a quantidade do pedido:
- bipou 9 e o pedido tem 10 → "Quantidade diferente do pedido, conte de novo": pede recontagem ali mesmo. Não trava a bipagem do resto, mas o item fica marcado enquanto não bater;
- bipou código que não está no pedido → "Este produto não é do pedido": não soma. O conferente tem o botão **"Tirar da coletagem"** (remove o item bipado, com motivo opcional).

**Fecha só 100 % certo.** Não existe "fechar com divergência". O Terminei só conclui quando todo item do pedido bateu e não há nada fora do pedido.
Se o pedido não fecha (faltou estoque, veio a mais), o caminho é o Televendas ajustar o pedido no Dlinks; o app relê o pedido e aí fecha.
Enquanto isso o pedido fica "aguardando ajuste do Televendas", com a lista dos itens que não batem (sem quantidade).

**Retaguarda: aviso de item tirado da coletagem.** Todo "Tirar da coletagem" gera um evento (`tirar_coletagem`) com loja 10, quem, pedido, código, descrição,
quantidade que tinha sido bipada e hora. Ele aparece na retaguarda pro **fiscal do CD** conferir se o produto saiu mesmo do pallet — porque o conferente
pode apagar no app e mandar o produto sem coletagem. Onde aparece: aba **Expedição** dentro de Centro Distribuição (retaguarda), com pendências
"verificar pallet" por pedido, e no LOG Coletor. Fiscal marca "verifiquei" (nome + hora). Enquanto tiver pendência não verificada, o pedido fica sinalizado na retaguarda (não trava o CD).

## Decisões já tomadas
1. Expedição **cega** (não separação assistida). O papel impresso é a separação.
2. Quem fecha a expedição é o **próprio CD** ao terminar, e só com 100 % batendo; divergência = Televendas ajusta o pedido, nunca fecha diferente. Item tirado da coletagem vira pendência pro fiscal do CD na retaguarda.
3. Entram **todos** os pedidos do Televendas da loja 10 (lojas do grupo e clientes externos).
4. `painel_televendas.Status` não é mexido; o espelho grava só os bipes em `conferencia_televendas` (teste).

Mockup: https://claude.ai/artifact/X8GGMLQW8dSfQVGc6rHpcr · Escrita no `.252` continua fechada; espelho só no MySQL de teste do `.254`.
