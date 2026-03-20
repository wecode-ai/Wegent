# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executor version service with caching.

Fetches latest executor version from configured source (GitHub or Registry)
with Redis-based caching to avoid excessive API calls.
"""

import logging
from typing import Optional

from app.core.cache import cache_manager
from app.core.config import settings
from app.services.device.version_checker import (
    GithubVersionChecker,
    RegistryVersionChecker,
    VersionChecker,
)

logger = logging.getLogger(__name__)

# Cache key for executor version
EXECUTOR_VERSION_CACHE_KEY = "executor:latest_version"


class ExecutorVersionService:
    """Service for fetching and caching executor latest version."""

    def __init__(self):
        self._checker = self._create_checker()
        self._cache_ttl = settings.EXECUTOR_VERSION_CACHE_TTL

    def _create_checker(self) -> VersionChecker:
        """Create appropriate version checker based on configuration.

        Uses implicit source selection (aligned with executor design):
        - If EXECUTOR_REGISTRY_URL is set, use Registry
        - Otherwise, use GitHub (public repo, no token needed)
        """
        # Implicit source selection based on registry URL
        if settings.EXECUTOR_REGISTRY_URL:
            return RegistryVersionChecker(
                registry_url=settings.EXECUTOR_REGISTRY_URL,
                auth_token=settings.EXECUTOR_REGISTRY_TOKEN or None,
            )
        else:
            # Default: GitHub (public repo, no token needed)
            return GithubVersionChecker()

    async def get_latest_version(self) -> Optional[str]:
        """Get latest executor version with caching.

        Returns:
            Latest version string (e.g., "1.6.6") or None if fetch fails
        """
        # Try to get from cache first
        cached = await cache_manager.get(EXECUTOR_VERSION_CACHE_KEY)
        if cached:
            logger.debug(f"Using cached executor version: {cached}")
            return cached

        # Fetch from remote source
        version_info = await self._checker.get_latest_version()
        if version_info:
            version = version_info.version
            # Cache the result
            await cache_manager.set(
                EXECUTOR_VERSION_CACHE_KEY,
                version,
                expire=self._cache_ttl,
            )
            logger.info(f"Fetched and cached executor version: {version}")
            return version

        logger.warning("Failed to fetch executor version from all sources")
        return None

    async def invalidate_cache(self) -> bool:
        """Invalidate the version cache.

        Returns:
            True if cache was invalidated
        """
        result = await cache_manager.delete(EXECUTOR_VERSION_CACHE_KEY)
        if result:
            logger.info("Executor version cache invalidated")
        return result


# Singleton instance
executor_version_service = ExecutorVersionService()
