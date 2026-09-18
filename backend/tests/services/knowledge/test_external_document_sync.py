# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for provider-neutral daily external document synchronization."""

import asyncio
import logging
from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.services.knowledge.external_document_sync import (
    ConnectionSyncReport,
    ExternalDocumentSyncModule,
    PendingExternalRefresh,
    RefreshExecutionResult,
    SyncReport,
)
from app.services.knowledge.external_sync_providers import (
    PreparedExternalSyncBatch,
    RemoteDocumentState,
)


def _provider(states: dict[int, RemoteDocumentState]) -> SimpleNamespace:
    def prepare(_db, candidates):
        return PreparedExternalSyncBatch(
            payload=tuple(candidates),
            connection_names={
                (
                    candidate.owner_user_id,
                    candidate.locator.connection_id,
                ): "Primary Wiki"
                for candidate in candidates
            },
        )

    return SimpleNamespace(
        prepare_remote_inspection=prepare,
        inspect_remote_states=AsyncMock(return_value=states),
    )


def _create_synced_document(
    db: Session, user: User, *, remote_version: str
) -> KnowledgeDocument:
    kb = Kind(
        user_id=user.id,
        kind="KnowledgeBase",
        name=f"sync-kb-{user.id}",
        namespace="default",
        json={"spec": {"name": "Sync KB"}},
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    db.add(kb)
    db.flush()
    document = KnowledgeDocument(
        kind_id=kb.id,
        attachment_id=0,
        name="Wiki Runbook",
        file_extension="md",
        file_size=100,
        user_id=user.id,
        is_active=True,
        status="enabled",
        source_type="external",
        index_status=DocumentIndexStatus.SUCCESS,
        source_config={
            "external": {
                "provider": "wiki",
                "title": "Wiki Runbook",
                "sync": {
                    "enabled": True,
                    "connection_id": "conn-primary",
                    "resource_id": "42",
                    "observed_version": remote_version,
                    "content_version": remote_version,
                    "indexed_version": remote_version,
                },
            }
        },
        external_source=KnowledgeDocumentExternalSource(
            kind_id=kb.id,
            external_provider="wiki",
            external_resource_id="v1:conn-primary:42",
        ),
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


@pytest.mark.asyncio
async def test_daily_sync_skips_unchanged_indexed_document(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(
        test_db, test_user, remote_version="2026-09-06T01:00:00Z"
    )
    external = document.external_source_config
    sync = dict(external["sync"])
    sync["last_error_code"] = "external_source_missing"
    document.update_external_source_config(
        status="inaccessible",
        last_error="Wiki 源文档不存在",
        sync=sync,
    )
    test_db.commit()
    provider = _provider(
        {
            document.id: RemoteDocumentState(
                True,
                "2026-09-06T01:00:00Z",
                metadata={"title": "Wiki Runbook"},
            )
        }
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    cache_get = AsyncMock(return_value=0)
    cache_set = AsyncMock()
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get", cache_get
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", cache_set
    )
    prepare_refresh = MagicMock()
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "external_document_import_service.prepare_source_refresh",
        prepare_refresh,
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    assert report.eligible == 1
    assert report.unchanged == 1
    assert report.refreshed == 0
    prepare_refresh.assert_not_called()
    assert cache_set.await_count == 2
    document = test_db.get(KnowledgeDocument, document.id)
    assert document is not None
    external = document.external_source_config
    assert external["status"] == "accessible"
    assert "last_error" not in external
    assert "last_error_code" not in external["sync"]


@pytest.mark.asyncio
async def test_daily_sync_queues_changed_remote_document(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    document = _create_synced_document(
        test_db, test_user, remote_version="2026-09-06T01:00:00Z"
    )
    provider = _provider(
        {
            document.id: RemoteDocumentState(
                True,
                "2026-09-06T02:00:00Z",
                metadata={"title": "Wiki Runbook v2", "path": "ops/runbook"},
            )
        }
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )
    dispatch_import = MagicMock()
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import."
        "external_document_import_service._dispatch_import_task",
        dispatch_import,
    )
    execute_refresh = AsyncMock(
        return_value=RefreshExecutionResult(started=True, failed=False)
    )
    sync_module = ExternalDocumentSyncModule()
    monkeypatch.setattr(
        sync_module,
        "_execute_refresh",
        execute_refresh,
        raising=False,
    )

    with caplog.at_level(
        logging.INFO,
        logger="app.services.knowledge.external_document_sync",
    ):
        report = await sync_module.run_daily_sync(test_db, scan_limit=100)

    document = test_db.get(KnowledgeDocument, document.id)
    assert document is not None
    assert report.refreshed == 1
    assert report.updates_detected == 1
    summary = next(iter(report.connection_summaries.values()))
    assert summary.connection_name == "Primary Wiki"
    assert summary.scanned == 1
    assert summary.eligible == 1
    assert summary.updates_detected == 1
    assert summary.refresh_queued == 1
    assert document.name == "Wiki Runbook v2"
    assert document.source_config["external"]["sync"]["observed_version"] == (
        "2026-09-06T02:00:00Z"
    )
    dispatch_import.assert_not_called()
    execute_refresh.assert_awaited_once()
    assert "[External Sync] update detected" in caplog.text
    assert f"document_id={document.id}" in caplog.text
    assert f"knowledge_base_id={document.kind_id}" in caplog.text
    assert "name='Wiki Runbook v2'" in caplog.text
    assert "provider=wiki" in caplog.text
    assert "connector=wikijs" in caplog.text
    assert "connection_id='conn-primary'" in caplog.text
    assert "resource_kind=page" in caplog.text
    assert "path='ops/runbook'" in caplog.text
    assert "previous_version='2026-09-06T01:00:00Z'" in caplog.text
    assert "remote_version='2026-09-06T02:00:00Z'" in caplog.text
    assert "action=refresh" in caplog.text


@pytest.mark.asyncio
async def test_daily_sync_limits_parallel_source_downloads(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = [
        _create_synced_document(test_db, test_user, remote_version="v1")
        for _ in range(6)
    ]
    provider = _provider(
        {
            document.id: RemoteDocumentState(True, f"v2-{document.id}")
            for document in documents
        }
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )
    monkeypatch.setattr(settings, "WIKI_SYNC_DOWNLOAD_CONCURRENCY", 2)
    active = 0
    max_active = 0

    async def execute_refresh(_refresh) -> RefreshExecutionResult:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return RefreshExecutionResult(started=True, failed=False)

    sync_module = ExternalDocumentSyncModule()
    monkeypatch.setattr(
        sync_module,
        "_execute_refresh",
        execute_refresh,
        raising=False,
    )
    dispatch_import = MagicMock()
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import."
        "external_document_import_service._dispatch_import_task",
        dispatch_import,
    )

    report = await sync_module.run_daily_sync(test_db, scan_limit=100)

    assert report.refreshed == len(documents)
    assert max_active == 2
    assert all(
        test_db.get(KnowledgeDocument, document.id).index_status
        == DocumentIndexStatus.SUCCESS
        for document in documents
    )
    dispatch_import.assert_not_called()


@pytest.mark.asyncio
async def test_pending_refresh_failure_does_not_cancel_other_downloads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_report = ConnectionSyncReport("wiki", 1, "conn-a", "Wiki A")
    second_report = ConnectionSyncReport("wiki", 2, "conn-b", "Wiki B")
    refreshes = [
        PendingExternalRefresh(1, 1, "wiki", first_report),
        PendingExternalRefresh(2, 1, "wiki", second_report),
    ]
    completed: list[int] = []

    async def execute_refresh(
        refresh: PendingExternalRefresh,
    ) -> RefreshExecutionResult:
        completed.append(refresh.document_id)
        return RefreshExecutionResult(
            started=True,
            failed=refresh.document_id == 1,
        )

    sync_module = ExternalDocumentSyncModule()
    monkeypatch.setattr(sync_module, "_execute_refresh", execute_refresh)
    report = SyncReport()

    await sync_module._run_pending_refreshes(refreshes, report)

    assert completed == [1, 2]
    assert report.failed == 1
    assert first_report.failed == 1
    assert second_report.failed == 0


@pytest.mark.asyncio
async def test_execute_refresh_claims_generation_before_async_download(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(test_db, test_user, remote_version="v1")

    @contextmanager
    def session_local():
        yield test_db

    run_import = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.SessionLocal",
        session_local,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "run_external_document_import_async",
        run_import,
    )
    pending = PendingExternalRefresh(
        document.id,
        document.index_generation,
        "wiki",
        ConnectionSyncReport("wiki", test_user.id, "conn-primary", "Primary Wiki"),
    )

    result = await ExternalDocumentSyncModule._execute_refresh(pending)

    assert result == RefreshExecutionResult(started=True, failed=False)
    current = test_db.get(KnowledgeDocument, document.id)
    assert current is not None
    assert current.index_generation == pending.expected_generation + 2
    run_import.assert_awaited_once()
    assert run_import.await_args.kwargs["generation"] == current.index_generation


@pytest.mark.asyncio
async def test_daily_sync_does_not_count_a_rejected_refresh_as_queued(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(test_db, test_user, remote_version="v1")
    provider = _provider({document.id: RemoteDocumentState(True, "v2")})
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "external_document_import_service.prepare_source_refresh",
        MagicMock(
            return_value=SimpleNamespace(
                started=False,
                reason="already_in_progress",
            )
        ),
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    summary = next(iter(report.connection_summaries.values()))
    assert report.updates_detected == 1
    assert report.refreshed == 0
    assert report.skipped == 1
    assert summary.refresh_queued == 0
    assert summary.skipped == 1


@pytest.mark.asyncio
async def test_daily_sync_reindexes_local_content_after_failed_index(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    document = _create_synced_document(
        test_db, test_user, remote_version="2026-09-06T02:00:00Z"
    )
    sync = dict(document.source_config["external"]["sync"])
    sync["indexed_version"] = "2026-09-06T01:00:00Z"
    document.update_external_source_config(sync=sync)
    document.attachment_id = 123
    test_db.commit()
    provider = _provider(
        {document.id: RemoteDocumentState(True, "2026-09-06T02:00:00Z")}
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )
    prepare_refresh = MagicMock()
    reindex = MagicMock()
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "external_document_import_service.prepare_source_refresh",
        prepare_refresh,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "knowledge_orchestrator.reindex_document",
        reindex,
    )

    with caplog.at_level(
        logging.INFO,
        logger="app.services.knowledge.external_document_sync",
    ):
        report = await ExternalDocumentSyncModule().run_daily_sync(
            test_db, scan_limit=100
        )

    assert report.reindexed == 1
    assert report.refreshed == 0
    summary = next(iter(report.connection_summaries.values()))
    assert summary.updates_detected == 1
    assert summary.reindex_queued == 1
    prepare_refresh.assert_not_called()
    reindex.assert_called_once()
    assert reindex.call_args.kwargs["db"] is test_db
    assert reindex.call_args.kwargs["user"].id == test_user.id
    assert reindex.call_args.kwargs["document_id"] == document.id
    assert "[External Sync] update detected" in caplog.text
    assert "action=reindex" in caplog.text


@pytest.mark.asyncio
async def test_daily_sync_marks_missing_wiki_source_without_breaking_index(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(
        test_db, test_user, remote_version="2026-09-06T02:00:00Z"
    )
    provider = _provider(
        {
            document.id: RemoteDocumentState(
                False,
                None,
                error_code="external_source_missing",
            )
        }
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    document = test_db.get(KnowledgeDocument, document.id)
    assert document is not None
    external = document.source_config["external"]
    assert report.failed == 0
    assert report.source_missing == 1
    summary = next(iter(report.connection_summaries.values()))
    assert summary.source_missing == 1
    assert summary.failed == 0
    assert document.index_status == DocumentIndexStatus.SUCCESS
    assert document.is_active is True
    assert external["status"] == "inaccessible"
    assert external["last_error"] == "Wiki 源文档不存在"
    assert external["sync"]["last_error_code"] == "external_source_missing"


@pytest.mark.asyncio
async def test_daily_sync_records_transient_source_error_without_breaking_index(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(
        test_db, test_user, remote_version="2026-09-06T02:00:00Z"
    )
    provider = _provider(
        {
            document.id: RemoteDocumentState(
                True,
                None,
                error_code="wiki_connection_failed",
                error_message="无法连接 Wiki 站点",
            )
        }
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )

    await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    current = test_db.get(KnowledgeDocument, document.id)
    assert current is not None
    external = current.external_source_config
    assert current.index_status == DocumentIndexStatus.SUCCESS
    assert current.is_active is True
    assert external["status"] == "sync_error"
    assert external["last_error"] == "无法连接 Wiki 站点"


@pytest.mark.asyncio
async def test_daily_sync_skips_connector_without_scheduled_sync_support(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(test_db, test_user, remote_version="v1")

    def prepare(_db, candidates):
        candidate = candidates[0]
        return PreparedExternalSyncBatch(
            payload=(),
            skipped_document_ids=frozenset({candidate.document_id}),
            connection_names={
                (
                    candidate.owner_user_id,
                    candidate.locator.connection_id,
                ): "Manual Wiki"
            },
        )

    provider = SimpleNamespace(
        prepare_remote_inspection=prepare,
        inspect_remote_states=AsyncMock(return_value={}),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )
    prepare_refresh = MagicMock()
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "external_document_import_service.prepare_source_refresh",
        prepare_refresh,
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    current = test_db.get(KnowledgeDocument, document.id)
    assert current is not None
    assert report.scanned == 1
    assert report.eligible == 1
    assert report.skipped == 1
    assert report.failed == 0
    assert report.unchanged == 0
    summary = next(iter(report.connection_summaries.values()))
    assert summary.connection_name == "Manual Wiki"
    assert summary.skipped == 1
    assert summary.failed == 0
    assert current.index_status == DocumentIndexStatus.SUCCESS
    assert current.external_source_config["sync"] == {
        "enabled": True,
        "connection_id": "conn-primary",
        "resource_id": "42",
        "observed_version": "v1",
        "content_version": "v1",
        "indexed_version": "v1",
    }
    prepare_refresh.assert_not_called()


@pytest.mark.asyncio
async def test_schedule_failure_does_not_rollback_prior_batch_metadata(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = _create_synced_document(test_db, test_user, remote_version="v1")
    second = _create_synced_document(test_db, test_user, remote_version="v1")
    provider = _provider(
        {
            first.id: RemoteDocumentState(
                True,
                None,
                error_code="wiki_connection_failed",
            ),
            second.id: RemoteDocumentState(True, "v2"),
        }
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "external_document_import_service.prepare_source_refresh",
        MagicMock(side_effect=RuntimeError("broker unavailable")),
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    test_db.expire_all()
    first = test_db.get(KnowledgeDocument, first.id)
    second = test_db.get(KnowledgeDocument, second.id)
    assert first is not None
    assert second is not None
    assert report.failed == 2
    assert first.external_source_config["status"] == "sync_error"
    assert first.external_source_config["sync"]["last_error_code"] == (
        "wiki_connection_failed"
    )
    assert second.external_source_config["sync"]["observed_version"] == "v2"


@pytest.mark.asyncio
async def test_daily_sync_continues_batches_without_session_during_remote_io(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = [
        _create_synced_document(test_db, test_user, remote_version="v1")
        for _ in range(3)
    ]

    async def inspect(prepared):
        assert test_db.in_transaction() is False
        return {
            candidate.document_id: RemoteDocumentState(True, "v1")
            for candidate in prepared.payload
        }

    provider = SimpleNamespace(
        prepare_remote_inspection=lambda _db, candidates: PreparedExternalSyncBatch(
            payload=tuple(candidates)
        ),
        inspect_remote_states=AsyncMock(side_effect=inspect),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.get_external_sync_provider",
        lambda provider_id: provider if provider_id == "wiki" else None,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.get",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync.cache_manager.set", AsyncMock()
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=2)

    assert report.scanned == len(documents)
    assert report.unchanged == len(documents)
    assert provider.inspect_remote_states.await_count == 2
