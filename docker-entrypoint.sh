#!/bin/sh

echo "Starting KGconcept..."

# Ensure download directory exists (fnOS shared folder mount point)
mkdir -p /app/downloads

# Start services
echo 'Mobile client running @ http://127.0.0.1:8880/'
echo 'API running @ http://127.0.0.1:6521/'

# Start API in background
cd /app/KuGouMusicApi && node app.js --platform=lite &

# Start Nginx in foreground
nginx -g 'daemon off;'
