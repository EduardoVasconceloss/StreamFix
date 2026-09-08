# Túnel momentâneo: restaurar o Go Live com latência nativa

Redesenho do StreamFix para a regressão de 03/09/2026, em que o Discord passou a verificar a
região também no plano de mídia e o roteamento apenas do gateway deixou de ser suficiente.

O diagnóstico completo, com as evidências, está em
`docs/research/regressao-encoder-inativo-2026-09-03.md`. Este documento assume aqueles
achados e trata só do desenho.

Escopo desta spec: **Windows**. Linux e macOS ficam para specs próprias.

## Premissa declarada

> O Discord valida a região da mídia **apenas quando uma sessão de entrega nasce**, e
> revalida quando um espectador entra. Entre esses momentos, a mídia pode mudar de caminho
> livremente.

Isso foi medido em 08/09/2026 e é comportamento não documentado. Foi exatamente esse tipo de
comportamento que mudou em 03/09. **Se a validação passar a ser contínua, o modo momentâneo
deixa de funcionar e resta apenas o modo permanente.** O desenho abaixo trata isso como
suposição, não como verdade estável: por isso o modo permanente não é um plano B improvisado,
é um valor de configuração já previsto.

## A ideia

O túnel sobe, a transmissão nasce autorizada, o túnel desce. A mídia volta a sair direta e a
transmissão continua funcionando, a **35 ms** — quatro vezes melhor que os ~134 ms que o Go
Live tinha antes do bloqueio.

O custo é que a entrada de um espectador novo revalida, e com a mídia direta o servidor nega.
A transmissão precisa então ser recriada com o túnel de pé, o que interrompe quem já assiste
por 2 a 3 segundos.

Como o túnel vive segundos, **a franquia e a latência do provedor deixam de importar**. Isso
torna viável uma conta gratuita de VPN comum (ProtonVPN free é ilimitado) e dispensa VPS.

## Arquitetura

Cinco unidades, cada uma com uma responsabilidade e uma interface estreita.

### `TunnelProvider`

Obtém uma config WireGuard. Interface única:

```
getConfig(): Promise<WireGuardConfig>
```

Implementações nesta spec: `ManualProvider` (config colada nas settings) e `ProtonProvider`
(usuário e senha, gera pela API). O resto do sistema não sabe de onde a config veio.

Ponto de extensão: um `OracleProvider` futuro entra aqui sem tocar em mais nada.

### `Tunnel`

O helper nativo, no processo main.

```
prepare(config)   sobe a interface e completa o handshake
route()           passa a rotear o processo do Discord
unroute()         devolve a mídia ao caminho direto
down()            derruba a interface
status()          estado e diagnóstico
```

A separação entre **preparar** e **rotear** é o que viabiliza o túnel pré-aquecido: recuperar
vira uma mudança de regra de rota, não a subida de uma VPN do zero. É a diferença entre 2-3
segundos e 5-10 segundos de interrupção.

### `SessionMonitor`

Observa a saúde da entrega e emite `healthy` / `broken`.

**O `active` dos `videoStreamParameters` não serve como sinal.** Foi medido que ele permanece
`true` mesmo com a entrega negada — o JS não fica sabendo da recusa. Usar esse campo produz um
monitor cego.

O sinal confiável é o cruzamento de dois fatos observáveis no renderer:

- `remoteVideoSinkWants` indica que alguém está pedindo o vídeo;
- as estatísticas de saída (`getStats()`) mostram se os frames codificados estão avançando.

**Alguém pedindo e nada sendo codificado por alguns segundos é quebra.** A janela de
tolerância evita disparar em oscilações normais.

### `StreamController`

Sabe parar e reiniciar o Go Live programaticamente.

Isolado porque é a única unidade que depende de API interna do Discord, e por isso a mais
frágil do desenho — vai quebrar em atualizações. Concentrar isso aqui limita o estrago e
torna o conserto localizado.

### `Orchestrator`

A máquina de estados que junta tudo, aplica debounce e implementa os modos. É onde mora a
política; as outras quatro unidades são mecanismo.

## Ciclo de vida

```
IDLE ──[usuário inicia Go Live]──> WARMING
                                      │ prepare() + route()
                                      │ inicia o stream (nasce autorizado)
                                      v
                                     HOT ──[janela quente expira]──> DIRECT
                                      ^                                │
                                      │                    [SessionMonitor: broken]
                                      │                                v
                                      └────[route + restart]──── RECOVERING
                                                                  (após debounce)
```

**`WARMING`** — prepara e roteia o túnel **antes** de iniciar o Go Live, para o stream nascer
autorizado. Fail-closed: se o túnel não sobe, a transmissão não é iniciada e o usuário recebe
uma mensagem clara. Deixar tentar sem túnel só produziria um 2012 inexplicável.

**`HOT`** — túnel roteando. Entradas de espectador não quebram nada. É onde a maioria das
pessoas entra.

**`DIRECT`** — túnel preparado, sem rota. Mídia direta, 35 ms. Uma entrada nova aqui quebra.

**`RECOVERING`** — quebra detectada; aplica debounce, volta a rotear e recria o stream. Volta
para `HOT`, e o relógio da janela quente reinicia — quem chegou atrasado raramente vem
sozinho.

### O parâmetro que unifica os modos

A duração da **janela quente** cobre os três comportamentos, sem código de orquestração
diferente para cada um:

| janela quente | comportamento | para quem |
|---|---|---|
| `0` | momentâneo puro — 35 ms desde o primeiro segundo | audiência fixa, latência mínima |
| `3 min` (padrão) | pessoas entram durante a janela sem quebrar; depois 35 ms | uso normal |
| `∞` | túnel permanente, nunca quebra | quem tem VPS própria |

O modo futuro com VPS no Cone Sul é literalmente `janela quente = ∞`, com latência de 60-80 ms
e nenhuma quebra.

### Debounce

Ao detectar quebra, o `Orchestrator` espera **5 segundos** antes de recuperar. Se três pessoas
entram em rajada, é **um** reinício para as três. O debounce também protege contra oscilação
do sinal.

### Orçamento de recuperação

**No máximo 3 recuperações a cada 10 minutos**, com registro do que ocorreu. Sem isso, um
espectador com conexão instável entrando e saindo em laço derrubaria a transmissão
indefinidamente.

Estourado o orçamento, o plugin para de recuperar, sobe para `HOT` e permanece lá — degrada
para o modo estável em vez de brigar.

### Valores iniciais

Todos configuráveis; estes são os padrões de partida, a calibrar com uso real.

| parâmetro | padrão | razão |
|---|---|---|
| janela quente | 3 min | cobre o período de maior entrada de espectadores |
| debounce de recuperação | 5 s | agrupa entradas em rajada |
| orçamento | 3 por 10 min | evita laço de reinício |
| tolerância do monitor | 4 s | tempo com sink wants ativo e zero frames codificados antes de declarar quebra |

## Privilégio, instalação e segredos

Criar interface de rede e alterar rotas exige administrador. O plugin roda dentro do Discord,
sem privilégio. UAC a cada transmissão é inaceitável; um serviço privilegiado que aceita
comandos arbitrários de um processo comum é escalada de privilégio.

**Desenho:** o instalador existente roda uma vez com admin, instala o componente de túnel
(WireSock, que dá filtro por aplicativo no Windows) e registra um **serviço auxiliar do
StreamFix**. Depois disso o plugin nunca mais precisa de elevação.

O serviço expõe um named pipe com **operações fixas e enumeradas** — as cinco de `Tunnel`.
Três regras, nenhuma opcional:

- **Nenhuma operação genérica.** Nada de "executar comando" ou "aplicar regra arbitrária".
- **ACL do pipe restrita ao usuário que instalou.**
- **Config validada antes de aplicar** (formato de chave, endpoint, `AllowedIPs`), para que
  uma config maliciosa não vire regra de rota arbitrária.

**Segredos.** A chave privada do WireGuard é credencial e as settings do Vencord são um JSON
em texto plano — ela não pode ir para lá. Vai cifrada com DPAPI no escopo do usuário; o
plugin guarda uma referência e o serviço decifra em memória ao aplicar. A chave nunca aparece
em log nem no relatório do `/streamfix`, que precisa continuar seguro para colar em suporte.

Credenciais de provedor seguem a mesma regra. O `ProtonProvider` persiste a **sessão**, nunca
a senha.

**Desinstalação.** O caminho de desinstalar do instalador precisa derrubar o túnel, remover o
serviço e apagar os segredos. Um túnel órfão que sobrevive à desinstalação seria grave: o
usuário acharia que removeu e seguiria com tráfego roteado.

**Estado residual.** Se o Discord fechar de forma anormal com o túnel roteando, o serviço
detecta e volta ao direto sozinho.

**Risco conhecido:** o WireSock é software de terceiro, adiciona um passo ao instalador e pode
mudar de licença ou ser descontinuado. O GoLiveBypass mantém specs dedicadas à prontidão dele,
o que sugere que dá trabalho na prática.

## Tratamento de erro

**Princípio: nunca degradar silenciosamente para o 2012.** Toda falha vira mensagem que diz o
que houve e o que fazer.

| falha | comportamento |
|---|---|
| provedor não autentica / API fora | não inicia a transmissão, mensagem clara |
| túnel não sobe | fail-closed, não inicia |
| config inválida | rejeitada na validação, antes de virar rota |
| serviço auxiliar ausente | avisa que precisa reinstalar |
| orçamento de recuperação estourado | degrada para `HOT` |
| `StreamController` quebrado | degrada para `HOT`, registra, avisa |

O destino de toda degradação é `HOT` — o estado que sempre funciona, só que mais lento.
Falhar para "mais lento porém estável" é sempre melhor que falhar para "não transmite".

## Testes

As sessões de 08/09 produziram séries temporais reais de todos os cenários relevantes:
transmissão saudável por 16 minutos, quebra na entrada de espectador (16:08 e 16:23),
recuperação bem-sucedida, e sessão negada que não se recupera. **Essas séries viram
fixtures**, e com elas a maior parte do sistema é testável sem Discord e sem humano.

- **`SessionMonitor`** — alimentado com as séries reais, precisa detectar as quebras de 16:08
  e 16:23 e **não** disparar durante os 16 minutos saudáveis nem nos eventos locais
  (minimizar, restaurar, trocar fonte). Cobre o pior defeito possível aqui: um falso positivo
  reinicia a transmissão sem motivo.
- **`Orchestrator`** — máquina de estados pura, com relógio injetável. Janela quente,
  debounce, orçamento e transições de degradação, sem esperar tempo real.
- **Validação de config** e **provider** com API mockada.

Continua exigindo teste manual apenas o que depende do servidor do Discord: se o stream nasce
autorizado com o túnel de pé, e se a recuperação restabelece a entrega. Vira um roteiro curto
de aceitação, não a forma principal de validar.

**Modo simulação:** o plugin observa e registra o que *faria*, sem subir túnel nem reiniciar
nada. Permite validar a detecção em uso real, com risco zero, antes de deixá-lo agir sozinho
na transmissão de alguém.

Parte desse arcabouço serve também à issue #30 (cobertura de regressão de gateway, saída e
RTC).

## Fora de escopo

- GUI — o StreamFix continua sendo plugin mais instalador.
- Linux e macOS — specs próprias. No macOS não há caminho simples para split tunnel por
  aplicativo; a via seria extensão de rede com assinatura da Apple, o que muda o custo do
  projeto.
- Provisionamento de VPS — spec futura, quando o modo permanente for priorizado.
- **Remoção do código legado de SOCKS5/PAC.** O túnel torna obsoleto quase tudo que o
  `native.ts` faz hoje (`serveSocks`, `negotiateSocks5`, `pacScript`, `openTunnel`,
  `rankFreeProxies`, pool de saídas), mas a remoção só acontece depois do túnel provado em
  campo. Registrado aqui como direção: o StreamFix com túnel fica **menor** do que é hoje.

## Pontos de extensão

Dois, explícitos desde a primeira versão:

1. **Origem da config** — novo `TunnelProvider`.
2. **Modo do túnel** — valor da janela quente.

Adicionar a VPS Oracle no futuro deve ser escrever um provider e ligar uma chave. Se essas
dimensões ficarem implícitas, vira reescrita.
