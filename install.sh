#!/usr/bin/env bash
# Bootstrap Activity Trapping di mesin ini (Linux/macOS/Git-Bash Windows).
# Pemakaian: ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/3 Siapkan folder output"
mkdir -p data/audit data/otel data/siem

echo "==> 2/3 Jalankan collector + mock SIEM (docker compose)"
if ! docker compose version >/dev/null 2>&1; then
  echo "   ! Docker tidak terdeteksi. Install/By Docker Desktop dulu." >&2
  echo "   ! (Windows Docker Desktop: mungkin perlu 'export DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine')" >&2
  exit 1
fi
docker compose up -d

echo "==> 3/3 Merge konfigurasi (env OTel + hooks) ke ~/.claude/settings.json (backup otomatis)"
node scripts/merge-settings.mjs

echo ""
echo "SELESAI. Langkah terakhir: RESTART sesi Claude Code agar hooks & telemetri aktif."
echo "Verifikasi: node scripts/reconcile.mjs   |   cat data/audit/hooks-*.jsonl"
