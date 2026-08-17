# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.execution.agents.video import recovery


@pytest.mark.asyncio
async def test_recover_video_jobs_after_stale_delay_waits_then_recovers(
    monkeypatch,
):
    sleep = AsyncMock()
    recover = AsyncMock(return_value=3)
    monkeypatch.setattr(recovery.asyncio, "sleep", sleep)
    monkeypatch.setattr(recovery, "recover_video_jobs", recover)

    recovered_count = await recovery.recover_video_jobs_after_stale_delay()

    sleep.assert_awaited_once_with(recovery.STALE_THRESHOLD_SECONDS)
    recover.assert_awaited_once_with()
    assert recovered_count == 3
