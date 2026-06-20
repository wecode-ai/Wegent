#!/usr/bin/env bash
# Regression checks for the standalone nginx reverse proxy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NGINX_CONF="$PROJECT_ROOT/docker/standalone/nginx.conf"

if ! awk '
    $1 == "location" && $2 == "/" {
        in_frontend_location = 1
    }
    in_frontend_location && /proxy_set_header Host \$http_host;/ {
        found = 1
    }
    in_frontend_location && /^    }/ {
        in_frontend_location = 0
    }
    END {
        exit found ? 0 : 1
    }
' "$NGINX_CONF"; then
    echo "Expected standalone frontend proxy to preserve the original Host header with port."
    exit 1
fi

echo "standalone nginx config regression test passed"
