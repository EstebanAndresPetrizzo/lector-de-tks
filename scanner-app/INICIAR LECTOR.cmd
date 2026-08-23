@echo off
setlocal
set "NODE="
for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE (
  echo No encontre Node.js en el PATH de esta computadora.
  echo Instala Node.js o agrega node.exe al PATH y volve a intentar.
  pause
  exit /b 1
)
PowerShell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4173 -TimeoutSec 1; exit [int]($response.StatusCode -ne 200) } catch { exit 1 }"
if not errorlevel 1 (
  echo El lector ya esta abierto. Voy a mostrarlo en el navegador.
  start "" http://localhost:4173/
  exit /b 0
)
"%NODE%" "%~dp0server.mjs"
endlocal
