from typing import Any

from app.services.web_scraper.models import SourcePart
from app.services.web_scraper.policy import ScrapePolicy
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
