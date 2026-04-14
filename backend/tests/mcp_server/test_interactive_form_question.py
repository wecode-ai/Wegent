# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for interactive_form_question MCP tool."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.interactive_form_question import (
    _generate_ask_id,
    interactive_form_question,
)


class TestGenerateAskId:
    """Tests for _generate_ask_id helper."""

    def test_format(self):
        assert _generate_ask_id(456) == "ask_456"

    def test_deterministic(self):
        ids = [_generate_ask_id(42) for _ in range(10)]
        assert len(set(ids)) == 1

    def test_unique_per_subtask(self):
        ids = [_generate_ask_id(i) for i in range(100)]
        assert len(set(ids)) == 100


class TestInteractiveFormTool:
    """Tests for interactive_form_question async tool."""

    def _make_token(self, task_id=1, subtask_id=2):
        return TaskTokenInfo(
            task_id=task_id,
            subtask_id=subtask_id,
            user_id=9,
            user_name="tester",
        )

    @pytest.mark.asyncio
    async def test_returns_silent_exit(self):
        """interactive_form_question always returns __silent_exit__."""
        token = self._make_token()
        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            new_callable=AsyncMock,
        ):
            result = await interactive_form_question(
                token_info=token, question="Any question?"
            )

        assert result["__silent_exit__"] is True
        assert "reason" in result

    @pytest.mark.asyncio
    async def test_single_question_choice_mode(self):
        """Single-question mode with options keeps input_type='choice'."""
        token = self._make_token()
        captured = {}

        async def capture(task_id, subtask_id, question_data):
            captured.update(question_data)

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            side_effect=capture,
        ):
            await interactive_form_question(
                token_info=token,
                question="Pick one",
                options=[{"label": "A", "value": "a"}],
                input_type="choice",
            )

        assert captured["input_type"] == "choice"
        assert captured["question"] == "Pick one"
        assert captured["task_id"] == token.task_id
        assert captured["subtask_id"] == token.subtask_id
        assert captured["type"] == "interactive_form_question"

    @pytest.mark.asyncio
    async def test_single_question_no_options_becomes_text(self):
        """input_type is forced to 'text' when no options provided."""
        token = self._make_token()
        captured = {}

        async def capture(task_id, subtask_id, question_data):
            captured.update(question_data)

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            side_effect=capture,
        ):
            await interactive_form_question(
                token_info=token,
                question="Enter anything",
                input_type="choice",  # overridden to 'text'
                options=None,
            )

        assert captured["input_type"] == "text"

    @pytest.mark.asyncio
    async def test_multi_question_mode(self):
        """Multi-question mode normalizes each question."""
        token = self._make_token()
        captured = {}

        async def capture(task_id, subtask_id, question_data):
            captured.update(question_data)

        questions = [
            {
                "id": "q1",
                "question": "Choice?",
                "options": [{"label": "A", "value": "a"}],
            },
            {"id": "q2", "question": "Text?"},
        ]

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            side_effect=capture,
        ):
            await interactive_form_question(token_info=token, questions=questions)

        assert "questions" in captured
        assert len(captured["questions"]) == 2
        # q1 has options → choice
        assert captured["questions"][0]["input_type"] == "choice"
        # q2 has no options → text
        assert captured["questions"][1]["input_type"] == "text"

    @pytest.mark.asyncio
    async def test_notify_frontend_called(self):
        """_notify_frontend is called with correct arguments."""
        token = self._make_token(task_id=10, subtask_id=20)
        mock_notify = AsyncMock()

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            mock_notify,
        ):
            await interactive_form_question(token_info=token, question="Hello?")

        mock_notify.assert_awaited_once()
        call_kwargs = mock_notify.call_args
        assert call_kwargs.kwargs["task_id"] == 10
        assert call_kwargs.kwargs["subtask_id"] == 20
        assert call_kwargs.kwargs["question_data"]["question"] == "Hello?"

    @pytest.mark.asyncio
    async def test_ask_id_in_question_data(self):
        """question_data contains correct ask_id derived from subtask_id."""
        token = self._make_token(subtask_id=99)
        captured = {}

        async def capture(task_id, subtask_id, question_data):
            captured.update(question_data)

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            side_effect=capture,
        ):
            await interactive_form_question(token_info=token, question="Q?")

        assert captured["ask_id"] == "ask_99"
