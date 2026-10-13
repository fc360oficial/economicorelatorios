const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Portal do Fornecedor: login com e-mail + senha (Tiago, 13/10/2026: "quero que o vendedor receba esse link e crie um
// login e senha com e-mail e senha de no mínimo 6 dígitos"). Dados num diretório temporário; sem web-push.
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

test('criar conta: valida nome, WhatsApp, e-mail e senha de no mínimo 6 dígitos', () => {
  assert.equal(portal.criarConta({ nome: 'A', whats: '81911111111', email: 'ana@somar.com.br', senha: '123456' }).erro, 'Informe seu nome');
  assert.match(portal.criarConta({ nome: 'Ana Lima', whats: '12', email: 'ana@somar.com.br', senha: '123456' }).erro, /WhatsApp inválido/);
  assert.equal(portal.criarConta({ nome: 'Ana Lima', whats: '81911111111', email: 'ana-somar', senha: '123456' }).erro, 'E-mail inválido');
  assert.match(portal.criarConta({ nome: 'Ana Lima', whats: '81911111111', email: 'ana@somar.com.br', senha: '12345' }).erro, /no mínimo 6 dígitos/);
  assert.match(portal.criarConta({ nome: 'Ana Lima', whats: '81911111111', email: 'ana@somar.com.br', senha: 'x'.repeat(65) }).erro, /longa demais/);
});

test('criar conta pelo link da cotação: guarda hash (nunca a senha), liga a empresa e devolve a sessão (vt)', () => {
  const r = portal.criarConta({ nome: 'Ana Lima', whats: '(81) 9 1111-1111', email: 'Ana@Somar.com.br ', senha: '123456', de: { tipo: 'cotacao', token: TOKEN_ANA }, ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile' });
  assert.equal(r.erro, undefined);
  assert.match(r.vt, /^[a-f0-9]{32}$/);
  assert.equal(r.vendedor.email, 'ana@somar.com.br', 'e-mail normalizado (minúsculo, sem espaço)');
  assert.equal(r.vendedor.whats, '81911111111');
  assert.equal(r.vendedor.tem_senha, true);
  assert.deepEqual(r.vendedor.empresas, [{ codFornec: 1234, nome: 'SOMAR' }]);
  const disco = JSON.parse(fs.readFileSync(path.join(portal.DIR, 'vendedores.json'), 'utf8'));
  assert.ok(disco['81911111111'].senha.startsWith('scrypt$'), 'senha gravada como hash');
  assert.ok(!JSON.stringify(disco).includes('123456'), 'senha em texto não vai pro disco');
  assert.equal(portal.vendedorPorToken(r.vt).id, '81911111111');
});

test('e-mail ou WhatsApp já com login não cria de novo', () => {
  assert.match(portal.criarConta({ nome: 'Outra Pessoa', whats: '81922222222', email: 'ana@somar.com.br', senha: '654321' }).erro, /e-mail já tem login/);
  assert.match(portal.criarConta({ nome: 'Ana de Novo', whats: '81911111111', email: 'ana2@somar.com.br', senha: '654321' }).erro, /WhatsApp já tem login no portal \(an•••@somar\.com\.br\)/);
});

test('entrar: e-mail + senha certos devolvem o mesmo vt; errados não; 8 erros travam por 10 min', () => {
  const ok = portal.entrar({ email: 'ANA@somar.com.br', senha: '123456' });
  assert.equal(ok.erro, undefined); assert.equal(ok.vendedor.id, '81911111111');
  assert.equal(ok.vt, portal.vendedorPorToken(ok.vt).token);
  assert.equal(portal.entrar({ email: 'ana@somar.com.br', senha: '123457' }).erro, 'E-mail ou senha não conferem');
  assert.equal(portal.entrar({ email: 'ninguem@x.com.br', senha: '123456' }).erro, 'E-mail ou senha não conferem');
  assert.equal(portal.entrar({ email: 'ana@somar.com.br', senha: '' }).erro, 'Informe a senha');
  assert.equal(portal.entrar({ email: 'nao-e-email', senha: '123456' }).erro, 'Informe o e-mail do seu login');
  for (let i = 0; i < portal.TENT_MAX; i++) portal.entrar({ email: 'ana@somar.com.br', senha: 'errada' + i });
  const bloq = portal.entrar({ email: 'ana@somar.com.br', senha: '123456' });
  assert.equal(bloq.bloqueado, true, 'até a senha certa é recusada enquanto está travado');
  // comprador(a) redefine a senha → destrava
  const r = portal.definirSenha('81911111111', { senha: '999999' });
  assert.equal(r.ok, true);
  assert.equal(portal.entrar({ email: 'ana@somar.com.br', senha: '123456' }).erro, 'E-mail ou senha não conferem', 'senha antiga não vale mais');
  assert.equal(portal.entrar({ email: 'ana@somar.com.br', senha: '999999' }).erro, undefined);
});

test('trocar senha: exige a atual; a nova precisa de 6 dígitos', () => {
  const vt = portal.entrar({ email: 'ana@somar.com.br', senha: '999999' }).vt;
  assert.equal(portal.trocarSenha(vt, { senha_atual: 'errada', senha_nova: '111111' }).erro, 'Senha atual não confere');
  assert.match(portal.trocarSenha(vt, { senha_atual: '999999', senha_nova: '111' }).erro, /no mínimo 6/);
  assert.equal(portal.trocarSenha('f'.repeat(32), { senha_atual: '999999', senha_nova: '111111' }).erro, 'Sessão inválida');
  assert.equal(portal.trocarSenha(vt, { senha_atual: '999999', senha_nova: '111111' }).ok, true);
  assert.equal(portal.entrar({ email: 'ana@somar.com.br', senha: '111111' }).erro, undefined);
});

test('vendedor de antes do login (entrou pelo "Sou eu", sem senha): não entra por e-mail; cria a senha pelo vt; admin pode definir e-mail + senha', () => {
  // simula o registro antigo direto no disco
  const arq = path.join(portal.DIR, 'vendedores.json');
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  disco['81933333333'] = { id: '81933333333', nome: 'Bruno Antigo', whats: '81933333333', email: 'bruno@dia.com.br', token: 'd'.repeat(32), empresas: [], dispositivos: [], criadoEm: '2026-10-13T09:00:00.000Z' };
  fs.writeFileSync(arq, JSON.stringify(disco));
  portal.init(deps);
  assert.equal(portal.entrar({ email: 'bruno@dia.com.br', senha: '123456' }).erro, 'E-mail ou senha não conferem');
  const eu = portal.resumoVendedor('d'.repeat(32));
  assert.equal(eu.vendedor.tem_senha, false, 'o portal vê que falta senha e pede pra criar');
  assert.equal(portal.trocarSenha('d'.repeat(32), { senha_nova: '123456', email: 'ana@somar.com.br' }).erro, 'Este e-mail já tem login no portal');
  assert.equal(portal.trocarSenha('d'.repeat(32), { senha_nova: '123456', email: 'bruno.novo@dia.com.br' }).ok, true);
  assert.equal(portal.entrar({ email: 'bruno.novo@dia.com.br', senha: '123456' }).vendedor.id, '81933333333');
  // outro antigo sem e-mail: a tela administrativa precisa informar o e-mail junto
  const d2 = JSON.parse(fs.readFileSync(arq, 'utf8'));
  d2['81944444444'] = { id: '81944444444', nome: 'Sem Email', whats: '81944444444', email: null, token: 'e'.repeat(32), empresas: [], dispositivos: [], criadoEm: '2026-10-13T09:00:00.000Z' };
  fs.writeFileSync(arq, JSON.stringify(d2)); portal.init(deps);
  assert.match(portal.definirSenha('81944444444', { senha: '123456' }).erro, /não tem e-mail/);
  assert.equal(portal.definirSenha('81944444444', { senha: '123456', email: 'bruno.novo@dia.com.br' }).erro, 'Este e-mail já é o login de Bruno Antigo');
  assert.equal(portal.definirSenha('81944444444', { senha: '123456', email: 'sem@email.com.br' }).ok, true);
  assert.equal(portal.definirSenha('nao-existe', { senha: '123456' }).erro, 'Vendedor não encontrado');
  // "Sou eu" antigo + criar conta com o mesmo WhatsApp: aproveita o registro (aparelhos, empresas) em vez de recusar
  const d3 = JSON.parse(fs.readFileSync(arq, 'utf8'));
  d3['81955555555'] = { id: '81955555555', nome: 'Clara', whats: '81955555555', email: null, token: 'f'.repeat(32), empresas: [{ codFornec: 9, nome: 'X' }], dispositivos: [{ endpoint: 'https://p/1', keys: { p256dh: 'a', auth: 'b' } }], criadoEm: '2026-10-13T09:00:00.000Z' };
  fs.writeFileSync(arq, JSON.stringify(d3)); portal.init(deps);
  const r = portal.criarConta({ nome: 'Clara Souza', whats: '81955555555', email: 'clara@x.com.br', senha: '123456' });
  assert.equal(r.erro, undefined); assert.equal(r.vt, 'f'.repeat(32), 'mantém a sessão/aparelhos de antes'); assert.equal(r.vendedor.dispositivos, 1); assert.equal(r.vendedor.nome, 'Clara Souza');
});

test('casamento: WhatsApp manda; sem WhatsApp vale o e-mail; sem os dois vale a empresa', () => {
  const ana = portal.vendedorPorEmail('ana@somar.com.br');
  assert.equal(portal.fornecedorEhDoVendedor(cot.fornecedores[0], ana), true, 'pelo WhatsApp');
  assert.equal(portal.fornecedorEhDoVendedor(cot.fornecedores[1], ana), false, 'DISLUB não tem WhatsApp e o e-mail é outro');
  const r = portal.criarConta({ nome: 'Vendas Dislub', whats: '81966666666', email: 'vendas@dislub.com.br', senha: '123456' });
  const dislub = portal.vendedorPorToken(r.vt);
  assert.equal(portal.fornecedorEhDoVendedor(cot.fornecedores[1], dislub), true, 'pelo e-mail, já que o fornecedor não tem WhatsApp');
  assert.equal(portal.fornecedorEhDoVendedor({ codFornecErp: 1234, vendedor: { nome: 'Ana Lima', whats: '81911111111', email: 'vendas@dislub.com.br' } }, dislub), false, 'com WhatsApp cadastrado o e-mail não desempata');
  assert.equal(portal.fornecedorEhDoVendedor({ codFornecErp: 1234, vendedor: null, vendedores: [] }, ana), true, 'pela empresa ligada ao criar a conta');
  assert.equal(portal.pedidoEhDoVendedor(ped, ana), true);
  assert.equal(portal.pedidoEhDoVendedor({ codFornec: 555, vendedor: { email: 'VENDAS@dislub.com.br' } }, dislub), true);
  assert.equal(portal.pedidoEhDoVendedor({ codFornec: 555, vendedor: { whats: '81900000009' } }, dislub), false);
});

test('convite do link traz WhatsApp e e-mail inteiros (pré-preenche o cadastro) e diz se já tem login', () => {
  const c = portal.convite('cotacao', TOKEN_ANA);
  assert.equal(c.fornecedor, 'SOMAR'); assert.equal(c.id, 7);
  assert.deepEqual(c.vendedores, [{ idx: 0, nome: 'Ana Lima', whats: '81911111111', email: 'ana@somar.com.br', ja_no_portal: true, tem_senha: true, login: 'an•••@somar.com.br' }]);
  assert.equal(portal.convite('cotacao', 'z'.repeat(32)), null);
  assert.equal(portal.convite('pedido', TOKEN_PED).vendedores[0].ja_no_portal, true);
});

test('resumo do vendedor logado traz login e cotação aberta; exemplos de teste entram com senha 123456', () => {
  const vt = portal.entrar({ email: 'ana@somar.com.br', senha: '111111', de: { tipo: 'pedido', token: TOKEN_PED } }).vt;
  const eu = portal.resumoVendedor(vt);
  assert.equal(eu.vendedor.email, 'ana@somar.com.br'); assert.equal(eu.vendedor.tem_senha, true);
  assert.equal(eu.cotacoes_abertas.length, 1); assert.equal(eu.cotacoes_abertas[0].link, '/fornecedor/cotacao/' + TOKEN_ANA);
  assert.equal(eu.pedidos_pendentes.length, 1);
  assert.equal(portal.resumoVendedor('0'.repeat(32)), null);
  portal.criarTestes();
  assert.equal(portal.entrar({ email: 'carlos@teste.com.br', senha: portal.TESTE_SENHA }).vendedor.teste, true);
  assert.equal(portal.estado().comLogin, 5, 'estado() conta só os reais com senha (Ana, Bruno, Sem Email, Clara, Dislub), não os de teste');
});

test('login obrigatório pra responder cotação: ligado por padrão, convite e canais avisam, admin desliga e liga (persistido)', () => {
  assert.equal(portal.exigeLogin(), true);
  assert.equal(portal.convite('cotacao', TOKEN_ANA).exige_login, true);
  assert.equal(portal.resumoCanais(cot).exigeLogin, true);
  assert.deepEqual(portal.setConfig({ exigeLogin: false }), { exigeLogin: false });
  assert.equal(portal.exigeLogin(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(portal.DIR, 'config.json'), 'utf8')).exigeLogin, false);
  portal.init(deps); assert.equal(portal.exigeLogin(), false, 'vale depois de reiniciar');
  assert.equal(portal.setConfig({ exigeLogin: 1 }).exigeLogin, true);
  assert.equal(portal.estado().exigeLogin, true);
});
