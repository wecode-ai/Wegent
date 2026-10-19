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
        "pwd" => Some(DeviceCommandSpec {
            command: r#"pwd"#,
            post_processor: None,
        }),
        "home_dir" => Some(DeviceCommandSpec {
            command: r#"sh -c 'case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) cygpath -w "$HOME" ;; * ) printf "%s\n" "$HOME" ;; esac'"#,
            post_processor: None,
        }),
        "project_workspace_root" => Some(DeviceCommandSpec {
            command: r#"sh -c 'printf %s "${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}"'"#,
            post_processor: None,
        }),
        "workspace_tree" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import json
import stat as stat_module
from datetime import datetime, timezone
from pathlib import Path


def iso_mtime(path_stat):
    return datetime.fromtimestamp(path_stat.st_mtime, timezone.utc).isoformat()


root = Path.cwd().resolve()

entries = []
for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
    if child.name in {'"'"'.'"'"', '"'"'..'"'"'}:
        continue
    try:
        child_stat = child.lstat()
    except OSError:
        continue
    is_directory = stat_module.S_ISDIR(child_stat.st_mode)
    entries.append(
        {
            "name": child.name,
            "path": str(child),
            "is_directory": is_directory,
            "size": 0 if is_directory else child_stat.st_size,
            "modified_at": iso_mtime(child_stat),
        }
    )

entries.sort(key=lambda item: (not item["is_directory"], item["name"].lower()))
print(json.dumps({"path": str(root), "entries": entries}, ensure_ascii=False))'"#,
            post_processor: Some("json"),
        }),
        "workspace_read_text_file" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import json
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 262144


def fail(message, code=64):
    print(json.dumps({"success": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)


def is_relative_to(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


if len(sys.argv) != 2:
    fail("file name is required")

root = Path.cwd().resolve()
target = (root / sys.argv[1]).resolve()
if not is_relative_to(target, root):
    fail("file path is outside workspace")
if not target.is_file():
    fail("file does not exist")

with target.open("rb") as target_file:
    data = target_file.read(MAX_BYTES + 1)
truncated = len(data) > MAX_BYTES
content = data[:MAX_BYTES].decode("utf-8", errors="replace")
stat = target.stat()
print(
    json.dumps(
        {
            "success": True,
            "path": str(target),
            "name": target.name,
            "content": content,
            "truncated": truncated,
            "size": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        },
        ensure_ascii=False,
    )
)'"#,
            post_processor: Some("json"),
        }),
        "workspace_read_file_chunk" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import base64
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 1024 * 1024


def fail(message, code=64):
    print(json.dumps({"success": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)


def is_relative_to(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


if len(sys.argv) != 3:
    fail("file name and offset are required")

try:
    offset = int(sys.argv[2])
except ValueError:
    fail("file offset must be a non-negative integer")
if offset < 0:
    fail("file offset must be a non-negative integer")

root = Path.cwd().resolve()
target = (root / sys.argv[1]).resolve()
if not is_relative_to(target, root):
    fail("file path is outside workspace")
if not target.is_file():
    fail("file does not exist")

with target.open("rb") as target_file:
    target_file.seek(offset)
    data = target_file.read(MAX_BYTES)
stat = target.stat()
print(
    json.dumps(
        {
            "path": str(target),
            "name": target.name,
            "content_base64": base64.b64encode(data).decode("ascii"),
            "offset": offset,
            "eof": offset + len(data) >= stat.st_size,
            "size": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        },
        ensure_ascii=False,
    )
)'"#,
            post_processor: Some("json"),
        }),
        "project_folder_status" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import json
import subprocess
import sys
from pathlib import Path


def git_output(path, *args):
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=10,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


raw_path = sys.argv[1] if len(sys.argv) > 1 else ""
path = Path(raw_path).expanduser()
exists = path.exists()
is_directory = path.is_dir() if exists else None
is_empty = None
is_git_repo = False
remote_url = None
head_commit = None

if exists and is_directory:
    try:
        is_empty = next(path.iterdir(), None) is None
    except OSError:
        is_empty = False
    is_git_repo = git_output(path, "rev-parse", "--is-inside-work-tree") == "true"
    if is_git_repo:
        remote_url = git_output(path, "remote", "get-url", "origin")
        head_commit = git_output(path, "rev-parse", "HEAD")

print(
    json.dumps(
        {
            "exists": exists,
            "isDirectory": is_directory,
            "isEmpty": is_empty,
            "isGitRepo": is_git_repo,
            "remoteUrl": remote_url,
            "headCommit": head_commit,
        },
        ensure_ascii=False,
    )
)'"#,
            post_processor: Some("json"),
        }),
        "ls_a" => Some(DeviceCommandSpec {
            command: r#"ls -a"#,
            post_processor: Some("file_list"),
        }),
        "ls_dirs" => Some(DeviceCommandSpec {
            command: r#"ls -a -p"#,
            post_processor: Some("directory_list"),
        }),
        "find_worktree_dirs" => Some(DeviceCommandSpec {
            command: r#"sh -c 'root=$1; [ -d "$root" ] || exit 0; find "$root" -mindepth 2 -maxdepth 2 -type d -print' --"#,
            post_processor: Some("file_list"),
        }),
        "mkdir_p" => Some(DeviceCommandSpec {
            command: r#"mkdir -p"#,
            post_processor: None,
        }),
        "path_exists" => Some(DeviceCommandSpec {
            command: r#"test -e"#,
            post_processor: None,
        }),
        "open_terminal" => Some(DeviceCommandSpec {
            command: r#"sh -c 'target=${1:-$PWD}; case "$(uname -s)" in Darwin) open -a Terminal "$target" ;; Linux) if command -v x-terminal-emulator >/dev/null 2>&1; then x-terminal-emulator --working-directory="$target" >/dev/null 2>&1 & elif command -v gnome-terminal >/dev/null 2>&1; then gnome-terminal --working-directory="$target" >/dev/null 2>&1 & else echo "No supported graphical terminal found" >&2; exit 69; fi ;; *) echo "Opening a graphical terminal is unsupported on this device" >&2; exit 69 ;; esac' --"#,
            post_processor: None,
        }),
        "environment_prepare" => Some(DeviceCommandSpec {
            command: r#"environment-prepare"#,
            post_processor: Some("json"),
        }),
        _ => None,
    }
}
