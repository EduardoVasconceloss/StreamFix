# Instalação de mods de Discord no macOS

Pesquisa para portar o `installer/streamfix-installer.sh` (hoje só Linux) para macOS. Fontes primárias: código do Equilotl (fork do Vencord Installer, usado pelo Equicord), código do Vencord/Vesktop, e documentação da Apple. Cada afirmação cita de onde veio.

Repos lidos direto (clone raso, commits de 2026-08-20):
- `github.com/Equicord/Equilotl` (Go, instalador oficial do Equicord/Vencord para as três plataformas)
- `github.com/Vendicated/Vencord` (o mod em si, `src/main/utils/constants.ts` e `src/main/patcher.ts`)
- Não achei `github.com/Vencord/Installer` como repo separado ativo: o Equilotl é literalmente esse instalador, com o cabeçalho de licença ainda dizendo "Vencord Installer, a cross platform gui/cli app for installing Vencord". Tratei o Equilotl como a fonte de verdade para os dois mods.

## 1. Layout do Discord no macOS

Não existe bootstrap no macOS. O `app.asar` fica dentro do bundle, em `Contents/Resources`, do jeito antigo que o Linux tinha antes da 1.0.136.

Fonte: `equilotl-src/find_discord_darwin.go`, função `ParseDiscord`:

```go
resources := path.Join(p, "/Contents/Resources")
if !ExistsFile(resources) {
    return nil
}
isPatched := ExistsFile(path.Join(resources, "_app.asar"))
if !isPatched && !ExistsFile(path.Join(resources, "app.asar")) {
    return nil
}
```

`FindDiscords()`, no mesmo arquivo, procura só em dois lugares:

```go
bases := []string{
    "/Applications",
    path.Join(os.Getenv("HOME"), "Applications"),
}
```

com o mapa `macosNames`:

```go
var macosNames = map[string]string{
    "stable": "Discord.app",
    "ptb":    "Discord PTB.app",
    "canary": "Discord Canary.app",
    "dev":    "Discord Development.app",
}
```

Ou seja: `Discord.app`, `Discord PTB.app`, `Discord Canary.app` e `Discord Development.app`, cada um em `/Applications` ou em `~/Applications`. Nada de varredura de `~/.config` ou de uma pasta `app-*` dentro do HOME. A comparação é direta com o esquema do Linux: `find_discord_linux.go` tem um bloco de `init()` inteiro tratando `SUDO_USER`/`DOAS_USER` e HOME (ver seção 5), e o comentário do `discord_resources()` no `streamfix-installer.sh` (linhas 160-165) descreve o bootstrap de maio de 2026 que baixa o app de verdade para dentro do `~/.config`. O `find_discord_darwin.go` não tem nada equivalente: `ParseDiscordNew` (a função que trataria um esquema novo, tipo o bootstrap) existe só como stub que sempre retorna `nil`:

```go
func ParseDiscordNew(p, branch string, isFlatpak bool) *DiscordInstall {
    return nil
}
```

Isso é o mesmo padrão em `find_discord_windows.go` e `find_discord_linux.go` (ambos implementam `ParseDiscordNew` de verdade, tratando o caso novo). No macOS o stub nunca foi preenchido, o que é evidência direta, pelo próprio código do instalador oficial, de que o esquema de bootstrap não existe lá: a Discord Inc. atualiza o `.app` inteiro via Squirrel.Mac (`electron.autoUpdater`) trocando o bundle em `/Applications`, não baixando um app novo para dentro do HOME.

Confirma isso também um efeito colateral do próprio design do Squirrel.Mac, citado em terceiros mas consistente com o código acima (não achei doc oficial da Discord sobre isso, então trato como corroboração, não como fonte primária): o updater da Squirrel.Mac substitui o bundle assinado inteiro a cada atualização, ao contrário do NSIS/Squirrel.Windows ou dos pacotes Linux recentes, que separam bootstrap e payload.

## 2. Dados de usuário e settings

O caminho vem do Electron, não de uma constante hardcoded do mod. `src/main/utils/constants.ts` do Vencord:

```ts
export const DATA_DIR = process.env.VENCORD_USER_DATA_DIR ?? (
    process.env.DISCORD_USER_DATA_DIR
        ? join(process.env.DISCORD_USER_DATA_DIR, "..", "VencordData")
        : join(app.getPath("userData"), "..", "Vencord")
);
export const SETTINGS_DIR = join(DATA_DIR, "settings");
```

`app.getPath("userData")` é API do Electron; no macOS ela resolve para `~/Library/Application Support/<productName>`, onde `<productName>` para o Discord é `discord` (o nome interno do produto, minúsculo, o mesmo em qualquer plataforma). `DATA_DIR` sobe um nível a partir dali e cria uma pasta irmã chamada `Vencord`. Resultado: `~/Library/Application Support/Vencord/settings/settings.json`. Para o Equicord o Equilotl usa a mesma lógica, mas com `appdir.New("Equicord").UserConfig()` (`equilotl-src/patcher.go`, bloco `init()`), que no macOS resolve pela biblioteca `go-appdir` também para `~/Library/Application Support/Equicord` (não abri o código do `go-appdir` para confirmar o valor exato, então isto fica marcado como inferência razoável, não conferida linha a linha).

`patcher.go` do Equilotl tem a mesma ideia de override por variável de ambiente que o Vencord:

```go
if dir := os.Getenv("EQUICORD_USER_DATA_DIR"); dir != "" {
    BaseDir = dir
} else if dir = os.Getenv("DISCORD_USER_DATA_DIR"); dir != "" {
    BaseDir = path.Join(dir, "..", "EquicordData")
} else {
    BaseDir = appdir.New("Equicord").UserConfig()
}
```

Isso é o equivalente direto do `mod_settings_file()` que o `streamfix-installer.sh` já implementa para Linux (linhas 672-694), incluindo a checagem de `<MOD>_USER_DATA_DIR`. Para macOS a única mudança necessária nessa função seria trocar `$HOME/.config/$mod` por `$HOME/Library/Application Support/$mod`, mantendo a checagem da variável de ambiente igual.

## 3. O instalador (Equilotl) no macOS

Existe build para os dois formatos de CPU: confirmado pelos assets da release mais recente (`v2.2.6`, 2026-06-11) via `gh release view`:

```
Equilotl-darwin-arm64.zip
Equilotl-darwin-x64.zip
EquilotlCli-darwin-arm64
EquilotlCli-darwin-x64
```

O `EquilotlCli-darwin-*` é um binário CLI puro (sem GUI), o que dá para baixar e rodar por script sem interação, do mesmo jeito que o `pnpm inject` do Linux hoje. `docs.equicord.org/installation` só documenta os dois `.zip` gráficos e recomenda o Equibop (Discord+Vencord empacotado junto) como alternativa "recomendada" para macOS; não lista os binários CLI nem exemplos de flag, então essa parte veio só do código-fonte.

Flags de linha de comando, de `equilotl-src/cli.go` (comuns às três plataformas, o parsing de flags não é condicional por `GOOS`):

```go
var installFlag = flag.Bool("install", false, "Install Equicord")
var updateFlag = flag.Bool("repair", false, "Repair Equicord")
var uninstallFlag = flag.Bool("uninstall", false, "Uninstall Equicord")
var installOpenAsarFlag = flag.Bool("install-openasar", false, "Install OpenAsar")
var uninstallOpenAsarFlag = flag.Bool("uninstall-openasar", false, "Uninstall OpenAsar")
var locationFlag = flag.String("location", "", "The location of the Discord install to modify")
var branchFlag = flag.String("branch", "", "The branch of Discord to modify [auto|stable|ptb|canary]")
```

O `--location` funciona igual nas três plataformas na entrada (`PromptDiscord`, `cli.go` linha 221 em diante), mas o que ele espera como caminho muda por causa de `ParseDiscord`, que é implementado separado por SO. No Linux `ParseDiscord` (em `find_discord_linux.go`) aceita a pasta que contém `resources/`, o que bate com o `install_location()` do `streamfix-installer.sh` (linhas 231-239). No macOS, `ParseDiscord` em `find_discord_darwin.go` espera o caminho do `.app` inteiro:

```go
func ParseDiscord(p, branch string) *DiscordInstall {
    if !ExistsFile(p) { return nil }
    resources := path.Join(p, "/Contents/Resources")
    ...
```

Ou seja, `--location "/Applications/Discord.app"`, não `.../Contents/Resources` nem `.../Contents`. Isso é diferente do que `install_location()` calcularia hoje (que devolveria a pasta acima de `resources`, ou seja `Contents`, não o `.app`). Um port teria que ter uma função de resolução própria para macOS: a partir do caminho do `app.asar` encontrado, subir dois níveis (`resources` -> `Contents` -> `<Nome>.app`) e passar esse `.app` para `--location`.

`--branch` (`auto`, `stable`, `canary`, `ptb`) é mutuamente exclusivo com `--location` (`cli.go` linha 93-94: `die("The 'location' and 'branch' flags are mutually exclusive.")`), o que não existe hoje no fluxo Linux do StreamFix (que sempre usa `--location`). Isso é uma alternativa mais simples para macOS: como `FindDiscords()` já varre só `/Applications` e `~/Applications`, bastaria `pnpm inject -- --branch stable` (ou detectar o branch pelo nome do `.app` encontrado) e nem precisar calcular o `--location` manualmente.

**Assinatura de código depois de injetar: não, o Equilotl não faz nada sozinho.** Busquei por `codesign`, `xattr`, `quarantine` e `gatekeeper` (case-insensitive) em todo o repositório do Equilotl, incluindo o pipeline de patch/unpatch em `patcher.go`, o `find_discord_darwin.go`, `openasar.go` e a GUI (`gui.go`): zero ocorrências. O código de patch (`patcher.go`, função `patchAppAsar`) faz só duas coisas: renomeia `app.asar` para `_app.asar` e escreve um `app.asar` novo (via `WriteAppAsar`) que só faz `require()` do asar real do mod. Nenhuma chamada a `codesign`, `xattr` ou qualquer coisa equivalente, em nenhuma das três plataformas, aliás: isso não é peculiaridade do macOS, o instalador nunca mexe em assinatura em lugar nenhum.

## 4. Assinatura Apple e Gatekeeper

Este é o ponto que mais importa e onde a certeza primária é mais baixa, porque não achei nenhum documento oficial da Apple nem do Discord descrevendo o caso específico "modifiquei `Contents/Resources/app.asar` de um app já instalado". O que dá para afirmar com fonte:

**Modificar arquivos dentro de um bundle assinado invalida a assinatura do bundle.** Fonte: Apple, Technical Note TN2206 ("Signing Mac Software with codesign"), `developer.apple.com/library/archive/technotes/tn2206/_index.html`:

> "If you modify a signed bundle, you must re-sign it afterwards."

> "The obvious solution to these problems is to not meddle with your signed program after you've signed it with codesign. If you're modifying the executable or bundle in any way then the code signing validation engine will obviously pick up on that change and act appropriately with the set policy."

A mesma nota diz que `--deep` não é recomendado para assinar (só para "reparos de emergência"), e que **Gatekeeper sempre faz validação estilo `--deep`** ao inspecionar um bundle:

> "Note that Gatekeeper always performs --deep style validation."

Isso quer dizer que, se o Gatekeeper chegar a reavaliar o bundle do Discord depois da injeção, ele vai notar a inconsistência entre o `_CodeSignature/CodeResources` original (que lista o hash do `app.asar` de fábrica) e o `app.asar` novo escrito pelo instalador.

**Onde entra a incerteza: quando o Gatekeeper reavalia o bundle.** O guia oficial de segurança da Apple, "Gatekeeper and runtime protection" (`support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web`), descreve o Gatekeeper como uma verificação que roda **"the first time it's opened"** (a checagem de malware conhecido citada no documento) e que **"requests user approval before opening downloaded software for the first time"**. Isso está ligado ao atributo `com.apple.quarantine`, aplicado pelo Launch Services a arquivos baixados da internet (browsers, clientes de mensagem etc. marcam o arquivo com esse atributo estendido ao salvar). O documento da Apple não detalha explicitamente o mecanismo do atributo de quarentena nem confirma, com todas as letras, que a validação completa do Gatekeeper só roda enquanto esse atributo está presente; isso é o entendimento comum na comunidade de segurança do macOS (por exemplo a Apple, em fóruns de desenvolvedor, e pesquisadores de segurança independentes como o post do theevilbit sobre Gatekeeper), mas não achei o texto normativo da Apple que feche esse ponto com uma citação direta. Marco isso como lacuna abaixo.

O que dá para deduzir com razoável confiança, cruzando TN2206 com o comportamento observado e documentado pelo próprio Equilotl (que nunca resina nada, nas três plataformas, há anos, sem que isso quebre a instalação para a base de usuários do Vencord/Equicord no macOS):
- **App já executado antes (quarentena já removida no primeiro launch)**: o Gatekeeper não costuma reavaliar o bundle inteiro a cada abertura subsequente; a checagem completa (a que usa `--deep` e pegaria a inconsistência do `app.asar`) está associada ao atributo de quarentena, que o macOS remove automaticamente depois do primeiro launch aprovado (ou que o próprio usuário limpa com `xattr -cr`). Isso é consistente com o Equilotl nunca precisar tocar em assinatura: ele assume, implicitamente, que o Discord instalado já passou pelo primeiro launch.
- **App recém-baixado, ainda quarentenado**: se alguém baixar o `.dmg` do Discord, arrastar para `/Applications` e rodar o Equilotl antes do primeiro launch, existe risco real de o primeiro `open` disparar a checagem completa do Gatekeeper e falhar por causa do `app.asar` trocado, já que a mesma nota confirma que "Gatekeeper always performs --deep style validation". Não achei um caso documentado de usuário relatando isso especificamente para Discord+Vencord/Equicord (só um caso adjacente, de um launcher de terceiros não oficial, citado abaixo), então trato como risco teórico bem fundamentado em TN2206 e no comportamento documentado do Gatekeeper, não como fato confirmado por um teste real.

**Apple Silicon (arm64) exige assinatura, nem que seja ad-hoc, mas isso não é sobre o `app.asar`.** É um requisito de kernel: em arm64 (Apple Silicon), o macOS não executa código (Mach-O) sem assinatura válida, e o linker da Apple passou a aplicar assinatura ad-hoc automaticamente em tempo de build para resolver isso de forma transparente. Esse requisito recai sobre o **executável principal do bundle** (o binário Mach-O do Discord dentro de `Contents/MacOS/`), não sobre arquivos de recurso como o `app.asar`, que é carregado pelo processo Electron já em execução via `require()`, não executado diretamente pelo kernel. Como o Equilotl nunca toca no binário Mach-O (`patchAppAsar` só mexe em `Contents/Resources/app.asar`), a assinatura do executável em si permanece intacta; o que quebra é só a validade do selo do bundle como um todo (o que o `codesign --verify` no bundle acusaria, e o que o Gatekeeper acusaria se reavaliasse). Isso é inferência a partir de como funciona a verificação de assinatura em Mach-O (o kernel valida a assinatura embutida no próprio executável no `exec()`, TN2206 e a documentação geral de code signing da Apple), cruzada com o que o `patchAppAsar` de fato modifica; não achei um documento da Apple que descreva separadamente "validação do executável" vs "validação do selo do bundle" com essas palavras exatas, e por isso registro isso como uma inferência tecnicamente sólida, não uma citação direta.

**Diferença Intel vs Apple Silicon quanto à necessidade de agir depois da injeção**: não achei evidência de que a distinção troque o comportamento aqui. Em ambos os casos o `app.asar` não é um Mach-O e não passa pela checagem de assinatura de executável do kernel; a diferença de exigência de assinatura entre Intel e Apple Silicon é sobre binários executáveis, e nenhum binário executável é tocado pela injeção.

**`codesign --force --deep --sign -` e `xattr -cr`**: nem o Equilotl nem a documentação oficial (docs.equicord.org) mandam rodar esses comandos. Vi essas duas receitas em contextos adjacentes, não confirmados como oficiais do Equicord/Vencord:
- Um launcher de terceiros, não oficial (`github.com/feifeiFrank/Vencord-Discord-Launcher`, que se descreve como ferramenta própria e não é mantido pela organização Vencord/Equicord), documenta que, se o macOS bloquear a escrita em `/Applications/Discord.app`, é preciso liberar a permissão "App Management" em Ajustes do Sistema > Privacidade e Segurança para o app que faz a injeção, e que o próprio launcher não usa `sudo`.
- A permissão "App Management", introduzida no macOS 15 (Sequoia), é a barreira nova de TCC que controla que apps podem modificar bundles de outros apps. Não achei a página oficial da Apple que documenta essa permissão especificamente (só fontes secundárias: artigos técnicos sobre o Sequoia), então tratada como lacuna: se o instalador do StreamFix for um binário compilado (não um script), pode precisar dessa permissão em macOS 15+ para escrever dentro de `Discord.app`; se for um script bash chamando o `EquilotlCli-darwin-*`, o processo que pede a permissão provavelmente é o Terminal.app (ou o processo que executa o script), não o Equilotl em si, mas isso não é uma certeza validada.

Resumo prático para o port: o instalador do StreamFix para macOS deveria, por segurança, rodar `xattr -cr` no `.app` alvo antes ou depois de injetar (idempotente, não faz mal nenhum, e cobre o caso de alguém rodar o instalador num Discord recém-baixado), mas não precisa reassinar nada, porque a injeção não toca no executável principal e o Equilotl (que já tem base de usuários grande no macOS) nunca precisou disso.

## 5. Permissões

`/Applications` no macOS tem permissão padrão `drwxrwxr-x`, dono `root`, grupo `admin` (confirmado por múltiplas fontes técnicas consistentes entre si, incluindo o blog de pesquisa de segurança theevilbit e uma thread do fórum MacRumors mostrando a saída de `ls -la`/`stat` real; não achei documento oficial da Apple que declare esse modo explicitamente, então é conhecimento bem estabelecido mas não uma citação primária da Apple). Isso significa que **qualquer usuário do grupo `admin`** (a conta padrão criada na configuração inicial do Mac já é admin) **pode escrever em `/Applications` sem `sudo`**, ao contrário do Linux, onde `/usr/share`, `/opt` etc. exigem root. Isso é uma diferença estrutural importante em relação ao fluxo Linux do `streamfix-installer.sh`: lá, a divisão é "dentro do HOME não precisa de sudo, fora precisa" (`inject_mod()`, linhas 620-638, testando `[ ! -w "$alvo" ]`); no macOS, mesmo o Discord "de sistema" em `/Applications` normalmente é gravável pelo usuário comum, sem sudo, então esse branch de "pedir senha" provavelmente nunca dispara lá (a menos que a conta não seja admin, caso incomum em máquina pessoal).

O paralelo mais próximo no código atual não é o de raiz/sudo do Linux, e sim a distinção usuário/sistema do **flatpak**: lá, `flatpak_is_user_install()` decide se o override de sandbox precisa de sudo, e o comentário do próprio script (linha 77-78) já registra a mesma ideia geral ("Instalação do usuario nao precisa de raiz para nada; a do sistema precisa para tudo"). No macOS, como a instalação de app "de sistema" mora em `/Applications` mas continua gravável pelo usuário admin, o caso mais parecido é "instalação de usuário" o tempo todo, não o caso "de sistema" do Linux.

**Rodar como root quebraria a posse dos arquivos, sim, e isso é documentado no próprio Equilotl para Linux, com o padrão que deveria valer também num port de macOS.** `find_discord_linux.go`, bloco `init()`:

```go
// If ran as root, the HOME environment variable will be that of root.
// SUDO_USER and DOAS_USER tell us the actual user
var sudoUser = os.Getenv("SUDO_USER")
...
if sudoUser == "" {
    ...
} else if os.Getuid() == 0 {
    panic("Equilotl was run as root but neither SUDO_USER nor DOAS_USER are set. ...")
}
```

Ou seja, mesmo no Linux, o Equilotl recusa rodar como root puro; ele exige saber quem é o usuário real (via `sudo`/`doas`) para escrever as settings no HOME correto. `find_discord_darwin.go` não tem bloco `init()` nenhum tratando isso (nem `FixOwnership` faz algo: `func FixOwnership(_ string) error { return nil }`), o que é coerente com `/Applications` não precisar de sudo no caminho comum: o instalador nunca é chamado como root no macOS, então o cenário "root escrevendo settings no HOME de outro usuário" simplesmente não é um problema tratado, porque não deveria acontecer. Um port para macOS deveria seguir a mesma lógica: nunca pedir sudo para a instalação em si (nem para `/Applications`, que normalmente é gravável), e caso o instalador detecte `EUID == 0` (usuário raro que roda tudo com sudo por hábito vindo do Linux), avisar e abortar, do jeito que o Equilotl já faz.

## Lacunas

- Não encontrei documentação oficial da Apple que confirme, com uma frase direta, que a checagem completa do Gatekeeper (a que usa validação `--deep` do bundle) só roda enquanto o atributo `com.apple.quarantine` está presente, e que ela não é repetida em cada abertura subsequente de um app já aprovado. O texto usado (`support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web`) fala em "primeira vez que é aberto" mas não detalha o mecanismo do atributo de quarentena nem confirma a ausência de rechecagem depois.
- Não confirmei em nenhuma fonte primária um relato real de alguém injetando Vencord/Equicord num Discord.app recém-baixado e ainda quarentenado no macOS, para saber se o Gatekeeper de fato bloqueia nesse caso específico. O risco é bem fundamentado em TN2206, mas é inferência, não teste documentado.
- Não abri o código-fonte da biblioteca `go-appdir` (`github.com/ProtonMail/go-appdir`) para confirmar que `UserConfig()` resolve exatamente para `~/Library/Application Support/Equicord` no macOS; é a leitura natural do nome da API e do padrão do Vencord, mas não é uma citação de código.
- Não achei a página oficial da Apple que documenta a permissão "App Management" do macOS 15 (Sequoia). O que sei sobre ela veio de um launcher de terceiros não oficial e de artigos técnicos de terceiros, não da Apple nem do Equicord/Vencord.
- Não testei rodar o `EquilotlCli-darwin-*` de verdade (não tenho Mac na bancada de teste, que hoje é só WSL/Linux); tudo aqui vem de leitura de código-fonte e documentos, não de execução real.
- Não confirmei se existe alguma diferença de comportamento entre Discord Canary/PTB e a versão estável quanto a Gatekeeper ou quarentena; o código do Equilotl trata as três exatamente da mesma forma (mesma função `ParseDiscord`), então não há razão para esperar diferença, mas isso também não foi testado.
