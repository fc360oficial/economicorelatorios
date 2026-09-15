# Sugestão Manual — layout de referência da Consolidação (prints do Tiago, 15/09/2026)

Tiago mandou 2 prints de uma versão web da tela "Consolidação da Lista" e pediu:
**"grave aí pra nos basearmos nesse layout"**. A implementação atual
(`#consolidacao-view` em `public/sugestao-compras.html`, plano
`2026-09-15-sugestao-manual-consolidacao.md`) é o esqueleto funcional; a
próxima rodada visual deve seguir isto. Os PNGs originais podem ser
guardados em `mockups/` (ainda não estão no repo).

## Tela 1 — lista de itens (sem item selecionado)

Fundo da página branco; **cabeçalho e barra de totais em navy escuro
(#1B2430 aprox.), texto claro, destaques em verde-água/ciano**.

**Cabeçalho (navy, 1 linha alta):**
- Esquerda: dois blocos grandes "SUGESTÃO **3361**" e "LISTA **436**"
  (rótulo pequeno em caps cinza, número grande ciano) · "Fornecedor:
  **55.941.335/0001-04 S.M.S ALIMENTOS LTDA**" (CNPJ formatado + nome, em
  ciano).
- Direita (3 linhas, alinhadas à direita): "Período Vendas: **15/05/2026 até
  15/06/2026 - ( 32 Dias )**" · "Observação: **Loja(s): 1 - 2 - 3**" ·
  "Cobertura: **20 Dias** P/M: **10 Dias** Status Web: **Em Aberto**" · botão
  ✕ fechar no canto.

**Barra TOTAIS (navy mais escuro, logo abaixo):** rótulo "TOTAIS:" e 6 KPIs
em colunas separadas por linha vertical fina — Valor Total Compra (R$) ·
Receita Prevista (R$) · Total Itens · Total Volumes · Margem Prevista (—) ·
Cobertura Média Final (—). Valores em ciano; sem valor = traço amarelo.
À direita um botão roxo claro "🎩 Painel IA".

**Linha de busca:** "Item:" + input com lupa "Buscar por código ou
descrição..." + contagem "5 — Produto(s)".

**Grade de itens** (cabeçalho navy, linhas zebradas claras):
Código (mono) · Descrição (bold) · Und · Emb · **Quantidade** (célula com
fundo verde-água claro quando > 0, número bold; 0 em cinza claro) ·
**Prioridade** (badge arredondado com bolinha: 🟢 BAIXO verde, 🟡 MÉDIO
amarelo, 🟠 ALTO laranja) · Observação.
Linha inteira fica verde-água claro quando selecionada.

**Rodapé (fixo embaixo, fundo branco, borda superior):**
- Esquerda: legenda de cores (■ Promoção azul, ■ Rebaixa de Preço vermelho,
  ■ Avarias amarelo) · checkbox "Considerar NFe no cálculo de venda" ·
  checkbox marcado "Consultar Promoção / Rebaixa de Preço / Avarias".
- Direita: "Exibir Itens:" select "Todos".
- Segunda linha de botões (outline cinza, texto escuro): Abrir Solicitar
  Preço Web · Fechar Solicitar Preço Web · ✈ Enviar Link · Excluir/Desativar
  Item(ns) · Ativar Item(ns) · ⟳ [F5] Atualizar · **Gerar Cotação** (outline
  verde) · **⊙ Aceitar Sugestão Sistema** (outline azul) · **🛒 Gerar
  Pedido** (sólido azul) · Cadastro Fornecedor · … · Imprimir · **Excel**
  (outline verde).

## Tela 2 — item selecionado (painel de detalhe abre embaixo da grade)

A grade de cima continua (linha selecionada em verde-água) e abre um
**painel do produto** logo abaixo:

- **Título do painel (navy):** código em ciano + descrição em bold branco;
  à direita botão verde-água "📊 Detalhamento do Produto" e ✕.
- **RESUMO FINANCEIRO (linha branca, rótulo em ciano):** Capital Investido
  R$ · Receita Prevista R$ · Margem Prevista % (amarelo) · Total Caixas ·
  Cob. Média pós compra (—). À direita, nome do fornecedor em cinza.
- **COLUNAS:** presets em pílulas: Compacta · **Comprador** (ativo, azul) ·
  Analítica · ⚙ Personalizada · contador "19 col".
- **Grade por loja (uma linha por loja, cabeçalho cinza claro):**
  LJ · Últ.Compra · Últ.Venda · Emb · Qtd · Estoque Atual (bold) ·
  Méd.Período · Dias Cob. (bold) · Sug.Sistema (cinza) · **Pedido Compra**
  (coluna verde-água com input editável) · ABC · Status IA (🟢 OK, coluna
  lilás) · Venda Prev. · Margem Prev. (% laranja) · Investimento (coluna
  amarela) · Ruptura em (coluna vermelha clara, "OK") · Capital Parado (R$ +
  "1 un", laranja) · Prioridade (badge BAIXO + "Venda média 6.0 un/mês") ·
  vs Anterior ("Ant:6cx").
- Rodapé e barra de botões iguais à Tela 1.

## Mapeamento pro que já existe

| Print | Implementação atual | Ação na rodada visual |
|---|---|---|
| Cabeçalho navy 2 blocos + fornecedor + período/lojas/cobertura/status | `.cons-hdr` (branco, grid 4 col) | Trocar pra navy, blocos grandes, alinhar direita |
| Barra TOTAIS | não existe | Novo: Valor Total Compra = Σ qtd×preco_und; Total Itens = ativos com qtd>0; Total Volumes = Σ ceil(qtd/emb); Receita/Margem/Cobertura média = calcular quando tiver preço de venda (itens.P{loja}) |
| Coluna Prioridade (BAIXO/MÉDIO/ALTO) | não existe | Reaproveitar a regra de `classificar()` do calculador antigo: razão diasCob/cobertura ≤0,3 ALTO, ≤0,7 MÉDIO, senão BAIXO |
| Quantidade em verde-água | input `.qtd` | CSS |
| Painel do produto com Resumo Financeiro + presets de colunas | `#c-det` (tabela única de 21 colunas) | Presets: Compacta (LJ, Estoque, Méd, Dias Cob, Sug.Sistema, Pedido Compra, ABC), Comprador (o print), Analítica (todas as 21 + as novas) |
| "Pedido Compra" editável por loja | "Sugestão Loja" editável | Renomear a coluna |
| Aceitar Sugestão Sistema | não existe | Novo botão: copia sug_sistema → sug_loja em todos os itens ativos |
| Status IA / Painel IA / Venda Prev. / Ruptura em / Capital Parado / vs Anterior | não existe | Fora desta rodada (depende do Radar/IA); deixar as colunas escondidas nos presets |
| Gerar Cotação / Cadastro Fornecedor / Solicitar Preço Web / Enviar Link | não existe | Fora desta rodada (spec original) |

## Complemento (prints 3 e 4 — sugestão 3346 / lista 482, 15/09/2026)

- **Barra de baixo é fixa** (sticky no rodapé da janela): quando o painel do
  produto abre, a barra de botões continua visível sem rolar. Decisão do
  Tiago: "tem que ficar fixa".
- **Prioridade tem 4 níveis**: 🟢 BAIXO · 🟡 MÉDIO · 🟠 ALTO · 🔴 **CRÍTICO**.
  Linha do item CRÍTICO fica com fundo rosa claro e código/descrição em
  vermelho (ex.: ADES 200ML MAÇÃ, PÊSSEGO).
- Status Web no cabeçalho pode ser "Em Digitação".
- Painel do produto (preset Comprador): Sug.Sistema e Pedido Compra em azul;
  ABC "B" em azul; **Status IA** com 3 estados vistos: 🟡 "Comprar", 🟢 "OK";
  **Ruptura em** mostra badge amarelo "Ruptura em 15d" quando há risco, senão
  "OK" cinza; Investimento e Capital Parado "—" quando não há.
- Clicar no item: a grade de cima fica, o painel abre logo abaixo (não é
  modal), linha do item selecionado em verde-água.
