# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.chat.access import permissions
from app.services.chat.correction import service as correction_service
from app.services.chat.interactive_forms import get_pending_interactive_form
from app.services.chat.operations import cancel, retry
from app.services.chat.trigger import lifecycle


class _NoModelCrudDb:
    def query(self, *_args, **_kwargs):
        raise AssertionError("chat service must use task/subtask stores")

    def get(self, *_args, **_kwargs):
        raise AssertionError("chat service must use task/subtask stores")

    def close(self):
        pass


def _subtask(**overrides):
    values = {
        "id": 10,
        "task_id": 100,
        "user_id": 7,
        "role": SubtaskRole.ASSISTANT,
        "status": SubtaskStatus.COMPLETED,
        "message_id": 2,
        "parent_id": 1,
        "prompt": "prompt",
        "result": {"value": "answer"},
        "created_at": None,
        "contexts": [],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_interactive_form_reads_subtasks_through_store(monkeypatch):
    store = SimpleNamespace(
        list_by_task_desc=lambda db, task_id: [
            _subtask(
                result={
                    "blocks": [
                        {
                            "id": "tool-1",
                            "tool_name": "interactive_form_question",
                            "render_payload": {
                                "type": "interactive_form_question",
                                "questions": [{"id": "q"}],
                            },
                        }
                    ]
                }
            )
        ]
    )
    monkeypatch.setattr(
        "app.services.chat.interactive_forms.subtask_store",
        store,
        raising=False,
    )

    pending = get_pending_interactive_form(_NoModelCrudDb(), task_id=100)

    assert pending is not None
    assert pending.tool_use_id == "tool-1"


@pytest.mark.asyncio
async def test_lifecycle_loads_existing_result_through_store(monkeypatch):
    store = SimpleNamespace(
        get_by_id=lambda db, subtask_id: _subtask(result={"value": "stored"})
    )
    monkeypatch.setattr(lifecycle, "subtask_store", store, raising=False)
    monkeypatch.setattr(
        lifecycle, "SessionLocal", lambda: _NoModelCrudDb(), raising=False
    )

    result = await lifecycle._get_existing_subtask_result(10)

    assert result == {"value": "stored"}


def test_can_access_task_uses_access_store(monkeypatch):
    store = SimpleNamespace(is_member=lambda db, task_id, user_id: True)
    monkeypatch.setattr(permissions, "task_access_store", store, raising=False)

    assert permissions.can_access_task.__wrapped__(_NoModelCrudDb(), 7, 100) is True


def test_active_streaming_db_fallback_uses_subtask_store(monkeypatch):
    store = SimpleNamespace(
        get_latest_running_assistant_by_task=lambda db, task_id: _subtask(
            status=SubtaskStatus.RUNNING
        )
    )
    monkeypatch.setattr(permissions, "subtask_store", store, raising=False)

    result = permissions._get_active_streaming_from_db.__wrapped__(
        _NoModelCrudDb(),
        100,
    )

    assert result["subtask_id"] == 10


def test_active_streaming_subtask_validation_rejects_terminal_subtask(monkeypatch):
    store = SimpleNamespace(
        get_basic_by_id=lambda db, subtask_id: _subtask(status=SubtaskStatus.CANCELLED)
    )
    monkeypatch.setattr(permissions, "subtask_store", store, raising=False)

    result = permissions._is_streaming_subtask_active.__wrapped__(
        _NoModelCrudDb(),
        100,
        10,
    )

    assert result is False


@pytest.mark.asyncio
async def test_active_streaming_ignores_stale_redis_status(monkeypatch):
    mock_session_manager = SimpleNamespace(
        get_task_streaming_status=AsyncMock(
            return_value={
                "subtask_id": 10,
                "user_id": 7,
            }
        ),
        cleanup_streaming_state=AsyncMock(),
    )
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager",
        mock_session_manager,
        raising=False,
    )
    monkeypatch.setattr(
        permissions,
        "_is_streaming_subtask_active",
        AsyncMock(return_value=False),
        raising=False,
    )
    monkeypatch.setattr(
        permissions,
        "_get_active_streaming_from_db",
        AsyncMock(return_value=None),
        raising=False,
    )

    result = await permissions.get_active_streaming(100)

    assert result is None
    mock_session_manager.cleanup_streaming_state.assert_awaited_once_with(
        10,
        task_id=100,
    )


@pytest.mark.asyncio
async def test_active_streaming_keeps_valid_redis_status(monkeypatch):
    mock_session_manager = SimpleNamespace(
        get_task_streaming_status=AsyncMock(
            return_value={
                "subtask_id": "10",
                "user_id": 7,
            }
        ),
        get_streaming_content=AsyncMock(return_value="hello"),
        cleanup_streaming_state=AsyncMock(),
    )
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager",
        mock_session_manager,
        raising=False,
    )
    monkeypatch.setattr(
        permissions,
        "_is_streaming_subtask_active",
        AsyncMock(return_value=True),
        raising=False,
    )
    monkeypatch.setattr(
        permissions,
        "_get_active_streaming_from_db",
        AsyncMock(return_value=None),
        raising=False,
    )

    result = await permissions.get_active_streaming(100)

    assert result == {"subtask_id": 10, "user_id": 7}
    mock_session_manager.get_streaming_content.assert_awaited_once_with(10)
    mock_session_manager.cleanup_streaming_state.assert_not_awaited()


def test_correction_history_reads_subtasks_through_store(monkeypatch):
    store = SimpleNamespace(
        list_completed_before_message_id=lambda db, task_id, before_message_id: [
            _subtask(role=SubtaskRole.USER, message_id=1, prompt="question"),
            _subtask(
                role=SubtaskRole.ASSISTANT, message_id=2, result={"value": "answer"}
            ),
        ]
    )
    monkeypatch.setattr(correction_service, "subtask_store", store, raising=False)

    history = correction_service.build_chat_history(
        _NoModelCrudDb(),
        task_id=100,
        before_message_id=3,
    )

    assert history == [
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "answer"},
    ]


def test_retry_context_reads_task_and_subtasks_through_stores(monkeypatch):
    failed = _subtask(parent_id=1, team_id=20)
    user_subtask = _subtask(role=SubtaskRole.USER, message_id=1)
    task = SimpleNamespace(id=100)
    team = SimpleNamespace(id=20)
    monkeypatch.setattr(
        retry,
        "subtask_store",
        SimpleNamespace(
            get_retry_assistant=lambda db, task_id, subtask_id: failed,
            get_user_by_task_message_id=lambda db, task_id, message_id: user_subtask,
        ),
        raising=False,
    )
    monkeypatch.setattr(
        retry,
        "task_store",
        SimpleNamespace(get_non_deleted_task=lambda db, task_id: task),
        raising=False,
    )

    class _Db(_NoModelCrudDb):
        def query(self, model):
            assert model is retry.Kind

            class _Query:
                def filter(self, *_args, **_kwargs):
                    return self

                def first(self):
                    return team

            return _Query()

    assert retry.fetch_retry_context(_Db(), 100, 10) == (
        failed,
        task,
        team,
        user_subtask,
    )


@pytest.mark.asyncio
async def test_cancel_executor_path_reads_subtask_through_store(monkeypatch):
    calls = []
    monkeypatch.setattr(cancel, "SessionLocal", lambda: _NoModelCrudDb(), raising=False)
    monkeypatch.setattr(
        cancel,
        "subtask_store",
        SimpleNamespace(get_by_id=lambda db, subtask_id: _subtask(task_id=100)),
        raising=False,
    )
    monkeypatch.setattr(
        "app.services.chat.operations.executor.call_executor_cancel",
        AsyncMock(side_effect=lambda task_id: calls.append(task_id)),
    )

    await cancel.cancel_chat_stream(10, shell_type="ClaudeCode")

    assert calls == [100]
