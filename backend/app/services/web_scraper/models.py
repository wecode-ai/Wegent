# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal models and error codes for web scraper orchestration."""

from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field

ERROR_INVALID_URL = "INVALID_URL_FORMAT"
ERROR_FETCH_FAILED = "FETCH_FAILED"
ERROR_FETCH_TIMEOUT = "FETCH_TIMEOUT"
ERROR_PARSE_FAILED = "PARSE_FAILED"
ERROR_EMPTY_CONTENT = "EMPTY_CONTENT"
ERROR_AUTH_REQUIRED = "AUTH_REQUIRED"
ERROR_RATE_LIMITED = "RATE_LIMITED"
ERROR_FETCH_BLOCKED = "FETCH_BLOCKED"
ERROR_SSRF_BLOCKED = "SSRF_BLOCKED"
ERROR_CRAWL4AI_NOT_INSTALLED = "CRAWL4AI_NOT_INSTALLED"


class ScrapeStatus(str, Enum):
    """Classified scrape status."""

    OK = "ok"
    EMPTY = "empty"
    LOW_QUALITY = "low_quality"
    BLOCKED = "blocked"
    AUTH_REQUIRED = "auth_required"
    RATE_LIMITED = "rate_limited"
    REDIRECT_BLOCKED = "redirect_blocked"
    SSRF_BLOCKED = "ssrf_blocked"
    NETWORK_FAILED = "network_failed"
    TIMEOUT = "timeout"


class SourcePart(BaseModel):
    """One extracted source fragment."""

    title: Optional[str] = None
    url: Optional[str] = None
    markdown: str = ""
    text_length: int = 0
    method: Literal[
        "crawl4ai",
        "pdf",
        "playwright_html",
        "playwright_text",
    ]
    quality_level: Literal["structured", "degraded"] = "structured"


class ScrapeDecision(BaseModel):
    """Classifier decision for an internal scrape result."""

    status: ScrapeStatus
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    should_try_fallback: bool = False
    is_pdf: bool = False


class MarkdownQuality(BaseModel):
    """Markdown quality assessment."""

    acceptable: bool
    quality_level: Literal["structured", "degraded", "rejected"]
    reason: Optional[str] = None
    text_length: int = 0
    link_count: int = 0
    heading_count: int = 0
    content_density: float = 0.0


class InternalScrapeResult(BaseModel):
    """Internal result produced by scraper strategies."""

    url: str
    final_url: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    markdown: str = ""
    content_type: Optional[str] = None
    status_code: Optional[int] = None
    success: bool = True
    error_message: Optional[str] = None
    security_error_code: Optional[str] = None
    response_headers: dict[str, str] = Field(default_factory=dict)
    extraction_method: Literal[
        "crawl4ai",
        "pdf",
        "playwright_html",
        "playwright_text",
    ] = "crawl4ai"
    quality_level: Literal["structured", "degraded"] = "structured"
    source_parts: list[SourcePart] = Field(default_factory=list)


STATUS_ERROR_CODE_MAP = {
    ScrapeStatus.BLOCKED: ERROR_FETCH_BLOCKED,
    ScrapeStatus.AUTH_REQUIRED: ERROR_AUTH_REQUIRED,
    ScrapeStatus.RATE_LIMITED: ERROR_RATE_LIMITED,
    ScrapeStatus.REDIRECT_BLOCKED: ERROR_SSRF_BLOCKED,
    ScrapeStatus.SSRF_BLOCKED: ERROR_SSRF_BLOCKED,
    ScrapeStatus.EMPTY: ERROR_EMPTY_CONTENT,
    ScrapeStatus.LOW_QUALITY: ERROR_EMPTY_CONTENT,
    ScrapeStatus.TIMEOUT: ERROR_FETCH_TIMEOUT,
    ScrapeStatus.NETWORK_FAILED: ERROR_FETCH_FAILED,
}
