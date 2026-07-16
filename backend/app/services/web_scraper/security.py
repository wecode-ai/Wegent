# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""URL safety guard for web scraping."""

from urllib.parse import ParseResult, urljoin, urlparse, urlunparse

from app.services.url_metadata import _validate_url_for_ssrf
from app.services.web_scraper.models import ERROR_INVALID_URL, ERROR_SSRF_BLOCKED


class WebScraperSecurityError(Exception):
    """Controlled web scraper security exception."""

    def __init__(self, error_code: str, message: str) -> None:
        self.error_code = error_code
        self.message = message
        super().__init__(message)


class WebScraperUrlGuard:
    """Validate URLs and request targets used by scraper strategies."""

    def validate_initial_url(self, url: str) -> None:
        """Validate user-provided URL."""
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            raise WebScraperSecurityError(ERROR_INVALID_URL, "Invalid URL format")
        if parsed.scheme not in {"http", "https"}:
            raise WebScraperSecurityError(ERROR_INVALID_URL, "Invalid URL format")
        if not _validate_url_for_ssrf(url):
            raise WebScraperSecurityError(
                ERROR_SSRF_BLOCKED,
                "URL blocked by security policy (private/internal address)",
            )

    def validate_final_url(self, original_url: str, final_url: str) -> None:
        """Validate redirect target URL."""
        if not self.is_allowed_fetch_url(final_url):
            raise WebScraperSecurityError(
                ERROR_SSRF_BLOCKED,
                (
                    "Redirect blocked by security policy: "
                    f"{redact_url_for_logging(original_url)} -> "
                    f"{redact_url_for_logging(final_url)}"
                ),
            )

    def validate_redirect_target(
        self, original_url: str, current_url: str, location: str
    ) -> str:
        """Resolve and validate one redirect target before following it."""
        next_url = urljoin(current_url, location)
        self.validate_final_url(original_url, next_url)
        return next_url

    def validate_frame_url(self, frame_url: str) -> None:
        """Validate iframe URL."""
        if not self.is_allowed_frame_url(frame_url):
            raise WebScraperSecurityError(
                ERROR_SSRF_BLOCKED,
                (
                    "Frame URL blocked by security policy: "
                    f"{redact_url_for_logging(frame_url)}"
                ),
            )

    def is_allowed_fetch_url(self, url: str) -> bool:
        """Return whether a subrequest URL is safe to fetch."""
        parsed = urlparse(url)
        if parsed.scheme in {"data", "blob", "about"}:
            return True
        if parsed.scheme in {"ws", "wss"}:
            return self._is_allowed_websocket_url(parsed)
        if parsed.scheme not in {"http", "https"}:
            return False
        return _validate_url_for_ssrf(url)

    def is_allowed_frame_url(self, url: str) -> bool:
        """Return whether an iframe URL is safe to inspect."""
        parsed = urlparse(url)
        if parsed.scheme in {"about", "data", "blob"}:
            return True
        return self.is_allowed_fetch_url(url)

    def _is_allowed_websocket_url(self, parsed: ParseResult) -> bool:
        if not parsed.netloc:
            return False
        mapped_scheme = "https" if parsed.scheme == "wss" else "http"
        mapped_url = urlunparse((mapped_scheme, parsed.netloc, "/", "", "", ""))
        return _validate_url_for_ssrf(mapped_url)


def redact_url_for_logging(url: str) -> str:
    """Return a URL safe for logs and trace attributes."""
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return "<invalid-url>"

    hostname = parsed.hostname or ""
    netloc = hostname
    try:
        if parsed.port:
            netloc = f"{hostname}:{parsed.port}"
    except ValueError:
        return "<invalid-url>"

    query = "<redacted>" if parsed.query else ""
    fragment = "<redacted>" if parsed.fragment else ""
    return urlunparse((parsed.scheme, netloc, parsed.path, "", query, fragment))
