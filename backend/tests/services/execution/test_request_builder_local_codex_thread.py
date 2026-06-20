# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for propagating local Codex thread metadata into execution requests."""

from types import SimpleNamespace

from app.core.constants import (
    LABEL_LOCAL_CODEX_DEVICE_ID,
    LABEL_LOCAL_CODEX_THREAD_ID,
    WORKSPACE_SOURCE_LOCAL_CODEX_THREAD,
)
from app.services.execution.request_builder import TaskRequestBuilder


def _task(source: str | None = None, *, include_path: bool = True) -> SimpleNamespace:
    labels = {}
    if source == WORKSPACE_SOURCE_LOCAL_CODEX_THREAD:
        labels = {
            LABEL_LOCAL_CODEX_THREAD_ID: "018f2d6b-8c7a-7abc-9def-0123456789ab",
            LABEL_LOCAL_CODEX_DEVICE_ID: "device-abc",
        }
    workspace = {"source": source}
    if include_path:
        workspace["path"] = "codex://018f2d6b-8c7a-7abc-9def-0123456789ab"
    return SimpleNamespace(
        json={
            "metadata": {"labels": labels},
            "spec": {"execution": {"workspace": workspace}},
        }
    )


def test_local_codex_thread_metadata_is_extracted_for_bound_tasks() -> None:
    metadata = TaskRequestBuilder._extract_local_codex_binding_metadata(
        _task(WORKSPACE_SOURCE_LOCAL_CODEX_THREAD)
    )

    assert metadata == {
        "local_codex_thread_id": "018f2d6b-8c7a-7abc-9def-0123456789ab",
        "local_codex_device_id": "device-abc",
    }


def test_local_codex_thread_metadata_is_none_for_normal_tasks() -> None:
    metadata = TaskRequestBuilder._extract_local_codex_binding_metadata(
        _task("local_path")
    )

    assert metadata == {
        "local_codex_thread_id": None,
        "local_codex_device_id": None,
    }


def test_local_codex_thread_workspace_source_is_preserved_without_path() -> None:
    task = _task(WORKSPACE_SOURCE_LOCAL_CODEX_THREAD, include_path=False)
    task.user_id = 7
    task.project_id = 0
    workspace_data = {}

    merged = TaskRequestBuilder(db=object())._merge_task_spec_execution_workspace(
        task,
        workspace_data,
    )

    assert merged is True
    assert (
        workspace_data["project"]["workspace_source"]
        == WORKSPACE_SOURCE_LOCAL_CODEX_THREAD
    )
    assert workspace_data["project"]["project_workspace_path"] is None


def test_build_sets_local_codex_thread_fields_on_execution_request(monkeypatch) -> None:
    from app.services.execution import request_builder

    builder = TaskRequestBuilder(db=object())
    task = _task(WORKSPACE_SOURCE_LOCAL_CODEX_THREAD)
    task.id = 101
    task.user_id = 7
    task.project_id = 0
    task.client_origin = "wework"
    subtask = SimpleNamespace(id=202, message_id=303, executor_name=None)
    user = SimpleNamespace(id=7, user_name="testuser", git_info=None)
    team = SimpleNamespace(
        id=404,
        name="team",
        namespace="default",
        user_id=7,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "team", "namespace": "default"},
            "spec": {
                "members": [{"botRef": {"name": "bot", "namespace": "default"}}],
                "collaborationModel": "solo",
            },
        },
    )
    bot = SimpleNamespace(id=505, name="bot", namespace="default", json={"spec": {}})

    monkeypatch.setattr(builder, "_get_bot_for_subtask", lambda *args: bot)
    monkeypatch.setattr(builder, "_build_workspace", lambda task: {"project": {}})
    monkeypatch.setattr(builder, "_get_model_config", lambda **kwargs: {})
    monkeypatch.setattr(builder, "_get_base_system_prompt", lambda **kwargs: "")
    monkeypatch.setattr(builder, "_inject_conditional_provider_skills", lambda **kw: [])
    monkeypatch.setattr(builder, "_inject_subscription_manager_skill", lambda **kw: [])
    monkeypatch.setattr(builder, "_get_bot_skills", lambda **kw: ([], [], [], {}))
    monkeypatch.setattr(
        builder,
        "_build_bot_config",
        lambda *args, **kwargs: [{"name": "bot", "shell_type": "Chat"}],
    )
    monkeypatch.setattr(builder, "_generate_auth_token", lambda *args: "auth")
    monkeypatch.setattr(
        builder, "_generate_skill_identity_token", lambda *args: "skill-auth"
    )
    monkeypatch.setattr(builder, "_build_mcp_servers", lambda *args, **kwargs: [])
    monkeypatch.setattr(builder, "_is_tool_output_guard_enabled", lambda user: False)
    monkeypatch.setattr(builder, "_build_request_task_data", lambda user: {})
    monkeypatch.setattr(builder, "_derive_task_mode", lambda task: "chat")
    monkeypatch.setattr(
        request_builder.skill_binding_service,
        "list_user_default_skill_refs",
        lambda *args, **kwargs: [],
    )

    request = builder.build(
        subtask=subtask,
        task=task,
        user=user,
        team=team,
        message="continue",
    )

    assert request.local_codex_thread_id == "018f2d6b-8c7a-7abc-9def-0123456789ab"
    assert request.local_codex_device_id == "device-abc"
