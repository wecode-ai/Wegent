# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Health endpoint contracts for the isolated stream worker."""

import asyncio
import threading
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from app.api.endpoints.health import readiness_check, router


@pytest.mark.asyncio
async def test_readiness_requires_database_and_real_stream_worker_round_trip() -> None:
    response = Response()
    stream_ping = AsyncMock()
    channel_ping = AsyncMock()

    with (
        patch("app.api.endpoints.health._check_database_readiness_sync") as database,
        patch(
            "app.api.endpoints.health.stream_execution_client.ping",
            stream_ping,
        ),
        patch(
            "app.api.endpoints.health.channel_worker_client.ping",
            channel_ping,
        ),
    ):
        result = await readiness_check(response)

    assert response.status_code == 200
    assert result == {"status": "ready"}
    database.assert_called_once_with()
    stream_ping.assert_awaited_once_with()
    channel_ping.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_readiness_fails_when_stream_worker_does_not_respond() -> None:
    response = Response()
    ping = AsyncMock(side_effect=TimeoutError("stalled"))
    channel_ping = AsyncMock()

    with (
        patch("app.api.endpoints.health._check_database_readiness_sync"),
        patch(
            "app.api.endpoints.health.stream_execution_client.ping",
            ping,
        ),
        patch(
            "app.api.endpoints.health.channel_worker_client.ping",
            channel_ping,
        ),
    ):
        result = await readiness_check(response)

    assert response.status_code == 503
    assert result["status"] == "not_ready"
    assert "stalled" in result["message"]
    ping.assert_awaited_once_with()
    channel_ping.assert_not_awaited()


@pytest.mark.asyncio
async def test_readiness_database_probe_keeps_event_loop_responsive() -> None:
    response = Response()
    started = threading.Event()
    release = threading.Event()

    def blocking_database_probe() -> None:
        started.set()
        release.wait(timeout=1)

    release_timer = threading.Timer(0.2, release.set)
    release_timer.start()
    loop = asyncio.get_running_loop()
    started_at = loop.time()
    with (
        patch(
            "app.api.endpoints.health._check_database_readiness_sync",
            blocking_database_probe,
        ),
        patch(
            "app.api.endpoints.health.stream_execution_client.ping",
            new=AsyncMock(),
        ),
        patch(
            "app.api.endpoints.health.channel_worker_client.ping",
            new=AsyncMock(),
        ),
    ):
        operation = asyncio.create_task(readiness_check(response))
        await asyncio.sleep(0.02)

        assert started.is_set()
        assert loop.time() - started_at < 0.1
        assert not operation.done()

        release.set()
        result = await operation
    release_timer.cancel()
    assert result == {"status": "ready"}


@pytest.mark.asyncio
async def test_readiness_fails_before_stream_ping_when_database_is_down() -> None:
    response = Response()
    stream_ping = AsyncMock()
    channel_ping = AsyncMock()

    with (
        patch(
            "app.api.endpoints.health._check_database_readiness_sync",
            side_effect=ConnectionError("database unavailable"),
        ),
        patch(
            "app.api.endpoints.health.stream_execution_client.ping",
            stream_ping,
        ),
        patch(
            "app.api.endpoints.health.channel_worker_client.ping",
            channel_ping,
        ),
    ):
        result = await readiness_check(response)

    assert response.status_code == 503
    assert result["status"] == "not_ready"
    assert "database unavailable" in result["message"]
    stream_ping.assert_not_awaited()
    channel_ping.assert_not_awaited()


@pytest.mark.asyncio
async def test_readiness_fails_when_channel_worker_does_not_respond() -> None:
    response = Response()
    channel_ping = AsyncMock(side_effect=TimeoutError("channel stalled"))

    with (
        patch("app.api.endpoints.health._check_database_readiness_sync"),
        patch(
            "app.api.endpoints.health.stream_execution_client.ping",
            new=AsyncMock(),
        ),
        patch(
            "app.api.endpoints.health.channel_worker_client.ping",
            channel_ping,
        ),
    ):
        result = await readiness_check(response)

    assert response.status_code == 503
    assert result["status"] == "not_ready"
    assert "channel stalled" in result["message"]
    channel_ping.assert_awaited_once_with()


@pytest.mark.parametrize(
    "path",
    [
        "/shutdown/initiate",
        "/shutdown/wait",
        "/shutdown/reset",
    ],
)
def test_shutdown_mutation_is_not_exposed(path: str) -> None:
    app = FastAPI()
    app.include_router(router)

    response = TestClient(app).post(path)

    assert response.status_code == 404
