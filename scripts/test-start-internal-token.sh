#!/usr/bin/env bash
# Regression test for start.sh internal service token bootstrapping.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
START_SH="$PROJECT_ROOT/start.sh"

start_services_body=$(awk '
    /^start_services\(\) \{/ {
        in_function = 1
        depth = 1
        print
        next
    }
    in_function {
        print
        opens = gsub(/\{/, "{")
        closes = gsub(/\}/, "}")
        depth += opens - closes
        if (depth == 0) {
            exit
        }
    }
' "$START_SH")

ensure_line=$(printf '%s\n' "$start_services_body" | awk '/ensure_internal_service_token/ { print NR; exit }')
compose_line=$(printf '%s\n' "$start_services_body" | awk '/check_mysql_redis/ { print NR; exit }')

if [ -z "$ensure_line" ]; then
    echo "Expected start_services to call ensure_internal_service_token."
    exit 1
fi

if [ -z "$compose_line" ]; then
    echo "Expected start_services to call check_mysql_redis."
    exit 1
fi

if [ "$ensure_line" -ge "$compose_line" ]; then
    echo "Expected INTERNAL_SERVICE_TOKEN to be ensured before Docker Compose is used."
    echo "ensure_internal_service_token line in start_services: $ensure_line"
    echo "check_mysql_redis line in start_services: $compose_line"
    exit 1
fi

echo "start.sh internal token bootstrap regression test passed"
