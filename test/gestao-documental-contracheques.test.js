// test/gestao-documental-contracheques.test.js — Contracheques (etapa 4B): os 10 testes obrigatórios da spec + arquivamento na pasta 08.
// PDFs gerados com pdfkit no formato do sistema de folha (nome ANTES do rótulo "Nome do Funcionário", matrícula antes de "Código") e
// no formato rótulo-antes ("Nome: FULANO"). Nenhum dado real.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cc-teste-'));
process.env.CGD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cgd-cc-teste-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const PDFDocument = require('pdfkit');
const GP = require('../lib/gestao-pessoas');
const D = require('../lib/gestao-documental');
const CC = require('../lib/gestao-documental-contracheques');

const U = { rh: { usuario: 'rh1', nome: 'Rodrigo RH', perfil: 'gerente' }, rh5: { usuario: 'rh5', nome: 'RH só E5', perfil: 'gerente' }, cpd1: { usuario: 'cpd1', nome: 'CPD E1', perfil: 'gerente' }, dir: { usuario: 'dir', nome: 'Diretoria', perfil: 'gerente' }, coord: { usuario: 'coord', nome: 'Coord', perfil: 'gerente' }, ninguem: { usuario: 'x', nome: 'X', perfil: 'gerente' }, admin: { usuario: 'tiago', nome: 'Tiago', perfil: 'admin' } };
GP.salvarConfig({ designados: [{ usuario: 'rh1', nome: 'Rodrigo RH', papeis: ['rh_doc'] }, { usuario: 'rh5', nome: 'RH só E5', papeis: ['rh_doc'], lojas: [5] }, { usuario: 'cpd1', nome: 'CPD E1', papeis: ['cpd'], lojas: [1] }, { usuario: 'dir', nome: 'Diretoria', papeis: ['diretoria'] }, { usuario: 'coord', nome: 'Coord', papeis: ['coordenacao'] }] }, U.admin);

const COLABS = { ativos: [
  { id: 101, nome: 'JOAO SILVA SANTOS', matricula: '158', cargo: 'Operador de caixa', setor: 'Frente', loja: 1, ativo: true, admissao: '2024-03-11' },
  { id: 102, nome: 'JOAO SILVA SANTANA', matricula: '159', cargo: 'Repositor', setor: 'Mercearia', loja: 1, ativo: true, admissao: '2024-05-01' },   // nome parecido (teste 03)
  { id: 103, nome: 'MARIA SOUZA LIMA', matricula: '321', cargo: 'Repositora', setor: 'Mercearia', loja: 2, ativo: true, admissao: '2025-07-02' },   // transferida: folha da E1, cadastro na E2 (teste 04)
  { id: 104, nome: 'PEDRO ALVES SILVA', matricula: '487', cargo: 'Açougueiro', setor: 'Açougue', loja: 5, ativo: true, admissao: '2022-01-17' },
  { id: 105, nome: 'ANA CLARA MENDES', matricula: '214', cargo: 'Fiscal', setor: 'Frente', loja: 1, ativo: true, admissao: '2023-09-04' },
], desligados: [{ id: 106, nome: 'CARLOS HENRIQUE MELO', matricula: '266', cargo: 'Líder', setor: 'Hortifruti', loja: 1, ativo: false, desligamento: '2026-10-10' }] };   // teste 05
const deps = { colaboradores: async () => COLABS, cpfDe: async id => ({ 101: '11111111111', 103: '33333333333', 105: '55555555555' }[id] || '') };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-up-'));
// gera um PDF: cada item = página; { nome, mat, cpf, comp, tipo, formato: 'folha'|'rotulo'|'vazio'|'cont' }
function pdf(paginas) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 40 } }); const ch = []; doc.on('data', c => ch.push(c)); doc.on('end', () => resolve(Buffer.concat(ch)));
    paginas.forEach((p, i) => {
      if (i) doc.addPage(); doc.fontSize(11);
      if (p.formato === 'vazio') return;   // página ilegível (sem texto)
      if (p.formato === 'cont') { doc.text('Continuação do demonstrativo — página 2'); doc.text('Código Descrição Referência Vencimentos Descontos'); doc.text('Horas extras 10,00 150,00'); return; }
      doc.text('ECONOMICO SUPERMERCADOS LTDA'); doc.text(p.tipo === 'adiantamento' ? 'RECIBO DE ADIANTAMENTO SALARIAL' : 'RECIBO MENSAL - CAHU'); doc.text('Competência: ' + (p.comp || 'outubro de 2026'));
      if (p.formato === 'rotulo') { doc.text('Nome: ' + p.nome); if (p.mat) doc.text('Matrícula: ' + p.mat); if (p.cpf) doc.text('CPF: ' + p.cpf); }
      else { doc.text(p.nome); doc.text('Nome do Funcionário'); if (p.mat) { doc.text(String(p.mat)); doc.text('Código'); } if (p.cpf) doc.text('CPF ' + p.cpf); }
      doc.text('Código Descrição Referência Vencimentos Descontos'); doc.text('001 Salário base 30,00 1.500,00'); doc.text('Valor Líquido 1.350,00');
    });
    doc.end();
  });
}
let seq = 0; const arq = (buf, nome) => { const p = path.join(TMP, 'up' + (++seq) + '.pdf'); fs.writeFileSync(p, buf); return { path: p, originalname: nome || 'folha.pdf', mimetype: 'application/pdf', size: buf.length }; };
const erroStatus = st => e => e.status === st;
const docDe = (r, n) => r.docs.find(d => d.n === n);

test('Teste 10 · acesso: CPD, Diretoria e sem papel não entram; RH de loja só vê a sua', async () => {
  assert.equal(CC.perm(U.cpd1).ver, false); assert.equal(CC.perm(U.dir).ver, false); assert.equal(CC.perm(U.coord).ver, true); assert.equal(CC.perm(U.coord).operar, false); assert.equal(CC.perm(U.rh).operar, true);
  assert.throws(() => CC.listar(U.cpd1), e => e.status === 403 && e.naoAutorizado); assert.throws(() => CC.listar(U.dir), erroStatus(403)); assert.throws(() => CC.painel(U.ninguem), erroStatus(403));
  await assert.rejects(CC.importar(U.cpd1, { tipo: 'mensal', competencia: '2026-10' }, arq(await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158 }])), deps), erroStatus(403));
  await assert.rejects(CC.importar(U.coord, { tipo: 'mensal', competencia: '2026-10' }, arq(await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158 }])), deps), erroStatus(403));   // Coordenação consulta, não opera
  await assert.rejects(CC.importar(U.rh5, { tipo: 'mensal', competencia: '2026-10', loja: 1 }, arq(await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158 }])), deps), erroStatus(403));   // RH da E5 não importa folha da E1
});

test('Teste 01 · PDF com vários contracheques de uma página: separa, identifica por matrícula+nome e CPF, um PDF por pessoa', async () => {
  const buf = await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158 }, { nome: 'ANA CLARA MENDES', cpf: '555.555.555-55', formato: 'rotulo' }, { nome: 'PEDRO ALVES SILVA', mat: 487, formato: 'rotulo' }]);
  await assert.rejects(CC.importar(U.rh, { tipo: 'decimo', competencia: '2026-10' }, arq(buf), deps), /Tipo de folha/);
  await assert.rejects(CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-13' }, arq(buf), deps), /Competência/);
  await assert.rejects(CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10' }, arq(Buffer.from('nao e pdf '.repeat(20)), 'x.pdf'), deps), /não é um PDF/);
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', observacoes: 'Folha de outubro', aguardar: true }, arq(buf, 'folha_outubro.pdf'), deps);
  assert.match(r.protocolo, /^REM-\d{4}-0001$/); assert.equal(r.status, 'conferencia'); assert.equal(r.arquivo.paginas, 3); assert.equal(r.arquivo.hash.length, 64); assert.equal(r.totais.docs, 3); assert.equal(r.totais.identificados, 3); assert.equal(r.totais.aptos, 3);
  const det = CC.detalhe(r.protocolo, U.rh); const d1 = docDe(det, 1), d2 = docDe(det, 2), d3 = docDe(det, 3);
  assert.equal(d1.colab.id, 101); assert.equal(d1.identPor, 'matricula'); assert.deepEqual(d1.paginas, [1]); assert.equal(d1.matriculaLida, '158');
  assert.equal(d2.colab.id, 105); assert.equal(d2.identPor, 'cpf'); assert.equal(d2.cpfFim, '5555'); assert.ok(!JSON.stringify(det).includes('55555555555'));   // CPF inteiro nunca sai
  assert.equal(d3.colab.id, 104); assert.equal(d3.identPor, 'matricula');
  for (const n of [1, 2, 3]) { const f = CC.P.doc(r.protocolo, n); assert.ok(fs.existsSync(f)); assert.equal(fs.readFileSync(f).slice(0, 4).toString(), '%PDF'); }
  assert.ok(fs.existsSync(CC.P.original(r.protocolo))); assert.equal(CC.arquivo(r.protocolo, 1, U.rh, false).nome, d1.arquivo.nome);
  assert.throws(() => CC.arquivo(r.protocolo, 1, U.rh5, false), erroStatus(403));   // RH da E5 não abre doc da E1 (remessa toda rede)
  assert.equal(CC.detalhe(r.protocolo, U.rh5).docs.length, 1);   // só o Pedro (E5)
  assert.throws(() => CC.detalhe(r.protocolo, U.cpd1), erroStatus(403));
});

test('Teste 02 · contracheque com múltiplas páginas: página sem identidade continua o documento anterior', async () => {
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', aguardar: true, loja: 1 }, arq(await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158 }, { formato: 'cont' }, { nome: 'ANA CLARA MENDES', mat: 214 }])), deps);
  const det = CC.detalhe(r.protocolo, U.rh); assert.equal(det.docs.length, 2); assert.deepEqual(docDe(det, 1).paginas, [1, 2]); assert.equal(docDe(det, 1).nPaginas, 2); assert.deepEqual(docDe(det, 2).paginas, [3]);
  const { PDFDocument } = require('pdf-lib'); const ind = await PDFDocument.load(fs.readFileSync(CC.P.doc(r.protocolo, 1))); assert.equal(ind.getPageCount(), 2);
});

test('Teste 03 · dois funcionários com nomes semelhantes: sem matrícula vira ambígua, RH escolhe e confirma', async () => {
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', aguardar: true }, arq(await pdf([{ nome: 'JOAO SILVA', formato: 'rotulo' }])), deps);
  let d = docDe(CC.detalhe(r.protocolo, U.rh), 1); assert.equal(d.ident, 'ambigua'); assert.equal(d.candidatos.length, 2); assert.equal(d.podeAprovar, false); assert.ok(d.bloqueiosTxt.some(t => /Mais de um/.test(t)));
  await assert.rejects(CC.aprovar(r.protocolo, 1, U.rh, {}, deps), erroStatus(409));
  await assert.rejects(CC.vincular(r.protocolo, 1, U.rh, { colabId: 102 }, deps), /Confirme/);
  d = await CC.vincular(r.protocolo, 1, U.rh, { colabId: 102, confirmado: true, justificativa: 'Conferido no demonstrativo: matrícula 159' }, deps);
  assert.equal(d.ident, 'confirmada'); assert.equal(d.identPor, 'manual'); assert.equal(d.colab.id, 102); assert.equal(d.podeAprovar, true); assert.equal(d.vinculadoPor.usuario, 'rh1');
});

test('Teste 04 · transferido: folha da E1 com funcionário cadastrado na E2 fica pendente até o RH confirmar', async () => {
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', loja: 1, aguardar: true }, arq(await pdf([{ nome: 'MARIA SOUZA LIMA', mat: 321 }])), deps);
  const d = docDe(CC.detalhe(r.protocolo, U.rh), 1); assert.equal(d.colab.id, 103); assert.equal(d.ident, 'pendente'); assert.ok(d.bloqueios.includes('outra_unidade'));
  const v = await CC.vincular(r.protocolo, 1, U.rh, { confirmado: true }, deps); assert.equal(v.ident, 'confirmada'); assert.equal(v.colab.id, 103);
});

test('Teste 05 · desligado: identifica, mas fica pendente com aviso', async () => {
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', aguardar: true }, arq(await pdf([{ nome: 'CARLOS HENRIQUE MELO', mat: 266 }])), deps);
  const d = docDe(CC.detalhe(r.protocolo, U.rh), 1); assert.equal(d.colab.id, 106); assert.equal(d.colab.ativo, false); assert.equal(d.ident, 'pendente'); assert.ok(d.bloqueios.includes('desligado'));
});

test('Teste 06 · páginas ilegíveis: sem texto no meio vira continuação com aviso; PDF todo sem texto vai para revisão manual', async () => {
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', aguardar: true }, arq(await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158 }, { formato: 'vazio' }])), deps);
  const d = docDe(CC.detalhe(r.protocolo, U.rh), 1); assert.deepEqual(d.paginas, [1, 2]); assert.ok(d.bloqueios.includes('sem_texto')); assert.equal(d.ident, 'pendente');
  const r2 = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', aguardar: true }, arq(await pdf([{ formato: 'vazio' }, { formato: 'vazio' }])), deps);
  const det2 = CC.detalhe(r2.protocolo, U.rh); assert.equal(det2.status, 'revisao_manual'); assert.match(det2.processamento.erro, /texto pesquisável/); assert.equal(det2.docs.length, 0);
});

test('Teste 07 · documento sem matrícula identificável: só o nome → pendente com candidato; nome desconhecido → não localizado', async () => {
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', aguardar: true }, arq(await pdf([{ nome: 'PEDRO ALVES SILVA', formato: 'rotulo' }, { nome: 'FULANO INEXISTENTE DA SILVA', formato: 'rotulo' }])), deps);
  const det = CC.detalhe(r.protocolo, U.rh); const d1 = docDe(det, 1), d2 = docDe(det, 2);
  assert.equal(d1.ident, 'pendente'); assert.equal(d1.colab.id, 104); assert.ok(d1.bloqueios.includes('nome_so'));
  assert.equal(d2.ident, 'nao_localizado'); assert.equal(d2.colab, null); assert.equal(d2.nomeLido, 'FULANO INEXISTENTE DA SILVA');
  await assert.rejects(CC.vincular(r.protocolo, 2, U.rh, { confirmado: true }, deps), /Escolha/);
  const rt = CC.retirar(r.protocolo, 2, U.rh, { motivo: 'Não é funcionário da rede' }); assert.equal(rt.conferencia, 'retirado'); assert.ok(fs.existsSync(CC.P.doc(r.protocolo, 2)));   // retirar não apaga o arquivo
  assert.throws(() => CC.retirar(r.protocolo, 2, U.rh, { motivo: 'de novo' }), erroStatus(409));
});

test('Teste 08 · importação duplicada: mesmo PDF → 409 com a remessa existente; só entra confirmando', async () => {
  const buf = await pdf([{ nome: 'ANA CLARA MENDES', mat: 214 }]);
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', aguardar: true }, arq(buf), deps);
  await assert.rejects(CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10' }, arq(buf), deps), e => e.status === 409 && e.duplicadoDe === r.protocolo);
  const r2 = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', confirmarDuplicado: true, aguardar: true }, arq(buf), deps); assert.equal(r2.reimportacaoDe, r.protocolo);
});

test('Teste 09 · páginas de funcionários diferentes intercaladas: cada troca abre um documento; repetido fica pendente', async () => {
  const r = await CC.importar(U.rh, { tipo: 'mensal', competencia: '2026-10', aguardar: true }, arq(await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158 }, { nome: 'ANA CLARA MENDES', mat: 214 }, { nome: 'JOAO SILVA SANTOS', mat: 158 }])), deps);
  const det = CC.detalhe(r.protocolo, U.rh); assert.equal(det.docs.length, 3); assert.equal(docDe(det, 2).colab.id, 105); assert.equal(docDe(det, 2).ident, 'confirmada');
  assert.equal(docDe(det, 1).colab.id, 101); assert.equal(docDe(det, 3).colab.id, 101); assert.ok(docDe(det, 1).bloqueios.includes('repetido')); assert.ok(docDe(det, 3).bloqueios.includes('repetido')); assert.equal(docDe(det, 3).ident, 'pendente');
});

test('Aprovação: arquiva na pasta 08 com competência e origem; lote só dos aptos com quantidade confirmada; duplicidade no prontuário pede decisão; competência/tipo divergentes bloqueiam', async () => {
  const r = await CC.importar(U.rh, { tipo: 'adiantamento', competencia: '2026-10', aguardar: true }, arq(await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158, tipo: 'adiantamento' }, { nome: 'ANA CLARA MENDES', mat: 214, tipo: 'adiantamento' }, { nome: 'PEDRO ALVES SILVA', mat: 487, tipo: 'mensal' }, { nome: 'MARIA SOUZA LIMA', mat: 321, tipo: 'adiantamento', comp: 'setembro de 2026' }])), deps);
  let det = CC.detalhe(r.protocolo, U.rh); assert.equal(det.totais.aptos, 2); assert.ok(docDe(det, 3).bloqueios.includes('tipo')); assert.ok(docDe(det, 4).bloqueios.includes('competencia')); assert.equal(docDe(det, 4).competenciaLida, '2026-09');
  await assert.rejects(CC.aprovar(r.protocolo, 1, U.cpd1, {}, deps), erroStatus(403));
  await assert.rejects(CC.aprovarLote(r.protocolo, U.rh, { quantidade: 4 }, deps), erroStatus(409));   // quantidade confirmada tem que bater com os aptos
  const lote = await CC.aprovarLote(r.protocolo, U.rh, { quantidade: 2 }, deps); assert.equal(lote.aprovados, 2); assert.equal(lote.pulados, 0);
  det = CC.detalhe(r.protocolo, U.rh); const d1 = docDe(det, 1); assert.equal(d1.conferencia, 'aprovado'); assert.match(d1.documento, /^CGD-/); assert.equal(d1.assinatura, 'nao_solicitada');
  const doc = D.detalhe(d1.documento, U.rh); assert.equal(doc.categoria, '08'); assert.equal(doc.tipo, 'Recibo de adiantamento'); assert.equal(doc.competencia, '2026-10'); assert.match(doc.origemTxt, /contabilidade/); assert.match(doc.observacoes, new RegExp(r.protocolo)); assert.equal(doc.status, 'arquivado');
  const pr = await D.prontuario(101, U.rh, deps); assert.equal(pr.pastas[7].docs.length, 1);
  // mesma competência e tipo de novo → decisão do RH
  const r2 = await CC.importar(U.rh, { tipo: 'adiantamento', competencia: '2026-10', aguardar: true }, arq(await pdf([{ nome: 'JOAO SILVA SANTOS', mat: 158, tipo: 'adiantamento', comp: 'outubro de 2026' }])), deps);
  await assert.rejects(CC.aprovar(r2.protocolo, 1, U.rh, {}, deps), e => e.status === 409 && e.duplicadoDe === d1.documento);
  const ap = await CC.aprovar(r2.protocolo, 1, U.rh, { manterAmbos: true }, deps); assert.match(ap.documento, /^CGD-/); assert.notEqual(ap.documento, d1.documento);
  assert.equal((await D.prontuario(101, U.rh, deps)).pastas[7].docs.length, 2);   // histórico preservado, nada substituído
  assert.equal(CC.detalhe(r2.protocolo, U.rh).status, 'concluida');
  // painel e histórico
  const p = CC.painel(U.rh, {}); assert.ok(p.indicadores.importados >= 10); assert.equal(p.indicadores.aprovados, 3); assert.equal(p.indicadores.arquivados, 3); assert.ok(p.indicadores.divergencias >= 2); assert.equal(p.indicadores.assinatura.aguardando, 0);
  const hist = CC.listar(U.rh, {}); assert.ok(hist.length >= 10); assert.ok(hist.every(x => x.totais && x.statusTxt)); assert.equal(CC.listar(U.rh, { status: 'concluida' }).length, 1);
  const au = D.auditoria(U.coord, {}); for (const a of ['cc_importar', 'cc_processar_fim', 'cc_vincular', 'cc_retirar', 'cc_aprovar', 'cc_ver']) assert.ok(au.some(e => e.acao === a), a);
  assert.ok(!JSON.stringify(au).includes('1.350,00') && !JSON.stringify(au).includes('55555555555'));   // sem salário nem CPF em log
  CC.recarregar(); assert.equal(CC.detalhe(r.protocolo, U.rh).docs.length, 4);
});
