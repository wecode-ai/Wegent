# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
URL metadata service for fetching webpage metadata (title, description, favicon)
"""

import asyncio
import hashlib
import logging
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from pydantic import BaseModel

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# Cache TTL for URL metadata (15 minutes)
METADATA_CACHE_TTL = 900

# Request timeout in seconds
REQUEST_TIMEOUT = 5.0

# Maximum content length to download (1MB)
MAX_CONTENT_LENGTH = 1024 * 1024

# User agent for requests
USER_AGENT = (
    "Mozilla/5.0 (compatible; WegentBot/1.0; +https://github.com/AgiMa/Wegent)"
)


class UrlMetadata(BaseModel):
    """URL metadata response model"""

    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    favicon: Optional[str] = None
    success: bool = False


def _get_cache_key(url: str) -> str:
    """Generate cache key for URL metadata"""
    url_hash = hashlib.md5(url.encode()).hexdigest()
    return f"url_metadata:{url_hash}"


def _extract_favicon(soup: BeautifulSoup, base_url: str) -> Optional[str]:
    """Extract favicon URL from HTML document"""
    # Try various favicon link tags
    favicon_links = [
        soup.find("link", rel="icon"),
        soup.find("link", rel="shortcut icon"),
        soup.find("link", rel="apple-touch-icon"),
        soup.find("link", rel="apple-touch-icon-precomposed"),
    ]

    for link in favicon_links:
        if link and link.get("href"):
            href = link["href"]
            # Convert relative URL to absolute
            if not href.startswith(("http://", "https://", "//")):
                href = urljoin(base_url, href)
            elif href.startswith("//"):
                href = "https:" + href
            return href

    # Fallback to default favicon location
    parsed = urlparse(base_url)
    return f"{parsed.scheme}://{parsed.netloc}/favicon.ico"


def _extract_title(soup: BeautifulSoup) -> Optional[str]:
    """Extract page title from HTML document"""
    # Try Open Graph title first
    og_title = soup.find("meta", property="og:title")
    if og_title and og_title.get("content"):
        return og_title["content"].strip()

    # Try Twitter title
    twitter_title = soup.find("meta", attrs={"name": "twitter:title"})
    if twitter_title and twitter_title.get("content"):
        return twitter_title["content"].strip()

    # Fallback to regular title tag
    title_tag = soup.find("title")
    if title_tag and title_tag.string:
        return title_tag.string.strip()

    return None


def _extract_description(soup: BeautifulSoup) -> Optional[str]:
    """Extract page description from HTML document"""
    # Try Open Graph description first
    og_desc = soup.find("meta", property="og:description")
    if og_desc and og_desc.get("content"):
        return og_desc["content"].strip()[:500]

    # Try Twitter description
    twitter_desc = soup.find("meta", attrs={"name": "twitter:description"})
    if twitter_desc and twitter_desc.get("content"):
        return twitter_desc["content"].strip()[:500]

    # Fallback to regular meta description
    meta_desc = soup.find("meta", attrs={"name": "description"})
    if meta_desc and meta_desc.get("content"):
        return meta_desc["content"].strip()[:500]

    return None


async def fetch_url_metadata(url: str) -> UrlMetadata:
    """
    Fetch metadata for a given URL

    Args:
        url: The URL to fetch metadata from

    Returns:
        UrlMetadata object containing title, description, favicon, and success status
    """
    # Validate URL
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            logger.warning(f"Invalid URL scheme: {url}")
            return UrlMetadata(url=url, success=False)
    except Exception as e:
        logger.warning(f"Invalid URL: {url}, error: {e}")
        return UrlMetadata(url=url, success=False)

    # Check cache first
    cache_key = _get_cache_key(url)
    try:
        cached = await cache_manager.get(cache_key)
        if cached:
            logger.debug(f"Cache hit for URL metadata: {url}")
            return UrlMetadata(**cached)
    except Exception as e:
        logger.warning(f"Cache read error: {e}")

    # Fetch the URL
    try:
        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT,
            follow_redirects=True,
            max_redirects=5,
        ) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                },
            )

            # Check content type
            content_type = response.headers.get("content-type", "")
            if "text/html" not in content_type and "application/xhtml" not in content_type:
                logger.debug(f"Non-HTML content type for {url}: {content_type}")
                # Still return success with just the URL
                result = UrlMetadata(url=url, success=True)
                await _cache_metadata(cache_key, result)
                return result

            # Check content length
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_CONTENT_LENGTH:
                logger.warning(f"Content too large for {url}: {content_length}")
                result = UrlMetadata(url=url, success=True)
                await _cache_metadata(cache_key, result)
                return result

            # Parse HTML
            soup = BeautifulSoup(response.text, "html.parser")

            # Extract metadata
            title = _extract_title(soup)
            description = _extract_description(soup)
            favicon = _extract_favicon(soup, str(response.url))

            result = UrlMetadata(
                url=url,
                title=title,
                description=description,
                favicon=favicon,
                success=True,
            )

            # Cache the result
            await _cache_metadata(cache_key, result)

            logger.debug(f"Successfully fetched metadata for {url}")
            return result

    except httpx.TimeoutException:
        logger.warning(f"Timeout fetching URL metadata: {url}")
        return UrlMetadata(url=url, success=False)
    except httpx.HTTPStatusError as e:
        logger.warning(f"HTTP error fetching URL metadata: {url}, status: {e.response.status_code}")
        return UrlMetadata(url=url, success=False)
    except Exception as e:
        logger.error(f"Error fetching URL metadata: {url}, error: {e}")
        return UrlMetadata(url=url, success=False)


async def _cache_metadata(cache_key: str, metadata: UrlMetadata) -> None:
    """Cache metadata result"""
    try:
        await cache_manager.set(
            cache_key,
            metadata.model_dump(),
            ttl=METADATA_CACHE_TTL,
        )
    except Exception as e:
        logger.warning(f"Cache write error: {e}")
