# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory for creating search service instances based on configuration.
"""

import json
import logging

from app.core.config import settings
from .base import SearchServiceBase
from .http_search import HttpSearchService

logger = logging.getLogger(__name__)


def get_search_service() -> SearchServiceBase | None:
    """
    Get the configured search service instance.

    Returns:
        SearchServiceBase instance or None if search is disabled

    Configuration:
        WEB_SEARCH_ENABLED: Enable/disable web search (default: False)
        WEB_SEARCH_BASE_URL: API endpoint URL
        WEB_SEARCH_CONFIG: JSON string with search API configuration

    Example WEB_SEARCH_CONFIG for DuckDuckGo-compatible API:
    {
        "query_param": "q",
        "limit_param": "max_results",
        "auth_header": {},
        "extra_params": {"format": "json"},
        "response_path": "RelatedTopics",
        "title_field": "Text",
        "url_field": "FirstURL",
        "snippet_field": "Text"
    }

    Example for SearXNG:
    {
        "query_param": "q",
        "limit_param": "limit",
        "extra_params": {"format": "json"},
        "response_path": "results",
        "title_field": "title",
        "url_field": "url",
        "snippet_field": "content"
    }
    """
    if not getattr(settings, "WEB_SEARCH_ENABLED", False):
        logger.info("Web search is disabled")
        return None

    base_url = getattr(settings, "WEB_SEARCH_BASE_URL", "")
    if not base_url:
        logger.error("WEB_SEARCH_BASE_URL is required when web search is enabled")
        return None

    # Parse search configuration
    config_str = getattr(settings, "WEB_SEARCH_CONFIG", "{}")
    try:
        config = json.loads(config_str) if config_str else {}
    except json.JSONDecodeError:
        logger.exception("Failed to parse WEB_SEARCH_CONFIG")
        return None

    # Extract configuration with defaults
    query_param = config.get("query_param", "q")
    limit_param = config.get("limit_param", "limit")
    auth_header = config.get("auth_header", {})
    extra_params = config.get("extra_params", {})
    response_path = config.get("response_path")
    title_field = config.get("title_field", "title")
    url_field = config.get("url_field", "url")
    snippet_field = config.get("snippet_field", "snippet")
    content_field = config.get("content_field", "main_content")
    timeout = config.get("timeout", 10)

    logger.info("Initializing HTTP search service with base_url=%s", base_url)

    return HttpSearchService(
        base_url=base_url,
        query_param=query_param,
        limit_param=limit_param,
        auth_header=auth_header,
        extra_params=extra_params,
        response_path=response_path,
        title_field=title_field,
        url_field=url_field,
        snippet_field=snippet_field,
        content_field=content_field,
        timeout=timeout,
    )


# Global search service instance (lazy initialization)
_search_service: SearchServiceBase | None = None


def get_global_search_service() -> SearchServiceBase | None:
    """
    Get or create the global search service instance.

    Returns:
        SearchServiceBase instance or None if search is disabled
    """
    global _search_service
    if _search_service is None:
        _search_service = get_search_service()
    return _search_service
