# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for API structure detection and chunking.

Tests cover:
1. API endpoint parsing
2. Multi-endpoint shared parameters detection
3. Endpoint-specific description detection
4. API rule-based chunking
5. Integration with main pipeline
"""

import pytest

from app.services.rag.splitter.chunkers import APIRuleBasedChunker
from app.services.rag.splitter.models import (
    APIDocumentInfo,
    APIEndpoint,
    APISection,
    BlockType,
    SemanticChunk,
    StructureBlock,
)
from app.services.rag.splitter.recognizers import APIStructureDetector


class TestAPIEndpoint:
    """Test APIEndpoint data model."""

    def test_endpoint_creation(self):
        """Test creating an API endpoint."""
        endpoint = APIEndpoint(
            block_index=1,
            method="GET",
            path="/api/v1/users",
        )

        assert endpoint.method == "GET"
        assert endpoint.path == "/api/v1/users"
        assert endpoint.block_index == 1
        assert endpoint.description_blocks == []

    def test_endpoint_with_descriptions(self):
        """Test endpoint with description blocks."""
        endpoint = APIEndpoint(
            block_index=1,
            method="POST",
            path="/api/v1/users",
            description_blocks=[2, 3],
        )

        assert len(endpoint.description_blocks) == 2

    def test_endpoint_to_dict(self):
        """Test endpoint serialization."""
        endpoint = APIEndpoint(
            block_index=1,
            method="DELETE",
            path="/api/v1/users/{id}",
        )

        result = endpoint.to_dict()

        assert result["method"] == "DELETE"
        assert result["path"] == "/api/v1/users/{id}"
        assert result["block_index"] == 1


class TestAPISection:
    """Test APISection data model."""

    def test_single_endpoint_section(self):
        """Test section with single endpoint."""
        section = APISection(
            heading_block=0,
            endpoints=[
                APIEndpoint(block_index=1, method="GET", path="/users"),
            ],
        )

        assert not section.is_multi_endpoint
        assert len(section.all_endpoint_blocks) == 1
        assert section.total_shared_blocks == 0

    def test_multi_endpoint_section(self):
        """Test section with multiple endpoints."""
        section = APISection(
            heading_block=0,
            endpoints=[
                APIEndpoint(block_index=1, method="GET", path="/users"),
                APIEndpoint(block_index=2, method="POST", path="/users"),
            ],
            shared_params_blocks=[3],
            shared_response_blocks=[4],
        )

        assert section.is_multi_endpoint
        assert len(section.all_endpoint_blocks) == 2
        assert section.total_shared_blocks == 2

    def test_section_to_dict(self):
        """Test section serialization."""
        section = APISection(
            heading_block=0,
            endpoints=[
                APIEndpoint(block_index=1, method="GET", path="/users"),
            ],
            shared_params_blocks=[2],
        )

        result = section.to_dict()

        assert result["heading_block"] == 0
        assert len(result["endpoints"]) == 1
        assert result["shared_params_blocks"] == [2]


class TestAPIDocumentInfo:
    """Test APIDocumentInfo data model."""

    def test_non_api_document(self):
        """Test non-API document."""
        info = APIDocumentInfo(is_api_doc=False)

        assert not info.is_api_doc
        assert info.total_endpoints == 0
        assert not info.has_multi_endpoint_sections

    def test_api_document_with_sections(self):
        """Test API document with sections."""
        info = APIDocumentInfo(
            is_api_doc=True,
            api_sections=[
                APISection(
                    endpoints=[
                        APIEndpoint(block_index=1, method="GET", path="/a"),
                        APIEndpoint(block_index=2, method="POST", path="/a"),
                    ],
                ),
                APISection(
                    endpoints=[
                        APIEndpoint(block_index=5, method="GET", path="/b"),
                    ],
                ),
            ],
        )

        assert info.is_api_doc
        assert info.total_endpoints == 3
        assert info.has_multi_endpoint_sections
        assert info.multi_endpoint_section_count == 1


class TestAPIStructureDetector:
    """Test API structure detector."""

    def test_detect_single_endpoint(self):
        """Test detecting a single API endpoint."""
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
                content="GET /api/v1/users",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Get all users from the system.",
                line_start=3,
                line_end=3,
            ),
        ]

        detector = APIStructureDetector()
        result = detector.detect(blocks)

        assert result.is_api_doc
        assert len(result.api_sections) == 1
        assert len(result.api_sections[0].endpoints) == 1
        assert result.api_sections[0].endpoints[0].method == "GET"
        assert result.api_sections[0].endpoints[0].path == "/api/v1/users"

    def test_detect_multi_endpoint_shared_params(self):
        """Test detecting multiple endpoints sharing parameters."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="## User Interface",
                level=2,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="GET /users",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="POST /users",
                line_start=3,
                line_end=3,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Request Parameters:",
                line_start=4,
                line_end=4,
            ),
            StructureBlock(
                type=BlockType.TABLE,
                content="| Param | Type | Desc |\n|---|---|---|",
                line_start=5,
                line_end=6,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Response Example:",
                line_start=7,
                line_end=7,
            ),
            StructureBlock(
                type=BlockType.CODE,
                content="```json\n{}\n```",
                line_start=8,
                line_end=10,
            ),
        ]

        detector = APIStructureDetector()
        result = detector.detect(blocks)

        assert result.is_api_doc
        assert len(result.api_sections) == 1

        section = result.api_sections[0]
        assert section.is_multi_endpoint
        assert len(section.endpoints) == 2
        assert section.endpoints[0].method == "GET"
        assert section.endpoints[1].method == "POST"
        assert len(section.shared_params_blocks) == 1  # Shared params table
        assert len(section.shared_example_blocks) == 1  # Shared example

    def test_detect_endpoint_specific_description(self):
        """Test detecting endpoint-specific descriptions."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="## User Interface",
                level=2,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="GET /users",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Get user list",  # Short, endpoint-specific
                line_start=3,
                line_end=3,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="POST /users",
                line_start=4,
                line_end=4,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Create new user",  # Short, endpoint-specific
                line_start=5,
                line_end=5,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Request Parameters:",
                line_start=6,
                line_end=6,
            ),
            StructureBlock(
                type=BlockType.TABLE,
                content="| Param | Type |\n|---|---|",
                line_start=7,
                line_end=8,
            ),
        ]

        detector = APIStructureDetector()
        result = detector.detect(blocks)

        assert result.is_api_doc
        section = result.api_sections[0]
        assert len(section.endpoints) == 2

        # Each endpoint should have its specific description
        assert len(section.endpoints[0].description_blocks) == 1
        assert len(section.endpoints[1].description_blocks) == 1
        assert len(section.shared_params_blocks) == 1

    def test_detect_various_http_methods(self):
        """Test detecting various HTTP methods."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="GET /api/resource",
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="POST /api/resource",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="PUT /api/resource/{id}",
                line_start=3,
                line_end=3,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="DELETE /api/resource/{id}",
                line_start=4,
                line_end=4,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="PATCH /api/resource/{id}",
                line_start=5,
                line_end=5,
            ),
        ]

        detector = APIStructureDetector()
        result = detector.detect(blocks)

        assert result.is_api_doc
        assert result.total_endpoints == 5

        methods = [ep.method for s in result.api_sections for ep in s.endpoints]
        assert "GET" in methods
        assert "POST" in methods
        assert "PUT" in methods
        assert "DELETE" in methods
        assert "PATCH" in methods

    def test_detect_non_api_document(self):
        """Test detection on non-API document."""
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
                content="This is a regular document without any API endpoints.",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.LIST,
                content="- Item 1\n- Item 2",
                line_start=3,
                line_end=4,
            ),
        ]

        detector = APIStructureDetector()
        result = detector.detect(blocks)

        assert not result.is_api_doc
        assert len(result.api_sections) == 0

    def test_detect_endpoints_without_heading(self):
        """Test detecting endpoints without preceding heading."""
        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="GET /api/users",
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.TABLE,
                content="| Param | Type |\n|---|---|",
                line_start=2,
                line_end=3,
            ),
        ]

        detector = APIStructureDetector()
        result = detector.detect(blocks)

        assert result.is_api_doc
        assert len(result.api_sections) == 1
        assert result.api_sections[0].heading_block is None
        assert len(result.api_sections[0].endpoints) == 1


class TestAPIRuleBasedChunker:
    """Test API rule-based chunker."""

    def test_chunk_single_endpoint(self):
        """Test chunking a single endpoint section."""
        blocks = [
            StructureBlock(
                type=BlockType.HEADING,
                content="## Get Users",
                level=2,
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="GET /api/users",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.TABLE,
                content="| Param | Type |\n|---|---|",
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
                    shared_params_blocks=[2],
                ),
            ],
        )

        chunker = APIRuleBasedChunker()
        chunks = chunker.chunk(blocks, api_info)

        assert len(chunks) >= 2  # At least definition and params

        chunk_types = [c.chunk_type for c in chunks]
        assert "api_definition" in chunk_types
        assert "api_params" in chunk_types

    def test_chunk_multi_endpoint_section(self):
        """Test chunking multi-endpoint section with shared resources."""
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
                content="GET /users",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="POST /users",
                line_start=3,
                line_end=3,
            ),
            StructureBlock(
                type=BlockType.TABLE,
                content="| Param | Type |\n|---|---|",
                line_start=4,
                line_end=5,
            ),
            StructureBlock(
                type=BlockType.CODE,
                content="```json\n{}\n```",
                line_start=6,
                line_end=8,
            ),
        ]

        api_info = APIDocumentInfo(
            is_api_doc=True,
            api_sections=[
                APISection(
                    heading_block=0,
                    endpoints=[
                        APIEndpoint(block_index=1, method="GET", path="/users"),
                        APIEndpoint(block_index=2, method="POST", path="/users"),
                    ],
                    shared_params_blocks=[3],
                    shared_example_blocks=[4],
                ),
            ],
        )

        chunker = APIRuleBasedChunker()
        chunks = chunker.chunk(blocks, api_info)

        # Should have: definition, params, example
        chunk_types = [c.chunk_type for c in chunks]
        assert "api_definition" in chunk_types
        assert "api_params" in chunk_types
        assert "api_example" in chunk_types

        # Definition should contain both endpoints
        definition_chunk = next(c for c in chunks if c.chunk_type == "api_definition")
        assert len(definition_chunk.metadata.get("endpoints", [])) == 2

        # Params should indicate shared
        params_chunk = next(c for c in chunks if c.chunk_type == "api_params")
        assert params_chunk.metadata.get("shared_by_endpoints") == 2

    def test_chunk_with_endpoint_specific_descriptions(self):
        """Test chunking with endpoint-specific descriptions."""
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
                content="GET /users",
                line_start=2,
                line_end=2,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="GET endpoint description",
                line_start=3,
                line_end=3,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="POST /users",
                line_start=4,
                line_end=4,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="POST endpoint description",
                line_start=5,
                line_end=5,
            ),
        ]

        api_info = APIDocumentInfo(
            is_api_doc=True,
            api_sections=[
                APISection(
                    heading_block=0,
                    endpoints=[
                        APIEndpoint(
                            block_index=1,
                            method="GET",
                            path="/users",
                            description_blocks=[2],
                        ),
                        APIEndpoint(
                            block_index=3,
                            method="POST",
                            path="/users",
                            description_blocks=[4],
                        ),
                    ],
                ),
            ],
        )

        chunker = APIRuleBasedChunker()
        chunks = chunker.chunk(blocks, api_info)

        # Should have definition + 2 endpoint-specific descriptions
        description_chunks = [c for c in chunks if c.chunk_type == "api_description"]
        assert len(description_chunks) == 2

        # Each description should reference its endpoint
        for desc_chunk in description_chunks:
            assert "endpoint" in desc_chunk.metadata

    def test_convert_to_chunk_dicts(self):
        """Test converting semantic chunks to dictionaries."""
        chunks = [
            SemanticChunk(
                chunk_type="api_definition",
                title_path=["API", "Users"],
                content="GET /api/users",
                notes="API definition",
                source_blocks=[1],
                metadata={"atomic": True},
            ),
        ]

        chunker = APIRuleBasedChunker()
        dicts = chunker.convert_to_chunk_dicts(chunks)

        assert len(dicts) == 1
        assert dicts[0]["chunk_type"] == "api_definition"
        assert dicts[0]["content"] == "GET /api/users"
        assert dicts[0]["title_path"] == ["API", "Users"]


class TestSemanticChunk:
    """Test SemanticChunk data model."""

    def test_chunk_creation(self):
        """Test creating a semantic chunk."""
        chunk = SemanticChunk(
            chunk_type="api_params",
            title_path=["API", "Users"],
            content="| Param | Type |",
            notes="Parameter table",
        )

        assert chunk.chunk_type == "api_params"
        assert chunk.title_path == ["API", "Users"]

    def test_chunk_with_metadata(self):
        """Test chunk with metadata."""
        chunk = SemanticChunk(
            chunk_type="api_definition",
            title_path=[],
            content="GET /users",
            metadata={
                "atomic": True,
                "coverage": "exclusive",
                "endpoints": [{"method": "GET", "path": "/users"}],
            },
        )

        assert chunk.metadata["atomic"] is True
        assert chunk.metadata["coverage"] == "exclusive"

    def test_chunk_to_dict(self):
        """Test chunk serialization."""
        chunk = SemanticChunk(
            chunk_type="api_example",
            title_path=["API"],
            content="{}",
            notes="JSON example",
            source_blocks=[1, 2],
        )

        result = chunk.to_dict()

        assert result["chunk_type"] == "api_example"
        assert result["source_blocks"] == [1, 2]
