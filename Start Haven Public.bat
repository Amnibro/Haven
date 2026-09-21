@echo off
title Haven — amni-scient.com
color 0A
set "HAVEN_DATA_DIR=%APPDATA%\Haven-AmniScient"
set "HAVEN_DATA=%HAVEN_DATA_DIR%"
set "FORCE_HTTP=true"
if not exist "%HAVEN_DATA_DIR%" mkdir "%HAVEN_DATA_DIR%"
cd /d "%~dp0"

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Node.js is not in PATH.
    pause
    exit /b 1
)

echo [*] Seeding community channels if needed...
node scripts\seedAmniScientCommunity.js
if %ERRORLEVEL% NEQ 0 (
    echo Seed failed.
    pause
    exit /b 1
)

set "HAVEN_PORT=3010"
if exist "%HAVEN_DATA_DIR%\.env" (
    for /f "tokens=1,* delims==" %%A in ('findstr /B /I "PORT=" "%HAVEN_DATA_DIR%\.env"') do set "HAVEN_PORT=%%B"
)

echo [*] Checking port %HAVEN_PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%HAVEN_PORT%" ^| findstr "LISTENING"') do (
    echo [!] Killing PID %%a on port %HAVEN_PORT%
    taskkill /PID %%a /F >nul 2>&1
)

call npm install --no-audit --no-fund
if %ERRORLEVEL% NEQ 0 (
    echo npm install failed.
    pause
    exit /b 1
)

echo [*] Branding icon, banner, themes, Guide posts...
node scripts\brandAmniScientHaven.js
echo [*] Starting Guide bot...
start /B node scripts\amniScientGuideBot.js
echo [*] Starting Haven at http://127.0.0.1:%HAVEN_PORT%  (public: https://haven.amni-scient.com)
start /B node server.js

set RETRIES=0
:WAIT_LOOP
timeout /t 1 /nobreak >nul
set /a RETRIES+=1
netstat -ano | findstr ":%HAVEN_PORT%" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if %RETRIES% GEQ 20 (
        echo Server did not bind port %HAVEN_PORT%.
        pause
        exit /b 1
    )
    goto WAIT_LOOP
)

echo.
echo  Haven public instance is listening on 127.0.0.1:%HAVEN_PORT%
echo  Cloudflare hostname should be haven.amni-scient.com -^> localhost:%HAVEN_PORT%
echo  See docs\cloudflare-haven-amni-scient.md
echo.
start http://127.0.0.1:%HAVEN_PORT%

:KEEPALIVE
timeout /t 3600 /nobreak >nul
goto KEEPALIVE
