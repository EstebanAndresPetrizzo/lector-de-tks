@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_CMD="
where py >nul 2>nul && set "PYTHON_CMD=py -3"
if not defined PYTHON_CMD (
  where python >nul 2>nul && set "PYTHON_CMD=python"
)

if not defined PYTHON_CMD (
  echo No encontre Python 3 en esta computadora.
  echo Instalalo desde https://www.python.org/downloads/ y marca "Add Python to PATH".
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Preparando el lector por primera vez...
  %PYTHON_CMD% -m venv .venv
  if errorlevel 1 goto :error
)

if not exist ".venv\.dependencias-instaladas" (
  echo Instalando dependencias. Esto se hace una sola vez...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  if errorlevel 1 goto :error
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto :error
  type nul > ".venv\.dependencias-instaladas"
)

echo Iniciando lector de comprobantes...
".venv\Scripts\python.exe" app.py
exit /b %errorlevel%

:error
echo.
echo No pude preparar el lector. Revisa el mensaje anterior.
pause
exit /b 1
