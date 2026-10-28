// test/gestao-documental-ponto.test.js — Central de Ponto (etapa 03): sincronização da competência a partir da jornada da VR (fake),
// resumo e divergências, escopo por unidade, conferência/divergência, fechamento, PDF do espelho, preparar assinatura (abre solicitação
// ao CPD) e arquivamento direto na pasta 09 do prontuário.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ponto-teste-'));
process.env.CGD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cgd-ponto-teste-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas');
const D = require('../lib/gestao-documental');
const PT = require('../lib/gestao-documental-ponto');

const U = { rh: { usuario: 'rh1', nome: 'Rodrigo RH', perfil: 'gerente' }, cpd4: { usuario: 'cpd4', nome: 'Paula CPD', perfil: 'gerente' }, dir: { usuario: 'dir', nome: 'Diretoria', perfil: 'gerente' }, coord: { usuario: 'coord', nome: 'Coord', perfil: 'gerente' }, ninguem: { usuario: 'x', nome: 'X', perfil: 'gerente' }, admin: { usuario: 'tiago', nome: 'Tiago', perfil: 'admin' } };
GP.salvarConfig({ designados: [{ usuario: 'rh1', nome: 'Rodrigo RH', papeis: ['rh_doc'] }, { usuario: 'cpd4', nome: 'Paula CPD', papeis: ['cpd'], lojas: [4] }, { usuario: 'dir', nome: 'Diretoria', papeis: ['diretoria'] }, { usuario: 'coord', nome: 'Coord', papeis: ['coordenacao'] }] }, U.admin);

const COLABS = { ativos: [
  { id: 1045, nome: 'Ana Paula Souza', matricula: '1045', cargo: 'Operadora de Caixa', setor: 'Frente de Caixa', loja: 4, ativo: true, admissao: '2024-03-01' },
  { id: 2001, nome: 'Carlos Lima', matricula: '2001', cargo: 'Repositor', setor: 'Mercearia', loja: 5, ativo: true, admissao: '2023-01-10' },
], desligados: [{ id: 3001, nome: 'Ex Funcionário', matricula: '3001', loja: 4, ativo: false, desligamento: '2020-01-05' }] };
const COMP = PT.compAnterior(PT.compAtual()); const { de, ate } = PT.periodo(COMP);
function jornadaFake(id, de, ate) {
  const dias = []; for (let d = de; d <= ate; d = (x => { const n = new Date(x + 'T12:00:00'); n.setDate(n.getDate() + 1); return n.toISOString().slice(0, 10); })(d)) {
    const dow = new Date(d + 'T12:00:00').getDay(); const dia = +d.slice(8);
    let m = ['08:00', '12:00', '13:00', '17:00'], sit = 'ok'; if (dow === 0) { m = []; sit = 'folga'; } else if (dia === 3) { m = []; sit = 'sem_marcacao'; } else if (dia === 5) { m = ['08:00', '12:00', '13:00']; sit = 'incompleta'; } else if (dia === 7 && id === 1045) { m = ['08:25', '12:00', '13:00', '17:00']; sit = 'atraso'; }
    dias.push({ data: d, marcacoes: m, entrada: m[0] || null, saidaInt: m[1] || null, retornoInt: m[2] || null, saida: m[3] || null, situacao: sit, situacaoTxt: sit, atraso_min: sit === 'atraso' ? 25 : 0, previsto: null, apuracao: m.length ? { normais: '08:00', faltantes: '00:00', faltantes_min: 0, extras: '00:00', extras_min: 0, saldo_acum_min: 90, carga: '08:00' } : null });
  }
  return Promise.resolve({ colaborador: { id }, de, ate, dias: dias.reverse() });
}
const deps = { colaboradores: async () => COLABS, jornadaPeriodo: jornadaFake, cpfDe: async id => id === 1045 ? '12345678909' : '', empregadorDe: async id => id === 1045 ? { nome: 'ATACAREJO', razao: 'ATACAREJO COMERCIO DE ALIMENTOS LTDA', cnpj: '12345678000190' } : null };
const erroStatus = st => e => e.status === st;

test('1 · competência e permissões', () => {
  assert.ok(PT.compOk('2026-09')); assert.ok(!PT.compOk('2026-13')); assert.throws(() => PT.periodo('2099-01'), /futura/); assert.equal(PT.compTxt('2026-09'), '09/2026');
  assert.equal(PT.perm(U.rh).operar, true); assert.equal(PT.perm(U.cpd4).operar, false); assert.equal(PT.perm(U.cpd4).verPonto, true); assert.equal(PT.perm(U.dir).confirmar, false); assert.equal(PT.perm(U.ninguem).verPonto, false);
});

test('2 · sincronizar: só RH; importa ativos (e desligados do mês) com resumo, divergências e histórico; CPD vê só a própria unidade', async () => {
  await assert.rejects(PT.sincronizar(U.cpd4, COMP, {}, deps), erroStatus(403));
  await assert.rejects(PT.sincronizar(U.rh, '2026-13', {}, deps), /Competência/);
  const r = await PT.sincronizar(U.rh, COMP, { aguardar: true }, deps); assert.equal(r.total, 2);
  const st = PT.statusSync(); assert.equal(st.emAndamento, false); assert.equal(st.feitos, 2); assert.equal(st.nErros, 0); assert.equal(st.historico.length, 1); assert.equal(st.historico[0].ok, 2);
  const L = PT.listar(U.rh, COMP); assert.equal(L.length, 2); const ana = L.find(x => x.id === 1045);
  assert.equal(ana.conferencia, 'pendente'); assert.equal(ana.assinatura, 'nao_enviado'); assert.ok(ana.marcacoes > 50); assert.equal(ana.semMarcacao, 1); assert.equal(ana.incompletos, 1); assert.equal(ana.atrasos, 1); assert.equal(ana.nDivergencias, 3); assert.equal(ana.saldo, '1:30');
  assert.equal(PT.listar(U.cpd4, COMP).length, 1); assert.equal(PT.listar(U.cpd4, COMP)[0].id, 1045); assert.throws(() => PT.listar(U.ninguem, COMP), erroStatus(403));
  assert.equal(PT.listar(U.rh, COMP, { loja: 5 }).length, 1); assert.equal(PT.listar(U.rh, COMP, { q: 'carlos' }).length, 1); assert.equal(PT.listar(U.rh, COMP, { divergentes: 1 }).length, 2);
  const esp = PT.espelho(U.cpd4, COMP, 1045); assert.ok(esp.dias.length >= 28); assert.equal(esp.dias[0].data, de); assert.equal(esp.divergencias.length, 3);
  assert.throws(() => PT.espelho(U.cpd4, COMP, 2001), erroStatus(403));
  const dv = PT.divergencias(U.rh, COMP); assert.equal(dv.length, 5); assert.ok(dv.some(x => x.situacao === 'atraso' && x.id === 1045));
});

test('3 · conferência: aprovar / divergência (texto obrigatório); lote; ressincronizar sem mudança preserva; com mudança volta a pendente', async () => {
  assert.throws(() => PT.conferir(U.cpd4, COMP, 1045, { aprovar: true }), erroStatus(403));
  assert.throws(() => PT.conferir(U.rh, COMP, 1045, { aprovar: false, texto: '' }), /Descreva/);
  const d = PT.conferir(U.rh, COMP, 1045, { aprovar: false, texto: 'Dia 03 sem marcação: verificar atestado' }); assert.equal(d.conferencia, 'divergente');
  const c = PT.conferir(U.rh, COMP, 1045, { aprovar: true }); assert.equal(c.conferencia, 'conferido'); assert.equal(c.conferidoPor.usuario, 'rh1');
  assert.deepEqual(PT.conferirLote(U.rh, COMP, [2001, 9999]), { conferidos: 1 });
  await PT.sincronizar(U.rh, COMP, { aguardar: true }, deps); assert.equal(PT.listar(U.rh, COMP).find(x => x.id === 1045).conferencia, 'conferido');   // mesmos dados → mantém
  const deps2 = { ...deps, jornadaPeriodo: (id, a, b) => jornadaFake(id, a, b).then(j => { j.dias[0].marcacoes = ['09:00']; j.dias[0].situacao = 'incompleta'; return j; }) };
  await PT.sincronizar(U.rh, COMP, { aguardar: true }, deps2); const ana = PT.listar(U.rh, COMP).find(x => x.id === 1045); assert.equal(ana.conferencia, 'pendente'); assert.match(ana.obsConferencia, /mudaram/);
  assert.equal(PT.listar(U.rh, COMP).find(x => x.id === 2001).conferencia, 'pendente');   // o Carlos também mudou nesse sync
  await PT.sincronizar(U.rh, COMP, { aguardar: true }, deps); assert.deepEqual(PT.conferirLote(U.rh, COMP, [1045, 2001]), { conferidos: 2 });
});

test('4 · fechamento: só mês encerrado, RH ou Coordenação; lista de competências', () => {
  assert.throws(() => PT.confirmarFechamento(U.dir, COMP, {}), erroStatus(403)); assert.throws(() => PT.confirmarFechamento(U.rh, PT.compAtual(), {}), /ainda não encerrou/);
  const f = PT.confirmarFechamento(U.coord, COMP, { texto: 'Conferido na VR' }); assert.equal(f.confirmadoPor.usuario, 'coord'); assert.equal(f.funcionarios, 2);
  const fs_ = PT.fechamentos(U.rh); assert.equal(fs_[0].competencia, PT.compAtual()); assert.equal(fs_[0].status, 'em_aberto'); assert.equal(fs_[1].competencia, COMP); assert.equal(fs_[1].status, 'confirmado'); assert.equal(fs_[2].status, 'encerrada');
});

test('5 · PDF do espelho; painel com indicadores', async () => {
  const r = await PT.pdf(U.rh, COMP, 1045); assert.ok(r.buffer.length > 2000); assert.equal(r.buffer.slice(0, 4).toString(), '%PDF'); assert.match(r.nome, /^espelho-ponto-\d{4}-\d{2}-1045\.pdf$/);
  await assert.rejects(PT.pdf(U.cpd4, COMP, 2001), erroStatus(403));
  const p = await PT.painel(U.rh, COMP, deps); const I = p.indicadores; assert.equal(I.localizados, 2); assert.equal(I.ativos, 2); assert.equal(I.fechamentosConfirmados, 1); assert.equal(I.pendentes, 0); assert.equal(I.conferidos, 2); assert.equal(I.comDivergencia, 2); assert.equal(I.semCorrespondencia, 0); assert.equal(p.porLoja.length, 7);
  const p4 = await PT.painel(U.cpd4, COMP, deps); assert.equal(p4.indicadores.localizados, 1); assert.equal(p4.porLoja.length, 1);
});

test('6 · preparar assinatura abre solicitação ao CPD (pasta 09); CPD devolve assinado → RH valida → espelho arquivado; arquivar direto importa na pasta 09', async () => {
  const r = await PT.prepararAssinatura(U.rh, COMP, [1045], deps); assert.equal(r.preparados, 1);
  const e = PT.listar(U.rh, COMP).find(x => x.id === 1045); assert.equal(e.assinatura, 'solicitado'); assert.match(e.solicitacao, /^SOL-/);
  const sols = D.listarSolicitacoes(U.cpd4, {}); assert.equal(sols.length, 1); assert.equal(sols[0].categoria, '09'); assert.equal(sols[0].tipo, 'Espelho de ponto');
  // CPD devolve o espelho assinado (PDF gerado serve de arquivo), vinculado à solicitação
  const pdfBuf = (await PT.pdf(U.rh, COMP, 1045)).buffer; const tmp = path.join(os.tmpdir(), 'esp-assinado-' + Date.now() + '.pdf'); fs.writeFileSync(tmp, pdfBuf);
  const doc = await D.enviar(U.cpd4, { colabId: 1045, categoria: '09', tipo: 'Espelho de ponto', dataDocumento: ate, competencia: COMP, solicitacao: e.solicitacao }, { path: tmp, originalname: 'espelho-assinado.pdf', mimetype: 'application/pdf', size: pdfBuf.length }, deps);
  assert.equal(doc.solicitacao, e.solicitacao); assert.equal(PT.listar(U.rh, COMP).find(x => x.id === 1045).assinatura, 'solicitado');   // ainda aguardando o RH validar
  D.validar(doc.protocolo, U.rh, {}); const e2 = PT.listar(U.rh, COMP).find(x => x.id === 1045); assert.equal(e2.assinatura, 'arquivado'); assert.equal(e2.documento, doc.protocolo);
  // Carlos: arquivar direto, sem assinatura
  await assert.rejects(PT.arquivar(U.cpd4, COMP, 2001, deps), erroStatus(403));
  const a = await PT.arquivar(U.rh, COMP, 2001, deps); assert.match(a.protocolo, /^CGD-/); const d = D.detalhe(a.protocolo, U.rh); assert.equal(d.categoria, '09'); assert.equal(d.status, 'arquivado'); assert.equal(d.competencia, COMP); assert.match(d.origemTxt, /Pontomais/);
  await assert.rejects(PT.arquivar(U.rh, COMP, 2001, deps), /já arquivado/);
  const pr = await D.prontuario(2001, U.rh, deps); assert.equal(pr.pastas[8].docs.length, 1);
  const p = await PT.painel(U.rh, COMP, deps); assert.equal(p.indicadores.arquivados, 2); assert.equal(p.indicadores.aguardandoAssinatura, 0);
  PT.recarregar(); assert.equal(PT.listar(U.rh, COMP).find(x => x.id === 1045).documento, doc.protocolo);
});
