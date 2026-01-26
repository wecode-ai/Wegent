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
- Proxy support with direct and fallback modes
- PDF file extraction support
"""

import io
import logging
from datetime import datetime
from typing import Optional, Tuple
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field

from app.core.config import settings
from app.services.url_metadata import _validate_url_for_ssrf

logger = logging.getLogger(__name__)

# Request timeout (20 seconds - use domcontentloaded instead of networkidle for faster response)
WEB_SCRAPER_TIMEOUT = 20000  # milliseconds for Crawl4AI
# Timeout for PDF download (seconds)
PDF_DOWNLOAD_TIMEOUT = 60


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


def _is_pdf_content_type(content_type: Optional[str]) -> bool:
    """Check if Content-Type indicates a PDF file.

    Args:
        content_type: Content-Type header value

    Returns:
        True if Content-Type indicates PDF
    """
    if not content_type:
        return False
    return "application/pdf" in content_type.lower()


def _get_content_type_from_headers(headers: Optional[dict]) -> Optional[str]:
    """Extract Content-Type from response headers (case-insensitive).

    Args:
        headers: Response headers dictionary

    Returns:
        Content-Type value or None
    """
    if not headers:
        return None
    # Headers may have different cases
    for key, value in headers.items():
        if key.lower() == "content-type":
            return value
    return None


class WebScraperService:
    """Service for scraping web pages using Crawl4AI.

    This service uses Crawl4AI with Playwright for JavaScript rendering,
    making it suitable for modern web applications like GitHub, SPAs, etc.

    Features:
    - JavaScript rendering for dynamic content
    - LLM-optimized markdown output
    - Automatic content extraction
    - SSRF protection
    - PDF file extraction support

    Example:
        ```python
        service = WebScraperService()
        result = await service.scrape_url("https://github.com/user/repo")
        print(result.content)  # Markdown content with README, etc.

        # PDF files are also supported
        result = await service.scrape_url("https://example.com/report.pdf")
        print(result.content)  # Extracted text from PDF
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
            crawler = await self._get_crawler()

            # Crawl with proxy strategy, returns (result, effective_proxy_url)
            result, effective_proxy = await self._crawl_with_strategy(crawler, url)

            if not result.success:
                error_msg = result.error_message or "Unknown error during scraping"
                return self._error_result(url, ERROR_FETCH_FAILED, error_msg)

            markdown = result.markdown or ""

            # Check if content is empty and Content-Type is PDF
            # If so, download and parse PDF using PyPDF2
            if not markdown or len(markdown.strip()) < 50:
                content_type = _get_content_type_from_headers(result.response_headers)
                if _is_pdf_content_type(content_type):
                    logger.info(
                        f"Detected PDF content type for {url}, "
                        "extracting text using PyPDF2"
                    )
                    pdf_result = await self._extract_pdf_content(url, effective_proxy)
                    if pdf_result:
                        markdown = pdf_result

            return self._process_result(result, url, markdown)

        except TimeoutError:
            return self._error_result(url, ERROR_FETCH_TIMEOUT, "Request timed out")
        except Exception as e:
            logger.error(f"Crawl4AI scraping failed for {url}: {e}")
            return self._error_result(
                url, ERROR_FETCH_FAILED, f"Failed to scrape page: {str(e)}"
            )

    def _process_result(
        self, result, original_url: str, markdown: str
    ) -> ScrapedContent:
        """Process crawl result and return ScrapedContent.

        Args:
            result: CrawlResult from crawler
            original_url: Original URL requested
            markdown: Extracted markdown content

        Returns:
            ScrapedContent with processed data
        """
        if not result.success:
            error_msg = result.error_message or "Unknown error during scraping"
            return self._error_result(original_url, ERROR_FETCH_FAILED, error_msg)

        title = result.metadata.get("title", "") if result.metadata else ""
        description = result.metadata.get("description", "") if result.metadata else ""
        final_url = str(result.url) if result.url else original_url

        # SSRF check on final URL (after redirects)
        if final_url != original_url and not _validate_url_for_ssrf(final_url):
            return self._error_result(
                original_url,
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

    async def _crawl_with_strategy(self, crawler, url: str) -> Tuple:
        """Crawl URL using configured proxy strategy.

        Args:
            crawler: AsyncWebCrawler instance
            url: URL to crawl

        Returns:
            Tuple of (CrawlResult, effective_proxy_url)
            effective_proxy_url is the proxy that was actually used (None if direct)
        """
        proxy_url = settings.WEBSCRAPER_PROXY
        proxy_mode = settings.WEBSCRAPER_PROXY_MODE

        if proxy_mode == "direct" and proxy_url:
            # Direct mode: always use proxy
            result = await self._crawl_single(crawler, url, proxy_url=proxy_url)
            return result, proxy_url
        elif proxy_mode == "fallback" and proxy_url:
            # Fallback mode: try direct first, then proxy
            return await self._crawl_with_fallback(crawler, url, proxy_url)
        else:
            # No proxy configured
            result = await self._crawl_single(crawler, url)
            return result, None

    async def _crawl_single(
        self,
        crawler,
        url: str,
        proxy_url: Optional[str] = None,
    ):
        """Single crawl operation with specified configuration.

        Args:
            crawler: AsyncWebCrawler instance
            url: URL to crawl
            proxy_url: Optional proxy URL

        Returns:
            CrawlResult from crawler
        """
        logger.info(f"Crawling {url} (proxy: {proxy_url or 'none'})")
        run_config = self._build_run_config(proxy_config=proxy_url)
        return await crawler.arun(url=url, config=run_config)

    def _build_run_config(self, proxy_config: Optional[str] = None):
        """Build CrawlerRunConfig with optional proxy.

        Args:
            proxy_config: Proxy URL string (e.g., "http://proxy:8080")

        Returns:
            CrawlerRunConfig instance
        """
        from crawl4ai import CrawlerRunConfig

        # Configure the crawl run
        # Use domcontentloaded instead of networkidle to avoid timeout on sites
        # with persistent network activity (GitHub, SPAs with WebSocket, etc.)
        # Disable remove_overlay_elements to avoid "Execution context was destroyed"
        # errors on sites with navigation/redirects (e.g., Weibo)
        config_kwargs = {
            "wait_until": "domcontentloaded",  # Faster than networkidle, avoids timeout
            "page_timeout": WEB_SCRAPER_TIMEOUT,
            "remove_overlay_elements": False,  # Disabled to avoid navigation conflicts
        }

        if proxy_config:
            config_kwargs["proxy_config"] = proxy_config
            logger.debug(f"Using proxy: {proxy_config}")

        return CrawlerRunConfig(**config_kwargs)

    async def _crawl_with_fallback(self, crawler, url: str, proxy_url: str) -> Tuple:
        """Crawl URL with fallback strategy: try direct first, then proxy.

        Args:
            crawler: AsyncWebCrawler instance
            url: URL to crawl
            proxy_url: Proxy URL string for fallback

        Returns:
            Tuple of (CrawlResult, effective_proxy_url)
        """
        # First try direct connection
        logger.info(f"Crawling {url} - trying direct connection first")
        try:
            result = await self._crawl_single(crawler, url)
            if result.success:
                logger.debug(f"Direct connection succeeded for {url}")
                return result, None
            else:
                logger.debug(
                    f"Direct connection failed for {url}: {result.error_message}, "
                    "falling back to proxy"
                )
        except Exception as e:
            logger.debug(
                f"Direct connection exception for {url}: {e}, falling back to proxy"
            )

        # Fallback to proxy
        logger.info(f"Using proxy fallback for {url}")
        result = await self._crawl_single(crawler, url, proxy_url=proxy_url)
        return result, proxy_url

    async def _extract_pdf_content(
        self, url: str, proxy_url: Optional[str] = None
    ) -> Optional[str]:
        """Download and extract text content from a PDF file.

        Args:
            url: URL of the PDF file
            proxy_url: Optional proxy URL to use for download

        Returns:
            Extracted text content as markdown, or None if extraction failed
        """
        try:
            from PyPDF2 import PdfReader

            # Configure httpx client with optional proxy
            transport = None
            if proxy_url:
                transport = httpx.AsyncHTTPTransport(proxy=proxy_url)
                logger.debug(f"Using proxy for PDF download: {proxy_url}")

            async with httpx.AsyncClient(
                timeout=PDF_DOWNLOAD_TIMEOUT,
                transport=transport,
                follow_redirects=True,
            ) as client:
                logger.info(f"Downloading PDF from {url}")
                response = await client.get(url)
                response.raise_for_status()

                # Parse PDF content
                pdf_bytes = io.BytesIO(response.content)
                reader = PdfReader(pdf_bytes)

                # Extract text from all pages
                text_parts = []
                for i, page in enumerate(reader.pages):
                    page_text = page.extract_text()
                    if page_text:
                        text_parts.append(f"## Page {i + 1}\n\n{page_text}")

                if text_parts:
                    markdown = "\n\n".join(text_parts)
                    logger.info(
                        f"Successfully extracted {len(text_parts)} pages "
                        f"({len(markdown)} chars) from PDF"
                    )
                    return markdown
                else:
                    logger.warning(f"No text content extracted from PDF: {url}")
                    return None

        except ImportError:
            logger.error("PyPDF2 not installed, cannot extract PDF content")
            return None
        except httpx.TimeoutException:
            logger.error(f"Timeout downloading PDF from {url}")
            return None
        except Exception as e:
            logger.error(f"Failed to extract PDF content from {url}: {e}")
            return None

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
