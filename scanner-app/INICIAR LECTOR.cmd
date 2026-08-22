@echo off
setlocal
set "NODE=C:\Users\Esteban Andres\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo No encontre el runtime de Node configurado para esta aplicacion.
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
