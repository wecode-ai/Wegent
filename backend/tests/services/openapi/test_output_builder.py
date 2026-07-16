# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.services.openapi.output_builder import (
    build_response_output,
    extract_pending_user_input_state,
)


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
        status=SubtaskStatus.COMPLETED,
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
    assert output[0].status == "completed"


def test_build_response_output_preserves_thinking_block_order():
    subtask = _assistant_subtask(
        subtask_id=109,
        result={
            "value": "Final answer",
            "reasoning_content": "Before tool.After tool.",
            "blocks": [
                {
                    "id": "thinking-1",
                    "type": "thinking",
                    "content": "Before tool.",
                    "status": "done",
                },
                {
                    "id": "shell_1",
                    "type": "tool",
                    "tool_use_id": "shell_1",
                    "tool_name": "exec",
                    "tool_input": {"command": "cat /etc/os-release"},
                    "status": "done",
                },
                {
                    "id": "thinking-2",
                    "type": "thinking",
                    "content": "After tool.",
                    "status": "done",
                },
                {
                    "id": "text-1",
                    "type": "text",
                    "content": "Final answer",
                    "status": "done",
                },
            ],
        },
    )

    output = build_response_output([subtask])

    assert [item.type for item in output] == [
        "message",
        "shell_call",
        "message",
        "message",
    ]
    assert output[0].content[0].type == "reasoning"
    assert output[0].content[0].text == "Before tool."
    assert output[2].content[0].type == "reasoning"
    assert output[2].content[0].text == "After tool."
    assert output[3].content[0].type == "output_text"
    assert output[3].content[0].text == "Final answer"


def test_build_response_output_matches_tool_block_by_id():
    subtask = _assistant_subtask(
        subtask_id=103,
        result={
            "messages_chain": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_exec_2",
                            "type": "function",
                            "function": {
                                "name": "exec",
                                "arguments": '{"command":"python run.py","timeout_seconds":5}',
                            },
                        }
                    ],
                }
            ],
            "blocks": [
                {
                    "id": "other_tool",
                    "type": "tool",
                    "tool_use_id": "other_tool",
                    "tool_name": "exec",
                    "tool_input": {"command": "echo nope"},
                    "status": "done",
                },
                {
                    "id": "call_exec_2",
                    "type": "tool",
                    "tool_use_id": "call_exec_2",
                    "tool_name": "exec",
                    "tool_input": {"command": "python run.py", "timeout_seconds": 5},
                    "status": "error",
                },
            ],
        },
    )

    output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "shell_call"
    assert output[0].status == "failed"
    assert output[0].action.commands == ["python run.py"]


def test_build_response_output_marks_pending_shell_call_in_progress():
    subtask = _assistant_subtask(
        subtask_id=104,
        result={
            "messages_chain": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_exec_3",
                            "type": "function",
                            "function": {
                                "name": "exec",
                                "arguments": '{"command":"python wait.py","timeout_seconds":10}',
                            },
                        }
                    ],
                }
            ],
            "blocks": [
                {
                    "id": "call_exec_3",
                    "type": "tool",
                    "tool_use_id": "call_exec_3",
                    "tool_name": "exec",
                    "tool_input": {"command": "python wait.py", "timeout_seconds": 10},
                    "status": "pending",
                }
            ],
        },
    )

    output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "shell_call"
    assert output[0].status == "in_progress"


def test_build_response_output_preserves_failed_message_status():
    subtask = _assistant_subtask(
        subtask_id=105,
        result={"value": "partial output"},
    )
    subtask.status = SubtaskStatus.FAILED

    output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "message"
    assert output[0].status == "incomplete"


def test_build_response_output_restores_mcp_call_from_blocks():
    subtask = _assistant_subtask(
        subtask_id=106,
        result={
            "messages_chain": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_mcp_1",
                            "type": "function",
                            "function": {
                                "name": "search_docs",
                                "arguments": '{"query":"SSE timeout"}',
                            },
                        }
                    ],
                }
            ],
            "blocks": [
                {
                    "id": "call_mcp_1",
                    "type": "tool",
                    "tool_use_id": "call_mcp_1",
                    "tool_name": "search_docs",
                    "tool_input": {"query": "SSE timeout"},
                    "tool_protocol": "mcp_call",
                    "server_label": "wegent-knowledge",
                    "status": "done",
                }
            ],
        },
    )

    output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "mcp_call"
    assert output[0].name == "search_docs"
    assert output[0].server_label == "wegent-knowledge"
    assert output[0].arguments == '{"query":"SSE timeout"}'
    assert output[0].status == "completed"


def test_build_response_output_restores_mcp_call_by_unique_name_fallback():
    subtask = _assistant_subtask(
        subtask_id=107,
        result={
            "messages_chain": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "toolu_mismatched",
                            "type": "function",
                            "function": {
                                "name": "search_docs",
                                "arguments": '{"query":"SSE timeout"}',
                            },
                        }
                    ],
                }
            ],
            "blocks": [
                {
                    "id": "block_mcp_1",
                    "type": "tool",
                    "tool_use_id": "different_id",
                    "tool_name": "search_docs",
                    "tool_input": {"query": "SSE timeout"},
                    "tool_protocol": "mcp_call",
                    "server_label": "wegent-knowledge",
                    "status": "done",
                }
            ],
        },
    )

    output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "mcp_call"
    assert output[0].server_label == "wegent-knowledge"


def test_build_response_output_restores_mcp_call_output_from_blocks():
    subtask = _assistant_subtask(
        subtask_id=108,
        result={
            "blocks": [
                {
                    "id": "call_mcp_2",
                    "type": "tool",
                    "tool_use_id": "call_mcp_2",
                    "tool_name": "interactive_form_question",
                    "tool_input": {
                        "questions": [{"id": "exp_id", "question": "Enter exp id"}],
                    },
                    "tool_output": (
                        '{"pending_user_input": true, '
                        '"pending_user_input_payload": {'
                        '"type": "interactive_form_question", '
                        '"tool_use_id": "call_mcp_2", '
                        '"submit_mode": "new_response", '
                        '"submit_format": "markdown_message"}}'
                    ),
                    "tool_protocol": "mcp_call",
                    "server_label": "interactive-form",
                    "status": "done",
                }
            ]
        },
    )

    output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "mcp_call"
    assert "pending_user_input" not in output[0].output
    assert "pending_user_input_payload" not in output[0].output


def test_extract_pending_user_input_state_from_tool_blocks():
    subtask = _assistant_subtask(
        subtask_id=109,
        result={
            "blocks": [
                {
                    "id": "call_mcp_3",
                    "type": "tool",
                    "tool_use_id": "call_mcp_3",
                    "tool_name": "interactive_form_question",
                    "tool_input": {
                        "questions": [{"id": "exp_id", "question": "Enter exp id"}],
                    },
                    "tool_output": {
                        "pending_user_input": True,
                        "pending_user_input_payload": {
                            "type": "interactive_form_question",
                            "tool_use_id": "call_mcp_3",
                        },
                    },
                    "tool_protocol": "mcp_call",
                    "server_label": "interactive-form",
                    "status": "done",
                }
            ]
        },
    )

    pending_user_input, payload = extract_pending_user_input_state([subtask])

    assert pending_user_input is False
    assert payload is None


def test_extract_pending_user_input_state_rebuilds_minimal_payload_from_fallback():
    subtask = _assistant_subtask(
        subtask_id=110,
        result={
            "blocks": [
                {
                    "id": "call_mcp_4",
                    "type": "tool",
                    "tool_use_id": "call_mcp_4",
                    "tool_name": "interactive_form_question",
                    "tool_input": {
                        "questions": [{"id": "exp_id", "question": "Enter exp id"}],
                    },
                    "tool_output": {
                        "pending_user_input": True,
                        "tool_use_id": "call_mcp_4",
                    },
                    "tool_protocol": "mcp_call",
                    "server_label": "interactive-form",
                    "status": "done",
                }
            ]
        },
    )

    pending_user_input, payload = extract_pending_user_input_state([subtask])

    assert pending_user_input is False
    assert payload is None
