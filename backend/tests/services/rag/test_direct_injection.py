# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for direct injection and original document retrieval."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def set_auto_direct_injection_enabled_by_default(monkeypatch):
    """Enable auto direct injection by default for all tests in this module."""
    from app.core.config import settings

    monkeypatch.setattr(
        settings,
        "RAG_AUTO_DISABLE_DIRECT_INJECTION",
        False,
        raising=False,
    )


@pytest.mark.unit
class TestGetOriginalDocumentsFromKnowledgeBase:
    """Tests for get_original_documents_from_knowledge_base method."""

    @pytest.mark.asyncio
    async def test_returns_full_content_not_chunks(self):
        """Original documents should return complete content, not chunks."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        # Return (id, kind_id, text_length) tuples
        mock_query.all.return_value = [(1, 123, 100), (2, 123, 200)]
        db.query.return_value = mock_query

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            {
                "id": 1,
                "name": "doc-1.md",
                "content": "This is the full content of document 1.",
                "total_length": 35,
                "offset": 0,
                "returned_length": 35,
                "has_more": False,
                "kb_id": 123,
            },
            {
                "id": 2,
                "name": "doc-2.md",
                "content": "This is the full content of document 2.",
                "total_length": 35,
                "offset": 0,
                "returned_length": 35,
                "has_more": False,
                "kb_id": 123,
            },
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            service = RetrievalService()
            records = await service.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
            )

        assert records is not None
        assert len(records) == 2
        assert records[0]["content"] == "This is the full content of document 1."
        assert records[0]["score"] == 1.0
        assert records[0]["title"] == "doc-1.md"
        assert records[0]["metadata"]["document_id"] == 1
        assert records[0]["knowledge_base_id"] == 123

    @pytest.mark.asyncio
    async def test_respects_document_filter(self):
        """Document IDs filter should work with original documents."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        # Return (id, kind_id, text_length) tuples when document_ids provided
        mock_query.all.return_value = [(1, 123, 100)]
        db.query.return_value = mock_query

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            {
                "id": 1,
                "name": "doc-1.md",
                "content": "Filtered document content.",
                "total_length": 26,
                "offset": 0,
                "returned_length": 26,
                "has_more": False,
                "kb_id": 123,
            },
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            service = RetrievalService()
            records = await service.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
                document_ids=[1],
            )

        assert records is not None
        assert len(records) == 1
        assert records[0]["metadata"]["document_id"] == 1

        # Verify that the DB filter was constructed using the provided document_ids
        # The implementation should call filter with KnowledgeDocument.id.in_(document_ids)
        filter_calls = mock_query.filter.call_args_list
        assert len(filter_calls) >= 2, "Expected at least 2 filter calls"

        # Check that one of the filter calls contains the document_ids condition
        # The filter is called with KnowledgeDocument.id.in_(document_ids)
        found_document_filter = False
        for call in filter_calls:
            # call[0] is the args tuple, call[0][0] is the first argument (the filter expression)
            if call.args and len(call.args) > 0:
                filter_arg = call.args[0]
                # The filter expression should contain the document_ids value
                # We check if the expression string representation contains the document id
                if "id" in str(filter_arg) and "1" in str(filter_arg):
                    found_document_filter = True
                    break
        assert found_document_filter, (
            f"Expected filter call with document_ids condition, "
            f"got filter calls: {filter_calls}"
        )

    @pytest.mark.asyncio
    async def test_returns_empty_list_for_no_documents(self):
        """Should return empty list when no documents exist."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.all.return_value = []  # No documents
        db.query.return_value = mock_query

        service = RetrievalService()
        records = await service.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[123],
            db=db,
        )

        assert records is not None
        assert records == []

    @pytest.mark.asyncio
    async def test_skips_documents_with_errors(self):
        """Documents with errors should be skipped."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        # Return (id, kind_id, text_length) tuples
        mock_query.all.return_value = [(1, 123, 100), (2, 123, 200)]
        db.query.return_value = mock_query

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            {
                "id": 1,
                "name": "doc-1.md",
                "content": "Valid content.",
                "total_length": 15,
                "offset": 0,
                "returned_length": 15,
                "has_more": False,
                "kb_id": 123,
            },
            {
                "id": 2,
                "error": "Document not found",
                "error_code": "DOCUMENT_NOT_FOUND",
            },
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            service = RetrievalService()
            records = await service.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
            )

        assert records is not None
        assert len(records) == 1
        assert records[0]["metadata"]["document_id"] == 1

    @pytest.mark.asyncio
    async def test_truncated_document_rejects_direct_injection(self):
        """Documents with text_length >= MAX_EXTRACTED_TEXT_LENGTH should be rejected."""
        from app.core.config import settings
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        # Document with text_length >= MAX_EXTRACTED_TEXT_LENGTH (id, kind_id, text_length)
        max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
        mock_query.all.return_value = [(1, 123, max_text_length)]  # Exactly at limit
        db.query.return_value = mock_query

        service = RetrievalService()
        records = await service.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[123],
            db=db,
        )

        assert records is None

    @pytest.mark.asyncio
    async def test_document_above_limit_rejects_direct_injection(self):
        """Documents with text_length > MAX_EXTRACTED_TEXT_LENGTH should be rejected."""
        from app.core.config import settings
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        # Document with text_length > MAX_EXTRACTED_TEXT_LENGTH (id, kind_id, text_length)
        max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
        mock_query.all.return_value = [(1, 123, max_text_length + 1000)]
        db.query.return_value = mock_query

        service = RetrievalService()
        records = await service.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[123],
            db=db,
        )

        assert records is None

    @pytest.mark.asyncio
    async def test_mixed_documents_reject_if_any_truncated(self):
        """If any document is truncated, entire request should be rejected."""
        from app.core.config import settings
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        # Mixed: small document and large truncated document (id, kind_id, text_length)
        max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
        mock_query.all.return_value = [(1, 123, 100), (2, 123, max_text_length)]
        db.query.return_value = mock_query

        service = RetrievalService()
        records = await service.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[123],
            db=db,
        )

        assert records is None

    @pytest.mark.asyncio
    async def test_query_by_document_ids_with_multiple_knowledge_bases(self):
        """Should support querying by document IDs within multiple knowledge base scope."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        # Return (id, kind_id, text_length) tuples when document_ids provided
        mock_query.all.return_value = [(1, 123, 100), (2, 456, 200)]
        db.query.return_value = mock_query

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            {
                "id": 1,
                "name": "doc-1.md",
                "content": "Document from KB 123.",
                "total_length": 22,
                "offset": 0,
                "returned_length": 22,
                "has_more": False,
                "kb_id": 123,
            },
            {
                "id": 2,
                "name": "doc-2.md",
                "content": "Document from KB 456.",
                "total_length": 22,
                "offset": 0,
                "returned_length": 22,
                "has_more": False,
                "kb_id": 456,
            },
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            service = RetrievalService()
            records = await service.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123, 456],
                db=db,
                document_ids=[1, 2],
            )

        assert records is not None
        assert len(records) == 2
        # Should have correct KB IDs from result
        assert records[0]["knowledge_base_id"] == 123
        assert records[1]["knowledge_base_id"] == 456

    @pytest.mark.asyncio
    async def test_query_with_both_kb_id_and_document_ids(self):
        """Should filter by both knowledge_base_id and document_ids when both provided."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        # Track that filter was called for both conditions
        mock_query.filter.return_value = mock_query
        # Return (id, kind_id, text_length) tuples
        mock_query.all.return_value = [(1, 123, 100)]
        db.query.return_value = mock_query

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            {
                "id": 1,
                "name": "doc-1.md",
                "content": "Filtered by both KB and doc IDs.",
                "total_length": 32,
                "offset": 0,
                "returned_length": 32,
                "has_more": False,
                "kb_id": 123,
            },
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            service = RetrievalService()
            records = await service.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
                document_ids=[1, 2, 3],  # Only doc 1 is in KB 123
            )

        assert records is not None
        assert len(records) == 1
        assert records[0]["knowledge_base_id"] == 123

    @pytest.mark.asyncio
    async def test_no_filter_criteria_returns_empty(self):
        """Should return empty when no knowledge_base_ids provided."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        service = RetrievalService()
        records = await service.get_original_documents_from_knowledge_base(
            knowledge_base_ids=[],  # Empty KB IDs
            db=db,
            document_ids=None,
        )

        assert records is not None
        assert records == []


@pytest.mark.unit
class TestDirectInjectionUsesOriginalDocuments:
    """Tests to verify direct_injection uses original documents instead of chunks."""

    @pytest.mark.asyncio
    async def test_direct_injection_calls_get_original_documents(self):
        """Direct injection mode should call get_original_documents, not get_all_chunks."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ):
            service = RetrievalService()
            service.get_original_documents_from_knowledge_base = AsyncMock(
                return_value=[
                    {
                        "content": "full document",
                        "score": 1.0,
                        "title": "doc-1",
                        "metadata": {"document_id": 1},
                        "knowledge_base_id": 123,
                    }
                ]
            )
            service.get_all_chunks_from_knowledge_base = AsyncMock(
                return_value=[
                    {
                        "content": "chunk",
                        "title": "doc-1",
                        "doc_ref": "1",
                    }
                ]
            )

            result = await service.retrieve_with_routing(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                context_window=10000,
                user_id=7,
            )

        # Verify get_original_documents was called
        service.get_original_documents_from_knowledge_base.assert_awaited_once_with(
            knowledge_base_ids=[123],
            db=db,
            document_ids=None,
        )
        # Verify get_all_chunks was NOT called
        service.get_all_chunks_from_knowledge_base.assert_not_awaited()
        assert result["mode"] == "direct_injection"

    @pytest.mark.asyncio
    async def test_direct_injection_with_document_ids_filter(self):
        """Direct injection should pass document_ids to get_original_documents."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ):
            service = RetrievalService()
            service.get_original_documents_from_knowledge_base = AsyncMock(
                return_value=[
                    {
                        "content": "filtered document",
                        "score": 1.0,
                        "title": "doc-1",
                        "metadata": {"document_id": 1},
                        "knowledge_base_id": 123,
                    }
                ]
            )

            result = await service.retrieve_with_routing(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                context_window=10000,
                document_ids=[1, 2, 3],
                user_id=7,
            )

        # document_ids is passed along with knowledge_base_ids for scope filtering
        service.get_original_documents_from_knowledge_base.assert_awaited_once_with(
            knowledge_base_ids=[123],
            db=db,
            document_ids=[1, 2, 3],
        )
        assert result["mode"] == "direct_injection"
        assert len(result["records"]) == 1


@pytest.mark.unit
class TestDirectInjectionTruncationRejection:
    """Tests for direct injection truncation rejection and fallback."""

    @pytest.mark.asyncio
    async def test_truncated_documents_fallback_to_rag(self):
        """When documents are truncated, should fallback to RAG retrieval."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()

        with patch.object(
            RetrievalService,
            "_estimate_total_tokens_for_knowledge_bases",
            return_value=100,
        ):
            service = RetrievalService()
            service.get_original_documents_from_knowledge_base = AsyncMock(
                return_value=None  # Truncated documents
            )
            service.retrieve_from_knowledge_base_internal = AsyncMock(
                return_value={
                    "records": [
                        {
                            "content": "retrieved chunk",
                            "score": 0.9,
                            "title": "doc-1",
                            "metadata": {"page": 1},
                        }
                    ]
                }
            )

            result = await service.retrieve_with_routing(
                query="test",
                knowledge_base_ids=[123],
                db=db,
                context_window=10000,
                user_id=7,
            )

        assert result["mode"] == "rag_retrieval"
        assert len(result["records"]) == 1
        assert result["records"][0]["score"] == 0.9

    @pytest.mark.asyncio
    async def test_small_documents_use_extracted_text(self):
        """Documents under MAX_EXTRACTED_TEXT_LENGTH should use extracted_text."""
        from app.core.config import settings
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()
        mock_query = MagicMock()
        mock_query.select_from.return_value = mock_query
        mock_query.join.return_value = mock_query
        mock_query.filter.return_value = mock_query
        # Documents well under the limit (id, kind_id, text_length)
        max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
        mock_query.all.return_value = [
            (1, 123, 1000),
            (2, 123, 2000),
        ]  # Small documents
        db.query.return_value = mock_query

        mock_doc_read_service = MagicMock()
        mock_doc_read_service.read_documents.return_value = [
            {
                "id": 1,
                "name": "small-doc-1.md",
                "content": "Small document content.",
                "total_length": 23,
                "offset": 0,
                "returned_length": 23,
                "has_more": False,
                "kb_id": 123,
            },
            {
                "id": 2,
                "name": "small-doc-2.md",
                "content": "Another small document.",
                "total_length": 23,
                "offset": 0,
                "returned_length": 23,
                "has_more": False,
                "kb_id": 123,
            },
        ]

        with patch(
            "app.services.knowledge.document_read_service.document_read_service",
            mock_doc_read_service,
        ):
            service = RetrievalService()
            records = await service.get_original_documents_from_knowledge_base(
                knowledge_base_ids=[123],
                db=db,
            )

        assert records is not None
        assert len(records) == 2
        assert records[0]["content"] == "Small document content."

    @pytest.mark.asyncio
    async def test_forced_direct_injection_rejected_when_truncated(self):
        """Forced direct_injection should still be rejected if documents are truncated."""
        from app.services.rag.retrieval_service import RetrievalService

        db = MagicMock()

        service = RetrievalService()
        service.get_original_documents_from_knowledge_base = AsyncMock(
            return_value=None  # Truncated documents
        )
        service.retrieve_from_knowledge_base_internal = AsyncMock(
            return_value={
                "records": [
                    {
                        "content": "retrieved",
                        "score": 0.9,
                        "title": "doc-1",
                        "metadata": {},
                    }
                ]
            }
        )

        result = await service.retrieve_with_routing(
            query="test",
            knowledge_base_ids=[123],
            db=db,
            max_results=5,
            route_mode="direct_injection",  # Forced direct_injection
        )

        # Should still fallback to RAG
        assert result["mode"] == "rag_retrieval"
        service.retrieve_from_knowledge_base_internal.assert_awaited_once()
