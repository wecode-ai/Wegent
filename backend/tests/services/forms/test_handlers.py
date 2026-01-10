# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for form handlers."""

import pytest

from app.services.forms.base_handler import FormContext, FormHandlerResult
from app.services.forms.handlers.clarification_handler import ClarificationHandler
from app.services.forms.handlers.final_prompt_handler import FinalPromptHandler
from app.services.forms.handlers.pipeline_confirmation_handler import (
    PipelineConfirmationHandler,
)


class TestClarificationHandler:
    """Tests for ClarificationHandler."""

    @pytest.fixture
    def handler(self, test_db, test_user):
        """Create handler instance for tests."""
        return ClarificationHandler(test_db, test_user.id)

    @pytest.fixture
    def valid_form_data(self):
        """Valid clarification form data."""
        return {
            "answers": [
                {
                    "question_id": "q1",
                    "question_text": "What framework?",
                    "answer_type": "choice",
                    "value": "react",
                    "selected_labels": "React",
                },
                {
                    "question_id": "q2",
                    "question_text": "Any preferences?",
                    "answer_type": "custom",
                    "value": "Use TypeScript please",
                },
            ]
        }

    @pytest.fixture
    def context_with_task(self):
        """Context with task_id."""
        return FormContext(task_id=123)

    @pytest.mark.asyncio
    async def test_validate_success(self, handler, valid_form_data, context_with_task):
        """Test validation succeeds with valid data."""
        result = await handler.validate(valid_form_data, context_with_task)
        assert result.success is True

    @pytest.mark.asyncio
    async def test_validate_missing_task_id(self, handler, valid_form_data):
        """Test validation fails without task_id."""
        context = FormContext()
        result = await handler.validate(valid_form_data, context)

        assert result.success is False
        assert result.error_code == "MISSING_TASK_ID"

    @pytest.mark.asyncio
    async def test_validate_missing_answers(self, handler, context_with_task):
        """Test validation fails without answers."""
        result = await handler.validate({}, context_with_task)

        assert result.success is False
        assert result.error_code == "MISSING_ANSWERS"

    @pytest.mark.asyncio
    async def test_validate_empty_answer_value(self, handler, context_with_task):
        """Test validation fails with empty answer value."""
        form_data = {
            "answers": [
                {
                    "question_id": "q1",
                    "value": "",
                }
            ]
        }
        result = await handler.validate(form_data, context_with_task)

        assert result.success is False
        assert result.error_code == "EMPTY_ANSWER_VALUE"

    @pytest.mark.asyncio
    async def test_process_returns_formatted_message(
        self, handler, valid_form_data, context_with_task
    ):
        """Test process returns formatted markdown message."""
        result = await handler.process(valid_form_data, context_with_task)

        assert result.success is True
        assert result.data is not None
        assert "formatted_message" in result.data
        assert "task_id" in result.data
        assert result.data["task_id"] == 123
        assert result.data["answer_count"] == 2

    @pytest.mark.asyncio
    async def test_markdown_formatting(self, handler, context_with_task):
        """Test markdown formatting of answers."""
        form_data = {
            "answers": [
                {
                    "question_id": "q1",
                    "question_text": "Test Question",
                    "answer_type": "choice",
                    "value": "option_a",
                    "selected_labels": "Option A",
                }
            ]
        }
        result = await handler.process(form_data, context_with_task)

        markdown = result.data["formatted_message"]
        assert "## My Answers" in markdown
        assert "### Test Question" in markdown
        assert "Option A" in markdown


class TestFinalPromptHandler:
    """Tests for FinalPromptHandler."""

    @pytest.fixture
    def handler(self, test_db, test_user):
        """Create handler instance for tests."""
        return FinalPromptHandler(test_db, test_user.id)

    @pytest.mark.asyncio
    async def test_validate_success(self, handler):
        """Test validation succeeds with valid prompt."""
        form_data = {"final_prompt": "Build a REST API"}
        context = FormContext()

        result = await handler.validate(form_data, context)
        assert result.success is True

    @pytest.mark.asyncio
    async def test_validate_missing_prompt(self, handler):
        """Test validation fails without prompt."""
        result = await handler.validate({}, FormContext())

        assert result.success is False
        assert result.error_code == "MISSING_FINAL_PROMPT"

    @pytest.mark.asyncio
    async def test_validate_empty_prompt(self, handler):
        """Test validation fails with empty prompt."""
        form_data = {"final_prompt": "   "}
        result = await handler.validate(form_data, FormContext())

        assert result.success is False
        assert result.error_code == "EMPTY_PROMPT"

    @pytest.mark.asyncio
    async def test_process_returns_prompt_data(self, handler):
        """Test process returns prompt data for task creation."""
        form_data = {"final_prompt": "Build a REST API with FastAPI"}
        context = FormContext(task_id=100, team_id=5)

        result = await handler.process(form_data, context)

        assert result.success is True
        assert result.data["final_prompt"] == "Build a REST API with FastAPI"
        assert result.data["original_task_id"] == 100
        assert result.data["team_id"] == 5
        assert result.data["action"] == "create_task"


class TestPipelineConfirmationHandler:
    """Tests for PipelineConfirmationHandler."""

    @pytest.fixture
    def handler(self, test_db, test_user):
        """Create handler instance for tests."""
        return PipelineConfirmationHandler(test_db, test_user.id)

    @pytest.mark.asyncio
    async def test_validate_success(self, handler):
        """Test validation succeeds with valid data."""
        form_data = {
            "confirmed_prompt": "Process this request",
            "action": "continue",
        }
        context = FormContext(task_id=123)

        result = await handler.validate(form_data, context)
        assert result.success is True

    @pytest.mark.asyncio
    async def test_validate_missing_task_id(self, handler):
        """Test validation fails without task_id."""
        form_data = {
            "confirmed_prompt": "Process this",
            "action": "continue",
        }
        result = await handler.validate(form_data, FormContext())

        assert result.success is False
        assert result.error_code == "MISSING_TASK_ID"

    @pytest.mark.asyncio
    async def test_validate_missing_prompt(self, handler):
        """Test validation fails without confirmed_prompt."""
        form_data = {"action": "continue"}
        context = FormContext(task_id=123)

        result = await handler.validate(form_data, context)

        assert result.success is False
        assert result.error_code == "MISSING_CONFIRMED_PROMPT"

    @pytest.mark.asyncio
    async def test_validate_invalid_action(self, handler):
        """Test validation fails with invalid action."""
        form_data = {
            "confirmed_prompt": "Process this",
            "action": "invalid_action",
        }
        context = FormContext(task_id=123)

        result = await handler.validate(form_data, context)

        assert result.success is False
        assert result.error_code == "INVALID_ACTION"
