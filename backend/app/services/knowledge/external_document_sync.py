# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Daily synchronization decisions for versioned external documents."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentSourceType,
    KnowledgeDocument,
)
from app.models.user import User
from app.services.knowledge.external_document_import import (
    external_document_import_service,
)
from app.services.knowledge.external_sync_providers import (
    ExternalSyncLocator,
    SyncCandidate,
    get_document_sync_config,
    get_external_sync_provider,
)
from app.services.knowledge.orchestrator import knowledge_orchestrator

logger = logging.getLogger(__name__)

_CURSOR_CACHE_KEY = "external-document-sync:scan-cursor"


@dataclass
class SyncReport:
    scanned: int = 0
    eligible: int = 0
    unchanged: int = 0
    refreshed: int = 0
    reindexed: int = 0
    skipped: int = 0
    failed: int = 0
    next_cursor: int = 0


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _merge_sync_config(document: KnowledgeDocument, **updates: Any) -> None:
    source_config = dict(document.source_config or {})
    external = dict(source_config.get("external") or {})
    sync = dict(external.get("sync") or {})
    for key, value in updates.items():
        if value is None and key == "last_error_code":
            sync.pop(key, None)
        else:
            sync[key] = value
    external["sync"] = sync
    source_config["external"] = external
    document.source_config = source_config


class ExternalDocumentSyncModule:
    """Scan existing rows and hide provider-specific synchronization details."""

    async def run_daily_sync(self, db: Session, *, scan_limit: int) -> SyncReport:
        raw_cursor = await cache_manager.get(_CURSOR_CACHE_KEY)
        try:
            cursor = max(0, int(raw_cursor or 0))
        except (TypeError, ValueError):
            cursor = 0

        documents = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.id > cursor,
                KnowledgeDocument.source_type == DocumentSourceType.EXTERNAL.value,
            )
            .order_by(KnowledgeDocument.id.asc())
            .limit(scan_limit)
            .all()
        )
        report = SyncReport(scanned=len(documents))
        report.next_cursor = documents[-1].id if len(documents) == scan_limit else 0

        candidates_by_provider: dict[str, list[SyncCandidate]] = {}
        documents_by_id: dict[int, KnowledgeDocument] = {}
        for document in documents:
            sync = get_document_sync_config(document)
            if not sync.get("enabled"):
                continue
            provider_id = str(document.external_provider or "")
            connection_id = str(sync.get("connection_id") or "")
            resource_id = str(sync.get("resource_id") or "")
            provider = get_external_sync_provider(provider_id)
            if not provider or not connection_id or not resource_id:
                report.failed += 1
                _merge_sync_config(
                    document,
                    last_checked_at=_utc_iso(),
                    last_error_code="external_sync_config_invalid",
                )
                continue
            candidate = SyncCandidate(
                document_id=document.id,
                owner_user_id=document.user_id,
                locator=ExternalSyncLocator(provider_id, connection_id, resource_id),
            )
            candidates_by_provider.setdefault(provider_id, []).append(candidate)
            documents_by_id[document.id] = document
            report.eligible += 1
        db.commit()

        for provider_id, candidates in candidates_by_provider.items():
            provider = get_external_sync_provider(provider_id)
            if provider is None:
                continue
            try:
                states = await provider.inspect_remote_states(db, candidates)
            except Exception:
                logger.exception(
                    "[External Sync] Provider inspection failed provider=%s",
                    provider_id,
                )
                report.failed += len(candidates)
                for candidate in candidates:
                    _merge_sync_config(
                        documents_by_id[candidate.document_id],
                        last_checked_at=_utc_iso(),
                        last_error_code="external_provider_inspection_failed",
                    )
                db.commit()
                continue
            for candidate in candidates:
                document = documents_by_id[candidate.document_id]
                state = states.get(candidate.document_id)
                if state is None:
                    report.failed += 1
                    _merge_sync_config(
                        document,
                        last_checked_at=_utc_iso(),
                        last_error_code="external_sync_result_missing",
                    )
                    db.commit()
                    continue
                await self._apply_state(db, document, state, report)
        await cache_manager.set(_CURSOR_CACHE_KEY, report.next_cursor, expire=8 * 86400)
        return report

    async def _apply_state(
        self, db: Session, document: KnowledgeDocument, state: Any, report: SyncReport
    ) -> None:
        now = _utc_iso()
        if state.error_code or not state.exists:
            report.failed += 1
            if not state.exists and state.error_code == "external_source_missing":
                document.update_external_source_config(
                    status="inaccessible",
                    last_error="Wiki source document no longer exists",
                )
            _merge_sync_config(
                document,
                last_checked_at=now,
                last_error_code=state.error_code or "external_source_missing",
            )
            db.commit()
            return

        sync = get_document_sync_config(document)
        metadata = dict(state.metadata or {})
        if metadata.get("title"):
            document.name = str(metadata["title"])[:255]
        document.update_external_source_config(
            status="accessible",
            last_error=None,
            **({"url": metadata["url"]} if metadata.get("url") else {}),
        )
        _merge_sync_config(
            document,
            observed_version=state.remote_version,
            path=metadata.get("path", sync.get("path")),
            locale=metadata.get("locale", sync.get("locale")),
            last_checked_at=now,
            last_error_code=None,
        )
        db.commit()

        if document.index_status in {
            DocumentIndexStatus.QUEUED,
            DocumentIndexStatus.PENDING_CONVERSION,
            DocumentIndexStatus.CONVERTING,
            DocumentIndexStatus.INDEXING,
        }:
            report.skipped += 1
            return
        sync = get_document_sync_config(document)
        remote_version = state.remote_version
        if (
            remote_version == sync.get("indexed_version")
            and document.index_status == DocumentIndexStatus.SUCCESS
        ):
            report.unchanged += 1
            return
        try:
            if (
                remote_version != sync.get("content_version")
                or not document.attachment_id
            ):
                external_document_import_service.queue_source_refresh(db, document)
                report.refreshed += 1
                return
            owner = db.get(User, document.user_id)
            if owner is None:
                raise ValueError("Document owner no longer exists")
            knowledge_orchestrator.reindex_document(
                db=db, user=owner, document_id=document.id
            )
            report.reindexed += 1
        except Exception:
            db.rollback()
            report.failed += 1
            logger.exception(
                "[External Sync] Failed to schedule document=%s provider=%s",
                document.id,
                document.external_provider,
            )


external_document_sync_module = ExternalDocumentSyncModule()
