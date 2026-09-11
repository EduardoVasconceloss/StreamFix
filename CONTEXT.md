# StreamFix

Plugin de Equicord/Vencord que devolve o Go Live e a câmera no Discord para quem está no Brasil, mais os instaladores que o colocam no lugar. Este arquivo é o glossário do projeto: define os termos, não como as coisas funcionam.

## Language

### O plugin

**StreamFix**:
O plugin em si, os arquivos em `streamFix/`. É o produto; todo o resto existe para colocá-lo no lugar.
_Avoid_: GoLiveBypass (nome antigo, sobrevive só como diretório legado a migrar)

**Bypass**:
Fazer o Discord tratar a sessão como se ela não viesse do Brasil, que é a condição para o Go Live liberar. Exige as duas pontas: quem transmite e quem assiste.
_Avoid_: contorno, gambiarra

**Saída**:
O ponto por onde o tráfego deixa a rede e ganha um país de origem aos olhos do Discord. É um parâmetro, não um lugar fixo: pode ser a VPS do grupo, uma VPN de terceiro ou a de outra pessoa.
_Avoid_: nó de saída, exit node, IP, servidor

**Túnel**:
O WireGuard que leva o tráfego do Discord até a saída. Substituiu a proxy: o gate olha o IP da mídia UDP, e proxy SOCKS não move mídia.
_Avoid_: VPN (uma VPN leva a máquina inteira; o túnel leva só o Discord), proxy

**Gate**:
A verificação de região que o Discord passou a aplicar ao plano de mídia em 03/09/2026. Avalia o IP de quem transmite quando a sessão de entrega nasce, e o de quem assiste quando essa pessoa entra.
_Avoid_: bloqueio, trava (a Trava 1 é outra coisa: é o cliente escondendo o botão)

**Entrega**:
O vídeo efetivamente saindo da máquina de quem transmite e chegando a quem assiste. É o que o gate concede ou recusa, e é medida por contadores — não por a transmissão "estar no ar", que continua verdade mesmo quando a entrega foi recusada.
_Avoid_: stream, transmissão (a transmissão existe; a entrega é que pode estar morta)

**Espectador**:
Quem assiste a uma transmissão. Deixou de ser detalhe e virou parte do produto: sem a saída dele fora do Brasil, a entrega é recusada na entrada.

### O mod

**Mod**:
O Equicord ou o Vencord, o cliente modificado que hospeda plugins de usuário. Usado quando tanto faz qual dos dois.
_Avoid_: client mod, cliente modificado, Vencord (quando o que se quer dizer é "qualquer um dos dois")

**Checkout**:
A pasta com o código-fonte do mod, de onde o StreamFix é compilado. Plugins de usuário só existem compilando do fonte, então sempre há um. Nas telas do instalador aparece com o rótulo "Fonte", que é o mesmo conceito em linguagem de usuário final.
_Avoid_: repo, pasta do mod, source

**Injeção**:
Substituir o `app.asar` do Discord por um stub que carrega o build do mod. Quem faz é sempre o instalador do mod, nunca o nosso.
_Avoid_: patch, hook, mod do Discord

**Stub**:
O arquivo pequeno deixado no lugar do `app.asar` original, que só faz `require` da pasta de build do mod. É por ele que o instalador do StreamFix descobre qual checkout o Discord está carregando.

**Resources**:
O diretório do Discord que contém o `app.asar`, alvo da injeção. Onde ele fica muda por plataforma e por forma de empacotamento, e achá-lo é o grosso da descoberta.

### Os três instaladores

Três coisas diferentes se chamam "instalador" neste domínio. O termo sozinho é ambíguo e não deve ser usado.

**Instalador do StreamFix**:
O nosso, os arquivos em `installer/`. Encontra o mod, copia o plugin, compila, manda injetar e liga o plugin nas settings.
_Avoid_: o instalador, o script

**Instalador do mod**:
O Equilotl (no Equicord) ou o Vencord Installer (no Vencord). É ele, e só ele, que executa a injeção. Existe em dois builds, GUI e CLI, que não são intercambiáveis: só o CLI lê flags de linha de comando.
_Avoid_: Equilotl (quando o que se quer dizer serve para os dois)

**Wrapper de injeção**:
O `scripts/runInstaller.mjs` de dentro do checkout, que o `pnpm inject` chama. Baixa o instalador do mod e o executa. Escolhe qual build baixar por plataforma, e é essa escolha que faz o `pnpm inject` servir no Linux e no Windows mas não no macOS.

### Instalação

**Descoberta**:
A fase em que o instalador do StreamFix acha, sem perguntar nada, os Discord instalados e o checkout do mod. É a única parte que muda de verdade entre os sistemas operacionais.

**Modo permanente**:
O Discord continua abrindo com o mod até alguém desfazer.

**Modo temporário**:
A injeção vale só naquela sessão: quando o Discord fecha, o instalador do StreamFix a desfaz sozinho. Só é oferecido onde ele consegue mesmo desfazer sem intervenção.
