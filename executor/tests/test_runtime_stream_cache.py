# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from executor.services.runtime_stream_cache import RuntimeStreamCache
from shared.models.responses_api import ResponsesAPIStreamEvents


@pytest.mark.asyncio
async def test_runtime_stream_cache_records_and_cleans_snapshot():
    cache = RuntimeStreamCache()

    await cache.record_event(
        event_type=ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
        task_id=101,
        subtask_id=202,
        data={"delta": "hello"},
    )
    await cache.record_event(
        event_type=ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
        task_id=101,
        subtask_id=202,
        data={},
    )

    snapshot = await cache.get_snapshot(202)
    assert snapshot is not None
    assert snapshot["content"] == "hello"
    assert snapshot["terminal"] is True
    assert snapshot["blocks"][0]["status"] == "done"

    removed = await cache.cleanup(202)
    assert removed is True
    assert await cache.get_snapshot(202) is None
