# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Small asynchronous transport for DingTalk custom card instances."""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from dingtalk_stream import ChatbotMessage
    from dingtalk_stream.stream import DingTalkStreamClient

logger = logging.getLogger(__name__)


def stringify_card_data(card_data: dict[str, Any]) -> dict[str, str]:
    """Convert custom card variables to the string form required by DingTalk."""

    result: dict[str, str] = {}
    for key, value in card_data.items():
        if isinstance(value, str):
            result[key] = value
        elif isinstance(value, bool):
            result[key] = "true" if value else "false"
        else:
            result[key] = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return result


@dataclass(frozen=True)
class DingTalkCardSpace:
    """Destination needed to deliver a card without retaining an SDK message."""

    space_type: str
    space_id: str

    @classmethod
    def from_message(cls, message: "ChatbotMessage") -> "DingTalkCardSpace":
        if str(getattr(message, "conversation_type", "1")) == "2":
            return cls("IM_GROUP", str(message.conversation_id))
        return cls("IM_ROBOT", str(message.sender_staff_id))

    @property
    def open_space_id(self) -> str:
        return f"dtv1.card//{self.space_type}.{self.space_id}"


class DingTalkCardTransport:
    """Create custom cards through the same credential as the Stream client."""

    BASE_URL = "https://api.dingtalk.com"

    def __init__(self, client: "DingTalkStreamClient") -> None:
        self._client = client

    async def create_and_deliver(
        self,
        *,
        out_track_id: str,
        template_id: str,
        space: DingTalkCardSpace,
        card_data: dict[str, Any],
    ) -> bool:
        access_token = await asyncio.to_thread(self._client.get_access_token)
        if not access_token:
            logger.error("[DingTalkCard] Cannot obtain an access token")
            return False

        payload: dict[str, Any] = {
            "cardTemplateId": template_id,
            "outTrackId": out_track_id,
            "openSpaceId": space.open_space_id,
            # DingTalk staff IDs are also used by incoming chatbot messages.
            # Keeping the same ID type lets callback authorization compare the
            # actor without storing or exposing a second identity mapping.
            "userIdType": 1,
            "callbackType": "STREAM",
            "cardData": {"cardParamMap": stringify_card_data(card_data)},
            "imGroupOpenSpaceModel": {"supportForward": False},
            "imRobotOpenSpaceModel": {"supportForward": False},
        }
        if space.space_type == "IM_GROUP":
            payload["imGroupOpenDeliverModel"] = {
                "robotCode": self._client.credential.client_id,
            }
        else:
            payload["imRobotOpenDeliverModel"] = {"spaceType": "IM_ROBOT"}

        url = f"{self.BASE_URL}/v1.0/card/instances/createAndDeliver"
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(
                    url,
                    headers=self._headers(access_token),
                    json=payload,
                )
                response.raise_for_status()
            logger.info(
                "[DingTalkCard] Created card out_track_id=%s space_type=%s",
                out_track_id,
                space.space_type,
            )
            return True
        except Exception:
            logger.exception(
                "[DingTalkCard] Failed to create card out_track_id=%s",
                out_track_id,
            )
            return False

    def new_out_track_id(self) -> str:
        return uuid.uuid4().hex

    def _headers(self, access_token: str) -> dict[str, str]:
        return {
            "x-acs-dingtalk-access-token": access_token,
            "Content-Type": "application/json",
        }
