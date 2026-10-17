# Econômico Relatórios — regras do repositório

## Telas de compras: Radar de Pedidos → Análise de Compras → Pedidos de Compra

Essas três telas são usadas em sequência pelo(a) comprador(a) (Tiago, 07/10/2026: "são três telas que
sempre vão ser usadas em sequência, então sempre manter o layout parecido uma da outra").

- A escala tipográfica e o respiro das três ficam em **`public/compras-layout.css`**, carregado depois do
  `<style>` de cada página (`radar-pedidos.html`, `pedidos-compra.html` — esta serve Análise de Compras e
  Pedidos de Compra). Mudança de fonte, altura de linha ou espaçamento numa delas é feita **nesse arquivo**,
  nunca só numa página.
- As três usam os mesmos nomes de classe pros mesmos elementos: indicadores `.totais > .tkpi (.v/.l)`,
  tabela principal `table.main-t` com `.nm` / `.sub` / `.s2`, detalhe `.det .box .hd` (barra escura),
  tabela por produto `table.ppg` com `td.prod`, `.pp-meta`, `td.st input.qin`. Tela ou bloco novo no fluxo
  de compras reaproveita esses nomes e carrega o mesmo CSS.
- Rótulo de loja é sempre `E1..E6` e `CD` (loja 10), em todas as telas.
- O Dashboard (`index.html`, bloco Financeiro `#s6`) segue a mesma escala com CSS próprio.

## Toda tela se adapta a qualquer monitor (regra geral, Tiago 16/10/2026)

As telas foram feitas num monitor grande (diretor) e quebravam no monitor menor do Tiago ("ele tem que
reajustar automático seja qual monitor"). Vale pra **tudo que for criado ou alterado** em `public/`:

- Nenhuma tela pode depender de uma largura de monitor. Testar, antes de publicar, em pelo menos
  **1920, 1600, 1366 e 1280 px** de largura (print headless do Chrome serve:
  `chrome --headless=new --window-size=1366,768 --screenshot=...`). Nada de rolagem lateral na página
  nessas larguras; rolagem só dentro de uma tabela, e só como último recurso.
- Largura fixa (`width`/`min-width` em px grande) em coluna, card ou grid é proibida como regra única: a
  largura base é a do monitor grande e **faixas `@media (max-width: 1599px / 1399px / 1199px)`** vão
  apertando fonte, padding, pills e botões até caber. Largura mínima de coluna fica em classe CSS, nunca
  em `style=""` inline (inline ganha do `@media` e trava o ajuste).
- Grids de cards usam `repeat(auto-fit, minmax(...))` ou `flex-wrap`, não número fixo de colunas.
- Texto de coluna (nome, empresa, status) pode quebrar linha (`white-space:normal`); número e valor não.
- Tela nova no mesmo fluxo copia as faixas da tela irmã (ex.: Monitor de Cotações em `cotacao.html`,
  bloco "16/10/26 ... reajustar automático").

## Cotação: identidade azul (Tiago, 17/10/2026)

O módulo Cotação (`public/cotacao.html`: Monitor, Nova Cotação, Acompanhamento, Comparativo, Pedidos, Fornecedores) usa a
identidade azul do briefing de 17/10/2026: cabeçalho #103454, fundo #F0F6FB, cartões brancos com borda #DCE6EF, ação #0876F9,
verde = sucesso/economia, âmbar = atenção, vermelho = erro/cancelado/custo acima.

- Tokens e componentes compartilhados (cabeçalho `.azbar`, indicadores `.kpi`, botões, campos, etiquetas `.status-pill`,
  tabelas, cartões, estados vazios, pipeline `.pipe`/`.pcard`) ficam em **`public/cotacao-azul.css`**, carregado depois do
  `<style>` da página. Cor, fonte, respiro ou componente da Cotação muda lá, nunca só numa tela.
- Azul de texto é `--pri-t` (#0B5FC5, contraste AA sobre branco); `--pri` (#0876F9) é só fundo de botão/etiqueta ativa.
- O Monitor tem duas formas (pipeline e lista) da mesma lista, com os mesmos botões de detalhe. A coluna do pipeline sai de
  `statusCot` + `pedidos_status` (`pipeCol` em cotacao.html); não existe estado novo no servidor.
- Conferência sem ERP: `node scripts/cotacao-mock/server.js` sobe a tela com cotações de exemplo (lib real, dados numa pasta
  temporária) e `node scripts/cotacao-mock/shots.js` tira os prints nas 4 larguras e mede rolagem lateral.
