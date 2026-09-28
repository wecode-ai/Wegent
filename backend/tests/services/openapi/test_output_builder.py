# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import json
from unittest.mock import patch

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.services.openapi.output_builder import (
    build_response_output,
    extract_pending_user_input_state,
    sanitize_mcp_tool_output,
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


def test_sanitize_mcp_tool_output_omits_base64_image_payload():
    payload = base64.b64encode(b"\x00" * 4096).decode()

    output = sanitize_mcp_tool_output(
        json.dumps(
            [
                {"type": "text", "text": "image downloaded"},
                {"type": "image", "mimeType": "image/jpeg", "data": payload},
            ]
        )
    )

    assert output[0] == {"type": "text", "text": "image downloaded"}
    assert payload not in output[1]["data"]
    assert output[1]["data"] == "<image/jpeg payload omitted: 4096 bytes>"


def test_sanitize_mcp_tool_output_omits_data_url_payload():
    payload = base64.b64encode(b"\x00" * 1024).decode()

    output = sanitize_mcp_tool_output(
        {"type": "input_image", "image_url": f"data:image/png;base64,{payload}"}
    )

    assert output["image_url"] == "<image/png payload omitted: 1024 bytes>"


def test_sanitize_mcp_tool_output_omits_data_url_with_media_type_parameters():
    payload = base64.b64encode(b"\x00" * 1024).decode()

    output = sanitize_mcp_tool_output(
        {
            "type": "input_image",
            "image_url": f"data:image/jpeg;charset=utf-8;base64,{payload}",
        }
    )

    assert output["image_url"] == "<image/jpeg payload omitted: 1024 bytes>"


def test_sanitize_mcp_tool_output_omits_media_base64_payload_with_mime_hint():
    payload = base64.b64encode(b"\x00" * 4096).decode()

    output = sanitize_mcp_tool_output(
        {"type": "image", "mimeType": "image/jpeg", "data": payload}
    )

    assert output["data"] == "<image/jpeg payload omitted: 4096 bytes>"


def test_sanitize_mcp_tool_output_omits_audio_base64_payload_with_mime_hint():
    payload = base64.b64encode(b"\x00" * 2048).decode()

    output = sanitize_mcp_tool_output(
        {"type": "audio", "mimeType": "audio/mpeg", "data": payload}
    )

    assert output["data"] == "<audio/mpeg payload omitted: 2048 bytes>"


def test_sanitize_mcp_tool_output_omits_video_base64_payload_with_mime_hint():
    payload = base64.b64encode(b"\x00" * 2048).decode()

    output = sanitize_mcp_tool_output(
        {"type": "video", "mimeType": "video/mp4", "data": payload}
    )

    assert output["data"] == "<video/mp4 payload omitted: 2048 bytes>"


def test_sanitize_mcp_tool_output_omits_audio_and_video_data_url_payloads():
    payload = base64.b64encode(b"\x00" * 1024).decode()

    output = sanitize_mcp_tool_output(
        {
            "audio_url": f"data:audio/mpeg;base64,{payload}",
            "video_url": f"data:video/mp4;base64,{payload}",
        }
    )

    assert output["audio_url"] == "<audio/mpeg payload omitted: 1024 bytes>"
    assert output["video_url"] == "<video/mp4 payload omitted: 1024 bytes>"


def test_sanitize_mcp_tool_output_keeps_long_text():
    text = "The image looks fine. " * 300

    output = sanitize_mcp_tool_output({"text": text})

    assert output["text"] == text


def test_sanitize_mcp_tool_output_keeps_base64_encoded_text():
    text = "The image looks fine. " * 300
    payload = base64.b64encode(text.encode()).decode()

    output = sanitize_mcp_tool_output(
        {"type": "text", "mimeType": "text/plain", "data": payload}
    )

    assert output["data"] == payload


def test_sanitize_mcp_tool_output_keeps_base64_encoded_non_ascii_text():
    text = "图片内容正常，未发现异常。" * 40
    payload = base64.b64encode(text.encode()).decode()

    output = sanitize_mcp_tool_output({"type": "text", "data": payload})

    assert output["data"] == payload


def test_sanitize_mcp_tool_output_keeps_non_media_data_url_with_binary_payload():
    payload = base64.b64encode(b"\x00" * 4096).decode()

    output = sanitize_mcp_tool_output(
        {
            "type": "text",
            "mimeType": "text/plain",
            "data": f"data:text/plain;base64,{payload}",
        }
    )

    assert output["data"] == f"data:text/plain;base64,{payload}"


def test_sanitize_mcp_tool_output_keeps_non_media_base64_payload():
    payload = base64.b64encode(b"\x00" * 4096).decode()

    output = sanitize_mcp_tool_output(
        {"type": "file", "mimeType": "application/pdf", "data": payload}
    )

    assert output["data"] == payload


def test_sanitize_mcp_tool_output_keeps_small_payloads():
    output = sanitize_mcp_tool_output('{"query": "SSE timeout", "count": 3}')

    assert output == {"query": "SSE timeout", "count": 3}


def test_sanitize_mcp_tool_output_drops_internal_state():
    output = sanitize_mcp_tool_output(
        {
            "pending_user_input": True,
            "pending_user_input_payload": {"tool_use_id": "call_mcp_9"},
            "reason": "form displayed",
        }
    )

    assert output == {"reason": "form displayed"}


def _mcp_image_subtask(subtask_id: int, payload: str) -> Subtask:
    return _assistant_subtask(
        subtask_id=subtask_id,
        result={
            "blocks": [
                {
                    "id": "call_mcp_image",
                    "type": "tool",
                    "tool_use_id": "call_mcp_image",
                    "tool_name": "example-media-tool",
                    "tool_input": {"url": "https://cdn.example.com/photo.jpg"},
                    "tool_output": json.dumps(
                        [
                            {"type": "text", "text": "fetched"},
                            {
                                "type": "image",
                                "mimeType": "image/jpeg",
                                "data": payload,
                            },
                        ]
                    ),
                    "tool_protocol": "mcp_call",
                    "server_label": "example-media-server",
                    "status": "done",
                }
            ]
        },
    )


def test_build_response_output_keeps_mcp_binary_output_by_default():
    payload = base64.b64encode(b"\x00" * 2048).decode()

    output = build_response_output([_mcp_image_subtask(114, payload)])

    assert len(output) == 1
    assert output[0].type == "mcp_call"
    assert output[0].output[1]["data"] == payload


def test_build_response_output_omits_mcp_binary_output_when_requested():
    payload = base64.b64encode(b"\x00" * 2048).decode()

    output = build_response_output(
        [_mcp_image_subtask(115, payload)],
        omit_mcp_binary_output=True,
    )

    assert len(output) == 1
    assert output[0].type == "mcp_call"
    assert payload not in json.dumps(output[0].output)
    assert output[0].output[1]["data"] == "<image/jpeg payload omitted: 2048 bytes>"


def _mcp_image_messages_chain_subtask(subtask_id: int, payload: str) -> Subtask:
    return _assistant_subtask(
        subtask_id=subtask_id,
        result={
            "messages_chain": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_mcp_chain",
                            "type": "function",
                            "function": {
                                "name": "example-media-tool",
                                "arguments": '{"url":"https://cdn.example.com/photo.jpg"}',
                            },
                        }
                    ],
                }
            ],
            "blocks": [
                {
                    "id": "call_mcp_chain",
                    "type": "tool",
                    "tool_use_id": "call_mcp_chain",
                    "tool_name": "example-media-tool",
                    "tool_input": {"url": "https://cdn.example.com/photo.jpg"},
                    "tool_output": json.dumps(
                        [
                            {"type": "text", "text": "fetched"},
                            {
                                "type": "image",
                                "mimeType": "image/jpeg",
                                "data": payload,
                            },
                        ]
                    ),
                    "tool_protocol": "mcp_call",
                    "server_label": "example-media-server",
                    "status": "done",
                }
            ],
        },
    )


def test_build_response_output_keeps_messages_chain_binary_output_by_default():
    payload = base64.b64encode(b"\x00" * 2048).decode()

    output = build_response_output([_mcp_image_messages_chain_subtask(116, payload)])

    assert len(output) == 1
    assert output[0].type == "mcp_call"
    assert output[0].output[1]["data"] == payload


def test_build_response_output_omits_messages_chain_binary_output_when_requested():
    payload = base64.b64encode(b"\x00" * 2048).decode()

    output = build_response_output(
        [_mcp_image_messages_chain_subtask(117, payload)],
        omit_mcp_binary_output=True,
    )

    assert len(output) == 1
    assert output[0].type == "mcp_call"
    assert payload not in json.dumps(output[0].output)
    assert output[0].output[1]["data"] == "<image/jpeg payload omitted: 2048 bytes>"


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


def test_build_response_output_maps_image_block_and_refreshes_download_urls():
    subtask = _assistant_subtask(
        subtask_id=111,
        result={
            "value": "Image generation completed",
            "blocks": [
                {
                    "id": "image-1",
                    "type": "image",
                    "status": "done",
                    "image_urls": ["/api/attachments/51"],
                    "image_download_urls": ["expired-url"],
                    "image_attachment_ids": [51],
                    "image_count": 1,
                    "image_size": "1024x1024",
                }
            ],
        },
    )

    with patch(
        "app.services.openapi.output_builder.build_image_download_url",
        return_value="fresh-url",
    ):
        output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "image_generation_call"
    assert output[0].status == "completed"
    assert output[0].image_urls == ["/api/attachments/51"]
    assert output[0].image_download_urls == ["fresh-url"]
    assert output[0].image_attachment_ids == [51]
    assert output[0].metadata["size"] == "1024x1024"


def test_build_response_output_maps_video_block_with_temporary_download_url():
    subtask = _assistant_subtask(
        subtask_id=112,
        result={
            "value": "Video generation completed",
            "blocks": [
                {
                    "id": "video-1",
                    "type": "video",
                    "status": "done",
                    "video_url": "https://cdn.example/video.mp4",
                    "video_thumbnail": "thumbnail",
                    "video_duration": 5,
                    "video_attachment_id": 73,
                    "video_progress": 100,
                }
            ],
        },
    )

    with patch(
        "app.services.openapi.output_builder.build_video_download_url",
        return_value="fresh-video-url",
    ):
        output = build_response_output([subtask])

    assert len(output) == 1
    assert output[0].type == "wegent_video_generation_call"
    assert output[0].status == "completed"
    assert output[0].video_url == "fresh-video-url"
    assert output[0].video_attachment_id == 73
    assert output[0].metadata == {
        "thumbnail": "thumbnail",
        "duration": 5,
        "progress": 100,
        "download_url_expires_in_seconds": 3600,
    }


def test_build_response_output_keeps_video_url_without_attachment():
    subtask = _assistant_subtask(
        subtask_id=113,
        result={
            "blocks": [
                {
                    "id": "video-2",
                    "type": "video",
                    "status": "done",
                    "video_url": "https://cdn.example/video.mp4",
                }
            ],
        },
    )

    output = build_response_output([subtask])

    assert output[0].video_url == "https://cdn.example/video.mp4"
    assert output[0].video_attachment_id is None
    assert "download_url_expires_in_seconds" not in output[0].metadata
