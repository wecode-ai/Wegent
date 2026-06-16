#!/usr/bin/env bash
# Regression tests for standalone image startup verification.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY_SCRIPT="$PROJECT_ROOT/scripts/verify-standalone-image.sh"

TMP_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$TMP_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

echo "docker $*" >> "$FAKE_DOCKER_LOG"

case "$1" in
    run)
        echo "container-id"
        ;;
    inspect)
        echo "true"
        ;;
    ps)
        echo "$CONTAINER_NAME"
        ;;
    logs)
        echo "standalone container logs"
        ;;
    rm)
        echo "removed"
        ;;
    *)
        echo "unexpected docker command: $*" >&2
        exit 1
        ;;
esac
EOF
chmod +x "$TMP_DIR/docker"

cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

url="${@: -1}"
echo "$url" >> "$FAKE_CURL_LOG"

case "$url" in
    *:18000/health)
        exit 0
        ;;
    *:13000/)
        exit 22
        ;;
    *)
        echo "unexpected curl URL: $url" >&2
        exit 1
        ;;
esac
EOF
chmod +x "$TMP_DIR/curl"

export PATH="$TMP_DIR:$PATH"
export FAKE_DOCKER_LOG="$TMP_DIR/docker.log"
export FAKE_CURL_LOG="$TMP_DIR/curl.log"
export CONTAINER_NAME="wegent-standalone-test"
export STANDALONE_VERIFY_TIMEOUT_SECONDS=0
export STANDALONE_VERIFY_INTERVAL_SECONDS=1

if "$VERIFY_SCRIPT" "ghcr.io/wecode-ai/wegent-standalone:test" > "$TMP_DIR/output.log" 2>&1; then
    echo "Expected standalone verification to fail when frontend is unreachable."
    cat "$TMP_DIR/output.log"
    exit 1
fi

if ! grep -q "Frontend failed readiness check" "$TMP_DIR/output.log"; then
    echo "Expected frontend readiness failure message."
    cat "$TMP_DIR/output.log"
    exit 1
fi

if ! grep -q "standalone container logs" "$TMP_DIR/output.log"; then
    echo "Expected container logs on verification failure."
    cat "$TMP_DIR/output.log"
    exit 1
fi

if ! grep -q "docker rm -f $CONTAINER_NAME" "$FAKE_DOCKER_LOG"; then
    echo "Expected verification script to clean up the container."
    cat "$FAKE_DOCKER_LOG"
    exit 1
fi

echo "standalone image verification regression test passed"
