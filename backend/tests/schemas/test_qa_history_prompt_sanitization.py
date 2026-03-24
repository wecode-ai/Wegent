# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for QAHistoryItem user_prompt field serialization.

Verifies that system-injected metadata blocks (<system-reminder>) stored in
Subtask.prompt are stripped before the value is returned via QAHistoryItem.user_prompt
in the knowledge base QA history API.
"""

import json
from datetime import datetime

import pytest

from app.schemas.knowledge_qa_history import QAHistoryItem


def _make_qa_item_data(user_prompt=None, **kwargs):
    """Build a minimal dict accepted by QAHistoryItem."""
    base = {
        "task_id": 1,
        "user_id": 1,
        "subtask_id": 10,
        "subtask_context_id": 20,
        "created_at": datetime(2025, 1, 1, 12, 0, 0),
    }
    if user_prompt is not None:
        base["user_prompt"] = user_prompt
    base.update(kwargs)
    return base


class TestQAHistoryItemUserPromptSerialization:
    """Tests for the clean_user_prompt field_serializer in QAHistoryItem."""

    def test_plain_text_prompt_returned_unchanged(self):
        """Plain text user_prompt must not be modified."""
        item = QAHistoryItem(**_make_qa_item_data(user_prompt="What is RAG?"))
        result = item.model_dump()
        assert result["user_prompt"] == "What is RAG?"

    def test_none_prompt_returned_as_none(self):
        """None user_prompt must remain None (or empty)."""
        item = QAHistoryItem(**_make_qa_item_data(user_prompt=None))
        result = item.model_dump()
        assert result["user_prompt"] is None

    def test_json_array_prompt_strips_system_reminder(self):
        """JSON array user_prompt with <system-reminder> must be stripped."""
        raw_prompt = json.dumps(
            [
                {"type": "text", "text": "Search documents for quarterly report"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-01-01 09:00</CurrentTime></system-reminder>",
                },
            ]
        )
        item = QAHistoryItem(**_make_qa_item_data(user_prompt=raw_prompt))
        result = item.model_dump()
        assert result["user_prompt"] == "Search documents for quarterly report"

    def test_json_array_prompt_with_attachment_metadata(self):
        """JSON array with attachment metadata block is stripped correctly."""
        raw_prompt = json.dumps(
            [
                {"type": "text", "text": "Summarize this document"},
                {
                    "type": "text",
                    "text": (
                        "<system-reminder>"
                        "<Attachment>report.pdf (uploaded)</Attachment>"
                        "</system-reminder>"
                    ),
                },
            ]
        )
        item = QAHistoryItem(**_make_qa_item_data(user_prompt=raw_prompt))
        result = item.model_dump()
        assert result["user_prompt"] == "Summarize this document"

    def test_json_serialization_also_strips(self):
        """model_dump(mode='json') also passes through the serializer."""
        raw_prompt = json.dumps(
            [
                {"type": "text", "text": "Find relevant chapters"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>2025-03-01</CurrentTime></system-reminder>",
                },
            ]
        )
        item = QAHistoryItem(**_make_qa_item_data(user_prompt=raw_prompt))
        result = item.model_dump(mode="json")
        assert result["user_prompt"] == "Find relevant chapters"

    def test_invalid_json_returned_as_is(self):
        """Non-JSON strings should be returned unchanged (treated as plain text)."""
        prompt = "[not valid json"
        item = QAHistoryItem(**_make_qa_item_data(user_prompt=prompt))
        result = item.model_dump()
        assert result["user_prompt"] == prompt
