# Plano: TV Televendas CAHU

Spec: `docs/superpowers/specs/2026-09-25-tv-televendas-cahu-design.md`

1. **`lib/tv-televendas.js` + `test/tv-televendas.test.js`** — config em `data/tv-televendas.json` (padrões, validação, token novo), `cruzar(erp, catalogo, cfg)` puro, `montarSequencia(produtos, cfg)` puro (usado também pela página via cópia), `carregarProdutos()` com cache 10 min e deps injetadas (`q`, `fetchCatalogo`). Rodar `node --test test/tv-televendas.test.js`.
2. **`server.js`** — `require` + `init({ q, dataDir })`; rotas logadas `/api/pedidos-cd/tv-config[...]`; rotas públicas `/tv-televendas/:token` e `/api/tv-televendas-publico/:token` liberadas no filtro de login (regex 32 hex).
3. **`public/tv-televendas.html`** — página da TV (porta o protótipo: 3 modos, 2 temas, tela do app, fullscreen, refresh 60 s, QR via cdnjs `qrcodejs`). `public/logo-cahu-nova.png`.
4. **`public/centro-distribuicao.html`** — aba "TV Televendas" (link + config + tela do app + destaques + Salvar em cima).
5. Verificação: testes verdes, `node -e "require('./server.js')"` não é viável (sobe servidor); conferir sintaxe com `node --check`. Commit. Deploy é do Tiago (webhook).
