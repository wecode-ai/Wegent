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
        """Test upload fails for unsupported file types"""
        from app.services.context import context_service

        # Arrange
        mock_db = Mock()
        user_id = 1
        filename = "test.exe"
        binary_data = b"fake exe content"

        # Act & Assert
        with pytest.raises(ValueError, match="Unsupported file type"):
            context_service.upload_attachment(
                db=mock_db, user_id=user_id, filename=filename, binary_data=binary_data
            )

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
        assert binary_data == b"stored data"


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

    def test_build_document_text_prefix(self):
        """Test building document text prefix for messages"""
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
            type_data={"original_filename": "test.pdf"},
        )

        # Act
        prefix = context_service.build_document_text_prefix(context)

        # Assert
        assert prefix is not None
        assert "[File Content - test.pdf]:" in prefix
        assert "This is the extracted PDF content." in prefix

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
            type_data={"file_extension": ".pdf", "original_filename": "test.pdf"},
        )
        message = "Summarize this document"

        # Act
        result = context_service.build_message_with_attachment(message, context)

        # Assert
        assert isinstance(result, str)
        assert "[File Content - test.pdf]:" in result
        assert "PDF content here" in result
        assert "[User Question]:" in result
        assert "Summarize this document" in result
