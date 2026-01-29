# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for knowledge base and document management.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.user import User
from app.schemas.knowledge import (
    AccessibleKnowledgeResponse,
    BatchDocumentIds,
    BatchOperationResult,
    DocumentContentUpdate,
    DocumentDetailResponse,
    DocumentSourceType,
    KnowledgeBaseCreate,
    KnowledgeBaseListResponse,
    KnowledgeBaseResponse,
    KnowledgeBaseTypeUpdate,
    KnowledgeBaseUpdate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentListResponse,
    KnowledgeDocumentResponse,
    KnowledgeDocumentUpdate,
    ResourceScope,
)
from app.schemas.knowledge_qa_history import QAHistoryResponse
from app.schemas.rag import (
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SplitterConfig,
)
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.knowledge import (
    KnowledgeBaseQAService,
    KnowledgeService,
    knowledge_base_qa_service,
)
from app.services.rag.document_service import DocumentService
from app.services.rag.storage.factory import create_storage_backend
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

router = APIRouter()


# ============== Knowledge Base Endpoints ==============


@router.get("", response_model=KnowledgeBaseListResponse)
def list_knowledge_bases(
    scope: str = Query(
        default="all",
        description="Resource scope: personal, group, or all",
    ),
    group_name: Optional[str] = Query(
        default=None,
        description="Group name (required when scope is group)",
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List knowledge bases based on scope.

    - **scope=personal**: Only user's own personal knowledge bases
    - **scope=group**: Knowledge bases from a specific group (requires group_name)
    - **scope=all**: All accessible knowledge bases (personal + team)
    """
    try:
        resource_scope = ResourceScope(scope)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid scope: {scope}. Must be one of: personal, group, all",
        )

    if resource_scope == ResourceScope.GROUP and not group_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="group_name is required when scope is group",
        )

    knowledge_bases = KnowledgeService.list_knowledge_bases(
        db=db,
        user_id=current_user.id,
        scope=resource_scope,
        group_name=group_name,
    )
    return KnowledgeBaseListResponse(
        total=len(knowledge_bases),
        items=[
            KnowledgeBaseResponse.from_kind(
                kb, KnowledgeService.get_document_count(db, kb.id)
            )
            for kb in knowledge_bases
        ],
    )


@router.get("/accessible", response_model=AccessibleKnowledgeResponse)
def get_accessible_knowledge(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get all knowledge bases accessible to the current user.

    Returns both personal and team knowledge bases organized by group.
    This endpoint is designed for AI chat integration.
    """
    return KnowledgeService.get_accessible_knowledge(
        db=db,
        user_id=current_user.id,
    )


@router.get("/config")
@trace_sync("get_knowledge_config", "knowledge.api")
def get_knowledge_config():
    """
    Get knowledge base configuration.

    Returns system-level configuration for knowledge base features.
    This is used by frontend to determine which features are enabled.
    """
    return {
        "chunk_storage_enabled": settings.CHUNK_STORAGE_ENABLED,
    }


@router.post(
    "",
    response_model=KnowledgeBaseResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_knowledge_base(
    data: KnowledgeBaseCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new knowledge base.

    - **namespace=default**: Personal knowledge base
    - **namespace=<group_name>**: Team knowledge base (requires Maintainer+ permission)
    """
    try:
        kb_id = KnowledgeService.create_knowledge_base(
            db=db,
            user_id=current_user.id,
            data=data,
        )
        # Commit the transaction to persist the knowledge base
        db.commit()
        # Fetch the created knowledge base
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=kb_id,
            user_id=current_user.id,
        )
        if not knowledge_base:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to retrieve created knowledge base",
            )
        return KnowledgeBaseResponse.from_kind(
            knowledge_base, KnowledgeService.get_document_count(db, knowledge_base.id)
        )
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Knowledge base with name '{data.name}' already exists in this namespace",
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.get("/{knowledge_base_id}", response_model=KnowledgeBaseResponse)
def get_knowledge_base(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get a knowledge base by ID."""
    knowledge_base = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=knowledge_base_id,
        user_id=current_user.id,
    )

    if not knowledge_base:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found or access denied",
        )

    return KnowledgeBaseResponse.from_kind(
        knowledge_base, KnowledgeService.get_document_count(db, knowledge_base.id)
    )


@router.put("/{knowledge_base_id}", response_model=KnowledgeBaseResponse)
def update_knowledge_base(
    knowledge_base_id: int,
    data: KnowledgeBaseUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update a knowledge base."""
    try:
        knowledge_base = KnowledgeService.update_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
            data=data,
        )

        if not knowledge_base:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Knowledge base not found or access denied",
            )

        return KnowledgeBaseResponse.from_kind(
            knowledge_base, KnowledgeService.get_document_count(db, knowledge_base.id)
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.delete("/{knowledge_base_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_knowledge_base(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a knowledge base and all its documents."""
    try:
        deleted = KnowledgeService.delete_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
        )

        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Knowledge base not found or access denied",
            )

        return None
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )


@router.patch("/{knowledge_base_id}/type", response_model=KnowledgeBaseResponse)
def update_knowledge_base_type(
    knowledge_base_id: int,
    data: KnowledgeBaseTypeUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update the knowledge base type (notebook <-> classic conversion).

    - Converting to 'notebook': Requires document count <= 50
    - Converting to 'classic': No restrictions
    """
    try:
        knowledge_base = KnowledgeService.update_knowledge_base_type(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
            new_type=data.kb_type,
        )

        if not knowledge_base:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Knowledge base not found or access denied",
            )

        return KnowledgeBaseResponse.from_kind(
            knowledge_base,
            KnowledgeService.get_document_count(db, knowledge_base.id),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


# ============== Knowledge Document Endpoints ==============


@router.get(
    "/{knowledge_base_id}/documents",
    response_model=KnowledgeDocumentListResponse,
)
def list_documents(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """List documents in a knowledge base."""
    documents = KnowledgeService.list_documents(
        db=db,
        knowledge_base_id=knowledge_base_id,
        user_id=current_user.id,
    )

    return KnowledgeDocumentListResponse(
        total=len(documents),
        items=[KnowledgeDocumentResponse.model_validate(doc) for doc in documents],
    )


@router.post(
    "/{knowledge_base_id}/documents",
    response_model=KnowledgeDocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_document(
    knowledge_base_id: int,
    data: KnowledgeDocumentCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new document in a knowledge base.

    The attachment_id should reference an already uploaded attachment
    via /api/attachments/upload endpoint.

    After creating the document, automatically triggers RAG indexing
    if the knowledge base has retrieval_config configured.
    """
    try:
        # Create document record
        document = KnowledgeService.create_document(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
            data=data,
        )

        # Get knowledge base to check for retrieval_config
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
        )

        # If knowledge base has retrieval_config, trigger RAG indexing
        # Skip RAG indexing for TABLE source type as table data should be queried in real-time
        if knowledge_base and data.source_type != DocumentSourceType.TABLE:
            spec = knowledge_base.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")

            if retrieval_config:
                # Extract configuration using snake_case format
                retriever_name = retrieval_config.get("retriever_name")
                retriever_namespace = retrieval_config.get(
                    "retriever_namespace", "default"
                )
                embedding_config = retrieval_config.get("embedding_config")

                if retriever_name and embedding_config:
                    # Extract embedding model info
                    embedding_model_name = embedding_config.get("model_name")
                    embedding_model_namespace = embedding_config.get(
                        "model_namespace", "default"
                    )

                    # Pre-compute KB index info from already-fetched knowledge_base object
                    # This avoids redundant DB query in the background task
                    summary_enabled = spec.get("summaryEnabled", False)
                    if knowledge_base.namespace == "default":
                        index_owner_user_id = current_user.id
                    else:
                        # Group KB - use creator's user_id for shared index
                        index_owner_user_id = knowledge_base.user_id

                    kb_index_info = KnowledgeBaseIndexInfo(
                        index_owner_user_id=index_owner_user_id,
                        summary_enabled=summary_enabled,
                    )

                    # Schedule RAG indexing in background
                    # Note: We use a synchronous function that creates its own event loop
                    # because BackgroundTasks runs in a thread pool without an event loop.
                    # We also don't pass db session because it will be closed
                    # after the request ends. The background task creates its own session.
                    background_tasks.add_task(
                        _index_document_background,
                        knowledge_base_id=str(knowledge_base_id),
                        attachment_id=data.attachment_id,
                        retriever_name=retriever_name,
                        retriever_namespace=retriever_namespace,
                        embedding_model_name=embedding_model_name,
                        embedding_model_namespace=embedding_model_namespace,
                        user_id=current_user.id,
                        user_name=current_user.user_name,
                        splitter_config=data.splitter_config,
                        document_id=document.id,
                        kb_index_info=kb_index_info,
                    )
                    logger.info(
                        f"Scheduled RAG indexing for document {document.id} in knowledge base {knowledge_base_id}"
                    )
                else:
                    logger.warning(
                        f"Knowledge base {knowledge_base_id} has incomplete retrieval_config, skipping RAG indexing"
                    )

        return KnowledgeDocumentResponse.model_validate(document)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@dataclass
class KnowledgeBaseIndexInfo:
    """Container for knowledge base information needed for background indexing.

    This dataclass holds all KB-related information needed by the background
    indexing task, avoiding redundant database queries in the background task.
    """

    index_owner_user_id: int
    summary_enabled: bool = False


def _get_kb_index_info_sync(
    db: Session, knowledge_base_id: str, current_user_id: int
) -> KnowledgeBaseIndexInfo:
    """
    Get knowledge base information needed for indexing in a single query.
    Synchronous version for use in background tasks.

    Returns index_owner_user_id and summary_enabled setting in one operation
    to avoid redundant database queries.

    For personal knowledge bases (namespace="default"), use the current user's ID.
    For group knowledge bases (namespace!="default"), use the knowledge base creator's ID.

    Args:
        db: Database session
        knowledge_base_id: Knowledge base ID (Kind.id as string)
        current_user_id: Current requesting user's ID

    Returns:
        KnowledgeBaseIndexInfo containing index_owner_user_id and summary_enabled
    """
    from app.models.kind import Kind

    try:
        kb_id = int(knowledge_base_id)
    except ValueError:
        # If knowledge_base_id is not a valid integer, return default info
        return KnowledgeBaseIndexInfo(
            index_owner_user_id=current_user_id,
            summary_enabled=False,
        )

    # Get the knowledge base (single query for all needed info)
    kb = (
        db.query(Kind)
        .filter(
            Kind.id == kb_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active == True,
        )
        .first()
    )

    if not kb:
        # Knowledge base not found, return default info
        return KnowledgeBaseIndexInfo(
            index_owner_user_id=current_user_id,
            summary_enabled=False,
        )

    # Extract summary_enabled from KB spec
    spec = (kb.json or {}).get("spec", {})
    summary_enabled = spec.get("summaryEnabled", False)

    # Determine index_owner_user_id based on namespace
    if kb.namespace == "default":
        # Personal knowledge base - use current user's ID
        index_owner_user_id = current_user_id
    else:
        # Group knowledge base - use KB creator's user_id for index naming
        # This ensures all group members access the same index
        index_owner_user_id = kb.user_id

    return KnowledgeBaseIndexInfo(
        index_owner_user_id=index_owner_user_id,
        summary_enabled=summary_enabled,
    )


def _resolve_kb_index_info(
    db: Session,
    knowledge_base_id: str,
    user_id: int,
    kb_index_info: Optional[KnowledgeBaseIndexInfo] = None,
) -> KnowledgeBaseIndexInfo:
    """
    Resolve knowledge base index information.

    Use pre-computed KB info if provided, otherwise fetch from DB.
    This optimization avoids redundant DB query when called from create_document.

    Args:
        db: Database session
        knowledge_base_id: Knowledge base ID
        user_id: User ID (the user who triggered the indexing)
        kb_index_info: Pre-computed KB info (optional)

    Returns:
        KnowledgeBaseIndexInfo containing index_owner_user_id and summary_enabled
    """
    if kb_index_info:
        logger.info(
            f"Using pre-computed KB info: index_owner_user_id={kb_index_info.index_owner_user_id}, "
            f"summary_enabled={kb_index_info.summary_enabled}"
        )
        return kb_index_info
    else:
        # Fallback: fetch KB info from database (for backward compatibility)
        kb_info = _get_kb_index_info_sync(
            db=db,
            knowledge_base_id=knowledge_base_id,
            current_user_id=user_id,
        )
        logger.info(
            f"Fetched KB info from DB: index_owner_user_id={kb_info.index_owner_user_id}, "
            f"summary_enabled={kb_info.summary_enabled}"
        )
        return kb_info


def _parse_splitter_config(config_dict: dict) -> Optional[SplitterConfig]:
    """
    Parse a dictionary into the appropriate SplitterConfig type.

    Since SplitterConfig is a Union type (Union[SemanticSplitterConfig, SentenceSplitterConfig, SmartSplitterConfig]),
    it cannot be instantiated directly. This function determines the correct type based on
    the 'type' field in the config dictionary.

    Args:
        config_dict: Dictionary containing splitter configuration

    Returns:
        SemanticSplitterConfig, SentenceSplitterConfig, or SmartSplitterConfig instance,
        or None if invalid
    """
    from app.schemas.rag import SmartSplitterConfig

    if not config_dict:
        return None

    splitter_type = config_dict.get("type")
    if splitter_type == "semantic":
        return SemanticSplitterConfig(**config_dict)
    elif splitter_type == "sentence":
        return SentenceSplitterConfig(**config_dict)
    elif splitter_type == "smart":
        return SmartSplitterConfig(**config_dict)
    else:
        # Default to sentence splitter if type is not specified or unknown
        logger.warning(
            f"Unknown splitter type '{splitter_type}', defaulting to sentence splitter"
        )
        return SentenceSplitterConfig(**config_dict)


def _trigger_document_summary_if_enabled(
    db: Session,
    document_id: int,
    user_id: int,
    user_name: str,
    kb_info: KnowledgeBaseIndexInfo,
):
    """
    Trigger document summary generation if enabled.

    Check both global setting and knowledge base setting before triggering.
    Summary generation failure should not affect indexing result.

    Args:
        db: Database session
        document_id: Document ID
        user_id: User ID (the user who triggered the indexing)
        user_name: Username for placeholder resolution
        kb_info: Knowledge base index information
    """
    try:
        global_summary_enabled = getattr(settings, "SUMMARY_ENABLED", False)
        if global_summary_enabled and kb_info.summary_enabled:
            from app.services.knowledge import get_summary_service

            summary_service = get_summary_service(db)
            # Use a dedicated event loop and ensure proper cleanup
            # to avoid "no running event loop" errors during garbage collection
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(
                    summary_service.trigger_document_summary(
                        document_id, user_id, user_name
                    )
                )
            finally:
                # Properly shutdown async generators and close the loop
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.close()
            logger.info(
                f"Triggered document summary generation for document {document_id}"
            )
        else:
            logger.info(
                f"Skipping document summary for {document_id}: summary not enabled "
                f"(global={global_summary_enabled}, kb={kb_info.summary_enabled})"
            )
    except Exception as summary_error:
        # Summary generation failure should not affect indexing result
        logger.warning(
            f"Failed to trigger document summary for {document_id}: {summary_error}"
        )


def _index_document_background(
    knowledge_base_id: str,
    attachment_id: int,
    retriever_name: str,
    retriever_namespace: str,
    embedding_model_name: str,
    embedding_model_namespace: str,
    user_id: int,
    user_name: str,
    splitter_config: Optional[SplitterConfig] = None,
    document_id: Optional[int] = None,
    kb_index_info: Optional[KnowledgeBaseIndexInfo] = None,
):
    """
    Background task for RAG document indexing.

    This is a synchronous function that creates its own event loop to run
    the async indexing code. This is necessary because FastAPI's BackgroundTasks
    runs tasks in a thread pool, which doesn't have an event loop.

    This function also creates its own database session because the request-scoped
    session will be closed after the HTTP response is sent.

    Args:
        knowledge_base_id: Knowledge base ID
        attachment_id: Attachment ID
        retriever_name: Retriever name
        retriever_namespace: Retriever namespace
        embedding_model_name: Embedding model name
        embedding_model_namespace: Embedding model namespace
        user_id: User ID (the user who triggered the indexing)
        user_name: Username for placeholder resolution
        splitter_config: Optional splitter configuration
        document_id: Optional document ID to use as doc_ref
        kb_index_info: Pre-computed KB info (avoids redundant DB query if provided)
    """
    logger.info(
        f"Background task started: indexing document for knowledge base {knowledge_base_id}, "
        f"attachment {attachment_id}"
    )

    # Create a new database session for the background task
    db = SessionLocal()
    try:
        # Resolve KB index info (use pre-computed or fetch from DB)
        kb_info = _resolve_kb_index_info(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
            kb_index_info=kb_index_info,
        )

        # Get retriever from database
        retriever_crd = retriever_kinds_service.get_retriever(
            db=db,
            user_id=user_id,
            name=retriever_name,
            namespace=retriever_namespace,
        )

        if not retriever_crd:
            raise ValueError(
                f"Retriever {retriever_name} (namespace: {retriever_namespace}) not found"
            )

        logger.info(f"Found retriever: {retriever_name}")

        # Create storage backend from retriever
        storage_backend = create_storage_backend(retriever_crd)
        logger.info(f"Created storage backend: {type(storage_backend).__name__}")

        # Create document service
        doc_service = DocumentService(storage_backend=storage_backend)

        # Use index_owner_user_id for per_user index strategy to ensure
        # all group members access the same index created by the KB owner
        # Use a dedicated event loop and ensure proper cleanup
        # to avoid "no running event loop" errors during garbage collection
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(
                doc_service.index_document(
                    knowledge_id=knowledge_base_id,
                    embedding_model_name=embedding_model_name,
                    embedding_model_namespace=embedding_model_namespace,
                    user_id=kb_info.index_owner_user_id,
                    db=db,
                    attachment_id=attachment_id,
                    splitter_config=splitter_config,
                    document_id=document_id,
                )
            )
        finally:
            # Properly shutdown async generators and close the loop
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()
        logger.info(
            f"Successfully indexed document for knowledge base {knowledge_base_id}: {result}"
        )

        # Update document is_active to True and status to enabled after successful indexing
        # Also save chunk metadata to document if CHUNK_STORAGE_ENABLED is True
        if document_id:
            from app.models.knowledge import DocumentStatus, KnowledgeDocument

            doc = (
                db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == document_id)
                .first()
            )
            if doc:
                doc.is_active = True
                doc.status = DocumentStatus.ENABLED
                # Save chunk metadata from indexing result only if CHUNK_STORAGE_ENABLED is True
                # When disabled (default), chunks are only stored in vector database for retrieval
                if settings.CHUNK_STORAGE_ENABLED:
                    chunks_data = result.get("chunks_data")
                    if chunks_data:
                        doc.chunks = chunks_data
                        logger.info(
                            f"Saved {chunks_data.get('total_count', 0)} chunks metadata "
                            f"for document {document_id}"
                        )
                else:
                    logger.info(
                        f"Skipping chunk storage for document {document_id} "
                        "(CHUNK_STORAGE_ENABLED=False)"
                    )
                db.commit()
                logger.info(
                    f"Updated document {document_id} is_active to True and status to enabled after successful indexing"
                )

                # Trigger document summary generation if enabled
                _trigger_document_summary_if_enabled(
                    db=db,
                    document_id=document_id,
                    user_id=user_id,
                    user_name=user_name,
                    kb_info=kb_info,
                )
    except Exception as e:
        logger.error(
            f"Failed to index document for knowledge base {knowledge_base_id}: {str(e)}",
            exc_info=True,
        )
        # Don't raise exception to avoid blocking document creation
    finally:
        # Always close the database session
        db.close()
        logger.info(f"Background task completed for knowledge base {knowledge_base_id}")


# Document-specific endpoints (without knowledge_base_id in path)
document_router = APIRouter()


@document_router.put("/{document_id}", response_model=KnowledgeDocumentResponse)
def update_document(
    document_id: int,
    data: KnowledgeDocumentUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update a document (enable/disable status)."""
    try:
        document = KnowledgeService.update_document(
            db=db,
            document_id=document_id,
            user_id=current_user.id,
            data=data,
        )

        if not document:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found or access denied",
            )

        return KnowledgeDocumentResponse.model_validate(document)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )


@document_router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(
    document_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a document from the knowledge base."""
    try:
        result = KnowledgeService.delete_document(
            db=db,
            document_id=document_id,
            user_id=current_user.id,
        )

        if not result.success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found or access denied",
            )

        # Trigger KB summary update in background after successful deletion
        if result.kb_id is not None:
            logger.info(
                f"[KnowledgeAPI] Scheduling KB summary update after deletion: "
                f"kb_id={result.kb_id}, document_id={document_id}"
            )
            background_tasks.add_task(
                _update_kb_summary_after_deletion,
                kb_id=result.kb_id,
                user_id=current_user.id,
                user_name=current_user.user_name,
            )

        return None
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )


@document_router.put("/{document_id}/content")
async def update_document_content(
    document_id: int,
    data: DocumentContentUpdate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """
    Update document content (TEXT type only).

    Updates the extracted_text field and triggers RAG re-indexing.
    Only Owner or Maintainer of the knowledge base can update documents.

    Returns:
        Success message with document_id
    """
    from app.models.knowledge import KnowledgeDocument

    try:
        # Update document content via service
        document = KnowledgeService.update_document_content(
            db=db,
            document_id=document_id,
            content=data.content,
            user_id=current_user.id,
        )

        if not document:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found or access denied",
            )

        # Get knowledge base to check for retrieval_config and trigger RAG re-indexing
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=document.kind_id,
            user_id=current_user.id,
        )

        if knowledge_base:
            spec = knowledge_base.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")

            if retrieval_config:
                # Extract configuration using snake_case format
                retriever_name = retrieval_config.get("retriever_name")
                retriever_namespace = retrieval_config.get(
                    "retriever_namespace", "default"
                )
                embedding_config = retrieval_config.get("embedding_config")

                if retriever_name and embedding_config:
                    # Extract embedding model info
                    embedding_model_name = embedding_config.get("model_name")
                    embedding_model_namespace = embedding_config.get(
                        "model_namespace", "default"
                    )

                    # Pre-compute KB index info
                    summary_enabled = spec.get("summaryEnabled", False)
                    if knowledge_base.namespace == "default":
                        index_owner_user_id = current_user.id
                    else:
                        index_owner_user_id = knowledge_base.user_id

                    kb_index_info = KnowledgeBaseIndexInfo(
                        index_owner_user_id=index_owner_user_id,
                        summary_enabled=summary_enabled,
                    )

                    # Schedule RAG re-indexing in background
                    background_tasks.add_task(
                        _index_document_background,
                        knowledge_base_id=str(document.kind_id),
                        attachment_id=document.attachment_id,
                        retriever_name=retriever_name,
                        retriever_namespace=retriever_namespace,
                        embedding_model_name=embedding_model_name,
                        embedding_model_namespace=embedding_model_namespace,
                        user_id=current_user.id,
                        user_name=current_user.user_name,
                        splitter_config=(
                            _parse_splitter_config(document.splitter_config)
                            if document.splitter_config
                            else None
                        ),
                        document_id=document.id,
                        kb_index_info=kb_index_info,
                    )
                    logger.info(
                        f"Scheduled RAG re-indexing for document {document.id} after content update"
                    )

        return {
            "success": True,
            "document_id": document.id,
            "message": "Document content updated successfully",
        }

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


# ============== Batch Document Operations ==============


@document_router.get("/{document_id}/detail")
@trace_sync("get_document_detail_standalone", "knowledge.api")
def get_document_detail_standalone(
    document_id: int,
    include_content: bool = Query(True, description="Include document content"),
    include_summary: bool = Query(True, description="Include document summary"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get document detail (content and/or summary) without requiring knowledge base ID.

    This is a convenience endpoint for getting document content when the kb_id
    is not readily available (e.g., in citation tooltips).
    """
    from app.models.knowledge import KnowledgeDocument

    # Get document
    document = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document_id).first()
    )

    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    # Check access permission via knowledge base
    kb = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=document.kind_id,
        user_id=current_user.id,
    )
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this document",
        )

    # Get content if requested
    content = None
    content_length = None
    truncated = False

    if include_content and document.attachment_id:
        try:
            from app.services.context import context_service

            attachment = context_service.get_context_by_id(
                db=db,
                context_id=document.attachment_id,
            )
            if attachment and attachment.extracted_text:
                full_content = attachment.extracted_text
                content_length = len(full_content)
                # Truncate if too large
                max_length = 100000
                if content_length > max_length:
                    content = full_content[:max_length]
                    truncated = True
                else:
                    content = full_content
        except Exception as e:
            logger.warning(f"Failed to get document content: {e}")

    # Build response
    response = {
        "document_id": document_id,
    }

    if include_content:
        response["content"] = content
        response["content_length"] = content_length
        response["truncated"] = truncated

    if include_summary:
        response["summary"] = document.summary

    return response


@document_router.post("/batch/delete", response_model=BatchOperationResult)
def batch_delete_documents(
    data: BatchDocumentIds,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch delete multiple documents.

    Deletes all specified documents that the user has permission to delete.
    Returns a summary of successful and failed operations.
    Raises 403 if all operations fail due to permission issues.
    """
    batch_result = KnowledgeService.batch_delete_documents(
        db=db,
        document_ids=data.document_ids,
        user_id=current_user.id,
    )

    result = batch_result.result
    kb_ids = batch_result.kb_ids

    # If all operations failed, raise an error
    if result.success_count == 0 and result.failed_count > 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Maintainer can delete documents from this knowledge base",
        )

    # Trigger KB summary update ONCE for each affected KB after all deletions complete
    if kb_ids:
        logger.info(
            f"[KnowledgeAPI] Scheduling KB summary updates after batch deletion: "
            f"kb_ids={kb_ids}, deleted_count={result.success_count}"
        )
        for kb_id in kb_ids:
            background_tasks.add_task(
                _update_kb_summary_after_deletion,
                kb_id=kb_id,
                user_id=current_user.id,
                user_name=current_user.user_name,
            )

    return result


@document_router.post("/batch/enable", response_model=BatchOperationResult)
def batch_enable_documents(
    data: BatchDocumentIds,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch enable multiple documents.

    Enables all specified documents that the user has permission to update.
    Returns a summary of successful and failed operations.
    Raises 403 if all operations fail due to permission issues.
    """
    result = KnowledgeService.batch_enable_documents(
        db=db,
        document_ids=data.document_ids,
        user_id=current_user.id,
    )
    # If all operations failed, raise an error
    if result.success_count == 0 and result.failed_count > 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Maintainer can update documents in this knowledge base",
        )
    return result


@document_router.post("/batch/disable", response_model=BatchOperationResult)
def batch_disable_documents(
    data: BatchDocumentIds,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch disable multiple documents.

    Disables all specified documents that the user has permission to update.
    Returns a summary of successful and failed operations.
    Raises 403 if all operations fail due to permission issues.
    """
    result = KnowledgeService.batch_disable_documents(
        db=db,
        document_ids=data.document_ids,
        user_id=current_user.id,
    )
    # If all operations failed, raise an error
    if result.success_count == 0 and result.failed_count > 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Maintainer can update documents in this knowledge base",
        )
    return result


# ============== QA History Endpoints ==============


qa_history_router = APIRouter()


@qa_history_router.get("", response_model=QAHistoryResponse)
def get_qa_history(
    start_time: datetime = Query(
        ...,
        description="Query start time (ISO 8601 format)",
    ),
    end_time: datetime = Query(
        ...,
        description="Query end time (ISO 8601 format)",
    ),
    user_id: Optional[int] = Query(
        default=None,
        description="Filter by user ID (admin only, ignored for non-admin users)",
    ),
    page: int = Query(
        default=1,
        ge=1,
        description="Page number (default: 1)",
    ),
    page_size: int = Query(
        default=20,
        ge=1,
        le=100,
        description="Number of items per page (default: 20, max: 100)",
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Query knowledge base QA history based on time range.

    Returns user questions, assistant answers, vector search results,
    and knowledge base configuration information.

    - **start_time**: Query start time (ISO 8601 format, required)
    - **end_time**: Query end time (ISO 8601 format, required)
    - **user_id**: Filter by user ID (admin only; non-admin users can only query their own history)
    - **page**: Page number (default: 1)
    - **page_size**: Items per page (default: 20, max: 100)

    Note: Maximum query time range is 30 days.

    Authorization:
    - Admin users can query any user's history by specifying user_id,
      or query all users' history when user_id is None.
    - Non-admin users can only query their own history (user_id parameter is ignored).
    """
    # Enforce authorization: non-admin users can only query their own history
    if current_user.role != "admin":
        effective_user_id = current_user.id
    else:
        # Admin can query specific user or all users (when user_id is None)
        effective_user_id = user_id

    try:
        return knowledge_base_qa_service.get_qa_history(
            db=db,
            start_time=start_time,
            end_time=end_time,
            user_id=effective_user_id,
            page=page,
            page_size=page_size,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


# ============== Summary Endpoints ==============

summary_router = APIRouter()


@summary_router.get("/{kb_id}/summary")
async def get_kb_summary(
    kb_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get knowledge base summary.

    Returns the summary information for a knowledge base including:
    - short_summary: Brief overview (50-100 characters)
    - long_summary: Detailed description (up to 500 characters)
    - topics: List of core topic tags
    - status: Summary generation status
    """
    from app.schemas.summary import KnowledgeBaseSummaryResponse
    from app.services.knowledge import get_summary_service

    # Validate KB access permission
    kb = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found or access denied",
        )

    summary_service = get_summary_service(db)
    summary = await summary_service.get_kb_summary(kb_id)
    return KnowledgeBaseSummaryResponse(kb_id=kb_id, summary=summary)


@summary_router.post("/{kb_id}/summary/refresh")
async def refresh_kb_summary(
    kb_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Manually refresh knowledge base summary.

    Triggers regeneration of the knowledge base summary based on
    aggregated document summaries. Runs in background.
    """
    from app.schemas.summary import SummaryRefreshResponse

    # Validate KB access permission
    kb = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found or access denied",
        )

    # Run in background, return immediately
    background_tasks.add_task(
        _run_kb_summary_refresh, kb_id, current_user.id, current_user.user_name
    )

    return SummaryRefreshResponse(
        message="Summary refresh started",
        status="generating",
    )


@summary_router.get(
    "/{kb_id}/documents/{doc_id}/detail", response_model=DocumentDetailResponse
)
async def get_document_detail(
    kb_id: int,
    doc_id: int,
    include_content: bool = Query(
        default=True, description="Include document content in response"
    ),
    include_summary: bool = Query(
        default=True, description="Include document summary in response"
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get document detail including content and summary.

    Query parameters:
    - include_content: Whether to include extracted text content (default: true)
    - include_summary: Whether to include AI-generated summary (default: true)

    Returns:
    - document_id: Document ID
    - content: Extracted text content (if include_content=true)
    - content_length: Length of content in characters (if include_content=true)
    - truncated: Whether content was truncated (if include_content=true)
    - summary: Document summary object (if include_summary=true)
    """
    from app.models.knowledge import KnowledgeDocument
    from app.models.subtask_context import SubtaskContext
    from app.services.knowledge import get_summary_service

    # Validate KB access permission first
    kb = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found or access denied",
        )

    # Validate document belongs to the specified knowledge base
    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == doc_id,
            KnowledgeDocument.kind_id == kb_id,
        )
        .first()
    )
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found in the specified knowledge base",
        )

    # Initialize response data
    content = None
    content_length = None
    truncated = None
    summary = None

    # Get document content if requested
    if include_content:
        content = ""
        truncated = False
        max_length = 100000  # 100k characters limit for frontend display

        if document.attachment_id:
            context = (
                db.query(SubtaskContext)
                .filter(SubtaskContext.id == document.attachment_id)
                .first()
            )

            if context and context.extracted_text:
                content = context.extracted_text
                # Truncate if too long
                if len(content) > max_length:
                    content = content[:max_length]
                    truncated = True

        content_length = len(content)

    # Get document summary if requested
    if include_summary:
        summary_service = get_summary_service(db)
        summary_obj = await summary_service.get_document_summary(doc_id)
        # Convert DocumentSummary object to dict for response
        if summary_obj:
            summary = (
                summary_obj.model_dump()
                if hasattr(summary_obj, "model_dump")
                else summary_obj
            )

    return DocumentDetailResponse(
        document_id=doc_id,
        content=content,
        content_length=content_length,
        truncated=truncated,
        summary=summary,
    )


@summary_router.get("/{kb_id}/documents/{doc_id}/summary")
async def get_document_summary(
    kb_id: int,
    doc_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get document summary.

    Returns the summary information for a document including:
    - short_summary: Brief overview (50-100 characters)
    - long_summary: Detailed description (up to 500 characters)
    - topics: List of topic tags
    - meta_info: Extracted metadata
    - status: Summary generation status
    """
    from app.models.knowledge import KnowledgeDocument
    from app.schemas.summary import DocumentSummaryResponse
    from app.services.knowledge import get_summary_service

    # Validate KB access permission first
    kb = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found or access denied",
        )

    # Validate document belongs to the specified knowledge base
    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == doc_id,
            KnowledgeDocument.kind_id == kb_id,
        )
        .first()
    )
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found in the specified knowledge base",
        )

    summary_service = get_summary_service(db)
    summary = await summary_service.get_document_summary(doc_id)
    return DocumentSummaryResponse(document_id=doc_id, summary=summary)


@summary_router.post("/{kb_id}/documents/{doc_id}/summary/refresh")
async def refresh_document_summary(
    kb_id: int,
    doc_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Manually refresh document summary.

    Triggers regeneration of the document summary. Runs in background.
    """
    from app.models.knowledge import KnowledgeDocument
    from app.schemas.summary import SummaryRefreshResponse

    # Validate KB access permission first
    kb = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found or access denied",
        )

    # Validate document belongs to the specified knowledge base
    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == doc_id,
            KnowledgeDocument.kind_id == kb_id,
        )
        .first()
    )
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found in the specified knowledge base",
        )

    # Run in background, return immediately
    background_tasks.add_task(
        _run_document_summary_refresh, doc_id, current_user.id, current_user.user_name
    )

    return SummaryRefreshResponse(
        message="Summary refresh started",
        status="generating",
    )


async def _run_kb_summary_refresh(kb_id: int, user_id: int, user_name: str):
    """Background task wrapper for KB summary refresh."""
    from app.db.session import SessionLocal
    from app.services.knowledge import get_summary_service

    # Create new session for background task
    new_db = SessionLocal()
    try:
        summary_service = get_summary_service(new_db)
        await summary_service.refresh_kb_summary(kb_id, user_id, user_name)
    except Exception:
        logger.exception(f"Failed to refresh KB summary for kb_id={kb_id}")
    finally:
        new_db.close()


async def _run_document_summary_refresh(doc_id: int, user_id: int, user_name: str):
    """Background task wrapper for document summary refresh."""
    from app.db.session import SessionLocal
    from app.services.knowledge import get_summary_service

    # Create new session for background task
    new_db = SessionLocal()
    try:
        summary_service = get_summary_service(new_db)
        await summary_service.refresh_document_summary(doc_id, user_id, user_name)
    except Exception:
        logger.exception(f"Failed to refresh document summary for doc_id={doc_id}")
    finally:
        new_db.close()


def _update_kb_summary_after_deletion(kb_id: int, user_id: int, user_name: str):
    """
    Background task to update KB summary after document deletion.

    - If no active documents remain, clear the summary
    - If active documents remain, regenerate the summary
    - Errors are logged but don't affect the deletion operation
    - Respects debounce pattern (skip if summary is currently generating)

    This is a synchronous function that creates its own event loop to run
    the async summary service methods. This is necessary because FastAPI's
    BackgroundTasks runs tasks in a thread pool without an event loop.

    Args:
        kb_id: Knowledge base ID
        user_id: User who triggered the deletion
        user_name: Username for placeholder resolution
    """
    from app.services.knowledge import get_summary_service

    logger.info(
        f"[KnowledgeAPI] Starting KB summary update after deletion: kb_id={kb_id}"
    )

    # Create a new database session for the background task
    db = SessionLocal()
    try:
        summary_service = get_summary_service(db)

        # Trigger KB summary with clear_if_empty=True
        # This will:
        # - Clear summary if no active documents remain
        # - Regenerate summary if active documents exist with completed summaries
        # - Skip if currently generating (debounce)
        # Use a dedicated event loop and ensure proper cleanup
        # to avoid "no running event loop" errors during garbage collection
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(
                summary_service.trigger_kb_summary(
                    kb_id, user_id, user_name, force=False, clear_if_empty=True
                )
            )
        finally:
            # Properly shutdown async generators and close the loop
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

    except Exception as e:
        # Log error but don't re-raise - deletion should succeed regardless
        logger.error(
            f"[KnowledgeAPI] Failed to update KB summary after deletion: "
            f"kb_id={kb_id}, error={str(e)}",
            exc_info=True,
        )
    finally:
        db.close()
        logger.info(f"[KnowledgeAPI] KB summary update task completed: kb_id={kb_id}")


# ============== Chunk Management Endpoints ==============


@document_router.get("/{document_id}/chunks")
@trace_sync("list_document_chunks", "knowledge.api")
def list_document_chunks(
    document_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Page size"),
    search: Optional[str] = Query(None, description="Search keyword"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List chunks for a document with pagination and optional search.

    Returns paginated chunk list with content and metadata.
    """
    from app.models.knowledge import KnowledgeDocument
    from app.schemas.knowledge import ChunkItem, ChunkListResponse

    # Get document with access check
    document = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document_id).first()
    )

    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    # Check access permission via knowledge base
    kb = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=document.kind_id,
        user_id=current_user.id,
    )
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this document",
        )

    # Get chunks from document
    chunks_data = document.chunks or {}
    all_items = chunks_data.get("items", [])

    # Apply search filter if provided
    if search:
        search_lower = search.lower()
        all_items = [
            item
            for item in all_items
            if search_lower in item.get("content", "").lower()
        ]

    # Pagination
    total = len(all_items)
    start = (page - 1) * page_size
    end = start + page_size
    paginated_items = all_items[start:end]

    return ChunkListResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[ChunkItem(**item) for item in paginated_items],
        splitter_type=chunks_data.get("splitter_type"),
        splitter_subtype=chunks_data.get("splitter_subtype"),
    )


@document_router.get("/{document_id}/chunks/{chunk_index}")
@trace_sync("get_document_chunk", "knowledge.api")
def get_document_chunk(
    document_id: int,
    chunk_index: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get a single chunk by index.

    Returns full chunk content for citation hover display.
    """
    from app.models.knowledge import KnowledgeDocument
    from app.schemas.knowledge import ChunkResponse

    # Get document
    document = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document_id).first()
    )

    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    # Check access permission via knowledge base
    kb = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=document.kind_id,
        user_id=current_user.id,
    )
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this document",
        )

    # Get chunk by index
    chunks_data = document.chunks or {}
    items = chunks_data.get("items", [])

    # Find chunk by index
    chunk = None
    for item in items:
        if item.get("index") == chunk_index:
            chunk = item
            break

    if not chunk:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chunk with index {chunk_index} not found",
        )

    return ChunkResponse(
        index=chunk.get("index", chunk_index),
        content=chunk.get("content", ""),
        token_count=chunk.get("token_count", 0),
        document_name=document.name,
        document_id=document.id,
        kb_id=document.kind_id,
    )
