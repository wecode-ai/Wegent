#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "$temp_dir/bin" "$temp_dir/fixture"
printf 'executor binary\n' >"$temp_dir/fixture/wegent-executor"
(cd "$temp_dir/fixture" && zip -q "$temp_dir/artifact.zip" wegent-executor)

cat >"$temp_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${@: -1}"
printf '%s\n' "$url" >>"$TEST_TEMP_DIR/requests"
case "$url" in
  */workflows/e2e-tests.yml/runs*)
    if [[ "$TEST_CASE" == "queued" && ! -f "$TEST_TEMP_DIR/producer-seen" ]]; then
      touch "$TEST_TEMP_DIR/producer-seen"
      printf '{"workflow_runs":[]}'
    elif [[ "$TEST_CASE" == "wrong-sha" ]]; then
      printf '{"workflow_runs":[{"id":99,"head_sha":"wrong","event":"pull_request","status":"completed"}]}'
    else
      printf '{"workflow_runs":[{"id":99,"head_sha":"wrong","event":"pull_request","status":"completed"},{"id":42,"head_sha":"target","event":"pull_request","status":"completed"},{"id":100,"head_sha":"target","event":"push","status":"completed"}]}'
    fi
    ;;
  */runs/7/artifacts*|*/runs/42/artifacts*)
    if [[ "$TEST_CASE" == "missing" ]]; then
      printf '{"artifacts":[]}'
    elif [[ "$TEST_CASE" == "duplicate" ]]; then
      printf '{"artifacts":[{"id":201,"name":"executor-e2e-binary"},{"id":202,"name":"executor-e2e-binary"}]}'
    else
      printf '{"artifacts":[{"id":200,"name":"executor-e2e-binary","expired":true},{"id":201,"name":"executor-e2e-binary","expired":false}]}'
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

export TEST_CASE=success
"$script_dir/download-actions-artifact.sh" executor-e2e-binary "$temp_dir/current-run"
cmp "$temp_dir/fixture/wegent-executor" "$temp_dir/current-run/wegent-executor"

export ACTIONS_ARTIFACT_WORKFLOW=e2e-tests.yml ACTIONS_ARTIFACT_HEAD_SHA=target
"$script_dir/download-actions-artifact.sh" executor-e2e-binary "$temp_dir/source-run"
cmp "$temp_dir/fixture/wegent-executor" "$temp_dir/source-run/wegent-executor"
grep -Fq '/runs/42/artifacts' "$temp_dir/requests"
if grep -Eq '/runs/(99|100)/artifacts' "$temp_dir/requests"; then
  echo 'Downloader selected a different commit or event' >&2
  exit 1
fi

TEST_CASE=queued ACTIONS_ARTIFACT_WAIT_SECONDS=5 \
  "$script_dir/download-actions-artifact.sh" executor-e2e-binary "$temp_dir/queued-run"
cmp "$temp_dir/fixture/wegent-executor" "$temp_dir/queued-run/wegent-executor"

for failure_case in wrong-sha missing duplicate; do
  export TEST_CASE="$failure_case"
  if "$script_dir/download-actions-artifact.sh" executor-e2e-binary "$temp_dir/rejected" >"$temp_dir/error" 2>&1; then
    echo "Downloader unexpectedly accepted $failure_case" >&2
    exit 1
  fi
  test ! -e "$temp_dir/rejected/wegent-executor"
  case "$failure_case" in
    wrong-sha) grep -Fq 'was not available' "$temp_dir/error" ;;
    missing) grep -Fq 'completed without artifact' "$temp_dir/error" ;;
    duplicate) grep -Fq 'Expected at most one active artifact' "$temp_dir/error" ;;
  esac
done

if ACTIONS_ARTIFACT_HEAD_SHA='' "$script_dir/download-actions-artifact.sh" \
  executor-e2e-binary "$temp_dir/rejected" >"$temp_dir/error" 2>&1; then
  echo 'Downloader unexpectedly accepted a missing commit SHA' >&2
  exit 1
fi
grep -Fq 'ACTIONS_ARTIFACT_HEAD_SHA is required' "$temp_dir/error"

printf 'Actions artifact downloader tests passed\n'
