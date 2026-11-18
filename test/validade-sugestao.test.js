// Sugestão de validade (Análise Lista de Compras › Sem Validade) — lib/validade-sugestao.js
const test = require('node:test');
const assert = require('node:assert');
const vs = require('../lib/validade-sugestao');

const irmaos = (n, validar, extra) => Array.from({ length: n }, () => ({ validar, ...extra }));

test('naGrade arredonda pra baixo pro número de cadastro da casa', () => {
  assert.strictEqual(vs.naGrade(229), 180);
  assert.strictEqual(vs.naGrade(365), 365);
  assert.strictEqual(vs.naGrade(1096), 365);
  assert.strictEqual(vs.naGrade(29), 25);
  assert.strictEqual(vs.naGrade(5), 5);      // abaixo de 7 fica o próprio número
  assert.strictEqual(vs.naGrade(1), null);   // 1 é o "vazio" do ERP: não sugere
  assert.strictEqual(vs.naGrade(0), null);
});

test('família com consenso vence e sai com confiança alta', () => {
  const ref = vs.montarReferencia([...irmaos(7, 180, { familia: 'HALLS', subgrupo: 10, grupo: 1 }), ...irmaos(9, 365, { familia: 'OUTRA', subgrupo: 10, grupo: 1 })]);
  const s = vs.sugerir({ familia: ' halls ', subgrupo: 10, grupo: 1 }, ref, null);
  assert.strictEqual(s.dias, 180); assert.strictEqual(s.fonte, 'familia'); assert.strictEqual(s.confianca, 'alta');
  assert.match(s.base, /7 de 7 produtos com 180 dias/);
});

test('subgrupo: alta com 80 %+ de consenso, média entre 60 e 80 %, nada abaixo de 60 %', () => {
  const alta = vs.montarReferencia([...irmaos(9, 90, { subgrupo: 5 }), ...irmaos(1, 30, { subgrupo: 5 })]);
  assert.deepStrictEqual([vs.sugerir({ subgrupo: 5 }, alta, null).dias, vs.sugerir({ subgrupo: 5 }, alta, null).confianca], [90, 'alta']);
  const media = vs.montarReferencia([...irmaos(7, 90, { subgrupo: 5 }), ...irmaos(3, 30, { subgrupo: 5 })]);
  assert.strictEqual(vs.sugerir({ subgrupo: 5 }, media, null).confianca, 'media');
  const racha = vs.montarReferencia([...irmaos(5, 90, { subgrupo: 5 }), ...irmaos(5, 30, { subgrupo: 5 })]);
  assert.strictEqual(vs.sugerir({ subgrupo: 5 }, racha, null), null);
  const nomes = { subgrupo: { 5: 'BISCOITOS' } };
  assert.match(vs.sugerir({ subgrupo: 5 }, alta, null, nomes).base, /Subgrupo "BISCOITOS": 9 de 10/);
});

test('menos de 3 irmãos não vale como parecido', () => {
  const ref = vs.montarReferencia(irmaos(2, 180, { familia: 'X', subgrupo: 5 }));
  assert.strictEqual(vs.sugerir({ familia: 'X', subgrupo: 5 }, ref, null), null);
});

test('sem parecido: usa o coletor (mediana na chegada, pra baixo na grade); 3+ entradas = média, menos = baixa', () => {
  const ref = vs.montarReferencia([]);
  const s = vs.sugerir({}, ref, { entradas: 11, p25: 150, p50: 229, p75: 300, ultima: '2026-11-01' });
  assert.deepStrictEqual([s.dias, s.fonte, s.confianca], [180, 'coletor', 'media']);
  assert.match(s.base, /em 11 entradas chegou com 229 dias/);
  assert.strictEqual(vs.sugerir({}, ref, { entradas: 1, p25: 365, p50: 365, p75: 365 }).confianca, 'baixa');
});

test('parecidos dizem 365 mas o produto chega com bem menos: vale o coletor e guarda o número dos parecidos', () => {
  const ref = vs.montarReferencia(irmaos(10, 365, { subgrupo: 5 }));
  const s = vs.sugerir({ subgrupo: 5 }, ref, { entradas: 8, p25: 40, p50: 55, p75: 70 });
  assert.deepStrictEqual([s.dias, s.fonte, s.divergente], [45, 'coletor', 365]);
  // com só 2 entradas o coletor não derruba os parecidos
  assert.strictEqual(vs.sugerir({ subgrupo: 5 }, ref, { entradas: 2, p25: 40, p50: 55, p75: 70 }).fonte, 'subgrupo');
});

test('a evidência do coletor acompanha a sugestão dos parecidos', () => {
  const ref = vs.montarReferencia(irmaos(10, 180, { subgrupo: 5 }));
  const s = vs.sugerir({ subgrupo: 5 }, ref, { entradas: 12, p25: 150, p50: 203, p75: 230 });
  assert.strictEqual(s.fonte, 'subgrupo'); assert.deepStrictEqual([s.coletor.entradas, s.coletor.tipico], [12, 203]);
});

test('grupo é o último recurso (5+ irmãos) e sai com confiança baixa', () => {
  const ref = vs.montarReferencia(irmaos(8, 365, { grupo: 41 }));
  const s = vs.sugerir({ grupo: 41, subgrupo: 999 }, ref, null, { grupo: { 41: 'HIGIENE' } });
  assert.deepStrictEqual([s.dias, s.fonte, s.confianca], [365, 'grupo', 'baixa']);
  assert.match(s.base, /Grupo "HIGIENE"/);
});

test('produto de balança herdando mais de 60 dias dos parecidos: confiança baixa com aviso', () => {
  const ref = vs.montarReferencia(irmaos(5, 180, { subgrupo: 213 }));
  const s = vs.sugerir({ subgrupo: 213, balanca: true }, ref, null);
  assert.strictEqual(s.dias, 180); assert.strictEqual(s.confianca, 'baixa'); assert.match(s.aviso, /balança/);
  const curto = vs.sugerir({ subgrupo: 7, balanca: true }, vs.montarReferencia(irmaos(5, 15, { subgrupo: 7 })), null);
  assert.strictEqual(curto.confianca, 'alta'); assert.strictEqual(curto.aviso, undefined);
});

test('leitura de 1 dia do coletor não vira sugestão, mas a evidência aparece', () => {
  const s = vs.sugerir({}, vs.montarReferencia([]), { entradas: 1, p25: 1, p50: 1, p75: 1 });
  assert.strictEqual(s.dias, null); assert.strictEqual(s.coletor.tipico, 1);
});

test('planilha: código de barras como texto, ordenada por lista e confiança, com a origem da sugestão', async () => {
  const ExcelJS = require('exceljs');
  const sug = (dias, confianca, base, coletor) => ({ dias, confianca, base, fonte: 'subgrupo', coletor: coletor || null });
  const buf = await vs.planilha([
    { lista: 412, nome: 'GRIFOS', fornecedor: 'GRIFOS LTDA', comprador: 'STEPHANNY', codigo: '7896001020658', descricao: 'ESCOVA', lojas: [1, 4], validade_dias: 1, sugestao: sug(365, 'media', 'Subgrupo "UTILIDADE": 83 de 130 produtos com 365 dias', { entradas: 21, tipico: 458 }) },
    { lista: 412, nome: 'GRIFOS', fornecedor: 'GRIFOS LTDA', comprador: 'STEPHANNY', codigo: '7896007811021', descricao: 'MOLHO', lojas: [3], validade_dias: 0, sugestao: sug(180, 'alta', 'Subgrupo "CONDIMENTOS": 293 de 350 produtos com 180 dias') },
    { lista: 364, nome: 'COTAÇÃO PADARIA', fornecedor: 'ATACAREJO', comprador: 'CRISLANE', codigo: '5102', descricao: 'BANDEJA', lojas: [1, 2, 3, 4, 5, 6], validade_dias: 0, sugestao: null },
  ], { filtro: 'teste' });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Sem validade');
  assert.strictEqual(ws.rowCount, 4);
  const lin = n => ws.getRow(n).values.slice(1);
  assert.strictEqual(lin(1)[4], 'Código de barras');
  assert.deepStrictEqual([lin(2)[0], lin(2)[9], lin(2)[6]], [364, 'Sem sugestão', 'E1 E2 E3 E4 E5 E6']);   // C antes de G
  assert.deepStrictEqual([lin(3)[5], lin(3)[8], lin(3)[9]], ['MOLHO', 180, 'Alta']);                         // alta antes de média na mesma lista
  assert.deepStrictEqual([lin(4)[4], typeof lin(4)[4], lin(4)[11], lin(4)[12]], ['7896001020658', 'string', 458, 21]);
  assert.match(wb.getWorksheet('Como ler').getRow(1).values[1], /3 itens sem validade/);
});
