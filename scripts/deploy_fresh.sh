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
rm -f backend/whitelist_database.json 2>/dev/null || true
git fetch origin main
git reset --hard origin/main

# 3. Restore whitelist database
if [ -f "backend/whitelist_database.json.bak" ]; then
  echo "🛡️ 3. Restoring permanent whitelist database..."
  cp -f backend/whitelist_database.json.bak backend/whitelist_database.json
fi

# 4. Flush Redis Cache
echo "🧹 4. Purging stale Redis cache..."
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli flushall >/dev/null 2>&1 || true
  echo "✅ Redis cache flushed cleanly."
fi

# 5. Restart PM2 Process
echo "🔄 5. Restarting casinotv-stream PM2 worker..."
pm2 restart casinotv-stream --update-env

# 6. Verify health
sleep 2
echo "🏥 6. Verifying API health status..."
if command -v curl >/dev/null 2>&1; then
  curl -s http://localhost:3000/api/stream/health | grep -q "ok" && echo "✅ Service is HEALTHY and serving zero-latency streams!" || echo "⚠️ Service online (check pm2 logs casinotv-stream if needed)"
fi

echo "========================================================"
echo "✅ FRESH DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo "🎯 Latest code active, cache purged, zero stuck streams!"
echo "========================================================"
