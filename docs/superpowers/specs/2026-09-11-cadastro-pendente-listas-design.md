# Aba "Cadastro Pendente" na Lista de Compra — design

**Data:** 2026-09-11 · **Tela:** Gestão de Compras > Lista de Compra (`public/fornecedores.html`)

## Objetivo
Mostrar quais listas de compra têm produtos com cadastro incompleto no ERP, em três critérios,
e permitir abrir a lista pra ver exatamente quais itens e qual é o problema. Só leitura no ERP.

## Critérios de pendência (decididos com o Tiago em 11/09/2026)
Para cada item ATIVO (`itens.CodDesativado = 0`) de cada lista (`c_cotacao_lista_itens`):
1. **Sem margem varejo** — em alguma loja em que o item está marcado na lista (`i.l1..l6 = 1`),
   `itens_margens.MargemVarejo` (por `nLoja`) é NULL ou 0.
2. **Sem margem atacado** — mesma regra, com `itens_margens.MargemAtacado`.
3. **Loja 4 sem múltiplo de atacado** — só itens com `i.l4 = 1`; `itens.q4` NULL ou 0.

Item sem nenhuma loja marcada (l1..l6 = 0) não é avaliado (já aparece como "sem loja" na aba atual).
Margem zero conta como pendente (cadastro existe mas nunca foi preenchido).

## Backend (`server.js`, ao lado das rotas `/api/listas-compra`)
- `GET /api/listas-compra/cadastro-pendente` → `{ listas: [{ id, nome, fornecedor, codFornec, compradores,
  total_itens, sem_varejo, sem_atacado, sem_multiplo_l4, com_pendencia }], compradores: [...] }`.
  Só listas com `com_pendencia > 0`. Aceita `?comprador=` (mesmo mapa `NREGS_COMPRADOR`).
  Estratégia: 1 query dos itens de lista × itens ativos (com q4), 1 query de `itens_margens`
  inteira (CodigoBarra, nLoja, MargemVarejo, MargemAtacado), agrega em memória.
- `GET /api/listas-compra/:id/cadastro-pendente` → `[{ codigo, descricao, lojas:[..],
  margem_varejo:{1:x,...}, margem_atacado:{...}, lojas_sem_varejo:[..], lojas_sem_atacado:[..],
  sem_multiplo_l4: bool, atacado_qtd_l4, problemas:['varejo','atacado','multiplo_l4'] }]`.
  Só itens com pelo menos 1 problema.

## Frontend
- Terceira aba `⚠️ Cadastro Pendente` em `.main-tabs`; seção `#sec-pendente` com tabela `main-t`:
  Lista / Fornecedor · Comprador · Itens · Sem margem varejo · Sem margem atacado · L4 sem múltiplo ·
  Com pendência. Ordenada por "Com pendência" desc. Filtro Comprador do topo continua valendo;
  filtros Loja/Mês/Fornecedor/Buscar ficam ocultos (não se aplicam). Cache em memória por comprador.
- Clique no nome da lista abre o drawer existente (mesmo `#drawer`), sem abas, com KPIs (itens
  pendentes por tipo) + filtro por tipo (Todos / Varejo / Atacado / Múltiplo L4) + tabela `d-t`:
  Código · Descrição · Lojas · Margem varejo (por loja, vermelho onde falta) · Margem atacado (idem) ·
  Múltiplo L4 · Pendências (selos). Botão Cadastro e Imprimir do drawer continuam funcionando.

## Fora de escopo
Escrever no ERP, notificar comprador, outras lojas além da 4 no critério de múltiplo.
