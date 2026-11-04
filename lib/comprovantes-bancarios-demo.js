'use strict';
// lib/comprovantes-bancarios-demo.js — DP / RH › Comprovantes Bancários, FASE A (interfaces demonstrativas) + FASE B (diagnóstico), 04/11/2026.
// TUDO AQUI É FICTÍCIO, de propósito: o módulo ainda não lê banco, não grava nada e não toca em nenhum outro cadastro. A Fase C em
// diante só começa com aprovação expressa da Coordenação. Os nomes levam "Exemplo"/"Fictício" pra nunca serem confundidos com
// funcionário real. Os resultados do diagnóstico (DIAGNOSTICO) são medições reais de 04/11/2026, só com contagens e formato.
const HOJE = '2026-11-04';   // data de referência fixa: os vencimentos da demonstração não mudam com o tempo
const LOJAS = [
  { n: 1, txt: 'E1', nome: 'Socorro', cnpj: '21.425.302/0001-81' }, { n: 2, txt: 'E2', nome: 'Muribeca', cnpj: '30.148.015/0001-62' },
  { n: 3, txt: 'E3', nome: 'Ponte', cnpj: '39.762.002/0001-53' }, { n: 4, txt: 'E4', nome: 'Atacarejo', cnpj: '43.358.448/0001-94' },
  { n: 5, txt: 'E5', nome: 'Porta Larga', cnpj: '51.632.927/0001-85' }, { n: 6, txt: 'E6', nome: 'Jardim Jordão', cnpj: '59.890.722/0001-01' },
  { n: 10, txt: 'CD', nome: 'Centro de Distribuição', cnpj: '61.920.643/0001-48' },
];
const TIPOS = { rescisao: 'Rescisão', salario: 'Salário', adiantamento: 'Adiantamento', ferias: 'Férias', decimo: '13º salário', abono: 'Abono', acordo: 'Acordo trabalhista', outros: 'Outros' };
const SITUACOES = { aguardando_envio: 'Aguardando envio ao banco', agendado: 'Agendado', enviado: 'Enviado', processamento: 'Em processamento', liquidado: 'Confirmado / liquidado', rejeitado: 'Rejeitado', devolvido: 'Devolvido', divergente: 'Divergente', comprovante_indisponivel: 'Comprovante indisponível' };
const TIPOS_GUIA = { fgts_mensal: 'FGTS mensal', fgts_rescisorio: 'FGTS rescisório', previdencia: 'Contribuição previdenciária', darf_folha: 'DARF da folha', encargos_13: 'Encargos do 13º', outros: 'Outro recolhimento' };
const SIT_GUIA = { aguardando: 'Aguardando pagamento', conferencia: 'Em conferência', paga: 'Paga', parcial: 'Paga em parte', vencida: 'Vencida', divergente: 'Com divergência', duplicada: 'Guia duplicada', pag_duplicado: 'Pagamento duplicado', devolvida: 'Devolvida', rejeitada: 'Rejeitada' };
const CLASSE_DOC = { oficial: 'Comprovante bancário oficial', importado: 'Documento importado', guia: 'Guia emitida', ordem: 'Ordem de pagamento', demonstrativo: 'Demonstrativo' };

const banco = n => 'DEMO-ITAU-' + String(n).padStart(6, '0');
const hist = (...l) => l.map(([em, quem, txt]) => ({ em, quem, txt }));
// cadeia = obrigação → ordem → confirmação bancária → comprovante; cada elo: ok | pendente | falha | na
const P = (id, nome, cpf, idf, loja, tipo, sub, comp, valor, prevista, efetiva, n, situacao, cadeia, docs, extra) => ({ id, nome, cpf, idf, loja, tipo, sub, comp, valor, prevista, efetiva, idBanco: n ? banco(n) : null, situacao, cadeia, docs, arquivado: false, ...(extra || {}) });
const OK4 = ['ok', 'ok', 'ok', 'ok'];
const dOf = (nome, kb) => [{ classe: 'importado', nome, kb, origem: 'Importado pelo Financeiro · PDF do Itaú Empresas' }];

const PAGAMENTOS = [
  P('PG-0001', 'Ana Exemplo Souza', '***.104.221-**', 'DEMO-0101', 2, 'rescisao', 'Verbas rescisórias', '2026-10', 12598.22, '2026-10-31', '2026-10-31', 875423, 'liquidado', OK4,
    dOf('Comprovante_Rescisao_Exemplo.pdf', 180), { cenarios: [1, 13, 15], vinculoEncerrado: '2026-10-21', pasta: '10 — Desligamento', arquivado: true, guiaRel: 'GU-0002', hist: hist(['2026-10-29 09:12', 'RH / DP', 'Rescisão lançada na folha'], ['2026-10-31 11:40', 'Itaú', 'Débito individual identificado no extrato (CPF + valor)'], ['2026-11-03 10:05', 'Financeiro', 'Comprovante importado do Itaú Empresas · hash conferido'], ['2026-11-03 14:30', 'RH / DP', 'Arquivado em 10 — Desligamento']) }),
  P('PG-0002', 'Bruno Fictício Lima', '***.987.321-**', 'DEMO-0102', 1, 'salario', 'Salário mensal', '2026-10', 2954.67, '2026-10-31', '2026-10-31', 875424, 'liquidado', OK4, dOf('Comprovante_Salario_Fictício.pdf', 96), { cenarios: [2, 14], pasta: '08 — Recibos e Contracheques › Comprovantes Bancários', arquivado: true, hist: hist(['2026-10-31 11:41', 'Itaú', 'Débito individual identificado no extrato'], ['2026-11-03 10:06', 'Financeiro', 'Comprovante importado e validado'], ['2026-11-03 14:31', 'RH / DP', 'Arquivado no prontuário, pasta 08']) }),
  P('PG-0003', 'Carla Exemplo Moura', '***.654.987-**', 'DEMO-0103', 3, 'adiantamento', 'Adiantamento salarial', '2026-10', 1000, '2026-10-20', '2026-10-20', 875011, 'liquidado', OK4, dOf('Comprovante_Adiantamento_Exemplo.pdf', 88), { cenarios: [3], hist: hist(['2026-10-20 10:02', 'Itaú', 'Débito individual identificado no extrato'], ['2026-10-22 16:20', 'Financeiro', 'Comprovante importado']) }),
  P('PG-0004', 'Diego Fictício Alves', '***.321.456-**', 'DEMO-0104', 4, 'ferias', 'Férias', '2026-10', 3420, '2026-10-30', '2026-10-30', 875302, 'liquidado', OK4, dOf('Comprovante_Ferias_Fictício.pdf', 92), { hist: hist(['2026-10-30 10:15', 'Itaú', 'Débito individual identificado no extrato']) }),
  P('PG-0005', 'Elisa Exemplo Prado', '***.789.123-**', 'DEMO-0105', 5, 'salario', 'Folha complementar', '2026-10', 1477.33, '2026-11-06', null, null, 'agendado', ['ok', 'ok', 'pendente', 'pendente'], [{ classe: 'ordem', nome: 'Ordem_Agendada_Exemplo.pdf', kb: 44, origem: 'Agenda do Itaú Empresas · NÃO comprova pagamento' }], { cenarios: [5], hist: hist(['2026-11-03 17:02', 'Financeiro', 'Agendamento informado para 06/11. Ainda não é pagamento']) }),
  P('PG-0006', 'Fábio Fictício Rocha', '***.147.258-**', 'DEMO-0106', 6, 'decimo', '13º salário · 1ª parcela', '2026-10', 1389.5, '2026-10-30', '2026-10-30', 875355, 'comprovante_indisponivel', ['ok', 'ok', 'ok', 'pendente'], [], { cenarios: [6], hist: hist(['2026-10-30 10:20', 'Itaú', 'Débito confirmado no extrato. A API não entrega o comprovante'], ['2026-11-01 08:00', 'Sistema', 'Pendência aberta para o Financeiro importar o PDF']) }),
  P('PG-0007', 'Gabriela Exemplo Dias', '***.258.369-**', 'DEMO-0107', 2, 'salario', 'Salário mensal', '2026-10', 2210.4, '2026-10-31', '2026-10-31', 875440, 'divergente', ['ok', 'ok', 'falha', 'pendente'], [], { cenarios: [7], motivo: 'O CPF do favorecido no banco não confere com o CPF do funcionário. Associação automática bloqueada.', hist: hist(['2026-10-31 11:42', 'Sistema', 'CPF divergente: vínculo automático bloqueado, enviado para conferência']) }),
  P('PG-0008', 'Heitor Fictício Melo', '***.369.147-**', 'DEMO-0108', 3, 'salario', 'Salário mensal', '2026-10', 3105.8, '2026-10-31', '2026-10-31', 875441, 'divergente', ['ok', 'ok', 'falha', 'pendente'], [], { cenarios: [8], motivo: 'Folha R$ 3.105,80 × banco R$ 3.005,80 (diferença de R$ 100,00). O RH não ajusta valor para forçar a conciliação.', hist: hist(['2026-10-31 11:43', 'Sistema', 'Valor divergente: encaminhado ao Financeiro']) }),
  P('PG-0009', 'Iara Exemplo Nunes', '***.951.753-**', 'DEMO-0109', 10, 'salario', 'Salário mensal', '2026-10', 2750, '2026-10-31', null, null, 'aguardando_envio', ['ok', 'pendente', 'pendente', 'pendente'], [], { motivo: 'CD sem API de extrato: a confirmação depende do chamado no Itaú ou da importação manual.', hist: hist(['2026-10-31 18:00', 'Sistema', 'Sem conta do CD na API: não verificado']) }),
  P('PG-0015', 'João Fictício Barros', '***.753.159-**', 'DEMO-0115', 4, 'rescisao', 'Diferença rescisória', '2026-09', 845.1, '2026-10-16', '2026-10-16', 874900, 'rejeitado', ['ok', 'ok', 'falha', 'na'], [], { motivo: 'Banco rejeitou a ordem: conta do favorecido encerrada.', hist: hist(['2026-10-16 15:10', 'Financeiro', 'Rejeição registrada a partir do retorno do banco']) }),
  P('PG-0016', 'Karina Exemplo Teles', '***.852.456-**', 'DEMO-0116', 5, 'abono', 'Abono', '2026-10', 350, '2026-10-10', '2026-10-10', 874210, 'devolvido', ['ok', 'ok', 'falha', 'na'], [], { motivo: 'Valor devolvido pelo banco do favorecido dois dias depois do débito.', hist: hist(['2026-10-12 09:30', 'Financeiro', 'Devolução registrada']) }),
  P('PG-0017', 'Lucas Fictício Pires', '***.456.852-**', 'DEMO-0117', 6, 'acordo', 'Acordo trabalhista autorizado', '2026-10', 5200, '2026-10-29', '2026-10-29', 875210, 'liquidado', OK4, dOf('Comprovante_Acordo_Fictício.pdf', 110), { hist: hist(['2026-10-29 10:40', 'Itaú', 'Débito individual identificado no extrato']) }),
  // transferência entre unidades: o pagamento sai pelo CNPJ de quem pagou, não pela loja atual do funcionário
  P('PG-0018', 'Marina Exemplo Couto', '***.159.357-**', 'DEMO-0118', 1, 'salario', 'Salário mensal · transferida E3 → E1 em 15/10', '2026-10', 2480.9, '2026-10-31', '2026-10-31', 875425, 'liquidado', OK4, dOf('Comprovante_Salario_Exemplo.pdf', 96), { hist: hist(['2026-10-31 11:41', 'Itaú', 'Débito identificado no CNPJ da E1']) }),
  P('PG-0019', 'Nilo Fictício Freitas', '***.357.951-**', 'DEMO-0119', 1, 'adiantamento', 'Adiantamento salarial', '2026-10', 880, '2026-10-20', null, null, 'enviado', ['ok', 'ok', 'pendente', 'pendente'], [{ classe: 'ordem', nome: 'Ordem_Enviada_Fictício.pdf', kb: 40, origem: 'Remessa ao banco · NÃO comprova pagamento' }], { hist: hist(['2026-10-20 09:00', 'Financeiro', 'Ordem enviada. Sem confirmação bancária até agora']) }),
  P('PG-0020', 'Olívia Exemplo Campos', '***.246.135-**', 'DEMO-0120', 2, 'ferias', 'Férias', '2026-11', 2890.75, '2026-11-05', null, null, 'processamento', ['ok', 'ok', 'pendente', 'pendente'], [], { hist: hist(['2026-11-04 08:30', 'Financeiro', 'Lote em processamento no banco']) }),
];

// Lote SISPAG (cenário 4): o extrato só traz total + quantidade. Quem recebeu vem do PDF de comprovantes; quem não aparece vira pendência do Financeiro.
const lote = (id, nome, cpf, idf, valor, ok) => P(id, nome, cpf, idf, 4, 'salario', 'Salário mensal · lote SISPAG', '2026-10', valor, '2026-10-31', '2026-10-31', ok ? 880000 + +id.slice(-2) : null, ok ? 'liquidado' : 'divergente', ok ? OK4 : ['ok', 'ok', 'falha', 'pendente'], ok ? dOf('Comprovantes_SISPAG_E4_31-10.pdf', 412) : [], { lote: 'LOTE-DEMO-01', cenarios: [4], ...(ok ? {} : { motivo: 'O lote fecha com 4 favorecidos identificados. Esta pessoa não aparece no PDF de comprovantes: pendência do Financeiro.' }), hist: hist(['2026-10-31 11:50', 'Itaú', 'Lote debitado: total + quantidade, sem favorecido'], ok ? ['2026-11-03 10:10', 'Financeiro', 'Identificado por nome + valor no PDF de comprovantes do lote'] : ['2026-11-03 10:10', 'Sistema', 'Não identificado no PDF do lote']) });
PAGAMENTOS.push(
  lote('PG-0010', 'Paulo Exemplo Reis', '***.135.246-**', 'DEMO-0110', 2100.5, true), lote('PG-0011', 'Quésia Fictício Sá', '***.864.209-**', 'DEMO-0111', 1980.25, true),
  lote('PG-0012', 'Rafael Exemplo Vaz', '***.209.864-**', 'DEMO-0112', 2315, true), lote('PG-0013', 'Sara Fictício Luz', '***.572.038-**', 'DEMO-0113', 2044.1, true),
  lote('PG-0014', 'Tomás Exemplo Paz', '***.038.572-**', 'DEMO-0114', 1899.9, false),
);
const LOTES = [{ id: 'LOTE-DEMO-01', loja: 4, data: '2026-10-31', total: 10339.75, qtdBanco: 5, descricao: 'SISPAG SALARIOS', identificados: 4 }];

const G = (id, tipo, numero, comp, loja, valor, atualizado, emissao, venc, pag, situacao, extra) => ({ id, tipo, numero, comp, loja, valor, atualizado, emissao, vencimento: venc, pagamento: pag, situacao, origem: 'Importação manual (RH)', coletiva: true, demonstrativo: [], docs: [], hist: [], ...(extra || {}) });
const GUIAS = [
  G('GU-0001', 'fgts_mensal', 'DEMO-GFD-2026-10-E2', '2026-10', 2, 18420.6, null, '2026-11-03', '2026-11-20', null, 'aguardando', { cenarios: [9], docs: [{ classe: 'guia', nome: 'GFD_E2_10-2026.pdf', kb: 210, origem: 'Baixado do FGTS Digital e importado pelo RH' }, { classe: 'demonstrativo', nome: 'Demonstrativo_Trabalhadores_E2.pdf', kb: 340, origem: 'FGTS Digital · importação manual' }], hist: hist(['2026-11-03 15:20', 'RH / DP', 'Guia e demonstrativo importados']) }),
  G('GU-0002', 'fgts_rescisorio', 'DEMO-GFD-RESC-0101', '2026-10', 2, 2184.4, null, '2026-10-22', '2026-10-31', '2026-10-30', 'paga', { cenarios: [10], coletiva: false, origem: 'Importação manual (Financeiro)', demonstrativo: [{ nome: 'Ana Exemplo Souza', cpf: '***.104.221-**', vinculo: 'DEMO-0101', desligamento: '2026-10-21', valor: 2184.4 }], docs: [{ classe: 'guia', nome: 'GFD_Rescisoria_Exemplo.pdf', kb: 180, origem: 'FGTS Digital · importação manual' }, { classe: 'oficial', nome: 'Comprovante_GFD_Rescisoria.pdf', kb: 120, origem: 'Itaú Empresas · importado pelo Financeiro' }], hist: hist(['2026-10-22 11:00', 'RH / DP', 'Guia relacionada ao desligamento'], ['2026-10-31 09:00', 'Financeiro', 'Comprovante importado e validado']) }),
  G('GU-0003', 'darf_folha', 'DEMO-DARF-E1-1026', '2026-10', 1, 6210.15, null, '2026-11-03', '2026-11-20', null, 'aguardando', { cenarios: [11], origem: 'DCTFWeb · importação manual', docs: [{ classe: 'guia', nome: 'DARF_Folha_E1_10-2026.pdf', kb: 74, origem: 'DCTFWeb · importação manual' }], hist: hist(['2026-11-03 16:00', 'Financeiro', 'DARF importado. Natureza: folha']) }),
  G('GU-0004', 'previdencia', 'DEMO-DARF-E3-0926', '2026-09', 3, 9874.3, 10128.44, '2026-10-05', '2026-10-20', null, 'vencida', { cenarios: [12], docs: [{ classe: 'guia', nome: 'DARF_Previdencia_E3_09-2026.pdf', kb: 76, origem: 'DCTFWeb · importação manual' }], hist: hist(['2026-10-21 06:00', 'Sistema', 'Guia vencida sem comprovante']) }),
  G('GU-0005', 'fgts_mensal', 'DEMO-GFD-2026-09-E4', '2026-09', 4, 24410.9, null, '2026-10-06', '2026-10-20', '2026-10-20', 'paga', { docs: [{ classe: 'guia', nome: 'GFD_E4_09-2026.pdf', kb: 214, origem: 'FGTS Digital · importação manual' }, { classe: 'demonstrativo', nome: 'Demonstrativo_Trabalhadores_E4.pdf', kb: 390, origem: 'FGTS Digital · importação manual' }, { classe: 'oficial', nome: 'Comprovante_GFD_E4_09-2026.pdf', kb: 118, origem: 'Itaú Empresas · importado pelo Financeiro' }], demonstrativo: [{ nome: 'Carla Exemplo Moura', cpf: '***.654.987-**', vinculo: 'DEMO-0103', valor: 240.1 }, { nome: 'Diego Fictício Alves', cpf: '***.321.456-**', vinculo: 'DEMO-0104', valor: 273.6 }], hist: hist(['2026-10-21 10:00', 'Financeiro', 'Comprovante validado']) }),
  G('GU-0006', 'fgts_mensal', 'DEMO-GFD-2026-09-E5', '2026-09', 5, 20175.45, null, '2026-10-06', '2026-10-20', '2026-10-20', 'divergente', { motivo: 'Valor no banco difere R$ 34,20 da guia.', docs: [{ classe: 'guia', nome: 'GFD_E5_09-2026.pdf', kb: 205, origem: 'FGTS Digital · importação manual' }], hist: hist(['2026-10-21 10:10', 'Sistema', 'Valor divergente: encaminhado ao Financeiro']) }),
  G('GU-0007', 'darf_folha', 'DEMO-DARF-E6-0926', '2026-09', 6, 5120.8, null, '2026-10-05', '2026-10-20', '2026-10-20', 'paga', { docs: [{ classe: 'guia', nome: 'DARF_Folha_E6_09-2026.pdf', kb: 71, origem: 'DCTFWeb · importação manual' }], semComprovante: true, hist: hist(['2026-10-21 06:00', 'Sistema', 'Débito encontrado no banco, comprovante ainda não localizado']) }),
  G('GU-0008', 'encargos_13', 'DEMO-DARF-13-E2', '2026-11', 2, 3460, null, '2026-11-04', '2026-11-30', null, 'aguardando', { docs: [{ classe: 'guia', nome: 'Encargos_13_E2.pdf', kb: 70, origem: 'Importação manual (RH)' }], hist: hist(['2026-11-04 09:00', 'RH / DP', 'Guia cadastrada']) }),
  G('GU-0009', 'fgts_mensal', 'DEMO-GFD-2026-09-E5', '2026-09', 5, 20175.45, null, '2026-10-06', '2026-10-20', null, 'duplicada', { motivo: 'Mesmo identificador e competência da GU-0006: importação bloqueada até conferência.', docs: [], hist: hist(['2026-10-07 10:40', 'Sistema', 'Duplicidade detectada pelo identificador']) }),
  G('GU-0010', 'fgts_mensal', 'DEMO-GFD-2026-10-CD', '2026-10', 10, 7312.75, null, '2026-11-03', '2026-11-07', null, 'aguardando', { docs: [{ classe: 'guia', nome: 'GFD_CD_10-2026.pdf', kb: 190, origem: 'Importação manual (Financeiro)' }], hist: hist(['2026-11-03 16:30', 'Financeiro', 'Guia importada']) }),
];

const ALERTAS = { nao_confirmado: 'Pagamento não confirmado', sem_comprovante: 'Comprovante indisponível', valor: 'Divergência de valor', cpf: 'CPF ou beneficiário incompatível', rejeitado: 'Pagamento rejeitado', devolvido: 'Pagamento devolvido', guia_proxima: 'Guia próxima do vencimento', guia_vencida: 'Guia vencida', guia_sem_comp: 'Guia paga sem comprovante localizado', guia_duplicada: 'Guia duplicada', sem_comp_doc: 'Documento sem competência', sem_cnpj: 'Documento sem CNPJ', nao_arquivado: 'Comprovante não arquivado' };
const pd = (id, alerta, ref, detalhe, setor, responsavel, situacao, em) => ({ id, alerta, ref, detalhe, setor, responsavel, situacao, em });
const PENDENCIAS = [
  pd('PD-0001', 'cpf', 'PG-0007', 'CPF do favorecido difere do cadastro', 'Financeiro', null, 'aberta', '2026-10-31'), pd('PD-0002', 'valor', 'PG-0008', 'Diferença de R$ 100,00 entre folha e banco', 'Financeiro', 'Financeiro (a designar)', 'em_analise', '2026-10-31'),
  pd('PD-0003', 'sem_comprovante', 'PG-0006', 'Débito confirmado, comprovante não entregue pela API', 'Financeiro', null, 'aberta', '2026-11-01'), pd('PD-0004', 'nao_confirmado', 'PG-0019', 'Ordem enviada em 20/10 sem confirmação', 'Financeiro', null, 'aberta', '2026-10-25'),
  pd('PD-0005', 'nao_confirmado', 'PG-0014', 'Funcionário não identificado no lote LOTE-DEMO-01', 'Financeiro', null, 'aberta', '2026-11-03'), pd('PD-0006', 'rejeitado', 'PG-0015', 'Conta do favorecido encerrada', 'RH / DP', 'RH · Documentação', 'em_analise', '2026-10-16'),
  pd('PD-0007', 'devolvido', 'PG-0016', 'Devolução dois dias após o débito', 'Financeiro', null, 'aberta', '2026-10-12'), pd('PD-0008', 'guia_proxima', 'GU-0010', 'Vence em 3 dias', 'Financeiro', null, 'aberta', '2026-11-04'),
  pd('PD-0009', 'guia_vencida', 'GU-0004', 'Vencida desde 20/10 sem comprovante', 'Financeiro', 'Financeiro (a designar)', 'aberta', '2026-10-21'), pd('PD-0010', 'guia_sem_comp', 'GU-0007', 'Débito localizado, comprovante não', 'Financeiro', null, 'aberta', '2026-10-21'),
  pd('PD-0011', 'guia_duplicada', 'GU-0009', 'Mesmo identificador da GU-0006', 'RH / DP', 'RH · Documentação', 'em_analise', '2026-10-07'), pd('PD-0012', 'sem_comp_doc', 'Importação IM-0007', 'Arquivo sem competência identificável', 'RH / DP', null, 'aberta', '2026-11-02'),
  pd('PD-0013', 'sem_cnpj', 'Importação IM-0008', 'Arquivo sem CNPJ identificável', 'RH / DP', null, 'aberta', '2026-11-02'), pd('PD-0014', 'nao_arquivado', 'PG-0017', 'Comprovante validado e ainda fora do prontuário', 'RH / DP', null, 'aberta', '2026-11-01'),
  pd('PD-0015', 'valor', 'GU-0006', 'Banco difere R$ 34,20 da guia', 'Financeiro', null, 'resolvida', '2026-10-21'),
];
const au = (em, quem, perfil, acao, ref, det) => ({ em, quem, perfil, acao, ref, det });
const AUDITORIA = [
  au('2026-11-04 09:31', 'Usuário Exemplo RH', 'RH / DP', 'Consulta', 'PG-0001', 'Abriu o detalhe do pagamento'), au('2026-11-04 09:31', 'Usuário Exemplo RH', 'RH / DP', 'Download', 'PG-0001', 'Baixou o comprovante · hash conferido'),
  au('2026-11-04 08:12', 'Usuário Exemplo CPD', 'CPD da unidade', 'Acesso negado', 'Módulo', 'Tentativa bloqueada no servidor (403)'), au('2026-11-03 14:31', 'Usuário Exemplo RH', 'RH / DP', 'Arquivamento', 'PG-0002', 'Pasta 08 › Comprovantes Bancários'),
  au('2026-11-03 14:30', 'Usuário Exemplo RH', 'RH / DP', 'Arquivamento', 'PG-0001', 'Pasta 10 — Desligamento'), au('2026-11-03 10:10', 'Usuário Exemplo Financeiro', 'Financeiro', 'Conferência de lote', 'LOTE-DEMO-01', '4 de 5 favorecidos identificados'),
  au('2026-11-03 10:05', 'Usuário Exemplo Financeiro', 'Financeiro', 'Importação', 'PG-0001', 'Origem Itaú Empresas · PDF + hash SHA-256'), au('2026-11-03 09:15', 'Usuário Exemplo Coordenação', 'Coordenação', 'Consulta', 'Painel Geral', 'Indicadores de outubro'),
  au('2026-11-02 17:40', 'Usuário Exemplo RH', 'RH / DP', 'Solicitação de correção', 'PG-0008', 'Enviada ao Financeiro. Valor não alterado'), au('2026-10-07 10:40', 'Sistema', 'Sistema', 'Bloqueio de duplicidade', 'GU-0009', 'Mesmo identificador da GU-0006'),
];

const HOMOLOGACAO = [
  [1, 'Pagamento de rescisão confirmado', 'PG-0001'], [2, 'Pagamento de salário', 'PG-0002'], [3, 'Adiantamento salarial', 'PG-0003'], [4, 'Pagamento em lote', 'LOTE-DEMO-01'], [5, 'Agendado, mas não liquidado', 'PG-0005'],
  [6, 'Comprovante não disponível pela API', 'PG-0006'], [7, 'Divergência de CPF', 'PG-0007'], [8, 'Divergência de valor', 'PG-0008'], [9, 'Guia de FGTS mensal', 'GU-0001'], [10, 'Guia de FGTS rescisório', 'GU-0002'], [11, 'DARF da folha', 'GU-0003'],
  [12, 'Guia vencida', 'GU-0004'], [13, 'Importação manual pelo Financeiro', 'PG-0001'], [14, 'Arquivamento no prontuário', 'PG-0002'], [15, 'Inclusão no Dossiê Jurídico', 'PG-0001'], [16, 'Tentativa de acesso por usuário não autorizado', 'Perfil CPD'],
];
const PERMISSOES = [
  ['Consultar pagamentos trabalhistas', 1, 1, 1, 1, 0], ['Pesquisar por funcionário', 1, 1, 1, 1, 0], ['Consultar guias', 1, 1, 1, 1, 0], ['Visualizar e baixar comprovantes', 1, 1, 1, 1, 0], ['Importar comprovante oficial', 1, 0, 0, 0, 0],
  ['Importar guias e documentos permitidos', 1, 1, 0, 0, 0], ['Conferir conciliação e validar comprovantes', 1, 0, 0, 0, 0], ['Resolver divergências bancárias', 1, 0, 0, 0, 0], ['Solicitar correção', 1, 1, 1, 0, 0], ['Arquivar no prontuário', 0, 1, 0, 0, 0],
  ['Aprovar alteração documental', 0, 0, 1, 0, 0], ['Consultar auditoria', 1, 1, 1, 1, 0], ['Todas as unidades', 1, 1, 1, 1, 0], ['Saldo e extrato geral', 0, 0, 0, 0, 0], ['Executar, agendar ou alterar pagamento', 0, 0, 0, 0, 0],
];

// Medições reais de 04/11/2026: extrato dos últimos 40 dias das 6 contas (mesma chamada que o sistema já faz), só com contagens e formato.
const DIAGNOSTICO = {
  data: '04/11/2026',
  perguntas: [
    { q: 'APIs Itaú disponíveis', st: 'parcial', r: 'Extrato de conta corrente (account-statement v1, 6 lojas). PIX cobrança (Distribuidora, para receber). Cobrança/boleto em implantação. Nenhuma API de pagamentos contratada.' },
    { q: 'Contas e CNPJs integrados', st: 'parcial', r: '6 contas, uma por loja (E1 a E6), com o mesmo escopo: account-statement.read. O CD não tem extrato: 403 no teste de 08/10; o chamado desse produto nunca foi aberto.' },
    { q: 'Consulta de pagamentos efetuados', st: 'parcial', r: 'Só indireta: o pagamento aparece como débito no extrato depois de sair da conta.' },
    { q: 'Identificação de beneficiários', st: 'sim', r: 'Sim para lançamento individual: nome, CPF/CNPJ, banco, agência e conta do favorecido (bloco counterpart).' },
    { q: 'Lote traz dados individuais', st: 'nao', r: 'Não. Em 40 dias foram 59 lotes de salários com 964 lançamentos; cada lote vem só com total, quantidade e data. O detalhe hoje vem do PDF de comprovantes, que a Auditoria da Folha já lê.' },
    { q: 'Situação e liquidação', st: 'parcial', r: 'O extrato só mostra o que já foi debitado. Agendado, enviado, em processamento e rejeitado não aparecem. Nenhum estorno foi visto nas 4 contas em que isso foi medido, então o formato real de devolução ainda é desconhecido.' },
    { q: 'Comprovantes oficiais', st: 'nao', r: 'Não pelas credenciais atuais. Nenhuma API contratada entrega comprovante.' },
    { q: 'Download de comprovantes em PDF', st: 'nao', r: 'Não por API. O PDF sai pelo Itaú Empresas, de forma manual. O site do Itaú informa consulta por até 5 anos.' },
    { q: 'Permissões adicionais necessárias', st: 'a confirmar', r: 'A confirmar com o Itaú: existe manual de “API SISPAG” circulando em cópia não oficial, com inclusão e consulta de pagamentos. Se existir, contratar SÓ o escopo de consulta. Alternativa: arquivo de retorno CNAB do SISPAG. O CD precisa de chamado próprio do extrato.' },
    { q: 'Limites de consulta e armazenamento', st: 'parcial', r: 'Token de 5 min, 8.000 eventos por página. Janelas de 1.500 dias responderam nas contas mais antigas; 2.600 dias dá erro 400. O limite exato não foi medido. A retenção oficial precisa ser confirmada com o Itaú.' },
  ],
  achados: [
    { sev: 'alta', t: 'Rotinas atuais leem só a 1ª página do extrato', d: 'Em 40 dias, 4 das 6 contas têm 2 páginas (Ponte 9.323, Atacarejo 14.109, Porta Larga 15.077, Jardim Jordão 15.360 eventos). Em lib/itau-extrato.js a busca pega uma página só. Janelas acima de cerca de 21 dias nas contas maiores podem perder lançamentos sem aviso, inclusive em conciliações já em produção. Não foi alterado aqui: pede correção separada e aprovada.' },
    { sev: 'alta', t: 'FGTS não é identificável pelo texto do extrato', d: 'Nenhum dos débitos de 40 dias traz “FGTS” no histórico. Aparecem “SISPAG TRIBUTOS DARF” (36) e “SISPAG TRIB COD BARRAS” (8), sem natureza. A guia nova também tem QR Code PIX, então pode sair por outro caminho. Guia só concilia com o documento importado + valor + data, com conferência humana.' },
    { sev: 'media', t: 'DARF do extrato não separa folha de comércio', d: 'O histórico não diz a natureza do DARF. Sem a guia importada, o módulo poderia misturar tributo comercial com obrigação do DP/RH, o que o escopo proíbe.' },
    { sev: 'media', t: 'Módulo de Dossiês Jurídicos não existe', d: 'O escopo pede integração com ele, mas nada foi encontrado no sistema. A Fase F depende de decidir se ele será criado antes.' },
    { sev: 'media', t: 'Papel Financeiro sem pessoa designada', d: 'Todo o fluxo depende desse papel: validar, importar e resolver divergências. A designação é feita em Gestão de Pessoas › Configurações.' },
  ],
  guias: [
    { t: 'FGTS Digital', st: 'nao', d: 'Nenhuma API oficial encontrada em pesquisa pública. Os serviços que existem automatizam o portal com o certificado da empresa, o que o escopo proíbe. Caminho: importação manual pelo RH ou Financeiro.' },
    { t: 'INSS e DARF (DCTFWeb)', st: 'a confirmar', d: 'Candidato: Integra Contador (Serpro/Receita), API paga e com e-CNPJ, que cita consulta da DCTFWeb, emissão de DARF e consulta de pagamentos. Endpoints e custo ainda não validados. Até lá, importação manual.' },
    { t: 'Sistema de folha / contabilidade', st: 'a confirmar', d: 'Verificar se a contabilidade pode entregar guias e demonstrativos em pasta padronizada, como já ocorre com os contracheques.' },
  ],
  reuso: [
    'Auditoria da Folha: leitor do PDF de comprovantes SISPAG, conciliação por nome + valor e robô da pasta do Drive.',
    'Gestão Documental: pastas 08 e 10, protocolo, hash SHA-256, versões e autorização da Coordenação.',
    'Gestão de Pessoas e PontoCerto: identificador permanente do funcionário e CPF. Nenhum cadastro novo.',
    'Pagamentos Dom/Feriados: regra de lote único e sugestão para o Financeiro confirmar.',
  ],
  etapas: [
    'Coordenação aprova as telas e o escopo desta fase.',
    'Autorizar a correção da paginação do extrato, como mudança separada do Financeiro.',
    'Designar quem responde pelo papel Financeiro.',
    'Perguntar ao Itaú: há API só de consulta de pagamentos, com detalhe do lote e PDF? Há retorno CNAB? Qual a retenção?',
    'Abrir o chamado de extrato da conta do CD.',
    'Decidir sobre o Dossiê Jurídico: criar antes da Fase F ou retirar da Fase F.',
    'Avaliar custo e contratação do Integra Contador para INSS e DARF.',
    'Com as respostas acima, iniciar a Fase C.',
  ],
};

// ── PROMPT 05, Guias e Encargos (04/11/2026). conc = conferência da guia contra o banco: cada critério ok | falha | nd (não vem no extrato).
// O extrato não traz número da guia nem competência, então o identificador nunca confirma nada sozinho e nenhuma guia quita sem o Financeiro.
const crit = (cnpj, valor, competencia, data) => ({ identificador: 'nd', cnpj, valor, competencia, data });
const deb = (data, valor, historico) => ({ data, valor, historico });
const PIX_CEF = 'SISPAG FORNECEDORES PIX · CEF MATRIZ', DARF_TXT = 'SISPAG TRIBUTOS DARF';
GUIAS.push(
  G('GU-0011', 'fgts_mensal', 'DEMO-GFD-2026-09-E6', '2026-09', 6, 15230.2, null, '2026-10-06', '2026-10-20', null, 'parcial', { motivo: 'O banco mostra R$ 12.000,00 para uma guia de R$ 15.230,20. Faltam R$ 3.230,20.', docs: [{ classe: 'guia', nome: 'GFD_E6_09-2026.pdf', kb: 201, origem: 'FGTS Digital · importação manual' }], hist: hist(['2026-10-21 06:10', 'Sistema', 'Débito menor que a guia: pagamento parcial']) }),
  G('GU-0012', 'fgts_rescisorio', 'DEMO-GFD-RESC-0115', '2026-09', 3, 912.35, null, '2026-10-02', '2026-10-13', null, 'devolvida', { coletiva: false, motivo: 'O débito voltou para a conta dois dias depois. A guia segue em aberto.', demonstrativo: [{ nome: 'João Fictício Barros', cpf: '***.753.159-**', vinculo: 'DEMO-0115', desligamento: '2026-10-01', valor: 912.35 }], docs: [{ classe: 'guia', nome: 'GFD_Rescisoria_Fictício.pdf', kb: 176, origem: 'FGTS Digital · importação manual' }], hist: hist(['2026-10-15 09:20', 'Financeiro', 'Devolução registrada']) }),
  G('GU-0013', 'darf_folha', 'DEMO-DARF-E4-0926', '2026-09', 4, 7410.6, null, '2026-10-05', '2026-10-20', null, 'rejeitada', { origem: 'DCTFWeb · importação manual', motivo: 'O Financeiro informou rejeição do pagamento pelo banco.', docs: [{ classe: 'guia', nome: 'DARF_Folha_E4_09-2026.pdf', kb: 73, origem: 'DCTFWeb · importação manual' }], hist: hist(['2026-10-20 16:00', 'Financeiro', 'Rejeição registrada']) }),
  G('GU-0014', 'fgts_mensal', 'DEMO-GFD-2026-09-E1', '2026-09', 1, 9840.15, null, '2026-10-06', '2026-10-20', null, 'conferencia', { docs: [{ classe: 'guia', nome: 'GFD_E1_09-2026.pdf', kb: 198, origem: 'FGTS Digital · importação manual' }, { classe: 'demonstrativo', nome: 'Demonstrativo_Trabalhadores_E1.pdf', kb: 310, origem: 'FGTS Digital · importação manual' }], demonstrativo: [{ nome: 'Bruno Fictício Lima', cpf: '***.987.321-**', vinculo: 'DEMO-0102', valor: 236.37 }, { nome: 'Marina Exemplo Couto', cpf: '***.159.357-**', vinculo: 'DEMO-0118', valor: 198.47 }], hist: hist(['2026-10-21 06:10', 'Sistema', 'Débito com mesma loja, valor e data: sugestão para o Financeiro']) }),
  G('GU-0015', 'previdencia', 'DEMO-DARF-E2-0926', '2026-09', 2, 11280.5, null, '2026-10-05', '2026-10-20', null, 'pag_duplicado', { origem: 'DCTFWeb · importação manual', motivo: 'Dois débitos de mesmo valor para a mesma obrigação. O Financeiro decide qual vale e pede a restituição.', docs: [{ classe: 'guia', nome: 'DARF_Previdencia_E2_09-2026.pdf', kb: 75, origem: 'DCTFWeb · importação manual' }], hist: hist(['2026-10-23 06:10', 'Sistema', 'Segundo débito de mesmo valor encontrado']) }),
  G('GU-0016', 'fgts_rescisorio', 'DEMO-GFD-RESC-0201', '2026-10', 5, 640.4, null, '2026-10-20', '2026-10-30', '2026-10-28', 'paga', { coletiva: false, lote: 'LOTE-GUIA-01', demonstrativo: [{ nome: 'Karina Exemplo Teles', cpf: '***.852.456-**', vinculo: 'DEMO-0116', desligamento: '2026-10-18', valor: 640.4 }], docs: [{ classe: 'guia', nome: 'GFD_Rescisoria_Exemplo.pdf', kb: 170, origem: 'FGTS Digital · importação manual' }, { classe: 'oficial', nome: 'Comprovante_Lote_GFD_E5.pdf', kb: 130, origem: 'Itaú Empresas · importado pelo Financeiro' }], hist: hist(['2026-10-29 10:00', 'Financeiro', 'Conciliada no lote LOTE-GUIA-01']) }),
  G('GU-0017', 'fgts_rescisorio', 'DEMO-GFD-RESC-0202', '2026-10', 5, 1125.9, null, '2026-10-20', '2026-10-30', '2026-10-28', 'paga', { coletiva: false, lote: 'LOTE-GUIA-01', demonstrativo: [{ nome: 'Elisa Exemplo Prado', cpf: '***.789.123-**', vinculo: 'DEMO-0105', desligamento: '2026-10-19', valor: 1125.9 }], docs: [{ classe: 'guia', nome: 'GFD_Rescisoria_Exemplo2.pdf', kb: 168, origem: 'FGTS Digital · importação manual' }, { classe: 'oficial', nome: 'Comprovante_Lote_GFD_E5.pdf', kb: 130, origem: 'Itaú Empresas · importado pelo Financeiro' }], hist: hist(['2026-10-29 10:00', 'Financeiro', 'Conciliada no lote LOTE-GUIA-01']) }),
);
const CONC = {
  'GU-0002': { res: 'confirmada', debitos: [deb('2026-10-30', 2184.4, PIX_CEF)], crit: crit('ok', 'ok', 'ok', 'ok') },
  'GU-0005': { res: 'confirmada', debitos: [deb('2026-10-20', 24410.9, PIX_CEF)], crit: crit('ok', 'ok', 'ok', 'ok') },
  'GU-0006': { res: 'divergente', debitos: [deb('2026-10-20', 20141.25, PIX_CEF)], crit: crit('ok', 'falha', 'ok', 'ok') },
  'GU-0007': { res: 'confirmada', debitos: [deb('2026-10-20', 5120.8, DARF_TXT)], crit: crit('ok', 'ok', 'ok', 'ok') },
  'GU-0009': { res: 'sem_debito', debitos: [], crit: crit('nd', 'nd', 'nd', 'nd') },
  'GU-0011': { res: 'parcial', debitos: [deb('2026-10-20', 12000, PIX_CEF)], crit: crit('ok', 'falha', 'ok', 'ok') },
  'GU-0012': { res: 'devolvida', debitos: [deb('2026-10-13', 912.35, PIX_CEF)], crit: crit('ok', 'ok', 'ok', 'ok') },
  'GU-0013': { res: 'rejeitada', debitos: [], crit: crit('nd', 'nd', 'nd', 'nd') },
  'GU-0014': { res: 'sugestao', debitos: [deb('2026-10-20', 9840.15, 'SISPAG PIX QR-CODE · CEF MATRIZ')], crit: crit('ok', 'ok', 'ok', 'ok') },
  'GU-0015': { res: 'duplicada', debitos: [deb('2026-10-20', 11280.5, DARF_TXT), deb('2026-10-23', 11280.5, DARF_TXT)], crit: crit('ok', 'ok', 'ok', 'ok') },
  'GU-0016': { res: 'confirmada', debitos: [deb('2026-10-28', 1766.3, PIX_CEF)], crit: crit('ok', 'ok', 'ok', 'ok') },
  'GU-0017': { res: 'confirmada', debitos: [deb('2026-10-28', 1766.3, PIX_CEF)], crit: crit('ok', 'ok', 'ok', 'ok') },
};
for (const g of GUIAS) g.conc = CONC[g.id] || { res: 'sem_debito', debitos: [], crit: crit('nd', 'nd', 'nd', 'nd') };
const RES_CONC = { confirmada: 'Confirmada pelo Financeiro', sugestao: 'Sugestão para confirmar', parcial: 'Pagamento parcial', duplicada: 'Pagamento duplicado', devolvida: 'Devolvida', rejeitada: 'Rejeitada', divergente: 'Divergente', sem_debito: 'Sem débito' };
const CRITERIOS = { identificador: 'Identificador', cnpj: 'CNPJ pagador', valor: 'Valor', competencia: 'Competência', data: 'Data' };
const LOTES_GUIA = [{ id: 'LOTE-GUIA-01', loja: 5, data: '2026-10-28', total: 1766.3, guias: ['GU-0016', 'GU-0017'] }];
PENDENCIAS.push(
  pd('PD-0017', 'rejeitado', 'GU-0013', 'Pagamento da guia rejeitado', 'Financeiro', null, 'aberta', '2026-10-20'),
  pd('PD-0018', 'devolvido', 'GU-0012', 'Débito devolvido dois dias depois', 'Financeiro', null, 'aberta', '2026-10-15'), pd('PD-0019', 'valor', 'GU-0011', 'Pagamento parcial: faltam R$ 3.230,20', 'Financeiro', null, 'aberta', '2026-10-21'),
  pd('PD-0020', 'valor', 'GU-0015', 'Dois débitos para a mesma guia', 'Financeiro', null, 'aberta', '2026-10-23'),
);
// agrupa as chaves de ALERTAS nos seis avisos da seção 7 do PROMPT 05
const ALERTAS_GUIA = [{ t: 'Próximas do vencimento', k: ['guia_proxima'] }, { t: 'Vencidas sem confirmação', k: ['guia_vencida'] }, { t: 'Rejeitados ou devolvidos', k: ['rejeitado', 'devolvido'] }, { t: 'Divergências de valor', k: ['valor'] }, { t: 'Comprovantes indisponíveis', k: ['guia_sem_comp'] }, { t: 'Sem competência ou CNPJ', k: ['sem_comp_doc', 'sem_cnpj'] }];

// Medições reais de 04/11/2026: títulos do contas a pagar do ERP (só leitura) × débitos do extrato de 20/08 a 04/11, por loja + valor.
DIAGNOSTICO.medicao = [
  { n: '46 de 48', t: 'débitos para a CEF têm título no ERP', d: 'FGTS mensal, rescisório e multa, com mesma loja e mesmo valor.' },
  { n: '17 de 25', t: 'títulos de INSS têm DARF no banco', d: 'Mesma loja e mesmo valor. Os outros 8 não foram localizados.' },
  { n: '0', t: 'números de guia no extrato', d: 'Só um código interno do banco. Competência também não vem.' },
  { n: '6 de 6', t: 'contas têm PIX para a CEF', d: 'Cinco com o rótulo de fornecedor, uma com PIX QR-Code. Falta o Financeiro confirmar.' },
];
DIAGNOSTICO.guias = [
  { t: 'Contas a pagar do ERP', st: 'parcial', d: 'É a melhor fonte que já existe: tem unidade, vencimento, valor e competência. Liga o débito ao título por loja e valor, mas não traz a guia nem o demonstrativo. Serve para sugerir, não para quitar. O CD fica sem o lado do banco.' },
  { t: 'Extrato Itaú', st: 'parcial', d: 'Confirma que saiu dinheiro, com data, valor e favorecido. Não informa número da guia nem competência. Por isso nenhum débito liquida uma guia sozinho.' },
  { t: 'FGTS Digital', st: 'nao', d: 'Nenhuma API oficial encontrada em pesquisa pública. Os serviços que existem automatizam o portal com o certificado da empresa, o que o escopo proíbe. Caminho: importação manual pelo RH ou Financeiro.' },
  { t: 'INSS e DARF (DCTFWeb)', st: 'a confirmar', d: 'Candidato: Integra Contador (Serpro/Receita), API paga e com e-CNPJ, que cita consulta da DCTFWeb, emissão de DARF e consulta de pagamentos. Endpoints e custo ainda não validados. Até lá, importação manual.' },
  { t: 'Sistema de folha / contabilidade', st: 'a confirmar', d: 'Verificar se a contabilidade pode entregar guias e demonstrativos em pasta padronizada, como já ocorre com os contracheques. O robô da Auditoria da Folha pode ser reaproveitado.' },
];
DIAGNOSTICO.achados.find(a => /^FGTS/.test(a.t)).t = 'FGTS sai como pagamento a fornecedor';
DIAGNOSTICO.achados.find(a => /^FGTS sai/.test(a.t)).d = 'O histórico nunca traz “FGTS”. O pagamento aparece como PIX para CEF MATRIZ, quase sempre com o rótulo SISPAG FORNECEDORES PIX. De 20/08 a 04/11 foram 48 débitos, e 46 têm título de FGTS no ERP com mesma loja e valor. A guia só concilia com documento importado e confirmação do Financeiro.';
DIAGNOSTICO.achados.push({ sev: 'media', t: 'Conta 12.20 do ERP mistura pessoal com outros tributos', d: 'A conta “FGTS/INSS/ISS/DAS” também tem ISS, Simples, sindicato e rateios, em texto livre. Para não misturar tributo comercial com encargo de pessoal, a importação precisa de conferência humana e não pode usar a conta sozinha.' });
DIAGNOSTICO.etapas.splice(DIAGNOSTICO.etapas.length - 1, 0, 'Confirmar com o Financeiro que os PIX para CEF MATRIZ são FGTS e como são lançados no ERP.');

module.exports = { HOJE, LOJAS, TIPOS, SITUACOES, TIPOS_GUIA, SIT_GUIA, CLASSE_DOC, ALERTAS, PAGAMENTOS, LOTES, GUIAS, PENDENCIAS, AUDITORIA, HOMOLOGACAO, PERMISSOES, DIAGNOSTICO, RES_CONC, CRITERIOS, LOTES_GUIA, ALERTAS_GUIA };
