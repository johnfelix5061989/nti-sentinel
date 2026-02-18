@echo off
setlocal
title INSTALADOR AUTOMATICO NTI SENTINEL
color 1F

echo ==================================================
echo      INSTALADOR NTI SENTINEL (VERSAO FINAL V2)
echo ==================================================
echo.

:: 1. VERIFICAR SE O NODE.JS ESTA INSTALADO
echo [*] Verificando Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Node.js nao encontrado.
    echo [!] Tentando instalar automaticamente via Winget...
    echo.
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    
    if %errorlevel% neq 0 (
        color 4F
        echo.
        echo [ERRO] Nao foi possivel instalar o Node.js automaticamente.
        echo Por favor, baixe manualmente em: https://nodejs.org/
        pause
        exit /b
    )
    echo.
    echo [SUCESSO] Node.js instalado! Feche e abra o instalador novamente.
    pause
    exit
) else (
    echo [OK] Node.js ja esta instalado.
)

:: 2. LIBERAR PERMISSOES
echo.
echo [*] Ajustando permissoes...
powershell -Command "Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force" >nul 2>&1
echo [OK] Permissoes ajustadas.

:: 3. INSTALAR BIBLIOTECAS
echo.
echo [*] Instalando bibliotecas (Aguarde)...
call npm install express socket.io sqlite3 sequelize cors node-cron csv-writer >nul 2>&1

if %errorlevel% neq 0 (
    echo [AVISO] Ocorreu um erro na instalacao automatica. Tentando manual...
    call npm install express socket.io sqlite3 sequelize cors node-cron csv-writer
)

echo [OK] Bibliotecas verificadas!

:: 4. CRIAR O ARQUIVO DE INICIALIZACAO (CORRIGIDO)
echo.
echo [*] Gerando arquivo de boot...

(
echo @echo off
echo title NTI SENTINEL - SERVIDOR
echo color 0A
echo cls
echo echo ==========================================
echo echo      INICIANDO SISTEMA NTI SENTINEL
echo echo ==========================================
echo echo.
echo echo Nao feche esta janela enquanto usar o sistema.
echo echo.
echo echo [1/2] Iniciando o servidor...
echo start "" "http://localhost:3000/home.html"
echo node server.js
echo pause
) > "INICIAR_SISTEMA.bat"

echo [OK] Arquivo 'INICIAR_SISTEMA.bat' recriado com sucesso!

:: 5. FIM
echo.
echo ==================================================
echo      CORRECAO APLICADA COM SUCESSO!
echo ==================================================
echo.
echo Clique em 'INICIAR_SISTEMA.bat' para rodar a aplicacao!
echo Pode fechar este instalador agora.
echo.
pause