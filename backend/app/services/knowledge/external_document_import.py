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

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.schemas.knowledge import DocumentProcessingStage
from app.services.knowledge.external_document_providers import (
    ExternalDocumentAlreadyImportedError,
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    get_external_document_provider,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.processing_errors import build_processing_error

logger = logging.getLogger(__name__)


class ExternalDocumentImportService:
    """Single-document external import orchestration."""

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

        external_meta = provider.resolve_importable(db, user, external_resource_id)

        existing = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
                KnowledgeDocument.external_provider == provider.provider_id,
                KnowledgeDocument.external_resource_id == external_resource_id,
            )
            .first()
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

    @staticmethod
    def _dispatch_import_task(document: KnowledgeDocument) -> None:
        """Start the background body fetch for a placeholder document."""
        from app.tasks.knowledge_tasks import import_external_document_task

        import_external_document_task.delay(document_id=document.id)


def run_external_document_import(
    db: Session,
    document: KnowledgeDocument,
    user: User,
) -> None:
    """Fetch the external body, attach it, and start indexing.

    Runs inside the Celery worker. Any failure marks the document failed with
    a structured processing error; the placeholder itself is kept.
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
        )
    except Exception as exc:
        _mark_external_import_failed(db, document, exc)
        logger.error(
            "[External Import] Failed to import document %s: %s",
            document.id,
            exc,
            exc_info=True,
        )


def _mark_external_import_failed(
    db: Session,
    document: KnowledgeDocument,
    exc: Exception,
) -> None:
    """Record the fetch failure on the document without deleting it."""
    from app.services.knowledge.index_state_machine import mark_document_index_failed

    generation = document.index_generation or 0
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
        ),
    )


external_document_import_service = ExternalDocumentImportService()
