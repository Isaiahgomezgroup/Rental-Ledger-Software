@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node.exe"
set "MONGOD_EXE=%~dp0runtime\mongodb\mongodb-win32-x86_64-windows-8.0.24\bin\mongod.exe"
set "DB_PATH=%~dp0data\db"
set "LOG_PATH=%~dp0data\logs\mongod.log"

if not exist "%NODE_EXE%" (
  set "NODE_EXE=node"
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js was not found. Install Node.js or place node.exe in the runtime folder.
    pause
    exit /b 1
  )
)

if exist "%MONGOD_EXE%" (
  if not exist "%DB_PATH%" mkdir "%DB_PATH%"
  if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"
  start "Rental Ledger MongoDB" /min "%MONGOD_EXE%" --dbpath "%DB_PATH%" --bind_ip 127.0.0.1 --port 27017 --logpath "%LOG_PATH%" --logappend
  timeout /t 2 /nobreak >nul
)

start "" "http://127.0.0.1:4173/index.html"
"%NODE_EXE%" preview-server.js
