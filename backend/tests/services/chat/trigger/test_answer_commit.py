"""Completion is observable only after a confirmed answer commit."""

from unittest.mock import AsyncMock

import pytest

from app.services.chat.storage import db as chat_db
from app.services.chat.trigger import lifecycle


def test_api_save_does_not_bind_untrusted_evidence(monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    from app.models.subtask import SubtaskStatus

    answer = SimpleNamespace(
        id=12,
        task_id=7,
        status=SubtaskStatus.RUNNING,
        result={},
        executor_name="",
    )
    task = SimpleNamespace(id=7, kind="Task", is_active=1, json={})
    db = MagicMock()

    @contextmanager
    def session():
        yield db

    monkeypatch.setattr(chat_db, "_db_session", session)
    for method in ("get_basic_by_id", "get_basic_by_id_for_update"):
        monkeypatch.setattr(
            chat_db.task_stores.subtask_store, method, lambda *a, **k: answer
        )
    monkeypatch.setattr(
        chat_db.task_stores.task_store, "get_by_id_for_update", lambda *a, **k: task
    )
    saved = MagicMock(return_value=True)
    monkeypatch.setattr(chat_db.task_stores.subtask_store, "update_fields", saved)
    handler = chat_db.DatabaseHandler()
    monkeypatch.setattr(
        handler, "_update_task_status_in_session", lambda *a, **k: object()
    )
    result = {
        "value": "API answer",
        "_answer_evidence": [],
        "answer_generation_id": "a" * 32,
        "answer_citations": [{"citation_id": "42"}],
    }

    handler._update_subtask_sync(12, "COMPLETED", result=result)

    assert result == {"value": "API answer"}
    assert saved.call_args.kwargs["result"] == {"value": "API answer"}
    db.begin_nested.assert_not_called()
    db.add.assert_not_called()


def test_completed_answer_rejects_a_duplicate_terminal(monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    from app.models.subtask import SubtaskStatus

    answer = SimpleNamespace(
        id=12,
        task_id=7,
        status=SubtaskStatus.COMPLETED,
    )
    task = SimpleNamespace(id=7, kind="Task", is_active=1, json={})
    db = MagicMock()

    @contextmanager
    def session():
        yield db

    monkeypatch.setattr(chat_db, "_db_session", session)
    for method in ("get_basic_by_id", "get_basic_by_id_for_update"):
        monkeypatch.setattr(
            chat_db.task_stores.subtask_store, method, lambda *a, **k: answer
        )
    monkeypatch.setattr(
        chat_db.task_stores.task_store, "get_by_id_for_update", lambda *a, **k: task
    )
    assert chat_db.DatabaseHandler()._update_subtask_sync(12, "COMPLETED") is None
    db.add.assert_not_called()


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
@pytest.mark.parametrize("failure", [None, "body", "commit", "snapshots"])
async def test_completion_publishes_only_committed_result(monkeypatch, failure):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    from sqlalchemy.exc import IntegrityError

    import app.services.chat.storage as storage
    from app.models.subtask import SubtaskRole, SubtaskStatus
    from app.services.execution.emitters import status_updating as emitter_module
    from app.services.knowledge import answer_evidence

    answer = SimpleNamespace(
        id=12,
        task_id=7,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
        result=None,
    )
    task = SimpleNamespace(id=7, kind="Task", is_active=1, json={})
    db = MagicMock()
    snapshots = []
    body = {}

    def insert(row):
        row.id = 42
        snapshots.append(row)

    def update(*args, **kwargs):
        if failure == "body":
            raise OSError("answer update failed")
        body.update(kwargs["result"])

    db.add.side_effect = insert
    if failure == "snapshots":
        db.flush.side_effect = [
            IntegrityError("INSERT INTO knowledge_citations (...) ", {}, OSError()),
            None,
        ]
    if failure == "commit":
        db.commit.side_effect = OSError("outer commit failed")

    @contextmanager
    def session():
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise

    monkeypatch.setattr(chat_db, "_db_session", session)
    for method in ("get_basic_by_id", "get_basic_by_id_for_update"):
        monkeypatch.setattr(
            chat_db.task_stores.subtask_store, method, lambda *a, **k: answer
        )
    monkeypatch.setattr(chat_db.task_stores.subtask_store, "update_fields", update)
    monkeypatch.setattr(
        chat_db.task_stores.task_store, "get_by_id_for_update", lambda *a, **k: task
    )
    monkeypatch.setattr(
        chat_db.db_handler,
        "_update_task_status_in_session",
        lambda *a, **k: chat_db.TaskStatusUpdateResult(),
    )
    monkeypatch.setattr(answer_evidence, "require_source", lambda *a: None)
    cleanup = AsyncMock()
    monkeypatch.setattr(storage.session_manager, "cleanup_streaming_state", cleanup)
    evidence = answer_evidence.TrustedEvidence(
        [
            {
                "evidence_id": "e1",
                "content": "original",
                "source": "document",
                "knowledge_base_id": 7,
                "document_id": 9,
            }
        ],
        user_id=3,
    )
    result = {"value": "A claim [[evidence:e1]]", "_answer_evidence": evidence}
    monkeypatch.setattr(
        emitter_module, "collect_completed_result", AsyncMock(return_value=result)
    )

    wrapped = AsyncMock()
    emitter = emitter_module.StatusUpdatingEmitter(wrapped, task_id=7, subtask_id=12)
    published = AsyncMock()
    monkeypatch.setattr(emitter, "_publish_task_completed_event", published)
    await emitter.emit_done(7, 12, result)

    if failure in {"body", "commit"}:
        db.rollback.assert_called_once()
        cleanup.assert_not_awaited()
        published.assert_not_awaited()
        wrapped.emit_done.assert_not_awaited()
        assert result == {
            "value": "A claim [[evidence:e1]]",
            "_answer_evidence": evidence,
        }
        assert "保存状态未确认" in wrapped.emit_error.await_args.args[2]
        return

    # A replay through this emitter must not forward the uncommitted input.
    await emitter.emit_done(
        7, 12, {"value": "second completion", "_answer_evidence": evidence}
    )
    db.commit.assert_called_once()
    cleanup.assert_awaited_once()
    published.assert_awaited_once_with("COMPLETED", body, None)
    wrapped.emit_done.assert_awaited_once_with(7, 12, body)
    assert "_answer_evidence" not in body
    if failure == "snapshots":
        assert body["value"] == "A claim [[evidence-unavailable]]"
        assert body["answer_citations"] == []
        db.begin_nested.return_value.rollback.assert_called_once()
    else:
        assert body["value"] == "A claim [[citation:42]]"
        assert body["answer_citations"][0]["citation_id"] == "42"
        assert snapshots[0].caller_context["answer_evidence"] == {
            "answer_id": 12,
            "generation_id": body["answer_generation_id"],
            "local_id": "e1",
        }
