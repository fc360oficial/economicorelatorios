'use strict';
// Backup diário do estado do Econômico Relatórios (tudo que fica fora do git:
// data/, usuarios.json, pareamento dos WhatsApp, Itaú, Caddy, Firebase das etiquetas).
// Spec: docs/superpowers/specs/2026-09-29-backup-e-seguranca-design.md
// Zip gerado com o tar.exe nativo do Windows 11 (--format=zip), sem pacote novo.
// Cópia pra nuvem via rclone só roda se o binário e o rclone.conf existirem.
// Regra de ouro: erro de backup NUNCA derruba o app — vira estado.erro + console.error.
const fs = require('fs');
const path = require('path');
const util = require('util');
const cp = require('child_process');

const RETENCAO_DIAS = 30;
const HORA_AGENDADA = 4; // 04:00
const MAX_HISTORICO = 30;
const EXEC_OPTS = { windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
// bsdtar do Windows (suporta --format=zip); o tar do Git Bash é GNU e não gera zip
const TAR = fs.existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';

let cfg = null;     // { appDir, dataDir, configPath, estadoPath, execFileFn, destinoDefault }
let rodando = null; // Promise da execução em andamento (serializa chamadas concorrentes)

function configDefault() {
  return {
    destino: cfg.destinoDefault,
    // relativos ao appDir (C:\fc360\claude_code_); só entra o que existir na hora
    itens: [
      'data', 'usuarios.json', 'Caddyfile', 'docs/RESTAURAR.md',
      'negativos-wpp/auth', 'negativos-wpp/pendentes.json',
      'cahu-wpp/auth_info', 'cahu-wpp/config.json',
    ],
    // absolutos, fora do app
    externos: [
      'C:/fc360/etiquetas-api/.env.etiquetas-api',
      'C:/fc360/etiquetas-api/firebase-service-account.json',
      'C:/cahudelivery/infra/caddy',
      'C:/fc360/data',
    ],
    // relativos ao appDir; sessões de login e arquivos de teste/PDF regeneráveis
    excluir: ['data/sessions', 'data/xml-teste', 'data/promocoes-pdf'],
    rclone: {
      exe: 'C:/fc360/tools/rclone/rclone.exe',
      conf: 'C:/fc360/tools/rclone/rclone.conf',
      remoto: 'gdrive-crypt:',
    },
  };
}

function lerJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function gravarJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function init(opts) {
  cfg = { execFileFn: util.promisify(cp.execFile), destinoDefault: 'D:/backups/economico', ...opts };
  if (!fs.existsSync(cfg.configPath)) gravarJson(cfg.configPath, configDefault());
}
function configAtual() { return { ...configDefault(), ...lerJson(cfg.configPath, {}) }; }
function estado() { return lerJson(cfg.estadoPath, { ultimo: null, historico: [] }); }

// D:\ pode não existir (máquina nova) → cai pra <appDir>\..\backups
function destinoReal(c) {
  try { fs.mkdirSync(c.destino, { recursive: true }); fs.accessSync(c.destino, fs.constants.W_OK); return c.destino; }
  catch {
    const alt = path.resolve(cfg.appDir, '..', 'backups');
    fs.mkdirSync(alt, { recursive: true });
    return alt;
  }
}

function nomeArquivo(dest) {
  const d = new Date();
  const dia = d.toISOString().slice(0, 10);
  let nome = `economico-${dia}.zip`;
  if (fs.existsSync(path.join(dest, nome))) {
    nome = `economico-${dia}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.zip`;
  }
  return path.join(dest, nome);
}

function retencao(dest) {
  const limite = Date.now() - RETENCAO_DIAS * 864e5;
  for (const f of fs.readdirSync(dest)) {
    if (!/^economico-.*\.zip$/.test(f)) continue;
    const p = path.join(dest, f);
    try { if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p); }
    catch (e) { console.error('[BACKUP] retenção', f, e.message); }
  }
}

async function gerarZip(c, arquivo) {
  const tmp = arquivo + '.tmp';
  const args = ['--format=zip', '-cf', tmp, '-C', cfg.appDir];
  for (const ex of c.excluir) args.push('--exclude=' + ex);
  for (const it of c.itens) if (fs.existsSync(path.join(cfg.appDir, it))) args.push(it);
  for (const ex of c.externos) if (fs.existsSync(ex)) args.push('-C', path.dirname(ex), path.basename(ex));
  try {
    await cfg.execFileFn(TAR, args, EXEC_OPTS);
    fs.renameSync(tmp, arquivo);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

async function enviarNuvem(c, arquivo) {
  const r = c.rclone || {};
  if (!r.exe || !r.conf || !fs.existsSync(r.exe) || !fs.existsSync(r.conf)) return { status: 'nao-configurada' };
  const base = [r.exe, ['--config', r.conf]];
  await cfg.execFileFn(base[0], [...base[1], 'copy', arquivo, r.remoto, '--drive-chunk-size', '64M'], EXEC_OPTS);
  await cfg.execFileFn(base[0], [...base[1], 'delete', r.remoto, '--min-age', RETENCAO_DIAS + 'd'], EXEC_OPTS);
  return { status: 'ok', em: new Date().toISOString() };
}

async function executar({ motivo = 'agendado' } = {}) {
  if (rodando) return rodando;
  rodando = (async () => {
    const c = configAtual();
    const reg = { inicio: new Date().toISOString(), fim: null, motivo, arquivo: null, bytes: 0, erro: null, nuvem: null };
    try {
      const dest = destinoReal(c);
      const arquivo = nomeArquivo(dest);
      await gerarZip(c, arquivo);
      reg.arquivo = arquivo;
      reg.bytes = fs.statSync(arquivo).size;
      retencao(dest);
      try { reg.nuvem = await enviarNuvem(c, arquivo); }
      catch (e) { reg.nuvem = { status: 'erro', erro: e.message }; console.error('[BACKUP] nuvem:', e.message); }
    } catch (e) {
      reg.erro = e.message;
      console.error('[BACKUP]', e.message);
    }
    reg.fim = new Date().toISOString();
    const st = estado();
    st.ultimo = reg;
    st.historico = [reg, ...(st.historico || [])].slice(0, MAX_HISTORICO);
    gravarJson(cfg.estadoPath, st);
    console.log('[BACKUP]', motivo, reg.erro ? 'ERRO ' + reg.erro : `${(reg.bytes / 1048576).toFixed(1)} MB → ${reg.arquivo} | nuvem: ${reg.nuvem && reg.nuvem.status}`);
    return st;
  })();
  try { return await rodando; } finally { rodando = null; }
}

/** true se os 2 últimos backups falharam (aviso no cabeçalho da tela). */
function alerta() {
  const h = estado().historico || [];
  return h.length >= 2 && !!h[0].erro && !!h[1].erro;
}

function agendar() {
  const hoje = () => new Date().toISOString().slice(0, 10);
  const jaFezHoje = () => { const u = estado().ultimo; return !!(u && !u.erro && u.inicio.slice(0, 10) === hoje()); };
  // ao subir: 5 min depois, se ainda não tem backup bom de hoje (ex.: servidor reiniciou às 04:00)
  setTimeout(() => { if (!jaFezHoje()) executar({ motivo: 'boot' }); }, 5 * 60 * 1000);
  // 04:00 todo dia; se falhar, tenta de novo nas próximas horas cheias (até 3×)
  let falhas = 0;
  setInterval(async () => {
    const d = new Date();
    if (d.getHours() === HORA_AGENDADA && d.getMinutes() === 0) {
      const st = await executar({ motivo: 'agendado' });
      falhas = st.ultimo.erro ? 1 : 0;
    } else if (falhas > 0 && falhas <= 3 && d.getMinutes() === 0) {
      const st = await executar({ motivo: 'retry' });
      falhas = st.ultimo.erro ? falhas + 1 : 0;
    }
  }, 60 * 1000);
}

module.exports = { init, executar, estado, configAtual, agendar, alerta, RETENCAO_DIAS };
