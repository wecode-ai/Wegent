# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for kb_meta prompt formatter.

All comments must be written in English.
"""

import pytest


@pytest.mark.unit
class TestKbMetaFormatter:
    def test_format_kb_meta_prompt_empty(self):
        from app.services.chat.preprocessing.kb_meta import format_kb_meta_prompt

        assert format_kb_meta_prompt([]) == ""

    def test_format_kb_meta_prompt_with_summary_and_topics(self):
        from app.services.chat.preprocessing.kb_meta import format_kb_meta_prompt

        prompt = format_kb_meta_prompt(
            [
                {
                    "kb_id": 1,
                    "kb_name": "KB1",
                    "summary_text": "S1",
                    "topics": ["t1", "t2"],
                },
                {
                    "kb_id": 2,
                    "kb_name": "KB2",
                    "summary_text": "",
                    "topics": [],
                },
            ]
        )

        assert "Knowledge Bases In Scope" in prompt
        assert "KB Name: KB1" in prompt
        assert "KB ID: 1" in prompt
        assert "Summary: S1" in prompt
        assert "Topics: t1, t2" in prompt
        assert "KB Name: KB2" in prompt
        assert "request-scoped metadata only" in prompt

    def test_format_kb_meta_prompt_marks_single_selected_kb_as_target(self):
        from app.services.chat.preprocessing.kb_meta import format_kb_meta_prompt

        prompt = format_kb_meta_prompt(
            [
                {
                    "kb_id": 1408,
                    "kb_name": "222",
                    "summary_text": "Upload target",
                    "topics": [],
                }
            ]
        )

        assert "Current Target KB" in prompt
        assert "KB Name: 222" in prompt
        assert "KB ID: 1408" in prompt
        assert "request-scoped metadata only" in prompt
        assert "create_document" not in prompt
        assert "list_knowledge_bases" not in prompt
        assert "clarifying questions" not in prompt

    def test_select_kb_summary_text_prefers_long_for_small_list(self):
        from app.services.chat.preprocessing.kb_meta import select_kb_summary_text

        assert (
            select_kb_summary_text(
                {"short_summary": "S", "long_summary": "L"}, kb_count=2
            )
            == "L"
        )

    def test_select_kb_summary_text_prefers_short_for_large_list(self):
        from app.services.chat.preprocessing.kb_meta import select_kb_summary_text

        assert (
            select_kb_summary_text(
                {"short_summary": "S", "long_summary": "L"}, kb_count=3
            )
            == "S"
        )

    def test_format_restricted_kb_meta_prompt_includes_safe_routing_hints(self):
        from app.services.chat.preprocessing.kb_meta import (
            format_restricted_kb_meta_prompt,
        )

        prompt = format_restricted_kb_meta_prompt(
            [
                {
                    "kb_id": 1,
                    "kb_name": "KB1",
                    "summary_text": "S1",
                    "topics": ["t1", "t2"],
                }
            ]
        )

        assert "Restricted Knowledge Bases In Scope" in prompt
        assert "KB Name: KB1" in prompt
        assert "KB ID: 1" in prompt
        assert "Summary:" not in prompt
        assert "Topics:" not in prompt
        assert "Routing Hint: S1" in prompt
        assert "Routing Keywords: t1, t2" in prompt
        assert "retrieval guidance only" in prompt
        assert "document structure" not in prompt
        assert "high-level analysis" not in prompt
