# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for ContextService - Simplified version.

Tests the core functionality of unified context management.
Uses mocks to avoid database dependencies.
"""

from unittest.mock import Mock, patch

import pytest


class TestContextServiceKnowledgeBaseRetrieval:
    """Test knowledge base retrieval result functionality"""

    def test_update_knowledge_base_retrieval_result_rag_mode(self):
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
        assert result.type_data["injection_mode"] == "rag_retrieval"
        assert result.type_data["query"] == "test query"
        assert result.type_data["chunks_count"] == 5
        assert result.type_data["sources"] == sources

    def test_update_knowledge_base_retrieval_result_direct_injection_mode(self):
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
        assert result.type_data["injection_mode"] == "direct_injection"
        assert result.type_data["query"] == "test query"
        assert result.type_data["chunks_count"] == 10

    def test_update_knowledge_base_retrieval_result_empty_status(self):
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
        assert result.type_data["chunks_count"] == 0

    def test_update_knowledge_base_retrieval_result_increments_retrieval_count(self):
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
        assert result.type_data["retrieval_count"] == 1

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
        assert result2.type_data["retrieval_count"] == 2
        assert result2.type_data["query"] == "second query"
        assert result2.type_data["chunks_count"] == 3

    def test_update_knowledge_base_retrieval_result_not_found(self):
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

    def test_update_knowledge_base_retrieval_result_wrong_type(self):
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

    def test_kb_head_count_property(self):
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

    def test_kb_head_document_ids_property(self):
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

    def test_update_kb_head_result_basic(self):
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

    def test_update_kb_head_result_increments_count(self):
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

    def test_update_kb_head_result_preserves_rag_data(self):
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

    def test_update_kb_head_result_not_found(self):
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

    def test_update_kb_head_result_wrong_type(self):
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
        # Use actual binary data (PNG header) that MIME detection will identify as binary
        # The parser will reject this because .bin is not a known extension and
        # the content is binary (not text-based)
        png_header = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        binary_data = png_header + bytes(100)

        # Act & Assert
        # The parser now allows unknown extensions but uses MIME detection to validate
        # Binary files without matching parsers will raise DocumentParseError
        with pytest.raises(DocumentParseError) as exc_info:
            parser.parse(binary_data, ".bin")
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

    def test_build_document_text_prefix_with_truncation(self):
        """Test building document text prefix with truncation notice"""
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.services.attachment.parser import DocumentParser
        from app.services.context import context_service

        # Arrange - set text_length >= max to trigger truncation notice
        max_text_length = DocumentParser.get_max_text_length()
        context = SubtaskContext(
            subtask_id=0,
            user_id=1,
            context_type=ContextType.ATTACHMENT.value,
            name="large.pdf",
            status=ContextStatus.READY.value,
            extracted_text="Content...",
            text_length=max_text_length,  # At max length
            type_data={
                "original_filename": "large.pdf",
                "mime_type": "application/pdf",
                "file_size": 5242880,  # 5 MB
            },
        )
        context.id = 100

        # Act
        prefix = context_service.build_document_text_prefix(context)

        # Assert
        assert prefix is not None
        assert "[Attachment: large.pdf |" in prefix
        assert "ID: 100" in prefix
        assert "Type: application/pdf" in prefix
        assert "Size: 5.0 MB" in prefix
        assert "URL: /api/attachments/100/download" in prefix
        assert "truncated" in prefix.lower()

    def test_build_message_with_image_attachment(self):
        """Test building message with image attachment"""
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
            image_base64="base64data",
            type_data={
                "file_extension": ".jpg",
                "mime_type": "image/jpeg",
                "original_filename": "test.jpg",
            },
        )
        message = "What's in this image?"

        # Act
        result = context_service.build_message_with_attachment(message, context)

        # Assert
        assert isinstance(result, dict)
        assert result["type"] == "vision"
        assert result["text"] == message
        assert result["image_base64"] == "base64data"

    def test_build_message_with_document_attachment(self):
        """Test building message with document attachment"""
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
            extracted_text="PDF content here",
            text_length=16,  # Add text_length to avoid None comparison error
            type_data={
                "file_extension": ".pdf",
                "original_filename": "test.pdf",
                "mime_type": "application/pdf",
                "file_size": 1024,  # 1 KB
            },
        )
        context.id = 123
        message = "Summarize this document"

        # Act
        result = context_service.build_message_with_attachment(message, context)

        # Assert
        assert isinstance(result, str)
        assert "[Attachment: test.pdf |" in result
        assert "ID: 123" in result
        assert "Type: application/pdf" in result
        assert "Size: 1.0 KB" in result
        assert "URL: /api/attachments/123/download" in result
        assert "PDF content here" in result
        assert "[User Question]:" in result
        assert "Summarize this document" in result


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
