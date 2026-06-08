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

LS_SKILLS_SCRIPT = """
import json
import re
from pathlib import Path

FRONTMATTER_PATTERN = re.compile(r"^---\\n(.*?)\\n---", re.S)
SKILL_SOURCES = (
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
        command='sh -c \'git -C "$1" worktree add --detach "$2"\' --'
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
    "git_branch_diff_shortstat": LocalDeviceCommandDefinition(
        command=GIT_BRANCH_DIFF_SHORTSTAT_COMMAND
    ),
    "git_remote_url": LocalDeviceCommandDefinition(command="git remote get-url origin"),
    "git_add_all": LocalDeviceCommandDefinition(command="git add --all"),
    "git_commit": LocalDeviceCommandDefinition(command="git commit"),
    "ls_skills": LocalDeviceCommandDefinition(
        command=LS_SKILLS_COMMAND,
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
