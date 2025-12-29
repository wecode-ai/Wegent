# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility API endpoints.
"""

from fastapi import APIRouter, Query

from app.services.url_metadata import UrlMetadataResult, fetch_url_metadata

router = APIRouter()


@router.get("/url-metadata", response_model=UrlMetadataResult)
async def get_url_metadata(
    url: str = Query(..., description="The URL to fetch metadata from"),
) -> UrlMetadataResult:
    """
    Fetch metadata (title, description, favicon) from a web page URL.

    This endpoint is used by the frontend to render rich link cards for URLs
    shared in chat messages.

    - **url**: The full URL of the web page to fetch metadata from

    Returns:
        UrlMetadataResult containing:
        - url: The original URL
        - title: Page title (from og:title, twitter:title, or <title>)
        - description: Page description (from og:description, meta description)
        - favicon: URL to the site's favicon
        - success: Whether the fetch was successful
    """
    return await fetch_url_metadata(url)
