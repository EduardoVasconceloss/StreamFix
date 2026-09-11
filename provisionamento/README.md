# A saída

Isto é para quem **opera** uma saída — a máquina fora do Brasil por onde a mídia do Discord vai
sair. Se você só quer usar o StreamFix, você não precisa de nada disto: precisa de um convite,
que quem opera a saída te manda.

Uma saída atende você e as pessoas que você convidar. Um `/24` dá 253 endereços, então o limite
prático não é esse — é a franquia de tráfego da sua máquina.

---

## O que roda aqui

| Arquivo | O quê |
|---|---|
| `servidor.mjs` | Recebe `POST /registrar`, troca convite por endereço, chama `wg set` |
| `convites.mjs` | A ferramenta de quem administra: criar convite, revogar, listar, remover |
| `registro.ts` | As decisões, puras e testadas. Os dois de cima são casca |
| `streamfix-provisionador.service` | A unit do systemd |

O estado inteiro é um arquivo JSON: faixa, endereço do servidor, chave pública da saída,
convites e peers. **Ele não tem chave privada de ninguém** — as privadas nascem e morrem nas
máquinas de quem instala, e nunca são transmitidas.

---

## Montar

Supõe Ubuntu com WireGuard já de pé em `wg0` e Node 18 ou mais novo.

### 1. O usuário e a pasta

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin streamfix
sudo mkdir -p /opt/streamfix
```

### 2. O servidor

O Node do Ubuntu é compilado **sem** o removedor de tipos do TypeScript, então ele não carrega
os `.ts` direto. Empacote numa máquina que tenha esbuild e mande o resultado:

```bash
# na sua máquina, no checkout do StreamFix
npx esbuild provisionamento/servidor.mjs --bundle --platform=node --format=esm \
    --outfile=/tmp/servidor.js
scp /tmp/servidor.js ubuntu@SUA-SAIDA:/tmp/
scp provisionamento/convites.mjs provisionamento/registro.ts ubuntu@SUA-SAIDA:/tmp/

# na saída
sudo mv /tmp/servidor.js /tmp/convites.mjs /tmp/registro.ts /opt/streamfix/
sudo chown -R root:root /opt/streamfix
```

### 3. O estado

Precisa da chave **pública** do seu `wg0` e do endpoint que as pessoas vão discar:

```bash
sudo wg show wg0 public-key       # a chave pública da saída
```

```bash
sudo -u streamfix node /opt/streamfix/convites.mjs iniciar \
    --faixa 10.8.0.0/24 \
    --servidor 10.8.0.1 \
    --chave-da-saida "<a pública do wg0>" \
    --endpoint "SEU.IP.AQUI:39743"
```

### 4. A unit

```bash
sudo cp streamfix-provisionador.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now streamfix-provisionador
systemctl status streamfix-provisionador
```

Ele sobe escutando em `127.0.0.1:8787`. **De propósito** — a próxima seção é a que decide se
gente de fora alcança.

---

## Abrir para fora

Enquanto o servidor escuta só no loopback, ninguém de fora se registra. Para as pessoas que você
convidou conseguirem instalar, ele precisa estar alcançável — e isso é uma decisão, não um
passo de instalação.

**O que fica exposto:** um endpoint HTTP que, sem um convite válido, responde 403 e nada mais.
Ele não lista convites, não diz quantos endereços existem, e não aceita nenhuma outra rota.

**O que protege:**

- **O convite.** Vinte caracteres aleatórios, comparação exata. Sem ele não há resposta útil.
- **Limite de tentativas**: 10 por minuto por origem, depois 429. É a defesa que importa contra
  adivinhação.
- **A chave pública fixada no cliente.** O registro vai por HTTP puro, porque a saída é um IP e
  não um domínio. O risco sério disso não é o convite vazar — é alguém no caminho devolver a
  *própria* saída e levar a mídia de quem instalou junto. Passar `-ExitKey` no instalador fecha
  isso sem TLS: o cliente recusa uma resposta que traga outra chave.

**O que continua exposto, e é honesto dizer:** o convite trafega em claro. Quem estiver no
caminho pode lê-lo e gastar um uso. Convite é barato de revogar e tem uso contado, então o
estrago é pequeno e reversível — mas é real.

Se decidir abrir:

```bash
# 1. o servidor passa a escutar em todas as interfaces
sudo sed -i 's/--endereco 127.0.0.1/--endereco 0.0.0.0/' \
    /etc/systemd/system/streamfix-provisionador.service
sudo systemctl daemon-reload && sudo systemctl restart streamfix-provisionador

# 2. o firewall do host
sudo iptables -I INPUT -p tcp --dport 8787 -j ACCEPT
sudo netfilter-persistent save

# 3. na Oracle Cloud, a security list da subnet também precisa liberar 8787/TCP.
#    Ela é uma segunda camada, independente do iptables -- foi ela que descartou o ICMP
#    na medição de MTU de 11/09, com o host aceitando.
```

Para fechar de novo, o caminho inverso. **Fechar depois que todo mundo já se registrou é uma
boa ideia**: quem já tem peer não precisa mais do provisionador para nada.

---

## Operar

```bash
cd /opt/streamfix

# criar um convite (o padrão é 1 uso)
sudo -u streamfix node convites.mjs novo
sudo -u streamfix node convites.mjs novo --usos 5

# ver tudo
sudo -u streamfix node convites.mjs listar

# fechar a porta para quem ainda não entrou por este convite
sudo -u streamfix node convites.mjs revogar CODIGO

# tirar uma pessoa
sudo -u streamfix node convites.mjs remover <chave-pública>
sudo wg set wg0 peer <chave-pública> remove
```

**Depois de qualquer mudança:** `sudo systemctl reload streamfix-provisionador`. O servidor
guarda o estado em memória, e sem o reload você revogou um convite que continua funcionando.
Os comandos lembram disso sozinhos.

**Revogar um convite não tira quem já entrou por ele.** São operações separadas de propósito: um
convite de cinco usos que vazou não deve derrubar as quatro pessoas certas que entraram por ele.

---

## Quando algo dá errado

| O que a pessoa vê | O que é |
|---|---|
| `o convite nao existe` | Código errado, ou o estado foi recriado |
| `este convite foi revogado` | Você revogou. Mande outro |
| `este convite ja foi usado o numero maximo de vezes` | Crie um novo, ou um com mais usos |
| `a saida esta cheia` | A faixa acabou. Remova quem não usa mais |
| `a saida aceitou voce mas nao conseguiu ligar o WireGuard` | **Problema seu**: o `wg set` falhou. Veja `journalctl -u streamfix-provisionador` |
| `nao consegui falar com a saida` | A porta não está aberta, ou o serviço caiu |

Reinstalar não gasta convite: registrar a mesma chave pública de novo devolve o mesmo endereço e
não conta uso.
