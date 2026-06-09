# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Crawl4AI-backed web scraper strategy."""

import asyncio
import logging
from typing import Any, Callable

from app.services.web_scraper.classifier import ScrapeResultClassifier
from app.services.web_scraper.models import InternalScrapeResult, ScrapeStatus
from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.profiles import BrowserProfile
from app.services.web_scraper.proxy import ProxyPlan
from app.services.web_scraper.quality import MarkdownQualityEvaluator
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


PROXY_RETRY_STATUSES = {
    ScrapeStatus.NETWORK_FAILED,
    ScrapeStatus.TIMEOUT,
    ScrapeStatus.BLOCKED,
    ScrapeStatus.EMPTY,
    ScrapeStatus.LOW_QUALITY,
}


class Crawl4AIScrapeStrategy:
    """Scrape pages through Crawl4AI."""

    def __init__(
        self,
        crawler_provider: Callable[[], Any],
        classifier: ScrapeResultClassifier,
        quality_evaluator: MarkdownQualityEvaluator,
    ) -> None:
        self._crawler_provider = crawler_provider
        self._classifier = classifier
        self._quality_evaluator = quality_evaluator

    @trace_async(
        span_name="web_scraper.crawl4ai.scrape",
        tracer_name="web_scraper",
        extract_attributes=lambda self, url, *args, **kwargs: {"url": url},
    )
    async def scrape(
        self,
        url: str,
        policy: ScrapePolicy,
        profile: BrowserProfile,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
    ) -> InternalScrapeResult:
        """Scrape a URL using the configured proxy strategy."""
        if proxy_plan.force_proxy and proxy_plan.has_proxy:
            return await self._crawl_once(
                url, policy, profile, proxy_plan.crawl4ai_proxy_config(), guard
            )

        if proxy_plan.fallback:
            direct_result = await self._crawl_once(url, policy, profile, None, guard)
            direct_quality = self._quality_evaluator.evaluate(
                direct_result.markdown, policy, direct_result.quality_level
            )
            direct_decision = self._classifier.classify(direct_result, direct_quality)
            if (
                direct_decision.status not in PROXY_RETRY_STATUSES
                or not proxy_plan.has_proxy
            ):
                return direct_result
            return await self._crawl_once(
                url, policy, profile, proxy_plan.crawl4ai_proxy_config(), guard
            )

        return await self._crawl_once(url, policy, profile, None, guard)

    @trace_async(
        span_name="web_scraper.crawl4ai.crawl_once",
        tracer_name="web_scraper",
        extract_attributes=lambda self, url, *args, **kwargs: {"url": url},
    )
    async def _crawl_once(
        self,
        url: str,
        policy: ScrapePolicy,
        profile: BrowserProfile,
        proxy_config: dict[str, str] | None,
        guard: WebScraperUrlGuard,
    ) -> InternalScrapeResult:
        try:
            crawler = await self._crawler_provider()
            run_config = self._build_run_config(policy, profile, proxy_config)
            result = await crawler.arun(url=url, config=run_config)
            return self._to_internal_result(url, result, guard)
        except WebScraperSecurityError as exc:
            return InternalScrapeResult(
                url=url,
                success=False,
                error_message=exc.message,
                security_error_code=exc.error_code,
            )
        except asyncio.TimeoutError:
            return InternalScrapeResult(
                url=url,
                success=False,
                error_message="Crawl4AI request timed out",
            )
        except Exception as exc:
            logger.warning("Crawl4AI scrape failed for %s: %s", url, exc)
            return InternalScrapeResult(url=url, success=False, error_message=str(exc))

    def _build_run_config(
        self,
        policy: ScrapePolicy,
        profile: BrowserProfile,
        proxy_config: dict[str, str] | None,
    ) -> Any:
        from crawl4ai import CacheMode, CrawlerRunConfig

        config_kwargs = {
            "wait_until": policy.wait_until,
            "wait_for": policy.wait_for,
            "delay_before_return_html": policy.delay_before_return_html,
            "page_timeout": policy.page_timeout_ms,
            "process_iframes": policy.process_iframes,
            "cache_mode": CacheMode.BYPASS,
            "remove_overlay_elements": False,
            "locale": profile.locale,
            "timezone_id": profile.timezone_id,
            "user_agent": profile.user_agent,
            "user_agent_mode": profile.user_agent_mode,
        }

        if proxy_config:
            config_kwargs["proxy_config"] = proxy_config

        return CrawlerRunConfig(**config_kwargs)

    def _to_internal_result(
        self,
        original_url: str,
        result: Any,
        guard: WebScraperUrlGuard,
    ) -> InternalScrapeResult:
        metadata = result.metadata or {}
        headers = getattr(result, "response_headers", None) or {}
        final_url = str(result.url) if getattr(result, "url", None) else original_url
        guard.validate_final_url(original_url, final_url)

        return InternalScrapeResult(
            url=original_url,
            final_url=final_url,
            title=metadata.get("title") or None,
            description=metadata.get("description") or None,
            markdown=getattr(result, "markdown", None) or "",
            content_type=self._get_content_type(headers),
            status_code=getattr(result, "status_code", None),
            success=bool(getattr(result, "success", False)),
            error_message=getattr(result, "error_message", None),
            response_headers=headers,
            extraction_method="crawl4ai",
            quality_level="structured",
        )

    def _get_content_type(self, headers: dict) -> str | None:
        for key, value in headers.items():
            if key.lower() == "content-type":
                return value
        return None
