# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web scraper API endpoints for fetching and converting web pages."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
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
from app.services.knowledge.orchestrator import knowledge_orchestrator
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WebDocumentCreateResponse:
    """Scrape a web page and create a document in the knowledge base.

    This endpoint combines web scraping with document creation:
    1. Scrapes the web page and converts to Markdown
    2. Saves the content as an attachment
    3. Creates a document record in the knowledge base
    4. Triggers RAG indexing via Celery

    Args:
        request: Web document creation request
        current_user: Current authenticated user
        db: Database session

    Returns:
        WebDocumentCreateResponse with created document or error
    """
    logger.info(
        f"User {current_user.id} creating web document from URL: {request.url} "
        f"in knowledge base {request.knowledge_base_id}"
    )

    # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
    result = await knowledge_orchestrator.create_web_document(
        db=db,
        user=current_user,
        url=request.url,
        knowledge_base_id=request.knowledge_base_id,
        name=request.name,
        trigger_indexing=True,
        trigger_summary=True,
    )

    return WebDocumentCreateResponse(**result)


@router.post("/refresh-document", response_model=WebDocumentRefreshResponse)
async def refresh_web_document(
    request: WebDocumentRefreshRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WebDocumentRefreshResponse:
    """Refresh a web document by re-scraping its URL.

    This endpoint updates an existing web document:
    1. Gets the document and its source URL
    2. Re-scrapes the web page
    3. Updates the attachment content
    4. Updates the document metadata
    5. Re-triggers RAG indexing via Celery

    Args:
        request: Web document refresh request with document_id
        current_user: Current authenticated user
        db: Database session

    Returns:
        WebDocumentRefreshResponse with refreshed document or error
    """
    logger.info(f"User {current_user.id} refreshing web document {request.document_id}")

    # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
    result = await knowledge_orchestrator.refresh_web_document(
        db=db,
        user=current_user,
        document_id=request.document_id,
        trigger_indexing=True,
        trigger_summary=False,  # Don't re-generate summary on refresh
    )

    return WebDocumentRefreshResponse(**result)
