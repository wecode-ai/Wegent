# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for citation source aggregation in streaming state."""

from chat_shell.services.streaming.core import StreamingState


def _state() -> StreamingState:
    return StreamingState(task_id=1, subtask_id=2, user_id=3)


def test_add_sources_keeps_same_title_documents_in_same_knowledge_base():
    state = _state()

    state.add_sources(
        [
            {"kb_id": 211, "document_id": 811, "title": "chapter.video.md"},
            {"kb_id": 211, "document_id": 812, "title": "chapter.video.md"},
        ]
    )

    assert [source["document_id"] for source in state.sources] == [811, 812]


def test_add_sources_deduplicates_same_document():
    state = _state()
    source = {"kb_id": 211, "document_id": 811, "title": "chapter.video.md"}

    state.add_sources([source])
    state.add_sources([source.copy()])

    assert state.sources == [source]


def test_add_sources_preserves_legacy_deduplication_without_document_id():
    state = _state()
    source = {"kb_id": 211, "title": "legacy.md"}

    state.add_sources([source, source.copy()])

    assert state.sources == [source]


def test_add_sources_preserves_external_source_identity_behavior():
    state = _state()

    state.add_sources(
        [
            {"source_id": "external-1", "title": "document.md"},
            {"source_id": "external-1", "title": "document.md"},
            {"source_id": "external-2", "title": "document.md"},
        ]
    )

    assert [source["source_id"] for source in state.sources] == [
        "external-1",
        "external-2",
    ]
