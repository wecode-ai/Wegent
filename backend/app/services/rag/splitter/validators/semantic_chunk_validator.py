# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Semantic Chunk Validator for document processing.

This module implements validation and auto-correction for semantic chunks,
ensuring consistency with source blocks and proper coverage handling.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..models.api_models import SemanticChunk
from ..models.ir import BlockType, StructureBlock

logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    """Validation result with errors, warnings, and fixed chunks."""

    is_valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    fixed_chunks: Optional[List[SemanticChunk]] = None


class SemanticChunkValidator:
    """
    Semantic Chunk Validator (Enhanced Version).

    Validates and auto-corrects semantic chunks with:
    1. Source block existence and bounds checking
    2. Coverage strategy validation (exclusive vs shared)
    3. Chunk type and source block type matching
    4. Title path consistency (strict mode support)
    5. Content source verification
    6. Block coverage completeness check

    Enhancements:
    1. Coverage strategy levels (exclusive vs shared)
    2. title_strict mode for API chunks
    3. More precise error handling and auto-correction
    """

    # Valid chunk_type to source BlockType mappings
    VALID_TYPE_MAPPINGS: Dict[str, set] = {
        "paragraph": {BlockType.PARAGRAPH, BlockType.BLOCKQUOTE},
        "code": {BlockType.CODE},
        "table": {BlockType.TABLE},
        "example": {BlockType.CODE, BlockType.PARAGRAPH},
        "list": {BlockType.LIST},
        "definition": {BlockType.DEFINITION},
        "api_description": {BlockType.PARAGRAPH},
        "api_definition": {BlockType.PARAGRAPH},
        "api_params": {BlockType.TABLE, BlockType.PARAGRAPH, BlockType.LIST},
        "api_response": {BlockType.TABLE, BlockType.PARAGRAPH, BlockType.LIST},
        "api_example": {BlockType.CODE, BlockType.PARAGRAPH},
    }

    # Default coverage configuration by chunk type
    COVERAGE_CONFIG: Dict[str, str] = {
        "api_definition": "exclusive",
        "api_params": "exclusive",
        "api_example": "exclusive",
        "api_response": "exclusive",
        "api_description": "shared",  # Allows partial overlap
        "table": "exclusive",
        "code": "exclusive",
        "example": "exclusive",
        "paragraph": "exclusive",
        "list": "exclusive",
        "definition": "exclusive",
    }

    # Chunk types that require strict title matching
    TITLE_STRICT_TYPES = {
        "api_definition",
        "api_params",
        "api_response",
        "api_example",
        "api_description",
    }

    # Chunk types that are atomic (cannot be split)
    ATOMIC_TYPES = {
        "api_definition",
        "api_params",
        "table",
        "code",
        "example",
        "api_example",
    }

    # Overflow strategy by chunk type
    OVERFLOW_STRATEGIES: Dict[str, str] = {
        "api_params": "row_split",
        "table": "row_split",
        "code": "function_split",
        "example": "function_split",
        "api_example": "function_split",
        "list": "item_split",
    }

    def validate(
        self,
        chunks: List[SemanticChunk],
        blocks: List[StructureBlock],
        heading_context: List[str],
    ) -> ValidationResult:
        """
        Validate chunks for consistency and correctness.

        Args:
            chunks: List of semantic chunks to validate
            blocks: List of structure blocks from document IR
            heading_context: Current heading hierarchy

        Returns:
            ValidationResult with errors, warnings, and optionally fixed chunks
        """
        errors: List[str] = []
        warnings: List[str] = []
        fixed_chunks: List[SemanticChunk] = []

        # Track block usage: block_idx -> [(chunk_idx, coverage)]
        block_usage: Dict[int, List[Tuple[int, str]]] = {}

        for i, chunk in enumerate(chunks):
            chunk_errors: List[str] = []
            chunk_warnings: List[str] = []
            fixed_chunk = self._copy_chunk(chunk)

            # === Set metadata defaults ===
            self._set_metadata_defaults(fixed_chunk)

            # === Validation 1: source_blocks existence ===
            if not chunk.source_blocks:
                chunk_errors.append(f"Chunk[{i}]: source_blocks is empty")
                fixed_source = self._infer_source_blocks(chunk.content, blocks)
                if fixed_source:
                    fixed_chunk.source_blocks = fixed_source
                    chunk_warnings.append(
                        f"Chunk[{i}]: source_blocks inferred as {fixed_source}"
                    )
                else:
                    chunk_errors.append(
                        f"Chunk[{i}]: cannot infer source_blocks, chunk will be dropped"
                    )
                    errors.extend(chunk_errors)
                    warnings.extend(chunk_warnings)
                    continue

            # === Validation 2: source_blocks bounds check ===
            invalid_indices = [
                idx
                for idx in chunk.source_blocks
                if idx < 0 or idx >= len(blocks)
            ]
            if invalid_indices:
                chunk_errors.append(
                    f"Chunk[{i}]: source_blocks out of bounds: {invalid_indices}"
                )
                fixed_chunk.source_blocks = [
                    idx for idx in chunk.source_blocks if 0 <= idx < len(blocks)
                ]
                if not fixed_chunk.source_blocks:
                    chunk_errors.append(
                        f"Chunk[{i}]: all source_blocks invalid, chunk will be dropped"
                    )
                    errors.extend(chunk_errors)
                    warnings.extend(chunk_warnings)
                    continue

            # === Validation 3: Coverage strategy ===
            current_coverage = fixed_chunk.metadata["coverage"]
            for block_idx in fixed_chunk.source_blocks:
                if block_idx in block_usage:
                    for prev_chunk_idx, prev_coverage in block_usage[block_idx]:
                        # exclusive + any overlap -> error
                        if current_coverage == "exclusive" or prev_coverage == "exclusive":
                            chunk_errors.append(
                                f"Chunk[{i}]: block[{block_idx}] already used by Chunk[{prev_chunk_idx}] "
                                f"(coverage conflict: {prev_coverage} vs {current_coverage})"
                            )
                        else:
                            # shared + shared -> warning only
                            chunk_warnings.append(
                                f"Chunk[{i}]: block[{block_idx}] shared with Chunk[{prev_chunk_idx}]"
                            )
                    block_usage[block_idx].append((i, current_coverage))
                else:
                    block_usage[block_idx] = [(i, current_coverage)]

            # === Validation 4: chunk_type and source block type match ===
            source_block_types = {blocks[idx].type for idx in fixed_chunk.source_blocks}
            valid_source_types = self.VALID_TYPE_MAPPINGS.get(chunk.chunk_type, set())
            if valid_source_types:
                invalid_types = source_block_types - valid_source_types
                if invalid_types:
                    chunk_warnings.append(
                        f"Chunk[{i}]: chunk_type '{chunk.chunk_type}' has invalid source block types: {invalid_types}"
                    )
                    inferred_type = self._infer_chunk_type(source_block_types)
                    if inferred_type:
                        fixed_chunk.chunk_type = inferred_type
                        fixed_chunk.notes += f" [type corrected from {chunk.chunk_type}]"
                        # Update metadata for new type
                        self._set_metadata_defaults(fixed_chunk)

            # === Validation 5: title_path consistency ===
            is_title_strict = fixed_chunk.metadata["title_strict"]
            if not self._is_valid_title_path(
                chunk.title_path, heading_context, strict=is_title_strict
            ):
                if is_title_strict:
                    chunk_errors.append(
                        f"Chunk[{i}]: title_path {chunk.title_path} must exactly match "
                        f"heading_context {heading_context} (strict mode)"
                    )
                else:
                    chunk_warnings.append(
                        f"Chunk[{i}]: title_path {chunk.title_path} inconsistent with "
                        f"heading_context {heading_context}"
                    )
                fixed_chunk.title_path = heading_context.copy()

            # === Validation 6: content source verification ===
            expected_content = self._merge_block_contents(
                blocks, fixed_chunk.source_blocks
            )
            if not self._content_matches(chunk.content, expected_content):
                chunk_warnings.append(
                    f"Chunk[{i}]: content doesn't match source_blocks"
                )
                fixed_chunk.content = expected_content

            errors.extend(chunk_errors)
            warnings.extend(chunk_warnings)

            # Only add chunk if no fatal errors
            if not any("will be dropped" in e for e in chunk_errors):
                fixed_chunks.append(fixed_chunk)

        # === Validation 7: Block coverage completeness ===
        all_valid_blocks = set(range(len(blocks)))
        heading_blocks = {
            i for i, b in enumerate(blocks) if b.type == BlockType.HEADING
        }
        expected_covered = all_valid_blocks - heading_blocks
        actually_covered = set(block_usage.keys())
        missed_blocks = expected_covered - actually_covered

        if missed_blocks:
            warnings.append(
                f"Blocks not covered by any chunk: {sorted(missed_blocks)}"
            )
            for block_idx in sorted(missed_blocks):
                block = blocks[block_idx]
                fallback_chunk = self._create_fallback_chunk(
                    block, block_idx, heading_context
                )
                fixed_chunks.append(fallback_chunk)
                warnings.append(f"Created fallback chunk for block[{block_idx}]")

        is_valid = len(errors) == 0

        # Log validation results
        logger.info(
            f"[Phase6.5] Validation: {len(chunks)} chunks, valid={is_valid}"
        )
        logger.info(
            f"[Phase6.5] Errors: {len(errors)}, Warnings: {len(warnings)}"
        )

        if errors:
            for error in errors:
                logger.error(f"[Phase6.5] ERROR: {error}")

        if warnings:
            for warning in warnings:
                logger.warning(f"[Phase6.5] WARNING: {warning}")

        if fixed_chunks and (errors or warnings):
            logger.info(
                f"[Phase6.5] Auto-fixed to {len(fixed_chunks)} chunks"
            )

        return ValidationResult(
            is_valid=is_valid,
            errors=errors,
            warnings=warnings,
            fixed_chunks=fixed_chunks if (errors or warnings) else None,
        )

    def _set_metadata_defaults(self, chunk: SemanticChunk) -> None:
        """Set metadata defaults based on chunk type."""
        if "coverage" not in chunk.metadata:
            chunk.metadata["coverage"] = self.COVERAGE_CONFIG.get(
                chunk.chunk_type, "exclusive"
            )
        if "title_strict" not in chunk.metadata:
            chunk.metadata["title_strict"] = chunk.chunk_type in self.TITLE_STRICT_TYPES
        if "atomic" not in chunk.metadata:
            chunk.metadata["atomic"] = chunk.chunk_type in self.ATOMIC_TYPES
        if "overflow_strategy" not in chunk.metadata:
            chunk.metadata["overflow_strategy"] = self.OVERFLOW_STRATEGIES.get(
                chunk.chunk_type, "none"
            )

    def _is_valid_title_path(
        self,
        title_path: List[str],
        heading_context: List[str],
        strict: bool = False,
    ) -> bool:
        """
        Check if title_path is consistent with heading_context.

        Args:
            title_path: The title path to validate
            heading_context: The expected heading context
            strict: True requires exact match, False allows prefix subset

        Returns:
            True if valid, False otherwise
        """
        if not title_path:
            return not strict  # Empty path invalid in strict mode

        if strict:
            return title_path == heading_context

        # Non-strict mode: allow prefix subset
        if len(title_path) <= len(heading_context):
            return title_path == heading_context[: len(title_path)]
        return False

    def _content_matches(self, actual: str, expected: str) -> bool:
        """Check if content matches (allowing whitespace differences)."""
        def normalize(s: str) -> str:
            return re.sub(r"\s+", " ", s.strip())

        return normalize(actual) == normalize(expected)

    def _infer_source_blocks(
        self, content: str, blocks: List[StructureBlock]
    ) -> List[int]:
        """Infer source_blocks from content by matching."""
        normalized_content = re.sub(r"\s+", " ", content.strip())
        for i, block in enumerate(blocks):
            normalized_block = re.sub(r"\s+", " ", block.content.strip())
            if normalized_block and (
                normalized_block in normalized_content
                or normalized_content in normalized_block
            ):
                return [i]
        return []

    def _infer_chunk_type(self, source_types: set) -> Optional[str]:
        """Infer chunk_type from source block types."""
        if BlockType.CODE in source_types:
            return "code"
        if BlockType.TABLE in source_types:
            return "table"
        if BlockType.LIST in source_types:
            return "list"
        if BlockType.DEFINITION in source_types:
            return "definition"
        return "paragraph"

    def _merge_block_contents(
        self, blocks: List[StructureBlock], indices: List[int]
    ) -> str:
        """Merge content from specified blocks."""
        contents = [blocks[i].content for i in indices if 0 <= i < len(blocks)]
        return "\n\n".join(contents)

    def _copy_chunk(self, chunk: SemanticChunk) -> SemanticChunk:
        """Create a deep copy of a chunk."""
        return SemanticChunk(
            chunk_type=chunk.chunk_type,
            title_path=chunk.title_path.copy() if chunk.title_path else [],
            content=chunk.content,
            notes=chunk.notes,
            source_blocks=chunk.source_blocks.copy(),
            metadata=chunk.metadata.copy(),
        )

    def _create_fallback_chunk(
        self,
        block: StructureBlock,
        block_idx: int,
        heading_context: List[str],
    ) -> SemanticChunk:
        """Create a fallback chunk for a missed block."""
        chunk_type = self._infer_chunk_type({block.type}) or "paragraph"
        is_atomic = chunk_type in self.ATOMIC_TYPES

        return SemanticChunk(
            chunk_type=chunk_type,
            title_path=heading_context.copy(),
            content=block.content,
            notes=f"Fallback chunk for missed block[{block_idx}]",
            source_blocks=[block_idx],
            metadata={
                "atomic": is_atomic,
                "fallback": True,
                "coverage": self.COVERAGE_CONFIG.get(chunk_type, "exclusive"),
                "title_strict": False,
                "overflow_strategy": self.OVERFLOW_STRATEGIES.get(chunk_type, "none"),
            },
        )
