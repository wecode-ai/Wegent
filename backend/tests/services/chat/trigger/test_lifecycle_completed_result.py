# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.chat.trigger import lifecycle


class _SessionManager:
    async def get_accumulated_content(self, _subtask_id: int) -> str:
        return ""

    async def finalize_and_get_blocks(self, _subtask_id: int) -> list[dict]:
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

    async def finalize_and_get_blocks(self, _subtask_id: int) -> list[dict]:
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

    async def finalize_and_get_blocks(self, _subtask_id: int) -> list[dict]:
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


class _SnapshotService:
    def __init__(self, snapshot: dict):
        self.snapshot = snapshot

    async def get_snapshot(self, **_kwargs) -> dict:
        return self.snapshot


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
async def test_collect_completed_result_drops_reasoning_only_snapshot_blocks(
    monkeypatch,
):
    async def _empty_existing_result(_subtask_id: int) -> dict:
        return {}

    monkeypatch.setattr(
        lifecycle,
        "_get_existing_subtask_result",
        _empty_existing_result,
    )
    monkeypatch.setattr(
        "app.services.chat.runtime_stream_snapshot.runtime_stream_snapshot_service",
        _SnapshotService(
            {
                "content": "Visible assistant answer.",
                "blocks": [
                    {
                        "id": "thinking-1",
                        "type": "thinking",
                        "content": "Drafting the answer.",
                        "status": "done",
                    }
                ],
            }
        ),
    )

    result = await lifecycle.collect_completed_result(
        1234,
        status="COMPLETED",
        result={"value": "Visible assistant answer."},
    )

    assert result is not None
    assert result["value"] == "Visible assistant answer."
    assert "blocks" not in result


@pytest.mark.asyncio
async def test_collect_completed_result_preserves_snapshot_blocks_with_tools(
    monkeypatch,
):
    async def _empty_existing_result(_subtask_id: int) -> dict:
        return {}

    monkeypatch.setattr(
        lifecycle,
        "_get_existing_subtask_result",
        _empty_existing_result,
    )
    monkeypatch.setattr(
        "app.services.chat.runtime_stream_snapshot.runtime_stream_snapshot_service",
        _SnapshotService(
            {
                "content": "Final answer.",
                "blocks": [
                    {
                        "id": "thinking-1",
                        "type": "thinking",
                        "content": "Checking files.",
                        "status": "done",
                    },
                    {
                        "id": "tool-1",
                        "type": "tool",
                        "tool_name": "Bash",
                        "status": "done",
                    },
                ],
            }
        ),
    )

    result = await lifecycle.collect_completed_result(
        1234,
        status="COMPLETED",
        result={"value": "Final answer."},
    )

    assert result is not None
    assert [block["type"] for block in result["blocks"]] == ["thinking", "tool"]
