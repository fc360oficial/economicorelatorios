// lib/recebimento.js — conferência cega de recebimento (estado no Econômico; ERP é espelho, ver recebimento-erp.js)
// estados de item (it.estado): 'ok' | 'recusado' | 'bloqueado_validade' | 'nao_esta_na_nota' | 'sem_validade'
// ('nao_cadastrado' não gera item — bipar retorna { resultado: 'nao_cadastrado', item: null })
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
let DIR, deps = {}; const LOJAS = [1, 2, 3, 4, 5, 6];
const PADRAO = { validade_pct_min: 100, recontagens_min: 1, modo_cega: 'total', janela_dias_axml: 7 };
const agora = () => (deps.agora ? deps.agora() : new Date());
const hojeStr = () => { const d = agora(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const arqCfg = () => path.join(DIR, 'recebimento-config.json');
const arqDia = data => path.join(DIR, data + '.json');
function init(o) { DIR = o.dir; deps = o; fs.mkdirSync(DIR, { recursive: true }); config(); }
function config() { let c = {}; try { c = JSON.parse(fs.readFileSync(arqCfg(), 'utf8')); } catch {} c = { ...PADRAO, ...c, lojas: c.lojas || {} }; let mudou = false;
  for (const ln of LOJAS) { c.lojas[ln] = c.lojas[ln] || {}; if (!c.lojas[ln].pin) { c.lojas[ln].pin = String(1000 + Math.floor(Math.random() * 9000)); mudou = true; } if (!c.lojas[ln].token) { c.lojas[ln].token = crypto.randomBytes(16).toString('hex'); mudou = true; } }
  if (mudou || !fs.existsSync(arqCfg())) fs.writeFileSync(arqCfg(), JSON.stringify(c, null, 2)); return c; }
function setConfig(campos) { const c = { ...config(), ...campos }; fs.writeFileSync(arqCfg(), JSON.stringify(c, null, 2)); return c; }
function lojaPorPin(ln, pin) { const c = config().lojas[ln]; return c && String(pin) === String(c.pin) ? { loja: +ln, token: c.token } : null; }
function lojaPorToken(t) { if (!/^[a-f0-9]{32}$/.test(String(t || ''))) return null; const c = config(); const ln = LOJAS.find(k => c.lojas[k].token === t); return ln ? { loja: ln, token: t } : null; }
function lerDia(data) {
  try { return JSON.parse(fs.readFileSync(arqDia(data), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { data, confs: {} };
    try {
      const destino = path.join(DIR, `${data}.corrompido-${Date.now()}.json`);
      fs.renameSync(arqDia(data), destino);
      console.error(`recebimento: arquivo do dia ${data} corrompido, renomeado para ${destino}`, e);
    } catch (e2) { console.error(`recebimento: falha ao renomear arquivo corrompido do dia ${data}`, e2); }
    return { data, confs: {} };
  }
}
function gravarDia(d) { fs.writeFileSync(arqDia(d.data), JSON.stringify(d)); }
function obter(id) { return lerDia(id.slice(0, 10)).confs[id] || null; }
function salvar(c) { const d = lerDia(c.id.slice(0, 10)); c.atualizadoEm = agora().toISOString(); d.confs[c.id] = c; gravarDia(d); return c; }
function listarDia(data = hojeStr()) { return Object.values(lerDia(data).confs); }
function abrirNota({ loja, nome, chave, nNota, fornecedor, codFornec }) {
  const id = `${hojeStr()}-${loja}-${nNota}`; const ex = obter(id); if (ex) return ex;
  return salvar({ id, loja: +loja, nome: String(nome || '').toUpperCase().slice(0, 20), chave, nNota: String(nNota), fornecedor, codFornec: +codFornec || 0, status: 'bipando', abertoEm: agora().toISOString(), itens: {}, recontagens: 0, mensagens: [], erp: { nReg: null, erros: [] } });
}
function diasAte(validade) { if (!validade) return null; return Math.round((new Date(validade + 'T00:00:00') - new Date(hojeStr() + 'T00:00:00')) / 864e5); }
function xmlDe(c) { const x = deps.xmlLoja ? deps.xmlLoja(c.chave) : null; return x || { itens: [], naoPedidos: [], status: 'sem_pedido' }; }
async function bipar(id, { cod, quant, emb, validade, nome }) {
  // cadastro (única espera assíncrona) roda ANTES da leitura da conferência; do obter() até o
  // salvar() é tudo síncrono, então duas bipagens concorrentes na mesma nota não se pisam.
  cod = String(cod || '').trim(); const cad = await deps.cadastro(cod);
  const c = obter(id); if (!c) throw new Error('Conferência não encontrada'); if (c.status === 'liberada') throw new Error('Nota já liberada');
  if (!cad) return { resultado: 'nao_cadastrado', item: null };
  const x = xmlDe(c); const noXml = (x.itens || []).find(i => i.cod === cod); const cfg = config();
  quant = +quant || 0; emb = +emb || cad.qtdemb || 1; const un = +(quant * emb).toFixed(3);
  const it = c.itens[cod] || (c.itens[cod] = { cod, descricao: cad.descricao, quant: 0, emb, un: 0, validade: null, estado: 'ok', bipagens: 0, validar: cad.validar || 0 });
  it.bipagens++; it.quant = +(it.quant + quant).toFixed(3); it.emb = emb; it.un = +(it.un + un).toFixed(3);
  if (validade && (!it.validade || validade < it.validade)) it.validade = validade;
  let resultado = 'ok';
  if (noXml && noXml.decisao && noXml.decisao.acao === 'recusar') { it.estado = 'recusado'; it.origem_devolucao = 'compras'; resultado = 'recusado'; }
  else if (!noXml) { it.estado = 'nao_esta_na_nota'; resultado = 'nao_esta_na_nota'; }
  const d = diasAte(it.validade);
  if (resultado === 'ok' && it.validar > 0 && d != null && d < it.validar * (cfg.validade_pct_min / 100)) { it.estado = 'bloqueado_validade'; it.origem_devolucao = 'coletor'; resultado = 'bloqueado_validade'; }
  else if (resultado === 'ok' && it.validar > 0 && it.validade == null) { it.estado = 'sem_validade'; resultado = 'sem_validade'; }
  if (resultado === 'ok') { it.estado = 'ok'; if (!(it.validar > 0)) it.aviso = 'sem_cadastro_validade'; }
  it.por = nome || c.nome; it.em = agora().toISOString(); salvar(c); return { resultado, item: it };
}
async function corrigir(id, { cod, quant, emb, validade }) { const c = obter(id); const it = c && c.itens[cod]; if (!it) throw new Error('Item não bipado');
  it.quant = 0; it.un = 0; it.validade = null; it.bipagens = 0; delete it.origem_devolucao; delete it.aviso; salvar(c); return bipar(id, { cod, quant, emb, validade, nome: c.nome }); }
function visaoLoja(loja, id) { const c = obter(id); if (!c || +c.loja !== +loja) return null; const itens = Object.values(c.itens);
  return { id: c.id, nNota: c.nNota, fornecedor: c.fornecedor, status: c.status, recontagens: c.recontagens, produtos: itens.length, unidades: +itens.reduce((a, i) => a + i.un, 0).toFixed(3),
    itens: itens.map(i => ({ cod: i.cod, descricao: i.descricao, quant: i.quant, emb: i.emb, un: i.un, validade: i.validade, estado: i.estado })), recontar: c.recontar || null, mensagens: c.mensagens.slice(-50) }; }
module.exports = { init, config, setConfig, lojaPorPin, lojaPorToken, hojeStr, obter, salvar, listarDia, abrirNota, bipar, corrigir, visaoLoja, diasAte, xmlDe, LOJAS };
