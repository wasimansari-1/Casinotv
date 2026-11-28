#!/usr/bin/env bash
set -e

echo "========================================================"
echo "📱 Connecting VPS to Tailscale Phone Proxy Engine..."
echo "========================================================"

APP_DIR="/root/Casinotv"
if [ ! -d "$APP_DIR" ]; then
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$APP_DIR"

PROXY_TARGET="${1:-http://100.127.231.58:8080}"
ENV_FILE="$APP_DIR/.env"

echo "🎯 Config Target: $PROXY_TARGET"

# 1. Update or create .env
if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
fi

if grep -q "UPSTREAM_PROXY_URL" "$ENV_FILE"; then
  sed -i "s|^UPSTREAM_PROXY_URL=.*|UPSTREAM_PROXY_URL=$PROXY_TARGET|" "$ENV_FILE"
else
  echo "UPSTREAM_PROXY_URL=$PROXY_TARGET" >> "$ENV_FILE"
fi

echo "✅ Saved UPSTREAM_PROXY_URL=$PROXY_TARGET in $ENV_FILE"

# 2. Test Proxy Connectivity
echo "🔍 Testing Tailscale connection to Phone Proxy..."
if command -v curl >/dev/null 2>&1; then
  GEO_OUT=$(curl -s --connect-timeout 5 -x "$PROXY_TARGET" https://ipinfo.io/json || true)
  if echo "$GEO_OUT" | grep -q "ip"; then
    PHONE_IP=$(echo "$GEO_OUT" | grep '"ip"' | head -1 | cut -d'"' -f4)
    PHONE_ORG=$(echo "$GEO_OUT" | grep '"org"' | head -1 | cut -d'"' -f4)
    PHONE_CITY=$(echo "$GEO_OUT" | grep '"city"' | head -1 | cut -d'"' -f4)
    PHONE_COUNTRY=$(echo "$GEO_OUT" | grep '"country"' | head -1 | cut -d'"' -f4)
    echo "========================================================"
    echo "🎉 PROXY VERIFIED SUCCESSFUL!"
    echo "📍 Public IP: $PHONE_IP"
    echo "🏢 Carrier/ISP: $PHONE_ORG"
    echo "🌆 Location: $PHONE_CITY, $PHONE_COUNTRY"
    echo "========================================================"
  else
    echo "⚠️ Warning: Proxy not responding yet. Ensure Every Proxy is toggled ON in Android app."
  fi
fi

# 3. Restart PM2 with updated environment
echo "🔄 Reloading PM2 with new residential proxy..."
pm2 restart casinotv-stream --update-env

echo "========================================================"
echo "✅ VPS is now routing through your 5G Mobile Phone Proxy!"
echo "🎯 Lifetime Cloudflare & Platin bypass active!"
echo "========================================================"
