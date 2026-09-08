# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
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


@pytest.mark.asyncio
async def test_webpage_chat_message_includes_im_display_metadata() -> None:
    sio = AsyncMock()
    emitter = WebPageSocketEmitter(sio)
    created_at = datetime(2026, 9, 8, 15, 39, 46)
    contexts = [{"id": 9, "context_type": "attachment"}]
    source = {
        "source": "im",
        "channel_type": "dingtalk",
        "channel_label": "DingTalk",
    }

    await emitter.emit_chat_message(
        task_id=2425,
        subtask_id=3574,
        message_id=5,
        role="user",
        content="你叫什么",
        sender={"user_id": 6, "user_name": "206422"},
        created_at=created_at,
        attachment=None,
        attachments=[],
        contexts=contexts,
        source=source,
    )

    sio.emit.assert_awaited_once_with(
        "chat:message",
        {
            "subtask_id": 3574,
            "task_id": 2425,
            "message_id": 5,
            "role": "user",
            "content": "你叫什么",
            "sender": {"user_id": 6, "user_name": "206422"},
            "created_at": created_at.isoformat(),
            "attachment": None,
            "attachments": [],
            "contexts": contexts,
            "source": source,
        },
        room="task:2425",
        skip_sid=None,
        namespace="/chat",
    )
