# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Scraper failures must not copy URL credentials into diagnostics."""

import logging
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.web_scraper.classifier import ScrapeResultClassifier
from app.services.web_scraper.crawler_logging import RedactingCrawlerLogger
from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.profiles import BrowserProfile
from app.services.web_scraper.proxy import ProxyMode, ProxyPlan
from app.services.web_scraper.quality import MarkdownQualityEvaluator
from app.services.web_scraper.scraper_service import WebScraperService
from app.services.web_scraper.security import WebScraperUrlGuard
from app.services.web_scraper.strategies.crawl4ai_strategy import Crawl4AIScrapeStrategy

URL = "https://log-user:log-password@example.com/page?token=log-secret#log-fragment"
SECRETS = ("log-user", "log-password", "log-secret", "log-fragment")

DIAGNOSTIC_CASES = [
    pytest.param(
        "{'token': 'opaque-credential-ABC123XYZ987",
        ("opaq", "Z987"),
        id="single-quoted-truncated",
    ),
    pytest.param(
        '{"token": "opaque-credential-ABC123XYZ987',
        ("opaq", "Z987"),
        id="double-quoted-truncated",
    ),
    ("Authorization: Bearer opaque-credential-ABC123XYZ987", ("opaq", "Z987")),
    ("Authorization: Basic dXNlcjpwYXNzd29yZA==", ("dXNl", "ZA==")),
    ("{'token': 'opaque-credential-ABC123XYZ987'}", ("opaq", "Z987")),
    ('{"token": "opaque-credential-ABC123XYZ987"}', ("opaq", "Z987")),
    ("{'Authorization': 'Bearer opaque-credential-ABC123XYZ987'}", ("opaq", "Z987")),
    ("token=opaque-credential-ABC123XYZ987", ("opaq", "Z987")),
    ("https://example.com/report?token=prefix'credential-tail", ("credential-tail",)),
    ("'https://example.com/report?token=prefix'credential-tail'", ("credential-tail",)),
]


@pytest.mark.parametrize(("diagnostic", "secrets"), DIAGNOSTIC_CASES)
async def test_credentials_are_hidden_in_all_sinks_and_error_results(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    tmp_path: Path,
    diagnostic: str,
    secrets: tuple[str, ...],
) -> None:
    message = f"Request failed: {diagnostic}"
    console = StringIO()
    destination = tmp_path / "crawler.log"
    handlers = [logging.StreamHandler(console), logging.FileHandler(destination)]
    root_logger = logging.getLogger()
    for handler in handlers:
        root_logger.addHandler(handler)
    service = WebScraperService()

    async def fail(url: str) -> None:
        raise RuntimeError(message)

    monkeypatch.setattr(service, "_scrape_url_impl", fail)
    try:
        with caplog.at_level(logging.ERROR):
            RedactingCrawlerLogger().error(message)
            result = await service.scrape_url("https://example.com/report")
        for output in (
            console.getvalue(),
            destination.read_text(),
            caplog.text,
            result.error_message,
        ):
            assert "Request failed" in output
            for secret in secrets:
                assert secret not in output
    finally:
        for handler in handlers:
            root_logger.removeHandler(handler)
            handler.close()


async def test_service_redacts_exception_chain_and_error_result(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    service = WebScraperService()

    async def fail(url: str) -> None:
        try:
            raise ValueError(f"Failed connection: {url}")
        except ValueError as cause:
            raise RuntimeError(f"Unable to scrape {url}") from cause

    monkeypatch.setattr(service, "_scrape_url_impl", fail)
    with caplog.at_level(logging.WARNING):
        result = await service.scrape_url(URL)

    assert not result.success
    assert "Unable to scrape" in result.error_message
    assert "ValueError" in caplog.text
    assert "RuntimeError" in caplog.text
    for secret in SECRETS:
        assert secret not in caplog.text
        assert secret not in result.error_message


@pytest.mark.parametrize("fails", [False, True])
async def test_service_crawler_logs_use_safe_console_and_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    fails: bool,
) -> None:
    import crawl4ai
    from crawl4ai.async_logger import AsyncLogger

    log_file = tmp_path / "crawler.log"
    console = StringIO()
    handlers = [logging.StreamHandler(console), logging.FileHandler(log_file)]
    root_logger = logging.getLogger()
    for handler in handlers:
        root_logger.addHandler(handler)

    class Crawler:
        def __init__(self, config: Any, logger: Any = None) -> None:
            self.logger = logger or AsyncLogger(log_file=str(log_file))
            self.crawler_strategy = SimpleNamespace(set_hook=Mock())

        async def start(self) -> None:
            if fails:
                self.logger.error_status(URL, f"Fetch failed: {URL}")
                raise RuntimeError("Browser startup failed")
            self.logger.url_status(URL, True, 0.25)

        async def close(self) -> None:
            pass

    monkeypatch.setattr(crawl4ai, "AsyncWebCrawler", Crawler)
    service = WebScraperService()
    try:
        with caplog.at_level(logging.INFO):
            if fails:
                with pytest.raises(RuntimeError, match="Browser startup failed"):
                    await service._get_crawler()
            else:
                await service._get_crawler()
        captured = capsys.readouterr()
        outputs = (console.getvalue(), log_file.read_text(), caplog.text)
        for output in outputs:
            assert "example.com/page" in output
            for secret in SECRETS:
                assert secret not in output
        for secret in SECRETS:
            assert secret not in captured.out + captured.err
    finally:
        await service.close()
        for handler in handlers:
            root_logger.removeHandler(handler)
            handler.close()


@pytest.mark.parametrize("raises", [True, False])
async def test_crawler_failure_text_is_safe(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, raises: bool
) -> None:
    raw_error = f"Fetch failed for {URL}"
    crawler = SimpleNamespace(
        arun=AsyncMock(
            side_effect=RuntimeError(raw_error) if raises else None,
            return_value=SimpleNamespace(
                success=False, url=URL, error_message=raw_error, metadata={}
            ),
        )
    )
    strategy = Crawl4AIScrapeStrategy(
        AsyncMock(return_value=crawler),
        ScrapeResultClassifier(),
        MarkdownQualityEvaluator(),
    )
    monkeypatch.setattr(strategy, "_validate_redirect_chain", AsyncMock())
    guard = WebScraperUrlGuard()
    monkeypatch.setattr(guard, "validate_final_url", lambda *args: None)
    with caplog.at_level(logging.WARNING):
        result = await strategy.scrape(
            URL,
            ScrapePolicy(),
            BrowserProfile(name="desktop_chrome_cn"),
            ProxyPlan(mode=ProxyMode.NONE),
            guard,
        )

    assert not result.success
    assert crawler.arun.call_args.kwargs["url"] == URL
    assert "Fetch failed" in result.error_message
    for secret in SECRETS:
        assert secret not in caplog.text
        assert secret not in result.error_message
