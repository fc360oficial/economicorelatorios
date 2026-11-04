// Integração com a API oficial do Itaú (Conta Corrente | Extrato), via
// certificado mTLS dinâmico — caminho direto com o banco, sem Open
// Finance/agregador (ver docs enviados pela implantação técnica do Itaú).
//
// Arquivos sensíveis (certificado .pfx por conta + config.json com
// client_id/secret por conta) NUNCA ficam no git — vivem em data/itau/,
// gitignored, copiados manualmente pro servidor. Ver
// data/itau/config.exemplo.json pro formato esperado (múltiplas contas,
// uma chave por loja — ex: "cahu", "muribeca").
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ITAU_DIR = path.join(__dirname, '..', 'data', 'itau');
const CONFIG_PATH = path.join(ITAU_DIR, 'config.json');

function carregarConfig(conta) {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config não encontrada em ${CONFIG_PATH} — copie os certificados .pfx e crie config.json (ver config.exemplo.json).`);
  }
  const todas = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = todas[conta];
  if (!cfg) throw new Error(`Conta "${conta}" não encontrada em ${CONFIG_PATH}. Contas configuradas: ${Object.keys(todas).join(', ') || '(nenhuma)'}`);
  return cfg;
}

function carregarPfx(cfg) {
  return fs.readFileSync(path.join(ITAU_DIR, cfg.pfxFile));
}

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// access_token dura só 5 minutos — sempre gera um novo na hora de usar,
// não vale a pena cachear.
async function gerarAccessToken(conta) {
  const cfg = carregarConfig(conta);
  const pfx = carregarPfx(cfg);
  const bodyStr = `grant_type=client_credentials&client_id=${cfg.clientId}&client_secret=${cfg.clientSecret}`;
  const { status, body } = await requestJson({
    hostname: 'sts.itau.com.br', port: 443, path: '/api/oauth/token', method: 'POST',
    pfx, passphrase: cfg.pfxPassphrase,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bodyStr) }
  }, bodyStr);
  if (status !== 200) throw new Error(`Erro ao gerar access token da conta "${conta}" (${status}): ${JSON.stringify(body)}`);
  return body.access_token;
}

// dataInicio/dataFim no formato YYYY-MM-DD.
//
// 04/11/2026 (autorizado pela Coordenação): a API devolve no máximo `page_size` (8.000) eventos por página e, em 40 dias, quatro
// das seis contas já passam disso — a versão antiga lia SÓ a página 1 e perdia lançamentos sem aviso. Agora, sem `pagina`
// explícita, lê todas as páginas (até MAX_PAGINAS), junta os eventos em data[0].events, remove duplicados pelo id do evento,
// repete uma página que falhar (2 tentativas) e grava um registro em data/itau/sync.jsonl. Passar `pagina` mantém o
// comportamento de UMA página (scripts de diagnóstico). O formato da resposta é o mesmo: quem chama não muda.
const MAX_PAGINAS = 40;
const PAUSA_ENTRE_PAGINAS_MS = 150;
const SYNC_LOG = path.join(ITAU_DIR, 'sync.jsonl');
const dormir = ms => new Promise(r => setTimeout(r, ms));
function registrarSync(linha) { try { fs.appendFileSync(SYNC_LOG, JSON.stringify({ em: new Date().toISOString(), ...linha }) + '\n'); } catch (e) {} }
async function buscarPagina({ conta, cfg, pfx, accessToken, dataInicio, dataFim, pagina, tamanhoPagina }) {
  const contaPath = `${cfg.agencia}00${cfg.conta}${cfg.dac}`;
  const qs = `type=current_account&start_date=${dataInicio}&end_date=${dataFim}&page_size=${tamanhoPagina}&page=${pagina}`;
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const { status, body } = await requestJson({
        hostname: 'account-statement.api.itau.com', port: 443,
        path: `/account-statement/v1/statements/${contaPath}?${qs}`, method: 'GET',
        pfx, passphrase: cfg.pfxPassphrase,
        headers: { 'Authorization': `Bearer ${accessToken}`, 'x-itau-correlationid': crypto.randomUUID() }
      });
      if (status === 200) return body;
      ultimoErro = new Error(`Erro ao buscar extrato da conta "${conta}" (${status}): ${JSON.stringify(body)}`);
      if (status >= 400 && status < 500 && status !== 429) throw ultimoErro;   // erro de pedido: repetir não ajuda
    } catch (e) { ultimoErro = e; }
    if (tentativa < 3) await dormir(500 * tentativa);
  }
  throw ultimoErro;
}
async function buscarExtrato({ conta, dataInicio, dataFim, pagina, tamanhoPagina = 8000 }) {
  const cfg = carregarConfig(conta);
  const pfx = carregarPfx(cfg);
  const accessToken = await gerarAccessToken(conta);   // vale 5 min: serve pra todas as páginas desta chamada
  const base = { conta, cfg, pfx, accessToken, dataInicio, dataFim, tamanhoPagina };
  if (pagina) return buscarPagina({ ...base, pagina });
  const t0 = Date.now();
  let body;
  try {
    body = await buscarPagina({ ...base, pagina: 1 });
    const totalPaginas = Math.max(1, Number(body.pagination && body.pagination.total_pages) || 1);
    const destino = Array.isArray(body.data) && body.data[0] ? body.data[0] : null;
    let lidas = 1, duplicados = 0;
    if (totalPaginas > 1 && destino) {
      destino.events = destino.events || [];
      const vistos = new Set(destino.events.map(e => e.id).filter(Boolean));
      for (let p = 2; p <= Math.min(totalPaginas, MAX_PAGINAS); p++) {
        await dormir(PAUSA_ENTRE_PAGINAS_MS);
        const pb = await buscarPagina({ ...base, pagina: p }); lidas++;
        for (const ev of (pb.data || []).flatMap(d => d.events || [])) {
          if (ev.id) { if (vistos.has(ev.id)) { duplicados++; continue; } vistos.add(ev.id); }
          destino.events.push(ev);
        }
      }
      if (totalPaginas > MAX_PAGINAS) console.warn(`[itau] conta ${conta}: ${totalPaginas} páginas, lidas só ${MAX_PAGINAS} — reduza o período`);
    }
    const eventos = (body.data || []).reduce((a, d) => a + ((d.events || []).length), 0);
    body.pagination = { ...(body.pagination || {}), paginas_lidas: lidas, eventos_total: eventos, duplicados_removidos: duplicados, completo: totalPaginas <= MAX_PAGINAS };
    registrarSync({ conta, de: dataInicio, ate: dataFim, paginas: totalPaginas, lidas, eventos, duplicados, ms: Date.now() - t0 });
    return body;
  } catch (e) { registrarSync({ conta, de: dataInicio, ate: dataFim, erro: String(e.message).slice(0, 200), ms: Date.now() - t0 }); throw e; }
}

function contasConfiguradas() {
  if (!fs.existsSync(CONFIG_PATH)) return [];
  return Object.keys(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
}

// ── Saldo da conta (Tiago, 07/10/26) ─────────────────────────────────
// A própria resposta do extrato traz o saldo em data[0].balances: saldo_disponivel ("SALDO EM CONTA"), saldo_total,
// saldo_bloqueado e saldo_aplic_aut, cada um com amount.value (pode ser negativo) e date.event (posição em tempo real).
// Não existe API nem escopo novo. Pra só pegar o saldo, pede 1 lançamento de hoje (page_size=1).
const hojeLocal = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function extrairSaldo(body, conta) {
  const d = Array.isArray(body && body.data) ? body.data[0] : (body && body.data) || body;
  const bal = d && Array.isArray(d.balances) ? d.balances : [];
  const tipo = b => String(b.type || b.balance_type || b.balanceType || b.code || b.name || b.description || '').toLowerCase();
  const val = b => { if (!b) return null; const v = b.amount != null && typeof b.amount === 'object' ? b.amount.value : (b.amount != null ? b.amount : b.value); const n = typeof v === 'string' ? (v.includes(',') ? parseFloat(v.replace(/\./g, '').replace(',', '.')) : parseFloat(v)) : Number(v); return isFinite(n) ? n : null; };
  const dt = b => (b && b.date && typeof b.date === 'object' && (b.date.event || b.date.value || b.date.date)) || (b && (b.event_date || b.eventDate)) || (b && typeof b.date === 'string' ? b.date : null) || null;
  const acha = re => bal.find(b => re.test(tipo(b)));
  const disp = acha(/dispon|em conta/), tot = acha(/total/), blq = acha(/bloq/), apl = acha(/aplic/);
  if (!disp && !tot) throw new Error('Resposta do extrato sem balances (saldo) pra conta "' + conta + '"' + (bal.length ? ': tipos ' + bal.map(tipo).join(', ') : ''));
  const vd = val(disp);
  return { conta, disponivel: vd != null ? vd : val(tot), total: val(tot), bloqueado: val(blq) || 0, aplicacaoAutomatica: val(apl) || 0, atualizadoEm: dt(disp || tot) || new Date().toISOString() };
}
async function buscarSaldo(conta) {
  const hoje = hojeLocal();
  // pagina: 1 explícita — o saldo vem no cabeçalho da 1ª página; sem isso a paginação nova varreria o dia inteiro de 1 em 1 evento
  return extrairSaldo(await buscarExtrato({ conta, dataInicio: hoje, dataFim: hoje, pagina: 1, tamanhoPagina: 1 }), conta);
}
// as 6 contas em paralelo; conta que falha volta { conta, erro } sem derrubar as outras
async function buscarSaldos(contas) {
  const lista = Array.isArray(contas) && contas.length ? contas : contasConfiguradas();
  const rs = await Promise.allSettled(lista.map(c => buscarSaldo(c)));
  return rs.map((r, i) => r.status === 'fulfilled' ? r.value : { conta: lista[i], erro: String((r.reason && r.reason.message) || r.reason) });
}

module.exports = { gerarAccessToken, buscarExtrato, contasConfiguradas, buscarSaldo, buscarSaldos, extrairSaldo };
