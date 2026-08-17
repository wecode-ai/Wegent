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

MAX_VIDEO_SEGMENTS_PER_SOURCE = DEFAULT_MAX_SEGMENTS
VideoSourceMap = dict[tuple[int, int], dict[str, Any]]


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
) -> None:
    """Collect time-addressable video citations from a knowledge MCP result."""
    payload = _decode_mcp_json_payload(tool_output)
    if payload is None:
        return
    if payload.get("mode") == "rag_retrieval":
        _collect_rag_retrieval_video_sources(collected, payload)
        return
    _collect_document_content_video_source(collected, payload)


def _get_or_create_source(
    collected: VideoSourceMap,
    source_key: tuple[int, int],
    *,
    title: Any,
    source_type: str,
) -> dict[str, Any] | None:
    """Return the source entry for ``source_key``, creating it if needed."""
    source = collected.get(source_key)
    if source is not None:
        return source
    if not isinstance(title, str) or not title.strip():
        return None
    source = {
        "index": len(collected) + 1,
        "title": title.strip(),
        "kb_id": source_key[0],
        "document_id": source_key[1],
        "source_type": source_type,
        "segments": [],
    }
    collected[source_key] = source
    return source


def _append_segment(source: dict[str, Any], segment: dict[str, Any]) -> None:
    """Append a segment with dedup by time range and a per-source cap."""
    segment_key = (segment.get("start_sec"), segment.get("end_sec"))
    if any(
        (item.get("start_sec"), item.get("end_sec")) == segment_key
        for item in source["segments"]
    ):
        return
    if len(source["segments"]) >= MAX_VIDEO_SEGMENTS_PER_SOURCE:
        source["segments_truncated"] = True
        return
    source["segments"].append(segment)


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

        source = _get_or_create_source(
            collected,
            source_key,
            title=chunk.get("title") or metadata.get("source_file"),
            source_type="wegent_video_segment",
        )
        if source is None:
            continue

        _append_segment(
            source,
            {
                "id": metadata.get("video_segment_id"),
                "start_sec": start_sec,
                "end_sec": end_sec,
                "score": chunk.get("score"),
                "title": metadata.get("video_segment_title"),
                "description": metadata.get("video_segment_description"),
            },
        )


def _collect_document_content_video_source(
    collected: VideoSourceMap, payload: dict[str, Any]
) -> None:
    """Collect chapters from a fully-read video document content payload.

    Handles the ``wegent_kb_get_document_content`` MCP result: unlike RAG
    retrieval there is no chunk metadata, so chapters are parsed from the
    full Markdown content with the shared parser. Only applies when the
    document is confirmed as video and read completely (offset 0, no more
    pages), mirroring the chat_shell ``kb_head`` whitelist conditions.
    """
    if payload.get("source_media_type") != "video":
        return
    if payload.get("offset", 0) != 0 or payload.get("has_more", False):
        return
    content = payload.get("content")
    if not isinstance(content, str) or not content:
        return
    document_id = _positive_int(payload.get("document_id"))
    kb_id = _positive_int(payload.get("knowledge_base_id")) or _positive_int(
        payload.get("kb_id")
    )
    if document_id is None or kb_id is None:
        return

    parse_result = extract_all_video_segments(content)
    if not parse_result.segments:
        return

    source = _get_or_create_source(
        collected,
        (kb_id, document_id),
        title=payload.get("name"),
        source_type="wegent_video_chapters",
    )
    if source is None:
        return

    # Full-document chapters are strictly more complete than chunk-level
    # segments, so prefer the chapters renderer when both were collected.
    source["source_type"] = "wegent_video_chapters"
    for segment in parse_result.segments:
        _append_segment(
            source,
            {
                "id": f"segment_{segment.start_sec}_{segment.end_sec}",
                "start_sec": segment.start_sec,
                "end_sec": segment.end_sec,
                "title": segment.title,
                "description": segment.description,
            },
        )
    if parse_result.truncated:
        source["segments_truncated"] = True


def collect_and_log_knowledge_mcp_video_sources(
    collected: VideoSourceMap,
    tool_output: Any,
    *,
    logger: logging.Logger,
    context: str,
) -> int:
    """Collect sources and log only when the collection actually grows."""
    previous_source_count = len(collected)
    previous_segment_count = sum(
        len(source.get("segments", [])) for source in collected.values()
    )
    collect_knowledge_mcp_video_sources(collected, tool_output)
    current_segment_count = sum(
        len(source.get("segments", [])) for source in collected.values()
    )
    added_segments = current_segment_count - previous_segment_count
    if added_segments > 0 or len(collected) > previous_source_count:
        logger.info(
            "Collected MCP video citations: context=%s, source_count=%d, "
            "new_segment_count=%d",
            context,
            len(collected),
            added_segments,
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
        merged.append(copied_source)
    by_key = {
        key: source for source in merged if (key := _source_key(source)) is not None
    }
    next_index = (
        max((_positive_int(source.get("index")) or 0 for source in merged), default=0)
        + 1
    )

    for key, video in videos.items():
        target = by_key.get(key)
        if target is None:
            target = dict(video)
            video_segments = target.get("segments")
            if (
                isinstance(video_segments, list)
                and len(video_segments) > MAX_VIDEO_SEGMENTS_PER_SOURCE
            ):
                target["segments"] = video_segments[:MAX_VIDEO_SEGMENTS_PER_SOURCE]
                target["segments_truncated"] = True
            target["index"] = next_index
            next_index += 1
            merged.append(target)
            by_key[key] = target
            continue

        target["source_type"] = video["source_type"]
        target["document_id"] = video["document_id"]
        target["kb_id"] = video["kb_id"]
        existing_segments = target.get("segments")
        if not isinstance(existing_segments, list):
            existing_segments = []
            target["segments"] = existing_segments
        if len(existing_segments) >= MAX_VIDEO_SEGMENTS_PER_SOURCE:
            target["segments_truncated"] = True
        seen = {
            (segment.get("start_sec"), segment.get("end_sec"))
            for segment in existing_segments
            if isinstance(segment, dict)
        }
        for segment in video["segments"]:
            segment_key = (segment.get("start_sec"), segment.get("end_sec"))
            if segment_key in seen:
                continue
            if len(existing_segments) >= MAX_VIDEO_SEGMENTS_PER_SOURCE:
                target["segments_truncated"] = True
                break
            existing_segments.append(segment)
            seen.add(segment_key)
        if video.get("segments_truncated"):
            target["segments_truncated"] = True

    return merged
