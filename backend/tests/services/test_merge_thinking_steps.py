# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for merge_thinking_steps function."""

import pytest

from app.services.adapters.executor_kinds import merge_thinking_steps


class TestMergeThinkingSteps:
    """Test cases for merge_thinking_steps function."""

    def test_empty_list(self):
        """Test with empty list returns empty list."""
        result = merge_thinking_steps([])
        assert result == []

    def test_single_step(self):
        """Test with single step returns that step."""
        steps = [{"title": "thinking.initialize_agent", "next_action": "continue"}]
        result = merge_thinking_steps(steps)
        assert len(result) == 1
        assert result[0]["title"] == "thinking.initialize_agent"

    def test_no_merge_different_titles(self):
        """Test that steps with different titles are not merged."""
        steps = [
            {"title": "thinking.initialize_agent", "next_action": "continue"},
            {"title": "thinking.async_execution_started", "next_action": "continue"},
        ]
        result = merge_thinking_steps(steps)
        assert len(result) == 2
        assert result[0]["title"] == "thinking.initialize_agent"
        assert result[1]["title"] == "thinking.async_execution_started"

    def test_no_merge_without_details_type(self):
        """Test that steps without details.type are not merged even with same title."""
        steps = [
            {"title": "thinking.initialize_agent", "next_action": "continue"},
            {"title": "thinking.initialize_agent", "next_action": "continue"},
        ]
        result = merge_thinking_steps(steps)
        # Should not merge because no details.type
        assert len(result) == 2

    def test_merge_same_reasoning_type(self):
        """Test that adjacent reasoning steps are merged."""
        steps = [
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "Hello"},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": " World"},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "!"},
            },
        ]
        result = merge_thinking_steps(steps)
        assert len(result) == 1
        assert result[0]["title"] == "thinking.model_reasoning"
        assert result[0]["details"]["content"] == "Hello World!"

    def test_no_merge_different_details_type(self):
        """Test that steps with different details.type are not merged."""
        steps = [
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "Hello"},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "tool_call", "content": "World"},
            },
        ]
        result = merge_thinking_steps(steps)
        assert len(result) == 2

    def test_no_merge_different_next_action(self):
        """Test that steps with different next_action are not merged."""
        steps = [
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "Hello"},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "stop",
                "details": {"type": "reasoning", "content": " World"},
            },
        ]
        result = merge_thinking_steps(steps)
        assert len(result) == 2

    def test_mixed_steps(self):
        """Test realistic scenario with mixed step types."""
        steps = [
            {"title": "thinking.initialize_agent", "next_action": "continue"},
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "Let me "},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "think about "},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "this."},
            },
            {
                "title": "thinking.agent_tool_call",
                "next_action": "continue",
                "details": {"type": "tool", "name": "Read"},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "Now I "},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "understand."},
            },
        ]
        result = merge_thinking_steps(steps)

        # Expected: 4 steps after merging
        # 1. initialize_agent
        # 2. merged reasoning "Let me think about this."
        # 3. agent_tool_call
        # 4. merged reasoning "Now I understand."
        assert len(result) == 4
        assert result[0]["title"] == "thinking.initialize_agent"
        assert result[1]["title"] == "thinking.model_reasoning"
        assert result[1]["details"]["content"] == "Let me think about this."
        assert result[2]["title"] == "thinking.agent_tool_call"
        assert result[3]["title"] == "thinking.model_reasoning"
        assert result[3]["details"]["content"] == "Now I understand."

    def test_preserves_other_details_fields(self):
        """Test that other fields in details are preserved after merge."""
        steps = [
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "Hello", "extra": "value1"},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {
                    "type": "reasoning",
                    "content": " World",
                    "extra": "value2",
                },
            },
        ]
        result = merge_thinking_steps(steps)
        assert len(result) == 1
        # Content should be merged
        assert result[0]["details"]["content"] == "Hello World"
        # Other fields from the first step should be preserved
        assert result[0]["details"]["type"] == "reasoning"
        # extra from first step is preserved (we keep the first step's other fields)
        assert result[0]["details"]["extra"] == "value1"

    def test_does_not_mutate_input(self):
        """Test that input list is not mutated."""
        steps = [
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": "Hello"},
            },
            {
                "title": "thinking.model_reasoning",
                "next_action": "continue",
                "details": {"type": "reasoning", "content": " World"},
            },
        ]
        original_first_content = steps[0]["details"]["content"]
        merge_thinking_steps(steps)
        # Original should not be modified
        assert steps[0]["details"]["content"] == original_first_content
        assert len(steps) == 2
