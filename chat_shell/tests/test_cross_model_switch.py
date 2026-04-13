# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Integration tests for cross-model switching with think block compatibility.

Simulates the full serialize → store → load → filter → convert cycle when
switching between different LLM providers mid-conversation.
"""

from langchain_core.messages import AIMessage, ToolMessage

from chat_shell.agents.graph_builder import (
    _convert_validated_messages,
    _serialize_messages_chain,
)


class TestCrossModelSwitch:
    """End-to-end tests for cross-model think block round-trips."""

    def test_claude_thinking_to_gpt(self):
        """Claude thinking blocks are stripped when loading for GPT."""
        # Step 1: Simulate Claude response with thinking
        claude_msg = AIMessage(
            content=[
                {
                    "type": "thinking",
                    "thinking": "Let me analyze...",
                    "signature": "sig123",
                },
                {"type": "text", "text": "The answer is 42"},
            ]
        )
        chain = _serialize_messages_chain(
            [claude_msg], provider="anthropic", model_id="claude-sonnet"
        )

        # Step 2: Simulate history loading for GPT
        history = [{"role": "user", "content": "What is 6*7?"}] + chain
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="openai"
        )

        # Verify: no thinking blocks in the converted messages
        for msg in lc_messages:
            if hasattr(msg, "content") and isinstance(msg.content, list):
                for block in msg.content:
                    if isinstance(block, dict):
                        assert (
                            block.get("type") != "thinking"
                        ), "thinking block should be stripped for openai"
                        # Canonical reasoning blocks should also be stripped
                        assert (
                            block.get("type") != "reasoning"
                        ), "reasoning block should be stripped for cross-provider"

    def test_deepseek_reasoning_to_claude(self):
        """DeepSeek reasoning_content is stripped when loading for Claude."""
        deepseek_msg = AIMessage(
            content="The answer is 42",
            additional_kwargs={"reasoning_content": "Step 1: multiply..."},
        )
        chain = _serialize_messages_chain(
            [deepseek_msg], provider="openai", model_id="deepseek-r1"
        )

        history = [{"role": "user", "content": "What is 6*7?"}] + chain
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="anthropic"
        )

        # Verify: no reasoning blocks in the anthropic-targeted messages
        for msg in lc_messages:
            if hasattr(msg, "content") and isinstance(msg.content, list):
                for block in msg.content:
                    if isinstance(block, dict):
                        assert block.get("type") != "reasoning"

    def test_openai_responses_reasoning_to_gemini(self):
        """OpenAI Responses API reasoning summary is stripped for Gemini."""
        oai_msg = AIMessage(
            content=[
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "I considered..."}],
                    "id": "rs_abc",
                },
                {"type": "text", "text": "Final answer"},
            ]
        )
        chain = _serialize_messages_chain(
            [oai_msg], provider="openai", model_id="gpt-5"
        )

        history = [{"role": "user", "content": "Question?"}] + chain
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="google"
        )

        for msg in lc_messages:
            if hasattr(msg, "content") and isinstance(msg.content, list):
                for block in msg.content:
                    if isinstance(block, dict):
                        assert block.get("type") != "reasoning"

    def test_same_provider_preserves_reasoning(self):
        """Claude → Claude denormalizes reasoning back to thinking format."""
        claude_msg = AIMessage(
            content=[
                {"type": "thinking", "thinking": "Analysis...", "signature": "sig"},
                {"type": "text", "text": "Answer"},
            ]
        )
        chain = _serialize_messages_chain(
            [claude_msg], provider="anthropic", model_id="claude-sonnet"
        )

        history = [{"role": "user", "content": "Question"}] + chain
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="anthropic"
        )

        # Verify: thinking blocks are restored (not canonical reasoning)
        has_thinking = False
        for msg in lc_messages:
            if hasattr(msg, "content") and isinstance(msg.content, list):
                for block in msg.content:
                    if isinstance(block, dict) and block.get("type") == "thinking":
                        has_thinking = True
                        assert block.get("thinking") == "Analysis..."
                        assert block.get("signature") == "sig"
        assert has_thinking, "Thinking blocks should be restored for same provider"

    def test_claude_to_claude_round_trip_has_response_metadata(self):
        """Full Claude round-trip produces AIMessage with correct response_metadata."""
        claude_msg = AIMessage(
            content=[
                {"type": "thinking", "thinking": "Deep thought", "signature": "s1"},
                {"type": "text", "text": "42"},
            ]
        )
        chain = _serialize_messages_chain(
            [claude_msg], provider="anthropic", model_id="claude-sonnet"
        )

        history = [{"role": "user", "content": "Meaning of life?"}] + chain
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="anthropic"
        )

        # The assistant message should have response_metadata set
        assistant_msgs = [m for m in lc_messages if hasattr(m, "response_metadata")]
        assert any(
            m.response_metadata.get("model_provider") == "anthropic"
            for m in assistant_msgs
        ), "response_metadata['model_provider'] should be 'anthropic'"

    def test_claude_to_claude_legacy_without_model_info(self):
        """Legacy messages without model_info but with signature are denormalized."""
        # Simulate legacy stored data: canonical reasoning with extras.signature
        # but no model_info field
        history = [
            {"role": "user", "content": "Question"},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "reasoning",
                        "reasoning": "Legacy thought",
                        "extras": {"signature": "legacy_sig"},
                    },
                    {"type": "text", "text": "Answer"},
                ],
                # No model_info — _infer_provider should detect signature
            },
        ]
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="anthropic"
        )

        # Verify denormalization happened
        has_thinking = False
        for msg in lc_messages:
            if hasattr(msg, "content") and isinstance(msg.content, list):
                for block in msg.content:
                    if isinstance(block, dict) and block.get("type") == "thinking":
                        has_thinking = True
                        assert block.get("signature") == "legacy_sig"
        assert has_thinking, "Legacy messages with signature should be denormalized"

    def test_tool_call_sequence_preserved_across_model_switch(self):
        """Tool call sequences remain valid after cross-model reasoning strip."""
        msgs = [
            AIMessage(
                content=[
                    {"type": "thinking", "thinking": "I should search"},
                ],
                tool_calls=[{"id": "call_1", "name": "search", "args": {"q": "test"}}],
            ),
            ToolMessage(content="Search result", tool_call_id="call_1", name="search"),
            AIMessage(content="Based on the search..."),
        ]
        chain = _serialize_messages_chain(msgs, provider="anthropic", model_id="claude")

        history = [{"role": "user", "content": "Find something"}] + chain
        # Should not raise InvalidToolMessageSequenceError
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="openai"
        )
        assert len(lc_messages) == 4  # user + 3 from chain

    def test_openai_responses_to_openai_responses_round_trip(self):
        """GPT-5.4 Responses API reasoning blocks survive a same-provider round-trip.

        Simulates: GPT-5.4 response with reasoning → serialize → store →
        load → filter (same provider) → convert. The reasoning blocks must
        be reconstructed to the original Responses API format with top-level
        ``id``, ``summary`` structure, and ``encrypted_content``.
        """
        # Step 1: Simulate GPT-5.4 response with Responses API reasoning
        oai_msg = AIMessage(
            content=[
                {
                    "type": "reasoning",
                    "summary": [
                        {"type": "summary_text", "text": "I need to think about this."}
                    ],
                    "id": "rs_00a8759da22afc8f0069d4b2f63cd88195a5b413e3d1051685",
                    "encrypted_content": "gAAAAABp1LL2_encrypted_data_here",
                },
                {
                    "id": "msg_00a8759da22afc8f0069d4b2f88cc4819595f7e18d7ec92a63",
                    "type": "text",
                    "text": "The answer is 42.",
                    "index": 1,
                },
            ]
        )

        # Step 2: Serialize (this will explode the reasoning block)
        chain = _serialize_messages_chain(
            [oai_msg], provider="openai", model_id="gpt-5.4"
        )

        # Verify exploded format in storage
        stored_content = chain[0]["content"]
        assert stored_content[0]["type"] == "reasoning"
        assert "extras" in stored_content[0]
        assert stored_content[0]["extras"]["id"] == (
            "rs_00a8759da22afc8f0069d4b2f63cd88195a5b413e3d1051685"
        )

        # Step 3: Load and convert for same provider (GPT-5.4 → GPT-5.4)
        history = [{"role": "user", "content": "What is 6*7?"}] + chain
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="openai",
            target_api_format="responses",
        )

        # Step 4: Verify the reasoning block is reconstructed
        assistant_msg = lc_messages[1]
        assert isinstance(assistant_msg.content, list)

        reasoning_blocks = [
            b
            for b in assistant_msg.content
            if isinstance(b, dict) and b.get("type") == "reasoning"
        ]
        assert len(reasoning_blocks) >= 1

        rb = reasoning_blocks[0]
        # Top-level id must be present (not buried in extras)
        assert rb.get("id") == (
            "rs_00a8759da22afc8f0069d4b2f63cd88195a5b413e3d1051685"
        )
        # Summary structure must be rebuilt
        assert "summary" in rb
        assert rb["summary"] == [
            {"type": "summary_text", "text": "I need to think about this."}
        ]
        # encrypted_content at top level
        assert rb.get("encrypted_content") == "gAAAAABp1LL2_encrypted_data_here"
        # extras should not be present
        assert "extras" not in rb

    def test_minimax_fake_signature_to_claude(self):
        """Minimax message with fake signature does not break Claude target.

        Simulates the exact scenario from task 23: Minimax (provider=anthropic)
        produces a hex-hash signature, then conversation switches to Claude.
        The fake signature must be stripped, not denormalized.
        """
        history = [
            {"role": "user", "content": "Draw something"},
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
                    {"type": "text", "text": "Here is a diagram"},
                ],
                "model_info": {"provider": "anthropic", "model": "minimax-m2.7"},
            },
            {"role": "user", "content": "What do you think?"},
        ]
        # Target Claude — should not raise
        lc_messages = _convert_validated_messages(
            history, context="test", target_provider="anthropic"
        )
        assert len(lc_messages) == 3
        # Minimax reasoning should be stripped
        assistant_msg = lc_messages[1]
        if isinstance(assistant_msg.content, list):
            for block in assistant_msg.content:
                if isinstance(block, dict):
                    assert block.get("type") != "thinking"
