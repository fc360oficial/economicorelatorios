const fs=require('fs');
const p=JSON.parse(fs.readFileSync('data/pedidos-fornecedor/14.json'));
const {itens,lojas,...resto}=p; console.log(JSON.stringify(resto,null,1).slice(0,3000));
console.log('PDFs:',fs.readdirSync('data/pedidos-fornecedor').filter(f=>/^14(\.|-L)/.test(f)));
console.log('receb:',fs.existsSync('data/recebimento')?fs.readdirSync('data/recebimento').filter(f=>f.includes('14')):'-');
console.log('log-erp:',fs.existsSync('data/log-erp')?fs.readdirSync('data/log-erp').slice(-5):'-');
try{const l=fs.readdirSync('data/log-erp');for(const f of l){const t=fs.readFileSync('data/log-erp/'+f,'utf8');if(/"pedido"\s*:\s*14\b|pedidoId":14|pedido 14/.test(t))console.log('log-erp menciona 14:',f);}}catch(e){}
console.log('removidos:',fs.existsSync('data/cotacoes/_removidos')?fs.readdirSync('data/cotacoes/_removidos'):'-');
