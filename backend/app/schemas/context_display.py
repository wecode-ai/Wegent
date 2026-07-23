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

    if context_type == "attachment" and data.get("source") == "external_web_content":
        fields = _build_external_web_video_fields(data)
        fields.update(_build_attachment_fields(data))
        return fields

    if context_type == "attachment":
        return _build_attachment_fields(data)

    if context_type == "knowledge_base":
        return {
            "knowledge_id": data.get("knowledge_id"),
            "document_count": data.get("document_count"),
            "document_ids": data.get("document_ids"),
            "folder_ids": data.get("folder_ids"),
            "folder_names": data.get("folder_names"),
            "include_subfolders": data.get("include_subfolders"),
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
        external_ref = _normalize_external_ref(data)
        provider = external_ref.get("provider")
        source_name = external_ref.get("name") or external_ref.get("id")
        target_name = external_ref.get("target_name") or source_name
        return {
            "external_ref": external_ref or None,
            "external_provider": provider,
            "external_provider_label": _external_provider_label(provider),
            "external_source_name": source_name,
            "external_target_name": target_name,
            "external_mode": external_ref.get("mode"),
            "external_id": external_ref.get("id"),
            "external_scope": external_ref.get("scope"),
            "external_target_type": external_ref.get("target_type"),
            "external_node_id": external_ref.get("node_id"),
            "external_document_id": external_ref.get("document_id"),
            "external_parent_id": external_ref.get("parent_id"),
            "retrieval_status": data.get("retrieval_status"),
        }

    return {}


def build_public_context_display_fields(
    context_type: str,
    type_data: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build share-safe display fields for a SubtaskContext."""
    fields = build_context_display_fields(context_type, type_data)
    if context_type != "external_knowledge":
        return fields

    allowed_keys = {
        "external_provider",
        "external_provider_label",
        "external_source_name",
        "external_target_name",
        "external_target_type",
        "retrieval_status",
    }
    return {
        key: value
        for key, value in fields.items()
        if key in allowed_keys and value is not None
    }


def _normalize_external_ref(type_data: dict[str, Any]) -> dict[str, Any]:
    """Read new external_ref snapshots and legacy flat external data."""
    external_ref = type_data.get("external_ref")
    if isinstance(external_ref, dict):
        return {key: value for key, value in external_ref.items() if value is not None}

    legacy_keys = (
        "provider",
        "mode",
        "id",
        "name",
        "scope",
        "target_type",
        "node_id",
        "document_id",
        "parent_id",
        "target_name",
        "boundBy",
        "boundAt",
    )
    return {
        key: type_data.get(key) for key in legacy_keys if type_data.get(key) is not None
    }


def _external_provider_label(provider: Any) -> str | None:
    if not provider:
        return None
    labels = {
        "dingtalk": "DingTalk",
    }
    return labels.get(str(provider), str(provider))


def _build_attachment_fields(type_data: dict[str, Any]) -> dict[str, Any]:
    return {
        "file_extension": type_data.get("file_extension"),
        "file_size": type_data.get("file_size"),
        "mime_type": type_data.get("mime_type"),
    }


def _build_external_web_video_fields(type_data: dict[str, Any]) -> dict[str, Any]:
    item = _find_external_web_video_item(type_data)
    return {
        "video_count": 1,
        "site": item.get("site"),
        "source_url": type_data.get("external_source_url"),
        "cover_url": item.get("cover_s3") or item.get("cover"),
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
