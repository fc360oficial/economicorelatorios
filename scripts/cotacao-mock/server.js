'use strict';
// Servidor de MENTIRA pra conferir a tela da Cotação sem ERP e sem o servidor real: serve o public/ do repositório e
// responde as rotas /api que cotacao.html usa com cotações de exemplo geradas pela lib real (lib/cotacao.js), no mesmo
// formato de dados da produção. NÃO toca em data/ do repositório: copia lib/cotacao.js pra uma pasta temporária, então
// a lib grava os JSON de exemplo lá (a lib usa __dirname/../data/cotacoes).
//   uso: node scripts/cotacao-mock/server.js [porta]      (padrão 4477)  → http://localhost:4477/cotacao.html
//   prints nas 4 larguras do CLAUDE.md: node scripts/cotacao-mock/shots.js
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..', '..'), PORT = parseInt(process.argv[2]) || 4477, BASE = 'http://localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cotacao-mock-'));
fs.mkdirSync(path.join(TMP, 'lib')); fs.copyFileSync(path.join(ROOT, 'lib', 'cotacao.js'), path.join(TMP, 'lib', 'cotacao.js'));
const cot = require(path.join(TMP, 'lib', 'cotacao.js')); cot.init();
const PEDIDOS = []; let PID = 500;
const r2 = v => Math.round(v * 100) / 100;
const localIso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const patch = (id, campos) => { const f = path.join(TMP, 'data', 'cotacoes', id + '.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8')); Object.assign(c, campos); fs.writeFileSync(f, JSON.stringify(c)); };

const ITENS = [
  { cod: '7896002100014', descricao: '51 AGUARDENTE CANA 965ML', unid: 'UN', emb: 12, lojas_qtd: { 1: 12, 3: 12, 4: 24 }, ultimo_custo: 10.14, estoque: 47, venda_dia: 1.68, cobertura_dias: 28 },
  { cod: '7891000100103', descricao: 'ARROZ BRANCO TIPO 1 5KG', unid: 'UN', emb: 6, lojas_qtd: { 1: 60, 2: 30, 4: 90, 6: 24 }, ultimo_custo: 24.9, estoque: 312, venda_dia: 8, cobertura_dias: 39, curva_a: true },
  { cod: '7891000100202', descricao: 'FEIJÃO CARIOCA 1KG', unid: 'UN', emb: 10, lojas_qtd: { 1: 50, 4: 30, 6: 20 }, ultimo_custo: 7.89, estoque: 208, venda_dia: 10, cobertura_dias: 21, curva_a: true },
  { cod: '7896003740233', descricao: 'MARILAN BISC 300G COCO', unid: 'UN', emb: 20, lojas_qtd: { 1: 40, 3: 20, 4: 60 }, ultimo_custo: 4.9, estoque: 156, venda_dia: 9, cobertura_dias: 17 },
  { cod: '7891167023017', descricao: '88 SARDINHA 125G OLEO', unid: 'UN', emb: 50, lojas_qtd: { 2: 50, 4: 100, 5: 50 }, ultimo_custo: 4.55, estoque: 61, venda_dia: 13.2, cobertura_dias: 5, curva_a: true },
  { cod: '7891910000197', descricao: 'AÇÚCAR CRISTAL UNIÃO 1KG', unid: 'UN', emb: 10, lojas_qtd: { 1: 100, 2: 50, 3: 50, 4: 150, 5: 40, 6: 30 }, ultimo_custo: 4.19, estoque: 420, venda_dia: 22, cobertura_dias: 19, curva_a: true },
  { cod: '7894900011517', descricao: 'COCA-COLA PET 2L', unid: 'UN', emb: 6, lojas_qtd: { 1: 120, 2: 60, 4: 180 }, ultimo_custo: 7.35, estoque: 260, venda_dia: 31, cobertura_dias: 8, curva_a: true },
  { cod: '7891024134702', descricao: 'SABÃO EM PÓ OMO 1,6KG', unid: 'UN', emb: 8, lojas_qtd: { 1: 24, 3: 16, 4: 32, 6: 8 }, ultimo_custo: 21.4, estoque: 88, venda_dia: 3.4, cobertura_dias: 26 }
];
const FORNS = [
  { codFornec: 999001, nome: 'SABOR & CIA DISTRIBUIDORA', vendedor: { nome: 'Maria Souza', whats: '5581999990001', email: 'maria@saborecia.com.br' }, faturamento_minimo: 600, condicao: '28 dias', prazo_entrega: 3 },
  { codFornec: 999002, nome: 'ATACADO NORDESTE LTDA', vendedor: { nome: 'Érico Lima', whats: '5581999990002', email: 'erico@atacadonordeste.com.br' }, faturamento_minimo: 400, condicao: '21 dias boleto', prazo_entrega: 5 },
  { codFornec: 999003, nome: 'DISTRIBUIDORA DO VALE', vendedor: { nome: 'Carlos Pereira', whats: '', email: 'carlos@distvale.com.br' }, faturamento_minimo: null, condicao: '14 dias', prazo_entrega: 2 },
  { codFornec: 999004, nome: 'MEGA ATACADO S.A.', vendedor: { nome: 'Ana Castro', whats: '5581999990004', email: 'ana@megaatacado.com.br' }, faturamento_minimo: 1000, condicao: '30 dias', prazo_entrega: 4 }
];
function criarPedidoFake(f, its, c, extra) {
  const total = +its.reduce((s, i) => s + i.total, 0).toFixed(2), lojas = [...new Set(its.flatMap(i => Object.keys(i.lojas_qtd)))].map(Number).sort((a, b) => a - b);
  const p = { id: ++PID, codFornec: f.codFornec, fornecedor: f.nome, vendedor: f.vendedor, lojas, itens: its.length, total, status: 'aprovado', link: BASE + '/pedido-fornecedor.html?t=mock' + PID,
    totais: { digitado: total, ultimo_custo: r2(total * 1.04) }, xml: { status: 'aguardando', lojas: Object.fromEntries(lojas.map(l => [l, { status: 'aguardando', notas: 0 }])) }, cotacao: { id: c.id, nome: c.nome }, entrega: extra && extra.entrega || null };
  PEDIDOS.push(p); return p;
}
function cota(c, f, filtro, fator, obsCada, cond) {
  cot.abrir(f.token);
  cot.salvarPrecos(f.token, c.itens.filter(filtro).map((i, k) => ({ cod: i.cod, preco: r2(i.ultimo_custo * fator(k)), obs: k % obsCada === 0 ? ['cx fechada', 'marca similar', 'entrega parcial'][k % 3] : '', emb_vendedor: k % 5 === 1 ? ['cx 24', 'fardo 12', 'cx 6'][k % 3] : '' })),
    { condicao: cond, cadastro: { email: f.vendedor.email || 'vendas@exemplo.com.br', prazo_pagamento: parseInt(cond) || 28, prazo_entrega: f.prazo_entrega || 3, pedido_minimo: f.faturamento_minimo || 350 } });
  const r = cot.finalizar(f.token, f.vendedor && f.vendedor.nome); if (r && r.erro) console.error('finalizar', f.nome, r.erro);
}
function mk(nome, opts) {
  const seq = opts.seq || 0, criado = new Date(); criado.setDate(criado.getDate() - (opts.dias || 0)); criado.setHours(9 + (seq % 6), 15 * (seq % 4), 0, 0);
  const prazo = opts.prazoFuturo ? new Date(Date.now() + 2 * 86400e3) : new Date(criado.getTime() + 2 * 86400e3); prazo.setHours(17, 0, 0, 0);
  const forns = (opts.forns || FORNS.slice(0, 2)).map(f => ({ ...f }));
  const c0 = cot.criar({ nome, lista: 277, lista_nome: 'COTAÇÃO DE ALIMENTOS', comprador: { nome: opts.comprador || 'Patrícia', whats: '5581999990000' }, prazo: localIso(prazo), parametros: { cobertura: 28, ponto: 3, embMeses: 36 }, itens: ITENS.slice(0, opts.n || ITENS.length), fornecedores: forns, usuario: 'Tiago' });
  patch(c0.id, { criadoEm: criado.toISOString(), teste: !!opts.teste });
  return cot.obter(c0.id);
}
// as 10 cotações cobrem as 4 colunas do pipeline do Monitor e as situações de XML da aba Pedidos
(async () => {
  let c;
  c = mk('Cotação de Alimentos', { dias: 12, seq: 0, prazoFuturo: true });   // fechada, pedidos ainda não recebidos → "Pedido gerado"
  c.fornecedores.forEach((f, n) => cota(c, f, (i, k) => n === 1 ? k % 3 !== 2 : true, k => (n === 0 ? 0.9 + (k % 5) * 0.035 : 0.87 + ((k + 2 + n) % 4) * 0.05), 4 + n, f.condicao_padrao));
  await cot.fechar(c.id, 'Tiago', criarPedidoFake);
  { const ps = PEDIDOS.slice(-2); ps[0].status = 'aprovado'; ps[0].xml = { status: 'parcial', lojas: { 1: { status: 'conciliado', notas: 1 }, 3: { status: 'aguardando', notas: 0 }, 4: { status: 'aguardando', notas: 0 } } };
    if (ps[1]) { ps[1].status = 'recebido_parcial'; ps[1].xml = { status: 'consistencia', lojas: { 1: { status: 'consistencia', notas: 1, nao_vem: 1 }, 4: { status: 'conciliado', notas: 1 } } }; } }
  patch(c.id, { fechadaEm: new Date(Date.now() - 9 * 86400e3).toISOString() });
  c = mk('Cotação Mercearia Seca', { dias: 20, seq: 1, prazoFuturo: true, comprador: 'Fátima' });   // fechada, tudo recebido → "Concluídas"
  c.fornecedores.forEach((f, n) => cota(c, f, () => true, k => 0.88 + ((k + n) % 4) * 0.04, 5, f.condicao_padrao));
  await cot.fechar(c.id, 'Tiago', criarPedidoFake);
  PEDIDOS.slice(-2).forEach(p => { p.status = 'recebido'; p.xml = { status: 'conciliado', lojas: Object.fromEntries(p.lojas.map(l => [l, { status: 'conciliado', notas: 1 }])) }; });
  patch(c.id, { fechadaEm: new Date(Date.now() - 16 * 86400e3).toISOString() });
  c = mk('Cotação Bebidas', { dias: 1, seq: 2, prazoFuturo: true, forns: FORNS.slice(0, 3) });   // todos responderam → "Prontas para análise"
  c.fornecedores.forEach((f, n) => cota(c, f, (i, k) => n === 2 ? k % 2 === 0 : true, k => 0.86 + ((k * 3 + n) % 5) * 0.035, 3 + n, f.condicao_padrao));
  c = mk('Cotação Limpeza', { dias: 0, seq: 3, prazoFuturo: true, comprador: 'Fátima' });   // em digitação → "Aguardando respostas"
  cota(c, c.fornecedores[0], () => true, k => 0.92 + (k % 4) * 0.03, 5, c.fornecedores[0].condicao_padrao);
  cot.abrir(c.fornecedores[1].token); cot.salvarPrecos(c.fornecedores[1].token, c.itens.slice(0, 2).map(i => ({ cod: i.cod, preco: r2(i.ultimo_custo * 0.97) })), {});
  c = mk('Cotação Higiene e Beleza', { dias: 0, seq: 4, prazoFuturo: true, forns: FORNS.slice(1, 4), n: 5 });   // ninguém respondeu
  c = mk('Cotação Perecíveis', { dias: 9, seq: 5, n: 4 }); cot.cancelar(c.id, 'Tiago');   // cancelada → "Concluídas"
  c = mk('Cotação Pré-pedido (exemplo)', { dias: 1, seq: 6, prazoFuturo: true, forns: FORNS, teste: true });   // 4 fornecedores, preços cruzados, 1 pedido já realizado
  c.fornecedores.forEach((f, n) => cota(c, f, () => true, k => ((k + n) % 4 === 0 ? 0.85 : 0.88 + ((k * 3 + n) % 4) * 0.02), 3 + n, f.condicao_padrao));
  { const cmp = cot.comparativo(cot.obter(c.id)), venc = cmp.fornecedores.filter(x => x.itens_vencedor > 0);
    if (venc[0]) { const its = cmp.itens.filter(i => i.vencedor && i.vencedor.codFornec === venc[0].codFornec), lq = {}; its.slice(0, 2).forEach(i => { lq[i.cod] = {}; for (const [ln, v] of Object.entries(i.lojas_qtd)) lq[i.cod][ln] = Math.max(0, Math.round(v * 1.5)); }); const d = new Date(); d.setDate(d.getDate() + 4); cot.salvarPrePedido(c.id, venc[0].codFornec, { lojas_qtd: lq, entrega: d.toISOString().slice(0, 10), tipo_entrega: 'CIF / FOB', obs: 'Entregar pela manhã' }); }
    if (venc[1]) await cot.realizarPedido(c.id, venc[1].codFornec, 'Tiago', criarPedidoFake); }
  c = mk('Cotação Prazo encerrado (exemplo)', { dias: 3, seq: 7, prazoFuturo: true, forns: FORNS.slice(0, 3), teste: true });   // prazo venceu ontem
  cot.setPrazo(c.id, '2099-12-31T18:00', 'Tiago');
  cota(c, c.fornecedores[0], () => true, k => 0.9 + (k % 4) * 0.03, 4, c.fornecedores[0].condicao_padrao);
  cot.abrir(c.fornecedores[1].token); cot.salvarPrecos(c.fornecedores[1].token, c.itens.slice(0, 4).map(i => ({ cod: i.cod, preco: r2(i.ultimo_custo * 0.95) })), { cadastro: { email: 'erico@atacadonordeste.com.br', prazo_pagamento: 21, prazo_entrega: 5, pedido_minimo: 400 } });
  { const ontem = new Date(); ontem.setDate(ontem.getDate() - 1); ontem.setHours(17, 0, 0, 0); patch(c.id, { prazo: localIso(ontem), historicoPrazo: [], prazoAlteradoEm: null, prazoAlteradoPor: null }); }
  c = mk('Cotação DIA · 3 vendedores', { dias: 0, seq: 8, prazoFuturo: true, forns: [{ codFornec: 999005, nome: 'DIA DISTRIBUIDORA', vendedor: { nome: 'Ana Dias', whats: '5581999990005', email: 'ana@dia.com.br' }, vendedores: [{ nome: 'Bruno Dias', whats: '5581999990006', email: '' }, { nome: 'Clara Dias', whats: '5581999990007', email: 'clara@dia.com.br' }], faturamento_minimo: 500, condicao: 'Boleto 28 dias', prazo_entrega: 3 }, FORNS[0]] });
  { const F = c.fornecedores, ana = F.find(x => x.codFornec === 999005), t1 = F.find(x => x.codFornec === 999001); if (ana) cota(c, ana, (i, k) => k % 2 === 0, k => 0.9 + (k % 4) * 0.03, 4, ana.condicao_padrao); if (t1) cota(c, t1, () => true, k => 0.88 + ((k + 1) % 4) * 0.04, 5, t1.condicao_padrao); }
  c = mk('Cotação Bazar (antiga)', { dias: 30, seq: 9, n: 3 }); cot.encerrar(c.id, 'Tiago', 'antiga');   // encerrada sem pedido → "Concluídas"
  console.log('cotações de exemplo: ' + cot.listar().length + ' · pedidos: ' + PEDIDOS.length + ' · dados em ' + TMP);
})().catch(e => { console.error(e); process.exit(1); });

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const json = (res, obj, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function detalhe(c) {   // mesmo desenho do cotDetalhe do server.js (link, cotados, novo, canal do portal)
  return { ...c, comparativo: cot.comparativo(c), prePedidos: cot.prePedidos(c, {}),
    fornecedores: c.fornecedores.map((f, k) => ({ ...f, precos: undefined, link: BASE + '/cotacao-fornecedor.html?t=' + f.token, cotados: c.itens.filter(i => f.precos[i.cod] && f.precos[i.cod].preco > 0).length, novo: f.codFornec === 999004,
      canal: k % 3 === 0 ? { canal: 'app', app: [{ nome: f.vendedor.nome }], avisadoEm: c.criadoEm, reenvios: k ? 1 : 0 } : k % 3 === 1 ? { canal: 'whatsapp', no_portal: true, portal: [{ nome: f.vendedor.nome }] } : { canal: 'whatsapp' } })),
    canais: { app: Math.ceil(c.fornecedores.length / 3), whatsapp: c.fornecedores.length - Math.ceil(c.fornecedores.length / 3), no_portal: Math.ceil(c.fornecedores.length / 3) * 2, sem_portal: Math.floor(c.fornecedores.length / 3), exigeLogin: false } };
}
const PROBE = fs.readFileSync(path.join(__dirname, 'probe.html'), 'utf8');
http.createServer((req, res) => {
  const u = new URL(req.url, BASE), p = u.pathname;
  if (p === '/__h.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PROBE); }
  if (p === '/sw.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('self.addEventListener("install",function(){self.skipWaiting()});'); }
  if (req.method !== 'GET' && p.startsWith('/api/')) return json(res, {});
  let m;
  if (p === '/api/versao') return json(res, { versao: 'mock' });
  if (p === '/api/me') return json(res, { nome: 'Tiago Freire', perfil: 'admin' });
  if (p === '/api/estoque-cd') return json(res, { cods: { '7891000100103': 120, '7891910000197': 48 }, txt: {}, det: { '7891000100103': { un: 120 }, '7891910000197': { cx: 48 } } });
  if (p === '/api/listas-compra') return json(res, [{ lista: 277, nome: 'COTAÇÃO DE ALIMENTOS', comprador: 'Patrícia', fornecedor: 'VÁRIOS', itens: 128 }]);
  if (p === '/api/pedidos-fornecedor') return json(res, PEDIDOS);
  if (p === '/api/fornecedores/buscar') return json(res, []);
  if (p === '/api/cotacoes') return json(res, cot.listar().map(c => { const r = cot.resumo(c); const ps = (c.pedidos || []).map(x => PEDIDOS.find(y => y.id === x.id)).filter(Boolean); r.pedidos_status = { gerados: ps.length, aprovados: ps.filter(x => ['aprovado', 'recebido', 'recebido_parcial'].includes(x.status)).length, recebidos: ps.filter(x => ['recebido', 'recebido_parcial'].includes(x.status)).length, cancelados: ps.filter(x => x.status === 'cancelado').length }; return r; }));
  if ((m = p.match(/^\/api\/cotacoes\/lista\/(\d+)\/fornecedores$/))) return json(res, { total_itens: 128, salvos: FORNS.map((f, k) => ({ ...f, cnpj: '12.345.678/000' + (k + 1) + '-90', vendedores: k === 0 ? [{ nome: 'João Souza', whats: '5581988880001', email: '' }] : [], obs: k === 1 ? 'Entrega só terça e quinta' : null })), erp: [{ codFornec: 1234, nome: 'ATACADO DO NORTE LTDA', cnpj: '07.526.557/0001-00' }, { codFornec: 5678, nome: 'DISTRIBUIDORA PERNAMBUCANA', cnpj: '10.111.222/0001-33' }], da_ultima_cotacao: [], ultima_cotacao: null });
  if ((m = p.match(/^\/api\/cotacoes\/(\d+)\/ultimas-compras$/))) { const c = cot.obter(+m[1]); if (!c) return json(res, { error: 'não achei' }, 404); const ult = {}, cats = {}; c.itens.forEach((i, k) => { ult[i.cod] = { preco: r2(i.ultimo_custo * (0.96 + (k % 3) * 0.03)), fornecedor: ['ATACADO DO NORTE', 'DIST. PERNAMBUCANA', 'MEGA ATACADO'][k % 3], data: '2026-09-' + String(10 + k).padStart(2, '0'), qtd: 60 + k * 12, loja: 1 + (k % 4), cf: 1000 + k }; cats[i.cod] = { grupo: ['MERCEARIA', 'BEBIDAS', 'LIMPEZA'][k % 3], subgrupo: ['BÁSICOS', 'REFRIGERANTES', 'LAVANDERIA'][k % 3] }; }); return json(res, { ultimas: ult, categorias: cats }); }
  if ((m = p.match(/^\/api\/cotacoes\/(\d+)\/estoque$/))) return json(res, { itens: {} });
  if ((m = p.match(/^\/api\/cotacoes\/(\d+)\/giro$/))) return json(res, {});
  if ((m = p.match(/^\/api\/cotacoes\/historico\//))) return json(res, []);
  if ((m = p.match(/^\/api\/cotacoes\/fornecedor\//))) return json(res, {});
  if ((m = p.match(/^\/api\/cotacoes\/(\d+)$/))) { const c = cot.obter(+m[1]); return c ? json(res, detalhe(c)) : json(res, { error: 'cotação não encontrada' }, 404); }
  if (p.startsWith('/api/')) return json(res, { error: 'mock: sem rota ' + p }, 404);
  const f = path.join(ROOT, 'public', p === '/' ? 'cotacao.html' : p.replace(/^\//, ''));
  if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log('mock da Cotação em ' + BASE + '/cotacao.html'));
