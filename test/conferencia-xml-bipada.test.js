// Nota bipada na loja sem XML no ERP (16/10/2026, pedido 169 Estivas Novo Prado): as lojas 3, 4, 5 e 6 biparam a chave da
// DANFE no coletor de manhã, mas o XML não tinha entrado na central.axml (10 das 60 chaves do dia). O Fiscal mostrava
// "Aguardando nota · nenhuma NF-e desse CNPJ". Agora a chave bipada vira x.bipada e a situação "bipada_sem_xml".
const test = require('node:test');
const assert = require('node:assert/strict');
const cx = require('../lib/conferencia-xml');
const fp = require('../lib/fiscal-pedidos');

const CH_L4 = '26261008029696000352550010024788005005610436';   // NF 2478800, loja 4
const CH_L6 = '26261008029696000352550010024788625005613969';   // NF 2478862, loja 6

function pedido(extra = {}) {
  const loja = () => ({ status: 'aguardando', notas: [], itens: [], problemas: [] });
  return { id: 169, status: 'aprovado', codFornec: 387, fornecedor: 'ESTIVAS NOVO PRADO LTDA', lojas: [2, 3, 4, 6],
    aprovadoEm: new Date().toISOString(), criadoEm: new Date().toISOString(),
    xml: { status: 'aguardando', lojas: { 2: loja(), 3: loja(), 4: loja(), 6: loja() } }, ...extra };
}

// "ERP" de mentira: responde por trecho do SQL
function erp(rows) {
  const sqls = [];
  cx.init(async (sql, params) => {
    sqls.push({ sql, params });
    if (/FROM central\.fornecedor/.test(sql)) return [{ CNPJ: '08.029.696/0003-52' }];
    if (/bipada-sem-xml/.test(sql)) return rows;
    return [];
  });
  return sqls;
}

test('chaveNNota: nº da NF-e sai das posições 26-34 da chave', () => {
  assert.equal(cx.chaveNNota(CH_L4), 2478800);
  assert.equal(cx.chaveNNota(CH_L6), 2478862);
  assert.equal(cx.chaveNNota('CH1'), null);
});

test('loja que bipou a chave sem XML vira x.bipada; loja sem nada continua aguardando; situação do Fiscal muda', async () => {
  const sqls = erp([
    { nConferencia: 185421, nLoja: 4, Status: 1, de: '2026-10-16', he: '07:31:12', op: 'JASIANA', Chave: CH_L4, Obs: 'V.31/10 1.728,74' },
    { nConferencia: 185447, nLoja: 6, Status: 5, de: '2026-10-16', he: '08:57:00', op: 'ROSINEIDE', Chave: CH_L6, Obs: '0' }
  ]);
  const p = pedido(); const salvos = [];
  const r = await cx.verificarBipadasSemXml({ listar: () => [p], salvar: q => salvos.push(q.id) });
  assert.deepEqual(r, { pedidos: 1, lojas: 2 });
  assert.deepEqual(salvos, [169]);
  // consulta: só as lojas sem nota, raiz do CNPJ (8 dígitos) e fora da axml
  const q = sqls.find(s => /bipada-sem-xml/.test(s.sql));
  assert.match(q.sql, /a\.nReg IS NULL/);
  assert.deepEqual(q.params.slice(0, 4), [2, 3, 4, 6]);
  assert.equal(q.params[q.params.length - 1], '08029696');
  const b4 = p.xml.lojas[4].bipada;
  assert.equal(b4.chaves.length, 1);
  assert.deepEqual(b4.chaves[0], { chave: CH_L4, nNota: 2478800, nConferencia: 185421, status: 1, em: '2026-10-16 07:31', operador: 'JASIANA', obs: 'V.31/10 1.728,74' });
  assert.equal(p.xml.lojas[6].bipada.chaves[0].obs, null);   // Obs "0" do ERP = vazio
  assert.equal(p.xml.lojas[2].bipada, undefined);
  assert.equal(p.xml.lojas[3].bipada, undefined);

  const hoje = '2026-10-16';
  const s4 = fp.situacaoLoja(p, 4, hoje);
  assert.equal(s4.codigo, 'bipada_sem_xml'); assert.equal(s4.nConferencia, 185421); assert.equal(s4.atraso, 0);
  assert.equal(s4.texto, 'Nota bipada na loja 16/10 07:31');
  assert.equal(s4.sub, 'NF 2478800 · XML ainda não baixado no ERP · conferência 185421 · V.31/10 1.728,74');
  assert.equal(fp.situacaoLoja(p, 2, hoje).codigo, 'aguardando_nota');

  // na aba "Pedidos a receber" (ordem: loja, depois situação): bipada sem XML fica logo depois da nota bipada, antes de
  // "a caminho" e "aguardando"; mesma loja, dois pedidos → o bipado sem XML sobe
  const totais = () => ({ itens: 2, com_preco: 2, digitado: 1178.55, ultimo_custo: 0 });
  const outro = pedido({ id: 170, lojas: [4], xml: { status: 'aguardando', lojas: { 4: { status: 'aguardando', notas: [], itens: [], problemas: [] } } } });
  const lista = fp.pedidosAReceber(() => [outro, p], totais, { hoje });
  assert.deepEqual(lista.map(l => l.loja + ':' + l.pedido + ':' + l.situacao), ['2:169:aguardando_nota', '3:169:aguardando_nota', '4:169:bipada_sem_xml', '4:170:aguardando_nota', '6:169:bipada_sem_xml']);
  assert.equal(lista.find(l => l.pedido === 169 && l.loja === 4).itens_vieram, null);

  // 2ª rodada igual: nada muda, não salva de novo
  salvos.length = 0;
  await cx.verificarBipadasSemXml({ listar: () => [p], salvar: q => salvos.push(q.id) });
  assert.deepEqual(salvos, []);
  assert.equal(p.xml.lojas[4].bipada.chaves.length, 1);
});

test('XML chegou (nota entrou em x.notas): a anotação some e a loja não é mais consultada', async () => {
  erp([{ nConferencia: 185421, nLoja: 4, Status: 1, de: '2026-10-16', he: '07:31:12', op: 'JASIANA', Chave: CH_L4, Obs: '0' }]);
  const p = pedido(); const salvos = [];
  await cx.verificarBipadasSemXml({ listar: () => [p], salvar: () => {} });
  assert.ok(p.xml.lojas[4].bipada);
  p.xml.lojas[4].notas = [{ chave: CH_L4, nNota: 2478800, data: '2026-10-16' }]; p.xml.lojas[4].status = 'consistencia';
  const sqls = erp([]);
  await cx.verificarBipadasSemXml({ listar: () => [p], salvar: q => salvos.push(q.id) });
  assert.equal(p.xml.lojas[4].bipada, undefined);
  assert.deepEqual(salvos, [169]);
  const q = sqls.find(s => /bipada-sem-xml/.test(s.sql));
  assert.deepEqual(q.params.slice(0, 3), [2, 3, 6]);   // loja 4 já tem nota: fora da consulta
});

test('pedido de teste, conciliado ou fora da janela de 30 dias: não consulta o ERP', async () => {
  const sqls = erp([{ nConferencia: 1, nLoja: 4, Status: 1, de: '2026-10-16', he: '07:31:12', op: 'X', Chave: CH_L4, Obs: '0' }]);
  const velho = pedido({ aprovadoEm: '2026-08-01T12:00:00.000Z', criadoEm: '2026-08-01T12:00:00.000Z' });
  const r = await cx.verificarBipadasSemXml({ listar: () => [pedido({ teste: true }), pedido({ xml: { status: 'conciliado', lojas: {} } }), velho], salvar: () => {} });
  assert.deepEqual(r, { pedidos: 0, lojas: 0 });
  assert.equal(sqls.filter(s => /bipada-sem-xml/.test(s.sql)).length, 0);
});
