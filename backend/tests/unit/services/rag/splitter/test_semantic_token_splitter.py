# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Semantic Token Splitter.

Tests cover:
1. Token splitting with overflow strategies
2. Table row splitting
3. Code function splitting
4. List item splitting
5. Truncation as last resort
6. Embedding hard limit protection
"""

import pytest

from app.services.rag.splitter.chunkers import SemanticTokenSplitter
from app.services.rag.splitter.models import SemanticChunk


class TestSemanticTokenSplitter:
    """Test Semantic Token Splitter."""

    def test_chunk_within_limits(self):
        """Test chunks within limits are kept as-is."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=100,
            overlap_tokens=10,
        )

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="This is a short paragraph.",
                source_blocks=[0],
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        assert len(result) == 1
        assert result[0].content == "This is a short paragraph."
        assert stats["split_count"] == 0

    def test_split_non_atomic_chunk(self):
        """Test non-atomic chunks are split when exceeding limits."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=50,
            overlap_tokens=5,
        )

        long_content = "This is paragraph one. " * 10 + "\n\n" + "This is paragraph two. " * 10

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content=long_content,
                source_blocks=[0],
                metadata={"atomic": False},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        assert len(result) > 1
        assert stats["split_count"] > 0

    def test_atomic_chunk_kept_within_soft_limit(self):
        """Test atomic chunks exceeding max_tokens but within hard limit are kept."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=50,
            overlap_tokens=5,
        )

        # Create an atomic chunk that exceeds max_tokens but not hard limit
        content = "Code line. " * 20

        chunks = [
            SemanticChunk(
                chunk_type="code",
                title_path=["Code"],
                content=content,
                source_blocks=[0],
                metadata={"atomic": True, "overflow_strategy": "none"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        assert len(result) == 1
        assert stats["atomic_kept"] == 1

    def test_atomic_chunk_with_overflow_strategy(self):
        """Test atomic chunks with overflow strategy are split."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=50,
            overlap_tokens=5,
        )

        # Create code content that will be split
        content = "def func1():\n    pass\n\ndef func2():\n    pass\n\ndef func3():\n    pass\n" * 3

        chunks = [
            SemanticChunk(
                chunk_type="code",
                title_path=["Code"],
                content=content,
                source_blocks=[0],
                metadata={"atomic": True, "overflow_strategy": "function_split"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        # Should have split based on function boundaries
        assert stats["overflow_handled"] >= 1

    def test_table_row_split(self):
        """Test table splitting by rows."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=100,
            overlap_tokens=5,
        )

        # Create a table with header and data rows
        table_content = """| Parameter | Type | Description |
|-----------|------|-------------|
| user_id | int | User identifier |
| name | string | User name |
| email | string | Email address |
| phone | string | Phone number |
| address | string | Home address |
| city | string | City name |"""

        chunks = [
            SemanticChunk(
                chunk_type="table",
                title_path=["API", "Params"],
                content=table_content,
                source_blocks=[0],
                metadata={"atomic": True, "overflow_strategy": "row_split"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        # Verify rows are split correctly
        for chunk in result:
            # Each chunk should contain the header
            assert "| Parameter | Type | Description |" in chunk.content
            assert "|-----------|------|-------------|" in chunk.content

    def test_list_item_split(self):
        """Test list splitting by items."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=80,
            overlap_tokens=5,
        )

        list_content = """- First item with some description text
- Second item with more details here
- Third item explaining something important
- Fourth item with additional context
- Fifth item with final information
- Sixth item with even more content"""

        chunks = [
            SemanticChunk(
                chunk_type="list",
                title_path=["Features"],
                content=list_content,
                source_blocks=[0],
                metadata={"atomic": True, "overflow_strategy": "item_split"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        # Verify items are split
        for chunk in result:
            # Each chunk should start with a list item marker
            assert chunk.content.strip().startswith("-")

    def test_truncate_strategy(self):
        """Test truncation as fallback strategy."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=50,
            overlap_tokens=5,
        )

        # Very long content without clear structure
        long_content = "word " * 200

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Content"],
                content=long_content,
                source_blocks=[0],
                metadata={"atomic": True, "overflow_strategy": "truncate"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        assert len(result) == 1
        assert "[... content truncated ...]" in result[0].content
        assert result[0].metadata.get("truncated") is True

    def test_split_metadata_preserved(self):
        """Test that split chunks preserve and extend metadata."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=50,
            overlap_tokens=5,
        )

        content = "First paragraph. " * 10 + "\n\n" + "Second paragraph. " * 10

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section", "Subsection"],
                content=content,
                notes="Original note",
                source_blocks=[0, 1],
                metadata={"custom_key": "custom_value"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        assert len(result) > 1
        for i, chunk in enumerate(result):
            assert chunk.title_path == ["Section", "Subsection"]
            assert chunk.chunk_type == "paragraph"
            assert chunk.metadata.get("is_split") is True
            assert chunk.metadata.get("split_index") == i
            assert chunk.metadata.get("split_total") == len(result)


class TestSemanticTokenSplitterEdgeCases:
    """Test edge cases for Semantic Token Splitter."""

    def test_empty_chunks(self):
        """Test handling of empty chunks list."""
        splitter = SemanticTokenSplitter()

        result, stats = splitter.split_if_needed([])

        assert len(result) == 0
        assert stats["total_input"] == 0

    def test_empty_content_chunk(self):
        """Test handling of chunk with empty content."""
        splitter = SemanticTokenSplitter()

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Empty"],
                content="",
                source_blocks=[0],
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        assert len(result) == 1  # Empty chunk passes through

    def test_table_without_data_rows(self):
        """Test table with only header."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=50,
            overlap_tokens=5,
        )

        table_content = """| Header1 | Header2 |
|---------|---------|"""

        chunks = [
            SemanticChunk(
                chunk_type="table",
                title_path=["Table"],
                content=table_content,
                source_blocks=[0],
                metadata={"atomic": True, "overflow_strategy": "row_split"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        # Should return original since no data rows to split
        assert len(result) >= 1

    def test_code_without_function_boundaries(self):
        """Test code without clear function boundaries."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=50,
            overlap_tokens=5,
        )

        code_content = """x = 1
y = 2
z = x + y
print(z)
a = 3
b = 4
c = a + b
print(c)"""

        chunks = [
            SemanticChunk(
                chunk_type="code",
                title_path=["Code"],
                content=code_content,
                source_blocks=[0],
                metadata={"atomic": True, "overflow_strategy": "function_split"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        # Should fall back to semantic boundary splitting
        assert len(result) >= 1

    def test_stats_tracking(self):
        """Test statistics tracking across multiple chunks."""
        splitter = SemanticTokenSplitter(
            min_tokens=10,
            max_tokens=50,
            overlap_tokens=5,
        )

        chunks = [
            # Small chunk - passes through
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["A"],
                content="Short content.",
                source_blocks=[0],
            ),
            # Large non-atomic - gets split
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["B"],
                content="Long content. " * 20,
                source_blocks=[1],
                metadata={"atomic": False},
            ),
            # Large atomic without strategy - kept (must be > max_tokens but < hard limit)
            SemanticChunk(
                chunk_type="code",
                title_path=["C"],
                content="x = 1; y = 2; z = 3; a = 4; b = 5; c = 6; " * 10,  # Long but no structure
                source_blocks=[2],
                metadata={"atomic": True, "overflow_strategy": "none"},
            ),
        ]

        result, stats = splitter.split_if_needed(chunks)

        assert stats["total_input"] == 3
        assert stats["split_count"] >= 1
        assert stats["atomic_kept"] >= 1
