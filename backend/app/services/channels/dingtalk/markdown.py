# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Neutralise Markdown syntax in text a notification's recipient did not write."""

# Markdown control characters that could turn a member's own words into a link,
# an image or emphasis inside the bot's message. Links need their brackets and
# the rest carry the markup, so escaping these characters disarms the text
# while ordinary punctuation — parentheses, dates, dashes — stays readable.
_MARKDOWN_ESCAPES = str.maketrans({char: f"\\{char}" for char in "\\`*_~[]!<>"})


def escape_markdown(text: str) -> str:
    """Neutralise Markdown syntax in text the recipient's peer controls."""

    return text.translate(_MARKDOWN_ESCAPES)
