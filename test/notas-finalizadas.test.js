// Notas Finalizadas fase 2 (06/11/2026): curva nos itens, "chegou e não vendeu", ações do gerente e push das 08:00.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const NF = require('../lib/notas-finalizadas');
const P = NF._puras;

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const soma = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-'));
NF.initAvisos({ dataDir: tmp });

test('classificar: sem venda só quando o produto vendia o bastante; novo sem histórico; fraco abaixo de 10 % e 30 %; estoque zero = ok', () => {
  assert.equal(P.classificar({ vendeu: 0, antes: 1830, esperado: 488, qtd: 240, estoque: 263 }), 'sem');
  assert.equal(P.classificar({ vendeu: 0, antes: 0, esperado: 0, qtd: 48, estoque: 48 }), 'novo');
  assert.equal(P.classificar({ vendeu: 0, antes: 0, esperado: 0, qtd: 142, estoque: 1995, unid: 'KG' }), 'ok', 'carcaça em KG sai pelo código da balança');
  assert.equal(P.classificar({ vendeu: 0, antes: 2, esperado: 0.5, qtd: 24, estoque: 24 }), 'ok', 'curva C de giro lento não é problema');
  assert.equal(P.classificar({ vendeu: 12, antes: 270, esperado: 90, qtd: 160, estoque: 171 }), 'fraco');
  assert.equal(P.classificar({ vendeu: 20, antes: 270, esperado: 90, qtd: 160, estoque: 171 }), 'ok', '20 de 160 passa dos 10 %');
  assert.equal(P.classificar({ vendeu: 12, antes: 60, esperado: 20, qtd: 160, estoque: 171 }), 'ok', '12 de 20 esperados passa dos 30 %');
  assert.equal(P.classificar({ vendeu: 0, antes: 1830, esperado: 488, qtd: 240, estoque: 0 }), 'ok', 'estoque zero: já saiu');
  assert.equal(P.classificar({ vendeu: 0, antes: 1830, esperado: 488, qtd: 240, estoque: null }), 'sem', 'estoque desconhecido não esconde');
});

test('produtosDaJanela: mesmo código em duas notas vira um produto com a chegada mais antiga e a qtd somada', () => {
  const notas = [
    { nCompra: 1, nNota: '10', fornecedor: 'Camil', dia: '2026-10-27', itens: [{ cod: '1', descricao: 'ÓLEO', unid: 'UN', qtd: 240, curva: 'A', vendeDia: 61 }] },
    { nCompra: 2, nNota: '11', fornecedor: 'Camil', dia: '2026-10-25', itens: [{ cod: '1', descricao: 'ÓLEO', unid: 'UN', qtd: 60, curva: 'A', vendeDia: 61 }, { cod: '2', descricao: 'CAFÉ', unid: 'UN', qtd: 96, curva: 'A', vendeDia: 29 }] },
  ];
  const ps = P.produtosDaJanela(notas);
  assert.equal(ps.length, 2);
  const oleo = ps.find(p => p.cod === '1');
  assert.equal(oleo.qtd, 300); assert.equal(oleo.chegou, '2026-10-25'); assert.equal(oleo.notas.length, 2);
});

test('avaliar: vendeu = do dia seguinte à nota até ontem; antes = 30 dias antes; esperado = média × dias; estoque do mapa', () => {
  const ontem = '2026-11-04';
  const produtos = [{ cod: '1', descricao: 'ÓLEO', qtd: 240, chegou: '2026-10-27', notas: [], lojaNum: 3 }];
  const vd = { '1': { '2026-10-26': 60, '2026-10-20': 60, '2026-09-26': 999 /* fora dos 30 d */, '2026-10-28': 0, '2026-11-04': 0, '2026-11-05': 50 /* hoje não conta */ } };
  const [x] = P.avaliar(produtos, vd, { '1': 263 }, ontem);
  assert.equal(x.vendeu, 0); assert.equal(x.antes, 120); assert.equal(x.diasSem, 8); assert.equal(x.mediaDia, 4); assert.equal(x.esperado, 32); assert.equal(x.estoque, 263);
  assert.equal(x.classe, 'sem');
  const [y] = P.avaliar(produtos, { '1': { '2026-10-30': 5 } }, { '1': 263 }, ontem);
  assert.equal(y.vendeu, 5); assert.equal(y.antes, 0); assert.equal(y.classe, 'ok', 'vendeu algo e sem média: ok');
});

test('porCurva: A → B → C → Novo, dentro do grupo por venda/dia; itens sem curva por último', () => {
  const notas = [{ nCompra: 1, nNota: '10', fornecedor: 'X', itens: [
    { cod: 'c', descricao: 'C1', curva: 'C', vendeDia: 0.4 }, { cod: 'n', descricao: 'N1', curva: 'N', vendeDia: 0 },
    { cod: 'a2', descricao: 'A2', curva: 'A', vendeDia: 29 }, { cod: 'a1', descricao: 'A1', curva: 'A', vendeDia: 61 }, { cod: 'b', descricao: 'B1', curva: 'B', vendeDia: 9 }] }];
  const g = P.porCurva(notas);
  assert.deepEqual(g.map(x => x.curva), ['A', 'B', 'C', 'N']);
  assert.deepEqual(g[0].itens.map(i => i.cod), ['a1', 'a2']);
  assert.equal(g[0].itens[0].nNota, '10');
});

test('aplicarCurva: sem espelho fica null; com mapa marca A/B/C e N pra quem não vendeu', () => {
  const notas = [{ itens: [{ cod: '1' }, { cod: '2' }] }];
  P.aplicarCurva(notas, null); assert.equal(notas[0].itens[0].curva, null);
  P.aplicarCurva(notas, { mapa: { '1': { abc: 'A', dia: 61.26 } } });
  assert.equal(notas[0].itens[0].curva, 'A'); assert.equal(notas[0].itens[0].vendeDia, 61.3);
  assert.equal(notas[0].itens[1].curva, 'N'); assert.equal(notas[0].itens[1].vendeDia, 0);
});

test('textoNota: aviso da nota diz quantos curva A e quantos novos', () => {
  const n = { fornecedor: 'Camil', hora: '10:20', diferencas: 0, itens: [{ curva: 'A' }, { curva: 'A' }, { curva: 'B' }, { curva: 'N' }] };
  assert.equal(P.textoNota(n), 'Camil · 4 produtos · 2 produtos curva A · 1 produto novo · 10:20');
  assert.equal(P.textoNota({ fornecedor: 'X', itens: [{ curva: null }] }), 'X · 1 produto');
});

test('marcar/acaoVigente: ação vale 7 dias; inválida rejeita; listarAcoes vem do mais novo', () => {
  assert.throws(() => NF.marcar({ loja: 3, cod: '1', acao: 'qualquer' }), /inválida/);
  assert.throws(() => NF.marcar({ loja: 0, cod: '1', acao: 'gondola' }), /obrigat/);
  const a = NF.marcar({ loja: 3, cod: '1', acao: 'deposito', usuario: 'gerencia.e3', nCompra: 10, nNota: '48213', descricao: 'ÓLEO' });
  assert.equal(a.acaoTxt, 'Estava no depósito');
  assert.ok(P.acaoVigente(3, '1'));
  assert.equal(P.acaoVigente(4, '1'), null);
  assert.equal(P.acaoVigente(3, '1', Date.now() + 8 * 86400e3), null, 'depois de 7 dias volta');
  assert.ok(fs.existsSync(path.join(tmp, 'notas-finalizadas', 'acoes.json')));
  NF.marcar({ loja: 3, cod: '2', acao: 'nao_achei' });
  const l = NF.listarAcoes({ loja: 3 }); assert.equal(l[0].cod, '2'); assert.equal(l.length, 2);
  assert.equal(NF.listarAcoes({ acao: 'nao_achei' }).length, 1);
  // marcado some da lista do avaliar
  const [x] = P.avaliar([{ cod: '1', descricao: 'ÓLEO', qtd: 240, chegou: '2026-10-27', notas: [], lojaNum: 3 }], {}, null, '2026-11-04');
  assert.equal(x.acao.acao, 'deposito');
});

test('avisoParado: só sem venda e novo, cada produto uma vez a cada 7 dias', () => {
  const p = { loja: 3, lojaTxt: 'E3 · Ponte', itens: [{ cod: '1', descricao: 'ÓLEO', classe: 'sem' }, { cod: '2', descricao: 'IOGURTE', classe: 'novo' }, { cod: '3', descricao: 'MACARRÃO', classe: 'fraco' }] };
  const av = P.avisoParado(p, {}, '2026-11-06');
  assert.deepEqual(av.chaves, ['3|1', '3|2']);
  assert.equal(av.payload.title, 'E3 · Ponte: 2 produtos chegaram e não venderam');
  assert.equal(av.payload.body, 'ÓLEO, IOGURTE');
  assert.equal(av.payload.url, '/gestao-gerencial.html#notas/parado');
  assert.equal(P.avisoParado(p, { '3|1': '2026-11-02', '3|2': '2026-11-05' }, '2026-11-06'), null, 'avisados há menos de 7 dias');
  const av2 = P.avisoParado(p, { '3|1': '2026-10-29', '3|2': '2026-11-05' }, '2026-11-06');
  assert.deepEqual(av2.chaves, ['3|1'], '8 dias depois volta');
});

test('rodar: push da nota com curva A; às 08:00 manda o chegou-e-não-vendeu uma vez por dia e lembra quem já foi avisado', async () => {
  P._resetCaches();
  const hoje = ymd(new Date()); const ontem = soma(hoje, -1);
  // ERP falso: 1 nota finalizada hoje na loja 3 (nCompra 10) e 1 nota de 10 dias atrás (nCompra 20) com produto parado
  const d10 = soma(hoje, -10);
  const q = async (sql, params) => {
    if (/FROM central\.compras c/.test(sql)) {
      const [, , , dIni, dFim] = params;
      const todas = [
        { nCompra: 10, nLoja: 4, nNota: '48213', NomeFornec: 'CAMIL', CodFornec: 1, Movimentacao: 'COMPRA', TotalNota: '1.000,00', NomeOperador: 'ANA', nConferencia: 0, DataRecto: hoje, DataStatus: hoje },
        { nCompra: 20, nLoja: 4, nNota: '7715', NomeFornec: 'UNIAO', CodFornec: 2, Movimentacao: 'COMPRA', TotalNota: '500,00', NomeOperador: 'ANA', nConferencia: 0, DataRecto: d10, DataStatus: d10 },
      ];
      return todas.filter(n => n.DataStatus >= dIni && n.DataStatus <= dFim);
    }
    if (/compraprodutos/.test(sql)) {
      const out = [];
      if (params.includes(10)) out.push({ nCompra: 10, Item: 1, CodigoBarra: '1', Descricao: 'ARROZ', Unid: 'UN', Qtd: 10, QtdEmb: 12, QtdEntradaEstoque: 120, Preco: 0, Custo: 5, Cancelado: 0 }, { nCompra: 10, Item: 2, CodigoBarra: '9', Descricao: 'NOVIDADE', Unid: 'UN', Qtd: 1, QtdEmb: 1, QtdEntradaEstoque: 48, Preco: 0, Custo: 1, Cancelado: 0 });
      if (params.includes(20)) out.push({ nCompra: 20, Item: 1, CodigoBarra: '2', Descricao: 'ACUCAR', Unid: 'UN', Qtd: 1, QtdEmb: 1, QtdEntradaEstoque: 300, Preco: 0, Custo: 3, Cancelado: 0 });
      return out;
    }
    return [];
  };
  // espelho falso: curva da loja (arroz A, açúcar A), venda por dia do açúcar só ANTES da nota, estoque > 0
  const espelho = {
    pronto: () => true,
    vendaPeriodo: async () => [{ loja: 3, codigo: '1', qtd: 1200, valor: 9000 }, { loja: 3, codigo: '2', qtd: 1100, valor: 8000 }, { loja: 3, codigo: '5', qtd: 10, valor: 10 }],
    temCobertura: async () => true,
    pq: async () => { const rows = []; for (let i = 1; i <= 30; i++) rows.push({ codigo: '2', dia: soma(d10, -i), qtd: 38 }); return rows; },
    estoqueAtual: async () => [{ codigo: '2', qtd: 300 }],
  };
  const enviados = [];
  const notificarLoja = async (loja, payload) => { enviados.push({ loja, ...payload }); };
  const base = { q, espelho, notificarLoja, lojas: [4] };
  const em = h => new Date(hoje + 'T' + h + ':00');
  // 1ª passada (07:00): só marca o que já existe, nada é avisado
  let r = await NF.rodar({ ...base, agora: em('07:00') });
  assert.deepEqual(r, { novas: 0, avisos: 0, parados: 0 }); assert.equal(enviados.length, 0);
  // 07:30: nota 10 "aparece" (apaga do visto) → aviso com curva A e novo
  P._vistos().chaves = []; P._resetCaches();
  r = await NF.rodar({ ...base, agora: em('07:30') });
  assert.equal(r.novas, 1); assert.equal(r.avisos, 1); assert.equal(r.parados, 0, 'antes das 08:00 não manda o parado');
  assert.equal(enviados[0].title, 'Nota finalizada · NF 48213');
  assert.match(enviados[0].body, /1 produto curva A · 1 produto novo/);
  // 08:05: chegou e não vendeu da loja 3 — açúcar vendia 38/dia e vendeu 0 em 9 dias
  r = await NF.rodar({ ...base, agora: em('08:05') });
  assert.equal(r.parados, 1); assert.equal(enviados.length, 2);
  assert.equal(enviados[1].title, 'E4 · Atacarejo: 1 produto chegou e não vendeu'); assert.equal(enviados[1].body, 'ACUCAR');
  assert.equal(P._vistos().paradoAvisados['4|2'], hoje);
  // 08:10: mesmo dia, não repete
  r = await NF.rodar({ ...base, agora: em('08:10') });
  assert.equal(r.parados, 0); assert.equal(enviados.length, 2);
  // parado() direto: lista, resumo e janela
  const p = await NF.parado({ loja: 4, dias: 7 }, base);
  assert.equal(p.itens.length, 1); assert.equal(p.itens[0].classe, 'sem'); assert.equal(p.itens[0].curva, 'B', 'arroz sozinho já passa de 50 %: açúcar é B'); assert.equal(p.itens[0].estoque, 300);
  assert.equal(p.resumo.sem, 1); assert.equal(p.janela.fim, soma(hoje, -7)); assert.equal(p.janela.ini, soma(hoje, -21)); assert.equal(p.ate, ontem);
  // gerente marca → some da lista e conta como marcado
  NF.marcar({ loja: 4, cod: '2', acao: 'gondola' });
  const p2 = await NF.parado({ loja: 4, dias: 7 }, base);
  assert.equal(p2.itens.length, 0); assert.equal(p2.resumo.marcados, 1);
  // listar: curva nos itens e contagem no resumo
  const l = await NF.listar({ loja: 4, dia: hoje }, base);
  assert.equal(l.notas[0].itens[0].curva, 'A'); assert.equal(l.notas[0].itens[1].curva, 'N'); assert.deepEqual(l.resumo.curvas, { A: 1, B: 0, C: 0, N: 1 });
  assert.equal(l.curva.fonte, 'espelho');
});

test('parado sem espelho devolve erro explicado e lista vazia', async () => {
  P._resetCaches();
  const p = await NF.parado({ loja: 2, dias: 14 }, { q: async () => [], espelho: null });
  assert.match(p.erro, /Espelho/); assert.deepEqual(p.itens, []); assert.equal(p.dias, 14);
});

test('pdf por curva gera um PDF', async () => {
  P._resetCaches();
  const hoje = ymd(new Date());
  const q = async (sql) => /FROM central\.compras c/.test(sql) ? [{ nCompra: 1, nLoja: 1, nNota: '1', NomeFornec: 'F', CodFornec: 1, Movimentacao: 'COMPRA', TotalNota: '1', NomeOperador: '', nConferencia: 0, DataRecto: hoje, DataStatus: hoje }]
    : /compraprodutos/.test(sql) ? [{ nCompra: 1, Item: 1, CodigoBarra: '1', Descricao: 'ARROZ', Unid: 'UN', Qtd: 1, QtdEmb: 1, QtdEntradaEstoque: 10, Preco: 0, Custo: 1, Cancelado: 0 }] : [];
  const buf = await NF.pdf({ loja: 1, dia: hoje, modo: 'curva', usuario: 'teste' }, { q, espelho: { vendaPeriodo: async () => [{ loja: 1, codigo: '1', qtd: 10, valor: 100 }] } });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000); assert.equal(buf.slice(0, 4).toString(), '%PDF');
  assert.equal(NF.nomePdf(1, hoje, null, 'curva'), 'notas-finalizadas-E1-' + hoje + '-por-curva.pdf');
});
