# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Classify web scrape results for error mapping and fallback decisions."""

from app.services.web_scraper.constants import (
    AUTH_KEYWORDS,
    BLOCKED_KEYWORDS,
    RATE_LIMIT_KEYWORDS,
)
from app.services.web_scraper.models import (
    ERROR_EMPTY_CONTENT,
    ERROR_FETCH_FAILED,
    ERROR_FETCH_TIMEOUT,
    ERROR_SSRF_BLOCKED,
    STATUS_ERROR_CODE_MAP,
    InternalScrapeResult,
    MarkdownQuality,
    ScrapeDecision,
    ScrapeStatus,
)
from app.services.web_scraper.policy import ScrapePolicy


class ScrapeResultClassifier:
    """Classify internal scrape results."""

    def classify(
        self,
        result: InternalScrapeResult,
        quality: MarkdownQuality | None = None,
    ) -> ScrapeDecision:
        """Classify an internal result."""
        is_pdf = self._is_pdf_content_type(result.content_type)

        if result.security_error_code:
            return ScrapeDecision(
                status=ScrapeStatus.SSRF_BLOCKED,
                error_code=ERROR_SSRF_BLOCKED,
                error_message=result.error_message,
                is_pdf=is_pdf,
            )

        if result.status_code == 401:
            return self._decision(ScrapeStatus.AUTH_REQUIRED, result, is_pdf)
        if result.status_code == 429:
            return self._decision(ScrapeStatus.RATE_LIMITED, result, is_pdf)
        if result.status_code in {403, 503}:
            return self._decision(ScrapeStatus.BLOCKED, result, is_pdf)

        if not result.success:
            if self._looks_like_timeout(result.error_message):
                return ScrapeDecision(
                    status=ScrapeStatus.TIMEOUT,
                    error_code=ERROR_FETCH_TIMEOUT,
                    error_message=result.error_message,
                    is_pdf=is_pdf,
                )
            if self._has_successful_http_status(result.status_code):
                return ScrapeDecision(
                    status=ScrapeStatus.EMPTY,
                    error_code=ERROR_EMPTY_CONTENT,
                    error_message="No extractable content found on the page",
                    should_try_fallback=True,
                    is_pdf=is_pdf,
                )
            return ScrapeDecision(
                status=ScrapeStatus.NETWORK_FAILED,
                error_code=ERROR_FETCH_FAILED,
                error_message=result.error_message,
                is_pdf=is_pdf,
            )

        text = " ".join(
            part for part in [result.title, result.final_url, result.markdown] if part
        ).lower()
        if self._contains_keyword(text, RATE_LIMIT_KEYWORDS):
            return self._decision(ScrapeStatus.RATE_LIMITED, result, is_pdf)
        if self._contains_keyword(text, AUTH_KEYWORDS):
            return self._decision(ScrapeStatus.AUTH_REQUIRED, result, is_pdf)
        if self._contains_keyword(text, BLOCKED_KEYWORDS):
            return self._decision(ScrapeStatus.BLOCKED, result, is_pdf)

        if not result.markdown or not result.markdown.strip():
            return ScrapeDecision(
                status=ScrapeStatus.EMPTY,
                error_code=ERROR_EMPTY_CONTENT,
                error_message="No extractable content found on the page",
                should_try_fallback=True,
                is_pdf=is_pdf,
            )

        if quality and not quality.acceptable:
            return ScrapeDecision(
                status=ScrapeStatus.LOW_QUALITY,
                error_code=ERROR_EMPTY_CONTENT,
                error_message="Extracted content quality is too low",
                should_try_fallback=True,
                is_pdf=is_pdf,
            )

        return ScrapeDecision(status=ScrapeStatus.OK, is_pdf=is_pdf)

    def should_use_playwright_fallback(
        self,
        decision: ScrapeDecision,
        quality: MarkdownQuality | None,
        policy: ScrapePolicy,
    ) -> bool:
        """Return whether Playwright fallback should be attempted."""
        if not policy.fallback_enabled:
            return False
        if decision.status in {ScrapeStatus.EMPTY, ScrapeStatus.LOW_QUALITY}:
            return policy.fallback_on_empty or policy.deep_iframe_extraction
        if decision.status == ScrapeStatus.BLOCKED:
            return policy.fallback_on_blocked
        if decision.status == ScrapeStatus.OK and quality and not quality.acceptable:
            return policy.fallback_on_empty
        return False

    def _decision(
        self,
        status: ScrapeStatus,
        result: InternalScrapeResult,
        is_pdf: bool,
    ) -> ScrapeDecision:
        return ScrapeDecision(
            status=status,
            error_code=STATUS_ERROR_CODE_MAP.get(status),
            error_message=result.error_message or self._default_message(status),
            should_try_fallback=status in {ScrapeStatus.EMPTY, ScrapeStatus.BLOCKED},
            is_pdf=is_pdf,
        )

    def _default_message(self, status: ScrapeStatus) -> str:
        messages = {
            ScrapeStatus.AUTH_REQUIRED: "Authentication required",
            ScrapeStatus.RATE_LIMITED: "Request was rate limited",
            ScrapeStatus.BLOCKED: "Request was blocked by the target site",
        }
        return messages.get(status, "Failed to scrape page")

    def _is_pdf_content_type(self, content_type: str | None) -> bool:
        return bool(content_type and "application/pdf" in content_type.lower())

    def _contains_keyword(self, text: str, keywords: tuple[str, ...]) -> bool:
        return any(keyword in text for keyword in keywords)

    def _looks_like_timeout(self, error_message: str | None) -> bool:
        return bool(error_message and "timeout" in error_message.lower())

    def _has_successful_http_status(self, status_code: int | None) -> bool:
        """Whether the page was reachable with a successful HTTP response.

        A 2xx response with a failed extraction means the content is present
        but unreachable by the primary strategy (e.g. nested iframes), so the
        Playwright fallback is worth attempting.
        """
        return status_code is not None and 200 <= status_code < 300
