<#
    StreamFix - instalador automatico

    Encontra sozinho o Equicord ou o Vencord que voce tem, instala o plugin, compila e
    injeta. Se voce nao tiver nenhum dos dois, pergunta qual quer e instala junto.

    Uso:
      .\StreamFix-Installer.ps1
      .\StreamFix-Installer.ps1 -Source "C:\caminho\do\Equicord"
      .\StreamFix-Installer.ps1 -Mod Equicord -Yes
      .\StreamFix-Installer.ps1 -Mode Uninstall

    Obrigado ao Vithor (https://github.com/Vith0r), que escreveu o primeiro instalador do
    GoLiveBypass e abriu o caminho para este aqui.
#>

[CmdletBinding()]
param(
    [ValidateSet('Menu', 'Install', 'Uninstall', 'Restore')]
    [string] $Mode = 'Menu',

    [ValidateSet('Equicord', 'Vencord')]
    [string] $Mod = '',

    [string] $Source = '',

    [switch] $Yes,

    # Deixa a GUI carregar so as funcoes via dot-sourcing, sem disparar o menu de terminal.
    [switch] $NoAutoRun,

    # Passado por quem baixou este script (o .bat ou o StreamFix-Installer-GUI.ps1), que ja
    # resolveu a ultima release estavel pela API do GitHub para se baixar. Reaproveitar essa
    # mesma tag aqui, em vez de consultar a API de novo, e o que garante que o motor do
    # instalador e os arquivos que ele baixa (Resolve-RepoRaw) vem sempre da mesma revisao --
    # uma segunda consulta independente correria o risco de pegar uma release mais nova que
    # saiu no meio do caminho.
    [string] $ResolvedTag = '',

    # A saida que provisiona o tunel. Quem monta a propria saida aponta para a dela.
    [string] $ExitUrl = 'http://159.112.151.37:8787/registrar',

    # A chave publica esperada da saida. O registro nao tem TLS (a saida e um IP, sem dominio),
    # entao esta chave e o que impede substituicao de resposta -- alguem no meio do caminho
    # devolvendo a propria saida e levando a midia de quem instalou.
    #
    # Tem padrao, e o padrao casa com o $ExitUrl acima: os dois descrevem a MESMA saida. Sem
    # padrao, quem instala pela janela (que nao tem onde digitar isto) ficaria sem a unica
    # defesa que existe sem TLS -- e e por ali que quase todo mundo instala. Quem aponta para
    # outra saida troca os dois juntos. Vazia desliga a conferencia.
    [string] $ExitKey = 'fbv+rSWSp36QfVdcNvPHdtEFzeOvCrzB1cyNBfGSvWY=',

    # Nome do perfil no WireSock. Muda junto com o nome do arquivo .conf, que e de onde o
    # WireSock tira o nome de verdade.
    [string] $TunnelProfile = 'streamfix-santiago',

    # Provisiona de novo mesmo que ja exista um perfil com esse nome. Gera chave nova, gasta um
    # uso do convite e deixa o peer antigo orfao na saida -- so use se o perfil atual quebrou.
    [switch] $Reprovision
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Libera a execucao so para este processo; se a politica de dominio recusar, o .bat ja abre
# com -ExecutionPolicy Bypass.
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch { }

# Alguns antivirus/EDR rodam um .exe novo e desconhecido numa primeira passada de sandbox com
# o ambiente do processo raspado (sem USERPROFILE/TEMP), antes de liberar a execucao de
# verdade. Sem essa checagem, isso vira la na frente um erro criptico do .NET tentando montar
# um caminho vazio -- "nao e possivel associar o argumento ao parametro 'Path'". Falhar aqui,
# cedo e com uma mensagem que aponta o antivirus, poupa uma investigacao as cegas depois.
foreach ($envVar in @('USERPROFILE', 'TEMP')) {
    if (-not [Environment]::GetEnvironmentVariable($envVar)) {
        throw "A variavel de ambiente $envVar veio vazia para este processo. Isso costuma acontecer quando um antivirus roda o instalador numa sandbox restrita antes de liberar de verdade -- confirme que o .exe/.ps1 esta liberado no seu antivirus e tente de novo."
    }
}

# Resolvida a ultima release estavel (nao "main"): evita execucao remota de codigo via um push
# nao revisado, sem precisar editar isto a cada release -- Resolve-RepoRaw consulta a API do
# GitHub e resolve uma vez por execucao, memoizando o resultado.
$script:RepoRaw = $null
# As fases 1 a 6 quebraram o plugin em modulos. Copiar so os dois de cima deixaria um plugin
# que nem compila -- os imports de ./tunnel/ nao resolveriam.
$PluginFiles = @(
    'streamFix/index.tsx',
    'streamFix/native.ts',
    'streamFix/tunnel/coletor.ts',
    'streamFix/tunnel/controle.ts',
    'streamFix/tunnel/entrada.ts',
    'streamFix/tunnel/monitor.ts',
    'streamFix/tunnel/observador.ts',
    'streamFix/tunnel/perfil.ts',
    'streamFix/tunnel/porteiro.ts'
)
$PluginDirName = 'streamFix'
$LegacyPluginDirName = 'goLiveBypass'
$DiscordNames = @('Discord', 'DiscordCanary', 'DiscordPTB')

$Mods = @{
    Equicord = @{ Git = 'https://github.com/Equicord/Equicord'; Label = 'Equicord'; Note = 'recomendado, inclui tudo do Vencord e mais plugins' }
    Vencord  = @{ Git = 'https://github.com/Vendicated/Vencord'; Label = 'Vencord'; Note = 'o original, mais enxuto' }
}

function Write-Step($text) { Write-Host "  [*] $text" -ForegroundColor DarkGray }
function Write-Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "  [X] $text" -ForegroundColor Red }

function Show-Banner {
    Write-Host ''
    Write-Host '  StreamFix' -ForegroundColor Cyan
    Write-Host '  Go Live e camera de volta no Discord' -ForegroundColor DarkGray
    Write-Host '  https://github.com/EduardoVasconceloss/StreamFix (fork de bezumiya/GoLiveBypass)' -ForegroundColor DarkGray
    Write-Host ''
}

function Confirm-Action($question) {
    if ($Yes) { return $true }
    return (Read-Host "  $question [s/N]") -match '^[sSyY]'
}

function Save-Text($path, $text) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Resolve-RepoRaw {
    if ($script:RepoRaw) { return $script:RepoRaw }

    if ($ResolvedTag) {
        $script:RepoRaw = "https://raw.githubusercontent.com/EduardoVasconceloss/StreamFix/$ResolvedTag"
        return $script:RepoRaw
    }

    try {
        $release = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'StreamFix-Installer' } `
            -Uri 'https://api.github.com/repos/EduardoVasconceloss/StreamFix/releases/latest'
    } catch {
        throw 'Nao consegui descobrir a ultima release estavel do StreamFix pela API do GitHub. Verifique sua conexao e tente de novo.'
    }

    if (-not $release.tag_name) { throw 'A API do GitHub nao devolveu uma tag de release valida.' }

    $script:RepoRaw = "https://raw.githubusercontent.com/EduardoVasconceloss/StreamFix/$($release.tag_name)"
    return $script:RepoRaw
}

function Get-RepoFile($relativePath) {
    # Split-Path -Parent devolve vazio na raiz de um disco, e Join-Path com Path vazio lanca
    # excecao -- o if aninhado evita isso.
    if ($PSScriptRoot) {
        $repoRoot = Split-Path -Parent $PSScriptRoot
        if ($repoRoot) {
            $local = Join-Path $repoRoot ($relativePath -replace '/', '\')
            if (Test-Path -LiteralPath $local) { return [IO.File]::ReadAllText($local) }
        }
    }

    try {
        return (Invoke-WebRequest -UseBasicParsing -Uri "$(Resolve-RepoRaw)/$relativePath").Content
    } catch {
        throw "Nao consegui baixar $relativePath. Verifique sua conexao."
    }
}

# stderr de um comando externo vira NativeCommandError fatal com ErrorActionPreference=Stop,
# mesmo sendo so aviso (ex: pnpm avisando a propria versao). Quem diz se falhou de verdade e o
# $LASTEXITCODE, checado depois de cada chamada -- aqui so relaxamos a checagem do PowerShell.
#
# A saida vai por Write-Host, NUNCA pro stream de sucesso. Emitir no stream de sucesso fazia a
# saida do comando virar parte do valor de retorno de quem chamou: Install-Mod devolvia
# ["Cloning into 'C:\...'", "C:\...\Equicord"] em vez do caminho, e o primeiro Join-Path
# reclamava que nao existe drive chamado "Cloning into 'C". Mesma armadilha que ja tinha
# derrubado o log da GUI -- ver o Write-Host redefinido em StreamFix-Installer-GUI.ps1.
function Invoke-Native([ScriptBlock] $Command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # 2>&1 mistura stderr no stream; o ForEach devolve o texto puro em vez do ErrorRecord,
        # senao toda linha aparece em vermelho como "ERROR:" mesmo sendo saida normal.
        & $Command 2>&1 | ForEach-Object {
            $line = if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ }
            Write-Host "    $line" -ForegroundColor DarkGray
        }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Test-Tool($name) {
    return [bool] (Get-Command $name -ErrorAction SilentlyContinue)
}

# pnpm recente exige esse minimo de Node pra rodar (corepack aborta com "This version of pnpm
# requires at least Node.js vX" quando nao bate) -- so existir um "node" no PATH nao basta.
$MinNodeVersion = [version]'22.13.0'

function Get-NodeVersionAt($nodeExe) {
    $raw = & $nodeExe --version 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    try { return [version] ($raw.Trim().TrimStart('v')) } catch { return $null }
}

# Quem ja tem um Node novo instalado do lado de um antigo (ou trocou de versao sem tirar a
# anterior) nao devia precisar desinstalar nada so pra rodar o instalador -- procuramos nos
# locais de instalacao comuns por um Node que ja atenda o minimo e usamos esse, sem mexer no
# PATH permanente da maquina.
function Find-NewerNodeDir($minVersion) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs')
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs')
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'node.exe')) }

    $best = $null
    $bestVersion = $null
    foreach ($dir in $candidates) {
        $version = Get-NodeVersionAt (Join-Path $dir 'node.exe')
        if ($version -and $version -ge $minVersion -and (-not $bestVersion -or $version -gt $bestVersion)) {
            $best = $dir
            $bestVersion = $version
        }
    }
    return $best
}

# O corepack cria o atalho do pnpm antes de saber que versao usar. Na primeira execucao ele
# busca essa versao no registro do npm e confere a assinatura com chaves embutidas nele; as
# chaves do corepack que vem no Node 22 estao velhas, entao o atalho existe e mesmo assim
# quebra com "Cannot find matching keyid". So testar se o comando existe nao prova nada.
function Test-Pnpm($expectedVersion = $null) {
    if (-not (Test-Tool 'pnpm')) { return $false }

    # 2>$null para o erro do corepack nao assustar quem so vai ver a instalacao seguir.
    $version = & pnpm --version 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }

    # Versao errada tambem conta como "nao esta pronto": pnpm avisa a cada comando quando
    # difere da que o package.json pede, mesmo funcionando -- reinstalar a certa cala o aviso.
    if ($expectedVersion -and $version -ne $expectedVersion) { return $false }

    Write-Step "pnpm encontrado: $version"
    return $true
}

function Get-PinnedPnpmVersion($root) {
    if (-not $root) { return $null }
    $manifest = Join-Path $root 'package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }

    try {
        $pm = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).packageManager
        if ($pm -match '^pnpm@([\d.]+)') { return $Matches[1] }
    } catch { }
    return $null
}

function Update-PathFromEnvironment {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $fresh = @($machine, $user | Where-Object { $_ }) -join ';'

    # Mescla no PATH atual, nunca substitui: descartaria entradas que so existem no processo
    # (wrapper, shell de dev, instalacao portatil) e nao estao no registro.
    $existing = @($env:Path -split ';' | Where-Object { $_ })
    $newEntries = @($fresh -split ';' | Where-Object { $_ -and ($existing -notcontains $_) })
    $env:Path = ($existing + $newEntries) -join ';'
}

function Test-ModCheckout($path) {
    if (-not $path) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $path 'package.json'))) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $path 'src\utils\types.ts'))) { return $false }

    # O build roda "git rev-parse" pra gravar o hash na versao compilada; uma pasta sem clone
    # git de verdade (ZIP baixado, clone interrompido) so quebraria mais tarde, sem contexto.
    return Test-Path -LiteralPath (Join-Path $path '.git')
}

function Get-DiscordResources {
    $found = @()
    foreach ($name in $DiscordNames) {
        $root = Join-Path $env:LOCALAPPDATA $name
        if (-not (Test-Path -LiteralPath $root)) { continue }

        $apps = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -match '^app-[0-9]' -and
                (Test-Path -LiteralPath (Join-Path $_.FullName 'resources'))
            } |
            Sort-Object -Descending -Property @{ Expression = {
                try { [version]($_.Name -replace '^app-', '') } catch { [version]'0.0.0' }
            } }

        foreach ($app in $apps) { $found += (Join-Path $app.FullName 'resources') }
    }
    return $found
}

function Get-InjectedPath($resources) {
    # O stub que o Equicord/Vencord deixa no lugar do app.asar so faz require da pasta de
    # build -- aponta direto pro checkout, forma mais confiavel de acha-lo.

    $candidates = @()

    $stub = Join-Path $resources 'app.asar'
    if (Test-Path -LiteralPath $stub) {
        $item = Get-Item -LiteralPath $stub
        # app.asar pode ser pasta (.Length viraria 1, nao o tamanho real).
        if ($item -is [IO.FileInfo] -and $item.Length -lt 65536) {
            $candidates += [IO.File]::ReadAllText($stub)
        }
    }

    $index = Join-Path $resources 'app\index.js'
    if (Test-Path -LiteralPath $index) {
        $candidates += Get-Content -LiteralPath $index -Raw -ErrorAction SilentlyContinue
    }

    foreach ($text in $candidates) {
        if (-not $text) { continue }
        $match = [regex]::Match($text, 'require\("(.+?)"\)')
        if ($match.Success) { return $match.Groups[1].Value -replace '\\\\', '\' }
    }

    return $null
}

function Get-InstalledMod {
    foreach ($resources in Get-DiscordResources) {
        $injected = Get-InjectedPath $resources
        if (-not $injected) { continue }
        if ($injected -match 'equibop') { return 'Equibop' }
        if ($injected -match 'equicord') { return 'Equicord' }
        if ($injected -match 'vesktop') { return 'Vesktop' }
        if ($injected -match 'vencord') { return 'Vencord' }
    }
    return $null
}

function Find-CheckoutFromInjection {
    foreach ($resources in Get-DiscordResources) {
        $injected = Get-InjectedPath $resources
        if (-not $injected) { continue }

        # <checkout>\dist\desktop -> <checkout>
        $root = Split-Path -Parent (Split-Path -Parent $injected)
        if (Test-ModCheckout $root) { return $root }
    }
    return $null
}

function Find-CheckoutOnDisk {
    $roots = @($env:USERPROFILE)
    foreach ($sub in @('Documents', 'Desktop', 'Downloads', 'dev', 'repos', 'projects', 'git', 'source', 'source\repos')) {
        $roots += (Join-Path $env:USERPROFILE $sub)
    }
    foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
        if ($drive.Root -and $drive.Root -match '^[A-Za-z]:\\$') { $roots += $drive.Root }
    }

    $seen = @{}
    foreach ($root in $roots) {
        if (-not $root -or $seen.ContainsKey($root) -or -not (Test-Path -LiteralPath $root)) { continue }
        $seen[$root] = $true

        $candidates = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^(Equicord|Vencord)$' }

        foreach ($dir in $candidates) {
            if (Test-ModCheckout $dir.FullName) { return $dir.FullName }
        }
    }

    Write-Step 'Procurando um pouco mais fundo no seu perfil'
    $deep = Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(Equicord|Vencord)$' } |
        Select-Object -First 20

    foreach ($dir in $deep) {
        if (Test-ModCheckout $dir.FullName) { return $dir.FullName }
    }

    return $null
}

function Find-Checkout {
    if ($Source) {
        if (Test-ModCheckout $Source) { return $Source }
        throw "Nao encontrei um checkout do Equicord ou Vencord em $Source"
    }

    $root = Find-CheckoutFromInjection
    if ($root) {
        Write-Ok "Achei pelo Discord: $root"
        return $root
    }

    $root = Find-CheckoutOnDisk
    if ($root) {
        Write-Ok "Achei no disco: $root"
        return $root
    }

    return $null
}

function Test-InjectedFromCheckout($root) {
    foreach ($resources in Get-DiscordResources) {
        $injected = Get-InjectedPath $resources
        if ($injected -and $injected.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Show-ModChoice {
    if ($Mod) { return $Mod }

    $installed = Get-InstalledMod

    Write-Host ''
    if ($installed) {
        Write-Warn "Voce tem o $installed instalado, mas nao achei o codigo fonte dele."
        Write-Host '  Plugins de usuario so existem compilando do fonte, entao preciso baixar o repositorio.' -ForegroundColor DarkGray
    } else {
        Write-Warn 'Nao encontrei Equicord nem Vencord no seu computador.'
        Write-Host '  Posso baixar e instalar um dos dois junto com o plugin.' -ForegroundColor DarkGray
    }

    Write-Host ''
    Write-Host '  Qual voce quer instalar?' -ForegroundColor White
    Write-Host ''
    Write-Host "    [1] Equicord    $($Mods.Equicord.Note)" -ForegroundColor Green
    Write-Host "    [2] Vencord     $($Mods.Vencord.Note)" -ForegroundColor Cyan
    Write-Host '    [0] Cancelar' -ForegroundColor Gray
    Write-Host ''

    switch (Read-Host '  Escolha') {
        '1' { return 'Equicord' }
        '2' { return 'Vencord' }
        default { throw 'Cancelado.' }
    }
}

function Install-Toolchain($root = $null) {
    # Relê o PATH antes do primeiro Test-Tool: quem instala o Node e abre o instalador sem
    # reiniciar o terminal (ou clica no .exe pelo Explorer) herda um PATH de antes do registro
    # atualizar, e a ferramenta parece "faltando" mesmo estando la.
    Update-PathFromEnvironment

    # git e sempre necessario, mesmo quando ja existe um checkout: o build roda "git
    # rev-parse" pra gravar o hash na versao compilada (ver Test-ModCheckout). $needGit so
    # controlava a mensagem/fluxo de clone, e por isso um checkout ja existente sem git
    # instalado passava direto por essa checagem e so quebrava mais tarde, com "pnpm build
    # falhou" sem contexto nenhum.
    $missing = @()
    if (-not (Test-Tool 'git')) { $missing += 'git' }
    if (-not (Test-Tool 'node')) { $missing += 'node' }

    if ($missing.Count -gt 0) {
        Write-Warn "Faltando no seu PATH: $($missing -join ', ')"

        if (Test-Tool 'winget') {
            if (-not (Confirm-Action 'Instalar agora com o winget?')) {
                throw "Instale $($missing -join ' e ') e rode de novo."
            }

            foreach ($tool in $missing) {
                $id = if ($tool -eq 'git') { 'Git.Git' } else { 'OpenJS.NodeJS.LTS' }
                Write-Step "winget install $id"
                Invoke-Native { winget install --id $id --accept-source-agreements --accept-package-agreements --silent }
            }
        } else {
            # Sem winget: cai pro instalador oficial de cada ferramenta (Install-ToolDirect).
            Write-Warn 'Sem winget nesta maquina.'
            if (-not (Confirm-Action "Baixar e instalar $($missing -join ' e ') pelo instalador oficial de cada um?")) {
                throw "Instale $($missing -join ' e ') manualmente e rode de novo."
            }

            foreach ($tool in $missing) {
                Install-ToolDirect $tool
            }
        }

        # O winget grava o PATH novo no registro (Machine/User), e da pra reler isso no mesmo
        # processo sem reabrir o terminal -- e a mesma tecnica ja usada pra pegar o pnpm
        # recem-instalado logo abaixo. Antes o instalador sempre pedia pra fechar e abrir de
        # novo aqui, e como este mesmo Install-Toolchain roda de novo mais adiante no fluxo
        # (para o mod, e depois para o resto), isso virava um ciclo de fechar/reabrir varias
        # vezes numa instalacao do zero. So pede reabrir se, mesmo depois de reler, a
        # ferramenta continuar faltando -- caso raro de instalador do winget que precisa
        # mesmo de uma sessao nova.
        Update-PathFromEnvironment
        $stillMissing = $missing | Where-Object { -not (Test-Tool $_) }

        if ($stillMissing.Count -gt 0) {
            Write-Host ''
            Write-Warn "Ainda faltando depois de instalar: $($stillMissing -join ', '). Feche este terminal, abra outro e rode o instalador de novo."
            exit 0
        }

        Write-Ok 'Instalado. Seguindo sem precisar reabrir o terminal.'
    }

    # "node" existir no PATH nao quer dizer que e novo o suficiente -- quem tem uma instalacao
    # antiga na frente do PATH (ou nunca reabriu o terminal depois de instalar uma nova) cai
    # direto no "pnpm requires at least Node.js vX" mais adiante, sem nenhum contexto.
    $nodeVersion = Get-NodeVersionAt 'node'
    if ($nodeVersion -and $nodeVersion -lt $MinNodeVersion) {
        Write-Warn "O Node do PATH ($nodeVersion) e mais antigo que o exigido ($MinNodeVersion)."

        $newerNodeDir = Find-NewerNodeDir $MinNodeVersion
        if ($newerNodeDir) {
            Write-Ok "Achei um Node mais novo em $newerNodeDir -- usando ele so pra esta instalacao, sem mexer no seu PATH."
            $env:Path = "$newerNodeDir;$env:Path"
        } else {
            Write-Warn 'Nenhuma instalacao de Node compativel encontrada. Instalando a versao mais recente.'
            if (Test-Tool 'winget') {
                Invoke-Native { winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent }
            } else {
                Install-ToolDirect 'node'
            }
            Update-PathFromEnvironment

            $nodeVersion = Get-NodeVersionAt 'node'
            if (-not $nodeVersion -or $nodeVersion -lt $MinNodeVersion) {
                $newerNodeDir = Find-NewerNodeDir $MinNodeVersion
                if ($newerNodeDir) {
                    $env:Path = "$newerNodeDir;$env:Path"
                } else {
                    Write-Warn 'Instalei um Node novo, mas este terminal ainda nao enxerga ele. Feche este terminal, abra outro e rode o instalador de novo.'
                    exit 0
                }
            }
        }
    }

    $pinnedPnpm = Get-PinnedPnpmVersion $root
    if (Test-Pnpm $pinnedPnpm) { return }

    # O Corepack cria um atalho do pnpm antes de saber que versao usar, e na primeira
    # execucao ele confere a assinatura contra chaves embutidas que no Node 22 estao
    # vencidas: o atalho existe e mesmo assim quebra com "Cannot find matching keyid".
    # O npm instala o pnpm direto, sem essa etapa, entao vamos direto por ele.
    $pnpmSpec = if ($pinnedPnpm) { "pnpm@$pinnedPnpm" } else { 'pnpm' }
    Write-Step "Instalando o $pnpmSpec pelo npm"
    Invoke-Native { npm install -g $pnpmSpec }
    Update-PathFromEnvironment

    if (-not (Test-Pnpm $pinnedPnpm)) {
        throw "Nao consegui deixar o pnpm funcionando. Abra um terminal e rode: npm install -g $pnpmSpec"
    }
}

function Install-Mod($choice) {
    $info = $Mods[$choice]
    $target = Join-Path $env:USERPROFILE $info.Label

    Write-Host ''
    Write-Host '  Vou fazer:' -ForegroundColor White
    Write-Host "    1. Baixar o $($info.Label) em $target" -ForegroundColor DarkGray
    Write-Host '    2. Instalar as dependencias' -ForegroundColor DarkGray
    Write-Host '    3. Compilar junto com o StreamFix' -ForegroundColor DarkGray
    Write-Host '    4. Injetar no Discord (o Discord vai fechar)' -ForegroundColor DarkGray
    Write-Host ''
    if (-not (Confirm-Action 'Pode seguir?')) { throw 'Cancelado.' }

    Install-Toolchain

    if (Test-Path -LiteralPath $target) {
        if (-not (Test-ModCheckout $target)) {
            throw "$target ja existe e nao parece um checkout. Apague a pasta ou use -Source."
        }
        Write-Step "Ja existe um checkout em $target, reaproveitando"
        return $target
    }

    Write-Step "git clone $($info.Git)"
    Invoke-Native { git clone --depth 1 $info.Git $target }
    if ($LASTEXITCODE -ne 0) { throw 'git clone falhou' }

    return $target
}

function Stop-Discord {
    if (-not (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue)) { return }

    Write-Step 'Fechando o Discord'
    Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 300
        if (-not (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue)) { return }
    }

    throw 'O Discord nao fechou. Feche pelo icone na bandeja e rode de novo.'
}

function Copy-Plugin($root) {
    $target = Join-Path $root "src\userplugins\$PluginDirName"
    $legacy = Join-Path $root "src\userplugins\$LegacyPluginDirName"

    # Evita pasta duplicada/orfa pra quem ja tinha o plugin instalado sob o nome antigo.
    if ((Test-Path -LiteralPath $legacy) -and -not (Test-Path -LiteralPath $target)) {
        Write-Step "Removendo a instalacao antiga do plugin em $legacy"
        Remove-Item -LiteralPath $legacy -Recurse -Force
    }

    Write-Step "Instalando o plugin em $target"

    if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

    # versoes antigas usavam index.ts; deixar os dois quebra o build
    $stale = Join-Path $target 'index.ts'
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }

    # Split-Path -Leaf achatava tudo na raiz do plugin, e ./tunnel/coletor virava ./coletor --
    # os imports nao resolveriam e o build morreria. O caminho relativo tem que sobreviver.
    foreach ($file in $PluginFiles) {
        $relative = $file -replace '^streamFix/', ''
        $dest = Join-Path $target ($relative -replace '/', '\')
        $parent = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Save-Text $dest (Get-RepoFile $file)
    }
}

function Build-Mod($root) {
    Push-Location -LiteralPath $root
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
            Write-Step 'Instalando dependencias (na primeira vez demora alguns minutos)'
            Invoke-Native { pnpm install }
            if ($LASTEXITCODE -ne 0) { throw 'pnpm install falhou' }
        }

        Write-Step 'Compilando'
        Invoke-Native { pnpm build }
        if ($LASTEXITCODE -ne 0) { throw 'pnpm build falhou' }
    } finally {
        Pop-Location
    }
}

function Invoke-Injection($root) {
    Push-Location -LiteralPath $root
    try {
        Stop-Discord
        Write-Step 'Injetando no Discord'
        # --branch auto: sem isso, o instalador do mod pergunta com um menu de setinhas qual
        # Discord usar mesmo com --install ja passado -- na GUI (sem console de verdade) essa
        # pergunta trava para sempre, sem jeito de responder. auto pega Stable > Canary > PTB.
        Invoke-Native { pnpm inject -- --branch auto }
        if ($LASTEXITCODE -ne 0) { throw 'pnpm inject falhou' }
    } finally {
        Pop-Location
    }
}

function Start-Discord {
    foreach ($name in $DiscordNames) {
        $exe = Join-Path $env:LOCALAPPDATA "$name\Update.exe"
        if (Test-Path -LiteralPath $exe) {
            Start-Process -FilePath $exe -ArgumentList '--processStart', "$name.exe"
            return
        }
    }
}

function Invoke-Install($root) {
    $root = Select-Target $root

    # Um comando nativo escreve na saida da funcao que o chama, e Select-Target chama outras que
    # rodam npm e git. O Invoke-Native ja contem isso, mas se qualquer nativo novo escapar dele
    # o $root volta a chegar como array, e o Test-Path quebra ao ligar um elemento vazio -- com
    # uma mensagem sobre parametro que nao diz nada a quem esta instalando.
    #
    # Ficar com a ultima linha e o que resolve: o caminho de verdade sai do "return" no fim da
    # funcao, depois de toda a saida que vazou. E nao esconde erro nenhum, porque a checagem
    # logo abaixo continua valendo.
    $root = @($root) | Where-Object { $_ } | Select-Object -Last 1

    # Checar que a pasta existe, e nao so que a variavel tem algo: um checkout que nao ficou
    # pronto (clone interrompido, permissao negada) passaria pela checagem de vazio e so
    # apareceria muito depois, como erro do .NET sobre o parametro 'Path'.
    if (-not $root -or -not (Test-Path -LiteralPath $root)) {
        throw 'Nao consegui determinar a pasta de instalacao. Tente de novo, ou aponte com -Source.'
    }

    Remove-LegacyTor

    $permanent = Select-Persistence

    # A ORDEM E O DESENHO. O tunel vem antes do plugin, e as configuracoes (que e onde o plugin
    # fica `enabled: true`) vem por ultimo. Assim uma instalacao interrompida no meio deixa a
    # pessoa sem plugin -- nunca com um plugin ligado e sem tunel, que e o pior estado possivel
    # porque parece pronto.
    #
    # O toolchain vem primeiro de todos porque o provisionador roda em Node.
    Install-Toolchain $root
    $tunnel = Install-Tunnel $ExitUrl $ExitKey $TunnelProfile

    Copy-Plugin $root
    Build-Mod $root

    $weInjected = -not (Test-InjectedFromCheckout $root)
    if ($weInjected) {
        Invoke-Injection $root
    } else {
        Write-Step 'O Discord ja carrega deste checkout, so reiniciando'
        Stop-Discord
    }

    # Com o Discord fechado: aberto, ele regrava o settings.json a partir da memoria e
    # apaga o que escrevemos aqui.
    Set-PluginSettings $root $tunnel

    Start-Discord

    Write-Host ''
    Write-Ok 'Pronto. O plugin ja vem ativado, nao precisa mexer em nada.'
    Write-Host "  Sua saida: $($tunnel.endpoint)" -ForegroundColor DarkGray

    if ($tunnel.conectado) {
        Write-Host '  Entre numa call e use Go Live ou a camera.' -ForegroundColor DarkGray
    } else {
        Write-Warn 'O tunel nao subiu antes de o Discord abrir.'
        Write-Host '  Feche o Discord DE VERDADE (bandeja, botao direito, Sair) e abra de novo.' -ForegroundColor DarkGray
        Write-Host '  Sem isso o Discord segue enxergando o IP brasileiro e esconde o botao de transmitir.' -ForegroundColor DarkGray
    }

    if (-not $permanent) {
        if ($weInjected) {
            Wait-DiscordExit $root
        } else {
            Write-Warn 'O Discord ja estava injetado antes de eu rodar, entao nao vou desfazer isso.'
            Write-Host '  Para remover depois: .\StreamFix-Installer.ps1 -Mode Uninstall' -ForegroundColor DarkGray
        }
    }
}

function Invoke-Uninstall {
    $root = Find-Checkout
    if (-not $root) { throw 'Nao encontrei o checkout do Equicord/Vencord. Use -Source.' }

    $target = Join-Path $root "src\userplugins\$PluginDirName"
    if (Test-Path -LiteralPath $target) {
        Write-Step "Removendo $target"
        Remove-Item -LiteralPath $target -Recurse -Force
    } else {
        Write-Warn 'O plugin nao estava instalado nesse checkout.'
    }

    Build-Mod $root
    Stop-Discord
    Start-Discord
    Remove-TorDaemon

    Write-Host ''
    Write-Ok 'Plugin removido. Seu Equicord/Vencord continua funcionando.'
}

# =============================================================================== interface

function Get-CheckoutMod($root) {
    # A identidade vem do package.json, nao do nome da pasta: quem baixou o ZIP tem o repo
    # numa pasta chamada Equicord-main, e ai o nome da pasta nao diz nada.
    $manifest = Join-Path $root 'package.json'
    if (Test-Path -LiteralPath $manifest) {
        try {
            $name = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name
            if ($name -match 'equicord') { return 'Equicord' }
            if ($name -match 'vencord') { return 'Vencord' }
        } catch { }
    }

    if ((Split-Path -Leaf $root) -match 'vencord') { return 'Vencord' }
    return 'Equicord'
}

function Get-ModSettingsFile($root) {
    # Mesma regra do proprio mod (src/main/utils/constants.ts):
    #   DATA_DIR = <MOD>_USER_DATA_DIR ?? %APPDATA%\<Mod>
    #   SETTINGS_FILE = DATA_DIR\settings\settings.json
    $mod = Get-CheckoutMod $root

    $override = [Environment]::GetEnvironmentVariable("$($mod.ToUpper())_USER_DATA_DIR")
    if ($override) { return (Join-Path $override 'settings\settings.json') }

    return (Join-Path $env:APPDATA "$mod\settings\settings.json")
}

function Set-PluginSettings($root, $tunnel) {
    $file = Get-ModSettingsFile $root

    $settings = $null
    if (Test-Path -LiteralPath $file) {
        try { $settings = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { $settings = 'ilegivel' }
    }

    # Nunca reescrever por cima de um arquivo que nao deu para ler: isso apagaria todos os
    # plugins da pessoa. Melhor guardar uma copia e deixar ela ativar o plugin na mao.
    if ($settings -is [string]) {
        $backup = "$file.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -LiteralPath $file -Destination $backup -Force
        Write-Warn "Nao consegui ler $file, entao nao mexi nele. Copia em $backup"
        Write-Warn 'Ative o StreamFix na mao em Configuracoes > Plugins.'
        return
    }

    if ($null -eq $settings) { $settings = [pscustomobject]@{} }

    if (-not $settings.PSObject.Properties['plugins']) {
        $settings | Add-Member -NotePropertyName plugins -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    # A chave e o campo "name:" do plugin, que hoje e StreamFix. Escrever no nome antigo so
    # funcionava porque migrateLegacySettings() movia depois -- e ela nao move quando a chave
    # nova ja existe, entao reinstalar pra trocar a proxy escrevia num lugar que ninguem le.
    $existing = $settings.plugins.PSObject.Properties['StreamFix']
    $plugin = if ($existing) { $existing.Value } else { [pscustomobject]@{} }

    # `proxy` e `excludedCountries` sairam com a proxy de gateway (fase 0): escrever aqui um
    # campo que o plugin nao le mais so deixaria lixo no settings.json de quem atualiza.
    foreach ($dead in @('proxy', 'excludedCountries')) {
        if ($plugin.PSObject.Properties[$dead]) { $plugin.PSObject.Properties.Remove($dead) }
    }

    $plugin | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
    $plugin | Add-Member -NotePropertyName exigirTunel -NotePropertyValue $true -Force
    $plugin | Add-Member -NotePropertyName perfilDoTunel -NotePropertyValue $tunnel.perfil -Force

    # Vem da resposta da saida, nao de um padrao escrito aqui: e contra este endereco que o
    # porteiro confere o que o Discord reporta, e um valor chutado recusaria transmissao boa.
    $plugin | Add-Member -NotePropertyName enderecoDaSaida -NotePropertyValue $tunnel.endpoint -Force

    # Ligado por padrao (D9). Quem so assiste desliga nas configuracoes e passa a subir o tunel
    # so na entrada de cada transmissao.
    if (-not $plugin.PSObject.Properties['tunelPermanente']) {
        $plugin | Add-Member -NotePropertyName tunelPermanente -NotePropertyValue $true -Force
    }

    $settings.plugins | Add-Member -NotePropertyName StreamFix -NotePropertyValue $plugin -Force

    Save-Text $file ($settings | ConvertTo-Json -Depth 10)

    $written = $null
    try { $written = (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).plugins.StreamFix } catch { }
    if ($written -and $written.enabled) {
        Write-Step "Plugin ativado em $file"
    } else {
        Write-Warn "Nao consegui confirmar a escrita em $file"
        Write-Host '  Ative o StreamFix na mao em Configuracoes > Plugins.' -ForegroundColor DarkGray
    }
}

function Show-Status($root) {
    $discord = (Get-DiscordResources).Count
    $mod = Get-InstalledMod

    Write-Host '  Detectado:' -ForegroundColor White
    if ($discord -gt 0) { Write-Host "    Discord   instalado ($discord versao(oes))" -ForegroundColor DarkGray }
    else { Write-Host '    Discord   nao encontrado' -ForegroundColor Yellow }

    if ($mod) { Write-Host "    Mod       $mod" -ForegroundColor DarkGray }
    else { Write-Host '    Mod       nenhum' -ForegroundColor DarkGray }

    if ($root) {
        Write-Host "    Fonte     $root" -ForegroundColor DarkGray
        $plugin = Join-Path $root "src\userplugins\$PluginDirName"
        if (Test-Path -LiteralPath $plugin) { Write-Host '    Plugin    ja instalado' -ForegroundColor Green }
        else { Write-Host '    Plugin    nao instalado' -ForegroundColor DarkGray }
    } else {
        Write-Host '    Fonte     nao encontrado' -ForegroundColor DarkGray
    }
    Write-Host ''
}

function Select-Target($root) {
    if (-not $root) { return (Install-Mod (Show-ModChoice)) }
    if ($Yes) { return $root }

    $name = Split-Path -Leaf $root
    Write-Host '  Onde instalar?' -ForegroundColor White
    Write-Host ''
    Write-Host "    [1] Usar o $name que ja esta aqui" -ForegroundColor Green
    Write-Host "        $root" -ForegroundColor DarkGray
    Write-Host '    [2] Baixar e usar outro (Equicord ou Vencord)' -ForegroundColor Cyan
    Write-Host ''

    switch (Read-Host '  Escolha') {
        '2' { return (Install-Mod (Show-ModChoice)) }
        default { return $root }
    }
}

# =============================================================================== ferramentas

$TorRoot = Join-Path $env:LOCALAPPDATA 'StreamFix\Tor'
$LegacyTorRoot = Join-Path $env:LOCALAPPDATA 'GoLiveBypass\Tor'
$TorExe = Join-Path $TorRoot 'tor\tor.exe'

function Install-ToolDirect($tool) {
    $spec = if ($tool -eq 'git') {
        @{ Url = $GitExeUrl; Sha256 = $GitExeSha256; File = 'StreamFix-git-installer.exe' }
    } else {
        @{ Url = $NodeMsiUrl; Sha256 = $NodeMsiSha256; File = 'StreamFix-node-installer.msi' }
    }

    $installerPath = Join-Path $env:TEMP $spec.File
    Write-Step "Baixando o instalador oficial do $tool"
    Invoke-WebRequest -UseBasicParsing -Uri $spec.Url -OutFile $installerPath

    Write-Step 'Conferindo o hash do download'
    $actualHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $spec.Sha256) {
        Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
        throw "O hash do instalador do $tool baixado nao bate com o hash fixo no instalador. Abortando: o arquivo pode ter sido adulterado no caminho."
    }

    Write-Step "Instalando o $tool (instalador oficial, silencioso -- pode levar um minuto)"
    # -Wait: msiexec e o instalador do git voltam pro prompt na hora se so chamados com "&".
    $proc = if ($tool -eq 'git') {
        Start-Process -FilePath $installerPath -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS' -Wait -PassThru
    } else {
        Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', "`"$installerPath`"", '/quiet', '/norestart' -Wait -PassThru
    }
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue

    if ($proc.ExitCode -ne 0) {
        throw "O instalador do $tool terminou com codigo de erro $($proc.ExitCode)."
    }
}

# O Tor saiu com a proxy de gateway (fase 0). As duas funcoes abaixo ficam porque quem instalou
# uma versao antiga tem um Tor rodando na maquina, e apagar o codigo que o remove deixaria essa
# pessoa com um daemon orfao para sempre. Elas so removem; nada mais instala Tor.

# Limpa uma instalacao anterior do Tor sob o nome antigo (GoLiveBypass), atalho de autostart
# incluso -- so remove; quem quiser o Tor de volta ganha um novo em $TorRoot na proxima vez
# que escolher essa opcao.
function Remove-LegacyTor {
    if (-not (Test-Path -LiteralPath $LegacyTorRoot)) { return }

    Write-Step 'Removendo a instalacao antiga do Tor (GoLiveBypass -> StreamFix)'

    try {
        $legacyExe = Join-Path $LegacyTorRoot 'tor\tor.exe'
        Get-Process -Name 'tor' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.Equals($legacyExe, [StringComparison]::OrdinalIgnoreCase) } |
            Stop-Process -Force -ErrorAction SilentlyContinue
    } catch { }

    $legacyShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'GoLiveBypass Tor.lnk'
    Remove-Item -LiteralPath $legacyShortcut -Force -ErrorAction SilentlyContinue

    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $LegacyTorRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# So mexe no Tor que o proprio StreamFix instalou (path exato), nunca num tor.exe de outra
# origem -- a pessoa pode ter Tor Browser aberto por outro motivo.
function Remove-TorDaemon {
    if (-not (Test-Path -LiteralPath $TorRoot)) { return }

    Write-Step 'Removendo o Tor que o StreamFix instalou'

    try {
        Get-Process -Name 'tor' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.Equals($TorExe, [StringComparison]::OrdinalIgnoreCase) } |
            Stop-Process -Force -ErrorAction SilentlyContinue
    } catch { }

    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'StreamFix Tor.lnk'
    Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue

    # Da um instante para o processo morto soltar o arquivo de lock antes de apagar a pasta.
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $TorRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# =============================================================================== tunel

# O tunel e o produto agora. Estas funcoes fazem o que so o PowerShell faz -- achar o WireSock,
# instalar o que falta, importar o perfil. Toda a decisao (medir MTU, gerar chave, trocar o
# convite por um endereco, montar o .conf) vive em installer/provisiona.mjs, que chama o
# TypeScript ja testado em vez de reimplementar nada aqui.

$WireSockWingetId = 'NTKERNEL.WireSockVPNClient'
$DefaultTunnelProfile = 'streamfix-santiago'

# O fecho transitivo do provisionador: ele e os modulos que ele importa. Precisam ser gravados
# com o mesmo caminho relativo, senao os imports nao resolvem.
$ProvisioningFiles = @(
    'installer/provisiona.mjs',
    'streamFix/tunnel/perfil.ts',
    'provisionamento/cliente.ts',
    'provisionamento/chaves.ts'
)

function Find-WireSockCli {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'WireSock Secure Connect\command-line\wiresock-connect-cli.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'WireSock Secure Connect\command-line\wiresock-connect-cli.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

# A UNICA elevacao do instalador, e ela nao e nossa: o winget levanta o proprio UAC para este
# install e devolve o controle sem elevar o resto.
#
# Medido em 11/09: list, status, import, delete e connect do wiresock-connect-cli funcionam SEM
# elevacao. Por isso o instalador nao se auto-eleva -- se elevasse, o pnpm e o build rodariam
# como administrador e deixariam arquivos que o dono da conta nao consegue apagar depois.
function Install-WireSock {
    Write-Step 'Instalando o WireSock (vai aparecer uma janela do Windows pedindo permissao)'

    if (-not (Test-Tool 'winget')) {
        throw "Preciso do WireSock e nao achei o winget para instala-lo. Instale o WireSock a mao em https://www.wiresock.net e rode este instalador de novo."
    }

    Invoke-Native { winget install --id $WireSockWingetId --exact --silent --accept-package-agreements --accept-source-agreements }

    Update-PathFromEnvironment
    $cli = Find-WireSockCli
    if (-not $cli) {
        throw "O winget terminou mas nao achei o wiresock-connect-cli.exe. Se a janela de permissao foi recusada, rode de novo e aceite."
    }
    Write-Ok 'WireSock instalado.'
    return $cli
}

function Get-WireSock {
    $cli = Find-WireSockCli
    if ($cli) {
        Write-Step 'WireSock ja instalado'
        return $cli
    }
    return Install-WireSock
}

# Le o endpoint de um perfil que o WireSock ja tem.
#
# `export` escreve o perfil INTEIRO, com a chave privada dentro. Por isso o arquivo nasce numa
# pasta temporaria, e o `finally` o apaga mesmo quando algo falha no meio. So a linha do
# Endpoint sai daqui.
function Get-ExistingTunnel($cli, $profile) {
    $existing = & $cli list 2>&1 | Out-String
    if ($existing -notmatch [regex]::Escape($profile)) { return $null }

    $dir = Join-Path $env:TEMP "streamfix-lt-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    $file = Join-Path $dir 'perfil.conf'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    try {
        & $cli export $profile $file 2>&1 | Out-Null
        if (-not (Test-Path -LiteralPath $file)) { return $null }

        $endpoint = $null
        $rota = $null
        foreach ($line in (Get-Content -LiteralPath $file)) {
            if ($line -match '^\s*Endpoint\s*=\s*(\S+)\s*$') { $endpoint = $Matches[1] }
            if ($line -match '^\s*AllowedIPs\s*=\s*(.+?)\s*$') { $rota = $Matches[1] }
        }
        if (-not $endpoint) { return $null }

        return [pscustomobject]@{ perfil = $profile; endpoint = $endpoint; rota = $rota }
    } finally {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Grava o provisionador e seus modulos num diretorio temporario, preservando o caminho
# relativo. Get-RepoFile le do checkout local quando ha um, e baixa da release quando nao ha --
# um caminho so para os dois casos.
function Save-Provisioner {
    $dir = Join-Path $env:TEMP "streamfix-prov-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    foreach ($rel in $ProvisioningFiles) {
        $dest = Join-Path $dir ($rel -replace '/', '\')
        $parent = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Save-Text $dest (Get-RepoFile $rel)
    }
    return $dir
}

function Read-Invite {
    Write-Host ''
    Write-Host '  Cole o convite que voce recebeu de quem administra a saida.' -ForegroundColor White
    Write-Host '  Ele vale poucos usos e nao da acesso a mais nada.' -ForegroundColor DarkGray
    $invite = (Read-Host '  Convite').Trim()
    if (-not $invite) { throw 'Sem convite nao da para montar o tunel. Peca um a quem administra a saida e rode de novo.' }
    return $invite
}

# Chama o provisionador. O convite vai por stdin de proposito: argumento de linha de comando
# aparece na lista de processos para qualquer usuario da maquina.
# Monta um argumento para a linha de comando do Windows.
#
# `ProcessStartInfo.ArgumentList` -- que aceitaria os argumentos um a um, sem isto -- so existe
# no .NET Core. O instalador roda em Windows PowerShell 5.1, que e .NET Framework, e la a
# propriedade vem nula: `.Add()` estoura com "nao e possivel chamar um metodo em uma expressao
# de valor nulo". Sobra montar a string a mao.
#
# As regras sao as do CommandLineToArgvW, e elas nao sao obvias: barra invertida so escapa
# quando vem antes de aspas, e as que precedem a aspa de fechamento precisam ser dobradas.
# Importa aqui porque os caminhos passam por %TEMP%, que pode ter espaco no nome do usuario.
function Format-Argument([string] $valor) {
    if ($valor -ne '' -and $valor -notmatch '[\s"]') { return $valor }

    $sb = New-Object Text.StringBuilder
    [void] $sb.Append('"')
    $barras = 0
    foreach ($ch in $valor.ToCharArray()) {
        if ($ch -eq '\') { $barras++; continue }
        if ($ch -eq '"') {
            [void] $sb.Append('\' * ($barras * 2 + 1)).Append('"')
        } else {
            [void] $sb.Append('\' * $barras).Append($ch)
        }
        $barras = 0
    }
    [void] $sb.Append('\' * ($barras * 2)).Append('"')
    return $sb.ToString()
}

function Invoke-Provisioner($provisionerDir, $invite, $url, $exitKey, $confPath) {
    $script = Join-Path $provisionerDir 'installer\provisiona.mjs'

    # Nao chamar isto de $args: dentro de uma funcao esse nome ja e do PowerShell.
    $argumentos = @($script, '--url', $url, '--arquivo', $confPath)
    if ($exitKey) { $argumentos += @('--chave-da-saida', $exitKey) }

    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = ($argumentos | ForEach-Object { Format-Argument $_ }) -join ' '
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = [Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Write($invite)
    $proc.StandardInput.Close()
    $out = $proc.StandardOutput.ReadToEnd()
    $err = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()

    foreach ($line in ($err -split "`n")) {
        if ($line.Trim()) { Write-Step $line.Trim() }
    }

    $result = $null
    foreach ($line in ($out -split "`n")) {
        if ($line.Trim().StartsWith('{')) {
            try { $result = $line.Trim() | ConvertFrom-Json } catch { }
        }
    }
    if (-not $result) { throw "O provisionador nao respondeu nada que eu entenda. Saida: $out" }
    if (-not $result.ok) { throw "Nao consegui montar o tunel: $($result.erro)" }
    return $result
}

# O nome do perfil no WireSock vem do NOME DO ARQUIVO, nao do que se pede no import -- e o
# import se recusa a sobrescrever. Por isso: apagar antes, e so entao importar.
function Import-TunnelProfile($cli, $confPath, $profile) {
    $existing = & $cli list 2>&1 | Out-String
    if ($existing -match [regex]::Escape($profile)) {
        Write-Step "Substituindo o perfil $profile que ja existia"
        & $cli delete $profile | Out-Null
    }

    $output = & $cli import $confPath 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "O WireSock recusou o perfil: $output" }

    $after = & $cli list 2>&1 | Out-String
    if ($after -notmatch [regex]::Escape($profile)) {
        throw "Importei o perfil mas o WireSock nao o lista. Saida: $after"
    }
}

# Conserta um perfil que carrega a faixa interna em vez de rota.
#
# Ate 11/09 o provisionador escrevia `AllowedIPs = 10.8.0.0/24` -- a faixa de enderecos que a
# saida distribui -- onde vao os DESTINOS que o tunel carrega. O resultado conecta, faz
# handshake, aceita o AllowedApps e nao roteia nada: nenhum servidor do Discord esta nessa
# faixa. Quem instalou nesse periodo tem um perfil assim.
#
# Consertar no lugar em vez de provisionar de novo NAO e refinamento: reprovisionar gera chave
# nova, gasta um uso do convite e deixa o peer antigo ocupando endereco na saida. A chave
# privada ja esta guardada no WireSock, entao da para reescrever so a linha errada.
function Repair-TunnelProfile($cli, $profile) {
    Write-Warn "O perfil $profile foi criado com a rota errada e nao carrega nada."
    Write-Step 'Consertando sem gerar chave nova nem gastar convite'

    $dir = Join-Path $env:TEMP "streamfix-fix-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    $file = Join-Path $dir "$profile.conf"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    try {
        & $cli export $profile $file 2>&1 | Out-Null
        if (-not (Test-Path -LiteralPath $file)) { Write-Warn 'Nao consegui exportar o perfil.'; return $false }

        $linhas = @(Get-Content -LiteralPath $file)
        $saida = New-Object Collections.Generic.List[string]
        $temDns = $false
        foreach ($l in $linhas) {
            if ($l -match '^\s*AllowedIPs\s*=') { $saida.Add('AllowedIPs = 0.0.0.0/0'); continue }
            if ($l -match '^\s*DNS\s*=') { $temDns = $true }
            $saida.Add($l)
            # O DNS entra logo depois do Address, dentro do [Interface]. Sem ele, quem esta no
            # tunel resolve pelo resolvedor de casa, e o GeoDNS do Discord devolve servidor
            # brasileiro mesmo com os pacotes saindo pelo Chile.
            if (-not $temDns -and $l -match '^\s*Address\s*=') { $saida.Add('DNS = 1.1.1.1'); $temDns = $true }
        }

        Set-Content -LiteralPath $file -Value $saida -Encoding UTF8

        # Derrubar so se o que esta no ar for este perfil: `disconnect` nao escolhe, e
        # consertar um perfil parado nao pode desligar o tunel que a pessoa esta usando.
        if ((& $cli status 2>&1 | Out-String) -match [regex]::Escape($profile)) {
            & $cli disconnect 2>&1 | Out-Null
        }
        & $cli delete $profile 2>&1 | Out-Null
        $out = (& $cli import $file 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { Write-Err "Nao consegui reimportar o perfil: $out"; return $false }

        Write-Ok 'Perfil consertado: o tunel agora carrega o trafego do Discord.'
        return $true
    } finally {
        # O arquivo exportado tem a chave privada dentro. Ele morre aqui, de qualquer jeito.
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Sobe o tunel, e confere que subiu.
#
# **Isto existe por um bug de verdade, nao por completude.** Sem conectar aqui, o instalador
# terminava, abria o Discord, e so entao o plugin subia o tunel -- tarde demais. O WebSocket de
# gateway ja tinha nascido pelo IP brasileiro, e o WireSock captura conexao NOVA, nao a que ja
# existe. A sessao inteira nascia marcada como brasileira, o cliente engatava a propria trava e
# desabilitava o botao de transmitir. Como o botao nem chama a funcao que o plugin intercepta,
# o porteiro nunca era consultado: a pessoa via o aviso do Discord e nada explicava o porque.
#
# Nao aparece para quem ja usava: o WireSock e um servico, entao o tunel dessas pessoas ja
# estava de pe muito antes de o Discord abrir. So quem instala do zero cai nisso -- ou seja,
# exatamente todo mundo que recebe um convite.
#
# Falhar aqui NAO derruba a instalacao: o plugin tenta subir sozinho no `start()`. O que muda e
# que a pessoa e avisada de que precisa reabrir o Discord, em vez de descobrir pelo botao cinza.
function Connect-Tunnel($cli, $profile) {
    Write-Step "Subindo o tunel no perfil $profile"

    $saidaLog = Join-Path $env:TEMP "streamfix-connect-$([guid]::NewGuid().ToString('N').Substring(0,8)).log"
    $erroLog = "$saidaLog.err"
    $log = ''

    try {
        # -log-level info porque o log e a UNICA coisa que diz quais aplicativos entraram no
        # tunel; ver a conferencia logo abaixo. -exit devolve o controle assim que conecta, e o
        # prazo existe porque, quando o aperto de mao nao fecha, ele fica pendurado para sempre
        # -- medido na fase 3.
        $p = Start-Process -FilePath $cli `
            -ArgumentList 'connect', $profile, '-log-level', 'info', '-exit' `
            -PassThru -NoNewWindow -RedirectStandardOutput $saidaLog -RedirectStandardError $erroLog
        if (-not $p.WaitForExit(20000)) {
            try { $p.Kill() } catch { }
            Write-Warn 'O WireSock demorou demais para conectar.'
            return $false
        }
        foreach ($f in @($saidaLog, $erroLog)) {
            if (Test-Path -LiteralPath $f) { $log += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) }
        }
    } catch {
        Write-Warn "Nao consegui subir o tunel: $($_.Exception.Message)"
        return $false
    } finally {
        Remove-Item -LiteralPath $saidaLog, $erroLog -Force -ErrorAction SilentlyContinue
    }

    # Quem diz se subiu e o status, nao o codigo de saida.
    $status = (& $cli status 2>&1 | Out-String)
    if ($status -notmatch [regex]::Escape($profile)) {
        Write-Warn 'O WireSock nao confirmou a conexao.'
        return $false
    }

    # **A conferencia que justifica capturar o log.** O `#@ws:AllowedApps` pode ser descartado
    # em silencio, e ai o tunel leva a MAQUINA INTEIRA em vez de so o Discord -- tudo continua
    # parecendo funcionar. O log do connect diz quais aplicativos valeram, e e a unica chance de
    # saber: nenhum comando do CLI mostra isso depois, e o plugin, que confia num tunel que ja
    # encontrou de pe, depende desta conferencia ter acontecido aqui.
    #
    # A leitura rigorosa (JSON, linha a linha) vive em streamFix/tunnel/controle.ts, com teste.
    # Aqui basta pegar o caso catastrofico: nenhum split tunnel declarado.
    if ($log -match 'AllowedApps') {
        if ($log -notmatch 'AllowedApps[^\r\n]*Discord') {
            & $cli disconnect 2>&1 | Out-Null
            Write-Err 'O tunel subiu sem restringir ao Discord, entao eu o derrubei.'
            Write-Host '  Deixa-lo de pe mandaria TODO o seu trafego para a saida, nao so o Discord.' -ForegroundColor DarkGray
            return $false
        }

        # A outra metade da configuracao, e ela nao pode ser esquecida: AllowedApps diz QUEM
        # entra no tunel, AllowedIPs diz PARA ONDE. Com o app certo e a rota errada o tunel
        # sobe, aperta a mao, e nao carrega nada -- foi assim que dois amigos ficaram com um
        # "conectado" que nao servia para coisa nenhuma.
        if ($log -match 'AllowedIPs=([^"\r\n]+)') {
            $rota = $Matches[1].Trim()
            if ($rota -ne '0.0.0.0/0') {
                Write-Warn "O tunel subiu carregando so $rota, e o Discord nao esta nessa faixa."
                Write-Host '  Ele nao vai servir para nada. Rode o instalador de novo para consertar o perfil.' -ForegroundColor DarkGray
                return $false
            }
        }

        Write-Ok 'Tunel de pe, levando so o Discord, com rota para tudo.'
        return $true
    }

    # Sem log nenhum: o tunel ja estava de pe antes (o CLI recusa uma segunda conexao sem
    # emitir log). Nao da para conferir o split tunnel desta vez, e mentir dizendo que conferiu
    # seria pior do que dizer a verdade.
    Write-Ok 'Tunel de pe.'
    Write-Host '  Ele ja estava conectado, entao nao deu para conferir aqui se leva so o Discord.' -ForegroundColor DarkGray
    Write-Host '  Para conferir: .\Verifica-Tunel.ps1' -ForegroundColor DarkGray
    return $true
}

# Monta o tunel inteiro. Roda ANTES de o plugin ser copiado e ativado: se qualquer coisa aqui
# falhar, a pessoa fica sem plugin em vez de ficar com um plugin ligado e sem tunel -- que e o
# pior estado possivel, porque parece pronto.
function Install-Tunnel($url, $exitKey, $profile) {
    if (-not $profile) { $profile = $DefaultTunnelProfile }

    $cli = Get-WireSock

    # Instalar de novo NAO pode provisionar de novo. Cada provisionamento gera uma chave nova,
    # gasta um uso do convite e deixa o peer anterior orfao ocupando endereco na saida -- e
    # atualizar o plugin passa por aqui toda vez. Quem ja tem perfil so precisa do plugin novo.
    if (-not $Reprovision) {
        $existente = Get-ExistingTunnel $cli $profile
        if ($existente) {
            Write-Ok "Tunel ja configurado no perfil $profile (saida $($existente.endpoint))"
            Write-Host '  Nao pedi convite nem gerei chave nova. Para refazer do zero: -Reprovision' -ForegroundColor DarkGray

            # Rota que nao e padrao = perfil da epoca do bug. Consertar aqui e o que faz uma
            # reinstalacao resolver o problema de quem ja instalou.
            if ($existente.rota -ne '0.0.0.0/0') {
                if (Repair-TunnelProfile $cli $profile) {
                    $existente = Get-ExistingTunnel $cli $profile
                }
            }

            # Configurado nao quer dizer de pe. Se estiver fora, o Discord abriria pelo Brasil.
            $status = (& $cli status 2>&1 | Out-String)
            if ($status -notmatch [regex]::Escape($profile)) {
                $existente | Add-Member -NotePropertyName conectado -NotePropertyValue (Connect-Tunnel $cli $profile) -Force
            } else {
                $existente | Add-Member -NotePropertyName conectado -NotePropertyValue $true -Force
            }
            return $existente
        }
    }

    $invite = Read-Invite
    $provisionerDir = Save-Provisioner

    # O arquivo nasce com a chave privada dentro. Ele vive o tempo do import e morre no finally,
    # ate quando algo falha no meio -- o WireSock guarda copia propria (medido em 11/09).
    $confPath = Join-Path $env:TEMP "$profile.conf"
    try {
        $result = Invoke-Provisioner $provisionerDir $invite $url $exitKey $confPath
        Import-TunnelProfile $cli $confPath $result.perfil

        Write-Ok "Tunel pronto: $($result.endereco) pela saida $($result.endpoint)"
        Write-Host "  MTU medido: caminho $($result.mtuDoCaminho), tunel $($result.mtuDoTunel)" -ForegroundColor DarkGray

        # Antes de o Discord abrir, senao o gateway dele nasce pelo Brasil. Ver Connect-Tunnel.
        $result | Add-Member -NotePropertyName conectado -NotePropertyValue (Connect-Tunnel $cli $result.perfil) -Force
        return $result
    } finally {
        Remove-Item -LiteralPath $confPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $provisionerDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Select-Persistence {
    if ($Yes) { return $true }

    Write-Host ''
    Write-Host '  Como voce quer deixar o Discord?' -ForegroundColor White
    Write-Host ''
    Write-Host '    [1] Permanente' -ForegroundColor Green
    Write-Host '        O Discord abre com o mod toda vez, ate voce remover.' -ForegroundColor DarkGray
    Write-Host '    [2] Temporario' -ForegroundColor Yellow
    Write-Host '        Vale so nesta sessao. Quando voce fechar o Discord, a injecao e desfeita.' -ForegroundColor DarkGray
    Write-Host ''

    return (Read-Host '  Escolha') -ne '2'
}

function Wait-DiscordExit($root) {
    Write-Host ''
    Write-Ok 'Discord aberto com o StreamFix.'
    Write-Warn 'Deixe esta janela aberta. Quando voce fechar o Discord, eu desfaco a injecao.'
    Write-Host '  Se fechar esta janela antes, rode: .\StreamFix-Installer.ps1 -Mode Uninstall' -ForegroundColor DarkGray

    try {
        # Esperar o Discord APARECER antes de esperar ele sumir. Sem isso, o Update.exe ainda
        # nao trocou de processo e o laco acha que ja fechou, desfazendo tudo em 5 segundos.
        for ($i = 0; $i -lt 90; $i++) {
            if (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue) { break }
            Start-Sleep -Seconds 1
        }

        if (-not (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue)) {
            Write-Warn 'O Discord nao abriu em 90s. Vou desfazer a injecao agora.'
        } else {
            while (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
            Write-Host ''
            Write-Step 'Discord fechado, desfazendo a injecao'
        }
    } finally {
        # finally para que Ctrl+C tambem desfaca, em vez de deixar o Discord injetado.
        Push-Location -LiteralPath $root
        try {
            Invoke-Native { pnpm uninject -- --branch auto }
            if ($LASTEXITCODE -ne 0) { Write-Warn 'O pnpm uninject falhou. Rode "pnpm uninject" na pasta do mod.' }
            else { Write-Ok 'Discord restaurado.' }
        } finally { Pop-Location }
    }
}

function Invoke-RestoreEverything {
    $root = Find-Checkout
    if ($root) {
        $target = Join-Path $root "src\userplugins\$PluginDirName"
        if (Test-Path -LiteralPath $target) {
            Write-Step "Removendo $target"
            Remove-Item -LiteralPath $target -Recurse -Force
        }

        Stop-Discord
        Push-Location -LiteralPath $root
        try {
            Write-Step 'Desfazendo a injecao'
            Invoke-Native { pnpm uninject -- --branch auto }
        } finally { Pop-Location }
    } else {
        Write-Warn 'Nao achei o fonte do mod, entao so posso parar por aqui.'
    }

    Remove-TorDaemon

    Write-Host ''
    Write-Ok 'Tudo restaurado. Seu Discord voltou ao normal.'
}

function Show-MainMenu {
    $root = Find-Checkout
    Show-Status $root

    Write-Host '  O que voce quer fazer?' -ForegroundColor White
    Write-Host ''
    Write-Host '    [1] Instalar ou atualizar o StreamFix' -ForegroundColor Green
    Write-Host '    [2] Remover so o plugin (o mod continua)' -ForegroundColor Yellow
    Write-Host '    [3] Restaurar tudo (remove o plugin e desfaz a injecao)' -ForegroundColor Red
    Write-Host '    [0] Sair' -ForegroundColor Gray
    Write-Host ''

    switch (Read-Host '  Escolha') {
        '1' { Invoke-Install $root }
        '2' { Invoke-Uninstall }
        '3' { Invoke-RestoreEverything }
        default { Write-Host '  Ate mais.' -ForegroundColor DarkGray }
    }
}

if (-not $NoAutoRun) {
    # Start-Transcript grava a tela num arquivo no Desktop mesmo que a janela feche rapido
    # demais pra ler. So pausa quando NAO e -Yes -- automacao passa -Yes sem stdin pra responder.
    $logPath = $null
    try {
        $logPath = Join-Path ([Environment]::GetFolderPath('Desktop')) "StreamFix-log-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
        Start-Transcript -Path $logPath -Append | Out-Null
    } catch {
        $logPath = $null
    }

    Show-Banner

    $failed = $false
    try {
        switch ($Mode) {
            'Install' { Invoke-Install (Find-Checkout) }
            'Uninstall' { Invoke-Uninstall }
            'Restore' { Invoke-RestoreEverything }
            default { Show-MainMenu }
        }
    } catch {
        $failed = $true
        Write-Host ''
        Write-Err $_.Exception.Message
    }

    if ($logPath) {
        try { Stop-Transcript | Out-Null } catch { }
        Write-Host ''
        Write-Host "  Log completo desta instalacao: $logPath" -ForegroundColor DarkGray
    }

    Write-Host ''

    if (-not $Yes) {
        Write-Host '  Pressione Enter para fechar...' -ForegroundColor DarkGray
        try { Read-Host | Out-Null } catch { }
    }

    if ($failed) { exit 1 }
}
