# Negativos > Aprovar ajuste no MySQL de teste (.254)

**Data:** 2026-09-23 · **Status:** aguardando liberação do Tiago (nada implementado)
**Depende de:** `escreverERP` + Processos > Log (spec 2026-09-23-log-mudancas-erp-design.md, em produção).

## O que é

Na tela Negativos (Processos), depois que uma loja concluiu a contagem no app Contagem, a central
clica em **Aprovar ajuste**. O sistema grava, no MySQL de TESTE do `.254`, a quantidade contada de cada
item na tabela de estoque daquela loja (`central.estoquen{loja}`), item por item, pelo `escreverERP`.
Cada item vira uma linha em Processos > Log com antes/depois. O `.252` não é tocado.

## Regras

1. Só aparece pra loja com status **Concluída** e ainda não aprovada. Botão fica ao lado do "Feito" atual.
2. **Prévia obrigatória** antes de gravar: modal lista os itens que vão mudar (código, descrição, sistema,
   contado, novo valor), o total de itens e a loja. Itens **sem contagem** ficam de fora e são listados
   à parte como "não serão ajustados". Confirmação exige digitar o número da loja.
3. Valor gravado = **contado** (depósito + loja, ou 0 se "Não achei"). `Qtd` é varchar no ERP: grava como
   string inteira (`String(contado)`), igual ao formato existente.
4. Por item: `escreverERP({ usuario, motivo: 'Ajuste de negativos — contagem DD/MM/AAAA, loja N (nome)',
   banco: 'central', tabela: 'estoquen{N}', operacao: 'update', where: { CodigoBarra: cod }, valores: { Qtd } })`.
   Roda em série (1 conexão por vez), pra não derrubar o MySQL 5.0 de teste.
5. **Antes de cada UPDATE** o `escreverERP` já lê o valor atual. Se o estoque atual no `.254` for
   diferente do `sys` que o app tinha na hora da contagem (a cópia mudou), o item **não é pulado**: grava
   mesmo assim (o contado é a verdade física), mas a prévia avisa "N itens com estoque diferente do
   dia da contagem".
6. Item cuja escrita falhar (erro/recusado) não interrompe o lote: continua, e no fim mostra
   "X gravados, Y com erro" com a lista dos erros. Tudo já fica no Log de qualquer jeito.
7. Ao terminar com todos OK, a loja é marcada **Aprovada** (novo campo `aprovadoEm/aprovadoPor/aprovadoIds[]`
   em `data/contagem-negativos/<dia>.json`) e o botão some. Com erro parcial, fica "Aprovada com pendências"
   e o botão vira **Reprocessar pendentes** (só os itens que falharam).
8. **Não existe desfazer** pela tela. Reverter é uma nova aprovação depois de reabrir a contagem, ou ajuste
   manual pelo Log (fora de escopo agora).

## Tela

- Coluna Situação ganha a pill **Aprovada** (verde escuro) / **Aprovada c/ pendências** (âmbar).
- Botões em cima da tabela seguem como hoje; o "Aprovar ajuste" fica na linha da loja (mesmo lugar do "Feito").
- Modal de prévia: título "Aprovar ajuste — Loja N · nome", tabela com Código, Descrição, Sistema, Contado,
  Novo, colunas "Sem contagem: N" e "Estoque mudou: N" em cima, campo "Digite o número da loja pra confirmar",
  botão primário **Gravar no teste .254** e secundário Cancelar. Progresso "12 de 40…" durante a gravação.
- Rodapé do resultado: link "Ver no Log" (abre `/log.html?tabela=estoquenN&de=hoje&ate=hoje`).

## API

- `POST /api/contagem/:data/:loja/aprovar` → `{ somentePendentes?: bool }`.
  Resposta: `{ ok, gravados, erros: [{cod, erro}], ids: [...], aprovadoEm }`.
- `GET /api/contagem/:data/:loja/previa-ajuste` → itens com contagem, sem contagem, e estoque atual do `.254`
  (lido pelo `dbTeste`) pra comparar com `sys`.
- Acesso: já está no módulo Processos (`contagem` já é API do módulo? verificar em `lib/modulos.js` — se não
  estiver, adicionar `contagem` às apis de `processos`).

## Testes

- Unit (sem banco): montagem da lista de itens a gravar (ignora sem contagem; "Não achei" → 0; soma dep+loja);
  motivo com data/loja; marcação `aprovado` só quando 0 erros; reprocessar só pendentes.
- Integração no `.254` com Tiago: aprovar 1 loja de um dia de contagem real; conferir N linhas no Log;
  SELECT no `.252` mostra estoque intacto.

## Fora de escopo

Escrita no `.252`; desfazer; ajustar item a item pela tela; itens sem contagem.
