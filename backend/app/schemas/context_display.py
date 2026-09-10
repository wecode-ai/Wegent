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
            "folder_ids": data.get("folder_ids"),
            "folder_names": data.get("folder_names"),
            "include_subfolders": data.get("include_subfolders"),
            "scope_restricted": data.get("scope_restricted"),
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
            "site": type_data.get("site"),
            "source_url": type_data.get("external_source_url"),
            "cover_url": type_data.get("cover_url"),
        }
    if media_type == "comments":
        return {
            "external_media_type": "comments",
            "comment_count": type_data.get("comment_count"),
            "fetched_comment_count": type_data.get("fetched_comment_count"),
            "site": type_data.get("site"),
            "source_url": type_data.get("external_source_url"),
            "cover_url": type_data.get("cover_url"),
        }

    return {
        "external_media_type": "video",
        "video_count": 1,
        "site": type_data.get("site"),
        "source_url": type_data.get("external_source_url"),
        "cover_url": type_data.get("cover_url"),
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
        "site": type_data.get("site"),
        "source_url": type_data.get("external_source_url"),
        "cover_url": type_data.get("cover_url"),
    }
