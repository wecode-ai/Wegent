#!/usr/bin/env bash

set -euo pipefail

image="${1:?OCI image is required}"
source_path="${2:?source path inside the image is required}"
destination="${3:?destination path is required}"
wait_seconds="${OCI_RUNTIME_WAIT_SECONDS:-0}"
token="${GITHUB_TOKEN:-}"
actor="${GITHUB_ACTOR:-}"
temp_dir="$(mktemp -d)"
copy_log="$temp_dir/skopeo.log"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

credentials=()
if [[ -n "$token" && -n "$actor" ]]; then
  credentials=(--src-creds "$actor:$token")
fi

deadline=$((SECONDS + wait_seconds))
while true; do
  rm -rf "$temp_dir/image" "$temp_dir/bundle"
  if skopeo copy \
    --retry-times 3 \
    "${credentials[@]}" \
    "docker://$image" \
    "oci:$temp_dir/image:runtime" >"$copy_log" 2>&1; then
    umoci unpack \
      --rootless \
      --image "$temp_dir/image:runtime" \
      "$temp_dir/bundle"
    restored_source="$temp_dir/bundle/rootfs/${source_path#/}"
    test -f "$restored_source"
    mkdir -p "$(dirname "$destination")"
    restored_destination="${destination}.restore.$$"
    cp "$restored_source" "$restored_destination"
    chmod 0755 "$restored_destination"
    mv -f "$restored_destination" "$destination"
    exit 0
  fi

  if ((SECONDS >= deadline)); then
    cat "$copy_log" >&2
    echo "OCI runtime image was not available after ${wait_seconds}s: $image" >&2
    exit 1
  fi
  sleep 2
done
