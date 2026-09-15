# Sugestão Manual — tela "Consolidação da Lista"

**Data:** 2026-09-15
**Módulo:** Gestão de Compras › Sugestão de Compras › Sugestão Manual
**Arquivos:** `public/sugestao-compras.html`, `server.js`, novo `lib/sugestao-manual.js`

## Objetivo

Reproduzir dentro do Econômico Relatórios a tela "Consolidação da Lista" do
Dlinks (Gestão de Compras › Sugestão de Compras › duplo clique numa sugestão):
o sistema calcula a sugestão por loja com a conta do Dlinks, a compradora
digita manualmente a quantidade que quer, e daí gera o pedido em Pedidos de
Compra. Tudo acontece no Fluxo; o Dlinks é só fonte de leitura.

Regra fixa: **nada é escrito no MySQL do ERP** (só `SELECT`). Sugestões
criadas aqui são gravadas no nosso lado e, nesta fase, valem como teste.

## Contexto do ERP (confirmado 15/09/2026, só SELECT)

- A aba do Dlinks lê `central.lista_consolidadas` (1 linha por sugestão).
  `CodDesativado=1` some da lista. `StatusWeb` 0/1/2 = sem link / Em Aberto
  (vermelho) / Fechado (verde).
- `lista_consolidado_itens` = grade de cima da Consolidação (CodigoBarra,
  Descricao, Unid, QtdEmb, QTotal, Preco, Total, Ql1..Ql10 por loja, Obs).
- `lista_consolidado_historico` = grade de baixo por loja (nCompra, nDoc,
  DataCompra, Fornecedor, Qtd, Emb, Preco, Total, Custo, PVenda, Transito,
  SaidaMedia, Cobertura, Estoque, QtdVendas, QtdSug, QtdLoja, QTdCompra,
  PMV). Campos numéricos em varchar com vírgula.
- Fórmula do Dlinks (memória `erp-sugestao-compras-formula`):
  `QtdSug = QtdCobertura × SaidaMedia − Estoque − Transito`, com
  `SaidaMedia = QtdVendas ÷ dias do período` e `Cobertura = Estoque ÷ SaidaMedia`.

## 1. Pontos de entrada

| Ação | Resultado |
|---|---|
| **+ Nova Sugestão** → modal (lista, período de venda, cobertura, lojas, observações) → Confirmar | Cria a sugestão no Fluxo (`F-N`), calcula e abre a Consolidação |
| Clicar numa linha do Monitor com selo **Dlinks** | Abre a Consolidação com os números gravados no ERP (`lista_consolidado_*`) |
| Clicar numa linha do Monitor com selo **Fluxo** | Abre a Consolidação com o cálculo nosso + quantidades já digitadas |

O Monitor lista as duas fontes juntas, ordenadas por data (mais recente
primeiro), com selo de origem: **Dlinks** (cinza) ou **Fluxo** (âmbar). As do
Dlinks continuam como hoje (leitura, filtro de desativadas, StatusWeb). A
busca e o filtro de comprador valem pras duas fontes.

Numeração das nossas: `F-1`, `F-2`… (contador em `data/sugestoes-manuais/_seq.json`).

## 2. A tela (view `#consolidacao-view` em `sugestao-compras.html`)

Mesmo layout do Dlinks, no tema do Econômico (design-system.css).

**Cabeçalho:** nº sugestão · nº lista · fornecedor (CNPJ + nome) · período de
venda (`dd/mm/aaaa até dd/mm/aaaa (N dias)`) · lojas participantes · cobertura
(dias) · P/M (preço médio das vendas do período, R$) · status (`Aberta`,
`Pedido gerado #id`, `Desativada`; pra Dlinks o StatusWeb) · campo de busca de
item (código ou descrição, `%` coringa) · botão voltar (Monitor).

**Grade de cima (itens):** Código · Descrição · Und · Emb · **Quantidade
(editável)** · Preço Und · Preço Emb · Total · Observação (editável). Linha
selecionada em destaque; linha de item desativado em vermelho, riscada,
Quantidade travada. Rodapé: `N produto(s)` · total geral (R$).

- Preço Und = último custo (Dlinks: `lista_consolidado_itens.Preco`; Fluxo:
  custo de `custoloja{loja}` da loja com custo, ou o maior entre as lojas).
- Preço Emb = Preço Und × Emb. Total = Quantidade × Preço Und.

**Grade de baixo (detalhe do item selecionado, 1 linha por loja participante):**
LJ · Última Compra · Última Venda · Fornecedor (da última compra) · Un · Emb ·
Qtd (última compra) · Preço (última compra) · Total (última compra) · Custo
Unit. · Preço Atual (venda) · Estoque Atual · PMV · Qtd Venda (período) · Dias
de Venda (dias com venda) · Média Período · Dias de Cob. · **Sugestão
Sistema** · Pedido Compra (trânsito) · ABC · **Sugestão Loja (editável)**.

Ligação entre as grades:
- Editar **Sugestão Loja** → Quantidade do item = soma das Sugestões Loja.
- Editar **Quantidade** → reparte pelas lojas proporcional à Sugestão Sistema
  (sem sugestão sistema, divide igual; a última loja fecha a conta) — mesma
  regra do `repartirPorLoja()` atual.
- Estoque zerado ou negativo aparece em vermelho (como no Dlinks).

**Barra de baixo:** Excluir/Desativar item · Ativar item · Exibir itens
(`Todos` / `Com quantidade` / `Sem giro` = sem venda no período) · Excel ·
Imprimir · **Gerar Pedido**.

## 3. A conta (sugestões do Fluxo)

Por loja participante e produto da lista (`c_cotacao_lista_itens` com
`l{loja}=1`, `itens.CodDesativado=0`):

```
QtdVenda        = soma de QtdNovo em ln{loja}{mês}.zcupomitens no período (soma os meses que o período cruza)
DiasVenda       = dias distintos com venda no período
dias            = dias corridos do período  (obs "Não usar dias de vendas corrido" → DiasVenda, mínimo 1)
MédiaPeríodo    = QtdVenda ÷ dias
Estoque         = estoquen{loja}.Qtd          (obs "Não considerar estoque do Sistema" → 0)
Trânsito        = unidades em sugestões/pedidos abertos (mesma fonte do Radar, `radarPedidos` base.transito)  (obs "Considerar itens em trânsito" desligado → 0)
DiasCob         = Estoque ÷ MédiaPeríodo   (MédiaPeríodo = 0 → ∞, mostrado como "—")
SugestãoSistema = max(0, round(Cobertura × MédiaPeríodo − Estoque − Trânsito))
```

Outros campos: Última Compra / Fornecedor / Qtd / Preço / Total da última
compra e Custo Unit. de `custoloja{loja}`; Última Venda de `zcupomitens`;
Preço Atual = `central.itens.P{loja}` (mesma fonte da Formação de Preço); PMV
= valor vendido ÷ quantidade vendida da loja no período (0 sem venda); ABC
pela curva do Radar (`A` = está na curva A do Radar; senão `B` se o produto
está nos 80% acumulados da venda R$ da lista no período, `C` no resto). P/M do cabeçalho = valor
vendido ÷ quantidade vendida no período, todas as lojas.

Quantidade inicial do item = soma das Sugestões Sistema das lojas. O cálculo
roda uma vez ao criar a sugestão e fica gravado; botão **Recalcular** no
cabeçalho refaz a conta com os mesmos parâmetros (avisa que sobrescreve as
quantidades digitadas).

"Utilizar lista recebida da Indústria" fica desabilitado nesta rodada (tabela
não mapeada). Os 3 checkboxes cinzas do Dlinks continuam cinzas.

## 4. Gravação (só no Fluxo)

Novo `lib/sugestao-manual.js`, mesmo padrão de `lib/pedidos-fornecedor.js`:
um JSON por sugestão em `data/sugestoes-manuais/`.

- `F-N.json` (sugestão do Fluxo):
  ```
  { id:'F-12', criado_em, criado_por, lista:{id,nome,fornecedor,cnpj,cod_fornec},
    parametros:{ data_ini, data_fim, dias, cobertura, lojas:[..],
                 obs:{ sem_estoque, transito, dias_com_venda } },
    status:'aberta'|'pedido_gerado'|'desativada', pedido_id:null,
    pm:0, itens:[ { codigo, descricao, und, emb, preco_und, obs, ativo:true,
                    quantidade, lojas:[ { loja, ...campos do detalhe..., sug_sistema, sug_loja } ] } ] }
  ```
- `D-4380.json` (ajustes numa sugestão do Dlinks): só `{ id:'D-4380',
  quantidades:{codigo:{loja:qtd}}, obs:{codigo:texto}, inativos:[codigos],
  status, pedido_id }`. O resto vem do ERP a cada abertura.
- Salvamento automático a cada edição (debounce 600 ms) via `PATCH`. Sem
  botão Salvar. Indicador discreto "salvo" no cabeçalho.

## 5. API (server.js)

| Rota | Faz |
|---|---|
| `GET /api/sugestoes-compra` | Já existe; passa a concatenar as do Fluxo (`origem:'fluxo'`) com as do Dlinks (`origem:'dlinks'`) |
| `POST /api/sugestao-manual` | Body = parâmetros do modal → calcula, grava `F-N`, devolve a sugestão |
| `GET /api/sugestao-manual/:id` | `F-N` → JSON gravado; `D-N` → monta do ERP (`lista_consolidado_itens` + `historico`) e aplica os ajustes do `D-N.json` se existir |
| `PATCH /api/sugestao-manual/:id` | Salva quantidades / sugestão loja / obs / ativo / status |
| `POST /api/sugestao-manual/:id/recalcular` | Só `F-N`: refaz a conta com os parâmetros gravados |
| `POST /api/sugestao-manual/:id/pedido` | Monta `ajustes` por loja e chama a mesma função de `POST /api/pedidos-fornecedor` com `origem:'sugestao-manual'`; grava `status:'pedido_gerado'` e `pedido_id`; devolve `{pedido, link}` |
| `POST /api/sugestao-manual/:id/desativar` | Só `F-N`: `status:'desativada'` |
| `GET /api/sugestao-manual/:id/excel` | Planilha com as duas grades |

Todas as leituras do ERP são `SELECT`. Nenhuma rota escreve em `central.*`.

## 6. Gerar Pedido

Mesmo fluxo do Radar: passa pela verificação de SORTIMENTO (409 com
`bloqueados` → confirmação → reenvia com `confirmar_excesso`). Só itens ativos
com quantidade > 0 entram. Depois de criado: alerta com nº do pedido e link do
vendedor, marca a sugestão como `pedido_gerado` e abre `pedidos-compra.html`.
Uma sugestão com pedido gerado fica somente leitura (quantidades travadas),
com o nº do pedido no cabeçalho.

## 7. Desativar no Monitor

Checkbox por linha + botão "Desativar" (já existem). Pra selecionadas do
Fluxo: confirma e grava `status:'desativada'` (some da lista, aparece com
"Mostrar desativadas"). Pra selecionadas do Dlinks: continua só o aviso de
que não escrevemos no ERP.

## 8. Erros

- ERP fora (MySQL do .252 parado): Monitor mostra as do Fluxo e um aviso
  "Dlinks indisponível"; abrir `F-N` funciona (JSON local); abrir `D-N` mostra
  erro; criar sugestão nova mostra erro (precisa do ERP pra calcular).
- Lista sem produtos ou sem loja participante: modal avisa e não cria.
- Item da lista sem cadastro em `itens`: entra na grade com descrição "(sem
  cadastro)" e Sugestão Sistema 0.

## 9. Testes

- `lib/sugestao-manual.js` com a conta isolada (função pura
  `calcularLoja({qtdVenda, diasVenda, dias, estoque, transito, cobertura, obs})`)
  testada em `test/sugestao-manual.test.js` (`node:test`, padrão do repo): casos de dias corridos ×
  dias com venda, sem estoque, com/sem trânsito, resultado negativo → 0,
  arredondamento.
- Reparte-quantidade (`repartirPorLoja`) com casos: proporcional, sem
  sugestão sistema, última loja fecha a conta.
- Validação manual pelo Tiago: criar `F-1` pra lista 444 (mesmos parâmetros
  da sugestão 4380 do Dlinks: 15/08→15/09, cobertura 40, lojas 1-6) e
  comparar Sugestão Sistema por loja com o Dlinks (esperado: igual em ~63%
  das linhas, erro mediano < 1 un, conforme estudo de 14/09).

## Fora desta rodada

Gerar Cotação · Cadastro Fornecedor · Avarias · NFe no cálculo de venda ·
Promoção/Rebaixa/Avarias · colunas Sem Giro e Margem · lista recebida da
Indústria · Solicitar Preço Web / Enviar Link (coberto pelo link do pedido).
