# Aba Centro Distribuição (Gestão de Compras)

## Contexto

O Econômico Relatórios já tem o menu **Gestão de Compras** (`nav.js`) com três abas: Lista de
Compra (`fornecedores.html`), Gestão de Rupturas (`ruptura.html`) e Ponta de Gôndola
(`ponta-gondola.html`). A loja **10** é o Centro de Distribuição (CD) — "CAHU DISTRIBUIDORA DE
ALIMENTOS LTDA" — que abastece as lojas 1 a 6.

Hoje não existe nenhuma tela que cruze o estoque do CD com o consumo das lojas. O comprador
decide manualmente quando e quanto pedir do CD para cada loja. O objetivo desta feature é uma
nova aba que funcione como um "pedido automático por loja", sugerindo quanto cada loja deve pedir
do CD com base no giro de vendas dos últimos 30 dias, e alertando quando o próprio CD precisa
comprar do fornecedor porque não tem estoque suficiente para atender a demanda somada das 6 lojas.

## O que já existe e será reaproveitado

`server.js` já tem duas rotas com a mesma forma de cálculo que esta feature precisa:

- `/api/ruptura` — por loja, calcula estoque, média diária de venda (giro) e dias de cobertura,
  classificando em ruptura/em_risco/excesso.
- `/api/compras/analise-estoque` — por comprador, cruza estoque por loja (`estoquen1`..`estoquen6`)
  com vendas por loja/mês (`ln{loja}{mes}.zcupomitens`) dos últimos 30/60 dias.

A nova rota segue o mesmo padrão de consulta (estoque por loja + vendas por loja/mês), trocando o
"produto por loja" pelo "produto no CD vs. demanda somada das 6 lojas".

## Escopo

- Universo de produtos: itens ativos (`central.itens`, `CodDesativado=0`) que tenham estoque no CD
  (`estoquen10.Qtd > 0`) OU venda em qualquer uma das lojas 1-6 nos últimos 60 dias — mesmo filtro
  de "produto ativo" já usado em `analise-estoque`. Não há filtro por comprador/fornecedor: a aba
  cobre todos os produtos que passam pelo CD.
- Fora de escopo (não entra nesta versão):
  - Ratear automaticamente a sugestão entre lojas quando o CD não tem estoque suficiente para
    atender todo mundo — o sistema só alerta a falta; o rateio fica manual (decisão do comprador).
  - Pedidos de compra já em trânsito/pendentes de recebimento não entram no cálculo (não há hoje
    uma tabela confiável de "pedido em aberto" para cruzar).

## Backend — `GET /api/compras/centro-distribuicao`

Nova rota em `server.js`, na mesma seção `MÓDULO COMPRAS`.

**Fonte de dados por produto:**
- `estoqueCD` — `central.estoquen10.Qtd` (mesma estrutura de `estoquen1`..`estoquen6`).
- Por loja 1-6: `estoqueLoja` (`estoquenN.Qtd`) e vendas dos últimos 30 dias
  (`ln{loja}{mes}.zcupomitens`, `IndCancel='N'`) — reaproveita a mesma janela de 3 meses (60 dias)
  usada em `analise-estoque` para cobrir a virada de mês.

**Cálculo por produto, por loja (1-6):**
```
giroDiario      = qtd30 / 30
diasCobertura   = estoqueLoja / giroDiario   (ou 9999 se giroDiario ~ 0 e estoqueLoja > 0)
sugestaoPedido  = diasCobertura < 30
                    ? max(0, round(giroDiario * 30 - estoqueLoja))
                    : 0
```
Só entra sugestão de pedido quando a loja está abaixo de 30 dias de cobertura própria.

**Cálculo por produto, nível CD:**
```
totalSugerido     = soma(sugestaoPedido das 6 lojas)
giroDiarioTotalCD = soma(giroDiario das 6 lojas)
diasCoberturaCD   = estoqueCD / giroDiarioTotalCD   (ou 9999 se giroDiarioTotalCD ~ 0 e estoqueCD > 0)
faltaComprar      = max(0, totalSugerido - estoqueCD)
```

**Classificação de urgência do CD** (mesmo espírito de `/api/ruptura`, teto ajustado para 30 dias):
- Crítico: `diasCoberturaCD < 10`
- Alto: `diasCoberturaCD < 20`
- Médio: `diasCoberturaCD < 30`
- OK: `diasCoberturaCD >= 30`

**Resposta (shape):**
```json
{
  "produtos": [
    {
      "codigo": "...", "descricao": "...",
      "estoqueCD": 100, "diasCoberturaCD": 18, "status": "alto",
      "totalSugerido": 130, "faltaComprar": 30,
      "lojas": [
        { "loja": 1, "nome": "CAHU", "estoque": 5, "giroDiario": 2.1, "diasCobertura": 2.4, "sugestaoPedido": 58 },
        ...
      ]
    }
  ],
  "resumo": { "totalProdutos": 0, "precisamReposicao": 0, "criticos": 0, "totalUnidadesFaltando": 0 },
  "geradoEm": "..."
}
```

**Cache:** TTL de 10 minutos (mesmo padrão de `_analiseCache`/`ANALISE_TTL`), já que a consulta
cruza 6 bancos de vendas + a tabela de estoque do CD.

## Frontend — `public/centro-distribuicao.html`

Nova página, adicionada ao `nav.js` dentro do grupo "Gestão de Compras" (após Ponta de Gôndola).

- **Cards de resumo** no topo: nº de produtos precisando reposição, nº em estado crítico, total de
  unidades faltando no CD (soma de `faltaComprar`).
- **Filtro por status:** Todos / Crítico / Alto / Médio / OK, + busca por descrição/código do
  produto.
- **Tabela principal**, uma linha por produto: descrição, estoque CD, dias de cobertura CD, badge
  de status (cor por urgência, mesmo padrão visual de Gestão de Rupturas), total sugerido a repor.
- **Linha expansível** por produto: ao clicar, mostra a quebra por loja (Loja | Estoque | Giro/dia
  | Sugestão de pedido do CD) — só lojas com `sugestaoPedido > 0` aparecem em destaque, as demais
  aparecem esmaecidas/OK.
- Ordenação padrão: por urgência (dias de cobertura do CD, crescente) — mesmo critério de
  `/api/ruptura`.
- Estilo segue o design system atual do projeto (Executive Ink — navy + âmbar,
  `design-system.css`/`nav.js`).

## Testes / verificação manual

- Produto com estoque no CD zerado e giro ativo nas lojas → deve aparecer como crítico com
  `faltaComprar` = soma das sugestões das 6 lojas.
- Produto com estoque CD alto e giro baixo nas lojas → aparece como OK, sem sugestão.
- Loja com estoque próprio já acima de 30 dias de cobertura → não gera sugestão de pedido para
  aquela loja, mesmo que outras lojas do mesmo produto precisem.
- Produto sem nenhuma venda nas 6 lojas nos últimos 60 dias e sem estoque no CD → não aparece na
  lista (fora do universo de produtos ativos).
