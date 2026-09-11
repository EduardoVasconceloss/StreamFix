# Plano de implementação: túnel nas duas pontas

Implementa `docs/superpowers/specs/2026-09-11-tunel-nas-duas-pontas-design.md`. A spec responde
*o quê* e *por quê*; este plano responde *em que ordem* e *como se prova cada passo*.

Diagnóstico de origem em `docs/research/regressao-encoder-inativo-2026-09-03.md`, seções 12 a
12f. Substitui `2026-09-08-tunel-momentaneo-plan.md`, cuja spec caiu.

---

## Estado

| fase | estado |
|---|---|
| 0 — remover a proxy | **feita** em 11/09 |
| 1 — coletor | **feita** em 11/09 |
| 2 — perfil | **feita** em 11/09 |
| 3 — controle | não iniciada |
| 4 — provisionamento | não iniciada |
| 5 — porteiro | não iniciada (gancho investigado) |
| 6 — assistir | não iniciada (gancho investigado) |
| 7 — instalador | não iniciada |
| 8 — entrega | não iniciada |

**Pendência da fase 0:** a verificação de tipos completa não foi feita. Ela exige compilar
dentro de um checkout do mod, e o checkout desta máquina é o que o Discord do usuário carrega —
copiar para lá troca o plugin instalado. O que foi verificado: sintaxe por esbuild nos dois
arquivos, nenhuma referência pendente ao que saiu, nenhum import sobrando, e a suíte verde.

---

## O que já existe e entra de graça

| | estado |
|---|---|
| CI rodando `tests/**/*.test.cjs` | **feito**, verde em ubuntu e windows |
| `streamFix/tunnel/monitor.ts` | **feito e testado**, 32 testes, 3 fixtures reais |
| `tests/fixtures/capture.mjs` | **feito** — é a especificação executável do coletor |
| Descoberta do mod e injeção, no instalador | **feito** |
| Patch de `preferred_region` (`pickStreamRegion`) | **feito**, usado só no refinamento futuro |

Metade da fase 2 do plano anterior sobreviveu inteira. O monitor não muda nesta spec.

---

## Correções à spec, apuradas ao montar o plano

### 1. O plugin não atende quem assiste fora do Windows — e agora quem assiste é produto

Esta é a correção grave. A spec descreve o túnel inteiramente sobre **WireSock**, que é
Windows. Isso era aceitável enquanto o produto era de quem transmite; deixou de ser em 12d,
quando quem assiste virou parte do bypass.

O instalador tem um `streamfix-installer.sh`, então já há usuários fora do Windows. Um amigo em
Linux hoje não tem caminho: ele precisa de túnel para entrar na sua transmissão, e o desenho
não lhe dá nenhum.

**Proposta:** `tunnel/controle` ganha duas implementações por trás da mesma interface —
WireSock no Windows, `wg-quick` no Linux. Elas já foram exercitadas lado a lado no teste de
11/09: o emissor por WireSock, o espectador por `wg-quick` dentro do WSL2. macOS fica de fora
por ora, como já está no resto do projeto (ver `docs/adr/0001`).

**Isso muda a spec**, não só o plano. A seção 3.3 precisa falar de duas implementações, e a
seção 8 precisa de testes para as duas.

> **Adiado por decisão de 11/09/2026: só Windows por enquanto.** Linux e macOS ficam para
> depois. O registro fica porque a lacuna é real e vai voltar — assim que o primeiro amigo
> fora do Windows quiser assistir. Quando voltar, `tunnel/controle` já estará atrás de uma
> interface, que é o que torna a adição barata.

### 2. O patch `2026-08-video-guard` também tem que sair — e pelo motivo oposto ao da proxy

A seção 5 da spec lista o que morre e não o menciona. Deveria.

Esse patch desarma a Trava 1, o guarda do próprio cliente que esconde o Go Live para quem está
no Brasil. Com o túnel de pé ele é **inútil**: o cliente enxerga IP estrangeiro e o guarda nem
engata — foi o que 12d mostrou, com o plugin desligado. Sem o túnel, ele é **nocivo**: remove o
único aviso que sobraria e deixa a pessoa subir uma transmissão que vai ser recusada.

Ou seja, ele trabalha exatamente contra o porteiro da decisão D7.

**Ressalva honesta:** não sabemos em que sinal a Trava 1 se baseia. Se ela olhar o gateway e
não a mídia, tirar o patch não dá um porteiro de graça — o porteiro continua sendo nosso
trabalho. De qualquer forma o patch sai; ele só não substitui a fase 5.

### 3. O instalador não eleva

Conferido: nenhum script em `installer/` tem `RunAs`, `-Verb` ou equivalente. A seção 4.1 da
spec fala em "a única elevação" como se o mecanismo existisse. Não existe; é trabalho da fase 7.

---

## Fase 0 — Remover a proxy de gateway

**Por que primeiro.** É a maior deleção do projeto e não depende de nada. Fazer depois
significaria manter dois caminhos vivos enquanto o novo nasce, e o antigo carrega o defeito de
privacidade em aberto. Também encolhe `native.ts` — 1189 linhas hoje — antes de acrescentar
coisa nova a ele.

**O que sai:** roteamento SOCKS, PAC, lista de proxies públicas, teste de saídas, saída pelo
Tor, `stopRouter`, o patch `2026-08-video-guard` (correção 2), e as settings que só serviam a
eles.

**O que fica:** `pickStreamRegion` e as settings de região, o comando `/streamfix`, a descoberta
e a injeção.

**Como se prova:**
- A suíte continua em verde no que sobrou. Os testes que cobriam a proxy saem junto com ela —
  são cerca de 17, e removê-los é parte da fase, não perda de cobertura.
- O harness de `stripTypeScriptTypes` existia só para testar `native.ts`; verificar se ainda é
  necessário depois da deleção, e apagá-lo se não for.
- Nenhuma conexão de rede parte do plugin com ele ligado e sem túnel. Verificável com
  `Get-NetTCPConnection` filtrado pelo PID do Discord.

**Risco:** quem usa hoje perde a Trava 1 destravada sem ganhar nada em troca até a fase 5. É
consequência aceita da decisão D2, mas define a ordem da entrega: **nada disso vai para as
pessoas antes da fase 8.**

---

## Fase 1 — `tunnel/coletor`

**Objetivo.** Ler o `MediaEngineStore` no renderer, reduzir aos campos que o monitor consome, e
chamar `avancar` a cada 500 ms.

**Não depende de nada** e pode andar em paralelo com a fase 0.

**O que se escreve:** `streamFix/tunnel/coletor.ts`, com a extração idêntica à de
`tests/fixtures/capture.mjs` — inclusive `stats.rtp.outbound` (e não `stats.outbound`, que foi
erro meu em 08/09) e `quadrosCapturados` somando os backends de captura.

**Como se prova.** As três fixtures são a especificação: alimentar o coletor com os registros
crus de cada `.jsonl` tem que produzir exatamente as amostras que os testes do monitor já
consomem. Isso é um teste de igualdade, não de comportamento novo, e por isso é barato e forte.

**Fronteira que importa:** toda dependência de nome interno do Discord vive aqui. Quando o
bundle renomear um campo, há **um** arquivo para consertar — e o sintoma será `null` na amostra,
nunca zero, que é a diferença entre "não sei" e "mentir".

**Como ficou, e por que virou dois arquivos.** O Node exige extensão explícita em `import`
relativo dentro de `.ts`, mas escrever `./monitor.ts` quebraria o `tsc` do mod, que usa
`moduleResolution: bundler` sem `allowImportingTsExtensions`. Isso forçou a separação — e ela
é melhor do que o desenho original:

- `tunnel/coletor.ts` — a tradução pura (`aAmostra`, `quadrosCapturados`). Só `import type` do
  monitor, então nenhuma dependência em tempo de execução, e carregável por `require()` direto.
  É onde mora tudo o que pode quebrar em silêncio.
- `tunnel/observador.ts` — o laço. Importa os dois, não é carregável pelo Node, e por isso é
  mantido fino de propósito: o que sobra nele é agendamento, e falha de agendamento aparece na
  hora.

`quadrosCapturados` mudou de casa junto, do monitor para o coletor: ele interpreta nomes de
campo do Discord, então é tradução, não decisão.

**Os testes do monitor agora passam pela redução de produção.** O `daFixture` deixou de ter uma
cópia da extração e chama `aAmostra` — uma divergência entre o que a captura gravou e o que a
produção lê vira teste vermelho em vez de bug.

---

## Fase 2 — `tunnel/perfil`

**Objetivo.** Gerar o `.conf`, e medir o MTU antes.

**Duas armadilhas medidas em 11/09, e o teste de cada uma:**

1. **`#@ws:AllowedApps` vai no bloco `[Peer]`.** No `[Interface]` é descartado em silêncio e o
   túnel leva a máquina inteira. Teste: asserção explícita sobre a posição da linha no texto
   gerado — depois de `[Peer]` e do comentário `# [Peer] WireSock extensions`.
2. **MTU medido, nunca fixo.** O link de teste é PPPoE, 1492. Busca binária com `ping -f -l`
   (Windows) ou `ping -M do -s` (Linux), e `MTU = medido - 80`. No Linux dentro de um túnel
   aninhado, descontar 80 outra vez. Teste: a busca contra um "caminho" dublado devolve o valor
   esperado nas bordas.

**Como se prova de verdade:** um perfil gerado por esta unidade, importado no WireSock, tem que
resultar em `AllowedApps=Discord` no log do serviço. É teste manual, uma vez, e vale mais que
qualquer asserção sobre texto. **Ainda não feito** — depende da fase 3 para importar.

### O que a fase mediu

Feita em `streamFix/tunnel/perfil.ts`, 21 testes em `tests/perfil.test.cjs`. A busca binária foi
rodada de verdade, pelas funções de produção, e devolveu **1492 / 1412** — os mesmos números que
haviam sido encontrados na mão em 11/09. A unidade reproduz a medição manual.

**Descoberta que muda a fase 4: a VPS não responde echo.** A primeira medição, contra
`159.112.151.37`, devolveu `null`. O host aceita ICMP (`-A INPUT -p icmp -j ACCEPT`, e
`icmp_echo_ignore_all = 0`); quem descarta é a **security list da OCI**, que por padrão libera só
`fragmentation needed` (tipo 3 código 4) e não o echo (tipo 8).

Consequências:

- O código ganhou `medirMtuComAlternativas`, que tenta a saída própria primeiro e cai para
  `8.8.8.8` / `1.1.1.1`. Medir contra outro host não falseia nada: o gargalo é o link de casa,
  presente em todo caminho que sai da máquina. E uma saída de terceiro (D9) pode ser igual ou
  pior, então a alternativa é necessária de qualquer jeito.
- **Item para a fase 4:** liberar ICMP tipo 8 na security list da saída própria, para que a
  medição use o caminho real. Opcional, não bloqueante.

**Duas decisões tomadas na implementação, que a spec não tinha:**

1. **`null` não vira chute.** Nenhuma resposta significa "não sei" — ICMP bloqueado, saída fora
   do ar, rede caída chegam todos aqui iguais. Devolver um número seria repetir o erro do 1420
   fixo com mais confiança.
2. **A leitura do `ping` procura o sucesso, nunca a falha.** `TTL=` aparece em toda resposta que
   chegou, em qualquer idioma. Casar com `"Packet needs to be fragmented"` daria "cabe" em toda
   máquina em português — e esta é uma.

---

## Fase 3 — `tunnel/controle`

**Depende da fase 2** (precisa de um perfil para subir).

**Interface** (da spec, seção 3.3):

```
subir(perfil) → { ok, saida } | { ok: false, motivo }
derrubar()
estado() → "conectado" | "fora" | "desconhecido"
```

**Duas implementações** (correção 1): `wiresock-connect-cli.exe` no Windows, `wg-quick` no
Linux. A seleção é por plataforma, no mesmo lugar em que o wrapper de injeção já escolhe build.

**`estado()` não confia no CLI.** A verificação que vale é o `localAddress` de
`getStats().transport`, que vem de dentro da conexão que importa. O CLI dizer "conectado" e a
mídia sair pelo Brasil é um estado possível — e é exatamente o tipo de mentira que este projeto
já comeu. Isso implica que `estado()` precisa de um caminho do nativo ao renderer, ou que o
porteiro (fase 5) faça a leitura e o nativo só reporte o que o CLI sabe. **Escolher na fase 5**,
quando o consumidor existir.

**Como se prova:** CLI dublado para os caminhos de erro; teste manual para o caminho real.
Medido: a conexão leva ~793 ms e captura um Discord já aberto.

---

## Fase 4 — Provisionamento

**Duas metades**, e a do servidor pode andar em paralelo com tudo.

**Servidor** (`api/` ou equivalente, na VPS): recebe `{convite, chavePublica}`, valida, escolhe
o próximo endereço livre, acrescenta o peer com `wg set` e persiste no `.conf`. Devolve
`{endereco, chavePublicaDoServidor, endpoint, faixa}`.

Testes: convite inválido, convite já usado, faixa cheia, chave pública malformada, e — o que é
fácil esquecer — dois registros simultâneos não podem receber o mesmo endereço.

**Cliente**: gera o par localmente, envia só a pública, recebe os dados da saída. A privada
nunca sai da máquina, e não aparece em log, em erro ou em relatório de diagnóstico.

**Nota operacional:** uma interface WireGuard basta. O arranjo de duas interfaces de 12d era
exigência do laboratório — o WireSock rouba o tráfego de volta quando duas pontas na **mesma
máquina** falam com o mesmo `IP:porta`. Em uso real a colisão não existe.

---

## Fase 5 — O porteiro do Go Live

**Depende das fases 1 e 3.** É aqui que a decisão D7 vira código.

**Comportamento:** ao clicar em Go Live, verificar túnel de pé **e** saída estrangeira pelo
`localAddress`. Faltando qualquer um, bloquear com o motivo na tela e oferecer subir o túnel.

**O gancho existe, e é melhor do que se esperava.** Investigado no bundle em 11/09/2026
(Discord 1.0.9257): o módulo que contém `startStreamWithSource` exporta uma função assíncrona
que **já tem protocolo de recusa próprio** — ela retorna `[false, "no user or channel"]`,
`[false, "no source"]` e `[false, "no permission"]` em três caminhos, e `[true, undefined]` no
sucesso.

Ou seja, recusar não precisa ser inventado: a interface do Discord já sabe lidar com uma recusa
vinda dali. O patch prefixa uma verificação ao corpo da função e retorna a mesma forma:

```
const r = await $self.antesDeTransmitir();
if (!r.ok) return [!1, r.motivo];
```

**Âncora do patch:** a string literal `startStreamWithSource`, que aparece no módulo tanto no
logger quanto em `{location:...}`. É estável o bastante; o teste de regressão é o próprio
`find` falhar, que o Vencord reporta alto.

**E o aviso do monitor** entra junto: veredito `quebrado` com causa `entrega` diz "a transmissão
precisa ser recriada"; causa `captura` diz "o problema é local, recriar não adianta". Só avisa
— D4.

---

## Fase 6 — O fluxo de assistir

**Depende da fase 3.**

Ao entrar numa transmissão: subir o túnel, confirmar a saída, entrar, e derrubar 10 s depois.

**O gancho existe, mas é síncrono — e isso decide o desenho.** O módulo 401843 (3 KB) exporta
`A9` (entrar na transmissão) e `Nl` (entrar e focar). As duas **despacham `STREAM_WATCH` e
retornam**; não são assíncronas. Não dá para esperar o túnel dentro delas sem torná-las
assíncronas e mudar a ordem para quem as chama.

**Portanto o padrão não é segurar, é abortar e repetir:**

```
intercepta → túnel de pé? ─não─▶ não entra, avisa "preparando…", sobe o túnel,
                                  e chama a função original de novo
             └─sim─▶ segue
```

Pior que segurar, e suficiente: por 12f, se alguém escapar e entrar sem túnel, o estrago é só
dele. O risco a vigiar é o laço — a repetição tem que ser de uma tentativa só, nunca reentrante.

**Âncora do patch:** a string `Cannot join a null voice channel`, literal e única no módulo.

**Dois pontos não medidos, e vale medir antes de escrever:**
- Subir o túnel no meio de uma call causa soluço na voz?
- Entrar na transmissão dentro dos 10 s é folga suficiente em conexão lenta?

---

## Fase 7 — Instalador

**Depende das fases 2 e 4.**

Acrescenta ao fluxo existente: medir MTU, gerar chave, pedir e enviar o convite, instalar o
WireSock se faltar, escrever o perfil. **Aqui nasce a elevação** (correção 3), uma vez só.

**Tudo num passo.** Dois instaladores separados dobram a chance de alguém ficar com metade
montada — que é o pior estado possível, porque parece pronto.

**Como se prova:** os testes de instalador já existem em `installer/tests/`. Acrescentar: sem
convite, com convite inválido, sem rede, com WireSock já instalado, e — o mais importante —
**instalação interrompida no meio não pode deixar o plugin ligado sem túnel configurado.**

---

## Fase 8 — Entrega e validação

Com os seus amigos, que é o que a resposta ao Q3 pediu. Só depois disso o README muda e as
pessoas que estão no escuro desde 03/09 recebem a explicação.

**O teste negativo entra aqui como item obrigatório de aceitação:** com o túnel ligado, um
processo que não é o Discord tem que continuar saindo pelo IP brasileiro. Foi ele que pegou o
`AllowedApps` sendo descartado em silêncio, e é a única defesa contra o pior modo de falha
deste projeto — o teste que passa medindo outra coisa.

---

## Ordem e dependências

```
  0 (remover proxy) ─────┐
  1 (coletor) ───────────┼──▶ 5 (porteiro) ──┐
  2 (perfil) ──▶ 3 (controle) ──▶ 6 (assistir) ──┼──▶ 8 (entrega)
  4 (provisionamento) ──▶ 7 (instalador) ────┘
```

Podem começar já, em paralelo: **0**, **1**, **2** e a metade servidor da **4**.

O caminho crítico passa por 2 → 3 → 5/6.

**O que era o maior risco do plano — o gancho de interceptação — foi investigado em 11/09 e
está resolvido.** Os dois pontos existem e as âncoras estão registradas nas fases 5 e 6. O
desenho do porteiro não muda; o do fluxo de assistir muda de "segurar" para "abortar e
repetir".

O maior risco que sobra é a fase 7, a elevação no instalador, porque é a única que mexe em
privilégio e a única sem precedente no projeto.

---

## O que este plano não faz

- **macOS.** Fora do escopo, como no resto do projeto.
- **Refinamento de voz direta.** Seção 7 da spec. Depende de faixas de IP que ninguém levantou,
  e otimizar latência antes de a entrega funcionar em uso real é otimizar a coisa errada.

  Um achado da investigação do gancho que servirá a ele: o módulo 401843 exporta `dA`, que faz
  `PATCH /streams/{key}` com `{region}`. **Dá para mudar a região de uma transmissão já
  criada**, sem recriá-la — o que eu tinha assumido ser impossível ao escrever a spec.
- **Recuperação automática.** D4: o monitor só avisa até provar que acerta com gente real.
