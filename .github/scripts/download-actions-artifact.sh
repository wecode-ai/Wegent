#!/usr/bin/env bash

set -euo pipefail

artifact_name="${1:?artifact name is required}"
destination="${2:?destination directory is required}"
api_url="${GITHUB_API_URL:-https://api.github.com}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
token="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
temp_dir="$(mktemp -d)"
archive="$temp_dir/artifact.zip"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

request() {
  curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 2 \
    --connect-timeout 10 \
    --header "Authorization: Bearer $token" \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

artifacts_json="$(request \
  "$api_url/repos/$repository/actions/runs/$run_id/artifacts?per_page=100")"
artifact_id="$(
  python3 -c '
import json
import sys

name = sys.argv[1]
payload = json.load(sys.stdin)
matches = [
    artifact
    for artifact in payload.get("artifacts", [])
    if artifact.get("name") == name and not artifact.get("expired", False)
]
if len(matches) != 1:
    raise SystemExit(
        f"Expected one active artifact named {name!r}, found {len(matches)}"
    )
print(matches[0]["id"])
' "$artifact_name" <<<"$artifacts_json"
)"

request \
  --output "$archive" \
  "$api_url/repos/$repository/actions/artifacts/$artifact_id/zip"

mkdir -p "$destination"
python3 -c '
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
' "$archive" "$destination"
