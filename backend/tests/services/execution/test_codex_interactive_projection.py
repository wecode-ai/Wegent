# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Verify native Codex questions use the existing web form and answer contract."""

import json
from types import SimpleNamespace

import pytest

from app.models.subtask import SubtaskRole
from app.services.chat.interactive_forms import validate_interactive_form_answer
from app.services.execution.dispatcher import ResponsesAPIEventParser
from app.services.execution.interactive_form_render import (
    build_interactive_form_render_payload,
)
from shared.models import EventType


@pytest.mark.parametrize(
    "mcp_result", [False, True], ids=["native-question", "mcp-form"]
)
def test_codex_tool_events_render_a_pending_form_and_accept_its_answer(
    monkeypatch, mcp_result
):
    parser = ResponsesAPIEventParser()
    tool_id = "codex-interaction-unique-request"
    arguments = {
        "questions": [
            {
                "id": "destination",
                "question": "Where should the report be saved?",
                "input_type": "choice",
                "options": [{"label": "Workspace", "value": "Workspace"}],
                "required": True,
                "multi_select": False,
            },
            {
                "id": "filename",
                "question": "Which filename?",
                "input_type": "text",
                "options": [],
                "required": True,
                "multi_select": False,
            },
        ]
    }
    item = {
        "type": "function_call",
        "id": tool_id,
        "call_id": tool_id,
        "name": "interactive_form_question",
        "arguments": json.dumps(arguments),
    }
    parser.parse(
        task_id=100,
        subtask_id=200,
        message_id=3,
        event_type="response.output_item.added",
        data={"item": item},
    )
    deferred = {
        "__deferred_user_input__": True,
        "success": True,
        "status": "waiting_for_user_response",
    }
    output = (
        {
            "content": [{"type": "text", "text": json.dumps(deferred)}],
            "structuredContent": {"result": json.dumps(deferred)},
        }
        if mcp_result
        else deferred
    )
    result = parser.parse(
        task_id=100,
        subtask_id=200,
        message_id=3,
        event_type="response.output_item.done",
        data={"item": {**item, "status": "completed", "output": json.dumps(output)}},
    )

    assert result.type == EventType.TOOL_RESULT
    payload = build_interactive_form_render_payload(result)
    assert payload["type"] == "interactive_form_question"
    assert payload["questions"][0]["options"][0]["value"] == "Workspace"
    assert payload["questions"][1]["input_type"] == "text"

    subtask = SimpleNamespace(
        role=SubtaskRole.ASSISTANT,
        id=200,
        message_id=3,
        result={
            "blocks": [
                {
                    "id": tool_id,
                    "tool_name": result.tool_name,
                    "tool_use_id": result.tool_use_id,
                    "render_payload": payload,
                }
            ]
        },
    )
    monkeypatch.setattr(
        "app.services.chat.interactive_forms.subtask_store.list_by_task_desc",
        lambda *args, **kwargs: [subtask],
    )
    validation = validate_interactive_form_answer(
        None,
        task_id=100,
        answer={
            "type": "interactive_form_question",
            "tool_use_id": tool_id,
            "answers": {"destination": "Workspace", "filename": "report.md"},
        },
    )
    assert validation.ok
    assert validation.pending_form.assistant_subtask_id == 200
