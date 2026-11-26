# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI

from executor_manager.routers import wegent_e2b_proxy


def test_touch_sandbox_activity_persists_proxy_activity(mocker):
    """Proxied E2B SDK calls should refresh sandbox activity for GC."""
    repository = MagicMock()
    manager = SimpleNamespace(_repository=repository)
    sandbox = MagicMock()
    sandbox.sandbox_id = "1385"

    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)

    wegent_e2b_proxy._touch_sandbox_activity(sandbox)

    sandbox.touch.assert_called_once_with()
    repository.save_sandbox.assert_called_once_with(sandbox)


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
