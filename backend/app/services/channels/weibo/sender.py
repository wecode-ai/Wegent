# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo Open IM message sender."""

from __future__ import annotations

from typing import Optional

from app.services.channels.weibo.client import WeiboWebSocketClient


class WeiboSender:
    """Send Weibo private messages through an active Open IM WebSocket client."""

    def __init__(self, client: WeiboWebSocketClient):
        self._client = client

    async def send_text_message(
        self,
        *,
        to_user_id: str,
        text: str,
    ) -> bool:
        return await self.send_stream_chunk(
            to_user_id=to_user_id,
            text=text,
            message_id=None,
            chunk_id=0,
            done=True,
        )

    async def send_stream_chunk(
        self,
        *,
        to_user_id: str,
        text: str,
        message_id: Optional[str],
        chunk_id: int,
        done: bool,
    ) -> bool:
        return await self._client.send_json(
            {
                "type": "send_message",
                "payload": {
                    "toUserId": to_user_id,
                    "text": text,
                    "messageId": message_id,
                    "chunkId": chunk_id,
                    "done": done,
                },
            }
        )
