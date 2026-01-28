# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for KB summary injection in history loader.

Tests the automatic injection of knowledge base summaries into
the chat context when summaries are available.
"""

import logging
from unittest.mock import Mock

import pytest

from chat_shell.history.loader import (
    _get_summary_text,
    get_knowledge_base_meta_for_task,
    get_knowledge_base_meta_prompt,
)

logger = logging.getLogger(__name__)


class TestGetSummaryText:
    """Test _get_summary_text helper function."""

    def test_uses_long_summary_for_1_kb(self):
        """Should use long_summary for 1 KB."""
        summary_data = {
            "short_summary": "Brief summary",
            "long_summary": "Detailed summary with more information",
        }
        result = _get_summary_text(summary_data, kb_count=1)
        assert result == "Detailed summary with more information"

    def test_uses_long_summary_for_2_kbs(self):
        """Should use long_summary for 2 KBs."""
        summary_data = {
            "short_summary": "Brief summary",
            "long_summary": "Detailed summary with more information",
        }
        result = _get_summary_text(summary_data, kb_count=2)
        assert result == "Detailed summary with more information"

    def test_uses_short_summary_for_3_kbs(self):
        """Should use short_summary for 3 KBs."""
        summary_data = {
            "short_summary": "Brief summary",
            "long_summary": "Detailed summary with more information",
        }
        result = _get_summary_text(summary_data, kb_count=3)
        assert result == "Brief summary"

    def test_uses_short_summary_for_many_kbs(self):
        """Should use short_summary for many KBs."""
        summary_data = {
            "short_summary": "Brief summary",
            "long_summary": "Detailed summary with more information",
        }
        result = _get_summary_text(summary_data, kb_count=10)
        assert result == "Brief summary"

    def test_fallback_to_long_when_short_missing(self):
        """Should fall back to long_summary when short_summary is missing."""
        summary_data = {
            "long_summary": "Detailed summary with more information",
        }
        result = _get_summary_text(summary_data, kb_count=3)
        assert result == "Detailed summary with more information"

    def test_fallback_to_short_when_long_missing(self):
        """Should fall back to short_summary when long_summary is missing."""
        summary_data = {
            "short_summary": "Brief summary",
        }
        result = _get_summary_text(summary_data, kb_count=1)
        assert result == "Brief summary"

    def test_returns_empty_string_when_both_missing(self):
        """Should return empty string when both summaries are missing."""
        summary_data = {}
        result = _get_summary_text(summary_data, kb_count=1)
        assert result == ""

    def test_handles_empty_summary_values(self):
        """Should handle empty string values."""
        summary_data = {
            "short_summary": "",
            "long_summary": "",
        }
        result = _get_summary_text(summary_data, kb_count=1)
        assert result == ""


class TestGetKnowledgeBaseMetaPrompt:
    """Test get_knowledge_base_meta_prompt with summary injection."""

    def test_empty_prompt_when_no_kbs(self):
        """Should return empty string when no KBs are found."""
        mock_db = Mock()
        mock_db.query.return_value.filter.return_value.all.return_value = []

        result = get_knowledge_base_meta_prompt(mock_db, task_id=1)
        assert result == ""

    def test_basic_kb_list_without_summary(self):
        """Should show basic KB list when no summary is available."""
        # Mock KB without summary
        mock_kb_kind = Mock()
        mock_kb_kind.json = {
            "spec": {
                "name": "Test KB",
                "summaryEnabled": False,
            }
        }

        # Mock get_knowledge_base_meta_for_task return value
        with pytest.mock.patch(
            "chat_shell.history.loader.get_knowledge_base_meta_for_task"
        ) as mock_get_meta:
            mock_get_meta.return_value = [
                {
                    "kb_id": 123,
                    "kb_name": "Test KB",
                    "kb_kind": mock_kb_kind,
                }
            ]

            mock_db = Mock()
            result = get_knowledge_base_meta_prompt(mock_db, task_id=1)

            assert "KB Name: Test KB, KB ID: 123" in result
            assert "Summary:" not in result
            assert "Topics:" not in result

    def test_kb_with_completed_summary(self):
        """Should show summary sub-bullets when summary is completed."""
        # Mock KB with completed summary
        mock_kb_kind = Mock()
        mock_kb_kind.json = {
            "spec": {
                "name": "Test KB",
                "summaryEnabled": True,
                "summary": {
                    "status": "completed",
                    "short_summary": "Brief test summary",
                    "long_summary": "Detailed test summary with more information",
                    "topics": ["topic1", "topic2", "topic3"],
                },
            }
        }

        with pytest.mock.patch(
            "chat_shell.history.loader.get_knowledge_base_meta_for_task"
        ) as mock_get_meta:
            mock_get_meta.return_value = [
                {
                    "kb_id": 123,
                    "kb_name": "Test KB",
                    "kb_kind": mock_kb_kind,
                }
            ]

            mock_db = Mock()
            result = get_knowledge_base_meta_prompt(mock_db, task_id=1)

            assert "KB Name: Test KB, KB ID: 123" in result
            assert "  - Summary: Detailed test summary with more information" in result
            assert "  - Topics: topic1, topic2, topic3" in result

    def test_multiple_kbs_uses_short_summary(self):
        """Should use short_summary for 3+ KBs."""
        # Mock 3 KBs with summaries
        mock_kb_kinds = []
        for i in range(3):
            mock_kb = Mock()
            mock_kb.json = {
                "spec": {
                    "name": f"KB {i+1}",
                    "summaryEnabled": True,
                    "summary": {
                        "status": "completed",
                        "short_summary": f"Brief summary {i+1}",
                        "long_summary": f"Detailed summary {i+1}",
                        "topics": [f"topic{i+1}a", f"topic{i+1}b"],
                    },
                }
            }
            mock_kb_kinds.append(mock_kb)

        with pytest.mock.patch(
            "chat_shell.history.loader.get_knowledge_base_meta_for_task"
        ) as mock_get_meta:
            mock_get_meta.return_value = [
                {"kb_id": i + 1, "kb_name": f"KB {i+1}", "kb_kind": kb}
                for i, kb in enumerate(mock_kb_kinds)
            ]

            mock_db = Mock()
            result = get_knowledge_base_meta_prompt(mock_db, task_id=1)

            # Should use short summaries for all 3 KBs
            assert "Brief summary 1" in result
            assert "Brief summary 2" in result
            assert "Brief summary 3" in result
            assert "Detailed summary" not in result

    def test_kb_with_summary_in_progress(self):
        """Should not show summary when status is not completed."""
        mock_kb_kind = Mock()
        mock_kb_kind.json = {
            "spec": {
                "name": "Test KB",
                "summaryEnabled": True,
                "summary": {
                    "status": "in_progress",
                    "short_summary": "Brief test summary",
                    "long_summary": "Detailed test summary",
                },
            }
        }

        with pytest.mock.patch(
            "chat_shell.history.loader.get_knowledge_base_meta_for_task"
        ) as mock_get_meta:
            mock_get_meta.return_value = [
                {
                    "kb_id": 123,
                    "kb_name": "Test KB",
                    "kb_kind": mock_kb_kind,
                }
            ]

            mock_db = Mock()
            result = get_knowledge_base_meta_prompt(mock_db, task_id=1)

            assert "KB Name: Test KB, KB ID: 123" in result
            assert "Summary:" not in result

    def test_kb_without_topics(self):
        """Should not show Topics line when topics are empty."""
        mock_kb_kind = Mock()
        mock_kb_kind.json = {
            "spec": {
                "name": "Test KB",
                "summaryEnabled": True,
                "summary": {
                    "status": "completed",
                    "long_summary": "Detailed test summary",
                    "topics": [],
                },
            }
        }

        with pytest.mock.patch(
            "chat_shell.history.loader.get_knowledge_base_meta_for_task"
        ) as mock_get_meta:
            mock_get_meta.return_value = [
                {
                    "kb_id": 123,
                    "kb_name": "Test KB",
                    "kb_kind": mock_kb_kind,
                }
            ]

            mock_db = Mock()
            result = get_knowledge_base_meta_prompt(mock_db, task_id=1)

            assert "Summary: Detailed test summary" in result
            assert "Topics:" not in result

    def test_mixed_kbs_with_and_without_summary(self):
        """Should handle mix of KBs with and without summaries."""
        # KB 1: Has summary
        mock_kb1 = Mock()
        mock_kb1.json = {
            "spec": {
                "name": "KB 1",
                "summaryEnabled": True,
                "summary": {
                    "status": "completed",
                    "long_summary": "Summary for KB 1",
                    "topics": ["topic1"],
                },
            }
        }

        # KB 2: No summary
        mock_kb2 = Mock()
        mock_kb2.json = {
            "spec": {
                "name": "KB 2",
                "summaryEnabled": False,
            }
        }

        with pytest.mock.patch(
            "chat_shell.history.loader.get_knowledge_base_meta_for_task"
        ) as mock_get_meta:
            mock_get_meta.return_value = [
                {"kb_id": 1, "kb_name": "KB 1", "kb_kind": mock_kb1},
                {"kb_id": 2, "kb_name": "KB 2", "kb_kind": mock_kb2},
            ]

            mock_db = Mock()
            result = get_knowledge_base_meta_prompt(mock_db, task_id=1)

            # KB 1 should have summary
            assert "KB Name: KB 1, KB ID: 1" in result
            assert "Summary: Summary for KB 1" in result

            # KB 2 should not have summary
            assert "KB Name: KB 2, KB ID: 2" in result
            # Count occurrences of "Summary:" - should be exactly 1
            assert result.count("Summary:") == 1

    def test_kb_not_found_fallback(self):
        """Should handle KB not found gracefully."""
        with pytest.mock.patch(
            "chat_shell.history.loader.get_knowledge_base_meta_for_task"
        ) as mock_get_meta:
            mock_get_meta.return_value = [
                {
                    "kb_id": 999,
                    "kb_name": "Missing KB",
                    "kb_kind": None,  # KB not found
                }
            ]

            mock_db = Mock()
            result = get_knowledge_base_meta_prompt(mock_db, task_id=1)

            # Should show basic KB line without summary
            assert "KB Name: Missing KB, KB ID: 999" in result
            assert "Summary:" not in result

    def test_exception_handling_in_summary_extraction(self):
        """Should handle exceptions in summary extraction gracefully."""
        # Mock KB with malformed json
        mock_kb_kind = Mock()
        mock_kb_kind.json.get.side_effect = Exception("Test error")

        with pytest.mock.patch(
            "chat_shell.history.loader.get_knowledge_base_meta_for_task"
        ) as mock_get_meta:
            mock_get_meta.return_value = [
                {
                    "kb_id": 123,
                    "kb_name": "Test KB",
                    "kb_kind": mock_kb_kind,
                }
            ]

            mock_db = Mock()
            # Should not raise exception
            result = get_knowledge_base_meta_prompt(mock_db, task_id=1)

            # Should still show basic KB line
            assert "KB Name: Test KB, KB ID: 123" in result
