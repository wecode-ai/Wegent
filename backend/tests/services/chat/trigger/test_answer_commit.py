"""Completion is observable only after a confirmed answer commit."""

from unittest.mock import AsyncMock

import pytest

from app.services.chat.storage import db as chat_db
from app.services.chat.trigger import lifecycle


@pytest.mark.asyncio
async def test_rejected_save_does_not_cleanup_or_complete(monkeypatch):
    import app.services.chat.storage as storage

    cleanup = AsyncMock()
    monkeypatch.setattr(storage.session_manager, "cleanup_streaming_state", cleanup)
    monkeypatch.setattr(
        chat_db.db_handler, "update_subtask_status", AsyncMock(return_value=False)
    )
    saved = await lifecycle.persist_completed_result(
        subtask_id=12, task_id=7, status="COMPLETED", result={"value": "answer"}
    )
    assert not saved
    cleanup.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["emit_done", "emit_error", "emit_cancelled"])
async def test_stale_terminal_is_not_published(monkeypatch, method):
    from app.services.execution.emitters import status_updating as module

    wrapped = AsyncMock()
    emitter = module.StatusUpdatingEmitter(wrapped, task_id=7, subtask_id=12)
    monkeypatch.setattr(
        module, "collect_completed_result", AsyncMock(return_value={"value": "old"})
    )
    monkeypatch.setattr(
        module, "persist_completed_result", AsyncMock(return_value=False)
    )
    published = AsyncMock()
    monkeypatch.setattr(emitter, "_publish_task_completed_event", published)
    kwargs = {"error": "old error"} if method == "emit_error" else {}
    await getattr(emitter, method)(7, 12, **kwargs)
    getattr(wrapped, method).assert_not_awaited()
    published.assert_not_awaited()


@pytest.mark.asyncio
async def test_uncertain_commit_reports_refresh_without_success(monkeypatch):
    from contextlib import contextmanager
    from unittest.mock import MagicMock

    from app.services.execution.emitters import status_updating as module

    @contextmanager
    def broken_commit():
        db = MagicMock()
        db.commit.side_effect = OSError("connection lost")
        yield db
        db.commit()

    monkeypatch.setattr(chat_db, "_db_session", broken_commit)
    monkeypatch.setattr(
        module, "collect_completed_result", AsyncMock(return_value={"value": "answer"})
    )
    wrapped = AsyncMock()
    emitter = module.StatusUpdatingEmitter(wrapped, 7, 12)
    published = AsyncMock()
    monkeypatch.setattr(emitter, "_publish_task_completed_event", published)
    await emitter.emit_done(7, 12, result={"value": "answer"})
    wrapped.emit_done.assert_not_awaited()
    published.assert_not_awaited()
    assert "保存状态未确认" in wrapped.emit_error.await_args.args[2]


@pytest.mark.asyncio
async def test_successful_completion_is_published_once(monkeypatch):
    from app.services.chat.storage.answer_attempt import AnswerSaveResult
    from app.services.execution.emitters import status_updating as module

    wrapped = AsyncMock()
    emitter = module.StatusUpdatingEmitter(wrapped, 7, 12)
    monkeypatch.setattr(
        module, "collect_completed_result", AsyncMock(return_value={"value": "answer"})
    )
    monkeypatch.setattr(
        module,
        "persist_completed_result",
        AsyncMock(return_value=AnswerSaveResult.COMMITTED),
    )
    published = AsyncMock()
    monkeypatch.setattr(emitter, "_publish_task_completed_event", published)
    await emitter.emit_done(7, 12, result={"value": "answer"})
    await emitter.emit_done(7, 12, result={"value": "answer"})
    assert wrapped.emit_done.await_count == 1
    published.assert_awaited_once()


@pytest.mark.asyncio
async def test_late_dispatch_does_not_recover_or_dispatch_new_attempt(monkeypatch):
    from unittest.mock import MagicMock

    from app.services.chat.storage.answer_attempt import AnswerSaveResult
    from app.services.execution.dispatcher import ExecutionDispatcher
    from shared.models import ExecutionRequest

    dispatcher = ExecutionDispatcher()
    recover = AsyncMock()
    monkeypatch.setattr(dispatcher, "_recover_executor_if_needed", recover)
    monkeypatch.setattr(
        dispatcher,
        "_update_subtask_to_running",
        AsyncMock(return_value=AnswerSaveResult.REJECTED),
    )
    request = ExecutionRequest(task_id=7, subtask_id=12, answer_generation_id="a" * 32)
    dispatcher.router = MagicMock()
    wrapped = AsyncMock()
    await dispatcher.dispatch(request, emitter=wrapped)
    recover.assert_not_awaited()
    dispatcher.router.route.assert_not_called()
    wrapped.emit_done.assert_not_awaited()
    await dispatcher.http_client.aclose()


def test_accept_captures_identity_once_independent_of_client_result():
    from unittest.mock import MagicMock

    from app.models.subtask import Subtask, SubtaskStatus
    from app.services.chat.storage.answer_attempt import accept_answer_attempt

    db = MagicMock()
    db.query.return_value.filter.return_value.update.return_value = 1
    row = Subtask(
        id=12, status=SubtaskStatus.PENDING, result={"answer_generation_id": "forged"}
    )
    identity = accept_answer_attempt(db, row)
    assert len(identity) == 32 and identity != "forged"
    row.result = None
    assert accept_answer_attempt(db, row) == identity
    row.result = {"answer_generation_id": "copied-from-another-answer"}
    assert accept_answer_attempt(db, row) == identity
    db.commit.assert_called_once()


def test_accept_cannot_adopt_identity_after_losing_pending_claim():
    from unittest.mock import MagicMock

    from app.models.subtask import Subtask, SubtaskStatus
    from app.services.chat.storage.answer_attempt import accept_answer_attempt

    db = MagicMock()
    db.query.return_value.filter.return_value.update.return_value = 0
    row = Subtask(id=12, status=SubtaskStatus.PENDING)
    with pytest.raises(ValueError, match="no longer pending"):
        accept_answer_attempt(db, row)
    assert row.answer_generation_id is None
    db.commit.assert_not_called()


@pytest.mark.asyncio
async def test_unconfirmed_terminal_is_never_written_again(monkeypatch):
    from app.services.chat.storage.answer_attempt import AnswerSaveResult
    from app.services.execution.emitters import status_updating as module

    wrapped = AsyncMock()
    emitter = module.StatusUpdatingEmitter(wrapped, 7, 12)
    monkeypatch.setattr(
        module, "collect_completed_result", AsyncMock(return_value={"value": "answer"})
    )
    save = AsyncMock(return_value=AnswerSaveResult.UNCONFIRMED)
    monkeypatch.setattr(module, "persist_completed_result", save)
    await emitter.emit_done(7, 12)
    await emitter.emit_done(7, 12)
    await emitter.emit_error(7, 12, "late error")
    await emitter.emit_cancelled(7, 12)
    save.assert_awaited_once()
    wrapped.emit_error.assert_awaited_once()
    wrapped.emit_done.assert_not_awaited()


@pytest.mark.asyncio
async def test_claimed_attempt_can_fail_during_routing(monkeypatch):
    from app.services.chat.storage.answer_attempt import AnswerSaveResult
    from app.services.execution.dispatcher import ExecutionDispatcher
    from app.services.execution.emitters import status_updating as module
    from shared.models import ExecutionRequest

    dispatcher = ExecutionDispatcher()
    monkeypatch.setattr(
        dispatcher,
        "_recover_executor_if_needed",
        AsyncMock(side_effect=ValueError("recovery failed")),
    )
    monkeypatch.setattr(
        dispatcher,
        "_update_subtask_to_running",
        AsyncMock(return_value=AnswerSaveResult.COMMITTED),
    )
    monkeypatch.setattr(
        module, "collect_completed_result", AsyncMock(return_value={"value": ""})
    )
    save = AsyncMock(return_value=AnswerSaveResult.COMMITTED)
    monkeypatch.setattr(module, "persist_completed_result", save)
    monkeypatch.setattr(
        module.StatusUpdatingEmitter, "_publish_task_completed_event", AsyncMock()
    )
    wrapped = AsyncMock()
    request = ExecutionRequest(task_id=7, subtask_id=12, answer_generation_id="a" * 32)
    with pytest.raises(ValueError, match="recovery failed"):
        await dispatcher.dispatch(request, emitter=wrapped)
    assert save.await_args.kwargs["generation_id"] == "a" * 32
    assert save.await_args.kwargs["expected_status"] == "RUNNING"
    wrapped.emit_error.assert_awaited_once()
    await dispatcher.http_client.aclose()


@pytest.mark.asyncio
async def test_post_commit_pipeline_error_does_not_change_commit_result(monkeypatch):
    from app.services.chat.storage.answer_attempt import AnswerSaveResult
    from app.services.chat.storage.db import DatabaseHandler, TaskStatusUpdateResult

    handler = DatabaseHandler()
    monkeypatch.setattr(
        handler,
        "_run_in_executor",
        AsyncMock(return_value=TaskStatusUpdateResult(auto_advance=object())),
    )
    monkeypatch.setattr(
        "app.services.chat.pipeline_advance.advance_pipeline_stage_from_auto_completion",
        AsyncMock(side_effect=RuntimeError("next stage unavailable")),
    )
    assert (
        await handler.update_subtask_status(12, "COMPLETED")
        is AnswerSaveResult.COMMITTED
    )


def test_public_subtask_schema_cannot_set_attempt_identity():
    from app.schemas.subtask import SubtaskCreate

    payload = SubtaskCreate.model_validate(
        {
            "task_id": 7,
            "team_id": 1,
            "title": "answer",
            "answer_generation_id": "forged",
            "result": {"answer_generation_id": "copied"},
        }
    )
    assert "answer_generation_id" not in payload.model_dump()
    assert payload.result == {"answer_generation_id": "copied"}


@pytest.mark.asyncio
async def test_unconfirmed_recovery_is_not_reported_as_failed(monkeypatch):
    from datetime import datetime

    from app.services.chat.storage.answer_attempt import AnswerSaveResult
    from app.services.execution import stalled_tasks
    from app.services.execution.emitters import status_updating as module

    monkeypatch.setattr(
        module, "collect_completed_result", AsyncMock(return_value={"value": ""})
    )
    monkeypatch.setattr(
        module,
        "persist_completed_result",
        AsyncMock(return_value=AnswerSaveResult.UNCONFIRMED),
    )
    monkeypatch.setattr(
        stalled_tasks, "WebSocketResultEmitter", lambda **_: AsyncMock()
    )
    candidate = stalled_tasks.StalledCandidate(
        7, 12, 1, "", "", datetime.now(), "a" * 32
    )
    assert not await stalled_tasks.fail_stalled_subtask(
        candidate, error_message="timeout", error_code="executor_not_started"
    )


@pytest.mark.asyncio
async def test_claim_uncertainty_and_failed_notification_do_not_write_again(
    monkeypatch,
):
    from app.services.chat.storage.answer_attempt import AnswerSaveResult
    from app.services.execution.dispatcher import ExecutionDispatcher
    from app.services.execution.emitters import status_updating as module
    from shared.models import ExecutionRequest

    dispatcher = ExecutionDispatcher()
    monkeypatch.setattr(
        dispatcher,
        "_update_subtask_to_running",
        AsyncMock(return_value=AnswerSaveResult.UNCONFIRMED),
    )
    monkeypatch.setattr(
        module, "collect_completed_result", AsyncMock(return_value={"value": ""})
    )
    save = AsyncMock(return_value=AnswerSaveResult.COMMITTED)
    monkeypatch.setattr(module, "persist_completed_result", save)
    monkeypatch.setattr(
        module.StatusUpdatingEmitter, "_publish_task_completed_event", AsyncMock()
    )
    wrapped = AsyncMock()
    wrapped.emit_error.side_effect = OSError("notification lost")
    request = ExecutionRequest(task_id=7, subtask_id=12, answer_generation_id="a" * 32)
    with pytest.raises(OSError):
        await dispatcher.dispatch(request, emitter=wrapped)
    save.assert_not_awaited()
    await dispatcher.http_client.aclose()
