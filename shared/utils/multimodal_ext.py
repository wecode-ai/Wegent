# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Multimodal extension classification — pure, dependency-free helpers.

Lives in ``shared`` so both the backend orchestrator and any other consumer
can route files by extension without depending on the multimodal dispatch
module. These helpers contain no business logic and no private dependencies.
"""

from __future__ import annotations

from typing import Optional

# ── Multimodal extension sets ────────────────────────────────────────

_MULTIMODAL_VIDEO_EXTENSIONS = frozenset(
    {"mp4", "avi", "mov", "mkv", "webm", "flv", "wmv", "m4v"}
)
_MULTIMODAL_IMAGE_EXTENSIONS = frozenset({"jpg", "jpeg", "png", "gif", "bmp", "webp"})
_MULTIMODAL_EXTENSIONS = _MULTIMODAL_VIDEO_EXTENSIONS | _MULTIMODAL_IMAGE_EXTENSIONS


def multimodal_media_type(file_extension: Optional[str]) -> str:
    """Classify a multimodal extension as ``"video"`` or ``"image"``.

    Used by dispatch + scheduling to tell the converter task which prompt and
    delivery path to use. Unknown extensions default to ``"image"`` (safer —
    video is the stricter gate).
    """
    ext = (file_extension or "").strip().lstrip(".").lower()
    if ext in _MULTIMODAL_VIDEO_EXTENSIONS:
        return "video"
    return "image"


def is_multimodal_extension(file_extension: Optional[str]) -> bool:
    """Return True if the extension is routed to the multimodal pipeline."""
    ext = (file_extension or "").strip().lstrip(".").lower()
    return ext in _MULTIMODAL_EXTENSIONS
