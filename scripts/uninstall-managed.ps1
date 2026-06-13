# Cabut deploy managed-settings (Windows, JALANKAN SEBAGAI ADMINISTRATOR).
param([string]$TrapDir = "C:\ProgramData\claude-trapping")
$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) { Write-Error "Harus dijalankan sebagai Administrator."; exit 1 }

Remove-Item "C:\Program Files\ClaudeCode\managed-settings.json" -Force -ErrorAction SilentlyContinue
Remove-Item $TrapDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "managed-settings.json + $TrapDir dihapus. LOGOUT & login kembali agar berlaku."
