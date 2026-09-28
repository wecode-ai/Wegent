# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""SDK card rendering with cancellable asynchronous delivery."""

from typing import Any
from uuid import uuid4

from dingtalk_stream import AIMarkdownCardInstance
from dingtalk_stream.card_replier import AICardStatus

from app.services.channels.dingtalk.card_transport import (
    DingTalkCardTransport,
    card_delivery_data,
)


class DingTalkMarkdownCard(AIMarkdownCardInstance):
    """Reuse SDK payload rendering without invoking its synchronous HTTP methods."""

    def __init__(self, client: Any, message: Any):
        super().__init__(client, message)
        self._transport = DingTalkCardTransport(client)
        self._track_id = uuid4().hex
        self._created = False

    async def ai_start(self) -> None:
        if self.card_instance_id:
            return
        delivery = card_delivery_data(
            self.dingtalk_client, self.incoming_message, self._track_id
        )
        if not self._created:
            await self._transport.request(
                "POST",
                "instances",
                {
                    "cardTemplateId": self.card_template_id,
                    "outTrackId": self._track_id,
                    "cardData": {
                        "cardParamMap": {"flowStatus": AICardStatus.PROCESSING}
                    },
                    "callbackType": "STREAM",
                    "imGroupOpenSpaceModel": {"supportForward": True},
                    "imRobotOpenSpaceModel": {"supportForward": True},
                },
                require_success=False,
            )
            self._created = True
        await self._transport.request(
            "POST", "instances/deliver", delivery, require_success=False
        )
        self.card_instance_id = self._track_id

    async def _put_status(self, status: str) -> None:
        await self._transport.request(
            "PUT",
            "instances",
            {
                "outTrackId": self.card_instance_id,
                "cardData": {"cardParamMap": self.get_card_data(status)},
            },
            require_success=False,
        )

    async def ai_streaming(self, markdown: str, append: bool = False) -> None:
        if not self.inputing_status:
            await self._put_status(AICardStatus.INPUTING)
            self.inputing_status = True
        self.markdown = self.markdown + markdown if append else markdown
        await self._transport.request(
            "PUT",
            "streaming",
            {
                "outTrackId": self.card_instance_id,
                "guid": uuid4().hex,
                "key": "msgContent",
                "content": self.markdown,
                "isFull": True,
                "isFinalize": False,
                "isError": False,
            },
            require_success=False,
        )

    async def ai_finish(self, markdown: str) -> None:
        self.markdown = markdown
        await self._put_status(AICardStatus.FINISHED)

    async def ai_fail(self) -> None:
        await self._put_status(AICardStatus.FAILED)

    async def close(self) -> None:
        await self._transport.close()
