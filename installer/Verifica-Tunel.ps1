<#
    StreamFix - confere se o tunel esta fazendo o que promete

    Uso:
      .\Verifica-Tunel.ps1
      .\Verifica-Tunel.ps1 -Profile streamfix-santiago -ExitHost 159.112.151.37

    Este script existe por causa do pior modo de falha deste projeto: o teste que passa medindo
    outra coisa. O `#@ws:AllowedApps` do perfil pode ser descartado em silencio -- ja foi --, e
    quando isso acontece o tunel leva a MAQUINA INTEIRA em vez de so o Discord. Tudo continua
    parecendo funcionar: o Go Live sobe, a transmissao aparece. O que muda e que todo o seu
    trafego passa a sair pela saida, o que voce nao pediu e nao quer.

    O jeito de pegar isso e medir pelo lado de fora: um processo que NAO e o Discord tem que
    continuar saindo pelo seu IP de sempre.
#>

[CmdletBinding()]
param(
    [string] $Profile = 'streamfix-santiago',

    # O host da sua saida, sem porta. E o mesmo valor que esta em "Endereco da saida" nas
    # configuracoes do plugin, sem o `:porta`.
    [string] $ExitHost = '',

    # Quem responde "qual e o meu IP". Trocavel para quem nao quiser bater na Cloudflare.
    [string] $TraceUrl = 'https://cloudflare.com/cdn-cgi/trace'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Write-Bad($t)  { Write-Host "  [X]  $t" -ForegroundColor Red }
function Write-Info($t) { Write-Host "  $t" -ForegroundColor DarkGray }

function Find-WireSockCli {
    foreach ($c in @(
        (Join-Path $env:ProgramFiles 'WireSock Secure Connect\command-line\wiresock-connect-cli.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'WireSock Secure Connect\command-line\wiresock-connect-cli.exe')
    )) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

Write-Host ''
Write-Host '  StreamFix -- conferindo o tunel' -ForegroundColor White
Write-Host ''

$problemas = 0

# ---------------------------------------------------------------- 1. o tunel esta de pe?
$cli = Find-WireSockCli
if (-not $cli) {
    Write-Bad 'Nao achei o WireSock. Rode o instalador antes.'
    exit 1
}

$status = (& $cli status 2>&1 | Out-String).Trim()
if ($status -match [regex]::Escape($Profile)) {
    Write-Ok "O tunel esta de pe no perfil $Profile"
} else {
    Write-Bad "O tunel nao esta de pe no perfil $Profile"
    Write-Info "O WireSock disse: $status"
    $problemas++
}

# A saida pode ser descoberta pelo proprio status, que informa o endereco externo.
if (-not $ExitHost -and $status -match '(\d{1,3}(?:\.\d{1,3}){3})') {
    $ExitHost = $Matches[1]
    Write-Info "Saida detectada pelo WireSock: $ExitHost"
}

# ---------------------------------------------------------------- 2. O TESTE NEGATIVO
#
# Este e o teste que importa. Ele roda dentro deste PowerShell, que nao e o Discord: se o
# AllowedApps estiver valendo, esta requisicao sai pelo IP de sempre. Se ela sair pela saida, o
# tunel pegou a maquina inteira.
Write-Host ''
Write-Host '  Teste negativo: por onde sai um processo que nao e o Discord?' -ForegroundColor White

try {
    $trace = Invoke-RestMethod -Uri $TraceUrl -UseBasicParsing -TimeoutSec 20
    $meuIp = ($trace -split "`n" | Where-Object { $_ -like 'ip=*' }) -replace '^ip=', ''
    $pais  = ($trace -split "`n" | Where-Object { $_ -like 'loc=*' }) -replace '^loc=', ''

    Write-Info "Este processo sai por $meuIp ($pais)"

    if (-not $ExitHost) {
        Write-Bad 'Sem saber o endereco da saida eu nao consigo julgar. Passe -ExitHost.'
        $problemas++
    } elseif ($meuIp -eq $ExitHost) {
        Write-Bad 'O TUNEL ESTA LEVANDO A MAQUINA INTEIRA, nao so o Discord.'
        Write-Info 'O #@ws:AllowedApps do perfil nao esta valendo. Reinstale o perfil.'
        Write-Info 'Ate consertar, todo o seu trafego esta passando pela saida.'
        $problemas++
    } else {
        Write-Ok "O resto da maquina continua saindo pelo seu IP de sempre ($meuIp)"
        Write-Info "A saida do tunel e outra ($ExitHost), como tem que ser."
    }
} catch {
    Write-Bad "Nao consegui descobrir por onde este processo sai: $($_.Exception.Message)"
    $problemas++
}

# ---------------------------------------------------------------- 3. a outra metade
#
# Confirmar que a midia do Discord sai PELA saida exige ler o motor de midia de dentro do
# Discord, e quem sabe fazer isso e o proprio plugin. Mandar para o lugar certo e mais honesto
# do que inventar aqui uma medicao pior.
Write-Host ''
Write-Host '  A outra metade (a midia do Discord sai PELA saida) quem mede e o plugin:' -ForegroundColor White
Write-Info 'Entre numa call e digite /streamfix no Discord.'
Write-Info 'Na secao "== tunel ==", "o Discord diz" tem que ser o endereco da saida.'

Write-Host ''
if ($problemas -eq 0) {
    Write-Ok 'Tudo certo do lado que da para conferir daqui.'
    exit 0
}

Write-Bad "$problemas problema(s). Veja acima."
exit 1
