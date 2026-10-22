'use strict';
// lib/escalas-rotas.js — rotas /api/escalas/* (DP / RH › Escalas). Regras em lib/escalas.js; permissão = designação da
// central de pessoas (gerente da loja edita e envia, RH Ponto valida, Coordenação aprova, Diretoria consulta).
// PontoCerto só é lido (cadastro, escalas contratuais, marcações, afastamentos); se estiver fora, as escalas já
// gravadas continuam funcionando e só a comparação com o ponto fica indisponível.
module.exports = function montarRotasEscalas(app, deps) {
  const E = require('./escalas'); const GP = require('./gestao-pessoas'); const pc = deps.pontocerto;
  const erroRes = (res, e) => { if (!e.status) console.error('[escalas]', e.message); res.status(e.status || 500).json({ error: e.message, erros: e.erros }); };
  const user = req => req.session && req.session.user;
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
    const funcs = await comAfast(e);
    return { loja: e.loja, lojaTxt: GP.LOJA_TXT[e.loja], mes: e.mes, status: e.status, statusTxt: E.STATUS_TXT[e.status], versao: e.versao, demo: !!e.demo, origem: e.origem, dias: E.diasDoMes(e.mes), feriados: E.config().feriados, feriadosNome: Object.fromEntries(E.config().feriados.map(d => [d, E.nomeFeriado(d)])), funcionarios: funcs, acoes: E.acoes(u, e), podeEditar: E.podeEditar(u, e), historico: e.historico.slice(-200).reverse(), fluxo: e.fluxo.slice().reverse(), turnos: E.turnosDoMes(funcs), versoes: e.versoes.map(v => ({ versao: v.versao, em: v.em })), alterados: Object.keys(e.dias).length };
  }));
  app.post('/api/escalas/:loja/:mes/demo', ok(req => { const l = lojaOk(req), m = mesOk(req); if (l !== 1) throw Object.assign(new Error('A semente demonstrativa é só da Loja 1 (Socorro)'), { status: 400 }); if (!GP.gerenteDa(user(req), 1) && !GP.temPapel(user(req), 'coordenacao')) throw Object.assign(new Error('Sem permissão'), { status: 403 }); const e = E.criarDemoSocorro(m, user(req)); GP.auditar({ usuario: user(req).usuario, acao: 'escala_demo', ref: 'ESC-1-' + m }); return { ok: true, funcionarios: e.funcionarios.length }; }));
  app.post('/api/escalas/:loja/:mes/dia', ok(async req => { const l = lojaOk(req), m = mesOk(req); return E.editarDia(l, m, user(req), req.body || {}, await afastMes(m)); }));
  app.post('/api/escalas/:loja/:mes/validar-dia', ok(async req => { const l = lojaOk(req), m = mesOk(req); const e = E.obter(l, m); const f = e.funcionarios.find(x => +x.id === +(req.body || {}).funcId); if (!f) throw Object.assign(new Error('Funcionário não está nesta escala'), { status: 404 }); const b = req.body; return E.validarDia(e, f, b.data, { tipo: b.tipo || 'trabalho', entrada: b.entrada || null, saida: b.saida || null, almoco_ini: b.almoco_ini || null, almoco_fim: b.almoco_fim || null, setor: b.setor || f.setor }, b.justificativa, await afastMes(m)); }));
  // Express 5 (path-to-regexp v8) não aceita regex no parâmetro (':acao(enviar|...)' derruba o servidor na subida): uma rota por ação
  for (const acao of ['enviar', 'validar', 'aprovar', 'devolver']) app.post('/api/escalas/:loja/:mes/' + acao, ok(req => { const l = lojaOk(req), m = mesOk(req); const e = E.mover(l, m, user(req), acao, (req.body || {}).texto); return { ok: true, status: e.status, statusTxt: E.STATUS_TXT[e.status], acoes: E.acoes(user(req), e) }; }));
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
      const l = lojaOk(req), m = mesOk(req); const e = E.obter(l, m); const funcs = await comAfast(e); const dias = E.diasDoMes(m);
      GP.auditar({ usuario: user(req).usuario, acao: 'escala_exportar', ref: 'ESC-' + l + '-' + m, fmt: req.params.fmt });
      res.set('Cache-Control', 'no-store');
      if (req.params.fmt === 'csv') { res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="escala-' + GP.LOJA_TXT[l].split(' ')[0] + '-' + m + '.csv"'); return res.send(csv(['Funcionário', 'Setor', 'Folga fixa', ...dias.map(d => d.slice(8) + '/' + d.slice(5, 7)), 'Horas no mês'], funcs.map(f => [f.nome, E.setorTxt(f.setor), f.folga_fixa.map(x => 'DSTQQSS'[x]).join(''), ...dias.map(d => celula(f.dias[d])), f.horas_mes]))); }
      const PDFDocument = require('pdfkit'); const doc = new PDFDocument({ size: 'A3', layout: 'landscape', margin: 24 });
      res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', 'inline; filename="escala-' + GP.LOJA_TXT[l].split(' ')[0] + '-' + m + '.pdf"'); doc.pipe(res);
      doc.font('Helvetica-Bold').fontSize(14).text('Escala coletiva · ' + GP.LOJA_TXT[l] + ' · ' + m.split('-').reverse().join('/') + (e.demo ? ' · DADOS DEMONSTRATIVOS' : ''), { continued: false });
      doc.font('Helvetica').fontSize(8).fillColor('#555').text('Situação: ' + E.STATUS_TXT[e.status] + ' · versão ' + e.versao + ' · gerado ' + new Date().toLocaleString('pt-BR') + ' · previsto da escala (não é apuração oficial)'); doc.moveDown(0.5);
      const W = doc.page.width - 48, x0 = 24; const cNome = 150, cSet = 60, cDia = (W - cNome - cSet - 40) / dias.length; let y = doc.y; const linha = 16;
      const fer = E.config().feriados; const turnos = E.turnosDoMes(funcs), corTurno = Object.fromEntries(turnos.map(t => [t.chave, t.cor]));
      const cab = () => { doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#000'); doc.text('Funcionário', x0, y, { width: cNome }); doc.text('Setor', x0 + cNome, y, { width: cSet }); dias.forEach((d, i) => doc.fillColor(fer.includes(d) ? '#C22F49' : '#000').text(d.slice(8) + '\n' + 'DSTQQSS'[E._util.dow(d)] + (fer.includes(d) ? ' FER' : ''), x0 + cNome + cSet + i * cDia, y - 2, { width: cDia, align: 'center' })); doc.fillColor('#000').text('Horas', x0 + cNome + cSet + dias.length * cDia, y, { width: 40, align: 'right' }); y += linha + 4; };
      cab();
      for (const f of funcs) {
        if (y > doc.page.height - 40) { doc.addPage(); y = 24; cab(); }
        doc.font('Helvetica').fontSize(6.5).fillColor('#000'); doc.text(f.nome.slice(0, 34), x0, y, { width: cNome, lineBreak: false }); doc.text(E.setorTxt(f.setor).slice(0, 14), x0 + cNome, y, { width: cSet, lineBreak: false });
        doc.fontSize(5.5);   // 31 colunas no A3: 'HHMM-HHMM' só cabe sem quebrar até 5,5 pt
        dias.forEach((d, i) => { const c = f.dias[d]; const t = c.tipo === 'trabalho' ? c.entrada.replace(':', '') + '-' + c.saida.replace(':', '') : { folga: 'F', ferias: 'FÉ', afastado: 'AF', feriado: 'FER' }[c.tipo];
          const cx = x0 + cNome + cSet + i * cDia, cor = c.tipo === 'trabalho' ? corTurno[String(c.minutos)] : E.CORES_TIPO[c.tipo]; if (cor) doc.rect(cx + 0.5, y - 3, cDia - 1, linha - 1).fill(cor);
          if (c.alterado) doc.rect(cx + 1, y - 2.5, cDia - 2, linha - 2).lineWidth(1).stroke('#1f5fbf');
          if (c.feriado) doc.rect(cx + 0.5, y - 3, cDia - 1, 2).fill('#C22F49');
          doc.fillColor(c.tipo === 'trabalho' ? '#14213D' : '#666').text(t, cx, y, { width: cDia, align: 'center', lineBreak: false }); });
        doc.fontSize(6.5).fillColor('#000').text(f.horas_mes, x0 + cNome + cSet + dias.length * cDia, y, { width: 40, align: 'right', lineBreak: false }); y += linha;
      }
      // legenda: um quadradinho por turno do mês + tipos fixos + borda azul = dia alterado
      y += 10; let lx = x0; doc.font('Helvetica').fontSize(7);
      const leg = [...turnos.map(t => [t.cor, t.nome + ' ' + t.horas + ': ' + t.horarios.join(' · ')]), [E.CORES_TIPO.afastado, 'AF Afastamento/Atestado · FÉ Férias'], [E.CORES_TIPO.folga, 'F Folga'], [null, 'Borda azul = dia alterado em relação à jornada contratual'], ['#C22F49', 'Faixa vermelha / FER = feriado (' + (dias.filter(d => fer.includes(d)).map(d => d.slice(8) + ' ' + E.nomeFeriado(d)).join(', ') || 'nenhum no mês') + ')']];
      for (const [cor, txt] of leg) { const w = doc.widthOfString(txt) + 22; if (lx + w > x0 + W) { lx = x0; y += 12; } if (cor) doc.rect(lx, y - 1, 9, 9).fill(cor); else doc.rect(lx, y - 1, 9, 9).lineWidth(1).stroke('#1f5fbf'); doc.fillColor('#555').text(txt, lx + 13, y, { lineBreak: false }); lx += w; }
      doc.end();
    })().catch(e => erroRes(res, e));
  });
};
