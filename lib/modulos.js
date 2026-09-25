'use strict';
// Fonte única dos módulos do Econômico Relatórios (mesma divisão da sidebar em
// public/nav.js). Usado pelo middleware de acesso do server.js, pelo /api/me e
// pelo cadastro de usuários (admin-usuarios.html). Página ou API que não está
// em nenhum módulo continua liberada pra qualquer usuário logado.
const MODULOS = [
  { id: 'analise', nome: 'Análise',
    paginas: ['index', 'comparativos', 'consulta', 'itens'],
    apis: ['dashboard', 'comparativo-diario', 'comparativo-lojas', 'comparativo-mensal', 'comparativo-mercadologico', 'consulta', 'itens', 'kpis',
           'faturamento-lojas', 'faturamento-mensal', 'margem-lojas', 'top-mercadologico', 'top-produtos', 'top-vendidos',
           'produtos', 'produtos-semana', 'grupos', 'compra-venda', 'pagar-venda', 'formas-pagamento'] },
  { id: 'cahu-distribuidora', nome: 'CAHU Distribuidora', paginas: ['cahu-tabela-precos', 'cahu-tv-televendas'], apis: ['cahu-distribuidora'] },
  { id: 'dedo-duro', nome: 'Dedo Duro', paginas: ['dedo-duro'], apis: ['dedo-duro'] },
  { id: 'financeiro', nome: 'Financeiro',
    paginas: ['conciliador', 'conciliador-entradas', 'conciliador-cd', 'dre'],
    apis: ['conciliador', 'conciliador-entradas', 'conciliador-cd', 'itau', 'dre'] },
  { id: 'fiscal', nome: 'Fiscal', paginas: ['fiscal'], apis: ['fiscal', 'recebimento'] },
  { id: 'compras', nome: 'Gestão de Compras',
    paginas: ['centro-distribuicao', 'cotacao', 'ruptura', 'fornecedores', 'pedidos-compra', 'ponta-gondola', 'radar-pedidos',
              'sugestao-compras', 'painel-cd', 'comprador', 'analise-comprador', 'margem-comprador', 'compras', 'mensal', 'relatorio-cronograma'],
    apis: ['compras', 'cotacoes', 'ruptura', 'fornecedores', 'listas-compra', 'pedidos-cd', 'painel-cd', 'pedidos-fornecedor',
           'pontas-gondola', 'radar-pedidos', 'sugestao-compras', 'sugestao-manual', 'sugestoes-compra', 'sem-fornecedor'] },
  { id: 'precificacao', nome: 'Promoção', paginas: ['formacao-de-preco', 'precificacao', 'radar-precificacao'], apis: ['precificacao', 'radar-precificacao'] },
  { id: 'prevencao', nome: 'Prevenção', paginas: ['prevencao'], apis: [] },
  { id: 'processos', nome: 'Processos', paginas: ['pendencias', 'negativos', 'log'], apis: ['pendencias', 'negativos', 'log-erp', 'contagem', 'logs', 'log-coletor'] },
];
const IDS = MODULOS.map(m => m.id);

/** Id do módulo dono de `/x.html` ou `/api/prefixo/...`; null se a rota está fora do mapa. */
function moduloDaRota(path) {
  const p = String(path || '').split('?')[0];
  const api = p.match(/^\/api\/([a-z0-9-]+)/);
  if (api) { const m = MODULOS.find(x => x.apis.includes(api[1])); return m ? m.id : null; }
  const pg = p.match(/^\/([a-z0-9-]+)\.html$/);
  if (pg) { const m = MODULOS.find(x => x.paginas.includes(pg[1])); return m ? m.id : null; }
  return null;
}

/** Admin, gerencial e usuário sem o campo (cadastro antigo) veem tudo. */
function modulosDoUsuario(user) {
  if (!user) return [];
  if (user.perfil === 'admin' || user.perfil === 'gerencial' || !Array.isArray(user.modulos)) return IDS.slice();
  return user.modulos.filter(id => IDS.includes(id));
}

function podeAcessar(user, path) {
  const mod = moduloDaRota(path);
  return !mod || modulosDoUsuario(user).includes(mod);
}

/** Dashboard se tem Análise; senão a primeira página do primeiro módulo liberado; null se nenhum. */
function primeiraPagina(user) {
  const mods = modulosDoUsuario(user);
  if (mods.includes('analise')) return '/index.html';
  const m = MODULOS.find(x => mods.includes(x.id));
  return m ? '/' + m.paginas[0] + '.html' : null;
}

function idValido(id) { return IDS.includes(id); }

module.exports = { MODULOS, moduloDaRota, modulosDoUsuario, podeAcessar, primeiraPagina, idValido };
