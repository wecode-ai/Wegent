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
source_job="${ACTIONS_ARTIFACT_JOB:-}"
source_event="${GITHUB_EVENT_NAME:-}"
if [[ -n "$source_workflow" || -n "$source_job" ]]; then
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
    --header "Cache-Control: no-cache" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

producer_state_for() {
  local jobs_json
  jobs_json="$(request "$api_url/repos/$repository/actions/runs/$1/jobs?per_page=100")"
  node -e '
const fs = require("node:fs")
const payload = JSON.parse(fs.readFileSync(0, "utf8"))
if (!Array.isArray(payload.jobs)) throw new Error("Invalid workflow jobs response")
const job = payload.jobs.find(job => job.name === process.argv[1])
if (!job) console.log("absent")
else if (job.conclusion) console.log(job.conclusion)
else {
  const steps = job.steps ?? []
  const failed = steps.find(step => step.status === "completed" &&
    !["success", "skipped"].includes(step.conclusion))
  const finished = steps.at(-1)?.name === "Complete job" && steps.every(step =>
    step.status === "completed" && ["success", "skipped"].includes(step.conclusion))
  // GitHub can publish terminal steps before updating the enclosing job status.
  console.log(failed?.conclusion || (finished ? "steps_completed" : job.status))
}
' "$source_job" <<<"$jobs_json"
}

if [[ -z "$source_workflow" && -n "$source_job" ]]; then
  run_json="$(request "$api_url/repos/$repository/actions/runs/$run_id")"
  node -e '
const fs = require("node:fs")
const run = JSON.parse(fs.readFileSync(0, "utf8"))
const [sha, event] = process.argv.slice(1)
if (run.head_sha !== sha || run.event !== event)
  throw new Error("Current artifact run does not match the expected commit and event")
' "$source_head_sha" "$source_event" <<<"$run_json"
fi

deadline=$((SECONDS + wait_seconds))
discovery_started=$SECONDS
polls=0
artifact_id=""
while [[ -z "$artifact_id" ]]; do
  polls=$((polls + 1))
  source_run_status=""
  producer_state="untracked"
  producer_ready=true
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
for (const run of runs) console.log(run.id, run.status)
' "$source_head_sha" "$source_event" <<<"$runs_json")"
    run_id=""
    while read -r candidate_id candidate_status; do
      [[ -n "$candidate_id" ]] || continue
      if [[ -n "$source_job" ]]; then
        producer_state="$(producer_state_for "$candidate_id")"
        case "$producer_state" in
          skipped) continue ;;
          absent) [[ "$candidate_status" != "completed" ]] || continue ;;
          failure|cancelled|timed_out|action_required|startup_failure)
            echo "Producer $source_job in run $candidate_id ended with $producer_state" >&2
            exit 1 ;;
        esac
      fi
      run_id="$candidate_id"
      source_run_status="$candidate_status"
      break
    done <<<"$source_run"
  elif [[ -n "$source_job" ]]; then
    producer_state="$(producer_state_for "$run_id")"
    case "$producer_state" in
      success|steps_completed) ;;
      absent|queued|in_progress|waiting|pending|requested) producer_ready=false ;;
      *)
        echo "Producer $source_job in run $run_id ended with $producer_state" >&2
        exit 1 ;;
    esac
  fi
  if [[ -n "$run_id" && "$producer_ready" == "true" ]]; then
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
  if ((polls == 1 || polls % 15 == 0)); then
    printf '[actions-artifact] name=%s run=%s phase=discovery-pending producer=%s state=%s ready=%s seconds=%s polls=%s\n' \
      "$artifact_name" "$run_id" "$source_job" "$producer_state" "$producer_ready" \
      "$((SECONDS - discovery_started))" "$polls" >&2
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

printf '[actions-artifact] name=%s run=%s id=%s phase=discovery-wait seconds=%s polls=%s\n' \
  "$artifact_name" "$run_id" "$artifact_id" "$((SECONDS - discovery_started))" "$polls" >&2
transfer_started=$SECONDS
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
printf '[actions-artifact] name=%s run=%s id=%s phase=transfer-unpack seconds=%s\n' \
  "$artifact_name" "$run_id" "$artifact_id" "$((SECONDS - transfer_started))" >&2
