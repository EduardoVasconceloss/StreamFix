# StreamFix — túnel nas duas pontas

**Data:** 11/09/2026
**Estado:** desenho aprovado, sem pontos em aberto
**Substitui:** `2026-09-08-tunel-momentaneo-design.md`, cuja premissa central foi refutada

---

## 1. O que mudou, e por que a spec anterior não serve

Em 03/09/2026 o Discord estendeu a verificação de região ao plano de mídia. A spec de 08/09
assumiu que bastava a mídia de quem transmite sair do Brasil no instante em que a entrega
nasce. A seção 12c da pesquisa refutou isso, e as seções 12d e 12e estabeleceram o modelo real:

> **O gate avalia o IP da mídia UDP de quem transmite, quando a sessão de entrega nasce, e o
> de quem assiste, quando essa pessoa entra. Depois disso, a autorização de cada lado
> sobrevive à queda do túnel.**

Três consequências, e a primeira reescreve o produto:

1. **Não há solução de uma ponta só.** Nada que a máquina de quem transmite faça resolve o
   lado de quem assiste. O StreamFix deixa de ser "restaure seu Go Live" e passa a exigir as
   duas pontas.
2. **O plugin atual é redundante onde há túnel.** Em 12d a transmissão funcionou com o
   StreamFix desligado nos dois lados: com o túnel de pé, o cliente enxerga um IP estrangeiro
   e a Trava 1 nunca engata. A proxy de gateway, que é o coração do plugin hoje, não tem
   função — o fato 5 já dizia que rotear controle não satisfaz o gate.
3. **Quem assiste não precisa de túnel permanente.** Por 12e, basta estar de pé no instante de
   entrar. Isso permite um túnel de segundos em vez de uma VPN ligada o dia inteiro.

O produto muda de lugar: deixa de ser "minta sobre a região" e passa a ser **"tenha o túnel
certo, só no Discord, só quando precisa, e saiba quando a entrega morreu"**.

Esse último pedaço é o que justifica continuar sendo um plugin em vez de um instalador de
túnel avulso. O SessionMonitor só existe dentro do cliente: saber que `framesEncoded` travou
com espectador assistindo exige estar dentro do Discord. De fora, tudo o que se vê é uma
transmissão "no ar" — que é exatamente o que ela parece estar quando foi recusada.

---

## 2. Decisões

| # | Decisão | Alternativa descartada |
|---|---|---|
| D1 | Continua sendo plugin de mod, com o trabalho realocado | Instalador de túnel avulso, sem Vencord |
| D2 | A proxy de gateway **sai do código** | Virar modo legado desligado por padrão |
| D3 | O túnel é configurado pelo **instalador do StreamFix** | Instalador separado |
| D4 | O monitor **só avisa**; agir vem depois | Recriar a transmissão sozinho |
| D5 | Chave por pessoa, gerada no cliente | Config compartilhada |
| D6 | Registro por **endpoint de convite** na saída | Cadastro manual; distribuir configs prontas |
| D7 | Sem túnel, o **Go Live é bloqueado** com o motivo na tela | Deixar transmitir e torcer |
| D8 | A saída é **parâmetro**, com a VPS de Santiago como padrão | Amarrar ao IP da VPS |
| D9 | Túnel **permanente** em quem transmite, **momentâneo** em quem assiste | Permanente nos dois |
| D10 | Split tunnel por aplicativo (`AllowedApps = Discord`) | Por faixa de IP |

Duas delas merecem a justificativa por extenso.

**D2, a proxy sai do código.** Ela carrega o defeito de privacidade em aberto — desligar o
plugin deixa conexões vivas atravessando proxy de terceiro — e código legado que ninguém
exercita apodrece sem avisar. Quem quiser o comportamento antigo tem as versões antigas.

**D7, bloquear.** Sem túnel, a transmissão sobe, aparece "AO VIVO" e só morre quando alguém
entra; quem transmite não tem como saber. A falha silenciosa é o inimigo declarado deste
projeto, e deixar passar aqui seria reproduzi-la de propósito.

---

## 3. Arquitetura

Seis unidades, cada uma com um propósito e uma fronteira testável.

```
  máquina de quem usa                            saída (VPS)
  ┌──────────────────────────────┐               ┌────────────────────┐
  │ instalador do StreamFix      │──registro────▶│ provisionador      │
  │   descoberta · chave · perfil│               │  (convite → peer)  │
  └──────────────────────────────┘               │                    │
  ┌──────────────────────────────┐               │ WireGuard          │
  │ plugin (renderer)            │               │  uma interface,    │
  │   coletor ──▶ SessionMonitor │               │  um peer por pessoa│
  │   porteiro do Go Live        │               └────────────────────┘
  └───────────┬──────────────────┘                         ▲
              │ IPC                                        │
  ┌───────────▼──────────────────┐                         │
  │ plugin (nativo)              │                         │
  │   controle do túnel ─────────┼── WireSock ─────────────┘
  └──────────────────────────────┘
```

### 3.1 `tunnel/monitor.ts` — decide se a entrega está viva

**Já existe e está testado.** Função pura: recebe uma série de amostras, devolve um veredito.
Não lê store, não consulta rede, não olha o relógio. Quatro regras, todas vindas de medição.

Nada nesta spec muda o monitor. Ele entra como está.

### 3.2 `tunnel/coletor` — alimenta o monitor

Roda no renderer. A cada 500 ms lê `MediaEngineStore`, o contexto `stream`, e a contagem de
espectadores; reduz aos campos que o monitor consome e chama `avancar`.

É a fronteira entre "o que o Discord expõe" e "o que o monitor entende". Toda dependência de
nome interno do Discord vive aqui e em nenhum outro lugar — quando o bundle renomear um campo,
há um arquivo só para consertar.

O `tests/fixtures/capture.mjs` já implementa exatamente essa redução, e as três fixtures
existentes são a especificação executável desta unidade.

### 3.3 `tunnel/controle` — sobe e derruba o túnel

Roda no módulo nativo, porque fala com o WireSock. Interface mínima:

```
subir(perfil): Promise<{ ok: true, saida: string } | { ok: false, motivo: string }>
derrubar(): Promise<void>
estado(): Promise<"conectado" | "fora" | "desconhecido">
```

Implementado sobre `wiresock-connect-cli.exe` (`connect`, `disconnect`, `status`). A conexão
levou **793 ms** na medição do spike, e o `connect` captura um Discord já aberto — não exige
reinício.

**`estado()` não pode se contentar com "o CLI diz conectado".** A verificação que vale é o
`localAddress` que o próprio Discord reporta em `getStats().transport` — foi assim que 12d
provou que a mídia saía de Santiago, e é a única leitura que não pode mentir, porque vem de
dentro da conexão que importa.

### 3.4 `tunnel/perfil` — escreve o `.conf`

Gera o arquivo de perfil do WireSock. Pequena, e mais perigosa do que parece: duas das três
falhas silenciosas de 11/09 nasceram aqui.

- **`#@ws:AllowedApps` vai no bloco `[Peer]`**, depois de `# [Peer] WireSock extensions`. No
  `[Interface]` a diretiva é descartada em silêncio e o túnel leva a máquina inteira — e um
  teste de ponta a ponta **passa** assim.
- **O MTU não pode ser fixo em 1420.** Link PPPoE residencial tem MTU 1492, e 1420 assume
  1500. Oito bytes bastam para descartar pacote cheio de vídeo sem aviso. O valor tem que ser
  **medido** na instalação (`ping -f -l`, busca binária) e escrito como `MTU = <medido> - 80`.
- O perfil vive em `ProgramData` e pertence a SYSTEM e Administradores: escrevê-lo exige
  elevação.

### 3.5 `provisionamento` — cliente do registro

Na instalação: gera o par de chaves localmente, envia a **pública** junto com o convite, recebe
de volta o endereço interno e os dados da saída. A privada nunca sai da máquina.

### 3.6 `provisionador` — o endpoint na saída

Serviço mínimo na VPS. Recebe `{convite, chavePublica}`, valida o convite, escolhe o próximo
endereço livre na faixa, acrescenta o peer e devolve `{endereco, chavePublicaDoServidor,
endpoint, faixa}`.

Convites são gerados e revogados por quem administra a saída. Revogar um convite não mexe em
quem já entrou; revogar uma pessoa é remover o peer dela.

**Uma interface WireGuard basta**, com um peer por pessoa. O arranjo de duas interfaces em
portas separadas que 12d usou era exigência do laboratório, não do desenho: o WireSock rouba o
tráfego de volta quando duas pontas **na mesma máquina** falam com o mesmo `IP:porta`. Em uso
real cada pessoa tem a sua máquina, e a colisão não existe. Vale registrar mesmo assim, porque
quem for reproduzir o teste vai esbarrar nela.

---

## 4. Fluxos

### 4.1 Instalação

1. Descoberta (já existe): acha os Discord instalados e o checkout do mod.
2. Copia o plugin, compila, manda injetar (já existe).
3. **Mede o MTU do caminho.**
4. Gera o par de chaves.
5. Pede o convite ao usuário e registra a pública no provisionador.
6. Instala o WireSock, se não houver.
7. Escreve o perfil — **aqui acontece a única elevação**.
8. Liga o plugin nas settings do mod.

Tudo num passo só. Dois instaladores separados dobram a chance de alguém ficar com metade da
coisa montada, que é o pior estado possível: parece pronto e não está.

### 4.2 Transmitir

```
usuário clica em Go Live
   │
   ├─ túnel de pé? ──não──▶ BLOQUEIA, com o motivo na tela
   │                        "o túnel está fora; o Go Live seria recusado"
   │                        e um botão para tentar subir
   └─ sim
      └─ o Discord enxerga saída estrangeira? (localAddress) ──não──▶ BLOQUEIA
         └─ sim
            └─ Go Live segue normalmente
               └─ coletor → monitor, a cada 500 ms
                  └─ veredito "quebrado", causa "entrega" ──▶ avisa na tela
```

O túnel de quem transmite é **permanente** enquanto o plugin estiver ligado (D9). Não porque a
autorização precise — ela sobrevive à queda —, mas porque alternar o túnel é o que derruba
conexões do Discord, e porque a próxima transmissão precisa dele de pé de novo.

**Custo assumido:** a call inteira passa a ~80 ms em vez dos 35 ms diretos. Medido em 12d,
nos dois contextos, sem trombone. Ver a seção 7 para o refinamento que ataca isso.

### 4.3 Assistir

```
usuário clica numa transmissão
   │
   ├─ sobe o túnel  (~800 ms, medido)
   ├─ confirma a saída pelo localAddress
   ├─ entra na transmissão
   └─ derruba o túnel 10 s depois da entrada
```

**Por que dez segundos, e por que um prazo fixo em vez de uma medição.** O lado de quem assiste
não tem os contadores de saída que o monitor usa — aqueles são de quem transmite. Medir a
chegada exigiria ler as estatísticas de entrada, e essa é uma superfície do Discord que ainda
não foi levantada. Dez segundos é folga larga sobre os ~800 ms de conexão do túnel e sobre o
tempo de o `stream` nascer, e errar para mais aqui é barato: custa alguns segundos de latência
a quem assiste, e nada mais. Trocar por uma medição real é melhoria, não requisito.

Por 12e, a autorização de quem assiste sobrevive à queda do túnel: medido com o espectador
voltando a IP brasileiro e a entrega seguindo por mais de dois minutos a 60 fps, confirmada na
tela. Isso mantém a conversa em latência normal e tira o vídeo do espectador da franquia de
saída depois dos primeiros segundos.

**Dois pontos frágeis deste fluxo, nomeados de propósito:**

- **Interceptar a entrada.** O plugin precisa se colocar entre o clique e a entrada, e segurar
  a entrada até o túnel confirmar. Se falhar em segurar, a pessoa entra sem túnel e é recusada
  — e pela pergunta F2 talvez derrube mais gente junto. O comportamento na falha é
  **desistir da entrada com aviso**, nunca entrar mesmo assim.
- **O túnel leva o processo inteiro** (D10), então subi-lo mexe também na voz de quem já está
  numa call. Espera-se um soluço curto. Não medido.

---

## 5. O que morre

- A proxy de gateway e todo o roteamento SOCKS.
- O PAC e a lógica de escolha de proxy.
- A lista de proxies públicas e o teste de saídas.
- A saída pelo Tor.
- As configurações `voiceRegion` e `streamRegion` **permanecem** — voltam a ser úteis no
  refinamento da seção 7, e não custam nada paradas.

Com a proxy some o defeito de privacidade em aberto, porque some o terceiro.

---

## 6. Erros e estados degradados

| situação | comportamento |
|---|---|
| WireSock não instalado | o instalador instala; o plugin não tenta |
| Túnel não sobe | Go Live bloqueado, motivo na tela, botão de tentar de novo |
| Túnel de pé mas `localAddress` brasileiro | tratado como "sem túnel": bloqueia |
| Saída fora do ar | bloqueia; a transmissão já no ar **não** é derrubada (a autorização sobrevive) |
| Monitor diz "quebrado", causa `entrega` | avisa: a transmissão precisa ser recriada |
| Monitor diz "quebrado", causa `captura` | avisa que o problema é local; recriar não adianta |
| Entrada em transmissão sem túnel | desiste da entrada, com aviso |

A assimetria da quarta linha é deliberada: derrubar uma transmissão que está funcionando
porque a saída ficou inacessível seria trocar um problema hipotético por um real.

---

## 7. Refinamento previsto, fora deste escopo

> **Substituído em 11/09/2026** por `2026-09-11-tunel-em-dois-niveis-design.md`, que também
> substitui a D9. As medições de 12g e 12h mostraram um caminho melhor do que a faixa de IP
> dos servidores de transmissão descrita abaixo.

Voz direta. Forçar `voiceRegion` no Brasil e `streamRegion` fora, e restringir o túnel por
`AllowedIPs` à faixa dos servidores de transmissão: a voz fica em ~35 ms e só o vídeo paga o
desvio. Latência de voz é o que se sente numa conversa; latência de tela compartilhada é muito
mais tolerante.

Fica fora agora por dois motivos: depende de faixas de IP estáveis que ninguém levantou, e
otimizar latência antes de a entrega funcionar em uso real é otimizar a coisa errada.

---

## 8. Testes

| unidade | como se testa |
|---|---|
| `monitor` | puro, com as três fixtures reais e os casos sintéticos — 32 testes, já existem |
| `coletor` | contra as fixtures: a redução tem que produzir as mesmas entradas |
| `perfil` | texto gerado comparado com o que o WireSock aceita; asserção explícita de que `AllowedApps` está no `[Peer]` |
| `controle` | CLI do WireSock dublado; o caminho real fica no teste manual |
| `provisionador` | convite inválido, convite repetido, faixa cheia |

**Um teste que não pode faltar, e que é de integração manual: o negativo.** Com o túnel ligado,
confirmar que um processo que *não* é o Discord continua saindo pelo IP brasileiro. Foi ele que
pegou o `AllowedApps` sendo descartado em silêncio, e é a única defesa contra o pior modo de
falha deste projeto — o teste que passa medindo outra coisa.

---

## 9. F2, respondido

A pergunta que nasceu aberta nesta spec — *um espectador sem túnel derruba a entrega para a
sala inteira?* — foi respondida em 11/09/2026 com três participantes simultâneos. Ver a seção
12f da pesquisa.

**A negação é por espectador.** O brasileiro sem túnel tomou o erro 2012 e não viu nada; o
espectador tunelado continuou vendo a transmissão, e o encoder seguiu a 60 fps sem uma parada
em 93 amostras.

Isso confirma o desenho como escrito, sem alteração:

- A seção 6 fica como está. A linha "entrada em transmissão sem túnel → desiste da entrada, com
  aviso" continua certa, e agora com a garantia de que, se alguém escapar do porteiro, o
  estrago é só dele.
- O produto **não** passa a depender de quem clica na transmissão, que é justamente o que quem
  transmite não controla.

Um achado colateral que afeta a unidade `coletor`: **o espectador negado aparece na contagem
de espectadores.** `getViewerIds()` foi de 1 para 2 com o negado sem receber um byte. A
contagem diz quem clicou, não quem recebe — o que reforça a decisão, já embutida no monitor, de
concluir por contadores de entrega e nunca por ela.

---

## 10. Referências

- `docs/research/regressao-encoder-inativo-2026-09-03.md` — seções 12 a 12e, os fatos medidos
- `docs/superpowers/plans/2026-09-08-spike-wiresock.md` — sintaxe do split tunnel, tempos
- `tests/fixtures/` — `saudavel-longa`, `quebra-entrada-espectador`, `sem-espectador`
- `CONTEXT.md` — o glossário do domínio, refeito em 11/09
