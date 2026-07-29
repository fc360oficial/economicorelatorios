'use strict';
const mysql       = require('mysql2/promise');
const cron        = require('node-cron');
const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');
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
// Estilo: fundo branco, texto navy escuro, acento laranja/âmbar

function gerarPDFLoja(itens, ln, hoje) {
  const rows = itens; // já filtrado por loja
  const doc    = new PDFDocument({ size:'A4', margin:0, bufferPages:true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const PW = 595, PH = 842, ML = 36, MR = 36, CW = PW - ML - MR;

  // Colunas da tabela
  const C = {
    cod:  { x: ML,       w: 108 },
    desc: { x: ML + 108, w: 252 },
    est:  { x: ML + 360, w: 88  },
    sis:  { x: ML + 448, w: CW - 360 - 88 },
  };

  // Paleta "Executive Ink" — a mesma dos relatórios estratégicos (navy + âmbar só como acento pontual)
  const COR = {
    branco:   '#FFFFFF',
    navy:     '#0E1626',
    navySec:  '#4E5A72',
    navyTer:  '#98A0B3',
    cinza:    '#F4F4F2',
    cinzaMd:  '#E4E4E1',
    borda:    '#DADAD6',
    laranja:  '#F5B800',
    laranjaL: '#FFF6D9',
    vermelho: '#E53E3E',
    verde:    '#38A169',
  };

  const ROW_H = 15, GRP_H = 17, COL_H = 19;

  function ln_(x1,y1,x2,y2, c=COR.borda, w=0.5) {
    doc.strokeColor(c).lineWidth(w).moveTo(x1,y1).lineTo(x2,y2).stroke();
  }

  function txt(text, x, y, w, h, { cor=COR.navy, font='Helvetica', size=8, align='left', pad=5 }={}) {
    doc.fillColor(cor).fontSize(size).font(font)
       .text(String(text||''), x+pad, y+Math.max(0,(h-size)/2), { width:w-pad*2, align, lineBreak:false });
  }

  const dataHora = hoje.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})
                 + '  —  ' + hoje.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const dataLabel = `GERADO EM\n${hoje.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'})}\n${hoje.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;

  function cabecalho() {
    // Fundo branco total
    doc.rect(0, 0, PW, PH).fill(COR.branco);

    // Header top — linha fina laranja no topo
    doc.rect(0, 0, PW, 2).fill(COR.laranja);

    // Área do cabeçalho
    const HDR = 68;
    doc.rect(0, 2, PW, HDR).fill(COR.branco);

    // Logo
    const temLogo = fs.existsSync(LOGO_PATH);
    if (temLogo) { try { doc.image(LOGO_PATH, ML, 12, { height: 44 }); } catch(_) {} }

    // Nome empresa
    const txX = temLogo ? ML + 54 : ML;
    doc.fillColor(COR.laranja).fontSize(8).font('Helvetica-Bold')
       .text('ECONÔMICO RELATÓRIOS', txX, 16, { width: 180, lineBreak:false });
    doc.fillColor(COR.navySec).fontSize(9.5).font('Helvetica')
       .text('Auditoria de Estoque Negativo', txX, 28, { width: 180, lineBreak:false });
    doc.fillColor(COR.borda).fontSize(8).font('Helvetica')
       .text('Relatório Operacional', txX, 42, { width: 180, lineBreak:false });

    // Data geração — canto direito (estilo do exemplo)
    const dL = hoje.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'});
    const hL = hoje.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    doc.fillColor(COR.navySec).fontSize(6.5).font('Helvetica')
       .text('GERADO EM', ML, 14, { width:CW, align:'right', lineBreak:false });
    doc.fillColor(COR.navy).fontSize(13).font('Helvetica-Bold')
       .text(dL, ML, 23, { width:CW, align:'right', lineBreak:false });
    doc.fillColor(COR.navySec).fontSize(9).font('Helvetica')
       .text(hL, ML, 39, { width:CW, align:'right', lineBreak:false });

    // Divisor fino cinza
    ln_(ML, HDR+2, PW-MR, HDR+2, COR.borda, 0.8);

    let y = HDR + 10;

    // Título da loja com barra laranja à esquerda (estilo do exemplo)
    doc.rect(ML, y, 3, 26).fill(COR.laranja);
    doc.fillColor(COR.navy).fontSize(16).font('Helvetica-Bold')
       .text(`LOJA ${ln}  —  ${NOMES_LOJA[ln]||'LOJA '+ln}`, ML+10, y+4, { width:CW-10, lineBreak:false });
    doc.fillColor(COR.navySec).fontSize(8).font('Helvetica')
       .text('Estoque Negativo por Mercadológico', ML+10, y+22, { width:CW-10, lineBreak:false });

    y += 36;

    // Cabeçalho colunas — fundo cinza claro com label laranja
    doc.rect(0, y, PW, COL_H).fill(COR.cinzaMd);
    ln_(0, y, PW, y, COR.borda, 0.5);
    ln_(0, y+COL_H, PW, y+COL_H, COR.borda, 0.5);

    txt('CÓDIGO',       C.cod.x,  y, C.cod.w,  COL_H, { cor:COR.navySec, font:'Helvetica-Bold', size:7, align:'left' });
    txt('DESCRIÇÃO',    C.desc.x, y, C.desc.w, COL_H, { cor:COR.navySec, font:'Helvetica-Bold', size:7 });
    txt('ESTOQUE/LOJA', C.est.x,  y, C.est.w,  COL_H, { cor:COR.navySec, font:'Helvetica-Bold', size:7, align:'center' });
    txt('SISTEMA',      C.sis.x,  y, C.sis.w,  COL_H, { cor:COR.navySec, font:'Helvetica-Bold', size:7, align:'center' });

    // Divisores verticais cabeçalho
    ln_(C.desc.x, y, C.desc.x, y+COL_H, COR.borda);
    ln_(C.est.x,  y, C.est.x,  y+COL_H, COR.borda);
    ln_(C.sis.x,  y, C.sis.x,  y+COL_H, COR.borda);

    return y + COL_H;
  }

  // ── Conteúdo ────────────────────────────────────────────────────────────────
  let y = cabecalho();

  // Agrupa: Grupo → SubGrupo → produtos (igual ao mercadológico do ERP)
  const arvore = {};
  rows.forEach(r => {
    const grp = (r.Grupo    || 'SEM GRUPO').toUpperCase();
    const sub = (r.SubGrupo || 'SEM SUBGRUPO').toUpperCase();
    if (!arvore[grp]) arvore[grp] = {};
    if (!arvore[grp][sub]) arvore[grp][sub] = [];
    arvore[grp][sub].push(r);
  });

  const SUB_H = 14; // altura da linha de subgrupo
  let idx = 0;

  for (const [nomeGrupo, subGrupos] of Object.entries(arvore)) {
    if (y > 788) { doc.addPage(); doc.rect(0,0,PW,PH).fill(COR.branco); y = retomarCabecalho(); }

    // Cabeçalho do GRUPO — fundo neutro, texto navy, acento âmbar à esquerda
    doc.rect(0, y, PW, GRP_H).fill(COR.cinzaMd);
    doc.rect(0, y, 3, GRP_H).fill(COR.laranja);
    doc.fillColor(COR.navy).fontSize(8).font('Helvetica-Bold')
       .text(nomeGrupo, ML + 6, y + (GRP_H - 8) / 2, { width: CW - 6, lineBreak: false });
    y += GRP_H;

    for (const [nomeSub, produtos] of Object.entries(subGrupos)) {
      if (y > 790) { doc.addPage(); doc.rect(0,0,PW,PH).fill(COR.branco); y = retomarCabecalho(); }

      // Sub-cabeçalho — fundo branco, texto navy secundário, indentado
      doc.rect(0, y, PW, SUB_H).fill(COR.branco);
      ln_(0, y+SUB_H, PW, y+SUB_H, COR.borda, 0.4);
      doc.fillColor(COR.navyTer).fontSize(7).font('Helvetica-Bold')
         .text('▸', ML + 10, y + (SUB_H - 7) / 2, { width: 10, lineBreak: false });
      doc.fillColor(COR.navySec).fontSize(7).font('Helvetica-Bold')
         .text(nomeSub, ML + 22, y + (SUB_H - 7) / 2, { width: CW - 22, lineBreak: false });
      y += SUB_H;

      for (const r of produtos) {
        if (y > 800) { doc.addPage(); doc.rect(0,0,PW,PH).fill(COR.branco); y = retomarCabecalho(); }

        const bg = idx % 2 === 0 ? COR.branco : COR.cinza;
        doc.rect(0, y, PW, ROW_H).fill(bg);

        txt(r.Codigo||'',                             C.cod.x,  y, C.cod.w,  ROW_H, { size:7.5 });
        txt(String(r.Descricao||'').substring(0,54),  C.desc.x, y, C.desc.w, ROW_H, { size:7.5 });
        txt('',                                       C.est.x,  y, C.est.w,  ROW_H, { size:7.5, align:'center' });
        txt(String(r.Estoque),                        C.sis.x,  y, C.sis.w,  ROW_H, { cor:COR.vermelho, font:'Helvetica-Bold', size:7.5, align:'center' });

        ln_(0,        y+ROW_H, PW,       y+ROW_H, COR.borda, 0.3);
        ln_(C.desc.x, y,       C.desc.x, y+ROW_H, COR.borda, 0.3);
        ln_(C.est.x,  y,       C.est.x,  y+ROW_H, COR.borda, 0.3);
        ln_(C.sis.x,  y,       C.sis.x,  y+ROW_H, COR.borda, 0.3);

        y += ROW_H; idx++;
      }
    }
  }

  // Rodapé total
  if (y > 808) { doc.addPage(); doc.rect(0,0,PW,PH).fill(COR.branco); y = retomarCabecalho(); }
  ln_(ML, y, PW-MR, y, COR.laranja, 0.8);
  y += 6;
  doc.fillColor(COR.navySec).fontSize(7.5).font('Helvetica-Bold')
     .text(`TOTAL: ${itens.length} produto(s) com estoque negativo nesta loja`, ML, y, { width:CW });

  // Rodapé da página
  doc.rect(0, PH-20, PW, 20).fill(COR.cinzaMd);
  ln_(0, PH-20, PW, PH-20, COR.laranja, 1.5);
  doc.fillColor(COR.navySec).fontSize(6.5).font('Helvetica')
     .text('ECONÔMICO RELATÓRIOS  |  Gerado automaticamente  |  Uso interno', ML, PH-13, { align:'center', width:CW, lineBreak:false });

  // retomarCabecalho para novas páginas (sem o header da loja, só colunas)
  function retomarCabecalho() {
    doc.rect(0, 0, PW, 2).fill(COR.laranja);
    doc.rect(0, 2, PW, 28).fill(COR.branco);
    doc.fillColor(COR.navySec).fontSize(7).font('Helvetica-Bold')
       .text(`ECONÔMICO RELATÓRIOS  |  Loja ${ln} — ${NOMES_LOJA[ln]||''}  |  (continuação)`, ML, 10, { width:CW, lineBreak:false });
    const yy = 30;
    doc.rect(0, yy, PW, COL_H).fill(COR.cinzaMd);
    ln_(0, yy, PW, yy, COR.borda, 0.5);
    ln_(0, yy+COL_H, PW, yy+COL_H, COR.borda, 0.5);
    txt('CÓDIGO',       C.cod.x,  yy, C.cod.w,  COL_H, { cor:COR.navySec, font:'Helvetica-Bold', size:7 });
    txt('DESCRIÇÃO',    C.desc.x, yy, C.desc.w, COL_H, { cor:COR.navySec, font:'Helvetica-Bold', size:7 });
    txt('ESTOQUE/LOJA', C.est.x,  yy, C.est.w,  COL_H, { cor:COR.navySec, font:'Helvetica-Bold', size:7, align:'center' });
    txt('SISTEMA',      C.sis.x,  yy, C.sis.w,  COL_H, { cor:COR.navySec, font:'Helvetica-Bold', size:7, align:'center' });
    ln_(C.desc.x, yy, C.desc.x, yy+COL_H, COR.borda);
    ln_(C.est.x,  yy, C.est.x,  yy+COL_H, COR.borda);
    ln_(C.sis.x,  yy, C.sis.x,  yy+COL_H, COR.borda);
    return yy + COL_H;
  }

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
  }

  const t = texto.toLowerCase();
  if (t.includes('custo')) { await responderCusto(jid, texto); return; }

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
