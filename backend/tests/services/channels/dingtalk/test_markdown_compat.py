# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalk Markdown compatibility rendering."""

from app.services.channels.dingtalk.markdown_compat import render_for_dingtalk


class TestTableConversion:
    def test_plain_text_unchanged(self):
        content = "好的，这是一个示例：\n\n- 第一项\n- 第二项\n"
        assert render_for_dingtalk(content) == content

    def test_supported_markdown_unchanged(self):
        content = "# 标题\n\n**加粗** 和 [链接](https://example.com)\n\n> 引用\n"
        assert render_for_dingtalk(content) == content

    def test_table_converted_to_aligned_code_block(self):
        content = (
            "表格如下：\n"
            "| 学生 | 年龄 | 性别 |\n"
            "| --- | --- | --- |\n"
            "| 张伟 | 18 | 男 |\n"
            "| 李娜 | 19 | 女 |\n"
            "完"
        )
        result = render_for_dingtalk(content)
        assert result.startswith("表格如下：\n```\n")
        assert result.endswith("```\n完")
        lines = result.split("\n")
        assert "|" not in lines[1:-1][0] or lines[1] == "```"
        body = lines[2:6]
        assert body[0].startswith("学生")
        assert set(body[1].replace("-", "").replace("+", "")) == set()
        # CJK header and ASCII body columns align to the same display width
        assert body[2].index("18") == body[0].index("年龄")

    def test_table_without_surrounding_pipes(self):
        content = "| a | b |\n|---|---|\n| 1 | 2 |"
        result = render_for_dingtalk(content)
        assert "```" in result
        assert "a | b" in result

    def test_separator_variants(self):
        content = "| a | b |\n| :--- | ---: |\n| 1 | 2 |"
        result = render_for_dingtalk(content)
        assert "```\na" in result

    def test_streaming_partial_table_untouched(self):
        # Header arrived but separator row has not streamed yet
        content = "| 学生 | 年龄 |\n"
        assert render_for_dingtalk(content) == content

    def test_table_inside_code_fence_preserved(self):
        content = "示例：\n```markdown\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n"
        assert render_for_dingtalk(content) == content

    def test_multiple_tables(self):
        content = "| a |\n| - |\n| 1 |\n" "\n中间文字\n\n" "| c |\n| - |\n| 3 |"
        result = render_for_dingtalk(content)
        assert result.count("```") == 4
        assert "中间文字" in result

    def test_uneven_row_lengths(self):
        content = "| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 | 4 |"
        result = render_for_dingtalk(content)
        assert "```" in result
        assert "4" in result

    def test_no_pipe_fast_path(self):
        content = "没有任何表格的纯文本" * 100
        assert render_for_dingtalk(content) == content

    def test_escaped_pipe_stays_in_cell(self):
        content = "| a | b |\n| --- | --- |\n| x \\| y | 2 |"
        result = render_for_dingtalk(content)
        row = [line for line in result.split("\n") if "x" in line][0]
        # The escaped pipe remains a literal cell value, not a delimiter
        assert "x | y" in row
        assert row.count("|") == 2  # two column separators only

    def test_double_backslash_pipe_is_delimiter(self):
        # "\\\\|" escapes the backslash, so the pipe still splits cells
        content = "| a | b |\n| --- | --- |\n| x \\\\| y |"
        result = render_for_dingtalk(content)
        row = [line for line in result.split("\n") if "x" in line][0]
        assert row.startswith("x \\\\ | y")  # two cells: 'x \\' and 'y'

    def test_nested_shorter_fence_does_not_close(self):
        content = (
            "````\n"
            "```\n"  # nested shorter fence must not end the block
            "| a | b |\n"
            "| --- | --- |\n"
            "| 1 | 2 |\n"
            "````\n"
        )
        assert render_for_dingtalk(content) == content

    def test_tilde_fence_not_closed_by_backticks(self):
        content = "~~~\n```\n| a |\n| - |\n| 1 |\n~~~\n"
        assert render_for_dingtalk(content) == content
