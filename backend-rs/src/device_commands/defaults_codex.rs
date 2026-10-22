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
        "codex_threads_list" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_limit():
    try:
        value = int(os.environ.get("WEGENT_CODEX_THREADS_LIMIT", "100"))
    except ValueError:
        value = 100
    return min(max(value, 1), 100)


def parse_datetime(value):
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def object_value(value, *names):
    current = value
    for name in names:
        if isinstance(current, dict):
            current = current.get(name)
        else:
            current = getattr(current, name, None)
    return current


def first_object_value(value, *names):
    for name in names:
        raw = object_value(value, name)
        if raw is not None:
            return raw
    return None


def object_text(value, *names):
    for name in names:
        raw = object_value(value, name)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        root = object_value(raw, "root")
        if isinstance(root, str) and root.strip():
            return root.strip()
    return None


def time_to_iso(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).isoformat()
    if isinstance(value, str) and value.strip():
        parsed = parse_datetime(value.strip())
        return parsed.isoformat() if parsed else value.strip()
    return None


def is_thread_running(thread):
    status = object_value(thread, "status")
    if status is None:
        return False
    if isinstance(status, str):
        status_type = status
    else:
        status_type = object_text(status, "type", "status")

    normalized = (status_type or "").replace("_", "").lower()
    return normalized not in ("", "notloaded", "completed", "archived", "idle")


def enum_value(enum_name, value):
    try:
        from openai_codex.generated import v2_all

        enum_type = getattr(v2_all, enum_name)
        return enum_type(value)
    except (ImportError, AttributeError, TypeError, ValueError):
        return value


def resolve_codex_binary():
    value = os.environ.get("CODEX_BINARY_PATH") or os.environ.get("CODEX_BIN") or "codex"
    if "/" in value or "\\" in value:
        return value
    if value == "codex" and sys.platform == "darwin":
        app_binary = Path("/Applications/Codex.app/Contents/Resources/codex")
        if app_binary.exists():
            return str(app_binary)
    return shutil.which(value) or value


def normalize_thread(thread):
    thread_id = object_text(thread, "id", "thread_id", "threadId", "conversation_id")
    if not thread_id:
        return None
    title = object_text(thread, "name", "preview", "title") or thread_id
    updated_at = time_to_iso(first_object_value(thread, "updated_at", "updatedAt"))
    return {
        "threadId": thread_id,
        "title": title,
        "cwd": object_text(thread, "cwd"),
        "updatedAt": updated_at,
        "archived": bool(object_value(thread, "archived")),
        "running": is_thread_running(thread),
    }


def sort_key(record):
    value = record.get("updatedAt") or ""
    return parse_datetime(value) or datetime.min.replace(tzinfo=timezone.utc)


limit = parse_limit()
codex_home = Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex")).expanduser()
records = []
discovery_error = None

try:
    codex_home.mkdir(parents=True, exist_ok=True)

    from openai_codex import Codex, CodexConfig

    with Codex(
        CodexConfig(
            codex_bin=resolve_codex_binary(),
            client_name="wegent_device_command",
            client_title="Wegent Device Command",
            env={**os.environ, "CODEX_HOME": str(codex_home)},
        )
    ) as codex:
        response = codex.thread_list(
            limit=limit,
            archived=False,
            sort_direction=enum_value("SortDirection", "desc"),
            sort_key=enum_value("ThreadSortKey", "updated_at"),
            use_state_db_only=True,
        )

    for thread in getattr(response, "data", []):
        normalized = normalize_thread(thread)
        if normalized:
            records.append(normalized)
except Exception as exc:
    discovery_error = str(exc)

records.sort(key=sort_key, reverse=True)
payload = {"threads": records}
if discovery_error:
    payload["error"] = discovery_error
print(json.dumps(payload, ensure_ascii=False))'"#,
            post_processor: Some("json"),
        }),
        "git_generate_commit_message" => Some(DeviceCommandSpec {
            command: r#"python3 -c '
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_DIFF_BYTES = 200000
MAX_MESSAGE_CHARS = 180


def emit(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def decode_output(data):
    return data.decode("utf-8", errors="replace").strip()


def run_git(*args, max_bytes=MAX_DIFF_BYTES):
    try:
        result = subprocess.run(
            ["git", *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
    except Exception as exc:
        emit({"success": False, "error": str(exc)}, 1)

    if result.returncode != 0:
        emit(
            {
                "success": False,
                "error": decode_output(result.stderr) or "Git command failed",
            },
            1,
        )

    output = result.stdout
    truncated = len(output) > max_bytes
    return output[:max_bytes].decode("utf-8", errors="replace"), truncated


def resolve_codex_binary():
    value = os.environ.get("CODEX_BINARY_PATH") or os.environ.get("CODEX_BIN") or "codex"
    if "/" in value or "\\" in value:
        return value
    if value == "codex" and sys.platform == "darwin":
        app_binary = Path("/Applications/Codex.app/Contents/Resources/codex")
        if app_binary.exists():
            return str(app_binary)
    return shutil.which(value) or value


def clean_candidate(line):
    value = line.strip().lstrip("-* ").strip()
    lowered = value.lower()
    for prefix in ("commit message:", "message:", "subject:"):
        if lowered.startswith(prefix):
            value = value[len(prefix):].strip()
            break
    return value.strip("\"'"'"'`").strip()


def sanitize_message(raw):
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("```"):
            continue
        candidate = clean_candidate(stripped)
        if candidate:
            return candidate[:MAX_MESSAGE_CHARS]
    return ""


status, status_truncated = run_git("status", "--short", max_bytes=20000)
diff_stat, stat_truncated = run_git("diff", "--cached", "--stat", max_bytes=20000)
diff, diff_truncated = run_git("diff", "--cached", "--", max_bytes=MAX_DIFF_BYTES)

if not diff_stat.strip() and not diff.strip():
    emit({"success": False, "error": "No staged changes to summarize"}, 1)

prompt = f"""Generate a Git commit subject line from the staged changes.
Return exactly one line.
Use Conventional Commits when a clear type is available, such as feat:, fix:, refactor:, docs:, test:, chore:, or style:.
Do not include Markdown, quotes, bullets, explanations, or a body.
Keep the line under 72 characters when possible.

Git status:
{status}

Staged diff stat:
{diff_stat}

Staged diff:
{diff}
"""

output_path = None
try:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as output_file:
        output_path = output_file.name

    result = subprocess.run(
        [
            resolve_codex_binary(),
            "exec",
            "--ephemeral",
            "--ignore-rules",
            "--sandbox",
            "read-only",
            "--output-last-message",
            output_path,
            "-",
        ],
        input=prompt,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
        check=False,
    )
    if result.returncode != 0:
        emit(
            {
                "success": False,
                "error": result.stderr.strip()
                or result.stdout.strip()
                or "Codex failed to generate a commit message",
            },
            1,
        )

    raw_message = Path(output_path).read_text(encoding="utf-8", errors="replace")
finally:
    if output_path:
        try:
            Path(output_path).unlink()
        except OSError:
            pass

message = sanitize_message(raw_message)
if not message:
    emit({"success": False, "error": "Codex returned an empty commit message"}, 1)

emit(
    {
        "success": True,
        "message": message,
        "diff_truncated": bool(status_truncated or stat_truncated or diff_truncated),
    }
)
'"#,
            post_processor: Some("json"),
        }),
        _ => None,
    }
}
