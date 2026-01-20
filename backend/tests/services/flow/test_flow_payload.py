# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for FlowTriggerPayload schema.
"""

import pytest
from pydantic import ValidationError

from app.schemas.flow import FlowTriggerPayload


class TestFlowTriggerPayload:
    """Test FlowTriggerPayload schema defaults and validation."""

    def test_default_values(self):
        """Test that FlowTriggerPayload has correct default values."""
        payload = FlowTriggerPayload()

        assert payload.force_override_bot_model is None
        assert payload.enable_clarification is False
        assert payload.enable_deep_thinking is True
        assert payload.is_group_chat is False
        assert payload.enable_web_search is False
        assert payload.search_engine is None
        assert payload.preload_skills is None

    def test_custom_values(self):
        """Test that FlowTriggerPayload accepts custom values."""
        payload = FlowTriggerPayload(
            force_override_bot_model="gpt-4",
            enable_clarification=True,
            enable_deep_thinking=False,
            is_group_chat=True,
            enable_web_search=True,
            search_engine="google",
            preload_skills=["skill1", "skill2"],
        )

        assert payload.force_override_bot_model == "gpt-4"
        assert payload.enable_clarification is True
        assert payload.enable_deep_thinking is False
        assert payload.is_group_chat is True
        assert payload.enable_web_search is True
        assert payload.search_engine == "google"
        assert payload.preload_skills == ["skill1", "skill2"]

    def test_partial_values(self):
        """Test that FlowTriggerPayload allows partial initialization."""
        payload = FlowTriggerPayload(
            enable_web_search=True,
            search_engine="bing",
        )

        # Custom values
        assert payload.enable_web_search is True
        assert payload.search_engine == "bing"

        # Default values
        assert payload.force_override_bot_model is None
        assert payload.enable_clarification is False
        assert payload.enable_deep_thinking is True
        assert payload.is_group_chat is False
        assert payload.preload_skills is None

    def test_serialization(self):
        """Test that FlowTriggerPayload can be serialized to dict."""
        payload = FlowTriggerPayload(
            enable_deep_thinking=True,
            preload_skills=["code_review"],
        )

        payload_dict = payload.model_dump()

        assert isinstance(payload_dict, dict)
        assert payload_dict["enable_deep_thinking"] is True
        assert payload_dict["preload_skills"] == ["code_review"]
        assert payload_dict["force_override_bot_model"] is None

    def test_empty_preload_skills(self):
        """Test that preload_skills can be empty list."""
        payload = FlowTriggerPayload(preload_skills=[])

        assert payload.preload_skills == []
