# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.chat.webpage_websocket_chat_emitter import (
    WebSocketEmitter as WebPageWebSocketEmitter,
)
from app.services.chat.webpage_ws_chat_emitter import WebPageSocketEmitter
from app.services.chat.ws_emitter import WebSocketEmitter


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "emitter_type",
    [WebSocketEmitter, WebPageSocketEmitter, WebPageWebSocketEmitter],
)
async def test_chat_done_removes_private_workflow_urls(emitter_type) -> None:
    sio = AsyncMock()
    emitter = emitter_type(sio)

    await emitter.emit_chat_done(
        task_id=1,
        subtask_id=2,
        offset=0,
        result={
            "blocks": [
                {
                    "type": "tool",
                    "tool_output": {
                        "success": True,
                        "query_url": "http://internal/query",
                    },
                }
            ]
        },
    )

    payload = sio.emit.await_args.args[1]
    assert payload["result"]["blocks"][0]["tool_output"] == {"success": True}
