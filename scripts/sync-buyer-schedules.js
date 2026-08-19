#!/usr/bin/env node
/*
 * Sincroniza o cronograma de compras das 5 compradoras a partir de public/mensal.html
 * (CRON_FATIMA/KELLY/STHEPHANNY/CRISLANE/PATRICIA — a fonte de verdade) para os outros
 * 4 lugares que guardam cópia própria dos mesmos dados:
 *
 *   1. server.js               -> NREGS_COMPRADOR (lista simples de nRegs por comprador)
 *   2. public/compras.html     -> funções xxxHoje() (Central de Compras / Painel TV)
 *   3. public/comprador.html   -> objeto DADOS[...].cronograma (painel por comprador)
 *   4. public/relatorio-cronograma.html -> checklist imprimível em HTML puro
 *
 * Uso:
 *   1. Edite os CRON_* em public/mensal.html com a atualização da planilha.
 *   2. Rode: node scripts/sync-buyer-schedules.js
 *   3. Revise o diff (git diff), confirme que faz sentido, e commit.
 *
 * Idempotente — pode rodar mais de uma vez seguida sem corromper nada.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = {
  mensal: path.join(ROOT, 'public/mensal.html'),
  server: path.join(ROOT, 'server.js'),
  compras: path.join(ROOT, 'public/compras.html'),
  comprador: path.join(ROOT, 'public/comprador.html'),
  relatorio: path.join(ROOT, 'public/relatorio-cronograma.html'),
};

const BUYERS = ['FATIMA', 'KELLY', 'STHEPHANNY', 'CRISLANE', 'PATRICIA'];
const FUNCS = { FATIMA: 'fatimaHoje', KELLY: 'kellyHoje', STHEPHANNY: 'sthephannyHoje', CRISLANE: 'crislaneHoje', PATRICIA: 'patriciaHoje' };
const KEY = { FATIMA: 'FÁTIMA', KELLY: 'KELLY', STHEPHANNY: 'STHEPHANNY', CRISLANE: 'CRISLANE', PATRICIA: 'PATRICIA' };
const DIAS = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'];
const DIA_LABEL = { SEG: 'Segunda', TER: 'Terca', QUA: 'Quarta', QUI: 'Quinta', SEX: 'Sexta' };

const mensal = fs.readFileSync(P.mensal, 'utf8');

function stripAccents(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escJs(s) { return s.replace(/'/g, "\\'"); }

// ---- fonte de verdade: parse dos CRON_* do mensal.html ----
function parseCron(buyer) {
  const start = mensal.indexOf(`const CRON_${buyer}`);
  const nextConst = mensal.indexOf('\nconst CRON_', start + 10);
  const endMarker = mensal.indexOf('\nconst COMPRADORES', start);
  const end = nextConst !== -1 && nextConst < endMarker ? nextConst : endMarker;
  const block = mensal.slice(start, end);
  const weeks = {};
  for (const week of ['1e3', '2e4']) {
    const wIdx = block.indexOf(`'${week}':{`);
    const wEndIdx = week === '1e3' ? block.indexOf(`'2e4':{`) : block.length;
    const wBlock = block.slice(wIdx, wEndIdx);
    const days = {};
    for (const day of DIAS) {
      const dRe = new RegExp(day + ':\\[([\\s\\S]*?)\\n(?:    )?\\],');
      const m = wBlock.match(dRe);
      const items = [];
      if (m) {
        const itemRe = /\{nReg:(\d+),nome:'([^']*)',cat:'([^']*)'\}/g;
        let im;
        while ((im = itemRe.exec(m[1]))) items.push({ nReg: parseInt(im[1], 10), nome: im[2], cat: im[3] });
      }
      days[day] = items;
    }
    weeks[week] = days;
  }
  return weeks;
}

function sameDay(a, b) {
  return a.map(x => x.nReg).sort().join(',') === b.map(x => x.nReg).sort().join(',');
}

function groupByCat(items, mensalCatToOldName) {
  const order = [], byName = {};
  for (const it of items) {
    const name = mensalCatToOldName[it.cat] || it.cat;
    if (!byName[name]) { byName[name] = []; order.push(name); }
    byName[name].push(it);
  }
  return order.map(name => ({ nome: name, fornecedores: byName[name] }));
}

// vota qual nome de categoria "bonito" (do arquivo antigo) reaproveitar pra cada `cat` cru do mensal
function buildCatNameMap(weeks, oldCodMap) {
  const votes = {};
  for (const week of ['1e3', '2e4']) for (const day of DIAS) for (const it of weeks[week][day]) {
    const oldName = oldCodMap[it.nReg];
    if (oldName) { votes[it.cat] = votes[it.cat] || {}; votes[it.cat][oldName] = (votes[it.cat][oldName] || 0) + 1; }
  }
  const map = {};
  for (const cat of Object.keys(votes)) {
    let best = null, bestN = 0;
    for (const name of Object.keys(votes[cat])) if (votes[cat][name] > bestN) { best = name; bestN = votes[cat][name]; }
    map[cat] = best;
  }
  return map;
}

// =====================================================================
// 1) server.js -> NREGS_COMPRADOR
// =====================================================================
function syncServerJs() {
  let server = fs.readFileSync(P.server, 'utf8');
  const lines = [];
  for (const buyer of BUYERS) {
    const weeks = parseCron(buyer);
    const set = new Set();
    for (const week of ['1e3', '2e4']) for (const day of DIAS) for (const it of weeks[week][day]) set.add(it.nReg);
    const arr = [...set].sort((a, b) => a - b);
    lines.push(`  ${buyer}: [${arr.join(',')}],`);
  }
  const newBlock = `const NREGS_COMPRADOR = {\n${lines.join('\n')}\n};`;
  const re = /const NREGS_COMPRADOR = \{[\s\S]*?\n\};/;
  if (!re.test(server)) throw new Error('NREGS_COMPRADOR block not found in server.js');
  server = server.replace(re, newBlock);
  fs.writeFileSync(P.server, server, 'utf8');
  console.log('✓ server.js (NREGS_COMPRADOR) atualizado');
}

// =====================================================================
// 2) public/compras.html -> funções xxxHoje()
// =====================================================================
function syncComprasHtml() {
  const original = fs.readFileSync(P.compras, 'utf8');
  let html = original;

  function parseOldCategorias(buyer) {
    const fnName = FUNCS[buyer];
    const start = original.indexOf(`function ${fnName}(`);
    const end = original.indexOf(`\nconst _`, start);
    const block = original.slice(start, end);
    const map = {};
    const re = /\{nome:'([^']*)',fornecedores:\[([\s\S]*?)\]\}/g;
    let cm;
    while ((cm = re.exec(block))) {
      const codRe = /cod:(\d+)/g;
      let cdm;
      while ((cdm = codRe.exec(cm[2]))) { const cod = parseInt(cdm[1], 10); if (!map[cod]) map[cod] = cm[1]; }
    }
    return map;
  }

  function emitCategorias(groups) {
    const pad = '  ';
    if (groups.length === 0) return '{categorias:[],atividades:[]}';
    const lines = [`{categorias:[`];
    groups.forEach((g, gi) => {
      const forn = g.fornecedores.map(f => `${pad}      {nome:'${escJs(f.nome)}',status:'r',cod:${f.nReg}}`).join(',\n');
      const suffix = gi === groups.length - 1 ? ']}],' : ']},';
      lines.push(`${pad}    {nome:'${escJs(g.nome)}',fornecedores:[\n${forn}${suffix}`);
    });
    lines.push(`${pad} atividades:[]}`);
    return lines.join('\n');
  }

  for (const buyer of BUYERS) {
    const weeks = parseCron(buyer);
    const oldMap = parseOldCategorias(buyer);
    const catNameMap = buildCatNameMap(weeks, oldMap);

    const declLines = [];
    const schedParts = {};
    for (const day of DIAS) {
      const d1 = weeks['1e3'][day], d2 = weeks['2e4'][day];
      const lc = day.toLowerCase();
      if (sameDay(d1, d2)) {
        declLines.push(`  const ${lc} = ${emitCategorias(groupByCat(d1, catNameMap))};`);
        schedParts[day] = lc;
      } else {
        declLines.push(`  const ${lc}_impar = ${emitCategorias(groupByCat(d1, catNameMap))};`);
        declLines.push(`  const ${lc}_par = ${emitCategorias(groupByCat(d2, catNameMap))};`);
        schedParts[day] = `impar ? ${lc}_impar : ${lc}_par`;
      }
    }
    let newBody = declLines.join('\n\n') + '\n\n  const sched = {\n';
    for (const day of DIAS) newBody += `    ${day}: ${schedParts[day]},\n`;
    newBody += '  };\n\n  ';

    const fnName = FUNCS[buyer];
    const fnStart = html.indexOf(`function ${fnName}(`);
    const headerEnd = html.indexOf('impar  = semana % 2 === 1', fnStart);
    const headerLineEnd = html.indexOf('\n', headerEnd) + 1;
    const returnIdx = html.indexOf('return sched[sig]', fnStart);
    html = html.slice(0, headerLineEnd) + '\n' + newBody + html.slice(returnIdx);
  }

  fs.writeFileSync(P.compras, html, 'utf8');
  console.log('✓ compras.html atualizado');
}

// =====================================================================
// 3) public/comprador.html -> DADOS[...].cronograma
// =====================================================================
function syncCompradorHtml() {
  const original = fs.readFileSync(P.comprador, 'utf8');
  let html = original;

  // remove funções auxiliares antigas da Fátima, se ainda existirem (só na primeira vez que este
  // script roda contra um arquivo "legado" — em runs seguintes elas já não existem, e o passo é pulado)
  const fnStart = html.indexOf('function fatimaSeg1e3()');
  if (fnStart !== -1) {
    const dadosStart = html.indexOf('const DADOS = {');
    html = html.slice(0, fnStart) + html.slice(dadosStart);
  }

  function parseOldCategorias() {
    const map = {};
    const re = /\{\s*nome:\s*'([^']*)',\s*itens:\s*\[([\s\S]*?)\]\s*\}/g;
    let cm;
    while ((cm = re.exec(original))) {
      const codRe = /cod:\s*(\d+)/g;
      let cdm;
      while ((cdm = codRe.exec(cm[2]))) { const cod = parseInt(cdm[1], 10); if (!map[cod]) map[cod] = cm[1]; }
    }
    return map;
  }
  const oldMap = parseOldCategorias();

  function emitDay(items, catNameMap, indent) {
    const groups = groupByCat(items, catNameMap);
    const pad = ' '.repeat(indent);
    if (groups.length === 0) return `{ categorias: [], atividades: [] }`;
    const lines = [`{ categorias: [`];
    groups.forEach(g => {
      const itens = g.fornecedores.map(f => `${pad}    { nome: '${escJs(f.nome)}',status:'r',pedido:null,cod:${f.nReg}},`).join('\n');
      lines.push(`${pad}  { nome: '${escJs(g.nome)}', itens: [\n${itens}\n${pad}  ]},`);
    });
    lines.push(`${pad}], atividades: [] }`);
    return lines.join('\n');
  }

  let searchFrom = 0;
  for (const buyer of BUYERS) {
    const weeks = parseCron(buyer);
    const catNameMap = buildCatNameMap(weeks, oldMap);

    let block = `    cronograma: {\n`;
    for (const week of ['1e3', '2e4']) {
      block += `      '${week}': {\n`;
      for (const day of DIAS) block += `        ${day}: ${emitDay(weeks[week][day], catNameMap, 8)},\n`;
      block += `      },\n`;
    }
    block += `    },`;

    const key = KEY[buyer];
    const keyIdx = html.indexOf(`'${key}': {`, searchFrom);
    if (keyIdx === -1) throw new Error(`buyer key not found in comprador.html: ${buyer}`);
    let cronIdx = html.indexOf('cronograma: {', keyIdx);
    const lineStart = html.lastIndexOf('\n', cronIdx) + 1;
    cronIdx = lineStart; // replace from start of line so re-runs don't accumulate leading whitespace
    const braceStart = html.indexOf('{', cronIdx);
    let depth = 1, i = braceStart + 1;
    while (depth > 0) { if (html[i] === '{') depth++; else if (html[i] === '}') depth--; i++; }
    let endIdx = i;
    if (html[endIdx] === ',') endIdx++;
    html = html.slice(0, cronIdx) + block + html.slice(endIdx);
    searchFrom = cronIdx + block.length;
  }

  fs.writeFileSync(P.comprador, html, 'utf8');
  console.log('✓ comprador.html atualizado');
}

// =====================================================================
// 4) public/relatorio-cronograma.html -> checklist imprimível
// =====================================================================
function syncRelatorioHtml() {
  let html = fs.readFileSync(P.relatorio, 'utf8');

  function emitRows(days) {
    const rows = [];
    for (const day of DIAS) {
      days[day].forEach((it, i) => {
        const diaCell = i === 0 ? `<td class="dia">${DIA_LABEL[day]}</td>` : `<td class="dia"></td>`;
        rows.push(`    <tr>${diaCell}<td class="fnm">${escHtml(it.nome)}</td><td class="cat">${escHtml(stripAccents(it.cat))}</td><td class="ck"><span class="cb"></span></td></tr>`);
      });
    }
    return rows.join('\n');
  }

  for (const buyer of BUYERS) {
    const weeks = parseCron(buyer);
    const marker = `<!-- ==================== ${buyer} ====================`;
    const pageStart = html.indexOf(marker);
    if (pageStart === -1) throw new Error(`page marker not found in relatorio-cronograma.html: ${buyer}`);
    const nextMarkerIdx = html.indexOf('<!-- ====', pageStart + marker.length);
    const pageEnd = nextMarkerIdx === -1 ? html.length : nextMarkerIdx;
    let page = html.slice(pageStart, pageEnd);

    const tbodyRe = /<tbody>([\s\S]*?)<\/tbody>/g;
    const matches = [...page.matchAll(tbodyRe)];
    if (matches.length !== 2) throw new Error(`expected 2 <tbody> for ${buyer}, found ${matches.length}`);

    const rows1 = emitRows(weeks['1e3']);
    const rows2 = emitRows(weeks['2e4']);
    const newPage = page.slice(0, matches[0].index) + `<tbody>\n${rows1}\n    </tbody>` +
      page.slice(matches[0].index + matches[0][0].length, matches[1].index) + `<tbody>\n${rows2}\n    </tbody>` +
      page.slice(matches[1].index + matches[1][0].length);

    html = html.slice(0, pageStart) + newPage + html.slice(pageEnd);
  }

  fs.writeFileSync(P.relatorio, html, 'utf8');
  console.log('✓ relatorio-cronograma.html atualizado');
}

// =====================================================================
function validateSyntax(filePath, isHtml) {
  const { execSync } = require('child_process');
  const os = require('os');
  const content = fs.readFileSync(filePath, 'utf8');
  const js = isHtml
    ? [...content.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n;\n')
    : content;
  const tmp = path.join(os.tmpdir(), 'sync-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, js, 'utf8');
  try {
    execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

function main() {
  syncServerJs();
  syncComprasHtml();
  syncCompradorHtml();
  syncRelatorioHtml();

  console.log('\nValidando sintaxe...');
  validateSyntax(P.compras, true);
  validateSyntax(P.comprador, true);
  console.log('✓ sintaxe OK em compras.html e comprador.html');
  console.log('\nPronto. Revise com "git diff" antes de commitar.');
}

main();
