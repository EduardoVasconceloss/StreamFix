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
