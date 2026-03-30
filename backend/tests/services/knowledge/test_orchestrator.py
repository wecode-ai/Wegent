# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KnowledgeOrchestrator service layer."""

from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

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
