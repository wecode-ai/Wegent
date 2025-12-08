# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory for creating search service instances based on configuration.
"""

import logging
from typing import Optional

from app.core.config import settings
from .base import SearchServiceBase
from .duckduckgo import DuckDuckGoSearchService

logger = logging.getLogger(__name__)


def get_search_service() -> Optional[SearchServiceBase]:
    """
    Get the configured search service instance.

    Returns:
        SearchServiceBase instance or None if search is disabled

    Configuration:
        WEB_SEARCH_ENABLED: Enable/disable web search (default: False)
        WEB_SEARCH_PROVIDER: Search provider to use (default: "duckduckgo")
        WEB_SEARCH_MAX_RESULTS: Default max results (default: 5)
    """
    if not getattr(settings, "WEB_SEARCH_ENABLED", False):
        logger.info("Web search is disabled")
        return None

    provider = getattr(settings, "WEB_SEARCH_PROVIDER", "duckduckgo").lower()

    if provider == "duckduckgo":
        logger.info("Using DuckDuckGo search service")
        return DuckDuckGoSearchService()
    # Add more providers here in the future:
    # elif provider == "google":
    #     return GoogleSearchService()
    # elif provider == "bing":
    #     return BingSearchService()
    else:
        logger.warning(
            f"Unknown search provider '{provider}', defaulting to DuckDuckGo"
        )
        return DuckDuckGoSearchService()


# Global search service instance (lazy initialization)
_search_service: Optional[SearchServiceBase] = None


def get_global_search_service() -> Optional[SearchServiceBase]:
    """
    Get or create the global search service instance.

    Returns:
        SearchServiceBase instance or None if search is disabled
    """
    global _search_service
    if _search_service is None:
        _search_service = get_search_service()
    return _search_service
