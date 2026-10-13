'use strict';
const mysql       = require('mysql2/promise');
const cron        = require('node-cron');
const PDFDocument = require('pdfkit');
const contagem    = require('../lib/contagem-negativos');
const path        = require('path');
const fs          = require('fs');
const http        = require('http');
const pino        = require('pino');

const DB         = { host:'192.168.2.252', port:3306, user:'root', password:'1900', database:'central', connectTimeout:15000 };
const GRUPO_NOME = 'CENTRAL ( Aux ) PREVENÇÃO DE PERDAS';

// Aviso diário no grupo. Sem link de propósito: link em bot não oficial é
// sinal de spam pro WhatsApp. O app Contagem já fica instalado no celular.
// ENVIAR_PDF=true volta a mandar a folha em PDF junto (modo antigo).
const ENVIAR_PDF = process.env.NEGATIVOS_ENVIAR_PDF === '1';
function msgAvisoContagem(porLoja, dataStr, rei = {}) {
  const vezes = (ln, x) => (rei[ln] || {})[String(x.Codigo)] || 1;
  const linhas = [1,2,3,4,5,6].filter(ln => (porLoja[ln] || []).length)
    .map(ln => {
      const n = porLoja[ln].length;
      const r = porLoja[ln].filter(x => vezes(ln, x) >= 2).length;
      return `• Loja ${ln} (${NOMES_LOJA[ln]}): *${n}* ${n === 1 ? 'item' : 'itens'}${r ? ` — ⚠ *${r}* reincidente${r > 1 ? 's' : ''}` : ''}`;
    });
  // Piores casos (3+ vezes em 15 dias), limitados pra mensagem não virar textão
  const piores = [];
  for (const ln of [1,2,3,4,5,6]) for (const x of porLoja[ln] || []) {
    const v = vezes(ln, x);
    if (v >= 3) piores.push({ ln, desc: x.Descricao, v });
  }
  piores.sort((a, b) => b.v - a.v);
  const blocoPiores = piores.length ? [
    '',
    '🔴 *Vive negativando (3+ vezes em 15 dias):*',
    ...piores.slice(0, 8).map(p => `• Loja ${p.ln} · ${p.desc} — ${p.v}ª vez`),
    ...(piores.length > 8 ? [`…e mais ${piores.length - 8} itens marcados no app.`] : []),
  ] : [];
  return [
    `📋 *CONTAGEM DE NEGATIVOS — ${dataStr}*`,
    '',
    ...linhas,
    ...blocoPiores,
    '',
    'Abra o app *Contagem* no celular: a lista da sua loja já está lá.',
    'Digite *Depósito* e *Loja* em cada item. Se o produto não existe na loja, toque em *Não achei*.',
    'Itens com ⚠ no app já negativaram outros dias: confira depósito e validade com atenção redobrada.',
    'No fim, toque em *Concluir contagem*. A central recebe na hora.',
  ].join('\n');
}
const LOGO_PATH  = path.join(__dirname, '..', 'public', 'logo.png');
const logger     = pino({ level:'info' });
const NOMES_LOJA = { 1:'CAHU', 2:'MURIBECA', 3:'PONTE', 4:'ATACAREJO', 5:'PORTA LARGA', 6:'JARDIM JORDAO' };

// ── Banco ─────────────────────────────────────────────────────────────────────

async function buscarNegativos() {
  const conn = await mysql.createConnection(DB);
  try {
    // 6 queries simples em paralelo — muito mais rápido que 1 query com 6 JOINs
    const resultados = await Promise.all(
      [1,2,3,4,5,6].map(ln => conn.query(`
        SELECT
          i.CodigoBarra                           AS Codigo,
          i.Descricao,
          COALESCE(g.Descricao,  'SEM GRUPO')    AS Grupo,
          COALESCE(sg.Descricao, 'SEM SUBGRUPO') AS SubGrupo,
          e.Qtd                                  AS Estoque
        FROM central.itens i
        JOIN central.estoquen${ln} e ON e.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.gruposub sg ON sg.CodSubGrupo = i.CodGrupoSub
        LEFT JOIN central.grupo    g  ON g.CodGrupo     = sg.CodGrupo
        WHERE i.CodDesativado = 0
          AND i.Descricao NOT LIKE '% KG%'
          AND i.CodigoBarra IS NOT NULL
          AND CHAR_LENGTH(i.CodigoBarra) >= 7
          AND e.Qtd < 0
        ORDER BY g.Descricao, sg.Descricao, i.Descricao
      `))
    );
    // Retorna objeto { 1: [...], 2: [...], ..., 6: [...] }
    return Object.fromEntries(resultados.map(([rows], i) => [i + 1, rows]));
  } finally { conn.end(); }
}

// ── PDF ───────────────────────────────────────────────────────────────────────
// Folha de conferência física: encarregado preenche à mão (Depósito/Loja) e
// devolve foto pro agente ler. Marcas de referência + caixa LOJA-DATA existem
// pra correção de perspectiva/identificação automática da foto — não mexer
// nelas sem falar com o Tiago primeiro.

const MM = 2.83465; // pt por mm
const mm = v => v * MM;

function gerarPDFLoja(itens, ln, hoje) {
  const doc    = new PDFDocument({ size:'A4', margin:0, bufferPages:true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const PW = 595, PH = 842, ML = 36, MR = 36, CW = PW - ML - MR;

  const COR = {
    branco:   '#FFFFFF',
    preto:    '#000000',
    navy:     '#0E1626',
    navySec:  '#4E5A72',
    navyTer:  '#98A0B3',
    cinza:    '#F4F4F2',
    cinzaMd:  '#EDEDEB',
    laranja:  '#F5B800',
  };

  // Colunas da tabela
  const C = {
    cod:  { x: ML,  w: 76  },
    desc: { x: 0,   w: 206 },
    dep:  { x: 0,   w: 96  },
    loja: { x: 0,   w: 96  },
    sis:  { x: 0,   w: CW - 76 - 206 - 96 - 96 },
  };
  C.desc.x = C.cod.x + C.cod.w;
  C.dep.x  = C.desc.x + C.desc.w;
  C.loja.x = C.dep.x + C.dep.w;
  C.sis.x  = C.loja.x + C.loja.w;

  const CORNER = mm(6);    // 17pt — quadrado de referência pra correção de perspectiva da foto
  const BOXW   = mm(6.5);  // quadrado grande (algarismo)
  const BOXH   = mm(9);
  const BOXS   = mm(5);    // quadrado pequeno ("zerado")
  const ROW_H  = mm(9.5);  // altura de linha, pra caber letra grande
  const GRP_H  = 16;
  const INSET  = mm(5);    // distância das marcas de referência até a borda da página
  const COLH_H = 34;       // altura do cabeçalho de colunas

  function linha(x1,y1,x2,y2, c=COR.preto, w=0.6) {
    doc.strokeColor(c).lineWidth(w).moveTo(x1,y1).lineTo(x2,y2).stroke();
  }

  function txt(text, x, y, w, h, { cor=COR.navy, font='Helvetica', size=8, align='left', pad=4, lineBreak=false }={}) {
    doc.fillColor(cor).fontSize(size).font(font)
       .text(String(text==null?'':text), x+pad, y+Math.max(0,(h-size)/2), { width:w-pad*2, align, lineBreak });
  }

  // Marcas de referência (fiduciais). De propósito só 3 cantos — falta o
  // inferior-direito — pra resolver ambiguidade de rotação 180° na foto.
  function marcasReferencia() {
    doc.rect(INSET, INSET, CORNER, CORNER).fill(COR.preto);
    doc.rect(PW-INSET-CORNER, INSET, CORNER, CORNER).fill(COR.preto);
    doc.rect(INSET, PH-INSET-CORNER, CORNER, CORNER).fill(COR.preto);
  }

  // Caixa "LOJA-AAAAMMDD" — identificador da folha pro agente que lê a foto
  function idBox() {
    const idTxt = `L${String(ln).padStart(2,'0')}-${hoje.getFullYear()}${String(hoje.getMonth()+1).padStart(2,'0')}${String(hoje.getDate()).padStart(2,'0')}`;
    const w = 150, h = 22, x = PW-MR-w, y = 26;
    doc.lineWidth(1).strokeColor(COR.preto).rect(x,y,w,h).stroke();
    doc.fillColor(COR.navy).fontSize(12).font('Courier-Bold')
       .text(idTxt, x, y+6, { width:w, align:'center', lineBreak:false });
    return { x, y, w, h };
  }

  function cabecalhoColunas(y) {
    doc.rect(0,y,PW,COLH_H).fill(COR.cinzaMd);
    linha(0,y,PW,y); linha(0,y+COLH_H,PW,y+COLH_H);

    txt('Código',    C.cod.x,  y, C.cod.w,  COLH_H, { font:'Helvetica-Bold', size:7.5 });
    txt('Descrição', C.desc.x, y, C.desc.w, COLH_H, { font:'Helvetica-Bold', size:7.5 });

    [['dep','Depósito','o que achou no estoque'],['loja','Loja','o que achou na área de vendas']].forEach(([k,label,sub]) => {
      const col = C[k];
      txt(label, col.x, y+3, col.w, 10, { font:'Helvetica-Bold', size:7.5, align:'center' });
      doc.fillColor(COR.navyTer).fontSize(5.6).font('Helvetica')
         .text(sub, col.x+2, y+13, { width:col.w-4, align:'center', lineBreak:true });
      const boxesW = BOXW*3 + 4 + BOXS;
      const bx = col.x + (col.w-boxesW)/2;
      txt('quantidade', bx, y+COLH_H-11, BOXW*3+4, 8, { font:'Helvetica', size:5.6, align:'center', cor:COR.navyTer });
      const zx = bx + BOXW*3 + 4 + BOXS/2 - 15;
      txt('zerado', zx, y+COLH_H-11, 30, 8, { font:'Helvetica', size:5.6, align:'center', cor:COR.navyTer });
    });

    doc.rect(C.sis.x, y, C.sis.w, COLH_H).fill(COR.cinza);
    txt('Sistema', C.sis.x, y+4, C.sis.w, 10, { font:'Helvetica-Bold', size:7.5, align:'center' });
    doc.fillColor(COR.navyTer).fontSize(5.6).font('Helvetica')
       .text('não escreva aqui', C.sis.x+2, y+15, { width:C.sis.w-4, align:'center', lineBreak:true });

    [C.desc.x, C.dep.x, C.loja.x, C.sis.x, PW-MR].forEach(x => linha(x,y,x,y+COLH_H));

    return y + COLH_H;
  }

  function desenharBoxes(col, y, h) {
    const boxesW = BOXW*3 + 4 + BOXS;
    let bx = col.x + (col.w-boxesW)/2;
    const by = y + (h-BOXH)/2;
    doc.lineWidth(0.9).strokeColor(COR.preto);
    for (let i=0; i<3; i++) { doc.rect(bx,by,BOXW,BOXH).stroke(); bx += BOXW+2; }
    bx += 2;
    const sy = y + (h-BOXS)/2;
    doc.rect(bx, sy, BOXS, BOXS).stroke();
  }

  function cabecalho() {
    doc.rect(0, 0, PW, PH).fill(COR.branco);
    marcasReferencia();
    doc.rect(0, 0, PW, 2).fill(COR.laranja);

    const temLogo = fs.existsSync(LOGO_PATH);
    if (temLogo) { try { doc.image(LOGO_PATH, ML, 14, { height: 30 }); } catch(_) {} }
    const txX = temLogo ? ML + 42 : ML;

    doc.fillColor(COR.laranja).fontSize(7.5).font('Helvetica-Bold')
       .text('ECONÔMICO RELATÓRIOS', txX, 16, { width: 220, lineBreak:false });
    doc.fillColor(COR.navy).fontSize(13).font('Helvetica-Bold')
       .text('Auditoria de Estoque Negativo', txX, 27, { width: 280, lineBreak:false });
    doc.fillColor(COR.navySec).fontSize(7.5).font('Helvetica')
       .text('Folha de conferência — preencher e devolver até 17:00', txX, 44, { width: 320, lineBreak:false });

    const { y:idY, h:idH } = idBox();
    const dataHora = hoje.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'})
                   + '  ·  ' + hoje.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    doc.fillColor(COR.navySec).fontSize(8).font('Helvetica')
       .text(dataHora, PW-MR-200, idY+idH+6, { width:200, align:'right', lineBreak:false });

    let y = 68;
    doc.rect(ML, y, 3, 22).fill(COR.laranja);
    doc.fillColor(COR.navy).fontSize(14).font('Helvetica-Bold')
       .text(`LOJA ${ln}  —  ${NOMES_LOJA[ln]||'LOJA '+ln}`, ML+9, y+3, { width: CW-9, lineBreak:false });
    y += 30;

    return cabecalhoColunas(y);
  }

  // Cabeçalho de continuação (loja com folha grande, estourou pra página 2+).
  // Mantém marcas de referência + caixa LOJA-DATA: cada página vira uma foto
  // separada e precisa da própria referência de perspectiva/identificação.
  function retomarCabecalho() {
    doc.rect(0, 0, PW, PH).fill(COR.branco);
    marcasReferencia();
    doc.rect(0, 0, PW, 2).fill(COR.laranja);
    idBox();
    doc.fillColor(COR.navySec).fontSize(7).font('Helvetica-Bold')
       .text(`ECONÔMICO RELATÓRIOS  |  Loja ${ln} — ${NOMES_LOJA[ln]||''}  |  (continuação)`, ML, 16, { width:300, lineBreak:false });
    return cabecalhoColunas(56);
  }

  // ── Conteúdo ────────────────────────────────────────────────────────────────
  let y = cabecalho();

  // Agrupa: Grupo → SubGrupo → produtos (igual ao mercadológico do ERP)
  const arvore = {};
  itens.forEach(r => {
    const grp = (r.Grupo    || 'SEM GRUPO').toUpperCase();
    const sub = (r.SubGrupo || 'SEM SUBGRUPO').toUpperCase();
    if (!arvore[grp]) arvore[grp] = {};
    if (!arvore[grp][sub]) arvore[grp][sub] = [];
    arvore[grp][sub].push(r);
  });

  for (const [nomeGrupo, subGrupos] of Object.entries(arvore)) {
    for (const [nomeSub, produtos] of Object.entries(subGrupos)) {
      if (y > 760) { doc.addPage(); y = retomarCabecalho(); }

      // Grupo e subgrupo na mesma linha — grupo em negrito, subgrupo normal
      doc.rect(0, y, PW, GRP_H).fill(COR.cinzaMd);
      doc.fillColor(COR.navy).fontSize(8).font('Helvetica-Bold')
         .text(nomeGrupo, ML+6, y+(GRP_H-8)/2, { width: CW-12, lineBreak:false, continued:true });
      doc.fillColor(COR.navySec).fontSize(8).font('Helvetica')
         .text('  >  '+nomeSub, { width: CW-12, lineBreak:false });
      y += GRP_H;

      for (const r of produtos) {
        if (y > 800) { doc.addPage(); y = retomarCabecalho(); }

        txt(r.Codigo||'', C.cod.x, y, C.cod.w, ROW_H, { size:7.5, font:'Helvetica' });
        doc.fillColor(COR.navy).fontSize(7.5).font('Helvetica')
           .text(String(r.Descricao||''), C.desc.x+4, y+3, { width: C.desc.w-8, lineBreak:true, height: ROW_H-6 });

        desenharBoxes(C.dep, y, ROW_H);
        desenharBoxes(C.loja, y, ROW_H);

        doc.rect(C.sis.x, y, C.sis.w, ROW_H).fill(COR.cinza);
        txt(String(r.Estoque), C.sis.x, y, C.sis.w, ROW_H, { cor:COR.preto, font:'Helvetica-Bold', size:9, align:'center' });

        linha(0, y+ROW_H, PW, y+ROW_H, COR.preto, 1);
        [C.desc.x, C.dep.x, C.loja.x, C.sis.x, PW-MR].forEach(x => linha(x, y, x, y+ROW_H, COR.preto, 0.75));

        y += ROW_H;
      }
    }
  }

  // Precisa de ~170pt pro total + legenda + regras + assinatura — se não
  // couber, começa página nova pra não partir esse bloco ao meio.
  if (y + 170 > PH-20) { doc.addPage(); y = retomarCabecalho(); }

  y += 8;
  doc.fillColor(COR.navy).fontSize(8.5).font('Helvetica-Bold')
     .text(`TOTAL: ${itens.length} produto(s) nesta folha`, ML, y, { width:CW });
  y += 20;

  // Legenda + regras de preenchimento
  const legY = y, legH = 92, colW = (CW-16)/2;
  doc.lineWidth(1).strokeColor(COR.preto).rect(ML, legY, colW, legH).stroke();
  doc.lineWidth(1).strokeColor(COR.preto).rect(ML+colW+16, legY, colW, legH).stroke();

  const legendas = [
    ['Depósito', 'quantidade que você contou no estoque, incluindo o que está em pallet e em caixa fechada.'],
    ['Loja', 'quantidade que você contou na gôndola, ponta, ilha e check-out.'],
    ['Sistema', 'saldo negativo que o sistema mostra hoje. Já vem impresso — é só a referência, não preencha.'],
    ['Quadro pequeno', 'marque X quando a contagem daquele lugar deu zero.'],
  ];
  let ly = legY+8;
  legendas.forEach(([label,desc]) => {
    doc.fillColor(COR.navy).fontSize(7).font('Helvetica-Bold').text(label, ML+8, ly, { width:70, lineBreak:true });
    doc.fillColor(COR.navySec).fontSize(6.8).font('Helvetica').text(desc, ML+80, ly, { width:colW-88, lineBreak:true });
    ly += 21;
  });

  const regras = [
    'Preencha os dois lados. Achou só na loja? X no zerado do depósito.',
    'Nunca deixe uma linha inteira em branco sem anotar o motivo no verso.',
    'Um algarismo por quadro, caneta preta ou azul escura. Não use lápis.',
    'Contagem zero: X no quadro pequeno. Não escreva 0 nos quadros grandes.',
    'Não conseguiu contar: deixe os quadros em branco e anote o motivo no verso.',
    'Fotografe a folha inteira, com os três quadrados pretos das pontas visíveis.',
  ];
  let ry = legY+8;
  const rx = ML+colW+16+8;
  regras.forEach(rtxt => {
    doc.fillColor(COR.navy).fontSize(6).font('Helvetica-Bold').text('•', rx, ry, { width:8, lineBreak:false });
    doc.fillColor(COR.navySec).fontSize(6.8).font('Helvetica').text(rtxt, rx+8, ry, { width:colW-24, lineBreak:true });
    ry += 13.5;
  });

  // Assinatura
  y = legY + legH + 22;
  linha(ML, y, ML+180, y, COR.preto, 0.75);
  linha(PW-MR-160, y, PW-MR, y, COR.preto, 0.75);
  txt('Aux Prevenção (nome legível)', ML, y+3, 180, 12, { size:7, cor:COR.navySec });
  txt('Hora da conclusão', PW-MR-160, y+3, 160, 12, { size:7, cor:COR.navySec });

  doc.end();
  return new Promise(resolve => doc.on('end', () => resolve({ buffer:Buffer.concat(chunks), total:itens.length })));
}

// ── WhatsApp: sai pelo bot do número "Central Rede Cahu" (cahu-wpp/, 127.0.0.1:3012) ──────────────────────
// Desde 13/10/2026 (Tiago: "tirar meu número pessoal de enviar os negativos e colocar pra enviar pelo ROBÔ CENTRAL
// CAHU, o número novo, lá no grupo de prevenção"). Este processo NÃO conecta mais no WhatsApp: só decide O QUE e
// QUANDO mandar e pede pro cahu-wpp (filho do server.js, número 5581987709903) entregar no grupo GRUPO_NOME —
// o robô precisa estar como participante desse grupo. A pasta auth_info/ (sessão antiga do número pessoal do
// Tiago, já deslogada) ficou só como histórico e não é lida. Junto saiu o "bot de perguntas" (pendentes/custo),
// que só existia porque o processo ouvia o número pessoal.
const BOT_URL = (process.env.CAHU_WPP_URL || 'http://127.0.0.1:3012').replace(/\/$/, '');

async function botPost(rota, body) {
  const r = await fetch(BOT_URL + rota, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch (_) { /* resposta sem JSON */ }
  if (!r.ok) throw new Error('cahu-wpp ' + rota + ' -> ' + r.status + ': ' + (j.error || 'erro'));
  return j;
}
async function botConectado() {
  try {
    const r = await fetch(BOT_URL + '/status', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return j.conectado === true;
  } catch (_) { return false; }
}
async function enviarTextoGrupo(texto) { return botPost('/mensagem-grupo', { grupo: GRUPO_NOME, texto }); }
async function enviarDocumentoGrupo({ buffer, fileName, caption, mimetype }) {
  return botPost('/documento-grupo', { grupo: GRUPO_NOME, base64: Buffer.from(buffer).toString('base64'), fileName, caption, mimetype: mimetype || 'application/pdf' });
}

async function enviarPDFsLojas(porLoja) {
  // Abre a contagem do dia pro app do celular (não apaga o que já foi digitado)
  try { contagem.abrirDia(porLoja); logger.info('Contagem do dia aberta pro app'); }
  catch (err) { logger.error({ err }, 'Erro ao abrir contagem do dia'); }

  const hoje     = new Date();
  const dataStr  = hoje.toLocaleDateString('pt-BR');
  const dataNome = hoje.toISOString().slice(0, 10);

  for (let ln = 1; ln <= 6; ln++) {
    const itens = porLoja[ln] || [];
    logger.info(`Loja ${ln} (${NOMES_LOJA[ln]}): ${itens.length} negativo(s)`);
    if (!itens.length || !ENVIAR_PDF) continue;
    try {
      const { buffer, total } = await gerarPDFLoja(itens, ln, hoje);
      const nomeLoja = (NOMES_LOJA[ln]||'LOJA'+ln).replace(/\s+/g,'_');
      await enviarDocumentoGrupo({
        buffer,
        fileName: `negativos_loja${ln}_${nomeLoja}_${dataNome}.pdf`,
        caption:  `*Estoque Negativo — Loja ${ln} (${NOMES_LOJA[ln]}) — ${dataStr}*\n${total} produto(s) negativos`,
      });
      logger.info(`Loja ${ln}: PDF enviado (${total} itens)`);
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      logger.error({ err }, `Erro ao enviar Loja ${ln}`);
    }
  }

  // Aviso único no grupo: quantos itens por loja + como contar no app.
  // Reincidência calculada depois do abrirDia pra contagem de hoje já entrar.
  let rei = {};
  try { rei = contagem.reincidencia(contagem.hojeStr()); }
  catch (err) { logger.error({ err }, 'Erro ao calcular reincidência (aviso sai sem ⚠)'); }
  await enviarTextoGrupo(msgAvisoContagem(porLoja, dataStr, rei));
  logger.info(`Aviso de contagem enviado no grupo "${GRUPO_NOME}" pelo cahu-wpp`);
}

// ── Rotina ────────────────────────────────────────────────────────────────────

async function rotina() {
  logger.info('Iniciando rotina de negativos...');
  try {
    // Garante que o robô (cahu-wpp) está conectado antes de rodar (espera até 1 min)
    let ok = await botConectado();
    for (let i = 0; i < 12 && !ok; i++) {
      logger.warn('Robô Central Cahu (cahu-wpp:3012) não conectado ainda. Aguardando 5s...');
      await new Promise(r => setTimeout(r, 5000));
      ok = await botConectado();
    }
    if (!ok) {
      logger.error('Robô Central Cahu não conectou a tempo. Abortando rotina de hoje.');
      return;
    }
    const porLoja = await buscarNegativos();
    const total   = Object.values(porLoja).reduce((s, arr) => s + arr.length, 0);
    logger.info(`Total negativos: ${total}`);
    if (!total) { logger.info('Nenhum estoque negativo.'); return; }

    // Retry no envio: a conexão WA reconecta periodicamente e pode estar
    // momentaneamente fechada bem na hora do cron (visto em produção)
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
      try {
        await enviarPDFsLojas(porLoja);
        return;
      } catch (err) {
        logger.error({ err }, `Erro na rotina (tentativa ${tentativa}/5). Aguardando reconexão...`);
        if (tentativa < 5) await new Promise(r => setTimeout(r, 15000));
      }
    }
    logger.error('Rotina falhou após 5 tentativas. Desistindo por hoje.');
  } catch (err) {
    logger.error({ err }, 'Erro na rotina');
  }
}

// ── Gatilho local (só localhost) ────────────────────────────────────────────
// Servidor HTTP interno, sem exposição externa, pra permitir disparo manual
// do reenvio sem depender de mensagem de WhatsApp — chamado pelo server.js
// principal (que já tem domínio público via Caddy) num endpoint próprio.
http.createServer(async (req, res) => {
  // Cotação (Tiago, 25/09): manda a mensagem com o link da cotação pra um vendedor avulso, pelo número do robô.
  if (req.url === '/mensagem' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { numero, texto } = JSON.parse(body || '{}');
        const dig = String(numero || '').replace(/\D/g, '');
        if (!texto || dig.length < 10) { res.writeHead(400); res.end(JSON.stringify({ error: 'Informe numero (com DDI/DDD) e texto.' })); return; }
        if (!(await botConectado())) { res.writeHead(503); res.end(JSON.stringify({ error: 'WhatsApp não conectado.' })); return; }
        const r = await botPost('/mensagem', { numero: dig, texto }); // repassa pro cahu-wpp (número central)
        res.writeHead(200); res.end(JSON.stringify({ ok: true, jid: r.jid }));
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }
  if (req.url === '/mensagem-grupo' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { texto } = JSON.parse(body || '{}');
        if (!texto) { res.writeHead(400); res.end(JSON.stringify({ error: 'Sem texto.' })); return; }
        if (!(await botConectado())) { res.writeHead(503); res.end(JSON.stringify({ error: 'WhatsApp não conectado.' })); return; }
        await enviarTextoGrupo(texto);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }
  if (req.url !== '/reenviar-negativos') { res.writeHead(404); res.end(); return; }
  try {
    if (!(await botConectado())) { res.writeHead(503); res.end(JSON.stringify({ error: 'WhatsApp não conectado.' })); return; }
    const porLoja = await buscarNegativos();
    const total = Object.values(porLoja).reduce((s, arr) => s + arr.length, 0);
    if (!total) { res.writeHead(200); res.end(JSON.stringify({ ok: true, total: 0, msg: 'Nenhum estoque negativo agora.' })); return; }
    await enviarPDFsLojas(porLoja);
    res.writeHead(200); res.end(JSON.stringify({ ok: true, total }));
  } catch (err) {
    logger.error({ err }, 'Erro no gatilho HTTP de reenvio');
    res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
  }
}).listen(3010, '127.0.0.1', () => logger.info('Gatilho local de reenvio ativo em 127.0.0.1:3010'));

// ── Inicialização ─────────────────────────────────────────────────────────────

(async () => {
  logger.info(`Envio pelo Robô Central Cahu (${BOT_URL}) no grupo "${GRUPO_NOME}". Robô conectado agora: ${await botConectado()}`);
  cron.schedule('0 8 * * 1-5', rotina, { timezone:'America/Sao_Paulo' });
  logger.info('Agendamento ativo: seg-sex 08:00 (Brasília). Aguardando...');
})();
