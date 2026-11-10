# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""REST cancellation must hold the attempt observed at request acceptance."""

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

import app.stores.tasks as task_stores
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.adapters.task_kinds.operations import TaskOperationsMixin
from app.services.chat.operations import cancel as cancel_ops
from tests.services.chat.operations.test_cancel_stuck import _task_json


@pytest.mark.asyncio
@pytest.mark.parametrize("task_status", ["RUNNING", "CANCELLING"])
@pytest.mark.parametrize(
    "outcome", ["idle", "new_attempt", "late_attempt", "commit_failure"]
)
async def test_empty_cancel_repairs_only_an_idle_task_projection(
    monkeypatch, task_status, outcome
):
    service = object.__new__(TaskOperationsMixin)
    service.get_task_detail = MagicMock(
        return_value={
            "status": task_status,
            "updated_at": datetime.now() - timedelta(hours=1),
        }
    )
    service._is_chat_shell_task = MagicMock(return_value=True)
    task = SimpleNamespace(id=1, user_id=7, json=_task_json(task_status))
    active = SimpleNamespace(role=SubtaskRole.ASSISTANT)
    reads = MagicMock(
        side_effect=[
            [],
            [active] if outcome == "new_attempt" else [],
            [active] if outcome == "late_attempt" else [],
        ]
    )
    monkeypatch.setattr(task_stores.subtask_store, "list_by_task_statuses", reads)
    monkeypatch.setattr(
        task_stores.subtask_store,
        "get_latest_assistant_for_user_by_statuses",
        MagicMock(return_value=None),
    )
    monkeypatch.setattr(
        task_stores.task_store, "get_owned_active_task", MagicMock(return_value=task)
    )
    write = MagicMock()
    monkeypatch.setattr(task_stores.task_store, "update_json", write)
    runner = MagicMock()
    db = MagicMock()
    if outcome == "commit_failure":
        db.commit.side_effect = RuntimeError("commit acknowledgement lost")
    if outcome != "idle":
        with pytest.raises(HTTPException) as rejected:
            await service.cancel_task(
                db=db, task_id=1, user_id=7, background_task_runner=runner
            )
        assert rejected.value.status_code == (
            503 if outcome == "commit_failure" else 409
        )
        db.rollback.assert_called()
        if outcome in {"new_attempt", "late_attempt"}:
            write.assert_not_called()
            db.commit.assert_not_called()
    else:
        result = await service.cancel_task(
            db=db, task_id=1, user_id=7, background_task_runner=runner
        )
        assert result["status"] == "CANCELLED"
        assert write.call_args.kwargs["payload"]["status"]["status"] == "CANCELLED"
        db.refresh.assert_called_once_with(task, with_for_update=True)
        db.commit.assert_called_once()
    assert reads.call_args.kwargs["for_update"] is True
    if outcome != "new_attempt":
        assert reads.call_args.kwargs["nowait"] is True
    runner.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("task_status", ["RUNNING", "CANCELLING"])
@pytest.mark.parametrize("captured_identity", [None, "a" * 32])
async def test_late_rest_cancel_cannot_cancel_retry(
    monkeypatch, task_status, captured_identity
):
    service = object.__new__(TaskOperationsMixin)
    service.get_task_detail = MagicMock(
        return_value={
            "status": task_status,
            "updated_at": datetime.now() - timedelta(hours=1),
        }
    )
    service._is_chat_shell_task = MagicMock(return_value=True)
    service.update_task = MagicMock()
    old = SimpleNamespace(
        id=100,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
        answer_generation_id=captured_identity,
        result={"value": "A"},
    )
    retry = SimpleNamespace(
        id=100,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
        answer_generation_id="b" * 32,
        result={"value": "B"},
    )
    visible = [old]
    task = SimpleNamespace(id=1, json=_task_json(task_status))

    def read_after_retry(*args, **kwargs):
        visible[:] = [retry]
        return task

    def running_after_retry(*args, **kwargs):
        visible[:] = [retry]
        return retry

    def compare_attempt(db, **kwargs):
        if kwargs["generation_id"] != retry.answer_generation_id:
            return False
        retry.status = kwargs["status"]
        return True

    monkeypatch.setattr(
        task_stores.subtask_store,
        "list_by_task_statuses",
        MagicMock(side_effect=lambda *a, **k: list(visible)),
    )
    monkeypatch.setattr(
        task_stores.subtask_store,
        "get_latest_assistant_for_user_by_statuses",
        running_after_retry,
    )
    monkeypatch.setattr(
        task_stores.task_store, "get_regular_active_task", read_after_retry
    )
    plain_write = MagicMock()
    monkeypatch.setattr(task_stores.subtask_store, "update_fields", plain_write)
    monkeypatch.setattr(
        task_stores.subtask_store, "update_fields_if_attempt", compare_attempt
    )
    task_write = MagicMock()
    monkeypatch.setattr(task_stores.task_store, "update_json", task_write)
    published = AsyncMock()
    monkeypatch.setattr(cancel_ops, "publish_task_cancelled_events", published)
    runner = MagicMock()
    db = MagicMock()

    with pytest.raises(HTTPException) as rejected:
        await service.cancel_task(
            db=db, task_id=1, user_id=7, background_task_runner=runner
        )

    assert rejected.value.status_code == 409
    assert retry.status == SubtaskStatus.RUNNING
    assert retry.result == {"value": "B"}
    assert retry.answer_generation_id == "b" * 32
    plain_write.assert_not_called()
    task_write.assert_not_called()
    service.update_task.assert_not_called()
    published.assert_not_awaited()
    runner.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("identity", [None, "a" * 32])
@pytest.mark.parametrize("commit_fails", [False, True])
@pytest.mark.parametrize(
    "answer_status", [SubtaskStatus.PENDING, SubtaskStatus.RUNNING]
)
async def test_rest_cancel_schedules_only_after_confirmed_commit(
    monkeypatch, identity, commit_fails, answer_status
):
    service = object.__new__(TaskOperationsMixin)
    service.get_task_detail = MagicMock(return_value={"status": "RUNNING"})
    service._is_chat_shell_task = MagicMock(return_value=True)
    service.update_task = MagicMock()
    row = SimpleNamespace(
        id=100,
        role=SubtaskRole.ASSISTANT,
        status=answer_status,
        answer_generation_id=identity,
        result={"value": "partial answer"},
    )
    task = SimpleNamespace(id=1, json=_task_json("RUNNING"))
    monkeypatch.setattr(
        task_stores.subtask_store,
        "list_by_task_statuses",
        MagicMock(return_value=[row]),
    )
    monkeypatch.setattr(
        task_stores.subtask_store,
        "get_latest_assistant_for_user_by_statuses",
        MagicMock(return_value=row),
    )
    compare = MagicMock(return_value=True)
    monkeypatch.setattr(task_stores.subtask_store, "update_fields_if_attempt", compare)
    monkeypatch.setattr(
        task_stores.task_store, "get_owned_active_task", MagicMock(return_value=task)
    )
    task_write = MagicMock()
    monkeypatch.setattr(task_stores.task_store, "update_json", task_write)
    committed = False

    def commit():
        nonlocal committed
        assert task_write.call_args.kwargs["payload"]["status"]["status"] == "CANCELLED"
        if commit_fails:
            raise OSError("commit connection lost")
        committed = True

    def schedule(*args):
        assert committed

    db = MagicMock()
    db.commit.side_effect = commit
    runner = MagicMock(side_effect=schedule)
    if commit_fails:
        with pytest.raises(HTTPException) as failed:
            await service.cancel_task(
                db=db, task_id=1, user_id=7, background_task_runner=runner
            )
        assert failed.value.status_code == 503
        assert "未确认" in failed.value.detail
        runner.assert_not_called()
        db.rollback.assert_called_once()
    else:
        result = await service.cancel_task(
            db=db, task_id=1, user_id=7, background_task_runner=runner
        )
        assert result["status"] == "CANCELLED"
        runner.assert_called_once_with(service._call_chat_shell_cancel, 100, identity)
    assert compare.call_args.kwargs["generation_id"] == identity
    assert compare.call_args.kwargs["from_statuses"] == (
        SubtaskStatus.PENDING,
        SubtaskStatus.RUNNING,
    )
    assert "result" not in compare.call_args.kwargs
    service.update_task.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "current_identity,expected_calls", [("a" * 32, 1), ("b" * 32, 0)]
)
async def test_delayed_rest_cancel_signal_keeps_captured_identity(
    monkeypatch, current_identity, expected_calls
):
    service = object.__new__(TaskOperationsMixin)
    row = SimpleNamespace(
        answer_generation_id=current_identity, status=SubtaskStatus.CANCELLED
    )
    monkeypatch.setattr("app.db.session.SessionLocal", MagicMock())
    monkeypatch.setattr(
        task_stores.subtask_store, "get_by_id", MagicMock(return_value=row)
    )
    signal = MagicMock(return_value=True)
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager.cancel_stream_from_sync", signal
    )

    await service._call_chat_shell_cancel(100, "a" * 32)

    assert signal.call_count == expected_calls
    if expected_calls:
        assert signal.call_args.args[0] == 100


def test_stuck_cancel_with_empty_snapshot_cannot_adopt_current_identity(monkeypatch):
    task = SimpleNamespace(id=1, json=_task_json("CANCELLING"))
    row = SimpleNamespace(
        id=100,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
        answer_generation_id="b" * 32,
    )
    monkeypatch.setattr(
        task_stores.task_store, "get_regular_active_task", MagicMock(return_value=task)
    )
    monkeypatch.setattr(
        task_stores.subtask_store,
        "list_by_task_statuses",
        MagicMock(return_value=[row]),
    )
    compare = MagicMock()
    monkeypatch.setattr(task_stores.subtask_store, "update_fields_if_attempt", compare)
    task_write = MagicMock()
    monkeypatch.setattr(task_stores.task_store, "update_json", task_write)
    db = MagicMock()

    assert cancel_ops.finalize_stuck_cancellation(db, task_id=1, attempts={}) == []

    compare.assert_not_called()
    task_write.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.asyncio
async def test_rest_cancel_holds_attempt_until_signal_is_published(monkeypatch):
    service = object.__new__(TaskOperationsMixin)
    old = SimpleNamespace(answer_generation_id="a" * 32, status=SubtaskStatus.CANCELLED)
    guarded = False
    published = []
    db = MagicMock()

    def lock_row(*args, **kwargs):
        nonlocal guarded
        assert kwargs["with_for_update"] is True
        guarded = True

    def close_transaction(*args):
        nonlocal guarded
        guarded = False
        if not published:
            old.answer_generation_id = "b" * 32

    def publish(subtask_id, *args):
        published.append((guarded, old.answer_generation_id))
        return True

    async def publish_async(subtask_id):
        return publish(subtask_id)

    factory = MagicMock()
    factory.return_value.__enter__.return_value = db
    factory.return_value.__exit__.side_effect = close_transaction
    db.refresh.side_effect = lock_row
    monkeypatch.setattr("app.db.session.SessionLocal", factory)
    monkeypatch.setattr(
        task_stores.subtask_store, "get_by_id", MagicMock(return_value=old)
    )
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager.cancel_stream", publish_async
    )
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager.cancel_stream_from_sync",
        publish,
        raising=False,
    )

    await service._call_chat_shell_cancel(100, "a" * 32)

    assert published == [(True, "a" * 32)]
