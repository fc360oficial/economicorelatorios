'use strict';
// lib/comprovantes-bancarios.js — DP / RH › Comprovantes Bancários (04/11/2026). Catálogo (tipos, situações, alertas, permissões), o
// diagnóstico medido das integrações e a base REAL do módulo em data/comprovantes-bancarios/ (gitignored). A base nasce vazia: os
// registros de pagamentos, guias, lotes e pendências entram na Fase C (importação pelo Financeiro e vínculo com Auditoria da Folha).
// Nenhum dado fictício: o que não existe aparece vazio na tela. Nada aqui movimenta dinheiro.
const fs = require('fs');
const path = require('path');
const DIR = process.env.COMPROVANTES_DIR || path.join(__dirname, '..', 'data', 'comprovantes-bancarios');
const P = { pagamentos: path.join(DIR, 'pagamentos.json'), guias: path.join(DIR, 'guias.json'), lotes: path.join(DIR, 'lotes.json'), lotesGuia: path.join(DIR, 'lotes-guia.json'), pendencias: path.join(DIR, 'pendencias.json'), auditoria: path.join(DIR, 'auditoria.jsonl') };
const lerJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } };
const lerLinhas = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

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
const ALERTAS = { nao_confirmado: 'Pagamento não confirmado', sem_comprovante: 'Comprovante indisponível', valor: 'Divergência de valor', cpf: 'CPF ou beneficiário incompatível', rejeitado: 'Pagamento rejeitado', devolvido: 'Pagamento devolvido', guia_proxima: 'Guia próxima do vencimento', guia_vencida: 'Guia vencida', guia_sem_comp: 'Guia paga sem comprovante localizado', guia_duplicada: 'Guia duplicada', sem_comp_doc: 'Documento sem competência', sem_cnpj: 'Documento sem CNPJ', nao_arquivado: 'Comprovante não arquivado' };
const RES_CONC = { confirmada: 'Confirmada pelo Financeiro', sugestao: 'Sugestão para confirmar', parcial: 'Pagamento parcial', duplicada: 'Pagamento duplicado', devolvida: 'Devolvida', rejeitada: 'Rejeitada', divergente: 'Divergente', sem_debito: 'Sem débito' };
const CRITERIOS = { identificador: 'Identificador', cnpj: 'CNPJ pagador', valor: 'Valor', competencia: 'Competência', data: 'Data' };
const ALERTAS_GUIA = [{ t: 'Próximas do vencimento', k: ['guia_proxima'] }, { t: 'Vencidas sem confirmação', k: ['guia_vencida'] }, { t: 'Rejeitados ou devolvidos', k: ['rejeitado', 'devolvido'] }, { t: 'Divergências de valor', k: ['valor'] }, { t: 'Comprovantes indisponíveis', k: ['guia_sem_comp'] }, { t: 'Sem competência ou CNPJ', k: ['sem_comp_doc', 'sem_cnpj'] }];
// cenários de homologação (seção 15): o exemplo real de cada um é apontado quando existir registro na base
const HOMOLOGACAO = [[1, 'Pagamento de rescisão confirmado', null], [2, 'Pagamento de salário', null], [3, 'Adiantamento salarial', null], [4, 'Pagamento em lote', null], [5, 'Agendado, mas não liquidado', null], [6, 'Comprovante não disponível pela API', null], [7, 'Divergência de CPF', null], [8, 'Divergência de valor', null], [9, 'Guia de FGTS mensal', null], [10, 'Guia de FGTS rescisório', null], [11, 'DARF da folha', null], [12, 'Guia vencida', null], [13, 'Importação manual pelo Financeiro', null], [14, 'Arquivamento no prontuário', null], [15, 'Inclusão no Dossiê Jurídico', null], [16, 'Tentativa de acesso por usuário não autorizado', 'Perfil CPD']];
const PERMISSOES = [
  ['Consultar pagamentos trabalhistas', 1, 1, 1, 1, 0], ['Pesquisar por funcionário', 1, 1, 1, 1, 0], ['Consultar guias', 1, 1, 1, 1, 0], ['Visualizar e baixar comprovantes', 1, 1, 1, 1, 0], ['Importar comprovante oficial', 1, 0, 0, 0, 0],
  ['Importar guias e documentos permitidos', 1, 1, 0, 0, 0], ['Conferir conciliação e validar comprovantes', 1, 0, 0, 0, 0], ['Resolver divergências bancárias', 1, 0, 0, 0, 0], ['Solicitar correção', 1, 1, 1, 0, 0], ['Arquivar no prontuário', 0, 1, 0, 0, 0],
  ['Aprovar alteração documental', 0, 0, 1, 0, 0], ['Consultar auditoria', 1, 1, 1, 1, 0], ['Todas as unidades', 1, 1, 1, 1, 0], ['Saldo e extrato geral', 0, 0, 0, 0, 0], ['Executar, agendar ou alterar pagamento', 0, 0, 0, 0, 0],
];
// Medições reais de 04/11/2026 (só leitura): extrato das 6 contas (40 dias) e cruzamento com o contas a pagar do ERP (20/08 a 04/11).
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
    { q: 'Limites de consulta e armazenamento', st: 'parcial', r: 'Token de 5 min, 8.000 eventos por página (desde 04/11 o sistema lê todas as páginas). Janelas de 1.500 dias responderam nas contas mais antigas; 2.600 dias dá erro 400. A retenção oficial precisa ser confirmada com o Itaú.' },
  ],
  achados: [
    { sev: 'media', t: 'Paginação do extrato corrigida em 04/11', d: 'Até então as rotinas liam só a 1ª página (8.000 eventos) e, em 40 dias, E3, E4, E5 e E6 tinham 2 páginas. Validação antes × depois: E3 7.934→9.351, E4 7.955→14.145, E5 7.958→15.103, E6 7.959→15.413 eventos. Conciliações antigas dessas lojas em janelas longas podem precisar de reconciliação.' },
    { sev: 'alta', t: 'FGTS sai como pagamento a fornecedor', d: 'O histórico nunca traz “FGTS”. O pagamento aparece como PIX para CEF MATRIZ, quase sempre com o rótulo SISPAG FORNECEDORES PIX. De 20/08 a 04/11 foram 48 débitos, e 46 têm título de FGTS no ERP com mesma loja e valor. A guia só concilia com documento importado e confirmação do Financeiro.' },
    { sev: 'media', t: 'DARF do extrato não separa folha de comércio', d: 'O histórico não diz a natureza do DARF. Sem a guia importada, o módulo poderia misturar tributo comercial com obrigação do DP/RH, o que o escopo proíbe.' },
    { sev: 'media', t: 'Conta 12.20 do ERP mistura pessoal com outros tributos', d: 'A conta “FGTS/INSS/ISS/DAS” também tem ISS, Simples, sindicato e rateios, em texto livre. Para não misturar tributo comercial com encargo de pessoal, a importação precisa de conferência humana e não pode usar a conta sozinha.' },
    { sev: 'media', t: 'Módulo de Dossiês Jurídicos não existe', d: 'Mantido no projeto pela Coordenação (04/11) para fase posterior: processo + funcionário → documentos → volumes de até 2 MB, originais e assinaturas preservados.' },
    { sev: 'media', t: 'Papel Financeiro sem pessoa designada', d: 'Todo o fluxo depende desse papel: validar, importar e resolver divergências. A designação é feita em Gestão de Pessoas › Configurações, só com autorização da Coordenação.' },
  ],
  medicao: [
    { n: '46 de 48', t: 'débitos para a CEF têm título no ERP', d: 'FGTS mensal, rescisório e multa, com mesma loja e mesmo valor.' },
    { n: '17 de 25', t: 'títulos de INSS têm DARF no banco', d: 'Mesma loja e mesmo valor. Os outros 8 não foram localizados.' },
    { n: '0', t: 'números de guia no extrato', d: 'Só um código interno do banco. Competência também não vem.' },
    { n: '6 de 6', t: 'contas têm PIX para a CEF', d: 'Cinco com o rótulo de fornecedor, uma com PIX QR-Code. Falta o Financeiro confirmar.' },
  ],
  guias: [
    { t: 'Contas a pagar do ERP', st: 'parcial', d: 'É a melhor fonte que já existe: tem unidade, vencimento, valor e competência. Liga o débito ao título por loja e valor, mas não traz a guia nem o demonstrativo. Serve para sugerir, não para quitar. O CD fica sem o lado do banco.' },
    { t: 'Extrato Itaú', st: 'parcial', d: 'Confirma que saiu dinheiro, com data, valor e favorecido. Não informa número da guia nem competência. Por isso nenhum débito liquida uma guia sozinho.' },
    { t: 'FGTS Digital', st: 'nao', d: 'Nenhuma API oficial encontrada em pesquisa pública. Os serviços que existem automatizam o portal com o certificado da empresa, o que o escopo proíbe. Caminho: importação manual pelo RH ou Financeiro.' },
    { t: 'INSS e DARF (DCTFWeb)', st: 'a confirmar', d: 'Candidato: Integra Contador (Serpro/Receita), API paga e com e-CNPJ, que cita consulta da DCTFWeb, emissão de DARF e consulta de pagamentos. Endpoints e custo ainda não validados. Até lá, importação manual.' },
    { t: 'Sistema de folha / contabilidade', st: 'a confirmar', d: 'Verificar se a contabilidade pode entregar guias e demonstrativos em pasta padronizada, como já ocorre com os contracheques. O robô da Auditoria da Folha pode ser reaproveitado.' },
  ],
  reuso: [
    'Auditoria da Folha: leitor do PDF de comprovantes SISPAG, conciliação por nome + valor e robô da pasta do Drive.',
    'Gestão Documental: pastas 08 (tipo "Comprovante bancário" criado em 04/11) e 10, protocolo, hash SHA-256, versões e autorização da Coordenação.',
    'Gestão de Pessoas e PontoCerto: identificador permanente do funcionário e CPF. Nenhum cadastro novo.',
    'Pagamentos Dom/Feriados: regra de lote único e sugestão para o Financeiro confirmar.',
  ],
  etapas: [
    'Fase C autorizada em 04/11: estruturar pagamentos, lotes, comprovantes e vínculos nesta base, preservando os registros existentes.',
    'Designar quem responde pelo papel Financeiro (só com autorização da Coordenação).',
    'Perguntar ao Itaú: há API só de consulta de pagamentos, com detalhe do lote e PDF? Há retorno CNAB? Qual a retenção?',
    'Abrir o chamado de extrato da conta do CD.',
    'Confirmar com o Financeiro que os PIX para CEF MATRIZ são FGTS e como são lançados no ERP.',
    'Avaliar custo e contratação do Integra Contador para INSS e DARF.',
    'Homologar com os 16 cenários antes de liberar a operação.',
  ],
};

/** tudo que a tela precisa: catálogo + base real (vazia até a Fase C) */
function dados() {
  return { HOJE: hojeISO(), LOJAS, TIPOS, SITUACOES, TIPOS_GUIA, SIT_GUIA, CLASSE_DOC, ALERTAS, RES_CONC, CRITERIOS, ALERTAS_GUIA, HOMOLOGACAO, PERMISSOES, DIAGNOSTICO,
    PAGAMENTOS: lerJson(P.pagamentos, []), GUIAS: lerJson(P.guias, []), LOTES: lerJson(P.lotes, []), LOTES_GUIA: lerJson(P.lotesGuia, []), PENDENCIAS: lerJson(P.pendencias, []), AUDITORIA: lerLinhas(P.auditoria).slice(-200).reverse() };
}
module.exports = { DIR, LOJAS, TIPOS, SITUACOES, TIPOS_GUIA, SIT_GUIA, CLASSE_DOC, ALERTAS, RES_CONC, CRITERIOS, ALERTAS_GUIA, HOMOLOGACAO, PERMISSOES, DIAGNOSTICO, dados };
