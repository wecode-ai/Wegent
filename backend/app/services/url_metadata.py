# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
URL metadata service for fetching Open Graph and meta information from web pages.
"""

import hashlib
import logging
import re
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
import redis
from pydantic import BaseModel

from app.core.config import settings

logger = logging.getLogger(__name__)

# Cache TTL for URL metadata (1 hour)
URL_METADATA_CACHE_TTL = 3600
# Request timeout (5 seconds)
URL_FETCH_TIMEOUT = 5.0
# Maximum content size to download (1MB)
MAX_CONTENT_SIZE = 1 * 1024 * 1024


class UrlMetadataResult(BaseModel):
    """URL metadata result schema"""

    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    favicon: Optional[str] = None
    success: bool = True


def _get_cache_key(url: str) -> str:
    """Generate a cache key for the URL"""
    url_hash = hashlib.md5(url.encode()).hexdigest()
    return f"url_metadata:{url_hash}"


def _get_redis_client():
    """Get Redis client instance"""
    try:
        return redis.from_url(settings.REDIS_URL)
    except Exception as e:
        logger.warning(f"Failed to connect to Redis: {e}")
        return None


def _extract_meta_content(html: str, property_name: str, attr: str = "property") -> Optional[str]:
    """Extract content from meta tag"""
    # Try different patterns
    patterns = [
        rf'<meta\s+{attr}=["\']?{property_name}["\']?\s+content=["\']([^"\']*)["\']',
        rf'<meta\s+content=["\']([^"\']*)["\']?\s+{attr}=["\']?{property_name}["\']',
    ]

    for pattern in patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            return match.group(1).strip()

    return None


def _extract_title(html: str) -> Optional[str]:
    """Extract page title from HTML"""
    # First try Open Graph title
    og_title = _extract_meta_content(html, "og:title")
    if og_title:
        return og_title

    # Try Twitter card title
    twitter_title = _extract_meta_content(html, "twitter:title", "name")
    if twitter_title:
        return twitter_title

    # Fallback to <title> tag
    match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    if match:
        return match.group(1).strip()

    return None


def _extract_description(html: str) -> Optional[str]:
    """Extract page description from HTML"""
    # First try Open Graph description
    og_desc = _extract_meta_content(html, "og:description")
    if og_desc:
        return og_desc

    # Try Twitter card description
    twitter_desc = _extract_meta_content(html, "twitter:description", "name")
    if twitter_desc:
        return twitter_desc

    # Fallback to meta description
    desc = _extract_meta_content(html, "description", "name")
    if desc:
        return desc

    return None


def _extract_favicon(html: str, base_url: str) -> Optional[str]:
    """Extract favicon URL from HTML"""
    # Try to find link rel="icon" or rel="shortcut icon"
    patterns = [
        r'<link[^>]+rel=["\'](?:shortcut\s+)?icon["\'][^>]+href=["\']([^"\']+)["\']',
        r'<link[^>]+href=["\']([^"\']+)["\'][^>]+rel=["\'](?:shortcut\s+)?icon["\']',
        r'<link[^>]+rel=["\']apple-touch-icon["\'][^>]+href=["\']([^"\']+)["\']',
    ]

    for pattern in patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            favicon_url = match.group(1).strip()
            # Handle relative URLs
            if not favicon_url.startswith(("http://", "https://", "//")):
                favicon_url = urljoin(base_url, favicon_url)
            elif favicon_url.startswith("//"):
                favicon_url = "https:" + favicon_url
            return favicon_url

    # Fallback to /favicon.ico
    parsed = urlparse(base_url)
    return f"{parsed.scheme}://{parsed.netloc}/favicon.ico"


async def fetch_url_metadata(url: str) -> UrlMetadataResult:
    """
    Fetch metadata from a URL.

    Args:
        url: The URL to fetch metadata from

    Returns:
        UrlMetadataResult with title, description, favicon
    """
    # Validate URL
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return UrlMetadataResult(url=url, success=False)
    except Exception:
        return UrlMetadataResult(url=url, success=False)

    # Check cache first
    redis_client = _get_redis_client()
    if redis_client:
        cache_key = _get_cache_key(url)
        try:
            cached = redis_client.get(cache_key)
            if cached:
                import json
                data = json.loads(cached)
                return UrlMetadataResult(**data)
        except Exception as e:
            logger.warning(f"Failed to read from cache: {e}")

    # Fetch the URL
    try:
        async with httpx.AsyncClient(
            timeout=URL_FETCH_TIMEOUT,
            follow_redirects=True,
            verify=False,  # Skip SSL verification for some sites
        ) as client:
            # Use streaming to limit content size
            async with client.stream(
                "GET",
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; WegentBot/1.0; +https://wegent.ai)",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                },
            ) as response:
                # Check content type
                content_type = response.headers.get("content-type", "")
                if "text/html" not in content_type and "application/xhtml" not in content_type:
                    # Not an HTML page, return minimal result
                    result = UrlMetadataResult(url=url, success=True)
                    _cache_result(redis_client, url, result)
                    return result

                # Read limited content
                content_bytes = b""
                async for chunk in response.aiter_bytes():
                    content_bytes += chunk
                    if len(content_bytes) > MAX_CONTENT_SIZE:
                        break

                html = content_bytes.decode("utf-8", errors="ignore")

        # Extract metadata
        title = _extract_title(html)
        description = _extract_description(html)
        favicon = _extract_favicon(html, url)

        # Truncate long descriptions
        if description and len(description) > 200:
            description = description[:197] + "..."

        result = UrlMetadataResult(
            url=url,
            title=title,
            description=description,
            favicon=favicon,
            success=True,
        )

        # Cache the result
        _cache_result(redis_client, url, result)

        return result

    except httpx.TimeoutException:
        logger.warning(f"Timeout fetching URL metadata: {url}")
        return UrlMetadataResult(url=url, success=False)
    except httpx.RequestError as e:
        logger.warning(f"Error fetching URL metadata: {url} - {e}")
        return UrlMetadataResult(url=url, success=False)
    except Exception as e:
        logger.error(f"Unexpected error fetching URL metadata: {url} - {e}")
        return UrlMetadataResult(url=url, success=False)


def _cache_result(redis_client, url: str, result: UrlMetadataResult):
    """Cache the metadata result in Redis"""
    if not redis_client:
        return

    try:
        import json
        cache_key = _get_cache_key(url)
        redis_client.setex(
            cache_key,
            URL_METADATA_CACHE_TTL,
            json.dumps(result.model_dump()),
        )
    except Exception as e:
        logger.warning(f"Failed to cache URL metadata: {e}")
