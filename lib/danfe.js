// DANFE SIMPLIFICADA gerada a partir dos dados do XML que o ERP guarda (central.axml / axmlprodutos / axmlboletos).
// Não é o arquivo XML original nem a DANFE oficial do fornecedor: é um espelho fiel dos dados pra conferência.
// A consulta oficial fica no portal da SEFAZ pela chave de acesso (link na tela).
const PDFDocument = require('pdfkit');
const { PassThrough } = require('stream');

const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n3 = v => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const br = s => String(s || '').split('-').reverse().join('/');
const cnpj = s => { const d = String(s || '').replace(/\D/g, ''); return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : s || ''; };
const chaveFmt = s => String(s || '').replace(/(\d{4})(?=\d)/g, '$1 ');

// devolve um stream com o PDF
function gerarDanfe(n) {
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: `DANFE simplificada NF-e ${n.nNota}` } });
  const out = new PassThrough(); doc.pipe(out);
  const W = doc.page.width - 60; let y = 30;
  const box = (x, yy, w, h, titulo, linhas, opts = {}) => {
    doc.rect(x, yy, w, h).lineWidth(0.6).strokeColor('#333').stroke();
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#555').text(titulo.toUpperCase(), x + 4, yy + 3, { width: w - 8 });
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 8.5).fillColor('#000');
    let ly = yy + 12; for (const l of linhas) { doc.text(String(l), x + 4, ly, { width: w - 8, lineBreak: false }); ly += (opts.size || 8.5) + 2; }
  };
  // cabeçalho
  doc.rect(30, y, W, 54).lineWidth(0.8).strokeColor('#333').stroke();
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(n.NomeEmit || '', 36, y + 6, { width: W * 0.55 });
  doc.font('Helvetica').fontSize(8).fillColor('#333').text(`CNPJ ${cnpj(n.CNPJemit)}`, 36, y + 24, { width: W * 0.55 });
  doc.font('Helvetica-Bold').fontSize(11).text('DANFE SIMPLIFICADA', 30 + W * 0.58, y + 6, { width: W * 0.4, align: 'right' });
  doc.font('Helvetica').fontSize(8).text(`NF-e nº ${n.nNota}${n.nSerie ? '  série ' + n.nSerie : ''}  ·  emissão ${br(n.data)}`, 30 + W * 0.58, y + 22, { width: W * 0.4, align: 'right' });
  doc.fontSize(7).fillColor('#555').text('Espelho dos dados do XML no ERP · conferência interna · não substitui a DANFE oficial', 30 + W * 0.58, y + 36, { width: W * 0.4, align: 'right' });
  y += 60;
  box(30, y, W, 28, 'Chave de acesso', [chaveFmt(n.Chave)], { size: 9.5, bold: true }); y += 34;
  const half = (W - 6) / 2;
  box(30, y, half, 40, 'Destinatário', [n.NomeDest || '', `CNPJ ${cnpj(n.CNPJdest)}`]);
  box(30 + half + 6, y, half, 40, 'Situação no ERP', [n.Importado ? 'XML importado (nota de entrada gerada)' : 'XML recebido, ainda não importado', `${n.itens.length} item(ns)`]); y += 46;
  // totais
  const tot = [['Produtos', n.ValorProduto], ['Desconto', n.ValorDesconto], ['Frete', n.ValorFrete], ['IPI', n.ValorIPI], ['ICMS ST', n.ValorICMSsub], ['TOTAL DA NF-e', n.ValorNFE]];
  const tw = W / tot.length;
  tot.forEach(([t, v], i) => box(30 + i * tw, y, tw, 26, t, [brl(v)], { bold: i === tot.length - 1, size: 9 })); y += 32;
  // duplicatas
  if (n.boletos && n.boletos.length) { box(30, y, W, 26, 'Duplicatas / boletos', [n.boletos.map(b => `${b.dup}: ${br(b.vencimento)} ${brl(b.valor)}`).join('   ·   ')]); y += 32; }
  // itens
  const cols = [['Código', 78], ['Descrição', W - 78 - 32 - 48 - 60 - 66 - 62], ['Und', 32], ['Qtd', 48], ['V. unit', 60], ['V. total', 66], ['Un. trib.', 62]];
  const head = () => { doc.rect(30, y, W, 14).fill('#E8E8E8'); let x = 30; doc.font('Helvetica-Bold').fontSize(7).fillColor('#000'); for (const [t, w] of cols) { doc.text(t.toUpperCase(), x + 3, y + 4, { width: w - 6, align: ['Código', 'Descrição', 'Und'].includes(t) ? 'left' : 'right' }); x += w; } y += 14; };
  head();
  for (const [k, i] of n.itens.entries()) {
    if (y > doc.page.height - 50) { doc.addPage(); y = 30; head(); }
    if (k % 2) doc.rect(30, y, W, 13).fill('#FAFAFA');
    let x = 30; doc.font('Helvetica').fontSize(7.5).fillColor('#000');
    const vals = [i.cod, i.descricao, i.und || '', n3(i.qtd), Number(i.valorUnit || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }), brl(i.total), i.unidades ? `${n3(i.unidades)} ${i.undTrib || ''}${i.precoUnit ? ' @ ' + Number(i.precoUnit).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}` : ''];
    cols.forEach(([t, w], ci) => { doc.text(String(vals[ci]), x + 3, y + 3, { width: w - 6, align: ci <= 2 ? 'left' : 'right', lineBreak: false }); x += w; });
    y += 13;
  }
  doc.rect(30, y, W, 0.6).fill('#333');
  doc.font('Helvetica').fontSize(7).fillColor('#555').text(`Gerado pelo Econômico Relatórios em ${new Date().toLocaleString('pt-BR')} a partir do XML da NF-e no ERP. Consulta oficial: portal da NF-e (SEFAZ) pela chave de acesso.`, 30, doc.page.height - 40, { width: W });
  doc.end();
  return out;
}
module.exports = { gerarDanfe };
