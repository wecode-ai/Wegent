# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.video_generation_params import apply_video_generation_params


def _model_config() -> dict:
    return {
        "modelType": "video",
        "videoConfig": {
            "capabilities": {
                "resolutions": [{"value": "720p"}, {"value": "1080p"}],
                "aspect_ratios": [{"value": "16:9"}, {"value": "9:16"}],
                "durations_sec": [5, 10],
                "generation_modes": [{"id": "text_to_video"}],
            }
        },
    }


def test_applies_supported_video_generation_params() -> None:
    model_config = _model_config()

    apply_video_generation_params(
        model_config,
        {
            "resolution": "1080p",
            "ratio": "9:16",
            "duration": 10,
            "generation_mode_id": "text_to_video",
        },
    )

    assert model_config["videoConfig"]["resolution"] == "1080p"
    assert model_config["videoConfig"]["ratio"] == "9:16"
    assert model_config["videoConfig"]["duration"] == 10
    assert model_config["generation_mode_id"] == "text_to_video"


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"resolution": "4k"}, "Unsupported resolution"),
        ({"ratio": "1:1"}, "Unsupported aspect ratio"),
        ({"duration": 30}, "Unsupported duration"),
        ({"generation_mode_id": "image_to_video"}, "Unsupported video generation"),
    ],
)
def test_rejects_unsupported_video_generation_params(
    params: dict,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        apply_video_generation_params(_model_config(), params)
