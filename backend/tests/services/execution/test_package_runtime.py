# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Embedded Chat Shell transport authentication and lifecycle contracts."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sse_starlette.sse import ServerSentEvent

from app.core.config import settings
from app.services.execution.package_runtime import (
    PACKAGE_RUNTIME_PATH,
    mount_package_runtime,
    package_runtime_lifespan,
)


@pytest.fixture
def runtime(monkeypatch):
    monkeypatch.setattr(settings, "CHAT_SHELL_MODE", "package")
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "unit-package-token")
    app = FastAPI()
    mount_package_runtime(app)
    return TestClient(app)


@pytest.mark.parametrize("token", [None, "wrong-token"])
def test_engine_rejects_requests_without_internal_credentials(runtime, token):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = runtime.post(
        f"{PACKAGE_RUNTIME_PATH}/v1/responses",
        headers=headers,
        json={"model": "mock", "input": "hello", "stream": True},
    )
    assert response.status_code == 401


def test_http_mode_does_not_mount_embedded_engine(monkeypatch):
    monkeypatch.setattr(settings, "CHAT_SHELL_MODE", "http")
    app = FastAPI()
    mount_package_runtime(app)
    assert (
        TestClient(app).post(f"{PACKAGE_RUNTIME_PATH}/v1/responses").status_code == 404
    )


def test_embedded_engine_reuses_chat_shell_sse(runtime, monkeypatch):
    from chat_shell.api.v1 import response as engine

    received = []

    async def stream(request, request_id):
        received.append((request.metadata, request_id))
        yield ServerSentEvent(
            event="response.completed", data='{"type":"response.completed"}'
        )

    monkeypatch.setattr(engine, "_stream_response", stream)
    response = runtime.post(
        f"{PACKAGE_RUNTIME_PATH}/v1/responses",
        headers={
            "Authorization": "Bearer unit-package-token",
            "X-Request-ID": "package-1",
        },
        json={
            "model": "mock",
            "input": "hello",
            "stream": True,
            "metadata": {"task_id": 7},
        },
    )
    assert response.status_code == 200
    assert "event: response.completed" in response.text
    assert received == [({"task_id": 7}, "package-1")]


@pytest.mark.asyncio
@pytest.mark.parametrize("completed", [True, False])
async def test_package_shutdown_drains_or_cancels_engine_streams(
    monkeypatch, completed
):
    from chat_shell.core import shutdown

    monkeypatch.setattr(settings, "CHAT_SHELL_MODE", "package")
    manager = AsyncMock()
    manager.wait_for_streams.return_value = completed
    monkeypatch.setattr(shutdown, "shutdown_manager", manager)
    async with package_runtime_lifespan():
        manager.initiate_shutdown.assert_not_awaited()
    manager.initiate_shutdown.assert_awaited_once()
    manager.wait_for_streams.assert_awaited_once_with(
        timeout=settings.GRACEFUL_SHUTDOWN_TIMEOUT
    )
    assert manager.cancel_all_streams.await_count == (0 if completed else 1)
