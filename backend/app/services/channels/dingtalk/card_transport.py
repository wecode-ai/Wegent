# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Cancellable card HTTP requests, including token refresh and bounded retries."""

import json
import logging
import time
from typing import Any

import httpx
from anyio import fail_after
from tenacity import (
    AsyncRetrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from app.services.channels.dingtalk.message_logging import log_dingtalk_message
from shared.telemetry.decorators import trace_async

CARD_REQUEST_TIMEOUT = 15


def card_delivery_data(client: Any, message: Any, track_id: str) -> dict:
    data = {"outTrackId": track_id, "userIdType": 1}
    if message.conversation_type == "2":
        space_id = message.conversation_id
        model_key = "imGroupOpenDeliverModel"
        data["openSpaceId"] = f"dtv1.card//IM_GROUP.{space_id}"
        data[model_key] = {"robotCode": client.credential.client_id}
    else:
        space_id = message.sender_staff_id
        model_key = "imRobotOpenDeliverModel"
        data["openSpaceId"] = f"dtv1.card//IM_ROBOT.{space_id}"
        data[model_key] = {"spaceType": "IM_ROBOT"}
    if not space_id:
        raise ValueError("Missing DingTalk card recipient")
    hosting = getattr(message, "hosting_context", None)
    if hosting is not None:
        data[model_key]["extension"] = {
            "hostingRepliedContext": json.dumps({"userId": hosting.user_id})
        }
    return data


def _retryable(error: BaseException) -> bool:
    return isinstance(error, httpx.TransportError) or (
        isinstance(error, httpx.HTTPStatusError)
        and (error.response.status_code == 429 or error.response.status_code >= 500)
    )


class DingTalkCardTransport:
    def __init__(self, client: Any, channel_id: int = 0):
        self._client = client
        self.channel_id = channel_id
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(10, connect=5))

    async def _access_token(self) -> str:
        # Share the Stream client's existing cache without its synchronous I/O.
        cached = getattr(self._client, "_access_token", None)
        if isinstance(cached, dict) and time.time() < cached.get("expireTime", 0):
            return cached["accessToken"]
        credential = self._client.credential
        with fail_after(5):
            response = await self._http.post(
                "https://api.dingtalk.com/v1.0/oauth2/accessToken",
                json={
                    "appKey": credential.client_id,
                    "appSecret": credential.client_secret,
                },
            )
        if response.is_error:
            raise RuntimeError(f"DingTalk token request: HTTP {response.status_code}")
        data = response.json()
        if not isinstance(data, dict) or not data.get("accessToken"):
            raise RuntimeError("DingTalk access token unavailable")
        self._client._access_token = {
            **data,
            "expireTime": time.time() + max(0, int(data["expireIn"]) - 300),
        }
        return data["accessToken"]

    @trace_async(
        span_name="dingtalk.card.request", tracer_name="backend.channels.dingtalk"
    )
    async def request(
        self, method: str, path: str, body: dict, *, require_success: bool = True
    ) -> dict:
        # The deadline includes token refresh, retries and all HTTP phases.
        with fail_after(CARD_REQUEST_TIMEOUT):
            try:
                token = await self._access_token()
                async for attempt in AsyncRetrying(
                    stop=stop_after_attempt(3 if method == "PUT" else 1),
                    wait=wait_exponential(multiplier=0.5),
                    retry=retry_if_exception(_retryable),
                    reraise=True,
                ):
                    with attempt:
                        response = await self._http.request(
                            method,
                            f"https://api.dingtalk.com/v1.0/card/{path}",
                            headers={"x-acs-dingtalk-access-token": token},
                            json=body,
                        )
                        response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                self._log_failure(path, body.get("outTrackId"), exc.response)
                raise RuntimeError(
                    f"DingTalk card {path}: HTTP {exc.response.status_code}"
                ) from None
            except httpx.TransportError:
                raise RuntimeError(f"DingTalk card {path}: transport failure") from None
            data = response.json()
            if (
                not isinstance(data, dict)
                or data.get("success") is False
                or (require_success and data.get("success") is not True)
            ):
                raise RuntimeError(f"DingTalk card {path}: request was not accepted")
            return data

    def _log_failure(
        self, path: str, track_id: str | None, response: httpx.Response
    ) -> None:
        try:
            data = response.json()
        except ValueError:
            data = {}
        identifiers = {
            key: str(data[key])[:256]
            for key in ("code", "requestid", "requestId")
            if isinstance(data, dict) and isinstance(data.get(key), (str, int))
        }
        log_dingtalk_message(
            logging.getLogger(__name__),
            "card_request_failed",
            {
                "channel_id": self.channel_id,
                "outTrackId": track_id,
                "path": path,
                "status_code": response.status_code,
                **identifiers,
            },
        )

    async def close(self) -> None:
        await self._http.aclose()
