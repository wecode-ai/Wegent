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


# Inline notice prepended to a truncated attachment body. It is intentionally
# length-free: the old "(truncated to N characters)" notice reported the fixed
# parse cap (not the real injected length), which drifted from the actual text
# and clashed with chat_shell's per-preview "Truncated" header field. This note
# only signals that the parsed text is partial — its main value is for execution
# modes WITHOUT the chat_shell preview (executor / device), which otherwise have
# no leading indication that the file was cut and the full file should be read.
ATTACHMENT_TRUNCATION_NOTE = (
    "(Note: parsing truncated this file; only partial content is shown below. "
    "Read the full file at the path above for the complete content.)"
)


def build_truncation_note(is_truncated: bool) -> str:
    """Return the truncation notice line (trailing newline) or empty string.

    Prepended to a truncated attachment body so every execution mode — including
    those without chat_shell's token-budget preview — knows the text is partial.
    """
    return f"{ATTACHMENT_TRUNCATION_NOTE}\n" if is_truncated else ""


# Marker inserted where the inline injected copy is truncated. Points to the
# full file referenced in the header (valid for every mode: executor/device read
# the downloaded file, chat_shell reads the sandbox file). It deliberately does
# NOT mention read_attachment — that tool is chat_shell-only; chat_shell surfaces
# it via the tool list and its own L3 hint, not via this shared marker.
_INJECT_TRUNCATION_MARKER = (
    "\n\n…[inline preview truncated; the full file is referenced in the "
    "header above]…\n\n"
)


def truncate_for_injection(text: str, max_chars: int) -> tuple[str, bool]:
    """Bound the inline attachment text to *max_chars* (contiguous head + tail).

    The injected ``<attachment>`` copy is only a preview; the full text stays
    reachable via read_attachment (chat_shell) or the downloaded file
    (executor/device). Returns ``(text, truncated)``. When truncation happens a
    coherent head and tail are kept with a single marker between them, and the
    result length stays within *max_chars*.
    """
    if max_chars <= 0 or len(text) <= max_chars:
        return text, False
    budget = max_chars - len(_INJECT_TRUNCATION_MARKER)
    if budget <= 0:
        # max_chars smaller than the marker itself: fall back to a hard head cut.
        return text[:max_chars], True
    head = int(budget * 0.6)
    tail = budget - head
    truncated = text[:head] + _INJECT_TRUNCATION_MARKER + (text[-tail:] if tail else "")
    return truncated, True


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
    # Strip control chars so a crafted filename can't break the single-line
    # header or inject extra prompt content (mirrors build_sandbox_path).
    safe_filename = (filename or "document").replace("\n", "").replace("\r", "")
    parts = [
        f"[{label}: {safe_filename} | ID: {attachment_id} | "
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
