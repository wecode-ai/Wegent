# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest

from wecode.service.evaluation.text_conversion_service import TextConversionService


class TestTextConversionService:
    """Test cases for TextConversionService."""

    def test_convert_question_notes_with_empty_text(self):
        """Should return None for empty text."""
        db = MagicMock()
        session = MagicMock()
        session.id = 1

        result = TextConversionService.convert_question_notes_to_s3(db, session, 1, "")
        assert result is None

    def test_convert_question_notes_with_whitespace_only(self):
        """Should return None for whitespace-only text."""
        db = MagicMock()
        session = MagicMock()
        session.id = 1

        result = TextConversionService.convert_question_notes_to_s3(
            db, session, 1, "   \n\t  "
        )
        assert result is None

    @patch("wecode.service.evaluation.text_conversion_service.EvalStorageService")
    def test_convert_question_notes_with_s3_not_configured(self, mock_storage_class):
        """Should return mock attachment when S3 is not configured."""
        db = MagicMock()
        session = MagicMock()
        session.id = 123
        session.user_id = 456
        session.topic_id = 789

        # Mock storage service with no client (S3 not configured)
        mock_storage = MagicMock()
        mock_storage.client = None
        mock_storage_class.return_value = mock_storage

        result = TextConversionService.convert_question_notes_to_s3(
            db, session, 1, "Test notes content"
        )

        assert result is not None
        assert result["key"].startswith("exam/123/question/1/")
        assert result["filename"] == "question_1_notes.txt"
        assert result["content_type"] == "text/plain"
        assert result["file_size"] == len("Test notes content".encode("utf-8"))

    @patch("wecode.service.evaluation.text_conversion_service.EvalStorageService")
    def test_convert_question_notes_with_s3_upload_success(self, mock_storage_class):
        """Should upload to S3 and return attachment when S3 is configured."""
        db = MagicMock()
        session = MagicMock()
        session.id = 123
        session.user_id = 456
        session.topic_id = 789

        # Mock storage service with client (S3 configured)
        mock_storage = MagicMock()
        mock_storage.client = MagicMock()
        mock_storage.generate_upload_key.return_value = "evaluation/exam/456/789/1/supplementaryNotes/20250101_120000_\u4f5c\u7b54\u8bf4\u660e_20250101_120000.txt"
        mock_storage.upload_file.return_value = "evaluation/exam/456/789/1/supplementaryNotes/20250101_120000_\u4f5c\u7b54\u8bf4\u660e_20250101_120000.txt"
        mock_storage_class.return_value = mock_storage

        result = TextConversionService.convert_question_notes_to_s3(
            db, session, 1, "Test notes content"
        )

        assert result is not None
        assert result["key"].startswith("evaluation/exam/456/789/1/supplementaryNotes/")
        # Filename format should match the original implementation: 作答说明_{timestamp}.txt
        assert result["filename"].startswith("作答说明_")
        assert result["filename"].endswith(".txt")
        assert result["content_type"] == "text/plain"
        assert result["file_size"] == len("Test notes content".encode("utf-8"))

        # Verify S3 operations were called with correct parameters
        call_args = mock_storage.generate_upload_key.call_args
        assert call_args.kwargs["file_type"] == "exam_attachment"
        assert call_args.kwargs["user_id"] == 456
        assert call_args.kwargs["topic_id"] == 789
        assert call_args.kwargs["question_id"] == 1
        assert call_args.kwargs["slot"] == "supplementaryNotes"
        # Filename should match the original implementation format
        assert call_args.kwargs["filename"].startswith("作答说明_")
        assert call_args.kwargs["filename"].endswith(".txt")
        mock_storage.upload_file.assert_called_once()

    @patch("wecode.service.evaluation.text_conversion_service.EvalStorageService")
    def test_convert_question_notes_with_s3_upload_failure(self, mock_storage_class):
        """Should return None when S3 upload fails."""
        db = MagicMock()
        session = MagicMock()
        session.id = 123
        session.user_id = 456
        session.topic_id = 789

        # Mock storage service with client but upload fails
        mock_storage = MagicMock()
        mock_storage.client = MagicMock()
        mock_storage.generate_upload_key.return_value = (
            "evaluation/exam/456/789/1/supplementary_notes/question_1_notes.txt"
        )
        mock_storage.upload_file.return_value = None  # Upload fails
        mock_storage_class.return_value = mock_storage

        result = TextConversionService.convert_question_notes_to_s3(
            db, session, 1, "Test notes content"
        )

        assert result is None

    @patch("wecode.service.evaluation.text_conversion_service.EvalStorageService")
    def test_convert_question_notes_with_exception(self, mock_storage_class):
        """Should return None when exception occurs during upload."""
        db = MagicMock()
        session = MagicMock()
        session.id = 123
        session.user_id = 456
        session.topic_id = 789

        # Mock storage service that raises exception
        mock_storage = MagicMock()
        mock_storage.client = MagicMock()
        mock_storage.generate_upload_key.side_effect = Exception("S3 connection error")
        mock_storage_class.return_value = mock_storage

        result = TextConversionService.convert_question_notes_to_s3(
            db, session, 1, "Test notes content"
        )

        assert result is None

    @patch("wecode.service.evaluation.text_conversion_service.EvalStorageService")
    def test_convert_all_questions_with_mixed_data(self, mock_storage_class):
        """Should convert only questions with notes."""
        db = MagicMock()
        session = MagicMock()
        session.id = 1
        session.user_id = 100
        session.topic_id = 200

        # Mock storage service
        mock_storage = MagicMock()
        mock_storage.client = None  # S3 not configured, returns mock
        mock_storage_class.return_value = mock_storage

        answers_data = {
            "1": {"supplementaryNotes": "Notes for Q1", "supplementaryNotesFiles": []},
            "2": {"supplementaryNotes": "", "supplementaryNotesFiles": []},
            "3": {"supplementaryNotes": "Notes for Q3", "supplementaryNotesFiles": []},
        }

        result = TextConversionService.convert_all_questions_notes(
            db, session, answers_data
        )

        # Q1 and Q3 should have files, Q2 should not
        assert len(result["1"]["supplementaryNotesFiles"]) == 1
        assert result["1"]["supplementaryNotes"] == ""
        assert len(result["2"]["supplementaryNotesFiles"]) == 0
        assert len(result["3"]["supplementaryNotesFiles"]) == 1
        assert result["3"]["supplementaryNotes"] == ""

    @patch("wecode.service.evaluation.text_conversion_service.EvalStorageService")
    def test_convert_all_questions_replaces_existing_files(self, mock_storage_class):
        """Should replace existing files when converting notes (keep only latest)."""
        db = MagicMock()
        session = MagicMock()
        session.id = 1
        session.user_id = 100
        session.topic_id = 200

        # Mock storage service
        mock_storage = MagicMock()
        mock_storage.client = None  # S3 not configured, returns mock
        mock_storage_class.return_value = mock_storage

        answers_data = {
            "1": {
                "supplementaryNotes": "New notes for Q1",
                "supplementaryNotesFiles": [
                    {"key": "existing_file.txt", "name": "existing.txt"}
                ],
            },
        }

        result = TextConversionService.convert_all_questions_notes(
            db, session, answers_data
        )

        # Should replace old files with new one (only keep latest)
        assert len(result["1"]["supplementaryNotesFiles"]) == 1
        assert result["1"]["supplementaryNotesFiles"][0]["key"] != "existing_file.txt"
        assert result["1"]["supplementaryNotes"] == ""
