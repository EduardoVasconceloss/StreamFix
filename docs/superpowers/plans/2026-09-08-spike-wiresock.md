# Spike: WireSock pega a mídia do Discord?

Roteiro do spike da fase 3 de `2026-09-08-tunel-momentaneo-plan.md`. Executado por quem tem
uma config WireGuard em mãos; cada medição diz o que fazer com o resultado.

Nada aqui é código de produto. O objetivo é responder quatro perguntas que podem mudar o
desenho, gastando uma tarde em vez de uma fase inteira.

## O que a documentação já respondeu, antes de instalar nada

**1. `prepare` e `route` não são separáveis pelo CLI.** O `wiresock-client.exe` documenta
`run`, `install`, `uninstall`, `import` e `reset-network-lock`, mais `sc start` / `sc stop` do
serviço. **Não existe comando para manter o túnel de pé e desligar só o roteamento.** A spec
apoiava a promessa de 2-3 segundos de interrupção justamente nessa separação.

Isso não mata o desenho, mas troca a pergunta. Em vez de "dá para separar?", que já tem
resposta e é *não*, o que importa medir é **quanto tempo custa uma partida completa**. Se subir
o túnel inteiro leva ~1 s, a separação nunca foi necessária e a spec estava resolvendo um
problema que não existe. Se leva 8 s, a recuperação automática fica cara demais e a janela
quente passa a ser a defesa principal.

**2. Licença: gratuito para uso pessoal, não comercial.** Serve para este projeto e para quem
usar o plugin. **Decidido em 08/09/2026: o instalador automatiza.** Cada pessoa instala na
própria máquina sob a própria licença de uso pessoal, pelo canal oficial
(`winget install --id NTKERNEL.WireSockVPNClient --silent`), sem o projeto redistribuir nada —
o mesmo padrão já usado para Node, pnpm e Tor.

Consequência a tratar na fase 3: o componente instala um driver de filtro de rede e exige
elevação, e **hoje nenhum script em `installer/` eleva**. A recomendação é elevar só esse
passo, num processo separado.

**3. Não documentado, e por isso medido aqui:** se o filtro por aplicativo alcança UDP, e se
alcança um processo que já estava rodando antes do túnel subir.

## Preparação

### 1. Instalar o WireSock

```
winget install --id NTKERNEL.WireSockVPNClient -e --accept-source-agreements --accept-package-agreements
```

Pede elevação (instala um driver de filtro de rede), então roda numa janela com UAC, não a
partir de um processo sem privilégio.

### 2. Obter uma config WireGuard

Em `account.protonvpn.com`, **Downloads → WireGuard configuration**: dê um nome, escolha um
servidor e baixe o `.conf`. O plano gratuito gera config normalmente; a única opção oferecida é
o VPN Accelerator, e os servidores disponíveis ficam longe do Brasil. **Para o spike isso não
importa** — aqui se mede mecanismo, não latência. O número de latência só passa a valer quando
houver uma saída no Cone Sul.

> **A chave privada dentro do `.conf` é credencial.** Não cole o conteúdo do arquivo em
> conversa, em issue, em log ou no relatório do `/streamfix`. Passe sempre o caminho.

### 3. Restringir o túnel ao Discord

É o ponto do desenho inteiro. No bloco `[Interface]` do `.conf`, acrescente:

```
#@ws:AllowedApps = Discord
```

O nome casa por processo, sem caminho e sem `.exe`, então cobre de uma vez os vários processos
que o Discord abre — o que carrega a mídia não é necessariamente o de nome mais óbvio. O
executável nesta máquina está em
`%LOCALAPPDATA%\Discord\app-<versao>\Discord.exe`, e o número da versão muda a cada
atualização: mais uma razão para casar por nome e não por caminho.

Deixe `AllowedIPs = 0.0.0.0/0` no bloco `[Peer]`. Combinado com `AllowedApps`, isso significa
"todo destino, mas só para o Discord".

### 4. Subir o túnel

Para o spike, rode em primeiro plano em vez de instalar como serviço — é mais fácil de ligar e
desligar nas medições M2 e M4, e o log fica à vista:

```
wiresock-client.exe run -config "C:\caminho\para\sua.conf" -log-level debug
```

## As quatro medições

### M1 — O filtro por aplicativo alcança a mídia UDP?

**A pergunta que justifica o projeto.** O PAC nunca alcançou a mídia; se o WireSock também não
alcançar, o componente está errado e o desenho precisa de outro.

Com o túnel de pé e o Discord rodando, inicie um Go Live e peça para alguém assistir.

- **Espectador vê a tela:** a mídia UDP saiu pelo túnel. É a resposta que o desenho espera.
- **Espectador recebe 2012:** a mídia continuou saindo direta. Conferir antes de concluir se o
  `AllowedApps` casou com o processo certo — o Discord roda vários processos, e o que carrega a
  mídia não é necessariamente o que tem o nome óbvio.

### M2 — Quanto custa uma partida completa?

Meça do comando até a entrega funcionando, em três marcos:

1. `sc start wiresock-client-service` retorna;
2. o log do WireSock registra o primeiro handshake;
3. uma transmissão iniciada agora nasce autorizada.

O número que interessa para o desenho é o **terceiro**, porque é ele que o usuário sente numa
recuperação. Repita três vezes e anote os três.

| resultado | consequência |
|---|---|
| até ~2 s | a separação `prepare`/`route` era desnecessária. Remover da spec e simplificar o `Tunnel` para quatro operações. |
| 2 a 5 s | recuperação automática continua viável, mas o custo anunciado na spec sobe. Corrigir o número. |
| acima de 5 s | recuperação automática fica cara. A janela quente vira a defesa principal e seu padrão sobe bem acima dos 3 min. |

### M3 — O Discord precisa nascer depois do túnel?

**A medição que pode matar o modo momentâneo.** Se o filtro só alcança processos iniciados
depois dele, o túnel momentâneo exigiria reiniciar o Discord a cada transmissão, o que ninguém
aceita.

Há motivo concreto para suspeitar: o passo a passo manual que funcionava antes do StreamFix
mandava fechar o Discord e abri-lo com a VPN já ligada.

Com o **Discord já aberto**, suba o túnel e faça M1 de novo.

- **Funciona:** o modo momentâneo é viável.
- **Só funciona reiniciando o Discord:** o modo momentâneo morre. Sobra o túnel permanente, e a
  spec passa a ter um modo só. Melhor saber agora.

### M4 — Derrubar o túnel derruba a transmissão em andamento?

O modo momentâneo depende de a transmissão sobreviver à queda do túnel. Já foi medido que ela
sobrevive quando a VPN é desligada — mas com uma VPN de sistema, não com um filtro por
aplicativo que corta os sockets de um processo específico.

Com a transmissão no ar e alguém assistindo, pare o serviço.

- **Continua entregando:** confirma a premissa central da spec, agora com o mecanismo real.
- **Cai:** o modo momentâneo morre pelo mesmo motivo de M3, e vale registrar em quanto tempo.

## O que fazer com o resultado

Anote as quatro respostas em `docs/research/`, com data. Se M1 falhar, o spike terminou e a
fase 3 recomeça com outro componente. Se M3 ou M4 falharem, a spec perde o modo momentâneo e o
plano encurta — a fase 5 fica bem menor, porque `RECOVERING` deixa de existir.
