@echo off
REM ============================================================================
REM  deploy-client.cmd - Pasang Activity Trapping di laptop CLIENT (cmd, TANPA PowerShell)
REM  Jalankan sebagai ADMINISTRATOR, atau via MDM/Intune sebagai SYSTEM.
REM  Paket harus berisi (sejajar file ini): hooks\  config\  managed-settings.json
REM  managed-settings.json sudah memuat endpoint collector pusat (di-set saat build paket).
REM ============================================================================
setlocal
set "TRAP=C:\ProgramData\claude-trapping"
set "MD=C:\Program Files\ClaudeCode"

REM --- prasyarat: Node.js (hook dijalankan oleh node) ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan di PATH. Install Node.js LTS lebih dulu.
  exit /b 2
)

echo ==^> 1/2 salin hooks dan config ke %TRAP%
md "%TRAP%\hooks" 2>nul
md "%TRAP%\config" 2>nul
md "%TRAP%\data\audit" 2>nul
xcopy /E /I /Y "%~dp0hooks"  "%TRAP%\hooks"  >nul
if errorlevel 1 ( echo [ERROR] gagal salin hooks. & exit /b 3 )
xcopy /E /I /Y "%~dp0config" "%TRAP%\config" >nul
if errorlevel 1 ( echo [ERROR] gagal salin config. & exit /b 3 )

echo ==^> 2/2 pasang managed-settings.json ke %MD%
md "%MD%" 2>nul
copy /Y "%~dp0managed-settings.json" "%MD%\managed-settings.json" >nul
if errorlevel 1 (
  echo [ERROR] gagal menulis %MD%. Jalankan sebagai Administrator / SYSTEM.
  exit /b 4
)

echo.
echo SELESAI. Trapping aktif untuk sesi Claude Code BARU.
echo Tutup semua sesi Claude Code, lalu logout dan login kembali.
endlocal
exit /b 0
