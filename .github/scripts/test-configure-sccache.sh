#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

ruby -ryaml -e '
  action = YAML.load_file(ARGV.fetch(0))
  install = action.fetch("runs").fetch("steps").find { |step|
    step["name"] == "Install sccache"
  }
  unless install.fetch("env", {})["SCCACHE_IDLE_TIMEOUT"] == "0"
    abort "The installer must start its daemon without idle expiry"
  end
  puts action.fetch("runs").fetch("steps").find { |step|
    step["name"] == "Configure Rust compiler cache"
  }.fetch("run")
' "$script_dir/../actions/setup-sccache/action.yml" > "$test_dir/configure.template"

mkdir "$test_dir/bin"
cat > "$test_dir/bin/sccache" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$SCCACHE_GHA_ENABLED" == true ]]
[[ "$SCCACHE_BASEDIRS" == '/test/workspace' ]]
[[ "$SCCACHE_GHA_VERSION" == 'wegent-sccache-v1-Linux-X64' ]]
[[ "${SCCACHE_IDLE_TIMEOUT-unset}" == 0 ]]
printf '%s:%s\n' "$*" "${SCCACHE_GHA_RW_MODE-unset}" >> "$SCCACHE_TEST_CALLS"
case "$*" in
  --show-stats) exit 0 ;;
  'rustc -vV')
    if [[ "$SCCACHE_TEST_EXIT" != 0 ]]; then
      echo "cache-server-sensitive-detail ?sig=synthetic-cache-token" >&2
    fi
    exit "$SCCACHE_TEST_EXIT"
    ;;
  *) exit 99 ;;
esac
SH
chmod +x "$test_dir/bin/sccache"

run_case() {
  local name="$1" startup_exit="$2" save_cache="$3" ref="$4" expected_mode="$5"
  sed 's/${{ inputs.save-cache }}/'"$save_cache"'/g' \
    "$test_dir/configure.template" > "$test_dir/configure.sh"
  : > "$test_dir/$name.env"
  env -u RUSTC_WRAPPER -u SCCACHE_GHA_RW_MODE -u SCCACHE_IDLE_TIMEOUT \
    PATH="$test_dir/bin:$PATH" \
    GITHUB_WORKSPACE=/test/workspace GITHUB_REF="$ref" \
    RUNNER_OS=Linux RUNNER_ARCH=X64 GITHUB_ENV="$test_dir/$name.env" \
    SCCACHE_TEST_EXIT="$startup_exit" SCCACHE_TEST_CALLS="$test_dir/$name.calls" \
    bash "$test_dir/configure.sh" > "$test_dir/$name.log" 2>&1
  [[ "$(cat "$test_dir/$name.calls")" == "rustc -vV:$expected_mode" ]]
  if [[ "$startup_exit" == 0 ]]; then
    grep -Fxq 'RUSTC_WRAPPER=sccache' "$test_dir/$name.env"
    grep -Fxq 'SCCACHE_GHA_ENABLED=true' "$test_dir/$name.env"
    grep -Fxq 'SCCACHE_BASEDIRS=/test/workspace' "$test_dir/$name.env"
    grep -Fxq 'SCCACHE_IDLE_TIMEOUT=0' "$test_dir/$name.env"
    if [[ "$expected_mode" == READ_ONLY ]]; then
      grep -Fxq 'SCCACHE_GHA_RW_MODE=READ_ONLY' "$test_dir/$name.env"
    else
      ! grep -q '^SCCACHE_GHA_RW_MODE=' "$test_dir/$name.env"
    fi
  else
    if [[ -s "$test_dir/$name.env" ]]; then
      printf 'Unavailable cache server must not enable a Rust compiler wrapper\n' >&2
      return 1
    fi
    ! grep -Fq 'cache-server-sensitive-detail' "$test_dir/$name.log"
    grep -Fq 'continuing without Rust compiler caching' "$test_dir/$name.log"
  fi
  ! grep -Fq 'synthetic-cache-token' "$test_dir/$name.log"
}

run_case startup-failure 2 false refs/pull/4053/merge READ_ONLY
run_case pull-request 0 false refs/pull/4053/merge READ_ONLY
run_case main 0 false refs/heads/main unset
run_case warmup 0 true refs/heads/cache-warmup unset

printf 'sccache configuration tests passed\n'
