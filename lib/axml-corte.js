// Corte por nReg pras consultas "notas recentes" na central.axml do .252 (06/10/26).
//
// A axml (MyISAM, MySQL 5.0, ~126 mil linhas) não tem índice por Data: toda consulta
// "WHERE Data >= X" varria a tabela inteira e, nos horários em que o Dlinks grava XML
// (escrita MyISAM trava a tabela toda), passava dos 20 s do server.js — o estouro armava
// a pausa de 5 min e DERRUBAVA TODO MUNDO que usa axml, inclusive a tela do Fiscal,
// que nem era a culpada. Foi o "não tá puxando as notas" do Tiago em 06/10.
//
// A saída é usar a PRIMARY KEY: nReg cresce na ordem de CAPTURA do XML, e a emissão
// (Data) nunca é depois da captura. Logo, toda nota com Data >= desde foi capturada
// depois de 'desde' e mora nos nRegs altos. Sondas de 8 mil nRegs (~17 ms cada, range
// na PRIMARY) andam da ponta pra trás até achar 2 fatias seguidas sem nota na janela —
// abaixo dali é só passado. As consultas então acrescentam "nReg >= corte" e viram
// type=range (medido: varredura do Radar caiu de 638 ms/126 mil linhas pra 23 ms,
// com resultado idêntico).
//
// Em QUALQUER falha devolve 0 (sem corte): a consulta fica exatamente como era antes.
const FATIA = 8000;              // nRegs por sonda
const MAX_FATIAS = 40;           // teto de sondagem (320 mil nRegs); passou disso, desiste
const VALE_MS = 10 * 60 * 1000;  // cada corte vale 10 min
const caches = new Map();        // desde ('YYYY-MM-DD') → { corte, em } — por janela, pra uma
                                 // consulta de data antiga não rebaixar o corte das janelas normais

async function corteAxml(q, desde) {
  const c = caches.get(desde);
  if (c && Date.now() - c.em < VALE_MS) return c.corte;
  let corte = 0;
  try {
    const m = Number(((await q(`SELECT MAX(nReg) m FROM central.axml`))[0] || {}).m) || 0;
    if (!m) return 0;
    let lo = m, vazias = 0;
    for (let i = 0; lo > 0 && i < MAX_FATIAS; i++) {
      const n = Number(((await q(`SELECT COUNT(*) n FROM central.axml WHERE nReg > ? AND nReg <= ? AND Data >= ?`, [lo - FATIA, lo, desde]))[0] || {}).n) || 0;
      vazias = n ? 0 : vazias + 1;
      lo -= FATIA;
      if (vazias >= 2) { corte = Math.max(0, lo); break; }
    }
  } catch (e) { return 0; }   // não cacheia falha: na próxima chamada sonda de novo
  for (const [k, v] of caches) if (Date.now() - v.em >= VALE_MS) caches.delete(k);
  caches.set(desde, { corte, em: Date.now() });
  return corte;
}

module.exports = { corteAxml, _zerar: () => caches.clear() };
