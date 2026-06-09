# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for interactive_form_question MCP tool."""

import inspect
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.interactive_form_question import (
    _build_deferred_tool_result,
    _build_form_render_payload,
    _notify_frontend,
    interactive_form_question,
)


class TestInteractiveFormTool:
    """Tests for interactive_form_question async tool."""

    def _make_token(self, task_id=1, subtask_id=2):
        return TaskTokenInfo(
            task_id=task_id,
            subtask_id=subtask_id,
            user_id=9,
            user_name="tester",
        )

    def test_tool_signature_only_accepts_form_questions(self):
        """The MCP tool owns form creation, not deferred answer injection."""
        signature = inspect.signature(interactive_form_question)

        assert "token_info" in signature.parameters
        assert "questions" in signature.parameters
        assert "answers" not in signature.parameters
        assert "success" not in signature.parameters
        assert "status" not in signature.parameters
        assert "message" not in signature.parameters

    @pytest.mark.asyncio
    async def test_returns_silent_exit(self):
        """interactive_form_question always returns __silent_exit__."""
        token = self._make_token()
        with (
            patch(
                "app.mcp_server.tools.interactive_form_question._has_existing_interactive_form",
                new=AsyncMock(return_value=False),
            ),
            patch(
                "app.mcp_server.tools.interactive_form_question._notify_frontend",
                new_callable=AsyncMock,
            ),
        ):
            result = await interactive_form_question(
                token_info=token,
                questions=[{"id": "q1", "question": "Any question?"}],
            )

        assert result["__silent_exit__"] is True
        assert "reason" in result

    @pytest.mark.asyncio
    async def test_return_does_not_include_user_input_payload(self):
        """interactive_form_question does not expose UI state to the model."""
        token = self._make_token(subtask_id=2)
        with (
            patch(
                "app.mcp_server.tools.interactive_form_question._has_existing_interactive_form",
                new=AsyncMock(return_value=False),
            ),
            patch(
                "app.mcp_server.tools.interactive_form_question._notify_frontend",
                new_callable=AsyncMock,
            ),
        ):
            result = await interactive_form_question(
                token_info=token,
                questions=[{"id": "q1", "question": "Any question?"}],
            )

        assert result["__silent_exit__"] is True
        assert "pending_user_input" not in result
        assert "pending_user_input_payload" not in result

    @pytest.mark.asyncio
    async def test_returns_minimal_deferred_result(self):
        """The tool result must not expose the renderable form schema to the model."""
        token = self._make_token(task_id=10, subtask_id=20)
        with (
            patch(
                "app.mcp_server.tools.interactive_form_question._has_existing_interactive_form",
                new=AsyncMock(return_value=False),
            ),
            patch(
                "app.mcp_server.tools.interactive_form_question._notify_frontend",
                new_callable=AsyncMock,
            ),
        ):
            result = await interactive_form_question(
                token_info=token,
                questions=[
                    {
                        "id": "target_lang",
                        "question": "Target language",
                        "input_type": "multi_select",
                        "options": [{"label": "English", "value": "en"}],
                    }
                ],
            )

        assert result["success"] is True
        assert result["status"] == "waiting_for_user_response"
        assert "ask_id" not in result
        assert result["__deferred_user_input__"] is True
        assert "form" not in result
        assert "questions" not in result

    @pytest.mark.asyncio
    async def test_rejects_empty_question_text(self):
        """Question text must be non-empty before a form can be rendered."""
        token = self._make_token()
        with patch(
            "app.mcp_server.tools.interactive_form_question._has_existing_interactive_form",
            new=AsyncMock(return_value=False),
        ):
            with pytest.raises(ValueError, match="question"):
                await interactive_form_question(
                    token_info=token,
                    questions=[{"id": "description", "question": "   "}],
                )

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
    async def test_multi_select_input_type_is_normalized_to_choice(self):
        """input_type='multi_select' is accepted as a choice question alias."""
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
                        "id": "features",
                        "question": "Pick features",
                        "input_type": "multi_select",
                        "options": [{"label": "A", "value": "a"}],
                    }
                ],
            )

        assert captured["questions"][0]["input_type"] == "choice"
        assert captured["questions"][0]["multi_select"] is True

    @pytest.mark.asyncio
    async def test_recovers_question_text_embedded_in_input_type(self) -> None:
        """Malformed model output can put question(...) inside input_type."""
        token = self._make_token()
        captured: dict[str, Any] = {}

        async def capture(
            task_id: int,
            subtask_id: int,
            question_data: dict[str, Any],
        ) -> None:
            captured.update(question_data)

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            side_effect=capture,
        ):
            result = await interactive_form_question(
                token_info=token,
                questions=[
                    {
                        "id": "confirm_logic",
                        "input_type": "single_choice(question(确认需求逻辑是否正确?))",
                        "multiSelect": False,
                        "options": [
                            {"label": "确认以上逻辑正确", "value": "yes"},
                            {"label": "需要调整", "value": "adjust"},
                        ],
                    }
                ],
            )

        assert result["__deferred_user_input__"] is True
        assert captured["questions"][0]["question"] == "确认需求逻辑是否正确?"
        assert captured["questions"][0]["input_type"] == "choice"
        assert captured["questions"][0]["multi_select"] is False

    @pytest.mark.asyncio
    async def test_preserves_trailing_parentheses_in_embedded_question(self) -> None:
        """Recovering embedded question text preserves legitimate trailing parens."""
        token = self._make_token()
        captured: dict[str, Any] = {}

        async def capture(
            task_id: int,
            subtask_id: int,
            question_data: dict[str, Any],
        ) -> None:
            captured.update(question_data)

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            side_effect=capture,
        ):
            await interactive_form_question(
                token_info=token,
                questions=[
                    {
                        "id": "confirm_logic",
                        "input_type": "single_choice(question(Use option A (recommended)))",
                        "options": [
                            {"label": "Confirm", "value": "confirm"},
                            {"label": "Adjust", "value": "adjust"},
                        ],
                    }
                ],
            )

        assert captured["questions"][0]["question"] == "Use option A (recommended)"
        assert captured["questions"][0]["input_type"] == "choice"

    @pytest.mark.asyncio
    async def test_accepts_camel_case_multi_select_alias(self) -> None:
        """Claude-style tool calls may use multiSelect instead of multi_select."""
        token = self._make_token()
        captured: dict[str, Any] = {}

        async def capture(
            task_id: int,
            subtask_id: int,
            question_data: dict[str, Any],
        ) -> None:
            captured.update(question_data)

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            side_effect=capture,
        ):
            await interactive_form_question(
                token_info=token,
                questions=[
                    {
                        "id": "features",
                        "question": "Pick features",
                        "input_type": "choice",
                        "multiSelect": True,
                        "options": [
                            {"label": "A", "value": "a"},
                            {"label": "B", "value": "b"},
                        ],
                    }
                ],
            )

        assert captured["questions"][0]["input_type"] == "choice"
        assert captured["questions"][0]["multi_select"] is True

    @pytest.mark.asyncio
    async def test_accepts_common_aliases_and_string_options(self) -> None:
        """Common model form aliases are normalized before rendering."""
        token = self._make_token()
        captured: dict[str, Any] = {}

        async def capture(
            task_id: int,
            subtask_id: int,
            question_data: dict[str, Any],
        ) -> None:
            captured.update(question_data)

        with patch(
            "app.mcp_server.tools.interactive_form_question._notify_frontend",
            side_effect=capture,
        ):
            await interactive_form_question(
                token_info=token,
                questions=[
                    {
                        "id": "confirm",
                        "question": "Confirm?",
                        "inputType": "single_choice",
                        "options": ["Yes", "No"],
                    },
                    {
                        "id": "note",
                        "title": "Anything else?",
                        "input_type": "text_input",
                        "required": False,
                    },
                ],
            )

        assert captured["questions"][0]["input_type"] == "choice"
        assert captured["questions"][0]["options"] == [
            {"label": "Yes", "value": "Yes", "recommended": False},
            {"label": "No", "value": "No", "recommended": False},
        ]
        assert captured["questions"][1]["question"] == "Anything else?"
        assert captured["questions"][1]["input_type"] == "text"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "input_type",
        ["textarea", "long_text", "short_text", "string", "input", "free_text"],
    )
    async def test_text_input_type_aliases_are_normalized_to_text(self, input_type):
        """Common model text input aliases are accepted and normalized."""
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
                        "id": "description",
                        "question": "Describe it",
                        "input_type": input_type,
                    }
                ],
            )

        assert captured["questions"][0]["input_type"] == "text"
        assert captured["questions"][0]["multi_select"] is False

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "input_type",
        [
            "single_select",
            "select",
            "dropdown",
            "radio",
            "radio_group",
            "enum",
            "option",
        ],
    )
    async def test_single_choice_input_type_aliases_are_normalized_to_choice(
        self, input_type
    ):
        """Common model single-choice aliases are accepted and normalized."""
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
                        "id": "source_lang",
                        "question": "Source language",
                        "input_type": input_type,
                        "options": [{"label": "Auto", "value": "auto"}],
                    }
                ],
            )

        assert captured["questions"][0]["input_type"] == "choice"
        assert captured["questions"][0]["multi_select"] is False

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "input_type",
        [
            "multiple_select",
            "multiselect",
            "multi_choice",
            "multiple_choice",
            "checkbox",
            "checkboxes",
            "checkbox_group",
        ],
    )
    async def test_multi_choice_input_type_aliases_are_normalized_to_choice(
        self, input_type
    ):
        """Common model multi-choice aliases are accepted and normalized."""
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
                        "id": "features",
                        "question": "Features",
                        "input_type": input_type,
                        "options": [{"label": "Basic", "value": "basic"}],
                    }
                ],
            )

        assert captured["questions"][0]["input_type"] == "choice"
        assert captured["questions"][0]["multi_select"] is True

    @pytest.mark.asyncio
    async def test_string_default_value_is_normalized_to_list(self):
        """Models commonly emit a single default string; normalize it."""
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
                        "id": "skill_name",
                        "question": "Skill name",
                        "input_type": "text",
                        "default": "翻译助手",
                    }
                ],
            )

        assert captured["questions"][0]["default"] == ["翻译助手"]

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
        # q1 has options -> choice
        assert captured["questions"][0]["input_type"] == "choice"
        # q2 has no options -> text
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
    async def test_question_data_has_no_generated_form_id(self):
        """The rendered form uses the tool call ID, not a separate ask_id."""
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

        assert "ask_id" not in captured

    @pytest.mark.asyncio
    async def test_requires_at_least_one_question(self):
        """The tool rejects empty question lists."""
        token = self._make_token()

        with pytest.raises(
            ValueError, match="questions must contain at least one item"
        ):
            await interactive_form_question(token_info=token, questions=[])

    @pytest.mark.asyncio
    async def test_rejects_second_form_for_same_subtask(self):
        """A subtask can display at most one interactive form."""
        token = self._make_token(subtask_id=2)
        mock_session_manager = MagicMock()
        mock_session_manager.get_blocks = AsyncMock(
            return_value=[
                {
                    "type": "tool",
                    "tool_name": "interactive_form_question",
                    "tool_use_id": "tool-1",
                    "tool_input": {"questions": [{"id": "q1", "question": "Raw?"}]},
                    "render_payload": {
                        "type": "interactive_form_question",
                        "task_id": 1,
                        "subtask_id": 2,
                        "questions": [
                            {
                                "id": "q1",
                                "question": "Raw?",
                                "input_type": "text",
                                "options": None,
                                "multi_select": False,
                                "required": True,
                                "default": None,
                                "placeholder": None,
                            }
                        ],
                    },
                }
            ]
        )
        mock_notify = AsyncMock()

        with (
            patch(
                "app.services.chat.storage.session.session_manager",
                mock_session_manager,
            ),
            patch(
                "app.mcp_server.tools.interactive_form_question._notify_frontend",
                mock_notify,
            ),
        ):
            with pytest.raises(RuntimeError, match="already displayed"):
                await interactive_form_question(
                    token_info=token,
                    questions=[{"id": "q2", "question": "Second form?"}],
                )

        mock_notify.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_allows_retry_after_raw_unrendered_tool_blocks(self):
        """Raw tool argument blocks do not count as displayed forms."""
        token = self._make_token(subtask_id=2)
        mock_session_manager = MagicMock()
        mock_session_manager.get_blocks = AsyncMock(
            return_value=[
                {
                    "type": "tool",
                    "tool_name": "mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question",
                    "tool_use_id": "tool-1",
                    "tool_input": {"questions": [{"id": "q1", "question": "First?"}]},
                },
                {
                    "type": "tool",
                    "tool_name": "mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question",
                    "tool_use_id": "tool-2",
                    "tool_input": {"questions": [{"id": "q2", "question": "Second?"}]},
                },
            ]
        )
        mock_notify = AsyncMock()

        with (
            patch(
                "app.services.chat.storage.session.session_manager",
                mock_session_manager,
            ),
            patch(
                "app.mcp_server.tools.interactive_form_question._notify_frontend",
                mock_notify,
            ),
        ):
            await interactive_form_question(
                token_info=token,
                questions=[{"id": "q2", "question": "Second form?"}],
            )

        mock_notify.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_allows_current_raw_tool_block_for_first_form(self):
        """The first call is allowed when only its current raw tool block exists."""
        token = self._make_token(subtask_id=2)
        mock_session_manager = MagicMock()
        mock_session_manager.get_blocks = AsyncMock(
            return_value=[
                {
                    "type": "tool",
                    "tool_name": "mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question",
                    "tool_use_id": "tool-current",
                    "tool_input": {"questions": [{"id": "q1", "question": "First?"}]},
                }
            ]
        )
        mock_notify = AsyncMock()

        with (
            patch(
                "app.services.chat.storage.session.session_manager",
                mock_session_manager,
            ),
            patch(
                "app.mcp_server.tools.interactive_form_question._notify_frontend",
                mock_notify,
            ),
        ):
            await interactive_form_question(
                token_info=token,
                questions=[{"id": "q1", "question": "First form?"}],
            )

        mock_notify.assert_awaited_once()


class TestFormRenderPayloadSchema:
    """Tests for the strict UI-only form schema emitted to frontend."""

    def test_rejects_choice_question_without_options(self):
        """Backend must not emit a choice question that frontend cannot render."""
        with pytest.raises(ValueError, match="choice questions"):
            _build_form_render_payload(
                {
                    "type": "interactive_form_question",
                    "task_id": 1,
                    "subtask_id": 2,
                    "questions": [
                        {
                            "id": "q1",
                            "question": "Pick one",
                            "input_type": "choice",
                            "options": None,
                            "multi_select": False,
                            "required": True,
                            "default": None,
                            "placeholder": None,
                        }
                    ],
                }
            )

    def test_rejects_unknown_input_type(self):
        """Backend must emit only frontend-supported input types."""
        with pytest.raises(ValueError, match="Input should be"):
            _build_form_render_payload(
                {
                    "type": "interactive_form_question",
                    "task_id": 1,
                    "subtask_id": 2,
                    "questions": [
                        {
                            "id": "q1",
                            "question": "Describe it",
                            "input_type": "textarea",
                            "options": None,
                            "multi_select": False,
                            "required": True,
                            "default": None,
                            "placeholder": None,
                        }
                    ],
                }
            )


class TestNotifyFrontend:
    """Tests for attaching rendered forms to existing tool blocks."""

    @pytest.mark.asyncio
    async def test_does_not_create_synthetic_block_when_tool_block_missing(self):
        mock_session_manager = MagicMock()
        mock_session_manager.get_blocks = AsyncMock(return_value=[])
        mock_session_manager.add_tool_block = AsyncMock()
        mock_session_manager.update_tool_block_status = AsyncMock()

        mock_ws_emitter = MagicMock()
        mock_ws_emitter.emit_block_created = AsyncMock()

        question_data = {
            "type": "interactive_form_question",
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

        mock_session_manager.add_tool_block.assert_not_awaited()
        mock_session_manager.update_tool_block_status.assert_not_awaited()
        mock_ws_emitter.emit_block_created.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_updates_existing_block_with_form_payload(self):
        mock_session_manager = MagicMock()
        mock_session_manager.get_blocks = AsyncMock(
            return_value=[
                {
                    "type": "tool",
                    "tool_name": "interactive_form_question",
                    "tool_use_id": "tool-123",
                    "tool_input": {"questions": []},
                }
            ]
        )
        mock_session_manager.update_tool_block_status = AsyncMock()

        mock_ws_emitter = MagicMock()
        mock_ws_emitter.emit_block_updated = AsyncMock()

        question_data = {
            "type": "interactive_form_question",
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

        mock_session_manager.update_tool_block_status.assert_awaited_once_with(
            subtask_id=2,
            tool_use_id="tool-123",
            tool_output=_build_deferred_tool_result(),
            render_payload=question_data,
        )
        mock_ws_emitter.emit_block_updated.assert_awaited_once_with(
            task_id=1,
            subtask_id=2,
            block_id="tool-123",
            tool_output=_build_deferred_tool_result(),
            render_payload=question_data,
            status="pending",
        )
