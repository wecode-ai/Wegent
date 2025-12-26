# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the context constants module."""

import pytest

from app.services.chat_v2.context.constants import (
    DEFAULT_CONTEXT_LIMITS,
    DEFAULT_RESERVED_OUTPUT_RATIO,
    get_default_context_limit,
)


class TestContextConstants:
    """Tests for context constants."""

    def test_default_context_limits_has_common_models(self):
        """Test that DEFAULT_CONTEXT_LIMITS includes common models."""
        assert "claude-3-5-sonnet-20241022" in DEFAULT_CONTEXT_LIMITS
        assert "gpt-4" in DEFAULT_CONTEXT_LIMITS
        assert "gpt-4o" in DEFAULT_CONTEXT_LIMITS
        assert "deepseek-chat" in DEFAULT_CONTEXT_LIMITS
        assert "default" in DEFAULT_CONTEXT_LIMITS

    def test_default_context_limits_values_are_positive(self):
        """Test that all context limits are positive integers."""
        for model, limit in DEFAULT_CONTEXT_LIMITS.items():
            assert isinstance(limit, int)
            assert limit > 0

    def test_default_reserved_output_ratio(self):
        """Test that DEFAULT_RESERVED_OUTPUT_RATIO is valid."""
        assert 0 < DEFAULT_RESERVED_OUTPUT_RATIO < 1
        assert DEFAULT_RESERVED_OUTPUT_RATIO == 0.2


class TestGetDefaultContextLimit:
    """Tests for get_default_context_limit function."""

    def test_exact_match(self):
        """Test exact model name match."""
        assert get_default_context_limit("gpt-4") == 8192
        assert get_default_context_limit("gpt-4o") == 128000

    def test_prefix_match_claude(self):
        """Test prefix matching for Claude models."""
        assert get_default_context_limit("claude-3-5-sonnet-20241022") == 200000
        assert get_default_context_limit("claude-some-new-model") == 200000

    def test_prefix_match_gpt4(self):
        """Test prefix matching for GPT-4 models."""
        assert get_default_context_limit("gpt-4-turbo-2024-01") == 128000
        assert get_default_context_limit("gpt-4o-mini-2024-01") == 128000

    def test_prefix_match_gpt35(self):
        """Test prefix matching for GPT-3.5 models."""
        assert get_default_context_limit("gpt-3.5-turbo-0125") == 16385

    def test_prefix_match_deepseek(self):
        """Test prefix matching for DeepSeek models."""
        assert get_default_context_limit("deepseek-new-model") == 64000

    def test_prefix_match_gemini(self):
        """Test prefix matching for Gemini models."""
        assert get_default_context_limit("gemini-1.5-pro-002") == 1000000
        assert get_default_context_limit("gemini-pro-vision") == 32000

    def test_unknown_model_returns_default(self):
        """Test that unknown models return the default value."""
        assert get_default_context_limit("unknown-model") == DEFAULT_CONTEXT_LIMITS["default"]
        assert get_default_context_limit("some-random-model-xyz") == DEFAULT_CONTEXT_LIMITS["default"]
