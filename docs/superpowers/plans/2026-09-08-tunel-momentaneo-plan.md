# Plano de implementação: túnel momentâneo

Implementa `docs/superpowers/specs/2026-09-08-tunel-momentaneo-design.md`. A spec responde
*o quê* e *por quê*; este plano responde *em que ordem* e *como se prova cada passo*.

Escopo: Windows. Diagnóstico de origem em `docs/research/regressao-encoder-inativo-2026-09-03.md`.

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

## Fase 0 — A rede de segurança (pequena, primeiro)

Nada abaixo é confiável se a suíte não roda sozinha.

- Job de CI executando `node --test tests/` em `windows-latest` e `ubuntu-latest`, em push e PR.
- **Prova:** abrir um PR com uma quebra proposital de um teste e ver o job vermelho.

Serve também à issue #30.

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

**Risco:** depende de um segundo humano. Se não houver, a fase 2 pode começar com fixtures
sintéticas escritas à mão, **desde que marcadas como sintéticas** e substituídas depois. Uma
fixture sintética prova a máquina, não a realidade.

## Fase 2 — `SessionMonitor` e modo simulação

**Objetivo:** detectar a quebra de forma confiável, sem ainda agir sobre nada.

**Entregável:** `streamFix/tunnel/monitor.ts` — função pura de série temporal para estado
(`healthy` / `broken`), com relógio injetável, mais a coleta que a alimenta no renderer. E o
**modo simulação**: o plugin observa, registra o que *faria*, não faz.

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

1. **Spike, manual, sem código de produto:** com WireSock e uma config real, provar as duas
   afirmações de que a spec depende:
   - o filtro por aplicativo pega a mídia **UDP** do Discord (o PAC nunca pegou; é a razão de
     tudo isto existir);
   - `prepare` e `route` são separáveis — dá para completar o handshake antes e ligar a rota
     depois em menos de 1 s. **É essa medição que sustenta a promessa de 2-3 s de interrupção
     em vez de 5-10 s.** Se a separação não existir, a spec continua válida, mas o custo da
     recuperação precisa ser reescrito com o número medido.
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
