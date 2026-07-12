@echo off
chcp 65001 >nul
title MissAV Manager
cd /d "%~dp0"

echo.
echo  ╔════════════════════════════════╗
echo  ║    🎬 MissAV Manager v0.1     ║
echo  ║     正在启动，请稍候...       ║
echo  ╚════════════════════════════════╝
echo.

REM Electron 默认从 GitHub 下载，部分网络环境无法访问。
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

REM 首次运行时安装全部依赖。
if not exist "node_modules\" (
    echo [!] 首次运行，正在安装依赖...
    call npm install --registry=https://registry.npmmirror.com
    if errorlevel 1 goto :install_failed
    echo.
)

REM node_modules 可能存在，但 Electron 二进制曾下载失败；单独重建即可修复。
if not exist "node_modules\electron\dist\electron.exe" (
    echo [!] Electron 运行文件缺失，正在从国内镜像下载...
    node node_modules\electron\install.js
    if errorlevel 1 goto :electron_failed
    echo.
)

REM 启动 Electron 应用
call .\node_modules\.bin\electron.cmd .

REM 如果异常退出，暂停让用户看到错误信息
if errorlevel 1 (
    echo.
    echo [X] 启动异常，请检查上方错误信息
    goto :failed
)
exit /b 0

:install_failed
echo.
echo [X] 依赖安装失败，请检查 Node.js 版本和网络连接
goto :failed

:electron_failed
echo.
echo [X] Electron 下载失败，请检查网络后重新双击启动

:failed
if /i not "%~1"=="--silent" pause
exit /b 1
