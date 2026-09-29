# Plano · Expedição do CD no Coletor (loja 10)

Spec: `docs/superpowers/specs/2026-09-29-coletor-cd-expedicao-processo.md` · Mockup: https://claude.ai/artifact/X8GGMLQW8dSfQVGc6rHpcr
Já feito antes deste plano: loja 10 no coletor, DANFE, recontagem única, validade obrigatória, lote no Recebimento da loja 10.

## Fontes no ERP (só leitura no .252; espelho só no MySQL de teste do .254)
- `central.delivery` (nLoja=10): nPedido, Nome (cliente), CPF (CNPJ), Data, Hora, Total, Status (0/1 = aberto ainda sem nota; 2 = faturado; 9 = cancelado), NFe, CodVendedor.
- `central.delivery_produtos` (por nPedido, sem nLoja): CodigoBarra, Descricao, Und, Qtd, QtdEmb.
- `central.painel_televendas` (nLoja=10, nPedido varchar): Status 0 painel → 1 separação → 2 conferido → 4 liberado. Só leitura, não é mexido.
- Espelho de saída no teste: `conferencia_televendas` (nLoja 10, nPedido, Codigobarra, Qtd cx, QtdEmb, Data, Status_Conferencia).

## Tarefas (ordem de execução, cada uma com teste antes)
1. **`lib/expedicao.js`** (estado, sem rede): abrirPedido({nPedido, cliente, itens[{cod, descricao, qtd, qtdEmb}]}) → id `exp-AAAA-MM-DD-10-<nPedido>`; bipar({cod, quant, emb, lote}) cego com resposta imediata: `ok` / `qtd_diferente` (sem revelar qtd) / `fora_do_pedido` (não soma, vai pra `fora[]`); tirar({cod, lote?}) remove/baixa e grava evento `tirar_coletagem` na conferência; terminei() só fecha se 100 % (todo item bate e `fora[]` vazio), senão devolve lista de códigos (sem qtd) e status continua `bipando`; lote obrigatório em todo bipe; dedup por bipeId como no recebimento; arquivos `data/expedicao/AAAA-MM-DD.json`.
2. **`lib/expedicao-erp.js`**: passos pra `escreverERP.lote` em `conferencia_televendas` (uma linha por (cod, lote) com Qtd em caixas e QtdEmb), só ao fechar 100 %; fila `erp.erros` + reenviar, igual ao recebimento.
3. **Rotas públicas** em `lib/expedicao-rotas.js` (token da loja 10 apenas): `GET /api/expedicao-publico/pedidos` (delivery nLoja=10, Status IN (0,1), Data ≥ hoje−3, sem NFe; junta status do painel só pra mostrar), `POST /abrir`, `/bipar`, `/tirar`, `/terminei`, `GET /visao/:id`; log no LOG Coletor (tipos novos `exp_abrir`, `exp_bipe`, `tirar_coletagem`, `exp_fechar`). Middleware de auth: liberar `/api/expedicao-publico/`.
4. **App** (`public/recebimento.html`): tela de escolha após o PIN só quando `sess.loja === 10` (Recebimento × Expedição); telas Pedidos / Conferência de saída / Terminei conforme mockup; aviso imediato de `qtd_diferente` e `fora_do_pedido`; botão "Tirar da coletagem" com motivo opcional; Terminei só fecha 100 %.
5. **Retaguarda** em `public/centro-distribuicao.html` + rotas internas (sessão): aba **Expedição** (pedidos conferidos hoje, pendências "verificar pallet" com botão "verifiquei" → nome+hora) e aba **Lotes no CD** (por produto: lote, entrada, validade, entrou, saiu por pedido, saldo; fonte = conferências do coletor, entrada e saída). ⚠ `centro-distribuicao.html` tem edição sem commit de outra sessão do Tiago: commitar/descartar antes de mexer.
6. **Docs/memória**: atualizar spec com o que foi diferente; memória do projeto.

## Fora do plano
FEFO calculado; alterar `painel_televendas`; escrita no `.252`; Fiscal da central (continua desligado).
