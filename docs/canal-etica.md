# ECONÔMICO | CANAL DE ÉTICA E DENÚNCIAS — documentação técnica e manual do administrador

Primeira versão funcional (16/10/2026). Base: "prompt mestre" + Especificação V1.0 (PDF de 16/10/2026).
Decisões do Tiago em 16/10: começa em JSON e migra pra banco antes de abrir pras 6 lojas; acompanhamento do
denunciante é somente leitura; retaguarda dentro do Econômico Relatórios (DP / RH › Canal de Ética), portal fora.

## 1. Onde fica cada coisa

| Parte | Arquivo | Acesso |
|---|---|---|
| Regras e dados (camada de dados) | `lib/etica.js` | — |
| Rotas públicas e internas, tick de prazos | `lib/etica-rotas.js` (montado no `server.js`) | — |
| Portal público (registrar, acompanhar) | `public/etica-portal.html` servido em `/etica` e `/etica/<E1..E6\|CD\|ADM>` | sem login, sem sessão, fora do log de acessos |
| Retaguarda | `public/etica.html` (item "Canal de Ética" em DP / RH, `lib/modulos.js` página `etica`) | login do sistema **+** designação no canal |
| Dados | `data/etica/` (gitignored, fora do backup geral) | só o serviço |
| Testes | `test/etica.test.js` (`node --test test/etica.test.js`) | — |

Estrutura de `data/etica/`:

```
config.json                 unidades, categorias, políticas de prazo, cadeia, designados, calendário, avisos
casos/<PROT>.json           o caso (sem a identidade do denunciante)
casos/<PROT>.ident.json     identidade opcional, cifrada com ETICA_KEY (AES-256-GCM)
casos/<PROT>.eventos.jsonl  histórico append-only; cada linha carrega o hash da anterior (verificarCadeia)
omissoes/<OM>.json          avaliação administrativa por descumprimento de prazo (OM-AAAA-NNN)
anexos/<PROT>/              arquivos (nunca servidos como estático; download só por rota autenticada e auditada)
notificacoes.jsonl          avisos internos (painel); sem conteúdo do relato
auditoria/AAAA-MM.jsonl     leituras, downloads, acessos negados, tentativas bloqueadas
tentativas.json             erros de consulta por protocolo (5 em 60 min bloqueia)
```

Toda escrita em disco passa por `lib/etica.js`. A migração pra PostgreSQL é reescrever esse módulo e carregar os
arquivos; telas e rotas não mudam.

## 2. Fluxo e estados

`recebida → em_triagem → aguardando_aceite → em_apuracao → aguardando_validacao → concluida` (ou `arquivada` na
triagem). Impedimento, escalonamento, prorrogação e reabertura são eventos no histórico, não estados.

- **Portal**: gera protocolo aleatório `ETC-AAAA-XXXXX` (alfabeto sem 0/O/1/I/L) e credencial `XXXX-XXXX-XXXX`,
  guardada só como scrypt. Prioridade inicial: risco imediato = Crítica; senão a da categoria (assédio,
  discriminação, fraude, retaliação = Alta; conflito, segurança = Média; normas = Baixa). A triagem pode mudar.
- **Triagem**: gravidade, categoria, envolvidos (ficam impedidos), instância, responsável (tem que ser designado com o
  papel da instância ou "investigador"), medida protetiva, justificativa obrigatória. O sistema **recusa** (HTTP 409)
  responsável envolvido/impedido e grava a tentativa no histórico e na auditoria.
- **Apuração** (só o responsável atual): aceitar, declarar impedimento, pedir redistribuição, providência (a 1ª
  cumpre o prazo), evidência (arquivo com SHA-256), prorrogação (aprovada por Coordenação/Revisor, nunca por quem
  pediu), enviar para validação com resultado proposto.
- **Validação** (Revisor independente, pessoa diferente de quem investigou): aprova e encerra (resultado + texto ao
  denunciante) ou devolve para complementação.
- **Reabertura**: Coordenação ou Revisor, com fundamento.

## 3. Prazos, escalonamento e omissão

Política por prioridade (`config.politicas`), em horas corridas (`h`) ou dias úteis (`du`); calendário com dias
úteis (padrão seg–sáb) e feriados. Valores iniciais = proposta do doc. V1.0 (dependem de Direção, RH e Jurídico):

| Prioridade | Triagem | Aceite | 1ª providência | Investigação | Validação | Comunicação |
|---|---|---|---|---|---|---|
| Crítica | 1 h | 2 h | 2 h | 10 d.ú. | 2 d.ú. | 2 d.ú. |
| Alta | 4 h | 8 h | 24 h | 20 d.ú. | 3 d.ú. | 2 d.ú. |
| Média | 1 d.ú. | 1 d.ú. | 2 d.ú. | 30 d.ú. | 3 d.ú. | 2 d.ú. |
| Baixa | 2 d.ú. | 2 d.ú. | 5 d.ú. | 45 d.ú. | 5 d.ú. | 3 d.ú. |

O `tick` roda a cada minuto no servidor (idempotente: cada caso guarda quais avisos já saíram e quando venceu):

1. avisos em 50% e 80% do prazo (configurável) ao responsável; em 80% também à Coordenação;
2. no vencimento: registra o evento, preserva o histórico do responsável anterior, notifica a instância supervisora,
   encaminha ao primeiro designado **sem conflito** da instância seguinte (RH → Jurídico → Coordenação → Autoridade
   independente; nunca volta), registra a transferência, abre `OM-AAAA-NNN` e notifica o responsável anterior para
   se manifestar (2 dias úteis). Sem substituto sem conflito, o caso fica "sem responsável" e a Coordenação designa.
3. triagem e validação vencidas não mudam de instância: avisam a Coordenação e abrem a OM.
4. na última instância não há novo encaminhamento automático (evento `escalonamento_esgotado`).

A OM é decidida por Coordenação ou Revisor (nunca pelo avaliado) com desfecho: sem falha, orientação, melhoria,
encaminhamento disciplinar, outra. Nenhuma sanção é aplicada pelo sistema.

## 4. Perfis e permissões

Designação em `config.designados` (aba Designados): `triagem`, `rh`, `juridico`, `coordenacao`, `investigador`,
`revisor`, `independente`. Quem não está designado recebe 403 em `/api/etica/*`, mesmo sendo admin do sistema.
Exceção de bootstrap: enquanto não houver designados, o perfil `admin` entra só pra cadastrá-los.

Visibilidade por caso (`podeVer`): triagem, coordenação, revisor e independente veem todos; RH/Jurídico veem os
casos na sua instância; investigador vê os casos em que é ou foi responsável. Pessoa envolvida ou impedida **nunca**
vê o caso, seja qual for o papel. Toda leitura de caso e download de anexo vai pra `auditoria/`.

O painel mascara unidade com menos de 3 casos ("<3") pra quem não é Coordenação/Revisor.

## 5. Variáveis de ambiente

- `ETICA_KEY` — chave da cifra da identidade do denunciante. **Obrigatória em produção**; sem ela a identidade é
  gravada em claro e o servidor avisa no log. Guardar no parâmetro do serviço (nssm), nunca no repositório.
- `ETICA_DIR` — pasta de dados (padrão `data/etica`); usada nos testes.

## 6. Instalação e implantação

1. `git pull` + restart do serviço (as rotas sobem com o `server.js`; não há dependência nova).
2. Definir `ETICA_KEY` no serviço Windows antes do primeiro relato identificado.
3. Entrar em DP / RH › Canal de Ética com um `admin`, cadastrar os designados (ao menos um por papel: triagem, rh,
   juridico, coordenacao, revisor, independente).
4. Conferir Prazos e cadeia (valores aprovados pela Direção) e o calendário de feriados.
5. Excluir `data/etica/` do backup geral (rclone) e criar rotina própria, cifrada, com retenção definida pelo Jurídico.
6. Domínio público (ex.: `etica.<domínio>`) apontando pro Caddy do 254 → `reverse_proxy localhost:3003` com
   `handle_path /etica*` ou rewrite pra `/etica`; imprimir os cartazes com QR por unidade:
   `https://<domínio>/etica/E1` … `/E6`, `/CD`, `/ADM` (o código só pré-seleciona a unidade).
7. Teste de ponta a ponta com dados fictícios: `node --test test/etica.test.js` e o roteiro da seção 8.

## 7. Pendências antes de produção (validação jurídica, de segurança e de governança)

- **Governança** (Direção + Jurídico): quem faz triagem; cadeia; autoridade independente de contingência; prazos;
  competência para validar; política de sanções por omissão; política de retenção por categoria; canal de emergência.
- **Segurança**: MFA (TOTP) na entrada da retaguarda — previsto, não implementado nesta versão; antivírus nos
  anexos; `ETICA_KEY` em cofre; revisão periódica de designados; teste de restauração do backup do canal.
- **Dados**: migração JSON → PostgreSQL antes de abrir pras 6 lojas (banco `etica` no Postgres 16 do 254 ou SQLite);
  separar identidade do relato já está feito; definir descarte.
- **LGPD**: controlador/operador, bases legais, aviso de privacidade no portal, procedimento para direitos do
  titular com os limites da apuração.
- **Comunicação**: e-mail/WhatsApp só com texto genérico ("há um caso aguardando você"); modelos aprovados.
- **Escopo**: o doc. V1.0 previa caixa de mensagens bidirecional com o denunciante; por decisão de 16/10 o
  acompanhamento é somente leitura. Registrar na matriz de decisões.

## 8. Roteiro de homologação (dados fictícios)

1. Anônimo: `/etica/E5` → registrar → guardar protocolo/credencial → `/etica` › Acompanhar.
2. Identificado: mesmo fluxo com nome/contato → na retaguarda, triagem vê a identidade; revisor vê "restrita".
3. Triagem: tentar encaminhar ao gerente citado → bloqueio; encaminhar ao RH → prazos calculados.
4. RH aceita, registra providência "interna + avança etapa" → denunciante vê "nova providência" sem conteúdo.
5. Deixar o aceite vencer (ou ajustar a política pra 0 h e chamar `POST /api/etica/tick`) → escalonado ao Jurídico,
   OM aberta, RH se manifesta, Coordenação decide.
6. Enviar à validação; revisor devolve; reenviar; revisor aprova → portal mostra o resultado.
7. Conferir cadeia de hash no detalhe ("íntegra"), auditoria e painel em celular (320–420 px) e em 1366/1280 px.
