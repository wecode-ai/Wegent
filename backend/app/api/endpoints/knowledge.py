# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for knowledge base and document management.
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.db.session import SessionLocal
from app.core import security
from app.models.user import User
from app.schemas.knowledge import (
    AccessibleKnowledgeResponse,
    BatchDocumentIds,
    BatchOperationResult,
    KnowledgeBaseCreate,
    KnowledgeBaseListResponse,
    KnowledgeBaseResponse,
    KnowledgeBaseUpdate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentListResponse,
    KnowledgeDocumentResponse,
    KnowledgeDocumentUpdate,
    ResourceScope,
)
from app.schemas.rag import SplitterConfig
from app.services.knowledge_service import KnowledgeService
from app.services.rag.document_service import DocumentService
from app.services.rag.storage.factory import create_storage_backend
from app.services.adapters.retriever_kinds import retriever_kinds_service

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
        if knowledge_base:
            spec = knowledge_base.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")

            if retrieval_config:
                # Extract configuration using snake_case format
                retriever_name = retrieval_config.get("retriever_name")
                retriever_namespace = retrieval_config.get("retriever_namespace", "default")
                embedding_config = retrieval_config.get("embedding_config")

                if retriever_name and embedding_config:
                    # Extract embedding model info
                    embedding_model_name = embedding_config.get("model_name")
                    embedding_model_namespace = embedding_config.get("model_namespace", "default")

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
                        splitter_config=data.splitter_config,
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


def _index_document_background(
    knowledge_base_id: str,
    attachment_id: int,
    retriever_name: str,
    retriever_namespace: str,
    embedding_model_name: str,
    embedding_model_namespace: str,
    user_id: int,
    splitter_config: Optional[SplitterConfig] = None,
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
        user_id: User ID
        splitter_config: Optional splitter configuration
    """
    logger.info(
        f"Background task started: indexing document for knowledge base {knowledge_base_id}, "
        f"attachment {attachment_id}"
    )

    # Create a new database session for the background task
    db = SessionLocal()
    try:
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

        # Run the async index_document in a new event loop
        # This is necessary because BackgroundTasks runs in a thread without an event loop
        result = asyncio.run(
            doc_service.index_document(
                knowledge_id=knowledge_base_id,
                embedding_model_name=embedding_model_name,
                embedding_model_namespace=embedding_model_namespace,
                user_id=user_id,
                db=db,
                attachment_id=attachment_id,
                splitter_config=splitter_config,
            )
        )

        logger.info(
            f"Successfully indexed document for knowledge base {knowledge_base_id}: {result}"
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
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a document from the knowledge base."""
    try:
        deleted = KnowledgeService.delete_document(
            db=db,
            document_id=document_id,
            user_id=current_user.id,
        )

        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found or access denied",
            )

        return None
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )


# ============== Batch Document Operations ==============


@document_router.post("/batch/delete", response_model=BatchOperationResult)
def batch_delete_documents(
    data: BatchDocumentIds,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch delete multiple documents.

    Deletes all specified documents that the user has permission to delete.
    Returns a summary of successful and failed operations.
    Raises 403 if all operations fail due to permission issues.
    """
    result = KnowledgeService.batch_delete_documents(
        db=db,
        document_ids=data.document_ids,
        user_id=current_user.id,
    )
    # If all operations failed, raise an error
    if result.success_count == 0 and result.failed_count > 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Maintainer can delete documents from this knowledge base",
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
