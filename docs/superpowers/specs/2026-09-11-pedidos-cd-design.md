# Pedidos do CD (Centro de Distribuição) — design

Data: 2026-09-11. Aprovado pelo Tiago em conversa (11/09/2026).

## Problema

O CD (loja 10, `central.estoquen10`) estoca 187 produtos. 116 deles têm **código de caixa** (14 dígitos, DUN-14) diferente do **código de unidade** que as lojas 1–6 vendem no PDV. A tela atual "Centro Distribuição" compara estoque do CD com venda das lojas pelo mesmo código, então pra caixa a venda dá zero e a sugestão sai errada. Não existe vínculo caixa→unidade no ERP (`itens.Pai` é flag; `atacado_embalagem` está vazia).

Objetivo: tela de manutenção pra vincular caixa do CD ↔ unidade da loja, e uma sugestão semanal de pedido loja→CD **em caixas**, com as mesmas regras do Radar de Pedidos, mais acompanhamento até a mercadoria chegar na loja.

## Decisões

- **Substitui** a tela Centro Distribuição atual (mesmo nome, mesmo lugar em Gestão de Compras). Apagar `public/centro-distribuicao.html`, rotas `GET /api/compras/centro-distribuicao` e `POST .../ajustar`, `data/cd-pedido-overrides.json` e helpers relacionados em `server.js`.
- **Pedido toda segunda-feira**: ciclo fixo de 7 dias. Lead calculado do histórico por loja. Teto 28 mantido como trava.
- **Produto novo no CD** (sem venda nas lojas ou caixa sem vínculo): bloco "Novos no CD" com 1 caixa por loja, editável.
- **Pedido fica em JSON** no .254 e é acompanhado (separado no CD → chegou na loja). Sem envio a fornecedor, sem escrita no ERP (só SELECT, sempre via .254).
- Reaproveita a matemática do Radar (`lib/radar-pedidos.js`): exportar `paramsLista`, `alvoProduto`, `qtdPedido` (e `num`, `chunk`) em vez de duplicar.

## Fontes de dados (ERP `central`, só leitura)

| Dado | Fonte |
|---|---|
| Estoque CD (em caixas quando código de 14 dígitos) | `estoquen10.Qtd > 0` |
| Unidades por caixa | `embalagempadrao_venda.Qtd_venda` pelo código de 14 dígitos (cobre as 116 caixas) |
| Cadastro / ativo / validade | `itens` (`CodDesativado=0`, `Validar`, `Descricao`, `Unid`) |
| Venda das lojas (40 dias, igual Radar) | `ln{N}mes{MM}.zcupomitens` pelo **código de unidade** |
| Estoque das lojas | `estoquen1..6` pelo código de unidade |
| Custo | `custoloja1..6` |
| Expedição do CD | `painel_televendas` (nLoja=10, `CodFornec` = código de cliente da loja, Status 4 = liberado) + `conferencia_televendas` (itens por código de caixa, `Qtd` em caixas) |
| Entrada na loja | `compras` (nLoja 1–6, `CodFornec=2157` CAHU DISTRIBUIDORA, `Movimentacao='COMPRA'`) + `compraprodutos` (código de **unidade**, `Qtd` = caixas, `QtdEmb` = un/cx, `QtdEntradaEstoque` = unidades) |

Códigos de cliente das lojas no `painel_televendas` (a confirmar na primeira verificação, editável em Regras): 828 CAHU (L1), 899 MURIBECA (L2), 1300 PONTE (L3), 1421 ATACAREJO (L4), 1684 PORTA LARGA (L5), 1969 JARDIM JORDÃO (L6). Existem também 1266 JORDAO e 799 ECONOMICO; se um pedido da loja cair neles, a verificação por nota de entrada (fonte principal de "chegou") continua funcionando.

## Vínculos caixa ↔ unidade

Arquivo `data/cd-vinculos.json` no .254 (fora do git), mapa `codigoCD → { unidade, unPorCaixa, origem: 'igual'|'dun14'|'manual', confirmadoPor, confirmadoEm }`.

Regras de sugestão automática:
1. Código do CD com 13 dígitos ou menos: unidade = o próprio código (`origem: 'igual'`, 1 un/cx), já confirmado.
2. Código de 14 dígitos: candidato = EAN-13 calculado pelo padrão DUN-14 (tira o 1º dígito, pega 12 dígitos, recalcula o verificador). Se existir em `itens` ativo, vem como **sugerido** (`origem: 'dun14'`, pendente de confirmação). Hoje: 87 de 116 casam.
3. Restante: pendente, sem candidato. Busca manual por descrição ou código no cadastro de unidade (só `CodDesativado=0`).

`unPorCaixa` vem de `embalagempadrao_venda`; se ausente ou zero, o campo fica vazio e obrigatório antes de confirmar. Editável sempre (cadastro errado). Produto sem vínculo confirmado **não entra em "Repor"**; entra em "Novos no CD" com aviso "sem vínculo". Produto que aparecer no CD pela primeira vez cai na aba Vínculos automaticamente no próximo recálculo.

## Cálculo da sugestão (lib/pedidos-cd.js)

Base coletada só pros produtos vinculados (≈187 × 6 lojas): venda 40 d, estoque, custo, validade, por loja, pelo código de unidade. Trânsito = pedidos do CD no app com status `aberto` ou `separado` (unidades = caixas × un/cx), por produto/loja.

Parâmetros por loja: `lead` = média dos dias entre `painel_televendas.DataEntrada` (pedido da loja no CD) e `compras.DataRecto` da nota do fornecedor 2157 na mesma loja nos últimos 6 meses, casando por data mais próxima ≥ entrada; `lead_max` idem; `intervalo` = 7 fixo. Sem histórico: lead 2, lead_max 3. Passa por `paramsLista` do Radar (ponto = lead + segurança; alvo = min(teto 28, ponto + 7), nunca abaixo de ponto+1). `alvoProduto` aplica 60% da validade.

Quantidade: `qtdPedido` do Radar com `fazerEm = 0` e embalagem = un/cx do vínculo, loja a loja → sai em unidades múltiplas de caixa; tela mostra **caixas** (unidades ÷ un/cx). Regras herdadas: piso 1 ciclo, teto alvo+ciclo, `zera_antes` quando cobertura < lead (linha vermelha).

**CD insuficiente**: se a soma das caixas pedidas > estoque do CD em caixas, distribui as caixas disponíveis por ordem de menor cobertura (uma caixa por vez, round-robin por prioridade) e marca o produto `cd_insuficiente` com a falta em caixas — é o aviso pra comprar do fornecedor. Nunca sugere acima do estoque do CD.

**Novos no CD**: produto vinculado com `vq = 0` em todas as lojas, ou sem vínculo: 1 caixa por loja (limitado ao estoque do CD, ordem L1→L6), editável.

Recálculo automático 90 s após subir e às 05:30; botão "Recalcular" (`?refresh=1`).

## Pedidos (data/pedidos-cd/<id>.json)

Fechar pedido: seleciona linhas (checkbox, "selecionar todas"), confirma "Gerar pedidos pra N lojas?", cria **1 pedido por loja** com os itens com caixas > 0 naquela loja: `{ id, loja, criadoEm, criadoPor, status, itens:[{ codigoCD, unidade, descricao, unPorCaixa, caixas, unidades, custoUn, origem:'repor'|'novo', editado }], totais, expedicao:{...}, recebimento:{...} }`. Quantidades da tela editáveis antes de fechar (inputs L1–L6, igual Radar); edição fica marcada.

Status: `aberto` → `separado` → `recebido` | `recebido_parcial`; `cancelado` a qualquer momento antes de recebido.

Verificação (2 min após subir, a cada 30 min, botão manual):
- **separado**: existe `painel_televendas` nLoja=10, `CodFornec` = cliente da loja, `DataEntrada ≥ criadoEm`, Status 4. Guarda nPedido do CD e os itens de `conferencia_televendas` (caixas separadas por código de caixa).
- **recebido**: notas `compras` nLoja = loja, `CodFornec=2157`, COMPRA, `DataRecto ≥ criadoEm` (janela 30 d), soma `compraprodutos.Qtd` (caixas) por código de **unidade**; compara com `caixas` pedidas por item: "veio X de Y cx", ✓, "não veio". Todos ✓ → `recebido`; senão `recebido_parcial` com lista de faltas. Limite conhecido, igual aos Pedidos de Compra: casa por fornecedor+loja+data, não por número de pedido.

Aba Pedidos: cards-filtro por status, tabela (loja, data, itens, caixas, custo, andamento), detalhe com itens e recebimento, botões Cancelar / Verificar agora / Imprimir (resumo por loja, mesma prévia do Radar).

## Tela `public/centro-distribuicao.html` (nova, mesmo nome de arquivo)

Padrão visual do Radar (design-system.css, nav.js). Abas:
1. **Pedido da semana** — cabeçalho com data da próxima segunda, contadores (produtos a repor, novos, CD insuficiente, custo total). Blocos "Repor" e "Novos no CD". Colunas: descrição (caixa + unidade vinculada), estoque CD (cx), un/cx, venda un/dia total, cobertura (d), L1…L6 em caixas (inputs), total cx, custo. Filtro por texto e por loja. Barra com seleção + **Fechar pedido**.
2. **Vínculos** — filtros: pendentes / sugeridos / confirmados / todos. Colunas: código CD, descrição CD, estoque CD, un/cx (input), unidade vinculada (código + descrição), origem, ações: Confirmar / Trocar (busca) / Remover.
3. **Pedidos** — descrito acima.
4. **Regras** — lead/segurança/ponto/alvo por loja (calculados), ciclo 7, teto (input, default 28), 60% validade, códigos de cliente das lojas (editáveis), fornecedor 2157. Salvos em `data/pedidos-cd/config.json`.

## Rotas (server.js, antes do `app.listen`)

- `GET /api/pedidos-cd?refresh=1&teto=` → sugestão (repor, novos, resumo, regras, estado).
- `GET /api/pedidos-cd/vinculos`, `POST /api/pedidos-cd/vinculos` `{codigoCD, unidade, unPorCaixa}`, `DELETE /api/pedidos-cd/vinculos/:codigoCD`, `GET /api/pedidos-cd/buscar-unidade?q=`.
- `GET /api/pedidos-cd/pedidos`, `POST /api/pedidos-cd/pedidos` `{lojas:{1:[{codigoCD,caixas}],...}}`, `GET /:id`, `POST /:id/cancelar`, `POST /api/pedidos-cd/verificar`.
- `GET/POST /api/pedidos-cd/config`.

## Erros

ERP fora: rota devolve último cálculo em memória com `estado.erro`; tela mostra faixa "dados de HH:MM, ERP indisponível". Vínculo com un/cx vazio: 400. Fechar pedido com produto sem vínculo: 400 com a lista. Verificação nunca derruba o servidor (try/catch por pedido, log `[PEDIDOS-CD]`).

## Testes

- Unitários (node, sem ERP): `dun14ParaEan13`, conversão un↔cx, distribuição com CD insuficiente, decisão de status de recebimento.
- Integração no .254 antes do deploy: copiar `lib/` pra `C:\fc360\tmp`, rodar recálculo com `q` real e conferir contagens (187 produtos, 68 iguais, 87 sugeridos).
- Depois do deploy: Tiago reinicia o serviço; conferir tela, confirmar 3 vínculos, fechar 1 pedido de teste e cancelar.

## Fora de escopo

Escrita no ERP (gerar sugestão no Dlinks), pedido do CD ao fornecedor, envio automático por WhatsApp.
