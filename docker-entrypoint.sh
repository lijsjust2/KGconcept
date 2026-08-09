#!/bin/sh

echo "Starting KGconcept..."
echo "FNOS_ENV=$FNOS_ENV"
echo "DOWNLOAD_DIR=$DOWNLOAD_DIR"

# ============================================================
# 从 /app/.trim_token 读取并 export TRIM_API_TOKEN
#
# 飞牛 appcenter 启动 Docker 容器时，不会把 cmd/main 里拿到的 env 注入容器。
# cmd/main 在被调用时会把 token 写到应用目录下的 .trim_token，
# docker-compose 把这个文件以只读方式挂载到容器。
# ============================================================
if [ -f /app/.trim_token ]; then
    TOKEN_CONTENT=$(cat /app/.trim_token 2>/dev/null | tr -d '\n' | tr -d '\r')
    if [ -n "$TOKEN_CONTENT" ]; then
        export TRIM_API_TOKEN="$TOKEN_CONTENT"
        echo "TRIM_API_TOKEN: OK (loaded from /app/.trim_token, length=${#TOKEN_CONTENT})"
    else
        echo "TRIM_API_TOKEN: /app/.trim_token exists but is EMPTY"
    fi
else
    echo "TRIM_API_TOKEN: /app/.trim_token NOT FOUND — app-center cmd/main may not have run yet, or file was not mounted. Backend OpenAPI calls will fail."
fi

echo "TRIM_APPNAME=$TRIM_APPNAME"

# Ensure download directory exists (fnOS shared folder mount point)
mkdir -p /app/downloads

# Diagnose mount point: is it really a mounted shared folder?
MOUNT_LOG="/app/downloads/.mount_diagnose.log"
{
  echo "==== $(date) ===="
  echo "FNOS_ENV=$FNOS_ENV"
  echo "DOWNLOAD_DIR=$DOWNLOAD_DIR"
  echo "TRIM_API_TOKEN_LEN=${#TRIM_API_TOKEN}"
  echo "TRIM_APPNAME=$TRIM_APPNAME"
  echo "-- /app/.trim_token --"
  if [ -f /app/.trim_token ]; then
    echo "  exists: yes"
    wc -c /app/.trim_token
  else
    echo "  exists: NO"
  fi
  echo "-- /app/downloads mounted? --"
  mount | grep /app/downloads || echo "(no mount info)"
  echo "-- /app/downloads stat --"
  ls -ld /app/downloads
  echo "-- /app/downloads contents --"
  ls -la /app/downloads | head -20
  echo "-- /vol1 contents (1st level) --"
  ls -la /vol1 2>/dev/null | head -30 || echo "(no /vol1)"
  echo "-- socket --"
  if [ -S /var/run/trim_open_gateway_apiscope.socket ]; then
    echo "  socket exists: yes"
  else
    echo "  socket exists: NO"
  fi
  echo "-- write test --"
  if touch /app/downloads/.writable_test 2>&1; then
    echo "WRITABLE=yes"
    rm -f /app/downloads/.writable_test
  else
    echo "WRITABLE=no"
    chmod 777 /app/downloads 2>&1 || echo "chmod failed"
    # Try again after chmod
    if touch /app/downloads/.writable_test 2>&1; then
      echo "WRITABLE_AFTER_CHMOD=yes"
      rm -f /app/downloads/.writable_test
    else
      echo "WRITABLE_AFTER_CHMOD=no — files will be written inside container (will be lost on restart)"
    fi
  fi
} > "$MOUNT_LOG" 2>&1

cat "$MOUNT_LOG"

# Start services
echo 'Mobile client running @ http://127.0.0.1:8880/'
echo 'API running @ http://127.0.0.1:6521/'

# Start API in background
cd /app/KuGouMusicApi && node app.js --platform=lite &

# Start Nginx in foreground
nginx -g 'daemon off;'
