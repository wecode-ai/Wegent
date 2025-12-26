# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
URL metadata fetching service
Provides functionality to fetch metadata (title, description, favicon) from web pages
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger(__name__)

# Request timeout in seconds
REQUEST_TIMEOUT = 5.0

# Maximum content length to read (1MB)
MAX_CONTENT_LENGTH = 1024 * 1024

# Common user agent to avoid being blocked
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


@dataclass
class UrlMetadata:
    """URL metadata result"""

    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    favicon: Optional[str] = None
    success: bool = False


def _extract_title(html: str) -> Optional[str]:
    """Extract title from HTML content"""
    # Try Open Graph title first
    og_match = re.search(
        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    if og_match:
        return og_match.group(1).strip()

    # Try reverse order (content before property)
    og_match_reverse = re.search(
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']',
        html,
        re.IGNORECASE,
    )
    if og_match_reverse:
        return og_match_reverse.group(1).strip()

    # Try Twitter title
    twitter_match = re.search(
        r'<meta[^>]+name=["\']twitter:title["\'][^>]+content=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    if twitter_match:
        return twitter_match.group(1).strip()

    # Fallback to <title> tag
    title_match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    if title_match:
        return title_match.group(1).strip()

    return None


def _extract_description(html: str) -> Optional[str]:
    """Extract description from HTML content"""
    # Try Open Graph description first
    og_match = re.search(
        r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    if og_match:
        return og_match.group(1).strip()

    # Try reverse order
    og_match_reverse = re.search(
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:description["\']',
        html,
        re.IGNORECASE,
    )
    if og_match_reverse:
        return og_match_reverse.group(1).strip()

    # Try Twitter description
    twitter_match = re.search(
        r'<meta[^>]+name=["\']twitter:description["\'][^>]+content=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    if twitter_match:
        return twitter_match.group(1).strip()

    # Try standard meta description
    desc_match = re.search(
        r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    if desc_match:
        return desc_match.group(1).strip()

    # Try reverse order for standard description
    desc_match_reverse = re.search(
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']description["\']',
        html,
        re.IGNORECASE,
    )
    if desc_match_reverse:
        return desc_match_reverse.group(1).strip()

    return None


def _extract_favicon(html: str, base_url: str) -> Optional[str]:
    """Extract favicon URL from HTML content"""
    parsed_base = urlparse(base_url)
    base_origin = f"{parsed_base.scheme}://{parsed_base.netloc}"

    # Try to find icon link tags
    # Patterns: <link rel="icon" href="...">, <link rel="shortcut icon" href="...">
    icon_patterns = [
        r'<link[^>]+rel=["\'](?:shortcut )?icon["\'][^>]+href=["\']([^"\']+)["\']',
        r'<link[^>]+href=["\']([^"\']+)["\'][^>]+rel=["\'](?:shortcut )?icon["\']',
        r'<link[^>]+rel=["\']apple-touch-icon["\'][^>]+href=["\']([^"\']+)["\']',
    ]

    for pattern in icon_patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            favicon_url = match.group(1).strip()
            # Handle relative URLs
            if favicon_url.startswith("//"):
                return f"{parsed_base.scheme}:{favicon_url}"
            elif favicon_url.startswith("/"):
                return urljoin(base_origin, favicon_url)
            elif not favicon_url.startswith("http"):
                return urljoin(base_url, favicon_url)
            return favicon_url

    # Fallback to /favicon.ico
    return urljoin(base_origin, "/favicon.ico")


async def fetch_url_metadata(url: str) -> UrlMetadata:
    """
    Fetch metadata from a URL

    Args:
        url: The URL to fetch metadata from

    Returns:
        UrlMetadata object containing title, description, favicon, and success status
    """
    result = UrlMetadata(url=url)

    try:
        # Validate URL
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            logger.warning(f"Invalid URL scheme: {url}")
            return result

        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT,
            follow_redirects=True,
            verify=False,  # Allow self-signed certs
        ) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                },
            )

            # Check if response is HTML
            content_type = response.headers.get("content-type", "")
            if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                logger.debug(f"Non-HTML content type for {url}: {content_type}")
                # Still try to extract basic info
                result.favicon = _extract_favicon("", url)
                result.success = True
                return result

            # Limit content reading
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_CONTENT_LENGTH:
                logger.warning(f"Content too large for {url}: {content_length}")
                return result

            # Read and decode content
            html = response.text

            # Extract metadata
            result.title = _extract_title(html)
            result.description = _extract_description(html)
            result.favicon = _extract_favicon(html, str(response.url))
            result.success = True

            # Truncate description if too long
            if result.description and len(result.description) > 300:
                result.description = result.description[:297] + "..."

            logger.debug(
                f"Successfully fetched metadata for {url}: "
                f"title={result.title}, desc_len={len(result.description or '')}"
            )

    except httpx.TimeoutException:
        logger.warning(f"Timeout fetching {url}")
    except httpx.RequestError as e:
        logger.warning(f"Request error fetching {url}: {e}")
    except Exception as e:
        logger.error(f"Error fetching metadata for {url}: {e}")

    return result
