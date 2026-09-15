# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SDK card rendering with bounded, checked HTTP updates."""

import uuid
from typing import Any

import requests
from dingtalk_stream import AIMarkdownCardInstance
from dingtalk_stream.utils import DINGTALK_OPENAPI_ENDPOINT


class DingTalkMarkdownCard(AIMarkdownCardInstance):
    """Retain SDK rendering while propagating update errors to the emitter."""

    def _put(self, path: str, payload: dict[str, Any]) -> None:
        token = self.dingtalk_client.get_access_token()
        if not token:
            raise RuntimeError("Cannot update DingTalk card without an access token")
        # SDK update methods swallow failures and omit timeouts. Terminal delivery
        # must only succeed when its HTTP request succeeds.
        with requests.put(
            f"{DINGTALK_OPENAPI_ENDPOINT}{path}",
            headers=self.get_request_header(token),
            json=payload,
            timeout=(5, 10),
        ) as response:
            response.raise_for_status()

    def put_card_data(
        self, card_instance_id: str, card_data: dict, **kwargs: Any
    ) -> None:
        self._put(
            "/v1.0/card/instances",
            {
                "outTrackId": card_instance_id,
                "cardData": {"cardParamMap": card_data},
                **kwargs,
            },
        )

    def streaming(
        self,
        card_instance_id: str,
        content_key: str,
        content_value: str,
        append: bool,
        finished: bool,
        failed: bool,
    ) -> None:
        self._put(
            "/v1.0/card/streaming",
            {
                "outTrackId": card_instance_id,
                "guid": str(uuid.uuid4()),
                "key": content_key,
                "content": content_value,
                "isFull": not append,
                "isFinalize": finished,
                "isError": failed,
            },
        )
