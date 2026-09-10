# Sugestão de Compras — tela inicial "Rupturas por Comprador"

**Data:** 2026-09-10 · **Arquivo:** `public/sugestao-compras.html` · **Servidor:** só ajuste de limite em `/api/ruptura`

## Objetivo
Nova primeira tela do módulo Sugestão de Compras: a compradora escolhe o próprio nome,
vê só as listas dela com as rupturas de cada uma (mesmo cálculo da Central de Rupturas)
e, a partir de uma lista, cria uma sugestão que cai na calculadora de cobertura já existente.

## Fluxo
1. `#rupturas-view` (inicial): dropdown Comprador (`GET /api/ruptura/compradores`) + botão Analisar.
2. Ao analisar: `GET /api/ruptura?comprador=X&refresh=1` em paralelo com `GET /api/listas-compra?comprador=X`.
   - KPIs: rupturas, urgência ≤3d, em risco, perda R$/dia.
   - Tabela: uma linha por lista da compradora (as com problema vêm de `ranking_fornec`,
     ordenadas por score; as sem problema entram no fim, zeradas, em cinza).
   - Clique na linha expande abas Rupturas / Urgência / Em Risco / Excesso com produtos por loja
     (filtro client-side por `listaId` sobre `rupturas`, `sem_pedido`, `em_risco`, `excesso`).
   - Botão **Criar Sugestão** na linha → abre o modal "Nova Sugestão" existente com nº da lista
     preenchido e lojas participantes carregadas → Confirmar → calculadora (`abrirSugestao`).
3. Botão "Monitor de Sugestões" leva pra tela atual (`#monitor-view`), que deixa de ser a inicial.
   O Monitor ganha botão de volta pra Rupturas.
4. Botão de voltar da calculadora retorna pra tela de origem (rupturas, monitor ou listas).

## Regras
- 100% leitura do ERP; nada é gravado.
- `ranking_fornec` passa de 50 pra 200 linhas (compradora com mais listas: 52).
- Comprador escolhido fica salvo em `localStorage` (`sc_comprador`).
- Cores/estilo do design-system (navy + âmbar), sem copiar o layout da Central.

## Fora de escopo
Gerar pedido/cotação, persistir sugestão, mapear status do Monitor (pendências já registradas).
