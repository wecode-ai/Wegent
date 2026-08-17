# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints.adapter.aigc_video.clarification import (
    normalize_one_minute_video_questions,
)
from app.mcp_server.tools.interactive_form_question import (
    build_render_payload_from_tool_input,
)


def test_video_text_preferences_become_single_choice() -> None:
    questions = [
        {
            "id": "duration",
            "question": "视频时长（秒）",
            "input_type": "text",
            "default": "60",
        },
        {
            "id": "bgm",
            "question": "背景音乐风格偏好",
            "input_type": "text",
            "placeholder": "例如：钢琴、摇滚",
        },
    ]

    normalized = normalize_one_minute_video_questions(questions)

    assert normalized[0]["input_type"] == "choice"
    assert normalized[0]["multi_select"] is False
    assert normalized[0]["default"] == ["60"]
    assert [option["value"] for option in normalized[0]["options"]] == [
        "30",
        "60",
        "90",
    ]
    assert normalized[1]["input_type"] == "choice"
    assert normalized[1]["placeholder"] is None
    assert normalized[1]["default"] == ["piano"]
    assert [option["value"] for option in normalized[1]["options"]] == [
        "piano",
        "electronic",
        "orchestral",
        "ethnic",
        "none",
    ]


def test_existing_choices_receive_a_default_and_open_text_is_preserved() -> None:
    questions = [
        {
            "id": "style",
            "question": "视频风格",
            "input_type": "single_select",
            "options": [
                {"label": "写实", "value": "写实"},
                {"label": "动漫", "value": "动漫"},
            ],
        },
        {
            "id": "additional_info",
            "question": "其他补充说明",
            "input_type": "text",
        },
    ]

    normalized = normalize_one_minute_video_questions(questions)

    assert normalized[0]["input_type"] == "single_select"
    assert normalized[0]["options"] == questions[0]["options"]
    assert normalized[0]["default"] == ["写实"]
    assert normalized[1] == questions[1]


def test_existing_valid_default_is_preserved() -> None:
    questions = [
        {
            "id": "mood",
            "question": "整体情绪氛围",
            "input_type": "choice",
            "options": [
                {"label": "温馨", "value": "温馨"},
                {"label": "励志", "value": "励志"},
            ],
            "default": ["励志"],
        }
    ]

    normalized = normalize_one_minute_video_questions(questions)

    assert normalized[0]["default"] == ["励志"]


def test_interactive_form_builder_applies_video_normalization(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.api.endpoints.adapter.aigc_video.clarification."
        "_is_one_minute_video_task",
        lambda task_id: task_id == 21,
    )

    payload = build_render_payload_from_tool_input(
        task_id=21,
        subtask_id=72,
        tool_input={
            "questions": [
                {
                    "id": "duration",
                    "question": "视频时长（秒）",
                    "input_type": "text",
                    "default": "60",
                },
                {
                    "id": "bgm",
                    "question": "背景音乐风格偏好",
                    "input_type": "text",
                },
            ]
        },
    )

    assert payload is not None
    assert [question["input_type"] for question in payload["questions"]] == [
        "choice",
        "choice",
    ]
    assert all(question["options"] for question in payload["questions"])
