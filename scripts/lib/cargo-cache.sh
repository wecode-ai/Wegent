#!/usr/bin/env bash

# Shared Cargo target directories for local Codex worktrees.
#
# Normal clones keep Cargo's default per-worktree target directory. Codex
# worktrees use a stable target root under ~/.codex so dependency artifacts can
# be reused across branches without committing machine-specific Cargo config.

configure_wegent_cargo_target_dir() {
  local project_dir="$1"
  local cache_name="$2"

  if [ "${WEGENT_DISABLE_SHARED_CARGO_TARGET:-0}" = "1" ]; then
    return 0
  fi

  if [ -n "${CARGO_TARGET_DIR:-}" ]; then
    return 0
  fi

  local cache_root=""
  if [ -n "${WEGENT_CARGO_TARGET_ROOT:-}" ]; then
    cache_root="${WEGENT_CARGO_TARGET_ROOT%/}"
  elif [ -n "${HOME:-}" ] && [[ "$project_dir" == "$HOME/.codex/worktrees/"*"/Wegent" ]]; then
    cache_root="$HOME/.codex/cache/wegent/cargo-target"
  else
    return 0
  fi

  export CARGO_TARGET_DIR="$cache_root/$cache_name"
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
