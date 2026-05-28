# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for extract_completed_result shared helper."""

import pytest

from app.services.execution.dispatcher import extract_completed_result


class TestExtractCompletedResult:
    """Tests for the extract_completed_result function."""

    def test_extracts_text_from_output(self):
        """Text content from output items is concatenated into 'value'."""
        response_data = {
            "output": [
                {
                    "content": [
                        {"text": "Hello "},
                        {"text": "world"},
                    ]
                }
            ]
        }
        result = extract_completed_result(response_data)
        assert result["value"] == "Hello world"

    def test_empty_output(self):
        """Empty output produces empty value."""
        result = extract_completed_result({"output": []})
        assert result["value"] == ""

    def test_missing_output(self):
        """Missing output key produces empty value."""
        result = extract_completed_result({})
        assert result["value"] == ""

    def test_preserves_usage(self):
        result = extract_completed_result({"usage": {"tokens": 42}})
        assert result["usage"] == {"tokens": 42}

    def test_preserves_sources(self):
        result = extract_completed_result({"sources": [{"url": "http://x"}]})
        assert result["sources"] == [{"url": "http://x"}]

    def test_preserves_messages_chain(self):
        chain = [{"role": "assistant", "content": "hi"}]
        result = extract_completed_result({"messages_chain": chain})
        assert result["messages_chain"] == chain

    def test_preserves_reasoning_content(self):
        result = extract_completed_result({"reasoning_content": "thinking..."})
        assert result["reasoning_content"] == "thinking..."

    def test_preserves_loaded_skills(self):
        result = extract_completed_result({"loaded_skills": ["skill1"]})
        assert result["loaded_skills"] == ["skill1"]

    def test_preserves_silent_exit_fields(self):
        result = extract_completed_result(
            {
                "silent_exit": True,
                "silent_exit_reason": "user_cancelled",
            }
        )
        assert result["silent_exit"] is True
        assert result["silent_exit_reason"] == "user_cancelled"

    def test_missing_fields_are_none(self):
        """Fields not present in response_data are None."""
        result = extract_completed_result({})
        assert result["sources"] is None
        assert result["messages_chain"] is None
        assert result["reasoning_content"] is None
        assert result["loaded_skills"] is None

    def test_multiple_output_items(self):
        """Text from multiple output items is concatenated."""
        response_data = {
            "output": [
                {"content": [{"text": "Part1"}]},
                {"content": [{"text": "Part2"}]},
            ]
        }
        result = extract_completed_result(response_data)
        assert result["value"] == "Part1Part2"

    def test_non_dict_items_skipped(self):
        """Non-dict items in output are skipped."""
        response_data = {"output": ["not_a_dict", {"content": [{"text": "ok"}]}]}
        result = extract_completed_result(response_data)
        assert result["value"] == "ok"

    def test_content_blocks_without_text_skipped(self):
        """Content blocks without 'text' key are skipped."""
        response_data = {
            "output": [{"content": [{"type": "image"}, {"text": "hello"}]}]
        }
        result = extract_completed_result(response_data)
        assert result["value"] == "hello"
