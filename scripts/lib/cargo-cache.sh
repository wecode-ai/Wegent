#!/usr/bin/env bash

# Cargo build directories for local worktrees.
#
# Cargo's timestamp fingerprints cannot distinguish older sources in another
# worktree. Isolate its mutable state and share compiled content through sccache.

wegent_cargo_cache_root() {
  if [ -n "${WEGENT_CARGO_TARGET_ROOT:-}" ]; then
    printf '%s\n' "${WEGENT_CARGO_TARGET_ROOT%/}"
  elif [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s\n' "${XDG_CACHE_HOME%/}/wegent/cargo-target"
  elif [ -n "${HOME:-}" ]; then
    printf '%s\n' "$HOME/.cache/wegent/cargo-target"
  fi
}

configure_wegent_sccache() {
  local project_dir="$1"
  local target_dir="$2"
  local canonical_project_dir=""

  if [ "${WEGENT_DISABLE_SCCACHE:-0}" = "1" ]; then
    return 0
  fi

  if [ -n "${RUSTC_WRAPPER:-}" ] && [ "${WEGENT_SCCACHE_AUTO:-0}" != "1" ]; then
    return 0
  fi

  if command -v sccache >/dev/null 2>&1; then
    canonical_project_dir="$(cd "$project_dir" 2>/dev/null && pwd -P)" || return 1
    RUSTC_WRAPPER="$(command -v sccache)"
    export RUSTC_WRAPPER
    export CARGO_INCREMENTAL=0
    export WEGENT_SCCACHE_AUTO=1
    if [ -z "${SCCACHE_BASEDIRS:-}" ] || [ "${WEGENT_SCCACHE_BASEDIRS_AUTO:-0}" = "1" ]; then
      export SCCACHE_BASEDIRS="$canonical_project_dir:$target_dir"
      export WEGENT_SCCACHE_BASEDIRS_AUTO=1
    fi
  fi
}

install_wegent_sccache_with_homebrew() {
  if [ "${WEGENT_DISABLE_SCCACHE:-0}" = "1" ] || command -v sccache >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v brew >/dev/null 2>&1; then
    echo "Error: sccache is required for shared Rust compilation caching." >&2
    echo "Install Homebrew or set WEGENT_DISABLE_SCCACHE=1 to continue without sccache." >&2
    return 1
  fi

  echo "sccache is not installed; installing it with Homebrew..."
  brew install sccache
}

configure_wegent_cargo_target_dir() {
  local project_dir="$1"
  local cache_name="$2"
  local canonical_project_dir=""
  local cache_root="${CARGO_TARGET_DIR:-}"
  local worktree_id=""

  canonical_project_dir="$(cd "$project_dir" 2>/dev/null && pwd -P)" || return 1

  if [ "${WEGENT_CARGO_TARGET_DIR_AUTO:-0}" = "1" ] \
    && [ "$cache_root" = "${WEGENT_CONFIGURED_CARGO_TARGET_DIR:-}" ]; then
    cache_root="${WEGENT_CARGO_TARGET_BASE:-}"
  fi

  if [ "${WEGENT_DISABLE_SHARED_CARGO_TARGET:-0}" = "1" ]; then
    CARGO_TARGET_DIR="$canonical_project_dir/target/$cache_name"
  else
    [ -n "$cache_root" ] || cache_root="$(wegent_cargo_cache_root)"
    [ -n "$cache_root" ] || cache_root="$canonical_project_dir/target"
    mkdir -p "$cache_root" || return 1
    cache_root="$(cd "$cache_root" && pwd -P)" || return 1
    worktree_id="$(printf '%s\n' "$canonical_project_dir" | git hash-object --stdin)" || return 1
    CARGO_TARGET_DIR="$cache_root/$cache_name/worktrees/$worktree_id"
  fi

  export CARGO_TARGET_DIR
  export WEGENT_CARGO_TARGET_DIR_AUTO=1
  export WEGENT_CARGO_TARGET_BASE="$cache_root"
  export WEGENT_CONFIGURED_CARGO_TARGET_DIR="$CARGO_TARGET_DIR"
  mkdir -p "$CARGO_TARGET_DIR" || return 1
  configure_wegent_sccache "$canonical_project_dir" "$CARGO_TARGET_DIR"
}

cargo_target_dir_for() {
  local manifest_dir="$1"

  if [ -n "${CARGO_TARGET_DIR:-}" ]; then
    case "$CARGO_TARGET_DIR" in
      /*) printf '%s\n' "$CARGO_TARGET_DIR" ;;
      *) printf '%s/%s\n' "$(pwd)" "$CARGO_TARGET_DIR" ;;
    esac
    return 0
  fi

  printf '%s/target\n' "$manifest_dir"
}

cargo_target_binary_path() {
  local manifest_dir="$1"
  local profile="$2"
  local binary="$3"

  printf '%s/%s/%s\n' "$(cargo_target_dir_for "$manifest_dir")" "$profile" "$binary"
}
