# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Video chapter metadata extraction for generated ``*.video.md`` files."""

from __future__ import annotations

import re
from typing import Any, Sequence

from llama_index.core.schema import BaseNode

VIDEO_SEGMENT_PATTERN = re.compile(
    r"^#{1,6}\s+.*?\[\s*(\d{1,2}):(\d{2}):(\d{2})\s*-\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})\s*\]",
    re.MULTILINE,
)


def _to_seconds(hours: str, minutes: str, seconds: str) -> int | None:
    minute = int(minutes)
    second = int(seconds)
    if minute > 59 or second > 59:
        return None
    return int(hours) * 3600 + minute * 60 + second


def extract_video_segment_metadata(text: str) -> dict[str, Any] | None:
    """Return validated time metadata from a generated video chapter heading."""
    match = VIDEO_SEGMENT_PATTERN.search(text)
    if match is None:
        return None
    start_sec = _to_seconds(*match.groups()[:3])
    end_sec = _to_seconds(*match.groups()[3:])
    if start_sec is None or end_sec is None or end_sec <= start_sec:
        return None
    return {
        "video_segment_id": f"segment_{start_sec}_{end_sec}",
        "video_start_sec": start_sec,
        "video_end_sec": end_sec,
    }


def enrich_video_segment_nodes(nodes: Sequence[BaseNode]) -> list[BaseNode]:
    """Attach time metadata only to nodes originating from ``*.video.md``."""
    enriched = list(nodes)
    for node in enriched:
        filename = str((node.metadata or {}).get("filename", "")).lower()
        if not filename.endswith(".video"):
            continue
        segment_metadata = extract_video_segment_metadata(node.text)
        if segment_metadata:
            node.metadata.update(segment_metadata)
    return enriched
