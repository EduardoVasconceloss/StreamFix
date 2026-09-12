# Plano de implementação: túnel em dois níveis

Implementa `docs/superpowers/specs/2026-09-11-tunel-em-dois-niveis-design.md`. A spec responde
*o quê* e *por quê*; este plano responde *em que ordem* e *como se prova cada passo*.

Base medida: `docs/research/regressao-encoder-inativo-2026-09-03.md`, seções 12g e 12h.

---

## Estado

| fase | estado |
|---|---|
| 0 — medições que bloqueiam | **feita** em 12/09 (pesquisa, 12i). A câmera exige a voz nascida no completo; a spec foi revista (E8–E10, unidade `voz`) |
| 1 — controle: dois perfis | **feita** em 12/09. `perfilDeControle` mora no `perfil.ts`, não no `controle.ts`: o provisionador só carrega o `perfil.ts` |
| 2 — perfil e provisionador | **feita** em 12/09 |
| 3 — instalador | **feita** em 12/09, menos o item 5 (vai com a fase 5) e o critério de rodar o instalador inteiro (vai para a fase 8). Ver "O que a fase 3 achou" |
| 4 — empréstimos e voz | **feita** em 12/09 |
| 5 — plugin | **feita** em 12/09, com o item 5 da fase 3, e provada na fase 8. Ver "O que a fase 5 fez" |
| 6 — porteiro | **feita** em 12/09, e provada na fase 8 |
| 7 — Trava 1 e diagnóstico | **feita** em 12/09, e provada na fase 8. Ver "O que as fases 6 e 7 fizeram" |
| 8 — validação e entrega | itens 1 e 4 **feitos** em 12/09 (o `instalacao.gif` segue pendente). Faltam os itens 2 ou 3 (amigos) e o 6 (release). Ver "O que a fase 8 mediu" |

**Ordem.** A fase 0 pode derrubar o desenho, então vem antes de qualquer código. As fases 1 a
4 são independentes do Discord e podem ir juntas. A 5 depende de 1 e 4, e a 6 e a 7 dependem
da 5. Nada chega a quem usa antes da fase 8. Enquanto o perfil de controle não existir na
máquina, o plugin novo se comporta como o de hoje (E5), então as fases 1 a 7 podem ir para a
`main` sem mudar nada para quem já usa.

---

## O que já existe e entra de graça

| | estado |
|---|---|
| Perfil de teste `streamfix-controle` na máquina do usuário | importado em 11/09, mesma chave do `streamfix-santiago`. **Apagar na fase 8.** |
| Montagem de teste Windows + WSL2 com CDP local | de pé; scripts no scratchpad da sessão de 11/09 |
| Leitura da atribuição da Trava 1 | `getServerAssignment` já está no `/streamfix` |
| O ciclo aborta-troca-repete de quem assiste | fase 6 do plano anterior, `entrada.ts` |
| Conferência de `AllowedApps` a cada `connect` | `controle.subir` |

---

## Fase 0 — Medições que bloqueiam

Na montagem de 12g: Windows (`dudiss1`) transmitindo, WSL2 (`dudivis1`) assistindo pelo `wg1`,
leitura por CDP em `127.0.0.1`. O perfil `streamfix-controle` já existe no Windows.

### 0.1 A câmera com a voz nascida pelo Brasil

**Por que primeiro:** se a câmera quebrar, o desenho precisa de mais uma peça (empréstimo na
câmera, talvez com reconexão da voz). Isso muda as fases 4 e 5.

1. Windows no controle. Entrar na call, para que a voz nasça pelo Brasil (conferir
   `localAddress` brasileiro e ping ~33 ms).
2. Ligar a câmera. Se não houver webcam, serve a câmera virtual do OBS.
3. No WSL, com túnel, ler os quadros de vídeo recebidos na conexão `default`.
4. **Controle negativo:** WSL sem túnel, conexões novas, ler de novo.

**Resultado que decide:** chegam quadros no passo 3? Se sim, a câmera não precisa de nada. Se
não, repetir com o completo no ar **antes** de entrar na call, para confirmar que é o IP da voz
que conta, e a spec ganha a seção da câmera.

### 0.2 A folga depois do nascimento

1. Windows no controle. Clique em Go Live com a troca para o completo feita à mão.
2. Voltar ao controle **N segundos** depois de a conexão `stream` ficar `CONNECTED`.
3. Um minuto depois, o WSL (com túnel) entra do zero, **sem conexão de stream sobrando**. A
   armadilha de 12g é esta: tirar o espectador da call e esperar o motor de mídia ficar sem
   conexões.
4. Repetir com N = 10, 5, 2 e 0.

**Resultado:** o menor N que entrega, com uma margem em cima, vira `FOLGA_NASCIMENTO_MS`.

### 0.3 O soluço da troca de perfil

Amostrar `packetsReceived` da conexão `default` a cada 250 ms durante dez trocas, nos dois
sentidos, com alguém falando do outro lado. Registrar o maior buraco. Não bloqueia sozinho, mas
entra na seção 2 da spec e no README.

**Critério de saída da fase:** as três respostas registradas na pesquisa, como seção 12i.

---

## Fase 1 — `controle`: dois perfis

Arquivo: `streamFix/tunnel/controle.ts`.

1. **`estadoDoStatus` com nome exato.** O perfil é casado como token, sem letra, dígito, `-` ou
   `_` colado antes ou depois. Hoje é `includes`, e `streamfix-santiago` casa dentro de
   `streamfix-santiago-controle`.
2. **`perfilAtivo(candidatos: string[]): string | null | "desconhecido"`**, a partir do mesmo
   `status`.
3. **`trocar(para: string)`**: se `para` já está ativo, não faz nada. Senão faz `derrubar()` e
   depois `subir(para)`, com a conferência de `AllowedApps` de hoje. Mede e devolve a duração.
4. **`perfilDeControle(perfil)`** como função pura, `"<perfil>-controle"`, usada pelo plugin e
   espelhada pelo instalador.

**Testes** (`tests/controle.test.cjs`):
- `estadoDoStatus("... perfil streamfix-santiago-controle", "streamfix-santiago")` é `fora`,
  e o contrário também.
- `trocar` com CLI dublado: o `connect` num perfil com outro já no ar é recusado sem log. O teste
  exige `disconnect` antes, na ordem.
- `trocar` para o perfil que já está ativo não chama nada.

**Critério:** a suíte verde, e o teste de nome contido falhando no código de hoje. Provar isso
revertendo a mudança uma vez.

---

## Fase 2 — `perfil` e provisionador

Arquivos: `streamFix/tunnel/perfil.ts`, `installer/provisiona.mjs`.

1. `FAIXA_CONTROLE = "162.159.128.0/17, 1.1.1.1/32"` em `perfil.ts`, com o comentário do que foi
   medido e de onde (12h), e do que acontece se ficar curta (E6 pega).
2. `provisiona.mjs` grava dois arquivos a partir do **mesmo** registro: `<arquivo>` com
   `destinos` padrão e `<base>-controle.conf` com `FAIXA_CONTROLE`. Os dois com modo 0600.
   O nome do arquivo é o nome do perfil (medido na fase 3 anterior: o WireSock ignora qualquer
   outro).
3. A saída JSON do provisionador passa a trazer os dois caminhos.

**Testes:** `perfil.test.cjs` gera os dois textos e confere que só a linha `AllowedIPs` difere.
`provisiona` com `--mtu-do-caminho` (sem rede) grava os dois arquivos e nenhum outro.

---

## Fase 3 — Instalador

Arquivo: `installer/StreamFix-Installer.ps1`, mais `Diagnostico-Tunel.ps1` e
`Verifica-Tunel.ps1`.

1. **Instalação nova:** `Import-TunnelProfile` para os dois. Conecta o de **controle** antes de
   abrir o Discord.
2. **Reinstalação:** se o completo existe e o de controle não, derivar o de controle pelo
   caminho do `Repair-TunnelProfile`: exportar, reescrever só a linha `AllowedIPs`, gravar
   como `<perfil>-controle.conf`, importar, apagar no `finally`. Sem convite, sem chave nova.
   Se o completo estiver com a rota errada da época do bug, consertar primeiro, como hoje.
3. **`Connect-Tunnel($cli, $profile, $rotaEsperada)`**: a rota conferida passa a ser parâmetro.
   `0.0.0.0/0` para o completo, `FAIXA_CONTROLE` para o de controle.
4. **Todo `-match [regex]::Escape($profile)` sobre o `status` vira casamento exato**, pela mesma
   regra da fase 1. São pelo menos quatro lugares (`Repair-TunnelProfile`, `Connect-Tunnel`,
   `Install-Tunnel`, e o diagnóstico).
5. `Set-PluginSettings` grava `tunelCompletoSempre = false` quando ausente. O
   `tunelPermanente` antigo deixa de ser escrito.
6. `Diagnostico-Tunel.ps1` e `Verifica-Tunel.ps1` reconhecem os dois perfis e dizem qual está no
   ar. O teste negativo (processo que não é o Discord sai pelo Brasil) continua valendo para os
   dois.

**Testes** (`tests/instalador.test.cjs`, `tests/release.test.cjs`):
- Drift: a faixa que o `Connect-Tunnel` espera do controle é textualmente a `FAIXA_CONTROLE`
  do `perfil.ts`.
- Nenhum `-match [regex]::Escape($profile)` sobrando contra saída do `status`.
- O arquivo derivado morre no `finally`, como o do `Repair-TunnelProfile`.

**Critério:** rodar o instalador na máquina do usuário **sem** `-Reprovision`. Ele cria o
perfil de controle a partir do existente, não pede convite, e deixa o controle no ar. O
`streamfix-controle` de teste é apagado antes, para não confundir.

### O que a fase 3 achou (12/09)

- **O item 5 foi adiado para a fase 5.** Trocar `tunelPermanente` por `tunelCompletoSempre` no
  `Set-PluginSettings` quebra o teste que exige que o instalador escreva exatamente as
  configurações que o plugin declara. As duas pontas mudam juntas.
- **O instalador e o plugin têm de sair na mesma release.** Com o instalador novo, o controle
  fica no ar quando o Discord abre. O plugin de hoje, com `tunelPermanente`, tenta conectar o
  completo, o `connect` é recusado porque há outro perfil no ar, e o porteiro vê o túnel fora.
  Nenhuma release pode sair entre a fase 3 e a fase 5.
- **Dois defeitos que os testes de texto não pegavam**, encontrados rodando as funções no
  Windows PowerShell 5.1: `"perfil $controle: ..."` (o PowerShell lê como variável com escopo e
  recusa o arquivo **inteiro**), e o DNS duplicado em todo perfil derivado. O segundo já existia
  no `Repair-TunnelProfile`. Virou teste: `instalador.test.cjs` roda o parser e as funções puras
  no PowerShell de verdade, no Windows.
- **O `Verifica-Tunel` dava alarme falso com o controle no ar.** Ele tirava a saída do
  "endereço externo" do `status`, que no controle é o IP de casa, porque a consulta de
  geolocalização do WireSock não passa pela faixa. Agora, no controle, a saída sai do `Endpoint`
  do perfil completo. E o teste negativo passou a consultar `1.1.1.1`, que está nas duas rotas:
  `cloudflare.com` fica fora da faixa de controle e passaria mesmo com o `AllowedApps` quebrado.
  `discord.com` recusa esse caminho (403).
- **O log do `connect` escreve a rota sem espaço** (`162.159.128.0/17,1.1.1.1/32`), e o perfil
  escreve com espaço. As comparações ignoram espaços.
- **Rodado contra o WireSock real:** derivar, conferir a faixa, trocar nos dois sentidos com a
  rota conferida pelo log, recriar por cima, e nenhum arquivo com chave sobrando no TEMP. O
  `streamfix-santiago-controle` existe agora nesta máquina, e o `streamfix-controle` de teste
  foi apagado.

---

## Fase 4 — Empréstimos e voz

Duas unidades puras e sem imports, como `entrada.ts`.

**`streamFix/tunnel/emprestimos.ts`:**

```ts
type Nivel = "controle" | "completo";
interface Emprestimos {
    pegar(motivo: "voz" | "transmitir" | "assistir"): number;   // devolve um id
    devolver(id: number): void;                                  // idempotente
    nivelDesejado(): Nivel;                                      // completo se houver algum em aberto
}
```

A política fica fora do contador: `tunelCompletoSempre`, ou a falta do perfil de controle, faz o
nível desejado ser sempre o completo. Isso é uma função `nivel(situacao)` separada, também pura.

**`streamFix/tunnel/voz.ts`** (spec, 4.6): uma máquina de estados pequena, por nascimento de
conexão de voz. Entrada: o evento (`selecionou`, `conectando`, `conectada` com o
`localAddress`, `saiu`) e a saída esperada. Saída: `pegar`, `devolverDepoisDaFolga`,
`resgatar`, `avisarEDevolver` ou nada. Guarda só se há empréstimo aberto e se o nascimento
atual já é um resgate.

**Testes:**
- empréstimos sobrepostos (voz, transmitir e assistir), devolução dupla, devolução de id que não
  existe, e a política forçando o completo com o contador vazio;
- `voz`: cada linha da tabela 4.6 da spec; `selecionou` seguido de `conectando` abre **um**
  empréstimo, não dois; o `conectando` gerado pelo resgate não abre outro, e o resgate que
  renasce no Brasil termina em `avisarEDevolver`, sem segundo resgate; `saiu` com empréstimo
  aberto devolve; `localAddress` nulo devolve sem resgate.

---

## Fase 5 — Plugin

Arquivos: `streamFix/index.tsx`, `streamFix/native.ts`.

1. **`native.ts`** expõe `trocarTunel(perfil)` e `perfilAtivo(candidatos)`.
2. **Aplicar o nível** é uma função só, serializada: pede ao nativo a troca para o perfil do
   nível desejado, e só uma troca roda por vez. Uma troca pedida durante outra espera e depois
   reconfere o nível desejado, que pode ter mudado.
3. **`start()`**: se o perfil de controle existe e `tunelCompletoSempre` está desligado, aplicar
   o controle. Senão, o completo, que é o comportamento de hoje.
4. **Go Live** (`antesDeTransmitir`): pega um empréstimo `transmitir` e **espera** a troca.
   Deu certo: libera. Deu errado: devolve o empréstimo e recusa com o motivo. Some o "clique de
   novo em alguns segundos".
5. **Nascimento:** no `RTC_CONNECTION_STATE` com `context: "stream"` e `RTC_CONNECTED`, sendo a
   transmissão **nossa** (conferir que o payload diz de quem é o stream, ou cruzar com
   `getCurrentUserActiveStream`), esperar `FOLGA_NASCIMENTO_MS` e devolver o empréstimo. Se a
   transmissão acabar antes, `STREAM_DELETE` devolve.
6. **Assistir** (`antesDeAssistir`): o ciclo da fase 6 fica, trocando "subir" por "pegar
   empréstimo e aplicar" e "derrubar em 10 s" por "devolver em 10 s". `deveDerrubarDepois` e
   `tunelConhecido` saem, porque o contador faz o papel dos dois.
7. **Voz** (E8, E9): `flux` para `VOICE_CHANNEL_SELECT` (com canal) e `RTC_CONNECTION_STATE`
   com `context: "default"`, alimentando `voz.ts`. No `RTC_CONNECTED`, ler o `localAddress` da
   conexão `default` do motor de mídia, com até três tentativas curtas, porque o `getStats`
   pode vir vazio logo no primeiro instante. O resgate espera o completo ficar no ar e chama
   `RTCConnectionStore.getRTCConnection().reconnect()`. Nenhum desses caminhos pode lançar
   exceção para dentro do Discord: `try` em volta de tudo, e falha vira devolução.
8. **`stop()`**: devolve tudo e aplica o completo. Desligar o plugin não pode deixar a pessoa no
   controle sem porteiro nenhum.
9. Sai a configuração `tunelPermanente` e o comentário da D9. Entra `tunelCompletoSempre`.
   **Junto**, o item 5 da fase 3: o `Set-PluginSettings` do instalador passa a gravar
   `tunelCompletoSempre = false` quando ausente e deixa de gravar `tunelPermanente`.

**Testes:** o patch do Go Live continua casando uma vez só (`patch-go-live.test.cjs`). O de
assistir também (`patch-assistir.test.cjs`). A lógica de quando pegar e devolver fica em unidades
puras (fase 4 e `entrada.ts`). O resto é fiação, provada na fase 8.

**Pendência herdada, que continua:** a verificação de tipos completa exige compilar dentro de um
checkout do mod. Fazer num checkout **separado** do que o Discord do usuário carrega.

### O que a fase 5 fez (12/09)

- **A verificação de tipos saiu sem checkout nenhum.** Um `tsconfig` no scratchpad que estende o
  do Vencord, com `rootDir` acima dos dois repositórios e os `.d.ts` globais do mod no
  `include`, verifica `streamFix/` inteiro contra os tipos do mod sem copiar nem mexer em nada.
  Achou um erro **anterior** a esta fase: `const dados = []` no `leituraDaMidia` vira `never[]`
  com o `noImplicitAny: false` do mod. Corrigido com o tipo do coletor.
- **`controle.existe(perfil)`**, que o plano não previa: o `start` precisa saber se o perfil de
  controle está importado, e só a `list` diz isso. Na dúvida, `false`, que é o completo (E5).
- **O dono do stream** passou a ser o último pedaço da chave (`donoDoStream`, no `porteiro.ts`).
  O `includes(meuId)` de antes aceitava uma transmissão alheia num servidor ou canal cujo id
  contivesse o nosso. O `RTC_CONNECTION_STATE` do stream traz a `streamKey` (lido no bundle
  1.0.9257, módulo 116956), então dá para saber de quem é o nascimento sem cruzar com store.
- **`PRAZO_NASCIMENTO_MS = 20 s`** para o empréstimo do Go Live: se a transmissão não nascer,
  nada mais o devolveria.
- **Uma troca falha tenta o outro nível.** O `subir` derruba o que subiu errado, então uma troca
  que falha pode deixar a pessoa sem túnel nenhum. Qualquer um dos dois é melhor do que isso.
- **Durante uma troca, o cache do perfil no ar vale `desconhecido`.** Sem isso, uma entrada numa
  transmissão logo depois de uma devolução leria "completo no ar" com o `disconnect` já em curso.
  Com isso, ela aborta e repete depois da troca, que é o caminho que já existia.
- **Quem assiste devolve em 10 s**, como o plano pedia, e não no nascimento do stream. Quem entra
  com o completo já no ar por outro motivo pega o seu empréstimo mesmo assim, para quem o segura
  não o devolver no meio do nascimento.
- **Plugin ligado com a call já no ar** (o Discord volta sozinho ao canal, ou o plugin foi ligado
  no meio): o `start` confere a voz depois de aplicar o nível, e o resgate cobre.
- **Itens da fase 6 que saíram aqui**, porque são a própria fiação do Go Live: em dois níveis, o
  veredito do clique é a troca ter dado certo; no completo sempre, a regra de hoje. O
  `porteiro.ts` não mudou. Falta o item 2 (a conferência depois do nascimento) e os testes dela.
- **Itens da fase 7 que saíram aqui:** o `/streamfix` mostra o modo, os dois perfis, o que o
  WireSock diz e o que o plugin acha, o nível desejado, os empréstimos, o estado da voz, a
  instrução de reinstalar sem o perfil de controle, e as últimas 15 coisas que o túnel fez (sem
  o IP de casa, porque o texto vai para suporte).

---

## Fase 6 — Porteiro

Arquivo: `streamFix/tunnel/porteiro.ts`.

1. **No clique:** a entrada do `decidir` passa a ser o resultado da troca, não o `localAddress`
   da voz. A voz anda noutra conexão e não diz nada sobre o Go Live, e quem cuida dela agora é
   `voz.ts` (spec, 4.4 e 4.6).
2. **Depois do nascimento:** função nova, `conferirNascimento(localAddressDoStream, saida)`. O
   `localAddress` da conexão de stream é lido no `RTC_CONNECTED`, antes da folga. Nesse instante
   ele ainda não envelheceu. Se não for a saída, avisar para parar e começar de novo (fato 6).
3. No modo `tunelCompletoSempre` a regra de hoje continua valendo inteira.

**Testes:** o caso de hoje que a medição de 11/09 fixou (túnel caiu, `localAddress` velho)
continua recusado no modo completo. No modo de dois níveis, voz brasileira com a troca bem feita
libera, e stream nascido com endereço brasileiro gera o aviso.

---

## Fase 7 — Trava 1 e diagnóstico

1. **A conferência (E6).** Uns segundos depois de cada `CONNECTION_OPEN`, ler a atribuição do
   servidor. Variante 1 ou 2 com o controle no ar: avisar, forçar o completo e recarregar o
   Discord **uma vez por sessão**. Guardar a marca da recarga para não entrar em laço.
2. **`/streamfix`** passa a mostrar:
   - o perfil no ar, o nível desejado e os empréstimos em aberto;
   - a atribuição do servidor e, separado, se há override de cliente (`getClientOverrides`), com
     a frase "o botão aparece, mas o servidor continua recusando sem túnel";
   - quando falta o perfil de controle, a instrução de rodar o instalador de novo.
3. Corrigir o diagnóstico: o `ask` devolve `null` para "sem atribuição", e isso deve aparecer
   como "o servidor não mandou a trava", não como `null`.

**Testes:** a leitura da atribuição como função pura sobre o formato que o `ApexExperimentStore`
devolve, com e sem override (os dois formatos foram lidos em 12h).

### O que as fases 6 e 7 fizeram (12/09)

- **Fase 6 em duas funções puras do `porteiro.ts`.** `decidirClique` junta a decisão do clique que
  a fase 5 tinha deixado na fiação (troca boa libera em dois níveis; `decidir` inteiro no
  completo sempre; troca que deixou o controle no ar não conta). `conferirNascimento` é o item 2,
  e cala quando não há leitura ou saída configurada: aviso sem prova é alarme falso.
- **A conexão de stream nossa se acha pelo `streamUserId`.** Toda conexão do motor de mídia tem
  `context` e `streamUserId` (lido em 12/09). A leitura corre junto com a folga, sem atrasá-la.
- **Fase 7 numa unidade nova, `trava.ts`**, sem imports, com a leitura (`lerTrava`), as frases
  do `/streamfix` (`descreverTrava`) e a decisão (`decidirTrava`). Formato lido em 12/09 no
  Discord aberto: a atribuição do servidor é `{ hashedName, variantId, isOverride, revision, … }`
  ou `undefined`; o override do plugin Experiments fica em `getClientOverrides()`, num mapa pelo
  nome do experimento, com `variantId: -1`. A trava são as variantes 1 e 2.
- **A decisão só age em dois níveis.** No completo sempre, a trava vir significa outra coisa (o
  túnel estava fora quando o gateway conectou, ou a saída foi marcada), e trocar de perfil não
  resolveria.
- **A marca da recarga vai no `DataStore` do Vencord.** O Discord apaga `localStorage` e
  `sessionStorage` do renderer (conferido em 12/09), e a marca precisa atravessar a recarga. Ela
  vale 60 s e é apagada na leitura, então é **uma recarga por abertura do Discord**. Se a
  leitura da marca falhar, o plugin não recarrega naquela abertura: sem saber, uma recarga
  poderia puxar outra. E só recarrega depois de o completo estar no ar; sem ele, a recarga traria
  a trava de volta e gastaria a única tentativa.
- **A conferência roda também no `start`**, depois de aplicar o nível: o gateway pode ter
  conectado antes de o plugin ligar, e aí o `CONNECTION_OPEN` já passou.
- **Não medido:** a trava vindo de verdade com o controle no ar. Daqui, a faixa cobre o
  gateway, então o caminho da recarga só se prova com alguém de outra rede (fase 8, item 2) ou
  forçando: por exemplo, um perfil de controle sem `162.159.128.0/17`.

---

## Fase 8 — Validação e entrega

1. **Ponta a ponta na montagem de 12g**, com o plugin fazendo as trocas sozinho:
   - transmitir com o WSL entrando depois da folga (tem que entregar);
   - assistir uma transmissão do WSL (inverter os papéis, se o WSL conseguir transmitir);
   - transmitir e assistir ao mesmo tempo (o contador não pode devolver cedo);
   - **câmera** ligada no Windows, com o WSL recebendo, os dois tendo entrado na call pelo
     plugin, sem troca feita à mão;
   - **reconexão de voz de verdade**: trocar a região do canal com a call no ar, e conferir
     que a voz renasce na saída (direto ou pelo resgate) e que a câmera continua;
   - ping da voz fora dos cliques perto de 35 ms;
   - **a recuperação da Trava 1:** um perfil de controle de teste sem `162.159.128.0/17`, para o
     gateway sair pelo Brasil. Tem de vir o aviso, o completo, uma recarga só, e o `/streamfix`
     dizendo "o servidor não mandou a trava" depois dela.
2. **Um amigo de outra cidade** instala do zero, e o `/streamfix` dele mostra que o servidor não
   mandou a trava. Valida a faixa de controle fora daqui.
3. **Um amigo que já usa** roda o instalador de novo sem convite e fica com os dois perfis.
4. README: a seção de como funciona e a tabela de latência. O `assets/instalacao.gif` continua
   pendente do plano anterior.
5. ~~Apagar o perfil de teste `streamfix-controle` da máquina do usuário.~~ Feito na fase 3.
6. Release. A versão é decisão do usuário.

**Critério de saída:** o item 1 inteiro, e pelo menos um dos itens 2 e 3.

### O que a fase 8 mediu (12/09)

Montagem de 12g: Windows (`dudiss1`) com o plugin novo, compilado no checkout que o Discord
carrega (`Projetos\Vencord`, com backup do plugin antigo no scratchpad da sessão); WSL2
(`dudivis1`) com o `wg0` levando tudo e o StreamFix desligado. Leitura por CDP em `127.0.0.1`.
O instalador inteiro **não** rodou: o plugin foi copiado e compilado à mão, o que cobre a fiação
mas não o `Set-PluginSettings` nem o caminho de quem reinstala (itens 2 e 3).

| teste | resultado |
|---|---|
| abrir o Discord | o plugin achou o controle e o pôs no ar sozinho; `/streamfix` em "dois níveis", "o servidor não mandou a trava", override de cliente mostrado à parte |
| entrar na call (1ª vez) | completo no clique, voz nasceu na saída, controle 4 s depois; ping 31 ms |
| entrar na call (2ª vez) | a troca **perdeu** a corrida: voz nasceu fora, o plugin resgatou com `reconnect()`, a voz renasceu na saída; ping 33 ms |
| transmitir, WSL entrando depois da folga | o clique esperou 1,7 s; com o Windows já no controle, o WSL recebeu **59,6 q/s** |
| câmera no Windows, WSL recebendo | Windows no controle, 16,6 q/s codificados, **16,6 q/s** recebidos |
| reconexão de voz de verdade (região do canal para `us-east` e de volta) | passa pelo `CONNECTING`; o plugin emprestou, a voz nasceu na saída as duas vezes, a câmera seguiu a 16,6 q/s |
| assistir uma transmissão do WSL | aborta, troca, repete; recebeu 30 q/s (a fonte do WSL) antes e depois da devolução em 10 s |
| transmitir com a voz reconectando no meio, e assistindo o WSL | voz e stream nasceram na saída; o contador só voltou ao controle depois dos dois; os dois sentidos e a câmera seguiram no controle (60, 30 e 16,6 q/s) |
| Trava 1 forçada (controle só com `1.1.1.1/32`) | a trava veio, completo, **uma** recarga; depois dela, "aberto por uma recarga pela trava", completo, e o servidor não mandou mais a trava. Controle verdadeiro recriado depois, sem arquivo com chave no TEMP |

**O que a fase 8 corrigiu:**

- **A troca levava ~2,7 s, e não os 1,25 s de 12i.** O `trocar` herdava do `subir` a espera
  pelo endereço externo no `status`: até 4 leituras, com 0,5 s entre elas. Cada `status` leva
  ~220 ms, e o endereço só aparece segundos depois do `connect`. A troca não usa esse endereço
  (no controle ele é o de casa). Sem a espera, a troca caiu para ~1,75 s, e o clique do Go Live
  espera ~1,7 s. Teste novo em `controle.test.cjs`.
- **O `/streamfix` no chat cortava em 1800 caracteres**, e o corte levava o registro do túnel.
  Agora vai em partes, quebrando por linha. A cópia para a área de transferência já vinha inteira.
- O registro anotava como troca o `status` que só confirmava o perfil já no ar (~330 ms); o
  limite subiu para 600 ms. E o modo passou a dizer quando é a trava que força o completo.

**O que ficou registrado, sem bloquear:**

- **A troca pode derrubar a sinalização da voz que está nascendo.** Na volta da região para
  automático, o `disconnect` da troca pegou a voz no meio do `AUTHENTICATING`; o Discord repetiu
  sozinho e ela nasceu na saída, mas levou 6,3 s em vez de ~3 s. É o mesmo efeito que em 12i
  atrasava a entrada e fazia a troca ganhar a corrida.
- **A corrida da entrada foi perdida uma vez em duas**, logo depois de o Discord abrir. O resgate
  cobriu, como a spec previa (E8).
- O `DiscordNative.clipboard` é um objeto congelado do Electron: para ler o `/streamfix` por CDP,
  a leitura é pela mensagem local do bot (`MESSAGE_CREATE` no canal `0`).
