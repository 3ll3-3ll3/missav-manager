# 在桌面创建 MissAV Manager 快捷方式
# 右键此文件 → "使用 PowerShell 运行"

$desktop = [Environment]::GetFolderPath("Desktop")
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 创建 VBS 启动器的快捷方式
$WshShell = New-Object -ComObject WScript.Shell
$shortcut = $WshShell.CreateShortcut("$desktop\MissAV_Manager.lnk")
$shortcut.TargetPath = "wscript.exe"
$shortcut.Arguments = "`"$projectDir\启动MissAV.vbs`""
$shortcut.WorkingDirectory = $projectDir
$shortcut.IconLocation = "shell32.dll,13"
$shortcut.Description = "MissAV Manager - AV 番号收藏管理工具"
$shortcut.Save()

Write-Host "✅ 桌面快捷方式已创建！双击桌面上的 'MissAV_Manager' 即可启动" -ForegroundColor Green
Write-Host ""
Write-Host "按任意键退出..." 
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")