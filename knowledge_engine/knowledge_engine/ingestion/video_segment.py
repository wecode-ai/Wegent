# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Video chapter metadata extraction for generated ``*.video.md`` files."""

from __future__ import annotations

import re
from typing import Any, Sequence

from llama_index.core.schema import BaseNode

# Match a chapter-style heading carrying a time range. Tolerates the formats
# Gemini actually emits in practice:
#   - [HH:MM:SS - HH:MM:SS]   (prompt- mandated, square brackets, 3 segments)
#   - (MM:SS - MM:SS)         (short videos: Gemini drops the hour + parens)
#   - [MM:SS - MM:SS] / (HH:MM:SS - HH:MM:SS)   (any bracket/segment mix)
# The hour part is optional per timestamp; brackets are [] or ().
_TIME = r"(?:\d{1,2}:)?\d{1,2}:\d{2}"
VIDEO_SEGMENT_PATTERN = re.compile(
    r"\[\s*(" + _TIME + r")\s*-\s*(" + _TIME + r")\s*\]"
    r"|\(\s*(" + _TIME + r")\s*-\s*(" + _TIME + r")\s*\)"
)


def _to_seconds(value: str) -> int | None:
    """Convert ``[HH:]MM:SS`` to seconds, rejecting invalid minute/second."""
    parts = value.split(":")
    if len(parts) == 2:
        hours, minutes, seconds = "0", parts[0], parts[1]
    elif len(parts) == 3:
        hours, minutes, seconds = parts
    else:
        return None
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
    # Two alternations in the pattern: groups 1-2 for [], 3-4 for ().
    start_raw, end_raw = (
        (match.group(1), match.group(2))
        if match.group(1)
        else (
            match.group(3),
            match.group(4),
        )
    )
    start_sec = _to_seconds(start_raw)
    end_sec = _to_seconds(end_raw)
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
