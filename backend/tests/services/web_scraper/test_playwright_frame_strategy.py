from typing import Any

from app.services.web_scraper.models import InternalScrapeResult, SourcePart
from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.profiles import BrowserProfile
from app.services.web_scraper.proxy import ProxyMode, ProxyPlan
from app.services.web_scraper.security import WebScraperUrlGuard
from app.services.web_scraper.strategies.playwright_frame_strategy import (
    PlaywrightFrameExtractionStrategy,
)


class FakeFrame:
    def __init__(
        self,
        html: str,
        text: str,
        title: str = "Frame Title",
        url: str = "https://example.com/frame",
    ) -> None:
        self.html = html
        self.text = text
        self.title = title
        self.url = url

    async def wait_for_load_state(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def evaluate(self, script: str) -> str | None:
        if "innerHTML" in script:
            return self.html
        if "innerText" in script:
            return self.text
        if "document.title" in script:
            return self.title
        return None


class RecordingPlaywrightStrategy(PlaywrightFrameExtractionStrategy):
    def __init__(self, results: list[InternalScrapeResult]) -> None:
        super().__init__()
        self.results = results
        self.attempts: list[bool] = []

    async def _scrape_once(
        self,
        playwright: Any,
        url: str,
        policy: ScrapePolicy,
        profile: BrowserProfile,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
        use_proxy: bool,
    ) -> InternalScrapeResult:
        self.attempts.append(use_proxy)
        return self.results.pop(0)


async def test_playwright_frame_prefers_html_markdown() -> None:
    strategy = PlaywrightFrameExtractionStrategy()
    frame = FakeFrame(
        html=(
            "<h1>Frame Heading</h1>"
            "<p>Structured content for indexing with enough body detail to pass "
            "the markdown quality threshold.</p>"
        ),
        text="Plain text fallback should not be used.",
    )

    part = await strategy._extract_frame_part(frame, ScrapePolicy())

    assert part is not None
    assert part.method == "playwright_html"
    assert part.quality_level == "structured"
    assert "# Frame Heading" in part.markdown


async def test_playwright_frame_uses_inner_text_as_degraded_fallback() -> None:
    strategy = PlaywrightFrameExtractionStrategy()
    frame = FakeFrame(
        html="<nav>Home</nav>",
        text="This degraded fallback text contains useful content for indexing.",
    )

    part = await strategy._extract_frame_part(frame, ScrapePolicy())

    assert part is not None
    assert part.method == "playwright_text"
    assert part.quality_level == "degraded"
    assert "degraded fallback text" in part.markdown


def test_combine_source_parts_includes_frame_source() -> None:
    strategy = PlaywrightFrameExtractionStrategy()
    part = strategy._combine_source_parts(
        page_title="Page",
        page_url="https://example.com/page",
        source_parts=[
            SourcePart(
                title="Frame",
                url="https://example.com/frame",
                markdown="Frame body",
                method="playwright_html",
            )
        ],
        max_total_chars=1000,
    )

    assert "# Page" in part
    assert "Source: https://example.com/page" in part
    assert "## Frame" in part
    assert "Source: https://example.com/frame" in part


async def test_playwright_fallback_mode_tries_direct_first() -> None:
    strategy = RecordingPlaywrightStrategy(
        [InternalScrapeResult(url="https://example.com", markdown="accepted content")]
    )

    await strategy._scrape_with_proxy_plan(
        playwright=object(),
        url="https://example.com",
        policy=ScrapePolicy(),
        profile=BrowserProfile(name="desktop_chrome_cn"),
        proxy_plan=ProxyPlan(
            mode=ProxyMode.FALLBACK,
            raw_url="http://proxy.example.com:8080",
        ),
        guard=WebScraperUrlGuard(),
    )

    assert strategy.attempts == [False]


async def test_playwright_fallback_retries_proxy_after_direct_failure() -> None:
    strategy = RecordingPlaywrightStrategy(
        [
            InternalScrapeResult(
                url="https://example.com",
                success=False,
                error_message="direct failed",
            ),
            InternalScrapeResult(url="https://example.com", markdown="proxy content"),
        ]
    )

    await strategy._scrape_with_proxy_plan(
        playwright=object(),
        url="https://example.com",
        policy=ScrapePolicy(),
        profile=BrowserProfile(name="desktop_chrome_cn"),
        proxy_plan=ProxyPlan(
            mode=ProxyMode.FALLBACK,
            raw_url="http://proxy.example.com:8080",
        ),
        guard=WebScraperUrlGuard(),
    )

    assert strategy.attempts == [False, True]


async def test_playwright_proxy_mode_uses_proxy_first() -> None:
    strategy = RecordingPlaywrightStrategy(
        [InternalScrapeResult(url="https://example.com", markdown="proxy content")]
    )

    await strategy._scrape_with_proxy_plan(
        playwright=object(),
        url="https://example.com",
        policy=ScrapePolicy(),
        profile=BrowserProfile(name="desktop_chrome_cn"),
        proxy_plan=ProxyPlan(
            mode=ProxyMode.PROXY,
            raw_url="http://proxy.example.com:8080",
        ),
        guard=WebScraperUrlGuard(),
    )

    assert strategy.attempts == [True]
