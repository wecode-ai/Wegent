# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared builders for attachment context block metadata.

Both the backend chat preprocessing (first-send) and the chat_shell history
loader (history replay) embed an ``<attachment>`` block describing each
attachment. These two sites previously each formatted the metadata header on
their own and had already drifted. This module owns the single source of truth
for that header plus the small helpers it needs (file-size formatting, download
URL, sandbox path), so the format stays consistent across both paths.

Scope note: this module is pure string formatting and intentionally has **no**
dependency on a tokenizer. Token-based preview truncation of the attachment body
lives in chat_shell (where ``tiktoken`` is available); per-runtime usage hints
(e.g. ``read_attachment``) also stay in their respective callers.
"""

from __future__ import annotations


def format_file_size(size_bytes: int) -> str:
    """Format a byte count into a human-readable string (B / KB / MB)."""
    if size_bytes >= 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    if size_bytes >= 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes} bytes"


def build_attachment_download_url(attachment_id: int) -> str:
    """Build the download URL for an attachment."""
    return f"/api/attachments/{attachment_id}/download"


def build_sandbox_path(
    task_id: int | None,
    subtask_id: int | None,
    filename: str,
) -> str | None:
    """Build the sandbox file path where the Executor downloads an attachment.

    Returns ``None`` when *task_id* or *subtask_id* is missing. Control
    characters in *filename* are stripped to keep the path single-line.
    """
    if task_id is None or subtask_id is None:
        return None
    safe_filename = (filename or "document").replace("\n", "").replace("\r", "")
    return f"/home/user/{task_id}:executor:attachments/{subtask_id}/{safe_filename}"


def build_attachment_header(
    *,
    attachment_id: int,
    filename: str,
    mime_type: str | None,
    file_size: int,
    sandbox_path: str | None,
    is_image: bool = False,
) -> str:
    """Build the single-line metadata header for an attachment block.

    Documents render as ``[Attachment: ...]`` and images as
    ``[Image Attachment: ...]``. The sandbox path, when available, is appended
    so the model knows where the source file lives.
    """
    label = "Image Attachment" if is_image else "Attachment"
    formatted_size = format_file_size(file_size or 0)
    url = build_attachment_download_url(attachment_id)
    parts = [
        f"[{label}: {filename} | ID: {attachment_id} | "
        f"Type: {mime_type or 'unknown'} | Size: {formatted_size} | URL: {url}"
    ]
    if sandbox_path:
        # Images historically used "File Path in Sandbox", documents used
        # "File Path(already in sandbox)"; preserve both verbatim.
        if is_image:
            parts.append(f" | File Path in Sandbox: {sandbox_path}")
        else:
            parts.append(f" | File Path(already in sandbox): {sandbox_path}")
    parts.append("]")
    return "".join(parts)
