# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for OpenAI request conversion defaults."""

from shared.models.execution import ExecutionRequest
from shared.models.knowledge import KnowledgeBaseToolAccessMode
from shared.models.openai_converter import OpenAIRequestConverter


def test_from_execution_request_normalizes_null_kb_tool_access_mode():
    request = ExecutionRequest(kb_tool_access_mode=None)

    openai_request = OpenAIRequestConverter.from_execution_request(request)

    assert (
        openai_request["metadata"]["kb_tool_access_mode"]
        == KnowledgeBaseToolAccessMode.FULL
    )


def test_to_execution_request_normalizes_null_kb_tool_access_mode():
    openai_request = {
        "model": "test-model",
        "input": "hello",
        "metadata": {
            "kb_tool_access_mode": None,
        },
    }

    request = OpenAIRequestConverter.to_execution_request(openai_request)

    assert request.kb_tool_access_mode == KnowledgeBaseToolAccessMode.FULL


def test_round_trip_preserves_skill_reference_metadata():
    request = ExecutionRequest(
        skill_names=["analysis-skill"],
        skill_configs=[
            {
                "name": "analysis-skill",
                "skill_id": 101,
                "namespace": "team-a",
                "is_public": False,
            }
        ],
        preload_skills=["analysis-skill"],
        skill_refs={
            "analysis-skill": {
                "skill_id": 101,
                "namespace": "team-a",
                "is_public": False,
            }
        },
        preload_skill_refs={
            "analysis-skill": {
                "skill_id": 202,
                "namespace": "team-b",
                "is_public": False,
            }
        },
    )

    openai_request = OpenAIRequestConverter.from_execution_request(request)
    converted = OpenAIRequestConverter.to_execution_request(openai_request)

    assert converted.skill_refs == request.skill_refs
    assert converted.preload_skill_refs == request.preload_skill_refs


def test_to_execution_request_preserves_message_history_and_stateless_flag():
    openai_request = {
        "model": "test-model",
        "input": [
            {"role": "user", "content": "第一条用户消息"},
            {"role": "user", "content": "第二条用户消息"},
        ],
        "metadata": {
            "stateless": True,
            "enable_tools": False,
        },
    }

    request = OpenAIRequestConverter.to_execution_request(openai_request)

    assert request.stateless is True
    assert request.enable_tools is False
    assert request.history == [{"role": "user", "content": "第一条用户消息"}]
    assert request.prompt == "第二条用户消息"
