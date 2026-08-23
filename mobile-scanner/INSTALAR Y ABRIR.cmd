@echo off
setlocal
echo Instalando la app movil. Este paso se hace una sola vez.
call npm install
if errorlevel 1 (
  echo No se pudo instalar la app.
  pause
  exit /b 1
)
call npx expo start
endlocal
