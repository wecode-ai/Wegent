import pytest

import app.services.web_scraper.security as security_module
from app.services.web_scraper.models import ERROR_INVALID_URL, ERROR_SSRF_BLOCKED
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
    redact_url_for_logging,
)


def test_validate_initial_url_rejects_invalid_format() -> None:
    guard = WebScraperUrlGuard()

    with pytest.raises(WebScraperSecurityError) as exc_info:
        guard.validate_initial_url("not-a-url")

    assert exc_info.value.error_code == ERROR_INVALID_URL


def test_validate_initial_url_rejects_ssrf(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(security_module, "_validate_url_for_ssrf", lambda url: False)
    guard = WebScraperUrlGuard()

    with pytest.raises(WebScraperSecurityError) as exc_info:
        guard.validate_initial_url("https://example.com")

    assert exc_info.value.error_code == ERROR_SSRF_BLOCKED


def test_fetch_url_allows_safe_http(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(security_module, "_validate_url_for_ssrf", lambda url: True)

    assert WebScraperUrlGuard().is_allowed_fetch_url("https://example.com") is True


def test_fetch_url_aborts_file_scheme() -> None:
    assert WebScraperUrlGuard().is_allowed_fetch_url("file:///etc/passwd") is False


def test_websocket_url_is_mapped_through_ssrf_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    def fake_validate(url: str) -> bool:
        seen.append(url)
        return True

    monkeypatch.setattr(security_module, "_validate_url_for_ssrf", fake_validate)

    assert WebScraperUrlGuard().is_allowed_fetch_url("wss://example.com/socket") is True
    assert seen == ["https://example.com/"]


def test_validate_redirect_target_resolves_relative_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    def fake_validate(url: str) -> bool:
        seen.append(url)
        return True

    monkeypatch.setattr(security_module, "_validate_url_for_ssrf", fake_validate)

    target = WebScraperUrlGuard().validate_redirect_target(
        "https://example.com/start",
        "https://example.com/docs/start",
        "../file.pdf",
    )

    assert target == "https://example.com/file.pdf"
    assert seen == ["https://example.com/file.pdf"]


def test_validate_redirect_target_rejects_ssrf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(security_module, "_validate_url_for_ssrf", lambda url: False)

    with pytest.raises(WebScraperSecurityError) as exc_info:
        WebScraperUrlGuard().validate_redirect_target(
            "https://example.com/start",
            "https://example.com/start",
            "http://127.0.0.1/private",
        )

    assert exc_info.value.error_code == ERROR_SSRF_BLOCKED


def test_redact_url_for_logging_removes_secrets() -> None:
    redacted = redact_url_for_logging(
        "https://user:secret@example.com:8443/path?a=token#fragment"
    )

    assert redacted == "https://example.com:8443/path?<redacted>#<redacted>"
