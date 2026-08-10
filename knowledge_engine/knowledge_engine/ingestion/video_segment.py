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
_RANGE_SEPARATOR = r"[-–—~至]"
VIDEO_SEGMENT_PATTERN = re.compile(
    r"\[\s*(" + _TIME + r")\s*" + _RANGE_SEPARATOR + r"\s*(" + _TIME + r")\s*\]"
    r"|\(\s*(" + _TIME + r")\s*" + _RANGE_SEPARATOR + r"\s*(" + _TIME + r")\s*\)"
)
VIDEO_SEGMENT_SUMMARY_PATTERN = re.compile(
    r"^>\s*\*\*本段摘要\*\*[：:]\s*(.+?)\s*$", re.MULTILINE
)


def _to_seconds(value: str) -> int | None:
    """Convert ``[HH:]MM:SS`` to seconds, rejecting invalid second values.

    For the 2-part (MM:SS) form the first field is treated as total minutes
    (not clock minutes), so values ≥ 60 are accepted for long videos where
    Gemini may emit e.g. ``65:00`` instead of ``01:05:00``.
    """
    parts = value.split(":")
    if len(parts) == 2:
        total_minutes, seconds = parts[0], parts[1]
        if not seconds.isdigit() or int(seconds) > 59:
            return None
        if not total_minutes.isdigit():
            return None
        return int(total_minutes) * 60 + int(seconds)
    elif len(parts) == 3:
        hours, minutes, seconds = parts
        minute = int(minutes)
        second = int(seconds)
        if minute > 59 or second > 59:
            return None
        return int(hours) * 3600 + minute * 60 + second
    else:
        return None


def extract_video_segment_metadata(text: str) -> dict[str, Any] | None:
    """Return validated time metadata from a generated video chapter heading."""
    match = None
    for line in text.splitlines():
        heading = line.strip()
        if not re.match(r"^#{1,6}\s+", heading):
            continue
        match = VIDEO_SEGMENT_PATTERN.search(heading)
        if match is not None:
            break
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


def extract_video_segment_copy(text: str) -> dict[str, str]:
    """Extract stable display copy before a chapter is split into child nodes."""
    heading = next(
        (
            line.strip()
            for line in text.splitlines()
            if re.match(r"^#{1,6}\s+", line.strip())
            and VIDEO_SEGMENT_PATTERN.search(line)
        ),
        "",
    )
    result: dict[str, str] = {}
    if heading:
        title = re.sub(r"^#{1,6}\s+", "", heading)
        title = VIDEO_SEGMENT_PATTERN.sub("", title)
        title = re.sub(r"\(\s*\)\s*$", "", title).strip()
        title = re.sub(r"^章节\s*\d+\s*[：:]\s*", "", title)
        if title:
            result["video_segment_title"] = title
    summary_match = VIDEO_SEGMENT_SUMMARY_PATTERN.search(text)
    if summary_match:
        result["video_segment_description"] = summary_match.group(1).strip()
    return result


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
            node.metadata.update(extract_video_segment_copy(node.text))
    return enriched
