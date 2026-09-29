const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backup = require('../lib/backup');

// Pasta temporária com um app mínimo: data/a.json, data/sessions/s.json, usuarios.json
function montar() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const appDir = path.join(raiz, 'app');
  const dataDir = path.join(appDir, 'data');
  const destino = path.join(raiz, 'dest');
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'a.json'), '{"x":1}');
  fs.writeFileSync(path.join(dataDir, 'sessions', 's.json'), '{}');
  fs.writeFileSync(path.join(appDir, 'usuarios.json'), '[]');
  fs.mkdirSync(destino, { recursive: true });
  return { raiz, appDir, dataDir, destino };
}

// execFile falso: registra as chamadas; pro tar, cria o arquivo de saída.
function execFake(reg) {
  return async (cmd, args) => {
    reg.push({ cmd, args });
    if (/tar(\.exe)?$/.test(cmd)) fs.writeFileSync(args[args.indexOf('-cf') + 1], 'ZIP');
    return { stdout: '', stderr: '' };
  };
}

function iniciar(m, execFileFn) {
  backup.init({
    appDir: m.appDir, dataDir: m.dataDir,
    configPath: path.join(m.dataDir, 'backup-config.json'),
    estadoPath: path.join(m.dataDir, 'backup-estado.json'),
    execFileFn, destinoDefault: m.destino,
  });
}

test('executar gera zip no destino, exclui sessions e grava estado', async () => {
  const m = montar(); const reg = [];
  iniciar(m, execFake(reg));
  const st = await backup.executar({ motivo: 'teste' });
  assert.equal(st.ultimo.erro, null);
  assert.ok(fs.existsSync(st.ultimo.arquivo));
  assert.match(path.basename(st.ultimo.arquivo), /^economico-\d{4}-\d{2}-\d{2}(-\d{4})?\.zip$/);
  const tar = reg.find(r => /tar(\.exe)?$/.test(r.cmd));
  assert.ok(tar, 'tar foi chamado');
  assert.ok(tar.args.includes('--format=zip'));
  assert.ok(tar.args.includes('--exclude=data/sessions'));
  assert.ok(tar.args.includes('data'));
  assert.ok(tar.args.includes('usuarios.json'));
  assert.ok(!tar.args.includes('Caddyfile'), 'caminho inexistente não entra');
  assert.ok(fs.existsSync(path.join(m.dataDir, 'backup-config.json')), 'config default criada');
  const estado = JSON.parse(fs.readFileSync(path.join(m.dataDir, 'backup-estado.json'), 'utf8'));
  assert.equal(estado.historico.length, 1);
  assert.equal(estado.ultimo.motivo, 'teste');
  assert.equal(estado.ultimo.nuvem.status, 'nao-configurada');
});

test('retencao apaga zip com mais de 30 dias e mantem os novos', async () => {
  const m = montar(); const reg = [];
  const velho = path.join(m.destino, 'economico-2020-01-01.zip');
  fs.writeFileSync(velho, 'x');
  const t = new Date(Date.now() - 40 * 864e5);
  fs.utimesSync(velho, t, t);
  const novo = path.join(m.destino, 'economico-2099-01-01.zip');
  fs.writeFileSync(novo, 'x');
  iniciar(m, execFake(reg));
  await backup.executar({ motivo: 'teste' });
  assert.ok(!fs.existsSync(velho), 'zip velho apagado');
  assert.ok(fs.existsSync(novo), 'zip novo mantido');
});

test('erro do tar vira estado.erro, nao lanca e nao deixa .tmp', async () => {
  const m = montar();
  iniciar(m, async () => { throw new Error('tar quebrou'); });
  const st = await backup.executar({ motivo: 'teste' });
  assert.match(st.ultimo.erro, /tar quebrou/);
  assert.equal(st.ultimo.arquivo, null);
  assert.equal(fs.readdirSync(m.destino).filter(f => f.endsWith('.tmp')).length, 0);
});

test('nuvem configurada: chama rclone copy e delete; erro do rclone nao invalida o zip', async () => {
  const m = montar(); const reg = [];
  const exe = path.join(m.raiz, 'rclone.exe'); const conf = path.join(m.raiz, 'rclone.conf');
  fs.writeFileSync(exe, ''); fs.writeFileSync(conf, '');
  iniciar(m, execFake(reg));
  const cfgPath = path.join(m.dataDir, 'backup-config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.rclone = { exe, conf, remoto: 'gdrive-crypt:' };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  let st = await backup.executar({ motivo: 'teste' });
  assert.equal(st.ultimo.nuvem.status, 'ok');
  const rc = reg.filter(r => r.cmd === exe).map(r => r.args);
  assert.equal(rc.length, 2);
  assert.ok(rc[0].includes('copy') && rc[0].includes('gdrive-crypt:'));
  assert.ok(rc[1].includes('delete') && rc[1].includes('--min-age'));

  iniciar(m, async (cmd, args) => { if (/tar(\.exe)?$/.test(cmd)) { fs.writeFileSync(args[args.indexOf('-cf') + 1], 'ZIP'); return {}; } throw new Error('sem internet'); });
  st = await backup.executar({ motivo: 'teste' });
  assert.equal(st.ultimo.erro, null);
  assert.equal(st.ultimo.nuvem.status, 'erro');
  assert.match(st.ultimo.nuvem.erro, /sem internet/);
});

test('alerta so quando os 2 ultimos falharam', async () => {
  const m = montar();
  iniciar(m, async () => { throw new Error('x'); });
  await backup.executar({ motivo: 'a' });
  assert.equal(backup.alerta(), false);
  await backup.executar({ motivo: 'b' });
  assert.equal(backup.alerta(), true);
});
