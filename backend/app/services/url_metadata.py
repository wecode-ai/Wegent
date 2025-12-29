# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
URL metadata service for fetching Open Graph and meta information from web pages.
Includes SSRF protection to block requests to private/internal IP ranges.
"""

import hashlib
import ipaddress
import logging
import os
import re
import socket
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

# SSL verification configuration (defaults to True for security)
# Set URL_METADATA_SSL_VERIFY=false in environment to disable (not recommended for production)
URL_METADATA_SSL_VERIFY = os.getenv("URL_METADATA_SSL_VERIFY", "true").lower() == "true"

# Private/internal IP ranges that should be blocked for SSRF protection
BLOCKED_IP_NETWORKS = [
    # IPv4 private ranges (RFC1918)
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    # IPv4 loopback
    ipaddress.ip_network("127.0.0.0/8"),
    # IPv4 link-local
    ipaddress.ip_network("169.254.0.0/16"),
    # IPv4 shared address space (RFC6598)
    ipaddress.ip_network("100.64.0.0/10"),
    # IPv6 loopback
    ipaddress.ip_network("::1/128"),
    # IPv6 link-local
    ipaddress.ip_network("fe80::/10"),
    # IPv6 unique local (RFC4193)
    ipaddress.ip_network("fc00::/7"),
    # IPv4-mapped IPv6
    ipaddress.ip_network("::ffff:0:0/96"),
]

# Cloud metadata endpoints that should be blocked
BLOCKED_HOSTS = [
    "169.254.169.254",  # AWS/GCP/Azure metadata
    "metadata.google.internal",  # GCP metadata
    "metadata.gcp.internal",  # GCP metadata
]


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


def _is_ip_blocked(ip_str: str) -> bool:
    """Check if an IP address is in a blocked range."""
    try:
        ip = ipaddress.ip_address(ip_str)
        for network in BLOCKED_IP_NETWORKS:
            if ip in network:
                return True
        return False
    except ValueError:
        # Invalid IP address format
        return True


def _is_host_blocked(hostname: str) -> bool:
    """
    Check if a hostname resolves to a blocked IP address.
    Performs DNS resolution and validates all resolved IPs.
    """
    # Check against blocked hostnames
    hostname_lower = hostname.lower()
    for blocked_host in BLOCKED_HOSTS:
        if hostname_lower == blocked_host or hostname_lower.endswith(
            "." + blocked_host
        ):
            logger.warning(f"Blocked request to known internal hostname: {hostname}")
            return True

    # Try to resolve the hostname
    try:
        # Get all IP addresses for the hostname
        addr_info = socket.getaddrinfo(
            hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM
        )

        for family, type_, proto, canonname, sockaddr in addr_info:
            ip_str = sockaddr[0]
            if _is_ip_blocked(ip_str):
                logger.warning(
                    f"Blocked request to internal IP: {hostname} -> {ip_str}"
                )
                return True

        return False
    except socket.gaierror as e:
        # DNS resolution failed
        logger.warning(f"DNS resolution failed for {hostname}: {e}")
        return True
    except Exception as e:
        logger.warning(f"Error checking host {hostname}: {e}")
        return True


def _validate_url_for_ssrf(url: str) -> bool:
    """
    Validate a URL for SSRF protection.
    Returns True if the URL is safe to fetch, False otherwise.
    """
    try:
        parsed = urlparse(url)

        # Only allow http and https schemes
        if parsed.scheme not in ("http", "https"):
            logger.warning(f"Blocked URL with invalid scheme: {url}")
            return False

        # Get hostname
        hostname = parsed.hostname
        if not hostname:
            logger.warning(f"Blocked URL with no hostname: {url}")
            return False

        # Check if hostname is an IP address
        try:
            ip = ipaddress.ip_address(hostname)
            if _is_ip_blocked(str(ip)):
                logger.warning(f"Blocked URL with internal IP: {url}")
                return False
        except ValueError:
            # Not an IP address, it's a hostname - resolve it
            if _is_host_blocked(hostname):
                return False

        return True
    except Exception as e:
        logger.warning(f"Error validating URL {url}: {e}")
        return False


def _extract_meta_content(
    html: str, property_name: str, attr: str = "property"
) -> Optional[str]:
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
    # Validate URL for SSRF protection
    if not _validate_url_for_ssrf(url):
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

    # Log SSL verification status if disabled
    if not URL_METADATA_SSL_VERIFY:
        logger.warning(f"SSL verification disabled for URL metadata fetch: {url}")

    # Fetch the URL
    try:
        async with httpx.AsyncClient(
            timeout=URL_FETCH_TIMEOUT,
            follow_redirects=True,
            verify=URL_METADATA_SSL_VERIFY,
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
                # Re-validate the final URL after redirects for SSRF protection
                final_url = str(response.url)
                if final_url != url and not _validate_url_for_ssrf(final_url):
                    logger.warning(
                        f"Blocked redirect to internal URL: {url} -> {final_url}"
                    )
                    return UrlMetadataResult(url=url, success=False)

                # Check content type
                content_type = response.headers.get("content-type", "")
                if (
                    "text/html" not in content_type
                    and "application/xhtml" not in content_type
                ):
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
