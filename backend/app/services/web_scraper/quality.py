# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Markdown quality evaluation for scraped content."""

import re
from typing import Literal

from app.services.web_scraper.constants import (
    AUTH_KEYWORDS,
    BLOCKED_KEYWORDS,
    RATE_LIMIT_KEYWORDS,
)
from app.services.web_scraper.models import MarkdownQuality
from app.services.web_scraper.policy import ScrapePolicy

WORD_PATTERN = re.compile(r"[\w\u4e00-\u9fff]+")
DENSITY_NORMALIZATION_FACTOR = 20
MIN_LINE_LENGTH_FOR_REPETITION = 8
MIN_TOTAL_LINES_FOR_REPETITION = 8
UNIQUE_RATIO_THRESHOLD = 0.35
InputQualityLevel = Literal["structured", "degraded"]


class MarkdownQualityEvaluator:
    """Evaluate whether Markdown is suitable for indexing."""

    def evaluate(
        self,
        markdown: str,
        policy: ScrapePolicy,
        quality_level: InputQualityLevel = "structured",
    ) -> MarkdownQuality:
        """Evaluate Markdown quality."""
        text = markdown.strip()
        text_length = len(text)
        heading_count = len(re.findall(r"^#{1,6}\s+", text, flags=re.MULTILINE))
        link_count = len(re.findall(r"\[[^\]]+\]\([^)]+\)", text))
        density = self._content_density(text)

        if not text:
            return self._reject(
                "empty", quality_level, text_length, link_count, heading_count, density
            )

        lower_text = text.lower()
        if self._contains_error_shell(lower_text):
            return self._reject(
                "blocked_or_auth_shell",
                quality_level,
                text_length,
                link_count,
                heading_count,
                density,
            )

        if text_length < policy.min_markdown_chars:
            return self._reject(
                "too_short",
                quality_level,
                text_length,
                link_count,
                heading_count,
                density,
            )

        if density < policy.min_content_density:
            return self._reject(
                "low_content_density",
                quality_level,
                text_length,
                link_count,
                heading_count,
                density,
            )

        if self._has_excessive_repetition(text):
            return self._reject(
                "excessive_repetition",
                quality_level,
                text_length,
                link_count,
                heading_count,
                density,
            )

        return MarkdownQuality(
            acceptable=True,
            quality_level=(
                quality_level if quality_level == "degraded" else "structured"
            ),
            text_length=text_length,
            link_count=link_count,
            heading_count=heading_count,
            content_density=density,
        )

    def _reject(
        self,
        reason: str,
        quality_level: InputQualityLevel,
        text_length: int,
        link_count: int,
        heading_count: int,
        density: float,
    ) -> MarkdownQuality:
        return MarkdownQuality(
            acceptable=False,
            quality_level="rejected" if quality_level != "degraded" else "degraded",
            reason=reason,
            text_length=text_length,
            link_count=link_count,
            heading_count=heading_count,
            content_density=density,
        )

    def _contains_error_shell(self, lower_text: str) -> bool:
        keywords = BLOCKED_KEYWORDS + AUTH_KEYWORDS + RATE_LIMIT_KEYWORDS
        return any(keyword in lower_text for keyword in keywords)

    def _content_density(self, text: str) -> float:
        if not text:
            return 0.0
        words = WORD_PATTERN.findall(text)
        return min(len(words) / max(len(text) / DENSITY_NORMALIZATION_FACTOR, 1), 1.0)

    def _has_excessive_repetition(self, text: str) -> bool:
        lines = [
            line.strip()
            for line in text.splitlines()
            if len(line.strip()) > MIN_LINE_LENGTH_FOR_REPETITION
        ]
        if len(lines) < MIN_TOTAL_LINES_FOR_REPETITION:
            return False
        unique_ratio = len(set(lines)) / len(lines)
        return unique_ratio < UNIQUE_RATIO_THRESHOLD
