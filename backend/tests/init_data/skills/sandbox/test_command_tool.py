# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for sandbox command execution."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from init_data.skills.sandbox.command_tool import SandboxCommandTool


@pytest.mark.asyncio
async def test_command_timeout_returns_a_terminal_tool_error(monkeypatch) -> None:
    """A stalled SDK request must not leave the task stream running."""

    class FakeCommands:
        async def run(self, **kwargs) -> SimpleNamespace:
            await asyncio.Event().wait()
            raise AssertionError("wait_for should cancel the stalled command")

    sandbox = SimpleNamespace(
        sandbox_id="sandbox-1",
        commands=FakeCommands(),
    )

    class FakeManager:
        async def get_or_create_sandbox(self, **kwargs):
            return sandbox, None

    monkeypatch.setattr(
        SandboxCommandTool,
        "_get_sandbox_manager",
        lambda self: FakeManager(),
    )
    tool = SandboxCommandTool(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="alice",
    )

    statuses: list[tuple[str, str]] = []

    async def emit_tool_status(status: str, message: str, *args) -> None:
        statuses.append((status, message))

    monkeypatch.setattr(tool, "_emit_tool_status", emit_tool_status)

    result = json.loads(
        await tool._arun(
            command="sleep 60",
            timeout_seconds=0.01,
        )
    )

    assert result["success"] is False
    assert result["exit_code"] == -1
    assert "timed out after 0.01 seconds" in result["error"]
    assert statuses == [
        (
            "failed",
            "Command timed out after 0.01 seconds while waiting for the sandbox.",
        )
    ]
