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

$lista = (& $cli list 2>&1 | Out-String)
Linha 'perfil existe' ($lista -match [regex]::Escape($Profile))
$status = (& $cli status 2>&1 | Out-String)
foreach ($l in ($status -split "`r?`n")) { if ($l.Trim()) { Nota (Limpar $l.Trim()) } }

# ------------------------------------------------------------------ 4. o que entra no tunel
Titulo 'quais aplicativos o WireSock aceitou'

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
        $p = Start-Process -FilePath $cli -ArgumentList 'connect', $Profile, '-log-level', 'info', '-exit' `
            -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
        if (-not $p.WaitForExit(20000)) { try { $p.Kill() } catch { } ; Ruim 'O connect ficou pendurado.' }
        foreach ($f in @($out, $err)) {
            if (Test-Path -LiteralPath $f) { $log += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) }
        }
    } finally {
        Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
    }

    $linhas = @($log -split "`r?`n" | Where-Object { $_ -match 'AllowedApps' })
    if ($linhas) {
        foreach ($l in $linhas) { Nota (Limpar $l.Trim()) }
        if ($log -match 'AllowedApps[^\r\n]*Discord') {
            Bom 'O WireSock aceitou o Discord no tunel.'
        } else {
            Ruim 'O WireSock NAO aceitou o Discord -- o perfil lista outro aplicativo.'
            Nota 'Refaca o perfil: .\StreamFix-Installer.ps1 -Reprovision'
        }
    } else {
        Ruim 'O WireSock nao declarou split tunnel nenhum.'
        Nota 'Ou o perfil nao tem a diretiva, ou ela foi descartada. Nao deixe o tunel assim:'
        Nota 'sem ela, o tunel leva a MAQUINA INTEIRA, nao so o Discord.'
    }
}

# ------------------------------------------------------------------ 5. por onde as coisas saem
Titulo 'por onde o trafego sai'

try {
    $trace = Invoke-RestMethod -Uri 'https://cloudflare.com/cdn-cgi/trace' -UseBasicParsing -TimeoutSec 20
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
