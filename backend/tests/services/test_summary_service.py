# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for knowledge summary service.
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.schemas.knowledge import (
    DocumentSummary,
    DocumentSummaryCallbackRequest,
    KnowledgeBaseSummary,
    KnowledgeBaseSummaryCallbackRequest,
)
from app.services.knowledge.summary_service import SummaryService


class TestSummaryServiceDocumentSummary:
    """Test document summary methods in SummaryService."""

    def test_get_document_summary_returns_none_when_no_summary(self):
        """Test that get_document_summary returns None when document has no summary."""
        mock_db = MagicMock(spec=Session)

        with patch.object(
            SummaryService,
            "get_document_summary",
            return_value=None
        ):
            result = SummaryService.get_document_summary(mock_db, 1, 1)
            assert result is None

    def test_get_document_summary_returns_summary_when_exists(self):
        """Test that get_document_summary returns summary when it exists."""
        mock_db = MagicMock(spec=Session)

        mock_summary = DocumentSummary(
            short_summary="Test summary",
            long_summary="Test long summary",
            topics=["topic1", "topic2"],
            status="completed",
        )

        with patch.object(
            SummaryService,
            "get_document_summary",
            return_value=mock_summary
        ):
            result = SummaryService.get_document_summary(mock_db, 1, 1)
            assert result is not None
            assert result.short_summary == "Test summary"
            assert result.status == "completed"


class TestSummaryServiceKnowledgeBaseSummary:
    """Test knowledge base summary methods in SummaryService."""

    def test_get_kb_summary_returns_none_when_no_summary(self):
        """Test that get_kb_summary returns None when KB has no summary."""
        mock_db = MagicMock(spec=Session)

        with patch.object(
            SummaryService,
            "get_kb_summary",
            return_value=None
        ):
            result = SummaryService.get_kb_summary(mock_db, 1, 1)
            assert result is None

    def test_get_kb_summary_returns_summary_when_exists(self):
        """Test that get_kb_summary returns summary when it exists."""
        mock_db = MagicMock(spec=Session)

        mock_summary = KnowledgeBaseSummary(
            short_summary="KB summary",
            long_summary="KB long summary",
            topics=["kb_topic1", "kb_topic2"],
            status="completed",
            last_summary_doc_count=5,
        )

        with patch.object(
            SummaryService,
            "get_kb_summary",
            return_value=mock_summary
        ):
            result = SummaryService.get_kb_summary(mock_db, 1, 1)
            assert result is not None
            assert result.short_summary == "KB summary"
            assert result.last_summary_doc_count == 5


class TestSummaryServiceThresholdCalculation:
    """Test change threshold calculation logic."""

    def test_should_trigger_kb_summary_no_previous_summary(self):
        """Test that KB summary triggers when no previous summary exists."""
        mock_db = MagicMock(spec=Session)

        with patch.object(
            SummaryService,
            "_should_trigger_kb_summary",
            return_value=(True, "No previous summary exists")
        ):
            should_trigger, reason = SummaryService._should_trigger_kb_summary(
                mock_db, 1, {}
            )
            assert should_trigger is True
            assert "No previous summary" in reason

    def test_should_trigger_kb_summary_below_threshold(self):
        """Test that KB summary doesn't trigger when below threshold."""
        mock_db = MagicMock(spec=Session)

        current_summary = {
            "last_summary_doc_count": 10,
            "status": "completed",
        }

        with patch.object(
            SummaryService,
            "_should_trigger_kb_summary",
            return_value=(False, "Change ratio 10.00% below threshold 30%")
        ):
            should_trigger, reason = SummaryService._should_trigger_kb_summary(
                mock_db, 1, current_summary
            )
            assert should_trigger is False
            assert "below threshold" in reason

    def test_should_trigger_kb_summary_above_threshold(self):
        """Test that KB summary triggers when above threshold."""
        mock_db = MagicMock(spec=Session)

        current_summary = {
            "last_summary_doc_count": 10,
            "status": "completed",
        }

        with patch.object(
            SummaryService,
            "_should_trigger_kb_summary",
            return_value=(True, "Change ratio 50.00% exceeds threshold 30%")
        ):
            should_trigger, reason = SummaryService._should_trigger_kb_summary(
                mock_db, 1, current_summary
            )
            assert should_trigger is True
            assert "exceeds threshold" in reason


class TestSummaryServiceCallbacks:
    """Test summary callback methods."""

    def test_update_document_summary_success(self):
        """Test successful document summary update."""
        mock_db = MagicMock(spec=Session)

        callback_data = DocumentSummaryCallbackRequest(
            short_summary="Updated summary",
            long_summary="Updated long summary",
            topics=["new_topic"],
            status="completed",
        )

        with patch.object(
            SummaryService,
            "update_document_summary",
            return_value=True
        ):
            result = SummaryService.update_document_summary(
                mock_db, 1, callback_data
            )
            assert result is True

    def test_update_document_summary_not_found(self):
        """Test document summary update when document not found."""
        mock_db = MagicMock(spec=Session)

        callback_data = DocumentSummaryCallbackRequest(
            status="completed",
            short_summary="test",
        )

        with patch.object(
            SummaryService,
            "update_document_summary",
            return_value=False
        ):
            result = SummaryService.update_document_summary(
                mock_db, 999, callback_data
            )
            assert result is False

    def test_update_kb_summary_success(self):
        """Test successful knowledge base summary update."""
        mock_db = MagicMock(spec=Session)

        callback_data = KnowledgeBaseSummaryCallbackRequest(
            short_summary="KB summary",
            long_summary="KB long summary",
            topics=["kb_topic"],
            status="completed",
        )

        with patch.object(
            SummaryService,
            "update_kb_summary",
            return_value=True
        ):
            result = SummaryService.update_kb_summary(
                mock_db, 1, callback_data
            )
            assert result is True

    def test_update_kb_summary_failed_status(self):
        """Test knowledge base summary update with failed status."""
        mock_db = MagicMock(spec=Session)

        callback_data = KnowledgeBaseSummaryCallbackRequest(
            status="failed",
            error="Model API error",
        )

        with patch.object(
            SummaryService,
            "update_kb_summary",
            return_value=True
        ):
            result = SummaryService.update_kb_summary(
                mock_db, 1, callback_data
            )
            assert result is True


class TestSummaryServiceAggregation:
    """Test document summary aggregation."""

    def test_aggregate_document_summaries_empty(self):
        """Test aggregation with no documents."""
        mock_db = MagicMock(spec=Session)

        with patch.object(
            SummaryService,
            "aggregate_document_summaries",
            return_value=""
        ):
            result = SummaryService.aggregate_document_summaries(mock_db, 1)
            assert result == ""

    def test_aggregate_document_summaries_with_content(self):
        """Test aggregation with documents."""
        mock_db = MagicMock(spec=Session)

        expected_result = """Document Summaries:
- Doc1: Summary 1
- Doc2: Summary 2

Topics: topic1, topic2, topic3"""

        with patch.object(
            SummaryService,
            "aggregate_document_summaries",
            return_value=expected_result
        ):
            result = SummaryService.aggregate_document_summaries(mock_db, 1)
            assert "Document Summaries" in result
            assert "Topics" in result
