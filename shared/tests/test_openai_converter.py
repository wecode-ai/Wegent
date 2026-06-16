# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for OpenAI request conversion defaults."""

from shared.models.execution import ExecutionRequest
from shared.models.knowledge import KnowledgeBaseScope, KnowledgeBaseToolAccessMode
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


def test_round_trip_preserves_interactive_form_answer():
    request = ExecutionRequest(
        interactive_form_answer={
            "type": "interactive_form_question",
            "tool_use_id": "tool-1",
            "answers": {"language": "python"},
            "message": "selected python",
        }
    )

    openai_request = OpenAIRequestConverter.from_execution_request(request)
    converted = OpenAIRequestConverter.to_execution_request(openai_request)

    assert converted.interactive_form_answer == request.interactive_form_answer


def test_round_trip_preserves_skip_git_clone_for_archive_recovery():
    request = ExecutionRequest(skip_git_clone=True)

    openai_request = OpenAIRequestConverter.from_execution_request(request)
    converted = OpenAIRequestConverter.to_execution_request(openai_request)

    assert openai_request["metadata"]["skip_git_clone"] is True
    assert converted.skip_git_clone is True


def test_round_trip_preserves_project_workspace_metadata():
    request = ExecutionRequest(
        workspace={"project": {"project_id": 42}},
        project_id=42,
        standalone_chat_workspace=True,
        workspace_source="local_path",
        project_workspace_path="/Users/test/project",
        execution_target_type="local",
        device_id="device-1",
    )

    openai_request = OpenAIRequestConverter.from_execution_request(request)
    converted = OpenAIRequestConverter.to_execution_request(openai_request)

    assert openai_request["metadata"]["project_id"] == 42
    assert converted.project_id == 42
    assert converted.standalone_chat_workspace is True
    assert converted.workspace_source == "local_path"
    assert converted.project_workspace_path == "/Users/test/project"
    assert converted.execution_target_type == "local"
    assert converted.device_id == "device-1"


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


def test_round_trip_preserves_knowledge_base_scopes():
    request = ExecutionRequest(
        knowledge_base_ids=[1, 2],
        knowledge_base_scopes=[
            KnowledgeBaseScope(
                knowledge_base_id=1,
                scope_restricted=True,
                document_ids=[101, 102],
            ),
            KnowledgeBaseScope(knowledge_base_id=2, scope_restricted=False),
        ],
    )

    openai_request = OpenAIRequestConverter.from_execution_request(request)
    converted = OpenAIRequestConverter.to_execution_request(openai_request)

    assert converted.knowledge_base_scopes == request.knowledge_base_scopes


def test_to_execution_request_ignores_malformed_scope_document_ids():
    request = OpenAIRequestConverter.to_execution_request(
        {
            "input": "hello",
            "metadata": {
                "knowledge_base_scopes": [
                    {
                        "knowledge_base_id": 1,
                        "scope_restricted": True,
                        "document_ids": 101,
                    }
                ]
            },
        }
    )

    assert request.knowledge_base_scopes == [
        KnowledgeBaseScope(knowledge_base_id=1, scope_restricted=True)
    ]
