# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest

from wecode.service.evaluation.exam_session_service import ExamSessionService
from wecode.service.evaluation.text_conversion_service import TextConversionService


class TestAdvancePhaseWithConversion:
    """Test phase advancement with text conversion."""

    def test_advance_to_review_triggers_conversion(self):
        """Should convert text when entering review phase."""
        from unittest.mock import MagicMock, patch

        db = MagicMock()
        session = MagicMock()
        session.extra_data = {"allAnswers": {}}
        session.current_phase = "exam"
        session.topic_id = 1
        session.user_id = 1
        session.id = 1

        # Mock EvalAnswer query
        mock_answer = MagicMock()
        mock_answer.id = 1
        mock_answer.question_id = 1
        mock_answer.content_data = {"inputs": {"supplementaryNotes": "Test notes"}}

        # Patch EvalAnswer in the correct module where it's used
        with patch("wecode.models.evaluation.EvalAnswer") as mock_answer_class:
            # Setup query chain
            mock_query = MagicMock()
            mock_query.scalar_subquery.return_value = "subquery"
            mock_filter1 = MagicMock()
            mock_filter1.filter.return_value = mock_query
            mock_answer_class.query = mock_filter1

            # For the answers query
            mock_answers_query = MagicMock()
            mock_answers_query.filter.return_value = mock_answers_query
            mock_answers_query.all.return_value = [mock_answer]
            db.query = MagicMock()
            db.query.return_value = mock_answers_query

            with patch.object(
                TextConversionService,
                "convert_question_notes_to_s3",
                return_value={"key": "test", "filename": "test.txt"},
            ) as mock_convert:
                result = ExamSessionService.advance_phase_with_conversion(
                    db, session, "review"
                )

                mock_convert.assert_called_once()
                assert result.current_phase == "review"

    def test_advance_to_exam_no_conversion(self):
        """Should not convert text when entering exam phase."""
        db = MagicMock()
        session = MagicMock()
        session.extra_data = {"allAnswers": {}}
        session.current_phase = "intro"

        with patch.object(
            TextConversionService, "convert_all_questions_notes"
        ) as mock_convert:
            result = ExamSessionService.advance_phase_with_conversion(
                db, session, "exam"
            )

            mock_convert.assert_not_called()
            assert result.current_phase == "exam"

    def test_advance_to_completed_no_conversion(self):
        """Should not convert text when entering completed phase."""
        db = MagicMock()
        session = MagicMock()
        session.extra_data = {"allAnswers": {}}
        session.current_phase = "review"

        with patch.object(
            TextConversionService, "convert_all_questions_notes"
        ) as mock_convert:
            result = ExamSessionService.advance_phase_with_conversion(
                db, session, "completed"
            )

            mock_convert.assert_not_called()
            assert result.current_phase == "completed"

    def test_advance_to_review_always_updates_timestamp(self):
        """Should always update review_started_at when entering review phase."""
        db = MagicMock()
        session = MagicMock()
        # Simulate existing review_started_at from previous preview
        old_timestamp = 1000000
        session.extra_data = {
            "allAnswers": {},
            "review_started_at": old_timestamp,
        }
        session.current_phase = "exam"

        with patch.object(
            TextConversionService, "convert_all_questions_notes", return_value={}
        ):
            with patch("time.time", return_value=2000000):
                result = ExamSessionService.advance_phase_with_conversion(
                    db, session, "review"
                )

                # review_started_at should be updated to new timestamp
                assert result.extra_data["review_started_at"] == 2000000
                assert result.extra_data["review_started_at"] != old_timestamp
