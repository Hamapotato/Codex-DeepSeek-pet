' Started by the "dsh-pet-on-codex-launch" scheduled task when Codex launches.
' Runs the watchdog hidden; --exit-on-codex-close makes it quit (and shut the
' pet down) once Codex closes, so nothing keeps running between launches.
'
' Paths are derived from this file's location, so the project can be moved
' without editing this script. Node is expected in %ProgramFiles%\nodejs.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
watchdog = projectDir & "\src\watch-codex.js"
cmd = """" & nodeExe & """ """ & watchdog & """ --exit-on-codex-close"
sh.Run cmd, 0, False
