# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility API endpoints.
"""

from fastapi import APIRouter, Query

from app.services.link_preview import LinkPreviewResult, fetch_link_preview
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


@router.get("/link-preview", response_model=LinkPreviewResult)
async def get_link_preview(
    url: str = Query(..., description="The URL to fetch preview for"),
) -> LinkPreviewResult:
    """
    Fetch rich link preview metadata including Open Graph image.

    This endpoint is used by the frontend to render [card:url] syntax
    as rich preview cards in chat messages.

    Supports:
    - Standard web pages with Open Graph metadata (og:image, og:title, etc.)
    - Direct image URLs (jpg, png, gif, webp, etc.)
    - Video platform URLs (YouTube, Bilibili, Vimeo) with thumbnail extraction

    - **url**: The full URL to fetch preview for

    Returns:
        LinkPreviewResult containing:
        - url: The original URL
        - title: Page title
        - description: Page description
        - image: Preview image URL (og:image or video thumbnail)
        - favicon: Site favicon URL
        - site_name: Site name (og:site_name)
        - type: URL type ("website", "image", or "video")
        - success: Whether the fetch was successful
    """
    return await fetch_link_preview(url)
