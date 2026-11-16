# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.context import context_service
from app.services.execution.agents.video import extensions
from app.services.execution.agents.video.materials import (
    determine_image_mode,
    normalize_reference_materials,
    resolve_generation_reference_materials,
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


def test_uploaded_media_preserves_requested_attachment_order() -> None:
    first = SimpleNamespace(
        id=11,
        user_id=1,
        storage_backend="local",
        storage_key="attachments/first",
        updated_at=datetime(2026, 8, 12),
        original_filename="first.png",
        file_extension=".png",
        file_size=100,
        mime_type="image/png",
    )
    second = SimpleNamespace(
        id=22,
        user_id=1,
        storage_backend="local",
        storage_key="attachments/second",
        updated_at=datetime(2026, 8, 12),
        original_filename="second.png",
        file_extension=".png",
        file_size=100,
        mime_type="image/png",
    )

    with (
        patch(
            "app.db.session.SessionLocal",
            return_value=MagicMock(),
        ),
        patch.object(
            context_service,
            "get_attachments_by_subtask",
            return_value=[second, first],
        ),
    ):
        images, _, _ = resolve_uploaded_media(
            user_subtask_id=10,
            user_id=1,
            attachment_ids=[11, 22],
        )

    assert [image["attachment_id"] for image in images] == [11, 22]


def test_tool_reference_resolution_owns_its_database_session() -> None:
    db = MagicMock()
    with (
        patch("app.db.session.SessionLocal") as factory,
        patch(
            "app.services.execution.agents.video.materials.normalize_reference_materials",
            side_effect=[[{"id": "image"}], [{"id": "video"}], []],
        ) as normalize,
    ):
        factory.return_value.__enter__.return_value = db
        result = resolve_generation_reference_materials(7, [1], [2], [])
    assert result == ([{"id": "image"}], [{"id": "video"}], [])
    assert [call.args for call in normalize.call_args_list] == [
        (db, [1], "image", 7),
        (db, [2], "video", 7),
        (db, [], "audio", 7),
    ]
    factory.return_value.__exit__.assert_called_once()


@pytest.mark.parametrize("media_type", ["video", "audio"])
@pytest.mark.parametrize("entrypoint", ["chat", "tool"])
def test_hosted_reference_receives_owner_context_without_public_url(
    monkeypatch: pytest.MonkeyPatch, media_type: str, entrypoint: str
) -> None:
    extension = ".mp4" if media_type == "video" else ".mp3"
    attachment = SimpleNamespace(
        id=51,
        user_id=7,
        storage_backend="media_hosting",
        storage_key="",
        type_data={"provider_reference": {"id": "media-123"}},
        updated_at=datetime(2026, 10, 27),
        original_filename=f"reference{extension}",
        file_extension=extension,
        file_size=100,
        mime_type=f"{media_type}/test",
    )
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = attachment

    class HostedReference:
        def resolve_material(self, **context: object) -> dict:
            assert context == {
                "type_data": attachment.type_data,
                "media_type": media_type,
                "user_id": 7,
                "attachment_id": 51,
            }
            return {"external_reference": {"id": "media-123"}}

    monkeypatch.setattr(extensions, "_extensions", [HostedReference()])
    monkeypatch.setattr("app.db.session.SessionLocal", lambda: db)
    monkeypatch.setattr(
        context_service, "get_attachments_by_subtask", lambda *_args: [attachment]
    )
    monkeypatch.setattr(
        "app.services.execution.agents.video.materials.settings.ATTACHMENT_PUBLIC_BASE_URL",
        "",
    )

    if entrypoint == "chat":
        _, videos, audios = resolve_uploaded_media(10, 7, [51])
        descriptors = videos if media_type == "video" else audios
    else:
        descriptors = normalize_reference_materials(db, [51], media_type, 7)

    assert descriptors[0]["external_reference"] == {"id": "media-123"}
    assert "url" not in descriptors[0]
