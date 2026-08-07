// Integração com a API oficial do Itaú (Conta Corrente | Extrato), via
// certificado mTLS dinâmico — caminho direto com o banco, sem Open
// Finance/agregador (ver docs enviados pela implantação técnica do Itaú).
//
// Arquivos sensíveis (certificado.pfx + config.json com client_id/secret)
// NUNCA ficam no git — vivem em data/itau/, gitignored, copiados manualmente
// pro servidor. Ver data/itau/config.exemplo.json pro formato esperado.
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ITAU_DIR = path.join(__dirname, '..', 'data', 'itau');
const PFX_PATH = path.join(ITAU_DIR, 'certificado.pfx');
const CONFIG_PATH = path.join(ITAU_DIR, 'config.json');

function carregarConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config não encontrada em ${CONFIG_PATH} — copie certificado.pfx e crie config.json (ver config.exemplo.json).`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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
async function gerarAccessToken() {
  const cfg = carregarConfig();
  const pfx = fs.readFileSync(PFX_PATH);
  const bodyStr = `grant_type=client_credentials&client_id=${cfg.clientId}&client_secret=${cfg.clientSecret}`;
  const { status, body } = await requestJson({
    hostname: 'sts.itau.com.br', port: 443, path: '/api/oauth/token', method: 'POST',
    pfx, passphrase: cfg.pfxPassphrase,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bodyStr) }
  }, bodyStr);
  if (status !== 200) throw new Error(`Erro ao gerar access token (${status}): ${JSON.stringify(body)}`);
  return body.access_token;
}

// dataInicio/dataFim no formato YYYY-MM-DD.
async function buscarExtrato({ dataInicio, dataFim, pagina = 1, tamanhoPagina = 8000 }) {
  const cfg = carregarConfig();
  const pfx = fs.readFileSync(PFX_PATH);
  const accessToken = await gerarAccessToken();
  const contaPath = `${cfg.agencia}00${cfg.conta}${cfg.dac}`;
  const qs = `type=current_account&start_date=${dataInicio}&end_date=${dataFim}&page_size=${tamanhoPagina}&page=${pagina}`;
  const { status, body } = await requestJson({
    hostname: 'account-statement.api.itau.com', port: 443,
    path: `/account-statement/v1/statements/${contaPath}?${qs}`, method: 'GET',
    pfx, passphrase: cfg.pfxPassphrase,
    headers: { 'Authorization': `Bearer ${accessToken}`, 'x-itau-correlationid': crypto.randomUUID() }
  });
  if (status !== 200) throw new Error(`Erro ao buscar extrato (${status}): ${JSON.stringify(body)}`);
  return body;
}

module.exports = { gerarAccessToken, buscarExtrato };
