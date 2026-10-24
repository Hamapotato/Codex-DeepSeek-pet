' Started by the "dsh-pet-on-codex-launch" scheduled task when Codex launches.
' Runs the watchdog hidden. When Codex closes the watchdog writes that day's
' diary and exits; the pet is left running until you close it by hand.
'
' Paths are derived from this file's location (scripts\ -> project root), so the
' project can be moved without editing this script. Node is expected in
' %ProgramFiles%\nodejs.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
watchdog = projectDir & "\src\watch-codex.js"
cmd = """" & nodeExe & """ """ & watchdog & """ --exit-on-codex-close"
sh.Run cmd, 0, False
