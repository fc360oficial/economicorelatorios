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

## MÓDULO REAL (14/09/2026, noite) — protótipo virou módulo ligado em dados reais

Fluxo descrito pelo Tiago: "na parte de cima sugestão de compra, digito a lista (ex. 277) e a partir
dessa sugestão faz que nem o Radar; depois o preço de cotação (manda pros vendedores porem o preço);
analiso fornecedor a fornecedor quem ganhou; envio o pedido pra cada um; fechando a cotação, os pedidos
vão pra tela de Pedidos de Compra pra conferir do mesmo jeito do Radar".

| O quê | Onde |
|---|---|
| Regras e persistência (1 JSON por cotação, `data/cotacoes/`, fora do git) | `lib/cotacao.js` |
| Rotas `/api/cotacoes*` e públicas `/cotacao/:token`, `/api/cotacao-publica/:token` | `server.js` (bloco COTAÇÃO, depois dos pedidos ao fornecedor) |
| Tela (Monitor · Nova Cotação · Acompanhamento · Comparativo · Pedidos) | `public/cotacao.html` (`?id=N&tela=s3`, `?lista=277`) |
| Página pública do fornecedor (nasceu de `pedido-fornecedor.html`) | `public/cotacao-fornecedor.html` |
| Lista sem lead (277) na sugestão | `radar-pedidos.itensLista(..., paramsPadrao={alvo,ponto})` |
| Vínculo pedido→cotação (badge em Pedidos de Compra) | `pedidos-fornecedor.vincularCotacao`, `p.cotacao`, `parametros.origem='cotacao'` |

- **Sugestão** = `GET /api/cotacoes/sugestao/:lista?cobertura=28&ponto=3&emb=` → Radar por loja
  (piso/teto/embalagem real). Lista com lead usa o lead real; sem lead (277) usa cobertura+prazo da tela.
- **Cotação** = itens com qtd por loja + N fornecedores, cada um com token/link próprio; fornecedor
  digita preço unitário (centavos, Enter pula), condição de pagamento e observação; não vê custo nem
  concorrentes. Status do fornecedor: aguardando → digitacao → finalizado. Status da cotação:
  aberta → fechada | cancelada.
- **Comparativo** = menor preço vence por item; compradora clica pra trocar vencedor ou marcar
  "não comprar" (`c.vencedores[cod]`); economia × último custo do ERP; total por fornecedor.
- **Fechar** = `POST /api/cotacoes/:id/fechar` → 1 pedido por vencedor via `pedidosFornec.criar` +
  `salvarPrecos` + `finalizar` + `aprovar` → **entra em Pedidos de Compra JÁ APROVADO, uma linha por
  loja**, com `parametros.origem='cotacao'` + `p.cotacao` (selo COTAÇÃO #id na lista). A aprovação já
  aconteceu dentro da cotação (comparativo / pré-pedido). PDF, XML e ruptura iguais ao Radar;
  **avarias NÃO são consultadas pra pedido de cotação** (regra 25/09/26, só deles: `anexarAvarias`
  ignora origem 'cotacao', inclusive no Reconsultar).

Pendente: testar com a lista 277 real no .254 (Radar precisa estar calculado); envio ao vendedor é
WhatsApp manual (igual aos pedidos); histórico de preço por produto olha só cotações anteriores do app.
