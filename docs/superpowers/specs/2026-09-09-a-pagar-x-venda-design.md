# A Pagar x Venda

## Contexto

`comparativos.html` já tem uma aba **Compra x Venda** que compara compras com NF (entrada) contra
venda total por loja, com um percentual C/V% e cor por faixa (verde ≤80%, neutro ≤95%, vermelho
>95%). O Tiago quer uma aba irmã, **A Pagar x Venda**, que faz a mesma comparação só que usando
Contas a Pagar do ERP em vez de Compras — um sinal de risco de fluxo de caixa por loja (quanto a
loja tem que pagar esse mês perto do que já vendeu).

Investigação no ERP (`192.168.2.252`, via SSH no `.254`, só leitura) confirmou:

- A tabela é `loja20045.contasapagar` — apesar do nome com "loja20045", é uma tabela **única**
  para a rede inteira (não existe uma base por loja); cada título tem uma coluna `Filial`
  (1-6 = as lojas do grupo, igual ao `nLoja` usado em Compras). Existe também `Filial=10`, que é
  o CD (Centro de Distribuição) — não é uma loja de venda, então fica de fora dessa comparação.
- Campos relevantes: `Valor` (valor total do título), `Devedor` (saldo ainda em aberto),
  `DataVencto` (data de vencimento), `Filial`.
- `Status` está sempre em `0` nos vencimentos de setembro/2026 testados — não existe um filtro de
  "cancelado" equivalente ao `Status='F'` de Compras. Não é preciso (nem dá pra) filtrar por status
  nessa tabela.

## Escopo

Nova aba na mesma página `comparativos.html`, ao lado de "Compra x Venda", reaproveitando o
seletor de mês (`#sel-mes`) que a página já tem.

**Não inclui:** valores em R$ na tela (só percentual), granularidade diária/gráfico de evolução,
edição/baixa de título, ou qualquer visão que não seja o resumo por loja do mês selecionado.

## Backend

Novo endpoint `GET /api/pagar-venda?mes=N`, em `server.js`, ao lado de `/api/compra-venda`.

**A Pagar** — soma cheia do mês inteiro (não corta no dia de hoje, mesmo se `mes` for o mês
corrente, porque os vencimentos do mês já existem todos no ERP hoje, não vão "aparecendo" com o
tempo como venda):

```sql
SELECT Filial, COALESCE(SUM(Valor),0) as total
FROM loja20045.contasapagar
WHERE MONTH(DataVencto) = ? AND YEAR(DataVencto) = 2026
  AND Filial IN (1,2,3,4,5,6)
GROUP BY Filial
```

**Venda** — reaproveita a mesma lógica de `venda_total` que `/api/compra-venda` já calcula
(NFC-e via `ln{loja}mes{mm}.zcupomitens` + NF-e de saída via `central.compras`), **incluindo** o
corte "até o dia de hoje" quando `mes` é o mês corrente (`diaFiltroV`) — só a venda é parcial, a
pagar é sempre o mês cheio.

**Resposta:**

```json
{
  "por_loja": [
    { "loja": 1, "a_pagar": 249635.22, "venda_total": 180000.00, "pct": 138.7 }
  ],
  "totais": { "a_pagar": 5784318.94, "venda_total": 4200000.00, "pct": 137.7 },
  "mes": 9, "nome_mes": "Setembro",
  "diaHoje": 9, "parcial": true
}
```

`pct = a_pagar / venda_total * 100`, arredondado a 1 casa; `null` se `venda_total` for 0. Sem teto
em 100 — pode passar (ex: 138.7). `totais` é a soma das 6 lojas (rede), no mesmo formato de
`totais` em `/api/compra-venda`, para alimentar o card de KPI superior da página (mesmo padrão que
as outras abas já seguem) — só o `pct` é exibido ali (`k-tot26` = "138.7%", `k-sub26` = "A Pagar %
rede"), sem valor em R$, consistente com a regra de não mostrar valor monetário nessa aba. Os
outros 2 KPIs superiores (`k-tot25`/`k-sub25`, `k-med26`/`k-med-label`) ficam com "—" nessa aba.

## Frontend

Nova aba `tab-btn` "A Pagar x Venda" depois de "Compra x Venda" (mesmo padrão de
`setTab('pagar')`, painel `#tab-pagar`), com um subtítulo curto explicando a regra (mesmo estilo
do `#cv-subtitulo`).

Uma linha por loja (1 a 6, ordem numérica — mesma ordem das outras abas), cada linha com:

- Nome da loja (`LOJAS[l.loja]`, mesmo array já usado em Compra x Venda).
- Barra horizontal com uma escala de cor **fixa** por baixo (0-50% verde `#137A48`, 50-70% amarelo
  `#F5B800`, 70-100% vermelho `#C22F49`, mesmos tons de `var-pos`/destaque/`var-neg` já usados na
  página), coberta por uma máscara cinza-claro (`#EDEDE9`, mesmo tom do trilho das abas) que
  recua da direita pra esquerda até `min(pct, 100)%` — o efeito visual é uma barra "enchendo" da
  esquerda pra direita e trocando de cor ao cruzar cada corte, sem recalcular gradiente por loja.
- **Sem valor em R$** — só o número da porcentagem como texto ao lado da barra.
- Se `pct > 100`, a máscara recua 100% (barra toda revelada, ponta final vermelha) e o texto
  mostra o valor real sem cortar (ex: "138.7%") — não existe tratamento visual especial além
  disso, o texto já comunica o excesso.

Sem gráfico, sem linha de total/rede agregado (fora de escopo — só o comparativo por loja).

## Casos de borda

- `venda_total = 0` numa loja (raro, mas Compra x Venda já trata isso com "—"): `pct = null`,
  barra vazia, texto "—" no lugar da %. Prevalece sobre qualquer valor de `a_pagar`.
- Loja com `venda_total > 0` mas sem título a pagar no mês: `a_pagar = 0`, `pct = 0`, barra vazia
  (sem preenchimento), texto "0%".
- `Filial = 10` (CD) sempre excluído da query e nunca aparece na lista de 6 lojas.
