@echo off
chcp 65001 >nul
title Instalação HTTPS - Caddy Reverse Proxy
echo.
echo ============================================
echo   INSTALAÇÃO HTTPS - Caddy Reverse Proxy
echo ============================================
echo.

:: Verifica se está rodando como admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Execute como ADMINISTRADOR!
    echo         Clique direito ^> Executar como administrador
    pause
    exit /b 1
)

set CADDY_DIR=C:\caddy
set CADDY_EXE=%CADDY_DIR%\caddy.exe

echo [1/4] Criando diretorio %CADDY_DIR%...
if not exist "%CADDY_DIR%" mkdir "%CADDY_DIR%"

echo [2/4] Baixando Caddy para Windows...
if exist "%CADDY_EXE%" (
    echo        Caddy ja existe, pulando download.
) else (
    echo        Aguarde, download em andamento...
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile '%CADDY_EXE%' -UseBasicParsing"
    if not exist "%CADDY_EXE%" (
        echo [ERRO] Falha ao baixar. Verifique a internet.
        pause
        exit /b 1
    )
    echo        Download concluido!
)

echo [3/4] Copiando Caddyfile...
copy /Y "%~dp0Caddyfile" "%CADDY_DIR%\Caddyfile" >nul

echo [4/4] Configurando inicio automatico...
:: Para processos antigos
taskkill /f /im caddy.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Remove tarefa antiga se existir
schtasks /delete /tn "CaddyHTTPS" /f >nul 2>&1

:: Cria tarefa que inicia com o Windows
schtasks /create /tn "CaddyHTTPS" /tr "\"%CADDY_EXE%\" run --config \"%CADDY_DIR%\Caddyfile\" --adapter caddyfile" /sc onstart /ru SYSTEM /rl HIGHEST /f >nul

:: Inicia agora
start "" /min "%CADDY_EXE%" run --config "%CADDY_DIR%\Caddyfile" --adapter caddyfile

echo.
echo ============================================
echo   INSTALAÇÃO CONCLUÍDA!
echo ============================================
echo.
echo   Caddy rodando em: %CADDY_DIR%
echo   Certificado SSL: automatico (Let's Encrypt)
echo.
echo   CONFIGURE NO ROTEADOR:
echo   ┌──────────────────────────────────────┐
echo   │ Porta 80  (TCP) ^> 192.168.2.252:80  │
echo   │ Porta 443 (TCP) ^> 192.168.2.252:443 │
echo   └──────────────────────────────────────┘
echo.
echo   ACESSE DE QUALQUER LUGAR:
echo   https://hhk0a8gt2cn.sn.mynetname.net
echo.
echo   Na primeira conexao o certificado demora
echo   ~30 segundos para ser gerado.
echo ============================================
echo.
pause
