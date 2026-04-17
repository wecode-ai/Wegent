# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for kb_meta prompt formatter.

All comments must be written in English.
"""

from unittest.mock import MagicMock, patch

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
                    "search_available": True,
                    "total_document_count": 3,
                    "searchable_document_count": 2,
                    "spreadsheet_document_count": 1,
                    "summary_text": "S1",
                    "topics": ["t1", "t2"],
                },
                {
                    "kb_id": 2,
                    "kb_name": "KB2",
                    "search_available": False,
                    "total_document_count": 0,
                    "searchable_document_count": 0,
                    "spreadsheet_document_count": 0,
                    "summary_text": "",
                    "topics": [],
                },
            ]
        )

        assert "Knowledge Bases In Scope" in prompt
        assert "KB Name: KB1" in prompt
        assert "KB ID: 1" in prompt
        assert "Search: available" in prompt
        assert "Total Docs: 3" in prompt
        assert "Searchable Docs: 2" in prompt
        assert "Spreadsheets: 1" in prompt
        assert "Summary: S1" in prompt
        assert "Topics: t1, t2" in prompt
        assert "KB Name: KB2" in prompt
        assert "Search: unavailable" in prompt
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
        assert "wegent_kb_create_document" not in prompt
        assert "wegent_kb_list_knowledge_bases" not in prompt
        assert "clarifying questions" not in prompt

    def test_format_kb_meta_prompt_includes_runtime_retrieval_fields(self):
        from app.services.chat.preprocessing.kb_meta import format_kb_meta_prompt

        prompt = format_kb_meta_prompt(
            [
                {
                    "kb_id": 12,
                    "kb_name": "Product Docs",
                    "search_available": True,
                    "total_document_count": 128,
                    "searchable_document_count": 113,
                    "spreadsheet_document_count": 9,
                    "summary_text": "Internal product documentation and runbooks",
                    "topics": ["release process", "deployment"],
                }
            ]
        )

        assert "KB Name: Product Docs" in prompt
        assert "KB ID: 12" in prompt
        assert "Search: available" in prompt
        assert "Total Docs: 128" in prompt
        assert "Searchable Docs: 113" in prompt
        assert "Spreadsheets: 9" in prompt

    def test_format_kb_meta_prompt_marks_search_unavailable(self):
        from app.services.chat.preprocessing.kb_meta import format_kb_meta_prompt

        prompt = format_kb_meta_prompt(
            [
                {
                    "kb_id": 7,
                    "kb_name": "Ops KB",
                    "search_available": False,
                    "total_document_count": 10,
                    "searchable_document_count": 6,
                    "spreadsheet_document_count": 2,
                    "summary_text": "",
                    "topics": [],
                }
            ]
        )

        assert "Search: unavailable" in prompt
        assert "Total Docs: 10" in prompt
        assert "Searchable Docs: 6" in prompt
        assert "Spreadsheets: 2" in prompt

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

    def test_build_kb_meta_prompt_passes_retrieval_metadata(self):
        from app.services.chat.preprocessing.contexts import _build_kb_meta_prompt

        kb_kind = MagicMock()
        kb_kind.json = {
            "spec": {
                "name": "Product Docs",
                "retrievalConfig": {"retriever_name": "retriever-a"},
                "summaryEnabled": False,
            }
        }
        captured_meta = {}

        def _capture_meta(kb_meta_list):
            captured_meta["value"] = kb_meta_list
            return "captured"

        with (
            patch(
                "app.services.knowledge.task_knowledge_base_service.task_knowledge_base_service.get_knowledge_bases_by_ids",
                return_value={12: kb_kind},
            ),
            patch(
                "app.services.chat.preprocessing.kb_meta.format_kb_meta_prompt",
                side_effect=_capture_meta,
            ),
            patch(
                "app.services.knowledge.KnowledgeService.get_document_prompt_stats",
                return_value={
                    12: {
                        "total_document_count": 128,
                        "searchable_document_count": 113,
                        "spreadsheet_document_count": 9,
                    }
                },
                create=True,
            ),
        ):
            result = _build_kb_meta_prompt(MagicMock(), [12])

        assert result == "captured"
        assert captured_meta["value"] == [
            {
                "kb_id": 12,
                "kb_name": "Product Docs",
                "search_available": True,
                "total_document_count": 128,
                "searchable_document_count": 113,
                "spreadsheet_document_count": 9,
                "summary_text": "",
                "topics": [],
            }
        ]
