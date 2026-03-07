# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feishu message sender utilities."""

import json
import logging
import time
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)


class FeishuBotSender:
    """Sender for Feishu Bot messages using OpenAPI."""

    BASE_URL = "https://open.feishu.cn"

    def __init__(self, app_id: str, app_secret: str):
        self.app_id = app_id
        self.app_secret = app_secret
        self._tenant_access_token: Optional[str] = None
        self._token_expire_at: float = 0.0

    async def _get_tenant_access_token(self) -> Optional[str]:
        now = time.time()
        if self._tenant_access_token and now < self._token_expire_at - 60:
            return self._tenant_access_token

        url = f"{self.BASE_URL}/open-apis/auth/v3/tenant_access_token/internal"
        payload = {"app_id": self.app_id, "app_secret": self.app_secret}

        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
                data = resp.json()

            if data.get("code") != 0:
                logger.error(
                    "[FeishuSender] Failed to fetch tenant token: %s",
                    data.get("msg", "unknown error"),
                )
                return None

            token = data.get("tenant_access_token")
            expire = int(data.get("expire", 7200))
            if not token:
                return None

            self._tenant_access_token = token
            self._token_expire_at = now + expire
            return token
        except Exception as exc:
            logger.exception("[FeishuSender] Token request failed: %s", exc)
            return None

    async def send_text_message(self, chat_id: str, text: str) -> Dict[str, Any]:
        if not chat_id:
            return {"success": False, "error": "missing chat_id"}

        token = await self._get_tenant_access_token()
        if not token:
            return {"success": False, "error": "failed to get tenant access token"}

        url = f"{self.BASE_URL}/open-apis/im/v1/messages"
        payload = {
            "receive_id": chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    f"{url}?receive_id_type=chat_id", json=payload, headers=headers
                )
                resp.raise_for_status()
                data = resp.json()

            if data.get("code") == 0:
                return {"success": True, "result": data}

            logger.error("[FeishuSender] Send message failed: %s", data)
            return {
                "success": False,
                "error": data.get("msg", "send message failed"),
                "result": data,
            }
        except Exception as exc:
            logger.exception("[FeishuSender] Send message error: %s", exc)
            return {"success": False, "error": str(exc)}
