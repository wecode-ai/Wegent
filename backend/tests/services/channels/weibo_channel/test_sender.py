# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.channels.weibo.sender import WeiboSender


@pytest.mark.asyncio
async def test_send_text_message_uses_weibo_send_message_payload():
    client = AsyncMock()
    client.send_json.return_value = True
    sender = WeiboSender(client)

    result = await sender.send_text_message(to_user_id="10001", text="hello")

    assert result is True
    sent = client.send_json.await_args.args[0]
    assert sent["type"] == "send_message"
    assert sent["payload"]["toUserId"] == "10001"
    assert sent["payload"]["text"] == "hello"
    assert sent["payload"]["messageId"].startswith("msg_")
    assert sent["payload"]["chunkId"] == 0
    assert sent["payload"]["done"] is True


@pytest.mark.asyncio
async def test_send_text_message_generates_required_message_id():
    client = AsyncMock()
    client.send_json.return_value = True
    sender = WeiboSender(client)

    await sender.send_text_message(to_user_id="10001", text="help")

    payload = client.send_json.await_args.args[0]["payload"]
    assert isinstance(payload["messageId"], str)
    assert payload["messageId"].startswith("msg_")
    assert payload["messageId"]


@pytest.mark.asyncio
async def test_send_stream_chunk_uses_stable_message_id_and_chunk_fields():
    client = AsyncMock()
    client.send_json.return_value = True
    sender = WeiboSender(client)

    result = await sender.send_stream_chunk(
        to_user_id="10001",
        text="part",
        message_id="weibo_7_11_13",
        chunk_id=3,
        done=False,
    )

    assert result is True
    client.send_json.assert_awaited_once_with(
        {
            "type": "send_message",
            "payload": {
                "toUserId": "10001",
                "text": "part",
                "messageId": "weibo_7_11_13",
                "chunkId": 3,
                "done": False,
            },
        }
    )
