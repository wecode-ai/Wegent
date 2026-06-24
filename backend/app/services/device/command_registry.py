# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local device command registry."""

import shlex
from dataclasses import dataclass
from typing import Any, Mapping


class CommandRegistryError(ValueError):
    """Raised when a local device command definition is invalid."""


@dataclass(frozen=True)
class LocalDeviceCommandDefinition:
    """Resolved local device command definition."""

    command: str
    post_processor: str | None = None


GIT_BRANCH_DIFF_SHORTSTAT_COMMAND = (
    'bash -lc \'base=""; '
    "for candidate in "
    '"$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" '
    "origin/main main origin/master master; do "
    '[ -n "$candidate" ] || continue; '
    'if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then '
    'base="$candidate"; break; '
    "fi; "
    "done; "
    '[ -n "$base" ] || { git diff --shortstat HEAD --; exit 0; }; '
    'merge_base=$(git merge-base "$base" HEAD 2>/dev/null || true); '
    '[ -n "$merge_base" ] || { git diff --shortstat HEAD --; exit 0; }; '
    'git diff --shortstat "$merge_base" --\''
)

GIT_WORKSPACE_DIFF_COMMAND = (
    "bash -lc "
    "'if git rev-parse --verify --quiet HEAD >/dev/null; then "
    "git diff --binary HEAD --; "
    "else "
    "git diff --binary --; "
    "fi; "
    "git ls-files --others --exclude-standard -z | "
    'while IFS= read -r -d "" file; do '
    'git diff --binary --no-index -- /dev/null "$file" || true; '
    "done'"
)

WORKSPACE_ROOT_GUARD_SCRIPT = """
def fail(message, code=64):
    print(json.dumps({"success": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)


def is_relative_to(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def configured_workspace_roots():
    roots = []
    for raw_root in os.environ.get("WEGENT_WORKSPACE_ROOTS", "").split(os.pathsep):
        raw_root = raw_root.strip()
        if raw_root:
            roots.append(Path(raw_root).expanduser().resolve())

    raw_projects_root = os.environ.get("WEGENT_EXECUTOR_PROJECTS_DIR", "").strip()
    if raw_projects_root:
        projects_root = Path(raw_projects_root).expanduser().resolve()
        roots.append(projects_root)
        if projects_root.name == "projects":
            roots.append(projects_root.parent / "worktrees")
        else:
            roots.append(projects_root / "worktrees")

    wecode_home = Path(os.environ.get("WECODE_HOME", Path.home() / ".wecode"))
    executor_workspace = wecode_home.expanduser() / "wegent-executor" / "workspace"
    roots.extend(
        [
            executor_workspace / "projects",
            executor_workspace / "worktrees",
            Path("/workspace/projects"),
            Path("/workspace/worktrees"),
        ]
    )
    return tuple(dict.fromkeys(root.resolve() for root in roots))


def require_workspace_root(path):
    for allowed_root in configured_workspace_roots():
        if is_relative_to(path, allowed_root):
            return allowed_root

    fail("workspace path is outside allowed workspace roots")
""".strip()

WORKSPACE_TREE_SCRIPT = """
import json
import os
import stat as stat_module
from datetime import datetime, timezone
from pathlib import Path


__WORKSPACE_ROOT_GUARD_SCRIPT__


def iso_mtime(path_stat):
    return datetime.fromtimestamp(path_stat.st_mtime, timezone.utc).isoformat()


root = Path.cwd().resolve()
workspace_root = require_workspace_root(root)
if not is_relative_to(root, workspace_root):
    fail("workspace path is outside allowed workspace root")

entries = []
for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
    if child.name in {'.', '..'}:
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
print(json.dumps({"path": str(root), "entries": entries}, ensure_ascii=False))
""".replace(
    "__WORKSPACE_ROOT_GUARD_SCRIPT__", WORKSPACE_ROOT_GUARD_SCRIPT
).strip()

WORKSPACE_READ_TEXT_FILE_SCRIPT = """
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 262144


__WORKSPACE_ROOT_GUARD_SCRIPT__


if len(sys.argv) != 2:
    fail("file name is required")

root = Path.cwd().resolve()
workspace_root = require_workspace_root(root)
target = (root / sys.argv[1]).resolve()
if not is_relative_to(target, workspace_root):
    fail("file path is outside workspace root")
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
)
""".replace(
    "__WORKSPACE_ROOT_GUARD_SCRIPT__", WORKSPACE_ROOT_GUARD_SCRIPT
).strip()

PROJECT_FOLDER_STATUS_SCRIPT = """
import json
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
)
""".strip()

LS_SKILLS_SCRIPT = """
import json
import os
import re
from pathlib import Path

FRONTMATTER_PATTERN = re.compile(r"^---\\n(.*?)\\n---", re.S)
SKILL_SOURCES = (
    (Path.home() / ".agents" / "skills", "agents", "**/SKILL.md", "skill"),
    (Path.home() / ".claude" / "skills", "claude", "**/SKILL.md", "skill"),
    (Path.home() / ".codex" / "skills", "codex", "**/SKILL.md", "skill"),
    (
        Path.home() / ".claude" / "plugins" / "cache",
        "claude-plugin",
        "**/skills/**/SKILL.md",
        "plugin",
    ),
    (
        Path.home() / ".codex" / "plugins" / "cache",
        "codex-plugin",
        "**/skills/**/SKILL.md",
        "plugin",
    ),
)


def read_frontmatter(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    match = FRONTMATTER_PATTERN.match(text)
    return match.group(1) if match else ""


def read_json_file(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def line_indent(line):
    return len(line) - len(line.lstrip(" "))


def clean_scalar(value):
    return value.strip().strip(chr(34)).strip(chr(39)).strip()


def fold_block_lines(lines, style):
    text = "\\n".join(line.strip() for line in lines).strip()
    if style.startswith(">"):
        text = re.sub(r"\\s*\\n\\s*", " ", text)
    return re.sub(r"\\s+", " ", text).strip()


def collect_block_scalar(lines, start_index, base_indent, style):
    block_lines = []
    for line in lines[start_index + 1 :]:
        if not line.strip():
            block_lines.append("")
            continue
        if line_indent(line) <= base_indent:
            break
        block_lines.append(line)
    return fold_block_lines(block_lines, style)


def frontmatter_field(frontmatter, field_name):
    lines = frontmatter.splitlines()
    pattern = re.compile(rf"^(\\s*){re.escape(field_name)}\\s*:\\s*(.*?)\\s*$")
    for index, line in enumerate(lines):
        match = pattern.match(line)
        if not match:
            continue
        value = match.group(2).strip()
        if value.startswith(("|", ">")):
            return collect_block_scalar(lines, index, len(match.group(1)), value)
        return clean_scalar(value)
    return None


def nested_metadata_field(frontmatter, field_name):
    in_metadata = False
    lines = frontmatter.splitlines()
    pattern = re.compile(rf"^(\\s+){re.escape(field_name)}\\s*:\\s*(.*?)\\s*$")
    for index, line in enumerate(lines):
        if re.match(r"^metadata\\s*:\\s*$", line):
            in_metadata = True
            continue
        if in_metadata and line and not line.startswith((" ", "\\t")):
            in_metadata = False
        if not in_metadata:
            continue
        match = pattern.match(line)
        if match:
            value = match.group(2).strip()
            if value.startswith(("|", ">")):
                return collect_block_scalar(lines, index, len(match.group(1)), value)
            return clean_scalar(value)
    return None


def plugin_info(skill_file):
    parts = skill_file.parts
    try:
        cache_index = parts.index("cache")
        skills_index = parts.index("skills", cache_index + 1)
    except ValueError:
        return None, None
    if skills_index <= cache_index + 2:
        return None, None
    marketplace = parts[cache_index + 1]
    plugin_name = parts[cache_index + 2]
    return plugin_name, f"{plugin_name}@{marketplace}"


def is_managed(record):
    return isinstance(record, dict) and record.get("managed", True) is not False


def skill_origin(name, plugin_key, manifest):
    if plugin_key:
        return "wegent" if is_managed(manifest.get("plugins", {}).get(plugin_key)) else "local"
    return "wegent" if is_managed(manifest.get("skills", {}).get(name)) else "local"


def truncate(text, max_len=300):
    if not text or len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "…"


def real_directory_key(path):
    try:
        return str(path.resolve())
    except OSError:
        return str(path)


def matches_skill_pattern(skill_file, root, pattern):
    if pattern == "**/SKILL.md":
        return True
    try:
        relative_parts = skill_file.relative_to(root).parts
    except ValueError:
        relative_parts = skill_file.parts
    if pattern == "**/skills/**/SKILL.md":
        return "skills" in relative_parts[:-1]
    return skill_file.match(pattern)


def same_directory(left, right):
    try:
        return left.resolve() == right.resolve()
    except OSError:
        return False


def is_shared_legacy_skill_root(root, source):
    if source not in {"claude", "codex"} or not root.is_symlink():
        return False
    return same_directory(root, Path.home() / ".agents" / "skills")


def iter_skill_files(root, pattern):
    visited = set()
    for current, dirnames, filenames in os.walk(root, followlinks=True):
        current_path = Path(current)
        current_key = real_directory_key(current_path)
        if current_key in visited:
            dirnames[:] = []
            continue
        visited.add(current_key)

        next_dirs = []
        for dirname in sorted(dirnames):
            child = current_path / dirname
            child_key = real_directory_key(child)
            if child_key not in visited:
                next_dirs.append(dirname)
        dirnames[:] = next_dirs

        for filename in sorted(filenames):
            if filename != "SKILL.md":
                continue
            skill_file = current_path / filename
            if matches_skill_pattern(skill_file, root, pattern):
                yield skill_file


def skill_metadata(skill_file, source, source_kind, manifest):
    stat = skill_file.stat()
    frontmatter = read_frontmatter(skill_file)
    name = frontmatter_field(frontmatter, "name") or skill_file.parent.name
    plugin_name, plugin_key = (
        plugin_info(skill_file) if source_kind == "plugin" else (None, None)
    )
    metadata = {
        "name": name,
        "description": truncate(frontmatter_field(frontmatter, "description") or ""),
        "short_description": nested_metadata_field(frontmatter, "short-description")
        or frontmatter_field(frontmatter, "short-description"),
        "path": str(skill_file),
        "source": source,
        "origin": skill_origin(name, plugin_key, manifest),
        "mtime": stat.st_mtime,
    }
    if plugin_name:
        metadata["plugin_name"] = plugin_name
    return metadata


manifest = read_json_file(Path.home() / ".wegent-executor" / "capabilities.json")
skills = []
seen_paths = set()
seen_names = set()
for root, source, pattern, source_kind in SKILL_SOURCES:
    if not root.is_dir():
        continue
    if is_shared_legacy_skill_root(root, source):
        continue
    skill_files = (
        iter_skill_files(root, pattern)
        if source_kind == "skill"
        else sorted(root.glob(pattern))
    )
    for skill_file in skill_files:
        key = str(skill_file)
        if key in seen_paths:
            continue
        try:
            metadata = skill_metadata(skill_file, source, source_kind, manifest)
            name = metadata.get("name", "")
            if name in seen_names:
                continue
            skills.append(metadata)
            seen_paths.add(key)
            seen_names.add(name)
        except OSError:
            continue

print(json.dumps(skills, ensure_ascii=False))
""".strip()

LS_SKILLS_COMMAND = f"python3 -c {shlex.quote(LS_SKILLS_SCRIPT)}"

SETUP_SHARED_SKILLS_SCRIPT = """
import json
import shutil
import sys
from pathlib import Path


def finish(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def fail(message, code=64):
    print(message, file=sys.stderr)
    finish({"success": False, "status": "failed", "error": message}, code)


def same_path(left, right):
    try:
        return left.resolve(strict=False) == right.resolve(strict=False)
    except OSError:
        return False


def unique_target(path, source_name):
    if not path.exists() and not path.is_symlink():
        return path

    base_name = f"{path.name}-{source_name}"
    candidate = path.with_name(base_name)
    if not candidate.exists() and not candidate.is_symlink():
        return candidate

    for index in range(2, 1000):
        candidate = path.with_name(f"{base_name}-{index}")
        if not candidate.exists() and not candidate.is_symlink():
            return candidate
    fail(f"could not find a free target name for {path.name}")


def migrate_entries(source_dir, source_name, shared_dir):
    if source_dir.is_symlink():
        if same_path(source_dir, shared_dir):
            return []
        fail(f"{source_dir} is already a symlink to another location")

    if not source_dir.exists():
        return []
    if not source_dir.is_dir():
        fail(f"{source_dir} exists but is not a directory")

    moved = []
    for entry in sorted(source_dir.iterdir(), key=lambda item: item.name.lower()):
        target = unique_target(shared_dir / entry.name, source_name)
        shutil.move(str(entry), str(target))
        moved.append(
            {
                "source": source_name,
                "from": str(entry),
                "to": str(target),
                "renamed": target.name != entry.name,
            }
        )

    try:
        source_dir.rmdir()
    except OSError as exc:
        fail(f"failed to remove migrated directory {source_dir}: {exc}", code=74)
    return moved


def ensure_link(path, shared_dir):
    if path.is_symlink():
        if same_path(path, shared_dir):
            return {
                "path": str(path),
                "target": str(shared_dir),
                "status": "already_configured",
            }
        fail(f"{path} is already a symlink to another location")

    if path.exists():
        fail(f"{path} still exists after migration")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(shared_dir, target_is_directory=True)
    return {"path": str(path), "target": str(shared_dir), "status": "created"}


home = Path.home().resolve()
shared_dir = home / ".agents" / "skills"
legacy_dirs = (
    (home / ".codex" / "skills", "codex"),
    (home / ".claude" / "skills", "claude"),
)

if shared_dir.exists() and not shared_dir.is_dir():
    fail(f"{shared_dir} exists but is not a directory")

shared_created = not shared_dir.exists()
shared_dir.mkdir(parents=True, exist_ok=True)

moved = []
for legacy_dir, source_name in legacy_dirs:
    moved.extend(migrate_entries(legacy_dir, source_name, shared_dir))

links = [ensure_link(legacy_dir, shared_dir) for legacy_dir, _ in legacy_dirs]

finish(
    {
        "success": True,
        "status": "configured",
        "shared_path": str(shared_dir),
        "shared_created": shared_created,
        "legacy_paths": [str(path) for path, _ in legacy_dirs],
        "moved_count": len(moved),
        "moved": moved,
        "links": links,
    }
)
""".strip()

SETUP_SHARED_SKILLS_COMMAND = f"python3 -c {shlex.quote(SETUP_SHARED_SKILLS_SCRIPT)}"

SYNC_RUNTIME_AUTH_FILE_SCRIPT = """
import json
import os
import sys
from pathlib import Path


def fail(message, code=64):
    print(json.dumps({"status": "failed", "error": message}, ensure_ascii=False))
    sys.exit(code)


runtime = os.environ.get("WEGENT_RUNTIME_CONFIG_RUNTIME", "").strip()
target_path = os.environ.get("WEGENT_RUNTIME_CONFIG_TARGET_PATH", "").strip()
content = os.environ.get("WEGENT_RUNTIME_CONFIG_CONTENT", "")
overwrite = os.environ.get("WEGENT_RUNTIME_CONFIG_OVERWRITE", "").strip().lower() in {
    "1",
    "true",
    "yes",
}

if not runtime:
    fail("runtime is required")
if not target_path.startswith("~/"):
    fail("target path must be inside the user home directory")
if not content:
    fail("runtime config content is required")

try:
    parsed = json.loads(content)
except json.JSONDecodeError as exc:
    fail(f"runtime config content is not valid JSON: {exc}")
if not isinstance(parsed, dict):
    fail("runtime config content must be a JSON object")

home = Path.home().resolve()
target = Path(target_path).expanduser()
try:
    resolved_target = target.resolve(strict=False)
except OSError as exc:
    fail(f"failed to resolve target path: {exc}")

if home not in [resolved_target, *resolved_target.parents]:
    fail("target path must stay inside the user home directory")

if target.exists() and not overwrite:
    print(
        json.dumps(
            {"status": "skipped_existing", "runtime": runtime, "path": target_path},
            ensure_ascii=False,
        )
    )
    sys.exit(0)

target.parent.mkdir(parents=True, exist_ok=True)
payload = json.dumps(parsed, ensure_ascii=False, indent=2, sort_keys=True) + "\\n"

if overwrite:
    existed = target.exists()
    temporary_target = target.parent / f".{target.name}.tmp.{os.getpid()}"
    try:
        fd = os.open(str(temporary_target), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(str(temporary_target), str(target))
        os.chmod(str(target), 0o600)
    finally:
        try:
            if temporary_target.exists():
                temporary_target.unlink()
        except OSError:
            pass
    status = "overwritten" if existed else "written"
else:
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
        handle.write(payload)
    status = "written"

print(
    json.dumps(
        {"status": status, "runtime": runtime, "path": target_path},
        ensure_ascii=False,
    )
)
""".strip()

SYNC_RUNTIME_AUTH_FILE_COMMAND = (
    f"python3 -c {shlex.quote(SYNC_RUNTIME_AUTH_FILE_SCRIPT)}"
)

READ_RUNTIME_AUTH_FILE_SCRIPT = """
import json
import os
import sys
from pathlib import Path


def fail(message, code=64):
    print(json.dumps({"status": "failed", "error": message}, ensure_ascii=False))
    sys.exit(code)


runtime = os.environ.get("WEGENT_RUNTIME_CONFIG_RUNTIME", "").strip()
target_path = os.environ.get("WEGENT_RUNTIME_CONFIG_TARGET_PATH", "").strip()

if not runtime:
    fail("runtime is required")
if not target_path.startswith("~/"):
    fail("target path must be inside the user home directory")

home = Path.home().resolve()
target = Path(target_path).expanduser()
try:
    resolved_target = target.resolve(strict=False)
except OSError as exc:
    fail(f"failed to resolve target path: {exc}")

if home not in [resolved_target, *resolved_target.parents]:
    fail("target path must stay inside the user home directory")
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
)
""".strip()

READ_RUNTIME_AUTH_FILE_COMMAND = (
    f"python3 -c {shlex.quote(READ_RUNTIME_AUTH_FILE_SCRIPT)}"
)

CODEX_THREADS_LIST_SCRIPT = """
import json
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
    if "/" in value or "\\\\" in value:
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
print(json.dumps(payload, ensure_ascii=False))
""".strip()

CODEX_THREADS_LIST_COMMAND = f"python3 -c {shlex.quote(CODEX_THREADS_LIST_SCRIPT)}"

TURN_FILE_CHANGES_SCRIPT = """
import gzip
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
# task_id is 0 for runtime-local work (no DB task row); subtask_id is always
# positive. Both segments are pure digits, so fullmatch still blocks traversal.
ARTIFACT_PATTERN = re.compile(
    r"turn-file-changes/([0-9]+)/([0-9]+)"
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

task_id = int(match.group(1))
subtask_id = int(match.group(2))
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
if metadata.get("task_id") != task_id or metadata.get("subtask_id") != subtask_id:
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
                "\\n".join(patches)
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
        temp_path.unlink(missing_ok=True)
""".strip()

TURN_FILE_CHANGES_REVIEW_COMMAND = (
    f"python3 -c {shlex.quote(TURN_FILE_CHANGES_SCRIPT)} review"
)
TURN_FILE_CHANGES_REVERT_COMMAND = (
    f"python3 -c {shlex.quote(TURN_FILE_CHANGES_SCRIPT)} revert"
)

OPEN_TERMINAL_COMMAND = (
    "sh -c "
    "'target=${1:-$PWD}; "
    'case "$(uname -s)" in '
    'Darwin) open -a Terminal "$target" ;; '
    "Linux) "
    "if command -v x-terminal-emulator >/dev/null 2>&1; then "
    'x-terminal-emulator --working-directory="$target" >/dev/null 2>&1 & '
    "elif command -v gnome-terminal >/dev/null 2>&1; then "
    'gnome-terminal --working-directory="$target" >/dev/null 2>&1 & '
    'else echo "No supported graphical terminal found" >&2; exit 69; fi ;; '
    '*) echo "Opening a graphical terminal is unsupported on this device" >&2; exit 69 ;; '
    "esac' --"
)


DEFAULT_LOCAL_DEVICE_COMMANDS: dict[str, LocalDeviceCommandDefinition] = {
    "pwd": LocalDeviceCommandDefinition(command="pwd"),
    "home_dir": LocalDeviceCommandDefinition(command="printenv HOME"),
    "project_workspace_root": LocalDeviceCommandDefinition(
        command=(
            "sh -c "
            "'printf %s "
            '"${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}"\''
        ),
    ),
    "ls_a": LocalDeviceCommandDefinition(
        command="ls -a",
        post_processor="file_list",
    ),
    "ls_dirs": LocalDeviceCommandDefinition(
        command="ls -a -p",
        post_processor="directory_list",
    ),
    "workspace_tree": LocalDeviceCommandDefinition(
        command=f"python3 -c {shlex.quote(WORKSPACE_TREE_SCRIPT)}",
        post_processor="json",
    ),
    "workspace_read_text_file": LocalDeviceCommandDefinition(
        command=f"python3 -c {shlex.quote(WORKSPACE_READ_TEXT_FILE_SCRIPT)}",
        post_processor="json",
    ),
    "project_folder_status": LocalDeviceCommandDefinition(
        command=f"python3 -c {shlex.quote(PROJECT_FOLDER_STATUS_SCRIPT)}",
        post_processor="json",
    ),
    "mkdir_p": LocalDeviceCommandDefinition(command="mkdir -p"),
    "path_exists": LocalDeviceCommandDefinition(command="test -e"),
    "git_clone": LocalDeviceCommandDefinition(command="git clone"),
    "git_fetch": LocalDeviceCommandDefinition(command="git fetch --all --prune"),
    "git_config": LocalDeviceCommandDefinition(command="git config"),
    "git_worktree_list": LocalDeviceCommandDefinition(
        command="sh -c 'git -C \"$1\" worktree list --porcelain' --"
    ),
    "find_worktree_dirs": LocalDeviceCommandDefinition(
        command=(
            "sh -c "
            '\'root=$1; [ -d "$root" ] || exit 0; '
            'find "$root" -mindepth 2 -maxdepth 2 -type d -print\' --'
        ),
        post_processor="file_list",
    ),
    "git_is_worktree": LocalDeviceCommandDefinition(
        command="sh -c 'git -C \"$1\" rev-parse --is-inside-work-tree' --"
    ),
    "git_worktree_add": LocalDeviceCommandDefinition(
        command=(
            "sh -c '"
            "source=$1; target=$2; ref=$3; "
            'mkdir -p "$(dirname "$target")"; '
            'if git -C "$target" rev-parse --is-inside-work-tree '
            ">/dev/null 2>&1; then "
            'if [ -n "$ref" ]; then '
            'git -C "$target" checkout --force --detach "$ref"; fi; '
            "else "
            'if [ -e "$target" ]; then '
            'echo "target exists and is not a Git worktree" >&2; exit 64; fi; '
            'if [ -n "$ref" ]; then '
            'git -C "$source" worktree add --detach "$target" "$ref"; '
            'else git -C "$source" worktree add --detach "$target"; fi; '
            "fi"
            "' --"
        )
    ),
    "git_worktree_remove": LocalDeviceCommandDefinition(
        command='sh -c \'git -C "$1" worktree remove --force "$2"\' --'
    ),
    "remove_worktree_dir": LocalDeviceCommandDefinition(
        command=(
            "sh -c "
            "'target=$1; "
            'parent=$(dirname "$target"); '
            'id=$(basename "$parent"); '
            'root_name=$(basename "$(dirname "$parent")"); '
            'if [ "$root_name" != "worktrees" ]; then '
            'echo "refusing unsafe worktree path" >&2; exit 64; fi; '
            'case "$id" in ""|*[!0-9]*) '
            'echo "refusing unsafe worktree path" >&2; exit 64 ;; '
            "esac; "
            'rm -rf "$target"; rmdir "$parent" 2>/dev/null || true\' --'
        )
    ),
    "git_branch": LocalDeviceCommandDefinition(command="git branch --show-current"),
    "git_branch_list": LocalDeviceCommandDefinition(
        command="git branch --format=%(refname:short)"
    ),
    "git_checkout": LocalDeviceCommandDefinition(command="git checkout"),
    "git_checkout_new": LocalDeviceCommandDefinition(command="git checkout -b"),
    "git_diff_shortstat": LocalDeviceCommandDefinition(command="git diff --shortstat"),
    "git_diff": LocalDeviceCommandDefinition(command=GIT_WORKSPACE_DIFF_COMMAND),
    "git_diff_unstaged": LocalDeviceCommandDefinition(command="git diff --binary --"),
    "git_diff_staged": LocalDeviceCommandDefinition(
        command="git diff --binary --cached --"
    ),
    "git_diff_last_commit": LocalDeviceCommandDefinition(
        command="git diff --binary HEAD~1..HEAD --"
    ),
    "git_branch_diff_shortstat": LocalDeviceCommandDefinition(
        command=GIT_BRANCH_DIFF_SHORTSTAT_COMMAND
    ),
    "git_status_porcelain": LocalDeviceCommandDefinition(
        command="git status --porcelain"
    ),
    "git_remote_url": LocalDeviceCommandDefinition(command="git remote get-url origin"),
    "git_commit_available": LocalDeviceCommandDefinition(
        command='sh -c \'git -C "$1" cat-file -e "$2^{commit}"\' --'
    ),
    "git_add_all": LocalDeviceCommandDefinition(command="git add --all"),
    "git_commit": LocalDeviceCommandDefinition(command="git commit"),
    "ls_skills": LocalDeviceCommandDefinition(
        command=LS_SKILLS_COMMAND,
        post_processor="json",
    ),
    "codex_threads_list": LocalDeviceCommandDefinition(
        command=CODEX_THREADS_LIST_COMMAND,
        post_processor="json",
    ),
    "setup_shared_skills": LocalDeviceCommandDefinition(
        command=SETUP_SHARED_SKILLS_COMMAND,
        post_processor="json",
    ),
    "open_terminal": LocalDeviceCommandDefinition(command=OPEN_TERMINAL_COMMAND),
    "sync_runtime_auth_file": LocalDeviceCommandDefinition(
        command=SYNC_RUNTIME_AUTH_FILE_COMMAND,
        post_processor="json",
    ),
    "read_runtime_auth_file": LocalDeviceCommandDefinition(
        command=READ_RUNTIME_AUTH_FILE_COMMAND,
        post_processor="json",
    ),
    "turn_file_changes_review": LocalDeviceCommandDefinition(
        command=TURN_FILE_CHANGES_REVIEW_COMMAND,
        post_processor="json",
    ),
    "turn_file_changes_revert": LocalDeviceCommandDefinition(
        command=TURN_FILE_CHANGES_REVERT_COMMAND,
        post_processor="json",
    ),
}


def resolve_local_device_command(
    command_key: str,
    configured_commands: Mapping[str, Any] | None = None,
) -> LocalDeviceCommandDefinition | None:
    """Resolve a command key from config overrides first, then built-in defaults."""
    key = command_key.strip()
    if not key:
        return None

    configured_commands = configured_commands or {}
    default_definition = DEFAULT_LOCAL_DEVICE_COMMANDS.get(key)
    if key in configured_commands:
        return _parse_command_definition(
            key,
            configured_commands[key],
            default_definition=default_definition,
        )
    return default_definition


def build_local_device_command_argv(
    command: str, args: list[str] | None = None
) -> list[str]:
    """Build an argv array from a configured command and request args."""
    argv = shlex.split(command)
    if not argv:
        raise CommandRegistryError("Local device command resolved to an empty argv")
    return [*argv, *(args or [])]


def _parse_command_definition(
    command_key: str,
    raw_definition: Any,
    default_definition: LocalDeviceCommandDefinition | None = None,
) -> LocalDeviceCommandDefinition:
    if isinstance(raw_definition, str):
        command = raw_definition.strip()
        if not command:
            raise CommandRegistryError(
                f"Local device command '{command_key}' has an empty command"
            )
        return LocalDeviceCommandDefinition(
            command=command,
            post_processor=(
                default_definition.post_processor if default_definition else None
            ),
        )

    if isinstance(raw_definition, Mapping):
        command = str(raw_definition.get("command", "")).strip()
        if not command:
            raise CommandRegistryError(
                f"Local device command '{command_key}' must define command"
            )

        raw_post_processor = raw_definition.get(
            "post_processor",
            default_definition.post_processor if default_definition else None,
        )
        post_processor = (
            str(raw_post_processor).strip() if raw_post_processor is not None else None
        )
        return LocalDeviceCommandDefinition(
            command=command,
            post_processor=post_processor or None,
        )

    raise CommandRegistryError(
        f"Local device command '{command_key}' must be a command string or object"
    )
