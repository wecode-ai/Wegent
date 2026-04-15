# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for reasoning config propagation from OpenAPI to ExecutionRequest."""

from unittest.mock import MagicMock, patch

import pytest

from app.schemas.openapi_response import ReasoningConfig, ResponseCreateInput


class TestReasoningConfigSchema:
    """Tests for ReasoningConfig schema."""

    def test_reasoning_config_defaults(self):
        """Test ReasoningConfig with default values."""
        config = ReasoningConfig()
        assert config.effort == "medium"
        assert config.summary == "auto"

    def test_reasoning_config_custom_values(self):
        """Test ReasoningConfig with custom values."""
        config = ReasoningConfig(effort="high", summary="detailed")
        assert config.effort == "high"
        assert config.summary == "detailed"

    def test_reasoning_config_literal_validation(self):
        """Test ReasoningConfig validates literal values."""
        # Valid values
        ReasoningConfig(effort="none")
        ReasoningConfig(effort="minimal")
        ReasoningConfig(effort="low")
        ReasoningConfig(effort="medium")
        ReasoningConfig(effort="high")
        ReasoningConfig(effort="xhigh")
        ReasoningConfig(summary="auto")
        ReasoningConfig(summary="concise")
        ReasoningConfig(summary="detailed")

    def test_reasoning_config_in_response_create_input(self):
        """Test ResponseCreateInput accepts reasoning config."""
        reasoning = ReasoningConfig(effort="high", summary="concise")
        input_data = ResponseCreateInput(
            model="default#my_team",
            input="Hello",
            reasoning=reasoning,
        )
        assert input_data.reasoning.effort == "high"
        assert input_data.reasoning.summary == "concise"

    def test_response_create_input_without_reasoning(self):
        """Test ResponseCreateInput without reasoning config."""
        input_data = ResponseCreateInput(
            model="default#my_team",
            input="Hello",
        )
        assert input_data.reasoning is None


class TestExecutionRequestReasoningConfig:
    """Tests for reasoning_config field in ExecutionRequest."""

    def test_execution_request_has_reasoning_config_field(self):
        """Test ExecutionRequest dataclass has reasoning_config field."""
        from shared.models.execution import ExecutionRequest

        # Create request without reasoning_config
        request = ExecutionRequest()
        assert request.reasoning_config is None

        # Create request with reasoning_config
        request_with_config = ExecutionRequest(
            reasoning_config={"effort": "high", "summary": "detailed"}
        )
        assert request_with_config.reasoning_config == {
            "effort": "high",
            "summary": "detailed",
        }

    def test_execution_request_to_dict_includes_reasoning_config(self):
        """Test ExecutionRequest.to_dict() includes reasoning_config."""
        from shared.models.execution import ExecutionRequest

        request = ExecutionRequest(
            reasoning_config={"effort": "medium", "summary": "auto"}
        )
        data = request.to_dict()
        assert data["reasoning_config"] == {"effort": "medium", "summary": "auto"}

    def test_execution_request_from_dict_preserves_reasoning_config(self):
        """Test ExecutionRequest.from_dict() preserves reasoning_config."""
        from shared.models.execution import ExecutionRequest

        data = {
            "task_id": 1,
            "reasoning_config": {"effort": "low", "summary": "concise"},
        }
        request = ExecutionRequest.from_dict(data)
        assert request.reasoning_config == {"effort": "low", "summary": "concise"}
