# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for interactive_form_question MCP tool."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.interactive_form_question import (
    _generate_ask_id,
    _notify_frontend,
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
                token_info=token,
                questions=[{"id": "q1", "question": "Any question?"}],
            )

        assert result["__silent_exit__"] is True
        assert "reason" in result

    @pytest.mark.asyncio
    async def test_single_question_choice_mode(self):
        """A single-item questions list keeps input_type='choice' when options exist."""
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
                questions=[
                    {
                        "id": "pick_one",
                        "question": "Pick one",
                        "options": [{"label": "A", "value": "a"}],
                        "input_type": "choice",
                    }
                ],
            )

        assert len(captured["questions"]) == 1
        assert captured["questions"][0]["input_type"] == "choice"
        assert captured["questions"][0]["question"] == "Pick one"
        assert captured["task_id"] == token.task_id
        assert captured["subtask_id"] == token.subtask_id
        assert captured["type"] == "interactive_form_question"

    @pytest.mark.asyncio
    async def test_question_without_options_becomes_text(self):
        """A question without options is normalized to text input."""
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
                questions=[
                    {
                        "id": "free_text",
                        "question": "Enter anything",
                        "input_type": "choice",
                    }
                ],
            )

        assert captured["questions"][0]["input_type"] == "text"

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
            await interactive_form_question(
                token_info=token,
                questions=[{"id": "hello", "question": "Hello?"}],
            )

        mock_notify.assert_awaited_once()
        call_kwargs = mock_notify.call_args
        assert call_kwargs.kwargs["task_id"] == 10
        assert call_kwargs.kwargs["subtask_id"] == 20
        assert (
            call_kwargs.kwargs["question_data"]["questions"][0]["question"] == "Hello?"
        )

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
            await interactive_form_question(
                token_info=token,
                questions=[{"id": "q1", "question": "Q?"}],
            )

        assert captured["ask_id"] == "ask_99"

    @pytest.mark.asyncio
    async def test_requires_at_least_one_question(self):
        """The tool rejects empty question lists."""
        token = self._make_token()

        with pytest.raises(
            ValueError, match="questions must contain at least one item"
        ):
            await interactive_form_question(token_info=token, questions=[])


class TestNotifyFrontendFallback:
    """Tests for synthetic block fallback when tool block is missing."""

    @pytest.mark.asyncio
    async def test_creates_synthetic_block_when_tool_block_missing(self):
        mock_session_manager = MagicMock()
        mock_session_manager.get_blocks = AsyncMock(return_value=[])
        mock_session_manager.add_tool_block = AsyncMock()

        mock_ws_emitter = MagicMock()
        mock_ws_emitter.emit_block_created = AsyncMock()

        question_data = {
            "type": "interactive_form_question",
            "ask_id": "ask_123",
            "task_id": 1,
            "subtask_id": 2,
            "questions": [
                {
                    "id": "q1",
                    "question": "Hello?",
                    "input_type": "text",
                    "options": None,
                    "multi_select": False,
                    "required": True,
                    "default": None,
                    "placeholder": None,
                }
            ],
        }

        with (
            patch(
                "app.services.chat.storage.session.session_manager",
                mock_session_manager,
            ),
            patch(
                "app.services.chat.webpage_ws_chat_emitter.get_webpage_ws_emitter",
                return_value=mock_ws_emitter,
            ),
        ):
            await _notify_frontend(task_id=1, subtask_id=2, question_data=question_data)

        mock_session_manager.add_tool_block.assert_awaited_once_with(
            subtask_id=2,
            tool_use_id="ask_123",
            tool_name="interactive_form_question",
            tool_input=question_data,
            display_name="interactive_form_question",
        )
        mock_ws_emitter.emit_block_created.assert_awaited_once()
