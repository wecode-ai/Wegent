# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import inspect
import threading
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints import oauth_provider
from app.services.auth.oauth_provider import oauth_provider_service


async def _wait_for_worker(started: threading.Event) -> None:
    for _ in range(200):
        if started.is_set():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("OAuth provider database worker did not start")


@pytest.mark.asyncio
async def test_oauth_provider_database_phase_does_not_block_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_names: list[str] = []

    monkeypatch.setattr(
        "app.services.auth.oauth_provider.cache_manager.get",
        AsyncMock(
            return_value={
                "client_kind_id": 7,
                "client_id": "client",
                "scope": "userinfo.read",
                "redirect_uri": "https://client.example/callback",
            }
        ),
    )

    def blocked_client_name(client_kind_id: int) -> str:
        assert client_kind_id == 7
        worker_names.append(threading.current_thread().name)
        started.set()
        release.wait(timeout=5)
        return "Client"

    monkeypatch.setattr(
        oauth_provider_service,
        "_active_client_name",
        blocked_client_name,
    )
    task = asyncio.create_task(
        oauth_provider_service.get_authorization_request("request-id")
    )
    try:
        await _wait_for_worker(started)
        ticked = asyncio.Event()
        asyncio.get_running_loop().call_soon(ticked.set)
        await asyncio.wait_for(ticked.wait(), timeout=0.1)
        assert not task.done()
    finally:
        release.set()

    response = await task
    assert response.client_name == "Client"
    assert worker_names and worker_names[0].startswith("wegent-db")


def test_oauth_provider_async_routes_do_not_accept_sync_sessions() -> None:
    routes = (
        oauth_provider.authorize,
        oauth_provider.get_authorization_request,
        oauth_provider.approve_authorization_request,
        oauth_provider.deny_authorization_request,
        oauth_provider.token,
    )
    for route in routes:
        annotations = {
            str(parameter.annotation)
            for parameter in inspect.signature(route).parameters.values()
        }
        assert not any("Session" in annotation for annotation in annotations)
