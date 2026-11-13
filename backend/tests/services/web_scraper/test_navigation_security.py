from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.web_scraper.classifier import ScrapeResultClassifier
from app.services.web_scraper.models import ERROR_SSRF_BLOCKED
from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.profiles import BrowserProfile
from app.services.web_scraper.proxy import ProxyMode, ProxyPlan
from app.services.web_scraper.quality import MarkdownQualityEvaluator
from app.services.web_scraper.security import WebScraperUrlGuard
from app.services.web_scraper.strategies.crawl4ai_strategy import Crawl4AIScrapeStrategy


async def test_wrapped_browser_denial_keeps_ssrf_code_without_proxy_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def arun(url: str, config: object) -> SimpleNamespace:
        config._wegent_navigation.blocked_url = "http://127.0.0.1/private"
        return SimpleNamespace(success=False, error_message="net::ERR_FAILED")

    crawler = SimpleNamespace(arun=AsyncMock(side_effect=arun))
    strategy = Crawl4AIScrapeStrategy(
        AsyncMock(return_value=crawler),
        ScrapeResultClassifier(),
        MarkdownQualityEvaluator(),
    )
    monkeypatch.setattr(strategy, "_validate_redirect_chain", AsyncMock())
    monkeypatch.setattr(strategy, "_build_run_config", lambda *args: SimpleNamespace())

    result = await strategy.scrape(
        "https://example.com",
        ScrapePolicy(),
        BrowserProfile(name="desktop_chrome_cn"),
        ProxyPlan(mode=ProxyMode.FALLBACK, raw_url="http://proxy:8080"),
        WebScraperUrlGuard(),
    )

    assert result.security_error_code == ERROR_SSRF_BLOCKED
    crawler.arun.assert_awaited_once()


@pytest.mark.parametrize(
    "final_url", ["https://example.com/final", "http://127.0.0.1/private"]
)
async def test_crawler_checks_actual_final_address(
    monkeypatch: pytest.MonkeyPatch, final_url: str
) -> None:
    crawler = SimpleNamespace(
        arun=AsyncMock(
            return_value=SimpleNamespace(
                success=True,
                url="https://example.com/start",
                redirected_url=final_url,
                metadata={},
                response_headers={},
                status_code=200,
                markdown="A useful public page with enough text to index.",
                html="<h1>Public</h1>",
            )
        )
    )
    strategy = Crawl4AIScrapeStrategy(
        AsyncMock(return_value=crawler),
        ScrapeResultClassifier(),
        MarkdownQualityEvaluator(),
    )
    monkeypatch.setattr(strategy, "_validate_redirect_chain", AsyncMock())
    monkeypatch.setattr(strategy, "_build_run_config", lambda *args: SimpleNamespace())
    guard = WebScraperUrlGuard()
    monkeypatch.setattr(
        "app.services.web_scraper.security._validate_url_for_ssrf",
        lambda url: "127.0.0.1" not in url,
    )
    result = await strategy.scrape(
        "https://example.com/start",
        ScrapePolicy(),
        BrowserProfile(name="desktop_chrome_cn"),
        ProxyPlan(mode=ProxyMode.NONE),
        guard,
    )
    if "127.0.0.1" in final_url:
        assert result.security_error_code == ERROR_SSRF_BLOCKED
    else:
        assert result.final_url == final_url
