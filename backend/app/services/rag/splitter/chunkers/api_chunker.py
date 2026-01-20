# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API document rule-based chunker.

This module implements specialized chunking for API documentation,
creating semantically meaningful chunks with proper handling of
multi-endpoint sections that share parameters, responses, and examples.
"""

import logging
import re
from typing import Any, Dict, List, Optional

from ..models.api_models import APIDocumentInfo, APISection, SemanticChunk
from ..models.ir import BlockType, StructureBlock

logger = logging.getLogger(__name__)


class APIRuleBasedChunker:
    """
    Rule-based chunker for API documentation.

    Creates semantically meaningful chunks for API docs with:
    - Shared resources generating single chunks (no duplicate embedding)
    - Each endpoint's specific descriptions in separate chunks
    - Multi-endpoint definitions merged into single chunks
    - Rich metadata for downstream processing

    Coverage strategies:
    - "exclusive": Block content appears in exactly one chunk
    - "shared": Block content may be referenced by multiple chunks
    """

    def __init__(self):
        """Initialize the API rule-based chunker."""
        pass

    def chunk(
        self,
        blocks: List[StructureBlock],
        api_info: APIDocumentInfo,
        heading_context: Optional[List[str]] = None,
    ) -> List[SemanticChunk]:
        """
        Create semantic chunks for API documentation.

        Args:
            blocks: List of structure blocks from document IR
            api_info: API document structure information
            heading_context: Optional heading hierarchy context

        Returns:
            List of SemanticChunk objects
        """
        if not api_info.is_api_doc or not api_info.api_sections:
            return []

        chunks: List[SemanticChunk] = []
        heading_context = heading_context or []

        for section in api_info.api_sections:
            section_chunks = self._chunk_section(
                blocks=blocks,
                section=section,
                heading_context=heading_context,
            )
            chunks.extend(section_chunks)

        logger.info(
            f"[Phase5.5] API chunker created {len(chunks)} chunks "
            f"from {len(api_info.api_sections)} sections"
        )

        return chunks

    def _chunk_section(
        self,
        blocks: List[StructureBlock],
        section: APISection,
        heading_context: List[str],
    ) -> List[SemanticChunk]:
        """
        Create chunks for a single API section.

        Args:
            blocks: All document blocks
            section: API section to chunk
            heading_context: Current heading hierarchy

        Returns:
            List of SemanticChunk objects for this section
        """
        chunks: List[SemanticChunk] = []

        # Get section title path
        section_title_path = self._get_section_title_path(
            blocks=blocks,
            heading_block=section.heading_block,
            heading_context=heading_context,
        )

        # 1. Shared description chunk
        if section.shared_description_blocks:
            chunks.append(
                SemanticChunk(
                    chunk_type="api_description",
                    title_path=section_title_path.copy(),
                    content=self._merge_block_contents(
                        blocks, section.shared_description_blocks
                    ),
                    notes=(
                        "API description (section shared)"
                        if section.is_multi_endpoint
                        else "API description"
                    ),
                    source_blocks=section.shared_description_blocks.copy(),
                    metadata={
                        "atomic": False,
                        "coverage": "shared",
                        "title_strict": True,
                        "overflow_strategy": "none",
                    },
                )
            )

        # 2. API endpoint definition chunk (merge multiple endpoints)
        if section.endpoints:
            endpoint_blocks = [ep.block_index for ep in section.endpoints]
            endpoint_content = self._merge_block_contents(blocks, endpoint_blocks)

            # Build endpoint summary for notes
            endpoint_summary = ", ".join(
                [f"{ep.method} {ep.path}" for ep in section.endpoints]
            )

            chunks.append(
                SemanticChunk(
                    chunk_type="api_definition",
                    title_path=section_title_path.copy(),
                    content=endpoint_content,
                    notes=f"API definition ({len(section.endpoints)} endpoint(s): {endpoint_summary})",
                    source_blocks=endpoint_blocks,
                    metadata={
                        "atomic": True,
                        "coverage": "exclusive",
                        "title_strict": True,
                        "overflow_strategy": "none",
                        "endpoints": [
                            {"method": ep.method, "path": ep.path}
                            for ep in section.endpoints
                        ],
                    },
                )
            )

            # 3. Endpoint-specific descriptions
            for ep in section.endpoints:
                if ep.description_blocks:
                    chunks.append(
                        SemanticChunk(
                            chunk_type="api_description",
                            title_path=section_title_path.copy(),
                            content=self._merge_block_contents(
                                blocks, ep.description_blocks
                            ),
                            notes=f"API description (specific to {ep.method} {ep.path})",
                            source_blocks=ep.description_blocks.copy(),
                            metadata={
                                "atomic": False,
                                "coverage": "exclusive",
                                "title_strict": True,
                                "overflow_strategy": "none",
                                "endpoint": {"method": ep.method, "path": ep.path},
                            },
                        )
                    )

        # 4. Shared parameters chunk
        if section.shared_params_blocks:
            shared_note = (
                f"API parameters ({len(section.endpoints)} endpoints shared)"
                if section.is_multi_endpoint
                else "API parameters"
            )
            chunks.append(
                SemanticChunk(
                    chunk_type="api_params",
                    title_path=section_title_path.copy(),
                    content=self._merge_block_contents(
                        blocks, section.shared_params_blocks
                    ),
                    notes=shared_note,
                    source_blocks=section.shared_params_blocks.copy(),
                    metadata={
                        "atomic": True,
                        "coverage": "exclusive",
                        "title_strict": True,
                        "overflow_strategy": "row_split",
                        "shared_by_endpoints": len(section.endpoints),
                    },
                )
            )

        # 5. Shared response chunk
        if section.shared_response_blocks:
            shared_note = (
                f"API response ({len(section.endpoints)} endpoints shared)"
                if section.is_multi_endpoint
                else "API response"
            )
            chunks.append(
                SemanticChunk(
                    chunk_type="api_response",
                    title_path=section_title_path.copy(),
                    content=self._merge_block_contents(
                        blocks, section.shared_response_blocks
                    ),
                    notes=shared_note,
                    source_blocks=section.shared_response_blocks.copy(),
                    metadata={
                        "atomic": False,
                        "coverage": "exclusive",
                        "title_strict": True,
                        "overflow_strategy": "none",
                        "shared_by_endpoints": len(section.endpoints),
                    },
                )
            )

        # 6. Shared examples chunk
        if section.shared_example_blocks:
            shared_note = (
                f"API example ({len(section.endpoints)} endpoints shared)"
                if section.is_multi_endpoint
                else "API example"
            )
            chunks.append(
                SemanticChunk(
                    chunk_type="api_example",
                    title_path=section_title_path.copy(),
                    content=self._merge_block_contents(
                        blocks, section.shared_example_blocks
                    ),
                    notes=shared_note,
                    source_blocks=section.shared_example_blocks.copy(),
                    metadata={
                        "atomic": True,
                        "coverage": "exclusive",
                        "title_strict": True,
                        "overflow_strategy": "function_split",
                        "shared_by_endpoints": len(section.endpoints),
                    },
                )
            )

        return chunks

    def _get_section_title_path(
        self,
        blocks: List[StructureBlock],
        heading_block: Optional[int],
        heading_context: List[str],
    ) -> List[str]:
        """
        Get the title path for a section.

        Args:
            blocks: All document blocks
            heading_block: Block index of section heading (may be None)
            heading_context: Current heading hierarchy

        Returns:
            Title path list
        """
        if heading_block is not None and 0 <= heading_block < len(blocks):
            block = blocks[heading_block]
            if block.type == BlockType.HEADING:
                # Extract heading text
                heading_text = self._extract_heading_text(block.content)
                level = block.level or 1

                # Update context based on heading level
                if level <= len(heading_context):
                    return heading_context[: level - 1] + [heading_text]
                return heading_context + [heading_text]

        return heading_context.copy()

    def _extract_heading_text(self, content: str) -> str:
        """
        Extract clean heading text from content.

        Args:
            content: Raw heading content

        Returns:
            Clean heading text
        """
        text = content.strip()
        # Remove markdown heading markers
        text = re.sub(r"^#{1,6}\s+", "", text)
        # Remove trailing punctuation
        text = re.sub(r"[:\s]+$", "", text)
        return text

    def _merge_block_contents(
        self, blocks: List[StructureBlock], indices: List[int]
    ) -> str:
        """
        Merge content from multiple blocks.

        Args:
            blocks: All document blocks
            indices: Block indices to merge

        Returns:
            Merged content string
        """
        contents = []
        for i in indices:
            if 0 <= i < len(blocks):
                contents.append(blocks[i].content)
        return "\n\n".join(contents)

    def convert_to_chunk_dicts(
        self, semantic_chunks: List[SemanticChunk]
    ) -> List[Dict[str, Any]]:
        """
        Convert SemanticChunks to chunk dictionaries for pipeline compatibility.

        Args:
            semantic_chunks: List of SemanticChunk objects

        Returns:
            List of chunk dictionaries compatible with token splitter
        """
        return [
            {
                "content": chunk.content,
                "chunk_type": chunk.chunk_type,
                "title_path": chunk.title_path,
                "notes": chunk.notes,
                "source_blocks": chunk.source_blocks,
                "metadata": chunk.metadata,
            }
            for chunk in semantic_chunks
        ]
