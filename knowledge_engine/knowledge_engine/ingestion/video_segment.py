# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Video chapter metadata extraction for generated ``*.video.md`` files.

Regex and timestamp conversion logic is delegated to the shared module
``shared.knowledge.video_segments`` so that knowledge_engine (index-time)
and chat_shell (runtime content parsing) use the exact same rules.
"""

from __future__ import annotations

import re
from typing import Any, Sequence

from llama_index.core.schema import BaseNode

from shared.knowledge.video_segments import (
    VIDEO_SEGMENT_SUMMARY_PATTERN,
    VIDEO_TIMESTAMP_PATTERN,
    extract_video_segment,
    to_seconds,
)


def extract_video_segment_metadata(text: str) -> dict[str, Any] | None:
    """Return validated time metadata from a generated video chapter heading.

    Delegates to :func:`shared.knowledge.video_segments.extract_video_segment`
    and converts the result to the metadata dict format expected by the indexer.
    """
    seg = extract_video_segment(text)
    if seg is None:
        return None
    return {
        "video_segment_id": f"segment_{seg.start_sec}_{seg.end_sec}",
        "video_start_sec": seg.start_sec,
        "video_end_sec": seg.end_sec,
    }


def extract_video_segment_copy(text: str) -> dict[str, str]:
    """Extract stable display copy (title + description) before splitting.

    Delegates to the shared parser for the regex, keeping the same output
    dict format (``video_segment_title`` / ``video_segment_description``).
    """
    seg = extract_video_segment(text)
    result: dict[str, str] = {}
    if seg is not None:
        if seg.title:
            result["video_segment_title"] = seg.title
        if seg.description:
            result["video_segment_description"] = seg.description
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
