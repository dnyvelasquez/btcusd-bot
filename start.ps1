#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Inicia el BTC Bot.
  Uso: .\start.ps1
#>

$TASK = 'btcusd-bot'

function TaskState($name) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { return 'NOT_FOUND' }
    return $t.State
}

Write-Host ''
Write-Host '[BTC Bot] Iniciando...' -ForegroundColor Cyan

if ((TaskState $TASK) -eq 'NOT_FOUND') {
    Write-Host "  ERROR: Tarea '$TASK' no encontrada. Ejecuta install.ps1 primero." -ForegroundColor Red
    exit 1
}

if ((TaskState $TASK) -eq 'Running') {
    Write-Host "  El bot ya está corriendo." -ForegroundColor DarkGray
} else {
    Start-ScheduledTask -TaskName $TASK
    Write-Host "  Bot iniciado." -ForegroundColor Green
}

Write-Host ''
Write-Host "  Estado : $(TaskState $TASK)"
Write-Host "  Dashboard: http://localhost:8002" -ForegroundColor DarkGray
Write-Host "  Logs: $PSScriptRoot\logs\" -ForegroundColor DarkGray
Write-Host ''
