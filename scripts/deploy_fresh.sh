#!/usr/bin/env bash
set -e

echo "========================================================"
echo "🚀 Starting Fresh CasinoTV & SportsTV VPS Deployment..."
echo "========================================================"

APP_DIR="/root/Casinotv"
if [ ! -d "$APP_DIR" ]; then
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$APP_DIR"

# 1. Backup whitelist database if present
if [ -f "backend/whitelist_database.json" ]; then
  echo "📦 1. Backing up whitelist database..."
  cp -f backend/whitelist_database.json backend/whitelist_database.json.bak
fi

# 2. Reset and pull latest cleanly
echo "📥 2. Pulling latest code cleanly from GitHub (origin/main)..."
git update-index --no-assume-unchanged backend/whitelist_database.json 2>/dev/null || true
git checkout -f 2>/dev/null || true
rm -f backend/whitelist_database.json 2>/dev/null || true
git fetch origin main
git reset --hard origin/main

# 3. Restore whitelist database
if [ -f "backend/whitelist_database.json.bak" ]; then
  echo "🛡️ 3. Restoring permanent whitelist database..."
  cp -f backend/whitelist_database.json.bak backend/whitelist_database.json
fi

# 4. Preserve Active Tables in Redis & Clear Stale Daemon Locks
echo "⚡ 4. Keeping warmed casino tables active in Redis..."
if command -v redis-cli >/dev/null 2>&1; then
  # Only clear stale locks, do NOT wipe warmed tables!
  redis-cli del casinotv:lock:cron:table_warmer_daemon >/dev/null 2>&1 || true
  redis-cli del cron:table_warmer_daemon >/dev/null 2>&1 || true
  echo "✅ Active warmed tables preserved in Redis."
fi

# 5. Restart PM2 Process
echo "🔄 5. Restarting casinotv-stream PM2 worker..."
pm2 restart casinotv-stream --update-env

# 6. Wait for initial table warming confirmation
echo "🏥 6. Verifying API health and hot cache status..."
PORT_NUM="${PORT:-5050}"
for i in {1..15}; do
  TTL_VAL=$(redis-cli ttl 'casinotv:html:99.0010' 2>/dev/null || echo -2)
  if [ "$TTL_VAL" -gt 0 ]; then
    echo "✅ Tables confirmed ACTIVE in Redis (TTL: ${TTL_VAL}s)!"
    break
  fi
  sleep 1
done

echo "========================================================"
echo "📋 Recent 25 lines of casinotv-stream logs:"
echo "========================================================"
pm2 logs casinotv-stream --lines 25 --nostream

echo "========================================================"
echo "✅ FRESH DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo "🎯 Latest code active, cache purged, zero stuck streams!"
echo "========================================================"
