# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for evaluation module services.

These tests use mocking to avoid requiring an actual database.
"""

from datetime import datetime
from unittest.mock import MagicMock, PropertyMock, patch

import pytest

from wecode.models.evaluation import (
    EvalAnswer,
    EvalGradingTask,
    EvalPermission,
    EvalQuestion,
    EvalQuestionVersion,
    EvalTopic,
    EvalTopicVersion,
    GradingTaskStatus,
    PermissionRole,
    QuestionStatus,
    TopicStatus,
    TopicVisibility,
)


class TestTopicService:
    """Tests for TopicService class."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        db = MagicMock()
        return db

    @pytest.fixture
    def topic_service(self):
        """Create a TopicService instance."""
        from wecode.service.evaluation.topic_service import TopicService

        return TopicService()

    def test_create_topic(self, topic_service, mock_db):
        """Test creating a new topic."""
        topic = topic_service.create(
            db=mock_db,
            user_id=1,
            name="Test Topic",
            description="Test description",
            visibility=TopicVisibility.PRIVATE,
        )

        mock_db.add.assert_called_once()
        mock_db.flush.assert_called_once()

    def test_create_topic_with_grading_team(self, topic_service, mock_db):
        """Test creating a topic with grading team configured."""
        topic = topic_service.create(
            db=mock_db,
            user_id=1,
            name="Test Topic",
            visibility=TopicVisibility.PUBLIC,
            grading_team_id=123,
        )

        mock_db.add.assert_called_once()
        added_topic = mock_db.add.call_args[0][0]
        assert added_topic.grading_team_config.get("team_id") == 123

    def test_get_topic(self, topic_service, mock_db):
        """Test getting a topic by ID."""
        mock_topic = MagicMock()
        mock_topic.id = 1
        mock_topic.is_active = True
        mock_db.query.return_value.filter.return_value.first.return_value = mock_topic

        result = topic_service.get(mock_db, 1)
        assert result == mock_topic

    def test_get_topic_not_found(self, topic_service, mock_db):
        """Test getting a non-existent topic."""
        mock_db.query.return_value.filter.return_value.first.return_value = None

        result = topic_service.get(mock_db, 999)
        assert result is None

    def test_update_topic(self, topic_service, mock_db):
        """Test updating a topic."""
        mock_topic = MagicMock()
        mock_topic.extra_data = {}

        result = topic_service.update(
            db=mock_db,
            topic=mock_topic,
            name="Updated Name",
            description="Updated description",
        )

        assert mock_topic.name == "Updated Name"
        assert mock_topic.extra_data.get("description") == "Updated description"
        mock_db.flush.assert_called_once()

    def test_delete_topic(self, topic_service, mock_db):
        """Test soft deleting a topic."""
        mock_topic = MagicMock()

        result = topic_service.delete(mock_db, mock_topic)

        assert mock_topic.is_active is False
        assert result is True
        mock_db.flush.assert_called_once()


class TestQuestionService:
    """Tests for QuestionService class."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    @pytest.fixture
    def question_service(self):
        """Create a QuestionService instance."""
        from wecode.service.evaluation.question_service import QuestionService

        return QuestionService()

    def test_create_question(self, question_service, mock_db):
        """Test creating a new question."""
        question = question_service.create(
            db=mock_db,
            topic_id=1,
            user_id=1,
            title="Test Question",
            content_type="text",
            content_data={"text": "Question content"},
            criteria_data={"criteria": "Grading criteria"},
        )

        mock_db.add.assert_called_once()
        mock_db.flush.assert_called_once()

    def test_get_question(self, question_service, mock_db):
        """Test getting a question by ID."""
        mock_question = MagicMock()
        mock_question.id = 1
        mock_question.is_active = True
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_question
        )

        result = question_service.get(mock_db, 1)
        assert result == mock_question

    def test_publish_question(self, question_service, mock_db):
        """Test publishing a question."""
        mock_question = MagicMock()
        mock_question.id = 1
        mock_question.content_data = {
            "text": "Content",
            "_criteria": {"criteria": "Test"},
        }

        with patch(
            "wecode.service.evaluation.question_service.generate_version"
        ) as mock_gen:
            mock_gen.return_value = "20240115_120000_abcd"
            version = question_service.publish(mock_db, mock_question, 1)

        mock_db.add.assert_called_once()
        assert mock_question.status == QuestionStatus.PUBLISHED
        assert mock_question.current_version == "20240115_120000_abcd"


class TestPermissionService:
    """Tests for PermissionService class."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    @pytest.fixture
    def permission_service(self):
        """Create a PermissionService instance."""
        from wecode.service.evaluation.permission_service import PermissionService

        return PermissionService()

    def test_can_view_public_topic(self, permission_service, mock_db):
        """Test that anyone can view a public topic."""
        mock_topic = MagicMock()
        mock_topic.visibility = TopicVisibility.PUBLIC

        result = permission_service.can_view_topic(mock_db, mock_topic, 999)
        assert result is True

    def test_can_view_own_topic(self, permission_service, mock_db):
        """Test that creator can view their own topic."""
        mock_topic = MagicMock()
        mock_topic.visibility = TopicVisibility.PRIVATE
        mock_topic.creator_id = 1

        result = permission_service.can_view_topic(mock_db, mock_topic, 1)
        assert result is True

    def test_can_edit_topic_creator_only(self, permission_service, mock_db):
        """Test that creator can edit a topic."""
        mock_topic = MagicMock()
        mock_topic.creator_id = 1
        mock_topic.id = 1

        # Creator can edit
        assert permission_service.can_edit_topic(mock_db, mock_topic, 1) is True

    def test_can_edit_topic_question_creator(self, permission_service, mock_db):
        """Test that question_creator can edit a topic."""
        mock_topic = MagicMock()
        mock_topic.creator_id = 1
        mock_topic.id = 1

        # Setup mock chain: db.query(EvalPermission).filter(...).filter(...).first()
        mock_permission = MagicMock()
        mock_permission.role = PermissionRole.QUESTION_CREATOR

        mock_filter2 = MagicMock()
        mock_filter2.first.return_value = mock_permission

        mock_filter1 = MagicMock()
        mock_filter1.filter.return_value = mock_filter2

        mock_query = MagicMock()
        mock_query.filter.return_value = mock_filter1

        mock_db.query.return_value = mock_query

        # Question creator can edit
        result = permission_service.can_edit_topic(mock_db, mock_topic, 2)
        assert result is True

    def test_can_edit_topic_non_creator_no_permission(self, permission_service, mock_db):
        """Test that non-creator without permission cannot edit a topic."""
        mock_topic = MagicMock()
        mock_topic.creator_id = 1
        mock_topic.id = 1

        # Setup mock chain to return None (no permission found)
        mock_filter2 = MagicMock()
        mock_filter2.first.return_value = None

        mock_filter1 = MagicMock()
        mock_filter1.filter.return_value = mock_filter2

        mock_query = MagicMock()
        mock_query.filter.return_value = mock_filter1

        mock_db.query.return_value = mock_query

        # Non-creator without question_creator permission cannot edit
        result = permission_service.can_edit_topic(mock_db, mock_topic, 2)
        assert result is False

    def test_grant_permission(self, permission_service, mock_db):
        """Test granting permission to a user."""
        mock_db.query.return_value.filter.return_value.first.return_value = None

        permission = permission_service.grant_permission(
            db=mock_db,
            topic_id=1,
            user_id=2,
            role=PermissionRole.RESPONDENT,
            granted_by=1,
        )

        mock_db.add.assert_called_once()
        mock_db.flush.assert_called_once()

    def test_grant_permission_update_existing(self, permission_service, mock_db):
        """Test updating an existing permission."""
        existing_permission = MagicMock()
        existing_permission.role = PermissionRole.RESPONDENT
        mock_db.query.return_value.filter.return_value.first.return_value = (
            existing_permission
        )

        permission = permission_service.grant_permission(
            db=mock_db,
            topic_id=1,
            user_id=2,
            role=PermissionRole.GRADER,
            granted_by=1,
        )

        assert existing_permission.role == PermissionRole.GRADER
        mock_db.add.assert_not_called()

    def test_revoke_permission(self, permission_service, mock_db):
        """Test revoking permission from a user."""
        mock_permission = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_permission
        )

        result = permission_service.revoke_permission(mock_db, 1, 2)

        assert result is True
        mock_db.delete.assert_called_once_with(mock_permission)

    def test_revoke_permission_not_found(self, permission_service, mock_db):
        """Test revoking non-existent permission."""
        mock_db.query.return_value.filter.return_value.first.return_value = None

        result = permission_service.revoke_permission(mock_db, 1, 999)

        assert result is False
        mock_db.delete.assert_not_called()


class TestAnswerService:
    """Tests for AnswerService class."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    @pytest.fixture
    def answer_service(self):
        """Create an AnswerService instance."""
        from wecode.service.evaluation.answer_service import AnswerService

        return AnswerService()

    def test_submit_answer(self, answer_service, mock_db):
        """Test submitting an answer."""
        mock_question = MagicMock()
        mock_question.id = 1
        mock_question.current_version = "v1"
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_question
        )

        answer = answer_service.submit(
            db=mock_db,
            question_id=1,
            user_id=2,
            content_type="text",
            content_data={"text": "My answer"},
        )

        # Should mark previous answers as not latest
        mock_db.query.return_value.filter.return_value.update.assert_called()
        # Should add new answer
        assert mock_db.add.call_count >= 1

    def test_submit_answer_unpublished_question(self, answer_service, mock_db):
        """Test that submitting to unpublished question raises error."""
        mock_question = MagicMock()
        mock_question.current_version = ""  # Not published
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_question
        )

        with pytest.raises(ValueError, match="not been published"):
            answer_service.submit(
                db=mock_db,
                question_id=1,
                user_id=2,
                content_data={},
            )

    def test_get_latest_answer(self, answer_service, mock_db):
        """Test getting the latest answer for a question."""
        mock_answer = MagicMock()
        mock_answer.is_latest = True
        mock_db.query.return_value.filter.return_value.first.return_value = mock_answer

        result = answer_service.get_latest_answer(mock_db, 1, 2)
        assert result == mock_answer


class TestGradingService:
    """Tests for GradingService class."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    @pytest.fixture
    def grading_service(self):
        """Create a GradingService instance."""
        from wecode.service.evaluation.grading_service import GradingService

        return GradingService()

    def test_create_grading_task(self, grading_service, mock_db):
        """Test creating a grading task."""
        mock_answer = MagicMock()
        mock_answer.id = 1
        mock_answer.question_id = 1
        mock_answer.question_version = "v1"
        mock_answer.respondent_id = 2

        task = grading_service.create_task(mock_db, mock_answer)

        mock_db.add.assert_called_once()
        added_task = mock_db.add.call_args[0][0]
        assert added_task.status == GradingTaskStatus.PENDING

    def test_execute_grading_task(self, grading_service, mock_db):
        """Test executing a grading task - fails when Team not found."""
        mock_task = MagicMock()
        mock_task.status = GradingTaskStatus.PENDING
        mock_task.id = 1
        mock_task.answer_id = 1
        mock_task.question_id = 1
        mock_task.question_version = "v1"
        mock_task.respondent_id = 2
        mock_task.attempt_count = 0

        # Mock the query to return None for Team (simulating Team not found)
        mock_query = MagicMock()
        mock_query.filter.return_value.first.return_value = None
        mock_db.query.return_value = mock_query

        # Execute will set status to RUNNING first, then fail when Team not found
        result = grading_service.execute(mock_db, mock_task, team_id=123, user_id=1)

        # Task should be FAILED because Team was not found
        assert mock_task.status == GradingTaskStatus.FAILED
        assert "not found" in mock_task.error_message.lower()

    def test_complete_grading_task(self, grading_service, mock_db):
        """Test completing a grading task."""
        mock_task = MagicMock()
        mock_task.status = GradingTaskStatus.RUNNING
        mock_task.question_id = 1
        mock_task.respondent_id = 2

        result = grading_service.complete(
            mock_db,
            mock_task,
            report_content="# Grading Report\n\nGood work!",
        )

        assert mock_task.status == GradingTaskStatus.COMPLETED
        # Check that report_data contains the expected structure
        report_data = mock_task.report_data
        assert report_data["content"] == "# Grading Report\n\nGood work!"
        assert "ai_report" in report_data
        assert report_data["ai_report"]["content"] == "# Grading Report\n\nGood work!"
        assert mock_task.completed_at is not None

    def test_fail_grading_task(self, grading_service, mock_db):
        """Test failing a grading task."""
        mock_task = MagicMock()
        mock_task.status = GradingTaskStatus.RUNNING

        result = grading_service.fail(mock_db, mock_task, "Connection timeout")

        assert mock_task.status == GradingTaskStatus.FAILED
        assert mock_task.report_data == {"error": "Connection timeout"}

    def test_publish_grading_report(self, grading_service, mock_db):
        """Test publishing a grading report."""
        mock_task = MagicMock()
        mock_task.status = GradingTaskStatus.COMPLETED
        mock_task.report_data = {"content": "Original report"}

        result = grading_service.publish(mock_db, mock_task)

        assert mock_task.status == GradingTaskStatus.PUBLISHED
        assert mock_task.published_at is not None

    def test_publish_with_updated_content(self, grading_service, mock_db):
        """Test publishing with updated report content."""
        mock_task = MagicMock()
        mock_task.status = GradingTaskStatus.COMPLETED
        mock_task.report_data = {"content": "Original report"}
        mock_task.report_s3_path = ""
        mock_task.question_id = 1
        mock_task.respondent_id = 2

        result = grading_service.publish(mock_db, mock_task, "Updated report")

        # Check that final_report was created with the updated content
        report_data = mock_task.report_data
        assert report_data["content"] == "Updated report"
        assert "final_report" in report_data
        assert report_data["final_report"]["content"] == "Updated report"
        assert mock_task.status == GradingTaskStatus.PUBLISHED


class TestVersionGeneration:
    """Tests for version string generation."""

    def test_generate_version_format(self):
        """Test that version strings have correct format."""
        from wecode.service.evaluation.utils import generate_version

        version = generate_version()

        # Format: YYYYMMDD_HHmmss_XXXX
        parts = version.split("_")
        assert len(parts) == 3
        assert len(parts[0]) == 8  # YYYYMMDD
        assert len(parts[1]) == 6  # HHmmss
        assert len(parts[2]) == 4  # UUID prefix

    def test_generate_version_uniqueness(self):
        """Test that generated versions are mostly unique."""
        from wecode.service.evaluation.utils import generate_version

        versions = {generate_version() for _ in range(100)}
        # Allow for a small collision rate (99% uniqueness is acceptable)
        # due to the random component being only 4 hex digits
        assert len(versions) >= 98  # At least 98% should be unique
