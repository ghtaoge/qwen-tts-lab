@echo off
setlocal
cd /d "%~dp0"
if not exist ".downloads\tmp" mkdir ".downloads\tmp"
set "TEMP=%~dp0.downloads\tmp"
set "TMP=%TEMP%"
set "HF_HOME=%~dp0.downloads\huggingface"
set "NUMBA_CACHE_DIR=%~dp0.downloads\numba-cache"
set "PYTHONUTF8=1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Backend torch -Device cpu -Precision float32
pause
endlocal
