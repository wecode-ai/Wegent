#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin"
ruby -ryaml -e '
  action = YAML.safe_load(File.read(ARGV[0]))
  step = action.fetch("runs").fetch("steps").find { |s| s["env"]&.key?("EXECUTOR_IMAGE") }
  source = step.fetch("env").fetch("BUILD_RUNTIMES_FROM_SOURCE")
  workflow = YAML.safe_load(File.read(ARGV[1]))
  publish = workflow.fetch("jobs").fetch("build-backend-rs-e2e-runtime").fetch("steps").find { |s| s["name"] == "Publish content-addressed Backend Rust E2E image" }.fetch("if")
  [["pull_request", "fork/Wegent", true, false],
   ["pull_request", "wecode-ai/Wegent", false, true],
   ["workflow_dispatch", "", false, true]].each do |event, head, expected_source, expected_publish|
    values = {"github.event_name" => event, "github.event.pull_request.head.repo.full_name" => head,
              "github.repository" => "wecode-ai/Wegent", "steps.image-check.outputs.exists" => "false"}
    evaluate = lambda do |expression|
      expression = expression.gsub(/\$\{\{|\}\}/, "")
      values.each { |key, value| expression = expression.gsub(key, value.inspect) }
      eval(expression)
    end
    raise "wrong runtime source for #{event}/#{head}" unless evaluate.call(source) == expected_source
    raise "wrong package publication for #{event}/#{head}" unless evaluate.call(publish) == expected_publish
  end
' "$script_dir/../actions/build-wework-core-e2e/action.yml" "$script_dir/../workflows/e2e-tests.yml"
ruby -ryaml -e '
  action = YAML.safe_load(File.read(ARGV[0]))
  step = action.fetch("runs").fetch("steps").find { |s| s["env"]&.key?("EXECUTOR_IMAGE") }
  puts "set -euo pipefail"
  puts step.fetch("run")
' "${RUNTIME_ACTION_FILE:-$script_dir/../actions/build-wework-core-e2e/action.yml}" > "$temp_dir/build.sh"

cat > "$temp_dir/bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test -z "${GITHUB_TOKEN:-}"
test ! -f "$DOCKER_CONFIG/config.json"
echo cargo >> "$TEST_LOG"
[[ "${FAIL_CARGO:-false}" != true ]] || exit 1
manifest=""
binary=""
while (($#)); do
  case "$1" in
    --manifest-path) manifest="$2"; shift ;;
    --bin) binary="$2"; shift ;;
  esac
  shift
done
sleep 0.2
mkdir -p "${manifest%/*}/target/release"
printf '#!/bin/sh\nexit 0\n' > "${manifest%/*}/target/release/$binary"
EOF
cat > "$temp_dir/bin/oras" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 2
test "$1" = logout
test "$2" = ghcr.io
echo logout >> "$TEST_LOG"
[[ "${FAIL_LOGOUT:-false}" != true ]] || exit 1
rm "$DOCKER_CONFIG/config.json"
EOF
cat > "$temp_dir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test -z "${GITHUB_TOKEN:-}"
echo package >> "$TEST_LOG"
if [[ "$BUILD_RUNTIMES_FROM_SOURCE" == true ]]; then
  test -x .ci-artifacts/wegent-executor
  test -x .ci-artifacts/wegent-backend-rs
fi
for ((i=0; i<50; i++)); do
  if [[ -x .ci-artifacts/wegent-executor ]]; then
    mkdir -p wework/electron/release/WeWork-linux-x64/resources/bin
    cp .ci-artifacts/wegent-executor wework/electron/release/WeWork-linux-x64/WeWork
    cp .ci-artifacts/wegent-executor wework/electron/release/WeWork-linux-x64/resources/bin/wegent-executor
    exit 0
  fi
  sleep 0.1
done
exit 1
EOF
chmod +x "$temp_dir/bin/"*

run_case() {
  local mode="$1" failure="$2" expected="$3"
  local logout_failure="${4:-false}"
  local repo="$temp_dir/repo-$mode-$failure-$logout_failure"
  mkdir -p "$repo/.github/scripts" "$repo/docker-config"
  printf '{"auths":{"ghcr.io":{"auth":"synthetic-credential"}}}\n' > "$repo/docker-config/config.json"
  touch "$repo/log"
  cat > "$repo/.github/scripts/restore-oci-runtime-binary.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_TOKEN:-}" = synthetic-read-token
test -f "$DOCKER_CONFIG/config.json"
echo oci >> "$TEST_LOG"
[[ "$BUILD_RUNTIMES_FROM_SOURCE" != true ]] || exit 1
mkdir -p "$(dirname "$3")"
printf '#!/bin/sh\nexit 0\n' > "$3"
chmod +x "$3"
EOF
  chmod +x "$repo/.github/scripts/restore-oci-runtime-binary.sh"
  local status=0
  (cd "$repo"; PATH="$temp_dir/bin:$PATH" TEST_LOG="$repo/log" \
    BUILD_RUNTIMES_FROM_SOURCE="$mode" FAIL_CARGO="$failure" \
    DOCKER_CONFIG="$repo/docker-config" FAIL_LOGOUT="$logout_failure" \
    GITHUB_TOKEN=synthetic-read-token EXECUTOR_IMAGE=executor \
    BACKEND_RS_IMAGE=backend bash "$temp_dir/build.sh") || status=$?
  if [[ "$expected" == success ]]; then
    test "$status" -eq 0
    test -x "$repo/.ci-artifacts/wegent-backend-rs"
  else
    test "$status" -ne 0
    if grep -q package "$repo/log"; then return 1; fi
  fi
  if [[ "$mode" == true ]]; then
    if grep -q oci "$repo/log"; then return 1; fi
    test "$(grep -c logout "$repo/log")" -eq 1
    if [[ "$logout_failure" == true ]]; then
      test -f "$repo/docker-config/config.json"
      if grep -q cargo "$repo/log"; then return 1; fi
    else
      test ! -f "$repo/docker-config/config.json"
      test "$(grep -c cargo "$repo/log")" -eq 2
    fi
  else
    if grep -q logout "$repo/log"; then return 1; fi
    if grep -q cargo "$repo/log"; then return 1; fi
    test "$(grep -c oci "$repo/log")" -eq 2
  fi
}

run_case true false success
run_case false false success
run_case true true failure
run_case true false failure true
echo 'Wework runtime source/OCI handoff tests passed'
