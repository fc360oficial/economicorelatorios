# Conciliação de Entradas

## Contexto

O Financeiro hoje só tem **Conciliação de Saídas** (`/conciliador.html`) e **CD**
(`/conciliador-cd.html`), ambos cruzando saídas do extrato Itaú contra o que o ERP tem
lançado (ver [[project_conciliador-bancario]] e [[project_conciliador-cd]]). Não existe nada
que olhe pro que **entrou** na conta — cartão de débito/crédito, PIX recebido, boleto pago por
cliente, etc.

O pedido do Tiago foi puxar do extrato bancário "o que entrou" (ex: repasse de cartão de
débito) no mesmo modelo da tela de Saídas. Investigação no schema do ERP (`192.168.2.252`, via
SSH no `.254`, só leitura) achou duas realidades bem diferentes por tipo de entrada:

- **Boleto/crediário (B2B e clientes cadastrados):** `cargaaux.fatura` +
  `cargaaux.faturabaixa` têm dado real, diário, das 7 unidades (as 6 lojas + CD/loja 10 — CD
  concentra ~80% do volume, R$39M em aberto, mas as lojas 1-6 também usam pra crediário de
  clientes fixos). Granularidade e estrutura equivalentes a `contasapagar`/`contasapagarbaixaconta`
  — dá pra casar linha a linha do mesmo jeito que Saídas já faz.
- **Cartão débito/crédito:** a única fonte com dado real é `dashboard.tipovendas`
  (`nLoja, Mes, Ano, TipoPagto, Total` — mesma tabela do relatório "Formas de Pagamento" já
  existente), e ela só tem **total mensal**, sem data. Tabelas que teoricamente guardariam o
  lançamento diário por forma de pagamento (`loja20045.cartaomaquineta`,
  `loja20045.cartaolancamento`, `supermercado.zcupompagto`, `central.recebivel*`) existem no
  schema mas estão **vazias** (confirmado com `COUNT(*)` real, não só estatística de tabela) —
  nunca foram populadas/ativadas nessa instalação do Dlinks. Não é uma tabela errada escolhida,
  é dado que simplesmente não existe hoje no ERP.

Por isso o desenho trata os dois casos de forma diferente: boleto/crediário ganha o mesmo
motor de casamento linha-a-linha de Saídas; cartão débito/crédito vira uma conferência
agregada por mês (sem fingir uma precisão diária que a fonte de dado não sustenta).

## Escopo

Cobre, na mesma tela, todas as entradas do extrato (valor positivo) do período/loja
selecionados:

- **Boleto/depósito B2B e crediário** → casamento linha a linha contra `cargaaux.fatura` /
  `cargaaux.faturabaixa`.
- **Cartão débito/crédito** → soma do período, comparada contra o total do(s) mês(es)
  correspondente(s) em `dashboard.tipovendas`, mostrando a diferença agregada. Sem casamento
  por depósito individual.
- **PIX recebido avulso** (sem fatura vinculada) e **outras entradas** (estorno, resgate de
  aplicação, transferência entre contas próprias, etc.) → só categoriza e lista, mesmo espírito
  do "fora do escopo" de Saídas. Fica pronto pra virar casamento de verdade no futuro se
  aparecer uma fonte melhor.

Fora de escopo desta versão:
- Regra automática/permanente (equivalente ao que existe em Saídas) — pode vir depois,
  seguindo o mesmo padrão, mas não faz parte deste primeiro corte.
- Confirmação avulsa manual (equivalente a `conciliacoes-avulsas.json` de Saídas) — mesma
  lógica, fica pra uma iteração seguinte se o dia a dia mostrar necessidade.
- Qualquer tentativa de achar/ativar fonte diária de cartão dentro do ERP (fora do controle
  deste projeto — dependeria do módulo `recebivel`/`recebivel_configuracao` ser configurado do
  lado do Dlinks, que é outro fornecedor).

## Fonte de dados e casamento — Boleto/crediário

**Tabelas:**
- `cargaaux.fatura` — título em aberto: `nFatura, CodCliente, Nloja, DataVenda, DataVencto,
  Valor, EmAberto, TipoFatura, Obs`.
- `cargaaux.faturabaixa` — baixa já lançada: `nFatura, DataPagto, ValorPago, Restante, nLoja`.
- `cargaaux.cliente` — nome do cliente (`Nome`, `Empresa`, `CPF`) pra casar com o favorecido do
  extrato, mesmo padrão de `similaridadeNome()` já usado em Saídas/CD.

**Motor (`lib/conciliador-entradas.js`, nova função `conciliarEntradas()`):** reaproveita as
funções já existentes e exportadas de `lib/conciliador.js` (`normalizarNome`,
`similaridadeNome`, `addDias`, `TOLERANCIA_DIAS`) — mesma tolerância de 5 dias e mesma
tolerância de valor (±15) pra cobrir juros/desconto de pagamento fora do prazo. Diferença
central pro motor de Saídas: aqui o candidato pode estar **em aberto** (`fatura.EmAberto > 0`,
ainda não baixado no ERP) ou **já baixado** (existe linha em `faturabaixa` com
`DataPagto`/`ValorPago` batendo) — os dois casos entram no mesmo pool de candidatos por
loja+período, já que o objetivo é achar qual fatura aquele depósito quita, esteja ela baixada
ou não.

Status final por item (mesma nomenclatura de Saídas, adaptada):
- `conciliado` — bateu com uma fatura já baixada no ERP (`faturabaixa` existe com valor/data
  compatíveis) — tudo consistente.
- `baixa_pendente` — bateu com uma fatura em aberto (`EmAberto > 0`, sem baixa lançada) — o
  cliente pagou, mas ninguém deu baixa no título ainda (equivalente ao achado de
  `baixa_pendente` em Saídas, ver [[reference_erp-baixa-contasapagar]]).
- `revisar` — mais de um candidato plausível (2+ faturas do mesmo valor/cliente na janela).
- `nao_encontrado` — nenhuma fatura compatível.
- `fora_escopo` — entrada não categorizada como boleto/depósito B2B (cartão, PIX avulso,
  outras).

## Fonte de dados — Cartão débito/crédito (conferência agregada)

Sem casamento por linha. Ao processar o extrato:
1. Soma todas as entradas do período categorizadas como `cartao` (ver categorização abaixo),
   separando débito de crédito quando o histórico do banco permitir distinguir (senão entra
   como "cartão" genérico).
2. Busca em `dashboard.tipovendas` o total do(s) mês(es) cobertos pelo período, por
   `nLoja`+`TipoPagto` (`01`=PIX/Débito, `02`=Crédito — reaproveita `pagtoLabels` já definido
   em `server.js`).
3. Mostra um card "Cartão (conferência mensal)" com banco vs. ERP e a diferença — não entra na
   contagem de conciliado/revisar/não encontrado dos itens individuais, é um indicador à parte.

**Cuidado de UI:** deixar claro que essa comparação é só do mês (não do período exato
selecionado, se o período cruzar meses) e que não é conciliação linha a linha — evita o Tiago
interpretar "3 pendentes de cartão" como se desse pra apontar qual depósito específico está
faltando.

## Categorização do extrato (`lib/extrato-parser.js`)

Nova função `parseEntradas()` (TXT/OFX) e `parseEntradasApi()` (API Itaú), espelhando
`parseSaidas*` só que filtrando **valor positivo** em vez de negativo. Categorias:

- `cartao` — histórico contém nome de adquirente/operadora conhecida no extrato Itaú
  (`REDE`, `CIELO`, `GETNET`, `STONE`, `PAGSEGURO`, `MERCADOPAGO` — lista extensível em
  constante `OPERADORAS_CARTAO`, igual ao padrão de listas de prefixo já usado no arquivo).
- `pix_recebido` — histórico começa com `PIX RECEBIDO` (mesmo padrão de `PIX ENVIADO` já
  tratado hoje).
- `deposito_boleto` — `BOLETO RECEBIDO`, `DOC RECEBIDO`, `TED RECEBIDO` ou depósito
  identificado por CNPJ/CPF no histórico (mesma extração de `extrairDocumento()` já existente,
  reaproveitada sem mudança).
- `outro` — resto (resgate de aplicação, transferência entre contas próprias, estorno, etc.).

`pix_recebido` e `deposito_boleto` entram no pool que tenta casar contra `cargaaux.fatura`
(ambos podem ser pagamento de cliente); `cartao` vai pra conferência agregada; `outro` fica
`fora_escopo`.

## Backend — endpoints (`server.js`)

Mesmo padrão de `/api/conciliador/*`, nova seção `/api/conciliador-entradas/*`:

- **`POST /api/conciliador-entradas/processar`** — body `{ loja, periodoDe, periodoAte,
  extratoTexto }` (TXT) ou multipart OFX (mesmo tratamento de upload já existente em
  `/api/conciliador/processar`). Roda `parseEntradas()` → busca candidatos em
  `cargaaux.fatura`/`faturabaixa`/`cliente` pra loja+janela → `conciliarEntradas()` → busca
  `dashboard.tipovendas` do(s) mês(es) → monta card de cartão → retorna itens + totais.
- **`POST /api/conciliador-entradas/processar-api`** (admin only, mesmo gate de
  `/api/conciliador/processar-api`) — usa `lib/itau-extrato.js` já existente
  (`buscarExtrato`) e `parseEntradasApi()`, resto igual.

Reaproveita a função `q()` e `dbConfig` já existentes — nenhuma configuração nova de conexão.

## Frontend

Novo `public/conciliador-entradas.html`, mesmo layout/CSS de `conciliador.html` (seletor de
loja, período de/até, colar extrato ou "Importar via Itaú", cards de resumo no topo). Cards de
resumo trocam pra: Total de entradas, Conciliado, Baixa pendente, Revisar, Não encontrado, Fora
do escopo — mais o card separado "Cartão (mês)" descrito acima.

`nav.js`: novo item dentro do grupo `financeiro`, logo abaixo de "Conciliação de Saídas":

```js
{ href: '/conciliador.html', ic: 'bank', txt: 'Conciliação de Saídas' },
{ href: '/conciliador-entradas.html', ic: 'bank', txt: 'Conciliação de Entradas' },
{ href: '/conciliador-cd.html', ic: 'bank', txt: 'CD' }
```

## Erros e casos de borda

- Fatura já baixada mas o valor da baixa (`faturabaixa.ValorPago`) diverge um pouco do
  depósito (desconto por antecipação, por exemplo) → mesma tolerância de ±15 usada em Saídas;
  fora disso cai em `revisar` em vez de assumir.
- Cliente com duas faturas do mesmo valor vencendo perto uma da outra → `revisar`, mostra as
  candidatas, não escolhe sozinho (mesmo princípio de Saídas/CD — nunca decidir entre dois
  títulos reais).
- Período selecionado cruza dois meses → card de cartão soma `dashboard.tipovendas` dos dois
  meses envolvidos, com rótulo deixando claro quais meses entraram na conta.
- `dashboard.tipovendas` sem linha pro mês/loja (mês corrente ainda não fechado, por exemplo) →
  card mostra "sem dado do ERP pra esse mês" em vez de comparar contra zero (que pareceria
  "100% divergente" e é enganoso).
- Loja sem nenhuma fatura em `cargaaux.fatura` no período (lojas 1-6 têm bem menos volume que a
  CD) → tudo cai em `fora_escopo`/`nao_encontrado` normalmente, sem erro — é esperado, não é
  bug.

## Testes / verificação manual

Projeto não usa framework de testes automatizados — verificação manual na tela, como o resto
do Conciliador.

- Depósito de cliente da CD (loja 10) que bate valor+data com uma fatura já baixada em
  `faturabaixa` → status `conciliado`.
- Depósito que bate com fatura em aberto (`EmAberto > 0`, sem baixa) → status `baixa_pendente`.
- Depósito de valor comum a duas faturas do mesmo cliente vencendo na mesma semana → `revisar`,
  as duas aparecem como candidatas.
- Depósito sem nenhuma fatura compatível → `nao_encontrado`.
- Entrada categorizada como `cartao` → não aparece nos itens individuais pra conciliar, soma
  certo no card "Cartão (mês)" e o total bate contra `dashboard.tipovendas` puxado à mão pro
  mesmo loja/mês.
- Item `outro` (ex: resgate de aplicação automática) → `fora_escopo`, aparece na lista mas não
  tenta casar.
- Item do menu "Conciliação de Entradas" aparece logo abaixo de "Conciliação de Saídas" no
  grupo Financeiro, leva pra tela nova.
