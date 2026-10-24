# Register the task that starts the pet when Codex launches.
#
# Trigger: Microsoft-Windows-AppModel-Runtime/Admin event 201 for the Codex
# MSIX app. Action: explorer.exe start-watch.vbs — going through Explorer keeps
# the pet out of Codex's process job (a direct child would be killed with it).
#
# Run from anywhere (paths are derived from this script's location):
#   powershell -NoProfile -ExecutionPolicy Bypass -File install\register-task.ps1
#
# Registering an event-log trigger may require an elevated shell.

param(
  [string]$TaskName = 'dsh-pet-on-codex-launch'
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path $PSScriptRoot -Parent
$vbs = Join-Path $ProjectDir 'scripts\start-watch.vbs'
if (-not (Test-Path $vbs)) {
  throw "scripts\start-watch.vbs not found: $vbs"
}
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) {
  Write-Warning "node.exe not found at $node — start-watch.vbs must point at a valid node.exe."
}

# Event 201 = [LaunchProcess] for the Codex desktop app. The AUMID is stable
# across Codex updates; only the version suffix in the package name changes.
# The event trigger needs a full <QueryList> wrapper — a bare XPath makes
# Register-ScheduledTask fail with 0x80073A98 (invalid channel path).
$subscription = @"
<QueryList><Query Id="0" Path="Microsoft-Windows-AppModel-Runtime/Admin"><Select Path="Microsoft-Windows-AppModel-Runtime/Admin">*[System[Provider[@Name='Microsoft-Windows-AppModel-Runtime'] and EventID=201]] and *[EventData[Data[@Name='ApplicationName']='OpenAI.Codex_2p2nqsd0c76g0!App' and Data[@Name='Message']='[LaunchProcess]']]</Select></Query></QueryList>
"@

$triggerClass = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$trigger = New-CimInstance -CimClass $triggerClass -ClientOnly
$trigger.Enabled = $true
$trigger.Subscription = $subscription

$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'explorer.exe') -Argument ('"' + $vbs + '"')
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

# Replacing in place can trip over the old event trigger; remove first.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName $TaskName `
  -Trigger $trigger `
  -Action $action `
  -Principal $principal `
  -Settings $settings `
  -Description 'Start the dsh-pet watchdog when OpenAI Codex launches (no logon autostart).' | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "  trigger: AppModel-Runtime/Admin event 201 (OpenAI.Codex...!App, [LaunchProcess])"
Write-Host "  action : explorer.exe `"$vbs`""
Write-Host "  user   : $user (interactive, limited)"
Write-Host ""
Write-Host "Verify:  Get-ScheduledTask -TaskName $TaskName | Format-List"
Write-Host "Remove:  powershell -File install\unregister-task.ps1"
