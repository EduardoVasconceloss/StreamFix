# Plano de implementação: túnel nas duas pontas

Implementa `docs/superpowers/specs/2026-09-11-tunel-nas-duas-pontas-design.md`. A spec responde
*o quê* e *por quê*; este plano responde *em que ordem* e *como se prova cada passo*.

Diagnóstico de origem em `docs/research/regressao-encoder-inativo-2026-09-03.md`, seções 12 a
12f. Substitui `2026-09-08-tunel-momentaneo-plan.md`, cuja spec caiu.

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
qualquer asserção sobre texto.

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

**O ponto difícil e ainda não resolvido: onde enganchar.** Os dois patches atuais são
substituições de expressão — servem para trocar um valor, não para abortar uma ação. Bloquear
exige interceptar o disparo da criação da transmissão. Isso precisa de investigação no bundle
antes de virar tarefa, e é o maior risco técnico do plano.

**Se não houver gancho confiável**, a alternativa é avisar de forma inescapável em vez de
bloquear — pior, mas honesto, e ainda muito melhor que o silêncio de hoje. Decidir com o bundle
na mão, não agora.

**E o aviso do monitor** entra junto: veredito `quebrado` com causa `entrega` diz "a transmissão
precisa ser recriada"; causa `captura` diz "o problema é local, recriar não adianta". Só avisa
— D4.

---

## Fase 6 — O fluxo de assistir

**Depende da fase 3.**

Ao entrar numa transmissão: subir o túnel, confirmar a saída, entrar, e derrubar 10 s depois.

**Mesmo risco de gancho da fase 5**, agravado: aqui não basta observar, é preciso **segurar** a
entrada até o túnel confirmar. Se não der para segurar, o fluxo degrada para "avisa e deixa a
pessoa decidir" — e por 12f o estrago de entrar sem túnel é só dela.

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

O caminho crítico passa por 2 → 3 → 5/6. E o maior risco não é nenhuma dessas: é o gancho de
interceptação das fases 5 e 6. **Vale investigar o bundle antes de começar a fase 0**, porque
se não houver gancho, o desenho do porteiro muda — e é melhor saber disso com o código antigo
ainda de pé.

---

## O que este plano não faz

- **macOS.** Fora do escopo, como no resto do projeto.
- **Refinamento de voz direta.** Seção 7 da spec. Depende de faixas de IP que ninguém levantou,
  e otimizar latência antes de a entrega funcionar em uso real é otimizar a coisa errada.
- **Recuperação automática.** D4: o monitor só avisa até provar que acerta com gente real.
