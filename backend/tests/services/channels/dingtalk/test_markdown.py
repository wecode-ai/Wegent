# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalk markdown normalization."""

import sys
from unittest.mock import patch

from app.services.channels.dingtalk.markdown import ensure_markdown


class TestEnsureMarkdown:
    """ensure_markdown converts HTML to Markdown and keeps plain Markdown intact."""

    def test_plain_markdown_unchanged(self) -> None:
        # Arrange
        content = "### 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n**加粗** 和 [链接](https://example.com)"

        # Act
        result = ensure_markdown(content)

        # Assert
        assert result == content

    def test_empty_content_unchanged(self) -> None:
        # Arrange / Act / Assert
        assert ensure_markdown("") == ""

    def test_html_table_converted_to_markdown(self) -> None:
        # Arrange
        content = (
            '<div style="width:980px;">'
            "<h2>人机审核概况</h2>"
            "<table><thead><tr><th>业务</th><th>结论</th></tr></thead>"
            "<tbody><tr><td>博文</td><td>波动正常</td></tr></tbody>"
            "</table></div>"
        )

        # Act
        result = ensure_markdown(content)

        # Assert
        assert "<" not in result
        assert "人机审核概况" in result
        assert "博文" in result
        assert "波动正常" in result
        assert "|" in result  # rendered as a Markdown table

    def test_html_link_and_image_preserved(self) -> None:
        # Arrange
        content = '<p>详见 <a href="https://example.com/detail">链接</a></p>'

        # Act
        result = ensure_markdown(content)

        # Assert
        assert "[链接](https://example.com/detail)" in result

    def test_non_html_angle_brackets_unchanged(self) -> None:
        # Arrange
        content = "比较结果: 1 < 2 且 3 > 2"

        # Act
        result = ensure_markdown(content)

        # Assert
        assert result == content

    def test_conversion_failure_returns_original(self) -> None:
        # Arrange
        content = "<div><table><tr><td>x</td></tr></table></div>"

        # Act
        with patch.dict(sys.modules, {"html2text": None}):
            result = ensure_markdown(content)

        # Assert
        assert result == content
