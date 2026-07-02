# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared display-field derivation for subtask contexts."""

from __future__ import annotations

from typing import Any


def build_context_display_fields(
    context_type: str,
    type_data: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build public display fields for a SubtaskContext."""
    data = type_data or {}

    if context_type == "external_web_content":
        return _build_external_web_content_aggregate_fields(data)

    if context_type == "attachment" and data.get("source") == "external_web_content":
        fields = _build_external_web_content_fields(data)
        fields.update(_build_attachment_fields(data))
        return fields

    if context_type == "attachment":
        return _build_attachment_fields(data)

    if context_type == "knowledge_base":
        return {
            "knowledge_id": data.get("knowledge_id"),
            "document_count": data.get("document_count"),
            "document_ids": data.get("document_ids"),
            "scope_restricted": data.get("scope_restricted"),
        }

    if context_type == "table":
        table_url = data.get("url")
        return {
            "document_id": data.get("document_id"),
            "source_config": {"url": table_url} if table_url else None,
        }

    if context_type == "selected_documents":
        document_ids = data.get("document_ids") or []
        return {
            "document_count": len(document_ids) if isinstance(document_ids, list) else 0
        }

    if context_type == "external_knowledge":
        return {
            "external_provider": data.get("provider"),
            "external_mode": data.get("mode"),
            "external_id": data.get("id"),
            "external_scope": data.get("scope"),
            "external_target_type": data.get("target_type"),
            "external_node_id": data.get("node_id"),
            "external_document_id": data.get("document_id"),
            "external_parent_id": data.get("parent_id"),
        }

    return {}


def _build_attachment_fields(type_data: dict[str, Any]) -> dict[str, Any]:
    return {
        "file_extension": type_data.get("file_extension"),
        "file_size": type_data.get("file_size"),
        "mime_type": type_data.get("mime_type"),
    }


def _build_external_web_content_fields(type_data: dict[str, Any]) -> dict[str, Any]:
    media_type = type_data.get("external_media_type") or "video"
    if media_type == "text":
        return {
            "external_media_type": "text",
            "text_count": 1,
            "site": type_data.get("site") or _first_raw_item(type_data).get("site"),
            "source_url": type_data.get("external_source_url"),
            "cover_url": _first_raw_item(type_data).get("cover_s3")
            or _first_raw_item(type_data).get("cover"),
        }
    if media_type == "comments":
        return {
            "external_media_type": "comments",
            "comment_count": type_data.get("comment_count"),
            "fetched_comment_count": type_data.get("fetched_comment_count"),
            "site": type_data.get("site") or _first_raw_item(type_data).get("site"),
            "source_url": type_data.get("external_source_url"),
            "cover_url": _first_raw_item(type_data).get("cover_s3")
            or _first_raw_item(type_data).get("cover"),
        }

    item = _find_external_web_video_item(type_data)
    return {
        "external_media_type": "video",
        "video_count": 1,
        "site": item.get("site"),
        "source_url": type_data.get("external_source_url"),
        "cover_url": item.get("cover_s3") or item.get("cover"),
    }


def _build_external_web_content_aggregate_fields(
    type_data: dict[str, Any],
) -> dict[str, Any]:
    return {
        "external_media_type": type_data.get("external_media_type") or "mixed",
        "video_count": type_data.get("video_count") or 0,
        "image_count": type_data.get("image_count") or 0,
        "comment_count": type_data.get("comment_count"),
        "fetched_comment_count": type_data.get("fetched_comment_count"),
        "site": type_data.get("site") or _first_raw_item(type_data).get("site"),
        "source_url": type_data.get("external_source_url"),
        "cover_url": type_data.get("cover_url")
        or _first_raw_item(type_data).get("cover_s3")
        or _first_raw_item(type_data).get("cover"),
    }


def _find_external_web_video_item(type_data: dict[str, Any]) -> dict[str, Any]:
    video_index = type_data.get("external_video_index")
    if not isinstance(video_index, int) or video_index < 0:
        video_index = 0

    seen_urls: set[str] = set()
    videos: list[dict[str, Any]] = []
    for item in _as_raw_items(type_data.get("raw_result")):
        video_url = item.get("video_url_s3")
        if not isinstance(video_url, str) or not video_url.strip():
            continue
        video_url = video_url.strip()
        if video_url in seen_urls:
            continue
        seen_urls.add(video_url)
        videos.append(item)

    if video_index < len(videos):
        return videos[video_index]
    return videos[0] if videos else {}


def _first_raw_item(type_data: dict[str, Any]) -> dict[str, Any]:
    items = _as_raw_items(type_data.get("raw_result"))
    return items[0] if items else {}


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _as_raw_items(raw_result: Any) -> list[dict[str, Any]]:
    if isinstance(raw_result, list):
        return [item for item in raw_result if isinstance(item, dict)]
    if isinstance(raw_result, dict):
        for key in ("items", "list", "videos", "data"):
            nested = raw_result.get(key)
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
        return [raw_result]
    return []
