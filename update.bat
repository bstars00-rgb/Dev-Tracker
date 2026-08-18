@echo off
REM ============================================================
REM  OHMY Integration Tracker - refresh the board from Excel
REM
REM  1. Save your changes in data\Dev_Schedule.xlsx
REM  2. Double-click this file
REM  3. index.html now shows the new numbers
REM ============================================================
cd /d "%~dp0"

echo.
echo   Reading data\Dev_Schedule.xlsx ...
echo.

if not exist node_modules (
  echo   First run - installing the Excel reader, one moment...
  call npm install --silent --no-audit --no-fund
  if errorlevel 1 goto failed
)

call npm run build
if errorlevel 1 goto failed

echo.
echo   Opening the board...
start "" "index.html"
echo.
echo   To publish: commit and push. GitHub does the rest.
echo.
pause
exit /b 0

:failed
echo.
echo   Something went wrong. Check that:
echo     - Node.js is installed        ^(https://nodejs.org^)
echo     - data\Dev_Schedule.xlsx exists and is closed in Excel
echo.
pause
exit /b 1
