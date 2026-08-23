# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from shared.knowledge.video_sources import (
    BuiltVideoSource,
    VideoSourceIdentity,
    VideoSourceSegment,
    build_video_source,
    merge_video_source,
    video_source_to_payload,
)

IDENTITY = VideoSourceIdentity(knowledge_base_id=212, document_id=825, title="v.mp4")


def seg(start: int, end: int, **kwargs) -> VideoSourceSegment:
    return VideoSourceSegment(start_sec=start, end_sec=end, **kwargs)


class TestBuildVideoSource:
    def test_rejects_invalid_identity(self) -> None:
        assert (
            build_video_source(
                identity=VideoSourceIdentity(0, 825, "v.mp4"),
                coverage="complete",
                segments=[seg(0, 5)],
            )
            is None
        )
        assert (
            build_video_source(
                identity=VideoSourceIdentity(212, 825, "  "),
                coverage="complete",
                segments=[seg(0, 5)],
            )
            is None
        )

    def test_rejects_invalid_and_empty_segments(self) -> None:
        assert (
            build_video_source(
                identity=IDENTITY,
                coverage="retrieved",
                segments=[seg(-1, 5), seg(5, 5), seg(9, 4)],
            )
            is None
        )

    def test_dedupes_and_sorts_by_range(self) -> None:
        source = build_video_source(
            identity=IDENTITY,
            coverage="retrieved",
            segments=[seg(10, 20), seg(0, 5), seg(10, 20)],
        )
        assert source is not None
        assert [(s.start_sec, s.end_sec) for s in source.segments] == [(0, 5), (10, 20)]
        assert source.segments_truncated is False

    def test_caps_segments_and_marks_truncated_only_over_limit(self) -> None:
        exact = build_video_source(
            identity=IDENTITY,
            coverage="complete",
            segments=[seg(i, i + 1) for i in range(3)],
            max_segments=3,
        )
        overflowing = build_video_source(
            identity=IDENTITY,
            coverage="complete",
            segments=[seg(i, i + 1) for i in range(4)],
            max_segments=3,
        )
        assert exact is not None and exact.segments_truncated is False
        assert overflowing is not None and overflowing.segments_truncated is True
        assert len(overflowing.segments) == 3

    def test_input_truncated_flag_is_propagated(self) -> None:
        source = build_video_source(
            identity=IDENTITY,
            coverage="complete",
            segments=[seg(0, 5)],
            input_truncated=True,
        )
        assert source is not None and source.segments_truncated is True


class TestMergeVideoSource:
    def retrieved(self, *ranges: tuple[int, int], truncated: bool = False):
        return build_video_source(
            identity=IDENTITY,
            coverage="retrieved",
            segments=[seg(s, e) for s, e in ranges],
            input_truncated=truncated,
        )

    def complete(self, *ranges: tuple[int, int], truncated: bool = False):
        return build_video_source(
            identity=IDENTITY,
            coverage="complete",
            segments=[seg(s, e) for s, e in ranges],
            input_truncated=truncated,
        )

    def test_none_existing_returns_incoming(self) -> None:
        incoming = self.retrieved((0, 5))
        assert merge_video_source(None, incoming) == incoming

    def test_complete_replaces_retrieved(self) -> None:
        existing = self.retrieved((10, 30), (25, 50), truncated=True)
        incoming = self.complete((0, 60))
        merged = merge_video_source(existing, incoming)
        assert merged is incoming
        assert merged.segments_truncated is False

    def test_retrieved_does_not_extend_complete(self) -> None:
        existing = self.complete((0, 60))
        merged = merge_video_source(existing, self.retrieved((10, 30)))
        assert merged is existing

    def test_retrieved_merges_with_retrieved(self) -> None:
        existing = self.retrieved((10, 30))
        incoming = self.retrieved((0, 5), (10, 30))
        merged = merge_video_source(existing, incoming)
        assert merged.coverage == "retrieved"
        assert [(s.start_sec, s.end_sec) for s in merged.segments] == [(0, 5), (10, 30)]

    def test_complete_replaces_complete(self) -> None:
        existing = self.complete((0, 60))
        incoming = self.complete((0, 30), (30, 60))
        assert merge_video_source(existing, incoming) is incoming

    def test_different_identity_returns_incoming(self) -> None:
        existing = self.retrieved((0, 5))
        other = build_video_source(
            identity=VideoSourceIdentity(212, 826, "v.mp4"),
            coverage="retrieved",
            segments=[seg(0, 5)],
        )
        assert other is not None
        assert merge_video_source(existing, other) is other


class TestVideoSourceToPayload:
    def test_serializes_wire_format(self) -> None:
        source = build_video_source(
            identity=VideoSourceIdentity(212, 825, "  v.mp4 "),
            coverage="retrieved",
            segments=[
                seg(0, 5, segment_id="seg_a", score=0.5, title="t", description="d"),
                seg(6, 9),
            ],
            input_truncated=True,
        )
        assert source is not None
        payload = video_source_to_payload(source)
        assert payload == {
            "title": "v.mp4",
            "kb_id": 212,
            "document_id": 825,
            "segments": [
                {
                    "id": "seg_a",
                    "start_sec": 0,
                    "end_sec": 5,
                    "score": 0.5,
                    "title": "t",
                    "description": "d",
                },
                {
                    "id": "segment_6_9",
                    "start_sec": 6,
                    "end_sec": 9,
                    "title": None,
                    "description": None,
                },
            ],
            "segments_truncated": True,
        }


class TestBuildVideoSourceArgumentValidation:
    def test_rejects_non_string_title(self) -> None:
        with pytest.raises(TypeError, match="identity.title"):
            build_video_source(
                identity=VideoSourceIdentity(212, 825, None),  # type: ignore[arg-type]
                coverage="complete",
                segments=[seg(0, 5)],
            )

    def test_rejects_unknown_coverage(self) -> None:
        with pytest.raises(ValueError, match="coverage"):
            build_video_source(
                identity=IDENTITY,
                coverage="partial",  # type: ignore[arg-type]
                segments=[seg(0, 5)],
            )

    def test_rejects_non_positive_max_segments(self) -> None:
        with pytest.raises(ValueError, match="max_segments"):
            build_video_source(
                identity=IDENTITY,
                coverage="complete",
                segments=[seg(0, 5)],
                max_segments=0,
            )
