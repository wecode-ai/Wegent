# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for extract_display_prompt in prompt_utils module."""

import json

import pytest

from app.utils.prompt_utils import extract_display_prompt


class TestExtractDisplayPrompt:
    """Tests for the extract_display_prompt utility."""

    def test_none_returns_none(self):
        assert extract_display_prompt(None) is None

    def test_empty_string_returns_empty(self):
        assert extract_display_prompt("") == ""

    def test_plain_text_returned_as_is(self):
        assert extract_display_prompt("Hello world") == "Hello world"

    def test_json_array_returns_first_text_block(self):
        prompt = json.dumps(
            [
                {"type": "text", "text": "User question"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-01-01 12:00</CurrentTime></system-reminder>",
                },
            ]
        )
        assert extract_display_prompt(prompt) == "User question"

    def test_json_array_single_text_block(self):
        """Single-element array still extracts the text."""
        prompt = json.dumps([{"type": "text", "text": "Only block"}])
        assert extract_display_prompt(prompt) == "Only block"

    def test_json_array_with_image_url_blocks(self):
        """image_url blocks are ignored; first text block is extracted."""
        prompt = json.dumps(
            [
                {"type": "text", "text": "Describe this image"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,abc"},
                },
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-01-01</CurrentTime></system-reminder>",
                },
            ]
        )
        assert extract_display_prompt(prompt) == "Describe this image"

    def test_invalid_json_returns_original(self):
        prompt = "[not valid json"
        assert extract_display_prompt(prompt) == prompt

    def test_json_non_array_returns_original(self):
        """JSON object (not array) is treated as plain text."""
        prompt = json.dumps({"type": "text", "text": "hello"})
        assert extract_display_prompt(prompt) == prompt

    def test_json_array_of_non_dicts_returns_original(self):
        """JSON array of non-dict items is treated as plain text."""
        prompt = json.dumps(["string1", "string2"])
        assert extract_display_prompt(prompt) == prompt

    def test_whitespace_preserved_for_plain_text(self):
        """Leading/trailing whitespace in plain text prompts is not stripped."""
        prompt = "  Hello world  "
        assert extract_display_prompt(prompt) == prompt

    def test_json_array_empty_first_text(self):
        """Empty first text block returns empty string."""
        prompt = json.dumps(
            [
                {"type": "text", "text": ""},
                {"type": "text", "text": "system block"},
            ]
        )
        assert extract_display_prompt(prompt) == ""

    def test_old_format_attachment_with_user_question_marker(self):
        """Old format: <attachment> + [User Question]: → extracts user message."""
        prompt = json.dumps(
            [
                {"type": "text", "text": "<attachment>\nimage metadata\n</attachment>"},
                {"type": "text", "text": "[User Question]:\nWhat is this image?"},
                {
                    "type": "text",
                    "text": "<system-reminder>[Current time: 2025-01-01]</system-reminder>",
                },
            ]
        )
        assert extract_display_prompt(prompt) == "What is this image?"

    def test_old_format_plain_string_with_marker(self):
        """Old text-only format with [User Question]: in plain string."""
        prompt = "<attachment>\ndoc content\n</attachment>\n\n[User Question]:\nSummarize this"
        assert extract_display_prompt(prompt) == "Summarize this"

    def test_legacy_selected_documents_returns_user_question(self):
        """Legacy selected_documents array: display prompt must be the user question, not system context."""
        prompt = json.dumps(
            [
                {
                    "type": "text",
                    "text": "<selected_documents>docs</selected_documents>",
                },
                {"type": "text", "text": "real user question"},
            ]
        )
        assert extract_display_prompt(prompt) == "real user question"

    def test_legacy_selected_documents_with_system_reminder(self):
        """Legacy selected_documents + user question + system-reminder."""
        prompt = json.dumps(
            [
                {
                    "type": "text",
                    "text": "<selected_documents>docs</selected_documents>",
                },
                {"type": "text", "text": "What does this mean?"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-01-01</CurrentTime></system-reminder>",
                },
            ]
        )
        assert extract_display_prompt(prompt) == "What does this mean?"

    def test_double_wrapped_prompt_returns_inner_text(self):
        """Double-wrapped prompt: outer layer is a JSON-serialized inner array.

        This reproduces the bug where a retry passes an already-formatted prompt
        through MessageConverter.build_messages a second time, producing:
            [{"type":"text","text":"[inner JSON string]"}, {"type":"text","text":"<system-reminder>..."}]
        extract_display_prompt must return the inner JSON string (the outer first text block).
        """
        inner = json.dumps(
            [
                {"type": "text", "text": "hello"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2026-03-22 19:14</CurrentTime></system-reminder>",
                },
            ]
        )
        double_wrapped = json.dumps(
            [
                {"type": "text", "text": inner},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2026-03-22 19:15</CurrentTime></system-reminder>",
                },
            ]
        )
        # The outer first text block is the serialized inner array.
        # Since that inner array is not a system-reminder, it is returned as-is.
        assert extract_display_prompt(double_wrapped) == inner

    def test_formatted_prompt_returns_original_user_text(self):
        """After deep-thinking persistence, the stored prompt is a JSON content
        array.  extract_display_prompt must recover the original user text.
        """
        prompt = json.dumps(
            [
                {"type": "text", "text": "What is the weather today?"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2026-03-22 19:14</CurrentTime></system-reminder>",
                },
            ]
        )
        assert extract_display_prompt(prompt) == "What is the weather today?"
