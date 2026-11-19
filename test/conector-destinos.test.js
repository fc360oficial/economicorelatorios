// Dois Conectores (19/11/26, Tiago: "colocar ele no 252, vamos testar na prática"): o desta máquina (Dlinks de teste) segue com
// pedido de compra, preço e ajuste; a liberação do Televendas vai pro Conector do servidor do ERP quando o sistema é ligado a ele.
const test = require('node:test'); const assert = require('node:assert/strict');
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');

// Conector de mentira: responde saúde, ordens, consulta e desfazer, e guarda o que recebeu
function conectorFalso({ token, producao, versao = '0.8.0', funcoes = true }) {
  const visto = []; let ajusteLigado = true;
  const srv = http.createServer((req, res) => {
    let corpo = ''; req.on('data', d => corpo += d); req.on('end', () => {
      const u = new URL(req.url, 'http://x'), j = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/v1/saude') return j(200, { conector: 'conector-erp', versao, instalacao: producao ? 'erp-producao' : 'central-1', adaptador: producao ? 'dlinks-producao' : 'dlinks-teste', producao: !!producao, erp: { ok: true, detalhe: 'x' }, funcoes: funcoes ? { liberacao_televendas: { nome: 'Liberação do Televendas', ligada: true }, preco_venda: { nome: 'Preço de venda', ligada: !producao }, ajuste_estoque: { nome: 'Ajuste de estoque', ligada: ajusteLigado } } : undefined, ordens: { total: visto.length } });
      if (req.headers.authorization !== 'Bearer ' + token) return j(401, { erro: 'Senha de acesso ausente ou inválida' });
      visto.push({ metodo: req.method, rota: u.pathname + u.search, corpo: corpo ? JSON.parse(corpo) : null });
      if (req.method === 'POST' && u.pathname === '/v1/ordens') { const b = JSON.parse(corpo); return j(201, { id: '20261119-150000-' + (producao ? 'aaaaaa' : 'bbbbbb'), tipo: b.tipo, status: 'executada', adaptador: producao ? 'dlinks-producao' : 'dlinks-teste', resultado: b.tipo === 'liberacao_televendas' ? { pedido: b.dados.pedido, ja_liberado: false, status_anterior: 0, antes: { Status: 0, DataLiberacao: null, HoraLiberacao: null }, depois: { Status: 4, DataLiberacao: '2026-11-19', HoraLiberacao: '15:00' } } : { precos_gravados: 1, antes: [] } }); }
      if (req.method === 'GET' && u.pathname === '/v1/ordens') return j(200, { ordens: [{ id: producao ? 'da-producao' : 'do-teste' }] });
      if (u.pathname === '/v1/consulta/televendas') return j(200, { loja: 10, pedido: +u.searchParams.get('pedido'), existe: true, onde: producao ? 'producao' : 'teste' });
      if (/\/desfazer$/.test(u.pathname)) return j(200, { id: 'x', tipo: 'liberacao_televendas', status: 'desfeita' });
      j(200, { id: 'x', onde: producao ? 'producao' : 'teste' });
    });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, visto, url: 'http://127.0.0.1:' + srv.address().port, token, ajuste: v => { ajusteLigado = v; } })));
}

test('sem o segundo Conector tudo vai no desta máquina; ligado, só o Televendas muda de destino', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conector-dest-'));
  const A = await conectorFalso({ token: 'token-do-conector-desta-maquina-0000000001' }), B = await conectorFalso({ token: 'token-do-conector-do-servidor-do-erp-000002', producao: true });
  process.env.CONECTOR_URL = A.url; process.env.CONECTOR_TOKEN = A.token; process.env.CONECTOR_CHAVE = path.join(dir, 'conector.json'); process.env.CONECTOR_DIR_LOG = path.join(dir, 'log'); delete process.env.CONECTOR_USO;
  delete require.cache[require.resolve('../lib/conector')]; const c = require('../lib/conector');
  try {
    // não ligado: a liberação do Televendas vai no padrão
    assert.equal(await c.estadoProducao(), null);
    let r = await c.liberacaoTelevendas('chave-padrao-tv-0001', 'Nicoly', { loja: 10, pedido: 6616 });
    assert.equal(r.ok, true); assert.equal(r.destino, 'padrao'); assert.equal(A.visto.filter(v => v.metodo === 'POST').length, 1); assert.equal(B.visto.length, 0);
    assert.equal((await c.consultaTelevendas(10, 6616)).onde, 'teste');

    // ligar: endereço torto, senha curta, quem não é Conector, senha errada — nada é gravado
    await assert.rejects(c.setDestinoProducao({ url: 'ftp://x', senha: B.token }, 'Tiago'), /Endereço inválido/);
    await assert.rejects(c.setDestinoProducao({ url: B.url, senha: 'curta' }, 'Tiago'), /Senha de acesso inválida/);
    await assert.rejects(c.setDestinoProducao({ url: 'http://127.0.0.1:19', senha: B.token }, 'Tiago'), /não respondeu/);
    await assert.rejects(c.setDestinoProducao({ url: B.url, senha: 'senha-errada-com-mais-de-trinta-e-dois-caracteres' }, 'Tiago'), /não aceitou a senha/);
    assert.equal(await c.estadoProducao(), null);
    c.setTelevendasAuto(true, 'Tiago'); assert.equal(c.televendasAuto(), true);
    const lig = await c.setDestinoProducao({ url: B.url + '/', senha: B.token }, 'Tiago');
    assert.equal(lig.producao, true); assert.equal(lig.url, B.url); assert.equal(c.televendasAuto(), false, 'trocar o destino desliga a liberação automática');
    const est = await c.estadoProducao(); assert.equal(est.no_ar, true); assert.equal(est.autenticado, true); assert.equal(est.saude.producao, true); assert.equal(est.ligadoPor, 'Tiago');
    assert.ok(!JSON.stringify(est).includes(B.token), 'a senha de acesso nunca volta pra tela');
    assert.equal(JSON.parse(fs.readFileSync(process.env.CONECTOR_CHAVE, 'utf8')).producao.url, B.url);

    // ligado: Televendas → produção; preço → continua no desta máquina
    const antesA = A.visto.length;
    r = await c.liberacaoTelevendas('chave-prod-tv-00001', 'Nicoly', { loja: 10, pedido: 8101 });
    assert.equal(r.ok, true); assert.equal(r.destino, 'producao'); assert.equal(r.ordem, '20261119-150000-aaaaaa');
    assert.equal(B.visto.filter(v => v.metodo === 'POST' && v.rota === '/v1/ordens').length, 1); assert.equal(A.visto.length, antesA, 'nada do Televendas foi pro Conector de teste');
    assert.deepEqual(B.visto.find(v => v.metodo === 'POST').corpo.dados, { loja: 10, pedido: 8101 });
    assert.equal((await c.consultaTelevendas(10, 8101)).onde, 'producao'); assert.equal(await c.suportaTelevendas(), true);
    const p = await c.precoVenda('chave-preco-teste-0001', 'Fulano', { loja: 1, itens: [{ codigo: '789', preco: 1.5 }] });
    assert.equal(p.ok, true); assert.equal(p.destino, 'padrao'); assert.equal(A.visto.filter(v => v.metodo === 'POST' && v.corpo.tipo === 'preco_venda').length, 1);
    assert.ok(!B.visto.some(v => v.corpo && v.corpo.tipo === 'preco_venda'), 'preço nunca vai pro Conector do servidor do ERP');
    // AJUSTE DE ESTOQUE (negativos): só vai pra produção com a chave ligada; ligar exige a função ligada no Conector de produção
    const aj = chave => c.ajusteEstoque(chave, 'Tiago', { loja: 3, cod_motivo: 37, itens: [{ codigo: '111', qtd: 5 }] });
    assert.equal(c.ajusteProducao(), false); assert.deepEqual(c.ondeGrava('ajuste_estoque'), { nome: 'padrao', remoto: false }); assert.deepEqual(c.ondeGrava('liberacao_televendas'), { nome: 'producao', remoto: true });
    let a = await aj('chave-ajuste-teste-0001'); assert.equal(a.destino, 'padrao'); assert.ok(!B.visto.some(v => v.corpo && v.corpo.tipo === 'ajuste_estoque'), 'chave desligada: o ajuste continua no Conector de teste');
    B.ajuste(false); await assert.rejects(c.setAjusteProducao(true, 'Tiago'), /DESLIGADO no Conector de produção/); assert.equal(c.ajusteProducao(), false);
    B.ajuste(true); await c.setAjusteProducao(true, 'Tiago'); assert.equal(c.ajusteProducao(), true); assert.equal(c.ondeGrava('ajuste_estoque').remoto, true); assert.equal(await c.suportaAjusteEstoque(), true);
    const nA = A.visto.length; a = await aj('chave-ajuste-prod-00001'); assert.equal(a.ok, true); assert.equal(a.destino, 'producao'); assert.equal(A.visto.length, nA, 'com a chave ligada o ajuste NÃO vai pro Conector de teste');
    assert.deepEqual(B.visto.find(v => v.corpo && v.corpo.tipo === 'ajuste_estoque').corpo.dados.itens, [{ codigo: '111', qtd: 5 }]);
    assert.equal(c.ondeGrava('preco_venda').remoto, false); assert.equal(c.ondeGrava('pedido_compra').remoto, false);
    await c.setAjusteProducao(false, 'Tiago'); assert.equal(c.ondeGrava('ajuste_estoque').remoto, false); await c.setAjusteProducao(true, 'Tiago');
    // listas e desfazer por destino
    assert.equal((await c.ordens(10)).ordens[0].id, 'do-teste'); assert.equal((await c.ordens(10, 'producao')).ordens[0].id, 'da-producao');
    assert.equal((await c.ordem('20261119-150000-aaaaaa', 'producao')).onde, 'producao'); assert.equal((await c.ordem('20261119-150000-bbbbbb')).onde, 'teste');
    await c.desfazer('20261119-150000-aaaaaa', 'Nicoly', 'producao'); assert.ok(B.visto.some(v => /\/desfazer$/.test(v.rota) && v.corpo.por === 'Nicoly'));
    // o Log de Processos registra de onde foi
    const logs = fs.readdirSync(process.env.CONECTOR_DIR_LOG, { recursive: true }).filter(f => /\.jsonl?$/.test(String(f))).map(f => fs.readFileSync(path.join(process.env.CONECTOR_DIR_LOG, String(f)), 'utf8')).join('\n');
    assert.match(logs, /Conector do servidor do ERP/); assert.match(logs, /"destino":"producao"/);

    // Conector do Televendas fora do ar: a liberação falha com o motivo e NÃO cai no de teste
    await new Promise(ok => B.srv.close(ok)); if (B.srv.closeAllConnections) B.srv.closeAllConnections();
    const antes = A.visto.length; r = await c.liberacaoTelevendas('chave-prod-tv-00002', 'Nicoly', { loja: 10, pedido: 8102 });
    assert.equal(r.ok, false); assert.match(r.erro, /não respondeu/); assert.equal(A.visto.length, antes, 'não tenta o outro Conector por conta própria');
    assert.equal((await c.estadoProducao()).no_ar, false);
    // ajuste com a chave em produção e o Conector de produção fora: falha com o motivo, NÃO cai no de teste, e não dá pra religar a chave
    const nA2 = A.visto.length; a = await aj('chave-ajuste-prod-00002'); assert.equal(a.ok, false); assert.match(a.erro, /não respondeu/); assert.equal(A.visto.length, nA2);
    assert.equal(await c.suportaAjusteEstoque(), false, 'a aprovação dos negativos vê que o Conector de produção não aguenta e devolve erro');
    await assert.rejects(c.setAjusteProducao(true, 'Tiago'), /não respondeu/);

    // desligar: volta pro padrão e a automática continua desligada
    c.setTelevendasAuto(true, 'Tiago'); assert.equal(c.ajusteProducao(), true); c.removerDestinoProducao('Tiago'); assert.equal(await c.estadoProducao(), null); assert.equal(c.televendasAuto(), false); assert.equal(c.ajusteProducao(), false, 'desligar o destino desliga o ajuste em produção');
    await assert.rejects(c.setAjusteProducao(true, 'Tiago'), /ainda não está ligado/); assert.equal((await aj('chave-ajuste-teste-0002')).destino, 'padrao');
    r = await c.liberacaoTelevendas('chave-padrao-tv-0002', 'Nicoly', { loja: 10, pedido: 6617 }); assert.equal(r.destino, 'padrao'); assert.equal(r.ok, true);
  } finally { A.srv.close(); try { B.srv.close(); } catch (e) {} delete process.env.CONECTOR_URL; delete process.env.CONECTOR_TOKEN; delete process.env.CONECTOR_CHAVE; delete process.env.CONECTOR_DIR_LOG; delete require.cache[require.resolve('../lib/conector')]; }
});
