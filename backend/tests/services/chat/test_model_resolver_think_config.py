# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for model_resolver - thinking_config and temperature extraction.

Tests that _extract_model_config correctly extracts thinking_config and
temperature from spec.modelConfig.env (the single source of truth).
"""

from unittest.mock import patch

import pytest

from app.services.chat.config.model_resolver import _extract_model_config

# All tests mock decrypt_api_key to avoid encryption dependency
_DECRYPT_PATCH = patch(
    "app.services.chat.config.model_resolver.decrypt_api_key",
    side_effect=lambda k: k,
)


def _make_spec(**env_overrides) -> dict:
    """Build a minimal model spec dict with optional env overrides."""
    env = {
        "api_key": "sk-test",
        "base_url": "https://api.example.com/v1",
        "model_id": "gpt-4",
        "model": "openai",
        **env_overrides,
    }
    return {"modelConfig": {"env": env}}


class TestExtractThinkingConfig:
    """Tests for thinking_config extraction from env."""

    @_DECRYPT_PATCH
    def test_snake_case_key(self, _decrypt):
        """thinking_config in env (snake_case) → extracted."""
        spec = _make_spec(thinking_config={"reasoning_effort": "medium"})
        result = _extract_model_config(spec)
        assert result["think_config"] == {"reasoning_effort": "medium"}

    @_DECRYPT_PATCH
    def test_camel_case_key(self, _decrypt):
        """thinkingConfig in env (camelCase) → extracted."""
        spec = _make_spec(thinkingConfig={"thinking": {"type": "enabled"}})
        result = _extract_model_config(spec)
        assert result["think_config"] == {"thinking": {"type": "enabled"}}

    @_DECRYPT_PATCH
    def test_snake_case_takes_priority(self, _decrypt):
        """When both keys exist in env, thinking_config (snake) wins."""
        spec = _make_spec(
            thinking_config={"reasoning_effort": "high"},
            thinkingConfig={"reasoning_effort": "low"},
        )
        result = _extract_model_config(spec)
        assert result["think_config"] == {"reasoning_effort": "high"}

    @_DECRYPT_PATCH
    def test_absent(self, _decrypt):
        """No thinking_config in env → None."""
        spec = _make_spec()
        result = _extract_model_config(spec)
        assert result["think_config"] is None

    @_DECRYPT_PATCH
    def test_complex_object(self, _decrypt):
        """Complex nested config → preserved as-is."""
        tc = {"thinking": {"type": "enabled", "budget_tokens": 10000}}
        spec = _make_spec(thinking_config=tc)
        result = _extract_model_config(spec)
        assert result["think_config"] == tc

    @_DECRYPT_PATCH
    def test_spec_level_thinkingConfig_ignored(self, _decrypt):
        """spec.thinkingConfig (outside env) is ignored."""
        spec = _make_spec()
        spec["thinkingConfig"] = {"reasoning_effort": "high"}
        result = _extract_model_config(spec)
        assert result["think_config"] is None


class TestExtractTemperature:
    """Tests for temperature extraction from env."""

    @_DECRYPT_PATCH
    def test_temperature_extracted(self, _decrypt):
        """temperature in env → extracted as number."""
        spec = _make_spec(temperature=0.7)
        result = _extract_model_config(spec)
        assert result["temperature"] == 0.7

    @_DECRYPT_PATCH
    def test_temperature_zero(self, _decrypt):
        """temperature=0 in env → extracted (not treated as falsy)."""
        spec = _make_spec(temperature=0)
        result = _extract_model_config(spec)
        assert result["temperature"] == 0

    @_DECRYPT_PATCH
    def test_temperature_absent(self, _decrypt):
        """No temperature in env → None."""
        spec = _make_spec()
        result = _extract_model_config(spec)
        assert result["temperature"] is None
