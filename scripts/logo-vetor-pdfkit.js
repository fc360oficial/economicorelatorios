// scripts/logo-vetor-pdfkit.js — converte o PDF vetorial da logo (Corel) em lib/logo-economico.js (stream pdfkit deflatado em base64).
// Uso: node scripts/logo-vetor-pdfkit.js docs/logo-economico-vetor.pdf lib/logo-economico.js  (rodar de novo se a logo mudar)
'use strict';
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const [,, pdfIn, jsOut] = process.argv;
const b = fs.readFileSync(pdfIn);
const s = b.toString('latin1');
const i = s.indexOf('10 0 obj'); const st = s.indexOf('stream', i) + 6; const start = s[st] === '\r' ? st + 2 : st + 1;
const len = +s.slice(i, st).match(/\/Length (\d+)/)[1];
const raw = zlib.inflateSync(b.slice(start, start + len)).toString('latin1');
const mb = s.slice(s.indexOf('/MediaBox'), s.indexOf('/MediaBox') + 60).match(/\[([^\]]+)\]/)[1].trim().split(/\s+/).map(Number);
const out = []; let scn4 = 0, bad = [];
for (let line of raw.split(/\r?\n/)) {
  line = line.trim(); if (!line) continue;
  if (/^\/GS\d+ gs$/.test(line) || /^\/OC /.test(line) || line === 'EMC' || /^\/CS\d+ (cs|CS)$/.test(line)) continue;
  let m;
  if ((m = line.match(/^(?:\/CS\d+ (?:cs|CS) )?(.*) (scn|SCN)$/))) { const nums = m[1].trim().split(/\s+/); if (nums.length !== 4) bad.push(line); scn4++; line = nums.map(n => (+n).toFixed(4).replace(/\.?0+$/, '')).join(' ') + ' ' + (m[2] === 'scn' ? 'k' : 'K'); }
  else line = line.replace(/-?\d+\.\d+/g, n => (+n).toFixed(3).replace(/\.?0+$/, ''));
  out.push(line);
}
if (bad.length) { console.error('cores não-CMYK:', bad); process.exit(1); }
const limpo = out.join('\n');
// confere que só sobraram operadores conhecidos
const ops = new Set(); for (const m of limpo.matchAll(/(?:^|\s)([a-zA-Z*]{1,3})(?=\s|$)/g)) ops.add(m[1]);
console.log('ops:', [...ops].join(' '), '| cores:', scn4, '| bytes:', raw.length, '->', limpo.length);
const b64 = zlib.deflateSync(Buffer.from(limpo, 'latin1'), { level: 9 }).toString('base64');
const [x0, y0, x1, y1] = mb;
const js = `'use strict';
// lib/logo-economico.js — logomarca oficial da Econômico Supermercados em VETOR para os PDFs (pdfkit).
// Origem: "logo economico vetor.pdf" (Corel, 26/09/2025) enviado pelo Tiago em 23/10/2026. O stream de conteúdo da página
// foi limpo (só operadores de caminho e cor CMYK) e vem deflatado em base64; gerado por scratchpad/logo-conv.js.
// Uso: const LOGO = require('./logo-economico'); LOGO.desenhar(doc, x, y, larguraEmPontos) — (x, y) é o canto superior esquerdo.
const zlib = require('zlib');
const BOX = { x0: ${x0}, y0: ${y0}, x1: ${x1}, y1: ${y1} };            // MediaBox do PDF original (pontos, origem embaixo)
const LARGURA = BOX.x1 - BOX.x0, ALTURA = BOX.y1 - BOX.y0;
const PROPORCAO = ALTURA / LARGURA;                                     // altura = largura × PROPORCAO
let stream = null;
function conteudo() { if (!stream) stream = zlib.inflateSync(Buffer.from(B64, 'base64')).toString('latin1'); return stream; }
/** Desenha a logo com o canto superior esquerdo em (x, y) e a largura pedida; a altura sai proporcional (retorna a altura). */
function desenhar(doc, x, y, largura) {
  const s = largura / LARGURA;
  doc.save();
  doc.translate(x, y); doc.scale(s, -s); doc.translate(-BOX.x0, -BOX.y1);   // PDF (y pra cima) → página do pdfkit (y pra baixo)
  doc.addContent(conteudo());
  doc.restore();
  return largura * PROPORCAO;
}
const B64 = '${b64}';
module.exports = { desenhar, PROPORCAO, LARGURA, ALTURA };
`;
fs.writeFileSync(jsOut, js);
console.log('gravado', jsOut, js.length, 'bytes');
