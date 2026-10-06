const fs=require('fs');
const cot=fs.readdirSync('data/cotacoes').filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync('data/cotacoes/'+f)));
console.log('COTACOES');
for(const c of cot.sort((a,b)=>a.id-b.id)) console.log(c.id,'|',c.nome,'| teste='+!!c.teste,'|',c.status,'|',c.criadoEm,'|',c.criadoPor,'| forn:',(c.fornecedores||[]).map(f=>f.nome).join(' ; '),'| pedidos:',(c.pedidos||[]).map(p=>p.id).join(','));
console.log('PEDIDOS');
const ped=fs.readdirSync('data/pedidos-fornecedor').filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync('data/pedidos-fornecedor/'+f)));
for(const p of ped.sort((a,b)=>a.id-b.id)) console.log(p.id,'|',p.fornecedor,'| teste='+!!p.teste,'|',p.status,'|',p.criadoEm,'|',p.criadoPor,'| cot:',p.cotacao?p.cotacao.id:'-','| origem:',p.origem?p.origem.tipo+':'+p.origem.pedidoId:'-','| lista:',p.lista_nome);
