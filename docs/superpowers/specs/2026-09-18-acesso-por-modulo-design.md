# Acesso por módulo no cadastro de usuários — design

Data: 2026-09-18. Sistema: Econômico Relatórios.

## Objetivo

O admin escolhe, por usuário, quais módulos ele acessa. Marcou "Financeiro", o usuário vê e usa o módulo inteiro (todas as telas e APIs dele). Módulo não marcado não aparece na sidebar e é bloqueado no servidor.

## Módulos

Mesma divisão da sidebar (`public/nav.js`). Um único mapa, no servidor, é a fonte da verdade e alimenta o cadastro, a sidebar e o bloqueio.

| id | Nome | Páginas | Prefixos de API |
| --- | --- | --- | --- |
| `analise` | Análise | index, comparativos, consulta, itens | comparativo-*, consulta, itens, kpis, faturamento-*, margem-*, top-*, produtos, produtos-semana, grupos, compra-venda, pagar-venda, formas-pagamento |
| `cahu-distribuidora` | CAHU Distribuidora | cahu-tabela-precos | cahu-distribuidora |
| `financeiro` | Financeiro | conciliador, conciliador-entradas, conciliador-cd, dre | conciliador, conciliador-entradas, conciliador-cd, itau |
| `compras` | Gestão de Compras | centro-distribuicao, cotacao, ruptura, fornecedores, pedidos-compra, ponta-gondola, radar-pedidos, sugestao-compras, painel-cd, comprador, analise-comprador, margem-comprador, compras, mensal, relatorio-cronograma | compras, cotacoes, ruptura, fornecedores, listas-compra, pedidos-cd, painel-cd, pedidos-fornecedor, pontas-gondola, radar-pedidos, sugestao-compras, sugestao-manual, sugestoes-compra, sem-fornecedor |
| `precificacao` | Precificação | formacao-de-preco, precificacao | precificacao |
| `prevencao` | Prevenção | prevencao | (usa /api/pendencias — ver Processos) |
| `processos` | Processos | pendencias, negativos | pendencias, negativos |

Fora do controle por módulo (regras já existentes continuam): `admin-usuarios` e `/api/admin/*` (só admin), `gestao-gerencial` (perfil gerencial), painéis de TV (`comparativo-tv`, `painel-*`, `diretoria`, `painel-diretoria`, `supervisao`, `ruptura-painel`, `hub`, `ds`), páginas públicas (`contagem`, `cd-pedido`, `cotacao-fornecedor`, `pedido-fornecedor`) e APIs públicas/comuns (`login`, `logout`, `me`, `versao`, `*-publico`, `*-publica`, `contagem`).

Página ou API que não está em nenhum módulo continua liberada pra qualquer usuário logado (comportamento atual). Nada fica bloqueado por engano.

## Regras

1. `usuarios.json` ganha `modulos: string[]` por usuário (ids da tabela).
2. `perfil === 'admin'`: acesso a tudo, campo ignorado. `perfil === 'gerencial'`: travado na Gestão Gerencial como hoje, campo ignorado.
3. Usuário sem o campo (cadastro antigo): acesso a tudo. Ao editar um usuário antigo, o admin vê todas as caixas marcadas e desmarca o que quiser. Assim ninguém perde acesso no dia da virada.
4. Campo presente mas vazio: só acessa o que está fora do controle por módulo.
5. Servidor: no middleware de autenticação já existente, depois de checar sessão, resolve o módulo da página (`/x.html`) ou da API (`/api/prefixo/...`) pelo mapa. Se o usuário não tem o módulo: API responde 403 `{ error: 'Sem permissão' }`; página redireciona pra primeira página permitida (ou `/login.html` se nenhuma).
6. Login: `redirect` passa a ser a primeira página permitida (Dashboard se tem Análise; senão a primeira página do primeiro módulo marcado). `/api/me` devolve `modulos` (lista completa pra admin e usuários antigos).
7. Sidebar: `nav.js` esconde os itens e grupos cujo módulo não está em `modulos`. Clique na logo leva à primeira página permitida.
8. Cadastro (`admin-usuarios.html`): bloco "Módulos" com uma caixa por módulo, vindo de `GET /api/admin/modulos`. Escondido quando o perfil é admin ou gerencial. A tabela de usuários mostra os módulos como etiquetas curtas. Botões de ação continuam acima da tabela.

## Arquivos

- `modulos.js` (raiz): mapa dos módulos e funções `moduloDaRota(path)` e `paginasPermitidas(user)`. CommonJS, usado só pelo servidor.
- `server.js`: middleware de acesso, `/api/login`, `/api/me`, `/api/admin/modulos`, CRUD de usuários aceita e devolve `modulos`.
- `public/nav.js`: filtro por `modulos` vindo de `/api/me`; ids dos grupos alinhados com o mapa (`analise` vira um id do bloco Análise).
- `public/admin-usuarios.html`: caixas de módulos no formulário e etiquetas na tabela.

## Testes

- Unitário de `modulos.js` (node:test): rota → módulo para página, API, rota fora do mapa e rota pública.
- Manual: usuário só com Financeiro loga e cai no Conciliador; sidebar mostra só Financeiro; abrir `/pendencias.html` na mão redireciona; `GET /api/pendencias` responde 403; admin continua vendo tudo; usuário antigo sem o campo continua vendo tudo.

## Fora de escopo

Permissão por tela dentro do módulo. Perfis novos. Mudança no perfil gerencial.
