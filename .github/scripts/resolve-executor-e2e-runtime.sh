#!/usr/bin/env bash
set -euo pipefail

base_image="${BASE_IMAGE:-ghcr.io/wecode-ai/wegent-base-python3.12:latest}"
source_digest="${SOURCE_DIGEST:?SOURCE_DIGEST is required}"
repository_owner="${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}"
output_file="${GITHUB_OUTPUT:-/dev/stdout}"

manifest_json="$(
  docker buildx imagetools inspect "$base_image" --format '{{json .Manifest}}'
)"
base_digest="$(
  jq -r '
    if .manifests then
      [
        .manifests[] |
        select(
          .platform.os == "linux" and
          .platform.architecture == "amd64"
        )
      ][0].digest
    else
      .digest
    end
  ' <<< "$manifest_json"
)"
test -n "$base_digest"
test "$base_digest" != "null"

pinned_base_image="${base_image%@*}@$base_digest"
runtime_digest="$(
  printf '%s\n%s\n' "$source_digest" "$pinned_base_image" |
    sha256sum |
    cut -d ' ' -f 1
)"

{
  echo "base-image=$pinned_base_image"
  echo "image=ghcr.io/${repository_owner,,}/wegent-e2e-claudecode-executor:$runtime_digest"
} >> "$output_file"
