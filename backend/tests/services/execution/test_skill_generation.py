# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.execution.skill_generation import build_skill_generation_context


def test_builds_public_skill_generation_protocol() -> None:
    assert build_skill_generation_context(
        {
            "model": "Seedance-2.0-Fast",
            "model_display_name": "Seedance 2.0 Fast",
            "resolution": "720p",
            "ratio": "adaptive",
            "duration": 60,
            "generation_mode_id": "omni_reference",
            "content": [
                {"type": "input_image", "file_id": "test-image-file-id"},
                {"type": "input_video", "file_id": "test-video-file-id"},
            ],
        }
    ) == {
        "modelName": "Seedance-2.0-Fast",
        "modelDisplayName": "Seedance 2.0 Fast",
        "content": [
            {"type": "input_image", "file_id": "test-image-file-id"},
            {"type": "input_video", "file_id": "test-video-file-id"},
            {
                "type": "generate_params",
                "value": {
                    "resolution": "720p",
                    "ratio": "adaptive",
                    "duration": 60,
                    "generation_mode_id": "omni_reference",
                },
            },
        ],
    }


def test_omits_empty_optional_generation_fields() -> None:
    assert build_skill_generation_context({"model": "video-model"}) == {
        "modelName": "video-model",
        "modelDisplayName": "video-model",
        "content": [],
    }
