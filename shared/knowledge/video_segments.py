# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared video segment timestamp parser.

Single source of truth for extracting time ranges from Gemini-generated
video Markdown. Used by:
  - knowledge_engine (index-time node enrichment)
  - chat_shell (direct injection / kb_head content parsing)

This module is dependency-free (stdlib ``re`` only) so it can be imported
from any service without pulling in llama_index or other heavy deps.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

_TIME = r"(?:\d{1,2}:)?\d{1,2}:\d{2}"
_RANGE_SEPARATOR = r"[-–—~至]"
_OPEN_BRACKETS = r"[\[\(【（]*"
_CLOSE_BRACKETS = r"[\]\)】）]*"

#: Matches a time range inside optional brackets.
#: Two capture groups: group(1)=start, group(2)=end.
VIDEO_TIMESTAMP_PATTERN = re.compile(
    _OPEN_BRACKETS
    + r"\s*("
    + _TIME
    + r")\s*"
    + _CLOSE_BRACKETS
    + r"\s*"
    + _RANGE_SEPARATOR
    + r"\s*"
    + _OPEN_BRACKETS
    + r"\s*("
    + _TIME
    + r")\s*"
    + _CLOSE_BRACKETS
)

#: Matches the Gemini summary line ``> **本段摘要**：...``
VIDEO_SEGMENT_SUMMARY_PATTERN = re.compile(
    r"^>\s*\*\*本段摘要\*\*[：:]\s*(.+?)\s*$", re.MULTILINE
)

_HEADING_RE = re.compile(r"^#{1,6}\s+")

#: Default safety cap — truncate (not clear) beyond this.
DEFAULT_MAX_SEGMENTS = 100


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VideoSegment:
    """A single parsed video chapter."""

    start_sec: int
    end_sec: int
    title: str | None = None
    description: str | None = None


@dataclass(frozen=True)
class VideoSegmentParseResult:
    """Result of parsing all chapters from a full video Markdown document."""

    segments: tuple[VideoSegment, ...]
    truncated: bool = False


# ---------------------------------------------------------------------------
# Conversion helpers
# ---------------------------------------------------------------------------


def to_seconds(value: str) -> int | None:
    """Convert ``[HH:]MM:SS`` to seconds.

    For the 2-part (MM:SS) form the first field is treated as *total minutes*
    (not clock minutes), so values ≥ 60 are accepted for long videos where
    Gemini may emit ``65:00`` instead of ``01:05:00``.

    Returns ``None`` on any invalid input.
    """
    parts = value.split(":")
    try:
        if len(parts) == 2:
            total_minutes, seconds = parts
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
    except (ValueError, TypeError):
        return None
    return None


# ---------------------------------------------------------------------------
# Single-chapter extraction (used by knowledge_engine at index time)
# ---------------------------------------------------------------------------


def _clean_heading_title(heading: str) -> str | None:
    """Remove Markdown, chapter numbering, timestamps, and empty wrappers."""
    title = _HEADING_RE.sub("", heading)
    title = VIDEO_TIMESTAMP_PATTERN.sub("", title).strip()
    title = re.sub(r"^章节\s*\d+\s*[：:]\s*", "", title)
    title = re.sub(r"[\[\(【（]\s*[\]\)】）]\s*$", "", title).strip()
    return title or None


def extract_video_segment(text: str) -> VideoSegment | None:
    """Extract the *first* valid video chapter from ``text``.

    Scans heading lines (``^#{1,6}\\s+``) for a timestamp range and returns
    a :class:`VideoSegment` or ``None`` if no valid match is found.
    """
    for line in text.splitlines():
        heading = line.strip()
        if not _HEADING_RE.match(heading):
            continue
        match = VIDEO_TIMESTAMP_PATTERN.search(heading)
        if match is None:
            continue
        start_sec = to_seconds(match.group(1))
        end_sec = to_seconds(match.group(2))
        if start_sec is None or end_sec is None or end_sec <= start_sec:
            continue
        title = _clean_heading_title(heading)
        summary_match = VIDEO_SEGMENT_SUMMARY_PATTERN.search(text)
        description = summary_match.group(1).strip() if summary_match else None
        return VideoSegment(
            start_sec=start_sec,
            end_sec=end_sec,
            title=title,
            description=description,
        )
    return None


# ---------------------------------------------------------------------------
# Full-document extraction (used by chat_shell for direct injection / kb_head)
# ---------------------------------------------------------------------------


def extract_all_video_segments(
    content: str,
    *,
    max_segments: int = DEFAULT_MAX_SEGMENTS,
) -> VideoSegmentParseResult:
    """Extract *all* video chapters from a full Gemini Markdown document.

    Unlike :func:`extract_video_segment` (which returns the first match),
    this scans every heading line and returns all validated time ranges.

    Key correctness guarantees:
      - Uses ``splitlines(keepends=True)`` + accumulated offsets for accurate
        character positions (avoids ``content.index(line)`` repeated-line bug).
      - Summary search is bounded to the current heading → next heading range
        (avoids cross-chapter summary bleed).
      - ``max_segments`` truncates; it does **not** clear results.

    Returns an empty result (no segments, ``truncated=False``) for non-video
    documents or documents without valid timestamp headings.
    """
    if max_segments <= 0:
        return VideoSegmentParseResult(segments=())

    lines = content.splitlines(keepends=True)
    heading_positions: list[tuple[int, int, str]] = []  # (start, end, heading)
    offset = 0
    for line in lines:
        stripped = line.strip()
        if _HEADING_RE.match(stripped):
            heading_positions.append((offset, offset + len(line), stripped))
        offset += len(line)

    segments: list[VideoSegment] = []
    seen: set[tuple[int, int]] = set()
    truncated = False

    for idx, (h_start, h_end, heading) in enumerate(heading_positions):
        match = VIDEO_TIMESTAMP_PATTERN.search(heading)
        if match is None:
            continue

        start_sec = to_seconds(match.group(1))
        end_sec = to_seconds(match.group(2))
        if start_sec is None or end_sec is None or end_sec <= start_sec:
            continue

        key = (start_sec, end_sec)
        if key in seen:
            continue
        seen.add(key)

        title = _clean_heading_title(heading)

        # Bounded summary search: current heading end → next heading start
        next_start = (
            heading_positions[idx + 1][0]
            if idx + 1 < len(heading_positions)
            else len(content)
        )
        chapter_body = content[h_end:next_start]
        summary_match = VIDEO_SEGMENT_SUMMARY_PATTERN.search(chapter_body)
        description = summary_match.group(1).strip() if summary_match else None

        segments.append(
            VideoSegment(
                start_sec=start_sec,
                end_sec=end_sec,
                title=title,
                description=description,
            )
        )

        if len(segments) >= max_segments:
            truncated = True
            break

    return VideoSegmentParseResult(
        segments=tuple(segments),
        truncated=truncated,
    )
