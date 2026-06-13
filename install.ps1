# Bootstrap Activity Trapping di mesin ini (Windows PowerShell).
# Pemakaian: .\install.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> 1/3 Siapkan folder output"
New-Item -ItemType Directory -Force -Path data\audit, data\otel, data\siem | Out-Null

Write-Host "==> 2/3 Jalankan collector + mock SIEM (docker compose)"
try { docker compose version | Out-Null } catch {
  Write-Error "Docker tidak terdeteksi. Install/jalankan Docker Desktop dulu."
}
docker compose up -d

Write-Host "==> 3/3 Merge konfigurasi (env OTel + hooks) ke ~/.claude/settings.json (backup otomatis)"
node scripts\merge-settings.mjs

Write-Host ""
Write-Host "SELESAI. Langkah terakhir: RESTART sesi Claude Code agar hooks & telemetri aktif."
Write-Host "Verifikasi: node scripts\merge-settings.mjs --dry-run  |  node scripts\reconcile.mjs"
