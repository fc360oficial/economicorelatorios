const fs = require('fs');
for (const i of [1, 2, 3]) { const p = JSON.parse(fs.readFileSync('C:/fc360/claude_code_/data/pedidos-cd/' + i + '.json'));
  const comVal = p.itens.filter(x => x.validadeLoja); if (!comVal.length) { console.log('AINDA'); process.exit(0); }
  console.log('NOVO pedido', i, 'itens c/ validade', comVal.length + '/' + p.itens.length, comVal.slice(0, 4).map(x => x.descricao.slice(0, 22) + ' ' + x.validadeLoja).join(' | ')); }
