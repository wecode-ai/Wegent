# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web scraper service for fetching and converting web pages to markdown."""

from app.services.web_scraper.scraper_service import (
    ScrapedContent,
    WebScraperService,
    get_web_scraper_service,
)

__all__ = [
    "WebScraperService",
    "ScrapedContent",
    "get_web_scraper_service",
]
