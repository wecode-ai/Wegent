# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for AI trigger service - multi-attachment processing."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.models.subtask_attachment import AttachmentStatus
from app.services.chat.ai_trigger import _process_attachments


class TestProcessAttachments:
    """Test suite for _process_attachments function."""

    @pytest.mark.asyncio
    async def test_process_multiple_text_attachments(self):
        """Test processing multiple text document attachments together."""
        # Arrange
        db = Mock()
        attachment_ids = [1, 2]
        user_id = 123
        message = "Analyze these documents"

        # Mock attachment objects
        attachment1 = Mock()
        attachment1.status = AttachmentStatus.READY
        attachment1.image_base64 = None
        attachment1.original_filename = "doc1.pdf"

        attachment2 = Mock()
        attachment2.status = AttachmentStatus.READY
        attachment2.image_base64 = None
        attachment2.original_filename = "doc2.txt"

        # Mock attachment service
        with patch(
            "app.services.chat.ai_trigger.attachment_service"
        ) as mock_attachment_service:
            mock_attachment_service.get_attachment.side_effect = [
                attachment1,
                attachment2,
            ]
            mock_attachment_service.is_image_attachment.return_value = False
            mock_attachment_service.build_document_text_prefix.side_effect = [
                "Content of document 1",
                "Content of document 2",
            ]

            # Act
            result = await _process_attachments(db, attachment_ids, user_id, message)

            # Assert
            assert isinstance(result, str)
            assert "【附件 1】" in result
            assert "【附件 2】" in result
            assert "Content of document 1" in result
            assert "Content of document 2" in result
            assert "【用户问题】" in result
            assert message in result
            assert mock_attachment_service.get_attachment.call_count == 2

    @pytest.mark.asyncio
    async def test_process_multiple_images(self):
        """Test processing multiple image attachments returns multi_vision structure."""
        # Arrange
        db = Mock()
        attachment_ids = [10, 20]
        user_id = 456
        message = "What's in these images?"

        # Mock image attachments
        attachment1 = Mock()
        attachment1.status = AttachmentStatus.READY
        attachment1.image_base64 = "base64_image_1"
        attachment1.mime_type = "image/png"
        attachment1.original_filename = "image1.png"

        attachment2 = Mock()
        attachment2.status = AttachmentStatus.READY
        attachment2.image_base64 = "base64_image_2"
        attachment2.mime_type = "image/jpeg"
        attachment2.original_filename = "image2.jpg"

        with patch(
            "app.services.chat.ai_trigger.attachment_service"
        ) as mock_attachment_service:
            mock_attachment_service.get_attachment.side_effect = [
                attachment1,
                attachment2,
            ]
            mock_attachment_service.is_image_attachment.return_value = True

            # Act
            result = await _process_attachments(db, attachment_ids, user_id, message)

            # Assert
            assert isinstance(result, dict)
            assert result["type"] == "multi_vision"
            assert "【用户问题】" in result["text"]
            assert message in result["text"]
            assert len(result["images"]) == 2
            assert result["images"][0]["image_base64"] == "base64_image_1"
            assert result["images"][0]["mime_type"] == "image/png"
            assert result["images"][1]["image_base64"] == "base64_image_2"
            assert result["images"][1]["mime_type"] == "image/jpeg"

    @pytest.mark.asyncio
    async def test_process_mixed_attachments(self):
        """Test processing mixed text and image attachments."""
        # Arrange
        db = Mock()
        attachment_ids = [1, 2, 3]
        user_id = 789
        message = "Analyze this document and image"

        # Mock mixed attachments (text, image, text)
        text_attachment = Mock()
        text_attachment.status = AttachmentStatus.READY
        text_attachment.image_base64 = None

        image_attachment = Mock()
        image_attachment.status = AttachmentStatus.READY
        image_attachment.image_base64 = "base64_image"
        image_attachment.mime_type = "image/png"
        image_attachment.original_filename = "chart.png"

        with patch(
            "app.services.chat.ai_trigger.attachment_service"
        ) as mock_attachment_service:
            mock_attachment_service.get_attachment.side_effect = [
                text_attachment,
                image_attachment,
                text_attachment,
            ]
            mock_attachment_service.is_image_attachment.side_effect = [
                False,
                True,
                False,
            ]
            mock_attachment_service.build_document_text_prefix.side_effect = [
                "Text document content",
                "Another text document",
            ]

            # Act
            result = await _process_attachments(db, attachment_ids, user_id, message)

            # Assert
            # Should return multi_vision structure because there's at least one image
            assert isinstance(result, dict)
            assert result["type"] == "multi_vision"
            assert "【附件 1】" in result["text"]  # Text attachment included in text
            assert "【附件 3】" in result["text"]
            assert len(result["images"]) == 1  # Only image attachment

    @pytest.mark.asyncio
    async def test_process_attachments_empty_list(self):
        """Test processing empty attachment list returns original message."""
        # Arrange
        db = Mock()
        attachment_ids = []
        user_id = 999
        message = "No attachments"

        # Act
        result = await _process_attachments(db, attachment_ids, user_id, message)

        # Assert
        assert result == message

    @pytest.mark.asyncio
    async def test_process_attachments_not_ready(self):
        """Test processing attachments that are not ready."""
        # Arrange
        db = Mock()
        attachment_ids = [1, 2]
        user_id = 100
        message = "Process when ready"

        # Mock attachments with different statuses
        attachment1 = Mock()
        attachment1.status = AttachmentStatus.PARSING  # Not ready

        attachment2 = Mock()
        attachment2.status = AttachmentStatus.FAILED  # Failed

        with patch(
            "app.services.chat.ai_trigger.attachment_service"
        ) as mock_attachment_service:
            mock_attachment_service.get_attachment.side_effect = [
                attachment1,
                attachment2,
            ]

            # Act
            result = await _process_attachments(db, attachment_ids, user_id, message)

            # Assert
            # Should return original message since no attachments are ready
            assert result == message

    @pytest.mark.asyncio
    async def test_process_attachments_none_returned(self):
        """Test processing when attachment service returns None."""
        # Arrange
        db = Mock()
        attachment_ids = [999]  # Non-existent attachment
        user_id = 200
        message = "Try to process non-existent attachment"

        with patch(
            "app.services.chat.ai_trigger.attachment_service"
        ) as mock_attachment_service:
            mock_attachment_service.get_attachment.return_value = None

            # Act
            result = await _process_attachments(db, attachment_ids, user_id, message)

            # Assert
            assert result == message

    @pytest.mark.asyncio
    async def test_process_image_without_base64(self):
        """Test processing image attachment without base64 data."""
        # Arrange
        db = Mock()
        attachment_ids = [1]
        user_id = 300
        message = "Image without data"

        # Mock image attachment without base64
        attachment = Mock()
        attachment.status = AttachmentStatus.READY
        attachment.image_base64 = None  # No image data

        with patch(
            "app.services.chat.ai_trigger.attachment_service"
        ) as mock_attachment_service:
            mock_attachment_service.get_attachment.return_value = attachment
            mock_attachment_service.is_image_attachment.return_value = True
            # When image has no base64, it falls back to text document processing
            mock_attachment_service.build_document_text_prefix.return_value = (
                ""  # Empty content
            )

            # Act
            result = await _process_attachments(db, attachment_ids, user_id, message)

            # Assert
            # Should return original message since document has no content
            assert result == message

    @pytest.mark.asyncio
    async def test_process_text_with_empty_prefix(self):
        """Test processing text attachment that returns empty prefix."""
        # Arrange
        db = Mock()
        attachment_ids = [1]
        user_id = 400
        message = "Empty text document"

        attachment = Mock()
        attachment.status = AttachmentStatus.READY
        attachment.image_base64 = None

        with patch(
            "app.services.chat.ai_trigger.attachment_service"
        ) as mock_attachment_service:
            mock_attachment_service.get_attachment.return_value = attachment
            mock_attachment_service.is_image_attachment.return_value = False
            mock_attachment_service.build_document_text_prefix.return_value = (
                ""  # Empty content
            )

            # Act
            result = await _process_attachments(db, attachment_ids, user_id, message)

            # Assert
            # Should return original message since document has no content
            assert result == message
