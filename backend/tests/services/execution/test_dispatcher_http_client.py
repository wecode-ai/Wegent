# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Background dispatch must release its request-owned SDK client."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from openai import APIConnectionError, APIStatusError, AsyncOpenAI

from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget
from shared.models import ExecutionRequest


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome",
    [
        200,
        429,
        500,
        httpx.ConnectError,
        httpx.ReadTimeout,
        httpx.WriteError,
        httpx.RemoteProtocolError,
    ],
)
async def test_background_dispatch_closes_client_without_replaying(outcome) -> None:
    """Use the production SDK retry policy and send each background POST once."""
    requests = []
    clients = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if isinstance(outcome, type):
            raise outcome("dispatch result is uncertain", request=request)
        return httpx.Response(outcome, json={"id": "queued-response", "output": []})

    def build_client(**kwargs) -> AsyncOpenAI:
        # Replace the dispatcher's proxy-free client with a mock transport.
        kwargs["http_client"] = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        client = AsyncOpenAI(**kwargs)
        clients.append(client)
        return client

    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(task_id=101, subtask_id=202)
    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK, url="http://executor-manager"
    )
    emitter = AsyncMock()
    try:
        with (
            patch("openai.AsyncOpenAI", side_effect=build_client),
            patch.object(
                dispatcher, "_sync_attachments_before_executor_dispatch", AsyncMock()
            ),
            patch(
                "app.services.execution.dispatcher.OpenAIRequestConverter.from_execution_request",
                return_value={"model": "test-model", "input": "hello"},
            ),
        ):
            if outcome == 200:
                await dispatcher._dispatch_http_callback(request, target, emitter)
                emitter.emit_start.assert_awaited_once()
            else:
                error_type = (
                    APIConnectionError if isinstance(outcome, type) else APIStatusError
                )
                with pytest.raises(error_type):
                    await dispatcher._dispatch_http_callback(request, target, emitter)
                emitter.emit_start.assert_not_awaited()

        assert len(requests) == 1
        assert len(clients) == 1
        assert clients[0].is_closed()
    finally:
        for client in clients:
            await client.close()
        await dispatcher.http_client.aclose()
