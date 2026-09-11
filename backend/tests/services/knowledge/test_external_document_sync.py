# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for provider-neutral daily external document synchronization."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.services.knowledge.external_document_sync import (
    ExternalDocumentSyncModule,
)
from app.services.knowledge.external_sync_providers import RemoteDocumentState


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
        last_error="Wiki source document no longer exists",
        sync=sync,
    )
    test_db.commit()
    provider = SimpleNamespace(
        inspect_remote_states=AsyncMock(
            return_value={
                document.id: RemoteDocumentState(
                    True,
                    "2026-09-06T01:00:00Z",
                    metadata={"title": "Wiki Runbook"},
                )
            }
        )
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
    queue_refresh = MagicMock()
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "external_document_import_service.queue_source_refresh",
        queue_refresh,
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    assert report.eligible == 1
    assert report.unchanged == 1
    assert report.refreshed == 0
    queue_refresh.assert_not_called()
    cache_set.assert_awaited_once()
    test_db.refresh(document)
    external = document.external_source_config
    assert external["status"] == "accessible"
    assert "last_error" not in external
    assert "last_error_code" not in external["sync"]


@pytest.mark.asyncio
async def test_daily_sync_queues_changed_remote_document(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(
        test_db, test_user, remote_version="2026-09-06T01:00:00Z"
    )
    provider = SimpleNamespace(
        inspect_remote_states=AsyncMock(
            return_value={
                document.id: RemoteDocumentState(
                    True,
                    "2026-09-06T02:00:00Z",
                    metadata={"title": "Wiki Runbook v2", "path": "ops/runbook"},
                )
            }
        )
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
    queue_refresh = MagicMock(return_value=SimpleNamespace(started=True))
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "external_document_import_service.queue_source_refresh",
        queue_refresh,
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    test_db.refresh(document)
    assert report.refreshed == 1
    assert document.name == "Wiki Runbook v2"
    assert document.source_config["external"]["sync"]["observed_version"] == (
        "2026-09-06T02:00:00Z"
    )
    queue_refresh.assert_called_once()


@pytest.mark.asyncio
async def test_daily_sync_reindexes_local_content_after_failed_index(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(
        test_db, test_user, remote_version="2026-09-06T02:00:00Z"
    )
    sync = document.source_config["external"]["sync"]
    sync["indexed_version"] = "2026-09-06T01:00:00Z"
    document.source_config = {**document.source_config}
    document.attachment_id = 123
    test_db.commit()
    provider = SimpleNamespace(
        inspect_remote_states=AsyncMock(
            return_value={
                document.id: RemoteDocumentState(True, "2026-09-06T02:00:00Z")
            }
        )
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
    queue_refresh = MagicMock()
    reindex = MagicMock()
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "external_document_import_service.queue_source_refresh",
        queue_refresh,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_sync."
        "knowledge_orchestrator.reindex_document",
        reindex,
    )

    report = await ExternalDocumentSyncModule().run_daily_sync(test_db, scan_limit=100)

    assert report.reindexed == 1
    assert report.refreshed == 0
    queue_refresh.assert_not_called()
    reindex.assert_called_once_with(db=test_db, user=test_user, document_id=document.id)


@pytest.mark.asyncio
async def test_daily_sync_marks_missing_wiki_source_without_breaking_index(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_synced_document(
        test_db, test_user, remote_version="2026-09-06T02:00:00Z"
    )
    provider = SimpleNamespace(
        inspect_remote_states=AsyncMock(
            return_value={
                document.id: RemoteDocumentState(
                    False,
                    None,
                    error_code="external_source_missing",
                )
            }
        )
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

    test_db.refresh(document)
    external = document.source_config["external"]
    assert report.failed == 1
    assert document.index_status == DocumentIndexStatus.SUCCESS
    assert document.is_active is True
    assert external["status"] == "inaccessible"
    assert external["sync"]["last_error_code"] == "external_source_missing"
