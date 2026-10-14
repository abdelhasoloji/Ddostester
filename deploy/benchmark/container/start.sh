#!/bin/sh
set -eu
mkdir -p /var/log/lab
touch /var/log/lab/requests.jsonl
chmod 660 /var/log/lab/requests.jsonl
php-fpm -F &
PHP_PID=$!
nginx -e /dev/stderr -g 'daemon off;' &
NGINX_PID=$!
stop() { kill -TERM "$PHP_PID" "$NGINX_PID" 2>/dev/null || true; }
trap stop TERM INT EXIT
# Stop the sibling when either service exits.
while kill -0 "$PHP_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do sleep 1; done
stop
wait "$PHP_PID" 2>/dev/null || true
wait "$NGINX_PID" 2>/dev/null || true
