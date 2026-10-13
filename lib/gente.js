'use strict';
// Gente & Gestão — registros próprios do DP e do RH (13/10/2026, Tiago: "transformar DP e RH num setor profissional
// de verdade, que traz tudo pro dia a dia"). O cadastro, o ponto e o banco de horas vêm do PontoCerto
// (lib/pontocerto.js); o que o ponto não tem (ASO/exames, ocorrências disciplinares, férias programadas, vagas,
// treinamentos, avaliações, movimentações, quadro previsto) fica aqui, em data/gente/<colecao>.json.
// Cada registro: { id, ...campos, criado_em, criado_por, atualizado_em, atualizado_por } — exclusão é física,
// mas fica no data/gente/_lixeira.json pra auditoria.
const fs = require('fs');
const path = require('path');
const pontocerto = require('./pontocerto');

const DIR = path.join(__dirname, '..', 'data', 'gente');
const COLECOES = {
  // DP
  ocorrencias:   { campos: ['colab_id', 'nome', 'loja', 'setor', 'cargo', 'tipo', 'data', 'motivo', 'dias', 'assinada', 'obs'], obrig: ['nome', 'tipo', 'data'] },
  documentos:    { campos: ['colab_id', 'nome', 'loja', 'setor', 'cargo', 'tipo', 'emissao', 'validade', 'obs'], obrig: ['nome', 'tipo'] },
  ferias:        { campos: ['colab_id', 'nome', 'loja', 'setor', 'cargo', 'aquisitivo_ini', 'aquisitivo_fim', 'inicio', 'fim', 'dias', 'abono', 'status', 'obs'], obrig: ['nome', 'inicio', 'fim'] },
  // RH
  vagas:         { campos: ['titulo', 'loja', 'setor', 'cargo', 'qtd', 'motivo', 'abertura', 'prazo', 'status', 'responsavel', 'candidatos', 'obs'], obrig: ['titulo', 'loja'] },
  treinamentos:  { campos: ['nome', 'descricao', 'validade_meses', 'setores', 'carga_h', 'obrigatorio'], obrig: ['nome'] },
  capacitacoes:  { campos: ['treinamento_id', 'treinamento', 'colab_id', 'nome', 'loja', 'setor', 'cargo', 'data', 'validade', 'instrutor', 'nota', 'obs'], obrig: ['nome', 'treinamento', 'data'] },
  avaliacoes:    { campos: ['colab_id', 'nome', 'loja', 'setor', 'cargo', 'tipo', 'prevista', 'realizada', 'avaliador', 'nota', 'fortes', 'melhorar', 'decisao', 'obs'], obrig: ['nome', 'tipo'] },
  movimentacoes: { campos: ['colab_id', 'nome', 'loja', 'setor', 'cargo', 'tipo', 'data', 'de', 'para', 'motivo', 'iniciativa', 'obs'], obrig: ['nome', 'tipo', 'data'] },
  quadro:        { campos: ['loja', 'setor', 'previsto', 'obs'], obrig: ['loja', 'setor', 'previsto'] },
};
const TIPOS = {
  ocorrencia: ['Advertência verbal', 'Advertência escrita', 'Suspensão', 'Orientação', 'Elogio'],
  documento: ['ASO admissional', 'ASO periódico', 'ASO demissional', 'ASO retorno ao trabalho', 'ASO mudança de função', 'Exame complementar', 'Carteira de saúde', 'Certificado NR', 'EPI entregue', 'Contrato', 'Outro'],
  ferias_status: ['programada', 'gozada', 'vendida'],
  vaga_motivo: ['Substituição', 'Aumento de quadro', 'Temporária'],
  vaga_status: ['aberta', 'em seleção', 'preenchida', 'cancelada'],
  etapa: ['triagem', 'entrevista', 'teste prático', 'exame admissional', 'aprovado', 'reprovado', 'desistiu'],
  avaliacao: ['Experiência 30 dias', 'Experiência 60 dias', 'Experiência 90 dias', 'Periódica', 'Promoção'],
  decisao: ['efetivar', 'prorrogar', 'desligar', 'manter', 'promover', 'plano de ação'],
  movimentacao: ['Admissão', 'Desligamento', 'Transferência de loja', 'Mudança de setor', 'Promoção', 'Mudança de cargo', 'Reajuste salarial'],
  iniciativa: ['empresa', 'colaborador', 'acordo', 'término de contrato'],
};

const mem = {};
const arq = col => path.join(DIR, col + '.json');
function ler(col) {
  if (mem[col]) return mem[col];
  try { mem[col] = JSON.parse(fs.readFileSync(arq(col), 'utf8')); } catch (e) { mem[col] = []; }
  if (!Array.isArray(mem[col])) mem[col] = [];
  return mem[col];
}
function gravar(col) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(arq(col), JSON.stringify(mem[col], null, 1)); }
const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const okData = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const somaMeses = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

function listarCol(col, filtro) {
  if (!COLECOES[col]) throw Object.assign(new Error('Coleção desconhecida: ' + col), { status: 404 });
  let rows = ler(col);
  if (filtro && filtro.loja) rows = rows.filter(r => String(r.loja) === String(filtro.loja));
  if (filtro && filtro.colab_id) rows = rows.filter(r => String(r.colab_id) === String(filtro.colab_id));
  return rows;
}
function salvar(col, body, usuario) {
  const def = COLECOES[col]; if (!def) throw Object.assign(new Error('Coleção desconhecida: ' + col), { status: 404 });
  const rows = ler(col); const agora = new Date().toISOString();
  const campos = {}; for (const k of def.campos) if (body[k] !== undefined) campos[k] = body[k];
  for (const k of ['data', 'emissao', 'validade', 'inicio', 'fim', 'prevista', 'realizada', 'abertura', 'prazo', 'aquisitivo_ini', 'aquisitivo_fim']) if (campos[k] != null && campos[k] !== '' && !okData(campos[k])) throw Object.assign(new Error('Data inválida em ' + k), { status: 400 });
  for (const k of ['loja', 'colab_id', 'dias', 'qtd', 'previsto', 'validade_meses', 'carga_h', 'treinamento_id']) if (campos[k] != null && campos[k] !== '') campos[k] = +campos[k];
  if (Array.isArray(campos.candidatos)) campos.candidatos = campos.candidatos.filter(c => c && c.nome).map(c => ({ nome: String(c.nome).trim(), telefone: c.telefone || '', etapa: c.etapa || 'triagem', obs: c.obs || '', em: c.em || agora.slice(0, 10) }));
  if (Array.isArray(campos.setores)) campos.setores = campos.setores.map(s => semAcento(s)).filter(Boolean);
  let reg;
  if (body.id) {
    reg = rows.find(r => r.id === +body.id); if (!reg) throw Object.assign(new Error('Registro não encontrado'), { status: 404 });
    Object.assign(reg, campos, { atualizado_em: agora, atualizado_por: usuario || null });
  } else {
    for (const k of def.obrig) if (campos[k] == null || campos[k] === '') throw Object.assign(new Error('Falta preencher: ' + k), { status: 400 });
    reg = { id: rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1, ...campos, criado_em: agora, criado_por: usuario || null };
    rows.push(reg);
  }
  gravar(col); return reg;
}
function excluir(col, id, usuario) {
  if (!COLECOES[col]) throw Object.assign(new Error('Coleção desconhecida: ' + col), { status: 404 });
  const rows = ler(col); const i = rows.findIndex(r => r.id === +id); if (i < 0) throw Object.assign(new Error('Registro não encontrado'), { status: 404 });
  const [reg] = rows.splice(i, 1); gravar(col);
  const lix = ler('_lixeira'); lix.push({ colecao: col, ...reg, excluido_em: new Date().toISOString(), excluido_por: usuario || null }); if (lix.length > 2000) lix.splice(0, lix.length - 2000); gravar('_lixeira');
  return reg;
}

// ── cruzamentos com o cadastro ──────────────────────────────
const porId = (rows, id) => rows.filter(r => r.colab_id === id);
const chaveNome = c => semAcento(c.nome);

// Férias: períodos aquisitivos de 12 meses a partir da admissão; cada um tem 12 meses de concessivo pra gozar.
// Gozado se houver férias (registro próprio "gozada"/"vendida", ou afastamento de férias no PontoCerto) com início
// dentro do concessivo. Sem admissão → sem cálculo.
// Períodos cujo prazo pra gozar acabou antes do ponto existir ficam "sem histórico" (a folha tem, o sistema não);
// os que ainda podiam ser gozados antes do ponto começar ficam "confirmar" (pode ter gozado sem registro aqui).
function feriasDe(c, hoje, regs, afastFerias, pontoDesde) {
  if (!c.admissao) return [];
  const out = []; const minhas = regs.filter(r => r.colab_id === c.id || chaveNome(r) === chaveNome(c));
  const afast = afastFerias.filter(a => semAcento(a.nome) === chaveNome(c));
  for (let n = 0; n < 12; n++) {
    const ini = somaMeses(c.admissao, 12 * n), fim = somaDias(somaMeses(c.admissao, 12 * (n + 1)), -1);
    if (fim > hoje) { out.push({ n: n + 1, aquisitivo_ini: ini, aquisitivo_fim: fim, limite: somaMeses(fim, 12), status: 'em aquisição', dias_restantes: diasEntre(hoje, fim) }); break; }
    const limite = somaMeses(fim, 12);
    const reg = minhas.find(r => r.aquisitivo_ini === ini) || minhas.find(r => r.inicio >= fim && r.inicio <= limite && (r.status === 'gozada' || r.status === 'vendida'));
    const prog = minhas.find(r => r.status === 'programada' && r.inicio >= fim && r.inicio <= somaMeses(limite, 2));
    const pc = afast.find(a => a.inicio >= fim && a.inicio <= limite);
    const gozada = reg && reg.status !== 'programada' ? reg : null;
    let status, ref = gozada || pc || prog || null;
    if (gozada) status = gozada.status; else if (pc && pc.inicio <= hoje) status = 'gozada'; else if (pc || prog) status = 'programada';
    else if (pontoDesde && limite < pontoDesde) status = 'sem histórico'; else if (pontoDesde && fim < pontoDesde) status = 'confirmar';
    else if (limite < hoje) status = 'vencida'; else if (diasEntre(hoje, limite) <= 90) status = 'vencendo'; else status = 'a programar';
    out.push({ n: n + 1, aquisitivo_ini: ini, aquisitivo_fim: fim, limite, status, dias_para_limite: diasEntre(hoje, limite), inicio: ref ? ref.inicio : null, fim: ref ? ref.fim : null, dias: ref ? (ref.dias || (ref.inicio && ref.fim ? diasEntre(ref.inicio, ref.fim) + 1 : null)) : null, fonte: gozada ? 'registro' : pc ? 'ponto' : prog ? 'registro' : null });
  }
  return out;
}

async function base(force) {
  const hoje = hojeISO();
  const cad = await pontocerto.colaboradores(force);
  let afastFerias = [];
  try { afastFerias = (await pontocerto.afastamentosLongos(somaMeses(hoje, -26), somaMeses(hoje, 4))).filter(a => a.ferias); }
  catch (e) { console.error('[gente] afastamentos longos:', e.message); }
  const pontoDesde = cad.ativos.map(c => c.criado_no_ponto).filter(Boolean).sort()[0] || null;   // desde quando o ponto existe (cadastro mais antigo no Pontomais ≈ 28/04/2026)
  return { hoje, cad, afastFerias, pontoDesde };
}

const ORD = [1, 2, 3, 4, 5, 6, 10, 0];
const lojaObj = ln => ({ loja: +ln, etq: pontocerto.ETQ(ln), nome: pontocerto.LOJAS_NOMES[ln] || ('Loja ' + ln) });

// ── Painel do DP ────────────────────────────────────────────
async function painelDP(force) {
  const { hoje, cad, afastFerias, pontoDesde } = await base(force);
  const ativos = cad.ativos; const docs = ler('documentos'), ocs = ler('ocorrencias'), fer = ler('ferias');
  // contratos de experiência (45 + 45)
  const experiencia = [];
  for (const c of ativos) { if (!c.admissao) continue; const d = diasEntre(c.admissao, hoje); if (d < 0 || d > 90) continue;
    const etapa = d < 45 ? 1 : 2; const venceEm = (etapa === 1 ? 45 : 90) - d;
    experiencia.push({ ...c, dias_casa: d, etapa, vence_em: venceEm, vencimento: somaDias(c.admissao, etapa === 1 ? 45 : 90), fim_contrato: somaDias(c.admissao, 90) }); }
  experiencia.sort((a, b) => a.vence_em - b.vence_em);
  // férias
  const ferias = []; let semHistorico = 0;
  for (const c of ativos) for (const p of feriasDe(c, hoje, fer, afastFerias, pontoDesde)) { if (p.status === 'sem histórico') { semHistorico++; continue; }
    if (p.status !== 'em aquisição' || p.dias_restantes <= 60) ferias.push({ ...p, colab_id: c.id, nome: c.nome, loja: c.loja, etq: c.etq, setor: c.setor, cargo: c.cargo, admissao: c.admissao, de_ferias_agora: /f[eé]rias/i.test(c.status_agora) }); }
  const peso = { vencida: 0, vencendo: 1, 'a programar': 2, confirmar: 3, programada: 4, 'em aquisição': 5, gozada: 6, vendida: 6 };
  ferias.sort((a, b) => (peso[a.status] - peso[b.status]) || (a.limite || '').localeCompare(b.limite || ''));
  // documentos
  const documentos = docs.map(d => { const v = d.validade || null; const dias = v ? diasEntre(hoje, v) : null;
    return { ...d, dias_para_vencer: dias, situacao: !v ? 'sem validade' : dias < 0 ? 'vencido' : dias <= 30 ? 'vencendo' : 'em dia' }; })
    .sort((a, b) => (a.dias_para_vencer == null ? 9e9 : a.dias_para_vencer) - (b.dias_para_vencer == null ? 9e9 : b.dias_para_vencer));
  // colaboradores sem ASO admissional registrado (admitidos nos últimos 12 meses) — pendência de documento
  const semAso = ativos.filter(c => c.admissao && diasEntre(c.admissao, hoje) <= 365 && !docs.some(d => (d.colab_id === c.id || semAcento(d.nome) === chaveNome(c)) && /ASO/i.test(d.tipo)));
  // ocorrências 90 dias
  const ocorrencias = ocs.filter(o => o.data >= somaDias(hoje, -90)).sort((a, b) => b.data.localeCompare(a.data));
  const reincidentes = {}; for (const o of ocorrencias) if (!/elogio|orienta/i.test(o.tipo)) { const k = o.colab_id || semAcento(o.nome); (reincidentes[k] = reincidentes[k] || { nome: o.nome, loja: o.loja, n: 0, tipos: [] }).n++; reincidentes[k].tipos.push(o.tipo); }
  // banco de horas
  const banco = ativos.filter(c => c.banco_horas_min).map(c => ({ colab_id: c.id, nome: c.nome, loja: c.loja, etq: c.etq, setor: c.setor, cargo: c.cargo, min: c.banco_horas_min })).sort((a, b) => b.min - a.min);
  const bancoTot = banco.reduce((s, b) => s + b.min, 0), bancoPos = banco.filter(b => b.min > 0).reduce((s, b) => s + b.min, 0), bancoNeg = banco.filter(b => b.min < 0).reduce((s, b) => s + b.min, 0);
  // status ao vivo
  const agora = {}; for (const c of ativos) agora[c.status_agora || '—'] = (agora[c.status_agora || '—'] || 0) + 1;
  // por loja
  const lojas = ORD.filter(ln => ativos.some(c => c.loja === ln)).map(ln => { const L = ativos.filter(c => c.loja === ln); const st = {}; for (const c of L) st[c.status_agora || '—'] = (st[c.status_agora || '—'] || 0) + 1;
    return { ...lojaObj(ln), colaboradores: L.length, status: st, experiencia: experiencia.filter(x => x.loja === ln).length, ferias_vencidas: ferias.filter(x => x.loja === ln && x.status === 'vencida').length, ferias_vencendo: ferias.filter(x => x.loja === ln && x.status === 'vencendo').length,
      docs_vencidos: documentos.filter(x => +x.loja === ln && x.situacao === 'vencido').length, docs_vencendo: documentos.filter(x => +x.loja === ln && x.situacao === 'vencendo').length, ocorrencias_90d: ocorrencias.filter(x => +x.loja === ln).length,
      banco_min: banco.filter(b => b.loja === ln).reduce((s, b) => s + b.min, 0), banco_pos_min: banco.filter(b => b.loja === ln && b.min > 0).reduce((s, b) => s + b.min, 0), banco_neg_min: banco.filter(b => b.loja === ln && b.min < 0).reduce((s, b) => s + b.min, 0) }; });
  // aniversariantes do mês
  const mes = hoje.slice(5, 7);
  const aniversariantes = ativos.filter(c => c.nascimento && c.nascimento.slice(5, 7) === mes).map(c => ({ colab_id: c.id, nome: c.nome, loja: c.loja, etq: c.etq, setor: c.setor, dia: +c.nascimento.slice(8, 10), idade: +hoje.slice(0, 4) - +c.nascimento.slice(0, 4) })).sort((a, b) => a.dia - b.dia);
  // pendências do dia (lista de ação)
  const pend = [];
  for (const f of ferias.filter(x => x.status === 'vencida')) pend.push({ grau: 3, area: 'Férias', loja: f.loja, nome: f.nome, texto: 'Férias VENCIDAS (período ' + f.n + ', limite ' + f.limite + ') — pagamento em dobro', aba: 'ferias', colab_id: f.colab_id });
  for (const f of ferias.filter(x => x.status === 'vencendo')) pend.push({ grau: 2, area: 'Férias', loja: f.loja, nome: f.nome, texto: 'Férias vencem em ' + f.dias_para_limite + ' dias (limite ' + f.limite + ') — programar com 30 dias de aviso', aba: 'ferias', colab_id: f.colab_id });
  for (const x of experiencia.filter(e => e.vence_em <= 10)) pend.push({ grau: x.vence_em <= 3 ? 3 : 2, area: 'Experiência', loja: x.loja, nome: x.nome, texto: (x.etapa === 1 ? '1º período de experiência (45 d)' : 'Contrato de experiência (90 d)') + ' termina em ' + x.vence_em + ' dia' + (x.vence_em === 1 ? '' : 's') + ' (' + x.vencimento + ')' + (x.etapa === 2 ? ' — efetivar ou desligar' : ' — avaliar e decidir prorrogação'), aba: 'experiencia', colab_id: x.id });
  for (const d of documentos.filter(x => x.situacao === 'vencido')) pend.push({ grau: 3, area: 'Documentos', loja: +d.loja, nome: d.nome, texto: d.tipo + ' VENCIDO em ' + d.validade, aba: 'documentos', colab_id: d.colab_id });
  for (const d of documentos.filter(x => x.situacao === 'vencendo')) pend.push({ grau: 2, area: 'Documentos', loja: +d.loja, nome: d.nome, texto: d.tipo + ' vence em ' + d.dias_para_vencer + ' dias (' + d.validade + ')', aba: 'documentos', colab_id: d.colab_id });
  if (semAso.length) pend.push({ grau: 1, area: 'Documentos', loja: 0, nome: semAso.length + ' admitidos nos últimos 12 meses', texto: 'sem ASO admissional registrado aqui — cadastrar na aba Documentos (lista "Sem ASO")', aba: 'documentos' });
  const confirmar = {}; for (const f of ferias.filter(x => x.status === 'confirmar')) (confirmar[f.colab_id] = confirmar[f.colab_id] || { nome: f.nome, loja: f.loja, n: 0, colab_id: f.colab_id }).n++;
  for (const k of Object.keys(confirmar)) pend.push({ grau: 1, area: 'Férias', loja: confirmar[k].loja, nome: confirmar[k].nome, texto: confirmar[k].n + ' período(s) aquisitivo(s) sem registro de férias — confirmar na folha e registrar (gozada, vendida ou programada)', aba: 'ferias', colab_id: confirmar[k].colab_id });
  for (const k of Object.keys(reincidentes)) if (reincidentes[k].n >= 2) pend.push({ grau: 2, area: 'Disciplina', loja: +reincidentes[k].loja, nome: reincidentes[k].nome, texto: reincidentes[k].n + ' ocorrências em 90 dias (' + reincidentes[k].tipos.join(', ') + ') — avaliar próximo passo', aba: 'ocorrencias', colab_id: isNaN(+k) ? null : +k });
  for (const l of lojas) { const pos = banco.filter(b => b.loja === l.loja && b.min >= 40 * 60), neg = banco.filter(b => b.loja === l.loja && b.min <= -20 * 60);
    if (pos.length) pend.push({ grau: pos.length >= 10 ? 2 : 1, area: 'Banco de horas', loja: l.loja, nome: l.nome, texto: pos.length + ' pessoa(s) com 40 h ou mais no banco (' + Math.round(pos.reduce((s, b) => s + b.min, 0) / 60) + ' h no total) — programar folgas/compensação', aba: 'banco' });
    if (neg.length) pend.push({ grau: 1, area: 'Banco de horas', loja: l.loja, nome: l.nome, texto: neg.length + ' pessoa(s) devendo 20 h ou mais (' + Math.round(-neg.reduce((s, b) => s + b.min, 0) / 60) + ' h) — acertar com a gerência', aba: 'banco' }); }
  pend.sort((a, b) => b.grau - a.grau || a.loja - b.loja || a.nome.localeCompare(b.nome));
  return { hoje, ponto_desde: pontoDesde, ferias_sem_historico: semHistorico, gerado_em: new Date().toISOString(), cadastro_em: cad.gerado_em, total: ativos.length, lojas, agora, pendencias: pend, experiencia, ferias, documentos, sem_aso: semAso, ocorrencias: ocs.sort((a, b) => b.data.localeCompare(a.data)), reincidentes: Object.values(reincidentes).filter(r => r.n >= 2),
    banco: { itens: banco, total_min: bancoTot, positivo_min: bancoPos, negativo_min: bancoNeg, pessoas: banco.length }, aniversariantes, colaboradores: ativos, tipos: TIPOS };
}

// ── Painel do RH ────────────────────────────────────────────
async function painelRH(force) {
  const { hoje, cad } = await base(force);
  const ativos = cad.ativos, desligados = cad.desligados;
  const quadro = ler('quadro'), vagas = ler('vagas'), trein = ler('treinamentos'), caps = ler('capacitacoes'), aval = ler('avaliacoes'), mov = ler('movimentacoes');
  const mesAtual = hoje.slice(0, 7);
  // série 12 meses: admissões × desligamentos
  const meses = []; for (let i = 11; i >= 0; i--) meses.push(somaMeses(mesAtual + '-01', -i).slice(0, 7));
  const serie = meses.map(m => ({ mes: m, admissoes: ativos.filter(c => (c.admissao || '').slice(0, 7) === m).length + desligados.filter(c => (c.admissao || '').slice(0, 7) === m).length, desligamentos: desligados.filter(c => (c.desligamento || '').slice(0, 7) === m).length }));
  const deslig12 = desligados.filter(c => c.desligamento && c.desligamento >= somaMeses(hoje, -12)).length;
  const turnover12 = ativos.length ? +(deslig12 / ativos.length * 100).toFixed(1) : null;
  // tempo de casa
  const tc = ativos.filter(c => c.admissao).map(c => diasEntre(c.admissao, hoje));
  const faixas = { 'até 90 dias': tc.filter(d => d <= 90).length, '3 a 12 meses': tc.filter(d => d > 90 && d <= 365).length, '1 a 3 anos': tc.filter(d => d > 365 && d <= 1095).length, 'mais de 3 anos': tc.filter(d => d > 1095).length };
  const tempoMedioMeses = tc.length ? +(tc.reduce((s, d) => s + d, 0) / tc.length / 30.44).toFixed(1) : null;
  // quadro por loja × setor vs previsto
  const setoresPorLoja = {};
  for (const c of ativos) { const k = c.loja + '|' + c.setor; setoresPorLoja[k] = (setoresPorLoja[k] || 0) + 1; }
  for (const q of quadro) { const k = +q.loja + '|' + semAcento(q.setor); if (!(k in setoresPorLoja)) setoresPorLoja[k] = 0; }
  const quadroLinhas = Object.keys(setoresPorLoja).map(k => { const [ln, setor] = k.split('|'); const q = quadro.find(x => +x.loja === +ln && semAcento(x.setor) === setor);
    const vg = vagas.filter(v => +v.loja === +ln && semAcento(v.setor) === setor && ['aberta', 'em seleção'].includes(v.status)).reduce((s, v) => s + (+v.qtd || 1), 0);
    return { loja: +ln, etq: pontocerto.ETQ(ln), setor, atual: setoresPorLoja[k], previsto: q ? +q.previsto : null, quadro_id: q ? q.id : null, diferenca: q ? setoresPorLoja[k] - +q.previsto : null, vagas_abertas: vg }; })
    .sort((a, b) => ORD.indexOf(a.loja) - ORD.indexOf(b.loja) || b.atual - a.atual);
  const lojas = ORD.filter(ln => ativos.some(c => c.loja === ln) || quadro.some(q => +q.loja === ln)).map(ln => { const L = ativos.filter(c => c.loja === ln), D12 = desligados.filter(c => c.loja === ln && c.desligamento && c.desligamento >= somaMeses(hoje, -12));
    const prev = quadroLinhas.filter(q => q.loja === ln && q.previsto != null).reduce((s, q) => s + q.previsto, 0);
    const tcl = L.filter(c => c.admissao).map(c => diasEntre(c.admissao, hoje));
    return { ...lojaObj(ln), colaboradores: L.length, previsto: prev || null, diferenca: prev ? L.length - prev : null, admissoes_mes: L.filter(c => (c.admissao || '').slice(0, 7) === mesAtual).length, desligamentos_mes: desligados.filter(c => c.loja === ln && (c.desligamento || '').slice(0, 7) === mesAtual).length,
      desligamentos_12m: D12.length, turnover_12m: L.length ? +(D12.length / L.length * 100).toFixed(1) : null, tempo_medio_meses: tcl.length ? +(tcl.reduce((s, d) => s + d, 0) / tcl.length / 30.44).toFixed(1) : null, lideres: L.filter(c => c.lider).length,
      vagas_abertas: vagas.filter(v => +v.loja === ln && ['aberta', 'em seleção'].includes(v.status)).reduce((s, v) => s + (+v.qtd || 1), 0), setores: Object.entries(L.reduce((o, c) => { o[c.setor] = (o[c.setor] || 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]).map(([setor, n]) => ({ setor, n })) }; });
  // avaliações de experiência (30/60/90) geradas da admissão + registradas
  const marcos = [['Experiência 30 dias', 30], ['Experiência 60 dias', 60], ['Experiência 90 dias', 85]];
  const avaliacoesPend = [];
  for (const c of ativos) { if (!c.admissao) continue; const d = diasEntre(c.admissao, hoje); if (d > 120) continue;
    for (const [tipo, dias] of marcos) { const prevista = somaDias(c.admissao, dias); const feita = aval.find(a => (a.colab_id === c.id || semAcento(a.nome) === chaveNome(c)) && a.tipo === tipo && a.realizada);
      if (feita) continue; const atraso = diasEntre(prevista, hoje);
      if (atraso >= -7) avaliacoesPend.push({ colab_id: c.id, nome: c.nome, loja: c.loja, etq: c.etq, setor: c.setor, cargo: c.cargo, admissao: c.admissao, tipo, prevista, atraso, situacao: atraso > 0 ? 'atrasada' : 'esta semana' }); } }
  avaliacoesPend.sort((a, b) => b.atraso - a.atraso);
  // treinamentos obrigatórios: quem está em dia / vencido / nunca fez
  const trObrig = trein.filter(t => t.obrigatorio);
  const trStatus = [];
  for (const t of trObrig) for (const c of ativos) { if (t.setores && t.setores.length && !t.setores.includes(semAcento(c.setor))) continue;
    const feitas = caps.filter(x => x.treinamento_id === t.id && (x.colab_id === c.id || semAcento(x.nome) === chaveNome(c))).sort((a, b) => b.data.localeCompare(a.data));
    const ult = feitas[0]; const validade = ult ? (ult.validade || (t.validade_meses ? somaMeses(ult.data, +t.validade_meses) : null)) : null;
    const situacao = !ult ? 'nunca fez' : (validade && validade < hoje) ? 'vencido' : (validade && diasEntre(hoje, validade) <= 30) ? 'vencendo' : 'em dia';
    trStatus.push({ treinamento_id: t.id, treinamento: t.nome, colab_id: c.id, nome: c.nome, loja: c.loja, etq: c.etq, setor: c.setor, cargo: c.cargo, ultima: ult ? ult.data : null, validade, situacao }); }
  const trResumo = trObrig.map(t => { const s = trStatus.filter(x => x.treinamento_id === t.id); return { id: t.id, nome: t.nome, validade_meses: t.validade_meses, setores: t.setores || [], alvo: s.length, em_dia: s.filter(x => x.situacao === 'em dia').length, vencendo: s.filter(x => x.situacao === 'vencendo').length, vencido: s.filter(x => x.situacao === 'vencido').length, nunca: s.filter(x => x.situacao === 'nunca fez').length }; });
  // vagas
  const vagasAbertas = vagas.filter(v => ['aberta', 'em seleção'].includes(v.status)).map(v => ({ ...v, dias_aberta: v.abertura ? diasEntre(v.abertura, hoje) : null, candidatos_ativos: (v.candidatos || []).filter(c => !['reprovado', 'desistiu', 'aprovado'].includes(c.etapa)).length, aprovados: (v.candidatos || []).filter(c => c.etapa === 'aprovado').length, atrasada: v.prazo && v.prazo < hoje }));
  // agenda do mês: aniversários, aniversário de casa, fim de experiência
  const mes = hoje.slice(5, 7);
  const agenda = [];
  for (const c of ativos) { if (c.nascimento && c.nascimento.slice(5, 7) === mes) agenda.push({ dia: +c.nascimento.slice(8, 10), tipo: 'Aniversário', nome: c.nome, loja: c.loja, etq: c.etq, setor: c.setor, detalhe: (+hoje.slice(0, 4) - +c.nascimento.slice(0, 4)) + ' anos' });
    if (c.admissao && c.admissao.slice(5, 7) === mes && c.admissao.slice(0, 4) < hoje.slice(0, 4)) agenda.push({ dia: +c.admissao.slice(8, 10), tipo: 'Tempo de casa', nome: c.nome, loja: c.loja, etq: c.etq, setor: c.setor, detalhe: (+hoje.slice(0, 4) - +c.admissao.slice(0, 4)) + ' ano' + ((+hoje.slice(0, 4) - +c.admissao.slice(0, 4)) === 1 ? '' : 's') + ' de empresa' });
    if (c.admissao) { const f = somaDias(c.admissao, 90); if (f.slice(0, 7) === mesAtual) agenda.push({ dia: +f.slice(8, 10), tipo: 'Fim da experiência', nome: c.nome, loja: c.loja, etq: c.etq, setor: c.setor, detalhe: 'admitido em ' + c.admissao }); } }
  agenda.sort((a, b) => a.dia - b.dia || a.tipo.localeCompare(b.tipo));
  // pendências
  const pend = [];
  for (const a of avaliacoesPend) pend.push({ grau: a.atraso > 7 ? 3 : 2, area: 'Avaliações', loja: a.loja, nome: a.nome, texto: a.tipo + (a.atraso > 0 ? ' atrasada ' + a.atraso + ' dias' : ' prevista pra ' + a.prevista), aba: 'avaliacoes', colab_id: a.colab_id });
  for (const v of vagasAbertas.filter(x => x.atrasada)) pend.push({ grau: 2, area: 'Vagas', loja: +v.loja, nome: v.titulo, texto: 'Vaga passou do prazo (' + v.prazo + ') com ' + v.candidatos_ativos + ' candidato(s) em processo', aba: 'vagas' });
  for (const q of quadroLinhas.filter(x => x.diferenca != null && x.diferenca < 0 && x.vagas_abertas < -x.diferenca)) pend.push({ grau: 2, area: 'Quadro', loja: q.loja, nome: q.setor, texto: 'Faltam ' + (-q.diferenca) + ' no quadro (' + q.atual + ' de ' + q.previsto + ') e só ' + q.vagas_abertas + ' vaga(s) aberta(s)', aba: 'quadro' });
  for (const q of quadroLinhas.filter(x => x.diferenca != null && x.diferenca > 0)) pend.push({ grau: 1, area: 'Quadro', loja: q.loja, nome: q.setor, texto: q.diferenca + ' acima do previsto (' + q.atual + ' de ' + q.previsto + ')', aba: 'quadro' });
  for (const t of trResumo.filter(x => x.vencido + x.nunca > 0)) pend.push({ grau: t.vencido ? 2 : 1, area: 'Treinamentos', loja: 0, nome: t.nome, texto: (t.vencido ? t.vencido + ' vencido(s)' : '') + (t.vencido && t.nunca ? ' · ' : '') + (t.nunca ? t.nunca + ' nunca fizeram' : '') + ' de ' + t.alvo, aba: 'treinamentos' });
  for (const l of lojas.filter(x => x.turnover_12m != null && x.turnover_12m >= 50)) pend.push({ grau: 2, area: 'Turnover', loja: l.loja, nome: l.nome, texto: 'Turnover de ' + l.turnover_12m + '% em 12 meses (' + l.desligamentos_12m + ' desligamentos pra ' + l.colaboradores + ' ativos)', aba: 'quadro' });
  pend.sort((a, b) => b.grau - a.grau || a.loja - b.loja || a.nome.localeCompare(b.nome));
  const admMes = ativos.filter(c => (c.admissao || '').slice(0, 7) === mesAtual), desMes = desligados.filter(c => (c.desligamento || '').slice(0, 7) === mesAtual);
  return { hoje, gerado_em: new Date().toISOString(), cadastro_em: cad.gerado_em, total: ativos.length, previsto: quadroLinhas.filter(q => q.previsto != null).reduce((s, q) => s + q.previsto, 0) || null, lojas, serie, turnover_12m: turnover12, desligamentos_12m: deslig12,
    admissoes_mes: admMes, desligamentos_mes: desMes, desligados_recentes: desligados.slice(0, 60), tempo_medio_meses: tempoMedioMeses, faixas, lideres: ativos.filter(c => c.lider).length, quadro: quadroLinhas, vagas: vagas.sort((a, b) => (b.abertura || '').localeCompare(a.abertura || '')), vagas_abertas: vagasAbertas,
    avaliacoes_pendentes: avaliacoesPend, avaliacoes: aval.sort((a, b) => (b.realizada || b.prevista || '').localeCompare(a.realizada || a.prevista || '')), treinamentos: trein, capacitacoes: caps.sort((a, b) => b.data.localeCompare(a.data)), treinamentos_status: trStatus, treinamentos_resumo: trResumo,
    movimentacoes: mov.sort((a, b) => b.data.localeCompare(a.data)), agenda, pendencias: pend, colaboradores: ativos, tipos: TIPOS };
}

module.exports = { COLECOES, TIPOS, listar: listarCol, salvar, excluir, painelDP, painelRH };
