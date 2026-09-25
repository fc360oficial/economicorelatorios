# Fiscal: mostrar quem liberou/recusou o item na conferência XML

**Data:** 2026-09-25 · **Pedido do Tiago:** "na nota fiscal pode ficar os itens que foi liberado, ex. liberado por Tiago Freire, pra o fiscal entender quem liberou".

## Problema
Na tela do Fiscal (Notas de Entrada), o cruzamento item a item mostra avisos como "Nota 16 × pedido 4 UN"
ou "Preço acima do pedido". Quando a compradora já decidiu esse item na conferência XML do Pedido de
Compra (aceitar/recusar) ou fechou a loja com motivo, o fiscal não vê isso e não sabe quem liberou.

## Decisão de design (aprovada)
- Os avisos existentes continuam iguais (mesma cor, mesma contagem de erro/aviso).
- Acrescenta-se uma linha extra por item, só informativa:
  - item aceito: `✓ Liberado por <nome> em dd/mm (item a mais | item não pedido | preço)`
  - item recusado: `↩ Recusado por <nome> em dd/mm — devolver`
- Loja fechada com "Aceitar e fechar Loja N": NÃO aparece no card (Tiago 25/09: ficava grande e feio); `aceitos` fica disponível em `pedidoAppPorCod` sem uso na tela.
- Fonte: `p.xml.lojas[ln].itens[].decisao` / `nao_pedidos[].decisao` / `lojas[ln].aceito` dos JSONs de
  `data/pedidos-fornecedor` (já gravados por `decidirItemXml` e `aceitarLojaXml`). Nada no ERP.
- Vale também quando o ERP tem pedido próprio: a decisão do app é anexada ao item mesmo assim.

## Implementação
- `lib/fiscal.js`: `pedidoAppPorCod` devolve `decisao` por item e `aceitos[]` por pedido/loja; nova flag
  `nivel: 'info'` (`tipo: 'xml_decisao'`) no item; `checks.pedido.msg` recebe o sufixo.
- `public/fiscal.html`: CSS `.fl.info` (verde) e contagem de aviso só com `nivel === 'aviso'`.
- Teste: `test/fiscal-xml-decisao.test.js` cobre o texto da flag e o mapa do pedido do app.
