# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for LangChain model factory - think_config and provider detection.

Tests the think_config extraction logic (_extract_think_params),
provider detection (_detect_provider), and integration of think_config
into create_from_config.
"""

from unittest.mock import MagicMock, patch

import pytest
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI

from chat_shell.models.factory import (
    LangChainModelFactory,
    _detect_provider,
    _extract_think_params,
)
from chat_shell.models.openai_reasoning import ChatOpenAIWithReasoning

# ---------------------------------------------------------------------------
# _extract_think_params
# ---------------------------------------------------------------------------


class TestExtractThinkParams:
    """Tests for _extract_think_params function."""

    # -- Anthropic provider --

    def test_anthropic_thinking_enabled(self):
        """Anthropic: standard extended thinking config."""
        result = _extract_think_params(
            "anthropic",
            {
                "thinking": {"type": "enabled", "budget_tokens": 10000},
            },
        )
        assert result == {"thinking": {"type": "enabled", "budget_tokens": 10000}}

    def test_anthropic_effort(self):
        """Anthropic: effort param is whitelisted."""
        result = _extract_think_params("anthropic", {"effort": "high"})
        assert result == {"effort": "high"}

    def test_anthropic_ignores_unknown_keys(self):
        """Anthropic: keys not in whitelist are silently dropped."""
        result = _extract_think_params(
            "anthropic",
            {
                "thinking": {"type": "enabled", "budget_tokens": 5000},
                "reasoning_effort": "high",  # not an Anthropic key
            },
        )
        assert result == {"thinking": {"type": "enabled", "budget_tokens": 5000}}
        assert "reasoning_effort" not in result

    # -- OpenAI provider --

    def test_openai_reasoning_effort(self):
        """OpenAI Chat Completions: only reasoning_effort is whitelisted."""
        result = _extract_think_params("openai", {"reasoning_effort": "medium"})
        assert result == {"reasoning_effort": "medium"}

    def test_openai_reasoning_dict_goes_to_extra_body(self):
        """OpenAI/OpenRouter: reasoning dict goes to extra_body to avoid
        implicitly activating the Responses API format in langchain."""
        result = _extract_think_params(
            "openai",
            {
                "reasoning": {"effort": "high", "summary": "auto"},
            },
        )
        assert result == {
            "extra_body": {"reasoning": {"effort": "high", "summary": "auto"}}
        }

    def test_openai_unknown_keys_go_to_extra_body(self):
        """OpenAI-compatible (Kimi): unknown keys go into extra_body."""
        result = _extract_think_params(
            "openai",
            {
                "thinking": {"type": "enabled"},
            },
        )
        assert result == {"extra_body": {"thinking": {"type": "enabled"}}}

    def test_openai_mixed_known_and_unknown(self):
        """OpenAI: mix of whitelisted + unknown keys."""
        result = _extract_think_params(
            "openai",
            {
                "reasoning_effort": "medium",
                "thinking": {"type": "enabled"},
            },
        )
        assert result["reasoning_effort"] == "medium"
        assert result["extra_body"] == {"thinking": {"type": "enabled"}}

    def test_openai_reasoning_and_effort_mixed(self):
        """OpenAI: reasoning dict + reasoning_effort → both handled correctly."""
        result = _extract_think_params(
            "openai",
            {
                "reasoning_effort": "medium",
                "reasoning": {"effort": "high"},
            },
        )
        assert result["reasoning_effort"] == "medium"
        assert result["extra_body"] == {"reasoning": {"effort": "high"}}

    # -- Google provider --

    def test_google_thinking_level(self):
        """Google Gemini: thinking_level is whitelisted."""
        result = _extract_think_params("google", {"thinking_level": "high"})
        assert result == {"thinking_level": "high"}

    def test_google_thinking_budget(self):
        """Google Gemini: thinking_budget is whitelisted."""
        result = _extract_think_params("google", {"thinking_budget": 8192})
        assert result == {"thinking_budget": 8192}

    def test_google_ignores_unknown_keys(self):
        """Google: unknown keys are silently dropped (no extra_body)."""
        result = _extract_think_params(
            "google",
            {
                "thinking_level": "high",
                "reasoning_effort": "medium",
            },
        )
        assert result == {"thinking_level": "high"}

    # -- Unknown / edge cases --

    def test_unknown_provider_drops_all(self):
        """Unknown provider: all keys are dropped (no whitelist, not openai)."""
        result = _extract_think_params("deepseek", {"reasoning_effort": "high"})
        assert result == {}

    def test_none_config_returns_empty(self):
        """None think_config returns empty dict."""
        assert _extract_think_params("anthropic", None) == {}

    def test_empty_config_returns_empty(self):
        """Empty dict think_config returns empty dict."""
        assert _extract_think_params("openai", {}) == {}


# ---------------------------------------------------------------------------
# _detect_provider
# ---------------------------------------------------------------------------


class TestDetectProvider:
    """Tests for _detect_provider function."""

    def test_model_type_alias(self):
        assert _detect_provider("openai", "anything") == "openai"
        assert _detect_provider("gpt", "anything") == "openai"
        assert _detect_provider("anthropic", "anything") == "anthropic"
        assert _detect_provider("claude", "anything") == "anthropic"
        assert _detect_provider("google", "anything") == "google"
        assert _detect_provider("gemini", "anything") == "google"

    def test_unknown_model_type_defaults_to_openai(self):
        """Unknown model_type always defaults to openai (no model_id fallback)."""
        assert _detect_provider("unknown", "gpt-4o") == "openai"
        assert _detect_provider("unknown", "claude-3-sonnet") == "openai"
        assert _detect_provider("unknown", "gemini-1.5-pro") == "openai"
        assert _detect_provider("unknown", "kimi-k2.5") == "openai"
        assert _detect_provider("unknown", "deepseek-chat") == "openai"


# ---------------------------------------------------------------------------
# LangChainModelFactory.create_from_config with think_config
# ---------------------------------------------------------------------------


class TestCreateFromConfigThinkConfig:
    """Tests for think_config integration in create_from_config."""

    @staticmethod
    def _base_config(provider="openai", model_id="gpt-4", **overrides):
        cfg = {
            "model_id": model_id,
            "model": provider,
            "api_key": "sk-test-key-1234567890",
            "base_url": "https://api.example.com/v1",
            **overrides,
        }
        return cfg

    # -- OpenAI with reasoning_effort --

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_openai_reasoning_effort_creates_reasoning_wrapper(self, _span):
        """OpenAI + think_config → ChatOpenAIWithReasoning instance."""
        config = self._base_config(think_config={"reasoning_effort": "medium"})
        model = LangChainModelFactory.create_from_config(config)
        assert isinstance(model, ChatOpenAIWithReasoning)
        assert model.reasoning_effort == "medium"

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_openai_no_think_config_creates_base_class(self, _span):
        """OpenAI without think_config → regular ChatOpenAI."""
        config = self._base_config()
        model = LangChainModelFactory.create_from_config(config)
        assert type(model) is ChatOpenAI

    # -- OpenRouter / OpenAI-compatible with reasoning dict --

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_openrouter_reasoning_goes_to_extra_body(self, _span):
        """OpenRouter reasoning config → extra_body, keeps Chat Completions format."""
        config = self._base_config(
            base_url="https://openrouter.ai/api/v1",
            think_config={"reasoning": {"effort": "high"}},
        )
        model = LangChainModelFactory.create_from_config(config)
        assert isinstance(model, ChatOpenAIWithReasoning)
        # reasoning dict goes to extra_body, NOT as a direct param
        assert model.extra_body == {"reasoning": {"effort": "high"}}
        # Verify it does NOT implicitly use Responses API
        assert model.reasoning is None

    # -- OpenAI-compatible (Kimi) with extra_body --

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_kimi_thinking_goes_to_extra_body(self, _span):
        """Kimi K2.5 thinking config → extra_body passthrough."""
        config = self._base_config(
            model_id="kimi-k2.5",
            think_config={"thinking": {"type": "enabled"}},
        )
        model = LangChainModelFactory.create_from_config(config)
        assert isinstance(model, ChatOpenAIWithReasoning)
        # Kimi's unknown keys go to extra_body
        assert model.extra_body == {"thinking": {"type": "enabled"}}

    # -- Anthropic with thinking --

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_anthropic_thinking_forces_temperature_1(self, _span):
        """Anthropic + thinking → temperature forced to 1.0."""
        config = self._base_config(
            provider="anthropic",
            model_id="claude-3-sonnet",
            think_config={"thinking": {"type": "enabled", "budget_tokens": 10000}},
        )
        model = LangChainModelFactory.create_from_config(config, temperature=0.7)
        assert isinstance(model, ChatAnthropic)
        assert model.temperature == 1.0

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_anthropic_no_thinking_keeps_temperature(self, _span):
        """Anthropic without thinking → user's temperature preserved."""
        config = self._base_config(
            provider="anthropic",
            model_id="claude-3-sonnet",
        )
        model = LangChainModelFactory.create_from_config(config, temperature=0.5)
        assert isinstance(model, ChatAnthropic)
        assert model.temperature == 0.5

    # -- Google with thinking_level --

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_google_thinking_level(self, _span):
        """Google Gemini + thinking_level → applied to model."""
        config = self._base_config(
            provider="google",
            model_id="gemini-2.5-pro",
            think_config={"thinking_level": "high"},
        )
        model = LangChainModelFactory.create_from_config(config)
        assert isinstance(model, ChatGoogleGenerativeAI)

    # -- Empty / None think_config --

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_none_think_config_no_effect(self, _span):
        """None think_config → no reasoning wrapper, no extra params."""
        config = self._base_config(think_config=None)
        model = LangChainModelFactory.create_from_config(config)
        assert type(model) is ChatOpenAI

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_empty_think_config_no_effect(self, _span):
        """Empty dict think_config → no reasoning wrapper, no extra params."""
        config = self._base_config(think_config={})
        model = LangChainModelFactory.create_from_config(config)
        assert type(model) is ChatOpenAI


# ---------------------------------------------------------------------------
# Temperature from model_config
# ---------------------------------------------------------------------------


class TestCreateFromConfigTemperature:
    """Tests for temperature from model_config in create_from_config."""

    @staticmethod
    def _base_config(provider="openai", model_id="gpt-4", **overrides):
        return {
            "model_id": model_id,
            "model": provider,
            "api_key": "sk-test-key-1234567890",
            "base_url": "https://api.example.com/v1",
            **overrides,
        }

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_openai_temperature_from_config(self, _span):
        """OpenAI: temperature from model_config applied."""
        config = self._base_config(temperature=0.3)
        model = LangChainModelFactory.create_from_config(config)
        assert model.temperature == 0.3

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_anthropic_temperature_from_config(self, _span):
        """Anthropic: temperature from model_config applied."""
        config = self._base_config(
            provider="anthropic", model_id="claude-3-sonnet", temperature=0.5
        )
        model = LangChainModelFactory.create_from_config(config)
        assert model.temperature == 0.5

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_google_temperature_from_config(self, _span):
        """Google: temperature from model_config applied."""
        config = self._base_config(
            provider="google", model_id="gemini-2.5-pro", temperature=0.8
        )
        model = LangChainModelFactory.create_from_config(config)
        assert model.temperature == 0.8

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_config_temperature_overrides_kwargs(self, _span):
        """model_config temperature takes priority over kwargs temperature."""
        config = self._base_config(temperature=0.2)
        model = LangChainModelFactory.create_from_config(config, temperature=0.9)
        assert model.temperature == 0.2

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_no_config_temperature_uses_kwargs(self, _span):
        """No model_config temperature → kwargs temperature used."""
        config = self._base_config()
        model = LangChainModelFactory.create_from_config(config, temperature=0.6)
        assert model.temperature == 0.6

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_no_temperature_anywhere_uses_provider_default(self, _span):
        """No temperature → not passed to constructor, provider uses its own default."""
        config = self._base_config()
        model = LangChainModelFactory.create_from_config(config)
        # When no temperature is configured, it's not passed to the LLM constructor,
        # so the provider class uses its own default (ChatOpenAI defaults to None)
        assert model.temperature is None

    @patch("chat_shell.models.factory.add_span_event")
    @patch("chat_shell.models.factory.trace_sync", lambda **kw: lambda fn: fn)
    def test_anthropic_thinking_overrides_config_temperature(self, _span):
        """Anthropic thinking mode forces temperature=1.0 even with config temperature."""
        config = self._base_config(
            provider="anthropic",
            model_id="claude-3-sonnet",
            temperature=0.3,
            think_config={"thinking": {"type": "enabled", "budget_tokens": 10000}},
        )
        model = LangChainModelFactory.create_from_config(config)
        assert model.temperature == 1.0
