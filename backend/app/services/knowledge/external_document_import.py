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

from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.schemas.knowledge import ContentOrigin, DocumentProcessingStage
from app.services.knowledge.external_document_providers import (
    ExternalDocumentAlreadyImportedError,
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    ExternalDocumentProvider,
    ExternalImportLostWriteError,
    get_external_document_provider,
)
from app.services.knowledge.folder_policy import assert_document_can_be_placed_in_folder
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.processing_errors import build_processing_error

logger = logging.getLogger(__name__)

# Maximum external documents a single batch import may create.
MAX_EXTERNAL_BATCH_IMPORT = 50


@dataclass
class SkippedExternalDocument:
    """An external resource skipped because it is already imported."""

    resource_id: str
    name: str


@dataclass
class ExternalDocumentBatchImportResult:
    """Outcome of a batch external document import."""

    imported: list[KnowledgeDocument]
    skipped_existing: list[SkippedExternalDocument]
    requested_count: int


class ExternalDocumentImportService:
    """External document import orchestration (single and batch)."""

    def import_document(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        provider_id: str,
        external_resource_id: str,
        folder_id: int = 0,
    ) -> KnowledgeDocument:
        """Validate the request and create the placeholder document.

        Returns the placeholder; the body fetch runs in a background task.

        Raises:
            ExternalDocumentImportError: With the HTTP status to surface.
        """
        provider = self._validate_import_context(
            db, user, knowledge_base_id, provider_id
        )

        external_meta = provider.resolve_importable(db, user, external_resource_id)

        existing = self._find_existing_document(
            db, knowledge_base_id, provider.provider_id, external_resource_id
        )
        if existing is not None:
            raise ExternalDocumentAlreadyImportedError(
                f"'{existing.name}' is already imported into this knowledge base"
            )

        try:
            document = KnowledgeService.create_external_document(
                db=db,
                knowledge_base_id=knowledge_base_id,
                user_id=user.id,
                name=external_meta["title"],
                external_provider=provider.provider_id,
                external_resource_id=external_resource_id,
                folder_id=folder_id,
                external_meta=external_meta,
            )
        except IntegrityError:
            # Concurrent duplicate submit hit the unique external identity.
            raise ExternalDocumentAlreadyImportedError(
                "This external document is already imported into this knowledge base"
            ) from None

        self._dispatch_import_task(document)
        logger.info(
            "[External Import] Created placeholder document %s for %s resource %s "
            "in KB %s",
            document.id,
            provider.provider_id,
            external_resource_id,
            knowledge_base_id,
        )
        return document

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

        External identities are deduplicated up front and already-imported
        resources are skipped (and reported) instead of failing the batch.
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

        resolved, skipped_existing = self._resolve_batch_items(
            db, user, provider, knowledge_base_id, resource_ids
        )
        imported = self._create_batch_documents(
            db, user, provider, knowledge_base_id, folder_id, resolved, skipped_existing
        )

        logger.info(
            "[External Import] Batch import into KB %s created %s placeholder "
            "documents and skipped %s already-imported resources",
            knowledge_base_id,
            len(imported),
            len(skipped_existing),
        )
        return ExternalDocumentBatchImportResult(
            imported=imported,
            skipped_existing=skipped_existing,
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
        dedicated entry for external imports — the ordinary reindex flow
        cannot work here because a failed import has no valid attachment.

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

        from app.services.knowledge.index_state_machine import (
            prepare_document_index_enqueue,
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
        self._dispatch_import_task(document)
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
        provider: ExternalDocumentProvider,
        knowledge_base_id: int,
        resource_ids: list[str],
    ) -> tuple[list[tuple[str, dict]], list[SkippedExternalDocument]]:
        """Classify the requested resources into importable and skipped.

        Every remaining resource is resolved before any placeholder is
        created so an invalid item rejects the whole batch without partial
        placeholders.
        """
        existing = {
            document.external_resource_id: document
            for document in db.query(KnowledgeDocument).filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
                KnowledgeDocument.external_provider == provider.provider_id,
                KnowledgeDocument.external_resource_id.in_(resource_ids),
            )
        }
        resolved: list[tuple[str, dict]] = []
        skipped: list[SkippedExternalDocument] = []
        for resource_id in resource_ids:
            existing_document = existing.get(resource_id)
            if existing_document is not None:
                skipped.append(
                    SkippedExternalDocument(resource_id, existing_document.name)
                )
                continue
            resolved.append(
                (resource_id, provider.resolve_importable(db, user, resource_id))
            )
        return resolved, skipped

    def _create_batch_documents(
        self,
        db: Session,
        user: User,
        provider: ExternalDocumentProvider,
        knowledge_base_id: int,
        folder_id: int,
        resolved: list[tuple[str, dict]],
        skipped_existing: list[SkippedExternalDocument],
    ) -> list[KnowledgeDocument]:
        """Create one placeholder per resolved resource and dispatch fetches."""
        imported: list[KnowledgeDocument] = []
        for resource_id, external_meta in resolved:
            try:
                document = KnowledgeService.create_external_document(
                    db=db,
                    knowledge_base_id=knowledge_base_id,
                    user_id=user.id,
                    name=external_meta["title"],
                    external_provider=provider.provider_id,
                    external_resource_id=resource_id,
                    folder_id=folder_id,
                    external_meta=external_meta,
                )
            except IntegrityError:
                # Concurrent duplicate submit hit the unique external identity;
                # report it as skipped instead of failing the batch.
                db.rollback()
                concurrent = self._find_existing_document(
                    db, knowledge_base_id, provider.provider_id, resource_id
                )
                skipped_existing.append(
                    SkippedExternalDocument(
                        resource_id, concurrent.name if concurrent else ""
                    )
                )
                continue
            self._dispatch_import_task(document)
            imported.append(document)
        return imported

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
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
                KnowledgeDocument.external_provider == provider_id,
                KnowledgeDocument.external_resource_id == external_resource_id,
            )
            .first()
        )

    @staticmethod
    def _dispatch_import_task(document: KnowledgeDocument) -> None:
        """Start the background body fetch for a placeholder document."""
        from app.tasks.knowledge_tasks import import_external_document_task

        import_external_document_task.delay(document_id=document.id)


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
    failure: this attempt simply stands down.
    """
    from app.services.knowledge.orchestrator import knowledge_orchestrator

    provider = get_external_document_provider(document.external_provider or "")
    try:
        if provider is None:
            raise ExternalDocumentFetchError(
                f"Unsupported external provider: {document.external_provider}"
            )
        if user is None:
            raise ExternalDocumentFetchError(
                f"Owner user {document.user_id} no longer exists"
            )
        content: ExternalDocumentContent = asyncio.run(
            provider.fetch_content(db, user, document.external_resource_id)
        )
        knowledge_orchestrator.attach_external_document_content(
            db=db,
            document=document,
            user=user,
            content=content,
            generation=generation,
        )
    except ExternalImportLostWriteError:
        logger.info(
            "[External Import] Attempt for document %s lost its write right at "
            "generation %s; standing down without touching the document",
            document.id,
            generation,
        )
    except Exception as exc:
        _mark_external_import_failed(db, document, generation, exc)
        logger.error(
            "[External Import] Failed to import document %s: %s",
            document.id,
            exc,
            exc_info=True,
        )


def _mark_external_import_failed(
    db: Session,
    document: KnowledgeDocument,
    generation: int,
    exc: Exception,
) -> None:
    """Record the fetch failure on the document without deleting it."""
    from app.services.knowledge.index_state_machine import mark_document_index_failed

    mark_document_index_failed(
        db=db,
        document_id=document.id,
        generation=generation,
        error=build_processing_error(
            stage=DocumentProcessingStage.SYSTEM,
            code="external_import_failed",
            message=(
                "The external document could not be imported. Please retry later."
            ),
            retryable=True,
            generation=generation,
            provider=document.external_provider,
        ),
    )


external_document_import_service = ExternalDocumentImportService()
