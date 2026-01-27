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
