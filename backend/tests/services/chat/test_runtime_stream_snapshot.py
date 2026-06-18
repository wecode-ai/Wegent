# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.chat.runtime_stream_snapshot import RuntimeStreamSnapshotService


@pytest.mark.asyncio
async def test_runtime_snapshot_prefers_executor_cache(monkeypatch):
    service = RuntimeStreamSnapshotService()
    executor_snapshot = {
        "task_id": 101,
        "subtask_id": 202,
        "content": "from executor",
        "blocks": [{"id": "text-1", "type": "text", "content": "from executor"}],
        "offset": 13,
        "source": "executor",
    }
    get_executor_snapshot = AsyncMock(return_value=executor_snapshot)
    get_redis_snapshot = AsyncMock(return_value={"content": "from redis"})
    monkeypatch.setattr(service, "_get_executor_snapshot", get_executor_snapshot)
    monkeypatch.setattr(service, "_get_redis_snapshot", get_redis_snapshot)

    snapshot = await service.get_snapshot(
        task_id=101,
        subtask_id=202,
        streaming_info={
            "runtime_cache": {"enabled": True, "version": 1},
            "executor_name": "executor-1",
            "executor_namespace": "default",
        },
    )

    assert snapshot["content"] == "from executor"
    get_executor_snapshot.assert_awaited_once_with(
        subtask_id=202,
        executor_name="executor-1",
        executor_namespace="default",
    )
    get_redis_snapshot.assert_not_awaited()


@pytest.mark.asyncio
async def test_runtime_snapshot_uses_redis_without_runtime_marker(monkeypatch):
    service = RuntimeStreamSnapshotService()
    get_executor_snapshot = AsyncMock()
    get_redis_snapshot = AsyncMock(
        return_value={
            "task_id": 101,
            "subtask_id": 202,
            "content": "from redis",
            "blocks": [],
            "offset": 10,
            "source": "redis",
        }
    )
    monkeypatch.setattr(service, "_get_executor_snapshot", get_executor_snapshot)
    monkeypatch.setattr(service, "_get_redis_snapshot", get_redis_snapshot)

    snapshot = await service.get_snapshot(
        task_id=101,
        subtask_id=202,
        streaming_info={"executor_name": "old-executor"},
    )

    assert snapshot["content"] == "from redis"
    get_executor_snapshot.assert_not_awaited()
    get_redis_snapshot.assert_awaited_once_with(
        task_id=101,
        subtask_id=202,
        finalize_blocks=False,
    )
