# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio

import pytest

from app.api.ws import device_namespace as device_namespace_module
from app.api.ws.device_namespace import DeviceNamespace
from app.core.web_background_tasks import WebBackgroundTaskManager


@pytest.fixture
def background_manager(monkeypatch) -> WebBackgroundTaskManager:
    manager = WebBackgroundTaskManager(max_concurrency=2, max_outstanding=4)
    monkeypatch.setattr(
        device_namespace_module,
        "web_background_task_manager",
        manager,
    )
    return manager


@pytest.mark.asyncio
async def test_background_tasks_are_deduplicated_by_device_operation(
    background_manager,
) -> None:
    background_manager.start()
    namespace = DeviceNamespace()
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    duplicate_started = asyncio.Event()
    key = ("execution-reconcile", 7, "device-1")

    async def first() -> None:
        first_started.set()
        await release_first.wait()

    async def duplicate() -> None:
        duplicate_started.set()

    assert await namespace._schedule_background_task(first, "first", key=key) is True
    await asyncio.wait_for(first_started.wait(), timeout=0.1)

    assert (
        await namespace._schedule_background_task(duplicate, "duplicate", key=key)
        is False
    )
    await asyncio.sleep(0)
    assert not duplicate_started.is_set()
    assert background_manager.outstanding_count == 1

    release_first.set()
    await background_manager.drain()

    assert namespace._background_task_keys == set()


@pytest.mark.asyncio
async def test_shutdown_joins_background_tasks_without_cancelling(
    background_manager,
) -> None:
    background_manager.start()
    namespace = DeviceNamespace()
    started = asyncio.Event()
    release = asyncio.Event()
    cancelled = asyncio.Event()

    async def pending() -> None:
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    await namespace._schedule_background_task(
        pending,
        "pending",
        key=("capability-sync", 7, "device-1"),
    )
    await asyncio.wait_for(started.wait(), timeout=0.1)

    shutdown = asyncio.create_task(namespace.shutdown_background_tasks())
    await asyncio.sleep(0)

    assert not shutdown.done()
    assert not cancelled.is_set()
    release.set()
    await shutdown

    assert not cancelled.is_set()
    assert namespace._background_task_keys == set()


@pytest.mark.asyncio
async def test_shutdown_rejects_new_background_tasks(
    monkeypatch,
    background_manager,
) -> None:
    background_manager.start()
    namespace = DeviceNamespace()
    started = asyncio.Event()

    async def follow_up() -> None:
        started.set()

    monkeypatch.setattr(
        device_namespace_module.shutdown_manager,
        "_shutting_down",
        True,
    )

    assert (
        await namespace._schedule_background_task(
            follow_up,
            "follow-up",
            key=("execution-reconcile", 7, "device-1"),
        )
        is False
    )
    await asyncio.sleep(0)

    assert not started.is_set()
    assert background_manager.outstanding_count == 0
