# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Web scraper service constants and site-specific configurations.
"""

import json
import logging
from functools import lru_cache
from typing import Any, Dict

from app.core.config import settings

logger = logging.getLogger(__name__)

# ========== Web Scraper Site-Specific Configuration ==========
# Configuration for specific sites that require special handling
# due to anti-bot detection, dynamic content loading, or navigation patterns
# Loaded from settings.WEB_SCRAPER_SITE_CONFIG


def _load_site_config() -> Dict[str, Any]:
    """Load site configuration from settings.

    This function is called at runtime to ensure settings
    are properly loaded (they may not be available at module import time).

    Returns:
        Normalized site configuration dict
    """
    # Get config from settings - this reads from environment variables
    # and is properly parsed by Pydantic settings
    try:
        config_value = settings.WEB_SCRAPER_SITE_CONFIG

        if not config_value:
            logger.warning(
                "[WebScraperConfig] WEB_SCRAPER_SITE_CONFIG is empty in settings"
            )
            return {}

        # Parse the JSON string
        if isinstance(config_value, str):
            config = json.loads(config_value)
        else:
            config = config_value

        logger.info(
            f"[WebScraperConfig] Parsed config from settings, keys: {list(config.keys())}"
        )

        # Normalize domain keys to lowercase and sort by length descending
        # to prefer longest matches (e.g., "api.github.com" before "github.com")
        normalized_config = dict(
            sorted(
                ((k.lower(), v) for k, v in config.items()),
                key=lambda item: len(item[0]),
                reverse=True,
            )
        )
        logger.info(
            f"[WebScraperConfig] Normalized config keys: {list(normalized_config.keys())}"
        )
        return normalized_config

    except json.JSONDecodeError as e:
        logger.error(f"[WebScraperConfig] Failed to parse WEB_SCRAPER_SITE_CONFIG: {e}")
        return {}
    except (AttributeError, KeyError, TypeError, ValueError) as e:
        logger.error(
            f"[WebScraperConfig] Error loading WEB_SCRAPER_SITE_CONFIG from settings: {e}"
        )
        return {}


@lru_cache(maxsize=1)
def get_site_config() -> Dict[str, Any]:
    """Get site configuration with caching.

    Uses LRU cache to avoid re-parsing config on every request,
    but can be refreshed by clearing the cache if needed.
    """
    return _load_site_config()
