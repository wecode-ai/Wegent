# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Collect and merge internal knowledge-video citations."""

from __future__ import annotations

import json
import logging
from typing import Any

from shared.knowledge.video_segments import (
    DEFAULT_MAX_SEGMENTS,
    extract_all_video_segments,
)
from shared.knowledge.video_sources import (
    BuiltVideoSource,
    VideoSourceIdentity,
    VideoSourceSegment,
    build_video_source,
    merge_video_source,
    video_source_to_payload,
)

MAX_VIDEO_SEGMENTS_PER_SOURCE = DEFAULT_MAX_SEGMENTS
VideoSourceMap = dict[tuple[int, int], BuiltVideoSource]

_COVERAGE_TO_SOURCE_TYPE = {
    "retrieved": "wegent_video_segment",
    "complete": "wegent_video_chapters",
}

#: Server label of the built-in knowledge MCP server. Used as the primary
#: identity check for video citation collection; tool names are not reliable
#: because MCP clients may rename them.
KNOWLEDGE_MCP_SERVER_LABEL = "wegent-knowledge"


def _decode_mcp_json_payload(value: Any) -> dict[str, Any] | None:
    candidates = value if isinstance(value, list) else [value]
    for candidate in candidates:
        payload = candidate
        if isinstance(candidate, dict) and candidate.get("type") == "text":
            payload = candidate.get("text")
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except (json.JSONDecodeError, TypeError):
                continue
        if isinstance(payload, dict):
            return payload
    return None


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None


def _source_key(source: dict[str, Any]) -> tuple[int, int] | None:
    kb_id = _positive_int(source.get("kb_id")) or _positive_int(
        source.get("knowledge_base_id")
    )
    document_id = _positive_int(source.get("document_id"))
    if kb_id is None or document_id is None:
        return None
    return kb_id, document_id


def _set_available_segments(
    source: dict[str, Any],
    segments: Any,
    *,
    truncated: bool,
) -> None:
    """Attach a full chapter catalog to a segment source when available."""
    if not isinstance(segments, list) or not segments:
        return
    source["available_segments"] = list(segments)
    if truncated:
        source["available_segments_truncated"] = True
    else:
        source.pop("available_segments_truncated", None)


def _video_chunk_key(chunk: dict[str, Any]) -> tuple[int, int] | None:
    metadata = chunk.get("metadata")
    if not isinstance(metadata, dict):
        return None
    source_file = metadata.get("source_file") or chunk.get("title")
    is_video = (
        chunk.get("source_media_type") == "video"
        or metadata.get("source_media_type") == "video"
        or (isinstance(source_file, str) and source_file.lower().endswith(".video.md"))
    )
    if not is_video:
        return None
    document_id = _positive_int(metadata.get("doc_ref")) or _positive_int(
        chunk.get("document_id")
    )
    kb_id = _positive_int(chunk.get("knowledge_base_id")) or _positive_int(
        metadata.get("knowledge_id")
    )
    if document_id is None or kb_id is None:
        return None
    return kb_id, document_id


def collect_knowledge_mcp_video_sources(
    collected: VideoSourceMap, tool_output: Any
) -> tuple[int, int] | None:
    """Collect citations and return a parsed complete-document source key."""
    payload = _decode_mcp_json_payload(tool_output)
    if payload is None:
        return None
    if payload.get("mode") == "rag_retrieval":
        _collect_rag_retrieval_video_sources(collected, payload)
        return None
    return _collect_document_content_video_source(collected, payload)


def _collect_into(
    collected: VideoSourceMap,
    source_key: tuple[int, int],
    *,
    title: Any,
    coverage: str,
    segments: list[VideoSourceSegment],
    input_truncated: bool = False,
) -> None:
    """Build and coverage-merge one observation into the collection map."""
    existing = collected.get(source_key)
    if not isinstance(title, str) or not title.strip():
        # A new source needs a display title; merging into an existing one
        # keeps the already-recorded title.
        if existing is None:
            return
        title = existing.identity.title
    built = build_video_source(
        identity=VideoSourceIdentity(
            knowledge_base_id=source_key[0],
            document_id=source_key[1],
            title=title,
        ),
        coverage=coverage,  # type: ignore[arg-type]
        segments=segments,
        input_truncated=input_truncated,
    )
    if built is None:
        return
    collected[source_key] = merge_video_source(existing, built)


def _collect_rag_retrieval_video_sources(
    collected: VideoSourceMap, payload: dict[str, Any]
) -> None:
    """Collect citations from a ``rag_retrieval`` payload's chunk metadata."""
    chunks = payload.get("chunks")
    if not isinstance(chunks, list):
        return

    for chunk in chunks:
        if not isinstance(chunk, dict):
            continue
        metadata = chunk.get("metadata")
        source_key = _video_chunk_key(chunk)
        if not isinstance(metadata, dict) or source_key is None:
            continue
        start_sec = metadata.get("video_start_sec")
        end_sec = metadata.get("video_end_sec")
        if (
            isinstance(start_sec, bool)
            or isinstance(end_sec, bool)
            or not isinstance(start_sec, int)
            or not isinstance(end_sec, int)
            or start_sec < 0
            or end_sec <= start_sec
        ):
            continue

        _collect_into(
            collected,
            source_key,
            title=chunk.get("title") or metadata.get("source_file"),
            coverage="retrieved",
            segments=[
                VideoSourceSegment(
                    start_sec=start_sec,
                    end_sec=end_sec,
                    segment_id=metadata.get("video_segment_id"),
                    score=chunk.get("score"),
                    title=metadata.get("video_segment_title"),
                    description=metadata.get("video_segment_description"),
                )
            ],
        )


def _collect_document_content_video_source(
    collected: VideoSourceMap, payload: dict[str, Any]
) -> tuple[int, int] | None:
    """Collect chapters from a fully-read video document content payload.

    Handles the ``wegent_kb_get_document_content`` MCP result: unlike RAG
    retrieval there is no chunk metadata, so chapters are parsed from the
    full Markdown content with the shared parser. Only applies when the
    document is confirmed as video and read completely (offset 0, no more
    pages), mirroring the chat_shell ``kb_head`` whitelist conditions.
    """
    if payload.get("source_media_type") != "video":
        return None
    if payload.get("offset", 0) != 0 or payload.get("has_more", False):
        return None
    content = payload.get("content")
    if not isinstance(content, str) or not content:
        return None
    document_id = _positive_int(payload.get("document_id"))
    kb_id = _positive_int(payload.get("knowledge_base_id")) or _positive_int(
        payload.get("kb_id")
    )
    if document_id is None or kb_id is None:
        return None

    parse_result = extract_all_video_segments(content)
    if not parse_result.segments:
        return None

    source_key = (kb_id, document_id)

    # Full-document chapters are a fallback when this response has no RAG
    # evidence. The coverage rules in merge_video_source keep retrieved
    # segments when both observations exist for the same video.
    _collect_into(
        collected,
        source_key,
        title=payload.get("name"),
        coverage="complete",
        segments=[
            VideoSourceSegment(
                start_sec=segment.start_sec,
                end_sec=segment.end_sec,
                title=segment.title,
                description=segment.description,
            )
            for segment in parse_result.segments
        ],
        input_truncated=parse_result.truncated,
    )
    return source_key


def collect_and_log_knowledge_mcp_video_sources(
    collected: VideoSourceMap,
    tool_output: Any,
    *,
    logger: logging.Logger,
    context: str,
    server_label: str | None = None,
) -> int:
    """Collect sources and log only when the collection actually grows.

    Server identity policy (identity first, content fallback):
      - ``server_label == wegent-knowledge``: collect (``identity_match``).
      - Any other non-empty label: skip (``identity_rejected``).
      - Missing label (some runtimes drop/rewrite it): fall back to the
        strict content-level guards (``content_fallback``).
    The decision is included in logs to help diagnose context loss.
    """
    if server_label:
        if server_label != KNOWLEDGE_MCP_SERVER_LABEL:
            logger.info(
                "Skipped MCP video citation collection: decision=identity_rejected, "
                "server_label=%s, context=%s",
                server_label,
                context,
            )
            return 0
        decision = "identity_match"
    else:
        decision = "content_fallback"
    previous_source_count = len(collected)
    previous_segment_count = sum(len(source.segments) for source in collected.values())
    previous_coverages = {key: source.coverage for key, source in collected.items()}
    complete_source_key = collect_knowledge_mcp_video_sources(collected, tool_output)
    current_segment_count = sum(len(source.segments) for source in collected.values())
    added_segments = current_segment_count - previous_segment_count
    segment_preferred = (
        complete_source_key is not None
        and previous_coverages.get(complete_source_key) == "retrieved"
        and collected.get(complete_source_key) is not None
        and collected[complete_source_key].coverage == "retrieved"
    )
    if (
        added_segments != 0
        or len(collected) > previous_source_count
        or segment_preferred
    ):
        logger.info(
            "Collected MCP video citations: decision=%s, coverage_action=%s, "
            "context=%s, source_count=%d, previous_segment_count=%d, "
            "new_segment_count=%d",
            decision,
            "segment_preferred_over_chapters" if segment_preferred else "merge",
            context,
            len(collected),
            previous_segment_count,
            current_segment_count,
        )
    return added_segments


def merge_video_sources(existing: Any, videos: VideoSourceMap) -> list[dict[str, Any]]:
    """Merge video citations into existing sources by KB and document ID."""
    merged = []
    for source in existing or []:
        if not isinstance(source, dict):
            continue
        copied_source = dict(source)
        if isinstance(source.get("segments"), list):
            copied_source["segments"] = list(source["segments"])
        if isinstance(source.get("available_segments"), list):
            copied_source["available_segments"] = list(source["available_segments"])
        merged.append(copied_source)
    by_key = {
        key: source for source in merged if (key := _source_key(source)) is not None
    }
    next_index = (
        max((_positive_int(source.get("index")) or 0 for source in merged), default=0)
        + 1
    )

    for key, video_source in videos.items():
        video = video_source_to_payload(video_source)
        video["source_type"] = _COVERAGE_TO_SOURCE_TYPE[video_source.coverage]
        target = by_key.get(key)
        if target is None:
            target = dict(video)
            target["index"] = next_index
            next_index += 1
            merged.append(target)
            by_key[key] = target
            continue

        target["document_id"] = video["document_id"]
        target["kb_id"] = video["kb_id"]
        if (
            target.get("source_type") == "wegent_video_chapters"
            and video["source_type"] == "wegent_video_segment"
        ):
            # RAG hits are the retrieval evidence. Replace the chapter snapshot
            # rather than appending to it so only retrieved segments render.
            chapter_segments = target.get("segments")
            chapter_segments_truncated = bool(target.get("segments_truncated"))
            target["source_type"] = video["source_type"]
            target["segments"] = list(video["segments"])
            if video.get("segments_truncated"):
                target["segments_truncated"] = True
            else:
                target.pop("segments_truncated", None)
            _set_available_segments(
                target,
                video.get("available_segments") or chapter_segments,
                truncated=bool(
                    video.get("available_segments_truncated")
                    or chapter_segments_truncated
                ),
            )
            continue
        if (
            target.get("source_type") == "wegent_video_segment"
            and video["source_type"] == "wegent_video_chapters"
        ):
            # Chapters are a fallback only; preserve existing RAG evidence.
            if not target.get("title"):
                target["title"] = video["title"]
            _set_available_segments(
                target,
                video["segments"],
                truncated=bool(video.get("segments_truncated")),
            )
            continue
        target["source_type"] = video["source_type"]
        # Video segments are already normalized by the shared builder; for a
        # complete snapshot this replaces partial segments outright, and for
        # retrieved hits the builder already deduped across MCP calls.
        if video["source_type"] == "wegent_video_chapters":
            target["segments"] = video["segments"]
            if video.get("segments_truncated"):
                target["segments_truncated"] = True
            else:
                target.pop("segments_truncated", None)
            continue
        existing_segments = target.get("segments")
        if not isinstance(existing_segments, list):
            existing_segments = []
            target["segments"] = existing_segments
        seen = {
            (segment.get("start_sec"), segment.get("end_sec"))
            for segment in existing_segments
            if isinstance(segment, dict)
        }
        truncated = bool(video.get("segments_truncated"))
        for segment in video["segments"]:
            segment_key = (segment.get("start_sec"), segment.get("end_sec"))
            if segment_key in seen:
                continue
            if len(existing_segments) >= MAX_VIDEO_SEGMENTS_PER_SOURCE:
                truncated = True
                break
            existing_segments.append(segment)
            seen.add(segment_key)
        if truncated:
            target["segments_truncated"] = True
        _set_available_segments(
            target,
            video.get("available_segments"),
            truncated=bool(video.get("available_segments_truncated")),
        )

    return merged
