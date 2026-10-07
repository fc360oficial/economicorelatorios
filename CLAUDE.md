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
