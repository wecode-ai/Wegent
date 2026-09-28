# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from app.schemas.kind import Ghost
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.ghost_capabilities import merge_ghost_capabilities


def _bot_json() -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Bot",
        "metadata": {"name": "custom-bot", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "custom-ghost", "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            "capability_mode": "manual",
        },
    }


def _ghost_json(
    name: str,
    *,
    prompt: str,
    base_ref: dict | None = None,
    mcp_servers: dict | None = None,
) -> dict:
    spec = {
        "systemPrompt": prompt,
        "mcpServers": mcp_servers or {},
        "plugins": [],
        "skills": [],
    }
    if base_ref:
        spec["baseGhostRef"] = base_ref
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Ghost",
        "metadata": {"name": name, "namespace": "default"},
        "spec": spec,
    }


@pytest.mark.parametrize("capability_mode", [None, "manual", "follow_device"])
def test_bot_capability_mode_preserves_legacy_skills_and_mcp(mocker, capability_mode):
    builder = TaskRequestBuilder(mocker.Mock())
    bot_json = _bot_json()
    bot_json["spec"]["shellRef"]["name"] = "Chat"
    if capability_mode is None:
        del bot_json["spec"]["capability_mode"]
    else:
        bot_json["spec"]["capability_mode"] = capability_mode
    bot = SimpleNamespace(name="custom-bot", json=bot_json)
    team = SimpleNamespace(user_id=7, name="custom-agent", namespace="default")
    user = SimpleNamespace(id=7)
    ghost_json = _ghost_json(
        "custom-ghost",
        prompt="Use the configured analysis skill.",
        mcp_servers={"analysis": {"url": "https://analysis.example/mcp"}},
    )
    ghost_json["spec"].update(skills=["analysis"], preload_skills=["analysis"])
    ghost = SimpleNamespace(name="custom-ghost", namespace="default", json=ghost_json)
    mocker.patch(
        "app.services.execution.request_builder.kindReader.get_by_name_and_namespace",
        return_value=ghost,
    )
    skill = SimpleNamespace(
        id=42,
        user_id=7,
        namespace="default",
        json={
            "kind": "Skill",
            "metadata": {"name": "analysis", "namespace": "default"},
            "spec": {"description": "Analyze data", "prompt": "Analyze the data."},
        },
    )
    mocker.patch.object(builder, "_find_skill", return_value=skill)
    mocker.patch.object(builder, "_load_system_mcp_servers", return_value=[])

    skills, preloads, selected, refs = builder._get_bot_skills(
        bot, team, user, user_id=7
    )
    servers = builder._build_mcp_servers(bot, team, user=user)

    expected_names = [] if capability_mode == "follow_device" else ["analysis"]
    assert [item["name"] for item in skills] == expected_names
    assert preloads == selected == expected_names
    assert list(refs) == expected_names
    assert [server["name"] for server in servers] == expected_names
    if expected_names:
        assert skills[0]["prompt"] == "Analyze the data."
        assert refs["analysis"]["skill_id"] == 42


def test_base_ghost_is_loaded_once_per_builder(mocker, test_db):
    builder = TaskRequestBuilder(test_db)
    bot = SimpleNamespace(
        name="custom-bot",
        namespace="default",
        json=_bot_json(),
    )
    team = SimpleNamespace(user_id=7)
    own_ghost = SimpleNamespace(
        name="custom-ghost",
        json=_ghost_json(
            "custom-ghost",
            prompt="Custom identity",
            base_ref={
                "name": "chat-ghost",
                "namespace": "default",
                "user_id": 0,
            },
        ),
    )
    base_ghost = SimpleNamespace(
        name="chat-ghost",
        json=_ghost_json("chat-ghost", prompt="Default chat identity"),
    )
    reader = mocker.patch(
        "app.services.execution.request_builder.kindReader.get_by_name_and_namespace",
        side_effect=[own_ghost, base_ghost],
    )

    first = builder._get_bot_ghost_chain(bot, team)
    second = builder._get_bot_ghost_chain(bot, team)

    assert first is second
    assert [ghost.name for ghost, _ in first] == ["chat-ghost", "custom-ghost"]
    assert reader.call_count == 2


def test_base_ghost_prompt_does_not_override_custom_agent_identity(mocker, test_db):
    builder = TaskRequestBuilder(test_db)
    bot = SimpleNamespace(
        name="custom-bot",
        namespace="default",
        json=_bot_json(),
    )
    team = SimpleNamespace(user_id=7, name="custom-agent")
    team_crd = SimpleNamespace(spec=SimpleNamespace(members=[]))
    own_ghost = SimpleNamespace(
        name="custom-ghost",
        json=_ghost_json(
            "custom-ghost",
            prompt="Custom Claude Code identity",
            base_ref={
                "name": "chat-ghost",
                "namespace": "default",
                "user_id": 0,
            },
        ),
    )
    base_ghost = SimpleNamespace(
        name="chat-ghost",
        json=_ghost_json("chat-ghost", prompt="Default Chat identity"),
    )
    mocker.patch(
        "app.services.execution.request_builder.kindReader.get_by_name_and_namespace",
        side_effect=[own_ghost, base_ghost],
    )

    prompt = builder._get_base_system_prompt(
        bot=bot,
        team=team,
        team_crd=team_crd,
        team_member_prompt="Team role",
    )

    assert "Custom Claude Code identity" in prompt
    assert "Team role" in prompt
    assert "Default Chat identity" not in prompt


def test_plugin_merge_key_allows_custom_config_to_override_base():
    base = SimpleNamespace(
        namespace="default",
        json=_ghost_json("base", prompt="Base"),
    )
    custom = SimpleNamespace(
        namespace="default",
        json=_ghost_json("custom", prompt="Custom"),
    )
    base_ghost = Ghost.model_validate(base.json)
    custom_ghost = Ghost.model_validate(custom.json)
    base_ghost.spec.plugins = [
        {"id": "company-mail@official", "config": {"mode": "base"}}
    ]
    custom_ghost.spec.plugins = [
        {"id": "company-mail@official", "config": {"mode": "custom"}}
    ]

    merged = merge_ghost_capabilities([(base, base_ghost), (custom, custom_ghost)])

    assert merged.plugins == [
        {"id": "company-mail@official", "config": {"mode": "custom"}}
    ]


def test_base_and_custom_mcp_merge_with_custom_precedence(mocker, test_db):
    builder = TaskRequestBuilder(test_db)
    bot = SimpleNamespace(
        name="custom-bot",
        namespace="default",
        json=_bot_json(),
    )
    team = SimpleNamespace(user_id=7, name="custom-agent")
    own_ghost = SimpleNamespace(
        name="custom-ghost",
        json=_ghost_json(
            "custom-ghost",
            prompt="Custom identity",
            base_ref={
                "name": "chat-ghost",
                "namespace": "default",
                "user_id": 0,
            },
            mcp_servers={
                "shared": {"url": "https://custom.example/mcp"},
                "custom-only": {"url": "https://custom-only.example/mcp"},
            },
        ),
    )
    base_ghost = SimpleNamespace(
        name="chat-ghost",
        json=_ghost_json(
            "chat-ghost",
            prompt="Default identity",
            mcp_servers={
                "shared": {"url": "https://base.example/mcp"},
                "base-only": {"url": "https://base-only.example/mcp"},
            },
        ),
    )
    reader = mocker.patch(
        "app.services.execution.request_builder.kindReader.get_by_name_and_namespace",
        side_effect=[own_ghost, base_ghost],
    )
    mocker.patch.object(builder, "_load_system_mcp_servers", return_value=[])

    result = builder._build_mcp_servers(
        bot=bot,
        team=team,
        user=SimpleNamespace(),
    )

    servers = {server["name"]: server for server in result}
    assert servers["shared"]["url"] == "https://custom.example/mcp"
    assert set(servers) == {"shared", "base-only", "custom-only"}
    assert reader.call_count == 2
