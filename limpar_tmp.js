const fs=require('fs');
const DC='data/cotacoes', DP='data/pedidos-fornecedor';
fs.mkdirSync(DC+'/_removidos',{recursive:true}); fs.mkdirSync(DP+'/excluidos',{recursive:true});
const cot=[];
for(const f of fs.readdirSync(DC).filter(f=>f.endsWith('.json'))){ fs.renameSync(DC+'/'+f, DC+'/_removidos/'+f); cot.push(f); }
const p=JSON.parse(fs.readFileSync(DP+'/14.json'));
p.excluidoEm=new Date().toISOString(); p.excluidoPor='Tiago Freire (limpeza cotações teste)';
fs.writeFileSync(DP+'/excluidos/14.json',JSON.stringify(p)); fs.unlinkSync(DP+'/14.json');
for(const f of fs.readdirSync(DP)) if(f.endsWith('.pdf')&&(f==='14.pdf'||f.startsWith('14-L'))) fs.unlinkSync(DP+'/'+f);
console.log('cotacoes removidas:',cot.join(', '));
console.log('restam cotacoes:',fs.readdirSync(DC).filter(f=>f.endsWith('.json')));
console.log('restam pedidos:',fs.readdirSync(DP).filter(f=>f.endsWith('.json')));
