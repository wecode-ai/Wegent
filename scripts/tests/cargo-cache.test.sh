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

test_worktrees_isolate_component_targets() {
  local root="$1"
  local first="$root/first/Wegent"
  local second="$root/second/Wegent"
  mkdir -p "$first" "$second"

  local first_target
  local second_target
  first_target="$(WEGENT_CARGO_TARGET_ROOT="$root/cache" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    printf "%s" "$CARGO_TARGET_DIR"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$first")"
  second_target="$(WEGENT_CARGO_TARGET_ROOT="$root/cache" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    printf "%s" "$CARGO_TARGET_DIR"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$second")"

  [ "$first_target" != "$second_target" ] || fail "worktrees share mutable Cargo state"
  [[ "$first_target" == "$root/cache/executor/worktrees/"* ]] || fail "unexpected target path: $first_target"
  [[ "$second_target" == "$root/cache/executor/worktrees/"* ]] || fail "unexpected target path: $second_target"
}

test_explicit_target_location_is_preserved() {
  local root="$1"
  local actual
  actual="$(CARGO_TARGET_DIR="$root/explicit" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    printf "%s" "$CARGO_TARGET_DIR"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$PROJECT_DIR")"
  [[ "$actual" == "$root/explicit/executor/worktrees/"* ]] || fail "explicit target root was replaced: $actual"
}

test_target_configuration_is_idempotent() {
  local root="$1"
  WEGENT_CARGO_TARGET_ROOT="$root/cache" bash -c '
    set -eu
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    first="$CARGO_TARGET_DIR"
    configure_wegent_cargo_target_dir "$2" executor
    [ "$CARGO_TARGET_DIR" = "$first" ]
    configure_wegent_cargo_target_dir "$2" executor-dev
    case "$CARGO_TARGET_DIR" in "$3/cache/executor-dev/worktrees/"*) ;; *) exit 1 ;; esac
    CARGO_TARGET_DIR="$3/another-root"
    configure_wegent_cargo_target_dir "$2" executor
    case "$CARGO_TARGET_DIR" in "$3/another-root/executor/worktrees/"*) ;; *) exit 1 ;; esac
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$PROJECT_DIR" "$root" \
    || fail "reconfiguration nested or retained a stale target directory"
}

test_symlinks_resolve_to_the_same_worktree() {
  local root="$1"
  ln -s "$PROJECT_DIR" "$root/project-link"
  local actual
  actual="$(WEGENT_CARGO_TARGET_ROOT="$root/cache" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    first="$CARGO_TARGET_DIR"
    configure_wegent_cargo_target_dir "$3" executor
    [ "$CARGO_TARGET_DIR" = "$first" ] && printf matched
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$PROJECT_DIR" "$root/project-link")"
  [ "$actual" = matched ] || fail "symlinks use a different Cargo target"
}

test_disabled_shared_target_is_worktree_local() {
  local root="$1"
  local actual
  mkdir -p "$root/local-project"
  actual="$(CARGO_TARGET_DIR="$root/shared" WEGENT_DISABLE_SHARED_CARGO_TARGET=1 bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor-dev
    printf "%s" "$CARGO_TARGET_DIR"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$root/local-project")"
  [ "$actual" = "$root/local-project/target/executor-dev" ] || fail "disabled shared target is not local: $actual"
}

test_sccache_is_configured_when_available() {
  local root="$1"
  mkdir -p "$root/bin" "$root/project"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$root/bin/sccache"
  chmod +x "$root/bin/sccache"

  local actual
  actual="$(PATH="$root/bin:$PATH" WEGENT_CARGO_TARGET_ROOT="$root/cache" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    [ "$SCCACHE_BASEDIRS" = "$2:$CARGO_TARGET_DIR" ] || exit 1
    printf "%s|%s|%s" "$RUSTC_WRAPPER" "$CARGO_INCREMENTAL" "$WEGENT_SCCACHE_AUTO"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$root/project")"
  [ "$actual" = "$root/bin/sccache|0|1" ] \
    || fail "sccache was not configured with normalized paths: $actual"
}

test_explicit_compiler_wrapper_is_preserved() {
  local root="$1"
  local actual
  actual="$(RUSTC_WRAPPER="$root/custom-wrapper" WEGENT_CARGO_TARGET_ROOT="$root/cache" bash -c '
    source "$1"
    configure_wegent_cargo_target_dir "$2" executor
    printf "%s" "$RUSTC_WRAPPER"
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$PROJECT_DIR")"
  [ "$actual" = "$root/custom-wrapper" ] || fail "explicit compiler wrapper was replaced"
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
  actual="$(PATH="$root/reconfigure-bin:$PATH" bash -c '
    source "$1"
    CARGO_TARGET_DIR="$3/first"
    configure_wegent_cargo_target_dir "$2" first
    CARGO_TARGET_DIR="$3/second"
    configure_wegent_cargo_target_dir "$2" second
    [ "$SCCACHE_BASEDIRS" = "$2:$CARGO_TARGET_DIR" ] && printf matched
  ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$root/reconfigure-project" "$root")"
  [ "$actual" = matched ] || fail "automatic sccache paths were stale: $actual"
}

test_older_worktree_sources_are_actually_compiled() {
  local root="$1"
  local first="$root/compile-first"
  local second="$root/compile-second"
  local project
  mkdir -p "$first/src" "$second/src"
  for project in "$first" "$second"; do
    printf '[package]\nname="cargo-cache-regression"\nversion="0.1.0"\nedition="2021"\n' > "$project/Cargo.toml"
  done
  printf 'fn main() { println!("first-worktree"); }\n' > "$first/src/main.rs"
  printf 'fn main() { println!("second-worktree"); }\n' > "$second/src/main.rs"
  touch -t 202001010000 "$second/src/main.rs"

  local mode
  local actual
  local target_base
  for mode in automatic explicit; do
    target_base=""
    [ "$mode" != explicit ] || target_base="$root/explicit-compile-cache"
    for project in "$first" "$second" "$first"; do
      actual="$(CARGO_TARGET_DIR="$target_base" WEGENT_CARGO_TARGET_ROOT="$root/compile-cache" \
        WEGENT_DISABLE_SCCACHE=1 RUSTC_WRAPPER='' bash -c '
          set -eu
          source "$1"
          configure_wegent_cargo_target_dir "$2" executor
          cargo build --quiet --manifest-path "$2/Cargo.toml"
          "$CARGO_TARGET_DIR/debug/cargo-cache-regression"
        ' _ "$PROJECT_DIR/scripts/lib/cargo-cache.sh" "$project")"
      if [ "$project" = "$first" ]; then
        [ "$actual" = first-worktree ] || fail "$mode: first worktree reused another source tree: $actual"
      else
        [ "$actual" = second-worktree ] || fail "$mode: older sources reused stale build artifacts: $actual"
      fi
    done
  done
}

cleanup() {
  rm -rf "$TEST_ROOT"
}

main() {
  unset CARGO_TARGET_DIR RUSTC_WRAPPER CARGO_INCREMENTAL SCCACHE_BASEDIRS
  unset WEGENT_CARGO_TARGET_DIR_AUTO WEGENT_CARGO_TARGET_BASE WEGENT_CONFIGURED_CARGO_TARGET_DIR
  unset WEGENT_DISABLE_SHARED_CARGO_TARGET WEGENT_DISABLE_SCCACHE
  unset WEGENT_SCCACHE_AUTO WEGENT_SCCACHE_BASEDIRS_AUTO
  TEST_ROOT="$(mktemp -d)"
  TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
  trap cleanup EXIT
  test_worktrees_isolate_component_targets "$TEST_ROOT"
  test_explicit_target_location_is_preserved "$TEST_ROOT"
  test_target_configuration_is_idempotent "$TEST_ROOT"
  test_symlinks_resolve_to_the_same_worktree "$TEST_ROOT"
  test_disabled_shared_target_is_worktree_local "$TEST_ROOT"
  test_sccache_is_configured_when_available "$TEST_ROOT"
  test_explicit_compiler_wrapper_is_preserved "$TEST_ROOT"
  test_sccache_is_installed_with_homebrew "$TEST_ROOT"
  test_automatic_sccache_paths_follow_target_changes "$TEST_ROOT"
  test_older_worktree_sources_are_actually_compiled "$TEST_ROOT"
  echo "cargo-cache tests passed"
}

main "$@"
