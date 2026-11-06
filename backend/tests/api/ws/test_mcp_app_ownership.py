"""Ownership cleanup must survive missing and late native releases."""

import asyncio
from unittest.mock import AsyncMock

import pytest

from app.api.ws.mcp_app_ownership import McpAppOwnership

PARAMS = {
    "address": {"taskId": "task"},
    "callId": "call",
    "sessionId": "instance",
    "method": "retain",
}


@pytest.mark.asyncio
async def test_disconnect_releases_only_sessions_of_the_authenticated_owner():
    release = AsyncMock()
    owners = McpAppOwnership(release)
    await owners.request("first", 1, "device", PARAMS, AsyncMock(return_value={}))
    await owners.request(
        "second", 2, "other-device", PARAMS, AsyncMock(return_value={})
    )
    await owners.disconnect("first")
    release.assert_awaited_once_with(
        1,
        "device",
        {
            **PARAMS,
            "address": {"taskId": "task", "deviceId": "device"},
            "method": "release",
        },
    )
    await owners.disconnect("first")
    assert release.await_count == 1
    await owners.disconnect("second")
    assert release.await_count == 2


@pytest.mark.asyncio
async def test_late_retention_is_released_after_the_owner_has_disconnected():
    release = AsyncMock()
    owners = McpAppOwnership(release)
    started, complete = asyncio.Event(), asyncio.Event()

    async def pending():
        started.set()
        await complete.wait()
        return {}

    task = asyncio.create_task(owners.request("owner", 1, "device", PARAMS, pending))
    await started.wait()
    await owners.disconnect("owner")
    assert release.await_count == 0
    complete.set()
    await task
    assert release.await_count == 1


@pytest.mark.asyncio
async def test_explicit_release_is_not_repeated_on_disconnect():
    release = AsyncMock()
    owners = McpAppOwnership(release)
    await owners.request("owner", 1, "device", PARAMS, AsyncMock(return_value={}))
    await owners.request(
        "owner",
        1,
        "device",
        {**PARAMS, "method": "release"},
        AsyncMock(return_value={}),
    )
    await owners.disconnect("owner")
    release.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_retention_preserves_the_error_when_cleanup_also_fails():
    owners = McpAppOwnership(AsyncMock(side_effect=RuntimeError("cleanup")))
    with pytest.raises(ValueError, match="retain"):
        await owners.request(
            "owner", 1, "device", PARAMS, AsyncMock(side_effect=ValueError("retain"))
        )
