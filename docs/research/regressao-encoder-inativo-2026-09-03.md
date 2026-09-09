# Regressão de 03/09/2026: encoder de vídeo não ativa, espectador recebe erro 2012

Investigação do defeito em que o compartilhamento de tela fica carregando e termina em erro
2012 no espectador. O StreamFix funcionava e parou em 03/09/2026 — a regressão é datada, e
sem o plugin o compartilhamento também não funciona (segue bloqueado no Brasil).

Sessão de 08/09/2026. Emissor: Discord Windows 1.0.9256 + Vencord + StreamFix.
Espectador: WSL2 Ubuntu, Discord Flatpak + Equicord/StreamFix.

Método: Chrome DevTools Protocol na porta local 9222 para ler o estado vivo do lado
JavaScript, correlacionado com `%APPDATA%\discord\logs\discord-webrtc_0` do lado nativo.
Quatro reproduções. Cada afirmação abaixo cita a evidência que a sustenta.

> **Atenção ao fuso.** O probe JS registra em UTC (`toISOString`); o log nativo registra em
> hora local (BRT, UTC−3). `16:10` no probe é `13:10` no log nativo. A sessão anterior
> perdeu tempo procurando eventos na janela errada por causa disso.

## Resumo

O lado JavaScript está correto do início ao fim. O binário nativo `discord_voice` recusa
ativar o encoder de vídeo, apesar de o JS pedir `active: true`, de haver 60 fps entrando e
de haver banda alocada. O único sinal que acompanha a recusa é o servidor reportando zero
receptores para o SSRC de vídeo, durante toda a transmissão.

Os módulos nativos `discord_voice-1` e `discord_media-1` foram atualizados em
**03/09/2026 14:30** — o dia exato da quebra.

## 1. O lado JavaScript está correto

Observador passivo instalado na página (listeners + amostragem de leitura a cada 400 ms),
depois estendido com um wrapper sobre `conn.setTransportOptions` que apenas registra os
argumentos e repassa a chamada intacta ao original. Nenhum valor foi alterado ou forçado.

Estado da conexão de stream, constante em todos os snapshots das quatro reproduções:

```
stream:CONNECTED  selfVideo=true  active=true
```

Todas as chamadas de `setTransportOptions` que carregam `streamParameters` levaram
`active: true` — 21 delas só na quarta reprodução, e nenhuma exceção em nenhuma rodada:

```
16:22:53.741  [stream] SP=[{"rid":"100","active":true,"q":100,"maxBR":9000000,
                            "tgtBR":600000,"maxPx":3686400,"maxFps":60}]
              vals: PixelCount=3686400 MaxFramerate=60 MinBitRate=500000
                    MaxBitRate=9000000 BitRate=600000
              from: updateVideoQualityCore < updateVideoQuality
                    < setRemoteVideoSinkWants < _handleMediaSinkWants
```

`remoteSinkWantsPixelCount` chega ao nativo sempre como `3686400`, nunca 0 — ele vem de
`Math.max(...videoStreamParameters.map(p => p.maxPixelCount))`, que é o máximo local, e não
do want do espectador. Uma hipótese de que o nativo recebia pixel count zerado foi levantada
e **refutada** por esses dados.

### Onde `active` é decidido no JS

Vale registrar o mapa, porque a sessão anterior procurou no módulo errado.

`updateVideoQuality` (módulo `904986`, base compartilhada) **nunca calcula `active`** — só
propaga o valor que já está em `videoStreamParameters`. Não adianta procurar a causa no
caminho de qualidade.

O único ponto que grava `active` para o próprio usuário no caminho nativo é `handleVideo`
(módulo `206959`):

```js
handleVideo = (userId, ssrc, _, streams) => {
  let r = clone(this.videoStreamParameters);
  if (userId === this.userId) {
    if (streams?.length > 0)
      streams.forEach(s => r.forEach((p,i) => {
        if (p.rid === s.rid) r[i] = {...p, ssrc: s.ssrc, active: s.active} }))
    else if (ssrc > 0) { r[0].active = true; r[0].ssrc = ssrc }
    else r[0].active = false
  }
  this.videoStreamParameters = r;
}
```

É o callback do opcode VIDEO do gateway de voz: o `active` vem do payload que o **servidor
devolve**. Compare com o módulo `113634` (caminho browser/WebRTC), onde é
`active = this.videoReady`, decidido localmente. São caminhos distintos — o que a busca por
`.active=` encontra em `113634` não diz nada sobre o Windows nativo.

Na prática o servidor **confirma** o stream. Primeira reprodução:

| hora (UTC) | `active` | evento |
|---|---|---|
| 16:10:10.110 | `false` | conexão `stream` nasce |
| **16:10:10.125** | **`true`** | servidor confirma o SSRC |
| 16:10:13.694 | `true` | sink wants do espectador chega |

Depois de virar `true`, nunca mais volta a `false`. Isso descarta a hipótese de que o
servidor estaria negando o stream no plano de controle.

## 2. O binário nativo recusa

Em cada `CreateVideoSendStream`, duas configurações no mesmo milissegundo — a segunda zera o
que a primeira acabou de aceitar:

```
13:22:53.741  Creating simulcast encoder stream ... 2560x1440  active: 1   ← aceita
13:22:53.743  Encoder config: {codec_type: VP8 ... active: 1              ← aplica
13:22:53.743  Encoder config: {codec_type: VP8 ... active: 0              ← zera sozinho
```

E permanece em `active: 0` até o ciclo seguinte, que repete o mesmo padrão. O `active: 1`
aparece sempre na linha da resolução máxima configurada (2560x1440) e o `active: 0` na
passagem que adapta ao frame real capturado — é na adaptação ao frame real que o stream é
desligado.

Consequência, com a janela compartilhada visível (para descartar a queda de captura por
minimização observada na primeira rodada):

```
input frame rate: 60 [fps]        ← captura perfeita, 1920x1080
frames encoded: 0                 ← nada codificado
target rate: 530971 → 662634 bps  ← banda alocada e crescendo
[SEA] InitEncode: total_streams_count: 1, active_streams_count: 0
Incoming frame dropped due to that the encoder is blocked
```

Os frames chegam, a banda existe, o JS pede `active: true`, e o encoder recusa. **A decisão
é tomada dentro do binário, não no JavaScript.**

Nada aqui é rota, região ou endpoint — o que remove a base da hipótese de que uma VPN seria
obrigatória. Ela continua sem demonstração.

## 3. O sinal que acompanha a recusa

Constante durante toda a transmissão, em todas as reproduções (91 ocorrências na janela da
quarta rodada, todas com valor 0):

```
[stream] Received receiver count for ssrc: 2680: 0
```

Enquanto isso o JS recebe os sink wants do espectador normalmente:

```
wants: {"2680":100,"pixelCounts":{"2680":295800},"any":100}
```

**O espectador existe no plano de controle e não existe no plano de mídia.** Um encoder que
não vê receptor algum tem motivo legítimo para não codificar — o `active: 0` é consequência,
não a doença.

Ressalva de causalidade: na primeira reprodução o encoder já estava em `active: 0` às
13:10:10.531, quase um segundo **antes** do primeiro receiver count (13:10:11.352). Ou o
valor inicial padrão é 0 até o primeiro relatório chegar, ou há outra causa a montante. Os
dados atuais não distinguem os dois casos.

## 4. A regressão é datada e material

```
/AppData/Local/Discord/app-1.0.9256/modules/
  discord_media-1    2026-09-03 14:30
  discord_voice-1    2026-09-03 14:30
```

`Discord_updater_r00002.log` confirma o burst de instalação de módulos em 03/09 entre
15:03 e 15:05, incluindo `discord_voice`, `discord_media`, `discord_krisp` e outros.

Não há cópia local da versão anterior: `AppData/Local/Discord/packages/` só tem
`Discord-1.0.9251-full.nupkg` (03/08) e o `module_data/discord_voice/` está vazio. Um
downgrade para teste exigiria buscar a build anterior na CDN, e o número dela não é
recuperável dos logs (o `version: 1` que aparece é o sufixo do diretório, não a build).

## 5. Por que o experimento TCP não resolveu

Pelo README, o StreamFix roteia **só o WebSocket do gateway** pela saída fora do Brasil; a
mídia UDP sai direto pelo IP real. Isso bastava porque a verificação de região acontecia uma
única vez, no `VOICE_STATE_UPDATE`, e o plano de mídia não conferia nada.

O experimento de 08/09 alinhou as conexões TCP de *controle* à saída do gateway. Mas a mídia
propriamente dita é UDP e continuou saindo pelo IP brasileiro — por isso o alinhamento não
mudou o resultado. Ver
`docs/superpowers/specs/2026-09-08-media-control-proxy-experiment-design.md`.

## 6. Hipótese de região: testada e refutada

A call ficava no Brasil (`voiceRegion: ""`, automática) e o stream em `us-east`. A hipótese
era que o novo `discord_voice` passasse a exigir coerência entre as duas regiões, ou que o
servidor brasileiro da call recusasse relay para o stream americano.

Quarta reprodução, com `voiceRegion: "us-east"` e `streamRegion: "us-east"`:

```
receiver count:  91 ocorrências na janela, todas 0
frames encoded:  0   (input frame rate 60-61 fps)
active_streams_count: 0
```

Idêntico ao anterior. **Hipótese refutada.**

## 7. Captura entrega quadros em branco (defeito secundário)

O log nativo registra, uma vez por segundo e sem parar durante todo o compartilhamento:

```
(frame.cpp:95): Failed to copy frame into CPU, a blank frame is sent to downstream
```

1747 ocorrências no arquivo, presentes nas cinco reproduções. A captura não consegue copiar
o frame da GPU para a CPU e envia um quadro em branco adiante.

**Isso corrige uma leitura anterior desta investigação:** o `input frame rate: 60 [fps]` das
estatísticas de saída não significa captura saudável — ele conta os quadros em branco.

A sessão de captura usa o video hook:

```
Screenshare: SetWumpusSource(type: 2, video-hook: 1, graphics-capture-api-level: 26100)
creating session with source: Window(HWND(...)), fps: 60,
  video_hook: true, video_hook_allow_dx12: true
```

### Testado: trocar janela por tela inteira

Quinta reprodução, compartilhando o monitor em vez de uma janela. A fonte de fato mudou para
`Display(Handle(HMONITOR(...)))` e as falhas de cópia caíram de ~60/min para 3-18/min.

| | janela | tela inteira |
|---|---|---|
| falhas de cópia | ~60/min | 3-18/min |
| `active` | `false` | `false` |
| `active_streams_count` | 0 | 0 |
| receiver count | 0 | 0 (90 ocorrências) |
| frames encoded | 0 | 0 |

A captura melhorou muito e **nada mudou** no defeito. Os quadros em branco são um segundo
problema real, e não a causa do 2012.

Ponto de intervenção, caso se queira tratar esse defeito separadamente: as opções passam
pelo JS antes de chegar ao nativo, em `setDesktopSourceWithOptions({useVideoHook,
useHookFramePacer, useGraphicsCapture, useGraphicsCaptureApiLevel, useCaptureDeviceForEncode,
videoHookAllowDx12, ...})` no módulo `206959` — alcançável por um plugin.

## 8. O espectador está correto

Logs do WSL em `~/.var/app/com.discordapp.Discord/config/discord/logs/`, mesma janela:

```
[stream] Inbound stats: audio ssrc: 2679, packets received: 34545, lost: -31,
         audio frames normal: 31210, video ssrc: 2680
[RTCConnection(stream)] Go Live Media sink wants: {"2680":100}
(decryptor.cpp:133): Decrypted audio: 34030, video: 0. Failed audio: 33
```

O espectador está conectado ao stream, **recebe e descriptografa 34 mil pacotes de áudio**,
conhece o SSRC de vídeo correto (2680, o mesmo do emissor) e pede qualidade 100. Não recebe
vídeo porque não existe vídeo sendo produzido.

Consequências:

- **O NAT do WSL2 está descartado.** O caminho de mídia UDP do espectador funciona.
- **O `receiver count: 0` que chega ao emissor não corresponde à realidade.** O espectador
  está lá e assinou o SSRC de vídeo.

A sessão MLS/DAVE também estabelece normalmente no emissor
(`session.cpp:386: Successfully processed MLS commit`), então a criptografia E2E não é o
bloqueio.

## 9. Sobre o áudio passar — um argumento que NÃO se sustenta

Durante a investigação levantou-se o seguinte argumento: como o áudio do Go Live atravessa o
plano de mídia e chega ao espectador (pelo mesmo transporte UDP, do mesmo IP brasileiro, para
o mesmo servidor de stream), um bloqueio por região da mídia teria barrado o áudio também —
logo a hipótese de região estaria enfraquecida.

**Esse raciocínio está errado e não deve ser reaproveitado.** Ele assume que um bloqueio
regional recusaria o stream inteiro. A ordem da ANPD é sobre transmissão ao vivo, e nada
impede que a implementação bloqueie **apenas o vídeo**, deixando o áudio passar. O áudio
chegando é perfeitamente compatível com bloqueio regional seletivo.

Fica registrado como armadilha: o áudio funcionar não é evidência contra a hipótese de
região.

## 9b. Codec: testado e refutado

Hipótese: o emissor oferece AV1/H265/H264/VP8 e o espectador só decodifica AV1/H264/VP8; a
troca de codec em laço (VP8 → H265 → H264) sugeria renegociação que não converge.

Teste: interceptação de `setExperimentFlag` no protótipo da classe base (módulo `904986`),
recusando toda flag que casasse com `/av1|h265/i`. Cinco flags bloqueadas, AV1 saiu da lista
de codecs da conexão de stream, e o codec estabilizou em H264 (a troca em laço parou; houve
inclusive `target rate: 2420911`).

Resultado: `active: false`, `active_streams_count: 0`, `frames encoded: 0`. Sem mudança.
**Refutada.** O patch foi removido e o ambiente restaurado.

Nota: a lista de codecs vem do servidor via `_handleCodecs`, não apenas das flags locais —
H265 permaneceu na lista mesmo com as flags bloqueadas.

## 10. Onde a investigação está

O defeito está isolado em: **o binário nativo do emissor configura o encoder de vídeo com
`active: false` e não produz quadros, apesar de o JS pedir `active: true`, do espectador
estar conectado e assinado no SSRC correto, e de haver banda alocada.**

Hipóteses já eliminadas por evidência, que não devem ser reabertas sem dados novos:

- Servidor negando o stream no plano de controle — ele confirma `active: true` (§1).
- Bug no plugin ou no caminho de qualidade JS — todas as chamadas corretas (§1).
- `remoteSinkWantsPixelCount` zerado chegando ao nativo — chega sempre 3686400 (§1).
- Falta de banda — 530-660 kbps alocados e crescendo (§2).
- Incoerência entre região da call e do stream — testada diretamente (§6).
- Método de captura (video hook / janela vs monitor) — testado diretamente (§7).
- Espectador, NAT do WSL2, caminho de mídia do espectador — recebe áudio (§8).
- Criptografia DAVE/MLS — estabelece com sucesso (§8).

Cuidado com um falso positivo já encontrado: `MediaEngineStore.supportsInApp(...)` retorna
`false` para **todos** os tipos de mídia, inclusive `audio`, que comprovadamente funciona.
Essa função não é o gate operacional e não serve como sinal de diagnóstico.

## 11. Hipótese principal atual

O defeito ocorre **apenas no Brasil** (informação do autor do projeto). Combinando isso com
tudo acima, a explicação que sobrevive é:

> A atualização de 03/09 estendeu a verificação de região ao **plano de mídia**, bloqueando
> seletivamente o **vídeo** do Go Live. O gateway roteado continua liberando o plano de
> controle (botões, SSRC atribuído, `active: true` vindo do servidor), mas a mídia sai pelo
> IP brasileiro real e é ali que o vídeo é barrado — daí `receiver count: 0` para o SSRC de
> vídeo enquanto o áudio flui pelo mesmo transporte, e daí o encoder não ativar.

Ou seja: o Discord fechou exatamente a brecha que o StreamFix usa. O pressuposto que sustenta
a arquitetura do plugin — documentado no README como "a mídia (UDP) não passa por verificação
nenhuma" — deixou de valer.

Se confirmada, a consequência de produto é séria: rotear só o gateway deixa de ser suficiente
por design, e isso não é questão de ajuste.

## 12. CONFIRMADA — reprodução com VPN

Sexta reprodução, com VPN ligada (toda a saída fora do Brasil, mídia inclusive). O
compartilhamento **funcionou normalmente**.

| | sem VPN (5 reproduções) | com VPN |
|---|---|---|
| `active` | `false` | `true` |
| `active_streams_count` | 0 | 1 |
| receiver count | 0 (sempre) | 1 |
| frames encoded | 0 | 529 → 1135 → 1720 → 2326 |
| encoded frame rate | 0 | 60 fps |
| encoder | — | `H264 (nvidia: direct3d)` |

Momento da virada:

```
14:03:49.630  active: false,  active_streams_count: 0
14:03:49.681  active: true,   active_streams_count: 1
14:04:14.657  [stream] Received receiver count for ssrc: 4047: 1
```

Variável alterada em relação às reproduções anteriores: a saída da mídia.

> **Correção de 08/09/2026, à noite.** A frase original dizia "variável **única**", e listava o
> espectador entre o que permaneceu igual. **Está errado.** O espectador era o WSL2, que
> compartilha a pilha de rede do Windows: ligar a VPN mudou a saída do emissor **e a do
> espectador**, ao mesmo tempo. Foram duas variáveis, não uma.
>
> Consequência: **nunca testamos um espectador brasileiro assistindo a uma transmissão
> autorizada.** Em toda reprodução bem-sucedida, os dois lados estavam fora do Brasil. A
> hipótese de que a verificação também olha o IP de quem assiste segue viva e não testada, e o
> teste de 08/09 à noite — emissor tunelado, espectador brasileiro, negado — é compatível com
> ela.
>
> Achado apontado pelo usuário, não pela análise. A armadilha aqui é a mesma da seção 9: o
> ambiente de teste acoplava duas coisas que pareciam independentes.

**Diagnóstico fechado:** a partir de 03/09/2026 o Discord passou a verificar a região também
no plano de mídia, bloqueando seletivamente o vídeo do Go Live. Rotear apenas o WebSocket de
gateway deixou de ser suficiente. O pressuposto documentado no README — "a mídia (UDP) não
passa por verificação nenhuma" — não vale mais.

O `receiver count: 0` era o servidor recusando registrar receptores de vídeo para um stream
cuja mídia vem do Brasil; o `active: false` do encoder era a consequência local disso, e o
2012 no espectador, a consequência final.

## 12b. Como o gate se comporta — seis fatos medidos

Investigação da sessão de 08/09, tarde. Cada item foi verificado por teste direto, com o
emissor no Windows e o espectador no WSL. Estes fatos definem o espaço de solução.

**1. A autorização é concedida quando a sessão de entrega nasce, não continuamente.**
Com o túnel ativo no momento de iniciar o compartilhamento, o stream sobe e funciona.

**2. Sobrevive ao desligamento do túnel.** Desligada a VPN com a transmissão no ar, a mídia
migrou para o caminho direto — RTT caiu de 145 ms para 35 ms — e a entrega continuou:
`receiver count: 1` por 16 minutos, 60 mil frames codificados a 60 fps.

**3. Sobrevive a eventos locais do emissor.** Minimizar e restaurar a janela: continuou.
Trocar a fonte compartilhada de tela inteira para janela: continuou.

**4. É revalidada quando um espectador entra.** O espectador saiu e voltou; o encoder chegou
a religar e foi derrubado em menos de um segundo:

```
16:08  recv=1 (57x) → recv=0 → recv=1 (1x) → recv=0
16:08:58  active: true,  active_streams_count: 1
16:08:58  active: false, active_streams_count: 0
```

**5. A revalidação usa o IP da mídia UDP, não o controle TCP.** Este é o achado que fecha o
espaço de solução. Com o experimento de media control proxy ativo — `*.discord.media`
roteado pela saída em Kosovo, conexões abertas e com tráfego bidirecional confirmado no
diagnóstico do plugin (`conexao#14 media saida#1 tx=5375 rx=5499 ativa`) — o servidor negou
assim mesmo, com a mídia UDP saindo do Brasil a 31 ms. **Não há nada que o plugin possa
mover de lugar via proxy que satisfaça o gate.**

Isso explica retroativamente por que o experimento de media control proxy não resolveu: a
intenção estava certa, a conexão alvo é que era a errada.

**6. Ligar o túnel não recupera uma sessão já negada.** Testado duas vezes. A sessão precisa
ser recriada com o túnel já ativo — parar e reiniciar o compartilhamento funciona.

### Latências medidas

| cenário | RTT do stream |
|---|---|
| antes do bloqueio (direto, us-east) | ~134 ms |
| VPN nos EUA + stream us-east | 145 ms |
| VPN nos EUA + stream Brasil (trombone) | 249 ms |
| VPN lenta + stream Brasil | ~320 ms |
| **mídia direta + stream Brasil (`c-gru18`)** | **31–35 ms** |

A saída direta para o servidor brasileiro é ~4x melhor que o Go Live tinha antes do bloqueio.

### Consequência

O gate só pode ser satisfeito com a mídia UDP vindo de fora do Brasil no instante em que a
entrega é criada. Isso permite dois modos, e o trade-off entre eles é a decisão central do
redesenho:

| modo | latência | quando um espectador entra |
|---|---|---|
| túnel momentâneo (sobe, cria a sessão, desce) | 35 ms | transmissão precisa ser recriada |
| túnel permanente | 60–80 ms (Cone Sul) | nada acontece |

No modo momentâneo a franquia e a latência do provedor deixam de importar — o túnel vive
segundos — o que torna viável qualquer VPN gratuita comum (ProtonVPN free, ilimitado) sem
exigir VPS do usuário.

## 13. Consequências de produto

O diferencial do StreamFix era não rotear a mídia: gateway pela saída, todo o resto direto,
na velocidade normal. Esse diferencial é exatamente o que o bloqueio novo ataca.

Direções possíveis, sem ordem de preferência definida:

1. **Túnel só para a mídia do Discord.** Preserva boa parte da proposta — navegação,
   downloads e jogos seguem diretos, só a mídia de voz/vídeo do Discord passa pela saída.
   Exige transporte UDP: SOCKS5 com UDP ASSOCIATE (raro em proxies públicas) ou WireGuard.
   Precisa de teste: verificar se rotear apenas a mídia, mantendo o resto direto, é
   suficiente — a reprodução com VPN roteou tudo e não distingue isso.
2. **Assumir o escopo reduzido.** O plugin continua entregando o destravamento do cliente
   (Trava 1, que segue funcionando) e o roteamento de gateway, e o README passa a documentar
   que, desde 03/09, o Go Live exige também rotear a mídia.
3. **Não fazer nada no plugin** e documentar a regressão para os usuários, que hoje não têm
   explicação para a quebra.

Questão em aberto relevante para decidir: com VPN ligada, o plugin ainda é necessário? Se a
VPN sozinha resolve as duas travas, o valor do plugin nesse cenário precisa ser
reconsiderado. Não testado.

## Apêndice: como reproduzir a instrumentação

O Discord Windows precisa ser iniciado com
`--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`. Não expor a porta à
rede, não abrir firewall, não usar `--remote-allow-origins=*` nem desativar sandbox. Oferecer
reinício normal ao terminar, para remover a porta de depuração.

O acesso é por CDP direto (`Runtime.evaluate` via WebSocket em `/json/list`), sem depender
dos MCPs. Os scripts da sessão ficaram no scratchpad; o essencial é: alcançar o motor de
mídia por `Vencord.Webpack.findStore('MediaEngineStore').getMediaEngine()`, iterar
`engine.connections`, e ler `videoStreamParameters`, `remoteVideoSinkWants`, `selfVideo` e
`connectionState`.

Cuidados com os logs: podem conter tokens de sessão e autenticadores DAVE. Filtrar sempre,
nunca despejar arquivo inteiro. O `/streamfix` copia o relatório completo ao clipboard, mas
a mensagem exibida é truncada em 1800 caracteres — truncamento não é ausência de eventos.
