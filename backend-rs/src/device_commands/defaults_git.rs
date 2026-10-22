// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Default local device commands ported verbatim from
//! `app/services/device/command_registry.py::DEFAULT_LOCAL_DEVICE_COMMANDS`.
//!
//! The `command` text is embedded byte-for-byte: the device receives it in the
//! `device:execute_command` payload, so quoting and embedded scripts must match
//! the source exactly.

use super::DeviceCommandSpec;

pub(super) fn lookup(key: &str) -> Option<DeviceCommandSpec> {
    match key {
        "git_clone" => Some(DeviceCommandSpec {
            command: r#"git clone"#,
            post_processor: None,
        }),
        "git_fetch" => Some(DeviceCommandSpec {
            command: r#"git fetch --all --prune"#,
            post_processor: None,
        }),
        "git_config" => Some(DeviceCommandSpec {
            command: r#"git config"#,
            post_processor: None,
        }),
        "git_worktree_list" => Some(DeviceCommandSpec {
            command: r#"sh -c 'git -C "$1" worktree list --porcelain' --"#,
            post_processor: None,
        }),
        "git_is_worktree" => Some(DeviceCommandSpec {
            command: r#"sh -c 'git -C "$1" rev-parse --is-inside-work-tree' --"#,
            post_processor: None,
        }),
        "git_worktree_add" => Some(DeviceCommandSpec {
            command: r#"sh -c 'source=$1; target=$2; ref=$3; mkdir -p "$(dirname "$target")"; if git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then if [ -n "$ref" ]; then git -C "$target" checkout --force --detach "$ref"; fi; else if [ -e "$target" ]; then echo "target exists and is not a Git worktree" >&2; exit 64; fi; if [ -n "$ref" ]; then git -C "$source" worktree add --detach "$target" "$ref"; else git -C "$source" worktree add --detach "$target"; fi; fi' --"#,
            post_processor: None,
        }),
        "git_worktree_remove" => Some(DeviceCommandSpec {
            command: r#"sh -c 'git -C "$1" worktree remove --force "$2"' --"#,
            post_processor: None,
        }),
        "remove_worktree_dir" => Some(DeviceCommandSpec {
            command: r#"sh -c 'target=$1; parent=$(dirname "$target"); id=$(basename "$parent"); root_name=$(basename "$(dirname "$parent")"); if [ "$root_name" != "worktrees" ]; then echo "refusing unsafe worktree path" >&2; exit 64; fi; case "$id" in ""|*[!0-9]*) echo "refusing unsafe worktree path" >&2; exit 64 ;; esac; rm -rf "$target"; rmdir "$parent" 2>/dev/null || true' --"#,
            post_processor: None,
        }),
        "git_branch" => Some(DeviceCommandSpec {
            command: r#"git branch --show-current"#,
            post_processor: None,
        }),
        "git_branch_list" => Some(DeviceCommandSpec {
            command: r#"git branch --format=%(refname:short)"#,
            post_processor: None,
        }),
        "git_checkout" => Some(DeviceCommandSpec {
            command: r#"git checkout"#,
            post_processor: None,
        }),
        "git_checkout_new" => Some(DeviceCommandSpec {
            command: r#"git checkout -b"#,
            post_processor: None,
        }),
        "git_diff_shortstat" => Some(DeviceCommandSpec {
            command: r#"git diff --shortstat"#,
            post_processor: None,
        }),
        "git_diff" => Some(DeviceCommandSpec {
            command: r#"bash -c 'if git rev-parse --verify --quiet HEAD >/dev/null; then git diff --binary HEAD --; else git diff --binary --; fi; git ls-files --others --exclude-standard -z | while IFS= read -r -d "" file; do git diff --binary --no-index -- /dev/null "$file" || true; done'"#,
            post_processor: None,
        }),
        "git_branch_diff" => Some(DeviceCommandSpec {
            command: r#"bash -c 'base=""; for candidate in "$(git symbolic-ref --quiet --short refs/remotes/upstream/HEAD 2>/dev/null)" upstream/main upstream/master "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master main master; do [ -n "$candidate" ] || continue; if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then base="$candidate"; break; fi; done; if [ -n "$base" ]; then merge_base=$(git merge-base "$base" HEAD 2>/dev/null || true); fi; if [ -n "$merge_base" ]; then git diff --binary "$merge_base" --; elif git rev-parse --verify --quiet HEAD >/dev/null; then git diff --binary HEAD --; else git diff --binary --; fi; git ls-files --others --exclude-standard -z | while IFS= read -r -d "" file; do git diff --binary --no-index -- /dev/null "$file" || true; done'"#,
            post_processor: None,
        }),
        "git_diff_unstaged" => Some(DeviceCommandSpec {
            command: r#"git diff --binary --"#,
            post_processor: None,
        }),
        "git_diff_staged" => Some(DeviceCommandSpec {
            command: r#"git diff --binary --cached --"#,
            post_processor: None,
        }),
        "git_diff_last_commit" => Some(DeviceCommandSpec {
            command: r#"git diff --binary HEAD~1..HEAD --"#,
            post_processor: None,
        }),
        "git_branch_diff_shortstat" => Some(DeviceCommandSpec {
            command: r#"bash -c 'base=""; for candidate in "$(git symbolic-ref --quiet --short refs/remotes/upstream/HEAD 2>/dev/null)" upstream/main upstream/master "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master main master; do [ -n "$candidate" ] || continue; if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then base="$candidate"; break; fi; done; [ -n "$base" ] || { git diff --shortstat HEAD --; exit 0; }; merge_base=$(git merge-base "$base" HEAD 2>/dev/null || true); [ -n "$merge_base" ] || { git diff --shortstat HEAD --; exit 0; }; git diff --shortstat "$merge_base" --'"#,
            post_processor: None,
        }),
        "git_status_porcelain" => Some(DeviceCommandSpec {
            command: r#"git status --porcelain"#,
            post_processor: None,
        }),
        "git_remote_url" => Some(DeviceCommandSpec {
            command: r#"git remote get-url origin"#,
            post_processor: None,
        }),
        "git_add_all" => Some(DeviceCommandSpec {
            command: r#"git add --all"#,
            post_processor: None,
        }),
        "git_apply_patch" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import base64
import subprocess
import sys


action = sys.argv[1] if len(sys.argv) > 1 else ""
encoded_patch = sys.argv[2] if len(sys.argv) > 2 else ""
args_by_action = {
    "stage": ["git", "apply", "--cached", "--whitespace=nowarn", "-"],
    "unstage": ["git", "apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
    "revert": ["git", "apply", "--reverse", "--whitespace=nowarn", "-"],
}
git_args = args_by_action.get(action)
if git_args is None:
    print("Unsupported patch action", file=sys.stderr)
    raise SystemExit(64)

try:
    patch = base64.b64decode(encoded_patch, validate=True)
except Exception:
    print("Invalid patch payload", file=sys.stderr)
    raise SystemExit(64)

result = subprocess.run(git_args, input=patch, check=False)
raise SystemExit(result.returncode)'"#,
            post_processor: None,
        }),
        "git_commit" => Some(DeviceCommandSpec {
            command: r#"git commit"#,
            post_processor: None,
        }),
        "git_push" => Some(DeviceCommandSpec {
            command: r#"sh -c 'branch=$(git branch --show-current); [ -n "$branch" ] || { echo "Cannot push detached HEAD" >&2; exit 64; }; exec git push -u origin "$branch"'"#,
            post_processor: None,
        }),
        "git_commit_available" => Some(DeviceCommandSpec {
            command: r#"sh -c 'git -C "$1" cat-file -e "$2^{commit}"' --"#,
            post_processor: None,
        }),
        _ => None,
    }
}
