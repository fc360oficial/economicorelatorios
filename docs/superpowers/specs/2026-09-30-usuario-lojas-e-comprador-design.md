# Usuários: lojas liberadas e trava por comprador(a)

**Data:** 2026-09-30 · **Pedido do Tiago:** "em usuários vou querer linkar as lojas em alguns usuários (ex.: só
CD no Fiscal) ... ou também opção todas lojas" e "comprador vai poder ver todas lojas, mas só vai tá linkado
tudo só com o nome dela; não vai poder ver nada de outra compradora".

## Problema
O cadastro de usuários controla **quais módulos** a pessoa abre (`lib/modulos.js`), mas não **o que ela vê
dentro da tela**:
- Loja: só existe `loja_id` do perfil gerencial, que trava uma única tela (Gestão Gerencial). Nenhuma API
  usa a loja do usuário pra filtrar. Quem tem o módulo Fiscal vê as 7 lojas.
- Comprador(a): `comprador_nome` é gravado no cadastro, mas serve só de rótulo. Uma compradora logada
  troca o seletor e vê as listas, sugestões e pedidos de qualquer outra.

## Decisão de design (aprovada)
Dois vínculos por usuário, configurados na tela **Usuários**, ao lado de "Módulos liberados":

| Vínculo | Campo no `usuarios.json` | Padrão | Efeito |
|---|---|---|---|
| Lojas liberadas | `lojas: number[]` ou `null` | `null` = todas | só enxerga as lojas marcadas |
| Comprador(a) | `comprador_nome` (já existe, perfil comprador) | — | só enxerga o que é das listas dela, em todas as lojas |

- Os dois são independentes: compradora fica com "Todas as lojas" e travada no nome dela.
- Admin ignora os dois (vê tudo). Perfil gerencial continua como está (`loja_id` + Gestão Gerencial).
- Cadastro antigo sem o campo `lojas` = todas as lojas (nada muda pra quem já existe).
- A trava é no **servidor**. Esconder seletor na tela é só conforto; mudar a URL na mão não abre outra loja
  nem outra compradora.
- Vale a partir do **próximo login** do usuário (igual aos módulos: a lista fica na sessão).
- O app do coletor (PIN por loja, `/api/recebimento-publico/*`, `/api/expedicao-publico/*`) **não muda**.

## Fase 1 — Lojas liberadas (primeiro uso: Fiscal só CD)

### Cadastro (`public/admin-usuarios.html`, `server.js` CRUD)
- Bloco novo "Lojas liberadas": caixa "Todas as lojas" (marcada por padrão) + E1, E2, E3, E4, E5, E6, CD
  (valores 1..6 e 10, mesmos rótulos do Fiscal). Marcar "Todas" desmarca e desabilita as outras.
- Escondido pra admin e gerencial, como os módulos.
- Salvar sem "Todas" e sem nenhuma loja = erro "Marque ao menos uma loja".
- Coluna "Lojas" na tabela de usuários: "todas" em cinza ou as etiquetas E1/CD.
- Servidor: `lojasDoBody(v)` aceita só 1..6 e 10, sem repetição; lista vazia ou inválida vira `null`.
  `lojas` entra em `POST/PUT /api/admin/usuarios`, no `GET`, na sessão do login e no `/api/me`.

### Regra (`lib/escopo.js`, novo)
Fonte única, sem dependência do Express, testável sozinha:
- `lojasDoUsuario(user)` → `null` (todas) ou a lista permitida. Admin e gerencial → `null`.
- `podeLoja(user, loja)` → boolean.
- `resolverLoja(user, pedida)` → o que a API deve usar:
  - usuário sem restrição: devolve a loja pedida (ou `null` = todas);
  - restrito e pediu loja permitida: essa loja;
  - restrito e pediu loja fora da lista: erro 403;
  - restrito e não pediu loja ("todas"): a lista permitida.

### Onde a trava é ligada nesta fase
Só no que o módulo Fiscal usa. O resto das telas com seletor de loja continua igual e é ligado depois,
tela por tela, usando o mesmo `lib/escopo.js`.
- `/api/fiscal/recebimentos`, `/documentos`, `/margem`: `fiscalPeriodo` passa a devolver `lojas` (lista ou
  `null`) via `resolverLoja`; `lib/fiscal.js` filtra `nLoja IN (...)`.
- `/api/fiscal/recebimentos/:nReg` e `/decisao`: confere a loja da conferência; fora da lista = 403.
- `/api/fiscal/config`: `lojas` devolvido só com as permitidas (é de onde a tela monta o seletor).
- `/api/recebimento` (lista do dia usada pelo Fiscal) filtra por loja permitida; `/api/recebimento/:id/*`
  (liberar, reconferir, chat, devolução, reenviar) confere a loja da conferência; fora = 403.
- `/api/recebimento/config` (PINs das lojas): usuário restrito recebe só as lojas dele.

### Tela (`public/fiscal.html`)
- Uma loja só: seletor já vem nela e desabilitado.
- Mais de uma: seletor mostra só as permitidas; a opção "Todas as lojas" significa "todas as minhas".
- Nenhuma mudança visual pra quem vê todas.

## Fase 2 — Trava por comprador(a)
Usuário com perfil comprador e `comprador_nome` preenchido. O nome é resolvido por `resolveComprador`
pra chave do ERP (`NREGS_COMPRADOR`: compradora → listas dela).

### Regra (`lib/escopo.js`)
- `compradorDoUsuario(user)` → nome ou `null` (admin e demais perfis = `null`).
- `listasDoUsuario(user, nregsComprador)` → ids das listas dela, ou `null` (sem trava).
- **Falha fechada:** compradora cujo nome não bate com nenhuma lista do ERP vê tudo vazio, nunca tudo aberto.

### Servidor
- Middleware nas APIs do módulo Gestão de Compras: pra usuário travado, `req.query.comprador` é sempre
  sobrescrito com o nome dela (qualquer valor que vier da tela é ignorado).
- APIs que devolvem a lista de compradores (`compradores: [...]`, `/api/compras/compradores` e iguais)
  devolvem só ela.
- APIs que listam por **lista de compra** sem receber `comprador` (Sugestão de Compras e Monitor, Sugestão
  Manual, Radar de Pedidos, Pedidos de Compra, Cotação, Sortimento, Ruptura, Ponta de Gôndola, Cronograma)
  filtram pelas listas dela. Ação em item de lista que não é dela (abrir detalhe, gerar sugestão/pedido,
  salvar) = 403.
- Dashboard (módulo Análise), bloco de compradores: só a linha dela.
- Telas sem dono por compradora ficam como estão: Centro de Distribuição, Painel do CD, Fornecedores.
  (Se alguma delas precisar ser travada, entra como ajuste depois.)
- O plano de implementação começa com a auditoria de cada rota de `apis` do módulo `compras` em
  `lib/modulos.js`, classificando: recebe `comprador` / lista por lista / sem dono.

### Telas
- Seletor de comprador(a) some ou vem travado no nome dela em: Sugestão de Compras, Cotação, Ruptura,
  Ponta de Gôndola, Compras, Comprador, Análise do Comprador, Margem do Comprador, Mensal, Cronograma.
- Seletor de loja dessas telas não muda (compradora vê todas as lojas).

## Erros
- API fora do escopo: `403 { error: 'Sem permissão pra esta loja' }` ou `'... pra esta lista'`.
- A tela mostra a mensagem no lugar dos dados; não redireciona.

## Testes
- `test/escopo.test.js` (node:test, como `modulos.test.js`): `lojasDoUsuario` (admin, gerencial, sem campo,
  com lista), `resolverLoja` (permitida, negada, "todas" vira lista), `lojasDoBody` (valores inválidos,
  vazio), `listasDoUsuario` (nome resolvido, nome que não bate = vazio, admin = sem trava).
- Teste de rota do Fiscal com usuário `lojas:[10]`: lista só traz loja 10; `?loja=3` = 403; detalhe de
  conferência de outra loja = 403.
- Validação manual do Tiago: logar com uma usuária só CD no Fiscal e com uma compradora nas telas de Compras.

## Fora do escopo
- Ligar a trava de loja nas outras telas com seletor (Dashboard, Prevenção, Radar, Sugestão etc.).
- Mudar o perfil gerencial ou o app do coletor.
- Trocar a lista fixa de compradores do formulário de usuário por lista vinda do ERP.

## Cadastro dos usuários (depois do deploy)
Feito pelo Tiago na tela Usuários em produção (o `usuarios.json` não vai pro git):
- usuárias do CD: módulos CAHU Distribuidora + Fiscal, lojas = CD;
- demais usuários novos: módulos e lojas conforme cada um, ou "Todas as lojas";
- compradoras: perfil comprador + nome vinculado, lojas = todas.
