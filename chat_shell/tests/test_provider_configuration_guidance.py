# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Configuration guidance stays available without duplicate model instructions."""

from unittest.mock import patch

import pytest

from chat_shell.tools.skill_factory import prepare_load_skill_tool, prepare_skill_tools
from shared.models import ExecutionRequest
from shared.models.openai_converter import OpenAIRequestConverter

GUIDANCE = (
    "## Configuration Required\n"
    "请点击 [打开钉钉文档 MCP 配置弹窗]"
    "(wegent://modal/mcp-provider-config?provider=dingtalk&service=docs) 完成配置。"
)
MODAL_LINK = "wegent://modal/mcp-provider-config?provider=dingtalk&service=docs"


@pytest.mark.asyncio
@pytest.mark.parametrize("preloaded", [False, True])
async def test_configuration_guidance_is_in_model_context_once(preloaded):
    skill = {
        "name": "dingtalk-docs",
        "description": "DingTalk documents",
        "prompt": GUIDANCE,
        "configuration_required": True,
    }
    if preloaded:
        skill["prompt_in_system_prompt"] = True
    request = ExecutionRequest(
        user_id=1,
        skill_names=["dingtalk-docs"],
        skill_configs=[skill],
        preload_skills=["dingtalk-docs"] if preloaded else [],
        system_prompt=GUIDANCE if preloaded else "",
    )
    # Exercise the same metadata transport used by HTTP and package Chat Shell.
    request = OpenAIRequestConverter.to_execution_request(
        OpenAIRequestConverter.from_execution_request(request)
    )
    load_skill = prepare_load_skill_tool(
        user_id=request.user_id,
        skill_names=request.skill_names,
        skill_configs=request.skill_configs,
    )

    with patch("chat_shell.tools.mcp.MCPClient") as mcp_client:
        tools, clients = await prepare_skill_tools(
            task_id=1,
            subtask_id=1,
            user_id=1,
            skill_configs=request.skill_configs,
            preload_skills=request.preload_skills,
            load_skill_tool=load_skill,
        )
        response = await load_skill.ainvoke({"skill_name": "dingtalk-docs"})
        model_context = request.system_prompt + load_skill.get_prompt_modification()

    assert "Error:" not in response
    assert model_context.count(MODAL_LINK) == 1
    assert load_skill.get_loaded_skills() == {"dingtalk-docs"}
    assert tools == []
    assert clients == []
    assert load_skill.get_available_tools() == []
    mcp_client.assert_not_called()
    if preloaded:
        assert "~/.claude/skills/dingtalk-docs" not in model_context


def test_other_skill_instructions_are_not_suppressed():
    configs = [
        {
            "name": "dingtalk-docs",
            "description": "DingTalk documents",
            "prompt": GUIDANCE,
            "prompt_in_system_prompt": True,
        },
        {"name": "review", "description": "Review code", "prompt": "Review carefully."},
    ]
    load_skill = prepare_load_skill_tool(
        user_id=1, skill_names=["dingtalk-docs", "review"], skill_configs=configs
    )
    for config in configs:
        load_skill.preload_skill_prompt(config["name"], config, is_user_selected=True)

    prompt = load_skill.get_prompt_modification()

    assert GUIDANCE not in prompt
    assert "Review carefully." in prompt
    assert "~/.claude/skills/review" in prompt


def test_restored_skill_uses_this_turn_metadata_not_old_configuration_state():
    configs = [
        {
            "name": "dingtalk-docs",
            "description": "DingTalk documents",
            "prompt": "Use the configured DingTalk MCP.",
        }
    ]
    load_skill = prepare_load_skill_tool(
        user_id=1, skill_names=["dingtalk-docs"], skill_configs=configs
    )

    load_skill.restore_from_history(
        [
            {
                "role": "assistant",
                "content": "Configure first.",
                "loaded_skills": ["dingtalk-docs"],
            }
        ]
    )

    prompt = load_skill.get_prompt_modification()
    assert "Use the configured DingTalk MCP." in prompt
    assert MODAL_LINK not in prompt
