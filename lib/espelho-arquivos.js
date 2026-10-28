'use strict';
// lib/espelho-arquivos.js — os JSONs operacionais de data/ (Gente, Ética, Avarias, Expedição, Fiscal, pedidos do CD...)
// copiados pro nosso Postgres como jsonb (tabela arquivo_json), 28/10/2026 à noite (Tiago: "no futuro quero colocar
// tudo via API"). Os módulos continuam lendo/gravando os arquivos como sempre (nada muda no fluxo de ninguém); este
// módulo só espelha: varre data/ na subida, grava o que mudou (mtime/tamanho) e fica de olho (fs.watch) pra gravar as
// alterações em segundos. Com isso o dado já fica consultável em SQL (conteudo->'campo') e entra no dump diário.
// Caches regeneráveis (radar-*, sortimento, dashboard-estoque, sem-giro...) e arquivos > 8 MB ficam de fora.
const fs = require('fs');
const path = require('path');
const pg = require('./pg');

const MAX_BYTES = 8 * 1024 * 1024;
const PASTAS_FORA = new Set(['sessions', 'pg-dump', 'xml-teste', 'promocoes-pdf', 'apk', 'log-acessos', 'log-coletor', 'log-erp', 'log-precificacao']);
const ARQUIVOS_FORA = /^(radar-.*|sortimento|dashboard-estoque|sem-giro|.*-cache|tv-rh-cache|backup-estado|servicos-nssm|pg-economico)\.json$/i;

let DATA = null, pronto = false, erro = null, watcher = null, pendentes = new Map(), timerFlush = null;
let estado = { arquivos: 0, ultimaEm: null, ultimoErro: null, gravados: 0, ignorados: 0, varreduraMs: null };

async function criarEsquema() {
  await pg.pq(`CREATE TABLE IF NOT EXISTS arquivo_json (
    caminho text PRIMARY KEY, conteudo jsonb NOT NULL, tamanho integer NOT NULL, modificado_em timestamptz NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now(), removido boolean NOT NULL DEFAULT false
  )`);
  await pg.pq(`CREATE INDEX IF NOT EXISTS arquivo_json_conteudo ON arquivo_json USING gin (conteudo jsonb_path_ops)`);
}
const rel = abs => path.relative(DATA, abs).split(path.sep).join('/');
function entra(relPath) {
  const partes = relPath.split('/');
  if (partes.some(p => PASTAS_FORA.has(p))) return false;
  if (!/\.json$/i.test(relPath)) return false;
  return !ARQUIVOS_FORA.test(path.basename(relPath));
}
function listar(dir, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!PASTAS_FORA.has(e.name)) listar(abs, out); }
    else if (e.isFile() && entra(rel(abs))) out.push(abs);
  }
  return out;
}
async function gravarArquivo(abs) {
  const r = rel(abs); let st;
  try { st = fs.statSync(abs); } catch (e) { if (e.code === 'ENOENT') { await pg.pq('UPDATE arquivo_json SET removido = true, atualizado_em = now() WHERE caminho = $1', [r]); return 'removido'; } throw e; }
  if (st.size > MAX_BYTES) { estado.ignorados++; return 'grande'; }
  let txt; try { txt = fs.readFileSync(abs, 'utf8'); } catch (e) { return 'ilegivel'; }
  let obj; try { obj = JSON.parse(txt); } catch (e) { return 'invalido'; }   // gravação pela metade de outro processo: a próxima mudança corrige
  // jsonb não aceita \u0000 dentro de texto
  const json = JSON.stringify(obj).replace(/\\u0000/g, '');
  await pg.pq(`INSERT INTO arquivo_json (caminho, conteudo, tamanho, modificado_em, atualizado_em, removido) VALUES ($1, $2::jsonb, $3, $4, now(), false)
               ON CONFLICT (caminho) DO UPDATE SET conteudo = EXCLUDED.conteudo, tamanho = EXCLUDED.tamanho, modificado_em = EXCLUDED.modificado_em, atualizado_em = now(), removido = false`,
    [r, json, st.size, st.mtime.toISOString()]);
  estado.gravados++;
  return 'ok';
}
// Varredura: grava só o que mudou (mtime ou tamanho diferentes do que está no banco)
async function varrer() {
  const t0 = Date.now();
  const conhecidos = new Map((await pg.pq('SELECT caminho, tamanho, modificado_em FROM arquivo_json WHERE NOT removido')).map(r => [r.caminho, r]));
  const arquivos = listar(DATA); let n = 0;
  for (const abs of arquivos) {
    const r = rel(abs); let st; try { st = fs.statSync(abs); } catch (e) { continue; }
    const c = conhecidos.get(r);
    if (c && Number(c.tamanho) === st.size && Math.abs(new Date(c.modificado_em).getTime() - st.mtime.getTime()) < 1000) { conhecidos.delete(r); continue; }
    try { if ((await gravarArquivo(abs)) === 'ok') n++; } catch (e) { estado.ultimoErro = `${r}: ${e.message}`; }
    conhecidos.delete(r);
  }
  for (const r of conhecidos.keys()) await pg.pq('UPDATE arquivo_json SET removido = true, atualizado_em = now() WHERE caminho = $1', [r]).catch(() => {});
  estado.arquivos = arquivos.length; estado.varreduraMs = Date.now() - t0; estado.ultimaEm = new Date().toISOString();
  return { arquivos: arquivos.length, gravados: n, removidos: conhecidos.size, ms: estado.varreduraMs };
}
// Mudanças ao vivo: fs.watch recursivo (Windows suporta); junta num lote de 2 s porque os módulos gravam .tmp + rename
function vigiar() {
  try {
    watcher = fs.watch(DATA, { recursive: true }, (ev, nome) => {
      if (!nome) return; const r = String(nome).split(path.sep).join('/');
      if (!entra(r)) return;
      pendentes.set(r, Date.now());
      clearTimeout(timerFlush); timerFlush = setTimeout(flush, 2000);
    });
    watcher.on('error', e => { console.error('[ESPELHO-ARQ] watch:', e.message); });
  } catch (e) { console.error('[ESPELHO-ARQ] sem fs.watch:', e.message); }
}
async function flush() {
  const lote = [...pendentes.keys()]; pendentes.clear();
  for (const r of lote) { try { await gravarArquivo(path.join(DATA, r)); } catch (e) { estado.ultimoErro = `${r}: ${e.message}`; } }
  estado.ultimaEm = new Date().toISOString();
}
// Leitura pela API futura: devolve o conteúdo de um arquivo espelhado (null se não existe)
async function ler(caminho) {
  const r = await pg.pq('SELECT conteudo FROM arquivo_json WHERE caminho = $1 AND NOT removido', [String(caminho).split(path.sep).join('/')]);
  return r.length ? r[0].conteudo : null;
}
async function status() {
  let banco = null;
  try { banco = (await pg.pq(`SELECT COUNT(*) FILTER (WHERE NOT removido) ativos, COUNT(*) FILTER (WHERE removido) removidos, pg_size_pretty(pg_total_relation_size('arquivo_json')) tamanho, MAX(atualizado_em) ultimo FROM arquivo_json`))[0]; } catch (e) {}
  return { pronto, erro, ...estado, banco, maxMb: MAX_BYTES / 1048576, pendentes: pendentes.size };
}
function init(d) {
  DATA = (d && d.dataDir) || path.join(__dirname, '..', 'data');
  if (!pg.disponivel()) { erro = 'Postgres não configurado'; return; }
  (async () => {
    try {
      await criarEsquema();
      pronto = true;
      setTimeout(async () => {
        try { const r = await varrer(); console.log(`[ESPELHO-ARQ] ${r.arquivos} arquivos JSON de data/, ${r.gravados} gravados, ${r.removidos} marcados removidos, ${r.ms} ms`); }
        catch (e) { erro = e.message; console.error('[ESPELHO-ARQ] varredura:', e.message); }
        vigiar();
      }, 60 * 1000);
      const t = setInterval(() => varrer().catch(e => { estado.ultimoErro = e.message; }), 6 * 60 * 60 * 1000); if (t.unref) t.unref();
    } catch (e) { erro = e.message; console.error('[ESPELHO-ARQ] falhou ao iniciar:', e.message); }
  })();
}
module.exports = { init, status, varrer, ler, _estado: () => estado };
