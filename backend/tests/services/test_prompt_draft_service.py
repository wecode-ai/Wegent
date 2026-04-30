# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import asynccontextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.prompt_draft_service import (
    PromptDraftConversationTooShortError,
    PromptDraftGenerationFailedError,
    PromptDraftModelUnavailableError,
    PromptDraftTaskNotFoundError,
    _stream_prompt_text_generation,
    generate_prompt_draft,
    generate_prompt_draft_stream,
)


def _create_task(db: Session, user: User) -> TaskResource:
    task = TaskResource(
        user_id=user.id,
        kind="Task",
        name="task-prompt-draft-service",
        namespace="default",
        json={
            "metadata": {"name": "task-prompt-draft-service", "namespace": "default"},
            "spec": {"title": "Prompt Draft Task", "prompt": "seed prompt"},
            "status": {"status": "COMPLETED"},
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _add_user_subtask(db: Session, user: User, task: TaskResource, content: str):
    db.add(
        Subtask(
            user_id=user.id,
            task_id=task.id,
            team_id=1,
            title="user",
            bot_ids=[1],
            role=SubtaskRole.USER,
            executor_namespace="",
            executor_name="",
            prompt=content,
            status=SubtaskStatus.COMPLETED,
            progress=100,
            message_id=1,
            parent_id=0,
            completed_at=datetime.now(),
            result=None,
        )
    )
    db.commit()


def _add_assistant_subtask(db: Session, user: User, task: TaskResource, content: str):
    db.add(
        Subtask(
            user_id=user.id,
            task_id=task.id,
            team_id=1,
            title="assistant",
            bot_ids=[1],
            role=SubtaskRole.ASSISTANT,
            executor_namespace="",
            executor_name="",
            prompt="",
            status=SubtaskStatus.COMPLETED,
            progress=100,
            message_id=2,
            parent_id=0,
            completed_at=datetime.now(),
            result={"content": content},
        )
    )
    db.commit()


def _add_assistant_subtask_with_messages_chain(
    db: Session, user: User, task: TaskResource, assistant_contents: list[str]
):
    messages_chain = [{"role": "assistant", "content": c} for c in assistant_contents]
    db.add(
        Subtask(
            user_id=user.id,
            task_id=task.id,
            team_id=1,
            title="assistant-chain",
            bot_ids=[1],
            role=SubtaskRole.ASSISTANT,
            executor_namespace="",
            executor_name="",
            prompt="",
            status=SubtaskStatus.COMPLETED,
            progress=100,
            message_id=3,
            parent_id=0,
            completed_at=datetime.now(),
            result={
                "messages_chain": messages_chain,
                "value": "legacy-fallback-value",
            },
        )
    )
    db.commit()


def _add_assistant_subtask_with_tool_attempt(
    db: Session, user: User, task: TaskResource
):
    db.add(
        Subtask(
            user_id=user.id,
            task_id=task.id,
            team_id=1,
            title="assistant-tool-chain",
            bot_ids=[1],
            role=SubtaskRole.ASSISTANT,
            executor_namespace="",
            executor_name="",
            prompt="",
            status=SubtaskStatus.COMPLETED,
            progress=100,
            message_id=4,
            parent_id=0,
            completed_at=datetime.now(),
            result={
                "loaded_skills": ["mermaid-diagram"],
                "messages_chain": [
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "text": "我来帮您创建流程图。首先，我需要加载流程图相关的技能指导。",
                                "type": "text",
                                "index": 0,
                            },
                            {
                                "id": "tool_1",
                                "name": "load_skill",
                                "type": "tool_use",
                                "index": 1,
                                "input": {},
                                "partial_json": '{"skill_name":"mermaid-diagram"}',
                            },
                        ],
                        "tool_calls": [
                            {
                                "id": "tool_1",
                                "type": "function",
                                "function": {
                                    "name": "load_skill",
                                    "arguments": '{"skill_name":"mermaid-diagram"}',
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "name": "load_skill",
                        "content": "Skill 'mermaid-diagram' has been loaded.",
                        "tool_call_id": "tool_1",
                    },
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "text": "好的，流程图技能已加载。请告诉我主题和主要步骤。",
                                "type": "text",
                                "index": 0,
                            }
                        ],
                    },
                ],
            },
        )
    )
    db.commit()


def test_generate_prompt_draft_task_not_found(test_db: Session, test_user: User):
    with pytest.raises(PromptDraftTaskNotFoundError):
        generate_prompt_draft(
            db=test_db,
            task_id=999999,
            current_user=test_user,
            model="test-model",
            source="pet_panel",
        )


def test_generate_prompt_draft_conversation_too_short(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "只有一条用户消息")

    with pytest.raises(PromptDraftConversationTooShortError):
        generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model=None,
            source="pet_panel",
        )


def test_generate_prompt_draft_success_returns_prompt_contract(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "以后回答先给结论，再给执行步骤。")
    _add_assistant_subtask(test_db, test_user, task, "已收到，我会先给结论。")

    generated_prompt = "\n".join(
        [
            "你是协作助手，负责将需求转为可执行方案。",
            "",
            "## 你的工作方式",
            "- 先结论后步骤。",
            "",
            "## 处理任务时请遵循以下原则",
            "- 方案可执行、可复用。",
            "",
            "## 输出要求",
            "- 结构清晰。",
        ]
    )

    with (
        patch(
            "app.services.prompt_draft_service._resolve_model_config",
            return_value=(
                {
                    "provider": "openai",
                    "model_id": "gpt-test",
                    "modelType": "llm",
                },
                "gpt-test",
            ),
        ),
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.complete_text",
            new=AsyncMock(side_effect=[generated_prompt, "协作提示词"]),
        ),
    ):
        result = generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model=None,
            source="pet_panel",
        )

    assert result["title"] == "协作提示词"
    assert result["prompt"].startswith("你是")
    assert "\n\n## 你的工作方式\n" in result["prompt"]
    assert "\n\n## 处理任务时请遵循以下原则\n" in result["prompt"]
    assert "\n\n## 输出要求\n" in result["prompt"]
    assert result["model"] == "gpt-test"
    assert result["version"] == 1
    assert result["created_at"] is not None


def test_generate_prompt_draft_model_not_found(test_db: Session, test_user: User):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "请先给结论。")
    _add_assistant_subtask(test_db, test_user, task, "结论是可行。")

    with pytest.raises(ValueError, match="model_not_found"):
        generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model="missing-model",
            source="pet_panel",
        )


def test_generate_prompt_draft_requires_available_model(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "请先给结论。")
    _add_assistant_subtask(test_db, test_user, task, "结论是可行。")

    with pytest.raises(PromptDraftModelUnavailableError):
        generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model=None,
            source="pet_panel",
        )


def test_generate_prompt_draft_uses_chat_shell_skill_pipeline(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "先总结，再给执行步骤。")
    _add_assistant_subtask_with_messages_chain(
        test_db,
        test_user,
        task,
        ["收到，我会按这个结构回答。", "后续输出会更结构化。"],
    )

    generated_prompt = "\n".join(
        [
            "你是协作助手，负责将需求转为可执行方案。",
            "",
            "## 你的工作方式",
            "- 先结论后步骤。",
            "",
            "## 处理任务时请遵循以下原则",
            "- 方案可执行、可复用。",
            "",
            "## 输出要求",
            "- 结构清晰。",
        ]
    )

    with (
        patch(
            "app.services.prompt_draft_service._resolve_model_config",
            return_value=(
                {
                    "provider": "openai",
                    "model_id": "gpt-test",
                    "modelType": "llm",
                },
                "gpt-test",
            ),
        ),
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.complete_text",
            new=AsyncMock(side_effect=[generated_prompt, "协作提示词草案"]),
        ) as mock_complete_text,
    ):
        result = generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model="gpt-test",
            source="pet_panel",
        )

    assert result["title"] == "协作提示词草案"
    assert result["model"] == "gpt-test"
    assert result["prompt"].startswith("你是")

    assert mock_complete_text.await_count == 2
    first_call = mock_complete_text.await_args_list[0].kwargs
    assert isinstance(first_call["input_messages"], list)
    assert len(first_call["input_messages"]) == 2
    assert first_call["input_messages"][0]["role"] == "user"
    assert "<conversation>" in first_call["input_messages"][0]["content"]
    assert first_call["input_messages"][1]["role"] == "user"
    assert (
        "未来可直接给助手使用的系统提示词" in first_call["input_messages"][1]["content"]
    )
    assert first_call["metadata"]["history_limit"] == 0
    assert first_call["metadata"]["enable_tools"] is False


def test_generate_prompt_draft_uses_three_message_transcript_prompt(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "帮我创建一个流程图")
    _add_assistant_subtask_with_tool_attempt(test_db, test_user, task)

    generated_prompt = "\n".join(
        [
            "你是流程图协作助手，负责根据对话沉淀可复用协作提示词。",
            "",
            "## 你的工作方式",
            "- 优先提炼稳定协作方式。",
            "",
            "## 处理任务时请遵循以下原则",
            "- 不把一次性任务细节固化为长期规则。",
            "",
            "## 输出要求",
            "- 结果可直接作为系统提示词使用。",
        ]
    )

    with (
        patch(
            "app.services.prompt_draft_service._resolve_model_config",
            return_value=(
                {
                    "provider": "openai",
                    "model_id": "gpt-test",
                    "modelType": "llm",
                },
                "gpt-test",
            ),
        ),
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.complete_text",
            new=AsyncMock(side_effect=[generated_prompt, "流程图协作提示词"]),
        ) as mock_complete_text,
    ):
        generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model="gpt-test",
            source="pet_panel",
        )

    first_call = mock_complete_text.await_args_list[0].kwargs
    assert "未来可复用的系统提示词" in first_call["instructions"]
    assert len(first_call["input_messages"]) == 2
    assert first_call["input_messages"][0]["role"] == "user"
    assert "<conversation>" in first_call["input_messages"][0]["content"]
    assert "[user]" in first_call["input_messages"][0]["content"]
    assert "[assistant]" in first_call["input_messages"][0]["content"]
    assert "[assistant_attempt]" in first_call["input_messages"][0]["content"]
    assert "mermaid-diagram" in first_call["input_messages"][0]["content"]
    assert (
        "未来可直接给助手使用的系统提示词" in first_call["input_messages"][1]["content"]
    )
    assert (
        "调用 conversation_to_prompt 技能"
        not in first_call["input_messages"][1]["content"]
    )


def test_generate_prompt_draft_retries_when_first_prompt_echoes_extraction_task(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "帮我创建一个流程图")
    _add_assistant_subtask_with_tool_attempt(test_db, test_user, task)

    invalid_prompt = "\n".join(
        [
            "你是会话提炼助手，负责根据给定的用户会话记录提炼可复用的prompt草案。",
            "",
            "## 你的工作方式",
            "- 基于用户提供的会话记录进行提炼。",
            "",
            "## 处理任务时请遵循以下原则",
            "- 提炼稳定的协作方式。",
            "",
            "## 输出要求",
            "- 仅输出最终prompt正文。",
        ]
    )
    valid_prompt = "\n".join(
        [
            "你是流程图协作助手，负责帮助用户梳理流程、补齐关键信息，并输出可执行的流程图方案。",
            "",
            "## 你的工作方式",
            "- 先识别流程目标、参与对象和关键步骤。",
            "- 信息不足时先询问缺失的节点、分支和判断条件。",
            "",
            "## 处理任务时请遵循以下原则",
            "- 优先沉淀可复用的流程图协作方式，而不是复述一次性任务背景。",
            "- 输出应围绕流程图任务本身，不得转而描述会话提炼过程。",
            "",
            "## 输出要求",
            "- 结构清晰，便于后续直接复用或继续微调。",
        ]
    )

    with (
        patch(
            "app.services.prompt_draft_service._resolve_model_config",
            return_value=(
                {
                    "provider": "openai",
                    "model_id": "gpt-test",
                    "modelType": "llm",
                },
                "gpt-test",
            ),
        ),
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.complete_text",
            new=AsyncMock(
                side_effect=[
                    invalid_prompt,
                    valid_prompt,
                    "流程图协作提示词",
                ]
            ),
        ) as mock_complete_text,
    ):
        result = generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model="gpt-test",
            source="pet_panel",
        )

    assert result["prompt"] == valid_prompt
    assert result["title"] == "流程图协作提示词"
    assert mock_complete_text.await_count == 3

    retry_call = mock_complete_text.await_args_list[1].kwargs
    assert len(retry_call["input_messages"]) == 3
    assert "你刚才的输出不合格" in retry_call["input_messages"][2]["content"]
    assert "会话提炼助手" in retry_call["input_messages"][2]["content"]


def test_generate_prompt_draft_logs_do_not_include_model_secrets(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "先总结，再给执行步骤。")
    _add_assistant_subtask(test_db, test_user, task, "已收到，我会按这个结构回答。")

    generated_prompt = "\n".join(
        [
            "你是协作助手，负责将需求转为可执行方案。",
            "",
            "## 你的工作方式",
            "- 先结论后步骤。",
            "",
            "## 处理任务时请遵循以下原则",
            "- 方案可执行、可复用。",
            "",
            "## 输出要求",
            "- 结构清晰。",
        ]
    )
    model_config = {
        "provider": "openai",
        "model_id": "gpt-test",
        "api_key": "sk-secret-value",
        "default_headers": {"Authorization": "Bearer top-secret-header"},
    }

    with (
        patch(
            "app.services.prompt_draft_service._resolve_model_config",
            return_value=(model_config, "gpt-test"),
        ),
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.complete_text",
            new=AsyncMock(side_effect=[generated_prompt, "协作提示词"]),
        ),
        patch("app.services.prompt_draft_service.logger.info") as mock_logger_info,
    ):
        generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model="gpt-test",
            source="pet_panel",
        )

    logged_text = " ".join(
        str(arg) for call in mock_logger_info.call_args_list for arg in call.args
    )
    assert "sk-secret-value" not in logged_text
    assert "top-secret-header" not in logged_text


def test_generate_prompt_draft_raises_when_chat_shell_generation_fails(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "先总结，再给执行步骤。")
    _add_assistant_subtask(test_db, test_user, task, "已收到，我会按这个结构回答。")

    with (
        patch(
            "app.services.prompt_draft_service._resolve_model_config",
            return_value=(
                {
                    "provider": "openai",
                    "model_id": "gpt-test",
                    "modelType": "llm",
                },
                "gpt-test",
            ),
        ),
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.complete_text",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ),
    ):
        with pytest.raises(PromptDraftGenerationFailedError):
            generate_prompt_draft(
                db=test_db,
                task_id=task.id,
                current_user=test_user,
                model="gpt-test",
                source="pet_panel",
            )


def test_generate_prompt_draft_normalizes_single_line_prompt_to_markdown(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "帮我创建一个流程图")
    _add_assistant_subtask(test_db, test_user, task, "先告诉我主题和主要步骤。")

    single_line_prompt = (
        "你是流程图协作助手，负责帮助用户梳理流程、补齐关键信息，并输出可执行的流程图方案。"
        "你的工作方式：先识别流程目标、参与对象和关键步骤。"
        "处理任务时请遵循以下原则：信息不足时优先追问缺失环节。"
        "输出要求：结果可直接作为系统提示词使用。"
    )

    with (
        patch(
            "app.services.prompt_draft_service._resolve_model_config",
            return_value=(
                {
                    "provider": "openai",
                    "model_id": "gpt-test",
                    "modelType": "llm",
                },
                "gpt-test",
            ),
        ),
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.complete_text",
            new=AsyncMock(side_effect=[single_line_prompt, "流程图协作提示词"]),
        ),
    ):
        result = generate_prompt_draft(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model="gpt-test",
            source="pet_panel",
        )

    assert result["prompt"].startswith("你是流程图协作助手")
    assert "\n\n## 你的工作方式\n" in result["prompt"]
    assert "\n\n## 处理任务时请遵循以下原则\n" in result["prompt"]
    assert "\n\n## 输出要求\n" in result["prompt"]
    assert "- 先识别流程目标、参与对象和关键步骤。" in result["prompt"]
    assert "- 信息不足时优先追问缺失环节。" in result["prompt"]
    assert "- 结果可直接作为系统提示词使用。" in result["prompt"]


@pytest.mark.asyncio
async def test_stream_prompt_generation_logs_do_not_include_model_secrets():
    async def _mock_stream():
        yield SimpleNamespace(type="response.output_text.delta", delta="你是")

    @asynccontextmanager
    async def _mock_streaming_response(**kwargs):
        yield _mock_stream()

    with (
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.create_streaming_response",
            new=_mock_streaming_response,
        ),
        patch("app.services.prompt_draft_service.logger.info") as mock_logger_info,
    ):
        chunks = [
            chunk
            async for chunk in _stream_prompt_text_generation(
                model_id="gpt-test",
                input_messages=[{"role": "user", "content": "hello"}],
                prompt_instructions="system",
                metadata={"history_limit": 0},
                model_config={
                    "model_id": "gpt-test",
                    "api_key": "sk-stream-secret",
                    "default_headers": {"Authorization": "Bearer stream-secret"},
                },
            )
        ]

    assert chunks == ["你是"]
    logged_text = " ".join(
        str(arg) for call in mock_logger_info.call_args_list for arg in call.args
    )
    assert "sk-stream-secret" not in logged_text
    assert "stream-secret" not in logged_text


@pytest.mark.asyncio
async def test_generate_prompt_draft_stream_requires_available_model(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "请先给结论。")
    _add_assistant_subtask(test_db, test_user, task, "结论是可行。")

    with pytest.raises(PromptDraftModelUnavailableError):
        async for _ in generate_prompt_draft_stream(
            db=test_db,
            task_id=task.id,
            current_user=test_user,
            model=None,
            source="pet_panel",
        ):
            pass


@pytest.mark.asyncio
async def test_generate_prompt_draft_stream_raises_when_chat_shell_generation_fails(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "帮我创建一个流程图")
    _add_assistant_subtask(test_db, test_user, task, "先告诉我主题和主要步骤。")

    @asynccontextmanager
    async def _mock_streaming_response_that_raises(**kwargs):
        raise RuntimeError("stream boom")
        yield  # never reached

    with (
        patch(
            "app.services.prompt_draft_service._resolve_model_config",
            return_value=(
                {
                    "provider": "openai",
                    "model_id": "gpt-test",
                    "modelType": "llm",
                },
                "gpt-test",
            ),
        ),
        patch(
            "app.services.prompt_draft_service.chat_shell_model_service.create_streaming_response",
            new=_mock_streaming_response_that_raises,
        ),
    ):
        with pytest.raises(PromptDraftGenerationFailedError):
            async for _ in generate_prompt_draft_stream(
                db=test_db,
                task_id=task.id,
                current_user=test_user,
                model="gpt-test",
                source="pet_panel",
            ):
                pass
