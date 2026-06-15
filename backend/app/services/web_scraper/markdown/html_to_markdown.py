# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTML-to-Markdown conversion using existing backend dependencies."""

from urllib.parse import urljoin

from bs4 import BeautifulSoup
from html2text import HTML2Text

BODY_WIDTH_NO_WRAP = 0


class HtmlToMarkdownConverter:
    """Convert cleaned HTML fragments to Markdown."""

    def to_markdown(self, html: str, base_url: str | None = None) -> str:
        """Convert HTML to Markdown while preserving basic structure."""
        if not html:
            return ""

        soup = BeautifulSoup(html, "html.parser")
        for tag in soup.find_all(["script", "style", "noscript"]):
            tag.decompose()

        if base_url:
            for link in soup.find_all("a", href=True):
                link["href"] = urljoin(base_url, link["href"])

        # Keep paragraphs unwrapped so Markdown remains stable for indexing.
        converter = HTML2Text()
        converter.body_width = BODY_WIDTH_NO_WRAP
        converter.ignore_images = True
        converter.ignore_emphasis = False
        converter.ignore_links = False
        converter.protect_links = False
        converter.mark_code = True

        return converter.handle(str(soup)).strip()
