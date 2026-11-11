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
// 10/11/26 (Tiago): "Excluir" some de vez com o vendedor (cópias nas listas e conta do portal vão junto; cotações e pedidos são
// histórico e ficam) e deixa uma lápide pra ele não voltar na próxima subida; e o que os vendedores digitam em "Estamos atualizando
// nosso cadastro" vira uma fila de atualizações pendentes pra equipe levar pro ERP (ver blocos "lápide" e "atualizações").
// Persistência: data/vendedores/vendedores.json. NADA é escrito no ERP.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.env.VENDEDORES_DIR || path.join(__dirname, '..', 'data', 'vendedores');
const ARQ = path.join(DIR, 'vendedores.json');
let deps = {};        // { lerCotForn, gravarCotForn, cotacao, pedidosFornec, portal, log }
let D = null;         // { seq, itens: { [id]: { id, nome, whats, email, codFornec, empresa, ativo, antigos:[], teste, origem, criadoEm, atualizadoEm } },
                      //   excluidos: { [whats]: lápide }, excluidosNome: { ['nome|codFornec']: lápide }, excluidosLog: [últimos 50],   (10/11)
                      //   seqAtu, atualizacoes: [{ id, em, cotacao, pedido, lista, codFornec, fornecedor, vendedor, campos, tratadoEm, tratadoPor }] }
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

function carregar() {
  try { D = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { D = null; }
  if (!D || typeof D !== 'object' || !D.itens) D = { seq: 0, itens: {} };
  if (!(D.seq > 0)) D.seq = Object.keys(D.itens).reduce((m, k) => Math.max(m, +k || 0), 0);
  // arquivo de antes de 10/11 não tem lápide nem atualizações
  if (!D.excluidos || typeof D.excluidos !== 'object') D.excluidos = {}; if (!D.excluidosNome || typeof D.excluidosNome !== 'object') D.excluidosNome = {}; if (!Array.isArray(D.excluidosLog)) D.excluidosLog = [];
  if (!Array.isArray(D.atualizacoes)) D.atualizacoes = []; if (!(D.seqAtu > 0)) D.seqAtu = D.atualizacoes.reduce((m, a) => Math.max(m, +a.id || 0), 0);
}
function gravar() { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(D, null, 1)); }
const ativos = () => D ? Object.values(D.itens).filter(v => v.ativo !== false) : [];
const reais = () => ativos().filter(v => !v.teste);
function obter(id) { return D.itens[parseInt(id)] || null; }
// pelo número: o atual ou um número antigo (unido/corrigido) — assim cópia velha numa cotação fechada ainda acha a pessoa certa
function porWhats(w) { w = normWhats(w); if (!w) return null; const as = ativos(); return as.find(v => v.whats === w) || as.find(v => (v.antigos || []).includes(w)) || null; }
function porNomeEmpresa(nome, codFornec) { const k = chaveNome(nome); if (!k) return null; return ativos().find(v => !v.whats && chaveNome(v.nome) === k && (+v.codFornec || 0) === (+codFornec || 0)) || null; }

// ── lápide do vendedor excluído (Tiago, 10/11/26) ───────────────────────────────────────────────────────────────
// absorverTudo roda a cada subida (e a tela tem "Absorver") lendo listas, cotações, pedidos e contas do portal: sem isto, o vendedor
// que o Tiago excluiu voltaria no próximo restart a partir da cópia dele numa cotação ou pedido antigo (histórico, que não se apaga).
// D.excluidos[whats] (número atual e antigos) e D.excluidosNome['nome|codFornec'] (pra cópia sem número) guardam { id, nome, empresa,
// em, por }. absorver() pula quem está na lápide, a menos que a fonte seja mais nova que a exclusão (opts.criadoEm > em: cotação,
// pedido ou conta criados DEPOIS — então ele voltou de verdade) ou o caminho seja explícito (opts.explicito: criar() da tela,
// registrarLista — o(a) comprador(a) salvou a lista com ele — e registrar(x, 'portal') — login novo); esses dois casos APAGAM a
// lápide e seguem. Listas em absorverTudo não passam nada (excluir já tirou o vendedor delas; se voltou lá, foi pela tela, explícita).
// Qual data vale em cada fonte (revisão 10/11, achados 0 e 3):
//   · cotação: a do CONVITE daquele fornecedor (f.convidadoEm; cotação antiga sem o campo usa c.criadoEm) — convidar o vendedor de novo
//     numa cotação aberta criada antes da exclusão é ação explícita do(a) comprador(a) e traz ele de volta;
//   · pedido: NUNCA a do pedido. A cópia do vendedor no pedido é histórica — veio da cotação (criarPedidoDaCotacao copia f.vendedor) ou
//     de uma lista / pedido anterior (Radar, ruptura) — e o pedido nasce com criadoEm = agora mesmo quando a cotação é de antes da
//     exclusão: realizar um pedido da cotação aberta recriava o excluído no próximo restart e apagava a lápide. Pedido com cotação usa
//     o convidadoEm do fornecedor nela (ou c.criadoEm); pedido sem cotação não passa data nenhuma e a lápide segura;
//   · conta do portal: a.criadoEm (conta criada depois = login novo).
const chaveNomeCod = (nome, cod) => { const k = chaveNome(nome); return k ? k + '|' + (parseInt(cod) || 0) : ''; };
function lapideDe(w, nome, cod) { if (!D) return null; if (w) return D.excluidos[w] || null; const k = chaveNomeCod(nome, cod); return (k && D.excluidosNome[k]) || null; }
// está na lápide? (número / nome crus) — pro server.js aplicarCadastroVendedor não devolver a cópia de um excluído pra lista (revisão 10/11, achado 1)
function excluido(whats, nome, codFornec) { return lapideDe(normWhats(whats), normNome(nome), parseInt(codFornec) || 0); }
function depoisDaLapide(lap, criadoEm) { if (!lap || !criadoEm) return false; const a = new Date(criadoEm).getTime(), b = new Date(lap.em).getTime(); return a > 0 && b > 0 && a > b; }
// apaga a lápide da pessoa inteira (todas as chaves com o mesmo id: número atual, antigos e nome)
function apagarLapide(w, nome, cod) {
  if (!D) return 0; const ids = new Set();
  if (w && D.excluidos[w]) ids.add(D.excluidos[w].id);
  const k = chaveNomeCod(nome, cod); if (k && D.excluidosNome[k]) ids.add(D.excluidosNome[k].id);
  if (!ids.size) return 0; let n = 0;
  for (const m of [D.excluidos, D.excluidosNome]) for (const key of Object.keys(m)) if (m[key] && ids.has(m[key].id)) { delete m[key]; n++; }
  log('lápide apagada:', w || '', nome || '', '(' + n + ' chave(s))');
  return n;
}

// ── absorver: registra o que as listas / cotações / pedidos / portal conhecem e o cadastro ainda não ──────────────
// x = { nome, whats, email, codFornec, empresa }. Nunca sobrescreve: só preenche campo vazio do registro que já existe.
// opts: { criadoEm } da fonte (cotação / pedido / conta) ou { explicito: true } — ver a lápide acima.
function absorver(x, origem, opts) {
  opts = opts || {};
  if (!x || !D) return null;
  const w = normWhats(x.whats), nome = normNome(x.nome), email = normEmail(x.email), cod = parseInt(x.codFornec) || 0, emp = normEmpresa(x.empresa);
  if (!w && !nome) return null;
  const lap = lapideDe(w, nome, cod);
  if (lap) { if (opts.explicito || depoisDaLapide(lap, opts.criadoEm)) apagarLapide(w, nome, cod); else return null; }   // excluído não volta por cópia antiga
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
// registrar(x, 'portal') = conta nova / login no portal (lib/portal-fornecedor registrarNoCadastro): caminho explícito, apaga a lápide (10/11)
function registrar(x, origem, opts) { opts = Object.assign({}, opts || {}); if (origem === 'portal') opts.explicito = true; const r = absorver(x, origem, opts); if (r && r.novo) gravar(); return r ? r.v : null; }
function registrarVarios(xs, origem, opts) { let n = 0; for (const x of xs || []) { const r = absorver(x, origem, opts); if (r && r.novo) n++; } if (n) gravar(); return n; }
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
      if (rec) { const r = corrigirPorCopia({ nome: rec.nome, whats: rec.whats, email: rec.email }, { nome, whats: w, email }, { codFornec, empresa }, { explicito: true }); if (r && r.ok) corrigidos++; continue; }   // explícito: número que estava na lápide de um excluído passa a ser deste vendedor (revisão 10/11)
    }
    const r = absorver({ nome, whats: w, email, codFornec, empresa }, 'lista ' + lista, { explicito: true }); if (r && r.novo) novos++;   // o(a) comprador(a) salvou a lista com ele: apaga a lápide (10/11)
  }
  if (novos) gravar();
  if (devolvidos && deps.lerCotForn && deps.gravarCotForn) { try { const todos = deps.lerCotForn(); todos[lista] = cad; deps.gravarCotForn(todos); } catch (e) { log('devolver número atual à lista', lista, e.message); } }
  if (novos || corrigidos || devolvidos) log('lista', lista, '->', novos, 'novo(s),', corrigidos, 'corrigido(s),', devolvidos, 'cópia(s) devolvida(s) ao número atual');
  return { novos, corrigidos, devolvidos };
}
// cotação: cada fornecedor passa a data do PRÓPRIO convite (f.convidadoEm; cotação antiga sem o campo usa c.criadoEm) — convite feito
// depois da exclusão traz o vendedor de volta, mesmo numa cotação criada antes dela (revisão 10/11, achado 3; ver lápide)
function absorverCotacao(c, conta) { for (const f of c.fornecedores || []) for (const x of [f.vendedor].concat(f.vendedores || [])) if (x) conta(absorver({ ...x, codFornec: f.codFornecErp || f.codFornec, empresa: f.empresa || f.nome }, 'cotação ' + c.id, { criadoEm: f.convidadoEm || c.criadoEm })); }
function registrarCotacao(c) { if (!c || c.teste) return 0; let n = 0; absorverCotacao(c, r => { if (r && r.novo) n++; }); if (n) gravar(); return n; }
// pedido nunca é fonte nova de vendedor (revisão 10/11, achado 0; ver lápide): a data da cópia é a do convite do fornecedor na cotação de
// origem (ou c.criadoEm); pedido sem cotação (Radar, ruptura) não passa data — a cópia veio de uma lista / pedido anterior, que já passaram aqui
function dataDaCopiaDoPedido(p, cotPorId) {
  const cid = p.cotacao && p.cotacao.id; if (!cid) return undefined;
  let c = (cotPorId && cotPorId.get(String(cid))) || null;
  if (!c && deps.cotacao && typeof deps.cotacao.obter === 'function') { try { c = deps.cotacao.obter(cid); } catch (e) { c = null; } }
  if (!c) return undefined;
  const w = normWhats(p.vendedor.whats), k = chaveNome(p.vendedor.nome);
  const f = (c.fornecedores || []).find(f => [f.vendedor].concat(f.vendedores || []).some(x => x && (w ? normWhats(x.whats) === w : (!normWhats(x.whats) && !!k && chaveNome(x.nome) === k))));
  return (f && f.convidadoEm) || c.criadoEm || undefined;
}
// cada fonte passa quando foi criada (cotação / pedido / conta): excluído só volta por fonte criada DEPOIS da exclusão — ver lápide
function absorverTudo(origem) {
  let novos = 0; const conta = r => { if (r && r.novo) novos++; };
  let cots = []; try { cots = deps.cotacao ? deps.cotacao.listar() : []; } catch (e) { log('absorver cotações:', e.message); }
  try { const todos = deps.lerCotForn ? deps.lerCotForn() : {}; for (const [lista, arr] of Object.entries(todos || {})) { if (!Array.isArray(arr)) continue; for (const cad of arr) for (const x of [cad.vendedor].concat(cad.vendedores || [])) if (x) conta(absorver({ ...x, codFornec: cad.codFornec, empresa: cad.nome }, 'lista ' + lista)); } } catch (e) { log('absorver listas:', e.message); }
  try { for (const c of cots) { if (c.teste) continue; absorverCotacao(c, conta); } } catch (e) { log('absorver cotações:', e.message); }
  try { const porId = new Map(cots.map(c => [String(c.id), c])); for (const p of (deps.pedidosFornec ? deps.pedidosFornec.listar() : [])) { if (p.teste || !p.vendedor) continue; conta(absorver({ ...p.vendedor, codFornec: p.codFornec, empresa: p.fornecedor }, 'pedido ' + p.id, { criadoEm: dataDaCopiaDoPedido(p, porId) })); } } catch (e) { log('absorver pedidos:', e.message); }
  try { for (const a of (deps.portal && deps.portal.contas ? deps.portal.contas() : [])) { if (a.teste) continue; const e = (a.empresas || [])[0] || {}; conta(absorver({ nome: a.nome, whats: a.whats, email: a.email, codFornec: e.codFornec, empresa: e.nome }, 'portal', { criadoEm: a.criadoEm })); } } catch (e) { log('absorver portal:', e.message); }
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
  apagarLapide(r.w, r.nome, r.cod);   // excluído e criado de novo na tela: caminho explícito, ele volta (10/11)
  const v = { id: ++D.seq, nome: r.nome, whats: r.w || null, email: r.email, codFornec: r.cod, empresa: r.emp, ativo: true, antigos: [], origem: 'tela', criadoEm: agora(), criadoPor: usuario || null, atualizadoEm: agora() };
  D.itens[v.id] = v; gravar(); return { ok: true, vendedor: v };
}
function salvar(id, dados, usuario) {
  const v = obter(id); if (!v) return { erro: 'Vendedor não encontrado' };
  const r = validar(dados || {}, v.id); if (r.erro) return r;
  const antigo = { nome: v.nome, whats: v.whats, email: v.email };
  if (v.whats && r.w && v.whats !== r.w) v.antigos = [...new Set([...(v.antigos || []), v.whats])];
  if (r.w) v.antigos = (v.antigos || []).filter(a => a !== r.w);
  if (r.w && r.w !== v.whats) apagarLapide(r.w);   // número que era de um excluído passa a ser deste vendedor (10/11)
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
// Número que está na lápide de um EXCLUÍDO também não (revisão 10/11, achado 1): ficaria uma chave de lápide apontando pra registro
// ativo e absorver() negaria a própria pessoa; a troca é ignorada (a fila mostra pra equipe decidir), e-mail e nome seguem. Só o caminho
// explícito aceita (opts.explicito — registrarLista: o(a) comprador(a) salvou a lista assim): aí a lápide some e o número passa a ser dele.
function corrigirPorCopia(antes, depois, ctx, opts) {
  opts = opts || {};
  const wA = normWhats(antes && antes.whats), wD = normWhats(depois && depois.whats), eD = normEmail(depois && depois.email);
  const v = (wA && porWhats(wA)) || (wD && porWhats(wD)) || null;
  if (!v) { const n = registrar({ nome: depois && depois.nome, whats: wD, email: eD, codFornec: ctx && ctx.codFornec, empresa: ctx && ctx.empresa }, 'cadastro do vendedor', opts.explicito ? { explicito: true } : undefined); return n ? { novo: n.id } : null; }
  let mudou = false, numeroDe = null, numeroExcluido = null;
  if (wD && wD !== v.whats) {
    const outro = ativos().find(x => x.id !== v.id && (x.whats === wD || (x.antigos || []).includes(wD)));
    const lap = outro ? null : lapideDe(wD);
    if (outro) { numeroDe = outro.id; log('número', wD, 'informado pelo vendedor já é de #' + outro.id, outro.nome, '- não trocado'); }
    else if (lap && !opts.explicito) { numeroExcluido = lap.id; log('número', wD, 'informado pelo vendedor é de um excluído (#' + lap.id, lap.nome, ') - não trocado'); }
    else { if (lap) apagarLapide(wD); if (v.whats) v.antigos = [...new Set([...(v.antigos || []), v.whats])]; v.antigos = (v.antigos || []).filter(a => a !== wD); v.whats = wD; mudou = true; }
  }
  if (eD && emailOk(eD) && eD !== v.email) { v.email = eD; mudou = true; }
  if (!mudou) return numeroDe ? { numero_de_outro: numeroDe } : (numeroExcluido ? { numero_de_excluido: numeroExcluido } : null);
  v.atualizadoEm = agora(); v.atualizadoPor = 'vendedor (cadastro na cotação/pedido)'; gravar();
  const antigo = wA && wA !== v.whats ? wA : ((v.antigos || [])[v.antigos.length - 1] || v.whats);
  return { ok: true, propagado: propagar(antigo, v, antes && antes.nome, { semPortal: true }), ...(numeroExcluido ? { numero_de_excluido: numeroExcluido } : {}), ...(numeroDe ? { numero_de_outro: numeroDe } : {}) };   // número recusado sai também quando o e-mail mudou (server.js desfaz na lista; revisão 3, 10/11)
}
function desativar(id, usuario, ligar) { const v = obter(id); if (!v) return { erro: 'Vendedor não encontrado' }; v.ativo = !!ligar; v.atualizadoEm = agora(); v.atualizadoPor = usuario || null; if (ligar) { delete v.unidoCom; delete v.unidoEm; } gravar(); return { ok: true, vendedor: v }; }

// ── excluir (Tiago, 10/11/26: "aqui tem que ter pra excluir" — nos possíveis duplicados, na tabela do cadastro e no "fora do portal")
// Some de vez do cadastro (não é ativo=false): tira as cópias dele de TODO cadastro de lista (casa pelo número atual ou antigo; cópia
// sem número casa por nome + empresa) e apaga a conta do portal (PIN, sessão, aparelhos — lib/portal-fornecedor apagarConta). Cotações
// e pedidos NÃO mudam: são histórico, e o link de uma cotação aberta continua valendo — a resposta diz em quais ele ainda aparece
// (cotacoes_abertas) e em quais pedidos ainda à espera dele (pedidos_abertos: aguardando / digitação — revisão 10/11, achado 1) pra tela
// avisar. Fica a lápide (ver absorver) pra ele não voltar na próxima subida a partir dessas cópias antigas.
// Número que outro registro ativo ainda reclama (registro que foi unido: o sobrevivente tem o número em `antigos`) não entra em nada
// disso — senão apagaria a conta e as cópias da pessoa certa.
function excluir(id, usuario) {
  const v = obter(id); if (!v) return { erro: 'Vendedor não encontrado' };
  const removido = { id: v.id, nome: v.nome, whats: v.whats, empresa: v.empresa, codFornec: v.codFornec || null };
  const out = { ok: true, removido, listas: 0, listas_ids: [], conta_portal: null, cotacoes_abertas: [], pedidos_abertos: [] };
  if (v.teste) { delete D.itens[v.id]; gravar(); return { ...out, teste: true }; }   // exemplo de teste: só apaga
  const reclamado = w => ativos().some(o => o.id !== v.id && (o.whats === w || (o.antigos || []).includes(w)));
  const chaves = [v.whats].concat(v.antigos || []).filter(w => w && !reclamado(w));
  const kNome = chaveNomeCod(v.nome, v.codFornec);
  const casa = (x, cod) => { if (!x) return false; const w = normWhats(x.whats); if (w) return chaves.includes(w); return !!kNome && chaveNomeCod(x.nome, cod) === kNome; };
  // conta do portal ANTES de apagar o registro: apagarConta acha a conta pelo cadastro (número atual ou antigo)
  if (v.whats && !reclamado(v.whats) && deps.portal && typeof deps.portal.apagarConta === 'function') {
    try { const r = deps.portal.apagarConta(v.whats); out.conta_portal = !!(r && r.apagada); if (r && Array.isArray(r.mantidas) && r.mantidas.length) out.conta_portal_mantidas = r.mantidas; } catch (e) { log('excluir: conta do portal', e.message); out.conta_portal = null; }   // mantidas: conta num número antigo que parece ser de outra pessoa (revisão 3, 10/11)
  }
  try {   // listas: cópia principal removida é substituída pelo 1º dos outros vendedores do fornecedor; sem outro, fica vazia (nunca undefined:
    const todos = deps.lerCotForn ? deps.lerCotForn() : {}; let n = 0;   // o server.js e as telas assumem objeto, igual à lista salva sem vendedor)
    for (const [lista, arr] of Object.entries(todos || {})) {
      if (!Array.isArray(arr)) continue; let nl = 0;
      for (const cad of arr) {
        if (Array.isArray(cad.vendedores)) { const antes = cad.vendedores.length; cad.vendedores = cad.vendedores.filter(x => !casa(x, cad.codFornec)); nl += antes - cad.vendedores.length; }
        if (casa(cad.vendedor, cad.codFornec)) { nl++; cad.vendedor = (cad.vendedores || []).length ? cad.vendedores.shift() : { nome: '', whats: '', email: '' }; }
      }
      if (nl) { n += nl; out.listas_ids.push(parseInt(lista) || lista); }
    }
    if (n && deps.gravarCotForn) deps.gravarCotForn(todos); out.listas = n;
  } catch (e) { log('excluir: listas', e.message); }
  try { for (const c of (deps.cotacao ? deps.cotacao.listar() : [])) { if (c.teste || c.status !== 'aberta') continue; if ((c.fornecedores || []).some(f => [f.vendedor].concat(f.vendedores || []).some(x => casa(x, f.codFornecErp || f.codFornec)))) out.cotacoes_abertas.push({ id: c.id, nome: c.nome }); } } catch (e) { log('excluir: cotações', e.message); }
  // pedidos ainda à espera dele (o link do pedido também continua valendo): aguardando / em digitação com a cópia dele como vendedor
  try { for (const p of (deps.pedidosFornec ? deps.pedidosFornec.listar() : [])) { if (p.teste || !['aguardando', 'digitacao'].includes(p.status) || !casa(p.vendedor, p.codFornec)) continue; out.pedidos_abertos.push({ id: p.id, fornecedor: p.fornecedor || null }); } } catch (e) { log('excluir: pedidos', e.message); }
  const em = agora(), lap = { id: v.id, nome: v.nome, empresa: v.empresa, em, por: usuario || null };
  for (const w of chaves) D.excluidos[w] = { ...lap };
  if (kNome) D.excluidosNome[kNome] = { ...lap };   // cópia antiga sem número com o mesmo nome na mesma empresa também não recria
  D.excluidosLog.unshift({ id: v.id, nome: v.nome, whats: v.whats, empresa: v.empresa, em, por: usuario || null }); D.excluidosLog = D.excluidosLog.slice(0, 50);
  delete D.itens[v.id]; gravar();
  log('excluído', v.id, v.nome, v.whats || '(sem número)', 'por', usuario || '?', JSON.stringify({ listas: out.listas, conta_portal: out.conta_portal, cotacoes_abertas: out.cotacoes_abertas.map(c => c.id), pedidos_abertos: out.pedidos_abertos.map(p => p.id) }));
  return out;
}

// ── atualizações de cadastro digitadas pelos vendedores (Tiago, 10/11/26: "essas atualizações de cadastro que vendedores coloca
// já tem que chegar pra gente atualizar") ─────────────────────────────────────────────────────────────────────────
// O bloco "Estamos atualizando nosso cadastro de fornecedor" da página da cotação / do pedido já ia direto pro cadastro da lista
// (server.js aplicarCadastroVendedor) e pro cadastro único (corrigirPorCopia), em silêncio: ninguém da equipe via, então ninguém
// levava pro ERP (o sistema nunca escreve no ERP). Agora cada mudança vira um registro aqui, pendente até alguém da equipe marcar
// "tratado" na tela Vendedores. Fusão: o vendedor salva várias vezes enquanto digita (e-mail em partes) — pendente da mesma cotação +
// fornecedor + vendedor com menos de 30 min funde: "de" fica o original, "para" vira o último, campo novo entra; campo que voltou ao
// valor original sai (e se não sobrar nada, o registro some). Depois de tratado não funde mais: mudança nova é registro novo.
// Sem ruído (revisão 10/11, achado 2): a página do vendedor vem pré-preenchida com a proposta anterior e o Enviar manda o bloco inteiro
// mesmo sem ele digitar nada — a mesma informação voltava como pendência "— → valor" em cada lista nova. Campo cujo mesmo valor novo já
// está pendente ou foi conferido há menos de 30 dias pra mesma pessoa (número; sem número, nome + empresa) não entra de novo.
const ATU_MAX = 500, ATU_FUSAO_MS = 30 * 60 * 1000, ATU_SABIDO_MS = 30 * 24 * 60 * 60 * 1000;
const chaveAtu = a => String((a.cotacao && a.cotacao.id) || (a.pedido && a.pedido.id ? 'pedido ' + a.pedido.id : '')) + '|' + (parseInt(a.codFornec) || 0);
// números que identificam o vendedor no registro: o atual e, se ele trocou o WhatsApp, o de antes e o de depois — assim o salvamento
// seguinte (que já chega com o número novo) ainda funde com o registro da troca
const numerosAtu = a => { const s = new Set(); const add = w => { w = normWhats(w); if (w) s.add(w); }; add(a.vendedor && a.vendedor.whats); for (const c of a.campos || []) if (c.campo === 'whats') { add(c.de); add(c.para); } return s; };
const mesmoVendedorAtu = (a, b) => { const na = numerosAtu(a), nb = numerosAtu(b); if (na.size && nb.size) return [...na].some(w => nb.has(w)); return !na.size && !nb.size && chaveNome(a.vendedor && a.vendedor.nome) === chaveNome(b.vendedor && b.vendedor.nome); };
// mesma pessoa entre registros de cotações / fornecedores diferentes (pra "já sabida"): número em comum; sem número dos dois lados, nome + empresa
const mesmaPessoaAtu = (a, b) => { const na = numerosAtu(a), nb = numerosAtu(b); if (na.size && nb.size) return [...na].some(w => nb.has(w)); if (na.size || nb.size) return false; const k = chaveNome(a.vendedor && a.vendedor.nome); return !!k && k === chaveNome(b.vendedor && b.vendedor.nome) && (parseInt(a.codFornec) || 0) === (parseInt(b.codFornec) || 0); };
const mesmoValor = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
const pendentes = () => (D.atualizacoes || []).filter(a => !a.tratadoEm);
// x = { cotacao: { id, nome } | null, pedido: { id } | null, lista, codFornec, fornecedor, vendedor: { nome, whats }, campos: [{ campo, rotulo, de, para }] }
function registrarAtualizacao(x) {
  if (!D || !x) return null;
  const campos = (x.campos || []).filter(c => c && c.campo && !mesmoValor(c.de, c.para)).map(c => ({ campo: String(c.campo), rotulo: String(c.rotulo || c.campo), de: c.de == null || c.de === '' ? null : c.de, para: c.para == null || c.para === '' ? null : c.para }));
  if (!campos.length) return null;
  const em = agora();
  const novo = { id: 0, em, cotacao: x.cotacao && x.cotacao.id ? { id: x.cotacao.id, nome: x.cotacao.nome || null } : null, pedido: x.pedido && x.pedido.id ? { id: x.pedido.id } : null, lista: x.lista || null, codFornec: parseInt(x.codFornec) || null, fornecedor: x.fornecedor || null, vendedor: { nome: normNome(x.vendedor && x.vendedor.nome) || null, whats: normWhats(x.vendedor && x.vendedor.whats) || null }, campos, tratadoEm: null, tratadoPor: null };
  const k = chaveAtu(novo), pend = pendentes().find(a => chaveAtu(a) === k && mesmoVendedorAtu(a, novo) && Date.now() - new Date(a.em).getTime() < ATU_FUSAO_MS);
  // já sabida (ver ATU_SABIDO_MS): o ÚLTIMO valor conhecido desse campo pra essa pessoa (registro mais recente, pendente ou conferido há
  // menos de 30 dias) já é o valor novo. Comparar com o último, não com qualquer valor dos 30 dias: typo enviado na #12 e corrigido na #13
  // pro valor da #11 tem que virar pendência (revisão 3, 10/11). Condição / prazo de entrega / mínimo são do FORNECEDOR: só contam no
  // mesmo codFornec (o mesmo vendedor pode vender por duas empresas). Campo apagado (para vazio) nunca é "sabido". O registro em fusão
  // fica de fora da conferência e campo que JÁ está nele nunca é descartado: é a mesma digitação, e campo que voltou ao original precisa
  // chegar nele pra sair (desfaz a pendência)
  const doFornecedor = { condicao: 1, prazo_entrega: 1, faturamento_minimo: 1 };
  const ultimoValor = c => { let m = null; for (const a of D.atualizacoes || []) { if (a === pend || !mesmaPessoaAtu(a, novo)) continue; if (a.tratadoEm && Date.now() - new Date(a.tratadoEm).getTime() >= ATU_SABIDO_MS) continue; if (doFornecedor[c.campo] && (parseInt(a.codFornec) || 0) !== (parseInt(novo.codFornec) || 0)) continue; const y = (a.campos || []).find(z => z.campo === c.campo); if (!y) continue; if (!m || String(a.em || '') > String(m.em || '')) m = { em: a.em, para: y.para }; } return m; };
  const sabida = c => { if (c.para == null) return false; if (pend && (pend.campos || []).some(y => y.campo === c.campo)) return false; const u = ultimoValor(c); return !!u && mesmoValor(u.para, c.para); };
  const vivos = campos.filter(c => !sabida(c)); if (!vivos.length) return null; novo.campos = vivos;
  if (pend) {
    for (const c of vivos) { const j = pend.campos.find(y => y.campo === c.campo); if (j) j.para = c.para; else pend.campos.push(c); }
    pend.campos = pend.campos.filter(c => !mesmoValor(c.de, c.para)); pend.em = em; pend.fusoes = (pend.fusoes || 0) + 1;
    pend.vendedor = { nome: novo.vendedor.nome || pend.vendedor.nome, whats: novo.vendedor.whats || pend.vendedor.whats };   // o número atual dele
    if (!pend.campos.length) { D.atualizacoes = D.atualizacoes.filter(a => a !== pend); gravar(); return { ok: true, atualizacao: null, desfeita: true }; }
    gravar(); return { ok: true, atualizacao: pend, fundida: true };
  }
  novo.id = ++D.seqAtu; D.atualizacoes.unshift(novo);
  if (D.atualizacoes.length > ATU_MAX) D.atualizacoes = D.atualizacoes.slice(0, ATU_MAX);   // mais novas primeiro; as 500 últimas
  gravar(); return { ok: true, atualizacao: novo, fundida: false };
}
function listarAtualizacoes() {
  const desc = campo => (a, b) => String(b[campo] || '').localeCompare(String(a[campo] || ''));
  return { pendentes: pendentes().sort(desc('em')), tratadas: (D.atualizacoes || []).filter(a => a.tratadoEm).sort(desc('tratadoEm')).slice(0, 50) };
}
function tratarAtualizacao(id, usuario) {
  const a = (D.atualizacoes || []).find(x => x.id === (parseInt(id) || 0)); if (!a) return { erro: 'Atualização não encontrada' };
  if (a.tratadoEm) return { ok: true, atualizacao: a, ja_tratada: true };   // clique duplo / 2ª aba
  a.tratadoEm = agora(); a.tratadoPor = usuario || null; gravar();
  return { ok: true, atualizacao: a };
}

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

function resumo() {
  const vs = reais(); const contaDe = deps.portal && deps.portal.contaDe ? w => deps.portal.contaDe(w) : () => null; const comLogin = vs.filter(v => { const c = v.whats ? contaDe(v.whats) : null; return c && c.tem_pin; }).length;
  const excluidos = new Set([...Object.values(D.excluidos || {}), ...Object.values(D.excluidosNome || {})].map(l => l && l.id)).size;   // pessoas na lápide (uma pode ter várias chaves)
  return { vendedores: vs.length, com_login: comLogin, sem_login: vs.length - comLogin, sem_whats: vs.filter(v => !v.whats).length, suspeitos: suspeitos().length, testes: ativos().filter(v => v.teste).length, inativos: Object.values(D.itens).filter(v => v.ativo === false).length, excluidos, atualizacoes_pendentes: pendentes().length };
}

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
  // atualizações de cadastro (10/11) — ANTES de qualquer rota '/api/vendedores/:id...', senão ':id' captura "atualizacoes"
  app.get('/api/vendedores/atualizacoes', (req, res) => { try { res.set('Cache-Control', 'no-store'); res.json(listarAtualizacoes()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/atualizacoes/:id/tratar', (req, res) => { try { responder(res, tratarAtualizacao(idDe(req), user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores', (req, res) => { try { responder(res, criar(req.body || {}, user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/absorver', (req, res) => { try { res.json(absorverTudo('tela')); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/testes', (req, res) => { try { res.json(criarTestes(user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/testes/remover', (req, res) => { try { res.json(removerTestes()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/:id/unir', (req, res) => { try { responder(res, unir(idDe(req), parseInt(req.body && req.body.para) || 0, user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/:id/desativar', (req, res) => { try { responder(res, desativar(idDe(req), user(req), false)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/:id/reativar', (req, res) => { try { responder(res, desativar(idDe(req), user(req), true)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/vendedores/:id/excluir', (req, res) => { try { responder(res, excluir(idDe(req), user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });   // 10/11; antes de '/:id'
  app.post('/api/vendedores/:id', (req, res) => { try { responder(res, salvar(idDe(req), req.body || {}, user(req))); } catch (e) { res.status(500).json({ error: e.message }); } });
}

module.exports = { init, normWhats, obter, porWhats, excluido, listar, suspeitos, resumo, empresasConhecidas, absorver, registrar, registrarVarios, registrarLista, registrarCotacao, absorverTudo, criar, salvar, unir, desativar, excluir, corrigirPorCopia, propagar, registrarAtualizacao, listarAtualizacoes, tratarAtualizacao, criarTestes, removerTestes, registrarRotas };
