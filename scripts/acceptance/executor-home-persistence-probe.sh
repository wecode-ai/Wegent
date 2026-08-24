#!/usr/bin/env bash
set -euo pipefail

fail() {
    echo "Executor Home persistence acceptance failed: $*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage:
  executor-home-persistence-probe.sh seed
  executor-home-persistence-probe.sh verify
  executor-home-persistence-probe.sh cleanup

Required environment:
  WEGENT_EXECUTOR_HOME
  LOCAL_WORKSPACE_ROOT
  WEGENT_EXECUTOR_HOME_ID
  WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true
  WEGENT_ACCEPTANCE_INSTANCE_ID
  WEGENT_ACCEPTANCE_VOLUME_ID

Optional environment:
  WEGENT_ACCEPTANCE_PROBE_ID
  WEGENT_ACCEPTANCE_EXECUTOR_BIN
EOF
}

read_state() {
    local name="$1"
    local path="$STATE_DIR/$name"
    [ -f "$path" ] || fail "missing persisted probe state: $path"
    cat "$path"
}

require_absolute_directory() {
    local name="$1"
    local value="$2"
    case "$value" in
        /*) ;;
        *) fail "$name must be an absolute path" ;;
    esac
    [ -d "$value" ] || fail "$name does not exist: $value"

    local physical
    physical="$(cd "$value" && pwd -P)"
    [ "$physical" = "${value%/}" ] || fail "$name must not resolve through a symlink"
}

require_device_identity() {
    local identity_file="$EXECUTOR_HOME/.executor-home-id"
    [ -f "$identity_file" ] || fail "missing Executor Home identity file"

    local persisted_device_id
    persisted_device_id="$(cat "$identity_file")"
    [ "$persisted_device_id" = "$DEVICE_ID" ] || {
        fail "Executor Home identity does not match WEGENT_EXECUTOR_HOME_ID"
    }
}

read_device_config_field() {
    local field="$1"
    local config_path="$EXECUTOR_HOME/device-config.json"
    [ -f "$config_path" ] || fail "missing persisted device config: $config_path"
    command -v python3 >/dev/null 2>&1 || {
        fail "python3 is required to inspect persisted device config"
    }
    python3 "$JSON_HELPER" read-config "$config_path" "$field"
}

run_executor_rpc() {
    local method="$1"
    local params_json="$2"
    command -v python3 >/dev/null 2>&1 || {
        fail "python3 is required to exercise the Executor Worktree RPC"
    }
    [ -x "$EXECUTOR_BIN" ] || fail "Executor binary is not executable: $EXECUTOR_BIN"
    local script_dir="${0%/*}"
    [ "$script_dir" != "$0" ] || script_dir="."
    python3 \
        "$script_dir/executor-rpc-probe.py" \
        "$EXECUTOR_BIN" \
        "$DEVICE_ID" \
        "$method" \
        "$params_json"
}

assert_worktree_capability() {
    local capability
    capability="$(run_executor_rpc "runtime.worktrees.capabilities" '{}')" || {
        fail "Executor Worktree capability RPC failed"
    }
    # The JSON helper requires runtimeWorktrees.persistentStorageVerified=true.
    python3 "$JSON_HELPER" assert-capability "$capability" "$DEVICE_ID"
}

prepare_worktree_via_executor() {
    local response
    response="$(
        run_executor_rpc \
            "runtime.worktrees.prepare" \
            "$(python3 "$JSON_HELPER" prepare-params "$SOURCE_REPO" "$WORKTREE_ID")"
    )" || fail "Executor failed to prepare the acceptance Worktree"
    local prepared_path
    prepared_path="$(python3 "$JSON_HELPER" prepared-path "$response")"
    [ "$prepared_path" = "$WORKTREE_PATH" ] || {
        fail "Executor prepared an unexpected Worktree path: $prepared_path"
    }
}

assert_worktree_listed() {
    local response
    response="$(run_executor_rpc "runtime.worktrees.list" '{}')" || {
        fail "Executor failed to list persisted Worktrees"
    }
    python3 \
        "$JSON_HELPER" \
        assert-listed \
        "$response" \
        "$DEVICE_ID" \
        "$WORKTREE_ID" \
        "$WORKTREE_PATH"
}

assert_worktree_absent() {
    [ ! -e "$WORKTREE_PATH" ] || {
        fail "Executor delete left the acceptance Worktree path behind"
    }
    local response
    response="$(run_executor_rpc "runtime.worktrees.list" '{}')" || {
        fail "Executor failed to list Worktrees after deletion"
    }
    python3 "$JSON_HELPER" assert-absent "$response" "$WORKTREE_ID" "$WORKTREE_PATH"
}

delete_worktree_via_executor() {
    run_executor_rpc \
        "runtime.worktrees.delete" \
        "$(python3 "$JSON_HELPER" delete-params "$WORKTREE_PATH")" \
        >/dev/null || fail "Executor failed to delete the acceptance Worktree"
}

write_state() {
    local name="$1"
    local value="$2"
    printf '%s' "$value" >"$STATE_DIR/$name"
}

seed_probe() {
    require_device_identity
    assert_worktree_capability
    [ ! -e "$STATE_DIR" ] || fail "probe state already exists: $STATE_DIR"
    [ ! -e "$SOURCE_REPO" ] || fail "probe source repository already exists"
    [ ! -e "$WORKTREE_PATH" ] || fail "probe Worktree already exists"
    [ ! -e "$RUNTIME_MARKER" ] || fail "probe Runtime marker already exists"

    mkdir -p \
        "$STATE_DIR" \
        "$(dirname "$SOURCE_REPO")" \
        "$(dirname "$WORKTREE_PATH")" \
        "$(dirname "$RUNTIME_MARKER")"

    git init -q "$SOURCE_REPO"
    git -C "$SOURCE_REPO" config user.email "acceptance@wegent.invalid"
    git -C "$SOURCE_REPO" config user.name "Wegent Acceptance"
    printf '%s\n' "$PROBE_ID" >"$SOURCE_REPO/README.acceptance"
    git -C "$SOURCE_REPO" add README.acceptance
    git -C "$SOURCE_REPO" commit -qm "test: seed executor home acceptance"
    prepare_worktree_via_executor
    assert_worktree_listed

    printf '%s\n' "$PROBE_ID" >"$WORKTREE_PATH/.wegent-acceptance-marker"
    printf \
        '{"probeId":"%s","deviceId":"%s","status":"interrupted"}\n' \
        "$PROBE_ID" \
        "$DEVICE_ID" \
        >"$RUNTIME_MARKER"

    write_state device-id "$DEVICE_ID"
    write_state executor-home "$EXECUTOR_HOME"
    write_state workspace-root "$WORKSPACE_ROOT"
    write_state source-repo "$SOURCE_REPO"
    write_state worktree-path "$WORKTREE_PATH"
    write_state runtime-marker "$RUNTIME_MARKER"
    write_state git-head "$(git -C "$SOURCE_REPO" rev-parse HEAD)"
    write_state git-common-dir "$(
        git -C "$WORKTREE_PATH" \
            rev-parse --path-format=absolute --git-common-dir
    )"
    write_state seed-instance-id "$INSTANCE_ID"
    write_state volume-id "$VOLUME_ID"
    write_state runtime-instance-id "$(read_device_config_field runtime_instance_id)"

    echo "ACCEPTANCE_PHASE=seed"
    echo "ACCEPTANCE_RESULT=passed"
    echo "ACCEPTANCE_PROBE_ID=$PROBE_ID"
}

verify_probe() {
    require_device_identity
    assert_worktree_capability
    [ -d "$STATE_DIR" ] || fail "persisted probe state is missing"

    [ "$(read_state device-id)" = "$DEVICE_ID" ] || {
        fail "logical device identity changed after instance replacement"
    }
    [ "$(read_state executor-home)" = "$EXECUTOR_HOME" ] || {
        fail "WEGENT_EXECUTOR_HOME absolute path changed after instance replacement"
    }
    [ "$(read_state workspace-root)" = "$WORKSPACE_ROOT" ] || {
        fail "LOCAL_WORKSPACE_ROOT absolute path changed after instance replacement"
    }
    [ "$(read_state volume-id)" = "$VOLUME_ID" ] || {
        fail "persistent volume identity changed after instance replacement"
    }
    [ "$(read_state runtime-instance-id)" = \
        "$(read_device_config_field runtime_instance_id)" ] || {
        fail "Runtime instance ID changed after instance replacement"
    }
    [ "$(read_device_config_field device_id)" = "$DEVICE_ID" ] || {
        fail "persisted device config belongs to a different logical device"
    }

    local seed_instance_id
    seed_instance_id="$(read_state seed-instance-id)"
    [ "$seed_instance_id" != "$INSTANCE_ID" ] || {
        fail "verification must run on a replacement instance with a different instance ID"
    }

    local persisted_source
    local persisted_worktree
    local persisted_runtime_marker
    local persisted_head
    persisted_source="$(read_state source-repo)"
    persisted_worktree="$(read_state worktree-path)"
    persisted_runtime_marker="$(read_state runtime-marker)"
    persisted_head="$(read_state git-head)"

    [ "$persisted_source" = "$SOURCE_REPO" ] || fail "source repository path changed"
    [ "$persisted_worktree" = "$WORKTREE_PATH" ] || fail "Worktree path changed"
    [ "$persisted_runtime_marker" = "$RUNTIME_MARKER" ] || {
        fail "Runtime state path changed"
    }
    [ -d "$SOURCE_REPO/.git" ] || fail "source Git repository was not retained"
    [ -d "$WORKTREE_PATH" ] || fail "Worktree directory was not retained"
    [ -f "$WORKTREE_PATH/.git" ] || fail "Worktree .git file was not retained"
    [ ! -L "$WORKTREE_PATH/.git" ] || fail "Worktree .git file became a symlink"
    [ -f "$RUNTIME_MARKER" ] || fail "Runtime state was not retained"
    [ -f "$WORKTREE_PATH/.wegent-acceptance-marker" ] || {
        fail "Worktree contents were not retained"
    }
    [ "$(cat "$WORKTREE_PATH/.wegent-acceptance-marker")" = "$PROBE_ID" ] || {
        fail "Worktree marker changed"
    }
    [ "$(git -C "$SOURCE_REPO" rev-parse HEAD)" = "$persisted_head" ] || {
        fail "source repository HEAD changed"
    }
    [ "$(git -C "$WORKTREE_PATH" rev-parse HEAD)" = "$persisted_head" ] || {
        fail "Worktree HEAD changed"
    }
    git -C "$SOURCE_REPO" worktree list --porcelain \
        | grep -Fxq "worktree $WORKTREE_PATH" \
        || fail "source repository no longer registers the persisted Worktree"

    local source_common_dir
    local worktree_common_dir
    source_common_dir="$(
        git -C "$SOURCE_REPO" rev-parse --path-format=absolute --git-common-dir
    )"
    worktree_common_dir="$(
        git -C "$WORKTREE_PATH" rev-parse --path-format=absolute --git-common-dir
    )"
    [ "$source_common_dir" = "$worktree_common_dir" ] || {
        fail "restored Worktree no longer belongs to the original Git repository"
    }
    [ "$(read_state git-common-dir)" = "$worktree_common_dir" ] || {
        fail "Git common directory changed after instance replacement"
    }
    grep -Fq "\"deviceId\":\"$DEVICE_ID\"" "$RUNTIME_MARKER" || {
        fail "Runtime state belongs to a different logical device"
    }
    assert_worktree_listed

    echo "ACCEPTANCE_PHASE=verify"
    echo "ACCEPTANCE_RESULT=passed"
    echo "ACCEPTANCE_PROBE_ID=$PROBE_ID"
    echo "ACCEPTANCE_SEED_INSTANCE_ID=$seed_instance_id"
    echo "ACCEPTANCE_VERIFY_INSTANCE_ID=$INSTANCE_ID"
}

cleanup_probe() {
    require_device_identity
    assert_worktree_capability
    if [ -d "$SOURCE_REPO/.git" ] && [ -e "$WORKTREE_PATH" ]; then
        delete_worktree_via_executor
        assert_worktree_absent
    elif [ -e "$WORKTREE_PATH" ]; then
        fail "refusing to remove an unverified Worktree path"
    fi
    if [ -d "$SOURCE_REPO/.git" ]; then
        git -C "$SOURCE_REPO" worktree prune
    fi
    rm -f "$RUNTIME_MARKER"
    rm -rf "$SOURCE_REPO" "$STATE_DIR"

    echo "ACCEPTANCE_PHASE=cleanup"
    echo "ACCEPTANCE_RESULT=passed"
    echo "ACCEPTANCE_PROBE_ID=$PROBE_ID"
}

ACTION="${1:-}"
case "$ACTION" in
    seed | verify | cleanup) ;;
    *)
        usage >&2
        exit 2
        ;;
esac

EXECUTOR_HOME="${WEGENT_EXECUTOR_HOME:-}"
WORKSPACE_ROOT="${LOCAL_WORKSPACE_ROOT:-}"
DEVICE_ID="${WEGENT_EXECUTOR_HOME_ID:-}"
INSTANCE_ID="${WEGENT_ACCEPTANCE_INSTANCE_ID:-}"
VOLUME_ID="${WEGENT_ACCEPTANCE_VOLUME_ID:-}"
PROBE_ID="${WEGENT_ACCEPTANCE_PROBE_ID:-git-worktree-persistence}"
EXECUTOR_BIN="${WEGENT_ACCEPTANCE_EXECUTOR_BIN:-$EXECUTOR_HOME/bin/wegent-executor}"
SCRIPT_DIR="${0%/*}"
[ "$SCRIPT_DIR" != "$0" ] || SCRIPT_DIR="."
JSON_HELPER="$SCRIPT_DIR/executor-persistence-json.py"

[ -n "$EXECUTOR_HOME" ] || fail "WEGENT_EXECUTOR_HOME is required"
[ -n "$WORKSPACE_ROOT" ] || fail "LOCAL_WORKSPACE_ROOT is required"
[ -n "$DEVICE_ID" ] || fail "WEGENT_EXECUTOR_HOME_ID is required"
[ "${WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED:-}" = "true" ] || {
    fail "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED must be true"
}
[ -n "$INSTANCE_ID" ] || fail "WEGENT_ACCEPTANCE_INSTANCE_ID is required"
[ -n "$VOLUME_ID" ] || fail "WEGENT_ACCEPTANCE_VOLUME_ID is required"
case "$VOLUME_ID" in
    *$'\n'* | *$'\r'*) fail "WEGENT_ACCEPTANCE_VOLUME_ID must be one line" ;;
esac
[[ "$PROBE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
    fail "WEGENT_ACCEPTANCE_PROBE_ID contains unsupported characters"
}
[[ "$DEVICE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || {
    fail "WEGENT_EXECUTOR_HOME_ID contains unsupported characters"
}
[[ "$INSTANCE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || {
    fail "WEGENT_ACCEPTANCE_INSTANCE_ID contains unsupported characters"
}

EXECUTOR_HOME="${EXECUTOR_HOME%/}"
WORKSPACE_ROOT="${WORKSPACE_ROOT%/}"
require_absolute_directory WEGENT_EXECUTOR_HOME "$EXECUTOR_HOME"
require_absolute_directory LOCAL_WORKSPACE_ROOT "$WORKSPACE_ROOT"
case "$WORKSPACE_ROOT/" in
    "$EXECUTOR_HOME/"*) ;;
    *) fail "LOCAL_WORKSPACE_ROOT must remain inside WEGENT_EXECUTOR_HOME" ;;
esac

STATE_DIR="$EXECUTOR_HOME/.acceptance/$PROBE_ID"
SOURCE_REPO="$WORKSPACE_ROOT/projects/.wegent-acceptance-$PROBE_ID"
WORKTREE_ID="acceptance-$PROBE_ID"
WORKTREE_PATH="$WORKSPACE_ROOT/worktrees/$WORKTREE_ID/.wegent-acceptance-$PROBE_ID"
RUNTIME_MARKER="$EXECUTOR_HOME/runtime-work/.acceptance-$PROBE_ID.json"

case "$ACTION" in
    seed) seed_probe ;;
    verify) verify_probe ;;
    cleanup) cleanup_probe ;;
esac
