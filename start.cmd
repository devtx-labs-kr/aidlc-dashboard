@echo off
REM aidlc-dashboard launcher — Windows (cmd). Run it from a terminal.
REM
REM Exists to call start.ps1 with the execution policy bypassed: a fresh Windows
REM refuses to run unsigned .ps1 files, so `.\start.ps1` can fail outright where
REM this wrapper works. -Bypass applies to THIS invocation only; it changes no
REM machine setting. Use start.ps1 directly if your policy already allows it.
REM
REM usage:
REM   start.cmd
REM   start.cmd C:\path\to\workspace
REM   start.cmd --port 5000

setlocal
cd /d "%~dp0"

REM Prefer PowerShell 7+ (pwsh) when present, else Windows PowerShell 5.1.
REM `where /q` sets ERRORLEVEL 0 on a hit.
where /q pwsh.exe
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
) else (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
)

endlocal
