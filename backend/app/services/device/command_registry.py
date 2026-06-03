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
    "git_clone": LocalDeviceCommandDefinition(command="git clone"),
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
