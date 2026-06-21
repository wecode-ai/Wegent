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
echo "$*" >> "$FAKE_CURL_LOG"

case "$url" in
    *:13000/health)
        exit 0
        ;;
    *:13000/)
        exit 0
        ;;
    *:13000/wework/)
        exit 0
        ;;
    *:13000/api/users/me)
        echo "${FAKE_API_STATUS:-404}"
        exit 0
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

export FAKE_API_STATUS=400
if ! bash "$VERIFY_SCRIPT" "ghcr.io/wecode-ai/wegent-standalone:test" > "$TMP_DIR/output-success.log" 2>&1; then
    echo "Expected standalone verification to pass when the API proxy reaches backend setup-required response."
    cat "$TMP_DIR/output-success.log"
    exit 1
fi

if ! grep -q "API proxy is reachable (HTTP 400)" "$TMP_DIR/output-success.log"; then
    echo "Expected API proxy success message for HTTP 400 setup-required response."
    cat "$TMP_DIR/output-success.log"
    exit 1
fi

export FAKE_API_STATUS=404
if bash "$VERIFY_SCRIPT" "ghcr.io/wecode-ai/wegent-standalone:test" > "$TMP_DIR/output.log" 2>&1; then
    echo "Expected standalone verification to fail when the API proxy returns 404."
    cat "$TMP_DIR/output.log"
    exit 1
fi

if ! grep -q "API proxy failed readiness check" "$TMP_DIR/output.log"; then
    echo "Expected API proxy readiness failure message."
    cat "$TMP_DIR/output.log"
    exit 1
fi

if ! grep -q "http://localhost:13000/wework/" "$FAKE_CURL_LOG"; then
    echo "Expected Wework to be checked through the frontend standalone port."
    cat "$FAKE_CURL_LOG"
    exit 1
fi

if ! grep -q "http://localhost:13000/api/users/me" "$FAKE_CURL_LOG"; then
    echo "Expected API proxy to be checked through the standalone port."
    cat "$FAKE_CURL_LOG"
    exit 1
fi

if ! grep -q "Referer: http://localhost:13000/" "$FAKE_CURL_LOG"; then
    echo "Expected API proxy check to include a same-origin Referer header."
    cat "$FAKE_CURL_LOG"
    exit 1
fi

if ! grep -q "http://localhost:13000/health" "$FAKE_CURL_LOG"; then
    echo "Expected backend health to be checked through the standalone port."
    cat "$FAKE_CURL_LOG"
    exit 1
fi

if grep -q ":8000" "$FAKE_DOCKER_LOG"; then
    echo "Expected standalone verification to avoid the old direct backend port."
    cat "$FAKE_DOCKER_LOG"
    exit 1
fi

if grep -q ":3001" "$FAKE_DOCKER_LOG"; then
    echo "Expected standalone verification to avoid the old container Wework port."
    cat "$FAKE_DOCKER_LOG"
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
