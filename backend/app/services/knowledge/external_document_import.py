# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External document import service.

Validates an import request, creates the visible placeholder document, and
drives the background body fetch. The import itself reuses the existing
attachment / conversion / indexing state machine — no import-task table.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import ObjectDeletedError

from app.core.config import settings
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.schemas.knowledge import ContentOrigin, DocumentProcessingStage
from app.services.knowledge.external_document_identity import WIKI_PROVIDER_ID
from app.services.knowledge.external_document_providers import (
    DetachedExternalDocumentProvider,
    DirectExternalDocumentImportProvider,
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    ExternalDocumentProvider,
    ExternalImportLostWriteError,
    ExternalSourceUnavailableError,
    get_external_document_provider,
)
from app.services.knowledge.folder_policy import assert_document_can_be_placed_in_folder
from app.services.knowledge.index_state_machine import (
    ACTIVE_INDEX_STATUSES,
    mark_document_index_enqueue_failed,
    mark_document_index_failed,
    prepare_document_index_enqueue,
    prepare_external_refresh_enqueue,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.processing_errors import build_processing_error
from shared.telemetry.decorators import set_span_attribute

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from app.services.knowledge.external_sync_providers import ResolvedExternalDocument

# Maximum external documents a single batch import may create.
MAX_EXTERNAL_BATCH_IMPORT = 50
MAX_DOCUMENT_NAME_LENGTH = 255


def _external_document_name(external_meta: dict) -> str:
    """Fit the display name to the document column without losing source metadata."""
    return str(external_meta["title"])[:MAX_DOCUMENT_NAME_LENGTH]


@dataclass(frozen=True)
class ExternalDocumentRefreshResult:
    """Outcome of asking an existing external document to refresh."""

    document: KnowledgeDocument
    started: bool
    reason: str = ""


@dataclass(frozen=True)
class ExternalImportObservabilityContext:
    """Stable identity used to correlate one external import attempt."""

    document_id: int
    knowledge_base_id: int
    provider_id: str
    generation: int


@dataclass
class ExternalDocumentBatchImportResult:
    """Outcome of a batch external document import."""

    created: list[KnowledgeDocument]
    updated: list[KnowledgeDocument]
    processing: list[KnowledgeDocument]
    requested_count: int
    duplicates: list[KnowledgeDocument] = field(default_factory=list)


@dataclass(frozen=True)
class _ResolvedImportPlan:
    """One mutation selected only after the entire resolved batch is validated."""

    action: str
    resource_id: str
    metadata: dict
    document: KnowledgeDocument | None = None


class ExternalDocumentImportService:
    """External document import orchestration (single and batch)."""

    def get_import_statuses(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        provider_id: str,
        external_resource_ids: list[str],
    ) -> dict[str, DocumentIndexStatus]:
        """Read current copies without fetching provider content or queuing work."""
        provider = self._validate_provider_context(
            db, user, knowledge_base_id, provider_id
        )
        rows = (
            db.query(
                KnowledgeDocumentExternalSource.external_resource_id,
                KnowledgeDocument.index_status,
            )
            .join(KnowledgeDocument.external_source)
            .filter(
                KnowledgeDocumentExternalSource.kind_id == knowledge_base_id,
                KnowledgeDocumentExternalSource.external_provider
                == provider.provider_id,
                KnowledgeDocumentExternalSource.external_resource_id.in_(
                    external_resource_ids
                ),
            )
            .all()
        )
        return {resource_id: index_status for resource_id, index_status in rows}

    def import_document(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        provider_id: str,
        external_resource_id: str,
        folder_id: int = 0,
    ) -> KnowledgeDocument:
        """Import one resource through the same contract as a one-item batch."""
        result = self.import_documents(
            db=db,
            user=user,
            knowledge_base_id=knowledge_base_id,
            provider_id=provider_id,
            external_resource_ids=[external_resource_id],
            folder_id=folder_id,
        )
        return (result.created or result.updated or result.processing)[0]

    def refresh_existing_document(
        self,
        db: Session,
        document: KnowledgeDocument,
        external_meta: dict | None = None,
        *,
        expected_generation: int | None = None,
    ) -> ExternalDocumentRefreshResult:
        """Queue a single-version refresh while preserving local organization."""
        refresh = self.prepare_source_refresh(
            db,
            document,
            external_meta,
            expected_generation=expected_generation,
        )
        if not refresh.started:
            return refresh
        self._dispatch_import_task(db, refresh.document)
        logger.info(
            "[External Import] Refresh queued document_id=%s kb_id=%s generation=%s "
            "previous_attachment_id=%s",
            refresh.document.id,
            refresh.document.kind_id,
            refresh.document.index_generation,
            refresh.document.attachment_id,
        )
        return refresh

    def prepare_source_refresh(
        self,
        db: Session,
        document: KnowledgeDocument,
        external_meta: dict | None = None,
        *,
        expected_generation: int | None = None,
    ) -> ExternalDocumentRefreshResult:
        """Prepare refresh state without choosing how the body fetch is executed."""
        from app.services.knowledge.external_sync_providers import (
            is_synchronized_external_document,
        )

        synchronized = (
            document.external_provider == WIKI_PROVIDER_ID
            and is_synchronized_external_document(document)
        )
        if synchronized:
            decision = prepare_external_refresh_enqueue(
                db=db,
                document_id=document.id,
                expected_generation=expected_generation,
            )
        else:
            decision = prepare_document_index_enqueue(
                db=db,
                document_id=document.id,
                allow_if_success=True,
                expected_generation=expected_generation,
            )
        if not decision.should_enqueue:
            if decision.reason in {"already_in_progress", "stale_generation"}:
                db.refresh(document)
                return ExternalDocumentRefreshResult(
                    document, started=False, reason=decision.reason
                )
            status_code = 404 if decision.reason == "document_not_found" else 409
            raise ExternalDocumentImportError(
                f"External document refresh was not started: {decision.reason}",
                status_code=status_code,
            )

        db.refresh(document)
        if not synchronized:
            document.is_active = False
        # Invalidate until the fetched body lands with its corresponding timestamp.
        refreshed_metadata = dict(external_meta or {})
        refreshed_metadata["source_update_time"] = None
        document.update_external_source_config(**refreshed_metadata)
        db.commit()
        db.refresh(document)
        return ExternalDocumentRefreshResult(document, started=True)

    def import_resolved_documents(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        provider_id: str,
        resolved_documents: list[ResolvedExternalDocument],
        folder_id: int = 0,
    ) -> ExternalDocumentBatchImportResult:
        """Import metadata already resolved by a trusted async provider adapter.

        Existing import callers keep their synchronous resolve contract. This
        narrow entry lets an async source such as Wiki validate remote pages
        before reusing the same placeholder and worker pipeline.
        """
        provider = self._validate_provider_context(
            db, user, knowledge_base_id, provider_id
        )
        from app.services.knowledge.external_sync_providers import (  # noqa: PLC0415
            get_external_sync_provider,
        )

        sync_provider = get_external_sync_provider(provider_id)
        if sync_provider is None:
            raise ExternalDocumentImportError(
                f"External document provider does not support resolved import: "
                f"{provider_id}"
            )
        if len(resolved_documents) > MAX_EXTERNAL_BATCH_IMPORT:
            raise ExternalDocumentImportError(
                f"At most {MAX_EXTERNAL_BATCH_IMPORT} documents can be imported "
                "in one batch"
            )
        if folder_id:
            assert_document_can_be_placed_in_folder(
                db, knowledge_base_id, folder_id, content_origin=ContentOrigin.USER
            )
        sync_provider.preflight_resolved_import(db, user, resolved_documents)
        plans, duplicates, requested_count = self._plan_resolved_imports(
            db,
            knowledge_base_id,
            provider,
            resolved_documents,
        )

        created: list[KnowledgeDocument] = []
        updated: list[KnowledgeDocument] = []
        processing: list[KnowledgeDocument] = []
        for plan in plans:
            if plan.action == "processing":
                assert plan.document is not None
                processing.append(plan.document)
                continue
            if plan.action == "refresh":
                assert plan.document is not None
                refresh = self.refresh_existing_document(
                    db, plan.document, plan.metadata
                )
                (updated if refresh.started else processing).append(refresh.document)
                continue
            try:
                document = KnowledgeService.create_external_document(
                    db=db,
                    knowledge_base_id=knowledge_base_id,
                    user_id=user.id,
                    name=_external_document_name(plan.metadata),
                    external_provider=provider.provider_id,
                    external_resource_id=plan.resource_id,
                    folder_id=folder_id,
                    external_meta=plan.metadata,
                )
            except IntegrityError:
                db.rollback()
                concurrent = self._find_existing_document(
                    db,
                    knowledge_base_id,
                    provider.provider_id,
                    plan.resource_id,
                )
                if concurrent is None:
                    raise ExternalDocumentImportError(
                        "This external document could not be imported; please retry"
                    ) from None
                processing.append(concurrent)
                continue
            self._dispatch_import_task(db, document)
            created.append(document)
        return ExternalDocumentBatchImportResult(
            created=created,
            updated=updated,
            processing=processing,
            requested_count=requested_count,
            duplicates=duplicates,
        )

    def _plan_resolved_imports(
        self,
        db: Session,
        knowledge_base_id: int,
        provider: ExternalDocumentProvider,
        resolved_documents: list[ResolvedExternalDocument],
    ) -> tuple[list[_ResolvedImportPlan], list[KnowledgeDocument], int]:
        """Classify every item and reject all conflicts before any mutation."""
        plans: list[_ResolvedImportPlan] = []
        duplicates: list[KnowledgeDocument] = []
        canonical_wiki_documents: dict[tuple[str, str, str], KnowledgeDocument] = {}
        if provider.provider_id == WIKI_PROVIDER_ID:
            from app.services.knowledge.external_sync_providers import (
                get_document_sync_config,
            )

            existing_wiki_documents = (
                db.query(KnowledgeDocument)
                .join(KnowledgeDocument.external_source)
                .filter(
                    KnowledgeDocumentExternalSource.kind_id == knowledge_base_id,
                    KnowledgeDocumentExternalSource.external_provider
                    == WIKI_PROVIDER_ID,
                )
                .all()
            )
            for document in existing_wiki_documents:
                sync = get_document_sync_config(document)
                site_url = str(sync.get("site_url") or "").rstrip("/")
                adapter_type = str(sync.get("adapter_type") or "wikijs")
                canonical_id = str(
                    sync.get("resource_key") or sync.get("resource_id") or ""
                )
                if site_url and canonical_id:
                    canonical_wiki_documents[(adapter_type, site_url, canonical_id)] = (
                        document
                    )
        seen: set[str] = set()
        for resolved in resolved_documents:
            resource_id = resolved.encoded_resource_id
            if resource_id in seen:
                continue
            seen.add(resource_id)
            metadata = resolved.external_metadata()
            existing = self._find_existing_document(
                db, knowledge_base_id, provider.provider_id, resource_id
            )
            resolved_sync = dict(metadata.get("sync") or {})
            canonical_key = (
                str(resolved_sync.get("adapter_type") or "wikijs"),
                str(resolved_sync.get("site_url") or "").rstrip("/"),
                str(
                    resolved_sync.get("resource_key")
                    or resolved_sync.get("resource_id")
                    or ""
                ),
            )
            canonical_existing = canonical_wiki_documents.get(canonical_key)
            if existing is None and canonical_existing is not None:
                duplicates.append(canonical_existing)
                continue
            if existing:
                from app.services.knowledge.external_sync_providers import (
                    is_synchronized_external_document,
                )

                if not is_synchronized_external_document(existing):
                    raise ExternalDocumentImportError(
                        "This external resource is already bound in another mode",
                        status_code=409,
                    )
                if self._is_processing(existing):
                    plans.append(
                        _ResolvedImportPlan(
                            "processing", resource_id, metadata, existing
                        )
                    )
                    continue
                plans.append(
                    _ResolvedImportPlan("refresh", resource_id, metadata, existing)
                )
                continue
            plans.append(_ResolvedImportPlan("create", resource_id, metadata))
        return plans, duplicates, len(seen)

    def request_source_refresh(
        self, db: Session, user: User, document_id: int
    ) -> KnowledgeDocument:
        """Force a synchronized external document to fetch its source again."""
        document = db.get(KnowledgeDocument, document_id)
        if document is None:
            raise ExternalDocumentImportError("Document not found", status_code=404)
        kb, has_access = KnowledgeService.get_knowledge_base(
            db=db, knowledge_base_id=document.kind_id, user_id=user.id
        )
        if not kb or not has_access:
            raise ExternalDocumentImportError("Document not found", status_code=404)
        if not KnowledgeService.can_manage_knowledge_base_documents(
            db, document.kind_id, user.id
        ):
            raise ExternalDocumentImportError(
                "You do not have permission to manage documents in this knowledge base",
                status_code=403,
            )
        from app.services.knowledge.external_sync_providers import (
            is_synchronized_external_document,
        )

        if not document.has_external_identity or not is_synchronized_external_document(
            document
        ):
            raise ExternalDocumentImportError(
                "Only synchronized external documents can be synchronized"
            )
        refresh = self.queue_source_refresh(db, document)
        if not refresh.started:
            raise ExternalDocumentImportError(
                "This document is still being processed; retry later", status_code=409
            )
        return refresh.document

    def queue_source_refresh(
        self, db: Session, document: KnowledgeDocument
    ) -> ExternalDocumentRefreshResult:
        """Queue a refresh after the caller has established authorization."""
        return self.refresh_existing_document(
            db, document, document.external_source_config
        )

    def import_documents(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        provider_id: str,
        external_resource_ids: list[str],
        folder_id: int = 0,
    ) -> ExternalDocumentBatchImportResult:
        """Validate a batch import and create one placeholder per document.

        External identities are deduplicated up front. Existing settled
        documents refresh on the same record; active attempts are reported
        without dispatching duplicate work.
        Raises ExternalDocumentImportError when the request itself is invalid.
        """
        provider = self._validate_direct_import_context(
            db, user, knowledge_base_id, provider_id
        )
        if folder_id:
            assert_document_can_be_placed_in_folder(
                db, knowledge_base_id, folder_id, content_origin=ContentOrigin.USER
            )

        # Deduplicate by external identity while preserving request order.
        resource_ids = list(dict.fromkeys(external_resource_ids))
        max_batch = settings.KNOWLEDGE_EXTERNAL_BATCH_IMPORT_MAX
        if len(resource_ids) > max_batch:
            raise ExternalDocumentImportError(
                f"At most {max_batch} documents can be imported in one batch"
            )

        resolved, refreshable, processing = self._resolve_batch_items(
            db,
            user,
            provider,
            knowledge_base_id,
            resource_ids,
        )
        updated: list[KnowledgeDocument] = []
        for document, external_meta in refreshable:
            refresh = self.refresh_existing_document(db, document, external_meta)
            (updated if refresh.started else processing).append(refresh.document)

        created = self._create_batch_documents(
            db, user, provider, knowledge_base_id, folder_id, resolved, processing
        )
        logger.info(
            "[External Import] Batch import into KB %s created %s documents, "
            "updated %s documents, and reused %s active attempts",
            knowledge_base_id,
            len(created),
            len(updated),
            len(processing),
        )
        return ExternalDocumentBatchImportResult(
            created=created,
            updated=updated,
            processing=processing,
            requested_count=len(resource_ids),
        )

    def retry_document_import(
        self,
        db: Session,
        user: User,
        document_id: int,
    ) -> KnowledgeDocument:
        """
        Re-dispatch the background import for an existing failed record.

        Reuses the same KnowledgeDocument (no copy is created): the retry
        claim advances the index generation and requeues the document, then
        the regular import task re-fetches the external body. This is the
        dedicated entry for external imports because every retry must fetch the
        provider's latest body before replacing the attachment and reindexing.

        Raises:
            ExternalDocumentImportError: With the HTTP status to surface.
        """
        document = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )
        if document is None:
            raise ExternalDocumentImportError("Document not found", status_code=404)

        kb, has_access = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=document.kind_id,
            user_id=user.id,
        )
        if not kb or not has_access:
            raise ExternalDocumentImportError("Document not found", status_code=404)
        if not KnowledgeService.can_manage_knowledge_base_documents(
            db, document.kind_id, user.id
        ):
            raise ExternalDocumentImportError(
                "You do not have permission to manage documents in this "
                "knowledge base",
                status_code=403,
            )

        if not document.has_external_identity:
            raise ExternalDocumentImportError(
                "Only imported external documents can be retried"
            )

        decision = prepare_document_index_enqueue(db=db, document_id=document.id)
        if not decision.should_enqueue:
            reason_messages = {
                "already_in_progress": (
                    "This document is still being processed; retry later"
                ),
                "already_indexed": "This document is already imported",
                "document_not_found": "Document not found",
            }
            message = reason_messages.get(
                decision.reason, f"Retry skipped: {decision.reason}"
            )
            status_code = 404 if decision.reason == "document_not_found" else 409
            raise ExternalDocumentImportError(message, status_code=status_code)

        db.refresh(document)
        self._dispatch_import_task(db, document)
        logger.info(
            "[External Import] Retry dispatched for document %s at generation %s",
            document.id,
            decision.generation,
        )
        return document

    def _resolve_batch_items(
        self,
        db: Session,
        user: User,
        provider: DirectExternalDocumentImportProvider,
        knowledge_base_id: int,
        resource_ids: list[str],
    ) -> tuple[
        list[tuple[str, dict]],
        list[tuple[KnowledgeDocument, dict]],
        list[KnowledgeDocument],
    ]:
        """Classify requested resources into new and existing documents.

        Every new or refreshable resource is resolved before any document is
        changed, so an invalid item rejects the batch without partial updates.
        Active copies are reused without requiring the source directory.
        """
        existing = {
            document.external_resource_id: document
            for document in db.query(KnowledgeDocument)
            .join(KnowledgeDocument.external_source)
            .filter(
                KnowledgeDocumentExternalSource.kind_id == knowledge_base_id,
                KnowledgeDocumentExternalSource.external_provider
                == provider.provider_id,
                KnowledgeDocumentExternalSource.external_resource_id.in_(resource_ids),
            )
        }
        resolved: list[tuple[str, dict]] = []
        refreshable: list[tuple[KnowledgeDocument, dict]] = []
        processing: list[KnowledgeDocument] = []
        for resource_id in resource_ids:
            existing_document = existing.get(resource_id)
            if existing_document is not None:
                db.refresh(existing_document)
                if self._is_processing(existing_document):
                    processing.append(existing_document)
                else:
                    refreshable.append(
                        (
                            existing_document,
                            self._resolve_existing_source(
                                db, provider, existing_document
                            ),
                        )
                    )
                continue
            resolved.append(
                (resource_id, provider.resolve_importable(db, user, resource_id))
            )
        return resolved, refreshable, processing

    def _create_batch_documents(
        self,
        db: Session,
        user: User,
        provider: DirectExternalDocumentImportProvider,
        knowledge_base_id: int,
        folder_id: int,
        resolved: list[tuple[str, dict]],
        processing: list[KnowledgeDocument],
    ) -> list[KnowledgeDocument]:
        """Create one placeholder per resolved resource and dispatch fetches."""
        created: list[KnowledgeDocument] = []
        for resource_id, external_meta in resolved:
            try:
                document = KnowledgeService.create_external_document(
                    db=db,
                    knowledge_base_id=knowledge_base_id,
                    user_id=user.id,
                    name=_external_document_name(external_meta),
                    external_provider=provider.provider_id,
                    external_resource_id=resource_id,
                    folder_id=folder_id,
                    external_meta=external_meta,
                )
            except IntegrityError:
                # Another request won creation. Its fresh placeholder is
                # already processing, so reuse it without another dispatch.
                db.rollback()
                concurrent = self._find_existing_document(
                    db, knowledge_base_id, provider.provider_id, resource_id
                )
                if concurrent is None:
                    raise ExternalDocumentImportError(
                        "This external document could not be imported; please retry"
                    ) from None
                processing.append(concurrent)
                continue
            self._dispatch_import_task(db, document)
            created.append(document)
        return created

    @staticmethod
    def _resolve_existing_source(
        db: Session,
        provider: DirectExternalDocumentImportProvider,
        document: KnowledgeDocument,
    ) -> dict:
        """Use the original importer's authorization, as the worker does."""
        owner = db.get(User, document.user_id)
        if owner is None:
            raise ExternalDocumentImportError("The original importer no longer exists")
        return provider.resolve_importable(db, owner, document.external_resource_id)

    @staticmethod
    def _validate_provider_context(
        db: Session,
        user: User,
        knowledge_base_id: int,
        provider_id: str,
    ) -> ExternalDocumentProvider:
        """Validate provider, knowledge base access and manage permission."""
        provider = get_external_document_provider(provider_id)
        if provider is None:
            raise ExternalDocumentImportError(
                f"Unsupported external document provider: {provider_id}"
            )

        kb, has_access = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
        )
        if not kb or not has_access:
            raise ExternalDocumentImportError(
                "Knowledge base not found or access denied", status_code=404
            )
        if not KnowledgeService.can_manage_knowledge_base_documents(
            db, knowledge_base_id, user.id
        ):
            raise ExternalDocumentImportError(
                "You do not have permission to add documents to this knowledge base",
                status_code=403,
            )
        return provider

    @classmethod
    def _validate_direct_import_context(
        cls,
        db: Session,
        user: User,
        knowledge_base_id: int,
        provider_id: str,
    ) -> DirectExternalDocumentImportProvider:
        """Validate a provider that supports caller-supplied resource IDs."""
        provider = cls._validate_provider_context(
            db, user, knowledge_base_id, provider_id
        )
        if isinstance(provider, DirectExternalDocumentImportProvider):
            return provider
        if provider.provider_id == WIKI_PROVIDER_ID:
            raise ExternalDocumentImportError(
                "Wiki documents must be imported through the Wiki selector"
            )
        raise ExternalDocumentImportError(
            f"External document provider does not support direct import: {provider_id}"
        )

    @staticmethod
    def _find_existing_document(
        db: Session,
        knowledge_base_id: int,
        provider_id: str,
        external_resource_id: str,
    ) -> KnowledgeDocument | None:
        """Return the document already holding this external identity, if any."""
        return (
            db.query(KnowledgeDocument)
            .join(KnowledgeDocument.external_source)
            .filter(
                KnowledgeDocumentExternalSource.kind_id == knowledge_base_id,
                KnowledgeDocumentExternalSource.external_provider == provider_id,
                KnowledgeDocumentExternalSource.external_resource_id
                == external_resource_id,
            )
            .first()
        )

    @staticmethod
    def _is_processing(document: KnowledgeDocument) -> bool:
        """Treat every active state as owned by its current import attempt."""
        return document.index_status in ACTIVE_INDEX_STATUSES

    @staticmethod
    def _dispatch_import_task(db: Session, document: KnowledgeDocument) -> None:
        """Start the background body fetch for an external document."""
        from app.tasks.knowledge_tasks import import_external_document_task

        generation = document.index_generation
        try:
            queued = import_external_document_task.delay(
                document_id=document.id, expected_generation=generation
            )
        except Exception as exc:
            mark_document_index_enqueue_failed(
                db=db,
                document_id=document.id,
                generation=generation,
                error=build_processing_error(
                    stage=DocumentProcessingStage.DISPATCH,
                    code="external_import_dispatch_failed",
                    message="External import could not be started. Please retry.",
                    retryable=True,
                    generation=generation,
                ),
                preserve_active_sync_index=True,
            )
            db.refresh(document)
            logger.exception(
                "[External Import] Failed to dispatch document %s: %s",
                document.id,
                exc,
            )
            return
        logger.info(
            "[External Import] Body fetch queued document_id=%s kb_id=%s "
            "generation=%s task_id=%s",
            document.id,
            document.kind_id,
            generation,
            getattr(queued, "id", None) or "unavailable",
        )


def run_external_document_import(
    db: Session,
    document: KnowledgeDocument,
    user: User | None,
    *,
    generation: int,
) -> None:
    """Run one external import attempt from synchronous task code."""
    asyncio.run(
        run_external_document_import_async(
            db,
            document,
            user,
            generation=generation,
        )
    )


async def run_external_document_import_async(
    db: Session,
    document: KnowledgeDocument,
    user: User | None,
    *,
    generation: int,
) -> bool:
    """
    Fetch the external body, attach it, and start indexing.

    Runs inside the Celery worker for one claimed ``generation``. Any failure
    marks the document failed with a structured processing error (stale
    generations are ignored by the state machine); the placeholder itself is
    kept. A lost write right (document deleted or superseded mid-run) is not a
    failure: this attempt simply stands down. When the provider reports the
    source is gone or access was revoked during the initial import, the
    placeholder is marked inaccessible and remains available for retry.
    """
    from app.services.knowledge.orchestrator import knowledge_orchestrator

    # Keep error handling independent of ORM expiration across provider/upload I/O.
    document_id = document.id
    provider_id = document.external_provider
    resource_id = document.external_resource_id
    owner_user_id = document.user_id
    knowledge_base_id = document.kind_id
    fetch_started_at = time.perf_counter()
    failure_stage = "fetch"
    observability = ExternalImportObservabilityContext(
        document_id=document_id,
        knowledge_base_id=knowledge_base_id,
        provider_id=provider_id or "unknown",
        generation=generation,
    )
    _set_external_import_span_context(observability)
    try:
        if user is None:
            raise ExternalDocumentFetchError(
                f"Owner user {owner_user_id} no longer exists"
            )
        if not user.is_active:
            raise ExternalDocumentFetchError(f"Owner user {owner_user_id} is inactive")
        provider = get_external_document_provider(provider_id or "")
        if provider is None:
            raise ExternalDocumentFetchError(
                f"Unsupported external provider: {provider_id}"
            )
        if isinstance(provider, DetachedExternalDocumentProvider):
            prepared = provider.prepare_content_fetch(
                db,
                user,
                resource_id,
                document.external_source_config,
            )
            # Wiki remote I/O must not hold a checked-out database connection.
            db.commit()
            db.close()
            content: ExternalDocumentContent = await provider.fetch_prepared_content(
                prepared
            )
            document = db.get(KnowledgeDocument, document_id)
            user = db.get(User, owner_user_id)
            if document is None or user is None:
                raise ExternalImportLostWriteError(
                    "External document or owner disappeared during content fetch"
                )
        else:
            content = await provider.fetch_content(db, user, resource_id)
        _record_external_content_fetched(
            observability,
            fetch_elapsed_ms=round((time.perf_counter() - fetch_started_at) * 1000, 3),
        )
        failure_stage = "publish"
        knowledge_orchestrator.attach_external_document_content(
            db=db,
            document=document,
            user=user,
            content=content,
            generation=generation,
        )
        logger.info(
            "[External Import] Body landed document_id=%s kb_id=%s generation=%s "
            "attachment_id=%s content_bytes=%s provider_update_time=%s",
            document_id,
            document.kind_id,
            generation,
            document.attachment_id,
            len(content.content),
            (content.metadata or {}).get("source_update_time"),
        )
        return True
    except (ExternalImportLostWriteError, ObjectDeletedError):
        logger.info(
            "[External Import] Attempt for document %s lost its write right at "
            "generation %s; standing down without touching the document",
            document_id,
            generation,
        )
        return False
    except ExternalSourceUnavailableError as exc:
        _record_external_import_failure(
            observability,
            failure_stage=failure_stage,
            error_code=exc.error_code,
        )
        _mark_external_source_unavailable(
            db,
            document_id,
            provider_id,
            generation,
            message=_external_source_unavailable_message(provider_id, exc),
            error_code=exc.error_code,
        )
        logger.warning(
            "[External Import] Source of document %s is no longer accessible: %s",
            document_id,
            exc,
        )
        return False
    except Exception as exc:
        _record_external_import_failure(
            observability,
            failure_stage=failure_stage,
            error_code=str(getattr(exc, "error_code", "external_import_failed")),
        )
        db.rollback()
        error_code = (
            exc.error_code
            if isinstance(exc, ExternalDocumentFetchError)
            else "external_import_failed"
        )
        retryable = (
            exc.retryable if isinstance(exc, ExternalDocumentFetchError) else True
        )
        _mark_external_import_failed(
            db,
            document_id,
            provider_id,
            generation,
            message=_external_fetch_error_message(
                exc,
                fallback=(
                    "The external document could not be imported. Please retry later."
                ),
            ),
            error_code=error_code,
            retryable=retryable,
        )
        logger.error(
            "[External Import] Failed to import document %s: %s",
            document_id,
            exc,
            exc_info=True,
        )
        return False


def _set_external_import_span_context(
    context: ExternalImportObservabilityContext,
) -> None:
    attributes = {
        "knowledge.document_id": context.document_id,
        "knowledge.knowledge_base_id": context.knowledge_base_id,
        "knowledge.provider": context.provider_id,
        "knowledge.index_generation": context.generation,
    }
    for key, value in attributes.items():
        set_span_attribute(key, value)


def _record_external_content_fetched(
    context: ExternalImportObservabilityContext,
    *,
    fetch_elapsed_ms: float,
) -> None:
    details = {
        "knowledge_base_id": context.knowledge_base_id,
        "document_id": context.document_id,
        "provider": context.provider_id,
        "index_generation": context.generation,
        "fetch_elapsed_ms": fetch_elapsed_ms,
    }
    for key, value in details.items():
        if value is not None:
            set_span_attribute(f"knowledge.{key}", value)
    logger.info("[External Import] Content fetched", extra=details)


def _record_external_import_failure(
    context: ExternalImportObservabilityContext,
    *,
    failure_stage: str,
    error_code: str,
) -> None:
    set_span_attribute("knowledge.failure_stage", failure_stage)
    set_span_attribute("knowledge.error_code", error_code)
    logger.error(
        "[External Import] Attempt failed",
        extra={
            "knowledge_base_id": context.knowledge_base_id,
            "document_id": context.document_id,
            "failure_stage": failure_stage,
            "error_code": error_code,
        },
    )


def _mark_external_source_unavailable(
    db: Session,
    document_id: int,
    provider_id: str,
    generation: int,
    *,
    message: str,
    error_code: str,
) -> None:
    """Mark the source inaccessible and record the initial import failure.

    The placeholder is kept for an explicit retry. The source is only marked
    when this attempt's failure actually landed; a stale generation must not
    overwrite the outcome of a newer attempt.
    """
    mark_document_index_failed(
        db=db,
        document_id=document_id,
        generation=generation,
        error=build_processing_error(
            stage=DocumentProcessingStage.SYSTEM,
            code=error_code,
            message=message,
            retryable=True,
            generation=generation,
            provider=provider_id,
        ),
        preserve_active_sync_index=True,
    )


def _mark_external_import_failed(
    db: Session,
    document_id: int,
    provider_id: str,
    generation: int,
    *,
    message: str,
    error_code: str = "external_import_failed",
    retryable: bool = True,
) -> None:
    """Record the fetch failure on the document without deleting it."""
    finalized = mark_document_index_failed(
        db=db,
        document_id=document_id,
        generation=generation,
        error=build_processing_error(
            stage=DocumentProcessingStage.SYSTEM,
            code=error_code,
            message=message,
            retryable=retryable,
            generation=generation,
            provider=provider_id,
        ),
        preserve_active_sync_index=True,
    )
    if not finalized:
        return
    document = db.get(KnowledgeDocument, document_id)
    if document is None:
        return
    external = document.external_source_config
    sync = external.get("sync")
    if not isinstance(sync, dict) or not sync.get("enabled"):
        return
    sync = dict(sync)
    sync["last_error_code"] = error_code
    sync["last_error_retryable"] = retryable
    if retryable:
        sync.pop("failed_version", None)
    elif sync.get("observed_version"):
        sync["failed_version"] = sync["observed_version"]
    document.update_external_source_config(
        status="sync_error",
        last_error=message,
        sync=sync,
    )
    db.commit()


def _external_fetch_error_message(exc: Exception, *, fallback: str) -> str:
    """Return provider-vetted fetch text without exposing internal failures."""
    if not isinstance(exc, ExternalDocumentFetchError):
        return fallback
    message = str(exc).strip()
    return message[:1000] if message else fallback


def _external_source_unavailable_message(
    provider_id: str,
    exc: ExternalSourceUnavailableError,
) -> str:
    """Keep Wiki sync copy provider-specific without changing other providers."""
    if provider_id == WIKI_PROVIDER_ID:
        if exc.error_code == "external_source_missing":
            return _external_fetch_error_message(
                exc,
                fallback="外部源文档不存在",
            )
        return "外部源当前无法访问，请恢复访问后重试导入"
    return (
        "The external source is no longer accessible. Restore access "
        "and retry the import."
    )


external_document_import_service = ExternalDocumentImportService()
