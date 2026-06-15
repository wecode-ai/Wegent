# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Conservative HTML and Markdown cleaning helpers."""

import re

from bs4 import BeautifulSoup

from app.services.web_scraper.policy import ScrapePolicy

LOW_VALUE_TAGS = (
    "script",
    "style",
    "noscript",
    "nav",
    "footer",
    "form",
    "input",
    "button",
    "select",
    "textarea",
)
OPTIONAL_LOW_VALUE_TAGS = ("header", "aside")
MIN_DEDUP_LINE_LENGTH = 12
MAX_ALLOWED_REPEATS = 2
SHORT_CHROME_TEXT_LENGTH = 120


class MarkdownCleaner:
    """Clean HTML and Markdown without aggressively deleting possible body text."""

    def clean_html(self, html: str, policy: ScrapePolicy | None = None) -> str:
        """Remove obvious non-content elements from HTML."""
        if not html:
            return ""

        soup = BeautifulSoup(html, "html.parser")
        for tag in soup.find_all(LOW_VALUE_TAGS):
            tag.decompose()

        for tag in soup.find_all(OPTIONAL_LOW_VALUE_TAGS):
            if self._looks_like_short_chrome(tag.get_text(" ", strip=True)):
                tag.decompose()

        return str(soup)

    def clean_markdown(self, markdown: str, policy: ScrapePolicy | None = None) -> str:
        """Normalize Markdown and remove repeated lines conservatively."""
        if not markdown:
            return ""

        normalized = markdown.replace("\r\n", "\n").replace("\r", "\n")
        normalized = re.sub(r"\n{3,}", "\n\n", normalized)
        lines = [line.rstrip() for line in normalized.splitlines()]

        cleaned_lines = []
        seen_counts = {}
        for line in lines:
            stripped = line.strip()
            if not stripped:
                cleaned_lines.append("")
                continue
            if len(stripped) > MIN_DEDUP_LINE_LENGTH:
                seen_counts[stripped] = seen_counts.get(stripped, 0) + 1
                if seen_counts[stripped] > MAX_ALLOWED_REPEATS:
                    continue
            cleaned_lines.append(line)

        return "\n".join(cleaned_lines).strip()

    def clean_plain_text(self, text: str, policy: ScrapePolicy | None = None) -> str:
        """Convert plain text into basic degraded Markdown."""
        if not text:
            return ""

        lines = [
            line.strip()
            for line in text.replace("\r\n", "\n").replace("\r", "\n").splitlines()
        ]
        paragraphs = []
        buffer = []
        for line in lines:
            if line:
                buffer.append(line)
            elif buffer:
                paragraphs.append(" ".join(buffer))
                buffer = []
        if buffer:
            paragraphs.append(" ".join(buffer))

        markdown = "\n\n".join(paragraphs)
        return self.clean_markdown(markdown, policy)

    def _looks_like_short_chrome(self, text: str) -> bool:
        if not text:
            return True
        return len(text) < SHORT_CHROME_TEXT_LENGTH
