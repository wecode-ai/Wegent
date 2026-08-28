# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for ContextService - Simplified version.

Tests the core functionality of unified context management.
Uses mocks to avoid database dependencies.
"""

import importlib
from unittest.mock import Mock, patch

import pytest


class _FakeStorageBackend:
    backend_type = "mysql"

    def __init__(self):
        self.saved: list[tuple[str, bytes, dict]] = []

    def save(self, storage_key: str, binary_data: bytes, metadata: dict) -> str:
        self.saved.append((storage_key, binary_data, metadata))
        return storage_key


class TestSubtaskContextBrief:
    """Test context brief serialization."""

    def test_context_display_fields_include_external_web_video_fields(
        self,
    ) -> None:
        """Shared display fields expose external web video metadata."""
        from app.schemas.context_display import build_context_display_fields

        fields = build_context_display_fields(
            "attachment",
            {
                "source": "external_web_content",
                "file_extension": ".mp4",
                "file_size": 1024,
                "mime_type": "video/mp4",
                "external_source_url": "https://example.com/post/1",
                "site": "example",
                "cover_url": "https://cdn.example.com/cover.jpg",
            },
        )

        assert fields["file_extension"] == ".mp4"
        assert fields["mime_type"] == "video/mp4"
        assert fields["video_count"] == 1
        assert fields["site"] == "example"
        assert fields["source_url"] == "https://example.com/post/1"
        assert fields["cover_url"] == "https://cdn.example.com/cover.jpg"
        assert fields["external_media_type"] == "video"

    def test_context_display_fields_include_external_web_comment_fields(
        self,
    ) -> None:
        """Shared display fields expose external web comment metadata."""
        from app.schemas.context_display import build_context_display_fields

        fields = build_context_display_fields(
            "attachment",
            {
                "source": "external_web_content",
                "external_media_type": "comments",
                "file_extension": ".md",
                "file_size": 1024,
                "mime_type": "text/markdown",
                "external_source_url": "https://example.com/post/1",
                "site": "xiaohongshu",
                "comment_count": 14,
                "fetched_comment_count": 3,
            },
        )

        assert fields["external_media_type"] == "comments"
        assert fields["comment_count"] == 14
        assert fields["fetched_comment_count"] == 3
        assert fields["site"] == "xiaohongshu"
        assert fields["source_url"] == "https://example.com/post/1"

    def test_context_display_fields_include_external_web_text_fields(
        self,
    ) -> None:
        """Shared display fields expose external web page text metadata."""
        from app.schemas.context_display import build_context_display_fields

        fields = build_context_display_fields(
            "attachment",
            {
                "source": "external_web_content",
                "external_media_type": "text",
                "file_extension": ".md",
                "file_size": 1024,
                "mime_type": "text/markdown",
                "external_source_url": "https://example.com/post/1",
                "site": "example",
            },
        )

        assert fields["external_media_type"] == "text"
        assert fields["text_count"] == 1
        assert fields["site"] == "example"
        assert fields["source_url"] == "https://example.com/post/1"

    def test_context_display_fields_include_external_web_aggregate_fields(
        self,
    ) -> None:
        """External web aggregate contexts expose combined display metadata."""
        from app.schemas.context_display import build_context_display_fields

        fields = build_context_display_fields(
            "external_web_content",
            {
                "source": "external_web_content",
                "external_media_type": "mixed",
                "external_source_url": "https://example.com/post/1",
                "site": "xiaohongshu",
                "cover_url": "https://public.example.com/cover.jpg",
                "title": "Post title",
                "body": "Post body",
                "video_count": 1,
                "image_count": 2,
                "comment_count": 14,
                "fetched_comment_count": 3,
                "asset_context_ids": {
                    "videos": [10],
                    "comments": [13],
                },
                "raw_result": [{"id": "item-1"}],
            },
        )

        assert fields["external_media_type"] == "mixed"
        assert "text_count" not in fields
        assert fields["video_count"] == 1
        assert fields["image_count"] == 2
        assert fields["comment_count"] == 14
        assert fields["fetched_comment_count"] == 3
        assert fields["site"] == "xiaohongshu"
        assert fields["source_url"] == "https://example.com/post/1"
        assert fields["cover_url"] == "https://public.example.com/cover.jpg"

    def test_context_display_fields_tolerate_empty_selected_documents(self) -> None:
        """Selected document display does not fail on nullable legacy data."""
        from app.schemas.context_display import build_context_display_fields

        fields = build_context_display_fields(
            "selected_documents",
            {"document_ids": None},
        )

        assert fields == {"document_count": 0}

    def test_subtask_brief_includes_knowledge_base_domain_id(self) -> None:
        """Knowledge base context briefs expose the underlying knowledge ID."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.schemas.subtask import SubtaskContextBrief

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Product KB",
            status=ContextStatus.READY.value,
            type_data={"knowledge_id": 123, "document_count": 5},
        )
        context.id = 999

        brief = SubtaskContextBrief.from_model(context)

        assert brief.id == 999
        assert brief.knowledge_id == 123
        assert brief.document_count == 5

    def test_subtask_brief_preserves_scoped_knowledge_base_documents(self) -> None:
        """Knowledge base context briefs preserve scoped document selections."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.schemas.subtask import SubtaskContextBrief

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Scoped KB",
            status=ContextStatus.READY.value,
            type_data={
                "knowledge_id": 123,
                "document_count": 2,
                "document_ids": [10, 11],
                "scope_restricted": True,
            },
        )
        context.id = 1000

        brief = SubtaskContextBrief.from_model(context)

        assert brief.knowledge_id == 123
        assert brief.document_count == 2
        assert brief.document_ids == [10, 11]
        assert brief.scope_restricted is True

    def test_subtask_brief_includes_table_document_id(self) -> None:
        """Table context briefs expose the underlying document ID."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.schemas.subtask import SubtaskContextBrief

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.TABLE.value,
            name="Roadmap",
            status=ContextStatus.READY.value,
            type_data={"document_id": 456, "url": "https://example.com/table"},
        )
        context.id = 888

        brief = SubtaskContextBrief.from_model(context)

        assert brief.id == 888
        assert brief.document_id == 456
        assert brief.source_config == {"url": "https://example.com/table"}

    def test_subtask_brief_includes_external_web_video_fields(self) -> None:
        """External web video attachments expose display fields."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.schemas.subtask import SubtaskContextBrief

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="External video",
            status=ContextStatus.READY.value,
            type_data={
                "source": "external_web_content",
                "file_extension": ".mp4",
                "file_size": 1024,
                "mime_type": "video/mp4",
                "storage_backend": "weibo",
                "fid": 12345,
                "external_source_url": "https://example.com/post/1",
                "site": "example",
                "cover_url": "https://cdn.example.com/cover.jpg",
            },
        )
        context.id = 777

        brief = SubtaskContextBrief.from_model(context)

        assert brief.id == 777
        assert brief.context_type == ContextType.ATTACHMENT.value
        assert brief.file_extension == ".mp4"
        assert brief.mime_type == "video/mp4"
        assert brief.video_count == 1
        assert brief.site == "example"
        assert brief.source_url == "https://example.com/post/1"
        assert brief.cover_url == "https://cdn.example.com/cover.jpg"
        assert brief.external_media_type == "video"


class TestContextServiceAttachmentCopy:
    """Test trusted attachment copy operations."""

    def test_copy_attachment_for_user_creates_quick_launch_preset_copy(
        self, monkeypatch
    ) -> None:
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context_service_module = importlib.import_module(
            "app.services.context.context_service"
        )

        source = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="template.pdf",
            status=ContextStatus.READY.value,
            extracted_text="Template extracted text",
            text_length=23,
            image_base64="",
            type_data={
                "original_filename": "template.pdf",
                "file_extension": ".pdf",
                "file_size": 2048,
                "mime_type": "application/pdf",
                "storage_backend": "mysql",
                "storage_key": "attachments/source",
            },
        )
        source.id = 50
        storage = _FakeStorageBackend()
        added_contexts = []
        db = Mock()

        def add_context(context):
            added_contexts.append(context)

        def flush_context():
            if added_contexts and added_contexts[-1].id is None:
                added_contexts[-1].id = 501

        db.add.side_effect = add_context
        db.flush.side_effect = flush_context
        monkeypatch.setattr(
            context_service_module,
            "get_storage_backend",
            lambda _db: storage,
        )
        monkeypatch.setattr(
            context_service,
            "get_attachment_binary_data",
            lambda _db, _context: b"template-bytes",
        )

        copied = context_service.copy_attachment_for_user(
            db=db,
            source_context=source,
            target_user_id=7,
            source_metadata={
                "source": "quick_launch_preset",
                "quick_launch_function_id": "create_ppt",
                "quick_launch_preset_id": "roadmap",
            },
        )

        assert copied.id == 501
        assert copied.user_id == 7
        assert copied.subtask_id == 0
        assert copied.context_type == ContextType.ATTACHMENT.value
        assert copied.status == ContextStatus.READY.value
        assert copied.extracted_text == "Template extracted text"
        assert copied.text_length == 23
        assert copied.type_data["source"] == "quick_launch_preset"
        assert copied.type_data["source_attachment_id"] == 50
        assert copied.type_data["quick_launch_function_id"] == "create_ppt"
        assert copied.type_data["quick_launch_preset_id"] == "roadmap"
        assert copied.type_data["original_filename"] == "template.pdf"
        assert copied.type_data["storage_key"].endswith("_7_501")
        assert storage.saved[0][1] == b"template-bytes"
        db.commit.assert_called_once()
        db.refresh.assert_called_once_with(copied)

    def test_copy_attachment_for_user_copies_video_metadata_without_binary(
        self, monkeypatch
    ) -> None:
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context_service_module = importlib.import_module(
            "app.services.context.context_service"
        )
        source = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="demo.mp4",
            status=ContextStatus.READY.value,
            extracted_text="",
            text_length=0,
            image_base64="",
            type_data={
                "original_filename": "demo.mp4",
                "file_extension": ".mp4",
                "file_size": 4096,
                "mime_type": "video/mp4",
                "storage_backend": "weibo",
                "fid": 987654,
            },
        )
        source.id = 60
        added_contexts = []
        db = Mock()

        def add_context(context):
            added_contexts.append(context)

        def flush_context():
            if added_contexts and added_contexts[-1].id is None:
                added_contexts[-1].id = 601

        db.add.side_effect = add_context
        db.flush.side_effect = flush_context
        monkeypatch.setattr(
            context_service,
            "get_attachment_binary_data",
            lambda _db, _context: pytest.fail("video copy must not read binary data"),
        )
        monkeypatch.setattr(
            context_service_module,
            "find_external_attachment_storage_adapter",
            lambda _mime_type, _purpose: None,
        )

        copied = context_service.copy_attachment_for_user(
            db=db,
            source_context=source,
            target_user_id=7,
            source_metadata={
                "source": "quick_launch_preset",
                "quick_launch_function_id": "create_video",
                "quick_launch_preset_id": "demo",
            },
        )

        assert copied.id == 601
        assert copied.user_id == 7
        assert copied.subtask_id == 0
        assert copied.context_type == ContextType.ATTACHMENT.value
        assert copied.status == ContextStatus.READY.value
        assert copied.type_data["original_filename"] == "demo.mp4"
        assert copied.type_data["file_extension"] == ".mp4"
        assert copied.type_data["mime_type"] == "video/mp4"
        assert copied.type_data["storage_backend"] == "weibo"
        assert copied.type_data["fid"] == 987654
        assert copied.type_data["source"] == "quick_launch_preset"
        assert copied.type_data["source_attachment_id"] == 60
        assert copied.type_data["quick_launch_function_id"] == "create_video"
        assert copied.type_data["quick_launch_preset_id"] == "demo"
        assert copied.binary_data == b""
        db.commit.assert_called_once()
        db.refresh.assert_called_once_with(copied)

    def test_copy_attachment_for_user_promotes_legacy_video_reference(
        self, monkeypatch
    ) -> None:
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.attachment.external_storage import (
            ExternalAttachmentPlayback,
            ExternalAttachmentReference,
            ExternalAttachmentStorageResult,
        )
        from app.services.context import context_service

        context_service_module = importlib.import_module(
            "app.services.context.context_service"
        )
        source = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="demo.mp4",
            status=ContextStatus.READY.value,
            extracted_text="",
            text_length=0,
            image_base64="",
            type_data={
                "original_filename": "demo.mp4",
                "file_extension": ".mp4",
                "file_size": 4096,
                "mime_type": "video/mp4",
                "storage_backend": "weibo",
                "fid": 987654,
            },
        )
        source.id = 60
        added_contexts = []
        stored_inputs = []
        db = Mock()

        def add_context(context):
            added_contexts.append(context)

        def flush_context():
            if added_contexts and added_contexts[-1].id is None:
                added_contexts[-1].id = 601

        class _MediaStorage:
            backend_type = "weibo_video_hosting"

            def store(self, **kwargs):
                stored_inputs.append(kwargs)
                return ExternalAttachmentStorageResult(
                    backend_type=self.backend_type,
                    type_data={
                        "weibo_video_upload": {
                            "media_id": "media-123",
                            "upload_id": "upload-123",
                        }
                    },
                )

        def resolve_reference(*, type_data):
            upload = type_data.get("weibo_video_upload") or {}
            if upload.get("media_id"):
                return ExternalAttachmentReference(
                    name="media_id",
                    value=upload["media_id"],
                )
            return ExternalAttachmentReference(name="fid", value=type_data["fid"])

        db.add.side_effect = add_context
        db.flush.side_effect = flush_context
        monkeypatch.setattr(
            context_service_module,
            "find_external_attachment_storage_adapter",
            lambda _mime_type, _purpose: _MediaStorage(),
        )
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_reference",
            resolve_reference,
        )
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_playback",
            lambda **_kwargs: ExternalAttachmentPlayback(
                url="https://example.com/demo.mp4",
                media_type="video/mp4",
            ),
        )
        monkeypatch.setattr(
            context_service_module,
            "_download_external_media",
            lambda _url: b"video-bytes",
        )

        copied = context_service.copy_attachment_for_user(
            db=db,
            source_context=source,
            target_user_id=7,
            source_metadata={"source": "quick_launch_preset"},
        )

        assert stored_inputs[0]["data"] == b"video-bytes"
        assert stored_inputs[0]["filename"] == "demo.mp4"
        assert source.type_data["fid"] == 987654
        assert source.type_data["weibo_video_upload"]["media_id"] == "media-123"
        assert copied.type_data["fid"] == 987654
        assert copied.type_data["weibo_video_upload"]["media_id"] == "media-123"
        assert copied.type_data["storage_backend"] == "weibo_video_hosting"
        context_service._promote_legacy_video_reference(db, source)
        assert len(stored_inputs) == 1
        db.commit.assert_called_once()
        db.refresh.assert_called_once_with(copied)


class TestContextServiceKnowledgeBaseRetrieval:
    """Test knowledge base retrieval result functionality"""

    def test_update_knowledge_base_retrieval_result_rag_mode(self) -> None:
        """Test updating context with RAG retrieval results."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Test KB",
            status=ContextStatus.PENDING.value,
            type_data={"knowledge_id": 123, "document_count": 5},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        extracted_text = "Retrieved content from RAG"
        sources = [{"index": 1, "title": "doc1.pdf", "kb_id": 123, "score": 0.95}]

        # Act
        result = context_service.update_knowledge_base_retrieval_result(
            db=mock_db,
            context_id=1,
            extracted_text=extracted_text,
            sources=sources,
            injection_mode="rag_retrieval",
            query="test query",
            chunks_count=5,
        )

        # Assert
        assert result is not None
        assert result.extracted_text == extracted_text
        assert result.text_length == len(extracted_text)
        assert result.status == ContextStatus.READY.value
        # RAG result fields are now stored in rag_result sub-object
        assert result.type_data["rag_result"]["injection_mode"] == "rag_retrieval"
        assert result.type_data["rag_result"]["query"] == "test query"
        assert result.type_data["rag_result"]["chunks_count"] == 5
        assert result.type_data["rag_result"]["sources"] == sources
        assert result.type_data["rag_result"]["restricted_mode"] is False

    def test_update_knowledge_base_retrieval_result_restricted_mode_sets_flag(
        self,
    ) -> None:
        """Restricted KB retrieval should be marked for history suppression."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Test KB",
            status=ContextStatus.PENDING.value,
            type_data={"knowledge_id": 123},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        result = context_service.update_knowledge_base_retrieval_result(
            db=mock_db,
            context_id=1,
            extracted_text="",
            sources=[],
            injection_mode="rag_retrieval",
            query="diagnose",
            chunks_count=1,
            restricted_mode=True,
        )

        assert result is not None
        assert result.type_data["rag_result"]["restricted_mode"] is True

    def test_update_knowledge_base_retrieval_result_direct_injection_mode(self) -> None:
        """Test updating context with direct injection results - extracted_text should be empty."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Test KB",
            status=ContextStatus.PENDING.value,
            type_data={"knowledge_id": 123, "document_count": 5},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        sources = [{"index": 1, "title": "doc1.pdf", "kb_id": 123}]

        # Act
        result = context_service.update_knowledge_base_retrieval_result(
            db=mock_db,
            context_id=1,
            extracted_text="This should be ignored for direct injection",
            sources=sources,
            injection_mode="direct_injection",
            query="test query",
            chunks_count=10,
        )

        # Assert - extracted_text should be empty for direct injection
        assert result is not None
        assert result.extracted_text == ""
        assert result.text_length == 0
        assert result.status == ContextStatus.READY.value
        # RAG result fields are now stored in rag_result sub-object
        assert result.type_data["rag_result"]["injection_mode"] == "direct_injection"
        assert result.type_data["rag_result"]["query"] == "test query"
        assert result.type_data["rag_result"]["chunks_count"] == 10

    def test_update_knowledge_base_retrieval_result_empty_status(self) -> None:
        """Test updating context with no results sets EMPTY status."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Test KB",
            status=ContextStatus.PENDING.value,
            type_data={"knowledge_id": 123, "document_count": 5},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        # Act - chunks_count = 0 means no results
        result = context_service.update_knowledge_base_retrieval_result(
            db=mock_db,
            context_id=1,
            extracted_text="",
            sources=[],
            injection_mode="rag_retrieval",
            query="test query with no results",
            chunks_count=0,
        )

        # Assert - status should be EMPTY
        assert result is not None
        assert result.status == ContextStatus.EMPTY.value
        # RAG result fields are now stored in rag_result sub-object
        assert result.type_data["rag_result"]["chunks_count"] == 0

    def test_update_knowledge_base_retrieval_result_increments_retrieval_count(
        self,
    ) -> None:
        """Test that retrieval_count increments on multiple tool calls."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Test KB",
            status=ContextStatus.PENDING.value,
            type_data={"knowledge_id": 123, "document_count": 5},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        # Act - First call
        result = context_service.update_knowledge_base_retrieval_result(
            db=mock_db,
            context_id=1,
            extracted_text="First retrieval",
            sources=[{"index": 1, "title": "doc1.pdf", "kb_id": 123}],
            injection_mode="rag_retrieval",
            query="first query",
            chunks_count=5,
        )

        # Assert - First call should set retrieval_count to 1
        assert result is not None
        # RAG result fields are now stored in rag_result sub-object
        assert result.type_data["rag_result"]["retrieval_count"] == 1

        # Act - Second call (simulating another tool call)
        result2 = context_service.update_knowledge_base_retrieval_result(
            db=mock_db,
            context_id=1,
            extracted_text="Second retrieval",
            sources=[{"index": 1, "title": "doc2.pdf", "kb_id": 123}],
            injection_mode="rag_retrieval",
            query="second query",
            chunks_count=3,
        )

        # Assert - Second call should increment retrieval_count to 2
        assert result2 is not None
        # RAG result fields are now stored in rag_result sub-object
        assert result2.type_data["rag_result"]["retrieval_count"] == 2
        assert result2.type_data["rag_result"]["query"] == "second query"
        assert result2.type_data["rag_result"]["chunks_count"] == 3

    def test_update_knowledge_base_retrieval_result_not_found(self) -> None:
        """Test updating non-existent context returns None."""
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = None

        # Act
        result = context_service.update_knowledge_base_retrieval_result(
            db=mock_db,
            context_id=999,
            extracted_text="test",
            sources=[],
            injection_mode="rag_retrieval",
            query="test",
            chunks_count=0,
        )

        # Assert
        assert result is None

    def test_update_knowledge_base_retrieval_result_wrong_type(self) -> None:
        """Test updating non-knowledge_base context returns None."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,  # Not knowledge_base
            name="Test.pdf",
            status=ContextStatus.READY.value,
            type_data={},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        # Act
        result = context_service.update_knowledge_base_retrieval_result(
            db=mock_db,
            context_id=1,
            extracted_text="test",
            sources=[],
            injection_mode="rag_retrieval",
            query="test",
            chunks_count=5,
        )

        # Assert
        assert result is None


class TestSubtaskContextProperties:
    """Test SubtaskContext helper properties for RAG observability"""

    def test_injection_mode_property(self):
        """Test injection_mode property returns correct value."""
        from app.models.subtask_context import SubtaskContext

        # Test with injection_mode set
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={"injection_mode": "direct_injection"},
        )
        assert context.injection_mode == "direct_injection"

        # Test without injection_mode
        context2 = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={},
        )
        assert context2.injection_mode is None

    def test_query_property(self):
        """Test query property returns correct value."""
        from app.models.subtask_context import SubtaskContext

        # Test with query set
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={"query": "test search query"},
        )
        assert context.query == "test search query"

        # Test without query
        context2 = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={},
        )
        assert context2.query is None

    def test_chunks_count_property(self):
        """Test chunks_count property returns correct value."""
        from app.models.subtask_context import SubtaskContext

        # Test with chunks_count set
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={"chunks_count": 15},
        )
        assert context.chunks_count == 15

        # Test without chunks_count (default 0)
        context2 = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={},
        )
        assert context2.chunks_count == 0

    def test_retrieval_count_property(self):
        """Test retrieval_count property returns correct value."""
        from app.models.subtask_context import SubtaskContext

        # Test with retrieval_count set
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={"retrieval_count": 3},
        )
        assert context.retrieval_count == 3

        # Test without retrieval_count (default 0)
        context2 = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={},
        )
        assert context2.retrieval_count == 0

    def test_kb_head_count_property(self) -> None:
        """Test kb_head_count property returns correct value."""
        from app.models.subtask_context import SubtaskContext

        # Test with kb_head_count set
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={"kb_head_count": 5},
        )
        assert context.kb_head_count == 5

        # Test without kb_head_count (default 0)
        context2 = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={},
        )
        assert context2.kb_head_count == 0

    def test_kb_head_document_ids_property(self) -> None:
        """Test kb_head_document_ids property returns correct value."""
        from app.models.subtask_context import SubtaskContext

        # Test with kb_head_result sub-object (new structure)
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={"kb_head_result": {"document_ids": [10, 20, 30]}},
        )
        assert context.kb_head_document_ids == [10, 20, 30]

        # Test with legacy flat field (backward compatibility)
        context2 = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={"kb_head_document_ids": [40, 50]},
        )
        assert context2.kb_head_document_ids == [40, 50]

        # Test without kb_head data (default empty list)
        context3 = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type="knowledge_base",
            name="Test",
            type_data={},
        )
        assert context3.kb_head_document_ids == []


class TestKbHeadPersistence:
    """Test kb_head persistence functionality"""

    def test_update_kb_head_result_basic(self) -> None:
        """Test basic kb_head result persistence."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Test KB",
            status=ContextStatus.PENDING.value,
            type_data={"knowledge_id": 123, "document_count": 5},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        # Act
        result = context_service.update_knowledge_base_kb_head_result(
            db=mock_db,
            context_id=1,
            document_ids=[10, 20, 30],
            offset=0,
            limit=50000,
        )

        # Assert
        assert result is not None
        # Check kb_head_result sub-object
        kb_head_result = result.type_data.get("kb_head_result", {})
        assert kb_head_result.get("usage_count") == 1
        assert set(kb_head_result.get("document_ids", [])) == {10, 20, 30}
        assert kb_head_result.get("offset") == 0
        assert kb_head_result.get("limit") == 50000
        # Status should be updated to READY when previously PENDING
        assert result.status == ContextStatus.READY.value
        # Original knowledge_id should be preserved
        assert result.type_data["knowledge_id"] == 123

    def test_update_kb_head_result_increments_count(self) -> None:
        """Test kb_head usage_count increments on multiple calls."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Test KB",
            status=ContextStatus.PENDING.value,
            type_data={"knowledge_id": 123, "document_count": 5},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        # Act - First call
        result1 = context_service.update_knowledge_base_kb_head_result(
            db=mock_db,
            context_id=1,
            document_ids=[10],
            offset=0,
            limit=50000,
        )

        # Assert - First call
        kb_head_result1 = result1.type_data.get("kb_head_result", {})
        assert kb_head_result1.get("usage_count") == 1

        # Act - Second call
        result2 = context_service.update_knowledge_base_kb_head_result(
            db=mock_db,
            context_id=1,
            document_ids=[20, 30],
            offset=0,
            limit=50000,
        )

        # Assert - Second call should accumulate document_ids and increment count
        kb_head_result2 = result2.type_data.get("kb_head_result", {})
        assert kb_head_result2.get("usage_count") == 2
        assert set(kb_head_result2.get("document_ids", [])) == {10, 20, 30}

    def test_update_kb_head_result_preserves_rag_data(self) -> None:
        """Test kb_head update preserves existing RAG retrieval data."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange - context with existing RAG data in rag_result sub-object
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="Test KB",
            status=ContextStatus.READY.value,  # Already READY from RAG
            type_data={
                "knowledge_id": 123,
                "document_count": 5,
                "rag_result": {
                    "injection_mode": "rag_retrieval",
                    "query": "test query",
                    "chunks_count": 10,
                    "retrieval_count": 1,
                    "sources": [{"title": "doc1.pdf"}],
                },
                # Also keep flat fields for backward compatibility
                "injection_mode": "rag_retrieval",
                "query": "test query",
                "chunks_count": 10,
                "retrieval_count": 1,
                "sources": [{"title": "doc1.pdf"}],
            },
        )
        context.id = 1
        context.extracted_text = "RAG retrieved content"

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        # Act
        result = context_service.update_knowledge_base_kb_head_result(
            db=mock_db,
            context_id=1,
            document_ids=[10, 20],
            offset=100,
            limit=10000,
        )

        # Assert - kb_head data added, RAG data preserved
        assert result is not None
        kb_head_result = result.type_data.get("kb_head_result", {})
        assert kb_head_result.get("usage_count") == 1
        assert kb_head_result.get("offset") == 100
        assert kb_head_result.get("limit") == 10000
        # RAG data should be preserved in rag_result sub-object
        rag_result = result.type_data.get("rag_result", {})
        assert rag_result.get("injection_mode") == "rag_retrieval"
        assert rag_result.get("query") == "test query"
        assert rag_result.get("chunks_count") == 10
        # Status should NOT change (already READY)
        assert result.status == ContextStatus.READY.value

    def test_update_kb_head_result_not_found(self) -> None:
        """Test kb_head update returns None for non-existent context."""
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = None

        # Act
        result = context_service.update_knowledge_base_kb_head_result(
            db=mock_db,
            context_id=999,
            document_ids=[10],
            offset=0,
            limit=50000,
        )

        # Assert
        assert result is None

    def test_update_kb_head_result_wrong_type(self) -> None:
        """Test kb_head update returns None for non-knowledge_base context."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange - attachment context, not knowledge_base
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="Test.pdf",
            status=ContextStatus.READY.value,
            type_data={},
        )
        context.id = 1

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        # Act
        result = context_service.update_knowledge_base_kb_head_result(
            db=mock_db,
            context_id=1,
            document_ids=[10],
            offset=0,
            limit=50000,
        )

        # Assert
        assert result is None


class TestContextStatusEnum:
    """Test ContextStatus enum values"""

    def test_context_status_empty_exists(self):
        """Test EMPTY status exists in ContextStatus enum."""
        from app.models.subtask_context import ContextStatus

        assert hasattr(ContextStatus, "EMPTY")
        assert ContextStatus.EMPTY.value == "empty"

    def test_context_status_all_values(self):
        """Test all expected ContextStatus values exist."""
        from app.models.subtask_context import ContextStatus

        expected = ["pending", "uploading", "parsing", "ready", "failed", "empty"]
        actual = [status.value for status in ContextStatus]
        for val in expected:
            assert val in actual


class TestContextServiceUpload:
    """Test attachment upload functionality"""

    def test_upload_unsupported_file_type(self):
        """Test upload fails for binary files with unknown extensions via MIME detection"""
        from app.services.attachment.parser import DocumentParseError, DocumentParser

        # Arrange
        parser = DocumentParser()
        filename = "test.bin"
        # Use a minimal valid GIF image that libmagic reliably detects as binary
        # across all platforms (including macOS where PNG header + null bytes
        # may be misdetected as text/plain)
        gif_data = (
            b"GIF87a"
            b"\x01\x00\x01\x00"
            b"\x80\x00\x00"
            b"\xff\xff\xff\x00\x00\x00"
            b",\x00\x00\x00\x00\x01\x00\x01\x00\x00"
            b"\x02\x02\x44\x01\x00"
            b"\x3b"
        )

        # Act & Assert
        # The parser now allows unknown extensions but uses MIME detection to validate
        # Binary files without matching parsers will raise DocumentParseError
        with pytest.raises(DocumentParseError) as exc_info:
            parser.parse(gif_data, ".bin")
        assert exc_info.value.error_code == DocumentParseError.UNRECOGNIZED_TYPE

    def test_upload_file_too_large(self):
        """Test upload fails when file exceeds size limit"""
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        user_id = 1
        filename = "large.pdf"
        binary_data = b"x" * (101 * 1024 * 1024)  # 101 MB

        # Act & Assert
        with pytest.raises(ValueError, match="File size exceeds maximum limit"):
            context_service.upload_attachment(
                db=mock_db, user_id=user_id, filename=filename, binary_data=binary_data
            )


class TestContextServiceStorage:
    """Test storage backend operations"""

    def test_get_binary_data_from_mysql(self):
        """Test retrieving binary data from MySQL storage"""
        import sys

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context.context_service import context_service as cs_instance

        # Get the actual module (not the singleton instance) for patching
        cs_module = sys.modules["app.services.context.context_service"]

        # Arrange
        mock_db = Mock()
        storage_key = "attachments/test123_20250113_1_100"
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.pdf",
            status=ContextStatus.READY.value,
            binary_data=b"stored data",
            type_data={
                "storage_backend": "mysql",
                "storage_key": storage_key,
                "is_encrypted": False,
            },
        )
        context.id = 100

        # Mock the storage backend to return the binary data
        # Use patch.object with the module to avoid name conflicts
        with patch.object(cs_module, "get_storage_backend") as mock_get_backend:
            mock_backend = Mock()
            mock_backend.get.return_value = b"stored data"
            mock_get_backend.return_value = mock_backend

            # Act
            binary_data = cs_instance.get_attachment_binary_data(mock_db, context)

        # Assert
        assert binary_data == b"stored data"
        mock_backend.get.assert_called_once_with(storage_key)

    def test_get_binary_data_with_encryption(self):
        """Test retrieving and decrypting encrypted binary data"""
        import sys

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context.context_service import context_service as cs_instance
        from shared.utils.crypto import encrypt_attachment

        # Get the actual module (not the singleton instance) for patching
        cs_module = sys.modules["app.services.context.context_service"]

        # Arrange
        mock_db = Mock()
        storage_key = "attachments/test123_20250113_1_100"
        original_data = b"original attachment data"
        encrypted_data = encrypt_attachment(original_data)

        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.pdf",
            status=ContextStatus.READY.value,
            binary_data=encrypted_data,
            type_data={
                "storage_backend": "mysql",
                "storage_key": storage_key,
                "is_encrypted": True,
            },
        )
        context.id = 100

        # Mock the storage backend to return encrypted data
        # Use patch.object with the module to avoid name conflicts
        with patch.object(cs_module, "get_storage_backend") as mock_get_backend:
            mock_backend = Mock()
            mock_backend.get.return_value = encrypted_data
            mock_get_backend.return_value = mock_backend

            # Act
            binary_data = cs_instance.get_attachment_binary_data(mock_db, context)

        # Assert - should return decrypted data
        assert binary_data == original_data
        assert binary_data != encrypted_data

    def test_get_binary_data_returns_none_without_storage_key(self):
        """Test that get_binary_data returns None when storage_key is missing"""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.pdf",
            status=ContextStatus.READY.value,
            binary_data=b"stored data",
            type_data={"storage_backend": "mysql", "storage_key": ""},
        )

        # Act
        binary_data = context_service.get_attachment_binary_data(mock_db, context)

        # Assert
        assert binary_data is None


class TestContextServiceVision:
    """Test vision-related functionality"""

    def test_is_image_context_for_png(self):
        """Test image detection for PNG files"""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.png",
            status=ContextStatus.READY.value,
            type_data={"file_extension": ".png"},
        )

        # Act & Assert
        assert context_service.is_image_context(context) is True

    def test_is_image_context_for_pdf(self):
        """Test image detection returns False for PDF"""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.pdf",
            status=ContextStatus.READY.value,
            type_data={"file_extension": ".pdf"},
        )

        # Act & Assert
        assert context_service.is_image_context(context) is False

    def test_build_vision_content_block(self):
        """Test building OpenAI vision content block"""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.jpg",
            status=ContextStatus.READY.value,
            image_base64="base64imagedata",
            type_data={"file_extension": ".jpg", "mime_type": "image/jpeg"},
        )

        # Act
        content_block = context_service.build_vision_content_block(context)

        # Assert
        assert content_block is not None
        assert content_block["type"] == "image_url"
        assert (
            "data:image/jpeg;base64,base64imagedata"
            in content_block["image_url"]["url"]
        )


class TestContextServiceFormatting:
    """Test message formatting functionality"""

    def test_format_file_size_bytes(self):
        """Test file size formatting for bytes"""
        from app.services.context import context_service

        assert context_service.format_file_size(512) == "512 bytes"
        assert context_service.format_file_size(0) == "0 bytes"
        assert context_service.format_file_size(1023) == "1023 bytes"

    def test_format_file_size_kb(self):
        """Test file size formatting for KB"""
        from app.services.context import context_service

        assert context_service.format_file_size(1024) == "1.0 KB"
        assert context_service.format_file_size(1536) == "1.5 KB"
        # 160000 / 1024 = 156.25, rounds to 156.2
        assert context_service.format_file_size(160000) == "156.2 KB"

    def test_format_file_size_mb(self):
        """Test file size formatting for MB"""
        from app.services.context import context_service

        assert context_service.format_file_size(1024 * 1024) == "1.0 MB"
        assert context_service.format_file_size(2621440) == "2.5 MB"
        assert context_service.format_file_size(10 * 1024 * 1024) == "10.0 MB"

    def test_build_attachment_url(self):
        """Test attachment URL generation"""
        from app.services.context import context_service

        assert (
            context_service.build_attachment_url(12345)
            == "/api/attachments/12345/download"
        )
        assert context_service.build_attachment_url(1) == "/api/attachments/1/download"

    def test_build_sandbox_path(self):
        """Test sandbox path generation"""
        from app.services.context import context_service

        # Test with valid task_id and subtask_id
        path = context_service.build_sandbox_path(123, 456, "test.pdf")
        assert path == "/home/user/123:executor:attachments/456/test.pdf"

        # Test with different values
        path = context_service.build_sandbox_path(1, 2, "image.png")
        assert path == "/home/user/1:executor:attachments/2/image.png"

    def test_build_sandbox_path_returns_none_for_missing_ids(self):
        """Test sandbox path returns None when task_id or subtask_id is missing"""
        from app.services.context import context_service

        # Test with None task_id
        assert context_service.build_sandbox_path(None, 456, "test.pdf") is None

        # Test with None subtask_id
        assert context_service.build_sandbox_path(123, None, "test.pdf") is None

        # Test with both None
        assert context_service.build_sandbox_path(None, None, "test.pdf") is None

    def test_build_sandbox_path_strips_control_characters(self):
        """Test sandbox path strips control characters from filename"""
        from app.services.context import context_service

        # Test filename with newline
        path = context_service.build_sandbox_path(123, 456, "test\n.pdf")
        assert path == "/home/user/123:executor:attachments/456/test.pdf"

        # Test filename with carriage return
        path = context_service.build_sandbox_path(123, 456, "test\r.pdf")
        assert path == "/home/user/123:executor:attachments/456/test.pdf"

        # Test filename with both
        path = context_service.build_sandbox_path(123, 456, "test\r\n.pdf")
        assert path == "/home/user/123:executor:attachments/456/test.pdf"

    def test_build_document_text_prefix_with_sandbox_path(self):
        """Test building document text prefix with sandbox path included"""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.pdf",
            status=ContextStatus.READY.value,
            extracted_text="This is the extracted PDF content.",
            text_length=35,
            type_data={
                "file_extension": ".pdf",
                "original_filename": "test.pdf",
                "mime_type": "application/pdf",
                "file_size": 2621440,  # 2.5 MB
            },
        )
        context.id = 12345

        # Act - with task_id and subtask_id
        prefix = context_service.build_document_text_prefix(
            context, task_id=100, subtask_id=200
        )

        # Assert
        assert prefix is not None
        assert "[Attachment: test.pdf |" in prefix
        assert "ID: 12345" in prefix
        assert "Type: application/pdf" in prefix
        assert "Size: 2.5 MB" in prefix
        assert "URL: /api/attachments/12345/download" in prefix
        assert (
            "File Path(already in sandbox): /home/user/100:executor:attachments/200/test.pdf"
            in prefix
        )
        assert "This is the extracted PDF content." in prefix

    def test_build_document_text_prefix(self):
        """Test building document text prefix with attachment metadata"""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.pdf",
            status=ContextStatus.READY.value,
            extracted_text="This is the extracted PDF content.",
            text_length=35,
            type_data={
                "original_filename": "test.pdf",
                "mime_type": "application/pdf",
                "file_size": 2621440,  # 2.5 MB
            },
        )
        context.id = 12345

        # Act
        prefix = context_service.build_document_text_prefix(context)

        # Assert
        assert prefix is not None
        assert "[Attachment: test.pdf |" in prefix
        assert "ID: 12345" in prefix
        assert "Type: application/pdf" in prefix
        assert "Size: 2.5 MB" in prefix
        assert "URL: /api/attachments/12345/download" in prefix
        assert "This is the extracted PDF content." in prefix

    def test_build_document_text_prefix_without_sandbox_path(self):
        """Device tasks should omit sandbox path metadata from attachment prefix."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="test.pdf",
            status=ContextStatus.READY.value,
            extracted_text="This is the extracted PDF content.",
            text_length=35,
            type_data={
                "original_filename": "test.pdf",
                "mime_type": "application/pdf",
                "file_size": 2621440,
            },
        )
        context.id = 12345

        prefix = context_service.build_document_text_prefix(
            context,
            task_id=100,
            subtask_id=200,
        )

        assert prefix is not None
        assert "URL: /api/attachments/12345/download" in prefix
        assert "File Path(already in sandbox)" in prefix

    def test_build_document_text_prefix_with_truncation(self):
        """Truncated attachments get a length-free partial-content notice.

        The notice is driven by the persisted ``is_truncated`` flag (not a
        length-vs-cap comparison) and intentionally omits any character count,
        so it never restates the old "(truncated to N characters)" wording.
        """
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        # Arrange - parse-time truncation recorded in type_data
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="large.pdf",
            status=ContextStatus.READY.value,
            extracted_text="Content...",
            text_length=10,
            type_data={
                "original_filename": "large.pdf",
                "mime_type": "application/pdf",
                "file_size": 5242880,  # 5 MB
                "is_truncated": True,
            },
        )
        context.id = 100

        # Act
        prefix = context_service.build_document_text_prefix(context)

        # Assert
        assert prefix is not None
        assert "[Attachment: large.pdf |" in prefix
        assert "ID: 100" in prefix
        # Partial-content notice present, but no character count.
        assert "only partial content is shown" in prefix
        assert "has been truncated to" not in prefix
        assert "characters" not in prefix

    def test_build_document_text_prefix_bounds_injected_text(self):
        """Long extracted text is bounded inline; full text stays in the DB."""
        from app.core.config import settings
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        long_text = "x" * (settings.ATTACHMENT_INJECT_MAX_CHARS + 50_000)
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="huge.txt",
            status=ContextStatus.READY.value,
            extracted_text=long_text,
            text_length=len(long_text),
            type_data={
                "original_filename": "huge.txt",
                "mime_type": "text/plain",
                "file_size": len(long_text),
                # Parse also truncated this file: the merged logic must still emit
                # only the inline marker, not an additional prefix note.
                "is_truncated": True,
            },
        )
        context.id = 102

        prefix = context_service.build_document_text_prefix(context)

        assert prefix is not None
        # Inline copy is bounded well below the stored text length.
        assert len(prefix) < len(long_text)
        assert "inline preview truncated" in prefix
        # Mode-neutral marker: no chat_shell-only read_attachment mention.
        assert "read_attachment" not in prefix
        # Merged signal: the inline marker is the only notice — no separate
        # "(parsing truncated ...)" prefix note is duplicated.
        assert "parsing truncated this file" not in prefix

    def test_build_document_text_prefix_without_truncation_has_no_notice(self):
        """Non-truncated attachments get no partial-content notice."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="small.pdf",
            status=ContextStatus.READY.value,
            extracted_text="Full content.",
            text_length=13,
            type_data={
                "original_filename": "small.pdf",
                "mime_type": "application/pdf",
                "file_size": 1024,
            },
        )
        context.id = 101

        prefix = context_service.build_document_text_prefix(context)

        assert prefix is not None
        assert "only partial content is shown" not in prefix
        assert "Full content." in prefix

    def test_large_spreadsheet_metadata_prefix_omits_extracted_text(self):
        """Local executors should receive spreadsheet metadata without parsed text."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.chat.preprocessing.contexts import (
            _build_attachment_metadata_only_prefix,
            _should_skip_attachment_text,
        )

        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="sales.xlsx",
            status=ContextStatus.READY.value,
            extracted_text="truncated spreadsheet rows should not be injected",
            text_length=42,
            type_data={
                "file_extension": ".xlsx",
                "original_filename": "sales.xlsx",
                "mime_type": (
                    "application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet"
                ),
                "file_size": 1024,
            },
        )
        context.id = 321

        assert _should_skip_attachment_text(context) is True
        prefix = _build_attachment_metadata_only_prefix(
            context,
            task_id=100,
            subtask_id=200,
        )

        assert "sales.xlsx" in prefix
        assert "ID: 321" in prefix
        assert "File Path(already in sandbox):" in prefix
        assert "precise spreadsheet or full-file analysis" in prefix
        assert "truncated spreadsheet rows should not be injected" not in prefix
        # Spreadsheets should NOT include a text_preview section
        assert "<text_preview>" not in prefix

    def test_large_non_spreadsheet_metadata_prefix_includes_preview(self):
        """Non-spreadsheet large files should include a text preview snippet."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.chat.preprocessing.contexts import (
            _build_attachment_metadata_only_prefix,
            _should_skip_attachment_text,
        )

        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="annual-report.pdf",
            status=ContextStatus.READY.value,
            extracted_text="A" * 1000,  # Long extracted text
            text_length=1000,
            type_data={
                "file_extension": ".pdf",
                "original_filename": "annual-report.pdf",
                "mime_type": "application/pdf",
                "file_size": 2048000,
            },
        )
        context.id = 555

        assert _should_skip_attachment_text(context) is False  # PDF, not spreadsheet
        # But metadata-only prefix should still work and include preview
        prefix = _build_attachment_metadata_only_prefix(
            context,
            task_id=100,
            subtask_id=200,
        )

        assert "annual-report.pdf" in prefix
        assert "ID: 555" in prefix
        assert "<text_preview>" in prefix
        assert "truncated" in prefix.lower()
        # Preview should be limited, not the full 1000 chars
        assert "A" * 600 not in prefix

    def test_spreadsheet_metadata_prefix_has_no_preview(self):
        """Spreadsheets should never include parsed text preview."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.chat.preprocessing.contexts import (
            _build_attachment_metadata_only_prefix,
        )

        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="data.csv",
            status=ContextStatus.READY.value,
            extracted_text="col1,col2\n1,2\n3,4",
            text_length=20,
            type_data={
                "file_extension": ".csv",
                "original_filename": "data.csv",
                "mime_type": "text/csv",
                "file_size": 512,
            },
        )
        context.id = 666

        prefix = _build_attachment_metadata_only_prefix(
            context,
            task_id=100,
            subtask_id=200,
        )

        assert "<text_preview>" not in prefix
        assert "col1,col2" not in prefix

    @pytest.mark.asyncio
    async def test_process_contexts_can_use_metadata_only_for_spreadsheets(self):
        """Compatibility context processing should support metadata-only mode."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.chat.preprocessing.contexts import process_contexts

        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="sales.xlsx",
            status=ContextStatus.READY.value,
            extracted_text="spreadsheet rows should not be injected",
            text_length=42,
            type_data={
                "file_extension": ".xlsx",
                "original_filename": "sales.xlsx",
                "mime_type": (
                    "application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet"
                ),
                "file_size": 1024,
            },
        )
        context.id = 321

        with patch(
            "app.services.chat.preprocessing.contexts."
            "context_service.get_context_optional",
            return_value=context,
        ):
            result = await process_contexts(
                Mock(),
                [321],
                "Summarize the file",
                metadata_only_for_large_documents=True,
            )

        assert isinstance(result, list)
        attachment_text = result[0]["text"]
        user_text = result[1]["text"]
        assert "sales.xlsx" in attachment_text
        assert "Source file is available for local tool analysis" in attachment_text
        assert "spreadsheet rows should not be injected" not in attachment_text
        assert user_text == "Summarize the file"


class TestContextServiceOverwrite:
    """Test attachment overwrite functionality"""

    def test_overwrite_attachment_updates_existing_context(self):
        """Test overwriting an attachment updates metadata and storage data."""
        import sys

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.attachment.parser import ParseResult
        from app.services.context.context_service import context_service as cs_instance

        cs_module = sys.modules["app.services.context.context_service"]

        mock_db = Mock()
        storage_key = "attachments/test123_20250113_1_100"
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="old.txt",
            status=ContextStatus.READY.value,
            binary_data=b"old data",
            type_data={
                "storage_backend": "mysql",
                "storage_key": storage_key,
                "original_filename": "old.txt",
                "file_extension": ".txt",
                "file_size": 7,
                "mime_type": "text/plain",
                "is_encrypted": False,
            },
        )
        context.id = 100

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        new_binary_data = b"new data"
        parse_result = ParseResult(text="new data", text_length=8)

        with patch.object(cs_module, "_should_encrypt", return_value=False):
            with patch.object(cs_module, "get_storage_backend") as mock_get_backend:
                mock_backend = Mock()
                mock_get_backend.return_value = mock_backend

                with patch.object(
                    cs_instance.parser, "parse", return_value=parse_result
                ):
                    updated_context, truncation_info = cs_instance.overwrite_attachment(
                        db=mock_db,
                        context_id=context.id,
                        user_id=context.user_id,
                        filename="new.txt",
                        binary_data=new_binary_data,
                    )

        assert truncation_info is None
        assert updated_context.id == context.id
        assert updated_context.status == ContextStatus.READY.value
        assert updated_context.name == "new.txt"
        assert updated_context.original_filename == "new.txt"
        assert updated_context.file_size == len(new_binary_data)
        assert updated_context.storage_key == storage_key
        mock_backend.save.assert_called_once()
        saved_key, saved_data, saved_metadata = mock_backend.save.call_args.args
        assert saved_key == storage_key
        assert saved_data == new_binary_data
        assert saved_metadata["file_size"] == len(new_binary_data)

    def test_overwrite_clears_stale_is_truncated_flag(self):
        """Overwriting a truncated attachment with a non-truncated file clears
        the persisted is_truncated flag (so prefixes/readback stop warning)."""
        import sys

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.attachment.parser import ParseResult
        from app.services.context.context_service import context_service as cs_instance

        cs_module = sys.modules["app.services.context.context_service"]

        mock_db = Mock()
        storage_key = "attachments/test_trunc"
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="big.txt",
            status=ContextStatus.READY.value,
            binary_data=b"old big data",
            type_data={
                "storage_backend": "mysql",
                "storage_key": storage_key,
                "original_filename": "big.txt",
                "file_extension": ".txt",
                "file_size": 12,
                "mime_type": "text/plain",
                "is_encrypted": False,
                "is_truncated": True,  # previously truncated
            },
        )
        context.id = 101

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = context

        # New parse does NOT truncate (no truncation_info).
        parse_result = ParseResult(text="small", text_length=5)

        with patch.object(cs_module, "_should_encrypt", return_value=False):
            with patch.object(cs_module, "get_storage_backend") as mock_get_backend:
                mock_get_backend.return_value = Mock()
                with patch.object(
                    cs_instance.parser, "parse", return_value=parse_result
                ):
                    updated_context, truncation_info = cs_instance.overwrite_attachment(
                        db=mock_db,
                        context_id=context.id,
                        user_id=context.user_id,
                        filename="small.txt",
                        binary_data=b"small",
                    )

        assert truncation_info is None
        assert updated_context.is_truncated is False


class TestContextServiceCreateKnowledgeBaseContextWithResult:
    """Test create_knowledge_base_context_with_result functionality."""

    def test_create_knowledge_base_context_with_rag_result(self) -> None:
        """Test creating KB context with RAG result in one operation."""
        from app.models.subtask_context import ContextStatus, ContextType
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        mock_kind = Mock()
        mock_kind.name = "Test KB"

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_kind

        result_data = {
            "extracted_text": "Retrieved content from RAG",
            "sources": [{"index": 1, "title": "doc1.pdf", "kb_id": 123}],
            "injection_mode": "rag_retrieval",
            "query": "test query",
            "chunks_count": 5,
        }

        # Act
        result = context_service.create_knowledge_base_context_with_result(
            db=mock_db,
            subtask_id=100,
            knowledge_id=123,
            user_id=1,
            tool_type="rag",
            result_data=result_data,
        )

        # Assert
        mock_db.add.assert_called_once()
        mock_db.commit.assert_called_once()
        mock_db.refresh.assert_called_once()

        added_context = mock_db.add.call_args[0][0]
        assert added_context.subtask_id == 100
        assert added_context.user_id == 1
        assert added_context.context_type == ContextType.KNOWLEDGE_BASE.value
        assert added_context.name == "Test KB"
        assert added_context.status == ContextStatus.READY.value
        assert added_context.extracted_text == "Retrieved content from RAG"
        assert added_context.type_data["knowledge_id"] == 123
        assert added_context.type_data["auto_created"] is True
        assert added_context.type_data["rag_result"]["chunks_count"] == 5
        assert added_context.type_data["rag_result"]["query"] == "test query"
        assert (
            added_context.type_data["rag_result"]["injection_mode"] == "rag_retrieval"
        )
        assert added_context.type_data["rag_result"]["restricted_mode"] is False

    def test_create_knowledge_base_context_with_restricted_rag_result(self) -> None:
        """Restricted KB contexts should persist the restricted_mode flag."""
        from app.services.context import context_service

        mock_db = Mock()
        mock_kind = Mock()
        mock_kind.name = "Test KB"

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_kind

        result = context_service.create_knowledge_base_context_with_result(
            db=mock_db,
            subtask_id=100,
            knowledge_id=123,
            user_id=1,
            tool_type="rag",
            result_data={
                "extracted_text": "",
                "sources": [],
                "injection_mode": "rag_retrieval",
                "query": "diagnose",
                "chunks_count": 2,
                "restricted_mode": True,
            },
        )

        added_context = mock_db.add.call_args[0][0]
        assert result is not None
        assert added_context.type_data["rag_result"]["restricted_mode"] is True

    def test_create_knowledge_base_context_with_kb_head_result(self) -> None:
        """Test creating KB context with kb_head result in one operation."""
        from app.models.subtask_context import ContextStatus, ContextType
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        mock_kind = Mock()
        mock_kind.name = "Test KB"

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_kind

        result_data = {
            "document_ids": [1, 2, 3],
            "offset": 0,
            "limit": 50000,
        }

        # Act
        result = context_service.create_knowledge_base_context_with_result(
            db=mock_db,
            subtask_id=100,
            knowledge_id=456,
            user_id=2,
            tool_type="kb_head",
            result_data=result_data,
        )

        # Assert
        mock_db.add.assert_called_once()
        mock_db.commit.assert_called_once()
        mock_db.refresh.assert_called_once()

        added_context = mock_db.add.call_args[0][0]
        assert added_context.subtask_id == 100
        assert added_context.user_id == 2
        assert added_context.context_type == ContextType.KNOWLEDGE_BASE.value
        assert added_context.name == "Test KB"
        assert added_context.status == ContextStatus.READY.value
        assert added_context.extracted_text == ""
        assert added_context.type_data["knowledge_id"] == 456
        assert added_context.type_data["auto_created"] is True
        assert added_context.type_data["kb_head_result"]["usage_count"] == 1
        assert added_context.type_data["kb_head_result"]["document_ids"] == [1, 2, 3]

    def test_create_knowledge_base_context_with_empty_rag_result(self) -> None:
        """Test creating KB context with empty RAG result sets EMPTY status."""
        from app.models.subtask_context import ContextStatus, ContextType
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        mock_kind = Mock()
        mock_kind.name = "Test KB"

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_kind

        result_data = {
            "extracted_text": "",
            "sources": [],
            "injection_mode": "rag_retrieval",
            "query": "test query",
            "chunks_count": 0,  # No chunks found
        }

        # Act
        result = context_service.create_knowledge_base_context_with_result(
            db=mock_db,
            subtask_id=100,
            knowledge_id=123,
            user_id=1,
            tool_type="rag",
            result_data=result_data,
        )

        # Assert
        added_context = mock_db.add.call_args[0][0]
        assert added_context.status == ContextStatus.EMPTY.value

    def test_create_knowledge_base_context_fetches_kb_name(self) -> None:
        """Test that KB name is fetched from Kind table when not provided."""
        from app.models.subtask_context import ContextType
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        mock_kind = Mock()
        mock_kind.name = "Auto-fetched KB Name"

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_kind

        result_data = {
            "document_ids": [1],
            "offset": 0,
            "limit": 50000,
        }

        # Act
        result = context_service.create_knowledge_base_context_with_result(
            db=mock_db,
            subtask_id=100,
            knowledge_id=789,
            user_id=1,
            tool_type="kb_head",
            result_data=result_data,
        )

        # Assert
        added_context = mock_db.add.call_args[0][0]
        assert added_context.name == "Auto-fetched KB Name"

    def test_create_knowledge_base_context_with_custom_kb_name(self) -> None:
        """Test that custom KB name is used when provided."""
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()

        result_data = {
            "document_ids": [1],
            "offset": 0,
            "limit": 50000,
        }

        # Act
        result = context_service.create_knowledge_base_context_with_result(
            db=mock_db,
            subtask_id=100,
            knowledge_id=789,
            user_id=1,
            tool_type="kb_head",
            result_data=result_data,
            kb_name="Custom KB Name",
        )

        # Assert
        added_context = mock_db.add.call_args[0][0]
        assert added_context.name == "Custom KB Name"
        # Should not query Kind table when kb_name is provided
        # Note: The Kind query is only for fetching name when not provided

    def test_create_knowledge_base_context_invalid_tool_type(self) -> None:
        """Test that invalid tool_type raises ValueError."""
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()

        result_data = {"some": "data"}

        # Act & Assert
        with pytest.raises(ValueError) as exc_info:
            context_service.create_knowledge_base_context_with_result(
                db=mock_db,
                subtask_id=100,
                knowledge_id=789,
                user_id=1,
                tool_type="invalid_type",
                result_data=result_data,
            )

        assert "Unknown tool_type: invalid_type" in str(exc_info.value)

    def test_create_knowledge_base_context_marks_auto_created(self) -> None:
        """Test that auto_created flag is set in type_data."""
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        mock_kind = Mock()
        mock_kind.name = "Test KB"

        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_kind

        result_data = {
            "document_ids": [1],
            "offset": 0,
            "limit": 50000,
        }

        # Act
        result = context_service.create_knowledge_base_context_with_result(
            db=mock_db,
            subtask_id=100,
            knowledge_id=789,
            user_id=1,
            tool_type="kb_head",
            result_data=result_data,
        )

        # Assert
        added_context = mock_db.add.call_args[0][0]
        assert added_context.type_data["auto_created"] is True


class TestVideoAttachmentProcessing:
    """Test video attachment processing functionality."""

    def test_is_video_context_with_video_extension(self) -> None:
        """Video context is identified by file extension."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="video.mp4",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".mp4",
                "mime_type": "video/mp4",
            },
        )

        assert context_service.is_video_context(context) is True

    def test_is_video_context_with_non_video_extension(self) -> None:
        """Non-video files are not identified as video context."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="document.pdf",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".pdf",
                "mime_type": "application/pdf",
            },
        )

        assert context_service.is_video_context(context) is False

    def test_build_video_content_from_attachment_resolves_url(
        self, monkeypatch, test_db
    ) -> None:
        """Video payload resolves URL and keeps fid metadata."""
        from importlib import import_module
        from types import SimpleNamespace

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context_service_module = import_module("app.services.context.context_service")

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="video.mp4",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".mp4",
                "original_filename": "video.mp4",
                "file_size": 1024000,
                "mime_type": "video/mp4",
                "fid": 12345,
            },
        )
        context.id = 999

        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_reference",
            lambda **_kwargs: SimpleNamespace(name="fid", value=12345),
        )
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_playback",
            lambda **_kwargs: SimpleNamespace(
                url="https://example.com/video.mp4",
                media_type="video/mp4",
            ),
        )
        payload = context_service.build_video_content_from_attachment(test_db, context)

        assert payload is not None
        assert payload.video_url == "https://example.com/video.mp4"
        assert "12345" in payload.metadata_text

    def test_build_video_metadata_text_does_not_resolve_url(
        self, monkeypatch, test_db
    ) -> None:
        """Metadata-only video path exposes fid without resolving a download URL."""
        from importlib import import_module
        from types import SimpleNamespace

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context_service_module = import_module("app.services.context.context_service")
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="video.mp4",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".mp4",
                "original_filename": "video.mp4",
                "file_size": 1024000,
                "mime_type": "video/mp4",
                "fid": 12345,
            },
        )
        context.id = 999
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_reference",
            lambda **_kwargs: SimpleNamespace(name="fid", value=12345),
        )

        metadata_header, metadata_text, fid = context_service.build_video_metadata_text(
            context
        )

        assert "video.mp4" in metadata_header
        assert metadata_text.startswith(metadata_header)
        assert '"fid": 12345' in metadata_text
        assert fid == 12345

    def test_build_video_metadata_text_supports_hosted_media_id(
        self, monkeypatch
    ) -> None:
        """Metadata-only chat keeps the media id used by AIGC tools."""
        from importlib import import_module
        from types import SimpleNamespace

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context_service_module = import_module("app.services.context.context_service")
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="video.mp4",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".mp4",
                "original_filename": "video.mp4",
                "file_size": 1024000,
                "mime_type": "video/mp4",
                "weibo_video_upload": {"media_id": "media-123"},
            },
        )
        context.id = 999
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_reference",
            lambda **_kwargs: SimpleNamespace(name="media_id", value="media-123"),
        )

        _header, metadata_text, media_id = context_service.build_video_metadata_text(
            context
        )

        assert '"media_id": "media-123"' in metadata_text
        assert media_id == "media-123"

    def test_build_video_content_resolves_hosted_media_id(
        self, monkeypatch, test_db
    ) -> None:
        """Video-capable models resolve externally hosted reference videos."""
        from importlib import import_module
        from types import SimpleNamespace

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context_service_module = import_module("app.services.context.context_service")
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="video.mp4",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".mp4",
                "original_filename": "video.mp4",
                "file_size": 1024000,
                "mime_type": "video/mp4",
                "weibo_video_upload": {"media_id": "media-123"},
            },
        )
        context.id = 999
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_reference",
            lambda **_kwargs: SimpleNamespace(
                name="media_id",
                value="media-123",
            ),
        )
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_playback",
            lambda **kwargs: SimpleNamespace(
                url="https://example.com/video.mp4", media_type="video/mp4"
            ),
        )

        payload = context_service.build_video_content_from_attachment(test_db, context)

        assert payload is not None
        assert payload.video_url == "https://example.com/video.mp4"
        assert '"media_id": "media-123"' in payload.metadata_text

    def test_build_video_history_metadata_text_allows_missing_fid(
        self, test_db
    ) -> None:
        """History metadata can preserve video context even without model input fid."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="video.mp4",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".mp4",
                "original_filename": "video.mp4",
                "file_size": 1024000,
                "mime_type": "video/mp4",
            },
        )
        context.id = 999

        metadata_text = context_service.build_video_history_metadata_text(context)

        assert "Video Attachment: video.mp4" in metadata_text
        assert "ID: 999" in metadata_text
        assert '"fid"' not in metadata_text

    def test_build_video_content_from_attachment_raises_when_url_missing(
        self, monkeypatch, test_db
    ) -> None:
        """Video URL resolution failure raises instead of falling back to metadata."""
        from importlib import import_module
        from types import SimpleNamespace

        import pytest

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service
        from app.services.context.context_service import VideoAttachmentResolutionError

        context_service_module = import_module("app.services.context.context_service")

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="video.mp4",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".mp4",
                "original_filename": "video.mp4",
                "file_size": 1024000,
                "mime_type": "video/mp4",
                "fid": 12345,
            },
        )
        context.id = 999

        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_reference",
            lambda **_kwargs: SimpleNamespace(name="fid", value=12345),
        )
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_playback",
            lambda **_kwargs: None,
        )

        with pytest.raises(VideoAttachmentResolutionError):
            context_service.build_video_content_from_attachment(test_db, context)

    def test_build_video_content_from_attachment_raises_without_fid_when_resolving(
        self, monkeypatch, test_db
    ) -> None:
        """Video URL resolution requires fid."""
        from importlib import import_module

        import pytest

        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service
        from app.services.context.context_service import VideoAttachmentResolutionError

        context_service_module = import_module("app.services.context.context_service")
        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="video.mp4",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".mp4",
                "original_filename": "video.mp4",
                "file_size": 1024000,
                "mime_type": "video/mp4",
            },
        )
        context.id = 999
        monkeypatch.setattr(
            context_service_module,
            "resolve_external_attachment_reference",
            lambda **_kwargs: None,
        )

        with pytest.raises(VideoAttachmentResolutionError):
            context_service.build_video_content_from_attachment(test_db, context)

    def test_build_video_content_from_non_video_returns_none(self, test_db) -> None:
        """Non-video context returns None from video builder."""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.context import context_service

        context = SubtaskContext(
            subtask_id=100,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="document.pdf",
            status=ContextStatus.READY.value,
            type_data={
                "file_extension": ".pdf",
                "mime_type": "application/pdf",
            },
        )

        payload = context_service.build_video_content_from_attachment(test_db, context)

        assert payload is None

    def test_video_attachment_payload_dataclass(self) -> None:
        """VideoAttachmentPayload dataclass has expected fields."""
        from app.services.context.context_service import VideoAttachmentPayload

        payload = VideoAttachmentPayload(
            video_url="https://example.com/video.mp4",
            mime_type="video/mp4",
            metadata_header="[Video Attachment: video.mp4 | ID: 999 | Type: video/mp4 | Size: 1.0 MB]",
            metadata_text='[Video Attachment: video.mp4 | ID: 999 | Type: video/mp4 | Size: 1.0 MB]\n{"fid": 12345}',
        )

        assert payload.video_url == "https://example.com/video.mp4"
        assert payload.mime_type == "video/mp4"
        assert "12345" in payload.metadata_text
