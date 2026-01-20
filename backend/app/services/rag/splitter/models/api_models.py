# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Data models for API document structure detection.

This module defines the data structures used for detecting and representing
API documentation patterns, including support for multiple endpoints sharing
parameters, responses, and examples.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class APIEndpoint:
    """
    Single API endpoint representation.

    Attributes:
        block_index: Index of the endpoint block in the document IR
        method: HTTP method (GET, POST, PUT, DELETE, etc.)
        path: API path (e.g., /api/v1/users)
        description_blocks: List of block indices for endpoint-specific descriptions
    """

    block_index: int
    method: str
    path: str
    description_blocks: List[int] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "block_index": self.block_index,
            "method": self.method,
            "path": self.path,
            "description_blocks": self.description_blocks,
        }


@dataclass
class APISection:
    """
    API section representing a group of endpoints with shared resources.

    Supports the common pattern where multiple endpoints share parameters,
    responses, and examples. For example:

        ## User Interface
        GET /users      <- endpoint 1
        POST /users     <- endpoint 2

        Request Parameters:    <- shared_params (shared by both endpoints)
        | ... |

        Response Example:      <- shared_examples
        ```json
        ...
        ```

    Attributes:
        heading_block: Block index of the section heading (if any)
        endpoints: List of API endpoints in this section
        shared_description_blocks: Block indices for shared section descriptions
        shared_params_blocks: Block indices for shared parameter tables
        shared_response_blocks: Block indices for shared response descriptions
        shared_example_blocks: Block indices for shared examples/code blocks
    """

    heading_block: Optional[int] = None
    endpoints: List[APIEndpoint] = field(default_factory=list)

    # Shared resources (used by multiple endpoints)
    shared_description_blocks: List[int] = field(default_factory=list)
    shared_params_blocks: List[int] = field(default_factory=list)
    shared_response_blocks: List[int] = field(default_factory=list)
    shared_example_blocks: List[int] = field(default_factory=list)

    @property
    def is_multi_endpoint(self) -> bool:
        """Check if this section contains multiple endpoints."""
        return len(self.endpoints) > 1

    @property
    def all_endpoint_blocks(self) -> List[int]:
        """Get all endpoint block indices."""
        return [ep.block_index for ep in self.endpoints]

    @property
    def total_shared_blocks(self) -> int:
        """Get total count of shared resource blocks."""
        return (
            len(self.shared_description_blocks)
            + len(self.shared_params_blocks)
            + len(self.shared_response_blocks)
            + len(self.shared_example_blocks)
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "heading_block": self.heading_block,
            "endpoints": [ep.to_dict() for ep in self.endpoints],
            "is_multi_endpoint": self.is_multi_endpoint,
            "shared_description_blocks": self.shared_description_blocks,
            "shared_params_blocks": self.shared_params_blocks,
            "shared_response_blocks": self.shared_response_blocks,
            "shared_example_blocks": self.shared_example_blocks,
        }


@dataclass
class APIDocumentInfo:
    """
    API document structure detection result.

    Attributes:
        is_api_doc: Whether the document is identified as API documentation
        api_sections: List of detected API sections
    """

    is_api_doc: bool
    api_sections: List[APISection] = field(default_factory=list)

    @property
    def has_multi_endpoint_sections(self) -> bool:
        """Check if any section has multiple endpoints sharing resources."""
        return any(s.is_multi_endpoint for s in self.api_sections)

    @property
    def total_endpoints(self) -> int:
        """Get total count of endpoints across all sections."""
        return sum(len(s.endpoints) for s in self.api_sections)

    @property
    def multi_endpoint_section_count(self) -> int:
        """Get count of sections with multiple endpoints."""
        return sum(1 for s in self.api_sections if s.is_multi_endpoint)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "is_api_doc": self.is_api_doc,
            "api_sections": [s.to_dict() for s in self.api_sections],
            "has_multi_endpoint_sections": self.has_multi_endpoint_sections,
            "total_endpoints": self.total_endpoints,
        }


@dataclass
class SemanticChunk:
    """
    Semantic chunk for rule-based chunking.

    This is used by the API rule-based chunker to create semantically
    meaningful chunks with rich metadata for downstream processing.

    Attributes:
        chunk_type: Type of chunk (api_definition, api_description, api_params,
                   api_response, api_example, table, code, example, paragraph, list, definition)
        title_path: Heading hierarchy path
        content: Chunk content
        notes: Processing notes or description
        source_blocks: List of source block indices
        metadata: Additional metadata including coverage, atomic flag, etc.

    Metadata keys:
        - atomic: bool - Whether the chunk cannot be split
        - coverage: str - "exclusive" (no overlap) or "shared" (allows overlap)
        - title_strict: bool - Whether title_path must match exactly
        - overflow_strategy: str - "none", "row_split", "function_split", "item_split", "truncate"
        - is_split: bool - Whether this chunk was split from a larger chunk
        - split_index: int - Index if split
        - split_total: int - Total parts if split
    """

    chunk_type: str
    title_path: List[str]
    content: str
    notes: str = ""
    source_blocks: List[int] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    # === Computed Properties ===

    @property
    def flat_title(self) -> str:
        """Flatten title path for UI display: 'Section > Subsection'"""
        return " > ".join(self.title_path) if self.title_path else ""

    @property
    def section_path_text(self) -> str:
        """Section path text for context injection: '[Section/Subsection]'"""
        return "[" + "/".join(self.title_path) + "]" if self.title_path else ""

    @property
    def is_atomic(self) -> bool:
        """Whether the chunk cannot be split."""
        return self.metadata.get("atomic", False)

    @property
    def coverage(self) -> str:
        """Coverage strategy: 'exclusive' (no overlap) or 'shared' (allows overlap)."""
        return self.metadata.get("coverage", "exclusive")

    @property
    def overflow_strategy(self) -> str:
        """Overflow handling strategy: 'none', 'row_split', 'function_split', 'item_split', 'truncate'."""
        return self.metadata.get("overflow_strategy", "none")

    @property
    def is_title_strict(self) -> bool:
        """Whether title_path must match heading_context exactly."""
        return self.metadata.get("title_strict", False)

    @property
    def is_split(self) -> bool:
        """Whether this chunk was split from a larger chunk."""
        return self.metadata.get("is_split", False)

    @property
    def split_index(self) -> Optional[int]:
        """Index of this split part (0-based)."""
        return self.metadata.get("split_index")

    @property
    def split_total(self) -> Optional[int]:
        """Total number of split parts."""
        return self.metadata.get("split_total")

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "chunk_type": self.chunk_type,
            "title_path": self.title_path,
            "content": self.content,
            "notes": self.notes,
            "source_blocks": self.source_blocks,
            "metadata": self.metadata,
            # Include computed properties for convenience
            "flat_title": self.flat_title,
            "section_path_text": self.section_path_text,
            "is_atomic": self.is_atomic,
            "coverage": self.coverage,
            "overflow_strategy": self.overflow_strategy,
            "is_title_strict": self.is_title_strict,
        }
