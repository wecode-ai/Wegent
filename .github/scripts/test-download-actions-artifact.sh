#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "$temp_dir/bin" "$temp_dir/fixture"
printf 'executor binary\n' >"$temp_dir/fixture/wegent-executor"
printf 'backend binary\n' >"$temp_dir/fixture/wegent-backend-rs"
(cd "$temp_dir/fixture" && zip -q "$temp_dir/artifact.zip" wegent-executor wegent-backend-rs)

cat >"$temp_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${@: -1}"
printf '%s\n' "$url" >>"$TEST_TEMP_DIR/requests"
case "$url" in
  */runs/7)
    if [[ "$TEST_CASE" == "current-wrong-sha" ]]; then
      printf '{"head_sha":"wrong","event":"pull_request"}'
    elif [[ "$TEST_CASE" == "current-wrong-event" ]]; then
      printf '{"head_sha":"target","event":"push"}'
    else
      printf '{"head_sha":"target","event":"pull_request"}'
    fi
    ;;
  */runs/7/jobs*)
    if [[ "$TEST_CASE" == current-terminal-* ]]; then
      conclusion=success
      [[ "$TEST_CASE" != current-terminal-failed ]] || conclusion=failure
      printf '{"jobs":[{"name":"%s","status":"in_progress","conclusion":null,"steps":[{"name":"Build","status":"completed","conclusion":"%s"},{"name":"Complete job","status":"completed","conclusion":"success"}]}]}' "$TEST_PRODUCER_JOB" "$conclusion"
      exit 0
    fi
    state=success
    case "$TEST_CASE" in
      current-pending)
        if [[ ! -f "$TEST_TEMP_DIR/current-producer-seen" ]]; then
          touch "$TEST_TEMP_DIR/current-producer-seen"
          state=in_progress
        fi
        ;;
      current-producer-*) state="${TEST_CASE#current-producer-}" ;;
      current-cached)
        state=in_progress
        for argument in "$@"; do
          if [[ "$argument" == 'Cache-Control: no-cache' ]]; then
            state=success
          fi
        done
        ;;
    esac
    if [[ "$state" == in_progress ]]; then
      printf '{"jobs":[{"name":"%s","status":"in_progress","conclusion":null}]}' "$TEST_PRODUCER_JOB"
    else
      printf '{"jobs":[{"name":"%s","status":"completed","conclusion":"%s"}]}' "$TEST_PRODUCER_JOB" "$state"
    fi
    ;;
  */workflows/e2e-tests.yml/runs*)
    if [[ "$TEST_CASE" == "queued" && ! -f "$TEST_TEMP_DIR/producer-seen" ]]; then
      touch "$TEST_TEMP_DIR/producer-seen"
      printf '{"workflow_runs":[]}'
    elif [[ "$TEST_CASE" == "wrong-sha" ]]; then
      printf '{"workflow_runs":[{"id":99,"head_sha":"wrong","event":"pull_request","status":"completed"}]}'
    elif [[ "$TEST_CASE" == producer-* ]]; then
      printf '{"workflow_runs":[{"id":43,"head_sha":"target","event":"pull_request","status":"completed"},{"id":42,"head_sha":"target","event":"pull_request","status":"in_progress"}]}'
    else
      printf '{"workflow_runs":[{"id":99,"head_sha":"wrong","event":"pull_request","status":"completed"},{"id":42,"head_sha":"target","event":"pull_request","status":"completed"},{"id":100,"head_sha":"target","event":"push","status":"completed"}]}'
    fi
    ;;
  */runs/43/jobs*)
    if [[ "$TEST_CASE" == "producer-failed" ]]; then
      printf '{"jobs":[{"name":"%s","status":"completed","conclusion":"failure"}]}' "$TEST_PRODUCER_JOB"
    else
      printf '{"jobs":[{"name":"%s","status":"completed","conclusion":"skipped"}]}' "$TEST_PRODUCER_JOB"
    fi
    ;;
  */runs/42/jobs*)
    printf '{"jobs":[{"name":"%s","status":"completed","conclusion":"success"}]}' "$TEST_PRODUCER_JOB"
    ;;
  */runs/7/artifacts*|*/runs/42/artifacts*)
    if [[ "$TEST_CASE" == "missing" ]]; then
      printf '{"artifacts":[]}'
    elif [[ "$TEST_CASE" == "duplicate" ]]; then
      printf '{"artifacts":[{"id":201,"name":"%s"},{"id":202,"name":"%s"}]}' "$TEST_ARTIFACT_NAME" "$TEST_ARTIFACT_NAME"
    else
      printf '{"artifacts":[{"id":200,"name":"%s","expired":true},{"id":201,"name":"%s","expired":false}]}' "$TEST_ARTIFACT_NAME" "$TEST_ARTIFACT_NAME"
    fi
    ;;
  */artifacts/201/zip)
    while (($#)); do
      if [[ "$1" == "--output" ]]; then
        cp "$TEST_TEMP_DIR/artifact.zip" "$2"
        exit 0
      fi
      shift
    done
    exit 1
    ;;
  *) echo "Unexpected request: $url" >&2; exit 1 ;;
esac
EOF
chmod 0755 "$temp_dir/bin/curl"

export PATH="$temp_dir/bin:$PATH"
export TEST_TEMP_DIR="$temp_dir"
export GITHUB_REPOSITORY=example/repo GITHUB_RUN_ID=7 GITHUB_TOKEN=test-token
export GITHUB_EVENT_NAME=pull_request ACTIONS_ARTIFACT_WAIT_SECONDS=0

for artifact_spec in executor-e2e-binary:wegent-executor backend-rs-e2e-runtime:wegent-backend-rs; do
  export TEST_ARTIFACT_NAME="${artifact_spec%:*}"
  binary="${artifact_spec#*:}"
  if [[ "$TEST_ARTIFACT_NAME" == executor-e2e-binary ]]; then
    export TEST_PRODUCER_JOB="Prepare Executor E2E Runtime"
  else
    export TEST_PRODUCER_JOB="Build Backend Rust E2E Runtime"
  fi
  destination="$temp_dir/$TEST_ARTIFACT_NAME"
  unset ACTIONS_ARTIFACT_WORKFLOW ACTIONS_ARTIFACT_HEAD_SHA
  rm -f "$temp_dir/producer-seen" "$temp_dir/requests"

  export TEST_CASE=success
  "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$destination/current-run"
  cmp "$temp_dir/fixture/$binary" "$destination/current-run/$binary"

  export ACTIONS_ARTIFACT_WORKFLOW=e2e-tests.yml ACTIONS_ARTIFACT_HEAD_SHA=target
  "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$destination/source-run"
  cmp "$temp_dir/fixture/$binary" "$destination/source-run/$binary"
  grep -Fq '/runs/42/artifacts' "$temp_dir/requests"
  if grep -Eq '/runs/(99|100)/artifacts' "$temp_dir/requests"; then
    echo 'Downloader selected a different commit or event' >&2
    exit 1
  fi

  TEST_CASE=queued ACTIONS_ARTIFACT_WAIT_SECONDS=5 \
    "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$destination/queued-run" \
      2> "$temp_dir/timing"
  cmp "$temp_dir/fixture/$binary" "$destination/queued-run/$binary"
  grep -Eq 'phase=discovery-wait seconds=[0-9]+ polls=2$' "$temp_dir/timing"
  grep -Eq 'phase=transfer-unpack seconds=[0-9]+$' "$temp_dir/timing"
  if grep -Fq "$GITHUB_TOKEN" "$temp_dir/timing"; then
    echo 'Artifact timing logs must not include credentials' >&2
    exit 1
  fi

  TEST_CASE=producer-skipped ACTIONS_ARTIFACT_JOB="$TEST_PRODUCER_JOB" \
    "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$destination/eligible-run"
  cmp "$temp_dir/fixture/$binary" "$destination/eligible-run/$binary"
  if TEST_CASE=producer-failed ACTIONS_ARTIFACT_JOB="$TEST_PRODUCER_JOB" \
    "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$destination/failed-producer" >"$temp_dir/error" 2>&1; then
    echo 'Downloader unexpectedly masked a failed producer' >&2
    exit 1
  fi
  test ! -e "$destination/failed-producer/$binary"
  grep -Fq 'ended with failure' "$temp_dir/error"

  for failure_case in wrong-sha missing duplicate; do
    export TEST_CASE="$failure_case"
    if "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$destination/rejected" >"$temp_dir/error" 2>&1; then
      echo "Downloader unexpectedly accepted $failure_case" >&2
      exit 1
    fi
    test ! -e "$destination/rejected/$binary"
    case "$failure_case" in
      wrong-sha) grep -Fq 'was not available' "$temp_dir/error" ;;
      missing) grep -Fq 'completed without artifact' "$temp_dir/error" ;;
      duplicate) grep -Fq 'Expected at most one active artifact' "$temp_dir/error" ;;
    esac
  done

  if ACTIONS_ARTIFACT_HEAD_SHA='' "$script_dir/download-actions-artifact.sh" \
    "$TEST_ARTIFACT_NAME" "$destination/rejected" >"$temp_dir/error" 2>&1; then
    echo 'Downloader unexpectedly accepted a missing commit SHA' >&2
    exit 1
  fi
  grep -Fq 'ACTIONS_ARTIFACT_HEAD_SHA is required' "$temp_dir/error"
done

unset ACTIONS_ARTIFACT_WORKFLOW
export TEST_ARTIFACT_NAME=frontend-next-build
export TEST_PRODUCER_JOB='Build Frontend E2E Artifact'
export ACTIONS_ARTIFACT_JOB="$TEST_PRODUCER_JOB" ACTIONS_ARTIFACT_HEAD_SHA=target
rm -f "$temp_dir/requests" "$temp_dir/current-producer-seen"
TEST_CASE=current-pending ACTIONS_ARTIFACT_WAIT_SECONDS=5 \
  "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$temp_dir/current-frontend" \
  2> "$temp_dir/current-timing"
cmp "$temp_dir/fixture/wegent-executor" "$temp_dir/current-frontend/wegent-executor"
test "$(grep -Fc '/runs/7/jobs?' "$temp_dir/requests")" = 2
test "$(grep -Fc '/runs/7/artifacts?' "$temp_dir/requests")" = 1
grep -Eq 'phase=discovery-wait seconds=[0-9]+ polls=2$' "$temp_dir/current-timing"
grep -Fq 'phase=discovery-pending producer=Build Frontend E2E Artifact state=in_progress ready=false' "$temp_dir/current-timing"

TEST_CASE=current-cached \
  "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$temp_dir/fresh-frontend"
cmp "$temp_dir/fixture/wegent-executor" "$temp_dir/fresh-frontend/wegent-executor"

TEST_CASE=current-terminal-success \
  "$script_dir/download-actions-artifact.sh" "$TEST_ARTIFACT_NAME" "$temp_dir/terminal-frontend"
cmp "$temp_dir/fixture/wegent-executor" "$temp_dir/terminal-frontend/wegent-executor"

for failure_case in current-wrong-sha current-wrong-event \
  current-terminal-failed \
  current-producer-failure current-producer-cancelled current-producer-timed_out \
  current-producer-skipped current-producer-neutral; do
  rm -f "$temp_dir/requests"
  if TEST_CASE="$failure_case" "$script_dir/download-actions-artifact.sh" \
    "$TEST_ARTIFACT_NAME" "$temp_dir/$failure_case" >"$temp_dir/error" 2>&1; then
    echo "Current-run downloader unexpectedly accepted $failure_case" >&2
    exit 1
  fi
  test ! -e "$temp_dir/$failure_case/wegent-executor"
  if grep -Fq '/artifacts/201/zip' "$temp_dir/requests"; then
    echo 'A failed or mismatched frontend producer must not be consumed' >&2
    exit 1
  fi
done

printf 'Actions artifact downloader tests passed\n'
