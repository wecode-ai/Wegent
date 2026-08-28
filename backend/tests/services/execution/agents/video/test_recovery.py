# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for video polling recovery."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.agents.video.recovery import (
    STALE_THRESHOLD_SECONDS,
    _do_recover_video_jobs,
    _is_polling_context_stale,
    _recover_video_jobs_sync,
    recover_video_jobs,
    recover_video_jobs_after_stale_delay,
)


def test_polling_context_stale_after_threshold() -> None:
    now = datetime.now(timezone.utc)

    assert _is_polling_context_stale(
        {
            "status": "polling",
            "last_poll_at": (
                now - timedelta(seconds=STALE_THRESHOLD_SECONDS + 1)
            ).isoformat(),
        },
        now,
        subtask_id=1,
    )


def test_polling_context_fresh_before_threshold() -> None:
    now = datetime.now(timezone.utc)

    assert not _is_polling_context_stale(
        {
            "status": "polling",
            "last_poll_at": (now - timedelta(seconds=1)).isoformat(),
        },
        now,
        subtask_id=1,
    )


@pytest.mark.asyncio
async def test_recovery_runs_blocking_work_in_thread() -> None:
    with patch(
        "app.services.execution.agents.video.recovery.asyncio.to_thread",
        new=AsyncMock(return_value=3),
    ) as to_thread:
        recovered_count = await recover_video_jobs()

    to_thread.assert_awaited_once_with(_recover_video_jobs_sync)
    assert recovered_count == 3


@pytest.mark.asyncio
async def test_delayed_recovery_runs_second_pass() -> None:
    with (
        patch(
            "app.services.execution.agents.video.recovery.asyncio.sleep",
            new=AsyncMock(),
        ) as sleep,
        patch(
            "app.services.execution.agents.video.recovery.recover_video_jobs",
            new=AsyncMock(return_value=2),
        ) as recover,
    ):
        recovered_count = await recover_video_jobs_after_stale_delay()

    sleep.assert_awaited_once_with(STALE_THRESHOLD_SECONDS + 1)
    recover.assert_awaited_once_with()
    assert recovered_count == 2


def test_recovery_requeues_async_card_with_existing_video_poller() -> None:
    subtask = SimpleNamespace(
        id=2,
        task_id=1,
        message_id=3,
        result={
            "video_job": {
                "job_id": "https://workflow.example.com/task/1",
                "query_url": "https://workflow.example.com/task/1",
                "card_type": "video_director_generation",
                "preview_title": "test-preview-title",
                "progress_text": "test-progress",
                "status": "polling",
                "video_block_id": "card-1",
                "poll_count": 4,
                "progress": 42,
                "last_poll_at": "2020-01-01T00:00:00+00:00",
            }
        },
    )
    db = MagicMock()

    with (
        patch("app.db.session.SessionLocal", return_value=db),
        patch(
            "app.services.execution.agents.video.recovery."
            "subtask_store.list_running_since",
            return_value=[subtask],
        ),
        patch(
            "app.services.execution.agents.video.recovery._get_user_id_for_task",
            return_value=9,
        ),
        patch(
            "app.services.execution.agents.video.recovery."
            "_get_model_config_for_subtask",
            return_value={},
        ),
        patch("app.tasks.video_tasks.dispatch_video_polling_task") as dispatch,
    ):
        recovered = _do_recover_video_jobs()

    assert recovered == 1
    assert dispatch.call_args.kwargs["card_context"] == {
        "query_url": "https://workflow.example.com/task/1",
        "card_type": "video_director_generation",
        "preview_title": "test-preview-title",
        "progress_text": "test-progress",
    }
    assert dispatch.call_args.kwargs["poll_count"] == 4
