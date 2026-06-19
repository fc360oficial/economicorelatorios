const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

// Carrega usuários do arquivo
const usuarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'usuarios.json'), 'utf8'));

// Sessão (8 horas)
app.use(session({
  secret: 'ec0n0mic0-bi-2026-xK9#mP',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// Middleware de autenticação (antes do static)
app.use((req, res, next) => {
  const publico = ['/login.html', '/api/login', '/logo.png', '/deploy',
    '/precificacao.html', '/compras.html', '/comprador.html', '/supervisao.html',
    '/api/precificacao/margens-criticas', '/api/compras/pedidos-hoje',
    '/diretoria.html', '/api/diretoria/kpis',
    '/api/top-vendidos', '/api/top-mercadologico',
    '/api/compras/verificar-comprador',
    '/api/compras/analise-estoque',
    '/analise-comprador.html',
    '/api/compras/fornec-por-lista',
    '/api/compras/pedidos-mes',
    '/mensal.html',
    '/comparativo-tv.html', '/api/comparativo-tv'];
  if (publico.includes(req.path)) return next();
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  return res.redirect('/login.html');
});

// Arquivos estáticos (após auth)
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH ENDPOINTS ──────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ error: 'Preencha usuário e senha.' });
  const user = usuarios.find(u => u.usuario === usuario.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  const ok = await bcrypt.compare(String(senha), user.senha_hash);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  req.session.user = { id: user.id, nome: user.nome, usuario: user.usuario };
  res.json({ ok: true, nome: user.nome });
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

app.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json(req.session.user);
});

const dbConfig = {
  host: '192.168.2.252',
  port: 3306,
  user: 'root',
  password: '1900',
  connectTimeout: 15000
};

// Mapeamento baseado em central.tipo_finalizadora
const pagtoLabels = {
  '01': 'PIX / Débito', '02': 'Crédito', '03': 'Voucher',
  '04': 'POS', '98': 'Dinheiro', '99': 'Outros'
};

async function q(sql, params = []) {
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
  } catch(connErr) {
    console.error('[DB-CONN-ERR]', connErr.code, connErr.errno, connErr.message, connErr.sqlMessage);
    throw new Error(connErr.message || connErr.code || JSON.stringify(connErr));
  }
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } catch(queryErr) {
    console.error('[DB-QUERY-ERR]', queryErr.code, queryErr.message, sql.substring(0,80));
    throw new Error(queryErr.message || queryErr.code || JSON.stringify(queryErr));
  } finally {
    await conn.end().catch(()=>{});
  }
}

function mesDB(mes) {
  return 'mes' + String(mes).padStart(2, '0');
}

function buildUnionSemana(mes, dataInicio, dataFim) {
  const lojas = [1, 2, 3, 4, 5, 6];
  return lojas.map(ln =>
    `SELECT Codigo, Descricao, QtdNovo, ValorTotalNovo FROM \`ln${ln}${mesDB(mes)}\`.zcupomitens WHERE Data BETWEEN '${dataInicio}' AND '${dataFim}' AND IndCancel='N'`
  ).join(' UNION ALL ');
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

// Data local (sem timezone UTC) — evita bug de virar dia às 21h no Brasil
function localDate(d) {
  const dt = d || new Date();
  const y  = dt.getFullYear();
  const m  = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Último dia real do mês — evita '2026-06-31' (data inválida) que retorna NULL no MySQL
function dFimMes(ano, mes) {
  const ultimo = new Date(ano, mes, 0).getDate();
  return `${ano}-${String(mes).padStart(2,'0')}-${String(ultimo).padStart(2,'0')}`;
}

// KPIs resumo — aceita ?loja=1..6 e ?mes=1..12
app.get('/api/kpis', async (req, res) => {
  try {
    const hoje = new Date();
    const ano  = hoje.getFullYear();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;

    const anoAnt  = ano - 1;
    const mm      = mesDB(mesSel);
    const mmAnt   = mesDB(mesSel);
    const lojas   = lojaSel ? [lojaSel] : [1,2,3,4,5,6];

    const diaHoje = String(hoje.getDate()).padStart(2,'0');
    const mesStr  = String(mesSel).padStart(2,'0');

    const dIni        = `${ano}-${mesStr}-01`;
    const dFim        = dFimMes(ano, mesSel);
    const dIniAnt     = `${anoAnt}-${mesStr}-01`;
    const dFimAntHoje = `${anoAnt}-${mesStr}-${diaHoje}`;  // mesmo dia do ano passado
    const dFimAntMes  = dFimMes(anoAnt, mesSel);           // mês completo ano passado

    // Faturamento + custo + cupons mês atual
    let atual = 0, custoAtual = 0, totalCupons = 0;
    for (const ln of lojas) {
      try {
        const [r] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda, COALESCE(SUM(Custo),0) as custo, COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIni, dFim]
        );
        atual        += parseFloat(r.venda || 0);
        custoAtual   += parseFloat(r.custo || 0);
        totalCupons  += parseInt(r.cupons || 0);
      } catch(_) {}
    }

    // Ano anterior: mesmo mês até mesmo dia + mês completo
    let antAteDia = 0, antMesTotal = 0;
    for (const ln of lojas) {
      try {
        const [r1] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda FROM \`ln${ln}${mmAnt}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIniAnt, dFimAntHoje]
        );
        antAteDia += parseFloat(r1.venda || 0);
        const [r2] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda FROM \`ln${ln}${mmAnt}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIniAnt, dFimAntMes]
        );
        antMesTotal += parseFloat(r2.venda || 0);
      } catch(_) {}
    }

    // Produtos únicos vendidos na semana
    const dataFim    = fmtDate(hoje);
    const inicioSem  = new Date(hoje); inicioSem.setDate(hoje.getDate() - 6);
    const dataInicio = fmtDate(inicioSem);
    let prodSemana = { total: 0 };
    try {
      const union = lojas.map(ln =>
        `SELECT Codigo FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN '${dataInicio}' AND '${dataFim}' AND IndCancel='N'`
      ).join(' UNION ALL ');
      [prodSemana] = await q(`SELECT COUNT(DISTINCT Codigo) as total FROM (${union}) t`);
    } catch(_) {}

    const variacaoAno = antAteDia > 0 ? (((atual - antAteDia) / antAteDia) * 100).toFixed(1) : 0;
    const lucroAtual  = atual - custoAtual;
    const margemSC    = custoAtual > 0 ? +(lucroAtual / custoAtual * 100).toFixed(2) : 0;
    const margemSV    = atual > 0      ? +(lucroAtual / atual      * 100).toFixed(2) : 0;

    const ticketMedio = totalCupons > 0 ? +(atual / totalCupons).toFixed(2) : 0;

    res.json({
      faturamento_mes: +atual.toFixed(2),
      fat_ano_ant_ate_dia: +antAteDia.toFixed(2),
      fat_ano_ant_mes_total: +antMesTotal.toFixed(2),
      variacao_percentual: parseFloat(variacaoAno),
      ticket_medio: ticketMedio,
      total_cupons: totalCupons,
      margem_sc: margemSC,
      margem_sv: margemSV,
      mes: mesSel,
      ano_ant: anoAnt,
      dia_ate: diaHoje,
      loja: lojaSel || 'todas'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KPIs por loja — painel diretoria
app.get('/api/diretoria/kpis', async (req, res) => {
  try {
    const hoje   = new Date();
    const ano    = hoje.getFullYear();
    const mes    = hoje.getMonth() + 1;
    const anoAnt = ano - 1;
    const mm     = mesDB(mes);
    const diaHoje = String(hoje.getDate()).padStart(2,'0');
    const mesStr  = String(mes).padStart(2,'0');
    const dIni        = `${ano}-${mesStr}-01`;
    const dFim        = dFimMes(ano, mes);
    const dIniAnt     = `${anoAnt}-${mesStr}-01`;
    const dFimAntHoje = `${anoAnt}-${mesStr}-${diaHoje}`;

    const lojas = await Promise.all([1,2,3,4,5,6].map(async ln => {
      try {
        const [r] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda, COALESCE(SUM(Custo),0) as custo,
                  COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons
           FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIni, dFim]
        );
        const [r1] = await q(
          `SELECT COALESCE(SUM(ValorTotalNovo),0) as venda
           FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N'`,
          [dIniAnt, dFimAntHoje]
        );
        const venda  = parseFloat(r.venda  || 0);
        const custo  = parseFloat(r.custo  || 0);
        const cupons = parseInt(r.cupons   || 0);
        const antAteDia = parseFloat(r1.venda || 0);
        const variacao  = antAteDia > 0 ? +((venda - antAteDia) / antAteDia * 100).toFixed(1) : 0;
        const msv    = venda  > 0 ? +((venda - custo) / venda * 100).toFixed(1) : 0;
        const ticket = cupons > 0 ? +(venda / cupons).toFixed(2) : 0;
        return { loja: ln, faturamento: +venda.toFixed(2), fat_ant_ate_dia: +antAteDia.toFixed(2), variacao, msv, ticket, cupons };
      } catch(e) {
        return { loja: ln, faturamento: 0, fat_ant_ate_dia: 0, variacao: 0, msv: 0, ticket: 0, cupons: 0 };
      }
    }));

    res.json({ lojas, mes, dia_ate: diaHoje, ano_ant: anoAnt });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 1. Produtos mais vendidos essa semana
app.get('/api/produtos-semana', async (req, res) => {
  try {
    const hoje   = new Date();
    const mes    = hoje.getMonth() + 1;
    const dataFim   = fmtDate(hoje);
    const inicio    = new Date(hoje); inicio.setDate(hoje.getDate() - 6);
    const dataInicio = fmtDate(inicio);
    const mm     = mesDB(mes);
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas  = lojaSel ? [lojaSel] : [1,2,3,4,5,6];

    const mapa = {};
    for (const ln of lojas) {
      const db = 'ln' + ln + mm;
      try {
        const rows = await q(
          'SELECT Codigo, TRIM(Descricao) as desc_, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as val FROM `' + db + '`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel=\'N\' GROUP BY Codigo, Descricao',
          [dataInicio, dataFim]
        );
        for (const r of rows) {
          const k = r.Codigo;
          if (!mapa[k]) mapa[k] = { codigobarras: k, descricao: r.desc_?.trim(), total_semana: 0, total_valor: 0 };
          mapa[k].total_semana += parseFloat(r.qtd || 0);
          mapa[k].total_valor  += parseFloat(r.val || 0);
        }
      } catch (e) {}
    }

    const codigos = Object.keys(mapa);
    if (codigos.length > 0) {
      const ph = codigos.map(() => '?').join(',');
      const itensRows = await q(`SELECT CodigoBarra, Descricao FROM central.itens WHERE CodigoBarra IN (${ph})`, codigos);
      for (const r of itensRows) {
        if (mapa[r.CodigoBarra]) mapa[r.CodigoBarra].descricao = r.Descricao?.trim() || mapa[r.CodigoBarra].descricao;
      }
    }

    res.json(Object.values(mapa).sort((a,b) => b.total_semana - a.total_semana).slice(0,15));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Faturamento mensal do ano
app.get('/api/faturamento-mensal', async (req, res) => {
  try {
    const ano     = new Date().getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    let sql = 'SELECT Mes, SUM(Total) as total FROM dashboard.vendas WHERE Ano=?';
    const params = [ano];
    if (lojaSel) { sql += ' AND nLoja=?'; params.push(lojaSel); }
    sql += ' GROUP BY Mes ORDER BY Mes';
    const rows = await q(sql, params);
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    res.json(rows.map(r => ({ mes: meses[r.Mes - 1], total: parseFloat(r.total) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Top 10 mais vendidos por loja e mês
app.get('/api/top-vendidos', async (req, res) => {
  try {
    const hoje   = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas   = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const mm      = mesDB(mesSel);
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const ultimoDia = new Date(anoSel, mesSel, 0).getDate();
    const dFim    = `${anoSel}-${String(mesSel).padStart(2,'0')}-${String(ultimoDia).padStart(2,'0')}`;

    let union;
    if (lojaSel) {
      union = `SELECT Codigo, Descricao, QtdNovo, ValorTotalNovo FROM \`ln${lojaSel}${mm}\`.zcupomitens WHERE IndCancel='N' AND Data BETWEEN '${dIni}' AND '${dFim}'`;
    } else {
      const partes = await Promise.all(lojas.map(async ln => {
        const d = `ln${ln}${mm}`;
        try {
          const [t] = await q(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='zcupomitens'`, [d]);
          return t ? `SELECT Codigo, Descricao, QtdNovo, ValorTotalNovo FROM \`${d}\`.zcupomitens WHERE IndCancel='N' AND Data BETWEEN '${dIni}' AND '${dFim}'` : null;
        } catch(e) { return null; }
      }));
      const validas = partes.filter(Boolean);
      if (!validas.length) return res.json([]);
      union = validas.join(' UNION ALL ');
    }

    const rows = await q(
      `SELECT Codigo, TRIM(Descricao) as descricao,
              SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as faturamento
       FROM (${union}) t
       GROUP BY Codigo, Descricao
       ORDER BY qtd DESC
       LIMIT 10`
    );
    if (rows.length) {
      const ph = rows.map(() => '?').join(',');
      const itens = await q(`SELECT CodigoBarra, Descricao FROM central.itens WHERE CodigoBarra IN (${ph})`, rows.map(r => r.Codigo));
      const itensMap = {};
      for (const i of itens) itensMap[i.CodigoBarra] = i.Descricao?.trim();
      res.json(rows.map(r => ({
        descricao: itensMap[r.Codigo] || r.descricao,
        qtd: parseFloat(r.qtd),
        faturamento: parseFloat(r.faturamento)
      })));
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top mercadológico por mês
app.get('/api/top-mercadologico', async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const anoSel  = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas   = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const mm      = mesDB(mesSel);
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const ultimoDia = new Date(anoSel, mesSel, 0).getDate();
    const dFim    = `${anoSel}-${String(mesSel).padStart(2,'0')}-${String(ultimoDia).padStart(2,'0')}`;

    // Vendas do mês por produto
    let vendasMap = {};
    for (const ln of lojas) {
      try {
        const rows = await q(`SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor
          FROM \`ln${ln}${mm}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIni, dFim]);
        for (const r of rows) {
          if (!vendasMap[r.Codigo]) vendasMap[r.Codigo] = { qtd: 0, valor: 0 };
          vendasMap[r.Codigo].qtd   += parseFloat(r.qtd);
          vendasMap[r.Codigo].valor += parseFloat(r.valor);
        }
      } catch(e) {}
    }

    // Itens com mercadológico (gruposub tem a descrição)
    const itens = await q(`
      SELECT i.CodigoBarra, i.CodGrupoSub,
             gs.Descricao as merc_desc
      FROM central.itens i
      INNER JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub AND gs.CodDesativado = 0
      WHERE i.CodDesativado = 0 AND i.CodGrupoSub > 0
    `);

    // Agrupa por mercadológico
    const mMap = {};
    for (const it of itens) {
      const v = vendasMap[it.CodigoBarra];
      if (!v) continue;
      const key = it.CodGrupoSub;
      if (!mMap[key]) mMap[key] = { descricao: it.merc_desc?.trim(), qtd: 0, valor: 0 };
      mMap[key].qtd   += v.qtd;
      mMap[key].valor += v.valor;
    }

    const result = Object.values(mMap)
      .filter(r => r.qtd > 0)
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 15)
      .map(r => ({
        descricao: r.descricao,
        qtd:       +r.qtd.toFixed(0),
        valor:     +r.valor.toFixed(2)
      }));

    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 4. Vendas por forma de pagamento
app.get('/api/formas-pagamento', async (req, res) => {
  try {
    const hoje    = new Date();
    const ano     = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : null;
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    let sql = 'SELECT TipoPagto, SUM(Total) as total FROM dashboard.tipovendas WHERE Ano=?';
    const params = [ano];
    if (mesSel)  { sql += ' AND Mes=?';   params.push(mesSel); }
    if (lojaSel) { sql += ' AND nLoja=?'; params.push(lojaSel); }
    sql += ' GROUP BY TipoPagto ORDER BY total DESC';
    const rows = await q(sql, params);
    res.json(rows.map(r => ({
      tipo: pagtoLabels[r.TipoPagto] || `Tipo ${r.TipoPagto}`,
      total: parseFloat(r.total)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Consulta dinâmica por loja/período
app.get('/api/consulta', async (req, res) => {
  try {
    const { loja, inicio, fim, ordenar = 'qtd', top = 20, produto = '' } = req.query;

    if (!loja || !inicio || !fim) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios: loja, inicio, fim' });
    }

    const dataInicio = inicio;
    const dataFim = fim;
    const limite = Math.min(parseInt(top) || 20, 100);
    const ordem = ordenar === 'valor' ? 'total_valor DESC' : 'total_qtd DESC';

    // Descobre quais bancos mes01-mes12 precisam ser consultados
    const d1 = new Date(dataInicio + 'T12:00:00');
    const d2 = new Date(dataFim + 'T12:00:00');
    const mesesNeeded = new Set();
    const cur = new Date(d1.getFullYear(), d1.getMonth(), 1);
    while (cur <= d2) {
      mesesNeeded.add(String(cur.getMonth() + 1).padStart(2, '0'));
      cur.setMonth(cur.getMonth() + 1);
    }

    const lojas = loja === 'todas' ? [1, 2, 3, 4, 5, 6] : [parseInt(loja)];

    // Se há filtro de produto, busca códigos pela descrição COMPLETA no cadastro central
    let codigosFiltro = null;
    let nomesCompletos = {};
    if (produto) {
      const itensCad = await q(
        'SELECT CodigoBarra, Descricao FROM central.itens WHERE Descricao LIKE ?',
        ['%' + produto + '%']
      );
      codigosFiltro = itensCad.map(r => r.CodigoBarra);
      itensCad.forEach(r => { nomesCompletos[r.CodigoBarra] = r.Descricao?.trim(); });
      if (!codigosFiltro.length) return res.json({ total_produtos: 0, total_faturamento: 0, total_itens: 0, modo_todas: loja === 'todas', data: [] });
    }

    const modoTodas = loja === 'todas';
    const mapa = {};
    for (const mm of mesesNeeded) {
      for (const ln of lojas) {
        const db = 'ln' + ln + 'mes' + mm;
        try {
          let filtroNome = '';
          let params = [dataInicio, dataFim];
          if (codigosFiltro) {
            filtroNome = ' AND Codigo IN (' + codigosFiltro.map(() => '?').join(',') + ')';
            params = [dataInicio, dataFim, ...codigosFiltro];
          }
          const rows = await q(
            'SELECT Codigo, TRIM(Descricao) as desc_, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as val, COUNT(DISTINCT CCF) as cupons FROM `' + db + '`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel=\'N\'' + filtroNome + ' GROUP BY Codigo, Descricao',
            params
          );
          for (const r of rows) {
            const k = r.Codigo;
            const nomeCompleto = nomesCompletos[k] || r.desc_?.trim();
            if (!mapa[k]) mapa[k] = { codigo: k, produto: nomeCompleto, total_qtd: 0, total_valor: 0, cupons: 0,
              lojas: {1:0,2:0,3:0,4:0,5:0,6:0}, valor_lojas: {1:0,2:0,3:0,4:0,5:0,6:0} };
            const qtd = parseFloat(r.qtd || 0);
            const val = parseFloat(r.val || 0);
            mapa[k].total_qtd += qtd;
            mapa[k].total_valor += val;
            mapa[k].cupons += parseInt(r.cupons || 0);
            if (modoTodas) {
              mapa[k].lojas[ln] = (mapa[k].lojas[ln] || 0) + qtd;
              mapa[k].valor_lojas[ln] = (mapa[k].valor_lojas[ln] || 0) + val;
            }
          }
        } catch (e) { /* banco não existe para esse período */ }
      }
    }

    // Enrich all product descriptions with NF-e names from central.itens
    const todoscodigos = Object.keys(mapa);
    if (todoscodigos.length > 0 && !codigosFiltro) {
      const ph = todoscodigos.map(() => '?').join(',');
      const itensEnrich = await q(`SELECT CodigoBarra, Descricao FROM central.itens WHERE CodigoBarra IN (${ph})`, todoscodigos);
      for (const it of itensEnrich) {
        if (mapa[it.CodigoBarra]) mapa[it.CodigoBarra].produto = it.Descricao?.trim() || mapa[it.CodigoBarra].produto;
      }
    }

    const result = Object.values(mapa)
      .map(r => {
        const base = {
          ...r,
          total_qtd: parseFloat(r.total_qtd.toFixed(3)),
          total_valor: parseFloat(r.total_valor.toFixed(2)),
          ticket_medio: r.cupons > 0 ? parseFloat((r.total_valor / r.cupons).toFixed(2)) : 0
        };
        if (modoTodas) {
          base.lojas = Object.fromEntries(Object.entries(r.lojas).map(([k,v]) => [k, parseFloat(v.toFixed(3))]));
          base.valor_lojas = Object.fromEntries(Object.entries(r.valor_lojas).map(([k,v]) => [k, parseFloat(v.toFixed(2))]));
        } else {
          delete base.lojas;
          delete base.valor_lojas;
        }
        return base;
      })
      .sort((a, b) => ordenar === 'valor' ? b.total_valor - a.total_valor : b.total_qtd - a.total_qtd)
      .slice(0, limite);

    res.json({
      total_produtos: result.length,
      total_faturamento: parseFloat(result.reduce((s, r) => s + r.total_valor, 0).toFixed(2)),
      total_itens: parseFloat(result.reduce((s, r) => s + r.total_qtd, 0).toFixed(0)),
      modo_todas: modoTodas,
      data: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grupos e subgrupos para popular dropdowns
app.get('/api/grupos', async (req, res) => {
  try {
    const grupos = await q(`
      SELECT g.CodGrupo, g.Descricao as grupo,
             gs.CodSubGrupo, gs.Descricao as subgrupo,
             COUNT(i.nInterno) as total,
             SUM(CASE WHEN i.CodDesativado=0 THEN 1 ELSE 0 END) as ativos
      FROM central.grupo g
      LEFT JOIN central.gruposub gs ON gs.CodGrupo = g.CodGrupo
      LEFT JOIN central.itens i ON i.CodGrupoSub = gs.CodSubGrupo
      WHERE g.CodGrupo NOT IN (1,59,61,63,66,65,67)
      GROUP BY g.CodGrupo, gs.CodSubGrupo
      HAVING total > 0
      ORDER BY g.Descricao, gs.Descricao
    `);
    // Monta hierarquia
    const mapa = {};
    for (const r of grupos) {
      if (!mapa[r.CodGrupo]) mapa[r.CodGrupo] = { id: r.CodGrupo, nome: r.grupo, subs: [] };
      if (r.CodSubGrupo) {
        mapa[r.CodGrupo].subs.push({ id: r.CodSubGrupo, nome: r.subgrupo, total: r.total, ativos: r.ativos });
      }
    }
    res.json(Object.values(mapa));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function parsePreco(v) { return v && v !== '0' ? parseFloat(String(v).replace(',', '.')) : 0; }

// Consulta de itens por grupo/subgrupo
app.get('/api/itens', async (req, res) => {
  try {
    const { grupo, subgrupo, ativo, busca, loja = '1', pagina = 1, limite = 50 } = req.query;
    const ln = parseInt(loja) || 1;
    const offset = (parseInt(pagina) - 1) * parseInt(limite);

    let where = [];
    let params = [];

    if (subgrupo) { where.push('i.CodGrupoSub = ?'); params.push(parseInt(subgrupo)); }
    else if (grupo) { where.push('g.CodGrupo = ?'); params.push(parseInt(grupo)); }

    if (ativo === '1') { where.push('i.CodDesativado = 0'); }
    else if (ativo === '0') { where.push('i.CodDesativado = 1'); }

    if (busca) { where.push('i.Descricao LIKE ?'); params.push('%' + busca + '%'); }

    const filtro = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [total] = await q(`
      SELECT COUNT(*) as cnt
      FROM central.itens i
      LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
      LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
      ${filtro}
    `, params);

    // Modo todas as lojas
    if (loja === 'todas') {
      const rows = await q(`
        SELECT
          i.nInterno, i.CodigoBarra, i.Descricao,
          i.CodDesativado, i.Unid, i.Marca,
          i.P1, i.P2, i.P3, i.P4, i.P5, i.P6,
          e1.Qtd as est1, e2.Qtd as est2, e3.Qtd as est3,
          e4.Qtd as est4, e5.Qtd as est5, e6.Qtd as est6,
          cj1.Custo as custo1, cj2.Custo as custo2, cj3.Custo as custo3,
          cj4.Custo as custo4, cj5.Custo as custo5, cj6.Custo as custo6,
          gs.Descricao as subgrupo, g.Descricao as grupo
        FROM central.itens i
        LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
        LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
        LEFT JOIN central.estoquen1 e1 ON e1.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen2 e2 ON e2.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen3 e3 ON e3.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen4 e4 ON e4.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen5 e5 ON e5.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.estoquen6 e6 ON e6.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja1 cj1 ON cj1.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja2 cj2 ON cj2.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja3 cj3 ON cj3.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja4 cj4 ON cj4.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja5 cj5 ON cj5.CodigoBarra = i.CodigoBarra
        LEFT JOIN central.custoloja6 cj6 ON cj6.CodigoBarra = i.CodigoBarra
        ${filtro}
        ORDER BY i.Descricao
        LIMIT ? OFFSET ?
      `, [...params, parseInt(limite), offset]);

      return res.json({
        total: total.cnt,
        pagina: parseInt(pagina),
        paginas: Math.ceil(total.cnt / parseInt(limite)),
        loja: 'todas',
        data: rows.map(r => {
          const lojas = [1,2,3,4,5,6].map(n => {
            const preco = parsePreco(r['P'+n]);
            const custo = parsePreco(r['custo'+n]);
            const margem = custo > 0 ? parseFloat(((preco - custo) / custo * 100).toFixed(2)) : 0;
            return { preco, custo, margem, estoque: parseFloat(r['est'+n] || 0) };
          });
          return {
            codigo: r.nInterno, codigoBarra: r.CodigoBarra,
            descricao: r.Descricao?.trim(), lojas,
            ativo: r.CodDesativado === 0, unidade: r.Unid?.trim(),
            marca: r.Marca?.trim(), subgrupo: r.subgrupo?.trim(), grupo: r.grupo?.trim()
          };
        })
      });
    }

    const rows = await q(`
      SELECT
        i.nInterno, i.CodigoBarra, i.Descricao, i.Abreviacao,
        i.CodDesativado, i.Unid, i.Marca,
        i.P${ln} as preco_loja,
        e.Qtd as estoque_qtd,
        cj.Custo as custo_compra,
        cj.UltimaCompra as ultima_compra,
        gs.Descricao as subgrupo, g.Descricao as grupo
      FROM central.itens i
      LEFT JOIN central.gruposub gs ON gs.CodSubGrupo = i.CodGrupoSub
      LEFT JOIN central.grupo g ON g.CodGrupo = gs.CodGrupo
      LEFT JOIN central.estoquen${ln} e ON e.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.custoloja${ln} cj ON cj.CodigoBarra = i.CodigoBarra
      ${filtro}
      ORDER BY i.Descricao
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limite), offset]);

    res.json({
      total: total.cnt,
      pagina: parseInt(pagina),
      paginas: Math.ceil(total.cnt / parseInt(limite)),
      loja: ln,
      data: rows.map(r => {
        const preco = parsePreco(r.preco_loja);
        const custo = parsePreco(r.custo_compra);
        const margem = custo > 0 ? parseFloat(((preco - custo) / custo * 100).toFixed(2)) : 0;
        return {
          codigo: r.nInterno,
          codigoBarra: r.CodigoBarra,
          descricao: r.Descricao?.trim(),
          preco,
          custo,
          ultimaCompra: r.ultima_compra ? new Date(r.ultima_compra).toLocaleDateString('pt-BR') : null,
          estoque: parseFloat(r.estoque_qtd || 0),
          ativo: r.CodDesativado === 0,
          unidade: r.Unid?.trim(),
          marca: r.Marca?.trim(),
          margem,
          subgrupo: r.subgrupo?.trim(),
          grupo: r.grupo?.trim()
        };
      })
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Faturamento por loja e por mês (para gráfico no dashboard)
app.get('/api/faturamento-lojas', async (req, res) => {
  try {
    const ano = new Date().getFullYear();
    const rows = await q(
      'SELECT nLoja, Mes, SUM(Total) as total FROM dashboard.vendas WHERE Ano=? GROUP BY nLoja, Mes ORDER BY nLoja, Mes',
      [ano]
    );
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const lojas = [1,2,3,4,5,6];
    const porMes = {};
    for (const r of rows) {
      const m = meses[r.Mes - 1];
      if (!porMes[m]) porMes[m] = {};
      porMes[m][r.nLoja] = parseFloat(r.total);
    }
    const mesesComDados = [...new Set(rows.map(r => meses[r.Mes - 1]))];
    res.json({ meses: mesesComDados, lojas, dados: porMes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO FORNECEDORES
// ═══════════════════════════════════════════════════

// Resumo geral por fornecedor (deve vir ANTES de /:id)
const _resumoCache = {}, _resumoCacheTs = {};
const RESUMO_TTL = 5 * 60 * 1000;

app.get('/api/fornecedores/resumo', async (req, res) => {
  try {
    const hoje = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const busca   = req.query.busca || '';
    const compradorSel = req.query.comprador || '';
    const mm       = mesDB(mesSel);
    const dIni     = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim     = dFimMes(anoSel, mesSel);

    // Cache por loja+mes+ano (quando não há busca/comprador)
    const cacheKey = `${lojaSel}-${mesSel}-${anoSel}`;
    if (!busca && !compradorSel && _resumoCache[cacheKey] && (Date.now() - _resumoCacheTs[cacheKey]) < RESUMO_TTL) {
      return res.json(_resumoCache[cacheKey]);
    }

    // Todas as queries em paralelo
    let wf = 'WHERE CodDesativado=0', pf = [];
    if (busca) { wf += ' AND (Nome LIKE ? OR NomeCompleto LIKE ?)'; pf.push(`%${busca}%`, `%${busca}%`); }

    const [vendasRows, prodRows, avariaRows, avariaStatusRows, compradorRows, fornecs] = await Promise.all([
      q(`SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor, SUM(Custo) as custo_total
         FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE Data BETWEEN ? AND ? AND IndCancel='N' GROUP BY Codigo`, [dIni, dFim]).catch(() => []),
      q(`SELECT fi.CodFornecedor, fi.CodigoBarra, c.Custo
         FROM central.fornecedoritens fi
         INNER JOIN central.itens it ON it.CodigoBarra = fi.CodigoBarra AND it.CodDesativado = 0
         LEFT JOIN central.custoloja${lojaSel} c ON c.CodigoBarra = fi.CodigoBarra
         WHERE fi.Backup = 0`).catch(() => []),
      q(`SELECT a.CodFornec, SUM(a.Total) as total, COUNT(*) as qtd
         FROM central.avariaconsumo a
         INNER JOIN central.fornecedoritens fi ON fi.CodigoBarra = a.CodigoBarras AND fi.CodFornecedor = a.CodFornec AND fi.Backup = 0
         WHERE a.nLoja=? AND a.DataLan BETWEEN ? AND ? AND a.CodFornec>0
         GROUP BY a.CodFornec`, [lojaSel, dIni, dFim]).catch(() => []),
      q(`SELECT SUM(CASE WHEN Status=0 THEN Total ELSE 0 END) as em_aberto,
                SUM(CASE WHEN Status=2 THEN Total ELSE 0 END) as em_tramite,
                SUM(CASE WHEN Status IN (3,4) THEN Total ELSE 0 END) as ja_emitido,
                SUM(Total) as total_geral
         FROM central.avariaconsumo WHERE nLoja=? AND DataLan BETWEEN ? AND ?`,
        [lojaSel, dIni, dFim]).catch(() => [{}]),
      q(`SELECT codFornec, GROUP_CONCAT(DISTINCT nome ORDER BY nome SEPARATOR ', ') as nomes
         FROM central.c_cotacao_agenda_comprador WHERE nLoja=? GROUP BY codFornec`,
        [lojaSel]).catch(() => []),
      q(`SELECT CodFornec, Nome, NomeCompleto FROM central.fornecedor ${wf}`, pf).catch(() => [])
    ]);

    // Processa vendas
    let vendasMap = {}, totalLojaReal = 0, totalCustoLoja = 0;
    for (const r of vendasRows) {
      const v = parseFloat(r.valor), ct = parseFloat(r.custo_total || 0);
      vendasMap[r.Codigo] = { qtd: parseFloat(r.qtd), valor: v, custo: ct };
      totalLojaReal += v; totalCustoLoja += ct;
    }

    // Avaria
    const avariaMap = {};
    for (const r of avariaRows) avariaMap[r.CodFornec] = { total: parseFloat(r.total), qtd: parseInt(r.qtd) };
    const avSt = avariaStatusRows[0] || {};
    const avariaBreakdown = {
      em_aberto:  +parseFloat(avSt.em_aberto  || 0).toFixed(2),
      em_tramite: +parseFloat(avSt.em_tramite || 0).toFixed(2),
      ja_emitido: +parseFloat(avSt.ja_emitido || 0).toFixed(2),
      total:      +parseFloat(avSt.total_geral || 0).toFixed(2)
    };

    // Agrupa por fornecedor em memória
    const codsComFornec = new Set(prodRows.map(p => p.CodigoBarra));
    const totalComFornec = [...codsComFornec].reduce((s, cod) => s + (vendasMap[cod]?.valor || 0), 0);
    const margemReal = totalLojaReal > 0 ? +((totalLojaReal - totalCustoLoja) / totalLojaReal * 100).toFixed(2) : 0;

    let totalLucroReal = 0;
    for (const cod of codsComFornec) {
      const v = vendasMap[cod];
      if (v && v.valor > 0) totalLucroReal += v.valor - v.custo;
    }

    const fMap = {};
    for (const p of prodRows) {
      const fid = p.CodFornecedor;
      const v   = vendasMap[p.CodigoBarra] || { qtd: 0, valor: 0 };
      const cst = parsePreco(p.Custo);
      const cstTot = v.qtd * cst;
      if (!fMap[fid]) fMap[fid] = { venda: 0, custo: 0, lucro: 0, ativos: 0, comVenda: 0 };
      fMap[fid].ativos++;
      if (v.valor > 0) {
        fMap[fid].venda  += v.valor;
        fMap[fid].custo  += cstTot;
        fMap[fid].lucro  += v.valor - cstTot;
        fMap[fid].comVenda++;
      }
    }

    const compradorMap = {};
    for (const c of compradorRows) compradorMap[c.codFornec] = c.nomes;
    const todosCompradores = [...new Set(compradorRows.flatMap(r => r.nomes.split(', ')))].sort();

    let result = fornecs
      .filter(f => fMap[f.CodFornec] || avariaMap[f.CodFornec])
      .map(f => {
        const m  = fMap[f.CodFornec]  || { venda: 0, custo: 0, lucro: 0, ativos: 0, comVenda: 0 };
        const av = avariaMap[f.CodFornec] || { total: 0, qtd: 0 };
        return {
          id:         f.CodFornec,
          nome:       (f.Nome || f.NomeCompleto || '').trim(),
          comprador:  compradorMap[f.CodFornec] || '',
          venda:      +m.venda.toFixed(2),
          custo:      +m.custo.toFixed(2),
          lucro:      +m.lucro.toFixed(2),
          msv:        m.venda > 0  ? +(m.lucro / m.venda  * 100).toFixed(2) : 0,
          msc:        m.custo > 0  ? +(m.lucro / m.custo  * 100).toFixed(2) : 0,
          avaria:     +av.total.toFixed(2),
          qtd_avaria: av.qtd,
          ativos:     m.ativos,
          com_venda:  m.comVenda,
          pct_av:     m.venda > 0  ? +(av.total / m.venda * 100).toFixed(2) : 0
        };
      })
      .sort((a, b) => b.venda - a.venda);

    if (compradorSel) {
      result = result.filter(r => r.comprador && r.comprador.split(', ').includes(compradorSel));
    }

    const margemFornec = totalComFornec > 0 ? +(totalLucroReal / totalComFornec * 100).toFixed(2) : 0;
    const payload = { total_loja: +totalLojaReal.toFixed(2), total_com_fornecedor: +totalComFornec.toFixed(2), total_lucro_real: +totalLucroReal.toFixed(2), margem_loja: margemReal, margem_fornec: margemFornec, avaria_breakdown: avariaBreakdown, fornecedores: result, compradores: todosCompradores };
    if (!busca && !compradorSel) { _resumoCache[cacheKey] = payload; _resumoCacheTs[cacheKey] = Date.now(); }
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cache de itens mercadológico (muda raramente)
let _itensCache = null, _itensCacheTs = 0;
async function getItensGrupo() {
  if (_itensCache && Date.now() - _itensCacheTs < 10*60*1000) return _itensCache;
  _itensCache = await q(`SELECT i.CodigoBarra, g.CodGrupo, g.Descricao as grupo_nome
     FROM central.itens i
     INNER JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub AND gs.CodDesativado=0
     INNER JOIN central.grupo g ON g.CodGrupo=gs.CodGrupo
     WHERE i.CodDesativado=0 AND i.CodGrupoSub>0`).catch(()=>[]);
  _itensCacheTs = Date.now();
  return _itensCache;
}

// Comparativo TV: dados combinados (diário + mercadológico) para uma loja — mês atual
app.get('/api/comparativo-tv', async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = hoje.getMonth() + 1;
    const diaAtual= hoje.getDate();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const mm      = mesDB(mesSel);

    const mesesNomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const [diasRows, prod25, prod26, itens, ...mensalRows] = await Promise.all([
      q(`SELECT DAY(Data) as dia, YEAR(Data) as ano, SUM(ValorTotalNovo) as valor
         FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE MONTH(Data)=? AND YEAR(Data) IN (2025,2026) AND IndCancel='N'
         GROUP BY dia, ano ORDER BY dia`, [mesSel]).catch(()=>[]),
      q(`SELECT Codigo, SUM(ValorTotalNovo) as valor FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE YEAR(Data)=2025 AND MONTH(Data)=? AND IndCancel='N' GROUP BY Codigo`, [mesSel]).catch(()=>[]),
      q(`SELECT Codigo, SUM(ValorTotalNovo) as valor FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE YEAR(Data)=2026 AND MONTH(Data)=? AND IndCancel='N' GROUP BY Codigo`, [mesSel]).catch(()=>[]),
      getItensGrupo(),
      ...[1,2,3,4,5,6,7,8,9,10,11,12].map(m =>
        q(`SELECT YEAR(Data) as ano, SUM(ValorTotalNovo) as valor
           FROM \`ln${lojaSel}mes${String(m).padStart(2,'0')}\`.zcupomitens
           WHERE YEAR(Data) IN (2025,2026) AND IndCancel='N' GROUP BY ano`, []).catch(()=>[])
      )
    ]);

    // Diário
    const v25d = {}, v26d = {};
    for (const r of diasRows) {
      if (r.ano==2025) v25d[r.dia] = parseFloat(r.valor);
      if (r.ano==2026) v26d[r.dia] = parseFloat(r.valor);
    }
    const ultimoDia = new Date(2026, mesSel, 0).getDate();
    const dias = [];
    for (let d=1; d<=ultimoDia; d++) {
      const a=v25d[d]||0, b=v26d[d]||0;
      if (a>0||b>0) dias.push({ dia:d, v2025:+a.toFixed(2), v2026:+b.toFixed(2),
        var: a>0?+((b-a)/a*100).toFixed(1):null });
    }
    const tot25  = dias.reduce((s,d)=>s+d.v2025,0);
    const tot26  = dias.reduce((s,d)=>s+d.v2026,0);
    const tot25p = dias.filter(d=>d.dia<=diaAtual).reduce((s,d)=>s+d.v2025,0);

    // Mercadológico por grupo
    const pv25={}, pv26={};
    for (const r of prod25) pv25[r.Codigo]=parseFloat(r.valor);
    for (const r of prod26) pv26[r.Codigo]=parseFloat(r.valor);
    const gMap={};
    for (const it of itens) {
      const a=pv25[it.CodigoBarra]||0, b=pv26[it.CodigoBarra]||0;
      if (!a&&!b) continue;
      const k=it.CodGrupo;
      if (!gMap[k]) gMap[k]={ nome:it.grupo_nome?.trim()||'—', v2025:0, v2026:0 };
      gMap[k].v2025+=a; gMap[k].v2026+=b;
    }
    const grupos = Object.values(gMap)
      .filter(g=>g.v2025>0||g.v2026>0)
      .map(g=>({ nome:g.nome, v2025:+g.v2025.toFixed(2), v2026:+g.v2026.toFixed(2),
        var:g.v2025>0?+((g.v2026-g.v2025)/g.v2025*100).toFixed(1):null }))
      .sort((a,b)=>b.v2026-a.v2026||b.v2025-a.v2025);

    // Mensal
    const mensal = mensalRows.map((rows, i) => {
      let v25=0, v26=0;
      for (const r of rows) { if(r.ano==2025) v25=parseFloat(r.valor); if(r.ano==2026) v26=parseFloat(r.valor); }
      return { mes:i+1, nome:mesesNomes[i], v2025:+v25.toFixed(2), v2026:+v26.toFixed(2),
        var: v25>0?+((v26-v25)/v25*100).toFixed(1):null };
    });

    res.json({ loja:lojaSel, mes:mesSel, dia_atual:diaAtual,
      total2025:+tot25.toFixed(2), total2026:+tot26.toFixed(2),
      total2025_periodo:+tot25p.toFixed(2),
      var_pct: tot25>0?+((tot26-tot25)/tot25*100).toFixed(1):null,
      var_periodo: tot25p>0?+((tot26-tot25p)/tot25p*100).toFixed(1):null,
      dias, grupos, mensal });
  } catch(err) { console.error('[comparativo-tv]', err); res.status(500).json({ error: err.message }); }
});

// Comparativo diário: vendas dia-a-dia 2025 vs 2026 para o mês selecionado
app.get('/api/comparativo-diario', async (req, res) => {
  try {
    const hoje   = new Date();
    const mesSel = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const lojaSel= req.query.loja ? parseInt(req.query.loja) : 1;
    const mm     = mesDB(mesSel);

    const rows = await q(`
      SELECT DAY(Data) as dia, YEAR(Data) as ano,
             SUM(ValorTotalNovo) as valor,
             COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons
      FROM \`ln${lojaSel}${mm}\`.zcupomitens
      WHERE MONTH(Data)=? AND YEAR(Data) IN (2025,2026) AND IndCancel='N'
      GROUP BY dia, ano ORDER BY dia, ano
    `, [mesSel]).catch(() => []);

    const v25 = {}, v26 = {}, c25 = {}, c26 = {};
    for (const r of rows) {
      if (r.ano == 2025) { v25[r.dia] = parseFloat(r.valor); c25[r.dia] = parseInt(r.cupons); }
      if (r.ano == 2026) { v26[r.dia] = parseFloat(r.valor); c26[r.dia] = parseInt(r.cupons); }
    }

    const ultimoDia = new Date(2026, mesSel, 0).getDate();
    const dias = [];
    for (let d = 1; d <= ultimoDia; d++) {
      const a = v25[d] || 0, b = v26[d] || 0;
      dias.push({ dia: d, v2025: +a.toFixed(2), v2026: +b.toFixed(2),
        c2025: c25[d] || 0, c2026: c26[d] || 0,
        var: a > 0 ? +((b - a) / a * 100).toFixed(1) : null });
    }

    const tot25 = dias.reduce((s,d) => s + d.v2025, 0);
    const tot26 = dias.reduce((s,d) => s + d.v2026, 0);
    res.json({ dias, total2025: +tot25.toFixed(2), total2026: +tot26.toFixed(2),
      var_pct: tot25 > 0 ? +((tot26 - tot25) / tot25 * 100).toFixed(1) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Comparativo por mercadológico (grupo + subgrupo): 2025 vs 2026 para loja+mês
app.get('/api/comparativo-mercadologico', async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const mm      = mesDB(mesSel);

    const [rows25, rows26, itens] = await Promise.all([
      q(`SELECT Codigo, SUM(ValorTotalNovo) as valor FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE YEAR(Data)=2025 AND MONTH(Data)=? AND IndCancel='N' GROUP BY Codigo`, [mesSel]).catch(()=>[]),
      q(`SELECT Codigo, SUM(ValorTotalNovo) as valor FROM \`ln${lojaSel}${mm}\`.zcupomitens
         WHERE YEAR(Data)=2026 AND MONTH(Data)=? AND IndCancel='N' GROUP BY Codigo`, [mesSel]).catch(()=>[]),
      q(`SELECT i.CodigoBarra, i.CodGrupoSub, gs.Descricao as sub_nome,
                g.CodGrupo, g.Descricao as grupo_nome,
                i.CodGrupoMarca, gm.Descricao as merc_nome
         FROM central.itens i
         INNER JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub AND gs.CodDesativado=0
         INNER JOIN central.grupo g ON g.CodGrupo=gs.CodGrupo
         LEFT JOIN central.grupomarca gm ON gm.CodMarca=i.CodGrupoMarca
         WHERE i.CodDesativado=0 AND i.CodGrupoSub>0`).catch(()=>[])
    ]);

    const v25 = {}, v26 = {};
    for (const r of rows25) v25[r.Codigo] = parseFloat(r.valor);
    for (const r of rows26) v26[r.Codigo] = parseFloat(r.valor);

    // Agrupa por grupo → subgrupo → mercadológico
    const gMap = {};
    for (const it of itens) {
      const a = v25[it.CodigoBarra] || 0, b = v26[it.CodigoBarra] || 0;
      if (!a && !b) continue;
      const gk = it.CodGrupo, sk = it.CodGrupoSub, mk = it.CodGrupoMarca || 0;
      if (!gMap[gk]) gMap[gk] = { nome: it.grupo_nome?.trim()||'—', v2025:0, v2026:0, subs:{} };
      gMap[gk].v2025 += a; gMap[gk].v2026 += b;
      if (!gMap[gk].subs[sk]) gMap[gk].subs[sk] = { nome: it.sub_nome?.trim()||'—', v2025:0, v2026:0, mercs:{} };
      gMap[gk].subs[sk].v2025 += a; gMap[gk].subs[sk].v2026 += b;
      if (!gMap[gk].subs[sk].mercs[mk]) gMap[gk].subs[sk].mercs[mk] = { nome: it.merc_nome?.trim()||'Sem mercadológico', v2025:0, v2026:0 };
      gMap[gk].subs[sk].mercs[mk].v2025 += a; gMap[gk].subs[sk].mercs[mk].v2026 += b;
    }

    const sort26 = (a,b) => b.v2026-a.v2026 || b.v2025-a.v2025;
    const mkVar  = m => m.v2025>0 ? +((m.v2026-m.v2025)/m.v2025*100).toFixed(1) : null;

    const grupos = Object.values(gMap)
      .filter(g => g.v2025>0 || g.v2026>0)
      .map(g => ({
        nome: g.nome,
        v2025: +g.v2025.toFixed(2), v2026: +g.v2026.toFixed(2), var: mkVar(g),
        subs: Object.values(g.subs)
          .filter(s => s.v2025>0 || s.v2026>0)
          .map(s => ({
            nome: s.nome,
            v2025: +s.v2025.toFixed(2), v2026: +s.v2026.toFixed(2), var: mkVar(s),
            mercs: Object.values(s.mercs)
              .filter(m => m.v2025>0 || m.v2026>0)
              .map(m => ({ nome:m.nome, v2025:+m.v2025.toFixed(2), v2026:+m.v2026.toFixed(2), var:mkVar(m) }))
              .sort(sort26)
          }))
          .sort(sort26)
      }))
      .sort(sort26);

    const tot25 = grupos.reduce((s,g)=>s+g.v2025, 0);
    const tot26 = grupos.reduce((s,g)=>s+g.v2026, 0);
    res.json({ grupos, total2025: +tot25.toFixed(2), total2026: +tot26.toFixed(2),
      var_pct: tot25>0 ? +((tot26-tot25)/tot25*100).toFixed(1) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Comparativo por lojas: todas as 6 lojas 2025 vs 2026 para um mês
app.get('/api/comparativo-lojas', async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const mm      = mesDB(mesSel);
    const lojas   = [1,2,3,4,5,6];

    const results = await Promise.all(lojas.map(ln =>
      q(`SELECT YEAR(Data) as ano, SUM(ValorTotalNovo) as valor,
                COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons
         FROM \`ln${ln}${mm}\`.zcupomitens
         WHERE MONTH(Data)=? AND YEAR(Data) IN (2025,2026) AND IndCancel='N'
         GROUP BY ano`, [mesSel]).catch(()=>[])
    ));

    const data = results.map((rows, i) => {
      let v25=0, v26=0, c25=0, c26=0;
      for (const r of rows) {
        if (r.ano==2025) { v25=parseFloat(r.valor); c25=parseInt(r.cupons); }
        if (r.ano==2026) { v26=parseFloat(r.valor); c26=parseInt(r.cupons); }
      }
      return { loja: i+1, v2025: +v25.toFixed(2), v2026: +v26.toFixed(2),
        c2025: c25, c2026: c26, var: v25>0 ? +((v26-v25)/v25*100).toFixed(1) : null };
    });

    const tot25 = data.reduce((s,d)=>s+d.v2025, 0);
    const tot26 = data.reduce((s,d)=>s+d.v2026, 0);
    res.json({ lojas: data, total2025: +tot25.toFixed(2), total2026: +tot26.toFixed(2),
      var_pct: tot25>0 ? +((tot26-tot25)/tot25*100).toFixed(1) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const _mensalCache = {}, _mensalCacheTs = {};

// Comparativo mensal: todos os meses do ano 2025 vs 2026
app.get('/api/comparativo-mensal', async (req, res) => {
  try {
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const cacheKey = String(lojaSel);
    if (_mensalCache[cacheKey] && (Date.now() - _mensalCacheTs[cacheKey]) < RESUMO_TTL) {
      return res.json(_mensalCache[cacheKey]);
    }

    const meses = ['01','02','03','04','05','06','07','08','09','10','11','12'];
    const results = await Promise.all(meses.map(mm =>
      q(`SELECT YEAR(Data) as ano, SUM(ValorTotalNovo) as valor,
                COUNT(DISTINCT CONCAT(nECF,'-',CCF)) as cupons
         FROM \`ln${lojaSel}mes${mm}\`.zcupomitens
         WHERE YEAR(Data) IN (2025,2026) AND IndCancel='N'
         GROUP BY ano`, []).catch(() => [])
    ));

    const mesesNomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const data = results.map((rows, i) => {
      let v25=0, v26=0, c25=0, c26=0;
      for (const r of rows) {
        if (r.ano == 2025) { v25 = parseFloat(r.valor); c25 = parseInt(r.cupons); }
        if (r.ano == 2026) { v26 = parseFloat(r.valor); c26 = parseInt(r.cupons); }
      }
      return { mes: i+1, nome: mesesNomes[i],
        v2025: +v25.toFixed(2), v2026: +v26.toFixed(2),
        c2025: c25, c2026: c26,
        var: v25 > 0 ? +((v26-v25)/v25*100).toFixed(1) : null };
    });

    const tot25 = data.reduce((s,d)=>s+d.v2025,0);
    const tot26 = data.reduce((s,d)=>s+d.v2026,0);
    const payload = { meses: data, total2025: +tot25.toFixed(2), total2026: +tot26.toFixed(2),
      var_pct: tot25>0 ? +((tot26-tot25)/tot25*100).toFixed(1) : null };
    _mensalCache[cacheKey] = payload; _mensalCacheTs[cacheKey] = Date.now();
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Produtos vendidos sem fornecedor cadastrado
app.get('/api/sem-fornecedor', async (req, res) => {
  try {
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const anoSel  = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const mm      = mesDB(mesSel);
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim    = dFimMes(anoSel, mesSel);

    const rows = await q(`
      SELECT z.Codigo, it.Descricao, it.Unid,
             SUM(z.ValorTotalNovo) as valor, SUM(z.QtdNovo) as qtd
      FROM \`ln${lojaSel}${mm}\`.zcupomitens z
      LEFT JOIN central.itens it ON it.CodigoBarra = z.Codigo
      WHERE z.Data BETWEEN ? AND ? AND z.IndCancel = 'N'
        AND z.Codigo NOT IN (
          SELECT DISTINCT CodigoBarra FROM central.fornecedoritens WHERE Backup = 0
        )
      GROUP BY z.Codigo, it.Descricao, it.Unid
      ORDER BY valor DESC
    `, [dIni, dFim]);

    res.json(rows.map(r => ({
      codigo:    r.Codigo,
      descricao: (r.Descricao || '').trim() || '(sem descrição)',
      unid:      r.Unid || '',
      valor:     +parseFloat(r.valor || 0).toFixed(2),
      qtd:       Math.round(parseFloat(r.qtd || 0))
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Produtos de um fornecedor numa loja+mês
app.get('/api/fornecedores/:id/produtos', async (req, res) => {
  try {
    const id      = parseInt(req.params.id);
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const anoSel  = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const mm      = mesDB(mesSel);
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim    = dFimMes(anoSel, mesSel);

    const prods = await q(`
      SELECT fi.CodigoBarra, it.Descricao, it.Unid,
             c.Custo, c.UltimaCompra,
             e.Qtd as estoque
      FROM central.fornecedoritens fi
      INNER JOIN central.itens it ON it.CodigoBarra = fi.CodigoBarra AND it.CodDesativado = 0
      LEFT JOIN central.custoloja${lojaSel} c  ON c.CodigoBarra = fi.CodigoBarra
      LEFT JOIN central.estoquen${lojaSel}  e  ON e.CodigoBarra = fi.CodigoBarra
      WHERE fi.CodFornecedor = ? AND fi.Backup = 0
    `, [id]);

    if (!prods.length) return res.json([]);

    const codigos = [...new Set(prods.map(p => p.CodigoBarra))];
    const ph = codigos.map(() => '?').join(',');
    let vendasMap = {};
    try {
      const rows = await q(`
        SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor
        FROM \`ln${lojaSel}${mm}\`.zcupomitens
        WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph})
        GROUP BY Codigo
      `, [dIni, dFim, ...codigos]);
      for (const r of rows) vendasMap[r.Codigo] = { qtd: parseFloat(r.qtd), valor: parseFloat(r.valor) };
    } catch (e) {}

    res.json(prods.map(p => {
      const v   = vendasMap[p.CodigoBarra] || { qtd: 0, valor: 0 };
      const cst = parsePreco(p.Custo);
      const cstTot = v.qtd * cst;
      const lucro  = v.valor - cstTot;
      return {
        codigo:       p.CodigoBarra,
        descricao:    p.Descricao?.trim(),
        unidade:      p.Unid?.trim(),
        estoque:      parseFloat(p.estoque || 0),
        qtd_vendida:  +v.qtd.toFixed(3),
        venda:        +v.valor.toFixed(2),
        custo_unit:   +cst.toFixed(4),
        custo_total:  +cstTot.toFixed(2),
        lucro:        +lucro.toFixed(2),
        msv:          v.valor > 0 ? +(lucro / v.valor * 100).toFixed(2) : null,
        ultima_compra: p.UltimaCompra ? new Date(p.UltimaCompra).toLocaleDateString('pt-BR') : null,
        tem_venda:    v.valor > 0
      };
    }).sort((a, b) => b.venda - a.venda));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Avarias de um fornecedor
app.get('/api/fornecedores/:id/avarias', async (req, res) => {
  try {
    const id      = parseInt(req.params.id);
    const hoje    = new Date();
    const mesSel  = req.query.mes  ? parseInt(req.query.mes)  : hoje.getMonth() + 1;
    const anoSel  = req.query.ano  ? parseInt(req.query.ano)  : hoje.getFullYear();
    const lojaSel = req.query.loja ? parseInt(req.query.loja) : 1;
    const dIni    = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim    = dFimMes(anoSel, mesSel);

    const rows = await q(`
      SELECT a.CodigoBarras, a.Descricao, SUM(a.Qtd) as qtd, SUM(a.Total) as total,
             MAX(a.DataLan) as ultima
      FROM central.avariaconsumo a
      INNER JOIN central.fornecedoritens fi ON fi.CodigoBarra = a.CodigoBarras AND fi.CodFornecedor = a.CodFornec AND fi.Backup = 0
      WHERE a.nLoja=? AND a.CodFornec=? AND a.DataLan BETWEEN ? AND ?
      GROUP BY a.CodigoBarras, a.Descricao
      ORDER BY total DESC
    `, [lojaSel, id, dIni, dFim]);

    // Enrich with NF-e descriptions from central.itens
    const avCodigos = [...new Set(rows.map(r => r.CodigoBarras))];
    if (avCodigos.length > 0) {
      const ph = avCodigos.map(() => '?').join(',');
      const itensRows = await q(`SELECT CodigoBarra, Descricao FROM central.itens WHERE CodigoBarra IN (${ph})`, avCodigos);
      const itensMap = {};
      for (const r of itensRows) itensMap[r.CodigoBarra] = r.Descricao?.trim();
      for (const r of rows) { if (itensMap[r.CodigoBarras]) r.Descricao = itensMap[r.CodigoBarras]; }
    }

    const totalAvaria = rows.reduce((s, r) => s + parseFloat(r.total), 0);

    // Venda do fornecedor para calcular %
    let vendaFornec = 0;
    try {
      const mm   = mesDB(mesSel);
      const prods = await q(`SELECT DISTINCT CodigoBarra FROM central.fornecedoritens WHERE CodFornecedor=? AND Backup=0`, [id]);
      if (prods.length) {
        const ph = prods.map(() => '?').join(',');
        const [vr] = await q(`
          SELECT SUM(ValorTotalNovo) as v FROM \`ln${lojaSel}${mm}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph})
        `, [dIni, dFim, ...prods.map(p => p.CodigoBarra)]);
        vendaFornec = parseFloat(vr?.v || 0);
      }
    } catch (e) {}

    res.json({
      total:       +totalAvaria.toFixed(2),
      qtd_prods:   rows.length,
      pct_venda:   vendaFornec > 0 ? +(totalAvaria / vendaFornec * 100).toFixed(2) : 0,
      ultima:      rows.length ? new Date(Math.max(...rows.map(r => new Date(r.ultima)))).toLocaleDateString('pt-BR') : null,
      produtos:    rows.map(r => ({
        codigo:    r.CodigoBarras,
        descricao: r.Descricao?.trim(),
        qtd:       +parseFloat(r.qtd).toFixed(3),
        total:     +parseFloat(r.total).toFixed(2)
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Comparativo do fornecedor em todas as lojas
app.get('/api/fornecedores/:id/lojas', async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const hoje   = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const mm     = mesDB(mesSel);
    const dIni   = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dFim   = dFimMes(anoSel, mesSel);

    const prods = await q(`SELECT DISTINCT CodigoBarra FROM central.fornecedoritens WHERE CodFornecedor=? AND Backup=0`, [id]);
    const codigos = prods.map(p => p.CodigoBarra);
    if (!codigos.length) return res.json([]);
    const ph = codigos.map(() => '?').join(',');

    const result = [];
    for (const ln of [1,2,3,4,5,6]) {
      let venda = 0, avaria = 0, custo = 0, qtd = 0;
      try {
        const [vr] = await q(`
          SELECT SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as v
          FROM \`ln${ln}${mm}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph})
        `, [dIni, dFim, ...codigos]);
        venda = parseFloat(vr?.v || 0);
        qtd   = parseFloat(vr?.qtd || 0);
      } catch (e) {}
      try {
        const [ar] = await q(`SELECT SUM(Total) v FROM central.avariaconsumo WHERE nLoja=? AND CodFornec=? AND DataLan BETWEEN ? AND ?`, [ln, id, dIni, dFim]);
        avaria = parseFloat(ar?.v || 0);
      } catch (e) {}
      try {
        const custoRows = await q(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph}) AND Custo>0`, codigos);
        // We need qtd per barcode to compute custo total accurately - approximate with equal distribution
        const custoMap = {};
        for (const r of custoRows) custoMap[r.CodigoBarra] = parsePreco(r.Custo);
        // Get individual qtds
        let vendasLn = {};
        try {
          const vrs = await q(`SELECT Codigo, SUM(QtdNovo) as q FROM \`ln${ln}${mm}\`.zcupomitens WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph}) GROUP BY Codigo`, [dIni, dFim, ...codigos]);
          for (const r of vrs) vendasLn[r.Codigo] = parseFloat(r.q);
        } catch (e) {}
        for (const [cod, c] of Object.entries(custoMap)) {
          custo += (vendasLn[cod] || 0) * c;
        }
      } catch (e) {}
      const lucro = venda - custo;
      result.push({
        loja:   ln,
        venda:  +venda.toFixed(2),
        avaria: +avaria.toFixed(2),
        lucro:  +lucro.toFixed(2),
        msv:    venda > 0 ? +(lucro / venda * 100).toFixed(2) : 0,
        pct_av: venda > 0 ? +(avaria / venda * 100).toFixed(2) : 0
      });
    }

    const maxVenda  = Math.max(...result.map(r => r.venda));
    const maxMsv    = Math.max(...result.filter(r => r.venda > 0).map(r => r.msv), -Infinity);
    const minAvaria = Math.min(...result.filter(r => r.avaria > 0).map(r => r.avaria), Infinity);

    res.json(result.map(r => ({
      ...r,
      badge_venda:  r.venda  === maxVenda  && maxVenda  > 0,
      badge_msv:    r.msv    === maxMsv    && maxMsv    > -Infinity,
      badge_avaria: r.avaria === minAvaria && minAvaria < Infinity && minAvaria > 0
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// FIM MÓDULO FORNECEDORES
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// MÓDULO PENDÊNCIAS DE CADASTRO
// ═══════════════════════════════════════════════════

// Itens ativos que não estão em nenhuma lista de compra
app.get('/api/pendencias/sem-lista', async (req, res) => {
  try {
    const busca = req.query.busca || '';
    const grupo = req.query.grupo ? parseInt(req.query.grupo) : null;
    let where = 'WHERE i.CodDesativado=0 AND i.P1 > 0 AND i.CodigoBarra NOT IN (SELECT DISTINCT Codigobarra FROM central.c_cotacao_lista_itens)';
    const params = [];
    if (grupo) { where += ' AND i.CodGrupo=?'; params.push(grupo); }
    if (busca) { where += ' AND (i.Descricao LIKE ? OR i.CodigoBarra LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`); }
    const rows = await q(`
      SELECT i.CodigoBarra, i.Descricao, i.Unid,
             i.CodGrupo, g.Descricao as grupo,
             i.CodGrupoSub, gs.Descricao as subgrupo,
             i.CodGrupoMarca, gm.Descricao as mercadologico
      FROM central.itens i
      LEFT JOIN central.grupo g ON g.CodGrupo=i.CodGrupo
      LEFT JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub
      LEFT JOIN central.grupomarca gm ON gm.CodMarca=i.CodGrupoMarca
      ${where}
      ORDER BY g.Descricao, gs.Descricao, i.Descricao
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Itens ativos sem mercadológico (CodGrupoMarca=0 ou CodGrupoSub=0)
app.get('/api/pendencias/sem-mercadologico', async (req, res) => {
  try {
    const busca = req.query.busca || '';
    let where = 'WHERE i.CodDesativado=0 AND i.P1 > 0 AND (i.CodGrupoMarca=0 OR i.CodGrupoMarca IS NULL OR i.CodGrupoSub=0 OR i.CodGrupoSub IS NULL)';
    const params = [];
    if (busca) { where += ' AND (i.Descricao LIKE ? OR i.CodigoBarra LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`); }
    const rows = await q(`
      SELECT i.CodigoBarra, i.Descricao, i.Unid,
             i.CodGrupo, g.Descricao as grupo,
             i.CodGrupoSub, gs.Descricao as subgrupo,
             i.CodGrupoMarca, gm.Descricao as mercadologico,
             CASE WHEN (i.CodGrupoSub=0 OR i.CodGrupoSub IS NULL) THEN 1 ELSE 0 END as sem_subgrupo,
             CASE WHEN (i.CodGrupoMarca=0 OR i.CodGrupoMarca IS NULL) THEN 1 ELSE 0 END as sem_merc
      FROM central.itens i
      LEFT JOIN central.grupo g ON g.CodGrupo=i.CodGrupo
      LEFT JOIN central.gruposub gs ON gs.CodSubGrupo=i.CodGrupoSub
      LEFT JOIN central.grupomarca gm ON gm.CodMarca=i.CodGrupoMarca
      ${where}
      ORDER BY g.Descricao, i.Descricao
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista de grupos para filtro
app.get('/api/grupos', async (req, res) => {
  try {
    const rows = await q('SELECT CodGrupo, Descricao FROM central.grupo WHERE CodDesativado=0 ORDER BY Descricao');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// FIM MÓDULO PENDÊNCIAS
// ═══════════════════════════════════════════════════

// Resumo de margens de todas as listas (deve vir ANTES de /:id)
app.get('/api/listas-compra/margem-resumo', async (req, res) => {
  try {
    const hoje = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;
    const lojas = lojaSel ? [lojaSel] : [1,2,3,4,5,6];
    const mm = mesDB(mesSel);
    const dataInicio = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dataFim = dFimMes(anoSel, mesSel);

    // Todos os itens de todas as listas (mapa barcode -> [lista_ids])
    const todosItens = await q(`SELECT nCotacao as lista_id, Codigobarra FROM central.c_cotacao_lista_itens`);
    const barcodeToListas = {};
    for (const item of todosItens) {
      if (!barcodeToListas[item.Codigobarra]) barcodeToListas[item.Codigobarra] = [];
      barcodeToListas[item.Codigobarra].push(item.lista_id);
    }
    const barcodesSet = new Set(Object.keys(barcodeToListas));

    // Vendas do mês: query simples sem filtro de código (mais rápido), filtra em memória
    const vendas = {};
    for (const ln of lojas) {
      const db = `ln${ln}${mm}`;
      try {
        const rows = await q(`
          SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor
          FROM \`${db}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N'
          GROUP BY Codigo
        `, [dataInicio, dataFim]);
        for (const r of rows) {
          if (!barcodesSet.has(r.Codigo)) continue;
          if (!vendas[r.Codigo]) vendas[r.Codigo] = { qtd: 0, valor: 0 };
          vendas[r.Codigo].qtd += parseFloat(r.qtd || 0);
          vendas[r.Codigo].valor += parseFloat(r.valor || 0);
        }
      } catch (e) {}
    }

    // Custo atual de cada produto (custoloja é pequeno, sem filtro)
    const custos = {};
    for (const ln of lojas) {
      try {
        const rows = await q(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE Custo > 0`);
        for (const r of rows) {
          if (barcodesSet.has(r.CodigoBarra) && !custos[r.CodigoBarra]) {
            custos[r.CodigoBarra] = parseFloat(r.Custo);
          }
        }
      } catch (e) {}
    }

    // Acumula margem por lista
    const listaMargens = {};
    for (const [barcode, listaIds] of Object.entries(barcodeToListas)) {
      const v = vendas[barcode];
      if (!v || v.valor <= 0) continue;
      const custo = custos[barcode] || 0;
      if (custo <= 0) continue;
      const custoTotal = v.qtd * custo;
      const lucro = v.valor - custoTotal;
      for (const listaId of listaIds) {
        if (!listaMargens[listaId]) listaMargens[listaId] = { fat: 0, custo_total: 0, lucro: 0, prods: 0 };
        listaMargens[listaId].fat += v.valor;
        listaMargens[listaId].custo_total += custoTotal;
        listaMargens[listaId].lucro += lucro;
        listaMargens[listaId].prods++;
      }
    }

    const result = {};
    for (const [listaId, m] of Object.entries(listaMargens)) {
      result[parseInt(listaId)] = {
        msv: m.fat > 0 ? parseFloat((m.lucro / m.fat * 100).toFixed(2)) : 0,
        msc: m.custo_total > 0 ? parseFloat((m.lucro / m.custo_total * 100).toFixed(2)) : 0,
        faturamento: parseFloat(m.fat.toFixed(2)),
        lucro: parseFloat(m.lucro.toFixed(2)),
        produtos_vendidos: m.prods
      };
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Margem produto a produto de uma lista
app.get('/api/listas-compra/:id/margem', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const hoje = new Date();
    const mesSel = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const anoSel = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const lojaSel = req.query.loja && req.query.loja !== 'todas' ? parseInt(req.query.loja) : null;

    const [lista] = await q('SELECT * FROM central.c_cotacao_lista WHERE nReg = ?', [id]);
    if (!lista) return res.status(404).json({ error: 'Lista não encontrada' });

    const lojasLista = lojaSel ? [lojaSel] : [1,2,3,4,5,6].filter(n => lista['l'+n] == 1);
    const lojas = lojasLista.length ? lojasLista : [1,2,3,4,5,6];
    const mm = mesDB(mesSel);
    const dataInicio = `${anoSel}-${String(mesSel).padStart(2,'0')}-01`;
    const dataFim = dFimMes(anoSel, mesSel);

    const itens = await q(`
      SELECT i.Codigobarra, ci.Descricao, ci.Unid, i.QtdEmb
      FROM central.c_cotacao_lista_itens i
      INNER JOIN central.itens ci ON ci.CodigoBarra = i.Codigobarra AND ci.CodDesativado = 0
      WHERE i.nCotacao = ?
      ORDER BY i.Posicao, ci.Descricao
    `, [id]);
    if (!itens.length) return res.json({ produtos: [], resumo: {} });

    const codigos = [...new Set(itens.map(i => i.Codigobarra))];
    const ph = codigos.map(() => '?').join(',');

    const vendas = {};
    for (const ln of lojas) {
      const db = `ln${ln}${mm}`;
      try {
        const rows = await q(`
          SELECT Codigo, SUM(QtdNovo) as qtd, SUM(ValorTotalNovo) as valor
          FROM \`${db}\`.zcupomitens
          WHERE Data BETWEEN ? AND ? AND IndCancel='N' AND Codigo IN (${ph})
          GROUP BY Codigo
        `, [dataInicio, dataFim, ...codigos]);
        for (const r of rows) {
          if (!vendas[r.Codigo]) vendas[r.Codigo] = { qtd: 0, valor: 0 };
          vendas[r.Codigo].qtd += parseFloat(r.qtd || 0);
          vendas[r.Codigo].valor += parseFloat(r.valor || 0);
        }
      } catch (e) {}
    }

    const custos = {};
    for (const ln of lojas) {
      try {
        const rows = await q(`SELECT CodigoBarra, Custo FROM central.custoloja${ln} WHERE CodigoBarra IN (${ph}) AND Custo > 0`, codigos);
        for (const r of rows) { if (!custos[r.CodigoBarra]) custos[r.CodigoBarra] = parseFloat(r.Custo); }
      } catch (e) {}
    }

    let totalFat = 0, totalCusto = 0, totalLucro = 0, comVenda = 0;
    const produtos = itens.map(item => {
      const v = vendas[item.Codigobarra] || { qtd: 0, valor: 0 };
      const custo = custos[item.Codigobarra] || 0;
      const custoTotal = v.qtd * custo;
      const lucro = v.valor - custoTotal;
      if (v.valor > 0) { totalFat += v.valor; totalCusto += custoTotal; totalLucro += lucro; comVenda++; }
      return {
        codigo: item.Codigobarra,
        descricao: item.Descricao?.trim(),
        unidade: item.Unid?.trim(),
        qtd_vendida: parseFloat(v.qtd.toFixed(3)),
        faturamento: parseFloat(v.valor.toFixed(2)),
        custo_unit: parseFloat(custo.toFixed(4)),
        custo_total: parseFloat(custoTotal.toFixed(2)),
        lucro: parseFloat(lucro.toFixed(2)),
        msv: v.valor > 0 ? parseFloat((lucro / v.valor * 100).toFixed(2)) : null,
        msc: custoTotal > 0 ? parseFloat((lucro / custoTotal * 100).toFixed(2)) : null,
        tem_venda: v.valor > 0
      };
    });

    res.json({
      produtos,
      resumo: {
        faturamento: parseFloat(totalFat.toFixed(2)),
        custo_total: parseFloat(totalCusto.toFixed(2)),
        lucro: parseFloat(totalLucro.toFixed(2)),
        msv: totalFat > 0 ? parseFloat((totalLucro / totalFat * 100).toFixed(2)) : 0,
        msc: totalCusto > 0 ? parseFloat((totalLucro / totalCusto * 100).toFixed(2)) : 0,
        produtos_com_venda: comVenda,
        total_produtos: itens.length
      },
      mes: mesSel, ano: anoSel
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Listas de compra cadastradas
app.get('/api/listas-compra', async (req, res) => {
  try {
    const { busca, comprador } = req.query;

    let where = [];
    let params = [];

    if (busca) {
      where.push('(l.Nome LIKE ? OR l.NomeFornec LIKE ? OR l.Obs LIKE ?)');
      params.push('%' + busca + '%', '%' + busca + '%', '%' + busca + '%');
    }

    const filtro = where.length ? 'WHERE ' + where.join(' AND ') : '';

    let sql = `
      SELECT l.nReg, l.Nome, l.NomeFornec, l.CodFornec, l.OperadorLista, l.Obs,
             l.l1, l.l2, l.l3, l.l4, l.l5, l.l6,
             COUNT(DISTINCT i.nReg) as total_itens,
             GROUP_CONCAT(DISTINCT cap.nome ORDER BY cap.nome SEPARATOR ', ') as compradores_str
      FROM central.c_cotacao_lista l
      LEFT JOIN central.c_cotacao_lista_itens i ON i.nCotacao = l.nReg
      LEFT JOIN central.c_cotacao_agenda_comprador cap ON cap.nLista = l.nReg
      ${filtro}
      GROUP BY l.nReg
    `;
    if (comprador) {
      sql += ' HAVING compradores_str LIKE ?';
      params.push('%' + comprador + '%');
    }
    sql += ' ORDER BY l.Nome';

    const rows = await q(sql, params);

    const compRows = await q(`
      SELECT DISTINCT nome FROM central.c_cotacao_agenda_comprador
      WHERE nome IS NOT NULL AND nome != '' AND nome != '0' AND TRIM(nome) != ''
      ORDER BY nome
    `);

    res.json({
      listas: rows.map(r => ({
        id: r.nReg,
        nome: r.Nome?.trim(),
        fornecedor: r.NomeFornec?.trim(),
        codFornec: r.CodFornec,
        operador: r.OperadorLista && r.OperadorLista !== '0' ? r.OperadorLista : null,
        obs: r.Obs?.trim(),
        total_itens: r.total_itens,
        compradores: r.compradores_str || null,
        lojas: [1,2,3,4,5,6].filter(n => r['l'+n] == 1)
      })),
      compradores: compRows.map(c => c.nome)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Itens de uma lista específica
app.get('/api/listas-compra/:id/itens', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { loja } = req.query;

    let where = 'WHERE i.nCotacao = ?';
    let params = [id];

    if (loja && loja !== 'todas') {
      where += ` AND i.l${parseInt(loja)} = 1`;
    }

    const itens = await q(`
      SELECT i.nReg, i.Codigobarra, it.Descricao, it.Unid, i.QtdEmb, i.Posicao,
             i.l1, i.l2, i.l3, i.l4, i.l5, i.l6,
             ci.Custo as custo_atual
      FROM central.c_cotacao_lista_itens i
      INNER JOIN central.itens it ON it.CodigoBarra = i.Codigobarra AND it.CodDesativado = 0
      LEFT JOIN central.custoloja1 ci ON ci.CodigoBarra = i.Codigobarra
      ${where}
      ORDER BY i.Posicao, it.Descricao
    `, params);

    res.json(itens.map(r => ({
      codigo: r.Codigobarra,
      descricao: r.Descricao?.trim(),
      unidade: r.Unid?.trim(),
      embalagem: r.QtdEmb,
      posicao: r.Posicao,
      custo: parseFloat(r.custo_atual || 0),
      lojas: [1,2,3,4,5,6].filter(n => r['l'+n] == 1)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO COMPRAS — PAINEL OPERACIONAL
// ═══════════════════════════════════════════════════

// Fornecedores com pedido colocado hoje (ou em data específica ?data=YYYY-MM-DD)
app.get('/api/compras/pedidos-hoje', async (req, res) => {
  try {
    const hoje = req.query.data || localDate();
    const rows = await q(`
      SELECT
        CodFornec,
        Nome                          AS nome,
        COUNT(DISTINCT nLoja)         AS qtd_lojas,
        COUNT(*)                      AS qtd_pedidos,
        SUM(Total)                    AS total_R,
        MAX(DataLan)                  AS ultima_hora
      FROM central.pedidocompra
      WHERE DATE(DataLan) = ?
      GROUP BY CodFornec, Nome
      ORDER BY total_R DESC
    `, [hoje]);

    const concluidos = new Set(rows.map(r => parseInt(r.CodFornec)));

    res.json({
      data: hoje,
      total_pedidos: rows.length,
      concluidos: [...concluidos],
      detalhe: rows.map(r => ({
        codFornec:   parseInt(r.CodFornec),
        nome:        (r.nome || '').trim(),
        qtd_lojas:   parseInt(r.qtd_lojas),
        qtd_pedidos: parseInt(r.qtd_pedidos),
        total:       parseFloat((r.total_R || 0)).toFixed(2)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Busca CodFornec real e NomeFornec a partir de nRegs de lista de compra
app.get('/api/compras/fornec-por-lista', async (req, res) => {
  try {
    const { listas } = req.query;
    if (!listas) return res.json({});
    const nRegs = String(listas).split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n > 0);
    if (!nRegs.length) return res.json({});
    const ph = nRegs.map(() => '?').join(',');
    const rows = await q(
      `SELECT nReg, CodFornec, NomeFornec FROM central.c_cotacao_lista WHERE nReg IN (${ph})`,
      nRegs
    );
    const map = {};
    for (const r of rows) {
      map[String(r.nReg)] = { codFornec: r.CodFornec, nomeFornec: (r.NomeFornec||'').trim() };
    }
    res.json(map);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Verificação de pedidos da semana de Fátima ──
app.get('/api/compras/verificar-comprador', async (req, res) => {
  try {
    // cod = nReg da lista de compra (não CodFornec)
    const cronFatima = {
      SEG: [344,342,380,355,534,304,537,415,347,332,314,303,482,310,312,311,309,461,313,394],
      TER: [538],
      QUA: [341,419,384,543,555,350],
      QUI: [],
      SEX: [277],
    };

    const nRegsCron = [...new Set(Object.values(cronFatima).flat())];

    // Passo 1a: listas linkadas pelo nome (c_cotacao_agenda_comprador)
    const listasNome = await q(`
      SELECT DISTINCT nLista
      FROM central.c_cotacao_agenda_comprador
      WHERE nome LIKE '%FATIMA%' OR nome LIKE '%FÁTIMA%' OR nome LIKE '%PEREIRA%'
    `);
    // Passo 1b: listas com OperadorLista = nome dela
    const listasOper = await q(`
      SELECT nReg FROM central.c_cotacao_lista
      WHERE OperadorLista LIKE '%FATIMA%' OR OperadorLista LIKE '%FÁTIMA%'
    `);

    const extrasNRegs = [
      ...listasNome.map(r => r.nLista),
      ...listasOper.map(r => r.nReg),
    ].filter(Boolean);

    const todosNRegs = [...new Set([...nRegsCron, ...extrasNRegs])];
    const phN = todosNRegs.map(() => '?').join(',');

    // Passo 2: traduz nReg → CodFornec real
    const listas = await q(
      `SELECT nReg, CodFornec, NomeFornec FROM central.c_cotacao_lista WHERE nReg IN (${phN})`,
      todosNRegs
    );
    const listaMap = {};
    for (const l of listas) {
      listaMap[l.nReg] = { codFornec: l.CodFornec, nomeFornec: (l.NomeFornec||'').trim() };
    }

    const codsFornec = [...new Set(listas.map(l => l.CodFornec).filter(Boolean))];
    if (!codsFornec.length) {
      return res.json({ comprador: 'FATIMA', semana: Object.fromEntries(
        Object.entries(cronFatima).map(([dia, cods]) => [dia, cods.map(cod => ({
          cod, codFornec: null, nome: listaMap[cod]?.nomeFornec || `Lista ${cod}`,
          status: 'PENDENTE', pedidos: []
        }))])
      )});
    }

    // Passo 3: busca pedidos usando CodFornec real (últimos 10 dias)
    const phF = codsFornec.map(() => '?').join(',');
    const pedidos = await q(`
      SELECT DATE(DataLan) AS data, CodFornec, Nome AS nome_fornec,
             COUNT(*) AS qtd, SUM(Total) AS total
      FROM central.pedidocompra
      WHERE DATE(DataLan) >= DATE_SUB(CURDATE(), INTERVAL 10 DAY)
        AND CodFornec IN (${phF})
      GROUP BY DATE(DataLan), CodFornec, Nome
      ORDER BY data DESC
    `, codsFornec);

    // Indexa por CodFornec
    const mapa = {};
    for (const p of pedidos) {
      const k = String(p.CodFornec);
      if (!mapa[k]) mapa[k] = { nome: (p.nome_fornec||'').trim(), pedidos: [] };
      mapa[k].pedidos.push({
        data: String(p.data).slice(0,10),
        qtd: p.qtd,
        total: parseFloat(p.total||0).toFixed(2),
      });
    }

    // Monta resultado por dia
    const resultado = {};
    for (const [dia, nRegs] of Object.entries(cronFatima)) {
      resultado[dia] = nRegs.map(nReg => {
        const info = listaMap[nReg];
        const codFornec = info?.codFornec;
        const pedidoInfo = codFornec ? mapa[String(codFornec)] : null;
        return {
          cod: nReg,
          codFornec: codFornec || null,
          nome: pedidoInfo?.nome || info?.nomeFornec || `Lista ${nReg}`,
          status: pedidoInfo ? 'CONCLUIDO' : 'PENDENTE',
          pedidos: pedidoInfo?.pedidos || [],
        };
      });
    }

    res.json({ comprador: 'FATIMA', semana: resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pedidos do mês agrupados por data e CodFornec
app.get('/api/compras/pedidos-mes', async (req, res) => {
  try {
    const hoje = new Date();
    const mes = req.query.mes ? parseInt(req.query.mes) : hoje.getMonth() + 1;
    const ano = req.query.ano ? parseInt(req.query.ano) : hoje.getFullYear();
    const rows = await q(`
      SELECT DATE(DataLan) AS data, CodFornec
      FROM central.pedidocompra
      WHERE YEAR(DataLan) = ? AND MONTH(DataLan) = ?
      GROUP BY DATE(DataLan), CodFornec
      ORDER BY data
    `, [ano, mes]);
    const mapa = {};
    for (const r of rows) {
      const k = String(r.data).slice(0,10);
      if (!mapa[k]) mapa[k] = [];
      mapa[k].push(parseInt(r.CodFornec));
    }
    res.json({ mes, ano, pedidos: mapa });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO PRECIFICAÇÃO — MARGENS CRÍTICAS
// ═══════════════════════════════════════════════════

app.get('/api/precificacao/margens-criticas', async (req, res) => {
  try {
    const hoje = localDate();
    const mes  = new Date().getMonth() + 1;
    const mm   = mesDB(mes);
    const result = {};
    for (const ln of [1,2,3,4,5,6]) {
      try {
        const rows = await q(`
          SELECT z.Codigo,
                 TRIM(COALESCE(i.Descricao, z.Descricao)) as descricao,
                 SUM(z.ValorTotalNovo) / NULLIF(SUM(z.QtdNovo), 0) as preco,
                 SUM(z.Custo)          / NULLIF(SUM(z.QtdNovo), 0) as custo
          FROM \`ln${ln}${mm}\`.zcupomitens z
          INNER JOIN central.itens i ON i.CodigoBarra = z.Codigo AND i.CodDesativado = 0
          WHERE z.Data = ? AND z.IndCancel = 'N'
          GROUP BY z.Codigo, i.Descricao, z.Descricao
          HAVING custo > 0
        `, [hoje]);
        result[ln] = rows
          .map(r => {
            const preco = parsePreco(r.preco);
            const custo = parsePreco(r.custo);
            const margem = custo > 0 ? +((preco - custo) / custo * 100).toFixed(1) : -999;
            return { codigo: r.Codigo, descricao: r.descricao, preco, custo, margem };
          })
          .filter(r => r.margem < 20)
          .sort((a, b) => a.margem - b.margem);
      } catch(e) { result[ln] = []; }
    }
    // Margem geral e por loja
    let totalVenda = 0, totalCusto = 0;
    const porLoja = {};
    for (const ln of [1,2,3,4,5,6]) {
      try {
        const [r] = await q(`
          SELECT SUM(ValorTotalNovo) as venda, SUM(Custo) as custo
          FROM \`ln${ln}${mm}\`.zcupomitens
          WHERE Data = ? AND IndCancel = 'N'
        `, [hoje]);
        const v = parseFloat(r?.venda || 0);
        const c = parseFloat(r?.custo  || 0);
        totalVenda += v;
        totalCusto += c;
        porLoja[ln] = { msc: c > 0 ? +((v - c) / c * 100).toFixed(1) : 0, msv: v > 0 ? +((v - c) / v * 100).toFixed(1) : 0, venda: +v.toFixed(2), custo: +c.toFixed(2) };
      } catch(e) { porLoja[ln] = { msc: 0, msv: 0, venda: 0, custo: 0 }; }
    }
    result.resumo = {
      margemMSC: totalCusto > 0 ? +((totalVenda - totalCusto) / totalCusto * 100).toFixed(1) : 0,
      margemMSV: totalVenda > 0 ? +((totalVenda - totalCusto) / totalVenda * 100).toFixed(1) : 0,
      totalVenda: +totalVenda.toFixed(2),
      totalCusto: +totalCusto.toFixed(2),
      porLoja
    };
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MÓDULO COMPRAS — ANÁLISE DE ESTOQUE POR COMPRADOR
// Tudo separado por loja (ruptura/excesso/giro por loja)
// Variação de custo: soma das 6 lojas (preço único de compra)
// ═══════════════════════════════════════════════════

const NREGS_COMPRADOR = {
  FATIMA: [344,342,380,355,534,304,537,338,347,332,314,303,482,310,312,311,309,461,313,394,538,341,419,384,543,555,350,277],
};

let _analiseCache = {}, _analiseCacheTs = {};
const ANALISE_TTL = 10 * 60 * 1000;

app.get('/api/compras/analise-estoque', async (req, res) => {
  try {
    const comp = (req.query.comprador || 'FATIMA')
      .normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase();
    const nRegs = NREGS_COMPRADOR[comp];
    const vazio = { lojas:{}, variacaoCusto:[], totalProdutos:0, geradoEm:'' };
    if (!nRegs) return res.json(vazio);

    const now = Date.now();
    if (_analiseCache[comp] && (now - _analiseCacheTs[comp]) < ANALISE_TTL)
      return res.json(_analiseCache[comp]);

    // 1. Produtos diretamente dos itens das listas (só o que está nas listas)
    const phN = nRegs.map(() => '?').join(',');
    const prods = await q(`
      SELECT DISTINCT i.Codigobarra as CodigoBarra, TRIM(it.Descricao) as descricao
      FROM central.c_cotacao_lista_itens i
      INNER JOIN central.itens it ON it.CodigoBarra = i.Codigobarra AND it.CodDesativado = 0
      WHERE i.nCotacao IN (${phN})
    `, nRegs);
    if (!prods.length) return res.json(vazio);

    const codigos = [...new Set(prods.map(p => p.CodigoBarra))];
    const descMap = Object.fromEntries(prods.map(p => [p.CodigoBarra, p.descricao]));
    const phC = codigos.map(() => '?').join(',');

    // 3. Estoque por loja (separado)
    const estRows = await q(`
      SELECT i.CodigoBarra,
        GREATEST(0,COALESCE(e1.Qtd,0)) as q1, GREATEST(0,COALESCE(e2.Qtd,0)) as q2,
        GREATEST(0,COALESCE(e3.Qtd,0)) as q3, GREATEST(0,COALESCE(e4.Qtd,0)) as q4,
        GREATEST(0,COALESCE(e5.Qtd,0)) as q5, GREATEST(0,COALESCE(e6.Qtd,0)) as q6
      FROM (SELECT CodigoBarra FROM central.itens WHERE CodigoBarra IN (${phC})) i
      LEFT JOIN central.estoquen1 e1 ON e1.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen2 e2 ON e2.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen3 e3 ON e3.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen4 e4 ON e4.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen5 e5 ON e5.CodigoBarra = i.CodigoBarra
      LEFT JOIN central.estoquen6 e6 ON e6.CodigoBarra = i.CodigoBarra
    `, codigos);
    // estoqueMap[cod][ln] = qty
    const estoqueMap = {};
    for (const r of estRows) {
      estoqueMap[r.CodigoBarra] = {
        '1':parseFloat(r.q1||0),'2':parseFloat(r.q2||0),'3':parseFloat(r.q3||0),
        '4':parseFloat(r.q4||0),'5':parseFloat(r.q5||0),'6':parseFloat(r.q6||0),
      };
    }

    // 4. Vendas por loja × período (3 meses para cobrir 60 dias)
    const hojeD = new Date();
    const ini60 = localDate(new Date(hojeD - 60*86400000));
    const ini30 = localDate(new Date(hojeD - 30*86400000));
    const meses = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(hojeD.getFullYear(), hojeD.getMonth()-i, 1);
      meses.push({ ano: d.getFullYear(), mes: d.getMonth()+1 });
    }

    // vendasMap[ln][cod] = { qtd30, qtd30ant, custoAtual, custoAnt, ultimaVenda }
    const vendasMap = {};
    for (const ln of ['1','2','3','4','5','6']) vendasMap[ln] = {};

    for (const { ano, mes } of meses) {
      const mm = mesDB(mes);
      for (const ln of [1,2,3,4,5,6]) {
        try {
          const rows = await q(`
            SELECT Codigo,
              SUM(CASE WHEN Data >= ? THEN QtdNovo ELSE 0 END) as qtd30,
              SUM(CASE WHEN Data >= ? AND Data < ? THEN QtdNovo ELSE 0 END) as qtd30ant,
              SUM(CASE WHEN Data >= ? THEN Custo  ELSE 0 END) as custoAtual,
              SUM(CASE WHEN Data >= ? AND Data < ? THEN Custo  ELSE 0 END) as custoAnt,
              MAX(Data) as ultima_venda
            FROM \`ln${ln}${mm}\`.zcupomitens
            WHERE IndCancel='N' AND Data >= ? AND Codigo IN (${phC})
            GROUP BY Codigo
          `, [ini30, ini60, ini30, ini30, ini60, ini30, ini60, ...codigos]);
          const key = String(ln);
          for (const r of rows) {
            const k = r.Codigo;
            if (!vendasMap[key][k]) vendasMap[key][k] = { qtd30:0, qtd30ant:0, custoAtual:0, custoAnt:0, ultimaVenda:null };
            vendasMap[key][k].qtd30     += parseFloat(r.qtd30||0);
            vendasMap[key][k].qtd30ant  += parseFloat(r.qtd30ant||0);
            vendasMap[key][k].custoAtual+= parseFloat(r.custoAtual||0);
            vendasMap[key][k].custoAnt  += parseFloat(r.custoAnt||0);
            const uv = r.ultima_venda ? String(r.ultima_venda).slice(0,10) : null;
            if (uv && (!vendasMap[key][k].ultimaVenda || uv > vendasMap[key][k].ultimaVenda))
              vendasMap[key][k].ultimaVenda = uv;
          }
        } catch(_) {}
      }
    }

    // Filtrar produtos sem nenhuma atividade (sem estoque e sem vendas em 60 dias)
    const codAtivos = codigos.filter(cod => {
      const estoqueTotal = Object.values(estoqueMap[cod] || {}).reduce((s,v) => s+v, 0);
      const vendasTotal  = ['1','2','3','4','5','6'].reduce((s,ln) => {
        const v = vendasMap[ln][cod]; return s + (v ? v.qtd30 + v.qtd30ant : 0);
      }, 0);
      return estoqueTotal > 0 || vendasTotal > 0;
    });

    // 5. Classificar por loja
    const lojas = {};
    for (const ln of ['1','2','3','4','5','6']) {
      lojas[ln] = { ruptura:[], excesso:[], semVenda:[], topVendidos:[], quedaGiro:[] };
    }
    const variacaoCusto = [];

    for (const cod of codAtivos) {
      const descricao = descMap[cod] || cod;

      // Variação de custo — soma das 6 lojas (preço de compra é único)
      let totQtd30=0, totQtd30ant=0, totCustoAtual=0, totCustoAnt=0;
      for (const ln of ['1','2','3','4','5','6']) {
        const v = vendasMap[ln][cod];
        if (!v) continue;
        totQtd30     += v.qtd30;
        totQtd30ant  += v.qtd30ant;
        totCustoAtual+= v.custoAtual;
        totCustoAnt  += v.custoAnt;
      }
      if (totQtd30 > 0 && totQtd30ant > 0 && totCustoAnt > 0) {
        const cu = totCustoAtual/totQtd30, ca = totCustoAnt/totQtd30ant;
        const varPct = ((cu-ca)/ca)*100;
        if (varPct > 5) variacaoCusto.push({ codigo:cod, descricao,
          custoAtual:+cu.toFixed(4), custoAnt:+ca.toFixed(4), varPct:+varPct.toFixed(1) });
      }

      // Por loja
      for (const ln of ['1','2','3','4','5','6']) {
        const estoque = estoqueMap[cod]?.[ln] || 0;
        const v = vendasMap[ln][cod];
        const qtd30    = v ? v.qtd30    : 0;
        const qtd30ant = v ? v.qtd30ant : 0;
        const ultimaVenda = v ? v.ultimaVenda : null;
        const mediaDiaria = qtd30 / 30;
        const diasCobertura = mediaDiaria > 0.001
          ? Math.round(estoque / mediaDiaria) : (estoque > 0 ? 9999 : 0);
        const diasSemVenda = ultimaVenda
          ? Math.round((hojeD - new Date(ultimaVenda+'T12:00:00')) / 86400000) : 999;

        if (diasSemVenda >= 60 && estoque > 0)
          lojas[ln].semVenda.push({ codigo:cod, descricao, estoque:+estoque.toFixed(2), diasSemVenda, ultimaVenda });

        if (mediaDiaria > 0.001 && diasCobertura < 40) {
          const urgencia = diasCobertura < 10 ? 'critico' : diasCobertura < 20 ? 'alto' : 'medio';
          lojas[ln].ruptura.push({ codigo:cod, descricao, estoque:+estoque.toFixed(2), mediaDiaria:+mediaDiaria.toFixed(2), diasCobertura, urgencia });
        }

        if (mediaDiaria > 0.001 && diasCobertura > 80)
          lojas[ln].excesso.push({ codigo:cod, descricao, estoque:+estoque.toFixed(2), mediaDiaria:+mediaDiaria.toFixed(2), diasCobertura });

        if (qtd30 > 0)
          lojas[ln].topVendidos.push({ codigo:cod, descricao, qtd30:+qtd30.toFixed(0), mediaDiaria:+mediaDiaria.toFixed(2) });

        if (qtd30ant > 0 && qtd30 < qtd30ant * 0.7)
          lojas[ln].quedaGiro.push({ codigo:cod, descricao,
            qtd30:+qtd30.toFixed(0), qtd30ant:+qtd30ant.toFixed(0),
            quedaPct:+(((qtd30ant-qtd30)/qtd30ant)*100).toFixed(1) });
      }
    }

    // Ordenar e limitar por loja
    for (const ln of ['1','2','3','4','5','6']) {
      lojas[ln].ruptura.sort((a,b)    => a.diasCobertura - b.diasCobertura);
      lojas[ln].excesso.sort((a,b)    => b.diasCobertura - a.diasCobertura);
      lojas[ln].semVenda.sort((a,b)   => b.diasSemVenda  - a.diasSemVenda);
      lojas[ln].topVendidos.sort((a,b)=> b.qtd30 - a.qtd30);
      lojas[ln].quedaGiro.sort((a,b)  => b.quedaPct - a.quedaPct);
      lojas[ln].ruptura    = lojas[ln].ruptura.slice(0,20);
      lojas[ln].excesso    = lojas[ln].excesso.slice(0,20);
      lojas[ln].semVenda   = lojas[ln].semVenda.slice(0,10);
      lojas[ln].topVendidos= lojas[ln].topVendidos.slice(0,10);
      lojas[ln].quedaGiro  = lojas[ln].quedaGiro.slice(0,10);
    }
    variacaoCusto.sort((a,b) => b.varPct - a.varPct);

    const result = {
      lojas,
      variacaoCusto: variacaoCusto.slice(0,10),
      totalProdutos: codAtivos.length,
      geradoEm: new Date().toISOString()
    };
    _analiseCache[comp] = result;
    _analiseCacheTs[comp] = now;
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/deploy', (req, res) => {
  if (req.query.token !== 'fc360deploy2026') return res.status(403).send('Proibido');
  const gitPaths = [
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    'git'
  ];
  const fs2 = require('fs');
  const git = gitPaths.find(p => p === 'git' || fs2.existsSync(p)) || 'git';
  const cmd = `"${git}" fetch origin && "${git}" reset --hard origin/main`;
  exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
    const out = (stdout || '') + (stderr || '') + (err ? '\nERRO: ' + err.message : '');
    console.log('[DEPLOY]', out);
    res.send('<pre>' + out + '\n\nReiniciando servidor...</pre>');
    setTimeout(() => process.exit(0), 1000);
  });
});

app.listen(3003, '0.0.0.0', () => {
  console.log('✓ Dashboard rodando em http://localhost:3003');
  console.log('✓ Rede local: http://192.168.2.252:3003');
});

process.on('uncaughtException', err => {
  console.error('uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
