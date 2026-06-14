@echo off
REM ============================================================================
REM  uninstall-client.cmd - Cabut Activity Trapping dari laptop CLIENT (cmd).
REM  Jalankan sebagai ADMINISTRATOR, atau via MDM sebagai SYSTEM (remediation).
REM ============================================================================
setlocal
echo Menghapus managed-settings.json dan folder trap...
del /F /Q "C:\Program Files\ClaudeCode\managed-settings.json" 2>nul
rmdir /S /Q "C:\ProgramData\claude-trapping" 2>nul
echo SELESAI. Tutup semua sesi Claude Code, lalu logout dan login kembali.
endlocal
exit /b 0
