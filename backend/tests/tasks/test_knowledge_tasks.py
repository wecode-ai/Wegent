# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge Celery tasks."""

import asyncio
from contextlib import ExitStack, contextmanager, nullcontext
from datetime import datetime, timedelta, timezone
from heapq import heappop, heappush
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.config import settings
from app.models.knowledge import DocumentIndexStatus
from app.tasks.knowledge_tasks import (
    LateIndexCleanupError,
    _build_stale_processing_error,
    _delete_late_index_if_document_was_deleted,
    index_document_task,
)


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


@pytest.mark.parametrize("exhausted", [False, True])
@pytest.mark.parametrize("prior_domain_retries", [0, 2])
def test_web_busy_retry_is_bounded_without_changing_publication(
    test_db, test_user, monkeypatch, exhausted, prior_domain_retries
):
    from celery.exceptions import Retry

    from app.models.knowledge import KnowledgeDocument
    from app.services.knowledge.web_refresh import WebRefreshBusy
    from app.tasks.web_auto_update_tasks import refresh_web_document_task

    monkeypatch.setattr(settings, "WEB_AUTO_UPDATE_SCHEDULE_ENABLED", True)
    document = KnowledgeDocument(
        kind_id=1,
        user_id=test_user.id,
        name="web.md",
        file_extension="md",
        file_size=8,
        source_type="web",
        is_active=True,
        status="enabled",
        index_status="success",
        index_generation=3,
        source_config={"published_generation": 2},
    )
    test_db.add(document)
    test_db.commit()
    monkeypatch.setattr(
        "app.tasks.web_auto_update_tasks.SessionLocal", lambda: nullcontext(test_db)
    )
    busy = WebRefreshBusy("Domain is busy")
    monkeypatch.setattr(
        "app.tasks.web_auto_update_tasks.refresh_web_document",
        AsyncMock(side_effect=busy),
    )
    retry = MagicMock(side_effect=Retry())
    monkeypatch.setattr(refresh_web_document_task, "retry", retry)
    refresh_web_document_task.push_request(retries=prior_domain_retries)
    try:
        if exhausted:
            result = refresh_web_document_task.run(
                document.id,
                3,
                document_lock_retries=refresh_web_document_task.max_retries,
            )
            assert result == {"status": "skipped", "reason": "busy_retry_exhausted"}
            retry.assert_not_called()
        else:
            with pytest.raises(Retry):
                refresh_web_document_task.run(document.id, 3)
            assert retry.call_args.kwargs["kwargs"] == {
                "document_id": document.id,
                "expected_generation": 3,
                "document_lock_retries": 1,
            }
            assert (
                retry.call_args.kwargs["countdown"]
                == settings.KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS
            )
    finally:
        refresh_web_document_task.pop_request()
    test_db.refresh(document)
    assert document.source_config["published_generation"] == 2
    assert document.index_status == DocumentIndexStatus.SUCCESS
    assert document.is_active and document.status == "enabled"


@pytest.mark.parametrize("expires_soon", [False, True])
def test_web_domain_wait_preserves_deadline_and_allows_batch_progress(
    test_db, test_user, monkeypatch, expires_soon
):
    from celery.exceptions import Retry

    from app.models.kind import Kind
    from app.models.knowledge import KnowledgeDocument
    from app.models.subtask_context import SubtaskContext
    from app.services.knowledge import web_refresh
    from app.services.knowledge.web_publication import config_fingerprint, content_hash
    from app.services.web_scraper import ScrapedContent
    from app.tasks import web_auto_update_tasks as tasks
    from tests.utils.retrieval_resources import embedding_model_kind, retriever_kind

    start = datetime(2026, 11, 19, tzinfo=timezone.utc)
    clock = {"seconds": 0.0, "busy_until": 30.0}
    deadline = start + timedelta(seconds=10 if expires_soon else 600)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return start + timedelta(seconds=clock["seconds"])

    lease = SimpleNamespace(owned=lambda: True)
    monkeypatch.setattr(
        web_refresh.distributed_lock,
        "owned_watchdog_context",
        lambda name, **kw: nullcontext(
            None
            if name.startswith("web-fetch:") and clock["seconds"] < clock["busy_until"]
            else lease
        ),
    )
    redis = MagicMock()
    redis.time.side_effect = lambda: (clock["seconds"], 0)
    redis.get.return_value = None
    monkeypatch.setattr(web_refresh.distributed_lock, "_redis_client", redis)

    async def scrape(url, **kwargs):
        # Another worker can occupy the domain for longer than the first retry.
        clock["busy_until"] = clock["seconds"] + 30
        return ScrapedContent(url=url, content="Open 9am-6pm.")

    monkeypatch.setattr(
        "app.services.web_scraper.WebScraperService",
        lambda: SimpleNamespace(scrape_url=scrape, close=AsyncMock()),
    )

    monkeypatch.setattr(tasks, "datetime", Clock)
    monkeypatch.setattr(tasks, "uniform", lambda a, b: 0)
    monkeypatch.setattr(tasks.refresh_web_document_task, "default_retry_delay", 15)
    monkeypatch.setattr(tasks.refresh_web_document_task, "max_retries", 1)
    monkeypatch.setattr(tasks.settings, "WEB_AUTO_UPDATE_SCHEDULE_ENABLED", True)
    monkeypatch.setattr(tasks, "SessionLocal", lambda: nullcontext(test_db))
    # Retain Celery's real retry/signature construction; replace only transport.
    monkeypatch.setattr(tasks.refresh_web_document_task, "apply_async", MagicMock())
    kb = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="domain-batch",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "webAutoUpdateEnabled": True,
                "retrievalConfig": {
                    "retriever_name": "store",
                    "embedding_config": {"model_name": "embed"},
                },
            }
        },
    )
    test_db.add_all(
        [
            kb,
            retriever_kind(test_user.id, "store"),
            embedding_model_kind(test_user.id, "embed"),
        ]
    )
    test_db.commit()
    attachments = [
        SubtaskContext(
            user_id=test_user.id,
            context_type="attachment",
            name=f"web-{i}.md",
            status="ready",
            binary_data=b"Open 9am-6pm.",
        )
        for i in range(3)
    ]
    test_db.add_all(attachments)
    test_db.flush()
    documents = [
        KnowledgeDocument(
            kind_id=kb.id,
            user_id=test_user.id,
            attachment_id=attachment.id,
            name=attachment.name,
            file_extension="md",
            file_size=8,
            source_type="web",
            is_active=True,
            status="enabled",
            index_status=DocumentIndexStatus.SUCCESS,
            index_generation=3,
            source_config={
                "url": "https://example.com/hours",
                "published_generation": 2,
                "webAutoUpdate": {"content_hash": content_hash("Open 9am-6pm.")},
            },
        )
        for attachment in attachments
    ]
    test_db.add_all(documents)
    test_db.commit()
    for document in documents:
        document.source_config = {
            **document.source_config,
            "published_index_fingerprint": config_fingerprint(kb, document, test_db),
        }
    test_db.commit()
    pending = [(0, document.id, 0, 3) for document in documents]
    completed, expired = [], []
    while pending:
        when, document_id, retries, expected_generation = heappop(pending)
        clock["seconds"] = when
        task = tasks.refresh_web_document_task
        task.push_request(
            id=f"web-{document_id}",
            retries=retries,
            called_directly=False,
            expires=deadline.isoformat(),
            args=(),
            kwargs={},
        )
        try:
            try:
                result = task.run(document_id, expected_generation)
            except Retry as retry:
                assert retry.sig.options["expires"] == deadline
                assert retry.sig.kwargs["document_id"] == document_id
                generation = retry.sig.kwargs["expected_generation"]
                assert generation == expected_generation + 1
                heappush(
                    pending,
                    (
                        when + retry.when,
                        retry.sig.kwargs["document_id"],
                        retry.sig.options["retries"],
                        generation,
                    ),
                )
            else:
                if expires_soon:
                    assert result["reason"] == "domain_wait_expired"
                    expired.append(document_id)
                else:
                    assert result["status"] == "accepted"
                    assert retries > settings.KNOWLEDGE_INDEX_LOCK_MAX_RETRIES
                    completed.append(document_id)
        finally:
            task.pop_request()
    assert (expired if expires_soon else completed) == [d.id for d in documents]
    for document in documents:
        test_db.refresh(document)
        assert document.source_config["published_generation"] == 2
        assert document.index_status == DocumentIndexStatus.SUCCESS
        assert document.is_active and document.status == "enabled"


@pytest.mark.parametrize("failure", ["fetch", "startup_timeout"])
def test_web_refresh_closes_browser_on_each_task_event_loop(monkeypatch, failure):
    import crawl4ai

    from app.services.knowledge.web_refresh import (
        distributed_lock,
        scrape_with_domain_lease,
    )
    from app.services.web_scraper import ScrapedContent, WebScraperService

    crawlers = []

    class LoopBoundCrawler:
        def __init__(self, **kwargs):
            self.crawler_strategy = MagicMock()
            self.closed = False
            crawlers.append(self)

        async def start(self):
            self.loop = asyncio.get_running_loop()
            if failure == "startup_timeout" and len(crawlers) == 1:
                await asyncio.Future()

        async def close(self):
            assert self.loop is asyncio.get_running_loop()
            self.closed = True

    async def scrape(service, url, *, allow_short_content):
        crawler = await service._get_crawler()
        assert crawler.loop is asyncio.get_running_loop()
        if url.endswith("/failure"):
            raise RuntimeError("fetch stopped")
        return ScrapedContent(url=url, content="Opening hours")

    monkeypatch.setattr(crawl4ai, "AsyncWebCrawler", LoopBoundCrawler)
    monkeypatch.setattr(WebScraperService, "_scrape_url_impl", scrape)
    monkeypatch.setattr(WebScraperService, "_resolve_total_timeout", lambda *_: 0.05)
    lease = SimpleNamespace(owned=lambda: True)
    monkeypatch.setattr(
        distributed_lock, "owned_watchdog_context", lambda name: nullcontext(lease)
    )
    redis = MagicMock()
    redis.time.return_value = (100, 0)
    redis.get.return_value = None
    monkeypatch.setattr(distributed_lock, "_redis_client", redis)

    result = asyncio.run(scrape_with_domain_lease("https://example.org/failure"))
    assert not result.success
    if failure == "startup_timeout":
        assert result.error_code == "FETCH_TIMEOUT"
    assert crawlers[0].closed
    assert asyncio.run(scrape_with_domain_lease("https://example.org/hours")).success
    assert len(crawlers) == 2
    assert crawlers[1].closed
    assert crawlers[0].loop is not crawlers[1].loop


@pytest.mark.parametrize(
    ("status", "expected_stage", "expected_code"),
    [
        (
            DocumentIndexStatus.PENDING_CONVERSION,
            "conversion",
            "conversion_timeout",
        ),
        (DocumentIndexStatus.CONVERTING, "conversion", "conversion_timeout"),
        (DocumentIndexStatus.QUEUED, "indexing", "indexing_timeout"),
        (DocumentIndexStatus.INDEXING, "indexing", "indexing_timeout"),
    ],
)
def test_stale_processing_error_uses_public_timeout_code(
    status, expected_stage: str, expected_code: str
) -> None:
    error = _build_stale_processing_error(status, generation=3)

    assert error.stage.value == expected_stage
    assert error.code == expected_code
    assert error.generation == 3


def test_index_document_task_retries_when_lock_is_held(
    monkeypatch: pytest.MonkeyPatch,
):
    retry_mock = MagicMock(side_effect=RuntimeError("retry-called"))
    monkeypatch.setattr(index_document_task, "retry", retry_mock)

    with _task_request_context(retries=0):
        with patch(
            "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
        with (
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
                return_value=_lock_context(False),
            ),
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            ),
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_failed",
            ),
        ):
            result = index_document_task.run(**_task_kwargs())

    retry_mock.assert_not_called()
    assert result["status"] == "skipped"
    assert result["reason"] == "lock_retry_exhausted"


@pytest.mark.parametrize("exhausted", [False, True])
def test_index_document_task_bounds_retries_for_unavailable_lock_store(exhausted):
    from celery.exceptions import Retry
    from redis.exceptions import ConnectionError as RedisConnectionError

    error = RedisConnectionError("connection lost acquiring the index lease")

    @contextmanager
    def unavailable(*args, **kwargs):
        raise error
        yield

    with (
        _task_request_context(
            retries=index_document_task.max_retries if exhausted else 0
        ),
        patch(
            "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
            unavailable,
        ),
        patch.object(index_document_task, "retry", side_effect=Retry()) as retry,
        patch(
            "app.services.knowledge.index_state_machine.mark_document_index_started"
        ) as start,
    ):
        with pytest.raises(RedisConnectionError if exhausted else Retry):
            index_document_task.run(**_task_kwargs())

    start.assert_not_called()
    if exhausted:
        retry.assert_not_called()
    else:
        retry.assert_called_once_with(
            exc=error, countdown=settings.KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS
        )


def test_index_document_task_cleans_up_after_lock_retry_exhaustion(
    monkeypatch: pytest.MonkeyPatch,
):
    """An exhausted lock retry still removes a late reference for a deleted document."""
    retry_mock = MagicMock()
    cleanup_mock = MagicMock(return_value=True)
    monkeypatch.setattr(index_document_task, "retry", retry_mock)

    with _task_request_context(retries=index_document_task.max_retries):
        with (
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
                return_value=_lock_context(False),
            ),
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            ),
            patch(
                "app.services.knowledge.index_state_machine.mark_document_index_failed",
            ),
            patch(
                "app.tasks.knowledge_tasks._delete_late_index_if_document_was_deleted",
                cleanup_mock,
            ),
        ):
            result = index_document_task.run(**_task_kwargs())

    retry_mock.assert_not_called()
    cleanup_mock.assert_called_once()
    assert result["status"] == "skipped"
    assert result["reason"] == "lock_retry_exhausted"
    assert result["deleted_late_index"] is True


def test_index_document_task_marks_skip_result_as_failed():
    start_decision = MagicMock(should_execute=True, reason="started")
    success_finalize_mock = MagicMock()
    failed_finalize_mock = MagicMock(return_value=True)

    with _task_request_context(retries=0), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
        mock_gateway = MagicMock()
        mock_gateway.delete_document_index = AsyncMock(
            return_value={"deleted_chunks": 0}
        )
        mock_gateway.index_document = AsyncMock(
            return_value={
                "status": "success",
                "document_id": 4,
                "knowledge_base_id": "1",
                "chunks_data": {"total_count": 8},
            }
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.RagRuntimeResolver.build_delete_runtime_spec",
                return_value=object(),
            )
        )
        mock_get_rag_gateway = stack.enter_context(
            patch(
                "app.services.knowledge.indexing.get_rag_gateway",
                return_value=mock_gateway,
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
    mock_get_rag_gateway.assert_called_once()
    mock_gateway.index_document.assert_awaited_once_with(
        mock_resolve.return_value,
        db=None,
    )


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
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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


def test_index_document_task_deletes_late_index_after_document_deletion():
    start_decision = MagicMock(should_execute=True, reason="started")
    cleanup_mock = MagicMock(return_value=True)

    with _task_request_context(retries=0), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
                return_value=False,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.run_document_indexing",
                return_value={"status": "success", "chunks_data": []},
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks._delete_late_index_if_document_was_deleted",
                cleanup_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            )
        )
        result = index_document_task.run(**_task_kwargs())

    cleanup_mock.assert_called_once()
    assert result["reason"] == "stale_or_already_finalized"


@pytest.mark.parametrize("outcome", ["lost_lease", "superseded", "deleted"])
def test_web_index_invalidations_never_use_logical_document_compensation(outcome):
    """Old versioned workers cannot change another owner's state or index."""
    lease = MagicMock()
    lease.owned.return_value = True

    def index(**kwargs):
        if outcome == "lost_lease":
            lease.owned.return_value = False
        return {"status": "success"}

    index_mock = MagicMock(side_effect=index)
    fail_mock = MagicMock(
        side_effect=AssertionError("Lost owner must not fail the candidate")
    )
    cleanup_mock = MagicMock(
        side_effect=AssertionError("Version cleanup must use its persisted ledger")
    )
    with ExitStack() as stack:
        for target, replacement in {
            "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context": MagicMock(
                return_value=nullcontext(lease)
            ),
            "app.tasks.knowledge_tasks.SessionLocal": MagicMock(
                side_effect=_session_factory()
            ),
            "app.services.knowledge.index_state_machine.mark_document_index_started": MagicMock(
                return_value=SimpleNamespace(
                    should_execute=outcome != "deleted", reason="document_not_found"
                )
            ),
            "app.services.knowledge.indexing.run_document_indexing": index_mock,
            "app.services.knowledge.web_publication.publish_candidate": MagicMock(
                return_value=False
            ),
            "app.services.knowledge.index_state_machine.mark_document_index_failed": fail_mock,
            "app.tasks.knowledge_tasks._cleanup_late_index_or_retry": cleanup_mock,
        }.items():
            stack.enter_context(patch(target, replacement))
        result = index_document_task.run(**_task_kwargs(), publication_generation=5)

    fail_mock.assert_not_called()
    cleanup_mock.assert_not_called()
    if outcome != "deleted":
        index_mock.assert_called_once()
    assert result["status"] == "skipped"
    assert (
        result["reason"]
        == {
            "lost_lease": "lease_lost",
            "superseded": "stale_or_already_finalized",
            "deleted": "document_not_found",
        }[outcome]
    )


def test_index_document_task_compensates_a_late_index_after_a_failed_write():
    """An indexing failure that arrives after the document is gone cleans up."""
    start_decision = MagicMock(should_execute=True, reason="started")
    cleanup_mock = MagicMock(return_value=True)

    with _task_request_context(retries=0), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
                "app.services.knowledge.index_state_machine.mark_document_index_failed",
                return_value=False,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.run_document_indexing",
                side_effect=RuntimeError("runtime unavailable"),
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks._delete_late_index_if_document_was_deleted",
                cleanup_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            )
        )
        result = index_document_task.run(**_task_kwargs())

    cleanup_mock.assert_called_once()
    assert result["reason"] == "stale_failure"


def test_index_document_task_retries_a_failed_late_index_cleanup():
    """A failed compensation retries instead of ending as a clean skip."""
    from celery.exceptions import Retry

    start_decision = MagicMock(should_execute=True, reason="started")
    cleanup_mock = MagicMock(side_effect=RuntimeError("vector store down"))
    retry_mock = MagicMock(side_effect=Retry("retry requested"))

    with _task_request_context(retries=0), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
                return_value=False,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.run_document_indexing",
                return_value={"status": "success", "chunks_data": []},
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks._delete_late_index_if_document_was_deleted",
                cleanup_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            )
        )
        stack.enter_context(patch.object(index_document_task, "retry", retry_mock))
        with pytest.raises(Retry):
            index_document_task.run(**_task_kwargs())

    cleanup_mock.assert_called_once()
    retry_mock.assert_called_once()
    assert retry_mock.call_args.kwargs["countdown"] > 0


def test_index_document_task_owns_a_failed_cleanup_outside_a_worker():
    """A direct call cannot retry, so the cleanup failure is its own failure."""
    start_decision = MagicMock(should_execute=True, reason="started")
    cleanup_mock = MagicMock(side_effect=RuntimeError("vector store down"))

    with _task_request_context(retries=0), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
                return_value=False,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.run_document_indexing",
                return_value={"status": "success", "chunks_data": []},
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks._delete_late_index_if_document_was_deleted",
                cleanup_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            )
        )
        with pytest.raises(LateIndexCleanupError, match="vector store down"):
            index_document_task.run(**_task_kwargs())

    cleanup_mock.assert_called_once()


def test_index_document_task_reports_an_exhausted_late_index_cleanup():
    """The last allowed attempt re-raises, so the cleanup failure stays visible."""
    start_decision = MagicMock(should_execute=True, reason="started")
    cleanup_mock = MagicMock(side_effect=RuntimeError("vector store down"))
    retry_mock = MagicMock()

    with (
        _task_request_context(retries=settings.KNOWLEDGE_INDEX_LOCK_MAX_RETRIES),
        ExitStack() as stack,
    ):
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
                return_value=False,
            )
        )
        stack.enter_context(
            patch(
                "app.services.knowledge.indexing.run_document_indexing",
                return_value={"status": "success", "chunks_data": []},
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks._delete_late_index_if_document_was_deleted",
                cleanup_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            )
        )
        stack.enter_context(patch.object(index_document_task, "retry", retry_mock))
        with pytest.raises(LateIndexCleanupError, match="vector store down"):
            index_document_task.run(**_task_kwargs())

    cleanup_mock.assert_called_once()
    retry_mock.assert_not_called()


def test_index_document_task_retry_only_cleans_a_deleted_document():
    """A retried task for a deleted document cleans up instead of indexing again."""
    start_decision = MagicMock(should_execute=False, reason="document_not_found")
    cleanup_mock = MagicMock(return_value=True)
    indexing_mock = MagicMock()

    with _task_request_context(retries=1), ExitStack() as stack:
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.distributed_lock.owned_watchdog_context",
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
                "app.services.knowledge.indexing.run_document_indexing",
                indexing_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks._delete_late_index_if_document_was_deleted",
                cleanup_mock,
            )
        )
        stack.enter_context(
            patch(
                "app.tasks.knowledge_tasks.SessionLocal",
                side_effect=_session_factory(),
            )
        )
        result = index_document_task.run(**_task_kwargs())

    indexing_mock.assert_not_called()
    cleanup_mock.assert_called_once()
    assert result["status"] == "skipped"
    assert result["reason"] == "document_not_found"
    assert result["deleted_late_index"] is True


def test_delete_late_index_uses_deleted_document_ref():
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    gateway = MagicMock()
    gateway.delete_document_index = AsyncMock(return_value={"status": "deleted"})
    delete_spec = object()

    with (
        patch(
            "app.services.knowledge.indexing.get_kb_index_info",
            return_value=SimpleNamespace(index_owner_user_id=9),
        ),
        patch(
            "app.services.rag.runtime_resolver.RagRuntimeResolver.build_delete_runtime_spec",
            return_value=delete_spec,
        ) as build_spec,
        patch(
            "app.services.rag.gateway_factory.get_rag_gateway",
            return_value=gateway,
        ),
    ):
        deleted = _delete_late_index_if_document_was_deleted(
            db=db,
            document_id=4,
            knowledge_base_id="1",
            user_id=3,
        )

    assert deleted is True
    build_spec.assert_called_once_with(
        db=db,
        knowledge_base_id=1,
        document_ref="4",
        index_owner_user_id=9,
    )
    gateway.delete_document_index.assert_awaited_once_with(delete_spec, db=db)
