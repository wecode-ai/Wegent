# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connection ownership, safe replay boundaries, and dispatch diagnostics."""

import asyncio
import errno
import json
import logging
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from openai import APIConnectionError, APIStatusError, AsyncOpenAI

from app.services.execution.chat_shell_client import (
    ChatShellClientPool,
    log_transport_event,
    open_chat_shell_stream,
)


def _client(handler) -> AsyncOpenAI:
    return AsyncOpenAI(
        base_url="http://chat-shell/v1",
        api_key="test",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


async def _open(client: AsyncOpenAI):
    return await open_chat_shell_stream(
        client,
        task_id=101,
        subtask_id=202,
        request_id="request-303",
        model="test-model",
        input="hello",
        stream=True,
        extra_headers={"X-Request-ID": "request-303"},
        extra_body={"metadata": {"request_id": "request-303"}},
    )


def _response() -> httpx.Response:
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        text='data: {"type":"response.completed","response":{"output":[]}}\n\n',
    )


def _events(caplog) -> list[dict]:
    return [
        json.loads(record.getMessage().removeprefix("[ChatShellTransport] "))
        for record in caplog.records
        if record.name == "app.services.execution.chat_shell_client"
    ]


@pytest.mark.asyncio
async def test_application_reuses_clients_until_shutdown() -> None:
    pool = ChatShellClientPool()

    async with pool.lifespan():
        async with pool.client("http://chat-shell/") as first:
            assert first.timeout.connect == 5.0
            assert first.timeout.read == 300.0
            assert first.timeout.write == 30.0
            assert first.timeout.pool == 5.0
            assert first.max_retries == 0
        async with pool.client("http://chat-shell") as second:
            assert second is first
            assert not first.is_closed()
        async with pool.client("http://other-chat-shell") as other:
            assert other is not first
        borrowers = await asyncio.gather(*(_borrow(pool) for _ in range(10)))
        assert all(client is first for client in borrowers)

    assert first.is_closed()
    assert other.is_closed()
    # A new lifespan cannot reuse a closed connection pool.
    async with pool.lifespan():
        async with pool.client("http://chat-shell") as fresh:
            assert fresh is not first
    assert fresh.is_closed()


async def _borrow(pool: ChatShellClientPool) -> AsyncOpenAI:
    async with pool.client("http://chat-shell") as client:
        return client


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
async def test_worker_owned_client_closes_on_every_exit(error_type) -> None:
    pool = ChatShellClientPool()

    with pytest.raises(error_type):
        async with pool.client("http://chat-shell") as client:
            raise error_type("interrupted")

    assert client.is_closed()
    async with pool.client("http://chat-shell") as next_client:
        assert next_client is not client
    assert next_client.is_closed()


@pytest.mark.asyncio
async def test_worker_loop_cannot_borrow_application_connections() -> None:
    pool = ChatShellClientPool()

    async def borrow_on_worker():
        async with pool.client("http://chat-shell") as client:
            assert not client.is_closed()
        assert client.is_closed()
        return client

    async with pool.lifespan():
        async with pool.client("http://chat-shell") as owner:
            worker = await asyncio.to_thread(lambda: asyncio.run(borrow_on_worker()))
            assert worker is not owner
            assert not owner.is_closed()
    assert owner.is_closed()


@pytest.mark.asyncio
async def test_forked_worker_cannot_borrow_parent_connections() -> None:
    pool = ChatShellClientPool()

    async with pool.lifespan():
        async with pool.client("http://chat-shell") as owner:
            with patch(
                "app.services.execution.chat_shell_client.os.getpid", return_value=-1
            ):
                async with pool.client("http://chat-shell") as worker:
                    assert worker is not owner
                assert worker.is_closed()
            assert not owner.is_closed()
    assert owner.is_closed()


@pytest.mark.asyncio
async def test_lifespan_closes_all_clients_on_startup_failure() -> None:
    pool = ChatShellClientPool()
    clients = [AsyncMock(), AsyncMock()]
    clients[0].close.side_effect = RuntimeError("close failed")

    with patch(
        "app.services.execution.chat_shell_client._build_client", side_effect=clients
    ):
        with pytest.raises(RuntimeError, match="close failed"):
            async with pool.lifespan():
                async with pool.client("http://first"):
                    pass
                async with pool.client("http://second"):
                    pass
                raise ValueError("startup failed")

    for client in clients:
        client.close.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [httpx.ConnectError, httpx.ConnectTimeout])
async def test_connect_failure_recovers_with_bounded_jitter(error_type, caplog) -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request):
        calls.append(request)
        if len(calls) < 3:
            raise error_type("connect failed", request=request)
        return _response()

    caplog.set_level(logging.INFO)
    with patch(
        "app.services.execution.chat_shell_client.asyncio.sleep", new_callable=AsyncMock
    ) as sleep:
        async with _client(handler) as client:
            async with await _open(client) as stream:
                events = [event async for event in stream]

    assert len(calls) == 3
    assert events[0].type == "response.completed"
    assert sleep.await_count == 2
    for delay, maximum in zip(sleep.await_args_list, [0.5, 1.0]):
        assert 0 <= delay.args[0] <= maximum
    for request in calls:
        assert request.headers["X-Request-ID"] == "request-303"
        assert json.loads(request.content)["metadata"]["request_id"] == "request-303"
    records = _events(caplog)
    assert [
        record["attempt"] for record in records if record["event"] == "connect_attempt"
    ] == [1, 2, 3]
    assert records[-1]["event"] == "stream_opened"
    assert records[-1]["elapsed_ms"] >= 0


@pytest.mark.asyncio
async def test_exhaustion_retains_cause_and_correlation(caplog) -> None:
    def handler(request: httpx.Request):
        try:
            raise OSError(errno.ECONNREFUSED, "Connection refused")
        except OSError as cause:
            raise httpx.ConnectError("connect failed", request=request) from cause

    caplog.set_level(logging.INFO)
    with patch(
        "app.services.execution.chat_shell_client.asyncio.sleep", new_callable=AsyncMock
    ) as sleep:
        async with _client(handler) as client:
            with pytest.raises(APIConnectionError) as failure:
                await _open(client)

    assert str(failure.value) == "Connection error."
    assert isinstance(failure.value.__cause__, httpx.ConnectError)
    assert sleep.await_count == 2
    records = _events(caplog)
    failures = [record for record in records if record["event"] == "connect_failed"]
    assert len(failures) == 3
    final = failures[-1]
    assert final["retry"] is False
    assert final["task_id"] == 101
    assert final["subtask_id"] == 202
    assert final["request_id"] == "request-303"
    assert final["error_hop"] == "backend_to_chat_shell"
    assert final["target_url"] == "http://chat-shell/v1/responses"
    assert final["caller_pod"]
    assert [cause["exception_type"] for cause in final["exception_chain"]] == [
        "APIConnectionError",
        "ConnectError",
        "ConnectionRefusedError",
    ]
    assert str(errno.ECONNREFUSED) in final["exception_chain"][-1]["exception_repr"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error_type",
    [
        httpx.ReadError,
        httpx.ReadTimeout,
        httpx.WriteError,
        httpx.WriteTimeout,
        httpx.RemoteProtocolError,
        httpx.PoolTimeout,
    ],
)
async def test_ambiguous_transport_failure_is_never_replayed(error_type) -> None:
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        raise error_type("request may have been received", request=request)

    with patch(
        "app.services.execution.chat_shell_client.asyncio.sleep", new_callable=AsyncMock
    ) as sleep:
        async with _client(handler) as client:
            with pytest.raises(APIConnectionError):
                await _open(client)

    assert len(calls) == 1
    sleep.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [429, 500, 503])
async def test_http_failure_is_never_replayed(status) -> None:
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": "failed"}})

    async with _client(handler) as client:
        with pytest.raises(APIStatusError):
            await _open(client)

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_cancellation_interrupts_retry_backoff() -> None:
    backoff_started = asyncio.Event()
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        raise httpx.ConnectError("connect failed", request=request)

    async def sleep(_delay):
        backoff_started.set()
        await asyncio.Future()

    with patch("app.services.execution.chat_shell_client.asyncio.sleep", sleep):
        async with _client(handler) as client:
            task = asyncio.create_task(_open(client))
            await asyncio.wait_for(backoff_started.wait(), timeout=2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    assert len(calls) == 1


def test_diagnostics_remove_url_credentials_and_mask_secrets(caplog) -> None:
    caplog.set_level(logging.INFO)

    log_transport_event(
        "connect_failed",
        task_id=1,
        subtask_id=2,
        request_id="test",
        target_url="http://user:private-password@chat-shell/v1/responses?key=private-key",
        error=RuntimeError("token=private-token password=another-password"),
    )

    record = _events(caplog)[0]
    assert record["target_url"] == "http://chat-shell/v1/responses"
    assert "private-password" not in caplog.text
    assert "private-key" not in caplog.text
    assert "private-token" not in caplog.text
    assert "another-password" not in caplog.text
