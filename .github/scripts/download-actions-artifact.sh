#!/usr/bin/env bash

set -euo pipefail

artifact_name="${1:?artifact name is required}"
destination="${2:?destination directory is required}"
api_url="${GITHUB_API_URL:-https://api.github.com}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
token="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
wait_seconds="${ACTIONS_ARTIFACT_WAIT_SECONDS:-0}"
source_workflow="${ACTIONS_ARTIFACT_WORKFLOW:-}"
source_head_sha="${ACTIONS_ARTIFACT_HEAD_SHA:-}"
source_event="${GITHUB_EVENT_NAME:-}"
if [[ -n "$source_workflow" ]]; then
  : "${ACTIONS_ARTIFACT_HEAD_SHA:?ACTIONS_ARTIFACT_HEAD_SHA is required for a source workflow}"
  : "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required for a source workflow}"
fi
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

deadline=$((SECONDS + wait_seconds))
artifact_id=""
while [[ -z "$artifact_id" ]]; do
  source_run_status=""
  if [[ -n "$source_workflow" ]]; then
    runs_json="$(request \
      "$api_url/repos/$repository/actions/workflows/$source_workflow/runs?head_sha=$source_head_sha&event=$source_event&per_page=100")"
    source_run="$(node -e '
const fs = require("node:fs")
const [sha, event] = process.argv.slice(1)
const payload = JSON.parse(fs.readFileSync(0, "utf8"))
if (!Array.isArray(payload.workflow_runs)) throw new Error("Invalid workflow run response")
const runs = payload.workflow_runs
  .filter(run => run.head_sha === sha && run.event === event)
  .sort((left, right) => right.id - left.id)
if (runs.length) console.log(runs[0].id, runs[0].status)
' "$source_head_sha" "$source_event" <<<"$runs_json")"
    read -r run_id source_run_status <<<"$source_run"
  fi
  if [[ -n "$run_id" ]]; then
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
if len(matches) > 1:
    raise SystemExit(f"Expected at most one active artifact named {name!r}, found {len(matches)}")
if matches:
    print(matches[0]["id"])
' "$artifact_name" <<<"$artifacts_json"
    )"
  fi
  if [[ -n "$artifact_id" ]]; then
    break
  fi
  if [[ "$source_run_status" == "completed" ]]; then
    echo "Workflow $source_workflow run $run_id completed without artifact $artifact_name for $source_head_sha" >&2
    exit 1
  fi
  if ((SECONDS >= deadline)); then
    echo "Artifact $artifact_name was not available after ${wait_seconds}s" >&2
    exit 1
  fi
  sleep 2
done

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
