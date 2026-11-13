# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Route Crawl4AI diagnostics through the application's safe logging boundary."""

import logging
from typing import Any

from crawl4ai.async_logger import AsyncLogger, LogLevel

from app.services.web_scraper.security import (
    redact_scraper_text,
    redact_url_for_logging,
)

logger = logging.getLogger(__name__)

_LEVELS = {
    LogLevel.DEFAULT: logging.INFO,
    LogLevel.DEBUG: logging.DEBUG,
    LogLevel.INFO: logging.INFO,
    LogLevel.SUCCESS: logging.INFO,
    LogLevel.WARNING: logging.WARNING,
    LogLevel.ERROR: logging.ERROR,
    LogLevel.CRITICAL: logging.CRITICAL,
    LogLevel.ALERT: logging.ERROR,
    LogLevel.NOTICE: logging.INFO,
    LogLevel.EXCEPTION: logging.ERROR,
    LogLevel.FATAL: logging.CRITICAL,
}


class RedactingCrawlerLogger(AsyncLogger):
    """Sanitize diagnostics before any console or file handler receives them."""

    def __init__(self) -> None:
        # The application owns the sinks; never create the SDK's crawler.log.
        super().__init__(log_file=None)

    def _log(
        self,
        level: LogLevel,
        message: str,
        tag: str,
        params: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        if level.value < self.log_level.value:
            return
        formatted = message.format(**params) if params else message
        logger.log(
            _LEVELS[level],
            "[%s] %s",
            redact_scraper_text(tag),
            redact_scraper_text(formatted),
        )

    def url_status(
        self,
        url: str,
        success: bool,
        timing: float,
        tag: str = "FETCH",
        url_length: int = 100,
    ) -> None:
        # Sanitize before the SDK decodes or truncates a URL into fragments.
        super().url_status(
            redact_url_for_logging(url), success, timing, tag, url_length
        )

    def error_status(
        self,
        url: str,
        error: str,
        tag: str = "ERROR",
        url_length: int = 50,
    ) -> None:
        super().error_status(
            redact_url_for_logging(url), redact_scraper_text(error), tag, url_length
        )
