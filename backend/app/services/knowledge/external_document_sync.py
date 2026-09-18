# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Daily synchronization decisions for versioned external documents."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session, contains_eager, load_only

from app.core.cache import cache_manager
from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentSourceType,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.services.knowledge.external_document_import import (
    external_document_import_service,
)
from app.services.knowledge.external_sync_providers import (
    ExternalSyncLocator,
    ExternalSyncProvider,
    RemoteDocumentState,
    SyncCandidate,
    build_wiki_resource_ref,
    get_document_sync_config,
    get_external_sync_provider,
    list_external_sync_provider_ids,
)
from app.services.knowledge.orchestrator import knowledge_orchestrator
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

_CURSOR_CACHE_PREFIX = "external-document-sync:scan-cursor"


@dataclass
class ConnectionSyncReport:
    """Synchronization counters for one owner-scoped external connection."""

    provider_id: str
    owner_user_id: int
    connection_id: str
    connection_name: str
    scanned: int = 0
    eligible: int = 0
    updates_detected: int = 0
    refresh_queued: int = 0
    reindex_queued: int = 0
    unchanged: int = 0
    source_missing: int = 0
    skipped: int = 0
    failed: int = 0


@dataclass
class SyncReport:
    scanned: int = 0
    eligible: int = 0
    updates_detected: int = 0
    unchanged: int = 0
    refreshed: int = 0
    reindexed: int = 0
    source_missing: int = 0
    skipped: int = 0
    failed: int = 0
    next_cursors: dict[str, int] = field(default_factory=dict)
    connection_summaries: dict[str, ConnectionSyncReport] = field(default_factory=dict)


def _connection_summary_key(
    provider_id: str, owner_user_id: int, connection_id: str
) -> str:
    return f"{provider_id}:{owner_user_id}:{connection_id}"


def _get_connection_report(
    report: SyncReport,
    *,
    provider_id: str,
    owner_user_id: int,
    connection_id: str,
) -> ConnectionSyncReport:
    key = _connection_summary_key(provider_id, owner_user_id, connection_id)
    summary = report.connection_summaries.get(key)
    if summary is None:
        summary = ConnectionSyncReport(
            provider_id=provider_id,
            owner_user_id=owner_user_id,
            connection_id=connection_id,
            connection_name=connection_id,
        )
        report.connection_summaries[key] = summary
    return summary


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

    @trace_async(
        span_name="knowledge.external_document_daily_sync",
        tracer_name="knowledge.external_sync",
    )
    async def run_daily_sync(
        self,
        db: Session,
        *,
        scan_limit: int,
        max_documents: int | None = None,
        time_budget_seconds: int | None = None,
    ) -> SyncReport:
        """Scan all provider cursors while releasing DB connections for remote I/O."""
        report = SyncReport()
        started = time.monotonic()
        remaining = max_documents if max_documents is not None else 2**63 - 1
        budget = time_budget_seconds or 0

        for provider_id in list_external_sync_provider_ids():
            if remaining <= 0 or self._budget_exhausted(started, budget):
                break
            remaining = await self._sync_provider(
                db,
                provider_id=provider_id,
                scan_limit=scan_limit,
                remaining=remaining,
                started=started,
                budget=budget,
                report=report,
            )
        return report

    async def _sync_provider(
        self,
        db: Session,
        *,
        provider_id: str,
        scan_limit: int,
        remaining: int,
        started: float,
        budget: int,
        report: SyncReport,
    ) -> int:
        cursor_key = f"{_CURSOR_CACHE_PREFIX}:{provider_id}"
        cursor = await self._read_cursor(cursor_key)
        provider = get_external_sync_provider(provider_id)
        while remaining > 0:
            if self._budget_exhausted(started, budget):
                report.next_cursors[provider_id] = cursor
                break
            batch_size = min(scan_limit, remaining)
            documents = self._scan_documents(
                db, provider_id=provider_id, cursor=cursor, limit=batch_size
            )
            if not documents:
                await self._store_cursor(cursor_key, provider_id, 0, report)
                break
            report.scanned += len(documents)
            remaining -= len(documents)
            cursor = documents[-1].id
            candidates = self._build_candidates(provider_id, documents, report)
            db.commit()
            if provider is not None and candidates:
                states, connection_names, skipped_document_ids = (
                    await self._inspect_candidates(
                        db, provider_id, provider, candidates
                    )
                )
                self._apply_connection_names(report, provider_id, connection_names)
                await self._apply_inspection_results(
                    db,
                    candidates,
                    states,
                    skipped_document_ids,
                    report,
                )
                db.commit()
            await self._store_cursor(cursor_key, provider_id, cursor, report)
            if len(documents) < batch_size:
                await self._store_cursor(cursor_key, provider_id, 0, report)
                break
        return remaining

    @staticmethod
    def _budget_exhausted(started: float, budget: int) -> bool:
        return bool(budget and time.monotonic() - started >= budget)

    @staticmethod
    def _scan_documents(
        db: Session, *, provider_id: str, cursor: int, limit: int
    ) -> list[KnowledgeDocument]:
        return (
            db.query(KnowledgeDocument)
            .join(
                KnowledgeDocumentExternalSource,
                KnowledgeDocumentExternalSource.document_id == KnowledgeDocument.id,
            )
            .options(
                contains_eager(KnowledgeDocument.external_source),
                load_only(
                    KnowledgeDocument.id,
                    KnowledgeDocument.user_id,
                    KnowledgeDocument.source_type,
                    KnowledgeDocument.source_config,
                ),
            )
            .filter(
                KnowledgeDocument.id > cursor,
                KnowledgeDocument.source_type == DocumentSourceType.EXTERNAL.value,
                KnowledgeDocumentExternalSource.external_provider == provider_id,
            )
            .order_by(KnowledgeDocument.id.asc())
            .limit(limit)
            .all()
        )

    @staticmethod
    async def _read_cursor(cursor_key: str) -> int:
        raw_cursor = await cache_manager.get(cursor_key)
        try:
            return max(0, int(raw_cursor or 0))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    async def _store_cursor(
        cursor_key: str,
        provider_id: str,
        cursor: int,
        report: SyncReport,
    ) -> None:
        report.next_cursors[provider_id] = cursor
        await cache_manager.set(cursor_key, cursor, expire=8 * 86400)

    @staticmethod
    async def _inspect_candidates(
        db: Session,
        provider_id: str,
        provider: ExternalSyncProvider,
        candidates: list[SyncCandidate],
    ) -> tuple[
        dict[int, RemoteDocumentState | None],
        dict[tuple[int, str], str],
        frozenset[int],
    ]:
        prepared = provider.prepare_remote_inspection(db, candidates)
        db.commit()
        try:
            states = await provider.inspect_remote_states(prepared)
        except Exception:
            logger.exception(
                "[External Sync] Provider inspection failed provider=%s", provider_id
            )
            states = {candidate.document_id: None for candidate in candidates}
        return states, prepared.connection_names, prepared.skipped_document_ids

    @staticmethod
    def _apply_connection_names(
        report: SyncReport,
        provider_id: str,
        connection_names: dict[tuple[int, str], str],
    ) -> None:
        for (owner_user_id, connection_id), connection_name in connection_names.items():
            summary = _get_connection_report(
                report,
                provider_id=provider_id,
                owner_user_id=owner_user_id,
                connection_id=connection_id,
            )
            summary.connection_name = connection_name

    @staticmethod
    def _build_candidates(
        provider_id: str,
        documents: list[KnowledgeDocument],
        report: SyncReport,
    ) -> list[SyncCandidate]:
        candidates: list[SyncCandidate] = []
        for document in documents:
            sync = get_document_sync_config(document)
            try:
                locator, resource_ref = build_wiki_resource_ref(
                    provider_id,
                    str(document.external_resource_id or ""),
                    sync,
                )
            except Exception:
                locator = None
                resource_ref = None
            connection_id = str(
                sync.get("connection_id")
                or (locator.connection_id if locator is not None else "unknown")
            )
            connection_report = _get_connection_report(
                report,
                provider_id=provider_id,
                owner_user_id=document.user_id,
                connection_id=connection_id,
            )
            connection_report.scanned += 1
            if locator is None or resource_ref is None:
                report.failed += 1
                connection_report.failed += 1
                _merge_sync_config(
                    document,
                    last_checked_at=_utc_iso(),
                    last_error_code="external_sync_config_invalid",
                )
                continue
            candidates.append(
                SyncCandidate(
                    document_id=document.id,
                    owner_user_id=document.user_id,
                    locator=ExternalSyncLocator(
                        provider_id,
                        locator.connection_id,
                        locator.resource_id,
                        resource_kind=locator.resource_kind,
                        identity_version=locator.identity_version,
                    ),
                    resource_ref=resource_ref,
                )
            )
            report.eligible += 1
            connection_report.eligible += 1
        return candidates

    async def _apply_inspection_results(
        self,
        db: Session,
        candidates: list[SyncCandidate],
        states: dict[int, RemoteDocumentState | None],
        skipped_document_ids: frozenset[int],
        report: SyncReport,
    ) -> None:
        candidate_by_id = {candidate.document_id: candidate for candidate in candidates}
        documents = (
            db.query(KnowledgeDocument)
            .join(KnowledgeDocument.external_source)
            .options(contains_eager(KnowledgeDocument.external_source))
            .filter(KnowledgeDocument.id.in_(candidate_by_id))
            .all()
        )
        documents_by_id = {document.id: document for document in documents}
        for document_id, candidate in candidate_by_id.items():
            connection_report = _get_connection_report(
                report,
                provider_id=candidate.locator.provider_id,
                owner_user_id=candidate.owner_user_id,
                connection_id=candidate.locator.connection_id,
            )
            document = documents_by_id.get(document_id)
            if document is None or not self._still_matches(document, candidate):
                report.skipped += 1
                connection_report.skipped += 1
                continue
            if document_id in skipped_document_ids:
                report.skipped += 1
                connection_report.skipped += 1
                continue
            state = states.get(document_id)
            if state is None:
                report.failed += 1
                connection_report.failed += 1
                document.update_external_source_config(
                    status="sync_error",
                    last_error="外部文档同步未返回检查结果",
                )
                _merge_sync_config(
                    document,
                    last_checked_at=_utc_iso(),
                    last_error_code="external_sync_result_missing",
                )
                continue
            await self._apply_state(db, document, state, report, connection_report)

    @staticmethod
    def _still_matches(document: KnowledgeDocument, candidate: SyncCandidate) -> bool:
        try:
            locator, resource_ref = build_wiki_resource_ref(
                candidate.locator.provider_id,
                str(document.external_resource_id or ""),
                get_document_sync_config(document),
            )
        except Exception:
            return False
        return bool(
            locator == candidate.locator
            and (
                candidate.resource_ref is None or resource_ref == candidate.resource_ref
            )
        )

    async def _apply_state(
        self,
        db: Session,
        document: KnowledgeDocument,
        state: RemoteDocumentState,
        report: SyncReport,
        connection_report: ConnectionSyncReport,
    ) -> None:
        now = _utc_iso()
        if state.error_code or not state.exists:
            if not state.exists and state.error_code == "external_source_missing":
                report.source_missing += 1
                connection_report.source_missing += 1
                document.update_external_source_config(
                    status="inaccessible",
                    last_error="Wiki 源文档不存在",
                )
            else:
                report.failed += 1
                connection_report.failed += 1
                document.update_external_source_config(
                    status="sync_error",
                    last_error=state.error_message or "外部文档同步检查失败",
                )
            _merge_sync_config(
                document,
                last_checked_at=now,
                last_error_code=state.error_code or "external_source_missing",
            )
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
            resource_kind=metadata.get("resource_kind", sync.get("resource_kind")),
            resource_key=metadata.get("resource_key", sync.get("resource_key")),
            file_extension=metadata.get("file_extension", sync.get("file_extension")),
            last_checked_at=now,
            last_error_code=None,
        )
        if document.index_status in {
            DocumentIndexStatus.QUEUED,
            DocumentIndexStatus.PENDING_CONVERSION,
            DocumentIndexStatus.CONVERTING,
            DocumentIndexStatus.INDEXING,
        }:
            report.skipped += 1
            connection_report.skipped += 1
            return
        sync = get_document_sync_config(document)
        remote_version = state.remote_version
        if (
            remote_version == sync.get("indexed_version")
            and document.index_status == DocumentIndexStatus.SUCCESS
        ):
            report.unchanged += 1
            connection_report.unchanged += 1
            return

        report.updates_detected += 1
        connection_report.updates_detected += 1
        refresh_required = (
            remote_version != sync.get("content_version") or not document.attachment_id
        )
        logger.info(
            "[External Sync] update detected document_id=%s knowledge_base_id=%s "
            "name=%r provider=%s connector=%s connection_id=%r "
            "resource_kind=%s path=%r previous_version=%r remote_version=%r "
            "action=%s",
            document.id,
            document.kind_id,
            document.name,
            document.external_provider,
            sync.get("adapter_type") or "wikijs",
            sync.get("connection_id"),
            sync.get("resource_kind") or "page",
            sync.get("path") or "",
            sync.get("indexed_version"),
            remote_version,
            "refresh" if refresh_required else "reindex",
        )

        # Scheduling uses the existing state machines, which may commit or roll
        # back independently. Persist this batch's accumulated metadata first so
        # one document's dispatch failure cannot roll back earlier results.
        db.commit()
        try:
            if refresh_required:
                refresh = external_document_import_service.queue_source_refresh(
                    db, document
                )
                if refresh.started:
                    report.refreshed += 1
                    connection_report.refresh_queued += 1
                else:
                    report.skipped += 1
                    connection_report.skipped += 1
                return
            owner = db.get(User, document.user_id)
            if owner is None:
                raise ValueError("Document owner no longer exists")
            knowledge_orchestrator.reindex_document(
                db=db, user=owner, document_id=document.id
            )
            report.reindexed += 1
            connection_report.reindex_queued += 1
        except Exception:
            db.rollback()
            report.failed += 1
            connection_report.failed += 1
            logger.exception(
                "[External Sync] Failed to schedule document=%s provider=%s",
                document.id,
                document.external_provider,
            )


external_document_sync_module = ExternalDocumentSyncModule()
