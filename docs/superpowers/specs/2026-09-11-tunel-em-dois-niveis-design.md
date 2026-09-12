# Túnel em dois níveis: controle sempre, mídia só no nascimento

Refina `2026-09-11-tunel-nas-duas-pontas-design.md`. Aquela spec continua valendo em tudo o que
esta não muda. Esta substitui a decisão **D9** (túnel permanente em quem transmite) e cumpre o
"refinamento previsto" da seção 7 dela, por um caminho melhor do que o que ela previa.

Base medida: `docs/research/regressao-encoder-inativo-2026-09-03.md`, seções **12g**, **12h** e
**12i**.

> Revista em 12/09/2026 depois da fase 0 (12i). A câmera exige que a **voz** também nasça no
> completo, e isso acrescenta um terceiro momento de empréstimo, a unidade `voz` e o resgate por
> `reconnect()`. A folga e o soluço, que estavam em aberto, foram medidos.

---

## 1. Por que mudar

Hoje o túnel leva o Discord inteiro o tempo todo. Funciona, e custa caro onde mais se sente:
a voz da call vai de ~35 ms para ~130 ms, porque o servidor de voz está em São Paulo e o
caminho passa pelo Chile. E todo vídeo de todo mundo atravessa a VPS.

A seção 7 da spec anterior previa atacar isso com o túnel levando só a transmissão, por faixa
de IP dos servidores de mídia. Três rodadas de testes, em 11 e 12/09, mostraram um caminho
melhor:

**12g — quem transmite só é conferido quando a transmissão nasce.** Com o túnel de quem
transmite derrubado havia um minuto, um espectador novo (com túnel) entrou e recebeu 60 fps. O
controle negativo, com o espectador sem túnel, recebeu zero bytes na mesma transmissão.

**12h — a Trava 1 é decidida pelo IP do gateway, e só dele.** O servidor manda o experimento
`2026-08-video-guard` dentro do `READY`. Com o Discord aberto sem túnel, veio a variante que
trava. Com um túnel levando **só** a faixa de controle (`162.159.128.0/17` e o DNS), não veio
nada, e a voz saiu direto a 32 ms. E trocar de perfil com a call no ar **não derruba o
gateway**.

**12i — a câmera é conferida quando a conexão de voz nasce, dos dois lados.** Com a voz nascida
pelo Brasil, quem liga a câmera não codifica, e quem assiste não recebe, mesmo sem Trava 1.
Trocar o túnel depois não muda o veredito em nenhum sentido. E em todas as conexões o veredito
já está dado no `CONNECTED`: voltar ao controle nesse instante entregou.

Junto com 12e (quem assiste só é conferido ao entrar), o modelo fica completo:

| o que | quando o Discord confere | o que precisa estar no túnel |
|---|---|---|
| a Trava 1 | a cada conexão do gateway | o controle (gateway, API) |
| a câmera, de quem liga e de quem assiste | quando a conexão de **voz** nasce | a mídia, só naquele momento |
| quem transmite | quando a conexão de stream nasce | a mídia, só naquele momento |
| quem assiste | quando a conexão de stream dessa pessoa nasce | a mídia, só naquele momento |

Fora desses instantes, ninguém precisa da mídia no túnel.

---

## 2. O desenho

Dois perfis do WireSock, gerados da **mesma chave e do mesmo peer**:

| perfil | `AllowedIPs` | quando está no ar |
|---|---|---|
| `<perfil>-controle` | `162.159.128.0/17, 1.1.1.1/32` | o tempo todo, é o estado normal |
| `<perfil>` (o de hoje) | `0.0.0.0/0` | por segundos, enquanto uma conexão de mídia nasce |

Os dois têm `#@ws:AllowedApps` com o Discord, como hoje. Como os dois usam o mesmo endereço de
túnel e a mesma saída, o servidor vê o gateway vindo do mesmo IP antes e depois da troca, e a
conexão TCP sobrevive (12h, e também no WSL em 12i).

Existem três momentos de empréstimo, um para cada conexão de mídia que nasce:

```
Discord abre             → controle          (Trava 1 não vem)

entra numa call          → completo, disparado no clique, sem segurar a entrada
voz RTC_CONNECTED        → confere o localAddress da voz
    é a saída            → folga → controle
    é o Brasil           → espera o completo, reconnect() da voz, confere de novo
voz reconecta sozinha    → (CONNECTING) completo → mesma conferência

clique em Go Live        → completo, aguardado dentro do clique
stream RTC_CONNECTED     → confere o localAddress do stream → folga → controle

clique em Assistir       → completo (aborta, troca, repete a entrada, como a fase 6)
stream RTC_CONNECTED     → folga → controle
```

**Custo que sobra:**

- **Entrar numa call:** nada audível. A troca acontece antes de a mídia existir, e a volta ao
  controle não tem soluço mensurável (12i).
- **Go Live e Assistir, com a call no ar:** ~200 ms de travada na ida para o completo, e nada
  na volta (12i). A troca leva ~1,25 s.
- **Resgate da voz:** ~0,7 s sem voz, **sem sair do canal**. Ninguém vê você sair e entrar
  (12i).

**O que se ganha:** voz, câmera e transmissão a ~35 ms o tempo todo. A VPS deixa de carregar
vídeo, e a franquia de 10 TB deixa de ser uma preocupação.

---

## 3. Decisões

| # | Decisão | Alternativa descartada |
|---|---|---|
| E1 | Dois perfis com a mesma chave; trocar é `disconnect` + `connect` | Um perfil só com `AllowedIPs` dinâmico (reescrever e reimportar a cada clique) |
| E2 | O controle é **lista do que entra**, não do que fica fora | `DisallowedIPs` com a faixa dos servidores de mídia, que ninguém levantou |
| E3 | O nível normal é o controle; o completo é **emprestado** por quem precisa | `tunelPermanente` decidindo entre dois comportamentos |
| E4 | O Go Live **espera** a troca dentro do clique | "Clique de novo em alguns segundos", como hoje |
| E5 | Sem perfil de controle instalado, o plugin cai no comportamento de hoje (completo sempre) | Exigir reinstalação antes de o plugin novo funcionar |
| E6 | O plugin **confere** a Trava 1 depois de cada conexão do gateway, lendo a atribuição do servidor | Confiar que a faixa cobre o gateway |
| E7 | Configuração `tunelCompletoSempre`, desligada por padrão, para quem prefere o de hoje | Sem saída de emergência |
| E8 | **Toda** conexão de voz nova pega um empréstimo, venha ou não de um clique, e o empréstimo é disparado **sem segurar** a entrada | Segurar a entrada na call até a troca terminar, com um patch no clique |
| E9 | A voz é **conferida** pelo `localAddress` lido no `RTC_CONNECTED` e **resgatada** por `reconnect()`, uma vez por nascimento | Sair e entrar no canal de novo |
| E10 | Folga única, `FOLGA_NASCIMENTO_MS = 2000`, depois de cada `RTC_CONNECTED` | Uma folga medida por tipo de conexão |

**E2 por extenso.** Listar o que fica fora exigiria saber todas as faixas de mídia do Discord,
que variam por região e ninguém mediu. Listar o que entra exige só a faixa de controle. Ela foi
medida: gateway, API, CDN e sinalização de voz resolvem todos para `162.159.128.0/17`. Se a
lista estiver curta, o erro aparece como "a Trava 1 voltou", que E6 detecta. Se a lista de
mídia estivesse curta, o erro apareceria como transmissão preta, que é a falha silenciosa que
este projeto existe para evitar.

**E3 por extenso.** Vários momentos podem pedir o completo ao mesmo tempo: você transmitindo e,
no meio disso, entrando na transmissão de outra pessoa, ou a voz reconectando durante um Go
Live. Um contador de empréstimos resolve. Cada pedido pega um empréstimo e o devolve quando
acaba, e o túnel volta ao controle só quando o contador zera. Isso é uma unidade pura, testável
sem WireSock.

**E5 por extenso.** O plugin chega por atualização do mod, e o perfil de controle chega pelo
instalador. Durante um tempo haverá gente com o plugin novo e sem o perfil novo. Para essas
pessoas o plugin se comporta exatamente como hoje, e o `/streamfix` diz que rodar o instalador
de novo baixa a latência.

**E8 por extenso.** Segurar a entrada na call não resolveria sozinho: uma reconexão automática
(troca de servidor de voz, queda de rede, ser movido por um moderador) não passa por clique
nenhum, e vai de `CONNECTING` a `RTC_CONNECTED` em ~0,7 s, antes de qualquer troca terminar.
Então a conferência com resgate (E9) tem que existir de qualquer jeito. E, com ela existindo,
segurar o clique só evitaria o resgate no caso em que a corrida é perdida. Na medição, a troca
disparada junto com o clique ganhou as três corridas: o completo ficou no ar em ~1,29 s, e a
voz só ficou `CONNECTED` em ~2,5 s. A própria troca atrasa a sinalização da voz, que passa pela
faixa de controle e pausa durante o `disconnect`, então o ganho não é sorte de rede. Mesmo
assim, o desenho não depende dele.

**E9 por extenso.** O `localAddress` da conexão de voz é o IP que o servidor de mídia viu na
descoberta de IP, ou seja, justamente o do nascimento. Ele não se atualiza depois, e é por isso
que o porteiro de hoje erra quando o túnel cai. Mas, lido no `RTC_CONNECTED`, ele diz com
certeza por onde a voz nasceu. O `reconnect()` da conexão RTC fecha o websocket da voz e abre
de novo, pelo mesmo caminho que o Discord usa quando reconecta sozinho. A conexão de mídia
renasce em ~0,7 s, a pessoa continua no canal, e o novo `localAddress` reflete o túnel do
momento. Medido nos dois sentidos em 12i: no controle, a câmera morreu; no completo, voltou.

---

## 4. O que muda em cada unidade

### 4.1 `controle`

- **`estadoDoStatus` passa a casar o nome exato do perfil.** Hoje ele usa `includes`, e
  `streamfix-santiago` está contido em `streamfix-santiago-controle`. Com o controle de pé, o
  plugin acharia que o completo está no ar. O mesmo vale para o `-match` do instalador.
- **Novo `perfilAtivo()`**, que diz qual dos dois perfis está no ar, ou nenhum.
- **Novo `trocar(para)`**: `disconnect`, depois o `subir` de hoje, com toda a conferência de
  `AllowedApps`. O `connect` com outro perfil no ar é recusado sem log, então o `disconnect` é
  obrigatório.

### 4.2 `perfil` e provisionamento

`gerarPerfil` já aceita `destinos`. Entra uma constante `FAIXA_CONTROLE`, e o provisionador
grava os **dois** arquivos a partir do mesmo registro. Um convite continua valendo um peer.

### 4.3 O instalador

- Instalação nova: importa os dois perfis e conecta o de **controle** antes de abrir o Discord.
- Reinstalação de quem já tem o perfil completo: deriva o de controle pelo mesmo caminho do
  `Repair-TunnelProfile` (exportar, reescrever a linha `AllowedIPs`, importar, apagar), sem
  convite e sem chave nova.
- `Connect-Tunnel` confere a rota esperada **para cada perfil**: `0.0.0.0/0` no completo e a
  faixa de controle no outro.

### 4.4 O porteiro

A regra assimétrica de hoje usa o `localAddress` da **voz** como negativa para o Go Live. A
câmera anda na voz, e a transmissão anda na conexão de stream, que é outra e nasce no clique.
Então a voz não diz nada sobre o Go Live, e quem cuida dela passa a ser a unidade `voz` (4.6).
O porteiro fica assim:

- **Antes de nascer** (no clique): quem decide é a troca para o completo ter dado certo,
  conferida pelo `controle`.
- **Depois de nascer**: o `localAddress` da conexão de stream lido no `RTC_CONNECTED`. Se ele
  não for a saída, a transmissão nasceu fora do túnel: avisar para parar e começar de novo
  (fato 6).
- No modo `tunelCompletoSempre`, a regra de hoje continua valendo inteira.

### 4.5 A Trava 1

Depois de cada `CONNECTION_OPEN`, ler
`ApexExperimentStore.getServerAssignment("user", <id>, "2026-08-video-guard")`. Variante 1 ou
2 com o controle no ar significa que a faixa não cobriu o gateway desta pessoa. Nesse caso o
plugin avisa, passa para o completo e recarrega o Discord uma vez. É a atribuição do servidor
que se lê, e não o `getConfig`, porque um override do plugin Experiments esconde a trava no
cliente (12h).

### 4.6 A voz (unidade nova)

Uma decisão pura, sem imports, como `entrada.ts`. Ela recebe os eventos de
`RTC_CONNECTION_STATE` com `context: "default"` e devolve o que fazer:

| evento | situação | ação |
|---|---|---|
| `VOICE_CHANNEL_SELECT` com canal, ou `CONNECTING` | sem empréstimo de voz aberto | pegar empréstimo |
| `RTC_CONNECTED` | `localAddress` é a saída | devolver depois da folga |
| `RTC_CONNECTED` | `localAddress` brasileiro, sem resgate ainda | esperar o completo no ar, `reconnect()` |
| `RTC_CONNECTED` | `localAddress` brasileiro, já resgatada | avisar uma vez, devolver |
| `RTC_CONNECTED` | `localAddress` ilegível | devolver sem resgate; o `/streamfix` mostra |
| `RTC_DISCONNECTED` sem canal (saiu da call) | empréstimo aberto | devolver |

As regras de sempre valem aqui também:

- **Um resgate por nascimento.** O `reconnect()` gera um novo `CONNECTING`, e é ele que zera a
  marca. Se o resgate renascer no Brasil de novo, a unidade avisa e para, sem entrar em laço.
- **Sem perfil de controle, ou com `tunelCompletoSempre`,** a unidade não faz nada. O completo
  já está no ar.
- **O aviso diz o que fazer:** "a câmera desta call pode não funcionar; saia e entre de novo".

Os nomes e a ordem dos eventos foram lidos no Discord 1.0.9257: `VOICE_CHANNEL_SELECT`,
`VOICE_SERVER_UPDATE`, `CONNECTING`, `AUTHENTICATING`, `RTC_CONNECTING` e `RTC_CONNECTED`.
Numa entrada sem troca, o intervalo entre o clique e o `RTC_CONNECTED` é de 1,35 s. Num
`reconnect()`, é de 0,7 s.

### 4.7 O monitor

Não muda.

---

## 5. Erros e estados degradados

| situação | comportamento |
|---|---|
| Sem perfil de controle | comportamento de hoje (completo sempre); `/streamfix` diz para reinstalar |
| Troca para o completo falha no clique de Go Live | Go Live recusado com o motivo; o controle continua no ar |
| Troca para o completo falha na entrada da call | a voz nasce no Brasil, a conferência vê, e o resgate tenta de novo |
| Voz nasceu no Brasil mesmo depois do resgate | aviso de sair e entrar; a call segue, sem câmera |
| Troca de volta para o controle falha | fica no completo (funciona, só com mais latência) e avisa uma vez |
| Trava 1 veio com o controle no ar | aviso, completo permanente, uma recarga |
| Stream nasceu com `localAddress` fora da saída | aviso de recriar a transmissão |
| Vários pedidos do completo ao mesmo tempo | contador; volta ao controle só quando zera |

A regra de sempre vale aqui também: **falha do StreamFix nunca impede ninguém de transmitir, de
assistir ou de entrar numa call.** Na dúvida, o estado para onde se cai é o completo, que é o
que funciona hoje.

---

## 6. O que bloqueava, e foi medido (12i)

1. **A câmera** quebra com a voz nascida no Brasil, dos dois lados, e funciona com a voz
   nascida no completo, mesmo depois da volta ao controle. Isso gerou E8, E9 e a seção 4.6.
2. **A folga depois do nascimento é zero.** Com N = 10, 5, 2 e 0 segundos depois do
   `CONNECTED` do stream, o espectador recebeu 60 q/s nas quatro rodadas. Na voz também foi
   zero. O controle negativo (stream nascido no controle) recebeu zero bytes. E10 põe 2 s de
   margem.
3. **O soluço da troca de perfil:** ~200 ms ao ir para o completo e nada mensurável ao voltar.
4. **O resgate:** o `reconnect()` renasce a conexão de mídia em ~0,7 s, sem sair do canal, e
   o veredito da câmera acompanha o túnel do novo nascimento.
5. **A corrida** entre a troca e o nascimento da voz: a troca ganhou as três vezes.
6. **O `reconnect()` da voz com uma transmissão no ar** não a derruba. Quem transmite segue
   codificando, e quem assiste segue a 60 q/s. Um Go Live logo depois de um `reconnect()`
   também nasce normalmente. O resgate, portanto, não precisa esperar a transmissão acabar.

## 7. O que não foi medido, e não bloqueia

- **Se `162.159.128.0/17` cobre o controle em qualquer lugar.** Foi medido daqui. E6 transforma
  um erro nisso em aviso e recuperação, em vez de botão cinza.
- ~~**Uma reconexão de voz de verdade**, sem ser pelo `reconnect()` chamado à mão.~~ Medida na
  fase 8 do plano, trocando a região do canal com a call no ar: passa pelo mesmo `CONNECTING`, e
  a voz nasceu na saída. Uma das duas vezes, o `disconnect` da troca derrubou a sinalização no
  meio do `AUTHENTICATING`, e o Discord repetiu sozinho (~3 s a mais).
- **Um `STREAM_DELETE` com motivo `unauthorized`,** visto uma vez em 12/09: o Go Live foi
  aceito pelo cliente e recusado pelo servidor 0,6 s depois. Ele sumiu depois de sair e entrar
  na call, e não voltou em quatro tentativas, nem logo depois de um `reconnect()`. Não é o gate
  do Brasil, que não recusa assim. Se reaparecer em uso real, o monitor e o `/streamfix`
  precisam dizer "saia e entre na call".
- **A corrida em outras máquinas e redes.** O resgate cobre a derrota. O custo é ~0,7 s sem voz
  logo depois de entrar.
- **Calls de DM e de grupo.** Devem usar o mesmo caminho RTC, mas não foram testadas.
- **Conexão de stream que sobra.** "Parar de assistir" não fecha a conexão (12g). Uma entrada
  recusada, feita sem túnel, pode deixar para trás uma conexão negada que a próxima entrada
  reaproveite. Isso não é novo: vale hoje também. Fica registrado porque o túnel de segundos
  torna mais comum entrar com o túnel no nível errado.

## 8. Testes

| unidade | como se testa |
|---|---|
| `controle` | `estadoDoStatus` com o perfil contido em outro nome; `trocar` com CLI dublado, incluindo a recusa sem log |
| contador de empréstimos | puro: empréstimos sobrepostos (voz, transmitir, assistir), devolução dupla, falha no meio |
| `voz` | pura: cada linha da tabela de 4.6; o resgate que renasce no Brasil não gera segundo resgate; o `reconnect()` gera `CONNECTING`, que não abre segundo empréstimo |
| porteiro | sai a negativa da voz; entra a conferência pós-nascimento com o `localAddress` do stream |
| perfil | os dois textos a partir do mesmo registro; a faixa de controle no lugar certo |
| instalador | drift test: a rota esperada pelo `Connect-Tunnel` é a mesma constante do `perfil` |
| Trava 1 | a leitura da atribuição, com e sem override de cliente |

E a validação de ponta a ponta, na montagem de 12g (Windows transmitindo, WSL2 assistindo), com
a câmera dos dois lados, mais um amigo de outra cidade para a faixa de controle.
