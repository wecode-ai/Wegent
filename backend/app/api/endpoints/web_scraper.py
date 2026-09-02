# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web scraper API endpoints for fetching and converting web pages."""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.payload_codec import run_payload_codec
from app.core.security import DetachedUser, get_detached_current_user
from app.schemas.knowledge import (
    KnowledgeDocumentResponse,
    WebScrapeRequest,
    WebScrapeResponse,
)
from app.services.knowledge.orchestrator import knowledge_orchestrator
from app.services.web_scraper import get_web_scraper_service

logger = logging.getLogger(__name__)

router = APIRouter()


def _build_scrape_response(
    title: str | None,
    content: str,
    url: str,
    scraped_at: str,
    content_length: int,
    description: str | None,
    success: bool,
    error_code: str | None,
    error_message: str | None,
) -> WebScrapeResponse:
    return WebScrapeResponse(
        title=title,
        content=content,
        url=url,
        scraped_at=scraped_at,
        content_length=content_length,
        description=description,
        success=success,
        error_code=error_code,
        error_message=error_message,
    )


class WebDocumentCreateRequest(BaseModel):
    """Request to create a document from a web page."""

    url: str = Field(..., min_length=1, description="URL to scrape")
    knowledge_base_id: int = Field(
        ..., description="Knowledge base ID to add document to"
    )
    name: Optional[str] = Field(
        None, description="Optional document name (uses page title if not provided)"
    )
    folder_id: int = Field(0, ge=0, description="Target folder ID (0 = root level)")


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


def _build_create_response(result: dict[str, Any]) -> WebDocumentCreateResponse:
    return WebDocumentCreateResponse.model_validate(result)


def _build_refresh_response(result: dict[str, Any]) -> WebDocumentRefreshResponse:
    return WebDocumentRefreshResponse.model_validate(result)


@router.post("/scrape", response_model=WebScrapeResponse)
async def scrape_web_page(
    request: WebScrapeRequest,
    current_user: DetachedUser = Depends(get_detached_current_user),
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
        return await run_payload_codec(
            _build_scrape_response,
            result.title,
            result.content,
            result.url,
            result.scraped_at.isoformat(),
            result.content_length,
            result.description,
            result.success,
            result.error_code,
            result.error_message,
            payload_hint=result.content,
            force_offload=True,
        )

    logger.info(
        f"Successfully scraped {request.url}: {result.content_length} chars, title={result.title}"
    )

    return await run_payload_codec(
        _build_scrape_response,
        result.title,
        result.content,
        result.url,
        result.scraped_at.isoformat(),
        result.content_length,
        result.description,
        result.success,
        result.error_code,
        result.error_message,
        payload_hint=result.content,
        force_offload=True,
    )


@router.post("/create-document", response_model=WebDocumentCreateResponse)
async def create_web_document(
    request: WebDocumentCreateRequest,
    current_user: DetachedUser = Depends(get_detached_current_user),
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
    Returns:
        WebDocumentCreateResponse with created document or error
    """
    logger.info(
        f"User {current_user.id} creating web document from URL: {request.url} "
        f"in knowledge base {request.knowledge_base_id}"
    )

    # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
    result = await knowledge_orchestrator.create_web_document_for_user(
        user_id=current_user.id,
        url=request.url,
        knowledge_base_id=request.knowledge_base_id,
        name=request.name,
        folder_id=request.folder_id,
        trigger_indexing=True,
        trigger_summary=True,
    )

    return await run_payload_codec(
        _build_create_response,
        result,
        payload_hint=result,
        force_offload=True,
    )


@router.post("/refresh-document", response_model=WebDocumentRefreshResponse)
async def refresh_web_document(
    request: WebDocumentRefreshRequest,
    current_user: DetachedUser = Depends(get_detached_current_user),
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
    Returns:
        WebDocumentRefreshResponse with refreshed document or error
    """
    logger.info(f"User {current_user.id} refreshing web document {request.document_id}")

    # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
    result = await knowledge_orchestrator.refresh_web_document_for_user(
        user_id=current_user.id,
        document_id=request.document_id,
        trigger_indexing=True,
        trigger_summary=False,  # Don't re-generate summary on refresh
    )

    return await run_payload_codec(
        _build_refresh_response,
        result,
        payload_hint=result,
        force_offload=True,
    )
