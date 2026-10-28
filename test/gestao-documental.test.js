// test/gestao-documental.test.js — Gestão Documental (etapa 02): CPD envia → RH confere (valida / corrige / rejeita) → arquivamento
// automático no prontuário; reenvio no mesmo protocolo; importação histórica direta e em lote; proteção do validado
// (RH pede → Coordenação decide reautenticada; autor não aprova o próprio pedido); escopo por unidade; saúde ocupacional restrita;
// duplicidade por hash; tipo real do arquivo; retenção; auditoria.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.GP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cgd-teste-'));
process.env.CGD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cgd-teste-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const GP = require('../lib/gestao-pessoas');
const D = require('../lib/gestao-documental');

const U = {
  cpd4: { usuario: 'cpd4', nome: 'Paula CPD', perfil: 'gerente' }, cpd5: { usuario: 'cpd5', nome: 'Cícero CPD', perfil: 'gerente' },
  rh: { usuario: 'rh1', nome: 'Rodrigo RH', perfil: 'gerente' }, rh5: { usuario: 'rh5', nome: 'RH só E5', perfil: 'gerente' },
  coord: { usuario: 'coord', nome: 'Donato Coord', perfil: 'gerente' }, coord2: { usuario: 'coord2', nome: 'Outra Coord', perfil: 'gerente' }, dir: { usuario: 'dir', nome: 'Diretoria', perfil: 'gerente' },
  admin: { usuario: 'tiago', nome: 'Tiago', perfil: 'admin' }, ninguem: { usuario: 'x', nome: 'Sem papel', perfil: 'gerente' },
};
GP.salvarConfig({ designados: [
  { usuario: 'cpd4', nome: 'Paula CPD', papeis: ['cpd'], lojas: [4] }, { usuario: 'cpd5', nome: 'Cícero CPD', papeis: ['cpd'], lojas: [5] },
  { usuario: 'rh1', nome: 'Rodrigo RH', papeis: ['rh_doc'] }, { usuario: 'rh5', nome: 'RH só E5', papeis: ['rh_doc'], lojas: [5] },
  { usuario: 'coord', nome: 'Donato Coord', papeis: ['coordenacao', 'rh_doc'] }, { usuario: 'coord2', nome: 'Outra Coord', papeis: ['coordenacao'] }, { usuario: 'dir', nome: 'Diretoria', papeis: ['diretoria'] },
] }, U.admin);

const COLABS = { ativos: [
  { id: 1045, nome: 'Ana Paula Souza', matricula: '1045', cargo: 'Operadora de Caixa', setor: 'Frente de Caixa', loja: 4, ativo: true, status_agora: 'Trabalhando', admissao: '2024-03-01' },
  { id: 2001, nome: 'Carlos Lima', matricula: '2001', cargo: 'Repositor', setor: 'Mercearia', loja: 5, ativo: true, admissao: '2023-01-10' },
], desligados: [{ id: 3001, nome: 'Ex Funcionário', matricula: '3001', cargo: 'Repositor', setor: 'Mercearia', loja: 4, ativo: false }] };
const deps = { colaboradores: async () => COLABS };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cgd-up-'));
let seq = 0;
function arquivo(conteudo, nome, mime) {
  const p = path.join(TMP, 'up' + (++seq)); const buf = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo); fs.writeFileSync(p, buf);
  return { path: p, originalname: nome || 'doc.pdf', mimetype: mime || 'application/pdf', size: buf.length };
}
const pdf = (texto) => arquivo('%PDF-1.4\n' + (texto || 'conteudo') + '\n' + 'x'.repeat(80) + '\n%%EOF', 'doc.pdf');
const png = () => arquivo(Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(100, 7)]), 'foto.png', 'image/png');
const erroStatus = st => e => e.status === st;
const existe = rel => fs.existsSync(path.join(D.DIR, rel));
const envio = (extra = {}) => ({ colabId: 1045, categoria: '01', tipo: 'RG', dataDocumento: '2018-03-15', observacoes: 'RG frente e verso', ...extra });

test('1 · permissões: quem vê o quê; CPD só a própria unidade; Diretoria não aprova; saúde ocupacional restrita', () => {
  assert.equal(D.permissoes(U.ninguem).ver, false); assert.equal(D.permissoes(U.cpd4).cpd, true); assert.deepEqual(D.permissoes(U.cpd4).lojas, [4]);
  assert.equal(D.permissoes(U.rh).rh, true); assert.deepEqual(D.permissoes(U.rh5).lojas, [5]); assert.equal(D.permissoes(U.dir).autorizar, false); assert.equal(D.permissoes(U.admin).autorizar, true);
  assert.equal(D.veLoja(U.cpd4, 5), false); assert.equal(D.veLoja(U.coord, 5), true);
});

test('2 · CPD envia: protocolo CGD, situação Aguardando conferência, arquivo em pendentes/, só funcionário da unidade, tipo real conferido', async () => {
  await assert.rejects(D.enviar(U.cpd5, envio(), pdf(), deps), erroStatus(403));               // Ana é da loja 4, cpd5 é da 5
  await assert.rejects(D.enviar(U.ninguem, envio(), pdf(), deps), erroStatus(403));
  await assert.rejects(D.enviar(U.cpd4, envio({ categoria: '99' }), pdf(), deps), /Categoria/);
  await assert.rejects(D.enviar(U.cpd4, envio({ tipo: 'ASO admissional' }), pdf(), deps), /Tipo de documento inválido/);
  await assert.rejects(D.enviar(U.cpd4, envio({ dataDocumento: '2099-01-01' }), pdf(), deps), /futura/);
  await assert.rejects(D.enviar(U.cpd4, envio(), arquivo('isto nao e um pdf de verdade, so texto comprido pra passar do minimo de bytes....', 'falso.pdf'), deps), /não corresponde a um PDF/);
  await assert.rejects(D.enviar(U.cpd4, envio(), arquivo('<script>alert(1)</script>' + 'x'.repeat(80), 'pagina.html', 'text/html'), deps), /não aceito/);
  await assert.rejects(D.enviar(U.cpd4, envio(), null, deps), /Anexe/);
  const d = await D.enviar(U.cpd4, envio(), pdf('rg-ana'), deps);
  assert.match(d.protocolo, /^CGD-\d{4}-00001$/); assert.equal(d.status, 'aguardando_rh'); assert.equal(d.origem, 'cpd'); assert.equal(d.loja, 4); assert.equal(d.colab.nome, 'Ana Paula Souza');
  assert.equal(d.versoes.length, 1); assert.match(d.versoes[0].caminho, /^arquivos\/pendentes\/CGD-/); assert.ok(existe(d.versoes[0].caminho)); assert.equal(d.versoes[0].hash.length, 64);
  assert.equal(d.enviadoPor.usuario, 'cpd4'); assert.equal(d.historico[0].acao, 'enviar');
  // duplicidade pelo hash no mesmo funcionário (409 com o protocolo existente)
  await assert.rejects(D.enviar(U.cpd4, envio({ tipo: 'CPF' }), pdf('rg-ana'), deps), e => e.status === 409 && e.duplicadoDe === d.protocolo);
  // CPD acompanha o que enviou; RH vê; CPD de outra loja não; Diretoria vê a ficha mas não baixa
  assert.equal(D.detalhe(d.protocolo, U.cpd4).podeBaixar, true); assert.equal(D.detalhe(d.protocolo, U.rh).status, 'aguardando_rh');
  assert.throws(() => D.detalhe(d.protocolo, U.cpd5), erroStatus(403)); assert.equal(D.detalhe(d.protocolo, U.dir).podeBaixar, false);
  assert.equal(D.pendencias(U.rh).n, 1); assert.equal(D.pendencias(U.rh5).n, 0); assert.equal(D.fila(U.rh).length, 1); assert.throws(() => D.fila(U.cpd4), erroStatus(403));
});

test('3 · RH confere: CPD não valida; RH de outra unidade não; validar arquiva no prontuário (pasta da categoria), registra validador e retenção', async () => {
  const prot = 'CGD-' + new Date().getFullYear() + '-00001';
  assert.throws(() => D.validar(prot, U.cpd4), erroStatus(403)); assert.throws(() => D.validar(prot, U.rh5), erroStatus(403)); assert.throws(() => D.validar(prot, U.dir), erroStatus(403));
  D.analisar(prot, U.rh); assert.equal(D.obter(prot).status, 'em_analise'); assert.throws(() => D.analisar(prot, U.rh), erroStatus(409));
  const d = D.validar(prot, U.rh, { parecer: 'Legível, confere com o cadastro' });
  assert.equal(d.status, 'arquivado'); assert.equal(d.validadoPor.usuario, 'rh1'); assert.ok(d.arquivadoEm); assert.equal(d.retencaoAte, '2023-03-15');   // 5 anos a partir da data do documento
  assert.match(d.versoes[0].caminho, /^arquivos\/prontuarios\/1045\/01\/CGD-\d{4}-00001-v1\.pdf$/); assert.ok(existe(d.versoes[0].caminho)); assert.ok(!existe('arquivos/pendentes/' + prot + '/v1.pdf'));
  assert.throws(() => D.validar(prot, U.rh), erroStatus(409));
  const pr = await D.prontuario(1045, U.rh, deps); assert.equal(pr.total, 1); assert.equal(pr.pastas[0].docs[0].protocolo, prot); assert.equal(pr.pastas.length, 10);
  assert.equal(D.arquivo(prot, U.rh).nome, 'doc.pdf'); assert.throws(() => D.arquivo(prot, U.cpd5), erroStatus(403));
});

test('4 · correção: volta ao CPD com justificativa, reenvio no MESMO protocolo vira versão 2 e preserva o histórico; rejeição é final', async () => {
  const a = await D.enviar(U.cpd4, envio({ categoria: '02', tipo: 'Contrato de trabalho', dataDocumento: '2024-03-01' }), pdf('contrato-v1'), deps);
  assert.throws(() => D.corrigir(a.protocolo, U.rh, {}), /motivo/);
  assert.throws(() => D.reenviar(a.protocolo, U.cpd4, {}, pdf('x')), erroStatus(409));   // ainda não foi devolvido
  D.corrigir(a.protocolo, U.rh, { motivo: 'Sem assinatura', texto: 'Página 2 sem assinatura do colaborador' });
  assert.equal(D.obter(a.protocolo).status, 'correcao_solicitada'); assert.equal(D.pendencias(U.cpd4).n, 1);
  assert.throws(() => D.reenviar(a.protocolo, U.cpd5, {}, pdf('y')), erroStatus(403));
  const r = D.reenviar(a.protocolo, U.cpd4, { texto: 'Assinado e digitalizado de novo' }, pdf('contrato-v2'));
  assert.equal(r.status, 'aguardando_rh'); assert.equal(r.versoes.length, 2); assert.equal(r.versaoAtual, 2); assert.equal(r.correcoes.length, 1); assert.deepEqual(r.historico.map(h => h.acao), ['enviar', 'corrigir', 'reenviar']);
  const v = D.validar(a.protocolo, U.rh); assert.match(v.versoes[1].caminho, /prontuarios\/1045\/02\/.*-v2\.pdf$/); assert.match(v.versoes[0].caminho, /pendentes/);   // v1 fica guardada
  const b = await D.enviar(U.cpd4, envio({ tipo: 'CPF' }), png(), deps);
  assert.throws(() => D.rejeitar(b.protocolo, U.rh, { motivo: 'x' }), /motivo/); const rj = D.rejeitar(b.protocolo, U.rh, { motivo: 'Documento de terceiro' });
  assert.equal(rj.status, 'rejeitado'); assert.throws(() => D.validar(b.protocolo, U.rh), erroStatus(409)); assert.throws(() => D.reenviar(b.protocolo, U.cpd4, {}, pdf('z')), erroStatus(409));
});

test('5 · importação histórica direta pelo RH: exige confirmação e data original, arquiva na hora com origem marcada; CPD não importa', async () => {
  const b = { colabId: 2001, categoria: '04', tipo: 'Aviso de férias', dataDocumento: '2024-07-01', competencia: '2024-07', origem: 'fisico', observacoes: 'Pasta física 2024' };
  await assert.rejects(D.importar(U.cpd5, { ...b, confirmado: true }, pdf('ferias'), deps), erroStatus(403));
  await assert.rejects(D.importar(U.rh, b, pdf('ferias'), deps), /Confirme/);
  await assert.rejects(D.importar(U.rh, { ...b, confirmado: true, dataDocumento: '' }, pdf('ferias'), deps), /data original/);
  await assert.rejects(D.importar(U.rh, { ...b, confirmado: true, origem: 'inventada' }, pdf('ferias'), deps), /Origem/);
  await assert.rejects(D.importar(U.rh5, { ...b, colabId: 1045, confirmado: true }, pdf('ferias'), deps), erroStatus(403));   // RH só da E5 não importa pra loja 4
  const d = await D.importar(U.rh, { ...b, confirmado: true }, pdf('ferias'), deps);
  assert.equal(d.status, 'arquivado'); assert.equal(d.origem, 'importacao_historica'); assert.equal(d.origemDetalhe, 'fisico'); assert.equal(d.dataDocumento, '2024-07-01'); assert.equal(d.competencia, '2024-07');
  assert.equal(d.validadoPor.usuario, 'rh1'); assert.ok(d.importadoEm); assert.match(d.versoes[0].caminho, /prontuarios\/2001\/04\//); assert.equal(d.historico[0].acao, 'importar');
  assert.equal(D.resumo(d).origemTxt, 'Importação histórica (RH) · Arquivo físico digitalizado');
  // RH só da E5 importa pro funcionário da E5
  const e = await D.importar(U.rh5, { ...b, tipo: 'Recibo de férias', confirmado: true }, pdf('recibo'), deps); assert.equal(e.loja, 5);
});

test('6 · lote: um protocolo por arquivo; item sem funcionário, duplicado ou com tipo errado é recusado e os demais seguem', async () => {
  const itens = [{ colabId: 1045, categoria: '08', tipo: 'Contracheque', dataDocumento: '2025-05-05', competencia: '2025-05' }, { colabId: '', categoria: '08', tipo: 'Contracheque', dataDocumento: '2025-06-05' },
    { colabId: 2001, categoria: '09', tipo: 'Espelho de ponto', dataDocumento: '2025-05-31' }, { colabId: 2001, categoria: '04', tipo: 'Aviso de férias', dataDocumento: '2024-07-01' }];
  const files = [pdf('cc-05'), pdf('cc-06'), pdf('ponto-05'), pdf('ferias')];   // o último repete o hash da importação do teste 5
  await assert.rejects(D.importarLote(U.cpd4, itens, files, deps), erroStatus(403));
  await assert.rejects(D.importarLote(U.rh, itens.slice(1), files, deps), /um registro por arquivo/);
  const r = await D.importarLote(U.rh, itens, files, deps);
  assert.equal(r.arquivados, 2); assert.equal(r.recusados, 2); assert.match(r.itens[1].erro, /não identificado/); assert.match(r.itens[3].erro, /já existe/); assert.ok(r.itens[0].protocolo && r.itens[2].protocolo && r.itens[0].protocolo !== r.itens[2].protocolo);
  assert.equal(D.obter(r.itens[0].protocolo).lote, r.lote); assert.ok(!fs.existsSync(files[1].path));   // arquivo recusado não fica na tmp
});

test('7 · proteção do validado: RH não exclui nem substitui; pede → Coordenação decide só reautenticada; autor não aprova o próprio pedido; exclusão guarda o arquivo', async () => {
  const prot = 'CGD-' + new Date().getFullYear() + '-00001';
  assert.throws(() => D.substituir(prot, U.rh, {}, pdf('nova')), /não autorizada/);
  assert.throws(() => D.solicitarAutorizacao(U.cpd4, { protocolo: prot, operacao: 'excluir', justificativa: 'Documento em duplicidade' }), erroStatus(403));
  assert.throws(() => D.solicitarAutorizacao(U.rh, { protocolo: prot, operacao: 'rasgar', justificativa: 'Documento em duplicidade' }), /Operação/);
  assert.throws(() => D.solicitarAutorizacao(U.rh, { protocolo: prot, operacao: 'excluir', justificativa: 'curta' }), /Justifique/);
  const a = D.solicitarAutorizacao(U.rh, { protocolo: prot, operacao: 'substituir', justificativa: 'Nova via do RG com foto atualizada' });
  assert.match(a.protocolo, /^AUT-\d{4}-0001$/); assert.equal(a.status, 'pendente');
  assert.throws(() => D.solicitarAutorizacao(U.rh, { protocolo: prot, operacao: 'excluir', justificativa: 'Outro pedido no mesmo doc' }), erroStatus(409));
  assert.throws(() => D.decidirAutorizacao(a.protocolo, U.coord, { decisao: 'aprovar' }, false), erroStatus(401));   // sem reautenticação
  assert.throws(() => D.decidirAutorizacao(a.protocolo, U.rh, { decisao: 'aprovar' }, true), erroStatus(403)); assert.throws(() => D.decidirAutorizacao(a.protocolo, U.dir, { decisao: 'aprovar' }, true), erroStatus(403));
  // coord também é rh_doc, mas não foi quem pediu — pode; quem pediu não poderia
  const aut2 = D.solicitarAutorizacao(U.coord, { protocolo: D.listar(U.rh, { categoria: '02' })[0].protocolo, operacao: 'excluir', justificativa: 'Contrato em duplicidade no prontuário' });
  assert.throws(() => D.decidirAutorizacao(aut2.protocolo, U.coord, { decisao: 'aprovar' }, true), /próprio pedido/);
  assert.throws(() => D.decidirAutorizacao(a.protocolo, U.coord, { decisao: 'indeferir', texto: '' }, true), /motivo/);
  const ap = D.decidirAutorizacao(a.protocolo, U.coord, { decisao: 'aprovar', texto: 'Ok' }, true);
  assert.equal(ap.status, 'aprovada'); assert.equal(ap.decisao.por.usuario, 'coord'); assert.ok(ap.decisao.reautenticadoEm); assert.equal(D.obter(prot).substituicaoAutorizada, a.protocolo);
  assert.throws(() => D.decidirAutorizacao(a.protocolo, U.coord2, { decisao: 'aprovar' }, true), erroStatus(409));
  const s = D.substituir(prot, U.rh, { texto: 'Nova via' }, pdf('rg-novo')); assert.equal(s.versoes.length, 2); assert.equal(s.versaoAtual, 2); assert.equal(s.status, 'arquivado'); assert.ok(existe(s.versoes[0].caminho) && existe(s.versoes[1].caminho));
  assert.equal(D.obter(prot).substituicaoAutorizada, null); assert.throws(() => D.substituir(prot, U.rh, {}, pdf('outra')), /não autorizada/);   // autorização é de uso único
  // exclusão aprovada por outra coordenação: sai do prontuário, arquivo vai pra excluidos/, histórico fica
  const ex = D.decidirAutorizacao(aut2.protocolo, U.coord2, { decisao: 'aprovar', texto: 'Confirmado em duplicidade' }, true); assert.equal(ex.status, 'usada');
  const dEx = D.obter(ex.documento); assert.equal(dEx.status, 'excluido'); assert.ok(dEx.versoes.every(v => /^arquivos\/excluidos\//.test(v.caminho) && existe(v.caminho))); assert.equal(dEx.exclusao.autorizacao, aut2.protocolo);
  assert.throws(() => D.arquivo(ex.documento, U.rh), erroStatus(403)); assert.equal(D.arquivo(ex.documento, U.coord).nome, 'doc.pdf');
  const pr = await D.prontuario(1045, U.rh, deps); assert.equal(pr.pastas[1].docs.length, 0); assert.ok(pr.outros.some(x => x.protocolo === ex.documento && x.status === 'excluido'));
  assert.equal(D.listarAutorizacoes(U.coord2, {}).length, 2); assert.throws(() => D.listarAutorizacoes(U.cpd4), erroStatus(403));
});

test('8 · saúde ocupacional: CPD envia mas depois de arquivado só RH/Coordenação veem e baixam; Diretoria nem lista', async () => {
  const d = await D.enviar(U.cpd4, envio({ categoria: '07', tipo: 'ASO admissional', dataDocumento: '2024-03-01' }), pdf('aso'), deps);
  assert.equal(d.sensivel, true); assert.equal(D.detalhe(d.protocolo, U.cpd4).podeBaixar, false);   // quem enviou acompanha a ficha, mas o arquivo é restrito
  D.validar(d.protocolo, U.rh); assert.equal(D.detalhe(d.protocolo, U.rh).podeBaixar, true); assert.equal(D.detalhe(d.protocolo, U.coord).podeBaixar, true);
  assert.throws(() => D.detalhe(d.protocolo, U.dir), erroStatus(403)); assert.throws(() => D.arquivo(d.protocolo, U.cpd4), erroStatus(403));
  const prDir = await D.prontuario(1045, U.dir, deps); assert.equal(prDir.pastas[6].restrita, true); assert.equal(prDir.pastas[6].docs.length, 0);
  assert.equal(D.obter(d.protocolo).retencaoAte, '2044-03-01');   // 20 anos
});

test('9 · solicitações do RH às unidades: CPD atende com o envio vinculado; painel, listagens, prontuários e auditoria', async () => {
  const s = await D.criarSolicitacao(U.rh, { colabId: 2001, categoria: '01', tipo: 'Comprovante de residência', prazo: '2020-01-01', observacoes: 'Endereço diverge' }, deps);
  assert.match(s.protocolo, /^SOL-/); assert.equal(D.listarSolicitacoes(U.cpd5)[0].atrasada, true); assert.equal(D.listarSolicitacoes(U.cpd4).length, 0); assert.equal(D.pendencias(U.cpd5).n, 1);
  const d = await D.enviar(U.cpd5, { colabId: 2001, categoria: '01', tipo: 'Comprovante de residência', dataDocumento: '2026-10-01', solicitacao: s.protocolo }, pdf('comprovante'), deps);
  assert.equal(d.solicitacao, s.protocolo); assert.equal(D.listarSolicitacoes(U.rh, { status: 'atendida' })[0].documento, d.protocolo);
  await assert.rejects(D.criarSolicitacao(U.cpd5, { colabId: 2001, categoria: '01', tipo: 'RG' }, deps), erroStatus(403));
  const p = D.painel(U.rh, {}); assert.ok(p.indicadores.recebidosMes >= 5); assert.equal(p.porLoja.length, 7); assert.equal(p.porCategoria.length, 10); assert.ok(p.recentes.length);
  const p5 = D.painel(U.cpd5, {}); assert.equal(p5.porLoja.length, 1); assert.ok(p5.recentes.every(x => x.loja === 5));
  assert.ok(D.listar(U.rh, { q: 'ana paula' }).every(x => x.colab.id === 1045)); assert.equal(D.listar(U.rh, { origem: 'importacao_historica' }).length, 4); assert.ok(D.listar(U.rh, { status: 'arquivado' }).length >= 4);
  const lista = await D.prontuarios(U.rh, {}, deps); assert.equal(lista.length, 2); assert.ok(lista.find(x => x.id === 1045).docs >= 2); assert.equal((await D.prontuarios(U.cpd5, {}, deps)).length, 1);
  assert.equal((await D.prontuarios(U.rh, { desligados: 1 }, deps)).length, 3);
  const au = D.auditoria(U.coord, {}); assert.ok(au.some(e => e.acao === 'validar' && e.usuario === 'rh1')); assert.ok(au.some(e => e.acao === 'aut_aprovar')); assert.ok(au.some(e => e.acao === 'baixar'));
  assert.ok(D.auditoria(U.cpd4, {}).every(e => e.usuario === 'cpd4' || +e.loja === 4)); assert.throws(() => D.auditoria(U.ninguem), erroStatus(403));
  // configuração: só Coordenação; retenção reflete no próximo arquivamento
  assert.throws(() => D.salvarConfig(U.rh, { prazoRhDias: 5 }), erroStatus(403)); const c = D.salvarConfig(U.coord, { prazoRhDias: 5, retencaoAnos: { '01': 7 } }); assert.equal(c.prazoRhDias, 5); assert.equal(c.retencaoAnos['01'], 7); assert.equal(c.retencaoAnos['07'], 20);
  // recarga do disco mantém tudo
  D.recarregar(); assert.equal(D.obter(d.protocolo).solicitacao, s.protocolo); assert.equal(D.config().prazoRhDias, 5);
});
