'use strict';
const mysql       = require('mysql2/promise');
const cron        = require('node-cron');
const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');
const http        = require('http');
const qrcode      = require('qrcode-terminal');
const pino        = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const DB         = { host:'192.168.2.252', port:3306, user:'root', password:'1900', database:'central', connectTimeout:15000 };
const GRUPO_NOME = 'CENTRAL ( Aux ) PREVENÇÃO DE PERDAS';
const LOGO_PATH  = path.join(__dirname, '..', 'public', 'logo.png');
const logger     = pino({ level:'info' });
const NOMES_LOJA = { 1:'CAHU', 2:'MURIBECA', 3:'PONTE', 4:'ATACAREJO', 5:'PORTA LARGA', 6:'JARDIM JORDAO' };
const NUMERO_BOT = '5581991665457'; // pareamento por código, alternativa ao QR

let sock = null;

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

// ── Bot de perguntas (Econômico Assistente) ─────────────────────────────────────

const PENDENTES_PATH = path.join(__dirname, 'pendentes.json');

function carregarPendentes() {
  try { return JSON.parse(fs.readFileSync(PENDENTES_PATH, 'utf8')); }
  catch (_) { return []; }
}
function salvarPendentes(lista) {
  fs.writeFileSync(PENDENTES_PATH, JSON.stringify(lista, null, 2));
}
function jidBase(jid) { return (jid || '').split('@')[0].split(':')[0]; }

function parsePreco(v) { return v && v !== '0' ? parseFloat(String(v).replace(',', '.')) : 0; }

// Extrai o termo de busca removendo palavras comuns da pergunta de custo
function extrairTermoCusto(texto) {
  return texto
    .replace(/qual|quanto|é|eh|o|a|de|da|do|custo|preço|preco|\?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function responderCusto(jid, texto) {
  const termo = extrairTermoCusto(texto);
  if (!termo) {
    await sock.sendMessage(jid, { text: 'Me diga o nome do produto que você quer saber o custo. Ex: "custo coca 2l"' });
    return;
  }

  const conn = await mysql.createConnection(DB);
  try {
    const [rows] = await conn.query(`
      SELECT i.CodigoBarra, TRIM(i.Descricao) as Descricao,
        cj1.Custo as c1, cj2.Custo as c2, cj3.Custo as c3,
        cj4.Custo as c4, cj5.Custo as c5, cj6.Custo as c6
      FROM central.itens i
      LEFT JOIN central.custoloja1 cj1 ON cj1.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.custoloja2 cj2 ON cj2.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.custoloja3 cj3 ON cj3.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.custoloja4 cj4 ON cj4.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.custoloja5 cj5 ON cj5.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.custoloja6 cj6 ON cj6.CodigoBarra = i.CodigoBarra
      WHERE i.Descricao LIKE ? AND i.CodDesativado = 0
      LIMIT 8
    `, ['%' + termo + '%']);

    if (!rows.length) {
      await sock.sendMessage(jid, { text: `Não encontrei nenhum produto com "${termo}" no cadastro.` });
      return;
    }

    let resp = `Encontrei ${rows.length} item(ns) de "${termo}" no cadastro:\n\n`;
    for (const r of rows) {
      const custos = [1,2,3,4,5,6].map(n => parsePreco(r['c'+n])).filter(v => v > 0);
      resp += `• ${r.CodigoBarra} — ${r.Descricao}\n`;
      if (!custos.length) { resp += `  Sem custo cadastrado\n\n`; continue; }
      const min = Math.min(...custos), max = Math.max(...custos);
      resp += min === max
        ? `  Custo: R$ ${min.toFixed(2)}\n\n`
        : `  Custo: R$ ${min.toFixed(2)} até R$ ${max.toFixed(2)} (varia por loja)\n\n`;
    }
    await sock.sendMessage(jid, { text: resp.trim() });
  } finally {
    await conn.end();
  }
}

async function responderPergunta(jid, texto) {
  const meuNumero = jidBase(sock.user.id);
  const remetente = jidBase(jid);
  const ehEuMesmo = remetente === meuNumero;

  // Comandos de administrador — só valem vindo do "Mensagens para você mesmo"
  if (ehEuMesmo) {
    const mResp = texto.match(/^responder\s+(\d+)\s+([\s\S]+)/i);
    if (mResp) {
      const id = parseInt(mResp[1]);
      const resposta = mResp[2].trim();
      const pendentes = carregarPendentes();
      const item = pendentes.find(p => p.id === id && !p.respondida);
      if (!item) { await sock.sendMessage(jid, { text: `Não encontrei a pendência #${id} (ou já foi respondida).` }); return; }
      await sock.sendMessage(item.jid, { text: resposta });
      item.respondida = true;
      salvarPendentes(pendentes);
      await sock.sendMessage(jid, { text: `Respondido! Pendência #${id} encerrada.` });
      return;
    }
    if (/^pendentes\s*$/i.test(texto.trim())) {
      const abertas = carregarPendentes().filter(p => !p.respondida);
      const lista = abertas.length
        ? abertas.map(p => `#${p.id} — "${p.texto}"`).join('\n')
        : 'Nenhuma pendência no momento.';
      await sock.sendMessage(jid, { text: lista });
      return;
    }
    // Reenvio manual do relatório de negativos — usado quando o ERP foi
    // corrigido no meio do dia e as lojas precisam do PDF atualizado sem
    // esperar o cron de amanhã às 8h.
    if (/^reenviar\s+negativos\s*$/i.test(texto.trim())) {
      await sock.sendMessage(jid, { text: 'Buscando negativos atualizados e reenviando pro grupo...' });
      try {
        const porLoja = await buscarNegativos();
        const total = Object.values(porLoja).reduce((s, arr) => s + arr.length, 0);
        if (!total) { await sock.sendMessage(jid, { text: 'Nenhum estoque negativo encontrado agora.' }); return; }
        await enviarPDFsLojas(porLoja);
        await sock.sendMessage(jid, { text: `Reenviado! ${total} produto(s) negativos no total.` });
      } catch (err) {
        logger.error({ err }, 'Erro ao reenviar negativos manualmente');
        await sock.sendMessage(jid, { text: `Erro ao reenviar: ${err.message}` });
      }
      return;
    }
  }

  // Gatilho por palavra-chave ("custo") desativado: o bot está conectado no
  // número pessoal/comercial do Tiago, então qualquer frase comum que
  // mencione "custo" (ex: "o custo da grifos saiu") dispara resposta
  // automática numa conversa real — igual ao problema do bloco abaixo.
  // Reativar só com um jeito de restringir o escopo (grupo específico,
  // prefixo/comando explícito, etc), não texto livre.
  //
  // const t = texto.toLowerCase();
  // if (t.includes('custo')) { await responderCusto(jid, texto); return; }

  // Não reconhecido: o bot está conectado no número pessoal/comercial do
  // Tiago, então NÃO deve responder automaticamente qualquer mensagem que
  // chegue (senão interfere em conversas reais que não são pra ele) —
  // desativado até definir um jeito de restringir isso (ex: só grupo
  // específico, ou só mensagens com um prefixo/comando).
  return;
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth:state, logger:pino({level:'silent'}), printQRInTerminal:false, keepAliveIntervalMs:15000 });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.remoteJid.endsWith('@g.us')) continue; // ignora mensagens de grupo
      // Ignora mensagens antigas reenviadas pelo Baileys numa reconexão —
      // sem isso, toda vez que o WhatsApp cai e reconecta, o bot responde
      // de novo a perguntas de minutos/horas atrás como se fossem novas.
      const idadeSegundos = Date.now() / 1000 - Number(msg.messageTimestamp || 0);
      if (idadeSegundos > 120) continue;
      // Ignora mensagens enviadas por mim para outra pessoa (ex: as próprias
      // respostas do bot), mas permite "Mensagens para você mesmo" — é por lá
      // que os comandos de administrador (responder/pendentes) chegam.
      const ehParaMimMesmo = msg.key.remoteJid.split('@')[0].split(':')[0] === sock.user.id.split('@')[0].split(':')[0];
      if (msg.key.fromMe && !ehParaMimMesmo) continue;
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!texto.trim()) continue;
      try { await responderPergunta(msg.key.remoteJid, texto); }
      catch (err) { logger.error({ err }, 'Erro ao responder pergunta'); }
    }
  });

  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        const codigo = await sock.requestPairingCode(NUMERO_BOT);
        logger.info(`Código de pareamento: ${codigo}  (WhatsApp > Conectar dispositivo > Conectar com número de telefone)`);
      } catch (err) {
        logger.error({ err }, 'Erro ao solicitar código de pareamento');
      }
    }, 3000);
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout conexão WA')), 120000);
    let resolvido = false;

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) { logger.info('Escaneie o QR:'); qrcode.generate(qr, { small:true }); }
      if (connection === 'open') {
        logger.info('WhatsApp conectado');
        if (!resolvido) { resolvido = true; clearTimeout(timer); resolve(); }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          logger.error('Sessão encerrada. Apague auth_info e reinicie.');
          if (!resolvido) { clearTimeout(timer); reject(new Error('Deslogado')); }
          else process.exit(1);
        } else {
          logger.warn('Reconectando...');
          if (resolvido) setTimeout(conectar, 5000);
        }
      }
    });
  });
}

async function enviarPDFsLojas(porLoja) {
  const grupos = await sock.groupFetchAllParticipating();
  let jid = Object.keys(grupos).find(id => grupos[id].subject === GRUPO_NOME);
  if (!jid) {
    // Busca parcial (case-insensitive) como fallback
    const termo = GRUPO_NOME.toLowerCase();
    jid = Object.keys(grupos).find(id => grupos[id].subject.toLowerCase().includes('prevenção') || grupos[id].subject.toLowerCase().includes('prevencao'));
    const todosNomes = Object.values(grupos).map(g => `  • "${g.subject}"`).join('\n');
    if (!jid) {
      logger.error(`Grupo "${GRUPO_NOME}" não encontrado. Grupos disponíveis:\n${todosNomes}`);
      return;
    }
    logger.warn(`Grupo exato não encontrado. Usando: "${grupos[jid].subject}"\nGrupos disponíveis:\n${todosNomes}`);
  }

  const hoje     = new Date();
  const dataStr  = hoje.toLocaleDateString('pt-BR');
  const dataNome = hoje.toISOString().slice(0, 10);

  for (let ln = 1; ln <= 6; ln++) {
    const itens = porLoja[ln] || [];
    logger.info(`Loja ${ln} (${NOMES_LOJA[ln]}): ${itens.length} negativo(s)`);
    if (!itens.length) continue;

    try {
      const { buffer, total } = await gerarPDFLoja(itens, ln, hoje);
      const nomeLoja = (NOMES_LOJA[ln]||'LOJA'+ln).replace(/\s+/g,'_');
      await sock.sendMessage(jid, {
        document: Buffer.from(buffer),
        mimetype: 'application/pdf',
        fileName: `negativos_loja${ln}_${nomeLoja}_${dataNome}.pdf`,
        caption:  `*Estoque Negativo — Loja ${ln} (${NOMES_LOJA[ln]}) — ${dataStr}*\n${total} produto(s) negativos`,
      });
      logger.info(`Loja ${ln}: PDF enviado (${total} itens)`);
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      logger.error({ err }, `Erro ao enviar Loja ${ln}`);
    }
  }
}

// ── Rotina ────────────────────────────────────────────────────────────────────

async function rotina() {
  logger.info('Iniciando rotina de negativos...');
  try {
    // Garante que o WhatsApp está conectado antes de rodar (espera até 1 min)
    for (let i = 0; i < 12 && (!sock || !sock.user); i++) {
      logger.warn('WhatsApp não conectado ainda. Aguardando 5s...');
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!sock || !sock.user) {
      logger.error('WhatsApp não conectou a tempo. Abortando rotina de hoje.');
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
  if (req.url !== '/reenviar-negativos') { res.writeHead(404); res.end(); return; }
  try {
    if (!sock || !sock.user) { res.writeHead(503); res.end(JSON.stringify({ error: 'WhatsApp não conectado.' })); return; }
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
  logger.info('Conectando ao WhatsApp...');
  for (;;) {
    try {
      await conectar();
      logger.info('WhatsApp conectado com sucesso.');
      break;
    } catch (err) {
      logger.error({ err }, 'Falha ao conectar. Tentando novamente em 10s...');
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  cron.schedule('0 8 * * 1-5', rotina, { timezone:'America/Sao_Paulo' });
  logger.info('Agendamento ativo: seg-sex 08:00 (Brasília). Aguardando...');
})();
