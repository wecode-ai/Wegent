#!/usr/bin/env bash

wework_clear_release_proxy() {
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
  unset http_proxy https_proxy all_proxy no_proxy
  unset ELECTRON_GET_USE_PROXY
}

wework_require_proxy_url() {
  local name="$1"
  local value="$2"
  local allowed_socks="${3:-false}"

  if [ -z "$value" ]; then
    echo "Missing required release proxy setting: $name" >&2
    return 1
  fi
  case "$value" in
    http://*|https://*) return 0 ;;
    socks5://*|socks5h://*)
      if [ "$allowed_socks" = "true" ]; then
        return 0
      fi
      ;;
  esac
  echo "Unsupported release proxy URL for $name: ${value%%:*}://" >&2
  return 1
}

wework_configure_release_proxy() {
  local extra_no_proxy="${1:-}"
  local configured_no_proxy="${WEWORK_BUILD_NO_PROXY:-localhost,127.0.0.1,.intra.weibo.com}"

  if [ "${WEWORK_USE_BUILD_PROXY:-false}" != "true" ]; then
    wework_clear_release_proxy
    return 0
  fi

  wework_require_proxy_url \
    WEWORK_BUILD_HTTP_PROXY \
    "${WEWORK_BUILD_HTTP_PROXY:-}" \
    || return 1
  wework_require_proxy_url \
    WEWORK_BUILD_HTTPS_PROXY \
    "${WEWORK_BUILD_HTTPS_PROXY:-}" \
    || return 1
  if [ -n "${WEWORK_BUILD_ALL_PROXY:-}" ]; then
    wework_require_proxy_url \
      WEWORK_BUILD_ALL_PROXY \
      "$WEWORK_BUILD_ALL_PROXY" \
      true \
      || return 1
  fi

  export http_proxy="$WEWORK_BUILD_HTTP_PROXY"
  export https_proxy="$WEWORK_BUILD_HTTPS_PROXY"
  export HTTP_PROXY="$http_proxy"
  export HTTPS_PROXY="$https_proxy"
  if [ -n "${WEWORK_BUILD_ALL_PROXY:-}" ]; then
    export all_proxy="$WEWORK_BUILD_ALL_PROXY"
    export ALL_PROXY="$all_proxy"
  else
    unset all_proxy ALL_PROXY
  fi
  if [ -n "$extra_no_proxy" ]; then
    configured_no_proxy="$configured_no_proxy,$extra_no_proxy"
  fi
  export no_proxy="$configured_no_proxy"
  export NO_PROXY="$no_proxy"
  export ELECTRON_GET_USE_PROXY=1
}
