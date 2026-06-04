#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Detiene el BTC Bot.
  Uso: .\stop.ps1
#>

$TASK = 'btcusd-bot'

function TaskState($name) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { return 'NOT_FOUND' }
    return $t.State
}

Write-Host ''
Write-Host '[BTC Bot] Deteniendo...' -ForegroundColor Cyan

if ((TaskState $TASK) -eq 'Running') {
    Stop-ScheduledTask -TaskName $TASK
    Write-Host "  Bot detenido." -ForegroundColor Yellow
} else {
    Write-Host "  El bot no estaba corriendo." -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Listo.' -ForegroundColor Green
Write-Host ''
