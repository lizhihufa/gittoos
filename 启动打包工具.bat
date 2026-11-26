@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 青枝打包工具

echo ========================================
echo   青枝打包工具
echo   - Windows / Linux 打包
echo   - 清理构建缓存
echo   - 版本号同步
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
echo 浏览器打开后可：
echo   1^) 改版本并打包 Windows（NSIS）
echo   2^) 经 WSL 打包 Linux（deb / AppImage）
echo   3^) 清理 src-tauri\target 与 dist 缓存
echo.
echo 关闭本窗口即停止打包服务。
echo.

node "packager\server.mjs"
if errorlevel 1 (
  echo.
  echo 启动失败。
  pause
)
