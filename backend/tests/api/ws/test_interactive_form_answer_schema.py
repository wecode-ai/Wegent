# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.api.ws.events import InteractiveFormAnswerPayload


def test_interactive_form_answer_ignores_unknown_fields():
    payload = InteractiveFormAnswerPayload.model_validate(
        {
            "type": "interactive_form_question",
            "ask_id": "ask_123",
            "tool_use_id": "tool_123",
            "answers": {"genre": "fantasy"},
        }
    )

    assert payload.tool_use_id == "tool_123"
    assert payload.answers == {"genre": "fantasy"}
    assert "ask_id" not in payload.model_dump()


def test_interactive_form_answer_requires_tool_use_id():
    with pytest.raises(ValidationError):
        InteractiveFormAnswerPayload.model_validate(
            {
                "type": "interactive_form_question",
                "answers": {"genre": "fantasy"},
            }
        )
