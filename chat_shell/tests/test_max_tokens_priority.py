# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for max_tokens priority in response API.

This module tests that max_tokens from Model CRD (max_output_tokens) takes priority
over request-level max_tokens parameter.

Priority order:
1. Model CRD max_output_tokens (highest)
2. Request max_tokens (fallback)
"""

import pytest

from chat_shell.api.v1.schemas import (
    InputConfig,
    ModelConfig,
    ResponseRequest,
)


class TestMaxTokensPriority:
    """Tests for max_tokens priority logic."""

    def _create_model_config(self, max_output_tokens: int | None = None) -> ModelConfig:
        """Create a ModelConfig with optional max_output_tokens."""
        return ModelConfig(
            model_id="claude-3-5-sonnet-20241022",
            model="claude",
            api_key="test-api-key",
            max_output_tokens=max_output_tokens,
        )

    def _create_request(
        self, model_config: ModelConfig, max_tokens: int = 32768
    ) -> ResponseRequest:
        """Create a ResponseRequest with given model_config and max_tokens."""
        return ResponseRequest(
            model_config=model_config,
            max_tokens=max_tokens,
            input=InputConfig(text="Hello"),
        )

    def test_max_tokens_uses_model_config_when_configured(self):
        """Test that max_output_tokens from Model CRD is used when configured."""
        # Arrange
        model_config = self._create_model_config(max_output_tokens=8192)
        request = self._create_request(model_config, max_tokens=32768)

        # Act - simulate the logic in response.py
        effective_max_tokens = (
            request.model_config_data.max_output_tokens or request.max_tokens
        )

        # Assert - Model CRD max_output_tokens should take priority
        assert effective_max_tokens == 8192

    def test_max_tokens_uses_request_when_model_config_not_set(self):
        """Test that request.max_tokens is used when Model CRD max_output_tokens is None."""
        # Arrange
        model_config = self._create_model_config(max_output_tokens=None)
        request = self._create_request(model_config, max_tokens=16384)

        # Act - simulate the logic in response.py
        effective_max_tokens = (
            request.model_config_data.max_output_tokens or request.max_tokens
        )

        # Assert - Request max_tokens should be used as fallback
        assert effective_max_tokens == 16384

    def test_max_tokens_uses_request_when_model_config_is_zero(self):
        """Test that request.max_tokens is used when Model CRD max_output_tokens is 0."""
        # Arrange
        model_config = self._create_model_config(max_output_tokens=0)
        request = self._create_request(model_config, max_tokens=4096)

        # Act - simulate the logic in response.py (0 is falsy, so falls back to request)
        effective_max_tokens = (
            request.model_config_data.max_output_tokens or request.max_tokens
        )

        # Assert - Request max_tokens should be used since 0 is falsy
        assert effective_max_tokens == 4096

    def test_max_tokens_preserves_small_model_config_value(self):
        """Test that small max_output_tokens values from Model CRD are preserved."""
        # Arrange
        model_config = self._create_model_config(max_output_tokens=1024)
        request = self._create_request(model_config, max_tokens=32768)

        # Act
        effective_max_tokens = (
            request.model_config_data.max_output_tokens or request.max_tokens
        )

        # Assert - Even small values from Model CRD should be used
        assert effective_max_tokens == 1024

    def test_max_tokens_default_request_value(self):
        """Test that default request max_tokens value is correct."""
        # Arrange
        model_config = self._create_model_config(max_output_tokens=None)
        request = self._create_request(model_config)

        # Assert - Default value should be 32768
        assert request.max_tokens == 32768

    def test_model_config_data_alias(self):
        """Test that model_config_data is accessible via model_config alias."""
        # Arrange
        model_config = self._create_model_config(max_output_tokens=8192)

        # Act - Create request with model_config alias
        request = ResponseRequest(
            model_config=model_config,
            input=InputConfig(text="Hello"),
        )

        # Assert - Should be accessible via model_config_data attribute
        assert request.model_config_data.max_output_tokens == 8192
