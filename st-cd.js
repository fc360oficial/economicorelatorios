const fs=require('fs');
for (const i of [1,2,3,4,5,6]) { const p=JSON.parse(fs.readFileSync('data/pedidos-cd/'+i+'.json','utf8')); console.log(i,'L'+p.loja,p.status,'noCD=',JSON.stringify(p.noCD||null),'exped=',JSON.stringify(p.expedicao||null)); }
