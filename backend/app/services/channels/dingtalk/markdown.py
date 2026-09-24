# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers to normalize content for DingTalk markdown rendering."""

import logging

logger = logging.getLogger(__name__)


def ensure_markdown(content: str) -> str:
    """Convert HTML fragments to Markdown for DingTalk message fields.

    DingTalk markdown surfaces (AI card markdown component, sampleMarkdown,
    custom-robot webhook) render only Markdown syntax; raw HTML is shown
    verbatim. Model outputs occasionally contain styled HTML tables, so
    normalize them before sending. Non-HTML content is returned unchanged.
    """
    if not content or not _looks_like_html(content):
        return content

    try:
        from html2text import HTML2Text

        converter = HTML2Text()
        converter.body_width = 0  # Keep lines unwrapped for DingTalk rendering
        converter.ignore_links = False
        converter.ignore_images = False
        converter.ignore_emphasis = False
        converted = converter.handle(content).strip()
        if converted:
            return converted
    except Exception:
        logger.warning(
            "[DingTalk] Failed to convert HTML to markdown, sending raw content",
            exc_info=True,
        )
    return content


def _looks_like_html(content: str) -> bool:
    """Detect whether content contains HTML tags worth converting."""
    if "<" not in content or ">" not in content:
        return False
    try:
        from bs4 import BeautifulSoup

        return BeautifulSoup(content, "html.parser").find() is not None
    except Exception:
        return False
