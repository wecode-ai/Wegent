# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility API endpoints
Provides various utility functions like URL metadata fetching
"""

import hashlib
import json
import logging
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.core.cache import get_redis_client
from app.services.url_metadata import fetch_url_metadata

logger = logging.getLogger(__name__)

router = APIRouter()

# Cache settings
URL_METADATA_CACHE_PREFIX = "url_metadata:"
URL_METADATA_CACHE_TTL = 15 * 60  # 15 minutes


class UrlMetadataResponse(BaseModel):
    """Response model for URL metadata"""

    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    favicon: Optional[str] = None
    success: bool = False


def _get_cache_key(url: str) -> str:
    """Generate a cache key for a URL"""
    url_hash = hashlib.md5(url.encode()).hexdigest()
    return f"{URL_METADATA_CACHE_PREFIX}{url_hash}"


async def _get_cached_metadata(url: str) -> Optional[UrlMetadataResponse]:
    """Get cached URL metadata from Redis"""
    try:
        redis = await get_redis_client()
        if redis is None:
            return None

        cache_key = _get_cache_key(url)
        cached = await redis.get(cache_key)

        if cached:
            data = json.loads(cached)
            return UrlMetadataResponse(**data)
    except Exception as e:
        logger.warning(f"Error reading from cache: {e}")

    return None


async def _set_cached_metadata(url: str, metadata: UrlMetadataResponse) -> None:
    """Cache URL metadata in Redis"""
    try:
        redis = await get_redis_client()
        if redis is None:
            return

        cache_key = _get_cache_key(url)
        await redis.setex(cache_key, URL_METADATA_CACHE_TTL, metadata.model_dump_json())
    except Exception as e:
        logger.warning(f"Error writing to cache: {e}")


@router.get("/url-metadata", response_model=UrlMetadataResponse)
async def get_url_metadata(
    url: str = Query(..., description="The URL to fetch metadata from"),
) -> UrlMetadataResponse:
    """
    Fetch metadata (title, description, favicon) from a URL.

    This endpoint extracts Open Graph, Twitter Card, and standard HTML meta tags
    from the given URL. Results are cached in Redis for 15 minutes.

    Args:
        url: The URL to fetch metadata from

    Returns:
        UrlMetadataResponse containing title, description, favicon, and success status
    """
    # Check cache first
    cached = await _get_cached_metadata(url)
    if cached:
        logger.debug(f"Cache hit for URL metadata: {url}")
        return cached

    # Fetch metadata
    logger.debug(f"Fetching URL metadata: {url}")
    metadata = await fetch_url_metadata(url)

    # Build response
    response = UrlMetadataResponse(
        url=metadata.url,
        title=metadata.title,
        description=metadata.description,
        favicon=metadata.favicon,
        success=metadata.success,
    )

    # Cache the result (even on failure to prevent repeated fetches)
    await _set_cached_metadata(url, response)

    return response
