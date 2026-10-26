// Cadastro único de vendedores — Gestão de Compras > Vendedores (Tiago, 26/10/2026: "o portal vai ser para todos os
// vendedores do sistema, independente [de lista]; cada vendedor tem a sua empresa; tem que ser o cadastro único para
// cada vendedor").
//
// Antes não existia cadastro de vendedor: cada lista guardava a própria cópia (nome, WhatsApp, e-mail) dentro do cadastro de
// fornecedores dela (data/cotacoes-fornecedores.json) e cada cotação / pedido copiava de novo na hora do convite. A mesma
// pessoa aparecia com número diferente em listas diferentes, e o Portal do Fornecedor (que casa pelo WhatsApp) tratava como
// duas (26/10: Maria Alexsandra, A & B, com login no 98727-4841 e "alexandra" 98127-4841 na lista #218 "fora do portal").
//
// Aqui: UM registro por vendedor (id numérico) com nome, WhatsApp (chave; normalizado sem 55), e-mail e a empresa dele
// (codFornec + nome do ERP). Listas, cotações, pedidos e portal continuam guardando a cópia deles (formato não muda), mas
// este cadastro é a fonte da verdade: corrigir aqui PROPAGA pra todas as cópias (listas, cotações, pedidos e a conta do
// portal, re-chaveada sem perder PIN, sessão e aparelhos). "Unir" dois registros (mesma pessoa com dois números) troca o
// número errado pelo certo em tudo e guarda o antigo em `antigos`, pra qualquer cópia velha ainda casar com a pessoa certa.
//
// Alimentação: ao subir e a cada gravação de cadastro de lista / cotação criada / login no portal, o módulo "absorve" os
// vendedores que ainda não conhece. Absorver nunca sobrescreve o que já tem (só preenche campo vazio); quem manda é a tela.
// Persistência: data/vendedores/vendedores.json. NADA é escrito no ERP.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.env.VENDEDORES_DIR || path.join(__dirname, '..', 'data', 'vendedores');
const ARQ = path.join(DIR, 'vendedores.json');
let deps = {};        // { lerCotForn, gravarCotForn, cotacao, pedidosFornec, portal, log }
let D = null;         // { seq, itens: { [id]: { id, nome, whats, email, codFornec, empresa, ativo, antigos:[], teste, origem, criadoEm, atualizadoEm } } }
const log = (...a) => (deps.log || console.log)('[VENDEDORES]', ...a);
const agora = () => new Date().toISOString();

// WhatsApp no padrão da casa (portal-fornecedor.normWhats): só dígitos, sem 55; 9 dígitos ganham 81, 8 ganham 81 9
function normWhats(v) {
  let d = String(v || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length === 9) d = '81' + d; else if (d.length === 8) d = '819' + d;
  return d.length === 10 || d.length === 11 ? d : '';
}
const normEmail = e => String(e || '').trim().toLowerCase().slice(0, 120);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const normNome = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const chaveNome = n => normNome(n).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const normEmpresa = e => String(e || '').replace(/\s+/g, ' ').trim().slice(0, 120);

function carregar() { try { D = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { D = null; } if (!D || typeof D !== 'object' || !D.itens) D = { seq: 0, itens: {} }; if (!(D.seq > 0)) D.seq = Object.keys(D.itens).reduce((m, k) => Math.max(m, +k || 0), 0); }
function gravar() { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(D, null, 1)); }
const ativos = () => D ? Object.values(D.itens).filter(v => v.ativo !== false) : [];
const reais = () => ativos().filter(v => !v.teste);
function obter(id) { return D.itens[parseInt(id)] || null; }
// pelo número: o atual ou um número antigo (unido/corrigido) — assim cópia velha numa cotação fechada ainda acha a pessoa certa
function porWhats(w) { w = normWhats(w); if (!w) return null; const as = ativos(); return as.find(v => v.whats === w) || as.find(v => (v.antigos || []).includes(w)) || null; }
function porNomeEmpresa(nome, codFornec) { const k = chaveNome(nome); if (!k) return null; return ativos().find(v => !v.whats && chaveNome(v.nome) === k && (+v.codFornec || 0) === (+codFornec || 0)) || null; }

// ── absorver: registra o que as listas / cotações / pedidos / portal conhecem e o cadastro ainda não ──────────────
// x = { nome, whats, email, codFornec, empresa }. Nunca sobrescreve: só preenche campo vazio do registro que já existe.
function absorver(x, origem) {
  if (!x || !D) return null;
  const w = normWhats(x.whats), nome = normNome(x.nome), email = normEmail(x.email), cod = parseInt(x.codFornec) || 0, emp = normEmpresa(x.empresa);
  if (!w && !nome) return null;
  let v = (w && porWhats(w)) || porNomeEmpresa(nome, cod);   // registro sem número com o mesmo nome na mesma empresa ganha o número
  let mudou = false;
  if (!v) {
    if (!w && !cod) return null;   // nome solto, sem número e sem empresa, não vira cadastro
    v = { id: ++D.seq, nome: nome || null, whats: w || null, email: emailOk(email) ? email : null, codFornec: cod || null, empresa: emp || null, ativo: true, antigos: [], origem: origem || null, criadoEm: agora(), atualizadoEm: agora() };
    D.itens[v.id] = v; mudou = true;
  } else {
    if (!v.nome && nome) { v.nome = nome; mudou = true; }
    if (!v.email && emailOk(email)) { v.email = email; mudou = true; }
    if (!v.codFornec && cod) { v.codFornec = cod; v.empresa = emp || v.empresa; mudou = true; }
    if (!v.empresa && emp) { v.empresa = emp; mudou = true; }
    if (!v.whats && w) { v.whats = w; mudou = true; }   // registro sem número ganha o número
    if (mudou) v.atualizadoEm = agora();
  }
  return { v, novo: mudou };
}
function registrar(x, origem) { const r = absorver(x, origem); if (r && r.novo) gravar(); return r ? r.v : null; }
function registrarVarios(xs, origem) { let n = 0; for (const x of xs || []) { const r = absorver(x, origem); if (r && r.novo) n++; } if (n) gravar(); return n; }
// cadastro de uma lista salvo na tela Fornecedores por lista (POST /api/cotacoes/lista/:lista/fornecedores). É edição explícita
// do(a) comprador(a), então o cadastro único SEGUE a lista: nome / e-mail novos entram (e vão pras outras cópias); número
// trocado no mesmo vendedor (mesma empresa + mesmo nome, número antigo sumiu da lista) vira correção; vendedor novo é
// absorvido. Cópia que ainda traz um número antigo do vendedor (aba velha aberta) é devolvida ao número atual.
function registrarLista(lista, cad) {
  if (!D) return { novos: 0, corrigidos: 0, devolvidos: 0 };
  const copias = (cad || []).flatMap(f => [f.vendedor].concat(f.vendedores || []).filter(Boolean).map(x => ({ x, codFornec: f.codFornec, empresa: f.nome })));
  const numerosDaLista = new Set(copias.map(c => normWhats(c.x.whats)).filter(Boolean));
  let novos = 0, corrigidos = 0, devolvidos = 0;
  for (const { x, codFornec, empresa } of copias) {
    const w = normWhats(x.whats), nome = normNome(x.nome), email = normEmail(x.email);
    const v = w ? porWhats(w) : null;
    if (v) {
      if (w !== v.whats) { x.whats = v.whats; devolvidos++; }   // cópia com número antigo do mesmo vendedor
      if (v.teste) continue;
      const dados = { nome: nome || v.nome, whats: v.whats, email: emailOk(email) ? email : v.email, codFornec: v.codFornec || codFornec, empresa: v.empresa || empresa };
      if (dados.nome !== v.nome || dados.email !== v.email || (dados.codFornec || null) !== (v.codFornec || null)) { const r = salvar(v.id, dados, 'lista ' + lista); if (r.ok) { corrigidos++; x.nome = r.vendedor.nome; if (r.vendedor.email) x.email = r.vendedor.email; } }
      continue;
    }
    if (w) {
      const k = chaveNome(nome);
      const rec = k ? ativos().find(y => !y.teste && y.whats && !numerosDaLista.has(y.whats) && chaveNome(y.nome) === k && (+y.codFornec || 0) === (+codFornec || 0)) : null;
      if (rec) { const r = corrigirPorCopia({ nome: rec.nome, whats: rec.whats, email: rec.email }, { nome, whats: w, email }, { codFornec, empresa }); if (r && r.ok) corrigidos++; continue; }
    }
    const r = absorver({ nome, whats: w, email, codFornec, empresa }, 'lista ' + lista); if (r && r.novo) novos++;
  }
  if (novos) gravar();
  if (devolvidos && deps.lerCotForn && deps.gravarCotForn) { try { const todos = deps.lerCotForn(); todos[lista] = cad; deps.gravarCotForn(todos); } catch (e) { log('devolver número atual à lista', lista, e.message); } }
  if (novos || corrigidos || devolvidos) log('lista', lista, '->', novos, 'novo(s),', corrigidos, 'corrigido(s),', devolvidos, 'cópia(s) devolvida(s) ao número atual');
  return { novos, corrigidos, devolvidos };
}
function registrarCotacao(c) { if (!c || c.teste) return 0; return registrarVarios((c.fornecedores || []).flatMap(f => [f.vendedor].concat(f.vendedores || []).filter(Boolean).map(x => ({ ...x, codFornec: f.codFornecErp || f.codFornec, empresa: f.empresa || f.nome }))), 'cotação ' + c.id); }
function absorverTudo(origem) {
  let novos = 0; const conta = r => { if (r && r.novo) novos++; };
  try { const todos = deps.lerCotForn ? deps.lerCotForn() : {}; for (const [lista, arr] of Object.entries(todos || {})) { if (!Array.isArray(arr)) continue; for (const cad of arr) for (const x of [cad.vendedor].concat(cad.vendedores || [])) if (x) conta(absorver({ ...x, codFornec: cad.codFornec, empresa: cad.nome }, 'lista ' + lista)); } } catch (e) { log('absorver listas:', e.message); }
  try { for (const c of (deps.cotacao ? deps.cotacao.listar() : [])) { if (c.teste) continue; for (const f of c.fornecedores || []) for (const x of [f.vendedor].concat(f.vendedores || [])) if (x) conta(absorver({ ...x, codFornec: f.codFornecErp || f.codFornec, empresa: f.empresa || f.nome }, 'cotação ' + c.id)); } } catch (e) { log('absorver cotações:', e.message); }
  try { for (const p of (deps.pedidosFornec ? deps.pedidosFornec.listar() : [])) { if (p.teste || !p.vendedor) continue; conta(absorver({ ...p.vendedor, codFornec: p.codFornec, empresa: p.fornecedor }, 'pedido ' + p.id)); } } catch (e) { log('absorver pedidos:', e.message); }
  try { for (const a of (deps.portal && deps.portal.contas ? deps.portal.contas() : [])) { if (a.teste) continue; const e = (a.empresas || [])[0] || {}; conta(absorver({ nome: a.nome, whats: a.whats, email: a.email, codFornec: e.codFornec, empresa: e.nome }, 'portal')); } } catch (e) { log('absorver portal:', e.message); }
  if (novos) gravar();
  return { novos, total: reais().length, origem: origem || null };
}

// ── onde cada número aparece (listas, cotações, empresas) — calculado na hora, nada guardado ─────────────────────
function indice() {
  const m = {}; const at = w => (m[w] = m[w] || { listas: [], cotacoes: [], empresas: {} });
  try { const todos = deps.lerCotForn ? deps.lerCotForn() : {}; for (const [lista, arr] of Object.entries(todos || {})) { if (!Array.isArray(arr)) continue; const id = parseInt(lista); if (!id) continue; for (const cad of arr) for (const x of [cad.vendedor].concat(cad.vendedores || [])) { const w = normWhats(x && x.whats); if (!w) continue; const r = at(w); if (!r.listas.includes(id)) r.listas.push(id); if (cad.codFornec) r.empresas[cad.codFornec] = cad.nome; } } } catch (e) { log('índice listas:', e.message); }
  try { for (const c of (deps.cotacao ? deps.cotacao.listar() : [])) { if (c.teste) continue; for (const f of c.fornecedores || []) for (const x of [f.vendedor].concat(f.vendedores || [])) { const w = normWhats(x && x.whats); if (!w) continue; const r = at(w); if (!r.cotacoes.some(k => k.id === c.id)) r.cotacoes.push({ id: c.id, nome: c.nome, status: c.status, criadoEm: c.criadoEm, f_status: f.status }); const cod = f.codFornecErp || f.codFornec; if (cod) r.empresas[cod] = f.empresa || f.nome; } } } catch (e) { log('índice cotações:', e.message); }
  return m;
}
// empresas conhecidas (cadastro das listas + registros), pro campo Empresa da tela
function empresasConhecidas() {
  const m = {};
  try { const todos = deps.lerCotForn ? deps.lerCotForn() : {}; for (const arr of Object.values(todos || {})) { if (!Array.isArray(arr)) continue; for (const cad of arr) if (cad.codFornec && cad.nome) m[cad.codFornec] = m[cad.codFornec] || cad.nome; } } catch (e) { /* sem cadastro de listas */ }
  for (const v of ativos()) if (v.codFornec && v.empresa && !m[v.codFornec]) m[v.codFornec] = v.empresa;
  return Object.entries(m).map(([cod, nome]) => ({ codFornec: +cod, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
function listar() {
  const ix = indice(); const contaDe = deps.portal && deps.portal.contaDe ? w => deps.portal.contaDe(w) : () => null;
  return Object.values(D.itens).map(v => {
    const chaves = [v.whats].concat(v.antigos || []).filter(Boolean);
    const r = { listas: [], cotacoes: [], empresas: {} };
    for (const w of chaves) { const x = ix[w]; if (!x) continue; for (const l of x.listas) if (!r.listas.includes(l)) r.listas.push(l); for (const c of x.cotacoes) if (!r.cotacoes.some(k => k.id === c.id)) r.cotacoes.push(c); Object.assign(r.empresas, x.empresas); }
    const outras = Object.entries(r.empresas).filter(([cod]) => +cod !== +(v.codFornec || 0)).map(([cod, nome]) => ({ codFornec: +cod, nome }));
    return { ...v, listas: r.listas.sort((a, b) => a - b), cotacoes: r.cotacoes.sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm))).slice(0, 3), outras_empresas: outras, portal: v.whats ? contaDe(v.whats) : null };
  }).sort((a, b) => (a.ativo === false) - (b.ativo === false) || String(a.empresa || '').localeCompare(String(b.empresa || ''), 'pt-BR') || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
}

// ── possíveis duplicados: mesma pessoa cadastrada com dois números (ou dois registros parecidos) ───────────────────
const tokens = n => chaveNome(n).split(' ').filter(t => t.length >= 4);
const nomeParecido = (a, b) => { const ta = tokens(a), tb = tokens(b); return ta.length > 0 && tb.length > 0 && ta.some(t => tb.includes(t)); };
function numeroParecido(a, b) {
  if (!a || !b || a === b) return false;
  if (a.slice(-8) === b.slice(-8)) return true;   // mesmo número, um com o 9 e outro sem
  if (a.length !== b.length) return false;
  let dif = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dif++;
  return dif === 1;   // um dígito trocado
}
function suspeitos() {
  const vs = ativos(), out = [];   // exemplos de teste só casam entre si (pra mostrar o bloco na tela); nunca com vendedor real
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
    const a = vs[i], b = vs[j]; if (!!a.teste !== !!b.teste) continue; const mesmaEmp = a.codFornec && b.codFornec && +a.codFornec === +b.codFornec;
    const nome = nomeParecido(a.nome, b.nome), num = numeroParecido(a.whats, b.whats);
    let motivo = null;
    if (num && (nome || mesmaEmp)) motivo = 'números diferem em um dígito' + (mesmaEmp ? ', mesma empresa' : ', nome parecido');
    else if (mesmaEmp && nome) motivo = 'mesma empresa e nome parecido';
    else if (a.email && b.email && a.email === b.email && nome) motivo = 'mesmo e-mail e nome parecido';
    if (motivo) out.push({ a: a.id, b: b.id, motivo });
  }
  return out;
}

// ── propagar: o cadastro manda nas cópias (listas, cotações, pedidos, conta do portal) ───────────────────────────
// `antigo` = WhatsApp que as cópias ainda têm (ou null: casa por nome + empresa, pra vendedor que não tinha número)
function propagar(antigo, v, antigoNome, opts) {
  opts = opts || {};
  const dados = { nome: v.nome, whats: v.whats, email: v.email };
  const casa = (x, cod) => { if (!x) return false; const w = normWhats(x.whats); if (antigo) return w === antigo; return !w && !!chaveNome(antigoNome) && chaveNome(x.nome) === chaveNome(antigoNome) && (+cod || 0) === (+v.codFornec || 0); };
  const out = { listas: 0, cotacoes: 0, pedidos: 0, portal: null };
  try {
    const todos = deps.lerCotForn ? deps.lerCotForn() : {}; let n = 0;
    for (const arr of Object.values(todos || {})) { if (!Array.isArray(arr)) continue; for (const cad of arr) for (const x of [cad.vendedor].concat(cad.vendedores || [])) if (casa(x, cad.codFornec)) { if (dados.nome) x.nome = dados.nome; x.whats = dados.whats || ''; if (dados.email) x.email = dados.email; n++; } }
    if (n && deps.gravarCotForn) deps.gravarCotForn(todos); out.listas = n;
  } catch (e) { log('propagar listas:', e.message); }
  try { if (deps.cotacao && deps.cotacao.atualizarVendedor) out.cotacoes = deps.cotacao.atualizarVendedor(casa, dados); } catch (e) { log('propagar cotações:', e.message); }
  try { if (deps.pedidosFornec && deps.pedidosFornec.atualizarVendedor) out.pedidos = deps.pedidosFornec.atualizarVendedor(casa, dados); } catch (e) { log('propagar pedidos:', e.message); }
  try { if (antigo && !opts.semPortal && deps.portal && deps.portal.atualizarVendedor) out.portal = deps.portal.atualizarVendedor(antigo, dados); } catch (e) { log('propagar portal:', e.message); }
  log('propagado', antigo || ('nome "' + antigoNome + '"'), '->', dados.whats, dados.nome, JSON.stringify(out));
  return out;
}

// ── tela: criar, editar, unir, desativar ───────────────────────────────────────────────────────────────────────
function validar(dados, ignorarId) {
  const nome = normNome(dados.nome), w = normWhats(dados.whats), email = normEmail(dados.email), cod = parseInt(dados.codFornec) || null, emp = normEmpresa(dados.empresa);
  if (nome.length < 2) return { erro: 'Informe o nome do vendedor' };
  if (String(dados.whats || '').replace(/\D/g, '') && !w) return { erro: 'WhatsApp inválido: DDD + número, ex. 81 99999-0000' };
  if (email && !emailOk(email)) return { erro: 'E-mail inválido' };
  if (w) { const outro = ativos().find(x => x.id !== ignorarId && (x.whats === w || (x.antigos || []).includes(w))); if (outro) return { erro: 'Este WhatsApp já é de ' + (outro.nome || 'outro vendedor') + ' (#' + outro.id + (outro.empresa ? ', ' + outro.empresa : '') + '). Se é a mesma pessoa, use "Unir".', outro: outro.id }; }
  return { nome, w, email: email || null, cod, emp: emp || null };
}
function criar(dados, usuario) {
  const r = validar(dados || {}); if (r.erro) return r;
  const v = { id: ++D.seq, nome: r.nome, whats: r.w || null, email: r.email, codFornec: r.cod, empresa: r.emp, ativo: true, antigos: [], origem: 'tela', criadoEm: agora(), criadoPor: usuario || null, atualizadoEm: agora() };
  D.itens[v.id] = v; gravar(); return { ok: true, vendedor: v };
}
function salvar(id, dados, usuario) {
  const v = obter(id); if (!v) return { erro: 'Vendedor não encontrado' };
  const r = validar(dados || {}, v.id); if (r.erro) return r;
  const antigo = { nome: v.nome, whats: v.whats, email: v.email };
  if (v.whats && r.w && v.whats !== r.w) v.antigos = [...new Set([...(v.antigos || []), v.whats])];
  if (r.w) v.antigos = (v.antigos || []).filter(a => a !== r.w);
  v.nome = r.nome; v.whats = r.w || null; v.email = r.email; v.codFornec = r.cod; v.empresa = r.emp; v.atualizadoEm = agora(); v.atualizadoPor = usuario || null;
  gravar();
  const mudou = antigo.whats !== v.whats || antigo.nome !== v.nome || antigo.email !== v.email;
  const prop = mudou && !v.teste ? (antigo.whats ? propagar(antigo.whats, v) : propagar(null, v, antigo.nome)) : null;
  return { ok: true, vendedor: v, propagado: prop };
}
// une `idDe` em `idPara` (o que fica): o número do que sai vira "antigo" do que fica e é trocado em todas as cópias
function unir(idDe, idPara, usuario) {
  const de = obter(idDe), para = obter(idPara);
  if (!de || !para || de === para) return { erro: 'Escolha dois vendedores diferentes' };
  if (de.ativo === false || para.ativo === false) return { erro: 'Um dos dois já foi unido ou desativado' };
  if (!para.whats && de.whats) para.whats = de.whats;
  else if (de.whats && de.whats !== para.whats) para.antigos = [...new Set([...(para.antigos || []), de.whats, ...(de.antigos || [])])];
  if (!para.nome && de.nome) para.nome = de.nome; if (!para.email && de.email) para.email = de.email;
  if (!para.codFornec && de.codFornec) { para.codFornec = de.codFornec; para.empresa = de.empresa; }
  para.atualizadoEm = agora(); para.atualizadoPor = usuario || null;
  de.ativo = false; de.unidoEm = agora(); de.unidoCom = para.id; de.unidoPor = usuario || null;
  gravar();
  const prop = de.teste || para.teste ? null : (de.whats && de.whats !== para.whats ? propagar(de.whats, para) : (!de.whats ? propagar(null, para, de.nome) : null));
  log('unido', de.id, de.nome, de.whats, '->', para.id, para.nome, para.whats);
  return { ok: true, vendedor: para, saiu: { id: de.id, nome: de.nome, whats: de.whats }, propagado: prop };
}
// a cópia mudou por fora: o vendedor preencheu "Estamos atualizando nosso cadastro" na página da cotação / do pedido
// (server.js aplicarCadastroVendedor). O cadastro segue a cópia: número novo vira o atual (o antigo fica em `antigos`), e-mail
// novo entra, e as outras cópias são atualizadas. A conta do portal NÃO é re-chaveada (o login dele continua o número com que
// entrou; o casamento com cotações e pedidos passa por `antigos`). Número que já é de outro vendedor não é trocado.
function corrigirPorCopia(antes, depois, ctx) {
  const wA = normWhats(antes && antes.whats), wD = normWhats(depois && depois.whats), eD = normEmail(depois && depois.email);
  const v = (wA && porWhats(wA)) || (wD && porWhats(wD)) || null;
  if (!v) { const n = registrar({ nome: depois && depois.nome, whats: wD, email: eD, codFornec: ctx && ctx.codFornec, empresa: ctx && ctx.empresa }, 'cadastro do vendedor'); return n ? { novo: n.id } : null; }
  let mudou = false, numeroDe = null;
  if (wD && wD !== v.whats) {
    const outro = ativos().find(x => x.id !== v.id && (x.whats === wD || (x.antigos || []).includes(wD)));
    if (outro) { numeroDe = outro.id; log('número', wD, 'informado pelo vendedor já é de #' + outro.id, outro.nome, '- não trocado'); }
    else { if (v.whats) v.antigos = [...new Set([...(v.antigos || []), v.whats])]; v.antigos = (v.antigos || []).filter(a => a !== wD); v.whats = wD; mudou = true; }
  }
  if (eD && emailOk(eD) && eD !== v.email) { v.email = eD; mudou = true; }
  if (!mudou) return numeroDe ? { numero_de_outro: numeroDe } : null;
  v.atualizadoEm = agora(); v.atualizadoPor = 'vendedor (cadastro na cotação/pedido)'; gravar();
  const antigo = wA && wA !== v.whats ? wA : ((v.antigos || [])[v.antigos.length - 1] || v.whats);
  return { ok: true, propagado: propagar(antigo, v, antes && antes.nome, { semPortal: true }) };
}
function desativar(id, usuario, ligar) { const v = obter(id); if (!v) return { erro: 'Vendedor não encontrado' }; v.ativo = !!ligar; v.atualizadoEm = agora(); v.atualizadoPor = usuario || null; if (ligar) { delete v.unidoCom; delete v.unidoEm; } gravar(); return { ok: true, vendedor: v }; }

// exemplos de teste (regra da casa: tela nova entra com exemplos pra ajustar olhando) — ficam só nesta tela:
// não entram no portal, no "fora do portal" nem propagam pra lista nenhuma
function criarTestes(usuario) {
  const ex = [
    { nome: 'TESTE Vendedor Um', whats: '81900000001', email: 'teste1@exemplo.com', codFornec: 999001, empresa: 'FORNECEDOR TESTE UM LTDA' },
    { nome: 'TESTE Vendedora Dois', whats: '81900000002', email: 'teste2@exemplo.com', codFornec: 999002, empresa: 'FORNECEDOR TESTE DOIS S/A' },
    { nome: 'TESTE Vendedor Sem Número', whats: '', email: '', codFornec: 999002, empresa: 'FORNECEDOR TESTE DOIS S/A' },
    { nome: 'TESTE Vendedor Um (duplicado)', whats: '81900000011', email: '', codFornec: 999001, empresa: 'FORNECEDOR TESTE UM LTDA' }
  ];
  let n = 0;
  for (const x of ex) { if (ativos().some(v => v.teste && v.nome === x.nome)) continue; const v = { id: ++D.seq, nome: x.nome, whats: x.whats || null, email: x.email || null, codFornec: x.codFornec, empresa: x.empresa, ativo: true, antigos: [], teste: true, origem: 'exemplo', criadoEm: agora(), criadoPor: usuario || null, atualizadoEm: agora() }; D.itens[v.id] = v; n++; }
  if (n) gravar(); return { ok: true, criados: n };
}
function removerTestes() { let n = 0; for (const k of Object.keys(D.itens)) if (D.itens[k].teste) { delete D.itens[k]; n++; } if (n) gravar(); return { ok: true, removidos: n }; }

function resumo() { const vs = reais(); const contaDe = deps.portal && deps.portal.contaDe ? w => deps.portal.contaDe(w) : () => null; const comLogin = vs.filter(v => { const c = v.whats ? contaDe(v.whats) : null; return c && c.tem_pin; }).length; return { vendedores: vs.length, com_login: comLogin, sem_login: vs.length - comLogin, sem_whats: vs.filter(v => !v.whats).length, suspeitos: suspeitos().length, testes: ativos().filter(v => v.teste).length, inativos: Object.values(D.itens).filter(v => v.ativo === false).length }; }

function init(d) {
  deps = d || {}; fs.mkdirSync(DIR, { recursive: true }); carregar();
  const r = absorverTudo('subida');
  log('cadastro:', reais().length, 'vendedor(es),', r.novos, 'novo(s) absorvido(s) na subida');
  return { ...resumo(), absorvidos: r.novos };
}

// ── rotas (atrás do login do Econômico, como toda /api/ que não está na lista pública) ───────────────────────────
function registrarRotas(app) {
  const user = req => (req.session && req.session.user && req.session.user.nome) || null;
  const idDe = req => parseInt(req.params.id) || 0;
  const responder = (res, r) => { if (!r) return res.status(404).json({ error: 'Vendedor não encontrado' }); if (r.erro) return res.status(400).json({ error: r.erro, outro: r.outro || null }); res.json(r); };
  app.get('/api/vendedores', (req, res) => { try { res.set('Cache-Control', 'no-store'); res.json({ itens: listar(), suspeitos: suspeitos(), fornecedores: empresasConhecidas(), resumo: resumo() }); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores', (req, res) => { try { responder(res, criar(req.body || {}, user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/absorver', (req, res) => { try { res.json(absorverTudo('tela')); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/testes', (req, res) => { try { res.json(criarTestes(user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/testes/remover', (req, res) => { try { res.json(removerTestes()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/:id/unir', (req, res) => { try { responder(res, unir(idDe(req), parseInt(req.body && req.body.para) || 0, user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/:id/desativar', (req, res) => { try { responder(res, desativar(idDe(req), user(req), false)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/:id/reativar', (req, res) => { try { responder(res, desativar(idDe(req), user(req), true)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/:id', (req, res) => { try { responder(res, salvar(idDe(req), req.body || {}, user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
}

module.exports = { init, normWhats, obter, porWhats, listar, suspeitos, resumo, empresasConhecidas, absorver, registrar, registrarVarios, registrarLista, registrarCotacao, absorverTudo, criar, salvar, unir, desativar, corrigirPorCopia, propagar, criarTestes, removerTestes, registrarRotas };
