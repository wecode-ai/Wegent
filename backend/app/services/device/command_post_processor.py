# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Post processors for local device command results."""

import json
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


def _directory_list_processor(result: CommandResult) -> CommandResult:
    if not result.get("success"):
        return result

    entries = [
        line.strip()
        for line in str(result.get("stdout") or "").splitlines()
        if line.strip()
    ]
    result["stdout"] = [
        entry.rstrip("/")
        for entry in entries
        if entry.endswith("/") and entry.rstrip("/") not in {".", ".."}
    ]
    return result


def _json_processor(result: CommandResult) -> CommandResult:
    if result.get("stdout_truncated"):
        result["success"] = False
        result["error"] = (
            "Command output exceeded max_output_bytes and was truncated; "
            "JSON is incomplete and cannot be parsed"
        )
        return result

    stdout = result.get("stdout") or ""
    try:
        parsed_stdout = json.loads(str(stdout))
    except json.JSONDecodeError as exc:
        if not result.get("success"):
            return result
        result["success"] = False
        result["error"] = f"Failed to parse command JSON output: {exc}"
        return result

    result["stdout"] = parsed_stdout
    if not result.get("success") and isinstance(parsed_stdout, dict):
        error = parsed_stdout.get("error")
        if isinstance(error, str) and error.strip() and not result.get("error"):
            result["error"] = error
    return result


COMMAND_POST_PROCESSORS: dict[str, CommandPostProcessor] = {
    "file_list": _file_list_processor,
    "directory_list": _directory_list_processor,
    "json": _json_processor,
}
