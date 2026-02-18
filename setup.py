import subprocess
import os
import sys
import platform

# --- Configurações Visuais ---
GREEN = '\033[92m'
YELLOW = '\033[93m'
RED = '\033[91m'
RESET = '\033[0m'

def log(msg, tipo="info"):
    if tipo == "info":
        print(f"[*] {msg}")
    elif tipo == "sucesso":
        print(f"{GREEN}[OK] {msg}{RESET}")
    elif tipo == "erro":
        print(f"{RED}[X] {msg}{RESET}")
    elif tipo == "aviso":
        print(f"{YELLOW}[!] {msg}{RESET}")

def run_command(command, error_msg):
    try:
        # shell=True ajuda no Windows para comandos compostos
        subprocess.check_call(command, shell=True)
    except subprocess.CalledProcessError:
        log(error_msg, "erro")
        return False
    return True

def check_node():
    log("Verificando instalação do Node.js...")
    try:
        subprocess.run(["node", "-v"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        log("Node.js já está instalado.", "sucesso")
        return True
    except (OSError, subprocess.CalledProcessError):
        log("Node.js NÃO encontrado.", "aviso")
        return False

def install_node():
    log("Tentando instalar Node.js automaticamente via Winget...", "aviso")
    # Tenta instalar a versão LTS do Node
    if run_command("winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements", "Falha ao instalar Node.js via Winget."):
        log("Node.js instalado! Por favor, REINICIE este script para carregar as variáveis de ambiente.", "sucesso")
        sys.exit(0) # Sai para obrigar o reinício
    else:
        log("Não foi possível instalar o Node automaticamente.", "erro")
        log("Por favor, baixe e instale manualmente: https://nodejs.org/", "aviso")
        sys.exit(1)

def fix_execution_policy():
    if platform.system() == "Windows":
        log("Ajustando permissões de execução (PowerShell)...")
        # Define permissão apenas para o usuário atual, sem precisar de Admin global
        run_command("powershell Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force", "Não foi possível ajustar a política de execução.")

def install_dependencies():
    libs = "express socket.io sqlite3 sequelize cors node-cron csv-writer"
    log(f"Instalando bibliotecas do NTI Sentinel: {libs}...")
    
    # Usamos npm.cmd para garantir execução no Windows
    npm_cmd = "npm.cmd" if platform.system() == "Windows" else "npm"
    
    if run_command(f"{npm_cmd} install {libs}", "Erro ao instalar dependências."):
        log("Bibliotecas instaladas com sucesso!", "sucesso")
    else:
        sys.exit(1)

def create_startup_script():
    log("Criando atalho de inicialização (INICIAR_SISTEMA.bat)...")
    content = """@echo off
title NTI SENTINEL - SERVIDOR
color 0A
echo ==========================================
echo      INICIANDO SISTEMA NTI SENTINEL
echo ==========================================
echo.
echo Nao feche esta janela enquanto usar o sistema.
echo Para acessar: http://localhost:3000
echo.
npm start
pause
"""
    try:
        with open("INICIAR_SISTEMA.bat", "w") as bat_file:
            bat_file.write(content)
        log("Arquivo 'INICIAR_SISTEMA.bat' criado na pasta!", "sucesso")
    except Exception as e:
        log(f"Erro ao criar bat: {e}", "erro")

def main():
    print(f"{GREEN}=== INSTALADOR AUTOMÁTICO NTI SENTINEL ==={RESET}\n")
    
    # 1. Verifica Node
    if not check_node():
        install_node()
    
    # 2. Corrige Permissões (Windows)
    fix_execution_policy()
    
    # 3. Instala Dependências
    install_dependencies()
    
    # 4. Cria Atalho
    create_startup_script()
    
    print(f"\n{GREEN}=== INSTALAÇÃO CONCLUÍDA ==={RESET}")
    print("Agora você pode rodar o arquivo 'INICIAR_SISTEMA.bat' para abrir o servidor.")

if __name__ == "__main__":
    main()