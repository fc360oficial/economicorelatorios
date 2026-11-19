'use strict';
// lib/escalas-rotas.js — rotas /api/escalas/* (DP / RH › Escalas). Regras em lib/escalas.js; permissão = designação da
// central de pessoas (gerente da loja edita e envia, RH Ponto valida, Coordenação aprova, Diretoria consulta).
// PontoCerto só é lido (cadastro, escalas contratuais, marcações, afastamentos); se estiver fora, as escalas já
// gravadas continuam funcionando e só a comparação com o ponto fica indisponível.
module.exports = function montarRotasEscalas(app, deps) {
  const E = require('./escalas'); const GP = require('./gestao-pessoas'); const pc = deps.pontocerto;
  const erroRes = (res, e) => { if (!e.status) console.error('[escalas]', e.message); res.status(e.status || 500).json({ error: e.message, erros: e.erros, bloqueios: e.bloqueios }); };
  const user = req => req.session && req.session.user;
  const S5 = () => require('./escalas-5x2');   // serviço do Gerador 5×2: cores por turno, validação da semana, trava de publicação e auditoria
  const PER = () => require('./escalas-periodo');   // Gerar por período (modelo da planilha): códigos e cores dos turnos da loja
  const PM = require('./escalas-planilha');
  const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { erroRes(res, e); } };
  app.use('/api/escalas', (req, res, next) => { const u = user(req); if (!u) return res.status(401).json({ error: 'Não autenticado' }); if (!GP.papeisDe(u).length) return res.status(403).json({ error: 'Você não está entre os designados da central de pessoas (DP / RH › Gestão de Pessoas › Configurações).', naoDesignado: true }); next(); });
  const lojaOk = req => { const l = +req.params.loja; if (!GP.LOJAS.includes(l)) throw Object.assign(new Error('Loja inválida'), { status: 400 }); if (!E.podeVer(user(req), l)) throw Object.assign(new Error('Loja fora do seu escopo'), { status: 403 }); return l; };
  const mesOk = req => { const m = String(req.params.mes || req.query.mes || ''); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw Object.assign(new Error('Mês inválido (AAAA-MM)'), { status: 400 }); return m; };
  const dataOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const hoje = () => E._util.diaISO();
  // afastamentos do mês (férias/afastados viram tipo do dia); se o PontoCerto falhar, segue sem eles
  async function afastMes(mes) { try { const l = await pc.afastamentos(mes + '-01', E.diasDoMes(mes).pop()); const m = new Map(); for (const a of l) { if (!m.has(a.nome)) m.set(a.nome, []); m.get(a.nome).push(a); } return m; } catch (e) { return null; } }
  const comAfast = async (e) => E.resolver(e, await afastMes(e.mes));

  app.get('/api/escalas/me', (req, res) => { const u = user(req); res.json({ usuario: u.usuario, nome: u.nome, papeis: GP.papeisDe(u), escopo: GP.escopo(u), soConsulta: GP.temPapel(u, 'diretoria') && GP.papeisDe(u).length === 1, lojas: GP.LOJAS.filter(l => GP.veLoja(u, l)).map(n => ({ n, txt: GP.LOJA_TXT[n] })), setores: E.SETORES.map(s => ({ id: s, txt: E.SETOR_TXT[s] })), tipos: E.TIPO_TXT, status: E.STATUS_TXT, config: E.config(), podeConfigurar: GP.temPapel(u, 'coordenacao', ...GP.RH) }); });
  app.put('/api/escalas/config', ok(req => E.salvarConfig(req.body || {}, user(req))));

  // Painel da Coordenação: todas as lojas do escopo num dia
  app.get('/api/escalas/painel', ok(async req => {
    const u = user(req); if (!GP.vePainel(u)) throw Object.assign(new Error('Sem acesso ao painel'), { status: 403 });
    const data = dataOk(req.query.data) ? req.query.data : hoje(); const mes = data.slice(0, 7); const afast = await afastMes(mes);
    const now = new Date(); const agoraMin = data === hoje() ? now.getHours() * 60 + now.getMinutes() : E._util.min('10:00');
    let alertas = []; try { alertas = GP.centralAlertas(u).filter(a => a.evento <= 2); } catch (e) {}
    const lojas = [];
    for (const l of GP.LOJAS) {
      if (!GP.veLoja(u, l)) continue; const e = E.ler(l, mes);
      if (!e) { lojas.push({ loja: l, lojaTxt: GP.LOJA_TXT[l], semEscala: true, alertas_bh: alertas.filter(a => +a.loja === l).length }); continue; }
      const funcs = E.resolver(e, afast); const r = E.resumoLoja(l, data, funcs, agoraMin, alertas.filter(a => +a.loja === l).length);
      lojas.push({ ...r, status: e.status, statusTxt: E.STATUS_TXT[e.status], pendente: ['enviada_rh', 'validada_rh'].includes(e.status), demo: !!e.demo, versao: e.versao, alterados: Object.keys(e.dias).length });
    }
    return { data, mes, hoje: hoje(), lojas };
  }));
  // Escala do mês de uma loja (cria do PontoCerto se ainda não existir)
  app.get('/api/escalas/:loja/:mes', ok(async req => {
    const l = lojaOk(req), m = mesOk(req); const u = user(req);
    let e = E.ler(l, m);
    if (!e) { if (String(req.query.criar) !== '1') throw Object.assign(new Error('Ainda não há escala de ' + GP.LOJA_TXT[l] + ' em ' + m), { status: 404, semEscala: true }); const [col, esc] = await Promise.all([pc.colaboradores(), pc.escalas()]); e = E.criarDoPontoCerto(l, m, col, esc, u); GP.auditar({ usuario: u.usuario, acao: 'escala_criar', ref: 'ESC-' + l + '-' + m }); }
    const funcs = PER().organizar(l, (await comAfast(e)).filter(f => !f.fora_do_mes));   // saiu antes do mês (ou só entra depois): continua no arquivo, não é linha da grade
    return { loja: e.loja, lojaTxt: GP.LOJA_TXT[e.loja], mes: e.mes, status: e.status, statusTxt: E.STATUS_TXT[e.status], versao: e.versao, demo: !!e.demo, origem: e.origem, dias: E.diasDoMes(e.mes), feriados: E.config().feriados, feriadosNome: Object.fromEntries(E.config().feriados.map(d => [d, E.nomeFeriado(d)])), funcionarios: funcs, acoes: E.acoes(u, e), podeEditar: E.podeEditar(u, e), historico: e.historico.slice(-200).reverse(), fluxo: e.fluxo.slice().reverse(), turnos: E.turnosDoMes(funcs), classes: S5().pintar(e.loja, funcs), planilha: PER().codificar(e.loja, funcs), versoes: e.versoes.map(v => ({ versao: v.versao, em: v.em })), alterados: Object.keys(e.dias).length };
  }));
  app.post('/api/escalas/:loja/:mes/demo', ok(req => { const l = lojaOk(req), m = mesOk(req); if (l !== 1) throw Object.assign(new Error('A semente demonstrativa é só da Loja 1 (Socorro)'), { status: 400 }); if (!GP.gerenteDa(user(req), 1) && !GP.temPapel(user(req), 'coordenacao')) throw Object.assign(new Error('Sem permissão'), { status: 403 }); const e = E.criarDemoSocorro(m, user(req)); GP.auditar({ usuario: user(req).usuario, acao: 'escala_demo', ref: 'ESC-1-' + m }); return { ok: true, funcionarios: e.funcionarios.length }; }));
  // depois de salvar, o serviço do Gerador 5×2 classifica a alteração e avisa a Coordenação (imediato ou relatório diário)
  app.post('/api/escalas/:loja/:mes/dia', ok(async req => { const l = lojaOk(req), m = mesOk(req); const antes = (E.ler(l, m) || {}).status; const afast = await afastMes(m); const r = E.editarDia(l, m, user(req), req.body || {}, afast);
    // Etapa 4: valida a semana (duas folgas, carga efetiva, descansos), grava a alteração na auditoria encadeada e avisa a Coordenação
    // mês gerado no modelo da planilha (semana de domingo a sábado): a alteração é auditada e avisada, mas a conta seg→dom não é mostrada como "semana inválida"
    try { const p = S5().aposEdicao(user(req), l, m, req.body || {}, antes, afast); if (p) { if (!PER().modeloNoMes(l, m)) r.validacao = p.validacao; r.aviso = p.nivel; } } catch (e) { console.error('[escalas] auditoria/aviso da alteração', e.message); } return r; }));
  app.post('/api/escalas/:loja/:mes/validar-dia', ok(async req => { const l = lojaOk(req), m = mesOk(req); const e = E.obter(l, m); const f = e.funcionarios.find(x => +x.id === +(req.body || {}).funcId); if (!f) throw Object.assign(new Error('Funcionário não está nesta escala'), { status: 404 }); const b = req.body; return E.validarDia(e, f, b.data, { tipo: b.tipo || 'trabalho', entrada: b.entrada || null, saida: b.saida || null, almoco_ini: b.almoco_ini || null, almoco_fim: b.almoco_fim || null, setor: b.setor || f.setor }, b.justificativa, await afastMes(m)); }));
  // Express 5 (path-to-regexp v8) não aceita regex no parâmetro (':acao(enviar|...)' derruba o servidor na subida): uma rota por ação
  for (const acao of ['enviar', 'validar', 'aprovar', 'devolver']) app.post('/api/escalas/:loja/:mes/' + acao, ok(async req => { const l = lojaOk(req), m = mesOk(req);
    // escala no regime 5×2 só é validada/aprovada sem pendência impeditiva (duas folgas por semana, descansos, intervalo, carga)
    if (acao === 'validar' || acao === 'aprovar') S5().exigirPublicavel(user(req), l, m, { afast: await afastMes(m) }, acao);
    const e = E.mover(l, m, user(req), acao, (req.body || {}).texto); return { ok: true, status: e.status, statusTxt: E.STATUS_TXT[e.status], acoes: E.acoes(user(req), e) }; }));
  // Visão da loja: cobertura por setor em blocos de 15 min + sugestões + divergências com o ponto (se o PontoCerto responder)
  app.get('/api/escalas/:loja/dia/:data', ok(async req => {
    const l = lojaOk(req); const data = req.params.data; if (!dataOk(data)) throw Object.assign(new Error('Data inválida'), { status: 400 });
    const e = E.ler(l, data.slice(0, 7)); if (!e) throw Object.assign(new Error('Ainda não há escala de ' + GP.LOJA_TXT[l] + ' em ' + data.slice(0, 7)), { status: 404, semEscala: true });
    const funcs = await comAfast(e); const cob = E.cobertura(l, data, funcs); const sug = E.sugestoes(cob);
    let div = null, pontoErro = null;
    if (data <= hoje()) { try { const j = await pc.jornadaDia(data, { toleranciaMin: GP.config().ponto.atrasoMin }); div = E.divergencias(e, data, funcs, j.linhas.filter(x => +x.loja === l), hoje()); } catch (er) { pontoErro = er.message; } }
    return { ...cob, status: e.status, statusTxt: E.STATUS_TXT[e.status], demo: !!e.demo, sugestoes: sug, divergencias: div, pontoErro, hoje: hoje() };
  }));
  // Escala individual: mês do funcionário + (opcional) comparação com o ponto do período
  app.get('/api/escalas/:loja/:mes/funcionario/:id', ok(async req => {
    const l = lojaOk(req), m = mesOk(req); const e = E.obter(l, m); const funcs = await comAfast(e); const f = funcs.find(x => +x.id === +req.params.id); if (!f) throw Object.assign(new Error('Funcionário não está nesta escala'), { status: 404 });
    const dias = E.diasDoMes(m).map(d => ({ data: d, ...f.dias[d] }));
    const semanas = {}; for (const d of dias) { const w = E._util.somaDias(d.data, -((E._util.dow(d.data) + 6) % 7)); semanas[w] = (semanas[w] || 0) + d.minutos; }
    const hist = e.historico.filter(h => +h.funcId === +f.id).reverse();
    let ponto = null, pontoErro = null, banco = null;
    if (String(req.query.ponto) === '1' && f.id > 0) { try { const ate = E.diasDoMes(m).pop() < hoje() ? E.diasDoMes(m).pop() : hoje(); const p = await pc.jornadaPeriodo(f.id, m + '-01', ate, { toleranciaMin: GP.config().ponto.atrasoMin }); ponto = p.dias; const c = GP.colabInfo(f.id); banco = c ? c.min : (p.colaborador.banco_horas_min != null ? p.colaborador.banco_horas_min : null); } catch (er) { pontoErro = er.message; } }
    const div = ponto ? dias.filter(d => d.data <= hoje()).flatMap(d => { const j = ponto.find(x => x.data === d.data); return j ? E.divergencias(e, d.data, [f], [j], hoje()).flatMap(x => x.itens.map(i => ({ data: d.data, ...i }))) : []; }) : null;
    return { loja: l, lojaTxt: GP.LOJA_TXT[l], mes: m, status: e.status, statusTxt: E.STATUS_TXT[e.status], funcionario: { id: f.id, nome: f.nome, matricula: f.matricula, cargo: f.cargo, setor: f.setor, setorTxt: E.setorTxt(f.setor), turno: f.turno, folga_fixa: f.folga_fixa, base: f.base, habilitado: f.habilitado, horas_mes: f.horas_mes, minutos_mes: f.minutos_mes },
      dias, semanas: Object.entries(semanas).map(([ini, mn]) => ({ inicio: ini, minutos: mn, horas: E._util.hhmm(mn) })), historico: hist, ponto, pontoErro, banco_oficial_min: banco, divergencias: div, podeEditar: E.podeEditar(user(req), e) };
  }));
  // Exportações: CSV (abre no Excel) e PDF da escala coletiva
  const csv = (cab, linhas) => '﻿' + [cab, ...linhas].map(r => r.map(v => { const s = String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
  const celula = d => d.tipo === 'trabalho' ? d.entrada + '-' + d.saida + (d.almoco_ini ? ' (' + d.almoco_ini + '-' + d.almoco_fim + ')' : '') : E.TIPO_TXT[d.tipo];
  app.get('/api/escalas/:loja/:mes/exportar.:fmt', (req, res) => {   // Express 5: sem regex no parâmetro; formato validado abaixo
    (async () => {
      if (!['csv', 'pdf'].includes(req.params.fmt)) { res.status(404).json({ error: 'Formato inválido (csv ou pdf)' }); return; }
      const l = lojaOk(req), m = mesOk(req); const e = E.obter(l, m); const funcs = PER().organizar(l, (await comAfast(e)).filter(f => !f.fora_do_mes)); const dias = E.diasDoMes(m);
      // posições vagas do mês (Vagas e Quadro de Pessoal): saem identificadas no fim, sem horas — vaga não é jornada
      let vagas = []; try { vagas = require('./vagas').naEscala(user(req), l, dias[0], dias[dias.length - 1]); } catch (er) {}
      const naVaga = (v, d) => d >= v.desde && (!v.ate || d <= v.ate);
      GP.auditar({ usuario: user(req).usuario, acao: 'escala_exportar', ref: 'ESC-' + l + '-' + m, fmt: req.params.fmt });
      res.set('Cache-Control', 'no-store');
      if (req.params.fmt === 'csv') { res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="escala-' + GP.LOJA_TXT[l].split(' ')[0] + '-' + m + '.csv"'); return res.send(csv(['Funcionário', 'Setor', 'Folga fixa', ...dias.map(d => d.slice(8) + '/' + d.slice(5, 7)), 'Horas no mês'], funcs.map(f => [f.nome, E.setorTxt(f.setor), f.folga_fixa.map(x => 'DSTQQSS'[x]).join(''), ...dias.map(d => celula(f.dias[d])), f.horas_mes]).concat(vagas.map(v => ['VAGA EM ABERTO (' + v.id + ')' + (v.cargo ? ' · ' + v.cargo : ''), v.setorTxt, '', ...dias.map(d => naVaga(v, d) ? 'VAGA' : ''), ''])))); }
      // PDF no modelo da planilha (19/11/2026): A4 deitado, uma linha por pessoa, código e cor do turno, folga fixa verde,
      // descanso do domingo / folga rotativa em branco e a tabela LEGENDA × HORÁRIO no fim. Mesmos códigos da tela.
      const PDFDocument = require('pdfkit'); const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 18 });
      res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', 'inline; filename="escala-' + GP.LOJA_TXT[l].split(' ')[0] + '-' + m + '.pdf"'); doc.pipe(res);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('Escala · ' + GP.LOJA_TXT[l] + ' · ' + m.split('-').reverse().join('/') + (e.demo ? ' · DADOS DEMONSTRATIVOS' : ''), 18, 16, { lineBreak: false });
      doc.font('Helvetica').fontSize(6.5).fillColor('#555').text('Situação: ' + E.STATUS_TXT[e.status] + ' · versão ' + e.versao + ' · gerado ' + new Date().toLocaleString('pt-BR') + ' · previsto da escala (não é apuração oficial)', 18, 30, { lineBreak: false });
      const fer = E.config().feriados; const PL = PER().codificar(l, funcs), PT = Object.fromEntries(PL.turnos.map(t => [t.codigo, t]));
      const x0 = 18, W = doc.page.width - 36, cNome = 150, cSet = 74, cHr = 30, cDia = (W - cNome - cSet - cHr) / dias.length, linha = 9.6, xDia = i => x0 + cNome + cSet + i * cDia, xHr = x0 + cNome + cSet + dias.length * cDia; let y = 42;
      const DS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'], MESN = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
      const caixa = (x, yy, w, h, fill) => { doc.lineWidth(0.4); if (fill) doc.rect(x, yy, w, h).fillAndStroke(fill, '#9AA0A6'); else doc.rect(x, yy, w, h).stroke('#9AA0A6'); };
      const escreve = (t, x, yy, w, cor, tam, align) => doc.fontSize(tam).fillColor(cor).text(String(t), x, yy, { width: w, align: align || 'center', lineBreak: false });
      const hTxt = hm => { const [h, mi] = hm.split(':').map(Number); return h + 'h' + (mi ? String(mi).padStart(2, '0') + 'min' : ''); };
      const horario = t => hTxt(t.entrada) + (t.almoco_ini ? ' às ' + hTxt(t.almoco_ini) + ' - ' + hTxt(t.almoco_fim) + ' às ' : ' às ') + hTxt(t.saida);
      const cab = () => { doc.font('Helvetica-Bold'); caixa(x0, y, cNome, linha * 2); escreve('NOME', x0 + 3, y + linha - 2.6, cNome - 6, '#000', 6, 'left'); caixa(x0 + cNome, y, cSet, linha * 2); escreve('CARGO', x0 + cNome, y + linha - 2.6, cSet, '#000', 6);
        dias.forEach((d, i) => { const w = E._util.dow(d), f = fer.includes(d); caixa(xDia(i), y, cDia, linha, w === 0 ? '#E8412C' : null); escreve(DS[w], xDia(i), y + 2.4, cDia, w === 0 ? '#FFFFFF' : f ? '#C22F49' : '#000', 5.4); caixa(xDia(i), y + linha, cDia, linha); escreve(d.slice(8) + '/' + MESN[+d.slice(5, 7) - 1], xDia(i), y + linha + 2.8, cDia, f ? '#C22F49' : '#000', 4.4); });
        caixa(xHr, y, cHr, linha * 2); escreve('Horas', xHr, y + linha - 2.6, cHr, '#000', 5.6); y += linha * 2; };
      const quebra = () => { if (y > doc.page.height - 26) { doc.addPage(); y = 18; cab(); } };
      cab(); let grupoAnt = null;
      for (const f of funcs) {
        quebra(); const novoGrupo = grupoAnt !== null && grupoAnt !== f.grupo; grupoAnt = f.grupo;   // linha mais grossa entre as funções, como os blocos da planilha
        doc.font('Helvetica-Bold'); caixa(x0, y, cNome, linha); escreve(f.nome.slice(0, 40), x0 + 3, y + 2.5, cNome - 5, f.vaga ? '#D0021B' : '#000', 5.4, 'left');
        doc.font('Helvetica'); caixa(x0 + cNome, y, cSet, linha); escreve((f.grupo || f.cargo || E.setorTxt(f.setor)).slice(0, 24), x0 + cNome, y + 2.7, cSet, '#000', 4.8);
        doc.font('Helvetica-Bold');
        dias.forEach((d, i) => { const c = f.dias[d], w = E._util.dow(d), cx = xDia(i), t = c.cod && PT[c.cod]; let fill = null, txt = '', cor = '#14213D', tam = 5.4;
          if (c.tipo === 'trabalho') { if (t) { fill = t.cor; txt = c.cod; cor = t.texto; } else if (c.entrada && c.saida) { txt = c.entrada.replace(':', '') + '-' + c.saida.replace(':', ''); tam = 3.5; } }
          else if (c.tipo === 'folga') { const fixa = c.folga ? c.folga === 'fixa' : w !== 0 && (f.folga_fixa || []).includes(w); if (fixa) { fill = PM.COR_FOLGA; txt = 'Folga'; cor = '#FFFFFF'; tam = 5; } else if (c.folga === 'rotativa') { fill = '#C9EBCF'; txt = 'F.Rot'; cor = '#0B5A2A'; tam = 4.6; } }
          else if (c.tipo === 'saiu') fill = '#F1F1EF';
          else { txt = { ferias: 'Férias', afastado: 'Licença', feriado: 'Feriado' }[c.tipo] || ''; tam = 4.2; }
          caixa(cx, y, cDia, linha, fill); if (c.feriado) doc.rect(cx, y, cDia, 1.2).fill('#C22F49');
          if (c.alterado && c.origem !== 'gerador') doc.lineWidth(0.9).rect(cx + 0.7, y + 0.7, cDia - 1.4, linha - 1.4).stroke('#1f5fbf');
          if (txt) escreve(txt, cx, y + (linha - tam) / 2 + 0.7, cDia, cor, tam); });
        caixa(xHr, y, cHr, linha, '#F4F4F1'); escreve(f.horas_mes, xHr, y + 2.5, cHr, '#000', 5.2); if (novoGrupo) doc.lineWidth(1.1).moveTo(x0, y).lineTo(x0 + W, y).stroke('#14213D'); y += linha;
      }
      // posições vagas: linha própria, em vermelho, sem horário nem horas (não é jornada nem cobertura)
      for (const v of vagas) {
        quebra(); doc.font('Helvetica-Bold'); caixa(x0, y, cNome, linha, '#FDF1F3'); escreve(('VAGA EM ABERTO · ' + (v.cargo || '')).slice(0, 44), x0 + 3, y + 2.5, cNome - 5, '#A3263A', 5.2, 'left');
        doc.font('Helvetica'); caixa(x0 + cNome, y, cSet, linha); escreve(String(v.setorTxt || '').slice(0, 24), x0 + cNome, y + 2.7, cSet, '#A3263A', 4.8);
        dias.forEach((d, i) => { const na = naVaga(v, d); caixa(xDia(i), y, cDia, linha, na ? '#FBE4E8' : null); if (na) escreve('VAGA', xDia(i), y + 3, cDia, '#A3263A', 3.8); });
        caixa(xHr, y, cHr, linha); escreve('—', xHr, y + 2.5, cHr, '#A3263A', 5.2); y += linha;
      }
      // legenda como na planilha: LEGENDA × HORÁRIO, só com os turnos que aparecem neste mês
      const usados = PL.turnos.filter(t => t.n > 0); const legT = usados.length ? usados : PL.turnos; const cLeg = 46, cHor = 190;
      if (y + (legT.length + 5) * linha > doc.page.height - 18) { doc.addPage(); y = 18; } else y += 8;
      doc.font('Helvetica-Bold'); caixa(x0, y, cLeg, linha); escreve('LEGENDA', x0, y + 2.5, cLeg, '#000', 5.4); caixa(x0 + cLeg, y, cHor, linha); escreve('HORÁRIO', x0 + cLeg + 4, y + 2.5, cHor - 8, '#000', 5.4, 'left'); y += linha;
      for (const t of legT) { doc.font('Helvetica-Bold'); caixa(x0, y, cLeg, linha, t.cor); escreve(t.codigo, x0, y + 2.5, cLeg, t.texto, 5.4); doc.font('Helvetica'); caixa(x0 + cLeg, y, cHor, linha); escreve(horario(t), x0 + cLeg + 4, y + 2.5, cHor - 8, '#000', 5.4, 'left'); y += linha; }
      doc.font('Helvetica-Bold'); caixa(x0, y, cLeg, linha, PM.COR_FOLGA); escreve('Folga', x0, y + 2.5, cLeg, '#FFFFFF', 5.4); doc.font('Helvetica'); caixa(x0 + cLeg, y, cHor, linha); escreve('Folga fixa da semana', x0 + cLeg + 4, y + 2.5, cHor - 8, '#000', 5.4, 'left'); y += linha;
      doc.font('Helvetica-Bold'); caixa(x0, y, cLeg, linha, '#C9EBCF'); escreve('F.Rot', x0, y + 2.5, cLeg, '#0B5A2A', 5.4); doc.font('Helvetica'); caixa(x0 + cLeg, y, cHor, linha); escreve('FOLG. ROTATIVA', x0 + cLeg + 4, y + 2.5, cHor - 8, '#000', 5.4, 'left'); y += linha;
      caixa(x0, y, cLeg, linha); caixa(x0 + cLeg, y, cHor, linha); escreve('Em branco: descanso do domingo', x0 + cLeg + 4, y + 2.5, cHor - 8, '#000', 5.4, 'left'); y += linha + 4;
      const ferMes = dias.filter(d => fer.includes(d)).map(d => d.slice(8) + ' ' + E.nomeFeriado(d)).join(', ');
      doc.font('Helvetica').fontSize(5.4).fillColor('#555').text('Borda azul = dia alterado à mão' + (ferMes ? ' · Feriado(s) no mês (faixa vermelha): ' + ferMes : '') + ' · Horas = previsto no mês, com o intervalo descontado', x0, y, { width: W, lineBreak: false });
      doc.end();
    })().catch(e => erroRes(res, e));
  });
};
