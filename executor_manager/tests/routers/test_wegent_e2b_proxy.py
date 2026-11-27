# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from executor_manager.routers import wegent_e2b_proxy


@pytest.mark.asyncio
async def test_cancelled_proxy_waits_for_forwarded_workspace_write():
    started = asyncio.Event()
    published = asyncio.Event()

    async def upload() -> httpx.Response:
        started.set()
        await published.wait()
        return httpx.Response(200)

    caller = asyncio.create_task(wegent_e2b_proxy._await_workspace_write(upload()))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        for _ in range(2):
            caller.cancel()
            await asyncio.sleep(0)
            assert not caller.done()
    finally:
        published.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(caller, timeout=2)


@pytest.mark.asyncio
async def test_proxy_health_lookup_uses_the_selected_e2b_runtime(mocker):
    selected = SimpleNamespace(sandbox_id="12345")
    get_sandbox = mocker.AsyncMock(return_value=None)
    manager = SimpleNamespace(get_sandbox=get_sandbox)
    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)
    mocker.patch.object(
        wegent_e2b_proxy, "_find_sandbox_by_e2b_id", return_value=selected
    )

    with pytest.raises(HTTPException) as exc_info:
        await wegent_e2b_proxy._get_sandbox_info("original-e2b-id")

    assert exc_info.value.status_code == 404
    get_sandbox.assert_awaited_once_with(
        "12345", check_health=True, expected_runtime=selected
    )


@pytest.mark.asyncio
async def test_touch_sandbox_activity_rejects_a_terminated_runtime(mocker):
    """Proxied E2B SDK calls should refresh sandbox activity for GC."""
    refresh = mocker.AsyncMock(return_value=(None, "Sandbox 1385 not found"))
    manager = SimpleNamespace(refresh_sandbox_activity=refresh)
    sandbox = MagicMock()
    sandbox.sandbox_id = "1385"

    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)

    with pytest.raises(HTTPException) as exc_info:
        await wegent_e2b_proxy._touch_sandbox_activity(sandbox)
    assert exc_info.value.status_code == 503
    refresh.assert_awaited_once_with("1385", expected_runtime=sandbox)


def test_legacy_process_start_keeps_default_read_timeout():
    timeout = wegent_e2b_proxy._sandbox_proxy_timeout("process.Process/Start")

    assert timeout.read == 1800.0
    assert timeout.connect == 10.0


def test_regular_sandbox_request_keeps_short_timeout():
    timeout = wegent_e2b_proxy._sandbox_proxy_timeout(
        "filesystem.Filesystem/Stat", "90000"
    )

    assert timeout.read == 60.0
    assert timeout.connect == 10.0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("upstream_error", "phase", "seconds"),
    [
        (httpx.ConnectTimeout, "connect", 10),
        (httpx.ReadTimeout, "read", 95),
        (httpx.WriteTimeout, "write", 60),
        (httpx.PoolTimeout, "pool", 10),
    ],
)
async def test_process_start_returns_connect_error(
    mocker, upstream_error, phase, seconds
):
    """The SDK reads the error code and message from the HTTP response root."""
    app = FastAPI()
    app.include_router(wegent_e2b_proxy.router)
    sandbox = SimpleNamespace(metadata={"task_type": "sandbox"})
    upstream_client = mocker.AsyncMock()
    upstream_client.__aenter__.return_value = upstream_client
    upstream_client.request.side_effect = upstream_error("")

    mocker.patch.object(
        wegent_e2b_proxy,
        "_get_sandbox_info",
        new=mocker.AsyncMock(return_value=("http://sandbox:8080", sandbox)),
    )
    mocker.patch.object(wegent_e2b_proxy, "_touch_sandbox_activity")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://manager"
    ) as client:
        upstream = mocker.patch.object(
            wegent_e2b_proxy.httpx, "AsyncClient", return_value=upstream_client
        )
        response = await client.post(
            "/sandbox-1/49983/process.Process/Start",
            headers={"connect-timeout-ms": "90000"},
        )

    assert response.status_code == 504
    assert response.json() == {
        "code": "deadline_exceeded",
        "phase": phase,
        "timeout_seconds": seconds,
        "message": (
            "Sandbox request POST process.Process/Start timed out "
            f"after {seconds} seconds during the {phase} phase"
        ),
    }
    assert upstream.call_args.kwargs["timeout"].read == 95
    assert (
        upstream_client.request.call_args.kwargs["headers"]["connect-timeout-ms"]
        == "90000"
    )


@pytest.mark.asyncio
async def test_proxy_transport_error_returns_typed_bad_gateway(mocker):
    """Transport failures should not become an empty 500 response."""
    sandbox = SimpleNamespace(metadata={"task_type": "task"})
    request = MagicMock()
    request.method = "POST"
    request.query_params = {}
    request.headers = {}
    request.body = mocker.AsyncMock(return_value=b"payload")
    client = MagicMock()
    client.request = mocker.AsyncMock(side_effect=httpx.ReadError(""))
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)

    mocker.patch.object(
        wegent_e2b_proxy,
        "_get_sandbox_info",
        new=mocker.AsyncMock(return_value=("http://sandbox:8080", sandbox)),
    )
    manager = SimpleNamespace(
        sandbox_workspace_write=mocker.Mock(return_value=nullcontext())
    )
    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)
    mocker.patch.object(
        wegent_e2b_proxy.httpx,
        "AsyncClient",
        return_value=client,
    )

    with pytest.raises(HTTPException) as exc_info:
        await wegent_e2b_proxy.proxy_to_sandbox(
            "sandbox-1",
            49983,
            "files",
            request,
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail["code"] == "sandbox_transport_error"
    assert "ReadError" in exc_info.value.detail["message"]
    manager.sandbox_workspace_write.assert_called_once_with(sandbox)


@pytest.mark.asyncio
async def test_proxy_preserves_upstream_response(mocker):
    """A received upstream response keeps its status and body."""
    sandbox = SimpleNamespace(metadata={"task_type": "task"})
    request = MagicMock()
    request.method = "POST"
    request.query_params = {}
    request.headers = {}
    request.body = mocker.AsyncMock(return_value=b"payload")
    upstream = MagicMock()
    upstream.status_code = 413
    upstream.headers = {"content-type": "application/json"}
    upstream.content = b'{"detail":"Request payload is too large"}'
    client = MagicMock()
    client.request = mocker.AsyncMock(return_value=upstream)
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)

    mocker.patch.object(
        wegent_e2b_proxy,
        "_get_sandbox_info",
        new=mocker.AsyncMock(return_value=("http://sandbox:8080", sandbox)),
    )
    manager = SimpleNamespace(
        sandbox_workspace_write=mocker.Mock(return_value=nullcontext())
    )
    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)
    mocker.patch.object(
        wegent_e2b_proxy.httpx,
        "AsyncClient",
        return_value=client,
    )

    response = await wegent_e2b_proxy.proxy_to_sandbox(
        "sandbox-1",
        49983,
        "files",
        request,
    )

    assert response.status_code == 413
    assert await anext(response.body_iterator) == upstream.content
