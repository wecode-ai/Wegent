# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for MCP tools that execute inside the Web process."""

from __future__ import annotations

import threading
from unittest.mock import AsyncMock

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import prompt_optimization, subscription

TOKEN_INFO = TaskTokenInfo(
    task_id=11,
    subtask_id=22,
    user_id=33,
    user_name="mcp-user",
)


@pytest.mark.asyncio
async def test_get_team_prompt_runs_store_work_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []

    def load_prompt(_task_id: int, _user_id: int) -> dict[str, object]:
        worker_thread_ids.append(threading.get_ident())
        return {"team_id": 1, "assembled_prompt": "prompt", "sources": []}

    monkeypatch.setattr(
        prompt_optimization,
        "_load_team_prompt_from_store",
        load_prompt,
    )

    result = await prompt_optimization.get_team_prompt(TOKEN_INFO)

    assert result["team_id"] == 1
    assert worker_thread_ids
    assert worker_thread_ids[0] != loop_thread_id


@pytest.mark.asyncio
async def test_submit_prompt_changes_prepares_payload_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []

    def prepare_payload(
        task_id: int,
        subtask_id: int,
        _user_id: int,
        changes: list[dict[str, object]],
    ) -> dict[str, object]:
        worker_thread_ids.append(threading.get_ident())
        return {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "changes": changes,
        }

    send_block = AsyncMock()
    monkeypatch.setattr(
        prompt_optimization,
        "_prepare_prompt_changes_from_store",
        prepare_payload,
    )
    monkeypatch.setattr(prompt_optimization, "_send_block_to_frontend", send_block)

    result = await prompt_optimization.submit_prompt_changes(
        TOKEN_INFO,
        [{"type": "ghost", "id": 1, "suggested": "new prompt"}],
    )

    assert result["__silent_exit__"] is True
    assert worker_thread_ids
    assert worker_thread_ids[0] != loop_thread_id
    send_block.assert_awaited_once()


@pytest.mark.asyncio
async def test_subscription_preview_runs_db_and_redis_off_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []

    def load_task(_task_id: int) -> dict[str, object]:
        worker_thread_ids.append(threading.get_ident())
        return {
            "team_id": 44,
            "team_namespace": "default",
            "model_name": None,
            "model_namespace": "default",
        }

    def store_preview(_preview_id: str, _data: dict[str, object]) -> bool:
        worker_thread_ids.append(threading.get_ident())
        return True

    monkeypatch.setattr(subscription, "_get_task_info_from_store", load_task)
    monkeypatch.setattr(subscription, "_store_preview_data", store_preview)
    monkeypatch.setattr(
        subscription,
        "_send_subscription_preview_block",
        AsyncMock(),
    )

    from app.services.chat.storage.session import session_manager

    monkeypatch.setattr(session_manager, "get_blocks", AsyncMock(return_value=[]))

    result = await subscription.preview_subscription(
        TOKEN_INFO,
        display_name="Daily report",
        trigger_type="interval",
        prompt_template="Summarize progress",
        interval_value=1,
        interval_unit="days",
    )

    assert result["__silent_exit__"] is True
    assert len(worker_thread_ids) == 2
    assert all(thread_id != loop_thread_id for thread_id in worker_thread_ids)
