# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KnowledgeOrchestrator service layer."""

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.schemas.knowledge import DocumentSourceType, KnowledgeDocumentCreate
from app.services.knowledge.indexing import get_rag_indexing_skip_reason
from app.services.knowledge.orchestrator import (
    KnowledgeOrchestrator,
    _build_filename,
    _normalize_file_extension,
)


class TestFileExtensionHelpers:
    """Tests for file extension helper functions."""

    def test_normalize_file_extension_with_dot(self):
        """Test normalizing extension with leading dot."""
        assert _normalize_file_extension(".txt") == "txt"
        assert _normalize_file_extension(".md") == "md"
        assert _normalize_file_extension("..pdf") == "pdf"

    def test_normalize_file_extension_without_dot(self):
        """Test normalizing extension without leading dot."""
        assert _normalize_file_extension("txt") == "txt"
        assert _normalize_file_extension("md") == "md"

    def test_normalize_file_extension_empty(self):
        """Test normalizing empty extension defaults to txt."""
        assert _normalize_file_extension("") == "txt"
        assert _normalize_file_extension(None) == "txt"
        assert _normalize_file_extension("   ") == "txt"

    def test_normalize_file_extension_invalid_raises(self):
        """Test normalizing invalid extension raises ValueError."""
        with pytest.raises(ValueError):
            _normalize_file_extension("../etc/passwd")
        with pytest.raises(ValueError):
            _normalize_file_extension("txt/subdir")
        with pytest.raises(ValueError):
            _normalize_file_extension("foo\\bar")

    def test_build_filename(self):
        """Test building filename from name and extension."""
        assert _build_filename("document", "txt") == "document.txt"
        assert _build_filename("my-file", ".md") == "my-file.md"


class TestKnowledgeOrchestrator:
    """Tests for KnowledgeOrchestrator class."""

    @pytest.fixture
    def orchestrator(self):
        """Create orchestrator instance."""
        return KnowledgeOrchestrator()

    @pytest.fixture
    def mock_db(self):
        """Create mock database session."""
        return MagicMock()

    @pytest.fixture
    def mock_user(self):
        """Create mock user."""
        user = MagicMock()
        user.id = 1
        user.user_name = "testuser"
        return user

    def test_get_default_retriever_returns_first(self, orchestrator, mock_db):
        """Test get_default_retriever returns first available retriever."""
        with patch(
            "app.services.adapters.retriever_kinds.retriever_kinds_service"
        ) as mock_service:
            mock_service.list_retrievers.return_value = [
                {"name": "retriever1", "namespace": "default", "type": "user"},
                {"name": "retriever2", "namespace": "default", "type": "public"},
            ]

            result = orchestrator.get_default_retriever(mock_db, user_id=1)

            assert result == {
                "retriever_name": "retriever1",
                "retriever_namespace": "default",
            }
            mock_service.list_retrievers.assert_called_once_with(
                db=mock_db,
                user_id=1,
                scope="personal",
                group_name=None,
            )

    def test_get_default_retriever_returns_none_when_empty(self, orchestrator, mock_db):
        """Test get_default_retriever returns None when no retrievers."""
        with patch(
            "app.services.adapters.retriever_kinds.retriever_kinds_service"
        ) as mock_service:
            mock_service.list_retrievers.return_value = []

            result = orchestrator.get_default_retriever(mock_db, user_id=1)

            assert result is None

    def test_get_default_retriever_group_scope(self, orchestrator, mock_db):
        """Test get_default_retriever with group namespace."""
        with patch(
            "app.services.adapters.retriever_kinds.retriever_kinds_service"
        ) as mock_service:
            mock_service.list_retrievers.return_value = [
                {"name": "group-retriever", "namespace": "my-team", "type": "group"},
            ]

            result = orchestrator.get_default_retriever(
                mock_db, user_id=1, namespace="my-team"
            )

            assert result == {
                "retriever_name": "group-retriever",
                "retriever_namespace": "my-team",
            }
            mock_service.list_retrievers.assert_called_once_with(
                db=mock_db,
                user_id=1,
                scope="group",
                group_name="my-team",
            )

    def test_get_default_embedding_model_returns_first(self, orchestrator, mock_db):
        """Test get_default_embedding_model returns first available model."""
        mock_user = MagicMock()
        mock_user.id = 1

        with patch.object(mock_db, "query") as mock_query:
            mock_query.return_value.filter.return_value.first.return_value = mock_user

            with patch(
                "app.services.model_aggregation_service.model_aggregation_service"
            ) as mock_service:
                mock_service.list_available_models.return_value = [
                    {"name": "embedding1", "namespace": "default", "type": "user"},
                    {"name": "embedding2", "namespace": "default", "type": "public"},
                ]

                result = orchestrator.get_default_embedding_model(mock_db, user_id=1)

                assert result == {
                    "model_name": "embedding1",
                    "model_namespace": "default",
                }

    def test_get_default_embedding_model_returns_none_when_user_not_found(
        self, orchestrator, mock_db
    ):
        """Test get_default_embedding_model returns None when user not found."""
        with patch.object(mock_db, "query") as mock_query:
            mock_query.return_value.filter.return_value.first.return_value = None

            result = orchestrator.get_default_embedding_model(mock_db, user_id=999)

            assert result is None

    def test_get_task_model_returns_none_when_task_not_found(
        self, orchestrator, mock_db
    ):
        """Test get_task_model_as_summary_model returns None when task not found."""
        with patch.object(mock_db, "query") as mock_query:
            mock_query.return_value.filter.return_value.first.return_value = None

            result = orchestrator.get_task_model_as_summary_model(
                mock_db, task_id=999, user_id=1
            )

            assert result is None

    def test_list_knowledge_bases_success(self, orchestrator, mock_db, mock_user):
        """Test list_knowledge_bases returns knowledge bases."""
        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_service:
            mock_kb = MagicMock()
            mock_kb.id = 1
            mock_service.list_knowledge_bases.return_value = [mock_kb]
            mock_service.get_document_count.return_value = 5

            with patch(
                "app.services.knowledge.orchestrator.KnowledgeBaseResponse"
            ) as mock_response:
                # Create a proper mock response that Pydantic can accept
                mock_kb_response = MagicMock()
                mock_kb_response.name = "test-kb"
                mock_response.from_kind.return_value = mock_kb_response

                with patch(
                    "app.services.knowledge.orchestrator.KnowledgeBaseListResponse"
                ) as mock_list_response:
                    # Return a mock that has the expected attributes
                    result_mock = MagicMock()
                    result_mock.total = 1
                    mock_list_response.return_value = result_mock

                    result = orchestrator.list_knowledge_bases(
                        mock_db, mock_user, scope="all"
                    )

                    assert result.total == 1
                    mock_service.list_knowledge_bases.assert_called_once()

    def test_list_documents_raises_when_kb_not_found(
        self, orchestrator, mock_db, mock_user
    ):
        """Test list_documents raises ValueError when KB not found."""
        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_service:
            mock_service.get_knowledge_base.return_value = (None, False)

            with pytest.raises(ValueError, match="Knowledge base not found"):
                orchestrator.list_documents(mock_db, mock_user, knowledge_base_id=999)

    def test_document_access_helper_and_reader_are_defined_once(self):
        """KnowledgeOrchestrator should not carry duplicate document-access methods."""
        source = inspect.getsource(KnowledgeOrchestrator)

        assert source.count("def _get_document_with_access_or_raise(") == 1
        assert source.count("def read_document_content(") == 1

    def test_read_document_content_returns_paginated_payload(
        self, orchestrator, mock_db, mock_user
    ):
        """Test read_document_content returns the paginated raw content payload."""
        document = SimpleNamespace(
            id=9, name="roadmap", kind_id=77, index_status="success"
        )
        mock_db.query.return_value.filter.return_value.first.return_value = document

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb_service.get_document.return_value = document
            mock_kb_service.get_knowledge_base.return_value = (MagicMock(id=77), True)

            with patch(
                "app.services.knowledge.orchestrator.document_read_service"
            ) as mock_read_service:
                mock_read_service.read_documents.return_value = [
                    {
                        "id": 9,
                        "name": "roadmap",
                        "content": "cdef",
                        "total_length": 10,
                        "offset": 2,
                        "returned_length": 4,
                        "has_more": True,
                        "kb_id": 77,
                    }
                ]

                result = orchestrator.read_document_content(
                    db=mock_db,
                    user=mock_user,
                    document_id=9,
                    offset=2,
                    limit=4,
                )

        assert result.document_id == 9
        assert result.name == "roadmap"
        assert result.content == "cdef"
        assert result.total_length == 10
        assert result.offset == 2
        assert result.returned_length == 4
        assert result.has_more is True
        assert result.kb_id == 77
        mock_kb_service.get_knowledge_base.assert_called_once_with(
            db=mock_db,
            knowledge_base_id=77,
            user_id=mock_user.id,
        )
        mock_read_service.read_documents.assert_called_once_with(
            db=mock_db,
            document_ids=[9],
            offset=2,
            limit=4,
            knowledge_base_ids=[77],
        )

    @pytest.mark.parametrize(
        ("offset", "limit", "message"),
        [
            (-1, 1, "offset must be greater than or equal to 0"),
            (0, 0, "limit must be greater than 0"),
            (0, 100001, "limit must be less than or equal to 100000"),
        ],
    )
    def test_read_document_content_rejects_invalid_paging_args(
        self, orchestrator, mock_db, mock_user, offset, limit, message
    ):
        """Test read_document_content validates offset and limit."""
        with pytest.raises(ValueError, match=message):
            orchestrator.read_document_content(
                db=mock_db,
                user=mock_user,
                document_id=9,
                offset=offset,
                limit=limit,
            )

        mock_db.query.assert_not_called()

    def test_read_document_content_raises_for_missing_document(
        self, orchestrator, mock_db, mock_user
    ):
        """Test read_document_content raises ValueError when document is missing."""
        mock_db.query.return_value.filter.return_value.first.return_value = None

        with pytest.raises(ValueError, match="Document not found"):
            orchestrator.read_document_content(
                db=mock_db,
                user=mock_user,
                document_id=9,
            )

    def test_read_document_content_uses_error_code_for_missing_document(
        self, orchestrator, mock_db, mock_user
    ):
        """Test read_document_content maps stable missing-document error codes."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)
        mock_db.query.return_value.filter.return_value.first.return_value = document

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb_service.get_knowledge_base.return_value = (MagicMock(id=77), True)

            with patch(
                "app.services.knowledge.orchestrator.document_read_service"
            ) as mock_read_service:
                mock_read_service.read_documents.return_value = [
                    {
                        "id": 9,
                        "error": "reader payload changed",
                        "error_code": "DOCUMENT_NOT_FOUND",
                    }
                ]

                with pytest.raises(ValueError, match="Document not found"):
                    orchestrator.read_document_content(
                        db=mock_db,
                        user=mock_user,
                        document_id=9,
                    )

    def test_read_document_content_raises_when_reader_returns_empty_results(
        self, orchestrator, mock_db, mock_user
    ):
        """Test read_document_content raises when the reader returns no rows."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)
        mock_db.query.return_value.filter.return_value.first.return_value = document

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb_service.get_knowledge_base.return_value = (MagicMock(id=77), True)

            with patch(
                "app.services.knowledge.orchestrator.document_read_service"
            ) as mock_read_service:
                mock_read_service.read_documents.return_value = []

                with pytest.raises(ValueError, match="Document not found"):
                    orchestrator.read_document_content(
                        db=mock_db,
                        user=mock_user,
                        document_id=9,
                    )

    def test_read_document_content_raises_reader_error(
        self, orchestrator, mock_db, mock_user
    ):
        """Test read_document_content surfaces reader access errors unchanged."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)
        mock_db.query.return_value.filter.return_value.first.return_value = document

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb_service.get_knowledge_base.return_value = (MagicMock(id=77), True)

            with patch(
                "app.services.knowledge.orchestrator.document_read_service"
            ) as mock_read_service:
                mock_read_service.read_documents.return_value = [
                    {
                        "id": 9,
                        "error": "Access denied: document not in allowed knowledge bases",
                    }
                ]

                with pytest.raises(
                    ValueError,
                    match="Access denied: document not in allowed knowledge bases",
                ):
                    orchestrator.read_document_content(
                        db=mock_db,
                        user=mock_user,
                        document_id=9,
                    )

    def test_read_document_content_raises_for_incomplete_reader_payload(
        self, orchestrator, mock_db, mock_user
    ):
        """Test read_document_content rejects incomplete reader payloads."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)
        mock_db.query.return_value.filter.return_value.first.return_value = document

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb_service.get_knowledge_base.return_value = (MagicMock(id=77), True)

            with patch(
                "app.services.knowledge.orchestrator.document_read_service"
            ) as mock_read_service:
                mock_read_service.read_documents.return_value = [
                    {
                        "id": 9,
                        "name": "roadmap",
                        "content": "cdef",
                        "offset": 2,
                        "kb_id": 77,
                    }
                ]

                with pytest.raises(
                    ValueError,
                    match="Incomplete document read payload: missing total_length, returned_length, has_more",
                ):
                    orchestrator.read_document_content(
                        db=mock_db,
                        user=mock_user,
                        document_id=9,
                    )

    @pytest.mark.asyncio
    async def test_get_document_detail_maps_content_length_and_truncated(
        self, orchestrator, mock_db, mock_user
    ):
        """Test get_document_detail maps paged content and async summary."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)
        paged = SimpleNamespace(
            document_id=9,
            name="roadmap",
            content="abcd",
            total_length=10,
            offset=0,
            returned_length=4,
            has_more=True,
            kb_id=77,
        )
        summary_service = MagicMock()
        summary_service.get_document_summary = AsyncMock(
            return_value={"summary": "hello"}
        )

        with patch.object(
            orchestrator,
            "_get_document_with_access_or_raise",
            return_value=document,
        ) as mock_get_document:
            with patch.object(
                orchestrator, "read_document_content", return_value=paged
            ) as mock_read_document_content:
                with patch(
                    "app.services.knowledge.summary_service.get_summary_service",
                    return_value=summary_service,
                ) as mock_get_summary_service:
                    result = await orchestrator.get_document_detail(
                        db=mock_db,
                        user=mock_user,
                        document_id=9,
                        include_content=True,
                        include_summary=True,
                    )

        assert result.document_id == 9
        assert result.content == "abcd"
        assert result.content_length == 10
        assert result.truncated is True
        assert result.summary == {"summary": "hello"}
        mock_get_document.assert_called_once_with(
            db=mock_db,
            user=mock_user,
            document_id=9,
        )
        mock_read_document_content.assert_called_once_with(
            db=mock_db,
            user=mock_user,
            document_id=9,
            offset=0,
            limit=100000,
        )
        mock_get_summary_service.assert_called_once_with(mock_db)
        summary_service.get_document_summary.assert_awaited_once_with(9)

    @pytest.mark.asyncio
    async def test_get_document_detail_skips_content_when_disabled(
        self, orchestrator, mock_db, mock_user
    ):
        """Test get_document_detail still validates access when payload sections are disabled."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)

        with patch.object(
            orchestrator,
            "_get_document_with_access_or_raise",
            return_value=document,
        ) as mock_get_document:
            with patch.object(
                orchestrator, "read_document_content"
            ) as mock_read_document_content:
                with patch(
                    "app.services.knowledge.summary_service.get_summary_service"
                ) as mock_get_summary_service:
                    result = await orchestrator.get_document_detail(
                        db=mock_db,
                        user=mock_user,
                        document_id=9,
                        include_content=False,
                        include_summary=False,
                    )

        assert result.document_id == 9
        assert result.content is None
        assert result.content_length is None
        assert result.truncated is None
        assert result.summary is None
        mock_get_document.assert_called_once_with(
            db=mock_db,
            user=mock_user,
            document_id=9,
        )
        mock_read_document_content.assert_not_called()
        mock_get_summary_service.assert_not_called()

    @pytest.mark.asyncio
    async def test_get_document_detail_summary_only_validates_access_before_fetching(
        self, orchestrator, mock_db, mock_user
    ):
        """Test summary-only detail requests still enforce document authorization."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)
        mock_db.query.return_value.filter.return_value.first.return_value = document

        summary_service = MagicMock()
        summary_service.get_document_summary = AsyncMock(
            return_value={"summary": "hello"}
        )

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb_service.get_knowledge_base.return_value = (MagicMock(id=77), False)

            with patch(
                "app.services.knowledge.summary_service.get_summary_service",
                return_value=summary_service,
            ):
                with pytest.raises(ValueError, match="Access denied to this document"):
                    await orchestrator.get_document_detail(
                        db=mock_db,
                        user=mock_user,
                        document_id=9,
                        include_content=False,
                        include_summary=True,
                    )

        summary_service.get_document_summary.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_get_document_detail_converts_summary_model_dump(
        self, orchestrator, mock_db, mock_user
    ):
        """Test get_document_detail normalizes summary objects via model_dump."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)
        mock_db.query.return_value.filter.return_value.first.return_value = document

        summary_result = Mock()
        summary_result.model_dump.return_value = {"summary": "hello"}

        summary_service = MagicMock()
        summary_service.get_document_summary = AsyncMock(return_value=summary_result)

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb_service.get_knowledge_base.return_value = (MagicMock(id=77), True)

            with patch(
                "app.services.knowledge.summary_service.get_summary_service",
                return_value=summary_service,
            ):
                result = await orchestrator.get_document_detail(
                    db=mock_db,
                    user=mock_user,
                    document_id=9,
                    include_content=False,
                    include_summary=True,
                )

        assert result.summary == {"summary": "hello"}
        summary_result.model_dump.assert_called_once_with()

    @pytest.mark.asyncio
    async def test_get_document_detail_marks_non_zero_offset_as_truncated(
        self, orchestrator, mock_db, mock_user
    ):
        """Test get_document_detail treats non-zero offsets as truncated content."""
        document = SimpleNamespace(id=9, name="roadmap", kind_id=77)
        paged = SimpleNamespace(
            document_id=9,
            name="roadmap",
            content="cd",
            total_length=10,
            offset=2,
            returned_length=2,
            has_more=False,
            kb_id=77,
        )

        with patch.object(
            orchestrator,
            "_get_document_with_access_or_raise",
            return_value=document,
        ) as mock_get_document:
            with patch.object(
                orchestrator, "read_document_content", return_value=paged
            ) as mock_read_document_content:
                result = await orchestrator.get_document_detail(
                    db=mock_db,
                    user=mock_user,
                    document_id=9,
                    include_content=True,
                    include_summary=False,
                    offset=2,
                    limit=2,
                )

        assert result.truncated is True
        mock_get_document.assert_called_once_with(
            db=mock_db,
            user=mock_user,
            document_id=9,
        )
        mock_read_document_content.assert_called_once_with(
            db=mock_db,
            user=mock_user,
            document_id=9,
            offset=2,
            limit=2,
        )

    def test_create_document_with_text_content(self, orchestrator, mock_db, mock_user):
        """Test create_document_with_content with text source type."""
        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb = MagicMock()
            mock_kb.id = 1
            mock_kb.json = {"spec": {}}
            mock_kb_service.get_knowledge_base.return_value = (mock_kb, True)

            mock_doc = MagicMock()
            mock_doc.id = 1
            mock_doc.name = "test"
            mock_kb_service.create_document.return_value = mock_doc

            with patch("app.services.context.context_service") as mock_context:
                mock_attachment = MagicMock()
                mock_attachment.id = 1
                mock_context.upload_attachment.return_value = (mock_attachment, None)

                with patch(
                    "app.services.knowledge.orchestrator.KnowledgeDocumentResponse"
                ) as mock_response:
                    mock_response.model_validate.return_value = MagicMock()

                    result = orchestrator.create_document_with_content(
                        db=mock_db,
                        user=mock_user,
                        knowledge_base_id=1,
                        name="test-doc",
                        source_type="text",
                        content="Hello world",
                        trigger_indexing=False,
                        trigger_summary=False,
                    )

                    mock_context.upload_attachment.assert_called_once()
                    mock_kb_service.create_document.assert_called_once()

    def test_create_document_with_file_base64(self, orchestrator, mock_db, mock_user):
        """Test create_document_with_content with file source type."""
        import base64

        content = base64.b64encode(b"file content").decode()

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb = MagicMock()
            mock_kb.id = 1
            mock_kb.json = {"spec": {}}
            mock_kb_service.get_knowledge_base.return_value = (mock_kb, True)

            mock_doc = MagicMock()
            mock_doc.id = 1
            mock_kb_service.create_document.return_value = mock_doc

            with patch("app.services.context.context_service") as mock_context:
                mock_attachment = MagicMock()
                mock_attachment.id = 1
                mock_context.upload_attachment.return_value = (mock_attachment, None)

                with patch(
                    "app.services.knowledge.orchestrator.KnowledgeDocumentResponse"
                ) as mock_response:
                    mock_response.model_validate.return_value = MagicMock()

                    result = orchestrator.create_document_with_content(
                        db=mock_db,
                        user=mock_user,
                        knowledge_base_id=1,
                        name="test-doc",
                        source_type="file",
                        file_base64=content,
                        file_extension="pdf",
                        trigger_indexing=False,
                        trigger_summary=False,
                    )

                    # Verify attachment was uploaded with decoded content
                    call_args = mock_context.upload_attachment.call_args
                    assert call_args[1]["binary_data"] == b"file content"

    def test_create_document_raises_for_missing_content(
        self, orchestrator, mock_db, mock_user
    ):
        """Test create_document raises ValueError when content missing for text."""
        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_service:
            mock_kb = MagicMock()
            mock_service.get_knowledge_base.return_value = (mock_kb, True)

            with pytest.raises(ValueError, match="content is required"):
                orchestrator.create_document_with_content(
                    db=mock_db,
                    user=mock_user,
                    knowledge_base_id=1,
                    name="test",
                    source_type="text",
                    content=None,
                )

    def test_create_document_raises_for_invalid_source_type(
        self, orchestrator, mock_db, mock_user
    ):
        """Test create_document raises ValueError for invalid source type."""
        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_service:
            mock_kb = MagicMock()
            mock_service.get_knowledge_base.return_value = (mock_kb, True)

            with pytest.raises(ValueError, match="Invalid source_type"):
                orchestrator.create_document_with_content(
                    db=mock_db,
                    user=mock_user,
                    knowledge_base_id=1,
                    name="test",
                    source_type="invalid",
                )

    def test_create_document_from_attachment_skips_large_excel_indexing(
        self, orchestrator, mock_db, mock_user
    ):
        """Test large Excel documents (>2MB) are created without scheduling RAG indexing."""
        mock_kb = MagicMock()
        mock_kb.id = 1
        mock_kb.json = {"spec": {}}

        mock_doc = MagicMock()
        mock_doc.id = 99
        mock_doc.attachment_id = 123

        # File size > 2MB (3MB)
        large_file_size = 3 * 1024 * 1024

        data = KnowledgeDocumentCreate(
            attachment_id=123,
            name="report.xlsx",
            file_extension="xlsx",
            file_size=large_file_size,
            source_type=DocumentSourceType.FILE,
        )

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_service:
            mock_service.get_knowledge_base.return_value = (mock_kb, True)
            mock_service.create_document.return_value = mock_doc

            with patch.object(
                orchestrator, "_schedule_indexing_celery"
            ) as mock_schedule:
                with patch(
                    "app.services.knowledge.orchestrator.KnowledgeDocumentResponse"
                ) as mock_response:
                    mock_response.model_validate.return_value = MagicMock()

                    orchestrator.create_document_from_attachment(
                        db=mock_db,
                        user=mock_user,
                        knowledge_base_id=1,
                        data=data,
                        trigger_indexing=True,
                        trigger_summary=False,
                    )

        mock_schedule.assert_not_called()

    def test_reindex_document_raises_for_large_excel_document(
        self, orchestrator, mock_db, mock_user
    ):
        """Test large Excel documents (>2MB) cannot be reindexed."""
        mock_document = MagicMock()
        mock_document.id = 1
        mock_document.source_type = DocumentSourceType.FILE.value
        mock_document.file_extension = "xlsx"
        mock_document.file_size = 3 * 1024 * 1024  # 3MB

        with patch.object(mock_db, "query") as mock_query:
            mock_query.return_value.filter.return_value.first.return_value = (
                mock_document
            )

            with pytest.raises(ValueError, match="EXCEL_FILE_SIZE_EXCEEDED"):
                orchestrator.reindex_document(
                    db=mock_db,
                    user=mock_user,
                    document_id=1,
                )

    def test_schedule_indexing_celery_skips_duplicate_enqueue(
        self, orchestrator, mock_db, mock_user
    ):
        """Test duplicate enqueue requests are skipped before hitting Celery."""
        mock_kb = MagicMock()
        mock_kb.id = 1
        mock_kb.namespace = "default"
        mock_kb.json = {
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-1",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "embedding-1",
                        "model_namespace": "default",
                    },
                }
            }
        }

        mock_document = MagicMock()
        mock_document.id = 10
        mock_document.attachment_id = 20

        with patch(
            "app.services.knowledge.index_state_machine.prepare_document_index_enqueue"
        ) as mock_prepare:
            mock_prepare.return_value = SimpleNamespace(
                should_enqueue=False,
                generation=3,
                reason="already_in_progress",
                previous_status="indexing",
            )
            with patch(
                "app.tasks.knowledge_tasks.index_document_task.delay"
            ) as mock_delay:
                result = orchestrator._schedule_indexing_celery(
                    db=mock_db,
                    knowledge_base=mock_kb,
                    document=mock_document,
                    user=mock_user,
                )

        mock_delay.assert_not_called()

        assert result["scheduled"] is False
        assert result["reason"] == "already_in_progress"

    def test_schedule_indexing_celery_enqueues_with_generation(
        self, orchestrator, mock_db, mock_user
    ):
        """Test a queued indexing task carries the new business generation."""
        mock_kb = MagicMock()
        mock_kb.id = 1
        mock_kb.namespace = "default"
        mock_kb.json = {
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-1",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "embedding-1",
                        "model_namespace": "default",
                    },
                }
            }
        }

        mock_document = MagicMock()
        mock_document.id = 10
        mock_document.attachment_id = 20

        with patch(
            "app.services.knowledge.index_state_machine.prepare_document_index_enqueue"
        ) as mock_prepare:
            mock_prepare.return_value = SimpleNamespace(
                should_enqueue=True,
                generation=7,
                reason="scheduled",
                previous_status="failed",
            )

            with patch(
                "app.tasks.knowledge_tasks.index_document_task.delay"
            ) as mock_delay:
                mock_delay.return_value = SimpleNamespace(id="celery-task-1")

                result = orchestrator._schedule_indexing_celery(
                    db=mock_db,
                    knowledge_base=mock_kb,
                    document=mock_document,
                    user=mock_user,
                )

        assert result["scheduled"] is True
        assert result["index_generation"] == 7
        mock_delay.assert_called_once()
        assert mock_delay.call_args.kwargs["index_generation"] == 7

    def test_schedule_indexing_celery_preserves_legacy_splitter_config(
        self, orchestrator, mock_db, mock_user
    ):
        """Test enqueueing keeps the raw legacy splitter config payload unchanged."""
        mock_kb = MagicMock()
        mock_kb.id = 1
        mock_kb.namespace = "default"
        mock_kb.json = {
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-1",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "embedding-1",
                        "model_namespace": "default",
                    },
                }
            }
        }

        mock_document = MagicMock()
        mock_document.id = 10
        mock_document.attachment_id = 20

        legacy_splitter_config = {"type": "smart", "chunk_size": 1536}

        with patch(
            "app.services.knowledge.index_state_machine.prepare_document_index_enqueue"
        ) as mock_prepare:
            mock_prepare.return_value = SimpleNamespace(
                should_enqueue=True,
                generation=7,
                reason="scheduled",
                previous_status="failed",
            )

            with patch(
                "app.tasks.knowledge_tasks.index_document_task.delay"
            ) as mock_delay:
                mock_delay.return_value = SimpleNamespace(id="celery-task-1")

                result = orchestrator._schedule_indexing_celery(
                    db=mock_db,
                    knowledge_base=mock_kb,
                    document=mock_document,
                    user=mock_user,
                    splitter_config=legacy_splitter_config,
                )

        assert result["scheduled"] is True
        assert (
            mock_delay.call_args.kwargs["splitter_config_dict"]
            == legacy_splitter_config
        )

    def test_schedule_indexing_celery_raises_when_generation_missing(
        self, orchestrator, mock_db, mock_user
    ):
        """Test enqueue decisions without generation fail explicitly."""
        mock_kb = MagicMock()
        mock_kb.id = 1
        mock_kb.namespace = "default"
        mock_kb.json = {
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-1",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "embedding-1",
                        "model_namespace": "default",
                    },
                }
            }
        }

        mock_document = MagicMock()
        mock_document.id = 10
        mock_document.attachment_id = 20

        with patch(
            "app.services.knowledge.index_state_machine.prepare_document_index_enqueue"
        ) as mock_prepare:
            mock_prepare.return_value = SimpleNamespace(
                should_enqueue=True,
                generation=None,
                reason="scheduled",
                previous_status="failed",
            )

            with pytest.raises(RuntimeError, match="generation is None"):
                orchestrator._schedule_indexing_celery(
                    db=mock_db,
                    knowledge_base=mock_kb,
                    document=mock_document,
                    user=mock_user,
                )

    def test_reindex_document_returns_reason_specific_skip_message(
        self, orchestrator, mock_db, mock_user
    ):
        """Test reindex returns a precise skip message for uncommon reasons."""
        mock_document = MagicMock()
        mock_document.id = 1
        mock_document.kind_id = 2
        mock_document.source_type = DocumentSourceType.FILE.value
        mock_document.file_extension = "txt"
        mock_document.file_size = 1024
        mock_document.splitter_config = {}

        mock_kb = MagicMock()

        with patch.object(mock_db, "query") as mock_query:
            mock_query.return_value.filter.return_value.first.return_value = (
                mock_document
            )
            with patch(
                "app.services.knowledge.orchestrator.KnowledgeService.get_knowledge_base",
                return_value=(mock_kb, True),
            ):
                with patch(
                    "app.services.knowledge.orchestrator.KnowledgeService.can_manage_knowledge_document",
                    return_value=True,
                ):
                    with patch(
                        "app.services.knowledge.indexing.extract_rag_config_from_knowledge_base",
                        return_value=MagicMock(),
                    ):
                        with patch.object(
                            orchestrator,
                            "_schedule_indexing_celery",
                            return_value={
                                "scheduled": False,
                                "reason": "document_not_found",
                                "index_generation": None,
                            },
                        ):
                            result = orchestrator.reindex_document(
                                db=mock_db,
                                user=mock_user,
                                document_id=1,
                            )

        assert result["skipped"] is True
        assert result["reason"] == "document_not_found"
        assert result["message"] == "Document not found"

    def test_reindex_document_allows_requeue_for_successful_documents(
        self, orchestrator, mock_db, mock_user
    ):
        """Test explicit reindex requests bypass the success-state skip rule."""
        mock_document = MagicMock()
        mock_document.id = 1
        mock_document.kind_id = 2
        mock_document.source_type = DocumentSourceType.FILE.value
        mock_document.file_extension = "txt"
        mock_document.file_size = 1024
        mock_document.splitter_config = {}

        mock_kb = MagicMock()

        with patch.object(mock_db, "query") as mock_query:
            mock_query.return_value.filter.return_value.first.return_value = (
                mock_document
            )
            with patch(
                "app.services.knowledge.orchestrator.KnowledgeService.get_knowledge_base",
                return_value=(mock_kb, True),
            ):
                with patch(
                    "app.services.knowledge.orchestrator.KnowledgeService.can_manage_knowledge_document",
                    return_value=True,
                ):
                    with patch(
                        "app.services.knowledge.indexing.extract_rag_config_from_knowledge_base",
                        return_value=MagicMock(),
                    ):
                        with patch.object(
                            orchestrator,
                            "_schedule_indexing_celery",
                            return_value={
                                "scheduled": True,
                                "reason": "scheduled",
                                "task_id": "task-1",
                                "index_generation": 8,
                            },
                        ) as mock_schedule:
                            result = orchestrator.reindex_document(
                                db=mock_db,
                                user=mock_user,
                                document_id=1,
                            )

        assert result["message"] == "Reindex started"
        assert result["index_generation"] == 8
        assert mock_schedule.call_args.kwargs["allow_if_success"] is True

    def test_reindex_document_preserves_raw_splitter_config_when_rescheduling(
        self, orchestrator, mock_db, mock_user
    ):
        """Test reindex scheduling keeps persisted legacy splitter config unchanged."""
        raw_splitter_config = {
            "type": "smart",
            "chunk_size": 1536,
        }
        mock_document = MagicMock()
        mock_document.id = 1
        mock_document.kind_id = 2
        mock_document.source_type = DocumentSourceType.FILE.value
        mock_document.file_extension = "md"
        mock_document.file_size = 1024
        mock_document.splitter_config = raw_splitter_config

        mock_kb = MagicMock()

        with patch.object(mock_db, "query") as mock_query:
            mock_query.return_value.filter.return_value.first.return_value = (
                mock_document
            )
            with patch(
                "app.services.knowledge.orchestrator.KnowledgeService.get_knowledge_base",
                return_value=(mock_kb, True),
            ):
                with patch(
                    "app.services.knowledge.orchestrator.KnowledgeService.can_manage_knowledge_document",
                    return_value=True,
                ):
                    with patch(
                        "app.services.knowledge.indexing.extract_rag_config_from_knowledge_base",
                        return_value=MagicMock(),
                    ):
                        with patch.object(
                            orchestrator,
                            "_schedule_indexing_celery",
                            return_value={
                                "scheduled": True,
                                "reason": "scheduled",
                                "task_id": "task-1",
                                "index_generation": 8,
                            },
                        ) as mock_schedule:
                            orchestrator.reindex_document(
                                db=mock_db,
                                user=mock_user,
                                document_id=1,
                            )

        assert mock_schedule.call_args.kwargs["splitter_config"] == raw_splitter_config


class TestIndexingPolicy:
    """Tests for knowledge indexing skip policy."""

    def test_excel_documents_within_size_limit_are_allowed(self):
        """Test Excel extensions within 2MB size limit are allowed for RAG indexing."""
        reason = get_rag_indexing_skip_reason("file", "xlsx")

        assert reason is None

    def test_table_documents_are_skipped(self):
        """Test table source types are excluded from RAG indexing."""
        reason = get_rag_indexing_skip_reason("table", "txt")

        assert (
            reason
            == "Table documents are queried in real-time and do not support RAG indexing"
        )
