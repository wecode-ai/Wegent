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
ROOTS = (
    (Path.home() / ".claude" / "skills", "claude"),
    (Path.home() / ".codex" / "skills", "codex"),
)


def read_frontmatter(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    match = FRONTMATTER_PATTERN.match(text)
    return match.group(1) if match else ""


def frontmatter_field(frontmatter, field_name):
    pattern = re.compile(rf"^\\s*{re.escape(field_name)}\\s*:\\s*(.+?)\\s*$")
    for line in frontmatter.splitlines():
        match = pattern.match(line)
        if match:
            return match.group(1).strip().strip(chr(34)).strip(chr(39))
    return None


def nested_metadata_field(frontmatter, field_name):
    in_metadata = False
    pattern = re.compile(rf"^\\s+{re.escape(field_name)}\\s*:\\s*(.+?)\\s*$")
    for line in frontmatter.splitlines():
        if re.match(r"^metadata\\s*:\\s*$", line):
            in_metadata = True
            continue
        if in_metadata and line and not line.startswith((" ", "\\t")):
            in_metadata = False
        if not in_metadata:
            continue
        match = pattern.match(line)
        if match:
            return match.group(1).strip().strip(chr(34)).strip(chr(39))
    return None


def skill_metadata(skill_file, source):
    stat = skill_file.stat()
    frontmatter = read_frontmatter(skill_file)
    name = frontmatter_field(frontmatter, "name") or skill_file.parent.name
    return {
        "name": name,
        "description": frontmatter_field(frontmatter, "description") or "",
        "short_description": nested_metadata_field(frontmatter, "short-description")
        or frontmatter_field(frontmatter, "short-description"),
        "path": str(skill_file),
        "source": source,
        "mtime": stat.st_mtime,
    }


skills = []
seen_paths = set()
for root, source in ROOTS:
    if not root.is_dir():
        continue
    for skill_file in sorted(root.glob("**/SKILL.md")):
        key = str(skill_file)
        if key in seen_paths:
            continue
        try:
            skills.append(skill_metadata(skill_file, source))
            seen_paths.add(key)
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
    "git_clone": LocalDeviceCommandDefinition(command="git clone"),
    "git_branch": LocalDeviceCommandDefinition(command="git branch --show-current"),
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
