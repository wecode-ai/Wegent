# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for sandbox skill identity token propagation."""

import json
from types import SimpleNamespace

import pytest

from chat_shell.tools.sandbox._base import SandboxManager
from chat_shell.tools.skill_factory import prepare_load_skill_tool, prepare_skill_tools


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
@pytest.mark.parametrize("activation", ["preload", "manual", "history"])
async def test_sandbox_manager_requires_only_deployable_skills(
    monkeypatch: pytest.MonkeyPatch, activation: str
) -> None:
    """Every loading path keeps the Connector active only in Chat Shell."""
    monkeypatch.setattr(
        "e2b_code_interpreter.AsyncSandbox",
        _AsyncSandboxStub,
        raising=False,
    )
    connector = "wegent-connector-shanhai-sandbox"
    deployable = "wegent-connector-file-analyzer"
    skill_names = ["sandbox", connector, deployable]
    skill_configs = [{"name": name, "prompt": f"Use {name}."} for name in skill_names]
    skill_configs[1]["sandbox_deploy"] = False
    connector_tool = SimpleNamespace(name="connector_tool")

    async def load_connector_tools(
        configs: dict, task_id: int, task_data: object
    ) -> tuple[dict[str, list[SimpleNamespace]], list]:
        return {name: [connector_tool] for name in configs}, []

    if activation != "preload":
        # Keyword-matched Connectors register their MCP server directly on the
        # request. Other Connectors load their MCP tools when activated.
        skill_configs[1]["mcpServers"] = {
            connector: {"type": "streamable-http", "url": "https://example.test/mcp"}
        }
        monkeypatch.setattr(
            "chat_shell.tools.skill_factory._load_skill_mcp_tools", load_connector_tools
        )

    load_skill_tool = prepare_load_skill_tool(skill_names, 2, skill_configs)
    assert load_skill_tool is not None

    # Keyword matches arrive from Backend as preload_skills entries.
    await prepare_skill_tools(
        task_id=1,
        subtask_id=2,
        user_id=2,
        skill_configs=skill_configs,
        load_skill_tool=load_skill_tool,
        preload_skills=skill_names if activation == "preload" else ["sandbox"],
    )
    if activation == "manual":
        for name in (connector, deployable):
            await load_skill_tool.ainvoke({"skill_name": name})
    elif activation == "history":
        load_skill_tool.restore_from_history(
            [{"role": "assistant", "content": "", "loaded_skills": skill_names}]
        )

        await load_skill_tool.ensure_loaded_skill_tools_loaded()

    assert load_skill_tool.get_loaded_skills() == set(skill_names)
    if activation != "preload":
        assert connector_tool in load_skill_tool.get_available_tools()
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
        deployable
    ]


def test_generated_connector_cannot_hide_same_named_deployable_skill() -> None:
    name = "wegent-connector-file-analyzer"
    stored_skill = {"name": name, "prompt": "Analyze files.", "skill_id": 42}
    dynamic_connector = {
        "name": name,
        "prompt": "Use the Connector.",
        "sandbox_deploy": False,
    }
    load_skill_tool = prepare_load_skill_tool(
        [name], 2, [stored_skill, dynamic_connector]
    )
    assert load_skill_tool is not None

    load_skill_tool.preload_skill_prompt(name, stored_skill)

    assert set(load_skill_tool.iter_loaded_sandbox_skills()) == {name}
