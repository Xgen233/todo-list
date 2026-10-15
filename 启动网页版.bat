@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动待办清单网页版...
node serve-web.js
pause
