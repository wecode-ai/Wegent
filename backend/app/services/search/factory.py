# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory for creating search service instances based on configuration.
"""

import json
import logging
from typing import Any

from app.core.config import settings

from .base import SearchServiceBase
from .http_search import HttpSearchService

logger = logging.getLogger(__name__)

# Cache for search service instances and config
_search_services: dict[str, SearchServiceBase] = {}
_engines_config: dict[str, Any] | None = None


def _get_engines_config() -> dict[str, Any] | None:
    """Parse and cache the engines configuration from settings."""
    global _engines_config
    if _engines_config is not None:
        logger.debug("Using cached engines configuration")
        return _engines_config

    if not getattr(settings, "WEB_SEARCH_ENABLED", False):
        logger.info("Web search is disabled")
        return None

    config_str = getattr(settings, "WEB_SEARCH_ENGINES", "")
    if not config_str:
        return None

    try:
        _engines_config = json.loads(config_str)
        logger.debug(
            "Parsed engines configuration with %d engines",
            len(_engines_config.get("engines", {})),
        )
        return _engines_config
    except json.JSONDecodeError:
        logger.exception("Failed to parse WEB_SEARCH_ENGINES configuration")
        return None


def get_search_service(engine_name: str | None = None) -> SearchServiceBase | None:
    """
    Get the configured search service instance for a specific engine.
    If engine_name is None, returns the first configured engine.
    """

    config = _get_engines_config()
    if not config or "engines" not in config:
        return None

    engines = config["engines"]

    # Select engine: requested one, or first available one
    selected_name = (
        engine_name
        if engine_name and engine_name in engines
        else next(iter(engines), None)
    )

    if not selected_name:
        return None

    # Return cached instance if available
    if selected_name in _search_services:
        return _search_services[selected_name]

    # Create new instance
    engine_config = engines[selected_name]
    base_url = engine_config.get("base_url")

    if not base_url:
        logger.error("base_url is required for search engine: %s", selected_name)
        return None

    service = HttpSearchService(
        base_url=base_url,
        max_results=engine_config.get("max_results", 10),
        query_param=engine_config.get("query_param", "q"),
        limit_param=engine_config.get("limit_param", "limit"),
        auth_header=engine_config.get("auth_header", {}),
        extra_params=engine_config.get("extra_params", {}),
        response_path=engine_config.get("response_path"),
        title_field=engine_config.get("title_field", "title"),
        url_field=engine_config.get("url_field", "url"),
        snippet_field=engine_config.get("snippet_field", "snippet"),
        content_field=engine_config.get("content_field", "main_content"),
        timeout=engine_config.get("timeout", 10),
    )

    _search_services[selected_name] = service
    logger.info("Initialized search service for engine: %s", selected_name)
    return service


def get_available_engines() -> list[dict[str, str]]:
    """Get list of available search engines."""
    config = _get_engines_config()
    if not config or "engines" not in config:
        return []
    return [
        {"name": k, "display_name": v.get("display_name", k)}
        for k, v in config["engines"].items()
    ]
