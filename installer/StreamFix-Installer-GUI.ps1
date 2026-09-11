<#
    StreamFix - instalador com janela (GUI)

    Faz exatamente o que o StreamFix-Installer.ps1/.bat de terminal faz -- mesmo motor,
    mesmas funcoes, mesmo WireSock/pnpm/git por baixo -- so trocando as perguntas de terminal por
    uma tela com opcoes e um botao "Instalar", e o texto que rolava no console por uma caixa
    de log dentro da janela. Quem prefere ver tudo em texto puro continua usando o .bat ou o
    .ps1 direto; esta janela e so uma segunda forma de chegar no mesmo lugar.

    Uso:
      .\StreamFix-Installer-GUI.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Mesma resolucao em runtime que installer/StreamFix-Installer.ps1 usa pro proprio $RepoRaw
# (ver o comentario la): pega a ultima release estavel pela API do GitHub, sem precisar editar
# nada a cada release. Resolvida uma unica vez aqui e repassada pro motor via -ResolvedTag (nas
# duas chamadas dele abaixo) -- se cada um consultasse a API por conta propria, uma release nova
# saindo no meio da instalacao poderia deixar o motor baixado e os arquivos que ele baixa depois
# vindo de revisoes diferentes.
$script:ResolvedTag = $null

function Resolve-LatestTag {
    if ($script:ResolvedTag) { return $script:ResolvedTag }

    try {
        $release = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'StreamFix-Installer' } `
            -Uri 'https://api.github.com/repos/EduardoVasconceloss/StreamFix/releases/latest'
    } catch {
        throw 'Nao consegui descobrir a ultima release estavel do StreamFix pela API do GitHub. Verifique sua conexao e tente de novo.'
    }

    if (-not $release.tag_name) { throw 'A API do GitHub nao devolveu uma tag de release valida.' }

    $script:ResolvedTag = $release.tag_name
    return $script:ResolvedTag
}

function Resolve-CoreScript {
    if ($PSScriptRoot) {
        $local = Join-Path $PSScriptRoot 'StreamFix-Installer.ps1'
        if (Test-Path -LiteralPath $local) { return (Get-Content -LiteralPath $local -Raw) }
    }

    $url = "https://raw.githubusercontent.com/EduardoVasconceloss/StreamFix/$(Resolve-LatestTag)/installer/StreamFix-Installer.ps1"
    try {
        return (Invoke-WebRequest -UseBasicParsing -Uri $url).Content
    } catch {
        throw 'Nao consegui baixar o motor de instalacao. Verifique sua conexao.'
    }
}

$coreContent = Resolve-CoreScript
$coreTempPath = Join-Path $env:TEMP 'StreamFix-Installer-Core.ps1'
[IO.File]::WriteAllText($coreTempPath, $coreContent, (New-Object Text.UTF8Encoding($false)))

# Write-* viram no-op: nesta janela (-noConsole) nao ha console ouvindo Write-Host.
. $coreTempPath -NoAutoRun -ResolvedTag $script:ResolvedTag
function Write-Step($text) { }
function Write-Ok($text) { }
function Write-Warn($text) { }
function Write-Err($text) { }

$detectedRoot = $null
try { $detectedRoot = Find-Checkout } catch { $detectedRoot = $null }

# =============================================================================== janela

$form = New-Object System.Windows.Forms.Form
$form.Text = 'StreamFix'
$form.Size = New-Object System.Drawing.Size(560, 560)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = 'StreamFix'
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object System.Drawing.Point(20, 15)
$titleLabel.AutoSize = $true
$form.Controls.Add($titleLabel)

$subtitleLabel = New-Object System.Windows.Forms.Label
$subtitleLabel.Text = 'Go Live e camera de volta no Discord'
$subtitleLabel.ForeColor = [System.Drawing.Color]::Gray
$subtitleLabel.Location = New-Object System.Drawing.Point(20, 45)
$subtitleLabel.AutoSize = $true
$form.Controls.Add($subtitleLabel)

# --------------------------------------------------------------------- pagina 1: opcoes

$optionsPage = New-Object System.Windows.Forms.Panel
$optionsPage.Location = New-Object System.Drawing.Point(20, 75)
$optionsPage.Size = New-Object System.Drawing.Size(505, 400)
$form.Controls.Add($optionsPage)

# --- onde instalar ---
$targetBox = New-Object System.Windows.Forms.GroupBox
$targetBox.Text = 'Onde instalar'
$targetBox.Location = New-Object System.Drawing.Point(0, 0)
$targetBox.Size = New-Object System.Drawing.Size(505, 95)
$optionsPage.Controls.Add($targetBox)

$radioUseExisting = New-Object System.Windows.Forms.RadioButton
$radioDownloadEquicord = New-Object System.Windows.Forms.RadioButton
$radioDownloadVencord = New-Object System.Windows.Forms.RadioButton

if ($detectedRoot) {
    $name = Split-Path -Leaf $detectedRoot
    $radioUseExisting.Text = "Usar o $name que ja esta em $detectedRoot"
    $radioUseExisting.Location = New-Object System.Drawing.Point(15, 22)
    $radioUseExisting.AutoSize = $true
    $radioUseExisting.Checked = $true
    $targetBox.Controls.Add($radioUseExisting)

    $radioDownloadEquicord.Text = 'Baixar e usar outro: Equicord (recomendado)'
    $radioDownloadEquicord.Location = New-Object System.Drawing.Point(15, 46)
    $radioDownloadEquicord.AutoSize = $true
    $targetBox.Controls.Add($radioDownloadEquicord)

    $radioDownloadVencord.Text = 'Baixar e usar outro: Vencord'
    $radioDownloadVencord.Location = New-Object System.Drawing.Point(15, 68)
    $radioDownloadVencord.AutoSize = $true
    $targetBox.Controls.Add($radioDownloadVencord)
} else {
    $noneLabel = New-Object System.Windows.Forms.Label
    $noneLabel.Text = 'Nao encontrei Equicord nem Vencord no seu computador. Qual instalar?'
    $noneLabel.Location = New-Object System.Drawing.Point(15, 20)
    $noneLabel.AutoSize = $true
    $targetBox.Controls.Add($noneLabel)

    $radioDownloadEquicord.Text = 'Equicord (recomendado, inclui tudo do Vencord e mais plugins)'
    $radioDownloadEquicord.Location = New-Object System.Drawing.Point(15, 44)
    $radioDownloadEquicord.AutoSize = $true
    $radioDownloadEquicord.Checked = $true
    $targetBox.Controls.Add($radioDownloadEquicord)

    $radioDownloadVencord.Text = 'Vencord (o original, mais enxuto)'
    $radioDownloadVencord.Location = New-Object System.Drawing.Point(15, 66)
    $radioDownloadVencord.AutoSize = $true
    $targetBox.Controls.Add($radioDownloadVencord)
}

# --- saida de rede ---
# Quem ja tem o tunel montado NAO precisa de convite: o instalador detecta o perfil e pula o
# provisionamento inteiro. Exigir o convite aqui mandaria essa pessoa cacar um codigo que nao
# vai ser usado -- e atualizar o plugin passa por esta janela toda vez.
#
# A checagem e a mesma que o motor faz (Get-ExistingTunnel), so que sem precisar dele: a UI
# roda antes de o motor ser carregado no runspace.
function Test-TunnelAlreadySetUp {
    foreach ($cli in @(
        (Join-Path $env:ProgramFiles 'WireSock Secure Connect\command-line\wiresock-connect-cli.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'WireSock Secure Connect\command-line\wiresock-connect-cli.exe')
    )) {
        if (-not $cli -or -not (Test-Path -LiteralPath $cli)) { continue }
        try {
            $lista = & $cli list 2>&1 | Out-String
            if ($lista -match [regex]::Escape('streamfix-santiago')) { return $true }
        } catch { }
    }
    return $false
}

$script:TunnelAlreadySetUp = Test-TunnelAlreadySetUp

$inviteBox = New-Object System.Windows.Forms.GroupBox
$inviteBox.Text = if ($script:TunnelAlreadySetUp) { 'Seu convite para a saida (nao precisa)' } else { 'Seu convite para a saida' }
$inviteBox.Location = New-Object System.Drawing.Point(0, 105)
$inviteBox.Size = New-Object System.Drawing.Size(505, 120)
$optionsPage.Controls.Add($inviteBox)

$inviteHintLabel = New-Object System.Windows.Forms.Label
$inviteHintLabel.Text = if ($script:TunnelAlreadySetUp) {
    'Voce ja tem o tunel montado nesta maquina, entao pode deixar em branco -- so o plugin sera atualizado. Preencha apenas se quiser refazer o tunel do zero.'
} else {
    'Cole o convite que voce recebeu de quem administra a saida. Ele vale poucos usos e nao da acesso a mais nada. Sem ele nao da para montar o tunel.'
}
$inviteHintLabel.Location = New-Object System.Drawing.Point(15, 25)
$inviteHintLabel.Size = New-Object System.Drawing.Size(470, 40)
$inviteHintLabel.ForeColor = [System.Drawing.Color]::DimGray
$inviteBox.Controls.Add($inviteHintLabel)

$inviteTextBox = New-Object System.Windows.Forms.TextBox
$inviteTextBox.Location = New-Object System.Drawing.Point(15, 72)
$inviteTextBox.Size = New-Object System.Drawing.Size(470, 22)
$inviteBox.Controls.Add($inviteTextBox)

# --- persistencia ---
$persistBox = New-Object System.Windows.Forms.GroupBox
$persistBox.Text = 'Como deixar o Discord'
$persistBox.Location = New-Object System.Drawing.Point(0, 278)
$persistBox.Size = New-Object System.Drawing.Size(505, 75)
$optionsPage.Controls.Add($persistBox)

$radioPermanent = New-Object System.Windows.Forms.RadioButton
$radioPermanent.Text = 'Permanente -- o Discord abre com o mod toda vez, ate voce remover'
$radioPermanent.Location = New-Object System.Drawing.Point(15, 22)
$radioPermanent.AutoSize = $true
$radioPermanent.Checked = $true
$persistBox.Controls.Add($radioPermanent)

$radioTemporary = New-Object System.Windows.Forms.RadioButton
$radioTemporary.Text = 'Temporario -- vale so nesta sessao, desfeito quando fechar o Discord'
$radioTemporary.Location = New-Object System.Drawing.Point(15, 46)
$radioTemporary.AutoSize = $true
$persistBox.Controls.Add($radioTemporary)

# --------------------------------------------------------------------- pagina 2: progresso

$progressPage = New-Object System.Windows.Forms.Panel
$progressPage.Location = New-Object System.Drawing.Point(20, 75)
$progressPage.Size = New-Object System.Drawing.Size(505, 400)
$progressPage.Visible = $false
$form.Controls.Add($progressPage)

$progressLabel = New-Object System.Windows.Forms.Label
$progressLabel.Text = 'Instalando...'
$progressLabel.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$progressLabel.Location = New-Object System.Drawing.Point(0, 0)
$progressLabel.AutoSize = $true
$progressPage.Controls.Add($progressLabel)

$progressBar = New-Object System.Windows.Forms.ProgressBar
$progressBar.Style = 'Marquee'
$progressBar.MarqueeAnimationSpeed = 30
$progressBar.Location = New-Object System.Drawing.Point(0, 28)
$progressBar.Size = New-Object System.Drawing.Size(505, 18)
$progressPage.Controls.Add($progressBar)

$logBox = New-Object System.Windows.Forms.RichTextBox
$logBox.Location = New-Object System.Drawing.Point(0, 54)
$logBox.Size = New-Object System.Drawing.Size(505, 346)
$logBox.ReadOnly = $true
$logBox.BackColor = [System.Drawing.Color]::Black
$logBox.ForeColor = [System.Drawing.Color]::Gainsboro
$logBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$progressPage.Controls.Add($logBox)

# --------------------------------------------------------------------- pagina 3: concluido

$donePage = New-Object System.Windows.Forms.Panel
$donePage.Location = New-Object System.Drawing.Point(20, 75)
$donePage.Size = New-Object System.Drawing.Size(505, 400)
$donePage.Visible = $false
$form.Controls.Add($donePage)

$doneIconLabel = New-Object System.Windows.Forms.Label
$doneIconLabel.Font = New-Object System.Drawing.Font('Segoe UI', 28)
$doneIconLabel.Location = New-Object System.Drawing.Point(0, 10)
$doneIconLabel.AutoSize = $true
$donePage.Controls.Add($doneIconLabel)

$doneTitleLabel = New-Object System.Windows.Forms.Label
$doneTitleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$doneTitleLabel.Location = New-Object System.Drawing.Point(60, 20)
$doneTitleLabel.AutoSize = $true
$donePage.Controls.Add($doneTitleLabel)

$doneTextLabel = New-Object System.Windows.Forms.Label
$doneTextLabel.Location = New-Object System.Drawing.Point(0, 70)
$doneTextLabel.Size = New-Object System.Drawing.Size(505, 60)
$donePage.Controls.Add($doneTextLabel)

$doneLogBox = New-Object System.Windows.Forms.RichTextBox
$doneLogBox.Location = New-Object System.Drawing.Point(0, 130)
$doneLogBox.Size = New-Object System.Drawing.Size(505, 270)
$doneLogBox.ReadOnly = $true
$doneLogBox.Visible = $false
$donePage.Controls.Add($doneLogBox)

# --------------------------------------------------------------------- botoes

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = 'Instalar'
$installButton.Location = New-Object System.Drawing.Point(360, 485)
$installButton.Size = New-Object System.Drawing.Size(160, 32)
$installButton.BackColor = [System.Drawing.Color]::FromArgb(88, 101, 242)
$installButton.ForeColor = [System.Drawing.Color]::White
$installButton.FlatStyle = 'Flat'
$form.Controls.Add($installButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = 'Fechar'
$closeButton.Location = New-Object System.Drawing.Point(360, 485)
$closeButton.Size = New-Object System.Drawing.Size(160, 32)
$closeButton.Visible = $false
$form.Controls.Add($closeButton)
$closeButton.Add_Click({ $form.Close() })

# =============================================================================== log

# Chamada so pelo Tick do Timer (thread da UI): controles do WinForms so podem ser tocados
# pela propria thread que os criou. Reagir ao evento DataAdded da colecao (thread da runspace
# de fundo) arriscaria dois pipelines na mesma runspace, que o PowerShell nao suporta.
function Append-Log([string] $text, [System.Drawing.Color] $color) {
    $logBox.SelectionStart = $logBox.TextLength
    $logBox.SelectionLength = 0
    $logBox.SelectionColor = $color
    $logBox.AppendText("$text`n")
    $logBox.ScrollToCaret()
}

function Append-OutputLine($item) {
    if ($null -eq $item) { return }
    $line = "$item"
    $sep = $line.IndexOf('|')
    if ($sep -lt 0) { Append-Log $line $ColorHost; return }

    $prefix = $line.Substring(0, $sep)
    $text = $line.Substring($sep + 1)
    switch ($prefix) {
        'STEP' { Append-Log "  [*] $text" $ColorStep }
        'OK' { Append-Log "  [OK] $text" $ColorOk }
        'WARN' { Append-Log "  [!] $text" $ColorWarn }
        'ERR' { Append-Log "  [X] $text" $ColorErr }
        default { Append-Log $text $ColorHost }
    }
}

$ColorStep = [System.Drawing.Color]::Gainsboro
$ColorOk = [System.Drawing.Color]::LightGreen
$ColorWarn = [System.Drawing.Color]::Khaki
$ColorErr = [System.Drawing.Color]::Salmon
$ColorHost = [System.Drawing.Color]::Gainsboro

# =============================================================================== instalar

# Roda numa runspace separada pra nao travar a janela durante o pnpm build. As funcoes de
# interface do core sao redefinidas aqui pra escrever "PREFIXO|texto" na saida em vez de
# mexer na janela direto -- so a thread da UI pode tocar em controles do WinForms.
$workerTemplate = @'
param(
    [string] $CorePath,
    [string] $TargetRoot,
    [bool] $DownloadFresh,
    [string] $ModChoice,
    [string] $Invite,
    [bool] $Permanent,
    [string] $ResolvedTag
)

$ErrorActionPreference = 'Stop'
. $CorePath -NoAutoRun -ResolvedTag $ResolvedTag

# Write-Information, nunca Write-Output: Write-Output entra no mesmo stream do valor de
# retorno de qualquer funcao no meio do caminho, e uma chamada de log ali dentro corrompia esse
# retorno.
function Write-Host {
    param(
        [Parameter(Position = 0, ValueFromPipeline = $true)] $Object = '',
        [switch] $NoNewline,
        $Separator = ' ',
        $ForegroundColor,
        $BackgroundColor
    )
    process { Write-Information "HOST|$Object" }
}
function Write-Step($text) { Write-Information "STEP|$text" }
function Write-Ok($text) { Write-Information "OK|$text" }
function Write-Warn($text) { Write-Information "WARN|$text" }
function Write-Err($text) { Write-Information "ERR|$text" }

function Confirm-Action($question) {
    $result = [System.Windows.Forms.MessageBox]::Show($question, 'StreamFix', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    return $result -eq [System.Windows.Forms.DialogResult]::Yes
}

function Select-Target($root) {
    if ($DownloadFresh) { return (Install-Mod $ModChoice) }
    return $root
}

# O motor pede o convite pelo terminal; aqui ele ja veio da janela.
function Read-Invite {
    if (-not $Invite) { throw 'Sem convite nao da para montar o tunel. Peca um a quem administra a saida e rode de novo.' }
    return $Invite
}

function Select-Persistence { return $Permanent }

Invoke-Install $TargetRoot
'@

$state = [pscustomobject]@{
    Runspace = $null
    Pipeline = $null
    AsyncResult = $null
    Output = $null
    Timer = $null
    LastIndex = 0
    InfoLastIndex = 0
}

function Start-Install {
    $modChoice = if ($radioDownloadVencord.Checked) { 'Vencord' } else { 'Equicord' }
    $downloadFresh = -not ($detectedRoot -and $radioUseExisting.Checked)

    # Recusar aqui, antes de comecar, e o ponto -- mas so para quem realmente precisa: sem
    # convite E sem tunel, a instalacao iria ate o meio e morreria na hora de montar o tunel,
    # deixando a pessoa com o mod baixado e nada funcionando. Quem ja tem tunel nao precisa de
    # convite nenhum, e barrar essa pessoa a mandaria cacar um codigo que ninguem vai usar.
    $invite = $inviteTextBox.Text.Trim()
    if (-not $invite -and -not $script:TunnelAlreadySetUp) {
        [System.Windows.Forms.MessageBox]::Show('Cole o convite que voce recebeu de quem administra a saida. Sem ele nao da para montar o tunel.', 'StreamFix', 'OK', 'Warning') | Out-Null
        return
    }

    $optionsPage.Visible = $false
    $progressPage.Visible = $true
    $installButton.Visible = $false
    $form.Text = 'StreamFix -- instalando...'

    $runspace = [runspacefactory]::CreateRunspace()
    $runspace.Open()

    $ps = [powershell]::Create()
    $ps.Runspace = $runspace
    $ps.AddScript($workerTemplate) | Out-Null
    $ps.AddParameter('CorePath', $coreTempPath) | Out-Null
    $ps.AddParameter('TargetRoot', $detectedRoot) | Out-Null
    $ps.AddParameter('DownloadFresh', $downloadFresh) | Out-Null
    $ps.AddParameter('ModChoice', $modChoice) | Out-Null
    $ps.AddParameter('Invite', $invite) | Out-Null
    $ps.AddParameter('Permanent', [bool] $radioPermanent.Checked) | Out-Null
    $ps.AddParameter('ResolvedTag', $script:ResolvedTag) | Out-Null

    $output = New-Object 'System.Management.Automation.PSDataCollection[psobject]'

    # BeginInvoke($null, $output) nao resolve a sobrecarga certa entre as varias que aceitam
    # colecao de entrada; uma vazia e tipada resolve sem ambiguidade.
    $emptyInput = New-Object 'System.Management.Automation.PSDataCollection[psobject]'
    $state.Runspace = $runspace
    $state.Pipeline = $ps
    $state.Output = $output
    $state.LastIndex = 0
    $state.InfoLastIndex = 0
    $state.AsyncResult = $ps.BeginInvoke($emptyInput, $output)

    # Tick do Timer roda na thread da UI, entao puxar $output/Streams.Information aqui e
    # seguro sem Invoke (ver o comentario de Append-Log).
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 200
    $timer.Add_Tick({
        while ($state.LastIndex -lt $state.Output.Count) {
            Append-OutputLine $state.Output[$state.LastIndex]
            $state.LastIndex++
        }

        $infoStream = $state.Pipeline.Streams.Information
        while ($state.InfoLastIndex -lt $infoStream.Count) {
            Append-OutputLine $infoStream[$state.InfoLastIndex].MessageData
            $state.InfoLastIndex++
        }

        if (-not $state.AsyncResult.IsCompleted) { return }
        $state.Timer.Stop()

        $failure = $null
        try {
            $state.Pipeline.EndInvoke($state.AsyncResult)
        } catch {
            $failure = $_.Exception.Message
        }

        if (-not $failure -and $state.Pipeline.Streams.Error.Count -gt 0) {
            $failure = ($state.Pipeline.Streams.Error | Select-Object -First 1).ToString()
        }

        $state.Pipeline.Dispose()
        $state.Runspace.Close()
        $state.Runspace.Dispose()

        Show-Done $failure
    })
    $state.Timer = $timer
    $timer.Start()
}

function Show-Done([string] $failure) {
    $progressPage.Visible = $false
    $donePage.Visible = $true
    $closeButton.Visible = $true

    if ($failure) {
        $form.Text = 'StreamFix -- erro na instalacao'
        $doneIconLabel.Text = [char] 0x274C
        $doneIconLabel.ForeColor = [System.Drawing.Color]::Firebrick
        $doneTitleLabel.Text = 'Algo deu errado'
        $doneTextLabel.Text = 'Veja o detalhe abaixo. O log completo tambem ficou na caixa de progresso.'
        $doneLogBox.Visible = $true
        $doneLogBox.Text = $failure
    } else {
        $form.Text = 'StreamFix -- pronto'
        $doneIconLabel.Text = [char] 0x2705
        $doneIconLabel.ForeColor = [System.Drawing.Color]::ForestGreen
        $doneTitleLabel.Text = 'Pronto!'
        $doneTextLabel.Text = "O plugin ja vem ativado, nao precisa mexer em nada. Entre numa call e use Go Live ou a camera.`n`nSe o Discord nao abriu sozinho, abra ele manualmente."
    }
}

$installButton.Add_Click({ Start-Install })

[System.Windows.Forms.Application]::EnableVisualStyles()
[void] $form.ShowDialog()
