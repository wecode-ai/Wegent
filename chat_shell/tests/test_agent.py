# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ChatAgent and related functionality.

This module tests the core agent functionality including:
- Message building with inject_datetime control
- Deep thinking prompt injection
- AgentConfig behavior

Note: Some tests require langchain_core which may not be available in test env.
These are marked with pytest.importorskip.
"""

import pytest

from chat_shell.messages.converter import MessageConverter

# Import directly to avoid __init__.py triggering all dependencies
from chat_shell.prompts.builder import (
    append_deep_thinking_prompt,
    build_system_prompt,
)


class TestDeepThinkingPrompt:
    """Tests for deep thinking prompt injection."""

    def test_append_deep_thinking_prompt_enabled(self):
        """Test deep thinking prompt is appended when enabled."""
        base_prompt = "You are a helpful assistant."
        result = append_deep_thinking_prompt(base_prompt, enable_deep_thinking=True)

        assert base_prompt in result
        assert len(result) > len(base_prompt)

    def test_append_deep_thinking_prompt_disabled(self):
        """Test deep thinking prompt is NOT appended when disabled."""
        base_prompt = "You are a helpful assistant."
        result = append_deep_thinking_prompt(base_prompt, enable_deep_thinking=False)

        assert result == base_prompt

    def test_build_system_prompt_with_deep_thinking(self):
        """Test build_system_prompt includes deep thinking when enabled."""
        base_prompt = "You are helpful."
        result = build_system_prompt(
            base_prompt=base_prompt,
            enable_clarification=False,
            enable_deep_thinking=True,
        )

        assert base_prompt in result
        # Deep thinking prompt should be appended
        assert len(result) > len(base_prompt)

    def test_build_system_prompt_without_deep_thinking(self):
        """Test build_system_prompt does not include deep thinking when disabled."""
        base_prompt = "You are helpful."
        result = build_system_prompt(
            base_prompt=base_prompt,
            enable_clarification=False,
            enable_deep_thinking=False,
        )

        # Result should be same as base prompt (no enhancements when both flags are False)
        # Note: <base_prompt> tag is NOT added here - it's added by Backend's get_bot_system_prompt()
        assert result == base_prompt
        # Should NOT contain deep thinking or clarification prompts
        assert "<deep_thinking_mode>" not in result
        assert "<clarification_mode>" not in result


class TestMessageBuilding:
    """Tests for message building that don't require langchain."""

    def test_datetime_is_injected_when_enabled(self):
        """Test that datetime is injected as system-reminder block when inject_datetime=True."""
        messages = MessageConverter.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="You are helpful.",
            inject_datetime=True,
        )

        user_msg = next((m for m in messages if m["role"] == "user"), None)
        assert user_msg is not None
        content = user_msg["content"]
        # New format: list with system-reminder block
        assert isinstance(content, list)
        all_texts = [b["text"] for b in content if b.get("type") == "text"]
        assert any("<CurrentTime>" in t for t in all_texts)

    def test_datetime_not_injected_when_disabled(self):
        """Test that datetime is NOT injected when inject_datetime=False.

        This is the expected behavior for API calls without wegent_chat_bot.
        """
        messages = MessageConverter.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="You are helpful.",
            inject_datetime=False,
        )

        user_msg = next((m for m in messages if m["role"] == "user"), None)
        assert user_msg is not None
        assert "<CurrentTime>" not in user_msg["content"]
        assert user_msg["content"] == "Hello"


@pytest.mark.skipif(
    not pytest.importorskip("langchain_core", reason="langchain_core not installed"),
    reason="langchain_core not installed",
)
class TestChatAgentBuildMessages:
    """Tests for ChatAgent.build_messages method.

    These tests require langchain_core to be installed.
    """

    def test_build_messages_with_enable_deep_thinking_true(self):
        """Test that datetime is injected as system-reminder block when enable_deep_thinking=True."""
        from chat_shell.agent import AgentConfig, ChatAgent

        agent = ChatAgent()
        config = AgentConfig(
            model_config={"model": "gpt-4"},
            system_prompt="You are helpful.",
            enable_deep_thinking=True,
        )

        messages = agent.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="You are helpful.",
            config=config,
        )

        user_msg = next((m for m in messages if m["role"] == "user"), None)
        assert user_msg is not None
        content = user_msg["content"]
        assert isinstance(content, list)
        all_texts = [b["text"] for b in content if b.get("type") == "text"]
        assert any("<CurrentTime>" in t for t in all_texts)

    def test_build_messages_with_enable_deep_thinking_false(self):
        """Test that datetime is NOT injected when enable_deep_thinking=False.

        This is the expected behavior for API calls without wegent_chat_bot.
        """
        from chat_shell.agent import AgentConfig, ChatAgent

        agent = ChatAgent()
        config = AgentConfig(
            model_config={"model": "gpt-4"},
            system_prompt="You are helpful.",
            enable_deep_thinking=False,
        )

        messages = agent.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="You are helpful.",
            config=config,
        )

        user_msg = next((m for m in messages if m["role"] == "user"), None)
        assert user_msg is not None
        assert "<CurrentTime>" not in user_msg["content"]
        assert user_msg["content"] == "Hello"

    def test_build_messages_explicit_inject_datetime_overrides_config(self):
        """Test that explicit inject_datetime parameter overrides config."""
        from chat_shell.agent import AgentConfig, ChatAgent

        agent = ChatAgent()
        config = AgentConfig(
            model_config={"model": "gpt-4"},
            enable_deep_thinking=True,  # Would normally inject datetime
        )

        # Explicitly disable datetime injection
        messages = agent.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="",
            config=config,
            inject_datetime=False,  # Override
        )

        user_msg = next((m for m in messages if m["role"] == "user"), None)
        assert user_msg is not None
        assert "<CurrentTime>" not in user_msg["content"]

    def test_build_messages_without_config_defaults_to_inject_datetime(self):
        """Test that without config, datetime is injected as system-reminder block by default (backward compatibility)."""
        from chat_shell.agent import ChatAgent

        agent = ChatAgent()

        messages = agent.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="You are helpful.",
            config=None,  # No config
        )

        user_msg = next((m for m in messages if m["role"] == "user"), None)
        assert user_msg is not None
        content = user_msg["content"]
        assert isinstance(content, list)
        all_texts = [b["text"] for b in content if b.get("type") == "text"]
        assert any("<CurrentTime>" in t for t in all_texts)


class TestNeedsExplicitCacheBreakpoints:
    """Tests for ChatAgent._needs_explicit_cache_breakpoints."""

    def test_returns_false_when_no_config(self):
        from chat_shell.agent import AgentConfig, ChatAgent

        assert ChatAgent._needs_explicit_cache_breakpoints(None) is False

    def test_returns_true_for_anthropic_without_auto_cache(self):
        from chat_shell.agent import AgentConfig, ChatAgent

        config = AgentConfig(
            model_config={"model_id": "claude-3-sonnet", "model": "anthropic"}
        )
        assert ChatAgent._needs_explicit_cache_breakpoints(config) is True

    def test_returns_false_for_anthropic_with_auto_cache(self):
        from chat_shell.agent import AgentConfig, ChatAgent

        config = AgentConfig(
            model_config={
                "model_id": "claude-3-sonnet",
                "model": "anthropic",
                "is_support_claude_automatic_caching": True,
            }
        )
        assert ChatAgent._needs_explicit_cache_breakpoints(config) is False

    def test_returns_false_for_openai(self):
        from chat_shell.agent import AgentConfig, ChatAgent

        config = AgentConfig(model_config={"model_id": "gpt-4", "model": "openai"})
        assert ChatAgent._needs_explicit_cache_breakpoints(config) is False

    def test_returns_false_for_google(self):
        from chat_shell.agent import AgentConfig, ChatAgent

        config = AgentConfig(
            model_config={"model_id": "gemini-1.5-pro", "model": "google"}
        )
        assert ChatAgent._needs_explicit_cache_breakpoints(config) is False

    def test_detects_anthropic_by_model_id_prefix(self):
        from chat_shell.agent import AgentConfig, ChatAgent

        config = AgentConfig(
            model_config={"model_id": "claude-3-5-sonnet", "model": ""}
        )
        assert ChatAgent._needs_explicit_cache_breakpoints(config) is True

    def test_detects_anthropic_by_model_type_alias(self):
        from chat_shell.agent import AgentConfig, ChatAgent

        config = AgentConfig(
            model_config={"model_id": "custom-model", "model": "claude"}
        )
        assert ChatAgent._needs_explicit_cache_breakpoints(config) is True
