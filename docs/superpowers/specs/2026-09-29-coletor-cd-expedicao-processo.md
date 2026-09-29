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

## Como vai ficar no nosso coletor

**Diferenciação é por tela, não por código.** Só a loja 10 vê, depois do PIN, a escolha:

| | Recebimento | Expedição |
|---|---|---|
| O que é | nota de fornecedor chegando | pedido de loja/cliente saindo |
| Lista | NF-e da `axml` sem entrada (igual às lojas) | pedidos do dia em `delivery nLoja=10` que estão no painel (Status 1 ou 2), com cliente, nº e hora |
| Abrir | tocar na nota → **bipar a DANFE** | tocar no pedido (sem digitar zero nenhum) |
| Bipagem | cega, unidade, validade | por caixa (DUN-14) ou unidade, mostra o que falta separar (é separação, não recebimento) |
| Terminei | recontagem (1×) → central libera no Fiscal | resumo separado × pedido; falta vira aviso pro Televendas |
| Espelho no ERP de teste | `conferencia` + `conferenciachave` (como hoje) | `conferencia_televendas`, no formato do Dlinks |
| Id interno | `AAAA-MM-DD-10-<hash da chave>` | `exp-AAAA-MM-DD-10-<nPedido>` |

Lojas 1–6 não veem a escolha: entram direto no Recebimento, como hoje.

## O que ainda precisa o Tiago decidir antes de implementar
1. Expedição é **cega** (não mostra a quantidade do pedido) ou **aberta** (mostra o que falta separar)? Proposta: aberta.
2. Quem **libera** a expedição: o próprio CD ao terminar, ou a central pelo Fiscal?
3. Clientes externos (mercadinhos) entram na lista ou só as 6 lojas? Proposta: todos os pedidos do painel.
4. Atualizar `painel_televendas.Status` no espelho de teste (0→1→2) ou só gravar os bipes?

Escrita no `.252` continua fechada; o espelho é só no MySQL de teste do `.254`, como no recebimento.
