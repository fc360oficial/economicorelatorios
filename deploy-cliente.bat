@echo off
chcp 65001 >nul
title FC360 — Deploy de Cliente

echo.
echo  ╔══════════════════════════════════════╗
echo  ║     FC360 — Deploy para Cliente      ║
echo  ╚══════════════════════════════════════╝
echo.
echo  Qual cliente deseja atualizar?
echo.
echo  [1] Economico Supermercado
echo  [2] Bar do Cachorro
echo  [3] Todos os clientes
echo  [0] Cancelar
echo.
set /p OPCAO="  Escolha: "

if "%OPCAO%"=="0" goto FIM
if "%OPCAO%"=="1" goto ECONOMICO
if "%OPCAO%"=="2" goto BARDOCACHORRO
if "%OPCAO%"=="3" goto TODOS
echo  Opcao invalida.
goto FIM

:ECONOMICO
call :DEPLOY economico "Economico Supermercado"
goto FIM

:BARDOCACHORRO
call :DEPLOY bardocachorro "Bar do Cachorro"
goto FIM

:TODOS
call :DEPLOY economico "Economico Supermercado"
call :DEPLOY bardocachorro "Bar do Cachorro"
goto FIM

:DEPLOY
echo.
echo  Publicando para: %~2
echo  ------------------------------------------
git checkout -b deploy/%~1
echo window.FC360_CLIENT_ID = '%~1'; > client.js
git add client.js
git commit -m "Deploy %~2"
git push %~1 deploy/%~1:main -f
git checkout main
git branch -D deploy/%~1
echo.
echo  [OK] %~2 atualizado!
echo  URL: https://fc360oficial.github.io/fc360-%~1/
echo.
goto :EOF

:FIM
echo.
pause
