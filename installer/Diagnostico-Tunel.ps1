<#
    StreamFix - diagnostico do tunel

    Para quando o tunel esta "conectado" e mesmo assim nada funciona.

    Uso:
      Diagnostico-Tunel.bat                      (dois cliques -- o jeito recomendado)

    Rodar o .ps1 direto so funciona se a politica de execucao da maquina permitir; no padrao
    do Windows ele falha com "nao esta assinado digitalmente". Se voce nao tiver o .bat:

      powershell -ExecutionPolicy Bypass -File .\Diagnostico-Tunel.ps1
      powershell -ExecutionPolicy Bypass -File .\Diagnostico-Tunel.ps1 -SemReconectar

    Ele imprime um relatorio para voce colar. **Nao contem token, senha nem chave privada** --
    qualquer coisa com cara de chave e substituida antes de aparecer.

    Por que ele existe: o modo de falha mais confuso deste projeto e o tunel subir e o Discord
    continuar saindo por fora dele. Tudo parece certo -- WireSock diz conectado, o perfil
    existe, o peer aparece na saida -- e a unica coisa que denuncia e o trafego nao passar. As
    causas ja vistas sao o `#@ws:AllowedApps` nao casar com o cliente instalado e a camada que
    intercepta nao estar de pe.
#>

[CmdletBinding()]
param(
    [string] $Profile = 'streamfix-santiago',

    # Descobrir o que o WireSock aplicou exige reconectar: so o `connect` reporta os
    # aplicativos, e ele nao reporta nada quando o tunel ja esta de pe. Sao uns 2 segundos.
    [switch] $SemReconectar
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Titulo($t) { Write-Host "`n== $t ==" -ForegroundColor White }
function Linha($r, $v) { Write-Host ("  {0,-24} {1}" -f $r, $v) }
function Bom($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Ruim($t) { Write-Host "  [X]  $t" -ForegroundColor Red }
function Nota($t) { Write-Host "  $t" -ForegroundColor DarkGray }

# Qualquer coisa com forma de chave WireGuard sai do relatorio. Ele e feito para ser colado.
function Limpar([string] $t) {
    if (-not $t) { return '' }
    return ($t -replace '[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]{2}', '<chave omitida>')
}


# O wiresock-connect-cli e um programa .NET: ele le o proprio runtimeconfig.json e carrega o
# runtime pelo `hostfxr`. Quando essa instalacao do .NET esta quebrada, o CLI nem inicia -- o
# Windows mostra uma caixa "Imagem Incompleta" com status 0xc0000127 (procedimento nao
# encontrado) e nada do StreamFix funciona a partir dali.
#
# Nao da para detectar isso rodando o proprio CLI: a falha acontece no carregamento e abre uma
# caixa de dialogo, que travaria o instalador esperando um clique. Entao perguntamos ao
# `dotnet`, que usa o MESMO hostfxr -- se ele tambem nao responde, o problema esta ali.
#
# Devolve $null quando esta tudo bem, ou a frase do problema.
function Test-DotNetParaWireSock($cli) {
    $exigido = 10
    $config = Join-Path (Split-Path -Parent $cli) 'wiresock-connect-cli.runtimeconfig.json'
    if (Test-Path -LiteralPath $config) {
        try {
            $j = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
            $v = @($j.runtimeOptions.frameworks | ForEach-Object { $_.version }) |
                Where-Object { $_ } | Select-Object -First 1
            if ($v -match '^(\d+)\.') { $exigido = [int] $Matches[1] }
        } catch { }
    }

    $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if (-not $dotnet) {
        return "o WireSock precisa do .NET Desktop Runtime $exigido e nao ha .NET nenhum nesta maquina"
    }

    $saida = ''
    try { $saida = (& dotnet --list-runtimes 2>&1 | Out-String) } catch { $saida = '' }

    if (-not ($saida -match 'Microsoft\.NETCore\.App')) {
        # `dotnet --list-runtimes` usa o mesmo hostfxr que o CLI. Ele calar e o sinal.
        return "a instalacao do .NET desta maquina esta quebrada: nem o proprio `dotnet` consegue listar os runtimes"
    }
    if (-not ($saida -match "Microsoft\.WindowsDesktop\.App $exigido\.")) {
        return "falta o .NET Desktop Runtime $exigido (o WireSock precisa dele, nao so do runtime basico)"
    }
    return $null
}

# O perfil aparece no texto como nome inteiro? `streamfix-santiago` esta contido em
# `streamfix-santiago-controle`. Mesma regra do instalador (Test-ProfileName).
function Tem-Perfil([string] $texto, [string] $perfil) {
    if (-not $perfil) { return $false }
    return $texto -match ('(?<![\p{L}\p{N}_-])' + [regex]::Escape($perfil) + '(?![\p{L}\p{N}_-])')
}

# O que o perfil de controle carrega. Espelho de FAIXA_CONTROLE (streamFix/tunnel/perfil.ts).
$ControlRange = '162.159.128.0/17, 1.1.1.1/32'
$Controle = "$Profile-controle"

function Achar-Cli {
    foreach ($c in @(
        (Join-Path $env:ProgramFiles 'WireSock Secure Connect\command-line\wiresock-connect-cli.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'WireSock Secure Connect\command-line\wiresock-connect-cli.exe')
    )) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

Write-Host ''
Write-Host '  StreamFix -- diagnostico do tunel' -ForegroundColor White
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm')" -ForegroundColor DarkGray

# ------------------------------------------------------------------ 1. o que intercepta
Titulo 'a camada que intercepta'

$servicos = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'WireSock' }
if (-not $servicos) {
    Ruim 'Nenhum servico do WireSock. Ele nao esta instalado, ou a instalacao falhou.'
} else {
    foreach ($s in $servicos) { Linha $s.Name "$($s.Status) / $($s.StartType)" }
    $parados = @($servicos | Where-Object { $_.Status -ne 'Running' })
    if ($parados) { Ruim "Parado(s): $($parados.Name -join ', ') -- sem isso nada e interceptado." }
}

$pacotes = @(Get-ItemProperty `
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' `
    -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*WireSock*' })

if (-not $pacotes) {
    Ruim 'WireSock nao aparece nos programas instalados.'
} else {
    foreach ($p in ($pacotes | Select-Object DisplayName, DisplayVersion -Unique)) {
        Linha $p.DisplayName $p.DisplayVersion
    }
    if (-not ($pacotes | Where-Object { $_.DisplayName -like '*Kernel*' })) {
        Ruim 'O "WireSock Kernel Drivers" nao esta instalado -- e ele que desvia o trafego.'
        Nota 'Reinstale o WireSock e reinicie o computador.'
    }
}

# `PendingFileRenameOperations` fica setado no Windows por motivos que nada tem a ver com o
# WireSock -- numa maquina que funciona ele estava la. Reportado como informacao, nunca como
# diagnostico: um alarme falso aqui manda a pessoa reiniciar a toa e ensina a ignorar o resto.
# Quem manda reiniciar e a combinacao "driver ou servico faltando", que e o sinal de verdade.
$cbs = Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
$arquivosPendentes = [bool] (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' `
    -Name PendingFileRenameOperations -ErrorAction SilentlyContinue)
Linha 'reinicio do Windows' $cbs
Linha 'arquivos pendentes' "$arquivosPendentes (comum, nao quer dizer nada sozinho)"

$camadaIncompleta = (-not $pacotes) -or
                    (-not ($pacotes | Where-Object { $_.DisplayName -like '*Kernel*' })) -or
                    (-not $servicos) -or
                    @($servicos | Where-Object { $_.Status -ne 'Running' }).Count -gt 0
if ($camadaIncompleta) {
    Ruim 'A camada que intercepta nao esta completa.'
    Nota 'Reinstale o WireSock e REINICIE o computador -- driver novo so vale depois disso.'
} elseif ($cbs) {
    Nota 'Ha um reinicio do Windows pendente. Se nada mais explicar, reinicie e teste de novo.'
}

# ------------------------------------------------------------------ 2. o Discord
Titulo 'qual Discord esta rodando'

$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'iscord|esktop|quibop' })
if (-not $procs) {
    Ruim 'Nenhum Discord rodando. Abra o Discord antes de rodar isto.'
} else {
    foreach ($g in ($procs | Group-Object Name)) {
        $caminho = ($g.Group | Where-Object { $_.Path } | Select-Object -First 1).Path
        Linha $g.Name "$($g.Count) processo(s)  $caminho"
    }
    $nomes = @($procs | Select-Object -ExpandProperty Name -Unique)
    if ($nomes -notcontains 'Discord' -and -not ($nomes -match '^Discord')) {
        Ruim "O que esta rodando ($($nomes -join ', ')) nao e um Discord suportado."
    }
}

# ------------------------------------------------------------------ 3. o tunel
Titulo 'o tunel'

$cli = Achar-Cli
if (-not $cli) {
    Ruim 'Nao achei o wiresock-connect-cli.exe. Pare por aqui: o WireSock nao esta instalado.'
    exit 1
}

# Conferir isto ANTES de chamar o CLI: quando o .NET esta quebrado, chama-lo abre uma caixa de
# dialogo do Windows e o diagnostico fica parado esperando um clique que ninguem vai dar.
$problemaDotNet = Test-DotNetParaWireSock $cli
if ($problemaDotNet) {
    Ruim "O WireSock nao consegue nem iniciar: $problemaDotNet."
    Nota 'Baixe o .NET Desktop Runtime x64 em https://dotnet.microsoft.com/download/dotnet/10.0'
    Nota 'Instale por cima mesmo que ja exista: isso grava um host novo e bom.'
    Nota 'Depois disso, rode este diagnostico de novo.'
    exit 1
}

$lista = (& $cli list 2>&1 | Out-String)
Linha 'perfil completo' "$Profile existe: $(Tem-Perfil $lista $Profile)"
Linha 'perfil de controle' "$Controle existe: $(Tem-Perfil $lista $Controle)"
$status = (& $cli status 2>&1 | Out-String)
foreach ($l in ($status -split "`r?`n")) { if ($l.Trim()) { Nota (Limpar $l.Trim()) } }

# O perfil que se confere abaixo e o que esta no ar. Sem nenhum dos dois, o completo.
$alvo = $Profile
$rotaEsperada = '0.0.0.0/0'
if (Tem-Perfil $status $Controle) {
    $alvo = $Controle
    $rotaEsperada = $ControlRange
    Nota "No ar: $Controle (so o controle). O endereco externo acima e o de casa, e isso e normal."
} elseif (Tem-Perfil $status $Profile) {
    Nota "No ar: $Profile (completo)."
}

# ------------------------------------------------------------------ 4. o que entra no tunel
Titulo 'o que o WireSock aplicou'

if ($SemReconectar) {
    Nota 'Pulado (-SemReconectar). So o `connect` reporta isto, e ele cala quando ja esta de pe.'
} else {
    Nota 'Reconectando para descobrir -- uns 2 segundos.'
    $out = Join-Path $env:TEMP "sf-diag-$([guid]::NewGuid().ToString('N').Substring(0,8)).log"
    $err = "$out.err"
    $log = ''
    try {
        & $cli disconnect 2>&1 | Out-Null
        Start-Sleep -Milliseconds 500
        $p = Start-Process -FilePath $cli -ArgumentList 'connect', $alvo, '-log-level', 'info', '-exit' `
            -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
        if (-not $p.WaitForExit(20000)) { try { $p.Kill() } catch { } ; Ruim 'O connect ficou pendurado.' }
        foreach ($f in @($out, $err)) {
            if (Test-Path -LiteralPath $f) { $log += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) }
        }
    } finally {
        Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
    }

    # **As duas linhas importam, e por muito tempo esta secao olhava so uma.** O WireSock
    # reporta AllowedIPs (quais destinos entram no tunel) e AllowedApps (quais programas). Um
    # perfil com o app certo e a rota errada conecta, aperta a mao, e nao carrega nada -- e o
    # diagnostico dizia "[OK]" com a prova do problema uma linha acima, descartada pelo filtro.
    $linhas = @($log -split "`r?`n" | Where-Object { $_ -match 'Allowed(IPs|Apps)' })
    if (-not $linhas) {
        Ruim 'O WireSock nao declarou split tunnel nenhum.'
        Nota 'Ou o perfil nao tem as diretivas, ou elas foram descartadas. Nao deixe assim:'
        Nota 'sem AllowedApps, o tunel leva a MAQUINA INTEIRA, nao so o Discord.'
    } else {
        foreach ($l in $linhas) { Nota (Limpar $l.Trim()) }

        $rota = $null
        if ($log -match 'AllowedIPs=([^"\r\n]+)') { $rota = $Matches[1].Trim() }

        # O log escreve a rota sem espaco depois da virgula; o perfil, com. Medido em 12/09.
        if (-not $rota) {
            Ruim 'O WireSock nao declarou AllowedIPs.'
        } elseif (($rota -replace '\s', '') -ne ($rotaEsperada -replace '\s', '')) {
            Ruim "O perfil $alvo carrega $rota, e deveria carregar $rotaEsperada."
            Nota 'E por isso que ele conecta e nada funciona. Rode o instalador de novo:'
            Nota 'ele conserta o perfil sem gerar chave nova nem gastar convite.'
        } elseif ($rotaEsperada -eq '0.0.0.0/0') {
            Bom 'O tunel carrega rota padrao -- os destinos do Discord entram nele.'
        } else {
            Bom 'O tunel carrega a faixa de controle -- o gateway entra nele, a midia sai direta.'
        }

        if ($log -match 'AllowedApps[^\r\n]*Discord') {
            Bom 'O WireSock aceitou o Discord no tunel.'
        } else {
            Ruim 'O WireSock NAO aceitou o Discord -- o perfil lista outro aplicativo.'
            Nota 'Rode o instalador de novo para refazer o perfil.'
        }
    }
}

# ------------------------------------------------------------------ 5. por onde as coisas saem
Titulo 'por onde o trafego sai'

try {
    # 1.1.1.1 esta dentro das duas rotas do tunel, entao a medida vale nos dois perfis. Ver o
    # comentario do TraceUrl no Verifica-Tunel.ps1.
    $trace = Invoke-RestMethod -Uri 'https://1.1.1.1/cdn-cgi/trace' -UseBasicParsing -TimeoutSec 20
    $meu = ($trace -split "`n" | Where-Object { $_ -like 'ip=*' }) -replace '^ip=', ''
    $pais = ($trace -split "`n" | Where-Object { $_ -like 'loc=*' }) -replace '^loc=', ''
    Linha 'este PowerShell' "$meu ($pais)"
    Nota 'Este NAO deve ser o endereco da saida: o tunel e so para o Discord.'
} catch {
    Ruim "Nao consegui medir: $($_.Exception.Message)"
}

Write-Host ''
Nota 'No Discord, rode /streamfix e mande as duas saidas juntas.'
Nota 'A linha "o Discord diz" e a que conta: ela tem que ser o endereco da saida.'
Write-Host ''
