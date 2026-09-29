# Coletor de Recebimento · bipar a DANFE antes de descarregar

**Data:** 2026-09-29 · **Decisão do Tiago:** opção A (bipar a DANFE) + bloquear e avisar a central quando o XML não existir.

## Problema
A loja seleciona a nota no coletor, descarrega o caminhão inteiro e só depois descobre que o XML no ERP não é o da
nota que chegou (ou nem existe). Precisa de uma trava com o caminhão ainda fechado.

## Fluxo
1. Tela de notas ganha o campo **"Bipar DANFE do caminhão"** no topo. A loja pode bipar ali direto ou tocar numa nota da lista.
2. Tocar numa nota **sem conferência começada** leva à tela **"Confira a DANFE"** (fornecedor + NF-e + campo esperando a chave de 44 dígitos). Não tem "pular".
3. `POST /api/recebimento-publico/danfe {chave, nome}` devolve um de três resultados:
   - `confere` → chave existe na `axml` e é da loja do token. Servidor guarda "DANFE validada" (loja+chave, 2 h). App abre a conferência (`/abrir`).
   - `outra_loja` → chave existe mas o destinatário é outro CNPJ. App bloqueia.
   - `sem_xml` → chave não está na `axml`. App bloqueia: **"XML desta DANFE não está no ERP. Não descarregue. A central já foi avisada."**
   Os três gravam evento `danfe` no LOG Coletor (loja, quem, chave, NF-e quando existe, CNPJ do emitente lido da chave, resultado).
4. Chave `confere` mas diferente da nota tocada: app pergunta "Essa DANFE é da NF-e X da Y. Abrir essa?" e abre a certa.
5. `/abrir` só aceita chave com DANFE validada (409 caso contrário), **exceto** quando já existe conferência dessa chave na loja (retomar bipagem/recontagem não pede DANFE de novo).
6. A conferência guarda `danfe: { nome, em }`.

## Fora do escopo
Aviso no Fiscal/chat (Fiscal com coletor está desligado desde 25/09; quando religar, o evento vira linha lá). Conferir o conteúdo do XML contra o papel.

## Testes
Rota `danfe` (confere / outra_loja / sem_xml / chave curta), gate do `/abrir` (409 sem DANFE, passa com DANFE, passa ao retomar), evento no log.
