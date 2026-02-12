# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KnowledgeOrchestrator service layer."""

import pytest
from unittest.mock import MagicMock, patch, Mock

from app.services.knowledge.orchestrator import (
    KnowledgeOrchestrator,
    _normalize_file_extension,
    _build_filename,
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

    def test_get_default_retriever_returns_first(
        self, orchestrator, mock_db
    ):
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

    def test_get_default_retriever_returns_none_when_empty(
        self, orchestrator, mock_db
    ):
        """Test get_default_retriever returns None when no retrievers."""
        with patch(
            "app.services.adapters.retriever_kinds.retriever_kinds_service"
        ) as mock_service:
            mock_service.list_retrievers.return_value = []

            result = orchestrator.get_default_retriever(mock_db, user_id=1)

            assert result is None

    def test_get_default_retriever_group_scope(
        self, orchestrator, mock_db
    ):
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

    def test_get_default_embedding_model_returns_first(
        self, orchestrator, mock_db
    ):
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

    def test_list_knowledge_bases_success(
        self, orchestrator, mock_db, mock_user
    ):
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
            mock_service.get_knowledge_base.return_value = None

            with pytest.raises(ValueError, match="Knowledge base not found"):
                orchestrator.list_documents(mock_db, mock_user, knowledge_base_id=999)

    def test_create_document_with_text_content(
        self, orchestrator, mock_db, mock_user
    ):
        """Test create_document_with_content with text source type."""
        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb = MagicMock()
            mock_kb.id = 1
            mock_kb.json = {"spec": {}}
            mock_kb_service.get_knowledge_base.return_value = mock_kb

            mock_doc = MagicMock()
            mock_doc.id = 1
            mock_doc.name = "test"
            mock_kb_service.create_document.return_value = mock_doc

            with patch(
                "app.services.context.context_service"
            ) as mock_context:
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

    def test_create_document_with_file_base64(
        self, orchestrator, mock_db, mock_user
    ):
        """Test create_document_with_content with file source type."""
        import base64

        content = base64.b64encode(b"file content").decode()

        with patch(
            "app.services.knowledge.orchestrator.KnowledgeService"
        ) as mock_kb_service:
            mock_kb = MagicMock()
            mock_kb.id = 1
            mock_kb.json = {"spec": {}}
            mock_kb_service.get_knowledge_base.return_value = mock_kb

            mock_doc = MagicMock()
            mock_doc.id = 1
            mock_kb_service.create_document.return_value = mock_doc

            with patch(
                "app.services.context.context_service"
            ) as mock_context:
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
            mock_service.get_knowledge_base.return_value = mock_kb

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
            mock_service.get_knowledge_base.return_value = mock_kb

            with pytest.raises(ValueError, match="Invalid source_type"):
                orchestrator.create_document_with_content(
                    db=mock_db,
                    user=mock_user,
                    knowledge_base_id=1,
                    name="test",
                    source_type="invalid",
                )
