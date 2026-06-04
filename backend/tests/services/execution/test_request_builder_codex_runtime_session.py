# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.models.subtask import Subtask, SubtaskRole
from app.services.execution.request_builder import TaskRequestBuilder


def _task_json(runtime_session_id: str | None = None) -> dict:
    status = {"status": "PENDING"}
    if runtime_session_id:
        status["runtime"] = {
            "sessions": {
                "codex": {
                    "provider": "codex",
                    "id": runtime_session_id,
                    "updatedAt": "2026-06-04T10:00:00",
                }
            }
        }
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": "task-1", "namespace": "default", "labels": {}},
        "spec": {
            "title": "Task 1",
            "prompt": "hello",
            "teamRef": {"name": "team", "namespace": "default"},
            "workspaceRef": {"name": "workspace", "namespace": "default"},
        },
        "status": status,
    }


def _team_json() -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Team",
        "metadata": {"name": "team", "namespace": "default"},
        "spec": {
            "members": [{"botRef": {"name": "bot", "namespace": "default"}}],
            "collaborationModel": "solo",
        },
    }


def _build_codex_request(monkeypatch, *, runtime_session_id=None, prior_turn=False):
    monkeypatch.setattr(
        "app.services.execution.request_builder.skill_binding_service.list_user_default_skill_refs",
        lambda *args, **kwargs: [],
    )

    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    builder.db = MagicMock()
    bot = SimpleNamespace(id=68, name="bot", json={})

    monkeypatch.setattr(builder, "_get_bot_for_subtask", lambda *args: bot)
    monkeypatch.setattr(builder, "_build_workspace", lambda task: {})
    monkeypatch.setattr(builder, "_build_user_info", lambda user, git_domain: {})
    monkeypatch.setattr(
        builder,
        "_get_model_config",
        lambda **kwargs: {
            "model": "openai",
            "model_id": "gpt-5.5",
            "api_format": "responses",
        },
    )
    monkeypatch.setattr(builder, "_get_base_system_prompt", lambda **kwargs: "")
    monkeypatch.setattr(
        builder,
        "_inject_conditional_provider_skills",
        lambda **kwargs: kwargs["preload_skills"],
    )
    monkeypatch.setattr(
        builder, "_inject_subscription_manager_skill", lambda **kwargs: []
    )
    monkeypatch.setattr(builder, "_build_skill_binding_context", lambda **kwargs: None)
    monkeypatch.setattr(builder, "_get_bot_skills", lambda **kwargs: ([], [], [], {}))
    monkeypatch.setattr(
        builder,
        "_build_bot_config",
        lambda *args, **kwargs: [{"id": 68, "shell_type": "ClaudeCode"}],
    )
    monkeypatch.setattr(builder, "_generate_auth_token", lambda *args: "task-token")
    monkeypatch.setattr(builder, "_generate_skill_identity_token", lambda *args: "")
    monkeypatch.setattr(builder, "_build_mcp_servers", lambda *args, **kwargs: [])
    monkeypatch.setattr(builder, "_is_group_chat", lambda task: False)
    monkeypatch.setattr(builder, "_build_request_task_data", lambda user: {})
    monkeypatch.setattr(
        builder,
        "_has_prior_assistant_turn",
        lambda task_id, current_subtask: prior_turn,
    )

    task = SimpleNamespace(
        id=1,
        json=_task_json(runtime_session_id),
        project_id=0,
    )
    subtask = SimpleNamespace(id=2, message_id=4, executor_name=None)
    team = SimpleNamespace(id=3, name="team", namespace="default", json=_team_json())
    user = SimpleNamespace(id=4, user_name="alice")

    return builder.build(
        subtask=subtask,
        task=task,
        user=user,
        team=team,
        message="hello",
    )


def test_codex_first_turn_allows_missing_runtime_session(monkeypatch):
    request = _build_codex_request(
        monkeypatch,
        runtime_session_id=None,
        prior_turn=False,
    )

    assert request.runtime_session_provider == "codex"
    assert request.runtime_session_id is None


def test_codex_existing_turn_requires_runtime_session(monkeypatch):
    with pytest.raises(ValueError, match="Codex runtime session is missing"):
        _build_codex_request(
            monkeypatch,
            runtime_session_id=None,
            prior_turn=True,
        )


def test_codex_existing_turn_uses_runtime_session(monkeypatch):
    request = _build_codex_request(
        monkeypatch,
        runtime_session_id="thread-123",
        prior_turn=True,
    )

    assert request.runtime_session_provider == "codex"
    assert request.runtime_session_id == "thread-123"


def test_prior_assistant_turn_falls_back_to_subtask_id(test_db):
    prior_subtask = Subtask(
        user_id=1,
        task_id=1,
        team_id=1,
        title="prior",
        bot_ids=[68],
        role=SubtaskRole.ASSISTANT,
        prompt="prior",
        message_id=1,
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add(prior_subtask)
    test_db.commit()
    test_db.refresh(prior_subtask)

    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    builder.db = test_db
    current_subtask = SimpleNamespace(id=prior_subtask.id + 1, message_id=None)

    assert builder._has_prior_assistant_turn(1, current_subtask)
