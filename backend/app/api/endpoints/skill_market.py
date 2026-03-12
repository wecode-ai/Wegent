# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill Market API endpoints

This module provides API endpoints for skill market operations:
- Check availability of skill market provider
- Search skills in the market
- Download skills from the market
"""

import logging
from dataclasses import asdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from app.core import security
from app.models.user import User
from app.services.skill_market import (
    SearchParams,
    skill_market_registry,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# Response schemas
class MarketSkillResponse(BaseModel):
    """Skill information from market"""

    skillKey: str
    originalSkillKey: str
    name: str
    description: str
    author: str
    visibility: str
    tags: List[str]
    version: str
    downloadCount: int
    createdAt: str
    hasDownloadPermission: bool = True
    permissionUrl: str = ""


class SearchResultResponse(BaseModel):
    """Search result from skill market"""

    total: int
    page: int
    pageSize: int
    skills: List[MarketSkillResponse]


class AvailableResponse(BaseModel):
    """Availability check response"""

    available: bool
    market_name: Optional[str] = None
    market_url: Optional[str] = None


class ErrorResponse(BaseModel):
    """Error response"""

    error: str
    message: Optional[str] = None
    details: Optional[Dict[str, Any]] = None


@router.get("/available", response_model=AvailableResponse)
async def check_availability(
    current_user: User = Depends(security.get_current_user),
) -> AvailableResponse:
    """
    Check if a skill market provider is available.

    Returns { available: true, market_name, market_url } if a provider is registered,
    otherwise { available: false }.
    """
    try:
        available = skill_market_registry.has_provider()
        provider = skill_market_registry.get_provider()
        provider_name = provider.name if provider else None
        provider_market_url = provider.market_url if provider else None
        logger.info(
            "[SkillMarket] Availability check: available=%s, provider=%s",
            available,
            provider_name,
        )
        return AvailableResponse(
            available=available,
            market_name=provider_name if available else None,
            market_url=provider_market_url if available else None,
        )
    except Exception as e:
        logger.error("[SkillMarket] Error checking availability: %s", str(e))
        return AvailableResponse(available=False)


@router.get("/search", response_model=SearchResultResponse)
async def search_skills(
    keyword: Optional[str] = Query(None, description="Keyword search"),
    tags: Optional[str] = Query(None, description="Tag filter"),
    page: int = Query(1, ge=1, description="Page number"),
    pageSize: int = Query(20, ge=1, le=100, description="Page size"),
    current_user: User = Depends(security.get_current_user),
) -> SearchResultResponse:
    """
    Search skills in the skill market.

    Delegates to the registered skill market provider.
    If no provider is registered, returns a 503 error.
    """
    provider = skill_market_registry.get_provider()

    if not provider:
        logger.info("[SkillMarket] No provider registered, returning error")
        raise HTTPException(
            status_code=503,
            detail={
                "error": "Skill market not available",
                "message": "No skill market provider is configured. "
                "This feature requires a skill market provider to be installed.",
            },
        )

    # Build search params with current user's username
    params = SearchParams(
        keyword=keyword,
        tags=tags,
        page=page,
        pageSize=pageSize,
        user=current_user.user_name,
    )

    try:
        result = await provider.search(params)

        return SearchResultResponse(
            total=result.total,
            page=result.page,
            pageSize=result.pageSize,
            skills=[
                MarketSkillResponse(**asdict(skill)) for skill in result.skills
            ],
        )
    except Exception as e:
        error_message = str(e)
        logger.error(
            "[SkillMarket] Search error: %s",
            error_message,
            exc_info=True,
        )

        raise HTTPException(
            status_code=500,
            detail={"error": error_message},
        ) from e


@router.get("/download/{skill_key:path}")
async def download_skill(
    skill_key: str,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """
    Download a skill from the skill market.

    Delegates to the registered skill market provider.
    If no provider is registered, returns a 503 error.

    Args:
        skill_key: Unique skill identifier (path parameter, can contain slashes)
    """
    provider = skill_market_registry.get_provider()

    if not provider:
        logger.info("[SkillMarket] No provider registered, returning error")
        raise HTTPException(
            status_code=503,
            detail={
                "error": "Skill market not available",
                "message": "No skill market provider is configured. "
                "This feature requires a skill market provider to be installed.",
            },
        )

    try:
        result = await provider.download(skill_key, user=current_user.user_name)

        # Sanitize filename for Content-Disposition header
        filename = result.filename or "download.zip"
        # Strip CR/LF characters to prevent header injection
        filename = filename.replace("\r", "").replace("\n", "")
        # Replace double quotes with single quotes
        filename = filename.replace('"', "'")

        # Check if filename contains non-ASCII characters
        has_non_ascii = any(ord(c) > 127 for c in filename)

        if has_non_ascii:
            # Create ASCII-safe version
            ascii_safe = "".join(
                c if ord(c) < 128 else "_" for c in filename
            )
            # RFC5987 percent-encode the original filename
            from urllib.parse import quote

            encoded = quote(filename, safe="")
            content_disposition = (
                f'attachment; filename="{ascii_safe}"; filename*=UTF-8\'\'{encoded}'
            )
        else:
            content_disposition = f'attachment; filename="{filename}"'

        return Response(
            content=result.content,
            media_type=result.content_type,
            headers={
                "Content-Disposition": content_disposition,
            },
        )
    except Exception as e:
        error_message = str(e)
        logger.error(
            "[SkillMarket] Download error: skill_key=%s, error=%s",
            skill_key,
            error_message,
            exc_info=True,
        )

        raise HTTPException(
            status_code=500,
            detail={
                "error": error_message,
                "details": {"skillKey": skill_key},
            },
        ) from e
