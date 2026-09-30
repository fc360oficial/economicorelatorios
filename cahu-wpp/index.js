'use strict';
// Bot WhatsApp do número novo "Central Rede Cahu" (18/09/2026). Só faz UMA coisa: recebe pedidos do server.js
// (localhost:3012) e manda texto/documento pro grupo dos vendedores da CAHU. Não responde ninguém, não lê grupo.
// Quem decide O QUE mandar e QUANDO é lib/cahu-tabela-wpp.js no processo principal.
//
// Separado do negativos-wpp de propósito: número diferente (o negativos continua no número antigo — Fase 1).
// Pareamento SEMPRE por código de telefone (nunca QR) — ver memória negativos-wpp-migracao.
//
// config.json (não vai pro git):
//   { "numero": "55DDDNNNNNNNN", "grupo": "NOME EXATO DO GRUPO", "alerta": "55DDDNNNNNNNN" }
//   numero = chip novo (pro código de pareamento); grupo = grupo dos vendedores; alerta = número do Tiago pra falhas.
const path = require('path');
const fs = require('fs');
const http = require('http');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const logger = pino({ level: 'info' });
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PORTA = 3012;

function lerConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { logger.error(`Falta ${CONFIG_PATH} — copie config.exemplo.json e preencha numero/grupo/alerta.`); process.exit(1); }
}
const cfg = lerConfig();
if (!/^\d{12,13}$/.test(cfg.numero || '')) { logger.error('config.numero inválido (use 55 + DDD + número, só dígitos).'); process.exit(1); }

let sock = null;
let grupoJid = null;

// ── WhatsApp ──────────────────────────────────────────────────────────────────
// Regras aprendidas em 29-30/09/2026 (dois dias de 401):
//  1. O 1º código de uma conexão com CHAVES NOVAS sai limpo. Se o código vence (408) e a gente reconecta com as
//     mesmas chaves e pede outro, o WhatsApp devolve 401 em menos de 1 s — e isso não tem a ver com o número.
//     Então: qualquer queda ANTES de completar o pareamento apaga auth_info e nasce do zero.
//  2. Só pode existir UMA cadeia de reconexão. Antes, o 408 agendava um conectar() e o loop principal agendava
//     outro; dois sockets pedindo código ao mesmo tempo = 401 na certa + rejeição não tratada derrubando o processo.
//  3. Código que ninguém digita não adianta: depois de 3 códigos vencidos seguidos, espera 30 min antes do próximo.
const AUTH_DIR = path.join(__dirname, 'auth_info');
let reconTimer = null;
let codigosVencidos = 0;

function limparAuth() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (err) { logger.warn({ err: err.message }, 'não consegui apagar auth_info'); }
}

function agendarReconexao(ms, motivo) {
  if (reconTimer) return; // já tem uma reconexão marcada — nunca duas cadeias
  logger.warn(`${motivo} Nova conexão em ${Math.round(ms / 1000)}s.`);
  reconTimer = setTimeout(() => {
    reconTimer = null;
    conectar().catch(err => {
      logger.error({ err: err.message }, 'Falha ao conectar.');
      agendarReconexao(10000, 'Erro na conexão.');
    });
  }, ms);
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const pareando = !state.creds.registered;
  logger.info(pareando ? 'Conectando com chaves novas pra pedir código de pareamento...' : 'Conectando com sessão salva...');
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, keepAliveIntervalMs: 15000 });
  sock.ev.on('creds.update', saveCreds);
  // Não responde nada de propósito: número novo, qualquer resposta automática é risco de bloqueio.

  if (pareando) {
    setTimeout(async () => {
      try {
        const codigo = await sock.requestPairingCode(cfg.numero);
        logger.info(`CÓDIGO DE PAREAMENTO: ${codigo}  (no celular: WhatsApp > Dispositivos conectados > Conectar dispositivo > Conectar com número de telefone)`);
      } catch (err) { logger.error({ err: err.message }, 'Erro ao pedir código de pareamento'); }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      logger.info('WhatsApp conectado');
      registrado = true;
      grupoJid = null;
      codigosVencidos = 0;
      return;
    }
    if (connection !== 'close') return;
    const code = lastDisconnect?.error?.output?.statusCode;

    // 515 (restartRequired) é o normal logo após digitar o código: o pareamento JÁ foi aceito (creds.registered
    // vira true no creds.update). Reconecta na hora com as mesmas chaves, senão o celular fica em "conectando...".
    if (code === DisconnectReason.restartRequired) { agendarReconexao(1000, 'Pareamento aceito (515), reiniciando a conexão.'); return; }

    if (!state.creds.registered) {
      // Caiu antes de completar o pareamento: código venceu (408) ou WhatsApp recusou (401). Chave usada = lixo.
      limparAuth();
      if (code === DisconnectReason.loggedOut) {
        agendarReconexao(600000, 'WhatsApp recusou o pareamento (401). Chaves descartadas.');
      } else {
        codigosVencidos++;
        const ms = codigosVencidos >= 3 ? 1800000 : 10000;
        agendarReconexao(ms, `Código venceu sem ser digitado (fechou com ${code ?? '?'}, ${codigosVencidos}º seguido). Chaves descartadas.`);
      }
      return;
    }

    if (code === DisconnectReason.loggedOut) {
      // Sessão que já funcionava foi encerrada no celular: apaga e sai; o supervisor (server.js) sobe de novo e
      // o processo novo já imprime um código de pareamento no log.
      logger.error('Sessão encerrada pelo WhatsApp. auth_info apagado; reiniciando pra parear de novo.');
      limparAuth();
      process.exit(1);
    }
    registrado = false;
    agendarReconexao(5000, `Conexão fechou (código ${code ?? '?'}).`);
  });
}

async function acharGrupo() {
  if (grupoJid) return grupoJid;
  const grupos = await sock.groupFetchAllParticipating();
  const alvo = String(cfg.grupo || '').trim().toLowerCase();
  let jid = Object.keys(grupos).find(id => (grupos[id].subject || '').trim().toLowerCase() === alvo);
  if (!jid) jid = Object.keys(grupos).find(id => alvo && (grupos[id].subject || '').toLowerCase().includes(alvo));
  if (!jid) {
    const nomes = Object.values(grupos).map(g => `  • "${g.subject}"`).join('\n');
    throw new Error(`Grupo "${cfg.grupo}" não encontrado. Grupos em que o número está:\n${nomes}`);
  }
  if (grupos[jid].subject !== cfg.grupo) logger.warn(`Grupo exato não achado, usando "${grupos[jid].subject}"`);
  grupoJid = jid;
  return jid;
}

// sock.user já existe assim que o código é pedido; só conta como conectado depois do pareamento completo.
let registrado = false;
const conectado = () => !!(sock && sock.user && registrado);
const jidNumero = n => String(n).replace(/\D/g, '') + '@s.whatsapp.net';

// ── HTTP local (só 127.0.0.1) ─────────────────────────────────────────────────
function lerJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''; req.on('data', c => { body += c; if (body.length > 30e6) { reject(new Error('corpo grande demais')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new Error('JSON inválido')); } });
  });
}
const responder = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      return responder(res, 200, { online: true, conectado: conectado(), numero: conectado() ? sock.user.id.split(':')[0] : null, grupo: cfg.grupo });
    }
    if (req.method !== 'POST') return responder(res, 404, { error: 'rota não existe' });
    const body = await lerJson(req);
    if (!conectado()) return responder(res, 503, { error: 'WhatsApp não conectado' });

    if (req.url === '/mensagem-grupo') {
      if (!body.texto) return responder(res, 400, { error: 'sem texto' });
      await sock.sendMessage(await acharGrupo(), { text: String(body.texto) });
      logger.info('texto enviado pro grupo');
      return responder(res, 200, { ok: true });
    }
    if (req.url === '/documento-grupo') {
      if (!body.base64 || !body.fileName) return responder(res, 400, { error: 'precisa de base64 e fileName' });
      await sock.sendMessage(await acharGrupo(), {
        document: Buffer.from(body.base64, 'base64'), mimetype: body.mimetype || 'application/pdf',
        fileName: String(body.fileName), caption: body.caption ? String(body.caption) : undefined,
      });
      logger.info(`documento enviado pro grupo: ${body.fileName}`);
      return responder(res, 200, { ok: true });
    }
    if (req.url === '/mensagem-alerta') {
      if (!cfg.alerta) return responder(res, 400, { error: 'config.alerta não preenchido' });
      await sock.sendMessage(jidNumero(cfg.alerta), { text: String(body.texto || 'alerta sem texto') });
      return responder(res, 200, { ok: true });
    }
    return responder(res, 404, { error: 'rota não existe' });
  } catch (err) {
    logger.error({ err }, `erro em ${req.url}`);
    responder(res, 500, { error: err.message });
  }
}).listen(PORTA, '127.0.0.1', () => logger.info(`Bot CAHU ouvindo em 127.0.0.1:${PORTA} (grupo alvo: "${cfg.grupo}")`));

// ── Inicialização ─────────────────────────────────────────────────────────────
logger.info('Bot Central Rede Cahu iniciando. Quem agenda o que mandar é lib/cahu-tabela-wpp.js no server.js.');
conectar().catch(err => {
  logger.error({ err: err.message }, 'Falha ao conectar.');
  agendarReconexao(10000, 'Erro na conexão inicial.');
});
