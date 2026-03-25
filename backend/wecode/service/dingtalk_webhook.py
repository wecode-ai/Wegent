# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk group webhook sender for notifications.

This module provides functionality to send messages to DingTalk groups
via webhook with signature verification.
"""

import base64
import hashlib
import hmac
import logging
import time
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

# TODO: Replace with your actual DingTalk group webhook configuration
DINGTALK_WEBHOOK_URL = "https://oapi.dingtalk.com/robot/send?access_token=255d9036cd66c687189134b8b168e910bec4d9601f53cf9fcb54d819928b9c86"
DINGTALK_WEBHOOK_SECRET = ""


class DingTalkWebhookSender:
    """Send messages to DingTalk group via webhook."""

    def __init__(self, webhook_url: str, secret: str = ""):
        """
        Initialize the webhook sender.

        Args:
            webhook_url: The DingTalk webhook URL
            secret: The secret for signature verification
        """
        self.webhook_url = webhook_url
        self.secret = secret

    def _generate_sign(self, timestamp: str) -> str:
        """
        Generate signature for webhook request.

        Args:
            timestamp: Current timestamp in milliseconds

        Returns:
            Base64 encoded signature
        """
        string_to_sign = f"{timestamp}\n{self.secret}"
        hmac_code = hmac.new(
            self.secret.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            digestmod=hashlib.sha256,
        ).digest()
        return base64.b64encode(hmac_code).decode("utf-8")

    async def send_markdown(self, title: str, content: str) -> bool:
        """
        Send markdown message to DingTalk group.

        Args:
            title: Message title
            content: Markdown content

        Returns:
            True if message was sent successfully, False otherwise
        """
        timestamp = str(int(time.time() * 1000))

        params: Dict[str, str] = {"timestamp": timestamp}
        if self.secret:
            params["sign"] = self._generate_sign(timestamp)

        payload: Dict[str, Any] = {
            "msgtype": "markdown",
            "markdown": {"title": title, "text": content},
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Build full URL with params manually to ensure access_token is preserved
                import urllib.parse
                parsed = urllib.parse.urlparse(self.webhook_url)
                query_params = urllib.parse.parse_qs(parsed.query)
                # Add timestamp and sign to existing params
                query_params["timestamp"] = [timestamp]
                if self.secret:
                    query_params["sign"] = [params["sign"]]
                # Rebuild query string
                new_query = urllib.parse.urlencode(query_params, doseq=True)
                full_url = urllib.parse.urlunparse(
                    (parsed.scheme, parsed.netloc, parsed.path, parsed.params, new_query, parsed.fragment)
                )

                # Mask access_token in log
                safe_url = full_url
                if "access_token=" in full_url:
                    parts = full_url.split("access_token=")
                    token = parts[1].split("&")[0] if "&" in parts[1] else parts[1]
                    safe_url = full_url.replace(token, "***")
                logger.info(f"DingTalk request URL: {safe_url}")

                response = await client.post(full_url, json=payload)
                response.raise_for_status()
                result = response.json()

                if result.get("errcode") == 0:
                    logger.info("DingTalk message sent successfully")
                    return True
                else:
                    logger.error(
                        f"DingTalk API error: {result.get('errcode')} - {result.get('errmsg')}"
                    )
                    return False

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error sending DingTalk message: {e}")
            return False
        except httpx.RequestError as e:
            logger.error(f"Request error sending DingTalk message: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error sending DingTalk message: {e}")
            return False

    async def send_text(self, content: str) -> bool:
        """
        Send text message to DingTalk group.

        Args:
            content: Text content

        Returns:
            True if message was sent successfully, False otherwise
        """
        timestamp = str(int(time.time() * 1000))

        params: Dict[str, str] = {"timestamp": timestamp}
        if self.secret:
            params["sign"] = self._generate_sign(timestamp)

        payload: Dict[str, Any] = {
            "msgtype": "text",
            "text": {"content": content},
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.webhook_url, params=params, json=payload
                )
                response.raise_for_status()
                result = response.json()

                if result.get("errcode") == 0:
                    logger.info("DingTalk text message sent successfully")
                    return True
                else:
                    logger.error(
                        f"DingTalk API error: {result.get('errcode')} - {result.get('errmsg')}"
                    )
                    return False

        except Exception as e:
            logger.error(f"Error sending DingTalk text message: {e}")
            return False
