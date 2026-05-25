# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Post processors for local device command results."""

from collections.abc import Callable
from typing import Any


class CommandPostProcessorError(ValueError):
    """Raised when a configured command post processor is invalid."""


CommandResult = dict[str, Any]
CommandPostProcessor = Callable[[CommandResult], CommandResult]


def apply_command_post_processor(
    result: CommandResult,
    processor_name: str | None,
) -> CommandResult:
    """Apply a registered post processor to a command result."""
    if not processor_name:
        return result

    processor = COMMAND_POST_PROCESSORS.get(processor_name)
    if processor is None:
        raise CommandPostProcessorError(
            f"Unknown local device command post processor: {processor_name}"
        )
    return processor(dict(result))


def _file_list_processor(result: CommandResult) -> CommandResult:
    if not result.get("success"):
        return result

    entries = [
        line.strip()
        for line in str(result.get("stdout") or "").splitlines()
        if line.strip()
    ]
    result["stdout"] = [entry for entry in entries if entry not in {".", ".."}]
    return result


COMMAND_POST_PROCESSORS: dict[str, CommandPostProcessor] = {
    "file_list": _file_list_processor,
}
