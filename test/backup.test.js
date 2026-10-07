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
  const configPath = path.join(m.dataDir, 'backup-config.json');
  const primeira = !fs.existsSync(configPath);
  backup.init({
    appDir: m.appDir, dataDir: m.dataDir,
    configPath, estadoPath: path.join(m.dataDir, 'backup-estado.json'),
    execFileFn, destinoDefault: m.destino,
  });
  // o default aponta pro rclone e pro script do CAHU reais, que existem no .254: na 1ª vez,
  // neutraliza pra o teste não depender da máquina (os testes de nuvem/extras configuram o que precisam)
  if (primeira) {
    const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    c.rclone = { exe: path.join(m.raiz, 'nao-tem.exe'), conf: path.join(m.raiz, 'nao-tem.conf'), remoto: 'x:' };
    c.extras = [];
    fs.writeFileSync(configPath, JSON.stringify(c));
  }
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
  assert.deepEqual(estado.ultimo.extras, []);
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

test('nuvem configurada: chama rclone copy e delete (so raiz); erro do rclone nao invalida o zip', async () => {
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
  assert.ok(rc[1].includes('--max-depth'), 'delete não desce nas subpastas de outros backups');

  iniciar(m, async (cmd, args) => { if (/tar(\.exe)?$/.test(cmd)) { fs.writeFileSync(args[args.indexOf('-cf') + 1], 'ZIP'); return {}; } throw new Error('sem internet'); });
  st = await backup.executar({ motivo: 'teste' });
  assert.equal(st.ultimo.erro, null);
  assert.equal(st.ultimo.nuvem.status, 'erro');
  assert.match(st.ultimo.nuvem.erro, /sem internet/);
});

test('alerta: null quando ok; texto na 1a falha, na falha da nuvem e quando o ultimo tem mais de 28 h', async () => {
  const m = montar(); const reg = [];
  iniciar(m, execFake(reg));
  await backup.executar({ motivo: 'a' });
  assert.equal(backup.alerta(), null);

  iniciar(m, async () => { throw new Error('tar quebrou'); });
  await backup.executar({ motivo: 'b' });
  assert.match(backup.alerta(), /falhou: tar quebrou/);

  iniciar(m, execFake(reg));
  await backup.executar({ motivo: 'c' });
  assert.equal(backup.alerta(), null);
  const p = path.join(m.dataDir, 'backup-estado.json');
  const st = JSON.parse(fs.readFileSync(p, 'utf8'));
  st.ultimo.inicio = new Date(Date.now() - 30 * 36e5).toISOString();
  fs.writeFileSync(p, JSON.stringify(st));
  assert.match(backup.alerta(), /mais de 28 horas/);

  st.ultimo.inicio = new Date().toISOString();
  st.ultimo.nuvem = { status: 'erro', erro: 'sem internet' };
  fs.writeFileSync(p, JSON.stringify(st));
  assert.match(backup.alerta(), /não subiu pro Google Drive: sem internet/);
});

test('servicos-nssm.json: le o reg query de cada servico (REG_MULTI_SZ vira lista) antes de zipar', async () => {
  const m = montar(); const reg = [];
  const fake = execFake(reg);
  iniciar(m, async (cmd, args) => {
    if (/reg(\.exe)?$/.test(cmd)) {
      reg.push({ cmd, args });
      if (!/EconomicoRelatorios/.test(args[1])) throw new Error('ERRO: O sistema não pode encontrar a chave');
      return { stdout: '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\...\\Parameters\r\n    Application    REG_EXPAND_SZ    C:\\node.exe\r\n    AppEnvironmentExtra    REG_MULTI_SZ    PORT=3003\\0DB_HOST=10.0.0.1\r\n\r\n' };
    }
    return fake(cmd, args);
  });
  const st = await backup.executar({ motivo: 'teste' });
  assert.equal(st.ultimo.erro, null);
  const j = JSON.parse(fs.readFileSync(path.join(m.dataDir, 'servicos-nssm.json'), 'utf8'));
  assert.deepEqual(Object.keys(j.servicos), ['EconomicoRelatorios']);
  assert.equal(j.servicos.EconomicoRelatorios.Application, 'C:\\node.exe');
  assert.deepEqual(j.servicos.EconomicoRelatorios.AppEnvironmentExtra, ['PORT=3003', 'DB_HOST=10.0.0.1']);
  const iTar = reg.findIndex(r => /tar(\.exe)?$/.test(r.cmd));
  const iReg = reg.findIndex(r => /reg(\.exe)?$/.test(r.cmd));
  assert.ok(iReg >= 0 && iReg < iTar, 'reg query roda antes do tar (o arquivo entra no zip via data/)');
});

test('extras: roda o script separado, guarda o JSON da ultima linha; erro de um extra nao invalida o zip', async () => {
  const m = montar(); const reg = [];
  const scriptOk = path.join(m.raiz, 'ok.js'); fs.writeFileSync(scriptOk, '');
  const scriptRuim = path.join(m.raiz, 'ruim.js'); fs.writeFileSync(scriptRuim, '');
  const fake = execFake(reg);
  iniciar(m, async (cmd, args) => {
    if (cmd === process.execPath) {
      if (args[0] === scriptRuim) throw new Error('pg_dump não encontrado');
      return { stdout: 'log qualquer\n{"arquivo":"D:/backups/cahu/cahu-2026-10-07.zip","bytes":5242880,"nuvem":{"status":"ok"}}\n' };
    }
    return fake(cmd, args);
  });
  const cfgPath = path.join(m.dataDir, 'backup-config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.extras = [{ nome: 'CAHU', script: scriptOk }, { nome: 'Ruim', script: scriptRuim }, { nome: 'Sumido', script: path.join(m.raiz, 'nao-existe.js') }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const st = await backup.executar({ motivo: 'teste' });
  assert.equal(st.ultimo.erro, null);
  assert.equal(st.ultimo.extras.length, 2, 'script inexistente é ignorado');
  assert.equal(st.ultimo.extras[0].nome, 'CAHU');
  assert.equal(st.ultimo.extras[0].bytes, 5242880);
  assert.equal(st.ultimo.extras[0].nuvem.status, 'ok');
  assert.match(st.ultimo.extras[1].erro, /pg_dump/);
  assert.match(backup.alerta(), /backup do Ruim .* falhou: pg_dump/);
});
