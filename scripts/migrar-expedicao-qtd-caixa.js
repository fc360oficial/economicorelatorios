#!/usr/bin/env node
// Reconstrói a quantidade do pedido das conferências de saída do CD ABERTAS lendo as linhas de novo no ERP de
// produção (central.delivery_produtos) e aplicando a regra de lib/expedicao.js abrirPedido (14/10/26):
//   Qtd é em CAIXAS só quando Und ≠ UN e QtdEmb > 0 → un = Qtd × QtdEmb; senão Qtd já é em unidades
//   (FD com QtdEmb 0 e "14 FD c/12" = 168 UNIDADES, não 168 fardos — FREDAO LEITE DE COCO, pedido 7218).
// Itens já separados/bipados são reavaliados (ok/diferente) contra a nova referência.
//   ERP_PASS=... node scripts/migrar-expedicao-qtd-caixa.js            (só mostra)
//   ERP_PASS=... node scripts/migrar-expedicao-qtd-caixa.js --gravar   (grava)
const fs = require('fs'); const path = require('path');
const mysql = require(path.join(__dirname, '..', 'node_modules', 'mysql2', 'promise'));
const DIR = path.join(__dirname, '..', 'data', 'expedicao'); const gravar = process.argv.includes('--gravar');
if (!process.env.ERP_PASS) { console.error('defina ERP_PASS'); process.exit(1); }
(async () => {
  const db = await mysql.createConnection({ host: process.env.ERP_HOST || '192.168.2.252', user: process.env.ERP_USER || 'root', password: process.env.ERP_PASS, connectTimeout: 15000 });
  for (const f of fs.readdirSync(DIR).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    const arq = path.join(DIR, f); const m = JSON.parse(fs.readFileSync(arq, 'utf8')); let mudou = false;
    for (const c of Object.values(m)) {
      if (c.status === 'fechada' || !c.etapas) continue;
      const [rows] = await db.query('SELECT CodigoBarra cod, Descricao descricao, Und und, Qtd qtd, QtdEmb qtdEmb, Conversao conversao FROM central.delivery_produtos WHERE nPedido=? ORDER BY nReg', [c.nPedido]);
      if (!rows.length) { console.log(c.id, 'sem linhas no ERP, pulado'); continue; }
      const novo = {};
      for (const i of rows) {
        const cod = String(i.cod || '').trim(); if (!cod) continue;
        const qtd = +(+i.qtd || 0).toFixed(3); const qtdEmb = +i.qtdEmb > 0 ? +i.qtdEmb : 0; const mConv = /c\/\s*(\d+)/i.exec(String(i.conversao || '')); const emb = qtdEmb > 0 ? qtdEmb : (mConv ? +mConv[1] : 1);
        const und = String(i.und || '').trim().toUpperCase(); const emCaixa = und !== '' && und !== 'UN' && qtdEmb > 0; const un = emCaixa ? +(qtd * emb).toFixed(3) : qtd;
        if (novo[cod]) { novo[cod].un = +(novo[cod].un + un).toFixed(3); novo[cod].qtd = +(novo[cod].qtd + qtd).toFixed(3); }
        else novo[cod] = { cod, descricao: String(i.descricao || '').trim(), un, qtd, emb, qtdEmb, und, emCaixa, ordem: Object.keys(novo).length };
      }
      for (const p of Object.values(novo)) { const a = c.pedido[p.cod]; const dif = !a || a.un !== p.un || a.emCaixa !== p.emCaixa || a.qtdEmb !== p.qtdEmb;
        if (dif) { console.log(`${c.id} ${p.cod} ${p.descricao.slice(0, 30).padEnd(30)} ${p.und.padEnd(3)} Qtd ${p.qtd} QtdEmb ${p.qtdEmb} → un ${a ? a.un + ' → ' : ''}${p.un}${p.emCaixa ? ' (caixas × ' + p.emb + ')' : ''}`); mudou = true; } }
      for (const cod of Object.keys(c.pedido)) if (!novo[cod]) { console.log(c.id, cod, 'saiu do pedido no ERP'); mudou = true; }
      c.pedido = novo;
      for (const et of [c.etapas.separacao, c.etapas.expedicao]) if (et) for (const it of Object.values(et.itens || {})) {
        const ref = et.etapa === 'separacao' ? c.pedido[it.cod] : (c.etapas.separacao.itens || {})[it.cod];
        const estado = !ref ? 'fora' : Math.abs(it.un - ref.un) < 0.001 ? 'ok' : 'diferente';
        if (estado !== it.estado) { console.log(`  ${et.etapa} ${it.cod}: ${it.estado} → ${estado}`); it.estado = estado; mudou = true; }
      }
    }
    if (mudou && gravar) { fs.writeFileSync(arq + '.tmp', JSON.stringify(m)); fs.renameSync(arq + '.tmp', arq); console.log('gravado', f); }
    else if (mudou) console.log('(sem --gravar: nada gravado em ' + f + ')'); else console.log(f, 'já certo');
  }
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
