# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sanitize inline binary payloads before text chunking and embedding."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

BASE64_DATA_PAYLOAD_PATTERN = (
    r"[A-Za-z0-9+/=_-]+(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/=_-]+)*"
)

MARKDOWN_IMAGE_DATA_URL_PATTERN = re.compile(
    rf"!\[(?P<alt>[^\]]*)\]\(\s*(?P<url>data:image/[^)\s]+;base64,{BASE64_DATA_PAYLOAD_PATTERN})\s*\)",
    re.IGNORECASE,
)
DATA_URL_PATTERN = re.compile(
    rf"data:(?P<mime>[-\w.+/]+)(?:;[-\w=]+)*;base64,(?P<data>{BASE64_DATA_PAYLOAD_PATTERN})",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class SanitizedTextResult:
    """Sanitized text plus replacement accounting."""

    text: str
    replacements_count: int
    replacement_summary: dict[str, int]


def sanitize_text_for_indexing(
    text: str,
    *,
    sanitize_inline_images: bool = True,
) -> SanitizedTextResult:
    """Replace inline binary payloads with readable placeholders."""
    if not text:
        return SanitizedTextResult(
            text=text or "",
            replacements_count=0,
            replacement_summary={},
        )

    counters: Counter[str] = Counter()
    sanitized_text = text

    def replace_markdown_image(match: re.Match[str]) -> str:
        counters["inline_image"] += 1
        alt = match.group("alt").strip()
        if alt:
            return f"![{alt}]([inline image omitted])"
        return "[inline image omitted]"

    def replace_data_url(match: re.Match[str]) -> str:
        mime_type = match.group("mime").lower()
        if mime_type.startswith("image/"):
            if not sanitize_inline_images:
                return match.group(0)
            counters["inline_image"] += 1
            return "[inline image omitted]"
        if mime_type == "application/pdf":
            counters["inline_pdf"] += 1
            return "[inline pdf omitted]"
        counters["embedded_binary"] += 1
        return "[embedded binary content omitted]"

    if sanitize_inline_images:
        sanitized_text = MARKDOWN_IMAGE_DATA_URL_PATTERN.sub(
            replace_markdown_image, sanitized_text
        )
    sanitized_text = DATA_URL_PATTERN.sub(replace_data_url, sanitized_text)

    return SanitizedTextResult(
        text=sanitized_text,
        replacements_count=sum(counters.values()),
        replacement_summary=dict(counters),
    )
