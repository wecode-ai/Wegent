# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.subtask import Subtask, SubtaskRole
from app.services.openapi.output_builder import build_response_output


def _assistant_subtask(*, subtask_id: int, result: dict) -> Subtask:
    return Subtask(
        id=subtask_id,
        user_id=1,
        task_id=1,
        team_id=1,
        title="assistant",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        prompt="",
        result=result,
    )


def test_build_response_output_from_messages_chain_infers_shell_call():
    subtask = _assistant_subtask(
        subtask_id=101,
        result={
            "value": "done",
            "messages_chain": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_exec_1",
                            "type": "function",
                            "function": {
                                "name": "exec",
                                "arguments": '{"command":"python hello.py","timeout_seconds":30}',
                            },
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Execution finished"}],
                },
            ],
            "blocks": [
                {
                    "id": "call_exec_1",
                    "type": "tool",
                    "tool_use_id": "call_exec_1",
                    "tool_name": "exec",
                    "tool_input": {"command": "python hello.py", "timeout_seconds": 30},
                    "status": "done",
                }
            ],
        },
    )

    output = build_response_output([subtask])

    assert len(output) == 2
    assert output[0].type == "shell_call"
    assert output[0].action.commands == ["python hello.py"]
    assert output[0].action.timeout_ms == 30000
    assert output[1].type == "message"
    assert output[1].content[-1].text == "Execution finished"


def test_build_response_output_includes_reasoning_content():
    subtask = _assistant_subtask(
        subtask_id=102,
        result={
            "value": "Final answer",
            "reasoning_content": "Thinking summary",
        },
    )

    output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "message"
    assert [part.type for part in output[0].content] == ["reasoning", "output_text"]
    assert output[0].content[0].text == "Thinking summary"
    assert output[0].content[1].text == "Final answer"
