# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints import oidc


async def _wait_for_thread(event: threading.Event) -> None:
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("OIDC database worker did not start")


@pytest.mark.asyncio
async def test_oidc_callback_database_phase_does_not_block_event_loop(
    monkeypatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []

    monkeypatch.setattr(
        oidc.jwt,
        "decode",
        lambda *args, **kwargs: {
            "nonce": "nonce",
            "exp": int(oidc.time.time()) + 60,
        },
    )
    monkeypatch.setattr(
        oidc.oidc_service,
        "exchange_code_for_tokens",
        AsyncMock(return_value={"id_token": "id-token"}),
    )
    monkeypatch.setattr(
        oidc.oidc_service,
        "verify_id_token",
        AsyncMock(
            return_value={
                "sub": "subject",
                "email": "user@example.com",
                "name": "User",
            }
        ),
    )

    def blocked_upsert(
        user_name: str,
        email: str,
        source: str,
    ) -> oidc._OIDCUserAuth:
        assert (user_name, email, source) == (
            "user",
            "user@example.com",
            "browser",
        )
        worker_threads.append(threading.get_ident())
        started.set()
        release.wait(timeout=5)
        return oidc._OIDCUserAuth(
            user_id=7,
            user_name="user",
            access_token="access-token",
        )

    monkeypatch.setattr(oidc, "_upsert_oidc_user", blocked_upsert)
    loop_thread = threading.get_ident()
    task = asyncio.create_task(
        oidc.oidc_callback(
            code="code",
            state="state",
            error=None,
        )
    )
    try:
        await _wait_for_thread(started)
        ticked = asyncio.Event()
        asyncio.get_running_loop().call_soon(ticked.set)
        await asyncio.wait_for(ticked.wait(), timeout=0.1)
        assert not task.done()
    finally:
        release.set()

    response = await task
    assert response.status_code == 302
    assert worker_threads and worker_threads[0] != loop_thread
    assert "access_token=access-token" in response.headers["location"]


def test_oidc_async_callbacks_do_not_accept_sync_sessions() -> None:
    assert "db" not in oidc.oidc_callback.__annotations__
    assert "db" not in oidc.cli_oidc_callback.__annotations__
