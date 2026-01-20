# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Semantic Chunk Validator.

Tests cover:
1. Source block validation
2. Coverage strategy validation
3. Type matching validation
4. Title path consistency
5. Auto-correction capabilities
6. Fallback chunk creation
"""

import pytest

from app.services.rag.splitter.models import BlockType, SemanticChunk, StructureBlock
from app.services.rag.splitter.validators import SemanticChunkValidator, ValidationResult


class TestSemanticChunkValidator:
    """Test Semantic Chunk Validator."""

    def test_valid_chunk_passes(self):
        """Test that valid chunks pass validation."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="This is a paragraph.",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="This is a paragraph.",
                source_blocks=[0],
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Section"])

        assert result.is_valid
        assert len(result.errors) == 0

    def test_empty_source_blocks_error(self):
        """Test that empty source_blocks triggers error."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Content",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="Content",
                source_blocks=[],  # Empty!
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Section"])

        assert not result.is_valid
        assert any("source_blocks is empty" in e for e in result.errors)

    def test_source_blocks_out_of_bounds(self):
        """Test that out of bounds source_blocks triggers error."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Content",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="Content",
                source_blocks=[0, 5, 10],  # 5 and 10 are out of bounds
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Section"])

        assert not result.is_valid
        assert any("out of bounds" in e for e in result.errors)
        # Should auto-fix to valid indices only
        assert result.fixed_chunks is not None
        assert result.fixed_chunks[0].source_blocks == [0]

    def test_coverage_conflict_exclusive(self):
        """Test coverage conflict with exclusive strategy."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Content",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="Content",
                source_blocks=[0],
                metadata={"coverage": "exclusive"},
            ),
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="Content",
                source_blocks=[0],  # Same block!
                metadata={"coverage": "exclusive"},
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Section"])

        assert not result.is_valid
        assert any("coverage conflict" in e for e in result.errors)

    def test_coverage_shared_allowed(self):
        """Test shared coverage allows overlap."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Content",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="api_description",
                title_path=["API"],
                content="Content",
                source_blocks=[0],
                metadata={"coverage": "shared"},
            ),
            SemanticChunk(
                chunk_type="api_description",
                title_path=["API"],
                content="Content",
                source_blocks=[0],  # Same block, but shared
                metadata={"coverage": "shared"},
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["API"])

        # Should not have errors, only warnings
        assert result.is_valid
        assert any("shared" in w for w in result.warnings)

    def test_type_mismatch_warning(self):
        """Test type mismatch generates warning and auto-fix."""
        blocks = [
            StructureBlock(
                type=BlockType.CODE,
                content="```python\ncode\n```",
                line_start=1,
                line_end=3,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",  # Wrong type for CODE block
                title_path=["Section"],
                content="```python\ncode\n```",
                source_blocks=[0],
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Section"])

        # Should have warning about type mismatch
        assert any("invalid source block types" in w for w in result.warnings)
        # Should auto-correct to 'code'
        assert result.fixed_chunks is not None
        assert result.fixed_chunks[0].chunk_type == "code"

    def test_title_strict_mode(self):
        """Test title_strict mode requires exact match."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="GET /api/users",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="api_definition",
                title_path=["API"],  # Different from heading_context
                content="GET /api/users",
                source_blocks=[0],
                metadata={"title_strict": True},
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["API", "Users"])

        assert not result.is_valid
        assert any("strict mode" in e for e in result.errors)

    def test_title_non_strict_allows_prefix(self):
        """Test non-strict mode allows prefix match."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Content",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["API"],  # Prefix of heading_context
                content="Content",
                source_blocks=[0],
                metadata={"title_strict": False},
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["API", "Users"])

        assert result.is_valid

    def test_missed_blocks_creates_fallback(self):
        """Test that missed blocks create fallback chunks."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="# Title",
                level=1,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Para 1",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Para 2",
                line_start=3,
                line_end=3,
            ),
        ]

        # Only cover block 1, miss block 2
        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Title"],
                content="Para 1",
                source_blocks=[1],
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Title"])

        assert result.is_valid  # Missing blocks are warnings, not errors
        assert any("not covered" in w for w in result.warnings)
        # Should create fallback for block 2
        assert result.fixed_chunks is not None
        assert len(result.fixed_chunks) == 2
        fallback = result.fixed_chunks[1]
        assert fallback.metadata.get("fallback") is True
        assert fallback.source_blocks == [2]

    def test_content_mismatch_warning(self):
        """Test content mismatch generates warning."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Original content",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="Different content",  # Doesn't match
                source_blocks=[0],
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Section"])

        assert any("doesn't match" in w for w in result.warnings)
        # Should auto-fix content
        assert result.fixed_chunks is not None
        assert result.fixed_chunks[0].content == "Original content"

    def test_metadata_defaults_set(self):
        """Test metadata defaults are set based on chunk type."""
        blocks = [
            StructureBlock(
                type=BlockType.TABLE,
                content="| A | B |",
                line_start=1,
                line_end=1,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="table",
                title_path=["Wrong"],  # Different from heading_context to trigger warning
                content="| A | B |",
                source_blocks=[0],
                metadata={},  # Empty metadata
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Data"])

        # Validation should have warnings due to title_path mismatch
        # and fixed_chunks should have metadata defaults set
        assert result.fixed_chunks is not None
        fixed = result.fixed_chunks[0]
        assert fixed.metadata.get("atomic") is True
        assert fixed.metadata.get("coverage") == "exclusive"
        assert fixed.metadata.get("overflow_strategy") == "row_split"


class TestSemanticChunkValidatorEdgeCases:
    """Test edge cases for Semantic Chunk Validator."""

    def test_empty_chunks(self):
        """Test handling of empty chunks list."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Content",
                line_start=1,
                line_end=1,
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate([], blocks, ["Section"])

        # No chunks means nothing to validate (but may warn about missed blocks)
        assert result.is_valid

    def test_empty_blocks(self):
        """Test handling of empty blocks list."""
        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="Content",
                source_blocks=[0],
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, [], ["Section"])

        # Should error on out of bounds
        assert not result.is_valid

    def test_infer_source_blocks(self):
        """Test source block inference from content."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="This is unique content",
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Different content here",
                line_start=2,
                line_end=2,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Section"],
                content="This is unique content",
                source_blocks=[],  # Empty - should be inferred
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Section"])

        # Should infer source_blocks as [0]
        assert result.fixed_chunks is not None
        assert result.fixed_chunks[0].source_blocks == [0]

    def test_multiple_errors_and_warnings(self):
        """Test handling of multiple issues in one validation run."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Content 1",
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.CODE,
                content="```code```",
                line_start=2,
                line_end=2,
            ),
        ]

        chunks = [
            SemanticChunk(
                chunk_type="paragraph",
                title_path=["Wrong"],
                content="Wrong content",
                source_blocks=[0],
                metadata={"coverage": "exclusive"},
            ),
            SemanticChunk(
                chunk_type="paragraph",  # Wrong type
                title_path=["Wrong"],
                content="Wrong content",
                source_blocks=[0, 1],  # Overlap + type mismatch
                metadata={"coverage": "exclusive"},
            ),
        ]

        validator = SemanticChunkValidator()
        result = validator.validate(chunks, blocks, ["Correct"])

        # Should have multiple errors and warnings
        assert not result.is_valid
        assert len(result.errors) >= 1
        assert len(result.warnings) >= 1
