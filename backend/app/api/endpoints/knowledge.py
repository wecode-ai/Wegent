# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for knowledge base and document management.
"""

import asyncio
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
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
from app.services.knowledge import (
    KnowledgeBaseQAService,
    KnowledgeService,
    knowledge_base_qa_service,
)
from app.services.knowledge.document_indexing import (
    parse_splitter_config,
    schedule_document_indexing,
)

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

        if knowledge_base:
            scheduled = schedule_document_indexing(
                background_tasks=background_tasks,
                knowledge_base=knowledge_base,
                attachment_id=data.attachment_id or 0,
                document_id=document.id,
                current_user_id=current_user.id,
                current_user_name=current_user.user_name,
                source_type=data.source_type,
                splitter_config=data.splitter_config,
            )
            if scheduled:
                logger.info(
                    "Scheduled RAG indexing for document %s in knowledge base %s",
                    document.id,
                    knowledge_base_id,
                )

        return KnowledgeDocumentResponse.model_validate(document)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


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
            scheduled = schedule_document_indexing(
                background_tasks=background_tasks,
                knowledge_base=knowledge_base,
                attachment_id=document.attachment_id,
                document_id=document.id,
                current_user_id=current_user.id,
                current_user_name=current_user.user_name,
                source_type=DocumentSourceType(document.source_type),
                splitter_config=(
                    parse_splitter_config(document.splitter_config)
                    if document.splitter_config
                    else None
                ),
            )
            if scheduled:
                logger.info(
                    "Scheduled RAG re-indexing for document %s after content update",
                    document.id,
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
