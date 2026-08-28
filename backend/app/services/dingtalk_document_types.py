# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Supported DingTalk snapshot formats, independent of account configuration."""

from typing import Any

DOWNLOAD_EXTENSIONS = frozenset({"pdf", "docx", "pptx", "xlsx", "csv", "txt", "md"})


def get_import_extension(node: dict[str, Any]) -> str | None:
    """Resolve the attachment format from official node metadata."""
    kind = str(node.get("nodeType") or "").strip().lower()
    content_type = str(node.get("contentType") or "").strip().upper()
    extension = str(node.get("extension") or "").strip().lower()
    if kind == "folder":
        return None
    if content_type == "ALIDOC":
        return {"adoc": "md", "able": "xlsx", "axls": "xlsx"}.get(extension)
    if kind == "file" and content_type and extension in DOWNLOAD_EXTENSIONS:
        return extension
    return None
