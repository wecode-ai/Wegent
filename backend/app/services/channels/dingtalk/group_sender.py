# SPDX-FileCopyrightText: 2025 Weco AI, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Group Webhook Message Sender.

This module provides functionality to send messages to DingTalk groups
via webhook. Used for subscription notifications to group chats.

Unlike the regular DingTalk robot sender (which uses OAuth2 + oToMessages API),
this sender uses the webhook URL directly with optional HMAC-SHA256 signing.

API Reference:
- Robot webhook: POST https://oapi.dingtalk.com/robot/send?access_token=xxx
"""

import base64
import hashlib
import hmac
import logging
import time
import urllib.parse
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

# DingTalk webhook message has a 20000 character limit
DINGTALK_MESSAGE_CHAR_LIMIT = 20000


class DingTalkGroupWebhookSender:
    """Sender for DingTalk group webhook messages.

    This class sends messages to DingTalk groups using the webhook API.
    Supports optional HMAC-SHA256 signing for security.

    Unlike DingTalkRobotSender which sends to individual users,
    this sender broadcasts messages to an entire group chat.
    """

    def __init__(self, webhook_url: str, sign_secret: Optional[str] = None):
        """Initialize the sender.

        Args:
            webhook_url: DingTalk group webhook URL (includes access_token)
            sign_secret: Optional signing secret for HMAC-SHA256 signature
        """
        self.webhook_url = webhook_url
        self.sign_secret = sign_secret

    def _generate_signature(self, timestamp: int) -> str:
        """Generate HMAC-SHA256 signature for webhook request.

        The signature is calculated as:
        1. Create string_to_sign = "{timestamp}\\n{secret}"
        2. Calculate HMAC-SHA256 using secret as key
        3. Base64 encode the result
        4. URL encode the base64 string

        Args:
            timestamp: Current timestamp in milliseconds

        Returns:
            URL-encoded base64 signature
        """
        if not self.sign_secret:
            return ""

        string_to_sign = f"{timestamp}\n{self.sign_secret}"
        hmac_code = hmac.new(
            self.sign_secret.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            digestmod=hashlib.sha256,
        ).digest()
        sign = urllib.parse.quote_plus(base64.b64encode(hmac_code).decode("utf-8"))
        return sign

    def _build_url(self) -> str:
        """Build the webhook URL with optional signature.

        If sign_secret is configured, appends timestamp and sign parameters
        to the webhook URL for security verification.

        Returns:
            Complete webhook URL with timestamp and signature if configured
        """
        url = self.webhook_url

        if self.sign_secret:
            timestamp = int(time.time() * 1000)
            sign = self._generate_signature(timestamp)
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}timestamp={timestamp}&sign={sign}"

        return url

    async def send_markdown_message(
        self,
        title: str,
        text: str,
    ) -> Dict[str, Any]:
        """Send markdown message to DingTalk group.

        Args:
            title: Message title (shown in notification preview)
            text: Markdown text content

        Returns:
            API response dict with success status
        """
        # Handle message length limit
        original_length = len(text)
        if original_length > DINGTALK_MESSAGE_CHAR_LIMIT:
            truncated_notice = "\n\n---\n*内容过长已截断，请查看详情链接*"
            max_text_len = DINGTALK_MESSAGE_CHAR_LIMIT - len(truncated_notice)
            text = text[:max_text_len] + truncated_notice
            logger.warning(
                f"[DingTalkGroupWebhook] Message truncated from {original_length} "
                f"to {DINGTALK_MESSAGE_CHAR_LIMIT} chars"
            )

        return await self._send_message(
            msg_type="markdown",
            content={"title": title, "text": text},
        )

    async def send_text_message(self, content: str) -> Dict[str, Any]:
        """Send text message to DingTalk group.

        Args:
            content: Text message content

        Returns:
            API response dict with success status
        """
        # Handle message length limit
        original_length = len(content)
        if original_length > DINGTALK_MESSAGE_CHAR_LIMIT:
            truncated_notice = "... (内容过长已截断)"
            max_text_len = DINGTALK_MESSAGE_CHAR_LIMIT - len(truncated_notice)
            content = content[:max_text_len] + truncated_notice
            logger.warning(
                f"[DingTalkGroupWebhook] Message truncated from {original_length} "
                f"to {DINGTALK_MESSAGE_CHAR_LIMIT} chars"
            )

        return await self._send_message(
            msg_type="text",
            content={"content": content},
        )

    async def _send_message(
        self,
        msg_type: str,
        content: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Send message to DingTalk group via webhook.

        Args:
            msg_type: Message type ("text" or "markdown")
            content: Message content dict

        Returns:
            API response dict with success/error status
        """
        try:
            url = self._build_url()
            payload = {"msgtype": msg_type, msg_type: content}

            logger.info(
                f"[DingTalkGroupWebhook] Sending {msg_type} message, "
                f"content_length={len(str(content))}"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                data = response.json()

                # DingTalk returns errcode: 0 on success
                if data.get("errcode") == 0:
                    logger.info("[DingTalkGroupWebhook] Message sent successfully")
                    return {"success": True, "result": data}
                else:
                    error_code = data.get("errcode", "UNKNOWN")
                    error_msg = data.get("errmsg", "Unknown error")
                    logger.error(
                        f"[DingTalkGroupWebhook] API error: {error_code} - {error_msg}"
                    )
                    return {"success": False, "error": f"{error_code}: {error_msg}"}

        except httpx.HTTPStatusError as e:
            error_data = {}
            try:
                error_data = e.response.json()
            except Exception:
                pass

            error_code = error_data.get("errcode", "HTTP_ERROR")
            error_msg = error_data.get("errmsg", str(e))
            logger.error(
                f"[DingTalkGroupWebhook] HTTP error: {error_code} - {error_msg}"
            )
            return {"success": False, "error": f"{error_code}: {error_msg}"}

        except httpx.TimeoutException:
            logger.error("[DingTalkGroupWebhook] Request timeout")
            return {"success": False, "error": "Request timeout"}

        except Exception as e:
            logger.error(f"[DingTalkGroupWebhook] Error: {e}")
            return {"success": False, "error": str(e)}
