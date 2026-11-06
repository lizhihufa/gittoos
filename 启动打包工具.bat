@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 青枝打包工具
echo 正在启动青枝打包工具...
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 后再试。
  pause
  exit /b 1
)
node "packager\server.mjs"
if errorlevel 1 (
  echo.
  echo 启动失败。
  pause
)
