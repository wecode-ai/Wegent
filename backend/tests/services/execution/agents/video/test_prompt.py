# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.execution.agents.video.prompt import normalize_video_prompt


def test_removes_leading_attachment_metadata_without_marker() -> None:
    prompt = (
        "<attachment>\n"
        "[Image Attachment: reference.png | ID: 67]\n"
        "</attachment>\n"
        "Generate a short video"
    )

    assert normalize_video_prompt(prompt) == "Generate a short video"


def test_extracts_user_question_from_legacy_wrapped_prompt() -> None:
    prompt = (
        "<attachment>attachment metadata</attachment>\n\n"
        "[User Question]:\nGenerate a city flythrough"
    )

    assert normalize_video_prompt(prompt) == "Generate a city flythrough"


def test_preserves_attachment_markup_inside_user_text() -> None:
    prompt = "Explain the literal tag <attachment> in this sentence"

    assert normalize_video_prompt(prompt) == prompt
