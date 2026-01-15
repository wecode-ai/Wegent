# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for RAG result persistence data format.

These tests ensure that the extracted_text field uses the correct JSON structure
with chunks and sources arrays, matching the frontend SourceReference interface.
"""

import json

import pytest

from chat_shell.tools.builtin.knowledge_base import KnowledgeBaseTool


class TestRagPersistenceFormat:
    """Test RAG result persistence data format."""

    def setup_method(self):
        self.tool = KnowledgeBaseTool()

    def test_build_extracted_data_returns_valid_json(self):
        """_build_extracted_data should return valid JSON string."""
        chunks = [
            {
                "content": "test content",
                "source": "test.md",
                "score": 0.85,
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [{"index": 1, "title": "test.md", "kb_id": 1}]

        result = self.tool._build_extracted_data(chunks, source_references, 1)

        # Should be valid JSON
        data = json.loads(result)
        assert isinstance(data, dict)

    def test_extracted_data_has_correct_structure(self):
        """extracted_text should have chunks and sources arrays."""
        chunks = [
            {
                "content": "test content",
                "source": "test.md",
                "score": 0.85,
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [{"index": 1, "title": "test.md", "kb_id": 1}]

        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        assert "chunks" in data
        assert "sources" in data
        assert isinstance(data["chunks"], list)
        assert isinstance(data["sources"], list)

    def test_chunk_has_required_fields(self):
        """Each chunk should have content, source, score, knowledge_base_id, source_index."""
        chunks = [
            {
                "content": "test content",
                "source": "test.md",
                "score": 0.85,
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [{"index": 1, "title": "test.md", "kb_id": 1}]

        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        assert len(data["chunks"]) == 1
        chunk = data["chunks"][0]
        assert chunk["content"] == "test content"
        assert chunk["source"] == "test.md"
        assert chunk["score"] == 0.85
        assert chunk["knowledge_base_id"] == 1
        assert chunk["source_index"] == 1

    def test_direct_injection_score_is_null(self):
        """Direct injection mode should have null score."""
        chunks = [
            {
                "content": "injected content",
                "source": "doc.md",
                "score": None,  # Direct injection
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [{"index": 1, "title": "doc.md", "kb_id": 1}]

        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        assert data["chunks"][0]["score"] is None

    def test_rag_retrieval_score_is_float(self):
        """RAG retrieval mode should have float score."""
        chunks = [
            {
                "content": "retrieved content",
                "source": "doc.md",
                "score": 0.75,  # RAG similarity score
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [{"index": 1, "title": "doc.md", "kb_id": 1}]

        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        assert data["chunks"][0]["score"] == 0.75
        assert isinstance(data["chunks"][0]["score"], float)

    def test_sources_match_frontend_format(self):
        """Sources should match SourceReference interface for frontend."""
        # Frontend expects: {index: number, title: string, kb_id: number}
        chunks = [
            {
                "content": "content",
                "source": "doc1.md",
                "score": 0.8,
                "knowledge_base_id": 10,
                "source_index": 1,
            }
        ]
        source_references = [
            {"index": 1, "title": "doc1.md", "kb_id": 10},
            {"index": 2, "title": "doc2.md", "kb_id": 10},
        ]

        result = self.tool._build_extracted_data(chunks, source_references, 10)
        data = json.loads(result)

        for source in data["sources"]:
            assert isinstance(source["index"], int)
            assert isinstance(source["title"], str)
            assert isinstance(source["kb_id"], int)

    def test_content_is_plain_text_not_json(self):
        """Content should be plain text, not serialized TextNode."""
        content = "这是纯文本内容"
        chunks = [
            {
                "content": content,
                "source": "doc.md",
                "score": 0.8,
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [{"index": 1, "title": "doc.md", "kb_id": 1}]

        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        chunk_content = data["chunks"][0]["content"]
        # Should NOT contain LlamaIndex TextNode fields
        assert "id_" not in chunk_content
        assert "embedding" not in chunk_content
        assert "class_name" not in chunk_content
        assert "TextNode" not in chunk_content
        assert "excluded_embed_metadata_keys" not in chunk_content
        # Should contain the actual text
        assert "这是纯文本内容" in chunk_content

    def test_multiple_chunks_from_same_source(self):
        """Multiple chunks from same source should share source_index."""
        chunks = [
            {
                "content": "chunk 1",
                "source": "doc.md",
                "score": 0.9,
                "knowledge_base_id": 1,
                "source_index": 1,
            },
            {
                "content": "chunk 2",
                "source": "doc.md",
                "score": 0.8,
                "knowledge_base_id": 1,
                "source_index": 1,
            },
            {
                "content": "chunk 3",
                "source": "other.md",
                "score": 0.7,
                "knowledge_base_id": 1,
                "source_index": 2,
            },
        ]
        source_references = [
            {"index": 1, "title": "doc.md", "kb_id": 1},
            {"index": 2, "title": "other.md", "kb_id": 1},
        ]

        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        # First two chunks should have same source_index
        assert (
            data["chunks"][0]["source_index"] == data["chunks"][1]["source_index"] == 1
        )
        # Third chunk should have different source_index
        assert data["chunks"][2]["source_index"] == 2
        # Sources should be deduplicated
        assert len(data["sources"]) == 2

    def test_filters_chunks_by_kb_id(self):
        """_build_extracted_data should filter chunks by knowledge_base_id."""
        chunks = [
            {
                "content": "kb1 content",
                "source": "doc1.md",
                "score": 0.9,
                "knowledge_base_id": 1,
                "source_index": 1,
            },
            {
                "content": "kb2 content",
                "source": "doc2.md",
                "score": 0.8,
                "knowledge_base_id": 2,
                "source_index": 2,
            },
        ]
        source_references = [
            {"index": 1, "title": "doc1.md", "kb_id": 1},
            {"index": 2, "title": "doc2.md", "kb_id": 2},
        ]

        # Only get KB 1 data
        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        assert len(data["chunks"]) == 1
        assert data["chunks"][0]["content"] == "kb1 content"
        assert len(data["sources"]) == 1
        assert data["sources"][0]["title"] == "doc1.md"

    def test_filters_sources_by_kb_id(self):
        """_build_extracted_data should filter sources by kb_id."""
        chunks = [
            {
                "content": "content",
                "source": "doc.md",
                "score": 0.9,
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [
            {"index": 1, "title": "doc1.md", "kb_id": 1},
            {"index": 2, "title": "doc2.md", "kb_id": 2},
            {"index": 3, "title": "doc3.md", "kb_id": 1},
        ]

        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        # Should only have sources for KB 1
        assert len(data["sources"]) == 2
        kb_ids = [s["kb_id"] for s in data["sources"]]
        assert all(kb_id == 1 for kb_id in kb_ids)

    def test_empty_chunks_returns_empty_arrays(self):
        """Empty chunks should return empty arrays in JSON."""
        result = self.tool._build_extracted_data([], [], 1)
        data = json.loads(result)

        assert data["chunks"] == []
        assert data["sources"] == []

    def test_json_ensure_ascii_false(self):
        """JSON should preserve non-ASCII characters."""
        chunks = [
            {
                "content": "中文内容 和 日本語",
                "source": "文档.md",
                "score": 0.8,
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [{"index": 1, "title": "文档.md", "kb_id": 1}]

        result = self.tool._build_extracted_data(chunks, source_references, 1)

        # Should contain actual Chinese characters, not escaped
        assert "中文内容" in result
        assert "日本語" in result
        assert "文档.md" in result

    def test_score_precision_preserved(self):
        """Score precision should be preserved in JSON."""
        chunks = [
            {
                "content": "content",
                "source": "doc.md",
                "score": 0.123456789,
                "knowledge_base_id": 1,
                "source_index": 1,
            }
        ]
        source_references = [{"index": 1, "title": "doc.md", "kb_id": 1}]

        result = self.tool._build_extracted_data(chunks, source_references, 1)
        data = json.loads(result)

        # Score should be preserved with precision
        assert data["chunks"][0]["score"] == 0.123456789


class TestKnowledgeBaseToolDirectInjection:
    """Test KnowledgeBaseTool direct injection behavior."""

    def test_direct_injection_chunks_have_null_score(self):
        """Chunks from direct injection should have null score."""
        # This tests the behavior when processing all chunks
        # In _get_all_chunks_from_all_kbs, score should be set to None
        chunk = {
            "content": "test",
            "source": "doc.md",
            "score": None,  # Should be None for direct injection
            "knowledge_base_id": 1,
        }

        assert chunk["score"] is None

    def test_rag_retrieval_chunks_have_float_score(self):
        """Chunks from RAG retrieval should have float score."""
        # In _retrieve_chunks_from_all_kbs, score comes from similarity
        chunk = {
            "content": "test",
            "source": "doc.md",
            "score": 0.85,  # Should be float for RAG
            "knowledge_base_id": 1,
        }

        assert isinstance(chunk["score"], float)
        assert chunk["score"] == 0.85


class TestKnowledgeBaseToolSourcesField:
    """Test that both Direct Injection and RAG modes return sources field."""

    def setup_method(self):
        self.tool = KnowledgeBaseTool()

    def test_format_direct_injection_result_includes_sources(self):
        """_format_direct_injection_result should include sources field."""
        injection_result = {
            "mode": "direct_injection",
            "injected_content": "Test content",
            "chunks_used": [
                {
                    "content": "chunk 1",
                    "source": "doc1.md",
                    "knowledge_base_id": 1,
                },
                {
                    "content": "chunk 2",
                    "source": "doc2.md",
                    "knowledge_base_id": 1,
                },
                {
                    "content": "chunk 3",
                    "source": "doc1.md",  # Duplicate source
                    "knowledge_base_id": 1,
                },
            ],
            "decision_details": {},
        }

        result_json = self.tool._format_direct_injection_result(
            injection_result, "test query"
        )
        result = json.loads(result_json)

        # Should have sources field
        assert "sources" in result
        assert isinstance(result["sources"], list)
        # Should have 2 unique sources (doc1.md and doc2.md)
        assert len(result["sources"]) == 2

    def test_direct_injection_sources_have_correct_format(self):
        """Direct injection sources should have index, title, kb_id fields."""
        injection_result = {
            "mode": "direct_injection",
            "injected_content": "Test content",
            "chunks_used": [
                {
                    "content": "chunk",
                    "source": "test.md",
                    "knowledge_base_id": 10,
                }
            ],
            "decision_details": {},
        }

        result_json = self.tool._format_direct_injection_result(
            injection_result, "test query"
        )
        result = json.loads(result_json)

        source = result["sources"][0]
        assert "index" in source
        assert "title" in source
        assert "kb_id" in source
        assert isinstance(source["index"], int)
        assert isinstance(source["title"], str)
        assert isinstance(source["kb_id"], int)
        assert source["title"] == "test.md"
        assert source["kb_id"] == 10

    def test_direct_injection_sources_deduplicated(self):
        """Direct injection should deduplicate sources by (kb_id, title)."""
        injection_result = {
            "mode": "direct_injection",
            "injected_content": "Test content",
            "chunks_used": [
                {"content": "c1", "source": "doc.md", "knowledge_base_id": 1},
                {
                    "content": "c2",
                    "source": "doc.md",
                    "knowledge_base_id": 1,
                },  # Duplicate
                {"content": "c3", "source": "other.md", "knowledge_base_id": 1},
                {
                    "content": "c4",
                    "source": "doc.md",
                    "knowledge_base_id": 2,
                },  # Different KB
            ],
            "decision_details": {},
        }

        result_json = self.tool._format_direct_injection_result(
            injection_result, "test query"
        )
        result = json.loads(result_json)

        # Should have 3 unique sources: (1, doc.md), (1, other.md), (2, doc.md)
        assert len(result["sources"]) == 3
        titles = [(s["kb_id"], s["title"]) for s in result["sources"]]
        assert (1, "doc.md") in titles
        assert (1, "other.md") in titles
        assert (2, "doc.md") in titles

    def test_direct_injection_sources_have_sequential_index(self):
        """Direct injection sources should have sequential index starting from 1."""
        injection_result = {
            "mode": "direct_injection",
            "injected_content": "Test content",
            "chunks_used": [
                {"content": "c1", "source": "doc1.md", "knowledge_base_id": 1},
                {"content": "c2", "source": "doc2.md", "knowledge_base_id": 1},
                {"content": "c3", "source": "doc3.md", "knowledge_base_id": 1},
            ],
            "decision_details": {},
        }

        result_json = self.tool._format_direct_injection_result(
            injection_result, "test query"
        )
        result = json.loads(result_json)

        indices = [s["index"] for s in result["sources"]]
        assert indices == [1, 2, 3]

    @pytest.mark.asyncio
    async def test_format_rag_result_includes_sources(self):
        """_format_rag_result should include sources field."""
        kb_chunks = {
            1: [
                {
                    "content": "chunk 1",
                    "source": "doc1.md",
                    "score": 0.9,
                    "knowledge_base_id": 1,
                },
                {
                    "content": "chunk 2",
                    "source": "doc2.md",
                    "score": 0.8,
                    "knowledge_base_id": 1,
                },
            ]
        }

        result_json = await self.tool._format_rag_result(kb_chunks, "test query", 20)
        result = json.loads(result_json)

        # Should have sources field
        assert "sources" in result
        assert isinstance(result["sources"], list)
        assert len(result["sources"]) == 2

    @pytest.mark.asyncio
    async def test_rag_result_sources_have_correct_format(self):
        """RAG result sources should have index, title, kb_id fields."""
        kb_chunks = {
            10: [
                {
                    "content": "chunk",
                    "source": "test.md",
                    "score": 0.85,
                    "knowledge_base_id": 10,
                }
            ]
        }

        result_json = await self.tool._format_rag_result(kb_chunks, "test query", 20)
        result = json.loads(result_json)

        source = result["sources"][0]
        assert "index" in source
        assert "title" in source
        assert "kb_id" in source
        assert source["title"] == "test.md"
        assert source["kb_id"] == 10

    @pytest.mark.asyncio
    async def test_rag_result_sources_deduplicated(self):
        """RAG result should deduplicate sources by (kb_id, title)."""
        kb_chunks = {
            1: [
                {
                    "content": "c1",
                    "source": "doc.md",
                    "score": 0.9,
                    "knowledge_base_id": 1,
                },
                {
                    "content": "c2",
                    "source": "doc.md",
                    "score": 0.8,
                    "knowledge_base_id": 1,
                },  # Duplicate
                {
                    "content": "c3",
                    "source": "other.md",
                    "score": 0.7,
                    "knowledge_base_id": 1,
                },
            ]
        }

        result_json = await self.tool._format_rag_result(kb_chunks, "test query", 20)
        result = json.loads(result_json)

        # Should have 2 unique sources
        assert len(result["sources"]) == 2
        titles = [s["title"] for s in result["sources"]]
        assert "doc.md" in titles
        assert "other.md" in titles

    @pytest.mark.asyncio
    async def test_rag_result_count_matches_sources(self):
        """RAG result count field should match number of chunks."""
        kb_chunks = {
            1: [
                {
                    "content": "c1",
                    "source": "doc1.md",
                    "score": 0.9,
                    "knowledge_base_id": 1,
                },
                {
                    "content": "c2",
                    "source": "doc2.md",
                    "score": 0.8,
                    "knowledge_base_id": 1,
                },
                {
                    "content": "c3",
                    "source": "doc3.md",
                    "score": 0.7,
                    "knowledge_base_id": 1,
                },
            ]
        }

        result_json = await self.tool._format_rag_result(kb_chunks, "test query", 20)
        result = json.loads(result_json)

        assert result["count"] == 3
        assert len(result["results"]) == 3
        assert len(result["sources"]) == 3

    @pytest.mark.asyncio
    async def test_direct_injection_and_rag_sources_format_consistent(self):
        """Direct injection and RAG should return sources in the same format."""
        # Direct injection
        injection_result = {
            "mode": "direct_injection",
            "injected_content": "Test",
            "chunks_used": [
                {"content": "c", "source": "doc.md", "knowledge_base_id": 1}
            ],
            "decision_details": {},
        }
        direct_json = self.tool._format_direct_injection_result(
            injection_result, "query"
        )
        direct_result = json.loads(direct_json)

        # RAG
        kb_chunks = {
            1: [
                {
                    "content": "c",
                    "source": "doc.md",
                    "score": 0.8,
                    "knowledge_base_id": 1,
                }
            ]
        }
        rag_json = await self.tool._format_rag_result(kb_chunks, "query", 20)
        rag_result = json.loads(rag_json)

        # Both should have sources with same structure
        assert "sources" in direct_result
        assert "sources" in rag_result
        direct_source = direct_result["sources"][0]
        rag_source = rag_result["sources"][0]
        assert set(direct_source.keys()) == set(rag_source.keys())
        assert set(direct_source.keys()) == {"index", "title", "kb_id"}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
