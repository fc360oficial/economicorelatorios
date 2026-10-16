// Conferência PEDIDO × XML de uma loja — o MESMO bloco em Pedidos de Compra (comprador) e em Fiscal · Pedidos a receber.
// 16/10/2026, Tiago (Estivas Loja 6: margarina 500 g veio em KG e o Fiscal não via a unidade da nota): "essa tela deveria
// ser igual a do pedido de compras, a parte de baixo de conferência pedido x xml".
// Só desenha. Quem chama passa em H os helpers e as AÇÕES da sua tela:
//   H.LOJAS_NOMES     {ln: nome}
//   H.cdTag(cod)      etiqueta "CD" (Pedidos de Compra) ou ''
//   H.abrirNfe        nome da função global que abre a nota pela chave (ou null = sem link)
//   H.cabecalhoExtra() html extra no cabeçalho da loja (ex.: "Fiscal aguardando sua decisão")
//   H.dec(i, tipo)    botões/decisão do item ('a_mais' | 'preco' | 'nao_pedido')
//   H.extraItem(i)    html extra na célula do produto (ex.: "aguardando o fiscal" na falta)
//   H.vq(i)           linha-pergunta do vínculo pelo nome (ou '')
//   H.naoPedidoBtn(i, temFalta)  botão "É item do pedido…" (ou '')
//   H.oqueFazer       {tipo: [quem, o que fazer]} — bloco amarelo quando há consistência (ou null)
//   H.rodape(tipos)   html das ações no fim (xacoes) quando há consistência (ou '')
(function () {
  const fmt = (v, d = 1) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const money2 = v => v == null ? '—' : 'R$ ' + fmt(v, 2);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const br = s => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '';
  const XML_ST = { aguardando: 'Aguardando conferência XML', parcial: 'XML parcial', conciliado: 'Conciliado XML', consistencia: 'Consistência XML', devolvida: 'Entrega devolvida' };
  const XML_PROB = { falta: 'falta', a_mais: 'veio a mais', nao_pedido: 'item não pedido', preco: 'preço', sem_boleto: 'sem boleto', boleto: 'boleto ≠ NF-e', valor: 'valor ≠ esperado', unidade: 'unidade da nota', afinidade: 'conferir se é este pedido', vinculo_nome: 'casado pelo nome: confirmar', devolucao: 'devolução parcial' };
  const TP = { ok: '✓ ok', parcial: 'parcial', falta: 'não veio', a_mais: 'veio a mais', conferir: 'conferir unidade' };
  const probTxt = a => (a || []).map(t => XML_PROB[t] || t).join(', ');
  function seta(dig, ult, pct) {
    if (dig == null || ult == null) return '<span class="mut">—</span>';
    const d = dig - ult; if (Math.abs(d) < 0.005) return '<span class="arw eq">=</span>';
    const p = ult > 0 ? Math.abs(d) / ult * 100 : 0;
    return d > 0 ? '<span class="arw up">▲ ' + (pct ? fmt(p, 1) + '%' : money2(d)) + '</span>' : '<span class="arw dn">▼ ' + (pct ? fmt(p, 1) + '%' : money2(Math.abs(d))) + '</span>';
  }
  // como o item veio na nota: quantidade e unidade comercial, fator de conversão e preço por unidade da nota
  function xmlComoVeio(i) {
    const xs = i.xml || []; if (!xs.length) return '';
    const tit = { trib: 'unidade tributável do XML', emb: 'convertido pela embalagem do pedido (a nota não trouxe a unidade tributável)', unitaria: 'a nota já veio em unidade', peso: 'a nota veio em kg/litro e o pedido é em unidade: convertido pelo preço (preço da nota = N × preço combinado → N unidades por kg)', conferir: 'a nota veio em caixa/fardo sem unidade tributável e o pedido não tem embalagem: conferir' };
    return xs.map(x => '<div class="sub" style="white-space:nowrap' + (x.conversao === 'conferir' ? ';color:#B45C00;font-weight:700' : '') + '" title="' + esc(tit[x.conversao] || '') + '">' + fmt(x.qtdCom, x.qtdCom % 1 ? 3 : 0) + ' ' + esc(x.und || '') + (x.fator && x.fator !== 1 ? ' × ' + fmt(x.fator, x.fator % 1 ? 3 : 0) : '') + (x.valorUnitCom ? ' · ' + fmt(x.valorUnitCom, 2) + '/' + esc((x.und || 'un').toLowerCase()) : '') + (x.conversao === 'conferir' ? ' · conferir unidade' : x.conversao === 'emb' ? ' · emb. do pedido' : x.conversao === 'peso' ? ' · por ' + esc((x.und || 'kg').toLowerCase()) + ' = ' + fmt(x.fator, 0) + ' un' : '') + '</div>').join('');
  }
  function chegouTxt(x) { const c = x.chegou; if (!c) return ''; return (c.fechada ? 'Nota fechada na loja' : 'Nota lançada na loja') + (c.em ? ' em ' + br(c.em) : '') + (c.de > 1 ? ' · ' + c.notas + ' de ' + c.de + ' notas' : '') + (c.fechada ? '' : ' · aguardando fechamento pela central'); }
  function entradaTxt(n) { const e = n.entrada; if (!e) return ''; const cf = e.conferencia; const quem = (nome, h) => { nome = nome && nome !== '0' ? nome : ''; const t = h ? br(h) + h.slice(10) : ''; return nome || t ? ' · ' + [nome, t].filter(Boolean).join(' ') : ''; }; return 'entrou na loja em ' + br(e.dataRecto) + (cf ? quem(cf.operadorLoja, cf.entrada) : '') + (e.status === 'F' ? ' · fechada' : (cf && cf.status === 2 ? ' · fechada (central liberou, ERP concluindo)' : ' · aberta (E)')) + (cf ? ' · ' + cf.texto + (cf.status === 2 ? quem(cf.operadorCentral, cf.liberacao) : '') : ''); }
  // linha da nota sem GTIN vem com chave F<cód. do fornecedor> ou I<linha> (lib/conferencia-xml.js, 07/10/26) — mostra em palavras
  const codTxt = c => { c = String(c || ''); return c[0] === 'F' ? 'cód. do fornecedor ' + c.slice(1) : c[0] === 'I' ? 'linha ' + c.slice(1) + ' da nota, sem código de barras' : c; };
  // vínculo por nome/de-para (07/10/2026, caso Knorr): código da nota é outro GTIN do mesmo produto
  const vincTxt = (i, x) => !i.vinculo ? '' : '<span class="dec" title="Na nota veio como ' + esc(i.vinculo.descricao_xml || '') + ' · ' + esc(codTxt(i.vinculo.cod_xml)) + '"><small style="color:' + (i.vinculo.tipo === 'nome' ? '#B45C00;font-weight:800' : '#137A48') + '">' + (i.vinculo.tipo === 'nome' ? 'casado pelo nome' + (x.status === 'consistencia' ? ' · responder acima' : '') : i.vinculo.tipo === 'fornecedor' ? 'cadastro do fornecedor (cód. ' + esc(i.vinculo.cod_fornec || '') + ')' : 'vínculo gravado') + '</small></span>';

  function secaoXmlLoja(p, ln, x, H) {
    H = H || {};
    const f0 = () => '';
    const cdTag = H.cdTag || f0, dec = H.dec || f0, extraItem = H.extraItem || f0, vq = H.vq || f0, naoPedidoBtn = H.naoPedidoBtn || f0, cabecalhoExtra = H.cabecalhoExtra || f0, rodape = H.rodape || f0;
    const nome = 'Loja ' + ln + ' · ' + ((H.LOJAS_NOMES || {})[ln] || '');
    if (!x || x.status === 'aguardando') return '<div class="xl"><div class="xh">' + nome + ' <span class="xml aguardando">Aguardando conferência XML</span><span class="mut" style="font-weight:500">nenhuma NF-e do fornecedor pra esta loja desde a aprovação</span></div></div>';
    const nNaoVem = (x.itens || []).filter(i => i.decisao && i.decisao.acao === 'nao_vem').length;
    let h = '<div class="xl"><div class="xh">' + nome + ' <span class="xml ' + x.status + '">' + (XML_ST[x.status] || x.status) + '</span>' + (x.problemas || []).map(pr => '<span class="prob">' + esc(pr.msg) + '</span>').join('')
      + (nNaoVem ? '<span class="prob" style="background:#EEF0F4;color:#4E5A72" title="Fiscal aceitou o parcial (16/10/26): pedido de cotação não tem 2ª entrega, o que faltou sai do pedido — cotar de novo">✓ ' + nNaoVem + ' item(ns) não vem mais · fiscal</span>' : '')
      + (x.entrega_recusada ? '<span class="prob" title="Fiscal recusou a entrega: a loja não recebe, vendedor cobrado">✖ entrega recusada pelo fiscal' + (x.entrega_recusada.por ? ' · ' + esc(x.entrega_recusada.por) : '') + '</span>' : '')
      + cabecalhoExtra(x) + '</div>';
    // H.abrirNfe = função global que abre a nota na própria tela (Pedidos de Compra); H.nfeHref(chave) = link direto em outra aba (Fiscal: DANFE em PDF)
    const nfLink = n => !n.chave ? esc(n.nNota)
      : H.nfeHref ? '<a href="' + esc(H.nfeHref(n.chave)) + '" class="nfe" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Abrir a DANFE (PDF) em outra aba">' + esc(n.nNota) + ' ↗</a>'
      : H.abrirNfe ? '<a href="#" class="nfe" onclick="event.preventDefault();event.stopPropagation();' + H.abrirNfe + '(\'' + esc(n.chave) + '\')" title="Abrir a nota (XML do ERP)">' + esc(n.nNota) + ' ↗</a>' : esc(n.nNota);
    h += '<div class="xb">' + (x.chegou ? '<div class="chegou' + (x.chegou.fechada ? ' fim' : '') + '">' + (x.chegou.fechada ? '✓ Finalizado na loja' : '✓ Chegou na loja') + ' · ' + esc(chegouTxt(x)) + '</div>' : '')
      // 16/10/2026 (Tiago: "ainda muita coisa"): uma linha curta por nota; boleto só com vencimento e valor
      + (x.notas || []).map(n => 'NF-e <b>' + nfLink(n) + '</b> · ' + br(n.data) + ' · ' + n.itens + ' itens · <b>' + money2(n.valorNFE) + '</b>' + (n.boletos?.length ? ' · boleto ' + n.boletos.map(b => br(b.vencimento) + ' ' + money2(b.valor)).join(', ') : ' · <span class="prob">sem boleto no XML</span>') + (n.entrada ? ' · <span class="pos">' + esc(entradaTxt(n)) + '</span>' : (n.importado ? '' : ' · <span class="mut">a loja ainda não lançou</span>'))).join('<br>');
    // entrega devolvida: a contranota do fornecedor cobre tudo que veio — a loja não ficou com a mercadoria (16/10/2026, Aujo #94)
    const dv = x.devolvida;
    if (dv && dv.total) h += '<div class="devolvida"><b>Esta entrega foi devolvida' + (dv.em ? ' em ' + br(dv.em) : '') + '</b> pela ' + (dv.notas || []).map(n => 'NF-e ' + nfLink(n) + ' (' + money2(n.valorNFE) + ')').join(', ') + '. A loja não ficou com a mercadoria. <b>Não pagar o boleto.</b> O pedido desta loja fica como não entregue.</div>';
    else if (dv && Object.keys(dv.itens || {}).length) h += '<div class="devolvida parcial"><b>Devolução parcial' + (dv.em ? ' em ' + br(dv.em) : '') + '</b>: ' + (dv.notas || []).map(n => 'NF-e ' + nfLink(n) + ' (' + money2(n.valorNFE) + ')').join(', ') + '. O "Veio no XML" abaixo já desconta o que voltou.</div>';
    // outras notas do fornecedor pra loja que NÃO são entrega (devolução / contranota de outra compra): só informadas
    else if ((x.notas_fora || []).length) h += '<br><span class="mut">Também há devolução do fornecedor nesta loja, de outra compra: ' + x.notas_fora.map(n => 'NF-e ' + nfLink(n) + ' · ' + br(n.data) + ' · ' + money2(n.valorNFE)).join(' · ') + '</span>';
    // Financeiro: uma frase só quando algo não bate; batendo, um "ok" curto
    const f = x.financeiro || {};
    if (f.nfe != null) {
      const difV = f.esperado > 0 ? (f.nfe - f.esperado) : 0, bolDif = Math.abs((f.boletos || 0) - (f.nfe || 0)) > 0.01;
      const avisos = [];
      if (f.esperado > 0 && Math.abs(difV) / f.esperado > 0.005) avisos.push('NF-e veio <b>' + money2(Math.abs(difV)) + ' ' + (difV > 0 ? 'acima' : 'abaixo') + '</b> do esperado pelo pedido (' + money2(f.esperado) + ')');
      if (!f.n_boletos) avisos.push('<b>sem boleto</b> no XML'); else if (bolDif) avisos.push('boletos somam <b>' + money2(f.boletos) + '</b> e a NF-e é ' + money2(f.nfe));
      h += '<br>Financeiro: ' + (avisos.length ? '<span class="prob">' + avisos.join(' · ') + '</span>' : '<span class="pos">✓ nota, pedido e boleto batem (' + money2(f.nfe) + ')</span>');
    }
    h += '</div>';
    h += '<div style="overflow-x:auto"><table><thead><tr><th>Produto</th><th class="r">Pedido</th><th class="r">Veio no XML</th><th class="r">Dif.</th><th>Situação</th><th class="r">Preço digitado</th><th class="r">Preço XML</th><th class="r">Var.</th></tr></thead><tbody>';
    for (const i of x.itens || []) h += vq(i) + '<tr class="' + (i.tipo === 'ok' ? '' : 'zero') + '"><td class="desc">' + esc(i.descricao) + cdTag(i.cod) + (i.tipo === 'a_mais' ? dec(i, 'a_mais') : (i.preco_status === 'maior' ? dec(i, 'preco') : '')) + extraItem(i) + vincTxt(i, x) + '<span class="cod">' + esc(i.cod) + '</span></td><td class="r">' + fmt(i.pedida, 0) + '</td><td class="r"><b>' + fmt(i.recebida, 0) + '</b>' + xmlComoVeio(i) + '</td><td class="r ' + (i.dif < 0 ? 'neg' : (i.dif > 0 ? 'pos' : '')) + '">' + (i.dif ? (i.dif > 0 ? '+' : '') + fmt(i.dif, 0) : '') + '</td><td class="tp-' + i.tipo + '">' + (TP[i.tipo] || i.tipo) + '</td><td class="r">' + (i.preco_digitado != null ? fmt(i.preco_digitado, 2) : '<span class="mut">—</span>') + '</td><td class="r"><b>' + (i.preco_xml != null ? fmt(i.preco_xml, 2) : '—') + '</b></td><td class="r">' + (i.preco_status ? (i.preco_status === 'ok' ? '<span class="arw eq">=</span>' : seta(i.preco_xml, i.preco_digitado, true)) : '') + '</td></tr>';
    const temFalta = (x.itens || []).some(i => i.tipo === 'falta' || i.tipo === 'parcial');
    for (const i of (x.nao_pedidos || [])) h += '<tr><td class="desc">' + esc(i.descricao) + cdTag(i.cod) + dec(i, 'nao_pedido') + naoPedidoBtn(i, temFalta) + '<span class="cod">' + esc(codTxt(i.cod)) + '</span></td><td class="r">—</td><td class="r"><b>' + fmt(i.recebida, 0) + '</b>' + xmlComoVeio(i) + '</td><td class="r"></td><td class="tp-nao_pedido">não pedido</td><td class="r">—</td><td class="r"><b>' + (i.preco_xml != null ? fmt(i.preco_xml, 2) : '—') + '</b></td><td></td></tr>';
    h += '</tbody></table></div>';
    if (x.aceito) h += '<div class="aceito">✓ Aceito e fechado por <b>' + esc(x.aceito.por || '—') + (x.aceito.papel === 'fiscal' ? ' (fiscal, no recebimento)' : '') + '</b> em ' + new Date(x.aceito.em).toLocaleString('pt-BR') + ' · motivo: <b>' + esc(x.aceito.motivo) + '</b>' + (x.aceito.problemas?.length ? ' · tinha: ' + esc(probTxt(x.aceito.problemas.map(z => z.tipo))) : '') + '</div>';
    if (x.status === 'consistencia') {
      const tipos = [...new Set((x.problemas || []).map(z => z.tipo))];
      if (H.oqueFazer) h += '<div class="oq">' + tipos.map(t => { const o = H.oqueFazer[t] || ['—', '']; return '<div><span class="t">' + esc(XML_PROB[t] || t) + ' · ' + esc(o[0]) + '</span>' + esc(o[1]) + '</div>'; }).join('') + '</div>';
      h += rodape(tipos);
    }
    return h + '</div>';
  }
  window.SecaoXml = { secaoXmlLoja, xmlComoVeio, seta, chegouTxt, entradaTxt, probTxt, codTxt, vincTxt, XML_ST, XML_PROB, TP, fmt, money2, br };
})();
