# Remove the Codex-launch trigger installed by register-task.ps1.

param(
  [string]$TaskName = 'dsh-pet-on-codex-launch'
)

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Task not found: $TaskName"
  return
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task: $TaskName"
