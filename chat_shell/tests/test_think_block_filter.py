# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for think_block_filter module."""

import pytest

from chat_shell.messages.think_block_filter import (
    _infer_provider,
    strip_foreign_reasoning_blocks,
)


class TestStripForeignReasoningBlocks:
    """Tests for strip_foreign_reasoning_blocks."""

    def test_same_provider_preserves_reasoning(self):
        """Anthropic same-provider reasoning blocks are denormalized to thinking format."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "thinking...",
                        "extras": {"signature": "abc"},
                    },
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "anthropic", "model": "claude-sonnet"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        content = result[0]["content"]
        assert content[0] == {
            "type": "thinking",
            "thinking": "thinking...",
            "signature": "abc",
        }
        assert content[1] == {"type": "text", "text": "answer"}

    def test_cross_provider_strips_reasoning(self):
        """Reasoning blocks from a different provider are removed."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "thinking..."},
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "anthropic", "model": "claude-sonnet"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert result[0]["content"] == [{"type": "text", "text": "answer"}]

    def test_user_messages_untouched(self):
        """Non-assistant messages are passed through without modification."""
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "system", "content": "You are a bot"},
        ]
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert result == messages

    def test_no_think_blocks_untouched(self):
        """Messages without reasoning blocks are passed through."""
        messages = [
            {
                "role": "assistant",
                "content": "plain text",
                "model_info": {"provider": "anthropic", "model": "claude"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert result == messages

    def test_all_reasoning_stripped_becomes_empty_text_block(self):
        """If all content blocks are reasoning, content becomes an empty text block."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "only thinking"},
                ],
                "model_info": {"provider": "anthropic", "model": "claude"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert result[0]["content"] == [{"type": "text", "text": ""}]

    def test_legacy_anthropic_thinking_blocks_inferred(self):
        """Legacy Claude thinking blocks (no model_info) are detected heuristically."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "old format"},
                    {"type": "text", "text": "answer"},
                ],
            },
        ]
        # Same provider (anthropic inferred) -> keep
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        assert len(result[0]["content"]) == 2

        # Different provider -> strip
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert result[0]["content"] == [{"type": "text", "text": "answer"}]

    def test_legacy_reasoning_content_in_additional_kwargs(self):
        """Legacy additional_kwargs.reasoning_content is detected and stripped."""
        messages = [
            {
                "role": "assistant",
                "content": "answer",
                "additional_kwargs": {"reasoning_content": "deep thinking"},
            },
        ]
        # Inferred as openai -> same provider keeps it
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert "additional_kwargs" in result[0]

        # Different provider -> strip
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        assert "additional_kwargs" not in result[0]

    def test_mixed_history_selective_stripping(self):
        """Mixed provider history: cross-provider reasoning stripped, same-provider denormalized."""
        messages = [
            {"role": "user", "content": "Q1"},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "claude thought",
                        "extras": {"signature": "sig1"},
                    },
                    {"type": "text", "text": "A1"},
                ],
                "model_info": {"provider": "anthropic", "model": "claude"},
            },
            {"role": "user", "content": "Q2"},
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "gpt thought"},
                    {"type": "text", "text": "A2"},
                ],
                "model_info": {"provider": "openai", "model": "gpt-5"},
            },
        ]
        # Target is openai: claude reasoning stripped, gpt reasoning kept
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert result[1]["content"] == [{"type": "text", "text": "A1"}]
        assert len(result[3]["content"]) == 2  # both blocks preserved

        # Target is anthropic: claude reasoning denormalized to thinking, gpt stripped
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        assert result[1]["content"][0] == {
            "type": "thinking",
            "thinking": "claude thought",
            "signature": "sig1",
        }
        assert result[3]["content"] == [{"type": "text", "text": "A2"}]

    def test_original_messages_not_mutated(self):
        """The original message dicts are not modified in-place."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "thinking"},
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "anthropic", "model": "claude"},
            },
        ]
        original_content = list(messages[0]["content"])
        strip_foreign_reasoning_blocks(messages, "openai")
        assert messages[0]["content"] == original_content

    def test_unknown_provider_no_model_info_no_reasoning(self):
        """Messages without model_info and without reasoning are passed through."""
        messages = [
            {"role": "assistant", "content": "plain answer"},
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        assert result == messages

    def test_anthropic_same_provider_sets_response_metadata(self):
        """Denormalized Anthropic messages include response_metadata for LangChain."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "thought",
                        "extras": {"signature": "sig"},
                    },
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "anthropic", "model": "claude"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        # response_metadata is injected as top-level key for convert_to_messages
        assert result[0]["response_metadata"] == {"model_provider": "anthropic"}

    def test_anthropic_same_provider_does_not_mutate_original(self):
        """Denormalization creates a deep copy, original is untouched."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "thought",
                        "extras": {"signature": "sig"},
                    },
                ],
                "model_info": {"provider": "anthropic", "model": "claude"},
            },
        ]
        original_content = list(messages[0]["content"])
        strip_foreign_reasoning_blocks(messages, "anthropic")
        assert messages[0]["content"] == original_content
        assert "response_metadata" not in messages[0]

    def test_non_anthropic_same_provider_passes_through(self):
        """Non-Anthropic same-provider messages without Responses API extras are not denormalized."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "thinking"},
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "openai", "model": "gpt-5"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "openai")
        # Plain reasoning blocks (no extras.id) pass through unchanged
        assert result[0]["content"][0]["type"] == "reasoning"
        assert result[0]["content"][0].get("reasoning") == "thinking"
        assert "additional_kwargs" not in result[0]

    def test_openai_same_provider_denormalizes_reasoning(self):
        """OpenAI same-provider reasoning blocks with Responses API extras are reconstructed."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "I considered the options...",
                        "extras": {
                            "id": "rs_abc123",
                            "encrypted_content": "gAAAA_encrypted_data",
                            "index": 0,
                        },
                    },
                    {
                        "id": "msg_xyz789",
                        "type": "text",
                        "text": "Final answer",
                        "index": 1,
                    },
                ],
                "model_info": {"provider": "openai", "model": "gpt-5.4"},
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        reasoning_block = result[0]["content"][0]
        assert reasoning_block == {
            "type": "reasoning",
            "id": "rs_abc123",
            "summary": [
                {"type": "summary_text", "text": "I considered the options..."}
            ],
            "encrypted_content": "gAAAA_encrypted_data",
        }
        # Text block unchanged
        assert result[0]["content"][1]["type"] == "text"

    def test_openai_same_provider_without_extras_id_passes_through(self):
        """OpenAI reasoning blocks without extras.id/encrypted_content are not reconstructed."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "plain thinking"},
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "openai", "model": "gpt-5"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert result[0]["content"][0] == {
            "type": "reasoning",
            "reasoning": "plain thinking",
        }

    def test_openai_same_provider_does_not_mutate_original(self):
        """OpenAI denormalization creates a deep copy, original is untouched."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "thought",
                        "extras": {"id": "rs_1", "encrypted_content": "enc"},
                    },
                ],
                "model_info": {"provider": "openai", "model": "gpt-5"},
            },
        ]
        original_content = list(messages[0]["content"])
        strip_foreign_reasoning_blocks(messages, "openai")
        assert messages[0]["content"] == original_content

    def test_openai_same_provider_multiple_reasoning_blocks(self):
        """Multiple exploded reasoning blocks are each reconstructed."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "Step 1",
                        "extras": {"id": "rs_1", "encrypted_content": "enc1"},
                    },
                    {
                        "type": "reasoning",
                        "reasoning": "Step 2",
                        "extras": {"id": "rs_1", "encrypted_content": "enc1"},
                    },
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "openai", "model": "gpt-5"},
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        assert result[0]["content"][0] == {
            "type": "reasoning",
            "id": "rs_1",
            "summary": [{"type": "summary_text", "text": "Step 1"}],
            "encrypted_content": "enc1",
        }
        assert result[0]["content"][1] == {
            "type": "reasoning",
            "id": "rs_1",
            "summary": [{"type": "summary_text", "text": "Step 2"}],
            "encrypted_content": "enc1",
        }
        assert result[0]["content"][2] == {"type": "text", "text": "answer"}

    def test_openai_same_provider_orphaned_text_id_stripped(self):
        """When reasoning blocks lack extras (corrupted data), text block ids are stripped.

        This prevents the API error where a message item references a reasoning
        item that no longer exists.
        """
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": ""},
                    {
                        "id": "msg_abc123",
                        "type": "text",
                        "text": "answer",
                        "index": 1,
                    },
                ],
                "model_info": {"provider": "openai", "model": "gpt-5.4"},
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        text_block = result[0]["content"][1]
        # id should be stripped to prevent orphaned message reference
        assert "id" not in text_block
        assert text_block["text"] == "answer"
        # reasoning block passed through unchanged
        assert result[0]["content"][0] == {"type": "reasoning", "reasoning": ""}

    def test_anthropic_same_provider_drops_reasoning_without_signature(self):
        """Reasoning blocks from Kimi (anthropic protocol, no signature) are dropped for Claude."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "kimi thought"},
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "anthropic", "model": "moonshot-kimi-k2.5"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        # Reasoning without signature is dropped; only text remains
        assert result[0]["content"] == [{"type": "text", "text": "answer"}]

    def test_anthropic_mixed_signature_and_no_signature(self):
        """Only reasoning blocks with signature are kept for Claude target."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "claude thought",
                        "extras": {"signature": "sig1"},
                    },
                    {"type": "text", "text": "A1"},
                ],
                "model_info": {"provider": "anthropic", "model": "claude-sonnet"},
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "kimi thought"},
                    {"type": "text", "text": "A2"},
                ],
                "model_info": {"provider": "anthropic", "model": "moonshot-kimi-k2.5"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        # Claude message: thinking denormalized with signature
        assert result[0]["content"][0] == {
            "type": "thinking",
            "thinking": "claude thought",
            "signature": "sig1",
        }
        # Kimi message: reasoning dropped (no signature), only text kept
        assert result[1]["content"] == [{"type": "text", "text": "A2"}]

    def test_non_claude_anthropic_protocol_fake_signature_stripped(self):
        """Minimax-style fake signature is stripped when targeting Claude.

        Non-Claude models using the Anthropic protocol may produce hex-hash
        signatures that the Claude API rejects as invalid.
        """
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "minimax thinking",
                        "extras": {
                            "index": 0,
                            "signature": "080de92e77be80ab453d135b3971d802",
                        },
                    },
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "anthropic", "model": "minimax-m2.7"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        # Reasoning with fake signature must be stripped, not denormalized
        assert result[0]["content"] == [{"type": "text", "text": "answer"}]
        # No response_metadata (not denormalized as Claude)
        assert "response_metadata" not in result[0]

    def test_legacy_anthropic_no_model_info_denormalized(self):
        """Legacy messages without model_info are assumed Claude (backward compat)."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "legacy thought",
                        "extras": {"signature": "EpwCCk...real_sig"},
                    },
                    {"type": "text", "text": "answer"},
                ],
                # No model_info — legacy data
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        # Legacy messages should be denormalized (assumed Claude)
        assert result[0]["content"][0]["type"] == "thinking"
        assert result[0]["content"][0]["signature"] == "EpwCCk...real_sig"
        assert "response_metadata" in result[0]

    def test_kimi_target_filters_empty_text_blocks(self):
        """Empty text blocks are filtered when targeting Kimi models."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "thought"},
                ],
                "model_info": {"provider": "openai", "model": "gpt-5"},
            },
        ]
        # Cross-provider strip leaves empty text fallback
        result = strip_foreign_reasoning_blocks(
            messages, "anthropic", target_model_id="moonshot-kimi-k2.5"
        )
        # Empty text block should be filtered out for Kimi
        content = result[0]["content"]
        assert not any(
            isinstance(b, dict) and b.get("type") == "text" and not b.get("text")
            for b in content
        )

    # ---- Fix 1: raw Responses API format recognition ----

    def test_openai_same_provider_raw_format_preserves_text_id(self):
        """Raw Responses API reasoning blocks (no extras) preserve sibling text block ids.

        When reasoning blocks have id/summary/encrypted_content at the top
        level (pre-normalization format), has_reasoning_id must be set to
        True so that sibling text block ids are NOT stripped.
        """
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "id": "rs_abc123",
                        "type": "reasoning",
                        "index": 0,
                        "summary": [
                            {"type": "summary_text", "text": "Thinking..."},
                        ],
                        "encrypted_content": "gAAAA_encrypted",
                    },
                    {
                        "id": "msg_xyz789",
                        "type": "text",
                        "text": "Final answer",
                        "index": 1,
                    },
                ],
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        text_block = result[0]["content"][1]
        # id must be preserved (not stripped)
        assert text_block.get("id") == "msg_xyz789"
        assert text_block["text"] == "Final answer"
        # reasoning block passed through unchanged
        assert result[0]["content"][0]["id"] == "rs_abc123"

    def test_openai_same_provider_raw_format_empty_summary(self):
        """Raw format with empty summary list still preserves text ids."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "id": "rs_test",
                        "type": "reasoning",
                        "index": 0,
                        "summary": [],
                        "encrypted_content": "gAAAA_data",
                    },
                    {
                        "id": "msg_test",
                        "type": "text",
                        "text": "answer",
                    },
                ],
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        # Text block id preserved
        assert result[0]["content"][1].get("id") == "msg_test"
        # Reasoning block unchanged
        assert result[0]["content"][0]["id"] == "rs_test"
        assert result[0]["content"][0]["summary"] == []

    def test_openai_same_provider_raw_format_only_id_no_encrypted(self):
        """Raw format with only id (no encrypted_content) still sets has_reasoning_id."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "id": "rs_only_id",
                        "type": "reasoning",
                        "summary": [{"type": "summary_text", "text": "thought"}],
                    },
                    {
                        "id": "msg_abc",
                        "type": "text",
                        "text": "answer",
                    },
                ],
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        assert result[0]["content"][1].get("id") == "msg_abc"

    # ---- Fix 3: reasoning sequence validation ----

    def test_reasoning_only_content_gets_empty_text_appended(self):
        """Assistant message with only reasoning block gets a placeholder text block."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "",
                        "extras": {"id": "rs_1", "encrypted_content": "enc"},
                    },
                ],
                "model_info": {"provider": "openai", "model": "gpt-5.4"},
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        content = result[0]["content"]
        # Reasoning is denormalized, then a placeholder text is appended
        assert len(content) == 2
        assert content[0]["type"] == "reasoning"
        assert content[-1] == {"type": "text", "text": ""}

    def test_reasoning_with_text_unchanged(self):
        """Assistant message with reasoning + text is not modified."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "thinking...",
                        "extras": {"id": "rs_1", "encrypted_content": "enc"},
                    },
                    {"type": "text", "text": "answer"},
                ],
                "model_info": {"provider": "openai", "model": "gpt-5.4"},
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        content = result[0]["content"]
        # Reasoning denormalized + text block = 2 blocks, no placeholder added
        assert len(content) == 2
        assert content[-1]["type"] == "text"
        assert content[-1]["text"] == "answer"

    def test_reasoning_with_tool_calls_not_patched(self):
        """Assistant with reasoning + tool_calls should NOT get a placeholder text."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "",
                        "extras": {"id": "rs_1", "encrypted_content": "enc"},
                    },
                ],
                "model_info": {"provider": "openai", "model": "gpt-5.4"},
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "test", "arguments": "{}"},
                    },
                ],
            },
        ]
        result = strip_foreign_reasoning_blocks(
            messages, "openai", target_api_format="responses"
        )
        content = result[0]["content"]
        # Should NOT have a placeholder — tool_calls serve as the output
        assert len(content) == 1
        assert content[0]["type"] == "reasoning"

    def test_non_responses_api_no_reasoning_validation(self):
        """Reasoning validation only applies to Responses API format."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "reasoning": "thinking..."},
                ],
            },
        ]
        # Chat Completions format — no target_api_format
        result = strip_foreign_reasoning_blocks(messages, "openai")
        content = result[0]["content"]
        # Should NOT be patched for non-Responses API
        assert len(content) == 1


class TestInferProvider:
    """Tests for _infer_provider heuristic."""

    def test_legacy_thinking_block_returns_anthropic(self):
        msg = {
            "role": "assistant",
            "content": [{"type": "thinking", "thinking": "..."}],
        }
        assert _infer_provider(msg) == "anthropic"

    def test_canonical_reasoning_with_signature_returns_anthropic(self):
        msg = {
            "role": "assistant",
            "content": [
                {
                    "type": "reasoning",
                    "reasoning": "...",
                    "extras": {"signature": "abc"},
                }
            ],
        }
        assert _infer_provider(msg) == "anthropic"

    def test_reasoning_with_summary_returns_openai(self):
        msg = {
            "role": "assistant",
            "content": [
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "x"}],
                }
            ],
        }
        assert _infer_provider(msg) == "openai"

    def test_canonical_reasoning_without_extras_returns_none(self):
        msg = {
            "role": "assistant",
            "content": [{"type": "reasoning", "reasoning": "..."}],
        }
        assert _infer_provider(msg) is None

    def test_additional_kwargs_reasoning_content_returns_openai(self):
        msg = {
            "role": "assistant",
            "content": "answer",
            "additional_kwargs": {"reasoning_content": "deep thinking"},
        }
        assert _infer_provider(msg) == "openai"

    def test_plain_text_returns_none(self):
        msg = {"role": "assistant", "content": "plain answer"}
        assert _infer_provider(msg) is None


class TestSanitizeToolIdsForAnthropic:
    """Tests for tool_call ID sanitization when targeting Claude."""

    def test_kimi_tool_ids_sanitized_for_claude(self):
        """Kimi-style tool IDs with dots and colons are sanitized."""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "function_call",
                        "call_id": "functions.load_skill:10",
                        "name": "load_skill",
                    },
                ],
                "tool_calls": [
                    {
                        "id": "functions.load_skill:10",
                        "type": "function",
                        "function": {"name": "load_skill", "arguments": "{}"},
                    }
                ],
                "model_info": {"provider": "openai", "model": "moonshot-kimi-k2.5"},
            },
            {
                "role": "tool",
                "content": "result",
                "tool_call_id": "functions.load_skill:10",
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        # Tool call ID should be sanitized
        assert result[0]["tool_calls"][0]["id"] == "functions_load_skill_10"
        assert result[0]["content"][0]["call_id"] == "functions_load_skill_10"
        assert result[1]["tool_call_id"] == "functions_load_skill_10"

    def test_valid_tool_ids_unchanged(self):
        """Standard tool IDs matching Claude's pattern are not modified."""
        messages = [
            {
                "role": "assistant",
                "content": "answer",
                "tool_calls": [
                    {
                        "id": "call_abc123",
                        "type": "function",
                        "function": {"name": "test", "arguments": "{}"},
                    }
                ],
                "model_info": {"provider": "openai", "model": "gpt-5"},
            },
            {
                "role": "tool",
                "content": "result",
                "tool_call_id": "call_abc123",
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "anthropic")
        assert result[0]["tool_calls"][0]["id"] == "call_abc123"
        assert result[1]["tool_call_id"] == "call_abc123"

    def test_non_anthropic_target_no_sanitization(self):
        """Tool IDs are not sanitized when targeting non-Anthropic providers."""
        messages = [
            {
                "role": "assistant",
                "content": "answer",
                "tool_calls": [
                    {
                        "id": "functions.test:1",
                        "type": "function",
                        "function": {"name": "test", "arguments": "{}"},
                    }
                ],
                "model_info": {"provider": "openai", "model": "kimi"},
            },
        ]
        result = strip_foreign_reasoning_blocks(messages, "openai")
        assert result[0]["tool_calls"][0]["id"] == "functions.test:1"
