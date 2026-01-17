# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Web scraper service using Crawl4AI for fetching and converting web pages to markdown.

Uses Crawl4AI library which provides:
- JavaScript rendering via Playwright for dynamic content (GitHub, SPAs, etc.)
- LLM-optimized markdown output
- Automatic content extraction
- SSRF protection
"""

import logging
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from pydantic import BaseModel, Field

from app.services.url_metadata import _validate_url_for_ssrf

logger = logging.getLogger(__name__)

# Request timeout (10 seconds - use domcontentloaded instead of networkidle for faster response)
WEB_SCRAPER_TIMEOUT = 10000  # milliseconds for Crawl4AI


class ScrapedContent(BaseModel):
    """Scraped web page content result."""

    title: Optional[str] = Field(None, description="Page title")
    content: str = Field(..., description="Markdown content")
    url: str = Field(..., description="Source URL")
    scraped_at: datetime = Field(
        default_factory=datetime.utcnow, description="Scrape timestamp"
    )
    content_length: int = Field(0, description="Content length in characters")
    description: Optional[str] = Field(None, description="Page description")
    success: bool = Field(True, description="Whether scraping succeeded")
    error_code: Optional[str] = Field(None, description="Error code if failed")
    error_message: Optional[str] = Field(None, description="Error message if failed")


class ScrapeError(BaseModel):
    """Error response for scrape failures."""

    success: bool = False
    error_code: str
    error_message: str
    url: str


# Error codes
ERROR_INVALID_URL = "INVALID_URL_FORMAT"
ERROR_FETCH_FAILED = "FETCH_FAILED"
ERROR_FETCH_TIMEOUT = "FETCH_TIMEOUT"
ERROR_PARSE_FAILED = "PARSE_FAILED"
ERROR_EMPTY_CONTENT = "EMPTY_CONTENT"
ERROR_AUTH_REQUIRED = "AUTH_REQUIRED"
ERROR_SSRF_BLOCKED = "SSRF_BLOCKED"
ERROR_CRAWL4AI_NOT_INSTALLED = "CRAWL4AI_NOT_INSTALLED"


class WebScraperService:
    """Service for scraping web pages using Crawl4AI.

    This service uses Crawl4AI with Playwright for JavaScript rendering,
    making it suitable for modern web applications like GitHub, SPAs, etc.

    Features:
    - JavaScript rendering for dynamic content
    - LLM-optimized markdown output
    - Automatic content extraction
    - SSRF protection

    Example:
        ```python
        service = WebScraperService()
        result = await service.scrape_url("https://github.com/user/repo")
        print(result.content)  # Markdown content with README, etc.
        ```
    """

    def __init__(self):
        """Initialize the web scraper service."""
        self._crawler = None
        self._crawl4ai_available = None

    def _check_crawl4ai(self) -> bool:
        """Check if Crawl4AI is available.

        Returns:
            True if Crawl4AI is installed
        """
        if self._crawl4ai_available is None:
            try:
                import crawl4ai  # noqa: F401

                self._crawl4ai_available = True
                logger.info("Crawl4AI is available for web scraping")
            except ImportError:
                self._crawl4ai_available = False
                logger.warning(
                    "Crawl4AI not installed. Install with: "
                    "pip install 'crawl4ai[sync]' && crawl4ai-setup"
                )
        return self._crawl4ai_available

    async def _get_crawler(self):
        """Get or create the AsyncWebCrawler instance.

        Returns:
            AsyncWebCrawler instance
        """
        if self._crawler is None:
            from crawl4ai import AsyncWebCrawler, BrowserConfig

            browser_config = BrowserConfig(
                headless=True,
                browser_type="chromium",
            )
            self._crawler = AsyncWebCrawler(config=browser_config)
            await self._crawler.start()
        return self._crawler

    async def scrape_url(self, url: str) -> ScrapedContent:
        """Scrape a web page and convert to Markdown using Crawl4AI.

        Args:
            url: URL to scrape

        Returns:
            ScrapedContent with title, markdown content, and metadata
        """
        # Validate URL format
        try:
            parsed = urlparse(url)
            if not parsed.scheme or not parsed.netloc:
                return self._error_result(url, ERROR_INVALID_URL, "Invalid URL format")
        except Exception:
            return self._error_result(url, ERROR_INVALID_URL, "Invalid URL format")

        # SSRF protection
        if not _validate_url_for_ssrf(url):
            return self._error_result(
                url,
                ERROR_SSRF_BLOCKED,
                "URL blocked by security policy (private/internal address)",
            )

        # Check if Crawl4AI is available
        if not self._check_crawl4ai():
            return self._error_result(
                url,
                ERROR_CRAWL4AI_NOT_INSTALLED,
                "Crawl4AI not installed. Install with: "
                "pip install 'crawl4ai[sync]' && crawl4ai-setup",
            )

        try:
            from crawl4ai import CrawlerRunConfig

            crawler = await self._get_crawler()

            # Configure the crawl run
            # Use domcontentloaded instead of networkidle to avoid timeout on sites
            # with persistent network activity (GitHub, SPAs with WebSocket, etc.)
            # Disable remove_overlay_elements to avoid "Execution context was destroyed"
            # errors on sites with navigation/redirects (e.g., Weibo)
            run_config = CrawlerRunConfig(
                wait_until="domcontentloaded",  # Faster than networkidle, avoids timeout
                page_timeout=WEB_SCRAPER_TIMEOUT,
                remove_overlay_elements=False,  # Disabled to avoid navigation conflicts
            )

            # Run the crawler
            result = await crawler.arun(url=url, config=run_config)

            if result.success:
                markdown = result.markdown or ""
                title = result.metadata.get("title", "") if result.metadata else ""
                description = (
                    result.metadata.get("description", "") if result.metadata else ""
                )
                final_url = str(result.url) if result.url else url

                # SSRF check on final URL (after redirects)
                if final_url != url and not _validate_url_for_ssrf(final_url):
                    return self._error_result(
                        url,
                        ERROR_SSRF_BLOCKED,
                        f"Redirect blocked by security policy: {final_url}",
                    )

                # Check for empty content
                if not markdown or len(markdown.strip()) < 50:
                    return self._error_result(
                        final_url,
                        ERROR_EMPTY_CONTENT,
                        "No extractable content found on the page",
                    )

                return ScrapedContent(
                    title=title or None,
                    content=markdown,
                    url=final_url,
                    scraped_at=datetime.utcnow(),
                    content_length=len(markdown),
                    description=description or None,
                    success=True,
                )
            else:
                error_msg = result.error_message or "Unknown error during scraping"
                return self._error_result(url, ERROR_FETCH_FAILED, error_msg)

        except TimeoutError:
            return self._error_result(url, ERROR_FETCH_TIMEOUT, "Request timed out")
        except Exception as e:
            logger.error(f"Crawl4AI scraping failed for {url}: {e}")
            return self._error_result(
                url, ERROR_FETCH_FAILED, f"Failed to scrape page: {str(e)}"
            )

    def _error_result(
        self, url: str, error_code: str, error_message: str
    ) -> ScrapedContent:
        """Create an error result.

        Args:
            url: Source URL
            error_code: Error code
            error_message: Error message

        Returns:
            ScrapedContent with error information
        """
        return ScrapedContent(
            title=None,
            content="",
            url=url,
            scraped_at=datetime.utcnow(),
            content_length=0,
            success=False,
            error_code=error_code,
            error_message=error_message,
        )

    async def close(self):
        """Close the crawler and release resources."""
        if self._crawler is not None:
            await self._crawler.close()
            self._crawler = None


# Global service instance
_service: Optional[WebScraperService] = None


def get_web_scraper_service() -> WebScraperService:
    """Get the global web scraper service instance.

    Returns:
        WebScraperService instance
    """
    global _service
    if _service is None:
        _service = WebScraperService()
    return _service
