#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Instala el bot como Scheduled Task de Windows.
  Uso: .\install.ps1
#>

$TASK   = 'btcusd-bot'
$DIR    = $PSScriptRoot
$NODE   = (Get-Command node -ErrorAction SilentlyContinue)?.Source

if (-not $NODE) {
    Write-Host "  ERROR: Node.js no encontrado. Instálalo primero." -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '[BTC Bot] Instalando Scheduled Task...' -ForegroundColor Cyan

# Build command
$logDir = "$DIR\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$action = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument "/c cd /d `"$DIR`" && npm run dev >> `"$logDir\bot-%DATE:~-4,4%-%DATE:~-7,2%-%DATE:~-10,2%.log`" 2>&1" `
    -WorkingDirectory $DIR

$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest

# Remove existing task if present
Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName  $TASK `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal | Out-Null

Write-Host "  Tarea '$TASK' registrada." -ForegroundColor Green
Write-Host ''
Write-Host '  Usa .\start.ps1 para iniciarlo y .\stop.ps1 para detenerlo.' -ForegroundColor DarkGray
Write-Host ''
