# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.chat.trigger import lifecycle


def test_merge_blocks_does_not_regress_terminal_card_to_pending():
    populated = {
        "id": "card-1",
        "type": "card",
        "status": "done",
        "card_status": "populated",
        "card_data": {"video_url": "https://example.com/video.mp4"},
        "card_preview_data": {"progress": 100},
    }
    stale_pending = {
        "id": "card-1",
        "type": "card",
        "status": "pending",
        "card_status": "pending",
        "card_data": {},
        "card_preview_data": {"progress": 0},
    }

    assert lifecycle._merge_blocks([populated], [stale_pending]) == [populated]


class _SessionManager:
    async def get_accumulated_content(self, _subtask_id: int) -> str:
        return ""

    async def finalize_and_get_blocks(
        self,
        _subtask_id: int,
        *,
        termination_reason: str | None = None,
        terminal_status: str | None = None,
    ) -> list[dict]:
        return [
            {
                "id": "tool_123",
                "type": "tool",
                "tool_use_id": "tool_123",
                "tool_name": "interactive_form_question",
                "status": "pending",
                "tool_output": {"status": "waiting_for_user_response"},
                "render_payload": {
                    "type": "interactive_form_question",
                    "task_id": 777,
                    "subtask_id": 1234,
                    "questions": [
                        {
                            "id": "genre",
                            "question": "Genre?",
                            "input_type": "choice",
                            "options": [{"label": "Fantasy", "value": "fantasy"}],
                        }
                    ],
                },
            }
        ]


class _TextBlockSessionManager:
    async def get_accumulated_content(self, _subtask_id: int) -> str:
        return ""

    async def finalize_and_get_blocks(
        self,
        _subtask_id: int,
        *,
        termination_reason: str | None = None,
        terminal_status: str | None = None,
    ) -> list[dict]:
        return [
            {
                "id": "text-1",
                "type": "text",
                "content": "Stage 1 found three release risks.",
                "status": "done",
            }
        ]


class _OutputTextBlockSessionManager:
    async def get_accumulated_content(self, _subtask_id: int) -> str:
        return ""

    async def finalize_and_get_blocks(
        self,
        _subtask_id: int,
        *,
        termination_reason: str | None = None,
        terminal_status: str | None = None,
    ) -> list[dict]:
        return [
            {
                "id": "reasoning-1",
                "type": "reasoning",
                "text": "Private reasoning should not be handed off.",
            },
            {
                "id": "output-1",
                "type": "output_text",
                "text": "Visible assistant answer.",
            },
            {
                "id": "tool-1",
                "type": "tool",
                "tool_name": "Example",
                "tool_output": "Tool output should not be handed off.",
            },
        ]


class _McpImageResultSessionManager:
    async def get_accumulated_content(self, _subtask_id: int) -> str:
        return "Image generated."

    async def finalize_and_get_blocks(
        self,
        _subtask_id: int,
        *,
        termination_reason: str | None = None,
        terminal_status: str | None = None,
    ) -> list[dict]:
        return [
            {
                "id": "tool-image-1",
                "type": "tool",
                "tool_name": "wegent-image_generate_image",
                "status": "done",
                "tool_output": [
                    {
                        "type": "text",
                        "text": (
                            '{"type":"images","result_data":{"blocks":['
                            '{"id":"image-1","type":"image","status":"done",'
                            '"image_urls":["/api/attachments/40/download"],'
                            '"image_attachment_ids":[40],"image_count":1}]}}'
                        ),
                    }
                ],
            }
        ]


@pytest.mark.asyncio
async def test_collect_completed_result_merges_duplicate_block_fields(monkeypatch):
    async def _empty_existing_result(_subtask_id: int) -> dict:
        return {}

    monkeypatch.setattr(
        lifecycle,
        "_get_existing_subtask_result",
        _empty_existing_result,
    )

    import app.services.chat.storage as chat_storage

    monkeypatch.setattr(chat_storage, "session_manager", _SessionManager())

    result = await lifecycle.collect_completed_result(
        1234,
        status="COMPLETED",
        result={
            "value": "请回答上面的几个问题",
            "blocks": [
                {
                    "id": "tool_123",
                    "type": "tool",
                    "tool_use_id": "tool_123",
                    "tool_name": "interactive_form_question",
                    "status": "done",
                }
            ],
        },
    )

    assert result is not None
    assert result["blocks"] == [
        {
            "id": "tool_123",
            "type": "tool",
            "tool_use_id": "tool_123",
            "tool_name": "interactive_form_question",
            "status": "pending",
            "tool_output": {"status": "waiting_for_user_response"},
            "render_payload": {
                "type": "interactive_form_question",
                "task_id": 777,
                "subtask_id": 1234,
                "questions": [
                    {
                        "id": "genre",
                        "question": "Genre?",
                        "input_type": "choice",
                        "options": [{"label": "Fantasy", "value": "fantasy"}],
                    }
                ],
            },
        }
    ]


@pytest.mark.asyncio
async def test_collect_completed_result_preserves_file_changes_with_blocks(monkeypatch):
    async def _empty_existing_result(_subtask_id: int) -> dict:
        return {}

    monkeypatch.setattr(
        lifecycle,
        "_get_existing_subtask_result",
        _empty_existing_result,
    )

    import app.services.chat.storage as chat_storage

    monkeypatch.setattr(chat_storage, "session_manager", _SessionManager())

    result = await lifecycle.collect_completed_result(
        1234,
        status="COMPLETED",
        result={
            "value": "done",
            "file_changes": {
                "version": 1,
                "status": "active",
                "artifact_id": "turn-file-changes/7/1234",
                "device_id": "device-1",
                "workspace_path": "/workspace/project",
                "file_count": 1,
                "additions": 4,
                "deletions": 2,
                "files": [],
                "reverted_at": None,
            },
        },
    )

    assert result is not None
    assert result["value"] == "done"
    assert result["blocks"]
    assert result["file_changes"]["file_count"] == 1


@pytest.mark.asyncio
async def test_collect_completed_result_normalizes_empty_value_from_text_blocks(
    monkeypatch,
):
    async def _empty_existing_result(_subtask_id: int) -> dict:
        return {}

    monkeypatch.setattr(
        lifecycle,
        "_get_existing_subtask_result",
        _empty_existing_result,
    )

    import app.services.chat.storage as chat_storage

    monkeypatch.setattr(chat_storage, "session_manager", _TextBlockSessionManager())

    result = await lifecycle.collect_completed_result(
        1234,
        status="COMPLETED",
        result={"value": ""},
    )

    assert result is not None
    assert result["value"] == "Stage 1 found three release risks."


@pytest.mark.asyncio
async def test_collect_completed_result_normalizes_empty_value_from_output_text_blocks(
    monkeypatch,
):
    async def _empty_existing_result(_subtask_id: int) -> dict:
        return {}

    monkeypatch.setattr(
        lifecycle,
        "_get_existing_subtask_result",
        _empty_existing_result,
    )

    import app.services.chat.storage as chat_storage

    monkeypatch.setattr(
        chat_storage, "session_manager", _OutputTextBlockSessionManager()
    )

    result = await lifecycle.collect_completed_result(
        1234,
        status="COMPLETED",
        result={"value": ""},
    )

    assert result is not None
    assert result["value"] == "Visible assistant answer."


@pytest.mark.asyncio
async def test_collect_completed_result_promotes_mcp_result_blocks(
    monkeypatch,
) -> None:
    async def _empty_existing_result(_subtask_id: int) -> dict:
        return {}

    monkeypatch.setattr(
        lifecycle,
        "_get_existing_subtask_result",
        _empty_existing_result,
    )

    import app.services.chat.storage as chat_storage

    monkeypatch.setattr(
        chat_storage,
        "session_manager",
        _McpImageResultSessionManager(),
    )

    result = await lifecycle.collect_completed_result(
        1234,
        status="COMPLETED",
        result={"value": "Image generated."},
    )

    assert result is not None
    assert [block["type"] for block in result["blocks"]] == ["tool", "image"]
    assert result["blocks"][1]["image_attachment_ids"] == [40]


@pytest.mark.asyncio
async def test_collect_completed_result_adds_sources_for_successful_knowledge_tools(
    monkeypatch,
):
    existing = {"index": 3, "kb_id": 42, "document_id": 71, "title": "Existing source"}
    read = {
        "kb_id": 42,
        "document_id": 72,
        "name": "Retrieved document.md",
        "content": "marker",
    }
    native_tool = {
        "type": "tool",
        "status": "done",
        "tool_name": "wegent-knowledge_wegent_kb_read_document_content",
        "server_label": "",
    }
    blocks = [
        {**native_tool, "tool_output": [{"type": "text", "text": json.dumps(read)}]},
        {**native_tool, "tool_output": read},
        {
            **native_tool,
            "tool_name": "wegent-knowledge_wegent_kb_search_knowledge_base",
            "tool_output": {
                "mode": "rag_retrieval",
                "sources": [
                    {
                        "knowledge_base_id": 42,
                        "document_id": "73",
                        "document_name": "Search hit.md",
                    }
                ],
            },
        },
        {**native_tool, "status": "error", "tool_output": {**read, "document_id": 99}},
        {
            **native_tool,
            "server_label": "other",
            "tool_output": {**read, "document_id": 99},
        },
        {**native_tool, "tool_output": {**read, "document_id": 99, "content": ""}},
        {
            **native_tool,
            "tool_name": "wegent_kb_read_document_content",
            "tool_output": {**read, "document_id": 99},
        },
    ]

    import app.services.chat.storage as chat_storage

    async def empty_result(_subtask_id: int) -> dict:
        return {}

    monkeypatch.setattr(lifecycle, "_get_existing_subtask_result", empty_result)
    monkeypatch.setattr(
        chat_storage,
        "session_manager",
        SimpleNamespace(
            get_accumulated_content=AsyncMock(return_value="Answer"),
            finalize_and_get_blocks=AsyncMock(return_value=blocks),
        ),
    )

    result = await lifecycle.collect_completed_result(
        1234, status="COMPLETED", result={"sources": [existing]}
    )

    assert result is not None
    assert result["sources"] == [
        existing,
        {"index": 4, "kb_id": 42, "document_id": 72, "title": "Retrieved document.md"},
        {"index": 5, "kb_id": 42, "document_id": 73, "title": "Search hit.md"},
    ]
