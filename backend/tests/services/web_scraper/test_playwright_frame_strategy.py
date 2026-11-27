import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

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


@pytest.mark.parametrize("structured", [True, False])
async def test_refresh_retains_short_frames_after_quality_checks(structured):
    strategy = PlaywrightFrameExtractionStrategy()
    body = "营业时间：周一至周五9点至18点，周末及节假日均休息。"
    frame = FakeFrame(html=f"<p>{body}</p>" if structured else "", text=body)
    blocked = FakeFrame(html="<p>Access denied</p>", text="Access denied")
    private_body = body + "（私有页面）"
    private = FakeFrame(
        html=f"<p>{private_body}</p>", text=private_body, url="http://127.0.0.1/frame"
    )
    page = SimpleNamespace(frames=[frame, frame, blocked, private])
    guard = WebScraperUrlGuard()
    policy = ScrapePolicy(allow_short_content=True)

    parts = await strategy._extract_source_parts(page, policy, guard)

    assert len(parts) == 1
    assert parts[0].markdown == body
    assert parts[0].quality_level == ("structured" if structured else "degraded")
    assert await strategy._extract_source_parts(page, ScrapePolicy(), guard) == []


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


async def test_browser_admission_checks_each_paused_document_before_continuing(
    monkeypatch,
):
    from unittest.mock import AsyncMock, MagicMock

    from app.services.web_scraper.security import (
        browser_domain_admission,
        fetch_domain_admission,
        install_page_domain_admission,
    )

    events = []

    async def send(command, params=None):
        events.append((command, (params or {}).get("requestId")))

    async def admit(url):
        events.append(("admitted", url))

    session = MagicMock()
    session.send = AsyncMock(side_effect=send)
    session.detach = AsyncMock()
    page = SimpleNamespace(
        context=SimpleNamespace(new_cdp_session=AsyncMock(return_value=session))
    )
    admission = AsyncMock(side_effect=admit)
    guard = MagicMock()
    monkeypatch.setattr(
        "app.services.web_scraper.security.WebScraperUrlGuard", lambda: guard
    )
    token = fetch_domain_admission.set(admission)
    try:
        async with browser_domain_admission():
            await install_page_domain_admission(page)
            handler = session.on.call_args.args[1]
            session.send.reset_mock()
            for request_id, url in [
                ("initial", "https://a.example/start"),
                ("redirect", "https://b.example/end"),
            ]:
                events.clear()
                await handler({"requestId": request_id, "request": {"url": url}})
                assert events == [
                    ("admitted", url),
                    ("Fetch.continueRequest", request_id),
                ]
            admission.side_effect = RuntimeError("domain busy")
            events.clear()
            await handler(
                {"requestId": "busy", "request": {"url": "https://c.example"}}
            )
            session.send.assert_awaited_with(
                "Fetch.failRequest",
                {"requestId": "busy", "errorReason": "BlockedByClient"},
            )
            assert events == [("Fetch.failRequest", "busy")]
            admission.reset_mock()
            guard.validate_initial_url.side_effect = ValueError("unsafe URL")
            events.clear()
            await handler(
                {"requestId": "unsafe", "request": {"url": "http://127.0.0.1"}}
            )
            admission.assert_not_awaited()
            session.send.assert_awaited_with(
                "Fetch.failRequest",
                {"requestId": "unsafe", "errorReason": "BlockedByClient"},
            )
            assert events == [("Fetch.failRequest", "unsafe")]
    finally:
        fetch_domain_admission.reset(token)
    session.remove_listener.assert_called_once_with("Fetch.requestPaused", handler)
    session.detach.assert_awaited_once()
    await install_page_domain_admission(page)
    page.context.new_cdp_session.assert_awaited_once()


@pytest.mark.parametrize("interruption", [RuntimeError, asyncio.CancelledError])
async def test_browser_admission_detaches_on_interrupted_navigation(interruption):
    from unittest.mock import AsyncMock, MagicMock

    from app.services.web_scraper.security import (
        browser_domain_admission,
        fetch_domain_admission,
        install_page_domain_admission,
    )

    session = MagicMock(send=AsyncMock(), detach=AsyncMock())
    page = SimpleNamespace(
        context=SimpleNamespace(new_cdp_session=AsyncMock(return_value=session))
    )
    token = fetch_domain_admission.set(AsyncMock())
    try:
        with pytest.raises(interruption):
            async with browser_domain_admission():
                await install_page_domain_admission(page)
                raise interruption()
        session.remove_listener.assert_called_once()
        session.detach.assert_awaited_once()
    finally:
        fetch_domain_admission.reset(token)
