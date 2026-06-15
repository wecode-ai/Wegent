from typing import Any

from app.services.web_scraper.classifier import ScrapeResultClassifier
from app.services.web_scraper.models import InternalScrapeResult
from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.proxy import ProxyMode, ProxyPlan
from app.services.web_scraper.quality import MarkdownQualityEvaluator
from app.services.web_scraper.security import WebScraperUrlGuard
from app.services.web_scraper.strategies.crawl4ai_strategy import (
    Crawl4AIScrapeStrategy,
)


def _build_strategy(
    direct: InternalScrapeResult, proxy: InternalScrapeResult
) -> Crawl4AIScrapeStrategy:
    strategy = Crawl4AIScrapeStrategy(
        crawler_provider=lambda: None,
        classifier=ScrapeResultClassifier(),
        quality_evaluator=MarkdownQualityEvaluator(),
    )

    async def fake_crawl_once(
        url: str,
        policy: ScrapePolicy,
        profile: Any,
        proxy_config: Any,
        proxy_plan: ProxyPlan,
        use_proxy: bool,
        guard: WebScraperUrlGuard,
    ) -> InternalScrapeResult:
        return proxy if use_proxy else direct

    strategy._crawl_once = fake_crawl_once  # type: ignore[assignment]
    return strategy


async def test_proxy_fallback_keeps_reachable_empty_over_hard_proxy_failure() -> None:
    direct = InternalScrapeResult(
        url="https://example.com",
        success=False,
        status_code=200,
        error_message="Blocked by anti-bot protection: minimal_text",
    )
    proxy = InternalScrapeResult(
        url="https://example.com",
        success=False,
        status_code=None,
        error_message="Connection refused",
    )
    strategy = _build_strategy(direct, proxy)

    result = await strategy.scrape(
        url="https://example.com",
        policy=ScrapePolicy(),
        profile=None,
        proxy_plan=ProxyPlan(mode=ProxyMode.FALLBACK, raw_url="http://proxy:8080"),
        guard=WebScraperUrlGuard(),
    )

    assert result is direct
    assert result.status_code == 200


async def test_proxy_fallback_prefers_successful_proxy_result() -> None:
    direct = InternalScrapeResult(
        url="https://example.com",
        success=False,
        status_code=200,
        error_message="Blocked by anti-bot protection: minimal_text",
    )
    proxy = InternalScrapeResult(
        url="https://example.com",
        final_url="https://example.com",
        markdown="This proxied content is long enough to be accepted as content.",
        status_code=200,
        success=True,
    )
    strategy = _build_strategy(direct, proxy)

    result = await strategy.scrape(
        url="https://example.com",
        policy=ScrapePolicy(),
        profile=None,
        proxy_plan=ProxyPlan(mode=ProxyMode.FALLBACK, raw_url="http://proxy:8080"),
        guard=WebScraperUrlGuard(),
    )

    assert result is proxy


async def test_proxy_fallback_keeps_proxy_result_for_transport_failure() -> None:
    direct = InternalScrapeResult(
        url="https://example.com",
        success=False,
        status_code=None,
        error_message="Connection refused",
    )
    proxy = InternalScrapeResult(
        url="https://example.com",
        final_url="https://example.com",
        markdown="This proxied content is long enough to be accepted as content.",
        status_code=200,
        success=True,
    )
    strategy = _build_strategy(direct, proxy)

    result = await strategy.scrape(
        url="https://example.com",
        policy=ScrapePolicy(),
        profile=None,
        proxy_plan=ProxyPlan(mode=ProxyMode.FALLBACK, raw_url="http://proxy:8080"),
        guard=WebScraperUrlGuard(),
    )

    assert result is proxy
