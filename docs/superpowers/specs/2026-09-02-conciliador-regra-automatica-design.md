# Regra automática de conciliação (Conciliador Bancário)

## Contexto

O Conciliador Bancário (`/conciliador.html`) casa saídas do extrato Itaú (`BOLETO PAGO` e
`PIX ENVIADO`) com títulos de `loja20045.contasapagar` do ERP. Quatro categorias hoje exigem
conferência manual todo mês: **Pago sem baixa**, **Revisar**, **Não encontrado** e **Fora do
escopo** — mesmo quando é claramente o mesmo fornecedor recorrente (ex: boleto mensal do
"MICHEL FIGUEIREDO DE SA LEITAO").

Já existe um mecanismo de confirmação manual "avulsa" (`POST /api/conciliador/confirmar-avulso`,
persistido em `data/conciliacoes-avulsas.json`), mas é por **chave exata**
(`data|valor|histórico` — ver `chaveSaida()` em `lib/conciliador.js`), então não generaliza pro
mês seguinte: o mesmo beneficiário recorrente volta pra fila de revisão todo mês.

Esta feature adiciona uma segunda camada: ao confirmar um match manual, o usuário pode marcar
"Confirmar definitivamente" (com reautenticação por senha, restrita a perfil `admin`), o que cria
uma **regra permanente** que ajuda o motor de match nos meses seguintes — sem substituí-lo.

**Por que exige senha:** é dinheiro. Uma regra errada concilia (ou dispensa) algo automaticamente
e silenciosamente todo mês. A senha é a mesma senha de login do usuário (reautenticação tipo
"sudo"), não uma senha nova ou compartilhada — restrita aos 3 usuários com `perfil: admin`
(`donato`, `tiago.freire`, `rodrigo.cahu`), reaproveitando o gate que já existe em outras rotas
admin do `server.js` (`req.session.user.perfil !== 'admin'`).

## Escopo

Cobre as 4 categorias, com dois tipos de regra:

- **`fornecedor`** (categorias Pago sem baixa / Revisar / Não encontrado — têm candidato de
  título do ERP pra vincular): alias beneficiário do extrato ↔ `CodFornec` do ERP.
- **`dispensar`** (categoria Fora do escopo — não tem título do ERP pra vincular, por decisão de
  produto essas categorias — tarifa, IOF, salário/SISPAG, tributo, aplicação automática — nunca
  cruzam contra fornecedor): marca o beneficiário pra sair da fila de conferência automaticamente.

Fora de escopo desta versão:
- Editar uma regra existente (só criar e excluir).
- Regra baseada em outra coisa que não o beneficiário normalizado (ex: por faixa de valor, por
  plano de contas de origem).
- Aplicar a regra retroativamente em meses já processados/exibidos antes da regra existir.

## Modelo de dados — `data/regras-conciliacao.json`

Mesmo padrão de persistência do `conciliacoes-avulsas.json` (JSON local, nunca no MySQL do ERP).

```js
// tipo 'fornecedor'
{
  id: 'uuid',
  tipo: 'fornecedor',
  beneficiarioNormalizado: 'MICHEL FIGUEIREDO DE SA LEITAO', // normalizarNome(favorecido)
  beneficiarioOriginal: 'MICHEL FIGUEIREDO DE SA LEITAO PIX',
  codFornec: 1234,
  fornecedorNome: 'MICHEL FIGUEIREDO DE SA LEITAO',
  criadoPor: 'tiago.freire',
  criadoEm: '2026-09-02T18:00:00.000Z'
}

// tipo 'dispensar'
{
  id: 'uuid',
  tipo: 'dispensar',
  beneficiarioNormalizado: 'SISPAG SALARIO',
  beneficiarioOriginal: 'SISPAG SALARIO SETEMBRO',
  criadoPor: 'donato',
  criadoEm: '2026-09-02T18:05:00.000Z'
}
```

Chave de casamento: `normalizarNome(favorecido)` — a mesma função de normalização já usada hoje
em `similaridadeNome()`.

## Motor de match (`lib/conciliador.js`)

Nova função `aplicarRegras(saidas, candidatos, regras)`, chamada **antes** de `conciliar()` em
`processarConciliacao()` (`server.js`). Ela intercepta só as saídas cujo `normalizarNome(favorecido)`
bate com alguma regra; o resto segue pro `conciliar()` de hoje sem nenhuma mudança de
comportamento.

**Regra `fornecedor`:**
1. Filtra `candidatos` (títulos do ERP já carregados pra essa loja/janela) por `CodFornec` da
   regra — ignora a exigência de nome parecido que hoje causa "revisar" por divergência textual.
2. Dentro desse subconjunto, aplica a mesma tolerância de data (`TOLERANCIA_DIAS`) e uma
   tolerância de valor mais larga (`TOLERANCIA_VALOR`, ±15 — a mesma já usada em
   `acharDivergenciaValor`/"buscar títulos próximos", pra cobrir boleto com juros/multa
   variável mês a mês).
3. **1 candidato encontrado** → concilia automaticamente. Status via `statusFinal()` (mesma regra
   de hoje: `Devedor = 0` → `conciliado`, `Devedor > 0` → `pago_sem_baixa`), com `match` montado
   por `montarMatch()` e a flag adicional `regraAplicada: { id, criadoPor, criadoEm }`.
4. **0 candidatos** → a regra não inventa título; a saída segue pro `conciliar()` normal e pode
   virar `não_encontrado` como hoje.
5. **2+ candidatos** → ambíguo mesmo sabendo o fornecedor (ex: duas faturas do mesmo fornecedor
   vencendo na mesma semana) — não escolhe sozinho, cai em `revisar` (mesmo comportamento de hoje
   pra ambiguidade), pra manter a garantia de que regra nunca decide entre dois títulos reais.

**Regra `dispensar`:**
- Saída `fora_escopo` cujo beneficiário bate vira `status: 'dispensado_regra'`. Some da fila de
  conferência (filtro padrão da tela), mas continua contada no resumo/relatório e aparece se o
  usuário filtrar por essa categoria explicitamente.

`aplicarAvulsos()` (conciliações avulsas do mês) continua rodando depois, com prioridade sobre o
resultado de `aplicarRegras()` + `conciliar()` — se o usuário confirmar manualmente algo diferente
do que a regra decidiu num mês específico, o avulso vence (mesmo comportamento de hoje).

## Backend — endpoints

**`POST /api/conciliador/confirmar-regra`**
- Guard: `req.session.user && req.session.user.perfil === 'admin'` (403 senão).
- Body: `{ tipo: 'fornecedor'|'dispensar', beneficiario, senha, codFornec?, fornecedorNome?, saida, escolha? }`.
- Reautenticação: `bcrypt.compare(senha, req.session.user.senha_hash)` contra o próprio hash do
  usuário logado (não uma senha nova). 401 se não bater.
- Se ok: grava a regra em `data/regras-conciliacao.json` (`criadoPor: req.session.user.nome`) **e**
  também grava/atualiza o avulso do mês corrente em `conciliacoes-avulsas.json` (mesmo caminho de
  hoje), pra o item já sair conciliado nessa mesma consulta sem esperar reprocessar.

**`GET /api/conciliador/regras`** (admin only) — lista regras ativas, pra tela de gerenciamento.

**`DELETE /api/conciliador/regras/:id`** (admin only) — remove uma regra. Não reautentica com
senha de novo (a sessão admin já é suficiente pra excluir; só *criar* regra nova exige senha,
porque criar é o que liga o piloto automático).

## Frontend (`public/conciliador.html`)

- No modal de confirmação manual que já existe (campo de justificativa), adiciona checkbox
  **"Confirmar definitivamente (vira regra pra sempre)"**. Ao marcar, revela um campo de senha.
  Some se o usuário não for admin (`window.usuarioAtual?.perfil === 'admin'` — mesma info de
  sessão que a tela já tem hoje pra outras seções admin-only).
- Em "Fora do escopo", adiciona um botão **"Não preciso ver isso de novo"** (sem escolha de
  título, já que não existe candidato) — mesmo campo de senha, chama o mesmo endpoint com
  `tipo: 'dispensar'`.
- Itens conciliados por regra ganham uma badge visual **"✓ regra"**, visualmente distinta de
  conciliação manual (avulso) e automática — não deve parecer mágica quando o usuário olhar a
  tabela depois.
- Nova seção (visível só pra admin) listando regras ativas: beneficiário, tipo, fornecedor (se
  aplicável), quem criou, quando, com botão excluir por linha.

## Erros e casos de borda

- Senha errada → 401 com mensagem clara, não cria regra nem avulso.
- Usuário não-admin tentando criar regra → 403 (o checkbox nem aparece na UI, mas o endpoint
  também valida server-side).
- Duas regras `fornecedor` diferentes pro mesmo beneficiário normalizado → última criada
  sobrescreve (mesmo padrão de `idx >= 0 ? lista[idx] = registro : lista.push(registro)` já usado
  em `confirmar-avulso`).
- Regra aplicada mas o título do ERP some (raro — estorno) → próximo reprocessamento não encontra
  candidato, cai no caso "0 candidatos" acima, não trava nada.

## Testes / verificação manual

O projeto não usa framework de testes automatizados — verificação é manual na tela, como as
outras features do Conciliador.

- Beneficiário recorrente em "Revisar" (nome divergente do cadastro do fornecedor, mas valor+data
  batem) → confirmar com "definitivamente" + senha correta de admin cria a regra; reprocessar o
  mesmo extrato (ou um novo mês com o mesmo beneficiário e valor parecido, dentro de ±15) concilia
  automaticamente com a badge "✓ regra", sem passar por "revisar" de novo.
- Mesmo beneficiário, mês em que o fornecedor não tem nenhum título aberto na janela de data →
  continua "não_encontrado" (regra não inventa título).
- Mesmo beneficiário, mês em que o fornecedor tem 2 títulos vencendo na mesma janela → cai em
  "revisar" mesmo com a regra ativa (não escolhe sozinho entre dois títulos reais).
- Senha errada no modal → 401, não cria regra nem avulso, item continua como estava.
- Usuário logado com perfil `gerente`/`gerencial`/`comprador` → checkbox de "confirmar
  definitivamente" nem aparece; chamando o endpoint direto (via curl/devtools) → 403.
- Item "Fora do escopo" (ex: SISPAG SALARIO) → botão "Não preciso ver isso de novo" + senha faz o
  item sumir da fila nos meses seguintes (status `dispensado_regra`), mas continua contado no
  resumo/relatório.
- Tela de gerenciamento de regras (admin) lista as regras criadas e exclui corretamente — depois
  de excluir, o beneficiário volta a cair no fluxo normal (revisar/não_encontrado) no próximo
  reprocessamento.
