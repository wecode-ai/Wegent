#!/usr/bin/env bash

# Shared macOS build helpers for Wework scripts.

wework_resolve_backend_base_url() {
  local host="${WEWORK_HOST:-127.0.0.1}"
  local backend_port="${BACKEND_PORT:-9100}"

  echo "http://$host:$backend_port"
}
