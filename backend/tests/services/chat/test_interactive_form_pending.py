# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.models.subtask import SubtaskRole
from app.services.chat.interactive_forms import (
    get_pending_interactive_form,
    validate_interactive_form_answer,
)


def _subtask(
    *,
    subtask_id: int,
    role: SubtaskRole,
    message_id: int,
    result: dict | None = None,
):
    return SimpleNamespace(
        id=subtask_id,
        role=role,
        message_id=message_id,
        result=result,
    )


def _form_result(tool_use_id: str = "tool-1"):
    return {
        "blocks": [
            {
                "id": tool_use_id,
                "type": "tool",
                "tool_name": (
                    "mcp__interactive_wegent-interactive-form-question__"
                    "interactive_form_question"
                ),
                "tool_use_id": tool_use_id,
                "render_payload": {
                    "type": "interactive_form_question",
                    "task_id": 100,
                    "subtask_id": 10,
                    "questions": [
                        {
                            "id": "target",
                            "question": "Target?",
                            "input_type": "choice",
                            "options": [{"label": "English", "value": "en"}],
                        }
                    ],
                },
            }
        ],
        "stop_reason": "tool_deferred",
        "silent_exit_reason": "waiting_for_user_input",
    }


def _deferred_result(
    tool_use_id: str | None = "tool-1",
):
    result = {
        "stop_reason": "tool_deferred",
        "silent_exit_reason": "waiting_for_user_input",
        "deferred_user_input": True,
    }
    if tool_use_id is not None:
        result["deferred_user_input_tool_use_id"] = tool_use_id
    return result


def _unpromoted_tool_output_result(tool_use_id: str = "tool-1"):
    return {
        "blocks": [
            {
                "id": tool_use_id,
                "type": "tool",
                "tool_name": (
                    "interactive_wegent-interactive-form-question_"
                    "interactive_form_question"
                ),
                "tool_use_id": tool_use_id,
                "tool_input": {
                    "questions": [
                        {
                            "id": "target",
                            "question": "Target?",
                            "input_type": "choice",
                            "options": [{"label": "English", "value": "en"}],
                        }
                    ]
                },
                "tool_output": [
                    {
                        "type": "text",
                        "text": (
                            '{"__silent_exit__": true, '
                            '"__deferred_user_input__": true, '
                            '"success": true, '
                            '"status": "waiting_for_user_response"}'
                        ),
                    }
                ],
            }
        ],
        "stop_reason": "end_turn",
        "deferred_user_input": None,
        "deferred_user_input_tool_use_id": None,
    }


class _Query:
    def __init__(self, subtasks):
        self._subtasks = subtasks

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def all(self):
        return self._subtasks


class _Db:
    def __init__(self, subtasks):
        self._subtasks = subtasks

    def query(self, _model):
        return _Query(self._subtasks)


def test_get_pending_interactive_form_returns_latest_unanswered_form():
    db = _Db(
        [
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_form_result(),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    pending = get_pending_interactive_form(db, task_id=100)

    assert pending is not None
    assert pending.tool_use_id == "tool-1"
    assert pending.assistant_subtask_id == 10


def test_get_pending_interactive_form_ignores_deferred_result_metadata_without_render_payload():
    db = _Db(
        [
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_deferred_result(),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    assert get_pending_interactive_form(db, task_id=100) is None


def test_get_pending_interactive_form_ignores_unpromoted_tool_output():
    db = _Db(
        [
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_unpromoted_tool_output_result(),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    assert get_pending_interactive_form(db, task_id=100) is None


def test_get_pending_interactive_form_treats_later_user_message_as_resolved():
    db = _Db(
        [
            _subtask(subtask_id=11, role=SubtaskRole.USER, message_id=3),
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_form_result(),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    assert get_pending_interactive_form(db, task_id=100) is None


def test_validate_interactive_form_answer_rejects_plain_message_when_form_pending():
    db = _Db(
        [
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_form_result(),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    result = validate_interactive_form_answer(
        db,
        task_id=100,
        answer=None,
    )

    assert result.ok is False
    assert result.error == "pending_interactive_form"


def test_validate_interactive_form_answer_requires_matching_tool_use_id():
    db = _Db(
        [
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_form_result(),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    result = validate_interactive_form_answer(
        db,
        task_id=100,
        answer={"type": "interactive_form_question", "tool_use_id": "other"},
    )

    assert result.ok is False
    assert result.error == "interactive_form_tool_mismatch"


def test_validate_interactive_form_answer_rejects_deferred_result_metadata_without_render_payload():
    db = _Db(
        [
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_deferred_result(tool_use_id=None),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    result = validate_interactive_form_answer(
        db,
        task_id=100,
        answer={
            "type": "interactive_form_question",
            "tool_use_id": "tool-from-ui",
            "success": True,
            "status": "answered",
            "answers": {"target": "en"},
        },
    )

    assert result.ok is False
    assert result.error == "interactive_form_not_pending"


def test_validate_interactive_form_answer_rejects_unpromoted_tool_output_form():
    db = _Db(
        [
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_unpromoted_tool_output_result(tool_use_id="tool-10"),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    result = validate_interactive_form_answer(
        db,
        task_id=100,
        answer={
            "type": "interactive_form_question",
            "tool_use_id": "tool-10",
            "success": True,
            "status": "answered",
            "answers": {"target": "en"},
        },
    )

    assert result.ok is False
    assert result.error == "interactive_form_not_pending"


def test_validate_interactive_form_answer_rejects_target_form_after_later_user_message():
    db = _Db(
        [
            _subtask(subtask_id=11, role=SubtaskRole.USER, message_id=3),
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_form_result(tool_use_id="tool-10"),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    result = validate_interactive_form_answer(
        db,
        task_id=100,
        answer={
            "type": "interactive_form_question",
            "tool_use_id": "tool-10",
            "task_id": 100,
            "subtask_id": 10,
            "success": True,
            "status": "answered",
            "answers": {"target": "en"},
        },
    )

    assert result.ok is False
    assert result.error == "interactive_form_not_pending"


def test_validate_interactive_form_answer_allows_cancelled_tool_result():
    db = _Db(
        [
            _subtask(
                subtask_id=10,
                role=SubtaskRole.ASSISTANT,
                message_id=2,
                result=_form_result(),
            ),
            _subtask(subtask_id=9, role=SubtaskRole.USER, message_id=1),
        ]
    )

    result = validate_interactive_form_answer(
        db,
        task_id=100,
        answer={
            "type": "interactive_form_question",
            "tool_use_id": "tool-1",
            "success": False,
            "status": "cancelled",
            "answers": {},
            "message": "用户取消表单，改为直接描述需求",
        },
    )

    assert result.ok is True
    assert result.pending_form is not None
