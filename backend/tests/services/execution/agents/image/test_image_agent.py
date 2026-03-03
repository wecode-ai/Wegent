# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for ImageAgent.

Tests the image generation agent workflow including:
- Normal execution flow
- Cancellation handling
- Error handling
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shared.models import EventType, ExecutionRequest


class TestImageAgent:
    """Tests for ImageAgent."""

    @pytest.fixture
    def mock_session_manager(self):
        """Create mock session manager."""
        with patch("app.services.chat.storage.session.session_manager") as mock_manager:
            mock_cancel_event = asyncio.Event()
            mock_manager.register_stream = AsyncMock(return_value=mock_cancel_event)
            mock_manager.unregister_stream = AsyncMock()
            mock_manager.is_cancelled = AsyncMock(return_value=False)
            yield mock_manager

    @pytest.fixture
    def mock_emitter(self):
        """Create mock result emitter."""
        emitter = AsyncMock()
        emitter.emit_start = AsyncMock()
        emitter.emit = AsyncMock()
        return emitter

    @pytest.fixture
    def sample_request(self):
        """Create sample execution request."""
        return ExecutionRequest(
            task_id=1,
            subtask_id=100,
            message_id=200,
            prompt="A beautiful sunset over the ocean",
            model_config={
                "protocol": "seedream",
                "base_url": "https://api.example.com",
                "api_key": "test-api-key",
                "model": "doubao-seedream-5.0-lite",
                "imageConfig": {
                    "size": "2048x2048",
                    "response_format": "url",
                    "watermark": False,
                },
            },
            user={"id": 1, "name": "test_user"},
        )

    @pytest.mark.asyncio
    async def test_execute_normal_flow(
        self, mock_session_manager, mock_emitter, sample_request
    ):
        """Test normal execution flow."""
        from app.services.execution.agents.image.image_agent import ImageAgent
        from app.services.execution.agents.image.providers.base import (
            ImageGenerationResult,
            ImageResult,
        )

        # Arrange
        mock_result = ImageGenerationResult(
            images=[
                ImageResult(url="https://example.com/image1.jpg", size="2048x2048"),
            ],
            model="doubao-seedream-5.0-lite",
            usage={"prompt_tokens": 10, "total_tokens": 10},
        )

        with patch(
            "app.services.execution.agents.image.image_agent.get_image_provider"
        ) as mock_get_provider:
            mock_provider = AsyncMock()
            mock_provider.name = "Seedream"
            mock_provider.generate = AsyncMock(return_value=mock_result)
            mock_get_provider.return_value = mock_provider

            with patch(
                "app.services.execution.agents.image.image_agent.ImageAgent._upload_attachment"
            ) as mock_upload:
                mock_upload.return_value = 999  # attachment_id

                agent = ImageAgent()

                # Act
                await agent.execute(sample_request, mock_emitter)

        # Assert
        # Verify emit_start was called
        mock_emitter.emit_start.assert_called_once()
        call_kwargs = mock_emitter.emit_start.call_args[1]
        assert call_kwargs["task_id"] == 1
        assert call_kwargs["subtask_id"] == 100
        assert call_kwargs["message_id"] == 200

        # Verify provider was called with correct prompt
        mock_provider.generate.assert_called_once()
        call_kwargs = mock_provider.generate.call_args[1]
        assert call_kwargs["prompt"] == "A beautiful sunset over the ocean"

        # Verify DONE event was emitted
        done_calls = [
            call
            for call in mock_emitter.emit.call_args_list
            if call[0][0].type == EventType.DONE
        ]
        assert len(done_calls) == 1
        done_event = done_calls[0][0][0]
        assert done_event.task_id == 1
        assert done_event.subtask_id == 100
        assert done_event.result is not None
        assert "blocks" in done_event.result
        assert done_event.result["blocks"][0]["type"] == "image"
        assert done_event.result["blocks"][0]["status"] == "done"

        # Verify session was unregistered
        mock_session_manager.unregister_stream.assert_called_once_with(100)

    @pytest.mark.asyncio
    async def test_execute_with_cancellation(
        self, mock_session_manager, mock_emitter, sample_request
    ):
        """Test execution with cancellation."""
        from app.services.execution.agents.image.image_agent import ImageAgent

        # Arrange - set cancellation flag
        mock_session_manager.is_cancelled = AsyncMock(return_value=True)

        agent = ImageAgent()

        # Act
        await agent.execute(sample_request, mock_emitter)

        # Assert
        # Verify CANCELLED event was emitted
        cancelled_calls = [
            call
            for call in mock_emitter.emit.call_args_list
            if call[0][0].type == EventType.CANCELLED
        ]
        assert len(cancelled_calls) == 1
        cancelled_event = cancelled_calls[0][0][0]
        assert cancelled_event.task_id == 1
        assert cancelled_event.subtask_id == 100

        # Verify session was unregistered
        mock_session_manager.unregister_stream.assert_called_once_with(100)

    @pytest.mark.asyncio
    async def test_execute_with_cancel_event_set(
        self, mock_session_manager, mock_emitter, sample_request
    ):
        """Test execution when cancel event is already set."""
        from app.services.execution.agents.image.image_agent import ImageAgent

        # Arrange - set cancel event
        cancel_event = asyncio.Event()
        cancel_event.set()
        mock_session_manager.register_stream = AsyncMock(return_value=cancel_event)

        agent = ImageAgent()

        # Act
        await agent.execute(sample_request, mock_emitter)

        # Assert
        # Verify CANCELLED event was emitted
        cancelled_calls = [
            call
            for call in mock_emitter.emit.call_args_list
            if call[0][0].type == EventType.CANCELLED
        ]
        assert len(cancelled_calls) == 1

    @pytest.mark.asyncio
    async def test_execute_with_provider_error(
        self, mock_session_manager, mock_emitter, sample_request
    ):
        """Test execution with provider error."""
        from app.services.execution.agents.image.image_agent import ImageAgent

        # Arrange
        with patch(
            "app.services.execution.agents.image.image_agent.get_image_provider"
        ) as mock_get_provider:
            mock_provider = AsyncMock()
            mock_provider.name = "Seedream"
            mock_provider.generate = AsyncMock(
                side_effect=Exception("API rate limit exceeded")
            )
            mock_get_provider.return_value = mock_provider

            agent = ImageAgent()

            # Act
            await agent.execute(sample_request, mock_emitter)

        # Assert
        # Verify ERROR event was emitted
        error_calls = [
            call
            for call in mock_emitter.emit.call_args_list
            if call[0][0].type == EventType.ERROR
        ]
        assert len(error_calls) == 1
        error_event = error_calls[0][0][0]
        assert error_event.task_id == 1
        assert error_event.subtask_id == 100
        assert "API rate limit exceeded" in error_event.error

        # Verify session was unregistered
        mock_session_manager.unregister_stream.assert_called_once_with(100)

    @pytest.mark.asyncio
    async def test_execute_with_no_images_generated(
        self, mock_session_manager, mock_emitter, sample_request
    ):
        """Test execution when no images are generated."""
        from app.services.execution.agents.image.image_agent import ImageAgent
        from app.services.execution.agents.image.providers.base import (
            ImageGenerationResult,
        )

        # Arrange
        mock_result = ImageGenerationResult(
            images=[],  # No images
            model="doubao-seedream-5.0-lite",
        )

        with patch(
            "app.services.execution.agents.image.image_agent.get_image_provider"
        ) as mock_get_provider:
            mock_provider = AsyncMock()
            mock_provider.name = "Seedream"
            mock_provider.generate = AsyncMock(return_value=mock_result)
            mock_get_provider.return_value = mock_provider

            agent = ImageAgent()

            # Act
            await agent.execute(sample_request, mock_emitter)

        # Assert
        # Verify ERROR event was emitted
        error_calls = [
            call
            for call in mock_emitter.emit.call_args_list
            if call[0][0].type == EventType.ERROR
        ]
        assert len(error_calls) == 1
        error_event = error_calls[0][0][0]
        assert "No images generated" in error_event.error

    @pytest.mark.asyncio
    async def test_execute_with_base64_image(
        self, mock_session_manager, mock_emitter, sample_request
    ):
        """Test execution with base64 encoded image result."""
        from app.services.execution.agents.image.image_agent import ImageAgent
        from app.services.execution.agents.image.providers.base import (
            ImageGenerationResult,
            ImageResult,
        )

        # Arrange
        mock_result = ImageGenerationResult(
            images=[
                ImageResult(
                    url=None,
                    b64_json="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                    size="2048x2048",
                ),
            ],
            model="doubao-seedream-5.0-lite",
        )

        with patch(
            "app.services.execution.agents.image.image_agent.get_image_provider"
        ) as mock_get_provider:
            mock_provider = AsyncMock()
            mock_provider.name = "Seedream"
            mock_provider.generate = AsyncMock(return_value=mock_result)
            mock_get_provider.return_value = mock_provider

            with patch(
                "app.services.execution.agents.image.image_agent.ImageAgent._upload_attachment"
            ) as mock_upload:
                mock_upload.return_value = 999

                agent = ImageAgent()

                # Act
                await agent.execute(sample_request, mock_emitter)

        # Assert
        # Verify DONE event was emitted with data URL
        done_calls = [
            call
            for call in mock_emitter.emit.call_args_list
            if call[0][0].type == EventType.DONE
        ]
        assert len(done_calls) == 1
        done_event = done_calls[0][0][0]
        image_urls = done_event.result["blocks"][0]["image_urls"]
        assert len(image_urls) == 1
        assert image_urls[0].startswith("data:image/jpeg;base64,")

    @pytest.mark.asyncio
    async def test_execute_with_multiple_images(
        self, mock_session_manager, mock_emitter, sample_request
    ):
        """Test execution with multiple images generated."""
        from app.services.execution.agents.image.image_agent import ImageAgent
        from app.services.execution.agents.image.providers.base import (
            ImageGenerationResult,
            ImageResult,
        )

        # Arrange
        mock_result = ImageGenerationResult(
            images=[
                ImageResult(url="https://example.com/image1.jpg", size="2048x2048"),
                ImageResult(url="https://example.com/image2.jpg", size="2048x2048"),
                ImageResult(url="https://example.com/image3.jpg", size="2048x2048"),
            ],
            model="doubao-seedream-5.0-lite",
        )

        with patch(
            "app.services.execution.agents.image.image_agent.get_image_provider"
        ) as mock_get_provider:
            mock_provider = AsyncMock()
            mock_provider.name = "Seedream"
            mock_provider.generate = AsyncMock(return_value=mock_result)
            mock_get_provider.return_value = mock_provider

            with patch(
                "app.services.execution.agents.image.image_agent.ImageAgent._upload_attachment"
            ) as mock_upload:
                mock_upload.side_effect = [1001, 1002, 1003]

                agent = ImageAgent()

                # Act
                await agent.execute(sample_request, mock_emitter)

        # Assert
        # Verify DONE event was emitted with all images
        done_calls = [
            call
            for call in mock_emitter.emit.call_args_list
            if call[0][0].type == EventType.DONE
        ]
        assert len(done_calls) == 1
        done_event = done_calls[0][0][0]
        image_block = done_event.result["blocks"][0]
        assert image_block["image_count"] == 3
        assert len(image_block["image_urls"]) == 3
        assert len(image_block["image_attachment_ids"]) == 3

    def test_agent_name(self):
        """Test agent name property."""
        from app.services.execution.agents.image.image_agent import ImageAgent

        agent = ImageAgent()
        assert agent.name == "ImageAgent"


class TestImageAgentExtractReferenceImages:
    """Tests for ImageAgent._extract_reference_images method."""

    def test_extract_no_attachments(self):
        """Test extraction with no attachments."""
        from app.services.execution.agents.image.image_agent import ImageAgent

        request = ExecutionRequest(
            task_id=1,
            subtask_id=100,
            prompt="test",
            attachments=[],
        )

        agent = ImageAgent()
        result = agent._extract_reference_images(request)

        assert result == []

    def test_extract_image_attachments(self):
        """Test extraction with image attachments."""
        from app.services.execution.agents.image.image_agent import ImageAgent

        request = ExecutionRequest(
            task_id=1,
            subtask_id=100,
            prompt="test",
            attachments=[
                {"mime_type": "image/jpeg", "url": "https://example.com/ref1.jpg"},
                {"mime_type": "image/png", "url": "https://example.com/ref2.png"},
            ],
        )

        agent = ImageAgent()
        result = agent._extract_reference_images(request)

        assert len(result) == 2
        assert "https://example.com/ref1.jpg" in result
        assert "https://example.com/ref2.png" in result

    def test_extract_mixed_attachments(self):
        """Test extraction with mixed attachment types."""
        from app.services.execution.agents.image.image_agent import ImageAgent

        request = ExecutionRequest(
            task_id=1,
            subtask_id=100,
            prompt="test",
            attachments=[
                {"mime_type": "image/jpeg", "url": "https://example.com/ref1.jpg"},
                {"mime_type": "application/pdf", "url": "https://example.com/doc.pdf"},
                {"mime_type": "text/plain", "content": "some text"},
            ],
        )

        agent = ImageAgent()
        result = agent._extract_reference_images(request)

        # Only image attachment should be extracted
        assert len(result) == 1
        assert "https://example.com/ref1.jpg" in result

    def test_extract_with_content_field(self):
        """Test extraction using content field when url is not present."""
        from app.services.execution.agents.image.image_agent import ImageAgent

        request = ExecutionRequest(
            task_id=1,
            subtask_id=100,
            prompt="test",
            attachments=[
                {"mime_type": "image/jpeg", "content": "data:image/jpeg;base64,abc123"},
            ],
        )

        agent = ImageAgent()
        result = agent._extract_reference_images(request)

        assert len(result) == 1
        assert "data:image/jpeg;base64,abc123" in result
