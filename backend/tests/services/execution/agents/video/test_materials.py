# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest

from app.services.execution.agents.video.materials import (
    normalize_reference_materials,
    validate_reference_materials,
)


def _config(capabilities: dict, mode_id: str | None = None) -> dict:
    video_config = {"capabilities": capabilities}
    if mode_id:
        video_config["generation_mode_id"] = mode_id
    return {"videoConfig": video_config, "generation_mode_id": mode_id}


def _material(filename: str, size_mb: float = 1) -> dict:
    return {
        "url": f"https://example.com/{filename}",
        "filename": filename,
        "file_extension": filename[filename.rfind(".") :],
        "file_size": int(size_mb * 1024 * 1024),
    }


def test_rejects_unsupported_video_input() -> None:
    with pytest.raises(ValueError, match="does not support reference videos"):
        validate_reference_materials(
            _config({"supports_video_input": False}),
            [],
            [_material("reference.mp4")],
            [],
        )


def test_validates_uploaded_material_format_and_size() -> None:
    capabilities = {
        "supports_image_input": True,
        "image_formats": ["png"],
        "image_max_size_mb": 2,
    }

    with pytest.raises(ValueError, match="Unsupported reference image format"):
        validate_reference_materials(
            _config(capabilities),
            [_material("reference.jpg")],
            [],
            [],
        )

    with pytest.raises(ValueError, match="exceeds maximum size"):
        validate_reference_materials(
            _config(capabilities),
            [_material("reference.png", size_mb=3)],
            [],
            [],
        )


@pytest.mark.parametrize(
    ("videos", "audios", "error"),
    [
        ([_material("reference.mp4")], [], "does not support reference videos"),
        ([], [_material("reference.mp3")], "does not support reference audios"),
    ],
)
def test_first_last_frame_rejects_non_image_materials_without_mode_flags(
    videos: list[dict],
    audios: list[dict],
    error: str,
) -> None:
    capabilities = {
        "supports_image_input": True,
        "supports_video_input": True,
        "supports_audio_input": True,
        "generation_modes": [{"id": "first_last_frame", "label": "First/last frame"}],
    }

    with pytest.raises(ValueError, match=error):
        validate_reference_materials(
            _config(capabilities, "first_last_frame"),
            [_material("first.png")],
            videos,
            audios,
        )


def test_uses_reduced_image_limit_when_video_is_present() -> None:
    capabilities = {
        "supports_video_input": True,
        "max_reference_images": 3,
        "max_reference_images_with_video": 1,
    }

    with pytest.raises(ValueError, match="Too many reference images"):
        validate_reference_materials(
            _config(capabilities),
            [_material("first.png"), _material("second.png")],
            [_material("reference.mp4")],
            [],
        )


def test_mode_falls_back_to_global_limits() -> None:
    capabilities = {
        "supports_video_input": True,
        "max_reference_videos": 1,
        "generation_modes": [
            {
                "id": "reference",
                "label": "Reference",
                "video_allowed": True,
            }
        ],
    }

    with pytest.raises(ValueError, match="Too many reference videos"):
        validate_reference_materials(
            _config(capabilities, mode_id="reference"),
            [],
            [_material("first.mp4"), _material("second.mp4")],
            [],
        )


def test_normalize_reference_materials_accepts_remote_urls() -> None:
    result = normalize_reference_materials(
        MagicMock(),
        ["https://example.com/reference.png"],
        "image",
        user_id=1,
    )

    assert result == [{"url": "https://example.com/reference.png"}]


def test_normalize_reference_materials_rejects_local_paths() -> None:
    with pytest.raises(ValueError, match="attachment ID or URL"):
        normalize_reference_materials(
            MagicMock(),
            ["/home/user/reference.png"],
            "image",
            user_id=1,
        )
