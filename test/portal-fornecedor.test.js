const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Portal do Fornecedor: login com WhatsApp + PIN de 6 números (Tiago, 13/10/2026: "vai ser número e PIN" — fornecedor com 3
// vendedores e 1 e-mail não casava com login por e-mail). Dados num diretório temporário; sem web-push.
process.env.PORTAL_FORNECEDOR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-forn-'));
const portal = require('../lib/portal-fornecedor');

const TOKEN_ANA = 'a'.repeat(32), TOKEN_SEM = 'b'.repeat(32), TOKEN_PED = 'c'.repeat(32);
const cot = {
  id: 7, nome: 'Bebidas', status: 'aberta', prazo: null, criadoEm: '2026-10-13T10:00:00.000Z', itens: [{ cod: 1 }, { cod: 2 }],
  fornecedores: [
    { codFornec: 1234, codFornecErp: 1234, nome: 'SOMAR · Ana', empresa: 'SOMAR', token: TOKEN_ANA, status: 'aguardando', precos: {}, vendedor: { nome: 'Ana Lima', whats: '81911111111', email: 'ana@somar.com.br' }, vendedores: [] },
    { codFornec: 555, codFornecErp: 555, nome: 'DISLUB', token: TOKEN_SEM, status: 'aguardando', precos: {}, vendedor: { nome: 'Vendas', whats: null, email: 'vendas@dislub.com.br' }, vendedores: [] }
  ]
};
const ped = { id: 90, token: TOKEN_PED, status: 'aguardando', codFornec: 1234, fornecedor: 'SOMAR', lista_nome: 'Bebidas', vendedor: { nome: 'Ana Lima', whats: '81911111111' }, itens: [] };
const deps = {
  log: () => {},
  cotacao: { porToken: t => t === TOKEN_ANA ? { c: cot, f: cot.fornecedores[0] } : t === TOKEN_SEM ? { c: cot, f: cot.fornecedores[1] } : null, listar: () => [cot], obter: id => id === 7 ? cot : null, normPrazo: () => null, prazoVencido: () => false, comparativo: () => ({ fornecedores: [] }) },
  pedidosFornec: { porToken: t => t === TOKEN_PED ? ped : null, listar: () => [ped], obter: id => id === 90 ? ped : null },
  lerCotForn: () => ({})
};
portal.init(deps);

test('criar conta: valida nome, WhatsApp, PIN de 6 números e e-mail obrigatório', () => {
  assert.equal(portal.criarConta({ nome: 'Ana Lima', whats: '81911111111', pin: '123456' }).erro, 'Informe um e-mail válido');
  assert.equal(portal.criarConta({ nome: 'A', whats: '81911111111', email: 'a@b.co', pin: '123456' }).erro, 'Informe seu nome');
  assert.match(portal.criarConta({ nome: 'Ana Lima', whats: '12', email: 'a@b.co', pin: '123456' }).erro, /WhatsApp inválido/);
  assert.equal(portal.criarConta({ nome: 'Ana Lima', whats: '81911111111', email: 'a@b.co', pin: '12345' }).erro, 'O PIN tem 6 números');
  assert.equal(portal.criarConta({ nome: 'Ana Lima', whats: '81911111111', email: 'a@b.co', pin: '12345a' }).erro, 'O PIN tem 6 números');
  assert.equal(portal.criarConta({ nome: 'Ana Lima', whats: '81911111111', email: 'a@b.co', pin: '1234567' }).erro, 'O PIN tem 6 números');
  assert.equal(portal.criarConta({ nome: 'Ana Lima', whats: '81911111111', email: 'ana-somar', pin: '123456' }).erro, 'Informe um e-mail válido');
});

test('criar conta pelo link da cotação: guarda hash + PIN em claro, liga a empresa e devolve a sessão (vt)', () => {
  const r = portal.criarConta({ nome: 'Ana Lima', whats: '(81) 9 1111-1111', email: ' Ana@Somar.com.br ', pin: ' 482913 ', de: { tipo: 'cotacao', token: TOKEN_ANA }, ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile' });
  assert.equal(r.erro, undefined);
  assert.match(r.vt, /^[a-f0-9]{32}$/);
  assert.equal(r.vendedor.whats, '81911111111', 'WhatsApp normalizado é o login');
  assert.equal(r.vendedor.email, 'ana@somar.com.br', 'e-mail normalizado (minúsculo, sem espaço)');
  assert.equal(r.vendedor.tem_pin, true);
  assert.deepEqual(r.vendedor.empresas, [{ codFornec: 1234, nome: 'SOMAR' }]);
  const disco = JSON.parse(fs.readFileSync(path.join(portal.DIR, 'vendedores.json'), 'utf8'));
  assert.ok(disco['81911111111'].senha.startsWith('scrypt$'), 'PIN gravado como hash');
  assert.equal(disco['81911111111'].pin_claro, '482913', 'PIN em claro guardado junto do hash, só pra tela administrativa (Tiago, 15/10)');
  assert.equal(portal.vendedorPorToken(r.vt).id, '81911111111');
});

test('WhatsApp já com login não cria de novo; e-mail da empresa pode repetir entre vendedores', () => {
  assert.match(portal.criarConta({ nome: 'Ana de Novo', whats: '81911111111', email: 'x@y.co', pin: '654321' }).erro, /WhatsApp já tem login no portal/);
  const r = portal.criarConta({ nome: 'Outra Pessoa', whats: '81922222222', email: 'ana@somar.com.br', pin: '654321' });
  assert.equal(r.erro, undefined); assert.equal(r.vendedor.email, 'ana@somar.com.br', 'mesmo e-mail da Ana, outro WhatsApp');
});

test('entrar: WhatsApp + PIN certos devolvem o mesmo vt; errados não; 8 erros travam por 10 min; admin redefine e destrava', () => {
  const ok = portal.entrar({ whats: '81 9 1111-1111', pin: '482913' });
  assert.equal(ok.erro, undefined); assert.equal(ok.vendedor.id, '81911111111');
  assert.equal(ok.vt, portal.vendedorPorToken(ok.vt).token);
  assert.equal(portal.entrar({ whats: '81911111111', pin: '482914' }).erro, 'WhatsApp ou PIN não conferem');
  assert.equal(portal.entrar({ whats: '81900000099', pin: '482913' }).erro, 'WhatsApp ou PIN não conferem');
  assert.equal(portal.entrar({ whats: '81911111111', pin: '' }).erro, 'Informe o PIN');
  assert.match(portal.entrar({ whats: '12', pin: '482913' }).erro, /Informe seu WhatsApp/);
  for (let i = 0; i < portal.TENT_MAX; i++) portal.entrar({ whats: '81911111111', pin: '00000' + i });
  const bloq = portal.entrar({ whats: '81911111111', pin: '482913' });
  assert.equal(bloq.bloqueado, true, 'até o PIN certo é recusado enquanto está travado');
  assert.equal(portal.definirPin('81911111111', { pin: '12345' }).erro, 'O PIN tem 6 números');
  assert.equal(portal.definirPin('81911111111', { pin: '999999' }).ok, true);
  assert.equal(portal.entrar({ whats: '81911111111', pin: '482913' }).erro, 'WhatsApp ou PIN não conferem', 'PIN antigo não vale mais');
  assert.equal(portal.entrar({ whats: '81911111111', pin: '999999' }).erro, undefined);
  assert.equal(portal.definirPin('nao-existe', { pin: '123456' }).erro, 'Vendedor não encontrado');
});

test('trocar PIN: exige o atual; o novo tem 6 números', () => {
  const vt = portal.entrar({ whats: '81911111111', pin: '999999' }).vt;
  assert.equal(portal.trocarPin(vt, { pin_atual: '111111', pin_novo: '222222' }).erro, 'PIN atual não confere');
  assert.equal(portal.trocarPin(vt, { pin_atual: '999999', pin_novo: '22' }).erro, 'O PIN tem 6 números');
  assert.equal(portal.trocarPin('f'.repeat(32), { pin_atual: '999999', pin_novo: '222222' }).erro, 'Sessão inválida');
  assert.equal(portal.trocarPin(vt, { pin_atual: '999999', pin_novo: '222222' }).ok, true);
  assert.equal(portal.entrar({ whats: '81911111111', pin: '222222' }).erro, undefined);
  // PIN em claro só na lista administrativa (Tiago, 15/10: "mostra a senha que o vendedor fez"); o resumo público não leva
  assert.equal(portal.listarVendedores().find(v => v.id === '81911111111').pin, '222222');
  assert.equal(portal.resumoVendedor(vt).vendedor.pin, undefined);
});

test('vendedor de antes do login (entrou pelo "Sou eu", sem PIN): não entra; cria o PIN pelo vt; criar conta com o mesmo WhatsApp aproveita o registro', () => {
  const arq = path.join(portal.DIR, 'vendedores.json');
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  disco['81933333333'] = { id: '81933333333', nome: 'Bruno Antigo', whats: '81933333333', email: 'bruno@dia.com.br', token: 'd'.repeat(32), empresas: [], dispositivos: [], criadoEm: '2026-10-13T09:00:00.000Z' };
  disco['81955555555'] = { id: '81955555555', nome: 'Clara', whats: '81955555555', email: null, token: 'f'.repeat(32), empresas: [{ codFornec: 9, nome: 'X' }], dispositivos: [{ endpoint: 'https://p/1', keys: { p256dh: 'a', auth: 'b' } }], criadoEm: '2026-10-13T09:00:00.000Z' };
  fs.writeFileSync(arq, JSON.stringify(disco));
  portal.init(deps);
  assert.equal(portal.entrar({ whats: '81933333333', pin: '123456' }).erro, 'WhatsApp ou PIN não conferem');
  const eu = portal.resumoVendedor('d'.repeat(32));
  assert.equal(eu.vendedor.tem_pin, false, 'o portal vê que falta PIN e pede pra criar');
  assert.equal(portal.trocarPin('d'.repeat(32), { pin_novo: '123456', email: 'x' }).erro, 'Informe um e-mail válido');
  assert.equal(portal.trocarPin('d'.repeat(32), { pin_novo: '123456' }).ok, true, 'sem PIN ainda, não pede o atual; e-mail que já tinha vale');
  assert.equal(portal.entrar({ whats: '81933333333', pin: '123456' }).vendedor.id, '81933333333');
  const r = portal.criarConta({ nome: 'Clara Souza', whats: '81955555555', email: 'clara@x.co', pin: '123456' });
  assert.equal(r.erro, undefined); assert.equal(r.vt, 'f'.repeat(32), 'mantém a sessão/aparelhos de antes'); assert.equal(r.vendedor.dispositivos, 1); assert.equal(r.vendedor.nome, 'Clara Souza');
});

test('casamento: WhatsApp manda; sem WhatsApp vale o e-mail; sem os dois vale a empresa', () => {
  const ana = portal.vendedorPorToken(portal.entrar({ whats: '81911111111', pin: '222222' }).vt);
  assert.equal(portal.fornecedorEhDoVendedor(cot.fornecedores[0], ana), true, 'pelo WhatsApp');
  assert.equal(portal.fornecedorEhDoVendedor(cot.fornecedores[1], ana), false, 'DISLUB não tem WhatsApp e o e-mail é outro');
  const r = portal.criarConta({ nome: 'Vendas Dislub', whats: '81966666666', email: 'vendas@dislub.com.br', pin: '123456' });
  const dislub = portal.vendedorPorToken(r.vt);
  assert.equal(portal.fornecedorEhDoVendedor(cot.fornecedores[1], dislub), true, 'pelo e-mail, já que o fornecedor não tem WhatsApp');
  assert.equal(portal.fornecedorEhDoVendedor({ codFornecErp: 1234, vendedor: { nome: 'Ana Lima', whats: '81911111111', email: 'vendas@dislub.com.br' } }, dislub), false, 'com WhatsApp cadastrado o e-mail não desempata');
  assert.equal(portal.fornecedorEhDoVendedor({ codFornecErp: 1234, vendedor: null, vendedores: [] }, ana), true, 'pela empresa ligada ao criar a conta');
  assert.equal(portal.pedidoEhDoVendedor(ped, ana), true);
  assert.equal(portal.pedidoEhDoVendedor({ codFornec: 555, vendedor: { email: 'VENDAS@dislub.com.br' } }, dislub), true);
  assert.equal(portal.pedidoEhDoVendedor({ codFornec: 555, vendedor: { whats: '81900000009' } }, dislub), false);
});

test('convite do link traz WhatsApp e e-mail inteiros (pré-preenche o cadastro) e diz se já tem PIN', () => {
  const c = portal.convite('cotacao', TOKEN_ANA);
  assert.equal(c.fornecedor, 'SOMAR'); assert.equal(c.id, 7); assert.equal(c.exige_login, true);
  assert.deepEqual(c.vendedores, [{ idx: 0, nome: 'Ana Lima', whats: '81911111111', email: 'ana@somar.com.br', ja_no_portal: true, tem_pin: true }]);
  assert.equal(portal.convite('cotacao', 'z'.repeat(32)), null);
  assert.equal(portal.convite('pedido', TOKEN_PED).vendedores[0].ja_no_portal, true);
});

test('resumo do vendedor logado traz login e cotação aberta; estado() conta quem tem PIN', () => {
  const vt = portal.entrar({ whats: '81911111111', pin: '222222', de: { tipo: 'pedido', token: TOKEN_PED } }).vt;
  const eu = portal.resumoVendedor(vt);
  assert.equal(eu.vendedor.whats, '81911111111'); assert.equal(eu.vendedor.tem_pin, true);
  assert.equal(eu.cotacoes_abertas.length, 1); assert.equal(eu.cotacoes_abertas[0].link, '/fornecedor/cotacao/' + TOKEN_ANA);
  assert.equal(eu.pedidos_pendentes.length, 1);
  assert.equal(portal.resumoVendedor('0'.repeat(32)), null);
  assert.equal(portal.estado().comLogin, 5, 'estado() conta os reais com PIN (Ana, Outra, Bruno, Clara, Dislub)');
});

test('fora do portal: vendedores das listas e cotações sem login, com empresa, lista e última cotação; quem tem PIN fica de fora', () => {
  const d2 = { ...deps, lerCotForn: () => ({ 277: [{ codFornec: 1234, nome: 'SOMAR', vendedor: { nome: 'Ana Lima', whats: '81911111111', email: 'ana@somar.com.br' }, vendedores: [{ nome: 'Novo Vendedor', whats: '81 97777-6666', email: '' }] }] }) };
  portal.init(d2);
  const f = portal.foraDoPortal();
  assert.ok(!f.some(x => x.whats === '81911111111'), 'Ana tem PIN: não aparece');
  const novo = f.find(x => x.whats === '81977776666');
  assert.ok(novo, 'vendedor da lista sem login aparece'); assert.equal(novo.nome, 'Novo Vendedor'); assert.deepEqual(novo.empresas, ['SOMAR']); assert.deepEqual(novo.listas, [277]); assert.equal(novo.sem_pin, false);
  portal.init(deps);
});

test('login obrigatório pra responder cotação: ligado por padrão, convite e canais avisam, admin desliga e liga (persistido)', () => {
  assert.equal(portal.exigeLogin(), true);
  assert.equal(portal.resumoCanais(cot).exigeLogin, true);
  assert.deepEqual(portal.setConfig({ exigeLogin: false }), { exigeLogin: false });
  assert.equal(portal.exigeLogin(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(portal.DIR, 'config.json'), 'utf8')).exigeLogin, false);
  portal.init(deps); assert.equal(portal.exigeLogin(), false, 'vale depois de reiniciar');
  assert.equal(portal.setConfig({ exigeLogin: 1 }).exigeLogin, true);
  assert.equal(portal.estado().exigeLogin, true);
});

test('registro de teste que sobrou no disco (vendedor TESTE de antes) é apagado ao subir', () => {
  const arq = path.join(portal.DIR, 'vendedores.json');
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  disco['81900000001'] = { id: '81900000001', nome: 'TESTE Carlos Menezes', whats: '81900000001', teste: true, token: 'e'.repeat(32), empresas: [], dispositivos: [] };
  fs.writeFileSync(arq, JSON.stringify(disco));
  portal.init(deps);
  assert.equal(portal.entrar({ whats: '81900000001', pin: '123456' }).erro, 'WhatsApp ou PIN não conferem');
  assert.equal(Object.values(JSON.parse(fs.readFileSync(arq, 'utf8'))).filter(v => v.teste).length, 0);
  assert.equal(portal.estado().vendedores, 5);
});
