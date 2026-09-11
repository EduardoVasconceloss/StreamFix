# StreamFix: bypass do Go Live no Discord (Brasil)

[![Release](https://img.shields.io/github/v/release/EduardoVasconceloss/StreamFix?style=for-the-badge&label=vers%C3%A3o&color=5865F2)](https://github.com/EduardoVasconceloss/StreamFix/releases/latest)
[![Licença](https://img.shields.io/github/license/EduardoVasconceloss/StreamFix?style=for-the-badge&color=5865F2)](LICENSE)

Plugin para Equicord e Vencord, feito por um desenvolvedor brasileiro, que devolve o Go Live e a câmera para usuários brasileiros. Ele manda **só o Discord** por um túnel WireGuard que sai fora do Brasil. Todo o resto do computador continua saindo direto, pelo seu IP de sempre.

> English summary at the end of this document.

> [!IMPORTANT]
> **Se você usava a versão antiga, ela parou de funcionar em 3 de setembro de 2026.** Até ali bastava mandar o WebSocket de gateway por uma proxy: a liberação era decidida uma vez, na entrada do canal de voz. O Discord passou a verificar a região também no plano de mídia, e aí proxy de gateway deixou de resolver — quem transmitia via a transmissão subir e morrer, e quem assistia via tela preta.
>
> A versão atual resolve isso de outro jeito, e o preço é honesto: **você precisa de uma saída fora do Brasil**. Ou uma máquina sua, ou um convite de alguém que tenha uma. Não há mais lista de proxies gratuitas, e isso é de propósito — ver [O que mudou, e por quê](#o-que-mudou-e-por-quê).

## Índice

- [Antes de instalar](#antes-de-instalar): o que você precisa ter
- [Instalação](#instalação): um script faz o resto
- [Configuração](#configuração)
- [Uso](#uso)
- [Conferindo que funcionou](#conferindo-que-funcionou)
- [Solução de problemas](#solução-de-problemas)
- [O que mudou, e por quê](#o-que-mudou-e-por-quê)
- [Avisos importantes](#avisos-importantes)

---

## Antes de instalar

**Windows.** Linux e macOS estão de fora por enquanto — o túnel usa o [WireSock](https://www.wiresock.net), que é Windows. O instalador de Linux recusa em vez de instalar algo que não vai funcionar.

**Discord para computador**, com Equicord ou Vencord injetado. Vesktop e Equibop não são suportados: eles trazem o mod embutido e não carregam de um checkout. Não funciona no navegador nem na extensão.

**Um convite para uma saída.** É o único item que o instalador não consegue arranjar sozinho.

- Se alguém que você conhece já opera uma saída, peça um convite a essa pessoa.
- Se você quer montar a sua, o passo a passo está em [`provisionamento/README.md`](provisionamento/README.md). Uma VPS pequena fora do Brasil dá conta; a do projeto é uma Oracle Cloud em Santiago, que é grátis e fica perto.

**Quem assiste também precisa.** Isso é novidade e é a parte que mais surpreende: não basta quem transmite estar fora do Brasil. Quem assiste também é verificado. Um amigo sem túnel vai ver tela preta na sua transmissão mesmo com tudo certo do seu lado.

---

## Instalação

Baixe o instalador da [última release](https://github.com/EduardoVasconceloss/StreamFix/releases/latest) e execute. Ele acha o seu Equicord ou Vencord (ou baixa um), instala o WireSock se faltar, mede o MTU da sua rede, troca o convite por um endereço na saída, escreve o perfil, compila e abre o Discord funcionando.

A única coisa que ele pergunta e você precisa ter em mãos é o **convite**.

```powershell
# terminal, se preferir
.\StreamFix-Installer.ps1

# apontando para uma saída que não é a padrão
.\StreamFix-Installer.ps1 -ExitUrl "http://SEU.IP:8787/registrar" -ExitKey "<a pública da saída>"
```

`-ExitKey` é a chave pública da saída. Ele não é obrigatório, mas vale a pena: o registro vai por HTTP puro, e essa chave é o que impede alguém no meio do caminho de devolver a *própria* saída e levar a sua mídia junto. Quem te mandou o convite pode te mandar ela também.

**Uma senha do Windows vai aparecer uma vez**, na instalação do WireSock. É o UAC do próprio instalador dele. O StreamFix não se eleva sozinho — se elevasse, a compilação rodaria como administrador e deixaria na pasta do mod arquivos que a sua conta não conseguiria apagar depois.

### Se a instalação parar no meio

Você fica **sem plugin**, não com um plugin ligado e sem túnel. Isso é de propósito: o túnel é montado antes do plugin, e ativar o plugin é o último passo de todos. Um estado pela metade que *parece* pronto é pior do que nenhum estado. Rode de novo.

---

## Configuração

Nas settings do plugin:

- **Exigir túnel** (padrão: ligado). Bloqueia o Go Live quando a mídia não está saindo pela sua saída, e diz o motivo na hora do clique. Sem isso o Discord recusa a transmissão do mesmo jeito — o que muda é onde você descobre. Com ele, você descobre no clique; sem ele, pelo amigo dizendo "tá preta".

- **Perfil do túnel** (padrão: `streamfix-santiago`). O nome do perfil no WireSock. O instalador escreve; só mude se você renomeou o perfil.

- **Endereço da saída**. O `host:porta` da sua saída. É contra ele que o plugin confere o que o Discord reporta, então um valor errado aqui recusa transmissão boa. O instalador preenche com o que a saída respondeu.

- **Túnel permanente** (padrão: ligado). Deixa o túnel de pé o tempo todo. Ligado é o certo para quem transmite: subir e descer o túnel no meio de uma call é o que derruba conexão do Discord. **Se você só assiste**, desligue — aí o túnel sobe só quando você entra numa transmissão e cai dez segundos depois, e o resto da sua call fica na latência normal.

- **Voice region** / **Stream region**. Preferência de região, não ordem — o Discord pode ignorar. Padrão: `Automatic`.

  > [!CAUTION]
  > Cuidado ao forçar `brazil`. Há indício de que o servidor de mídia brasileiro é justamente onde a transmissão é recusada.

---

## Uso

1. Abra o Discord. Se **Túnel permanente** está ligado, o túnel sobe junto.
2. Entre na call e use Go Live ou a câmera.
3. Para **assistir** a transmissão de alguém, é só clicar. Se o túnel não estiver de pé, o plugin avisa, sobe ele e te coloca lá — um clique a mais, nenhuma espera longa.

**Enquanto você transmite, o plugin vigia.** Se a entrega morrer, ele avisa que a transmissão precisa ser recriada — e distingue isso de o problema ser local (a captura de tela parou), que é o caso em que recriar não adianta.

**O custo.** A call inteira passa a ~80 ms em vez dos ~35 ms diretos, porque o túnel leva o processo do Discord inteiro, não só a transmissão. É perceptível e é o preço de funcionar.

---

## Conferindo que funcionou

Duas metades, medidas de lugares diferentes de propósito.

**A mídia sai pela saída?** No Discord, entre numa call e digite `/streamfix`. Na seção `== tunel ==`, o campo **"o Discord diz"** tem que ser o endereço da sua saída. Essa leitura vem de dentro do motor de mídia, que é a única que não mente.

**O resto da máquina continua saindo pelo seu IP?** Rode:

```powershell
.\Verifica-Tunel.ps1
```

Ele confere que um processo que **não** é o Discord continua saindo pelo seu IP de sempre. Esse teste existe porque o pior modo de falha deste projeto é o túnel levar a máquina inteira sem ninguém notar: tudo continua parecendo funcionar, e todo o seu tráfego passa a sair por outro país sem você ter pedido.

---

## Solução de problemas

**"Imagem Incompleta" ou erro `0xc0000127` ao instalar.** O `wiresock-connect-cli` é um programa .NET, e a instalação do .NET da sua máquina está quebrada — ele nem chega a iniciar. Instale o **.NET Desktop Runtime 10**, versão x64, em [dotnet.microsoft.com/download/dotnet/10.0](https://dotnet.microsoft.com/download/dotnet/10.0); instale por cima mesmo que já exista, porque isso grava um host novo. Não é problema do StreamFix, mas nada dele funciona até você resolver isso.

**"A mídia está saindo por X, e não pela saída Y"** ao clicar em Go Live. O túnel não está carregando a mídia. Confira com `/streamfix`; se o WireSock disser "conectado" e o Discord disser outro endereço, reinstale o perfil.

**"O túnel do StreamFix não está de pé."** O plugin tenta subir sozinho em segundo plano. Clique de novo em alguns segundos.

**"Não consegui subir o túnel"** ao entrar numa transmissão. O WireSock não conectou. Veja se a saída está no ar e se o seu perfil ainda existe (`wiresock-connect-cli list`).

**A transmissão sobe e morre.** O monitor avisa quando isso acontece. Pare e comece de novo — a sessão precisa ser recriada; não adianta esperar.

**Seus amigos veem tela preta.** Eles precisam de túnel também. Mande um convite.

**"O convite não existe"** / **"foi revogado"** / **"já foi usado o número máximo de vezes"**. Peça outro a quem opera a saída.

**"A saída aceitou você mas não conseguiu ligar o WireGuard."** Problema do lado da saída, não seu. Avise quem a opera.

**O túnel diz "conectado" e mesmo assim nada funciona.** É o caso mais confuso, e tem ferramenta própria — dois cliques no `Diagnostico-Tunel.bat`:

```powershell
Diagnostico-Tunel.bat
```

Ele confere de uma vez a camada que intercepta (os serviços e o driver do WireSock), qual Discord está rodando, o que o WireSock de fato aceitou no túnel, e por onde sai um processo que não é o Discord. As duas causas já vistas para esse sintoma são o driver do WireSock precisar de um **reinício do computador** para valer, e o túnel ter sido montado para um cliente diferente do que você usa.

> Rode pelo `.bat`. O `.ps1` direto falha com *"não está assinado digitalmente"* na maioria das máquinas — o `.bat` contorna isso só para aquele processo, sem mudar nada no seu Windows.

Para qualquer outra coisa: `/streamfix` copia um diagnóstico completo para você colar. **Ele não contém token nem chave privada.**

---

## O que mudou, e por quê

<details>
<summary><strong>A história técnica</strong> (clique para expandir)</summary>

### As duas travas

**Trava 1: o cliente se auto-bloqueia.** O Discord embarca um experimento que desliga vídeo; quando ele te atinge, os botões de câmera e Go Live somem sozinhos.

Versões antigas do plugin desarmavam isso. **A atual não desarma, de propósito.** Com o túnel de pé, o cliente enxerga IP estrangeiro e o guarda nem engata — desarmar é inútil. Sem o túnel, desarmar é *nocivo*: remove o único aviso que sobraria e deixa você subir uma transmissão que vai ser recusada. Ele trabalhava contra o porteiro.

**Trava 2: o servidor recusa.** Até 3 de setembro de 2026 essa decisão era tomada uma única vez, na entrada do canal de voz, a partir do IP do WebSocket de gateway, e nunca reavaliada. Era isso que fazia proxy de gateway funcionar: um socket só precisava sair do Brasil.

O Discord estendeu a verificação ao **plano de mídia**. Agora o IP que entrega a mídia também é verificado — nas duas pontas, de quem transmite e de quem assiste.

### Por que túnel, e não proxy

A mídia do Discord é UDP. Proxy SOCKS não carrega UDP de forma utilizável aqui, e o `session.setProxy` do Electron não alcança o plano de mídia de jeito nenhum. Um túnel de rede alcança.

E por que **split tunnel**: mandar a máquina inteira por uma VPS resolveria e cobraria caro — todo o seu tráfego, toda a sua navegação, toda a sua franquia. O `#@ws:AllowedApps` do WireSock deixa dizer "só o Discord". É a diferença entre uma ferramenta e um problema.

### O que morreu junto

A proxy de gateway, o roteamento SOCKS, o PAC, a lista de proxies públicas e a saída pelo Tor. Com eles morreu também o defeito de privacidade que o projeto carregava: não há mais um desconhecido no meio do seu gateway, porque não há mais terceiro. Quem vê o seu tráfego agora é quem opera a saída — que é você, ou alguém que você escolheu.

### Como se sabe que funciona

Medido em 11 de setembro de 2026, com o túnel de pé:

- o Discord reportou `159.112.151.37` (Santiago) como endereço local da conexão de mídia, lido de dentro do motor de mídia;
- um processo que não é o Discord, na mesma máquina e no mesmo minuto, saiu por `177.42.223.136` (Brasil).

O split tunnel faz o que promete. O `Verifica-Tunel.ps1` roda a segunda metade desse teste na sua máquina.

</details>

---

## Avisos importantes

- **Quem opera a saída vê o seu tráfego do Discord.** Menos do que parece, porque vai dentro de TLS, mas é real. Aceite um convite de quem você confiaria com isso.
- **Usar clientes modificados viola os Termos de Serviço do Discord.** Contornar a restrição de região também pode violar. O risco de punição é baixo, mas existe. Considere uma conta secundária.
- **O túnel leva o processo do Discord inteiro**, não só a transmissão — é o que o WireSock sabe separar. Então a sua call inteira paga a latência da saída.
- **Só Windows por enquanto.** Linux e macOS voltam quando o túnel ganhar uma implementação com `wg-quick`.
- O plugin **não te deixa sem Discord**. Se a verificação dele falhar por qualquer motivo, ele libera e avisa, em vez de travar a transmissão.

---

## Estrutura

```
streamFix/
├── index.tsx                      # renderer: o porteiro do Go Live, o fluxo de assistir,
│                                  #   o monitor, o seletor de região, o /streamfix
├── native.ts                      # processo principal: ponte fina para o WireSock
└── tunnel/
    ├── porteiro.ts                # decide se a transmissão vale a pena subir
    ├── entrada.ts                 # decide o que fazer ao entrar numa transmissão alheia
    ├── controle.ts                # sobe e derruba o túnel, e confere que subiu só o Discord
    ├── perfil.ts                  # gera o .conf e mede o MTU do caminho
    ├── coletor.ts                 # traduz o que o Discord reporta em amostras
    ├── monitor.ts                 # decide se a transmissão está viva pelas amostras
    └── observador.ts              # o laço que amostra enquanto há transmissão no ar

provisionamento/                   # o lado da saída -- ver o README de lá
├── servidor.mjs                   # troca convite por endereço, chama o wg set
├── convites.mjs                   # a ferramenta de quem administra
├── registro.ts                    # as decisões, puras e testadas
└── chaves.ts / cliente.ts         # geração de chaves e o cliente do registro

installer/
├── StreamFix-Installer.bat        # Windows: dois cliques
├── StreamFix-Installer.ps1        # Windows: terminal
├── StreamFix-Installer-GUI.ps1    # Windows: janela
├── Verifica-Tunel.ps1             # confere que o túnel leva só o Discord
├── Diagnostico-Tunel.ps1          # por que o túnel está de pé e nada passa por ele
├── Diagnostico-Tunel.bat          # o mesmo, com dois cliques
├── provisiona.mjs                 # mede MTU, gera chave, troca o convite, escreve o perfil
└── streamfix-installer.sh         # Linux: recusa, por enquanto
```

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para rodar o projeto localmente, e [LICENSE](LICENSE) para os termos (GPL-3.0-or-later).

---

StreamFix é um fork de [bezumiya/GoLiveBypass](https://github.com/bezumiya/GoLiveBypass); o suporte a flatpak vem do trabalho de [gabrigode](https://github.com/gabrigode). <!-- instalador automático originalmente por Vithor (https://github.com/Vith0r) -->

<details>
<summary><strong>English summary</strong> (click to expand)</summary>

StreamFix is an Equicord/Vencord plugin, made by a Brazilian developer, that restores Go Live and camera for Brazilian Discord users. It routes **only Discord** through a WireGuard split tunnel that exits outside Brazil; everything else on the machine keeps using your normal connection.

**This changed on 2026-09-03.** Discord's region gate used to be evaluated once, at voice-channel join, from the gateway WebSocket origin IP, and never re-evaluated — so routing that single socket through a proxy was enough. Discord extended the check to the **media plane**, on both ends. Gateway proxying stopped working: streamers saw their stream come up and die, viewers saw a black screen.

Media is UDP, which SOCKS cannot usefully carry and Electron's `session.setProxy` cannot reach at all. A network tunnel can. The split is what keeps it a tool instead of a problem: WireSock's `#@ws:AllowedApps` directive limits the tunnel to Discord, so your browsing, your bandwidth cap, and your other traffic stay untouched.

**You need an exit outside Brazil** — your own small VPS, or an invite from someone who runs one. There is no free-proxy list any more, and that is deliberate: it also removed the privacy defect the project used to carry, since there is no third party in the middle now. **Viewers need a tunnel too**, which is the part that surprises people: a friend without one sees a black screen no matter what you do.

Measured on 2026-09-11, tunnel up: Discord reported `159.112.151.37` (Santiago) as the local address of its media connection, read from inside the media engine, while a non-Discord process on the same machine in the same minute exited via `177.42.223.136` (Brazil). `Verifica-Tunel.ps1` runs the second half of that check on your machine — it exists because the worst failure mode here is the tunnel quietly taking the *whole* machine, which looks exactly like success.

- Windows only for now (WireSock). Linux and macOS return when the tunnel gets a `wg-quick` implementation; the Linux installer refuses rather than installing something that cannot work.
- Desktop Discord with Equicord or Vencord injected. Vesktop and Equibop are not supported by the installers, since they bundle the mod instead of loading it from a checkout.
- The installer does everything in one pass: installs WireSock if missing, measures your path MTU, trades the invite for an address on the exit, writes the profile, builds and injects. The tunnel is set up **before** the plugin is enabled, so an interrupted install leaves you with no plugin rather than a plugin that looks ready and is not.
- The installer does not self-elevate. Measured: every WireSock CLI operation it needs works unelevated; only installing WireSock requires admin, and winget raises that prompt itself.
- The whole Discord process goes through the tunnel, so your call pays the exit's latency (~80 ms vs ~35 ms direct). If you only ever watch, turn off **Túnel permanente** and the tunnel comes up only while you join a stream.
- Whoever runs the exit can see your Discord traffic. Accept an invite from someone you would trust with that.
- Using modified clients violates Discord's ToS, and bypassing the region restriction may as well. Use at your own risk.
- It cannot leave you unable to stream: if the plugin's own check fails for any reason, it allows the stream and warns, rather than blocking.
- StreamFix started as a fork of **[bezumiya/GoLiveBypass](https://github.com/bezumiya/GoLiveBypass)**, created by bezumiya ([Twitter](https://twitter.com/obezumiya), Discord `1366453661970071633`). Installer originally by [Vithor](https://github.com/Vith0r).
- License: GPL-3.0-or-later.

</details>
