# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for sandbox skill identity token propagation."""

import json
from types import SimpleNamespace

import pytest

from chat_shell.tools.sandbox._base import SandboxManager


class _AsyncSandboxStub:
    """Capture AsyncSandbox.create metadata."""

    last_call = None

    @classmethod
    async def create(cls, **kwargs):
        cls.last_call = kwargs
        return SimpleNamespace(sandbox_id="sandbox-1")


@pytest.mark.asyncio
async def test_sandbox_manager_includes_skill_identity_token_in_metadata(
    monkeypatch,
):
    """Sandbox metadata should include skill identity token when provided."""
    monkeypatch.setattr(
        "e2b_code_interpreter.AsyncSandbox",
        _AsyncSandboxStub,
        raising=False,
    )
    manager = SandboxManager(
        task_id=1,
        user_id=2,
        user_name="alice",
        auth_token="task-jwt",
        skill_identity_token="skill-jwt",
    )

    sandbox, error = await manager.get_or_create_sandbox("ClaudeCode")

    assert error is None
    assert sandbox is not None
    assert (
        _AsyncSandboxStub.last_call["metadata"]["skill_identity_token"] == "skill-jwt"
    )


@pytest.mark.asyncio
async def test_sandbox_manager_includes_active_skills_in_metadata(monkeypatch):
    """Sandbox activation should require every Skill loaded by Chat Shell."""
    monkeypatch.setattr(
        "e2b_code_interpreter.AsyncSandbox",
        _AsyncSandboxStub,
        raising=False,
    )
    load_skill_tool = SimpleNamespace(
        get_loaded_skills=lambda: {"sandbox", "abtest-file-analyzer"}
    )
    manager = SandboxManager(
        task_id=1,
        user_id=2,
        user_name="alice",
        auth_token="task-jwt",
        load_skill_tool=load_skill_tool,
    )

    sandbox, error = await manager.get_or_create_sandbox("ClaudeCode")

    assert error is None
    assert sandbox is not None
    assert json.loads(_AsyncSandboxStub.last_call["metadata"]["required_skills"]) == [
        "abtest-file-analyzer"
    ]
