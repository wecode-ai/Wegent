# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for LLM Provider factory.
"""

from unittest.mock import MagicMock

import pytest

from app.services.chat.providers.claude import ClaudeProvider
from app.services.chat.providers.factory import get_provider
from app.services.chat.providers.gemini import GeminiProvider
from app.services.chat.providers.openai import OpenAIProvider


@pytest.fixture
def mock_client():
    """Create a mock HTTP client for testing."""
    return MagicMock()


class TestGetProvider:
    """Tests for get_provider function."""

    def test_get_provider_openai_default(self, mock_client):
        """Test that OpenAI provider is returned by default."""
        model_config = {
            "api_key": "test-key",
            "base_url": "https://api.openai.com/v1",
            "model_id": "gpt-4",
        }

        provider = get_provider(model_config, mock_client)

        assert isinstance(provider, OpenAIProvider)
        assert provider.config.api_key == "test-key"
        assert provider.config.base_url == "https://api.openai.com/v1"
        assert provider.config.model_id == "gpt-4"

    def test_get_provider_openai_explicit(self, mock_client):
        """Test that OpenAI provider is returned when explicitly specified."""
        model_config = {
            "model": "openai",
            "api_key": "test-key",
            "base_url": "https://api.openai.com/v1",
            "model_id": "gpt-4-turbo",
        }

        provider = get_provider(model_config, mock_client)

        assert isinstance(provider, OpenAIProvider)
        assert provider.config.model_id == "gpt-4-turbo"

    def test_get_provider_claude(self, mock_client):
        """Test that Claude provider is returned for claude model type."""
        model_config = {
            "model": "claude",
            "api_key": "test-anthropic-key",
            "base_url": "https://api.anthropic.com",
            "model_id": "claude-3-opus-20240229",
        }

        provider = get_provider(model_config, mock_client)

        assert isinstance(provider, ClaudeProvider)
        assert provider.config.api_key == "test-anthropic-key"
        assert provider.config.base_url == "https://api.anthropic.com"
        assert provider.config.model_id == "claude-3-opus-20240229"

    def test_get_provider_gemini(self, mock_client):
        """Test that Gemini provider is returned for gemini model type."""
        model_config = {
            "model": "gemini",
            "api_key": "test-google-key",
            "base_url": "https://generativelanguage.googleapis.com",
            "model_id": "gemini-pro",
        }

        provider = get_provider(model_config, mock_client)

        assert isinstance(provider, GeminiProvider)
        assert provider.config.api_key == "test-google-key"
        assert provider.config.base_url == "https://generativelanguage.googleapis.com"
        assert provider.config.model_id == "gemini-pro"

    def test_get_provider_with_default_headers(self, mock_client):
        """Test that default headers are passed to provider config."""
        model_config = {
            "model": "openai",
            "api_key": "test-key",
            "base_url": "https://api.openai.com/v1",
            "model_id": "gpt-4",
            "default_headers": {"X-Custom-Header": "custom-value"},
        }

        provider = get_provider(model_config, mock_client)

        assert provider.config.default_headers == {"X-Custom-Header": "custom-value"}

    def test_get_provider_with_empty_config(self, mock_client):
        """Test provider creation with minimal/empty config uses defaults."""
        model_config = {}

        provider = get_provider(model_config, mock_client)

        assert isinstance(provider, OpenAIProvider)
        assert provider.config.api_key == ""
        assert provider.config.base_url == ""
        assert provider.config.model_id == "gpt-4"
        assert provider.config.default_headers == {}

    def test_get_provider_base_url_from_config(self, mock_client):
        """Test that base_url is correctly extracted from model_config.

        This test ensures the fix for NameError: name 'base_url' is not defined.
        The base_url should be read from model_config.get('base_url'), not from
        an undefined variable.
        """
        model_config = {
            "api_key": "test-key",
            "base_url": "https://custom-api.example.com/v1",
            "model_id": "custom-model",
        }

        provider = get_provider(model_config, mock_client)

        assert provider.config.base_url == "https://custom-api.example.com/v1"

    def test_get_provider_unknown_model_type_defaults_to_openai(self, mock_client):
        """Test that unknown model types default to OpenAI provider."""
        model_config = {
            "model": "unknown-provider",
            "api_key": "test-key",
            "base_url": "https://api.example.com",
            "model_id": "some-model",
        }

        provider = get_provider(model_config, mock_client)

        assert isinstance(provider, OpenAIProvider)
