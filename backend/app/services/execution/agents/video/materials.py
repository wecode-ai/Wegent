# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reference-material resolution and validation for video generation."""

import os
from datetime import timedelta
from typing import Any, Optional
from urllib.parse import urlencode

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask_context import SubtaskContext
from app.services.attachment.public_link import generate_public_attachment_token


def _capabilities(model_config: dict[str, Any]) -> dict[str, Any]:
    video_config = model_config.get("videoConfig") or {}
    return video_config.get("capabilities") or {}


def _active_mode(model_config: dict[str, Any]) -> Optional[dict[str, Any]]:
    mode_id = model_config.get("generation_mode_id")
    if not mode_id:
        return None
    return next(
        (
            mode
            for mode in _capabilities(model_config).get("generation_modes") or []
            if mode.get("id") == mode_id
        ),
        None,
    )


def determine_image_mode(
    model_config: dict[str, Any],
    images: list,
    videos: list,
    audios: list,
) -> Optional[str]:
    """Resolve the provider image role from the selected generation mode."""
    del videos, audios
    if not images:
        return None

    mode_id = model_config.get("generation_mode_id")
    if mode_id == "first_last_frame":
        return "first_frame"
    if mode_id in {"reference", "omni_reference"}:
        return "reference"
    return "first_frame"


def validate_reference_materials(
    model_config: dict[str, Any],
    images: list,
    videos: list,
    audios: list,
) -> None:
    """Validate reference counts against model and mode capabilities."""
    capabilities = _capabilities(model_config)
    mode = _active_mode(model_config)
    mode_id = model_config.get("generation_mode_id")

    _validate_supported_material_types(capabilities, images, videos, audios)
    if mode_id in {"first_last_frame", "keyframe"}:
        if videos:
            raise ValueError(f"Mode '{mode_id}' does not support reference videos")
        if audios:
            raise ValueError(f"Mode '{mode_id}' does not support reference audios")
    _validate_material_metadata(capabilities, images, "image")
    _validate_material_metadata(capabilities, videos, "video")
    _validate_material_metadata(capabilities, audios, "audio")

    image_limit = capabilities.get("max_reference_images")
    if videos and capabilities.get("max_reference_images_with_video") is not None:
        image_limit = capabilities["max_reference_images_with_video"]

    if mode:
        mode_image_limit = mode.get("max_images")
        if mode.get("max_images_first_last") is not None:
            mode_image_limit = mode["max_images_first_last"]
        _validate_limit(
            images,
            mode_image_limit if mode_image_limit is not None else image_limit,
            "images",
            mode_id,
        )
        _validate_limit(
            videos,
            _first_not_none(
                mode.get("max_videos"),
                capabilities.get("max_reference_videos"),
            ),
            "videos",
            mode_id,
        )
        _validate_limit(
            audios,
            _first_not_none(
                mode.get("max_audios"),
                capabilities.get("max_reference_audios"),
            ),
            "audios",
            mode_id,
        )
        _validate_limit(
            images + videos + audios,
            _first_not_none(
                mode.get("max_total"),
                capabilities.get("max_reference_materials"),
            ),
            "materials",
            mode_id,
        )
        if (
            mode.get("image_required") or mode.get("first_frame_required")
        ) and not images:
            raise ValueError(f"Mode '{mode_id}' requires at least one reference image")
        if mode.get("video_allowed") is False and videos:
            raise ValueError(f"Mode '{mode_id}' does not support reference videos")
        if mode.get("audio_allowed") is False and audios:
            raise ValueError(f"Mode '{mode_id}' does not support reference audios")
        return

    _validate_limit(images, image_limit, "images")
    _validate_limit(videos, capabilities.get("max_reference_videos"), "videos")
    _validate_limit(audios, capabilities.get("max_reference_audios"), "audios")
    _validate_limit(
        images + videos + audios,
        capabilities.get("max_reference_materials"),
        "materials",
    )
    if capabilities.get("image_input_required") and not images:
        raise ValueError("This model requires at least one reference image")
    if capabilities.get("reference_material_required") and not (
        images or videos or audios
    ):
        raise ValueError("This model requires at least one reference material")


def _first_not_none(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _validate_supported_material_types(
    capabilities: dict[str, Any],
    images: list,
    videos: list,
    audios: list,
) -> None:
    if images and capabilities.get("supports_image_input") is False:
        raise ValueError("This model does not support reference images")
    if videos and capabilities.get("supports_video_input") is not True:
        raise ValueError("This model does not support reference videos")
    if audios and capabilities.get("supports_audio_input") is not True:
        raise ValueError("This model does not support reference audios")


def _validate_material_metadata(
    capabilities: dict[str, Any],
    materials: list,
    material_type: str,
) -> None:
    allowed_formats = {
        str(value).lower().lstrip(".")
        for value in capabilities.get(f"{material_type}_formats") or []
    }
    max_size_mb = capabilities.get(f"{material_type}_max_size_mb")
    max_size_bytes = (
        float(max_size_mb) * 1024 * 1024 if max_size_mb is not None else None
    )

    for material in materials:
        if not isinstance(material, dict):
            continue
        filename = str(material.get("filename") or "")
        extension = str(material.get("file_extension") or "")
        if not extension and filename:
            extension = os.path.splitext(filename)[1]
        normalized_extension = extension.lower().lstrip(".")
        if (
            allowed_formats
            and normalized_extension
            and normalized_extension not in allowed_formats
        ):
            raise ValueError(
                f"Unsupported reference {material_type} format: "
                f"{normalized_extension}"
            )

        file_size = material.get("file_size")
        if (
            max_size_bytes is not None
            and isinstance(file_size, (int, float))
            and file_size > max_size_bytes
        ):
            raise ValueError(
                f"Reference {material_type} exceeds maximum size " f"({max_size_mb} MB)"
            )


def _validate_limit(
    values: list,
    limit: Optional[int],
    material_type: str,
    mode_id: Optional[str] = None,
) -> None:
    if limit is None or len(values) <= limit:
        return
    mode_suffix = f" for mode '{mode_id}'" if mode_id else ""
    raise ValueError(
        f"Too many reference {material_type}{mode_suffix}: {len(values)} > {limit}"
    )


def resolve_uploaded_media(
    user_subtask_id: Optional[int],
    user_id: int,
) -> tuple[list[dict[str, str]], list[dict[str, str]], list[dict[str, str]]]:
    """Resolve uploaded media into provider-readable signed URLs."""
    if not user_subtask_id:
        return [], [], []

    from app.db.session import SessionLocal
    from app.services.context import context_service

    db = SessionLocal()
    try:
        attachments = context_service.get_attachments_by_subtask(
            db,
            user_subtask_id,
        )
        images: list[dict[str, str]] = []
        videos: list[dict[str, str]] = []
        audios: list[dict[str, str]] = []
        for attachment in attachments:
            if attachment.user_id != user_id:
                continue
            descriptor = {
                "url": _public_attachment_url(attachment.id),
                "filename": attachment.original_filename,
                "file_extension": attachment.file_extension,
                "file_size": attachment.file_size,
                "mime_type": attachment.mime_type,
            }
            mime_type = attachment.mime_type or ""
            if mime_type.startswith("image/"):
                images.append(descriptor)
            elif mime_type.startswith("video/"):
                videos.append(descriptor)
            elif mime_type.startswith("audio/"):
                audios.append(descriptor)
        return images, videos, audios
    finally:
        db.close()


def normalize_reference_materials(
    db: Session,
    values: Optional[list[str | int]],
    material_type: str,
    user_id: int,
) -> list[dict[str, Any]]:
    """Resolve attachment IDs and remote URLs into provider descriptors."""
    descriptors: list[dict[str, Any]] = []
    for raw_value in values or []:
        value = str(raw_value).strip()
        if not value:
            continue
        if value.startswith(("http://", "https://", "data:")):
            descriptors.append({"url": value})
            continue
        if not value.isdigit():
            raise ValueError(
                f"Invalid reference {material_type}: use an attachment ID or URL"
            )

        attachment = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.id == int(value),
                SubtaskContext.user_id == user_id,
                SubtaskContext.context_type == "attachment",
            )
            .first()
        )
        if not attachment:
            raise ValueError(f"Reference attachment not found: {value}")
        mime_type = attachment.mime_type or ""
        if not mime_type.startswith(f"{material_type}/"):
            raise ValueError(f"Attachment {value} is not a {material_type} attachment")
        descriptors.append(
            {
                "url": _public_attachment_url(attachment.id),
                "filename": attachment.original_filename,
                "file_extension": attachment.file_extension,
                "file_size": attachment.file_size,
                "mime_type": mime_type,
            }
        )
    return descriptors


def _public_attachment_url(attachment_id: int) -> str:
    public_base_url = settings.ATTACHMENT_PUBLIC_BASE_URL.strip().rstrip("/")
    if not public_base_url:
        raise ValueError(
            "ATTACHMENT_PUBLIC_BASE_URL must be configured to send local "
            "attachments to a remote video provider"
        )
    token = generate_public_attachment_token(
        attachment_id,
        timedelta(hours=1),
    )
    query = urlencode({"token": token})
    return f"{public_base_url}/api/attachments/download/shared?{query}"
