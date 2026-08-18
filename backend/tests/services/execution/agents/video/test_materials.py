# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.context import context_service
from app.services.execution.agents.video.materials import (
    determine_image_mode,
    normalize_reference_materials,
    resolve_uploaded_media,
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


@pytest.mark.parametrize("mode_id", ["reference", "omni_reference", "edit", "extend"])
def test_omni_reference_modes_assign_reference_image_roles(mode_id: str) -> None:
    assert (
        determine_image_mode(
            _config({}, mode_id=mode_id),
            [_material("reference.png")],
            [],
            [],
        )
        == "reference"
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


def test_uploaded_image_does_not_require_public_attachment_url() -> None:
    attachment = SimpleNamespace(
        id=51,
        user_id=1,
        storage_backend="local",
        storage_key="attachments/reference",
        updated_at=datetime(2026, 8, 12),
        original_filename="reference.png",
        file_extension=".png",
        file_size=100,
        mime_type="image/png",
    )
    db = MagicMock()

    with (
        patch(
            "app.db.session.SessionLocal",
            return_value=db,
        ),
        patch.object(
            context_service,
            "get_attachments_by_subtask",
            return_value=[attachment],
        ),
    ):
        images, videos, audios = resolve_uploaded_media(
            user_subtask_id=10,
            user_id=1,
        )

    assert videos == []
    assert audios == []
    assert images == [
        {
            "attachment_id": 51,
            "storage_backend": "local",
            "storage_key": "attachments/reference",
            "updated_at": "2026-08-12T00:00:00",
            "filename": "reference.png",
            "file_extension": ".png",
            "file_size": 100,
            "mime_type": "image/png",
        }
    ]
