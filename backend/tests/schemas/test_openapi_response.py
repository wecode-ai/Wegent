# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.openapi_response import ResponseCreateInput


def test_response_create_input_accepts_generation_options() -> None:
    request = ResponseCreateInput(
        model="default#video-agent",
        input="Generate a launch video",
        attachment_ids=[31, 12],
        wegent_options={
            "generation": {
                "resolution": "1080p",
                "ratio": "16:9",
                "duration": 5,
                "generation_mode_id": "first_last_frame",
            }
        },
    )

    generation = request.wegent_options.generation
    assert generation.resolution == "1080p"
    assert generation.ratio == "16:9"
    assert generation.duration == 5
    assert generation.generation_mode_id == "first_last_frame"


def test_generation_options_reject_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        ResponseCreateInput(
            model="default#image-agent",
            input="Generate an image",
            wegent_options={
                "generation": {
                    "size": "1024x1024",
                    "quality": "high",
                }
            },
        )
