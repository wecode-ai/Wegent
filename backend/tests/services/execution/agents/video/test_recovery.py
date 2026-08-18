# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for video polling recovery."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.services.execution.agents.video.recovery import (
    STALE_THRESHOLD_SECONDS,
    _is_polling_context_stale,
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
