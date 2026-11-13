# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Crawler diagnostics must be safe before reaching any application log sink."""

import logging
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.services.web_scraper.crawler_logging import RedactingCrawlerLogger

LOGGER_NAME = "app.services.web_scraper.crawler_logging"
SECRET_URL = (
    "https://sensitive-user:sensitive-password@example.com/report"
    "?token=query-secret%20tail-secret#fragment-secret"
)
SECRETS = (
    "sensitive-user",
    "sensitive-password",
    "query-secret",
    "tail-secret",
    "fragment-secret",
)


@pytest.fixture
def log_file(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> Iterator[Path]:
    logger = logging.getLogger(LOGGER_NAME)
    console = logging.StreamHandler()
    destination = tmp_path / "crawler.log"
    file_handler = logging.FileHandler(destination)
    logger.addHandler(console)
    logger.addHandler(file_handler)
    try:
        yield destination
    finally:
        logger.removeHandler(console)
        logger.removeHandler(file_handler)
        file_handler.close()


@pytest.mark.parametrize("success", [True, False])
def test_crawler_status_is_redacted_in_console_and_file(
    success: bool,
    log_file: Path,
    capfd: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    crawler_logger = RedactingCrawlerLogger()
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        crawler_logger.url_status(SECRET_URL, success, 1.25, url_length=200)
        if not success:
            crawler_logger.error_status(
                SECRET_URL,
                f"RuntimeError: request to {SECRET_URL} failed",
                url_length=200,
            )

    captured = capfd.readouterr()
    for output in (captured.out + captured.err, log_file.read_text(), caplog.text):
        for secret in SECRETS:
            assert secret not in output
        assert "example.com/report" in output
        assert "1.25" in output
        if not success:
            assert "RuntimeError" in output


def test_crawler_templates_preserve_diagnostics_without_url_credentials(
    log_file: Path,
    capfd: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    crawler_logger = RedactingCrawlerLogger()
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        crawler_logger.warning(
            "request={details} elapsed={elapsed:.2f}",
            params={"details": {"failed_url": SECRET_URL}, "elapsed": 2.5},
        )
    captured = capfd.readouterr()
    for output in (captured.out + captured.err, log_file.read_text(), caplog.text):
        assert "elapsed=2.50" in output
        assert "failed_url" in output
        for secret in SECRETS:
            assert secret not in output


def test_crawler_sanitizes_urls_before_sdk_decodes_and_shortens_them(
    log_file: Path,
    capfd: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    crawler_logger = RedactingCrawlerLogger()
    long_url = (
        "https://example.com/" + "path-" * 30 + "?token=query-secret%20tail-secret"
    )
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        crawler_logger.url_status(long_url, True, 0.5, url_length=50)
    captured = capfd.readouterr()
    for output in (captured.out + captured.err, log_file.read_text(), caplog.text):
        assert "example" in output
        assert "query-secret" not in output
        assert "tail-secret" not in output
