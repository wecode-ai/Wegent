# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External web content API endpoints."""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.subtask_context import AttachmentResponse
from app.services.web_content import WebContentCrawlError, web_content_service

logger = logging.getLogger(__name__)

router = APIRouter()


class WebContentCrawlRequest(BaseModel):
    """Request for crawling external web content."""

    url: str = Field(..., min_length=1, description="External web page URL")


class WebContentCrawlResponse(BaseModel):
    """Response for crawling external web content into video attachments."""

    attachments: list[AttachmentResponse]


@router.post("/crawl", response_model=WebContentCrawlResponse)
async def crawl_external_web_content(
    request: WebContentCrawlRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WebContentCrawlResponse:
    """Crawl an external web page and persist it as an attachment context."""
    logger.info(
        "User %s crawling external web content: url=%s",
        current_user.id,
        request.url,
    )
    try:
        preview = await web_content_service.crawl(request.url)
    except HTTPException:
        raise
    except WebContentCrawlError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc) or "External web content crawl failed",
        ) from exc

    try:
        contexts = await web_content_service.create_context(
            db,
            user=current_user,
            preview=preview,
        )
    except HTTPException:
        raise
    except WebContentCrawlError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc) or "External web content video import failed",
        ) from exc
    except Exception as exc:
        logger.exception("Failed to import external web videos: url=%s", request.url)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="External web content video upload failed",
        ) from exc

    return WebContentCrawlResponse(
        attachments=[
            AttachmentResponse.from_context(context, None) for context in contexts
        ]
    )
