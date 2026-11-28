@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 青枝打包工具

echo ========================================
echo   青枝打包工具
echo   - 一键打包 Windows + Linux
echo   - 也可单独打 Windows 或 Linux
echo   - 清理构建缓存 / 版本号同步
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 后再试。
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 首次使用，正在安装依赖…
  call npm install
  if errorlevel 1 (
    echo [错误] npm install 失败。
    pause
    exit /b 1
  )
  echo.
)

echo 正在启动网页端打包工具…
echo.
echo 浏览器打开后：
echo   - 主按钮：一键打包 Windows + Linux
echo       Windows → src-tauri\target\release\bundle\nsis\
echo       Linux   → src-tauri\target\release\bundle\deb\qingzhi_*.deb
echo   - 也可点「仅 Windows」或「仅 Linux」
echo   - 清理缓存会删掉 target 与 dist
echo.
echo Linux 依赖 WSL（Ubuntu）内已装 Rust / Node / webkit。
echo 关闭本窗口即停止打包服务。
echo.

node "packager\server.mjs"
if errorlevel 1 (
  echo.
  echo 启动失败。
  pause
)
