@echo off
chcp 65001 >nul
title MissAV Manager
cd /d "%~dp0"

echo.
echo  ╔════════════════════════════════╗
echo  ║    🎬 MissAV Manager v2.0     ║
echo  ║     正在启动，请稍候...       ║
echo  ╚════════════════════════════════╝
echo.

REM 检查 node_modules 是否存在
if not exist "node_modules\" (
    echo [!] 首次运行，正在安装依赖...
    call npm install
    echo.
)

REM 启动 Electron 应用
call .\node_modules\.bin\electron.cmd .

REM 如果异常退出，暂停让用户看到错误信息
if errorlevel 1 (
    echo.
    echo [X] 启动异常，请检查上方错误信息
    pause
)