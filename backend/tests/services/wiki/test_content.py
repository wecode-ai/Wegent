# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for wiki markdown content helpers."""

from app.services.wiki.content import (
    extract_outline,
    slice_section,
    truncate_content,
)

PAGE = """# Title

Intro paragraph.

## Storage

Storage overview.

### Object storage

Object details.

## Compute

Compute overview.
"""


class TestExtractOutline:
    def test_returns_headings_in_order(self):
        outline = extract_outline(PAGE)
        assert [(item.level, item.title) for item in outline] == [
            (1, "Title"),
            (2, "Storage"),
            (3, "Object storage"),
            (2, "Compute"),
        ]

    def test_empty_content(self):
        assert extract_outline("") == []


class TestSliceSection:
    def test_section_includes_children(self):
        section = slice_section(PAGE, "Storage")
        assert section is not None
        assert section.startswith("## Storage")
        assert "### Object storage" in section
        assert "Compute" not in section

    def test_section_stops_at_same_level(self):
        section = slice_section(PAGE, "Compute")
        assert section is not None
        assert "Storage" not in section

    def test_no_match_returns_none(self):
        assert slice_section(PAGE, "Missing Heading") is None
        assert slice_section(PAGE, "") is None

    def test_match_is_case_insensitive(self):
        assert slice_section(PAGE, "storage") is not None


class TestTruncateContent:
    def test_short_content_not_truncated(self):
        body, truncated, total = truncate_content("abcdef", 10)
        assert (body, truncated, total) == ("abcdef", False, 6)

    def test_long_content_truncated(self):
        body, truncated, total = truncate_content("a" * 100, 10)
        assert (truncated, total) == (True, 100)
        assert len(body) == 10
