#!/usr/bin/env bash

wework_resolve_componentized_host_update() {
  local manifest_url="$1"
  local scripts_dir

  scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if curl -fsS "$manifest_url" 2>/dev/null |
    node "$scripts_dir/update-channel-manifests.mjs" \
      supports-componentized-host-update -; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}
