# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KnowledgeContentCleaner functionality.

These tests ensure that the content cleaner properly preserves important content
(URLs, code blocks, emails) while cleaning unnecessary elements (HTML, whitespace).
"""

import pytest

from chat_shell.tools.knowledge_content_cleaner import KnowledgeContentCleaner


class TestKnowledgeContentCleaner:
    """Test KnowledgeContentCleaner functionality."""

    def setup_method(self):
        self.cleaner = KnowledgeContentCleaner()

    # URL preservation tests
    def test_urls_are_preserved(self):
        """URLs should NOT be removed from content."""
        content = "访问 http://minio.internal.com 获取详情"
        cleaned = self.cleaner.clean_content(content)
        assert "http://minio.internal.com" in cleaned

    def test_internal_urls_preserved(self):
        """Internal URLs should be preserved."""
        content = "[[ 地址：http://minio.tomas.com ]]"
        cleaned = self.cleaner.clean_content(content)
        assert "http://minio.tomas.com" in cleaned

    def test_https_urls_preserved(self):
        """HTTPS URLs should be preserved."""
        content = "文档地址: https://docs.example.com/api/v1"
        cleaned = self.cleaner.clean_content(content)
        assert "https://docs.example.com/api/v1" in cleaned

    def test_urls_with_query_params_preserved(self):
        """URLs with query parameters should be preserved."""
        content = "链接: https://api.example.com/search?q=test&page=1"
        cleaned = self.cleaner.clean_content(content)
        assert "https://api.example.com/search?q=test&page=1" in cleaned

    def test_multiple_urls_preserved(self):
        """Multiple URLs should all be preserved."""
        content = "参考 http://a.com 和 https://b.com 两个地址"
        cleaned = self.cleaner.clean_content(content)
        assert "http://a.com" in cleaned
        assert "https://b.com" in cleaned

    # Code block preservation tests
    def test_code_blocks_are_preserved(self):
        """Code blocks should NOT be removed."""
        content = "示例代码：\n```python\nprint('hello')\n```"
        cleaned = self.cleaner.clean_content(content)
        assert "```python" in cleaned
        assert "print('hello')" in cleaned

    def test_inline_code_is_preserved(self):
        """Inline code should NOT be removed."""
        content = "使用 `kubectl get pods` 命令"
        cleaned = self.cleaner.clean_content(content)
        assert "`kubectl get pods`" in cleaned

    def test_multiline_code_block_preserved(self):
        """Multiline code blocks should be preserved."""
        content = """```yaml
server:
  host: localhost
  port: 8080
```"""
        cleaned = self.cleaner.clean_content(content)
        assert "```yaml" in cleaned
        assert "host: localhost" in cleaned
        assert "port: 8080" in cleaned

    def test_code_block_with_url_preserved(self):
        """Code blocks containing URLs should preserve both."""
        content = "示例：`curl http://api.internal.com/health`"
        cleaned = self.cleaner.clean_content(content)
        assert "`curl http://api.internal.com/health`" in cleaned

    # Email preservation tests
    def test_emails_are_preserved(self):
        """Email addresses should NOT be removed."""
        content = "联系人：admin@company.com"
        cleaned = self.cleaner.clean_content(content)
        assert "admin@company.com" in cleaned

    def test_multiple_emails_preserved(self):
        """Multiple email addresses should all be preserved."""
        content = "联系 user1@example.com 或 user2@example.org"
        cleaned = self.cleaner.clean_content(content)
        assert "user1@example.com" in cleaned
        assert "user2@example.org" in cleaned

    # Punctuation normalization tests
    def test_repeated_exclamation_normalized(self):
        """!!! should become ! (not .)"""
        content = "注意!!!"
        cleaned = self.cleaner.clean_content(content)
        assert "注意!" in cleaned
        assert "注意." not in cleaned
        assert "!!!" not in cleaned

    def test_repeated_question_normalized(self):
        """??? should become ? (not .)"""
        content = "真的吗???"
        cleaned = self.cleaner.clean_content(content)
        assert "真的吗?" in cleaned
        assert "真的吗." not in cleaned
        assert "???" not in cleaned

    def test_repeated_period_normalized(self):
        """... should become ."""
        content = "等等..."
        cleaned = self.cleaner.clean_content(content)
        assert cleaned.endswith(".")
        assert "..." not in cleaned

    def test_mixed_punctuation_preserved(self):
        """Mixed punctuation like ?! or !? should be preserved."""
        content = "真的吗?!"
        cleaned = self.cleaner.clean_content(content)
        # Mixed punctuation should remain as-is (not normalized)
        assert "?!" in cleaned

    def test_exclamation_then_question_preserved(self):
        """!? should be preserved as mixed punctuation."""
        content = "不可能!?"
        cleaned = self.cleaner.clean_content(content)
        assert "!?" in cleaned

    def test_single_punctuation_unchanged(self):
        """Single punctuation marks should not be modified."""
        content = "这是问题? 这是感叹! 这是句号."
        cleaned = self.cleaner.clean_content(content)
        assert "问题?" in cleaned
        assert "感叹!" in cleaned
        assert "句号." in cleaned

    # HTML cleaning tests (preserved functionality)
    def test_html_tags_removed(self):
        """HTML tags should be removed."""
        content = "<p>段落</p><div>内容</div>"
        cleaned = self.cleaner.clean_content(content)
        assert "<p>" not in cleaned
        assert "</p>" not in cleaned
        assert "<div>" not in cleaned
        assert "段落" in cleaned
        assert "内容" in cleaned

    def test_html_entities_removed(self):
        """HTML entities should be removed."""
        content = "空格&nbsp;和&lt;符号"
        cleaned = self.cleaner.clean_content(content)
        assert "&nbsp;" not in cleaned
        assert "&lt;" not in cleaned

    def test_complex_html_removed(self):
        """Complex HTML with attributes should be removed."""
        content = '<a href="http://example.com" class="link">点击这里</a>'
        cleaned = self.cleaner.clean_content(content)
        assert "<a" not in cleaned
        assert "</a>" not in cleaned
        assert "点击这里" in cleaned
        # URL in href attribute is removed with the tag
        # but URLs in text content are preserved

    # Whitespace normalization tests (preserved functionality)
    def test_whitespace_normalized(self):
        """Multiple whitespace should be normalized."""
        content = "多个   空格   和\n\n换行"
        cleaned = self.cleaner.clean_content(content)
        assert "   " not in cleaned
        # All whitespace (spaces, newlines) are normalized to single space
        assert "多个 空格 和" in cleaned

    def test_tabs_normalized(self):
        """Tabs should be normalized to single space."""
        content = "有\t\t制表符"
        cleaned = self.cleaner.clean_content(content)
        assert "\t" not in cleaned
        # Tabs are normalized to single space
        assert "有" in cleaned
        assert "制表符" in cleaned

    def test_leading_trailing_whitespace_stripped(self):
        """Leading and trailing whitespace should be stripped."""
        content = "   内容前后有空格   "
        cleaned = self.cleaner.clean_content(content)
        assert cleaned == "内容前后有空格"

    # Non-printable character tests
    def test_non_printable_removed(self):
        """Non-printable characters should be removed."""
        content = "正常文本\x00包含\x1f控制字符"
        cleaned = self.cleaner.clean_content(content)
        assert "\x00" not in cleaned
        assert "\x1f" not in cleaned
        assert "正常文本" in cleaned
        assert "控制字符" in cleaned

    # Complex content tests
    def test_complex_content_preserved(self):
        """Complex content with URLs, code, and email should be preserved."""
        content = """
        服务地址: http://api.internal.com
        联系人: admin@company.com

        配置示例:
        ```yaml
        server:
          host: localhost
          port: 8080
        ```

        使用 `curl http://api.internal.com/health` 检查服务状态。
        """
        cleaned = self.cleaner.clean_content(content)
        assert "http://api.internal.com" in cleaned
        assert "admin@company.com" in cleaned
        assert "```yaml" in cleaned
        assert "`curl http://api.internal.com/health`" in cleaned

    def test_mixed_html_and_content(self):
        """HTML should be removed while preserving URLs and code."""
        content = "<p>访问 http://example.com</p> 或运行 `npm install`"
        cleaned = self.cleaner.clean_content(content)
        assert "<p>" not in cleaned
        assert "</p>" not in cleaned
        assert "http://example.com" in cleaned
        assert "`npm install`" in cleaned

    # clean_knowledge_chunk tests
    def test_clean_knowledge_chunk_preserves_metadata(self):
        """clean_knowledge_chunk should preserve chunk metadata."""
        chunk = {
            "content": "访问 http://example.com 获取详情",
            "source": "test.md",
            "score": 0.85,
            "knowledge_base_id": 1,
        }
        cleaned_chunk = self.cleaner.clean_knowledge_chunk(chunk)

        assert "http://example.com" in cleaned_chunk["content"]
        assert cleaned_chunk["source"] == "test.md"
        assert cleaned_chunk["score"] == 0.85
        assert cleaned_chunk["knowledge_base_id"] == 1

    def test_clean_knowledge_chunk_handles_empty_content(self):
        """clean_knowledge_chunk should handle empty content gracefully."""
        chunk = {
            "content": "",
            "source": "empty.md",
            "score": 0.5,
        }
        cleaned_chunk = self.cleaner.clean_knowledge_chunk(chunk)
        assert cleaned_chunk["content"] == ""
        assert cleaned_chunk["source"] == "empty.md"

    def test_clean_knowledge_chunk_non_dict_returns_unchanged(self):
        """clean_knowledge_chunk should return non-dict input unchanged."""
        result = self.cleaner.clean_knowledge_chunk("not a dict")
        assert result == "not a dict"

    # clean_knowledge_chunks tests
    def test_clean_knowledge_chunks_multiple(self):
        """clean_knowledge_chunks should process multiple chunks."""
        chunks = [
            {"content": "URL: http://a.com", "source": "a.md"},
            {"content": "Email: test@example.com", "source": "b.md"},
        ]
        cleaned = self.cleaner.clean_knowledge_chunks(chunks)

        assert len(cleaned) == 2
        assert "http://a.com" in cleaned[0]["content"]
        assert "test@example.com" in cleaned[1]["content"]

    def test_clean_knowledge_chunks_empty_list(self):
        """clean_knowledge_chunks should handle empty list."""
        result = self.cleaner.clean_knowledge_chunks([])
        assert result == []

    # estimate_token_reduction tests
    def test_estimate_token_reduction(self):
        """estimate_token_reduction should return reasonable estimates."""
        content = "<p>正常内容</p>   多余空格"
        original, cleaned = self.cleaner.estimate_token_reduction(content)

        # Cleaned should have fewer or equal tokens
        assert cleaned <= original
        assert original > 0

    def test_estimate_token_reduction_empty(self):
        """estimate_token_reduction should handle empty content."""
        original, cleaned = self.cleaner.estimate_token_reduction("")
        assert original == 0
        assert cleaned == 0

    # Optional parameter tests
    def test_disable_html_removal(self):
        """Should be able to disable HTML removal."""
        content = "<p>保留HTML</p>"
        cleaned = self.cleaner.clean_content(content, remove_html=False)
        assert "<p>" in cleaned
        assert "</p>" in cleaned

    def test_disable_whitespace_normalization(self):
        """Should be able to disable whitespace normalization."""
        content = "多个   空格"
        cleaned = self.cleaner.clean_content(content, normalize_whitespace=False)
        assert "   " in cleaned

    def test_disable_punctuation_normalization(self):
        """Should be able to disable punctuation normalization."""
        content = "注意!!!"
        cleaned = self.cleaner.clean_content(content, normalize_punctuation=False)
        assert "!!!" in cleaned


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
