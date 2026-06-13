# Deploy trapping via managed-settings (Windows, JALANKAN SEBAGAI ADMINISTRATOR).
# - generate managed-settings.json (endpoint + trap-dir)
# - salin hooks/ + config/ ke $TrapDir
# - pasang managed-settings.json ke C:\Program Files\ClaudeCode (immutable, semua user)
#
# Contoh:
#   .\scripts\deploy-managed.ps1 -Endpoint http://localhost:4318
#   .\scripts\deploy-managed.ps1 -Endpoint https://otel.bankmega.internal:4318
param(
  [string]$Endpoint = "http://localhost:4318",
  [string]$TrapDir  = "C:\ProgramData\claude-trapping"
)
$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) { Write-Error "Harus dijalankan sebagai Administrator (klik kanan PowerShell > Run as administrator)."; exit 1 }

$repo    = Split-Path $PSScriptRoot -Parent
$trapFwd = $TrapDir -replace '\\','/'

Write-Host "==> 1/3 generate managed-settings.json (endpoint=$Endpoint, trap-dir=$trapFwd)"
& node "$repo\scripts\build-managed-settings.mjs" "--endpoint=$Endpoint" "--trap-dir=$trapFwd"
if ($LASTEXITCODE -ne 0) { Write-Error "build-managed-settings gagal (Node.js terpasang?)."; exit 1 }

Write-Host "==> 2/3 salin hooks/ + config/ ke $TrapDir"
New-Item -ItemType Directory -Force -Path "$TrapDir\hooks","$TrapDir\config","$TrapDir\data\audit" | Out-Null
Copy-Item "$repo\hooks\*"  "$TrapDir\hooks\"  -Recurse -Force
Copy-Item "$repo\config\*" "$TrapDir\config\" -Recurse -Force
# izin tulis data/ utk Users (audit lokal hook); abaikan bila gagal
try { icacls "$TrapDir\data" /grant "*S-1-5-32-545:(OI)(CI)M" /T | Out-Null } catch {}

$mdDir = "C:\Program Files\ClaudeCode"
Write-Host "==> 3/3 pasang managed-settings ke $mdDir\managed-settings.json"
New-Item -ItemType Directory -Force -Path $mdDir | Out-Null
Copy-Item "$repo\dist\managed-settings.json" "$mdDir\managed-settings.json" -Force

Write-Host ""
Write-Host "SELESAI. managed-settings AKTIF untuk sesi Claude Code BARU (tak bisa di-override user)."
Write-Host "Agar event tidak DOBEL, tiap developer jalankan SEBAGAI USER (non-admin):"
Write-Host "    node `"$repo\scripts\merge-settings.mjs`" --uninstall"
Write-Host "Lalu LOGOUT semua sesi Claude Code & login kembali."
