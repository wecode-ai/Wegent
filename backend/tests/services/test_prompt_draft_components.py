# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.prompt_draft.modeling import resolve_prompt_draft_model_config
from app.services.prompt_draft.transcript import (
    collect_conversation_blocks,
    extract_assistant_turn_blocks,
)


def _create_task(db: Session, user: User) -> TaskResource:
    task = TaskResource(
        user_id=user.id,
        kind="Task",
        name="task-prompt-draft-components",
        namespace="default",
        json={
            "metadata": {
                "name": "task-prompt-draft-components",
                "namespace": "default",
            },
            "spec": {"title": "Prompt Draft Components", "prompt": "seed prompt"},
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
            message_id=2,
            parent_id=0,
            completed_at=datetime.now(),
            result={
                "loaded_skills": ["mermaid-diagram"],
                "messages_chain": [
                    {
                        "role": "assistant",
                        "content": [
                            {"text": "我来帮您创建流程图。", "type": "text", "index": 0}
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
                ],
            },
        )
    )
    db.commit()


def test_extract_assistant_turn_blocks_includes_tool_attempt_summary():
    result = {
        "loaded_skills": ["mermaid-diagram"],
        "messages_chain": [
            {
                "role": "assistant",
                "content": [{"text": "先加载技能。", "type": "text"}],
                "tool_calls": [
                    {
                        "type": "function",
                        "function": {
                            "name": "load_skill",
                            "arguments": '{"skill_name":"mermaid-diagram"}',
                        },
                    }
                ],
            }
        ],
    }

    blocks = extract_assistant_turn_blocks(result)

    assert ("assistant", "先加载技能。") in blocks
    assert any(
        block_type == "assistant_attempt" and "mermaid-diagram" in content
        for block_type, content in blocks
    )


def test_collect_conversation_blocks_reads_user_and_assistant_attempts(
    test_db: Session, test_user: User
):
    task = _create_task(test_db, test_user)
    _add_user_subtask(test_db, test_user, task, "帮我创建流程图")
    _add_assistant_subtask_with_tool_attempt(test_db, test_user, task)

    blocks = collect_conversation_blocks(test_db, task.id)

    assert ("user", "帮我创建流程图") in blocks
    assert any(block_type == "assistant_attempt" for block_type, _ in blocks)


def test_resolve_prompt_draft_model_config_returns_empty_name_when_no_model(
    test_db: Session, test_user: User
):
    model_config, selected_model = resolve_prompt_draft_model_config(
        test_db, test_user, None
    )

    assert model_config is None
    assert selected_model == ""
