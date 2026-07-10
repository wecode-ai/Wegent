#!/usr/bin/env bash

# Cargo build caches for local worktrees.
#
# Cargo target directories contain path-sensitive fingerprints and unhashed
# binaries. Keep them isolated per worktree, while sccache (when installed)
# shares compiler outputs safely across worktrees.

wegent_cargo_cache_root() {
  if [ -n "${WEGENT_CARGO_TARGET_ROOT:-}" ]; then
    printf '%s\n' "${WEGENT_CARGO_TARGET_ROOT%/}"
  elif [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s\n' "${XDG_CACHE_HOME%/}/wegent/cargo-target"
  elif [ -n "${HOME:-}" ]; then
    printf '%s\n' "$HOME/.cache/wegent/cargo-target"
  fi
}

wegent_worktree_cache_key() {
  local project_dir="$1"
  local canonical_dir=""
  local directory_name=""
  local checksum=""

  canonical_dir="$(cd "$project_dir" 2>/dev/null && pwd -P)" || return 1
  directory_name="$(basename "$canonical_dir" | tr -c '[:alnum:]._-\n' '_')"
  checksum="$(printf '%s' "$canonical_dir" | cksum | awk '{print $1}')"
  printf '%s-%s\n' "$directory_name" "$checksum"
}

configure_wegent_sccache() {
  if [ "${WEGENT_DISABLE_SCCACHE:-0}" = "1" ] || [ -n "${RUSTC_WRAPPER:-}" ]; then
    return 0
  fi

  if command -v sccache >/dev/null 2>&1; then
    RUSTC_WRAPPER="$(command -v sccache)"
    export RUSTC_WRAPPER
    export CARGO_INCREMENTAL=0
    export WEGENT_SCCACHE_AUTO=1
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

  configure_wegent_sccache

  if [ "${WEGENT_DISABLE_SHARED_CARGO_TARGET:-0}" = "1" ]; then
    return 0
  fi

  if [ -n "${CARGO_TARGET_DIR:-}" ]; then
    return 0
  fi

  local cache_root=""
  local worktree_key=""
  cache_root="$(wegent_cargo_cache_root)"
  [ -n "$cache_root" ] || return 0
  worktree_key="$(wegent_worktree_cache_key "$project_dir")" || return 0

  export CARGO_TARGET_DIR="$cache_root/$cache_name/worktrees/$worktree_key"
  export WEGENT_CARGO_TARGET_DIR_AUTO=1
  mkdir -p "$CARGO_TARGET_DIR"
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
