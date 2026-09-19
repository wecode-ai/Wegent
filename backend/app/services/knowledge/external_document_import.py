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
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import ObjectDeletedError

from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.schemas.knowledge import ContentOrigin, DocumentProcessingStage
from app.services.knowledge.external_document_providers import (
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
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.processing_errors import build_processing_error

logger = logging.getLogger(__name__)

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


@dataclass
class ExternalDocumentBatchImportResult:
    """Outcome of a batch external document import."""

    created: list[KnowledgeDocument]
    updated: list[KnowledgeDocument]
    processing: list[KnowledgeDocument]
    requested_count: int


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
        provider = self._validate_import_context(
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
        """Queue a single-version refresh while preserving local organization.

        Every caller — a manual reimport and an automatic refresh alike —
        goes through the same dispatched task, so there is one way to start
        an import attempt. ``external_meta`` refreshes the provider-owned
        metadata a manual import just resolved; a caller that has none (an
        automatic refresh holds only a resource id) passes nothing.
        """
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
        document.is_active = False
        # Invalidate until the fetched body lands with its corresponding
        # timestamp. Overwrite the key first: the saved baseline may carry it.
        refreshed_metadata = dict(external_meta or {})
        refreshed_metadata["source_update_time"] = None
        document.update_external_source_config(**refreshed_metadata)
        db.commit()
        db.refresh(document)
        self._dispatch_import_task(db, document)
        logger.info(
            "[External Import] Refresh queued document_id=%s kb_id=%s generation=%s "
            "previous_attachment_id=%s",
            document.id,
            document.kind_id,
            document.index_generation,
            document.attachment_id,
        )
        return ExternalDocumentRefreshResult(document, started=True)

    def request_source_refresh(
        self, db: Session, user: User, document_id: int
    ) -> KnowledgeDocument:
        """Force an imported external document to fetch its source again."""
        document = self._load_manageable_external_document(
            db, user, document_id, action="synchronized"
        )
        # Any imported external document can re-fetch its source: DingTalk
        # copies follow the same refresh path as the scheduled copy update.
        refresh = self.refresh_existing_document(
            db, document, document.external_source_config
        )
        if not refresh.started:
            raise ExternalDocumentImportError(
                "This document is still being processed; retry later", status_code=409
            )
        return refresh.document

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
        provider = self._validate_import_context(
            db, user, knowledge_base_id, provider_id
        )
        if folder_id:
            assert_document_can_be_placed_in_folder(
                db, knowledge_base_id, folder_id, content_origin=ContentOrigin.USER
            )

        # Deduplicate by external identity while preserving request order.
        resource_ids = list(dict.fromkeys(external_resource_ids))
        if len(resource_ids) > MAX_EXTERNAL_BATCH_IMPORT:
            raise ExternalDocumentImportError(
                f"At most {MAX_EXTERNAL_BATCH_IMPORT} documents can be imported "
                "in one batch"
            )

        resolved, refreshable, processing = self._resolve_batch_items(
            db, user, provider, knowledge_base_id, resource_ids
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
        document = self._load_manageable_external_document(
            db, user, document_id, action="retried"
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

    def _load_manageable_external_document(
        self,
        db: Session,
        user: User,
        document_id: int,
        *,
        action: str,
    ) -> KnowledgeDocument:
        """Load a copy the user may act on, or raise the status to surface.

        The manual retry and the manual source sync are the same per-document
        write on the same kind of copy, so both resolve the document and its
        permissions here; ``action`` only names the operation in the message.
        """
        document = db.get(KnowledgeDocument, document_id)
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
                f"Only imported external documents can be {action}"
            )
        return document

    def _resolve_batch_items(
        self,
        db: Session,
        user: User,
        provider: ExternalDocumentProvider,
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
        provider: ExternalDocumentProvider,
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
        provider: ExternalDocumentProvider,
        document: KnowledgeDocument,
    ) -> dict:
        """Use the original importer's authorization, as the worker does."""
        owner = db.get(User, document.user_id)
        if owner is None:
            raise ExternalDocumentImportError("The original importer no longer exists")
        return provider.resolve_importable(db, owner, document.external_resource_id)

    @staticmethod
    def _validate_import_context(
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
    user: User,
    *,
    generation: int,
) -> None:
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
    provider = get_external_document_provider(provider_id or "")
    try:
        if provider is None:
            raise ExternalDocumentFetchError(
                f"Unsupported external provider: {provider_id}"
            )
        if user is None:
            raise ExternalDocumentFetchError(
                f"Owner user {owner_user_id} no longer exists"
            )
        content: ExternalDocumentContent = asyncio.run(
            provider.fetch_content(db, user, resource_id)
        )
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
    except (ExternalImportLostWriteError, ObjectDeletedError):
        logger.info(
            "[External Import] Attempt for document %s lost its write right at "
            "generation %s; standing down without touching the document",
            document_id,
            generation,
        )
    except ExternalSourceUnavailableError as exc:
        _mark_external_source_unavailable(
            db, document_id, provider_id, generation, error=exc
        )
        logger.warning(
            "[External Import] Source of document %s is no longer accessible: %s",
            document_id,
            exc,
        )
    except Exception as exc:
        db.rollback()
        _mark_external_import_failed(db, document_id, provider_id, generation)
        logger.error(
            "[External Import] Failed to import document %s: %s",
            document_id,
            exc,
            exc_info=True,
        )


def _mark_external_source_unavailable(
    db: Session,
    document_id: int,
    provider_id: str,
    generation: int,
    *,
    error: ExternalSourceUnavailableError,
) -> None:
    """Mark the source inaccessible and record the initial import failure.

    The placeholder is kept for an explicit retry. The source is only marked
    when this attempt's failure actually landed; a stale generation must not
    overwrite the outcome of a newer attempt. The provider's own message
    (with its logId) is what the user sees, per DingTalk's troubleshooting
    guidance.
    """
    message = str(error).strip()
    mark_document_index_failed(
        db=db,
        document_id=document_id,
        generation=generation,
        error=build_processing_error(
            stage=DocumentProcessingStage.SYSTEM,
            code=error.error_code,
            message=(
                message[:1000]
                if message
                else (
                    "The external source is no longer accessible. Restore "
                    "access and retry the import."
                )
            ),
            retryable=True,
            generation=generation,
            provider=provider_id,
        ),
    )


def _mark_external_import_failed(
    db: Session,
    document_id: int,
    provider_id: str,
    generation: int,
) -> None:
    """Record the fetch failure on the document without deleting it."""
    mark_document_index_failed(
        db=db,
        document_id=document_id,
        generation=generation,
        error=build_processing_error(
            stage=DocumentProcessingStage.SYSTEM,
            code="external_import_failed",
            message=(
                "The external document could not be imported. Please retry later."
            ),
            retryable=True,
            generation=generation,
            provider=provider_id,
        ),
    )


external_document_import_service = ExternalDocumentImportService()
