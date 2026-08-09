#!/bin/sh

echo "========================================"
echo "Starting KGconcept..."
echo "========================================"
echo "FNOS_ENV=$FNOS_ENV"
echo "DOWNLOAD_DIR=$DOWNLOAD_DIR"

# ============================================================
# TRIM_API_TOKEN 获取流程（三重保障）
#
# 飞牛 appcenter 启动 Docker 容器时，不会把 token 直接注入容器环境。
# token 由飞牛在调用 cmd/* 脚本时注入，我们通过文件中转：
#
#   飞牛调用 install_callback / config_callback / cmd/main 时
#     → 环境变量里有 TRIM_API_TOKEN
#     → 写入 /var/apps/KGconcept/.trim_token
#     → docker-compose 挂载到容器内 /app/.trim_token
#     → 这里读取并 export
# ============================================================

TOKEN_FILE="/app/.trim_token"
TOKEN_READY=0
MAX_WAIT=30
WAIT_COUNT=0

# 轮询等待 token 文件（最多 30 秒，每秒检查一次）
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if [ -f "$TOKEN_FILE" ]; then
        TOKEN_CONTENT=$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\n' | tr -d '\r')
        if [ -n "$TOKEN_CONTENT" ]; then
            export TRIM_API_TOKEN="$TOKEN_CONTENT"
            echo "✅ TRIM_API_TOKEN: OK (loaded from $TOKEN_FILE, length=${#TOKEN_CONTENT})"
            TOKEN_READY=1
            break
        else
            echo "⏳ $TOKEN_FILE exists but is EMPTY, waiting... ($((WAIT_COUNT+1))/$MAX_WAIT)"
        fi
    else
        echo "⏳ Waiting for $TOKEN_FILE to appear... ($((WAIT_COUNT+1))/$MAX_WAIT)"
    fi
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 1
done

if [ $TOKEN_READY -eq 0 ]; then
    echo "⚠️  WARNING: TRIM_API_TOKEN not available after ${MAX_WAIT}s."
    echo "   Backend API calls (getSharedAccessibleFolders, convertPath) will fail."
    echo "   Make sure install_callback / config_callback scripts wrote the token file."
    export TRIM_API_TOKEN=""
fi

echo "TRIM_APPNAME=$TRIM_APPNAME"
echo "========================================"

# Ensure download directory exists
mkdir -p /app/downloads

# Write a diagnostic log to the download dir so we can check from the fnOS file manager
MOUNT_LOG="/app/downloads/.mount_diagnose.log"
{
  echo "==== $(date) ===="
  echo "FNOS_ENV=$FNOS_ENV"
  echo "DOWNLOAD_DIR=$DOWNLOAD_DIR"
  echo "TRIM_APPNAME=$TRIM_APPNAME"
  echo "TRIM_API_TOKEN_LEN=${#TRIM_API_TOKEN}"
  echo ""
  echo "-- token file --"
  ls -la /app/.trim_token 2>/dev/null || echo "  not found"
  echo ""
  echo "-- socket --"
  if [ -S /var/run/trim_open_gateway_apiscope.socket ]; then
    echo "  socket: EXISTS"
  else
    echo "  socket: NOT FOUND"
  fi
  echo ""
  echo "-- /vol1 --"
  ls /vol1 2>/dev/null | head -20 || echo "  no /vol1"
  echo ""
  echo "-- /app/downloads writable? --"
  if touch /app/downloads/.writable_test 2>&1; then
    echo "  writable: YES"
    rm -f /app/downloads/.writable_test
  else
    echo "  writable: NO"
  fi
  echo ""
  echo "-- TRIM_API_TOKEN first 20 chars --"
  echo "${TRIM_API_TOKEN:0:20}..."
} > "$MOUNT_LOG" 2>&1

# Print the log to stdout too
cat "$MOUNT_LOG"

echo ''
echo 'Mobile client running @ http://127.0.0.1:8880/'
echo 'API running @ http://127.0.0.1:6521/'

# Start API in background
cd /app/KuGouMusicApi && node app.js --platform=lite &

# Start Nginx in foreground
nginx -g 'daemon off;'
