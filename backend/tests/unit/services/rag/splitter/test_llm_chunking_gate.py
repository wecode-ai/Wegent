# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for LLM Chunking Gate.

Tests cover:
1. API document detection decisions
2. Statistics-based complexity detection
3. Weak semantic block detection
4. Clear boundary detection
"""

import pytest

from app.services.rag.splitter.chunkers import LLMChunkingGate
from app.services.rag.splitter.models import (
    APIDocumentInfo,
    APIEndpoint,
    APISection,
    BlockType,
    StructureBlock,
)


class TestLLMChunkingGate:
    """Test LLM Chunking Gate decision logic."""

    def test_api_document_without_weak_semantic(self):
        """Test API document without weak semantic blocks uses rule-based."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="## User API",
                level=2,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="GET /api/users - Get all users from the system.",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.TABLE,
                content="| Param | Type | Description |\n|---|---|---|",
                line_start=3,
                line_end=4,
            ),
        ]

        api_info = APIDocumentInfo(
            is_api_doc=True,
            api_sections=[
                APISection(
                    heading_block=0,
                    endpoints=[
                        APIEndpoint(block_index=1, method="GET", path="/api/users"),
                    ],
                ),
            ],
        )

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        assert not should_use
        assert "rule-based" in reason.lower()

    def test_api_document_with_weak_semantic(self):
        """Test API document with weak semantic blocks needs LLM."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="## User API",
                level=2,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="示例：",  # Weak semantic block
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.CODE,
                content="```json\n{}\n```",
                line_start=3,
                line_end=5,
            ),
        ]

        api_info = APIDocumentInfo(
            is_api_doc=True,
            api_sections=[
                APISection(heading_block=0, endpoints=[]),
            ],
        )

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        assert should_use
        assert "weak semantic" in reason.lower()

    def test_simple_document_uniform_paragraphs(self):
        """Test simple document with uniform paragraphs uses rule-based."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="# Introduction",
                level=1,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="This is a normal paragraph with sufficient content for analysis. " * 3,
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Another paragraph with similar length and content structure. " * 3,
                line_start=3,
                line_end=3,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Third paragraph maintaining consistent paragraph sizes. " * 3,
                line_start=4,
                line_end=4,
            ),
        ]

        api_info = APIDocumentInfo(is_api_doc=False)

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        assert not should_use
        assert "simple" in reason.lower() or "rule-based" in reason.lower()

    def test_document_with_high_length_variance(self):
        """Test document with high paragraph length variance needs LLM."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="# Document",
                level=1,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Short.",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="This is a very long paragraph with extensive content. " * 20,
                line_start=3,
                line_end=3,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Tiny",
                line_start=4,
                line_end=4,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Another extremely long paragraph for testing variance. " * 15,
                line_start=5,
                line_end=5,
            ),
        ]

        api_info = APIDocumentInfo(is_api_doc=False)

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        assert should_use
        assert "variance" in reason.lower() or "std" in reason.lower()

    def test_document_with_many_short_paragraphs(self):
        """Test document with high short paragraph ratio needs LLM."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="# List Document",
                level=1,
                line_start=1,
                line_end=1,
            ),
        ]

        # Add many short paragraphs
        for i in range(10):
            blocks.append(
                StructureBlock(
                    type=BlockType.PARAGRAPH,
                    content=f"Short item {i}",
                    line_start=i + 2,
                    line_end=i + 2,
                )
            )

        # Add one normal paragraph
        blocks.append(
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="This is a normal length paragraph for reference. " * 3,
                line_start=12,
                line_end=12,
            )
        )

        api_info = APIDocumentInfo(is_api_doc=False)

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        assert should_use
        assert "short" in reason.lower() or "ratio" in reason.lower()

    def test_document_with_consecutive_short_paragraphs(self):
        """Test document with consecutive short paragraphs needs LLM."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="# Document",
                level=1,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Normal paragraph with sufficient content for analysis.",
                line_start=2,
                line_end=2,
            ),
        ]

        # Add consecutive short paragraphs
        for i in range(7):
            blocks.append(
                StructureBlock(
                    type=BlockType.PARAGRAPH,
                    content=f"Item {i}",
                    line_start=i + 3,
                    line_end=i + 3,
                )
            )

        api_info = APIDocumentInfo(is_api_doc=False)

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        assert should_use
        assert "consecutive" in reason.lower() or "short" in reason.lower()

    def test_complex_document_with_clear_boundaries(self):
        """Test complex document with clear boundaries uses rule-based."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="# Documentation",
                level=1,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="This is a substantial paragraph that introduces the code block below.",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.CODE,
                content="```python\nprint('hello')\n```",
                line_start=3,
                line_end=5,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="This paragraph explains the table below in detail.",
                line_start=6,
                line_end=6,
            ),
            StructureBlock(
                type=BlockType.TABLE,
                content="| Col1 | Col2 |\n|---|---|",
                line_start=7,
                line_end=8,
            ),
        ]

        api_info = APIDocumentInfo(is_api_doc=False)

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        assert not should_use
        assert "boundaries" in reason.lower() or "rule-based" in reason.lower()

    def test_complex_document_with_ambiguous_boundaries(self):
        """Test complex document with ambiguous boundaries needs LLM."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="# Documentation",
                level=1,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="如下：",  # Short lead text before code
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.CODE,
                content="```python\nprint('hello')\n```",
                line_start=3,
                line_end=5,
            ),
        ]

        api_info = APIDocumentInfo(is_api_doc=False)

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        # Should use LLM due to ambiguous boundary (short paragraph before code)
        assert should_use

    def test_weak_semantic_patterns(self):
        """Test various weak semantic patterns are detected."""
        gate = LLMChunkingGate()

        weak_patterns = [
            "如下",
            "以下",
            "见下",
            "示例：",
            "例如：",
            "返回示例",
            "请求示例",
            "response example",
            "request example",
            "see below",
            "as follows",
        ]

        for pattern in weak_patterns:
            blocks = [
                StructureBlock(
                    type=BlockType.PARAGRAPH,
                    content=pattern,
                    line_start=1,
                    line_end=1,
                ),
            ]

            has_weak = gate._has_weak_semantic_blocks(blocks)
            assert has_weak, f"Pattern '{pattern}' should be detected as weak semantic"


class TestLLMChunkingGateEdgeCases:
    """Test edge cases for LLM Chunking Gate."""

    def test_empty_blocks(self):
        """Test handling of empty blocks."""
        blocks = []
        api_info = APIDocumentInfo(is_api_doc=False)

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        # Should handle gracefully
        assert isinstance(should_use, bool)
        assert isinstance(reason, str)

    def test_only_headings(self):
        """Test document with only headings."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="# Title",
                level=1,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.HEADING,
                content="## Section",
                level=2,
                line_start=2,
                line_end=2,
            ),
        ]

        api_info = APIDocumentInfo(is_api_doc=False)

        gate = LLMChunkingGate()
        should_use, reason = gate.should_use_llm(blocks, api_info)

        # Should handle gracefully without errors
        assert isinstance(should_use, bool)
