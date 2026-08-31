# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import Mock, patch

from shared.knowledge.video_segments import extract_all_video_segments
from shared.knowledge.video_sources import (
    VideoSourceIdentity,
    VideoSourceSegment,
    build_video_source,
)
from wecode.service.knowledge.video_citation_sources import (
    KNOWLEDGE_MCP_SERVER_LABEL,
    MAX_VIDEO_SEGMENTS_PER_SOURCE,
    collect_and_log_knowledge_mcp_video_sources,
    collect_knowledge_mcp_video_sources,
    merge_video_sources,
)


def _built_source(
    kb_id: int,
    document_id: int,
    title: str,
    ranges: list[tuple[int, int]],
    *,
    coverage: str = "retrieved",
    truncated: bool = False,
):
    source = build_video_source(
        identity=VideoSourceIdentity(kb_id, document_id, title),
        coverage=coverage,  # type: ignore[arg-type]
        segments=[
            VideoSourceSegment(start_sec=start, end_sec=end) for start, end in ranges
        ],
        input_truncated=truncated,
    )
    assert source is not None
    return source


def _segment_ranges(source) -> list[tuple[int, int]]:
    return [(s.start_sec, s.end_sec) for s in source.segments]


def _video_rag_output() -> dict:
    return {
        "mode": "rag_retrieval",
        "chunks": [
            {
                "title": "825.video.md",
                "knowledge_base_id": 212,
                "document_id": 825,
                "metadata": {
                    "source_media_type": "video",
                    "video_start_sec": 1,
                    "video_end_sec": 2,
                },
            }
        ],
    }


VIDEO_DOCUMENT_CONTENT = (
    "# 产品培训示例视频\n\n"
    "### 章节 1：背景 ([00:00:00 - 00:00:48])\n"
    "> **本段摘要**：开场介绍。\n\n"
    "### 章节 2：架构 ([00:00:48 - 00:01:49])\n"
    "> **本段摘要**：整体架构。\n"
)


def _document_content_payload(**overrides):
    payload = {
        "document_id": 825,
        "knowledge_base_id": 212,
        "name": "产品培训示例视频.mp4",
        "content": VIDEO_DOCUMENT_CONTENT,
        "offset": 0,
        "returned_length": len(VIDEO_DOCUMENT_CONTENT),
        "total_length": len(VIDEO_DOCUMENT_CONTENT),
        "has_more": False,
        "index_status": "success",
        "source_media_type": "video",
    }
    payload.update(overrides)
    return payload


def test_merge_video_sources_upgrades_matching_plain_source() -> None:
    existing = [
        {
            "index": 4,
            "title": "Video document",
            "kb_id": 211,
            "document_id": 811,
        },
        {"index": 5, "title": "Plain document", "kb_id": 211, "document_id": 812},
    ]
    videos = {(211, 811): _built_source(211, 811, "811.video.md", [(6, 15)])}

    merged = merge_video_sources(existing, videos)

    assert len(merged) == 2
    assert merged[0]["index"] == 4
    assert merged[0]["title"] == "Video document"
    assert merged[0]["source_type"] == "wegent_video_segment"
    assert [(s["start_sec"], s["end_sec"]) for s in merged[0]["segments"]] == [(6, 15)]
    assert merged[1] == existing[1]


def test_merge_video_sources_appends_new_document_after_existing_indexes() -> None:
    videos = {(211, 813): _built_source(211, 813, "813.video.md", [(0, 5)])}

    merged = merge_video_sources(
        [{"index": 7, "title": "Plain", "kb_id": 211, "document_id": 812}],
        videos,
    )

    assert [source["index"] for source in merged] == [7, 8]


def test_merge_video_sources_enforces_segment_limit_on_existing_source() -> None:
    existing_segments = [
        {"start_sec": index, "end_sec": index + 1}
        for index in range(MAX_VIDEO_SEGMENTS_PER_SOURCE - 1)
    ]
    videos = {
        (211, 811): _built_source(211, 811, "811.video.md", [(200, 201), (202, 203)])
    }

    merged = merge_video_sources(
        [
            {
                "index": 1,
                "title": "Video",
                "kb_id": 211,
                "document_id": 811,
                "segments": existing_segments,
            }
        ],
        videos,
    )

    assert len(merged[0]["segments"]) == MAX_VIDEO_SEGMENTS_PER_SOURCE
    assert (
        merged[0]["segments"][-1]["start_sec"],
        merged[0]["segments"][-1]["end_sec"],
    ) == (200, 201)
    assert merged[0]["segments_truncated"] is True


def test_merge_video_sources_does_not_mutate_existing_segments() -> None:
    original_segments = [{"start_sec": 0, "end_sec": 1}]
    existing = [
        {
            "index": 1,
            "title": "Video",
            "kb_id": 211,
            "document_id": 811,
            "segments": original_segments,
        }
    ]
    videos = {(211, 811): _built_source(211, 811, "811.video.md", [(2, 3)])}

    merged = merge_video_sources(existing, videos)

    assert existing[0]["segments"] == [{"start_sec": 0, "end_sec": 1}]
    assert [(s["start_sec"], s["end_sec"]) for s in merged[0]["segments"]] == [
        (0, 1),
        (2, 3),
    ]


def test_video_segment_parser_marks_truncation_only_when_content_is_omitted() -> None:
    def content_with_chapters(count: int) -> str:
        return "\n".join(
            f"### Chapter {index} ([00:{index:02d}:00 - 00:{index:02d}:01])"
            for index in range(count)
        )

    exact = extract_all_video_segments(content_with_chapters(3), max_segments=3)
    overflowing = extract_all_video_segments(content_with_chapters(4), max_segments=3)

    assert len(exact.segments) == 3
    assert exact.truncated is False
    assert len(overflowing.segments) == 3
    assert overflowing.truncated is True


def test_collect_and_log_skips_non_video_mcp_output() -> None:
    logger = Mock()

    added = collect_and_log_knowledge_mcp_video_sources(
        {},
        json.dumps({"mode": "rag_retrieval", "chunks": []}),
        logger=logger,
        context="test",
    )

    assert added == 0
    logger.info.assert_not_called()


def test_collect_and_log_logs_when_video_segment_is_added() -> None:
    logger = Mock()
    collected = {}
    output = {
        "mode": "rag_retrieval",
        "chunks": [
            {
                "title": "811.video.md",
                "knowledge_base_id": 211,
                "document_id": 811,
                "metadata": {
                    "source_media_type": "video",
                    "video_start_sec": 1,
                    "video_end_sec": 2,
                },
            }
        ],
    }

    added = collect_and_log_knowledge_mcp_video_sources(
        collected,
        json.dumps(output),
        logger=logger,
        context="test",
    )

    assert added == 1
    logger.info.assert_called_once()


def test_collect_and_log_accepts_mcp_text_block_output_without_tool_context() -> None:
    logger = Mock()
    collected = {}
    output = {
        "mode": "rag_retrieval",
        "chunks": [
            {
                "title": "825.video.md",
                "knowledge_base_id": 212,
                "document_id": 825,
                "metadata": {
                    "source_media_type": "video",
                    "video_start_sec": 1,
                    "video_end_sec": 2,
                },
            }
        ],
    }

    added = collect_and_log_knowledge_mcp_video_sources(
        collected,
        [{"type": "text", "text": json.dumps(output), "id": "lc_test"}],
        logger=logger,
        context="test",
    )

    assert added == 1
    assert list(collected) == [(212, 825)]


def test_collect_and_log_identity_match_allows_knowledge_server() -> None:
    logger = Mock()
    collected = {}

    added = collect_and_log_knowledge_mcp_video_sources(
        collected,
        json.dumps(_video_rag_output()),
        logger=logger,
        context="test",
        server_label=KNOWLEDGE_MCP_SERVER_LABEL,
    )

    assert added == 1
    assert "identity_match" in logger.info.call_args[0]


def test_collect_and_log_identity_rejected_for_other_server() -> None:
    logger = Mock()
    collected = {}

    added = collect_and_log_knowledge_mcp_video_sources(
        collected,
        json.dumps(_video_rag_output()),
        logger=logger,
        context="test",
        server_label="custom-mcp",
    )

    assert added == 0
    assert collected == {}
    assert "decision=identity_rejected" in logger.info.call_args[0][0]


def test_collect_and_log_content_fallback_when_label_missing() -> None:
    logger = Mock()
    collected = {}

    added = collect_and_log_knowledge_mcp_video_sources(
        collected,
        json.dumps(_video_rag_output()),
        logger=logger,
        context="test",
        server_label=None,
    )

    assert added == 1
    assert "content_fallback" in logger.info.call_args[0]


def test_collect_and_log_reports_segment_preferred_over_chapters() -> None:
    logger = Mock()
    collected = {}
    collect_knowledge_mcp_video_sources(
        collected,
        {
            "mode": "rag_retrieval",
            "chunks": [
                _rag_chunk(0, 10),
                _rag_chunk(25, 50),
                _rag_chunk(60, 70),
            ],
        },
    )

    # The complete chapter snapshot is suppressed because RAG evidence already
    # exists. Segment count does not change, so the decision must still log.
    with patch(
        "wecode.service.knowledge.video_citation_sources.extract_all_video_segments",
        wraps=extract_all_video_segments,
    ) as extract_segments:
        added = collect_and_log_knowledge_mcp_video_sources(
            collected,
            json.dumps(_document_content_payload()),
            logger=logger,
            context="test",
        )

    assert added == 0
    log_message = logger.info.call_args[0][0]
    log_args = logger.info.call_args[0]
    assert "coverage_action=%s" in log_message
    assert "segment_preferred_over_chapters" in log_args
    assert extract_segments.call_count == 1


def test_collect_document_content_builds_chapters_source() -> None:
    collected = {}

    collect_knowledge_mcp_video_sources(
        collected, json.dumps(_document_content_payload())
    )

    assert list(collected) == [(212, 825)]
    source = collected[(212, 825)]
    assert source.coverage == "complete"
    assert source.identity.title == "产品培训示例视频.mp4"
    assert [
        (s.start_sec, s.end_sec, s.title, s.description) for s in source.segments
    ] == [
        (0, 48, "背景", "开场介绍。"),
        (48, 109, "架构", "整体架构。"),
    ]


def test_collect_document_content_accepts_kb_id_alias() -> None:
    collected = {}
    payload = _document_content_payload()
    payload["kb_id"] = payload.pop("knowledge_base_id")

    collect_knowledge_mcp_video_sources(collected, payload)

    assert list(collected) == [(212, 825)]


def test_collect_document_content_skips_partial_reads_and_non_video() -> None:
    for overrides in (
        {"has_more": True},
        {"offset": 100},
        {"source_media_type": None},
        {"content": "no timestamps here"},
    ):
        collected = {}
        collect_knowledge_mcp_video_sources(
            collected, _document_content_payload(**overrides)
        )
        assert collected == {}, overrides


def _rag_chunk(start: int, end: int, document_id: int = 825) -> dict:
    return {
        "title": f"{document_id}.video.md",
        "knowledge_base_id": 212,
        "document_id": document_id,
        "metadata": {
            "source_media_type": "video",
            "video_start_sec": start,
            "video_end_sec": end,
        },
    }


def test_collect_document_content_does_not_replace_rag_segments() -> None:
    collected = {}
    collect_knowledge_mcp_video_sources(
        collected,
        {
            "mode": "rag_retrieval",
            "chunks": [_rag_chunk(10, 30), _rag_chunk(25, 50)],
        },
    )

    collect_knowledge_mcp_video_sources(collected, _document_content_payload())

    source = collected[(212, 825)]
    assert source.coverage == "retrieved"
    assert _segment_ranges(source) == [(10, 30), (25, 50)]
    assert [
        (segment.start_sec, segment.end_sec) for segment in source.available_segments
    ] == [(0, 48), (48, 109)]


def test_collect_rag_segments_replace_chapters() -> None:
    collected = {}
    collect_knowledge_mcp_video_sources(collected, _document_content_payload())

    collect_knowledge_mcp_video_sources(
        collected,
        {"mode": "rag_retrieval", "chunks": [_rag_chunk(10, 30)]},
    )

    source = collected[(212, 825)]
    assert source.coverage == "retrieved"
    assert _segment_ranges(source) == [(10, 30)]
    assert [
        (segment.start_sec, segment.end_sec) for segment in source.available_segments
    ] == [(0, 48), (48, 109)]


def test_merge_video_sources_segments_are_not_replaced_by_chapters() -> None:
    existing = [
        {
            "index": 3,
            "title": "Video",
            "kb_id": 212,
            "document_id": 825,
            "source_type": "wegent_video_segment",
            "segments": [{"start_sec": 10, "end_sec": 30}],
            "segments_truncated": True,
        }
    ]
    videos = {
        (212, 825): _built_source(
            212, 825, "825.video.md", [(0, 48)], coverage="complete"
        )
    }

    merged = merge_video_sources(existing, videos)

    assert merged[0]["source_type"] == "wegent_video_segment"
    assert [(s["start_sec"], s["end_sec"]) for s in merged[0]["segments"]] == [(10, 30)]
    assert merged[0]["segments_truncated"] is True
    assert [
        (s["start_sec"], s["end_sec"]) for s in merged[0]["available_segments"]
    ] == [(0, 48)]


def test_merge_video_sources_segments_replace_existing_chapters() -> None:
    existing = [
        {
            "index": 3,
            "title": "Video",
            "kb_id": 212,
            "document_id": 825,
            "source_type": "wegent_video_chapters",
            "segments": [{"start_sec": 0, "end_sec": 48}],
        }
    ]
    videos = {(212, 825): _built_source(212, 825, "825.video.md", [(10, 30)])}

    merged = merge_video_sources(existing, videos)

    assert merged[0]["source_type"] == "wegent_video_segment"
    assert [(s["start_sec"], s["end_sec"]) for s in merged[0]["segments"]] == [(10, 30)]
    assert [
        (s["start_sec"], s["end_sec"]) for s in merged[0]["available_segments"]
    ] == [(0, 48)]
