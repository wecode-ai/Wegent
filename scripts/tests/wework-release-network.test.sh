#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NETWORK_SCRIPT="$PROJECT_DIR/wework/scripts/lib/wework-release-network.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_configures_release_proxy() {
  local actual
  actual="$(bash -c '
    set -euo pipefail
    source "$1"
    export WEWORK_USE_BUILD_PROXY=true
    export WEWORK_BUILD_HTTP_PROXY=http://proxy.example.com:8080
    export WEWORK_BUILD_HTTPS_PROXY=http://proxy.example.com:8080
    export WEWORK_BUILD_ALL_PROXY=socks5://proxy.example.com:1080
    export WEWORK_BUILD_NO_PROXY=localhost,.internal.example.com
    wework_configure_release_proxy minio.internal.example.com
    printf "%s|%s|%s|%s|%s" \
      "$HTTP_PROXY" \
      "$HTTPS_PROXY" \
      "$ALL_PROXY" \
      "$NO_PROXY" \
      "$ELECTRON_GET_USE_PROXY"
  ' _ "$NETWORK_SCRIPT")"

  [ "$actual" = \
    "http://proxy.example.com:8080|http://proxy.example.com:8080|socks5://proxy.example.com:1080|localhost,.internal.example.com,minio.internal.example.com|1" ] \
    || fail "unexpected release proxy configuration: $actual"
}

test_disabled_proxy_clears_environment() {
  local actual
  actual="$(HTTP_PROXY=http://old HTTPS_PROXY=http://old ALL_PROXY=socks5://old bash -c '
    set -euo pipefail
    source "$1"
    export WEWORK_USE_BUILD_PROXY=false
    wework_configure_release_proxy
    printf "%s|%s|%s" "${HTTP_PROXY:-}" "${HTTPS_PROXY:-}" "${ALL_PROXY:-}"
  ' _ "$NETWORK_SCRIPT")"

  [ "$actual" = "||" ] || fail "disabled release proxy kept stale variables: $actual"
}

test_rejects_invalid_http_proxy() {
  if bash -c '
    source "$1"
    export WEWORK_USE_BUILD_PROXY=true
    export WEWORK_BUILD_HTTP_PROXY=socks5://proxy.example.com:1080
    export WEWORK_BUILD_HTTPS_PROXY=http://proxy.example.com:8080
    wework_configure_release_proxy
  ' _ "$NETWORK_SCRIPT" >/dev/null 2>&1; then
    fail "release proxy accepted a SOCKS URL for HTTP_PROXY"
  fi
}

test_configures_release_proxy
test_disabled_proxy_clears_environment
test_rejects_invalid_http_proxy
echo "wework release network tests passed"
