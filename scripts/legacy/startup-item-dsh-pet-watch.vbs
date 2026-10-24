' Disabled logon item, kept for reference only.
'
' Historically this sat in the Startup folder and started the watchdog at
' logon. It is now started on demand by the "dsh-pet-on-codex-launch" scheduled
' task (see install/register-task.ps1). You do not need to run this file.
'
' Paths are derived from this file's location (scripts\legacy\ -> project root);
' deliberately no --exit-on-codex-close, matching the old logon behaviour.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
watchdog = projectDir & "\src\watch-codex.js"
sh.Run """" & nodeExe & """ """ & watchdog & """", 0, False
