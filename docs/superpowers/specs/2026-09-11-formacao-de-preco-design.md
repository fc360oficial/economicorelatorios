# Formação de Preço (sidebar: Precificação) — design

Data: 2026-09-11. Aprovado pelo Tiago em conversa (11/09/2026), caminho "aba decide, pessoa só aplica".

## Problema

Hoje, quando a nota entra no Dlinks, ele sugere o preço pela margem cadastrada e uma pessoa
arredonda e confirma item a item. O Tiago quer que toda a inteligência (custo real com imposto,
política de repasse, arredondamento, piso) seja automática. A gravação do preço no ERP continua
manual nesta etapa (regra: **nunca escrever no MySQL do ERP**, só SELECT via .254). Gravar direto
é uma decisão futura (Fase 4), fora deste escopo.

## Decisões

- **Sidebar**: item próprio no bloco "Operação", no mesmo nível de Gestão de Compras, chamado
  **Precificação** (`ic: 'tag'`, ou `trend` se não houver ícone de etiqueta no sprite). Sem
  acordeão: link direto pra `/formacao-de-preco.html`. Respeitar a ordem alfabética do bloco:
  CAHU Distribuidora, Financeiro, Gestão de Compras, **Precificação**, Prevenção, Processos.
- **Tela**: título "Formação de Preço".
- **Entrada automática**: um pedido/loja entra na Formação de Preço quando a loja fica
  `conciliado` na conferência XML, ou quando a compradora usa "Aceitar e fechar Loja N"
  (`aceitarLojaXml`). Unidade de trabalho = **pedido × loja** (igual às linhas por loja de
  Pedidos de Compra). Um pedido conciliado em 3 lojas vira 3 registros.
- **Três custos por item**: atual (ERP), novo (XML, unitário tributável) e com imposto
  (novo + ST + IPI + frete − desconto, rateados por item). O preço parte do **custo com imposto**.
- **Política de custo caído** (seletor no cabeçalho, salva por registro, padrão "por curva"):
  `manter` (preço fica, margem sobe) · `repassar` (preço desce) · `por_curva` (curva A repassa,
  demais mantêm). Custo subido recalcula sempre, em qualquer política.
- **Arredondamento** (seletor, padrão 9): terminação `9`, `5` ou `nenhum`. Sempre pra cima, nunca
  abaixo do calculado. Piso absoluto: preço final ≥ custo com imposto.
- **Sem mudança**: custo com imposto dentro de ±0,5% do custo atual → item `sem_mudanca`, sai da
  lista de ação (continua visível num filtro).
- **Sem margem cadastrada** na loja → item `bloqueado`, com aviso e link pra Lista de Compra >
  Cadastro Pendente. Não entra na lista final até a margem existir (recalcular depois).
- **Saída** = lista final por loja pra digitar no Dlinks: tela, PDF por loja e WhatsApp com o
  link do PDF. Depois de "Marcar como aplicado", uma verificação lê o preço atual do ERP e marca
  divergência item a item.
- **Não faz**: não grava no ERP, não mexe em promoção, não olha concorrente, não gera etiqueta
  (gancho futuro pro módulo Etiquetas do FC360).

## Fontes de dados (ERP `central`, só leitura via .254)

| Dado | Fonte |
|---|---|
| Custo atual por loja | `custoloja{N}` (mesmo campo já usado em `ultimo_custo` do pedido) |
| Preço atual por loja | tabela de preço por loja já lida em `server.js` (`P1..P6`, função `parsePreco`), mesma consulta da Lista de Compra |
| Margem por loja | `itens_margens` (`CodigoBarra`, `nLoja`, `MargemVarejo`, `MargemAtacado`); atacado só L4 |
| Custo novo | `axmlprodutos.ovUnTrib` (unitário tributável), quantidade `oqTrib` — já lidos na conferência |
| Impostos e frete | colunas por item de `axmlprodutos` (ST, IPI, frete, desconto). **Primeira tarefa da implementação**: `DESCRIBE central.axmlprodutos` e `DESCRIBE central.axml` no .254 pra fixar os nomes. Se só existir no cabeçalho (`axml`), ratear o total pelo `ValorTotal` de cada item |
| Curva A | `radar.getEstado()` → flag `curvaA` por produto (já calculada: produtos que somam 50% da venda) |
| Itens/quantidades recebidas | `p.xml.lojas[N].itens` do pedido (`recebida`, `preco_xml`) |

Nota do XML por item: o vínculo com o produto usa a mesma regra da conferência (`CodigoBarras`,
fallback `ocEanTrib`).

## Cálculo (por item, por loja)

```
custo_atual      = custoloja{N}
custo_novo       = ovUnTrib
custo_imposto    = ovUnTrib + (ST + IPI + frete − desconto) / oqTrib   // rateio por unidade
variacao         = custo_imposto / custo_atual − 1
margem           = MargemVarejo da loja (L4: também MargemAtacado → preco_atacado)
preco_calc       = custo_imposto × (1 + margem/100)
preco_atual      = P{N}
margem_se_mantem = preco_atual / custo_imposto − 1

status:
  sem margem                       → bloqueado
  |variacao| ≤ 0,5%                → sem_mudanca, preco_sugerido = preco_atual
  variacao > 0,5%                  → sobe, preco_sugerido = arred(preco_calc)
  variacao < −0,5%:
     politica manter               → mantem, preco_sugerido = preco_atual
     politica repassar             → desce, preco_sugerido = arred(preco_calc)
     politica por_curva            → curvaA ? desce : mantem
piso: preco_sugerido = max(preco_sugerido, custo_imposto)  (marca 'piso' se bateu)
```

`arred(v, term)`: `nenhum` → 2 casas; `9` → menor valor ≥ v com centavos terminados em 9
(0,09 · 0,19 · … · 0,99); `5` → idem com 5. Nunca arredonda pra baixo.

Margem é a **margem sobre custo** (mesmo conceito do Dlinks e do `margem` já calculado em
`server.js`: `(preco − custo) / custo`). O campo "margem se mantém" usa o mesmo conceito.

Se `preco_atual` for 0 ou nulo (produto novo na loja), status `sobe` e `margem_se_mantem` = null.

## Fluxo e status do registro (pedido × loja)

```
a_precificar  → criado na conciliação; cálculo feito na hora
precificado   → alguém abriu, revisou (pode editar preço final item a item) e clicou "Fechar lista"
aplicado      → "Marcar como aplicado" depois de digitar no Dlinks; guarda quem/quando
conferido     → verificação leu o ERP: todos os itens batem (±R$0,01) ou divergências listadas
```

Reabrir de `precificado` pra `a_precificar` é permitido (recalcula com política/arredondamento
novos; edições manuais são preservadas por item enquanto o custo com imposto não mudar).
Trocar política ou arredondamento no cabeçalho recalcula só os itens **não editados à mão**.

Verificação: roda 2 min após subir e a cada 60 min para registros `aplicado` com menos de 7 dias;
compara `P{N}` do ERP com `preco_final`. Também tem botão "Verificar agora".

## Tela `public/formacao-de-preco.html`

Padrão visual: Executive Ink (`design-system.css`, `nav.js`), mesma estrutura de Pedidos de Compra.

- **Cabeçalho**: título "Formação de Preço"; filtros: loja, status, busca (pedido, lista,
  fornecedor, produto); seletores globais de política e arredondamento (valem como padrão pra
  registros novos; cada registro guarda o seu).
- **Cards-filtro**: A precificar · Precificados · Aplicados · Divergentes · Bloqueados (itens).
- **Tabela** (uma linha por pedido × loja): # pedido · Loja · Lista / Fornecedor · Conciliado em ·
  Itens · Sobem · Descem · Mantêm · Sem mudança · Bloqueados · Status · Ação (Abrir / PDF).
- **Detalhe** (overlay, como nos pedidos): cabeçalho com pedido, lista, loja, política e
  arredondamento do registro (editáveis), totais. Tabela por item:
  Código · Descrição · Curva (A ou —) · Qtd recebida · Custo atual · Custo novo · Custo c/ imposto ·
  Var. % (▲ vermelho sobe / ▼ verde desce, convenção de custo) · Margem cad. · Preço atual ·
  Margem se mantém · Preço sugerido · **Preço final** (input) · Status do item.
  L4 mostra também Preço atacado atual / sugerido / final.
  Filtro rápido: só o que muda · tudo · bloqueados. Linha editada à mão ganha marca "manual".
  Botões: Recalcular · Fechar lista (→ precificado) · PDF · WhatsApp · Marcar como aplicado ·
  Verificar agora (aplicado) · Reabrir.
- **Aplicado/conferido**: coluna extra "Preço no ERP" e badge "divergente" por item.

## Saídas

- **PDF por loja** (`pdfkit`, A4 retrato, logo preta `logo-supermercados.png`, mesma família dos
  PDFs de pedido): cabeçalho (loja, pedido, lista, fornecedor, data, política, arredondamento),
  tabela só com itens que mudam (código, descrição, preço atual → preço final, e atacado na L4),
  bloco final com bloqueados. Arquivo `data/precificacao/<id>-L<N>.pdf`.
- **WhatsApp**: `wa.me/55<numero>?text=` com resumo (N itens sobem, N descem) + link do PDF
  (rota interna, exige login — quem aplica está na rede). Número escolhido na hora (não há
  cadastro de "quem precifica"), com os contatos do cadastro da lista como sugestão.

## Persistência e módulo

- `lib/precificacao.js`: `init(dir)`, `initERP(q, radar, pedidosFornec)`, `criarDeConciliacao(p, ln)`,
  `calcular(reg)`, `listar(filtros)`, `obter(id)`, `editarItem(id, cod, precoFinal)`,
  `setParametros(id, {politica, arredondamento})`, `fechar(id)`, `reabrir(id)`, `aplicar(id, usuario)`,
  `verificar(id)`, `verificarTodos()`, `gerarPdf(id)`, `arred(v, term)` (exportada pra teste).
- Um JSON por registro em `C:\fc360\claude_code_\data\precificacao\<pedidoId>-L<N>.json` no .254
  (fora do git), id = `"<pedidoId>-L<N>"`.
- Gatilho: `conferencia-xml.js`, ao marcar uma loja `conciliado`, e `aceitarLojaXml`, chamam
  `precificacao.criarDeConciliacao(p, ln)` (idempotente: se o id já existe, não recria).
  Pedidos de teste (`p.teste`) também entram, marcados `teste:true`, e somem em "Remover testes".
- Rotas em `server.js` (antes do `app.listen`, protegidas por login):
  `GET /api/precificacao` · `GET /api/precificacao/:id` · `POST /api/precificacao/:id/item` ·
  `POST /api/precificacao/:id/parametros` · `POST /api/precificacao/:id/fechar` · `.../reabrir` ·
  `.../aplicar` · `.../verificar` · `POST /api/precificacao/verificar` · `GET /api/precificacao/:id/pdf` ·
  `POST /api/precificacao/:id/recalcular`.
- `verificarTodos()` agendado em `server.js` junto com `verificarRecebimentos` (2 min após subir,
  depois a cada 60 min).

## Erros e limites

- Item do XML sem produto casado no ERP: aparece como `bloqueado` com motivo "não casado" (já é
  problema na conferência; aqui só reflete).
- Produto sem `P{N}` (novo na loja): tratado como preço atual 0 (status `sobe`).
- Colunas de imposto ausentes na tabela do XML: custo com imposto = custo novo − desconto, e o
  cabeçalho do detalhe avisa "impostos não disponíveis no XML".
- Conciliação com itens `a_mais` aceitos ou `nao_pedido` aceitos: entram normalmente (a decisão
  de aceitar já foi tomada). Recusados não entram.
- Recálculo nunca apaga edição manual; "Recalcular" tem opção "descartar edições manuais".

## Testes

- Unitário puro (sem ERP) em `test/precificacao.test.js` (node:test): `arred` (9, 5, nenhum,
  valores já terminados, limites de centavos), `calcular` com os 4 casos (sobe, desce em cada
  política, sem mudança, bloqueado, piso, preço atual 0, L4 atacado).
- Fluxo: os pedidos de teste da conferência XML (#25 conciliado e #27 preço +8%) devem gerar
  registros na Formação de Preço; validar em produção com esses antes de nota real.
- Não validado ainda: nomes das colunas de ST/IPI/frete do XML (primeira tarefa do plano).
