'use strict';
// Bot WhatsApp do número novo "Central Rede Cahu" (18/09/2026). Só faz UMA coisa: recebe pedidos do server.js
// (localhost:3011) e manda texto/documento pro grupo dos vendedores da CAHU. Não responde ninguém, não lê grupo.
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
const PORTA = 3011;

function lerConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { logger.error(`Falta ${CONFIG_PATH} — copie config.exemplo.json e preencha numero/grupo/alerta.`); process.exit(1); }
}
const cfg = lerConfig();
if (!/^\d{12,13}$/.test(cfg.numero || '')) { logger.error('config.numero inválido (use 55 + DDD + número, só dígitos).'); process.exit(1); }

let sock = null;
let grupoJid = null;

// ── WhatsApp ──────────────────────────────────────────────────────────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, keepAliveIntervalMs: 15000 });
  sock.ev.on('creds.update', saveCreds);
  // Não responde nada de propósito: número novo, qualquer resposta automática é risco de bloqueio.

  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        const codigo = await sock.requestPairingCode(cfg.numero);
        logger.info(`CÓDIGO DE PAREAMENTO: ${codigo}  (no celular: WhatsApp > Dispositivos conectados > Conectar dispositivo > Conectar com número de telefone)`);
      } catch (err) { logger.error({ err }, 'Erro ao pedir código de pareamento'); }
    }, 3000);
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout conexão WA')), 120000);
    let resolvido = false;
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        logger.info('WhatsApp conectado');
        grupoJid = null;
        if (!resolvido) { resolvido = true; clearTimeout(timer); resolve(); }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          logger.error('Sessão encerrada pelo WhatsApp. Apague a pasta auth_info e reinicie pra parear de novo.');
          if (!resolvido) { clearTimeout(timer); reject(new Error('Deslogado')); } else process.exit(1);
        } else {
          logger.warn('Reconectando...');
          if (resolvido) setTimeout(conectar, 5000);
        }
      }
    });
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

const conectado = () => !!(sock && sock.user);
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
(async () => {
  logger.info('Conectando ao WhatsApp (Central Rede Cahu)...');
  for (;;) {
    try { await conectar(); break; }
    catch (err) { logger.error({ err }, 'Falha ao conectar. Tentando de novo em 10s...'); await new Promise(r => setTimeout(r, 10000)); }
  }
  logger.info('Pronto. Aguardando pedidos do server.js (nenhuma agenda aqui — quem agenda é lib/cahu-tabela-wpp.js).');
})();
