# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider configuration guidance must reach every platform prompt consumer."""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.execution.provider_guidance import (
    GUIDANCE_START,
    apply_provider_configuration_guidance,
)
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.mcp_provider_registry import MCP_PROVIDER_REGISTRY
from shared.models import ExecutionRequest
from shared.models.openai_converter import OpenAIRequestConverter

MODAL_LINK = "wegent://modal/mcp-provider-config?provider=dingtalk&service=docs"
PLATFORM_SHELLS = ["Chat", "ClaudeCode", "Codex"]


@pytest.fixture(autouse=True)
def legacy_user_managed_dingtalk(monkeypatch):
    """Cover the personal-URL provider flow that DingTalk services moved away from.

    Production DingTalk services are connector-managed (per-user OAuth), so
    these guidance tests pin them back to the user-managed model that other
    deployment-specific providers still use.
    """
    provider = MCP_PROVIDER_REGISTRY["dingtalk"]
    services = {
        service_id: {**service, "connector_slug": None}
        for service_id, service in provider["services"].items()
    }
    monkeypatch.setitem(
        MCP_PROVIDER_REGISTRY, "dingtalk", {**provider, "services": services}
    )


def public_skill(service_id: str = "docs") -> SimpleNamespace:
    service = MCP_PROVIDER_REGISTRY["dingtalk"]["services"][service_id]
    name = service["skill_name"]
    return SimpleNamespace(
        id=101,
        name=name,
        user_id=0,
        namespace="default",
        json={
            "kind": "Skill",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "description": "Provider runtime Skill",
                "prompt": "Use the provider MCP directly.",
                "mcpServers": {
                    service["server_name"]: {
                        "type": "streamable-http",
                        "url": "https://example.com/mcp",
                    }
                },
            },
        },
    )


def skill_data(service_id: str = "docs") -> dict:
    return TaskRequestBuilder(MagicMock())._build_skill_data(
        public_skill(service_id), user=SimpleNamespace(preferences={})
    )


def request_with_skill(shell_type: str = "Chat") -> ExecutionRequest:
    return ExecutionRequest(
        task_id=1,
        system_prompt="Base instructions.",
        bot=[{"shell_type": shell_type, "system_prompt": "Bot instructions."}],
        skill_names=["dingtalk-docs"],
        skill_configs=[skill_data()],
        preload_skills=["dingtalk-docs"],
    )


@pytest.mark.parametrize("shell_type", PLATFORM_SHELLS)
def test_guidance_is_shared_by_request_and_bot_prompt_consumers(shell_type):
    request = request_with_skill(shell_type)

    apply_provider_configuration_guidance(request)
    first_result = deepcopy(request)
    apply_provider_configuration_guidance(request)
    wire_request = OpenAIRequestConverter.from_execution_request(request)
    restored = OpenAIRequestConverter.to_execution_request(wire_request)

    assert request == first_result
    assert request.system_prompt.startswith("Base instructions.")
    assert request.system_prompt.count(MODAL_LINK) == 1
    assert request.bot[0]["system_prompt"].startswith("Bot instructions.")
    assert request.bot[0]["system_prompt"].count(MODAL_LINK) == 1
    assert restored.system_prompt == request.system_prompt
    assert restored.bot[0]["system_prompt"] == request.bot[0]["system_prompt"]
    assert restored.skill_configs[0]["prompt_in_system_prompt"] is True
    assert "Use the provider MCP directly." not in request.system_prompt
    assert not request.skill_configs[0].get("mcpServers")


def test_available_skill_keeps_on_demand_guidance_until_activated():
    request = request_with_skill()
    request.preload_skills = []

    apply_provider_configuration_guidance(request)

    assert MODAL_LINK not in request.system_prompt
    assert MODAL_LINK in request.skill_configs[0]["prompt"]
    assert "prompt_in_system_prompt" not in request.skill_configs[0]

    request.user_selected_skills = ["dingtalk-docs"]
    apply_provider_configuration_guidance(request)

    assert request.system_prompt.count(MODAL_LINK) == 1
    assert request.skill_configs[0]["prompt_in_system_prompt"] is True


@pytest.mark.parametrize("transition", ["configured", "inactive"])
def test_refresh_removes_stale_guidance(transition):
    request = request_with_skill()
    apply_provider_configuration_guidance(request)
    if transition == "configured":
        request.skill_configs = [
            {
                "name": "dingtalk-docs",
                "prompt": "Use the provider MCP directly.",
                "mcpServers": {"docs": {"url": "https://example.com/mcp"}},
            }
        ]
    else:
        request.preload_skills = []

    apply_provider_configuration_guidance(request)

    assert request.system_prompt == "Base instructions."
    assert request.bot[0]["system_prompt"] == "Bot instructions."
    assert "prompt_in_system_prompt" not in request.skill_configs[0]


def test_multiple_providers_and_late_preloads_share_one_block():
    request = request_with_skill()
    apply_provider_configuration_guidance(request)
    request.skill_configs.append(skill_data("ai_table"))
    request.preload_skills.extend(["dingtalk-ai-table", "dingtalk-docs"])

    apply_provider_configuration_guidance(request)

    assert request.system_prompt.count(GUIDANCE_START) == 1
    assert request.system_prompt.count(MODAL_LINK) == 1
    assert request.system_prompt.count("provider=dingtalk&service=ai_table") == 1


def test_dify_does_not_receive_platform_mcp_configuration_guidance():
    request = request_with_skill("Dify")
    before = deepcopy(request)

    apply_provider_configuration_guidance(request)

    assert request == before


def test_coordinate_guidance_reaches_supported_member_prompts():
    request = request_with_skill("ClaudeCode")
    request.bot.extend(
        [
            {"shell_type": "ClaudeCode", "system_prompt": "Reviewer instructions."},
            {"shell_type": "ClaudeCode", "system_prompt": "Planner instructions."},
        ]
    )

    apply_provider_configuration_guidance(request)

    assert request.bot[1]["system_prompt"].startswith("Reviewer instructions.")
    assert request.bot[1]["system_prompt"].count(MODAL_LINK) == 1
    assert request.bot[2]["system_prompt"].startswith("Planner instructions.")
    assert request.bot[2]["system_prompt"].count(MODAL_LINK) == 1


@pytest.mark.parametrize(
    ("owner_id", "namespace"), [(7, "default"), (0, "group"), (7, "group")]
)
def test_same_named_custom_skills_are_not_treated_as_provider_state(
    owner_id, namespace
):
    skill = public_skill()
    skill.user_id = owner_id
    skill.json["metadata"]["namespace"] = namespace
    skill.json["spec"].pop("mcpServers")
    skill.json["spec"]["prompt"] = "## Configuration Required\nCustom instructions."
    request = request_with_skill()
    request.skill_configs = [
        TaskRequestBuilder(MagicMock())._build_skill_data(
            skill, user=SimpleNamespace(preferences={})
        )
    ]

    apply_provider_configuration_guidance(request)

    assert "configuration_required" not in request.skill_configs[0]
    assert request.system_prompt == "Base instructions."
    assert "prompt_in_system_prompt" not in request.skill_configs[0]


@pytest.fixture
def builder_context(test_db, mocker):
    """Exercise the real build and keyword paths without external services."""
    builder = TaskRequestBuilder(test_db)
    user = SimpleNamespace(id=7, user_name="alice", preferences={})
    team = SimpleNamespace(id=5, user_id=7, name="team", namespace="default", json={})
    bot = SimpleNamespace(id=9)
    mocker.patch(
        "app.services.execution.request_builder.Team.model_validate",
        return_value=SimpleNamespace(spec=SimpleNamespace(collaborationModel="solo")),
    )
    for method, value in {
        "_get_bot_for_subtask": bot,
        "_build_workspace": {},
        "_build_user_info": {"id": 7},
        "_get_model_config": {},
        "_get_base_system_prompt": "Base instructions.",
        "_build_mcp_servers": [],
        "_is_group_chat": False,
        "_generate_auth_token": "test-task",
        "_generate_skill_identity_token": "test-skill",
    }.items():
        mocker.patch.object(builder, method, return_value=value)

    def resolve_skills(**kwargs):
        names = [ref["name"] for ref in kwargs["user_preload_skills"] or []]
        configs = [
            builder._build_skill_data(public_skill(), user=kwargs["user"])
            for name in names
            if name == "dingtalk-docs"
        ]
        return configs, names, names, {}

    mocker.patch.object(builder, "_get_bot_skills", side_effect=resolve_skills)
    return builder, user, team, bot


@pytest.mark.parametrize("shell_type", [*PLATFORM_SHELLS, "Dify"])
@pytest.mark.parametrize("configured", [False, True])
def test_initial_request_build_handles_missing_and_ready_services(
    builder_context, mocker, shell_type, configured
):
    builder, user, team, _ = builder_context
    if configured:
        user.preferences = {
            "mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "enabled": True,
                            "credentials": {"url": "https://example.com/mcp"},
                        }
                    }
                }
            }
        }
    mocker.patch.object(
        builder,
        "_build_bot_config",
        return_value=[
            {
                "shell_type": shell_type,
                "system_prompt": "Bot instructions.",
                "skills": [],
                "mcp_servers": [],
            }
        ],
    )

    request = builder.build(
        subtask=SimpleNamespace(id=2, message_id=33),
        task=SimpleNamespace(id=1, user_id=7, json={"spec": {}}, project_id=None),
        user=user,
        team=team,
        message="钉钉文档可以用吗",
        new_session=True,
    )

    assert request.preload_skills == ["dingtalk-docs"]
    expected_guidance = not configured and shell_type in PLATFORM_SHELLS
    assert (MODAL_LINK in request.system_prompt) is expected_guidance
    assert (MODAL_LINK in request.bot[0]["system_prompt"]) is expected_guidance
    assert bool(request.skill_configs[0].get("mcpServers")) is configured
    if expected_guidance:
        assert request.system_prompt.count(MODAL_LINK) == 1
        assert request.skill_configs[0]["prompt_in_system_prompt"] is True


@pytest.mark.parametrize("shell_type", PLATFORM_SHELLS)
@pytest.mark.parametrize("already_resolved", [False, True])
def test_late_preload_resolution_injects_guidance(
    builder_context, shell_type, already_resolved
):
    builder, user, team, bot = builder_context
    request = request_with_skill(shell_type)
    if not already_resolved:
        request.skill_configs = []
        request.skill_names = []

    builder.resolve_request_preload_skills(
        request=request, user=user, bot=bot, team=team
    )

    assert request.system_prompt.count(MODAL_LINK) == 1
    assert request.bot[0]["system_prompt"].count(MODAL_LINK) == 1
    assert request.skill_configs[0]["prompt_in_system_prompt"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("shell_type", ["Chat", "ClaudeCode", "Codex"])
async def test_selected_source_activates_existing_skill_without_reresolution(
    mocker, shell_type
):
    from app.services.chat import selected_knowledge
    from app.services.chat.trigger import unified
    from shared.models.knowledge import SelectedKnowledgeContext, SelectedKnowledgeRef

    request = request_with_skill(shell_type)
    request.preload_skills = []
    mocker.patch.object(unified, "run_in_threadpool_with_cleanup", return_value=request)
    mocker.patch.object(unified, "SessionLocal")
    builder = mocker.patch("app.services.execution.TaskRequestBuilder").return_value
    context = SelectedKnowledgeContext(
        refs=(
            SelectedKnowledgeRef(
                provider="dingtalk",
                knowledge_base_id="space-1",
                knowledge_base_name="Selected space",
            ),
        )
    )
    mocker.patch.object(
        selected_knowledge, "build_inherited_selected_knowledge_refs", return_value=[]
    )
    mocker.patch.object(
        selected_knowledge, "build_selected_knowledge_context", return_value=context
    )

    result = await unified.build_execution_request(
        task=SimpleNamespace(id=1, json={}),
        assistant_subtask=SimpleNamespace(id=2),
        team=SimpleNamespace(id=5),
        user=SimpleNamespace(id=7),
        message="总结所选文档",
    )

    builder.resolve_request_preload_skills.assert_not_called()
    assert result.preload_skills == ["dingtalk-docs"]
    assert result.system_prompt.count(MODAL_LINK) == 1
    assert result.bot[0]["system_prompt"].count(MODAL_LINK) == 1
