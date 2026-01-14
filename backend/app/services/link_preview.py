# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Link preview service for fetching Open Graph metadata including images.
Supports detection of image URLs, video platforms (YouTube, Bilibili, Vimeo),
and standard web pages with og:image support.

This service extends the basic url_metadata service with:
- og:image extraction for rich preview cards
- URL type detection (website, image, video)
- Video platform thumbnail extraction
- Site name extraction
"""

import hashlib
import logging
import re
from typing import Literal, Optional
from urllib.parse import parse_qs, urljoin, urlparse

import httpx
import redis
from pydantic import BaseModel

from app.core.config import settings
from app.services.url_metadata import (
    MAX_CONTENT_SIZE,
    URL_FETCH_TIMEOUT,
    URL_METADATA_SSL_VERIFY,
    _extract_description,
    _extract_favicon,
    _extract_meta_content,
    _extract_title,
    _validate_url_for_ssrf,
)

logger = logging.getLogger(__name__)

# Cache TTL for link preview (24 hours as per requirements)
LINK_PREVIEW_CACHE_TTL = 86400

# Image file extensions
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico"}

# Video platform patterns
VIDEO_PLATFORMS = {
    "youtube": {
        "domains": ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"],
        "thumbnail_pattern": "https://img.youtube.com/vi/{video_id}/maxresdefault.jpg",
    },
    "bilibili": {
        "domains": ["bilibili.com", "www.bilibili.com", "b23.tv"],
        "thumbnail_pattern": None,  # Bilibili requires API call or og:image
    },
    "vimeo": {
        "domains": ["vimeo.com", "www.vimeo.com", "player.vimeo.com"],
        "thumbnail_pattern": None,  # Vimeo requires oEmbed API
    },
}


class LinkPreviewResult(BaseModel):
    """Link preview result schema with extended metadata"""

    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    favicon: Optional[str] = None
    site_name: Optional[str] = None
    type: Literal["website", "image", "video"] = "website"
    success: bool = True


def _get_cache_key(url: str) -> str:
    """Generate a cache key for link preview"""
    url_hash = hashlib.md5(url.encode()).hexdigest()
    return f"link_preview:{url_hash}"


def _get_redis_client():
    """Get Redis client instance"""
    try:
        return redis.from_url(settings.REDIS_URL)
    except Exception as e:
        logger.warning(f"Failed to connect to Redis: {e}")
        return None


def _is_image_url(url: str) -> bool:
    """Check if URL points to an image based on extension"""
    try:
        parsed = urlparse(url)
        path = parsed.path.lower()
        return any(path.endswith(ext) for ext in IMAGE_EXTENSIONS)
    except Exception:
        return False


def _detect_video_platform(url: str) -> Optional[tuple[str, Optional[str]]]:
    """
    Detect if URL is from a video platform and extract video ID.

    Returns:
        Tuple of (platform_name, video_id) or None if not a video platform
    """
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        hostname = hostname.lower()

        # YouTube
        if any(domain in hostname for domain in VIDEO_PLATFORMS["youtube"]["domains"]):
            video_id = None

            # youtu.be/VIDEO_ID
            if "youtu.be" in hostname:
                video_id = parsed.path.strip("/").split("/")[0] if parsed.path else None

            # youtube.com/watch?v=VIDEO_ID
            elif "v" in parse_qs(parsed.query):
                video_id = parse_qs(parsed.query)["v"][0]

            # youtube.com/embed/VIDEO_ID or youtube.com/v/VIDEO_ID
            elif "/embed/" in parsed.path or "/v/" in parsed.path:
                parts = parsed.path.split("/")
                for i, part in enumerate(parts):
                    if part in ("embed", "v") and i + 1 < len(parts):
                        video_id = parts[i + 1]
                        break

            # youtube.com/shorts/VIDEO_ID
            elif "/shorts/" in parsed.path:
                parts = parsed.path.split("/shorts/")
                if len(parts) > 1:
                    video_id = parts[1].split("/")[0].split("?")[0]

            return ("youtube", video_id)

        # Bilibili
        if any(domain in hostname for domain in VIDEO_PLATFORMS["bilibili"]["domains"]):
            video_id = None

            # bilibili.com/video/BV... or bilibili.com/video/av...
            match = re.search(r"/video/(BV[\w]+|av\d+)", parsed.path)
            if match:
                video_id = match.group(1)

            # b23.tv/xxx (short URL - need to follow redirect)
            elif "b23.tv" in hostname:
                video_id = parsed.path.strip("/")

            return ("bilibili", video_id)

        # Vimeo
        if any(domain in hostname for domain in VIDEO_PLATFORMS["vimeo"]["domains"]):
            video_id = None

            # vimeo.com/VIDEO_ID
            match = re.search(r"vimeo\.com/(\d+)", url)
            if match:
                video_id = match.group(1)

            # player.vimeo.com/video/VIDEO_ID
            match = re.search(r"player\.vimeo\.com/video/(\d+)", url)
            if match:
                video_id = match.group(1)

            return ("vimeo", video_id)

        return None
    except Exception:
        return None


def _get_youtube_thumbnail(video_id: str) -> str:
    """Get YouTube video thumbnail URL"""
    return f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"


def _extract_og_image(html: str, base_url: str) -> Optional[str]:
    """Extract Open Graph image from HTML"""
    # Try og:image first
    og_image = _extract_meta_content(html, "og:image")
    if og_image:
        # Handle relative URLs
        if not og_image.startswith(("http://", "https://", "//")):
            og_image = urljoin(base_url, og_image)
        elif og_image.startswith("//"):
            og_image = "https:" + og_image
        return og_image

    # Try twitter:image
    twitter_image = _extract_meta_content(html, "twitter:image", "name")
    if twitter_image:
        if not twitter_image.startswith(("http://", "https://", "//")):
            twitter_image = urljoin(base_url, twitter_image)
        elif twitter_image.startswith("//"):
            twitter_image = "https:" + twitter_image
        return twitter_image

    # Try twitter:image:src
    twitter_image_src = _extract_meta_content(html, "twitter:image:src", "name")
    if twitter_image_src:
        if not twitter_image_src.startswith(("http://", "https://", "//")):
            twitter_image_src = urljoin(base_url, twitter_image_src)
        elif twitter_image_src.startswith("//"):
            twitter_image_src = "https:" + twitter_image_src
        return twitter_image_src

    return None


def _extract_site_name(html: str) -> Optional[str]:
    """Extract site name from HTML"""
    # Try og:site_name
    site_name = _extract_meta_content(html, "og:site_name")
    if site_name:
        return site_name

    # Try application-name
    app_name = _extract_meta_content(html, "application-name", "name")
    if app_name:
        return app_name

    return None


def _cache_result(redis_client, url: str, result: LinkPreviewResult):
    """Cache the link preview result in Redis"""
    if not redis_client:
        return

    try:
        import json

        cache_key = _get_cache_key(url)
        redis_client.setex(
            cache_key,
            LINK_PREVIEW_CACHE_TTL,
            json.dumps(result.model_dump()),
        )
    except Exception as e:
        logger.warning(f"Failed to cache link preview: {e}")


async def fetch_link_preview(url: str) -> LinkPreviewResult:
    """
    Fetch link preview metadata from a URL.

    Supports:
    - Standard web pages with Open Graph metadata
    - Direct image URLs
    - Video platform URLs (YouTube, Bilibili, Vimeo)

    Args:
        url: The URL to fetch preview for

    Returns:
        LinkPreviewResult with title, description, image, type, etc.
    """
    # Validate URL for SSRF protection
    if not _validate_url_for_ssrf(url):
        return LinkPreviewResult(url=url, success=False)

    # Check cache first
    redis_client = _get_redis_client()
    if redis_client:
        cache_key = _get_cache_key(url)
        try:
            cached = redis_client.get(cache_key)
            if cached:
                import json

                data = json.loads(cached)
                return LinkPreviewResult(**data)
        except Exception as e:
            logger.warning(f"Failed to read from cache: {e}")

    # Handle direct image URLs
    if _is_image_url(url):
        result = LinkPreviewResult(
            url=url,
            image=url,
            type="image",
            success=True,
        )
        _cache_result(redis_client, url, result)
        return result

    # Detect video platforms
    video_info = _detect_video_platform(url)
    if video_info:
        platform, video_id = video_info

        # For YouTube, we can directly generate thumbnail URL
        if platform == "youtube" and video_id:
            thumbnail = _get_youtube_thumbnail(video_id)
            # Still fetch the page to get title and description
            page_result = await _fetch_page_metadata(url)
            result = LinkPreviewResult(
                url=url,
                title=page_result.get("title"),
                description=page_result.get("description"),
                image=thumbnail,
                favicon=page_result.get("favicon"),
                site_name=page_result.get("site_name") or "YouTube",
                type="video",
                success=True,
            )
            _cache_result(redis_client, url, result)
            return result

        # For other video platforms, fetch og:image from page
        page_result = await _fetch_page_metadata(url)
        result = LinkPreviewResult(
            url=url,
            title=page_result.get("title"),
            description=page_result.get("description"),
            image=page_result.get("image"),
            favicon=page_result.get("favicon"),
            site_name=page_result.get("site_name") or platform.capitalize(),
            type="video",
            success=page_result.get("success", False),
        )
        _cache_result(redis_client, url, result)
        return result

    # Standard web page - fetch metadata
    page_result = await _fetch_page_metadata(url)
    result = LinkPreviewResult(
        url=url,
        title=page_result.get("title"),
        description=page_result.get("description"),
        image=page_result.get("image"),
        favicon=page_result.get("favicon"),
        site_name=page_result.get("site_name"),
        type="website",
        success=page_result.get("success", False),
    )
    _cache_result(redis_client, url, result)
    return result


async def _fetch_page_metadata(url: str) -> dict:
    """
    Fetch page metadata from URL.

    Returns dict with title, description, image, favicon, site_name, success
    """
    # Log SSL verification status if disabled
    if not URL_METADATA_SSL_VERIFY:
        logger.warning(f"SSL verification disabled for link preview fetch: {url}")

    try:
        async with httpx.AsyncClient(
            timeout=URL_FETCH_TIMEOUT,
            follow_redirects=True,
            verify=URL_METADATA_SSL_VERIFY,
        ) as client:
            async with client.stream(
                "GET",
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; WegentBot/1.0; +https://wegent.ai)",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                },
            ) as response:
                # Re-validate the final URL after redirects
                final_url = str(response.url)
                if final_url != url and not _validate_url_for_ssrf(final_url):
                    logger.warning(
                        f"Blocked redirect to internal URL: {url} -> {final_url}"
                    )
                    return {"success": False}

                # Check content type
                content_type = response.headers.get("content-type", "")
                if (
                    "text/html" not in content_type
                    and "application/xhtml" not in content_type
                ):
                    return {"success": True}

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
        image = _extract_og_image(html, url)
        favicon = _extract_favicon(html, url)
        site_name = _extract_site_name(html)

        # Truncate long descriptions
        if description and len(description) > 200:
            description = description[:197] + "..."

        return {
            "title": title,
            "description": description,
            "image": image,
            "favicon": favicon,
            "site_name": site_name,
            "success": True,
        }

    except httpx.TimeoutException:
        logger.warning(f"Timeout fetching link preview: {url}")
        return {"success": False}
    except httpx.RequestError as e:
        logger.warning(f"Error fetching link preview: {url} - {e}")
        return {"success": False}
    except Exception as e:
        logger.error(f"Unexpected error fetching link preview: {url} - {e}")
        return {"success": False}
