# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Link preview service for fetching Open Graph metadata including images.
Supports standard web pages with og:image support.

This service extends the basic url_metadata service with:
- og:image extraction for rich preview cards
- Site name extraction
- Browserless screenshot fallback when og:image is not available
"""

import base64
import hashlib
import logging
from typing import Optional
from urllib.parse import urljoin, urlparse

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


class LinkPreviewResult(BaseModel):
    """Link preview result schema"""

    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    favicon: Optional[str] = None
    site_name: Optional[str] = None
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


def _extract_title_from_url(url: str) -> Optional[str]:
    """Extract a readable title from URL when page cannot be fetched"""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        # Remove common prefixes
        hostname = hostname.replace("www.", "")
        # Capitalize first letter
        if hostname:
            return hostname.split(".")[0].capitalize()
        return None
    except Exception:
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
    - Internal URLs via Browserless screenshot (when SSRF protection blocks direct access)

    Args:
        url: The URL to fetch preview for

    Returns:
        LinkPreviewResult with title, description, image, etc.
    """
    # If Browserless is disabled, return failure to trigger fallback to plain URL
    if not settings.BROWSERLESS_ENABLED or not settings.BROWSERLESS_URL:
        logger.warning("Browserless is disabled, returning failure for link preview")
        return LinkPreviewResult(
            url=url,
            title=None,
            description=None,
            image=None,
            favicon=None,
            site_name=None,
            success=False,
        )

    # Check cache first
    redis_client = _get_redis_client()
    if redis_client:
        cache_key = _get_cache_key(url)
        try:
            cached = redis_client.get(cache_key)
            if cached:
                import json

                data = json.loads(cached)
                cached_result = LinkPreviewResult(**data)
                # Only use cache if it was successful
                # Failed results might succeed after config changes (e.g., Browserless enabled)
                if cached_result.success:
                    logger.debug(f"Returning cached link preview for: {url}")
                    return cached_result
                else:
                    logger.info(f"Skipping failed cache entry, retrying: {url}")
                    # Delete the failed cache entry
                    redis_client.delete(cache_key)
        except Exception as e:
            logger.warning(f"Failed to read from cache: {e}")

    # Validate URL for SSRF protection
    is_internal_url = not _validate_url_for_ssrf(url)
    if is_internal_url:
        # For internal URLs, skip metadata fetch and use screenshot directly
        logger.info(f"Internal URL detected, using screenshot fallback: {url}")
        screenshot = await _capture_screenshot(url)
        result = LinkPreviewResult(
            url=url,
            title=_extract_title_from_url(url),
            image=screenshot,
            success=screenshot is not None,
        )
        _cache_result(redis_client, url, result)
        return result

    # Standard web page - fetch metadata
    page_result = await _fetch_page_metadata(url)

    # If no og:image found, try to capture screenshot as fallback
    image = page_result.get("image")
    if not image and page_result.get("success"):
        logger.info(f"No og:image found, attempting screenshot for: {url}")
        screenshot = await _capture_screenshot(url)
        if screenshot:
            image = screenshot

    # Only mark as success if we have an image (for card rendering)
    # Without image, frontend will show simple link instead
    has_image = image is not None
    result = LinkPreviewResult(
        url=url,
        title=page_result.get("title"),
        description=page_result.get("description"),
        image=image,
        favicon=page_result.get("favicon"),
        site_name=page_result.get("site_name"),
        success=page_result.get("success", False) and has_image,
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
        # Disable proxy for direct URL fetching (trust_env=False bypasses HTTP_PROXY)
        async with httpx.AsyncClient(
            timeout=URL_FETCH_TIMEOUT,
            follow_redirects=True,
            verify=URL_METADATA_SSL_VERIFY,
            trust_env=False,
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


async def _capture_screenshot(url: str) -> Optional[str]:
    """
    Capture a screenshot of the URL using Browserless service.

    Returns:
        Base64 encoded data URL of the screenshot, or None if failed
    """
    logger.info(
        f"_capture_screenshot called: url={url}, "
        f"BROWSERLESS_ENABLED={settings.BROWSERLESS_ENABLED}, "
        f"BROWSERLESS_URL={settings.BROWSERLESS_URL}"
    )

    if not settings.BROWSERLESS_ENABLED:
        logger.warning("Browserless screenshot is disabled via BROWSERLESS_ENABLED=False")
        return None

    browserless_url = settings.BROWSERLESS_URL.rstrip("/")
    screenshot_endpoint = f"{browserless_url}/screenshot"

    try:
        logger.info(f"Calling Browserless at: {screenshot_endpoint}")
        # Disable proxy for local Browserless service (trust_env=False bypasses HTTP_PROXY)
        async with httpx.AsyncClient(
            timeout=float(settings.BROWSERLESS_TIMEOUT),
            trust_env=False,
        ) as client:
            # Browserless /screenshot endpoint
            response = await client.post(
                screenshot_endpoint,
                json={
                    "url": url,
                    "viewport": {
                        "width": 1200,
                        "height": 630,  # Standard OG image aspect ratio
                    },
                },
            )

            if response.status_code == 200:
                # Convert to base64 data URL
                screenshot_base64 = base64.b64encode(response.content).decode("utf-8")
                data_url = f"data:image/png;base64,{screenshot_base64}"
                logger.info(f"Successfully captured screenshot for: {url}")
                return data_url
            else:
                logger.warning(
                    f"Browserless screenshot failed with status {response.status_code}: {url}, response: {response.text[:200]}"
                )
                return None

    except httpx.TimeoutException:
        logger.warning(f"Timeout capturing screenshot: {url}")
        return None
    except httpx.RequestError as e:
        logger.warning(f"Error capturing screenshot: {url} - {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error capturing screenshot: {url} - {e}")
        return None
