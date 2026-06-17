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

LS_SKILLS_SCRIPT = """
import json
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
    for skill_file in sorted(root.glob(pattern)):
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
    handle.write("\\n")

print(
    json.dumps(
        {"status": "written", "runtime": runtime, "path": target_path},
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

TURN_FILE_CHANGES_SCRIPT = """
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_PATCH_BYTES = 20 * 1024 * 1024
ARTIFACT_PATTERN = re.compile(
    r"turn-file-changes/([1-9][0-9]*)/([1-9][0-9]*)"
)


def finish(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def fail(message, code=64, status=None):
    payload = {"success": False, "error": message}
    if status:
        payload["status"] = status
    finish(payload, code)


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

if mode == "review":
    finish(
        {
            "success": True,
            "diff": patch.decode("utf-8", errors="replace"),
        }
    )

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
    "mkdir_p": LocalDeviceCommandDefinition(command="mkdir -p"),
    "path_exists": LocalDeviceCommandDefinition(command="test -e"),
    "git_clone": LocalDeviceCommandDefinition(command="git clone"),
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
            'if [ -n "$3" ]; then '
            'git -C "$1" worktree add --detach "$2" "$3"; '
            'else git -C "$1" worktree add --detach "$2"; fi'
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
    "git_branch_diff_shortstat": LocalDeviceCommandDefinition(
        command=GIT_BRANCH_DIFF_SHORTSTAT_COMMAND
    ),
    "git_status_porcelain": LocalDeviceCommandDefinition(
        command="git status --porcelain"
    ),
    "git_remote_url": LocalDeviceCommandDefinition(command="git remote get-url origin"),
    "git_add_all": LocalDeviceCommandDefinition(command="git add --all"),
    "git_commit": LocalDeviceCommandDefinition(command="git commit"),
    "ls_skills": LocalDeviceCommandDefinition(
        command=LS_SKILLS_COMMAND,
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
