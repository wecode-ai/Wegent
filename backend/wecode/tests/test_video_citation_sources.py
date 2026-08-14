# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import Mock

from wecode.service.knowledge.video_citation_sources import (
    MAX_VIDEO_SEGMENTS_PER_SOURCE,
    collect_and_log_knowledge_mcp_video_sources,
    collect_knowledge_mcp_video_sources,
    merge_video_sources,
)

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
    videos = {
        (211, 811): {
            "index": 1,
            "title": "811.video.md",
            "kb_id": 211,
            "document_id": 811,
            "source_type": "wegent_video_segment",
            "segments": [{"start_sec": 6, "end_sec": 15}],
        }
    }

    merged = merge_video_sources(existing, videos)

    assert len(merged) == 2
    assert merged[0]["index"] == 4
    assert merged[0]["title"] == "Video document"
    assert merged[0]["source_type"] == "wegent_video_segment"
    assert merged[0]["segments"] == [{"start_sec": 6, "end_sec": 15}]
    assert merged[1] == existing[1]


def test_merge_video_sources_appends_new_document_after_existing_indexes() -> None:
    videos = {
        (211, 813): {
            "index": 1,
            "title": "813.video.md",
            "kb_id": 211,
            "document_id": 813,
            "source_type": "wegent_video_segment",
            "segments": [{"start_sec": 0, "end_sec": 5}],
        }
    }

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
        (211, 811): {
            "title": "811.video.md",
            "kb_id": 211,
            "document_id": 811,
            "source_type": "wegent_video_segment",
            "segments": [
                {"start_sec": 200, "end_sec": 201},
                {"start_sec": 202, "end_sec": 203},
            ],
        }
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
    assert merged[0]["segments"][-1] == {"start_sec": 200, "end_sec": 201}
    assert merged[0]["segments_truncated"] is True


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


def test_collect_document_content_builds_chapters_source() -> None:
    collected = {}

    collect_knowledge_mcp_video_sources(
        collected, json.dumps(_document_content_payload())
    )

    assert list(collected) == [(212, 825)]
    source = collected[(212, 825)]
    assert source["source_type"] == "wegent_video_chapters"
    assert source["title"] == "产品培训示例视频.mp4"
    assert source["segments"] == [
        {
            "id": "segment_0_48",
            "start_sec": 0,
            "end_sec": 48,
            "title": "背景",
            "description": "开场介绍。",
        },
        {
            "id": "segment_48_109",
            "start_sec": 48,
            "end_sec": 109,
            "title": "架构",
            "description": "整体架构。",
        },
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


def test_collect_document_content_upgrades_existing_rag_source_type() -> None:
    collected = {}
    collect_knowledge_mcp_video_sources(
        collected,
        {
            "mode": "rag_retrieval",
            "chunks": [
                {
                    "title": "825.video.md",
                    "knowledge_base_id": 212,
                    "document_id": 825,
                    "metadata": {
                        "source_media_type": "video",
                        "video_start_sec": 0,
                        "video_end_sec": 48,
                    },
                }
            ],
        },
    )

    collect_knowledge_mcp_video_sources(collected, _document_content_payload())

    source = collected[(212, 825)]
    assert source["source_type"] == "wegent_video_chapters"
    # The RAG segment (0-48) is deduped against the parsed chapter range.
    assert [(s["start_sec"], s["end_sec"]) for s in source["segments"]] == [
        (0, 48),
        (48, 109),
    ]
