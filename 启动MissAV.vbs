' MissAV Manager - 无窗口静默启动
' 双击此文件即可启动，不会弹出命令行窗口

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' 获取脚本所在目录
strPath = objFSO.GetParentFolderName(WScript.ScriptFullName)

' 切换到项目目录并启动
objShell.CurrentDirectory = strPath

' 使用 Run 方法，第二个参数 0 = 隐藏窗口
strCmd = """" & strPath & "\node_modules\.bin\electron.cmd"" """ & strPath & """"
objShell.Run strCmd, 0, False

Set objShell = Nothing
Set objFSO = Nothing