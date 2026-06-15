from typing import Any

import httpx
import pytest

import app.services.web_scraper.pdf_extractor as pdf_extractor_module
from app.services.web_scraper.models import ERROR_INVALID_URL, InternalScrapeResult
from app.services.web_scraper.pdf_extractor import PdfExtractor
from app.services.web_scraper.proxy import ProxyMode, ProxyPlan
from app.services.web_scraper.scraper_service import ScrapedContent, WebScraperService
from app.services.web_scraper.security import WebScraperUrlGuard


class FakeCrawlStrategy:
    def __init__(self, result: InternalScrapeResult) -> None:
        self.result = result

    async def scrape(self, **kwargs: Any) -> InternalScrapeResult:
        return self.result


class FakePdfExtractor:
    def __init__(self, result: InternalScrapeResult) -> None:
        self.result = result
        self.seen_url = None

    async def extract(self, pdf_url: str, **kwargs: Any) -> InternalScrapeResult:
        self.seen_url = pdf_url
        return self.result


class FakePlaywrightStrategy:
    def __init__(self, result: InternalScrapeResult) -> None:
        self.result = result
        self.called = False

    async def scrape(self, **kwargs: Any) -> InternalScrapeResult:
        self.called = True
        return self.result


class RecordingPdfExtractor(PdfExtractor):
    def __init__(self, fail_direct: bool = False) -> None:
        self.fail_direct = fail_direct
        self.attempts: list[bool] = []

    async def _download_once(
        self,
        pdf_url: str,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
        use_proxy: bool,
    ) -> httpx.Response:
        self.attempts.append(use_proxy)
        if self.fail_direct and not use_proxy:
            raise httpx.TimeoutException("direct timed out")
        return httpx.Response(
            200,
            request=httpx.Request("GET", pdf_url),
            content=b"%PDF",
        )


class FakeRedirectingAsyncClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.follow_redirects = kwargs.get("follow_redirects")

    async def __aenter__(self) -> "FakeRedirectingAsyncClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    async def get(self, url: str) -> httpx.Response:
        if url == "https://example.com/start.pdf":
            return httpx.Response(
                302,
                headers={"location": "/final.pdf"},
                request=httpx.Request("GET", url),
            )
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            content=b"%PDF",
        )


class RecordingRedirectGuard(WebScraperUrlGuard):
    def __init__(self) -> None:
        self.redirects: list[tuple[str, str, str]] = []
        self.final_urls: list[tuple[str, str]] = []

    def validate_redirect_target(
        self, original_url: str, current_url: str, location: str
    ) -> str:
        self.redirects.append((original_url, current_url, location))
        return super().validate_redirect_target(original_url, current_url, location)

    def validate_final_url(self, original_url: str, final_url: str) -> None:
        self.final_urls.append((original_url, final_url))
        super().validate_final_url(original_url, final_url)


def prepare_service(monkeypatch: pytest.MonkeyPatch) -> WebScraperService:
    service = WebScraperService()
    monkeypatch.setattr(service, "_check_crawl4ai", lambda: True)
    monkeypatch.setattr(service._guard, "validate_initial_url", lambda url: None)
    return service


async def test_scrape_url_preserves_public_success_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = prepare_service(monkeypatch)
    service._crawl4ai_strategy = FakeCrawlStrategy(
        InternalScrapeResult(
            url="https://example.com",
            final_url="https://example.com/final",
            title="Example",
            description="Description",
            markdown="This is enough markdown content for the scraper to accept.",
        )
    )

    result = await service.scrape_url("https://example.com")

    assert isinstance(result, ScrapedContent)
    assert result.success is True
    assert result.title == "Example"
    assert result.description == "Description"
    assert result.url == "https://example.com/final"
    assert result.content_length == len(result.content)


async def test_pdf_extractor_uses_primary_final_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = prepare_service(monkeypatch)
    service._crawl4ai_strategy = FakeCrawlStrategy(
        InternalScrapeResult(
            url="https://example.com/file",
            final_url="https://cdn.example.com/file.pdf",
            markdown="",
            content_type="application/pdf",
        )
    )
    pdf_extractor = FakePdfExtractor(
        InternalScrapeResult(
            url="https://cdn.example.com/file.pdf",
            final_url="https://cdn.example.com/file.pdf",
            markdown="This is extracted PDF text content with sufficient length.",
            quality_level="degraded",
            extraction_method="pdf",
        )
    )
    service._pdf_extractor = pdf_extractor

    result = await service.scrape_url("https://example.com/file")

    assert result.success is True
    assert pdf_extractor.seen_url == "https://cdn.example.com/file.pdf"


async def test_direct_pdf_url_does_not_require_crawl4ai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = prepare_service(monkeypatch)
    monkeypatch.setattr(service, "_check_crawl4ai", lambda: False)
    pdf_extractor = FakePdfExtractor(
        InternalScrapeResult(
            url="https://example.com/file.pdf",
            final_url="https://example.com/file.pdf",
            markdown="This is extracted PDF text content with sufficient length.",
            quality_level="degraded",
            extraction_method="pdf",
        )
    )
    service._pdf_extractor = pdf_extractor

    result = await service.scrape_url("https://example.com/file.pdf")

    assert result.success is True
    assert pdf_extractor.seen_url == "https://example.com/file.pdf"


async def test_pdf_extractor_validates_initial_url() -> None:
    result = await PdfExtractor().extract(
        pdf_url="file:///tmp/local.pdf",
        proxy_plan=ProxyPlan(mode=ProxyMode.NONE),
        guard=WebScraperUrlGuard(),
    )

    assert result.success is False
    assert result.security_error_code == ERROR_INVALID_URL


async def test_pdf_download_fallback_tries_direct_first() -> None:
    extractor = RecordingPdfExtractor()

    await extractor._download_pdf(
        pdf_url="https://example.com/file.pdf",
        proxy_plan=ProxyPlan(
            mode=ProxyMode.FALLBACK,
            raw_url="http://proxy.example.com:8080",
        ),
        guard=WebScraperUrlGuard(),
    )

    assert extractor.attempts == [False]


async def test_pdf_download_fallback_retries_proxy_after_direct_failure() -> None:
    extractor = RecordingPdfExtractor(fail_direct=True)

    await extractor._download_pdf(
        pdf_url="https://example.com/file.pdf",
        proxy_plan=ProxyPlan(
            mode=ProxyMode.FALLBACK,
            raw_url="http://proxy.example.com:8080",
        ),
        guard=WebScraperUrlGuard(),
    )

    assert extractor.attempts == [False, True]


async def test_pdf_download_proxy_mode_uses_proxy_first() -> None:
    extractor = RecordingPdfExtractor()

    await extractor._download_pdf(
        pdf_url="https://example.com/file.pdf",
        proxy_plan=ProxyPlan(
            mode=ProxyMode.PROXY,
            raw_url="http://proxy.example.com:8080",
        ),
        guard=WebScraperUrlGuard(),
    )

    assert extractor.attempts == [True]


async def test_pdf_download_validates_redirect_before_following(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        pdf_extractor_module.httpx,
        "AsyncClient",
        FakeRedirectingAsyncClient,
    )
    guard = RecordingRedirectGuard()

    response = await PdfExtractor()._download_once(
        pdf_url="https://example.com/start.pdf",
        proxy_plan=ProxyPlan(mode=ProxyMode.NONE),
        guard=guard,
        use_proxy=False,
    )

    assert str(response.url) == "https://example.com/final.pdf"
    assert guard.redirects == [
        (
            "https://example.com/start.pdf",
            "https://example.com/start.pdf",
            "/final.pdf",
        )
    ]
    assert guard.final_urls[-1] == (
        "https://example.com/start.pdf",
        "https://example.com/final.pdf",
    )


async def test_pdf_extract_empty_text_is_successful_empty_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    extractor = PdfExtractor()
    response = httpx.Response(
        200,
        request=httpx.Request("GET", "https://example.com/empty.pdf"),
        content=b"%PDF",
    )

    async def download_pdf(*args: Any, **kwargs: Any) -> httpx.Response:
        return response

    monkeypatch.setattr(extractor, "_download_pdf", download_pdf)
    monkeypatch.setattr(extractor, "_extract_pdf_text", lambda response: ("", None))

    result = await extractor.extract(
        pdf_url="https://example.com/empty.pdf",
        proxy_plan=ProxyPlan(mode=ProxyMode.NONE),
        guard=WebScraperUrlGuard(),
    )

    assert result.success is True
    assert result.error_message is None
    assert result.markdown == ""
    assert result.source_parts == []


async def test_low_quality_primary_uses_playwright_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = prepare_service(monkeypatch)
    service._crawl4ai_strategy = FakeCrawlStrategy(
        InternalScrapeResult(url="https://example.com", markdown="short")
    )
    playwright = FakePlaywrightStrategy(
        InternalScrapeResult(
            url="https://example.com",
            final_url="https://example.com",
            markdown="This fallback content is long enough to be accepted.",
        )
    )
    service._playwright_strategy = playwright

    result = await service.scrape_url("https://example.com")

    assert playwright.called is True
    assert result.success is True
    assert result.content == "This fallback content is long enough to be accepted."


async def test_reachable_empty_2xx_primary_uses_playwright_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = prepare_service(monkeypatch)
    service._crawl4ai_strategy = FakeCrawlStrategy(
        InternalScrapeResult(
            url="https://example.com",
            success=False,
            status_code=200,
            error_message="Blocked by anti-bot protection: minimal_text",
        )
    )
    playwright = FakePlaywrightStrategy(
        InternalScrapeResult(
            url="https://example.com",
            final_url="https://example.com",
            markdown="This fallback content is long enough to be accepted.",
        )
    )
    service._playwright_strategy = playwright

    result = await service.scrape_url("https://example.com")

    assert playwright.called is True
    assert result.success is True
    assert result.content == "This fallback content is long enough to be accepted."
