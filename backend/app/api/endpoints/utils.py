# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility API endpoints
"""

from fastapi import APIRouter, Query
from pydantic import HttpUrl

from app.services.url_metadata import UrlMetadata, fetch_url_metadata

router = APIRouter()


@router.get("/url-metadata", response_model=UrlMetadata)
async def get_url_metadata(
    url: str = Query(..., description="The URL to fetch metadata from"),
) -> UrlMetadata:
    """
    Fetch metadata (title, description, favicon) for a given URL.

    This endpoint is used by the frontend to display rich link previews
    in chat messages.

    Args:
        url: The URL to fetch metadata from (must be HTTP or HTTPS)

    Returns:
        UrlMetadata object containing:
        - url: The original URL
        - title: The page title (from og:title, twitter:title, or <title> tag)
        - description: The page description (from og:description, twitter:description, or meta description)
        - favicon: The favicon URL
        - success: Whether the metadata fetch was successful
    """
    return await fetch_url_metadata(url)
