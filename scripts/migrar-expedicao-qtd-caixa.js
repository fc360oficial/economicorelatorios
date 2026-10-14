#!/usr/bin/env node
// Conserta conferências de saída do CD ABERTAS gravadas antes de 14/10/26 (noite) com a quantidade do pedido errada:
// linha em CX/FD vinha com `un` = caixas (ex.: PAPEL HIG. FD "4" em vez de 4 × 16 = 64). Reaplica a regra de
// lib/expedicao.js abrirPedido: und ≠ UN e emb > 1 → un = qtd × emb; grava qtd/emCaixa. Itens já separados
// nessas conferências são reavaliados (estado ok/diferente) contra a nova referência.
//   node scripts/migrar-expedicao-qtd-caixa.js            (só mostra)
//   node scripts/migrar-expedicao-qtd-caixa.js --gravar   (grava)
const fs = require('fs'); const path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'expedicao'); const gravar = process.argv.includes('--gravar');
for (const f of fs.readdirSync(DIR).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
  const arq = path.join(DIR, f); const m = JSON.parse(fs.readFileSync(arq, 'utf8')); let mudou = false;
  for (const c of Object.values(m)) {
    if (c.status === 'fechada' || !c.etapas) continue;
    for (const p of Object.values(c.pedido)) {
      if (p.qtd != null) continue;                      // já no modelo novo
      const und = String(p.und || '').toUpperCase(); const emCaixa = und !== '' && und !== 'UN' && p.emb > 1;
      const qtd = p.un; const un = emCaixa ? +(qtd * p.emb).toFixed(3) : qtd;
      console.log(`${c.id} ${p.cod} ${p.descricao.slice(0, 30).padEnd(30)} ${und.padEnd(3)} ${qtd} → un ${un}${emCaixa ? ' (caixa × ' + p.emb + ')' : ''}`);
      p.qtd = qtd; p.un = un; p.und = und; p.emCaixa = emCaixa; mudou = true;
    }
    for (const et of [c.etapas.separacao, c.etapas.expedicao]) if (et) for (const it of Object.values(et.itens || {})) {
      const ref = et.etapa === 'separacao' ? c.pedido[it.cod] : (c.etapas.separacao.itens || {})[it.cod];
      const estado = !ref ? 'fora' : Math.abs(it.un - ref.un) < 0.001 ? 'ok' : 'diferente';
      if (estado !== it.estado) { console.log(`  ${et.etapa} ${it.cod}: ${it.estado} → ${estado}`); it.estado = estado; mudou = true; }
    }
  }
  if (mudou && gravar) { fs.writeFileSync(arq + '.tmp', JSON.stringify(m)); fs.renameSync(arq + '.tmp', arq); console.log('gravado', f); }
  else if (mudou) console.log('(sem --gravar: nada gravado em ' + f + ')');
}
