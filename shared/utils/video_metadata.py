# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for video attachment metadata formatting."""

import json
from typing import Any


def format_file_size(size_bytes: int) -> str:
    """Format file size in bytes to human-readable format."""
    if size_bytes >= 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    if size_bytes >= 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes} bytes"


def build_video_attachment_header(context: Any) -> str:
    """Build a video attachment header without resolving a video URL."""
    filename = (
        getattr(context, "original_filename", None)
        or getattr(context, "name", None)
        or "video"
    )
    attachment_id = getattr(context, "id", "unknown")
    mime_type = getattr(context, "mime_type", None) or "video/mp4"
    file_size = getattr(context, "file_size", None) or 0
    formatted_size = format_file_size(file_size)

    return (
        f"[Video Attachment: {filename} | ID: {attachment_id} | "
        f"Type: {mime_type} | Size: {formatted_size}]"
    )


def build_video_history_metadata_text(context: Any) -> str:
    """Build video metadata for history when model-readable video input is unavailable."""
    metadata_text = build_video_attachment_header(context)
    type_data = getattr(context, "type_data", None) or {}
    fid = type_data.get("fid")
    if fid:
        metadata_text += "\n" + json.dumps({"fid": fid})
    return f"{metadata_text}\n"
