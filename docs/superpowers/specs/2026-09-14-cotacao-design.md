# Cotação — estado do projeto (14/09/2026)

Documento pra continuar o módulo em qualquer máquina. Tudo que importa está no repositório
`github.com/fc360oficial/economicorelatorios` (branch `main`); o .254 só roda a cópia publicada.

## Onde está cada coisa

| O quê | Onde |
|---|---|
| Página do protótipo (6 telas, dados fictícios) | `public/cotacao.html` |
| Item no menu Gestão de Compras | `public/nav.js` (grupo `compras`) |
| Cópia publicada no servidor | `C:\fc360\claude_code_\public\cotacao.html` no .254 (não editar lá; deploy sobrescreve) |
| Deploy | `git push origin main` → `curl https://hhk0a8gt2cn.sn.mynetname.net/deploy?token=fc360deploy2026` → ~40 s → `/api/versao` |
| Dados dos pedidos do Radar (já em produção) | `C:\fc360\claude_code_\data\pedidos-fornecedor\*.json` no .254 |

## O que o protótipo tem

1. **Monitor de Cotações** — filtros (nº, status, empresa, comprador), colunas Pedidos / Produtos /
   Concorrentes com contadores clicáveis (abrem modais: produtos da cotação, digitados, comprados,
   requisições por loja, fornecedores com filtros oferta anterior/atual/status), relatório de
   análise de preço por cotação, observação (condição de pagamento, enviado por).
2. **Nova Cotação** — wizard 3 passos: produtos (com estoque, venda 30 d, cobertura, margem) →
   fornecedores → resumo e envio por WhatsApp com link único.
3. **Acompanhamento** — KPIs, status por fornecedor, chat com o fornecedor.
4. **Página pública do fornecedor** — sem login, digita preço por item, link temporário.
5. **Comparativo** — última compra × preço de cada fornecedor, melhor preço, economia, análise
   (boa oportunidade / atenção / evitar), histórico de preço do produto, detalhe por loja,
   total por fornecedor, gerar pedido de compra (um por fornecedor vencedor).
6. **Pedidos** — um por fornecedor vencedor e por loja; status interno × status ERP; menu de
   ações (ver itens, confirmar entrega, avaliar vendedor, reenviar, WhatsApp, PDF, cancelar).

## Decisões já tomadas em módulos vizinhos (reaproveitar)

- Link público pro vendedor: `PUBLIC_URL` (DDNS via Caddy), token por pedido, página
  `public/pedido-fornecedor.html` + `lib/pedidos-fornecedor.js` — a página do fornecedor da
  cotação deve nascer desse código (digitação em centavos: 545 = 5,45, Enter pula pro próximo,
  logo à esquerda, razão social "ECONOMICO SUPERMERCADO - REDE CAHU").
- Pedido é POR LOJA depois da aprovação; conferência XML por loja (`lib/conferencia-xml.js`);
  recusa gera nota de devolução, nunca carta de crédito.
- ERP (MySQL .252) é SOMENTE LEITURA e só acessado via .254. Nada de escrita em `central.*`.
- Fonte das listas/produtos: `central.c_cotacao_lista` + `c_cotacao_lista_itens` (l1..l6 = loja
  marcada), fornecedor `central.fornecedor`, vendedor `c_cotacao_agenda`, comprador
  `c_cotacao_agenda_comprador`. Sugestão do ERP: `lista_consolidadas` (período de venda e
  cobertura) + `lista_consolidado_historico` (por loja), fórmula
  `cobertura × (venda do período ÷ dias) − estoque − trânsito`.
- Sortimento (aba na Lista de Compra) fica como relatório; o Radar NÃO marca mais em vermelho.

## Próximos passos sugeridos

1. Aprovar o desenho tela a tela com as compradoras.
2. Ligar o Monitor em dados reais: tabela própria em `data/cotacoes/*.json` (mesmo padrão dos
   pedidos), com nº, lista, produtos, fornecedores convidados, prazo, status.
3. Página pública do fornecedor a partir de `pedido-fornecedor.html`.
4. Comparativo com "última compra" vinda de `central.compras`/`custoloja{N}`.
5. "Gerar pedido" reaproveitando `pedidosFornec.criar` (já vai pra Pedidos de Compra).
