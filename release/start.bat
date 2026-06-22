@echo off
echo.
echo ============================================
echo          zcode-proxy Manager
echo ============================================
echo.
echo   1. Start proxy server
echo   2. OAuth login (Bigmodel) - Coding Plan
echo   3. OAuth login (Z.AI) - Coding Plan
echo   4. OAuth login (Bigmodel) - Start Plan
echo   5. OAuth login (Z.AI) - Start Plan
echo   6. Import key from ZCode (Bigmodel)
echo   7. Import key from ZCode (Z.AI)
echo   8. Check login status
echo   9. Logout
echo   0. Exit
echo.
set /p choice=Select: 

if "%choice%"=="1" goto serve
if "%choice%"=="2" goto login_bigmodel_cp
if "%choice%"=="3" goto login_zai_cp
if "%choice%"=="4" goto login_bigmodel_sp
if "%choice%"=="5" goto login_zai_sp
if "%choice%"=="6" goto import_bigmodel
if "%choice%"=="7" goto import_zai
if "%choice%"=="8" goto status
if "%choice%"=="9" goto logout
if "%choice%"=="0" exit
goto end

:serve
echo.
echo Starting proxy server...
zcode-proxy.exe serve config.yaml
pause
goto end

:login_bigmodel_cp
echo.
echo Starting Bigmodel OAuth login (Coding Plan)...
zcode-proxy.exe auth login bigmodel --plan=coding-plan
pause
goto end

:login_zai_cp
echo.
echo Starting Z.AI OAuth login (Coding Plan)...
zcode-proxy.exe auth login zai --plan=coding-plan
pause
goto end

:login_bigmodel_sp
echo.
echo Starting Bigmodel OAuth login (Start Plan)...
zcode-proxy.exe auth login bigmodel --plan=start-plan
pause
goto end

:login_zai_sp
echo.
echo Starting Z.AI OAuth login (Start Plan)...
zcode-proxy.exe auth login zai --plan=start-plan
pause
goto end

:import_bigmodel
echo.
echo Importing key from ZCode (Bigmodel)...
zcode-proxy.exe auth login bigmodel --import
pause
goto end

:import_zai
echo.
echo Importing key from ZCode (Z.AI)...
zcode-proxy.exe auth login zai --import
pause
goto end

:status
echo.
zcode-proxy.exe auth status
pause
goto end

:logout
echo.
zcode-proxy.exe auth logout
pause
goto end

:end
