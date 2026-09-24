// Reescreve os CRON_* de public/mensal.html a partir do vínculo lista→compradora do ERP.
// Mantém dia/semana/categoria de quem já estava no cronograma (mesmo se mudou de compradora);
// lista nova entra no dia da lista irmã (mesmo CodFornec) da mesma compradora; sem irmã = pendente.
const fs = require('fs');
const SP = 'C:/Users/tiago/AppData/Local/Temp/claude/C--Users-tiago/7abd50fb-bec0-42bf-b874-9744259d1ed2/scratchpad/';
const file = 'public/mensal.html';
let src = fs.readFileSync(file, 'utf8');
const agenda = JSON.parse(fs.readFileSync(SP + 'agenda.json', 'utf8')).rows;
const full = JSON.parse(fs.readFileSync(SP + 'full.json', 'utf8'));
const listaCod = {}; const listaNome = {}; for (const l of full.listas) { listaCod[l.id] = l.codf; listaNome[l.id] = l.nome; }
const MAP = { FATIMA: 'FATIMA PEREIRA', KELLY: 'ANA KELLY', STHEPHANNY: 'STEPHANNY', CRISLANE: 'CRISLANE CECILIA', PATRICIA: 'PATRICIA PEREIRA' };
const DIAS = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'];
// parse atual
const cron = {}; const blocks = {};
for (const m of src.matchAll(/const CRON_([A-Z]+) = (\{[\s\S]*?\n\});/g)) { cron[m[1]] = eval('(' + m[2] + ')'); blocks[m[1]] = m[0]; }
// onde cada nReg está hoje: lista de {buyer, week, day, item}
const where = {};
for (const [b, obj] of Object.entries(cron)) for (const [w, days] of Object.entries(obj)) for (const [d, items] of Object.entries(days)) for (const it of items) (where[it.nReg] ||= []).push({ b, w, d, it });
// ERP
const erp = {}; for (const r of agenda) { const n = r.nome.trim().toUpperCase(); (erp[n] ||= new Set()).add(r.nLista); }
const pend = []; const log = [];
const novo = {};
for (const b of Object.keys(cron)) {
  const set = erp[MAP[b]] ? [...erp[MAP[b]]] : [];
  const out = { '1e3': { SEG: [], TER: [], QUA: [], QUI: [], SEX: [] }, '2e4': { SEG: [], TER: [], QUA: [], QUI: [], SEX: [] } };
  const placed = new Set();
  // 1) quem já tem dia em algum cronograma
  for (const n of set) { const w = where[n]; if (!w) continue; for (const x of w) out[x.w][x.d].push({ nReg: n, nome: x.it.nome, cat: x.it.cat }); placed.add(n); if (w[0].b !== b) log.push(`${b}: ${n} ${w[0].it.nome} veio de ${w[0].b}`); }
  // 2) lista nova: irmã (mesmo CodFornec) já colocada nesta compradora
  for (const n of set) { if (placed.has(n)) continue; const sib = set.find(s => placed.has(s) && listaCod[s] === listaCod[n] && listaCod[n] > 0); if (sib) { for (const x of where[sib]) out[x.w][x.d].push({ nReg: n, nome: listaNome[n], cat: x.it.cat }); placed.add(n); log.push(`${b}: ${n} ${listaNome[n]} NOVA, mesmo dia da irmã ${sib} ${listaNome[sib]}`); } else { const any = Object.keys(where).find(k => listaCod[k] === listaCod[n] && listaCod[n] > 0); if (any) { for (const x of where[any]) out[x.w][x.d].push({ nReg: n, nome: listaNome[n], cat: x.it.cat }); placed.add(n); log.push(`${b}: ${n} ${listaNome[n]} NOVA, mesmo dia de ${any} ${where[any][0].it.nome} (${where[any][0].b})`); } else pend.push({ b, n, nome: listaNome[n], codf: listaCod[n] }); } }
  // removidos
  for (const n of Object.keys(where)) if (where[n][0].b === b && !set.includes(+n)) log.push(`${b}: ${n} ${where[n][0].it.nome} SAIU (ERP: ${Object.entries(erp).find(([k, v]) => v.has(+n))?.[0] || 'sem compradora'})`);
  novo[b] = out;
}
const esc = s => String(s).split(String.fromCharCode(92)).join(String.fromCharCode(92,92)).split(String.fromCharCode(39)).join(String.fromCharCode(92,39));
const render = (b, obj) => `const CRON_${b} = {\n` + ['1e3', '2e4'].map(w => `  '${w}':{\n` + DIAS.map(d => `    ${d}:[\n` + obj[w][d].sort((a, c) => (a.cat + a.nome).localeCompare(c.cat + c.nome)).map(it => `      {nReg:${it.nReg},nome:'${esc(it.nome)}',cat:'${esc(it.cat)}'},`).join('\n') + (obj[w][d].length ? '\n' : '') + `    ],\n`).join('') + `  },\n`).join('') + `};`;
for (const b of Object.keys(cron)) src = src.replace(blocks[b], render(b, novo[b]));
fs.writeFileSync(file, src);
fs.writeFileSync(SP + 'recron_pend.json', JSON.stringify(pend, null, 1));
console.log(log.join('\n')); console.log('\nPENDENTES (sem dia):'); for (const p of pend) console.log(' ', p.b, p.n, p.nome, 'codf', p.codf);
