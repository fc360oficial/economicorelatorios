// Cliente do Conector (projeto conector-erp, instalado no servidor em 13/11/2026): a ponte por onde as gravações no Dlinks
// vão passar (pedido de compra e preço de venda), no lugar de gravar direto no banco. Por enquanto só consulta a situação;
// o robô continua gravando por escreverERP até o Tiago mandar trocar.
// A senha do robô fica no config do próprio Conector (pasta protegida do Windows) ou em CONECTOR_TOKEN; nunca no repositório.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./log-erp');
const DIR_LOG = process.env.CONECTOR_DIR_LOG || path.join(__dirname, '..', 'data', 'log-erp');   // o mesmo Log de Processos › Log (CONECTOR_DIR_LOG: só nos testes)

const URL_BASE = (process.env.CONECTOR_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const CONFIG = process.env.CONECTOR_CONFIG || 'C:\\ProgramData\\Conector\\config.json';

function token() {
  if (process.env.CONECTOR_TOKEN) return { token: process.env.CONECTOR_TOKEN, origem: 'variável de ambiente' };
  try { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); const t = (c.tokens || [])[0]; if (t && t.token) return { token: t.token, origem: 'config do Conector' }; return { token: null, motivo: 'config do Conector sem senha' }; }
  catch (e) { return { token: null, motivo: e.code === 'EPERM' || e.code === 'EACCES' ? 'sem permissão pra ler o config do Conector' : e.code === 'ENOENT' ? 'Conector não instalado neste servidor' : e.message }; }
}

// ── DOIS DESTINOS (19/11/26, Tiago: "colocar ele no 252, vamos testar na prática") ──
//  · PADRÃO: o Conector desta máquina, que grava no Dlinks de TESTE (pedido de compra, preço, ajuste de estoque).
//  · TELEVENDAS: opcional, um segundo Conector instalado no servidor do ERP de PRODUÇÃO, que só faz a liberação do Televendas.
//    Endereço e senha de acesso ficam em data/conector.json ({ televendas: { url, token } }, pasta fora do repositório),
//    informados em Processos › Conector; a senha nunca volta pra tela. Sem ele, o Televendas vai no padrão (o de teste).
// Quem decide o destino é o TIPO da ordem: liberacao_televendas vai pro destino do Televendas, o resto sempre pro padrão.
const PADRAO = { nome: 'padrao', url: URL_BASE, senha: token, remoto: false };
function destinoTv() {
  const c = lerChave().televendas; if (!c || !c.url || !c.token) return null;
  return { nome: 'televendas', url: String(c.url).replace(/\/+$/, ''), senha: () => ({ token: c.token, origem: 'informada em Processos › Conector' }), remoto: true, ligadoEm: c.ligadoEm || null, ligadoPor: c.ligadoPor || null };
}
const destinoDoTipo = tipo => (tipo === 'liberacao_televendas' ? destinoTv() : null) || PADRAO;
const destino = onde => (onde === 'televendas' ? destinoTv() : null) || PADRAO;

/** Situação do Conector, sem expor a senha: está no ar? grava onde? o sistema consegue se autenticar nele? */
async function estado(d = PADRAO) {
  const out = { url: d.url, no_ar: false, saude: null, senha: false, senha_motivo: null, autenticado: false };
  try { const r = await fetch(d.url + '/v1/saude', { signal: AbortSignal.timeout(5000) }); out.saude = await r.json(); out.no_ar = r.ok; if (!r.ok) out.erro = 'Conector recusou: ' + ((out.saude && out.saude.erro) || 'resposta ' + r.status); }
  catch (e) { out.erro = 'Conector não respondeu: ' + e.message; return out; }
  const t = d.senha(); out.senha = !!t.token; out.senha_motivo = t.token ? t.origem : t.motivo;
  if (t.token) { try { const r = await fetch(d.url + '/v1/ordens?limite=1', { headers: { Authorization: 'Bearer ' + t.token }, signal: AbortSignal.timeout(5000) }); out.autenticado = r.ok; } catch (e) { out.autenticado = false; } }
  return out;
}
/** Situação do Conector do Televendas (o do servidor do ERP); null = não foi ligado, o Televendas vai no Conector padrão. */
async function estadoTelevendas() { const d = destinoTv(); if (!d) return null; return { ...(await estado(d)), ligadoEm: d.ligadoEm, ligadoPor: d.ligadoPor }; }
/** Liga o sistema ao Conector do Televendas. Confere ANTES de gravar: responde, é um Conector com a função e aceita a senha.
 *  Trocar o destino desliga a liberação automática: quem liga de novo é uma pessoa, sabendo onde vai gravar. */
async function setDestinoTelevendas({ url, senha } = {}, usuario) {
  url = String(url || '').trim().replace(/\/+$/, ''); senha = String(senha || '').trim();
  if (!/^http:\/\/[a-z0-9.-]+(:\d{2,5})?$/i.test(url)) throw new Error('Endereço inválido. Use o que o instalador mostrou, por exemplo http://192.168.2.252:3210');
  if (senha.length < 32) throw new Error('Senha de acesso inválida: é a sequência longa que o instalador mostrou no fim');
  let s; try { const r = await fetch(url + '/v1/saude', { signal: AbortSignal.timeout(6000) }); s = await r.json(); if (!r.ok) throw new Error((s && s.erro) || 'resposta ' + r.status); }
  catch (e) { throw new Error('O Conector em ' + url + ' não respondeu: ' + e.message); }
  if (!s || s.conector !== 'conector-erp' || !s.funcoes || !s.funcoes.liberacao_televendas) throw new Error('Quem respondeu em ' + url + ' não é um Conector com a liberação do Televendas (precisa da versão 0.6.0 ou mais nova)');
  let ok = false; try { ok = (await fetch(url + '/v1/ordens?limite=1', { headers: { Authorization: 'Bearer ' + senha }, signal: AbortSignal.timeout(6000) })).ok; } catch (e) {}
  if (!ok) throw new Error('O Conector respondeu, mas não aceitou a senha de acesso. Confira com "Mostrar ligacao do Conector" no servidor dele.');
  gravarChave({ ...lerChave(), televendas: { url, token: senha, ligadoEm: new Date().toISOString(), ligadoPor: usuario || null }, televendas_auto: false, televendasMudadoEm: new Date().toISOString(), televendasMudadoPor: usuario || null });
  versaoCache = {};
  return { ok: true, url, producao: !!s.producao, versao: s.versao, adaptador: s.adaptador, ligada: !!s.funcoes.liberacao_televendas.ligada };
}
/** Desliga o sistema do Conector do Televendas: a liberação volta a ir pro Conector padrão (o de teste). */
function removerDestinoTelevendas(usuario) { const c = lerChave(); delete c.televendas; gravarChave({ ...c, televendas_auto: false, televendasMudadoEm: new Date().toISOString(), televendasMudadoPor: usuario || null }); versaoCache = {}; return { ok: true }; }

// Chave: data/conector.json { ativo }. Ligada (padrão), os pedidos do ROBÔ gravam pelo Conector; desligada, voltam ao caminho de
// sempre (escreverERP). Não tem "tenta um, se falhar vai no outro": se o Conector recusar, o erro aparece pra quem aprovou.
const F_CHAVE = process.env.CONECTOR_CHAVE || path.join(__dirname, '..', 'data', 'conector.json');   // CONECTOR_CHAVE: só nos testes
function ativo() { if (process.env.CONECTOR_USO === 'off') return false;   // testes do caminho de sempre
  try { return JSON.parse(fs.readFileSync(F_CHAVE, 'utf8')).ativo !== false; } catch (e) { return true; } }
const lerChave = () => { try { return JSON.parse(fs.readFileSync(F_CHAVE, 'utf8')) || {}; } catch (e) { return {}; } };
const gravarChave = c => { fs.mkdirSync(path.dirname(F_CHAVE), { recursive: true }); fs.writeFileSync(F_CHAVE, JSON.stringify(c)); return c; };
function setAtivo(v, usuario) { return gravarChave({ ...lerChave(), ativo: !!v, mudadoEm: new Date().toISOString(), mudadoPor: usuario || null }); }
// Liberação do Televendas (19/11/26, Tiago: "assim que eu liberar no nosso, liberar no Dlinks"): chave SEPARADA e desligada por padrão.
// Ligada, toda saída que o fiscal do CD libera vira uma ordem de liberação no painel do Televendas. Enquanto o Conector aponta pro
// Dlinks de TESTE ela fica desligada (os pedidos de hoje não existem na cópia de teste): o ensaio é pela tela Processos › Conector.
function televendasAuto() { if (process.env.CONECTOR_USO === 'off') return false; return lerChave().televendas_auto === true; }
function setTelevendasAuto(v, usuario) { return gravarChave({ ...lerChave(), televendas_auto: !!v, televendasMudadoEm: new Date().toISOString(), televendasMudadoPor: usuario || null }); }

/** Manda uma ordem. Devolve no formato que as rotas já esperam do escreverERP: { ok, id, ids, erro, status }. */
async function enviar(tipo, chave, aprovadoPor, dados) {
  const d = destinoDoTipo(tipo), inicio = Date.now(), r = await enviarSemLog(tipo, chave, aprovadoPor, dados, d);
  r.destino = d.nome;   // 'padrao' (Conector desta máquina) ou 'televendas' (Conector do servidor do ERP)
  // toda ordem (executada, recusada ou com erro) fica em Processos › Log, igual às gravações do caminho antigo
  try {
    const itens = (dados && dados.itens) || [], res = r.resultado || {};
    // liberação do Televendas: uma linha do painel, sem itens; o Log mostra os três campos que mudam
    const tv = tipo === 'liberacao_televendas', campos = l => l ? { nPedido: dados.pedido, Status: l.Status, DataLiberacao: l.DataLiberacao, HoraLiberacao: l.HoraLiberacao } : null, mexeu = tv && r.ok && !res.ja_liberado;
    const e = tv ? { id: L.novoId(), quando: L.agoraIso(), usuario: String(aprovadoPor || '').trim(), servidor: 'conector', host: d.remoto ? d.url.replace(/^http:\/\//, '') : 'conector', banco: 'conector', tabela: tipo, operacao: 'ordem',
      motivo: String(dados.motivo || ('Conector: liberação do pedido ' + dados.pedido + ' no Televendas')).slice(0, 200) + ' · loja ' + dados.loja + (d.remoto ? ' · Conector do servidor do ERP' : ''), where: { chave, ordem: r.ordem || null, destino: d.nome }, valores: { loja: dados.loja, pedido: dados.pedido },
      limite: 1, sql: null, params: null, afetados: mexeu ? 1 : 0, antes: campos(res.antes) ? [campos(res.antes)] : [], depois: r.ok && campos(res.depois) ? [campos(res.depois)] : [], colunas_mudadas: mexeu ? ['Status', 'DataLiberacao', 'HoraLiberacao'] : [],
      status: r.ok ? 'ok' : r.status, erro: r.ok ? null : r.erro, ms: Date.now() - inicio, ordem_conector: r.ordem || null }
    : { id: L.novoId(), quando: L.agoraIso(), usuario: String(aprovadoPor || '').trim(), servidor: 'conector', host: 'conector',
      banco: 'conector', tabela: tipo, operacao: 'ordem', motivo: String((dados && (dados.motivo || dados.obs)) || ('Conector: ' + tipo)).slice(0, 200) + ' · loja ' + (dados && dados.loja),
      where: { chave, ordem: r.ordem || null }, valores: tipo === 'preco_venda' || tipo === 'ajuste_estoque' ? { loja: dados.loja, itens: itens.length } : { loja: dados.loja, fornecedor: dados.fornecedor && dados.fornecedor.codigo, itens: itens.length },
      limite: itens.length, sql: null, params: null, afetados: r.ok ? (tipo === 'ajuste_estoque' ? res.ajustados || 0 : itens.length) : 0,
      antes: tipo === 'preco_venda' ? (res.antes || []).map(a => ({ CodigoBarra: a.codigo, preco: a.preco })) : tipo === 'ajuste_estoque' ? (res.antes || []).map(a => ({ CodigoBarra: a.codigo, Qtd: a.qtd })) : [],
      depois: !r.ok ? [] : tipo === 'ajuste_estoque' ? (res.antes || []).map(a => ({ CodigoBarra: a.codigo, Qtd: (itens.find(i => i.codigo === a.codigo) || {}).qtd })) : tipo === 'preco_venda' ? itens.map(i => ({ CodigoBarra: i.codigo, preco: String(Number(i.preco).toFixed(2)).replace('.', ',') })) : [{ pedido: res.pedido, total: res.total, itens: res.itens }],
      colunas_mudadas: r.ok && tipo === 'preco_venda' ? ['preco'] : r.ok && tipo === 'ajuste_estoque' ? ['Qtd'] : [], status: r.ok ? 'ok' : r.status, erro: r.ok ? null : r.erro, ms: Date.now() - inicio, ordem_conector: r.ordem || null };
    L.gravar(DIR_LOG, e); r.id = e.id;   // o "Log nº" que as telas mostram passa a ser o do Log de Processos; a ordem do Conector vai junto em r.ordem
  } catch (e) { console.error('[CONECTOR] não gravou no Log:', e.message); }
  return r;
}
async function enviarSemLog(tipo, chave, aprovadoPor, dados, d = PADRAO) {
  const t = d.senha(); if (!t.token) return { ok: false, status: 'erro', erro: 'Conector: ' + t.motivo };
  let r, j;
  try {
    r = await fetch(d.url + '/v1/ordens', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.token }, body: JSON.stringify({ tipo, chave, aprovado_por: aprovadoPor || '', dados }), signal: AbortSignal.timeout(60000) });
    j = await r.json();
  } catch (e) { return { ok: false, status: 'erro', erro: 'Conector não respondeu: ' + e.message }; }
  const id = j && j.id ? 'conector:' + j.id : null;
  if (j && j.status === 'executada') return { ok: true, status: 'ok', id, ids: [j.resultado && j.resultado.pedido != null ? j.resultado.pedido : null], ordem: j.id, resultado: j.resultado };
  const motivo = (j && j.resultado && j.resultado.motivo) || (j && j.motivos && j.motivos.join('; ')) || (j && j.erro) || ('resposta ' + r.status);
  // função desligada na instalação (Conector 0.6.0+): nada foi tentado no ERP; quem chamou pode distinguir pelo `desligada`
  return { ok: false, status: j && (j.status === 'recusada' || j.funcao_desligada) ? 'recusado' : 'erro', id, ordem: (j && j.id) || null, erro: 'Conector: ' + motivo, desligada: !!(j && j.funcao_desligada) };
}
// ── tela Processos › Conector: ordens que passaram por ele, detalhe e desfazer ──
async function chamar(rota, corpo, d = PADRAO) {
  const t = d.senha(); if (!t.token) throw new Error('Conector: ' + t.motivo);
  const r = await fetch(d.url + rota, { method: corpo === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.token }, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || j.error || ('Conector respondeu ' + r.status));
  return j;
}
// `onde`: 'televendas' = o Conector do servidor do ERP (se estiver ligado); qualquer outra coisa = o padrão desta máquina
const ordens = (limite = 200, onde) => chamar('/v1/ordens?limite=' + Math.max(1, Math.min(500, +limite || 200)), undefined, destino(onde));
const ordem = (id, onde) => chamar('/v1/ordens/' + encodeURIComponent(String(id).replace(/[^0-9a-f-]/g, '')), undefined, destino(onde));
/** Desfaz uma ordem executada. Fica em Processos › Log com quem pediu. */
async function desfazer(id, usuario, onde) {
  const inicio = Date.now(); let r = null, erro = null;
  try { r = await chamar('/v1/ordens/' + encodeURIComponent(String(id).replace(/[^0-9a-f-]/g, '')) + '/desfazer', { por: usuario || '' }, destino(onde)); } catch (e) { erro = e.message; }
  try {
    L.gravar(DIR_LOG, { id: L.novoId(), quando: L.agoraIso(), usuario: String(usuario || '').trim(), servidor: 'conector', host: 'conector', banco: 'conector', tabela: (r && r.tipo) || 'ordem', operacao: 'desfazer',
      motivo: 'Conector: ordem ' + id + ' desfeita', where: { ordem: id }, valores: null, limite: 0, sql: null, params: null, afetados: r ? r.itens || 0 : 0, antes: [], depois: [], colunas_mudadas: [],
      status: erro ? 'erro' : 'ok', erro, ms: Date.now() - inicio, ordem_conector: id });
  } catch (e) { console.error('[CONECTOR] não gravou no Log:', e.message); }
  if (erro) throw new Error(erro);
  return r;
}
let versaoCache = {};   // por endereço: { em, v }
/** Versão do Conector instalado ([maior, menor, correção]); guarda 1 min. null = não respondeu. */
async function versao(d = PADRAO) {
  const g = versaoCache[d.url]; if (g && Date.now() - g.em < 60000) return g.v;
  let v = null;
  try { const r = await fetch(d.url + '/v1/saude', { signal: AbortSignal.timeout(5000) }); const j = await r.json(); v = String(j.versao || '').split('.').map(n => parseInt(n, 10) || 0); if (v.length < 3) v = null; } catch (e) { v = null; }
  versaoCache[d.url] = { em: Date.now(), v }; return v;
}
/** O Conector instalado é desta versão ou mais novo? (recurso novo só é usado quando a versão instalada aguenta) */
async function versaoMinima(a, b, c, d = PADRAO) { const v = await versao(d); if (!v) return false; return v[0] !== a ? v[0] > a : v[1] !== b ? v[1] > b : v[2] >= c; }
const suportaAtacado = () => versaoMinima(0, 4, 0);      // preço de atacado
const aceitaPrecoZero = () => versaoMinima(0, 4, 1);     // pedido com item sem preço
const suportaAjusteEstoque = () => versaoMinima(0, 5, 0);   // ajuste de estoque (negativos)
const ajusteEstoque = (chave, aprovadoPor, dados) => enviar('ajuste_estoque', chave, aprovadoPor, dados);
const pedidoCompra = (chave, aprovadoPor, dados) => enviar('pedido_compra', chave, aprovadoPor, dados);
const precoVenda = (chave, aprovadoPor, dados) => enviar('preco_venda', chave, aprovadoPor, dados);
// ── Televendas (Conector 0.6.0+) ──
// Tudo do Televendas vai pro destino do Televendas (o Conector do servidor do ERP, quando ligado; senão o padrão).
const suportaTelevendas = () => versaoMinima(0, 6, 0, destinoDoTipo('liberacao_televendas'));
/** Libera UM pedido no painel do Televendas do Dlinks. dados: { loja, pedido, motivo? }. */
const liberacaoTelevendas = (chave, aprovadoPor, dados) => enviar('liberacao_televendas', chave, aprovadoPor, dados);
/** Só leitura: como o pedido está no Televendas do banco em que o Conector grava (cabeçalho, linha do painel, bipes do Dlinks). */
const consultaTelevendas = (loja, pedido) => chamar('/v1/consulta/televendas?loja=' + (parseInt(loja, 10) || 0) + '&pedido=' + (parseInt(pedido, 10) || 0), undefined, destinoDoTipo('liberacao_televendas'));
/** Funções ligadas na instalação do Conector ({ tipo: { nome, ligada } }); null = não respondeu ou é anterior à 0.6.0. */
async function funcoes(d = PADRAO) { try { const r = await fetch(d.url + '/v1/saude', { signal: AbortSignal.timeout(5000) }); const j = await r.json(); return j.funcoes || null; } catch (e) { return null; } }

module.exports = { estadoTelevendas, setDestinoTelevendas, removerDestinoTelevendas, suportaTelevendas, liberacaoTelevendas, consultaTelevendas, funcoes, televendasAuto, setTelevendasAuto, suportaAjusteEstoque, ajusteEstoque, versao, versaoMinima, aceitaPrecoZero, suportaAtacado, estado, ativo, setAtivo, enviar, pedidoCompra, precoVenda, ordens, ordem, desfazer, URL_BASE };
