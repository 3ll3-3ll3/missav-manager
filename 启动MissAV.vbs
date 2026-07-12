' MissAV Manager - 无窗口静默启动
' 双击此文件即可启动，不会弹出命令行窗口

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' 获取脚本所在目录
strPath = objFSO.GetParentFolderName(WScript.ScriptFullName)

' 切换到项目目录并通过 BAT 启动；BAT 会自动安装或修复 Electron。
objShell.CurrentDirectory = strPath

' 使用 Run 方法，第二个参数 0 = 隐藏窗口，第三个参数 True = 等待退出。
strCmd = "cmd.exe /c """ & strPath & "\启动MissAV.bat"" --silent"
exitCode = objShell.Run(strCmd, 0, True)

If exitCode <> 0 Then
  MsgBox "MissAV Manager 启动失败。请双击“启动MissAV.bat”查看详细错误。", 16, "MissAV Manager"
End If

Set objShell = Nothing
Set objFSO = Nothing
