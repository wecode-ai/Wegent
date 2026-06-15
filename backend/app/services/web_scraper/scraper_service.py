# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web scraper service for fetching and converting web pages to markdown."""

import asyncio
import logging
from datetime import datetime
from typing import Any, Optional
from urllib.parse import urlparse

from pydantic import BaseModel, Field

from app.core.config import settings
from app.services.web_scraper.classifier import ScrapeResultClassifier
from app.services.web_scraper.models import (
    ERROR_AUTH_REQUIRED,
    ERROR_CRAWL4AI_NOT_INSTALLED,
    ERROR_EMPTY_CONTENT,
    ERROR_FETCH_BLOCKED,
    ERROR_FETCH_FAILED,
    ERROR_FETCH_TIMEOUT,
    ERROR_INVALID_URL,
    ERROR_PARSE_FAILED,
    ERROR_RATE_LIMITED,
    ERROR_SSRF_BLOCKED,
    InternalScrapeResult,
    MarkdownQuality,
    ScrapeDecision,
    ScrapeStatus,
)
from app.services.web_scraper.pdf_extractor import PdfExtractor
from app.services.web_scraper.policy import (
    DEFAULT_TOTAL_TIMEOUT_SECONDS,
    ScrapePolicy,
    SitePolicyResolver,
)
from app.services.web_scraper.profiles import BrowserProfileFactory
from app.services.web_scraper.proxy import ProxyPlan, ProxyResolver
from app.services.web_scraper.quality import MarkdownQualityEvaluator
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
    redact_url_for_logging,
)
from app.services.web_scraper.strategies.crawl4ai_strategy import Crawl4AIScrapeStrategy
from app.services.web_scraper.strategies.playwright_frame_strategy import (
    PlaywrightFrameExtractionStrategy,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

__all__ = [
    "ERROR_AUTH_REQUIRED",
    "ERROR_CRAWL4AI_NOT_INSTALLED",
    "ERROR_EMPTY_CONTENT",
    "ERROR_FETCH_BLOCKED",
    "ERROR_FETCH_FAILED",
    "ERROR_FETCH_TIMEOUT",
    "ERROR_INVALID_URL",
    "ERROR_PARSE_FAILED",
    "ERROR_RATE_LIMITED",
    "ERROR_SSRF_BLOCKED",
    "ScrapedContent",
    "ScrapeError",
    "WebScraperService",
    "get_web_scraper_service",
]


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


class WebScraperService:
    """Service for scraping web pages."""

    def __init__(self) -> None:
        """Initialize the web scraper service."""
        self._crawler = None
        self._crawler_lock = asyncio.Lock()
        self._crawl4ai_available = None
        self._guard = WebScraperUrlGuard()
        self._policy_resolver = SitePolicyResolver()
        self._profile_factory = BrowserProfileFactory()
        self._proxy_resolver = ProxyResolver()
        self._classifier = ScrapeResultClassifier()
        self._quality_evaluator = MarkdownQualityEvaluator()
        self._pdf_extractor = PdfExtractor()
        self._playwright_strategy = PlaywrightFrameExtractionStrategy(
            quality_evaluator=self._quality_evaluator
        )
        self._crawl4ai_strategy = Crawl4AIScrapeStrategy(
            self._get_crawler,
            self._classifier,
            self._quality_evaluator,
        )

    def _check_crawl4ai(self) -> bool:
        """Check if Crawl4AI is available."""
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

    async def _get_crawler(self) -> Any:
        """Get or create the AsyncWebCrawler instance."""
        if self._crawler is not None:
            return self._crawler

        async with self._crawler_lock:
            if self._crawler is not None:
                return self._crawler

            from crawl4ai import AsyncWebCrawler, BrowserConfig

            browser_config = BrowserConfig(
                headless=True,
                browser_type="chromium",
                user_agent_mode="random",
                use_managed_browser=True,
                extra_args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            crawler = AsyncWebCrawler(config=browser_config)
            try:
                await crawler.start()
            except Exception:
                close = getattr(crawler, "close", None)
                if close is not None:
                    close_result = close()
                    if asyncio.iscoroutine(close_result):
                        await close_result
                raise

            self._crawler = crawler
        return self._crawler

    @trace_async(
        span_name="web_scraper.scrape_url",
        tracer_name="web_scraper",
        extract_attributes=lambda self, url: {"url": redact_url_for_logging(url)},
    )
    async def scrape_url(self, url: str) -> ScrapedContent:
        """Scrape a web page and convert to Markdown."""
        try:
            return await asyncio.wait_for(
                self._scrape_url_impl(url),
                timeout=self._resolve_total_timeout(url),
            )
        except asyncio.TimeoutError:
            return self._error_result(url, ERROR_FETCH_TIMEOUT, "Request timed out")
        except WebScraperSecurityError as exc:
            return self._error_result(url, exc.error_code, exc.message)
        except Exception as exc:
            logger.exception("Web scraping failed for %s", redact_url_for_logging(url))
            return self._error_result(
                url, ERROR_FETCH_FAILED, f"Failed to scrape page: {str(exc)}"
            )

    async def _scrape_url_impl(self, url: str) -> ScrapedContent:
        self._guard.validate_initial_url(url)

        policy = self._policy_resolver.resolve(url)
        proxy_plan = self._proxy_resolver.resolve(
            mode=settings.WEBSCRAPER_PROXY_MODE,
            raw_url=settings.WEBSCRAPER_PROXY,
        )

        if self._is_direct_pdf_url(url):
            return await self._scrape_pdf(url, policy, proxy_plan)

        if not self._check_crawl4ai():
            return self._error_result(
                url,
                ERROR_CRAWL4AI_NOT_INSTALLED,
                "Crawl4AI not installed. Install with: "
                "pip install 'crawl4ai[sync]' && crawl4ai-setup",
            )

        profile = self._profile_factory.create(policy.profile)
        primary = await self._crawl4ai_strategy.scrape(
            url=url,
            policy=policy,
            profile=profile,
            proxy_plan=proxy_plan,
            guard=self._guard,
        )
        primary_quality = self._quality_evaluator.evaluate(
            primary.markdown, policy, primary.quality_level
        )
        primary_decision = self._classifier.classify(primary, primary_quality)

        if primary_decision.is_pdf:
            pdf_url = primary.final_url or url
            return await self._scrape_pdf(pdf_url, policy, proxy_plan)

        if primary_decision.status == ScrapeStatus.OK and primary_quality.acceptable:
            return self._build_success(primary)

        if not self._classifier.should_use_playwright_fallback(
            primary_decision, primary_quality, policy
        ):
            return self._build_result(primary, primary_decision, primary_quality)

        fallback = await self._playwright_strategy.scrape(
            url=url,
            policy=policy,
            profile=profile,
            proxy_plan=proxy_plan,
            guard=self._guard,
        )
        fallback_quality = self._quality_evaluator.evaluate(
            fallback.markdown, policy, fallback.quality_level
        )
        fallback_decision = self._classifier.classify(fallback, fallback_quality)
        return self._build_result(fallback, fallback_decision, fallback_quality)

    async def _scrape_pdf(
        self,
        pdf_url: str,
        policy: ScrapePolicy,
        proxy_plan: ProxyPlan,
    ) -> ScrapedContent:
        pdf_result = await self._pdf_extractor.extract(
            pdf_url=pdf_url,
            proxy_plan=proxy_plan,
            guard=self._guard,
        )
        pdf_quality = self._quality_evaluator.evaluate(
            pdf_result.markdown, policy, pdf_result.quality_level
        )
        pdf_decision = self._classifier.classify(pdf_result, pdf_quality)
        return self._build_result(pdf_result, pdf_decision, pdf_quality)

    def _is_direct_pdf_url(self, url: str) -> bool:
        return urlparse(url).path.lower().endswith(".pdf")

    def _resolve_total_timeout(self, url: str) -> int:
        try:
            return self._policy_resolver.resolve(url).total_timeout_seconds
        except (AttributeError, KeyError, ValueError) as exc:
            logger.warning(
                "Failed to resolve scrape timeout for %s; using default: %s",
                redact_url_for_logging(url),
                exc,
            )
            return DEFAULT_TOTAL_TIMEOUT_SECONDS

    def _build_success(self, result: InternalScrapeResult) -> ScrapedContent:
        final_url = result.final_url or result.url
        return ScrapedContent(
            title=result.title or None,
            content=result.markdown,
            url=final_url,
            scraped_at=datetime.utcnow(),
            content_length=len(result.markdown),
            description=result.description or None,
            success=True,
        )

    def _build_result(
        self,
        result: InternalScrapeResult,
        decision: ScrapeDecision,
        quality: MarkdownQuality,
    ) -> ScrapedContent:
        if decision.status == ScrapeStatus.OK and quality.acceptable:
            return self._build_success(result)

        return self._error_result(
            result.final_url or result.url,
            decision.error_code or ERROR_FETCH_FAILED,
            decision.error_message or result.error_message or "Failed to scrape page",
        )

    def _error_result(
        self, url: str, error_code: str, error_message: str
    ) -> ScrapedContent:
        """Create an error result."""
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

    async def close(self) -> None:
        """Close the crawler and release resources."""
        async with self._crawler_lock:
            if self._crawler is not None:
                await self._crawler.close()
                self._crawler = None


_service: Optional[WebScraperService] = None


def get_web_scraper_service() -> WebScraperService:
    """Get the global web scraper service instance."""
    global _service
    if _service is None:
        _service = WebScraperService()
    return _service
