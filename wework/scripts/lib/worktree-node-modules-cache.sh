#!/usr/bin/env bash

# Reuse Wework's installed dependency tree between Git worktrees. pnpm's
# virtual store is moved once to a user-level cache; each worktree then keeps
# only its local links, whose relative workspace targets resolve to that
# worktree's source files.

wegent_wework_node_modules_cache_root() {
  if [ -n "${WEGENT_WEWORK_NODE_MODULES_CACHE_ROOT:-}" ]; then
    printf '%s\n' "${WEGENT_WEWORK_NODE_MODULES_CACHE_ROOT%/}/v2"
  elif [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s\n' "${XDG_CACHE_HOME%/}/wegent/wework-node-modules/v2"
  else
    printf '%s\n' "$HOME/.cache/wegent/wework-node-modules/v2"
  fi
}

wegent_wework_dependency_fingerprint() {
  local project_dir="$1"
  local manifests=(
    "package.json"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
    "packages/chat-core/package.json"
    "frontend/package.json"
    "wework/package.json"
  )
  local manifest

  {
    for manifest in "${manifests[@]}"; do
      printf '%s\0' "$manifest"
      shasum -a 256 "$project_dir/$manifest" | awk '{print $1}'
    done
  } | shasum -a 256 | awk '{print $1}'
}

wegent_wework_node_modules_ready() {
  local node_modules="$1"

  [ -f "$node_modules/vite/package.json" ] &&
    [ -f "$node_modules/@tauri-apps/cli/package.json" ] &&
    [ -f "$node_modules/dingtalk-workspace-cli/package.json" ]
}

wegent_wework_installed_tree_matches_lockfile() {
  local project_dir="$1"

  [ -f "$project_dir/node_modules/.pnpm/lock.yaml" ] &&
    cmp -s "$project_dir/pnpm-lock.yaml" "$project_dir/node_modules/.pnpm/lock.yaml"
}

wegent_wework_cache_entry_matches_fingerprint() {
  local cache_entry="$1"
  local fingerprint="$2"

  [ -f "$cache_entry/dependency-fingerprint" ] &&
    [ "$(cat "$cache_entry/dependency-fingerprint")" = "$fingerprint" ]
}

wegent_wework_cache_entry_ready() {
  local cache_entry="$1"
  local fingerprint="$2"
  local cached_virtual_store="$cache_entry/pnpm-virtual-store"

  [ -d "$cached_virtual_store" ] &&
    wegent_root_node_modules_view_ready "$cache_entry" &&
    wegent_virtual_store_root_links_ready "$cached_virtual_store" &&
    wegent_workspace_node_modules_views_ready "$cache_entry" &&
    wegent_wework_cache_entry_matches_fingerprint "$cache_entry" "$fingerprint"
}

wegent_acquire_wework_cache_lock() {
  local cache_lock="$1"
  local timeout_seconds="${WEGENT_WEWORK_NODE_MODULES_CACHE_LOCK_TIMEOUT_SECONDS:-600}"
  local deadline=$((SECONDS + timeout_seconds))

  while ! mkdir "$cache_lock" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.1
  done
}

wegent_validate_wework_cache_entry_under_lock() {
  local cache_entry="$1"
  local fingerprint="$2"
  local cache_lock="${cache_entry}.lock"
  local status

  if (
    trap 'rmdir "$cache_lock" 2>/dev/null || true' EXIT
    wegent_acquire_wework_cache_lock "$cache_lock" || exit 2
    wegent_wework_cache_entry_ready "$cache_entry" "$fingerprint" || exit 3
  ); then
    return 0
  else
    status=$?
  fi
  return "$status"
}

wegent_wework_node_modules_view_ready() {
  local node_modules="$1"

  [ -L "$node_modules/vite" ] &&
    [ -L "$node_modules/@tauri-apps/cli" ] &&
    [ -L "$node_modules/dingtalk-workspace-cli" ]
}

wegent_workspace_node_modules_views_ready() {
  local cache_entry="$1"

  wegent_wework_node_modules_view_ready "$cache_entry/wework-node_modules" &&
    [ -L "$cache_entry/frontend-node_modules/next" ] &&
    [ -L "$cache_entry/chat-core-node_modules/socket.io-client" ]
}

wegent_root_node_modules_view_ready() {
  local cache_entry="$1"

  [ -L "$cache_entry/.pnpm" ] &&
    [ -L "$cache_entry/vitest" ] &&
    [ -L "$cache_entry/typescript" ]
}

wegent_virtual_store_root_links_ready() {
  local virtual_store="$1"

  [ -L "$virtual_store/node_modules/vitest" ] &&
    [ -L "$virtual_store/node_modules/typescript" ]
}

wegent_clone_node_modules_view() {
  local source="$1"
  local destination="$2"
  local temporary="${destination}.$$"

  [ ! -e "$temporary" ] || return 1
  cp -cR "$source" "$temporary"
  rm -rf "$temporary/.vite" "$temporary/.vite-temp"
  mv "$temporary" "$destination"
}

wegent_cache_workspace_node_modules_views() {
  local project_dir="$1"
  local cache_entry="$2"

  if [ ! -d "$cache_entry/wework-node_modules" ]; then
    wegent_clone_node_modules_view "$project_dir/wework/node_modules" \
      "$cache_entry/wework-node_modules"
  fi
  if [ ! -d "$cache_entry/frontend-node_modules" ]; then
    wegent_clone_node_modules_view "$project_dir/frontend/node_modules" \
      "$cache_entry/frontend-node_modules"
  fi
  if [ ! -d "$cache_entry/chat-core-node_modules" ]; then
    wegent_clone_node_modules_view "$project_dir/packages/chat-core/node_modules" \
      "$cache_entry/chat-core-node_modules"
  fi
}

wegent_attach_workspace_node_modules_views() {
  local project_dir="$1"
  local cache_entry="$2"

  if [ ! -d "$project_dir/wework/node_modules" ]; then
    wegent_clone_node_modules_view "$cache_entry/wework-node_modules" \
      "$project_dir/wework/node_modules"
  fi
  if [ ! -d "$project_dir/frontend/node_modules" ]; then
    wegent_clone_node_modules_view "$cache_entry/frontend-node_modules" \
      "$project_dir/frontend/node_modules"
  fi
  if [ ! -d "$project_dir/packages/chat-core/node_modules" ]; then
    wegent_clone_node_modules_view "$cache_entry/chat-core-node_modules" \
      "$project_dir/packages/chat-core/node_modules"
  fi
}

wegent_clone_root_node_modules_view() {
  local source="$1"
  local cache_entry="$2"
  local entry

  ln -s "pnpm-virtual-store" "$cache_entry/.pnpm"
  for entry in "$source"/*; do
    [ -L "$entry" ] || continue
    cp -cR "$entry" "$cache_entry/$(basename "$entry")"
  done
}

wegent_link_root_dependencies_into_virtual_store() {
  local source="$1"
  local virtual_store="$2"
  local entry
  local link_target

  mkdir -p "$virtual_store/node_modules"
  for entry in "$source"/*; do
    [ -L "$entry" ] || continue
    link_target="$(readlink "$entry")"
    case "$link_target" in
      .pnpm/*)
        ln -s "../${link_target#.pnpm/}" "$virtual_store/node_modules/$(basename "$entry")"
        ;;
    esac
  done
}

ensure_wework_worktree_node_modules() {
  local project_dir="$1"
  local wework_dir="$2"
  local destination="$wework_dir/node_modules"
  local cache_root
  local fingerprint
  local cache_entry
  local cached_virtual_store
  local cache_lock

  if wegent_wework_node_modules_ready "$destination"; then
    cache_root="$(wegent_wework_node_modules_cache_root)"
    fingerprint="$(wegent_wework_dependency_fingerprint "$project_dir")"
    cache_entry="$cache_root/$fingerprint"
    cached_virtual_store="$cache_entry/pnpm-virtual-store"
    if ! wegent_wework_installed_tree_matches_lockfile "$project_dir"; then
      echo "Error: installed dependencies do not match pnpm-lock.yaml." >&2
      echo "Run 'pnpm install --frozen-lockfile' before publishing the worktree cache." >&2
      return 1
    fi
    if ! wegent_wework_cache_entry_ready "$cache_entry" "$fingerprint"; then
      mkdir -p "$cache_root"
      cache_lock="${cache_entry}.lock"
      if mkdir "$cache_lock" 2>/dev/null; then
        (
          trap 'rmdir "$cache_lock" 2>/dev/null || true' EXIT
          mkdir -p "$cache_entry"
          if [ ! -d "$cached_virtual_store" ]; then
            mv "$project_dir/node_modules/.pnpm" "$cached_virtual_store"
            ln -s "$cached_virtual_store" "$project_dir/node_modules/.pnpm"
          fi
          if ! wegent_root_node_modules_view_ready "$cache_entry"; then
            wegent_clone_root_node_modules_view "$project_dir/node_modules" "$cache_entry"
          fi
          if ! wegent_virtual_store_root_links_ready "$cached_virtual_store"; then
            wegent_link_root_dependencies_into_virtual_store \
              "$project_dir/node_modules" \
              "$cached_virtual_store"
          fi
          if ! wegent_workspace_node_modules_views_ready "$cache_entry"; then
            wegent_cache_workspace_node_modules_views "$project_dir" "$cache_entry"
          fi
          printf '%s\n' "$fingerprint" >"$cache_entry/dependency-fingerprint"
        )
      fi
    fi
    if wegent_workspace_node_modules_views_ready "$cache_entry"; then
      wegent_attach_workspace_node_modules_views "$project_dir" "$cache_entry"
    fi
    return
  fi

  cache_root="$(wegent_wework_node_modules_cache_root)"
  fingerprint="$(wegent_wework_dependency_fingerprint "$project_dir")"
  cache_entry="$cache_root/$fingerprint"
  cached_virtual_store="$cache_entry/pnpm-virtual-store"
  if wegent_validate_wework_cache_entry_under_lock "$cache_entry" "$fingerprint"; then
    :
  else
    case "$?" in
      2)
        echo "Error: timed out waiting for another worktree to publish the Wework dependency cache." >&2
        ;;
      *)
        echo "Error: Wework dependencies are not installed and no matching worktree cache exists." >&2
        echo "Run 'pnpm install --frozen-lockfile' once in any worktree with these dependencies." >&2
        ;;
    esac
    return 1
  fi

  mkdir -p "$project_dir/node_modules"
  for entry in "$cache_entry"/*; do
    [ -L "$entry" ] || continue
    cp -cR "$entry" "$project_dir/node_modules/$(basename "$entry")"
  done
  ln -s "$cached_virtual_store" "$project_dir/node_modules/.pnpm"
  wegent_attach_workspace_node_modules_views "$project_dir" "$cache_entry"
}
