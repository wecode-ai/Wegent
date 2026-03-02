# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for SeedreamProvider.

Tests the Seedream image generation provider including:
- generate() method
- API response parsing
- Error handling
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from openai import APIConnectionError, APITimeoutError


def create_mock_image_data(url=None, b64_json=None):
    """Create a mock image data object."""
    mock_data = MagicMock()
    mock_data.url = url
    mock_data.b64_json = b64_json
    return mock_data


def create_mock_response(data_items, model="doubao-seedream-5.0-lite"):
    """Create a mock OpenAI images.generate response."""
    mock_response = MagicMock()
    mock_response.data = data_items
    mock_response.model = model
    return mock_response


class TestSeedreamProvider:
    """Tests for SeedreamProvider."""

    @pytest.fixture
    def mock_openai_client(self):
        """Create a mock OpenAI client."""
        mock_client = MagicMock()
        mock_client.images = MagicMock()
        mock_client.images.generate = AsyncMock()
        return mock_client

    @pytest.fixture
    def provider(self, mock_openai_client):
        """Create SeedreamProvider instance with mocked client."""
        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            provider = SeedreamProvider(
                base_url="https://api.example.com",
                api_key="test-api-key",
                model="doubao-seedream-5.0-lite",
                image_config={
                    "size": "2048x2048",
                    "response_format": "url",
                    "watermark": False,
                },
            )
            # Replace the real client with mock
            provider.client = mock_openai_client
            return provider

    def test_provider_name(self, provider):
        """Test provider name property."""
        assert provider.name == "Seedream"

    def test_init_with_defaults(self):
        """Test initialization with default values."""
        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            provider = SeedreamProvider(
                base_url="https://api.example.com",
                api_key="test-key",
            )

            assert provider.base_url == "https://api.example.com"
            assert provider.api_key == "test-key"
            assert provider.model == ""
            assert provider.image_config == {}

    def test_init_strips_trailing_slash(self):
        """Test that trailing slash is stripped from base_url."""
        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            provider = SeedreamProvider(
                base_url="https://api.example.com/",
                api_key="test-key",
            )

            assert provider.base_url == "https://api.example.com"

    def test_init_handles_empty_values(self):
        """Test initialization with empty values."""
        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            provider = SeedreamProvider(
                base_url="",
                api_key="",
            )

            assert provider.base_url == ""
            assert provider.api_key == ""

    @pytest.mark.asyncio
    async def test_generate_basic(self, provider, mock_openai_client):
        """Test basic image generation."""
        # Arrange
        mock_data = create_mock_image_data(
            url="https://example.com/generated-image.jpg"
        )
        mock_response = create_mock_response(
            [mock_data], model="doubao-seedream-5.0-lite"
        )
        mock_openai_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(prompt="A beautiful sunset")

        # Assert
        assert len(result.images) == 1
        assert result.images[0].url == "https://example.com/generated-image.jpg"
        assert result.images[0].size == "2048x2048"
        assert result.model == "doubao-seedream-5.0-lite"

        # Verify API call
        mock_openai_client.images.generate.assert_called_once()
        call_kwargs = mock_openai_client.images.generate.call_args[1]
        assert call_kwargs["model"] == "doubao-seedream-5.0-lite"
        assert call_kwargs["prompt"] == "A beautiful sunset"
        assert call_kwargs["size"] == "2048x2048"
        assert call_kwargs["response_format"] == "url"
        assert call_kwargs["extra_body"]["watermark"] is False

    @pytest.mark.asyncio
    async def test_generate_with_single_reference_image(
        self, provider, mock_openai_client
    ):
        """Test generation with single reference image."""
        mock_data = create_mock_image_data(url="https://example.com/result.jpg")
        mock_response = create_mock_response([mock_data])
        mock_openai_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(
            prompt="Transform this image",
            reference_images=["https://example.com/ref.jpg"],
        )

        # Assert
        call_kwargs = mock_openai_client.images.generate.call_args[1]
        assert call_kwargs["extra_body"]["image"] == "https://example.com/ref.jpg"

    @pytest.mark.asyncio
    async def test_generate_with_multiple_reference_images(
        self, provider, mock_openai_client
    ):
        """Test generation with multiple reference images."""
        mock_data = create_mock_image_data(url="https://example.com/result.jpg")
        mock_response = create_mock_response([mock_data])
        mock_openai_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(
            prompt="Combine these images",
            reference_images=[
                "https://example.com/ref1.jpg",
                "https://example.com/ref2.jpg",
            ],
        )

        # Assert
        call_kwargs = mock_openai_client.images.generate.call_args[1]
        assert call_kwargs["extra_body"]["image"] == [
            "https://example.com/ref1.jpg",
            "https://example.com/ref2.jpg",
        ]

    @pytest.mark.asyncio
    async def test_generate_with_sequential_mode(self):
        """Test generation with sequential image generation mode."""
        mock_client = MagicMock()
        mock_client.images = MagicMock()
        mock_client.images.generate = AsyncMock()

        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            provider = SeedreamProvider(
                base_url="https://api.example.com",
                api_key="test-key",
                image_config={
                    "sequential_image_generation": "auto",
                    "max_images": 5,
                },
            )
            provider.client = mock_client

        mock_data = [
            create_mock_image_data(url="https://example.com/img1.jpg"),
            create_mock_image_data(url="https://example.com/img2.jpg"),
            create_mock_image_data(url="https://example.com/img3.jpg"),
        ]
        mock_response = create_mock_response(mock_data)
        mock_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(prompt="Generate multiple images")

        # Assert
        assert len(result.images) == 3

        call_kwargs = mock_client.images.generate.call_args[1]
        assert call_kwargs["extra_body"]["sequential_image_generation"] == "auto"
        assert call_kwargs["extra_body"]["sequential_image_generation_options"] == {
            "max_images": 5
        }

    @pytest.mark.asyncio
    async def test_generate_with_output_format(self):
        """Test generation with output format configuration."""
        mock_client = MagicMock()
        mock_client.images = MagicMock()
        mock_client.images.generate = AsyncMock()

        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            provider = SeedreamProvider(
                base_url="https://api.example.com",
                api_key="test-key",
                image_config={
                    "output_format": "png",
                },
            )
            provider.client = mock_client

        mock_data = create_mock_image_data(url="https://example.com/result.png")
        mock_response = create_mock_response([mock_data])
        mock_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(prompt="Generate PNG image")

        # Assert
        call_kwargs = mock_client.images.generate.call_args[1]
        assert call_kwargs["extra_body"]["output_format"] == "png"

    @pytest.mark.asyncio
    async def test_generate_with_prompt_optimization(self):
        """Test generation with prompt optimization mode."""
        mock_client = MagicMock()
        mock_client.images = MagicMock()
        mock_client.images.generate = AsyncMock()

        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            provider = SeedreamProvider(
                base_url="https://api.example.com",
                api_key="test-key",
                image_config={
                    "optimize_prompt_mode": "fast",
                },
            )
            provider.client = mock_client

        mock_data = create_mock_image_data(url="https://example.com/result.jpg")
        mock_response = create_mock_response([mock_data])
        mock_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(prompt="Test prompt")

        # Assert
        call_kwargs = mock_client.images.generate.call_args[1]
        assert call_kwargs["extra_body"]["optimize_prompt_options"] == {"mode": "fast"}

    @pytest.mark.asyncio
    async def test_generate_with_base64_response(self, provider, mock_openai_client):
        """Test generation with base64 response format."""
        mock_data = create_mock_image_data(
            b64_json="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        )
        mock_response = create_mock_response([mock_data])
        mock_openai_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(prompt="Test")

        # Assert
        assert len(result.images) == 1
        assert result.images[0].url is None
        assert result.images[0].b64_json is not None
        assert result.images[0].size == "2048x2048"

    @pytest.mark.asyncio
    async def test_generate_handles_empty_data(self, provider, mock_openai_client):
        """Test handling of empty data array in response."""
        mock_response = create_mock_response([])
        mock_openai_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(prompt="Test")

        # Assert
        assert len(result.images) == 0

    @pytest.mark.asyncio
    async def test_generate_api_error(self, provider, mock_openai_client):
        """Test handling of API error response."""
        mock_openai_client.images.generate.side_effect = APIConnectionError(
            request=MagicMock()
        )

        # Act & Assert
        with pytest.raises(APIConnectionError):
            await provider.generate(prompt="Test")

    @pytest.mark.asyncio
    async def test_generate_timeout(self, provider, mock_openai_client):
        """Test handling of request timeout."""
        mock_openai_client.images.generate.side_effect = APITimeoutError(
            request=MagicMock()
        )

        # Act & Assert
        with pytest.raises(APITimeoutError):
            await provider.generate(prompt="Test")

    @pytest.mark.asyncio
    async def test_generate_uses_custom_model(self):
        """Test that custom model name is used in request."""
        mock_client = MagicMock()
        mock_client.images = MagicMock()
        mock_client.images.generate = AsyncMock()

        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            provider = SeedreamProvider(
                base_url="https://api.example.com",
                api_key="test-key",
                model="doubao-seedream-4.5",
            )
            provider.client = mock_client

        mock_data = create_mock_image_data(url="https://example.com/result.jpg")
        mock_response = create_mock_response([mock_data], model="doubao-seedream-4.5")
        mock_client.images.generate.return_value = mock_response

        # Act
        result = await provider.generate(prompt="Test")

        # Assert
        call_kwargs = mock_client.images.generate.call_args[1]
        assert call_kwargs["model"] == "doubao-seedream-4.5"
        assert result.model == "doubao-seedream-4.5"


class TestGetImageProvider:
    """Tests for get_image_provider factory function."""

    def test_get_seedream_provider(self):
        """Test getting Seedream provider."""
        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers import get_image_provider
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            model_config = {
                "base_url": "https://api.example.com",
                "api_key": "test-key",
                "imageConfig": {"size": "2048x2048"},
            }

            provider = get_image_provider("seedream", model_config)

            assert isinstance(provider, SeedreamProvider)
            assert provider.base_url == "https://api.example.com"
            assert provider.api_key == "test-key"

    def test_get_openai_compatible_provider(self):
        """Test getting provider with openai protocol (uses Seedream)."""
        with patch(
            "app.services.execution.agents.image.providers.seedream.AsyncOpenAI"
        ):
            from app.services.execution.agents.image.providers import get_image_provider
            from app.services.execution.agents.image.providers.seedream import (
                SeedreamProvider,
            )

            model_config = {
                "base_url": "https://api.example.com",
                "api_key": "test-key",
            }

            provider = get_image_provider("openai", model_config)

            assert isinstance(provider, SeedreamProvider)

    def test_get_unknown_provider_raises_error(self):
        """Test that unknown provider raises ValueError."""
        from app.services.execution.agents.image.providers import get_image_provider

        with pytest.raises(ValueError, match="Unknown image provider"):
            get_image_provider("unknown_provider", {})
