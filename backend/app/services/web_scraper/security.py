# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""URL safety guard for web scraping."""

import re
from urllib.parse import ParseResult, urljoin, urlparse, urlunparse

from app.services.url_metadata import _validate_url_for_ssrf
from app.services.web_scraper.models import ERROR_INVALID_URL, ERROR_SSRF_BLOCKED
from shared.utils.sensitive_data_masker import mask_string

_SECRET_FIELD = r"(?:token|(?:access|refresh|auth)[_-]?token|api[_-]?key|password|passwd|pwd|secret)"
_QUOTED_CREDENTIAL = re.compile(
    rf"""(["']?\b(?:authorization|{_SECRET_FIELD})\b["']?\s*[:=]\s*)"""
    r"""(["'])(?:\\.|(?!\2).)*(?:\2|$)""",
    re.IGNORECASE | re.DOTALL,
)
_AUTHORIZATION = re.compile(
    r"""(\bauthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)"""
    r"""[^\s"'`,;}\]]+""",
    re.IGNORECASE,
)
_BARE_CREDENTIAL = re.compile(
    rf"""(["']?\b{_SECRET_FIELD}\b["']?\s*[:=]\s*)[^\s"'`,;}}\]]+""",
    re.IGNORECASE,
)


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


def redact_scraper_text(text: str) -> str:
    """Redact URLs embedded in third-party messages before any output sink."""

    def redact(match: re.Match[str]) -> str:
        value = match.group()
        suffix = ""
        if match.start() and text[match.start() - 1] == "'":
            closing_quote = value.rfind("'")
            if closing_quote >= 0 and all(
                char in ",.;:)]}>" for char in value[closing_quote + 1 :]
            ):
                suffix = value[closing_quote:]
                value = value[:closing_quote]
        try:
            return redact_url_for_logging(value) + suffix
        except ValueError:
            return "<invalid-url>"

    redacted = re.sub(r"(?:https?|wss?)://[^\s\"`]+", redact, text, flags=re.IGNORECASE)
    redacted = _QUOTED_CREDENTIAL.sub(
        lambda match: match[1] + match[2] + "<redacted>" + match[2], redacted
    )
    redacted = _AUTHORIZATION.sub(r"\1<redacted>", redacted)
    redacted = _BARE_CREDENTIAL.sub(r"\1<redacted>", redacted)
    return mask_string(redacted)
