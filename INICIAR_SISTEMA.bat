@echo off
title NTI SENTINEL - SERVIDOR
color 0A
cls
echo ==========================================
echo      INICIANDO SISTEMA NTI SENTINEL
echo ==========================================
echo.
echo Nao feche esta janela enquanto usar o sistema.
echo.
echo [1/2] Iniciando o servidor...
start "" "http://localhost:3000/home.html"
node server.js
pause
