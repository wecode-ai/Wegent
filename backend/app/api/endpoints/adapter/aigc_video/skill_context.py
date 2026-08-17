# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build video Skill context from chat generation settings and attachments."""

from typing import Any, Optional

SYSTEM_RESOURCE_USER_ID = 0
AIGC_VIDEO_SKILL_NAMES = {"prompts-to-movie-stepped"}


def build_attachment_media_content(attachments: list[Any]) -> list[dict[str, str]]:
    """Build Skill-facing media content from hosted video/audio attachments."""
    content: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for attachment in attachments:
        type_data = getattr(attachment, "type_data", None) or {}
        if not isinstance(type_data, dict):
            continue

        media_type = _attachment_media_type(type_data)
        if media_type is None:
            continue

        upload = type_data.get(f"weibo_{media_type}_upload") or {}
        media_id = upload.get("media_id") if isinstance(upload, dict) else None
        if not media_id and media_type == "video":
            metadata = type_data.get("video_metadata") or {}
            media_id = metadata.get("media_id") if isinstance(metadata, dict) else None
        if not media_id:
            continue

        key = (media_type, str(media_id))
        if key in seen:
            continue
        seen.add(key)
        content.append({"type": f"input_{media_type}", "file_id": str(media_id)})
    return content


def _attachment_media_type(type_data: dict[str, Any]) -> Optional[str]:
    mime_type = str(type_data.get("mime_type") or "").lower()
    extension = str(type_data.get("file_extension") or "").lower()
    if mime_type.startswith("video/") or extension in {
        ".avi",
        ".m4v",
        ".mkv",
        ".mov",
        ".mp4",
        ".webm",
    }:
        return "video"
    if mime_type.startswith("audio/") or extension in {
        ".aac",
        ".flac",
        ".m4a",
        ".mp3",
        ".ogg",
        ".wav",
    }:
        return "audio"
    return None


def merge_attachment_media_into_generation(
    generation: Optional[dict[str, Any]],
    attachments: list[Any],
) -> Optional[dict[str, Any]]:
    """Merge hosted attachment identifiers into video Skill configuration."""
    media_content = build_attachment_media_content(attachments)
    if not media_content:
        return generation

    merged = dict(generation or {})
    existing_content = list(merged.get("content") or [])
    existing_keys = {
        (str(item.get("type")), str(item.get("file_id")))
        for item in existing_content
        if isinstance(item, dict) and item.get("file_id")
    }
    existing_content.extend(
        item
        for item in media_content
        if (item["type"], item["file_id"]) not in existing_keys
    )
    merged["content"] = existing_content
    return merged


def inject_generation_into_public_skills(
    *,
    resolved_skills: list[dict[str, Any]],
    team_user_id: int,
    generation: Optional[dict[str, Any]],
    prompt: Optional[str],
) -> None:
    """Expose chat-selected video settings to public Skill tools."""
    if team_user_id != SYSTEM_RESOURCE_USER_ID or not generation:
        return

    for skill_data in resolved_skills:
        if (
            skill_data.get("skill_user_id") != SYSTEM_RESOURCE_USER_ID
            or skill_data.get("name") not in AIGC_VIDEO_SKILL_NAMES
        ):
            continue
        skill_config = dict(skill_data.get("config") or {})
        skill_config["generation"] = dict(generation)
        if prompt:
            skill_config["prompt"] = prompt
        skill_data["config"] = skill_config
