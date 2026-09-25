# TV Televendas CAHU — painel de preços da Tabela Retirada

**Data:** 25/09/2026
**Onde:** Econômico Relatórios (`.254`), página Centro de Distribuição → nova aba **TV Televendas**, mais uma página pública pra TV.
**Protótipo aprovado:** https://claude.ai/artifact/KnjwSfa9c7RvqA6eV11kYk (3 modos, 2 cores, tela do app).

## Objetivo

Uma TV no televendas da CAHU Distribuidora passando, em loop, os produtos com preço da **Tabela Retirada** (código 1 no ERP) com a foto do CAHU Delivery, e a cada N slides uma tela chamativa do lançamento do app. Quem chega no CD vê o preço de retirada na hora. O Tiago controla tudo pela retaguarda, sem tocar na TV.

Regras de negócio fixas:
- Só **Tabela Retirada**. Preço Delivery nunca aparece na TV (fica só no app).
- Só produtos com **estoque positivo no CD** (`central.estoquen10.Qtd > 0`) e ativos na tabela (`s_tabela_item.status_item = 0`, `itens.CodDesativado = 0`) — mesmo critério da Tabela de Preços da CAHU já existente em `server.js` (`carregarTabelaPrecosCahu`).
- Logo nova da CAHU (casinha + CAHU preto) no rodapé de **todo** slide.

## Fora do escopo

Filtro por categoria, vídeo, preço Delivery na TV, escolher outra tabela, mais de uma TV com configs diferentes.

## Componentes

### 1. Config e dados — `lib/tv-televendas.js` (novo)

Estado em `data/tv-televendas.json`:

```json
{
  "token": "32 hex",
  "modo": "individual | grade | misto",
  "tema": "escuro | amarelo",
  "segundos": 6,
  "appCada": 5,
  "soComFoto": true,
  "destaques": ["7891000359836", "..."],
  "app": {
    "titulo": "Vem aí o app CAHU Delivery",
    "frase": "Peça pelo celular a qualquer hora, veja preço e estoque na hora e acompanhe a entrega ou a retirada.",
    "chamadas": ["Tabela na palma da mão", "Pedido em 2 minutos", "Android e iPhone"],
    "qrUrl": ""
  },
  "atualizadoEm": "ISO"
}
```

Funções:
- `getConfig()` — lê o arquivo; se não existe cria com os padrões acima e um token novo.
- `salvarConfig(parcial, usuario)` — valida (modo/tema em lista, `segundos` 3–30, `appCada` 2–20, `destaques` só strings numéricas, `qrUrl` vazia ou `https://`), grava, retorna o config.
- `novoToken()` — troca o token, o link antigo passa a dar 404.
- `carregarProdutos()` — junta ERP + catálogo do app, com **cache de 10 min** em memória:
  - ERP: `SELECT s.codigobarra, s.descricao, s.preco, e.Qtd FROM central.s_tabela_item s JOIN central.itens i ON i.CodigoBarra = s.codigobarra JOIN central.estoquen10 e ON e.CodigoBarra = s.codigobarra WHERE s.cod_tabela = 1 AND s.status_item = 0 AND i.CodDesativado = 0 AND e.Qtd > 0` via `q()` (somente leitura).
  - Catálogo do app: `GET https://cahudelivery.duckdns.org/v1/produtos?limit=20&pagina=N` com header `X-Tenant: cahu`, paginando até vir página vazia (hoje 188 itens = 10 chamadas). Guarda por `ean` (e também por `sku`): `{ nome, categoria, unidade_venda, qtd_por_embalagem, imagem: imagens[0].url }`.
  - Cruzamento por `codigobarra = ean` (ou `sku`). Item do ERP sem par no app: entra sem foto/categoria (`unidade` vira `CX` se a descrição termina em `CX\d+`, senão vazio). Com `soComFoto`, itens sem foto são descartados.
  - Resultado ordenado por descrição, cada item `{ ean, nome, preco, unidade, qtdEmbalagem, categoria, imagem, destaque }`. Nome = descrição do ERP (é a mesma que a tabela impressa usa).
  - Se o catálogo do app falhar, usa o último cache; se nunca carregou, devolve só ERP (sem fotos) e loga aviso.
- `buscarProdutos(termo)` — pra retaguarda escolher destaques: filtra `carregarProdutos()` por nome/EAN, máximo 30.

### 2. Rotas — `server.js`

Logadas (módulo `compras`, prefixo `/api/pedidos-cd/` que já está no mapa de `lib/modulos.js`):
- `GET /api/pedidos-cd/tv-config` → config + `linkTV` (`${PUBLIC_URL}/tv-televendas/${token}`) + `totais` (`{ erp, comFoto, exibidos }`).
- `POST /api/pedidos-cd/tv-config` → `salvarConfig(body, user)`.
- `POST /api/pedidos-cd/tv-config/novo-token`.
- `GET /api/pedidos-cd/tv-config/produtos?q=` → `buscarProdutos`.

Públicas (sem login, entram no filtro de rotas públicas com regex de token 32 hex, ao lado do `/cd/`):
- `GET /tv-televendas/:token` → serve `public/tv-televendas.html` se o token bate, senão 404 em texto.
- `GET /api/tv-televendas-publico/:token` → `{ config (sem token), produtos, geradoEm }`. Token errado → 404.

`PUBLIC_URL` do Econômico (a URL pública que o Caddy expõe) é a mesma usada nos links do CD.

### 3. Aba na retaguarda — `public/centro-distribuicao.html`

Nova aba `data-tab="tv"` com rótulo **TV Televendas**, depois de Regras. Botões de ação ficam em cima, como nas outras abas.

Blocos, de cima pra baixo:
1. **Link da TV**: campo somente leitura com o link, botões **Copiar**, **Abrir**, **Gerar novo link** (confirma antes; avisa que o antigo para). Abaixo, texto curto de como deixar a TV em tela cheia de uma vez: abrir o link com `?kiosk=1` no Chrome em modo quiosque (`chrome --kiosk <link>`) ou, se for navegador de smart TV, abrir o link e tocar no botão "Tela cheia" que aparece.
2. **Como passa**: Modo (Individual / Grade / Misto), Cor (Escuro / Amarelo), Segundos por slide, Tela do app a cada N slides, checkbox "Só produtos com foto". Contador "X produtos na Retirada com estoque · Y com foto · Z na TV".
3. **Tela do app**: título, frase, 3 chamadas, link do QR code (vazio = mostra "Em breve" no lugar do QR).
4. **Destaques** (usados no modo Misto): busca por nome ou código, lista de resultados com botão "Marcar"; lista dos marcados com foto pequena, preço e botão "Tirar".
5. Botão **Salvar** (em cima, na barra da aba). Salvou → toast "Salvo · a TV atualiza em até 1 minuto".

### 4. Página da TV — `public/tv-televendas.html` (novo)

Página isolada, sem `nav.js`, sem login, sem `design-system.css` (visual próprio do protótipo: Barlow Condensed + Barlow do Google Fonts com fallback, amarelo `#FFD500`, preto `#141414`). Sem `tv-fit.js`: a página já escala tudo por `--u = largura/100` como no protótipo.

Comportamento:
- Lê o token da URL, busca `/api/tv-televendas-publico/:token`. Erro → tela preta com "Link inválido. Gere um novo link na retaguarda."
- Monta a sequência conforme `modo`:
  - **individual**: cada produto um slide; a cada `appCada` slides, tela do app.
  - **grade**: páginas de 8 (4×2); a cada `appCada` páginas, tela do app.
  - **misto**: grade; após cada 2 páginas entra 1 destaque em tela cheia (faixa "Destaque da semana"), rodando a lista de destaques; sem destaques marcados vira igual a grade. Tela do app a cada `appCada` slides contando tudo.
- Slides iguais ao protótipo: individual (foto grande à esquerda, categoria, nome, "Tabela Retirada · preço de hoje", preço grande, "/ CX", "Caixa com N un · sai a R$ X a unidade" quando `qtdEmbalagem > 1`); grade (cabeçalho "Tabela Retirada · página X de Y", cards brancos); app (logo, "Em breve", título, frase, chamadas, celular com 4 produtos, QR real via `qrcode` da cdnjs quando `qrUrl` preenchida, senão bloco "Em breve"). Rodapé em todos: logo nova, "CAHU Distribuidora · Tabela Retirada · preços de hoje", contador, relógio. Barra de progresso do slide.
- Foto: usa a URL do app (`imagem`). Sem foto (quando `soComFoto` está desligado): bloco branco com a logo apagada.
- Tema `escuro` / `amarelo` = classes do protótipo.
- **Tela cheia**: se não está em fullscreen e não veio `?kiosk=1`, mostra botão grande centralizado "Tela cheia" por cima do primeiro slide; clique → `requestFullscreen()` e some. Tecla `F` também. Some sozinho se o navegador não suportar fullscreen (a página já ocupa 100% da janela de qualquer jeito).
- **Atualização**: a cada 60 s refaz o GET. Se `config` mudou, aplica (modo/tema/tempos) e remonta a sequência do início. Se só os produtos mudaram, troca os dados e segue do slide atual. Sem internet: continua rodando com o que tem, tenta de novo no próximo minuto. `Cache-Control: no-store` na API pública.
- Logo nova: `public/logo-cahu-nova.png` (copiada de `fluxo-commerce/apps/mobile/assets/icone/splash_logo.png`, 886×226).

### 5. Acesso e segurança

- Retaguarda: só quem tem o módulo Gestão de Compras (mesmo da página Centro de Distribuição).
- TV: token de 32 hex, sem login, só leitura, sem dado sensível (preço de tabela pública e foto pública do app). "Gerar novo link" derruba o anterior.
- Nada é gravado no ERP; `q()` continua somente leitura.

### 6. Erros

- ERP fora: `carregarProdutos()` devolve o último cache; se não tem cache, API pública responde 503 e a TV mostra "Sem dados no momento" com a logo e tenta de novo em 1 min.
- Catálogo do app fora: usa último cache de fotos; sem cache, itens vão sem foto (e com `soComFoto` a TV fica só com a tela do app + aviso na retaguarda "0 produtos com foto").
- Config inválida no POST → 400 com mensagem em português.

### 7. Testes

- `tests/tv-televendas.test.js` (mesmo runner dos outros testes do repo): validação de `salvarConfig` (limites, listas), cruzamento ERP × catálogo com fixtures (com foto / sem foto / `soComFoto`), montagem da sequência dos 3 modos (posição da tela do app e dos destaques), token novo invalida o antigo.
- Manual: abrir a aba, salvar cada modo/cor, abrir o link na TV, conferir preço de 3 itens contra a Tabela Retirada impressa.
