# Plano de implementação: túnel momentâneo

> **Substituido em 11/09/2026** por `2026-09-11-tunel-nas-duas-pontas-plan.md`.

Implementa `docs/superpowers/specs/2026-09-08-tunel-momentaneo-design.md`. A spec responde
*o quê* e *por quê*; este plano responde *em que ordem* e *como se prova cada passo*.

Escopo: Windows. Diagnóstico de origem em `docs/research/regressao-encoder-inativo-2026-09-03.md`.

## Estado em 09/09/2026

| fase | estado |
|---|---|
| 0 — CI | **feita**, verde nos dois runners |
| 1 — fixtures | 2 de 5 gravadas (`sem-espectador`, `quebra-entrada-espectador`) |
| 2 — monitor | decisão **feita e testada**; falta a coleta no renderer e o modo simulação |
| 3 — túnel | spike encerrado. **O componente serve; a premissa do desenho não.** |
| 4 — provider | não iniciada |
| 5 — orquestrador | **bloqueada** — depende do modelo de gate que caiu |

**O bloqueio.** A spec supunha que mídia não brasileira no nascimento da sessão bastava. Foi
testado com túnel de verdade e não basta: ver a seção 12c da pesquisa. A hipótese principal é
que o IP de quem assiste também conta — e isso, se confirmado, o plugin não resolve.

**O próximo passo é um teste, não código:** mesma montagem da seção 12c, com o espectador
**fora** do Brasil. Se funcionar, o bloqueio alcança quem assiste e o projeto muda de escopo.
Se falhar, o modelo do gate ainda é desconhecido e a investigação recomeça.

O que continua valendo e pode andar em paralelo: a fase 2 (coleta e modo simulação) não depende
do gate — ela detecta que a entrega morreu, seja qual for a causa.

## Correções à spec, apuradas ao montar o plano

**1. As fixtures da seção "Testes" não existem mais.** A spec afirma que as séries temporais
de 08/09 "viram fixtures". Elas não foram salvas: os logs de voz do Discord rotacionam a cada
reinício, e o reinício das 17:18 os apagou. Não sobrou nenhum `discord_voice_*`, e o
`discord_media_rCURRENT.log` tem 1902 bytes, todos posteriores à quebra.

Isso não é fatal, e é menos perda do que parece: o `SessionMonitor` consome sinais do
renderer (`remoteVideoSinkWants` e `getStats()`), não linhas do log nativo. As fixtures certas
sempre foram gravações **das entradas do monitor**, que nunca chegamos a gravar. Mas move a
captura para o início do plano e cria uma dependência de agenda — a quebra só acontece com um
espectador de verdade entrando. **Sem essa captura, a fase 2 não começa.**

**2. Dois riscos de arquitetura foram eliminados por verificação, não precisam de spike.**

- *Módulos irmãos no nativo.* Verificado no build do Vencord
  (`scripts/build/build.mjs:91-102`): o nativo entra por `import * as mod from
  "./<plugin>/native"`, esbuild normal, e a forma `native/index.ts` também é aceita. Dividir
  em vários arquivos funciona. Ressalva: só `native.ts` e `native/index.ts` entram na lista de
  watch — arquivos irmãos empacotam, mas podem não disparar rebuild automático em dev.
- *Teste dos módulos novos.* O Node desta máquina é v24 e faz `require()` de `.ts` direto
  (conferido). Os módulos novos são testáveis por import comum. **O harness de
  `stripTypeScriptTypes` + `runInNewContext` não deve ser estendido** — ele existe só porque
  `native.ts` é um arquivo único de 1200 linhas com efeitos no topo, e não sobrevive a
  `import`. Ele fica congelado cobrindo o legado.

**3. Nenhum dos testes em `tests/` roda em CI.** Só `installer/tests/*` roda
(`test-installer.yml`). Os 17 testes atuais não guardam nada contra regressão em PR.

**4. O instalador não roda com admin — a spec supõe que sim.** A spec diz que "o instalador
existente roda uma vez com admin". Não roda: nenhum dos scripts em `installer/` eleva, e não
precisava, porque tudo que fazem hoje é de usuário (checkout do mod, pasta do plugin, `winget`
de ferramentas de linha de comando).

O componente de túnel instala um driver de filtro de rede, e isso exige elevação. Então
**a fase 3 introduz privilégio num instalador que hoje não tem nenhum**, e isso é uma mudança
de natureza, não um detalhe de implementação. A recomendação é elevar **só esse passo**, num
processo separado, mantendo o resto sem privilégio: a superfície fica menor e o "uma vez com
admin, nunca mais" da spec continua valendo.

**Decisão do usuário (08/09/2026): a instalação e a configuração são automáticas**, feitas
pelo instalador do plugin. Isso confirma o que a spec já dizia e fecha a pergunta que o
roteiro do spike tinha deixado em aberto. Encaixa no padrão que o instalador já usa para Node,
pnpm e Tor: `winget install --silent` com confirmação única, e recuo para instalador oficial
com versão e hash fixos quando não há `winget`. O pacote é `NTKERNEL.WireSockVPNClient`.

Duas coisas que a automação **não** resolve, e que continuam abertas:

- **A config WireGuard.** Instalar o WireSock não produz uma config. É o `TunnelProvider` da
  fase 4, e é lá que mora a fricção que o projeto quer evitar.
- **A desinstalação.** Remover o StreamFix não pode remover um WireSock que já estava na
  máquina antes. O instalador precisa registrar se foi ele quem instalou.

## Fase 0 — A rede de segurança (pequena, primeiro)

Nada abaixo é confiável se a suíte não roda sozinha.

- Job de CI executando `node --test "tests/**/*.test.cjs"` em `windows-latest` e
  `ubuntu-latest`, em push na main e em PR.
- **Prova:** quebrar um teste de propósito e ver o comando sair com código 1.

Serve também à issue #30.

**Feito** em `.github/workflows/test-plugin.yml`. Dois detalhes que custaram tentativa:
`node --test tests/` não funciona — o Node tenta carregar o diretório como módulo e falha
antes de achar teste algum; e o parser de workflow do GitHub não resolve âncora YAML, então a
lista de `paths` fica repetida entre `push` e `pull_request`. O Node está fixado no 24 porque
o harness depende de `stripTypeScriptTypes`, que só existe do 22.18 em diante.

## Fase 1 — Captura das fixtures (bloqueia a fase 2, depende de outra pessoa)

**Objetivo:** gravar as entradas reais do monitor, nos cenários que ele precisa distinguir.

**Entregável:** um script de captura (fica em `tests/fixtures/`, não no plugin) que amostra a
cada 500 ms, pelo CDP, e grava JSON Lines com carimbo de tempo:

- `remoteVideoSinkWants` (alguém pedindo vídeo)
- `getStats()`: `framesEncoded`, `bytesSent`, `packetsSent` da trilha de vídeo
- `videoStreamParameters[].active` — gravado **só para provar que é inútil**, ver abaixo
- estado do Go Live e contagem de espectadores

**Cenários a gravar,** cada um num arquivo próprio:

| fixture | o que é | o monitor deve |
|---|---|---|
| `saudavel-longa` | 10+ min entregando, com espectador | nunca disparar |
| `quebra-entrada-espectador` | espectador entra e a entrega morre | disparar em ~4 s |
| `eventos-locais` | minimizar, restaurar, trocar fonte, durante entrega boa | nunca disparar |
| `sem-espectador` | transmitindo com ninguém assistindo | nunca disparar |
| `negada-desde-o-nascimento` | stream nascido sem túnel | disparar |

`sem-espectador` não está na spec e é o falso positivo mais provável: zero frames codificados
é o comportamento **correto** quando ninguém pede vídeo. É exatamente o que o cruzamento com
`remoteVideoSinkWants` existe para evitar, e precisa de fixture para provar.

**Prova:** os cinco arquivos existem, e uma leitura manual confirma que `active` permanece
`true` na fixture de quebra — reafirmando por dado, não por memória, que ele não serve de sinal.

**Risco:** depende de um segundo humano — e de mais gente do que parecia. Só `sem-espectador`
se grava sozinho. Os outros quatro precisam de alguém assistindo: sem espectador não há
entrega para observar, e `saudavel-longa` e `eventos-locais` também exigem a VPN ligada, senão
não há entrega nenhuma para chamar de saudável.

### Achados da primeira captura (`sem-espectador`, 08/09/2026)

235 amostras, nenhuma falha, campos preenchidos. Três coisas medidas que mudam o desenho:

**1. `sinkWantAsInt` vale 100 com ninguém assistindo.** Ficou em 100 nos 100 segundos inteiros,
sem nenhum espectador. **A regra do monitor escrita na spec — "alguém pedindo e nada sendo
codificado é quebra" — dispararia aqui**, e este é justamente o cenário em que ela não pode
disparar. O campo não serve como sinal de que existe espectador; a presença precisa vir de
outra fonte, a definir na fase 2.

Some-se a isso que, sem espectador, uma transmissão **saudável** também codifica zero quadro.
Do lado de quem emite, "ninguém está assistindo" e "o servidor recusou" são indistinguíveis.
Isso não é limitação da nossa medição, é o comportamento do sistema, e combina com o fato 4 da
pesquisa: a revalidação acontece quando um espectador entra. **O monitor só pode concluir
alguma coisa quando há espectador.**

**2. Os contadores zeram numa renegociação de codec.** Às 21:27:10 o Discord trocou H264 por
H265 no mesmo ssrc, e `bytesSent`/`packetsSent` voltaram a zero. Um monitor que leia "contador
parou de crescer" chamaria isso de quebra. **Queda de contador é reinício de base, não
ausência de progresso** — a fase 2 precisa tratar isso explicitamente.

**3. Os contadores de captura fazem o que se esperava deles.** Enquanto `framesEncoded` ficou
em zero o tempo todo, a captura foi de 0 a 6079 quadros, 1295 deles únicos. Separam
"a captura parou" de "a entrega foi recusada" sem ambiguidade. De quebra, a razão entre total
e únicos (~21%) é o defeito de quadro em branco aparecendo em número.

## Fase 2 — `SessionMonitor` e modo simulação

**Objetivo:** detectar a quebra de forma confiável, sem ainda agir sobre nada.

**Entregável:** `streamFix/tunnel/monitor.ts` — função pura de série temporal para estado
(`healthy` / `broken`), com relógio injetável, mais a coleta que a alimenta no renderer. E o
**modo simulação**: o plugin observa, registra o que *faria*, não faz.

Três exigências vindas da primeira captura, e não do desenho original:

- **Presença de espectador tem de vir de outra fonte que não `sinkWantAsInt`**, que fica em 100
  mesmo sem ninguém. Sem espectador o monitor não conclui nada — permanece em `healthy`,
  porque zero quadro codificado é o comportamento correto ali.
- **Queda de contador é reinício de base.** A renegociação de codec zera `bytesSent` e
  `packetsSent` no mesmo ssrc.
- **Captura e entrega são eixos separados.** Os contadores de captura dizem qual dos dois
  falhou; sem eles, os dois casos parecem o mesmo zero.

**Parcialmente feito.** `streamFix/tunnel/monitor.ts` implementa a decisão, como função pura
sobre a série — não lê store, não olha o relógio, o tempo entra pelo carimbo da amostra. A
presença de espectador vem de `ApplicationStreamingStore.getViewerIds()`, tipada no pacote de
tipos do Vencord, e entra como parâmetro.

A quebra passou a ter **causa**: `entrega` ou `captura`. Só `entrega` justifica recuperação —
religar o túnel e recriar a transmissão não conserta uma captura parada. Isso não estava na
spec e veio da fixture.

Cobertura em `tests/monitor.test.cjs`, incluindo a série real: com zero espectador nenhuma das
201 amostras dispara, e trocando só esse campo para 1 o veredito vira quebra de entrega —
prova de que é a regra do espectador que segura, e não falta de sinal. Cada uma das quatro
regras foi verificada por mutação: removida, ao menos um teste falha.

**Falta:** a coleta no renderer que alimenta o monitor, e o modo simulação. Os dois só se
validam de verdade contra as fixtures que ainda dependem de uma sessão com espectador.

**Prova:** os testes rodam as cinco fixtures. Disparar nas duas de quebra, nunca nas três boas.
Depois, uma sessão real em modo simulação, com espectador, em que o log diz "recuperaria agora"
no momento em que o vídeo de fato morreu.

**Por que sozinha antes de tudo:** já entrega valor isolada. Hoje o usuário vê silêncio e o
espectador vê 2012; com isso ele ao menos sabe que quebrou e por quê. Se as fases seguintes
atrasarem, isto pode ir para a main sozinho.

**Risco:** falso positivo é o pior defeito do sistema — reinicia a transmissão de alguém sem
motivo. É por isso que a tolerância de 4 s e o cruzamento com sink wants são testados contra
gravação real antes de o `Orchestrator` existir.

## Fase 3 — `Tunnel` e o serviço auxiliar

**Objetivo:** subir, rotear, desrotear e derrubar, com o Discord como único aplicativo afetado.

**Ordem interna, do mais arriscado ao mais mecânico:**

1. **Spike, manual, sem código de produto.** Roteiro em
   `2026-09-08-spike-wiresock.md`, com quatro medições e o que cada resultado implica.

   A documentação do WireSock já respondeu uma delas, antes de instalar qualquer coisa:
   **`prepare` e `route` não são separáveis pelo CLI.** Não existe comando para manter o túnel
   de pé e desligar só o roteamento — o ciclo é iniciar e parar o serviço. A spec apoiava a
   promessa de 2-3 s de interrupção nessa separação, então a pergunta passa a ser quanto custa
   uma partida completa: se for ~1 s, a separação nunca foi necessária; se for 8 s, a
   recuperação automática fica cara e a janela quente vira a defesa principal.

   As outras três continuam abertas e só se respondem medindo: se o filtro alcança a mídia
   **UDP** (o PAC nunca alcançou, é a razão de tudo isto existir), se alcança um Discord **já
   aberto**, e se a transmissão sobrevive à queda do túnel. As duas últimas podem matar o modo
   momentâneo — e nesse caso a fase 5 encolhe, porque `RECOVERING` deixa de existir.
2. Serviço auxiliar com named pipe, operações fixas e enumeradas, ACL restrita ao usuário que
   instalou, validação da config antes de virar rota.
3. Segredos por DPAPI no escopo do usuário; a chave privada nunca em log nem no relatório do
   `/streamfix`.
4. Estado residual: fechamento anormal do Discord volta ao direto sozinho.
5. Instalação e **desinstalação** no instalador existente. A desinstalação entra junto, não
   depois: um túnel órfão que sobrevive à remoção é o pior defeito desta fase.

**Prova:** teste de unidade na validação de config (rejeitar chave malformada, endpoint
inválido, `AllowedIPs` abusivo). Teste manual do resto, com roteiro escrito: subir, conferir
por onde a mídia sai, derrubar, conferir que voltou, matar o Discord à força e conferir que o
serviço limpou.

**Risco:** WireSock é software de terceiro e pode mudar de licença ou morrer. O `Tunnel` tem
interface de cinco operações justamente para que trocá-lo seja substituir uma implementação.

## Fase 4 — `TunnelProvider`

**Objetivo:** de onde vem a config.

`ManualProvider` primeiro — config colada nas settings, sem rede, sem conta, e suficiente para
validar as fases 3 e 5 de ponta a ponta. `ProtonProvider` depois, com API mockada nos testes,
persistindo **sessão**, nunca senha.

**Prova:** unidade com API mockada; manual com uma conta gratuita de verdade.

### Como o GoLiveBypass resolve isto (conferido no repositório, 08/09/2026)

Eles não escreveram: vendorizaram `hatemosphere/protonvpn-wg-confgen` em
`tools/proton-confgen/`, um utilitário Go que faz login SRP na Proton, gera um par de chaves
local e pede um certificado à API. Usa as bibliotecas da própria Proton
(`ProtonMail/go-srp`, `ProtonVPN/go-vpn-lib/ed25519`), escolhe o melhor servidor pelo `Score`
que a Proton publica, e sabe emitir certificado **só de sessão**, que nem aparece no painel da
conta.

**GPL-3.0, a mesma licença do StreamFix** — reaproveitar é legítimo.

Três coisas que isso **não** resolve, e que precisam entrar na decisão:

- **A conta continua existindo.** A API tira os cliques no painel, não o cadastro. A fricção
  que o projeto quer eliminar é a conta, e ela permanece.
- **A Proton pede verificação humana.** O código tem um tipo de erro dedicado a isso, com URL
  de CAPTCHA — sinal de que acontece na prática. Um instalador automático precisa saber
  degradar para "abra esta URL e resolva", o que quebra a instalação desacompanhada.
- **É Go, e o StreamFix é TypeScript.** Ou o instalador baixa um binário de terceiro (mais um
  elo na cadeia de suprimento, com verificação de hash), ou o SRP é reimplementado em TS.
  Nenhum dos dois é barato, e a escolha é da fase 4.

**Ordem:** isto vem depois do spike. Se M1, M3 ou M4 derrubarem o WireSock ou o modo
momentâneo, o provedor muda de requisito. Para o spike em si, config baixada à mão é mais
rápida que qualquer automação.

### Opção registrada: saída própria, em vez de conta de provedor

Levantada em 08/09/2026. O que incomoda no `ProtonProvider` não são os cliques, é **o cadastro**
— e ele só desaparece se a saída for do projeto. Um servidor WireGuard próprio, com um peer por
usuário, elimina a conta de todo mundo.

**Conta compartilhada num provedor não serve, e não é questão de gosto:** o plano gratuito da
Proton permite **1 conexão simultânea**, então uma conta global atenderia uma pessoa por vez no
mundo. Fora isso, credencial embutida em plugin de código aberto não é segredo, e um único
usuário abusando derruba o acesso de todos de uma vez.

**A concorrência é o gargalo, não o volume.** Com os 1,7 Mbps medidos na nossa fixture, cada
início de transmissão custa ~1 MB no momentâneo puro e ~38 MB com a janela quente de 3 min —
irrelevante contra os 10 TB mensais do free tier da Oracle. O que limita é quanta gente está
dentro da janela quente ao mesmo tempo: a 1,7 Mbps cada, 100 Mbps sustentam algumas dezenas.
Números de guardanapo, não medição.

**Duas restrições concretas da Oracle**, apuradas na documentação:

- Recursos Always Free só existem **na região de origem da tenancy**, e a região de origem não
  pode ser trocada. Uma conta cuja origem é São Paulo não sobe instância gratuita no Chile.
- **Uma instância em São Paulo não serve como saída**, porque tem IP brasileiro — é exatamente
  o que o bloqueio olha (fato 5 da pesquisa). Ela serve bem para o **serviço de coordenação**,
  que registra a chave pública de cada usuário como peer: isso não é sensível a latência e não
  precisa estar fora do país.

**Isto só importa se o modo momentâneo cair.** Enquanto o túnel vive segundos, a distância da
saída não é sentida — a mídia volta a sair direta logo em seguida, e uma saída gratuita nos
Estados Unidos serve igual a uma no Chile. A saída própria e a proximidade geográfica só viram
requisito no modo permanente. Mais uma razão para o spike vir antes.

O custo desta direção é o projeto passar a operar infraestrutura, e alguém responder pelo
tráfego que sai dela.

## Fase 5 — `Orchestrator` e `StreamController`

**Objetivo:** juntar tudo na máquina de estados.

`StreamController` é a unidade mais frágil do desenho — é a única que depende de API interna do
Discord e vai quebrar em atualizações. Fica isolada, e sua falha degrada para `HOT` com aviso,
nunca para transmissão morta.

**Se parar e reiniciar o Go Live programaticamente não for possível**, o estado `RECOVERING`
não existe: o plugin detecta, avisa, e pede o reinício manual. O sistema continua útil — isso
ainda é muito melhor que o silêncio de hoje — mas a janela quente passa a ser a defesa
principal, e o padrão de 3 min provavelmente precisa subir. **Descobrir isso cedo importa:**
vale um spike curto junto com o da fase 3, mesmo que a fase 5 venha bem depois.

`Orchestrator` é máquina de estados pura, relógio injetável, testável sem Discord: janela
quente, debounce de 5 s, orçamento de 3 por 10 min, e todas as transições de degradação.

**Prova:** unidade cobrindo cada transição; aceitação manual curta para o que só o servidor do
Discord responde — o stream nasce autorizado com o túnel de pé, e a recuperação restabelece a
entrega.

## Fase 6 — Entrega

Padrões da spec como valores iniciais configuráveis. README explicando a regressão de 03/09 e
o que mudou. **A remoção do código legado de SOCKS5/PAC não entra aqui** — só depois do túnel
provado em campo, como a spec já registra.

## Ordem e dependências

```
Fase 0 (CI) ────────────────────────────────> tudo
Fase 1 (fixtures) ──> Fase 2 (monitor) ──┐
                                          ├──> Fase 5 (orquestrador) ──> Fase 6
Fase 3 (túnel) ──> Fase 4 (provider) ────┘
```

As fases 1-2 e 3-4 são independentes. A fase 2 pode ir para a main sozinha.

Os dois spikes — separação `prepare`/`route`, e controle programático do Go Live — rodam antes
de qualquer código de produto das fases 3 e 5. Cada um pode mudar o desenho, e nenhum dos dois
custa mais que uma tarde.
