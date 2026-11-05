@echo off
cd /d "%~dp0"
".venv\Scripts\python.exe" tools\stop_server.py
pause
