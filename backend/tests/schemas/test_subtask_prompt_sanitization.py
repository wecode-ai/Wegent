# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for SubtaskInDB prompt field serialization.

Verifies that system-injected metadata blocks (<system-reminder>) stored in
Subtask.prompt are stripped before the value is returned to the frontend via
the SubtaskInDB schema.
"""

import json
from datetime import datetime

import pytest

from app.schemas.subtask import SubtaskInDB, SubtaskRole, SubtaskStatus


def _make_subtask_data(prompt=None, **kwargs):
    """Build a minimal dict accepted by SubtaskInDB."""
    base = {
        "id": 1,
        "user_id": 1,
        "task_id": 1,
        "team_id": 1,
        "title": "test",
        "role": SubtaskRole.USER,
        "status": SubtaskStatus.COMPLETED,
        "created_at": datetime(2025, 1, 1, 12, 0, 0),
        "updated_at": datetime(2025, 1, 1, 12, 0, 0),
    }
    if prompt is not None:
        base["prompt"] = prompt
    base.update(kwargs)
    return base


class TestSubtaskInDBPromptSerialization:
    """Tests for the clean_prompt field_serializer in SubtaskInDB."""

    def test_plain_text_prompt_returned_unchanged(self):
        """Plain text prompts must not be modified."""
        data = _make_subtask_data(prompt="Hello, please help me")
        subtask = SubtaskInDB(**data)
        result = subtask.model_dump()
        assert result["prompt"] == "Hello, please help me"

    def test_none_prompt_returned_as_none(self):
        """None prompt must remain None."""
        data = _make_subtask_data(prompt=None)
        subtask = SubtaskInDB(**data)
        result = subtask.model_dump()
        assert result["prompt"] is None

    def test_json_array_prompt_strips_system_reminder(self):
        """JSON array prompt containing a <system-reminder> block must be stripped."""
        raw_prompt = json.dumps(
            [
                {"type": "text", "text": "What is the weather today?"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-01-01 12:00</CurrentTime></system-reminder>",
                },
            ]
        )
        data = _make_subtask_data(prompt=raw_prompt)
        subtask = SubtaskInDB(**data)
        result = subtask.model_dump()
        assert result["prompt"] == "What is the weather today?"

    def test_json_array_prompt_with_multiple_system_blocks(self):
        """All extra blocks (system-reminder, attachment metadata) are stripped."""
        raw_prompt = json.dumps(
            [
                {"type": "text", "text": "Analyze this file"},
                {
                    "type": "text",
                    "text": "<system-reminder><Attachment>report.pdf</Attachment></system-reminder>",
                },
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-06-01 09:00</CurrentTime></system-reminder>",
                },
            ]
        )
        data = _make_subtask_data(prompt=raw_prompt)
        subtask = SubtaskInDB(**data)
        result = subtask.model_dump()
        assert result["prompt"] == "Analyze this file"

    def test_json_array_single_block_no_system_reminder(self):
        """Single-block JSON array without system-reminder returns the text."""
        raw_prompt = json.dumps([{"type": "text", "text": "Simple question"}])
        data = _make_subtask_data(prompt=raw_prompt)
        subtask = SubtaskInDB(**data)
        result = subtask.model_dump()
        assert result["prompt"] == "Simple question"

    def test_json_serialization_also_strips_system_reminder(self):
        """model_dump(mode='json') also passes through the serializer."""
        raw_prompt = json.dumps(
            [
                {"type": "text", "text": "User message"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-01-01</CurrentTime></system-reminder>",
                },
            ]
        )
        data = _make_subtask_data(prompt=raw_prompt)
        subtask = SubtaskInDB(**data)
        result = subtask.model_dump(mode="json")
        assert result["prompt"] == "User message"

    def test_assistant_role_prompt_none_not_affected(self):
        """ASSISTANT subtasks normally have None prompt — serializer handles gracefully."""
        data = _make_subtask_data(role=SubtaskRole.ASSISTANT, prompt=None)
        subtask = SubtaskInDB(**data)
        result = subtask.model_dump()
        assert result["prompt"] is None

    def test_empty_string_prompt_returned_as_empty(self):
        """Empty string prompt must not raise and must return an empty/falsy value."""
        data = _make_subtask_data(prompt="")
        subtask = SubtaskInDB(**data)
        result = subtask.model_dump()
        # extract_display_prompt("") returns "" (falsy but not None)
        assert result["prompt"] == "" or result["prompt"] is None
