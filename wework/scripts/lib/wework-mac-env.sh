#!/usr/bin/env bash

# Shared macOS build helpers for Wework scripts.

wework_get_local_ip() {
  local ip

  for interface in en0 en1; do
    ip="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
    if [ -n "$ip" ]; then
      echo "$ip"
      return
    fi
  done

  local default_interface
  default_interface="$(route get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  if [ -n "$default_interface" ]; then
    ip="$(ipconfig getifaddr "$default_interface" 2>/dev/null || true)"
    if [ -n "$ip" ]; then
      echo "$ip"
      return
    fi
  fi

  echo "127.0.0.1"
}

wework_normalize_api_proxy_target() {
  local value="${1%/}"

  if [[ "$value" == */api ]]; then
    value="${value%/api}"
  fi

  echo "$value"
}

wework_resolve_backend_base_url() {
  local local_ip="${WEWORK_HOST:-$(wework_get_local_ip)}"
  local backend_port="${BACKEND_PORT:-9100}"

  echo "http://$local_ip:$backend_port"
}
