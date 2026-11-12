'use strict';
// lib/dados-bancarios-relatorio.js — Relatório em PDF do Cadastro Bancário, separado por loja (Tiago, 12/11/2026: "aqui puxar por
// loja, trazer o CPF e a conta em PDF tipo relatório"). Usa os MESMOS filtros da tela Dados bancários (unidade, busca, situação,
// modalidade, com alerta, desligados) e o mesmo escopo de lojas do usuário. CPF e conta saem COMPLETOS só pra quem já vê os dados
// completos na ficha (DP / RH e Financeiro); Coordenação e Diretoria recebem a via mascarada. Cada emissão fica na auditoria.
const DB = require('./dados-bancarios');
const GP = require('./gestao-pessoas');

const cpfFmt = c => c && c.length === 11 ? c.slice(0, 3) + '.' + c.slice(3, 6) + '.' + c.slice(6, 9) + '-' + c.slice(9) : (c || '');
const FILTRO_TXT = { status: v => 'situação: ' + (DB.STATUS_TXT[v] || v), modalidade: v => 'só ' + (DB.MODALIDADE[v] || v), seguranca: () => 'só com alerta', inativos: () => 'incluindo desligados', q: v => 'busca: "' + v + '"' };

/** Linhas do relatório agrupadas por loja. { completo, filtrosTxt, grupos: [{ loja, lojaTxt, linhas, resumo }], total } */
async function dados(q, user, deps) {
  q = q || {}; const p = DB.perm(user); const completo = !!p.completo;
  const L = await DB.listarFuncionarios(q, user, deps);
  const grupos = new Map();
  for (const f of L.funcionarios) {
    const s = f.situacao; const linha = { id: f.id, nome: f.nome, cargo: f.cargo || '', ativo: f.ativo, cadastral: s.cadastral, cadastralTxt: s.cadastralTxt, bloqueado: !!s.seguranca.bloqueado,
      cpf: f.cpf_fim || '', modalidade: '', banco: '', agencia: '', conta: '', tipoConta: '', pix: '', terceiro: '' };
    if (completo) linha.cpf = cpfFmt(await deps.cpfDe(f.id)) || linha.cpf;
    if (s.atual) {
      const r = s.atual.resumo; linha.modalidade = r.modalidade;
      if (completo) {
        const d = DB.paraPagamento(f.id).conta.dados;
        linha.banco = (d.banco || DB.BANCOS[d.codigoBanco] || '') + (d.codigoBanco ? ' (' + d.codigoBanco + ')' : ''); linha.agencia = (d.agencia || '') + (d.agenciaDigito ? '-' + d.agenciaDigito : '');
        linha.conta = (d.conta || '') + (d.digito ? '-' + d.digito : ''); linha.tipoConta = DB.TIPO_CONTA[d.tipoConta] || '';
        if (d.modalidade === 'pix') linha.pix = 'Pix (' + (DB.TIPO_PIX[d.tipoChavePix] || d.tipoChavePix || '') + '): ' + (d.tipoChavePix === 'cpf' ? cpfFmt(d.chavePix) : d.chavePix);
        if (d.titularTerceiro) linha.terceiro = 'Titular: ' + (d.titular || '') + ' · CPF ' + cpfFmt(d.cpfTitular);
      } else {
        linha.banco = r.banco + (r.codigoBanco ? ' (' + r.codigoBanco + ')' : ''); linha.agencia = r.agenciaMask; linha.conta = r.contaMask; linha.tipoConta = r.tipoContaTxt;
        if (r.modalidade === 'pix') linha.pix = 'Pix (' + r.tipoChavePixTxt + '): ' + r.pixMask;
        if (r.titularTerceiro) linha.terceiro = 'Titular: ' + r.titular + ' · CPF ' + r.cpfTitularMask;
      }
    }
    const g = grupos.get(+f.loja) || grupos.set(+f.loja, { loja: +f.loja, lojaTxt: GP.LOJA_TXT[f.loja] || f.lojaTxt || ('Loja ' + f.loja), linhas: [] }).get(+f.loja);
    g.linhas.push(linha);
  }
  const lista = [...grupos.values()].sort((a, b) => a.loja - b.loja);
  for (const g of lista) g.resumo = { total: g.linhas.length, comConta: g.linhas.filter(l => l.modalidade).length, semConta: g.linhas.filter(l => !l.modalidade).length, bloqueados: g.linhas.filter(l => l.bloqueado).length };
  const filtrosTxt = Object.keys(FILTRO_TXT).filter(k => q[k]).map(k => FILTRO_TXT[k](String(q[k]).slice(0, 40)));
  return { completo, filtrosTxt, grupos: lista, total: L.total, gerado_em: L.gerado_em, lojaFiltro: q.loja ? +q.loja : null };
}

/** PDF A4 paisagem (cabem nome, função, banco e chave Pix inteiros); cada loja começa em página nova. Retorna { buffer, nomeArquivo, total }. */
async function pdf(q, user, deps) {
  const R = await dados(q, user, deps);
  if (!R.total) throw Object.assign(new Error('Nenhum funcionário com esses filtros para o relatório'), { status: 404 });
  const PDFDocument = require('pdfkit'); const LOGO = require('./logo-economico');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: 'Relatório de dados bancários', Author: 'Econômico Supermercados', Creator: 'Econômico Relatórios' } });
  const chunks = []; doc.on('data', c => chunks.push(c)); const fim = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));
  const X = 28, W = doc.page.width - 56, NAVY = '#14213D', FIM = doc.page.height - 46;
  const emitido = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }), por = user.nome || user.usuario;
  const cols = [['Nº', 22], ['Funcionário', 225], ['CPF', 78], ['Função', 150], ['Banco', 155], ['Agência', 50], ['Conta', 106]]; const sx = []; let x = X; for (const [, w] of cols) { sx.push(x); x += w; }
  /** corta o texto com reticências pra caber na largura (pdfkit com lineBreak:false invade a coluna vizinha) */
  const cabe = (s, w) => { s = String(s == null ? '' : s); if (doc.widthOfString(s) <= w) return s; while (s.length > 1 && doc.widthOfString(s + '…') > w) s = s.slice(0, -1); return s.trimEnd() + '…'; };
  /** célula; `encolhe` = dado que não pode sair cortado (conta, chave Pix, banco): diminui a fonte até caber antes de pôr reticências */
  const cel = (s, k, y, larg, encolhe) => { const w = (larg || cols[k][1]) - 5; s = String(s == null ? '' : s); let dy = 0; if (encolhe) { let t = 8; while (t > 5.5 && doc.fontSize(t).widthOfString(s) > w) t -= 0.25; dy = (8 - t) * 0.6; } doc.text(cabe(s, w), sx[k] + 3, y + dy, { width: w + 2, lineBreak: false }); };
  const cab = g => {
    LOGO.desenhar(doc, X, 20, 60);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('RELATÓRIO DE DADOS BANCÁRIOS', X + 74, 22, { width: W - 74, lineBreak: false });
    doc.fontSize(11).text(g.lojaTxt, X + 74, 38, { width: W - 74, lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor('#444').text('Econômico Supermercados · ' + (R.completo ? 'CPF e conta completos' : 'via mascarada (dados completos só para DP / RH e Financeiro)') + (R.filtrosTxt.length ? ' · ' + R.filtrosTxt.join(' · ') : '') + '\nEmitido em ' + emitido + ' por ' + por, X + 74, 53, { width: W - 74 });
    doc.y = 80; doc.rect(X, doc.y, W, 15).fill('#E6ECF4'); doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY); const y = doc.y + 4.5; cols.forEach(([t], k) => cel(t, k, y)); doc.y = y + 12.5;
  };
  let primeira = true;
  for (const g of R.grupos) {
    if (!primeira) doc.addPage(); primeira = false; cab(g); let n = 0;
    for (const l of g.linhas) {
      const obs = [l.bloqueado ? 'PAGAMENTO BLOQUEADO PARA VERIFICAÇÃO' : '', l.terceiro ? 'Conta de terceiro — ' + l.terceiro : ''].filter(Boolean).join(' · '); const alt = obs ? 22 : 13.5;
      if (doc.y + alt > FIM) { doc.addPage(); cab(g); }
      const y0 = doc.y; if (n % 2) doc.rect(X, y0, W, alt).fill('#F6F7F9'); const y = y0 + 3.5; n++;
      doc.font('Helvetica').fontSize(8).fillColor('#111');
      cel(n, 0, y); doc.font('Helvetica-Bold'); cel(l.nome + (l.ativo ? '' : ' (desligado)'), 1, y); doc.font('Helvetica'); cel(l.cpf || '—', 2, y); cel(l.cargo || '—', 3, y);
      if (!l.modalidade) { doc.font('Helvetica-Oblique').fillColor('#B42318'); cel(l.cadastral === 'nao_cadastrado' ? 'Sem conta cadastrada' : (l.cadastralTxt || '—'), 4, y, cols[4][1] + cols[5][1] + cols[6][1]); }
      else if (l.pix) cel(l.pix, 4, y, cols[4][1] + cols[5][1] + cols[6][1], true);
      else { cel(l.banco || '—', 4, y, 0, true); doc.fontSize(8); cel(l.agencia || '—', 5, y, 0, true); doc.font('Helvetica-Bold').fontSize(8); cel(l.conta || '—', 6, y, 0, true); }
      if (obs) { doc.font('Helvetica-Oblique').fontSize(7).fillColor(l.bloqueado ? '#B42318' : '#8A5A00'); cel(obs, 1, y + 10, W - cols[0][1]); }
      doc.y = y0 + alt;
    }
    if (doc.y + 30 > FIM) { doc.addPage(); cab(g); }
    doc.moveTo(X, doc.y + 2).lineTo(X + W, doc.y + 2).lineWidth(0.6).strokeColor(NAVY).stroke();
    const r = g.resumo; doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text(g.lojaTxt + ': ' + r.total + ' funcionário(s) · ' + r.comConta + ' com conta validada · ' + r.semConta + ' sem conta' + (r.bloqueados ? ' · ' + r.bloqueados + ' com pagamento bloqueado' : ''), X, doc.y + 7, { width: W });
  }
  // resumo geral quando sai mais de uma loja
  if (R.grupos.length > 1) {
    doc.addPage(); LOGO.desenhar(doc, X, 20, 60);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('RELATÓRIO DE DADOS BANCÁRIOS', X + 74, 22, { width: W - 74, lineBreak: false }); doc.fontSize(11).text('Resumo por unidade', X + 74, 38, { width: W - 74, lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor('#444').text('Econômico Supermercados' + (R.filtrosTxt.length ? ' · ' + R.filtrosTxt.join(' · ') : '') + '\nEmitido em ' + emitido + ' por ' + por, X + 74, 53, { width: W - 74 });
    const rc = [['Unidade', W - 330], ['Funcionários', 110], ['Com conta validada', 110], ['Sem conta', 110]]; const rx = []; x = X; for (const [, w] of rc) { rx.push(x); x += w; }
    const lin = (vals, y, negrito) => { doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(negrito ? NAVY : '#111'); vals.forEach((v, k) => doc.text(String(v), rx[k] + 4, y, { width: rc[k][1] - 8, lineBreak: false, align: k ? 'right' : 'left' })); };
    let y = 84; doc.rect(X, y, W, 16).fill('#E6ECF4'); lin(rc.map(c => c[0]), y + 4.5, true); y += 16;
    const tot = { total: 0, comConta: 0, semConta: 0 };
    R.grupos.forEach((g, i) => { if (i % 2) doc.rect(X, y, W, 16).fill('#F6F7F9'); lin([g.lojaTxt, g.resumo.total, g.resumo.comConta, g.resumo.semConta], y + 4.5); y += 16; for (const k in tot) tot[k] += g.resumo[k]; });
    doc.moveTo(X, y + 1).lineTo(X + W, y + 1).lineWidth(0.6).strokeColor(NAVY).stroke(); lin(['TOTAL', tot.total, tot.comConta, tot.semConta], y + 6, true);
  }
  // rodapé em todas as páginas (numeração só existe depois de montar tudo)
  const pg = doc.bufferedPageRange();
  for (let i = 0; i < pg.count; i++) {
    doc.switchToPage(pg.start + i); doc.page.margins.bottom = 0;
    doc.font('Helvetica-Oblique').fontSize(6.8).fillColor('#666').text('Documento com dados pessoais e bancários: uso restrito a DP / RH e Financeiro. Cadastro de funcionários do PontoCerto; conta = última versão validada no Cadastro Bancário. Emissão registrada na auditoria.', X, doc.page.height - 34, { width: W - 70, lineBreak: true, height: 18 });
    doc.font('Helvetica').fontSize(7.5).fillColor('#444').text('Página ' + (i + 1) + ' de ' + pg.count, X + W - 70, doc.page.height - 34, { width: 70, align: 'right', lineBreak: false });
  }
  doc.end(); const buffer = await fim;
  const lojasTxt = R.grupos.map(g => g.lojaTxt.split(' · ')[0]);
  DB.auditar({ usuario: user, loja: R.lojaFiltro, acao: 'exportar_relatorio', resultado: R.total + ' funcionário(s) · ' + (R.completo ? 'completo' : 'mascarado'), detalhe: { fmt: 'pdf', lojas: lojasTxt, filtros: R.filtrosTxt, completo: R.completo } });
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Recife' });
  return { buffer, total: R.total, nomeArquivo: 'dados-bancarios-' + (lojasTxt.length === 1 ? lojasTxt[0] : 'todas-as-lojas') + '-' + hoje + (R.completo ? '' : '-mascarado') + '.pdf' };
}

module.exports = { dados, pdf };
