# Escritório 3D isométrico com vida — design (05/11/2026)

Tiago mandou 5 prints de um anúncio ("Escritório de Agentes de IA", amiatec, feito no Lovable):
maquete isométrica de um andar inteiro, com sala do diretor no canto, lounge com sinuca/pebolim/ping-pong/
fliperama, bancadas de atendentes com etiqueta flutuante ("● atendendo / Nome / CARGO"), sala de reunião,
recepção, plantas. Pediu: "se espelha nesse 3D pra colocar no nosso Compras 3D que já temos". Depois:
"o local deve ser maior; quando não tiver fazendo nada o avatar anda pela sala, faz coisa de gente; sala de
reunião ter reunião quando for pra ter; faz algo bem legal e evoluímos juntos".

Página: `public/robo-escritorio-3d.html` (aba "Escritório 3D" de Processos › Robô de Precificação, só admin).
Dados continuam os mesmos: `/api/robo-precificacao` (vigia, real) e `/api/comprador-sombra` (compras, sombra).
Painel lateral (KPIs, cards, feed) não muda.

## Regra visual

Print externo dita a ESTRUTURA (isométrico, zonas, etiquetas em 3 pílulas, lounge); cores são sempre as
nossas: navy `#13294b` + âmbar `#f2a516`, madeira clara, creme, carpete cinza, vidro. Nada de verde-água.
Etiquetas pequenas (Tiago 04/11 achou balões grandes feios).

## Fase A — maquete isométrica (esta sessão)

- Câmera ortográfica fixa (θ = 45°, elevação ≈ 35°), zoom pela roda e botões, arrastar gira, botão ⌂ volta
  pro isométrico. Sem giro automático. Fundo = gradiente de céu azul-acinzentado (CSS, renderer alpha).
- Andar 30 × 22 m. Paredes do fundo (x = −15 e z = −11) altas de vidro com montantes escuros e rodapé de
  0,9 m; silhueta de cidade (caixas azul-pálido) atrás. Paredes da frente baixas (0,9 m) com vão de entrada
  e tapete. Laje escura embaixo.
- Zonas (x pra direita, z pra frente/câmera; canto do fundo = (−15, −11)):
  - Sala do diretor (Tiago): canto do fundo esquerdo, piso de madeira, vidro nos lados internos com porta,
    quadro branco "METAS DO MÊS" com os números reais (meta R$, projeção, por lista), mesa grande, 2 sofás +
    mesinha, aparador, planta. Tiago de frente pra câmera, crachá verde.
  - Precificação: 2 postos na frente da sala do Tiago, de costas pra câmera (telas com dados reais visíveis),
    placa no chão "PRECIFICAÇÃO · em teste".
  - Compras: bancada de 6 postos frente a frente (3 de frente pra câmera, 3 de costas), divisória navy,
    carpete, placa no chão "COMPRAS · SOMBRA", letreiro ECONÔMICO · COMPRAS e quadro "LISTAS DO ROBÔ" na
    parede do fundo.
  - Sala de vidro das compradoras (fundo direito): mesa larga, compradora(s) reais do ERP, placa.
  - Lounge (frente esquerda): 2 fliperamas, sinuca, pebolim, ping-pong, 2 pufes (âmbar e navy), estante.
  - Recepção (frente, ao lado do vão de entrada): balcão navy com logo âmbar.
  - Sala de reunião (frente centro): mesa de madeira 3,6 × 1,4 com 6 cadeiras, TV na parede baixa.
  - Sala do ERP (frente direita, vidro): 2 racks com LEDs, cubos azuis de dado voando dos postos até lá.
  - Copa (parede direita): balcão com cafeteira e canecas, bebedouro. Impressora. Plantas nos cantos.
- Bonecos chibi: cabeça maior, headset (arco + concha + microfone) nos robôs; crachá nas pessoas.
- Etiqueta em 3 pílulas empilhadas: status ("● sombra" / "● real" / "● aprovando"), nome, cargo (fundo âmbar
  nos postos sombra, navy na precificação, verde nas pessoas). Texto do que está fazendo só no selecionado.
- Luz: clara e chapada como a referência (hemisférica forte + sol suave com sombra macia).

## Fase B — vida (mesma sessão, depois da A)

- Malha de navegação: grade de 0,5 m com os móveis marcados como obstáculo; A* simples; caminhos retos
  entre células livres. Bonecos têm pose sentada e em pé; andando balançam pernas e braços.
- Estado de cada posto vem do dado real: `trabalhando` se tem o que fazer (Sugestão com pedir_hoje,
  Aprovação idem, Pedido ERP idem, Radar com trânsito, Cobrança com fornecedor atrasado, Resumo sempre às
  17:30–18:30, Vigia/Precificação com vazamento grave). Senão, `ocioso` → escolhe uma atividade: café,
  bebedouro, sofá, pufe, pebolim/sinuca/ping-pong em dupla, conversar com colega (bolha "…"), e volta.
- Status da pílula dinâmico: trabalhando · no café · no lounge · conversando · em reunião · lendo o ERP ·
  com o Tiago · esperando.
- Hora real: dia (luz branca-azulada), fim de tarde (âmbar), noite (luminárias quentes, janelas da cidade
  acesas, céu escuro). Antes das 06:00 e depois das 20:00 só o Vigia fica na mesa; os outros "foram embora"
  (ausentes) — o robô roda de madrugada mesmo.

## Fase C — reuniões e eventos (depois da B)

- Agenda do dia (hora real): 05:50 e 13:05 Vigia vai à sala do ERP; 07:00 Resumo leva o resumo pro Tiago;
  18:00 reunião do Resumo do Dia na mesa grande com todos de Compras + Precificação, TV mostra a pauta real.
- Eventos pelo dado: pedir_hoje → Sugestão leva à Fila de Aprovação → Aprovação vai à sala da compradora;
  vazamento grave → Precificação vai à sala do Tiago; cobrar → visitante (vendedor, cinza) entra pela porta,
  espera na recepção, Cobrança atende; recálculo novo → Vigia vai ao ERP.
- Botão "simular um dia": roda as 24 h em ~60 s (relógio acelerado só na cena), pra demonstração.

## Fora de escopo

Nada muda nas APIs nem no painel lateral; nenhum dado novo é gravado; continua só admin.
