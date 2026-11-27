@echo off
chcp 65001 >nul
title Community For Goats - Publicar Atualizacao Automatica
cd /d "%~dp0"
set "PATH=%PATH%;D:\nodejs;C:\Program Files\nodejs;D:\Git\cmd;C:\Program Files\Git\cmd"

echo ============================================================
echo   PUBLICAR ATUALIZACAO AUTOMATICA PARA TODOS OS USUARIOS
echo ============================================================
echo.
node publish-update.js
echo.
pause
