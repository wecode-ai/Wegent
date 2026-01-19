# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Structural chunker for document processing.

This module implements Phase 4 of the document splitting pipeline:
grouping structure blocks into semantically coherent chunks.
"""

import logging
from typing import Any, Dict, List, Optional

from ..models.ir import BlockType, DocumentIR, StructureBlock

logger = logging.getLogger(__name__)


class StructuralChunker:
    """
    Groups structure blocks into semantically coherent chunks.

    Principles:
    - Keep heading + following content together
    - Keep complete tables/code blocks/lists intact
    - Maintain parent heading context
    - Respect semantic boundaries
    """

    def __init__(self):
        """Initialize the structural chunker."""
        pass

    def chunk(self, doc_ir: DocumentIR) -> List[Dict[str, Any]]:
        """
        Convert document IR blocks into preliminary chunks.

        Args:
            doc_ir: Filtered document IR

        Returns:
            List of chunk dictionaries with content and metadata
        """
        if not doc_ir.blocks:
            return []

        chunks: List[Dict[str, Any]] = []
        current_chunk_blocks: List[StructureBlock] = []
        current_heading_path: List[str] = []

        for block in doc_ir.blocks:
            # Update heading path if this is a heading
            if block.type == BlockType.HEADING:
                # Finalize current chunk if not empty
                if current_chunk_blocks:
                    chunk = self._create_chunk_from_blocks(
                        current_chunk_blocks,
                        current_heading_path,
                    )
                    chunks.append(chunk)
                    current_chunk_blocks = []

                # Update heading path
                level = block.level or 1
                current_heading_path = self._update_heading_path(
                    current_heading_path,
                    level,
                    self._extract_heading_text(block.content),
                )

            # Add block to current chunk
            current_chunk_blocks.append(block)

            # Check if this block should end the chunk
            if self._should_end_chunk(block, current_chunk_blocks):
                chunk = self._create_chunk_from_blocks(
                    current_chunk_blocks,
                    current_heading_path,
                )
                chunks.append(chunk)
                current_chunk_blocks = []

        # Finalize remaining blocks
        if current_chunk_blocks:
            chunk = self._create_chunk_from_blocks(
                current_chunk_blocks,
                current_heading_path,
            )
            chunks.append(chunk)

        logger.info(
            f"Structural chunker created {len(chunks)} chunks from {len(doc_ir.blocks)} blocks"
        )
        return chunks

    def _should_end_chunk(
        self,
        block: StructureBlock,
        current_blocks: List[StructureBlock],
    ) -> bool:
        """Determine if the current block should end the chunk."""
        # Self-contained structures end their own chunks
        if block.type in {BlockType.TABLE, BlockType.CODE, BlockType.QA}:
            return True

        # Lists can be long, end chunk after list
        if block.type == BlockType.LIST:
            return True

        return False

    def _create_chunk_from_blocks(
        self,
        blocks: List[StructureBlock],
        heading_path: List[str],
    ) -> Dict[str, Any]:
        """Create a chunk dictionary from a list of blocks."""
        if not blocks:
            return {}

        # Determine primary chunk type
        chunk_type = self._determine_chunk_type(blocks)

        # Combine content
        content_parts = []
        for block in blocks:
            content_parts.append(block.content)

        content = "\n\n".join(content_parts)

        # Get line range
        line_start = blocks[0].line_start
        line_end = blocks[-1].line_end

        # Get page number (use first block's page)
        page_number = blocks[0].page_number

        return {
            "content": content,
            "chunk_type": (
                chunk_type.value if isinstance(chunk_type, BlockType) else chunk_type
            ),
            "title_path": heading_path.copy() if heading_path else None,
            "line_start": line_start,
            "line_end": line_end,
            "page_number": page_number,
            "block_count": len(blocks),
            "metadata": {
                "block_types": [
                    b.type.value if isinstance(b.type, BlockType) else b.type
                    for b in blocks
                ],
            },
        }

    def _determine_chunk_type(self, blocks: List[StructureBlock]) -> BlockType:
        """Determine the primary type for a chunk based on its blocks."""
        if len(blocks) == 1:
            return blocks[0].type

        # Count block types
        type_counts: Dict[BlockType, int] = {}
        for block in blocks:
            block_type = block.type
            type_counts[block_type] = type_counts.get(block_type, 0) + 1

        # Prioritize certain types
        priority_types = [
            BlockType.CODE,
            BlockType.TABLE,
            BlockType.QA,
            BlockType.LIST,
            BlockType.FLOW,
        ]

        for ptype in priority_types:
            if ptype in type_counts:
                return ptype

        # If heading + content, use paragraph
        if BlockType.HEADING in type_counts and BlockType.PARAGRAPH in type_counts:
            return BlockType.PARAGRAPH

        # Return most common type
        return max(type_counts.keys(), key=lambda t: type_counts[t])

    def _update_heading_path(
        self,
        current_path: List[str],
        level: int,
        title: str,
    ) -> List[str]:
        """Update the heading path based on a new heading."""
        # Remove headings at same or lower level
        new_path = []
        for existing_title in current_path:
            # We don't store levels with titles, so we can only append
            # This is a simplified approach
            new_path.append(existing_title)

        # For simplicity, we'll limit depth based on level
        if level <= len(current_path):
            new_path = current_path[: level - 1]

        new_path.append(title)
        return new_path

    def _extract_heading_text(self, content: str) -> str:
        """Extract clean heading text from content."""
        import re

        text = content.strip()
        # Remove markdown heading markers
        text = re.sub(r"^#{1,6}\s+", "", text)
        # Remove trailing punctuation
        text = re.sub(r"[:\s]+$", "", text)
        return text
