# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Robot Message Sender.

This module provides functionality to proactively send messages to users
via DingTalk robot API. Used for subscription notifications and other
push scenarios where there's no incoming message to reply to.

API Reference:
- Single chat batch send: POST /v1.0/robot/oToMessages/batchSend
"""

import logging
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class DingTalkRobotSender:
    """Sender for proactively sending DingTalk robot messages.

    This class uses DingTalk's oToMessages/batchSend API to send messages
    to users without requiring an incoming message context.
    """

    BASE_URL = "https://api.dingtalk.com"

    def __init__(self, client_id: str, client_secret: str):
        """Initialize the sender.

        Args:
            client_id: DingTalk robot client ID (AppKey)
            client_secret: DingTalk robot client secret (AppSecret)
        """
        self.client_id = client_id
        self.client_secret = client_secret
        self._access_token: Optional[str] = None

    async def _get_access_token(self) -> str:
        """Get access token for DingTalk API.

        Returns:
            Access token string

        Raises:
            Exception: If token fetch fails
        """
        url = f"{self.BASE_URL}/v1.0/oauth2/accessToken"
        payload = {
            "appKey": self.client_id,
            "appSecret": self.client_secret,
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                url, json=payload, headers={"Content-Type": "application/json"}
            )
            response.raise_for_status()
            data = response.json()

            if "code" in data:
                error_msg = data.get("message", "Unknown error")
                raise Exception(f"Failed to get access token: {error_msg}")

            access_token = data.get("accessToken")
            if not access_token:
                raise Exception("Missing accessToken in response")

            return access_token

    async def send_text_message(
        self,
        user_ids: List[str],
        content: str,
        robot_code: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send text message to users.

        Args:
            user_ids: List of DingTalk user IDs (staffId or unionId)
            content: Text message content
            robot_code: Robot code (defaults to client_id)

        Returns:
            API response dict with processQueryKey for tracking
        """
        return await self._send_message(
            user_ids=user_ids,
            msg_key="sampleText",
            msg_param={"content": content},
            robot_code=robot_code,
        )

    async def send_markdown_message(
        self,
        user_ids: List[str],
        title: str,
        text: str,
        robot_code: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send markdown message to users.

        Args:
            user_ids: List of DingTalk user IDs (staffId or unionId)
            title: Message title
            text: Markdown text content
            robot_code: Robot code (defaults to client_id)

        Returns:
            API response dict with processQueryKey for tracking
        """
        return await self._send_message(
            user_ids=user_ids,
            msg_key="sampleMarkdown",
            msg_param={"title": title, "text": text},
            robot_code=robot_code,
        )

    async def _send_message(
        self,
        user_ids: List[str],
        msg_key: str,
        msg_param: Dict[str, Any],
        robot_code: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send message to users via DingTalk robot API.

        Args:
            user_ids: List of DingTalk user IDs
            msg_key: Message type key (sampleText, sampleMarkdown, etc.)
            msg_param: Message parameters
            robot_code: Robot code (defaults to client_id)

        Returns:
            API response dict
        """
        if not user_ids:
            return {"success": False, "error": "No user IDs provided"}

        try:
            access_token = await self._get_access_token()

            url = f"{self.BASE_URL}/v1.0/robot/oToMessages/batchSend"
            payload = {
                "robotCode": robot_code or self.client_id,
                "userIds": user_ids,
                "msgKey": msg_key,
                "msgParam": str(msg_param).replace("'", '"'),  # JSON string
            }

            logger.info(
                f"[DingTalkSender] Sending {msg_key} message to {len(user_ids)} users"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={
                        "x-acs-dingtalk-access-token": access_token,
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                data = response.json()

                logger.info(
                    f"[DingTalkSender] Message sent successfully, "
                    f"processQueryKey={data.get('processQueryKey')}"
                )

                return {"success": True, "result": data}

        except httpx.HTTPStatusError as e:
            error_data = {}
            try:
                error_data = e.response.json()
            except Exception:
                pass

            error_code = error_data.get("code", "HTTP_ERROR")
            error_msg = error_data.get("message", str(e))

            logger.error(
                f"[DingTalkSender] HTTP error sending message: {error_code} - {error_msg}"
            )

            return {
                "success": False,
                "error": f"{error_code}: {error_msg}",
            }

        except Exception as e:
            logger.error(f"[DingTalkSender] Error sending message: {e}")
            return {
                "success": False,
                "error": str(e),
            }
