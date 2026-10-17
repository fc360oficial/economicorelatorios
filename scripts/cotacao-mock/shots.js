'use strict';
// Tira print de cada tela da Cotação em 1920 / 1600 / 1366 / 1280 px (regra do CLAUDE.md) pelo Chrome headless e, pela
// página /__h.html do mock, mede se a página rolou de lado (scrollWidth > clientWidth). Precisa do mock no ar (server.js).
//   uso: node scripts/cotacao-mock/shots.js [larguras] [telas]     ex.: node scripts/cotacao-mock/shots.js 1366 s1-pipeline,s5-pedidos
//   prints saem em %TEMP%/cotacao-shots (ou COTACAO_SHOTS); Chrome em CHROME (padrão: Program Files)
const { execFile } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.COTACAO_SHOTS || path.join(os.tmpdir(), 'cotacao-shots'); fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:' + (process.env.PORT || 4477);
// [nome, url, localStorage pré-ajustado] — as cotações de exemplo têm id fixo (1 fechada c/ XML, 3 pronta p/ análise, 7 pré-pedido, 8 prazo vencido)
const SCREENS = [
  ['s1-pipeline', '/cotacao.html', 'cot-mon-vista:pipeline'],
  ['s1-lista', '/cotacao.html', 'cot-mon-vista:lista'],
  ['s2-nova', '/cotacao.html?tela=s2', ''],
  ['s3-acomp', '/cotacao.html?id=3&tela=s3', ''],
  ['s3-prazo', '/cotacao.html?id=8&tela=s3', ''],
  ['s4-produtos', '/cotacao.html?id=7&tela=s4&aba=produtos', 'cot-vista:itens'],
  ['s4-prepedidos', '/cotacao.html?id=7&tela=s4&aba=prepedidos', 'cot-vista:itens'],
  ['s4-prepedido-det', '/cotacao.html?id=7&tela=s4&forn=999001', 'cot-vista:itens'],
  ['s4-pedidos', '/cotacao.html?id=7&tela=s4&aba=pedidos', 'cot-vista:itens'],
  ['s4-matriz', '/cotacao.html?id=3&tela=s4', 'cot-vista:matriz'],
  ['s5-pedidos', '/cotacao.html?id=1&tela=s5', ''],
  ['s6-forn', '/cotacao.html?lista=277&tela=s6', '']
];
const WIDTHS = (process.argv[2] || '1920,1600,1366,1280').split(',').map(Number);
const SO = (process.argv[3] || '').split(',').filter(Boolean);
const run = args => new Promise(res => execFile(CHROME, args, { maxBuffer: 80e6 }, (e, so, se) => res({ e, so, se })));
async function one(name, url, ls, w, slot) {
  const h = new URL(BASE + '/__h.html'); h.searchParams.set('u', url); if (ls) h.searchParams.set('ls', ls);
  const common = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--user-data-dir=' + path.join(OUT, '.prof' + slot), '--window-size=' + w + ',1300', '--virtual-time-budget=9000'];
  await run(common.concat(['--screenshot=' + path.join(OUT, name + '-' + w + '.png'), h.toString()]));
  const r = await run(common.concat(['--dump-dom', h.toString()]));
  const m = /<title>(PROBE[^<]*)<\/title>/.exec(r.so || '');
  return (m ? m[1] : 'PROBE ?? ' + String(r.se || '').slice(0, 160)).replace(/&amp;/g, '&') + '   [' + name + ' @' + w + ']';
}
(async () => {
  const jobs = []; for (const s of SCREENS) if (!SO.length || SO.includes(s[0])) for (const w of WIDTHS) jobs.push([s, w]);
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: 4 }, async (_, slot) => { while (i < jobs.length) { const [s, w] = jobs[i++]; out.push(await one(s[0], s[1], s[2], w, slot)); } }));
  out.sort((a, b) => a.slice(a.indexOf('[')).localeCompare(b.slice(b.indexOf('['))));
  console.log(out.join('\n'));
  console.log('\nprints em ' + OUT + ' · ' + out.length + ' combinações · com rolagem lateral: ' + out.filter(x => /overflow=YES/.test(x)).length);
})();
