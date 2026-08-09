#!/bin/sh

echo "========================================"
echo "Starting KGconcept..."
echo "========================================"
echo "FNOS_ENV=$FNOS_ENV"
echo "DOWNLOAD_DIR=$DOWNLOAD_DIR"

# ============================================================
# TRIM_API_TOKEN 获取流程
#
# 飞牛文档: https://developer.fnnas.com/api/calling/#接口调用认证
#   - 所有后端 API 必须通过 Authorization: Bearer <token> 鉴权
#   - token 由飞牛在调用应用脚本（cmd/* / install_callback / config_callback）
#     时通过 TRIM_API_TOKEN 环境变量注入
#
# 但飞牛 appcenter 启动 docker-compose 时，不会把 TRIM_API_TOKEN 直接注入容器。
# 我们通过以下机制中转：
#
#   飞牛执行脚本时注入 TRIM_API_TOKEN + TRIM_APPDEST
#     → 我们的脚本写入 ${TRIM_APPDEST}/.trim_token
#        （默认 /var/apps/KGconcept/.trim_token，
#          也可通过容器环境变量 TRIM_TOKEN_FILE 覆盖）
#     → docker-compose 把整个 /var/apps/KGconcept 目录只读挂载进容器
#        （避免单文件挂载时 docker 误创建空目录的 bug）
#     → 这里读取文件并 export
# ============================================================

TOKEN_FILE="${TRIM_TOKEN_FILE:-/var/apps/KGconcept/.trim_token}"
TOKEN_READY=0
MAX_WAIT=30
WAIT_COUNT=0

echo "TOKEN_FILE=$TOKEN_FILE"

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
            echo "⏳ $TOKEN_FILE 存在但是 EMPTY (0 bytes), waiting... ($((WAIT_COUNT+1))/$MAX_WAIT)"
        fi
    elif [ -d "$TOKEN_FILE" ]; then
        echo "❌ FATAL: $TOKEN_FILE 是目录，不是文件！docker 把挂载文件创建成了空目录。"
        echo "   → 请卸载应用，删除宿主机 /var/apps/KGconcept/.trim_token（如果是目录）后重装"
        # 不 break，继续等，也许后续脚本会重建
    else
        echo "⏳ 等待 $TOKEN_FILE 出现... ($((WAIT_COUNT+1))/$MAX_WAIT)"
    fi
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 1
done

if [ $TOKEN_READY -eq 0 ]; then
    echo "⚠️  WARNING: TRIM_API_TOKEN 不可用 (${MAX_WAIT}s 超时)"
    echo "   未拿到有效 token 时，trim.file.getSharedAccessibleFolders 会返回 200004 Unauthorized"
    echo "   排查方法："
    echo "   1) 查看宿主机 /var/apps/KGconcept/.cmd_diagnose.log 确认飞牛脚本是否真的执行并写入 token"
    echo "   2) 确认 /var/apps/KGconcept/.trim_token 是否是普通文件 (不是目录) 且内容非空"
    export TRIM_API_TOKEN=""
fi

echo "TRIM_APPNAME=$TRIM_APPNAME"
echo "TRIM_TOKEN_FILE=$TOKEN_FILE"
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
  echo "TRIM_TOKEN_FILE=$TOKEN_FILE"
  echo "TRIM_API_TOKEN_LEN=${#TRIM_API_TOKEN}"
  echo ""
  echo "-- token file --"
  if [ -d "$TOKEN_FILE" ]; then
    echo "  $TOKEN_FILE: ERROR 是目录！不是文件"
  elif [ -f "$TOKEN_FILE" ]; then
    echo "  $TOKEN_FILE: 普通文件, 大小=$(wc -c < "$TOKEN_FILE") bytes"
  else
    echo "  $TOKEN_FILE: 不存在"
  fi
  echo ""
  echo "-- cmd 诊断日志（宿主机 /var/apps/KGconcept/.cmd_diagnose.log）最新 20 行 --"
  CMD_LOG="/var/apps/KGconcept/.cmd_diagnose.log"
  if [ -f "$CMD_LOG" ]; then
    tail -n 20 "$CMD_LOG" 2>/dev/null || echo "(无法读取)"
  else
    echo "  $CMD_LOG 不存在 → 说明 install_callback/config_callback/cmd/main 均未被执行！"
  fi
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
