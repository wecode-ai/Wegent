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
from app.core import security
from app.db.session import SessionLocal
from app.models.user import User
from app.schemas.knowledge import (
    AccessibleKnowledgeResponse,
    BatchDocumentIds,
    BatchOperationResult,
    DocumentContentResponse,
    DocumentContentUpdate,
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
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.knowledge_service import KnowledgeService
from app.services.rag.document_service import DocumentService
from app.services.rag.storage.factory import create_storage_backend

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
                        document_id=document.id,
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


def _get_index_owner_user_id_sync(
    db: Session, knowledge_base_id: str, current_user_id: int
) -> int:
    """
    Get the user_id that should be used for index naming in per_user strategy.
    Synchronous version for use in background tasks.

    For personal knowledge bases (namespace="default"), use the current user's ID.
    For group knowledge bases (namespace!="default"), use the knowledge base creator's ID.

    This ensures that all group members access the same index created by the KB owner.

    Args:
        db: Database session
        knowledge_base_id: Knowledge base ID (Kind.id as string)
        current_user_id: Current requesting user's ID

    Returns:
        User ID to use for index naming
    """
    from app.models.kind import Kind
    from app.services.group_permission import get_effective_role_in_group

    try:
        kb_id = int(knowledge_base_id)
    except ValueError:
        # If knowledge_base_id is not a valid integer, return current user's ID
        return current_user_id

    # Get the knowledge base
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
        # Knowledge base not found, return current user's ID
        return current_user_id

    # Check access permission
    if kb.namespace == "default":
        # Personal knowledge base - use current user's ID
        return current_user_id
    else:
        # Group knowledge base - return the KB creator's user_id for index naming
        # This ensures all group members access the same index
        return kb.user_id


def _index_document_background(
    knowledge_base_id: str,
    attachment_id: int,
    retriever_name: str,
    retriever_namespace: str,
    embedding_model_name: str,
    embedding_model_namespace: str,
    user_id: int,
    splitter_config: Optional[SplitterConfig] = None,
    document_id: Optional[int] = None,
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
        splitter_config: Optional splitter configuration
        document_id: Optional document ID to use as doc_ref
    """
    logger.info(
        f"Background task started: indexing document for knowledge base {knowledge_base_id}, "
        f"attachment {attachment_id}"
    )

    # Create a new database session for the background task
    db = SessionLocal()
    try:
        # Get the correct user_id for index naming
        # For group knowledge bases, use the KB creator's user_id
        # This ensures all group members access the same index
        index_owner_user_id = _get_index_owner_user_id_sync(
            db=db,
            knowledge_base_id=knowledge_base_id,
            current_user_id=user_id,
        )
        logger.info(
            f"Using index_owner_user_id={index_owner_user_id} for indexing "
            f"(original user_id={user_id})"
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

        # Run the async index_document in a new event loop
        # This is necessary because BackgroundTasks runs in a thread without an event loop
        # Use index_owner_user_id for per_user index strategy to ensure
        # all group members access the same index created by the KB owner
        result = asyncio.run(
            doc_service.index_document(
                knowledge_id=knowledge_base_id,
                embedding_model_name=embedding_model_name,
                embedding_model_namespace=embedding_model_namespace,
                user_id=index_owner_user_id,
                db=db,
                attachment_id=attachment_id,
                splitter_config=splitter_config,
                document_id=document_id,
            )
        )

        logger.info(
            f"Successfully indexed document for knowledge base {knowledge_base_id}: {result}"
        )

        # Update document is_active to True after successful indexing
        if document_id:
            from app.models.knowledge import KnowledgeDocument

            doc = (
                db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == document_id)
                .first()
            )
            if doc:
                doc.is_active = True
                db.commit()
                logger.info(
                    f"Updated document {document_id} is_active to True after successful indexing"
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


# ============== Document Content Endpoints ==============


# Editable file extensions (text-based files)
EDITABLE_EXTENSIONS = frozenset([".md", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv"])

# MIME type mapping for document content
EXTENSION_TO_MIME_TYPE = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".xml": "application/xml",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
}


@document_router.get("/{document_id}/content", response_model=DocumentContentResponse)
def get_document_content(
    document_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get the original content of a document.

    For text-based files (md, txt, json, yaml, etc.), returns the text content.
    For PDF files, returns base64-encoded binary data.
    """
    from base64 import b64encode

    from app.models.subtask_attachment import SubtaskAttachment
    from app.services.attachment import attachment_service

    # Get document with permission check
    doc = KnowledgeService.get_document(db, document_id, current_user.id)
    if not doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found or access denied",
        )

    # Get attachment
    if not doc.attachment_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document has no associated attachment",
        )

    attachment = (
        db.query(SubtaskAttachment)
        .filter(SubtaskAttachment.id == doc.attachment_id)
        .first()
    )

    if not attachment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Attachment not found",
        )

    # Determine if file is editable
    file_extension = doc.file_extension.lower()
    if not file_extension.startswith("."):
        file_extension = f".{file_extension}"

    is_editable = file_extension in EDITABLE_EXTENSIONS
    mime_type = EXTENSION_TO_MIME_TYPE.get(file_extension, "application/octet-stream")

    # Get content based on file type
    if is_editable:
        # For text files, return extracted_text or decode binary_data
        if attachment.extracted_text:
            content = attachment.extracted_text
        else:
            # Try to decode binary data as UTF-8
            binary_data = attachment_service.get_attachment_binary_data(db, attachment)
            if binary_data:
                try:
                    content = binary_data.decode("utf-8")
                except UnicodeDecodeError:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="Cannot decode file content as UTF-8",
                    )
            else:
                content = ""
    else:
        # For non-editable files (like PDF), return base64-encoded binary
        binary_data = attachment_service.get_attachment_binary_data(db, attachment)
        if binary_data:
            content = b64encode(binary_data).decode("ascii")
        else:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Binary data not available",
            )

    return DocumentContentResponse(
        id=doc.id,
        name=doc.name,
        file_extension=doc.file_extension,
        mime_type=mime_type,
        content=content,
        is_editable=is_editable,
        updated_at=doc.updated_at,
    )


@document_router.put("/{document_id}/content", response_model=DocumentContentResponse)
async def update_document_content(
    document_id: int,
    data: DocumentContentUpdate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update the content of a document.

    Only text-based files (md, txt, json, yaml, etc.) can be updated.
    After updating, automatically re-indexes the document if the knowledge base
    has retrieval_config configured.
    """
    from app.models.kind import Kind
    from app.models.subtask_attachment import SubtaskAttachment
    from app.services.attachment.storage_factory import get_storage_backend

    # Get document with permission check
    doc = KnowledgeService.get_document(db, document_id, current_user.id)
    if not doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found or access denied",
        )

    # Check permission for team knowledge base
    kb = (
        db.query(Kind)
        .filter(Kind.id == doc.kind_id, Kind.kind == "KnowledgeBase")
        .first()
    )
    if kb and kb.namespace != "default":
        from app.schemas.namespace import GroupRole
        from app.services.group_permission import check_group_permission

        if not check_group_permission(
            db, current_user.id, kb.namespace, GroupRole.Maintainer
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only Owner or Maintainer can update documents in this knowledge base",
            )

    # Get attachment
    if not doc.attachment_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document has no associated attachment",
        )

    attachment = (
        db.query(SubtaskAttachment)
        .filter(SubtaskAttachment.id == doc.attachment_id)
        .first()
    )

    if not attachment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Attachment not found",
        )

    # Check if file is editable
    file_extension = doc.file_extension.lower()
    if not file_extension.startswith("."):
        file_extension = f".{file_extension}"

    if file_extension not in EDITABLE_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File type {file_extension} is not editable",
        )

    # Encode content to bytes
    try:
        new_binary_data = data.content.encode("utf-8")
    except UnicodeEncodeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Content encoding error: {str(e)}",
        )

    # Update binary data in storage backend
    storage_backend = get_storage_backend(db)

    if attachment.storage_key:
        try:
            metadata = {
                "filename": attachment.original_filename,
                "mime_type": attachment.mime_type,
                "file_size": len(new_binary_data),
                "user_id": current_user.id,
            }
            storage_backend.save(attachment.storage_key, new_binary_data, metadata)
        except Exception as e:
            logger.error(f"Failed to update attachment storage: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save document content",
            )

    # Update attachment record
    attachment.extracted_text = data.content
    attachment.text_length = len(data.content)
    attachment.file_size = len(new_binary_data)

    # Update document file_size
    doc.file_size = len(new_binary_data)

    # Commit changes
    db.commit()
    db.refresh(doc)
    db.refresh(attachment)

    # Re-index document if knowledge base has retrieval_config
    if kb:
        spec = kb.json.get("spec", {})
        retrieval_config = spec.get("retrievalConfig")

        if retrieval_config:
            retriever_name = retrieval_config.get("retriever_name")
            retriever_namespace = retrieval_config.get("retriever_namespace", "default")
            embedding_config = retrieval_config.get("embedding_config")

            if retriever_name and embedding_config:
                embedding_model_name = embedding_config.get("model_name")
                embedding_model_namespace = embedding_config.get(
                    "model_namespace", "default"
                )

                # Schedule re-indexing in background
                background_tasks.add_task(
                    _reindex_document_background,
                    knowledge_base_id=str(doc.kind_id),
                    attachment_id=doc.attachment_id,
                    retriever_name=retriever_name,
                    retriever_namespace=retriever_namespace,
                    embedding_model_name=embedding_model_name,
                    embedding_model_namespace=embedding_model_namespace,
                    user_id=current_user.id,
                    splitter_config=doc.splitter_config,
                    document_id=doc.id,
                    kb_user_id=kb.user_id,
                    kb_namespace=kb.namespace,
                )
                logger.info(
                    f"Scheduled re-indexing for document {doc.id} after content update"
                )

    mime_type = EXTENSION_TO_MIME_TYPE.get(file_extension, "text/plain")

    return DocumentContentResponse(
        id=doc.id,
        name=doc.name,
        file_extension=doc.file_extension,
        mime_type=mime_type,
        content=data.content,
        is_editable=True,
        updated_at=doc.updated_at,
    )


def _reindex_document_background(
    knowledge_base_id: str,
    attachment_id: int,
    retriever_name: str,
    retriever_namespace: str,
    embedding_model_name: str,
    embedding_model_namespace: str,
    user_id: int,
    splitter_config: Optional[dict] = None,
    document_id: Optional[int] = None,
    kb_user_id: Optional[int] = None,
    kb_namespace: Optional[str] = None,
):
    """
    Background task for re-indexing document after content update.

    This function deletes the old index and creates a new one with updated content.
    """
    logger.info(
        f"Background task started: re-indexing document {document_id} for knowledge base {knowledge_base_id}"
    )

    db = SessionLocal()
    try:
        # Determine index owner user_id
        if kb_namespace == "default":
            index_owner_user_id = user_id
        else:
            index_owner_user_id = kb_user_id if kb_user_id else user_id

        # Get retriever from database
        retriever_crd = retriever_kinds_service.get_retriever(
            db=db,
            user_id=user_id,
            name=retriever_name,
            namespace=retriever_namespace,
        )

        if not retriever_crd:
            logger.error(
                f"Retriever {retriever_name} (namespace: {retriever_namespace}) not found"
            )
            return

        # Create storage backend from retriever
        storage_backend = create_storage_backend(retriever_crd)

        # Create document service
        doc_service = DocumentService(storage_backend=storage_backend)

        # Delete old index
        if document_id:
            try:
                asyncio.run(
                    doc_service.delete_document(
                        knowledge_id=knowledge_base_id,
                        doc_ref=str(document_id),
                        user_id=index_owner_user_id,
                    )
                )
                logger.info(f"Deleted old index for document {document_id}")
            except Exception as e:
                logger.warning(f"Failed to delete old index: {e}")

        # Convert splitter_config dict to SplitterConfig if needed
        splitter_config_obj = None
        if splitter_config:
            splitter_config_obj = SplitterConfig(**splitter_config)

        # Re-index document
        result = asyncio.run(
            doc_service.index_document(
                knowledge_id=knowledge_base_id,
                embedding_model_name=embedding_model_name,
                embedding_model_namespace=embedding_model_namespace,
                user_id=index_owner_user_id,
                db=db,
                attachment_id=attachment_id,
                splitter_config=splitter_config_obj,
                document_id=document_id,
            )
        )

        logger.info(
            f"Successfully re-indexed document {document_id} for knowledge base {knowledge_base_id}: {result}"
        )

    except Exception as e:
        logger.error(
            f"Failed to re-index document {document_id}: {str(e)}",
            exc_info=True,
        )
    finally:
        db.close()
        logger.info(f"Background re-indexing task completed for document {document_id}")
