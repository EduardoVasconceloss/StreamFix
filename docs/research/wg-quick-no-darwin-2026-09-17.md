# O contrato do `wg-quick` no Darwin

Medição de 17/09/2026, para escrever a implementação de `Controle` que o macOS precisa. Fonte: o
workflow `.github/workflows/medir-wg-quick-darwin.yml`, rodado num runner `macos-latest`
(`wireguard-tools v1.0.20260223`, Homebrew em `/opt/homebrew`). Execução:
[35180646736](https://github.com/EduardoVasconceloss/StreamFix/actions/runs/35180646736).

Existe pelo mesmo motivo que o spike do WireSock de 11/09: cada decisão do `streamFix/tunnel/controle.ts`
é apoiada numa medição, e as três que o governam — código de saída que não vale nada, saída de
texto traduzida, split tunnel reportado só no log do `connect` — são invisíveis na documentação e
óbvias na execução. O `wg-quick` tem o seu próprio conjunto, e quatro dos achados abaixo derrubam
premissas que eu teria escrito sem medir.

**O que esta medição não alcança**, e que só o Mac de uma pessoa alcança: Discord, Go Live,
latência real, se o gate aceita a mídia, e se a regra restrita de sudoers de fato recusa o que não
autorizou (no runner o usuário já tem `NOPASSWD: ALL`, então lá tudo passa). Para isso existe o
`docs/research/medir-no-mac.sh`.

---

## 1. O nome do perfil não pode passar de 15 caracteres

Foi o que derrubou a primeira execução. O `wg-quick up streamfix-santiago-controle` respondeu

```
wg-quick: `streamfix-santiago-controle' does not exist
```

**com o arquivo presente em `/etc/wireguard/`.** A causa está no próprio script, linha 49:

```bash
if [[ $CONFIG_FILE =~ ^[a-zA-Z0-9_=+.-]{1,15}$ ]]; then
```

Um nome maior nem chega a ser procurado nos `CONFIG_SEARCH_PATHS` — cai direto no `does not
exist`, e a mensagem aponta para o lugar errado. Medido:

| nome | tamanho | cabe? |
|---|---|---|
| `streamfix-santiago` | 18 | **não** |
| `streamfix-santiago-controle` | 27 | **não** |
| `streamfix` | 9 | sim |
| `streamfix-ctl` | 13 | sim |

**Consequência.** Os dois nomes de produção estão fora, e o `perfilDeControle()` de `perfil.ts`,
que só acrescenta `-controle`, consome 9 dos 15 sozinho. O macOS precisa do seu próprio esquema de
nomes, e o sufixo de controle precisa ser curto. Candidatos usados no resto da medição: `streamfix`
e `streamfix-ctl`.

Os caminhos varridos, na ordem (linha 44):
`/etc/wireguard`, `/usr/local/etc/wireguard`, `/opt/homebrew/etc/wireguard`. Quando não acha, a
mensagem de erro nomeia o **último** deles, não o primeiro — o que confunde na leitura.

## 2. `wg show <perfil>` não resolve o nome do perfil no Darwin

Esta era a pergunta central, e a resposta é **não**:

```
--- wg show <perfil>: o nome resolve? ---
Unable to access interface: No such file or directory
exit=1
```

com o túnel de pé. O mapeamento existe — o `wg-quick` grava `/var/run/wireguard/streamfix-ctl.name`
com o conteúdo `utun4` — mas o `wg` não o consulta. O `wg show interfaces` devolve `utun4`, o nome
da interface, nunca o do perfil.

**Consequência, e é estrutural.** Todo o `controle.ts` de hoje pergunta pelo nome do perfil, e o
`contemPerfil()` existe justamente porque o WireSock repete esse nome na resposta. No Darwin não há
nome de perfil em resposta nenhuma: o controle precisa **resolver o perfil para o `utunN` antes de
qualquer pergunta**, lendo o `.name`. Com dois perfis no ar, `wg show interfaces` devolve
`utun4 utun5` e não diz qual é qual — sem ler os `.name` não dá para saber.

## 3. Qualquer leitura de estado precisa de root

Esta derruba o desenho de privilégio que eu tinha proposto.

```
cat: /var/run/wireguard/streamfix-ctl.name: Permission denied
wg show all allowed-ips   -> Unable to access interface utun4: Permission denied
wg show all latest-handshakes -> Unable to access interface utun4: Permission denied
```

O `.name` é `-r-------- root daemon` e o socket de controle é `srwx------ root daemon`. Ou seja,
**não é só `up` e `down` que precisam de privilégio — `wg show` também**, e o `.name` idem.

**Consequência.** A regra de sudoers que eu propus, liberando só `wg-quick up` e `wg-quick down`,
**não basta**: o plugin ficaria sem conseguir responder "o túnel está de pé?", que é a pergunta que
o porteiro faz a cada clique de Go Live. A regra precisa liberar também a leitura. E `wg show` é um
comando de leitura, então liberá-lo é muito mais barato em risco do que liberar `up`/`down` — mas
precisa ser listado.

## 4. `up` dar certo não significa túnel de pé

Confirmado, e é a diferença estrutural entre os dois CLIs. Com `Endpoint = 192.0.2.1:51820`
(TEST-NET-1, RFC 5737, garantidamente sem ninguém do outro lado), o `wg-quick up` devolveu **0** e
montou a interface inteira:

```
[#] wireguard-go utun
[+] Interface for streamfix-ctl is utun4
[#] wg addconf utun4 /dev/fd/63
[#] ifconfig utun4 inet 10.8.0.2/32 10.8.0.2 alias
[#] ifconfig utun4 mtu 1380
[#] ifconfig utun4 up
[#] route -q -n add -inet 1.1.1.1/32 -interface utun4
[#] route -q -n add -inet 162.159.128.0/17 -interface utun4
exit=0
```

O `wiresock-connect-cli connect` bloqueia até o handshake fechar — e é por isso que o controle atual
tem `PRAZO_CONEXAO_MS`, senão o porteiro congela. O WireGuard não tem conexão: o `up` configura a
interface e volta na hora, com ou sem peer vivo do outro lado.

**Consequência.** O `subir` do controle de wg-quick tem de conferir o handshake por conta própria
(`wg show <utunN> latest-handshakes`, esperando sair de `0`), que é uma verificação que o lado
WireSock ganhava de graça. Em compensação, **não precisa de prazo de conexão**: nada aqui bloqueia.

Não deu para medir o `latest-handshakes` nesta execução por causa do achado 3 (permission denied).
Fica para a próxima, com `sudo`.

## 5. O `0.0.0.0/0` não mexe na rota padrão — e sai limpo

Esta é a boa notícia, e ela desarma a minha preocupação com o churn de rotas a cada empréstimo.

O `wg-quick` não substitui a `default`. Ele usa o truque clássico das duas metades, e acrescenta uma
rota `/32` para o endpoint pelo gateway real (senão o próprio tráfego do túnel entraria no túnel):

```
[#] route -q -n add -inet 0.0.0.0/1 -interface utun4
[#] route -q -n add -inet 128.0.0.0/1 -interface utun4
[#] route -q -n add -inet 192.0.2.1 -gateway 192.168.64.1
```

Na tabela, com o completo no ar, `default` continua intacta apontando para `en0`, e `0/1` e `128.0/1`
passam na frente por serem mais específicas. Depois do `down`, a tabela voltou **exatamente** ao
estado anterior — nenhuma rota órfã.

**Consequência.** O custo do `0.0.0.0/0` por segundos é bem menor do que eu supus ao apresentar as
opções. Conexões existentes de outros aplicativos podem sofrer com a mudança de caminho, mas a
tabela não fica suja e não há janela em que a máquina perca rota.

## 6. Dois perfis podem estar no ar ao mesmo tempo

```
--- os dois perfis ao mesmo tempo? ---
[+] Interface for streamfix-ctl is utun5
exit=0
utun4 utun5
```

O WireSock recusa: medido em 11/09, `connect` com outro perfil de pé responde "outra conexão já está
em andamento", e é por isso que o `trocar()` do `controle.ts` **tem** que derrubar antes de subir —
deixando um buraco entre os dois comandos, que o gateway do Discord sobrevive por sorte de desenho
(mesmo endereço de túnel, mesma saída).

No Darwin não há esse buraco. Dá para subir o novo e só então derrubar o velho.

**Consequência.** O `trocar` do macOS pode ser mais seguro que o do Windows, não menos: sem instante
nenhum sem túnel. Como as duas interfaces coexistem, quem decide o tráfego é a especificidade da
rota — o completo (`0/1` + `128.0/1`) ganha do controle (`162.159.128/17`) para os destinos fora da
faixa de controle, e perde dentro dela, o que não muda nada porque os dois saem pela mesma VPS.
Isso precisa ser confirmado com tráfego real no Mac de alguém.

## 7. A troca é rápida

Ciclo completo `controle -> completo -> controle` (quatro operações de `wg-quick`):

| ciclo | tempo |
|---|---|
| 1 | 461 ms |
| 2 | 607 ms |
| 3 | 367 ms |

No Windows, **uma** troca custa ~1,25 s (medido em 12/09). Quatro operações aqui custam menos que
uma lá. O empréstimo de segundos sai mais barato no macOS do que no Windows.

## 8. A regra de sudoers é sintaticamente válida

```
/etc/sudoers.d/streamfix: parsed OK
```

e o comando autorizado roda com `sudo -n`. Que ela **recuse** o resto não deu para medir: o runner
dá `(ALL) NOPASSWD: ALL` ao usuário `runner`, que ofusca a nossa regra. Fica para o `medir-no-mac.sh`.

---

## O que isto decide para o `controle-wg.ts`

1. Esquema de nomes próprio do macOS, com no máximo 15 caracteres (achado 1).
2. Toda operação começa resolvendo perfil → `utunN` pelo `.name`, com privilégio (achados 2 e 3).
3. A regra de sudoers precisa cobrir leitura, não só `up`/`down` (achado 3).
4. `subir` confere o handshake; não precisa de prazo de conexão (achado 4).
5. `trocar` sobe antes de derrubar, sem buraco (achado 6).
6. Sem `AllowedApps`: a asserção equivalente — conferir o que o túnel de fato aplicou, que é a lição
   mais cara do projeto — passa a ser `wg show <utunN> allowed-ips` contra o que o perfil pedia.

## O que continua em aberto

- **Para onde vai o UDP da mídia do Discord.** Medido em 11/09 que não está em `162.159.128.0/17`;
  nunca medido para onde vai. É o que decide se o macOS pode cortar por destino em vez de por tempo,
  e provavelmente melhora o Windows junto. Instrumento: `medir-no-mac.sh`, parte 1.
- **`latest-handshakes` com privilégio**, que esta execução não alcançou.
- **Se a regra restrita de sudoers recusa o resto**, numa conta comum.
- **Se as duas interfaces coexistindo se comportam como a especificidade das rotas promete**, com
  tráfego real.

---

# Adendo: a primeira execução num Mac de verdade (20/09/2026)

MacBook Pro, macOS 26.5.1, arm64, conta de administrador comum. Três achados, e o primeiro
**invalidava o porte inteiro** — nenhum deles era alcançável pelo runner de CI.

## 9. O `wg-quick` exige bash 4+, e o macOS traz o 3.2

```
--- wg-quick up ---
wg-quick: Version mismatch: bash 3 detected, when bash 4+ required
exit=1
```

Todas as operações de túnel falharam. A Apple parou no bash 3.2 por licença (GPLv2), e quem tem
um bash moderno no Mac é o Homebrew.

**Por que a medição no CI passou.** O runner do GitHub já tem o bash do Homebrew no `PATH`, então
lá o `#!/usr/bin/env bash` do `wg-quick` encontrava um bash 5 e tudo subia. Num Mac comum, sob
`sudo`, o `PATH` é higienizado e o `env bash` acha o `/bin/bash` 3.2 da Apple.

O modo de falha existe **só** na combinação "Mac de verdade + sudo" — que é exatamente a
combinação em que o StreamFix roda. É a justificativa mais forte que este projeto tem para não
tratar CI como substituto de hardware real.

**Consequência.** O `wg-quick` nunca é chamado direto: sempre por um interpretador absoluto
(`BASH4_PADRAO` em `controle-wg.ts`, `wgq()` no instalador). A regra de sudoers precisa listar o
interpretador também, senão o `sudo` vê um comando diferente do autorizado e volta a pedir senha
no clique do Go Live. O instalador instala o bash pelo Homebrew se faltar, sem tocar no da Apple.

## 10. O socket de voz do Discord não é conectado

```
COMMAND    PID   USER   FD   TYPE   DEVICE  SIZE/OFF NODE NAME
Discord   1350 prodwb   39u  IPv4   0xd9b…       0t0  UDP *:49965
```

`UDP *:49965`, sem `->`. O Discord usa `sendto`/`recvfrom` com o endereço explícito em cada
pacote, em vez de `connect()`. **A premissa da parte 1 do `medir-no-mac.sh` estava errada**: o
`lsof` nunca revelaria o destino, por mais que se insistisse nele.

O que o `lsof` dá é a **porta local**, e com ela dá para fazer a captura mais estreita possível —
`tcpdump -q -s 64` filtrado naquela porta, por 8 segundos, cabeçalhos apenas. É o que o script
faz agora.

**A faixa da mídia continua sem medição**, e é o que falta para decidir se o macOS pode cortar
por destino em vez de por tempo.

## 11. O teste da regra de sudoers precisa de `sudo -k`

```
--- o NAO autorizado tem de ser RECUSADO ---
outro comando:
.CFUserTextEncoding
.forward
Library
exit=0
```

Um comando fora da regra passou. Não porque a regra falhou: o `sudo` ainda tinha o **cache da
senha** digitada minutos antes, e com o cache válido o `-n` passa em qualquer coisa que a conta
possa fazer.

E há uma segunda coisa que essa saída mostra, e que vale dizer com todas as letras:

```
User prodwb may run the following commands:
    (ALL) ALL
    (root) NOPASSWD: /opt/homebrew/bin/wg-quick up sfx-medicao, …
```

Numa conta de administrador do macOS — que é a conta da maioria das pessoas — o usuário **já
tem `(ALL) ALL`**, com senha. A nossa regra não reduz privilégio nenhum: o que ela faz é
dispensar a senha, e apenas para aqueles comandos. Essa é a descrição honesta dela, e é a que o
README usa.

O `sudo -k` antes do teste é o que torna a pergunta "esta regra recusa o resto?" respondível.
Fica para a próxima execução.

---

# Adendo 2: a medição que fechou as duas perguntas (20/09/2026, 20h46)

Mesma máquina do adendo 1, agora com o script corrigido. **As duas perguntas que estavam abertas
desde 11/09 foram respondidas.**

## 12. A mídia do Discord sai pela Cloudflare, em `104.16.0.0/12`

O achado que o projeto perseguia desde 11/09. Captura filtrada na porta de voz do Discord:

```
20:46:50.497512 IP 104.29.142.186.19313 > 192.168.15.6.49871: UDP, length 216
20:46:50.618942 IP 192.168.15.6.49871 > 104.29.142.186.19313: UDP, length 60
```

e o `whois` do destino:

```
NetRange:       104.16.0.0 - 104.31.255.255
CIDR:           104.16.0.0/12
NetName:        CLOUDFLARENET
OrgName:        Cloudflare, Inc.
```

Duas coisas de uma vez:

1. **A mídia é Cloudflare, e não a Cloudflare do controle.** O perfil de controle leva
   `162.159.128.0/17`; a mídia está em `104.16.0.0/12`. São blocos diferentes da mesma empresa, e
   é por isso que o perfil de controle nunca carregou mídia — o que 11/09 tinha medido pelo
   efeito (~9 KB em 20 s) e nunca pela causa.

2. **A faixa é larga demais para servir de `AllowedIPs`.** `104.16.0.0/12` é um dos blocos
   principais da Cloudflare, por onde passa uma fração enorme da web. Mandá-lo inteiro pelo túnel
   não seria "só o Discord": seria boa parte da internet, e de forma permanente em vez de por
   segundos.

**Consequência: o corte por tempo fica.** A decisão de 17/09 estava certa, e agora está medida em
vez de suposta. Estreitar para algo como `104.29.142.0/24` foi considerado e recusado: é **uma**
amostra, de **uma** região, e uma lista curta aparece como transmissão recusada — o modo de falha
que este projeto existe para evitar. Reabrir isso exigiria amostras de várias regiões e de vários
dias, e o ganho seria pequeno diante do risco.

Fica registrado para quem vier depois: se a Cloudflare publicar um bloco dedicado a `discord.media`,
ou se o Discord voltar a servir mídia de faixa própria, o corte por destino volta à mesa.

## 13. A regra restrita de sudoers recusa o resto — medido

A pergunta que o CI não podia responder, agora com `sudo -k` antes:

```
User prodwb may run the following commands:
    (ALL) ALL
    (root) NOPASSWD: /opt/homebrew/bin/bash /opt/homebrew/bin/wg-quick up sfx-medicao, …

--- o AUTORIZADO tem de passar sem senha ---
exit=0
--- o NAO autorizado tem de ser RECUSADO ---
outro perfil:  sudo: a password is required   exit=1
outro comando: sudo: a password is required   exit=1
```

O autorizado passa sem senha; um perfil de outro nome e um comando qualquer são recusados. A
regra faz exatamente o que promete.

Continua valendo a ressalva do adendo 1: numa conta de administrador o usuário **já tem
`(ALL) ALL`** com senha. A regra não reduz privilégio — ela dispensa a senha, e só para aqueles
comandos.

## 14. `wg show <utunN> …` responde em DUAS colunas, não três

Com privilégio, finalmente deu para ver o formato:

```
--- allowed-ips aplicados, perguntando pelo utun4 ---
TCYzWJaqlq5rgtNBtMeeCAnGS4FYQ/Z/pXnl98ho1zw=    192.0.2.0/24
--- handshake (endpoint reservado: tem de ser 0) ---
TCYzWJaqlq5rgtNBtMeeCAnGS4FYQ/Z/pXnl98ho1zw=    0
```

Perguntando por **uma** interface, o `wg` devolve `chave-do-peer<TAB>valor`. Ele só prefixa o nome
da interface quando se pergunta por `all`.

**E isto era um bug à espera.** O `controle-wg.ts` perguntava por `all` e supunha três colunas —
suposição que nunca tinha sido medida, porque no runner de 17/09 a pergunta morreu em "Permission
denied" antes de imprimir. Se o formato do `all` fosse outro, o mapa sairia vazio, nenhuma
interface casaria com nenhum perfil, e o controle recusaria **toda transmissão boa** dizendo que o
túnel não está de pé.

O controle passa a listar as interfaces e perguntar uma a uma. Custa um processo a mais por
interface e, em troca, os dois formatos que ele lê foram medidos.

## 15. Confirmações

- `wg show <perfil>` continua **não** resolvendo o nome do perfil, igual ao runner.
- O mapeamento `/var/run/wireguard/sfx-medicao.name` → `utun4` existe e é só-root.
- `latest-handshakes` deu `0` contra o endpoint reservado, confirmando o achado 4 na prática: o
  `up` devolveu `exit=0` e o túnel não estava de pé.
- `down` de quem já está fora responde `` `sfx-medicao' is not a WireGuard interface `` e sai com 1
  — texto diferente do `does not exist` que o perfil inexistente dá, mas nada aqui depende disso.
