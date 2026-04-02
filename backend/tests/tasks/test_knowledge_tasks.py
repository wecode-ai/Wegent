# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge Celery tasks."""

from contextlib import ExitStack, contextmanager, nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.config import settings
from app.tasks.knowledge_tasks import index_document_task


@contextmanager
def _lock_context(acquired: bool):
    yield acquired


@contextmanager
def _task_request_context(*, retries: int):
    index_document_task.push_request(
        id="task-1",
        retries=retries,
        hostname="worker-1",
    )
    try:
        yield
    finally:
        index_document_task.pop_request()


def _task_kwargs() -> dict:
    return {
        "knowledge_base_id": "1",
        "attachment_id": 2,
        "retriever_name": "retriever-1",
        "retriever_namespace": "default",
        "embedding_model_name": "embedding-1",
        "embedding_model_namespace": "default",
        "user_id": 3,
        "user_name": "tester",
        "document_id": 4,
        "index_generation": 5,
        "splitter_config_dict": None,
        "trigger_summary": False,
    }


def _session_factory():
    """Return a SessionLocal side effect that yields a fresh mock session."""

    def _open_session():
        return nullcontext(MagicMock())

    return _open_session


def test_index_document_task_retries_when_lock_is_held(
    monkeypatch: pytest.MonkeyPatch,
):
    retry_mock = MagicMock(side_effect=RuntimeError("retry-called"))
    monkeypatch.setattr(index_document_task, "retry", retry_mock)

    with _task_request_context(retries=0):
        with patch(
            "app.tasks.knowledge_tasks.distributed_lock.acquire_watchdog_context",
            return_value=_lock_context(False),
        ):
            with pytest.raises(RuntimeError, match="retry-called"):
                index_document_task.run(**_task_kwargs())

    retry_mock.assert_called_once()
    assert (
        retry_mock.call_args.kwargs["countdown"]
        == settings.KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS
    )


def test_index_document_task_skips_after_lock_retry_exhaustion(
    monkeypatch: pytest.MonkeyPatch,
):
    retry_mock = MagicMock()
    monkeypatch.setattr(index_document_task, "retry", retry_mock)

    with _task_request_context(retries=index_document_task.max_retries):
        with patch(
            "app.tasks.knowledge_tasks.distributed_lock.acquire_watchdog_context",
            return_value=_lock_context(False),
        ):
            result = index_document_task.run(**_task_kwargs())

    retry_mock.assert_not_called()
    assert result["status"] == "skipped"
    assert result["reason"] == "lock_retry_exhausted"


def test_index_document_task_marks_skip_result_as_failed():
    start_decision = MagicMock(should_execute=True, reason="started")
    success_finalize_mock = MagicMock()
    failed_finalize_mock = MagicMock(return_value=True)

    with _task_request_context(retries=0), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.acquire_watchdog_context",
                return_value=_lock_context(True),
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_started",
                return_value=start_decision,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_succeeded",
                success_finalize_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_failed",
                failed_finalize_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.run_document_indexing",
                return_value={
                    "status": "skipped",
                    "reason": "unsupported_document",
                    "document_id": 4,
                    "knowledge_base_id": "1",
                },
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            )
        )
        result = index_document_task.run(**_task_kwargs())

    failed_finalize_mock.assert_called_once()
    success_finalize_mock.assert_not_called()
    assert result["status"] == "skipped"
    assert result["reason"] == "unsupported_document"
    assert result["index_generation"] == 5


def test_index_document_task_routes_indexing_through_gateway():
    start_decision = MagicMock(should_execute=True, reason="started")
    success_finalize_mock = MagicMock(return_value=True)
    task_db = MagicMock()
    indexing_db = MagicMock()

    with _task_request_context(retries=0), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.acquire_watchdog_context",
                return_value=_lock_context(True),
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_started",
                return_value=start_decision,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_succeeded",
                success_finalize_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.resolve_kb_index_info",
                return_value=SimpleNamespace(
                    index_owner_user_id=3,
                    summary_enabled=False,
                ),
            )
        )
        mock_resolve = stack.enter_context(
            patch(
                "app.services.knowledge.indexing.RagRuntimeResolver.build_index_runtime_spec",
                return_value=object(),
            )
        )
        mock_index = stack.enter_context(
            patch(
                "app.services.knowledge.indexing.LocalRagGateway.index_document",
                new_callable=AsyncMock,
                return_value={
                    "status": "success",
                    "document_id": 4,
                    "knowledge_base_id": "1",
                    "chunks_data": {"total_count": 8},
                },
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=lambda: nullcontext(task_db),
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.SessionLocal",
                return_value=indexing_db,
            )
        )

        result = index_document_task.run(**_task_kwargs())

    assert result["status"] == "success"
    mock_resolve.assert_called_once()
    mock_index.assert_awaited_once_with(mock_resolve.return_value, db=indexing_db)


def test_index_document_task_enqueues_summary_after_finalize(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "SUMMARY_ENABLED", True)
    start_decision = MagicMock(should_execute=True, reason="started")
    success_finalize_mock = MagicMock(return_value=True)
    summary_delay_mock = MagicMock()

    with _task_request_context(retries=0), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.acquire_watchdog_context",
                return_value=_lock_context(True),
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_started",
                return_value=start_decision,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_succeeded",
                success_finalize_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.run_document_indexing",
                return_value={
                    "status": "success",
                    "document_id": 4,
                    "knowledge_base_id": "1",
                    "chunks_data": {"total_count": 8},
                },
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.get_kb_index_info",
                return_value=MagicMock(summary_enabled=True),
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.generate_document_summary_task.delay",
                summary_delay_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            )
        )

        result = index_document_task.run(**(_task_kwargs() | {"trigger_summary": True}))

    success_finalize_mock.assert_called_once()
    summary_delay_mock.assert_called_once_with(
        document_id=4,
        user_id=3,
        user_name="tester",
    )
    assert result["status"] == "success"
    assert result["index_generation"] == 5
