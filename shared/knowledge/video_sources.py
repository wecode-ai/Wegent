# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pure builders for time-addressable video citation sources.

Single deep module for assembling a video source from already-normalized
data: identity validation, segment normalization, stable IDs, dedup,
ordering, capping, and the retrieved-vs-complete coverage rules.

Callers remain responsible for trust decisions (server identity), raw
protocol parsing (MCP JSON / Markdown), and final ``source_type`` mapping.
This module has no I/O, no database, and no UI knowledge.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Literal

from shared.knowledge.video_segments import DEFAULT_MAX_SEGMENTS

VideoCoverage = Literal["retrieved", "complete"]


@dataclass(frozen=True)
class VideoSourceIdentity:
    """Stable identity of a video document citation."""

    knowledge_base_id: int
    document_id: int
    title: str


@dataclass(frozen=True)
class VideoSourceSegment:
    """A normalized playable time range of a video source."""

    start_sec: int
    end_sec: int
    segment_id: str | None = None
    score: float | None = None
    title: str | None = None
    description: str | None = None


@dataclass(frozen=True)
class BuiltVideoSource:
    """Validated, normalized video source ready for protocol serialization."""

    identity: VideoSourceIdentity
    coverage: VideoCoverage
    segments: tuple[VideoSourceSegment, ...]
    segments_truncated: bool = False


def _normalize_segments(
    segments: Iterable[VideoSourceSegment],
    *,
    input_truncated: bool,
    max_segments: int,
) -> tuple[tuple[VideoSourceSegment, ...], bool] | None:
    """Validate, dedupe, sort, and cap segments. ``None`` when none valid."""
    valid: dict[tuple[int, int], VideoSourceSegment] = {}
    for segment in segments:
        if (
            isinstance(segment.start_sec, bool)
            or isinstance(segment.end_sec, bool)
            or segment.start_sec < 0
            or segment.end_sec <= segment.start_sec
        ):
            continue
        valid.setdefault((segment.start_sec, segment.end_sec), segment)
    if not valid:
        return None
    ordered = tuple(valid[key] for key in sorted(valid))
    truncated = input_truncated or len(ordered) > max_segments
    return ordered[:max_segments], truncated


def build_video_source(
    *,
    identity: VideoSourceIdentity,
    coverage: VideoCoverage,
    segments: Iterable[VideoSourceSegment],
    input_truncated: bool = False,
    max_segments: int = DEFAULT_MAX_SEGMENTS,
) -> BuiltVideoSource | None:
    """Build a validated video source, or ``None`` when input is unusable.

    Raises TypeError/ValueError for malformed *call arguments* (wrong types,
    unknown coverage, non-positive cap); genuinely unusable citation data
    (bad ids, empty title, no valid segments) returns ``None`` instead.
    """
    if not isinstance(identity.title, str):
        raise TypeError("identity.title must be a string")
    if coverage not in ("retrieved", "complete"):
        raise ValueError(
            f"coverage must be 'retrieved' or 'complete', got {coverage!r}"
        )
    if (
        not isinstance(max_segments, int)
        or isinstance(max_segments, bool)
        or max_segments <= 0
    ):
        raise ValueError(f"max_segments must be a positive int, got {max_segments!r}")
    if (
        isinstance(identity.knowledge_base_id, bool)
        or isinstance(identity.document_id, bool)
        or identity.knowledge_base_id <= 0
        or identity.document_id <= 0
        or not identity.title.strip()
    ):
        return None
    normalized = _normalize_segments(
        segments, input_truncated=input_truncated, max_segments=max_segments
    )
    if normalized is None:
        return None
    return BuiltVideoSource(
        identity=identity,
        coverage=coverage,
        segments=normalized[0],
        segments_truncated=normalized[1],
    )


def merge_video_source(
    existing: BuiltVideoSource | None,
    incoming: BuiltVideoSource,
    *,
    max_segments: int = DEFAULT_MAX_SEGMENTS,
) -> BuiltVideoSource:
    """Merge two observations of the same video document by coverage rules.

    Coverage matrix (deterministic, order-independent):
      - retrieved + complete  → complete (snapshot replaces partial hits)
      - complete  + retrieved → complete (later partial hits are ignored)
      - retrieved + retrieved → retrieved (union, deduped and sorted)
      - complete  + complete  → complete (new snapshot replaces the old one)
    """
    if existing is None or (
        existing.identity.knowledge_base_id,
        existing.identity.document_id,
    ) != (incoming.identity.knowledge_base_id, incoming.identity.document_id):
        return incoming
    if incoming.coverage == "complete":
        return incoming
    if existing.coverage == "complete":
        return existing
    merged = build_video_source(
        identity=existing.identity,
        coverage="retrieved",
        segments=(*existing.segments, *incoming.segments),
        input_truncated=existing.segments_truncated or incoming.segments_truncated,
        max_segments=max_segments,
    )
    # Both inputs were valid, so the union cannot be empty.
    return merged if merged is not None else existing


def video_source_to_payload(source: BuiltVideoSource) -> dict[str, Any]:
    """Serialize to the existing citation wire format (dict).

    ``source_type`` is intentionally not included; callers own the mapping
    from coverage to their protocol's source type.
    """
    payload: dict[str, Any] = {
        "title": source.identity.title.strip(),
        "kb_id": source.identity.knowledge_base_id,
        "document_id": source.identity.document_id,
        "segments": [
            {
                "id": segment.segment_id
                or f"segment_{segment.start_sec}_{segment.end_sec}",
                "start_sec": segment.start_sec,
                "end_sec": segment.end_sec,
                **({"score": segment.score} if segment.score is not None else {}),
                "title": segment.title,
                "description": segment.description,
            }
            for segment in source.segments
        ],
    }
    if source.segments_truncated:
        payload["segments_truncated"] = True
    return payload
