@echo off
setlocal

rem StreamFix - diagnostico do tunel, para quem nao quer mexer no PowerShell.
rem Basta dar dois cliques neste arquivo. Ele precisa do Diagnostico-Tunel.ps1 do lado.
rem
rem Por que este atalho existe: rodar ".\Diagnostico-Tunel.ps1" direto falha com "nao esta
rem assinado digitalmente" em toda maquina cuja politica de execucao nao seja permissiva -- e
rem quem precisa de diagnostico ja esta com um problema, nao merece dois. O -ExecutionPolicy
rem Bypass vale so para este processo; nada na maquina e alterado.
rem
rem %~dp0 e resolvido na hora, entao funciona em pasta com espaco e com acento no nome.

set "SF_SCRIPT=%~dp0Diagnostico-Tunel.ps1"

if not exist "%SF_SCRIPT%" (
    echo.
    echo   Nao achei o Diagnostico-Tunel.ps1 nesta pasta.
    echo   Baixe os dois arquivos juntos e deixe-os lado a lado.
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SF_SCRIPT%" %*

echo.
echo   Copie tudo acima e mande para quem administra a saida.
echo.
pause
