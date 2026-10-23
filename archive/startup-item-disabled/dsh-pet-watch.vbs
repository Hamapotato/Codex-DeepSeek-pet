' Disabled logon item (kept for reference). The watchdog is now started by the
' scheduled task through ../start-watch.vbs instead.
'
' Paths are derived from this file's location: it sits in archive\startup-item-disabled,
' so the project root is two levels up.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
watchdog = projectDir & "\src\watch-codex.js"
sh.Run """" & nodeExe & """ """ & watchdog & """", 0, False
