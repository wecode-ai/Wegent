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
