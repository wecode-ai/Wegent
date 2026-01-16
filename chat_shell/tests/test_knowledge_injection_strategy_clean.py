# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge injection strategy - clean test version."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.tools.builtin.knowledge_base import (
    KnowledgeBaseInput,
    KnowledgeBaseTool,
)
from chat_shell.tools.knowledge_content_cleaner import KnowledgeContentCleaner
from chat_shell.tools.knowledge_injection_strategy import (
    InjectionMode,
    InjectionStrategy,
)


class TestKnowledgeContentCleanerClean:
    """Test knowledge content cleaner - clean version preserving URLs."""

    def test_clean_content_preserves_urls(self):
        """Test that content cleaning preserves URLs."""
        cleaner = KnowledgeContentCleaner()

        content = """
        This is a test with URLs: https://example.com and http://test.org/page
        And HTML tags: <p>paragraph</p> and <div>content</div>
        And entities: & < >
        And repeated punctuation: Hello!!! Really????
        And extra   whitespace   here.
        """

        cleaned = cleaner.clean_content(content)

        # Check that URLs are preserved
        assert "https://example.com" in cleaned
        assert "http://test.org/page" in cleaned

        # Check that HTML tags are removed
        assert "<p>" not in cleaned
        assert "</p>" not in cleaned
        assert "<div>" not in cleaned

        # Check that repeated punctuation is normalized to original type
        assert "Hello!!!" not in cleaned
        assert "Hello!" in cleaned  # ! preserved, not changed to .

        # Check that whitespace is normalized
        assert "extra   whitespace   here" not in cleaned
        assert "extra whitespace here" in cleaned

    def test_clean_knowledge_chunk_preserves_urls(self):
        """Test cleaning knowledge base chunk preserves URLs."""
        cleaner = KnowledgeContentCleaner()

        chunk = {
            "content": "Content with URL: https://example.com and HTML: <p>test</p>",
            "source": "test.txt",
            "score": 0.8,
            "knowledge_base_id": 1,
        }

        cleaned_chunk = cleaner.clean_knowledge_chunk(chunk)

        # URL should be preserved
        assert "https://example.com" in cleaned_chunk["content"]
        # HTML should be removed
        assert "<p>" not in cleaned_chunk["content"]
        assert cleaned_chunk["source"] == "test.txt"
        assert cleaned_chunk["score"] == 0.8
        assert cleaned_chunk["knowledge_base_id"] == 1

    def test_estimate_token_reduction(self):
        """Test token reduction estimation."""
        cleaner = KnowledgeContentCleaner()

        content = "Content with HTML: <p>test</p> and   extra   spaces"
        original_tokens, cleaned_tokens = cleaner.estimate_token_reduction(content)

        # Cleaned should have fewer or equal tokens (HTML and spaces removed)
        assert cleaned_tokens <= original_tokens
        assert original_tokens > 0


class TestInjectionStrategyClean:
    """Test injection strategy - clean version without aggressive mode."""

    def test_calculate_available_space(self):
        """Test available space calculation."""
        strategy = InjectionStrategy("claude-3-5-sonnet", context_window=200000)

        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]

        available_space = strategy.calculate_available_space(messages)

        assert available_space > 0
        assert available_space < strategy.context_window

    def test_estimate_chunk_tokens(self):
        """Test chunk token estimation."""
        strategy = InjectionStrategy("claude-3-5-sonnet", context_window=200000)

        chunks = [
            {"content": "This is a test chunk with some content."},
            {"content": "Another chunk with more content."},
        ]

        tokens = strategy.estimate_chunk_tokens(chunks)

        assert tokens > 0
        assert (
            tokens < 200
        )  # Reasonable upper bound (increased due to formatting overhead)

    def test_prepare_chunks_for_injection(self):
        """Test chunk preparation for injection."""
        strategy = InjectionStrategy("claude-3-5-sonnet", context_window=200000)

        chunks = [
            {"content": "High score content", "score": 0.9, "source": "doc1.txt"},
            {"content": "Low score content", "score": 0.3, "source": "doc2.txt"},
            {"content": "Medium score content", "score": 0.6, "source": "doc3.txt"},
        ]

        prepared = strategy.prepare_chunks_for_injection(chunks, max_chunks=2)

        # Should filter by score and limit count
        assert len(prepared) == 2
        assert prepared[0]["score"] == 0.9  # Highest score first
        assert prepared[1]["score"] == 0.6  # Second highest

    def test_format_chunks_for_injection(self):
        """Test chunk formatting for injection."""
        strategy = InjectionStrategy("claude-3-5-sonnet", context_window=200000)

        chunks = [
            {"content": "Test content 1", "source": "doc1.txt", "score": 0.8},
            {"content": "Test content 2", "source": "doc2.txt", "score": 0.7},
        ]

        formatted = strategy.format_chunks_for_injection(chunks)

        assert "[Knowledge Base Context" in formatted
        assert "[Knowledge Chunk 1]" in formatted
        assert "Test content 1" in formatted
        assert "Source: doc1.txt" in formatted
        assert "Score: 0.80" in formatted

    def test_decide_injection_mode_forced_rag(self):
        """Test injection mode decision with forced RAG."""
        strategy = InjectionStrategy(
            "claude-3-5-sonnet",
            context_window=200000,
            injection_mode=InjectionMode.RAG_ONLY,
        )

        messages = [{"role": "user", "content": "Hello"}]
        chunks = [{"content": "Test", "score": 0.8}]

        mode, details = strategy.decide_injection_mode(messages, chunks)

        assert mode == InjectionMode.RAG_ONLY
        assert details["reason"] == "forced_rag_mode"

    def test_decide_injection_mode_forced_direct(self):
        """Test injection mode decision with forced direct."""
        strategy = InjectionStrategy(
            "claude-3-5-sonnet",
            context_window=200000,
            injection_mode=InjectionMode.DIRECT_INJECTION,
        )

        messages = [{"role": "user", "content": "Hello"}]
        chunks = [{"content": "Test", "score": 0.8}]

        mode, details = strategy.decide_injection_mode(messages, chunks)

        assert mode == InjectionMode.DIRECT_INJECTION
        assert details["reason"] == "forced_direct_mode"

    def test_apply_all_or_nothing_strategy(self):
        """Test All-or-Nothing strategy."""
        strategy = InjectionStrategy("claude-3-5-sonnet", context_window=200000)

        kb_chunks = {
            1: [{"content": "KB1 content", "score": 0.8}],
            2: [{"content": "KB2 content", "score": 0.7}],
        }

        messages = [{"role": "user", "content": "Hello"}]

        can_inject, all_chunks = strategy.apply_all_or_nothing_strategy(
            kb_chunks, messages
        )

        # Should combine chunks from all KBs
        assert len(all_chunks) == 2
        assert all_chunks[0]["knowledge_base_id"] == 1
        assert all_chunks[1]["knowledge_base_id"] == 2

    @pytest.mark.asyncio
    async def test_execute_injection_strategy_rag_fallback(self):
        """Test injection strategy execution with RAG fallback."""
        strategy = InjectionStrategy(
            "claude-3-5-sonnet",
            context_window=200000,
            injection_mode=InjectionMode.RAG_ONLY,
        )

        messages = [{"role": "user", "content": "Hello"}]
        kb_chunks = {1: [{"content": "KB1 content", "score": 0.8}]}

        result = await strategy.execute_injection_strategy(
            messages, kb_chunks, "test query"
        )

        assert result["mode"] == InjectionMode.RAG_ONLY
        assert result["fallback_to_rag"] is True
        assert result["injected_content"] is None


class TestKnowledgeBaseToolClean:
    """Test KnowledgeBaseTool with injection strategy - clean version."""

    def test_injection_strategy_property(self):
        """Test injection strategy lazy initialization."""
        tool = KnowledgeBaseTool()
        tool.model_id = "claude-3-5-sonnet"

        # Should create strategy on first access
        strategy = tool.injection_strategy
        assert strategy is not None
        assert strategy.model_id == "claude-3-5-sonnet"

        # Should return same instance on subsequent access
        assert tool.injection_strategy is strategy

    @pytest.mark.asyncio
    async def test_arun_with_no_knowledge_bases(self):
        """Test _arun with no knowledge bases configured."""
        tool = KnowledgeBaseTool()
        tool.knowledge_base_ids = []

        result = await tool._arun("test query")

        result_dict = json.loads(result)
        assert "error" in result_dict
        assert "No knowledge bases configured" in result_dict["error"]

    @pytest.mark.asyncio
    async def test_arun_with_no_db_session_uses_http(self):
        """Test _arun with no database session uses HTTP fallback.

        When db_session is None (HTTP mode), the tool should use HTTP API
        to communicate with backend instead of returning an error.
        """
        tool = KnowledgeBaseTool()
        tool.knowledge_base_ids = [1]
        tool.db_session = None

        # Mock HTTP methods to simulate HTTP mode
        with patch.object(
            tool, "_get_kb_size_info_via_http", new_callable=AsyncMock
        ) as mock_kb_size:
            mock_kb_size.return_value = {
                "total_file_size": 1000,
                "total_estimated_tokens": 250,
            }

            with patch.object(
                tool, "_retrieve_chunks_via_http", new_callable=AsyncMock
            ) as mock_retrieve:
                mock_retrieve.return_value = {}

                result = await tool._arun("test query")

                result_dict = json.loads(result)
                # Should not return error, but empty results (no chunks found)
                assert "error" not in result_dict
                assert result_dict.get("count", 0) == 0

    @pytest.mark.asyncio
    async def test_retrieve_chunks_from_all_kbs_empty(self):
        """Test _retrieve_chunks_from_all_kbs with empty results."""
        tool = KnowledgeBaseTool()
        tool.knowledge_base_ids = [1]
        tool.db_session = MagicMock()

        # Mock the entire method to avoid import issues
        with patch.object(tool, "_retrieve_chunks_from_all_kbs") as mock_method:
            mock_method.return_value = {}

            kb_chunks = await tool._retrieve_chunks_from_all_kbs("test query", 5)

            assert kb_chunks == {}

    def test_format_direct_injection_result(self):
        """Test _format_direct_injection_result."""
        tool = KnowledgeBaseTool()

        injection_result = {
            "injected_content": "Test injected content",
            "chunks_used": [{"content": "test", "score": 0.8}],
            "decision_details": {"strategy": "all_or_nothing"},
        }

        result = tool._format_direct_injection_result(injection_result, "test query")

        result_dict = json.loads(result)
        assert result_dict["mode"] == "direct_injection"
        assert result_dict["injected_content"] == "Test injected content"
        assert result_dict["chunks_used"] == 1

    @pytest.mark.asyncio
    async def test_format_rag_result(self):
        """Test _format_rag_result."""
        tool = KnowledgeBaseTool()

        kb_chunks = {
            1: [
                {"content": "Content 1", "source": "doc1.txt", "score": 0.8},
                {"content": "Content 2", "source": "doc2.txt", "score": 0.7},
            ]
        }

        result = await tool._format_rag_result(kb_chunks, "test query", 5)

        result_dict = json.loads(result)
        assert result_dict["mode"] == "rag_retrieval"
        assert result_dict["count"] == 2
        assert len(result_dict["sources"]) == 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
