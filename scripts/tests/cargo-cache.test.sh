#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
# shellcheck source-path=SCRIPTDIR

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=../lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"

TEST_ROOT=""

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_worktree_target_isolation() {
  local root="$1"
  local first="$root/first/Wegent"
  local second="$root/second/Wegent"
  mkdir -p "$first" "$second"

  local first_target
  local second_target
  first_target="$(HOME="$root/home" WEGENT_CARGO_TARGET_ROOT="$root/cache" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    printf "%s" "$CARGO_TARGET_DIR"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$first")"
  second_target="$(HOME="$root/home" WEGENT_CARGO_TARGET_ROOT="$root/cache" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    printf "%s" "$CARGO_TARGET_DIR"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$second")"

  [ "$first_target" != "$second_target" ] || fail "worktrees share a target directory"
  [[ "$first_target" == "$root/cache/executor/worktrees/"* ]] || fail "unexpected target path"
}

test_explicit_target_is_preserved() {
  local root="$1"
  local actual
  actual="$(CARGO_TARGET_DIR="$root/explicit" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    printf "%s" "$CARGO_TARGET_DIR"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$PROJECT_DIR")"
  [ "$actual" = "$root/explicit" ] || fail "explicit CARGO_TARGET_DIR was replaced"
}

test_sccache_is_configured_when_available() {
  local root="$1"
  mkdir -p "$root/bin" "$root/project"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$root/bin/sccache"
  chmod +x "$root/bin/sccache"

  local actual
  local canonical_project
  canonical_project="$(cd "$root/project" && pwd -P)"
  actual="$(PATH="$root/bin:$PATH" HOME="$root/home" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    printf "%s|%s|%s|%s" "$RUSTC_WRAPPER" "$CARGO_INCREMENTAL" "$WEGENT_SCCACHE_AUTO" "$SCCACHE_BASEDIRS"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$root/project")"
  [ "$actual" = "$root/bin/sccache|0|1|$canonical_project:$root/home/.cache/wegent/cargo-target/executor/worktrees/project-$(printf '%s' "$canonical_project" | cksum | awk '{print $1}')" ] \
    || fail "sccache was not configured with normalized paths: $actual"
}

test_sccache_is_installed_with_homebrew() {
  local root="$1"
  mkdir -p "$root/brew-bin"
  cat > "$root/brew-bin/brew" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$BREW_CALL_LOG"
EOF
  chmod +x "$root/brew-bin/brew"

  BREW_CALL_LOG="$root/brew-call.log" PATH="$root/brew-bin:/usr/bin:/bin" \
    install_wegent_sccache_with_homebrew >/dev/null
  [ "$(cat "$root/brew-call.log")" = "install sccache" ] || fail "Homebrew was not invoked"
}

test_automatic_sccache_paths_follow_target_changes() {
  local root="$1"
  mkdir -p "$root/reconfigure-bin" "$root/reconfigure-project"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$root/reconfigure-bin/sccache"
  chmod +x "$root/reconfigure-bin/sccache"

  local actual
  actual="$(PATH="$root/reconfigure-bin:$PATH" HOME="$root/home" bash -c '
    source "$1"
    CARGO_TARGET_DIR="$3/first"
    configure_wegent_cargo_target_dir "$2" first
    CARGO_TARGET_DIR="$3/second"
    configure_wegent_cargo_target_dir "$2" second
    printf "%s" "$SCCACHE_BASEDIRS"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$root/reconfigure-project" "$root")"
  [[ "$actual" == *":$root/second" ]] || fail "automatic sccache paths were stale: $actual"
}

cleanup() {
  rm -rf "$TEST_ROOT"
}

main() {
  TEST_ROOT="$(mktemp -d)"
  trap cleanup EXIT
  test_worktree_target_isolation "$TEST_ROOT"
  test_explicit_target_is_preserved "$TEST_ROOT"
  test_sccache_is_configured_when_available "$TEST_ROOT"
  test_sccache_is_installed_with_homebrew "$TEST_ROOT"
  test_automatic_sccache_paths_follow_target_changes "$TEST_ROOT"
  echo "cargo-cache tests passed"
}

main "$@"
