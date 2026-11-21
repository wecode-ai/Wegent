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
        "sync_runtime_auth_file" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import json
import os
import sys
from pathlib import Path


def fail(message, code=64):
    print(json.dumps({"status": "failed", "error": message}, ensure_ascii=False))
    sys.exit(code)


def runtime_auth_file(runtime: str) -> Path:
    if runtime != "codex":
        fail(f"unsupported runtime: {runtime}")

    configured_home = os.environ.get("WEGENT_CODEX_HOME", "").strip()
    if configured_home:
        codex_home = Path(configured_home)
    else:
        executor_home = os.environ.get("WEGENT_EXECUTOR_HOME", "").strip()
        base = (
            Path(executor_home)
            if executor_home
            else Path.home() / ".wegent-executor"
        )
        codex_home = base / "codex"

    try:
        return codex_home.resolve(strict=False) / "auth.json"
    except OSError as exc:
        fail(f"failed to resolve runtime auth path: {exc}")

runtime = os.environ.get("WEGENT_RUNTIME_CONFIG_RUNTIME", "").strip()
content = os.environ.get("WEGENT_RUNTIME_CONFIG_CONTENT", "")

if not runtime:
    fail("runtime is required")
if not content:
    fail("runtime config content is required")

try:
    parsed = json.loads(content)
except json.JSONDecodeError as exc:
    fail(f"runtime config content is not valid JSON: {exc}")
if not isinstance(parsed, dict):
    fail("runtime config content must be a JSON object")

target = runtime_auth_file(runtime)
target_path = str(target)

if target.exists():
    print(
        json.dumps(
            {"status": "skipped_existing", "runtime": runtime, "path": target_path},
            ensure_ascii=False,
        )
    )
    sys.exit(0)

target.parent.mkdir(parents=True, exist_ok=True)
try:
    fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    print(
        json.dumps(
            {"status": "skipped_existing", "runtime": runtime, "path": target_path},
            ensure_ascii=False,
        )
    )
    sys.exit(0)

with os.fdopen(fd, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(parsed, ensure_ascii=False, indent=2, sort_keys=True))
    handle.write("\n")

print(
    json.dumps(
        {"status": "written", "runtime": runtime, "path": target_path},
        ensure_ascii=False,
    )
)'"#,
            post_processor: Some("json"),
        }),
        "read_runtime_auth_file" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import json
import os
import sys
from pathlib import Path


def fail(message, code=64):
    print(json.dumps({"status": "failed", "error": message}, ensure_ascii=False))
    sys.exit(code)


def runtime_auth_file(runtime: str) -> Path:
    if runtime != "codex":
        fail(f"unsupported runtime: {runtime}")

    configured_home = os.environ.get("WEGENT_CODEX_HOME", "").strip()
    if configured_home:
        codex_home = Path(configured_home)
    else:
        executor_home = os.environ.get("WEGENT_EXECUTOR_HOME", "").strip()
        base = (
            Path(executor_home)
            if executor_home
            else Path.home() / ".wegent-executor"
        )
        codex_home = base / "codex"

    try:
        return codex_home.resolve(strict=False) / "auth.json"
    except OSError as exc:
        fail(f"failed to resolve runtime auth path: {exc}")

runtime = os.environ.get("WEGENT_RUNTIME_CONFIG_RUNTIME", "").strip()

if not runtime:
    fail("runtime is required")
target = runtime_auth_file(runtime)
target_path = str(target)
if not target.is_file():
    fail("runtime auth file does not exist", code=66)

try:
    content = target.read_text(encoding="utf-8")
except OSError as exc:
    fail(f"failed to read runtime auth file: {exc}", code=74)

try:
    parsed = json.loads(content)
except json.JSONDecodeError as exc:
    fail(f"runtime auth file is not valid JSON: {exc}")
if not isinstance(parsed, dict):
    fail("runtime auth file must be a JSON object")

print(
    json.dumps(
        {
            "status": "read",
            "runtime": runtime,
            "path": target_path,
            "content": content,
        },
        ensure_ascii=False,
    )
)'"#,
            post_processor: Some("json"),
        }),
        "turn_file_changes_review" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_PATCH_BYTES = 20 * 1024 * 1024
ARTIFACT_PATTERN = re.compile(
    r"turn-file-changes/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)"
)


def finish(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def fail(message, code=64, status=None):
    payload = {"success": False, "error": message}
    if status:
        payload["status"] = status
    finish(payload, code)


def sequence_patches(raw_patch):
    try:
        patches = json.loads(raw_patch.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"invalid patch sequence: {exc}", code=65)
    if not isinstance(patches, list) or not all(isinstance(item, str) for item in patches):
        fail("invalid patch sequence", code=65)
    return patches


def patch_paths(patch_text):
    paths = set()
    for line in patch_text.splitlines():
        match = re.match(r"diff --git a/(.+?) b/(.+)$", line)
        if not match:
            continue
        for value in match.groups():
            if value != "/dev/null":
                paths.add(value)
    return paths


def copy_patch_paths(workspace, temp_workspace, patches):
    for patch_text in patches:
        for path in patch_paths(patch_text):
            source = (workspace / path).resolve()
            target = temp_workspace / path
            if workspace not in source.parents and source != workspace:
                fail("patch path escapes workspace", code=65)
            if source.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)


def run_reverse_patch_sequence(workspace, patches, check_only=False):
    with tempfile.TemporaryDirectory(prefix="wegent-turn-sequence-") as temp_dir:
        temp_workspace = Path(temp_dir)
        if check_only:
            copy_patch_paths(workspace, temp_workspace, patches)
            target_workspace = temp_workspace
        else:
            target_workspace = workspace
        for patch_text in reversed(patches):
            with tempfile.NamedTemporaryFile(
                prefix="wegent-sequence-",
                suffix=".patch",
                delete=False,
            ) as temp_file:
                temp_file.write(patch_text.encode("utf-8"))
                temp_path = Path(temp_file.name)
            try:
                result = subprocess.run(
                    ["git", "apply", "--reverse", "--binary", str(temp_path)],
                    cwd=target_workspace,
                    capture_output=True,
                    text=True,
                )
            finally:
                temp_path.unlink(missing_ok=True)
            if result.returncode != 0:
                return False
    return True


if len(sys.argv) != 3:
    fail("mode and artifact id are required")

mode = sys.argv[1]
artifact_id = sys.argv[2]
if mode not in {"review", "revert"}:
    fail("invalid mode")

match = ARTIFACT_PATTERN.fullmatch(artifact_id)
if not match:
    fail("invalid artifact id")

task_id = match.group(1)
subtask_id = match.group(2)
executor_home = Path(
    os.environ.get("WEGENT_EXECUTOR_HOME", "~/.wegent-executor")
).expanduser()
artifact_root = (executor_home / "artifacts").resolve()
artifact_dir = (artifact_root / artifact_id).resolve()
if artifact_root not in artifact_dir.parents:
    fail("invalid artifact id")

metadata_path = artifact_dir / "metadata.json"
patch_path = artifact_dir / "changes.patch.gz"
if not metadata_path.is_file() or not patch_path.is_file():
    finish(
        {
            "success": False,
            "status": "artifact_missing",
            "error": "turn file changes artifact is missing",
        }
    )

try:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    fail(f"invalid artifact metadata: {exc}", code=65)

if not isinstance(metadata, dict):
    fail("invalid artifact metadata", code=65)
if str(metadata.get("task_id")) != task_id or str(metadata.get("subtask_id")) != subtask_id:
    fail("artifact metadata id mismatch", code=65)

workspace = Path.cwd().resolve()
try:
    metadata_workspace = Path(str(metadata["workspace_path"])).resolve()
except (KeyError, OSError):
    fail("invalid artifact workspace", code=65)
if metadata_workspace != workspace:
    fail("artifact workspace mismatch", code=65)

try:
    with gzip.open(patch_path, "rb") as patch_file:
        patch = patch_file.read(MAX_PATCH_BYTES + 1)
except (OSError, gzip.BadGzipFile) as exc:
    fail(f"failed to read artifact patch: {exc}", code=65)
if len(patch) > MAX_PATCH_BYTES:
    fail("artifact patch exceeds size limit", code=65)
if hashlib.sha256(patch).hexdigest() != metadata.get("checksum"):
    fail("artifact patch checksum mismatch", code=65)

patch_sequence = metadata.get("patch_sequence") is True
patches = sequence_patches(patch) if patch_sequence else None

if mode == "review":
    finish(
        {
            "success": True,
            "diff": (
                "\n".join(patches)
                if patches is not None
                else patch.decode("utf-8", errors="replace")
            ),
        }
    )

if patches is not None:
    if not run_reverse_patch_sequence(workspace, patches, check_only=True):
        finish(
            {
                "success": False,
                "status": "conflicted",
                "error": "patch does not apply",
            }
        )
    if not run_reverse_patch_sequence(workspace, patches, check_only=False):
        finish(
            {
                "success": False,
                "status": "conflicted",
                "error": "patch does not apply",
            }
        )
    finish({"success": True, "status": "reverted"})

temp_path = None
try:
    with tempfile.NamedTemporaryFile(
        prefix="wegent-validated-turn-",
        suffix=".patch",
        delete=False,
    ) as temp_file:
        temp_file.write(patch)
        temp_path = Path(temp_file.name)

    check = subprocess.run(
        ["git", "apply", "--reverse", "--check", "--binary", str(temp_path)],
        cwd=workspace,
        capture_output=True,
        text=True,
    )
    if check.returncode != 0:
        finish(
            {
                "success": False,
                "status": "conflicted",
                "error": "patch does not apply",
            }
        )

    apply_result = subprocess.run(
        ["git", "apply", "--reverse", "--binary", str(temp_path)],
        cwd=workspace,
        capture_output=True,
        text=True,
    )
    if apply_result.returncode != 0:
        finish(
            {
                "success": False,
                "status": "conflicted",
                "error": "patch does not apply",
            }
        )
    finish({"success": True, "status": "reverted"})
finally:
    if temp_path is not None:
        temp_path.unlink(missing_ok=True)' review"#,
            post_processor: Some("json"),
        }),
        "turn_file_changes_revert" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_PATCH_BYTES = 20 * 1024 * 1024
ARTIFACT_PATTERN = re.compile(
    r"turn-file-changes/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)"
)


def finish(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def fail(message, code=64, status=None):
    payload = {"success": False, "error": message}
    if status:
        payload["status"] = status
    finish(payload, code)


def sequence_patches(raw_patch):
    try:
        patches = json.loads(raw_patch.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"invalid patch sequence: {exc}", code=65)
    if not isinstance(patches, list) or not all(isinstance(item, str) for item in patches):
        fail("invalid patch sequence", code=65)
    return patches


def patch_paths(patch_text):
    paths = set()
    for line in patch_text.splitlines():
        match = re.match(r"diff --git a/(.+?) b/(.+)$", line)
        if not match:
            continue
        for value in match.groups():
            if value != "/dev/null":
                paths.add(value)
    return paths


def copy_patch_paths(workspace, temp_workspace, patches):
    for patch_text in patches:
        for path in patch_paths(patch_text):
            source = (workspace / path).resolve()
            target = temp_workspace / path
            if workspace not in source.parents and source != workspace:
                fail("patch path escapes workspace", code=65)
            if source.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)


def run_reverse_patch_sequence(workspace, patches, check_only=False):
    with tempfile.TemporaryDirectory(prefix="wegent-turn-sequence-") as temp_dir:
        temp_workspace = Path(temp_dir)
        if check_only:
            copy_patch_paths(workspace, temp_workspace, patches)
            target_workspace = temp_workspace
        else:
            target_workspace = workspace
        for patch_text in reversed(patches):
            with tempfile.NamedTemporaryFile(
                prefix="wegent-sequence-",
                suffix=".patch",
                delete=False,
            ) as temp_file:
                temp_file.write(patch_text.encode("utf-8"))
                temp_path = Path(temp_file.name)
            try:
                result = subprocess.run(
                    ["git", "apply", "--reverse", "--binary", str(temp_path)],
                    cwd=target_workspace,
                    capture_output=True,
                    text=True,
                )
            finally:
                temp_path.unlink(missing_ok=True)
            if result.returncode != 0:
                return False
    return True


if len(sys.argv) != 3:
    fail("mode and artifact id are required")

mode = sys.argv[1]
artifact_id = sys.argv[2]
if mode not in {"review", "revert"}:
    fail("invalid mode")

match = ARTIFACT_PATTERN.fullmatch(artifact_id)
if not match:
    fail("invalid artifact id")

task_id = match.group(1)
subtask_id = match.group(2)
executor_home = Path(
    os.environ.get("WEGENT_EXECUTOR_HOME", "~/.wegent-executor")
).expanduser()
artifact_root = (executor_home / "artifacts").resolve()
artifact_dir = (artifact_root / artifact_id).resolve()
if artifact_root not in artifact_dir.parents:
    fail("invalid artifact id")

metadata_path = artifact_dir / "metadata.json"
patch_path = artifact_dir / "changes.patch.gz"
if not metadata_path.is_file() or not patch_path.is_file():
    finish(
        {
            "success": False,
            "status": "artifact_missing",
            "error": "turn file changes artifact is missing",
        }
    )

try:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    fail(f"invalid artifact metadata: {exc}", code=65)

if not isinstance(metadata, dict):
    fail("invalid artifact metadata", code=65)
if str(metadata.get("task_id")) != task_id or str(metadata.get("subtask_id")) != subtask_id:
    fail("artifact metadata id mismatch", code=65)

workspace = Path.cwd().resolve()
try:
    metadata_workspace = Path(str(metadata["workspace_path"])).resolve()
except (KeyError, OSError):
    fail("invalid artifact workspace", code=65)
if metadata_workspace != workspace:
    fail("artifact workspace mismatch", code=65)

try:
    with gzip.open(patch_path, "rb") as patch_file:
        patch = patch_file.read(MAX_PATCH_BYTES + 1)
except (OSError, gzip.BadGzipFile) as exc:
    fail(f"failed to read artifact patch: {exc}", code=65)
if len(patch) > MAX_PATCH_BYTES:
    fail("artifact patch exceeds size limit", code=65)
if hashlib.sha256(patch).hexdigest() != metadata.get("checksum"):
    fail("artifact patch checksum mismatch", code=65)

patch_sequence = metadata.get("patch_sequence") is True
patches = sequence_patches(patch) if patch_sequence else None

if mode == "review":
    finish(
        {
            "success": True,
            "diff": (
                "\n".join(patches)
                if patches is not None
                else patch.decode("utf-8", errors="replace")
            ),
        }
    )

if patches is not None:
    if not run_reverse_patch_sequence(workspace, patches, check_only=True):
        finish(
            {
                "success": False,
                "status": "conflicted",
                "error": "patch does not apply",
            }
        )
    if not run_reverse_patch_sequence(workspace, patches, check_only=False):
        finish(
            {
                "success": False,
                "status": "conflicted",
                "error": "patch does not apply",
            }
        )
    finish({"success": True, "status": "reverted"})

temp_path = None
try:
    with tempfile.NamedTemporaryFile(
        prefix="wegent-validated-turn-",
        suffix=".patch",
        delete=False,
    ) as temp_file:
        temp_file.write(patch)
        temp_path = Path(temp_file.name)

    check = subprocess.run(
        ["git", "apply", "--reverse", "--check", "--binary", str(temp_path)],
        cwd=workspace,
        capture_output=True,
        text=True,
    )
    if check.returncode != 0:
        finish(
            {
                "success": False,
                "status": "conflicted",
                "error": "patch does not apply",
            }
        )

    apply_result = subprocess.run(
        ["git", "apply", "--reverse", "--binary", str(temp_path)],
        cwd=workspace,
        capture_output=True,
        text=True,
    )
    if apply_result.returncode != 0:
        finish(
            {
                "success": False,
                "status": "conflicted",
                "error": "patch does not apply",
            }
        )
    finish({"success": True, "status": "reverted"})
finally:
    if temp_path is not None:
        temp_path.unlink(missing_ok=True)' revert"#,
            post_processor: Some("json"),
        }),
        _ => None,
    }
}
