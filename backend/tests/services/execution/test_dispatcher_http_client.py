# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Background dispatch must release its request-owned SDK client."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from openai import APIStatusError, AsyncOpenAI

from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget
from shared.models import ExecutionRequest


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 500])
async def test_background_dispatch_closes_client_on_success_or_failure(status) -> None:
    client = AsyncOpenAI(
        base_url="http://executor-manager/v1",
        api_key="test",
        max_retries=0,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    status, json={"id": "queued-response", "output": []}
                )
            )
        ),
    )
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(task_id=101, subtask_id=202)
    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK, url="http://executor-manager"
    )
    emitter = AsyncMock()
    try:
        with (
            patch("openai.AsyncOpenAI", return_value=client),
            patch.object(
                dispatcher, "_sync_attachments_before_executor_dispatch", AsyncMock()
            ),
            patch(
                "app.services.execution.dispatcher.OpenAIRequestConverter.from_execution_request",
                return_value={"model": "test-model", "input": "hello"},
            ),
        ):
            if status == 200:
                await dispatcher._dispatch_http_callback(request, target, emitter)
                emitter.emit_start.assert_awaited_once()
            else:
                with pytest.raises(APIStatusError):
                    await dispatcher._dispatch_http_callback(request, target, emitter)
                emitter.emit_start.assert_not_awaited()

        assert client.is_closed()
    finally:
        await client.close()
        await dispatcher.http_client.aclose()
