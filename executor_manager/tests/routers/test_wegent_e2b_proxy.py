# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from executor_manager.routers import wegent_e2b_proxy
from executor_manager.services.sandbox import SandboxExecutionStorageError


@pytest.mark.asyncio
async def test_proxy_execution_storage_failure_returns_503(mocker):
    sandbox = SimpleNamespace(sandbox_id="123", metadata={"task_id": 123})
    create = AsyncMock(
        side_effect=SandboxExecutionStorageError("Could not record execution")
    )
    mocker.patch.object(
        wegent_e2b_proxy,
        "get_sandbox_manager",
        return_value=SimpleNamespace(create_execution=create),
    )

    response = await wegent_e2b_proxy._proxy_sandbox_execute(
        "http://sandbox", sandbox, b'{"code":"test"}', MagicMock()
    )

    assert response.status_code == 503
    assert json.loads(await anext(response.body_iterator))["name"] == (
        "execution_storage_unavailable"
    )


@pytest.mark.asyncio
async def test_proxy_retries_when_the_selected_sandbox_cannot_be_confirmed(mocker):
    """A stale proxy request cannot reach an already-replaced sandbox."""
    refresh = AsyncMock(return_value=False)
    manager = SimpleNamespace(refresh_sandbox_activity=refresh)
    sandbox = SimpleNamespace(sandbox_id="1385")
    request = SimpleNamespace(
        method="POST", headers={}, body=AsyncMock(return_value=b"")
    )

    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)
    mocker.patch.object(
        wegent_e2b_proxy, "_get_sandbox_info", return_value=("http://sandbox", sandbox)
    )

    with pytest.raises(HTTPException) as error:
        await wegent_e2b_proxy.proxy_to_sandbox("1385", 49983, "execute", request)

    assert error.value.status_code == 503
    refresh.assert_awaited_once_with(sandbox)


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
    mocker.patch.object(
        wegent_e2b_proxy,
        "get_sandbox_manager",
        return_value=SimpleNamespace(
            refresh_sandbox_activity=AsyncMock(return_value=True)
        ),
    )
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
    mocker.patch.object(
        wegent_e2b_proxy,
        "get_sandbox_manager",
        return_value=SimpleNamespace(
            refresh_sandbox_activity=AsyncMock(return_value=True)
        ),
    )
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
    mocker.patch.object(
        wegent_e2b_proxy,
        "get_sandbox_manager",
        return_value=SimpleNamespace(
            refresh_sandbox_activity=AsyncMock(return_value=True)
        ),
    )
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
