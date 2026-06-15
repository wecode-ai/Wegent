# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Site-specific web scraper policy resolution."""

import logging
from typing import Any, Optional
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field

from app.services.web_scraper.scraper_config import get_site_config

logger = logging.getLogger(__name__)

DEFAULT_PROFILE = "desktop_chrome_cn"
DEFAULT_WAIT_UNTIL = "domcontentloaded"
DEFAULT_DELAY_BEFORE_RETURN_HTML = 0.1
DEFAULT_PAGE_TIMEOUT_MS = 20000
DEFAULT_TOTAL_TIMEOUT_SECONDS = 35
DEFAULT_MIN_MARKDOWN_CHARS = 50
DEFAULT_MIN_CONTENT_DENSITY = 0.2
DEFAULT_MAX_FRAMES = 20
DEFAULT_MAX_CHARS_PER_FRAME = 50000
DEFAULT_MAX_TOTAL_CHARS = 200000


class ScrapePolicy(BaseModel):
    """Typed scrape policy resolved from site configuration."""

    model_config = ConfigDict(extra="forbid")

    profile: str = DEFAULT_PROFILE
    wait_until: str = DEFAULT_WAIT_UNTIL
    wait_for: Optional[str] = None
    delay_before_return_html: float = Field(
        default=DEFAULT_DELAY_BEFORE_RETURN_HTML,
        ge=0,
    )
    page_timeout_ms: int = Field(default=DEFAULT_PAGE_TIMEOUT_MS, gt=0)
    total_timeout_seconds: int = Field(default=DEFAULT_TOTAL_TIMEOUT_SECONDS, gt=0)

    process_iframes: bool = True
    deep_iframe_extraction: bool = False
    scroll_main_page: bool = False
    scroll_frames: bool = False

    fallback_enabled: bool = True
    fallback_on_empty: bool = True
    fallback_on_blocked: bool = True

    prefer_html_markdown: bool = True
    allow_text_degraded: bool = True
    min_markdown_chars: int = Field(default=DEFAULT_MIN_MARKDOWN_CHARS, ge=0)
    min_content_density: float = Field(
        default=DEFAULT_MIN_CONTENT_DENSITY,
        ge=0,
        le=1,
    )

    max_frames: int = Field(default=DEFAULT_MAX_FRAMES, ge=0)
    max_chars_per_frame: int = Field(default=DEFAULT_MAX_CHARS_PER_FRAME, gt=0)
    max_total_chars: int = Field(default=DEFAULT_MAX_TOTAL_CHARS, gt=0)


class SitePolicyResolver:
    """Resolve the most specific site policy for a URL."""

    def __init__(self, site_configs: Optional[dict[str, Any]] = None) -> None:
        self._site_configs = site_configs

    def resolve(self, url: str) -> ScrapePolicy:
        """Resolve a typed policy for the target URL."""
        raw_config = self._match_site_config(url)
        if not raw_config:
            return ScrapePolicy()

        if not isinstance(raw_config, dict):
            logger.warning(
                "[WebScraperPolicy] Ignoring non-object site config: %r", raw_config
            )
            return ScrapePolicy()

        allowed_fields = set(ScrapePolicy.model_fields)
        allowed_config = {}
        for key, value in raw_config.items():
            if key in allowed_fields:
                allowed_config[key] = value
            else:
                logger.warning(
                    "[WebScraperPolicy] Ignoring unknown site config field: %s", key
                )

        try:
            return ScrapePolicy(**allowed_config)
        except ValueError as exc:
            logger.warning("[WebScraperPolicy] Invalid site config ignored: %s", exc)
            return ScrapePolicy()

    def _match_site_config(self, url: str) -> Optional[dict[str, Any]]:
        site_configs = self._site_configs
        if site_configs is None:
            site_configs = get_site_config()

        hostname = (urlparse(url).hostname or "").lower()
        if not hostname:
            return None

        sorted_items = sorted(
            site_configs.items(), key=lambda item: len(str(item[0])), reverse=True
        )
        for domain, site_config in sorted_items:
            normalized_domain = str(domain).lower()
            if hostname == normalized_domain or hostname.endswith(
                f".{normalized_domain}"
            ):
                return site_config

        return None
