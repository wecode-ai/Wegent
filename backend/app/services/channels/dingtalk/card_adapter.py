# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Card presentation adapters; execution events remain template-independent."""

import logging
from typing import Any, Protocol
from uuid import uuid4

from app.schemas.dingtalk_card import DingTalkChatCardConfig
from app.services.channels.dingtalk.card_binding import mark_card_ready
from app.services.channels.dingtalk.card_transport import (
    DingTalkCardTransport,
    card_delivery_data,
)
from app.services.channels.dingtalk.markdown_compat import render_for_dingtalk
from app.services.channels.dingtalk.message_logging import log_dingtalk_message


class ChatCardAdapter(Protocol):
    card_instance_id: str | None

    @property
    def out_track_id(self) -> str | None: ...

    async def start(self) -> None: ...
    async def update(self, content: str) -> None: ...
    async def finish(self, content: str) -> None: ...
    async def fail(self, error: str) -> None: ...
    async def close(self) -> None: ...


class BuiltinChatCardAdapter:
    """Preserve the SDK template for channels without a custom chat card."""

    def __init__(self, client: Any, message: Any, card_id: str | None = None):
        from app.services.channels.dingtalk.card import DingTalkMarkdownCard

        self._instance = DingTalkMarkdownCard(client, message)
        self._instance.set_order(["msgContent"])
        if card_id:
            self._instance.card_instance_id = card_id

    @property
    def card_instance_id(self) -> str | None:
        return self._instance.card_instance_id

    @property
    def out_track_id(self) -> str | None:
        return self.card_instance_id

    async def start(self) -> None:
        await self._instance.ai_start()

    async def update(self, content: str) -> None:
        await self._instance.ai_streaming(content, append=False)

    async def finish(self, content: str) -> None:
        await self._instance.ai_finish(content)

    async def fail(self, error: str) -> None:
        await self._instance.ai_fail()

    async def close(self) -> None:
        await self._instance.close()


class TemplateChatCardAdapter:
    """Use DingTalk's AI-card protocol with configurable content/action fields."""

    def __init__(
        self,
        client: Any,
        message: Any,
        config: DingTalkChatCardConfig,
        channel_id: int,
        card_id: str | None = None,
    ):
        self._client = client
        self._message = message
        self.config = config
        self.channel_id = channel_id
        self.card_instance_id = card_id
        self._out_track_id = card_id or f"wegent-chat-{uuid4().hex}"
        self._created = bool(card_id)
        self._transport = DingTalkCardTransport(client, channel_id)

    @property
    def out_track_id(self) -> str:
        return self._out_track_id

    async def _request(self, method: str, path: str, body: dict) -> dict:
        return await self._transport.request(method, path, body)

    async def close(self) -> None:
        await self._transport.close()

    async def start(self) -> None:
        if self.card_instance_id:
            return
        delivery = self._delivery_data()
        if not self._created:
            await self._request(
                "POST",
                "instances",
                {
                    "cardTemplateId": self.config.template_id,
                    "outTrackId": self._out_track_id,
                    "cardData": {
                        "cardParamMap": {
                            **self.config.initial_data,
                            **(
                                {self.config.follow_up_status_key: "idle"}
                                if self.config.follow_up_status_key
                                else {}
                            ),
                            self.config.content_key: "",
                            "flowStatus": "1",
                        }
                    },
                    "callbackType": "STREAM",
                    "imGroupOpenSpaceModel": {"supportForward": False},
                    "imRobotOpenSpaceModel": {"supportForward": False},
                },
            )
            self._created = True
        response = await self._request("POST", "instances/deliver", delivery)
        self.card_instance_id = self._out_track_id
        self._log_delivery(response)
        await self._save_quote_addresses(response)

    async def _save_quote_addresses(self, response: dict) -> None:
        from app.services.channels.dingtalk.card_quotes import save_quote_address

        if not self.config.follow_up_enabled or self._message.conversation_type != "2":
            return
        results = response.get("result")
        if not isinstance(results, list):
            return
        for row in results:
            if not isinstance(row, dict):
                continue
            carrier_id = row.get("carrierId")
            if (
                row.get("success") is True
                and row.get("spaceType") == "IM_GROUP"
                and row.get("spaceId") == self._message.conversation_id
                and isinstance(carrier_id, str)
                and carrier_id
            ):
                await save_quote_address(
                    self.channel_id,
                    self._message.conversation_id,
                    carrier_id,
                    self._out_track_id,
                )

    def _log_delivery(self, response: dict) -> None:
        """Capture only addressing fields to correlate future quoted replies."""
        results = response.get("result")
        fields = {"spaceType", "spaceId", "carrierId", "success"}
        addresses = (
            [
                {
                    key: value
                    for key, value in row.items()
                    if key in fields and isinstance(value, (str, bool, int))
                }
                for row in results
                if isinstance(row, dict)
            ]
            if isinstance(results, list)
            else []
        )
        log_dingtalk_message(
            logging.getLogger(__name__),
            "card_delivered",
            {
                "channel_id": self.channel_id,
                "outTrackId": self._out_track_id,
                "addresses": addresses,
            },
        )

    def _delivery_data(self) -> dict:
        return card_delivery_data(self._client, self._message, self._out_track_id)

    async def _stream(self, content: str, *, final: bool, error: bool = False) -> None:
        await self._request(
            "PUT",
            "streaming",
            {
                "outTrackId": self._out_track_id,
                "guid": uuid4().hex,
                "key": self.config.content_key,
                "content": content,
                "isFull": True,
                "isFinalize": final,
                "isError": error,
            },
        )

    async def update(self, content: str) -> None:
        await self._stream(content, final=False)

    async def set_follow_up_status(self, status: str) -> None:
        if not self.config.follow_up_status_key:
            return
        await self._request(
            "PUT",
            "instances",
            {
                "outTrackId": self._out_track_id,
                "cardData": {
                    "cardParamMap": {self.config.follow_up_status_key: status}
                },
                "cardUpdateOptions": {"updateCardDataByKey": True},
            },
        )

    async def finish(self, content: str) -> None:
        await self._stream(content, final=True)
        await mark_card_ready(self.channel_id, self._out_track_id)

    async def fail(self, error: str) -> None:
        await self._stream(error, final=True, error=True)
        await mark_card_ready(self.channel_id, self._out_track_id)


def create_card_adapter(
    client: Any,
    message: Any,
    config: DingTalkChatCardConfig | None,
    channel_id: int = 0,
    card_id: str | None = None,
) -> ChatCardAdapter:
    if config is None:
        adapter: ChatCardAdapter = BuiltinChatCardAdapter(client, message, card_id)
    else:
        adapter = TemplateChatCardAdapter(client, message, config, channel_id, card_id)
    return _MarkdownCompatAdapter(adapter)


class _MarkdownCompatAdapter:
    """Rewrite card content into DingTalk-renderable Markdown before sending.

    DingTalk card Markdown does not render GFM tables; the conversion is
    applied here so streaming updates and terminal answers share one path.
    """

    def __init__(self, inner: ChatCardAdapter):
        self._inner = inner

    @property
    def card_instance_id(self) -> str | None:
        return self._inner.card_instance_id

    @property
    def out_track_id(self) -> str | None:
        return self._inner.out_track_id

    async def start(self) -> None:
        await self._inner.start()

    async def update(self, content: str) -> None:
        await self._inner.update(render_for_dingtalk(content))

    async def finish(self, content: str) -> None:
        await self._inner.finish(render_for_dingtalk(content))

    async def fail(self, error: str) -> None:
        await self._inner.fail(render_for_dingtalk(error))

    async def set_follow_up_status(self, status: str) -> None:
        setter = getattr(self._inner, "set_follow_up_status", None)
        if setter is not None:
            await setter(status)

    async def close(self) -> None:
        await self._inner.close()
