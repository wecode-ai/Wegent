# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web scraper API endpoints for fetching and converting web pages."""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeDocumentResponse,
    WebScrapeRequest,
    WebScrapeResponse,
)
from app.services.web_scraper import get_web_scraper_service

logger = logging.getLogger(__name__)

router = APIRouter()


class WebDocumentCreateRequest(BaseModel):
    """Request to create a document from a web page."""

    url: str = Field(..., min_length=1, description="URL to scrape")
    knowledge_base_id: int = Field(
        ..., description="Knowledge base ID to add document to"
    )
    name: Optional[str] = Field(
        None, description="Optional document name (uses page title if not provided)"
    )


class WebDocumentCreateResponse(BaseModel):
    """Response for web document creation."""

    success: bool = Field(..., description="Whether the operation succeeded")
    document: Optional[KnowledgeDocumentResponse] = Field(
        None, description="Created document"
    )
    error_code: Optional[str] = Field(None, description="Error code if failed")
    error_message: Optional[str] = Field(None, description="Error message if failed")


class WebDocumentRefreshRequest(BaseModel):
    """Request to refresh a web document."""

    document_id: int = Field(..., description="Document ID to refresh")


class WebDocumentRefreshResponse(BaseModel):
    """Response for web document refresh."""

    success: bool = Field(..., description="Whether the operation succeeded")
    document: Optional[KnowledgeDocumentResponse] = Field(
        None, description="Refreshed document"
    )
    error_code: Optional[str] = Field(None, description="Error code if failed")
    error_message: Optional[str] = Field(None, description="Error message if failed")


@router.post("/scrape", response_model=WebScrapeResponse)
async def scrape_web_page(
    request: WebScrapeRequest,
    current_user: User = Depends(get_current_user),
) -> WebScrapeResponse:
    """Scrape a web page and convert to Markdown.

    Args:
        request: Web scrape request with URL
        current_user: Current authenticated user

    Returns:
        WebScrapeResponse with scraped content

    Raises:
        HTTPException: If scraping fails
    """
    logger.info(f"User {current_user.id} scraping URL: {request.url}")

    service = get_web_scraper_service()
    result = await service.scrape_url(request.url)

    if not result.success:
        logger.warning(
            f"Scrape failed for {request.url}: {result.error_code} - {result.error_message}"
        )
        # Return the error response with success=False
        return WebScrapeResponse(
            title=result.title,
            content=result.content,
            url=result.url,
            scraped_at=result.scraped_at.isoformat(),
            content_length=result.content_length,
            description=result.description,
            success=False,
            error_code=result.error_code,
            error_message=result.error_message,
        )

    logger.info(
        f"Successfully scraped {request.url}: {result.content_length} chars, title={result.title}"
    )

    return WebScrapeResponse(
        title=result.title,
        content=result.content,
        url=result.url,
        scraped_at=result.scraped_at.isoformat(),
        content_length=result.content_length,
        description=result.description,
        success=True,
    )


@router.post("/create-document", response_model=WebDocumentCreateResponse)
async def create_web_document(
    request: WebDocumentCreateRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WebDocumentCreateResponse:
    """Scrape a web page and create a document in the knowledge base.

    This endpoint combines web scraping with document creation:
    1. Scrapes the web page and converts to Markdown
    2. Saves the content as an attachment
    3. Creates a document record in the knowledge base
    4. Triggers RAG indexing in background

    Args:
        request: Web document creation request
        background_tasks: FastAPI background tasks
        current_user: Current authenticated user
        db: Database session

    Returns:
        WebDocumentCreateResponse with created document or error
    """
    from urllib.parse import urlparse

    from app.models.subtask_context import SubtaskContext
    from app.schemas.knowledge import DocumentSourceType, KnowledgeDocumentCreate
    from app.services.knowledge import KnowledgeService

    logger.info(
        f"User {current_user.id} creating web document from URL: {request.url} "
        f"in knowledge base {request.knowledge_base_id}"
    )

    # Step 1: Scrape the web page
    service = get_web_scraper_service()
    result = await service.scrape_url(request.url)

    if not result.success:
        logger.warning(
            f"Scrape failed for {request.url}: {result.error_code} - {result.error_message}"
        )
        return WebDocumentCreateResponse(
            success=False,
            document=None,
            error_code=result.error_code,
            error_message=result.error_message,
        )

    # Step 2: Determine document name
    doc_name = request.name
    if not doc_name:
        doc_name = result.title or urlparse(request.url).netloc
    # Ensure name has .md extension for proper handling
    if not doc_name.endswith(".md"):
        doc_name = f"{doc_name}.md"

    # Step 3: Create attachment (SubtaskContext) to store the content
    content_bytes = result.content.encode("utf-8")
    content_size = len(content_bytes)

    attachment = SubtaskContext(
        user_id=current_user.id,
        context_type="attachment",
        name=doc_name,
        status="ready",
        extracted_text=result.content,
        text_length=len(result.content),
        type_data={
            "original_filename": doc_name,
            "file_extension": "md",
            "file_size": content_size,
            "mime_type": "text/markdown",
            "storage_backend": "mysql",
        },
    )
    db.add(attachment)
    db.flush()  # Get the attachment ID

    logger.info(f"Created attachment {attachment.id} for web document")

    # Step 4: Create document record
    try:
        doc_data = KnowledgeDocumentCreate(
            attachment_id=attachment.id,
            name=doc_name,
            file_extension="md",
            file_size=content_size,
            source_type=DocumentSourceType.WEB,
            source_config={
                "url": result.url,
                "scraped_at": result.scraped_at.isoformat(),
                "title": result.title,
                "description": result.description,
            },
        )

        document = KnowledgeService.create_document(
            db=db,
            knowledge_base_id=request.knowledge_base_id,
            user_id=current_user.id,
            data=doc_data,
        )

        logger.info(
            f"Created web document {document.id} in knowledge base {request.knowledge_base_id}"
        )

        # Step 5: Trigger RAG indexing in background (same as file upload)
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=request.knowledge_base_id,
            user_id=current_user.id,
        )

        if knowledge_base:
            spec = knowledge_base.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")

            if retrieval_config:
                from app.api.endpoints.knowledge import (
                    KnowledgeBaseIndexInfo,
                    _index_document_background,
                )

                retriever_name = retrieval_config.get("retriever_name")
                retriever_namespace = retrieval_config.get(
                    "retriever_namespace", "default"
                )
                embedding_config = retrieval_config.get("embedding_config")

                if retriever_name and embedding_config:
                    embedding_model_name = embedding_config.get("model_name")
                    embedding_model_namespace = embedding_config.get(
                        "model_namespace", "default"
                    )

                    summary_enabled = spec.get("summaryEnabled", False)
                    if knowledge_base.namespace == "default":
                        index_owner_user_id = current_user.id
                    else:
                        index_owner_user_id = knowledge_base.user_id

                    kb_index_info = KnowledgeBaseIndexInfo(
                        index_owner_user_id=index_owner_user_id,
                        summary_enabled=summary_enabled,
                    )

                    background_tasks.add_task(
                        _index_document_background,
                        knowledge_base_id=str(request.knowledge_base_id),
                        attachment_id=attachment.id,
                        retriever_name=retriever_name,
                        retriever_namespace=retriever_namespace,
                        embedding_model_name=embedding_model_name,
                        embedding_model_namespace=embedding_model_namespace,
                        user_id=current_user.id,
                        user_name=current_user.user_name,
                        splitter_config=None,
                        document_id=document.id,
                        kb_index_info=kb_index_info,
                    )
                    logger.info(
                        f"Scheduled RAG indexing for web document {document.id}"
                    )

        return WebDocumentCreateResponse(
            success=True,
            document=KnowledgeDocumentResponse.model_validate(document),
            error_code=None,
            error_message=None,
        )

    except ValueError as e:
        # Rollback attachment creation on error
        db.rollback()
        logger.error(f"Failed to create web document: {e}")
        return WebDocumentCreateResponse(
            success=False,
            document=None,
            error_code="CREATE_FAILED",
            error_message=str(e),
        )


@router.post("/refresh-document", response_model=WebDocumentRefreshResponse)
async def refresh_web_document(
    request: WebDocumentRefreshRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WebDocumentRefreshResponse:
    """Refresh a web document by re-scraping its URL.

    This endpoint updates an existing web document:
    1. Gets the document and its source URL
    2. Re-scrapes the web page
    3. Updates the attachment content
    4. Updates the document metadata
    5. Re-triggers RAG indexing in background

    Args:
        request: Web document refresh request with document_id
        background_tasks: FastAPI background tasks
        current_user: Current authenticated user
        db: Database session

    Returns:
        WebDocumentRefreshResponse with refreshed document or error
    """
    from app.models.knowledge import DocumentSourceType, KnowledgeDocument
    from app.models.subtask_context import SubtaskContext
    from app.services.knowledge import KnowledgeService

    logger.info(f"User {current_user.id} refreshing web document {request.document_id}")

    # Step 1: Get the document and verify it's a web document
    document = KnowledgeService.get_document(
        db=db,
        document_id=request.document_id,
        user_id=current_user.id,
    )

    if not document:
        return WebDocumentRefreshResponse(
            success=False,
            document=None,
            error_code="NOT_FOUND",
            error_message="Document not found or access denied",
        )

    if document.source_type != DocumentSourceType.WEB.value:
        return WebDocumentRefreshResponse(
            success=False,
            document=None,
            error_code="INVALID_TYPE",
            error_message="Only web documents can be refreshed",
        )

    # Step 2: Get the source URL from source_config
    source_config = document.source_config or {}
    url = source_config.get("url")

    if not url:
        return WebDocumentRefreshResponse(
            success=False,
            document=None,
            error_code="NO_URL",
            error_message="Document has no source URL",
        )

    # Step 3: Re-scrape the web page
    service = get_web_scraper_service()
    result = await service.scrape_url(url)

    if not result.success:
        logger.warning(
            f"Scrape failed for {url}: {result.error_code} - {result.error_message}"
        )
        return WebDocumentRefreshResponse(
            success=False,
            document=None,
            error_code=result.error_code,
            error_message=result.error_message,
        )

    # Step 4: Update the attachment content
    content_bytes = result.content.encode("utf-8")
    content_size = len(content_bytes)

    attachment = (
        db.query(SubtaskContext)
        .filter(SubtaskContext.id == document.attachment_id)
        .first()
    )

    if attachment:
        # Update existing attachment
        attachment.extracted_text = result.content
        attachment.text_length = len(result.content)
        attachment.type_data = {
            **attachment.type_data,
            "file_size": content_size,
        }
        db.flush()
        logger.info(f"Updated attachment {attachment.id} for web document")
    else:
        # Create new attachment if not found (shouldn't happen normally)
        attachment = SubtaskContext(
            user_id=current_user.id,
            context_type="attachment",
            name=document.name,
            status="ready",
            extracted_text=result.content,
            text_length=len(result.content),
            type_data={
                "original_filename": document.name,
                "file_extension": "md",
                "file_size": content_size,
                "mime_type": "text/markdown",
                "storage_backend": "mysql",
            },
        )
        db.add(attachment)
        db.flush()
        document.attachment_id = attachment.id
        logger.info(f"Created new attachment {attachment.id} for web document")

    # Step 5: Update document metadata
    document.file_size = content_size
    document.source_config = {
        "url": result.url,
        "scraped_at": result.scraped_at.isoformat(),
        "title": result.title,
        "description": result.description,
    }
    # Reset is_active to False, will be set to True after re-indexing
    document.is_active = False

    try:
        db.commit()
        db.refresh(document)
        logger.info(f"Updated web document {document.id} metadata")

        # Step 6: Trigger RAG re-indexing in background
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=document.kind_id,
            user_id=current_user.id,
        )

        if knowledge_base:
            spec = knowledge_base.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")

            if retrieval_config:
                from app.api.endpoints.knowledge import (
                    KnowledgeBaseIndexInfo,
                    _index_document_background,
                )

                retriever_name = retrieval_config.get("retriever_name")
                retriever_namespace = retrieval_config.get(
                    "retriever_namespace", "default"
                )
                embedding_config = retrieval_config.get("embedding_config")

                if retriever_name and embedding_config:
                    embedding_model_name = embedding_config.get("model_name")
                    embedding_model_namespace = embedding_config.get(
                        "model_namespace", "default"
                    )

                    summary_enabled = spec.get("summaryEnabled", False)
                    if knowledge_base.namespace == "default":
                        index_owner_user_id = current_user.id
                    else:
                        index_owner_user_id = knowledge_base.user_id

                    kb_index_info = KnowledgeBaseIndexInfo(
                        index_owner_user_id=index_owner_user_id,
                        summary_enabled=summary_enabled,
                    )

                    background_tasks.add_task(
                        _index_document_background,
                        knowledge_base_id=str(document.kind_id),
                        attachment_id=attachment.id,
                        retriever_name=retriever_name,
                        retriever_namespace=retriever_namespace,
                        embedding_model_name=embedding_model_name,
                        embedding_model_namespace=embedding_model_namespace,
                        user_id=current_user.id,
                        user_name=current_user.user_name,
                        splitter_config=None,
                        document_id=document.id,
                        kb_index_info=kb_index_info,
                    )
                    logger.info(
                        f"Scheduled RAG re-indexing for refreshed web document {document.id}"
                    )

        return WebDocumentRefreshResponse(
            success=True,
            document=KnowledgeDocumentResponse.model_validate(document),
            error_code=None,
            error_message=None,
        )

    except Exception as e:
        db.rollback()
        logger.error(f"Failed to refresh web document: {e}")
        return WebDocumentRefreshResponse(
            success=False,
            document=None,
            error_code="REFRESH_FAILED",
            error_message=str(e),
        )
