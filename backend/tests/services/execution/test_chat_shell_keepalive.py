# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify actual HTTP keep-alive through the SSE dispatch path."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.services.execution.chat_shell_client import ChatShellClientPool
from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget
from shared.models import ExecutionRequest


@pytest.mark.asyncio
async def test_sequential_dispatches_reuse_tcp_connection(monkeypatch) -> None:
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    connections = []
    requests = []
    handlers = set()

    async def handle(reader, writer):
        task = asyncio.current_task()
        handlers.add(task)
        connections.append(writer)
        try:
            while True:
                headers = await reader.readuntil(b"\r\n\r\n")
                content_length = next(
                    int(line.split(b":", 1)[1])
                    for line in headers.split(b"\r\n")
                    if line.lower().startswith(b"content-length:")
                )
                requests.append(await reader.readexactly(content_length))
                # Like StreamingResponse, terminate a chunked HTTP response
                # after delivering the terminal SSE event.
                body = (
                    b'data: {"type":"response.completed","response":{"output":[]}}\n\n'
                )
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                    b"Transfer-Encoding: chunked\r\n\r\n"
                    + f"{len(body):x}\r\n".encode()
                    + body
                    + b"\r\n0\r\n\r\n"
                )
                await writer.drain()
        except asyncio.IncompleteReadError:
            pass
        finally:
            writer.close()
            await writer.wait_closed()
            handlers.remove(task)

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    pool = ChatShellClientPool()
    session = AsyncMock()
    session.register_stream.return_value = asyncio.Event()
    session.is_cancelled.return_value = False
    dispatcher = ExecutionDispatcher()
    target = ExecutionTarget(mode=CommunicationMode.SSE, url=f"http://127.0.0.1:{port}")
    try:
        with (
            patch("app.services.execution.chat_shell_sse.chat_shell_clients", pool),
            patch("app.services.chat.storage.session.session_manager", session),
            patch(
                "app.services.execution.chat_shell_sse.OpenAIRequestConverter.from_execution_request",
                return_value={"model": "test-model", "input": "hello"},
            ),
        ):
            async with server, pool.lifespan():
                for subtask_id in (1, 2):
                    request = ExecutionRequest(task_id=101, subtask_id=subtask_id)
                    await asyncio.wait_for(
                        dispatcher._dispatch_sse(request, target, AsyncMock()),
                        timeout=2,
                    )

                assert len(requests) == 2
                assert len(connections) == 1
    finally:
        await dispatcher.http_client.aclose()
        for writer in connections:
            writer.close()
        if handlers:
            await asyncio.wait_for(asyncio.gather(*handlers), timeout=2)
